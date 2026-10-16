'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, sectionEnabled } = require('../server/database');
const { ProjectManager } = require('../server/projects');
const { CodePermissions } = require('../server/code-permissions');
const { PhotoManager, TOOLS, toolSpecs, imageSize, MANIFEST, SCRATCH, SCRATCH_RESULT, CHEAT_SHEET } = require('../server/photo');
const { Photocraft, installedBuild } = require('../server/photocraft');
const { MODELS, DEFAULT_MODEL, DEFAULT_OBJECT_MODEL, partsOf, prebuiltRembg, sourceStamp } = require('../server/photo-ml');
const { CHANGES, COPIES, PATCHES, changesFingerprint } = require('../scripts/build-photocraft');

function tempDir(t, prefix = 'synthorg-photo-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return fs.realpathSync(dir);
}

// A 2×3 PNG, a 4×5 JPEG, a 7×9 lossless WebP and a 1×1 GIF: the headers alone, which is all the listing reads.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000020000000308060000007f1d2b3c0000000049454e44ae426082', 'hex');
const JPEG = Buffer.concat([Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'), Buffer.from('ffc0000b080005000403012200', 'hex'), Buffer.from('ffd9', 'hex')]);
const WEBP = (() => { const b = Buffer.alloc(30); b.write('RIFF', 0); b.writeUInt32LE(22, 4); b.write('WEBP', 8); b.write('VP8L', 12); b.writeUInt32LE(10, 16); b[20] = 0x2f; b.writeUInt32LE((6) | ((8) << 14), 21); return b; })();
const GIF = Buffer.from('474946383961010001000000', 'hex');

const fakeSandbox = {
  baseImages: null,
  async ensureProjectContainer(options) { return { containerName: options.containerName, volume: options.containerName, state: 'created', exec: { bin: 'podman', args: [] } }; },
  async removeProjectContainer() { return { removed: true }; },
  async stopAllContainers() { return { success: true, count: 0 }; }
};

/** photocraft as the service knows it: the build the installation carries, nothing running. */
const fakePhotocraft = () => ({ build: () => ({ tag: 'v0.3.0', commit: 'abc' }), status: () => ({ available: true, installed: { tag: 'v0.3.0', commit: 'abc' }, latest: null }), async checkLatest() { return this.status(); } });

/** The function of ours, without a container: writes a PNG where the real one would. */
const fakeMl = {
  MODELS, DEFAULT_MODEL: 'u2net',
  prebuiltRembg: () => ({ binary: 'x', stamp: 'y' }),
  calls: [],
  async removeBackground({ file, model, box, outDir, outName, onPhase }) { this.calls.push({ model, box }); onPhase('run'); fs.writeFileSync(path.join(outDir, outName), PNG); return { ok: true, output: path.join(outDir, outName), bytes: PNG.length, model, ms: 42, width: 2, height: 3 }; },
  warmed: [],
  described: { ok: true, inputs: [{ name: 'input', shape: [1, 3, 1024, 1024] }], outputs: [{ name: 'output', shape: [1, 1, 1024, 1024] }] },
  async warmModels({ models }) { this.warmed.push(...models); return { ok: true, log: '' }; },
  async describeModel() { return this.described; },
  async removeModelFiles(files) { this.removedFiles = files; return { removed: files.length }; },
  async cacheStatus(extra = {}) { return { engine: true, prebuilt: true, volume: true, models: { u2net: true, u2netp: false, ...Object.fromEntries(Object.keys(extra).map(key => [key, true])) } }; },
  async dropCache() { return { removed: true }; }
};

async function photoProject(t) {
  const store = new Store(':memory:');
  const folder = tempDir(t);
  fs.writeFileSync(path.join(folder, 'a.png'), PNG);
  fs.writeFileSync(path.join(folder, 'b.jpg'), JPEG);
  fs.mkdirSync(path.join(folder, 'sub'));
  fs.writeFileSync(path.join(folder, 'sub', 'c.webp'), WEBP);
  fs.writeFileSync(path.join(folder, 'note.txt'), 'no');
  const projects = new ProjectManager({ store: () => store, sandbox: fakeSandbox, dataDir: tempDir(t, 'synthorg-data-') });
  const permissions = new CodePermissions({ store: () => store });
  const photocraft = fakePhotocraft();
  const manager = new PhotoManager({ store: () => store, projects, permissions, sandbox: fakeSandbox, photocraft, mlImpl: fakeMl, dataDir: tempDir(t, 'synthorg-photo-data-') });
  const created = await projects.create({ kind: 'local', path: folder, name: 'Vacanze', section: 'photo' });
  const opened = await projects.open(created.id);
  assert.equal(opened.git.ready, true, opened.git.error);
  await manager.init(store.project(created.id), {});
  t.after(() => store.close());
  return { store, folder, projects, permissions, photocraft, manager, id: created.id };
}

test('image sizes come from the headers alone: PNG, JPEG, WebP, GIF, BMP', t => {
  const dir = tempDir(t);
  const write = (name, bytes) => { fs.writeFileSync(path.join(dir, name), bytes); return path.join(dir, name); };
  assert.deepEqual(imageSize(write('a.png', PNG)), { width: 2, height: 3 });
  assert.deepEqual(imageSize(write('b.jpg', JPEG)), { width: 4, height: 5 });
  assert.deepEqual(imageSize(write('c.webp', WEBP)), { width: 7, height: 9 });
  assert.deepEqual(imageSize(write('d.gif', GIF)), { width: 1, height: 1 });
  const bmp = Buffer.alloc(30); bmp.write('BM', 0); bmp.writeInt32LE(640, 18); bmp.writeInt32LE(-480, 22);
  assert.deepEqual(imageSize(write('e.bmp', bmp)), { width: 640, height: 480 });
  assert.equal(imageSize(write('f.txt', Buffer.from('ciao'))), null);
});

test('the build of photocraft: the changes to upstream are text substitutions plus our shell, and the stamp names them', async t => {
  assert.ok(CHANGES.length >= 5);
  for (const change of CHANGES) {
    assert.ok(change.file && typeof change.from === 'string' && change.from.length && typeof change.to === 'string', change.file);
    assert.ok(!path.isAbsolute(change.file) && !change.file.includes('..'));
    assert.notEqual(change.from, change.to);
  }
  // Only the web shell and the editor's shell (its menus, its title bar) are touched: the engine is upstream's.
  assert.deepEqual([...new Set(CHANGES.map(c => c.file))].sort(), ['apps/photocraft-web/Cargo.toml', 'apps/photocraft-web/src/main.rs', 'apps/photocraft-web/src/web.rs', 'crates/ui-egui/src/lib.rs', 'crates/ui-egui/src/menus.rs', 'crates/ui-egui/src/panels.rs']);
  assert.deepEqual(COPIES.map(c => c.to), ['apps/photocraft-web/src/synthorg.rs', 'crates/ui-egui/src/synthorg.rs']);
  // SynthOrg's functions are commands of the editor: in its menus, beside the items they resemble.
  const menus = CHANGES.filter(c => c.file === 'crates/ui-egui/src/menus.rs').map(c => c.to).join('\n');
  for (const text of ['("synthorg.removeBackground", "Remove Background", &["Layer"], None)', '("synthorg.selectSubject", "Subject (Model)", &["Select"], None)', '("synthorg.selectSubject", "select.subject")', 'crate::synthorg::menu(app, id, &params)', 'crate::synthorg::is_enabled(app, id)']) assert.ok(menus.includes(text), text);
  const functions = fs.readFileSync(path.join(PATCHES, 'synthorg_ui.rs'), 'utf8');
  for (const name of ['"synthorg.layerImage"', '"synthorg.matte"', '"synthorg.place"', '"synthorg.status"', 'pub fn set_host', '"Remove Background"', '"Select Subject"']) assert.ok(functions.includes(name), name);
  for (const copy of COPIES) assert.ok(fs.existsSync(path.join(PATCHES, copy.from)));
  assert.ok(fs.existsSync(path.join(PATCHES, 'index.html')));
  const shell = fs.readFileSync(path.join(PATCHES, 'synthorg.rs'), 'utf8');
  for (const name of ['synthorgPhotocraft', 'synthorgHost', 'pub fn attach', 'pub fn write', 'pub fn tick', 'synthorg::set_host', '"command"']) assert.ok(shell.includes(name), name);
  assert.match(changesFingerprint(), /^[a-f0-9]{16}$/);
  assert.equal(changesFingerprint(), changesFingerprint());

  // What the service says of the build: none without its stamp (the build writes it last), the stamp's own words with it.
  const dir = tempDir(t, 'synthorg-pc-');
  assert.equal(installedBuild(dir), null);
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ tag: 'v9.9.9', commit: 'deadbeef', changes: 'x' }));
  assert.equal(installedBuild(dir).tag, 'v9.9.9');
  const settings = new Map();
  const store = () => ({ getSetting: key => settings.get(key) ?? null, setSetting: (key, value) => settings.set(key, value) });
  const photocraft = new Photocraft({ store, dir, fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v10.0.0', published_at: '2026-10-07T00:00:00Z', html_url: 'https://example.invalid/r' }) }) });
  assert.deepEqual(Object.keys(photocraft.status()).sort(), ['available', 'installed', 'latest']);
  assert.equal(photocraft.status().latest, null);
  assert.equal((await photocraft.checkLatest()).latest.tag, 'v10.0.0');
  assert.equal(photocraft.status().latest.tag, 'v10.0.0', 'resta scritto');
  // The build this machine carries, if any, is of the changes this source declares.
  const build = installedBuild();
  if (build) { assert.match(build.tag, /^v\d+\.\d+\.\d+/); assert.equal(build.changes, changesFingerprint()); }
  // The function of ours is stamped by its sources: a change to the Rust makes a prebuilt stale.
  assert.match(sourceStamp(), /^[a-f0-9]{16}$/);
  const prebuilt = prebuiltRembg();
  if (prebuilt) assert.equal(prebuilt.sources, sourceStamp());
});

test('the models: pinned by hash, each with what its file does not say, never shipped', () => {
  assert.ok(MODELS[DEFAULT_MODEL] && MODELS[DEFAULT_MODEL].use !== 'object');
  assert.equal(MODELS[DEFAULT_OBJECT_MODEL].use, 'object');
  for (const [key, model] of Object.entries(MODELS)) {
    assert.ok(model.label && model.licence && /^\d+g$/.test(model.memory), key);
    const parts = partsOf(model);
    assert.equal(parts.length, model.use === 'object' ? 2 : 1, key);
    for (const part of parts) {
      assert.match(part.sha256, /^[a-f0-9]{64}$/, key);
      assert.match(part.url, /^https:\/\/github\.com\/danielgatis\/rembg\/releases\/download\//, key);
      assert.ok(/^[\w.-]+\.onnx$/.test(part.file) && part.bytes > 1e6, key);
    }
    // The size of the input and the kind of output are read from the file by the program: only the normalisation is kept here.
    if (model.use !== 'object') { assert.equal(model.mean.length, 3, key); assert.equal(model.std.length, 3, key); assert.equal('sigmoid' in model, false, key); }
  }
  assert.equal(MODELS.briaRmbg2.size, 1024, 'il solo con ingresso di qualunque misura');
  assert.equal('size' in MODELS.birefnet, false);
});

test('a model from Hugging Face: searched with the ONNX filter, downloaded by hash, read from its file, the user’s to tune', async t => {
  const { HuggingFaceHub } = require('../server/hf-hub');
  // The Hub, played: one page of repositories, and a repository with a usable file, one with its weights outside, one of another kind.
  const asked = [];
  const hub = new HuggingFaceHub({ fetchImpl: async url => {
    asked.push(String(url));
    const body = String(url).includes('/api/models?')
      ? [{ id: 'chi/scontorno', author: 'chi', downloads: 12, likes: 3, gated: false, lastModified: '2026-01-01T00:00:00Z' }]
      : { id: 'chi/scontorno', sha: 'abc123', gated: false, cardData: { license: 'mit' }, siblings: [
        { rfilename: 'onnx/model.onnx', size: 50 * 1048576, lfs: { sha256: 'a'.repeat(64) } },
        { rfilename: 'onnx/big.onnx', size: 5, lfs: { sha256: 'b'.repeat(64) } }, { rfilename: 'onnx/big.onnx_data', size: 9e9 },
        { rfilename: 'README.md', size: 10 }, { rfilename: 'onnx/nohash.onnx', size: 7 }] };
    return { ok: true, status: 200, headers: { get: name => (name === 'link' ? '<https://huggingface.co/api/models?cursor=2>; rel="next"' : null) }, json: async () => body };
  } });
  const page = await hub.searchOnnx({ query: 'sfondo', sort: 'downloads' });
  assert.match(asked[0], /filter=onnx/); assert.match(asked[0], /pipeline_tag=image-segmentation/); assert.match(asked[0], /search=sfondo/);
  assert.deepEqual(page.repos.map(r => r.id), ['chi/scontorno']);
  assert.equal(page.next, 'https://huggingface.co/api/models?cursor=2');
  await assert.rejects(hub.searchOnnx({ cursor: 'https://altrove.example/x' }), /non valida/);
  const repo = await hub.repoOnnx('chi/scontorno');
  assert.deepEqual(repo.files.map(f => [f.path, f.external]), [['onnx/big.onnx', true], ['onnx/nohash.onnx', false], ['onnx/model.onnx', false]]);
  assert.equal(repo.license, 'mit'); assert.equal(repo.revision, 'abc123');
  await assert.rejects(hub.repoOnnx('../x'), /non valido/);

  const { store, manager, id } = await photoProject(t);
  manager.hub = hub;
  fakeMl.warmed.length = 0;
  const wait = async () => { for (let i = 0; i < 200 && manager.userModelsStatus().warm?.state === 'running'; i++) await new Promise(r => setTimeout(r, 10)); };
  // What cannot be used is refused before anything is downloaded.
  await assert.rejects(manager.addUserModel({ repo: 'chi/scontorno', path: 'onnx/big.onnx' }), /pesi in un file a parte/);
  await assert.rejects(manager.addUserModel({ repo: 'chi/scontorno', path: 'onnx/nohash.onnx' }), /impronta/);
  await assert.rejects(manager.addUserModel({ repo: 'chi/scontorno', path: 'manca.onnx' }), /non trovato/);
  assert.equal(fakeMl.warmed.length, 0);
  // A good one: downloaded at the repository's own revision with the Hub's hash, then read.
  const key = 'hf:chi/scontorno/onnx/model.onnx';
  assert.equal((await manager.addUserModel({ repo: 'chi/scontorno', path: 'onnx/model.onnx' })).warm.model, key);
  await wait();
  const added = manager.userModels()[key];
  assert.deepEqual(fakeMl.warmed.map(m => [m.file, m.sha256, m.url]), [['hf--chi--scontorno--onnx--model.onnx', 'a'.repeat(64), 'https://huggingface.co/chi/scontorno/resolve/abc123/onnx/model.onnx']]);
  assert.equal(added.ready, true); assert.equal(added.licence, 'mit'); assert.equal('size' in added, false, 'il lato viene dal file');
  assert.deepEqual(added.mean, [0.485, 0.456, 0.406]);
  assert.deepEqual(added.inputs[0].shape, [1, 3, 1024, 1024]);
  // It is in every project's list, can be chosen, and is what the function runs.
  assert.equal((await manager.overview(id)).models[key].label, added.label);
  assert.equal((await manager.setSettings(id, { model: key })).settings.model, key);
  await manager.run(id, 'photo_remove_background', { path: 'a.png' });
  assert.equal(fakeMl.calls.at(-1).model.file, 'hf--chi--scontorno--onnx--model.onnx');
  assert.equal((await manager.modelsStatus()).models[key], true);
  // What no file says is the user's: the normalisation. The size is not, when the file declares it.
  assert.deepEqual(manager.setUserModel(key, { mean: [0.5, 0.5, 0.5], std: [1, 1, 1] }).models[key].std, [1, 1, 1]);
  assert.throws(() => manager.setUserModel(key, { std: [0, 1, 1] }), /Deviazione/);
  assert.throws(() => manager.setUserModel(key, { mean: [1, 2] }), /Media/);
  assert.throws(() => manager.setUserModel(key, { size: 512 }), /dichiara la sua dimensione/);
  assert.throws(() => manager.setUserModel('hf:altro', { mean: [0, 0, 0] }), /non trovato/);
  // One that takes any size keeps a size of the user's; one that does not take a picture is kept out, with the reason.
  fakeMl.described = { ok: true, inputs: [{ name: 'pixel_values', shape: [1, 3, -1, -1] }], outputs: [] };
  store.setSetting('photo_onnx_models', '{}');
  await manager.addUserModel({ repo: 'chi/scontorno', path: 'onnx/model.onnx' }); await wait();
  assert.equal(manager.userModels()[key].size, 1024);
  assert.equal(manager.setUserModel(key, { size: 768 }).models[key].size, 768);
  assert.throws(() => manager.setUserModel(key, { size: 10 }), /Lato/);
  fakeMl.described = { ok: true, inputs: [{ name: 'image_embeddings', shape: [1, 256, 64, 64] }, { name: 'point_coords', shape: [1, -1, 2] }], outputs: [] };
  store.setSetting('photo_onnx_models', '{}');
  await manager.addUserModel({ repo: 'chi/scontorno', path: 'onnx/model.onnx' }); await wait();
  assert.equal(manager.userModels()[key].ready, false);
  assert.match(manager.userModels()[key].error, /non è un modello che prende una sola immagine/i);
  assert.equal(key in manager.catalogue(), false, 'uno non pronto non si può scegliere');
  // The project that had chosen it is told, not run on something else.
  await assert.rejects(manager.run(id, 'photo_remove_background', { path: 'a.png' }), /non c’è più/);
  // Removed: out of the list, its file out of the volume.
  assert.deepEqual(Object.keys((await manager.removeUserModel(key)).models), []);
  assert.deepEqual(fakeMl.removedFiles, ['hf--chi--scontorno--onnx--model.onnx']);
  fakeMl.described = { ok: true, inputs: [{ name: 'input', shape: [1, 3, 1024, 1024] }], outputs: [{ name: 'output', shape: [1, 1, 1024, 1024] }] };
});

test('a folder becomes a photo project: manifest, scratch kept out of the record, files listed with sizes', async t => {
  const { manager, folder, id, projects } = await photoProject(t);
  assert.ok(fs.existsSync(path.join(folder, MANIFEST)));
  assert.ok(fs.existsSync(path.join(folder, SCRATCH)));
  assert.ok(fs.readFileSync(path.join(folder, '.git', 'info', 'exclude'), 'utf8').includes(`/${SCRATCH}/`));
  const overview = await manager.overview(id);
  assert.equal(overview.id, id);
  assert.equal(overview.perm.text, 'auto');
  assert.equal(overview.settings.model, 'u2net');
  assert.deepEqual(overview.files.map(f => f.path).sort(), ['a.png', 'b.jpg', 'sub/c.webp']);
  const png = overview.files.find(f => f.path === 'a.png');
  assert.equal(png.width, 2); assert.equal(png.height, 3); assert.equal(png.kind, 'image');
  assert.equal(overview.functions.included, true);
  assert.equal(overview.photocraft.installed.tag, 'v0.3.0');
  // Made with nothing asked: an empty canvas of the default size, and a document named after the project, still to be made.
  assert.equal(overview.document, 'Vacanze.pcraft');
  assert.equal(overview.documentExists, false);
  assert.deepEqual(overview.setup, { base: null, width: 1920, height: 1080, background: 'white' });
  assert.equal((await projects.gitStatus(id)).last.message, 'Nuovo progetto di foto');
  fs.writeFileSync(path.join(folder, 'Vacanze.pcraft'), 'x');
  assert.equal((await manager.overview(id)).documentExists, true);
  // A second init changes nothing.
  assert.deepEqual(await manager.init(manager.project(id), {}), manager.readManifest(manager.project(id)));
  // Paths are confined.
  assert.throws(() => manager.locate(manager.project(id), '../x'), /esce dalla cartella/);
  assert.throws(() => manager.locate(manager.project(id), 'C:/x'), /relativo/);
  assert.throws(() => manager.locate(manager.project(id), '.git/config'), /storico/);
  assert.throws(() => manager.filePath(id, 'note.txt'), /foto né un documento/);
  assert.equal(manager.filePath(id, 'sub/c.webp').mime, 'image/webp');
});

test('a project is made with its canvas: empty at a size, or from an image copied into the folder', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const projects = new ProjectManager({ store: () => store, sandbox: fakeSandbox, dataDir: tempDir(t, 'synthorg-data-') });
  const manager = new PhotoManager({ store: () => store, projects, permissions: new CodePermissions({ store: () => store }), sandbox: fakeSandbox, photocraft: fakePhotocraft(), mlImpl: fakeMl, dataDir: tempDir(t, 'synthorg-photo-data-') });
  const make = async (name, input) => {
    const folder = tempDir(t);
    const created = await projects.create({ kind: 'local', path: folder, name, section: 'photo' });
    await projects.open(created.id);
    return { id: created.id, folder, manifest: await manager.init(store.project(created.id), input) };
  };
  // Empty, at a size, on a transparent background.
  const empty = await make('Locandina: estate/2026', { width: 1080, height: 1350, background: 'transparent' });
  assert.deepEqual(empty.manifest.setup, { base: null, width: 1080, height: 1350, background: 'transparent' });
  assert.equal(empty.manifest.document, 'Locandina_ estate_2026.pcraft', 'il nome del documento è quello del progetto, senza caratteri da percorso');
  // From an image elsewhere on this computer: copied in, and the canvas is the image's own.
  const elsewhere = tempDir(t);
  fs.writeFileSync(path.join(elsewhere, 'ritratto.jpg'), JPEG);
  const based = await make('Ritratto', { base: path.join(elsewhere, 'ritratto.jpg') });
  assert.deepEqual(based.manifest.setup, { base: 'ritratto.jpg', width: null, height: null, background: 'white' });
  assert.ok(fs.readFileSync(path.join(based.folder, 'ritratto.jpg')).equals(JPEG));
  assert.deepEqual((await manager.overview(based.id)).files.map(f => f.path), ['ritratto.jpg']);
  // From an image, on a canvas of another size.
  const sized = await make('Formato', { base: path.join(elsewhere, 'ritratto.jpg'), width: 3840, height: 2160, background: 'black' });
  assert.deepEqual(sized.manifest.setup, { base: 'ritratto.jpg', width: 3840, height: 2160, background: 'black' });
  // One already in the folder is used where it is; a name taken is not overwritten.
  const inside = tempDir(t);
  fs.mkdirSync(path.join(inside, 'foto'));
  fs.writeFileSync(path.join(inside, 'foto', 'a.png'), PNG);
  fs.writeFileSync(path.join(inside, 'ritratto.jpg'), 'già qui');
  const local = await projects.create({ kind: 'local', path: inside, name: 'Dentro', section: 'photo' });
  await projects.open(local.id);
  assert.equal(manager.bringBase(store.project(local.id), path.join(inside, 'foto', 'a.png')), 'foto/a.png');
  assert.equal(manager.bringBase(store.project(local.id), path.join(elsewhere, 'ritratto.jpg')), 'ritratto-2.jpg');
  assert.equal(fs.readFileSync(path.join(inside, 'ritratto.jpg'), 'utf8'), 'già qui');
  // What is refused: a size out of range or not whole, a base that is not there, not an image, not an absolute path.
  for (const [input, message] of [
    [{ width: 0, height: 100 }, /Larghezza/], [{ width: 100, height: 30001 }, /Altezza/], [{ width: 10.5, height: 100 }, /Larghezza/],
    [{ base: path.join(elsewhere, 'manca.jpg') }, /non esiste/], [{ base: 'ritratto.jpg' }, /non esiste/]
  ]) {
    const folder = tempDir(t);
    const created = await projects.create({ kind: 'local', path: folder, name: 'No', section: 'photo' });
    await projects.open(created.id);
    await assert.rejects(manager.init(store.project(created.id), input), message);
    assert.equal(fs.existsSync(path.join(folder, MANIFEST)), false, 'niente manifesto a metà');
  }
  fs.writeFileSync(path.join(elsewhere, 'note.txt'), 'x');
  assert.throws(() => manager.bringBase(store.project(local.id), path.join(elsewhere, 'note.txt')), /foto o un documento/);
});

test('what the editor saves lands in the folder as a step; scratch is written and not recorded', async t => {
  const { manager, id, projects, folder } = await photoProject(t);
  const before = (await projects.gitStatus(id)).commits;
  const saved = await manager.writeFile(id, 'out/ritocco.png', PNG);
  assert.deepEqual({ path: saved.path, bytes: saved.bytes }, { path: 'out/ritocco.png', bytes: PNG.length });
  assert.ok(fs.readFileSync(path.join(folder, 'out', 'ritocco.png')).equals(PNG));
  assert.equal((await projects.gitStatus(id)).commits, before + 1);
  let last = (await projects.history(id, { limit: 1 })).commits[0];
  assert.equal(last.source, 'user'); assert.equal(last.title, 'salva out/ritocco.png');
  await manager.writeFile(id, 'del-modello.jpg', JPEG, { source: 'agent', tool: 'photo_save' });
  last = (await projects.history(id, { limit: 1 })).commits[0];
  assert.equal(last.source, 'agent'); assert.equal(last.tool, 'photo_save');
  const scratch = await manager.writeFile(id, `${SCRATCH}/rembg-in.png`, PNG);
  assert.equal(scratch.git, null);
  assert.equal((await projects.gitStatus(id)).commits, before + 2);
  await assert.rejects(manager.writeFile(id, 'x.exe', PNG), /Estensione/);
  await assert.rejects(manager.writeFile(id, '../x.png', PNG), /esce/);
  await assert.rejects(manager.writeFile(id, '.git/x.png', PNG), /storico/);
  await assert.rejects(manager.writeFile(id, 'vuoto.png', Buffer.alloc(0)), /Contenuto/);
});

test('the model’s tools: the folder is read here, what acts on the editor comes back as an instruction for the page', async t => {
  const { manager, id, projects, folder } = await photoProject(t);
  assert.deepEqual(Object.keys(TOOLS).sort(), ['photo_batch', 'photo_commands', 'photo_inspect', 'photo_list', 'photo_open', 'photo_place', 'photo_remove_background', 'photo_run', 'photo_save', 'photo_screenshot', 'photo_select_object']);
  assert.equal(toolSpecs().length, 11);
  assert.ok(CHEAT_SHEET.length > 20 && CHEAT_SHEET.every(c => c.id && c.params));

  const list = await manager.run(id, 'photo_list', {});
  assert.equal(list.total, 3);
  const found = await manager.run(id, 'photo_commands', { filter: 'Levels' });
  assert.equal(found.page.op, 'commands'); assert.equal(found.page.filter, 'levels');
  assert.ok(found.page.fallback.some(c => c.id === 'image.adjustments.levels'), 'il bigino, se la pagina non può chiedere all’editor');
  await assert.rejects(manager.run(id, 'photo_commands', {}), /parola/);
  assert.deepEqual(await manager.run(id, 'photo_inspect', {}), { page: { op: 'inspect' } });
  assert.deepEqual(await manager.run(id, 'photo_screenshot', {}), { page: { op: 'screenshot' } });

  assert.deepEqual(await manager.run(id, 'photo_run', { command: 'filter.blur.gaussianBlur', params: { radius: 3 } }), { page: { op: 'execute', command: 'filter.blur.gaussianBlur', params: { radius: 3 } } });
  await assert.rejects(manager.run(id, 'photo_run', { command: 'file.save' }), /file\.\*/);
  await assert.rejects(manager.run(id, 'photo_run', { command: 'x y' }), /non valido/);
  const batch = await manager.run(id, 'photo_batch', { steps: [{ command: 'layer.new.layer' }, { command: 'edit.undo', params: 'no' }] });
  assert.deepEqual(batch.page, { op: 'batch', steps: [{ command: 'layer.new.layer', params: {} }, { command: 'edit.undo', params: {} }] });
  await assert.rejects(manager.run(id, 'photo_batch', { steps: [{ command: 'layer.new.layer' }, { command: 'file.open' }] }), /file\.open/);
  await assert.rejects(manager.run(id, 'photo_batch', { steps: [] }), /Nessun passo/);
  await assert.rejects(manager.run(id, 'photo_batch', { steps: Array.from({ length: 65 }, () => ({ command: 'edit.undo' })) }), /Troppi/);

  assert.deepEqual(await manager.run(id, 'photo_open', { path: 'sub\\c.webp' }), { page: { op: 'open', path: 'sub/c.webp' } });
  await assert.rejects(manager.run(id, 'photo_open', { path: 'missing.png' }), /non trovato/);
  await assert.rejects(manager.run(id, 'photo_open', { path: 'note.txt' }), /foto né un documento/);
  // A file of the folder as a new layer of the open document: how a cut-out goes into an environment.
  assert.deepEqual(await manager.run(id, 'photo_place', { path: 'a.png' }), { page: { op: 'place', path: 'a.png' } });
  assert.deepEqual(await manager.run(id, 'photo_place', { path: 'sub/c.webp', center: [10, 20], scale: 50, fit: false }), { page: { op: 'place', path: 'sub/c.webp', center: [10, 20], scale: 50, fit: false } });
  assert.deepEqual((await manager.run(id, 'photo_place', { path: 'a.png', center: ['x', 2], scale: -1 })).page, { op: 'place', path: 'a.png' });
  await assert.rejects(manager.run(id, 'photo_place', { path: 'missing.png' }), /non trovato/);
  await assert.rejects(manager.run(id, 'photo_place', { path: 'note.txt' }), /foto né un documento/);
  assert.deepEqual(await manager.run(id, 'photo_save', { path: 'out.png' }), { page: { op: 'save', path: 'out.png' } });
  await assert.rejects(manager.run(id, 'photo_save', { path: 'a.png' }), /esiste già/);
  assert.deepEqual(await manager.run(id, 'photo_save', { path: 'a.png', overwrite: true }), { page: { op: 'save', path: 'a.png' } });
  await assert.rejects(manager.run(id, 'photo_save', { path: 'out.txt' }), /Estensione/);

  // The function of ours, on what the editor has open: the page does it there, on a layer — a mask, or a selection.
  assert.deepEqual(await manager.run(id, 'photo_remove_background', {}), { page: { op: 'removeBackground', output: 'mask', layer: null } });
  assert.deepEqual(await manager.run(id, 'photo_remove_background', { layer: 7, output: 'selection' }), { page: { op: 'removeBackground', output: 'selection', layer: 7 } });
  // An object that is pointed at: by a rectangle the model gives, or by the selection the document has.
  assert.deepEqual(await manager.run(id, 'photo_select_object', {}), { page: { op: 'selectObject', output: 'selection', layer: null } });
  assert.deepEqual(await manager.run(id, 'photo_select_object', { box: [10.4, 20, 300, 200], output: 'mask', layer: 3 }), { page: { op: 'selectObject', output: 'mask', layer: 3, box: [10, 20, 300, 200] } });
  await assert.rejects(manager.run(id, 'photo_select_object', { box: [1, 2, 0, 5] }), /box/);
  await assert.rejects(manager.run(id, 'photo_select_object', { box: 'qui' }), /box/);
  // On a file of the folder it runs in the pod from here, and is recorded as the model's step.
  const result = await manager.run(id, 'photo_remove_background', { path: 'b.jpg' });
  assert.equal(result.output, 'b.senza-sfondo.png');
  assert.ok(fs.existsSync(path.join(folder, 'b.senza-sfondo.png')));
  const last = (await projects.history(id, { limit: 1 })).commits[0];
  assert.equal(last.source, 'agent');
  assert.equal(last.tool, 'photo_remove_background');
  assert.equal(manager.jobStatus(id).state, 'done');
  await assert.rejects(manager.run(id, 'photo_remove_background', { path: 'note.txt' }), /Non è una foto/);
  await assert.rejects(manager.run(id, 'nope', {}), /non trovato/);

  // For the open document the page sends the layer's pixels as scratch and takes the matte back as scratch: nothing is added to the folder or to its record.
  await manager.writeFile(id, `${SCRATCH}/rembg-in.png`, PNG);
  const steps = (await projects.gitStatus(id)).commits;
  const fromEditor = await manager.removeBackground(id, `${SCRATCH}/rembg-in.png`, 'user', { scratch: true });
  assert.equal(fromEditor.output, `${SCRATCH}/${SCRATCH_RESULT}`);
  assert.ok(fs.existsSync(path.join(folder, SCRATCH, SCRATCH_RESULT)));
  assert.equal((await projects.gitStatus(id)).commits, steps);
  assert.equal(manager.filePath(id, fromEditor.output).mime, 'image/png');
  // The subject is found by the folder's model; with a rectangle, by the model that is told where the object is.
  assert.deepEqual(fakeMl.calls.at(-1), { model: DEFAULT_MODEL, box: null });
  await manager.removeBackground(id, `${SCRATCH}/rembg-in.png`, 'user', { scratch: true, box: [1, 2, 30, 40] });
  assert.deepEqual(fakeMl.calls.at(-1), { model: DEFAULT_OBJECT_MODEL, box: [1, 2, 30, 40] });
  assert.equal(manager.jobStatus(id).model, DEFAULT_OBJECT_MODEL);
  // The settings: which model finds the subject (never the pointed one), and whether edges are fitted to the photo.
  assert.deepEqual((await manager.overview(id)).settings, { model: DEFAULT_MODEL, objectModel: DEFAULT_OBJECT_MODEL, refine: false });
  assert.equal((await manager.setSettings(id, { refine: true, model: 'birefnet' })).settings.refine, true);
  assert.equal((await manager.overview(id)).settings.model, 'birefnet');
  await assert.rejects(manager.setSettings(id, { model: DEFAULT_OBJECT_MODEL }), /non valido/);
  await assert.rejects(manager.setSettings(id, { model: 'nessuno' }), /non valido/);
  assert.ok(!(await manager.overview(id)).files.some(f => f.path.startsWith(SCRATCH)), 'gli appoggi non sono foto della cartella');

  // The context block: the folder, where the editor is, the cheat sheet, the files.
  const context = await manager.context(id);
  assert.equal(context.photo, true);
  assert.ok(context.system.startsWith('[FOTO]'));
  assert.match(context.system, /scheda Foto dello Studio/);
  assert.match(context.system, /filter\.blur\.gaussianBlur/);
  assert.match(context.system, /sub\/c\.webp/);
  assert.match(context.system, /photo_place/);
  assert.match(context.system, /resta dentro la selezione/);
  assert.match(context.system, /photo_select_object/);
  assert.equal(context.tools.length, 11);
});

test('the permissions: commands are one change per folder, saving is structure, overwriting always asks', async t => {
  const { permissions, store, id } = await photoProject(t);
  const project = store.project(id);
  const semi = { ...project, perm_code: 'semi' };
  const auto = { ...project, perm_code: 'auto' };
  assert.equal(permissions.evaluate(auto, 'code', { name: 'photo_list', input: {} }).reason, 'read');
  assert.equal(permissions.evaluate(auto, 'code', { name: 'photo_run', input: { command: 'edit.undo' } }).verdict, 'allow');
  const first = permissions.evaluate(semi, 'code', { name: 'photo_run', input: { command: 'edit.undo' } });
  assert.equal(first.verdict, 'ask'); assert.equal(first.key, 'modifica:photocraft'); assert.equal(first.remember, true);
  store.addApproval(id, 'code', first.key);
  assert.equal(permissions.evaluate(semi, 'code', { name: 'photo_batch', input: { steps: [] } }).verdict, 'allow', 'la stessa chiave copre i batch');
  assert.equal(permissions.evaluate(semi, 'code', { name: 'photo_save', input: { path: 'x.png' } }).reason, 'structure');
  assert.equal(permissions.evaluate(auto, 'code', { name: 'photo_save', input: { path: 'x.png', overwrite: true } }).reason, 'overwrite');
  assert.equal(permissions.evaluate(semi, 'code', { name: 'photo_remove_background', input: { path: 'a.png' } }).key, 'modifica:a.png');
  // On the open document it is a change in the editor like a command: the same remembered answer.
  assert.equal(permissions.evaluate(semi, 'code', { name: 'photo_remove_background', input: {} }).verdict, 'allow');
  assert.equal(permissions.evaluate({ ...project, perm_code: 'manual' }, 'code', { name: 'photo_remove_background', input: { output: 'selection' } }).key, 'modifica:photocraft');
  const place = permissions.evaluate(semi, 'code', { name: 'photo_place', input: { path: 'sub/c.webp' } });
  assert.equal(place.verdict, 'ask'); assert.equal(place.key, 'modifica:sub/c.webp');
  assert.equal(permissions.evaluate({ ...project, perm_code: 'manual' }, 'code', { name: 'photo_select_object', input: { box: [1, 2, 3, 4] } }).key, 'modifica:photocraft');
});

test('over HTTP: Foto is part of Studio — its switch, a project with its canvas, writes, the tools through the gate', async t => {
  const { createApp } = require('../server');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-http-'));
  const { server, closeAll } = createApp({ token: 'tok', dbPath: path.join(data, 'synthorg.sqlite'), sandbox: fakeSandbox, photocraft: fakePhotocraft(), photoMl: fakeMl });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  // The data folder goes once the service has let its database go.
  t.after(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await closeAll(); fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const call = async (route, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${route}`, { method, headers: { Authorization: 'Bearer tok', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, type, body: type.includes('json') ? await response.json() : await response.arrayBuffer() };
  };
  // A project, made the way the page makes one: the folder, opened (its record starts), then its canvas.
  const folder = tempDir(t);
  const elsewhere = tempDir(t);
  fs.writeFileSync(path.join(elsewhere, 'a.png'), PNG);
  fs.writeFileSync(path.join(folder, 'note.txt'), 'x');
  const project = (await call('/projects', 'POST', { kind: 'local', path: folder, name: 'Vacanze', section: 'photo' })).body;
  assert.equal(project.section, 'photo');
  await call(`/projects/${project.id}/open`, 'POST', {});
  assert.equal((await call(`/photo/${project.id}`)).status, 409, 'senza manifesto non è ancora un progetto di foto');
  assert.equal((await call(`/photo/${project.id}/init`, 'POST', { base: path.join(elsewhere, 'a.png'), width: 99999 })).status, 400);
  const made = await call(`/photo/${project.id}/init`, 'POST', { base: path.join(elsewhere, 'a.png') });
  assert.equal(made.status, 200);
  assert.equal(made.body.document, 'Vacanze.pcraft');
  assert.deepEqual(made.body.setup, { base: 'a.png', width: null, height: null, background: 'white' });
  assert.equal(made.body.photocraft.available, true);
  const overview = (await call(`/photo/${project.id}`)).body;
  assert.equal(overview.files.length, 1);
  assert.equal(overview.documentExists, false);
  // Bytes of a photo, and nothing else.
  const image = await call(`/photo/${project.id}/file?path=a.png`);
  assert.equal(image.status, 200); assert.equal(image.type, 'image/png'); assert.equal(image.body.byteLength, PNG.length);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/photo/${project.id}/file?path=a.png`)).headers.get('cache-control'), 'no-store', 'un file che cambia sotto lo stesso nome non si legge da una cache');
  assert.equal((await call(`/photo/${project.id}/file?path=note.txt`)).status, 415);
  assert.equal((await call(`/photo/${project.id}/file?path=../a.png`)).status, 400);
  // What the editor saved.
  const wrote = await call(`/photo/${project.id}/write`, 'POST', { path: 'salvata.png', content: PNG.toString('base64') });
  assert.equal(wrote.status, 200); assert.equal(wrote.body.bytes, PNG.length);
  assert.ok(fs.readFileSync(path.join(folder, 'salvata.png')).equals(PNG));
  assert.equal((await call(`/photo/${project.id}/write`, 'POST', { path: 'x.png' })).status, 400);
  assert.equal((await call(`/photo/${project.id}/write`, 'POST', { path: 'x.sh', content: 'eA==' })).status, 415);
  // The context and a tool, gated (auto by default for Foto): the instruction for the page comes back.
  assert.equal((await call(`/photo/${project.id}/context`)).body.tools.length, 11);
  assert.deepEqual((await call(`/photo/${project.id}/tools/photo_select_object`, 'POST', { box: [5, 6, 70, 80] })).body.page, { op: 'selectObject', output: 'selection', layer: null, box: [5, 6, 70, 80] });
  assert.deepEqual((await call(`/photo/${project.id}/tools/photo_place`, 'POST', { path: 'a.png' })).body.page, { op: 'place', path: 'a.png' });
  assert.deepEqual((await call(`/photo/${project.id}/tools/photo_remove_background`, 'POST', {})).body.page, { op: 'removeBackground', output: 'mask', layer: null });
  const ran = await call(`/photo/${project.id}/tools/photo_run`, 'POST', { command: 'edit.undo' });
  assert.equal(ran.status, 200); assert.deepEqual(ran.body.page, { op: 'execute', command: 'edit.undo', params: {} });
  assert.equal((await call(`/photo/${project.id}/tools/photo_save`, 'POST', { path: 'a.png' })).status, 409);
  const overwrite = await call(`/photo/${project.id}/tools/photo_save`, 'POST', { path: 'a.png', overwrite: true });
  assert.equal(overwrite.body.pending, true, 'sovrascrivere chiede anche in automatico');
  await call(`/projects/${project.id}`, 'PATCH', { permissions: { code: 'manual' } });
  const parked = await call(`/photo/${project.id}/tools/photo_run`, 'POST', { command: 'edit.undo' });
  assert.equal(parked.body.pending, true);
  assert.equal(parked.body.approval.summary.path, 'edit.undo');
  // The function from the page: a job the page follows. It is done once its step is recorded, which takes git a moment.
  const settled = async () => { for (let i = 0; i < 600 && (await call(`/photo/${project.id}/job`)).body.state === 'running'; i++) await new Promise(r => setTimeout(r, 50)); };
  const job = (await call(`/photo/${project.id}/functions/remove-background`, 'POST', { path: 'a.png' })).body;
  assert.ok(['running', 'done'].includes(job.state));
  await settled();
  assert.equal((await call(`/photo/${project.id}/job`)).body.output, 'a.senza-sfondo.png');
  assert.equal((await call(`/photo/${project.id}/file?path=a.senza-sfondo.png`)).status, 200);
  // The same on scratch, for the open document.
  await call(`/photo/${project.id}/write`, 'POST', { path: `${SCRATCH}/rembg-in.png`, content: PNG.toString('base64') });
  await call(`/photo/${project.id}/functions/remove-background`, 'POST', { path: `${SCRATCH}/rembg-in.png`, scratch: true });
  await settled();
  assert.equal((await call(`/photo/${project.id}/job`)).body.output, `${SCRATCH}/${SCRATCH_RESULT}`);
  assert.equal((await call(`/photo/${project.id}/file?path=${SCRATCH}/${SCRATCH_RESULT}`)).status, 200);
  // And with a rectangle: the pointed model's job.
  await call(`/photo/${project.id}/functions/remove-background`, 'POST', { path: `${SCRATCH}/rembg-in.png`, scratch: true, box: [0, 0, 2, 3] });
  await settled();
  assert.equal((await call(`/photo/${project.id}/job`)).body.model, DEFAULT_OBJECT_MODEL);
  assert.equal((await call(`/photo/${project.id}`, 'PATCH', { refine: true })).body.settings.refine, true);
  assert.deepEqual(Object.keys((await call('/photo/status')).body).sort(), ['available', 'installed', 'latest']);
  assert.equal((await call('/photo/models')).body.models.u2net, true);
  // The user's own models: the list answers, and a change to one that is not there is refused.
  assert.deepEqual((await call('/photo/onnx')).body, { models: {}, warm: (await call('/photo/onnx')).body.warm });
  assert.equal((await call('/photo/onnx/model', 'PATCH', { key: 'hf:x/y/z.onnx', mean: [0, 0, 0] })).status, 404);
  assert.equal((await call('/photo/onnx/repo?id=..%2Fx')).status, 400);
  // The routes of the app in a window are gone.
  assert.equal((await call(`/photo/${project.id}/start`, 'POST', {})).status, 404);
  assert.equal((await call(`/photo/${project.id}/runtime`)).status, 404);
  assert.equal((await call('/photo/current', 'POST', {})).status, 404, 'nessuna cartella fatta da sola: i progetti li crea l’utente');

  // The switch is Studio's: off, the state still answers; the rest and the folders do not.
  await call('/settings/sections', 'PUT', { value: '{"studio":false}' });
  assert.equal((await call('/photo/status')).status, 200);
  assert.equal((await call(`/photo/${project.id}`)).status, 403);
  assert.equal((await call(`/photo/${project.id}/file?path=a.png`)).status, 403);
  assert.equal((await call(`/projects/${project.id}/open`, 'POST', {})).status, 403);
  assert.equal((await call('/projects', 'POST', { kind: 'local', path: tempDir(t), name: 'Altro', section: 'photo' })).status, 403);
  await call('/settings/sections', 'PUT', { value: '' });
  assert.equal((await call(`/photo/${project.id}`)).status, 200);
  // The lists stay apart: photo folders are not Code projects nor texts.
  assert.deepEqual((await call('/projects')).body, []);
  assert.equal((await call('/projects?section=photo')).body.length, 1);
  assert.equal(sectionEnabled({ getSetting: () => null }, 'photo'), true);
  assert.equal(sectionEnabled({ getSetting: () => '{"studio":false}' }, 'photo'), false, 'Foto segue l’interruttore di Studio');
  assert.equal(sectionEnabled({ getSetting: () => '{"studio":false}' }, 'studio'), false);
  assert.equal(sectionEnabled({ getSetting: () => '{"photo":false}' }, 'photo'), true, 'Foto non ha un interruttore suo');
  assert.equal(sectionEnabled({ getSetting: () => '{"chat":false}' }, 'chat'), true);
  assert.equal(sectionEnabled({ getSetting: () => 'rotto' }, 'photo'), true);
});

