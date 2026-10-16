/**
 * SynthOrg - the phone bridge, on the page's side.
 *
 * The local service carries the messages between the paired phones and this
 * page (server/bridge.js); what a phone asks is done here, where the
 * assistant, the chats and the projects are. Nothing here is on unless the
 * bridge is turned on in the assistant's settings: the connection, for
 * while the app is open, or the service, for when its window is closed and
 * the app goes on without it (src-tauri/src/background.rs).
 *
 * What a phone may ask (request -> answer):
 *   state                              the assistant and the tasks, as they are now
 *   assistant.history {before,limit}   what was said with the assistant
 *   assistant.say {text} | recording   something said to the assistant
 *   assistant.confirm {yes}            the answer to a task it asks to hand over
 *   assistant.interrupt                the answer under way is cut short
 *   assistant.stop                     the tasks of the Master are stopped
 *   projects.list                      the Code projects
 *   projects.chats {projectId}         the chats of a project
 *   projects.messages {chatId,...}     what a chat holds
 *   projects.task {projectId,text}     a task for the project's Master
 *   projects.stop {taskId}             that task is stopped
 *   chat.live {conversationId}         the answers being written in a chat, whole, as they are now
 *   approvals.list                     what the models wait an answer for
 *   approvals.decide {id,decision}     the answer: allow or deny
 *   agenda.list {from,to}              the agenda
 *   files.list / files.get {id}        the files handed by the assistant
 *
 * What a phone is told without asking (events): assistant.message,
 * assistant.state, chat.message, chat.live, task.update, approval.pending,
 * approval.settled, reminder.
 *
 * What a phone says is answered in writing: nothing is said aloud on the
 * computer for it. Tasks sent from the phone to a project are the user's
 * own and start at once; the ones the assistant wants to hand over are
 * asked about, on the phone as on the computer.
 */
