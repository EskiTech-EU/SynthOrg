'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Store } = require('../server/database');
const W = require('../resources/js/realtime-wellbeing.js');

const source = fs.readFileSync(path.join(__dirname, '../resources/js/realtime-usage.js'), 'utf8');
const pad = (n) => String(n).padStart(2, '0');
const dayStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** The page of the spending made for the test, over a real record of requests. */
function page(t, { locale = 'it', share = {} } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const usage = store.usage();
  const marked = [];
  const asked = [];
  const tools = [];
  const rt = {
    view: {}, usage: 'what the jobs cost: another thing, under this name already', loadUsage() {},
    renderSide() { rt.drawn = (rt.drawn || 0) + 1; }, dayLabel: (day) => day.slice(5), quiet: () => true, notice: null, pause: null
  };
  const chat = { conversation: { id: 'chat-1' }, messages: [], persist: async () => 'saved' };
  const window = {
    realtime: { _state: rt, _util: { t: (key, p) => key + (p ? ' ' + JSON.stringify(p) : ''), esc: (x) => String(x).replace(/</g, '&lt;'), dayStamp }, tools },
    RealtimeWellbeing: W,
    i18n: { getLocale: () => locale },
    chatManager: chat,
    chatStorage: {
      usage: async (from, to) => usage.overview({ from, to }),
      shareState: async () => ({ ...usage.shareState(), ...share }),
      sharePackage: async (until) => usage.sharePackage({ until }),
      shareLater: async () => usage.shareLater(),
      usageCorrected: async (id) => { marked.push(id); return usage.markCorrected(id); },
      getSetting: async () => ({ value: null }), setSetting: async () => {}
    }
  };
  const sandbox = { window, document: { readyState: 'loading', addEventListener() {} }, console, Intl, Date, JSON, Math, Number, String, Object, Map, Set, Promise, setTimeout: () => 0, setInterval: () => 1 };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  rt.openShare = async () => { asked.push('asked'); };
  return { rt, store, usage, chat, marked, asked, tools, window };
}

test('the page says what was spent, by project and by model, and keeps the rates for when there are enough requests', async t => {
  const p = page(t);
  const project = p.store.createProject({ name: 'Sito <b>Rossi</b>', kind: 'local', path: 'C:/x' });
  const code = p.store.createConversation('Chat');
  p.store.db.prepare('UPDATE conversations SET project_id=? WHERE id=?').run(project.id, code.id);
  for (let i = 0; i < 22; i++) p.usage.record({ conversationId: code.id, role: 'master', turn: `t${i}`, model: 'google/gemini-3.8-flash', cost: 0.05, ms: 4000, firstMs: 800, promptTokens: 2000, completionTokens: 320, cachedTokens: 1000, stopped: i === 0 });
  p.usage.markCorrected(code.id);
  p.usage.record({ conversationId: code.id, role: 'tool:thinking_solver', turn: 't1', model: 'openai/o5', cost: 0.4, ms: 9000 });
  p.usage.record({ role: 'speech', place: 'realtime', model: 'google/tts', generation: 'gen-tts-000001', ms: 1900 });
  assert.equal(p.rt.usage, 'what the jobs cost: another thing, under this name already', 'the name the jobs use is left alone');
  await p.rt.loadCosts();
  const home = p.rt.usageHome();
  assert.match(home.big, /1,50\s?\$/);
  assert.match(home.small, /realtime\.usageHomeRuns \{"count":"24"\}/);
  const html = p.rt.renderUsageTab();
  assert.match(html, /Sito &lt;b>Rossi&lt;\/b>/, 'a name is written as text');
  assert.match(html, /realtime\.usageUnpriced1 \{"count":1\}/);
  assert.match(html, /google\/gemini-3\.8-flash<\/strong>/);
  assert.match(html, /realtime\.usagePerTurn \{"cost":"0,05\s?\$"\}/);
  assert.match(html, /google\/tts<\/strong>\s*<span class="rt-hint">realtime\.usageCostWaiting · /, 'a cost not given yet is not shown as a zero');
  assert.match(html, /realtime\.usageFirst \{"time":"0,8 s"\}/);
  assert.match(html, /realtime\.usageSpeed \{"speed":"100"\}/);
  assert.match(html, /realtime\.usageCached \{"share":"50%"\}/);
  assert.match(html, /realtime\.usageStopped \{"share":"5%"\} · realtime\.usageCorrected \{"share":"5%"\} · realtime\.usageReverted \{"share":"0%"\}/);
  assert.equal((html.match(/realtime\.usageFew/g) || []).length, 2, 'two models with too few requests for rates');
  // Sharing is off in the build (share-endpoint.js): the page says nothing about it, not even that it is off.
  assert.doesNotMatch(html, /realtime\.share/, 'sharing off: not a word about it');
  assert.equal(await p.rt.shareLook(), false, 'and nothing is ever asked');
  const on = page(t, { share: { on: true } });
  await on.rt.loadCosts();
  const onHtml = on.rt.renderUsageTab();
  assert.match(onHtml, /realtime\.shareTitle/);
  assert.match(onHtml, /realtime\.shareNotReady/);
  assert.doesNotMatch(onHtml, /data-action="share-see"/, 'nowhere to send: nothing to see, nothing to ask');
});

