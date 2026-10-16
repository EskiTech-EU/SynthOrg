/**
 * SynthOrg - the assistant between the user and their chats.
 *
 * The character can do in the user's chats and projects what the user would:
 *   - read: which chats there are and what each is doing (chats_read), how
 *     far one is and what it last answered (chat_read). It reads by itself;
 *     for more than that — reading a chat through, an analysis, a report —
 *     the work goes to its computer (work, with the chat named), and the
 *     chat's messages are given to that work by the app;
 *   - write: an instruction, a correction or a question to the AI of a chat
 *     (chat_tell), written there as the user would and marked as written by
 *     the character; and stop the work in a chat (chat_stop). A message is
 *     told to the user and confirmed first, unless the settings say it may
 *     always write;
 *   - watch over a chat while the user is away (watch_set, watch_end, and the
 *     section's settings, page "Supervision"). The user leaves orders for
 *     that chat and principles for all of them. When a turn of that chat
 *     ends, the Master is asked once, starting from nothing, what happens
 *     next: an instruction is written to the chat, or the orders are done,
 *     or the user is needed. Nothing is read while a turn is under way.
 *
 * A watched chat is held to two limits the user chose: how many times in a
 * row the character may write to it without the user, and what the chat may
 * cost in a day (the usage record). Reached, the watch waits for the user.
 * A permission the chat asks for is left to the user, unless the chat's own
 * switch hands it to the Master.
 *
 * What takes no model is in realtime-watch.js. These are methods of the
 * section's object (realtime.js), kept in a file of their own. It all runs
 * on the computer, where the chats run.
 */
