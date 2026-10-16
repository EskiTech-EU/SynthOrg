/**
 * SynthOrg - Realtime, the notices.
 *
 * The character shows up while the user works, small, with a few words and
 * two or three buttons:
 *   stuck   — only one file saved, again and again, for an hour;
 *   long    — two hours of work without a pause;
 *   due     — a step of the open project's goals is due, or late;
 *   late    — working in the hours the user chose not to (from an hour to
 *             another, midnight to five in the morning to start with);
 *   advice  — an exchange with a model going badly (the same request said
 *             again, corrections one after the other, answers stopped, a
 *             hard tone): a word on how to ask.
 * Thresholds and switches are the user's (Realtime settings, Notices).
 *
 * What decides a notice is worked out on this computer from what the app
 * records anyway — the steps of the project, the moments the user wrote, the
 * way the last messages are written: no model reads the work as it goes.
 * Only for the advice, and only when those signs pass their threshold, the
 * Master is asked once, on the user's last six messages, whether a word
 * would help and which: a wrong piece of advice is worse than none. At most
 * twice a day, and it can be switched off (the words are then fixed ones).
 *
 * A pause accepted starts a timer; at its end the character calls the user
 * back. Pauses are recorded, with how long they lasted.
 *
 * In the Code tab the notice is a strip of the page, above the editor: the
 * editor of a local project is painted over the page, and makes room for
 * what is part of the page's flow. The advice is a strip above the chat's
 * input. Only the clock of a pause, on the tabs without a place for a strip,
 * is a small card in a corner.
 */