test('in words, for the character: numbers only, and a warning when the requests are few', async t => {
  const p = page(t);
  const chat = p.store.createConversation('Chat');
  p.usage.record({ conversationId: chat.id, role: 'master', turn: 'a', model: 'google/gemini-3.8-flash', cost: 0.2, ms: 3000, firstMs: 700, completionTokens: 230 });
  const tool = p.tools.find(x => x.name === 'usage_read');
  assert.ok(tool, 'the character has its tool');
  const today = dayStamp(new Date());
  const text = await tool.run({ from: today, to: 'domani' }, p.rt);
  assert.match(text, new RegExp(`^Spending recorded from ${today} to ${today}: \\$0\\.2 in 1 requests`));
  assert.match(text, /- master, google\/gemini-3\.8-flash: 1 requests; \$0\.2; \$0\.2 a turn; first word after 700 ms; whole answer 3000 ms; 100 tokens a second; too few requests for rates/);
  assert.match(text, /not what the work was worth/);
});

test('a message that corrects the answer before it marks that turn; any other message does not', async t => {
  const p = page(t);
  const chat = p.store.createConversation('Chat');
  p.chat.conversation = { id: chat.id };
  p.usage.record({ conversationId: chat.id, role: 'master', turn: 'a', model: 'a/b', cost: 0.1 });
  p.rt.startUsage();
  const say = async (content, extra = {}) => {
    const message = { id: `m${p.chat.messages.length}`, role: 'user', kind: 'final', content, ...extra };
    const result = await p.chat.persist(message, chat.id);
    p.chat.messages.push(message, { id: `a${p.chat.messages.length}`, role: 'assistant', kind: 'final', content: 'Fatto.' });
    await wait(5);
    return result;
  };
  assert.equal(await say('Sistema il parser delle date nel file utils.'), 'saved', 'the message is saved as before');
  await say('Ora aggiungi anche il test per quella funzione.');
  assert.equal(p.marked.length, 0);
  await say('No, non funziona ancora.');
  assert.deepEqual(p.marked, [chat.id]);
  await say('Ora aggiungi anche il test per quella funzione, ti prego.');
  assert.equal(p.marked.length, 1, 'said again, but not of the message just before');
  await say('Ora aggiungi anche il test per quella funzione, ti prego, dai.');
  assert.equal(p.marked.length, 2, 'the same request said again');
  await say('[Esito del compito]', { report: true });
  await p.chat.persist({ id: 'x', role: 'assistant', content: 'No, non funziona.' }, chat.id);
  await p.chat.persist({ id: 'y', role: 'user', kind: 'final', content: 'No, sbagliato.' }, 'another-chat');
  assert.equal(p.marked.length, 2);
  assert.equal(p.store.db.prepare('SELECT corrected FROM model_usage').get().corrected, 1);
});

test('the words of a correction', () => {
  assert.equal(W.correction('No, non è quello che ho chiesto.', 'Scrivi una funzione.'), true);
  assert.equal(W.correction('Ancora sbagliato', ''), true);
  assert.equal(W.correction('That\'s not what I asked', 'Write it'), true);
  assert.equal(W.correction('Still wrong.', ''), true);
  assert.equal(W.correction('Sistema il parser delle date, non legge i giorni.', 'Sistema il parser delle date nel file utils, non legge i giorni con una cifra.'), true);
  assert.equal(W.correction('Notevole! Ora passa al modulo successivo.', 'Scrivi una funzione.'), false, '"no" inside a word is not a no');
  assert.equal(W.correction('Perfetto, grazie.', 'Scrivi una funzione che legge il file di configurazione.'), false);
  assert.equal(W.correction('Ok vai', 'Ok vai'), false, 'too few words to say it is the same request');
  assert.equal(W.correction('', 'x'), false);
});

test('the question is put at a quiet moment, when it is due, and never over something else', async t => {
  const p = page(t, { share: { on: true, ready: true, due: true } });
  assert.equal(await p.rt.shareLook(), true);
  assert.deepEqual(p.asked, ['asked']);
  p.rt.quiet = () => false;
  assert.equal(await p.rt.shareLook(), false, 'a model is answering');
  p.rt.quiet = () => true;
  p.rt.pause = { id: 'b1' };
  assert.equal(await p.rt.shareLook(), false, 'a pause is under way');
  p.rt.pause = null;
  p.rt.shareDialog = { open: true };
  assert.equal(await p.rt.shareLook(), false, 'it is open already');
  const notDue = page(t, { share: { on: true, ready: true, due: false } });
  assert.equal(await notDue.rt.shareLook(), false);
  assert.equal(notDue.asked.length, 0);
});
