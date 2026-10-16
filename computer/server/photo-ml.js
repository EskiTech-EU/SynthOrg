'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  detectEngine, runExec, runInContainer, ensureNetwork, ensureSeccompProfile, copyIntoContainer, copyOutOfContainer, removeContainer,
  ensureBaseImage, hardenedRunArgs, normalizeImage, imageKey, containerArch, DEFAULT_PROJECT_IMAGE, PACKAGE_CACHE_MOUNTS
} = require('./sandbox');
const { ROOT } = require('./paths');

/**
 * The Foto section's own functions, run where SynthOrg runs anything that
 * computes on the user's files: a pod, on the CPU, with no network.
 *
 * The first function is the removal of a photo's background. The program
 * that does it is ours (server/photo/rembg, a small Rust binary around ONNX
 * Runtime), compiled once in a throwaway container by whoever builds
 * SynthOrg — as the Code editor is — and copied into an image of its own,
 * which also carries the runtime from Alpine's packages. The model it runs
 * is one of those the rembg project publishes, chosen by the user and
 * fetched once by the inert channel (a container with network and none of
 * the user's files, checking the file against a hash pinned here) into a
 * volume that the work container mounts read-only. The work container gets
 * the photo by stdin and gives the result back as a file: a rendering, the
 * one thing that leaves a pod.
 */
const PHOTO_IMAGE_REPO = 'localhost/synthorg-photo-tools';
const PHOTO_DIR = '/opt/synthorg-photo';
const REMBG = `${PHOTO_DIR}/synthorg-rembg`;
const MODELS_VOLUME = 'synthorg-cache-photo-models';
const CARGO_VOLUME = 'synthorg-cache-cargo';
const MODELS_MOUNT = '/models';
const WORK = '/work';
// What the pod image is made of besides the program: bumped when that changes (2: ONNX Runtime from Alpine's packages).
const IMAGE_RECIPE = 2;
const RUNTIME_PACKAGE = 'onnxruntime';
const BUILD_TIMEOUT_MS = 45 * 60 * 1000;
const WARM_TIMEOUT_MS = 30 * 60 * 1000;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const WARM_CONTAINER_PREFIX = 'synthorg-photo-warm-';
const RUN_CONTAINER_PREFIX = 'synthorg-photo-run-';

/**
 * The models, pinned: the rembg project publishes them as release assets, and
 * SynthOrg checks the bytes against the hash recorded here (computed from
 * that download: 2026-10-06 the first two, 2026-10-07 the others). It is the
 * user who downloads one, when they choose it; nothing is shipped.
 *
 * What a model's file says of itself is read from the file, by the program:
 * the size of its input, and whether its output is logits (seen in the
 * output). Here is only what no file says: `mean` and `std`, how its authors
 * normalised the pictures (the ImageNet values for all but IS-Net); `size`
 * for the one whose input is of any size; its licence as its authors state
 * it, which the page shows before the download; and the memory its container
 * is given. A model with `use: 'object'` is not asked for the subject: it
 * is told where the object is (a rectangle), and finds that.
 *
 * Measured on 2026-10-07 on a portrait of 1058×1252, 4 processors, ONNX
 * Runtime 1.23 (time in the program, peak memory): u2net 0,7 s and 0,4 GB;
 * isnet 1,3 s and 0,8 GB; birefnetLite 9,6 s and 6,5 GB; birefnet 23,8 s and
 * 6,9 GB; briaRmbg2 20,9 s and 6,9 GB. With tract, before: 2,8 s, 7,0 s,
 * 55 s, 97 s, and BRIA did not load. The three large ones take what memory
 * the container has (it was given 6,9 GB): on a machine with less they may
 * not run.
 */
