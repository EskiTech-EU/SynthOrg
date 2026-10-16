'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/database');
const { changesOf } = require('../server/replica');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** A computer and a phone, each with its own archive. */
function pair(t) {
  const computer = new Store(':memory:', { wins: true });
  const phone = new Store(':memory:', { wins: false });
  t.after(() => { computer.close(); phone.close(); });
  return { computer, phone };
}

/** One exchange started by the phone, until neither side has more: what each wrote of the other's. */
function exchange(computer, phone) {
  const written = { computer: [], phone: [] };
  for (let turn = 0; turn < 50; turn += 1) {
    const offer = phone.replica().offer('computer');
    const answer = computer.replica().receive('phone-1', offer);
    written.computer.push(...answer.applied);
    const took = phone.replica().answered('computer', answer);
    written.phone.push(...took.applied);
    if (took.reset) continue;
    if (!offer.more && !answer.more && !phone.replica().pending('computer')) return written;
  }
  throw new Error('the exchange never ended');
}

const dump = (store, table, order = 'rowid') => store.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();

test('the first exchange copies the archive, the next ones only what changed', t => {
  const { computer, phone } = pair(t);
  computer.setSetting('app_locale', 'it');
  computer.setSetting('openrouter_api_key', 'sk-or-secret');
  const chat = computer.createConversation('Lavoro');
  computer.saveMessage(chat.id, { id: 'm1', role: 'user', content: 'ciao' });
  computer.saveMessage(chat.id, { id: 'm2', role: 'assistant', content: 'eccomi' });
  computer.personal().saveAgendaItem({ kind: 'reminder', title: 'Dentista', startAt: '2026-10-02T09:00' });

  const first = exchange(computer, phone);
  assert.equal(first.computer.length, 0);
  assert.deepEqual(dump(phone, 'messages', 'sequence'), dump(computer, 'messages', 'sequence'));
  assert.deepEqual(dump(phone, 'conversations', 'id'), dump(computer, 'conversations', 'id'));
  assert.deepEqual(dump(phone, 'agenda_items', 'id'), dump(computer, 'agenda_items', 'id'));
  assert.equal(phone.getSetting('app_locale'), 'it');
  assert.equal(phone.getSetting('openrouter_api_key'), null, 'the key stays on the computer');

  const again = exchange(computer, phone);
  assert.equal(again.phone.length + again.computer.length, 0, 'nothing new, nothing sent');

  computer.setSetting('app_locale', 'en');
  const next = exchange(computer, phone);
  assert.deepEqual(next.phone.map(change => [change.t, change.k[0]]), [['settings', 'app_locale']]);
  assert.equal(phone.getSetting('app_locale'), 'en');
});

test('what is done on the phone is written there at once and reaches the computer as it was written', t => {
  const { computer, phone } = pair(t);
  exchange(computer, phone);
  const item = phone.personal().saveAgendaItem({ kind: 'activity', title: 'Palestra', startAt: '2026-10-03T18:00', endAt: '2026-10-03T19:00' });
  const habit = phone.personal().saveHabit({ name: 'Camminare', sign: 'positive' });
  phone.personal().markHabit({ habitId: habit.id, day: '2026-10-01', done: true });
  // A chat the phone opens in the computer's world: born there, so it reaches the computer.
  const chat = phone.createConversation('Dal telefono', null, 'peer');
  phone.saveMessage(chat.id, { id: 'p1', role: 'user', content: 'una domanda' });
  // There already, before anything is exchanged.
  assert.equal(phone.personal().agenda({}).length, 1);

  const written = exchange(computer, phone);
  assert.deepEqual(computer.personal().agendaItem(item.id), item);
  assert.deepEqual(computer.personal().habitDays({}), phone.personal().habitDays({}));
  assert.deepEqual(computer.messages(chat.id), phone.messages(chat.id));
  assert.equal(computer.conversation(chat.id).title, 'Dal telefono');
  const paths = changesOf(written.computer).map(change => `${change.method} ${change.path}`);
  assert.ok(paths.includes(`PUT /api/agenda/${item.id}`));
  assert.ok(paths.includes(`PUT /api/conversations/${chat.id}`));
  assert.ok(paths.includes(`POST /api/conversations/${chat.id}/messages`));
  assert.ok(paths.includes('PUT /api/habits/days'));

  // The answer written by the computer comes back, after the question.
  computer.saveMessage(chat.id, { id: 'c1', role: 'assistant', content: 'una risposta', status: 'streaming' });
  computer.saveMessage(chat.id, { id: 'c1', role: 'assistant', content: 'una risposta intera', status: 'complete' });
  const back = exchange(computer, phone);
  assert.deepEqual(phone.messages(chat.id).map(m => [m.id, m.content, m.status]), [['p1', 'una domanda', 'complete'], ['c1', 'una risposta intera', 'complete']]);
  assert.equal(changesOf(back.phone).find(change => change.data?.id === 'c1').data.content, 'una risposta intera');
});

