'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Store } = require('../server/database');
const { createApp } = require('../server');
const W = require('../resources/js/realtime-wellbeing.js');
const Watch = require('../resources/js/realtime-watch.js');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* What takes no model                                                  */
/* ------------------------------------------------------------------ */

const CHATS = [
  { id: 'c1', title: 'Chat AI 2', project: 'SynthOrg', projectId: 'p1' },
  { id: 'c2', title: 'Chat AI 1', project: 'SynthOrg', projectId: 'p1' },
  { id: 'c3', title: 'Ricette di casa', project: '', projectId: '' },
  { id: 'c4', title: 'Sito del negozio', project: 'Negozio', projectId: 'p2' },
  { id: 'c5', title: 'Appunti negozio', project: '', projectId: '' }
];

test('the chat the user named is found by its title or its project, and none is chosen between two that match as well', () => {
  const found = (said) => Watch.findChat(said, CHATS);
  assert.equal(found('le ricette').found.id, 'c3');
  assert.equal(found('il progetto synthorg').found.id, 'c1', 'a project named: the most recent of its chats');
  assert.equal(found('Chat AI 1').found.id, 'c2', 'the title said whole wins');
  assert.equal(found('sito negozio').found.id, 'c4');
  assert.deepEqual(found('negozio').among.map(chat => chat.id), ['c4', 'c5'], 'two chats of different projects: asked which');
  assert.deepEqual([found('la tesi').found, found('la tesi').among.length], [null, 0]);
  assert.deepEqual([found('il progetto').found, found('').found], [null, null], 'nothing said that names one');
});

const answerWith = (content, toolCalls = [], more = {}) => ({ role: 'assistant', content, status: 'complete', turns: [{ toolCalls }], ...more });

test('a turn is given to be judged with what was asked, by whom, the tools called and how it ended', () => {
  const answer = answerWith('Ho corretto il test.', [
    { name: 'write_file', args: '{"path":"a.js"}', result: 'ok' },
    { name: 'run_terminal', args: { command: 'npm test' }, result: { exit: 0, out: '12 passed' } },
    { name: 'run_terminal', args: '{"command":"rm -rf x"}', approvalOutcome: 'deny' }
  ]);
  const digest = Watch.turnDigest({ request: 'Correggi il test', by: 'assistant', answer });
  assert.match(digest, /\[REQUEST - written by you, as an instruction\]\nCorreggi il test/);
  assert.match(digest, /- write_file\(\{"path":"a\.js"\}\) -> ok/);
  assert.match(digest, /- run_terminal\(\{"command":"npm test"\}\) -> \{"exit":0,"out":"12 passed"\}/);
  assert.match(digest, /rm -rf x"\}\) -> refused/);
  assert.match(digest, /\[ANSWER - complete\]\nHo corretto il test\./);
  assert.match(Watch.turnDigest({ request: 'x', answer: answerWith('', [], { status: 'error' }) }), /written by the user[\s\S]*\(none\)[\s\S]*ANSWER - ended with an error\]\n\(empty\)/);
  // a long answer keeps its start and its end
  const long = Watch.turnDigest({ request: 'x', answer: answerWith('INIZIO ' + 'a'.repeat(9000) + ' FINE') });
  assert.ok(long.includes('INIZIO') && long.includes('FINE') && long.includes('[…]') && long.length < 6500);
  // the last turn of a chat, from its messages
  const turn = Watch.lastTurn([{ role: 'user', content: 'uno' }, answerWith('due'), { role: 'user', content: 'tre', by: 'assistant' }, { role: 'tool', kind: 'execution', content: 'x' }, answer]);
  assert.deepEqual([turn.request, turn.by, turn.answer.content], ['tre', 'assistant', 'Ho corretto il test.']);
  assert.deepEqual(plain(Watch.lastTurn([])), { request: '', by: '', answer: null, failed: false });
});

test('the messages of a chat are given to a task newest first, as many as fit', () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `messaggio ${i} ${'x'.repeat(900)}` }));
  const { text, left } = Watch.material(messages, (m) => (m.role === 'user' ? '[Utente]' : '[Risposta]'), 5000);
  assert.ok(text.includes('messaggio 29') && !text.includes('messaggio 0 '));
  assert.ok(left > 20 && text.length < 6500);
  assert.deepEqual(Watch.material([], () => ''), { text: '', left: 0 });
});

test('what the Master answers is a judgement only when it is one', () => {
  assert.deepEqual(Watch.parseVerdict('{"verdict":"continue","message":"Esegui i test","why":"Non sono stati eseguiti"}'), { verdict: 'continue', message: 'Esegui i test', why: 'Non sono stati eseguiti' });
  assert.deepEqual(Watch.parseVerdict('Ecco:\n```json\n{"verdict":"done","message":"ignored","why":"Tutto fatto"}\n```'), { verdict: 'done', message: '', why: 'Tutto fatto' });
  assert.equal(Watch.parseVerdict('{"verdict":"continue","message":"  "}'), null, 'nothing to write is not an instruction');
  assert.equal(Watch.parseVerdict('{"verdict":"maybe"}'), null);
  assert.equal(Watch.parseVerdict('va tutto bene'), null);
  assert.deepEqual(Watch.parsePermit('{"allow":false,"why":"Non serve"}'), { allow: false, why: 'Non serve' });
  assert.equal(Watch.parsePermit('{"allow":"yes"}'), null, 'not a yes or a no: nothing is decided');
});

