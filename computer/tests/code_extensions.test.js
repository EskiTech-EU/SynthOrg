'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodeExtensionCatalog, SHARED_MODULES } = require('../server/code-extensions');

/** A handful of extensions on disk, the way the build ships them. */
function catalogue(t, extensions = { alfa: 400, beta: 200, gamma: 100 }, sharedBytes = 500) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-ext-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'extensions');
  for (const [name, bytes] of Object.entries(extensions)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'blob'), Buffer.alloc(bytes));
    fs.writeFileSync(path.join(dir, name, 'package.json'), JSON.stringify({
      displayName: '%displayName%', description: 'descrizione', categories: ['Programming Languages']
    }));
    fs.writeFileSync(path.join(dir, name, 'package.nls.json'), JSON.stringify({ displayName: `Estensione ${name}` }));
  }
  fs.mkdirSync(path.join(dir, SHARED_MODULES), { recursive: true });
  fs.writeFileSync(path.join(dir, SHARED_MODULES, 'blob'), Buffer.alloc(sharedBytes));
  return new CodeExtensionCatalog({ dir, manifestPath: path.join(root, 'data', 'code-extensions.json') });
}

test('nothing goes into the image unless it was asked for', t => {
  // In a container the editor is ours and nothing starts the extension host,
  // so an extension that is merely available is weight nobody opens.
  const catalog = catalogue(t);
  const summary = catalog.summary();
  assert.equal(summary.total, 3);
  assert.equal(summary.enabled, 0);
  assert.equal(summary.bytes, 0);
  assert.deepEqual(catalog.enabled(), []);
  // What it would cost with everything stays visible, so the choice is informed.
  assert.equal(summary.totalBytes, summary.items.reduce((sum, item) => sum + item.bytes, 0) + summary.sharedBytes);
  assert.equal(summary.sharedBytes, 500);
  // The shared dependencies are not an extension of their own.
  assert.ok(!summary.items.some(item => item.name === SHARED_MODULES));
  // Heaviest first: the page is for deciding what is worth carrying.
  assert.deepEqual(summary.items.map(item => item.name), ['alfa', 'beta', 'gamma']);
  // The name comes from the extension's own manifest, translated.
  assert.equal(summary.items[0].title, 'Estensione alfa');
  assert.equal(summary.items[0].description, 'descrizione');
});

test('switching one on adds its weight, and the choice survives a restart', t => {
  const catalog = catalogue(t);
  const after = catalog.setEnabled('alfa', true);
  assert.equal(after.enabled, 1);
  // Its own weight, plus the dependencies the extensions share.
  assert.equal(after.bytes, after.items.find(item => item.name === 'alfa').bytes + after.sharedBytes);
  assert.ok(after.bytes < after.totalBytes);
  assert.deepEqual(catalog.enabled(), ['alfa']);

  // Read back from disk by a new catalogue: the choice is in the manifest.
  const again = new CodeExtensionCatalog({ dir: catalog.dir, manifestPath: catalog.manifestPath });
  assert.deepEqual(again.enabled(), ['alfa']);
  assert.equal(again.list().find(item => item.name === 'beta').enabled, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(catalog.manifestPath, 'utf8')), { enabled: ['alfa'] });

  // Only what was asked for is written down, so an extension that a later
  // build of SynthOrg adds does not quietly put itself in the image.
  fs.mkdirSync(path.join(catalog.dir, 'delta'));
  fs.writeFileSync(path.join(catalog.dir, 'delta', 'blob'), Buffer.alloc(10));
  const fresh = new CodeExtensionCatalog({ dir: catalog.dir, manifestPath: catalog.manifestPath });
  assert.equal(fresh.list().find(item => item.name === 'delta').enabled, false);

  // Switched back off it leaves, and nothing stays written down.
  catalog.setEnabled('alfa', false);
  assert.equal(catalog.summary().enabled, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(catalog.manifestPath, 'utf8')), { enabled: [] });
});

test('the shared dependencies travel only when something needs them', t => {
  const catalog = catalogue(t);
  assert.equal(catalog.summary().bytes, 0, 'niente estensioni, niente node_modules');
  const one = catalog.setEnabled('gamma', true);
  assert.equal(one.bytes, one.items.find(item => item.name === 'gamma').bytes + one.sharedBytes);
});

test('an extension that does not exist cannot be switched', t => {
  const catalog = catalogue(t);
  assert.throws(() => catalog.setEnabled('inventata', true), error => error.status === 404);
  // And the shared dependencies are not something to switch.
  assert.throws(() => catalog.setEnabled(SHARED_MODULES, true), error => error.status === 404);
});

test('the choice is part of what the image is, so changing it rebuilds', t => {
  // The manifest is stamped with the rest of the runtime: a different choice
  // is a different image, which is what makes the switch real instead of a
  // setting that leaves the megabytes inside.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'sandbox.js'), 'utf8');
  // The manifest's bytes go into the stamp, read every time (the rest of the sources once).
  assert.match(source, /update\(readManifest\(\)\)/);
  assert.match(source, /fs\.readFileSync\(EXTENSIONS_MANIFEST\)/);
  // And what is not asked for is removed before the image is committed.
  assert.match(source, /rm -rf/);
  assert.ok(source.includes('const dropped = extensions.list().filter(item => !item.enabled)'));
});
