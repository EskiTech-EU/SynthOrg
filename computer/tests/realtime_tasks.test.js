'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Store } = require('../server/database');
const { createApp } = require('../server');
const W = require('../resources/js/realtime-wellbeing.js');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* The server: a turn that starts from nothing                          */
/* ------------------------------------------------------------------ */

test('a turn that starts from nothing is given the last request alone, whatever the chat holds', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const chat = store.createConversation('Assistente · compiti');
  store.saveMemory({ content: 'L\'utente si chiama Samu', scope: 'global', pinned: true });
  for (let i = 1; i <= 40; i++) {
    store.saveMessage(chat.id, { role: 'user', content: `Compito numero ${i}` });
    store.saveMessage(chat.id, { role: 'assistant', content: `Esito del compito ${i}: ${'x'.repeat(2000)}` });
  }
  store.saveMessage(chat.id, { role: 'user', content: 'Genera un\'immagine di un faro' });
  const whole = store.context(chat.id, 'Genera un\'immagine di un faro', { includeGlobal: true, includeChat: false });
  assert.equal(whole.messages.length, 81, 'as a chat, all of it');
  const fresh = store.context(chat.id, 'Genera un\'immagine di un faro', { includeGlobal: true, includeChat: false, fresh: true });
  assert.deepEqual(plain(fresh.messages), [{ role: 'user', content: 'Genera un\'immagine di un faro' }]);
  assert.deepEqual([fresh.memoryView.active, fresh.compaction], [false, null]);
  assert.deepEqual(fresh.memories.map(m => m.content), whole.memories.map(m => m.content), 'the notes of the dossier go with it all the same');
  assert.deepEqual(fresh.globalItems.length, whole.globalItems.length);
  // the answer being written, and one left half way, are not the request
  store.saveMessage(chat.id, { role: 'assistant', content: '', status: 'streaming' });
  assert.equal(store.context(chat.id, '', { fresh: true }).messages[0].content, 'Genera un\'immagine di un faro');
  assert.equal(store.messages(chat.id).length, 82, 'what the chat holds stays there');
  assert.deepEqual(store.context(store.createConversation('Vuota').id, '', { fresh: true }).messages, []);
});

