'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/database');
const W = require('../resources/js/realtime-wellbeing.js');

function setup(t) { const store = new Store(':memory:'); t.after(() => store.close()); return store; }
const step = (title, done_day = null, extra = {}) => ({ title, done: done_day ? 1 : 0, done_day, due_day: null, proposed_day: null, ...extra });

test('a goal is kept with its steps in order; a step is closed, reopened, deleted', t => {
  const p = setup(t).personal();
  const goal = p.saveGoal({ name: 'Pubblicare il sito', dueDay: '2026-10-31', steps: ['Testi', { title: 'Grafica', dueDay: '2026-10-10' }] });
  assert.deepEqual(goal.steps.map(s => [s.title, s.position, s.due_day, s.done]), [['Testi', 0, null, 0], ['Grafica', 1, '2026-10-10', 0]]);
  const added = p.saveGoalStep(goal.id, { title: 'Messa in linea' });
  assert.equal(added.position, 2);
  const closed = p.saveGoalStep(goal.id, { done: true, doneDay: '2026-09-27' }, goal.steps[0].id);
  assert.deepEqual([closed.done, closed.done_day], [1, '2026-09-27']);
  assert.equal(p.saveGoalStep(goal.id, { done: false }, goal.steps[0].id).done_day, null);
  p.deleteGoalStep(added.id);
  assert.equal(p.goal(goal.id).steps.length, 2);
  assert.throws(() => p.saveGoal({ name: 'Senza giorno', dueDay: '31/10/2026' }), /AAAA-MM-GG/);
  assert.throws(() => p.saveGoal({ name: 'Progetto che non c’è', projectId: 'nobody' }), /Progetto non trovato/);
  p.deleteGoal(goal.id);
  assert.equal(p.goals().length, 0);
});

test('the model proposes that a step is done; only the user closes it, on the day proposed', t => {
  const p = setup(t).personal();
  const goal = p.saveGoal({ name: 'Esame', steps: ['Capitolo 1'] });
  const id = goal.steps[0].id;
  const proposed = p.saveGoalStep(goal.id, { proposedDay: '2026-09-25', proposedWhy: 'Nel racconto dice di averlo finito.' }, id);
  assert.deepEqual([proposed.done, proposed.proposed_day, proposed.proposed_why], [0, '2026-09-25', 'Nel racconto dice di averlo finito.']);
  const refused = p.saveGoalStep(goal.id, { proposedDay: null }, id);
  assert.deepEqual([refused.done, refused.proposed_day, refused.proposed_why], [0, null, null]);
  p.saveGoalStep(goal.id, { proposedDay: '2026-09-26', proposedWhy: '' }, id);
  const confirmed = p.saveGoalStep(goal.id, { done: true }, id);
  assert.deepEqual([confirmed.done, confirmed.done_day, confirmed.proposed_day], [1, '2026-09-26', null]);
});

