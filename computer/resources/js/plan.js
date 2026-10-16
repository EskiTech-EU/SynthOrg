/**
 * The plan mode of a Code project's chat.
 *
 * With "Piano" on beside the input, a request is not carried out in one
 * turn. The Master first writes a plan with a tool of ours (plan_write):
 * points in order, each with what to do and how it is checked. Then the
 * points are followed in order, by turns this module injects in the chat:
 *
 *   - the point's turn: the instructions written in the plan are given
 *     again, alone, and the Master works with its tools until it says the
 *     point is finished (plan_done);
 *   - the check's turn: the Master is made to verify the point against its
 *     own criterion (plan_check). Passed, the next point is injected; not
 *     passed, the same point is injected again with what is missing.
 *
 * A point is injected at most N times (a setting of the project, beside the
 * permissions for code and terminal): after that the plan stops and waits
 * for the user. In the same place the user chooses whether a plan starts by
 * itself once written, or waits to be read, corrected and started.
 *
 * The plan is kept in the archive (setting `plan_<chat>`), so the phone
 * shows it too. It runs on the computer, where the project is: the phone
 * asks the computer for what it wants done with it (bridge.js).
 */
(function () {
  'use strict';

  const t = (key, params) => (window.i18n ? window.i18n.t(key, params || {}) : key);
  const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const storage = () => window.chatStorage;
  const chat = () => window.chatManager;
  const clip = (value, most) => String(value ?? '').trim().slice(0, most);
  // On the phone the project is the computer's: what is done with a plan is asked of it.
  const far = () => Boolean(window.remote?.active);

  const KEY = (conversationId) => `plan_${conversationId}`;
  const MODE_KEY = (projectId) => `plan_mode_${projectId}`;
  const TRIES_KEY = (projectId) => `plan_tries_${projectId}`;
  const ON_KEY = (conversationId) => `synthorg_plan_on_${conversationId}`;
  const DEFAULT_TRIES = 5;
  const MOST_POINTS = 40;
  const OPEN = ['draft', 'running', 'paused', 'blocked'];

  const fn = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
  const TOOLS = {
    plan_write: fn('plan_write', 'Scrive il piano di questa richiesta: i punti in ordine di esecuzione. Ogni punto verrà poi dato da svolgere da solo, uno alla volta.', {
      points: {
        type: 'array', minItems: 1, maxItems: MOST_POINTS,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Il punto in poche parole.' },
            instructions: { type: 'string', description: 'Cosa fare, con file e dettagli: verrà riletto da solo, senza questo turno.' },
            check: { type: 'string', description: 'Come si verifica che il punto è fatto: un controllo concreto.' }
          },
          required: ['title', 'instructions', 'check']
        }
      }
    }, ['points']),
    plan_done: fn('plan_done', 'Dichiara finito il punto del piano in corso. Seguirà la sua verifica.', {
      summary: { type: 'string', description: 'Cosa è stato fatto per questo punto, in breve.' }
    }, ['summary']),
    plan_check: fn('plan_check', 'L\'esito della verifica del punto del piano.', {
      passed: { type: 'boolean', description: 'true solo se il criterio del punto è soddisfatto.' },
      missing: { type: 'string', description: 'Cosa manca o non va, se non è soddisfatto.' }
    }, ['passed']),
    plan_stop: fn('plan_stop', 'Ferma il piano perché non si può andare avanti senza l\'utente (una decisione, un\'informazione, un accesso).', {
      reason: { type: 'string', description: 'Cosa serve dall\'utente.' }
    }, ['reason'])
  };

  /* ------------------------------------------------------------------ */
  /* What the Master is told                                              */
  /* ------------------------------------------------------------------ */

  const PLANNING = '[PIANO] Questa richiesta va svolta con un piano. In questo turno non svolgerla: leggi del progetto quello che ti serve, poi chiama plan_write con i punti in ordine di esecuzione.'
    + ' Ogni punto ha: title (poche parole), instructions (cosa fare, con file e dettagli: verrà riletto da solo, senza questo turno), check (come si verifica che è fatto: un controllo concreto, che si possa eseguire).'
    + ' Punti piccoli, ognuno svolgibile in un turno di lavoro e verificabile da solo.'
    + ' Dopo plan_write rispondi con una riga: i punti verranno svolti uno alla volta.'
    + ' Se per fare il piano mancano informazioni, non chiamare plan_write e chiedile all\'utente.';

  const overview = (plan) => plan.points.map((point, index) => `${index + 1}. [${point.status === 'done' ? 'fatto' : (index === plan.current ? 'in corso' : 'da fare')}] ${point.title}`).join('\n');

  function pointText(plan, index, why) {
    const point = plan.points[index];
    const again = why === 'missing'
      ? `\n\nLa verifica non è passata. Manca: ${point.missing}`
      : (why === 'open' ? '\n\nIl turno precedente su questo punto è finito senza che fosse dichiarato finito: prosegui da dove eri.' : '');
    return `[PIANO · punto ${index + 1} di ${plan.points.length}] ${point.title}\n\n${point.instructions}\n\nCome si verifica: ${point.check}${again}`
      + '\n\nSvolgi solo questo punto. Quando è fatto, chiama plan_done con un riassunto di cosa hai fatto. Se non puoi andare avanti senza l\'utente, chiama plan_stop e di\' cosa serve.'
      + `\n\nIl piano:\n${overview(plan)}`;
  }

  function checkText(plan, index) {
    const point = plan.points[index];
    return `[PIANO · verifica del punto ${index + 1} di ${plan.points.length}] ${point.title}\n\nHai dichiarato finito questo punto: «${point.summary || ''}».\nCriterio: ${point.check}`
      + '\n\nVerificalo adesso, davvero: rileggi i file toccati ed esegui il controllo. In questo turno non correggere niente. Poi chiama plan_check: passed true solo se il criterio è soddisfatto, altrimenti missing con cosa manca.';
  }

  const FINAL = '[PIANO · fine] Tutti i punti sono fatti e verificati. Scrivi all\'utente un riepilogo breve: cosa è stato fatto, punto per punto, e cosa deve sapere.';

  /* ------------------------------------------------------------------ */
  /* The plans                                                            */
  /* ------------------------------------------------------------------ */

  const plans = {
    cache: new Map(),     // chat id -> its plan, as last read or written (null: none)
    runs: new Map(),      // chat id -> what stops the plan being followed here
    editing: null,        // { conversationId, index }: the point being corrected
    folded: new Set(),    // chats whose panel is folded

    /* ---- the project's two choices, beside its permissions ---- */

    async settings(projectId) {
      let mode = 'manual', tries = DEFAULT_TRIES;
      try { if ((await storage().getSetting(MODE_KEY(projectId)))?.value === 'auto') mode = 'auto'; } catch {}
      try { const n = parseInt((await storage().getSetting(TRIES_KEY(projectId)))?.value, 10); if (n >= 1) tries = Math.min(n, 50); } catch {}
      return { mode, tries };
    },

    async setSettings(projectId, { mode, tries } = {}) {
      if (mode !== undefined) await storage().setSetting(MODE_KEY(projectId), mode === 'auto' ? 'auto' : 'manual');
      if (tries !== undefined) await storage().setSetting(TRIES_KEY(projectId), String(Math.min(50, Math.max(1, parseInt(tries, 10) || DEFAULT_TRIES))));
      return this.settings(projectId);
    },

    /* ---- the switch beside the input: this chat's next request is planned ---- */

    isOn(conversationId) {
      try { return localStorage.getItem(ON_KEY(conversationId)) === '1'; } catch { return false; }
    },

    setOn(conversationId, on) {
      try { if (on) localStorage.setItem(ON_KEY(conversationId), '1'); else localStorage.removeItem(ON_KEY(conversationId)); } catch {}
      this.render();
    },

    /* ---- kept in the archive ---- */

    async load(conversationId) {
      let plan = null;
      try {
        const raw = (await storage().getSetting(KEY(conversationId)))?.value;
        if (raw) plan = JSON.parse(raw);
      } catch {}
      if (plan && (!Array.isArray(plan.points) || plan.conversationId !== conversationId)) plan = null;
      this.cache.set(conversationId, plan);
      // A plan "running" that nobody follows (the app was closed meanwhile) is a stopped one: written so,
      // for the phone to see it as it is.
      if (plan && plan.status === 'running' && !far() && !this.runs.has(conversationId)) await this.halted(plan);
      return plan;
    },

    async save(plan) {
      plan.updatedAt = new Date().toISOString();
      this.cache.set(plan.conversationId, plan);
      this.render();
      await storage().setSetting(KEY(plan.conversationId), JSON.stringify(plan));
    },

    /** The plan as it is when nobody is following it: stopped, its point to be taken up again. */
    async halted(plan) {
      const point = plan.points[plan.current];
      if (point && point.status !== 'done') point.status = 'todo';
      plan.status = 'paused';
      try { await this.save(plan); } catch {}
    },

    /** At the start of the app on the computer: the plans left "running" by the app closing are stopped ones. */
    async settle() {
      if (far()) return;
      let all = {};
      try { all = await storage().getSettings(); } catch { return; }
      for (const [key, value] of Object.entries(all || {})) {
        if (!key.startsWith('plan_') || key.startsWith('plan_mode_') || key.startsWith('plan_tries_')) continue;
        let plan = null;
        try { plan = JSON.parse(value); } catch {}
        if (plan?.status === 'running' && Array.isArray(plan.points) && plan.conversationId && !this.runs.has(plan.conversationId)) await this.halted(plan);
      }
    },

    of(conversationId) { return this.cache.get(conversationId) || null; },
    open(conversationId) { const plan = this.of(conversationId); return plan && OPEN.includes(plan.status) ? plan : null; },
    /** Being followed here now, or about to be written. */
    active(conversationId) { return this.runs.has(conversationId); },

    /** Whether this request starts a plan: the switch is on, the chat is a project's, and no plan is open in it. */
    async wanted(conversation, on = this.isOn(conversation?.id)) {
      if (!conversation?.project_id || !on) return false;
      await this.load(conversation.id);
      return !this.open(conversation.id);
    },

    /* ---- the turns ---- */

    told(active, conversationId) {
      document.dispatchEvent(new CustomEvent('synthorg-plan', { detail: { conversationId, active } }));
    },

    /** One turn of the Master in the chat, with the plan's tool for that moment. */
    async turn(conversationId, text, { signal, tools, call, system = '', mark = null, userId = null }) {
      await chat().runBackgroundTurn(conversationId, text, {
        signal, userId,
        userMeta: mark ? { plan: mark } : null,
        plan: { tools: tools.map(name => TOOLS[name]), system, handles: (name) => tools.includes(name), call }
      });
    },

    /** The request with the plan on: the Master writes the plan; it starts by itself if the project says so. */
    async begin(conversationId, request, { userId = null } = {}) {
      if (far()) throw new Error(t('plan.onComputer'));
      if (this.runs.has(conversationId)) throw new Error(t('plan.busy'));
      const loaded = await storage().getBare(conversationId);
      const projectId = loaded.conversation?.project_id;
      if (!projectId) throw new Error(t('plan.onlyProjects'));
      const settings = await this.settings(projectId);
      const stop = new AbortController();
      this.runs.set(conversationId, stop);
      this.told(true, conversationId);
      this.render();
      let plan = null;
      try {
        await this.ready(projectId);
        await this.turn(conversationId, request, {
          signal: stop.signal, userId, tools: ['plan_write'], system: PLANNING,
          call: async (name, args) => {
            const points = (Array.isArray(args.points) ? args.points : []).slice(0, MOST_POINTS)
              .map(point => ({ title: clip(point?.title, 200), instructions: clip(point?.instructions, 8000), check: clip(point?.check, 2000), status: 'todo', tries: 0, summary: '', missing: '' }))
              .filter(point => point.title && point.instructions);
            if (!points.length) return 'Piano vuoto: servono punti con title, instructions e check.';
            plan = { id: crypto.randomUUID(), conversationId, projectId, request: clip(request, 4000), status: 'draft', current: 0, tries: settings.tries, points, reason: '', createdAt: new Date().toISOString() };
            await this.save(plan);
            return settings.mode === 'auto'
              ? `Piano registrato: ${points.length} punti. Verranno dati da svolgere uno alla volta, da adesso. Chiudi questo turno con una riga.`
              : `Piano registrato: ${points.length} punti. L'utente lo legge, lo corregge se serve e lo avvia. Chiudi questo turno con una riga.`;
          }
        });
      } finally {
        this.runs.delete(conversationId);
        if (!(plan && settings.mode === 'auto' && !stop.signal.aborted)) this.told(false, conversationId);
        this.render();
      }
      if (plan && settings.mode === 'auto' && !stop.signal.aborted) this.follow(conversationId).catch(() => {});
      return plan;
    },

    /** A project in a container runs its commands there: the container is started first. */
    async ready(projectId) {
      try {
        const project = (await storage().listProjects()).find(item => item.id === projectId);
        if (project?.kind === 'podman') await storage().openProject(project.id);
      } catch {}
    },

    /** The points, in order, from where the plan is: each injected, then checked, until all are done or one cannot be. */
    async follow(conversationId) {
      if (far()) return this.ask('plan.start', { conversationId });
      if (this.runs.has(conversationId)) return;
      const plan = await this.load(conversationId);
      if (!plan || !OPEN.includes(plan.status)) return;
      const stop = new AbortController();
      this.runs.set(conversationId, stop);
      this.told(true, conversationId);
      // Started again by the user: the point that had run out of attempts gets them again.
      if (plan.status === 'blocked') { const point = plan.points[plan.current]; if (point) point.tries = 0; }
      plan.status = 'running';
      plan.reason = '';
      try {
        plan.tries = (await this.settings(plan.projectId)).tries;
        await this.save(plan);
        await this.ready(plan.projectId);
        let why = '';
        while (plan.current < plan.points.length) {
          // Stopped between a turn and the next: nothing more is injected.
          if (stop.signal.aborted) throw new DOMException('Piano fermato.', 'AbortError');
          const index = plan.current;
          const point = plan.points[index];
          if (point.status === 'done') { plan.current += 1; continue; }
          if (point.tries >= plan.tries) {
            plan.status = 'blocked';
            plan.reason = t('plan.outOfTries', { n: index + 1, tries: plan.tries }) + (point.missing ? ` ${point.missing}` : '');
            break;
          }
          point.tries += 1;
          point.status = 'doing';
          let declared = false;
          let halted = '';
          await this.save(plan);
          await this.turn(conversationId, pointText(plan, index, why || (point.missing ? 'missing' : '')), {
            signal: stop.signal, tools: ['plan_done', 'plan_stop'], mark: { phase: 'point', index, of: plan.points.length, title: point.title, attempt: point.tries },
            call: async (name, args) => {
              if (name === 'plan_stop') { halted = clip(args.reason, 2000) || t('plan.noReason'); return 'Piano fermato: l\'utente legge il motivo. Chiudi questo turno spiegandogli cosa serve.'; }
              declared = true;
              point.summary = clip(args.summary, 2000);
              return 'Registrato: segue la verifica del punto. Chiudi questo turno con una riga.';
            }
          });
          if (halted) { plan.status = 'blocked'; plan.reason = halted; point.status = 'todo'; break; }
          if (!declared) { point.status = 'todo'; why = 'open'; await this.save(plan); continue; }
          if (stop.signal.aborted) throw new DOMException('Piano fermato.', 'AbortError');
          why = '';
          point.status = 'checking';
          let verdict = null;
          await this.save(plan);
          await this.turn(conversationId, checkText(plan, index), {
            signal: stop.signal, tools: ['plan_check'], mark: { phase: 'check', index, of: plan.points.length, title: point.title },
            call: async (name, args) => { verdict = { passed: args.passed === true, missing: clip(args.missing, 2000) }; return 'Esito registrato. Chiudi questo turno con una riga.'; }
          });
          if (verdict?.passed) {
            point.status = 'done';
            point.missing = '';
            plan.current += 1;
          } else {
            point.status = 'todo';
            point.missing = verdict?.missing || t('plan.noVerdict');
          }
          await this.save(plan);
        }
        if (plan.status === 'running' && plan.current >= plan.points.length) {
          await this.turn(conversationId, FINAL, { signal: stop.signal, tools: [], mark: { phase: 'final' }, call: async () => '' });
          plan.status = 'done';
        }
      } catch (error) {
        // Stopped by the user, or a turn that failed (what went wrong is written in the chat): the plan waits where it is.
        const point = plan.points[plan.current];
        if (point && point.status !== 'done') point.status = 'todo';
        plan.status = 'paused';
        plan.reason = stop.signal.aborted ? '' : String(error?.message || error);
      } finally {
        this.runs.delete(conversationId);
        if (plan.status === 'running') plan.status = 'paused';
        try { await this.save(plan); } catch {}
        this.told(false, conversationId);
        // Whoever watches over the chat is told how the plan was left (the assistant: realtime-liaison.js).
        try { window.dispatchEvent(new CustomEvent('synthorg-plan-ended', { detail: { conversationId, plan } })); } catch {}
        this.render();
      }
    },

    async stop(conversationId) {
      if (far()) return this.ask('plan.stop', { conversationId });
      const stop = this.runs.get(conversationId);
      // Nothing is following it here: the plan is written as stopped, whatever it said.
      if (!stop) { await this.load(conversationId); this.render(); return; }
      stop.abort();
      chat()?.cancelPendingApprovals?.();
    },

    /** The plan is put away: the chat goes on as any other. */
    async close(conversationId) {
      if (far()) return this.ask('plan.close', { conversationId });
      await this.stop(conversationId);
      const plan = await this.load(conversationId);
      if (!plan) return;
      plan.status = 'closed';
      await this.save(plan);
    },

    /** A point corrected, or taken off, while the plan is not being followed. */
    async edit(conversationId, index, change) {
      if (far()) return this.ask('plan.edit', { conversationId, index, change });
      if (this.runs.has(conversationId)) throw new Error(t('plan.busy'));
      const plan = await this.load(conversationId);
      const point = plan?.points?.[index];
      if (!point || !OPEN.includes(plan.status) || point.status === 'done') return;
      if (change === null) {
        plan.points.splice(index, 1);
        if (!plan.points.length) plan.status = 'closed';
      } else {
        point.title = clip(change.title, 200) || point.title;
        point.instructions = clip(change.instructions, 8000) || point.instructions;
        point.check = clip(change.check, 2000) || point.check;
        point.missing = '';
        point.tries = 0;
      }
      if (plan.status === 'blocked') { plan.status = 'paused'; plan.reason = ''; }
      await this.save(plan);
    },

    /** From the phone: asked of the computer, which has the project. */
    async ask(method, params) {
      try { await window.remote.call(method, params); }
      catch (error) { window.chatWorkspace?.error?.(new Error(error?.message || String(error))); }
    },

    /* ------------------------------------------------------------------ */
    /* On screen: the switch beside the input, the plan above it            */
    /* ------------------------------------------------------------------ */

    host() {
      let panel = document.getElementById('chat-plan-panel');
      if (panel) return panel;
      const area = document.querySelector('.chat-input-area');
      if (!area?.parentElement) return null;
      panel = document.createElement('div');
      panel.id = 'chat-plan-panel';
      panel.className = 'chat-plan-panel';
      panel.hidden = true;
      area.parentElement.insertBefore(panel, area);
      panel.addEventListener('click', (event) => this.onClick(event));
      return panel;
    },

    button() {
      let button = document.getElementById('chat-btn-plan');
      if (button) return button;
      // On the computer it is one of the writing bar's own buttons, between what is added and the dictation:
      // its icon alone, like them. The phone keeps it beside the send button.
      const tools = window.SYNTHORG_REMOTE ? null : document.querySelector('.chat-input-tools');
      const actions = tools || document.querySelector('.chat-input-actions');
      if (!actions) return null;
      button = document.createElement('button');
      button.type = 'button';
      button.id = 'chat-btn-plan';
      button.className = 'btn btn-secondary btn-icon-action btn-plan';
      button.innerHTML = tools ? '<i class="fa-solid fa-list-check"></i>' : `<i class="fa-solid fa-list-check"></i><span>${esc(t('plan.name'))}</span>`;
      button.addEventListener('click', () => {
        const id = chat()?.conversation?.id;
        if (id) this.setOn(id, !this.isOn(id));
      });
      // After the "+" and its menu, before the microphone.
      if (tools) tools.insertBefore(button, document.getElementById('chat-add-menu')?.nextSibling || null);
      else actions.insertBefore(button, actions.firstChild);
      return button;
    },

    render() {
      const conversation = chat()?.conversation;
      const button = this.button();
      const panel = this.host();
      const project = Boolean(conversation?.project_id);
      if (button) {
        button.hidden = !project;
        const on = project && this.isOn(conversation.id);
        button.classList.toggle('is-on', on);
        button.title = t(on ? 'plan.switchOn' : 'plan.switchOff');
        button.setAttribute('aria-label', t('plan.name'));
        button.setAttribute('aria-pressed', String(on));
      }
      if (!panel) return;
      const plan = project ? this.of(conversation.id) : null;
      const writing = project && this.runs.has(conversation.id) && !plan;
      if (!project || (!writing && (!plan || !OPEN.concat('done').includes(plan.status)))) { panel.hidden = true; panel.innerHTML = ''; return; }
      panel.hidden = false;
      if (writing || !plan) {
        panel.innerHTML = `<div class="chat-plan-head"><i class="fa-solid fa-list-check"></i><strong>${esc(t('plan.name'))}</strong><span class="chat-plan-state"><i class="fa-solid fa-spinner fa-spin"></i> ${esc(t('plan.writing'))}</span>
          <span class="chat-plan-actions"><button type="button" class="btn btn-sm" data-plan="stop"><i class="fa-solid fa-stop"></i> ${esc(t('plan.stop'))}</button></span></div>`;
        return;
      }
      const id = conversation.id;
      const running = plan.status === 'running';
      const done = plan.points.filter(point => point.status === 'done').length;
      const folded = this.folded.has(id);
      const state = {
        draft: t('plan.stateDraft'), running: t('plan.stateRunning', { n: Math.min(plan.current + 1, plan.points.length), of: plan.points.length }),
        paused: t('plan.statePaused'), blocked: t('plan.stateBlocked'), done: t('plan.stateDone')
      }[plan.status];
      const actions = [
        plan.status === 'draft' ? `<button type="button" class="btn btn-primary btn-sm" data-plan="start"><i class="fa-solid fa-play"></i> ${esc(t('plan.start'))}</button>` : '',
        ['paused', 'blocked'].includes(plan.status) ? `<button type="button" class="btn btn-primary btn-sm" data-plan="start"><i class="fa-solid fa-play"></i> ${esc(t('plan.resume'))}</button>` : '',
        running ? `<button type="button" class="btn btn-sm" data-plan="stop"><i class="fa-solid fa-stop"></i> ${esc(t('plan.stop'))}</button>` : '',
        !running ? `<button type="button" class="btn btn-sm" data-plan="close"><i class="fa-solid fa-xmark"></i> ${esc(t('plan.close'))}</button>` : ''
      ].join('');
      const icon = { todo: 'fa-regular fa-circle', doing: 'fa-solid fa-spinner fa-spin', checking: 'fa-solid fa-magnifying-glass', done: 'fa-solid fa-circle-check' };
      const points = plan.points.map((point, index) => {
        const editing = this.editing && this.editing.conversationId === id && this.editing.index === index;
        const editable = !running && point.status !== 'done' && plan.status !== 'done';
        if (editing) {
          return `<li class="chat-plan-point is-editing" data-index="${index}">
            <input type="text" class="chat-plan-input" data-field="title" value="${esc(point.title)}" maxlength="200" aria-label="${esc(t('plan.fieldTitle'))}">
            <label>${esc(t('plan.fieldInstructions'))}<textarea class="chat-plan-input" data-field="instructions" rows="4">${esc(point.instructions)}</textarea></label>
            <label>${esc(t('plan.fieldCheck'))}<textarea class="chat-plan-input" data-field="check" rows="2">${esc(point.check)}</textarea></label>
            <div class="chat-plan-point-actions">
              <button type="button" class="btn btn-primary btn-sm" data-plan="save" data-index="${index}">${esc(t('plan.save'))}</button>
              <button type="button" class="btn btn-sm" data-plan="cancel">${esc(t('plan.cancel'))}</button>
              <button type="button" class="btn btn-sm" data-plan="remove" data-index="${index}">${esc(t('plan.remove'))}</button>
            </div></li>`;
        }
        const note = point.status === 'checking' ? t('plan.pointChecking')
          : (point.status === 'doing' ? t('plan.pointAttempt', { n: point.tries, of: plan.tries })
            : (point.status !== 'done' && point.missing ? t('plan.pointMissing', { text: point.missing }) : ''));
        return `<li class="chat-plan-point is-${point.status}${index === plan.current && plan.status !== 'done' ? ' is-current' : ''}" data-index="${index}">
          <details><summary><i class="${icon[point.status] || icon.todo}"></i><span class="chat-plan-title">${index + 1}. ${esc(point.title)}</span>${note ? `<em>${esc(note)}</em>` : ''}</summary>
            <div class="chat-plan-text">${esc(point.instructions)}</div>
            <div class="chat-plan-text"><strong>${esc(t('plan.fieldCheck'))}:</strong> ${esc(point.check)}</div>
            ${editable ? `<button type="button" class="btn btn-sm" data-plan="edit" data-index="${index}"><i class="fa-solid fa-pen"></i> ${esc(t('plan.edit'))}</button>` : ''}
          </details></li>`;
      }).join('');
      panel.innerHTML = `
        <div class="chat-plan-head">
          <button type="button" class="chat-plan-fold" data-plan="fold" aria-label="${esc(t(folded ? 'plan.unfold' : 'plan.fold'))}"><i class="fa-solid ${folded ? 'fa-chevron-right' : 'fa-chevron-down'}"></i></button>
          <i class="fa-solid fa-list-check"></i><strong>${esc(t('plan.name'))}</strong>
          <span class="chat-plan-state">${running ? '<i class="fa-solid fa-spinner fa-spin"></i> ' : ''}${esc(state)} · ${esc(t('plan.count', { done, of: plan.points.length }))}</span>
          <span class="chat-plan-actions">${actions}</span>
        </div>
        ${plan.reason && plan.status !== 'done' ? `<p class="chat-plan-reason">${esc(plan.reason)}</p>` : ''}
        ${folded ? '' : `<ol class="chat-plan-points">${points}</ol>`}`;
    },

    async onClick(event) {
      const button = event.target.closest('[data-plan]');
      const id = chat()?.conversation?.id;
      if (!button || !id) return;
      const action = button.dataset.plan;
      const index = Number(button.dataset.index);
      try {
        if (action === 'fold') { if (this.folded.has(id)) this.folded.delete(id); else this.folded.add(id); this.render(); }
        else if (action === 'start') await this.follow(id);
        else if (action === 'stop') await this.stop(id);
        else if (action === 'close') await this.close(id);
        else if (action === 'edit') { this.editing = { conversationId: id, index }; this.render(); }
        else if (action === 'cancel') { this.editing = null; this.render(); }
        else if (action === 'remove') { this.editing = null; await this.edit(id, index, null); }
        else if (action === 'save') {
          const item = button.closest('.chat-plan-point');
          const value = (field) => item.querySelector(`[data-field="${field}"]`)?.value || '';
          this.editing = null;
          await this.edit(id, index, { title: value('title'), instructions: value('instructions'), check: value('check') });
        }
      } catch (error) {
        window.chatWorkspace?.error?.(error);
      }
    },

    /** The chat on screen changed, or its plan did elsewhere: read again and shown. */
    async refresh() {
      const conversation = chat()?.conversation;
      if (conversation?.project_id) await this.load(conversation.id);
      this.render();
    },

    /** How a turn injected by the plan is shown in the chat: what it is, with its text behind. */
    label(mark) {
      if (!mark) return '';
      if (mark.phase === 'point') return t('plan.markPoint', { n: Number(mark.index) + 1, of: mark.of, title: mark.title || '' }) + (Number(mark.attempt) > 1 ? ` · ${t('plan.markAttempt', { n: mark.attempt })}` : '');
      if (mark.phase === 'check') return t('plan.markCheck', { n: Number(mark.index) + 1, of: mark.of, title: mark.title || '' });
      return t('plan.markFinal');
    }
  };

  window.planMode = plans;

  function start() {
    const manager = chat();
    if (!manager) { setTimeout(start, 300); return; }
    const select = manager.selectConversation.bind(manager);
    manager.selectConversation = async function (id) {
      const result = await select(id);
      plans.editing = null;
      plans.refresh().catch(() => {});
      return result;
    };
    // The plan written or moved on by the other device, or by the computer while the phone watches.
    document.addEventListener('synthorg-changed', (event) => {
      const id = chat()?.conversation?.id;
      if (id && (event.detail?.settings || []).includes(KEY(id)) && !plans.runs.has(id)) plans.refresh().catch(() => {});
    });
    document.addEventListener('synthorg-locale-changed', () => { document.getElementById('chat-btn-plan')?.remove(); plans.render(); });
    plans.settle().then(() => plans.refresh()).catch(() => {});
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})();
