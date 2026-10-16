'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fail, projectEnvs } = require('./database');
const { DATA_DIR } = require('./paths');
const ml = require('./photo-ml');
const CHEAT_SHEET = require('./photo-commands.json');

/**
 * The Foto tab of the Studio: photo projects, worked on in photocraft —
 * which runs in the page, in a frame of the tab (server/photocraft.js) — and
 * by functions of SynthOrg's that run in a pod (server/photo-ml.js).
 *
 * A photo project is a project like the Studio's texts and the Code projects
 * (`projects.section = 'photo'`): a folder of this computer, the same record,
 * the same chats. It is made with a canvas: empty at a size, or from a base
 * image (copied into the folder). The page builds that canvas in the editor
 * the first time the project is opened and saves it as the project's
 * document; from then on opening the project opens that document.
 *
 * What this module owns: the folder (its manifest, its listing, reading and
 * writing a file in it, each write a step of the record), the model's tools,
 * and the functions as jobs the page follows. The app itself is in the page,
 * so a tool that acts on it is settled here — is it allowed, does the file
 * exist, may it be overwritten — and comes back as an instruction the page
 * carries out (`{ page: { op, … } }`), the way a command of a local Code
 * project is settled here and run in the editor's terminal.
 */
const MANIFEST = 'foto.json';
const SCRATCH = '.synthorg';
const RESULT_SUFFIX = '.senza-sfondo.png';
// Where a function leaves its result when the page is going to put it into the open document.
const SCRATCH_RESULT = 'rembg-out.png';
const DOCUMENT_EXT = '.pcraft';
const BACKGROUNDS = ['white', 'transparent', 'black'];
const MIN_SIDE = 1;
const MAX_SIDE = 30000;
const DEFAULT_SIZE = { width: 1920, height: 1080 };
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.tga', '.ico', '.qoi', '.exr', '.hdr', '.avif', '.jxl', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.pef', '.orf', '.rw2', '.raf']);
const DOCUMENT_EXTS = new Set(['.pcraft', '.psd', '.psb']);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif' };
const MAX_LISTED = 500;
const MAX_IN_BLOCK = 60;
const MAX_BATCH = 64;
const MAX_COMMAND_HITS = 40;
const MAX_WRITE_BYTES = 200 * 1024 * 1024;
const BLOCK_TITLE = '[FOTO]';
// The user's own models, added from the Hub: kept with the app's settings.
const USER_MODELS_SETTING = 'photo_onnx_models';
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];
const now = () => new Date().toISOString();

function isDirectory(value) {
  try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

/**
 * Width and height from the file's own header, for the common formats, so
 * the listing does not decode a single pixel. Null when the format is not
 * one of these or the header is not where it should be.
 */
function imageSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    const b = head.subarray(0, read);
    if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (b.length >= 10 && b.toString('ascii', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (b.length >= 26 && b.toString('ascii', 0, 2) === 'BM') return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
    if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = b.toString('ascii', 12, 16);
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') { const bits = b.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
      if (chunk === 'VP8X') return { width: (b.readUIntLE(24, 3)) + 1, height: (b.readUIntLE(27, 3)) + 1 };
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      let at = 2;
      while (at + 9 < b.length) {
        if (b[at] !== 0xff) { at++; continue; }
        const marker = b[at + 1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
        const length = b.readUInt16BE(at + 2);
        if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7) };
        }
        at += 2 + length;
      }
    }
    return null;
  } catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

class PhotoManager {
  constructor({ store, projects, permissions = null, sandbox = null, photocraft = null, hub = null, mlImpl = ml, dataDir = DATA_DIR }) {
    this.store = store;
    this.projects = projects;
    this.permissions = permissions;
    this.sandbox = sandbox;
    this.photocraft = photocraft;
    this.hub = hub;
    this.ml = mlImpl;
    this.dataDir = dataDir;
    // Jobs the page follows: one per project for the functions, one for the models' download.
    this.jobs = new Map();
    this.warm = null;
  }

  // --- the models: the ones SynthOrg lists, and the ones the user adds from the Hub ----------------

  /** The user's own models, as they are kept: a name of ours → what is needed to download, feed and read each. */
  userModels() {
    try {
      const kept = JSON.parse(this.store().getSetting(USER_MODELS_SETTING) || '{}');
      return kept && typeof kept === 'object' && !Array.isArray(kept) ? kept : {};
    } catch { return {}; }
  }

  saveUserModels(models) {
    this.store().setSetting(USER_MODELS_SETTING, JSON.stringify(models));
  }

  /** Every model a project can choose: SynthOrg's list, then the user's (ready ones only). */
  catalogue() {
    const user = Object.fromEntries(Object.entries(this.userModels()).filter(([, model]) => model.ready));
    return { ...ml.MODELS, ...user };
  }

