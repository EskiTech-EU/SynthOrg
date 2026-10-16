'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const TEST_TOKEN = 'synthorg-test-token';

test('OperationalRegistry registers list_artifacts and publish_artifact tools with schemas', () => {
  const catalogCode = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'catalog.js'), 'utf8');
  const operationalCode = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'operational.js'), 'utf8');

  const sandbox = {
    window: {},
    localStorage: { getItem: () => null, setItem: () => null, removeItem: () => null },
    console,
    Boolean,
    fetch
  };

  vm.createContext(sandbox);
  vm.runInContext(catalogCode, sandbox);
  vm.runInContext('window.openRouterCatalog = new OpenRouterCatalog();', sandbox);

  return sandbox.window.openRouterCatalog.fetchModels().then(() => {
    vm.runInContext(operationalCode, sandbox);
    const registry = sandbox.window.operationalRegistry;

    const specs = registry.buildActiveToolSpecs();

    // 1. list_artifacts
    const listTool = specs.tools.find(t => t.function.name === 'list_artifacts');
    assert.ok(listTool, 'list_artifacts tool should be present in active specs');
    assert.ok(listTool.function.parameters.properties.category, 'list_artifacts should accept optional category parameter');

    // 2. publish_artifact
    const pubTool = specs.tools.find(t => t.function.name === 'publish_artifact');
    assert.ok(pubTool, 'publish_artifact tool should be present in active specs');
    assert.equal(pubTool.function.parameters.required[0], 'path', 'publish_artifact must require path');
    assert.ok(pubTool.function.parameters.properties.as_zip, 'publish_artifact should support as_zip parameter');
  });
});

test('ChatManager renders Edit and Copy on user messages, and Copy and Listen on assistant messages', () => {
  const chatCode = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'chat.js'), 'utf8');

  const domElements = new Map();
  const container = { innerHTML: '', querySelectorAll: () => [] };
  domElements.set('chat-messages-container', container);

  const sandbox = {
    window: {
      chatStorage: {},
      operationalRegistry: { getCurrentMasterModel: () => ({ name: 'Test Master' }) },
      i18n: { t: (k) => k },
      escapeHtml: (s) => s,
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    document: {
      getElementById: (id) => domElements.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    localStorage: { getItem: () => null, setItem: () => null },
    console,
    AbortSignal
  };

  vm.createContext(sandbox);
  vm.runInContext(chatCode, sandbox);

  const cm = sandbox.window.chatManager;
  cm.messages = [
    { id: 'user-msg-1', role: 'user', content: 'Ciao, generami un report di ricerca.' },
    { id: 'asst-msg-1', role: 'assistant', content: 'Certamente, ecco i dettagli del report.' }
  ];

  cm.renderMessages();

  const renderedHtml = container.innerHTML;

  // Verify User message has Modifica and Copia
  assert.ok(renderedHtml.includes('btn-msg-edit'), 'User message row must contain edit button');
  assert.ok(renderedHtml.includes("startEditUserMessage('user-msg-1')"), 'Edit button must call startEditUserMessage');
  assert.ok(renderedHtml.includes("copyMessageText('user-msg-1'"), 'User message row must contain copy button');

  // Verify Assistant message has Copia and Ascolta
  assert.ok(renderedHtml.includes("copyMessageText('asst-msg-1'"), 'Assistant message row must contain copy button');
  assert.ok(renderedHtml.includes("btn-tts-asst-msg-1"), 'Assistant message row must contain TTS listen button');
  assert.ok(renderedHtml.includes("playMessageTTS('asst-msg-1')"), 'TTS button must call playMessageTTS');
});

test('ChatManager startEditUserMessage toggles inline textarea editor and can cancel', () => {
  const chatCode = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'chat.js'), 'utf8');

  const domElements = new Map();
  const container = { innerHTML: '', querySelectorAll: () => [] };
  domElements.set('chat-messages-container', container);

  const sandbox = {
    window: {
      chatStorage: {},
      operationalRegistry: { getCurrentMasterModel: () => null },
      i18n: { t: (k) => k },
      escapeHtml: (s) => s,
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    document: {
      getElementById: (id) => domElements.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    localStorage: { getItem: () => null, setItem: () => null },
    console,
    AbortSignal
  };

  vm.createContext(sandbox);
  vm.runInContext(chatCode, sandbox);

  const cm = sandbox.window.chatManager;
  cm.render = () => cm.renderMessages();
  cm.messages = [
    { id: 'user-msg-edit', role: 'user', content: 'Testo originale del prompt utente.' }
  ];

  cm.startEditUserMessage('user-msg-edit');

  assert.equal(cm.editingMessageId, 'user-msg-edit', 'editingMessageId should be active');
  assert.ok(container.innerHTML.includes('message-inline-editor'), 'Inline editor should be rendered in message bubble');
  assert.ok(container.innerHTML.includes('textarea-edit-user-msg-edit'), 'Inline textarea should be present');
  assert.ok(container.innerHTML.includes('saveAndResendMessage'), 'Save and Send button should be present');

  cm.cancelEditMessage();
  assert.equal(cm.editingMessageId, null, 'editingMessageId should be null after cancel');
  assert.ok(!container.innerHTML.includes('message-inline-editor'), 'Inline editor should be removed after cancel');
});

