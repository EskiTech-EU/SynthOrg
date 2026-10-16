'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The uninstaller is told where the memory is through the registry: not from a test.
process.env.SYNTHORG_NO_REGISTRY = '1';
const memory = require('../server/memory');

function tempDir(t, prefix = 'synthorg-memory-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

/** A data folder as the app leaves it: the memory, and what is not memory beside it. */
function dataFolder(t) {
  const data = tempDir(t, 'synthorg-data-');
  fs.writeFileSync(path.join(data, 'synthorg.sqlite'), 'database');
  fs.writeFileSync(path.join(data, 'synthorg.sqlite-wal'), 'wal');
  fs.mkdirSync(path.join(data, 'artifacts', 'p1', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(data, 'artifacts', 'p1', 'a.pcraft'), Buffer.alloc(300000, 7));
  fs.writeFileSync(path.join(data, 'artifacts', 'p1', 'sub', 'b.png'), 'png');
  fs.mkdirSync(path.join(data, 'models'));
  fs.writeFileSync(path.join(data, 'models', 'grande.gguf'), 'pesi');
  fs.mkdirSync(path.join(data, 'sandboxes', 'c1'), { recursive: true });
  fs.writeFileSync(path.join(data, 'sandboxes', 'c1', 'x.txt'), 'lavoro');
  return data;
}
const tree = dir => { const out = []; const walk = (full, rel) => { for (const name of fs.readdirSync(full)) { const next = path.join(full, name); if (fs.statSync(next).isDirectory()) walk(next, `${rel}${name}/`); else out.push(rel + name); } }; walk(dir, ''); return out.sort(); };

test('the memory is beside the app until it is put elsewhere, and a folder that is picked is never used as it is', t => {
  const data = dataFolder(t);
  assert.deepEqual(memory.locate(data), { dir: data, home: true, missing: false });
  assert.equal(memory.memoryDir(data), data);
  const first = memory.status(data);
  assert.equal(first.bytes, 8 + 3 + 300000 + 3);
  assert.equal(first.moveTo, null);

  const disk = tempDir(t, 'synthorg-disk-');
  fs.writeFileSync(path.join(disk, 'le mie foto.txt'), 'non toccare');
  const asked = memory.plan(disk, data);
  assert.equal(asked.moveTo, path.join(disk, memory.FOLDER));
  // Asked, not done: the database is open.
  assert.equal(memory.memoryDir(data), data);
  assert.ok(!fs.existsSync(path.join(disk, memory.FOLDER)));
  // Taken back.
  assert.equal(memory.cancel(data).moveTo, null);
  assert.ok(!fs.existsSync(path.join(data, memory.POINTER)));

  // Refused: not a folder, not there, inside the app's own folder, no path.
  assert.throws(() => memory.plan('relativa', data), /percorso completo/);
  assert.throws(() => memory.plan(path.join(disk, 'manca'), data), /non esiste/);
  assert.throws(() => memory.plan(path.join(disk, 'le mie foto.txt'), data), /non è una cartella/);
  assert.throws(() => memory.plan(path.join(data, 'models'), data), /c’è già/);
  // Refused: a memory folder already there with something in it.
  fs.mkdirSync(path.join(disk, memory.FOLDER));
  fs.writeFileSync(path.join(disk, memory.FOLDER, 'synthorg.sqlite'), 'un altro');
  assert.throws(() => memory.plan(disk, data), /c'è già una cartella/);
});

test('moved when the app starts: copied, checked, used; the originals go last and what is not memory stays', t => {
  const data = dataFolder(t);
  const disk = tempDir(t, 'synthorg-disk-');
  fs.writeFileSync(path.join(disk, 'le mie foto.txt'), 'non toccare');
  memory.plan(disk, data);
  const done = memory.settle(data);
  const target = path.join(disk, memory.FOLDER);
  assert.deepEqual([done.dir, done.home, done.moved], [target, false, true]);
  assert.equal(memory.memoryDir(data), target);
  assert.deepEqual(tree(target), [memory.MARK, 'artifacts/p1/a.pcraft', 'artifacts/p1/sub/b.png', 'synthorg.sqlite', 'synthorg.sqlite-wal']);
  assert.equal(fs.readFileSync(path.join(target, 'synthorg.sqlite'), 'utf8'), 'database');
  // Beside the app: what makes it run, and where the memory is. Nothing of the memory.
  assert.deepEqual(tree(data), [memory.POINTER, 'models/grande.gguf', 'sandboxes/c1/x.txt']);
  // What else was in the folder picked is as it was.
  assert.equal(fs.readFileSync(path.join(disk, 'le mie foto.txt'), 'utf8'), 'non toccare');
  // Started again: nothing to do.
  assert.equal(memory.settle(data).moved, undefined);

  // The disk is not there: never an empty memory in its place.
  fs.renameSync(target, path.join(disk, 'via'));
  assert.equal(memory.locate(data).missing, true);
  assert.throws(() => memory.memoryDir(data), /non è raggiungibile/);
  assert.throws(() => memory.plan(null, data), /ricollegata/);
  assert.ok(!fs.existsSync(path.join(data, 'synthorg.sqlite')));
  fs.renameSync(path.join(disk, 'via'), target);

  // To another place, and then back beside the app.
  const nas = tempDir(t, 'synthorg-nas-');
  memory.plan(nas, data);
  assert.equal(memory.settle(data).dir, path.join(nas, memory.FOLDER));
  assert.ok(!fs.existsSync(target), 'la cartella di prima, vuota, se ne va');
  assert.equal(memory.plan(null, data).moveTo, data);
  const back = memory.settle(data);
  assert.deepEqual([back.dir, back.home, back.moved], [data, true, true]);
  assert.deepEqual(tree(data), ['artifacts/p1/a.pcraft', 'artifacts/p1/sub/b.png', 'models/grande.gguf', 'sandboxes/c1/x.txt', 'synthorg.sqlite', 'synthorg.sqlite-wal']);
  assert.ok(!fs.existsSync(path.join(nas, memory.FOLDER)));
});

test('a move that cannot be finished leaves the memory where it was, and says why', t => {
  const data = dataFolder(t);
  const disk = tempDir(t, 'synthorg-disk-');
  memory.plan(disk, data);
  // Something takes the place of a file of the memory in the destination, after it was asked for.
  const target = path.join(disk, memory.FOLDER);
  fs.mkdirSync(path.join(target, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(target, 'artifacts', 'di-qualcun-altro.txt'), 'x');
  const done = memory.settle(data);
  assert.match(done.error, /c'è già «artifacts»/);
  assert.deepEqual([done.dir, done.home], [data, true]);
  assert.equal(memory.memoryDir(data), data);
  assert.equal(fs.readFileSync(path.join(data, 'synthorg.sqlite'), 'utf8'), 'database');
  assert.ok(fs.existsSync(path.join(data, 'artifacts', 'p1', 'a.pcraft')));
  // What was already copied is taken away; what was there before is not touched.
  assert.deepEqual(tree(target), ['artifacts/di-qualcun-altro.txt']);
  // Not tried again by itself; the settings show the reason until another place is asked for.
  const state = memory.status(data);
  assert.equal(state.moveTo, null);
  assert.match(state.error, /non riuscito/);
  assert.equal(memory.settle(data).moved, undefined);
});