  /** What `settings.model` names, as the pod module wants it: a name of its table, or a description. */
  modelFor(key) {
    if (ml.MODELS[key]) return key;
    const model = this.userModels()[key];
    if (!model || !model.ready) fail('Il modello scelto per questo progetto non c’è più: scegline un altro nelle impostazioni delle foto.', 409);
    return model;
  }

  /**
   * A model from the Hub, added to the user's list: its file is downloaded by
   * the inert channel into the models' volume and checked against the hash
   * the Hub keeps for it; then the program reads what the file says of
   * itself. It becomes usable if it takes a picture: one input of three
   * channels. What no file says — how the pictures it was trained on were
   * normalised — starts from the ImageNet values, and is the user's to change.
   */
  async addUserModel({ repo, path: filePath } = {}) {
    if (!this.hub) fail('Hugging Face non è disponibile.', 501);
    const info = await this.hub.repoOnnx(repo);
    const file = info.files.find(entry => entry.path === filePath);
    if (!file) fail('File non trovato nel repository.', 404);
    if (file.external) fail('Questo modello tiene i pesi in un file a parte: serve un file .onnx che li contenga.', 415);
    if (!file.sha256) fail('Hugging Face non dà un’impronta per questo file: non si può verificare.', 415);
    const key = `hf:${info.id}/${file.path}`;
    const local = `hf--${`${info.id}--${file.path}`.replace(/[^\w.-]+/g, '--')}`.slice(0, 180).replace(/\.onnx$/i, '') + '.onnx';
    const models = this.userModels();
    models[key] = {
      file: local, url: this.hub.fileUrl(info.id, info.revision, file.path), sha256: file.sha256, bytes: file.size,
      label: `${info.id.split('/').pop()} · ${file.name} (${Math.round(file.size / 1048576)} MB)`, licence: info.license || 'non dichiarata',
      repo: info.id, path: file.path, mean: IMAGENET_MEAN, std: IMAGENET_STD, memory: '8g', ready: false, error: null, addedAt: now()
    };
    this.saveUserModels(models);
    if (this.warm && this.warm.state === 'running') fail('Un download è già in corso: aspetta che finisca.', 409);
    const warm = { state: 'running', phase: 'starting', model: key, startedAt: now(), finishedAt: null, error: null };
    this.warm = warm;
    (async () => {
      const settle = (change) => { const all = this.userModels(); if (all[key]) { Object.assign(all[key], change); this.saveUserModels(all); } };
      try {
        const result = await this.ml.warmModels({ models: [models[key]], baseImages: this.sandbox?.baseImages, onPhase: phase => { warm.phase = phase; } });
        if (!result.ok) throw new Error(result.error || 'Download non riuscito.');
        warm.phase = 'describe';
        const said = await this.ml.describeModel(local, { baseImages: this.sandbox?.baseImages });
        if (!said.ok) throw new Error(`Il modello non si carica: ${said.error}`);
        const input = said.inputs?.[0]?.shape || [];
        // Usable by the function as it is: one picture in (batch, three channels, height, width), a matte out.
        const takesPicture = said.inputs.length === 1 && input.length === 4 && input[1] === 3;
        const fixed = takesPicture && input[2] > 0 && input[3] > 0;
        if (takesPicture && fixed && input[2] !== input[3]) throw new Error(`Il modello vuole immagini ${input[3]}×${input[2]}: sono gestiti solo ingressi quadrati.`);
        if (!takesPicture) throw new Error(`Non è un modello che prende una sola immagine: i suoi ingressi sono ${said.inputs.map(i => `${i.name} ${JSON.stringify(i.shape)}`).join(', ')}.`);
        settle({ ready: true, error: null, inputs: said.inputs, outputs: said.outputs, ...(fixed ? {} : { size: 1024 }) });
        warm.state = 'done';
      } catch (error) {
        settle({ ready: false, error: error.message });
        warm.state = 'failed'; warm.error = error.message;
      } finally { warm.finishedAt = now(); warm.phase = null; }
    })();
    return this.userModelsStatus();
  }

  /** What only the user knows of a model: the normalisation, and the size for one that takes any. */
  setUserModel(key, input = {}) {
    const models = this.userModels();
    const model = models[key];
    if (!model) fail('Modello non trovato.', 404);
    const triple = (value, label, positive) => {
      if (!Array.isArray(value) || value.length !== 3 || !value.every(v => Number.isFinite(v) && v >= (positive ? 0.0001 : 0) && v <= 255)) fail(`${label}: tre numeri${positive ? ' maggiori di zero' : ''}.`);
      return value.map(Number);
    };
    if (input.mean !== undefined) model.mean = triple(input.mean, 'Media', false);
    if (input.std !== undefined) model.std = triple(input.std, 'Deviazione', true);
    if (input.size !== undefined) {
      if (model.size === undefined) fail('Questo modello dichiara la sua dimensione: non si imposta.');
      if (!Number.isInteger(input.size) || input.size < 32 || input.size > 2048) fail('Lato: un intero fra 32 e 2048.');
      model.size = input.size;
    }
    this.saveUserModels(models);
    return this.userModelsStatus();
  }