test('over the network a conversation is read without its messages, and its context from nothing', async t => {
  const { server } = createApp({ token: 'secret', dbPath: ':memory:', githubPort: 0, sandbox: { async stopAllContainers() { return { success: true, count: 0 }; }, async deleteWorkspace() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body) => (await fetch(base + url, { method, headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  const chat = await call('POST', '/conversations', { title: 'Compiti' });
  await call('POST', `/conversations/${chat.id}/messages`, { role: 'user', content: 'Primo compito' });
  await call('POST', `/conversations/${chat.id}/messages`, { role: 'assistant', content: 'Fatto.' });
  await call('POST', `/conversations/${chat.id}/messages`, { role: 'user', content: 'Secondo compito' });
  const bare = await call('GET', `/conversations/${chat.id}?messages=none`);
  assert.deepEqual([bare.conversation.id, bare.messages.length], [chat.id, 0]);
  assert.equal((await call('GET', `/conversations/${chat.id}`)).messages.length, 3);
  const context = await call('POST', `/conversations/${chat.id}/context`, { query: 'Secondo compito', fresh: true });
  assert.deepEqual(context.messages, [{ role: 'user', content: 'Secondo compito' }]);
});

/* ------------------------------------------------------------------ */
/* The chat: the Master's turn in the background                        */
/* ------------------------------------------------------------------ */

function chatPage({ onScreen = null, held = [] } = {}) {
  const calls = [];
  const saved = [];
  const window = {
    i18n: { t: (k) => k }, escapeHtml: (s) => s, addEventListener() {}, removeEventListener() {},
    openRouterCatalog: { getApiKey: () => 'key' },
    operationalRegistry: { getCurrentMasterModel: () => ({ id: 'model/master', name: 'Master' }), getSelectedMasterId: () => 'model/master' },
    chatWorkspace: { refresh: async () => {} },
    chatStorage: {
      get: async (id) => { calls.push(['get', id]); return { conversation: { id, memory_enabled: 0, global_memory_enabled: 1 }, messages: held.map(m => ({ ...m })) }; },
      getBare: async (id) => { calls.push(['getBare', id]); return { conversation: { id, memory_enabled: 0, global_memory_enabled: 1 }, messages: [] }; },
      getSandbox: async () => ({ networkEnabled: true }),
      save: async (id, message) => { saved.push({ id: message.id, role: message.role, status: message.status, content: message.content }); },
      context: async (id, query, options) => { calls.push(['context', options]); return { messages: [{ role: 'user', content: query }], memories: [], memoryView: { active: false } }; }
    }
  };
  const sandbox = { window, document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} }, localStorage: { getItem: () => null, setItem: () => null }, crypto, DOMException, AbortController, AbortSignal, console };
  vm.createContext(sandbox);
  vm.runInContext(read('resources/js/chat.js'), sandbox);
  const chat = window.chatManager;
  chat.render = () => { chat.rendered = (chat.rendered || 0) + 1; };
  chat.scrollToBottom = () => {};
  if (onScreen) { chat.conversation = { id: onScreen }; chat.messages = held.map(m => ({ ...m })); }
  return { chat, calls, saved };
}

test('the Master\'s turn for a task runs on the task alone, without reading the chat, and gives back what it made', async () => {
  const { chat, calls } = chatPage();
  let given;
  chat.callOpenRouterMaster = async (answer, modelId, apiKey, run) => {
    given = run;
    answer.content = 'Ecco il faro.';
    answer.turns = [{ toolCalls: [{ media: { type: 'image', url: '/api/conversations/tasks/sandbox/files/faro_1.png', filename: 'faro_1.png', title: 'Faro' } }] }];
  };
  const answer = await chat.runBackgroundTurn('tasks', 'Genera un\'immagine di un faro', { whole: true, fresh: true });
  assert.deepEqual(calls.map(c => c[0]), ['getBare', 'context']);
  assert.equal(calls[1][1].fresh, true);
  assert.deepEqual(plain(given.context.messages), [{ role: 'user', content: 'Genera un\'immagine di un faro' }]);
  assert.deepEqual([given.background, given.messages.length, given.signal], [true, 2, null]);
  assert.deepEqual([answer.status, answer.content], ['complete', 'Ecco il faro.']);
  assert.deepEqual(plain(chat.shownFiles(answer)).map(f => [f.kind, f.title, f.url]), [['image', 'Faro', '/api/conversations/tasks/sandbox/files/faro_1.png']]);
  // as it was: a turn of a chat reads the chat, and answers with the text
  const old = chatPage();
  old.chat.callOpenRouterMaster = async (message) => { message.content = 'Fatto.'; };
  assert.equal(await old.chat.runBackgroundTurn('tasks', 'Un compito'), 'Fatto.');
  assert.deepEqual(old.calls.map(c => c[0]), ['get', 'context']);
  assert.equal(Boolean(old.calls[1][1].fresh), false);
});

test('a turn stopped keeps what it wrote as a message like the others; one that fails says why', async () => {
  const { chat, saved } = chatPage();
  const stop = new AbortController();
  chat.callOpenRouterMaster = async (answer, modelId, apiKey, run) => {
    answer.content = 'Comincio dalla ricerca';
    stop.abort();
    if (run.signal.aborted) throw new DOMException('Turno fermato.', 'AbortError');
  };
  await assert.rejects(chat.runBackgroundTurn('tasks', 'Un compito lungo', { fresh: true, signal: stop.signal }), /fermato/);
  assert.deepEqual(plain(saved[saved.length - 1]), { id: saved[saved.length - 1].id, role: 'assistant', status: 'complete', content: 'Comincio dalla ricerca' });
  assert.equal(chat.backgroundRuns.size, 0);
  const failing = chatPage();
  failing.chat.callOpenRouterMaster = async () => { throw new Error('OpenRouter (500)'); };
  await assert.rejects(failing.chat.runBackgroundTurn('tasks', 'Un compito', { fresh: true }), /500/);
  const last = failing.saved[failing.saved.length - 1];
  assert.deepEqual([last.status, /Risposta interrotta: OpenRouter \(500\)/.test(last.content)], ['error', true]);
});

test('the chat of the tasks on screen shows the turn among the messages it has, and keeps them', async () => {
  const held = [{ id: 'm1', role: 'user', content: 'Compito di ieri' }, { id: 'm2', role: 'assistant', content: 'Esito di ieri' }];
  const { chat } = chatPage({ onScreen: 'tasks', held });
  let during;
  chat.callOpenRouterMaster = async (answer) => { during = chat.messages.map(m => m.content); answer.content = 'Esito di oggi'; };
  await chat.runBackgroundTurn('tasks', 'Compito di oggi', { fresh: true });
  assert.deepEqual(plain(during), ['Compito di ieri', 'Esito di ieri', 'Compito di oggi', '']);
  assert.deepEqual(plain(chat.messages.map(m => m.content)), ['Compito di ieri', 'Esito di ieri', 'Compito di oggi', 'Esito di oggi']);
  const live = [{ id: 'm2', role: 'assistant', content: 'in scrittura' }, { id: 'm3', role: 'user', content: 'nuovo' }];
  assert.deepEqual(plain(chat.withLive(held, live).map(m => m.content)), ['Compito di ieri', 'in scrittura', 'nuovo']);
});

/* ------------------------------------------------------------------ */
/* The section: the character at the computer, the user who waits       */
/* ------------------------------------------------------------------ */

function section({ model = null, i18n = null, ask = false } = {}) {
  const turns = [];       // the Master's turns asked for: { text, options, done(answer), fail(error) }
  const spoken = [];
  const kept = [];        // what is written in the character's conversation
  const settings = new Map();
  const streams = [];     // what each request to the character's model went with: { tools }
  const node = () => ({ hidden: false, disabled: false, className: '', dataset: {}, innerHTML: '', textContent: '', value: '', placeholder: '', title: '',
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, setAttribute() {}, addEventListener() {}, querySelector: () => node(), querySelectorAll: () => [] });
  const window = {
    RealtimeWellbeing: W,
    i18n: i18n || { t: (key, p) => key + (p && Object.keys(p).length ? ' ' + JSON.stringify(p) : ''), getLocale: () => 'it' },
    openRouterCatalog: { getApiKey: () => 'key', models: [] },
    operationalRegistry: { getCurrentRealtimeMultiModel: () => (model ? { id: 'model/listens', name: 'Listens' } : null), getToolDelegate: () => 'auto' },
    chatStorage: {
      realtime: async () => ({ conversation: { id: 'rt' }, tasksConversationId: 'tasks' }),
      context: async () => ({ messages: [], memories: [] }),
      getSetting: async (key) => ({ value: settings.get(key) ?? null }),
      setSetting: async (key, value) => { settings.set(key, value); }
    },
    chatManager: {
      makeMessage: (role, content, meta = {}) => ({ id: crypto.randomUUID(), role, content, ...meta }),
      persist: async (message, id) => { kept.push([id, message.role, message.content, message.calls || null]); },
      runBackgroundTurn: (id, text, options) => new Promise((done, fail) => {
        const turn = { id, text, options, done, fail };
        options.signal?.addEventListener('abort', () => fail(new DOMException('Turno fermato.', 'AbortError')));
        turns.push(turn);
      })
    }
  };
  const document = { readyState: 'loading', addEventListener() {}, getElementById: () => null, body: node(), createElement: () => node() };
  const sandbox = { window, document, console, crypto, AbortController, DOMException, performance, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, indexedDB: undefined, TextDecoder };
  vm.createContext(sandbox);
  vm.runInContext(read('resources/js/realtime.js'), sandbox);
  vm.runInContext(read('resources/js/realtime-features.js'), sandbox);
  const rt = window.realtime._state;
  rt.ui = { stage: node(), status: node(), talk: node(), interrupt: node(), stopTask: node(), confirmYes: node(), confirmNo: node(), input: node(), form: node(), puppet: node(), user: node(), bot: node(), side: null };
  rt.player = { playing: false, stop() {} };
  rt.systemPrompt = () => [{ text: 'rules' }];
  rt.renderSettings = () => {};
  rt.renderSide = () => {};
  rt.handNext = () => {};
  rt.handOver = async (answer) => answer.files || [];
  rt.handedText = (files) => `[file: ${files.map(f => f.title).join(', ')}]`;
  rt.loaded = true;
  // the question about an outcome is tried by the tests that are about it
  if (!ask) rt.features = { ...rt.features, askOutcome: false };
  rt.active = true;          // the section is on screen: what there is to tell is told
  rt.conversationId = 'rt';
  // what the character is told and says, without a model: written down
  const told = [];
  const own = { say: rt.say.bind(rt), respond: rt.respond.bind(rt) };
  const line = (text) => (Array.isArray(text) ? text.map(part => part.shown || part.text).join(' ') : text);
  rt.say = async (text, options = {}) => { if (rt.working() && !options.atWork) return own.say(text, options); spoken.push(line(text)); };
  rt.respond = async (input) => { if (rt.working() || rt.busy) return own.respond(input); told.push(input.report ? input.report.text : input.text); };
  // what the model answers in an exchange, when the exchange itself is tried: [{ transcript, toolCalls }]
  const answers = [];
  const request = rt.stream.bind(rt);   // the request itself, as it is made
  rt.stream = async (modelId, apiKey, messages, options = {}) => { streams.push({ tools: options.tools !== false, messages: plain(messages.slice(1)) }); return answers.shift() || { transcript: '', toolCalls: [] }; };
  rt.words = async (audio) => Buffer.from(audio, 'base64').toString('utf8');
  const heard = (words) => ({ audio: Buffer.from(words, 'utf8').toString('base64') });
  return { rt, turns, told, spoken, kept, settings, answers, streams, heard, window, request, exchange: own.respond, tell: own.say, util: window.realtime._util, tools: window.realtime.tools, tool: (name) => window.realtime.tools.find(x => x.name === name) };
}

test('the tasks are done one at a time, in the order they were handed, each from nothing', async () => {
  const { rt, turns, told } = section();
  rt.startTask('Cerca il prezzo');
  rt.startTask('Genera l\'immagine');
  await tick();
  assert.deepEqual(plain(rt.tasks.map(task => [task.text, task.status])), [['Genera l\'immagine', 'waiting'], ['Cerca il prezzo', 'running']]);
  assert.equal(turns.length, 1, 'the second waits for the first');
  assert.deepEqual([turns[0].id, turns[0].text, turns[0].options.fresh, turns[0].options.whole, turns[0].options.signal.aborted], ['tasks', 'Cerca il prezzo', true, true, false]);
  turns[0].done({ content: 'Costa 2 milioni.' });
  await tick(5);
  assert.deepEqual(plain(rt.tasks.map(task => task.status)), ['running', 'done']);
  assert.deepEqual(told, [], 'the outcome waits until no task is left to do');
  assert.equal(turns[1].text, 'Genera l\'immagine');
  turns[1].done({ content: 'Ecco.', files: [{ title: 'Scarpe' }] });
  await tick(5);
  assert.equal(rt.working(), false);
  assert.match(told[0], /Cerca il prezzo[\s\S]*Costa 2 milioni/);
  rt.tellNext();
  assert.match(told[1], /Genera l'immagine[\s\S]*Ecco\.[\s\S]*\[file: Scarpe\]/);
});

test('while the Master works nothing is taken in: not what is said, not what is written, not the diary', async () => {
  const { rt, turns, told, spoken } = section();
  rt.mic = { paused: false, close() {} };
  rt.session = true;
  rt.startTask('Un compito lungo');
  await tick();
  assert.equal(rt.working(), true);
  assert.equal(rt.mic.paused, false, 'until it has said it is going');
  rt.afterSpeaking();
  assert.equal(rt.mic.paused, true);
  rt.hear({ text: 'Intanto dimmi l\'ora' });
  rt.hear({ audio: 'UklGRg==' });
  await rt.respond({ text: 'E un\'altra cosa' });
  await rt.say('Una frase fissa');
  await rt.startDiary();
  rt.tell({ text: '[Promemoria arrivato]' });
  rt.setPhase('listening');
  assert.deepEqual([told.length, spoken.length, rt.diarySession, rt.busy, rt.phase, rt.tasks.length, rt.reports.length], [0, 0, null, false, 'idle', 1, 1]);
  assert.deepEqual([rt.ui.input.disabled, rt.ui.talk.disabled, rt.ui.stopTask.hidden], [true, true, false]);
  assert.match(rt.ui.input.placeholder, /realtime\.typeWaiting/);
  assert.match(rt.ui.status.textContent, /realtime\.statusWorkingOne/);
  turns[0].done({ content: 'Finito.' });
  await tick(5);
  assert.deepEqual([rt.working(), rt.mic.paused, rt.ui.input.disabled, rt.ui.talk.disabled, rt.ui.stopTask.hidden], [false, false, false, false, true]);
  assert.equal(told[0], '[Promemoria arrivato]', 'what waited is told, the oldest first');
  rt.tellNext();
  assert.match(told[1], /Finito\./);
});

test('the work is stopped: the user speaks again at once, and what the turn gives later is left out', async () => {
  const { rt, turns, told, spoken } = section();
  rt.startTask('Un video di un minuto');
  rt.startTask('E poi una ricerca');
  await tick();
  rt.stopTasks();
  assert.deepEqual(plain(rt.tasks.map(task => task.status)), ['stopped', 'stopped']);
  assert.deepEqual([rt.working(), rt.ui.input.disabled, turns[0].options.signal.aborted], [false, false, true]);
  assert.deepEqual(spoken, ['realtime.taskStopped']);
  await tick(5);
  assert.deepEqual([turns.length, told.length], [1, 0], 'the one that waited never starts, and nothing is told of the one stopped');
  assert.deepEqual(plain(rt.tasks.map(task => task.status)), ['stopped', 'stopped']);
  // a turn that ends all the same after the stop: a tool that could not be stopped half way
  const late = section();
  late.rt.startTask('Un\'immagine');
  await tick();
  late.rt.stopTasks();
  late.rt.startTask('Un\'altra');
  await tick(5);
  assert.deepEqual(plain(late.rt.tasks.map(task => task.status)), ['running', 'stopped']);
  assert.equal(late.turns[1].text, 'Un\'altra');
  late.rt.stopTasks();
  assert.equal(late.rt.working(), false);
});

test('a task that fails is told as failed, and the next one is done', async () => {
  const { rt, turns, told } = section();
  rt.startTask('Primo');
  rt.startTask('Secondo');
  await tick();
  turns[0].fail(new Error('Modello non raggiungibile'));
  await tick(5);
  assert.deepEqual(plain(rt.tasks.map(task => [task.status, task.result])), [['running', ''], ['error', 'Modello non raggiungibile']]);
  turns[1].done({ content: 'Fatto.' });
  await tick(5);
  assert.match(told[0], /non è riuscito[\s\S]*Primo[\s\S]*Modello non raggiungibile/);
});

/* ------------------------------------------------------------------ */
/* A task handed over: a turn of fixed words                            */
/* ------------------------------------------------------------------ */

const call = (name, args) => ({ id: 'c1', name, args: JSON.stringify(args) });

test('a task is handed by a turn of fixed words: told, asked about, and started only when it is confirmed', async () => {
  const { rt, turns, spoken, kept, answers, exchange } = section({ model: true });
  answers.push({ transcript: '', toolCalls: [call('work', { task: 'Genera un\'immagine di un faro al tramonto' })] });
  answers.push({ transcript: 'Vado a farlo fare al Master!', toolCalls: [] });
  await exchange({ text: 'Mi fai un\'immagine di un faro?' });
  await tick(5);
  assert.equal(answers.length, 1, 'the model is not asked for its own words about it');
  assert.deepEqual(spoken, ['realtime.confirmOpening «Genera un\'immagine di un faro al tramonto» realtime.confirmQuestion']);
  assert.deepEqual([rt.working(), turns.length, rt.confirming.task], [false, 0, 'Genera un\'immagine di un faro al tramonto']);
  assert.deepEqual([rt.ui.confirmYes.hidden, rt.ui.confirmNo.hidden], [false, false]);
  assert.match(rt.ui.status.textContent, /realtime\.statusConfirming/);
  assert.match(rt.ui.input.placeholder, /realtime\.typeConfirm/);
  await rt.confirmTask(true);
  await tick(5);
  assert.deepEqual([rt.working(), rt.confirming, turns[0].text, rt.ui.confirmYes.hidden], [true, null, 'Genera un\'immagine di un faro al tramonto', true]);
  assert.equal(spoken[1], 'realtime.confirmGoing');
  assert.deepEqual(plain(kept.map(([id, role, content]) => [role, content])), [
    ['user', 'Mi fai un\'immagine di un faro?'],
    ['assistant', 'realtime.confirmOpening «Genera un\'immagine di un faro al tramonto» realtime.confirmQuestion'],
    ['user', 'realtime.confirmYes'],
    ['assistant', 'realtime.confirmGoing']
  ]);
});

test('yes and no are whole words of what was said, in the language of the app; both, or neither, is no answer', () => {
  const dictionary = { window: {}, localStorage: { getItem: () => null, setItem: () => {} }, document: { querySelectorAll: () => [] }, console };
  vm.createContext(dictionary);
  vm.runInContext(read('resources/js/i18n.js'), dictionary);
  for (const [locale, yes, no, neither] of [
    ['it', ['Sì', 'sì, vai pure', 'Ok confermo.', 'va bene', "D'accordo!", 'si'], ['No', 'no grazie', 'Annulla', 'lascia stare', 'Non farlo.'], ['Che ore sono?', 'nono', 'così', 'sì anzi no', '']],
    ['en', ['Yes', 'yes please', 'Go ahead.', 'OK', 'sure'], ['No', 'no thanks', 'Cancel it', 'never mind', "Don't"], ['What time is it?', 'yesterday', 'nobody', 'yes, no, wait', '']]
  ]) {
    dictionary.window.i18n.setLocale(locale);
    const { yesOrNo } = section({ i18n: dictionary.window.i18n }).util;
    assert.deepEqual(yes.map(yesOrNo), yes.map(() => 'yes'), `${locale}: yes`);
    assert.deepEqual(no.map(yesOrNo), no.map(() => 'no'), `${locale}: no`);
    assert.deepEqual(neither.map(yesOrNo), neither.map(() => null), `${locale}: neither`);
  }
});

test('a task is said aloud as a sentence, cut where it gets long; what is shown is all of it', () => {
  const { spokenTask } = section().util;
  assert.equal(spokenTask("Genera  un'immagine\ndi un faro"), "Genera un'immagine di un faro.");
  assert.equal(spokenTask('Che tempo fa domani?'), 'Che tempo fa domani?');
  const long = spokenTask('parola '.repeat(80));
  assert.ok(long.length <= 262 && long.endsWith('…') && !long.endsWith(' …'), long);
});

test('a task waiting to be confirmed: no, a word that is neither, the voice turned off, the tab left', async () => {
  const no = section();
  no.rt.askTask('Cerca i voli per Lisbona');
  await no.rt.confirmNext();
  no.rt.hear({ text: 'realtime.confirmNoWords' });
  await tick(5);
  assert.deepEqual([no.rt.confirming, no.rt.working(), no.turns.length, no.spoken[1]], [null, false, 0, 'realtime.confirmDropped']);

  const again = section();
  again.rt.askTask('Cerca i voli per Lisbona');
  await again.rt.confirmNext();
  again.rt.hear({ text: 'Che ore sono?' });
  await tick(5);
  assert.deepEqual([again.rt.confirming.task, again.spoken[1], again.told.length], ['Cerca i voli per Lisbona', 'realtime.confirmAgain', 0]);
  again.rt.hear(again.heard('realtime.confirmYesWords'));
  await tick(5);
  assert.deepEqual([again.rt.confirming, again.rt.working(), again.turns.length], [null, true, 1]);
  assert.deepEqual(plain(again.kept.slice(-2).map(([id, role, content]) => [role, content])), [['user', 'realtime.confirmYesWords'], ['assistant', 'realtime.confirmGoing']]);

  const mute = section();
  await mute.rt.saveFeatures({ voiceYes: false });
  mute.rt.mic = { paused: false, close() {} };
  mute.rt.askTask('Cerca i voli per Lisbona');
  await mute.rt.confirmNext();
  mute.rt.listenAgain();
  assert.equal(mute.rt.mic.paused, true, 'it does not listen for the answer');
  mute.rt.hear(mute.heard('realtime.confirmYesWords'));
  await tick(5);
  assert.deepEqual([mute.rt.confirming.task, mute.turns.length], ['Cerca i voli per Lisbona', 0]);
  mute.rt.hear({ text: 'realtime.confirmYesWords' });
  await tick(5);
  assert.equal(mute.turns.length, 1, 'written, it is taken');

  const left = section();
  left.rt.analyze = () => {};
  left.rt.askTask('Cerca i voli per Lisbona');
  left.rt.askTask('E gli alberghi');
  await left.rt.confirmNext();
  await left.rt.setActive(false);
  assert.deepEqual([left.rt.confirming, left.rt.toConfirm.length, left.turns.length], [null, 0, 0]);
});

test('with the permission to always hand tasks over nothing is asked: the task starts and is told in fixed words', async () => {
  const { rt, turns, spoken, kept, settings, answers, exchange } = section({ model: true, ask: true });
  await rt.saveFeatures({ delegate: true });
  assert.equal(settings.get('realtime_features'), '{"delegate":true}', 'only what differs from how it starts out is kept');
  answers.push({ transcript: 'Subito. ', toolCalls: [call('work', { task: 'Riassumi le notizie di oggi' })] });
  await exchange({ text: 'Fammi un riassunto delle notizie' });
  await tick(5);
  assert.deepEqual([rt.confirming, rt.working(), turns[0].text, rt.ui.confirmYes.hidden], [null, true, 'Riassumi le notizie di oggi', true]);
  assert.deepEqual(spoken, ['realtime.confirmHanded «Riassumi le notizie di oggi» realtime.confirmGoing']);
  assert.deepEqual(plain(kept.slice(-1).map(([id, role, content]) => [role, content])), [['assistant', 'Subito. realtime.confirmHanded «Riassumi le notizie di oggi» realtime.confirmGoing']]);
  // turned on while a task waits to be confirmed: that task is handed
  const late = section({ ask: true });
  late.rt.askTask('Un compito');
  await late.rt.confirmNext();
  await late.rt.saveFeatures({ delegate: true });
  await tick(5);
  assert.deepEqual([late.rt.confirming, late.turns.length], [null, 1]);
  // what is kept is read back, and what is not a choice is left out
  const read = section();
  read.settings.set('realtime_features', '{"delegate":true,"voiceYes":"no","other":1,"askOutcome":false}');
  await read.rt.loadFeatures();
  assert.deepEqual(plain(read.rt.features), { delegate: true, relay: false, voiceYes: true, askOutcome: false });
});

test('two tasks in one exchange are asked about one at a time, the second when the first is done', async () => {
  const { rt, turns, spoken, told } = section();
  rt.askTask('Primo compito');
  rt.askTask('Secondo compito');
  await rt.confirmNext();
  await rt.confirmTask(true);
  await tick(5);
  assert.deepEqual([rt.working(), rt.confirming, rt.toConfirm.length, turns.length], [true, null, 1, 1]);
  turns[0].done({ content: 'Fatto il primo.' });
  await tick(5);
  assert.deepEqual([rt.working(), rt.confirming.task, told.length], [false, 'Secondo compito', 0]);
  assert.match(spoken[2], /confirmOpening «Secondo compito»/);
  await rt.confirmTask(false);
  await tick(5);
  rt.tellNext();
  assert.match(told[0], /Fatto il primo/);
});

/* ------------------------------------------------------------------ */
/* The page                                                              */
/* ------------------------------------------------------------------ */

test('the character is told that the work starts from the task alone, and the texts are in both languages', () => {
  const rt = read('resources/js/realtime.js');
  const i18n = read('resources/js/i18n.js');
  assert.match(rt, /name: 'work',\s+description: '[^']*the work starts from the task alone/);
  for (const key of ['statusWorkingOne', 'typeWaiting', 'stopTask', 'taskStopped', 'task_waiting', 'task_running', 'task_done', 'task_error', 'task_stopped',
    'confirmOpening', 'confirmQuestion', 'confirmAgain', 'confirmHanded', 'confirmGoing', 'confirmDropped', 'confirmYes', 'confirmNo', 'confirmYesWords', 'confirmNoWords',
    'statusConfirming', 'typeConfirm', 'settingsTab_features', 'featuresTitle', 'featuresHint', 'featureDelegate', 'featureDelegateHint', 'featureVoiceYes', 'featureVoiceYesHint']) {
    assert.equal(i18n.split(`'realtime.${key}':`).length - 1, 2, `${key} in both languages`);
  }
  const puppet = read('resources/js/realtime-puppet.js');
  assert.match(puppet, /working:\s+\{[^}]*typing: 1/);
  assert.match(puppet, /setFocus\(point\)/);
});

/* ------------------------------------------------------------------ */
/* What the model is left with                                          */
/* ------------------------------------------------------------------ */

test('a tool that did what was asked ends the exchange in fixed words, without another request', async () => {
  const { rt, window, spoken, kept, answers, streams, exchange } = section({ model: true });
  const saved = [];
  window.chatStorage.saveAgenda = async (data) => { saved.push(data); return { id: 'a1', kind: data.kind, title: data.title, start_at: data.startAt, end_at: data.endAt }; };
  window.chatStorage.agenda = async () => [];
  rt.renderSide = () => {};
  answers.push({ transcript: 'Certo. ', toolCalls: [call('agenda_add', { kind: 'activity', title: 'Palestra', start: '2030-05-02T18:00', end: '2030-05-02T19:30' })] });
  answers.push({ transcript: 'Fatto, ti ho segnato la palestra!', toolCalls: [] });
  await exchange({ text: 'Segnami la palestra giovedì dalle 18 alle 19 e 30' });
  await tick(5);
  assert.equal(streams.length, 1, 'one request');
  assert.equal(answers.length, 1);
  assert.deepEqual(plain(saved), [{ kind: 'activity', title: 'Palestra', startAt: '2030-05-02T18:00', endAt: '2030-05-02T19:30', notes: '', source: 'realtime' }]);
  assert.equal(spoken.length, 1);
  assert.match(spoken[0], /^realtime\.saidActivity «Palestra», .*2.*18:00, realtime\.saidUntilTime \{"time":"19:30"\}\.$/);
  assert.deepEqual(plain(kept.map(([id, role, content]) => [role, content])), [
    ['user', 'Segnami la palestra giovedì dalle 18 alle 19 e 30'],
    ['assistant', 'Certo. ' + spoken[0]]
  ]);
});

test('a tool that reads, or one that fails, gives the model what it goes on from', async () => {
  const { rt, window, spoken, answers, streams, exchange } = section({ model: true });
  window.chatStorage.diary = async () => [];
  window.chatStorage.saveAgenda = async (data) => ({ id: 'a1', kind: 'reminder', title: data.title, start_at: data.startAt, end_at: null });
  window.chatStorage.agenda = async () => [];
  answers.push({ transcript: '', toolCalls: [call('diary_read', { from: '2030-05-01', to: '2030-05-02' }), call('agenda_add', { kind: 'reminder', title: 'Dentista', start: '2030-05-03T09:00' })] });
  answers.push({ transcript: 'Non hai pagine in quei giorni, e ho segnato il dentista.', toolCalls: [] });
  await exchange({ text: 'Com\'è andata ieri? E ricordami il dentista' });
  await tick(5);
  assert.equal(streams.length, 2);
  assert.deepEqual(streams[1].messages.filter(m => m.role === 'tool').map(m => m.content), ['Nessuna pagina di diario in questi giorni.', streams[1].messages.filter(m => m.role === 'tool')[1].content]);
  assert.match(streams[1].messages.filter(m => m.role === 'tool')[1].content, /^realtime\.saidReminder «Dentista»/, 'what was done is told to the model, which says it');
  assert.deepEqual(spoken, [], 'nothing is said twice');
  // a step that is not there: the model is told which there are
  const failing = section({ model: true });
  failing.rt.goals = [{ id: 'g1', name: 'Trasloco', steps: [{ id: 's1', title: 'Scatole' }] }];
  failing.rt.loadGoals = async () => {};
  failing.answers.push({ transcript: '', toolCalls: [call('goal_step', { goal: 'g1', action: 'done', title: 'Camion' })] });
  failing.answers.push({ transcript: 'Non trovo quella tappa.', toolCalls: [] });
  await failing.exchange({ text: 'Ho prenotato il camion' });
  assert.equal(failing.streams.length, 2);
  assert.match(failing.streams[1].messages.pop().content, /tappa non trovata.*Scatole/);
});

test('the diary is started by the app: the model is not asked for words of its own', async () => {
  const { rt, kept, answers, streams, exchange } = section({ model: true });
  const started = [];
  rt.startDiary = async (day, options) => { started.push([day, options]); };
  answers.push({ transcript: '', toolCalls: [call('diary_start', {})] });
  await exchange({ text: 'Voglio scrivere il diario' });
  await tick(5);
  assert.equal(streams.length, 1);
  assert.deepEqual(plain(started), [[rt.diaryDay || started[0][0], { interrupt: false }]]);
  assert.deepEqual(plain(kept.map(([id, role, content]) => [role, content])), [['user', 'Voglio scrivere il diario'], ['assistant', 'realtime.diarySayOpening {"day":"' + rt.dayLabel(started[0][0]) + '"}']]);
});

test('an outcome is told without tools, and says nothing of who did the work', async () => {
  const { rt, turns, answers, streams, exchange } = section({ model: true });
  const told = [];
  rt.respond = async (input) => { told.push(input.report.text); return exchange(input); };
  answers.push({ transcript: 'Costa due milioni.', toolCalls: [] });
  rt.startTask('Cerca il prezzo del faro');
  await tick();
  turns[0].done({ content: 'Il faro costa 2 milioni.' });
  await tick(10);
  assert.equal(told[0], '[Hai finito il compito: «Cerca il prezzo del faro»]\nIl faro costa 2 milioni.\n\nRacconta l\'esito all\'utente, in breve.');
  assert.deepEqual(streams.map(s => s.tools), [false]);
  // with files: what was made, and no more
  answers.push({ transcript: 'Ecco il faro.', toolCalls: [] });
  rt.startTask('Disegna il faro');
  await tick();
  turns[1].done({ content: 'Fatto.', files: [{ title: 'Faro' }] });
  await tick(10);
  assert.equal(told[1], '[Hai finito il compito: «Disegna il faro»]\nFatto.\n\n[file: Faro]\n\nRacconta l\'esito all\'utente, in breve.');
});

test('a task goes to the work with the files it may be about, named by the app', async () => {
  const { rt, turns } = section();
  rt.filesAbout = async (task) => (task.includes('gatto') ? '\n\n[File fatti prima, nel workspace:\n- gatto_7.png — immagine «Gatto»]' : '');
  rt.startTask('Rendi il gatto più arancione');
  await tick();
  assert.equal(turns[0].text, 'Rendi il gatto più arancione\n\n[File fatti prima, nel workspace:\n- gatto_7.png — immagine «Gatto»]');
  assert.equal(rt.tasks[0].text, 'Rendi il gatto più arancione', 'what the user is shown is the task');
  turns[0].done({ content: 'Fatto.' });
  await tick(5);
  rt.startTask('Cerca il prezzo');
  await tick();
  assert.equal(turns[1].text, 'Cerca il prezzo');
});

test('a reminder is said in fixed words and kept in the conversation', async () => {
  const { rt, spoken, kept, streams } = section({ model: true });
  rt.toast = () => {};
  rt.announce({ id: 'a1', title: 'Chiama Marco', start_at: '2030-05-02T10:00', notes: 'per il preventivo' });
  await tick(5);
  assert.deepEqual(spoken, ['realtime.saidReminderDue «Chiama Marco», per il preventivo.']);
  assert.deepEqual(plain(kept.map(([id, role, content]) => [role, content])), [['assistant', 'realtime.saidReminderDue «Chiama Marco», per il preventivo.']]);
  assert.equal(streams.length, 0, 'no model');
});

test('the model is given what it takes and no more: the tools, the instructions, what the character says', () => {
  const { rt, tools } = section({ model: true });
  const names = tools.map(tool => tool.name);
  for (const gone of ['remember', 'dossier_propose', 'agenda_list', 'ask_master']) assert.equal(names.includes(gone), false, gone);
  for (const kept of ['work', 'agenda_add', 'agenda_update', 'agenda_delete', 'goal_add', 'goal_step', 'goals_read', 'diary_start', 'diary_read', 'wellbeing_read']) assert.ok(names.includes(kept), kept);
  const source = read('resources/js/realtime.js');
  const rules = source.slice(source.indexOf('      const rules = ['), source.indexOf('      const known = ['));
  assert.ok(rules.length < 1400, 'the instructions are short: ' + rules.length);
  assert.doesNotMatch(rules, /Master|remember|files_show|agenda_|goal_|diary_|wellbeing_|usage_/, 'what a tool is for is said by the tool');
  const said = [rules, ...tools.map(tool => tool.description), read('resources/js/realtime-desk.js').match(/name: 'files_show',\s+description: '([^']*)'/)[1], read('resources/js/realtime-usage.js').match(/name: 'usage_read',\s+description: '([^']*)'/)[1]];
  said.forEach(text => assert.doesNotMatch(text, /Master/));
  assert.ok(tools.every(tool => tool.description.length <= 320), 'a tool says what it is for in a line or two');
  // what the character says of its work, in both languages
  const i18n = read('resources/js/i18n.js');
  for (const key of ['statusWorking', 'statusWorkingOne', 'confirmOpening', 'confirmHanded', 'confirmGoing', 'diarySayWriting', 'deskTitle', 'saidFile', 'saidFiles', 'saidNoFile', 'saidNoFiles',
    'saidReminder', 'saidActivity', 'saidAgendaChanged', 'saidAgendaDone', 'saidAgendaDeleted', 'saidUntilTime', 'saidUntilDay', 'saidGoal', 'saidDue', 'saidStepAdded', 'saidStepDone', 'saidStepReopened', 'saidReminderDue']) {
    const found = [...i18n.matchAll(new RegExp(`'realtime\\.${key}': '((?:\\\\.|[^'])*)'`, 'g'))].map(m => m[1]);
    assert.equal(found.length, 2, `${key} in both languages`);
    found.forEach(text => assert.doesNotMatch(text, /Master/, key));
  }
  assert.match(i18n, /'tour\.rtTab\.text': '[^']*mi metto al computer/);
  assert.equal(rt.features.delegate, false);
});

test('the words of a say call are taken out of it as its arguments come', () => {
  const { wordsSoFar } = section().util;
  assert.equal(wordsSoFar(''), '');
  assert.equal(wordsSoFar('{"te'), '');
  assert.equal(wordsSoFar('{"text":"Ciao, co'), 'Ciao, co');
  assert.equal(wordsSoFar('{"text": "Perch\\u00e'), 'Perch', 'an escape cut half way waits for its rest');
  assert.equal(wordsSoFar('{"text": "Perch\\u00e9 no?"}'), 'Perché no?');
  assert.equal(wordsSoFar('{"text":"Ha detto \\"ciao\\"\\n e poi\\'), 'Ha detto "ciao"\n e poi');
  assert.equal(wordsSoFar('{"other":"x"}'), '');
});

test('the model is made to answer through a function: its words come out of say, a tool is a call to run', async () => {
  const { rt, window, request } = section({ model: true });
  const sent = [];
  const fed = [];
  let chunks = [];
  const line = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
  window.modelGateway = {
    fetchChat: async (asked) => {
      sent.push(JSON.parse(asked.body));
      const left = chunks.map(chunk => Buffer.from(chunk, 'utf8'));
      return { ok: true, body: { getReader: () => ({ read: async () => (left.length ? { value: new Uint8Array(left.shift()), done: false } : { done: true }) }) } };
    }
  };
  rt.wire = (payload) => payload;
  rt.speechFeed = (piece) => fed.push(piece);
  rt.abort = new AbortController();
  // words, in two pieces of one call
  chunks = [line({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'say', arguments: '{"text":"Ciao, ' } }] }), line({ tool_calls: [{ index: 0, function: { arguments: 'come stai?"}' } }] }), 'data: [DONE]\n\n'];
  let out = await request('model/listens', 'key', [{ role: 'user', content: 'Ciao' }]);
  assert.deepEqual(plain(out), { transcript: 'Ciao, come stai?', toolCalls: [] });
  assert.deepEqual(fed, ['Ciao, ', 'come stai?'], 'said as they come');
  assert.equal(sent[0].tool_choice, 'required');
  assert.equal(sent[0].tools[0].function.name, 'say');
  assert.ok(sent[0].tools.some(tool => tool.function.name === 'agenda_add'));
  // a tool, with a word before it
  fed.length = 0;
  chunks = [line({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'say', arguments: '{"text":"Certo."}' } }, { index: 1, id: 'c2', function: { name: 'agenda_add', arguments: '{"kind":"reminder","title":"Dentista","start":"2030-05-03T09:00"}' } }] })];
  out = await request('model/listens', 'key', [{ role: 'user', content: 'Ricordami il dentista' }]);
  assert.deepEqual(plain(out), { transcript: 'Certo.', toolCalls: [{ id: 'c2', name: 'agenda_add', args: '{"kind":"reminder","title":"Dentista","start":"2030-05-03T09:00"}' }] });
  // an outcome to tell: only words may be answered
  chunks = [line({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'say', arguments: '{"text":"Fatto."}' } }] })];
  await request('model/listens', 'key', [{ role: 'user', content: '[Hai finito il compito]' }], { tools: false });
  assert.deepEqual(plain(sent[2].tool_choice), { type: 'function', function: { name: 'say' } });
  // a model that cannot be made to choose is left free to, and answers in words of its own
  window.openRouterCatalog.models = [{ id: 'model/free', supportedParameters: ['tools', 'temperature'] }];
  fed.length = 0;
  chunks = [line({ content: 'Ciao ' }), line({ content: 'a te.' })];
  out = await request('model/free', 'key', [{ role: 'user', content: 'Ciao' }]);
  assert.deepEqual([sent[3].tool_choice, sent[3].tools.some(tool => tool.function.name === 'say'), out.transcript], ['auto', false, 'Ciao a te.']);
  await request('model/free', 'key', [{ role: 'user', content: 'x' }], { tools: false });
  assert.equal(sent[4].tool_choice, 'none');
  window.openRouterCatalog.models = [{ id: 'model/talks', supportedParameters: ['temperature'] }];
  await request('model/talks', 'key', [{ role: 'user', content: 'x' }]);
  assert.deepEqual([sent[5].tools, sent[5].tool_choice], [undefined, undefined]);
});

