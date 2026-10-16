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
const calls = (name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c-${name}-${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
const says = (content) => ({ choices: [{ delta: { content }, finish_reason: 'stop' }] });

/** A project's chat on the computer's page, with a model played by `answer(lastUserText, afterTool, payload)`. */
async function setup(t, answer) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const project = store.createProject({ name: 'Sito', kind: 'local', path: 'C:/sito' });
  const conversation = store.createConversation('Lavoro', project.id);
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
    codeToolSpecs: async () => ({ tools: [] }),
    projectTree: async () => ({ root: 'C:/sito', files: ['a.js'], total: 1, runsCommands: false }),
    memoryPending: async () => [], memoryAddNode: async () => {}, memoryOpen: async () => {}, saveMemory: async () => {}
  };
  const listeners = new Map();
  const document = {
    readyState: 'complete', getElementById: id => (/^chat-(btn-plan|plan-panel)$/.test(id) ? null : node(id)), querySelectorAll() { return []; }, querySelector() { return null; },
    addEventListener(name, fn) { listeners.set(name, [...(listeners.get(name) || []), fn]); },
    dispatchEvent(event) { (listeners.get(event.type) || []).forEach(fn => fn(event)); }
  };
  const local = new Map();
  const window = { chatStorage: storage, addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    operationalRegistry: { getCurrentMasterModel: () => ({ id: 'test/model', name: 'M', hasTools: true }), getAllConfigurableItems: () => [], getModelParameters: () => ({}), getSelectedMasterId: () => 'test/model',
      buildActiveToolSpecs: () => ({ tools: [], promptSection: '', toolMeta: new Map() }) },
    openRouterCatalog: { getApiKey: () => 'k' },
    chatWorkspace: { refresh: async () => {}, renderActive() {}, error: e => errors.push(e), perform: async fn => fn() } };
  const payloads = [];
  const context = vm.createContext({ window, document, crypto: webcrypto, console, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    localStorage: { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, String(value)), removeItem: key => local.delete(key) },
    AbortSignal, AbortController, TextDecoder, clearTimeout,
    // The page asks the provider for costs a while after a turn: its timers do not hold the test open.
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
    fetch: async (url, options) => {
      const payload = JSON.parse(options.body);
      payloads.push(payload);
      const users = payload.messages.filter(m => m.role === 'user');
      const given = answer(String(users.at(-1)?.content || ''), payload.messages.at(-1).role === 'tool', payload);
      // A model that goes on writing until it is stopped.
      if (given === 'HANG') {
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(sse(says('Sto lavorando')).slice(0, 60));
          const end = () => { try { controller.error(new DOMException('The operation was aborted.', 'AbortError')); } catch {} };
          if (options.signal?.aborted) end(); else options.signal?.addEventListener('abort', end);
        } }));
      }
      const body = sse(given);
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }));
    } });
  vm.runInContext(read('model-gateway.js'), context);
  vm.runInContext(read('chat.js'), context);
  vm.runInContext(read('plan.js'), context);
  const manager = window.chatManager;
  manager.__context = context;
  manager.ready = true;
  await manager.selectConversation(conversation.id);
  const plain = (value) => JSON.parse(JSON.stringify(value));
  return { store, project, conversation, manager, plans: window.planMode, payloads, errors, plain, events: () => listeners };
}

const POINTS = [
  { title: 'Scrivere la funzione', instructions: 'Aggiungi somma(a, b) in a.js.', check: 'node -e "require(\'./a\').somma(1,2) === 3"' },
  { title: 'Scrivere la prova', instructions: 'Aggiungi a.test.js.', check: 'npm test passa' }
];

