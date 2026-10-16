'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/database');
const { measure, quantile, weekOf, profileOf, publicRole, publicModel } = require('../server/usage');
// Sharing is off in the app for now (share-endpoint.js): the tests of it turn it on.
process.env.SYNTHORG_SHARE_ON = '1';

const plain = (value) => JSON.parse(JSON.stringify(value));
const pad = (n) => String(n).padStart(2, '0');
const dayStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function setup(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const project = store.createProject({ name: 'Sito del cliente Rossi', kind: 'local', path: 'C:/lavoro/rossi' });
  const chat = store.createConversation('Una chat');
  const code = store.createConversation('Chat del progetto');
  store.db.prepare('UPDATE conversations SET project_id=? WHERE id=?').run(project.id, code.id);
  return { store, usage: store.usage(), project, chat, code };
}

test('a request is written down with where it was made, worked out from its chat', t => {
  const { store, usage, project, chat, code } = setup(t);
  const first = usage.record({ conversationId: code.id, role: 'master', turn: 't1', model: 'google/gemini-3.8-flash', provider: 'Google',
    promptTokens: 1200.4, completionTokens: 300, cachedTokens: 800, reasoningTokens: 50, cost: 0.0021, ms: 4200, firstMs: 900 });
  assert.deepEqual(first, { id: 1, waiting: false });
  usage.record({ conversationId: chat.id, role: 'tool:thinking_solver', model: 'openai/o5', cost: 0.01, ms: 9000 });
  usage.record({ conversationId: store.realtime().conversation.id, role: 'realtime', model: 'google/gemini-3.5-flash-lite', cost: 0.0004, ms: 800 });
  usage.record({ conversationId: 'gone', role: 'speech', model: 'google/tts', place: 'tour', cost: 0.0003 });
  usage.record({ role: 'master', model: 'local/MiniCPM.gguf', local: true, cost: 5, promptTokens: 10, completionTokens: 20, ms: 1000 });
  const rows = store.db.prepare('SELECT * FROM model_usage ORDER BY id').all();
  assert.deepEqual(rows.map(r => [r.place, r.project_id, r.role, r.cost]), [
    ['project', project.id, 'master', 0.0021], ['chat', null, 'tool:thinking_solver', 0.01], ['realtime', null, 'realtime', 0.0004],
    ['tour', null, 'speech', 0.0003], ['other', null, 'master', 0]
  ]);
  assert.deepEqual([rows[0].prompt_tokens, rows[0].cached_tokens, rows[0].first_ms, rows[0].day], [1200, 800, 900, dayStamp(new Date())]);
  assert.equal(rows[4].cost, 0, 'a model on this computer costs nothing, whatever is said');
  assert.throws(() => usage.record({ role: 'Il mio ruolo!', model: 'x/y' }), /Ruolo non valido/);
  assert.throws(() => usage.record({ role: 'master', model: '' }), /Modello non valido/);
});

test('a cost not known when the request ends is asked for later, by its generation, for two days', t => {
  const { store, usage, chat } = setup(t);
  const speech = usage.record({ conversationId: chat.id, role: 'speech', model: 'google/tts', generation: 'gen-tts-1790590378-7vzfIJ', ms: 1900 });
  assert.deepEqual(speech, { id: 1, waiting: true });
  usage.record({ conversationId: chat.id, role: 'speech', model: 'google/tts', generation: 'gen-known', cost: 0.0002 });
  usage.record({ conversationId: chat.id, role: 'speech', model: 'google/tts', generation: 'not a generation!' });
  assert.deepEqual(usage.pending().map(r => [r.id, r.generation]), [[1, 'gen-tts-1790590378-7vzfIJ']]);
  assert.throws(() => usage.resolve(1, { cost: 'molto' }), /Costo non valido/);
  assert.deepEqual(usage.resolve(1, { cost: 0.000272, promptTokens: 2, completionTokens: 45, provider: 'Google AI Studio' }), { id: 1, resolved: true });
  const row = store.db.prepare('SELECT cost, generation, prompt_tokens, completion_tokens, provider FROM model_usage WHERE id=1').get();
  assert.deepEqual({ ...row }, { cost: 0.000272, generation: null, prompt_tokens: 2, completion_tokens: 45, provider: 'Google AI Studio' });
  assert.deepEqual(usage.resolve(1, { cost: 9 }), { id: 1, resolved: false }, 'given once');
  assert.throws(() => usage.resolve(99, { cost: 1 }), /Richiesta non trovata/);
  const old = usage.record({ conversationId: chat.id, role: 'image', model: 'x/image', generation: 'gen-old-000001' });
  store.db.prepare('UPDATE model_usage SET at=? WHERE id=?').run(new Date(Date.now() - 49 * 3600000).toISOString(), old.id);
  assert.equal(usage.pending().length, 0, 'after two days it is not asked for any more');
});

