'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/database');

function setup(t) { const store = new Store(':memory:'); t.after(() => store.close()); return store; }

test('the diary keeps one entry per day: a new account of the day is added to it', t => {
  const diary = setup(t).personal();
  const first = diary.saveDiaryEntry({ day: '2026-09-27', rawText: 'Stamattina ho lavorato al progetto.' });
  const second = diary.saveDiaryEntry({ day: '2026-09-27', rawText: 'Domanda: Con chi hai passato del tempo?\nCon Marco.' });
  assert.equal(second.id, first.id);
  assert.equal(second.raw_text, 'Stamattina ho lavorato al progetto.\n\nDomanda: Con chi hai passato del tempo?\nCon Marco.');
  diary.saveDiaryEntry({ day: '2026-09-26', rawText: 'Ieri riposo.' });
  assert.deepEqual(diary.diary().map(e => e.day), ['2026-09-27', '2026-09-26']);
});

test('page and data are saved beside the account and survive a new account of the day', t => {
  const diary = setup(t).personal();
  const entry = diary.saveDiaryEntry({ day: '2026-09-27', rawText: 'Racconto.' });
  const written = diary.saveDiaryEntry({ pageText: 'Oggi ho lavorato.\n\nPoi ho riposato.', extracted: { energy: 4 } }, entry.id);
  assert.equal(written.page_text, 'Oggi ho lavorato.\n\nPoi ho riposato.');
  assert.equal(written.raw_text, 'Racconto.');
  assert.deepEqual(JSON.parse(written.extracted_json), { energy: 4 });
  const added = diary.saveDiaryEntry({ day: '2026-09-27', rawText: 'Un altro pezzo.' });
  assert.equal(added.page_text, written.page_text);
  assert.deepEqual(JSON.parse(added.extracted_json), { energy: 4 });
  assert.equal(diary.saveDiaryEntry({ extracted: null }, entry.id).extracted_json, null);
  assert.equal(diary.saveDiaryEntry({ pageText: '' }, entry.id).page_text, null);
});

test('an entry cannot be moved onto a day that has one', t => {
  const diary = setup(t).personal();
  const a = diary.saveDiaryEntry({ day: '2026-09-26', rawText: 'A' });
  diary.saveDiaryEntry({ day: '2026-09-27', rawText: 'B' });
  assert.throws(() => diary.saveDiaryEntry({ day: '2026-09-27' }, a.id), /già una pagina/);
  assert.throws(() => diary.saveDiaryEntry({ day: '27/09/2026', rawText: 'C' }), /Giorno non valido/);
  assert.throws(() => diary.saveDiaryEntry({ day: '2026-09-28', rawText: '  ' }), /Racconto non valido/);
});

test('entries of the same day made before the rule are joined in the order they were told', t => {
  const store = setup(t);
  store.personal();
  store.db.exec('DROP INDEX diary_one_per_day');
  const insert = store.db.prepare('INSERT INTO diary_entries(id,day,raw_text,extracted_json,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  insert.run('b', '2026-09-25', 'secondo', '{"energy":2}', 'realtime', '2026-09-25T20:00:00.000Z', '2026-09-25T20:00:00.000Z');
  insert.run('a', '2026-09-25', 'primo', '{"energy":5}', 'realtime', '2026-09-25T09:00:00.000Z', '2026-09-25T09:00:00.000Z');
  insert.run('c', '2026-09-24', 'solo', '{"energy":3}', 'realtime', '2026-09-24T09:00:00.000Z', '2026-09-24T09:00:00.000Z');
  store._personal = null;
  const rows = store.personal().diary();
  assert.deepEqual(rows.map(e => [e.id, e.raw_text, e.extracted_json]), [
    ['a', 'primo\n\nsecondo', null],
    ['c', 'solo', '{"energy":3}']
  ]);
});

test('a note keeps where it came from until it is written again', t => {
  const store = setup(t);
  const chat = store.realtime().conversation;
  const base = { scope: 'conversation', conversationId: chat.id, section: 'about_user', pinned: true };
  const note = store.saveMemory({ ...base, content: 'Lavora a SynthOrg.', origin: 'diary:2026-09-27' });
  assert.equal(note.origin, 'diary:2026-09-27');
  assert.equal(store.saveMemory({ ...base, content: 'Lavora a SynthOrg, di sera.' }, note.id).origin, 'diary:2026-09-27');
  assert.equal(store.saveMemory({ ...base, content: 'Lavora a SynthOrg.', origin: 'user' }, note.id).origin, 'user');
  assert.equal(store.saveMemory({ content: 'Senza origine', scope: 'global' }).origin, null);
});

test('what the app tells the character is marked, so it is not read as the user\'s words', t => {
  const store = setup(t);
  const chat = store.realtime().conversation;
  store.saveMessage(chat.id, { role: 'user', content: '[Promemoria arrivato: «x»]', report: true });
  store.saveMessage(chat.id, { role: 'user', content: 'Mi chiamo Samu.' });
  assert.deepEqual(store.messages(chat.id).map(m => Boolean(m.report)), [true, false]);
});
