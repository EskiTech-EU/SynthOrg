'use strict';
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

test('switching chat during generation keeps response, memory and drafts in the original chat', async t => {
  const { store, manager, node, chat, errors } = await setup(t);
  const second = store.createConversation('Seconda');
  store.saveMemory({ content: 'Nota privata prima', scope: 'conversation', conversationId: chat.id, pinned: true });
  const started = deferred(), finish = deferred();
  manager.callOpenRouterMaster = async (assistant, model, key, run) => {
    assert.equal(run.context.memories.length, 1); started.resolve(); await finish.promise;
    assistant.content = 'Risposta nella prima';
  };
  node('chat-input').value = 'Domanda prima';
  const sending = manager.sendMessage('Domanda prima'); await started.promise;
  await manager.selectConversation(second.id);
  node('chat-input').value = 'Bozza seconda';
  assert.equal(node('chat-btn-send').disabled, true);
  finish.resolve(); await sending;
  assert.equal(manager.conversation.id, second.id);
  assert.equal(manager.messages.length, 0);
  assert.equal(node('chat-input').value, 'Bozza seconda');
  const saved = store.messages(chat.id);
  assert.equal(saved.length, 2); assert.equal(saved[1].content, 'Risposta nella prima'); assert.equal(saved[1].status, 'complete');
  assert.equal(saved[1].memoryNotes[0].content, 'Nota privata prima');
  await manager.selectConversation(chat.id);
  assert.equal(node('chat-input').value, '');
  assert(node('chat-messages-container').innerHTML.includes('&lt;unsafe model&gt;'));
  assert(node('chat-messages-container').innerHTML.includes('Nota privata prima'));
  await manager.selectConversation(second.id); assert.equal(node('chat-input').value, 'Bozza seconda');
  assert.equal(errors.length, 0);
});

test('SSE split frames and Unicode persist the final answer and filtered memory context', async t => {
  const { store, manager, context, chat } = await setup(t);
  store.saveMemory({ content: 'Usa italiano', scope: 'global', pinned: true });
  store.saveMessage(chat.id, { role: 'tool', content: 'PRIVATE TRACE' });
  let payload;
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Caffè ☕"}}]}\n\ndata: {"choices":[{"delta":{"content":" pronto"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n');
  context.fetch = async (url, options) => {
    payload = JSON.parse(options.body);
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) { if (offset >= bytes.length) return controller.close(); controller.enqueue(bytes.slice(offset, offset += 7)); } }));
  };
  await manager.sendMessage('Prepara il caffè');
  const saved = store.messages(chat.id).at(-1);
  assert.equal(saved.content, 'Caffè ☕ pronto'); assert.equal(saved.status, 'complete');
  assert(!JSON.stringify(payload).includes('PRIVATE TRACE'));
  assert(payload.messages[0].content.includes('Usa italiano'));
  assert.equal(payload.messages.at(-1).content, 'Prepara il caffè');
});

test('abrupt stream termination retains partial text as an error, excluded from future context', async t => {
  const { store, manager, context, chat, errors } = await setup(t);
  context.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"Parziale"}}]}\n');
  await manager.sendMessage('Domanda');
  const saved = store.messages(chat.id).at(-1);
  assert.equal(saved.status, 'error'); assert(saved.content.startsWith('Parziale'));
  assert.equal(store.context(chat.id, '').messages.length, 1);
  assert.equal(manager.isGenerating, false); assert.equal(errors.length, 1);
});

test('stopping a turn keeps the partial answer as a normal saved message and the history intact', async t => {
  const { store, manager, context, chat, errors } = await setup(t);
  // A stream that delivers one chunk and then hangs until the request is aborted.
  context.fetch = async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Parziale"}}]}\n'));
      options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
      setTimeout(() => manager.stopGeneration(), 10);
    }
  }));
  await manager.sendMessage('Domanda');
  const saved = store.messages(chat.id);
  assert.equal(saved.length, 2); assert.equal(saved[0].content, 'Domanda');
  assert.equal(saved[1].status, 'complete'); assert.equal(saved[1].content, 'Parziale');
  assert.equal(store.context(chat.id, '').messages.length, 2);
  assert.equal(manager.isGenerating, false); assert.equal(errors.length, 0);
});

test('failed initial write retains the input and does not invoke the model', async t => {
  const { manager, storage, node, store, chat } = await setup(t);
  storage.save = async () => { throw Error('Disk full'); };
  node('chat-input').value = 'Non perdere questo testo';
  manager.callOpenRouterMaster = () => assert.fail('Model must not run without saved user message');
  await manager.sendMessage(node('chat-input').value);
  assert.equal(node('chat-input').value, 'Non perdere questo testo');
  assert.equal(store.messages(chat.id).length, 0); assert.equal(manager.isGenerating, false);
});

test('demo is saved but excluded from future real context', async t => {
  const { manager, store, chat } = await setup(t, '');
  await manager.sendMessage('Prova');
  assert.equal(store.messages(chat.id)[1].demo, true);
  assert.equal(store.context(chat.id, '').messages.length, 1);
});