test('the tools an answer called are kept with it, and the conversation is given to the model with them', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const chat = store.createConversation('Assistente');
  store.saveMessage(chat.id, { role: 'user', content: 'Ricordami il dentista venerdì alle 9' });
  store.saveMessage(chat.id, { role: 'assistant', content: 'Promemoria segnato. «Dentista», venerdì 3 maggio, 09:00.',
    calls: [{ name: 'agenda_add', args: '{"kind":"reminder","title":"Dentista","start":"2030-05-03T09:00"}', result: 'Promemoria segnato. «Dentista», venerdì 3 maggio, 09:00.' }] });
  store.saveMessage(chat.id, { role: 'user', content: 'Grazie' });
  store.saveMessage(chat.id, { role: 'assistant', content: 'Di niente!' });
  const given = plain(store.context(chat.id, '', {}).messages);
  assert.deepEqual(given.map(m => [m.role, Boolean(m.calls)]), [['user', false], ['assistant', true], ['user', false], ['assistant', false]]);
  assert.deepEqual(given[1].calls[0].name, 'agenda_add');
  // as the model is sent it
  const { rt, kept, answers, streams, window, exchange } = section({ model: true });
  window.chatStorage.context = async () => ({ messages: given, memories: [] });
  answers.push({ transcript: 'Volentieri.', toolCalls: [] });
  await exchange({ text: 'Poi ne parliamo' });
  assert.deepEqual(streams[0].messages.map(m => [m.role, m.content, (m.tool_calls || []).map(c => c.function.name).join(), m.tool_call_id || '']), [
    ['user', 'Ricordami il dentista venerdì alle 9', '', ''],
    ['assistant', null, 'agenda_add', ''],
    ['tool', 'Promemoria segnato. «Dentista», venerdì 3 maggio, 09:00.', '', streams[0].messages[1].tool_calls[0].id],
    ['assistant', 'Promemoria segnato. «Dentista», venerdì 3 maggio, 09:00.', '', ''],
    ['user', 'Grazie', '', ''],
    ['assistant', 'Di niente!', '', ''],
    ['user', 'Poi ne parliamo', '', '']
  ]);
  // a tool that is no longer there is left out: its words stay
  assert.deepEqual(plain(rt.sent({ role: 'assistant', content: 'Me lo segno.', calls: [{ name: 'remember', args: '{}', result: 'x' }] }, 0)), [{ role: 'assistant', content: 'Me lo segno.' }]);
  // and what an exchange called is kept with its answer
  window.chatStorage.saveAgenda = async (data) => ({ id: 'a1', kind: 'reminder', title: data.title, start_at: data.startAt, end_at: null });
  window.chatStorage.agenda = async () => [];
  answers.push({ transcript: '', toolCalls: [call('agenda_add', { kind: 'reminder', title: 'Dentista', start: '2030-05-03T09:00' })] });
  await exchange({ text: 'Ricordami il dentista' });
  await tick(5);
  const last = kept[kept.length - 1];
  assert.deepEqual([last[1], /^realtime\.saidReminder «Dentista»/.test(last[2])], ['assistant', true]);
});

