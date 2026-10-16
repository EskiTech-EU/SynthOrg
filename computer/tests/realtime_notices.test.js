'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Store } = require('../server/database');
const W = require('../resources/js/realtime-wellbeing.js');

const MINUTE = 60000;
const pad = (n) => String(n).padStart(2, '0');
const dayStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plain = (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------------ */
/* The rules, worked out without a model                                */
/* ------------------------------------------------------------------ */

test('the stretch of work: back from the last thing done, for as long as no two are far apart', () => {
  const now = Date.parse('2026-09-28T16:00:00Z');
  const at = (minutes) => now - minutes * MINUTE;
  assert.equal(W.workSpan([], now), null);
  assert.equal(W.workSpan([at(20)], now), null, 'the last thing done is too long ago: not working');
  assert.deepEqual(W.workSpan([at(130), at(120), at(110), at(100), at(90), at(80), at(70), at(60), at(50), at(40), at(30), at(20), at(10), at(2)], now),
    { from: at(130), to: at(2), minutes: 130 });
  assert.equal(W.workSpan([at(200), at(190), at(60), at(50), at(40), at(30), at(20), at(10)], now).minutes, 60, 'a gap ends the stretch');
  assert.equal(W.workSpan([at(30), at(10)], now, { gap: 15 }).minutes, 10, 'twenty minutes apart are two stretches');
  const rested = W.workSpan([at(100), at(90), at(80), at(70), at(60), at(40), at(30), at(20), at(10)], now, { gap: 25, pauses: [{ from: at(55), to: at(45) }] });
  assert.equal(rested.minutes, 40, 'a pause taken starts the count again');
  assert.equal(W.workSpan([at(10), now + 5 * MINUTE], now).minutes, 10, 'a moment still to come is not counted');
});

test('stuck on a file: the same file alone, saved three times at least, from the last step back', () => {
  const now = Date.parse('2026-09-28T16:00:00Z');
  const at = (minutes) => now - minutes * MINUTE;
  const step = (minutes, title, files = 1) => ({ at: at(minutes), title, files });
  const span = { from: at(120), to: at(1), minutes: 120 };
  assert.deepEqual(W.stuckOn([step(90, 'a.js'), step(70, 'parser.js'), step(40, 'parser.js'), step(5, 'parser.js')], span, now), { file: 'parser.js', minutes: 70, saves: 3 });
  assert.equal(W.stuckOn([step(40, 'parser.js'), step(5, 'parser.js')], span, now), null, 'saved twice: not stuck');
  assert.equal(W.stuckOn([step(70, 'parser.js'), step(40, 'parser.js'), step(5, 'a.js, parser.js', 2)], span, now), null, 'the last step changed two files');
  assert.equal(W.stuckOn([step(70, 'parser.js'), step(40, 'parser.js'), step(5, 'other.js')], span, now), null);
  assert.equal(W.stuckOn([step(300, 'parser.js'), step(200, 'parser.js'), step(5, 'parser.js')], span, now), null, 'what came before the stretch is not counted');
  assert.equal(W.stuckOn([step(5, 'parser.js')], null, now), null);
});

test('steps due: the open ones of the project, due by tomorrow, the nearest first', () => {
  const goals = [
    { name: 'Sito', status: 'open', project_id: 'p1', due_day: null, steps: [
      { title: 'Bozza', done: 1, due_day: '2026-09-27' }, { title: 'Testi', done: 0, due_day: '2026-09-29' },
      { title: 'Foto', done: 0, due_day: '2026-09-26' }, { title: 'Lancio', done: 0, due_day: '2026-10-20' }, { title: 'Senza giorno', done: 0, due_day: null }] },
    { name: 'Tesi', status: 'open', project_id: 'p2', due_day: '2026-09-28', steps: [{ title: 'Capitolo', done: 0, due_day: '2026-09-28' }] },
    { name: 'Chiuso', status: 'done', project_id: 'p1', due_day: '2026-09-28', steps: [{ title: 'x', done: 0, due_day: '2026-09-28' }] }
  ];
  assert.deepEqual(W.dueSoon(goals, 'p1', '2026-09-28').map(d => [d.title, d.when]), [['Foto', 'late'], ['Testi', 'tomorrow']]);
  assert.deepEqual(W.dueSoon(goals, 'p2', '2026-09-28').map(d => [d.title, d.when, Boolean(d.whole)]), [['Capitolo', 'today', false], ['Tesi', 'today', true]]);
  assert.deepEqual(W.dueSoon(goals, 'p3', '2026-09-28'), []);
});

test('the late hours go from the hour given to five in the morning', () => {
  const at = (h, m = 0) => new Date(2026, 8, 28, h, m);
  assert.equal(W.lateHour(at(23, 30), '23:00'), true);
  assert.equal(W.lateHour(at(2), '23:00'), true);
  assert.equal(W.lateHour(at(5), '23:00'), false);
  assert.equal(W.lateHour(at(22, 59), '23:00'), false);
  assert.equal(W.lateHour(at(0, 10), '00:00'), true);
  assert.equal(W.lateHour(at(23, 50), '00:00'), false);
  assert.equal(W.lateHour(at(1), '01:30'), false);
  assert.equal(W.lateHour(at(1), ''), false);
});

test('the hours the user chose: from an hour to another, past midnight too, with the minutes since their start', () => {
  const at = (h, m = 0) => new Date(2026, 8, 28, h, m);
  assert.deepEqual(W.inHours(at(23, 30), '23:00', '05:00'), { inside: true, since: 30 });
  assert.deepEqual(W.inHours(at(2, 15), '23:00', '05:00'), { inside: true, since: 195 });
  assert.equal(W.inHours(at(5), '23:00', '05:00').inside, false, 'the end is outside');
  assert.deepEqual(W.inHours(at(13, 20), '13:00', '14:30'), { inside: true, since: 20 }, 'a range of the day: the lunch hour');
  assert.equal(W.inHours(at(14, 30), '13:00', '14:30').inside, false);
  assert.equal(W.inHours(at(12, 59), '13:00', '14:30').inside, false);
  assert.equal(W.inHours(at(10), '10:00', '10:00').inside, false, 'the same hour twice is no range');
  assert.equal(W.inHours(at(10), '25:00', '30:00').inside, false);
  assert.equal(W.inHours(at(10), '09:00', '').inside, false);
});

test('an exchange going badly is seen from how the user writes; one hard line is not an exchange', () => {
  const now = Date.parse('2026-09-28T16:00:00Z');
  let minute = 20;
  const user = (content) => ({ role: 'user', content, at: now - (minute--) * MINUTE });
  const answer = (status = 'complete') => ({ role: 'assistant', content: 'Ecco.', status, at: now - (minute--) * MINUTE });
  const calm = W.friction([user('Aggiungi una funzione che legge il file di configurazione.'), answer(), user('Ora scrivi anche il test per quella funzione.'), answer(), user('Perfetto, passa al modulo successivo.')], now);
  assert.deepEqual([calm.points, calm.sign], [0, null]);
  assert.equal(W.friction([user('SEI INUTILE, NON FUNZIONA NIENTE!!!')], now).points, 0);
  minute = 20;
  const bad = W.friction([
    user('Sistema il parser delle date nel file utils.'), answer(),
    user('No, non funziona ancora il parser delle date.'), answer(),
    user('Sistema il parser delle date nel file utils, ti ho detto.'), answer(),
    user('Sei inutile, il parser delle date è ancora rotto!!!')
  ], now);
  assert.ok(bad.points >= 4, `points ${bad.points}`);
  assert.ok(bad.signs.repeating >= 1 && bad.signs.correcting >= 1 && bad.signs.harsh === 1 && bad.signs.loud === 1);
  minute = 20;
  const stopped = W.friction([user('Scrivi il modulo.'), answer('interrupted'), user('Scrivi solo la prima funzione.'), answer('interrupted'), user('Una funzione sola per favore.'), answer('error')], now);
  assert.deepEqual([stopped.signs.stopped, stopped.points >= 3], [3, true]);
  minute = 200;
  const old = W.friction([user('No, sbagliato.'), user('No, ancora sbagliato.'), user('Idiota.'), user('NO NO NO NO NO NO!!!')], now);
  assert.equal(old.points, 0, 'what was said hours ago does not count');
  minute = 10;
  const code = W.friction([user('Rinomina la costante in MAX_RETRY_COUNT_DEFAULT.'), answer(), user('Ora aggiungi il controllo sul valore.'), answer(), user('Bene, e documenta la funzione.')], now);
  assert.equal(code.points, 0);
});

test('a stretch of time in hours and minutes; the pauses of a period added up', () => {
  assert.deepEqual(W.duration(130), { hours: 2, minutes: 10 });
  assert.deepEqual(W.duration(59.6), { hours: 1, minutes: 0 });
  assert.deepEqual(W.duration(-4), { hours: 0, minutes: 0 });
  const totals = W.pausesTotals({ pauses: [{ day: '2026-09-27', pauses: 2, minutes: 25 }, { day: '2026-09-28', pauses: 1, minutes: 9 }, { day: '2026-08-01', pauses: 4, minutes: 40 }] }, ['2026-09-26', '2026-09-27', '2026-09-28']);
  assert.deepEqual([totals.count, totals.minutes, totals.days], [3, 34, 2]);
  assert.deepEqual(plain([...totals.byDay]), [['2026-09-27', { pauses: 2, minutes: 25 }], ['2026-09-28', { pauses: 1, minutes: 9 }]]);
  assert.deepEqual([W.pausesTotals(null, ['2026-09-28']).count, W.pausesTotals({}, []).minutes], [0, 0]);
});

/* ------------------------------------------------------------------ */
/* What the server keeps                                                */
/* ------------------------------------------------------------------ */

test('a notice is written down with its answer; the day\'s notices come the latest first', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const p = store.personal();
  const first = p.recordNotice({ kind: 'long', projectId: 'p1', detail: 'Lavori da due ore.' });
  assert.deepEqual([first.kind, first.project_id, first.answer, first.day], ['long', 'p1', null, dayStamp(new Date())]);
  const second = p.recordNotice({ kind: 'advice', detail: 'Un consiglio.' });
  assert.equal(p.answerNotice(first.id, 'later').answer, 'later');
  assert.match(p.answerNotice(second.id, 'today').answered_at, /^\d{4}-/);
  assert.throws(() => p.answerNotice(first.id, 'forse'), /Risposta non valida/);
  assert.throws(() => p.answerNotice('nobody', 'ok'), /Avviso non trovato/);
  assert.throws(() => p.recordNotice({ kind: '' }), /Avviso non valido/);
  assert.deepEqual(p.notices({}).map(n => n.kind).sort(), ['advice', 'long']);
  assert.equal(p.notices({ day: '2020-01-01' }).length, 0);
});

