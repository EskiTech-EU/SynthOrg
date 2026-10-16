'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  detectEngine, runExec, runInContainer, ensureNetwork, ensureSeccompProfile, copyIntoContainer, copyOutOfContainer, removeContainer,
  ensureBaseImage, hardenedRunArgs, normalizeImage, imageKey, containerArch, DEFAULT_PROJECT_IMAGE
} = require('./sandbox');
const { ROOT } = require('./paths');

/**
 * LaTeX for the Studio, the way every library reaches a container here.
 *
 * The engine is Tectonic, one static binary that SynthOrg ships (scripts/
 * fetch-tectonic.js, checked against the release's sha256). It never runs on
 * this machine: it is copied into an image of its own, built from the same
 * base image as the projects, and every compile is a throwaway container of
 * that image with no network at all.
 *
 * The TeX packages are the part that would otherwise be downloaded by the
 * compile itself. They are not: a container made for that — the inert
 * channel, the same idea as the chats' package preinstall — compiles our own
 * sample documents, which use every construct the Studio ever writes and not
 * one word of the user's, with the network on and the cache volume writable.
 * From then on the cache volume is mounted read-only and the compile is
 * refused anything it does not already hold. The user's text meets the
 * network nowhere.
 */
const STUDIO_IMAGE_REPO = 'localhost/synthorg-studio-tools';
const STUDIO_DIR = '/opt/synthorg-studio';
const TECTONIC = `${STUDIO_DIR}/tectonic`;
const TEX_CACHE_VOLUME = 'synthorg-cache-tectonic';
const CACHE_MOUNT = '/var/cache/tectonic';
const WORK = '/work';
// Bumped when what goes into the image changes (the folder, a file): a new image is built.
const IMAGE_RECIPE = 2;
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const WARM_TIMEOUT_MS = 20 * 60 * 1000;
const COMPILE_TIMEOUT_MS = 5 * 60 * 1000;
const WARM_CONTAINER_PREFIX = 'synthorg-studio-warm-';
const COMPILE_CONTAINER_PREFIX = 'synthorg-studio-tex-';

function firstExisting(candidates) {
  return candidates.find(dir => fs.existsSync(dir)) || candidates[0];
}

// Outside resources/ for the same reason as the editor: a binary is a bundle
// resource, not a web asset.
const TECTONIC_PREBUILT_DIR = firstExisting([path.join(ROOT, 'tectonic-bin'), path.join(ROOT, 'resources', 'tectonic-bin')]);

/** The shipped engine for this machine's architecture, with the stamp that names the image it goes into. */
function prebuiltTectonic(arch = process.arch, dir = TECTONIC_PREBUILT_DIR) {
  const binary = path.join(dir, `tectonic-${containerArch(arch)}`);
  const stampFile = path.join(dir, 'build.json');
  if (!fs.existsSync(binary) || !fs.existsSync(stampFile)) return null;
  let built;
  try { built = JSON.parse(fs.readFileSync(stampFile, 'utf8')); } catch { return null; }
  const digest = built[containerArch(arch)];
  if (!built.version || !digest) return null;
  return { binary, version: built.version, stamp: crypto.createHash('sha256').update(`${built.version}:${digest}:${IMAGE_RECIPE}`).digest('hex').slice(0, 10) };
}

function studioImageRef(image, stamp) {
  return `${STUDIO_IMAGE_REPO}:${imageKey(normalizeImage(image)).toLowerCase()}-${stamp}`;
}

function missingEngine() {
  return Object.assign(new Error('Nessun container engine (Podman o Docker) rilevato o avviato sul sistema.'), { status: 503 });
}

/**
 * The image the Studio compiles in: the base image plus the engine. Built
 * once per engine build, with no network: there is nothing to install, the
 * binary is copied in from here.
 */
