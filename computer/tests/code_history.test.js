'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../server/database');
const { ProjectManager } = require('../server/projects');

function tempDir(t, prefix = 'synthorg-history-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function project(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const folder = fs.realpathSync(tempDir(t));
  fs.writeFileSync(path.join(folder, 'app.js'), 'uno\ndue\ntre\n');
  const sandbox = { async ensureProjectContainer() { throw new Error('local only'); }, async removeProjectContainer() { return { removed: true }; } };
  const manager = new ProjectManager({ store: () => store, sandbox, dataDir: tempDir(t, 'synthorg-data-') });
  const created = await manager.create({ kind: 'local', path: folder, name: 'Storico' });
  await manager.open(created.id);
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true }); fs.writeFileSync(path.join(folder, file), text); };
  const save = (options) => manager.gitAction(created.id, 'checkpoint', options, options.source || 'user');
  return { manager, id: created.id, folder, write, save };
}

test('the history reads back as a list of steps: who, what, how much', async t => {
  const { manager, id, write, save } = await project(t);
  write('app.js', 'uno\nDUE\ntre\nquattro\n');
  await save({ source: 'user' });
  write('lib/util.js', 'export const x = 1;\n');
  await manager.gitAction(id, 'checkpoint', { tool: 'write_file' }, 'agent');

  const { commits, more, github } = await manager.history(id);
  assert.equal(more, false);
  assert.equal(github, null, 'no repository, no GitHub column');
  assert.deepEqual(commits.map(c => c.title), ['util.js', 'app.js', 'Stato iniziale del progetto']);
  const [agent, user, first] = commits;
  assert.equal(agent.source, 'agent');
  assert.equal(agent.tool, 'write_file');
  assert.equal(agent.author, 'SynthOrg (modello)');
  assert.equal(user.source, 'user');
  assert.deepEqual([user.files, user.additions, user.deletions], [1, 2, 1]);
  assert.equal(first.parents.length, 0);
  assert.match(agent.short, /^[0-9a-f]{7}$/);

  // Pages: a limit, and whether there is more.
  const page = await manager.history(id, { limit: 2 });
  assert.equal(page.commits.length, 2);
  assert.equal(page.more, true);
  assert.equal((await manager.history(id, { limit: 2, skip: 2 })).commits[0].title, 'Stato iniziale del progetto');
});

test('one step shows each file it changed with its diff, and the first step shows everything as added', async t => {
  const { manager, id, write, save } = await project(t);
  write('app.js', 'uno\nDUE\ntre\n');
  write('nuovo.txt', 'ciao\n');
  await save({ source: 'user', message: 'Sistema app e aggiunge nuovo' });

  const [latest, first] = (await manager.history(id)).commits;
  const step = await manager.historyCommit(id, latest.hash);
  assert.equal(step.title, 'Sistema app e aggiunge nuovo');
  assert.equal(step.body, '', 'the trailers are not the description');
  const byPath = Object.fromEntries(step.files.map(f => [f.path, f]));
  assert.equal(byPath['app.js'].status, 'M');
  assert.deepEqual([byPath['app.js'].additions, byPath['app.js'].deletions], [1, 1]);
  assert.match(byPath['app.js'].hunks, /^@@ .* @@/);
  assert.match(byPath['app.js'].hunks, /^-due$/m);
  assert.match(byPath['app.js'].hunks, /^\+DUE$/m);
  assert.equal(byPath['nuovo.txt'].status, 'A');

  const root = await manager.historyCommit(id, first.short);
  assert.deepEqual(root.files.map(f => [f.path, f.status]), [['app.js', 'A']]);
});