test('a pause has a start and an end; one at a time; the days give how many and how long', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const p = store.personal();
  assert.equal(p.openPause(), null);
  const first = p.startPause({ minutes: 10, what: 'Un caffè', reason: 'long', projectId: 'p1' });
  assert.deepEqual([first.minutes, first.what, first.reason, first.ended_at], [10, 'Un caffè', 'long', null]);
  assert.equal(p.openPause().id, first.id);
  const second = p.startPause({ minutes: 5 });
  assert.match(p.pauses({}).find(x => x.id === first.id).ended_at, /^\d{4}-/, 'the one open is ended by the next');
  // taken twelve minutes ago, for the numbers
  store.db.prepare('UPDATE pauses SET started_at=? WHERE id=?').run(new Date(Date.now() - 12 * MINUTE).toISOString(), second.id);
  const ended = p.endPause(second.id);
  assert.equal(p.endPause(second.id).ended_at, ended.ended_at, 'ended once');
  assert.equal(p.openPause(), null);
  assert.equal(p.pauses({}).find(x => x.id === second.id).lasted, 12);
  assert.throws(() => p.startPause({ minutes: 0 }), /Durata/);
  assert.throws(() => p.startPause({ minutes: 500 }), /Durata/);
  assert.throws(() => p.endPause('nobody'), /Pausa non trovata/);
  const today = dayStamp(new Date());
  const activity = p.activity({ from: today, to: today });
  assert.deepEqual(plain(activity.pauses), [{ day: today, pauses: 2, minutes: 12 }]);
  p.deletePause(second.id);
  assert.deepEqual(p.pauses({}).map(x => x.id), [first.id], 'one recorded by mistake is taken out');
  assert.throws(() => p.deletePause(second.id), /Pausa non trovata/);
  const notice = p.recordNotice({ kind: 'long', detail: 'x' });
  p.deleteNotice(notice.id);
  assert.equal(p.notices({}).length, 0);
  assert.throws(() => p.deleteNotice(notice.id), /Avviso non trovato/);
});