test('a chat is watched only with orders and both limits, and is held to them', () => {
  const entry = { orders: 'Finisci i test', maxSteps: 3, maxSpend: 0.5, steps: 0 };
  assert.equal(Watch.ready(entry), true);
  for (const lacking of [{ orders: ' ' }, { maxSteps: null }, { maxSteps: 0 }, { maxSpend: null }, { maxSpend: -1 }]) assert.equal(Watch.ready({ ...entry, ...lacking }), false);
  assert.equal(Watch.limitHit(entry, 0.2), null);
  assert.equal(Watch.limitHit({ ...entry, steps: 3 }, 0), 'steps');
  assert.equal(Watch.limitHit(entry, 0.5), 'spend');
  assert.equal(Watch.limitHit({ ...entry, maxSpend: 0 }, 0), null, 'a chat that cost nothing, on a model of this computer, does not reach the spend');
  assert.equal(Watch.limitHit({ ...entry, maxSpend: 0 }, 0.001), 'spend');
  const logged = { log: [] };
  for (let i = 0; i < 40; i++) Watch.logged(logged, { kind: 'continue', message: String(i) });
  assert.deepEqual([logged.log.length, logged.log[0].message, logged.log[29].message], [30, '10', '39']);
});

test('the request that judges a turn carries the orders, the count, the last instructions and the plan', () => {
  const entry = { orders: 'Porta i test a verde', maxSteps: 5, steps: 2, log: [{ kind: 'continue', message: 'Esegui npm test' }, { kind: 'ask', why: 'x' }] };
  const text = Watch.watchRequest({ title: 'Chat AI 1', project: 'SynthOrg', entry, plan: { status: 'blocked', reason: 'tre tentativi', current: 1, points: [{ title: 'Uno', status: 'done' }, { title: 'Due', status: 'todo' }] }, turn: { request: 'x', answer: answerWith('y') } });
  assert.match(text, /\[CHAT\]\nChat AI 1 - project SynthOrg/);
  assert.match(text, /\[ORDERS FOR THIS CHAT\]\nPorta i test a verde/);
  assert.match(text, /2 of 5 allowed\.\nThe last ones:\n- Esegui npm test/);
  assert.match(text, /\[PLAN OF THE CHAT\]\nStatus: blocked \(tre tentativi\)\. Point 2 of 2\.\n1\. \[done\] Uno\n2\. \[todo\] Due/);
  assert.ok(Watch.WATCH_RULES.includes('"continue" | "done" | "ask"') && Watch.PERMIT_RULES.includes('"allow": true | false'));
  assert.match(Watch.permitRequest({ title: 'T', entry, tool: 'run_terminal', approval: { kind: 'terminal', reason: 'new', summary: { detail: 'npm install left-pad' } } }), /Tool: run_terminal\nKind: terminal\nAsked because: new\nDetail:\nnpm install left-pad/);
});

/* ------------------------------------------------------------------ */
/* The server: who wrote a message, what a chat cost                    */
/* ------------------------------------------------------------------ */

test('a message written by the assistant in a chat is kept as such, and what a chat cost in a day is summed', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const chat = store.createConversation('Lavoro');
  store.saveMessage(chat.id, { role: 'user', content: 'Mio' });
  store.saveMessage(chat.id, { role: 'user', content: 'Scritto da MO\'', by: 'assistant' });
  store.saveMessage(chat.id, { role: 'user', content: 'Altro', by: 'someone' });
  assert.deepEqual(store.messages(chat.id).map(m => JSON.parse(m.meta_json || '{}').by ?? m.by ?? null), [null, 'assistant', null]);
  const usage = store.usage();
  const other = store.createConversation('Altra');
  const day = new Date();
  const today = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  usage.record({ conversationId: chat.id, role: 'master', model: 'a/b', cost: 0.25, promptTokens: 10, completionTokens: 5 });
  usage.record({ conversationId: chat.id, role: 'job:watch', model: 'a/b', cost: 0.05, promptTokens: 10, completionTokens: 5 });
  usage.record({ conversationId: chat.id, role: 'master', model: 'a/b', promptTokens: 10, completionTokens: 5, generation: 'gen-1' });
  usage.record({ conversationId: other.id, role: 'master', model: 'a/b', cost: 9 });
  const spent = usage.spentBy(chat.id, today);
  assert.deepEqual([Number(spent.cost.toFixed(2)), spent.runs, spent.waiting], [0.3, 3, 1]);
  assert.deepEqual(usage.spentBy(chat.id, '2001-01-01'), { cost: 0, runs: 0, waiting: 0 });
  assert.deepEqual(usage.spentBy('nobody', 'not a day'), { cost: 0, runs: 0, waiting: 0 });
});