const MODELS = Object.freeze({
  u2net: { file: 'u2net.onnx', url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx', sha256: '8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491', bytes: 175997641, label: 'U²-Net (168 MB)', mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], licence: 'Apache-2.0', memory: '3g' },
  u2netp: { file: 'u2netp.onnx', url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx', sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8', bytes: 4574861, label: 'U²-Net piccolo (4,4 MB)', mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], licence: 'Apache-2.0', memory: '3g' },
  isnet: { file: 'isnet-general-use.onnx', url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx', sha256: '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a', bytes: 178648008, label: 'IS-Net (170 MB)', mean: [0.5, 0.5, 0.5], std: [1, 1, 1], licence: 'Apache-2.0', memory: '3g' },
  birefnetLite: { file: 'BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx', url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx', sha256: '5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333', bytes: 224005088, label: 'BiRefNet leggero (214 MB)', mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], licence: 'MIT', memory: '8g' },
  birefnet: { file: 'BiRefNet-general-epoch_244.onnx', url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-epoch_244.onnx', sha256: '58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c', bytes: 972666916, label: 'BiRefNet (928 MB)', mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], licence: 'MIT', memory: '8g' },
  briaRmbg2: { file: 'bria-rmbg-2.0.onnx', url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/bria-rmbg-2.0.onnx', sha256: '5b486f08200f513f460da46dd701db5fbb47d79b4be4b708a19444bcd4e79958', bytes: 1024331469, label: 'BRIA RMBG 2.0 (977 MB)', size: 1024, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], licence: 'CC BY-NC 4.0 (solo uso non commerciale)', memory: '8g' },
  // Segment Anything (ViT-B): told where the object is by a rectangle. Two files: what reads the picture, what answers.
  samVitB: {
    use: 'object', label: 'Segment Anything ViT-B (358 MB)', licence: 'Apache-2.0', memory: '6g',
    files: [
      { file: 'sam_vit_b_01ec64.encoder.onnx', url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/sam_vit_b_01ec64.encoder.onnx', sha256: '62a29c39ebc8ae4dfc3d9ec8eae28c28efc8360233fa8ffba229eb9f6ac0c30a', bytes: 359217310 },
      { file: 'sam_vit_b_01ec64.decoder.onnx', url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/sam_vit_b_01ec64.decoder.onnx', sha256: '9820a48a2d002aead7b4dab204d813176a810a5f1dc8f32e32f759cc070ae97e', bytes: 16500570 }
    ]
  }
});
const DEFAULT_MODEL = 'u2net';
const DEFAULT_OBJECT_MODEL = 'samVitB';

/** The files a model is made of: one for most, two for Segment Anything. */
function partsOf(model) {
  return model.files || [model];
}

function firstExisting(candidates) {
  return candidates.find(dir => fs.existsSync(dir)) || candidates[0];
}

const REMBG_SOURCES = path.join(ROOT, 'server', 'photo', 'rembg');
// Outside resources/ for the same reason as the editor: a binary is a bundle resource, not a web asset.
const REMBG_PREBUILT_DIR = firstExisting([path.join(ROOT, 'photo-tools-bin'), path.join(ROOT, 'resources', 'photo-tools-bin')]);

/** Every source file of the program, in a stable order: what the stamp of a build is made of. */
function sourceFiles(dir = REMBG_SOURCES) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'target') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full)); else out.push(full);
  }
  return out;
}

function sourceStamp(dir = REMBG_SOURCES) {
  const hash = crypto.createHash('sha256');
  for (const file of sourceFiles(dir)) {
    hash.update(`${path.relative(dir, file).split(path.sep).join('/')}:`);
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex').slice(0, 16);
}

/** The prebuilt program for this machine's architecture, or null if there is none made from these sources. */
function prebuiltRembg(arch = process.arch, dir = REMBG_PREBUILT_DIR) {
  const binary = path.join(dir, `synthorg-rembg-${containerArch(arch)}`);
  const stampFile = path.join(dir, 'build.json');
  if (!fs.existsSync(binary) || !fs.existsSync(stampFile)) return null;
  try {
    const built = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
    if (built.sources !== sourceStamp()) return null;
    return { binary, sources: built.sources, stamp: crypto.createHash('sha256').update(`${built.sources}:${IMAGE_RECIPE}`).digest('hex').slice(0, 10) };
  } catch { return null; }
}

function photoImageRef(image, stamp) {
  return `${PHOTO_IMAGE_REPO}:${imageKey(normalizeImage(image)).toLowerCase()}-${stamp}`;
}

function missingEngine() {
  return Object.assign(new Error('Nessun container engine (Podman o Docker) rilevato o avviato sul sistema.'), { status: 503 });
}

/**
 * Compiles the program for Alpine (musl) in a throwaway container with
 * the network (the builder's inert channel: cargo fetches the crates it
 * needs into a cache volume) and leaves the binary in outDir with its stamp.
 * Runs at build time, by scripts/build-rembg.js; never at the user's.
 */
async function buildRembg({ baseImages, outDir = REMBG_PREBUILT_DIR, log = () => {} } = {}) {
  const engineInfo = await detectEngine();
  if (!engineInfo.available) return { skipped: true, reason: 'Nessun container engine disponibile: le funzioni Foto non saranno incluse.' };
  const base = engineInfo.baseArgs || [];
  const arch = containerArch();
  const image = await ensureBaseImage(engineInfo, baseImages);
  const name = `synthorg-rembg-build-${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  try {
    log(`compilo in ${image} (${arch})`);
    const run = await runExec(engineInfo.bin, [...base, ...hardenedRunArgs({
      name, network: await ensureNetwork(engineInfo, 'build', true), image,
      mounts: [...PACKAGE_CACHE_MOUNTS, `${CARGO_VOLUME}:/root/.cargo/registry:rw`],
      memory: '6g', cpus: '4.0', pids: 1024, workdir: '/', seccomp: await ensureSeccompProfile(engineInfo)
    })], BUILD_TIMEOUT_MS);
    if (!run.ok) throw new Error(`Container di build non avviato: ${run.stderr || run.stdout || run.error}`);
    const deps = await runInContainer(engineInfo, name, 'mkdir -p /src /out; apk add rust cargo build-base', BUILD_TIMEOUT_MS, '/');
    if (!deps.ok) throw new Error(`Strumenti di compilazione non installabili: ${deps.stderr || deps.error}`);
    const copy = await copyIntoContainer(engineInfo, REMBG_SOURCES, name, '/src');
    if (!copy.ok) throw new Error(`Sorgenti non copiati: ${copy.stderr || copy.error}`);
    // Not static: the program loads ONNX Runtime's library when it starts, which a
    // static musl binary cannot do. The flag goes to the target alone (named
    // explicitly, as Alpine names it), not to cargo's own build scripts.
    const triple = `${arch}-alpine-linux-musl`;
    const flagsVar = `CARGO_TARGET_${triple.toUpperCase().replace(/-/g, '_')}_RUSTFLAGS`;
    const build = await runInContainer(engineInfo, name, [
      'cd /src',
      'rm -rf target',
      `${flagsVar}="-C target-feature=-crt-static" cargo build --release --locked --target ${triple}`,
      `cp target/${triple}/release/synthorg-rembg /out/synthorg-rembg`,
      `apk add ${RUNTIME_PACKAGE}`,
      '/out/synthorg-rembg --check'
    ].join(' && '), BUILD_TIMEOUT_MS, '/');
    if (!build.ok) throw new Error(`Compilazione non riuscita: ${(build.stderr || build.stdout || build.error || '').trim().split(/\r?\n/).slice(-6).join(' ')}`);
    const out = await copyOutOfContainer(engineInfo, name, '/out/synthorg-rembg', outDir);
    if (!out.ok) throw new Error(`Estrazione non riuscita: ${out.stderr || out.error}`);
    fs.renameSync(path.join(outDir, 'synthorg-rembg'), path.join(outDir, `synthorg-rembg-${arch}`));
  } finally {
    await removeContainer(engineInfo, name).catch(() => {});
  }
  const stamp = { sources: sourceStamp(), arch, image, at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000) };
  fs.writeFileSync(path.join(outDir, 'build.json'), JSON.stringify(stamp, null, 2) + '\n');
  return { skipped: false, dir: outDir, arch, bytes: fs.statSync(path.join(outDir, `synthorg-rembg-${arch}`)).size, stamp: stamp.sources, seconds: stamp.seconds };
}

/**
 * The image the functions run in: the base image, ONNX Runtime from Alpine's
 * packages and the program. It is made by a container with the build network
 * and nothing of the user's in it (the inert channel, as for every library);
 * the functions then run from the image with no network at all.
 */
async function ensurePhotoImage(engineInfo, baseImages, onPhase = () => {}) {
  const prebuilt = prebuiltRembg();
  if (!prebuilt) throw Object.assign(new Error('Le funzioni Foto non sono incluse in questa installazione (photo-tools-bin mancante: npm run build:rembg).'), { status: 501 });
  const base = engineInfo.baseArgs || [];
  const ref = photoImageRef(DEFAULT_PROJECT_IMAGE, prebuilt.stamp);
  const exists = await runExec(engineInfo.bin, [...base, 'image', 'exists', ref], 10000);
  if (exists.ok) return { image: ref, built: false };
  onPhase('image');
  await ensureBaseImage(engineInfo, baseImages);
  const name = `synthorg-photo-build-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const run = await runExec(engineInfo.bin, [...base, ...hardenedRunArgs({
      name, network: await ensureNetwork(engineInfo, 'build', true), image: normalizeImage(DEFAULT_PROJECT_IMAGE), mounts: PACKAGE_CACHE_MOUNTS,
      memory: '1g', cpus: '1.0', pids: 128, workdir: '/', seccomp: await ensureSeccompProfile(engineInfo)
    })], 5 * 60 * 1000);
    if (!run.ok) throw new Error(`Impossibile avviare il container per preparare le funzioni Foto: ${run.stderr || run.stdout || run.error}`);
    const prepare = await runInContainer(engineInfo, name, `mkdir -p ${PHOTO_DIR} ${WORK} ${MODELS_MOUNT} && apk add ${RUNTIME_PACKAGE}`, 10 * 60 * 1000, '/');
    if (!prepare.ok) throw new Error(`Impossibile installare ONNX Runtime nell'immagine delle funzioni Foto: ${(prepare.stderr || prepare.stdout || prepare.error || '').trim().split(/\r?\n/).slice(-3).join(' ')}`);
    const copy = await copyIntoContainer(engineInfo, prebuilt.binary, name, PHOTO_DIR, 'synthorg-rembg');
    if (!copy.ok) throw new Error(`Copia del programma nell'immagine non riuscita: ${copy.stderr || copy.error}`);
    const ready = await runInContainer(engineInfo, name, `chmod 755 ${REMBG} && ${REMBG} --check`, 60000, '/');
    if (!ready.ok) throw new Error(`Il programma non parte in questa immagine: ${ready.stderr || ready.stdout || ready.error}`);
    const commit = await runExec(engineInfo.bin, [...base, 'commit', '-q', name, ref], 5 * 60 * 1000);
    if (!commit.ok) throw new Error(`Impossibile salvare l'immagine ${ref}: ${commit.stderr || commit.error}`);
  } finally {
    await removeContainer(engineInfo, name).catch(() => {});
  }
  const prefix = ref.slice(0, ref.lastIndexOf('-') + 1);
  const listed = await runExec(engineInfo.bin, [...base, 'images', '--format', '{{.Repository}}:{{.Tag}}', PHOTO_IMAGE_REPO], 10000);
  for (const old of (listed.stdout || '').split(/\s+/).filter(tag => tag.startsWith(prefix) && tag !== ref)) {
    await runExec(engineInfo.bin, [...base, 'rmi', old], 60000);
  }
  return { image: ref, built: true };
}

/**
 * What the engine's machine has, asked once: a run gets every processor of
 * it, and the memory its model wants as far as the machine has it (a
 * gigabyte is left to the machine itself).
 */
let capacityKnown = null;
async function engineCapacity(engineInfo) {
  if (capacityKnown) return capacityKnown;
  const info = await runExec(engineInfo.bin, [...(engineInfo.baseArgs || []), 'info', '--format', '{{.Host.CPUs}} {{.Host.MemTotal}}'], 30000);
  const [cpus, bytes] = String(info.stdout || '').trim().split(/\s+/).map(Number);
  const totalMb = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes / 1048576) : 0;
  capacityKnown = {
    cpus: Number.isInteger(cpus) && cpus > 0 ? `${cpus}.0` : '2.0',
    memory(wanted) {
      const wantedMb = Number.parseInt(wanted, 10) * 1024;
      return totalMb ? `${Math.max(1024, Math.min(wantedMb, totalMb - 1024))}m` : wanted;
    }
  };
  return capacityKnown;
}

