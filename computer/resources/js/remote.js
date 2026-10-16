/*
 * SynthOrg on the phone.
 *
 * The phone app shows this same interface. Its shell (android/) sets
 * `window.SYNTHORG_REMOTE` before the page loads and answers the archive's
 * requests at the same paths the local service has here, from the phone's
 * own archive: the same rules, run on the phone (chats, the assistant's
 * pages, the settings). What is done on the phone is written there at once;
 * the rows go to the paired computer through the bridge, and the computer's
 * come back the same way (server/replica.js). The same thing changed on
 * both sides while apart: the most recent stays.
 *
 * The phone is as independent as the computer: the page calls the models
 * itself, with the API key entered on the phone, and the Master's turns and
 * the assistant run here, with or without a computer paired. The pairing
 * keeps the two archives the same, in the background, and gives the phone
 * the one thing that stays the computer's: the Code projects. Their files
 * and containers are there, so the phone has a zone with the projects and
 * their chats, and in those chats the Master's turn runs on the computer
 * (the bridge's requests, docs/ponte-telefono.md). On this computer this
 * file does nothing.
 */
(function () {
  'use strict';

  const given = window.SYNTHORG_REMOTE;
  if (!given) { window.remote = { active: false }; return; }

  const tauri = window.__TAURI__;
  const t = (key, params) => (window.i18n ? window.i18n.t(key, params || {}) : key);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  document.documentElement.classList.add('is-phone');
  // Where the files of the chats are asked for (pictures, what a task made): the phone's shell, which asks the computer.
  window.SYNTHORG_STORAGE_ORIGIN = 'http://synthorg.localhost';

  function toBase64(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(text);
  }
  const fromBase64 = (text) => Uint8Array.from(atob(text), c => c.charCodeAt(0));

  class RemoteError extends Error {
    constructor(code, message) { super(message || code); this.code = code; }
  }

  // Whether a computer is paired. The shell says it when the window is made; a pairing made or
  // undone after that is kept here, so that the page loaded again starts as what the phone is now.
  const PAIRED = 'synthorg_phone_paired';
  let pairedNow = Boolean(given.paired);
  try {
    const kept = localStorage.getItem(PAIRED);
    if (kept === '1' || kept === '0') pairedNow = kept === '1';
  } catch {}
  const keepPaired = (paired) => { try { localStorage.setItem(PAIRED, paired ? '1' : '0'); } catch {} };

  // Which world the phone shows: its own chats ('phone'), or those of the computer paired ('pc'). Two worlds, each
  // with its chats: the phone's never leave the phone (replica.js), the computer's come with the exchange and what
  // is done in them here goes back. Assistant, agenda, diary, memories and keys are one, whatever the world.
  const WORLD = 'synthorg_phone_world';
  let worldNow = 'phone';
  try { if (localStorage.getItem(WORLD) === 'pc') worldNow = 'pc'; } catch {}
  if (!pairedNow) worldNow = 'phone';

  const remote = {
    world: worldNow,
    active: true,
    paired: pairedNow, // a computer is paired: the archives are kept the same, and its projects are reachable
    deviceId: given.deviceId || '',
    desktop: given.desktop || '',
    state: 'offline',          // offline | connecting | online
    via: 'none',               // which way the link goes now: lan (the local network) | i2p | none
    queued: 0,                 // writes kept while the computer could not be reached
    page: true,                // whether the computer's page is there to answer
    running: new Set(),        // chats where the computer is writing an answer (a project's, or one being used there)
    scanning: false,           // the camera is open for the pairing code
    scans: 0,
    listeners: new Map(),

    /** A request to the computer's page, or to its service. Bytes go and come as base64. */
    async call(method, params = {}, body = null) {
      let got;
      try {
        got = await tauri.core.invoke('remote_call', { method, params, body: body ? toBase64(body) : null });
      } catch (error) {
        const detail = typeof error === 'object' && error ? error : { code: 'failed', message: String(error) };
        throw new RemoteError(detail.code || 'failed', detail.message || String(error));
      }
      return { result: got?.result ?? null, body: got?.body ? fromBase64(got.body) : null };
    },

    on(name, listener) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(listener);
      return () => this.listeners.get(name)?.delete(listener);
    },

    emit(name, data, body) {
      for (const listener of this.listeners.get(name) || []) {
        try { listener(data, body); } catch (error) { console.warn('[remote]', name, error); }
      }
    }
  };
  window.remote = remote;

  /** Words for a refusal of the computer, for the user. */
  function refusalText(error) {
    const code = error?.code;
    const known = {
      offline: t('remote.offline'), page_away: t('remote.pageAway'), working: t('remote.working'), busy: t('remote.busy'),
      no_key: t('remote.noKey'), no_model: t('remote.noModel'), diary: t('remote.diary')
    };
    return known[code] || error?.message || String(error);
  }
  remote.refusalText = refusalText;

  /* ------------------------------------------------------------------ */
  /* The connection                                                       */
  /* ------------------------------------------------------------------ */

  function setState(next) {
    const was = remote.state;
    remote.state = next.state || remote.state;
    remote.via = next.via || 'none';
    remote.queued = Number(next.queued) || 0;
    if (next.deviceId) remote.deviceId = next.deviceId;
    if (next.desktop) remote.desktop = next.desktop;
    renderLink();
    if (remote.paired && was !== 'online' && remote.state === 'online') refreshRunning();
  }

  tauri.event.listen('remote-state', (event) => setState(event.payload || {}));
  tauri.event.listen('remote-event', (event) => {
    const { name, data, body } = event.payload || {};
    // Rows the computer wrote, now in this phone's archive: what they changed is shown again.
    if (name === 'rows') { window.archiveSync?.apply(data?.changes || []).catch(error => console.warn('[sync]', error)); return; }
    // The copies of what only the computer has were checked with it: these differ.
    if (name === 'refreshed') { window.archiveSync?.refreshed(data?.paths || []); return; }
    if (name === 'welcome' || name === 'page') remote.page = name === 'welcome' ? data?.page !== false : Boolean(data?.there);
    remote.emit(name, data, body ? fromBase64(body) : null);
  });
  tauri.core.invoke('remote_info').then(info => {
    // The shell knows: if the page started as the other kind of phone, it is loaded again as the right one.
    if (info && Boolean(info.paired) !== remote.paired) { keepPaired(info.paired); location.reload(); return; }
    keepPaired(remote.paired);
    setState(info || {});
  }).catch(() => {});

  /** The pill in the header: where the computer is, and what waits to be sent. */
  function renderLink() {
    renderWorld();
    let pill = document.getElementById('remote-link');
    const header = document.querySelector('.header-actions');
    if (!pill && header) {
      pill = document.createElement('button');
      pill.type = 'button';
      pill.id = 'remote-link';
      pill.className = 'remote-link';
      pill.addEventListener('click', () => openLinkSheet());
      header.prepend(pill);
    }
    if (!pill) return;
    const label = !remote.paired ? t('remote.alone')
      : remote.state === 'online' ? t(remote.via === 'lan' ? 'remote.onlineLan' : 'remote.online', { name: remote.desktop || t('remote.computer') })
      : remote.state === 'connecting' ? t('remote.connecting') : t('remote.offlineShort');
    pill.dataset.state = remote.paired ? remote.state : 'alone';
    pill.innerHTML = `<span class="remote-dot"></span><span>${esc(label)}</span>${remote.queued ? `<em>${esc(t('remote.queued', { count: remote.queued }))}</em>` : ''}`;
  }

  /** The switch between the two worlds, in the header, only with a computer paired. */
  function renderWorld() {
    let box = document.getElementById('remote-world');
    const header = document.querySelector('.header-actions');
    if (!remote.paired) { box?.remove(); return; }
    if (!box && header) {
      box = document.createElement('div');
      box.id = 'remote-world';
      box.className = 'remote-world';
      box.setAttribute('role', 'group');
      box.addEventListener('click', (e) => { const button = e.target.closest('[data-world]'); if (button) setWorld(button.dataset.world); });
      header.prepend(box);
    }
    if (!box) return;
    box.innerHTML = ['phone', 'pc'].map(world => `<button type="button" class="remote-world-btn ${remote.world === world ? 'is-active' : ''}" data-world="${world}" aria-pressed="${remote.world === world}"><i class="fa-solid ${world === 'phone' ? 'fa-mobile-screen' : 'fa-desktop'}"></i><span>${esc(t(world === 'phone' ? 'remote.worldPhone' : 'remote.worldPc'))}</span></button>`).join('');
  }

  /** The other world: the switch, the list of its chats, and the chat left open there last. */
  async function setWorld(world) {
    if (world !== 'phone' && world !== 'pc') return;
    if (world === 'pc' && !remote.paired) return;
    if (remote.world === world) return;
    remote.world = world;
    try { localStorage.setItem(WORLD, world); } catch {}
    renderWorld();
    window.switchView('chat');
    await generalChat(true);
    await window.chatWorkspace?.refresh?.();
  }
  remote.setWorld = setWorld;

  function openLinkSheet() {
    // No computer yet: the pill opens the pairing.
    if (!remote.paired) { pairingScreen(); return; }
    const sheet = document.createElement('div');
    sheet.className = 'remote-sheet-backdrop';
    sheet.innerHTML = `
      <div class="remote-sheet" role="dialog" aria-modal="true">
        <h3>${esc(remote.desktop || t('remote.computer'))}</h3>
        <p>${esc(remote.state === 'online' ? t('remote.sheetOnline') : remote.state === 'connecting' ? t('remote.sheetConnecting') : t('remote.sheetOffline'))}</p>
        ${remote.state === 'online' ? `<p>${esc(t(remote.via === 'lan' ? 'remote.sheetViaLan' : 'remote.sheetViaI2p'))}</p>` : ''}
        ${remote.queued ? `<p>${esc(t('remote.sheetQueued', { count: remote.queued }))}</p>` : ''}
        <div class="remote-sheet-actions">
          <button type="button" class="btn" data-act="retry">${esc(t('remote.retry'))}</button>
          <button type="button" class="btn btn-danger" data-act="forget">${esc(t('remote.forget'))}</button>
          <button type="button" class="btn btn-primary" data-act="close">${esc(t('common.close'))}</button>
        </div>
      </div>`;
    sheet.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (e.target === sheet || act === 'close') { sheet.remove(); return; }
      if (act === 'retry') { tauri.core.invoke('remote_connect').catch(() => {}); sheet.remove(); }
      if (act === 'forget' && confirm(t('remote.forgetConfirm'))) {
        await tauri.core.invoke('remote_forget').catch(() => {});
        keepPaired(false);
        // The phone goes on by itself: the app opens, not the pairing.
        try { localStorage.setItem(ALONE, '1'); } catch {}
        location.reload();
      }
    });
    document.body.appendChild(sheet);
  }

  /* ------------------------------------------------------------------ */
  /* The chats of the projects: the computer writes the answers           */
  /* ------------------------------------------------------------------ */

  // A project's files and its container are on the computer: in a project's
  // chat the Master's turn runs there. Every other chat runs on this phone.
  const ofProject = (chat) => Boolean(chat?.conversation?.project_id);

  async function refreshRunning() {
    try {
      const { result } = await remote.call('chat.running');
      remote.running = new Set(result?.running || []);
      showRunning();
    } catch {}
  }

  // The computer is answering in the chat on screen (a project's, or a chat being used there): the
  // send button follows it. A turn of this phone keeps its own state.
  function showRunning() {
    const chat = window.chatManager;
    if (!chat) return;
    const id = chat.conversation?.id;
    if (id && remote.running.has(id)) {
      chat.isGenerating = true;
      chat.byComputer = id;
    } else if (chat.byComputer) {
      chat.byComputer = null;
      if (!chat.generation) chat.isGenerating = false;
    }
    chat.updateSendButtonState();
  }

  remote.on('chat.running', ({ conversationId, running } = {}) => {
    if (!conversationId) return;
    if (running) remote.running.add(conversationId);
    else remote.running.delete(conversationId);
    showRunning();
    // The answer is finished: read as the archive keeps it. One followed word by word is on screen
    // whole already, and is read again when the archive has it.
    const chat = window.chatManager;
    const followed = remote.followed.delete(conversationId);
    if (!running && !followed && chat?.conversation?.id === conversationId && !chat.generation) chat.selectConversation(conversationId).catch(() => {});
  });

  /* An answer the computer is writing, as it is written: the computer tells what changed in it since the
     last time (live-patch.js), and the chat on screen shows it at once. The archive has the answer at its
     steps and at its end, as before. */
  remote.live = new Map();       // message id -> { n }: the answers followed, and how far
  remote.followed = new Set();   // the chats where an answer was followed to its end
  let catching = null;

  function placeLive(chat, { id, n, full }) {
    const at = chat.messages.findIndex(m => m.id === id);
    if (at >= 0) Object.assign(chat.messages[at], full);
    else chat.messages.push({ ...full });
    remote.live.set(id, { n });
  }

  let drawing = null;
  function drawLive(chat, id) {
    if (drawing) return;
    drawing = requestAnimationFrame(() => {
      drawing = null;
      const message = chat.messages.find(m => m.id === id);
      // Drawn again in its place, the chat follows it by its own rule (chat.js, followStream).
      if (message && document.getElementById(`msg-bubble-${id}`)) chat.updateMessageStream(message);
      else {
        const atEnd = chat.atEnd();
        chat.render();
        chat.followStream(message, atEnd);
      }
    });
  }

  // The answers being written in a chat, whole: asked when the chat is opened while the computer
  // answers in it, and when something told of an answer was missed.
  async function catchUp(conversationId) {
    if (catching === conversationId) return;
    catching = conversationId;
    try {
      const { result } = await remote.call('chat.live', { conversationId });
      const chat = window.chatManager;
      if (chat?.conversation?.id !== conversationId) return;
      for (const message of result?.messages || []) { placeLive(chat, message); drawLive(chat, message.id); }
    } catch {} finally {
      if (catching === conversationId) catching = null;
    }
  }

  remote.on('chat.live', (packet = {}) => {
    const { conversationId, id, n, full, ops, done } = packet;
    const chat = window.chatManager;
    if (!id || !chat || chat.conversation?.id !== conversationId) { remote.live.delete(id); return; }
    const known = remote.live.get(id);
    if (full) placeLive(chat, packet);
    else {
      const message = chat.messages.find(m => m.id === id);
      if (!known || !message || n !== known.n + 1 || !window.livePatch.apply(message, ops)) {
        remote.live.delete(id);
        if (!done) catchUp(conversationId);
        return;
      }
      known.n = n;
    }
    if (done) { remote.live.delete(id); remote.followed.add(conversationId); }
    drawLive(chat, id);
  });

  /**
   * The archive's own methods, for the world shown: the list of the chats is the world's, and a chat made here is
   * born in it (on the computer, when that is the world: 'peer'). A project's chats are the computer's whatever the world.
   */
  function patchWorld() {
    const storage = window.chatStorage;
    if (!storage || storage._worldPatched) return;
    storage._worldPatched = true;
    const list = storage.list.bind(storage);
    storage.list = (query = '', archived = false) => storage.request(`/conversations?q=${encodeURIComponent(query)}&archived=${archived}&home=${remote.world === 'pc' ? 'others' : 'own'}`);
    storage._listAll = list;
    const create = storage.create.bind(storage);
    storage.create = (projectId = null, title) => storage.request('/conversations', 'POST', { ...(title ? { title } : {}), ...(projectId ? { projectId } : {}), home: projectId || remote.world === 'pc' ? 'peer' : 'own' });
    storage._createPlain = create;
  }

  function patchChat() {
    const chat = window.chatManager;
    if (!chat) return;
    const own = {
      send: chat.sendMessage.bind(chat),
      canStop: chat.canStopHere.bind(chat),
      stop: chat.stopGeneration.bind(chat),
      decide: chat.decideApproval.bind(chat),
      cancel: chat.cancelPendingApprovals.bind(chat)
    };
    const byComputer = (self) => Boolean(self.conversation && (ofProject(self) || remote.running.has(self.conversation.id)));
    chat.sendMessage = async function (text) {
      if (!ofProject(this)) return own.send(text);
      const words = String(text || '').trim();
      if (!words || !this.ready || this.loading || !this.conversation) return;
      const id = this.conversation.id;
      if (remote.running.has(id)) return;
      const input = document.getElementById('chat-input');
      // Written in this phone's archive, and shown, at once: the computer answers it when it has it.
      const message = this.makeMessage('user', words);
      try { await this.persist(message, id); } catch (error) { window.chatWorkspace?.error?.(error); return; }
      if (this.conversation?.id === id) {
        this.messages.push(message);
        this.render();
        this.scrollToBottom();
        if (input) { input.value = ''; input.style.height = 'auto'; }
      }
      this.drafts?.delete?.(id);
      remote.running.add(id);
      showRunning();
      try {
        // With the plan on (and none open in this chat) the computer plans the request first (plan.js).
        const plan = Boolean(window.planMode?.isOn(id) && !window.planMode.open(id));
        await remote.call('chat.send', { conversationId: id, text: words, id: message.id, plan });
      } catch (error) {
        remote.running.delete(id);
        showRunning();
        window.chatWorkspace?.error?.(new Error(refusalText(error)));
      }
    };
    chat.canStopHere = function () { return Boolean(this.conversation && remote.running.has(this.conversation.id)) || own.canStop(); };
    chat.stopGeneration = function () {
      const id = this.conversation?.id;
      if (id && remote.running.has(id)) remote.call('chat.stop', { conversationId: id }).catch(error => window.chatWorkspace?.error?.(new Error(refusalText(error))));
      else own.stop();
    };
    // What a model on the computer waits an answer for is answered there.
    chat.decideApproval = async function (approvalId, decision) {
      if (!byComputer(this)) return own.decide(approvalId, decision);
      // The card goes away when the computer has written the answer; until then its buttons wait.
      const buttons = [...document.querySelectorAll('.chat-tool-approval-actions button')];
      buttons.forEach(button => { button.disabled = true; });
      try {
        await remote.call('approvals.decide', { id: approvalId, decision });
      } catch (error) {
        buttons.forEach(button => { button.disabled = false; });
        window.chatWorkspace?.error?.(new Error(refusalText(error)));
      }
    };
    chat.cancelPendingApprovals = function () { if (!byComputer(this)) own.cancel(); };
    const select = chat.selectConversation.bind(chat);
    chat.selectConversation = async function (id) {
      const result = await select(id);
      showRunning();
      remote.live.clear();
      if (remote.running.has(id)) catchUp(id);
      return result;
    };
    chat.initialize = ((initialize) => async function () {
      await initialize();
      showRunning();
    })(chat.initialize.bind(chat));
  }

  // The vault is opened on the computer, which holds its keys: the phone waits for it (main.js asks).
  remote.waitUnlock = (then) => {
    const splash = document.getElementById('splash-unlock-form');
    const note = document.createElement('p');
    note.className = 'remote-locked';
    note.textContent = t('remote.locked');
    (splash?.parentElement || document.body).appendChild(note);
    const wait = async () => {
      try {
        const status = await window.chatStorage.getSecurityStatus();
        if (!(status?.isEncrypted && !status?.isUnlocked)) { note.remove(); then?.(); return; }
      } catch {}
      setTimeout(wait, 5000);
    };
    wait();
  };

  /* ------------------------------------------------------------------ */
  /* The projects                                                         */
  /* ------------------------------------------------------------------ */

  // The Code editor stays on the computer; the phone has the projects as pages
  // of their own: the list, then one project with its chats, its files, its
  // record and its artifacts, then one file, one step or one artifact. Every
  // thing read or written here is asked of the computer paired (`api`): the
  // files are there, in a folder of it or in its pod.
  const LOCALE = () => (window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT');
  const when = (iso, style = { dateStyle: 'medium', timeStyle: 'short' }) => { try { return new Date(iso).toLocaleString(LOCALE(), style); } catch { return String(iso || ''); } };
  const sizeOf = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  const PREVIEW_IMAGE = /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i;
  const TEXT_MOST = 400 * 1024;

  const projects = {
    list: [],
    open: null,       // the project whose pages are shown
    tab: 'chat',      // chat | files | history | artifacts
    chats: [],
    modes: null,      // what the model may do to the open project without asking: { code, terminal }
    plan: null,
    chat: null,       // the project's chat on screen: it is part of this zone, not of the Chat section
    // The files: the folders opened, what each holds, a search by name.
    files: { dirs: {}, opened: new Set(['']), search: '', found: null, loading: false },
    file: null,       // the file on its page: { path, content, text, size, editing, draft }
    // The record: the steps, and the one on its page with what it changed.
    history: { commits: [], more: false, loading: false },
    step: null,       // { ...commit, files, open: Set of files whose diff is shown }
    artifacts: { files: [], apart: false, loading: false },
    artifact: null,   // the artifact on its page: { ...entry, content | base64 | tooLarge }
    note: '',         // what the last action said (saved, taken back, refused)
    busy: false,

    build() {
      if (document.getElementById('view-projects')) return;
      const main = document.querySelector('.app-main-content');
      const view = document.createElement('section');
      view.id = 'view-projects';
      view.className = 'app-view remote-projects';
      view.style.display = 'none';
      main?.appendChild(view);
      view.addEventListener('click', (e) => this.onClick(e));
      view.addEventListener('change', (e) => this.onChange(e));
      view.addEventListener('input', (e) => this.onInput(e));
      const nav = document.querySelector('.nav-tabs');
      const code = document.getElementById('tab-btn-code');
      if (nav && code) {
        const tab = document.createElement('button');
        tab.className = 'nav-tab';
        tab.id = 'tab-btn-projects';
        tab.innerHTML = `<i class="fa-solid fa-folder-tree"></i><span>${esc(t('remote.projects'))}</span>`;
        tab.addEventListener('click', () => { this.chat = null; window.switchView('projects'); });
        nav.insertBefore(tab, code);
      }
    },

    /** The list and, with a project open, what its page shows now. */
    async load() {
      try { this.list = await window.chatStorage.listProjects(); } catch { this.list = this.list || []; }
      if (this.open) {
        this.open = this.list.find(project => project.id === this.open.id) || null;
        if (this.open) await this.loadTab();
      }
      this.render();
    },

    async loadTab() {
      const id = this.open?.id;
      if (!id) return;
      if (this.tab === 'chat') {
        try { this.chats = await window.chatStorage.listProjectChats(id); } catch {}
        // As the computer applies them; without it, as the project's row keeps them.
        let modes = { code: this.open.perm_code || 'manual', terminal: this.open.perm_terminal || 'manual' };
        try { modes = (await window.chatStorage.projectApprovals(id)).modes || modes; } catch {}
        let plan = { mode: 'manual', tries: 5 };
        try { plan = await window.planMode.settings(id); } catch {}
        if (this.open?.id === id) { this.modes = modes; this.plan = plan; }
      } else if (this.tab === 'files') await this.loadFiles();
      else if (this.tab === 'history') await this.loadHistory();
      else if (this.tab === 'artifacts') await this.loadArtifacts();
    },

    async loadFiles() {
      const id = this.open?.id;
      if (!id) return;
      this.files.loading = true;
      try {
        const { dirs } = await window.chatStorage.projectFiles(id, [...this.files.opened]);
        if (this.open?.id === id) {
          this.files.dirs = dirs || {};
          // A folder that is no longer there closes by itself.
          for (const dir of [...this.files.opened]) if (dir && this.files.dirs[dir] === null) this.files.opened.delete(dir);
        }
      } catch (error) { this.note = refusalText(error); }
      this.files.loading = false;
    },

    async loadHistory() {
      const id = this.open?.id;
      if (!id) return;
      this.history.loading = true;
      try {
        const out = await window.chatStorage.projectHistory(id, { limit: 100 });
        if (this.open?.id === id) { this.history.commits = out.commits || []; this.history.more = Boolean(out.more); }
      } catch (error) { this.note = refusalText(error); }
      this.history.loading = false;
    },

    async loadArtifacts() {
      const id = this.open?.id;
      if (!id) return;
      this.artifacts.loading = true;
      try {
        const out = await window.chatStorage.projectArtifacts(id);
        if (this.open?.id === id) { this.artifacts.files = out.files || []; this.artifacts.apart = Boolean(out.apart); }
      } catch (error) { this.note = refusalText(error); }
      this.artifacts.loading = false;
    },

    permissions() {
      const modes = this.modes || { code: this.open.perm_code || 'manual', terminal: this.open.perm_terminal || 'manual' };
      const names = { manual: 'code.permManual', semi: 'code.permSemi', auto: 'code.permAuto' };
      const select = (kind) => `<select data-perm="${kind}">${Object.keys(names).map(mode => `<option value="${mode}"${modes[kind] === mode ? ' selected' : ''}>${esc(t(names[mode]))}</option>`).join('')}</select>`;
      return `
        <div class="remote-perms">
          <label><span>${esc(t('remote.permCode'))}</span>${select('code')}</label>
          <label><span>${esc(t('remote.permTerminal'))}</span>${select('terminal')}</label>
          <p>${esc(t('remote.permHint'))}</p>
          <label><span>${esc(t('plan.name'))}</span><select data-plan-set="mode">${['manual', 'auto'].map(mode => `<option value="${mode}"${(this.plan?.mode || 'manual') === mode ? ' selected' : ''}>${esc(t(mode === 'auto' ? 'plan.modeAuto' : 'plan.modeManual'))}</option>`).join('')}</select></label>
          <label><span>${esc(t('plan.tries'))}</span><input type="number" data-plan-set="tries" min="1" max="50" step="1" value="${Number(this.plan?.tries) || 5}"></label>
          <p>${esc(t('plan.modeHint'))} ${esc(t('plan.triesHint'))}</p>
        </div>`;
    },

    async onChange(e) {
      const planField = e.target.closest('[data-plan-set]');
      if (planField && this.open) {
        const id = this.open.id;
        try { const plan = await window.planMode.setSettings(id, { [planField.dataset.planSet]: planField.value }); if (this.open?.id === id) this.plan = plan; }
        catch (error) { window.chatWorkspace?.error?.(new Error(refusalText(error))); }
        if (this.open?.id === id) this.render();
        return;
      }
      const upload = e.target.closest('input[data-upload]');
      if (upload && this.open) { await this.upload(upload); return; }
      const select = e.target.closest('select[data-perm]');
      if (!select || !this.open) return;
      const id = this.open.id;
      try {
        const updated = await window.chatStorage.setProjectPermissions(id, { [select.dataset.perm]: select.value });
        if (this.open?.id === id) this.modes = { code: updated.perm_code || this.modes?.code || 'manual', terminal: updated.perm_terminal || this.modes?.terminal || 'manual' };
      } catch (error) {
        window.chatWorkspace?.error?.(new Error(refusalText(error)));
      }
      if (this.open?.id === id) this.render();
    },

    onInput(e) {
      const search = e.target.closest('input[data-search]');
      if (search && this.open) {
        this.files.search = search.value;
        clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => this.search(), 250);
        return;
      }
      const draft = e.target.closest('textarea[data-draft]');
      if (draft && this.file) this.file.draft = draft.value;
    },

    async search() {
      const id = this.open?.id;
      const query = this.files.search.trim();
      if (!id) return;
      if (!query) { this.files.found = null; this.render(); return; }
      try {
        const out = await window.chatStorage.searchProjectFiles(id, query);
        if (this.open?.id === id && this.files.search.trim() === query) { this.files.found = out.files || []; this.render(); }
      } catch (error) { this.note = refusalText(error); this.render(); }
    },

    /* ---- the pages ---- */

    render() {
      const view = document.getElementById('view-projects');
      if (!view) return;
      const note = this.note ? `<p class="remote-note" role="status">${esc(this.note)}</p>` : '';
      if (!this.open) { view.innerHTML = this.listPage(); return; }
      if (this.file) { view.innerHTML = this.filePage() + note; return; }
      if (this.step) { view.innerHTML = this.stepPage() + note; return; }
      if (this.artifact) { view.innerHTML = this.artifactPage() + note; return; }
      view.innerHTML = this.projectPage() + note;
    },

    head(title, { back = 'back', action = '' } = {}) {
      return `
        <div class="remote-projects-head">
          <button type="button" class="btn-chat-action" data-act="${back}" aria-label="${esc(t('common.back'))}"><i class="fa-solid fa-arrow-left"></i></button>
          <h2>${esc(title)}</h2>
          ${action}
        </div>`;
    },

    listPage() {
      return `
        <div class="remote-projects-head"><h2>${esc(t('remote.projects'))}</h2></div>
        <ul class="remote-list">
          ${this.list.map(project => `
            <li><button type="button" class="remote-row" data-project="${esc(project.id)}">
              <i class="fa-solid ${project.kind === 'podman' ? 'fa-box' : 'fa-folder'}"></i>
              <span class="remote-row-text"><strong>${esc(project.name)}</strong><em>${esc(project.kind === 'podman' ? t('remote.inContainer') : t('remote.onComputer'))}</em></span>
              <i class="fa-solid fa-chevron-right"></i>
            </button></li>`).join('') || `<li class="remote-empty">${esc(t('remote.noProjects'))}</li>`}
        </ul>`;
    },

    projectPage() {
      const tabs = [['chat', 'fa-comments', 'remote.tabChats'], ['files', 'fa-folder-open', 'remote.tabFiles'], ['history', 'fa-clock-rotate-left', 'remote.tabHistory'], ['artifacts', 'fa-box-archive', 'remote.tabArtifacts']];
      const action = this.tab === 'chat'
        ? `<button type="button" class="btn btn-primary" data-act="new-chat"><i class="fa-solid fa-plus"></i> ${esc(t('remote.newChat'))}</button>`
        : this.tab === 'files'
          ? `<label class="btn btn-secondary remote-upload"><i class="fa-solid fa-upload"></i> ${esc(t('remote.upload'))}<input type="file" data-upload hidden></label>`
          : '';
      return `
        ${this.head(this.open.name, { action })}
        <div class="remote-tabs" role="tablist">
          ${tabs.map(([key, icon, label]) => `<button type="button" role="tab" class="remote-tab ${this.tab === key ? 'is-active' : ''}" data-tab="${key}" aria-selected="${this.tab === key}"><i class="fa-solid ${icon}"></i><span>${esc(t(label))}</span></button>`).join('')}
        </div>
        ${this.tab === 'chat' ? this.chatsTab() : this.tab === 'files' ? this.filesTab() : this.tab === 'history' ? this.historyTab() : this.artifactsTab()}`;
    },

    chatsTab() {
      return `
        ${this.permissions()}
        <ul class="remote-list">
          ${this.chats.map(chat => `
            <li><button type="button" class="remote-row" data-chat="${esc(chat.id)}">
              <i class="fa-solid ${remote.running.has(chat.id) ? 'fa-spinner fa-spin' : 'fa-comments'}"></i>
              <span class="remote-row-text"><strong>${esc(chat.title)}</strong><em>${esc(when(chat.updated_at))}</em></span>
              <i class="fa-solid fa-chevron-right"></i>
            </button></li>`).join('') || `<li class="remote-empty">${esc(t('remote.noChats'))}</li>`}
        </ul>`;
    },

    /** The folders opened, one under the other, each entry a row; or, with a search, the files found. */
    filesTab() {
      const search = `<div class="remote-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" data-search placeholder="${esc(t('remote.filesSearch'))}" value="${esc(this.files.search)}" autocomplete="off"></div>`;
      if (this.files.found) {
        return `${search}<ul class="remote-list remote-tree">
          ${this.files.found.map(file => `<li><button type="button" class="remote-row remote-tree-row" data-file="${esc(file)}"><i class="fa-regular fa-file"></i><span class="remote-row-text"><strong>${esc(file.slice(file.lastIndexOf('/') + 1))}</strong><em>${esc(file)}</em></span></button></li>`).join('')
            || `<li class="remote-empty">${esc(t('remote.filesNoMatch'))}</li>`}
        </ul>`;
      }
      const rows = [];
      const walk = (dir, depth) => {
        const entries = this.files.dirs[dir];
        if (!entries) { if (dir === '' && !this.files.loading) rows.push(`<li class="remote-empty">${esc(t('remote.filesEmpty'))}</li>`); return; }
        for (const entry of entries) {
          const full = dir ? `${dir}/${entry.name}` : entry.name;
          if (entry.dir) {
            const open = this.files.opened.has(full);
            rows.push(`<li><button type="button" class="remote-row remote-tree-row" style="--depth:${depth}" data-dir="${esc(full)}"><i class="fa-solid ${open ? 'fa-folder-open' : 'fa-folder'}"></i><span class="remote-row-text"><strong>${esc(entry.name)}</strong></span><i class="fa-solid ${open ? 'fa-chevron-down' : 'fa-chevron-right'}"></i></button></li>`);
            if (open) walk(full, depth + 1);
          } else {
            rows.push(`<li><button type="button" class="remote-row remote-tree-row" style="--depth:${depth}" data-file="${esc(full)}"><i class="fa-regular fa-file"></i><span class="remote-row-text"><strong>${esc(entry.name)}</strong></span></button></li>`);
          }
        }
        if (!entries.length && dir === '') rows.push(`<li class="remote-empty">${esc(t('remote.filesEmpty'))}</li>`);
      };
      walk('', 0);
      return `${search}<ul class="remote-list remote-tree">${rows.join('') || (this.files.loading ? `<li class="remote-empty">${esc(t('remote.loading'))}</li>` : '')}</ul>`;
    },

    /** The steps by day, the newest first: what, who, how much. */
    historyTab() {
      const commits = this.history.commits;
      if (!commits.length) return `<p class="remote-empty">${esc(this.history.loading ? t('remote.loading') : t('code.histEmpty'))}</p>`;
      const groups = [];
      for (const commit of commits) {
        const day = when(commit.when, { dateStyle: 'full' });
        if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, commits: [] });
        groups[groups.length - 1].commits.push(commit);
      }
      return `<div class="remote-history">${groups.map(group => `
        <h3>${esc(group.day)}</h3>
        <ul class="remote-list">${group.commits.map(commit => `
          <li><button type="button" class="remote-row" data-step="${esc(commit.hash)}">
            <i class="fa-solid ${commit.source === 'agent' ? 'fa-robot' : 'fa-user'}"></i>
            <span class="remote-row-text"><strong>${esc(commit.title || t('code.histUntitled'))}</strong>
              <em>${esc(when(commit.when, { timeStyle: 'short' }))} · ${esc(commit.source === 'agent' ? t('code.histModel') : t('code.histYou'))} · ${esc(t(commit.files === 1 ? 'code.histOneFileChanged' : 'code.histFilesChanged', { count: commit.files }))} <span class="remote-plus">+${commit.additions}</span> <span class="remote-minus">−${commit.deletions}</span>${commit.onGithub ? ` · ${esc(t('code.histOnGithub'))}` : ''}</em></span>
            <i class="fa-solid fa-chevron-right"></i>
          </button></li>`).join('')}
        </ul>`).join('')}
        ${this.history.more ? `<p class="remote-empty">${esc(t('remote.histMoreOnComputer'))}</p>` : ''}
      </div>`;
    },

    artifactsTab() {
      const files = this.artifacts.files;
      if (!files.length) return `<p class="remote-empty">${esc(this.artifacts.loading ? t('remote.loading') : t('remote.artifactsEmpty'))}</p>`;
      const icon = { image: 'fa-regular fa-image', document: 'fa-regular fa-file-image', text: 'fa-regular fa-file-lines', export: 'fa-solid fa-file-export', file: 'fa-regular fa-file' };
      return `<ul class="remote-list">${files.map(file => `
        <li><button type="button" class="remote-row" data-artifact="${esc(file.path)}">
          <i class="${icon[file.kind] || icon.file}"></i>
          <span class="remote-row-text"><strong>${esc(file.name)}</strong><em>${esc(sizeOf(file.bytes))} · ${esc(when(file.mtime))}${file.path !== file.name ? ` · ${esc(file.path)}` : ''}</em></span>
          <i class="fa-solid fa-chevron-right"></i>
        </button></li>`).join('')}</ul>`;
    },

    filePage() {
      const file = this.file;
      const action = file.text && !file.editing && file.size <= TEXT_MOST
        ? `<button type="button" class="btn btn-secondary" data-act="edit"><i class="fa-solid fa-pen"></i> ${esc(t('remote.fileEdit'))}</button>` : '';
      let body;
      if (file.loading) body = `<p class="remote-empty">${esc(t('remote.loading'))}</p>`;
      else if (file.editing) body = `
        <textarea class="remote-editor" data-draft spellcheck="false" autocapitalize="off" autocorrect="off">${esc(file.draft)}</textarea>
        <div class="remote-actions">
          <button type="button" class="btn btn-primary" data-act="save" ${this.busy ? 'disabled' : ''}><i class="fa-solid fa-floppy-disk"></i> ${esc(t('remote.fileSave'))}</button>
          <button type="button" class="btn btn-secondary" data-act="cancel-edit">${esc(t('common.cancel'))}</button>
        </div>`;
      else if (file.text) body = `<pre class="remote-code">${esc(file.content)}</pre>`;
      else if (PREVIEW_IMAGE.test(file.path) && file.base64) body = `<img class="remote-image" src="data:${esc(mimeOf(file.path))};base64,${file.base64}" alt="">`;
      else body = `<p class="remote-empty">${esc(t('remote.fileBinary', { size: sizeOf(file.size) }))}</p>`;
      return `${this.head(file.path.slice(file.path.lastIndexOf('/') + 1), { back: 'close-file', action })}
        <p class="remote-path">${esc(file.path)} · ${esc(sizeOf(file.size || 0))}</p>
        ${body}`;
    },

    stepPage() {
      const step = this.step;
      const status = { A: 'code.histAdded', M: 'code.histModified', D: 'code.histDeleted', R: 'code.histRenamed', C: 'code.histCopied', T: 'code.histModified' };
      const files = step.files || [];
      return `${this.head(step.title || t('code.histUntitled'), { back: 'close-step' })}
        <p class="remote-path">${esc(when(step.when))} · ${esc(step.source === 'agent' ? t('code.histModel') : t('code.histYou'))} · ${esc(step.short)}</p>
        ${step.body ? `<p class="remote-body">${esc(step.body)}</p>` : ''}
        <div class="remote-actions">
          <button type="button" class="btn btn-secondary" data-act="restore-all" ${this.busy ? 'disabled' : ''}><i class="fa-solid fa-rotate-left"></i> ${esc(t('code.histRestoreAll'))}</button>
        </div>
        ${step.loading ? `<p class="remote-empty">${esc(t('remote.loading'))}</p>` : ''}
        ${step.tooLarge ? `<p class="remote-empty">${esc(t('code.histTooLarge'))}</p>` : ''}
        <ul class="remote-list remote-changes">${files.map((file, index) => `
          <li class="remote-change">
            <button type="button" class="remote-row" data-diff="${index}">
              <i class="fa-regular ${file.status === 'D' ? 'fa-trash-can' : 'fa-file-lines'}"></i>
              <span class="remote-row-text"><strong>${esc(file.path)}</strong><em>${esc(t(status[file.status] || 'code.histModified'))}${file.oldPath ? ` · ${esc(file.oldPath)}` : ''} <span class="remote-plus">+${file.additions || 0}</span> <span class="remote-minus">−${file.deletions || 0}</span></em></span>
              <i class="fa-solid ${step.open.has(index) ? 'fa-chevron-down' : 'fa-chevron-right'}"></i>
            </button>
            ${step.open.has(index) ? `
              ${file.binary ? `<p class="remote-empty">${esc(t('code.histBinary'))}</p>` : `<pre class="remote-diff">${diffHtml(file.hunks || '')}</pre>${file.truncated ? `<p class="remote-empty">${esc(t('code.histDiffCut'))}</p>` : ''}`}
              <div class="remote-actions">
                <button type="button" class="btn btn-secondary" data-act="restore-file" data-path="${esc(file.path)}" ${this.busy ? 'disabled' : ''}><i class="fa-solid fa-rotate-left"></i> ${esc(t('code.histRestoreFile'))}</button>
              </div>` : ''}
          </li>`).join('')}</ul>`;
    },

    artifactPage() {
      const item = this.artifact;
      let body;
      if (item.loading) body = `<p class="remote-empty">${esc(t('remote.loading'))}</p>`;
      else if (item.tooLarge) body = `<p class="remote-empty">${esc(t('remote.artifactTooLarge', { size: sizeOf(item.size) }))}</p>`;
      else if (item.kind === 'image' && item.base64 && PREVIEW_IMAGE.test(item.path)) body = `<img class="remote-image" src="data:${esc(mimeOf(item.path))};base64,${item.base64}" alt="">`;
      else if (item.text) body = `<pre class="remote-code">${esc(item.content)}</pre>`;
      else body = `<p class="remote-empty">${esc(t('remote.artifactOnComputer'))}</p>`;
      return `${this.head(item.name || item.path, { back: 'close-artifact' })}
        <p class="remote-path">${esc(item.path)} · ${esc(sizeOf(item.size || item.bytes || 0))}</p>
        ${body}`;
    },

    /* ---- what the buttons do ---- */

    async onClick(e) {
      const button = e.target.closest('button');
      if (!button) return;
      const act = button.dataset.act;
      this.note = '';
      if (button.dataset.project) {
        this.open = this.list.find(project => project.id === button.dataset.project) || null;
        this.chats = []; this.modes = null; this.plan = null; this.tab = 'chat';
        this.files = { dirs: {}, opened: new Set(['']), search: '', found: null, loading: false };
        this.history = { commits: [], more: false, loading: false };
        this.artifacts = { files: [], apart: false, loading: false };
        this.render();
        await this.load();
      } else if (act === 'back') {
        this.open = null;
        this.render();
      } else if (button.dataset.tab) {
        this.tab = button.dataset.tab;
        this.render();
        await this.loadTab();
        this.render();
      } else if (act === 'new-chat' && this.open) {
        try {
          const chat = await window.chatStorage.create(this.open.id, t('code.aiChatName', { n: this.chats.length + 1 }));
          await this.openChat(chat.id);
        } catch (error) { window.chatWorkspace?.error?.(error); }
      } else if (button.dataset.chat) {
        await this.openChat(button.dataset.chat);
      } else if (button.dataset.dir !== undefined) {
        const dir = button.dataset.dir;
        if (this.files.opened.has(dir)) {
          for (const open of [...this.files.opened]) if (open === dir || open.startsWith(dir + '/')) this.files.opened.delete(open);
        } else this.files.opened.add(dir);
        this.render();
        await this.loadFiles();
        this.render();
      } else if (button.dataset.file) {
        await this.openFile(button.dataset.file);
      } else if (act === 'close-file') {
        this.file = null;
        this.render();
      } else if (act === 'edit' && this.file) {
        this.file.editing = true;
        this.file.draft = this.file.content;
        this.render();
      } else if (act === 'cancel-edit' && this.file) {
        this.file.editing = false;
        this.render();
      } else if (act === 'save' && this.file) {
        await this.saveFile();
      } else if (button.dataset.step) {
        await this.openStep(button.dataset.step);
      } else if (act === 'close-step') {
        this.step = null;
        this.render();
      } else if (button.dataset.diff !== undefined && this.step) {
        const index = Number(button.dataset.diff);
        if (this.step.open.has(index)) this.step.open.delete(index); else this.step.open.add(index);
        this.render();
      } else if ((act === 'restore-all' || act === 'restore-file') && this.step) {
        await this.restore(act === 'restore-file' ? button.dataset.path : null);
      } else if (button.dataset.artifact) {
        await this.openArtifact(button.dataset.artifact);
      } else if (act === 'close-artifact') {
        this.artifact = null;
        this.render();
      }
    },

    async openFile(path) {
      const id = this.open?.id;
      this.file = { path, loading: true, editing: false };
      this.render();
      try {
        const out = await window.chatStorage.readProjectFile(id, path);
        if (this.open?.id === id && this.file?.path === path) this.file = { ...out, editing: false, draft: out.content || '' };
      } catch (error) {
        this.file = null;
        this.note = refusalText(error);
      }
      this.render();
    },

    async saveFile() {
      const id = this.open?.id;
      const file = this.file;
      if (!id || !file || this.busy) return;
      this.busy = true;
      this.render();
      try {
        const out = await window.chatStorage.writeProjectFile(id, { path: file.path, content: file.draft });
        if (this.file === file) { file.content = file.draft; file.size = out.size; file.editing = false; }
        this.note = t('remote.fileSaved');
      } catch (error) { this.note = refusalText(error); }
      this.busy = false;
      this.render();
    },

    /** A file of this phone, put among the project's files in the folder shown last, under its own name. */
    async upload(input) {
      const id = this.open?.id;
      const chosen = input.files?.[0];
      if (!id || !chosen) return;
      const opened = [...this.files.opened].filter(Boolean).sort((a, b) => b.length - a.length);
      const folder = opened[0] || '';
      const name = chosen.name.replace(/[\u0000-\u001f<>:"|?*\\/]/g, '_');
      const target = folder ? `${folder}/${name}` : name;
      this.note = t('remote.uploading', { name });
      this.busy = true;
      this.render();
      try {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
          reader.onerror = () => reject(new Error('lettura non riuscita'));
          reader.readAsDataURL(chosen);
        });
        await window.chatStorage.writeProjectFile(id, { path: target, base64 });
        this.note = t('remote.uploaded', { path: target });
        await this.loadFiles();
      } catch (error) { this.note = refusalText(error); }
      this.busy = false;
      this.render();
    },

    async openStep(hash) {
      const id = this.open?.id;
      const known = this.history.commits.find(commit => commit.hash === hash) || { hash, short: hash.slice(0, 7) };
      this.step = { ...known, files: [], open: new Set(), loading: true };
      this.render();
      try {
        const out = await window.chatStorage.projectHistoryCommit(id, hash);
        if (this.open?.id === id && this.step?.hash === hash) this.step = { ...out, open: new Set(out.files?.length === 1 ? [0] : []), loading: false };
      } catch (error) {
        this.step = null;
        this.note = refusalText(error);
      }
      this.render();
    },

    /** A file, or the whole project, taken back to the step on screen: asked first, then a step of its own. */
    async restore(path) {
      const id = this.open?.id;
      const step = this.step;
      if (!id || !step || this.busy) return;
      const question = path ? t('code.histRestoreFileMessage', { file: path, version: step.short, when: when(step.when) }) : t('code.histRestoreAllMessage', { version: step.short, when: when(step.when) });
      if (!window.confirm(question)) return;
      this.busy = true;
      this.render();
      try {
        await window.chatStorage.restoreProject(id, step.hash, path);
        this.note = path ? t('code.histRestoredFile', { file: path, version: step.short }) : t('code.histRestoredAll', { version: step.short });
        this.step = null;
        await this.loadHistory();
      } catch (error) { this.note = refusalText(error); }
      this.busy = false;
      this.render();
    },

    async openArtifact(path) {
      const id = this.open?.id;
      const known = this.artifacts.files.find(file => file.path === path) || { path, name: path };
      this.artifact = { ...known, loading: true };
      this.render();
      try {
        const out = await window.chatStorage.readProjectArtifact(id, path);
        if (this.open?.id === id && this.artifact?.path === path) this.artifact = { ...known, ...out, loading: false };
      } catch (error) {
        this.artifact = null;
        this.note = refusalText(error);
      }
      this.render();
    },

    /** One level up, for the phone's back button: true when there was a level to leave. */
    back() {
      if (this.file) { this.file = null; this.render(); return true; }
      if (this.step) { this.step = null; this.render(); return true; }
      if (this.artifact) { this.artifact = null; this.render(); return true; }
      if (this.open) { this.open = null; this.render(); return true; }
      return false;
    },

    // A project's chat opens here, in the zone of the projects: the conversation takes the screen, and the
    // arrow in its bar goes back to the project. The Chat section keeps the chats that belong to no project.
    async openChat(id) {
      this.chat = id;
      window.switchView('projects');
      await window.chatManager.selectConversation(id);
    },

    closeChat() {
      this.chat = null;
      window.switchView('projects');
    }
  };

  const MIMES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml' };
  function mimeOf(file) { return MIMES[String(file).slice(String(file).lastIndexOf('.') + 1).toLowerCase()] || 'application/octet-stream'; }

  /** A unified diff, one line a row, the added and the removed told apart; never markup from the repository. */
  function diffHtml(hunks) {
    return String(hunks).split('\n').map(line => {
      const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
      return `<span class="remote-diff-line ${kind}">${esc(line)}</span>`;
    }).join('\n');
  }

  // The chat the Chat section goes back to when a project's chat was the one on screen.
  const GENERAL = 'synthorg_phone_general_chat';
  const generalKey = () => `${GENERAL}_${remote.world}`;
  async function generalChat(always = false) {
    const chat = window.chatManager;
    if (!always && !chat?.conversation?.project_id) return;
    try {
      const chats = await window.chatStorage.list();
      let last = '';
      try { last = localStorage.getItem(generalKey()) || ''; } catch {}
      const id = chats.find(c => c.id === last)?.id || chats[0]?.id || (await window.chatStorage.create()).id;
      await chat.selectConversation(id);
    } catch {}
  }
  remote.projects = projects;

  /** Chats: the list slides over the conversation; a chat chosen closes it. */
  function chatList() {
    const layout = document.querySelector('.chat-workspace-layout');
    const toolbar = document.querySelector('.conversation-toolbar');
    if (!layout || !toolbar || document.getElementById('remote-list-toggle')) return;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = 'remote-list-toggle';
    toggle.className = 'btn-chat-action remote-list-toggle';
    toggle.setAttribute('aria-label', t('chat.sidebarAriaLabel'));
    toggle.innerHTML = '<i class="fa-solid fa-bars"></i>';
    toggle.addEventListener('click', () => {
      if (projects.chat) { projects.closeChat(); return; }
      layout.classList.toggle('list-open');
    });
    toolbar.prepend(toggle);
    const chat = window.chatManager;
    const select = chat.selectConversation.bind(chat);
    chat.selectConversation = async function (id) {
      layout.classList.remove('list-open');
      const result = await select(id);
      if (this.conversation?.id === id && !this.conversation.project_id) { try { localStorage.setItem(generalKey(), id); } catch {} }
      return result;
    };
  }

  /**
   * Chats: the conversation takes the screen. The Master, the artifacts, the
   * memory, the environment and the tools move to a page of their own, opened
   * from the button next to the title; each of them opens its own page from
   * there. The elements are main.js's own, moved: chat.js draws them by id.
   */
  const chatDetails = {
    page: null,

    build() {
      const workspace = document.querySelector('.conversation-workspace');
      const toolbar = document.querySelector('.conversation-toolbar');
      if (!workspace || !toolbar || this.page) return;
      this.page = document.createElement('div');
      this.page.className = 'ph-chat-details';
      this.page.hidden = true;
      this.page.innerHTML = `
        <div class="ph-settings-head"><button type="button" class="ph-settings-back" aria-label="${esc(t('code.back'))}"><i class="fa-solid fa-arrow-left"></i></button><strong>${esc(t('remote.chatDetails'))}</strong></div>
        <div class="ph-chat-details-body"></div>`;
      const body = this.page.querySelector('.ph-chat-details-body');
      body.append(document.getElementById('chat-header-master-info'), document.getElementById('chat-artifacts-slot'), document.getElementById('chat-active-orchestrator-bar'));
      this.page.querySelector('.ph-settings-back').addEventListener('click', () => this.close());
      workspace.append(this.page);
      const open = document.createElement('button');
      open.type = 'button';
      open.id = 'remote-chat-details';
      open.className = 'btn-chat-action remote-chat-details';
      open.setAttribute('aria-label', t('remote.chatDetails'));
      open.innerHTML = '<i class="fa-solid fa-sliders"></i>';
      open.addEventListener('click', () => { this.page.hidden = false; });
      toolbar.append(open);
      // Another chat chosen: its conversation, not the details of the one before.
      const chat = window.chatManager;
      const select = chat.selectConversation.bind(chat);
      chat.selectConversation = async (id) => { this.close(); return select(id); };
    },

    /** The page open over the chat: a panel opened from it, or the page itself. */
    popover() {
      return [...(this.page?.querySelectorAll('.chat-tool-info-popover') || [])].find(el => el.style.display && el.style.display !== 'none');
    },

    back() {
      const panel = this.popover();
      if (panel) { panel.querySelector('.btn-popover-close')?.click(); return true; }
      if (this.page && !this.page.hidden) { this.close(); return true; }
      return false;
    },

    close() {
      const panel = this.popover();
      if (panel) panel.querySelector('.btn-popover-close')?.click();
      if (this.page) this.page.hidden = true;
    }
  };
  remote.chatDetails = chatDetails;

  /**
   * The models of one chat (chat-models.js): the list of roles, then the
   * chosen role on a page of its own, with a back arrow to the list.
   */
  const chatModelsNav = {
    dialog() { return document.querySelector('.chat-models-dialog'); },

    show(page) {
      const dialog = this.dialog();
      if (!dialog) return;
      dialog.dataset.ph = page;
      const head = dialog.querySelector('.chat-models-head');
      if (head && !head.querySelector('.chat-models-back')) {
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'ph-settings-back chat-models-back';
        back.setAttribute('aria-label', t('code.back'));
        back.innerHTML = '<i class="fa-solid fa-arrow-left"></i>';
        back.addEventListener('click', () => this.show('roles'));
        head.prepend(back);
      }
    },

    build() {
      const models = window.chatModels;
      if (!models?.open) return;
      const open = models.open.bind(models);
      // Opened from a role (the Master, a tool's pencil): that role's page.
      models.open = (...args) => { const result = open(...args); this.show(args[0] ? 'role' : 'roles'); return result; };
      document.addEventListener('click', (event) => {
        if (event.target.closest('.chat-models-dialog .chat-models-role')) this.show('role');
      }, true);
    },

    back() {
      const dialog = this.dialog();
      if (!dialog?.open || dialog.dataset.ph !== 'role') return false;
      this.show('roles');
      return true;
    }
  };

  function patchViews() {
    // The projects are the computer's: their zone is there with a computer paired.
    if (remote.paired) projects.build();
    // What the computer's page keeps elsewhere goes back where the phone has it: the
    // settings among the sections, the language in the header, the shared memories under the chats.
    document.querySelector('.nav-tabs')?.append(document.getElementById('tab-btn-settings'));
    document.querySelector('.header-actions')?.prepend(document.getElementById('btn-toggle-lang'));
    document.querySelector('.conversation-sidebar')?.append(document.getElementById('btn-open-global-memory'));
    chatList();
    chatDetails.build();
    chatModelsNav.build();
    settingsNav.build();
    const switched = window.switchView;
    const views = ['realtime', 'chat', 'projects', 'settings'];
    window.switchView = function (name) {
      if (name === 'code') name = remote.paired ? 'projects' : 'chat';
      // The projects are the computer's Code section: not shown while it is switched off there.
      if (name === 'projects' && window.sections?.on('code') === false) name = 'chat';
      if (name === 'projects' && !remote.paired) name = 'chat';
      if (!views.includes(name)) return;
      const view = document.getElementById('view-projects');
      const toggle = document.getElementById('remote-list-toggle');
      if (name === 'projects') {
        // The list of the projects, or the chat of one of them: the same conversation screen, inside this zone.
        const inChat = Boolean(projects.chat);
        switched('chat');
        if (!inChat) document.getElementById('view-chat').style.display = 'none';
        document.getElementById('tab-btn-chat')?.classList.remove('active');
        if (view) view.style.display = inChat ? 'none' : 'flex';
        if (toggle) toggle.innerHTML = inChat ? '<i class="fa-solid fa-arrow-left"></i>' : '<i class="fa-solid fa-bars"></i>';
        if (!inChat) projects.load();
      } else {
        projects.chat = null;
        if (toggle) toggle.innerHTML = '<i class="fa-solid fa-bars"></i>';
        if (view) view.style.display = 'none';
        switched(name);
        if (name === 'chat') generalChat();
      }
      document.getElementById('tab-btn-projects')?.classList.toggle('active', name === 'projects');
      document.documentElement.dataset.view = name;
    };
    Object.assign(window.switchView, switched);
    document.addEventListener('synthorg-changed', (event) => {
      if (event.detail?.projects || (event.detail?.changes || []).some(change => /^\/api\/conversations/.test(change.path || ''))) {
        if (document.getElementById('view-projects')?.style.display !== 'none') projects.load();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Settings, one page at a time                                         */
  /* ------------------------------------------------------------------ */

  // On the computer the settings are tabs and panes side by side. Here each
  // choice opens a page of its own: the sections, then a section's tabs or
  // roles, then a role's models or parameters, then one prompt. The pages
  // are the same elements main.js draws; this only says which level shows
  // (data-ph on #view-settings, read by styles.css) and adds the bar to go back.
  const settingsNav = {
    stack: [],     // { kind: section | sub | item | pane | card, title, card? }
    view: null,
    head: null,

    build() {
      this.view = document.getElementById('view-settings');
      if (!this.view || this.head) return;
      this.head = document.createElement('div');
      this.head.className = 'ph-settings-head';
      this.head.innerHTML = `<button type="button" class="ph-settings-back" aria-label="${esc(t('code.back'))}"><i class="fa-solid fa-arrow-left"></i></button><strong></strong>`;
      this.head.querySelector('button').addEventListener('click', () => this.back());
      this.view.prepend(this.head);
      // Before main.js's own handlers: the level is known when the page is drawn.
      this.view.addEventListener('click', (event) => this.onClick(event), true);
      // main.js draws the pages again when a value changes: the open prompt is marked again.
      new MutationObserver(() => this.mark()).observe(this.view.querySelector('.settings-subview-container'), { childList: true, subtree: true });
      document.getElementById('tab-btn-settings')?.addEventListener('click', () => {
        if (document.documentElement.dataset.view === 'settings') { this.stack = []; this.apply(); }
      }, true);
      this.apply();
    },

    top() { return this.stack[this.stack.length - 1]; },
    label(el) { return (el?.textContent || '').trim(); },

    onClick(event) {
      const el = event.target.closest('.settings-subnav-tab, [data-env-subtab], [data-prompts-subtab], .settings-sidebar-item, .settings-role-tab-btn, .prompt-card');
      if (!el || !this.view.contains(el)) return;
      const top = this.top()?.kind;
      if (el.matches('.settings-subnav-tab') && !top) {
        this.push({ kind: 'section', title: this.label(el.querySelector('span')) });
      } else if (el.matches('[data-env-subtab], [data-prompts-subtab]') && top === 'section') {
        this.push({ kind: 'sub', title: this.label(el.querySelector('span')) });
      } else if (el.matches('.settings-sidebar-item') && top === 'section') {
        this.push({ kind: 'item', title: this.label(el.querySelector('.settings-item-name span:last-child')) });
      } else if (el.matches('.settings-role-tab-btn') && top === 'item') {
        this.push({ kind: 'pane', title: this.label(el.querySelector('span')) });
      } else if (el.matches('.prompt-card') && top === 'sub') {
        this.push({ kind: 'card', title: this.label(el.querySelector('.prompt-card-title')), card: el.id });
      }
    },

    push(page) { this.stack.push(page); this.apply(); },

    /** One level up; false when already at the list of sections. */
    back() {
      if (!this.stack.length) return false;
      this.stack.pop();
      this.apply();
      return true;
    },

    apply() {
      if (!this.view) return;
      this.view.dataset.ph = this.stack.map(page => page.kind).join(' ') || 'root';
      this.head.querySelector('strong').textContent = this.top()?.title || '';
      this.mark();
      this.view.querySelectorAll('.settings-subview-container > *, .settings-workspace').forEach(el => { el.scrollTop = 0; });
    },

    mark() {
      const card = this.top()?.kind === 'card' ? this.top().card : '';
      this.view.querySelectorAll('.prompt-card').forEach(el => {
        const open = el.id === card;
        if (el.classList.contains('ph-open') !== open) el.classList.toggle('ph-open', open);
      });
    }
  };
  remote.settingsNav = settingsNav;

  /* ------------------------------------------------------------------ */
  /* Pairing                                                              */
  /* ------------------------------------------------------------------ */

  // Pairing: the phone's name, and the code the computer shows, read with the
  // camera (used at once) or pasted. Shown when the app is first opened, and
  // from the pill in the header after; the phone can also be used without.
  const ALONE = 'synthorg_phone_alone';
  remote.closePairing = () => {
    try { localStorage.setItem(ALONE, '1'); } catch {}
    document.querySelector('.remote-pairing')?.remove();
    document.documentElement.classList.remove('is-pairing');
  };
  function pairingScreen() {
    if (document.querySelector('.remote-pairing')) return;
    const screen = document.createElement('div');
    screen.className = 'remote-pairing';
    screen.innerHTML = `
      <div class="remote-pairing-card">
        <img src="icons/synthorg_logo.png" alt="" class="remote-pairing-logo">
        <h2>${esc(t('remote.pairTitle'))}</h2>
        <p>${esc(t('remote.pairSteps'))}</p>
        <label class="remote-pairing-field">
          <span>${esc(t('remote.pairName'))}</span>
          <input type="text" maxlength="60" data-field="name" value="${esc(t('remote.pairNameDefault'))}">
        </label>
        <button type="button" class="btn btn-primary" data-act="scan"><i class="fa-solid fa-qrcode"></i> ${esc(t('remote.pairScan'))}</button>
        <label class="remote-pairing-field">
          <span>${esc(t('remote.pairCode'))}</span>
          <textarea rows="4" spellcheck="false" autocapitalize="characters" autocomplete="off" data-field="code"></textarea>
        </label>
        <button type="button" class="btn" data-act="paste"><i class="fa-solid fa-link"></i> ${esc(t('remote.pairGo'))}</button>
        <p class="remote-pairing-status" role="status"></p>
        <p>${esc(t('remote.pairAloneNote'))}</p>
        <button type="button" class="btn" data-act="alone">${esc(t('remote.pairAlone'))}</button>
      </div>`;
    const name = screen.querySelector('[data-field="name"]');
    const pasted = screen.querySelector('[data-field="code"]');
    const status = screen.querySelector('.remote-pairing-status');
    let timer = null;
    const busy = (on, started = Date.now()) => {
      screen.querySelectorAll('button, input, textarea').forEach(control => { control.disabled = on; });
      clearInterval(timer);
      if (on) {
        const tick = () => { status.textContent = t('remote.pairWorking', { seconds: Math.round((Date.now() - started) / 1000) }); };
        tick();
        timer = setInterval(tick, 1000);
      }
    };
    const pair = async (code) => {
      busy(true);
      try {
        await tauri.core.invoke('remote_pair', { code, name: name.value });
        keepPaired(true);
        busy(false);
        status.textContent = t('remote.pairDone');
        setTimeout(() => location.reload(), 800);
      } catch (error) {
        busy(false);
        status.textContent = error?.message || String(error);
      }
    };
    screen.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'alone') { remote.closePairing(); return; }
      if (act === 'paste') {
        const code = pasted.value.replace(/\s+/g, '').toUpperCase();
        if (!code.startsWith('SYNTHORG-BRIDGE:')) { status.textContent = t('remote.pairBadCode'); return; }
        pair(code);
        return;
      }
      if (act !== 'scan') return;
      let code = '';
      try {
        await tauri.core.invoke('plugin:barcode-scanner|request_permissions').catch(() => {});
        // A scan left with the back button never answers: the one under way is the one that counts.
        const attempt = ++remote.scans;
        remote.scanning = true;
        const got = await tauri.core.invoke('plugin:barcode-scanner|scan', { windowed: false, formats: ['QR_CODE'] }).finally(() => { if (remote.scans === attempt) remote.scanning = false; });
        if (remote.scans !== attempt) return;
        code = String(got?.content || '').replace(/\s+/g, '').toUpperCase();
      } catch (error) {
        status.textContent = t('remote.pairScanError', { error: error?.message || String(error) });
        return;
      }
      if (!code) return;
      if (!code.startsWith('SYNTHORG-BRIDGE:')) { status.textContent = t('remote.pairBadCode'); return; }
      pair(code);
    });
    document.body.appendChild(screen);
    document.documentElement.classList.add('is-pairing');
  }

  // What the shell said when the window was made may be older than a pairing just done: it is asked again.
  if (!remote.paired) {
    document.addEventListener('DOMContentLoaded', () => {
      let alone = false;
      try { alone = localStorage.getItem(ALONE) === '1'; } catch {}
      if (!alone) pairingScreen();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Links                                                                */
  /* ------------------------------------------------------------------ */

  // The window holds the app's page and nothing else. A link that leads
  // outside opens in the phone's browser; a file of a chat opens over the
  // page, with the way back. Nothing replaces the page.
  const INSIDE = /^https?:\/\/([a-z0-9-]+\.)*localhost(:\d+)?(\/|$)/i;
  const FILE = /\/api\/conversations\/[^/]+\/sandbox\/files\/([^?#]+)/;

  const viewer = {
    el: null,

    async open(url, name) {
      this.close();
      const address = window.synthorgResolveUrl ? window.synthorgResolveUrl(url.replace(/^https?:\/\/[^/]+(?=\/api\/)/i, '')) : url;
      let label = name;
      if (!label) { try { label = decodeURIComponent(FILE.exec(url)?.[1].split('/').pop() || ''); } catch { label = ''; } }
      const kind = /\.(png|jpe?g|webp|gif|svg|bmp|ico)$/i.test(label) ? 'image' : /\.(mp4|webm|mov|mkv)$/i.test(label) ? 'video' : /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(label) ? 'audio' : 'text';
      const el = this.el = document.createElement('div');
      el.className = 'ph-viewer';
      el.innerHTML = `
        <div class="ph-settings-head"><button type="button" class="ph-settings-back" aria-label="${esc(t('code.back'))}"><i class="fa-solid fa-arrow-left"></i></button><strong>${esc(label)}</strong></div>
        <div class="ph-viewer-body is-${kind}"></div>`;
      el.querySelector('.ph-settings-back').addEventListener('click', () => this.close());
      document.body.appendChild(el);
      const body = el.querySelector('.ph-viewer-body');
      if (kind === 'image') body.innerHTML = `<img src="${esc(address)}" alt="">`;
      else if (kind === 'video') body.innerHTML = `<video src="${esc(address)}" controls playsinline></video>`;
      else if (kind === 'audio') body.innerHTML = `<audio src="${esc(address)}" controls></audio>`;
      else {
        try {
          const response = await fetch(address);
          if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || String(response.status));
          const type = response.headers.get('content-type') || '';
          if (!/^text\/|json|xml|csv|markdown|javascript/.test(type)) throw new Error(t('remote.viewerNoPreview'));
          const pre = document.createElement('pre');
          pre.textContent = (await response.text()).slice(0, 400000);
          if (this.el === el) body.appendChild(pre);
        } catch (error) {
          if (this.el === el) body.innerHTML = `<p class="ph-viewer-note">${esc(error?.message || String(error))}</p>`;
        }
      }
    },

    close() {
      if (!this.el) return false;
      this.el.remove();
      this.el = null;
      return true;
    }
  };
  remote.viewer = viewer;

  /** Whether the link was taken care of here (and must not be followed by the window). */
  function openLink(url, name) {
    const address = String(url || '');
    if (/^mailto:/i.test(address) || (/^https?:/i.test(address) && !INSIDE.test(address))) {
      window.SynthorgAndroid?.openExternal?.(address);
      return true;
    }
    if (FILE.test(address)) { viewer.open(address, name); return true; }
    return false;
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return;
    if (openLink(link.href, link.getAttribute('download') || '')) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  const openWindow = window.open.bind(window);
  window.open = (url, ...rest) => {
    let address = '';
    try { address = new URL(String(url || ''), location.href).href; } catch {}
    return address && openLink(address) ? null : openWindow(url, ...rest);
  };

  /* ------------------------------------------------------------------ */
  /* The back button                                                      */
  /* ------------------------------------------------------------------ */

  // Android's back button goes back inside the app: out of the camera, the
  // list of chats, a dialog, a project; from the other sections to the
  // assistant. Only from there the app goes to the background, where the
  // link with the computer stays as it is.
  function onBack() {
    if (remote.scanning) {
      remote.scanning = false;
      remote.scans += 1;
      tauri.core.invoke('plugin:barcode-scanner|cancel').catch(() => {});
      return;
    }
    if (viewer.close()) return;
    const sheet = document.querySelector('.remote-sheet-backdrop');
    if (sheet) { sheet.remove(); return; }
    if (chatModelsNav.back()) return;
    const dialog = [...document.querySelectorAll('dialog[open]')].pop();
    if (dialog) { dialog.close(); return; }
    if (document.querySelector('.inspector-drawer.open')) { window.closeDrawer(); return; }
    if (document.getElementById('view-chat')?.style.display !== 'none' && chatDetails.back()) return;
    const list = document.querySelector('.chat-workspace-layout.list-open');
    if (list) { list.classList.remove('list-open'); return; }
    const shown = (id) => document.getElementById(id)?.style.display !== 'none';
    if (projects.chat) { projects.closeChat(); return; }
    if (shown('view-projects') && projects.back()) return;
    if (shown('view-settings') && settingsNav.back()) return;
    if (!document.querySelector('.remote-pairing') && !shown('view-realtime')) { window.switchView('realtime'); return; }
    window.SynthorgAndroid?.toBackground();
  }
  tauri.app?.onBackButtonPress?.(onBack)?.catch?.(() => {});

  // The modules' objects exist already: they are pointed to the computer at once. What main.js
  // makes (the views) is changed when the document is ready, before main.js starts the page.
  // What an earlier version left in the page's storage in place of the key, when the key was the computer's alone.
  try {
    if (localStorage.getItem('synthorg_openrouter_api_key') === 'sul-computer') localStorage.removeItem('synthorg_openrouter_api_key');
    localStorage.removeItem('synthorg_remote_key_there');
  } catch {}
  patchWorld();
  if (remote.paired) patchChat();
  document.addEventListener('DOMContentLoaded', () => {
    patchViews();
    renderLink();
  });
})();
