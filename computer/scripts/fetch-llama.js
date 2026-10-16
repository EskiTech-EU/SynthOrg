'use strict';
// Downloads the engine the local models run on: llama.cpp's server, the build
// its project publishes for this platform with the Vulkan backend (any video
// card with a Vulkan driver, and the processor where there is none), checked
// against the sha256 the release publishes. It is what `bin/llama` holds and
// what the application carries: the models themselves are never shipped, the
// user downloads them (server/local-models.js).
//
// One release for every platform, so a model behaves the same on each. An
// engine already in `bin/llama` that this script did not put there (a build
// of one's own) is left alone: delete the folder, or set
// SYNTHORG_FORCE_LLAMA_FETCH, to have the release's instead.
//
// Only what the server needs is kept: the server, the libraries it loads, the
// licence. The archive's other programs (the command-line chat, the
// benchmarks, the converters) are not used by SynthOrg.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const TAG = 'b10999';
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'bin', 'llama');
const BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/`;

/** Published with the release (asset digests of llama.cpp@b10999). */
const RELEASES = {
  'linux-x64': { file: `llama-${TAG}-bin-ubuntu-vulkan-x64.tar.gz`, sha256: '492c0871fd257f4fcf8c2b9938e2c1015efa780f8f5b2e328e36858f8e3d462f' },
  'linux-arm64': { file: `llama-${TAG}-bin-ubuntu-vulkan-arm64.tar.gz`, sha256: '384091f40dddf3c89c18dab6067417122608bf782c9c1a0cbb68ec3d12d8a30c' },
  'win32-x64': { file: `llama-${TAG}-bin-win-vulkan-x64.zip`, sha256: 'cce83f919eb637473bea0822f0bfa652a8ffa4cdae4ba76547461584894fece8' }
};
const SERVER = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

function readStamp() {
  try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'build.json'), 'utf8')); } catch { return null; }
}

/** The folder of the unpacked archive that holds the server. */
function serverDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === SERVER) return dir;
    if (entry.isDirectory()) { const found = serverDir(path.join(dir, entry.name)); if (found) return found; }
  }
  return null;
}

/**
 * What the server needs, out of the archive's folder. On Linux a library is
 * there three times — the file, the name programs ask for (a link to it) and
 * a name for compilers: only the second is kept, as a file, so the folder
 * has no links for a package to mishandle.
 */
function keep(from) {
  const entries = fs.readdirSync(from, { withFileTypes: true });
  const sonames = new Set(entries.filter(e => e.isSymbolicLink() && /\.so\.\d+$/.test(e.name)).map(e => e.name));
  const kept = [];
  for (const entry of entries) {
    const name = entry.name;
    const library = /\.(so(\.[\d.]+)?|dll)$/.test(name);
    // The parts of the archive's other programs.
    if (/-impl\.(so|dll)$/.test(name) && !/^(lib)?llama-server-impl\./.test(name)) continue;
    if (entry.isSymbolicLink()) { if (sonames.has(name)) kept.push(name); continue; }
    if (!entry.isFile()) continue;
    if (name === SERVER || name === 'LICENSE' || /^LICENSE/.test(name)) { kept.push(name); continue; }
    if (!library) continue;
    // The file a kept name points to is copied under that name, not twice.
    if ([...sonames].some(soname => name.startsWith(`${soname}.`))) continue;
    kept.push(name);
  }
  return kept;
}

async function main() {
  const key = `${process.platform}-${process.arch}`;
  const release = RELEASES[key];
  const stamp = readStamp();
  const present = fs.existsSync(path.join(OUT_DIR, SERVER));
  if (present && !process.env.SYNTHORG_FORCE_LLAMA_FETCH) {
    if (stamp && stamp.tag === TAG && release && stamp.sha256 === release.sha256) { console.log(`[fetch-llama] gia presente: ${path.relative(ROOT, OUT_DIR)} (${TAG})`); return; }
    if (!stamp) { console.log(`[fetch-llama] in ${path.relative(ROOT, OUT_DIR)} c'è un motore non scaricato da qui: lo lascio com'è.`); return; }
  }
  if (!release) {
    console.log(`[fetch-llama] nessuna build pubblicata per ${key}: i modelli locali non avranno il motore.`);
    return;
  }
  const url = BASE + release.file;
  console.log(`[fetch-llama] scarico ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download non riuscito (${response.status}) da ${url}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== release.sha256) throw new Error(`sha256 diverso da quello pubblicato per ${release.file}: ${digest}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-llama-'));
  try {
    const archivePath = path.join(work, release.file);
    fs.writeFileSync(archivePath, archive);
    const unpacked = path.join(work, 'unpacked');
    fs.mkdirSync(unpacked);
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xf', archivePath, '-C', unpacked], { stdio: 'inherit' });
    const from = serverDir(unpacked);
    if (!from) throw new Error(`${SERVER} non trovato nell'archivio.`);
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const names = keep(from);
    for (const name of names) {
      // copyFile follows a link: the name programs ask for becomes the file itself.
      fs.copyFileSync(path.join(from, name), path.join(OUT_DIR, name));
      if (name === SERVER) fs.chmodSync(path.join(OUT_DIR, name), 0o755);
    }
    const bytes = names.reduce((sum, name) => sum + fs.statSync(path.join(OUT_DIR, name)).size, 0);
    fs.writeFileSync(path.join(OUT_DIR, 'build.json'), JSON.stringify({ tag: TAG, platform: key, file: release.file, sha256: release.sha256, files: names.length, bytes }, null, 2) + '\n');
    console.log(`[fetch-llama] ${path.relative(ROOT, OUT_DIR)}: ${names.length} file, ${(bytes / 1048576).toFixed(1)} MB (${TAG})`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`[fetch-llama] ${error.message}`);
  process.exit(1);
});