(function () {
  'use strict';

  const POLL_MS = 25000;
  const RETRY_MS = 5000;
  const HISTORY_MOST = 100;
  const FILE_MOST = 16 * 1024 * 1024;
  const TEXT_MOST = 8000;

  const storage = () => window.chatStorage;
  const assistant = () => window.realtime?._state;

  class Refusal extends Error {
    constructor(code, message) { super(message || code); this.code = code; }
  }

  const bridge = {
    status: null,
    running: false,
    handlers: new Map(),
    tasks: new Map(),       // tasks sent to projects from a phone: id -> { id, projectId, chatId, text, status, stop }
    watched: new Set(),     // chats a phone has asked about: what is written in them is told
    approvals: new Map(),   // what waits an answer: id -> what is told of it
    hidden: false,          // the window is closed and the app goes on without it
    shellTold: '',          // what the shell was last told of the service
    shell: null,            // what the shell says of itself: { service, hidden, autostart: 'off' | 'on' | 'blocked', entry }
    lastState: '',
    lastTold: new Map(),    // message id -> what was last told of it: a message saved again as it was is not told again
    live: new Map(),        // message id -> the answer being written, as the phones were last told of it
    listeners: new Set(),

    /** Whether a paired phone is connected now. */
    there() {
      return Boolean(this.status?.devices?.some(device => device.connected));
    },

    onStatus(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },

    setStatus(status) {
      if (!status) return;
      const was = this.there();
      this.status = status;
      this.listeners.forEach(listener => { try { listener(status); } catch {} });
      if (this.switchedOn() && !this.running) this.loop();
      this.tellShell();
      // A phone has just connected: what the assistant had to tell and nobody was there for.
      if (!was && this.there()) { this.lastState = ''; assistant()?.tellNext?.(); }
    },

    /** Whether either switch is on: then the page listens for the phones. */
    switchedOn() {
      return Boolean(this.status?.settings?.enabled || this.status?.settings?.service);
    },

    /** The shell is told whether closing the window hides it. */
    tellShell() {
      const invoke = window.__TAURI__?.core?.invoke;
      const settings = this.status?.settings;
      if (!invoke || !settings) return;
      const t = (key) => window.i18n.t(key);
      const request = { service: Boolean(settings.service), open: t('realtime.phoneTrayOpen'), quit: t('realtime.phoneTrayQuit'), tooltip: t('realtime.phoneTrayTooltip'), notice_title: t('realtime.phoneTrayNoticeTitle'), notice: t('realtime.phoneTrayNotice') };
      const mark = JSON.stringify(request);
      if (mark === this.shellTold) return;
      this.shellTold = mark;
      invoke('background_configure', { request }).then(state => this.setShell(state), () => { this.shellTold = ''; });
    },

    setShell(state) {
      if (!state) return;
      this.shell = state;
      this.listeners.forEach(listener => { try { listener(this.status); } catch {} });
    },

    /** Starting with the computer, turned on or off by the user: the entry is written or removed, and read back. */
    async setAutostart(on) {
      const invoke = window.__TAURI__?.core?.invoke;
      if (!invoke) throw new Error(window.i18n.t('realtime.phoneAutostartUnavailable'));
      this.setShell(await invoke('background_autostart', { on: Boolean(on) }));
      return this.shell;
    },

    /** What the system holds now: it may have been changed from the system's own list of what starts. */
    async readShell() {
      const invoke = window.__TAURI__?.core?.invoke;
      if (!invoke) return null;
      try { this.setShell(await invoke('background_state')); } catch {}
      return this.shell;
    },

    /** The window was closed with the app going on, or it is back. */
    async setHidden(hidden) {
      this.hidden = Boolean(hidden);
      this.lastState = '';
      const rt = assistant();
      // Nobody is at the computer: the microphone is of no use.
      if (this.hidden && rt?.session) rt.stopSession();
      try { this.setStatus(await storage().bridgeWindow(!this.hidden)); } catch {}
    },

    async refresh() {
      this.setStatus(await storage().bridgeStatus());
      return this.status;
    },

    /** The requests of the phones, taken as they come while the bridge is on. */
    async loop() {
      if (this.running) return;
      this.running = true;
      try {
        while (this.switchedOn()) {
          let got;
          try {
            got = await storage().bridgeInbox(POLL_MS);
          } catch {
            await new Promise(resolve => setTimeout(resolve, RETRY_MS));
            try { await this.refresh(); } catch {}
            continue;
          }
          for (const message of got.messages || []) {
            if (message.kind === 'request') this.answer(message);
            // Said in the settings' page, where the code was shown.
            else if (message.kind === 'paired' && assistant()) assistant().phoneNote = window.i18n.t('realtime.phonePaired', { name: message.device.name });
          }
          this.setStatus(got.status);
        }
      } finally {
        this.running = false;
      }
    },

    async answer(request) {
      const handler = this.handlers.get(request.method);
      let header;
      let body = null;
      try {
        if (!handler) throw new Refusal('unknown_method', `Richiesta sconosciuta: ${request.method}`);
        const bytes = request.body ? Uint8Array.from(atob(request.body), char => char.charCodeAt(0)) : null;
        const result = await handler(request.params || {}, bytes, request.device);
        if (result && result.bytes instanceof Uint8Array) { body = result.bytes; header = { t: 'res', id: request.id, ok: true, result: result.result ?? null }; }
        else header = { t: 'res', id: request.id, ok: true, result: result ?? null };
      } catch (error) {
        header = { t: 'res', id: request.id, ok: false, error: { code: error.code || 'failed', message: String(error.message || error).slice(0, 500) } };
      }
      this.send(request.device, header, body);
    },

    send(device, header, bytes = null) {
      let body = null;
      if (bytes?.length) {
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        body = btoa(text);
      }
      return storage().bridgeSend({ device, header, body }).catch(() => ({ sent: 0 }));
    },

    /** Something the phones are told. Nothing is sent when no phone is connected. */
    tell(name, data, device = '*') {
      if (!this.there()) return;
      this.send(device, { t: 'evt', name, data });
    },

    on(method, handler) { this.handlers.set(method, handler); }
  };

  /* ------------------------------------------------------------------ */
  /* What is told of things                                               */
  /* ------------------------------------------------------------------ */

  const clip = (text, most = TEXT_MOST) => { const s = String(text ?? ''); return s.length > most ? s.slice(0, most) + '…' : s; };

  function messageOf(message) {
    return {
      id: message.id, role: message.role, text: clip(message.content),
      at: message.timestamp || message.created_at || null,
      status: message.isStreaming ? 'streaming' : (message.status || 'complete'),
      model: message.modelName || message.model_name || null
    };
  }

  function stateOf(rt) {
    return {
      name: rt.displayName(),
      phase: rt.phase || 'idle',
      busy: Boolean(rt.busy),
      working: rt.working(),
      confirming: rt.confirming ? { task: rt.confirming.task, outcome: Boolean(rt.confirming.outcome) } : null,
      diary: Boolean(rt.diarySession),
      delegate: Boolean(rt.features?.delegate),
      error: rt.lastError || '',
      tasks: (rt.tasks || []).slice(0, 20).map(task => ({ id: task.id, text: clip(task.text, 600), status: task.status, started: task.started }))
    };
  }

  function taskOf(task) {
    return { id: task.id, projectId: task.projectId, chatId: task.chatId, text: clip(task.text, 600), status: task.status, started: task.started, ended: task.ended || null, answer: task.answer ? clip(task.answer) : '', files: task.files || [] };
  }

  /** The assistant, there to answer: its section built (not shown) and what it keeps loaded. */
  async function ready() {
    const rt = assistant();
    if (!rt) throw new Refusal('not_ready', 'L\'assistente non è ancora pronto.');
    rt.build();
    await rt.ensure();
    return rt;
  }

  /** A recording as the assistant's model takes it: wav, mono, 16 kHz. */
  async function toWav(bytes, format) {
    if (String(format || '').toLowerCase() === 'wav') {
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(text);
    }
    const Context = window.AudioContext || window.webkitAudioContext;
    const context = new Context();
    try {
      const decoded = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      // One channel: the mean of the ones there are.
      const mono = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const data = decoded.getChannelData(channel);
        for (let i = 0; i < data.length; i++) mono[i] += data[i] / decoded.numberOfChannels;
      }
      return window.realtime._audio.toWav([mono], decoded.sampleRate);
    } catch {
      throw new Refusal('bad_audio', 'La registrazione non si può leggere.');
    } finally {
      context.close?.();
    }
  }

  /* ------------------------------------------------------------------ */
  /* The assistant                                                        */
  /* ------------------------------------------------------------------ */

  bridge.on('state', async () => {
    const rt = await ready();
    return { assistant: stateOf(rt), tasks: [...bridge.tasks.values()].map(taskOf), approvals: [...bridge.approvals.values()] };
  });

  bridge.on('assistant.history', async ({ before = null, limit = 30 }) => {
    const rt = await ready();
    const most = Math.max(1, Math.min(HISTORY_MOST, Math.floor(Number(limit)) || 30));
    const all = (await storage().get(rt.conversationId)).messages || [];
    // What the app tells the assistant (a task's outcome, a reminder) is not part of what was said.
    const said = all.filter(message => !message.report && message.kind !== 'report' && ['user', 'assistant'].includes(message.role));
    const end = before ? said.findIndex(message => message.id === before) : said.length;
    const from = Math.max(0, (end < 0 ? said.length : end) - most);
    return { messages: said.slice(from, end < 0 ? said.length : end).map(messageOf), more: from > 0 };
  });

  bridge.on('assistant.say', async ({ text = '', format = 'wav' }, bytes) => {
    const rt = await ready();
    const words = String(text || '').trim().slice(0, 4000);
    if (!words && !bytes?.length) throw new Refusal('empty', 'Niente da dire.');
    if (!window.openRouterCatalog?.getApiKey?.()) throw new Refusal('no_key', 'Manca la chiave API.');
    if (!window.operationalRegistry?.getCurrentRealtimeMultiModel?.()) throw new Refusal('no_model', 'Nessun modello nel ruolo Realtime.');
    if (rt.working()) throw new Refusal('working', 'Il Master sta svolgendo un compito.');
    if (rt.diarySession) throw new Refusal('diary', 'È in corso il diario sul computer.');
    if (rt.busy) await rt.settled();
    if (rt.busy) throw new Refusal('busy', 'L\'assistente sta ancora rispondendo.');
    const input = words ? { text: words, remote: true } : { audio: await toWav(bytes, format), remote: true };
    bridge.spoken = Date.now();
    rt.hear(input);
    return { accepted: true };
  });

  bridge.on('assistant.confirm', async ({ yes }) => {
    const rt = await ready();
    if (!rt.confirming) throw new Refusal('nothing_to_confirm', 'Nessuna domanda aspetta una risposta.');
    rt.from = 'phone';
    rt.confirmTask(Boolean(yes));
    return { accepted: true };
  });

  bridge.on('assistant.interrupt', async () => { (await ready()).interrupt(); return { accepted: true }; });
  bridge.on('assistant.stop', async () => { const rt = await ready(); rt.from = 'phone'; rt.stopTasks(); return { accepted: true }; });

  /* ------------------------------------------------------------------ */
  /* Projects                                                             */
  /* ------------------------------------------------------------------ */

  bridge.on('projects.list', async () => {
    const projects = await storage().listProjects();
    return {
      projects: projects.map(project => ({
        id: project.id, name: project.name, kind: project.kind === 'podman' ? 'container' : 'local',
        repo: project.repo || null, openedAt: project.opened_at || null,
        running: [...bridge.tasks.values()].filter(task => task.projectId === project.id && task.status === 'running').length
      }))
    };
  });

  async function chatsOf(projectId) {
    const chats = await storage().listProjectChats(String(projectId));
    return chats.map(chat => ({ id: chat.id, title: chat.title, updatedAt: chat.updated_at, messages: chat.message_count }));
  }

  bridge.on('projects.chats', async ({ projectId }) => ({ chats: await chatsOf(projectId) }));

  bridge.on('projects.messages', async ({ chatId, before = null, limit = 30 }) => {
    const loaded = await storage().get(String(chatId));
    if (!loaded.conversation?.project_id) throw new Refusal('not_a_project_chat', 'Non è la chat di un progetto.');
    bridge.watched.add(loaded.conversation.id);
    const most = Math.max(1, Math.min(HISTORY_MOST, Math.floor(Number(limit)) || 30));
    const said = (loaded.messages || []).filter(message => ['user', 'assistant'].includes(message.role));
    const end = before ? said.findIndex(message => message.id === before) : said.length;
    const from = Math.max(0, (end < 0 ? said.length : end) - most);
    return { messages: said.slice(from, end < 0 ? said.length : end).map(messageOf), more: from > 0 };
  });

  bridge.on('projects.task', async ({ projectId, chatId = null, text = '' }) => {
    const words = String(text || '').trim();
    if (!words) throw new Refusal('empty', 'Compito vuoto.');
    const project = (await storage().listProjects()).find(item => item.id === projectId);
    if (!project) throw new Refusal('no_project', 'Progetto non trovato.');
    let chats = await storage().listProjectChats(project.id);
    if (!chats.length) chats = [await storage().create(project.id, window.i18n.t('code.aiChatName', { n: 1 }))];
    const chat = chatId ? chats.find(item => item.id === chatId) : chats[0];
    if (!chat) throw new Refusal('no_chat', 'Chat non trovata in questo progetto.');
    const manager = window.chatManager;
    if (manager.backgroundRuns?.has(chat.id) || manager.generation?.conversationId === chat.id) throw new Refusal('working', 'In questa chat il Master sta già lavorando.');

    const task = { id: crypto.randomUUID(), projectId: project.id, chatId: chat.id, text: words, status: 'running', started: Date.now(), stop: new AbortController(), answer: '', files: [] };
    bridge.tasks.set(task.id, task);
    // The oldest ones that have ended make room.
    for (const old of [...bridge.tasks.values()].filter(item => item.status !== 'running').slice(0, -30)) bridge.tasks.delete(old.id);
    bridge.watched.add(chat.id);
    (async () => {
      try {
        // A project in a container runs its commands there: the container is started first.
        if (project.kind === 'podman') await storage().openProject(project.id);
        const answer = await manager.runBackgroundTurn(chat.id, words, { whole: true, signal: task.stop.signal });
        task.answer = answer.content || '';
        task.files = (manager.shownFiles?.(answer) || []).map(file => ({ name: file.name, url: file.url, kind: file.kind || null }));
        task.status = 'done';
      } catch (error) {
        task.status = task.stop.signal.aborted ? 'stopped' : 'error';
        task.answer = task.stop.signal.aborted ? '' : String(error.message || error);
      }
      task.ended = Date.now();
      bridge.tell('task.update', taskOf(task));
    })();
    bridge.tell('task.update', taskOf(task));
    return { task: taskOf(task) };
  });

  bridge.on('projects.stop', async ({ taskId }) => {
    const task = bridge.tasks.get(String(taskId));
    if (!task) throw new Refusal('no_task', 'Compito non trovato.');
    if (task.status === 'running') {
      task.stop.abort();
      window.chatManager.cancelPendingApprovals?.();
    }
    return { task: taskOf(task) };
  });

  /* ------------------------------------------------------------------ */
  /* Approvals, agenda, files                                             */
  /* ------------------------------------------------------------------ */

  bridge.on('approvals.list', async () => ({ approvals: [...bridge.approvals.values()] }));

  bridge.on('approvals.decide', async ({ id, decision }) => {
    if (!bridge.approvals.has(String(id))) throw new Refusal('no_approval', 'Richiesta scaduta o già decisa.');
    await window.chatManager.decideApproval(String(id), decision === 'allow' ? 'allow' : 'deny');
    return { decided: true };
  });

  bridge.on('agenda.list', async ({ from = null, to = null }) => ({ items: await storage().agenda(from, to) }));

  bridge.on('files.list', async ({ before = '', limit = 30 }) => {
    const got = await storage().handedFiles({ limit: Math.max(1, Math.min(60, Number(limit) || 30)), before });
    return { files: got.files.map(file => ({ id: file.id, name: file.name, kind: file.kind, at: file.created_at, seen: Boolean(file.seen_at), size: file.size ?? null })), more: Boolean(got.more) };
  });

  bridge.on('files.get', async ({ id }) => {
    const got = await storage().handedFiles({ limit: 60 });
    const file = got.files.find(item => item.id === id);
    if (!file) throw new Refusal('no_file', 'File non trovato.');
    const origin = window.SYNTHORG_STORAGE_ORIGIN || '';
    const response = await fetch(origin + file.url);
    if (!response.ok) throw new Refusal('no_file', 'File non trovato.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > FILE_MOST) throw new Refusal('too_big', 'File troppo grande per il ponte.');
    return { result: { id: file.id, name: file.name, kind: file.kind, type: response.headers.get('content-type') || '', size: bytes.length }, bytes };
  });

  /* ------------------------------------------------------------------ */
  /* The phone's own interface                                            */
  /* ------------------------------------------------------------------ */

  // The phone shows this same interface and reads the archive through the
  // bridge (server/bridge-api.js); what only this page does it asks here: a
  // turn of the Master in a chat, stopping it, the list of the models.
  bridge.runs = new Map();      // chats where a turn asked by a phone is under way: id -> AbortController

  function running() {
    const manager = window.chatManager;
    const ids = new Set([...(manager?.backgroundRuns?.keys?.() || []), ...(window.planMode?.runs?.keys?.() || [])]);
    if (manager?.generation?.conversationId) ids.add(manager.generation.conversationId);
    return [...ids];
  }

  // `id`: the message as the phone already wrote it in its own archive, so that it is one message on both sides.
  // `plan`: the phone has the plan on for this chat: the request is planned, then carried out a point at a time (plan.js).
  bridge.on('chat.send', async ({ conversationId, text = '', id: messageId = null, plan = false }) => {
    const words = String(text || '').trim();
    if (!words) throw new Refusal('empty', 'Messaggio vuoto.');
    const userId = typeof messageId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(messageId) ? messageId : null;
    const id = String(conversationId || '');
    try { await storage().getBare(id); } catch { throw new Refusal('no_chat', 'Chat non trovata.'); }
    const manager = window.chatManager;
    if (running().includes(id)) throw new Refusal('working', 'In questa chat il Master sta già rispondendo.');
    if (!window.openRouterCatalog?.getApiKey()) {
      const master = manager.registryFor({})?.getSelectedMasterId?.();
      if (!window.modelGateway?.isLocal?.(master)) throw new Refusal('no_key', 'Sul computer manca la chiave API.');
    }
    if (plan && window.planMode) {
      const conversation = (await storage().getBare(id)).conversation;
      if (await window.planMode.wanted(conversation, true)) {
        window.planMode.begin(id, words, { userId }).catch(() => {});
        return { accepted: true, plan: true };
      }
    }
    const stop = new AbortController();
    bridge.runs.set(id, stop);
    bridge.tell('chat.running', { conversationId: id, running: true });
    (async () => {
      try {
        // A project's chat in a container runs its commands there: the container is started first.
        const loaded = await storage().getBare(id);
        const projectId = loaded.conversation?.project_id;
        if (projectId) {
          const project = (await storage().listProjects()).find(item => item.id === projectId);
          if (project?.kind === 'podman') await storage().openProject(project.id);
        }
        await manager.runBackgroundTurn(id, words, { signal: stop.signal, userId });
      } catch {
        // What went wrong is written in the answer itself, which the phone reads from the archive.
      } finally {
        bridge.runs.delete(id);
        bridge.tell('chat.running', { conversationId: id, running: false });
      }
    })();
    return { accepted: true };
  });

  bridge.on('chat.stop', async ({ conversationId }) => {
    const id = String(conversationId || '');
    const stop = bridge.runs.get(id);
    if (window.planMode?.active?.(id)) await window.planMode.stop(id);
    else if (stop) stop.abort();
    else if (window.chatManager?.generation?.conversationId === id) window.chatManager.stopController?.abort();
    else throw new Refusal('no_task', 'In questa chat non c\'è una risposta in corso.');
    window.chatManager.cancelPendingApprovals?.();
    return { stopped: true };
  });

  bridge.on('chat.running', async () => ({ running: running() }));

  // A plan runs here, where the project is: the phone asks for it to be started, stopped, corrected, put away.
  const planOf = () => { if (!window.planMode) throw new Refusal('not_ready', 'Il piano non è pronto.'); return window.planMode; };
  bridge.on('plan.start', async ({ conversationId }) => { planOf().follow(String(conversationId || '')).catch(() => {}); return { started: true }; });
  bridge.on('plan.stop', async ({ conversationId }) => { await planOf().stop(String(conversationId || '')); return { stopped: true }; });
  bridge.on('plan.close', async ({ conversationId }) => { await planOf().close(String(conversationId || '')); return { closed: true }; });
  bridge.on('plan.edit', async ({ conversationId, index, change = null }) => {
    try { await planOf().edit(String(conversationId || ''), Number(index), change && typeof change === 'object' ? change : null); }
    catch (error) { throw new Refusal('working', error.message); }
    return { edited: true };
  });
  document.addEventListener?.('synthorg-plan', (event) => {
    const { conversationId, active } = event.detail || {};
    if (conversationId) bridge.tell('chat.running', { conversationId, running: Boolean(active) });
  });

  /* ------------------------------------------------------------------ */
  /* An answer as it is written                                           */
  /* ------------------------------------------------------------------ */

  // The phone has the chats from the archive, where an answer is written at
  // its steps, not at every word. While a model writes here, the phones are
  // told what changed in the answer since the last time (live-patch.js): a
  // few bytes for a few words, many times a second. `n` counts what was told
  // of a message; a phone that missed one asks for the whole (`chat.live`).
  const LIVE_EVERY = 100;
  const stateOfLive = (message) => JSON.parse(JSON.stringify(message));

  function tellLive(id, done = false) {
    const entry = bridge.live.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = null;
    if (done) bridge.live.delete(id);
    if (!bridge.there()) { entry.sent = null; return; }
    let now;
    try { now = stateOfLive(entry.message); } catch { return; }
    if (!entry.sent) {
      entry.n = 0;
      bridge.tell('chat.live', { conversationId: entry.conversationId, id, n: 0, full: now, ...(done ? { done: true } : {}) });
    } else {
      const ops = window.livePatch.diff(entry.sent, now);
      if (ops.length || done) bridge.tell('chat.live', { conversationId: entry.conversationId, id, n: ++entry.n, ops, ...(done ? { done: true } : {}) });
    }
    entry.sent = now;
    entry.at = Date.now();
  }

  function followLive(message, conversationId) {
    let entry = bridge.live.get(message.id);
    if (!entry) { entry = { conversationId, message, sent: null, n: 0, timer: null, at: 0 }; bridge.live.set(message.id, entry); }
    entry.message = message;
    // Paced by the clock, with a timer only for the last words: with the window closed the browser holds the
    // page's timers back, down to one a minute, while the model's words keep arriving.
    if (Date.now() - entry.at >= LIVE_EVERY) tellLive(message.id);
    else if (!entry.timer) entry.timer = setTimeout(() => tellLive(message.id), LIVE_EVERY);
  }

  bridge.on('chat.live', async ({ conversationId }) => {
    const id = String(conversationId || '');
    const messages = [];
    for (const [messageId, entry] of bridge.live) {
      if (entry.conversationId !== id) continue;
      // As the phones were last told: what is told next goes on from here.
      if (!entry.sent) tellLive(messageId);
      if (entry.sent) messages.push({ conversationId: id, id: messageId, n: entry.n, full: entry.sent });
    }
    return { messages };
  });

  // The models, as this page has them: sent compressed, and only when newer than the phone's.
  bridge.on('catalog.get', async ({ since = null, refresh = false }) => {
    const catalog = window.openRouterCatalog;
    if (!catalog) throw new Refusal('not_ready', 'Il catalogo non è pronto.');
    if (refresh || !catalog.models.length) { try { await catalog.fetchModels(true); } catch {} }
    const updated = catalog.lastUpdated ? new Date(catalog.lastUpdated).toISOString() : null;
    if (since && updated && since === updated) return { lastUpdated: updated, same: true };
    const text = JSON.stringify({ lastUpdated: updated, models: catalog.models });
    const packed = new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')));
    return { result: { lastUpdated: updated, encoding: 'gzip' }, bytes: new Uint8Array(await packed.arrayBuffer()) };
  });

  /* ------------------------------------------------------------------ */
  /* What is told as it happens                                           */
  /* ------------------------------------------------------------------ */

  function hook() {
    const manager = window.chatManager;
    const rt = assistant();
    if (!manager || !rt || manager.bridgeHooked) return Boolean(manager?.bridgeHooked);
    manager.bridgeHooked = true;

    // What is written in the assistant's conversation and in the chats a phone follows.
    const persist = manager.persist.bind(manager);
    manager.persist = async function (message, conversationId) {
      const result = await persist(message, conversationId);
      // An answer being written is followed word by word; written to the end, it is told one last time.
      if (message?.role === 'assistant' && message.id) {
        if (message.isStreaming) followLive(message, conversationId);
        else if (bridge.live.has(message.id)) { bridge.live.get(message.id).message = message; tellLive(message.id, true); }
      }
      try {
        const mine = conversationId === rt.conversationId;
        if (bridge.there() && ['user', 'assistant'].includes(message.role) && !message.report && (mine || bridge.watched.has(conversationId))) {
          const told = messageOf(message);
          // An answer being written is saved many times over: the phone is told when what it would show changes.
          const mark = `${told.status}|${told.text}`;
          if (bridge.lastTold.get(told.id) !== mark) {
            bridge.lastTold.set(told.id, mark);
            if (bridge.lastTold.size > 200) bridge.lastTold.delete(bridge.lastTold.keys().next().value);
            bridge.tell(mine ? 'assistant.message' : 'chat.message', mine ? told : { chatId: conversationId, ...told });
          }
        }
      } catch {}
      return result;
    };

    const updateMessageStream = (manager.updateMessageStream || (() => {})).bind(manager);
    manager.updateMessageStream = function (message) {
      const entry = message?.id ? bridge.live.get(message.id) : null;
      if (entry) followLive(message, entry.conversationId);
      return updateMessageStream(message);
    };

    // What a model waits an answer for.
    const awaitApproval = manager.awaitApproval.bind(manager);
    manager.awaitApproval = function (tc, approval, assistantMsg, conversationId) {
      const waiting = awaitApproval(tc, approval, assistantMsg, conversationId);
      const told = {
        id: approval.id, projectId: manager._codeProjectId || null, kind: approval.kind, name: approval.name,
        summary: approval.summary || null, expiresAt: approval.expiresAt
      };
      bridge.approvals.set(approval.id, told);
      bridge.tell('approval.pending', told);
      return waiting;
    };
    const settleApproval = manager.settleApproval.bind(manager);
    manager.settleApproval = function (approvalId, answer) {
      if (bridge.approvals.delete(approvalId)) bridge.tell('approval.settled', { id: approvalId, outcome: answer?.approved ? 'allow' : (answer?.expired ? 'expired' : 'deny') });
      return settleApproval(approvalId, answer);
    };

    // The assistant, as it changes.
    rt.phone = {
      there: () => bridge.there(),
      // A phone is talking to this computer's assistant: one that spoke to it in the last ten minutes. The phone app
      // has an assistant of its own and never does: a phone merely connected changes nothing of what is said here.
      talking: () => bridge.there() && Date.now() - (bridge.spoken || 0) < 10 * 60 * 1000,
      hidden: () => bridge.hidden,
      state() {
        if (!bridge.there()) return;
        const state = stateOf(rt);
        const text = JSON.stringify(state);
        if (text === bridge.lastState) return;
        bridge.lastState = text;
        bridge.tell('assistant.state', state);
      },
      tell: (name, data) => bridge.tell(name, data)
    };
    return true;
  }

  /** What the shell says of the window, now and as it changes. */
  async function followWindow() {
    const tauri = window.__TAURI__;
    if (!tauri?.core?.invoke || bridge.following) return;
    bridge.following = true;
    try { await tauri.event.listen('synthorg-window', event => bridge.setHidden(event.payload?.open === false)); } catch {}
    try {
      const state = await tauri.core.invoke('background_state');
      bridge.setShell(state);
      if (state?.hidden) await bridge.setHidden(true);
    } catch {}
  }

  async function start() {
    // On the phone this page is the other end of the bridge (remote.js): nothing is served from it.
    if (window.SYNTHORG_REMOTE) return;
    if (!hook()) { setTimeout(start, 500); return; }
    try { await bridge.refresh(); } catch { setTimeout(start, RETRY_MS); return; }
    followWindow();
  }

  window.phoneBridge = bridge;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
