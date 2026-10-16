'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { createApp } = require('../server');
const { fetchPageContent, performWebSearch } = require('../server/web-search');
const TEST_TOKEN = 'synthorg-test-token';

async function setupServer(t) {
  const { server } = createApp({ token: TEST_TOKEN, dbPath: ':memory:', allowedOrigins: ['http://localhost:54321'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    request: (route, method = 'GET', data) => fetch(base + '/api' + route, {
      method,
      headers: { Authorization: 'Bearer synthorg-test-token', 'Content-Type': 'application/json', Origin: 'http://localhost:54321' },
      body: data === undefined ? undefined : JSON.stringify(data)
    })
  };
}

test('tools web-browse API respects network isolation and extracts web page content', async t => {
  const { request } = await setupServer(t);
  const chat = await (await request('/conversations', 'POST', { title: 'Web Browse Chat' })).json();
  assert.ok(chat.id);

  // 1. Offline chat rejects web-browse with 403
  const blockedRes = await request(`/conversations/${chat.id}/tools/web-browse`, 'POST', { url: 'http://example.com' });
  assert.equal(blockedRes.status, 403);
  const blockedJson = await blockedRes.json();
  assert.ok(blockedJson.error.includes('Isolato') || blockedJson.error.includes('Offline'));

  // 2. Missing URL validation
  await request(`/conversations/${chat.id}/sandbox`, 'PATCH', { networkEnabled: true });
  const noUrlRes = await request(`/conversations/${chat.id}/tools/web-browse`, 'POST', {});
  assert.equal(noUrlRes.status, 400);

  // 3. Create a local test web server to browse
  const mockWeb = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>SynthOrg Documentation</title>
          <style>body { font-family: sans-serif; }</style>
          <script>console.log("Noise to be stripped");</script>
        </head>
        <body>
          <header><nav><a href="/home">Home</a></nav></header>
          <main>
            <h1>Benvenuto in SynthOrg</h1>
            <p>Piattaforma avanzata per orchestrazione AI multi-agente con sandbox isolate e strumenti specialistici.</p>
            <p>Caratteristiche principali: navigazione web, sintesi vocale e video generation.</p>
            <a href="/getting-started">Guida Introduttiva</a>
            <a href="https://github.com/synthorg/core">Repository GitHub</a>
          </main>
          <footer>Copyright 2026 SynthOrg</footer>
        </body>
      </html>
    `);
  });
  await new Promise(resolve => mockWeb.listen(0, '127.0.0.1', resolve));
  t.after(() => mockWeb.close());
  const mockUrl = `http://127.0.0.1:${mockWeb.address().port}`;

  // 4. Browse the test web server
  const browseRes = await request(`/conversations/${chat.id}/tools/web-browse`, 'POST', {
    url: mockUrl,
    maxChars: 4000
  });
  assert.equal(browseRes.status, 200);
  const browseData = await browseRes.json();

  assert.equal(browseData.title, 'SynthOrg Documentation');
  assert.ok(browseData.content.includes('Benvenuto in SynthOrg'), 'Should extract main heading');
  assert.ok(browseData.content.includes('Piattaforma avanzata'), 'Should extract paragraph text');
  assert.equal(browseData.content.includes('console.log'), false, 'Should strip scripts');
  assert.ok(Array.isArray(browseData.links), 'Links should be an array');
  assert.ok(browseData.links.some(l => l.text.includes('Guida Introduttiva')), 'Should find internal link');
  assert.ok(browseData.links.some(l => l.url.includes('github.com/synthorg/core')), 'Should find external link');
});

test('web-search and pagination correctly returns distinct slices', async t => {
  // Test fallback search pagination
  const page1 = await performWebSearch('Artificial Intelligence', { maxResults: 3, page: 1 });
  assert.equal(page1.query, 'Artificial Intelligence');
  assert.equal(page1.page, 1);
  assert.ok(page1.results.length > 0);

  const page2 = await performWebSearch('Artificial Intelligence', { maxResults: 3, page: 2 });
  assert.equal(page2.page, 2);
  assert.ok(page2.results.length > 0);

  // Results should not be identical
  if (page1.results.length > 0 && page2.results.length > 0) {
    assert.notEqual(page1.results[0].url, page2.results[0].url, 'Page 1 and Page 2 should have distinct top results');
  }
});

test('OperationalRegistry registers web_search and web_browse as the first-person native engine', () => {
  const catalogCode = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'catalog.js'), 'utf8');
  const operationalCode = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'operational.js'), 'utf8');

  const mockStorage = new Map();
  const sandbox = {
    window: {},
    localStorage: {
      getItem: (k) => mockStorage.get(k) || null,
      setItem: (k, v) => mockStorage.set(k, String(v)),
      removeItem: (k) => mockStorage.delete(k)
    },
    fetch: async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ data: [
        {
          id: 'anthropic/claude-3.7-sonnet',
          name: 'Claude 3.7 Sonnet',
          context_length: 200000,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          supported_parameters: ['tools'],
          pricing: { prompt: '0.000003', completion: '0.000015' }
        }
      ]})
    }),
    console,
    Boolean
  };

  vm.createContext(sandbox);
  vm.runInContext(catalogCode, sandbox);
  vm.runInContext('window.openRouterCatalog = new OpenRouterCatalog();', sandbox);

  return sandbox.window.openRouterCatalog.fetchModels().then(() => {
    vm.runInContext(operationalCode, sandbox);
    const registry = sandbox.window.operationalRegistry;

    const specs = registry.buildActiveToolSpecs();

    // 1. web_search
    const searchTool = specs.tools.find(t => t.function.name === 'web_search');
    assert.ok(searchTool, 'web_search should be present');
    assert.ok(searchTool.function.parameters.properties.query, 'web_search should have query');
    assert.ok(searchTool.function.parameters.properties.page, 'web_search should have page for pagination');

    // 2. web_browse
    const browseTool = specs.tools.find(t => t.function.name === 'web_browse');
    assert.ok(browseTool, 'web_browse should be present as a native engine');
    assert.equal(browseTool.function.parameters.required[0], 'url', 'web_browse must require url');
    assert.ok(browseTool.function.parameters.properties.max_chars, 'web_browse should have max_chars');

    // Web access has exactly two shapes: the model driving the browser itself
    // (web_search + web_browse) and the search delegated to a model.
    assert.equal(specs.tools.filter(t => t.function.name === 'deep_web_research').length, 0,
      'il sotto-agente rimosso non deve piu comparire fra gli strumenti');
  });
});


