'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  SandboxManager,
  shellSafePackages,
  pythonPreinstallScript,
  nodePreinstallScript,
  imageKey,
  pythonPackagePresent,
  nodePackagePresent,
  SHARED_PY,
  SHARED_NODE
} = require('../server/sandbox');

test('only well-formed package names of the requested runtime reach the shell', () => {
  const packages = [
    { name: 'numpy', runtime: 'python' },
    { name: 'pandas', runtime: 'python' },
    { name: 'numpy', runtime: 'python' },
    { name: 'express', runtime: 'nodejs' },
    // Names come from cache filenames, so a crafted file must not smuggle shell
    // syntax into every other chat's container.
    { name: 'evil; rm -rf /', runtime: 'python' },
    { name: '$(id)', runtime: 'python' },
    { name: '`id`', runtime: 'python' },
    { name: '-r/etc/passwd', runtime: 'python' },
    { name: 'a b', runtime: 'python' },
    { name: '', runtime: 'python' }
  ];

  assert.deepEqual(shellSafePackages(packages, 'python'), ['numpy', 'pandas']);
  assert.deepEqual(shellSafePackages(packages, 'nodejs'), ['express']);
  assert.deepEqual(shellSafePackages([], 'python'), []);
  // Entries without an explicit runtime are treated as python, as elsewhere.
  assert.deepEqual(shellSafePackages([{ name: 'six' }], 'python'), ['six']);
});

test('the preinstall script survives the single-argument, single-line constraint', () => {
  // The script travels through wsl.exe on Windows, where embedded newlines are
  // lost; a lost separator would turn a shell assignment into an env prefix and
  // blank the command after it.
  for (const script of [
    pythonPreinstallScript(['numpy'], true),
    pythonPreinstallScript(['numpy'], false),
    nodePreinstallScript(['express'], true),
    nodePreinstallScript(['express'], false)
  ]) {
    assert.ok(!script.includes('\n'), 'lo script deve stare su una riga sola');
    assert.ok(!/^\s*[A-Z_]+=/m.test(script), 'nessuna assegnazione di variabile shell');
  }
});

test('python preinstall installs from the cache folder and only downloads when it must', () => {
  const online = pythonPreinstallScript(['numpy', 'pandas'], true);
  assert.ok(online.includes(`--target ${SHARED_PY}`), 'installa nello store condiviso, non nel container');
  assert.ok(online.includes('--no-index --find-links /root/.cache numpy pandas'), 'installa dalla cartella cache');
  assert.ok(online.includes('pip3 download --dest /root/.cache numpy pandas'), 'ricade sul download nella cartella');
  assert.ok(online.indexOf('--find-links') < online.indexOf('pip3 download'), 'la cache viene provata per prima');
  assert.ok(online.includes('apk add --no-cache python3 py3-pip'), 'installa il runtime se assente');

  const offline = pythonPreinstallScript(['numpy'], false);
  assert.ok(offline.includes('--no-index --find-links /root/.cache numpy'));
  assert.ok(!offline.includes('pip3 download'), 'senza rete non si scarica nulla');
  assert.ok(!offline.includes('apk add'), 'senza rete non si installa il runtime');
});

test('node preinstall deposits tarballs in the shared folder', () => {
  const online = nodePreinstallScript(['express'], true);
  assert.ok(online.includes('npm pack --pack-destination /root/.cache express'), 'l’artefatto finisce nella cartella catalogata');
  assert.ok(online.includes(`npm install --prefix ${SHARED_NODE}`), 'installa nello store condiviso');

  const offline = nodePreinstallScript(['express'], false);
  assert.ok(offline.includes('--offline'));
  assert.ok(!offline.includes('npm pack'), 'senza rete non si impacchetta nulla');
});

test('a chat with no active packages settles immediately instead of waiting on a container', () => {
  const sandbox = new SandboxManager({ defaultPackages: () => [] });
  sandbox._startPreinstall('chat1', { bin: 'nonesistente', baseArgs: [] }, {});
  const status = sandbox.preinstallStatus('chat1');
  assert.equal(status.state, 'done');
  assert.deepEqual(status.packages, []);
});

test('the shared store and the cache are locked for chats: only the preinstall step may write them', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'sandbox.js'), 'utf8');
  const chatCreate = source.slice(source.indexOf('async ensureContainerRunning('), source.indexOf('async stopContainer('));
  assert.ok(chatCreate.includes('/root/.cache:ro'), 'la cache è in sola lettura nel container della chat');
  assert.ok(chatCreate.includes("store.mount('ro')"), 'lo store è in sola lettura nel container della chat');
  assert.ok(!chatCreate.includes('/root/.cache:rw') && !chatCreate.includes("store.mount('rw')"), 'nessun mount condiviso in scrittura per la chat');
  const preinstall = source.slice(source.indexOf('_startPreinstall(safeId'), source.indexOf('async getStatus('));
  assert.ok(preinstall.includes('synthorg-preinstall-'), 'il preinstall usa un container usa-e-getta');
  assert.ok(preinstall.includes('/root/.cache:rw') && preinstall.includes("store.mount('rw')"), 'solo il preinstall scrive store e cache');
  assert.ok(!source.includes('_scheduleCacheRescan'), 'il desktop non rilegge più la cache dopo ogni comando del modello');
});

test('preinstall status is reported per chat and defaults to none', () => {
  const sandbox = new SandboxManager({ defaultPackages: () => [{ name: 'six', runtime: 'python' }] });
  assert.equal(sandbox.preinstallStatus('mai-vista').state, 'none');
});

test('the shared store is keyed by image so musl and glibc builds never mix', () => {
  assert.equal(imageKey('alpine:latest'), 'alpine_latest');
  assert.notEqual(imageKey('alpine:latest'), imageKey('python:3.12-slim'));
  assert.equal(imageKey('docker.io/library/node:24-alpine'), imageKey('docker.io/library/node:24-alpine'));
  // Nothing that could escape a path segment survives the key.
  assert.ok(!imageKey('../../etc/passwd').includes('/'));
  assert.ok(!imageKey('a/b:c').includes('/'));
});

test('presence in the shared store is decided on the host, without starting a container', (t) => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-store-'));
  t.after(() => { try { fs.rmSync(store, { recursive: true, force: true }); } catch {} });

  assert.equal(pythonPackagePresent(store, 'six'), false);

  // What `pip install --target` actually leaves behind.
  fs.mkdirSync(path.join(store, 'six-1.17.0.dist-info'), { recursive: true });
  fs.writeFileSync(path.join(store, 'six.py'), '');
  assert.equal(pythonPackagePresent(store, 'six'), true);

  // Distribution names normalise dashes and underscores.
  fs.mkdirSync(path.join(store, 'typing_extensions-4.12.0.dist-info'), { recursive: true });
  assert.equal(pythonPackagePresent(store, 'typing-extensions'), true);
  assert.equal(pythonPackagePresent(store, 'sixpack'), false, 'un prefisso non deve contare come presenza');

  const nodeStore = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-nodestore-'));
  t.after(() => { try { fs.rmSync(nodeStore, { recursive: true, force: true }); } catch {} });
  assert.equal(nodePackagePresent(nodeStore, 'express'), false);
  fs.mkdirSync(path.join(nodeStore, 'node_modules', 'express'), { recursive: true });
  assert.equal(nodePackagePresent(nodeStore, 'express'), true);
});