test('the pauses the user likes: proposed by a model once, confirmed by the user, offered in turn', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const p = store.personal();
  const coffee = p.saveLikedPause({ name: 'Un caffè', minutes: 10 });
  assert.deepEqual([coffee.status, coffee.source, coffee.offered_at], ['liked', 'user', null]);
  const walk = p.saveLikedPause({ name: 'Due passi', minutes: 15, status: 'proposed', why: 'mi piace fare due passi', source: 'model' });
  assert.deepEqual([walk.status, walk.source, walk.why], ['proposed', 'model', 'mi piace fare due passi']);
  assert.equal(p.saveLikedPause({ name: 'due passi', minutes: 20, status: 'proposed', source: 'model' }).id, walk.id, 'proposed again, it is the one there');
  assert.equal(p.likedPause(walk.id).minutes, 15);
  assert.throws(() => p.saveLikedPause({ name: 'un caffè', minutes: 5 }), /c'è già/);
  assert.equal(p.saveLikedPause({ status: 'dismissed' }, walk.id).status, 'dismissed');
  assert.equal(p.saveLikedPause({ name: 'Due passi', minutes: 15, status: 'proposed', source: 'model' }).status, 'dismissed', 'turned down: it is not proposed again');
  assert.match(p.saveLikedPause({ offered: true }, coffee.id).offered_at, /^\d{4}-/);
  assert.deepEqual(p.likedPauses().map(x => [x.name, x.status]), [['Un caffè', 'liked'], ['Due passi', 'dismissed']]);
  assert.throws(() => p.saveLikedPause({ name: 'Stretching', minutes: 0 }), /Durata/);
  assert.throws(() => p.saveLikedPause({ name: 'Stretching', status: 'forse' }), /Stato/);
  p.deleteLikedPause(walk.id);
  assert.equal(p.likedPauses().length, 1);
  assert.throws(() => p.deleteLikedPause(walk.id), /Pausa non trovata/);
});

