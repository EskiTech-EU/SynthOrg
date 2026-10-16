'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/database');
const W = require('../resources/js/realtime-wellbeing.js');

function setup(t) { const store = new Store(':memory:'); t.after(() => store.close()); return store; }
const entry = (day, data) => ({ day, extracted_json: data ? JSON.stringify(data) : null });

test('days are counted on the local calendar, and the week before is Monday to Sunday', () => {
  assert.deepEqual(W.lastDays('2026-03-02', 3), ['2026-02-28', '2026-03-01', '2026-03-02']);
  assert.equal(W.daysBetween('2026-09-01', '2026-09-30').length, 30);
  // 2026-09-27 is a Sunday: the week that ended before its own is 14–20.
  assert.deepEqual(W.weekBefore('2026-09-27'), { from: '2026-09-14', to: '2026-09-20' });
  assert.deepEqual(W.weekBefore('2026-09-28'), { from: '2026-09-21', to: '2026-09-27' });
});

test('a measure counts only the days that say it: a day not told is not a zero', () => {
  const days = W.lastDays('2026-09-27', 6);
  const byDay = W.dataByDay([
    entry('2026-09-22', { mood: { score: 2 }, sleep_hours: 6 }),
    entry('2026-09-23', { mood: { score: null }, energy: 3 }),
    entry('2026-09-24', null),
    entry('2026-09-26', { mood: { score: 4 }, sleep_hours: 8 }),
    entry('2026-09-27', { mood: { score: 5 }, sleep_hours: 40 })
  ]);
  const mood = W.series('mood', days, byDay);
  assert.deepEqual(mood.points.map(p => [p.day, p.value]), [['2026-09-22', 2], ['2026-09-26', 4], ['2026-09-27', 5]]);
  assert.equal(mood.average, 3.7);
  // first half (22–24): 2; second half (25–27): 4.5
  assert.equal(mood.change, 2.5);
  const sleep = W.series('sleep', days, byDay);
  assert.deepEqual(sleep.points.map(p => p.value), [6, 8], 'a value outside the scale is left out');
  assert.equal(W.series('stress', days, byDay).average, null);
  assert.equal(W.series('stress', days, byDay).change, null);
});

test('minutes are summed by kind of activity, the largest first', () => {
  const days = ['2026-09-26', '2026-09-27'];
  const byDay = W.dataByDay([
    entry('2026-09-26', { activities: [{ name: 'Corsa', category: 'sport', minutes: 30 }, { name: 'Codice', category: 'work', minutes: 240 }] }),
    entry('2026-09-27', { activities: [{ name: 'Corsa', category: 'sport', minutes: 45 }, { name: 'Cena', category: 'social', minutes: null }] })
  ]);
  assert.deepEqual(W.minutesByCategory(days, byDay), [{ category: 'work', minutes: 240 }, { category: 'sport', minutes: 75 }]);
});

test('a habit: days done out of the days known, the run, and the mood with and without', () => {
  const days = W.lastDays('2026-09-27', 7);
  const habit = { id: 'run', sign: 'positive' };
  const marks = [
    { habit_id: 'run', day: '2026-09-21', done: 1 },
    { habit_id: 'run', day: '2026-09-22', done: 0 },
    { habit_id: 'run', day: '2026-09-24', done: 1 },
    { habit_id: 'run', day: '2026-09-25', done: 1 },
    { habit_id: 'run', day: '2026-09-26', done: 1 },
    { habit_id: 'other', day: '2026-09-27', done: 0 }
  ];
  const byDay = W.dataByDay([
    entry('2026-09-21', { mood: { score: 4 } }), entry('2026-09-22', { mood: { score: 2 } }),
    entry('2026-09-24', { mood: { score: 5 } }), entry('2026-09-26', { mood: { score: 3 } })
  ]);
  const stats = W.habitStats(habit, days, marks, byDay);
  assert.deepEqual(stats.cells.map(c => c.done), [true, false, null, true, true, true, null]);
  assert.equal(stats.done, 4);
  assert.equal(stats.known, 5);
  assert.equal(stats.streak, 3, 'today not told yet does not end the run');
  assert.equal(stats.last, '2026-09-26');
  assert.deepEqual(stats.mood, { with: 4, withDays: 3, without: 2, withoutDays: 1 });
});

test('a day nothing is known about ends a run; for a negative habit the run is of days without', () => {
  const days = W.lastDays('2026-09-27', 5);
  const mark = (day, done) => ({ habit_id: 'h', day, done });
  const gap = W.habitStats({ id: 'h', sign: 'positive' }, days, [mark('2026-09-23', 1), mark('2026-09-25', 1), mark('2026-09-26', 1), mark('2026-09-27', 1)], new Map());
  assert.equal(gap.streak, 3);
  const smoke = W.habitStats({ id: 'h', sign: 'negative' }, days, [mark('2026-09-24', 1), mark('2026-09-25', 0), mark('2026-09-26', 0), mark('2026-09-27', 0)], new Map());
  assert.equal(smoke.streak, 3);
  assert.equal(smoke.done, 1);
  const lapse = W.habitStats({ id: 'h', sign: 'negative' }, days, [mark('2026-09-26', 0), mark('2026-09-27', 1)], new Map());
  assert.equal(lapse.streak, 0);
});

