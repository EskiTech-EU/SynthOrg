'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fail } = require('./database');

const CONTAINER_WORKDIR = '/workspace';

/**
 * The hands a model has on a Code project: one tool to look, five to change.
 * Together they cover everything it can do to the code, and nothing else — no
 * shell, no network, no path outside the project.
 *
 * Two rules hold for every one of them. Lines are ours: `read_file` hands back
 * numbered lines and `edit_file` is addressed by those numbers, so the model
 * never counts and never miscounts. And every change is recorded the moment it
 * lands, by the same checkpoint a save goes through, under the name of the
 * tool that made it — so the history is the whole story and any of it can be
 * undone.
 */

const MAX_READ_BYTES = 400 * 1024;
// Copies of a project's files handed to a chat that is not the project's (the assistant's tasks):
// where they go in that chat's workspace, and how much goes at once.
const COPIES_DIR = 'progetti';
const COPIES_MOST = 60;
const COPY_BYTES = 8 * 1024 * 1024;
const POINTERS_MOST = 2000;
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'build', '__pycache__', '.venv']);
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_READ_LINES = 2000;

/** The record itself is not the model's to edit. */
const FORBIDDEN_ROOTS = new Set(['.git']);

function normalizeRelative(value) {
  if (typeof value !== 'string' || !value.trim()) fail('Percorso mancante.');
  const raw = value.trim().replace(/\\/g, '/');
  if (raw.length > 1024) fail('Percorso troppo lungo.');
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('~')) {
    fail('Usa un percorso relativo alla radice del progetto.');
  }
  const parts = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') fail('Il percorso esce dal progetto.');
    parts.push(part);
  }
  if (!parts.length) fail('Percorso mancante.');
  if (FORBIDDEN_ROOTS.has(parts[0])) fail(`"${parts[0]}" è lo storico del progetto e non si modifica dai tool.`, 403);
  return parts.join('/');
}

/** Lines as the model sees them, numbered by us so it never has to count. */
function numberLines(text, first = 1) {
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const width = String(first + lines.length - 1).length;
  return lines.map((line, index) => `${String(first + index).padStart(width, ' ')}| ${line}`).join('\n');
}

