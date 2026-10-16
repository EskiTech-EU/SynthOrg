/*
 * The same archive on every side.
 *
 * This computer's page and a paired phone show the same things: chats,
 * projects, the assistant's pages, the settings. Each device keeps the
 * archive whole and writes what is done on it at once; the rows written go
 * to the other device (server/replica.js). This module shows, on the device
 * that did not make it, what a change changed: as if it had been made there.
 *
 * Here the page waits on the local service for what the phones wrote
 * (server/sync.js, `take`). On the phone the computer's rows are written in
 * the phone's archive by its shell, which then says what they changed
 * (remote.js hands that to `apply`). What only the computer has (a chat's
 * container and files, the projects) the phone shows from a copy and checks
 * with the computer after: what turned out different is shown again
 * (`refreshed`).
 * Settings have a copy in the page's storage, read at once by the modules
 * that own them: the copy is brought in line before those modules read the
 * archive again. The rest is read again where it is shown; each module can
 * also listen to `synthorg-changed` for what only it knows how to show.
 */
(function () {
  'use strict';

  // The settings kept in the page's storage too, and under which name.
  const MIRRORS = {
    openrouter_api_key: 'synthorg_openrouter_api_key',
    app_locale: 'synthorg_locale',
    theme_preferences: 'synthorg_theme_prefs',
    system_prompts_config: 'synthorg_system_prompts_config',
    role_master_model_id: 'synthorg_selected_master_id',
    role_microtask_model_id: 'synthorg_selected_microtask_id',
    role_realtime_multi_model_id: 'synthorg_selected_realtime_multi_id',
    operational_tool_delegates: 'synthorg_operational_tool_delegates',
    model_custom_parameters: 'synthorg_model_custom_parameters',
    model_custom_configs: 'synthorg_model_custom_configs',
    startup_sound: 'synthorg_startup_sound',
    notification_sound: 'synthorg_notification_sound',
    env_sound: 'synthorg_env_sound',
    prompt_caching_enabled: 'synthorg_prompt_caching_enabled',
    openrouter_zdr_enabled: 'synthorg_openrouter_zdr_enabled',
    // Which sections are switched off: read by sections.js when the page is loaded.
    sections: 'synthorg_sections'
  };
  const ROLES = new Set(['role_master_model_id', 'role_microtask_model_id', 'role_realtime_multi_model_id', 'operational_tool_delegates', 'model_custom_parameters', 'model_custom_configs']);
  // The assistant's pages, and what reads each of them again.
  const PAGES = [
    [/^\/api\/agenda(\/|$)/, 'loadAgenda'],
    [/^\/api\/diary(\/|$)/, 'loadDiary'],
    [/^\/api\/(habits|reviews)(\/|$)/, 'loadWellbeing'],
    [/^\/api\/goals(\/|$)/, 'loadGoals'],
    [/^\/api\/handed(\/|$)/, 'loadFiles'],
    [/^\/api\/memories(\/|$)/, 'loadNotes']
  ];
  const CONVERSATION = /^\/api\/conversations\/([^/]+)(?:\/([^/]+))?/;

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const sync = {
    epoch: '',
    rev: 0,
    running: false,
    pending: null,

    remote() { return Boolean(window.remote?.active); },

    /** Who this side is, as the service notes it: what this side wrote is already shown. */
    self() { return this.remote() ? `phone:${window.remote.deviceId || ''}` : 'desktop'; },

    /** Here: waits on the local service. On the phone the changes come from the bridge. */
    start() {
      if (this.running) return;
      this.running = true;
      if (!this.remote()) this.loop();
    },

    async loop() {
      for (;;) {
        try {
          this.take(await window.chatStorage.changes(this.epoch, this.rev, 25000));
        } catch {
          await sleep(5000);
        }
      }
    },

    /** Changes from the service: `{ epoch, rev, reset, changes }`. */
    take(got) {
      if (!got || typeof got !== 'object') return;
      const known = Boolean(this.epoch);
      // Numbers of another run of the service, or too old: everything is read again.
      if (got.reset) {
        this.epoch = got.epoch;
        this.rev = got.rev;
        if (known) this.reloadAll();
        return;
      }
      if (got.epoch !== this.epoch && known) { this.epoch = got.epoch; this.rev = got.rev; this.reloadAll(); return; }
      this.epoch = got.epoch;
      const fresh = (got.changes || []).filter(change => change.rev > this.rev);
      this.rev = Math.max(this.rev, Number(got.rev) || 0);
      const foreign = fresh.filter(change => change.origin !== this.self());
      if (foreign.length) this.apply(foreign).catch(error => console.warn('[sync]', error));
    },

    async apply(changes) {
      const settings = new Map();
      const pages = new Set();
      const conversations = new Map();
      let projects = false;
      let assistant = false;
      for (const change of changes) {
        const path = String(change.path || '');
        if (path.startsWith('/api/settings/')) {
          const key = decodeURIComponent(path.slice('/api/settings/'.length));
          settings.set(key, change.method === 'DELETE' ? null : (change.data?.value ?? null));
          continue;
        }
        for (const [pattern, load] of PAGES) if (pattern.test(path)) pages.add(load);
        if (/^\/api\/realtime(\/|$)/.test(path)) assistant = true;
        if (/^\/api\/projects(\/|$)/.test(path)) projects = true;
        const match = CONVERSATION.exec(path) || (path === '/api/conversations' ? [path, change.data?.id || '', ''] : null);
        if (match) {
          const id = match[1];
          const entry = conversations.get(id) || { id, messages: [], whole: false, gone: false };
          if (match[2] === 'messages' && change.method === 'POST' && change.data?.id) entry.messages.push(change.data);
          else if (!match[2] && change.method === 'DELETE') entry.gone = true;
          else entry.whole = true;
          conversations.set(id, entry);
        }
      }
      if (settings.size) await this.settings(settings);
      if (pages.size || assistant || [...settings.keys()].some(key => key.startsWith('realtime_'))) await this.assistant(pages, assistant, settings);
      if (conversations.size) await this.conversations([...conversations.values()]);
      document.dispatchEvent(new CustomEvent('synthorg-changed', { detail: { changes, settings: [...settings.keys()], projects } }));
    },

    /**
     * On the phone: the copies these readings were answered from have been
     * replaced by what the computer has now. Each is shown again, from the
     * new copy.
     */
    async refreshed(paths) {
      const list = (Array.isArray(paths) ? paths : []).map(String);
      if (!list.length) return;
      const rest = [];
      let settings = false;
      for (const path of list) {
        if (path === '/api/settings' || path.startsWith('/api/settings/')) settings = true;
        else rest.push({ path: path.split('?')[0], method: 'PUT' });
      }
      if (settings) {
        try {
          const all = await window.chatStorage.getSettings();
          const changed = new Map();
          for (const key of Object.keys(MIRRORS)) changed.set(key, all[key] ?? null);
          for (const [key, value] of Object.entries(all)) if (key.startsWith('realtime_')) changed.set(key, value);
          await this.settings(changed);
          await this.assistant(new Set(), false, changed);
        } catch (error) { console.warn('[sync]', error); }
      }
      if (rest.length) await this.apply(rest).catch(error => console.warn('[sync]', error));
      else document.dispatchEvent(new CustomEvent('synthorg-changed', { detail: { changes: [], settings: settings ? Object.keys(MIRRORS) : [], projects: false } }));
    },

    /** The settings changed on the other side: the page's copy first, then the modules that own them. */
    async settings(changed) {
      for (const [key, value] of changed) {
        const mirror = MIRRORS[key];
        if (!mirror) continue;
        try {
          if (value === null || value === undefined) localStorage.removeItem(mirror);
          else localStorage.setItem(mirror, value);
        } catch {}
      }
      const keys = [...changed.keys()];
      const jobs = [];
      if (changed.has('openrouter_api_key')) {
        const catalog = window.openRouterCatalog;
        if (catalog) catalog._inMemoryApiKey = changed.get('openrouter_api_key') || '';
      }
      if (keys.some(key => ROLES.has(key))) jobs.push(window.operationalRegistry?.syncWithStorage?.());
      if (changed.has('theme_preferences')) jobs.push(window.themeManager?.syncWithStorage?.().then(() => window.themeManager.apply?.()));
      if (changed.has('app_locale')) jobs.push(window.i18n?.syncWithStorage?.());
      if (changed.has('system_prompts_config')) jobs.push(window.promptManager?.syncWithStorage?.());
      await Promise.allSettled(jobs);
    },

    /** The assistant's pages: read again only once the section has been opened. */
    async assistant(pages, forgotten, settings) {
      const rt = window.realtime?._state;
      if (!rt?.loaded) return;
      if (forgotten) {
        rt.loaded = false;
        rt.conversationId = null;
        rt.tasksConversationId = null;
        if (rt.active) await rt.ensure();
        rt.renderSide?.();
        return;
      }
      const jobs = [...pages].map(load => rt[load]?.());
      if (settings.has('realtime_name')) rt.name = settings.get('realtime_name') || '';
      if (settings.has('realtime_voice')) rt.voice = settings.get('realtime_voice') || '';
      if (settings.has('realtime_calendar_view')) rt.calendarView = settings.get('realtime_calendar_view') === 'week' ? 'week' : 'month';
      if (settings.has('realtime_wellbeing_period')) {
        const period = Number(settings.get('realtime_wellbeing_period'));
        if ([7, 30, 90].includes(period)) rt.period = period;
        jobs.push(rt.loadWellbeing?.());
      }
      if (settings.has('realtime_features')) jobs.push(rt.loadFeatures?.());
      await Promise.allSettled(jobs);
      if (rt.ui) {
        rt.renderSide?.();
        rt.renderSettings?.();
        rt.renderControls?.();
      }
    },

    /** Chats: the list, and the one on screen as it is written. */
    async conversations(entries) {
      const chat = window.chatManager;
      const openId = chat?.conversation?.id;
      let reselect = false;
      for (const entry of entries) {
        if (entry.id !== openId) continue;
        if (entry.gone) { reselect = true; continue; }
        // The turn under way here writes this chat itself.
        if (chat.generation?.conversationId === openId || chat.backgroundRuns?.has(openId)) continue;
        if (entry.whole) { reselect = true; continue; }
        for (const message of entry.messages) {
          const { conversationId, ...shown } = message;
          // On the phone, an answer followed word by word (remote.js) is further on than the archive's.
          if (shown.status === 'streaming' && window.remote?.live?.has(shown.id)) continue;
          shown.isStreaming = shown.status === 'streaming';
          const at = chat.messages.findIndex(m => m.id === shown.id);
          if (at >= 0) chat.messages[at] = { ...chat.messages[at], ...shown };
          else chat.messages.push(shown);
        }
        this.showSoon();
        // Written to the end: read as the archive keeps it.
        if (entry.messages.some(m => m.status !== 'streaming')) reselect = true;
      }
      if (reselect && chat) {
        const gone = entries.some(entry => entry.id === openId && entry.gone);
        try {
          if (gone) {
            const chats = await window.chatStorage.list();
            const next = chats[0]?.id || (await window.chatStorage.create()).id;
            await chat.selectConversation(next);
          } else if (openId && !chat.isGenerating) {
            await chat.selectConversation(openId);
          }
        } catch {}
      }
      clearTimeout(this.listTimer);
      this.listTimer = setTimeout(() => window.chatWorkspace?.refresh?.().catch?.(() => {}), 250);
    },

    /** A message written a word at a time is drawn once a frame at most. */
    showSoon() {
      if (this.pending) return;
      this.pending = requestAnimationFrame(() => {
        this.pending = null;
        const chat = window.chatManager;
        const container = document.getElementById('chat-messages-container');
        const atBottom = container ? container.scrollHeight - container.scrollTop - container.clientHeight < 80 : false;
        chat?.render?.();
        // A message being written elsewhere is followed as one written here is.
        const written = chat?.messages?.findLast?.(m => m.isStreaming);
        if (written && chat.followStream) chat.followStream(written, atBottom);
        else if (atBottom) chat?.scrollToBottom?.();
      });
    },

    /** Everything read again: the numbers of the service could not be followed. */
    async reloadAll() {
      await Promise.allSettled([
        window.openRouterCatalog?.syncApiKey?.(),
        window.modelProviders?.load?.(),
        window.operationalRegistry?.syncWithStorage?.(),
        window.themeManager?.syncWithStorage?.().then(() => window.themeManager.apply?.()),
        window.i18n?.syncWithStorage?.(),
        window.promptManager?.syncWithStorage?.()
      ]);
      const rt = window.realtime?._state;
      if (rt?.loaded) {
        rt.loaded = false;
        if (rt.active) { try { await rt.ensure(); } catch {} }
        rt.renderSide?.();
      }
      const chat = window.chatManager;
      if (chat?.conversation?.id && !chat.isGenerating) { try { await chat.selectConversation(chat.conversation.id); } catch {} }
      window.chatWorkspace?.refresh?.().catch?.(() => {});
      document.dispatchEvent(new CustomEvent('synthorg-changed', { detail: { changes: [], settings: Object.keys(MIRRORS), projects: true, all: true } }));
    }
  };

  window.archiveSync = sync;
})();
