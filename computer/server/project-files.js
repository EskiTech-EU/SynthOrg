'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./paths');
const { fail } = require('./database');

/**
 * The files of a project as the page's own column shows them: the folders
 * that are open, the files whose name holds what is searched, and what the
 * user does to them there — a new file, a new folder, a new name or place,
 * a removal. The same for a folder of this computer and for a container,
 * where the names are read and the changes made by the container itself.
 *
 * What is done here is the user's: it is recorded as a step of theirs, the
 * moment it lands, like a save. The record (.git) is not listed and not
 * touched.
 */

const CONTAINER_WORKDIR = '/workspace';
const HIDDEN = new Set(['.git']);
const MOST_ENTRIES = 5000;
const MOST_DIRS = 200;
const MOST_FOUND = 300;

/** A path inside the project, as its parts; '' is the project itself. */
function relativeOf(value, { root = false } = {}) {
  if (typeof value !== 'string') fail('Percorso mancante.');
  const raw = value.trim().replace(/\\/g, '/');
  if (raw.length > 1024) fail('Percorso troppo lungo.');
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('~')) fail('Usa un percorso relativo alla radice del progetto.');
  const parts = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') fail('Il percorso esce dal progetto.');
    if (/[\u0000-\u001f<>:"|?*]/.test(part)) fail(`"${part}" non è un nome valido.`);
    parts.push(part);
  }
  if (!parts.length && !root) fail('Percorso mancante.');
  if (parts.length && HIDDEN.has(parts[0])) fail(`"${parts[0]}" è lo storico del progetto e non si tocca da qui.`, 403);
  return parts.join('/');
}

// What the container runs through node, which its tools image has: the request as JSON in, the answer as JSON out.
const CONTAINER_SCRIPT = `
const fs=require('fs'),p=require('path');const root=${JSON.stringify(CONTAINER_WORKDIR)};
const req=JSON.parse(fs.readFileSync(0,'utf8'));const at=r=>r?p.join(root,r):root;
const out={};
try{
if(req.op==='list'){out.dirs={};for(const d of req.dirs){try{out.dirs[d]=fs.readdirSync(at(d),{withFileTypes:true}).filter(e=>!(d===''&&e.name==='.git')).slice(0,${MOST_ENTRIES}).map(e=>({name:e.name,dir:e.isDirectory()}));}catch{out.dirs[d]=null;}}}
else if(req.op==='file'){if(fs.existsSync(at(req.path)))throw new Error('exists');fs.mkdirSync(p.dirname(at(req.path)),{recursive:true});fs.writeFileSync(at(req.path),'');}
else if(req.op==='folder'){if(fs.existsSync(at(req.path)))throw new Error('exists');fs.mkdirSync(at(req.path),{recursive:true});}
else if(req.op==='rename'){if(!fs.existsSync(at(req.path)))throw new Error('missing');if(fs.existsSync(at(req.to)))throw new Error('exists');fs.mkdirSync(p.dirname(at(req.to)),{recursive:true});fs.renameSync(at(req.path),at(req.to));}
else if(req.op==='copy'){if(!fs.existsSync(at(req.path)))throw new Error('missing');if(fs.statSync(at(req.path)).isDirectory())throw new Error('folder');if(fs.existsSync(at(req.to)))throw new Error('exists');fs.mkdirSync(p.dirname(at(req.to)),{recursive:true});fs.copyFileSync(at(req.path),at(req.to));}
else if(req.op==='put'){if(fs.existsSync(at(req.path)))throw new Error('exists');fs.mkdirSync(p.dirname(at(req.path)),{recursive:true});fs.writeFileSync(at(req.path),Buffer.from(req.base64,'base64'));}
else if(req.op==='write'){if(fs.existsSync(at(req.path))&&fs.statSync(at(req.path)).isDirectory())throw new Error('folder');fs.mkdirSync(p.dirname(at(req.path)),{recursive:true});fs.writeFileSync(at(req.path),Buffer.from(req.base64,'base64'));}
else if(req.op==='read'){if(!fs.existsSync(at(req.path)))throw new Error('missing');const st=fs.statSync(at(req.path));if(st.isDirectory())throw new Error('folder');if(st.size>req.most)throw new Error('big');out.size=st.size;out.base64=fs.readFileSync(at(req.path)).toString('base64');}
else if(req.op==='remove'){if(!fs.existsSync(at(req.path)))throw new Error('missing');fs.rmSync(at(req.path),{recursive:true});}
}catch(e){out.error=e.message;}
process.stdout.write(JSON.stringify(out));`;

