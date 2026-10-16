'use strict';
/**
 * The interface of the phone app: the same files as the computer's
 * (computer/resources), copied before every build into android/ui.
 *
 * Only what the phone shows is copied: the Code editor's workbench stays on
 * the computer. The fonts the computer takes from Google are replaced by the
 * copies in android/fonts, so the phone asks nothing of anyone outside the
 * bridge.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.resolve(ROOT, '..', 'computer', 'resources');
const TARGET = path.join(ROOT, 'ui');

const COPIED = ['index.html', 'styles.css', 'favicon.ico', 'js', 'icons', path.join('vendor', 'fontawesome', 'css'), path.join('vendor', 'fontawesome', 'webfonts')];

function copy(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name));
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

fs.rmSync(TARGET, { recursive: true, force: true });
for (const item of COPIED) copy(path.join(SOURCE, item), path.join(TARGET, item));
copy(path.join(ROOT, 'fonts'), path.join(TARGET, 'fonts'));

const indexPath = path.join(TARGET, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
const before = html;
html = html.replace(/\s*<link[^>]+fonts\.(googleapis|gstatic)\.com[^>]*>/g, '');
html = html.replace(/\s*<link rel="manifest"[^>]*>/, '');
html = html.replace('<link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css">', '<link rel="stylesheet" href="/fonts/fonts.css">\n  <link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css">');
if (html === before || /fonts\.googleapis/.test(html)) throw new Error('index.html non ha la forma attesa: controllare i collegamenti ai font.');
// An app, not a web page: the screen does not zoom with two fingers or a double tap.
const zoomable = html;
html = html.replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">');
if (html === zoomable) throw new Error('index.html non ha la forma attesa: manca il meta viewport.');
fs.writeFileSync(indexPath, html);

let total = 0;
const count = (dir) => { for (const name of fs.readdirSync(dir)) { const p = path.join(dir, name); const s = fs.statSync(p); if (s.isDirectory()) count(p); else total += s.size; } };
count(TARGET);
console.log(`Interfaccia del telefono in ${path.relative(process.cwd(), TARGET) || TARGET}: ${(total / 1048576).toFixed(1)} MB`);