test('the last hours of a project: its steps, the moments the user wrote in its chats, the pauses', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const p = store.personal();
  const project = store.createProject({ name: 'Sito', kind: 'local', path: 'C:/x' });
  const other = store.createProject({ name: 'Altro', kind: 'local', path: 'C:/y' });
  const ago = (minutes) => new Date(Date.now() - minutes * MINUTE).toISOString();
  const insert = store.db.prepare('INSERT INTO project_steps(project_id,hash,at,day,hour,source,title,files,additions,deletions) VALUES(?,?,?,?,?,?,?,?,?,?)');
  insert.run(project.id, 'a1', ago(50), dayStamp(new Date()), 10, 'user', 'parser.js', 1, 3, 1);
  insert.run(project.id, 'a2', ago(20), dayStamp(new Date()), 10, 'agent', 'Aggiunto il test', 2, 30, 0);
  insert.run(project.id, 'a3', ago(60 * 30), dayStamp(new Date()), 10, 'user', 'vecchio.js', 1, 1, 1);
  insert.run(other.id, 'b1', ago(10), dayStamp(new Date()), 10, 'user', 'altro.js', 1, 1, 1);
  const chat = store.createConversation('Chat del progetto');
  store.db.prepare('UPDATE conversations SET project_id=? WHERE id=?').run(project.id, chat.id);
  store.saveMessage(chat.id, { role: 'user', content: 'Sistema il parser.' });
  store.saveMessage(chat.id, { role: 'assistant', content: 'Fatto.' });
  store.saveMessage(store.createConversation('Altrove').id, { role: 'user', content: 'Altro.' });
  p.endPause(p.startPause({ minutes: 5 }).id);
  const got = p.signals({ projectId: project.id, hours: 8 });
  assert.equal(got.project.name, 'Sito');
  assert.deepEqual(got.steps.map(s => [s.source, s.title, s.files]), [['user', 'parser.js', 1], ['agent', 'Aggiunto il test', 2]]);
  assert.equal(got.messages.length, 1);
  assert.equal(got.pauses.length, 1);
  assert.match(got.now, /^\d{4}-\d{2}-\d{2}T/);
  assert.throws(() => p.signals({ projectId: 'nobody' }), /Progetto non trovato/);
});

/* ------------------------------------------------------------------ */
/* The notices as they are given                                        */
/* ------------------------------------------------------------------ */

const source = fs.readFileSync(path.join(__dirname, '../resources/js/realtime-notices.js'), 'utf8');

