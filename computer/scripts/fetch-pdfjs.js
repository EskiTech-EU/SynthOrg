'use strict';
// Downloads pdf.js, which draws the Studio's typeset pages in the page itself:
// the PDF never leaves the app and no system viewer is involved. Taken from
// the npm registry at a pinned version and checked against the package's
// published integrity, then only the two built files are kept.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const VERSION = '6.4.299';
const INTEGRITY = 'sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==';
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'resources', 'vendor', 'pdfjs');
const FILES = ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'LICENSE'];

async function main() {
  const stampFile = path.join(OUT_DIR, 'build.json');
  try {
    const stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
    if (stamp.version === VERSION && FILES.every(file => fs.existsSync(path.join(OUT_DIR, path.basename(file)))) && !process.env.SYNTHORG_FORCE_PDFJS_FETCH) {
      console.log(`[fetch-pdfjs] gia presente: ${path.relative(ROOT, OUT_DIR)} (${VERSION})`);
      return;
    }
  } catch {}
  const url = `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-${VERSION}.tgz`;
  console.log(`[fetch-pdfjs] scarico ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download non riuscito (${response.status}) da ${url}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = 'sha512-' + createHash('sha512').update(archive).digest('base64');
  if (digest !== INTEGRITY) throw new Error(`integrity diversa da quella pubblicata: ${digest}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-pdfjs-'));
  const archivePath = path.join(work, 'pdfjs.tgz');
  fs.writeFileSync(archivePath, archive);
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xzf', archivePath, '-C', work], { stdio: 'inherit' });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const file of FILES) {
    const source = path.join(work, 'package', ...file.split('/'));
    if (!fs.existsSync(source)) throw new Error(`File non trovato nel pacchetto: ${file}`);
    fs.copyFileSync(source, path.join(OUT_DIR, path.basename(file)));
  }
  fs.rmSync(work, { recursive: true, force: true });
  fs.writeFileSync(stampFile, JSON.stringify({ version: VERSION, integrity: INTEGRITY }, null, 2));
  console.log(`[fetch-pdfjs] ${path.relative(ROOT, OUT_DIR)} (${VERSION})`);
}

main().catch(error => {
  console.error(`[fetch-pdfjs] ${error.message}`);
  process.exit(1);
});
