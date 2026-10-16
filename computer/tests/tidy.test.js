'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../server/database');
const { Tidy } = require('../server/tidy');
const { ProjectManager } = require('../server/projects');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}
const put = (file, body = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const there = (...parts) => fs.existsSync(path.join(...parts));

function world(t, { elsewhere = false, plainCopy = true } = {}) {
  const data = tempDir(t, 'synthorg-tidy-data-');
  const memory = elsewhere ? tempDir(t, 'synthorg-tidy-memory-') : data;
  const store = new Store(':memory:');
  t.after(() => store.close());
  const tidy = new Tidy({ dataDir: data, memoryDir: () => memory, store: () => store, plainCopy: () => plainCopy });
  tidy.delayMs = 30;
  t.after(() => tidy.unwatch());
  return { data, memory, store, tidy };
}

test('folders and settings of chats and projects that are no longer there are removed, the others are left', t => {
  const { data, memory, store, tidy } = world(t);
  const chat = store.createConversation('Resta');
  const gone = '11111111-2222-3333-4444-555555555555';
  const project = '99999999-2222-3333-4444-555555555555';
  put(path.join(data, 'sandboxes', chat.id, 'workspace', 'nota.txt'));
  put(path.join(data, 'sandboxes', gone, 'workspace', 'vecchio.txt'));
  put(path.join(memory, 'artifacts', project, 'a.psd'));
  put(path.join(memory, 'studio', project, 'libro.pdf'));
  put(path.join(memory, 'pod-projects', `${project}.git`, 'HEAD'));
  put(path.join(memory, 'models', 'm.gguf'));
  store.setSetting(`plan_${chat.id}`, '{}');
  store.setSetting(`plan_${gone}`, '{}');
  store.setSetting(`plan_mode_${project}`, 'auto');
  store.setSetting('plan_default', 'x');
  const done = tidy.run();
  assert.deepEqual([done.chatFolders, done.projectFolders, done.settings], [1, 3, 3]);
  assert.ok(there(data, 'sandboxes', chat.id, 'workspace', 'nota.txt'));
  assert.ok(!there(data, 'sandboxes', gone));
  assert.ok(!there(memory, 'artifacts', project) && !there(memory, 'studio', project) && !there(memory, 'pod-projects', `${project}.git`));
  assert.ok(there(memory, 'models', 'm.gguf'), 'ciò che non porta il nome di una chat o di un progetto non si tocca');
  assert.equal(store.getSetting(`plan_${chat.id}`), '{}');
  assert.equal(store.getSetting(`plan_${gone}`), null);
  // Beside the app there is one folder: no copy of the chats' files.
  assert.ok(!there(memory, 'chat-files'));
  // A second pass finds nothing to do.
  assert.deepEqual(Object.values(tidy.run()).reduce((a, b) => a + b, 0), 0);
});

test('with the archive locked nothing is touched', t => {
  const data = tempDir(t, 'synthorg-tidy-data-');
  put(path.join(data, 'sandboxes', 'abc', 'workspace', 'f.txt'));
  const tidy = new Tidy({ dataDir: data, memoryDir: () => data, store: () => null });
  tidy.run();
  assert.ok(there(data, 'sandboxes', 'abc', 'workspace', 'f.txt'));
});

test('with the memory elsewhere the chats’ files are copied there as they change, and come back when the working folder is lost', async t => {
  const { data, memory, store, tidy } = world(t, { elsewhere: true });
  const chat = store.createConversation('Con file');
  const work = path.join(data, 'sandboxes', chat.id, 'workspace');
  put(path.join(work, 'dati', 'tabella.csv'), 'a,b\n1,2\n');
  put(path.join(work, 'grafico.png'), Buffer.alloc(4096, 7));
  assert.equal(tidy.run().copied, 2);
  const copy = path.join(memory, 'chat-files', chat.id);
  assert.equal(fs.readFileSync(path.join(copy, 'dati', 'tabella.csv'), 'utf8'), 'a,b\n1,2\n');
  assert.equal(tidy.run().copied, 0, 'ciò che è già uguale non si ricopia');

  // Followed: written, changed, removed in the working folder — the same in the memory a moment later.
  tidy.watch();
  put(path.join(work, 'nuovo.txt'), 'uno');
  fs.writeFileSync(path.join(work, 'dati', 'tabella.csv'), 'a,b\n1,2\n3,4\n');
  fs.rmSync(path.join(work, 'grafico.png'));
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(fs.readFileSync(path.join(copy, 'nuovo.txt'), 'utf8'), 'uno');
  assert.equal(fs.readFileSync(path.join(copy, 'dati', 'tabella.csv'), 'utf8'), 'a,b\n1,2\n3,4\n');
  assert.ok(!there(copy, 'grafico.png'));
  tidy.unwatch();

  // The data folder is lost: the chat's files come back from the memory.
  fs.rmSync(path.join(data, 'sandboxes'), { recursive: true, force: true });
  assert.equal(tidy.run().restored, 1);
  assert.equal(fs.readFileSync(path.join(work, 'nuovo.txt'), 'utf8'), 'uno');
  // A folder that is there and empty is a chat whose files were removed: nothing comes back, the copy follows.
  fs.rmSync(path.join(work, 'nuovo.txt'));
  fs.rmSync(path.join(work, 'dati'), { recursive: true });
  tidy.run();
  assert.deepEqual(fs.readdirSync(work), []);
  assert.ok(!there(copy, 'nuovo.txt'));

  // The chat deleted: its copy goes.
  tidy.forgetChat(chat.id);
  assert.ok(!there(copy));
});

test('under a vault that keeps the chats’ files encrypted no plain copy is kept in the memory', t => {
  const { data, memory, store, tidy } = world(t, { elsewhere: true, plainCopy: false });
  const chat = store.createConversation('Cifrata');
  put(path.join(data, 'sandboxes', chat.id, 'workspace', 'segreto.txt'));
  put(path.join(memory, 'chat-files', chat.id, 'segreto.txt'));
  tidy.run();
  assert.ok(!there(memory, 'chat-files'));
  assert.ok(there(data, 'sandboxes', chat.id, 'workspace', 'segreto.txt'));
});

test('a deleted pod project leaves nothing: pod, volume, copy, artifacts, chats and their folders', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const memory = tempDir(t, 'synthorg-tidy-memory-');
  const calls = [];
  const sandbox = {
    baseImages: null,
    async removeProjectContainer(name, options) { calls.push(['pod', name, options]); return { removed: true, volumeRemoved: true }; },
    async deleteWorkspace(id) { calls.push(['chat', id]); }
  };
  const projects = new ProjectManager({ store: () => store, sandbox, dataDir: memory });
  const made = await projects.create({ kind: 'podman', name: 'Da eliminare' });
  const chat = store.createConversation('Del progetto', made.id);
  store.setSetting(`plan_${chat.id}`, '{}');
  store.setSetting(`plan_mode_${made.id}`, 'auto');
  put(path.join(projects.copyDir(store.project(made.id)), 'HEAD'));
  put(path.join(projects.artifactsDir(store.project(made.id)), 'bozza.psd'));
  put(path.join(memory, 'studio', made.id, 'testo.pdf'));
  const result = await projects.remove(made.id);
  assert.deepEqual(result.chats, [chat.id]);
  assert.deepEqual(calls, [['pod', made.container_name, { volume: true }], ['chat', chat.id]]);
  assert.ok(!there(memory, 'pod-projects', `${made.id}.git`) && !there(memory, 'artifacts', made.id) && !there(memory, 'studio', made.id));
  assert.equal(store.getSetting(`plan_${chat.id}`), null);
  assert.equal(store.getSetting(`plan_mode_${made.id}`), null);
  assert.equal(store.listConversations('', false, made.id).length, 0);

  // A pod that cannot be removed: the project stays, with everything of its own.
  const kept = await projects.create({ kind: 'podman', name: 'Resta' });
  put(path.join(projects.artifactsDir(store.project(kept.id)), 'bozza.psd'));
  sandbox.removeProjectContainer = async () => ({ removed: false });
  await assert.rejects(projects.remove(kept.id), /resta nell’elenco/);
  assert.equal(store.project(kept.id).name, 'Resta');
  assert.ok(there(memory, 'artifacts', kept.id, 'bozza.psd'));
});