(function () {
  'use strict';

  const rt = window.realtime._state;
  const { t, esc, dayStamp } = window.realtime._util;
  const W = window.RealtimeWellbeing;

  const DEFAULTS = Object.freeze({
    on: true,
    stuck: true, stuckMinutes: 60,
    long: true, longMinutes: 120,
    due: true,
    late: true, lateFrom: '00:00', lateTo: '05:00',
    advice: true, confirm: true,
    gapMinutes: 45,       // between a notice and the next, whatever they are about
    pauseMinutes: 10,     // a pause that is not one of the liked ones
    voice: false
  });
  const LOOK_MS = 60000;           // how often the work is looked at
  const WORK_GAP = 15;             // minutes without doing anything that end a stretch of work
  const LATER_MINUTES = 15;        // "in a quarter of an hour"
  const ADVICE_POINTS = 4;         // signs of an exchange going badly past which a word is considered
  const ADVICE_HOURS = 3;          // between a piece of advice and the next
  const ADVICE_A_DAY = 2;
  const ADVICE_WAIT = 30 * 60000;  // after the Master said no advice is needed, before the signs are looked at again
  const LONG_CHAT = 150000;        // characters of a chat past which starting a new one is worth saying
  const STALE_MS = 10 * 60000;     // a notice the user was not there to see is dropped after this

  const number = (value, least, most, fallback) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= least && n <= most ? n : fallback;
  };

  Object.assign(rt, {
    notices: { ...DEFAULTS },
    notice: null,          // the one on screen: { id, kind, text, actions, pause, at }
    pause: null,           // the pause under way: { id, until, what }
    likedPauses: [],
    noticeTimer: null,
    pauseTimer: null,
    adviceChecked: 0,
    stops: new Map(),      // chat -> when its answers were stopped by the user, in this run of the app

    /* -------------------------------------------------------------- */
    /* Settings                                                         */
    /* -------------------------------------------------------------- */

    async loadNotices() {
      let saved = {};
      try { saved = JSON.parse((await window.chatStorage.getSetting('realtime_notices'))?.value || '{}'); } catch {}
      const flag = (key) => (typeof saved[key] === 'boolean' ? saved[key] : DEFAULTS[key]);
      this.notices = {
        on: flag('on'), stuck: flag('stuck'), long: flag('long'), due: flag('due'), late: flag('late'),
        advice: flag('advice'), confirm: flag('confirm'), voice: flag('voice'),
        stuckMinutes: number(saved.stuckMinutes, 10, 600, DEFAULTS.stuckMinutes),
        longMinutes: number(saved.longMinutes, 20, 720, DEFAULTS.longMinutes),
        gapMinutes: number(saved.gapMinutes, 5, 600, DEFAULTS.gapMinutes),
        pauseMinutes: number(saved.pauseMinutes, 1, 240, DEFAULTS.pauseMinutes),
        lateFrom: /^\d{2}:\d{2}$/.test(saved.lateFrom || '') ? saved.lateFrom : DEFAULTS.lateFrom,
        lateTo: /^\d{2}:\d{2}$/.test(saved.lateTo || '') ? saved.lateTo : DEFAULTS.lateTo
      };
      try { this.likedPauses = await window.chatStorage.likedPauses(); } catch { this.likedPauses = []; }
    },

    async saveNotices(changes) {
      this.notices = { ...this.notices, ...changes };
      // Only what differs from how it starts out is kept: the rest follows the defaults.
      const own = Object.fromEntries(Object.entries(this.notices).filter(([key, value]) => DEFAULTS[key] !== value));
      await window.chatStorage.setSetting('realtime_notices', Object.keys(own).length ? JSON.stringify(own) : '');
    },

    /* -------------------------------------------------------------- */
    /* Words                                                            */
    /* -------------------------------------------------------------- */

    /** A stretch of time as it is said: "un'ora e 10 minuti". */
    timeText(minutes) {
      const { hours, minutes: rest } = W.duration(minutes);
      const h = hours ? t(hours === 1 ? 'realtime.timeHour' : 'realtime.timeHours', { n: hours }) : '';
      const m = rest || !hours ? t(rest === 1 ? 'realtime.timeMinute' : 'realtime.timeMinutes', { n: rest }) : '';
      return h && m ? t('realtime.timeAnd', { hours: h, minutes: m }) : h || m;
    },

    /** The pause to propose: of the ones the user likes, the one proposed longest ago; without any, a pause and nothing more. */
    nextPause() {
      const liked = this.likedPauses.filter(p => p.status === 'liked')
        .sort((a, b) => String(a.offered_at || '').localeCompare(String(b.offered_at || '')));
      const pick = liked[0] || null;
      return pick
        ? { liked: pick.id, what: pick.name, minutes: pick.minutes, text: t('realtime.noticePauseLiked', { what: pick.name, time: this.timeText(pick.minutes) }) }
        : { liked: null, what: '', minutes: this.notices.pauseMinutes, text: t('realtime.noticePause', { time: this.timeText(this.notices.pauseMinutes) }) };
    },

    /* -------------------------------------------------------------- */
    /* Looking at the work                                              */
    /* -------------------------------------------------------------- */

    shown() {
      return ['realtime', 'chat', 'code', 'settings'].find(name => document.getElementById(`tab-btn-${name}`)?.classList.contains('active')) || 'chat';
    },

    /** Whether this is a moment a notice may come: nothing being generated, said or asked, nothing open over the page. */
    quiet() {
      return !window.chatManager?.isGenerating && !this.busy && !this.diarySession && !this.player?.playing
        && !document.querySelector('dialog[open], .onb-root:not([hidden]), #modal-key-backdrop.open, #drawer-backdrop.open');
    },

    /**
     * What today's notices allow: nothing within the gap from the last one;
     * nothing of a kind the user said "not today" to; what was put off comes
     * back after a quarter of an hour.
     */
    async allowed(now) {
      const given = await window.chatStorage.notices(dayStamp(new Date(now)));
      const last = given[0];
      const off = new Set(given.filter(n => n.answer === 'today').map(n => n.kind));
      const later = given.find(n => n.answer === 'later');
      const putOff = later && last && later.id === last.id ? later : null;
      const since = last ? (now - Date.parse(last.answered_at || last.at)) / 60000 : Infinity;
      return {
        given, off,
        // Put off: it may come back after its quarter of an hour. Otherwise the gap holds.
        free: putOff ? since >= LATER_MINUTES : since >= this.notices.gapMinutes,
        again: putOff && since >= LATER_MINUTES ? putOff.kind : null,
        has: (kind, projectId = null) => given.some(n => n.kind === kind && (!projectId || n.project_id === projectId))
      };
    },

    /** Whether a notice of a kind was given from a moment on: today's and, for a moment of yesterday, yesterday's. */
    async saidSince(kind, moment) {
      const days = [...new Set([dayStamp(new Date(moment)), dayStamp(new Date())])];
      for (const day of days) {
        const given = await window.chatStorage.notices(day);
        if (given.some(n => n.kind === kind && Date.parse(n.at) >= moment - 60000)) return true;
      }
      return false;
    },

    /** The work on the project open in the Code tab, looked at; a notice is given when there is one to give. */
    async look() {
      const cfg = this.notices;
      if (!cfg.on || this.notice || this.pause || this.looking || this.shown() !== 'code' || !this.quiet()) return null;
      const project = window.codeWorkspace?.current?.();
      if (!project) return null;
      this.looking = true;
      try {
        const signals = await window.chatStorage.signals(project.id, 8);
        const now = Date.parse(signals.now);
        const allowed = await this.allowed(now);
        if (!allowed.free) return null;
        const may = (kind) => cfg[kind] && !allowed.off.has(kind);
        // A step due: said once a day for a project, working or not.
        if (may('due') && !allowed.has('due', project.id)) {
          await this.loadGoals();
          const due = W.dueSoon(this.goals, project.id, dayStamp(new Date(now)));
          if (due.length) return this.give('due', project, this.dueText(project, due), ['ok', 'agenda', 'today']);
        }
        const steps = signals.steps.filter(s => s.source !== 'agent').map(s => ({ at: Date.parse(s.at), title: s.title, files: s.files }));
        const moments = [...steps.map(s => s.at), ...signals.messages.map(m => Date.parse(m.at))];
        const pauses = signals.pauses.map(p => ({ from: Date.parse(p.started_at), to: p.ended_at ? Date.parse(p.ended_at) : null }));
        const span = W.workSpan(moments, now, { gap: WORK_GAP, pauses });
        if (!span) return null;
        const hours = may('late') ? W.inHours(new Date(now), cfg.lateFrom, cfg.lateTo) : { inside: false };
        // Once for each time the hours come round: a range that goes past midnight is one, not two.
        if (hours.inside && !(await this.saidSince('late', now - hours.since * 60000))) {
          const hour = new Date(now).toLocaleTimeString(window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT', { hour: '2-digit', minute: '2-digit' });
          return this.give('late', project, t('realtime.noticeLate', { hour, from: cfg.lateFrom, to: cfg.lateTo, project: project.name, time: this.timeText(span.minutes) }), ['ok', 'today']);
        }
        const stuck = may('stuck') ? W.stuckOn(steps, span, now) : null;
        if (stuck && stuck.minutes >= cfg.stuckMinutes) {
          const pause = this.nextPause();
          return this.give('stuck', project, `${t('realtime.noticeStuck', { file: stuck.file, time: this.timeText(stuck.minutes) })} ${pause.text}`, ['pause', 'later', 'today'], pause);
        }
        if (may('long') && span.minutes >= cfg.longMinutes) {
          const pause = this.nextPause();
          return this.give('long', project, `${t('realtime.noticeLong', { time: this.timeText(span.minutes) })} ${pause.text}`, ['pause', 'later', 'today'], pause);
        }
        return null;
      } catch {
        return null;
      } finally {
        this.looking = false;
      }
    },

    dueText(project, due) {
      const first = due[0];
      const what = first.whole ? t('realtime.noticeDueGoal', { goal: first.goal }) : t('realtime.noticeDueStep', { step: first.title, goal: first.goal });
      const more = due.length > 1 ? ` ${t(due.length === 2 ? 'realtime.noticeDueOther' : 'realtime.noticeDueOthers', { count: due.length - 1 })}` : '';
      return `${t('realtime.noticeDue_' + first.when, { what })}${more}`;
    },

    /** A notice given: written down, shown, said when the voice is on. */
    async give(kind, project, text, actions, pause = null) {
      let saved = null;
      try { saved = await window.chatStorage.recordNotice({ kind, projectId: project?.id || null, detail: text }); } catch { return null; }
      if (pause?.liked) window.chatStorage.saveLikedPause({ offered: true }, pause.liked).then(() => this.loadNotices()).catch(() => {});
      this.notice = { id: saved.id, kind, text, actions, pause, project: project?.id || null, at: Date.now() };
      try { window.playNotificationSound?.(); } catch {}
      this.renderNotice();
      this.sayNotice(text);
      return this.notice;
    },

    sayNotice(text) {
      if (!this.notices.voice || !window.realtime.voice?.available?.()) return;
      window.realtime.voice.say(text, window.mascot?.puppet || null).catch(() => {});
    },

    async answerNotice(answer) {
      const notice = this.notice;
      if (!notice) return;
      this.notice = null;
      window.realtime.voice?.stop?.();
      // "agenda" is a way of saying ok that also opens the agenda.
      try { await window.chatStorage.answerNotice(notice.id, answer === 'agenda' ? 'ok' : answer); } catch {}
      if (answer === 'pause') await this.startPause(notice.pause, notice);
      if (answer === 'agenda') {
        window.switchView?.('realtime');
        this.sideTab = 'agenda';
        this.renderSide();
      }
      this.renderNotice();
    },

    /* -------------------------------------------------------------- */
    /* The pause                                                        */
    /* -------------------------------------------------------------- */

    async startPause(pause, notice = null) {
      const minutes = pause?.minutes || this.notices.pauseMinutes;
      try {
        const saved = await window.chatStorage.startPause({ minutes, what: pause?.what || '', reason: notice?.kind || 'user', projectId: notice?.project || null });
        this.pause = { id: saved.id, until: Date.parse(saved.started_at) + minutes * 60000, what: saved.what, minutes };
      } catch { this.pause = null; }
      this.renderNotice();
      this.tickPause();
    },

    /** The pause under way when the app was closed: taken up again, or ended when its time is past. */
    async resumePause() {
      try {
        const open = (await window.chatStorage.openPause()).pause;
        if (!open) return;
        const until = Date.parse(open.started_at) + open.minutes * 60000;
        if (until + STALE_MS < Date.now()) { await window.chatStorage.endPause(open.id); return; }
        this.pause = { id: open.id, until, what: open.what, minutes: open.minutes };
        this.renderNotice();
        this.tickPause();
      } catch {}
    },

    tickPause() {
      clearInterval(this.pauseTimer);
      if (!this.pause) return;
      this.pauseTimer = setInterval(() => {
        if (!this.pause) { clearInterval(this.pauseTimer); return; }
        if (!this.pause.over && Date.now() >= this.pause.until) {
          // Its time is up: the character calls the user back, and waits to be told they are back.
          this.pause.over = true;
          try { window.playNotificationSound?.(); } catch {}
          this.renderNotice();
          this.sayNotice(t('realtime.pauseOver'));
        } else if (!this.pause.over) {
          const clock = this.noticeBox?.querySelector('.rt-notice-clock');
          if (clock) clock.textContent = this.pauseClock();
        }
      }, 1000);
    },

    pauseClock() {
      const left = Math.max(0, Math.ceil((this.pause.until - Date.now()) / 1000));
      return `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    },

    async endPause() {
      const pause = this.pause;
      if (!pause) return;
      this.pause = null;
      clearInterval(this.pauseTimer);
      window.realtime.voice?.stop?.();
      try { await window.chatStorage.endPause(pause.id); } catch {}
      this.renderNotice();
      if (this.sideTab === 'wellbeing') this.loadWellbeing();
      else this.renderSide();
    },

    /* -------------------------------------------------------------- */
    /* On screen                                                        */
    /* -------------------------------------------------------------- */

    /** The notice, or the pause's clock, where the user is: a strip above the editor in Code, a card in a corner elsewhere. */
    renderNotice() {
      if (!this.noticeBox) {
        const box = document.createElement('div');
        box.className = 'rt-notice';
        box.setAttribute('role', 'status');
        box.setAttribute('aria-live', 'polite');
        box.hidden = true;
        // The character has no puppet of its own here: it comes hopping and lands in the place kept for it.
        box.innerHTML = '<div class="rt-notice-puppet mo-slot"></div><div class="rt-notice-body"></div>';
        box.addEventListener('click', (e) => {
          const action = e.target.closest('[data-notice]')?.dataset.notice;
          if (action === 'back') this.endPause();
          else if (action) this.answerNotice(action);
        });
        this.noticeBox = box;
        this.noticeSlot = box.querySelector('.rt-notice-puppet');
      }
      const box = this.noticeBox;
      const view = this.shown();
      // A notice is about the work in Code or about a chat: it shows where that is, as a strip of the
      // page (above the editor, above the chat's input). The pause's clock shows everywhere: on the
      // tabs that have no place for a strip it is a small card in a corner.
      const advice = !this.pause && this.notice?.kind === 'advice';
      const here = this.pause ? true : this.notice ? (advice ? ['chat', 'code'].includes(view) : view === 'code') : false;
      const host = !here ? null
        : advice || view === 'chat' ? document.getElementById('chat-notice')
        : view === 'code' ? document.getElementById('code-notice')
        : document.body;
      if (!host) {
        box.hidden = true;
        if (box.parentNode && box.parentNode !== document.body) box.remove();
        window.mascot?.release(this.noticeSlot);
        return;
      }
      if (box.parentNode !== host) host.appendChild(box);
      box.classList.toggle('is-strip', host !== document.body);
      box.classList.toggle('is-floating', host === document.body);
      const body = box.querySelector('.rt-notice-body');
      const button = (action, primary = false) => `<button type="button" class="btn${primary ? ' btn-primary' : ''}" data-notice="${action}">${esc(t('realtime.noticeAnswer_' + action))}</button>`;
      if (this.pause) {
        const what = this.pause.what ? t('realtime.pauseWhat', { what: this.pause.what }) : t('realtime.pauseTitle');
        body.innerHTML = this.pause.over
          ? `<p class="rt-notice-text">${esc(t('realtime.pauseOver'))}</p><div class="rt-notice-actions">${button('back', true)}</div>`
          : `<p class="rt-notice-text"><strong class="rt-notice-clock">${esc(this.pauseClock())}</strong> ${esc(what)}</p><div class="rt-notice-actions">${button('back')}</div>`;
        window.mascot?.puppet?.setState(this.pause.over ? 'happy' : 'idle');
      } else {
        body.innerHTML = `<p class="rt-notice-text">${esc(this.notice.text)}</p>
          <div class="rt-notice-actions">${this.notice.actions.map((action, i) => button(action, i === 0)).join('')}</div>`;
        window.mascot?.puppet?.setState('speaking');
        setTimeout(() => { if (this.notice) window.mascot?.puppet?.setState('idle'); }, 2500);
      }
      box.hidden = false;
      window.mascot?.dock(this.noticeSlot);
    },

    /* -------------------------------------------------------------- */
    /* An exchange going badly                                          */
    /* -------------------------------------------------------------- */

    /**
     * The user wrote to a model in a chat: the way the last messages are
     * written is looked at, here, without a model. Past the threshold, and
     * within what a day allows, a word of advice is given: the Master's, asked
     * once on the last six messages, or a fixed one.
     */
    async weigh(conversationId) {
      const cfg = this.notices;
      if (!cfg.on || !cfg.advice || this.notice || this.pause || this.weighing) return null;
      if (conversationId === this.conversationId || conversationId === this.tasksConversationId) return null;
      const chat = window.chatManager;
      if (chat?.conversation?.id !== conversationId) return null;
      const now = Date.now();
      if (now - this.adviceChecked < ADVICE_WAIT) return null;
      const messages = (chat.messages || []).filter(m => m.kind !== 'execution' && ['user', 'assistant'].includes(m.role))
        .map(m => ({ role: m.role, content: String(m.content || ''), status: m.status, at: Date.parse(m.timestamp) }));
      // An answer stopped by the user is kept as any other: that it was stopped is known here, from the button.
      const stops = (this.stops.get(conversationId) || []).filter(at => now - at < 3600000);
      this.stops.set(conversationId, stops);
      const found = W.friction([...messages, ...stops.map(at => ({ role: 'assistant', content: '', status: 'interrupted', at }))], now);
      const size = messages.reduce((n, m) => n + m.content.length, 0);
      const sign = found.points >= ADVICE_POINTS ? found.sign : size > LONG_CHAT ? 'long' : null;
      if (!sign) return null;
      this.weighing = true;
      try {
        const given = (await window.chatStorage.notices(dayStamp(new Date(now)))).filter(n => n.kind === 'advice');
        if (given.some(n => n.answer === 'today') || given.length >= ADVICE_A_DAY) return null;
        if (given[0] && now - Date.parse(given[0].at) < ADVICE_HOURS * 3600000) return null;
        this.adviceChecked = now;
        let text = t('realtime.advice_' + sign);
        if (cfg.confirm) {
          // The requests of a day are counted, whatever the Master answered: a day of false alarms costs two of them, not more.
          const today = dayStamp(new Date(now));
          let asked = {};
          try { asked = JSON.parse((await window.chatStorage.getSetting('realtime_advice_asked'))?.value || '{}'); } catch {}
          const count = asked.day === today ? Number(asked.count) || 0 : 0;
          if (count >= ADVICE_A_DAY) return null;
          await window.chatStorage.setSetting('realtime_advice_asked', JSON.stringify({ day: today, count: count + 1 }));
          const tip = await this.advice(messages, found, sign);
          if (!tip) return null;
          text = tip;
        }
        // Said when the model has finished answering: not over its words.
        for (let i = 0; i < 450 && !this.quiet(); i++) await new Promise(resolve => setTimeout(resolve, 2000));
        if (!this.quiet() || this.notice || this.pause || chat.conversation?.id !== conversationId) return null;
        return this.give('advice', null, text, ['ok', 'today']);
      } catch {
        return null;
      } finally {
        this.weighing = false;
      }
    },

    /** The Master's word on an exchange: the advice to give, or nothing when none would help. One short request. */
    advice(messages, found, sign) {
      const last = messages.slice(-12);
      const said = last.map(m => (m.role === 'user'
        ? `[User] ${m.content.slice(0, 500)}`
        : `[Assistant${m.status === 'interrupted' ? ', stopped by the user' : m.status === 'error' ? ', ended with an error' : ''}] ${m.content.replace(/\s+/g, ' ').slice(0, 120)}`)).join('\n');
      return this.job('advice', async () => {
        const reply = await this.master('advice', {
          json: true,
          stable: [
            'You are given the last messages a user wrote to an AI assistant while working, with the first line of each answer. A check made without a model found signs that the exchange is going badly. Decide whether a word of advice on how to ask would help the user get better answers, and give it.',
            'The advice is one or two short sentences, in the language the user writes in, friendly and practical: say what was expected and what came instead; paste the text of the error; one request at a time; a constructive tone gets better answers from a model than a hard one; when a chat has grown long, start a new one with a summary. It is about how to ask, never about the user: no reproach, nothing on their character or mood.',
            'No advice when the signs are a false alarm: corrections that are working, code or names written in capitals, a hard word quoted from a text, a user who is plainly fine.',
            'Reply only with JSON: {"advise": true or false, "tip": "the advice, or an empty text"}'
          ].join('\n\n'),
          user: `Signs found: ${Object.entries(found.signs).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || sign}\n\nMessages:\n${said}`
        });
        let data = null;
        try { data = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)); } catch {}
        const tip = String(data?.tip || '').trim().slice(0, 400);
        return data?.advise === true && tip ? tip : null;
      }).catch(() => null);
    },

    /* -------------------------------------------------------------- */
    /* The settings' page                                             */
    /* -------------------------------------------------------------- */

    renderSettings_notices() {
      const cfg = this.notices;
      const toggle = (key, title, hint, extra = '') => `<div class="rt-switch-row">
          <label class="synth-toggle-wrapper"><span class="synth-switch"><input type="checkbox" class="rt-notice-flag" data-key="${key}" ${cfg[key] ? 'checked' : ''}><span class="synth-slider"></span></span>
            <span><strong>${esc(t(title))}</strong><small>${esc(t(hint))}</small></span></label>
          ${extra}
        </div>`;
      const minutes = (key, label, least, most) => `<label class="rt-field rt-field-inline">${esc(t(label))}
          <input type="number" class="rt-notice-number" data-key="${key}" min="${least}" max="${most}" step="5" value="${cfg[key]}"></label>`;
      const option = (value, label, current) => `<option value="${value}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
      const liked = this.likedPauses.map(p => `<li>
        <form class="rt-habit-form rt-pause-form" data-id="${esc(p.id)}">
          <input type="text" class="rt-pause-name" maxlength="80" value="${esc(p.name)}" aria-label="${esc(t('realtime.pauseNameLabel'))}" required>
          <label class="rt-field rt-field-inline">${esc(t('realtime.pauseMinutesLabel'))}<input type="number" class="rt-pause-minutes" min="1" max="240" value="${p.minutes}"></label>
          <select class="rt-pause-status select-control" aria-label="${esc(t('realtime.habitStatusLabel'))}">
            ${['liked', 'proposed', 'dismissed'].map(s => option(s, t('realtime.pauseStatus_' + s), p.status)).join('')}
          </select>
          ${p.why ? `<p class="rt-hint rt-habit-notes">«${esc(p.why)}»</p>` : ''}
          <div class="rt-row">
            <button type="submit" class="btn btn-primary">${esc(t('realtime.save'))}</button>
            <button type="button" class="btn btn-danger-outline" data-action="pause-delete" data-id="${esc(p.id)}">${esc(t('realtime.habitDelete'))}</button>
            <span class="rt-hint">${esc(t(p.source === 'model' ? 'realtime.habitFromModel' : 'realtime.habitFromUser'))}</span>
          </div>
        </form>
      </li>`).join('');
      return `
        <section class="rt-set-block">
          <h3>${esc(t('realtime.noticesTitle'))}</h3>
          <p class="rt-hint">${esc(t('realtime.noticesHint', { name: this.displayName() }))}</p>
          ${this.settingsNote ? `<p class="rt-hint" role="status">${esc(this.settingsNote)}</p>` : ''}
          ${toggle('on', 'realtime.noticeOn', 'realtime.noticeOnHint')}
          <fieldset class="rt-notice-kinds" ${cfg.on ? '' : 'disabled'}>
            ${window.sections?.on('code') === false ? '' : `
            \${toggle('stuck', 'realtime.noticeKind_stuck', 'realtime.noticeKindHint_stuck', minutes('stuckMinutes', 'realtime.noticeAfterMinutes', 10, 600))}
            \${toggle('long', 'realtime.noticeKind_long', 'realtime.noticeKindHint_long', minutes('longMinutes', 'realtime.noticeAfterMinutes', 20, 720))}
            \${toggle('due', 'realtime.noticeKind_due', 'realtime.noticeKindHint_due')}
            \${toggle('late', 'realtime.noticeKind_late', 'realtime.noticeKindHint_late',
              \`<span class="rt-row"><label class="rt-field rt-field-inline">\${esc(t('realtime.noticeLateFrom'))}<input type="time" class="rt-notice-time" data-key="lateFrom" value="\${esc(cfg.lateFrom)}"></label>
              <label class="rt-field rt-field-inline">\${esc(t('realtime.noticeLateTo'))}<input type="time" class="rt-notice-time" data-key="lateTo" value="\${esc(cfg.lateTo)}"></label></span>\`)}`}
            ${toggle('advice', 'realtime.noticeKind_advice', 'realtime.noticeKindHint_advice')}
            ${toggle('confirm', 'realtime.noticeConfirm', 'realtime.noticeConfirmHint')}
            ${toggle('voice', 'realtime.noticeVoice', 'realtime.noticeVoiceHint')}
            <div class="rt-row">
              ${minutes('gapMinutes', 'realtime.noticeGap', 5, 600)}
              ${minutes('pauseMinutes', 'realtime.noticePauseLength', 1, 240)}
            </div>
          </fieldset>
        </section>
        <section class="rt-set-block">
          <h3>${esc(t('realtime.pausesTitle'))} <span class="rt-count">${this.likedPauses.filter(p => p.status === 'liked').length}</span></h3>
          <p class="rt-hint">${esc(t('realtime.pausesHint'))}</p>
          ${liked ? `<ul class="rt-list rt-habit-forms">${liked}</ul>` : `<p class="rt-hint">${esc(t('realtime.pausesEmpty'))}</p>`}
          <form class="rt-habit-form rt-pause-form rt-pause-add">
            <input type="text" class="rt-pause-name" maxlength="80" placeholder="${esc(t('realtime.pauseNamePlaceholder'))}" aria-label="${esc(t('realtime.pauseNameLabel'))}" required>
            <label class="rt-field rt-field-inline">${esc(t('realtime.pauseMinutesLabel'))}<input type="number" class="rt-pause-minutes" min="1" max="240" value="${cfg.pauseMinutes}"></label>
            <div class="rt-row"><button type="submit" class="btn">${esc(t('realtime.noteAdd'))}</button></div>
          </form>
        </section>`;
    },

    /** A change or a click in the notices' page of the settings; true when it was for it. */
    async onNoticesSettings(e) {
      const target = e.target;
      try {
        if (e.type === 'change' && target.matches('.rt-notice-flag')) {
          await this.saveNotices({ [target.dataset.key]: target.checked });
        } else if (e.type === 'change' && target.matches('.rt-notice-number')) {
          const value = number(target.value, Number(target.min), Number(target.max), null);
          if (value === null) throw new Error(t('realtime.noticeNumber', { least: target.min, most: target.max }));
          await this.saveNotices({ [target.dataset.key]: value });
        } else if (e.type === 'change' && target.matches('.rt-notice-time')) {
          if (!/^\d{2}:\d{2}$/.test(target.value)) throw new Error(t('realtime.noticeHourWrong'));
          const range = { lateFrom: this.notices.lateFrom, lateTo: this.notices.lateTo, [target.dataset.key]: target.value };
          if (range.lateFrom === range.lateTo) throw new Error(t('realtime.noticeHoursSame'));
          await this.saveNotices({ [target.dataset.key]: target.value });
        } else if (e.type === 'click' && target.closest('[data-action=pause-delete]')) {
          await window.chatStorage.deleteLikedPause(target.closest('[data-action=pause-delete]').dataset.id);
        } else if (e.type === 'submit' && target.closest('.rt-pause-form')) {
          e.preventDefault();
          const form = target.closest('.rt-pause-form');
          await window.chatStorage.saveLikedPause({
            name: form.querySelector('.rt-pause-name').value.trim(),
            minutes: Number(form.querySelector('.rt-pause-minutes').value),
            status: form.querySelector('.rt-pause-status')?.value || 'liked'
          }, form.dataset.id || null);
        } else return false;
        this.settingsNote = t('realtime.textSaved');
      } catch (err) {
        this.settingsNote = t('realtime.error', { error: err.message });
      }
      await this.loadNotices();
      this.renderSettings(true);
      this.renderSide();
      return true;
    },

    /* -------------------------------------------------------------- */
    /* Starting up                                                      */
    /* -------------------------------------------------------------- */

    startNotices() {
      if (this.noticeTimer) return;
      this.loadNotices().then(() => this.resumePause());
      this.noticeTimer = setInterval(() => {
        // A notice nobody was there to see is not kept waiting for ever.
        if (this.notice && Date.now() - this.notice.at > STALE_MS && !this.noticeBox?.offsetParent) this.notice = null;
        this.look();
      }, LOOK_MS);
      // What is on screen follows the user from a tab to the other.
      const switched = window.switchView;
      if (typeof switched === 'function' && !switched.withNotices) {
        window.switchView = (name) => { const result = switched(name); this.renderNotice(); if (name === 'code') setTimeout(() => this.look(), 3000); return result; };
        window.switchView.withNotices = true;
      }
      // What the user writes to a model is weighed when it is written; nothing is read in between.
      const chat = window.chatManager;
      if (chat && !chat.persist.withNotices) {
        const persist = chat.persist.bind(chat);
        chat.persist = async (message, conversationId) => {
          const result = await persist(message, conversationId);
          if (message?.role === 'user' && !message.report) setTimeout(() => this.weigh(conversationId), 1500);
          return result;
        };
        chat.persist.withNotices = true;
        const stop = chat.stopGeneration.bind(chat);
        chat.stopGeneration = () => {
          const id = chat.generation?.conversationId;
          if (id && chat.canStopHere()) this.stops.set(id, [...(this.stops.get(id) || []), Date.now()]);
          return stop();
        };
      }
    }
  });

  window.realtime._notices = { DEFAULTS, ADVICE_POINTS, LONG_CHAT };
  const start = () => setTimeout(() => rt.startNotices(), 1500);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