test('HTTP Server GET files lists categorized artifacts (excluding TTS audio cache) and POST publish creates artifact', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(__dirname, '../.tmp/test-artifacts-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const { createApp } = require('../server/index');
  const { server, store } = createApp({ token: TEST_TOKEN, dbPath, allowedOrigins: () => ['http://127.0.0.1:4319'] });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await new Promise(r => server.close(r));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const conv = store.createConversation('Artifacts Test Chat');
  const convId = conv.id;

  const saveFile = async (name, content) => {
    const res = await fetch(`${baseUrl}/api/conversations/${convId}/sandbox/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthorg-test-token' },
      body: JSON.stringify({ filename: name, content: Buffer.from(content).toString('base64'), encoding: 'base64' })
    });
    return res.json();
  };

  // 1. Save various files including a TTS audio cache file
  await saveFile('report_deep_research.md', '# Research Report\nKey insights...');
  await saveFile('generated_chart.png', 'FAKE_PNG_BYTES');
  await saveFile('tts_msg-1_1726090000.mp3', 'FAKE_TTS_AUDIO_CACHE');
  await saveFile('bundle.zip', 'FAKE_ZIP_BYTES');

  // 2. GET /api/conversations/:id/sandbox/files
  const listRes = await fetch(`${baseUrl}/api/conversations/${convId}/sandbox/files`, {
    headers: { Authorization: 'Bearer synthorg-test-token' }
  });
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();

  assert.ok(Array.isArray(listData.files), 'files should be an array');
  const fileNames = listData.files.map(f => f.name);

  // Assert regular artifacts are present with correct categories
  assert.ok(fileNames.includes('report_deep_research.md'), 'report should be in artifacts');
  assert.ok(fileNames.includes('generated_chart.png'), 'image should be in artifacts');
  assert.ok(fileNames.includes('bundle.zip'), 'zip should be in artifacts');

  const reportFile = listData.files.find(f => f.name === 'report_deep_research.md');
  assert.equal(reportFile.category, 'document');

  const imageFile = listData.files.find(f => f.name === 'generated_chart.png');
  assert.equal(imageFile.category, 'image');

  // Assert TTS audio is strictly excluded from artifacts
  assert.ok(!fileNames.includes('tts_msg-1_1726090000.mp3'), 'TTS audio cache MUST NOT be exposed as artifact');

  // 3. Category filtering: ?category=image
  const filterRes = await fetch(`${baseUrl}/api/conversations/${convId}/sandbox/files?category=image`, {
    headers: { Authorization: 'Bearer synthorg-test-token' }
  });
  const filterData = await filterRes.json();
  assert.equal(filterData.files.length, 1);
  assert.equal(filterData.files[0].name, 'generated_chart.png');

  // 4. POST /api/conversations/:id/sandbox/publish for single file
  const pubRes = await fetch(`${baseUrl}/api/conversations/${convId}/sandbox/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthorg-test-token' },
    body: JSON.stringify({ path: 'report_deep_research.md', title: 'Deep Research Report' })
  });
  assert.equal(pubRes.status, 200);
  const pubData = await pubRes.json();
  assert.equal(pubData.ok, true);
  assert.equal(pubData.filename, 'report_deep_research.md');
  assert.equal(pubData.category, 'document');
  // Stored without an origin: the storage port is assigned at runtime, so a
  // baked-in origin would break every saved link on the next start.
  assert.ok(pubData.markdown.startsWith('[file:Deep Research Report|/api/conversations/'));
  assert.ok(!pubData.markdown.includes('127.0.0.1'), 'nessuna porta incisa nel dato salvato');

  // 5. POST publish with image
  const pubImgRes = await fetch(`${baseUrl}/api/conversations/${convId}/sandbox/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthorg-test-token' },
    body: JSON.stringify({ path: 'generated_chart.png', title: 'Grafico Vendite' })
  });
  const pubImgData = await pubImgRes.json();
  assert.equal(pubImgData.category, 'image');
  assert.ok(pubImgData.markdown.startsWith('![Grafico Vendite](/api/conversations/'));
  assert.ok(!pubImgData.markdown.includes('127.0.0.1'), 'nessuna porta incisa nel dato salvato');
});

