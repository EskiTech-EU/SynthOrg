/**
 * SynthOrg - Realtime, what the models cost and how they do.
 *
 * Every request the app makes to a model is written down by the gateway
 * (model-gateway.js) and kept by the service (server/usage.js). This file is
 * what the user sees of it in the Realtime section:
 *   - the page «Consumi»: what was spent in a period, day by day, by project
 *     and by place, and how each model did in each role — cost of a request
 *     and of a turn, time before the first word, speed, and how often its
 *     answers were stopped, corrected or taken back. Rates are shown only
 *     with enough requests to say something; there is no single score;
 *   - the character's tool usage_read, which gives it the same numbers;
 *   - the question about sharing. Nothing leaves this computer by itself:
 *     each time five dollars of spending have been recorded the user is
 *     asked, shown exactly what would go, and says yes or no. Saying no
 *     changes nothing in the app. Without somewhere to send to, nothing is
 *     asked.
 *
 * All the numbers are worked out by the service from its own rows: no model
 * is asked anything for them.
 *
 * These are methods of the section's object (realtime.js), kept in a file of
 * their own.
 */
(function () {
  'use strict';

  const rt = window.realtime._state;
  const { t, esc, dayStamp } = window.realtime._util;
  const W = window.RealtimeWellbeing;

  const PERIODS = [7, 30, 90];
  const SHARE_LOOK_MS = 5 * 60000;   // how often it is checked whether it is time to ask
  const KNOWN_ROLES = ['master', 'microtask', 'compaction', 'realtime', 'speech', 'transcription', 'image', 'video', 'music', 'computer_use', 'other'];
  const locale = () => (window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT');

  /** Money as it is written: two decimals from a dollar up, more below, so that a small cost is not a zero. */
  function money(value) {
    const v = Number(value) || 0;
    const digits = v === 0 || v >= 1 ? 2 : v >= 0.01 ? 3 : v >= 0.0001 ? 4 : 6;
    return new Intl.NumberFormat(locale(), { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits }).format(v);
  }
  const whole = (value) => Math.round(Number(value) || 0).toLocaleString(locale());
  const seconds = (ms) => (ms === null || ms === undefined ? '—' : `${(ms / 1000).toLocaleString(locale(), { maximumFractionDigits: ms < 10000 ? 1 : 0 })} s`);
  const share = (part, all) => (all ? `${Math.round(part / all * 100)}%` : '—');

  function roleName(role) {
    const [kind, name] = String(role).split(':');
    if (kind === 'tool' && name) return t('realtime.usageRole_tool', { name: name.replace(/_/g, ' ') });
    if (kind === 'job' && name) return t('realtime.usageRole_job', { name: t('realtime.job_' + name) });
    return t('realtime.usageRole_' + (KNOWN_ROLES.includes(kind) ? kind : 'other'));
  }
  const placeName = (place) => t('realtime.usagePlace_' + (['chat', 'project', 'realtime', 'tasks'].includes(place) ? place : 'other'));
  const projectKind = (project) => (!project ? '—' : `${project.languages.length ? project.languages.join(', ') : t('realtime.shareLanguagesNone')} · ${t('realtime.shareSize_' + project.size)}`);

  Object.assign(rt, {
    usagePeriod: 30,
    costs: null,          // the overview of the period
    sharing: null,        // where the sharing stands: { on, ready, due, cost, every, until, history }; on false: not a word about it
    shareDialog: null,
    shareTimer: null,

    /* -------------------------------------------------------------- */
    /* Reading                                                          */
    /* -------------------------------------------------------------- */

    async loadCosts() {
      const today = dayStamp(new Date());
      try {
        const [usage, sharing] = await Promise.all([
          window.chatStorage.usage(W.shift(today, -(this.usagePeriod - 1)), today),
          window.chatStorage.shareState()
        ]);
        this.costs = usage;
        this.sharing = sharing;
        this.usageError = '';
      } catch (err) {
        this.usageError = err.message;
      }
      this.renderSide();
    },

    /** The numbers of a model in a role, in words, for a model to read. */
    usageLine(m) {
      const parts = [`${m.runs} requests`, `$${m.cost}`];
      if (m.cost_per_turn !== null) parts.push(`$${m.cost_per_turn} a turn`);
      else if (m.cost_per_run !== null) parts.push(`$${m.cost_per_run} a request`);
      if (m.first_ms_p50 !== null) parts.push(`first word after ${Math.round(m.first_ms_p50)} ms`);
      if (m.ms_p50 !== null) parts.push(`whole answer ${Math.round(m.ms_p50)} ms`);
      if (m.tokens_per_second_p50 !== null) parts.push(`${m.tokens_per_second_p50} tokens a second`);
      if (m.enough) {
        parts.push(`errors ${share(m.errors, m.runs)}`);
        if (m.turns) parts.push(`stopped by the user ${share(m.stopped, m.turns)}`, `corrected by the user ${share(m.corrected, m.turns)}`, `taken back ${share(m.reverted, m.turns)}`);
      } else parts.push('too few requests for rates');
      return `- ${m.role}, ${m.local ? 'a model on this computer' : m.model}: ${parts.join('; ')}`;
    },

    /** A period's overview in words: what the character reads. */
    usageText(o) {
      const lines = [`Spending recorded from ${o.from} to ${o.to}: $${o.total.cost} in ${o.total.runs} requests to models (${o.total.prompt_tokens} tokens in, ${o.total.completion_tokens} out).`];
      if (o.total.unpriced) lines.push(`${o.total.unpriced} requests have no cost yet: the provider gives it some time after.`);
      if (o.byPlace.length) lines.push(`By place: ${o.byPlace.map(p => `${p.place} $${p.cost}`).join(', ')}.`);
      if (o.byProject.length) lines.push('By project:', ...o.byProject.slice(0, 12).map(p => `- ${p.name || 'a project no longer there'}: $${p.cost} in ${p.runs} requests`));
      if (o.byModel.length) lines.push('By role and model (medians; rates only with at least twenty requests):', ...o.byModel.slice(0, 30).map(m => this.usageLine(m)));
      lines.push('Costs are in US dollars, as the provider gives them. The numbers say what was spent and how the answers went, not what the work was worth.');
      return lines.join('\n');
    },

    /* -------------------------------------------------------------- */
    /* The page                                                         */
    /* -------------------------------------------------------------- */

    /** What the card on the home shows. */
    usageHome() {
      const o = this.costs;
      return {
        big: o ? esc(money(o.total.cost)) + `<small>${esc(t('realtime.usageHomeDays', { days: this.usagePeriod }))}</small>` : '—',
        small: esc(o ? t(o.total.runs === 1 ? 'realtime.usageHomeRun' : 'realtime.usageHomeRuns', { count: whole(o.total.runs) }) : t('realtime.usageLoading')),
        live: Boolean(this.sharing?.due)
      };
    },

    renderUsageBars(o) {
      const today = dayStamp(new Date());
      const days = W.daysBetween(W.shift(today, -(this.usagePeriod - 1)), today);
      const byDay = new Map(o.byDay.map(d => [d.day, d]));
      const values = days.map(day => byDay.get(day)?.cost || 0);
      const max = Math.max(...values);
      if (!max) return '';
      const label = (day) => this.dayLabel(day, { day: 'numeric', month: 'short' });
      const ticks = [0, Math.floor((days.length - 1) / 2), days.length - 1];
      return `<span class="rt-tile-label">${esc(t('realtime.usageByDay'))}</span>
        <div class="rt-bars" role="img" aria-label="${esc(t('realtime.usageByDay'))}">
          ${values.map((v, i) => `<span class="rt-bar" title="${esc(`${label(days[i])}: ${money(v)}`)}"><i style="height: ${v ? Math.max(4, Math.round(v / max * 100)) : 0}%"></i></span>`).join('')}
        </div>
        <div class="rt-bars-axis">${ticks.map((i, n) => `<span style="${n === 0 ? 'left: 0; transform: none' : n === ticks.length - 1 ? 'right: 0; transform: none' : `left: ${(i + 0.5) / values.length * 100}%`}">${esc(label(days[i]))}</span>`).join('')}</div>
        <details class="rt-table"><summary>${esc(t('realtime.tableView'))}</summary>
          <table><thead><tr><th>${esc(t('realtime.tableDay'))}</th><th>${esc(t('realtime.usageCost'))}</th><th>${esc(t('realtime.usageRuns'))}</th></tr></thead>
          <tbody>${[...o.byDay].reverse().map(d => `<tr><th>${esc(label(d.day))}</th><td>${esc(money(d.cost))}</td><td>${esc(whole(d.runs))}</td></tr>`).join('')}</tbody></table>
        </details>`;
    },

    renderUsageModel(m) {
      // A cost the provider has not given yet is not a zero.
      const waiting = m.unpriced === m.runs;
      const first = [
        waiting ? t('realtime.usageCostWaiting') : money(m.cost),
        t(m.runs === 1 ? 'realtime.usageHomeRun' : 'realtime.usageHomeRuns', { count: whole(m.runs) }),
        waiting ? '' : m.cost_per_turn !== null ? t('realtime.usagePerTurn', { cost: money(m.cost_per_turn) }) : m.cost_per_run !== null ? t('realtime.usagePerRun', { cost: money(m.cost_per_run) }) : ''
      ].filter(Boolean).join(' · ');
      const speed = [
        m.first_ms_p50 !== null ? t('realtime.usageFirst', { time: seconds(m.first_ms_p50) }) : '',
        m.ms_p50 !== null ? t('realtime.usageWhole', { time: seconds(m.ms_p50) }) : '',
        m.tokens_per_second_p50 !== null ? t('realtime.usageSpeed', { speed: whole(m.tokens_per_second_p50) }) : '',
        m.cached_share ? t('realtime.usageCached', { share: `${Math.round(m.cached_share * 100)}%` }) : ''
      ].filter(Boolean).join(' · ');
      const rates = m.enough
        ? [t('realtime.usageErrors', { share: share(m.errors, m.runs) }),
          ...(m.turns ? [t('realtime.usageStopped', { share: share(m.stopped, m.turns) }), t('realtime.usageCorrected', { share: share(m.corrected, m.turns) }), t('realtime.usageReverted', { share: share(m.reverted, m.turns) })] : [])].join(' · ')
        : t('realtime.usageFew');
      return `<li class="rt-usage-model">
        <strong>${esc(m.local ? t('realtime.usageLocal', { model: m.model.replace(/^local\//, '') }) : m.model)}</strong>
        <span class="rt-hint">${esc(first)}</span>
        ${speed ? `<span class="rt-hint">${esc(speed)}</span>` : ''}
        <span class="rt-hint">${esc(rates)}</span>
      </li>`;
    },

    renderUsageTab() {
      const periods = `<div class="rt-periods" role="group" aria-label="${esc(t('realtime.periodLabel'))}">
        ${PERIODS.map(p => `<button type="button" class="rt-period${p === this.usagePeriod ? ' is-on' : ''}" data-action="usage-period" data-period="${p}" aria-pressed="${p === this.usagePeriod}">${esc(t('realtime.periodDays', { days: p }))}</button>`).join('')}
      </div>`;
      const o = this.costs;
      if (!o) return `${periods}<section class="rt-card"><p class="rt-hint">${esc(this.usageError ? t('realtime.error', { error: this.usageError }) : t('realtime.usageLoading'))}</p></section>`;
      const roles = [...new Set(o.byModel.map(m => m.role))];
      const models = roles.map(role => `<div class="rt-usage-role">
          <span class="rt-tile-label">${esc(roleName(role))}</span>
          <ul class="rt-list">${o.byModel.filter(m => m.role === role).map(m => this.renderUsageModel(m)).join('')}</ul>
        </div>`).join('');
      const table = o.byModel.length ? `<details class="rt-table"><summary>${esc(t('realtime.tableView'))}</summary>
        <table class="rt-usage-table">
          <thead><tr><th>${esc(t('realtime.usageRoleHead'))}</th><th>${esc(t('realtime.usageModelHead'))}</th><th>${esc(t('realtime.usageRuns'))}</th><th>${esc(t('realtime.usageCost'))}</th><th>${esc(t('realtime.usageFirstHead'))}</th><th>${esc(t('realtime.usageCorrectedHead'))}</th></tr></thead>
          <tbody>${o.byModel.map(m => `<tr><th>${esc(roleName(m.role))}</th><td>${esc(m.local ? t('realtime.usageLocalShort') : m.model)}</td><td>${esc(whole(m.runs))}</td><td>${esc(money(m.cost))}</td><td>${esc(seconds(m.first_ms_p50))}</td><td>${esc(m.enough && m.turns ? share(m.corrected, m.turns) : '—')}</td></tr>`).join('')}</tbody>
        </table></details>` : '';
      const s = this.sharing;
      const history = (s?.history || []).map(h => `<li class="rt-hint">
          ${esc(new Date(h.at).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }))} ·
          ${esc(t(h.answer === 'shared' ? 'realtime.shareWasShared' : 'realtime.shareWasDeclined'))} · ${esc(money(h.cost))}
          ${h.answer === 'shared' ? `<button type="button" class="btn-chat-action" data-action="share-show" data-id="${esc(h.id)}" title="${esc(t('realtime.shareShow'))}" aria-label="${esc(t('realtime.shareShow'))}"><i class="fa-solid fa-eye"></i></button>` : ''}
        </li>`).join('');
      return `
        ${periods}
        <section class="rt-card">
          <h3>${esc(t('realtime.usageSpent'))}</h3>
          <div class="rt-tile-head">
            <span class="rt-tile-value">${esc(money(o.total.cost))}</span>
            <span class="rt-hint">${esc(t('realtime.usageTotals', { runs: whole(o.total.runs), tokens: whole(o.total.prompt_tokens + o.total.completion_tokens) }))}</span>
          </div>
          ${o.total.unpriced ? `<p class="rt-hint">${esc(t(o.total.unpriced === 1 ? 'realtime.usageUnpriced1' : 'realtime.usageUnpriced', { count: o.total.unpriced }))}</p>` : ''}
          ${o.total.runs ? this.renderUsageBars(o) : `<p class="rt-hint">${esc(t('realtime.usageNone'))}</p>`}
          ${o.byPlace.length ? `<p class="rt-hint">${esc(o.byPlace.map(p => `${placeName(p.place)} ${money(p.cost)}`).join(' · '))}</p>` : ''}
          <p class="rt-hint">${esc(t('realtime.usageHint'))}</p>
        </section>
        <section class="rt-card">
          <h3>${esc(t('realtime.usageProjects'))}</h3>
          ${o.byProject.length ? `<ul class="rt-list">${o.byProject.map(p => `<li class="rt-usage-project"><span>${esc(p.name || t('realtime.usageProjectGone'))}</span><b>${esc(money(p.cost))}</b><small class="rt-hint">${esc(t(p.runs === 1 ? 'realtime.usageHomeRun' : 'realtime.usageHomeRuns', { count: whole(p.runs) }))}</small></li>`).join('')}</ul>`
            : `<p class="rt-hint">${esc(t('realtime.usageProjectsNone'))}</p>`}
        </section>
        <section class="rt-card">
          <h3>${esc(t('realtime.usageModels'))}</h3>
          <p class="rt-hint">${esc(t('realtime.usageModelsHint'))}</p>
          ${models || `<p class="rt-hint">${esc(t('realtime.usageNone'))}</p>`}
          ${table}
        </section>
        ${!s?.on ? '' : `<section class="rt-card">
          <h3>${esc(t('realtime.shareTitle'))}</h3>
          <p class="rt-hint">${esc(t('realtime.shareHint', { every: money(s?.every || 5) }))}</p>
          <p class="rt-hint">${esc(!s ? '' : !s.ready ? t('realtime.shareNotReady') : t('realtime.shareWaiting', { cost: money(s.cost), every: money(s.every) }))}</p>
          ${s?.ready && s.runs ? `<button type="button" class="btn" data-action="share-see"><i class="fa-solid fa-eye"></i> ${esc(t('realtime.shareSee'))}</button>` : ''}
          ${history ? `<ul class="rt-list">${history}</ul>` : ''}
        </section>`}
        <section class="rt-card">
          <h3>${esc(t('realtime.usageRecord'))}</h3>
          <p class="rt-hint">${esc(t('realtime.usageRecordHint'))}</p>
          <button type="button" class="btn btn-danger-outline" data-action="usage-clear"><i class="fa-solid fa-trash-can"></i> ${esc(t('realtime.usageClear'))}</button>
        </section>`;
    },

    /** A click in the page; true when it was for it. */
    async onUsageClick(e) {
      const target = e.target.closest('button');
      const action = target?.dataset.action;
      if (action === 'usage-period') {
        this.usagePeriod = PERIODS.find(p => p === Number(target.dataset.period)) || 30;
        window.chatStorage.setSetting('realtime_usage_period', String(this.usagePeriod)).catch(() => {});
        await this.loadCosts();
        return true;
      }
      if (action === 'usage-clear') {
        const ok = await window.chatWorkspace.confirmAction({ title: t('realtime.usageClearTitle'), message: t('realtime.usageClearMessage'), confirmText: t('realtime.usageClear') });
        if (ok) { await window.chatStorage.clearUsage(); await this.loadCosts(); }
        return true;
      }
      if (action === 'share-see') { await this.openShare(); return true; }
      if (action === 'share-show') { await this.openShare({ shown: target.dataset.id }); return true; }
      return false;
    },

    /* -------------------------------------------------------------- */
    /* Sharing                                                          */
    /* -------------------------------------------------------------- */

    /** The table of what a package holds: the same numbers that go, readable. */
    renderPackage(shared) {
      return `<div class="rt-share-table"><table>
          <thead><tr><th>${esc(t('realtime.usageModelHead'))}</th><th>${esc(t('realtime.usageRoleHead'))}</th><th>${esc(t('realtime.sharePlaceHead'))}</th><th>${esc(t('realtime.shareProjectHead'))}</th><th>${esc(t('realtime.usageRuns'))}</th><th>${esc(t('realtime.usageCost'))}</th><th>${esc(t('realtime.usageFirstHead'))}</th><th>${esc(t('realtime.usageCorrectedHead'))}</th></tr></thead>
          <tbody>${shared.groups.map(g => `<tr><th>${esc(g.model)}</th><td>${esc(g.role)}</td><td>${esc(g.place)}</td><td>${esc(projectKind(g.project))}</td><td>${esc(whole(g.runs))}</td><td>${esc(money(g.cost))}</td><td>${esc(seconds(g.first_ms_p50))}</td><td>${esc(g.turns ? `${g.corrected}/${g.turns}` : '—')}</td></tr>`).join('')}</tbody>
        </table></div>
        <details class="rt-table"><summary>${esc(t('realtime.shareExact'))}</summary><pre class="rt-share-json">${esc(JSON.stringify(shared, null, 2))}</pre></details>`;
    },

    /**
     * The question, or what was shared before (`shown`). What would go is
     * worked out by the service and shown whole before anything is sent.
     */
    async openShare({ shown = null } = {}) {
      if (!this.shareDialog) {
        const dialog = document.createElement('dialog');
        dialog.className = 'workspace-dialog rt-settings rt-share';
        dialog.setAttribute('aria-labelledby', 'rt-share-title');
        dialog.addEventListener('click', (e) => this.onShareClick(e));
        // Closed without an answer: asked again tomorrow.
        dialog.addEventListener('close', () => {
          if (this.shareAsked && !this.shareAnswered) window.chatStorage.shareLater().then(() => this.loadCosts()).catch(() => {});
          this.shareAsked = false;
          window.mascot?.release(this.shareSlot);
        });
        document.body.appendChild(dialog);
        this.shareDialog = dialog;
      }
      const dialog = this.shareDialog;
      this.shareAnswered = false;
      this.shareNote = '';
      this.shareBusy = false;
      try {
        if (shown) {
          const past = await window.chatStorage.shared(shown);
          this.shareView = { past, package: past.package };
        } else {
          const state = await window.chatStorage.shareState();
          const built = await window.chatStorage.sharePackage(state.until);
          this.shareView = { built, package: built.package };
          this.shareAsked = true;
        }
      } catch (err) {
        this.shareView = { error: err.message };
      }
      this.renderShare();
      if (!dialog.open) { dialog.showModal(); window.mascot?.dock(this.shareSlot); }
    },

    renderShare() {
      const dialog = this.shareDialog;
      const view = this.shareView || {};
      const head = (title, text) => `<div class="memory-dialog-heading">
          <div class="rt-share-puppet mo-slot"></div>
          <div class="memory-dialog-header-info"><h2 id="rt-share-title">${esc(title)}</h2><p>${esc(text)}</p></div>
          <button type="button" class="btn-chat-action" data-action="close" aria-label="${esc(t('common.close'))}"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
      if (view.error) {
        dialog.innerHTML = `${head(t('realtime.shareTitle'), t('realtime.error', { error: view.error }))}`;
      } else if (view.past) {
        dialog.innerHTML = `${head(t('realtime.sharePastTitle'), t('realtime.sharePastText', { date: new Date(view.past.at).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' }) }))}
          <div class="rt-settings-body">${this.renderPackage(view.package)}</div>`;
      } else {
        const b = view.built;
        dialog.innerHTML = `${head(t('realtime.shareAskTitle'), t('realtime.shareAskText'))}
          <div class="rt-settings-body">
            <section class="rt-set-block">
              <ul class="rt-list rt-share-points">
                <li><i class="fa-solid fa-check"></i> ${esc(t('realtime.sharePoint_what', { runs: whole(b.runs), cost: money(b.cost), from: view.package.weeks.from, to: view.package.weeks.to }))}</li>
                <li><i class="fa-solid fa-check"></i> ${esc(t('realtime.sharePoint_never'))}</li>
                <li><i class="fa-solid fa-check"></i> ${esc(t('realtime.sharePoint_no'))}</li>
                <li><i class="fa-solid fa-check"></i> ${esc(t('realtime.sharePoint_each'))}</li>
              </ul>
            </section>
            <section class="rt-set-block">
              <h3>${esc(t('realtime.shareWhatGoes'))}</h3>
              ${this.renderPackage(view.package)}
            </section>
          </div>
          <div class="rt-row rt-share-actions">
            ${this.shareNote ? `<span class="rt-hint" role="status">${esc(this.shareNote)}</span>` : ''}
            <button type="button" class="btn" data-action="share-no" ${this.shareBusy ? 'disabled' : ''}>${esc(t('realtime.shareNo'))}</button>
            <button type="button" class="btn btn-primary" data-action="share-yes" ${this.shareBusy ? 'disabled' : ''}>${esc(t(this.shareBusy ? 'realtime.shareSending' : 'realtime.shareYes'))}</button>
          </div>`;
      }
      // The character comes to the place kept for it in the window, and stays while the window is open.
      this.shareSlot = this.shareSlot || (() => (dialog.open ? dialog.querySelector('.rt-share-puppet') : null));
      if (dialog.open) window.mascot?.dock(this.shareSlot);
    },

    async onShareClick(e) {
      const action = e.target.closest('button')?.dataset.action;
      if (!action) return;
      if (action === 'close') { this.shareDialog.close(); return; }
      if (action !== 'share-yes' && action !== 'share-no') return;
      const until = this.shareView?.built?.until;
      this.shareBusy = true;
      this.shareNote = '';
      this.renderShare();
      try {
        await window.chatStorage.shareAnswer(action === 'share-yes' ? 'share' : 'decline', until);
        this.shareAnswered = true;
        if (action === 'share-yes') window.mascot?.puppet?.setExpression('joy', 2500);
        this.shareDialog.close();
      } catch (err) {
        // Not sent: the numbers stay here, and the question can be answered again.
        this.shareNote = t('realtime.error', { error: err.message });
      }
      this.shareBusy = false;
      if (this.shareDialog.open) this.renderShare();
      await this.loadCosts();
    },

    /** Whether it is time to ask, looked at now and then: asked at a quiet moment, never over something else. */
    async shareLook() {
      if (this.sharing?.on === false || this.shareDialog?.open || !this.quiet?.() || this.notice || this.pause) return false;
      try {
        const state = await window.chatStorage.shareState();
        this.sharing = state;
        if (!state.on || !state.due) return false;
        await this.openShare();
        return true;
      } catch { return false; }
    },

    /* -------------------------------------------------------------- */
    /* Starting up                                                      */
    /* -------------------------------------------------------------- */

    startUsage() {
      if (this.shareTimer) return;
      window.chatStorage.getSetting('realtime_usage_period').then(saved => {
        this.usagePeriod = PERIODS.find(p => p === Number(saved?.value)) || 30;
        return this.loadCosts();
      }).catch(() => {});
      this.shareTimer = setInterval(() => this.shareLook(), SHARE_LOOK_MS);
      setTimeout(() => this.shareLook(), 60000);
      // The user writes again to correct an answer: the turn before is marked. Told by how the
      // message is written, here, not by a model reading it.
      const chat = window.chatManager;
      if (chat && !chat.persist.withUsage) {
        const persist = chat.persist.bind(chat);
        const wrapped = async (message, conversationId) => {
          const result = await persist(message, conversationId);
          try {
            if (message?.role === 'user' && !message.report && chat.conversation?.id === conversationId) {
              const said = (chat.messages || []).filter(m => m.role === 'user' && m.kind !== 'execution' && m.id !== message.id);
              const before = said[said.length - 1];
              if (before && W.correction(String(message.content || ''), String(before.content || ''))) window.chatStorage.usageCorrected(conversationId).catch(() => {});
            }
          } catch {}
          return result;
        };
        Object.assign(wrapped, chat.persist, { withUsage: true });
        chat.persist = wrapped;
      }
    }
  });

  // The character's own way to the numbers.
  window.realtime.tools.push({
    name: 'usage_read',
    description: 'Call it before saying what was spent or how a model does: what the models cost and how they did between two days (YYYY-MM-DD), in numbers, in all and by project, and for each model its cost, its speed and how often its answers were stopped or corrected.',
    parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    async run(args, section) {
      const day = /^\d{4}-\d{2}-\d{2}$/;
      const to = day.test(String(args.to || '')) ? String(args.to) : dayStamp(new Date());
      const from = day.test(String(args.from || '')) ? String(args.from) : W.shift(to, -29);
      return section.usageText(await window.chatStorage.usage(from, to));
    }
  });

  window.realtime._usage = { money, roleName, PERIODS };
  const start = () => setTimeout(() => rt.startUsage(), 2000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
