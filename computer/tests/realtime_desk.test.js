'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// The workspaces of this file's chats are in a folder of their own, made before the server is read.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-desk-'));
process.env.SYNTHORG_DATA_DIR = DATA;
const { Store } = require('../server/database');
const { createApp } = require('../server');
const { workspaceLink } = require('../server/personal');
const D = require('../resources/js/realtime-desk.js');

function setup(t) { const store = new Store(':memory:'); t.after(() => store.close()); return store; }
const link = (name, chat = 'c1') => `/api/conversations/${chat}/sandbox/files/${name}`;

/* ------------------------------------------------------------------ */
/* What is kept of the files handed                                     */
/* ------------------------------------------------------------------ */

test('a file handed is kept with its link as it is stored; only a link into a chat\'s workspace is one', t => {
  const p = setup(t).personal();
  const photo = p.handFile({ kind: 'image', url: link('scarpe_1.png'), filename: 'scarpe_1.png', title: 'Air Jordan 13', description: 'Su fondo nero', task: 'Genera un\'immagine' });
  assert.deepEqual([photo.kind, photo.title, photo.url, photo.seen_at], ['image', 'Air Jordan 13', link('scarpe_1.png'), null]);
  const old = p.handFile({ kind: 'document', url: `http://127.0.0.1:4319${link('r%20x.pdf')}` });
  assert.deepEqual([old.url, old.filename, old.title], [link('r%20x.pdf'), 'r x.pdf', 'r x.pdf'], 'the origin an older version wrote is left out; the name comes from the link');
  assert.equal(workspaceLink(link('a/b/c.md')), link('a/b/c.md'));
  for (const bad of ['https://example.com/a.png', '/api/conversations/c1/messages', link('..%2F..%2Fsecret.txt'), link('a/../b.txt'), link('a.png?download=1'), '', null]) {
    assert.equal(workspaceLink(bad), null, String(bad));
    assert.throws(() => p.handFile({ kind: 'image', url: bad }), /workspace/);
  }
  assert.throws(() => p.handFile({ kind: 'archive', url: link('a.zip') }), /Tipo di file/);
});

test('the same file handed again is the same one, new again', t => {
  const p = setup(t).personal();
  const first = p.handFile({ kind: 'document', url: link('nota.md'), title: 'Nota' });
  p.seeFile(first.id);
  assert.ok(p.handedFile(first.id).seen_at);
  const again = p.handFile({ kind: 'document', url: link('nota.md'), title: 'Nota, seconda stesura' });
  assert.deepEqual([again.id, again.title, again.seen_at], [first.id, 'Nota, seconda stesura', null]);
  assert.equal(p.handedFiles().files.length, 1);
});

test('they are read a page at a time, the latest first, by words and by kind', t => {
  const p = setup(t).personal();
  const at = (minute) => new Date(Date.UTC(2026, 8, 28, 10, minute)).toISOString();
  for (let i = 0; i < 35; i++) p.handFile({ kind: i % 5 === 0 ? 'audio' : 'image', url: link(`f${i}.png`), title: `Disegno ${i}`, task: i === 7 ? 'il logo del sito' : '', at: at(i), seen: i < 30 });
  const page = p.handedFiles({ limit: 30 });
  assert.deepEqual([page.files.length, page.more, page.unseen, page.files[0].title], [30, true, 5, 'Disegno 34']);
  const rest = p.handedFiles({ limit: 30, before: page.files[29].at });
  assert.deepEqual([rest.files.length, rest.more, rest.files[4].title], [5, false, 'Disegno 0']);
  assert.deepEqual(p.handedFiles({ query: 'LOGO sito' }).files.map(f => f.title), ['Disegno 7']);
  assert.equal(p.handedFiles({ kind: 'audio', limit: 100 }).files.length, 7);
  assert.equal(p.handedFiles({ query: '100%' }).files.length, 0, 'a sign of the search is a letter like the others');
  assert.ok(p.handedFile(page.files[0].id).seen_at === null && p.handedFile(rest.files[0].id).seen_at, 'what was made before is handed as seen');
});

test('a file taken out of the ones handed is no longer among them', t => {
  const p = setup(t).personal();
  const file = p.handFile({ kind: 'video', url: link('clip.mp4') });
  p.dropFile(file.id);
  assert.equal(p.handedFiles().files.length, 0);
  assert.throws(() => p.dropFile(file.id), /non trovato/);
  assert.throws(() => p.seeFile('nobody'), /non trovato/);
});

