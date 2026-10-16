'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Store } = require('../server/database');
const { ProjectManager } = require('../server/projects');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

/**
 * A pod stood in for by a folder: its /workspace is `volume.dir`, and what the service runs in the container is run
 * here, with the git of this computer. Throwing the pod's disk away is giving it another, empty folder.
 */
function fakePod(t) {
  const volume = { dir: tempDir(t, 'synthorg-pod-volume-') };
  const tmp = tempDir(t, 'synthorg-pod-tmp-');
  const here = value => String(value).replace(/^\/workspace/, volume.dir).replace(/^\/tmp\//, tmp + path.sep);
  const run = (argv, { env = {}, input = null } = {}) => {
    const args = argv.map(arg => arg.startsWith('safe.directory=') ? `safe.directory=${volume.dir.replace(/\\/g, '/')}` : here(arg));
    const res = spawnSync(args[0], args.slice(1), { cwd: volume.dir, env: { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: '1' }, input: input ?? undefined, maxBuffer: 256 * 1024 * 1024 });
    return { ok: res.status === 0, stdout: res.stdout || Buffer.alloc(0), stderr: String(res.stderr || ''), error: res.status === 0 ? null : `uscita ${res.status}` };
  };
  const text = res => ({ ...res, stdout: res.stdout.toString('utf8') });
  const sandbox = {
    baseImages: null,
    async ensureProjectContainer(options) { return { containerName: options.containerName, volume: options.containerName, state: 'created', exec: { bin: 'podman', args: [] }, tools: { git: true, node: true } }; },
    async removeProjectContainer() { return { removed: true }; },
    async stopAllContainers() { return { success: true, count: 0 }; },
    async inspectWorkspace() { const entries = fs.readdirSync(volume.dir); return { repo: entries.includes('.git'), empty: entries.length === 0 }; },
    async execGit({ args, env }) {
      // The settings git is given name the pod's folder: here they name the folder that stands in for it.
      const mapped = Object.fromEntries(Object.entries(env || {}).map(([key, value]) => [key, value === '/workspace' ? volume.dir.replace(/\\/g, '/') : value]));
      return text(run(['git', ...args], { env: mapped }));
    },
    async execInContainer({ argv, input = null, encoding = 'utf8' }) {
      let res;
      if (argv[0] === 'sh' && /^cat > /.test(argv[2])) { fs.writeFileSync(here(argv[2].slice(6)), input); res = { ok: true, stdout: Buffer.alloc(0), stderr: '', error: null }; }
      else if (argv[0] === 'rm') { fs.rmSync(here(argv[argv.length - 1]), { force: true }); res = { ok: true, stdout: Buffer.alloc(0), stderr: '', error: null }; }
      else res = run(argv, { input });
      return encoding === 'buffer' ? res : text(res);
    }
  };
  return { sandbox, volume, write: (name, body) => { fs.mkdirSync(path.dirname(path.join(volume.dir, name)), { recursive: true }); fs.writeFileSync(path.join(volume.dir, name), body); } };
}
const gitIn = (dir, ...args) => String(spawnSync('git', ['--git-dir', dir, ...args], { encoding: 'utf8' }).stdout).trim();

test('a pod’s project is copied into the memory step by step, and an empty pod is filled again from the copy', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const pod = fakePod(t);
  const memory = tempDir(t, 'synthorg-memory-');
  const projects = new ProjectManager({ store: () => store, sandbox: pod.sandbox, dataDir: memory });
  projects.copyDelayMs = 20;
  const settle = () => new Promise(resolve => setTimeout(resolve, 900));
  const made = await projects.create({ kind: 'podman', name: 'App' });
  const row = () => store.project(made.id);
  const bare = projects.copyDir(row());

  // Opened: its record starts, and nothing is copied before there is a step.
  pod.write('README.md', 'ciao\n');
  pod.write('node_modules/x/index.js', 'non del progetto\n');
  pod.write('.gitignore', 'node_modules/\n');
  const opened = await projects.open(made.id);
  assert.equal(opened.git.ready, true, opened.git.error);
  assert.equal(opened.git.commits, 1);
  await settle();
  // The first step is in the memory: the record, not the folder, and nothing of what the project ignores.
  assert.ok(fs.existsSync(path.join(bare, 'HEAD')), 'la copia nella memoria');
  assert.equal(gitIn(bare, 'rev-list', '--count', 'main'), '1');
  assert.deepEqual(gitIn(bare, 'ls-tree', '-r', '--name-only', 'main').split('\n').sort(), ['.gitignore', 'README.md']);
  assert.equal(projects.memoryCopies().projects[0].copied, true);
  assert.equal(projects.memoryCopies().projects[0].error, null);

  // Another step, a branch: only what is new goes over, and the names are as in the pod.
  pod.write('src/main.js', 'console.log(1);\n');
  await projects.checkpoint(row(), { message: 'aggiunge main.js', source: 'user' });
  await projects.statusOf(row());
  await settle();
  assert.equal(gitIn(bare, 'rev-list', '--count', 'main'), '2');
  assert.equal(gitIn(bare, 'log', '-1', '--format=%s', 'main'), 'aggiunge main.js');
  const tip = gitIn(bare, 'rev-parse', 'main');

  // Turned off: steps are no longer copied; turned on again, the copy catches up.
  assert.equal(projects.setMemoryCopies(false).on, false);
  pod.write('src/due.js', '2\n');
  await projects.checkpoint(row(), { message: 'aggiunge due.js', source: 'agent' });
  await projects.statusOf(row());
  await settle();
  assert.equal(gitIn(bare, 'rev-parse', 'main'), tip, 'spenta, la copia resta com’era');
  assert.equal(projects.setMemoryCopies(true).on, true);
  await projects.statusOf(row());
  await settle();
  assert.equal(gitIn(bare, 'rev-list', '--count', 'main'), '3');

  // The disk of the pods is thrown away: the pod is empty. Opened, the project comes back from the memory, with its record.
  pod.volume.dir = tempDir(t, 'synthorg-pod-volume-new-');
  projects.copied.clear();
  const again = await projects.open(made.id);
  assert.equal(again.git.ready, true, again.git.error);
  assert.equal(again.git.commits, 3);
  assert.equal(again.git.branch, 'main');
  assert.equal(fs.readFileSync(path.join(pod.volume.dir, 'src', 'main.js'), 'utf8'), 'console.log(1);\n');
  assert.equal(fs.readFileSync(path.join(pod.volume.dir, 'src', 'due.js'), 'utf8'), '2\n');
  assert.ok(!fs.existsSync(path.join(pod.volume.dir, 'node_modules')), 'ciò che il progetto ignora non era nella copia');
  assert.equal(again.git.last.message, 'aggiunge due.js');
  // And the work goes on from there, copied as before.
  pod.write('src/tre.js', '3\n');
  await projects.checkpoint(row(), { message: 'aggiunge tre.js', source: 'user' });
  await projects.statusOf(row());
  await settle();
  assert.equal(gitIn(bare, 'rev-list', '--count', 'main'), '4');
});
