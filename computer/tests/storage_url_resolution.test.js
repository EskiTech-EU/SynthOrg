'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../resources/js/storage.js'), 'utf8');

function load(origin) {
  const sandbox = {};
  sandbox.window = sandbox;
  if (origin) sandbox.SYNTHORG_STORAGE_ORIGIN = origin;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

test('stored artifact links are resolved against the port of the running session', () => {
  const win = load('http://127.0.0.1:51873');
  const resolve = win.synthorgResolveUrl;

  // Links are saved without an origin.
  assert.equal(
    resolve('/api/conversations/abc/sandbox/files/grafico.png'),
    'http://127.0.0.1:51873/api/conversations/abc/sandbox/files/grafico.png'
  );

  // Links saved by earlier versions carry a port nothing listens on any more.
  assert.equal(
    resolve('http://127.0.0.1:4319/api/conversations/abc/sandbox/files/vecchio.png'),
    'http://127.0.0.1:51873/api/conversations/abc/sandbox/files/vecchio.png'
  );
  assert.equal(
    resolve('http://localhost:4319/api/conversations/abc/sandbox/files/vecchio.png'),
    'http://127.0.0.1:51873/api/conversations/abc/sandbox/files/vecchio.png'
  );

  // Anything that is not a local artifact link is left alone.
  for (const external of [
    'https://example.com/immagine.png',
    'data:image/png;base64,iVBORw0KGgo=',
    'blob:http://tauri.localhost/abc-123',
    'https://127.0.0.1:4319/altro/percorso'
  ]) {
    assert.equal(resolve(external), external, `non deve toccare ${external}`);
  }

  assert.equal(resolve(''), '');
  assert.equal(resolve(null), '');
  assert.equal(resolve(undefined), '');
});

test('without a known origin the link is left untouched rather than corrupted', () => {
  const resolve = load(null).synthorgResolveUrl;
  assert.equal(resolve('/api/conversations/a/sandbox/files/x.png'), '/api/conversations/a/sandbox/files/x.png');
  assert.equal(resolve('https://example.com/x.png'), 'https://example.com/x.png');
});
