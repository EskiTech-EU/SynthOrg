'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { BaseImageStore, BASE_IMAGE, VERSION, RELEASES, releaseFor } = require('../server/base-image');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-master-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A release pointing at bytes the test owns, so nothing is downloaded for real. */
function fakeRelease(payload) {
  return {
    file: 'alpine-minirootfs-0.0.1-test.tar.gz',
    arch: 'test',
    version: '0.0.1',
    url: 'https://example.invalid/alpine.tar.gz',
    size: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex')
  };
}

function counter(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async url => {
      calls.push(url);
      return { ok, status, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
    }
  };
}

test('the base image is pinned to a version and to bytes, never to a registry tag', () => {
  assert.equal(BASE_IMAGE, `localhost/synthorg-base:${VERSION}`);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  // Nothing here goes to a registry, and nothing is called latest.
  assert.ok(!BASE_IMAGE.includes('docker.io'));
  assert.ok(!BASE_IMAGE.endsWith(':latest'));
  for (const arch of ['x64', 'arm64']) {
    const release = releaseFor(arch);
    assert.match(release.sha256, /^[a-f0-9]{64}$/, arch);
    assert.ok(release.size > 1000000 && release.size < 10 * 1024 * 1024, `${arch}: ${release.size}`);
    assert.ok(release.file.includes(VERSION), arch);
  }
  assert.deepEqual(Object.keys(RELEASES).sort(), ['arm64', 'x64']);
  assert.throws(() => releaseFor('mips'), /Architettura non supportata/);
});

test('one download, for good: the second time nothing is fetched', async t => {
  const dir = tempDir(t);
  const payload = Buffer.from('un minirootfs finto ma con la sua firma');
  const release = fakeRelease(payload);
  const { calls, fetchImpl } = counter(payload);

  const store = new BaseImageStore({ dir, fetchImpl, release });
  assert.equal(store.status().present, false);
  assert.equal(await store.ensure(), path.join(dir, release.file));
  assert.equal(calls.length, 1);
  assert.equal(calls[0], release.url);
  assert.deepEqual(fs.readFileSync(store.archive), payload);
  assert.equal(store.status().present, true);

  // The same store asks again, and a brand new one on the same folder too:
  // what is on disk is checked, not trusted by its name.
  await store.ensure();
  const second = new BaseImageStore({ dir, fetchImpl, release });
  await second.ensure();
  assert.equal(calls.length, 1, 'scaricato una volta sola');

  // The note beside it says where it came from and what it hashed to.
  const note = JSON.parse(fs.readFileSync(store.marker, 'utf8'));
  assert.equal(note.sha256, release.sha256);
  assert.equal(note.url, release.url);
  assert.equal(note.version, '0.0.1');
});

test('bytes that are not the published ones are refused and never kept', async t => {
  const dir = tempDir(t);
  const release = fakeRelease(Buffer.from('gli originali'));
  const { fetchImpl } = counter(Buffer.from('qualcosa di diverso'));
  const store = new BaseImageStore({ dir, fetchImpl, release });

  await assert.rejects(store.ensure(), error => error.status === 502 && /non corrisponde alla firma/.test(error.message));
  assert.ok(!fs.existsSync(store.archive), 'niente resta sul disco');
  assert.ok(!fs.existsSync(store.marker));
  assert.equal(store.status().present, false);

  // A failure is not remembered as a result: the next attempt tries again.
  const good = Buffer.from('gli originali');
  const retry = new BaseImageStore({ dir, fetchImpl: counter(good).fetchImpl, release: fakeRelease(good) });
  await retry.ensure();
  assert.ok(fs.existsSync(retry.archive));
});

test('an archive tampered with after the download is not taken for good', async t => {
  const dir = tempDir(t);
  const payload = Buffer.from('il contenuto giusto');
  const release = fakeRelease(payload);
  const { calls, fetchImpl } = counter(payload);
  const store = new BaseImageStore({ dir, fetchImpl, release });
  await store.ensure();

  fs.writeFileSync(store.archive, Buffer.from('sostituito'));
  assert.equal(store.verified(), false);
  // A new store on that folder downloads it again rather than importing it.
  const fresh = new BaseImageStore({ dir, fetchImpl, release });
  await fresh.ensure();
  assert.equal(calls.length, 2);
  assert.deepEqual(fs.readFileSync(fresh.archive), payload);
});

test('projects opening together share the one download', async t => {
  const dir = tempDir(t);
  const payload = Buffer.from('una volta sola anche in parallelo');
  const release = fakeRelease(payload);
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    await new Promise(resolve => setTimeout(resolve, 30));
    return { ok: true, status: 200, arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) };
  };
  const store = new BaseImageStore({ dir, fetchImpl, release });
  await Promise.all([store.ensure(), store.ensure(), store.ensure()]);
  assert.equal(calls.length, 1);
});

test('the master folder belongs to no project: removing them all leaves it alone', async t => {
  const { SandboxManager } = require('../server/sandbox');
  const root = tempDir(t);
  const sandbox = new SandboxManager({ root });
  // Not inside data/sandboxes, and not inside any project's volume or folder.
  assert.equal(sandbox.baseImages.dir, path.join(root, 'data', 'images'));
  assert.ok(!sandbox.baseImages.dir.includes('sandboxes'));
  assert.equal(sandbox.baseImages.image, BASE_IMAGE);
});
