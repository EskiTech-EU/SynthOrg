'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../server/database');
const { ProjectManager } = require('../server/projects');
const { CodeTools, TOOLS, toolSpecs, numberLines, normalizeRelative } = require('../server/code-tools');

function tempDir(t, prefix = 'synthorg-tools-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

const fakeSandbox = {
  async ensureProjectContainer(options) {
    return { containerName: options.containerName, volume: options.containerName, state: 'created', exec: { bin: 'podman', args: [] } };
  },
  async removeProjectContainer() { return { removed: true }; },
  async stopAllContainers() { return { success: true, count: 0 }; }
};

/** A real folder, real git, real files: the tools have nothing faked under them. */
async function project(t, files = {}) {
  const store = new Store(':memory:');
  const folder = tempDir(t);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), content);
  }
  const projects = new ProjectManager({ store: () => store, sandbox: fakeSandbox, dataDir: tempDir(t, 'synthorg-data-') });
  const tools = new CodeTools({ store: () => store, sandbox: fakeSandbox, projects });
  const created = await projects.create({ kind: 'local', path: folder, name: 'Progetto' });
  const opened = await projects.open(created.id);
  assert.equal(opened.git.ready, true, opened.git.error);
  t.after(() => store.close());
  return { store, folder, projects, tools, id: created.id };
}

test('the six tools are all a model is given, and they describe themselves as a chat expects', () => {
  assert.deepEqual(Object.keys(TOOLS).sort(), ['create_file', 'delete_file', 'edit_file', 'overwrite_file', 'read_file', 'rename_file']);
  const specs = toolSpecs();
  assert.equal(specs.length, 6);
  for (const spec of specs) {
    assert.equal(spec.type, 'function');
    assert.ok(spec.function.description.length > 20, spec.function.name);
    assert.equal(spec.function.parameters.type, 'object');
    assert.ok(spec.function.parameters.required.includes('path'));
  }
});

test('lines belong to us: read_file hands them out numbered so the model never counts', async t => {
  const { tools, id } = await project(t, { 'src/app.js': 'uno\ndue\ntre\nquattro\n' });

  const whole = await tools.run(id, 'read_file', { path: 'src/app.js' });
  assert.equal(whole.total_lines, 4);
  assert.equal(whole.content, '1| uno\n2| due\n3| tre\n4| quattro');

  const part = await tools.run(id, 'read_file', { path: 'src/app.js', from_line: 2, to_line: 3 });
  assert.equal(part.content, '2| due\n3| tre');
  assert.equal(part.from_line, 2);
  assert.equal(part.to_line, 3);

  // Numbers stay aligned once they get wider, so the text keeps one margin.
  assert.equal(numberLines('a\nb\n', 9), ' 9| a\n10| b');
});

