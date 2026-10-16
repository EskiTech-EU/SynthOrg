'use strict';
// Removes from `data/` what no code of the app reads or writes any more: files left by versions before and by
// tests that used to write there (they now work in folders of their own: server/paths.js). The app closed.
// What belongs to a chat or a project that is no longer there is not this script's: the app removes it by itself
// when it starts (server/tidy.js).
//
//   node scripts/clean-dev-leftovers.js          shows what would be removed
//   node scripts/clean-dev-leftovers.js --do     removes it
const fs = require('node:fs');
const path = require('node:path');

const DATA = path.resolve(__dirname, '..', 'data');
const really = process.argv.includes('--do');
const sizeOf = full => { let n = 0; const walk = p => { let s; try { s = fs.lstatSync(p); } catch { return; } if (s.isDirectory()) for (const x of fs.readdirSync(p)) walk(path.join(p, x)); else n += s.size; }; walk(full); return n; };

const found = [];
for (const name of fs.existsSync(DATA) ? fs.readdirSync(DATA) : []) {
  // Databases and folders of the packages test, one per run.
  if (/^test-pkg-db-\d+\.sqlite(-wal|-shm)?$/.test(name) || /^test-packages-\d+$/.test(name)) found.push(name);
  // The database under its first name, the browser profile of the first web search, the data of the photo
  // editor when it was a program of its own.
  else if (['synthorg.db', 'synthorg.db-shm', 'synthorg.db-wal', 'app_profile', 'photocraft', 'photo-scratch'].includes(name)) found.push(name);
  // The projects' folders of the first versions: only if nothing but empty folders is in it.
  else if (name === 'projects' && sizeOf(path.join(DATA, name)) === 0) found.push(name);
}
let bytes = 0;
for (const name of found) {
  const full = path.join(DATA, name);
  bytes += sizeOf(full);
  if (really) fs.rmSync(full, { recursive: true, force: true, maxRetries: 5 });
}
const tests = found.filter(name => name.startsWith('test-')).length;
console.log(`${really ? 'Rimossi' : 'Da rimuovere'}: ${found.length} voci (${tests} delle prove), ${(bytes / 1048576).toFixed(1)} MB.`);
for (const name of found.filter(name => !name.startsWith('test-'))) console.log(`  ${name}`);
if (!really && found.length) console.log('Per rimuoverle: node scripts/clean-dev-leftovers.js --do');