test('a delete reaches the other device with all that belonged to the row', t => {
  const { computer, phone } = pair(t);
  const chat = computer.createConversation('Da togliere');
  computer.saveMessage(chat.id, { id: 'm1', role: 'user', content: 'ciao' });
  computer.saveMemory({ content: 'una nota', scope: 'conversation', conversationId: chat.id });
  const goal = computer.personal().saveGoal({ name: 'Finire' });
  computer.personal().saveGoalStep(goal.id, { title: 'Primo passo' });
  exchange(computer, phone);
  assert.equal(dump(phone, 'messages').length, 1);
  assert.equal(dump(phone, 'goal_steps').length, 1);

  phone.deleteConversation(chat.id);
  phone.personal().deleteGoal(goal.id);
  const written = exchange(computer, phone);
  for (const table of ['conversations', 'messages', 'memories', 'goals', 'goal_steps']) assert.equal(dump(computer, table).length, 0, table);
  assert.ok(changesOf(written.computer).some(change => change.method === 'DELETE' && change.path === `/api/conversations/${chat.id}`));
});

test('the same thing changed on both sides while apart: the most recent stays, on both', async t => {
  const { computer, phone } = pair(t);
  computer.setSetting('realtime_name', 'Mo');
  exchange(computer, phone);
  phone.setSetting('realtime_name', 'Dal telefono');
  await sleep(15);
  computer.setSetting('realtime_name', 'Dal computer');
  exchange(computer, phone);
  assert.equal(computer.getSetting('realtime_name'), 'Dal computer');
  assert.equal(phone.getSetting('realtime_name'), 'Dal computer');

  computer.setSetting('realtime_voice', 'a');
  await sleep(15);
  phone.setSetting('realtime_voice', 'b');
  exchange(computer, phone);
  assert.equal(computer.getSetting('realtime_voice'), 'b');
  assert.equal(phone.getSetting('realtime_voice'), 'b');
});

test('a chat deleted on one side and written on the other after: it stays whole on both', async t => {
  const { computer, phone } = pair(t);
  const chat = computer.createConversation('Contesa');
  computer.saveMessage(chat.id, { id: 'm1', role: 'user', content: 'uno' });
  exchange(computer, phone);
  computer.deleteConversation(chat.id);
  await sleep(15);
  phone.saveMessage(chat.id, { id: 'm2', role: 'user', content: 'due' });
  exchange(computer, phone);
  exchange(computer, phone);
  assert.deepEqual(computer.messages(chat.id).map(m => m.id), ['m1', 'm2']);
  assert.deepEqual(phone.messages(chat.id).map(m => m.id), ['m1', 'm2']);
});

