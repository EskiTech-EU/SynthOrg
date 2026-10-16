'use strict';
// Downloads the LaTeX engine the Studio section compiles with: Tectonic, a
// single static binary for Alpine (musl), checked against the sha256 its
// release publishes. It never runs on this machine: it is copied into the
// container image the Studio uses, like the Code editor is
// (server/sandbox.js, ensureStudioImage). The TeX packages it needs are not
// here: they are fetched once from the bundle by a container made for that
// (the same inert channel the chats' libraries pass through) and kept in an
// engine volume, so the compile itself runs without the network.
//
// Run `npm run fetch-tectonic`. Only the host's architecture is fetched (the
// container's is the host's), as fetch-node does: 26 MB a copy, and no build
// needs the other one.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const VERSION = '0.17.0';
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tectonic-bin');

/** Published with the release (asset digests of tectonic@0.17.0). */
const RELEASES = {
  x86_64: { file: `tectonic-${VERSION}-x86_64-unknown-linux-musl.tar.gz`, sha256: '8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7' },
  aarch64: { file: `tectonic-${VERSION}-aarch64-unknown-linux-musl.tar.gz`, sha256: 'b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8' }
};
const BASE = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VERSION}/`;

async function fetchOne(arch) {
  const release = RELEASES[arch];
  const destination = path.join(OUT_DIR, `tectonic-${arch}`);
  if (fs.existsSync(destination) && !process.env.SYNTHORG_FORCE_TECTONIC_FETCH) {
    const stamp = readStamp();
    if (stamp && stamp.version === VERSION && stamp[arch] === release.sha256) {
      console.log(`[fetch-tectonic] gia presente: ${path.relative(ROOT, destination)}`);
      return;
    }
  }
  const url = BASE + release.file;
  console.log(`[fetch-tectonic] scarico ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download non riuscito (${response.status}) da ${url}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== release.sha256) throw new Error(`sha256 diverso da quello pubblicato per ${release.file}: ${digest}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-tectonic-'));
  const archivePath = path.join(work, release.file);
  fs.writeFileSync(archivePath, archive);
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', archivePath, '-C', work], { stdio: 'inherit' });
  const extracted = path.join(work, 'tectonic');
  if (!fs.existsSync(extracted)) throw new Error(`Binario non trovato nell'archivio: ${extracted}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(extracted, destination);
  fs.rmSync(work, { recursive: true, force: true });
  const stamp = readStamp() || {};
  fs.writeFileSync(path.join(OUT_DIR, 'build.json'), JSON.stringify({ ...stamp, version: VERSION, [arch]: release.sha256 }, null, 2));
  console.log(`[fetch-tectonic] ${path.relative(ROOT, destination)} (${(archive.length / 1048576).toFixed(1)} MB compresso, ${VERSION})`);
}

function readStamp() {
  try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'build.json'), 'utf8')); } catch { return null; }
}

async function main() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  await fetchOne(arch);
}

main().catch(error => {
  console.error(`[fetch-tectonic] ${error.message}`);
  process.exit(1);
});