test('what each project cost is the sum of all its requests, the old ones folded by day too', t => {
  const { store, usage, project, chat, code } = setup(t);
  for (let i = 0; i < 4; i++) usage.record({ conversationId: code.id, role: 'master', turn: `t${i}`, model: 'a/b', cost: 0.5, promptTokens: 100, completionTokens: 10, ms: 1000 });
  usage.record({ conversationId: chat.id, role: 'master', turn: 'x', model: 'a/b', cost: 3 });
  const old = dayStamp(new Date(Date.now() - 120 * 86400000));
  store.db.prepare('UPDATE model_usage SET day=? WHERE id IN (1,2)').run(old);
  assert.deepEqual(plain(usage.fold()), { folded: 2 });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM model_usage').get().n, 3);
  assert.deepEqual(plain(store.db.prepare('SELECT * FROM model_usage_days').all()), [
    { day: old, project_id: project.id, place: 'project', role: 'master', model: 'a/b', runs: 2, ok: 2, prompt_tokens: 200, completion_tokens: 20, cached_tokens: 0, cost: 1 }
  ]);
  assert.deepEqual(plain(usage.projects()), { [project.id]: { cost: 2, runs: 4, tokens: 440, last_day: dayStamp(new Date()) } });
  // the project is deleted: what was spent on it was spent
  store.deleteProject(project.id);
  assert.equal(usage.projects()[project.id].cost, 2);
  const seen = usage.overview({}).byProject;
  assert.deepEqual(seen.map(p => [p.project_id, p.name, p.cost]), [[project.id, null, 1]]);
});

test('how a turn went is told by what happened next: corrected, taken back', t => {
  const { store, usage, project, chat, code } = setup(t);
  usage.record({ conversationId: chat.id, role: 'master', turn: 'a', model: 'a/b', cost: 0.1 });
  usage.record({ conversationId: chat.id, role: 'master', turn: 'b', model: 'a/b', cost: 0.1 });
  usage.record({ conversationId: chat.id, role: 'tool:web_search', turn: 'b', model: 'a/c', cost: 0.1 });
  usage.record({ conversationId: chat.id, role: 'master', turn: 'b', model: 'a/b', cost: 0.1 });
  assert.deepEqual(usage.markCorrected(chat.id), { marked: 3 });
  assert.deepEqual(store.db.prepare('SELECT turn, corrected FROM model_usage ORDER BY id').all().map(r => [r.turn, r.corrected]), [['a', 0], ['b', 1], ['b', 1], ['b', 1]]);
  assert.deepEqual(usage.markCorrected('nobody'), { marked: 0 });
  store.db.prepare('UPDATE model_usage SET at=?, corrected=0').run(new Date(Date.now() - 2 * 3600000).toISOString());
  assert.deepEqual(usage.markCorrected(chat.id), { marked: 0 }, 'a message written hours later is not a correction of that turn');

  const at = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
  const turn = (name, seconds) => { const { id } = usage.record({ conversationId: code.id, role: 'master', turn: name, model: 'a/b', cost: 0.2 }); store.db.prepare('UPDATE model_usage SET at=? WHERE id=?').run(at(seconds), id); };
  turn('first', 3000); turn('first', 2990);
  turn('second', 600); turn('second', 560); turn('second', 500);
  turn('third', 100);
  // a step of the model 570 seconds ago: made between two requests of the second turn
  assert.deepEqual(usage.markReverted(project.id, [at(570), at(570), 'not a moment']), { marked: 3 });
  const marks = store.db.prepare('SELECT turn, MAX(reverted) AS r FROM model_usage WHERE project_id=? GROUP BY turn').all(project.id);
  assert.deepEqual(Object.fromEntries(marks.map(m => [m.turn, m.r])), { first: 0, second: 1, third: 0 });
  assert.deepEqual(usage.markReverted(project.id, [at(2000)]), { marked: 0 }, 'a step with no request in the ten minutes before it');
  assert.deepEqual(usage.markReverted('another', [at(570)]), { marked: 0 });
});