test('a goal reached or given up has the day it was closed; reopened, it has none', t => {
  const p = setup(t).personal();
  const goal = p.saveGoal({ name: 'Trasloco' });
  const done = p.saveGoal({ status: 'done', closedDay: '2026-09-20' }, goal.id);
  assert.deepEqual([done.status, done.closed_day], ['done', '2026-09-20']);
  assert.match(p.saveGoal({ status: 'dropped', closedDay: null }, goal.id).closed_day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(p.saveGoal({ status: 'open' }, goal.id).closed_day, null);
  assert.deepEqual(p.goals().map(g => g.name), ['Trasloco']);
});

test('the steps of the projects are kept once each, by this computer\'s day and hour, and go with the project', t => {
  const store = setup(t);
  const p = store.personal();
  const project = store.createProject({ name: 'Sito', kind: 'local', path: 'C:/x' });
  const at = new Date(2026, 8, 24, 22, 53, 54);
  const commits = [
    { hash: 'a1', when: at.toISOString(), source: 'user', tool: null, title: 'index.html', files: 2, additions: 10, deletions: 1 },
    { hash: 'a2', when: new Date(2026, 8, 24, 22, 58).toISOString(), source: 'agent', tool: 'write_file', title: 'style.css', files: 1, additions: 40, deletions: 0 },
    { hash: 'a3', when: new Date(2026, 8, 25, 9, 5).toISOString(), source: null, title: '', files: 1, additions: 3, deletions: 3 },
    { hash: '', when: at.toISOString() }, { hash: 'bad', when: 'never' }
  ];
  assert.equal(p.recordSteps(project.id, commits), 3);
  assert.equal(p.recordSteps(project.id, commits), 0, 'read again, nothing is added');
  const activity = p.activity({ from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(activity.steps.map(s => [s.day, s.hour, s.source, s.steps, s.additions]), [
    ['2026-09-24', 22, 'agent', 1, 40], ['2026-09-24', 22, 'user', 1, 10], ['2026-09-25', 9, 'user', 1, 3]
  ]);
  assert.deepEqual(activity.projects.map(x => [x.name, x.last_step_day, x.steps]), [['Sito', '2026-09-25', 3]]);
  assert.deepEqual(p.activityOfDay('2026-09-24').map(s => [s.project, s.title, s.source]), [['Sito', 'index.html', 'user'], ['Sito', 'style.css', 'agent']]);
  assert.equal(p.activity({ from: '2026-09-25', to: '2026-09-25' }).steps.length, 1);
  store.db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
  assert.equal(p.activity({}).steps.length, 0);
});

test('the messages the user wrote count as activity, by place; what the app told the character does not', t => {
  const store = setup(t);
  const p = store.personal();
  const project = store.createProject({ name: 'Sito', kind: 'local', path: 'C:/x' });
  const chat = store.createConversation('Generale');
  const own = store.createConversation('Del progetto', project.id);
  const realtime = store.realtime().conversation;
  store.saveMessage(chat.id, { role: 'user', content: 'uno' });
  store.saveMessage(chat.id, { role: 'assistant', content: 'risposta' });
  store.saveMessage(own.id, { role: 'user', content: 'due' });
  store.saveMessage(own.id, { role: 'user', content: 'tre' });
  store.saveMessage(realtime.id, { role: 'user', content: '[Promemoria arrivato]', report: true });
  store.saveMessage(realtime.id, { role: 'user', content: 'ciao' });
  const rows = p.activity({}).messages.map(m => [m.kind, m.project_id, m.messages]).sort((a, b) => String(a).localeCompare(String(b)));
  assert.deepEqual(rows, [['chat', null, 1], ['chat', project.id, 2], ['realtime', null, 1]]);
  const totals = W.activityTotals(p.activity({}), [p.activity({}).messages[0].day]);
  assert.equal(totals.totals.messages, 3, 'talk with the character is not counted as work');
  assert.deepEqual(totals.projects.map(x => [x.name, x.messages]), [['Sito', 2]]);
});

test('where a goal stands: steps done, pace of the last four weeks, the day it ends at that pace', () => {
  const goal = { status: 'open', due_day: '2026-10-31', steps: [
    step('a', '2026-08-01'), step('b', '2026-09-10'), step('c', '2026-09-24'), step('d'), step('e'), step('f')
  ] };
  const p = W.goalProgress(goal, '2026-09-27');
  assert.deepEqual([p.total, p.done, p.left, p.share], [6, 3, 3, 0.5]);
  assert.equal(p.pace, 0.5, 'two steps in four weeks');
  assert.equal(p.estimate, '2026-11-08', 'three steps at half a step a week: six weeks');
  assert.equal(p.daysLeft, 34);
  assert.equal(p.late, true, 'it ends after the due day');
  assert.equal(p.next.title, 'd');
  assert.equal(W.goalProgress({ ...goal, due_day: '2026-12-01' }, '2026-09-27').late, false);
});

test('without steps closed lately there is no estimate; past the due day with steps open it is late', () => {
  const still = W.goalProgress({ status: 'open', due_day: '2026-12-01', steps: [step('a', '2026-07-01'), step('b')] }, '2026-09-27');
  assert.deepEqual([still.pace, still.estimate, still.late], [0, null, false]);
  const past = W.goalProgress({ status: 'open', due_day: '2026-09-20', steps: [step('a')] }, '2026-09-27');
  assert.deepEqual([past.daysLeft, past.late], [-7, true]);
  const done = W.goalProgress({ status: 'done', due_day: '2026-09-20', steps: [] }, '2026-09-27');
  assert.deepEqual([done.share, done.late], [1, false]);
  const proposed = W.goalProgress({ status: 'open', due_day: null, steps: [step('a', null, { proposed_day: '2026-09-26' })] }, '2026-09-27');
  assert.deepEqual(proposed.proposed.map(s => s.title), ['a']);
});

test('the activity of a period: totals, hours, weekdays, by project', () => {
  const activity = {
    steps: [
      { project_id: 'p1', day: '2026-09-21', hour: 9, source: 'user', steps: 3, files: 4, additions: 20, deletions: 5 },
      { project_id: 'p1', day: '2026-09-21', hour: 22, source: 'agent', steps: 5, files: 6, additions: 90, deletions: 10 },
      { project_id: 'p2', day: '2026-09-27', hour: 22, source: 'user', steps: 1, files: 1, additions: 1, deletions: 0 },
      { project_id: 'p1', day: '2026-08-01', hour: 9, source: 'user', steps: 50, files: 1, additions: 1, deletions: 0 }
    ],
    messages: [
      { project_id: 'p1', kind: 'chat', day: '2026-09-21', hour: 22, messages: 4 },
      { project_id: null, kind: 'realtime', day: '2026-09-22', hour: 8, messages: 9 },
      { project_id: null, kind: 'realtime_tasks', day: '2026-09-23', hour: 8, messages: 2 }
    ],
    projects: [{ id: 'p1', name: 'Uno', last_step_day: '2026-09-21' }, { id: 'p2', name: 'Due', last_step_day: '2026-09-27' }]
  };
  const days = W.daysBetween('2026-09-21', '2026-09-27');
  const w = W.activityTotals(activity, days);
  assert.deepEqual(w.totals, { steps: 9, own: 4, model: 5, messages: 6, files: 11, additions: 111, deletions: 15, activeDays: 3 });
  assert.equal(w.hours[22], 10);
  assert.equal(w.hours[9], 3);
  assert.equal(w.hours[8], 2, 'the tasks for the Master count, the talk does not');
  assert.deepEqual(w.weekdays, [12, 0, 2, 0, 0, 0, 1], '21 September 2026 is a Monday');
  assert.deepEqual(w.projects.map(x => [x.name, x.steps, x.messages, x.activeDays]), [['Uno', 8, 4, 1], ['Due', 1, 0, 1]]);
  assert.equal(W.actions(w.byDay.get('2026-09-21')), 12);
});

test('work on the high and on the low days of a measure, split at the median; too few days, nothing', () => {
  const days = W.daysBetween('2026-09-20', '2026-09-27');
  const sleep = { '2026-09-20': 5, '2026-09-21': 6, '2026-09-22': 6.5, '2026-09-23': 7, '2026-09-24': 7.5, '2026-09-25': 8, '2026-09-26': 8 };
  const data = new Map(Object.entries(sleep).map(([day, hours]) => [day, { sleep_hours: hours }]));
  const done = new Map(Object.entries({ '2026-09-20': 2, '2026-09-21': 4, '2026-09-23': 10, '2026-09-24': 12, '2026-09-25': 8, '2026-09-26': 10 })
    .map(([day, steps]) => [day, { steps, messages: 0 }]));
  const link = W.workByMeasure('sleep', days, data, done);
  assert.deepEqual(link, { measure: 'sleep', median: 7, high: 10, highDays: 4, low: 2, lowDays: 3 }, 'a told day with nothing done counts as zero');
  assert.equal(W.workByMeasure('mood', days, data, done), null, 'no day says the mood');
  assert.equal(W.workByMeasure('sleep', days.slice(0, 4), data, done), null, 'four days are too few');
  const same = new Map(days.map(day => [day, { energy: 3 }]));
  assert.equal(W.workByMeasure('energy', days, same, done), null, 'all the days say the same: no low side');
});

test('work on the days a habit was done and on the days it was not', () => {
  const cells = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']
    .map((day, i) => ({ day, done: i === 6 ? null : i % 2 === 0 }));
  const done = new Map([['2026-09-20', { steps: 6, messages: 0 }], ['2026-09-22', { steps: 3, messages: 3 }], ['2026-09-21', { steps: 1, messages: 1 }]]);
  assert.deepEqual(W.workByHabit(cells, done), { with: 4, withDays: 3, without: 0.7, withoutDays: 3 });
  assert.equal(W.workByHabit(cells.slice(0, 4), done), null);
});

test('the weeks of a month are whole, Monday first', () => {
  const september = W.monthWeeks(2026, 8);
  assert.equal(september.length, 5);
  assert.equal(september[0][0], '2026-08-31');
  assert.equal(september[4][6], '2026-10-04');
  assert.ok(september.every(week => week.length === 7));
  assert.equal(W.monthWeeks(2026, 1)[0][0], '2026-01-26', 'February 2026 starts on a Sunday: its first week is mostly January');
  assert.equal(W.monthWeeks(2027, 1).length, 4, 'February 2027 starts on a Monday and ends on a Sunday');
  assert.equal(W.monthWeeks(2026, 7).length, 6, 'August 2026 starts on a Saturday and needs six weeks');
  assert.deepEqual(W.weekOf('2026-09-27'), W.daysBetween('2026-09-21', '2026-09-27'));
});