test('the build of photocraft at a start: a newer release that does not build leaves the one built in use, and says so', async () => {
  const { main } = require('../scripts/build-photocraft');
  // The network, the compiler and the built copy, stood in for.
  const world = ({ stamp, latest, fails = [], fingerprint = 'now' }) => {
    const state = { stamp, built: [], warned: [] };
    const parts = {
      latest: async () => { if (latest instanceof Error) throw latest; return latest; },
      buildAt: async (tag, held = null) => {
        state.built.push(tag);
        if (fails.includes(tag)) throw new Error(`una modifica non si applica alla ${tag}\nseconda riga`);
        state.stamp = { tag, commit: 'c'.repeat(40), changes: fingerprint, ...(held ? { held } : {}) };
      },
      readStamp: () => state.stamp, writeStamp: next => { state.stamp = next; },
      fingerprint: () => fingerprint, built: true, pinned: false, force: false
    };
    return { state, parts };
  };
  const quiet = async run => { const warn = console.warn, log = console.log, said = []; console.warn = text => said.push(String(text)); console.log = () => {}; try { await run(); } finally { console.warn = warn; console.log = log; } return said.join('\n'); };
  const at = (tag, changes = 'now', extra = {}) => ({ tag, commit: 'c'.repeat(40), changes, ...extra });

  // Nothing new: nothing compiled, nothing said.
  let w = world({ stamp: at('v1'), latest: 'v1' });
  assert.equal(await quiet(() => main(w.parts)), '');
  assert.deepEqual(w.state.built, []);

  // A newer release that builds: taken.
  w = world({ stamp: at('v1'), latest: 'v2' });
  await quiet(() => main(w.parts));
  assert.deepEqual([w.state.built, w.state.stamp.tag, w.state.stamp.held], [['v2'], 'v2', undefined]);

  // A newer release that does not build: tried once, the built one kept, said with the release and the reason…
  w = world({ stamp: at('v1'), latest: 'v2', fails: ['v2'] });
  let said = await quiet(() => main(w.parts));
  assert.deepEqual(w.state.built, ['v2']);
  assert.equal(w.state.stamp.tag, 'v1');
  assert.deepEqual([w.state.stamp.held.latest, w.state.stamp.held.changes, w.state.stamp.held.reason], ['v2', 'now', 'una modifica non si applica alla v2']);
  assert.match(said, /resta alla v1/);
  assert.match(said, /uscita la v2/);
  assert.match(said, /non si applica alla v2/);
  // …and at the next start not tried again, but said again.
  w.state.built.length = 0;
  said = await quiet(() => main(w.parts));
  assert.deepEqual(w.state.built, []);
  assert.match(said, /resta alla v1/);
  // A release newer still is tried.
  w.parts.latest = async () => 'v3';
  await quiet(() => main(w.parts));
  assert.deepEqual([w.state.built, w.state.stamp.tag], [['v3'], 'v3']);

  // The changes were updated since it was held back: tried again.
  w = world({ stamp: at('v1', 'now', { held: { latest: 'v2', changes: 'before', reason: 'x' } }), latest: 'v2' });
  await quiet(() => main(w.parts));
  assert.deepEqual([w.state.built, w.state.stamp.tag], [['v2'], 'v2']);

  // The changes were edited and the newer release does not take them: the built release is built again with them.
  w = world({ stamp: at('v1', 'before'), latest: 'v2', fails: ['v2'] });
  said = await quiet(() => main(w.parts));
  assert.deepEqual(w.state.built, ['v2', 'v1']);
  assert.deepEqual([w.state.stamp.tag, w.state.stamp.changes, w.state.stamp.held.latest], ['v1', 'now', 'v2']);
  assert.match(said, /resta alla v1/);
  // Neither builds: that stops the start, with both reasons.
  w = world({ stamp: at('v1', 'before'), latest: 'v2', fails: ['v2', 'v1'] });
  await assert.rejects(quiet(() => main(w.parts)), /non si applica alla v2[\s\S]*nemmeno la v1/);

  // No answer about the newest release: the built one stays, and that is said; with nothing built it is an error.
  w = world({ stamp: at('v1'), latest: new Error('GitHub non risponde') });
  said = await quiet(() => main(w.parts));
  assert.deepEqual(w.state.built, []);
  assert.match(said, /Resto alla v1/);
  w = world({ stamp: null, latest: new Error('GitHub non risponde') });
  await assert.rejects(quiet(() => main(w.parts)), /GitHub non risponde/);

  // A tag asked for by name, or nothing built yet: a build that fails is an error, nothing is fallen back to.
  w = world({ stamp: at('v1'), latest: 'v2', fails: ['v2'] });
  w.parts.pinned = true;
  await assert.rejects(quiet(() => main(w.parts)), /non si applica alla v2/);
  w = world({ stamp: null, latest: 'v2', fails: ['v2'] });
  await assert.rejects(quiet(() => main(w.parts)), /non si applica alla v2/);
});