test('the numbers of a group: by request and by turn, medians, and rates only with enough requests', () => {
  const row = (extra) => ({ ok: 1, stopped: 0, corrected: 0, reverted: 0, turn: null, cost: 0.01, ms: 2000, first_ms: 500, prompt_tokens: 1000, completion_tokens: 150, cached_tokens: 600, reasoning_tokens: 0, local: 0, ...extra });
  const m = measure([
    row({ turn: 'a', ms: 1000, first_ms: 400 }), row({ turn: 'a', ms: 3000, first_ms: 600, corrected: 1 }),
    row({ turn: 'b', stopped: 1 }), row({ turn: 'c', reverted: 1, corrected: 1 }),
    row({ turn: 'd', ok: 0, cost: null, completion_tokens: 0, first_ms: null, ms: 9000 })
  ]);
  assert.deepEqual([m.runs, m.ok, m.errors, m.turns, m.stopped, m.corrected, m.reverted, m.unpriced], [5, 4, 1, 4, 1, 2, 1, 1]);
  assert.deepEqual([m.cost, m.cost_per_run, m.cost_per_turn, m.cached_share], [0.04, 0.008, 0.01, 0.6]);
  assert.deepEqual([m.ms_p50, m.first_ms_p50, m.enough], [2000, 500, false]);
  assert.equal(m.tokens_per_second_p50, 100, '150 tokens in the 1.5 seconds after the first');
  assert.equal(measure(Array.from({ length: 20 }, () => row({}))).enough, true);
  const none = measure([]);
  assert.deepEqual([none.runs, none.cost, none.cost_per_run, none.ms_p50, none.cached_share], [0, 0, null, null, null]);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([10], 0.9), 10);
  assert.equal(quantile([], 0.5), null);
});

test('the overview of a period: by day, by place, by project, by model and role', t => {
  const { usage, project, chat, code } = setup(t);
  usage.record({ conversationId: code.id, role: 'master', turn: 't1', model: 'a/big', cost: 0.2, ms: 3000, firstMs: 700, completionTokens: 400 });
  usage.record({ conversationId: code.id, role: 'master', turn: 't2', model: 'a/big', cost: 0.3, ms: 5000, firstMs: 900, completionTokens: 600 });
  usage.record({ conversationId: chat.id, role: 'master', turn: 't3', model: 'b/small', cost: 0.01, ms: 1000, firstMs: 200, completionTokens: 100 });
  usage.record({ conversationId: chat.id, role: 'speech', model: 'c/voice', cost: 0.002, ms: 1900 });
  const o = usage.overview({ from: dayStamp(new Date()), to: dayStamp(new Date()) });
  assert.deepEqual([o.total.runs, o.total.cost, o.total.turns], [4, 0.512, 3]);
  assert.deepEqual(o.byDay.map(d => [d.day, d.runs, d.cost]), [[dayStamp(new Date()), 4, 0.512]]);
  assert.deepEqual(o.byPlace.map(p => [p.place, p.cost]), [['project', 0.5], ['chat', 0.012]]);
  assert.deepEqual(o.byProject.map(p => [p.name, p.cost, p.runs]), [['Sito del cliente Rossi', 0.5, 2]]);
  assert.deepEqual(o.byModel.map(m => [m.role, m.model, m.runs, m.cost_per_turn]), [['master', 'a/big', 2, 0.25], ['master', 'b/small', 1, 0.01], ['speech', 'c/voice', 1, null]]);
  assert.equal(usage.overview({ projectId: project.id }).total.cost, 0.5);
  assert.equal(usage.overview({ from: '2020-01-01', to: '2020-12-31' }).total.runs, 0);
});

test('what may be named outside this computer: the app\'s own roles, the provider\'s public names', () => {
  assert.deepEqual(['master', 'tool:thinking_solver', 'tool:my_private_tool', 'job:page', 'job:secret', 'agent:marco', 'whatever', ''].map(publicRole),
    ['master', 'tool:thinking_solver', 'tool:other', 'job:page', 'job:other', 'other', 'other', 'other']);
  assert.equal(publicModel('google/gemini-3.8-flash'), 'google/gemini-3.8-flash');
  assert.equal(publicModel('Mistralai/Voxtral-Mini-3b-2507:free'), 'mistralai/voxtral-mini-3b-2507:free');
  assert.equal(publicModel('local/Il-modello-di-Samu.gguf'), 'local');
  assert.equal(publicModel('a/b', true), 'local');
  assert.equal(publicModel('C:\\Users\\samus\\modello'), 'other');
  assert.equal(publicModel('il mio modello/segreto'), 'other');
  assert.deepEqual(['2026-09-28', '2026-01-01', '2027-01-03', '2024-12-30'].map(weekOf), ['2026-W40', '2026-W01', '2026-W53', '2025-W01']);
});

