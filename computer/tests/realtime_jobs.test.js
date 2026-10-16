'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Store } = require('../server/database');
const W = require('../resources/js/realtime-wellbeing.js');

const source = fs.readFileSync(path.join(__dirname, '../resources/js/realtime-jobs.js'), 'utf8');
const pad = (n) => String(n).padStart(2, '0');
const dayStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localStamp = (d) => `${dayStamp(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * The jobs' file in a page made for the test: a Master that answers what the
 * test says and keeps every request it was sent, a storage that keeps what
 * was saved, and the section's object with the few methods the jobs lean on.
 */
function page({ replies = [], messages = [], mark = null, local = {}, supported = ['temperature', 'reasoning', 'response_format', 'max_tokens'], own = {}, modelLocal = false } = {}) {
  const sent = [];
  const saved = { jobs: [], settings: new Map(mark ? [['realtime_analyzed', JSON.stringify(mark)]] : []), memories: [], notes: [], reads: [], agenda: [], habits: [], goals: [], marks: [], diary: [], reviews: [], pauses: [] };
  const answers = [...replies];
  const rt = {
    conversationId: 'c1', notes: [], habits: [], goals: [], proposals: [], writing: new Set(), pageErrors: new Map(),
    settled: async () => {}, ensure: async () => {}, custom: async (key) => `[${key}]`,
    knownNotes() { return { ids: new Map(this.notes.map((n, i) => [`n${i + 1}`, n])), list: this.notes.map((n, i) => `[n${i + 1}] ${n.content}`).join('\n') || '(none)' }; },
    applyMemories: async (changes) => { saved.memories.push(changes); return (changes?.add || []).length; },
    knownHabits: async () => ({ ids: new Map(), followed: '(none)', others: '(none)', before: '(no day told)' }),
    applyHabits: async () => {}, applyGoals: async () => {}, knownGoals: () => ({ ids: new Map(), list: '(none)' }),
    workOfDay: async () => '(nothing recorded)', loadGoals: async () => {}, loadDiary: async () => {}, loadWellbeing: async () => {},
    loadNotes: async () => {}, renderSide() {}, renderSettings() {}, renderControls() {}, tell() {}, figure: (v) => String(v)
  };
  const window = {
    realtime: { _state: rt, _util: { t: (key, p) => key + (p?.error ? ` ${p.error}` : ''), esc: (x) => String(x), dayStamp, localStamp, plainWords: (x) => String(x).toLowerCase(), dayData: () => null } },
    RealtimeWellbeing: W,
    operationalRegistry: { getCurrentMasterModel: () => ({ id: 'vendor/master', name: 'Master' }), getModelParameters: () => own },
    openRouterCatalog: { getApiKey: () => 'key', models: [{ id: 'vendor/master', supportedParameters: supported }] },
    modelGateway: {
      isLocal: () => modelLocal,
      fetchChat: async ({ body }) => {
        const payload = JSON.parse(body);
        sent.push(payload);
        const next = answers.length ? answers.shift() : { content: '{}' };
        if (next.error) return { ok: false, status: 500, json: async () => ({ error: { message: next.error } }) };
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: next.content }, finish_reason: next.finish || 'stop' }], usage: next.usage || { prompt_tokens: 100, completion_tokens: 20 } }) };
      }
    },
    chatStorage: {
      getSetting: async (key) => (saved.settings.has(key) ? { value: saved.settings.get(key) } : { value: null }),
      setSetting: async (key, value) => { saved.settings.set(key, value); },
      messagesAfter: async (id, sequence) => ({ messages: messages.filter(m => m.sequence > sequence), last: messages.length ? messages[messages.length - 1].sequence : 0 }),
      memories: async () => rt.notes,
      saveMemory: async (data, id) => { saved.notes.push({ id, ...data }); },
      recordJob: async (job) => { saved.jobs.push(job); },
      request: async () => [],
      agendaProposals: async () => [],
      saveAgenda: async (item) => { saved.agenda.push(item); return { ...item, proposed: 1 }; },
      diary: async (from, to, limit, fields) => { saved.reads.push({ from, to, limit, fields }); return saved.diary.filter(e => (!from || e.day >= from) && (!to || e.day <= to)); },
      saveDiary: async (data, id) => { saved.diary = saved.diary.map(e => (e.id === id ? { ...e, ...data } : e)); return {}; },
      habits: async () => rt.habits, goals: async () => rt.goals, habitDays: async () => saved.marks,
      saveHabit: async (data, id) => { saved.habits.push({ id, ...data }); rt.habits = rt.habits.map(h => (h.id === id ? { ...h, ...(data.keywords ? { keywords: JSON.stringify(data.keywords) } : {}), ...(data.readAt ? { read_at: 'now' } : {}) } : h)); },
      saveGoal: async (data, id) => { saved.goals.push({ id, ...data }); rt.goals = rt.goals.map(g => (g.id === id ? { ...g, keywords: JSON.stringify(data.keywords) } : g)); },
      addDiaryMarks: async (marks) => { saved.marks.push(...marks.map(m => ({ habit_id: m.habitId, day: m.day, done: m.done }))); return { added: marks.length }; },
      reviews: async () => saved.reviews,
      saveLikedPause: async (data) => { saved.pauses.push(data); return { id: 'l' + saved.pauses.length, ...data }; }
    }
  };
  const store = new Map(Object.entries(local));
  const sandbox = { window, localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null) }, crypto: { randomUUID: () => 'id-' + Math.random() }, console, setTimeout, Date, Promise, JSON, Math };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { rt, sent, saved, jobs: window.realtime._jobs };
}

const message = (sequence, role, content, extra = {}) => ({ sequence, role, content, kind: 'final', status: 'complete', ...extra });
const textOf = (content) => (Array.isArray(content) ? content.map(p => p.text).join('\n\n') : content);

test('a request: the instructions first and marked for the cache, what changes last, the answer capped', async () => {
  const { rt, sent, saved } = page({ replies: [{ content: '{"ok": true}', usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 700 }, cost: 0.00012 } }] });
  const reply = await rt.master('analysis', { stable: 'RULES', user: 'WORDS', json: true });
  assert.equal(reply, '{"ok": true}');
  const [payload] = sent;
  assert.deepEqual(JSON.parse(JSON.stringify(payload.messages[0])), { role: 'system', content: [{ type: 'text', text: 'RULES', cache_control: { type: 'ephemeral' } }] });
  assert.deepEqual(JSON.parse(JSON.stringify(payload.messages[1])), { role: 'user', content: 'WORDS' });
  assert.equal(payload.max_tokens, 1500);
  assert.equal(payload.stream, false);
  assert.equal(payload.session_id, 'realtime-jobs');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.reasoning)), { effort: 'low' });
  assert.deepEqual(JSON.parse(JSON.stringify(payload.response_format)), { type: 'json_object' });
  assert.equal(payload.temperature, 0.2);
  assert.equal(payload.provider, undefined);
  const [job] = saved.jobs;
  assert.deepEqual([job.kind, job.model, job.ok, job.promptTokens, job.completionTokens, job.cachedTokens, job.cost], ['analysis', 'vendor/master', true, 900, 40, 700, 0.00012]);
});

test('the user\'s own settings are followed: thinking, temperature of the writing, caching off, no data kept', async () => {
  const { rt, sent } = page({
    replies: [{ content: 'Una pagina.' }],
    own: { reasoning_effort: 'high', temperature: 0.9 },
    local: { synthorg_prompt_caching_enabled: 'false', synthorg_openrouter_zdr_enabled: 'true' }
  });
  await rt.master('review', { stable: 'RULES', user: 'NUMBERS' });
  const [payload] = sent;
  assert.equal(payload.messages[0].content, 'RULES', 'without caching the instructions are plain text');
  assert.equal(payload.session_id, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.provider)), { zdr: true, data_collection: 'deny' });
  assert.deepEqual(JSON.parse(JSON.stringify(payload.reasoning)), { effort: 'high' });
  assert.equal(payload.temperature, 0.9);
  assert.equal(payload.response_format, undefined);
});

test('what a model cannot take is not sent; a model on this computer gets plain text and no provider rules', async () => {
  const remote = page({ replies: [{ content: '{}' }], supported: [] });
  await remote.rt.master('data', { stable: 'RULES', user: 'DAY', json: true });
  assert.deepEqual(Object.keys(remote.sent[0]).sort(), ['max_tokens', 'messages', 'model', 'session_id', 'stream', 'usage']);
  const own = page({ replies: [{ content: '{}' }], modelLocal: true, local: { synthorg_openrouter_zdr_enabled: 'true' } });
  await own.rt.master('data', { stable: 'RULES', user: 'DAY', json: true });
  assert.equal(own.sent[0].messages[0].content, 'RULES');
  assert.equal(own.sent[0].provider, undefined);
  assert.equal(own.sent[0].usage, undefined);
});

test('an answer cut short by the cap is asked for once more with twice the room; a fault is written down as one', async () => {
  const cut = page({ replies: [{ content: '{"half', finish: 'length' }, { content: '{"whole": true}' }] });
  assert.equal(await cut.rt.master('study', { stable: 'R', user: 'U', json: true }), '{"whole": true}');
  assert.deepEqual(cut.sent.map(p => p.max_tokens), [3000, 6000]);
  assert.deepEqual(cut.saved.jobs.map(j => j.ok), [false, true]);
  const twice = page({ replies: [{ content: 'a', finish: 'length' }, { content: 'ab', finish: 'length' }] });
  assert.equal(await twice.rt.master('study', { stable: 'R', user: 'U' }), 'ab', 'it is not asked for a third time');
  assert.equal(twice.sent.length, 2);
  const fault = page({ replies: [{ error: 'No credit' }] });
  await assert.rejects(fault.rt.master('page', { stable: 'R', user: 'U' }), /No credit/);
  assert.deepEqual(fault.saved.jobs.map(j => [j.kind, j.ok]), [['page', false]]);
});

test('the jobs run one at a time; the same job asked twice while it waits is one job', async () => {
  const { rt } = page();
  const order = [];
  let running = 0, most = 0;
  const work = (name, ms) => async () => { running++; most = Math.max(most, running); order.push(`${name} in`); await new Promise(r => setTimeout(r, ms)); order.push(`${name} out`); running--; return name; };
  const a = rt.job('a', work('a', 30));
  const again = rt.job('a', work('a again', 1));
  const b = rt.job('b', work('b', 1));
  assert.equal(a, again);
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
  assert.deepEqual(order, ['a in', 'a out', 'b in', 'b out']);
  assert.equal(most, 1);
  assert.equal(await rt.job('a', work('a later', 1)), 'a later', 'once done it can be asked again');
  await assert.rejects(rt.job('c', async () => { throw new Error('no'); }));
  assert.equal(rt.mayRetry('c'), false, 'a job that failed is not tried again at once');
  assert.equal(rt.mayRetry('a'), true);
  assert.equal(await rt.job('d', work('d', 1)), 'd', 'a fault does not stop the queue');
});

test('the conversation to read: the user\'s words, a line of each answer, nothing of what the app said', async () => {
  const long = 'Risposta molto lunga. '.repeat(40);
  const { rt } = page({
    mark: { conversationId: 'c1', sequence: 10 },
    messages: [
      message(9, 'user', 'Già letto.'),
      message(11, 'user', 'Mi chiamo Samu e lavoro a SynthOrg.'),
      message(12, 'assistant', long),
      message(13, 'user', '[Promemoria arrivato: «Dentista»]', { report: true }),
      message(14, 'assistant', 'Ehi, hai il dentista oggi.'),
      message(15, 'user', '(messaggio vocale)'),
      message(16, 'assistant', 'Non ho capito.'),
      message(17, 'user', '[Esito del compito affidato al Master: «x»]'),
      message(18, 'assistant', 'Il Master ha finito.'),
      message(19, 'user', 'Domani vado a Torino.'),
      message(20, 'assistant', 'Bello!'),
      message(21, 'assistant', 'A metà', { status: 'streaming' })
    ]
  });
  const stretch = await rt.unread();
  assert.deepEqual(stretch.text.split('\n'), [
    '[User] Mi chiamo Samu e lavoro a SynthOrg.',
    `[Assistant] ${long.replace(/\s+/g, ' ').slice(0, 160)}`,
    '[User] Domani vado a Torino.',
    '[Assistant] Bello!'
  ]);
  assert.equal(stretch.words, 11);
  assert.equal(stretch.last, 20);
  assert.equal(stretch.more, false);
  assert.ok(stretch.text.length < 330, 'the answers go as a line each');
});

test('a long conversation is read in pieces; one never read before starts from where it is', async () => {
  const messages = Array.from({ length: 10 }, (_, i) => message(i + 1, 'user', `Frase numero ${i + 1} ${'parola '.repeat(30)}`));
  const long = page({ mark: { conversationId: 'c1', sequence: 0 }, messages });
  const first = await long.rt.unread(700);
  assert.equal(first.more, true);
  assert.equal(first.last, 3);
  await long.rt.read(first.last);
  assert.equal((await long.rt.unread(700)).text.startsWith('[User] Frase numero 4 '), true);
  const fresh = page({ messages });
  assert.equal(await fresh.rt.unread(), null);
  assert.equal(JSON.parse(fresh.saved.settings.get('realtime_analyzed')).sequence, 10, 'what was said before is not read again');
  const other = page({ mark: { conversationId: 'gone', sequence: 500 }, messages });
  assert.equal((await other.rt.unread()).last, 10, 'a new conversation is read from its start');
});

test('the analysis: a few words wait for more and cost nothing; asked for by hand they are read', async () => {
  const messages = [message(11, 'user', 'Ciao, come va?'), message(12, 'assistant', 'Bene!')];
  const few = page({ mark: { conversationId: 'c1', sequence: 10 }, messages, replies: [{ content: '{"memories": {"add": []}}' }] });
  const waited = await few.rt.analyze();
  assert.equal(few.sent.length, 0);
  assert.equal(waited.waiting, 3);
  assert.equal(JSON.parse(few.saved.settings.get('realtime_analyzed')).sequence, 10, 'they stay to be read with the next ones');
  const byHand = await few.rt.analyze({ manual: true });
  assert.equal(few.sent.length, 1);
  assert.equal(byHand.read, 3);
  assert.equal(JSON.parse(few.saved.settings.get('realtime_analyzed')).sequence, 12);
  const none = page({ mark: { conversationId: 'c1', sequence: 10 }, messages: [message(11, 'user', '(messaggio vocale)'), message(12, 'assistant', 'Eh?')] });
  await none.rt.analyze();
  assert.equal(none.sent.length, 0);
  assert.equal(JSON.parse(none.saved.settings.get('realtime_analyzed')).sequence, 12, 'nothing of the user\'s in it: it is done with');
});

test('the analysis gives notes and proposals for the agenda: only days to come, only well formed', async () => {
  const tomorrow = new Date(Date.now() + 86400000);
  const start = `${dayStamp(tomorrow)}T18:30`;
  const { rt, sent, saved } = page({
    mark: { conversationId: 'c1', sequence: 0 },
    messages: [message(1, 'user', 'Domani alle sei e mezza ho la visita dal dentista, e ieri ero dal medico. Mi chiamo Samu, faccio lo sviluppatore.')],
    replies: [{ content: JSON.stringify({
      memories: { add: ['Si chiama Samu.'], update: [], remove: [] },
      dossier: [{ section: 'user_profile', content: 'Sviluppatore.' }, { section: 'unknown', content: 'Altro.' }],
      agenda: [
        { kind: 'reminder', title: 'Dentista', start, why: 'domani alle sei e mezza ho la visita' },
        { kind: 'reminder', title: 'Medico', start: '2020-01-01T10:00' },
        { kind: 'activity', title: 'Fine prima dell inizio', start, end: `${dayStamp(tomorrow)}T10:00` },
        { kind: 'reminder', title: 'Senza giorno', start: 'domani' },
        { kind: 'reminder', title: '', start }
      ]
    }) }]
  });
  const result = await rt.analyze();
  assert.equal(sent.length, 1);
  const asked = sent[0].messages[1].content;
  assert.match(asked, /^Now: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}, \w+\./);
  assert.match(asked, /Conversation:\n\[User\] Domani alle sei/);
  assert.deepEqual(saved.agenda.map(a => [a.kind, a.title, a.startAt, a.proposed, a.why]), [['reminder', 'Dentista', start, true, 'domani alle sei e mezza ho la visita']]);
  assert.deepEqual(rt.proposals.map(p => [p.section, p.content]), [['user_profile', 'Sviluppatore.'], ['general_notes', 'Altro.']]);
  assert.deepEqual([result.read, result.changed, result.failed], [21, 2, false]);
});

test('the pauses a user names are proposed once each, with their minutes, and wait for the user', async () => {
  const { rt, sent, saved } = page({
    mark: { conversationId: 'c1', sequence: 0 },
    messages: [message(1, 'user', 'Quando stacco mi piace farmi un caffè, oppure due passi sotto casa per un quarto d\'ora, mi rimette in sesto.')],
    replies: [{ content: JSON.stringify({ memories: { add: [] }, agenda: [], pauses: [
      { name: 'Due passi', minutes: 15, why: 'due passi sotto casa per un quarto d\'ora' },
      { name: 'un caffè', minutes: 10 }, { name: 'Stretching', minutes: 'tanti' }, { name: '' }, { name: 'Quarta' }
    ] }) }]
  });
  rt.likedPauses = [{ id: 'l0', name: 'Un caffè', minutes: 10, status: 'dismissed' }];
  const result = await rt.analyze();
  assert.match(textOf(sent[0].messages[0].content), /4\. THE PAUSES/);
  assert.match(sent[0].messages[1].content, /Pauses already in the list: Un caffè/);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.pauses)), [
    { name: 'Due passi', minutes: 15, status: 'proposed', why: 'due passi sotto casa per un quarto d\'ora', source: 'model' },
    { name: 'Stretching', minutes: 10, status: 'proposed', why: '', source: 'model' }
  ], 'what is in the list is not proposed again; three at most are read');
  assert.equal(result.changed, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(rt.likedPauses.map(p => p.name))), ['Un caffè', 'Due passi', 'Stretching']);
});

test('a fault in the analysis leaves the words to be read again, and is not tried again at once', async () => {
  const { rt, sent, saved } = page({
    mark: { conversationId: 'c1', sequence: 0 },
    messages: [message(1, 'user', 'Una frase abbastanza lunga da essere letta subito dal Master, con dodici parole e più.')],
    replies: [{ error: 'Provider down' }]
  });
  const result = await rt.analyze();
  assert.deepEqual([result.failed, result.error], [true, 'Provider down']);
  assert.equal(JSON.parse(saved.settings.get('realtime_analyzed')).sequence, 0);
  await rt.analyze();
  assert.equal(sent.length, 1, 'by itself it waits before trying again');
  await rt.analyze({ manual: true });
  assert.equal(sent.length, 2, 'by hand it is tried at once');
});

test('a page of the diary reads the conversation not read yet in the same request', async () => {
  const { rt, sent, saved } = page({
    mark: { conversationId: 'c1', sequence: 4 },
    messages: [message(5, 'user', 'Giovedì prossimo devo consegnare il progetto.'), message(6, 'assistant', 'Va bene.')],
    replies: [{ content: 'Oggi ho lavorato.\n\nPoi ho corso.\n=====\n{"data": {"energy": 4}, "memories": {"add": ["Corre."]}, "habits": {"marks": []}, "goals": {"steps_done": []}, "agenda": []}' }]
  });
  saved.diary = [{ id: 'e1', day: '2026-09-27', raw_text: 'Ho lavorato e poi ho corso.' }];
  const written = await rt.writePage('2026-09-27');
  assert.equal(written, 'Oggi ho lavorato.\n\nPoi ho corso.');
  assert.equal(sent.length, 1);
  const asked = sent[0].messages[1].content;
  assert.ok(asked.indexOf('Account:\nHo lavorato e poi ho corso.') < asked.indexOf('Conversation with the assistant since the last reading:\n[User] Giovedì prossimo'));
  assert.equal(sent[0].max_tokens, 4000);
  assert.equal(sent[0].response_format, undefined, 'a page is prose before it is JSON');
  assert.match(textOf(sent[0].messages[0].content), /Seven things are asked of you[\s\S]*\[pagePrompt\][\s\S]*\[memoryPrompt\][\s\S]*=====/);
  assert.deepEqual([saved.diary[0].pageText, saved.diary[0].extracted], ['Oggi ho lavorato.\n\nPoi ho corso.', { energy: 4 }]);
  assert.match(asked, /Pauses already in the list: none/);
  assert.equal(JSON.parse(saved.settings.get('realtime_analyzed')).sequence, 6, 'the conversation is read: no request of its own');
  await rt.analyze();
  assert.equal(sent.length, 1);
});

test('the instructions of a page are the same whatever the day: only what follows them changes', async () => {
  const first = page({ mark: { conversationId: 'c1', sequence: 0 }, replies: [{ content: 'Pagina.\n=====\n{"data": {}}' }] });
  first.saved.diary = [{ id: 'e1', day: '2026-09-26', raw_text: 'Un racconto.' }];
  await first.rt.writePage('2026-09-26');
  const second = page({ mark: { conversationId: 'c1', sequence: 0 }, replies: [{ content: 'Pagina.\n=====\n{"data": {}}' }] });
  second.rt.notes = [{ id: 'm1', content: 'Una nota.' }];
  second.saved.diary = [{ id: 'e2', day: '2026-09-27', raw_text: 'Un altro racconto.' }];
  await second.rt.writePage('2026-09-27');
  assert.equal(textOf(first.sent[0].messages[0].content), textOf(second.sent[0].messages[0].content));
  assert.notEqual(first.sent[0].messages[1].content, second.sent[0].messages[1].content);
});

test('a page that cannot be written says why and leaves the conversation unread', async () => {
  const { rt, saved } = page({ mark: { conversationId: 'c1', sequence: 0 }, messages: [message(1, 'user', 'Qualcosa da leggere.')], replies: [{ error: 'Timeout' }] });
  saved.diary = [{ id: 'e1', day: '2026-09-27', raw_text: 'Racconto.' }];
  assert.equal(await rt.writePage('2026-09-27'), null);
  assert.equal(rt.pageErrors.get('2026-09-27'), 'Timeout');
  assert.equal(rt.writing.size, 0);
  assert.equal(JSON.parse(saved.settings.get('realtime_analyzed')).sequence, 0);
});

test('the reply of a page is read with or without its mark, and without its JSON', () => {
  const { jobs } = page();
  assert.deepEqual(JSON.parse(JSON.stringify(jobs.parsePage('Prima.\n\nSeconda.\n=====\n```json\n{"data": {"energy": 3}}\n```'))), { page: 'Prima.\n\nSeconda.', json: { data: { energy: 3 } } });
  assert.deepEqual(JSON.parse(JSON.stringify(jobs.parsePage('Prima riga.\n{"data": {"energy": 3}, "memories": {}}'))), { page: 'Prima riga.', json: { data: { energy: 3 }, memories: {} } });
  assert.deepEqual(JSON.parse(JSON.stringify(jobs.parsePage('# Diario\n\nSolo la pagina, con {una graffa}.'))), { page: 'Solo la pagina, con {una graffa}.', json: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(jobs.parsePage('Pagina.\n=====\nnon è JSON'))), { page: 'Pagina.', json: {} });
});

test('a habit followed from now on: its words and the days already told, in one request', async () => {
  const { rt, sent, saved } = page({ replies: [{ content: JSON.stringify({
    words: { k1: ['corsa', 'correre', 'corso', 'jogging'], k2: ['esame', 'statistica', 'studiare'], k9: ['nessuno'] },
    days: { '2026-09-20': { k1: true }, '2026-09-21': { k1: false, k2: true }, '2026-09-22': { k1: 'forse' }, '2026-01-01': { k1: true } }
  }) }] });
  rt.habits = [
    { id: 'h-run', name: 'Corsa', sign: 'positive', status: 'tracked', notes: 'Al parco.', keywords: null, read_at: null },
    { id: 'h-old', name: 'Lettura', sign: 'positive', status: 'tracked', notes: '', keywords: '["leggere"]', read_at: 'before' },
    { id: 'h-no', name: 'Fumo', sign: 'negative', status: 'dismissed', notes: '', keywords: null, read_at: null }
  ];
  rt.goals = [{ id: 'g-exam', name: 'Esame di statistica', status: 'open', notes: '', keywords: null }, { id: 'g-done', name: 'Trasloco', status: 'done', keywords: null }];
  saved.diary = [
    { id: 'e3', day: '2026-09-22', raw_text: 'Niente di che.' },
    { id: 'e1', day: '2026-09-20', raw_text: 'Sono andato a correre.' },
    { id: 'e2', day: '2026-09-21', raw_text: 'Oggi non ho corso.' },
    { id: 'e0', day: '2026-09-19', raw_text: 'Già segnato.' }
  ];
  saved.marks = [{ habit_id: 'h-run', day: '2026-09-19', done: 1 }];
  const result = await rt.study();
  assert.equal(sent.length, 1, 'all of it in one request');
  const asked = sent[0].messages[1].content;
  assert.match(asked, /Words wanted:\n\[k1\] habit: Corsa — Al parco\.\n\[k2\] goal: Esame di statistica/);
  assert.match(asked, /Habits to read:\n\[k1\] habit: Corsa/);
  assert.deepEqual([...asked.matchAll(/^### (\S+)$/gm)].map(m => m[1]), ['2026-09-20', '2026-09-21', '2026-09-22'], 'only the days nothing is known about, in order');
  assert.doesNotMatch(asked, /Lettura|Fumo|Trasloco/);
  assert.deepEqual(saved.marks.slice(1), [{ habit_id: 'h-run', day: '2026-09-20', done: true }, { habit_id: 'h-run', day: '2026-09-21', done: false }],
    'a goal is not marked, a guess is not a mark, a day not given is not taken');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.habits)), [{ id: 'h-run', keywords: ['corsa', 'correre', 'corso', 'jogging'] }, { id: 'h-run', readAt: true }]);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.goals)), [{ id: 'g-exam', keywords: ['esame', 'statistica', 'studiare'] }]);
  assert.deepEqual([result.marked, result.days], [2, 3]);
  assert.equal(await rt.study(), null, 'nothing is left to study');
  assert.equal(sent.length, 1);
});

test('many days are read in a few requests; an item given no words keeps its name and is not asked again', async () => {
  const { rt, sent, saved } = page({ replies: [{ content: '{"words": {}, "days": {}}' }, { content: '{"words": {}, "days": {"2026-09-05": {"k1": true}}}' }] });
  rt.habits = [{ id: 'h1', name: 'Yoga', sign: 'positive', status: 'tracked', notes: '', keywords: null, read_at: null }];
  saved.diary = Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, day: `2026-09-0${i + 1}`, raw_text: 'x'.repeat(5000) }));
  const result = await rt.study();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(p => [...p.messages[1].content.matchAll(/^### /gm)].length), [4, 2]);
  assert.match(sent[0].messages[1].content, /Words wanted:\n\[k1\] habit: Yoga/);
  assert.match(sent[1].messages[1].content, /Words wanted:\n\(none\)/);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.habits)), [{ id: 'h1', keywords: ['Yoga'] }, { id: 'h1', readAt: true }]);
  assert.equal(result.marked, 1);
});

test('the words that name a habit decide whether it is asked about', () => {
  const account = 'Stamattina sono andato a correre al parco, poi ho letto un po\'. Niente sigarette.';
  assert.equal(W.named('Corsa', account), false, 'by its name alone the verb is not found');
  assert.equal(W.named('Corsa', account, ['corsa', 'correre', 'corso', 'jogging']), true);
  assert.equal(W.named('Lettura', account, ['leggere', 'letto', 'libro']), true);
  assert.equal(W.named('Fumo', account, ['fumare', 'fumato', 'sigaretta', 'sigarette']), true);
  assert.equal(W.named('Meditazione', account, ['meditare', 'meditato', 'mindfulness']), false);
  assert.equal(W.named('Camminata', 'Ho fatto due passi in centro.', ['camminare', 'due passi']), true, 'words together are looked for as they are');
  assert.equal(W.named('Tè', 'Una tazza di tè verde.', ['tè']), false, 'a word too short to tell is not a sign');
  assert.deepEqual(W.keywordsOf({ keywords: '["a","b"]' }), ['a', 'b']);
  assert.deepEqual(W.keywordsOf({ keywords: null }), []);
  assert.deepEqual(W.keywordsOf({ keywords: 'not json' }), []);
});

test('the week by hours: the part of an item that falls on a day, and what overlaps side by side', () => {
  const trip = { start_at: '2026-10-01T08:00', end_at: '2026-10-03T20:00' };
  assert.deepEqual(W.partOfDay(trip, '2026-10-01'), { from: 480, to: 1440 });
  assert.deepEqual(W.partOfDay(trip, '2026-10-02'), { allDay: true });
  assert.deepEqual(W.partOfDay(trip, '2026-10-03'), { from: 0, to: 1200 });
  assert.equal(W.partOfDay(trip, '2026-10-04'), null);
  assert.deepEqual(W.partOfDay({ start_at: '2026-09-27T15:30', end_at: null }, '2026-09-27'), { from: 930, to: 960 }, 'a reminder is given half an hour');
  assert.deepEqual(W.partOfDay({ start_at: '2026-09-27T23:50', end_at: null }, '2026-09-27'), { from: 1430, to: 1440 });
  assert.deepEqual(W.partOfDay({ start_at: '2026-09-27T10:00', end_at: '2026-09-27T10:05' }, '2026-09-27'), { from: 600, to: 630 }, 'a short activity can still be read');
  const placed = W.layoutDay([
    { id: 'gym', from: 1080, to: 1170 }, { id: 'call', from: 1100, to: 1130 }, { id: 'dinner', from: 1140, to: 1200 },
    { id: 'morning', from: 540, to: 570 }, { id: 'after', from: 1200, to: 1230 }
  ]);
  const by = Object.fromEntries(placed.map(e => [e.id, [e.column, e.columns]]));
  assert.deepEqual(by, { morning: [0, 1], gym: [0, 2], call: [1, 2], dinner: [1, 2], after: [0, 1] });
});

test('what a model proposes for the agenda waits for the user: it does not ring and is not in the agenda', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const p = store.personal();
  const proposed = p.saveAgendaItem({ kind: 'reminder', title: 'Dentista', startAt: '2026-09-29T18:30', proposed: true, why: 'domani ho il dentista', source: 'realtime' });
  assert.deepEqual([proposed.proposed, proposed.why], [1, 'domani ho il dentista']);
  assert.equal(p.saveAgendaItem({ kind: 'reminder', title: 'dentista', startAt: '2026-09-29T09:00', proposed: true }).id, proposed.id, 'the same thing on the same day is proposed once');
  assert.equal(p.agenda({ from: '2026-09-01T00:00', to: '2026-10-31T00:00' }).length, 0);
  assert.equal(p.dueReminders('2026-12-31T00:00').length, 0);
  assert.deepEqual(p.agendaProposals().map(a => a.title), ['Dentista']);
  const accepted = p.saveAgendaItem({ proposed: false }, proposed.id);
  assert.equal(accepted.proposed, 0);
  assert.deepEqual(p.agenda({ from: '2026-09-01T00:00', to: '2026-10-31T00:00' }).map(a => a.title), ['Dentista']);
  assert.equal(p.agendaProposals().length, 0);
  assert.equal(p.saveAgendaItem({ kind: 'reminder', title: 'Dentista', startAt: '2026-09-29T20:00', proposed: true }).id, proposed.id, 'what is in the agenda already is not proposed');
  assert.deepEqual(p.dueReminders('2026-12-31T00:00').map(a => a.title), ['Dentista']);
});

test('the past days are added where nothing is known, never in place of what is there', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const p = store.personal();
  const run = p.saveHabit({ name: 'Corsa', sign: 'positive' });
  p.markHabit({ habitId: run.id, day: '2026-09-20', done: false });
  p.setDiaryMarks({ day: '2026-09-21', marks: [{ habitId: run.id, done: true }] });
  const result = p.addDiaryMarks({ marks: [
    { habitId: run.id, day: '2026-09-20', done: true }, { habitId: run.id, day: '2026-09-21', done: false },
    { habitId: run.id, day: '2026-09-22', done: true }, { habitId: 'nobody', day: '2026-09-22', done: true },
    { habitId: run.id, day: 'ieri', done: true }, { habitId: run.id, day: '2026-09-23', done: 'sì' }
  ] });
  assert.equal(result.added, 1);
  assert.deepEqual(p.habitDays().map(m => [m.day, m.done, m.source]), [['2026-09-20', 0, 'user'], ['2026-09-21', 1, 'diary'], ['2026-09-22', 1, 'diary']]);
});

test('the words of a habit and the day its past was read go when it is given another name', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const p = store.personal();
  const habit = p.saveHabit({ name: 'Corsa', sign: 'positive' });
  assert.deepEqual([habit.keywords, habit.read_at], [null, null]);
  const studied = p.saveHabit({ keywords: ['Corsa', 'correre', 'corsa', 'x', ' jogging '], readAt: true }, habit.id);
  assert.equal(studied.keywords, '["corsa","correre","jogging"]');
  assert.match(studied.read_at, /^\d{4}-/);
  assert.equal(p.saveHabit({ sign: 'negative', status: 'dismissed' }, habit.id).keywords, studied.keywords);
  const renamed = p.saveHabit({ name: 'Camminata' }, habit.id);
  assert.deepEqual([renamed.keywords, renamed.read_at], [null, null]);
  assert.equal(p.saveHabit({ keywords: [] }, habit.id).keywords, '[]', 'looked for, none found: not looked for again');
  const goal = p.saveGoal({ name: 'Esame' });
  assert.equal(p.saveGoal({ keywords: ['esame', 'studiare'] }, goal.id).keywords, '["esame","studiare"]');
  assert.equal(p.saveGoal({ dueDay: '2026-10-10' }, goal.id).keywords, '["esame","studiare"]');
  assert.equal(p.saveGoal({ name: 'Concorso' }, goal.id).keywords, null);
});

test('what the jobs cost is written down and added up by kind', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const p = store.personal();
  p.recordJob({ kind: 'page', model: 'vendor/master', ok: true, promptTokens: 2000, completionTokens: 600, cachedTokens: 1500, cost: 0.0012, ms: 9000 });
  p.recordJob({ kind: 'page', model: 'vendor/master', ok: false, promptTokens: 2100, completionTokens: 0, ms: 3000 });
  p.recordJob({ kind: 'analysis', model: 'vendor/master', promptTokens: 400.4, completionTokens: 50, cost: 0.0002, ms: 2000 });
  assert.throws(() => p.recordJob({ kind: '' }), /Lavoro non valido/);
  const { kinds, days } = p.jobs({});
  assert.deepEqual(kinds.map(k => [k.kind, k.runs, k.done, k.prompt_tokens, k.completion_tokens, k.cached_tokens, k.ms]), [['page', 2, 1, 4100, 600, 1500, 6000], ['analysis', 1, 1, 400, 50, 0, 2000]]);
  assert.ok(Math.abs(kinds[0].cost - 0.0012) < 1e-9);
  assert.deepEqual(days.map(d => [d.runs, d.prompt_tokens]), [[3, 4500]]);
  assert.equal(p.jobs({ from: '2000-01-01', to: '2000-12-31' }).kinds.length, 0);
});


test('the notes past their bound are rewritten as fewer; the old ones are put away, not deleted', async () => {
  const many = Array.from({ length: 41 }, (_, i) => ({ id: 'm' + i, content: 'Nota ' + i + ' su di te.', origin: 'conversation', enabled: 1 }));
  const { rt, sent, saved } = page({ replies: [{ content: JSON.stringify({ notes: ['Si chiama Samu e lavora a SynthOrg.', 'Corre tre volte a settimana.', 'Ha una sorella, Giulia.', ''] }) }] });
  rt.notes = many.slice(0, 40);
  assert.equal(await rt.tidy(), null, 'forty notes are within the bound');
  assert.equal(sent.length, 0);
  rt.notes = many;
  const result = await rt.tidy();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { before: 41, after: 3 });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].messages[1].content.startsWith('Notes:\n[n1] Nota 0 su di te.\n[n2] Nota 1 su di te.'));
  assert.ok(textOf(sent[0].messages[0].content).includes('at most 25 notes'));
  const added = saved.notes.filter(n => !n.id);
  const away = saved.notes.filter(n => n.id);
  assert.deepEqual(added.map(n => [n.content, n.origin, n.pinned, n.enabled]), [
    ['Si chiama Samu e lavora a SynthOrg.', 'tidy', true, undefined], ['Corre tre volte a settimana.', 'tidy', true, undefined], ['Ha una sorella, Giulia.', 'tidy', true, undefined]
  ]);
  assert.equal(away.length, 41);
  assert.ok(away.every(n => n.enabled === false && n.pinned === false && n.content.startsWith('Nota ')));
});

test('a tidying up that gives too little, or no less, changes nothing and is not tried again at once', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: 'm' + i, content: 'Nota ' + i, enabled: 1 }));
  const few = page({ replies: [{ content: '{"notes": ["Una sola."]}' }] });
  few.rt.notes = many;
  assert.equal(await few.rt.tidy(), null);
  assert.equal(few.saved.notes.length, 0);
  const same = page({ replies: [{ content: JSON.stringify({ notes: many.map(n => n.content) }) }] });
  same.rt.notes = many;
  assert.equal(await same.rt.tidy(), null);
  assert.equal(same.saved.notes.length, 0);
  assert.equal(await same.rt.tidy(), null);
  assert.equal(same.sent.length, 1);
});

test('a habit followed from now on is read over the last ninety days, not over all the diary', async () => {
  const { rt, sent, saved } = page({ replies: [{ content: '{"words": {"k1": ["yoga"]}, "days": {}}' }] });
  rt.habits = [{ id: 'h1', name: 'Yoga', sign: 'positive', status: 'tracked', notes: '', keywords: null, read_at: null }];
  const recent = dayStamp(new Date(Date.now() - 10 * 86400000));
  const old = dayStamp(new Date(Date.now() - 200 * 86400000));
  saved.diary = [{ id: 'e1', day: recent, raw_text: 'Ho fatto yoga.' }, { id: 'e2', day: old, raw_text: 'Un anno fa, yoga.' }];
  await rt.study();
  const [read] = saved.reads;
  assert.equal(read.to, dayStamp(new Date()));
  assert.equal(read.from, dayStamp(new Date(Date.now() - 89 * 86400000)));
  assert.deepEqual([...sent[0].messages[1].content.matchAll(/^### (\S+)$/gm)].map(m => m[1]), [recent]);
});

test('a conversation without end is read from the last reading on, never whole', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const chat = store.realtime().conversation;
  for (let i = 0; i < 6; i++) store.saveMessage(chat.id, { role: i % 2 ? 'assistant' : 'user', content: `messaggio ${i}` });
  const all = store.messages(chat.id);
  assert.deepEqual(store.messagesAfter(chat.id, all[3].sequence).map(m => m.content), ['messaggio 4', 'messaggio 5']);
  assert.deepEqual(store.messagesAfter(chat.id, 0, 2).map(m => m.content), ['messaggio 0', 'messaggio 1']);
  assert.equal(store.lastSequence(chat.id), all[5].sequence);
  assert.equal(store.messagesAfter(chat.id, all[5].sequence).length, 0);
  assert.equal(store.messagesAfter(chat.id, 'x').length, 6);
});

test('the character\'s conversation has a cap of its own, which the user can change and which stays', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const chat = store.realtime().conversation;
  assert.deepEqual(JSON.parse(chat.memory_settings_json), { cap: 6000 });
  assert.equal(store.memoryTree().settings(chat.id).cap, 6000);
  assert.equal(store.memoryTree().settings(store.createConversation('Una chat').id).cap, 32000, 'the chats keep theirs');
  store.updateConversation(chat.id, { memorySettings: { cap: 12000 } });
  assert.equal(JSON.parse(store.realtime().conversation.memory_settings_json).cap, 12000);
});

test('past the cap the exchange is given the summaries and the last turns, read without the rest', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const chat = store.realtime().conversation;
  store.updateConversation(chat.id, { memorySettings: { cap: 4000, keepRaw: 2 } });
  const tree = store.memoryTree();
  const long = 'parola '.repeat(120);
  for (let i = 0; i < 30; i++) {
    const user = store.saveMessage(chat.id, { role: 'user', content: `Domanda ${i}. ${long}` });
    const answer = store.saveMessage(chat.id, { role: 'assistant', content: `Risposta ${i}. ${long}` });
    tree.addNode(chat.id, { level: 1, userMessageId: user.id, assistantMessageId: answer.id, content: `Riassunto del turno ${i}.` });
  }
  const first = store.context(chat.id, 'e adesso?', { includeGlobal: false, includeChat: true });
  assert.equal(first.memoryView.active, true);
  assert.equal(first.messages[0].role, 'system');
  assert.match(first.messages[0].content, /Riassunto del turno 0\./);
  assert.deepEqual(first.messages.slice(1).map(m => m.content.slice(0, 12)), ['Domanda 28. ', 'Risposta 28.', 'Domanda 29. ', 'Risposta 29.']);
  // Asked again, with the view made: the same answer, from the messages after the cut alone.
  let whole = 0;
  const messages = store.messages.bind(store);
  store.messages = (id) => { whole++; return messages(id); };
  const again = store.context(chat.id, 'e adesso?', { includeGlobal: false, includeChat: true });
  assert.deepEqual(again.messages, first.messages);
  assert.equal(whole, 0, 'the whole conversation is not read');
  // A new exchange is there at the next request.
  store.saveMessage(chat.id, { role: 'user', content: 'Una domanda nuova.' });
  store.saveMessage(chat.id, { role: 'assistant', content: 'Una risposta nuova.' });
  assert.deepEqual(store.context(chat.id, 'x', { includeChat: true }).messages.slice(-2).map(m => m.content), ['Una domanda nuova.', 'Una risposta nuova.']);
  // A view whose summaries are gone is forgotten, and the conversation is read whole again.
  store.db.prepare('DELETE FROM memory_nodes WHERE conversation_id=?').run(chat.id);
  const rebuilt = store.context(chat.id, 'x', { includeChat: true });
  assert.ok(whole > 0);
  assert.equal(rebuilt.messages.filter(m => m.role !== 'system').slice(-1)[0].content, 'Una risposta nuova.');
});

test('the turns are kept in mind while the messages stay as they are, and read again when one changes', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const chat = store.createConversation('Chat');
  const tree = store.memoryTree();
  const user = store.saveMessage(chat.id, { role: 'user', content: '(messaggio vocale)' });
  store.saveMessage(chat.id, { role: 'assistant', content: 'Ciao!' });
  let reads = 0;
  const read = tree.readTurns.bind(tree);
  tree.readTurns = (...args) => { reads++; return read(...args); };
  assert.equal(tree.turns(chat.id).length, 1);
  assert.equal(tree.turns(chat.id)[0].user.content, '(messaggio vocale)');
  assert.equal(reads, 1);
  // the words of the recording arrive after the answer: the same message, written again
  store.saveMessage(chat.id, { id: user.id, role: 'user', content: 'Ciao, come stai?' });
  assert.equal(tree.turns(chat.id)[0].user.content, 'Ciao, come stai?');
  store.saveMessage(chat.id, { role: 'user', content: 'Seconda.' });
  assert.equal(tree.turns(chat.id).length, 1, 'a question without its answer is not a turn yet');
  store.saveMessage(chat.id, { role: 'assistant', content: 'Risposta.' });
  assert.equal(tree.turns(chat.id).length, 2);
  const before = reads;
  tree.turns(chat.id); tree.pending(chat.id);
  assert.equal(reads, before);
  store.truncateMessages(chat.id, user.id);
  assert.equal(tree.turns(chat.id).length, 0);
});

test('the diary is read as light as what is asked of it', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const p = store.personal();
  const e = p.saveDiaryEntry({ day: '2026-09-27', rawText: 'Un racconto lungo.' });
  p.saveDiaryEntry({ pageText: 'Una pagina.', extracted: { energy: 4 } }, e.id);
  p.saveDiaryEntry({ day: '2026-09-26', rawText: 'Un altro.' });
  assert.deepEqual(p.diary({ fields: 'days' }).map(x => Object.keys(x)), [['id', 'day'], ['id', 'day']]);
  assert.deepEqual(p.diary({ fields: 'data' }).map(x => [x.day, x.extracted_json, x.raw_text]), [['2026-09-27', '{"energy":4}', undefined], ['2026-09-26', null, undefined]]);
  assert.equal(p.diary({})[0].raw_text, 'Un racconto lungo.');
  assert.deepEqual({ ...p.diaryCount() }, { days: 2 });
});

test('the turns brought up to date from the first message changed are the turns read whole', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const chat = store.createConversation('Chat');
  const other = store.createConversation('Altra');
  const tree = store.memoryTree();
  const whole = () => JSON.parse(JSON.stringify(tree.readTurns(chat.id)));
  const same = (what) => assert.deepEqual(JSON.parse(JSON.stringify(tree.turns(chat.id))), whole(), what);
  // a made-up sequence of what happens to a conversation, the same at every run
  let seed = 7;
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const ids = [];
  same('empty');
  for (let step = 0; step < 400; step++) {
    const what = random(10);
    if (what < 5 || !ids.length) {
      const role = random(3) ? (ids.length % 2 ? 'assistant' : 'user') : (random(2) ? 'user' : 'assistant');
      const status = random(8) ? 'complete' : 'streaming';
      const saved = store.saveMessage(chat.id, { role, content: `messaggio ${step}`, status, ...(random(12) ? {} : { demo: true }) });
      ids.push({ id: saved.id, role });
    } else if (what < 8) {
      const target = ids[random(ids.length)];
      store.saveMessage(chat.id, { id: target.id, role: target.role, content: `riscritto ${step}`, status: random(6) ? 'complete' : 'error' });
    } else if (what === 8) {
      store.saveMessage(other.id, { role: 'user', content: 'altrove' });
    } else if (ids.length > 6 && !random(4)) {
      const at = ids.length - 1 - random(5);
      store.truncateMessages(chat.id, ids[at].id);
      ids.length = at;
    }
    if (random(3)) same(`step ${step}`);
  }
  same('the end');
  store.clearMessages(chat.id);
  same('cleared');
  // changed by other means: nothing told of it, and still seen
  store.saveMessage(chat.id, { role: 'user', content: 'uno' });
  const answer = store.saveMessage(chat.id, { role: 'assistant', content: 'due' });
  same('two');
  store.db.prepare('DELETE FROM messages WHERE id=?').run(answer.id);
  same('deleted by hand');
});