test('clear refuses to delete the conversation currently generating', async t => {
  const { manager, chat, store } = await setup(t);
  store.saveMessage(chat.id, { role: 'user', content: 'Keep me' });
  manager.generation = { conversationId: chat.id };
  await assert.rejects(manager.clearHistory(), /Attendi/);
  assert.equal(store.messages(chat.id).length, 1);
});

test('recordTurnChatMemory gives every turn its node in the level memory: user request and answer, without thinking', async t => {
  const { manager, store, chat } = await setup(t);
  store.saveMessage(chat.id, { role: 'user', content: 'Come implemento la feature X?' });
  store.saveMessage(chat.id, {
    role: 'assistant',
    content: '<think>Ragionamento interno non da includere</think>Ecco la risposta completa del bot con codice e spiegazione dettagliata.'
  });

  // no Microtask model here: the turn's own text, cut short, stands in for the summary
  await manager.recordTurnChatMemory(chat.id);

  const { nodes } = store.memoryTree().tree(chat.id);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].level, 1);
  assert.equal(nodes[0].mechanical, true);
  assert(nodes[0].content.includes('Utente: Come implemento la feature X?'));
  assert(nodes[0].content.includes('Risposta: Ecco la risposta completa del bot con codice e spiegazione dettagliata.'));
  assert(!nodes[0].content.includes('<think>'));
  // the turn's messages are one open away
  const opened = store.memoryTree().open(chat.id, nodes[0].id);
  assert.equal(opened.messages[1].content, 'Ecco la risposta completa del bot con codice e spiegazione dettagliata.');
  assert.equal(store.listMemories(chat.id, '', 'conversation').length, 0, 'no note is written for it any more');
});

test('context always passes the entire turn-by-turn chat history in messages even when memory is disabled', async t => {
  const { store, chat } = await setup(t);
  store.saveMessage(chat.id, { role: 'user', content: 'Primo messaggio utente' });
  store.saveMessage(chat.id, { role: 'assistant', content: 'Prima risposta bot' });
  store.saveMessage(chat.id, { role: 'user', content: 'Secondo messaggio utente' });
  store.saveMessage(chat.id, { role: 'assistant', content: 'Seconda risposta bot' });

  // Add some memory notes
  store.saveMemory({ content: 'Nota di memoria globale', scope: 'global', pinned: true });
  store.saveMemory({ content: 'Nota di memoria locale', scope: 'conversation', conversationId: chat.id, pinned: true });

  // Case 1: Memory enabled
  const ctxWithMemory = store.context(chat.id, '', { includeGlobal: true, includeChat: true });
  assert.equal(ctxWithMemory.messages.length, 4, 'Full turn-by-turn messages must be passed');
  assert.equal(ctxWithMemory.memories.length, 2, 'Memory notes injected when enabled');

  // Case 2: Memory disabled (both local and global)
  store.updateConversation(chat.id, { memoryEnabled: false, globalMemoryEnabled: false });
  const ctxNoMemory = store.context(chat.id, '', { includeGlobal: false, includeChat: false });
  assert.equal(ctxNoMemory.messages.length, 4, 'Full chat history is STILL passed even when memory is disabled');
  assert.equal(ctxNoMemory.messages[0].role, 'user');
  assert.equal(ctxNoMemory.messages[0].content, 'Primo messaggio utente');
  assert.equal(ctxNoMemory.messages[1].role, 'assistant');
  assert.equal(ctxNoMemory.messages[1].content, 'Prima risposta bot');
  assert.equal(ctxNoMemory.memories.length, 0, 'No memory notes injected when disabled');
  assert.equal(ctxNoMemory.globalItems.length, 0);
  assert.equal(ctxNoMemory.chatItems.length, 0);
});

