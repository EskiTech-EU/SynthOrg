'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

// What the phone's pages of a project ask of the computer: one file whole, a file written whole (by hand, or brought
// from the phone), one artifact to look at. Every write is a step of the user's in the record.
const TOKEN = 'phone-files';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-phone-files-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

async function setup(t) {
  const { server } = createApp({ token: TOKEN, dbPath: ':memory:', githubPort: 0, sandbox: { async stopAllContainers() { return { success: true, count: 0 }; }, async deleteWorkspace() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (url, method = 'GET', body) => {
    const res = await fetch(base + url, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { request };
}

test('a file of a folder project is read whole and written whole from afar, each write a step of the user’s', async t => {
  const { request } = await setup(t);
  const folder = tempDir(t);
  fs.mkdirSync(path.join(folder, 'src'));
  fs.writeFileSync(path.join(folder, 'src', 'app.js'), 'console.log(1);\n');
  const project = (await request('/projects', 'POST', { kind: 'local', path: folder })).body;
  assert.ok(project.id);
  // Opened once: that is when a folder project gets its record (projects.open, prepareGit).
  assert.equal((await request(`/projects/${project.id}/open`, 'POST', {})).status, 200);

  const read = await request(`/projects/${project.id}/files/read?path=${encodeURIComponent('src/app.js')}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, { path: 'src/app.js', size: 16, text: true, content: 'console.log(1);\n', base64: null });

  // Changed by hand, as text: on disk, and in the record as the user's step.
  const written = await request(`/projects/${project.id}/files/write`, 'POST', { path: 'src/app.js', content: 'console.log(2);\n' });
  assert.equal(written.status, 200);
  assert.equal(written.body.size, 16);
  assert.equal(fs.readFileSync(path.join(folder, 'src', 'app.js'), 'utf8'), 'console.log(2);\n');
  const history = (await request(`/projects/${project.id}/history`)).body;
  assert.ok(history.commits.some(commit => commit.title === 'scrive src/app.js' && commit.source === 'user'), JSON.stringify(history.commits.map(c => c.title)));

  // Brought from the phone, as bytes: a new file in a new folder, read back as not text.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const put = await request(`/projects/${project.id}/files/write`, 'POST', { path: 'docs/foto.png', base64: png.toString('base64') });
  assert.equal(put.status, 200);
  assert.ok(fs.readFileSync(path.join(folder, 'docs', 'foto.png')).equals(png));
  const back = (await request(`/projects/${project.id}/files/read?path=${encodeURIComponent('docs/foto.png')}`)).body;
  assert.equal(back.text, false);
  assert.equal(back.content, null);
  assert.equal(Buffer.from(back.base64, 'base64').equals(png), true);

  // In a folder project the artifacts are its files: the picture is one, read with what it is.
  const artifacts = (await request(`/projects/${project.id}/artifacts`)).body;
  assert.ok(artifacts.files.some(file => file.path === 'docs/foto.png' && file.kind === 'image'));
  const artifact = (await request(`/projects/${project.id}/artifacts/read?path=${encodeURIComponent('docs/foto.png')}`)).body;
  assert.equal(artifact.kind, 'image');
  assert.equal(artifact.tooLarge, false);
  assert.equal(Buffer.from(artifact.base64, 'base64').equals(png), true);

  // What is refused: a path out of the project, a folder, a missing file, nothing to write, the record itself.
  assert.equal((await request(`/projects/${project.id}/files/read?path=${encodeURIComponent('../fuori.txt')}`)).status, 400);
  assert.equal((await request(`/projects/${project.id}/files/read?path=src`)).status, 400);
  assert.equal((await request(`/projects/${project.id}/files/read?path=manca.txt`)).status, 404);
  assert.equal((await request(`/projects/${project.id}/files/write`, 'POST', { path: 'x.txt' })).status, 400);
  assert.equal((await request(`/projects/${project.id}/files/write`, 'POST', { path: '.git/config', content: 'x' })).status, 403);
  assert.equal((await request(`/projects/${project.id}/artifacts/read?path=manca.png`)).status, 404);
});

test('a file too large for the phone is said to be, not sent', async t => {
  const { request } = await setup(t);
  const folder = tempDir(t);
  fs.writeFileSync(path.join(folder, 'grande.png'), Buffer.alloc(4 * 1024 * 1024 + 1));
  const project = (await request('/projects', 'POST', { kind: 'local', path: folder })).body;
  assert.equal((await request(`/projects/${project.id}/files/read?path=grande.png`)).status, 413);
  const artifact = (await request(`/projects/${project.id}/artifacts/read?path=grande.png`)).body;
  assert.equal(artifact.tooLarge, true);
  assert.equal(artifact.base64, null);
  assert.equal(artifact.kind, 'image');
});

test('the phone’s pages ask the computer through the client’s own methods, and the pages are there in the phone’s script', () => {
  const storage = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'storage.js'), 'utf8');
  for (const name of ['readProjectFile', 'writeProjectFile', 'readProjectArtifact', 'projectHistoryCommit', 'restoreProject', 'searchProjectFiles']) assert.ok(storage.includes(`${name}(`), name);
  const remote = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'ui', 'js', 'remote.js'), 'utf8');
  for (const piece of ["data-tab=\"${key}\"", 'filesTab()', 'historyTab()', 'artifactsTab()', 'filePage()', 'stepPage()', 'artifactPage()', 'window.confirm(question)', 'readAsDataURL(chosen)', 'projects.back()']) assert.ok(remote.includes(piece), piece);
  // The same file on both sides of the repository.
  assert.equal(remote, fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'remote.js'), 'utf8'));
  // Nothing from the repository is put in the page as markup: the diff goes through the escaper, line by line.
  assert.ok(remote.includes("${esc(line)}"));
});