async function ensureStudioImage(engineInfo, baseImages, onPhase = () => {}) {
  const prebuilt = prebuiltTectonic();
  if (!prebuilt) throw Object.assign(new Error('Il motore LaTeX non è incluso in questa installazione (tectonic-bin mancante: npm run fetch-tectonic).'), { status: 501 });
  const base = engineInfo.baseArgs || [];
  const ref = studioImageRef(DEFAULT_PROJECT_IMAGE, prebuilt.stamp);
  const exists = await runExec(engineInfo.bin, [...base, 'image', 'exists', ref], 10000);
  if (exists.ok) return { image: ref, built: false, version: prebuilt.version };
  onPhase('image');
  await ensureBaseImage(engineInfo, baseImages);
  const name = `synthorg-studio-build-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const run = await runExec(engineInfo.bin, [...base, ...hardenedRunArgs({
      name, network: 'none', image: normalizeImage(DEFAULT_PROJECT_IMAGE), memory: '512m', cpus: '1.0', pids: 128, workdir: '/', seccomp: await ensureSeccompProfile(engineInfo)
    })], BUILD_TIMEOUT_MS);
    if (!run.ok) throw new Error(`Impossibile avviare il container per preparare il motore LaTeX: ${run.stderr || run.stdout || run.error}`);
    // The work folder is part of the image: the engine does not create a working directory that is not there.
    const prepare = await runInContainer(engineInfo, name, `mkdir -p ${STUDIO_DIR} ${WORK}`, 30000, '/');
    if (!prepare.ok) throw new Error(`Impossibile preparare ${STUDIO_DIR}: ${prepare.stderr || prepare.error}`);
    const copy = await copyIntoContainer(engineInfo, prebuilt.binary, name, STUDIO_DIR, 'tectonic');
    if (!copy.ok) throw new Error(`Copia del motore LaTeX nell'immagine non riuscita: ${copy.stderr || copy.error}`);
    const ready = await runInContainer(engineInfo, name, `chmod 755 ${TECTONIC} && ${TECTONIC} --version`, 60000, '/');
    if (!ready.ok) throw new Error(`Il motore LaTeX non parte in questa immagine: ${ready.stderr || ready.stdout || ready.error}`);
    const commit = await runExec(engineInfo.bin, [...base, 'commit', '-q', name, ref], BUILD_TIMEOUT_MS);
    if (!commit.ok) throw new Error(`Impossibile salvare l'immagine ${ref}: ${commit.stderr || commit.error}`);
  } finally {
    await removeContainer(engineInfo, name).catch(() => {});
  }
  // Images of earlier engine builds are superseded.
  const prefix = ref.slice(0, ref.lastIndexOf('-') + 1);
  const listed = await runExec(engineInfo.bin, [...base, 'images', '--format', '{{.Repository}}:{{.Tag}}', STUDIO_IMAGE_REPO], 10000);
  for (const old of (listed.stdout || '').split(/\s+/).filter(tag => tag.startsWith(prefix) && tag !== ref)) {
    await runExec(engineInfo.bin, [...base, 'rmi', old], 60000);
  }
  return { image: ref, built: true, version: prebuilt.version };
}

