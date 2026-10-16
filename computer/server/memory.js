'use strict';
// The memory of the app: what is the user's own — the database, and what is
// kept beside it (the artifacts of the projects, the typeset texts, the
// scratch of the photo functions) — in one folder, in one place the user
// chooses: beside the app, as it has always been, or on another disk, a NAS,
// a folder that is kept online.
//
// What only makes the app run — the models, the packages, the pods and their
// working folders — is not memory and stays in the data folder (paths.js).
//
// Where the memory is cannot be written in the database it points to: it is
// in a small file of the data folder (`memoria.json`). A folder the user
// picks is never used as it is: the memory goes in a folder of its own
// inside it, marked, so that nothing else of theirs is ever moved or removed
// with it.
//
// Moving it is done when the app starts, before anything is open: copied,
// checked file by file against the originals, and only then used; the
// originals are removed last. A copy that fails leaves everything where it
// was. A memory that is not where it should be (a disk not plugged in) is
// never replaced by an empty one: the service says so and does not start.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DATA_DIR } = require('./paths');

const POINTER = 'memoria.json';
const UNINSTALL_INFO = 'uninstall.json';
const MARK = '.synthorg-memoria';
const FOLDER = 'SynthOrg Memoria';
// What is memory, among what the data folder holds. A name that is not here stays where it is.
const ITEMS = [
  'synthorg.sqlite', 'synthorg.sqlite-wal', 'synthorg.sqlite-shm', 'synthorg.sqlite.enc', 'synthorg.vault.json',
  'artifacts', 'studio',
  // The files of the chats: their copy when the memory is not beside the app, or the vault's encrypted one (tidy.js).
  'chat-files', 'sandboxes.enc',
  // The code editor's own data: its settings and what it remembers of each folder (src-tauri, `editor_data_dir`).
  'editor',
  // The record of each pod's project, copied here step by step (projects.js, `copyToMemory`).
  'pod-projects'
];

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function readPointer(dataDir) {
  try {
    const kept = JSON.parse(fs.readFileSync(path.join(dataDir, POINTER), 'utf8'));
    return kept && typeof kept === 'object' ? kept : {};
  } catch { return {}; }
}