test('messages written on both sides at once keep one order on both', async t => {
  const { computer, phone } = pair(t);
  const chat = computer.createConversation('Insieme');
  computer.saveMessage(chat.id, { id: 'm1', role: 'user', content: 'uno' });
  exchange(computer, phone);
  computer.saveMessage(chat.id, { id: 'c2', role: 'assistant', content: 'dal computer' });
  await sleep(5);
  phone.saveMessage(chat.id, { id: 'p2', role: 'user', content: 'dal telefono' });
  phone.saveMessage(chat.id, { id: 'p3', role: 'user', content: 'ancora' });
  exchange(computer, phone);
  exchange(computer, phone);
  const order = (store) => dump(store, 'messages', 'sequence').map(row => [row.sequence, row.id]);
  assert.deepEqual(order(computer), order(phone));
  assert.equal(order(computer).length, 4);
  assert.deepEqual(order(computer).slice(0, 2).map(row => row[1]), ['m1', 'c2']);
});

test('two pages of the same day made apart become one, the same on both', t => {
  const { computer, phone } = pair(t);
  exchange(computer, phone);
  computer.personal().saveDiaryEntry({ day: '2026-10-01', rawText: 'dal computer' });
  phone.personal().saveDiaryEntry({ day: '2026-10-01', rawText: 'dal telefono' });
  exchange(computer, phone);
  exchange(computer, phone);
  assert.equal(dump(computer, 'diary_entries').length, 1);
  assert.deepEqual(dump(computer, 'diary_entries'), dump(phone, 'diary_entries'));
});

test('an archive made again is found out and copied from zero', t => {
  const { computer, phone } = pair(t);
  computer.setSetting('app_locale', 'it');
  exchange(computer, phone);
  const other = new Store(':memory:', { wins: true });
  t.after(() => other.close());
  other.setSetting('app_locale', 'en');
  other.createConversation('Nuovo archivio');
  const written = exchange(other, phone);
  assert.ok(written.phone.some(change => change.t === 'conversations'));
  assert.equal(dump(phone, 'conversations').length, 1);
});

test('a long archive goes in several messages and arrives whole', t => {
  const { computer, phone } = pair(t);
  const chat = computer.createConversation('Lunga');
  for (let i = 0; i < 950; i += 1) computer.saveMessage(chat.id, { id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `messaggio ${i}` });
  exchange(computer, phone);
  assert.equal(dump(phone, 'messages').length, 950);
  assert.deepEqual(phone.messages(chat.id).map(m => m.id), computer.messages(chat.id).map(m => m.id));
});

test('a phone used alone, then paired: the rest becomes one, the phone’s own chats stay on the phone', t => {
  const { computer, phone } = pair(t);
  const theirs = computer.createConversation('Del computer');
  const mine = phone.createConversation('Del telefono');
  phone.personal().saveAgendaItem({ kind: 'reminder', title: 'Dal telefono', startAt: '2026-10-02T09:00' });
  exchange(computer, phone);
  assert.deepEqual(dump(computer, 'conversations', 'id').map(c => c.id), [theirs.id], 'the computer never sees the phone’s world');
  assert.deepEqual(dump(phone, 'conversations', 'id').map(c => c.id).sort(), [theirs.id, mine.id].sort(), 'the phone has both worlds');
  assert.equal(dump(computer, 'agenda_items').length, 1, 'the agenda is one');
});

test('a change made on a row that came from the other device stays, whatever the two clocks say', t => {
  const { computer, phone } = pair(t);
  computer.setSetting('realtime_name', 'Dal computer');
  // The computer's clock is an hour ahead of the phone's.
  computer.db.exec('UPDATE sync_log SET at = at + 3600000');
  exchange(computer, phone);
  assert.equal(phone.getSetting('realtime_name'), 'Dal computer');
  phone.setSetting('realtime_name', 'Dal telefono, dopo');
  exchange(computer, phone);
  assert.equal(computer.getSetting('realtime_name'), 'Dal telefono, dopo');
  assert.equal(phone.getSetting('realtime_name'), 'Dal telefono, dopo');
});