test('edit_file aims by line, and with the exact words it refuses rather than guess', async t => {
  const { tools, id, folder } = await project(t, { 'app.js': 'const a = 1;\nconst b = 2;\nconst c = 3;\n' });

  // Line alone: the range is replaced.
  const first = await tools.run(id, 'edit_file', { path: 'app.js', from_line: 2, content: 'const b = 20;' });
  assert.equal(first.replaced_lines, '2-2');
  assert.equal(fs.readFileSync(path.join(folder, 'app.js'), 'utf8'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
  // The model is shown the result, numbered, so its next aim is at what is there now.
  assert.ok(first.content.includes('2| const b = 20;'));

  // Line plus the exact words: only those words change.
  await tools.run(id, 'edit_file', { path: 'app.js', from_line: 3, match: '3', content: '30' });
  assert.equal(fs.readFileSync(path.join(folder, 'app.js'), 'utf8'), 'const a = 1;\nconst b = 20;\nconst c = 30;\n');

  // Words that are not there: nothing is written, and it says so.
  const before = fs.readFileSync(path.join(folder, 'app.js'), 'utf8');
  await assert.rejects(
    tools.run(id, 'edit_file', { path: 'app.js', from_line: 1, match: 'non esiste', content: 'x' }),
    error => error.status === 409 && /match/.test(error.message)
  );
  // Words that are there twice: same answer, because either one would be a guess.
  await assert.rejects(
    tools.run(id, 'edit_file', { path: 'app.js', from_line: 1, to_line: 3, match: 'const', content: 'let' }),
    error => error.status === 409 && /più volte/.test(error.message)
  );
  assert.equal(fs.readFileSync(path.join(folder, 'app.js'), 'utf8'), before, 'un rifiuto non scrive niente');

  // A line that does not exist is refused too.
  await assert.rejects(tools.run(id, 'edit_file', { path: 'app.js', from_line: 99, content: 'x' }), /99 non esiste/);
});

test('creating, overwriting, renaming and deleting, each recorded as it lands', async t => {
  const { tools, id, folder, projects } = await project(t, { 'app.js': 'vecchio\n' });
  const commits = async () => (await projects.gitStatus(id)).commits;
  const start = await commits();

  const created = await tools.run(id, 'create_file', { path: 'src/nuovo.js', content: 'ciao\n' });
  assert.equal(created.created, true);
  assert.equal(fs.readFileSync(path.join(folder, 'src/nuovo.js'), 'utf8'), 'ciao\n');
  assert.equal(await commits(), start + 1);
  // The history says which tool did it, and that it was not the user.
  assert.equal(created.git.last.source, 'agent');
  assert.equal(created.git.last.author, 'SynthOrg (modello)');
  assert.equal(created.git.last.message, 'crea src/nuovo.js');

  await assert.rejects(tools.run(id, 'create_file', { path: 'src/nuovo.js', content: 'x' }), error => error.status === 409);

  const over = await tools.run(id, 'overwrite_file', { path: 'app.js', content: 'nuovo\nnuovo\n' });
  assert.equal(over.previous_lines, 1);
  assert.equal(over.lines, 2);
  assert.equal(await commits(), start + 2);

  await tools.run(id, 'rename_file', { path: 'src/nuovo.js', to: 'src/rinominato.js' });
  assert.ok(!fs.existsSync(path.join(folder, 'src/nuovo.js')));
  assert.ok(fs.existsSync(path.join(folder, 'src/rinominato.js')));
  assert.equal(await commits(), start + 3);

  const deleted = await tools.run(id, 'delete_file', { path: 'src/rinominato.js' });
  assert.equal(deleted.deleted, true);
  assert.ok(!fs.existsSync(path.join(folder, 'src/rinominato.js')));
  assert.equal(await commits(), start + 4);
  // Gone from the folder, still in the record: that is what reversible means.
  const stored = await projects.tryGit(projects.store().project(id), ['show', 'HEAD~1:src/rinominato.js']);
  assert.equal(stored, 'ciao');
});

test('no tool reaches outside the project, and none of them touches the record', async t => {
  const { tools, id } = await project(t, { 'app.js': 'x\n' });
  const outside = ['../fuori.txt', '..\\fuori.txt', '/etc/passwd', 'C:/Windows/system.ini', 'a/../../fuori.txt', '~/segreti'];
  for (const bad of outside) {
    await assert.rejects(tools.run(id, 'create_file', { path: bad, content: 'x' }), error => error.status === 400 || error.status === 403, bad);
  }
  // The history is not the model's to edit, however it spells it.
  for (const bad of ['.git/config', '.git/HEAD', './.git/hooks/pre-commit']) {
    await assert.rejects(tools.run(id, 'overwrite_file', { path: bad, content: 'x' }), error => error.status === 403, bad);
  }
  await assert.rejects(tools.run(id, 'read_file', { path: 'non/esiste.js' }), error => error.status === 404);
  await assert.rejects(tools.run(id, 'run_shell', { path: 'x' }), error => error.status === 404);

  assert.equal(normalizeRelative('./src//app.js'), 'src/app.js');
  assert.equal(normalizeRelative('src\\app.js'), 'src/app.js');
});

test('a symbolic link cannot be used to step out of the folder', async t => {
  const { tools, id, folder } = await project(t, { 'app.js': 'x\n' });
  const outside = tempDir(t, 'synthorg-outside-');
  fs.writeFileSync(path.join(outside, 'segreto.txt'), 'non toccare\n');
  try {
    fs.symlinkSync(outside, path.join(folder, 'link'), 'junction');
  } catch {
    t.skip('questo sistema non permette di creare link senza privilegi');
    return;
  }
  await assert.rejects(tools.run(id, 'overwrite_file', { path: 'link/segreto.txt', content: 'toccato' }), error => error.status === 403);
  assert.equal(fs.readFileSync(path.join(outside, 'segreto.txt'), 'utf8'), 'non toccare\n');
});

test('a project has its own chats, kept out of the general list, and they reach the tools over HTTP', async t => {
  const { createApp } = require('../server');
  const folder = tempDir(t, 'synthorg-http-');
  fs.writeFileSync(path.join(folder, 'app.js'), 'const a = 1;\n');
  const { server } = createApp({ token: 'tok', dbPath: ':memory:', githubPort: 0, sandbox: fakeSandbox });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method = 'GET', data) => {
    const res = await fetch(base + route, {
      method,
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    return { status: res.status, body: await res.json() };
  };

  const project = (await call('/projects', 'POST', { kind: 'local', path: folder, name: 'Progetto' })).body;
  // The tools here are exercised without a user in front of them: both permissions on auto.
  assert.equal((await call(`/projects/${project.id}`, 'PATCH', { permissions: { code: 'auto', terminal: 'auto' } })).status, 200);
  await call(`/projects/${project.id}/open`, 'POST', {});

  // More than one chat per project, and none of them in the general sidebar.
  const generale = (await call('/conversations', 'POST', { title: 'Chat normale' })).body;
  const refactor = (await call('/conversations', 'POST', { title: 'Refactor', projectId: project.id })).body;
  const bug = (await call('/conversations', 'POST', { title: 'Bug', projectId: project.id })).body;
  assert.equal(refactor.project_id, project.id);
  assert.deepEqual((await call('/conversations')).body.map(c => c.id), [generale.id]);
  const mine = (await call(`/conversations?project=${project.id}`)).body.map(c => c.id).sort();
  assert.deepEqual(mine, [bug.id, refactor.id].sort());

  // The six are declared exactly as a chat completion expects them.
  const specs = (await call('/code-tools')).body.tools;
  assert.equal(specs.length, 6);
  assert.ok(specs.every(spec => spec.type === 'function'));

  // A tool call goes through and comes back with the change already recorded.
  const edited = await call(`/projects/${project.id}/tools/edit_file`, 'POST', { path: 'app.js', from_line: 1, match: '1', content: '42' });
  assert.equal(edited.status, 200);
  assert.equal(fs.readFileSync(path.join(folder, 'app.js'), 'utf8'), 'const a = 42;\n');
  assert.equal(edited.body.git.last.source, 'agent');

  // A refusal is an ordinary answer the model can read and try again from.
  const missed = await call(`/projects/${project.id}/tools/edit_file`, 'POST', { path: 'app.js', from_line: 1, match: 'non c’è', content: 'x' });
  assert.equal(missed.status, 409);
  assert.match(missed.body.error, /match/);
  assert.equal(fs.readFileSync(path.join(folder, 'app.js'), 'utf8'), 'const a = 42;\n');

  // A project that lives in a folder has no container: its commands run in the
  // editor's terminal on this machine, never through the chat's sandbox route.
  const tree = (await call(`/projects/${project.id}/tree`)).body;
  assert.equal(tree.kind, 'local');
  assert.equal(tree.runsCommands, true);
  assert.equal(tree.commandsIn, 'editor');
  const refused = await call(`/conversations/${refactor.id}/sandbox/exec`, 'POST', { command: 'ls' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /non in un container/);

  // Removing the project takes its chats with it; the general one stays.
  await call(`/projects/${project.id}`, 'DELETE');
  assert.deepEqual((await call(`/conversations?project=${project.id}`)).body, []);
  assert.deepEqual((await call('/conversations')).body.map(c => c.id), [generale.id]);
});

test('a command from a project chat runs in that project’s container, not in one of the chat’s own', async t => {
  const { createApp } = require('../server');
  const calls = [];
  const sandbox = {
    ...fakeSandbox,
    async ensureProjectRunning(project) { calls.push(['ensure', project.container_name]); return project.container_name; },
    async execute(chatId, command, options) {
      calls.push(['execute', options.containerName, command]);
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
    async inspectWorkspace() { return { repo: true, empty: false }; },
    async execGit() { return { ok: true, stdout: '' }; },
    async runGit() { return { ok: true, stdout: '' }; }
  };
  const { server } = createApp({ token: 'tok', dbPath: ':memory:', githubPort: 0, sandbox });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method = 'GET', data) => {
    const res = await fetch(base + route, {
      method,
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    return { status: res.status, body: await res.json() };
  };

  const project = (await call('/projects', 'POST', { kind: 'podman', name: 'API', container: 'api' })).body;
  // The tools here are exercised without a user in front of them: both permissions on auto.
  assert.equal((await call(`/projects/${project.id}`, 'PATCH', { permissions: { code: 'auto', terminal: 'auto' } })).status, 200);
  const chat = (await call('/conversations', 'POST', { title: 'Lavoro', projectId: project.id })).body;
  const generale = (await call('/conversations', 'POST', { title: 'Normale' })).body;

  assert.equal((await call(`/conversations/${chat.id}/sandbox/exec`, 'POST', { command: 'npm test' })).status, 200);
  assert.deepEqual(calls, [['ensure', 'synthorg-code-api'], ['execute', 'synthorg-code-api', 'npm test']]);

  // A chat that belongs to nothing keeps its own sandbox, as it always did.
  calls.length = 0;
  await call(`/conversations/${generale.id}/sandbox/exec`, 'POST', { command: 'ls' });
  assert.deepEqual(calls, [['execute', null, 'ls']]);
});

test('the file tree the model is given is the one git shows, so .gitignore holds there too', async t => {
  const { tools, id, folder } = await project(t, { 'app.js': 'x\n', 'src/b.js': 'y\n' });
  fs.writeFileSync(path.join(folder, '.gitignore'), 'node_modules/\nsegreti.env\n');
  fs.mkdirSync(path.join(folder, 'node_modules/pacchetto'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'node_modules/pacchetto/index.js'), 'enorme\n');
  fs.writeFileSync(path.join(folder, 'segreti.env'), 'CHIAVE=1\n');

  const tree = await tools.tree(id);
  assert.deepEqual(tree.files, ['.gitignore', 'app.js', 'src/b.js']);
  assert.ok(!tree.files.some(file => file.includes('node_modules')), 'niente node_modules nel prompt');
  assert.ok(!tree.files.includes('segreti.env'), 'niente file ignorati nel prompt');
});

test('a project gives pointers to its files without being opened, and copies of the ones asked for go into another chat\'s workspace', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const folder = tempDir(t);
  const write = (name, content) => { fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true }); fs.writeFileSync(path.join(folder, name), content); };
  write('src/app.js', 'console.log(1);\n');
  write('README.md', '# Progetto\n');
  write('img/logo.bin', Buffer.from([0, 1, 2, 3]));
  write('node_modules/dep/index.js', 'x');
  const calls = [];
  const sandbox = { ...fakeSandbox, async runGit(options) { calls.push(options); return { ok: false }; } };
  const projects = new ProjectManager({ store: () => store, sandbox, dataDir: tempDir(t, 'synthorg-data-') });
  const tools = new CodeTools({ store: () => store, sandbox, projects });
  // never opened: no repository yet, the folder is walked and what a package manager made is left out
  const created = await projects.create({ kind: 'local', path: folder, name: 'Il mio progetto!' });
  const listed = await tools.pointers(created.id);
  assert.deepEqual([listed.name, listed.total, listed.files], ['Il mio progetto!', 3, ['README.md', 'img/logo.bin', 'src/app.js']]);
  assert.equal(calls.length, 0, 'a folder of this computer starts nothing');

  const workspace = tempDir(t, 'synthorg-ws-');
  fs.writeFileSync(path.join(workspace, 'mio.txt'), 'del compito');
  const copied = await tools.copyTo(created.id, workspace, ['src/app.js', 'img/logo.bin', 'manca.txt', 'src', '../fuori.txt', 'src/app.js', 7]);
  assert.equal(copied.folder, 'progetti/Il-mio-progetto');
  assert.deepEqual(copied.files.map(file => [file.path, file.to || null, Boolean(file.error)]), [
    ['src/app.js', 'progetti/Il-mio-progetto/src/app.js', false],
    ['img/logo.bin', 'progetti/Il-mio-progetto/img/logo.bin', false],
    ['manca.txt', null, true],
    ['src', null, true],
    ['../fuori.txt', null, true]
  ]);
  assert.equal(fs.readFileSync(path.join(workspace, 'progetti/Il-mio-progetto/src/app.js'), 'utf8'), 'console.log(1);\n');
  assert.deepEqual([...fs.readFileSync(path.join(workspace, 'progetti/Il-mio-progetto/img/logo.bin'))], [0, 1, 2, 3], 'a file of a folder is copied as it is');
  // the copy is the task's: changing it leaves the project as it was
  fs.writeFileSync(path.join(workspace, 'progetti/Il-mio-progetto/src/app.js'), 'changed');
  assert.equal(fs.readFileSync(path.join(folder, 'src/app.js'), 'utf8'), 'console.log(1);\n');
  // taken away before the next task; what the tasks made themselves stays
  assert.deepEqual(tools.clearCopies(workspace), { cleared: true });
  assert.deepEqual(fs.readdirSync(workspace), ['mio.txt']);
  assert.deepEqual(tools.clearCopies(workspace), { cleared: true }, 'nothing to take away is not an error');
});

test('a container project that is not running is read from its volume, with no network, and is not started', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const asked = [];
  const started = [];
  const sandbox = {
    ...fakeSandbox,
    async ensureProjectContainer(options) { started.push(options.containerName); return fakeSandbox.ensureProjectContainer(options); },
    async execGit() { return { ok: false, stderr: 'container not running' }; },
    async execInContainer() { return { ok: false, stderr: 'container not running' }; },
    async runGit(options) {
      asked.push([options.volume, options.network, options.args.join(' ')]);
      if (options.args[0] === 'ls-files') return { ok: true, stdout: 'b.txt\na/a.txt\n' };
      if (options.args[0] === 'show' && options.args[1] === 'HEAD:a/a.txt') return { ok: true, stdout: 'contenuto di a\n' };
      return { ok: false };
    }
  };
  const projects = new ProjectManager({ store: () => store, sandbox, dataDir: tempDir(t, 'synthorg-data-') });
  const tools = new CodeTools({ store: () => store, sandbox, projects });
  const created = await projects.create({ kind: 'podman', name: 'Chiuso', container: 'chiuso' });
  started.length = 0;
  const listed = await tools.pointers(created.id);
  assert.deepEqual(listed.files, ['a/a.txt', 'b.txt']);
  const workspace = tempDir(t, 'synthorg-ws-');
  const copied = await tools.copyTo(created.id, workspace, ['a/a.txt', 'b.txt']);
  assert.equal(fs.readFileSync(path.join(workspace, 'progetti/Chiuso/a/a.txt'), 'utf8'), 'contenuto di a\n');
  assert.deepEqual(copied.files.map(file => [file.path, Boolean(file.error)]), [['a/a.txt', false], ['b.txt', true]]);
  assert.ok(asked.length >= 3 && asked.every(([volume, network]) => volume === created.container_name && network === false));
  assert.deepEqual(started, [], 'the project is not started to read its files');
});
