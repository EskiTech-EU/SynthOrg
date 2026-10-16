/**
 * SynthOrg - what stands around a chat.
 *
 * The column of the chats, as wide as the user drags it (between 15% and 35%
 * of the window) or closed; the chat's own settings, opened from one button;
 * the export of the chat; the artifacts of every chat; and what the "+" of
 * the writing bar brings into the open chat: artifacts of other chats, files
 * of the computer, the pod of another chat. In the header, the phone's button.
 *
 * The chats themselves are chat-workspace.js's, a conversation is chat.js's.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const t = (key, params) => window.i18n.t(key, params || {});
  const esc = value => window.escapeHtml(String(value ?? ''));
  const chat = () => window.chatManager;
  const storage = () => window.chatStorage;
  const perform = action => window.chatWorkspace.perform(action);

  // --- The column: its width and whether it is open

  const WIDTH_KEY = 'synthorg_chat_column';
  const CLOSED_KEY = 'synthorg_chat_column_closed';
  const MIN = 15, MAX = 35, START = 20;
  const layout = () => document.querySelector('.chat-workspace-layout');
  const stored = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const store = (key, value) => { try { localStorage.setItem(key, value); } catch {} };

  let width = Math.min(MAX, Math.max(MIN, parseFloat(stored(WIDTH_KEY)) || START));

  function applyWidth() {
    layout().style.setProperty('--chat-column', `${width}%`);
    const handle = $('conversation-resizer');
    handle.setAttribute('aria-valuemin', MIN);
    handle.setAttribute('aria-valuemax', MAX);
    handle.setAttribute('aria-valuenow', Math.round(width));
  }

  function setClosed(closed) {
    layout().classList.toggle('is-column-closed', closed);
    const button = $('btn-sidebar-collapse');
    button.setAttribute('aria-expanded', String(!closed));
    button.querySelector('i').className = closed ? 'fa-solid fa-chevron-right' : 'fa-solid fa-chevron-left';
    store(CLOSED_KEY, closed ? '1' : '0');
  }

  function bindColumn() {
    const handle = $('conversation-resizer');
    applyWidth();
    setClosed(stored(CLOSED_KEY) === '1');
    $('btn-sidebar-collapse').addEventListener('click', () => setClosed(!layout().classList.contains('is-column-closed')));
    handle.tabIndex = 0;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('is-dragging');
      const box = layout().getBoundingClientRect();
      const move = (e) => {
        width = Math.min(MAX, Math.max(MIN, (e.clientX - box.left) / box.width * 100));
        applyWidth();
      };
      const end = () => {
        handle.classList.remove('is-dragging');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        store(WIDTH_KEY, width.toFixed(1));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
    handle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      width = Math.min(MAX, Math.max(MIN, width + (event.key === 'ArrowRight' ? 1 : -1)));
      applyWidth();
      store(WIDTH_KEY, width.toFixed(1));
    });
  }

  // --- The chat's settings: one button, the panels the chat already had

  function chatSettings(open) {
    const panel = $('chat-settings-panel');
    panel.hidden = !open;
    $('btn-chat-settings').setAttribute('aria-expanded', String(open));
    if (!open) panel.querySelectorAll('.chat-tool-info-popover').forEach(popover => { popover.style.display = 'none'; });
  }

  function bindChatSettings() {
    const button = $('btn-chat-settings');
    const panel = $('chat-settings-panel');
    button.addEventListener('click', () => chatSettings(panel.hidden));
    document.addEventListener('click', (event) => {
      if (panel.hidden || panel.contains(event.target) || button.contains(event.target)) return;
      // A dialog or a menu opened from the panel is still the panel's business.
      if (event.target.closest('dialog, .artifact-float-menu') || !document.contains(event.target)) return;
      chatSettings(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.hidden && !document.querySelector('dialog[open]')) chatSettings(false);
    });
  }

  // --- Export: the open chat as a text file

  function exportChat() {
    const conversation = chat().conversation;
    if (!conversation) throw new Error(t('shell.noChat'));
    const spoken = (chat().messages || []).filter(message => message.kind !== 'execution' && (message.role === 'user' || message.role === 'assistant'));
    const turns = spoken.map(message => {
      const text = String(message.content || '')
        .replace(/<(think|thought|reasoning|reflection)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .trim();
      return text ? `## ${t(message.role === 'user' ? 'shell.exportUser' : 'shell.exportAssistant')}\n\n${text}` : '';
    }).filter(Boolean);
    if (!turns.length) throw new Error(t('shell.exportEmpty'));
    const title = conversation.kind === 'realtime_tasks' ? t('chat.realtimeTasks') : (conversation.title || 'Chat');
    const day = new Date().toISOString().slice(0, 10);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([`# ${title}\n\n${turns.join('\n\n')}\n`], { type: 'text/markdown;charset=utf-8' }));
    link.download = `${title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'chat'} ${day}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  }

  // --- What is brought into the open chat is named in the message being written

  function mention(files) {
    if (!files.length) return;
    const input = $('chat-input');
    const lines = files.map(file => chat().artifactMarkdown(file.name, file.url, file.category));
    input.value = [input.value.trim(), ...lines].filter(Boolean).join('\n');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    chat().updateArtifactsCount();
  }

  function openChatId() {
    const conversation = chat().conversation;
    if (!conversation) throw new Error(t('shell.noChat'));
    return conversation.id;
  }

  // --- Files of the computer, copied among the chat's files

  const PIECE = 6 * 1024 * 1024;
  const base64 = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  async function importFiles(files) {
    const id = openChatId();
    const button = $('chat-btn-add');
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    const added = [];
    try {
      for (const file of files) {
        // A large file goes in pieces: the first writes it, the others add to it.
        let saved = await storage().saveSandboxFile(id, file.name, await base64(file.slice(0, PIECE)));
        for (let at = PIECE; at < file.size; at += PIECE) saved = await storage().appendSandboxFile(id, saved.filename, await base64(file.slice(at, at + PIECE)));
        added.push({ name: saved.filename, url: saved.url, category: saved.category });
      }
    } finally {
      button.disabled = false;
      button.innerHTML = '<i class="fa-solid fa-plus"></i>';
      // The files that did arrive are there, whatever stopped the others.
      mention(added);
    }
  }

  // --- The artifacts of every chat: to look at, or to pick from for the open chat

  const ICONS = { image: 'fa-image', video: 'fa-film', audio: 'fa-music', document: 'fa-file-lines', archive: 'fa-file-zipper' };
  const library = { groups: [], picked: new Set(), request: 0 };

  const sizeText = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const keyOf = (chatId, path) => `${chatId}\n${path}`;

  /** The chats that have files, each with its files; `except` leaves one chat out. */
  async function chatsWithFiles(except = null) {
    const [open, archived, realtime] = await Promise.all([storage().list('', false), storage().list('', true), storage().realtime().catch(() => null)]);
    const chats = [...open, ...archived];
    // What MO' had made is in the chat of its tasks.
    if (realtime?.tasks) chats.push({ ...realtime.tasks, title: t('chat.realtimeTasks'), mo: true });
    const groups = await Promise.all(chats.filter(one => one.id !== except).map(async one => {
      const listed = await storage().listSandboxFiles(one.id).catch(() => ({ files: [] }));
      return { id: one.id, title: one.title, mo: Boolean(one.mo), files: listed.files || [] };
    }));
    return groups.filter(group => group.files.length);
  }

  /** The files by chat, those whose name holds `query`; with `picked`, each row is a box to tick. */
  function groupsHtml(groups, query, picked = null) {
    const html = groups.map(group => {
      const files = query ? group.files.filter(file => file.name.toLowerCase().includes(query)) : group.files;
      if (!files.length) return '';
      return `
        <section class="artifact-library-group">
          <h3><i class="fa-solid fa-comment" aria-hidden="true"></i> ${esc(group.title)}</h3>
          ${files.map(file => {
            const on = Boolean(picked?.has(keyOf(group.id, file.path)));
            return `
            <button type="button" class="artifact-library-row ${on ? 'is-picked' : ''}" data-chat="${esc(group.id)}" data-path="${esc(file.path)}" ${picked ? `aria-pressed="${on}"` : ''}>
              ${picked ? `<i class="${on ? 'fa-solid fa-square-check' : 'fa-regular fa-square'}" aria-hidden="true"></i>` : ''}
              <i class="fa-solid ${ICONS[file.category] || 'fa-file'}" aria-hidden="true"></i>
              <span class="artifact-library-name">${esc(file.path)}</span>
              <span class="artifact-library-size">${sizeText(file.size)}</span>
            </button>`;
          }).join('')}
        </section>`;
    }).join('');
    return html || `<p class="conversation-empty">${esc(t('shell.libraryEmpty'))}</p>`;
  }

  const fileOf = (groups, row) => {
    const group = groups.find(one => one.id === row.dataset.chat);
    const file = group?.files.find(one => one.path === row.dataset.path);
    return file ? { group, file } : null;
  };
  const loadingHtml = () => `<p class="artifacts-loading"><i class="fa-solid fa-spinner fa-spin"></i> ${esc(t('artifacts.loading'))}</p>`;

  // --- In the column: its second tab, beside the chats

  const side = { groups: [], on: false, request: 0, source: 'all', sort: 'date' };
  const ORDERS = {
    date: (a, b) => b.mtime - a.mtime,
    name: (a, b) => a.name.localeCompare(b.name),
    kind: (a, b) => String(a.category).localeCompare(String(b.category)) || a.name.localeCompare(b.name),
    size: (a, b) => b.size - a.size
  };

  /** The chats shown (all, or MO's alone), each with its files in the order chosen; by date, the chat with the latest file first. */
  function renderSide() {
    const order = ORDERS[side.sort] || ORDERS.date;
    const groups = side.groups.filter(group => side.source === 'all' || group.mo)
      .map(group => ({ ...group, files: [...group.files].sort(order) }));
    if (side.sort === 'date') groups.sort((a, b) => (b.files[0]?.mtime || 0) - (a.files[0]?.mtime || 0));
    $('side-artifacts').innerHTML = groupsHtml(groups, $('chat-search').value.trim().toLowerCase());
  }

  /** The column's tab: 'chats' or 'artifacts'. The search over it looks in what the tab shows. */
  async function showTab(name) {
    side.on = name === 'artifacts';
    $('conversation-sidebar').classList.toggle('is-artifacts', side.on);
    for (const [id, on] of [['side-tab-chats', !side.on], ['side-tab-artifacts', side.on]]) {
      $(id).classList.toggle('active', on);
      $(id).setAttribute('aria-selected', String(on));
    }
    $('side-artifacts').hidden = !side.on;
    $('side-artifacts-tools').hidden = !side.on;
    const field = $('chat-search');
    field.placeholder = t(side.on ? 'artifacts.searchPlaceholder' : 'chat.searchPlaceholder');
    if (field.value) { field.value = ''; field.dispatchEvent(new Event('input', { bubbles: true })); }
    if (!side.on) return;
    const request = ++side.request;
    $('side-artifacts').innerHTML = loadingHtml();
    const groups = await chatsWithFiles();
    if (request !== side.request) return;
    side.groups = groups;
    renderSide();
  }

  function onSideClick(event) {
    const row = event.target.closest('.artifact-library-row');
    const found = row && fileOf(side.groups, row);
    if (found) chat().openArtifact(window.synthorgResolveUrl(found.file.url), found.file.category, found.file.name);
  }

  // --- In a dialog: picking artifacts of other chats to bring into the open one

  async function openLibrary() {
    const current = openChatId();
    Object.assign(library, { groups: [], picked: new Set() });
    const request = ++library.request;
    $('artifact-library-title-text').textContent = t('shell.libraryPick');
    $('artifact-library-desc').textContent = t('shell.libraryPickDesc');
    $('artifact-library-foot').hidden = false;
    $('artifact-library-search').value = '';
    $('artifact-library-list').innerHTML = loadingHtml();
    $('artifact-library-dialog').showModal();
    const groups = await chatsWithFiles(current);
    if (request !== library.request) return;
    library.groups = groups;
    renderLibrary();
  }

  function renderLibrary() {
    $('artifact-library-list').innerHTML = groupsHtml(library.groups, $('artifact-library-search').value.trim().toLowerCase(), library.picked);
    $('artifact-library-count').textContent = t('shell.libraryCount', { count: library.picked.size });
    $('artifact-library-import').disabled = !library.picked.size;
  }

  function onLibraryClick(event) {
    const row = event.target.closest('.artifact-library-row');
    const found = row && fileOf(library.groups, row);
    if (!found) return;
    const key = keyOf(found.group.id, found.file.path);
    if (library.picked.has(key)) library.picked.delete(key); else library.picked.add(key);
    renderLibrary();
  }

  async function importPicked() {
    const id = openChatId();
    const button = $('artifact-library-import');
    button.disabled = true;
    const copied = [];
    try {
      for (const group of library.groups) {
        const paths = group.files.filter(file => library.picked.has(keyOf(group.id, file.path))).map(file => file.path);
        if (paths.length) copied.push(...(await storage().copySandboxFrom(id, group.id, paths)).copied);
      }
    } finally {
      $('artifact-library-dialog').close();
      mention(copied);
    }
  }

  // --- The pod of another chat, taken as this chat's

  async function pickPod(anchor) {
    const id = openChatId();
    const [open, archived] = await Promise.all([storage().list('', false), storage().list('', true)]);
    const others = [...open, ...archived].filter(one => one.id !== id);
    if (!others.length) throw new Error(t('shell.noOtherChats'));
    chat()._artifactMenu(anchor, t('shell.podTitle'), others.map(one => ({
      icon: 'fa-cube',
      label: one.title || 'Chat',
      onSelect: () => perform(async () => {
        // The chat's container is made again: not while a command of the model may be running in it.
        if (chat().generation?.conversationId === id) throw new Error(t('shell.busy'));
        const confirmed = await window.chatWorkspace.confirmAction({
          title: t('shell.podConfirmTitle'),
          message: t('shell.podConfirm', { title: one.title || 'Chat' }),
          confirmText: t('shell.podConfirmTitle')
        });
        if (!confirmed) return;
        const done = await storage().copySandboxFrom(id, one.id);
        await chat().updateHeaderCounts();
        $('chat-btn-add').title = t('shell.podDone', { count: done.files });
        chat()._flashArtifactBtn($('chat-btn-add'), 'fa-check');
      })
    })));
  }

  // --- The "+" of the writing bar

  function addMenu(open) {
    $('chat-add-menu').hidden = !open;
    $('chat-btn-add').setAttribute('aria-expanded', String(open));
    if (open) $('chat-btn-add').title = t('shell.add');
  }

  function bindAdd() {
    const button = $('chat-btn-add');
    const menu = $('chat-add-menu');
    const picker = $('chat-add-file');
    button.addEventListener('click', () => addMenu(menu.hidden));
    document.addEventListener('click', (event) => {
      if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) addMenu(false);
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !menu.hidden) addMenu(false); });
    menu.addEventListener('click', (event) => {
      const item = event.target.closest('[data-add]');
      if (!item) return;
      event.stopPropagation();
      addMenu(false);
      if (item.dataset.add === 'file') perform(() => { openChatId(); picker.click(); });
      else if (item.dataset.add === 'artifact') perform(() => openLibrary());
      else perform(() => pickPod(button));
    });
    picker.addEventListener('change', () => {
      const files = [...picker.files];
      picker.value = '';
      if (files.length) perform(() => importFiles(files));
    });
  }

  // --- The header: the phone's button says how the bridge is and opens its page

  function phoneButton() {
    const button = $('btn-phone-status');
    button.addEventListener('click', () => { window.switchView('settings'); window.switchSettingsSection('phone'); });
    // Two things, said apart. The service: on or off (the icon). The connection (the dot): none, a phone connected,
    // not steady, or an error the bridge states. Not steady is the bridge still coming up, a phone that has just
    // dropped, or one that keeps connecting and dropping.
    const STEADY_MS = 30000, FLAPS_MS = 120000;
    const seen = new Map();   // phone → { connected, changes: [times] }
    let lostAt = 0;
    const follow = () => {
      const status = window.phoneBridge?.status;
      const phase = status?.phase || 'off';
      const now = Date.now();
      let connected = false, flapping = false;
      for (const device of (phase === 'ready' ? status.devices || [] : [])) {
        const kept = seen.get(device.id) || { connected: device.connected, changes: [] };
        if (kept.connected !== device.connected) { kept.changes.push(now); if (!device.connected) lostAt = now; }
        kept.connected = device.connected;
        kept.changes = kept.changes.filter(at => now - at < FLAPS_MS);
        seen.set(device.id, kept);
        if (device.connected) connected = true;
        if (kept.changes.length >= 3) flapping = true;
      }
      if (phase !== 'ready') { seen.clear(); lostAt = 0; }
      const coming = phase === 'router' || phase === 'tunnels';
      const link = phase === 'error' ? 'error'
        : coming || flapping || (!connected && lostAt && now - lostAt < STEADY_MS) ? 'unstable'
        : connected ? 'connected' : 'none';
      button.dataset.service = phase === 'off' ? 'off' : 'on';
      button.dataset.link = link;
      const said = status && !status.locked ? window.realtime?._state?.phonePhaseText?.(status) : '';
      const note = link === 'unstable' && !coming ? ` ${t('shell.phoneUnstable')}` : '';
      button.title = said ? `${t('settings.tabPhone')}: ${said}${note}` : t('settings.tabPhone');
    };
    follow();
    setInterval(follow, 2000);
  }

  function start() {
    // The phone has its own page around the chat (remote.js).
    if (!window.SYNTHORG_REMOTE) { bindColumn(); bindChatSettings(); phoneButton(); }
    bindAdd();
    $('btn-export-chat').addEventListener('click', () => perform(() => exportChat()));
    $('side-tab-chats').addEventListener('click', () => perform(() => showTab('chats')));
    $('side-tab-artifacts').addEventListener('click', () => perform(() => showTab('artifacts')));
    $('side-artifacts').addEventListener('click', onSideClick);
    $('side-artifacts-tools').addEventListener('click', (event) => {
      const chosen = event.target.closest('[data-source]');
      if (!chosen) return;
      side.source = chosen.dataset.source;
      $('side-artifacts-tools').querySelectorAll('[data-source]').forEach(button => {
        const on = button === chosen;
        button.classList.toggle('active', on);
        button.setAttribute('aria-pressed', String(on));
      });
      renderSide();
    });
    $('side-artifacts-sort').addEventListener('change', (event) => { side.sort = event.target.value; renderSide(); });
    $('chat-search').addEventListener('input', () => { if (side.on) renderSide(); });
    $('artifact-library-search').addEventListener('input', renderLibrary);
    $('artifact-library-list').addEventListener('click', onLibraryClick);
    $('artifact-library-import').addEventListener('click', () => perform(() => importPicked()));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.chatShell = { chatSettings };
})();