test('the first time two archives meet, what the computer has stays; what only one side has goes to the other', t => {
  const { computer, phone } = pair(t);
  computer.setSetting('theme_preferences', 'del computer');
  const tasks = computer.realtime().tasksConversationId;
  computer.saveMessage(tasks, { id: 't1', role: 'user', content: 'un compito' });
  // The phone, just installed, writes its own defaults and makes its own assistant's chats: after the computer did.
  phone.setSetting('theme_preferences', 'predefinito del telefono');
  phone.setSetting('solo_telefono', 'x');
  phone.realtime();
  exchange(computer, phone);
  for (const store of [computer, phone]) {
    assert.equal(store.getSetting('theme_preferences'), 'del computer');
    assert.equal(store.getSetting('solo_telefono'), 'x');
    // One assistant, one chat of its tasks: the one that holds something.
    const now = store.realtime();
    assert.equal(now.tasksConversationId, tasks);
    assert.equal(dump(store, "conversations WHERE kind='realtime_tasks'").length, 1);
  }
  exchange(computer, phone);
  assert.equal(dump(computer, "conversations WHERE kind='realtime'").length, 1);
  assert.deepEqual(dump(computer, 'conversations', 'id'), dump(phone, 'conversations', 'id'));
  // From there on, the most recent stays.
  phone.setSetting('theme_preferences', 'cambiato sul telefono');
  exchange(computer, phone);
  assert.equal(computer.getSetting('theme_preferences'), 'cambiato sul telefono');
});

test('two worlds on the phone: its own chats never leave it, the computer’s come and go back, each row says its world', t => {
  const { computer, phone } = pair(t);
  const theirs = computer.createConversation('Del computer');
  computer.saveMessage(theirs.id, { id: 'c1', role: 'user', content: 'dal computer' });
  exchange(computer, phone);
  // Born on each side: the home is the site of the archive, written once.
  assert.equal(theirs.home, computer.replica().site());
  assert.equal(phone.conversation(theirs.id).home, computer.replica().site(), 'the home travels with the row');
  const mine = phone.createConversation('Mia');
  assert.equal(mine.home, phone.replica().site());
  phone.saveMessage(mine.id, { id: 'p1', role: 'user', content: 'solo mia' });
  phone.saveMessage(theirs.id, { id: 'p2', role: 'user', content: 'per il computer' });
  // Without a computer paired there is no 'peer' world to be born in.
  const alone = new Store(':memory:', { wins: false });
  t.after(() => alone.close());
  assert.throws(() => alone.createConversation('X', null, 'peer'), /accoppiato/);
  assert.throws(() => phone.createConversation('X', null, 'altrove'), /non valida/);

  const written = exchange(computer, phone);
  assert.ok(!written.computer.some(change => change.k[0] === mine.id || change.k[0] === 'p1'), 'nothing of the phone’s world reached the computer');
  assert.deepEqual(computer.messages(theirs.id).map(m => m.id), ['c1', 'p2'], 'what the phone did in the computer’s world did');
  assert.throws(() => computer.conversation(mine.id), /non trovata/);

  // The lists: one world at a time on the phone, each row with its world; the computer lists all.
  assert.deepEqual(phone.listConversations('', false, null, 'own').map(c => [c.id, c.world]), [[mine.id, 'own']]);
  assert.deepEqual(phone.listConversations('', false, null, 'others').map(c => [c.id, c.world]), [[theirs.id, 'peer']]);
  assert.equal(phone.listConversations().length, 2);
  assert.deepEqual(computer.listConversations().map(c => c.world), ['own']);
  // A chat born on the phone for the computer's world is the computer's: it appears there, and in the phone's PC world.
  const forThem = phone.createConversation('Per il PC', null, 'peer');
  assert.equal(forThem.home, computer.replica().site());
  exchange(computer, phone);
  assert.equal(computer.conversation(forThem.id).title, 'Per il PC');
  assert.ok(phone.listConversations('', false, null, 'others').some(c => c.id === forThem.id));
  // The chats from before the homes: the ones that came from the other device take its site, the rest this one.
  phone.db.prepare("UPDATE conversations SET home = ''").run();
  phone.replica().install();
  assert.equal(phone.conversation(theirs.id).home, computer.replica().site());
  assert.equal(phone.conversation(mine.id).home, phone.replica().site());
});