/* ------------------------------------------------------------------ */
/* A task's outcome: asked about when it is only words                  */
/* ------------------------------------------------------------------ */

test('a task that made no file: the user is asked whether they want to hear the outcome, and it is told on a yes', async () => {
  const { rt, turns, told, spoken, kept, heard } = section({ ask: true });
  rt.startTask('Cerca il prezzo del faro');
  await tick();
  turns[0].done({ content: 'Il faro costa 2 milioni.' });
  await tick(10);
  assert.deepEqual(told, [], 'nothing is told before the answer');
  assert.deepEqual(spoken, ['realtime.outcomeDone «Cerca il prezzo del faro» realtime.outcomeQuestion']);
  assert.deepEqual([rt.confirming.task, Boolean(rt.confirming.outcome), rt.ui.confirmYes.hidden], ['Cerca il prezzo del faro', true, false]);
  assert.match(rt.ui.confirmYes.innerHTML, /realtime\.outcomeYes/);
  assert.match(rt.ui.status.textContent, /realtime\.statusAsking/);
  assert.match(rt.ui.input.placeholder, /realtime\.typeOutcome/);
  // neither yes nor no: asked again
  rt.hear({ text: 'Che ore sono?' });
  await tick(5);
  assert.equal(spoken[1], 'realtime.outcomeAgain');
  assert.ok(rt.confirming);
  // yes, by voice
  rt.hear(heard('realtime.confirmYesWords'));
  await tick(10);
  assert.equal(rt.confirming, null);
  assert.equal(told.length, 1);
  assert.match(told[0], /^\[Hai finito il compito: «Cerca il prezzo del faro»\]\nIl faro costa 2 milioni\./);
  assert.deepEqual(plain(kept.map(([id, role, content]) => [role, content])), [
    ['assistant', 'realtime.outcomeDone «Cerca il prezzo del faro» realtime.outcomeQuestion'],
    ['user', 'Che ore sono?'],
    ['assistant', 'realtime.outcomeAgain'],
    ['user', 'realtime.confirmYesWords']
  ]);
});