test('what a project is made of: its most common languages and a size, from the names of its files', () => {
  const files = [...Array.from({ length: 30 }, (_, i) => `src/parte${i}.rs`), ...Array.from({ length: 12 }, (_, i) => `web/pagina${i}.ts`),
    'README.md', 'Cargo.toml', 'note-per-rossi.segreto', 'LICENSE', ...Array.from({ length: 400 }, (_, i) => `node_modules/x/${i}.js`)];
  assert.deepEqual(profileOf(files), { languages: ['rust', 'typescript'], size: 'S' });
  assert.deepEqual(profileOf(Array.from({ length: 600 }, (_, i) => `a/${i}.py`)), { languages: ['python'], size: 'L' });
  assert.deepEqual(profileOf([]), { languages: [], size: 'S' });
  assert.deepEqual(profileOf(['foto.raw', 'dati.bin']), { languages: [], size: 'S' });
});

test('sharing off in the build: nothing is asked whatever the address, and the page is told so', t => {
  const { store, usage, chat } = setup(t);
  for (let i = 0; i < 4; i++) usage.record({ conversationId: chat.id, role: 'master', turn: `t${i}`, model: 'a/b', cost: 1.3 });
  store.setSetting('usage_share_endpoint', 'https://share.synthorg.example/v1');
  delete process.env.SYNTHORG_SHARE_ON;
  try {
    const state = usage.shareState();
    assert.deepEqual([state.on, state.ready, state.due, state.cost], [false, false, false, 5.2]);
  } finally { process.env.SYNTHORG_SHARE_ON = '1'; }
  assert.equal(usage.shareState().on, true);
});

test('the question comes every five dollars recorded, and only with somewhere to send to', t => {
  const { store, usage, chat } = setup(t);
  for (let i = 0; i < 4; i++) usage.record({ conversationId: chat.id, role: 'master', turn: `t${i}`, model: 'a/b', cost: 1.3 });
  let state = usage.shareState();
  assert.deepEqual([state.ready, state.due, state.runs, state.cost, state.until, state.every], [false, false, 4, 5.2, 4, 5], 'nowhere to send: nothing is asked');
  store.setSetting('usage_share_endpoint', 'ftp://somewhere');
  assert.equal(usage.shareState().ready, false);
  store.setSetting('usage_share_endpoint', 'http://evil.example/collect');
  assert.equal(usage.shareState().ready, false, 'only a safe connection, or this computer for a test');
  store.setSetting('usage_share_endpoint', 'https://share.synthorg.example/v1');
  assert.deepEqual([usage.shareState().ready, usage.shareState().due], [true, true]);
  usage.shareLater();
  assert.equal(usage.shareState().due, false, 'closed without an answer: not before tomorrow');
  store.setSetting('usage_share_later', new Date(Date.now() - 1000).toISOString());
  assert.equal(usage.shareState().due, true);
  const built = usage.sharePackage({ until: 4 });
  const answered = usage.answerShare({ answer: 'declined', ...built, package: null });
  assert.deepEqual([answered.answer, answered.until], ['declined', 4]);
  state = usage.shareState();
  assert.deepEqual([state.due, state.runs, state.cost], [false, 0, 0], 'a stretch answered is not asked about again');
  assert.deepEqual(state.history.map(h => [h.answer, h.runs, h.cost]), [['declined', 4, 5.2]]);
  assert.equal(usage.shared(answered.id).package, null, 'nothing is kept of what was not shared');
  assert.throws(() => usage.answerShare({ answer: 'shared', ...built }), /già avuto una risposta/);
  assert.throws(() => usage.sharePackage({ until: 4 }), /niente da condividere/);
  usage.record({ conversationId: chat.id, role: 'master', turn: 'n', model: 'a/b', cost: 4.9 });
  assert.equal(usage.shareState().due, false);
  usage.record({ conversationId: chat.id, role: 'master', turn: 'n', model: 'a/b', cost: 0.2 });
  assert.equal(usage.shareState().due, true);
});

