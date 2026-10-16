'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../server');
const { Store } = require('../server/database');
const { ProjectManager } = require('../server/projects');
const {
  assertProjectContainerName, toolsImageRef, normalizeImage, runtimeStamp, TOOLS_INSTALL_SCRIPT, hardenedRunArgs,
  DEFAULT_PROJECT_IMAGE, CODE_AGENT
} = require('../server/sandbox');
const { VERSION: BASE_VERSION } = require('../server/base-image');

test('project containers start from a per-image tools variant that carries git, node and the editor runtime', () => {
  // One image, however it is spelled, gets one tools build per runtime build.
  assert.equal(normalizeImage('alpine'), 'docker.io/library/alpine:latest');
  assert.equal(normalizeImage('library/alpine:3.20'), 'docker.io/library/alpine:3.20');
  assert.equal(normalizeImage('user/app'), 'docker.io/user/app:latest');
  assert.equal(normalizeImage('ghcr.io/org/app:1.2'), 'ghcr.io/org/app:1.2');
  assert.equal(normalizeImage('localhost:5000/app'), 'localhost:5000/app:latest');
  assert.equal(normalizeImage('alpine@sha256:' + 'a'.repeat(64)), 'docker.io/library/alpine@sha256:' + 'a'.repeat(64));
  assert.match(runtimeStamp(), /^[a-f0-9]{10}$/);
  assert.equal(toolsImageRef('alpine:latest'), `localhost/synthorg-code-tools:docker.io_library_alpine_latest-${runtimeStamp()}`);
  assert.equal(toolsImageRef('alpine'), toolsImageRef('docker.io/library/alpine:latest'));
  // The base is ours, at a version this build pinned: no registry, no tag
  // called latest that can mean something else tomorrow.
  assert.equal(DEFAULT_PROJECT_IMAGE, `localhost/synthorg-base:${BASE_VERSION}`);
  assert.match(BASE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(!DEFAULT_PROJECT_IMAGE.includes('docker.io'));
  assert.ok(!DEFAULT_PROJECT_IMAGE.endsWith(':latest'));
  assert.equal(CODE_AGENT, '/opt/synthorg-code/agent.cjs');
  // Travels through `sh -c` and wsl.exe as one argument: no newlines allowed.
  assert.ok(!/\n/.test(TOOLS_INSTALL_SCRIPT));
  // Alpine only: one package manager, git and Node, nothing graphical.
  assert.ok(TOOLS_INSTALL_SCRIPT.includes('command -v apk'));
  assert.ok(TOOLS_INSTALL_SCRIPT.includes('apk add git nodejs'));
  for (const gone of ['apt-get', 'dnf', 'yum', 'webkit', 'gtk', 'xvfb', 'mesa']) assert.ok(!TOOLS_INSTALL_SCRIPT.includes(gone), gone);
});

test('the editor is shipped already compiled, and a stale binary is never used', t => {
  const { prebuiltEditor, editorSourceStamp, containerArch } = require('../server/sandbox');
  assert.equal(containerArch('x64'), 'x86_64');
  assert.equal(containerArch('arm64'), 'aarch64');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-prebuilt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = stamp => {
    fs.writeFileSync(path.join(dir, 'editor-x86_64'), 'binario');
    fs.writeFileSync(path.join(dir, 'mono.ttf'), 'font');
    fs.writeFileSync(path.join(dir, 'ui.ttf'), 'font');
    fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ sources: stamp }));
  };

  // Built from exactly these sources: used.
  write(editorSourceStamp());
  assert.ok(prebuiltEditor('x64', dir), 'un binario aggiornato va usato');
  // Built from other sources: ignored, and the container compiles as before.
  write('qualcosa-di-vecchio');
  assert.equal(prebuiltEditor('x64', dir), null, 'un binario vecchio non va mai usato');
  // Incomplete: ignored too, rather than half copied into an image.
  write(editorSourceStamp());
  fs.rmSync(path.join(dir, 'ui.ttf'));
  assert.equal(prebuiltEditor('x64', dir), null);
  // Nothing at all is the normal case on a machine that never built it.
  assert.equal(prebuiltEditor('x64', path.join(dir, 'vuota')), null);
  // The stamp is the sources themselves, so it moves when the C moves.
  assert.match(editorSourceStamp(), /^[a-f0-9]{16}$/);
});