/** A model by its name in the table here, or as its description (one the user added from the Hub). */
function modelOf(name) {
  const model = name && typeof name === 'object' ? name : MODELS[name];
  if (!model || !partsOf(model).every(part => /^[\w.-]+\.onnx$/.test(part.file) && /^[a-f0-9]{64}$/.test(part.sha256) && /^https:\/\//.test(part.url))) throw Object.assign(new Error(`Modello sconosciuto: ${typeof name === 'string' ? name : ''}.`), { status: 400 });
  return model;
}

/**
 * The inert channel: a container with the network and nothing of the user's
 * downloads the model into the volume and checks it against the pinned hash.
 * A file already there and matching is left alone.
 */
async function warmModels({ models = [DEFAULT_MODEL], baseImages, onPhase = () => {} } = {}) {
  const engineInfo = await detectEngine();
  if (!engineInfo.available) throw missingEngine();
  const base = engineInfo.baseArgs || [];
  onPhase('engine');
  const { image } = await ensurePhotoImage(engineInfo, baseImages, onPhase);
  const name = `${WARM_CONTAINER_PREFIX}${crypto.randomBytes(4).toString('hex')}`;
  const log = [];
  try {
    onPhase('models');
    const run = await runExec(engineInfo.bin, [...base, ...hardenedRunArgs({
      name, network: await ensureNetwork(engineInfo, 'build', true), image,
      mounts: [`${MODELS_VOLUME}:${MODELS_MOUNT}:rw`],
      memory: '512m', cpus: '1.0', pids: 64, workdir: '/', seccomp: await ensureSeccompProfile(engineInfo)
    })], 60000);
    if (!run.ok) throw new Error(`Impossibile avviare il container che scarica i modelli: ${run.stderr || run.stdout || run.error}`);
    for (const key of models) {
      for (const model of partsOf(modelOf(key))) {
        // Checked before and after: a good file is not downloaded again, a bad one never stays.
        const script = [
          `cd ${MODELS_MOUNT}`,
          `if echo "${model.sha256}  ${model.file}" | sha256sum -c -s 2>/dev/null; then echo "[synthorg] ${model.file} gia presente"; exit 0; fi`,
          `rm -f ${model.file}.part`,
          `wget -q -O ${model.file}.part "${model.url}"`,
          `echo "${model.sha256}  ${model.file}.part" | sha256sum -c -s || { rm -f ${model.file}.part; echo "[synthorg] impronta diversa per ${model.file}" >&2; exit 1; }`,
          `mv ${model.file}.part ${model.file}`,
          `echo "[synthorg] ${model.file} scaricato"`
        ].join(' && ');
        const res = await runInContainer(engineInfo, name, script, WARM_TIMEOUT_MS, '/');
        log.push(`--- ${model.file} ---\n${res.stdout}\n${res.stderr}`.trim());
        if (!res.ok) return { ok: false, error: (res.stderr || res.stdout || res.error || '').trim().split(/\r?\n/).slice(-3).join(' '), log: log.join('\n\n').slice(-8000) };
      }
    }
    return { ok: true, log: log.join('\n\n').slice(-8000) };
  } finally {
    await removeContainer(engineInfo, name).catch(() => {});
  }
}

/**
 * One photo in, one PNG out: a throwaway container with no network and the
 * models read-only. With a model of use 'object', `box` is the rectangle
 * around the object ([x0, y0, x1, y1] in the photo's pixels). The result lands in outDir under outName; the figures
 * the program prints come back for the record.
 */
async function removeBackground({ file, model = DEFAULT_MODEL, box = null, outDir, outName, baseImages, onPhase = () => {} }) {
  const engineInfo = await detectEngine();
  if (!engineInfo.available) throw missingEngine();
  const base = engineInfo.baseArgs || [];
  const chosen = modelOf(model);
  const parts = partsOf(chosen);
  const pointed = chosen.use === 'object';
  if (pointed && !(Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) && box[2] > box[0] && box[3] > box[1])) throw Object.assign(new Error('Manca il riquadro attorno all’oggetto.'), { status: 400 });
  if (!pointed && box) throw Object.assign(new Error('Questo modello non prende un riquadro.'), { status: 400 });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw Object.assign(new Error('Foto non trovata.'), { status: 404 });
  onPhase('engine');
  const { image } = await ensurePhotoImage(engineInfo, baseImages, onPhase);
  const capacity = await engineCapacity(engineInfo);
  const name = `${RUN_CONTAINER_PREFIX}${crypto.randomBytes(4).toString('hex')}`;
  const ext = path.extname(file).toLowerCase() || '.img';
  // A name of ours for the file inside: the user's name never reaches a shell.
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-photo-'));
  fs.copyFileSync(file, path.join(staged, `in${ext}`));
  try {
    onPhase('run');
    const run = await runExec(engineInfo.bin, [...base, ...hardenedRunArgs({
      name, network: 'none', image,
      mounts: [`${MODELS_VOLUME}:${MODELS_MOUNT}:ro`],
      memory: capacity.memory(chosen.memory), cpus: capacity.cpus, pids: 64, workdir: '/', capAdd: [], seccomp: await ensureSeccompProfile(engineInfo)
    })], 60000);
    if (!run.ok) throw new Error(`Impossibile avviare il container della funzione: ${run.stderr || run.stdout || run.error}`);
    const copy = await copyIntoContainer(engineInfo, staged, name, WORK);
    if (!copy.ok) throw new Error(`Copia della foto nel container non riuscita: ${copy.stderr || copy.error}`);
    const check = await runInContainer(engineInfo, name, parts.map(part => `test -f ${MODELS_MOUNT}/${part.file}`).join(' && '), 30000, '/');
    if (!check.ok) return { ok: false, needsModel: true, model: typeof model === 'string' ? model : null, error: `Il modello ${chosen.label} non è ancora scaricato.` };
    const how = pointed
      ? `--encoder ${MODELS_MOUNT}/${parts[0].file} --decoder ${MODELS_MOUNT}/${parts[1].file} --box ${box.map(v => Math.round(v)).join(',')}`
      : `--model ${MODELS_MOUNT}/${chosen.file} --mean ${chosen.mean.join(',')} --std ${chosen.std.join(',')}${chosen.size ? ` --size ${chosen.size}` : ''}`;
    const res = await runInContainer(engineInfo, name, `${REMBG} ${how} --in ${WORK}/in${ext} --out ${WORK}/out.png --json`, RUN_TIMEOUT_MS, '/');
    if (!res.ok) return { ok: false, error: (res.stderr || res.stdout || res.error || '').trim().split(/\r?\n/).slice(-3).join(' ') };
    let figures = {};
    try { figures = JSON.parse(res.stdout.trim().split(/\r?\n/).pop()); } catch {}
    fs.mkdirSync(outDir, { recursive: true });
    onPhase('copy');
    const out = await copyOutOfContainer(engineInfo, name, `${WORK}/out.png`, staged);
    if (!out.ok) throw new Error(`Il risultato non è uscito dal container: ${out.stderr || out.error}`);
    const produced = path.join(staged, 'out.png');
    if (!fs.existsSync(produced)) throw new Error('Il risultato non è stato prodotto.');
    const target = path.join(outDir, outName);
    fs.copyFileSync(produced, target);
    return { ok: true, output: target, bytes: fs.statSync(target).size, model: typeof model === 'string' ? model : chosen.label, ...figures };
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
    await removeContainer(engineInfo, name).catch(() => {});
  }
}

/** Which models the volume holds: a quick listing, not a hash check. */
/**
 * What a model's file says of itself — its inputs and outputs, with their
 * shapes — read by the program in a pod with no network. For a model just
 * downloaded: whether it takes a picture at all, and of which size.
 */
async function describeModel(file, { baseImages } = {}) {
  if (!/^[\w.-]+\.onnx$/.test(String(file))) throw Object.assign(new Error('File del modello non valido.'), { status: 400 });
  const engineInfo = await detectEngine();
  if (!engineInfo.available) throw missingEngine();
  const { image } = await ensurePhotoImage(engineInfo, baseImages);
  const capacity = await engineCapacity(engineInfo);
  const name = `${RUN_CONTAINER_PREFIX}${crypto.randomBytes(4).toString('hex')}`;
  try {
    const run = await runExec(engineInfo.bin, [...(engineInfo.baseArgs || []), ...hardenedRunArgs({
      name, network: 'none', image, mounts: [`${MODELS_VOLUME}:${MODELS_MOUNT}:ro`],
      memory: capacity.memory('8g'), cpus: capacity.cpus, pids: 64, workdir: '/', capAdd: [], seccomp: await ensureSeccompProfile(engineInfo)
    })], 60000);
    if (!run.ok) throw new Error(`Impossibile avviare il container della funzione: ${run.stderr || run.stdout || run.error}`);
    const res = await runInContainer(engineInfo, name, `${REMBG} --describe --model ${MODELS_MOUNT}/${file}`, RUN_TIMEOUT_MS, '/');
    if (!res.ok) return { ok: false, error: (res.stderr || res.stdout || res.error || '').trim().split(/\r?\n/).slice(-2).join(' ') };
    try { return { ok: true, ...JSON.parse(res.stdout.trim().split(/\r?\n/).pop()) }; }
    catch { return { ok: false, error: 'Il programma non ha descritto il modello.' }; }
  } finally {
    await removeContainer(engineInfo, name).catch(() => {});
  }
}

/** A model's files taken out of the volume: for one the user removes from the list. */
async function removeModelFiles(files) {
  const names = files.filter(file => /^[\w.-]+\.onnx$/.test(String(file)));
  if (!names.length) return { removed: 0 };
  const engineInfo = await detectEngine();
  if (!engineInfo.available) throw missingEngine();
  const res = await runExec(engineInfo.bin, [...(engineInfo.baseArgs || []), 'run', '--rm', '--network=none', '-v', `${MODELS_VOLUME}:${MODELS_MOUNT}:rw`, normalizeImage(DEFAULT_PROJECT_IMAGE), 'rm', '-f', ...names.map(file => `${MODELS_MOUNT}/${file}`)], 60000);
  return { removed: res.ok ? names.length : 0 };
}

async function cacheStatus(extra = {}) {
  const engineInfo = await detectEngine();
  const prebuilt = Boolean(prebuiltRembg());
  if (!engineInfo.available) return { engine: false, prebuilt, models: {} };
  const base = engineInfo.baseArgs || [];
  const exists = await runExec(engineInfo.bin, [...base, 'volume', 'exists', MODELS_VOLUME], 8000);
  const all = { ...MODELS, ...extra };
  const models = Object.fromEntries(Object.keys(all).map(key => [key, false]));
  if (!exists.ok) return { engine: true, prebuilt, volume: false, models };
  // A listing by a bare container of the base image: the volume's names, nothing run.
  const listed = await runExec(engineInfo.bin, [...base, 'run', '--rm', '--network=none', '-v', `${MODELS_VOLUME}:${MODELS_MOUNT}:ro`, normalizeImage(DEFAULT_PROJECT_IMAGE), 'ls', MODELS_MOUNT], 30000);
  const names = new Set((listed.stdout || '').split(/\s+/).filter(Boolean));
  for (const [key, model] of Object.entries(all)) models[key] = partsOf(model).every(part => names.has(part.file));
  return { engine: true, prebuilt, volume: true, models };
}

async function dropCache() {
  const engineInfo = await detectEngine();
  if (!engineInfo.available) throw missingEngine();
  const res = await runExec(engineInfo.bin, [...(engineInfo.baseArgs || []), 'volume', 'rm', '-f', MODELS_VOLUME], 30000);
  return { removed: res.ok };
}

module.exports = {
  MODELS, DEFAULT_MODEL, DEFAULT_OBJECT_MODEL, partsOf, buildRembg, ensurePhotoImage, warmModels, removeBackground, describeModel, removeModelFiles, cacheStatus, dropCache, prebuiltRembg, sourceStamp, photoImageRef,
  REMBG_PREBUILT_DIR, REMBG_SOURCES, MODELS_VOLUME, PHOTO_IMAGE_REPO, RUN_CONTAINER_PREFIX, WARM_CONTAINER_PREFIX
};
