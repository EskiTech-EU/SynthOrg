'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { Store } = require('../server/database');
const { CodePermissions, leavesWorkdir, normalizeCommand, codeKey } = require('../server/code-permissions');

const TOKEN = 'synthorg-test-token';

function tempDir(t, prefix = 'synthorg-perm-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeSandbox(calls = []) {
  return {
    async ensureProjectContainer(options) {
      calls.push(['ensure', options]);
      return { containerName: options.containerName, volume: options.containerName, state: 'created', exec: { bin: 'podman', args: [] }, tools: { git: true, bash: true, node: true, agent: true, editor: true, error: null } };
    },
    async ensureProjectRunning(project) { calls.push(['running', project.container_name]); return project.container_name; },
    async execute(id, command, options) { calls.push(['exec', command, options]); return { stdout: `ran: ${command}`, stderr: '', exitCode: 0 }; },
    async removeProjectContainer(name) { calls.push(['remove', name]); return { removed: true }; },
    async stopAllContainers() { return { success: true, count: 0 }; }
  };
}

async function setup(t, calls = []) {
  const { server } = createApp({ token: TOKEN, dbPath: ':memory:', githubPort: 0, sandbox: fakeSandbox(calls) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (route, method = 'GET', data) => {
    const res = await fetch(base + route, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: res.status, body: await res.json() };
  };
  return { request, calls };
}

test('a command that reaches outside the working directory is recognised as such', () => {
  assert.equal(leavesWorkdir('npm test'), null);
  assert.equal(leavesWorkdir('ls -la /workspace/src && cat /workspace/README.md'), null);
  assert.equal(leavesWorkdir('node -e "console.log(1)"'), null);
  assert.equal(leavesWorkdir('cat /etc/passwd'), 'absolute');
  assert.equal(leavesWorkdir('rm -rf /'), 'absolute');
  assert.equal(leavesWorkdir('cp --target=/tmp/x a'), 'absolute');
  assert.equal(leavesWorkdir('cd .. && ls'), 'parent');
  assert.equal(leavesWorkdir('cat ../secrets'), 'parent');
  assert.equal(leavesWorkdir('ls ~'), 'home');
  assert.equal(leavesWorkdir('ls ~/.ssh'), 'home');
  assert.equal(leavesWorkdir('echo $HOME'), 'home');
  assert.equal(leavesWorkdir('ls', '/tmp'), 'cwd');
  assert.equal(leavesWorkdir('ls', '/workspace/src'), null);
  // a local project: the folder on this machine is the boundary, case-insensitive on Windows
  const win = 'C:\\Users\\samu\\progetti\\demo';
  assert.equal(leavesWorkdir('npm test', undefined, win), null);
  assert.equal(leavesWorkdir('type C:\\Users\\samu\\progetti\\demo\\src\\app.js', undefined, win), null);
  assert.equal(leavesWorkdir('type c:/users/samu/progetti/DEMO/README.md', undefined, win), null);
  assert.equal(leavesWorkdir('type C:\\Windows\\win.ini', undefined, win), 'absolute');
  assert.equal(leavesWorkdir('dir D:\\', undefined, win), 'absolute');
  assert.equal(leavesWorkdir('cd ..\\altro', undefined, win), 'parent');
  assert.equal(leavesWorkdir('echo %USERPROFILE%', undefined, win), 'home');
  assert.equal(leavesWorkdir('ls $env:USERPROFILE', undefined, win), 'home');
  assert.equal(leavesWorkdir('ls', 'C:\\Users\\samu', win), 'cwd');
  assert.equal(leavesWorkdir('ls', 'C:\\Users\\samu\\progetti\\demo\\src', win), null);
  assert.equal(normalizeCommand('  npm   run\tbuild '), 'npm run build');
  assert.equal(codeKey('edit_file', { path: './src/app.js' }), 'modifica:src/app.js');
  assert.equal(codeKey('overwrite_file', { path: 'src\\app.js' }), 'modifica:src/app.js');
  assert.equal(codeKey('create_file', { path: 'src/new.js' }), 'struttura:src/new.js');
});

test('the three modes decide as promised, and the code remembers per file and kind of operation', () => {
  const store = new Store(':memory:');
  const project = store.createProject({ name: 'p', kind: 'podman', path: '/workspace', containerName: 'synthorg-code-p' });
  const perms = new CodePermissions({ store: () => store });
  const edit = { name: 'edit_file', input: { path: 'src/app.js', from_line: 1, content: 'x' } };
  const create = { name: 'create_file', input: { path: 'src/new.js', content: 'x' } };
  const read = { name: 'read_file', input: { path: 'src/app.js' } };

  // defaults: manual on both, from the settings when the project has none
  assert.deepEqual(perms.modes(project), { code: 'manual', terminal: 'manual' });
  assert.equal(perms.evaluate(project, 'code', read).verdict, 'allow', 'reading never asks');
  assert.equal(perms.evaluate(project, 'code', edit).reason, 'manual');
  assert.equal(perms.evaluate(project, 'terminal', { command: 'npm test' }).reason, 'manual');

  store.setSetting('code_perm_code', 'auto');
  assert.equal(perms.evaluate(store.project(project.id), 'code', edit).verdict, 'allow');
  // the project's own mode beats the default
  store.setProjectPermissions(project.id, { code: 'semi', terminal: 'semi' });
  let p = store.project(project.id);
  const first = perms.evaluate(p, 'code', edit);
  assert.deepEqual([first.verdict, first.reason, first.remember], ['ask', 'new', true]);
  store.addApproval(p.id, 'code', first.key, 'edit_file src/app.js');
  assert.equal(perms.evaluate(p, 'code', edit).reason, 'remembered');
  assert.equal(perms.evaluate(p, 'code', { name: 'overwrite_file', input: { path: 'src/app.js', content: '' } }).verdict, 'allow', 'same file, same kind: a change');
  assert.equal(perms.evaluate(p, 'code', { name: 'delete_file', input: { path: 'src/app.js' } }).reason, 'structure', 'deleting is never remembered in semi');
  assert.equal(perms.evaluate(p, 'code', create).reason, 'structure');

  const cmd = perms.evaluate(p, 'terminal', { command: 'npm  test' });
  assert.deepEqual([cmd.verdict, cmd.reason, cmd.key], ['ask', 'new', 'npm test']);
  store.addApproval(p.id, 'terminal', cmd.key, cmd.key);
  assert.equal(perms.evaluate(p, 'terminal', { command: 'npm test' }).verdict, 'allow');
  assert.equal(perms.evaluate(p, 'terminal', { command: 'npm test -- --watch' }).verdict, 'ask', 'a different command is a new one');

  store.setProjectPermissions(project.id, { terminal: 'auto' });
  p = store.project(project.id);
  assert.equal(perms.evaluate(p, 'terminal', { command: 'rm -rf build' }).verdict, 'allow');
  assert.equal(perms.evaluate(p, 'terminal', { command: 'cat /etc/hosts' }).reason, 'outside', 'outside the workdir asks even in auto');
  assert.throws(() => store.setProjectPermissions(project.id, { code: 'sempre' }), /Modalità non valida/);
  // the list is per project and goes with it
  assert.equal(store.listApprovals(project.id).length, 2);
  store.removeApproval(project.id, store.listApprovals(project.id)[0].id);
  assert.equal(store.listApprovals(project.id).length, 1);
  store.deleteProject(project.id);
  assert.equal(store.listApprovals(project.id).length, 0);
});

test('a pending request runs the action only when the user approves it, and a refusal runs nothing', async () => {
  const store = new Store(':memory:');
  const project = store.createProject({ name: 'p', kind: 'podman', path: '/workspace', containerName: 'synthorg-code-q' });
  const perms = new CodePermissions({ store: () => store, ttlMs: 50 });
  let runs = 0;
  const run = async () => { runs++; return { done: true }; };
  const asked = await perms.gate(project, 'terminal', { command: 'make' }, run);
  assert.equal(asked.pending, true);
  assert.equal(asked.approval.summary.detail, 'make');
  assert.equal(runs, 0, 'nothing runs before the answer');
  assert.deepEqual(await perms.decide(project.id, asked.approval.id, 'deny'), { approved: false });
  assert.equal(runs, 0);
  await assert.rejects(() => perms.decide(project.id, asked.approval.id, 'allow'), /scaduta o inesistente/, 'an answered request is gone');
  const again = await perms.gate(project, 'terminal', { command: 'make' }, run);
  const answer = await perms.decide(project.id, again.approval.id, 'allow');
  assert.deepEqual(answer, { approved: true, result: { done: true } });
  assert.equal(runs, 1);
  assert.equal(store.listApprovals(project.id).length, 0, 'manual mode remembers nothing');
  // a request nobody answers expires
  const late = await perms.gate(project, 'terminal', { command: 'make' }, run);
  await new Promise(resolve => setTimeout(resolve, 80));
  await assert.rejects(() => perms.decide(project.id, late.approval.id, 'allow'), /scaduta/);
  // another project cannot answer for this one
  const other = store.createProject({ name: 'o', kind: 'podman', path: '/workspace', containerName: 'synthorg-code-o' });
  const mine = await perms.gate(project, 'terminal', { command: 'make' }, run);
  await assert.rejects(() => perms.decide(other.id, mine.approval.id, 'allow'), /scaduta o inesistente/);
});

test('over the API: the tools and the commands of a project wait for the user according to its modes', async t => {
  const calls = [];
  const { request } = await setup(t, calls);
  const folder = tempDir(t);
  const created = await request('/projects', 'POST', { name: 'perm', kind: 'local', path: folder });
  assert.equal(created.status, 200);
  const id = created.body.id;
  await request(`/projects/${id}/open`, 'POST', {});

  // manual by default: a creation is parked, not written
  let res = await request(`/projects/${id}/tools/create_file`, 'POST', { path: 'a.txt', content: 'uno\n' });
  assert.equal(res.status, 200);
  assert.equal(res.body.pending, true);
  assert.equal(res.body.approval.reason, 'manual');
  assert.equal(res.body.approval.summary.title, 'create');
  assert.ok(!fs.existsSync(path.join(folder, 'a.txt')), 'nothing written before the answer');
  let listed = await request(`/projects/${id}/approvals`);
  assert.equal(listed.body.pending.length, 1);
  res = await request(`/projects/${id}/approvals/${res.body.approval.id}`, 'POST', { decision: 'deny' });
  assert.deepEqual(res.body, { approved: false });
  assert.ok(!fs.existsSync(path.join(folder, 'a.txt')));
  res = await request(`/projects/${id}/tools/create_file`, 'POST', { path: 'a.txt', content: 'uno\n' });
  res = await request(`/projects/${id}/approvals/${res.body.approval.id}`, 'POST', { decision: 'allow' });
  assert.equal(res.body.approved, true);
  assert.equal(res.body.result.created, true);
  assert.equal(fs.readFileSync(path.join(folder, 'a.txt'), 'utf8'), 'uno\n');
  // reading never asks
  res = await request(`/projects/${id}/tools/read_file`, 'POST', { path: 'a.txt' });
  assert.equal(res.body.pending, undefined);
  assert.match(res.body.content, /uno/);

  // semi: the first change to a file asks, the next one to the same file passes
  res = await request(`/projects/${id}`, 'PATCH', { permissions: { code: 'semi' } });
  assert.equal(res.body.perm_code, 'semi');
  res = await request(`/projects/${id}/tools/edit_file`, 'POST', { path: 'a.txt', from_line: 1, content: 'due' });
  assert.equal(res.body.approval.reason, 'new');
  assert.equal(res.body.approval.remember, true);
  await request(`/projects/${id}/approvals/${res.body.approval.id}`, 'POST', { decision: 'allow' });
  assert.equal(fs.readFileSync(path.join(folder, 'a.txt'), 'utf8'), 'due\n');
  res = await request(`/projects/${id}/tools/edit_file`, 'POST', { path: 'a.txt', from_line: 1, content: 'tre' });
  assert.equal(res.body.pending, undefined, 'the same file passes now');
  assert.equal(fs.readFileSync(path.join(folder, 'a.txt'), 'utf8'), 'tre\n');
  res = await request(`/projects/${id}/tools/delete_file`, 'POST', { path: 'a.txt' });
  assert.equal(res.body.approval.reason, 'structure');
  listed = await request(`/projects/${id}/approvals`);
  assert.equal(listed.body.remembered.length, 1);
  assert.equal(listed.body.remembered[0].key, 'modifica:a.txt');
  assert.deepEqual(listed.body.modes, { code: 'semi', terminal: 'manual' });
  await request(`/projects/${id}/approvals/${listed.body.remembered[0].id}`, 'DELETE');
  listed = await request(`/projects/${id}/approvals`);
  assert.equal(listed.body.remembered.length, 0);
  res = await request(`/projects/${id}/tools/edit_file`, 'POST', { path: 'a.txt', from_line: 1, content: 'quattro' });
  assert.equal(res.body.pending, true, 'forgotten: it asks again');

  // auto: nothing asks
  await request(`/projects/${id}`, 'PATCH', { permissions: { code: 'auto' } });
  res = await request(`/projects/${id}/tools/create_file`, 'POST', { path: 'b.txt', content: 'b' });
  assert.equal(res.body.created, true);
  res = await request(`/projects/${id}`, 'PATCH', { permissions: { code: 'sempre' } });
  assert.equal(res.status, 400);

  // a local project's command runs in the editor's terminal from the page: the service only settles the permission
  res = await request(`/projects/${id}/terminal/gate`, 'POST', { command: 'npm test' });
  assert.equal(res.body.pending, true, 'manual by default');
  assert.equal(res.body.approval.kind, 'terminal');
  res = await request(`/projects/${id}/approvals/${res.body.approval.id}`, 'POST', { decision: 'allow' });
  assert.deepEqual(res.body, { approved: true, result: { allowed: true } });
  await request(`/projects/${id}`, 'PATCH', { permissions: { terminal: 'auto' } });
  res = await request(`/projects/${id}/terminal/gate`, 'POST', { command: 'npm test' });
  assert.deepEqual(res.body, { allowed: true });
  res = await request(`/projects/${id}/terminal/gate`, 'POST', { command: `type ${path.join(os.homedir(), 'x.txt')}` });
  assert.equal(res.body.approval?.reason, 'outside', 'the project folder is the boundary of a local project');
  res = await request(`/projects/${id}/terminal/gate`, 'POST', { command: '   ' });
  assert.equal(res.status, 400);
  const tree = await request(`/projects/${id}/tree`);
  assert.equal(tree.body.runsCommands, true);
  assert.equal(tree.body.commandsIn, 'editor');

  // the terminal of a container project: the chat's command goes through the project's terminal mode
  const pod = await request('/projects', 'POST', { name: 'pod', kind: 'podman', container: 'permpod', network: false });
  await request(`/projects/${pod.body.id}/open`, 'POST', {});
  const chat = await request('/conversations', 'POST', { projectId: pod.body.id });
  res = await request(`/conversations/${chat.body.id}/sandbox/exec`, 'POST', { command: 'npm test' });
  assert.equal(res.body.pending, true);
  assert.equal(res.body.approval.kind, 'terminal');
  assert.ok(!calls.some(c => c[0] === 'exec'), 'not run before the answer');
  res = await request(`/projects/${pod.body.id}/approvals/${res.body.approval.id}`, 'POST', { decision: 'allow' });
  assert.equal(res.body.result.stdout, 'ran: npm test');
  await request(`/projects/${pod.body.id}`, 'PATCH', { permissions: { terminal: 'auto' } });
  res = await request(`/conversations/${chat.body.id}/sandbox/exec`, 'POST', { command: 'npm run build' });
  assert.equal(res.body.stdout, 'ran: npm run build');
  res = await request(`/conversations/${chat.body.id}/sandbox/exec`, 'POST', { command: 'cat /etc/passwd' });
  assert.equal(res.body.approval.reason, 'outside', 'outside the workdir asks even in auto');
  // the settings hold the defaults for projects that never set their own
  await request('/settings/code_perm_terminal', 'PUT', { value: 'auto' });
  const fresh = await request('/projects', 'POST', { name: 'pod2', kind: 'podman', container: 'permpod2', network: false });
  listed = await request(`/projects/${fresh.body.id}/approvals`);
  assert.deepEqual(listed.body.modes, { code: 'manual', terminal: 'auto' });
});