  async removeUserModel(key) {
    const models = this.userModels();
    const model = models[key];
    if (!model) fail('Modello non trovato.', 404);
    if (this.warm && this.warm.state === 'running' && this.warm.model === key) fail('Il download di questo modello è in corso.', 409);
    delete models[key];
    this.saveUserModels(models);
    await this.ml.removeModelFiles([model.file]).catch(() => {});
    return this.userModelsStatus();
  }

  userModelsStatus() {
    const warm = this.warm ? { state: this.warm.state, phase: this.warm.phase, model: this.warm.model, error: this.warm.error || null } : null;
    return { models: this.userModels(), warm };
  }

  project(id) {
    const project = this.store().project(id);
    if (!projectEnvs(project).includes('photo')) fail('Non è un progetto di foto.', 400);
    return project;
  }

  /**
   * Where the project's files of this kind are, on this computer: the project's
   * own folder, or — for a project that is in a pod — the folder of its
   * artifacts, kept here (projects.js, `artifactsDir`). The editor runs at this
   * computer either way, and works on files of this computer.
   */
  folderOf(project) {
    if (project.kind !== 'local') return this.projects.artifactsDir(project);
    if (!isDirectory(project.path)) fail(`La cartella non è più disponibile: ${project.path}`, 410);
    return project.path;
  }

  readManifest(project) {
    const file = path.join(this.folderOf(project), MANIFEST);
    if (!fs.existsSync(file)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { version: 1, ...data, settings: { model: ml.DEFAULT_MODEL, objectModel: ml.DEFAULT_OBJECT_MODEL, refine: false, ...(data.settings || {}) } };
    } catch { fail(`Il file ${MANIFEST} non si legge.`, 500); }
  }

  writeManifest(project, manifest) {
    manifest.updatedAt = now();
    fs.writeFileSync(path.join(this.folderOf(project), MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return manifest;
  }

  async record(project, message, source = 'user', tool = null) {
    try { return await this.projects.recordArtifacts(project, { message, source, tool }); }
    catch (error) { return { ready: false, error: error.message }; }
  }

  /** A side of the canvas, as the form sends it: a whole number of pixels within what the editor takes. */
  side(value, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < MIN_SIDE || n > MAX_SIDE) fail(`${label}: un numero intero di pixel fra ${MIN_SIDE} e ${MAX_SIDE}.`);
    return n;
  }

  /**
   * The base image of a new project, brought into its folder: a file of this
   * computer the user picked. One already inside the folder is used where it is.
   */
  bringBase(project, value) {
    const source = path.resolve(String(value));
    if (!path.isAbsolute(String(value)) || !fs.existsSync(source) || !fs.statSync(source).isFile()) fail('L’immagine di base non esiste.', 404);
    const ext = path.extname(source).toLowerCase();
    if (!IMAGE_EXTS.has(ext) && !DOCUMENT_EXTS.has(ext)) fail('La base deve essere una foto o un documento (.png, .jpg, .webp, .tif, .psd, .pcraft…).', 415);
    if (fs.statSync(source).size > MAX_WRITE_BYTES) fail('Immagine di base troppo grande.', 413);
    const folder = fs.realpathSync(this.folderOf(project));
    const real = fs.realpathSync(source);
    if (real.startsWith(folder + path.sep)) return path.relative(folder, real).split(path.sep).join('/');
    let name = path.basename(source);
    for (let n = 2; fs.existsSync(path.join(folder, name)); n++) name = `${path.basename(source, path.extname(source))}-${n}${path.extname(source)}`;
    fs.copyFileSync(source, path.join(folder, name));
    return name;
  }

  /**
   * The folder becomes a photo project: the manifest with the canvas it was
   * asked for (empty at a size, or from a base image), the scratch folder
   * kept out of the record, a first step. The canvas itself is made by the
   * page, in the editor, the first time the project is opened.
   */
  async init(project, input = {}) {
    const folder = this.folderOf(project);
    const existing = this.readManifest(project);
    if (existing) return existing;
    // With a base and no size the canvas is the base's own; an empty canvas always has one.
    // The size is checked before the base is brought in: a refused request leaves nothing in the folder.
    const sized = input.width !== undefined || input.height !== undefined || !input.base;
    const size = sized ? { width: this.side(input.width ?? DEFAULT_SIZE.width, 'Larghezza'), height: this.side(input.height ?? DEFAULT_SIZE.height, 'Altezza') } : { width: null, height: null };
    const base = input.base ? this.bringBase(project, input.base) : null;
    const stem = String(project.name || '').replace(/[^\p{L}\p{N} ._-]+/gu, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 60) || 'documento';
    const manifest = {
      version: 1, createdAt: now(),
      settings: { model: ml.MODELS[input.model] && ml.MODELS[input.model].use !== 'object' ? input.model : ml.DEFAULT_MODEL, objectModel: ml.DEFAULT_OBJECT_MODEL, refine: false },
      document: `${stem}${DOCUMENT_EXT}`,
      setup: { base, ...size, background: BACKGROUNDS.includes(input.background) ? input.background : 'white' }
    };
    this.writeManifest(project, manifest);
    fs.mkdirSync(path.join(folder, SCRATCH), { recursive: true });
    // Scratch of ours is not the user's photos: the record leaves it out.
    // (For a pod's project the record of the artifacts is started here, so that there is where to say it.)
    if (project.kind !== 'local') await this.record(project, 'Artefatti del progetto', 'user');
    const exclude = path.join(folder, '.git', 'info', 'exclude');
    try {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      if (!current.split(/\r?\n/).includes(`/${SCRATCH}/`)) fs.appendFileSync(exclude, `${current.endsWith('\n') || !current ? '' : '\n'}/${SCRATCH}/\n`);
    } catch {}
    await this.record(project, 'Nuovo progetto di foto', 'user');
    return manifest;
  }

  /** A path inside the folder, as the page or the model names it: relative, forward slashes, never outside. */
  locate(project, value) {
    if (typeof value !== 'string' || !value.trim()) fail('Percorso mancante.');
    const raw = value.trim().replace(/\\/g, '/');
    if (raw.length > 1024) fail('Percorso troppo lungo.');
    if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('~')) fail('Usa un percorso relativo alla cartella.');
    const parts = [];
    for (const part of raw.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') fail('Il percorso esce dalla cartella.');
      parts.push(part);
    }
    if (!parts.length) fail('Percorso mancante.');
    if (parts[0] === '.git') fail('Lo storico della cartella non si tocca.', 403);
    const root = fs.realpathSync(this.folderOf(project));
    const full = path.resolve(root, ...parts);
    let probe = full;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    let real;
    try { real = fs.realpathSync(probe); } catch { real = probe; }
    if (real !== root && !real.startsWith(root + path.sep)) fail('Il percorso esce dalla cartella.', 403);
    return { relative: parts.join('/'), full };
  }

