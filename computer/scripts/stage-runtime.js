'use strict';
// Stages the production dependency closure for bundling.
//
// The app ships its Node storage service, so the bundle needs node_modules —
// but not the build toolchain. npm's flat layout makes "everything except
// devDependencies" impossible to express as a glob, so the closure is read off
// package-lock.json, which already marks dev-only entries.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STAGE = path.join(ROOT, 'src-tauri', 'runtime');

const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
if (!lock.packages) throw new Error('package-lock.json in un formato non supportato (serve lockfileVersion >= 2).');

const runtime = Object.entries(lock.packages)
  .filter(([location, entry]) => location.includes('node_modules/') && !entry.dev && !entry.devOptional)
  .map(([location]) => location);

if (!runtime.length) throw new Error('Nessuna dipendenza di produzione risolta: esegui prima "npm install".');

fs.rmSync(STAGE, { recursive: true, force: true });
let copied = 0;
for (const location of runtime) {
  const source = path.join(ROOT, location);
  if (!fs.existsSync(source)) throw new Error(`Dipendenza mancante: ${location}. Esegui "npm ci".`);
  fs.cpSync(source, path.join(STAGE, location), { recursive: true, dereference: true });
  copied += 1;
}
console.log(`[stage-runtime] ${copied} pacchetti copiati in ${path.relative(ROOT, STAGE)}`);