/* ------------------------------------------------------------------ */
/* The server: only files that are there                                 */
/* ------------------------------------------------------------------ */

test('over the network a file is handed only when it is in its workspace, and goes when it is no longer there', async t => {
  const data = DATA;
  const { server } = createApp({ token: 'secret', dbPath: ':memory:', githubPort: 0, sandbox: { async stopAllContainers() { return { success: true, count: 0 }; }, async deleteWorkspace() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(() => { try { fs.rmSync(data, { recursive: true, force: true }); } catch {} resolve(); }); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const chat = (await call('POST', '/conversations', { title: 'Compiti' })).body;
  const ws = path.join(data, 'sandboxes', chat.id, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'nota.md'), '# Nota');
  const handed = await call('POST', '/handed', { kind: 'document', url: link('nota.md', chat.id), title: 'Nota' });
  assert.equal(handed.status, 200);
  assert.equal((await call('POST', '/handed', { kind: 'document', url: link('manca.md', chat.id) })).status, 404);
  assert.equal((await call('GET', '/handed')).body.files.length, 1);
  assert.ok((await call('PUT', `/handed/${handed.body.id}`, {})).body.seen_at);
  fs.rmSync(path.join(ws, 'nota.md'));
  assert.deepEqual((await call('GET', '/handed')).body.files, []);
});

/* ------------------------------------------------------------------ */
/* The numbers of the page                                               */
/* ------------------------------------------------------------------ */

test('what comes out of the machine: a sheet, a photo, a disc', () => {
  assert.deepEqual(['document', 'image', 'audio', 'video'].map(D.outOf), ['sheet', 'photo', 'disc', 'disc']);
  assert.ok(D.OUT_MS.sheet > 0 && D.OUT_MS.photo > 0 && D.OUT_MS.disc > 0);
});

test('how a file is looked at goes by its kind, then by its name', () => {
  const view = (kind, filename) => D.viewOf({ kind, filename });
  assert.equal(view('image', 'a.png'), 'image');
  assert.equal(view('audio', 'a.wav'), 'audio');
  assert.equal(view('document', 'Relazione.PDF'), 'pdf');
  assert.equal(view('document', 'note.md'), 'markdown');
  assert.equal(view('document', 'dati.csv'), 'table');
  assert.equal(view('document', 'moltiplicazione_assembly.asm'), 'text');
  assert.equal(view('document', 'bilancio.xlsx'), 'none');
  assert.deepEqual(['a.pdf', 'b.markdown', 'c', 'd.tar.gz'].map(D.badgeOf), ['PDF', 'MARK', '', 'GZ']);
});

test('a part of the drawing is found on the page, whatever size the drawing has there', () => {
  const half = D.onPage(D.SHEET, { left: 800, top: 300, width: D.VIEW.width / 2, height: D.VIEW.height / 2 });
  assert.deepEqual(half, { left: 800 + D.SHEET.x / 2, top: 300 + D.SHEET.y / 2, width: D.SHEET.width / 2, height: D.SHEET.height / 2 });
  const held = D.carried({ left: 100, top: 200, width: 50, height: 54 });
  assert.ok(held.left > 100 + 25 && held.left < 150, 'at the character\'s side');
  assert.ok(held.top > 200 && held.top < 254 && held.width < 50);
  assert.deepEqual([D.outAt(0), D.outAt(1), D.outAt(2)], [0, 1, 1]);
  assert.ok(D.outAt(0.5) > 0.5, 'fast at first');
});

test('a table is read with the mark its first line has most of, and quotes around a field', () => {
  assert.deepEqual(D.rowsOf('nome;prezzo\n"Air Jordan; 13";"2,2 milioni"\r\n\r\nYeezy;1,8\n').rows,
    [['nome', 'prezzo'], ['Air Jordan; 13', '2,2 milioni'], ['Yeezy', '1,8']]);
  assert.deepEqual(D.rowsOf('a,b\n"he said ""hi""",2').rows, [['a', 'b'], ['he said "hi"', '2']]);
  assert.deepEqual(D.rowsOf('a\tb\n1\t2').rows, [['a', 'b'], ['1', '2']]);
  const long = D.rowsOf(Array.from({ length: 20 }, (_, i) => `${i},x`).join('\n'), 5);
  assert.deepEqual([long.rows.length, long.more], [5, true]);
  assert.deepEqual(D.rowsOf(''), { rows: [], more: false });
});

test('the character is told what was handed and where the user sees it, never a file name', () => {
  const names = { image: 'immagine', document: 'documento' };
  const line = D.handedLine([{ kind: 'image', title: 'Air Jordan 13', filename: 'air_1790.png' }, { kind: 'document', title: '', filename: 'nota.md' }], names);
  assert.match(line, /immagine «Air Jordan 13», documento «nota\.md»/);
  assert.match(line, /qui sotto/);
  assert.doesNotMatch(line, /air_1790|Master|files_show/);
  assert.equal(D.handedLine([], names), '');
});

const made = [
  { id: 'f5', kind: 'document', title: 'Riassunto delle notizie', description: '', task: 'Riassumi le notizie di oggi', filename: 'notizie.md' },
  { id: 'f4', kind: 'image', title: 'Faro al tramonto', description: 'Un faro sulla scogliera', task: 'Genera un\'immagine di un faro', filename: 'faro_22.png' },
  { id: 'f3', kind: 'audio', title: 'Sigla', description: '', task: 'Una sigla di dieci secondi', filename: 'sigla.mp3' },
  { id: 'f2', kind: 'image', title: 'Gatto sul tetto', description: 'Un gatto arancione', task: 'Disegna un gatto', filename: 'gatto_7.png' },
  { id: 'f1', kind: 'document', title: 'Prezzi delle scarpe', description: '', task: 'Cerca i prezzi', filename: 'prezzi.csv' }
];

test('a file asked for again is found by the words said, by their roots, or by its kind', () => {
  const asked = (query, kind = '') => D.fileAsked(made, { query, kind })?.id || null;
  assert.equal(asked('il gatto'), 'f2');
  assert.equal(asked('i gatti arancioni'), 'f2', 'by the roots of the words');
  assert.equal(asked('l\'immagine del faro', 'image'), 'f4');
  assert.equal(asked('quella di prima', 'image'), 'f4', 'none of the words: the latest of the kind');
  assert.equal(asked('', 'audio'), 'f3');
  assert.equal(asked('le notizie', 'image'), 'f4', 'the kind is kept to');
  assert.equal(asked('la relazione trimestrale'), null);
  assert.equal(asked(''), null);
  assert.equal(D.fileAsked([], { query: 'gatto' }), null);
});

test('a task is told the files made before that it may be about: the ones it names and the latest, by their file names', () => {
  const names = { image: 'immagine', document: 'documento', audio: 'audio' };
  assert.deepEqual(D.filesFor('Rendi il gatto più arancione', made).map(file => file.id), ['f5', 'f4', 'f3', 'f2']);
  assert.deepEqual(D.filesFor('Fanne una versione più chiara', made).map(file => file.id), ['f5', 'f4', 'f3'], 'named by none of its words: the latest');
  assert.equal(D.filesFor('Aggiorna le scarpe', made, { latest: 1, most: 2 }).length, 2);
  const line = D.aboutLine(D.filesFor('Rendi il gatto più arancione', made), names);
  assert.match(line, /^\n\n\[File fatti prima, nel workspace:\n- notizie\.md — documento «Riassunto delle notizie»\n/);
  assert.match(line, /- gatto_7\.png — immagine «Gatto sul tetto»\]$/);
  assert.equal(D.aboutLine([], names), '');
  assert.deepEqual(D.filesFor('Un compito', []), []);
});

/* ------------------------------------------------------------------ */
/* The page                                                              */
/* ------------------------------------------------------------------ */

test('the section has its texts in both languages, and the machine makes no character of its own', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const desk = read('resources/js/realtime-desk.js');
  const i18n = read('resources/js/i18n.js');
  const keys = [...new Set([...desk.matchAll(/\bt\(\s*'(realtime\.[a-zA-Z_]+)'/g)].map(m => m[1]))];
  assert.ok(keys.length >= 8);
  for (const kind of ['image', 'video', 'audio', 'document']) keys.push(`realtime.fileKind_${kind}`);
  for (const key of keys) {
    if (key.endsWith('_')) continue;
    assert.equal(i18n.split(`'${key}':`).length - 1, 2, `${key} in both languages`);
  }
  assert.doesNotMatch(desk, /new\s+(window\.)?RealtimePuppet/);
  assert.match(read('resources/index.html'), /realtime-desk\.js/);
});
