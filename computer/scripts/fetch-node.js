'use strict';
// Downloads the Node runtime that ships inside the application.
//
// The app runs its storage service on Node, and an end user must not have to
// install anything: the binary is bundled as a Tauri external binary, named
// with the Rust target triple as Tauri expects, and placed next to the
// executable at install time.
//
// Run it for the host platform (`npm run fetch-node`). Each platform's build
// fetches its own binary; there is no cross-download.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const NODE_VERSION = process.env.SYNTHORG_NODE_VERSION || 'v24.14.0';
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'src-tauri', 'binaries');

const TARGETS = {
  'win32-x64': { dist: 'win-x64', archive: 'zip', triple: 'x86_64-pc-windows-msvc', binary: 'node.exe' },
  'darwin-x64': { dist: 'darwin-x64', archive: 'tar.gz', triple: 'x86_64-apple-darwin', binary: 'bin/node' },
  'darwin-arm64': { dist: 'darwin-arm64', archive: 'tar.gz', triple: 'aarch64-apple-darwin', binary: 'bin/node' },
  'linux-x64': { dist: 'linux-x64', archive: 'tar.gz', triple: 'x86_64-unknown-linux-gnu', binary: 'bin/node' },
  'linux-arm64': { dist: 'linux-arm64', archive: 'tar.gz', triple: 'aarch64-unknown-linux-gnu', binary: 'bin/node' }
};

async function main() {
  const key = `${process.platform}-${process.arch}`;
  const target = TARGETS[key];
  if (!target) throw new Error(`Piattaforma non supportata per il bundling di Node: ${key}.`);

  const suffix = process.platform === 'win32' ? '.exe' : '';
  const destination = path.join(OUT_DIR, `synthorg-node-${target.triple}${suffix}`);
  if (fs.existsSync(destination) && !process.env.SYNTHORG_FORCE_NODE_FETCH) {
    console.log(`[fetch-node] gia presente: ${path.relative(ROOT, destination)}`);
    return;
  }

  const name = `node-${NODE_VERSION}-${target.dist}`;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${name}.${target.archive}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-node-'));
  const archivePath = path.join(work, `${name}.${target.archive}`);

  console.log(`[fetch-node] scarico ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download non riuscito (${response.status}) da ${url}`);
  fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));

  // bsdtar on Windows and GNU tar elsewhere both read zip and tar.gz. The
  // Windows one is named explicitly: a POSIX tar earlier on PATH reads
  // "C:\..." as a remote host and fails.
  const tar = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  execFileSync(tar, ['-xf', archivePath, '-C', work], { stdio: 'inherit' });

  const extracted = path.join(work, name, ...target.binary.split('/'));
  if (!fs.existsSync(extracted)) throw new Error(`Binario non trovato nell'archivio: ${extracted}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(extracted, destination);
  if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
  fs.rmSync(work, { recursive: true, force: true });

  const megabytes = (fs.statSync(destination).size / 1048576).toFixed(0);
  console.log(`[fetch-node] ${path.relative(ROOT, destination)} (${megabytes} MB, ${NODE_VERSION})`);
}

main().catch(error => {
  console.error(`[fetch-node] ${error.message}`);
  process.exit(1);
});
