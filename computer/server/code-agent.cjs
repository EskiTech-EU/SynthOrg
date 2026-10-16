'use strict';
/**
 * SynthOrg Code agent: the server side of a container project.
 *
 * Runs inside the project's container (`node /opt/synthorg-code/agent.cjs`),
 * started by the desktop through `engine exec -i`. It never listens on
 * anything: stdin carries the desktop's requests, stdout carries the answers
 * and the events the desktop subscribed to. When stdin ends the desktop is
 * gone and the agent ends everything it started.
 *
 * Wire format: one JSON object per line.
 *   request   {"id":n,"op":"read_dir","path":"/workspace"}
 *   response  {"id":n,"ok":true,"result":...} | {"id":n,"ok":false,"error":"..."}
 *   event     {"event":"watch-batch","payload":{...}}
 * A message without `id` is a notification: no answer is written.
 *
 * Every operation mirrors the shape of the SideX Rust command it replaces,
 * so the workbench on the desktop sees no difference between a local folder
 * and a container.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const readline = require('node:readline');

const WORKSPACE = process.env.SYNTHORG_WORKSPACE || '/workspace';
const RUNTIME_DIR = process.env.SYNTHORG_CODE_DIR || '/opt/synthorg-code';
const DATA_DIR = path.join(os.homedir(), '.synthorg-code');
const MAX_CONTENT_SIZE = 100 * 1024;
const DEFAULT_MAX_FILE_SIZE = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

let outQueue = Promise.resolve();
function write(message) {
  const line = JSON.stringify(message) + '\n';
  outQueue = outQueue.then(() => new Promise(resolve => process.stdout.write(line, resolve)));
}

function emit(event, payload) {
  write({ event, payload });
}

function fail(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

/**
 * Paths arrive as the workbench spells them on its own OS; the container is
 * Linux. Whatever the spelling, the project is the only place they may point
 * to: the agent serves the workspace, not the container's filesystem.
 */
function normalize(value) {
  if (typeof value !== 'string' || !value) throw fail('path must not be empty');
  let p = value;
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(new URL(p).pathname); } catch { throw fail(`invalid path: ${value}`); }
  }
  p = p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('//')) throw fail(`path outside the project: ${value}`);
  if (!p.startsWith('/')) p = path.posix.join(WORKSPACE, p);
  p = path.posix.normalize(p);
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (p !== WORKSPACE && !p.startsWith(WORKSPACE + '/')) throw fail(`path outside the project: ${value}`);
  return p;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const seconds = ms => Math.floor(ms / 1000);

async function statOf(p) {
  const lst = await fsp.lstat(p);
  let st = lst;
  if (lst.isSymbolicLink()) {
    try { st = await fsp.stat(p); } catch { st = lst; }
  }
  let readonly = false;
  try { await fsp.access(p, fs.constants.W_OK); } catch { readonly = true; }
  return {
    size: Number(st.size),
    is_dir: st.isDirectory(),
    is_file: st.isFile(),
    is_symlink: lst.isSymbolicLink(),
    modified: seconds(st.mtimeMs),
    created: seconds(st.birthtimeMs || st.ctimeMs),
    readonly
  };
}

