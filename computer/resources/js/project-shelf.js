/**
 * The artifacts of a project: the second tab of its column, beside the files.
 *
 * The artifacts are what is worked on with the editors of this computer and
 * what they make: the documents of the photo editor, the chapters of a text,
 * the pictures, what was exported, what the project's chats made. In a
 * folder project they are among its files; for a pod's project they are kept
 * at this computer, apart from the pod (server/projects.js, `artifactsDir`).
 *
 * The tab is the one the column of the chats has for the artifacts of every
 * chat, made of the same parts: a choice of which to show — here raw, what is
 * still worked on and opens in its editor with a press, or finished, what is
 * looked at and taken where it is wanted — the order, the search of the
 * column over them, and the rows. A row of the project is dragged: onto the
 * picture in the photo editor, where it becomes a layer, or onto a folder of a
 * pod's files, where a copy of it goes into the pod (the column turns to the
 * files while the drag lasts, and back when it ends).
 */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const t = (key, values) => window.i18n?.t(key, values) || key;
  const storage = () => window.chatStorage;
  const STAGE_KEY = 'synthorg_project_artifacts_stage';
  const ICONS = { document: 'fa-solid fa-layer-group', text: 'fa-solid fa-align-left', image: 'fa-solid fa-image', export: 'fa-solid fa-file-export', file: 'fa-solid fa-file', video: 'fa-solid fa-film', audio: 'fa-solid fa-music', archive: 'fa-solid fa-file-zipper' };
  const DRAG_TYPE = 'application/x-synthorg-artifact';
  const sizeText = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const ORDERS = {
    date: (a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0),
    name: (a, b) => a.name.localeCompare(b.name),
    kind: (a, b) => String(a.kind).localeCompare(String(b.kind)) || a.name.localeCompare(b.name),
    size: (a, b) => b.bytes - a.bytes
  };

  const state = {
    id: null, on: false, apart: false, files: [], chats: [], stage: 'raw', sort: 'date', query: '', edit: null,
    onOpen: null, onError: null, onTab: null, seq: 0, timer: 0, back: false
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function icon(className) {
    const node = el('i', className);
    node.setAttribute('aria-hidden', 'true');
    return node;
  }
  const fail = error => state.onError?.(error?.message || String(error));

  /** The artifacts of the project. */
  async function read() {
    const id = state.id;
    if (!id) return;
    const seq = ++state.seq;
    try {
      // What the project's chats made is among them: the service brings it in as it lists (project-files.js).
      const listed = await storage().projectArtifacts(id);
      if (state.id !== id || seq !== state.seq) return;
      state.apart = Boolean(listed.apart);
      state.files = listed.files || [];
    } catch (error) { if (state.id === id) fail(error); }
    // Not while a name is being written on a row: drawing again would take the field away from under it (and a
    // field taken away loses the focus, which reads as the name given up).
    if (!state.edit) render();
  }

  function nameField(value, done) {
    const field = el('input', 'proj-tree-name-field');
    field.value = value;
    field.spellcheck = false;
    field.autocomplete = 'off';
    let ended = false;
    const end = keep => { if (ended) return; ended = true; done(keep ? field.value.trim() : null); };
    field.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); end(true); }
      else if (event.key === 'Escape') { event.preventDefault(); end(false); }
    });
    field.addEventListener('blur', () => end(true));
    field.addEventListener('click', event => event.stopPropagation());
    setTimeout(() => { field.focus(); const dot = value.lastIndexOf('.'); field.setSelectionRange(0, dot > 0 ? dot : value.length); });
    return field;
  }

  /** Another name for an artifact, or a copy of it under another name: the name was written on its row. */
  async function finishEdit(name) {
    const edit = state.edit;
    if (!edit) return;
    state.edit = null;
    const dir = edit.path.includes('/') ? edit.path.slice(0, edit.path.lastIndexOf('/') + 1) : '';
    if (!name || /[\\/]/.test(name) || name === edit.path.slice(dir.length)) {
      if (name && /[\\/]/.test(name)) fail(new Error(t('proj.nameInvalid')));
      render();
      return;
    }
    try {
      const done = await storage().changeProjectArtifact(state.id, { action: edit.copy ? 'copy' : 'rename', path: edit.path, to: dir + name });
      await read();
      if (done?.to) state.onOpen?.(done.to, state.files.find(file => file.path === done.to) || null);
    } catch (error) { fail(error); render(); }
  }

  function row(file, chat = null) {
    const item = el('button', 'artifact-library-row');
    item.type = 'button';
    item.dataset.path = file.path;
    if (chat) item.dataset.chat = chat.id;
    item.title = file.path;
    // What a chat made is opened where the chat keeps it; what is the project's is taken where it is wanted.
    item.draggable = !chat && !state.edit;
    item.append(icon(ICONS[chat ? file.category : file.kind] || ICONS.file));
    if (!chat && state.edit?.path === file.path) item.append(nameField(file.path.slice(file.path.lastIndexOf('/') + 1), name => void finishEdit(name)));
    else item.append(el('span', 'artifact-library-name', chat ? file.path : file.name));
    item.append(el('span', 'artifact-library-size', sizeText(chat ? file.size : file.bytes)));
    return item;
  }

  function group(title, iconClass, rows) {
    const section = el('section', 'artifact-library-group');
    const head = el('h3');
    head.append(icon(iconClass), document.createTextNode(` ${title}`));
    section.append(head, ...rows);
    return section;
  }

  function render() {
    const side = $('proj-side');
    if (!side) return;
    side.classList.toggle('is-artifacts', state.on);
    for (const [id, on] of [['proj-tab-files', !state.on], ['proj-tab-artifacts', state.on]]) {
      $(id).classList.toggle('active', on);
      $(id).setAttribute('aria-selected', String(on));
    }
    $('proj-artifacts-tools').hidden = !state.on;
    const host = $('proj-artifacts');
    host.hidden = !state.on;
    $('proj-search').placeholder = t(state.on ? 'artifacts.searchPlaceholder' : 'proj.search');
    for (const button of $('proj-artifacts-tools').querySelectorAll('[data-stage]')) {
      const on = button.dataset.stage === state.stage;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    }
    if (!state.on) { host.replaceChildren(); return; }
    const top = host.scrollTop;
    const holds = name => !state.query || String(name).toLowerCase().includes(state.query);
    const order = ORDERS[state.sort] || ORDERS.date;
    const own = state.files.filter(file => (file.stage === 'raw' ? 'raw' : 'finished') === state.stage && holds(file.name)).sort(order);
    const groups = [];
    if (own.length) groups.push(group(t('shelf.ofProject'), 'fa-solid fa-folder', own.map(file => row(file))));
    if (groups.length) host.replaceChildren(...groups);
    else host.replaceChildren(el('p', 'conversation-empty', t(state.query ? 'shell.libraryEmpty' : state.stage === 'raw' ? 'shelf.emptyRaw' : 'shelf.emptyFinished')));
    host.scrollTop = top;
  }

  /** The column's tab: the files, or the artifacts. */
  function showTab(on) {
    if (state.on === on) return;
    state.on = on;
    const field = $('proj-search');
    if (field.value) { field.value = ''; state.query = ''; window.projectTree.search(''); }
    render();
    state.onTab?.(on);
    if (on) void read();
  }

  function bind() {
    try { state.stage = localStorage.getItem(STAGE_KEY) === 'finished' ? 'finished' : 'raw'; } catch {}
    $('proj-tab-files').addEventListener('click', () => showTab(false));
    $('proj-tab-artifacts').addEventListener('click', () => showTab(true));
    $('proj-artifacts-tools').addEventListener('click', event => {
      const chosen = event.target.closest('[data-stage]');
      if (!chosen) return;
      state.stage = chosen.dataset.stage;
      try { localStorage.setItem(STAGE_KEY, state.stage); } catch {}
      render();
    });
    $('proj-artifacts-sort').addEventListener('change', event => { state.sort = event.target.value; render(); });
    $('proj-search').addEventListener('input', event => { if (state.on) { state.query = event.target.value.trim().toLowerCase(); render(); } });
    // A turn of a chat is over: what it made may be an artifact now.
    window.addEventListener('synthorg-turn-ended', () => window.projectShelf.refresh());
    const host = $('proj-artifacts');
    const found = event => {
      const item = event.target.closest('.artifact-library-row');
      if (!item) return null;
      if (item.dataset.chat) {
        const file = state.chats.find(chat => chat.id === item.dataset.chat)?.files.find(one => one.path === item.dataset.path);
        return file ? { chat: true, file } : null;
      }
      const file = state.files.find(one => one.path === item.dataset.path);
      return file ? { chat: false, file } : null;
    };
    host.addEventListener('click', event => {
      const hit = found(event);
      if (!hit || state.edit) return;
      // What a chat made is shown as the chat shows it; what is the project's opens in its editor.
      if (hit.chat) window.chatManager?.openArtifact(window.synthorgResolveUrl(hit.file.url), hit.file.category, hit.file.name);
      else state.onOpen?.(hit.file.path, hit.file);
    });
    host.addEventListener('keydown', event => {
      const hit = found(event);
      if (hit && !hit.chat && !state.edit && event.key === 'F2' && state.apart) { event.preventDefault(); state.edit = { path: hit.file.path, copy: false }; render(); }
    });
    // Taken from the list: the photo editor and the column of the files are told, each takes it where it can. For a
    // pod's project the column turns to the files, so that there is a folder to let it go on, and back afterwards.
    host.addEventListener('dragstart', event => {
      const hit = found(event);
      if (!hit || hit.chat || state.edit) { event.preventDefault(); return; }
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(DRAG_TYPE, hit.file.path);
      event.dataTransfer.setData('text/plain', hit.file.path);
      document.documentElement.classList.add('is-dragging-artifact');
      window.dispatchEvent(new CustomEvent('synthorg-artifact-drag', { detail: { path: hit.file.path, file: hit.file, apart: state.apart } }));
      if (state.apart) {
        state.back = true;
        // After this event: a list hidden while its row is being taken would end the drag before it began.
        setTimeout(() => { if (state.back) $('proj-side').classList.add('is-artifact-drop'); });
      }
    });
    const dragOver = () => {
      document.documentElement.classList.remove('is-dragging-artifact');
      $('proj-side').classList.remove('is-artifact-drop');
      state.back = false;
      window.dispatchEvent(new CustomEvent('synthorg-artifact-drag', { detail: null }));
    };
    host.addEventListener('dragend', dragOver);
    // The row that was taken is hidden with its list while the files are shown: the end of the drag is heard here too.
    window.addEventListener('drop', () => { if (state.back) setTimeout(dragOver); }, true);
    window.addEventListener('dragend', () => { if (state.back) dragOver(); }, true);
  }

  window.projectShelf = {
    /** The artifacts of a project: `onOpen(path, file)` for one pressed, `onError(text)`, `onTab(on)` when the tab is entered or left. */
    open({ id, onOpen, onError, onTab = null }) {
      Object.assign(state, { id, onOpen, onError, onTab, files: [], chats: [], apart: false, edit: null, query: '' });
      state.on = false;
      render();
      void read();
    },
    close() {
      clearTimeout(state.timer);
      Object.assign(state, { id: null, files: [], chats: [], edit: null, on: false, query: '' });
      render();
    },
    /** Something was saved, made or exported: read again, once for a burst of them. */
    refresh() {
      if (!state.id) return;
      clearTimeout(state.timer);
      state.timer = setTimeout(() => void read(), 350);
    },
    /** Back to the files (the history was asked for, a name is being written in the tree). */
    showFiles() { showTab(false); },
    /** Whether the tab in view is the artifacts'. */
    get on() { return state.on; },
    /** Whether the artifacts are kept apart from the project's files (a pod's project), and whether a path is one of them. */
    get apart() { return state.apart; },
    has(path) { return state.files.some(file => file.path === path); },
    /** Another name for an artifact, or a copy of it: asked from the bar over the editor, the name written on its row. */
    rename(path) { this.edit(path, false); },
    copyAs(path) { this.edit(path, true); },
    edit(path, copy) {
      const file = state.files.find(entry => entry.path === path);
      if (!state.id || !file) return;
      state.stage = file.stage === 'raw' ? 'raw' : 'finished';
      state.query = '';
      $('proj-search').value = '';
      state.edit = { path, copy };
      if (state.on) render(); else showTab(true);
      $('proj-artifacts').querySelector(`.artifact-library-row[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' });
    },
    DRAG_TYPE
  };

  document.addEventListener('DOMContentLoaded', bind);
})();
