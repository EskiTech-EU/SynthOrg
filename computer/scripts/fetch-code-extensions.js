'use strict';
// Only the compiled MIT built-in extensions are extracted, never the editor or
// Electron runtime. This matches the workbench's advertised VS Code 1.110 API.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const version = '1.110.11631';
const archiveName = `VSCodium-win32-x64-${version}.zip`;
const url = `https://github.com/VSCodium/vscodium/releases/download/${version}/${archiveName}`;
const digest = '158c35d1a229d3c9e5c203f68c9df1c33728c9e38ee73fb8daa0081f9e4224eb';
const destination = path.join(root, 'vendor', 'sidex', 'extensions');
const cache = path.join(root, '.tmp', archiveName);
const marker = path.join(destination, '.synthorg-source.json');
const notices = path.join(root, 'vendor', 'sidex', 'licenses', 'vscodium');
const tar = process.platform === 'linux' ? 'bsdtar' : 'tar';
// Built-in extensions SynthOrg does not ship. They either duplicate what the
// app already does on its own (GitHub, accounts, AI chat, browser) or depend on
// VS Code services the SideX workbench does not provide (tunnels, extension and
// settings authoring, remote browser launch).
const excluded = [
  'github', 'github-authentication', 'microsoft-authentication',
  'git', // SideX uses its own Rust git provider; git-base keeps the grammars.
  'mermaid-chat-features', 'prompt-basics',
  'simple-browser', 'tunnel-forwarding',
  'extension-editing', 'configuration-editing',
  'ms-vscode.js-debug-companion',
];

function prune() {
  for (const name of excluded) {
    const target = path.join(destination, name);
    if (path.dirname(target) !== destination) throw new Error('Invalid extension name');
    fs.rmSync(target, { recursive: true, force: true });
  }
}

async function main() {
  if (fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker)).sha256 === digest
      && fs.existsSync(path.join(notices, 'ThirdPartyNotices.txt'))) { prune(); return; }
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  if (!fs.existsSync(cache)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Extension download failed: HTTP ${response.status}`);
    fs.writeFileSync(cache, Buffer.from(await response.arrayBuffer()));
  }
  if (createHash('sha256').update(fs.readFileSync(cache)).digest('hex') !== digest) {
    throw new Error('Extension archive checksum mismatch');
  }
  const listing = spawnSync(tar, ['-tf', cache], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, windowsHide: true });
  if (listing.status !== 0) throw new Error(listing.stderr || 'Cannot read extension archive');
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  const extensionRoot = 'resources/app/extensions/';
  if (!entries.some(entry => entry.startsWith(extensionRoot))) throw new Error('Archive has no built-in extensions');
  if (entries.some(entry => entry.startsWith('/') || entry.split('/').includes('..'))) throw new Error('Unsafe archive path');
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync(tar, ['-xf', cache, '-C', destination,
    '--strip-components', String(extensionRoot.split('/').filter(Boolean).length), extensionRoot + '*'],
    { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || 'Extension extraction failed');
  prune();
  fs.mkdirSync(notices, { recursive: true });
  const licenseResult = spawnSync(tar, ['-xf', cache, '-C', notices, '--strip-components', '2',
    'resources/app/LICENSE.txt', 'resources/app/ThirdPartyNotices.txt'], { encoding: 'utf8', windowsHide: true });
  if (licenseResult.status !== 0) throw new Error(licenseResult.stderr || 'Cannot extract extension notices');
  // Match SideX's native Git provider. No account or agent extensions are loaded.
  fs.writeFileSync(marker, JSON.stringify({ url, sha256: digest, version }, null, 2) + '\n');
  console.log(`Built-in extensions prepared from VSCodium ${version}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
