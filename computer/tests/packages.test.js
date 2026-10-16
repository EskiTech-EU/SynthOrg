const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PackageManager, CURATED_PACKAGES } = require('../server/packages');
const { PromptManager } = require('../resources/js/prompts');
const { createApp } = require('../server/index');
const TEST_TOKEN = 'synthorg-test-token';

test('PackageManager initializes with curated packages and handles discovery', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'synthorg-test-packages-'));
  const cacheDir = path.join(tmpDir, 'cache');
  const manifestPath = path.join(tmpDir, 'manifest.json');

  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const pm = new PackageManager({ cacheDir, manifestPath });
  const pkgs = pm.list();

  assert.ok(pkgs.length >= 10, 'Curated default packages should be loaded');
  const numpy = pkgs.find(p => p.name === 'numpy');
  assert.ok(numpy, 'numpy package must exist');
  assert.equal(numpy.runtime, 'python');
  assert.ok(numpy.title.includes('NumPy'), 'numpy title must be formatted');
  assert.ok(numpy.description.length > 50, 'numpy description should be detailed');
  assert.equal(numpy.isDefault, true, 'numpy should be default active');

  // Toggle default off and on
  pm.toggleDefault('numpy', false);
  assert.equal(pm.list().find(p => p.name === 'numpy').isDefault, false);

  pm.toggleDefault('numpy', true);
  assert.equal(pm.list().find(p => p.name === 'numpy').isDefault, true);

  // Discovery of newly dropped wheel package
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'custom_tool-2.5.1-py3-none-any.whl'), 'fake-wheel-binary');

  await pm.scan();
  const custom = pm.list().find(p => p.name === 'custom-tool');
  assert.ok(custom, 'Discovered wheel package should be registered');
  assert.equal(custom.version, '2.5.1');
  assert.equal(custom.runtime, 'python');
  assert.ok(custom.title.includes('Custom-tool'), 'Title should be formatted');
});

test('PromptManager compileSystemPrompt includes [PRE-INSTALLED ENVIRONMENT PACKAGES]', () => {
  const pm = new PromptManager();
  const compiled = pm.compileSystemPrompt({
    modelId: 'anthropic/claude-3.7-sonnet',
    isChatOffline: true,
    memories: [],
    packages: [
      { name: 'numpy', version: '1.26.4', title: 'NumPy: Calcolo Scientifico e Vettoriale' },
      { name: 'pandas', version: '2.2.1', title: 'Pandas: Analisi Dati e Manipolazione Tabellare' }
    ]
  });

  assert.ok(compiled.includes('[PRE-INSTALLED ENVIRONMENT PACKAGES]'), 'Section header must exist');
  assert.ok(compiled.includes('- numpy (v1.26.4): NumPy: Calcolo Scientifico e Vettoriale'), 'numpy line must be listed');
  assert.ok(compiled.includes('- pandas (v2.2.1): Pandas: Analisi Dati e Manipolazione Tabellare'), 'pandas line must be listed');
  assert.ok(compiled.includes('do NOT execute pip/npm download commands for them'), 'Directive instruction must be present');
});

test('HTTP /api/packages endpoint operations', async (t) => {
  // A folder of its own, removed whole once the database in it is closed: nothing is left in the app's data.
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'synthorg-test-pkg-'));
  const tmpDb = path.join(tmpDir, 'synthorg.sqlite');
  const app = createApp({ token: TEST_TOKEN, dbPath: tmpDb });
  const { server } = app;

  t.after(async () => {
    server.close();
    server.closeAllConnections?.();
    try { app.store?.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api`;

  // 1. GET /api/packages
  const getRes = await fetch(`${base}/packages`, {
    headers: { Authorization: 'Bearer synthorg-test-token' }
  });
  assert.equal(getRes.status, 200);
  const packages = await getRes.json();
  assert.ok(Array.isArray(packages), 'Packages list must be an array');
  assert.ok(packages.length > 0, 'Packages list should not be empty');

  // 2. PATCH /api/packages/express
  const patchRes = await fetch(`${base}/packages/express`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer synthorg-test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ isDefault: false })
  });
  assert.equal(patchRes.status, 200);
  const updatedExpress = await patchRes.json();
  assert.equal(updatedExpress.isDefault, false);

  // 3. POST /api/packages/scan
  const scanRes = await fetch(`${base}/packages/scan`, {
    method: 'POST',
    headers: { Authorization: 'Bearer synthorg-test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(scanRes.status, 200);
  const scanned = await scanRes.json();
  assert.ok(Array.isArray(scanned));
});
