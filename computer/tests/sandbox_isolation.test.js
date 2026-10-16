'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createApp } = require('../server');
const { assertSafeImage } = require('../server/sandbox');
const TEST_TOKEN = 'synthorg-test-token';

const ROOT = path.resolve(__dirname, '..');

async function setup(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-sandbox-test-'));
  const { server } = createApp({ token: TEST_TOKEN, dbPath: path.join(tmpDir, 'test.sqlite'), allowedOrigins: ['http://localhost:54321'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = [];
  t.after(() => new Promise(resolve => {
    for (const dir of created) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    server.close(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      resolve();
    });
    server.closeAllConnections();
  }));
  return {
    created,
    request: (route, method = 'GET', data) => fetch(base + '/api' + route, {
      method,
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json', Origin: 'http://localhost:54321' },
      body: data === undefined ? undefined : JSON.stringify(data)
    })
  };
}

test('sandbox publish refuses to follow a link planted inside the workspace', async t => {
  const { request, created } = await setup(t);
  const chat = await (await request('/conversations', 'POST', { title: 'escape' })).json();

  const sandboxRoot = path.join(require('../server/paths').DATA_DIR, 'sandboxes', String(chat.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36));
  const wsDir = path.join(sandboxRoot, 'workspace');
  fs.mkdirSync(wsDir, { recursive: true });
  created.push(sandboxRoot);

  // Stands in for any host directory the server process can read but the
  // container must never be able to publish — data/synthorg.sqlite lives one
  // such hop above the workspace.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-outside-'));
  created.push(outside);
  fs.writeFileSync(path.join(outside, 'api_keys.txt'), 'SEGRETO');

  // A container running as root on the read-write /workspace mount can plant this.
  const link = path.join(wsDir, 'uscita');
  let planted = true;
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch {
    try { fs.symlinkSync(outside, link, 'dir'); } catch { planted = false; }
  }
  t.diagnostic(planted ? 'link piantato nel workspace' : 'link non creabile su questa piattaforma');

  if (planted) {
    const res = await request(`/conversations/${chat.id}/sandbox/publish`, 'POST', { path: 'uscita', title: 'leak' });
    assert.equal(res.status, 403, 'publishing through a link out of the workspace must be refused');
    const files = fs.readdirSync(wsDir).filter(name => name.endsWith('.zip'));
    assert.equal(files.length, 0, 'no archive of outside content may be left in the workspace');
  }

  // Absolute paths are refused whether or not links are available.
  const abs = await request(`/conversations/${chat.id}/sandbox/publish`, 'POST', { path: path.join(outside, 'api_keys.txt') });
  assert.equal(abs.status, 403);
});

test('sandbox image reference is validated before it can become a container argument', async t => {
  const { request } = await setup(t);
  const chat = await (await request('/conversations', 'POST', { title: 'image' })).json();

  // Anything starting with "-" would be read by the container engine as a flag
  // rather than an image, which is how a chat setting turns into a mount.
  for (const hostile of ['-v/:/host', '--privileged', '--mount=type=bind,src=/,dst=/h', 'alpine; rm -rf /', 'alpine latest', '../../etc/passwd']) {
    const res = await request(`/conversations/${chat.id}/sandbox`, 'PATCH', { image: hostile });
    assert.equal(res.status, 400, `image ${JSON.stringify(hostile)} must be refused`);
  }

  for (const valid of ['alpine', 'alpine:latest', 'python:3.12-slim', 'docker.io/library/node:24-alpine', 'localhost:5000/my/img:tag']) {
    assert.equal(assertSafeImage(valid), valid);
    const res = await request(`/conversations/${chat.id}/sandbox`, 'PATCH', { image: valid });
    assert.equal(res.status, 200, `image ${valid} must be accepted`);
  }

  // Nothing named comes back as our own pinned base, never as a registry tag.
  const { BASE_IMAGE } = require('../server/base-image');
  assert.equal(assertSafeImage(''), BASE_IMAGE);
  assert.equal(assertSafeImage(undefined), BASE_IMAGE);
});