test('the project can be browsed as it was at a step, file by file', async t => {
  const { manager, id, write, save } = await project(t);
  const first = (await manager.history(id)).commits[0].hash;
  write('app.js', 'cambiato\n');
  write('src/a.js', 'a\n');
  await save({ source: 'user' });

  assert.deepEqual((await manager.historyTree(id, first)).files, ['app.js']);
  const later = (await manager.history(id)).commits[0].hash;
  assert.deepEqual((await manager.historyTree(id, later)).files.sort(), ['app.js', 'src/a.js']);
  assert.equal((await manager.historyFile(id, first, 'app.js')).content, 'uno\ndue\ntre\n');
  assert.equal((await manager.historyFile(id, later, 'src/a.js')).content, 'a\n');
  await assert.rejects(manager.historyFile(id, first, 'src/a.js'), error => error.status === 404);
});

test('a file keeps its history across a rename', async t => {
  const { manager, id, folder, write, save } = await project(t);
  write('app.js', 'uno\ndue\ntre\nquattro\n');
  await save({ source: 'user' });
  fs.renameSync(path.join(folder, 'app.js'), path.join(folder, 'main.js'));
  await save({ source: 'user', message: 'Rinomina' });

  const steps = (await manager.history(id, { path: 'main.js' })).commits.map(c => c.title);
  assert.deepEqual(steps, ['Rinomina', 'app.js', 'Stato iniziale del progetto']);
  const renamed = await manager.historyCommit(id, (await manager.history(id)).commits[0].hash);
  assert.deepEqual(renamed.files.map(f => [f.status, f.oldPath, f.path]), [['R', 'app.js', 'main.js']]);
});

test('going back is a step: a file or the whole project returns to a version, and nothing is lost', async t => {
  const { manager, id, folder, write, save } = await project(t);
  const start = (await manager.history(id)).commits[0].hash;
  write('app.js', 'riscritto\n');
  write('extra.txt', 'in piu\n');
  await save({ source: 'user' });
  // Not saved yet: the restore records it before touching anything.
  write('app.js', 'mai salvato\n');

  // One file back.
  const one = await manager.restore(id, { hash: start, path: 'app.js' });
  assert.equal(fs.readFileSync(path.join(folder, 'app.js'), 'utf8'), 'uno\ndue\ntre\n');
  assert.ok(fs.existsSync(path.join(folder, 'extra.txt')), 'the rest stays as it is');
  assert.equal(one.last.message, `Ripristinato app.js alla versione ${start.slice(0, 7)}`);
  const titles = (await manager.history(id)).commits.map(c => c.title);
  assert.deepEqual(titles.slice(0, 2), [`Ripristinato app.js alla versione ${start.slice(0, 7)}`, 'Modifiche prima del ripristino']);
  const unsaved = (await manager.history(id)).commits[1].hash;
  assert.equal((await manager.historyFile(id, unsaved, 'app.js')).content, 'mai salvato\n', 'what was there is still in the history');

  // The whole project back: files added since go away, and it is one more step.
  const all = await manager.restore(id, { hash: start });
  assert.ok(!fs.existsSync(path.join(folder, 'extra.txt')));
  assert.equal(all.last.message, `Progetto riportato alla versione ${start.slice(0, 7)}`);
  assert.equal(all.changes, 0);

  // A file that did not exist at that step is taken away when restored there.
  write('tardi.txt', 'x\n');
  await save({ source: 'user' });
  await manager.restore(id, { hash: start, path: 'tardi.txt' });
  assert.ok(!fs.existsSync(path.join(folder, 'tardi.txt')));
});

test('versions and paths are checked before git sees them', async t => {
  const { manager, id } = await project(t);
  for (const bad of ['', 'HEAD', '--all', 'abc', 'zzzzzzz', '1234567;rm']) {
    await assert.rejects(manager.historyCommit(id, bad), error => error.status === 400, bad);
  }
  const hash = (await manager.history(id)).commits[0].hash;
  for (const bad of ['../fuori', '/etc/passwd', '-x', 'a//b', 'a/../b', '']) {
    await assert.rejects(manager.historyFile(id, hash, bad), error => error.status === 400, bad);
  }
  await assert.rejects(manager.restore(id, { hash: 'f'.repeat(40) }), error => error.status === 404);
});