  /** A photo or a document of the folder, as bytes: what the page hands to photocraft to open. */
  filePath(id, value) {
    const project = this.project(id);
    const { full, relative } = this.locate(project, value);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) fail('File non trovato.', 404);
    const ext = path.extname(full).toLowerCase();
    if (!IMAGE_EXTS.has(ext) && !DOCUMENT_EXTS.has(ext)) fail('Non è una foto né un documento.', 415);
    return { full, relative, mime: MIME[ext] || 'application/octet-stream' };
  }

  /**
   * What photocraft saved, written into the folder: File › Save in the app
   * and the model's photo_save both end here. Scratch files (the input of a
   * function) are written and not recorded; everything else is a step.
   */
  async writeFile(id, value, bytes, { source = 'user', tool = null } = {}) {
    const project = this.project(id);
    const { full, relative } = this.locate(project, value);
    if (!Buffer.isBuffer(bytes) || !bytes.length) fail('Contenuto mancante.');
    if (bytes.length > MAX_WRITE_BYTES) fail('File troppo grande.', 413);
    const scratch = relative.startsWith(`${SCRATCH}/`);
    const ext = path.extname(full).toLowerCase();
    if (!scratch && !IMAGE_EXTS.has(ext) && !DOCUMENT_EXTS.has(ext)) fail('Estensione non ammessa: una foto o un documento di photocraft.', 415);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
    const git = scratch ? null : await this.record(project, `salva ${relative}`, source, tool);
    return { path: relative, bytes: bytes.length, git };
  }

  /** What the folder holds: photos and documents at its root and one level down, newest first, with sizes read from the headers. */
  listFiles(project, { limit = MAX_LISTED } = {}) {
    const folder = this.folderOf(project);
    const out = [];
    const walk = (dir, prefix, depth) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (depth < 1) walk(full, relative, depth + 1); continue; }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        const kind = IMAGE_EXTS.has(ext) ? 'image' : DOCUMENT_EXTS.has(ext) ? 'document' : null;
        if (!kind) continue;
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        const size = kind === 'image' ? imageSize(full) : null;
        out.push({ path: relative, name: entry.name, kind, bytes: stat.size, mtime: stat.mtime.toISOString(), width: size?.width ?? null, height: size?.height ?? null });
      }
    };
    walk(folder, '', 0);
    out.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : a.path.localeCompare(b.path)));
    return { files: out.slice(0, limit), total: out.length, truncated: out.length > limit };
  }

  permOf(project) {
    const fallback = this.store().getSetting('photo_perm');
    const modes = ['manual', 'semi', 'auto'];
    return modes.includes(project.perm_code) ? project.perm_code : modes.includes(fallback) ? fallback : 'auto';
  }

  overview(id) {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    if (!manifest) fail('Questa cartella non è ancora un progetto di foto.', 409);
    const listing = this.listFiles(project);
    return {
      id: project.id,
      project: { id: project.id, name: project.name, path: project.path },
      // The project's own document, and the canvas to make while it is not there yet.
      document: manifest.document || null,
      documentExists: Boolean(manifest.document) && fs.existsSync(path.join(this.folderOf(project), manifest.document)),
      setup: manifest.setup || null,
      perm: { text: this.permOf(project) },
      settings: manifest.settings,
      models: this.catalogue(),
      files: listing.files, total: listing.total, truncated: listing.truncated,
      job: this.jobStatus(id),
      functions: { included: Boolean(this.ml.prebuiltRembg()) },
      photocraft: this.photocraft ? this.photocraft.status() : { available: false }
    };
  }

  async setSettings(id, input = {}) {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    if (!manifest) fail('Questa cartella non è ancora un progetto di foto.', 409);
    if (input.model !== undefined) { const known = this.catalogue()[input.model]; if (!known || known.use === 'object') fail('Modello non valido.'); manifest.settings.model = input.model; }
    // Fitting a matte's edge to the photo at full size, after the model: the user's switch, off until they turn it on.
    if (input.refine !== undefined) manifest.settings.refine = input.refine === true;
    this.writeManifest(project, manifest);
    await this.record(project, 'impostazioni della cartella', 'user');
    return this.overview(id);
  }

  // --- the model's tools -------------------------------------------------------------

  /**
   * A tool, once the gate has let it through. What only reads the folder or
   * runs in the pod is done here; what acts on the app comes back as the
   * instruction for the page, already checked.
   */
  async run(id, name, input = {}) {
    const project = this.project(id);
    switch (name) {
      case 'photo_list': {
        const listing = this.listFiles(project, { limit: 200 });
        return { root: project.path, total: listing.total, files: listing.files.map(f => ({ path: f.path, kind: f.kind, bytes: f.bytes, width: f.width, height: f.height })) };
      }
      case 'photo_commands': {
        const filter = String(input.filter || '').trim().toLowerCase();
        if (!filter) fail('Indica una parola da cercare nei comandi (es. "blur", "levels", "crop").');
        // The app has the whole list; the cheat sheet answers when the page cannot ask it.
        return { page: { op: 'commands', filter, limit: MAX_COMMAND_HITS, fallback: CHEAT_SHEET.filter(c => c.id.toLowerCase().includes(filter)).slice(0, MAX_COMMAND_HITS) } };
      }
      case 'photo_inspect': return { page: { op: 'inspect' } };
      case 'photo_open': {
        const { relative } = this.filePath(id, input.path);
        return { page: { op: 'open', path: relative } };
      }
      case 'photo_run': {
        const command = String(input.command || '').trim();
        if (!/^[a-zA-Z][a-zA-Z0-9._-]{1,120}$/.test(command)) fail('Comando mancante o non valido.');
        if (/^file\./.test(command)) fail('I comandi file.* aprono finestre di dialogo: usa photo_open e photo_save.');
        return { page: { op: 'execute', command, params: input.params && typeof input.params === 'object' ? input.params : {} } };
      }
      case 'photo_batch': {
        const steps = Array.isArray(input.steps) ? input.steps : [];
        if (!steps.length) fail('Nessun passo.');
        if (steps.length > MAX_BATCH) fail(`Troppi passi: al massimo ${MAX_BATCH}.`);
        for (const step of steps) {
          const command = String(step?.command || '').trim();
          if (!/^[a-zA-Z][a-zA-Z0-9._-]{1,120}$/.test(command) || /^file\./.test(command)) fail(`Comando non valido nel batch: ${command || '(vuoto)'}.`);
        }
        return { page: { op: 'batch', steps: steps.map(step => ({ command: String(step.command).trim(), params: step.params && typeof step.params === 'object' ? step.params : {} })) } };
      }
      case 'photo_save': {
        const { relative, full } = this.locate(project, input.path);
        const ext = path.extname(full).toLowerCase();
        if (!IMAGE_EXTS.has(ext) && !DOCUMENT_EXTS.has(ext)) fail('Estensione non ammessa: .png, .jpg, .webp, .tif, .psd, .pcraft…', 415);
        if (fs.existsSync(full) && input.overwrite !== true) fail(`Il file "${relative}" esiste già: per sovrascriverlo serve overwrite.`, 409);
        return { page: { op: 'save', path: relative } };
      }
      case 'photo_screenshot': return { page: { op: 'screenshot' } };
      case 'photo_place': {
        const { relative } = this.filePath(id, input.path);
        const page = { op: 'place', path: relative };
        if (Array.isArray(input.center) && input.center.length === 2 && input.center.every(Number.isFinite)) page.center = input.center;
        if (Number.isFinite(input.scale) && input.scale > 0) page.scale = input.scale;
        if (input.fit === false) page.fit = false;
        return { page };
      }
      case 'photo_select_object': {
        // The object inside a rectangle of the open document: the one given, or the bounds of the selection the document has.
        const page = { op: 'selectObject', output: input.output === 'mask' ? 'mask' : 'selection', layer: Number.isInteger(input.layer) ? input.layer : null };
        if (input.box !== undefined) {
          if (!Array.isArray(input.box) || input.box.length !== 4 || !input.box.every(Number.isFinite) || input.box[2] <= 0 || input.box[3] <= 0) fail('box: [x, y, larghezza, altezza] in pixel del documento.');
          page.box = input.box.map(v => Math.round(v));
        }
        return { page };
      }
      case 'photo_remove_background': {
        // Without a file it is about what the editor has open: the page does it there, on a layer.
        if (input.path === undefined || input.path === null || input.path === '') {
          const output = input.output === 'selection' ? 'selection' : 'mask';
          return { page: { op: 'removeBackground', output, layer: Number.isInteger(input.layer) ? input.layer : null } };
        }
        const status = await this.removeBackground(id, input.path, 'agent');
        if (!status.ok) fail(status.error || 'Funzione non riuscita.', status.needsModel ? 409 : 502);
        return { output: status.output, ms: status.ms, width: status.width, height: status.height, model: status.model };
      }
      default: fail('Strumento non trovato.', 404);
    }
  }

  /** What a chat of the folder gets with every turn: the folder and the tools. The page adds what the app has open. */
  context(id) {
    const project = this.project(id);
    const listing = this.listFiles(project, { limit: MAX_IN_BLOCK });
    const lines = [
      BLOCK_TITLE,
      `Progetto di foto «${project.name}»: ${project.path}, ${listing.total} file (foto e documenti). Ogni percorso è relativo alla cartella del progetto. L'utente lavora in photocraft, l'editor nella scheda Foto dello Studio, che ha sotto gli occhi: ogni cosa che fai lì la vede subito.`,
      'Strumenti: photo_list (i file), photo_inspect (livelli con id, selezione, storico e dimensioni del documento aperto), photo_open (apre un file della cartella come documento), photo_place (inserisce un file della cartella come nuovo livello del documento aperto: è così che si mette un soggetto scontornato dentro un ambiente, o un ambiente sotto un soggetto), photo_commands (cerca fra i comandi del motore: fallo prima di tirare a indovinare nome e parametri), photo_run (un comando: ogni passo è annullabile con edit.undo), photo_batch (più comandi in fila), photo_remove_background (senza path: toglie lo sfondo al livello attivo del documento aperto, o a quello indicato, con una maschera di livello che si può ritoccare o togliere; con output "selection" lascia la selezione del soggetto invece della maschera. Se nel documento c\'è una selezione, il risultato resta dentro la selezione: è il modo di dire «solo questo» quando ci sono più soggetti. Con path: lavora su un file della cartella e scrive <nome>.senza-sfondo.png), photo_select_object (seleziona un oggetto preciso indicato da un riquadro, o dalla selezione che l\'utente ha tracciato attorno: per «solo questa cosa» fra tante), photo_save (salva il documento aperto in un file della cartella; sovrascrivere chiede sempre), photo_screenshot (il documento aperto com\'è adesso, che l\'utente vede in chat).',
      'Per comporre: photo_place restituisce l\'id del nuovo livello e i suoi bordi; poi layer.translate lo sposta, edit.transform lo ridimensiona o lo ruota, layer.moveTo e layer.arrange.* cambiano l\'ordine dei livelli, layer.setProps cambia opacità e fusione. Guarda il risultato con photo_screenshot prima di dire che è fatto.',
      'I comandi file.* aprono finestre di dialogo: usa photo_open, photo_place e photo_save. Le modifiche passano per i permessi del progetto e possono aspettare l\'ok dell\'utente: se un risultato dice rifiutato, non ripetere, spiega e chiedi. Se la richiesta non dice su quale livello o file lavorare e non si capisce dal documento, chiedilo all\'utente.',
      '',
      'Comandi più comuni (id | parametri):',
      ...CHEAT_SHEET.map(c => `${c.id} | ${c.params}`),
      '',
      `File (${listing.total}${listing.truncated ? ', elenco troncato' : ''}):`,
      ...listing.files.map(f => `${f.path} (${f.kind === 'image' ? `${f.width || '?'}×${f.height || '?'}, ` : ''}${Math.round(f.bytes / 1024)} KB)`)
    ];
    return { photo: true, system: lines.join('\n'), tools: toolSpecs() };
  }

  // --- the functions, as jobs ------------------------------------------------------------

  jobStatus(id) {
    const job = this.jobs.get(String(id));
    return job ? { state: job.state, phase: job.phase, path: job.path, model: job.model || null, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error || null, needsModel: Boolean(job.needsModel), output: job.output || null, ms: job.ms || null } : { state: 'idle' };
  }

  /**
   * The function run to the end. `value` is the photo: a file of the folder,
   * or, when the page sends what the editor has open, a scratch file with
   * `as` naming the document it stands for, so the result is named after it.
   */
  async removeBackground(id, value, source = 'user', { scratch = false, box = null } = {}) {
    const project = this.project(id);
    const manifest = this.readManifest(project) || { settings: { model: ml.DEFAULT_MODEL, objectModel: ml.DEFAULT_OBJECT_MODEL } };
    const { full, relative } = this.locate(project, value);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) fail(`Il file "${relative}" non esiste.`, 404);
    if (!IMAGE_EXTS.has(path.extname(full).toLowerCase())) fail('Non è una foto.', 415);
    const key = String(id);
    const running = this.jobs.get(key);
    if (running && running.state === 'running') fail('Una funzione è già in corso su questa cartella.', 409);
    // For the open document the result is scratch: the page puts it into the document, and nothing is added to the folder.
    const named = scratch ? this.locate(project, `${SCRATCH}/${SCRATCH_RESULT}`) : { relative, full };
    const outName = scratch ? SCRATCH_RESULT : `${path.basename(named.relative).replace(/\.[^.]+$/, '')}${RESULT_SUFFIX}`;
    const outDir = path.dirname(named.full);
    fs.mkdirSync(outDir, { recursive: true });
    // With a rectangle the model is the one that is told where the object is; without, the one that finds the subject.
    const modelKey = box ? (manifest.settings.objectModel || ml.DEFAULT_OBJECT_MODEL) : manifest.settings.model;
    const model = this.modelFor(modelKey);
    const job = { state: 'running', phase: 'starting', path: named.relative, model: modelKey, startedAt: now(), finishedAt: null, error: null, needsModel: false, output: null, ms: null };
    this.jobs.set(key, job);
    try {
      const result = await this.ml.removeBackground({
        file: full, model, box, outDir, outName, baseImages: this.sandbox?.baseImages,
        onPhase: phase => { job.phase = phase; }
      });
      if (result.ok) {
        job.output = path.posix.join(path.posix.dirname(named.relative), outName).replace(/^\.\//, '');
        job.ms = result.ms || null;
        // Recorded before it is called done: whoever waits for the job finds the step there.
        if (!scratch) await this.record(project, `toglie lo sfondo a ${named.relative}`, source, source === 'agent' ? 'photo_remove_background' : null);
        job.state = 'done';
        return { ok: true, output: job.output, ms: result.ms, width: result.width, height: result.height, model: result.model, bytes: result.bytes };
      }
      job.state = 'failed';
      job.error = result.error;
      job.needsModel = Boolean(result.needsModel);
      return { ok: false, error: result.error, needsModel: Boolean(result.needsModel) };
    } catch (error) {
      job.state = 'failed';
      job.error = error.message;
      return { ok: false, error: error.message };
    } finally {
      job.finishedAt = now();
      job.phase = null;
    }
  }

  /** The page's button: starts it and answers at once; the page polls the job. */
  startRemoveBackground(id, value, options = {}) {
    const project = this.project(id);
    this.locate(project, value);
    const running = this.jobs.get(String(id));
    if (running && running.state === 'running') return this.jobStatus(id);
    this.removeBackground(id, value, 'user', options).catch(() => {});
    return this.jobStatus(id);
  }

  async modelsStatus() {
    const status = await this.ml.cacheStatus(this.userModels()).catch(error => ({ engine: false, prebuilt: false, models: {}, error: error.message }));
    return { ...status, catalogue: this.catalogue(), warm: this.warm ? { state: this.warm.state, phase: this.warm.phase, model: this.warm.model, error: this.warm.error || null, startedAt: this.warm.startedAt, finishedAt: this.warm.finishedAt } : null };
  }

  startWarm(model = ml.DEFAULT_MODEL) {
    const known = this.catalogue()[model];
    if (!known) fail('Modello non valido.');
    if (this.warm && this.warm.state === 'running') return this.modelsStatus();
    const warm = { state: 'running', phase: 'starting', model, startedAt: now(), finishedAt: null, error: null };
    this.warm = warm;
    (async () => {
      try {
        const result = await this.ml.warmModels({ models: [ml.MODELS[model] ? model : known], baseImages: this.sandbox?.baseImages, onPhase: phase => { warm.phase = phase; } });
        if (result.ok) warm.state = 'done'; else { warm.state = 'failed'; warm.error = result.error; }
      } catch (error) { warm.state = 'failed'; warm.error = error.message; }
      finally { warm.finishedAt = now(); warm.phase = null; }
    })();
    return this.modelsStatus();
  }
}