function countLines(text) {
  if (!text) return 0;
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Scripts the container runs through node, which its tools image guarantees. */
const SCRIPTS = {
  read: 'const f=require("fs");process.stdout.write(f.readFileSync(process.argv[1]));',
  write: 'const f=require("fs"),p=require("path");const t=process.argv[1];f.mkdirSync(p.dirname(t),{recursive:true});f.writeFileSync(t,f.readFileSync(0));',
  stat: 'const f=require("fs");const s=f.statSync(process.argv[1],{throwIfNoEntry:false});process.stdout.write(JSON.stringify(s?{size:s.size,dir:s.isDirectory()}:null));',
  rename: 'const f=require("fs"),p=require("path");const t=process.argv[2];f.mkdirSync(p.dirname(t),{recursive:true});f.renameSync(process.argv[1],t);',
  remove: 'const f=require("fs");f.rmSync(process.argv[1]);'
};

class CodeTools {
  constructor({ store, sandbox, projects }) {
    this.store = store;
    this.sandbox = sandbox;
    this.projects = projects;
  }

  /**
   * Where a path the model named actually is. A local project is a folder of
   * this machine, so the answer has to survive symbolic links: the deepest
   * part of the path that exists is resolved and has to still be inside the
   * project. In a container the boundary is the container itself.
   */
  locate(project, value) {
    const relative = normalizeRelative(value);
    if (project.kind !== 'local') return { relative, full: `/workspace/${relative}` };
    const root = fs.realpathSync(project.path);
    const full = path.resolve(root, relative);
    let probe = full;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    let real;
    try { real = fs.realpathSync(probe); } catch { real = probe; }
    if (real !== root && !real.startsWith(root + path.sep)) fail('Il percorso esce dal progetto.', 403);
    return { relative, full };
  }

  async node(project, script, args, input = null, encoding = 'utf8') {
    const res = await this.sandbox.execInContainer({
      containerName: project.container_name,
      argv: ['node', '-e', script, ...args],
      input,
      encoding
    });
    if (!res.ok) fail(`Operazione sul file non riuscita: ${res.stderr || res.error}`, 502);
    return res.stdout;
  }

  async statOf(project, target) {
    if (project.kind === 'local') {
      const info = fs.statSync(target.full, { throwIfNoEntry: false });
      return info ? { size: info.size, dir: info.isDirectory() } : null;
    }
    const out = await this.node(project, SCRIPTS.stat, [target.full]);
    try { return JSON.parse(out || 'null'); } catch { return null; }
  }

  async readFile(project, target) {
    const info = await this.statOf(project, target);
    if (!info) fail(`Il file "${target.relative}" non esiste.`, 404);
    if (info.dir) fail(`"${target.relative}" è una cartella, non un file.`);
    if (info.size > MAX_READ_BYTES) fail(`Il file "${target.relative}" è troppo grande da leggere (${Math.round(info.size / 1024)} KB).`, 413);
    const buffer = project.kind === 'local'
      ? fs.readFileSync(target.full)
      : Buffer.from(await this.node(project, SCRIPTS.read, [target.full], null, 'buffer'));
    if (buffer.subarray(0, 8192).includes(0)) fail(`"${target.relative}" è un file binario.`, 415);
    return buffer.toString('utf8');
  }

  async writeFile(project, target, content) {
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) fail('Contenuto troppo grande da scrivere.', 413);
    if (project.kind === 'local') {
      fs.mkdirSync(path.dirname(target.full), { recursive: true });
      fs.writeFileSync(target.full, content);
      return;
    }
    await this.node(project, SCRIPTS.write, [target.full], content);
  }

  /**
   * Every change is recorded as it lands, by the same path a save takes, so
   * the model has no way to touch the code without the history hearing it.
   */
  async record(project, tool, message) {
    try {
      return await this.projects.checkpoint(project, { message, source: 'agent', tool });
    } catch (error) {
      // The change is on disk either way; saying so is better than pretending
      // it did not happen.
      return { ready: false, error: error.message };
    }
  }

  text(input, field = 'content') {
    const value = input[field];
    if (typeof value !== 'string') fail(`Manca "${field}".`);
    return value;
  }

  line(input, field, fallback = null) {
    const value = input[field];
    if (value === undefined || value === null || value === '') {
      if (fallback !== null) return fallback;
      fail(`Manca "${field}".`);
    }
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) fail(`"${field}" deve essere un numero di riga.`);
    return number;
  }

  // --- the six --------------------------------------------------------------

  async read_file(project, input) {
    const target = this.locate(project, input.path);
    const content = await this.readFile(project, target);
    const all = content.split('\n');
    if (all.length && all[all.length - 1] === '') all.pop();
    const from = this.line(input, 'from_line', 1);
    const to = Math.min(this.line(input, 'to_line', all.length), all.length);
    if (from > all.length) fail(`Il file ha ${all.length} righe: la riga ${from} non esiste.`);
    const slice = all.slice(from - 1, Math.min(to, from - 1 + MAX_READ_LINES));
    return {
      path: target.relative,
      total_lines: all.length,
      from_line: from,
      to_line: from + slice.length - 1,
      truncated: slice.length < to - from + 1,
      content: numberLines(slice.join('\n') + '\n', from)
    };
  }

  async create_file(project, input) {
    const target = this.locate(project, input.path);
    const content = this.text(input);
    if (await this.statOf(project, target)) fail(`"${target.relative}" esiste già: usa overwrite_file o edit_file.`, 409);
    await this.writeFile(project, target, content);
    const git = await this.record(project, 'create_file', `crea ${target.relative}`);
    return { path: target.relative, created: true, lines: countLines(content), git };
  }

  async overwrite_file(project, input) {
    const target = this.locate(project, input.path);
    const content = this.text(input);
    const info = await this.statOf(project, target);
    if (info?.dir) fail(`"${target.relative}" è una cartella.`);
    const before = info ? countLines(await this.readFile(project, target)) : 0;
    await this.writeFile(project, target, content);
    const git = await this.record(project, 'overwrite_file', `riscrive ${target.relative}`);
    return { path: target.relative, lines: countLines(content), previous_lines: before, git };
  }

  /**
   * A change addressed by the line numbers `read_file` handed out, optionally
   * narrowed to the exact words to touch. The narrower form is the safe one:
   * if those words are not there, or are there more than once, nothing is
   * written and the model is told — a miss is never a silent wrong edit.
   */
  async edit_file(project, input) {
    const target = this.locate(project, input.path);
    const replacement = this.text(input);
    const original = await this.readFile(project, target);
    const all = original.split('\n');
    const trailing = all.length > 0 && all[all.length - 1] === '';
    if (trailing) all.pop();
    const from = this.line(input, 'from_line');
    const to = this.line(input, 'to_line', from);
    if (to < from) fail('"to_line" viene prima di "from_line".');
    if (from > all.length) fail(`Il file ha ${all.length} righe: la riga ${from} non esiste.`);
    const last = Math.min(to, all.length);
    const region = all.slice(from - 1, last).join('\n');

    let updated;
    const match = typeof input.match === 'string' ? input.match : null;
    if (match !== null) {
      if (!match) fail('"match" è vuoto: togli il filtro o scrivi il testo esatto da sostituire.');
      const first = region.indexOf(match);
      if (first === -1) {
        fail(`Alle righe ${from}-${last} non c’è il testo indicato in "match". Rileggi il file: niente è stato cambiato.`, 409);
      }
      if (region.indexOf(match, first + match.length) !== -1) {
        fail(`Il testo di "match" compare più volte fra le righe ${from}-${last}: restringi l’intervallo. Niente è stato cambiato.`, 409);
      }
      updated = region.slice(0, first) + replacement + region.slice(first + match.length);
    } else {
      updated = replacement;
    }

    const next = [...all.slice(0, from - 1), ...updated.split('\n'), ...all.slice(last)];
    await this.writeFile(project, target, next.join('\n') + (trailing ? '\n' : ''));
    const git = await this.record(project, 'edit_file', `modifica ${target.relative}:${from}${last > from ? `-${last}` : ''}`);
    // What the change looks like now, numbered, so the next edit aims at the
    // lines as they are and not as they were.
    const shownFrom = Math.max(1, from - 2);
    const shownTo = Math.min(next.length, from - 1 + updated.split('\n').length + 2);
    return {
      path: target.relative,
      replaced_lines: `${from}-${last}`,
      total_lines: next.length,
      content: numberLines(next.slice(shownFrom - 1, shownTo).join('\n') + '\n', shownFrom),
      git
    };
  }

  async rename_file(project, input) {
    const from = this.locate(project, input.path);
    const to = this.locate(project, input.to);
    if (!await this.statOf(project, from)) fail(`"${from.relative}" non esiste.`, 404);
    if (await this.statOf(project, to)) fail(`"${to.relative}" esiste già.`, 409);
    if (project.kind === 'local') {
      fs.mkdirSync(path.dirname(to.full), { recursive: true });
      fs.renameSync(from.full, to.full);
    } else {
      await this.node(project, SCRIPTS.rename, [from.full, to.full]);
    }
    const git = await this.record(project, 'rename_file', `rinomina ${from.relative} in ${to.relative}`);
    return { from: from.relative, to: to.relative, git };
  }

  async delete_file(project, input) {
    const target = this.locate(project, input.path);
    const info = await this.statOf(project, target);
    if (!info) fail(`"${target.relative}" non esiste.`, 404);
    if (info.dir) fail(`"${target.relative}" è una cartella: i tool lavorano sui file.`);
    if (project.kind === 'local') fs.rmSync(target.full);
    else await this.node(project, SCRIPTS.remove, [target.full]);
    const git = await this.record(project, 'delete_file', `elimina ${target.relative}`);
    return { path: target.relative, deleted: true, git };
  }

  /**
   * The project's files, for the model's context. Asked of git, so what the
   * .gitignore keeps out of the history stays out of the prompt too: one rule
   * for both, and the model never sees node_modules.
   */
  async tree(projectId, { limit = 2000 } = {}) {
    const project = this.store().project(projectId);
    const out = await this.projects.tryGit(project, ['ls-files', '--cached', '--others', '--exclude-standard']);
    const files = String(out || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).sort();
    return {
      root: project.kind === 'local' ? project.path : CONTAINER_WORKDIR,
      kind: project.kind,
      // Commands run in the project's container, or, for a project living in
      // a folder of this machine, in the editor's own terminal on this machine.
      runsCommands: true,
      commandsIn: project.kind === 'podman' ? 'container' : 'editor',
      total: files.length,
      truncated: files.length > limit,
      files: files.slice(0, limit)
    };
  }

  /**
   * The files of a project as pointers: their paths, and nothing of what is
   * in them. Read without starting the project: its folder, or its volume.
   */
  async pointers(projectId, { limit = POINTERS_MOST } = {}) {
    const project = this.store().project(projectId);
    const out = await this.projects.askGit(project, ['ls-files', '--cached', '--others', '--exclude-standard']);
    let files;
    if (out !== null) files = out.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    else if (project.kind === 'local') files = this.walk(project.path, limit + 1);
    else fail('I file del progetto non si possono leggere adesso.', 503);
    files.sort();
    return { id: project.id, name: project.name, kind: project.kind, total: files.length, truncated: files.length > limit, files: files.slice(0, limit) };
  }

  /** A folder that git does not know yet, walked by hand: what a build or a package manager made is left out. */
  walk(rootDir, most) {
    const found = [];
    const visit = (dir, prefix) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (found.length >= most) return;
        if (entry.isDirectory()) { if (!SKIPPED_DIRS.has(entry.name)) visit(path.join(dir, entry.name), `${prefix}${entry.name}/`); }
        else if (entry.isFile()) found.push(prefix + entry.name);
      }
    };
    visit(rootDir, '');
    return found;
  }

  /**
   * Copies of files of a project, written in the workspace of a chat that is
   * not the project's: the assistant's tasks work on them there, in their
   * own container, and the project is not touched or started. A file of a
   * folder is copied as it is; one of a container is read where it is when
   * the container is up, otherwise as its last recorded step holds it.
   * Returns where each one went, or why it did not.
   */
  async copyTo(projectId, workspaceDir, paths) {
    const project = this.store().project(projectId);
    const folder = `${COPIES_DIR}/${String(project.name).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'progetto'}`;
    const asked = [...new Set((Array.isArray(paths) ? paths : []).filter(item => typeof item === 'string'))];
    const files = [];
    let room = COPY_BYTES;
    for (const item of asked.slice(0, COPIES_MOST)) {
      try {
        const target = this.locate(project, item);
        let buffer;
        if (project.kind === 'local') {
          const info = fs.statSync(target.full, { throwIfNoEntry: false });
          if (!info) fail('non esiste', 404);
          if (info.isDirectory()) fail('è una cartella: chiedi i file che contiene');
          if (info.size > room) fail('troppo grande per questa copia', 413);
          buffer = fs.readFileSync(target.full);
        } else {
          let content = null;
          try { content = await this.readFile(project, target); } catch (error) { if ([404, 413, 415].includes(error.status)) throw error; }
          if (content === null) content = await this.projects.askGit(project, ['show', `HEAD:${target.relative}`]);
          if (content === null) fail('non si può leggere adesso', 503);
          buffer = Buffer.from(content, 'utf8');
          if (buffer.length > room) fail('troppo grande per questa copia', 413);
        }
        const to = path.join(workspaceDir, ...folder.split('/'), ...target.relative.split('/'));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, buffer);
        room -= buffer.length;
        files.push({ path: target.relative, to: `${folder}/${target.relative}`, size: buffer.length });
      } catch (error) {
        files.push({ path: String(item).slice(0, 300), error: error.message });
      }
    }
    return { folder, files, left: Math.max(0, asked.length - COPIES_MOST) };
  }

  /** The copies handed to a chat are taken away: every task starts without the ones of the task before. */
  clearCopies(workspaceDir) {
    fs.rmSync(path.join(workspaceDir, COPIES_DIR), { recursive: true, force: true });
    return { cleared: true };
  }

  async run(projectId, name, input = {}) {
    if (!Object.prototype.hasOwnProperty.call(TOOLS, name)) fail('Strumento non trovato.', 404);
    const project = this.store().project(projectId);
    return this[name](project, input || {});
  }
}