test('what is shared is numbers: no name, no identifier, no moment, no text', t => {
  const { store, usage, project, chat, code } = setup(t);
  usage.record({ conversationId: code.id, role: 'master', turn: 'turn-secret-1', model: 'google/gemini-3.8-flash', provider: 'Google', cost: 2, ms: 4213, firstMs: 874, promptTokens: 5000, completionTokens: 700, cachedTokens: 3000 });
  usage.record({ conversationId: code.id, role: 'master', turn: 'turn-secret-2', model: 'google/gemini-3.8-flash', cost: 2.5, ms: 6100, firstMs: 1130, promptTokens: 7000, completionTokens: 900, stopped: true });
  usage.record({ conversationId: code.id, role: 'tool:il_mio_strumento', model: 'local/Modello-di-Samu.gguf', local: true, ms: 9000, completionTokens: 300 });
  usage.record({ conversationId: chat.id, role: 'job:page', model: 'google/gemini-3.8-flash', cost: 0.6, ms: 3000 });
  usage.markCorrected(code.id);
  const built = usage.sharePackage({ until: 99, profiles: { [project.id]: { languages: ['rust', 'typescript'], size: 'M' } }, app: '1.1.0' });
  assert.deepEqual([built.from, built.until, built.runs, built.cost], [0, 4, 4, 5.1], 'never past the last row there is');
  const shared = built.package;
  assert.deepEqual(Object.keys(shared), ['schema', 'id', 'app', 'weeks', 'groups']);
  assert.deepEqual([shared.schema, shared.app, shared.weeks.from, shared.weeks.to], [1, '1.1.0', weekOf(dayStamp(new Date())), weekOf(dayStamp(new Date()))]);
  assert.deepEqual(plain(shared.groups.map(g => [g.model, g.role, g.place, g.project, g.runs, g.turns, g.stopped, g.corrected, g.cost])), [
    ['google/gemini-3.8-flash', 'master', 'project', { languages: ['rust', 'typescript'], size: 'M' }, 2, 2, 1, 1, 4.5],
    ['google/gemini-3.8-flash', 'job:page', 'chat', null, 1, 0, 0, 0, 0.6],
    ['local', 'tool:other', 'project', { languages: ['rust', 'typescript'], size: 'M' }, 1, 0, 0, 0, 0]
  ]);
  assert.deepEqual([shared.groups[0].ms_p50, shared.groups[0].first_ms_p50], [5160, 1000], 'times are rounded');
  const text = JSON.stringify(shared);
  for (const secret of [project.id, chat.id, code.id, 'Rossi', 'rossi', 'turn-secret', 'Samu', 'il_mio_strumento', 'gguf', new Date().toISOString().slice(0, 10)]) {
    assert.equal(text.includes(secret), false, `"${secret}" must not be in what is shared`);
  }
  // a project that could not be read is said to be unknown, not left out
  const unknown = usage.sharePackage({ until: 99 }).package.groups[0].project;
  assert.deepEqual(plain(unknown), { languages: [], size: 'unknown' });
  // shared: kept as it went, to be seen
  const answered = usage.answerShare({ answer: 'shared', ...built });
  assert.equal(answered.id, shared.id);
  assert.deepEqual(plain(usage.shared(shared.id).package), plain(shared));
  assert.equal(store.getSetting('usage_share_mark'), '4');
});

test('the record emptied by the user: every row goes, what was shared stays in its list', t => {
  const { store, usage, project, chat, code } = setup(t);
  store.setSetting('usage_share_endpoint', 'https://share.synthorg.example/v1');
  usage.record({ conversationId: code.id, role: 'master', turn: 'a', model: 'a/b', cost: 6 });
  usage.answerShare({ answer: 'shared', ...usage.sharePackage({}) });
  usage.record({ conversationId: chat.id, role: 'master', turn: 'b', model: 'a/b', cost: 1 });
  store.db.prepare("UPDATE model_usage SET day='2020-01-01' WHERE id=1").run();
  usage.fold();
  assert.deepEqual(plain(usage.clear()), { cleared: 1 });
  assert.deepEqual(plain(usage.projects()), {});
  assert.equal(usage.overview({}).total.runs, 0);
  assert.deepEqual(usage.shareState().history.map(h => h.answer), ['shared']);
  const next = usage.record({ conversationId: code.id, role: 'master', turn: 'c', model: 'a/b', cost: 2 });
  assert.equal(next.id, 3, 'a row written afterwards is a new one, not one already answered about');
  assert.deepEqual([usage.shareState().runs, usage.shareState().cost, usage.projects()[project.id].cost], [1, 2, 2]);
});