test('no container ever gets a device, a privilege or a mount of this machine it did not ask for', () => {
  const args = hardenedRunArgs({ name: 'synthorg-code-x', network: 'none', image: 'alpine', mounts: ['synthorg-code-x:/workspace:rw'], memory: '1g', cpus: '1.0', pids: 64 });
  const joined = args.join(' ');
  for (const forbidden of ['--device', '--gpus', '--privileged', '/dev/dri', '/dev/kfd', '/mnt/wslg', '.X11-unix', '--shm-size']) {
    assert.ok(!joined.includes(forbidden), forbidden);
  }
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--security-opt=no-new-privileges'));
  assert.ok(args.includes('--network=none'));
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '-v'), ['synthorg-code-x:/workspace:rw']);
  // root inside a project's container is a subordinate id outside, never the user
  const { USERNS_ARGS, toContainerMountPath } = require('../server/sandbox');
  for (const map of USERNS_ARGS) assert.ok(args.includes(map), map);
  const chat = hardenedRunArgs({ name: 'synthorg-chat-x', network: 'none', image: 'alpine', mounts: [], memory: '1g', cpus: '1.0', pids: 64, userns: false });
  for (const map of USERNS_ARGS) assert.ok(!chat.includes(map), 'a chat keeps the plain rootless mapping');
  // only SynthOrg's own data folder exists inside the runtime; anything else is refused, not mounted
  const { DATA_DIR } = require('../server/paths');
  assert.equal(toContainerMountPath(path.join(DATA_DIR, 'sandboxes', 'abc', 'workspace'), true), '/mnt/synthorg-data/sandboxes/abc/workspace');
  assert.equal(toContainerMountPath(DATA_DIR, true), '/mnt/synthorg-data');
  assert.throws(() => toContainerMountPath('C:\\Windows\\win.ini', true), /fuori dalla cartella dati/);
  assert.throws(() => toContainerMountPath(path.join(DATA_DIR, '..', 'altro'), true), /fuori dalla cartella dati/);
  assert.equal(toContainerMountPath('/srv/x', false), '/srv/x', 'a native engine mounts its own paths');
});
const TOKEN = 'synthorg-test-token';

// Every project opens a container now; the API tests never touch a real engine.
function fakeSandbox(calls = []) {
  return {
    async ensureProjectContainer(options) {
      calls.push(['ensure', options]);
      return { containerName: options.containerName, volume: options.containerName, state: 'created', exec: { bin: 'wsl.exe', args: ['-d', 'synthorg-runtime', 'podman'] }, tools: { git: true, node: true, agent: true, error: null } };
    },
    async removeProjectContainer(name, options = {}) { calls.push(['remove', name, ...(options.volume ? ['volume'] : [])]); return { removed: true, volumeRemoved: Boolean(options.volume) }; },
    async stopAllContainers() { return { success: true, count: 0 }; }
  };
}

