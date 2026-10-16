/**
 * Which local models stay in memory.
 *
 * Two sets are wanted there: the ones the roles have by default (Settings),
 * and the ones of the last chat that chose local models of its own. A local
 * model given to a role, or chosen for a chat, is loaded at once. When a
 * default changes, or another chat with local models of its own is used,
 * what was wanted before and no longer is, is freed — a model that only
 * changed role, or that both the chat and a default have, stays where it is.
 * A chat that uses only models asked of a provider changes nothing: it frees
 * neither another chat's models nor the defaults.
 *
 * Only what a default or a chat wanted is ever freed here: a model loaded by
 * hand (the header's manager, the models' page) is the user's to free. A
 * model that is answering is not freed: it is, the next time this is settled.
 */
(() => {
  'use strict';
  if (window.SYNTHORG_REMOTE) return;

  const KEPT = 'synthorg_local_keeper';
  const LOAD_TIMEOUT_MS = 60 * 60 * 1000;
  const isLocal = (id) => typeof id === 'string' && id.startsWith('local/');
  const unique = (ids) => [...new Set(ids.filter(isLocal))];
  const api = (route, method = 'GET', data, timeoutMs) => window.chatStorage.request('/local-models' + route, method, data, timeoutMs);

  // What survives a reload of the page: the service, and the models in it, do.
  const state = { chatOf: null, chat: [], before: [], defaults: null };
  try { Object.assign(state, JSON.parse(sessionStorage.getItem(KEPT) || '{}')); } catch {}
  const keep = () => { try { sessionStorage.setItem(KEPT, JSON.stringify(state)); } catch {} };

  function defaults() {
    const registry = window.operationalRegistry;
    if (!registry) return [];
    return unique([registry.getSelectedMasterId?.(), registry.getSelectedMicrotaskId?.(), registry.getSelectedRealtimeMultiId?.(), ...Object.values(registry.getDelegatesMap?.() || {})]);
  }

  /** The local models a chat chose for itself. */
  function ownOf(conversation) {
    const own = window.OperationalRegistry?.parseOverrides(conversation?.model_overrides_json);
    if (!own) return [];
    return unique([own.roles?.master, own.roles?.microtask, ...Object.values(own.tools || {})]);
  }

  let queue = Promise.resolve();
  /** One at a time: what is no longer wanted is freed first, then `load` (the models just chosen) is loaded. */
  function settle(load = []) {
    queue = queue.then(async () => {
      const wanted = new Set([...defaults(), ...state.chat]);
      let there;
      try { const now = await api('/loaded'); there = new Set([...now.loaded.map(m => m.id), ...now.loading.map(m => m.id)]); } catch { return; }
      const still = [];
      for (const id of state.before) {
        if (wanted.has(id)) continue;
        if (!there.has(id)) continue;
        try {
          const done = await api('/stop', 'POST', { id, idle: true });
          if (done.stopped) window.modelGateway?.forgetEngine?.(id);
          else still.push(id);   // answering now: freed the next time
        } catch { still.push(id); }
      }
      state.before = [...new Set([...wanted, ...still])];
      keep();
      for (const id of load) {
        if (!wanted.has(id) || there.has(id)) continue;
        try { await api('/start', 'POST', { id }, LOAD_TIMEOUT_MS); }
        catch (error) { console.warn('[local-keeper] non caricato', id, error.message); window.chatWorkspace?.error?.(error); }
      }
      window.loadedModels?.refresh?.();
      window.localModelsView?.changed?.();
    }).catch(error => console.warn('[local-keeper]', error));
    return queue;
  }

  /** A role was given a model in Settings: a local one just given is loaded, one no longer wanted is freed. */
  function defaultsChanged() {
    const now = defaults();
    const had = state.defaults || [];
    state.defaults = now;
    keep();
    const given = now.filter(id => !had.includes(id));
    if (given.length || had.some(id => !now.includes(id))) settle(given);
  }

  /** A chat's own choices were changed (chat-models.js): its local models are the chat's set from now. */
  function chatChanged(conversation) {
    if (!conversation) return;
    const own = ownOf(conversation);
    if (own.length) {
      const given = own.filter(id => !(state.chatOf === conversation.id && state.chat.includes(id)));
      state.chatOf = conversation.id;
      state.chat = own;
      keep();
      settle(given);
    } else if (state.chatOf === conversation.id) {
      state.chatOf = null;
      state.chat = [];
      keep();
      settle();
    }
  }

  const bare = new Map(); // conversation id → its own local models, for chats that are not the open one
  /**
   * A request is about to go to a local model for this chat (model-gateway.js). A chat with local models of its
   * own takes the place of the one before; a chat without changes nothing. What is no longer wanted is freed
   * before the request loads its model, so that the memory is there for it.
   */
  async function using(conversationId) {
    if (!conversationId) return;
    let own;
    const open = window.chatManager?.conversation;
    if (open && open.id === conversationId) own = ownOf(open);
    else {
      if (!bare.has(conversationId)) { try { bare.set(conversationId, ownOf(await window.chatStorage.getBare(conversationId))); } catch { return; } }
      own = bare.get(conversationId);
    }
    if (!own.length) return;
    if (state.chatOf === conversationId && own.length === state.chat.length && own.every(id => state.chat.includes(id))) return;
    state.chatOf = conversationId;
    state.chat = own;
    keep();
    await settle();
  }

  function start() {
    const registry = window.operationalRegistry;
    if (!registry) return;
    // The roles are given their models through these, wherever it is done from.
    for (const name of ['setSelectedMasterId', 'setSelectedMicrotaskId', 'setSelectedRealtimeMultiId', 'setToolDelegate']) {
      const original = registry[name];
      if (typeof original !== 'function') continue;
      registry[name] = function (...args) {
        const result = original.apply(this, args);
        if (this === registry) setTimeout(defaultsChanged, 0);
        return result;
      };
    }
    // What the roles have when the app starts is what "changed" is measured against: nothing is loaded for it.
    if (state.defaults === null) { state.defaults = defaults(); state.before = [...new Set([...state.before, ...state.defaults])]; keep(); }
    // A chat's choices changed from elsewhere (a phone): what is kept for the others is read again.
    document.addEventListener('synthorg-changed', () => bare.clear());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  window.localKeeper = { chatChanged, using, defaults, state: () => JSON.parse(JSON.stringify(state)) };
})();
