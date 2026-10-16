/**
 * How the interface was left — the widths of the columns, which ones are
 * closed, the zoom, the chat that was open, the help already seen — is kept
 * in the archive, with everything else the app remembers (setting
 * `ui_state`, which stays on its device).
 *
 * The modules read and write these values where they always did, in the
 * page's own storage, because they need them at once, before the archive
 * answers: that storage is only a copy. Every write to one of these keys
 * is saved to the archive; at start the archive has the last word, and the
 * page is loaded again once when its copy was not the same (a browser
 * profile that was cleared, an archive brought from elsewhere).
 */
(() => {
  const SETTING = 'ui_state';
  const RELOADED = 'synthorg_ui_state_reloaded';
  const KEYS = new Set([
    'synthorg_chat_column', 'synthorg_chat_column_closed', 'synthorg_active_conversation',
    'synthorg_project_files_width', 'synthorg_project_chat_width', 'synthorg_project_files_closed', 'synthorg_project_chat_closed',
    'synthorg_project_artifacts_stage', 'synthorg_studio_zoom',
    'synthorg_help_seen', 'synthorg_help_hidden', 'synthorg_tour_voice'
  ]);
  // One value per chat: whether its next request is planned (plan.js).
  const PER_CHAT = 'synthorg_plan_on_';
  const owned = key => KEYS.has(key) || key.startsWith(PER_CHAT);

  const proto = Object.getPrototypeOf(localStorage);
  const rawSet = proto.setItem, rawRemove = proto.removeItem;

  function snapshot() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (owned(key)) out[key] = localStorage.getItem(key);
      }
    } catch {}
    return out;
  }
  const canon = state => JSON.stringify(Object.keys(state).sort().map(key => [key, String(state[key])]));

  let followed = false;   // the archive was read: from here on the page's copy is what is saved
  let timer = null;
  let saved = '';

  async function save() {
    timer = null;
    // The archive could not be read at start (it was locked): it is read now, before anything is written over it.
    if (!followed) { await follow(); if (!followed) return; }
    const state = snapshot();
    const next = canon(state);
    if (next === saved) return;
    try { await window.chatStorage.setSetting(SETTING, JSON.stringify(state)); saved = next; }
    catch (error) { console.warn('[ui-state] non salvato:', error.message); }
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(save, 300); };

  proto.setItem = function setItem(key, value) {
    rawSet.call(this, key, value);
    if (this === localStorage && owned(String(key))) later();
  };
  proto.removeItem = function removeItem(key) {
    rawRemove.call(this, key);
    if (this === localStorage && owned(String(key))) later();
  };

  /** The archive has the last word. */
  async function follow() {
    let stored = null;
    try { stored = (await window.chatStorage.getSetting(SETTING))?.value || null; } catch { return; }
    let kept = null;
    try { const parsed = JSON.parse(stored || 'null'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) kept = parsed; } catch {}
    const here = snapshot();
    followed = true;
    // Nothing in the archive yet: what the page has is what is kept.
    if (!kept) { if (Object.keys(here).length) later(); return; }
    saved = canon(kept);
    if (canon(here) === saved) { try { sessionStorage.removeItem(RELOADED); } catch {} return; }
    try {
      for (const key of Object.keys(here)) if (!(key in kept)) rawRemove.call(localStorage, key);
      for (const [key, value] of Object.entries(kept)) if (owned(key)) rawSet.call(localStorage, key, String(value));
    } catch { return; }
    let again = false;
    try { again = sessionStorage.getItem(RELOADED) === '1'; sessionStorage.setItem(RELOADED, '1'); } catch { again = true; }
    if (!again && !window.SYNTHORG_REMOTE && !window.chatManager?.isGenerating) location.reload();
  }

  // A chat deleted: what was kept under its name goes with it.
  const storage = window.chatStorage;
  if (storage && typeof storage.remove === 'function') {
    const remove = storage.remove.bind(storage);
    storage.remove = async id => {
      const result = await remove(id);
      try { localStorage.removeItem(PER_CHAT + id); } catch {}
      return result;
    };
  }

  window.addEventListener('pagehide', () => { if (timer) { clearTimeout(timer); void save(); } });
  document.addEventListener('DOMContentLoaded', () => void follow());
  window.uiState = { follow, keys: () => [...KEYS], snapshot };
})();