test('a card that waits an answer is kept in the archive while it waits, and taken off it when answered', async t => {
  const { manager, chat, store, context } = await setup(t);
  Object.assign(context, { setTimeout, clearTimeout });
  const tc = { id: 'call-1', name: 'write_file', args: '{}', status: 'executing' };
  const message = manager.makeMessage('assistant', '', { isStreaming: true, turns: [{ toolCalls: [tc] }] });
  const approval = { id: 'appr-1', kind: 'code', name: 'write_file', reason: 'manual', summary: { title: 'overwrite', path: 'a.js' }, expiresAt: new Date(Date.now() + 60000).toISOString() };
  const waiting = manager.awaitApproval(tc, approval, message, chat.id);
  await new Promise(resolve => setTimeout(resolve, 10));
  // What a paired phone reads: the call waits, with what is asked.
  let kept = store.messages(chat.id).find(m => m.id === message.id).turns[0].toolCalls[0];
  assert.equal(kept.status, 'awaiting');
  assert.equal(kept.approval.id, 'appr-1');
  manager.settleApproval('appr-1', { approved: true, result: {} });
  assert.equal((await waiting).approved, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  kept = store.messages(chat.id).find(m => m.id === message.id).turns[0].toolCalls[0];
  assert.equal(kept.approval, undefined);
  assert.equal(kept.status, 'executing');
  assert.equal(kept.approvalOutcome, 'allow');
  // Past its time a card kept in the archive is not shown as one to answer.
  assert.equal(manager.renderApproval({ approval: { ...approval, expiresAt: new Date(Date.now() - 1000).toISOString() } }), '');
});

test('an answer being written is told to a connected phone as it grows: the whole once, then only what changed', async t => {
  const { manager, chat, context, storage } = await setup(t);
  const sent = [];
  storage.bridgeSend = async message => { sent.push(message.header); return { sent: 1 }; };
  storage.bridgeStatus = async () => { throw new Error('not in this test'); };
  context.window.realtime = { _state: { conversationId: 'assistant-chat' } };
  context.window.livePatch = require('../resources/js/live-patch.js');
  // The page keeps asking the service how the bridge is: its timers do not hold the test open.
  Object.assign(context, { setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout });
  context.document.readyState = 'complete';
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../resources/js/bridge.js'), 'utf8'), context);
  const bridge = context.window.phoneBridge;
  assert.equal(manager.bridgeHooked, true);
  bridge.status = { devices: [{ connected: true }] };
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const live = () => sent.filter(header => header.name === 'chat.live').map(header => header.data);

  const message = manager.makeMessage('assistant', '', { isStreaming: true, turns: [], reasoning: '' });
  await manager.persist(message, chat.id);
  await wait(160);
  assert.equal(live().length, 1);
  assert.deepEqual([live()[0].conversationId, live()[0].id, live()[0].n, live()[0].full.content], [chat.id, message.id, 0, '']);

  // Words arrive: nothing is saved, the phone is told the words alone. The first at once (the pace is
  // kept by the clock, so that it holds with the window closed), the ones that follow it together.
  for (const word of ['Ciao', ' a', ' te']) { message.content += word; manager.updateMessageStream(message); }
  assert.deepEqual(JSON.parse(JSON.stringify(live()[1])), { conversationId: chat.id, id: message.id, n: 1, ops: [{ p: ['content'], o: 0, t: 'Ciao' }] });
  await wait(160);
  assert.equal(live().length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(live()[2])), { conversationId: chat.id, id: message.id, n: 2, ops: [{ p: ['content'], o: 4, t: ' a te' }] });
  // Nothing new, nothing told.
  manager.updateMessageStream(message);
  await wait(160);
  assert.equal(live().length, 3);

  // A phone that missed something asks for the whole: as it was last told, so that what follows fits.
  await wait(10);
  message.content += ' oggi';
  const whole = await bridge.handlers.get('chat.live')({ conversationId: chat.id });
  assert.deepEqual(JSON.parse(JSON.stringify(whole.messages)).map(m => [m.id, m.n, m.full.content]), [[message.id, 2, 'Ciao a te']]);

  // Written to the end: told one last time, and no longer followed.
  message.isStreaming = false; message.status = 'complete';
  await manager.persist(message, chat.id);
  const last = live().at(-1);
  assert.equal(last.done, true);
  assert.equal(last.n, 3);
  const there = JSON.parse(JSON.stringify(live()[0].full));
  for (const packet of live().slice(1)) assert.equal(context.window.livePatch.apply(there, JSON.parse(JSON.stringify(packet.ops))), true);
  assert.deepEqual([there.content, there.isStreaming, there.status], ['Ciao a te oggi', false, 'complete']);
  assert.equal(bridge.live.size, 0);
});

test('an approved action says it is running at once, while the service still answers; the card is gone', async t => {
  const { manager, chat, store, context, storage } = await setup(t);
  Object.assign(context, { setTimeout, clearTimeout });
  const answer = deferred();
  storage.decideApproval = async () => answer.promise;
  const tc = { id: 'call-1', name: 'sandbox_exec', args: '{}', status: 'executing' };
  const message = manager.makeMessage('assistant', '', { isStreaming: true, turns: [{ toolCalls: [tc] }] });
  const approval = { id: 'appr-2', kind: 'terminal', name: 'sandbox_exec', reason: 'manual', summary: { title: 'command', detail: 'python a.py' }, expiresAt: new Date(Date.now() + 60000).toISOString() };
  const waiting = manager.awaitApproval(tc, approval, message, chat.id);
  assert.equal(tc.status, 'awaiting');
  assert.match(manager.renderApproval(tc), /chat-tool-approval/);
  const deciding = manager.decideApproval('appr-2', 'allow');
  // The command runs while the service answers: the call says so, and there is nothing left to press.
  assert.equal(tc.status, 'executing');
  assert.equal(manager.renderApproval(tc), '');
  answer.resolve({ approved: true, result: { stdout: 'ok' } });
  await deciding;
  assert.equal((await waiting).approved, true);
  assert.equal(tc.approval, undefined);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.messages(chat.id).find(m => m.id === message.id).turns[0].toolCalls[0].status, 'executing');
});