test('what a chat cost in a day is asked of the archive, the way the page asks it', async t => {
  const { server, store } = createApp({ token: 'secret', dbPath: ':memory:', githubPort: 0, sandbox: { async stopAllContainers() { return { success: true, count: 0 }; }, async deleteWorkspace() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body) => (await fetch(base + url, { method, headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  const chat = await call('POST', '/conversations', { title: 'Lavoro' });
  await call('POST', '/usage', { conversationId: chat.id, role: 'job:watch', model: 'a/b', cost: 0.02, promptTokens: 900, completionTokens: 100 });
  const day = new Date();
  const today = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  // the same address the page builds (resources/js/storage.js usageOfChat)
  assert.deepEqual(await call('GET', `/usage/chat?id=${encodeURIComponent(chat.id)}&day=${today}`), { cost: 0.02, runs: 1, waiting: 0 });
  assert.ok(read('resources/js/storage.js').includes('/usage/chat?id='));
});

/* ------------------------------------------------------------------ */
/* The section: reading, writing and watching over a chat               */
/* ------------------------------------------------------------------ */

function section({ relay = false, chats = CHATS, held = {} } = {}) {
  const turns = [];        // the turns asked of a chat's Master: { id, text, options, done(answer), fail(error) }
  const spoken = [];
  const kept = [];
  const told = [];
  const settings = new Map();
  const asked = [];        // the requests to the Master that judges: { kind, stable, user, about }
  const replies = [];      // what it answers, in order
  const decided = [];      // the permissions answered
  const opened = [];
  const spent = {};
  const listeners = new Map();
  const node = () => ({ hidden: false, disabled: false, className: '', dataset: {}, innerHTML: '', textContent: '', value: '', placeholder: '', title: '', open: false,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, setAttribute() {}, addEventListener() {}, appendChild() {}, remove() {}, close() {}, querySelector: () => node(), querySelectorAll: () => [] });
  const approvals = new Map();
  const window = {
    RealtimeWellbeing: W, RealtimeWatch: Watch,
    addEventListener: (name, run) => listeners.set(name, run),
    i18n: { t: (key, p) => key + (p && Object.keys(p).length ? ' ' + JSON.stringify(p) : ''), getLocale: () => 'it' },
    openRouterCatalog: { getApiKey: () => 'key', models: [] },
    operationalRegistry: { getCurrentRealtimeMultiModel: () => ({ id: 'model/listens', name: 'Listens' }), getToolDelegate: () => 'auto', getCurrentMasterModel: () => ({ id: 'model/master', name: 'Master' }) },
    planMode: { runs: new Map(), active(id) { return this.runs.has(id); }, of: () => null, load: async () => null, stop: async (id) => { opened.push(['plan.stop', id]); } },
    chatStorage: {
      realtime: async () => ({ conversation: { id: 'rt' }, tasksConversationId: 'tasks' }),
      context: async () => ({ messages: [], memories: [] }),
      getSetting: async (key) => ({ value: settings.get(key) ?? null }),
      setSetting: async (key, value) => { settings.set(key, value); },
      list: async () => chats.filter(chat => !chat.projectId).map(chat => ({ id: chat.id, title: chat.title, updated_at: chat.updated || '2026-10-08T10:00:00Z' })).concat([{ id: 'tasks', title: 'Compiti', updated_at: '2026-10-08T12:00:00Z' }]),
      listProjects: async () => [{ id: 'p1', name: 'SynthOrg', kind: 'podman' }, { id: 'p2', name: 'Negozio', kind: 'local' }],
      listProjectChats: async (projectId) => chats.filter(chat => chat.projectId === projectId).map(chat => ({ id: chat.id, title: chat.title, project_id: projectId, updated_at: chat.updated || '2026-10-08T11:00:00Z' })),
      get: async (id) => ({ conversation: { id, project_id: chats.find(chat => chat.id === id)?.projectId || null }, messages: held[id] || [] }),
      getBare: async (id) => ({ conversation: { id, project_id: chats.find(chat => chat.id === id)?.projectId || null }, messages: [] }),
      openProject: async (id) => { opened.push(['project', id]); },
      usageOfChat: async (id) => ({ cost: spent[id] || 0, runs: 0, waiting: 0 }),
      projectPointers: async (projectId) => ({ name: projectId === 'p1' ? 'SynthOrg' : 'Negozio', total: 3, files: ['README.md', 'src/app.js', 'src/db.js'] }),
      copyProjectFiles: async (id, projectId, paths) => { opened.push(['copy', id, projectId, paths]); return { folder: 'progetti/Negozio', left: 0, files: paths.map(file => (file === 'manca.js' ? { path: file, error: 'non esiste' } : { path: file, to: `progetti/Negozio/${file}`, size: 1 })) }; },
      clearProjectCopies: async (id) => { opened.push(['clear', id]); return { cleared: true }; }
    },
    chatManager: {
      _approvals: approvals,
      backgroundRuns: new Map(),
      generation: null,
      makeMessage: (role, content, meta = {}) => ({ id: crypto.randomUUID(), role, content, ...meta }),
      persist: async (message, id) => { kept.push([id, message.role, message.content]); },
      decideApproval: async (id, decision) => { decided.push([id, decision]); approvals.delete(id); },
      selectConversation: async (id) => { opened.push(['chat', id]); },
      runBackgroundTurn(id, text, options) {
        return new Promise((done, fail) => {
          this.backgroundRuns.set(id, []);
          const end = (settle) => (value) => { this.backgroundRuns.delete(id); settle(value); };
          const turn = { id, text, options, done: end(done), fail: end(fail) };
          options.signal?.addEventListener('abort', () => turn.fail(new DOMException('Turno fermato.', 'AbortError')));
          turns.push(turn);
        });
      }
    }
  };
  const document = { readyState: 'loading', addEventListener() {}, getElementById: () => null, body: node(), createElement: () => node() };
  const sandbox = { window, document, console, crypto, AbortController, DOMException, performance, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, indexedDB: undefined, TextDecoder };
  vm.createContext(sandbox);
  for (const file of ['realtime.js', 'realtime-jobs.js', 'realtime-features.js', 'realtime-liaison.js']) vm.runInContext(read(`resources/js/${file}`), sandbox);
  const rt = window.realtime._state;
  rt.ui = { stage: node(), status: node(), talk: node(), interrupt: node(), stopTask: node(), confirmYes: node(), confirmNo: node(), input: node(), form: node(), puppet: node(), user: node(), bot: node(), side: null };
  rt.player = { playing: false, stop() {} };
  rt.renderSettings = () => {};
  rt.renderSide = () => {};
  rt.handNext = () => {};
  rt.handOver = async (answer) => answer.files || [];
  rt.openSettings = (tab) => { opened.push(['settings', tab]); };
  rt.loaded = true;
  rt.active = true;
  rt.conversationId = 'rt';
  rt.features = { ...rt.features, askOutcome: false, relay };
  const line = (text) => (Array.isArray(text) ? text.map(part => part.shown || part.text).join(' ') : text);
  rt.say = async (text) => { spoken.push(line(text)); };
  rt.respond = async (input) => { told.push(input.report ? input.report.text : input.text); };
  rt.master = async (kind, request) => {
    asked.push({ kind, ...request });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'string' ? next : JSON.stringify(next ?? {});
  };
  const emit = (name, detail) => listeners.get(name)({ detail });
  const tool = (name) => window.realtime.tools.find(x => x.name === name);
  return { rt, window, turns, spoken, kept, told, settings, asked, replies, decided, opened, spent, approvals, emit, tool };
}

test('the chats and what each is doing are read without a model; the assistant\'s own are not among them', async () => {
  const held = { c2: [{ role: 'user', content: 'Porta i test a verde' }, answerWith('Fatto, 12 su 12.', [{ name: 'run_terminal', args: '{}' }, { name: 'run_terminal', args: '{}' }, { name: 'write_file', args: '{}' }])] };
  const { rt, window, tool } = section({ held });
  window.chatManager.backgroundRuns.set('c4', []);
  const list = await tool('chats_read').run({}, rt);
  assert.ok(!list.includes('Compiti'), 'the chat of its own tasks is its own');
  assert.match(list, /- «Sito del negozio» \(progetto Negozio\): sta lavorando adesso/);
  assert.match(list, /- «Ricette di casa»: ferma, ultimo messaggio /);
  const one = await tool('chat_read').run({ chat: 'chat ai 1' }, rt);
  assert.match(one, /^Chat «Chat AI 1» \(progetto SynthOrg\)\. Stato: ferma/);
  assert.match(one, /Ultima richiesta: Porta i test a verde\nStrumenti usati nell'ultima risposta: run_terminal × 2, write_file × 1\.\nUltima risposta: Fatto, 12 su 12\./);
  assert.match(await tool('chat_read').run({ chat: 'negozio' }, rt), /^Più chat corrispondono a «negozio»: «Sito del negozio» \(progetto Negozio\), «Appunti negozio»\. Chiedi all'utente quale\.$/);
  assert.match(await tool('chat_read').run({ chat: 'la tesi' }, rt), /^Nessuna chat e nessun progetto corrisponde a «la tesi»\./);
});

test('a message for a chat is told and confirmed, then written there as the user would, marked as the assistant\'s; its answer is told', async () => {
  const { rt, turns, spoken, told, opened, tool } = section();
  assert.deepEqual(plain(await tool('chat_tell').run({ chat: 'chat ai 1', message: 'Esegui i test e dimmi quali falliscono' }, rt)), {});
  assert.equal(turns.length, 0, 'nothing is written by the model\'s own words');
  await rt.confirmNext();
  assert.deepEqual(spoken, ['realtime.relayOpening «Chat AI 1». «Esegui i test e dimmi quali falliscono» realtime.confirmQuestion']);
  assert.deepEqual([rt.confirming.send.id, rt.working()], ['c2', false]);
  await rt.confirmTask(true);
  await tick(5);
  assert.equal(spoken[1], 'realtime.relayGoing');
  assert.deepEqual(opened, [['project', 'p1']], 'the container of the chat\'s project is started first');
  assert.deepEqual([turns[0].id, turns[0].text, plain(turns[0].options.userMeta), turns[0].options.fresh], ['c2', 'Esegui i test e dimmi quali falliscono', { by: 'assistant' }, undefined]);
  assert.equal(rt.working(), false, 'the assistant is not kept at its computer while another chat answers');
  turns[0].done({ content: 'Falliscono due test.' });
  await tick(5);
  assert.match(told[0], /^\[La chat «Chat AI 1» ha risposto a quello che hai scritto: «Esegui i test e dimmi quali falliscono»\]\nFalliscono due test\./);
  // refused: nothing is written
  const no = section();
  await no.tool('chat_tell').run({ chat: 'ricette', message: 'Aggiungi il risotto' }, no.rt);
  await no.rt.confirmNext();
  await no.rt.confirmTask(false);
  await tick(5);
  assert.deepEqual([no.turns.length, no.spoken[1]], [0, 'realtime.confirmDropped']);
});

test('with the permission to always write, the message is written at once and said in fixed words; a chat that is answering is not written to', async () => {
  const { rt, window, turns, spoken, tool } = section({ relay: true });
  await tool('chat_tell').run({ chat: 'ricette', message: 'Aggiungi il risotto' }, rt);
  await rt.confirmNext();
  await tick(5);
  assert.deepEqual([rt.confirming, turns.length, turns[0].id], [null, 1, 'c3']);
  assert.deepEqual(spoken, ['realtime.relayHanded «Ricette di casa». «Aggiungi il risotto» realtime.relayGoing']);
  // already answering: said, and nothing written
  window.chatManager.backgroundRuns.set('c5', []);
  assert.equal(writtenOf(await tool('chat_tell').run({ chat: 'appunti', message: 'Altro' }, rt)), 'realtime.relayBusy «Appunti negozio».');
  assert.deepEqual([turns.length, rt.toConfirm.length], [1, 0]);
  // stopping: the turn the assistant started, or nothing to stop
  assert.equal(writtenOf(await tool('chat_stop').run({ chat: 'ricette' }, rt)), 'realtime.relayStopped «Ricette di casa».');
  await tick(5);
  assert.equal(turns[0].options.signal.aborted, true);
  assert.equal(writtenOf(await tool('chat_stop').run({ chat: 'sito' }, rt)), 'realtime.relayNotRunning «Sito del negozio».');
});
const writtenOf = (result) => result.say.map(part => part.shown || part.text).join(' ');

test('before it writes in the chat of a project the assistant opens the project: the container started, or the folder opened in the Code tab', async () => {
  const { rt, window, turns, opened } = section({ relay: true });
  let open = null;
  let running = [];
  window.switchView = (view) => opened.push(['view', view]);
  window.codeWorkspace = { opened: () => open, current: () => (open ? { id: open } : null), open: async (id) => { opened.push(['code', id]); open = id; return true; } };
  // a folder of this computer: its commands run in the editor's terminal, there only with the project open
  rt.relay({ id: 'c4', title: 'Sito del negozio', text: 'Esegui i test' }, { watched: true });
  await tick(5);
  // asked first, shown after: the frame of a project with none on its way goes back to the list
  assert.deepEqual(opened, [['code', 'p2'], ['view', 'code']]);
  assert.equal(turns[0].id, 'c4');
  turns[0].done({ content: 'ok' });
  await tick(5);
  // already open and on screen: nothing moves
  rt.relay({ id: 'c4', title: 'Sito del negozio', text: 'Ancora' }, { watched: true });
  await tick(5);
  assert.equal(opened.length, 2);
  turns[1].done({ content: 'ok' });
  await tick(5);
  // a container: started, and the screen stays where it is
  rt.relay({ id: 'c2', title: 'Chat AI 1', text: 'Vai' }, { watched: true });
  await tick(5);
  assert.deepEqual(opened.slice(2), [['project', 'p1']]);
  turns[2].done({ content: 'ok' });
  await tick(5);
  // another project is open with work under way: it is not taken off the editor
  open = 'p1';
  window.chatManager.backgroundRuns.set('c1', []);
  rt.relay({ id: 'c4', title: 'Sito del negozio', text: 'Dopo' }, { watched: true });
  await tick(5);
  assert.deepEqual([opened.length, turns.length], [3, 4], 'written all the same, without the terminal');
});

test('a task about a chat is given that chat\'s messages by the app', async () => {
  const held = { c3: [{ role: 'user', content: 'Come si fa il risotto?' }, answerWith('Si tosta il riso.', [], { modelName: 'Modello' }), { role: 'user', content: 'Scrivi la ricetta', by: 'assistant' }] };
  const { rt, turns, spoken, tool } = section({ held });
  await tool('work').run({ task: 'Fammi un report di cosa è stato deciso', chat: 'ricette di casa' }, rt);
  await rt.confirmNext();
  assert.deepEqual(spoken, ['realtime.confirmOpening «Fammi un report di cosa è stato deciso» realtime.confirmQuestion']);
  await rt.confirmTask(true);
  await tick(5);
  assert.deepEqual([turns[0].id, turns[0].options.fresh], ['tasks', true], 'done at its own computer, from nothing');
  assert.equal(turns[0].text, 'Fammi un report di cosa è stato deciso\n\n[CHAT «Ricette di casa» — tutti i messaggi]\n[Utente]\nCome si fa il risotto?\n\n[Risposta di Modello]\nSi tosta il riso.\n\n[Assistente, per conto dell\'utente]\nScrivi la ricetta');
  // a chat that is not there: the model is told, and no task is made
  const none = section();
  assert.match(await none.tool('work').run({ task: 'Report', chat: 'la tesi' }, none.rt), /^Nessuna chat/);
  assert.equal(none.rt.toConfirm.length, 0);
});

const ORDERS = 'Porta i test a verde senza toccare la cartella vendor.';
async function watched(options = {}, limits = { maxSteps: 3, maxSpend: 1 }) {
  const page = section(options);
  await page.rt.loadWatch();
  page.rt.watch.last = limits;
  return page;
}

test('orders left by voice: the first time the limits are chosen in the settings; after that the chat is watched at once', async () => {
  const first = section();
  await first.rt.loadWatch();
  assert.equal(first.rt.watch.principles, 'realtime.watchPrinciplesDefault');
  const said = await first.tool('watch_set').run({ chat: 'chat ai 1', orders: ORDERS }, first.rt);
  assert.equal(writtenOf(said), 'realtime.watchSaidNeeds «Chat AI 1».');
  assert.deepEqual(first.opened, [['settings', 'watch']]);
  assert.deepEqual([first.rt.watch.chats.c2.on, first.rt.watch.chats.c2.orders, first.asked.length], [false, ORDERS, 0]);
  first.rt.watchOn('c2', true);
  assert.equal(first.rt.watch.chats.c2.on, false, 'not without its limits');
  assert.match(await first.tool('watch_set').run({ chat: 'ricette', orders: '' }, first.rt), /^ERRORE: mancano le consegne/);

  const { rt, asked, replies, turns, settings, tool } = await watched();
  replies.push({ verdict: 'continue', message: 'Esegui npm test e correggi il primo test che fallisce.', why: 'Niente è ancora stato fatto.' });
  const on = await tool('watch_set').run({ chat: 'chat ai 1', orders: ORDERS }, rt);
  assert.equal(writtenOf(on), 'realtime.watchSaidOn «Chat AI 1». realtime.watchSaidLimits {"steps":3,"spend":"1,00 $"}');
  await tick(10);
  assert.equal(asked.length, 1, 'a chat doing nothing is judged as it stands');
  assert.deepEqual([asked[0].kind, asked[0].json, asked[0].about], ['watch', true, 'c2']);
  assert.ok(asked[0].stable.endsWith('[THE USER\'S PRINCIPLES]\nrealtime.watchPrinciplesDefault') && asked[0].user.includes(`[ORDERS FOR THIS CHAT]\n${ORDERS}`));
  assert.deepEqual([turns[0].id, turns[0].text, plain(turns[0].options.userMeta)], ['c2', 'Esegui npm test e correggi il primo test che fallisce.', { by: 'assistant' }]);
  assert.equal(rt.watch.chats.c2.steps, 1);
  assert.equal(JSON.parse(settings.get('realtime_watch')).chats.c2.on, true, 'kept: it is there after a restart');
});

test('each turn of a watched chat is judged once: an instruction keeps it going, the orders done close the watch, a doubt waits for the user', async () => {
  const { rt, asked, replies, turns, spoken, told, emit, tool } = await watched();
  replies.push({ verdict: 'continue', message: 'Esegui i test.', why: 'Da fare.' });
  await tool('watch_set').run({ chat: 'chat ai 1', orders: ORDERS }, rt);
  await tick(10);
  // the chat answers what was written: judged again, on that turn alone
  replies.push({ verdict: 'continue', message: 'Correggi il test del login.', why: 'Un test fallisce.' });
  const answer = answerWith('Un test fallisce: login.', [{ name: 'run_terminal', args: '{"command":"npm test"}', result: '1 failed' }]);
  turns[0].done(answer);
  emit('synthorg-turn-ended', { conversationId: 'c2', request: 'Esegui i test.', by: 'assistant', answer, stopped: false, plan: false, background: true });
  await tick(10);
  assert.equal(asked.length, 2);
  assert.match(asked[1].user, /2 of 3|1 of 3 allowed/);
  assert.match(asked[1].user, /The last ones:\n- Esegui i test\./);
  assert.match(asked[1].user, /- run_terminal\(\{"command":"npm test"\}\) -> 1 failed/);
  assert.deepEqual([turns.length, turns[1].text, rt.watch.chats.c2.steps], [2, 'Correggi il test del login.', 2]);
  assert.deepEqual([spoken.length, told.length], [0, 0], 'while it goes on by itself the user is told nothing');
  // done
  replies.push({ verdict: 'done', message: '', why: 'I test passano tutti.' });
  const last = answerWith('12 su 12.');
  turns[1].done(last);
  emit('synthorg-turn-ended', { conversationId: 'c2', request: 'Correggi il test del login.', by: 'assistant', answer: last });
  await tick(10);
  assert.deepEqual([rt.watch.chats.c2.on, rt.watch.chats.c2.done, turns.length], [false, true, 2]);
  assert.equal(spoken.at(-1), 'realtime.watchSaidDone «Chat AI 1». I test passano tutti.');
  assert.deepEqual(plain(rt.watch.chats.c2.log.map(line => line.kind)), ['on', 'continue', 'continue', 'done']);
  // nothing more is asked about a chat that is no longer watched
  emit('synthorg-turn-ended', { conversationId: 'c2', request: 'x', by: '', answer: last });
  await tick(10);
  assert.equal(asked.length, 3);

  // a doubt, or an answer that is not a judgement: the user is told, and nothing is written
  for (const [reply, why] of [[{ verdict: 'ask', why: 'Serve la chiave del database.' }, 'Serve la chiave del database.'], ['boh', 'realtime.watchNoVerdict'], [new Error('HTTP 500'), 'HTTP 500']]) {
    const page = await watched();
    page.replies.push(reply);
    await page.tool('watch_set').run({ chat: 'ricette', orders: ORDERS }, page.rt);
    await tick(10);
    assert.deepEqual([page.turns.length, page.rt.watch.chats.c3.on, page.rt.watch.chats.c3.waiting], [0, true, why]);
    assert.equal(page.spoken.at(-1), `realtime.watchSaidAsk «Ricette di casa». ${why}${/[.!?]$/.test(why) ? '' : '.'}`);
    // waiting for the user: a turn of the assistant's own, come late, is not judged
    page.emit('synthorg-turn-ended', { conversationId: 'c3', request: 'x', by: 'assistant', answer: answerWith('y') });
    await tick(10);
    assert.equal(page.asked.length, 1);
  }
});

test('a watched chat is held to its limits: instructions in a row, and what it cost today', async () => {
  const { rt, asked, replies, turns, spoken, spent, emit, tool } = await watched({}, { maxSteps: 2, maxSpend: 0.5 });
  const go = (text) => ({ verdict: 'continue', message: text, why: '' });
  replies.push(go('Uno'), go('Due'), go('Tre'));
  await tool('watch_set').run({ chat: 'ricette', orders: ORDERS }, rt);
  await tick(10);
  const ended = async (by = 'assistant') => {
    const turn = turns.at(-1);
    turn.done(answerWith('ok'));
    emit('synthorg-turn-ended', { conversationId: 'c3', request: turn.text, by, answer: answerWith('ok') });
    await tick(10);
  };
  await ended();
  assert.deepEqual([turns.length, rt.watch.chats.c3.steps], [2, 2]);
  await ended();
  assert.deepEqual([turns.length, asked.length, rt.watch.chats.c3.halted], [2, 2, 'steps'], 'two in a row were allowed: the third is not asked for');
  assert.equal(spoken.at(-1), 'realtime.watchSaidSteps «Ricette di casa».');
  // the user writes there: they are here, and the count starts again
  emit('synthorg-turn-ended', { conversationId: 'c3', request: 'Vai avanti', by: '', answer: answerWith('ok') });
  await tick(10);
  assert.deepEqual([asked.length, turns.length, rt.watch.chats.c3.steps, rt.watch.chats.c3.halted], [3, 3, 1, null]);
  // what the chat cost today is what was allowed
  spent.c3 = 0.5;
  replies.push(go('Quattro'));
  await ended();
  assert.deepEqual([asked.length, turns.length, rt.watch.chats.c3.halted], [3, 3, 'spend']);
  assert.equal(spoken.at(-1), 'realtime.watchSaidSpend «Ricette di casa».');
  // what the chat cost cannot be read: its limit is not held to a guess, and nothing is written
  const blind = await watched();
  blind.window.chatStorage.usageOfChat = async () => { throw new Error('Endpoint non trovato.'); };
  await blind.tool('watch_set').run({ chat: 'ricette', orders: ORDERS }, blind.rt);
  await tick(10);
  assert.deepEqual([blind.asked.length, blind.turns.length, blind.rt.watch.chats.c3.waiting], [0, 0, 'realtime.watchNoSpend']);
  // taken up again from the settings, with more room
  rt.watch.chats.c3.maxSpend = 2;
  await rt.onWatchSettings({ type: 'click', target: { closest: (selector) => (selector === '.rt-watch-chat' ? { dataset: { chat: 'c3' } } : { dataset: { action: 'watch-resume' } }) } });
  await tick(10);
  assert.deepEqual([asked.length, turns.at(-1).text, rt.watch.chats.c3.halted], [4, 'Quattro', null]);
});

test('a turn stopped by hand is not followed by an instruction; the turns of a plan are judged when the plan stops', async () => {
  const { rt, window, asked, replies, turns, emit, tool } = await watched();
  replies.push({ verdict: 'continue', message: 'Uno', why: '' });
  await tool('watch_set').run({ chat: 'chat ai 2', orders: ORDERS }, rt);
  await tick(10);
  turns[0].fail(new Error('fermato'));
  emit('synthorg-turn-ended', { conversationId: 'c1', request: 'Uno', by: 'assistant', answer: answerWith('a metà'), stopped: true });
  await tick(10);
  assert.deepEqual([asked.length, rt.watch.chats.c1.waiting, turns.length], [1, 'realtime.watchStoppedByHand', 1]);
  // a plan under way: its turns are its own
  rt.watch.chats.c1.waiting = '';
  const before = asked.length;
  window.planMode.runs.set('c1', {});
  emit('synthorg-turn-ended', { conversationId: 'c1', request: 'punto 1', by: '', answer: answerWith('fatto'), plan: true });
  emit('synthorg-turn-ended', { conversationId: 'c1', request: 'x', by: '', answer: answerWith('fatto') });
  await tick(10);
  assert.equal(asked.length, before);
  // the plan blocked on a point: judged, with the plan
  window.planMode.runs.delete('c1');
  replies.push({ verdict: 'ask', why: 'Il punto 2 non passa.' });
  emit('synthorg-plan-ended', { conversationId: 'c1', plan: { status: 'blocked', reason: 'tentativi finiti', current: 1, points: [{ title: 'Uno', status: 'done' }, { title: 'Due', status: 'todo' }] } });
  await tick(10);
  assert.match(asked.at(-1).user, /\[PLAN OF THE CHAT\]\nStatus: blocked \(tentativi finiti\)/);
  assert.equal(rt.watch.chats.c1.waiting, 'Il punto 2 non passa.');
});

test('a permission asked by a watched chat is the user\'s, unless the chat\'s switch leaves it to the Master', async () => {
  const { rt, asked, replies, decided, spoken, approvals, emit, tool } = await watched();
  replies.push({ verdict: 'ask', why: 'Aspetto.' });
  await tool('watch_set').run({ chat: 'chat ai 1', orders: ORDERS }, rt);
  await tick(10);
  rt.watch.chats.c2.waiting = '';
  const wait = (id) => { approvals.set(id, { conversationId: 'c2' }); emit('synthorg-approval-waiting', { conversationId: 'c2', id, tool: 'run_terminal', approval: { kind: 'terminal', reason: 'new', summary: { detail: 'npm install' } } }); };
  wait('a1');
  await tick(10);
  assert.deepEqual([decided.length, asked.length, spoken.at(-1)], [0, 1, 'realtime.watchSaidPermit «Chat AI 1».']);
  // left to the Master
  rt.watch.chats.c2.approve = true;
  replies.push({ allow: true, why: 'Serve per i test.' }, { allow: false, why: 'Le consegne non lo chiedono.' }, 'non so');
  wait('a2');
  await tick(10);
  wait('a3');
  await tick(10);
  assert.deepEqual(decided, [['a2', 'allow'], ['a3', 'deny']]);
  assert.deepEqual([asked[1].kind, asked[1].about], ['permit', 'c2']);
  assert.match(asked[1].user, /\[ORDERS FOR THIS CHAT\]\nPorta i test a verde[\s\S]*Tool: run_terminal[\s\S]*npm install/);
  // an answer that is neither: nothing is decided, and the user is told
  const said = spoken.length;
  wait('a4');
  await tick(10);
  assert.deepEqual([decided.length, spoken.length, spoken.at(-1)], [2, said + 1, 'realtime.watchSaidPermit «Chat AI 1».']);
  // a chat that is not watched asks: nothing of this
  approvals.set('a5', { conversationId: 'c3' });
  emit('synthorg-approval-waiting', { conversationId: 'c3', id: 'a5', tool: 'x', approval: {} });
  await tick(10);
  assert.equal(asked.length, 4);
});

test('a task about a project is given pointers to its files, and a tool that copies the ones it asks for into its own workspace', async () => {
  const { rt, turns, opened, tool } = section();
  await tool('work').run({ task: 'Dimmi come è fatto il database', chat: 'sito del negozio' }, rt);
  await rt.confirmNext();
  await rt.confirmTask(true);
  await tick(5);
  assert.deepEqual(opened, [['clear', 'tasks']], 'the copies made for the task before are taken away first');
  assert.ok(turns[0].text.endsWith('[FILE DEL PROGETTO «Negozio» — 3 file, qui i loro percorsi. Con project_files ne ricevi una copia nel tuo spazio di lavoro; il progetto non viene toccato.]\nREADME.md\nsrc/app.js\nsrc/db.js'));
  const given = turns[0].options.tools;
  assert.deepEqual(plain([turns[0].id, turns[0].options.fresh, given.tools.map(spec => spec.function.name), given.handles('project_files'), given.handles('sandbox_exec')]), ['tasks', true, ['project_files'], true, false]);
  assert.equal(await given.call('project_files', { paths: ['src/db.js', 'manca.js'] }), 'Copie nel tuo spazio di lavoro (nel terminale: /workspace):\n- progetti/Negozio/src/db.js\n- manca.js: non copiato (non esiste)');
  assert.deepEqual(plain(opened.at(-1)), ['copy', 'tasks', 'p2', ['src/db.js', 'manca.js']], 'copied into the workspace of its own tasks, from that project');
  turns[0].done({ content: 'Fatto.' });
  await tick(5);
  // a task about a chat of no project, and one about nothing: no pointers, no tool; the copies are taken away all the same
  rt.startTask('Riassumi le ricette', { id: 'c3', title: 'Ricette di casa', project: '', projectId: '' });
  await tick(5);
  assert.deepEqual([turns[1].options.tools, turns[1].text.includes('FILE DEL PROGETTO'), plain(opened.at(-1))], [undefined, false, ['clear', 'tasks']]);
});