test('a pod’s project keeps its artifacts at this computer: worked on here, recorded apart, put into the pod only when asked', async t => {
  const { ProjectFiles } = require('../server/project-files');
  const { StudioManager } = require('../server/studio');
  const { spawnSync } = require('node:child_process');
  // The pod's volume, stood in for by a folder; its container, by the same script run in that folder with the node of here.
  const volume = tempDir(t, 'synthorg-pod-volume-');
  const data = tempDir(t, 'synthorg-data-');
  const ran = [];
  const podSandbox = {
    baseImages: null,
    async execInContainer({ argv, input = null }) {
      ran.push(argv[0]);
      const script = argv[2].replace(JSON.stringify('/workspace'), JSON.stringify(volume));
      const res = spawnSync(process.execPath, ['-e', script], { input: input ?? undefined });
      return { ok: res.status === 0, stdout: res.stdout.toString('utf8'), stderr: String(res.stderr), error: res.status === 0 ? null : `uscita ${res.status}` };
    }
  };
  const row = { id: 'pod-1', kind: 'podman', name: 'Nel pod', path: '/workspace', container_name: 'synthorg-code-nel-pod', section: 'code', envs: '["code","photo","writing"]', perm_code: null };
  const store = new Store(':memory:');
  t.after(() => store.close());
  const asStore = () => new Proxy(store, { get: (target, name) => name === 'project' ? () => row : typeof target[name] === 'function' ? target[name].bind(target) : target[name] });
  const projects = new ProjectManager({ store: asStore, sandbox: podSandbox, dataDir: data });
  // The project's own record is the pod's: here only whether a step of it was asked for.
  const podSteps = [];
  projects.checkpoint = async (project, step) => { podSteps.push(step.message); return { ready: true }; };
  const photo = new PhotoManager({ store: asStore, projects, sandbox: podSandbox, photocraft: fakePhotocraft(), mlImpl: fakeMl, dataDir: data });
  const studio = new StudioManager({ store: asStore, projects, sandbox: podSandbox, dataDir: tempDir(t, 'synthorg-build-') });
  const files = new ProjectFiles({ store: asStore, sandbox: podSandbox, projects });
  const dir = projects.artifactsDir(row);
  assert.ok(dir.startsWith(data) && !dir.includes('workspace'));
  const steps = () => spawnSync('git', ['-C', dir, 'log', '--format=%s'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);

  // The photos: the manifest, what the editor saves and what a function makes are all in that folder, steps of its record.
  await photo.init(photo.project('pod-1'), { width: 800, height: 600 });
  await photo.writeFile('pod-1', 'ritratto.pcraft', PNG);
  await photo.writeFile('pod-1', 'ritratto.png', PNG);
  assert.ok(fs.existsSync(path.join(dir, 'ritratto.pcraft')));
  assert.equal(photo.filePath('pod-1', 'ritratto.png').mime, 'image/png');
  assert.equal((await photo.removeBackground('pod-1', 'ritratto.png', 'user')).output, 'ritratto.senza-sfondo.png');
  // The text: its manifest and its chapters are there too.
  studio.ensureTables();
  await studio.init(studio.project('pod-1'), { title: 'La casa' });
  const chapterId = studio.overview('pod-1').chapters[0].id;
  await studio.saveDraft('pod-1', chapterId, { draft: 'Era una notte.' });
  await studio.exportDocument('pod-1', { what: 'md' });
  assert.ok(steps().includes('salva ritratto.pcraft') && steps().some(line => line.startsWith('scrive ')), steps().join(' | '));
  // None of it went into the pod, nor into the pod's record.
  assert.deepEqual(fs.readdirSync(volume), []);
  assert.deepEqual([podSteps, ran], [[], []]);

  // Listed: what is worked on (raw) and what is finished, the chapter by its title; the manifests and the scratch are not artifacts.
  const listed = await files.artifacts('pod-1');
  assert.equal(listed.apart, true);
  const byPath = Object.fromEntries(listed.files.map(f => [f.path, `${f.stage}/${f.kind}/${f.name}`]));
  assert.deepEqual(byPath, {
    'ritratto.pcraft': 'raw/document/ritratto.pcraft',
    'ritratto.png': 'finished/image/ritratto.png',
    'ritratto.senza-sfondo.png': 'finished/image/ritratto.senza-sfondo.png',
    [`capitoli/${chapterId}.json`]: 'raw/text/Capitolo 1',
    'esportazioni/La casa.md': 'finished/export/La casa.md'
  });

  // Put into the pod where the user says: a copy, a step of the pod's record; the artifact stays.
  const placed = await files.changeArtifact('pod-1', { action: 'place', path: 'ritratto.png', to: 'public/img/ritratto.png' });
  assert.equal(placed.to, 'public/img/ritratto.png');
  assert.ok(fs.readFileSync(path.join(volume, 'public', 'img', 'ritratto.png')).equals(PNG));
  assert.ok(fs.existsSync(path.join(dir, 'ritratto.png')));
  assert.deepEqual(podSteps, ['porta public/img/ritratto.png dagli artefatti']);
  await assert.rejects(() => files.changeArtifact('pod-1', { action: 'place', path: 'ritratto.png', to: 'public/img/ritratto.png' }), /Esiste già/);
  await assert.rejects(() => files.changeArtifact('pod-1', { action: 'place', path: 'ritratto.png', to: '../fuori.png' }), /esce dal progetto/);

  // Another name, a copy, a removal: among the artifacts, steps of their record.
  await files.changeArtifact('pod-1', { action: 'rename', path: 'ritratto.png', to: 'finiti/ritratto.png' });
  await files.changeArtifact('pod-1', { action: 'copy', path: 'ritratto.pcraft', to: 'ritratto-2.pcraft' });
  await files.changeArtifact('pod-1', { action: 'remove', path: 'ritratto.senza-sfondo.png' });
  assert.deepEqual((await files.artifacts('pod-1')).files.map(f => f.path).sort(), [`capitoli/${chapterId}.json`, 'esportazioni/La casa.md', 'finiti/ritratto.png', 'ritratto-2.pcraft', 'ritratto.pcraft']);
  assert.ok(steps().includes('sposta ritratto.png in finiti/ritratto.png'));
  await assert.rejects(() => files.changeArtifact('pod-1', { action: 'copy', path: 'ritratto.pcraft', to: 'ritratto-2.pcraft' }), /Esiste già/);
  await assert.rejects(() => files.changeArtifact('pod-1', { action: 'remove', path: '.git/config' }), /storico|artefatto/);
  await assert.rejects(() => files.changeArtifact('pod-1', { action: 'remove', path: '.synthorg/x.png' }), /artefatto/);

  // In a folder project the artifacts are among its files: listed from there, and changed as files.
  const folder = tempDir(t);
  fs.writeFileSync(path.join(folder, 'a.png'), PNG);
  fs.writeFileSync(path.join(folder, 'main.js'), '1');
  fs.mkdirSync(path.join(folder, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'node_modules', 'x', 'logo.png'), PNG);
  const local = { id: 'loc-1', kind: 'local', name: 'In cartella', path: folder, section: 'code', envs: '["code","photo"]' };
  const localFiles = new ProjectFiles({ store: () => ({ project: () => local }), sandbox: podSandbox, projects });
  assert.deepEqual(await localFiles.artifacts('loc-1').then(r => [r.apart, r.files.map(f => f.path)]), [false, ['a.png']]);
  await assert.rejects(() => localFiles.changeArtifact('loc-1', { action: 'remove', path: 'a.png' }), /file del progetto/);
});

test('what the chats of a project make becomes an artifact of the project, once', async t => {
  const { ProjectFiles } = require('../server/project-files');
  const { spawnSync } = require('node:child_process');
  const data = tempDir(t, 'synthorg-data-');
  const chats = tempDir(t, 'synthorg-chats-');
  const row = { id: 'pod-1', kind: 'podman', name: 'Nel pod', path: '/workspace', container_name: 'synthorg-code-nel-pod', section: 'code', envs: '["code","photo"]' };
  const projects = new ProjectManager({ store: () => ({ project: () => row }), sandbox: fakeSandbox, dataDir: data });
  // The database is where it is noted what was taken.
  const taken = new Store(':memory:');
  t.after(() => taken.close());
  const files = new ProjectFiles({
    store: () => new Proxy(taken, { get: (target, name) => name === 'project' ? () => row : name === 'listConversations' ? (query, archived) => archived ? [{ id: 'old' }] : [{ id: 'c1' }, { id: 'c2' }] : typeof target[name] === 'function' ? target[name].bind(target) : target[name] }),
    sandbox: fakeSandbox, projects, chatDir: id => path.join(chats, id)
  });
  const dir = projects.artifactsDir(row);
  const steps = () => spawnSync('git', ['-C', dir, 'log', '--format=%s'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  const listed = async () => (await files.artifacts('pod-1')).files.map(f => `${f.stage}:${f.path}`).sort();

  // Nothing made yet: nothing comes in, no step.
  assert.deepEqual(await listed(), []);
  // A picture generated in one chat, a file in a folder of another, one in an archived chat; the speech and hidden files are not taken.
  fs.mkdirSync(path.join(chats, 'c1'), { recursive: true });
  fs.mkdirSync(path.join(chats, 'c2', 'out'), { recursive: true });
  fs.mkdirSync(path.join(chats, 'old'), { recursive: true });
  fs.writeFileSync(path.join(chats, 'c1', 'gatto.png'), PNG);
  fs.writeFileSync(path.join(chats, 'c1', 'tts_1.mp3'), 'x');
  fs.writeFileSync(path.join(chats, 'c1', '.nascosto'), 'x');
  fs.writeFileSync(path.join(chats, 'c2', 'out', 'relazione.pdf'), 'pdf');
  fs.writeFileSync(path.join(chats, 'old', 'gatto.png'), JPEG);
  assert.deepEqual(await listed(), ['finished:generati/gatto-2.png', 'finished:generati/gatto.png', 'finished:generati/relazione.pdf']);
  assert.ok(fs.readFileSync(path.join(dir, 'generati', 'gatto.png')).equals(PNG));
  assert.deepEqual(steps(), ['dalla chat: 3 file']);
  // Listed again: nothing comes in twice.
  assert.equal((await listed()).length, 3);
  assert.equal(steps().length, 1);
  // Renamed or removed by the user: it does not come back.
  await files.changeArtifact('pod-1', { action: 'rename', path: 'generati/gatto.png', to: 'copertina.png' });
  await files.changeArtifact('pod-1', { action: 'remove', path: 'generati/relazione.pdf' });
  assert.deepEqual(await listed(), ['finished:copertina.png', 'finished:generati/gatto-2.png']);
  // Made anew by the chat: the new one comes in, under the name that is free.
  await new Promise(resolve => setTimeout(resolve, 20));
  fs.writeFileSync(path.join(chats, 'c1', 'gatto.png'), Buffer.concat([PNG, PNG]));
  assert.deepEqual(await listed(), ['finished:copertina.png', 'finished:generati/gatto-2.png', 'finished:generati/gatto.png']);
  assert.equal(steps()[0], 'dalla chat: generati/gatto.png');
  // Noted in the database, and nowhere on disk beside the artifacts.
  assert.deepEqual([...taken.artifactsTaken('pod-1').keys()].sort(), ['c1/gatto.png', 'c2/out/relazione.pdf', 'old/gatto.png']);
  assert.ok(!fs.existsSync(path.join(data, 'artifacts-taken')) && !fs.existsSync(path.join(dir, '.synthorg')));
});