(function () {
  'use strict';

  const rt = window.realtime._state;
  const { t, esc, dayStamp, fixedLine, writtenLine } = window.realtime._util;
  const W = window.RealtimeWatch;
  const storage = () => window.chatStorage;
  const manager = () => window.chatManager;

  const WATCH_KEY = 'realtime_watch';
  const PROJECTS_MOST = 12;       // projects whose chats are listed
  const LIST_MOST = 24;           // chats told to the model at once
  const READ_REQUEST = 500;       // characters of a chat's last request the model is given
  const READ_ANSWER = 1800;       // and of the answer to it
  const POINTERS_SHOWN = 400;     // paths of a project's files a task is given
  const TOAST_MS = 30000;

  const locale = () => (window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT');
  const money = (value) => `${Number(value || 0).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
  const named = (chat) => `«${chat.title}»${chat.project ? ` (progetto ${chat.project})` : ''}`;
  const far = () => Boolean(window.remote?.active);

  /** How long ago, in the words the model is given. */
  function ago(stamp) {
    const minutes = Math.max(0, Math.round((Date.now() - Date.parse(stamp)) / 60000));
    if (!Number.isFinite(minutes)) return '';
    if (minutes < 1) return 'adesso';
    if (minutes < 60) return `${minutes} min fa`;
    if (minutes < 60 * 24) return `${Math.round(minutes / 60)} ore fa`;
    return `${Math.round(minutes / (60 * 24))} giorni fa`;
  }

  Object.assign(rt, {
    // The chats watched over: { principles, chats: { id: entry }, last: the limits last chosen }.
    // entry: { title, project, on, orders, maxSteps, maxSpend, approve, steps, waiting, halted, done, log }.
    watch: { principles: '', chats: {}, last: null },
    relays: new Map(),          // chats where a message the character wrote is being answered: id -> AbortController
    watchSpent: {},             // what each watched chat cost today, as last read
    watchList: null,            // the user's chats, for the settings page

    async loadWatch() {
      let kept = {};
      try { kept = JSON.parse((await storage().getSetting(WATCH_KEY))?.value || '{}') || {}; } catch {}
      this.watch = {
        principles: typeof kept.principles === 'string' ? kept.principles : t('realtime.watchPrinciplesDefault'),
        chats: kept.chats && typeof kept.chats === 'object' ? kept.chats : {},
        last: kept.last && typeof kept.last === 'object' ? kept.last : null
      };
    },

    saveWatch() {
      return storage().setSetting(WATCH_KEY, JSON.stringify(this.watch)).catch(() => {});
    },

    /* -------------------------------------------------------------- */
    /* The user's chats                                                 */
    /* -------------------------------------------------------------- */

    /** The user's chats, the most recent first: the free ones and those of the latest projects. Not the character's own. */
    async userChats() {
      const [free, projects, own] = await Promise.all([
        storage().list('', false).catch(() => []),
        storage().listProjects('all').catch(() => []),
        storage().realtime().catch(() => ({}))
      ]);
      const mine = new Set([own.conversation?.id, own.tasksConversationId, this.conversationId, this.tasksConversationId].filter(Boolean));
      const inProjects = await Promise.all(projects.slice(0, PROJECTS_MOST).map(project => storage().listProjectChats(project.id)
        .then(chats => chats.map(chat => ({ ...chat, projectName: project.name })), () => [])));
      return [...free, ...inProjects.flat()].filter(chat => chat && !mine.has(chat.id))
        .map(chat => ({ id: chat.id, title: chat.title, project: chat.projectName || '', projectId: chat.project_id || '', updated: chat.updated_at }))
        .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    },

    /** The chat the user named: { chat }, or { text } with what the model is told when it is none or more than one. */
    async chatNamed(name) {
      const chats = await this.userChats();
      const { found, among } = W.findChat(name, chats);
      if (found) return { chat: found };
      if (among.length) return { text: `Più chat corrispondono a «${name}»: ${among.map(named).join(', ')}. Chiedi all'utente quale.` };
      return { text: chats.length
        ? `Nessuna chat e nessun progetto corrisponde a «${name}». Le più recenti: ${chats.slice(0, 8).map(named).join(', ')}. Chiedi all'utente quale.`
        : 'L\'utente non ha ancora chat.' };
    },

    /** Whether the Master of a chat is answering now: a turn by hand, one in the background, a plan. */
    isRunning(id) {
      const chat = manager();
      return Boolean(chat?.backgroundRuns?.has?.(id) || window.planMode?.runs?.has?.(id) || chat?.generation?.conversationId === id);
    },

    /** The permissions a chat is waiting for. */
    permitsWaiting(id) {
      return [...(manager()?._approvals?.values?.() || [])].filter(entry => entry.conversationId === id).length;
    },

    /** What a chat is doing now, in a few words for the model. */
    stateWords(chat) {
      const entry = this.watch.chats[chat.id];
      const words = [];
      if (this.permitsWaiting(chat.id)) words.push('aspetta un permesso dell\'utente');
      else if (this.isRunning(chat.id)) words.push('sta lavorando adesso');
      else words.push(`ferma, ultimo messaggio ${ago(chat.updated)}`);
      const plan = window.planMode?.of?.(chat.id);
      if (plan && plan.status !== 'done') words.push(`piano ${plan.status}, punto ${Math.min((plan.current || 0) + 1, plan.points.length)} di ${plan.points.length}`);
      if (entry?.on) words.push(entry.waiting ? `la sorvegli tu, in attesa dell'utente: ${entry.waiting}` : entry.halted ? 'la sorvegli tu, ferma per un limite' : `la sorvegli tu, ${entry.steps || 0} istruzioni scritte su ${entry.maxSteps}`);
      return words.join('; ');
    },

    /** The chats and what each is doing, as the model is told them. */
    async chatsText() {
      const chats = await this.userChats();
      if (!chats.length) return 'L\'utente non ha ancora chat.';
      const lines = chats.slice(0, LIST_MOST).map(chat => `- ${named(chat)}: ${this.stateWords(chat)}`);
      return lines.join('\n') + (chats.length > LIST_MOST ? `\n(e altre ${chats.length - LIST_MOST} più vecchie)` : '');
    },

    /** One chat as the model is told it: its state, its last request and the answer to it. */
    async chatText(chat) {
      const loaded = await storage().get(chat.id);
      const turn = W.lastTurn(loaded.messages);
      const plan = chat.projectId && window.planMode ? await window.planMode.load(chat.id).catch(() => null) : null;
      const tools = W.callsOf(turn.answer).map(call => call.name);
      const counted = [...new Set(tools)].map(name => `${name} × ${tools.filter(tool => tool === name).length}`);
      return [
        `Chat ${named(chat)}. Stato: ${this.stateWords(chat)}.`,
        plan && plan.points?.length ? `Piano:\n${W.planText(plan)}` : '',
        turn.request ? `Ultima richiesta${turn.by === 'assistant' ? ' (scritta da te)' : ''}: ${W.cut(turn.request, READ_REQUEST)}` : 'Nessun messaggio.',
        counted.length ? `Strumenti usati nell'ultima risposta: ${counted.join(', ')}.` : '',
        turn.answer ? `Ultima risposta${turn.failed ? ' (finita con un errore)' : ''}: ${W.cut(turn.answer.content, READ_ANSWER) || '(vuota)'}` : ''
      ].filter(Boolean).join('\n');
    },

    /** The last messages of a chat, as they are given to a task that is about it. */
    async chatAbout(chat) {
      try {
        const loaded = await storage().get(chat.id);
        const who = (message) => (message.role !== 'user' ? `[Risposta${message.modelName ? ` di ${message.modelName}` : ''}]`
          : message.by === 'assistant' ? '[Assistente, per conto dell\'utente]' : message.plan ? '[Piano]' : '[Utente]');
        const { text, left } = W.material(loaded.messages, who);
        const files = chat.projectId ? await this.projectAbout(chat) : '';
        return `\n\n[CHAT ${named(chat)} — ${left ? `gli ultimi messaggi; ${left} più vecchi non sono riportati` : 'tutti i messaggi'}]\n${text || '(nessun messaggio)'}${files}`;
      } catch (err) {
        return `\n\n[La chat ${named(chat)} non si è potuta leggere: ${err.message}]`;
      }
    },

    /**
     * The files of the project a task is about, as pointers: their paths,
     * nothing of what is in them. The task asks for the ones it needs with
     * project_files, and works on the copies.
     */
    async projectAbout(chat) {
      try {
        const listed = await storage().projectPointers(chat.projectId);
        const shown = listed.files.slice(0, POINTERS_SHOWN);
        return `\n\n[FILE DEL PROGETTO «${listed.name}» — ${listed.total} file, qui i loro percorsi. Con project_files ne ricevi una copia nel tuo spazio di lavoro; il progetto non viene toccato.]\n${shown.join('\n') || '(nessun file)'}${listed.total > shown.length ? `\n(e altri ${listed.total - shown.length})` : ''}`;
      } catch (err) {
        return `\n\n[I file del progetto non si sono potuti elencare: ${err.message}]`;
      }
    },

    /** The tool a task about a project has for that turn alone: copies of the project's files, in the task's own workspace. */
    projectTools(chat, tasksId) {
      return {
        tools: [{
          type: 'function',
          function: {
            name: 'project_files',
            description: 'Copies files of the project this task is about into your own workspace, so that you can read them and run things on the copies there. The project itself is not touched and nothing runs in it: what you change stays with you. Ask only for the files the task needs.',
            parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: 'The files, by their paths as listed.' } }, required: ['paths'] }
          }
        }],
        system: '',
        handles: (name) => name === 'project_files',
        call: async (name, args) => {
          const copied = await storage().copyProjectFiles(tasksId, chat.projectId, Array.isArray(args?.paths) ? args.paths : []);
          // Named as the tools of the chat name a file of its workspace; in its terminal the workspace is /workspace.
          const lines = copied.files.map(file => (file.error ? `- ${file.path}: non copiato (${file.error})` : `- ${file.to}`));
          const head = copied.files.some(file => !file.error) ? 'Copie nel tuo spazio di lavoro (nel terminale: /workspace):\n' : '';
          return `${head}${lines.join('\n') || 'Nessun file chiesto.'}${copied.left ? `\n(${copied.left} non copiati: troppi in una volta, chiedili dopo)` : ''}`;
        }
      };
    },

    /** The copies made for a task are taken away before the next one starts. */
    clearCopies(tasksId) {
      return storage().clearProjectCopies(tasksId).catch(() => {});
    },

    /* -------------------------------------------------------------- */
    /* Writing in a chat as the user would                              */
    /* -------------------------------------------------------------- */

    /**
     * A message written in a chat, and its Master's turn on it. send: { id,
     * title, text }. The message is marked as written by the character. When
     * the turn ends the user is told, unless the chat is watched over: then
     * what follows is the watch's.
     */
    async relay(send, { watched = false } = {}) {
      const id = send.id;
      if (this.isRunning(id)) {
        if (!watched) this.tell({ say: fixedLine('realtime.relayBusy', send.title), keep: true });
        return null;
      }
      const stop = new AbortController();
      this.relays.set(id, stop);
      this.renderSettings();
      let answer = null;
      let failed = '';
      try {
        // The chat of a project: the project is opened first, as the user would open it.
        const projectId = (await storage().getBare(id)).conversation?.project_id;
        if (projectId) await this.enterProject((await storage().listProjects('all')).find(item => item.id === projectId));
        answer = await manager().runBackgroundTurn(id, send.text, { whole: true, signal: stop.signal, userMeta: { by: 'assistant' } });
      } catch (err) {
        failed = err.message;
      } finally {
        this.relays.delete(id);
        this.renderSettings();
      }
      if (watched || stop.signal.aborted) return answer;
      this.tell(failed
        ? { text: `[Quello che hai scritto nella chat «${send.title}» non ha avuto risposta. Errore: ${failed}]\nDillo all'utente, in breve.` }
        : {
          ask: send.text, done: 'realtime.relayDone',
          text: `[La chat «${send.title}» ha risposto a quello che hai scritto: «${send.text.slice(0, 300)}»]\n${String(answer?.content || '').slice(0, 6000)}\n\nRacconta la risposta all'utente, in breve.`
        });
      return answer;
    },

    /**
     * A project opened before its chat is written to. One in a container
     * runs its commands there: the container is started, and nothing on
     * screen moves. One in a folder of this computer runs them in the
     * editor's terminal, which is there only with the project open in the
     * Code tab: the tab is opened on it. A project the user has open with
     * work under way is not taken off the editor for another one.
     */
    async enterProject(project) {
      if (!project) return;
      if (project.kind === 'podman') { await storage().openProject(project.id); return; }
      const code = window.codeWorkspace;
      if ((project.section || 'code') !== 'code' || !code?.open) return;
      const open = code.opened();
      if (open && open !== project.id) {
        const others = await storage().listProjectChats(open).catch(() => []);
        if (others.some(chat => this.isRunning(chat.id))) return;
      }
      if (!code.current() || open !== project.id) {
        // Asked first, shown after: the frame with no project on its way goes back to the list.
        const opened = code.open(project.id);
        window.switchView?.('code');
        await opened;
      }
    },

    /** Stops the work in a chat, whoever started it. False when there was none. */
    async stopChat(id) {
      const chat = manager();
      if (window.planMode?.active?.(id)) await window.planMode.stop(id);
      else if (this.relays.has(id)) this.relays.get(id).abort();
      else if (window.phoneBridge?.runs?.has?.(id)) window.phoneBridge.runs.get(id).abort();
      else if (chat?.generation?.conversationId === id) chat.stopController?.abort();
      else return false;
      return true;
    },

    /* -------------------------------------------------------------- */
    /* Watching over a chat                                             */
    /* -------------------------------------------------------------- */

    /** A chat's place among the watched ones, made when it has none: off, with the limits last chosen. */
    watchEntry(chat) {
      const entry = this.watch.chats[chat.id] || { on: false, orders: '', maxSteps: this.watch.last?.maxSteps ?? null, maxSpend: this.watch.last?.maxSpend ?? null, approve: false, steps: 0, log: [] };
      entry.title = chat.title;
      entry.project = chat.project || '';
      this.watch.chats[chat.id] = entry;
      return entry;
    },

    /**
     * The orders the user left for a chat, by voice or in writing. The chat
     * is watched from now when its limits are chosen; the first time they
     * are not, and the settings open where they are chosen.
     */
    watchSet(chat, orders) {
      const entry = this.watchEntry(chat);
      if (orders) entry.orders = orders;
      if (W.ready(entry)) {
        this.watchOn(chat.id, true);
        return { say: [...fixedLine('realtime.watchSaidOn', chat.title), { text: t('realtime.watchSaidLimits', { steps: entry.maxSteps, spend: money(entry.maxSpend) }) }] };
      }
      this.saveWatch();
      this.openSettings('watch');
      return { say: fixedLine('realtime.watchSaidNeeds', chat.title) };
    },

    /** The switch of a watched chat. Turned on, it starts from the chat as it is now. */
    watchOn(id, on) {
      const entry = this.watch.chats[id];
      if (!entry) return;
      entry.on = Boolean(on) && W.ready(entry);
      if (entry.on) Object.assign(entry, { steps: 0, waiting: '', halted: null, done: false });
      W.logged(entry, { kind: entry.on ? 'on' : 'off' });
      this.saveWatch();
      this.renderSettings();
      if (entry.on) this.watchKick(id);
    },

    /** A watched chat that is doing nothing is judged as it stands: its last turn, or nothing yet. */
    async watchKick(id) {
      if (this.isRunning(id)) return;
      let turn = { request: '', answer: null };
      let plan = null;
      try {
        const loaded = await storage().get(id);
        turn = W.lastTurn(loaded.messages);
        if (loaded.conversation?.project_id && window.planMode) plan = await window.planMode.load(id).catch(() => null);
      } catch {}
      this.watchCheck(id, turn, plan);
    },

    /** What a chat cost today, from the usage record. It fails when the record cannot be read: a limit is not held to a guess. */
    async spentToday(id) {
      const cost = Number((await storage().usageOfChat(id, dayStamp(new Date()))).cost) || 0;
      this.watchSpent[id] = cost;
      return cost;
    },

    /**
     * A turn of a watched chat judged: one request to the Master, which
     * starts from the principles, the orders and that turn alone. What it
     * decides is done here: an instruction written to the chat, the watch
     * closed with the orders done, or the user told that they are needed.
     */
    watchCheck(id, turn, plan = null) {
      return this.job(`watch:${id}`, async () => {
        const entry = this.watch.chats[id];
        if (!entry?.on || entry.halted || entry.waiting || this.isRunning(id)) return;
        let spent;
        try {
          spent = await this.spentToday(id);
        } catch {
          // Without what the chat cost, its limit cannot be held: nothing is written, and the user is told.
          entry.waiting = t('realtime.watchNoSpend');
          W.logged(entry, { kind: 'error', why: entry.waiting });
          await this.saveWatch();
          this.watchNotify(fixedLine('realtime.watchSaidAsk', entry.title), entry.waiting, id);
          return;
        }
        const hit = W.limitHit(entry, spent);
        if (hit) {
          entry.halted = hit;
          W.logged(entry, { kind: 'limit', why: hit });
          await this.saveWatch();
          this.watchNotify(fixedLine(hit === 'steps' ? 'realtime.watchSaidSteps' : 'realtime.watchSaidSpend', entry.title), '', id);
          return;
        }
        let verdict = null;
        let failed = '';
        try {
          verdict = W.parseVerdict(await this.master('watch', {
            stable: `${W.WATCH_RULES}\n\n[THE USER'S PRINCIPLES]\n${this.watch.principles.trim() || '(none)'}`,
            user: W.watchRequest({ title: entry.title, project: entry.project, entry, plan, turn }),
            json: true, about: id
          }));
        } catch (err) {
          failed = err.message;
        }
        // Switched off, or taken up again by the user, while the Master was reading.
        if (this.watch.chats[id] !== entry || !entry.on || this.isRunning(id)) return;
        if (!verdict) {
          entry.waiting = failed || t('realtime.watchNoVerdict');
          W.logged(entry, { kind: 'error', why: entry.waiting });
          this.watchNotify(fixedLine('realtime.watchSaidAsk', entry.title), entry.waiting, id);
        } else if (verdict.verdict === 'done') {
          Object.assign(entry, { on: false, done: true });
          W.logged(entry, { kind: 'done', why: verdict.why });
          this.watchNotify(fixedLine('realtime.watchSaidDone', entry.title), verdict.why, id);
        } else if (verdict.verdict === 'ask') {
          entry.waiting = verdict.why || t('realtime.watchNoVerdict');
          W.logged(entry, { kind: 'ask', why: verdict.why });
          this.watchNotify(fixedLine('realtime.watchSaidAsk', entry.title), verdict.why, id);
        } else {
          entry.steps = (entry.steps || 0) + 1;
          W.logged(entry, { kind: 'continue', message: verdict.message, why: verdict.why });
          // Its answer comes back here as a turn ended, and is judged in its turn.
          this.relay({ id, title: entry.title, text: verdict.message }, { watched: true });
        }
        await this.saveWatch();
        this.renderSettings();
      }).catch(() => {});
    },

    /** A turn ended in some chat: if the chat is watched over, what follows is decided. */
    onTurnEnded(detail) {
      const id = detail?.conversationId;
      const entry = this.watch.chats[id];
      if (far() || !entry?.on) return;
      // The turns of a plan are the plan's: it is judged when it stops.
      if (detail.plan || window.planMode?.active?.(id)) return;
      // The user wrote there: they are here, and the count of what was written without them starts again.
      if (detail.by !== 'assistant') Object.assign(entry, { steps: 0, waiting: '', halted: null });
      if (detail.stopped) {
        // Stopped by hand: nothing is written after it.
        entry.waiting = t('realtime.watchStoppedByHand');
        W.logged(entry, { kind: 'stopped' });
        this.saveWatch();
        this.renderSettings();
        return;
      }
      this.watchCheck(id, { request: detail.request, by: detail.by, answer: detail.answer, failed: detail.answer?.status === 'error' });
    },

    /** The plan of a watched chat stopped: done, blocked on a point, or stopped by hand. */
    onPlanEnded(detail) {
      const id = detail?.conversationId;
      const entry = this.watch.chats[id];
      const plan = detail?.plan;
      if (far() || !entry?.on || !plan) return;
      if (plan.status === 'paused' && !plan.reason) {
        entry.waiting = t('realtime.watchStoppedByHand');
        W.logged(entry, { kind: 'stopped' });
        this.saveWatch();
        this.renderSettings();
        return;
      }
      storage().get(id).then(loaded => this.watchCheck(id, W.lastTurn(loaded.messages), plan), () => {});
    },

    /**
     * A watched chat asks for a permission. It is the user's to give: they
     * are told. With the chat's own switch on, the Master decides from the
     * principles and the orders; when it cannot, the user is told all the same.
     */
    onPermitWaiting(detail) {
      const id = detail?.conversationId;
      const entry = this.watch.chats[id];
      if (far() || !entry?.on) return;
      const waiting = () => manager()?._approvals?.has?.(detail.id);
      const toUser = () => {
        W.logged(entry, { kind: 'permit', message: detail.tool || '' });
        this.saveWatch();
        this.watchNotify(fixedLine('realtime.watchSaidPermit', entry.title), '', id);
      };
      if (!entry.approve) { toUser(); return; }
      this.job(`permit:${detail.id}`, async () => {
        let answer = null;
        try {
          answer = W.parsePermit(await this.master('permit', {
            stable: `${W.PERMIT_RULES}\n\n[THE USER'S PRINCIPLES]\n${this.watch.principles.trim() || '(none)'}`,
            user: W.permitRequest({ title: entry.title, project: entry.project, entry, tool: detail.tool, approval: detail.approval }),
            json: true, about: id
          }));
        } catch {}
        if (!waiting()) return;
        if (!answer || this.watch.chats[id] !== entry || !entry.on) { toUser(); return; }
        W.logged(entry, { kind: answer.allow ? 'allowed' : 'refused', message: detail.tool || '', why: answer.why });
        await this.saveWatch();
        await manager().decideApproval(detail.id, answer.allow ? 'allow' : 'deny');
        this.renderSettings();
      }).catch(() => {});
    },

    /**
     * Something of a watched chat the user has to know: said by the
     * character where it is, kept in its conversation (a paired phone has it
     * from there), and shown on whatever tab is open.
     */
    watchNotify(parts, why = '', chatId = null) {
      const say = why ? [...parts, { text: /[.!?…]$/.test(why) ? why : `${why}.` }] : parts;
      this.tell({ say, keep: true });
      try { window.playNotificationSound?.(); } catch {}
      this.watchToast(writtenLine(say), chatId);
      this.renderSettings();
    },

    watchToast(text, chatId) {
      if (typeof document === 'undefined' || !document.body) return;
      let box = document.getElementById('rt-toasts');
      if (!box) {
        box = document.createElement('div');
        box.id = 'rt-toasts';
        box.className = 'rt-toasts';
        document.body.appendChild(box);
      }
      const card = document.createElement('div');
      card.className = 'rt-toast';
      card.setAttribute('role', 'alert');
      card.innerHTML = `
        <i class="fa-solid fa-eye" aria-hidden="true"></i>
        <div class="rt-toast-body">
          <strong>${esc(t('realtime.watchToastTitle', { name: this.displayName() }))}</strong>
          <span>${esc(text)}</span>
          <div class="rt-toast-actions">
            ${chatId ? `<button type="button" class="btn btn-primary" data-act="open">${esc(t('realtime.watchOpenChat'))}</button>` : ''}
            <button type="button" class="btn" data-act="close">${esc(t('common.close'))}</button>
          </div>
        </div>`;
      const timer = setTimeout(() => card.remove(), TOAST_MS);
      timer?.unref?.();
      card.addEventListener('click', async (e) => {
        const act = e.target.closest('button')?.dataset.act;
        if (!act) return;
        clearTimeout(timer);
        card.remove();
        if (act === 'open') this.openChat(chatId);
      });
      box.appendChild(card);
    },

    async openChat(id) {
      try {
        if (this.dialog?.open) this.dialog.close();
        window.switchView?.('chat');
        await manager().selectConversation(id);
        await window.chatWorkspace?.refresh?.();
      } catch {}
    },

    /* -------------------------------------------------------------- */
    /* The settings: the page of the chats watched over                 */
    /* -------------------------------------------------------------- */

    /** What a watched chat is doing, in the words shown beside its switch. */
    watchState(id, entry) {
      if (entry.done) return t('realtime.watchStateDone');
      if (!entry.on) return t(W.ready(entry) ? 'realtime.watchStateOff' : 'realtime.watchStateNotReady');
      if (entry.halted) return t(entry.halted === 'steps' ? 'realtime.watchStateSteps' : 'realtime.watchStateSpend');
      if (entry.waiting) return t('realtime.watchStateWaiting', { why: entry.waiting });
      const counts = t('realtime.watchStateCounts', { steps: entry.steps || 0, most: entry.maxSteps, spent: money(this.watchSpent[id]), cap: money(entry.maxSpend) });
      return `${t(this.isRunning(id) ? 'realtime.watchStateWorking' : 'realtime.watchStateOn')} · ${counts}`;
    },

    /** The chats to choose from and what the watched ones cost today: read when the page opens. */
    async loadWatchPage() {
      if (this.watchLoading) return;
      this.watchLoading = true;
      try {
        this.watchList = await this.userChats();
        await Promise.all(Object.keys(this.watch.chats).map(id => this.spentToday(id).catch(() => {})));
      } catch {}
      this.watchLoading = false;
      this.renderSettings();
    },

    renderSettings_watch() {
      if (!this.watchList && !this.watchLoading) this.loadWatchPage();
      const entries = Object.entries(this.watch.chats);
      const logLine = (line) => {
        const when = new Date(line.at).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        const what = [line.message, line.why].filter(Boolean).join(' — ');
        return `<li><em>${esc(when)}</em> <strong>${esc(t('realtime.watchLog_' + line.kind))}</strong>${what ? ` ${esc(what)}` : ''}</li>`;
      };
      const chat = ([id, entry]) => {
        const ready = W.ready(entry);
        return `
        <div class="rt-watch-chat" data-chat="${esc(id)}">
          <div class="rt-switch-row">
            <label class="synth-toggle-wrapper"><span class="synth-switch"><input type="checkbox" class="rt-watch-on" ${entry.on ? 'checked' : ''} ${ready ? '' : 'disabled'}><span class="synth-slider"></span></span>
              <span><strong>${esc(entry.title || '')}</strong><small>${esc([entry.project && t('realtime.watchProject', { name: entry.project }), this.watchState(id, entry)].filter(Boolean).join(' · '))}</small></span></label>
            <span class="rt-watch-actions">
              ${entry.on && (entry.waiting || entry.halted) ? `<button type="button" class="btn" data-action="watch-resume">${esc(t('realtime.watchResume'))}</button>` : ''}
              <button type="button" class="btn" data-action="watch-open">${esc(t('realtime.watchOpenChat'))}</button>
              <button type="button" class="btn btn-danger-outline" data-action="watch-drop">${esc(t('realtime.watchDrop'))}</button>
            </span>
          </div>
          <label class="rt-field"><span>${esc(t('realtime.watchOrders'))}</span>
            <textarea class="rt-watch-orders" rows="3" placeholder="${esc(t('realtime.watchOrdersHint'))}">${esc(entry.orders || '')}</textarea></label>
          <div class="rt-watch-limits">
            <label class="rt-field rt-field-inline"><span>${esc(t('realtime.watchSteps'))}</span><input type="number" class="rt-watch-steps" min="1" step="1" value="${entry.maxSteps ?? ''}"></label>
            <label class="rt-field rt-field-inline"><span>${esc(t('realtime.watchSpend'))}</span><input type="number" class="rt-watch-spend" min="0" step="0.01" value="${entry.maxSpend ?? ''}"></label>
          </div>
          <div class="rt-switch-row">
            <label class="synth-toggle-wrapper"><span class="synth-switch"><input type="checkbox" class="rt-watch-approve" ${entry.approve ? 'checked' : ''}><span class="synth-slider"></span></span>
              <span><strong>${esc(t('realtime.watchApprove'))}</strong><small>${esc(t('realtime.watchApproveHint'))}</small></span></label>
          </div>
          ${(entry.log || []).length ? `<details class="rt-watch-log"><summary>${esc(t('realtime.watchLogTitle'))}</summary><ul>${[...entry.log].reverse().map(logLine).join('')}</ul></details>` : ''}
        </div>`;
      };
      const free = (this.watchList || []).filter(item => !this.watch.chats[item.id]);
      return `
        <section class="rt-set-block">
          <h3>${esc(t('realtime.watchTitle'))}</h3>
          <p class="rt-hint">${esc(t('realtime.watchHint', { name: this.displayName() }))}</p>
          ${this.settingsNote ? `<p class="rt-hint" role="status">${esc(this.settingsNote)}</p>` : ''}
          <label class="rt-field"><span>${esc(t('realtime.watchPrinciples'))}</span>
            <textarea class="rt-watch-principles" rows="4">${esc(this.watch.principles)}</textarea></label>
          <p class="rt-hint">${esc(t('realtime.watchPrinciplesHint'))}</p>
        </section>
        <section class="rt-set-block">
          <h3>${esc(t('realtime.watchChats'))}</h3>
          <p class="rt-hint">${esc(t('realtime.watchChatsHint'))}</p>
          ${entries.map(chat).join('') || `<p class="rt-hint">${esc(t('realtime.watchNone'))}</p>`}
          <label class="rt-field"><span>${esc(t('realtime.watchAdd'))}</span>
            <select class="rt-watch-add select-control">
              <option value="">${esc(t(this.watchList ? 'realtime.watchAddChoose' : 'realtime.watchAddReading'))}</option>
              ${free.map(item => `<option value="${esc(item.id)}">${esc(item.project ? `${item.project} · ${item.title}` : item.title)}</option>`).join('')}
            </select></label>
        </section>`;
    },

    /** A click or a change in the page of the watched chats. True when it was one of its own. */
    async onWatchSettings(e) {
      const target = e.target;
      const id = target.closest('.rt-watch-chat')?.dataset.chat;
      const entry = id ? this.watch.chats[id] : null;
      if (e.type === 'click') {
        const action = target.closest('button')?.dataset.action;
        if (!entry || !['watch-resume', 'watch-open', 'watch-drop'].includes(action)) return false;
        if (action === 'watch-open') { this.openChat(id); return true; }
        if (action === 'watch-drop') {
          delete this.watch.chats[id];
          await this.saveWatch();
        } else {
          // The user is here again: the count starts over, and the chat is judged as it stands.
          Object.assign(entry, { steps: 0, waiting: '', halted: null });
          W.logged(entry, { kind: 'resumed' });
          await this.saveWatch();
          this.watchKick(id);
        }
        this.renderSettings(true);
        return true;
      }
      if (e.type !== 'change') return false;
      if (target.matches('.rt-watch-principles')) {
        this.watch.principles = target.value;
      } else if (target.matches('.rt-watch-add')) {
        const chat = (this.watchList || []).find(item => item.id === target.value);
        if (!chat) return true;
        this.watchEntry(chat);
      } else if (!entry) {
        return false;
      } else if (target.matches('.rt-watch-on')) {
        this.watchOn(id, target.checked);
        return true;
      } else if (target.matches('.rt-watch-approve')) {
        entry.approve = target.checked;
      } else if (target.matches('.rt-watch-orders')) {
        entry.orders = target.value.trim();
      } else if (target.matches('.rt-watch-steps, .rt-watch-spend')) {
        const steps = parseInt(target.closest('.rt-watch-chat').querySelector('.rt-watch-steps').value, 10);
        const spend = parseFloat(target.closest('.rt-watch-chat').querySelector('.rt-watch-spend').value);
        entry.maxSteps = Number.isInteger(steps) && steps > 0 ? steps : null;
        entry.maxSpend = Number.isFinite(spend) && spend >= 0 ? spend : null;
        // The limits last chosen are the ones the next chat starts with.
        if (entry.maxSteps !== null && entry.maxSpend !== null) this.watch.last = { maxSteps: entry.maxSteps, maxSpend: entry.maxSpend };
        // New limits are a new start for a chat that had reached the old ones.
        if (entry.halted && !W.limitHit(entry, this.watchSpent[id] || 0)) entry.halted = null;
      } else {
        return false;
      }
      // A chat that no longer has all it takes is not watched.
      if (entry && entry.on && !W.ready(entry)) entry.on = false;
      await this.saveWatch();
      this.settingsNote = t('realtime.textSaved');
      this.renderSettings(true);
      return true;
    }
  });

  /* ------------------------------------------------------------------ */
  /* The character's tools                                                */
  /* ------------------------------------------------------------------ */

  // The model names a chat as the user said it; which chat it is, is found here.
  const CHAT = { type: 'string', description: 'The name of the chat or of the project, whole, exactly as the user said it.' };
  const withChat = (run) => async (args, state) => {
    const found = await state.chatNamed(String(args.chat || ''));
    return found.text || run(found.chat, args, state);
  };

  window.realtime.tools.push(
    {
      name: 'chats_read',
      description: 'Call it when the user asks which chats or projects they have, or what they are doing now: lists them, the most recent first, with what each is doing.',
      parameters: { type: 'object', properties: {} },
      available: () => !far(),
      run: (args, state) => state.chatsText()
    },
    {
      name: 'chat_read',
      description: 'Call it when the user asks about one of their chats or projects: how far it is, what it was last asked, what it answered. For more than that (reading it all through, an analysis, a report) use work and name the chat there.',
      parameters: { type: 'object', properties: { chat: CHAT }, required: ['chat'] },
      available: () => !far(),
      run: withChat((chat, args, state) => state.chatText(chat))
    },
    {
      name: 'chat_tell',
      description: 'Call it when the user wants the AI working in one of their chats or projects told or asked something: an instruction, a correction, a question. It is written to that AI as the user would write it, and that AI does it, not you.',
      parameters: { type: 'object', properties: { chat: CHAT, message: { type: 'string', description: 'What that AI is told to do, or asked, whole and in the words of the user. Not the result of doing it.' } }, required: ['chat', 'message'] },
      available: () => !far(),
      run: withChat((chat, args, state) => {
        const text = String(args.message || '').trim();
        if (!text) return 'ERRORE: messaggio vuoto.';
        // A chat that is answering takes no other message: said at once, before anything is asked.
        if (state.isRunning(chat.id)) return { say: fixedLine('realtime.relayBusy', chat.title) };
        // Told to the user in fixed words when the exchange is over, and written then or when it is confirmed.
        state.askTask({ send: { id: chat.id, title: chat.title, text } });
        return {};
      })
    },
    {
      name: 'chat_stop',
      description: 'Call it when the user wants the work going on in one of their chats or projects stopped.',
      parameters: { type: 'object', properties: { chat: CHAT }, required: ['chat'] },
      available: () => !far(),
      run: withChat(async (chat, args, state) => ({ say: fixedLine(await state.stopChat(chat.id) ? 'realtime.relayStopped' : 'realtime.relayNotRunning', chat.title) }))
    },
    {
      name: 'watch_set',
      description: 'Call it when the user asks you to watch over, follow or keep going one of their chats or projects while they are away, and says what has to be done there. orders: what they said has to be done, whole, in their words.',
      parameters: { type: 'object', properties: { chat: CHAT, orders: { type: 'string' } }, required: ['chat', 'orders'] },
      available: () => !far(),
      run: withChat((chat, args, state) => {
        const orders = String(args.orders || '').trim();
        if (!orders) return 'ERRORE: mancano le consegne. Chiedi all\'utente che cosa va fatto in quella chat.';
        return state.watchSet(chat, orders);
      })
    },
    {
      name: 'watch_end',
      description: 'Call it when the user asks you to stop watching over one of their chats or projects.',
      parameters: { type: 'object', properties: { chat: CHAT }, required: ['chat'] },
      available: (state) => !far() && Object.values(state.watch.chats).some(entry => entry.on),
      run: withChat((chat, args, state) => {
        if (!state.watch.chats[chat.id]?.on) return { say: fixedLine('realtime.watchSaidNotOn', chat.title) };
        state.watchOn(chat.id, false);
        return { say: fixedLine('realtime.watchSaidOff', chat.title) };
      })
    }
  );

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('synthorg-turn-ended', (e) => rt.onTurnEnded(e.detail));
    window.addEventListener('synthorg-plan-ended', (e) => rt.onPlanEnded(e.detail));
    window.addEventListener('synthorg-approval-waiting', (e) => rt.onPermitWaiting(e.detail));
  }

  window.realtime._liaison = { WATCH_KEY };
})();