/** What the model is told it can do on a folder of photos. */
const TOOLS = {
  photo_list: {
    description: 'Elenca le foto e i documenti della cartella, con dimensioni in pixel e byte.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  photo_commands: {
    description: 'Cerca fra i comandi del motore di photocraft: nome, menu e parametri. Usalo prima di photo_run per il nome e i parametri esatti.',
    parameters: { type: 'object', properties: { filter: { type: 'string', description: 'Parola da cercare, es. "blur", "levels", "crop", "layer".' } }, required: ['filter'] }
  },
  photo_inspect: {
    description: 'Il documento aperto nell\'editor: livelli con id e bordi, selezione, storico, dimensioni.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  photo_open: {
    description: 'Apre un file della cartella nell\'editor.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Percorso relativo alla cartella, es. "vacanze/IMG_1.jpg".' } }, required: ['path'] }
  },
  photo_run: {
    description: 'Esegue un comando del motore sul documento aperto, con i suoi parametri. Ogni comando è un passo dello storico dell\'editor (edit.undo lo annulla).',
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'Id del comando, es. "filter.blur.gaussianBlur".' }, params: { type: 'object', description: 'I parametri del comando.' } }, required: ['command'] }
  },
  photo_batch: {
    description: 'Più comandi del motore in fila sul documento aperto; si ferma al primo che fallisce.',
    parameters: { type: 'object', properties: { steps: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, params: { type: 'object' } }, required: ['command'] }, description: 'Fino a 64 passi.' } }, required: ['steps'] }
  },
  photo_save: {
    description: 'Salva il documento aperto in un file della cartella: il formato dall\'estensione (.png, .jpg, .psd, .pcraft, .webp, .tif). Un file che esiste già non si sovrascrive senza overwrite, che chiede sempre all\'utente.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Percorso relativo alla cartella.' }, overwrite: { type: 'boolean', description: 'Sovrascrivere un file esistente.' } }, required: ['path'] }
  },
  photo_screenshot: {
    description: 'Il documento aperto com\'è adesso, con tutti i livelli composti, mostrato all\'utente in chat: per vedere il risultato di quello che hai fatto.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  photo_place: {
    description: 'Inserisce un file della cartella (foto o documento) come nuovo livello del documento aperto, sopra il livello attivo: centrato e rimpicciolito per stare nella tela, se non dici altro. Restituisce l\'id del livello e i suoi bordi.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Il file, relativo alla cartella.' },
      center: { type: 'array', items: { type: 'number' }, description: 'Dove va il centro, [x, y] in pixel del documento.' },
      scale: { type: 'number', description: 'Scala in percento della dimensione originale.' },
      fit: { type: 'boolean', description: 'false per non rimpicciolire un file più grande della tela.' }
    }, required: ['path'] }
  },
  photo_select_object: {
    description: 'Seleziona un oggetto preciso del documento aperto con un modello di SynthOrg (Segment Anything, nel container), a cui si indica dove sta: un riquadro attorno all\'oggetto. Senza box usa i bordi della selezione che il documento ha già (quella che l\'utente ha tracciato attorno all\'oggetto). Il risultato è la selezione dell\'oggetto, oppure con output "mask" una maschera sul livello. Usalo quando l\'utente indica una cosa fra tante; per il soggetto principale usa photo_remove_background.',
    parameters: { type: 'object', properties: {
      box: { type: 'array', items: { type: 'number' }, description: 'Riquadro attorno all\'oggetto: [x, y, larghezza, altezza] in pixel del documento. Omesso: la selezione presente.' },
      layer: { type: 'integer', description: 'Id del livello da cui leggere i pixel e su cui mettere la maschera. Omesso: tutto il documento per la selezione, il livello attivo per la maschera.' },
      output: { type: 'string', enum: ['selection', 'mask'], description: 'Selezione (default) o maschera di livello.' }
    }, required: [] }
  },
  photo_remove_background: {
    description: 'Toglie lo sfondo con un modello di SynthOrg (U²-Net, nel container). Senza path: sul documento aperto, al livello attivo o a quello indicato, come maschera di livello (o come selezione con output "selection"); una selezione già presente limita il risultato al suo interno. Con path: su un file della cartella, scrive <nome>.senza-sfondo.png accanto all\'originale. Qualche secondo; il modello va scaricato una volta dall\'utente.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Un file della cartella. Omesso: il documento aperto nell\'editor.' },
      layer: { type: 'integer', description: 'Id del livello (da photo_inspect). Omesso: il livello attivo.' },
      output: { type: 'string', enum: ['mask', 'selection'], description: 'Sul documento aperto: maschera di livello (default) o selezione.' }
    }, required: [] }
  }
};

function toolSpecs() {
  return Object.entries(TOOLS).map(([name, spec]) => ({ type: 'function', function: { name, description: spec.description, parameters: spec.parameters } }));
}

module.exports = { PhotoManager, TOOLS, toolSpecs, imageSize, MANIFEST, SCRATCH, SCRATCH_RESULT, RESULT_SUFFIX, IMAGE_EXTS, DOCUMENT_EXTS, CHEAT_SHEET, BLOCK_TITLE, BACKGROUNDS, MAX_SIDE };
