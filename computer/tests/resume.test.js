'use strict';
// «Prosegui» on an answer cut short: the model is told why and given back what it had.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { Store } = require('../server/database');
const source = fs.readFileSync(path.join(__dirname, '../resources/js/chat.js'), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// These tests exercise the chat's turn memory, which a new chat starts without: their chats turn it on.
function withChatMemory(store) {
  const create = store.createConversation.bind(store);
  store.createConversation = (...args) => { const c = create(...args); return store.updateConversation(c.id, { memoryEnabled: true }); };
  return store;
}
async function setup(t, apiKey = 'test-key') {
  const store = withChatMemory(new Store(':memory:')); t.after(() => store.close());
  const nodes = new Map(), errors = [], local = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { value: '', style: {}, hidden: true, innerHTML: '', textContent: '', focus() {}, querySelectorAll() { return []; }, scrollHeight: 0 });
    return nodes.get(id);
  }
  const storage = {
    get: async id => ({ conversation: store.conversation(id), messages: store.messages(id) }),
    save: async (id, message) => store.saveMessage(id, message),
    context: async (id, query) => store.context(id, query), clear: async id => store.clearMessages(id),
    saveMemory: async (data, id) => store.saveMemory(data, id),
    memoryPending: async id => store.memoryTree().pending(id),
    memoryAddNode: async (id, node) => store.memoryTree().addNode(id, node),
    memoryOpen: async (id, nodeId) => store.memoryTree().open(id, nodeId)
  };
  const window = { chatStorage: storage, addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    operationalRegistry: { getCurrentMasterModel: () => ({ id: 'test/model', name: '<unsafe model>', hasTools: true }), getAllConfigurableItems: () => [], getModelParameters: () => ({}), getSelectedMasterId: () => 'test/model', getToolDelegate: () => 'auto', buildActiveToolSpecs: () => ({ tools: [], promptSection: '', toolMeta: new Map() }) },
    openRouterCatalog: { getApiKey: () => apiKey },
    chatWorkspace: { refresh: async () => {}, renderActive() {}, error: error => errors.push(error), perform: async fn => { try { await fn(); } catch (e) { errors.push(e); } } }
  };
  const context = vm.createContext({ window, document: { getElementById: node, querySelectorAll() { return []; }, querySelector() { return null; } }, crypto: webcrypto, console,
    localStorage: { getItem: key => local.get(key), setItem: (key, value) => local.set(key, value) },
    AbortSignal, AbortController, TextDecoder, fetch: async () => { throw Error('Unexpected network'); }
  });
  // Same load order as index.html: chat completions go through the model gateway.
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../resources/js/model-gateway.js'), 'utf8'), context);
  vm.runInContext(source, context);
  const manager = window.chatManager;
  const chat = store.createConversation('Prima');
  manager.ready = true; await manager.selectConversation(chat.id);
  return { store, manager, context, node, errors, chat, storage };
}

const sseOf = (...chunks) => chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('');

test('an answer cut by an error keeps its text clean and the error apart; «Prosegui» tells the model why and gives back its text, thought and tools', async t => {
  const { store, manager, context, chat, errors } = await setup(t);
  // The stream ends without its end: part of the thought, part of the text, no finish.
  context.fetch = async () => new Response(sseOf({ choices: [{ delta: { reasoning: 'Devo elencare tre punti.' } }] }, { choices: [{ delta: { content: 'Primo punto: la base.' } }] }));
  await manager.sendMessage('Spiegami i tre punti');
  const cut = store.messages(chat.id).at(-1);
  assert.equal(cut.status, 'error');
  assert.equal(cut.cut, 'error');
  assert.equal(cut.content, 'Primo punto: la base.');
  assert.match(cut.cutDetail, /./);
  assert.equal(errors.length, 1);

  // The last answer cut short shows the error and «Prosegui».
  manager.messages = store.messages(chat.id);
  const html = manager.renderCut(manager.messages.at(-1));
  assert.match(html, /message-resume-btn/);
  assert.match(html, /message-cut-note/);

  const payloads = [];
  context.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return new Response(sseOf({ choices: [{ delta: { content: 'Secondo punto: il resto.' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  };
  await manager.resumeAnswer(cut.id);
  const saved = store.messages(chat.id);
  const resume = saved.at(-2), answer = saved.at(-1);
  assert.equal(resume.role, 'user');
  assert.equal(resume.report, true);
  assert.equal(resume.resume, true);
  assert.equal(answer.content, 'Secondo punto: il resto.');
  assert.equal(answer.status, 'complete');
  assert.equal(answer.cut, undefined);

  // What the model was told: why it stopped, what it had written, what it was thinking.
  const told = payloads[0].messages.filter(m => m.role === 'user').at(-1).content;
  assert.match(told, /^\[RIPRESA\] La tua risposta precedente si è interrotta per un errore/);
  assert.match(told, /Quello che avevi scritto:\nPrimo punto: la base\./);
  assert.match(told, /Il tuo ragionamento fino a quel punto:\nDevo elencare tre punti\./);

  // On the page the resumed turn is a line, not a bubble of the user; the old answer has no button any more.
  manager.messages = store.messages(chat.id);
  assert.equal(manager.renderCut(manager.messages.find(m => m.id === cut.id)).includes('message-resume-btn'), false);
});

test('an answer stopped by the user is kept in the history and marked; «Prosegui» does not repeat its text', async t => {
  const { store, manager, context, chat, errors } = await setup(t);
  context.fetch = async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Parziale"}}]}\n'));
      options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
      setTimeout(() => manager.stopGeneration(), 10);
    }
  }));
  await manager.sendMessage('Domanda');
  const stopped = store.messages(chat.id).at(-1);
  assert.equal(stopped.status, 'complete');
  assert.equal(stopped.cut, 'stop');
  assert.equal(stopped.cutDetail, undefined);
  assert.equal(errors.length, 0);

  const payloads = [];
  context.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return new Response(sseOf({ choices: [{ delta: { content: ' e il resto.' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  };
  manager.messages = store.messages(chat.id);
  await manager.resumeAnswer(stopped.id);
  const users = payloads[0].messages.filter(m => m.role === 'user');
  assert.match(users.at(-1).content, /^\[RIPRESA\] La tua risposta precedente si è interrotta perché l'utente l'ha fermata/);
  assert.doesNotMatch(users.at(-1).content, /Quello che avevi scritto/);
  // The stopped text is in the history, before the resume.
  assert.ok(payloads[0].messages.some(m => m.role === 'assistant' && m.content === 'Parziale'));
});
