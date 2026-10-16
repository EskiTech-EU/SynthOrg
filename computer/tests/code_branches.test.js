'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Store } = require('../server/database');
const { ProjectManager } = require('../server/projects');

// Real git, with a bare repository in a folder standing in for GitHub: what is
// tested is what git actually does to the branches, here and there.

function tempDir(t, prefix = 'synthorg-branches-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Altro', '-c', 'user.email=altro@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, env: CLEAN_ENV, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** "GitHub": a bare repository with main and dev, and a clone of it someone else works in. */
function fakeRemote(t) {
  const bare = path.join(tempDir(t, 'synthorg-remote-'), 'app.git');
  fs.mkdirSync(bare);
  git(bare, 'init', '--bare', '-b', 'main');
  const other = tempDir(t, 'synthorg-other-');
  git(other, 'clone', bare, '.');
  fs.writeFileSync(path.join(other, 'README.md'), 'uno\n');
  git(other, 'add', '--all');
  git(other, 'commit', '-m', 'primo');
  git(other, 'push', 'origin', 'HEAD:main');
  git(other, 'switch', '-c', 'dev');
  fs.writeFileSync(path.join(other, 'dev.txt'), 'dev\n');
  git(other, 'add', '--all');
  git(other, 'commit', '-m', 'lavoro su dev');
  git(other, 'push', 'origin', 'dev');
  git(other, 'switch', 'main');
  const branches = () => git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split(/\r?\n/).filter(Boolean);
  /** Someone else adds a step to a branch on GitHub. */
  const commit = (branch, file, text) => {
    git(other, 'fetch', 'origin');
    git(other, 'switch', '-C', branch, `origin/${branch}`);
    fs.writeFileSync(path.join(other, file), text);
    git(other, 'add', '--all');
    git(other, 'commit', '-m', `altro: ${file}`);
    git(other, 'push', 'origin', branch);
  };
  return { bare, other, branches, commit, head: branch => git(bare, 'rev-parse', `refs/heads/${branch}`) };
}

function setup(t) {
  const store = new Store(':memory:');
  const remote = fakeRemote(t);
  const github = {
    async getRepository(name) { return { full_name: name, name: name.split('/')[1], default_branch: 'main', html_url: `https://github.com/${name}`, canPush: true }; },
    async token() { return 'ghu_test'; },
    async listBranches() { return remote.branches(); }
  };
  class Manager extends ProjectManager {
    remoteUrl(project) { super.remoteUrl(project); return remote.bare; }
  }
  const manager = new Manager({
    store: () => store, sandbox: {}, github, dataDir: tempDir(t, 'synthorg-data-'),
    gitConfig: [['protocol.file.allow', 'always']]
  });
  t.after(() => { manager.stopSyncs(); store.close(); });
  return { store, remote, manager };
}

const write = (folder, file, text) => fs.writeFileSync(path.join(folder, file), text);
const read = (folder, file) => fs.readFileSync(path.join(folder, file), 'utf8');
const here = (folder, ...args) => git(folder, ...args);

test('the whole repository: every branch is there to move between, and each goes up and down under its own name', async t => {
  const { store, remote, manager } = setup(t);
  const folder = tempDir(t);
  const project = await manager.create({ kind: 'local', path: folder, name: 'App', repo: 'octocat/app' });
  const opened = await manager.open(project.id);
  assert.equal(opened.git.ready, true, opened.git.error);
  assert.equal(opened.git.mode, 'full');
  assert.equal(opened.git.branch, 'main');
  assert.equal(opened.git.onGithub, true);
  assert.equal(opened.git.unpushed, 0);
  assert.equal(opened.git.behind, 0);

  // Both branches are listed, the main one first; dev is only on GitHub so far.
  let listed = await manager.gitAction(project.id, 'branches', {});
  assert.deepEqual(listed.branches.map(b => [b.name, b.current, b.local, b.onGithub]), [['main', true, true, true], ['dev', false, false, true]]);

  // Moving to dev records what was being written on main, on main.
  write(folder, 'bozza.txt', 'a metà\n');
  const onDev = await manager.gitAction(project.id, 'switch', { branch: 'dev' });
  assert.equal(onDev.branch, 'dev');
  assert.equal(onDev.changes, 0);
  assert.equal(read(folder, 'dev.txt'), 'dev\n');
  assert.ok(!fs.existsSync(path.join(folder, 'bozza.txt')), 'the draft stayed on the branch it was written on');
  assert.equal(store.project(project.id).work_branch, 'dev');

  // Work on dev goes up to dev and nowhere else.
  const mainBefore = remote.head('main');
  write(folder, 'dev.txt', 'dev, cambiato qui\n');
  const sent = await manager.gitAction(project.id, 'push', {});
  assert.equal(sent.pushed.branch, 'dev');
  assert.equal(sent.unpushed, 0);
  assert.equal(remote.head('dev'), here(folder, 'rev-parse', 'HEAD'));
  assert.equal(remote.head('main'), mainBefore, 'main on GitHub was not touched');

  // Back on main the draft is there, one step to upload.
  const onMain = await manager.gitAction(project.id, 'switch', { branch: 'main' });
  assert.equal(read(folder, 'bozza.txt'), 'a metà\n');
  assert.equal(onMain.unpushed, 1);

  // A new branch exists here only, until the first upload.
  const fresh = await manager.gitAction(project.id, 'new-branch', { name: 'idea/nuova' });
  assert.equal(fresh.branch, 'idea/nuova');
  assert.equal(fresh.onGithub, false);
  assert.ok(!remote.branches().includes('idea/nuova'));
  await assert.rejects(manager.gitAction(project.id, 'new-branch', { name: 'dev' }), error => error.status === 409);
  const created = await manager.gitAction(project.id, 'push', {});
  assert.equal(created.onGithub, true);
  assert.ok(remote.branches().includes('idea/nuova'));

  // Someone else adds to dev on GitHub: download brings it here, on dev.
  remote.commit('dev', 'altro.txt', 'di un altro\n');
  await manager.gitAction(project.id, 'switch', { branch: 'dev' });
  const got = await manager.gitAction(project.id, 'pull', {});
  assert.equal(got.pulled, 1);
  assert.equal(got.behind, 0);
  assert.equal(read(folder, 'altro.txt'), 'di un altro\n');

  await assert.rejects(manager.gitAction(project.id, 'switch', { branch: 'non-esiste' }), error => error.status === 404);
});

test('one branch only: just that one is downloaded, and upload and download stay on it', async t => {
  const { remote, manager } = setup(t);
  const folder = tempDir(t);
  const project = await manager.create({ kind: 'local', path: folder, name: 'App', repo: 'octocat/app', repoMode: 'branch', repoBranch: 'dev' });
  const opened = await manager.open(project.id);
  assert.equal(opened.git.ready, true, opened.git.error);
  assert.equal(opened.git.mode, 'branch');
  assert.equal(opened.git.branch, 'dev');
  // Main never came down.
  assert.equal(here(folder, 'for-each-ref', '--format=%(refname)', 'refs/remotes'), 'refs/remotes/origin/dev');
  const listed = await manager.gitAction(project.id, 'branches', { fetch: true });
  assert.deepEqual(listed.branches.map(b => b.name), ['dev']);
  assert.equal(here(folder, 'for-each-ref', '--format=%(refname)', 'refs/remotes'), 'refs/remotes/origin/dev');

  const mainBefore = remote.head('main');
  write(folder, 'solo-dev.txt', 'x\n');
  const sent = await manager.gitAction(project.id, 'push', {});
  assert.equal(sent.pushed.branch, 'dev');
  assert.equal(remote.head('main'), mainBefore);

  remote.commit('dev', 'altro.txt', 'di un altro\n');
  remote.commit('main', 'su-main.txt', 'non riguarda questo progetto\n');
  const got = await manager.gitAction(project.id, 'pull', {});
  assert.equal(got.pulled, 1);
  assert.ok(!fs.existsSync(path.join(folder, 'su-main.txt')));
});

test('one branch that GitHub does not have yet starts from the main one, under its own name', async t => {
  const { remote, manager } = setup(t);
  const folder = tempDir(t);
  const project = await manager.create({ kind: 'local', path: folder, name: 'App', repo: 'octocat/app', repoMode: 'branch', repoBranch: 'mio/lavoro' });
  const opened = await manager.open(project.id);
  assert.equal(opened.git.ready, true, opened.git.error);
  assert.equal(opened.git.branch, 'mio/lavoro');
  assert.equal(opened.git.onGithub, false);
  assert.equal(read(folder, 'README.md'), 'uno\n');
  assert.ok(!remote.branches().includes('mio/lavoro'));
  const mainBefore = remote.head('main');
  await manager.gitAction(project.id, 'push', {});
  assert.ok(remote.branches().includes('mio/lavoro'));
  assert.equal(remote.head('main'), mainBefore, 'working off main never touches main');
});

test('when both sides have steps of their own nothing moves until the user chooses', async t => {
  const { store, remote, manager } = setup(t);
  const folder = tempDir(t);
  const project = await manager.create({ kind: 'local', path: folder, name: 'App', repo: 'octocat/app' });
  await manager.open(project.id);

  const diverge = async () => {
    write(folder, 'mio.txt', `mio ${Date.now()}\n`);
    await manager.gitAction(project.id, 'checkpoint', {});
    remote.commit('main', 'suo.txt', `suo ${Date.now()}\n`);
  };

  await diverge();
  const mine = here(folder, 'rev-parse', 'HEAD');
  const theirs = remote.head('main');

  // Upload is refused, never forced.
  const refused = await manager.gitAction(project.id, 'push', {});
  assert.equal(refused.rejected, true);
  assert.equal(refused.diverged, true);
  assert.equal(remote.head('main'), theirs);
  // Download says the two are different and touches nothing.
  const stopped = await manager.gitAction(project.id, 'pull', {});
  assert.equal(stopped.pulled, 0);
  assert.equal(stopped.diverged, true);
  assert.deepEqual([stopped.unpushed, stopped.behind], [1, 1]);
  assert.equal(here(folder, 'rev-parse', 'HEAD'), mine);
  assert.ok(!fs.existsSync(path.join(folder, 'suo.txt')));

  // Choice one: the work here goes on under a new name; main goes back to what GitHub has.
  await assert.rejects(manager.gitAction(project.id, 'resolve', { keep: 'branch', name: 'dev' }), error => error.status === 409);
  await assert.rejects(manager.gitAction(project.id, 'resolve', { keep: 'altro' }), error => error.status === 400);
  const moved = await manager.gitAction(project.id, 'resolve', { keep: 'branch', name: 'mio/lavoro' });
  assert.equal(moved.branch, 'mio/lavoro');
  assert.equal(moved.diverged, false);
  assert.equal(moved.onGithub, false);
  assert.equal(here(folder, 'rev-parse', 'HEAD'), mine);
  assert.equal(here(folder, 'rev-parse', 'refs/heads/main'), theirs);
  assert.ok(fs.existsSync(path.join(folder, 'mio.txt')));
  assert.equal(remote.head('main'), theirs);

  // Choice two: the branch becomes what GitHub has, and the steps made here are kept aside, not destroyed.
  await manager.gitAction(project.id, 'switch', { branch: 'main' });
  await diverge();
  const mineAgain = here(folder, 'rev-parse', 'HEAD');
  const kept = await manager.gitAction(project.id, 'resolve', { keep: 'github' });
  assert.equal(kept.diverged, false);
  assert.deepEqual([kept.unpushed, kept.behind], [0, 0]);
  assert.equal(here(folder, 'rev-parse', 'HEAD'), remote.head('main'));
  assert.ok(fs.existsSync(path.join(folder, 'suo.txt')));
  assert.equal(here(folder, 'for-each-ref', '--format=%(objectname)', 'refs/synthorg/kept'), mineAgain);

  // In a project that follows one branch, the new name becomes the branch it follows.
  const single = tempDir(t);
  const second = await manager.create({ kind: 'local', path: single, name: 'Solo', repo: 'octocat/app', repoMode: 'branch', repoBranch: 'dev' });
  await manager.open(second.id);
  write(single, 'mio.txt', 'mio\n');
  await manager.gitAction(second.id, 'checkpoint', {});
  remote.commit('dev', 'suo-dev.txt', 'suo\n');
  assert.equal((await manager.gitAction(second.id, 'pull', {})).diverged, true);
  const renamed = await manager.gitAction(second.id, 'resolve', { keep: 'branch', name: 'dev-mio' });
  assert.equal(renamed.branch, 'dev-mio');
  assert.equal(store.project(second.id).repo_branch, 'dev-mio');
  assert.equal((await manager.gitAction(second.id, 'push', {})).pushed.branch, 'dev-mio');
});

test('automatic sync is one switch per branch: off unless turned on, then every step goes up and opening downloads', async t => {
  const { store, remote, manager } = setup(t);
  const folder = tempDir(t);
  const project = await manager.create({ kind: 'local', path: folder, name: 'App', repo: 'octocat/app' });
  await manager.open(project.id);
  // The automatic upload as the timer would run it, once the one in flight (if any) is done.
  const upload = async () => {
    while (manager.syncs.get(project.id)?.busy) await new Promise(resolve => setTimeout(resolve, 50));
    await manager.runAutoPush(project.id);
  };

  // Off: a recorded step stays here.
  write(folder, 'a.txt', 'a\n');
  const before = remote.head('main');
  assert.equal((await manager.gitAction(project.id, 'checkpoint', {})).auto, false);
  assert.equal(manager.syncs.get(project.id), undefined);
  assert.equal(remote.head('main'), before);

  // Turned on for main: it is brought in step at once.
  const on = await manager.gitAction(project.id, 'sync', { auto: true });
  assert.equal(on.auto, true);
  assert.equal(on.unpushed, 0);
  assert.equal(remote.head('main'), here(folder, 'rev-parse', 'HEAD'));
  assert.deepEqual(JSON.parse(store.project(project.id).auto_sync), ['main']);

  // From then on a recorded step goes up by itself.
  write(folder, 'b.txt', 'b\n');
  await manager.gitAction(project.id, 'checkpoint', {});
  await upload();
  assert.equal(remote.head('main'), here(folder, 'rev-parse', 'HEAD'));
  assert.equal(manager.syncOf(project.id).error, null);

  // The switch is of the branch: dev, in the same project, does not sync.
  const onDev = await manager.gitAction(project.id, 'switch', { branch: 'dev' });
  assert.equal(onDev.auto, false);
  const devBefore = remote.head('dev');
  write(folder, 'c.txt', 'c\n');
  await manager.gitAction(project.id, 'checkpoint', {});
  await upload();
  assert.equal(remote.head('dev'), devBefore);

  // Opening downloads what GitHub got meanwhile, on the branch that syncs.
  await manager.gitAction(project.id, 'switch', { branch: 'main' });
  remote.commit('main', 'nuovo.txt', 'arrivato da GitHub\n');
  const reopened = await manager.open(project.id);
  assert.equal(reopened.git.behind, 0);
  assert.equal(read(folder, 'nuovo.txt'), 'arrivato da GitHub\n');

  // Different on the two sides: the automatic upload is refused like the manual one, and nothing is forced.
  write(folder, 'd.txt', 'd\n');
  remote.commit('main', 'altro.txt', 'x\n');
  const theirs = remote.head('main');
  await manager.gitAction(project.id, 'checkpoint', {});
  await upload();
  assert.equal(remote.head('main'), theirs);
  assert.equal((await manager.gitStatus(project.id)).diverged, true);

  // Off again, and unlinking forgets the switches.
  assert.equal((await manager.gitAction(project.id, 'sync', { auto: false })).auto, false);
  assert.equal(store.project(project.id).auto_sync, null);
  await manager.gitAction(project.id, 'sync', { auto: true, branch: 'dev' });
  await manager.gitAction(project.id, 'unlink', {});
  assert.equal(store.project(project.id).auto_sync, null);
});

test('linking a repository to a project that already has a history never replaces the work here', async t => {
  const { store, remote, manager } = setup(t);
  const folder = tempDir(t);
  write(folder, 'mio.txt', 'lavoro mio\n');
  const project = await manager.create({ kind: 'local', path: folder, name: 'Mio' });
  await manager.open(project.id);
  assert.equal((await manager.gitStatus(project.id)).mode, null);

  // The whole repository: its branches come down, the project stays where it is.
  const linked = await manager.gitAction(project.id, 'link', { repo: 'octocat/app', mode: 'full' });
  assert.equal(linked.mode, 'full');
  assert.equal(linked.branch, 'main');
  assert.equal(read(folder, 'mio.txt'), 'lavoro mio\n');
  // Nothing in common with GitHub's main: shown as different, for the user to decide.
  assert.equal(linked.diverged, true);
  assert.deepEqual((await manager.gitAction(project.id, 'branches', {})).branches.map(b => b.name), ['main', 'dev']);

  // One branch that is new on GitHub: it starts from where the project is.
  const single = await manager.gitAction(project.id, 'link', { repo: 'octocat/app', mode: 'branch', branch: 'mio/ramo' });
  assert.equal(single.mode, 'branch');
  assert.equal(single.branch, 'mio/ramo');
  assert.equal(single.onGithub, false);
  assert.equal(read(folder, 'mio.txt'), 'lavoro mio\n');
  await manager.gitAction(project.id, 'push', {});
  assert.ok(remote.branches().includes('mio/ramo'));
  assert.equal(store.project(project.id).repo_branch, 'mio/ramo');

  // An empty folder linked later simply becomes the branch asked for.
  const empty = tempDir(t);
  const blank = await manager.create({ kind: 'local', path: empty, name: 'Vuoto' });
  await manager.open(blank.id);
  const filled = await manager.gitAction(blank.id, 'link', { repo: 'octocat/app', mode: 'branch', branch: 'dev' });
  assert.equal(filled.branch, 'dev');
  assert.equal(read(empty, 'dev.txt'), 'dev\n');
  assert.deepEqual([filled.unpushed, filled.behind], [0, 0]);
});
