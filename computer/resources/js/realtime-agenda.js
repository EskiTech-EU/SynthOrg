/**
 * SynthOrg - Realtime, the agenda.
 *
 * The agenda is a calendar. While its page is open the calendar takes the
 * stage, by month or by week, and the character sits small beside the
 * controls; the side panel shows the day picked, the goals and what was done
 * in the app over the days on screen.
 *
 * By month a day shows what it holds as a short list. By week the days are
 * columns of hours: what has a time sits at its time and is as tall as it
 * lasts, side by side with what overlaps it; what belongs to the whole day
 * sits above the hours.
 *
 * On the calendar, day by day: reminders and activities, the days goals and
 * their steps are due, the steps closed, the steps recorded in the Code
 * projects, and whether the day was told in the diary.
 *
 * A goal has a due day, steps and, when it is about code, a Code project.
 * Where it stands is worked out here from its steps (realtime-wellbeing.js).
 * The Master, when it writes a day's page, may propose that a step is done:
 * the user confirms it or not, here.
 *
 * These are methods of the section's object (realtime.js), kept in a file of
 * their own.
 */
(function () {
  'use strict';

  const rt = window.realtime._state;
  const { t, esc, dayStamp, localStamp, parseStamp } = window.realtime._util;
  const W = window.RealtimeWellbeing;
  const locale = () => (window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT');
  const timeOf = (stamp) => String(stamp || '').slice(11, 16);

  Object.assign(rt, {
    goals: [],
    calendarView: 'month',     // month | week
    calendarDay: '',           // the day picked; empty: today
    calendar: null,            // what the days on screen hold (loadCalendar)
    dayWork: [],               // the steps recorded on the day picked
    openGoal: null,            // the goal whose steps are shown
    agendaNote: '',

    pickedDay() { return this.calendarDay || dayStamp(new Date()); },

    /** The days the calendar shows: the weeks of the picked day's month, or its week. */
    calendarDays() {
      const day = this.pickedDay();
      if (this.calendarView === 'week') return [W.weekOf(day)];
      const date = parseStamp(`${day}T00:00`);
      return W.monthWeeks(date.getFullYear(), date.getMonth());
    },

    async loadGoals() {
      try { this.goals = await window.chatStorage.goals(); } catch { this.goals = this.goals || []; }
    },

    /** Everything the days on screen hold, read together; then the calendar and the panel are drawn. */
    async loadCalendar() {
      const days = this.calendarDays().flat();
      const from = days[0], to = days[days.length - 1];
      const picked = this.pickedDay();
      try {
        const [items, goals, activity, diary, dayWork] = await Promise.all([
          window.chatStorage.request(`/agenda?from=${from}T00:00&to=${W.shift(to, 1)}T00:00&open=false`),
          window.chatStorage.goals(),
          window.chatStorage.activity(from, to),
          window.chatStorage.diary(from, to, 100, 'days'),
          window.chatStorage.activityOfDay(picked)
        ]);
        this.goals = goals;
        this.dayWork = dayWork;
        this.calendar = { from, to, days, items, activity, told: new Set(diary.map(e => e.day)), work: W.activityTotals(activity, days), pauses: W.pausesTotals(activity, days) };
        try { this.agendaWaiting = await window.chatStorage.agendaProposals(); } catch { this.agendaWaiting = []; }
        // The steps of the container projects are being read for the first time: what they add is shown when it is there.
        if (activity.reading && !this.calendarAgain) {
          this.calendarAgain = setTimeout(() => { this.calendarAgain = null; if (!this.ui.calendar.hidden) this.loadCalendar(); }, 15000);
        }
      } catch (err) {
        this.agendaNote = t('realtime.error', { error: err.message });
      }
      this.renderCalendar();
      this.renderSide();
      // A goal just added has no words to be known by yet.
      this.study();
    },

    /** What a day holds, in the order of the day: what has a time first, by time, then what belongs to the whole day. */
    dayItems(day) {
      const today = dayStamp(new Date());
      const list = [];
      (this.calendar?.items || []).forEach(item => {
        const first = item.start_at.slice(0, 10);
        const last = (item.end_at || item.start_at).slice(0, 10);
        if (day < first || day > last) return;
        list.push({
          kind: item.kind, id: item.id, done: Boolean(item.done),
          time: day === first ? timeOf(item.start_at) : '',
          until: item.end_at && day === last ? timeOf(item.end_at) : '',
          title: item.title, notes: item.notes, item
        });
      });
      this.goals.forEach(goal => {
        if (goal.due_day === day) list.push({ kind: 'goal', id: goal.id, time: '', title: goal.name, done: goal.status === 'done', late: goal.status === 'open' && day < today, goal });
        goal.steps.forEach(step => {
          if (step.done && step.done_day === day) list.push({ kind: 'step-done', id: step.id, time: '', title: step.title, done: true, goal, step });
          else if (!step.done && step.due_day === day && goal.status === 'open') list.push({ kind: 'step', id: step.id, time: '', title: step.title, done: false, late: day < today, goal, step });
        });
      });
      return list.sort((a, b) => (a.time ? 0 : 1) - (b.time ? 0 : 1) || a.time.localeCompare(b.time));
    },

    itemIcon(entry) {
      if (entry.late) return 'fa-triangle-exclamation';
      return { reminder: 'fa-bell', activity: 'fa-clock', goal: 'fa-flag-checkered', step: 'fa-flag', 'step-done': 'fa-circle-check' }[entry.kind];
    },

    /** What an entry is, in words: the calendar's marks are never colour or icon alone. */
    itemLabel(entry) {
      const kind = t('realtime.calKind_' + entry.kind.replace('-', '_'));
      const of = entry.goal && entry.kind !== 'goal' ? ` (${entry.goal.name})` : '';
      const state = entry.late ? ` — ${t('realtime.calLate')}` : entry.done && entry.kind !== 'step-done' ? ` — ${t('realtime.agendaDoneLabel')}` : '';
      const when = entry.time ? `${entry.time}${entry.until ? '–' + entry.until : ''} ` : '';
      return `${when}${kind}: ${entry.title}${of}${state}`;
    },

    /** The calendar takes the stage while the agenda's page is open. */
    showCalendar(on) {
      if (!this.ui?.calendar) return;
      const was = !this.ui.calendar.hidden;
      this.ui.calendar.hidden = !on;
      this.ui.stage.classList.toggle('is-calendar', on);
      if (on && !was) this.loadCalendar();
      // The stage is back: what was made meanwhile is handed now.
      if (!on && was) requestAnimationFrame(() => this.handNext());
    },

    renderCalendar() {
      const box = this.ui?.calendar;
      if (!box || box.hidden) return;
      const weeks = this.calendarDays();
      const picked = this.pickedDay();
      const today = dayStamp(new Date());
      const date = parseStamp(`${picked}T00:00`);
      const month = this.calendarView === 'month';
      const title = month
        ? date.toLocaleDateString(locale(), { month: 'long', year: 'numeric' })
        : `${this.dayLabel(weeks[0][0], { day: 'numeric', month: 'short' })} – ${this.dayLabel(weeks[0][6], { day: 'numeric', month: 'short', year: 'numeric' })}`;
      const names = weeks[0].map(day => parseStamp(`${day}T00:00`).toLocaleDateString(locale(), { weekday: month ? 'short' : 'long' }));
      const marksOf = (day) => {
        const work = this.calendar?.work.byDay.get(day);
        return [
          work?.steps ? `<span title="${esc(t('realtime.calStepsTitle', { own: work.own, model: work.model }))}"><i class="fa-solid fa-code-commit"></i> ${work.steps}</span>` : '',
          work?.messages ? `<span title="${esc(t('realtime.calMessagesTitle', { count: work.messages }))}"><i class="fa-solid fa-comment"></i> ${work.messages}</span>` : '',
          this.calendar?.told.has(day) ? `<span title="${esc(t('realtime.calTold'))}"><i class="fa-solid fa-book"></i></span>` : ''
        ].join('');
      };
      const labelOf = (day, items) => `${this.dayLabel(day)}: ${items.length ? t(items.length === 1 ? 'realtime.calItem' : 'realtime.calItems', { count: items.length }) : t('realtime.calNothing')}`;
      const line = (entry) => `<li class="rt-cal-item is-${entry.kind}${entry.done ? ' is-done' : ''}${entry.late ? ' is-late' : ''}" title="${esc(this.itemLabel(entry))}">
        <i class="fa-solid ${this.itemIcon(entry)}" aria-hidden="true"></i>${entry.time ? `<b>${esc(entry.time)}</b>` : ''}<span>${esc(entry.title)}</span></li>`;
      const cell = (day) => {
        const items = this.dayItems(day);
        const marks = marksOf(day);
        const outside = parseStamp(`${day}T00:00`).getMonth() !== date.getMonth();
        return `<div class="rt-cal-day${day === today ? ' is-today' : ''}${day === picked ? ' is-picked' : ''}${outside ? ' is-outside' : ''}" data-cal-day="${day}" role="button" tabindex="0" aria-pressed="${day === picked}" aria-label="${esc(labelOf(day, items))}">
          <span class="rt-cal-number">${Number(day.slice(8))}</span>
          <ul class="rt-cal-items">
            ${items.slice(0, 3).map(line).join('')}
            ${items.length > 3 ? `<li class="rt-cal-more">${esc(t('realtime.calMore', { count: items.length - 3 }))}</li>` : ''}
          </ul>
          ${marks ? `<span class="rt-cal-marks">${marks}</span>` : ''}
        </div>`;
      };
      // The week: for each day, what belongs to the whole day above, what has a time in the hours.
      const week = () => {
        const days = weeks[0].map(day => {
          const items = this.dayItems(day);
          const whole = [], timed = [];
          items.forEach(entry => {
            const part = entry.item ? W.partOfDay(entry.item, day) : { allDay: true };
            if (!part) return;
            if (part.allDay) whole.push(entry); else timed.push({ ...part, entry });
          });
          return { day, items, whole, timed: W.layoutDay(timed) };
        });
        const now = new Date();
        const nowAt = (now.getHours() * 60 + now.getMinutes()) / 1440 * 100;
        const percent = (minutes) => Math.round(minutes / 1440 * 10000) / 100;
        return `<div class="rt-week">
          <div class="rt-week-head">
            <span class="rt-week-gutter"></span>
            ${days.map((d, i) => `<div class="rt-week-day${d.day === today ? ' is-today' : ''}${d.day === picked ? ' is-picked' : ''}" data-cal-day="${d.day}" role="button" tabindex="0" aria-pressed="${d.day === picked}" aria-label="${esc(labelOf(d.day, d.items))}">
              <span class="rt-cal-name">${esc(names[i])}</span>
              <span class="rt-cal-number">${esc(this.dayLabel(d.day, { day: 'numeric', month: 'short' }))}</span>
              ${d.whole.length ? `<ul class="rt-cal-items">${d.whole.map(line).join('')}</ul>` : ''}
              ${marksOf(d.day) ? `<span class="rt-cal-marks">${marksOf(d.day)}</span>` : ''}
            </div>`).join('')}
          </div>
          <div class="rt-week-body">
            <div class="rt-week-hours">${Array.from({ length: 24 }, (_, h) => `<span>${String(h).padStart(2, '0')}:00</span>`).join('')}</div>
            ${days.map(d => `<div class="rt-week-col${d.day === today ? ' is-today' : ''}${d.day === picked ? ' is-picked' : ''}" data-cal-day="${d.day}">
              ${d.timed.map(p => `<div class="rt-week-event is-${p.entry.kind}${p.entry.done ? ' is-done' : ''}" title="${esc(this.itemLabel(p.entry))}"
                style="top: ${percent(p.from)}%; height: ${percent(p.to - p.from)}%; left: ${percent(p.column / p.columns * 1440)}%; width: ${percent(1440 / p.columns)}%">
                <i class="fa-solid ${this.itemIcon(p.entry)}" aria-hidden="true"></i><b>${esc(p.entry.time || '')}</b><span>${esc(p.entry.title)}</span></div>`).join('')}
              ${d.day === today ? `<span class="rt-week-now" style="top: ${Math.round(nowAt * 100) / 100}%" title="${esc(t('realtime.calNow'))}"></span>` : ''}
            </div>`).join('')}
          </div>
        </div>`;
      };
      // Drawn again, the week stays where it was scrolled to; drawn first, it opens an hour before the first thing of the week, or at seven.
      const body = box.querySelector('.rt-week-body');
      const scrolled = body && this.drawnWeek === weeks[0][0] ? body.scrollTop : null;
      this.drawnWeek = month ? null : weeks[0][0];
      box.innerHTML = `
        <header class="rt-cal-head">
          <button type="button" class="rt-back" data-cal="prev" aria-label="${esc(t('realtime.calPrev'))}" title="${esc(t('realtime.calPrev'))}"><i class="fa-solid fa-chevron-left"></i></button>
          <h2>${esc(title)}</h2>
          <button type="button" class="rt-back" data-cal="next" aria-label="${esc(t('realtime.calNext'))}" title="${esc(t('realtime.calNext'))}"><i class="fa-solid fa-chevron-right"></i></button>
          <button type="button" class="btn" data-cal="today">${esc(t('realtime.agendaToday'))}</button>
          <span class="rt-cal-space"></span>
          <div class="rt-periods" role="group" aria-label="${esc(t('realtime.calViewLabel'))}">
            ${['month', 'week'].map(view => `<button type="button" class="rt-period${view === this.calendarView ? ' is-on' : ''}" data-cal-view="${view}" aria-pressed="${view === this.calendarView}">${esc(t('realtime.calView_' + view))}</button>`).join('')}
          </div>
        </header>
        ${month ? `<div class="rt-cal-grid" style="--rt-cal-weeks: ${weeks.length}">
          ${names.map(name => `<span class="rt-cal-name">${esc(name)}</span>`).join('')}
          ${weeks.flat().map(cell).join('')}
        </div>` : week()}
        <p class="rt-cal-legend rt-hint">
          ${['reminder', 'activity', 'step', 'goal', 'step-done'].map(kind => `<span><i class="fa-solid ${this.itemIcon({ kind })}"></i> ${esc(t('realtime.calKind_' + kind.replace('-', '_')))}</span>`).join('')}
          <span><i class="fa-solid fa-triangle-exclamation"></i> ${esc(t('realtime.calLate'))}</span>
          <span><i class="fa-solid fa-code-commit"></i> ${esc(t('realtime.calSteps'))}</span>
          <span><i class="fa-solid fa-comment"></i> ${esc(t('realtime.calMessages'))}</span>
          <span><i class="fa-solid fa-book"></i> ${esc(t('realtime.calTold'))}</span>
        </p>`;
      const hours = box.querySelector('.rt-week-body');
      if (hours) {
        if (scrolled !== null) hours.scrollTop = scrolled;
        else {
          const first = Math.min(...weeks[0].flatMap(day => this.dayItems(day).map(entry => (entry.item ? W.partOfDay(entry.item, day) : null)).filter(part => part && !part.allDay).map(part => part.from)), 8 * 60);
          hours.scrollTop = Math.max(0, (first - 60) / 1440) * hours.scrollHeight;
        }
      }
    },

    async onCalendarClick(e) {
      const move = e.target.closest('[data-cal]')?.dataset.cal;
      const view = e.target.closest('[data-cal-view]')?.dataset.calView;
      const day = e.target.closest('[data-cal-day]')?.dataset.calDay;
      if (e.type === 'keydown' && !(day && (e.key === 'Enter' || e.key === ' '))) return;
      if (move) {
        const picked = this.pickedDay();
        if (move === 'today') this.calendarDay = '';
        else if (this.calendarView === 'week') this.calendarDay = W.shift(picked, move === 'next' ? 7 : -7);
        else {
          // The same day of the month before or after, or its last day when it has fewer.
          const d = parseStamp(`${picked}T00:00`);
          const target = new Date(d.getFullYear(), d.getMonth() + (move === 'next' ? 1 : -1), 1);
          const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
          target.setDate(Math.min(d.getDate(), last));
          this.calendarDay = dayStamp(target);
        }
      } else if (view) {
        this.calendarView = view === 'week' ? 'week' : 'month';
        window.chatStorage.setSetting('realtime_calendar_view', this.calendarView).catch(() => {});
      } else if (day) {
        if (e.type === 'keydown') e.preventDefault();
        this.calendarDay = day;
      } else return;
      await this.loadCalendar();
      if (day) this.ui.calendar.querySelector(`[data-cal-day="${day}"]`)?.focus();
    },

    /* -------------------------------------------------------------- */
    /* The agenda's page in the side panel                              */
    /* -------------------------------------------------------------- */

    dueLabel(due, today) {
      const left = Math.round((parseStamp(`${due}T00:00`) - parseStamp(`${today}T00:00`)) / 86400000);
      const when = this.dayLabel(due, { day: 'numeric', month: 'short', year: due.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric' });
      if (left === 0) return t('realtime.dueToday', { day: when });
      return t(left > 0 ? (left === 1 ? 'realtime.dueInDay' : 'realtime.dueInDays') : (left === -1 ? 'realtime.duePastDay' : 'realtime.duePastDays'), { day: when, days: Math.abs(left) });
    },

    renderGoal(goal, today) {
      const p = W.goalProgress(goal, today);
      const open = this.openGoal === goal.id;
      const project = goal.project_id ? (this.calendar?.activity.projects || []).find(x => x.id === goal.project_id) : null;
      const facts = [
        goal.due_day ? this.dueLabel(goal.due_day, today) : t('realtime.goalNoDue'),
        p.total ? t('realtime.goalSteps', { done: p.done, total: p.total }) : t('realtime.goalNoSteps')
      ];
      const pace = p.left && goal.status === 'open'
        ? (p.estimate
          ? t('realtime.goalPace', { pace: this.figure(p.pace, 2), day: this.dayLabel(p.estimate, { day: 'numeric', month: 'short' }) })
          : t('realtime.goalNoPace'))
        : '';
      const ago = project?.last_step_day ? Math.max(0, Math.round((parseStamp(`${today}T00:00`) - parseStamp(`${project.last_step_day}T00:00`)) / 86400000)) : 0;
      const last = project
        ? (project.last_step_day
          ? t(ago === 0 ? 'realtime.goalProjectToday' : ago === 1 ? 'realtime.goalProjectDay' : 'realtime.goalProject', { project: project.name, day: this.dayLabel(project.last_step_day, { day: 'numeric', month: 'short' }), days: ago })
          : t('realtime.goalProjectNoSteps', { project: project.name }))
        : '';
      const steps = goal.steps.map(step => `<li class="rt-goal-step${step.done ? ' is-done' : ''}">
        <input type="checkbox" data-action="step-done" data-goal="${esc(goal.id)}" data-id="${esc(step.id)}" ${step.done ? 'checked' : ''} aria-label="${esc(t('realtime.stepDoneLabel', { title: step.title }))}">
        <span class="rt-agenda-title">${esc(step.title)}<small>${esc([
          step.done && step.done_day ? t('realtime.stepDoneOn', { day: this.dayLabel(step.done_day, { day: 'numeric', month: 'short' }) }) : '',
          !step.done && step.due_day ? this.dueLabel(step.due_day, today) : ''
        ].filter(Boolean).join(' · '))}</small></span>
        <button type="button" class="btn-chat-action" data-action="step-delete" data-goal="${esc(goal.id)}" data-id="${esc(step.id)}" title="${esc(t('realtime.stepDelete'))}" aria-label="${esc(t('realtime.stepDelete'))}"><i class="fa-solid fa-xmark"></i></button>
      </li>`).join('');
      const projects = this.calendar?.activity.projects || [];
      return `<li class="rt-goal is-${goal.status}${p.late ? ' is-late' : ''}" data-goal="${esc(goal.id)}">
        <button type="button" class="rt-goal-head" data-action="goal-open" aria-expanded="${open}">
          <strong>${esc(goal.name)}</strong>
          <span class="rt-goal-share">${p.total ? Math.round(p.share * 100) + '%' : ''}</span>
          <i class="fa-solid ${open ? 'fa-chevron-up' : 'fa-chevron-down'}" aria-hidden="true"></i>
        </button>
        <div class="rt-meter" role="img" aria-label="${esc(t('realtime.goalSteps', { done: p.done, total: p.total }))}"><span style="width: ${Math.round(p.share * 100)}%"></span></div>
        <p class="rt-hint">${esc(facts.join(' · '))}</p>
        ${p.late ? `<p class="rt-goal-late"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(t(p.left && goal.due_day < today ? 'realtime.goalPastDue' : 'realtime.goalLate'))}</p>` : ''}
        ${pace ? `<p class="rt-hint">${esc(pace)}</p>` : ''}
        ${last ? `<p class="rt-hint">${esc(last)}</p>` : ''}
        ${open ? `<div class="rt-goal-body">
          ${goal.notes ? `<p class="rt-hint">${esc(goal.notes)}</p>` : ''}
          ${steps ? `<ul class="rt-list">${steps}</ul>` : ''}
          <form class="rt-step-add rt-row" data-goal="${esc(goal.id)}">
            <input type="text" class="rt-step-title" maxlength="200" placeholder="${esc(t('realtime.stepAddPlaceholder'))}" aria-label="${esc(t('realtime.stepAddPlaceholder'))}" required>
            <input type="date" class="rt-step-due rt-date" aria-label="${esc(t('realtime.stepDueLabel'))}" title="${esc(t('realtime.stepDueLabel'))}">
            <button type="submit" class="btn">${esc(t('realtime.noteAdd'))}</button>
          </form>
          <form class="rt-goal-edit" data-goal="${esc(goal.id)}">
            <label class="rt-field">${esc(t('realtime.goalNameLabel'))}<input type="text" class="rt-goal-name" maxlength="120" value="${esc(goal.name)}" required></label>
            <label class="rt-field">${esc(t('realtime.goalDueLabel'))}<input type="date" class="rt-goal-due rt-date" value="${esc(goal.due_day || '')}"></label>
            <label class="rt-field">${esc(t('realtime.goalProjectLabel'))}
              <select class="rt-goal-project select-control">
                <option value="">${esc(t('realtime.goalProjectNone'))}</option>
                ${projects.map(x => `<option value="${esc(x.id)}"${x.id === goal.project_id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}
              </select>
            </label>
            <label class="rt-field">${esc(t('realtime.goalNotesLabel'))}<input type="text" class="rt-goal-notes" maxlength="2000" value="${esc(goal.notes)}"></label>
            <div class="rt-row">
              <button type="submit" class="btn btn-primary">${esc(t('realtime.save'))}</button>
              ${goal.status === 'open'
                ? `<button type="button" class="btn" data-action="goal-status" data-status="done">${esc(t('realtime.goalReach'))}</button>
                   <button type="button" class="btn" data-action="goal-status" data-status="dropped">${esc(t('realtime.goalDrop'))}</button>`
                : `<button type="button" class="btn" data-action="goal-status" data-status="open">${esc(t('realtime.goalReopen'))}</button>`}
              <button type="button" class="btn btn-danger-outline" data-action="goal-delete">${esc(t('realtime.habitDelete'))}</button>
            </div>
          </form>
        </div>` : ''}
      </li>`;
    },

    /** Bars for the hours of the day or the days of the week: one hue, a value each, read on hover and in the table below. */
    renderBars(values, labels, ticks, name) {
      const max = Math.max(1, ...values);
      return `<div class="rt-bars" role="img" aria-label="${esc(name)}">
        ${values.map((v, i) => `<span class="rt-bar" title="${esc(`${labels[i]}: ${v}`)}"><i style="height: ${v ? Math.max(4, Math.round(v / max * 100)) : 0}%"></i></span>`).join('')}
      </div>
      <div class="rt-bars-axis">${ticks.map(i => `<span style="left: ${(i + 0.5) / values.length * 100}%">${esc(labels[i])}</span>`).join('')}</div>`;
    },

    renderAgendaTab() {
      const today = dayStamp(new Date());
      const picked = this.pickedDay();
      const items = this.dayItems(picked);
      const agendaItem = (entry) => `<li class="rt-agenda-item${entry.done ? ' is-done' : ''}">
        <input type="checkbox" data-action="agenda-done" data-id="${esc(entry.id)}" ${entry.done ? 'checked' : ''} aria-label="${esc(t('realtime.agendaDoneLabel'))}">
        <i class="fa-solid ${this.itemIcon(entry)}" title="${esc(t('realtime.calKind_' + entry.kind))}"></i>
        <span class="rt-agenda-time">${esc(entry.time ? `${entry.time}${entry.until ? '–' + entry.until : ''}` : t('realtime.calAllDay'))}</span>
        <span class="rt-agenda-title">${esc(entry.title)}${entry.notes ? `<small>${esc(entry.notes)}</small>` : ''}</span>
        <button type="button" class="btn-chat-action" data-action="agenda-delete" data-id="${esc(entry.id)}" title="${esc(t('realtime.agendaDelete'))}" aria-label="${esc(t('realtime.agendaDelete'))}"><i class="fa-solid fa-xmark"></i></button>
      </li>`;
      const goalItem = (entry) => `<li class="rt-agenda-item${entry.done && entry.kind !== 'step-done' ? ' is-done' : ''}${entry.late ? ' is-late' : ''}">
        <i class="fa-solid ${this.itemIcon(entry)}"></i>
        <span class="rt-agenda-title">${esc(entry.title)}<small>${esc([t('realtime.calKind_' + entry.kind.replace('-', '_')), entry.kind === 'goal' ? '' : entry.goal.name, entry.late ? t('realtime.calLate') : ''].filter(Boolean).join(' · '))}</small></span>
        <button type="button" class="btn-chat-action" data-action="goal-show" data-goal="${esc(entry.goal.id)}" title="${esc(t('realtime.goalShow'))}" aria-label="${esc(t('realtime.goalShow'))}"><i class="fa-solid fa-arrow-down"></i></button>
      </li>`;
      const work = new Map();
      this.dayWork.forEach(step => { if (!work.has(step.project)) work.set(step.project, []); work.get(step.project).push(step); });
      const workList = [...work].map(([project, steps]) => `<details class="rt-day-work"><summary>${esc(t(steps.length === 1 ? 'realtime.dayStep' : 'realtime.daySteps', { project, count: steps.length }))}</summary>
        <ul class="rt-list">${steps.map(step => `<li class="rt-hint">${esc(timeOf(localStamp(new Date(step.at))))} · ${esc(t(step.source === 'agent' ? 'realtime.byModel' : 'realtime.byYou'))} · ${esc(step.title || t('realtime.stepUntitled'))}</li>`).join('')}</ul></details>`).join('');
      const nextHour = picked === today ? localStamp(new Date(Date.now() + 60 * 60000)).slice(0, 14) + '00' : `${picked}T09:00`;

      const proposals = this.goals.flatMap(goal => goal.status === 'open' ? goal.steps.filter(s => !s.done && s.proposed_day).map(step => ({ goal, step })) : []);
      const openGoals = this.goals.filter(g => g.status === 'open');
      const closed = this.goals.filter(g => g.status !== 'open');
      const projects = this.calendar?.activity.projects || [];

      const w = this.calendar?.work;
      const hourLabels = Array.from({ length: 24 }, (_, i) => String(i));
      const dayLabels = W.weekOf(today).map(day => parseStamp(`${day}T00:00`).toLocaleDateString(locale(), { weekday: 'short' }));
      const activity = w && (w.totals.steps || w.totals.messages) ? `
          <p class="rt-hint">${esc(t('realtime.workTotals', { own: w.totals.own, model: w.totals.model, messages: w.totals.messages, days: w.totals.activeDays, all: this.calendar.days.length }))}</p>
          ${this.calendar.pauses.count ? `<p class="rt-hint">${esc(t(this.calendar.pauses.count === 1 ? 'realtime.pausesTaken1' : 'realtime.pausesTaken', { count: this.calendar.pauses.count, days: this.calendar.pauses.days, time: this.timeText(this.calendar.pauses.minutes) }))}</p>` : ''}
          <span class="rt-tile-label">${esc(t('realtime.workHours'))}</span>
          ${this.renderBars(w.hours, hourLabels, [0, 6, 12, 18, 23], t('realtime.workHours'))}
          <span class="rt-tile-label">${esc(t('realtime.workWeekdays'))}</span>
          ${this.renderBars(w.weekdays, dayLabels, [0, 1, 2, 3, 4, 5, 6], t('realtime.workWeekdays'))}
          <details class="rt-table"><summary>${esc(t('realtime.workByProject'))}</summary>
            <table>
              <thead><tr><th>${esc(t('realtime.workProject'))}</th><th>${esc(t('realtime.calSteps'))}</th><th>${esc(t('realtime.calMessages'))}</th><th>${esc(t('realtime.workDays'))}</th></tr></thead>
              <tbody>${w.projects.map(p => `<tr><th>${esc(p.name)}</th><td>${p.steps}</td><td>${p.messages}</td><td>${p.activeDays}</td></tr>`).join('')}
                <tr><th>${esc(t('realtime.workHoursTable'))}</th><td colspan="3">${esc(w.hours.map((v, i) => (v ? `${i}: ${v}` : '')).filter(Boolean).join(' · ') || '—')}</td></tr>
              </tbody>
            </table>
          </details>`
        : `<p class="rt-hint">${esc(t('realtime.workNone'))}</p>`;

      const waiting = (this.agendaWaiting || []).map(item => `<div class="rt-proposal" data-agenda="${esc(item.id)}">
          <span class="rt-proposal-section">${esc(t('realtime.agendaProposed'))}</span>
          <p><b>${esc(item.title)}</b></p>
          <p class="rt-hint">${esc([
            t('realtime.calKind_' + item.kind),
            parseStamp(item.start_at)?.toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
            item.end_at ? '→ ' + parseStamp(item.end_at)?.toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
          ].filter(Boolean).join(' · '))}</p>
          ${item.why ? `<p class="rt-hint">«${esc(item.why)}»</p>` : ''}
          <div class="rt-proposal-actions">
            <button type="button" class="btn btn-primary" data-action="agenda-accept">${esc(t('realtime.agendaAccept'))}</button>
            <button type="button" class="btn" data-action="agenda-refuse">${esc(t('realtime.habitDismiss'))}</button>
          </div>
        </div>`).join('');
      return `
        ${this.agendaNote ? `<p class="rt-hint" role="status">${esc(this.agendaNote)}</p>` : ''}
        ${waiting ? `<section class="rt-card rt-proposals">${waiting}</section>` : ''}
        <section class="rt-card">
          <h3>${esc(picked === today ? `${t('realtime.agendaToday')} · ${this.dayLabel(picked, { weekday: 'long', day: 'numeric', month: 'long' })}` : this.dayLabel(picked))}</h3>
          ${items.length ? `<ul class="rt-list">${items.map(entry => (entry.item ? agendaItem(entry) : goalItem(entry))).join('')}</ul>` : `<p class="rt-hint">${esc(t('realtime.calNothing'))}</p>`}
          ${workList}
          ${this.calendar?.told.has(picked) ? `<button type="button" class="btn" data-side-tab="diary"><i class="fa-solid fa-book"></i> ${esc(t('realtime.dayDiary'))}</button>` : ''}
          <details class="rt-agenda-add">
            <summary>${esc(t('realtime.agendaAdd'))}</summary>
            <form class="rt-agenda-form">
              <select class="rt-agenda-kind select-control">
                <option value="reminder">${esc(t('realtime.kindReminder'))}</option>
                <option value="activity">${esc(t('realtime.kindActivity'))}</option>
              </select>
              <input type="text" class="rt-agenda-title-input" maxlength="300" placeholder="${esc(t('realtime.agendaTitlePlaceholder'))}" required>
              <label class="rt-field">${esc(t('realtime.agendaStart'))}<input type="datetime-local" class="rt-agenda-start" value="${nextHour}" required></label>
              <label class="rt-field rt-agenda-end-wrap" hidden>${esc(t('realtime.agendaEnd'))}<input type="datetime-local" class="rt-agenda-end"></label>
              <button type="submit" class="btn btn-primary">${esc(t('realtime.agendaSave'))}</button>
            </form>
          </details>
        </section>
        <section class="rt-card rt-goals">
          <h3>${esc(t('realtime.goalsTitle'))}</h3>
          ${proposals.map(({ goal, step }) => `<div class="rt-proposal" data-goal="${esc(goal.id)}" data-step="${esc(step.id)}">
            <span class="rt-proposal-section">${esc(t('realtime.stepProposed'))}</span>
            <p><b>${esc(step.title)}</b> · ${esc(goal.name)}</p>
            <p class="rt-hint">${esc([this.dayLabel(step.proposed_day, { day: 'numeric', month: 'long' }), step.proposed_why].filter(Boolean).join(' — '))}</p>
            <div class="rt-proposal-actions">
              <button type="button" class="btn btn-primary" data-action="step-confirm">${esc(t('realtime.stepConfirm'))}</button>
              <button type="button" class="btn" data-action="step-refuse">${esc(t('realtime.stepRefuse'))}</button>
            </div>
          </div>`).join('')}
          ${openGoals.length ? `<ul class="rt-list rt-goal-list">${openGoals.map(goal => this.renderGoal(goal, today)).join('')}</ul>` : `<p class="rt-hint">${esc(t('realtime.goalsEmpty', { name: this.displayName() }))}</p>`}
          <details class="rt-agenda-add rt-goal-new">
            <summary>${esc(t('realtime.goalAdd'))}</summary>
            <form class="rt-goal-add rt-agenda-form">
              <input type="text" class="rt-goal-name" maxlength="120" placeholder="${esc(t('realtime.goalNamePlaceholder'))}" aria-label="${esc(t('realtime.goalNameLabel'))}" required>
              <label class="rt-field">${esc(t('realtime.goalDueLabel'))}<input type="date" class="rt-goal-due rt-date"></label>
              <label class="rt-field">${esc(t('realtime.goalProjectLabel'))}
                <select class="rt-goal-project select-control">
                  <option value="">${esc(t('realtime.goalProjectNone'))}</option>
                  ${projects.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}
                </select>
              </label>
              <label class="rt-field">${esc(t('realtime.goalStepsLabel'))}<textarea class="rt-goal-steps rt-text-input" rows="4" maxlength="4000" spellcheck="false"></textarea></label>
              <button type="submit" class="btn btn-primary">${esc(t('realtime.agendaSave'))}</button>
            </form>
          </details>
          ${closed.length ? `<details class="rt-goal-closed"><summary>${esc(t('realtime.goalsClosed', { count: closed.length }))}</summary>
            <ul class="rt-list rt-goal-list">${closed.map(goal => this.renderGoal(goal, today)).join('')}</ul></details>` : ''}
        </section>
        <section class="rt-card">
          <h3>${esc(t('realtime.workTitle'))}</h3>
          <p class="rt-hint">${esc(t('realtime.workHint'))}</p>
          ${activity}
        </section>`;
    },

    /** A click in the agenda's page; true when it was for the agenda. */
    async onAgendaClick(e) {
      const target = e.target.closest('button, input[type="checkbox"]');
      const action = target?.dataset.action;
      if (!action) return false;
      const goalId = target.dataset.goal || target.closest('[data-goal]')?.dataset.goal;
      const s = window.chatStorage;
      this.agendaNote = '';
      try {
        const waiting = target.closest('[data-agenda]')?.dataset.agenda;
        if (action === 'agenda-accept') {
          const item = await s.saveAgenda({ proposed: false }, waiting);
          this.calendarDay = item.start_at.slice(0, 10);
        } else if (action === 'agenda-refuse') await s.deleteAgenda(waiting);
        else if (action === 'agenda-done') await s.saveAgenda({ done: target.checked }, target.dataset.id);
        else if (action === 'agenda-delete') await s.deleteAgenda(target.dataset.id);
        else if (action === 'goal-open') { this.openGoal = this.openGoal === goalId ? null : goalId; this.renderSide(); return true; }
        else if (action === 'goal-show') {
          this.openGoal = goalId;
          this.renderSide();
          this.ui.side.querySelector(`.rt-goal[data-goal="${goalId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          return true;
        } else if (action === 'step-done') await s.saveGoalStep(goalId, { done: target.checked }, target.dataset.id);
        else if (action === 'step-delete') await s.deleteGoalStep(goalId, target.dataset.id);
        else if (action === 'step-confirm' || action === 'step-refuse') {
          const stepId = target.closest('[data-step]').dataset.step;
          await s.saveGoalStep(goalId, action === 'step-confirm' ? { done: true } : { proposedDay: null }, stepId);
        } else if (action === 'goal-status') await s.saveGoal({ status: target.dataset.status }, goalId);
        else if (action === 'goal-delete') {
          const goal = this.goals.find(g => g.id === goalId);
          const ok = await window.chatWorkspace.confirmAction({
            title: t('realtime.goalDeleteTitle'),
            message: t('realtime.goalDeleteMessage', { name: goal?.name || '' }),
            confirmText: t('realtime.habitDelete')
          });
          if (!ok) return true;
          await s.deleteGoal(goalId);
          this.openGoal = null;
        } else return false;
      } catch (err) {
        this.agendaNote = t('realtime.error', { error: err.message });
      }
      await Promise.all([this.loadAgenda(), this.loadCalendar()]);
      return true;
    },

    /** A form of the agenda's page sent; true when it was one of them. */
    async onAgendaSubmit(e) {
      const form = e.target.closest('.rt-agenda-form, .rt-step-add, .rt-goal-edit');
      if (!form) return false;
      e.preventDefault();
      const s = window.chatStorage;
      const value = (sel) => form.querySelector(sel)?.value || '';
      this.agendaNote = '';
      try {
        if (form.classList.contains('rt-goal-add')) {
          const goal = await s.saveGoal({
            name: value('.rt-goal-name').trim(),
            dueDay: value('.rt-goal-due') || null,
            projectId: value('.rt-goal-project') || null,
            steps: value('.rt-goal-steps').split('\n').map(x => x.trim()).filter(Boolean)
          });
          this.openGoal = goal.id;
        } else if (form.classList.contains('rt-step-add')) {
          await s.saveGoalStep(form.dataset.goal, { title: value('.rt-step-title').trim(), dueDay: value('.rt-step-due') || null });
        } else if (form.classList.contains('rt-goal-edit')) {
          await s.saveGoal({
            name: value('.rt-goal-name').trim(),
            dueDay: value('.rt-goal-due') || null,
            projectId: value('.rt-goal-project') || null,
            notes: value('.rt-goal-notes').trim()
          }, form.dataset.goal);
        } else {
          const kind = value('.rt-agenda-kind');
          await s.saveAgenda({
            kind,
            title: value('.rt-agenda-title-input'),
            startAt: value('.rt-agenda-start').slice(0, 16),
            endAt: kind === 'activity' ? (value('.rt-agenda-end').slice(0, 16) || null) : null
          });
        }
      } catch (err) {
        this.agendaNote = t('realtime.error', { error: err.message });
      }
      await Promise.all([this.loadAgenda(), this.loadCalendar()]);
      return true;
    },

    /* -------------------------------------------------------------- */
    /* Goals for the models                                             */
    /* -------------------------------------------------------------- */

    /** The open goals as a model is shown them: each with a short id, its steps with theirs. ids: short id -> { goal, step }. */
    knownGoals() {
      const ids = new Map();
      const today = dayStamp(new Date());
      const lines = [];
      this.goals.filter(g => g.status === 'open').forEach((goal, i) => {
        const gid = `g${i + 1}`;
        ids.set(gid, { goal });
        const p = W.goalProgress(goal, today);
        lines.push(`[${gid}] ${goal.name}${goal.due_day ? ` — due ${goal.due_day}` : ''} — ${p.done} of ${p.total} steps done${goal.notes ? ` — ${goal.notes}` : ''}`);
        goal.steps.forEach((step, j) => {
          const sid = `${gid}.s${j + 1}`;
          ids.set(sid, { goal, step });
          lines.push(`  [${sid}] ${step.done ? `(done ${step.done_day || ''})` : '(open)'} ${step.title}${step.due_day && !step.done ? ` — due ${step.due_day}` : ''}`);
        });
      });
      return { ids, list: lines.join('\n') || '(none)' };
    },

    /** The question about the goals at the end of a diary session: the open ones the account does not seem to name. */
    async goalsQuestion(session) {
      const account = await this.accountOf(session.day);
      const names = this.goals.filter(g => g.status === 'open' && !W.named(g.name, account, W.keywordsOf(g))).map(g => g.name);
      if (!names.length) return '';
      const today = session.day === dayStamp(new Date());
      return t(today ? 'realtime.diarySayGoals' : 'realtime.diarySayGoalsDay', { list: names.join(', ') });
    },

    /** What the Master said of the goals' steps for a day: each becomes a proposal for the user, never a step closed. */
    async applyGoals(goals, ids, day) {
      const list = Array.isArray(goals?.steps_done) ? goals.steps_done : [];
      for (const item of list) {
        const found = ids.get(String(item?.id || ''));
        if (!found?.step || found.step.done) continue;
        try {
          await window.chatStorage.saveGoalStep(found.goal.id, { proposedDay: day, proposedWhy: String(item.why || '').trim().slice(0, 600) }, found.step.id);
        } catch {}
      }
      if (list.length) await this.loadGoals();
    },

    /** The work recorded in the app on a day, as the Master is shown it: the titles of the steps, by project. */
    async workOfDay(day) {
      let steps = [];
      try { steps = await window.chatStorage.activityOfDay(day); } catch {}
      if (!steps.length) return '(nothing recorded)';
      const byProject = new Map();
      steps.forEach(step => { if (!byProject.has(step.project)) byProject.set(step.project, []); byProject.get(step.project).push(step); });
      return [...byProject].map(([project, list]) => `${project} (${list.length} steps): ${[...new Set(list.map(x => x.title).filter(Boolean))].slice(0, 40).join('; ')}`).join('\n');
    },

    /** The goals and the activity of a period in words, for a model. */
    async goalsText(from, to) {
      await this.loadGoals();
      const days = W.daysBetween(from, to);
      let activity = null;
      try { activity = await window.chatStorage.activity(from, to); } catch {}
      const w = W.activityTotals(activity, days);
      const today = dayStamp(new Date());
      const lines = [`Work recorded in the app from ${from} to ${to}: ${w.totals.own} steps by the user and ${w.totals.model} by models in the Code projects, ${w.totals.messages} messages written in the chats, on ${w.totals.activeDays} of ${days.length} days.`];
      const rest = W.pausesTotals(activity, days);
      if (rest.count) lines.push(`Pauses from work taken with the app's timer: ${rest.count}, on ${rest.days} days, ${rest.minutes} minutes in all.`);
      w.projects.filter(p => p.steps || p.messages).forEach(p => lines.push(`- project ${p.name}: ${p.steps} steps, ${p.messages} messages, ${p.activeDays} days`));
      const open = this.goals.filter(g => g.status === 'open');
      lines.push(open.length ? 'Open goals:' : 'No open goal.');
      open.forEach(goal => {
        const p = W.goalProgress(goal, today);
        const closed = goal.steps.filter(s => s.done && s.done_day >= from && s.done_day <= to).map(s => s.title);
        lines.push(`- ${goal.name}: ${p.done} of ${p.total} steps done${goal.due_day ? `, due ${goal.due_day} (${p.daysLeft} days from today)` : ''}${p.estimate ? `, at the pace of the last four weeks it ends on ${p.estimate}` : ''}${p.late ? ', LATE' : ''}${closed.length ? `; closed in the period: ${closed.join('; ')}` : '; no step closed in the period'}${p.next ? `; next step: ${p.next.title}` : ''}`);
      });
      this.goals.filter(g => g.status !== 'open' && g.closed_day >= from && g.closed_day <= to)
        .forEach(goal => lines.push(`- ${goal.name}: ${goal.status === 'done' ? 'reached' : 'given up'} on ${goal.closed_day}`));
      return lines.join('\n');
    },

    /** The goals as the character is told them at every exchange: a line each. */
    goalsPrompt() {
      const today = dayStamp(new Date());
      const open = this.goals.filter(g => g.status === 'open');
      if (!open.length) return 'Nessun obiettivo aperto.';
      return open.slice(0, 20).map(goal => {
        const p = W.goalProgress(goal, today);
        return `[${goal.id}] ${goal.name}${goal.due_day ? ` — scadenza ${goal.due_day}` : ''} — tappe ${p.done}/${p.total}${p.next ? ` — prossima: ${p.next.title}` : ''}`;
      }).join('\n');
    }
  });
})();