function tempDir(t, prefix = 'synthorg-folder-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(t) {
  const { server } = createApp({ token: TOKEN, dbPath: ':memory:', githubPort: 0, sandbox: fakeSandbox() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (route, method = 'GET', data) => {
    const res = await fetch(base + route, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    return { status: res.status, body: await res.json() };
  };
  return { request };
}

test('local project: create, open, rename and remove without touching the folder', async t => {
  const { request } = await setup(t);
  const folder = tempDir(t);
  const real = fs.realpathSync(folder);
  fs.writeFileSync(path.join(folder, 'README.md'), 'ciao');

  const created = await request('/projects', 'POST', { kind: 'local', path: folder });
  assert.equal(created.status, 200);
  assert.equal(created.body.kind, 'local');
  assert.equal(created.body.path, real);
  assert.equal(created.body.name, path.basename(real));
  assert.equal((await request('/projects')).body.length, 1);

  const opened = await request(`/projects/${created.body.id}/open`, 'POST', {});
  assert.equal(opened.status, 200);
  assert.equal(opened.body.folder, real);
  // A local project is edited on this machine, by choice: no container.
  assert.equal(created.body.container_name, null);
  assert.equal(opened.body.container, null);
  assert.deepEqual(opened.body.runtime, { kind: 'host' });
  assert.ok(opened.body.project.opened_at);

  const renamed = await request(`/projects/${created.body.id}`, 'PATCH', { name: 'Sito vetrina' });
  assert.equal(renamed.body.name, 'Sito vetrina');

  const removed = await request(`/projects/${created.body.id}`, 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal(removed.body.keptPath, real);
  assert.equal(fs.readFileSync(path.join(folder, 'README.md'), 'utf8'), 'ciao');
  assert.equal((await request('/projects')).body.length, 0);
  assert.equal((await request(`/projects/${created.body.id}/open`, 'POST', {})).status, 404);
});

test('a local project whose folder disappeared refuses to open', async t => {
  const { request } = await setup(t);
  const folder = tempDir(t);
  const created = await request('/projects', 'POST', { kind: 'local', path: folder, name: 'Sparita' });
  fs.rmSync(folder, { recursive: true, force: true });
  assert.equal((await request(`/projects/${created.body.id}/open`, 'POST', {})).status, 410);
});

test('project creation rejects unusable folders, duplicates, unknown kinds and repositories without an account', async t => {
  const { request } = await setup(t);
  const folder = tempDir(t);
  const file = path.join(folder, 'file.txt');
  fs.writeFileSync(file, 'x');
  const create = data => request('/projects', 'POST', data);

  assert.equal((await create({ kind: 'local', path: 'relativo/cartella' })).status, 400);
  assert.equal((await create({ kind: 'local', path: path.join(folder, 'manca') })).status, 400);
  assert.equal((await create({ kind: 'local', path: file })).status, 400);
  assert.equal((await create({ kind: 'local', path: path.parse(folder).root })).status, 400);
  assert.equal((await create({ kind: 'local', path: folder })).status, 200);
  assert.equal((await create({ kind: 'local', path: folder })).status, 409);
  if (process.platform === 'win32') assert.equal((await create({ kind: 'local', path: folder.toUpperCase() })).status, 409);
  assert.equal((await create({ kind: 'ftp', name: 'x' })).status, 400);
  assert.equal((await create({ kind: 'podman', container: '---' })).status, 400);
  assert.equal((await create({ kind: 'podman', container: 'api', image: '-v/:/host' })).status, 400);
  // GitHub stopped being a kind of project; a repository is an option on one.
  assert.equal((await create({ kind: 'github', name: 'x' })).status, 400);
  assert.equal((await create({ kind: 'podman', container: 'r1', repo: 'not a repo' })).status, 400);
  assert.equal((await create({ kind: 'podman', container: 'r2', repo: 'octocat/app' })).status, 409);
});

test('podman project gets a dedicated container and lives in its volume, not on this disk', async t => {
  const { request } = await setup(t);
  const created = await request('/projects', 'POST', { kind: 'podman', name: 'La mia API', network: false });
  assert.equal(created.status, 200);
  assert.equal(created.body.name, 'La mia API');
  assert.equal(created.body.container_name, 'synthorg-code-la-mia-api');
  assert.equal(created.body.image, `localhost/synthorg-base:${BASE_VERSION}`);
  assert.equal(created.body.network, 0);
  // The only path the project has is the one inside the container.
  assert.equal(created.body.path, '/workspace');
  assert.equal((await request('/projects', 'POST', { kind: 'podman', container: 'la-mia-api' })).status, 409);
  // The copy of its record into the memory: on unless turned off, and the project listed with no copy yet.
  const copies = await request('/memory/copies');
  assert.equal(copies.body.on, true);
  assert.deepEqual(copies.body.projects.map(p => [p.name, p.copied, p.error]), [['La mia API', false, null]]);
  assert.equal((await request('/memory/copies', 'POST', { on: false })).body.on, false);
  assert.equal((await request('/memory/copies')).body.on, false);
});

test('opening and removing a podman project drives only its own container and never a folder here', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const calls = [];
  const sandbox = {
    async ensureProjectContainer(options) {
      calls.push(['ensure', options]);
      return { containerName: options.containerName, volume: options.containerName, state: 'created', exec: { bin: 'wsl.exe', args: ['-d', 'synthorg-runtime', 'podman'] } };
    },
    async removeProjectContainer(name, options = {}) { calls.push(['remove', name, ...(options.volume ? ['volume'] : [])]); return { removed: true }; }
  };
  const manager = new ProjectManager({ store: () => store, sandbox });

  const project = await manager.create({ kind: 'podman', container: 'worker', image: 'node:22-alpine' });
  const opened = await manager.open(project.id);
  assert.equal(opened.container.state, 'created');
  // The sandbox is also handed the way to report which step it is on, for the
  // page's progress bar; the rest of the request is what it always was.
  const [verb, options] = calls[0];
  assert.equal(verb, 'ensure');
  assert.equal(typeof options.onPhase, 'function');
  const { onPhase, ...request } = options;
  assert.deepEqual(request, { containerName: 'synthorg-code-worker', image: 'node:22-alpine', networkEnabled: true });
  // The editor gets told where everything runs; nothing names this machine.
  assert.deepEqual(opened.runtime, {
    kind: 'container',
    engine: { bin: 'wsl.exe', args: ['-d', 'synthorg-runtime', 'podman'] },
    container: 'synthorg-code-worker',
    workdir: '/workspace',
    volume: 'synthorg-code-worker'
  });
  assert.equal(opened.folder, '/workspace');
  assert.ok(!JSON.stringify(opened).includes(os.tmpdir()));

  const removed = await manager.remove(project.id);
  // The pod and its volume, with the files: nothing of the project stays.
  assert.deepEqual(calls[1], ['remove', 'synthorg-code-worker', 'volume']);
  assert.equal(removed.containerRemoved, true);
  assert.equal(removed.keptPath, null);
});

// A container project's git, answered by the fake engine: credential-free
// commands arrive through execGit (the project's own container), anything
// that talks to GitHub through runGit (a throwaway one).
function fakeRepoSandbox(runs) {
  let cloned = false;
  let dirty = true;
  let commits = 0;
  const refs = new Set();
  // How far the branch here and the one on GitHub are from each other, as git would count it.
  const state = { lastAuthor: null, lastTrailers: null, ahead: 0, behind: 0, refuse: false };
  const answer = args => {
    const [command, ...rest] = args;
    const has = ref => refs.has(String(ref).replace(/^origin\//, 'refs/remotes/origin/'));
    if (command === 'clone') { cloned = true; commits = 1; refs.add('refs/heads/main'); refs.add('refs/remotes/origin/main'); }
    if (command === 'merge') state.behind = 0;
    if (command === 'commit') {
      commits += 1;
      state.ahead += 1;
      dirty = false;
      state.lastTrailers = rest[rest.length - 1];
      const keys = Object.keys(args.env || {});
      void keys;
    }
    // A branch GitHub has moved on: the push is refused, as git refuses a non-fast-forward.
    if (command === 'push' && state.refuse) return { ok: false, stdout: '', stderr: ' ! [rejected]        abc -> main (non-fast-forward)' };
    if (command === 'push') state.ahead = 0;
    if (command === 'symbolic-ref') return { ok: true, stdout: 'main' };
    if (command === 'for-each-ref') return { ok: true, stdout: [...refs].join('\n') };
    if (command === 'status' && rest.includes('--branch')) {
      return { ok: true, stdout: `# branch.oid ${commits ? 'abc' : '(initial)'}\n# branch.head main${dirty ? '\n1 .M N... 100644 100644 100644 a b src/app.js' : ''}` };
    }
    if (command === 'status') return { ok: true, stdout: dirty ? ' M src/app.js' : '' };
    if (command === 'rev-parse') {
      const ref = rest[rest.length - 1];
      const found = ref === 'HEAD' ? commits > 0 : has(ref);
      return { ok: found, stdout: found ? 'abc' : '' };
    }
    if (command === 'rev-list' && rest.includes('--left-right')) return { ok: true, stdout: `${state.behind}\t${state.ahead}` };
    if (command === 'rev-list') return { ok: true, stdout: String(commits) };
    if (command === 'log') return { ok: true, stdout: ['abcdef0123', 'Sistema il login', '2026-01-01T00:00:00Z', 'SynthOrg (modello)', 'agent'].join('\0') };
    return { ok: true, stdout: '' };
  };
  return {
    async ensureProjectContainer(options) {
      return { containerName: options.containerName, volume: options.containerName, state: 'running', exec: { bin: 'podman', args: [] } };
    },
    async removeProjectContainer() { return { removed: true }; },
    async inspectWorkspace(name) { assert.equal(name, 'synthorg-code-app'); return { repo: cloned, empty: !cloned }; },
    async runGit(options) { runs.push({ ...options, via: 'run' }); return answer(options.args); },
    async execGit(options) { runs.push({ ...options, via: 'exec' }); return answer(options.args); },
    state
  };
}

function fakeGithubApi(calls) {
  return {
    async getRepository(name) {
      return { full_name: name, name: name.split('/')[1], default_branch: 'main', html_url: `https://github.com/${name}`, canPush: true };
    },
    async token() { return 'ghu_secret_token'; },
    async listBranches(repo) { calls.push(['branches', repo]); return ['dev', 'main', 'feature/login']; }
  };
}

test('a repository is a property of a project, and only the user moves steps between it and GitHub', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const runs = [];
  const calls = [];
  const sandbox = fakeRepoSandbox(runs);
  const manager = new ProjectManager({ store: () => store, sandbox, github: fakeGithubApi(calls) });
  t.after(() => manager.stopSyncs());

  // Pod yes and repository yes are two answers to two questions, on one project.
  const project = await manager.create({ kind: 'podman', name: 'App', repo: 'octocat/app' });
  assert.equal(project.kind, 'podman');
  assert.equal(project.container_name, 'synthorg-code-app');
  assert.equal(project.repo, 'octocat/app');
  assert.equal(project.default_branch, 'main');
  // Unless one branch is asked for, a project follows the whole repository.
  assert.equal(project.repo_mode, 'full');
  assert.equal(project.repo_branch, null);

  const opened = await manager.open(project.id);
  const clone = runs.find(run => run.args[0] === 'clone');
  assert.deepEqual(clone.args, ['clone', '--origin', 'origin', 'https://github.com/octocat/app.git', '/workspace']);
  // Only what carries the credential gets a throwaway container and a network.
  assert.equal(clone.via, 'run');
  assert.equal(clone.network, true);
  assert.equal(clone.volume, 'synthorg-code-app');
  const secret = Buffer.from('x-access-token:ghu_secret_token').toString('base64');
  assert.ok(Object.values(clone.env).includes(`AUTHORIZATION: basic ${secret}`));
  assert.equal(opened.git.ready, true);
  assert.equal(opened.git.branch, 'main');
  assert.equal(opened.git.mode, 'full');
  assert.equal(opened.git.onGithub, true);
  // Nothing syncs on its own unless the user turns it on.
  assert.equal(opened.git.auto, false);
  assert.ok(!runs.some(run => ['push', 'fetch'].includes(run.args[0])), 'opening talks to GitHub only to clone');

  // The recorder: a model's tool call is committed as the model, on the spot.
  const recorded = await manager.gitAction(project.id, 'checkpoint', { message: 'Sistema il login', tool: 'write_file' }, 'agent');
  assert.equal(recorded.changes, 0);
  assert.equal(recorded.unpushed, 1);
  const commit = runs.find(run => run.args[0] === 'commit');
  // Recording needs no credential, so it runs in the project's own container.
  assert.equal(commit.via, 'exec');
  assert.equal(commit.containerName, 'synthorg-code-app');
  assert.ok(!JSON.stringify(commit.env).includes(secret), 'recording never receives the credential');
  assert.deepEqual(commit.args.slice(0, 4), ['commit', '--no-verify', '-m', 'Sistema il login']);
  assert.ok(commit.args[5].includes('SynthOrg-Source: agent'));
  assert.ok(commit.args[5].includes('SynthOrg-Tool: write_file'));
  assert.ok(Object.values(commit.env).includes('SynthOrg (modello)'), 'the history says the change is the model’s');

  // GitHub is the user's alone: a model can neither move steps nor branches, nor read or change the link.
  for (const action of ['push', 'pull', 'branches', 'switch', 'new-branch', 'resolve', 'sync', 'link', 'unlink']) {
    await assert.rejects(manager.gitAction(project.id, action, { repo: 'octocat/app', branch: 'main', name: 'x', auto: true }, 'agent'), error => error.status === 403, action);
  }
  // What is gone is gone for everyone: no pull requests or merges from here.
  for (const action of ['pull-request', 'merge', 'work-branch']) {
    await assert.rejects(manager.gitAction(project.id, action, {}), error => error.status === 404, action);
  }

  // Upload goes to the branch of the same name, with the credential, in a throwaway container.
  const sent = await manager.gitAction(project.id, 'push', {});
  const push = runs.find(run => run.args[0] === 'push');
  assert.deepEqual(push.args, ['push', 'https://github.com/octocat/app.git', 'abc:refs/heads/main']);
  assert.equal(push.via, 'run');
  assert.deepEqual(sent.pushed, { branch: 'main', url: 'https://github.com/octocat/app/tree/main' });
  assert.equal(sent.unpushed, 0);

  // Download asks GitHub with the credential and adds the steps without one, in the project's own container.
  sandbox.state.behind = 2;
  const got = await manager.gitAction(project.id, 'pull', {});
  assert.equal(got.pulled, 2);
  const fetch = runs.find(run => run.args[0] === 'fetch');
  assert.deepEqual(fetch.args, ['fetch', '--no-tags', '--prune', 'https://github.com/octocat/app.git', '+refs/heads/*:refs/remotes/origin/*']);
  assert.equal(fetch.via, 'run');
  const merge = runs.find(run => run.args[0] === 'merge');
  assert.deepEqual(merge.args, ['merge', '--ff-only', 'refs/remotes/origin/main']);
  assert.equal(merge.via, 'exec');
  assert.ok(!JSON.stringify(merge.env).includes(secret));

  // GitHub has moved on and so has the project: upload is refused and nothing is forced.
  sandbox.state.refuse = true;
  sandbox.state.ahead = 1;
  sandbox.state.behind = 1;
  const refused = await manager.gitAction(project.id, 'push', {});
  assert.equal(refused.rejected, true);
  assert.equal(refused.pushed, null);
  assert.equal(refused.diverged, true);
  // And download moves nothing while the two are different.
  const merges = runs.filter(run => run.args[0] === 'merge').length;
  assert.equal((await manager.gitAction(project.id, 'pull', {})).pulled, 0);
  assert.equal(runs.filter(run => run.args[0] === 'merge').length, merges);

  // Names git would read as something else never reach it.
  for (const bad of ['', '-f', '--force', '+main', 'a..b', 'x/', '/x', 'x.lock', 'a b', 'HEAD', '.hidden', 'a//b']) {
    await assert.rejects(manager.gitAction(project.id, 'switch', { branch: bad }), error => error.status === 400, bad);
    await assert.rejects(manager.gitAction(project.id, 'new-branch', { name: bad }), error => error.status === 400, bad);
  }

  for (const run of runs) {
    assert.ok(!JSON.stringify(run.args).includes('ghu_secret_token') && !JSON.stringify(run.args).includes(secret));
    assert.ok(!(run.args[0] === 'push' && run.args.some(arg => arg.startsWith('+') || arg === '--force' || arg === '-f')), 'never a forced push');
    assert.ok(Object.values(run.env).includes('/dev/null'), 'repository hooks are disabled');
  }
});

test('a project that follows one branch downloads that branch alone', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const runs = [];
  const manager = new ProjectManager({ store: () => store, sandbox: fakeRepoSandbox(runs), github: fakeGithubApi([]) });
  t.after(() => manager.stopSyncs());
  const project = await manager.create({ kind: 'podman', name: 'App', repo: 'octocat/app', repoMode: 'branch', repoBranch: 'dev' });
  assert.equal(project.repo_mode, 'branch');
  assert.equal(project.repo_branch, 'dev');
  await manager.open(project.id);
  const clone = runs.find(run => run.args[0] === 'clone');
  assert.deepEqual(clone.args, ['clone', '--origin', 'origin', '--single-branch', '--branch', 'dev', 'https://github.com/octocat/app.git', '/workspace']);
  // There is nowhere else to move to, and it says so.
  await assert.rejects(manager.gitAction(project.id, 'switch', { branch: 'main' }), error => error.status === 409);
  await assert.rejects(manager.gitAction(project.id, 'new-branch', { name: 'altro' }), error => error.status === 409);
  await assert.rejects(manager.create({ kind: 'podman', name: 'Altra', repo: 'octocat/app', repoMode: 'tutto' }), error => error.status === 400);
});

test('a local project records every change in its own folder, with no branch and no copy', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const folder = fs.realpathSync(tempDir(t));
  fs.writeFileSync(path.join(folder, 'index.html'), '<h1>ciao</h1>\n');
  const manager = new ProjectManager({ store: () => store, sandbox: fakeSandbox(), dataDir: tempDir(t, 'synthorg-data-') });

  const project = await manager.create({ kind: 'local', path: folder, name: 'Sito Vetrina' });
  assert.equal(project.repo, null);

  // Opening a folder that was not a repository starts the record at once, so
  // there is a state to come back to before anything is touched.
  const opened = await manager.open(project.id);
  assert.equal(opened.git.ready, true, opened.git.error);
  assert.equal(opened.git.branch, 'main');
  assert.equal(opened.git.commits, 1);
  assert.equal(opened.git.changes, 0);
  assert.equal(opened.git.pushBranch, null);
  assert.equal(opened.git.mode, null);
  assert.ok(fs.existsSync(path.join(folder, '.git')), 'git lives in the folder the user picked');

  // A model's tool call: the change and its record land together.
  fs.writeFileSync(path.join(folder, 'index.html'), '<h1>ciao mondo</h1>\n');
  const recorded = await manager.gitAction(project.id, 'checkpoint', { tool: 'write_file' }, 'agent');
  assert.equal(recorded.changes, 0);
  assert.equal(recorded.commits, 2);
  // Named after what changed when nobody named it.
  assert.equal(recorded.last.message, 'index.html');
  assert.equal(recorded.last.source, 'agent');
  assert.equal(recorded.last.author, 'SynthOrg (modello)');

  // Still one branch, the one the folder started on.
  const branches = await manager.tryGit(project.id ? store.project(project.id) : null, ['branch', '--format=%(refname:short)']);
  assert.equal(branches, 'main');

  // Nothing to record is the normal answer, not an error.
  assert.equal((await manager.gitAction(project.id, 'checkpoint', {}, 'agent')).commits, 2);

  // Without a repository there is nowhere to push, and it says so.
  await assert.rejects(manager.gitAction(project.id, 'push', {}), error => error.status === 409);
});

test('opening a project says which step it is on while it runs, and nothing once it is done', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let release = null;
  const held = new Promise(resolve => { release = resolve; });
  const sandbox = {
    async ensureProjectContainer({ containerName, onPhase }) {
      onPhase('image');
      await held;
      onPhase('tools');
      return { containerName, volume: containerName, state: 'created', exec: { bin: 'podman', args: [] } };
    },
    async removeProjectContainer() { return { removed: true }; }
  };
  const manager = new ProjectManager({ store: () => store, sandbox });
  const project = await manager.create({ kind: 'podman', container: 'slow', image: 'node:22-alpine' });

  assert.deepEqual(manager.progress(project.id), { phase: null, since: null });
  const opening = manager.open(project.id);
  await new Promise(resolve => setImmediate(resolve));
  // What the page polls while the single open request is still in flight.
  const during = manager.progress(project.id);
  assert.equal(during.phase, 'image');
  assert.ok(typeof during.since === 'number');
  release();
  await opening;
  assert.deepEqual(manager.progress(project.id), { phase: null, since: null });
});

test('project container names cannot smuggle engine flags or reach chat containers', () => {
  assert.equal(assertProjectContainerName('synthorg-code-api'), 'synthorg-code-api');
  for (const bad of ['-v/:/host', 'synthorg-chat-abc', 'synthorg-code-', 'synthorg-code--rm', 'synthorg-code-a b', 'synthorg-code-A']) {
    assert.throws(() => assertProjectContainerName(bad), /non valido/);
  }
});

test('a database from before this change keeps its GitHub projects, as container projects with a repository', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-db-'));
  const file = path.join(dir, 'old.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('local','podman','github')),
    path TEXT NOT NULL, container_name TEXT UNIQUE, image TEXT,
    network INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, opened_at TEXT,
    repo TEXT, default_branch TEXT
  );`);
  legacy.exec(`INSERT INTO projects(id,name,kind,path,container_name,image,network,created_at,updated_at,repo,default_branch) VALUES
    ('a','octocat/app','github','/workspace','synthorg-code-app','alpine:latest',1,'t','t','octocat/app','main'),
    ('b','Cartella','local','C:/lavoro/sito',NULL,NULL,0,'t','t',NULL,NULL);`);
  legacy.close();

  const store = new Store(file);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const migrated = store.project('a');
  assert.equal(migrated.kind, 'podman');
  assert.equal(migrated.repo, 'octocat/app');
  assert.equal(migrated.container_name, 'synthorg-code-app');
  assert.equal(migrated.network, 1);
  // The branches it already pushed keep meaning what they meant.
  assert.equal(migrated.branch_prefix, 'synthorg');
  assert.equal(store.project('b').kind, 'local');
  // The kind is gone from the schema too, not only from the rows.
  const schema = store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'").get().sql;
  assert.ok(!schema.includes("'github'"), schema);
});

test('a Lab project: several environments together, one permission, a note, listed with the others', async t => {
  const { request } = await setup(t);
  const folder = tempDir(t);

  // A folder of this computer takes any of the environments, kept in their own order.
  const made = await request('/projects', 'POST', { kind: 'local', path: folder, name: 'Libro', envs: ['writing', 'code'], permission: 'semi', notes: '  prima stesura ' });
  assert.equal(made.status, 200);
  assert.equal(made.body.envs, '["code","writing"]');
  assert.equal(made.body.section, 'code');
  assert.equal(made.body.perm_code, 'semi');
  assert.equal(made.body.perm_terminal, 'semi');
  assert.equal(made.body.notes, 'prima stesura');

  // A pod takes every environment (Photo and Writing reach its files through its container: tests/photo.test.js,
  // tests/studio.test.js); what is refused is no environment, or one that does not exist.
  assert.equal((await request('/projects', 'POST', { kind: 'podman', name: 'pod', envs: [] })).status, 400);
  assert.equal((await request('/projects', 'POST', { kind: 'podman', name: 'pod', envs: ['video'] })).status, 400);
  assert.equal((await request('/projects', 'POST', { kind: 'podman', name: 'pod', envs: ['code'], permission: 'sempre' })).status, 400);
  const pod = await request('/projects', 'POST', { kind: 'podman', name: 'pod', envs: ['code'] });
  assert.equal(pod.status, 200);
  assert.equal(pod.body.perm_code, null, 'no permission given: the default of the settings');

  // A project made before the environments has the one its section stands for.
  const old = await request('/projects', 'POST', { kind: 'local', path: tempDir(t), name: 'Saggio', section: 'studio' });
  const all = (await request('/projects?section=all')).body;
  assert.deepEqual(Object.fromEntries(all.map(p => [p.name, p.envs])), { Libro: ['code', 'writing'], pod: ['code'], Saggio: ['writing'] });
  assert.deepEqual((await request('/projects')).body.map(p => p.name).sort(), ['Libro', 'pod']);

  // The text of a project with Writing on is the Studio's, whatever its first environment is.
  assert.equal((await request(`/projects/${made.body.id}/open`, 'POST', {})).status, 200);
  assert.equal((await request(`/studio/${made.body.id}/init`, 'POST', { title: 'Libro' })).status, 200);
  assert.equal((await request(`/studio/${pod.body.id}`)).status, 400);

  // The day on a card is the last change: the latest step of the record, or the making while there is none.
  fs.writeFileSync(path.join(folder, 'capitolo.md'), 'testo');
  assert.equal((await request(`/projects/${made.body.id}/git/checkpoint`, 'POST', {})).status, 200);
  const listed = Object.fromEntries((await request('/projects?section=all')).body.map(p => [p.name, p]));
  assert.notEqual(listed.Libro.modified_at, listed.Libro.created_at, 'a step moves the day of the last change');
  assert.equal(listed.pod.modified_at, listed.pod.created_at);

  // The note is changed and taken away from the card.
  assert.equal((await request(`/projects/${old.body.id}`, 'PATCH', { notes: 'da rivedere' })).body.notes, 'da rivedere');
  assert.equal((await request(`/projects/${old.body.id}`, 'PATCH', { notes: '' })).body.notes, null);
});

test('the files of a project, as the page\u2019s column reads and changes them: folders, search, new, move, remove', async t => {
  const { request } = await setup(t);
  const folder = tempDir(t);
  fs.mkdirSync(path.join(folder, 'src'));
  fs.writeFileSync(path.join(folder, 'src', 'main.js'), '1');
  fs.writeFileSync(path.join(folder, 'README.md'), 'ciao');
  const made = await request('/projects', 'POST', { kind: 'local', path: folder, name: 'File' });
  const id = made.body.id;
  assert.equal((await request(`/projects/${id}/open`, 'POST', {})).status, 200);
  const files = `/projects/${id}/files`;
  const dirs = list => `${files}?dirs=${encodeURIComponent(JSON.stringify(list))}`;

  // Folders first, the record never listed, a folder that is not there answered as such.
  const listed = (await request(dirs(['', 'src', 'manca']))).body.dirs;
  assert.deepEqual(listed[''], [{ name: 'src', dir: true }, { name: 'README.md', dir: false }]);
  assert.deepEqual(listed.src, [{ name: 'main.js', dir: false }]);
  assert.equal(listed.manca, null);

  // Nothing outside the project, and not its record.
  assert.equal((await request(dirs(['..']))).status, 400);
  assert.equal((await request(files, 'POST', { action: 'file', path: '../fuori.txt' })).status, 400);
  assert.equal((await request(files, 'POST', { action: 'remove', path: '.git' })).status, 403);

  // A new file and a new folder; the same name twice is refused.
  const created = await request(files, 'POST', { action: 'file', path: 'src/util/note.txt' });
  assert.equal(created.status, 200);
  assert.equal(fs.readFileSync(path.join(folder, 'src', 'util', 'note.txt'), 'utf8'), '');
  assert.equal((await request(files, 'POST', { action: 'file', path: 'src/util/note.txt' })).status, 409);
  assert.equal((await request(files, 'POST', { action: 'folder', path: 'docs' })).status, 200);

  // Moved, found by name, removed with what it holds; each a step of the user's.
  assert.equal((await request(files, 'POST', { action: 'rename', path: 'src/util', to: 'src/util' })).status, 400);
  assert.equal((await request(files, 'POST', { action: 'rename', path: 'src/util/note.txt', to: 'docs/appunti.txt' })).status, 200);
  assert.ok(fs.existsSync(path.join(folder, 'docs', 'appunti.txt')));
  assert.deepEqual((await request(`${files}/search?q=appunti`)).body.files, ['docs/appunti.txt']);
  assert.deepEqual((await request(`${files}/search?q=src%20main`)).body.files, ['src/main.js']);
  assert.equal((await request(files, 'POST', { action: 'remove', path: 'docs' })).status, 200);
  assert.ok(!fs.existsSync(path.join(folder, 'docs')));
  assert.equal((await request(files, 'POST', { action: 'remove', path: 'docs' })).status, 404);
  const steps = (await request(`/projects/${id}/history`)).body.commits;
  assert.ok(steps.some(step => /sposta src\/util\/note\.txt in docs\/appunti\.txt/.test(step.title) && step.source === 'user'), JSON.stringify(steps.map(s => s.title)));
});