/** The notices' file in a page made for the test: the Code tab open on a project, a storage that keeps what was written. */
function page({ signals = {}, settings = {}, liked = [], goals = [], given = [], view = 'code', messages = [], tip = null } = {}) {
  const now = Date.now();
  // The hours of the notice of the late hours start out as the night's: a test that does not set them
  // has them away from the hour it is run at, or it would pass by day and fail by night.
  const chosen = (() => { try { return JSON.parse(settings.realtime_notices || '{}'); } catch { return {}; } })();
  if (!['late', 'lateFrom', 'lateTo'].some(key => key in chosen)) {
    const away = (hours) => { const d = new Date(now + hours * 60 * MINUTE); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    settings = { ...settings, realtime_notices: JSON.stringify({ ...chosen, lateFrom: away(8), lateTo: away(10) }) };
  }
  const saved = { notices: [...given], answers: [], pauses: [], ended: [], offered: [], settings: new Map(Object.entries(settings)), asked: [], said: [] };
  const node = () => ({ hidden: true, className: '', dataset: {}, innerHTML: '', textContent: '', parentNode: null, offsetParent: {},
    classList: { toggle() {}, contains: () => false }, setAttribute() {}, addEventListener() {}, appendChild(child) { child.parentNode = this; }, remove() {}, querySelector: () => node() });
  const rt = {
    // what the section's own object holds already under these names: the notices must not lean on them
    view: {}, ui: {}, dialog: null, calendar: null,
    conversationId: 'rt-chat', tasksConversationId: 'rt-tasks', busy: false, diarySession: null, player: null, goals, sideTab: null,
    loadGoals: async () => {}, renderSide() {}, renderSettings() {}, loadWellbeing() {}, displayName: () => 'Omino',
    job: (key, run) => run(),
    master: async (kind, request) => { saved.asked.push({ kind, ...request }); return JSON.stringify(tip ? { advise: true, tip } : { advise: false, tip: '' }); }
  };
  const chat = {
    isGenerating: false, conversation: { id: 'chat-1' }, messages, generation: null,
    persist: async () => 'saved', stopGeneration() {}, canStopHere: () => true
  };
  const window = {
    realtime: { _state: rt, _util: { t: (key, p) => key + (p ? ' ' + JSON.stringify(p) : ''), esc: (x) => String(x), dayStamp }, voice: { available: () => true, say: async (text) => { saved.said.push(text); }, stop() {} } },
    RealtimeWellbeing: W,
    codeWorkspace: { current: () => ({ id: 'p1', name: 'Sito' }) },
    chatManager: chat,
    switchView: () => {},
    chatStorage: {
      getSetting: async (key) => ({ value: saved.settings.get(key) ?? null }),
      setSetting: async (key, value) => { saved.settings.set(key, value); },
      likedPauses: async () => liked,
      saveLikedPause: async (data, id) => { saved.offered.push({ id, ...data }); const row = liked.find(x => x.id === id); if (row && data.offered) row.offered_at = new Date().toISOString(); return row; },
      signals: async () => ({ now: new Date(now).toISOString(), steps: [], messages: [], pauses: [], ...signals }),
      notices: async () => [...saved.notices].reverse(),
      recordNotice: async (data) => { const row = { id: `n${saved.notices.length + 1}`, kind: data.kind, project_id: data.projectId, detail: data.detail, at: new Date().toISOString(), answer: null, answered_at: null }; saved.notices.push(row); return row; },
      answerNotice: async (id, answer) => { saved.answers.push([id, answer]); const row = saved.notices.find(n => n.id === id); row.answer = answer; row.answered_at = new Date().toISOString(); return row; },
      startPause: async (data) => { const row = { id: `b${saved.pauses.length + 1}`, started_at: new Date().toISOString(), ...data }; saved.pauses.push(row); return row; },
      endPause: async (id) => { saved.ended.push(id); return {}; },
      openPause: async () => ({ pause: null })
    }
  };
  const tabs = { [`tab-btn-${view}`]: { classList: { contains: (name) => name === 'active' } }, 'code-notice': node() };
  const document = { readyState: 'loading', addEventListener() {}, body: node(), createElement: () => node(), getElementById: (id) => tabs[id] || null, querySelector: () => null };
  const sandbox = { window, document, console, setTimeout: (run) => { run(); return 0; }, setInterval: () => 0, clearInterval() {}, Date, Promise, JSON, Math, Map, Set, Number, String, Object, Array };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  rt.renderNotice = () => {};
  return { rt, saved, chat, now, ago: (minutes) => new Date(now - minutes * MINUTE).toISOString() };
}

const steps = (ago, title, minutes) => minutes.map(m => ({ at: ago(m), source: 'user', title, files: 1 }));

test('two hours of work: a pause is proposed, one of the liked ones, the one offered longest ago', async () => {
  const liked = [
    { id: 'l1', name: 'Un caffè', minutes: 10, status: 'liked', offered_at: '2026-09-27T10:00:00Z' },
    { id: 'l2', name: 'Due passi', minutes: 15, status: 'liked', offered_at: null },
    { id: 'l3', name: 'Videogioco', minutes: 30, status: 'proposed', offered_at: null }
  ];
  // the moments the user wrote, ten minutes apart, for a little more than two hours
  const made = page();
  const run = page({ liked, signals: { messages: Array.from({ length: 14 }, (_, i) => ({ at: made.ago(131 - i * 10) })) } });
  await run.rt.loadNotices();
  const notice = await run.rt.look();
  assert.equal(notice.kind, 'long');
  assert.deepEqual(plain(notice.actions), ['pause', 'later', 'today']);
  assert.match(notice.text, /realtime\.noticeLong .*realtime\.noticePauseLiked .*Due passi/);
  assert.deepEqual(plain(run.saved.offered), [{ id: 'l2', offered: true }]);
  assert.equal(run.saved.said.length, 0, 'the voice is off until the user turns it on');
  assert.equal(await run.rt.look(), null, 'one notice at a time');
  await run.rt.answerNotice('pause');
  assert.deepEqual(plain(run.saved.answers), [['n1', 'pause']]);
  assert.deepEqual(run.saved.pauses.map(x => [x.minutes, x.what, x.reason, x.projectId]), [[15, 'Due passi', 'long', 'p1']]);
  assert.equal(run.rt.pause.minutes, 15);
  assert.equal(await run.rt.look(), null, 'nothing is said during a pause');
  await run.rt.endPause();
  assert.deepEqual(run.saved.ended, ['b1']);
  assert.equal(run.rt.pause, null);
});

test('an hour on one file: the file is named; less than the time set, nothing is said', async () => {
  const made = page();
  const one = page({ signals: { steps: steps(made.ago, 'parser.js', [65, 50, 35, 20, 8, 2]) } });
  await one.rt.loadNotices();
  const notice = await one.rt.look();
  assert.equal(notice.kind, 'stuck');
  assert.match(notice.text, /realtime\.noticeStuck .*parser\.js.*realtime\.noticePause /);
  const short = page({ signals: { steps: steps(made.ago, 'parser.js', [40, 30, 20, 8, 2]) } });
  await short.rt.loadNotices();
  assert.equal(await short.rt.look(), null);
  const sooner = page({ signals: { steps: steps(made.ago, 'parser.js', [40, 30, 20, 8, 2]) }, settings: { realtime_notices: JSON.stringify({ stuckMinutes: 30 }) } });
  await sooner.rt.loadNotices();
  assert.equal((await sooner.rt.look()).kind, 'stuck', 'the time is the user\'s to set');
  const model = page({ signals: { steps: steps(made.ago, 'parser.js', [65, 50, 35, 20, 8, 2]).map(s => ({ ...s, source: 'agent' })) } });
  await model.rt.loadNotices();
  assert.equal(await model.rt.look(), null, 'what a model saved is not the user at work');
});

test('what the user answered is kept to: not today, in a quarter of an hour, the gap between notices', async () => {
  const made = page();
  const work = { steps: steps(made.ago, 'parser.js', [65, 50, 35, 20, 8, 2]) };
  const answered = (kind, answer, minutes) => [{ id: 'n1', kind, project_id: 'p1', at: made.ago(minutes + 1), answer, answered_at: made.ago(minutes) }];
  const off = page({ signals: work, given: answered('stuck', 'today', 200) });
  await off.rt.loadNotices();
  assert.equal(await off.rt.look(), null, 'not today: not of that kind');
  const other = page({ signals: { messages: Array.from({ length: 14 }, (_, i) => ({ at: made.ago(131 - i * 10) })) }, given: answered('stuck', 'today', 200) });
  await other.rt.loadNotices();
  assert.equal((await other.rt.look()).kind, 'long', 'another kind is still said');
  const soon = page({ signals: work, given: answered('stuck', 'later', 5) });
  await soon.rt.loadNotices();
  assert.equal(await soon.rt.look(), null);
  const later = page({ signals: work, given: answered('stuck', 'later', 16) });
  await later.rt.loadNotices();
  assert.equal((await later.rt.look()).kind, 'stuck', 'put off, it comes back after a quarter of an hour');
  const close = page({ signals: work, given: answered('late', 'ok', 20) });
  await close.rt.loadNotices();
  assert.equal(await close.rt.look(), null, 'within the gap from the last notice');
  const apart = page({ signals: work, given: answered('late', 'ok', 50) });
  await apart.rt.loadNotices();
  assert.equal((await apart.rt.look()).kind, 'stuck');
});

test('nothing is said when the notices are off, away from the Code tab, or while a model answers', async () => {
  const made = page();
  const work = { steps: steps(made.ago, 'parser.js', [65, 50, 35, 20, 8, 2]) };
  const off = page({ signals: work, settings: { realtime_notices: JSON.stringify({ on: false }) } });
  await off.rt.loadNotices();
  assert.equal(await off.rt.look(), null);
  const kind = page({ signals: work, settings: { realtime_notices: JSON.stringify({ stuck: false, long: false }) } });
  await kind.rt.loadNotices();
  assert.equal(await kind.rt.look(), null);
  const away = page({ signals: work, view: 'chat' });
  await away.rt.loadNotices();
  assert.equal(await away.rt.look(), null);
  const busy = page({ signals: work });
  await busy.rt.loadNotices();
  busy.chat.isGenerating = true;
  assert.equal(await busy.rt.look(), null);
  busy.chat.isGenerating = false;
  busy.rt.diarySession = { step: 'account' };
  assert.equal(await busy.rt.look(), null);
  busy.rt.diarySession = null;
  assert.equal((await busy.rt.look()).kind, 'stuck');
});

test('a step due is said when the project is opened, once a day, working or not', async () => {
  const today = dayStamp(new Date());
  const goals = [{ name: 'Sito', status: 'open', project_id: 'p1', due_day: null, steps: [{ title: 'Testi', done: 0, due_day: today }, { title: 'Foto', done: 0, due_day: '2020-01-01' }] }];
  const due = page({ goals });
  await due.rt.loadNotices();
  const notice = await due.rt.look();
  assert.equal(notice.kind, 'due');
  assert.deepEqual(plain(notice.actions), ['ok', 'agenda', 'today']);
  assert.match(notice.text, /realtime\.noticeDue_late .*Foto.*realtime\.noticeDueOther/);
  await due.rt.answerNotice('ok');
  assert.equal(await due.rt.look(), null);
  const again = page({ goals, given: [{ id: 'n1', kind: 'due', project_id: 'p1', at: due.ago(300), answer: 'ok', answered_at: due.ago(299) }] });
  await again.rt.loadNotices();
  assert.equal(await again.rt.look(), null, 'said today already for this project');
});

test('working in the hours the user chose is said once for each time they come round', async () => {
  const hour = (shift) => { const d = new Date(Date.now() + shift * 60 * MINUTE); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const made = page();
  const work = { messages: [{ at: made.ago(12) }, { at: made.ago(3) }] };
  const inside = page({ signals: work, settings: { realtime_notices: JSON.stringify({ lateFrom: hour(-1), lateTo: hour(1) }) } });
  await inside.rt.loadNotices();
  const notice = await inside.rt.look();
  assert.equal(notice.kind, 'late');
  assert.deepEqual(plain(notice.actions), ['ok', 'today']);
  assert.match(notice.text, new RegExp(`realtime\\.noticeLate .*"from":"${hour(-1)}","to":"${hour(1)}"`));
  await inside.rt.answerNotice('ok');
  inside.saved.notices[0].at = made.ago(50);
  inside.saved.notices[0].answered_at = made.ago(50);
  assert.equal(await inside.rt.look(), null, 'said already since the hours began');
  const outside = page({ signals: work, settings: { realtime_notices: JSON.stringify({ lateFrom: hour(2), lateTo: hour(4) }) } });
  await outside.rt.loadNotices();
  assert.equal(await outside.rt.look(), null);
  const before = page({ signals: work, settings: { realtime_notices: JSON.stringify({ lateFrom: hour(-1), lateTo: hour(1) }) },
    given: [{ id: 'n0', kind: 'late', project_id: 'p1', at: made.ago(180), answer: 'ok', answered_at: made.ago(179) }] });
  await before.rt.loadNotices();
  assert.equal((await before.rt.look()).kind, 'late', 'the one of the hours before these does not count');
  const idle = page({ signals: { messages: [{ at: made.ago(40) }] }, settings: { realtime_notices: JSON.stringify({ lateFrom: hour(-1), lateTo: hour(1) }) } });
  await idle.rt.loadNotices();
  assert.equal(await idle.rt.look(), null, 'not working: nothing to say');
});

test('the settings keep only what differs from how they start out, and wrong values are not taken', async () => {
  const p = page({ settings: { realtime_notices: JSON.stringify({ longMinutes: 90, stuckMinutes: 2, lateFrom: 'tardi', lateTo: '05:00', voice: 'sì', gapMinutes: 30 }) } });
  await p.rt.loadNotices();
  assert.deepEqual([p.rt.notices.longMinutes, p.rt.notices.stuckMinutes, p.rt.notices.lateFrom, p.rt.notices.lateTo, p.rt.notices.voice, p.rt.notices.gapMinutes], [90, 60, '00:00', '05:00', false, 30]);
  await p.rt.saveNotices({ voice: true, gapMinutes: 45 });
  assert.deepEqual(JSON.parse(p.saved.settings.get('realtime_notices')), { longMinutes: 90, voice: true });
  await p.rt.saveNotices({ voice: false, longMinutes: 120 });
  assert.equal(p.saved.settings.get('realtime_notices'), '');
});

const exchange = (ago) => [
  { role: 'user', content: 'Sistema il parser delle date nel file utils.', timestamp: ago(20), kind: 'final' },
  { role: 'assistant', content: 'Fatto.', timestamp: ago(19), kind: 'final', status: 'complete' },
  { role: 'user', content: 'No, non funziona ancora il parser delle date.', timestamp: ago(15), kind: 'final' },
  { role: 'assistant', content: 'Riprovo.', timestamp: ago(14), kind: 'final', status: 'complete' },
  { role: 'user', content: 'Sistema il parser delle date nel file utils, ti ho detto.', timestamp: ago(10), kind: 'final' },
  { role: 'assistant', content: 'Ecco.', timestamp: ago(9), kind: 'final', status: 'complete' },
  { role: 'user', content: 'Sei inutile, il parser delle date è ancora rotto!!!', timestamp: ago(1), kind: 'final' }
];

test('an exchange going badly: the Master is asked once, on the last messages, and its advice is given', async () => {
  const made = page();
  const p = page({ view: 'chat', messages: exchange(made.ago), tip: 'Prova a incollare il testo dell’errore e a dire che cosa ti aspettavi.' });
  await p.rt.loadNotices();
  const notice = await p.rt.weigh('chat-1');
  assert.equal(notice.kind, 'advice');
  assert.equal(notice.text, 'Prova a incollare il testo dell’errore e a dire che cosa ti aspettavi.');
  assert.deepEqual(plain(notice.actions), ['ok', 'today']);
  assert.equal(p.saved.asked.length, 1);
  const [asked] = p.saved.asked;
  assert.deepEqual([asked.kind, asked.json], ['advice', true]);
  assert.match(asked.user, /^Signs found: .*harsh 1/);
  assert.match(asked.user, /\[User\] Sei inutile, il parser/);
  assert.ok(asked.user.length < 1500, 'a short request');
  assert.doesNotMatch(asked.stable, /parser/, 'the instructions are the same whatever the exchange');
  assert.equal(JSON.parse(p.saved.settings.get('realtime_advice_asked')).count, 1);
  p.rt.notice = null;
  assert.equal(await p.rt.weigh('chat-1'), null, 'not again at once');
  assert.equal(p.saved.asked.length, 1);
});

test('no advice when the Master finds a false alarm; two requests a day at most; a calm exchange costs nothing', async () => {
  const made = page();
  const none = page({ view: 'chat', messages: exchange(made.ago) });
  await none.rt.loadNotices();
  assert.equal(await none.rt.weigh('chat-1'), null);
  assert.equal(none.saved.asked.length, 1);
  assert.equal(none.saved.notices.length, 0);
  const spent = page({ view: 'chat', messages: exchange(made.ago), tip: 'Un consiglio.', settings: { realtime_advice_asked: JSON.stringify({ day: dayStamp(new Date()), count: 2 }) } });
  await spent.rt.loadNotices();
  assert.equal(await spent.rt.weigh('chat-1'), null);
  assert.equal(spent.saved.asked.length, 0, 'the day\'s requests are spent');
  const yesterday = page({ view: 'chat', messages: exchange(made.ago), tip: 'Un consiglio.', settings: { realtime_advice_asked: JSON.stringify({ day: '2020-01-01', count: 2 }) } });
  await yesterday.rt.loadNotices();
  assert.equal((await yesterday.rt.weigh('chat-1')).kind, 'advice');
  const calm = page({ view: 'chat', tip: 'Un consiglio.', messages: [
    { role: 'user', content: 'Aggiungi una funzione che legge il file.', timestamp: made.ago(9), kind: 'final' },
    { role: 'assistant', content: 'Fatto.', timestamp: made.ago(8), kind: 'final', status: 'complete' },
    { role: 'user', content: 'Ora scrivi il test.', timestamp: made.ago(5), kind: 'final' },
    { role: 'assistant', content: 'Fatto.', timestamp: made.ago(4), kind: 'final', status: 'complete' },
    { role: 'user', content: 'Bene, passa al modulo successivo.', timestamp: made.ago(1), kind: 'final' }] });
  await calm.rt.loadNotices();
  assert.equal(await calm.rt.weigh('chat-1'), null);
  assert.equal(calm.saved.asked.length, 0);
});

test('without the Master the advice is a fixed sentence; the character\'s own chats are left alone', async () => {
  const made = page();
  const fixed = page({ view: 'chat', messages: exchange(made.ago), settings: { realtime_notices: JSON.stringify({ confirm: false, voice: true }) } });
  await fixed.rt.loadNotices();
  const notice = await fixed.rt.weigh('chat-1');
  assert.match(notice.text, /^realtime\.advice_(harsh|repeating)/);
  assert.equal(fixed.saved.asked.length, 0);
  assert.deepEqual(fixed.saved.said, [notice.text], 'read aloud when the user turned the voice on');
  const own = page({ view: 'chat', messages: exchange(made.ago), tip: 'x' });
  await own.rt.loadNotices();
  own.chat.conversation = { id: 'rt-tasks' };
  assert.equal(await own.rt.weigh('rt-tasks'), null);
  assert.equal(await own.rt.weigh('chat-other'), null, 'a chat that is not the one on screen');
  const off = page({ view: 'chat', messages: exchange(made.ago), tip: 'x', settings: { realtime_notices: JSON.stringify({ advice: false }) } });
  await off.rt.loadNotices();
  assert.equal(await off.rt.weigh('chat-1'), null);
  assert.equal(off.saved.asked.length, 0);
});

test('answers stopped by the user are counted from the stop button', async () => {
  const made = page();
  const p = page({ view: 'chat', settings: { realtime_notices: JSON.stringify({ confirm: false }) }, messages: [
    { role: 'user', content: 'Scrivi tutto il modulo di importazione.', timestamp: made.ago(9), kind: 'final' },
    { role: 'assistant', content: 'Ecco', timestamp: made.ago(8), kind: 'final', status: 'complete' },
    { role: 'user', content: 'Scrivi solo la prima funzione del modulo.', timestamp: made.ago(6), kind: 'final' },
    { role: 'assistant', content: 'Ecco', timestamp: made.ago(5), kind: 'final', status: 'complete' },
    { role: 'user', content: 'Una funzione sola, breve.', timestamp: made.ago(3), kind: 'final' },
    { role: 'assistant', content: 'Ecco', timestamp: made.ago(2), kind: 'final', status: 'complete' },
    { role: 'user', content: 'Soltanto la firma della funzione.', timestamp: made.ago(1), kind: 'final' }] });
  await p.rt.loadNotices();
  p.rt.startNotices();
  assert.equal(await p.rt.weigh('chat-1'), null, 'nothing was stopped: nothing to say');
  p.rt.adviceChecked = 0;
  p.chat.generation = { conversationId: 'chat-1' };
  for (let i = 0; i < 4; i++) p.chat.stopGeneration();
  p.chat.generation = null;
  const notice = await p.rt.weigh('chat-1');
  assert.match(notice.text, /^realtime\.advice_stopped/);
});