function writePointer(dataDir, pointer) {
  const file = path.join(dataDir, POINTER);
  const clean = Object.fromEntries(Object.entries(pointer).filter(([, value]) => value !== null && value !== undefined));
  if (!Object.keys(clean).length) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(dataDir, { recursive: true });
  // Whole or not at all: the file that says where the memory is must never be half written.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (child, parent) => { const rel = path.relative(path.resolve(parent), path.resolve(child)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

/** Every file under the memory's items of a folder: its place among them → its size. */
function filesOf(dir) {
  const out = new Map();
  const walk = (full, relative) => {
    let stat;
    try { stat = fs.statSync(full); } catch { return; }
    if (stat.isDirectory()) { for (const name of fs.readdirSync(full)) walk(path.join(full, name), `${relative}/${name}`); }
    else if (stat.isFile()) out.set(relative, stat.size);
  };
  for (const item of ITEMS) walk(path.join(dir, item), item);
  return out;
}

function hashOf(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    for (let read; (read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, read));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

/** Where the memory is: `home` when it is beside the app, `missing` when it should be elsewhere and that place is not there. */
function locate(dataDir = DATA_DIR) {
  const pointer = readPointer(dataDir);
  const wanted = typeof pointer.dir === 'string' && pointer.dir && !same(pointer.dir, dataDir) ? path.resolve(pointer.dir) : null;
  if (!wanted) return { dir: path.resolve(dataDir), home: true, missing: false };
  return { dir: wanted, home: false, missing: !fs.existsSync(path.join(wanted, MARK)) };
}

/** The folder of the memory, for what opens the database. Throws when it is not reachable. */
function memoryDir(dataDir = DATA_DIR) {
  const where = locate(dataDir);
  if (where.missing) fail(`La memoria di SynthOrg non è raggiungibile: ${where.dir}. Collega il disco o la cartella dove l'hai messa e riavvia.`, 503);
  return where.dir;
}

/** Windows: where the memory and the data are, for the uninstaller, which asks whether to remove them. */
function tellUninstaller(dataDir, dir) {
  tellRegistry([['DataDir', path.resolve(dataDir)], ['MemoryDir', path.resolve(dir)]], dataDir);
}

/**
 * Whether the projects in the pods are copied into the memory (projects.js): when they are, the disk of the pods
 * holds nothing that is not also there, and an uninstall that keeps the memory can remove it.
 */
function tellPodsCopied(copied, dataDir = DATA_DIR) {
  tellRegistry([['PodsCopied', copied ? '1' : '0']], dataDir);
}

/**
 * What the uninstaller needs to know, written where it reads it: the registry on Windows (nsis/hooks.nsh), a
 * small file of the data folder elsewhere (linux/synthorg-uninstall).
 */
function tellRegistry(values, dataDir = DATA_DIR) {
  if (process.env.SYNTHORG_NO_REGISTRY) return;
  if (process.platform !== 'win32') {
    const file = path.join(dataDir, UNINSTALL_INFO);
    let kept = {};
    try { kept = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
    const next = { ...kept, ...Object.fromEntries(values) };
    if (JSON.stringify(next) === JSON.stringify(kept)) return;
    // One value a line: the uninstaller is a shell script and reads it with sed.
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(next, null, 1) + '\n', 'utf8'); } catch { /* the uninstaller then takes the data folder as the memory */ }
    return;
  }
  try {
    for (const [name, value] of values) {
      execFileSync('reg.exe', ['add', 'HKCU\\Software\\SynthOrg', '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    }
  } catch { /* the uninstaller then removes only what is beside the app */ }
}

/**
 * Asks for the memory to be moved: into a folder of its own inside `picked`,
 * or back beside the app (`picked` null). Nothing moves now — the database is
 * open: it is done at the next start. Returns the state, with what is pending.
 */
function plan(picked, dataDir = DATA_DIR) {
  const now = locate(dataDir);
  if (now.missing) fail('La memoria non è raggiungibile: prima va ricollegata.', 409);
  let target;
  if (picked === null || picked === undefined || picked === '') target = path.resolve(dataDir);
  else {
    if (typeof picked !== 'string' || !path.isAbsolute(picked)) fail('Scegli una cartella con il suo percorso completo.');
    let stat;
    try { stat = fs.statSync(picked); } catch { fail('La cartella scelta non esiste.', 404); }
    if (!stat.isDirectory()) fail('Quella scelta non è una cartella.');
    // Chosen again where it already is (its own folder, or the one that holds it).
    target = path.basename(path.resolve(picked)) === FOLDER ? path.resolve(picked) : path.join(path.resolve(picked), FOLDER);
    if (inside(target, dataDir)) fail('Dentro la cartella dell’app la memoria c’è già: scegli un altro posto, oppure riportala accanto all’app.');
    if (inside(target, now.dir) && !same(target, now.dir)) fail('La cartella scelta è dentro la memoria di adesso.');
    try { fs.accessSync(picked, fs.constants.W_OK); } catch { fail('In quella cartella non si può scrivere.', 403); }
    if (!same(target, now.dir) && fs.existsSync(target) && fs.readdirSync(target).some(name => name !== MARK)) {
      fail(`In «${picked}» c'è già una cartella «${FOLDER}» con dentro qualcosa: scegline un'altra.`, 409);
    }
    // Room for it, where that can be asked.
    try {
      const free = fs.statfsSync(picked);
      const needed = [...filesOf(now.dir).values()].reduce((sum, size) => sum + size, 0);
      if (Number(free.bavail) * Number(free.bsize) < needed * 1.05) fail('Nella cartella scelta non c’è abbastanza spazio per la memoria.', 507);
    } catch (error) { if (error.status) throw error; }
  }
  const pointer = readPointer(dataDir);
  writePointer(dataDir, { dir: pointer.dir, moveTo: same(target, now.dir) ? null : target });
  return status(dataDir);
}

/** Takes back a move that was asked for and not done yet. */
function cancel(dataDir = DATA_DIR) {
  const pointer = readPointer(dataDir);
  writePointer(dataDir, { dir: pointer.dir });
  return status(dataDir);
}

/**
 * Done when the service starts, before the database is opened: a move that
 * was asked for is carried out. Returns where the memory is now, with `moved`
 * or the `error` that left it where it was.
 */
function settle(dataDir = DATA_DIR, { log = () => {} } = {}) {
  const pointer = readPointer(dataDir);
  const now = locate(dataDir);
  if (!pointer.moveTo || now.missing) { if (!now.missing) tellUninstaller(dataDir, now.dir); return { ...now }; }
  const target = path.resolve(pointer.moveTo);
  const home = same(target, dataDir);
  const made = [];
  let marked = false;
  try {
    log(`sposto la memoria da ${now.dir} a ${target}`);
    fs.mkdirSync(target, { recursive: true });
    if (!home && !fs.existsSync(path.join(target, MARK))) marked = true;
    if (!home) fs.writeFileSync(path.join(target, MARK), 'La memoria di SynthOrg. Non spostare né rinominare questa cartella a mano: si sposta dalle impostazioni dell’app.\n', 'utf8');
    const before = filesOf(now.dir);
    for (const item of ITEMS) {
      const from = path.join(now.dir, item);
      if (!fs.existsSync(from)) continue;
      if (fs.existsSync(path.join(target, item))) fail(`Nella destinazione c'è già «${item}».`, 409);
      made.push(item);
      fs.cpSync(from, path.join(target, item), { recursive: true, errorOnExist: true, force: false });
    }
    // Checked against the originals: every file there, as large, and saying the same.
    const after = filesOf(target);
    for (const [relative, size] of before) {
      if (after.get(relative) !== size) fail(`La copia di «${relative}» non è completa.`, 500);
      if (hashOf(path.join(now.dir, relative)) !== hashOf(path.join(target, relative))) fail(`La copia di «${relative}» non è uguale all'originale.`, 500);
    }
    if (after.size !== before.size) fail('Nella copia c’è qualcosa che nell’originale non c’è.', 500);
    // From here the memory is the copy.
    writePointer(dataDir, { dir: home ? null : target });
  } catch (error) {
    // Left where it was: what was copied so far is taken away again, and the reason kept for the settings to show.
    for (const item of made) { try { fs.rmSync(path.join(target, item), { recursive: true, force: true }); } catch {} }
    if (marked) { try { fs.rmSync(path.join(target, MARK), { force: true }); } catch {} }
    if (!home) { try { if (!fs.readdirSync(target).length) fs.rmdirSync(target); } catch {} }
    writePointer(dataDir, { dir: pointer.dir, error: `Spostamento in ${target} non riuscito: ${error.message}` });
    log(`memoria non spostata: ${error.message}`);
    return { ...now, error: error.message };
  }
  // The originals last, and never what makes the move fail: a file that cannot be removed is left, and said.
  let left = false;
  for (const item of ITEMS) { try { fs.rmSync(path.join(now.dir, item), { recursive: true, force: true }); } catch { left = true; } }
  if (!now.home) { try { if (!fs.readdirSync(now.dir).some(name => name !== MARK)) fs.rmSync(now.dir, { recursive: true, force: true }); } catch {} }
  if (left) log(`la memoria è in ${target}; nella cartella di prima è rimasto qualcosa che non si è potuto togliere: ${now.dir}`);
  tellUninstaller(dataDir, target);
  return { dir: target, home, missing: false, moved: true };
}

/** What the settings show: where the memory is, how much it weighs, what is pending, what went wrong last time. */
function status(dataDir = DATA_DIR) {
  const pointer = readPointer(dataDir);
  const now = locate(dataDir);
  const bytes = now.missing ? null : [...filesOf(now.dir).values()].reduce((sum, size) => sum + size, 0);
  return { dir: now.dir, home: now.home, missing: now.missing, bytes, moveTo: pointer.moveTo || null, error: pointer.error || null, folder: FOLDER };
}

module.exports = { locate, memoryDir, plan, cancel, settle, status, tellPodsCopied, ITEMS, MARK, FOLDER, POINTER };