const fsOps = {
  async get_cwd() { return WORKSPACE; },
  async read_file({ path: p }) { return fsp.readFile(normalize(p), 'utf8'); },
  async read_file_bytes({ path: p }) { return (await fsp.readFile(normalize(p))).toString('base64'); },
  async write_file({ path: p, content }) { await fsp.writeFile(normalize(p), String(content ?? '')); return null; },
  async write_file_bytes({ path: p, content }) {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'base64') : Buffer.from(content || []);
    await fsp.writeFile(normalize(p), bytes);
    return null;
  },
  async read_dir({ path: p }) {
    const dir = normalize(p);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      const full = path.posix.join(dir, entry.name);
      let st = null;
      try { st = await fsp.stat(full); } catch {}
      out.push({
        name: entry.name,
        path: full,
        is_dir: st ? st.isDirectory() : entry.isDirectory(),
        is_file: st ? st.isFile() : entry.isFile(),
        is_symlink: entry.isSymbolicLink(),
        size: st ? Number(st.size) : 0,
        modified: st ? seconds(st.mtimeMs) : 0
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  },
  async stat({ path: p }) { return statOf(normalize(p)); },
  async mkdir({ path: p, recursive }) { await fsp.mkdir(normalize(p), { recursive: recursive !== false }); return null; },
  async remove({ path: p, recursive }) {
    const target = normalize(p);
    if (target === WORKSPACE) throw fail('the workspace itself cannot be removed');
    await fsp.rm(target, { recursive: Boolean(recursive), force: false });
    return null;
  },
  async rename({ oldPath, old_path, newPath, new_path }) {
    await fsp.rename(normalize(oldPath ?? old_path), normalize(newPath ?? new_path));
    return null;
  },
  async exists({ path: p }) {
    try { await fsp.access(normalize(p)); return true; } catch { return false; }
  }
};

// ---------------------------------------------------------------------------
// Text helpers and hashes
// ---------------------------------------------------------------------------

function isBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

async function hashFile(p, algorithms) {
  const hashes = algorithms.map(a => crypto.createHash(a));
  let size = 0;
  await new Promise((resolve, reject) => {
    fs.createReadStream(p)
      .on('data', chunk => { size += chunk.length; for (const h of hashes) h.update(chunk); })
      .on('end', resolve)
      .on('error', reject);
  });
  return { size, digests: hashes.map(h => h.digest('hex')) };
}

const textOps = {
  async count_lines({ path: p }) {
    const buffer = await fsp.readFile(normalize(p));
    let count = 0;
    for (const byte of buffer) if (byte === 10) count += 1;
    return count;
  },
  async file_summary({ path: p }) {
    const buffer = await fsp.readFile(normalize(p));
    const has_bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    const text = buffer.subarray(has_bom ? 3 : 0).toString('utf8');
    const crlf = (text.match(/\r\n/g) || []).length;
    const lf = (text.match(/\n/g) || []).length - crlf;
    return {
      line_count: text.length ? text.split('\n').length : 0,
      word_count: (text.match(/[\p{L}\p{N}_]+/gu) || []).length,
      char_count: [...text].length,
      has_bom,
      likely_encoding: has_bom ? 'UTF-8 with BOM' : isBinary(buffer) ? 'Binary' : 'UTF-8',
      line_endings: crlf && !lf ? 'CRLF' : crlf && lf ? 'Mixed' : 'LF'
    };
  },
  async file_hash({ path: p }) { return (await hashFile(normalize(p), ['sha1'])).digests[0]; },
  async files_equal({ path1, path2 }) {
    const [a, b] = await Promise.all([fsp.readFile(normalize(path1)), fsp.readFile(normalize(path2))]);
    return a.equals(b);
  },
  async sha256_file({ path: p }) { return (await hashFile(normalize(p), ['sha256'])).digests[0]; },
  async md5_file({ path: p }) { return (await hashFile(normalize(p), ['md5'])).digests[0]; },
  async file_hashes({ path: p }) {
    const target = normalize(p);
    const { size, digests } = await hashFile(target, ['sha256', 'md5']);
    return { path: target, sha256: digests[0], md5: digests[1], size };
  },
  async is_binary_file({ path: p }) {
    const handle = await fsp.open(normalize(p), 'r');
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(buffer, 0, 8192, 0);
      return buffer.subarray(0, bytesRead).includes(0);
    } finally { await handle.close(); }
  }
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const ALWAYS_SKIPPED = new Set(['.git']);

/** Glob to regular expression: `**`, `*`, `?` and `{a,b}` on posix paths. */
function globToRegExp(glob) {
  let source = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i += 2;
        if (glob[i] === '/') i += 1;
        continue;
      }
      source += '[^/]*';
    } else if (c === '?') source += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { source += '\\{'; i += 1; continue; }
      source += '(' + glob.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')';
      i = end + 1;
      continue;
    } else source += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${source}$`);
}

function matcher(patterns) {
  const list = (patterns || []).filter(p => typeof p === 'string' && p.trim());
  if (!list.length) return null;
  const regexps = list.map(p => {
    const clean = p.replace(/^\.\//, '').replace(/\/$/, '');
    return clean.includes('/') || clean.includes('**') ? globToRegExp(clean) : globToRegExp(`**/${clean}`);
  });
  return (relative, name) => regexps.some(re => re.test(relative) || re.test(name));
}

async function* walk(root, { include, exclude, includeHidden, maxFileSize }) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.posix.join(dir, entry.name);
      const relative = path.posix.relative(root, full);
      if (ALWAYS_SKIPPED.has(entry.name)) continue;
      if (!includeHidden && entry.name.startsWith('.') && entry.name !== '.vscode') continue;
      if (exclude && exclude(relative, entry.name)) continue;
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      if (include && !include(relative, entry.name)) continue;
      if (maxFileSize) {
        try { if ((await fsp.stat(full)).size > maxFileSize) continue; } catch { continue; }
      }
      yield { full, relative, name: entry.name };
    }
  }
}

function fuzzyScore(pattern, candidate) {
  const p = pattern.toLowerCase();
  const c = candidate.toLowerCase();
  if (!p) return 1;
  if (c === p) return 1000;
  if (c.includes(p)) return 500 - (c.length - p.length);
  let pi = 0;
  let score = 0;
  for (let ci = 0; ci < c.length && pi < p.length; ci++) {
    if (c[ci] === p[pi]) { pi += 1; score += ci === 0 || c[ci - 1] === '/' || c[ci - 1] === '.' ? 10 : 1; }
  }
  return pi === p.length ? score : 0;
}

function buildRegExp(query, { isRegex, caseSensitive, wholeWord }) {
  let source = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) source = `\\b(?:${source})\\b`;
  return new RegExp(source, caseSensitive ? 'g' : 'gi');
}

async function textMatches(root, query, options, onMatch) {
  const opts = options || {};
  const re = buildRegExp(query, {
    isRegex: Boolean(opts.is_regex),
    caseSensitive: Boolean(opts.case_sensitive),
    wholeWord: Boolean(opts.whole_word)
  });
  const max = opts.max_results || 5000;
  const filter = {
    include: matcher(opts.include || opts.include_patterns),
    exclude: matcher(opts.exclude || opts.exclude_patterns),
    includeHidden: Boolean(opts.include_hidden),
    maxFileSize: opts.max_file_size || DEFAULT_MAX_FILE_SIZE
  };
  let count = 0;
  for await (const file of walk(root, filter)) {
    let buffer;
    try { buffer = await fsp.readFile(file.full); } catch { continue; }
    if (isBinary(buffer)) continue;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (m[0] === '') { re.lastIndex += 1; continue; }
        onMatch(file, lines, index, m.index, m.index + m[0].length);
        count += 1;
        if (count >= max) return;
      }
    }
  }
}

const searchOps = {
  async search_files({ root, pattern, options }) {
    const base = normalize(root);
    const opts = options || {};
    const results = [];
    const filter = {
      include: matcher(opts.include),
      exclude: matcher(opts.exclude),
      includeHidden: Boolean(opts.include_hidden)
    };
    for await (const file of walk(base, filter)) {
      const score = Math.max(fuzzyScore(pattern || '', file.relative), fuzzyScore(pattern || '', file.name) * 2);
      if (score > 0) results.push({ path: file.full, name: file.name, score });
    }
    results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return results.slice(0, opts.max_results || 200);
  },
  async search_text({ root, query, options }) {
    const results = [];
    await textMatches(normalize(root), query, options, (file, lines, index, start, end) => {
      results.push({ path: file.full, line_number: index + 1, line_content: lines[index], column: start, match_length: Math.max(end - start, query.length) });
    });
    return results;
  },
  async search_workspace({ root, query, options }) {
    const results = [];
    await textMatches(normalize(root), query, options, (file, lines, index, start, end) => {
      results.push({ path: file.full, line_number: index + 1, line_text: lines[index], match_start: start, match_end: end });
    });
    return results;
  },
  async search_workspace_grouped({ root, query, options }) {
    const context = (options && options.context_lines) || 0;
    const groups = new Map();
    await textMatches(normalize(root), query, options, (file, lines, index, start, end) => {
      let group = groups.get(file.full);
      if (!group) { group = { file_path: file.full, matches: [], line_count: lines.length }; groups.set(file.full, group); }
      const around = (from, to) => lines.slice(Math.max(0, from), Math.min(lines.length, to)).map((text, k) => ({ line_number: Math.max(0, from) + k + 1, text }));
      group.matches.push({
        line_number: index + 1, line_text: lines[index], match_start: start, match_end: end,
        before_context: context ? around(index - context, index) : [],
        after_context: context ? around(index + 1, index + 1 + context) : []
      });
    });
    return [...groups.values()];
  },
  async search_workspace_replace_preview({ root, query, replacement, options }) {
    const files = new Map();
    await textMatches(normalize(root), query, options, (file, lines, index, start, end) => {
      let entry = files.get(file.full);
      if (!entry) { entry = { path: file.full, edits: [] }; files.set(file.full, entry); }
      entry.edits.push({ line_number: index + 1, match_start: start, match_end: end, original: lines[index].slice(start, end), replacement: String(replacement ?? '') });
    });
    return [...files.values()];
  },
  async search_workspace_replace_apply({ root, query, replacement }) {
    const touched = new Map();
    await textMatches(normalize(root), query, { case_sensitive: true, max_results: 1e9 }, (file) => { touched.set(file.full, true); });
    const report = { files_modified: 0, replacements_made: 0, errors: [] };
    for (const file of touched.keys()) {
      try {
        const text = await fsp.readFile(file, 'utf8');
        const count = text.split(query).length - 1;
        if (!count) continue;
        await fsp.writeFile(file, text.split(query).join(String(replacement ?? '')));
        report.files_modified += 1;
        report.replacements_made += count;
      } catch (error) { report.errors.push([file, error.message]); }
    }
    return report;
  }
};

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

const watches = new Map();
let nextWatchId = 1;

function watchIgnored(session, p) {
  if (!session.ignore) return false;
  const relative = path.posix.relative(session.base, p);
  return session.ignore(relative, path.posix.basename(p));
}

const watchOps = {
  async watch_start({ paths, options }) {
    const opts = options || {};
    const targets = (paths || []).map(normalize).filter(p => fs.existsSync(p));
    if (!targets.length) throw fail('No valid paths to watch');
    const id = nextWatchId++;
    const session = {
      id, base: targets[0], watchers: [], pending: new Map(), timer: null,
      debounce: opts.debounce_ms || 100,
      ignore: matcher(opts.ignore_patterns),
      extensions: Array.isArray(opts.file_extensions) && opts.file_extensions.length ? new Set(opts.file_extensions.map(e => String(e).toLowerCase())) : null,
      emitContent: Boolean(opts.emit_content)
    };
    const flush = () => {
      session.timer = null;
      const events = [];
      for (const [p, kind] of session.pending) {
        let is_dir = false;
        let content = null;
        try {
          const st = fs.statSync(p);
          is_dir = st.isDirectory();
          if (session.emitContent && st.isFile() && st.size <= MAX_CONTENT_SIZE && kind !== 'deleted') content = fs.readFileSync(p, 'utf8');
        } catch {}
        events.push({ path: p, kind, is_dir, content });
      }
      session.pending.clear();
      if (events.length) emit('watch-batch', { watch_id: id, events, timestamp: Date.now() });
    };
    const record = (dir, eventType, filename) => {
      if (!filename) return;
      const full = path.posix.join(dir, String(filename).replace(/\\/g, '/'));
      if (watchIgnored(session, full)) return;
      if (session.extensions) {
        const ext = path.posix.extname(full).slice(1).toLowerCase();
        if (!session.extensions.has(ext)) return;
      }
      const exists = fs.existsSync(full);
      const kind = eventType === 'rename' ? (exists ? 'created' : 'deleted') : 'modified';
      session.pending.set(full, kind);
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(flush, session.debounce);
    };
    for (const target of targets) {
      try {
        const watcher = fs.watch(target, { recursive: opts.recursive !== false, persistent: false }, (eventType, filename) => record(target, eventType, filename));
        watcher.on('error', () => {});
        session.watchers.push(watcher);
      } catch (error) {
        for (const w of session.watchers) w.close();
        throw fail(`Failed to watch '${target}': ${error.message}`);
      }
    }
    watches.set(id, session);
    return id;
  },
  async watch_stop({ id }) {
    const session = watches.get(id);
    if (!session) throw fail(`Watch session ${id} not found`);
    for (const w of session.watchers) w.close();
    if (session.timer) clearTimeout(session.timer);
    watches.delete(id);
    return null;
  },
  async watch_update_patterns({ id, patterns }) {
    const session = watches.get(id);
    if (!session) throw fail(`Watch session ${id} not found`);
    session.ignore = matcher(patterns);
    return null;
  },
  async watch_list() { return [...watches.keys()]; },
  async watch_is_active({ id }) { return watches.has(id); }
};

// ---------------------------------------------------------------------------
// Task detection
// ---------------------------------------------------------------------------

function stripJsonComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1');
}

const taskOps = {
  async tasks_detect({ workspace }) {
    const root = normalize(workspace);
    const tasks = [];
    try {
      const pkg = JSON.parse(await fsp.readFile(path.posix.join(root, 'package.json'), 'utf8'));
      for (const [name, script] of Object.entries(pkg.scripts || {})) {
        tasks.push({ label: `npm: ${name}`, task_type: 'Npm', command: `npm run ${name}`, source: 'PackageJson', script: String(script) });
      }
    } catch {}
    try {
      const cargo = await fsp.readFile(path.posix.join(root, 'Cargo.toml'), 'utf8');
      if (/^\s*\[package\]/m.test(cargo) || /^\s*\[workspace\]/m.test(cargo)) {
        for (const sub of ['build', 'test', 'run', 'check']) tasks.push({ label: `cargo ${sub}`, task_type: 'Cargo', command: `cargo ${sub}`, source: 'CargoToml' });
      }
    } catch {}
    try {
      const make = await fsp.readFile(path.posix.join(root, 'Makefile'), 'utf8');
      for (const m of make.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)) {
        if (!m[1].startsWith('.')) tasks.push({ label: `make ${m[1]}`, task_type: 'Make', command: `make ${m[1]}`, source: 'Makefile' });
      }
    } catch {}
    return tasks;
  },
  async tasks_parse_config({ workspace }) {
    const file = path.posix.join(normalize(workspace), '.vscode', 'tasks.json');
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch { return []; }
    const parsed = JSON.parse(stripJsonComments(text));
    return (parsed.tasks || []).map(t => ({
      label: String(t.label || t.taskName || t.command || 'task'),
      task_type: String(t.type || 'shell'),
      command: String(t.command || ''),
      args: Array.isArray(t.args) ? t.args.map(String) : [],
      group: typeof t.group === 'string' ? t.group : t.group && t.group.kind ? String(t.group.kind) : null
    }));
  }
};

// ---------------------------------------------------------------------------
// Extension host and the TCP tunnel the desktop reaches it through
// ---------------------------------------------------------------------------

let extHost = null;
const conns = new Map();
let nextConn = 1;

function stopExtHost() {
  if (!extHost) return;
  const child = extHost.child;
  extHost = null;
  // The server ends itself when its stdin closes; the signals are the fallback.
  try { child.stdin.end(); } catch {}
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref();
}

const extHostOps = {
  async exthost_start({ initData, env }) {
    stopExtHost();
    for (const dir of ['extensions', 'globalStorage', 'workspaceStorage', 'logs']) {
      await fsp.mkdir(path.join(DATA_DIR, dir), { recursive: true });
    }
    const session = crypto.randomUUID();
    const initFile = path.join(os.tmpdir(), `synthorg-init-${session}.json`);
    await fsp.writeFile(initFile, typeof initData === 'string' ? initData : JSON.stringify(initData || {}));
    const server = path.join(RUNTIME_DIR, 'extension-host', 'server.cjs');
    const child = cp.spawn(process.execPath, ['--max-old-space-size=2048', server], {
      cwd: WORKSPACE,
      env: {
        PATH: process.env.PATH, HOME: os.homedir(), LANG: 'C.UTF-8', TERM: 'xterm-256color',
        NODE_ENV: 'production',
        SIDEX_EXTENSIONS_DIR: path.join(DATA_DIR, 'extensions'),
        SIDEX_BUILTIN_EXTENSIONS_DIR: path.join(RUNTIME_DIR, 'extensions'),
        SIDEX_GLOBAL_STORAGE_DIR: path.join(DATA_DIR, 'globalStorage'),
        SIDEX_EXTENSION_SEARCH_PATHS: JSON.stringify([path.join(RUNTIME_DIR, 'extensions')]),
        SIDEX_INIT_DATA_FILE: initFile,
        SIDEX_SESSION_ID: session,
        ...(env && typeof env === 'object' ? env : {})
      },
      // The server treats the end of its stdin as the order to shut down:
      // the pipe stays open, untouched, for as long as it must run.
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const entry = { child, session, port: null };
    extHost = entry;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => emit('exthost-log', String(chunk).trimEnd()));
    child.on('exit', (code, signal) => {
      if (extHost === entry) extHost = null;
      emit('exthost-exit', { code, signal, session });
    });
    const port = await new Promise((resolve, reject) => {
      const rl = readline.createInterface({ input: child.stdout });
      const timer = setTimeout(() => reject(fail('extension host did not report its port')), 30000);
      rl.once('line', line => {
        clearTimeout(timer);
        try { resolve(JSON.parse(line).port); } catch { reject(fail(`bad port message: ${line}`)); }
        rl.on('line', text => emit('exthost-log', text));
      });
      child.once('exit', code => { clearTimeout(timer); reject(fail(`extension host exited before sending its port (code ${code})`)); });
    });
    entry.port = port;
    return { port, session };
  },
  async exthost_status() {
    return extHost ? { running: true, port: extHost.port, session: extHost.session } : { running: false };
  },
  async exthost_stop() { stopExtHost(); return null; },

  async net_open({ port }) {
    const id = nextConn++;
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: Number(port) }, () => { conns.set(id, socket); resolve(); });
      socket.on('data', data => emit('net-data', { conn: id, data: data.toString('base64') }));
      socket.on('close', () => { if (conns.delete(id)) emit('net-close', { conn: id }); });
      socket.on('error', error => { if (!conns.has(id)) reject(fail(`connect 127.0.0.1:${port}: ${error.message}`)); });
    });
    return id;
  },
  async net_send({ conn, data }) {
    const socket = conns.get(conn);
    if (socket) socket.write(Buffer.from(String(data || ''), 'base64'));
    return null;
  },
  async net_close({ conn }) {
    const socket = conns.get(conn);
    if (socket) { conns.delete(conn); socket.destroy(); }
    return null;
  }
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const ops = {
  ...fsOps, ...textOps, ...searchOps, ...watchOps, ...taskOps, ...extHostOps,
  async ping() { return { pid: process.pid, node: process.version, workspace: WORKSPACE }; }
};

async function handle(message) {
  const { id, op } = message;
  const fn = ops[op];
  if (!fn) {
    if (id !== undefined) write({ id, ok: false, error: `unknown operation: ${op}` });
    return;
  }
  try {
    const result = await fn(message);
    if (id !== undefined) write({ id, ok: true, result: result === undefined ? null : result });
  } catch (error) {
    if (id !== undefined) write({ id, ok: false, error: error && error.message ? error.message : String(error) });
  }
}

function shutdown() {
  stopExtHost();
  for (const socket of conns.values()) socket.destroy();
  conns.clear();
  for (const session of watches.values()) for (const w of session.watchers) w.close();
  watches.clear();
  outQueue.then(() => process.exit(0));
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  void handle(message);
});
input.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', error => { emit('agent-error', String(error && error.stack || error)); });

write({ event: 'ready', payload: { pid: process.pid, node: process.version, workspace: WORKSPACE } });