// What counts as an artifact in a folder that holds everything else too: what the editors of this computer work on.
const ARTIFACT_KINDS = [
  ['document', /\.(pcraft|psd|psb)$/i],
  ['image', /\.(png|jpe?g|webp|gif|bmp|tiff?|tga|ico|qoi|exr|hdr|avif|jxl|dng|cr2|cr3|nef|arw|pef|orf|rw2|raf|svg)$/i],
  ['export', /^esportazioni\//]
];
// Sources of the editors to come (3D, video), raw like the documents of the photo editor.
const RAW_FILE = /\.(blend|fbx|kra|xcf|ai|tex|typ)$/i;
const CHAPTER = /^capitoli\/([a-f0-9]{10})\.json$/;
// Where nobody keeps what they work on by hand.
const NOT_ARTIFACTS = new Set(['node_modules', 'target', 'dist', 'build', 'vendor', '__pycache__']);
const MOST_ARTIFACTS = 2000;
// Where what the chats of a project made is put among its artifacts.
const FROM_CHATS = 'generati';
const MAX_PLACED_BYTES = 200 * 1024 * 1024;
// What a page far from the files may read or write whole (read, write, readArtifact): the phone, over the bridge.
const READ_MOST = 2 * 1024 * 1024;
const WRITE_MOST = 10 * 1024 * 1024;
const ARTIFACT_READ_MOST = 4 * 1024 * 1024;

class ProjectFiles {
  constructor({ store, sandbox, projects, chatDir = null }) {
    this.store = store;
    this.sandbox = sandbox;
    this.projects = projects;
    // Where a chat keeps the files it makes, on this computer.
    this.chatDir = chatDir || (id => path.join(DATA_DIR, 'sandboxes', String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36), 'workspace'));
  }

  /** Where a path of a folder project is on this computer: inside the project, links followed. */
  local(project, relative) {
    const root = fs.realpathSync(project.path);
    const full = relative ? path.resolve(root, relative) : root;
    let probe = full;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    let real;
    try { real = fs.realpathSync(probe); } catch { real = probe; }
    if (real !== root && !real.startsWith(root + path.sep)) fail('Il percorso esce dal progetto.', 403);
    return full;
  }

  async inContainer(project, request) {
    const res = await this.sandbox.execInContainer({ containerName: project.container_name, argv: ['node', '-e', CONTAINER_SCRIPT], input: JSON.stringify(request) });
    if (!res.ok) fail(`I file del progetto non si possono leggere adesso: ${res.stderr || res.error}`, 502);
    let answer;
    try { answer = JSON.parse(res.stdout || '{}'); } catch { fail('Risposta del container non leggibile.', 502); }
    if (answer.error === 'exists') fail('Esiste già un file o una cartella con questo nome.', 409);
    if (answer.error === 'missing') fail('Il file o la cartella non esiste più.', 404);
    if (answer.error === 'folder') fail('Si copia un file, non una cartella.');
    if (answer.error === 'big') fail('File troppo grande per essere letto da qui.', 413);
    if (answer.error) fail(`Operazione sui file non riuscita: ${answer.error}`, 502);
    return answer;
  }

  /** What each of the folders asked holds, folders first, by name; a folder that is not there any more is null. */
  async list(projectId, dirs) {
    const project = this.store().project(projectId);
    const asked = [...new Set((Array.isArray(dirs) && dirs.length ? dirs : ['']).slice(0, MOST_DIRS).map(dir => relativeOf(String(dir ?? ''), { root: true })))];
    let found;
    if (project.kind === 'local') {
      found = {};
      for (const dir of asked) {
        try {
          found[dir] = fs.readdirSync(this.local(project, dir), { withFileTypes: true })
            .filter(entry => !(dir === '' && HIDDEN.has(entry.name))).slice(0, MOST_ENTRIES)
            .map(entry => ({ name: entry.name, dir: entry.isDirectory() }));
        } catch { found[dir] = null; }
      }
    } else found = (await this.inContainer(project, { op: 'list', dirs: asked })).dirs || {};
    const order = (a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    for (const dir of Object.keys(found)) if (found[dir]) found[dir].sort(order);
    return { dirs: found };
  }

  /** The files whose path holds every word searched, as git lists them: what the project ignores is left out. */
  async search(projectId, query) {
    const project = this.store().project(projectId);
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length) return { files: [], truncated: false };
    const out = await this.projects.tryGit(project, ['ls-files', '--cached', '--others', '--exclude-standard']);
    const files = String(out || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      .filter(file => { const lower = file.toLowerCase(); return words.every(word => lower.includes(word)); });
    // A name that holds the words comes before a folder that does.
    const inName = file => { const name = file.slice(file.lastIndexOf('/') + 1).toLowerCase(); return words.every(word => name.includes(word)) ? 0 : 1; };
    files.sort((a, b) => inName(a) - inName(b) || a.localeCompare(b));
    return { files: files.slice(0, MOST_FOUND), truncated: files.length > MOST_FOUND };
  }

  // --- the artifacts ------------------------------------------------------------------------
  //
  // What is worked on with the editors of this computer: the photos and their documents, the chapters of the text,
  // what was exported. In a folder project they are among its files; for a pod's project they are in a folder of
  // this computer and not in the pod (projects.js, `artifactsDir`), so they are listed, renamed, copied and removed
  // here, and put into the pod, where the user says, with `place`.

  /** A path among the artifacts, on this computer; never outside their folder, never its record or the scratch. */
  artifact(project, value) {
    const relative = relativeOf(value);
    if (relative.split('/').some(part => part.startsWith('.'))) fail('Non è un artefatto del progetto.', 403);
    const root = fs.realpathSync(this.projects.artifactsDir(project));
    const full = path.resolve(root, relative);
    let probe = full;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    let real;
    try { real = fs.realpathSync(probe); } catch { real = probe; }
    if (real !== root && !real.startsWith(root + path.sep)) fail('Il percorso esce dagli artefatti del progetto.', 403);
    return { relative, full };
  }

  /** An artifact as a file of this computer, for the page that shows it small. */
  artifactFile(projectId, value) {
    const project = this.store().project(projectId);
    const { full } = this.artifact(project, value);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) fail('L’artefatto non esiste più.', 404);
    return { full, size: fs.statSync(full).size };
  }

  /**
   * What the chats of the project made — a picture generated, a file written out — is an artifact of the project:
   * a copy of each is put among them, in a folder of its own, the first time it is seen and again when the chat
   * makes it anew. What was taken is noted in the database, so that a copy the user renamed, moved or removed does not come back.
   * One step of the record for what came in.
   */
  async takeFromChats(project) {
    const store = this.store();
    let chats = [];
    try { chats = [...store.listConversations('', false, project.id), ...store.listConversations('', true, project.id)]; } catch { return []; }
    if (!chats.length) return [];
    const root = this.projects.artifactsDir(project);
    // What was taken already is kept with the rest of what the app knows, in its database: not in a file beside
    // the artifacts, and not in the project, which in a folder is the user's own folder and repository.
    const taken = store.artifactsTaken(project.id);
    const came = [];
    const walk = (chat, dir, prefix, depth) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        // Hidden files and the speech the chat keeps for itself are not what it made for the user.
        if (entry.name.startsWith('.') || entry.name.startsWith('tts_') || entry.name.startsWith('_tts_')) continue;
        const full = path.join(dir, entry.name);
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (depth < 3 && !NOT_ARTIFACTS.has(entry.name)) walk(chat, full, relative, depth + 1); continue; }
        if (!entry.isFile()) continue;
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.size > MAX_PLACED_BYTES) continue;
        const key = `${chat.id}/${relative}`, stamp = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
        if (taken.get(key) === stamp) continue;
        // Under its own name; one already there under that name is not written over.
        const ext = path.extname(entry.name), stem = path.basename(entry.name, ext);
        let name = entry.name;
        for (let n = 2; fs.existsSync(path.join(root, FROM_CHATS, name)); n++) name = `${stem}-${n}${ext}`;
        try {
          fs.mkdirSync(path.join(root, FROM_CHATS), { recursive: true });
          fs.copyFileSync(full, path.join(root, FROM_CHATS, name));
          store.markArtifactTaken(project.id, key, stamp, `${FROM_CHATS}/${name}`);
          came.push(`${FROM_CHATS}/${name}`);
        } catch {}
      }
    };
    for (const chat of chats) walk(chat, this.chatDir(chat.id), '', 0);
    if (!came.length) return [];
    try { await this.projects.recordArtifacts(project, { message: came.length === 1 ? `dalla chat: ${came[0]}` : `dalla chat: ${came.length} file`, source: 'agent' }); } catch {}
    return came;
  }

  /** The artifacts of the project, newest first; `apart` says they are kept apart from the project's files (a pod's). */
  async artifacts(projectId) {
    const project = this.store().project(projectId);
    await this.takeFromChats(project);
    const apart = project.kind !== 'local';
    const root = this.projects.artifactsDir(project);
    // The chapters are files named by a number: what is read is their title.
    let titles = new Map();
    try { titles = new Map(JSON.parse(fs.readFileSync(path.join(root, 'studio.json'), 'utf8')).chapters.map(c => [c.id, String(c.title || '')])); } catch {}
    const out = [];
    const walk = (dir, prefix, depth) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || out.length >= MOST_ARTIFACTS) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (depth < 4 && !NOT_ARTIFACTS.has(entry.name)) walk(path.join(dir, entry.name), relative, depth + 1); continue; }
        if (!entry.isFile()) continue;
        const chapter = CHAPTER.exec(relative);
        // The two manifests say how the folder is worked on: they are not what is worked on.
        if (relative === 'studio.json' || relative === 'foto.json') continue;
        if (chapter && !titles.has(chapter[1])) continue;
        const kind = chapter ? 'text' : (ARTIFACT_KINDS.find(([, test]) => test.test(relative)) || [apart ? 'file' : null])[0];
        if (!kind) continue;
        let stat;
        try { stat = fs.statSync(path.join(dir, entry.name)); } catch { continue; }
        // Raw is what is still worked on, and opens in its editor; the rest is finished: shown, and put where it is wanted.
        const stage = kind === 'document' || kind === 'text' || RAW_FILE.test(relative) ? 'raw' : 'finished';
        out.push({ path: relative, name: chapter ? titles.get(chapter[1]) || entry.name : entry.name, kind, stage, bytes: stat.size, mtime: stat.mtime.toISOString() });
      }
    };
    walk(root, '', 0);
    out.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : a.path.localeCompare(b.path)));
    return { apart, files: out };
  }

  /**
   * What is done to an artifact of a pod's project: another name, a copy under another name, a removal, each a step
   * of the artifacts' own record; and `place`, which puts a copy of it among the project's files, in the pod, at
   * the place given — a step of the project's record. In a folder project the artifacts are files like the others,
   * and all of this is `change`.
   */
  async changeArtifact(projectId, input = {}) {
    const project = this.store().project(projectId);
    if (project.kind === 'local') fail('In un progetto in cartella gli artefatti sono file del progetto: si spostano dalla colonna dei file.', 400);
    const op = input.action;
    if (!['rename', 'copy', 'remove', 'place'].includes(op)) fail('Operazione non valida.');
    const from = this.artifact(project, input.path);
    if (!fs.existsSync(from.full) || !fs.statSync(from.full).isFile()) fail('L’artefatto non esiste più.', 404);
    if (op === 'place') {
      const to = relativeOf(input.to);
      if (fs.statSync(from.full).size > MAX_PLACED_BYTES) fail('File troppo grande per essere portato nel pod.', 413);
      await this.inContainer(project, { op: 'put', path: to, base64: fs.readFileSync(from.full).toString('base64') });
      let git;
      try { git = await this.projects.checkpoint(project, { message: `porta ${to} dagli artefatti`, source: 'user' }); }
      catch (error) { git = { ready: false, error: error.message }; }
      return { action: op, path: from.relative, to, git };
    }
    let to = null;
    if (op === 'remove') fs.rmSync(from.full);
    else {
      const dest = this.artifact(project, input.to);
      if (fs.existsSync(dest.full)) fail('Esiste già un artefatto con questo nome.', 409);
      fs.mkdirSync(path.dirname(dest.full), { recursive: true });
      if (op === 'rename') fs.renameSync(from.full, dest.full); else fs.copyFileSync(from.full, dest.full);
      to = dest.relative;
    }
    const message = op === 'remove' ? `elimina ${from.relative}` : op === 'copy' ? `copia ${from.relative} in ${to}` : `sposta ${from.relative} in ${to}`;
    try { await this.projects.recordArtifacts(project, { message, source: 'user' }); } catch {}
    return { action: op, path: from.relative, to, git: null };
  }

  /**
   * One file as it is now, for a page that cannot reach the files itself (the
   * phone): its bytes as base64, and whether they read as text. Small files
   * only; what is larger is said to be, not sent.
   */
  async read(projectId, value) {
    const project = this.store().project(projectId);
    const target = relativeOf(value);
    let bytes;
    if (project.kind === 'local') {
      const full = this.local(project, target);
      let stat;
      try { stat = fs.statSync(full); } catch { fail('Il file non esiste più.', 404); }
      if (stat.isDirectory()) fail('È una cartella, non un file.');
      if (stat.size > READ_MOST) fail('File troppo grande per essere letto da qui.', 413);
      bytes = fs.readFileSync(full);
    } else {
      const answer = await this.inContainer(project, { op: 'read', path: target, most: READ_MOST });
      bytes = Buffer.from(answer.base64 || '', 'base64');
    }
    const text = !bytes.subarray(0, 8192).includes(0);
    return { path: target, size: bytes.length, text, content: text ? bytes.toString('utf8') : null, base64: text ? null : bytes.toString('base64') };
  }

  /**
   * A file written whole, as text or as bytes (base64): a change made by hand
   * where there is no editor, a file brought from the phone. A step of the
   * user's, like a save.
   */
  async write(projectId, input = {}) {
    const project = this.store().project(projectId);
    const target = relativeOf(input.path);
    const bytes = typeof input.base64 === 'string' ? Buffer.from(input.base64, 'base64')
      : typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : null;
    if (!bytes) fail('Contenuto mancante.');
    if (bytes.length > WRITE_MOST) fail('File troppo grande per essere scritto da qui.', 413);
    if (project.kind === 'local') {
      const full = this.local(project, target);
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) fail('È una cartella, non un file.');
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, bytes);
    } else await this.inContainer(project, { op: 'write', path: target, base64: bytes.toString('base64') });
    let git;
    try { git = await this.projects.checkpoint(project, { message: `scrive ${target}`, source: 'user' }); }
    catch (error) { git = { ready: false, error: error.message }; }
    return { path: target, size: bytes.length, git };
  }

  /** One artifact, small enough to be looked at from the phone: its bytes as base64, with what it is. */
  readArtifact(projectId, value) {
    const { full, size } = this.artifactFile(projectId, value);
    const relative = relativeOf(value);
    const kind = (ARTIFACT_KINDS.find(([, test]) => test.test(relative)) || ['file'])[0];
    if (size > ARTIFACT_READ_MOST) return { path: relative, kind, size, tooLarge: true, text: false, content: null, base64: null };
    const bytes = fs.readFileSync(full);
    const text = kind === 'file' && !bytes.subarray(0, 8192).includes(0);
    return { path: relative, kind, size, tooLarge: false, text, content: text ? bytes.toString('utf8') : null, base64: text ? null : bytes.toString('base64') };
  }

  /** A new file, a new folder, a new name or place, a copy of a file under another name, a removal: done, then recorded as the user's step. */
  async change(projectId, input = {}) {
    const project = this.store().project(projectId);
    const op = input.action;
    if (!['file', 'folder', 'rename', 'copy', 'remove'].includes(op)) fail('Operazione non valida.');
    const target = relativeOf(input.path);
    const to = op === 'rename' || op === 'copy' ? relativeOf(input.to) : null;
    if (to && (to === target || to.startsWith(target + '/'))) fail('La destinazione è dentro ciò che sposti.');
    if (project.kind === 'local') {
      const full = this.local(project, target);
      if (op === 'file' || op === 'folder') {
        if (fs.existsSync(full)) fail('Esiste già un file o una cartella con questo nome.', 409);
        if (op === 'folder') fs.mkdirSync(full, { recursive: true });
        else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, ''); }
      } else {
        if (!fs.existsSync(full)) fail('Il file o la cartella non esiste più.', 404);
        if (op === 'remove') fs.rmSync(full, { recursive: true });
        else if (op === 'copy') {
          if (fs.statSync(full).isDirectory()) fail('Si copia un file, non una cartella.');
          const dest = this.local(project, to);
          if (fs.existsSync(dest)) fail('Esiste già un file o una cartella con questo nome.', 409);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(full, dest);
        } else {
          const dest = this.local(project, to);
          if (fs.existsSync(dest)) fail('Esiste già un file o una cartella con questo nome.', 409);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(full, dest);
        }
      }
    } else await this.inContainer(project, { op, path: target, to });
    const message = op === 'file' ? `crea ${target}` : op === 'folder' ? `crea la cartella ${target}` : op === 'remove' ? `elimina ${target}` : op === 'copy' ? `copia ${target} in ${to}` : `sposta ${target} in ${to}`;
    let git;
    try { git = await this.projects.checkpoint(project, { message, source: 'user' }); }
    catch (error) { git = { ready: false, error: error.message }; }
    return { action: op, path: target, to, git };
  }
}

module.exports = { ProjectFiles, relativeOf };