test('on a no the outcome is left in the chat of the tasks; a task that made a file, or failed, is told without a question', async () => {
  const { rt, turns, told, spoken, kept } = section({ ask: true });
  rt.startTask('Cerca il prezzo del faro');
  await tick();
  turns[0].done({ content: 'Il faro costa 2 milioni.' });
  await tick(10);
  await rt.confirmTask(false);
  await tick(5);
  assert.deepEqual([rt.confirming, told.length, spoken[1]], [null, 0, 'realtime.outcomeLeft']);
  assert.deepEqual(plain(kept.slice(-2).map(([id, role, content]) => [role, content])), [['user', 'realtime.outcomeNo'], ['assistant', 'realtime.outcomeLeft']]);
  // a file made: handed, and told
  rt.startTask('Disegna il faro');
  await tick();
  turns[1].done({ content: 'Fatto.', files: [{ title: 'Faro' }] });
  await tick(10);
  assert.equal(rt.confirming, null);
  assert.match(told[0], /Disegna il faro[\s\S]*\[file: Faro\]/);
  // a task that failed
  rt.startTask('Cerca i voli');
  await tick();
  turns[2].fail(new Error('Modello non raggiungibile'));
  await tick(10);
  assert.equal(rt.confirming, null);
  assert.match(told[1], /non è riuscito[\s\S]*Modello non raggiungibile/);
});