test('an account names a habit when a word of it starts like a word of the name', () => {
  const account = 'Stamattina ho letto un capitolo, poi la sera una corsetta al parco. Niente sigarette.';
  assert.equal(W.named('Corsa', account), true);
  assert.equal(W.named('Sigaretta', account), true);
  assert.equal(W.named('Meditazione', account), false);
  assert.equal(W.named('Leggere', account), false, 'another form of the word is not found: the habit is asked about');
  assert.equal(W.named('Tè', account), false, 'a name of short words is always asked about');
});

test('habits are kept with sign and state, one per name, and go with their days', t => {
  const p = setup(t).personal();
  const run = p.saveHabit({ name: 'Corsa', sign: 'positive' });
  assert.equal(run.status, 'tracked');
  assert.equal(run.source, 'user');
  const smoke = p.saveHabit({ name: 'Fumo', sign: 'negative', status: 'proposed', source: 'model', notes: 'Ne parla ogni sera.' });
  assert.deepEqual(p.habits().map(h => [h.name, h.status]), [['Corsa', 'tracked'], ['Fumo', 'proposed']]);
  assert.throws(() => p.saveHabit({ name: 'corsa', sign: 'positive' }), /c'è già/);
  assert.throws(() => p.saveHabit({ name: 'Yoga', sign: 'buona' }), /Segno non valido/);
  assert.equal(p.saveHabit({ status: 'tracked' }, smoke.id).sign, 'negative');
  p.markHabit({ habitId: run.id, day: '2026-09-27', done: true });
  p.deleteHabit(run.id);
  assert.equal(p.habitDays().length, 0);
});

test('what the account says of the habits replaces an earlier reading, not what was set by hand', t => {
  const p = setup(t).personal();
  const a = p.saveHabit({ name: 'Corsa', sign: 'positive' });
  const b = p.saveHabit({ name: 'Lettura', sign: 'positive' });
  const c = p.saveHabit({ name: 'Fumo', sign: 'negative' });
  const day = '2026-09-27';
  p.setDiaryMarks({ day, marks: [{ habitId: a.id, done: true }, { habitId: b.id, done: true }] });
  p.markHabit({ habitId: c.id, day, done: true });
  // the page is written again: reading is no longer spoken of, smoking is said not done
  p.setDiaryMarks({ day, marks: [{ habitId: a.id, done: false }, { habitId: c.id, done: false }, { habitId: 'nobody', done: true }] });
  const marks = Object.fromEntries(p.habitDays({ from: day, to: day }).map(m => [m.habit_id, [m.done, m.source]]));
  assert.deepEqual(marks, { [a.id]: [0, 'diary'], [c.id]: [1, 'user'] });
  assert.equal(p.markHabit({ habitId: c.id, day, done: null }).done, null);
  assert.equal(p.habitDays().length, 1);
});

test('deleting a day of the diary takes what the habits did that day with it', t => {
  const p = setup(t).personal();
  const a = p.saveHabit({ name: 'Corsa', sign: 'positive' });
  const entry27 = p.saveDiaryEntry({ day: '2026-09-27', rawText: 'Ho corso.' });
  p.saveDiaryEntry({ day: '2026-09-26', rawText: 'Ho corso.' });
  p.setDiaryMarks({ day: '2026-09-27', marks: [{ habitId: a.id, done: true }] });
  p.setDiaryMarks({ day: '2026-09-26', marks: [{ habitId: a.id, done: true }] });
  p.deleteDiaryEntry(entry27.id);
  assert.deepEqual(p.habitDays().map(m => m.day), ['2026-09-26']);
  p.deleteDiary();
  assert.equal(p.habitDays().length, 0);
  assert.equal(p.habits().length, 1);
});

test('a period has one review: written again, it takes the place of the first', t => {
  const p = setup(t).personal();
  const first = p.saveReview({ fromDay: '2026-09-14', toDay: '2026-09-20', text: 'Prima stesura.' });
  const again = p.saveReview({ fromDay: '2026-09-14', toDay: '2026-09-20', text: 'Seconda stesura.' });
  p.saveReview({ fromDay: '2026-09-21', toDay: '2026-09-27', text: 'Settimana dopo.' });
  assert.equal(again.id, first.id);
  assert.deepEqual(p.reviews().map(r => r.text), ['Settimana dopo.', 'Seconda stesura.']);
  assert.throws(() => p.saveReview({ fromDay: '2026-09-27', toDay: '2026-09-21', text: 'x' }), /Periodo non valido/);
  p.deleteReview(first.id);
  assert.equal(p.reviews().length, 1);
});