test('a request with the plan on is written as a plan, then its points are injected in order, each checked, and injected again when the check does not pass', async t => {
  const seen = { check1: 0, point2: 0 };
  const { store, project, conversation, manager, plans, payloads, errors, plain } = await setup(t, (user, afterTool) => {
    if (afterTool) return says('Fatto.');
    if (!user.startsWith('[PIANO')) return calls('plan_write', { points: POINTS });
    if (user.startsWith('[PIANO · verifica del punto 1')) return calls('plan_check', ++seen.check1 === 1 ? { passed: false, missing: 'manca l\'export' } : { passed: true });
    if (user.startsWith('[PIANO · punto 1')) return calls('plan_done', { summary: 'funzione scritta' });
    if (user.startsWith('[PIANO · verifica del punto 2')) return calls('plan_check', { passed: true });
    // The second point: the first turn ends without declaring it finished.
    if (user.startsWith('[PIANO · punto 2')) return ++seen.point2 === 1 ? says('Ci sto lavorando.') : calls('plan_done', { summary: 'prova scritta' });
    if (user.startsWith('[PIANO · fine')) return says('Riepilogo: due punti fatti.');
    throw new Error(`unexpected: ${user.slice(0, 60)}`);
  });
  await plans.setSettings(project.id, { mode: 'auto', tries: 4 });
  assert.deepEqual(plain(await plans.settings(project.id)), { mode: 'auto', tries: 4 });

  // Off, the request is an ordinary one; on, it is planned.
  assert.equal(await plans.wanted(store.conversation(conversation.id)), false);
  plans.setOn(conversation.id, true);
  assert.equal(await plans.wanted(store.conversation(conversation.id)), true);
  await manager.sendMessage('Aggiungi la somma con la sua prova');
  for (let i = 0; i < 400 && !(plans.of(conversation.id)?.status === 'done' && !plans.active(conversation.id)); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(errors.map(e => e.message), []);

  const plan = JSON.parse(store.getSetting(`plan_${conversation.id}`));
  assert.equal(plan.status, 'done');
  assert.deepEqual(plan.points.map(point => [point.title, point.status, point.tries]), [['Scrivere la funzione', 'done', 2], ['Scrivere la prova', 'done', 2]]);

  // What the chat holds: the user's request as written, then the turns the plan injected, each marked for what it is.
  const users = store.messages(conversation.id).filter(m => m.role === 'user');
  assert.equal(users[0].content, 'Aggiungi la somma con la sua prova');
  assert.equal(users[0].plan, undefined);
  assert.deepEqual(users.slice(1).map(m => [m.plan.phase, m.plan.index, m.plan.attempt || null]), [
    ['point', 0, 1], ['check', 0, null], ['point', 0, 2], ['check', 0, null],
    ['point', 1, 1], ['point', 1, 2], ['check', 1, null], ['final', 0, null]
  ]);
  // The point injected again says what the check found missing; the one left open, that it was left open.
  assert.match(users[3].content, /La verifica non è passata\. Manca: manca l'export/);
  assert.match(users[6].content, /senza che fosse dichiarato finito/);
  assert.match(users[1].content, /Aggiungi somma\(a, b\) in a\.js\.[\s\S]*Come si verifica: node -e/);
  assert.match(users[1].content, /1\. \[in corso\] Scrivere la funzione\n2\. \[da fare\] Scrivere la prova/);

  // Every request marks at most 4 places for the provider's cache (Anthropic refuses more), however many steps came before.
  const marks = (payload) => [...payload.messages, ...(payload.tools || [])].filter(item => item.cache_control).length;
  assert.ok(payloads.length > 10);
  assert.deepEqual(payloads.map(marks).filter(n => n > 4), []);
  assert.ok(payloads.every(payload => marks(payload) >= 2), 'the cache is still used');

  // Each turn has the plan's tool for that moment, and only that.
  const toolsOf = (payload) => (payload.tools || []).map(tool => tool.function.name).filter(name => name.startsWith('plan_'));
  assert.deepEqual(toolsOf(payloads[0]), ['plan_write']);
  assert.match(payloads[0].messages[0].content, /\[PIANO\] Questa richiesta va svolta con un piano/);
  const first = (start) => payloads.find(p => String(p.messages.filter(m => m.role === 'user').at(-1).content).startsWith(start));
  assert.deepEqual(toolsOf(first('[PIANO · punto 1')), ['plan_done', 'plan_stop']);
  assert.deepEqual(toolsOf(first('[PIANO · verifica del punto 1')), ['plan_check']);
  assert.deepEqual(toolsOf(first('[PIANO · fine')), []);
  assert.doesNotMatch(first('[PIANO · punto 1').messages[0].content, /Questa richiesta va svolta con un piano/);

  // With a plan done, the next request with the switch on is planned again; with one open, it is an ordinary message.
  assert.equal(await plans.wanted(store.conversation(conversation.id)), true);
  // An injected turn is shown for what it is.
  assert.equal(plans.label({ phase: 'point', index: 0, of: 2, title: 'Scrivere la funzione', attempt: 2 }), 'plan.markPoint · plan.markAttempt');
});

test('manual: the plan waits to be read and started; a point can be corrected or taken off before', async t => {
  const { store, project, conversation, plans, plain } = await setup(t, (user, afterTool) => {
    if (afterTool) return says('Ok.');
    if (!user.startsWith('[PIANO')) return calls('plan_write', { points: [...POINTS, { title: 'Di troppo', instructions: 'Niente.', check: 'niente' }] });
    if (user.includes('verifica del punto')) return calls('plan_check', { passed: true });
    if (user.startsWith('[PIANO · punto')) return calls('plan_done', { summary: 'fatto' });
    return says('Riepilogo.');
  });
  assert.deepEqual(plain(await plans.settings(project.id)), { mode: 'manual', tries: 5 });
  const written = await plans.begin(conversation.id, 'Fai la somma');
  assert.equal(written.status, 'draft');
  assert.equal(plans.active(conversation.id), false);
  assert.equal(store.messages(conversation.id).filter(m => m.plan).length, 0, 'nothing is injected until it is started');

  await plans.edit(conversation.id, 2, null);
  await plans.edit(conversation.id, 0, { title: 'Scrivere somma', instructions: 'Aggiungi somma(a, b) e esportala.', check: 'somma(1,2) dà 3' });
  const draft = JSON.parse(store.getSetting(`plan_${conversation.id}`));
  assert.deepEqual(draft.points.map(point => point.title), ['Scrivere somma', 'Scrivere la prova']);

  await plans.follow(conversation.id);
  const plan = JSON.parse(store.getSetting(`plan_${conversation.id}`));
  assert.equal(plan.status, 'done');
  assert.match(store.messages(conversation.id).find(m => m.plan?.phase === 'point').content, /Aggiungi somma\(a, b\) e esportala\./);
});

test('a point that never passes is tried the number of times set, then the plan stops and waits for the user; the Master can stop it too', async t => {
  let stopNow = false;
  const { store, project, conversation, plans } = await setup(t, (user, afterTool) => {
    if (afterTool) return says('Ok.');
    if (!user.startsWith('[PIANO')) return calls('plan_write', { points: POINTS });
    if (user.includes('verifica del punto')) return calls('plan_check', { passed: false, missing: 'la prova fallisce' });
    if (stopNow) return calls('plan_stop', { reason: 'Serve la chiave del servizio.' });
    return calls('plan_done', { summary: 'fatto' });
  });
  await plans.setSettings(project.id, { mode: 'auto', tries: 2 });
  await plans.begin(conversation.id, 'Fai la somma');
  for (let i = 0; i < 400 && !(plans.of(conversation.id)?.status === 'blocked' && !plans.active(conversation.id)); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  let plan = JSON.parse(store.getSetting(`plan_${conversation.id}`));
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.current, 0);
  assert.equal(plan.points[0].tries, 2);
  assert.match(plan.reason, /plan\.outOfTries la prova fallisce/);
  assert.equal(store.messages(conversation.id).filter(m => m.plan?.phase === 'point').length, 2);

  // Started again by the user, the point has its attempts again; this time the Master says it cannot go on.
  stopNow = true;
  await plans.follow(conversation.id);
  plan = JSON.parse(store.getSetting(`plan_${conversation.id}`));
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.reason, 'Serve la chiave del servizio.');
  assert.equal(store.messages(conversation.id).filter(m => m.plan?.phase === 'point').length, 3);

  // Put away: the chat goes on as any other.
  await plans.close(conversation.id);
  assert.equal(JSON.parse(store.getSetting(`plan_${conversation.id}`)).status, 'closed');
  assert.equal(await plans.wanted({ id: conversation.id, project_id: project.id }, true), true);
});

test('the plan is stopped while the Master works on a point: the turn ends there, nothing else is injected, and it can be taken up again', async t => {
  let hang = true;
  const { store, project, conversation, plans, errors } = await setup(t, (user, afterTool) => {
    if (afterTool) return says('Ok.');
    if (!user.startsWith('[PIANO')) return calls('plan_write', { points: POINTS });
    if (user.includes('verifica del punto')) return calls('plan_check', { passed: true });
    if (user.startsWith('[PIANO · punto')) return hang ? 'HANG' : calls('plan_done', { summary: 'fatto' });
    return says('Riepilogo.');
  });
  await plans.setSettings(project.id, { mode: 'auto', tries: 5 });
  await plans.begin(conversation.id, 'Fai la somma');
  const injected = () => store.messages(conversation.id).filter(m => m.plan).length;
  for (let i = 0; i < 300 && !(plans.active(conversation.id) && injected() === 1); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(plans.of(conversation.id).status, 'running');
  await new Promise(resolve => setTimeout(resolve, 50));

  await plans.stop(conversation.id);
  for (let i = 0; i < 300 && plans.active(conversation.id); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(plans.active(conversation.id), false, 'the plan is no longer followed');
  let plan = JSON.parse(store.getSetting(`plan_${conversation.id}`));
  assert.equal(plan.status, 'paused');
  assert.equal(plan.reason, '');
  assert.equal(injected(), 1, 'nothing more is injected after the stop');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(injected(), 1);
  assert.equal(store.messages(conversation.id).some(m => m.status === 'streaming'), false, 'no answer is left being written');

  // Taken up again, it goes on from the point it was at.
  hang = false;
  await plans.follow(conversation.id);
  plan = JSON.parse(store.getSetting(`plan_${conversation.id}`));
  assert.equal(plan.status, 'done');
  assert.deepEqual(errors.map(e => e.message), []);
});

test('from the phone: a request with the plan on is planned by the computer, and the phone\'s stop button stops the plan', async t => {
  let hang = true;
  const { store, project, conversation, plans, manager } = await setup(t, (user, afterTool) => {
    if (afterTool) return says('Ok.');
    if (!user.startsWith('[PIANO')) return calls('plan_write', { points: POINTS });
    if (user.includes('verifica del punto')) return calls('plan_check', { passed: true });
    if (user.startsWith('[PIANO · punto')) return hang ? 'HANG' : calls('plan_done', { summary: 'fatto' });
    return says('Riepilogo.');
  });
  const context = manager.__context;
  const told = [];
  context.window.chatStorage.bridgeSend = async message => { told.push(message.header); return { sent: 1 }; };
  context.window.chatStorage.bridgeStatus = async () => { throw new Error('not in this test'); };
  context.window.livePatch = require('../resources/js/live-patch.js');
  vm.runInContext(read('bridge.js'), context);
  const bridge = context.window.phoneBridge;
  bridge.status = { devices: [{ connected: true }] };
  const ask = (method, params) => bridge.handlers.get(method)(params);
  await plans.setSettings(project.id, { mode: 'auto', tries: 5 });

  const sent = await ask('chat.send', { conversationId: conversation.id, text: 'Fai la somma', id: 'from-phone-1', plan: true });
  assert.equal(sent.plan, true);
  const injected = () => store.messages(conversation.id).filter(m => m.plan).length;
  for (let i = 0; i < 300 && !(plans.of(conversation.id)?.status === 'running' && injected() === 1); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.messages(conversation.id)[0].id, 'from-phone-1', 'the request is the message the phone wrote');
  // The phone sees the chat as one where the computer is answering, for as long as the plan is followed.
  assert.deepEqual(JSON.parse(JSON.stringify((await ask('chat.running', {})).running)), [conversation.id]);
  await assert.rejects(ask('chat.send', { conversationId: conversation.id, text: 'altro' }), error => error.code === 'working');
  await new Promise(resolve => setTimeout(resolve, 50));

  await ask('chat.stop', { conversationId: conversation.id });
  for (let i = 0; i < 300 && plans.active(conversation.id); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.parse(store.getSetting(`plan_${conversation.id}`)).status, 'paused');
  assert.equal(injected(), 1);
  assert.deepEqual(JSON.parse(JSON.stringify((await ask('chat.running', {})).running)), []);
  const running = told.filter(header => header.name === 'chat.running').map(header => header.data.running);
  assert.equal(running.at(-1), false, 'the phone is told the computer has stopped');

  // Taken up again from the phone, and stopped with the plan's own button.
  await ask('plan.start', { conversationId: conversation.id });
  for (let i = 0; i < 300 && !(plans.active(conversation.id) && injected() === 2); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 50));
  await ask('plan.stop', { conversationId: conversation.id });
  for (let i = 0; i < 300 && plans.active(conversation.id); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.parse(store.getSetting(`plan_${conversation.id}`)).status, 'paused');
  assert.equal(injected(), 2);
});

test('a plan left "running" by the app closing is a stopped one: written so at the next start, and by the stop button when nothing follows it', async t => {
  const { store, project, conversation, plans } = await setup(t, () => says('Ok.'));
  const left = { id: 'p', conversationId: conversation.id, projectId: project.id, request: 'x', status: 'running', current: 0, tries: 5, reason: '', points: [{ title: 'A', instructions: 'a', check: 'c', status: 'checking', tries: 1, summary: 's', missing: '' }] };
  store.setSetting(`plan_${conversation.id}`, JSON.stringify(left));
  await plans.settle();
  let kept = JSON.parse(store.getSetting(`plan_${conversation.id}`));
  assert.deepEqual([kept.status, kept.points[0].status], ['paused', 'todo']);

  // The phone shows a plan as running and its stop is pressed, with nothing following it on the computer.
  store.setSetting(`plan_${conversation.id}`, JSON.stringify(left));
  await plans.stop(conversation.id);
  kept = JSON.parse(store.getSetting(`plan_${conversation.id}`));
  assert.deepEqual([kept.status, kept.points[0].status], ['paused', 'todo']);
});