test('the question about an outcome: turned off it is told at once; the tab left, it is asked again at the return', async () => {
  const off = section({ ask: true });
  await off.rt.saveFeatures({ askOutcome: false });
  assert.equal(off.settings.get('realtime_features'), '{"askOutcome":false}');
  off.rt.startTask('Cerca il prezzo');
  await tick();
  off.turns[0].done({ content: 'Costa poco.' });
  await tick(10);
  assert.deepEqual([off.rt.confirming, off.spoken.length], [null, 0]);
  assert.match(off.told[0], /Costa poco/);
  // turned off while the question waits: told
  const late = section({ ask: true });
  late.rt.startTask('Cerca il prezzo');
  await tick();
  late.turns[0].done({ content: 'Costa poco.' });
  await tick(10);
  assert.ok(late.rt.confirming.outcome);
  await late.rt.saveFeatures({ delegate: true });
  assert.ok(late.rt.confirming, 'the permission to start tasks is not an answer to it');
  await late.rt.saveFeatures({ askOutcome: false });
  await tick(10);
  assert.deepEqual([late.rt.confirming, late.told.length], [null, 1]);
  // the tab left with the question unanswered
  const left = section({ ask: true });
  left.rt.analyze = () => {};
  left.rt.startTask('Cerca il prezzo');
  await tick();
  left.turns[0].done({ content: 'Costa poco.' });
  await tick(10);
  await left.rt.setActive(false);
  assert.deepEqual([left.rt.confirming, left.rt.reports.length, left.told.length], [null, 1, 0]);
  left.rt.active = true;
  left.rt.tellNext();
  await tick(10);
  assert.equal(left.spoken.filter(line => /outcomeQuestion/.test(line)).length, 2, 'asked again');
  // and the texts are there in both languages
  const i18n = read('resources/js/i18n.js');
  for (const key of ['outcomeDone', 'outcomeQuestion', 'outcomeAgain', 'outcomeLeft', 'outcomeYes', 'outcomeNo', 'statusAsking', 'typeOutcome', 'featureAskOutcome', 'featureAskOutcomeHint']) {
    assert.equal(i18n.split(`'realtime.${key}':`).length - 1, 2, `${key} in both languages`);
  }
});
