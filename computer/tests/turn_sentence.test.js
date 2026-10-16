'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { Store } = require('../server/database');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', file), 'utf8');
const sse = (...chunks) => new TextEncoder().encode(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n');
const call = (name, args, content) => ({ choices: [{ delta: { ...(content ? { content } : {}), tool_calls: [{ index: 0, id: `c-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
const says = (content) => ({ choices: [{ delta: { content }, finish_reason: 'stop' }] });

/** A chat on the computer's page with one tool, and a model played by `answer(payload)`. */
async function setup(t, answer) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const conversation = store.createConversation('Prova');
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { value: '', style: {}, hidden: true, innerHTML: '', textContent: '', focus() {}, querySelectorAll() { return []; }, scrollHeight: 0 }); return nodes.get(id); };
  const errors = [];
  const storage = {
    get: async id => ({ conversation: store.conversation(id), messages: store.messages(id) }),
    getBare: async id => ({ conversation: store.conversation(id), messages: [] }),
    save: async (id, message) => store.saveMessage(id, message),
    context: async (id, query, options) => store.context(id, query, options),
    getSetting: async key => ({ key, value: store.getSetting(key) }),
    getSettings: async () => store.getSettings(),
    setSetting: async (key, value) => ({ key, value: store.setSetting(key, value) }),
    listProjects: async () => store.listProjects(),
    memoryPending: async () => [], memoryAddNode: async () => {}, memoryOpen: async () => {}, saveMemory: async () => {}
  };
  const document = { readyState: 'complete', getElementById: node, querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {}, dispatchEvent() {} };
  const tool = { type: 'function', function: { name: 'leggi_nota', description: 'Legge una nota.', parameters: { type: 'object', properties: { nome: { type: 'string' } } } } };
  const window = { chatStorage: storage, addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    operationalRegistry: { getCurrentMasterModel: () => ({ id: 'test/model', name: 'M', hasTools: true }), getAllConfigurableItems: () => [], getModelParameters: () => ({}), getSelectedMasterId: () => 'test/model',
      buildActiveToolSpecs: () => ({ tools: [tool], promptSection: '', toolMeta: new Map() }) },
    openRouterCatalog: { getApiKey: () => 'k', models: [{ id: 'test/model', supportedParameters: ['tools', 'tool_choice'] }] },
    chatWorkspace: { refresh: async () => {}, renderActive() {}, error: e => errors.push(e), perform: async fn => fn() } };
  const payloads = [];
  const local = new Map();
  const context = vm.createContext({ window, document, crypto: webcrypto, console, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    localStorage: { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, String(value)), removeItem: key => local.delete(key) },
    AbortSignal, AbortController, TextDecoder, clearTimeout,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
    fetch: async (url, options) => {
      const payload = JSON.parse(options.body);
      payloads.push(payload);
      const given = answer(payload);
      if (payload.stream === false) return new Response(JSON.stringify(given), { headers: { 'Content-Type': 'application/json' } });
      const body = sse(given);
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }));
    } });
  vm.runInContext(read('model-gateway.js'), context);
  vm.runInContext(read('chat.js'), context);
  const manager = window.chatManager;
  manager.ready = true;
  await manager.selectConversation(conversation.id);
  return { store, conversation, manager, payloads, errors };
}

const answered = async (store, conversation) => {
  for (let i = 0; i < 300; i += 1) {
    const last = store.messages(conversation.id).at(-1);
    if (last?.role === 'assistant' && last.content) return last;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('no answer');
};

test('the Master is told to write a sentence before each tool call, and a tool turn without it is asked for it in a request of its own', async t => {
  const { store, conversation, manager, payloads, errors } = await setup(t, (payload) => {
    if (payload.stream === false) return { choices: [{ message: { content: 'Leggo la nota «spesa» per vedere cosa manca.' } }] };
    return payload.messages.at(-1).role === 'tool' ? says('Mancano latte e pane.') : call('leggi_nota', { nome: 'spesa' });
  });
  await manager.sendMessage('Cosa manca nella lista della spesa?');
  const last = await answered(store, conversation);
  assert.deepEqual(errors.map(e => e.message), []);

  // The rule is in the system prompt of every request with tools.
  assert.match(payloads[0].messages[0].content, /\[FRASE PRIMA DEGLI STRUMENTI\]/);

  // The model called the tool without a sentence: one request more, same messages and one at the end, no tools allowed.
  const asked = payloads.filter(p => p.stream === false);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].tool_choice, 'none');
  assert.match(asked[0].messages.at(-1).content, /^Stai per chiamare: leggi_nota\(\{"nome":"spesa"\}\)\. Scrivi una sola frase breve/);
  assert.deepEqual(asked[0].messages.slice(0, -1).map(m => m.role), payloads[0].messages.map(m => m.role));

  // The sentence is the turn's, it goes back to the model with the call, and the answer is only the answer.
  assert.equal(last.turns[0].content, 'Leggo la nota «spesa» per vedere cosa manca.');
  const second = payloads.filter(p => p.stream !== false)[1];
  assert.equal(second.messages.find(m => m.tool_calls)?.content, 'Leggo la nota «spesa» per vedere cosa manca.');
  assert.equal(last.content, 'Mancano latte e pane.');

  // Shown in the turn: the sentence, never a label made up by the page.
  const html = manager.renderTurnsAndReasoning(last);
  assert.ok(html.includes('chat-turn-said'));
  assert.ok(html.includes('Leggo la nota «spesa» per vedere cosa manca.'));
  assert.ok(!html.includes('Tool: leggi_nota'));
});

test('a sentence the model wrote with its call is kept in the turn, out of the answer, and nothing more is asked', async t => {
  const { store, conversation, manager, payloads, errors } = await setup(t, (payload) => (
    payload.messages.at(-1).role === 'tool' ? says('Mancano latte e pane.') : call('leggi_nota', { nome: 'spesa' }, 'Apro la nota della spesa.')
  ));
  await manager.sendMessage('Cosa manca nella lista della spesa?');
  const last = await answered(store, conversation);
  assert.deepEqual(errors.map(e => e.message), []);
  assert.equal(payloads.filter(p => p.stream === false).length, 0);
  assert.equal(last.turns[0].content, 'Apro la nota della spesa.');
  assert.equal(last.content, 'Mancano latte e pane.');
});