/**
 * What the model is told it can do. Five that change the code and one that
 * reads it: there is nothing else it can reach.
 */
const TOOLS = {
  read_file: {
    description: 'Legge un file del progetto e restituisce le righe già numerate. Usa questi numeri per edit_file: non contarli da solo.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Percorso relativo alla radice del progetto, es. "src/app.js".' },
        from_line: { type: 'integer', description: 'Prima riga da leggere (1 se omesso).' },
        to_line: { type: 'integer', description: 'Ultima riga da leggere (fine del file se omesso).' }
      },
      required: ['path']
    }
  },
  create_file: {
    description: 'Crea un file che non esiste ancora, con il contenuto dato. Fallisce se il file c’è già.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Percorso relativo del nuovo file.' },
        content: { type: 'string', description: 'Contenuto completo del file.' }
      },
      required: ['path', 'content']
    }
  },
  edit_file: {
    description: 'Cambia una parte di un file, indicando le righe lette con read_file. Con "match" sostituisce solo quel testo esatto dentro le righe indicate, e rifiuta se non lo trova o se compare più volte.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Percorso relativo del file.' },
        from_line: { type: 'integer', description: 'Prima riga da sostituire, come numerata da read_file.' },
        to_line: { type: 'integer', description: 'Ultima riga da sostituire (uguale a from_line se omesso).' },
        match: { type: 'string', description: 'Facoltativo: il testo esatto da sostituire dentro quelle righe. Più sicuro: se non combacia, non viene scritto niente.' },
        content: { type: 'string', description: 'Il testo nuovo: sostituisce le righe indicate, o solo "match" se lo hai dato.' }
      },
      required: ['path', 'from_line', 'content']
    }
  },
  overwrite_file: {
    description: 'Riscrive un file intero. Usalo solo quando cambia quasi tutto: per una modifica mirata usa edit_file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Percorso relativo del file.' },
        content: { type: 'string', description: 'Il nuovo contenuto completo.' }
      },
      required: ['path', 'content']
    }
  },
  rename_file: {
    description: 'Rinomina o sposta un file dentro il progetto.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Percorso relativo attuale.' },
        to: { type: 'string', description: 'Nuovo percorso relativo.' }
      },
      required: ['path', 'to']
    }
  },
  delete_file: {
    description: 'Elimina un file del progetto. Resta nello storico git, quindi è recuperabile.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Percorso relativo del file da eliminare.' } },
      required: ['path']
    }
  }
};

/** The tools as a chat completion expects to be told about them. */
function toolSpecs() {
  return Object.entries(TOOLS).map(([name, tool]) => ({
    type: 'function',
    function: { name, description: tool.description, parameters: tool.parameters }
  }));
}

module.exports = { CodeTools, TOOLS, COPIES_DIR, toolSpecs, numberLines, normalizeRelative };