/** A folder of .tex files written here, as one throwaway container sees it under /work. */
function stageFolder(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-tex-'));
  for (const [name, content] of Object.entries(files)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`Nome di file TeX non valido: ${name}`);
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

/** The lines that say what went wrong, from tectonic's output or the .log it kept. */
function errorsOf(text) {
  const lines = String(text || '').split(/\r?\n/);
  const errors = lines.filter(line => /^!|^error:|^Error:|fatal|cannot|could not|Undefined control sequence|Missing|not found/i.test(line));
  return (errors.length ? errors : lines.filter(Boolean).slice(-12)).slice(0, 20).join('\n').slice(0, 4000);
}

/**
 * What the compile could not find: with --only-cached, a file the cache does
 * not hold is reported as unreachable. That means the cache has to be warmed,
 * not that the document is wrong.
 */
function needsCache(text) {
  return /only-cached|only cached|cache.*(missing|not found|does not contain)|not available in cache|cannot be downloaded|network access is disabled|could not open bundle|no such file or directory.*(fmt|bundle)|failed to open .*index/i.test(String(text || ''));
}

function tectonicScript(main, { onlyCached }) {
  const flags = ['--keep-logs', '--keep-intermediates', '--outdir', WORK];
  if (onlyCached) flags.push('--only-cached');
  return `cd ${WORK} && TECTONIC_CACHE_DIR=${CACHE_MOUNT} ${TECTONIC} ${flags.join(' ')} ${WORK}/${main}`;
}

/**
 * The inert channel: compiles our sample documents with the network on and
 * the cache writable, so every file the Studio's templates need is in the
 * volume. Nothing of the user's is in the container.
 */
async function warmCache({ files, baseImages, onPhase = () => {} }) {
  const engineInfo = await detectEngine();
  if (!engineInfo.available) throw missingEngine();
  const base = engineInfo.baseArgs || [];
  onPhase('engine');
  const { image } = await ensureStudioImage(engineInfo, baseImages, onPhase);
  const name = `${WARM_CONTAINER_PREFIX}${crypto.randomBytes(4).toString('hex')}`;
  const staged = stageFolder(files);
  const log = [];
  try {
    onPhase('cache');
    const run = await runExec(engineInfo.bin, [...base, ...hardenedRunArgs({
      name, network: await ensureNetwork(engineInfo, 'build', true), image,
      mounts: [`${TEX_CACHE_VOLUME}:${CACHE_MOUNT}:rw`],
      memory: '1g', cpus: '1.0', pids: 256, workdir: '/', seccomp: await ensureSeccompProfile(engineInfo)
    })], 60000);
    if (!run.ok) throw new Error(`Impossibile avviare il container che scarica i pacchetti TeX: ${run.stderr || run.stdout || run.error}`);
    const copy = await copyIntoContainer(engineInfo, staged, name, WORK);
    if (!copy.ok) throw new Error(`Copia dei documenti di prova non riuscita: ${copy.stderr || copy.error}`);
    for (const main of Object.keys(files).filter(f => f.endsWith('.tex'))) {
      const res = await runInContainer(engineInfo, name, tectonicScript(main, { onlyCached: false }), WARM_TIMEOUT_MS, WORK);
      log.push(`--- ${main} ---\n${res.stdout}\n${res.stderr}`.trim());
      if (!res.ok) {
        const kept = await runInContainer(engineInfo, name, `tail -n 80 ${WORK}/${main.replace(/\.tex$/, '.log')} 2>/dev/null`, 30000, WORK);
        return { ok: false, error: errorsOf(`${res.stderr}\n${kept.stdout || ''}`), log: log.join('\n\n').slice(-12000) };
      }
    }
    return { ok: true, log: log.join('\n\n').slice(-12000) };
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
    await removeContainer(engineInfo, name).catch(() => {});
  }
}

/**
 * One compile of the user's document: no network, the cache read-only, the
 * files in by stdin, the PDF out to `outDir` — a rendering, which is what may
 * leave a container.
 */
async function compile({ files, main = 'main.tex', outDir, baseImages, onPhase = () => {} }) {
  const engineInfo = await detectEngine();
  if (!engineInfo.available) throw missingEngine();
  const base = engineInfo.baseArgs || [];
  onPhase('engine');
  const { image, version } = await ensureStudioImage(engineInfo, baseImages, onPhase);
  const name = `${COMPILE_CONTAINER_PREFIX}${crypto.randomBytes(4).toString('hex')}`;
  const staged = stageFolder(files);
  try {
    onPhase('compile');
    const run = await runExec(engineInfo.bin, [...base, ...hardenedRunArgs({
      name, network: 'none', image,
      mounts: [`${TEX_CACHE_VOLUME}:${CACHE_MOUNT}:ro`],
      memory: '1g', cpus: '2.0', pids: 256, workdir: '/', seccomp: await ensureSeccompProfile(engineInfo)
    })], 60000);
    if (!run.ok) throw new Error(`Impossibile avviare il container di compilazione: ${run.stderr || run.stdout || run.error}`);
    const copy = await copyIntoContainer(engineInfo, staged, name, WORK);
    if (!copy.ok) throw new Error(`Copia del documento nel container non riuscita: ${copy.stderr || copy.error}`);
    const res = await runInContainer(engineInfo, name, tectonicScript(main, { onlyCached: true }), COMPILE_TIMEOUT_MS, WORK);
    const logName = main.replace(/\.tex$/, '.log');
    const kept = await runInContainer(engineInfo, name, `tail -n 120 ${WORK}/${logName} 2>/dev/null`, 30000, WORK);
    const text = `${res.stdout}\n${res.stderr}\n${kept.stdout || ''}`;
    if (!res.ok) {
      return { ok: false, needsCache: needsCache(`${res.stdout}\n${res.stderr}`), error: errorsOf(`${res.stderr}\n${kept.stdout || ''}`), log: text.slice(-12000), engine: version };
    }
    fs.mkdirSync(outDir, { recursive: true });
    const pdfName = main.replace(/\.tex$/, '.pdf');
    const out = await copyOutOfContainer(engineInfo, name, `${WORK}/${pdfName}`, outDir);
    if (!out.ok) throw new Error(`Il PDF non è uscito dal container: ${out.stderr || out.error}`);
    const pdf = path.join(outDir, pdfName);
    if (!fs.existsSync(pdf)) throw new Error('Il PDF non è stato prodotto.');
    const warnings = String(kept.stdout || '').split(/\r?\n/).filter(line => /^(LaTeX|Package) .*Warning|Overfull|Underfull/.test(line)).slice(0, 20);
    return { ok: true, pdf, bytes: fs.statSync(pdf).size, warnings, log: text.slice(-12000), engine: version };
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
    await removeContainer(engineInfo, name).catch(() => {});
  }
}

/** Whether the cache volume exists at all: a quick look, not a guarantee that every file the templates need is there. */
async function cacheStatus() {
  const engineInfo = await detectEngine();
  if (!engineInfo.available) return { engine: false, warmed: false };
  const base = engineInfo.baseArgs || [];
  const exists = await runExec(engineInfo.bin, [...base, 'volume', 'exists', TEX_CACHE_VOLUME], 8000);
  return { engine: true, warmed: exists.ok, prebuilt: Boolean(prebuiltTectonic()) };
}

/** Forgets the downloaded packages: the next compile asks for them again. */
async function dropCache() {
  const engineInfo = await detectEngine();
  if (!engineInfo.available) throw missingEngine();
  const res = await runExec(engineInfo.bin, [...(engineInfo.baseArgs || []), 'volume', 'rm', '-f', TEX_CACHE_VOLUME], 30000);
  return { removed: res.ok };
}

module.exports = {
  ensureStudioImage, warmCache, compile, cacheStatus, dropCache, prebuiltTectonic, studioImageRef, needsCache, errorsOf,
  TEX_CACHE_VOLUME, STUDIO_IMAGE_REPO, TECTONIC_PREBUILT_DIR
};