test('the capability matrix offers one delegated web tool and one first-person engine', () => {
  const catalogCode = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'catalog.js'), 'utf8');
  const operationalCode = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'operational.js'), 'utf8');

  const store = new Map();
  const sandbox = {
    window: {},
    localStorage: {
      getItem: (k) => store.get(k) || null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(catalogCode, sandbox);
  vm.runInContext(operationalCode, sandbox);

  const registry = sandbox.window.operationalRegistry;
  const webItems = registry.getAllConfigurableItems().filter(i => i.suiteId === 'deep_research');

  // Web access has exactly two shapes, and the configuration surface shows
  // exactly two rows: the browser the model drives itself, and the search
  // handed to a model. The native functions are not separate settings, because
  // there is nothing to set on them.
  assert.equal(webItems.length, 2, 'la sezione web deve avere due sole voci');

  const native = webItems.find(i => i.isNativeEngine);
  assert.ok(native, 'serve la voce in prima persona');
  assert.equal(native.eligibleModels.length, 0, 'il motore nativo non ha modelli da assegnare');
  // Joined rather than deep-compared: the array is built inside the vm realm.
  assert.equal(native.functions.map(f => f.id).join(','), 'web_search,web_browse',
    'le due funzioni restano distinte sotto un unica voce');

  const delegated = webItems.find(i => !i.isNativeEngine);
  assert.ok(delegated, 'serve la voce delegata');
  assert.equal(delegated.id, 'model_search');

  // The model still calls them as separate functions.
  const specs = registry.buildActiveToolSpecs();
  const names = specs.tools.map(t => t.function.name);
  assert.ok(names.includes('web_search') && names.includes('web_browse'));
  assert.ok(!names.includes('deep_web_research'), 'il sotto-agente rimosso non deve riapparire');
});

test('an isolated chat is not offered the tools it could never use', () => {
  const catalogCode = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'catalog.js'), 'utf8');
  const operationalCode = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'operational.js'), 'utf8');

  const store = new Map();
  const sandbox = {
    window: {},
    localStorage: {
      getItem: (k) => store.get(k) || null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(catalogCode, sandbox);
  vm.runInContext(operationalCode, sandbox);
  const registry = sandbox.window.operationalRegistry;

  const online = registry.buildActiveToolSpecs({ offline: false });
  const offline = registry.buildActiveToolSpecs({ offline: true });
  const namesOnline = online.tools.map(t => t.function.name);
  const namesOffline = offline.tools.map(t => t.function.name);

  assert.ok(namesOnline.includes('web_search') && namesOnline.includes('web_browse'),
    'con la rete attiva gli strumenti web sono dichiarati');

  // Declaring them and refusing the call afterwards spent prompt on something
  // the model could never use, and invited it to keep trying.
  assert.ok(!namesOffline.includes('web_search'), 'web_search non deve essere dichiarato a chat isolata');
  assert.ok(!namesOffline.includes('web_browse'), 'web_browse non deve essere dichiarato a chat isolata');
  assert.ok(!/web_search|web_browse/.test(offline.promptSection),
    'nemmeno la sezione di prompt deve nominarli');

  // Tools that do not need the network are unaffected.
  for (const local of ['list_artifacts', 'publish_artifact']) {
    assert.ok(namesOffline.includes(local), `${local} deve restare disponibile`);
  }
});
