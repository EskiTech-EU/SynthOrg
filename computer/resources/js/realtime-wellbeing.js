/**
 * SynthOrg - Realtime, wellbeing: the numbers.
 *
 * What the wellbeing page shows is worked out here, on this computer, from
 * the data of the days told and from what the habits did day by day: no
 * model is asked. Days are local "YYYY-MM-DD" strings.
 *
 * A day nothing is known about is not a zero: it is left out of averages and
 * counts, and breaks a series.
 */
(function () {
  'use strict';

  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (day) => { const [y, m, d] = String(day).split('-').map(Number); return new Date(y, m - 1, d); };
  const shift = (day, n) => { const d = parse(day); d.setDate(d.getDate() + n); return stamp(d); };

  /** The days from `from` to `to`, both included. */
  function daysBetween(from, to) {
    const days = [];
    for (let day = from; day <= to && days.length < 400; day = shift(day, 1)) days.push(day);
    return days;
  }

  /** The last `count` days, ending with `today`. */
  function lastDays(today, count) {
    return daysBetween(shift(today, -(count - 1)), today);
  }

  /** The week (Monday to Sunday) that ended before the one `today` is in. */
  function weekBefore(today) {
    const d = parse(today);
    const sinceMonday = (d.getDay() + 6) % 7;
    const monday = shift(today, -sinceMonday - 7);
    return { from: monday, to: shift(monday, 6) };
  }

  const number = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const round = (v, digits = 1) => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);
  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

  // What is followed over time, and where it is in a day's data.
  const MEASURES = {
    mood: { read: (x) => number(x?.mood?.score), min: 1, max: 5 },
    energy: { read: (x) => number(x?.energy), min: 1, max: 5 },
    stress: { read: (x) => number(x?.stress), min: 1, max: 5 },
    sleep: { read: (x) => number(x?.sleep_hours), min: 0, max: 12 }
  };

  /** The days' data by day, from the diary's entries. */
  function dataByDay(entries) {
    const byDay = new Map();
    (entries || []).forEach(e => {
      if (!e.extracted_json) return;
      try { byDay.set(e.day, JSON.parse(e.extracted_json)); } catch {}
    });
    return byDay;
  }

  /**
   * One measure over the days: a point for every day that has it, the
   * average, and how it compares with the first half of the period
   * (`change`: second half's average less the first's; null with too little).
   */
  function series(measure, days, byDay) {
    const { read, min, max } = MEASURES[measure];
    const points = [];
    days.forEach((day, index) => {
      const value = read(byDay.get(day));
      if (value !== null && value >= min && value <= max) points.push({ day, index, value });
    });
    const half = days.length / 2;
    const first = points.filter(p => p.index < half).map(p => p.value);
    const second = points.filter(p => p.index >= half).map(p => p.value);
    return {
      measure, min, max, points,
      average: round(mean(points.map(p => p.value))),
      change: first.length && second.length ? round(mean(second) - mean(first)) : null
    };
  }

  /** Minutes told per category of activity over the days, the largest first. */
  function minutesByCategory(days, byDay) {
    const totals = new Map();
    days.forEach(day => (Array.isArray(byDay.get(day)?.activities) ? byDay.get(day).activities : []).forEach(a => {
      const minutes = number(a?.minutes);
      if (!minutes || minutes < 0) return;
      const category = String(a.category || 'other');
      totals.set(category, (totals.get(category) || 0) + minutes);
    }));
    return [...totals].map(([category, minutes]) => ({ category, minutes })).sort((a, b) => b.minutes - a.minutes);
  }

  /**
   * A habit over the days. marks: the rows of the habit (day, done).
   *   cells:   for every day, true (done), false (not done) or null (not known);
   *   done / known: days done, out of the days something is known about;
   *   streak:  days done in a row up to the last known day (a day not known
   *            or not done ends it); for a negative habit, days NOT done;
   *   with / without: a measure's average on the days done and on the days
   *            not done, each with its number of days.
   */
  function habitStats(habit, days, marks, byDay) {
    const state = new Map((marks || []).filter(m => m.habit_id === habit.id).map(m => [m.day, Boolean(m.done)]));
    const cells = days.map(day => ({ day, done: state.has(day) ? state.get(day) : null }));
    const known = cells.filter(c => c.done !== null);
    const good = (c) => (habit.sign === 'negative' ? c.done === false : c.done === true);
    // Counted back from the last day: that one not told yet does not end a series, any other day not known does.
    let streak = 0;
    for (let i = cells.length - 1; i >= 0; i--) {
      if (cells[i].done === null) { if (i === cells.length - 1) continue; break; }
      if (!good(cells[i])) break;
      streak++;
    }
    const compare = (measure) => {
      const read = MEASURES[measure].read;
      const pick = (done) => known.filter(c => c.done === done).map(c => read(byDay.get(c.day))).filter(v => v !== null);
      const on = pick(true), off = pick(false);
      return { with: round(mean(on)), withDays: on.length, without: round(mean(off)), withoutDays: off.length };
    };
    return {
      cells,
      done: known.filter(c => c.done).length,
      known: known.length,
      streak,
      last: [...known].reverse().find(c => c.done)?.day || null,
      mood: compare('mood'),
      energy: compare('energy')
    };
  }

  const plain = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ');

  /**
   * Whether an account seems to speak of a habit: one of the name's words
   * (four letters or more) starts like a word of the account. Rough on
   * purpose: it only decides whether the habit is asked about at the end of
   * the diary session, and a habit asked about once more does no harm.
   */
  function named(habitName, account, keywords = null) {
    const text = plain(account);
    const words = text.split(' ').filter(Boolean);
    // The words a model gave for it, once, when it was added: the forms people say it in
    // ("corsa": correre, corso, jogging). A word of them starts a word of the account;
    // one made of several words is looked for as it is.
    const given = (Array.isArray(keywords) ? keywords : []).map(plain).map(k => k.trim()).filter(k => k.length >= 3);
    if (given.some(k => (k.includes(' ') ? ` ${text} `.includes(` ${k}`) : words.some(word => word.startsWith(k))))) return true;
    const stems = plain(habitName).split(' ').filter(w => w.length >= 4).map(w => w.slice(0, Math.max(4, w.length - 2)));
    return stems.some(stem => words.some(word => word.startsWith(stem)));
  }

  /** The keywords of a habit or a goal, as they are kept (a JSON list), as a list. */
  function keywordsOf(item) {
    try { const list = JSON.parse(item?.keywords || '[]'); return Array.isArray(list) ? list : []; } catch { return []; }
  }

  /**
   * The part of an agenda item that falls on a day, in minutes from
   * midnight: { from, to }, or { allDay: true } when it covers the whole
   * day. A reminder is a moment: it is given half an hour so that it can be
   * seen and read. Null when the item does not touch the day.
   */
  function partOfDay(item, day) {
    const first = item.start_at.slice(0, 10);
    const last = (item.end_at || item.start_at).slice(0, 10);
    if (day < first || day > last) return null;
    const minutes = (stampText) => Number(stampText.slice(11, 13)) * 60 + Number(stampText.slice(14, 16));
    const from = day === first ? minutes(item.start_at) : 0;
    if (!item.end_at) return { from, to: Math.min(1440, from + 30) };
    const to = day === last ? minutes(item.end_at) : 1440;
    if (from === 0 && to >= 1440) return { allDay: true };
    return { from, to: Math.max(to, Math.min(1440, from + 30)) };
  }

  /**
   * Where the timed entries of a day go, side by side when they overlap:
   * each gets a column and the number of columns of its group, so that its
   * width is one share of the day's. entries: [{ from, to, … }], minutes.
   */
  function layoutDay(entries) {
    const sorted = [...entries].sort((a, b) => a.from - b.from || b.to - a.to);
    const placed = [];
    let group = [];
    let groupEnd = -1;
    const close = () => {
      const columns = Math.max(0, ...group.map(e => e.column)) + 1;
      group.forEach(e => { e.columns = columns; });
      group = [];
    };
    sorted.forEach(entry => {
      if (group.length && entry.from >= groupEnd) close();
      const taken = new Set(group.filter(e => e.to > entry.from).map(e => e.column));
      let column = 0;
      while (taken.has(column)) column++;
      const item = { ...entry, column, columns: 1 };
      group.push(item);
      placed.push(item);
      groupEnd = Math.max(groupEnd, entry.to);
    });
    if (group.length) close();
    return placed;
  }

  /* ---------------------------------------------------------------- */
  /* Goals and activity                                                 */
  /* ---------------------------------------------------------------- */

  const daysFromTo = (from, to) => Math.round((parse(to) - parse(from)) / 86400000);

  /**
   * Where a goal stands on `today`.
   *   done / total: steps closed, of the steps it has;
   *   pace:     steps closed per week, over the last four weeks;
   *   estimate: the day the last step would be closed at that pace (null
   *             when nothing was closed in four weeks, or nothing is left);
   *   daysLeft: days to the due day (negative: past it);
   *   late:     the estimate falls after the due day, or the due day is past
   *             with steps still open;
   *   next:     the first step still open.
   */
  function goalProgress(goal, today) {
    const steps = goal.steps || [];
    const done = steps.filter(s => s.done).length;
    const left = steps.length - done;
    const since = shift(today, -27);
    const recent = steps.filter(s => s.done && s.done_day && s.done_day >= since && s.done_day <= today).length;
    const pace = recent / 4;
    const estimate = left > 0 && pace > 0 ? shift(today, Math.ceil(left / pace * 7)) : null;
    const open = goal.status === 'open';
    const daysLeft = goal.due_day ? daysFromTo(today, goal.due_day) : null;
    const late = open && Boolean(goal.due_day) && ((left > 0 && goal.due_day < today) || (estimate !== null && estimate > goal.due_day));
    return {
      total: steps.length, done, left,
      share: steps.length ? done / steps.length : (open ? 0 : 1),
      pace: round(pace, 2), estimate, daysLeft, late,
      next: steps.find(s => !s.done) || null,
      proposed: steps.filter(s => !s.done && s.proposed_day)
    };
  }

  /** What was done in the app on each day: steps (the user's, a model's), messages written, files and lines. */
  function activityByDay(activity, projectId = null) {
    const byDay = new Map();
    const at = (day) => {
      if (!byDay.has(day)) byDay.set(day, { day, steps: 0, own: 0, model: 0, messages: 0, files: 0, additions: 0, deletions: 0 });
      return byDay.get(day);
    };
    (activity?.steps || []).forEach(row => {
      if (projectId && row.project_id !== projectId) return;
      const d = at(row.day);
      d.steps += row.steps;
      if (row.source === 'agent') d.model += row.steps; else d.own += row.steps;
      d.files += row.files || 0;
      d.additions += row.additions || 0;
      d.deletions += row.deletions || 0;
    });
    (activity?.messages || []).forEach(row => {
      if (projectId && row.project_id !== projectId) return;
      // What is said to the character is talk, not work: its tasks for the Master are.
      if (row.kind === 'realtime') return;
      at(row.day).messages += row.messages;
    });
    return byDay;
  }

  /** The actions of a day: steps recorded and messages written. One number for "how much was done in the app", nothing more. */
  const actions = (d) => (d ? d.steps + d.messages : 0);

  /**
   * The activity over the days: totals, the days something was done, when
   * in the day and in the week (hours 0–23, weekdays Monday first), and the
   * projects with their share.
   */
  function activityTotals(activity, days) {
    const inside = new Set(days);
    const byDay = activityByDay(activity);
    const totals = { steps: 0, own: 0, model: 0, messages: 0, files: 0, additions: 0, deletions: 0, activeDays: 0 };
    days.forEach(day => {
      const d = byDay.get(day);
      if (!d) return;
      ['steps', 'own', 'model', 'messages', 'files', 'additions', 'deletions'].forEach(k => { totals[k] += d[k]; });
      if (actions(d)) totals.activeDays++;
    });
    const hours = new Array(24).fill(0);
    const weekdays = new Array(7).fill(0);
    const count = (row, n) => {
      if (!inside.has(row.day) || row.kind === 'realtime') return;
      hours[row.hour] += n;
      weekdays[(parse(row.day).getDay() + 6) % 7] += n;
    };
    (activity?.steps || []).forEach(row => count(row, row.steps));
    (activity?.messages || []).forEach(row => count(row, row.messages));
    const projects = (activity?.projects || []).map(p => {
      const own = activityByDay(activity, p.id);
      const worked = days.filter(day => actions(own.get(day)));
      return {
        id: p.id, name: p.name,
        steps: worked.reduce((sum, day) => sum + own.get(day).steps, 0),
        messages: worked.reduce((sum, day) => sum + own.get(day).messages, 0),
        activeDays: worked.length,
        lastDay: p.last_step_day || null
      };
    }).sort((a, b) => (b.steps + b.messages) - (a.steps + a.messages));
    return { totals, hours, weekdays, projects, byDay };
  }

  /**
   * How much was done on the days a measure was high and on the days it was
   * low. The days that say the measure are split at their median: `high` the
   * days at or above it, `low` the ones below. Each side: the average of the
   * actions and the number of days. Null when a side has fewer than `least`
   * days, or when all the days say the same value.
   */
  function workByMeasure(measure, days, dataOfDay, activityOfDay, least = 3) {
    const read = MEASURES[measure].read;
    const known = days.map(day => ({ day, value: read(dataOfDay.get(day)) })).filter(d => d.value !== null);
    if (known.length < least * 2) return null;
    const sorted = known.map(d => d.value).sort((a, b) => a - b);
    const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const high = known.filter(d => d.value >= median);
    const low = known.filter(d => d.value < median);
    if (high.length < least || low.length < least) return null;
    const average = (list) => round(mean(list.map(d => actions(activityOfDay.get(d.day)))));
    return { measure, median: round(median), high: average(high), highDays: high.length, low: average(low), lowDays: low.length };
  }

  /** How much was done on the days a habit was done and on the days it was not; null with fewer than `least` days on a side. */
  function workByHabit(cells, activityOfDay, least = 3) {
    const on = cells.filter(c => c.done === true);
    const off = cells.filter(c => c.done === false);
    if (on.length < least || off.length < least) return null;
    const average = (list) => round(mean(list.map(c => actions(activityOfDay.get(c.day)))));
    return { with: average(on), withDays: on.length, without: average(off), withoutDays: off.length };
  }

  /** The weeks a month's calendar shows, Monday first: whole weeks, with the days of the months beside it that fill them. */
  function monthWeeks(year, month) {
    const first = stamp(new Date(year, month, 1));
    const last = stamp(new Date(year, month + 1, 0));
    const start = shift(first, -((parse(first).getDay() + 6) % 7));
    const end = shift(last, 6 - ((parse(last).getDay() + 6) % 7));
    const days = daysBetween(start, end);
    const weeks = [];
    for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
    return weeks;
  }

  /** The week a day is in, Monday to Sunday. */
  function weekOf(day) {
    const monday = shift(day, -((parse(day).getDay() + 6) % 7));
    return daysBetween(monday, shift(monday, 6));
  }

  /* ---------------------------------------------------------------- */
  /* Notices: what the last hours of work say                           */
  /* ---------------------------------------------------------------- */

  const MINUTE = 60000;

  /**
   * The stretch of work that is going on now. moments: when the user did
   * something (a step of theirs, a message written), in milliseconds. It
   * goes back from the last moment for as long as no two are more than
   * `gap` minutes apart; a pause taken ends it. Null when the last thing
   * done is more than `gap` minutes ago: the user is not working.
   *   from, to: its first and its last moment; minutes: from its first to now.
   */
  function workSpan(moments, now, { gap = 15, pauses = [] } = {}) {
    const times = moments.filter(t => Number.isFinite(t) && t <= now).sort((a, b) => a - b);
    if (!times.length || now - times[times.length - 1] > gap * MINUTE) return null;
    // Nothing before the end of the last pause belongs to this stretch.
    const rested = Math.max(0, ...pauses.map(p => p.to || p.from).filter(t => Number.isFinite(t) && t <= now));
    let from = times[times.length - 1];
    for (let i = times.length - 2; i >= 0; i--) {
      if (times[i] < rested || from - times[i] > gap * MINUTE) break;
      from = times[i];
    }
    if (from < rested) return null;
    return { from, to: times[times.length - 1], minutes: Math.floor((now - from) / MINUTE) };
  }

  /**
   * The file the user has been at, alone, for a while: the steps of theirs
   * in the stretch of work, from the last back, for as long as each one
   * changed that file and no other. steps: [{ at (ms), title, files }], the
   * user's own. Null with fewer than three such steps: a file saved once or
   * twice is not one the user is stuck on.
   *   file; minutes: from the first of those steps to now; saves.
   */
  function stuckOn(steps, span, now) {
    if (!span) return null;
    const own = steps.filter(s => s.at >= span.from && s.at <= now).sort((a, b) => a.at - b.at);
    const last = own[own.length - 1];
    // A step of one file made by a save is named after the file; one given a description by hand is not a file's name.
    const alone = (s) => Number(s.files) === 1 && /^[^\s,]+$/.test(s.title || '');
    if (!last || !alone(last)) return null;
    let first = last, saves = 0;
    for (let i = own.length - 1; i >= 0; i--) {
      if (!alone(own[i]) || own[i].title !== last.title) break;
      first = own[i];
      saves++;
    }
    return saves >= 3 ? { file: last.title, minutes: Math.floor((now - first.at) / MINUTE), saves } : null;
  }

  /** The open steps of the goals of a project that are due today or tomorrow, or past their day: the nearest first. */
  function dueSoon(goals, projectId, today) {
    const tomorrow = shift(today, 1);
    const found = [];
    (goals || []).filter(g => g.status === 'open' && g.project_id === projectId).forEach(goal => {
      (goal.steps || []).filter(s => !s.done && s.due_day && s.due_day <= tomorrow)
        .forEach(step => found.push({ goal: goal.name, title: step.title, day: step.due_day, when: step.due_day < today ? 'late' : step.due_day === today ? 'today' : 'tomorrow' }));
      if (goal.due_day && goal.due_day <= tomorrow && (goal.steps || []).some(s => !s.done)) {
        found.push({ goal: goal.name, title: goal.name, whole: true, day: goal.due_day, when: goal.due_day < today ? 'late' : goal.due_day === today ? 'today' : 'tomorrow' });
      }
    });
    return found.sort((a, b) => a.day.localeCompare(b.day));
  }

  /** The minutes from midnight of an hour written "HH:MM"; null when it is not one. */
  function minutesOf(hour) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hour || ''));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  /**
   * Whether `now` is in the hours the user chose, from an hour to another
   * ("HH:MM"): the range may go past midnight (23:00 to 05:00). The same
   * hour twice is no range at all.
   *   inside; since: the minutes from the range's start to now.
   */
  function inHours(now, from, to) {
    const start = minutesOf(from);
    const end = minutesOf(to);
    if (start === null || end === null || start === end) return { inside: false, since: 0 };
    const at = now.getHours() * 60 + now.getMinutes();
    const inside = start > end ? (at >= start || at < end) : (at >= start && at < end);
    return { inside, since: inside ? (at - start + 1440) % 1440 : 0 };
  }

  const lateHour = (now, from, to = '05:00') => inHours(now, from, to).inside;

  // Words that open a correction, and words that are hard on the one they are said to. Whole words, no accents.
  const CORRECTING = /^(no|non|ma no|ancora|di nuovo|sbagliato|errato|ti ho( gia)? detto|te l ho( gia)? detto|ho detto|come ti ho detto|wrong|again|not what|i (already )?(said|told)|still (wrong|not)|that s not|thats not|nope)\b/;
  const HARSH = ['idiota', 'stupido', 'stupida', 'scemo', 'cretino', 'deficiente', 'incapace', 'inutile', 'imbecille', 'coglione', 'cazzo', 'cazzata', 'merda', 'vaffanculo', 'fanculo', 'schifo', 'porco',
    'idiot', 'stupid', 'dumb', 'useless', 'moron', 'garbage', 'trash', 'crap', 'shit', 'fuck', 'fucking', 'wtf', 'damn'];

  /**
   * Whether an exchange with a model seems to be going badly, from the way
   * the user writes and not from a model's reading of it. messages: the last
   * ones of a chat, oldest first, { role, content, status, at (ms) }; only
   * the ones of the last `minutes` count.
   *   points: how much, all told; signs: what was seen, with how many times
   *   (repeating, correcting, harsh, loud, stopped); the strongest is `sign`.
   * A message counts once for each sign it shows. It says something only
   * with three user messages at least: one angry line is not an exchange.
   */
  function friction(messages, now, { minutes = 30 } = {}) {
    const recent = (messages || []).filter(m => m && Number.isFinite(m.at) && now - m.at <= minutes * MINUTE);
    const said = recent.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.trim()).slice(-8);
    const signs = { repeating: 0, correcting: 0, harsh: 0, loud: 0, stopped: 0 };
    const words = said.map(m => new Set(plain(m.content).split(' ').filter(w => w.length > 2)));
    said.forEach((m, i) => {
      const text = plain(m.content).replace(/\s+/g, ' ').trim();
      if (CORRECTING.test(text)) signs.correcting++;
      if (text.split(' ').some(w => HARSH.includes(w))) signs.harsh++;
      const letters = m.content.replace(/[^\p{L}]/gu, '');
      const capitals = letters.replace(/[^\p{Lu}]/gu, '');
      if ((letters.length >= 12 && capitals.length / letters.length > 0.7) || /[!?]{3,}/.test(m.content)) signs.loud++;
      // The same request said again: most of its words were in one of the three before it.
      if (words[i].size >= 4 && words.slice(Math.max(0, i - 3), i).some(before => {
        const shared = [...words[i]].filter(w => before.has(w)).length;
        return shared / Math.min(words[i].size, Math.max(before.size, 1)) >= 0.7 && before.size >= 4;
      })) signs.repeating++;
    });
    signs.stopped = recent.filter(m => m.role === 'assistant' && ['interrupted', 'error'].includes(m.status)).length;
    const points = said.length < 3 ? 0
      : signs.repeating * 2 + signs.correcting + signs.harsh * 2 + signs.loud + (signs.stopped >= 2 ? signs.stopped : 0);
    const weight = { harsh: 2, repeating: 2, correcting: 1, loud: 1, stopped: 1 };
    const sign = Object.keys(signs).filter(k => signs[k]).sort((a, b) => signs[b] * weight[b] - signs[a] * weight[a])[0] || null;
    return { points, signs, sign: points ? sign : null, said: said.length };
  }

  /** The pauses taken over the days: how many, the minutes they lasted, the days that had one, and the numbers day by day. */
  function pausesTotals(activity, days) {
    const inside = new Set(days);
    const rows = (activity?.pauses || []).filter(row => inside.has(row.day));
    return {
      count: rows.reduce((sum, row) => sum + (row.pauses || 0), 0),
      minutes: rows.reduce((sum, row) => sum + (row.minutes || 0), 0),
      days: rows.filter(row => row.pauses).length,
      byDay: new Map(rows.map(row => [row.day, { pauses: row.pauses || 0, minutes: row.minutes || 0 }]))
    };
  }

  /**
   * Whether a message corrects the answer to the one before it: it opens as
   * a correction does ("no", "ancora", "ti ho detto", "still wrong"…), or it
   * says again what the message before said. From the words, not from a
   * model's reading of them.
   */
  function correction(text, before) {
    const said = plain(text).replace(/\s+/g, ' ').trim();
    if (!said) return false;
    if (CORRECTING.test(said)) return true;
    const words = new Set(said.split(' ').filter(w => w.length > 2));
    const earlier = new Set(plain(before).split(' ').filter(w => w.length > 2));
    if (words.size < 4 || earlier.size < 4) return false;
    const shared = [...words].filter(w => earlier.has(w)).length;
    return shared / Math.min(words.size, earlier.size) >= 0.7;
  }

  /** How long, in hours and minutes, as numbers: { hours, minutes }. */
  function duration(minutes) {
    const whole = Math.max(0, Math.round(minutes));
    return { hours: Math.floor(whole / 60), minutes: whole % 60 };
  }

  const api = {
    workSpan, stuckOn, dueSoon, lateHour, inHours, friction, correction, duration, pausesTotals,
    MEASURES, daysBetween, lastDays, weekBefore, shift, dataByDay, series, minutesByCategory, habitStats, named,
    keywordsOf, partOfDay, layoutDay,
    goalProgress, activityByDay, activityTotals, actions, workByMeasure, workByHabit, monthWeeks, weekOf
  };
  if (typeof window !== 'undefined') window.RealtimeWellbeing = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
