/**
 * SynthOrg - the files of the open project, in the page's own column.
 *
 * One column for every environment: the folders of the project, opened and
 * closed in place, and over them a search by name. A file pressed is handed
 * to the frame of the project (code-workspace.js), which decides what opens
 * it. With the right button: a new file, a new folder, a new name, a
 * removal — done by the service, in a folder of this computer as in a pod,
 * and recorded as a step of the user's. A file is moved by dragging it onto
 * a folder.
 *
 * The column asks again what its open folders hold while it is in view, so
 * that what an editor, a terminal or a model made shows up by itself.
 */
(function () {
  'use strict';

  const t = (key, params) => window.i18n.t(key, params || {});
  const storage = () => window.chatStorage;
  // How often the open folders are read again: a folder of this computer, a pod (asked through its engine).
  const LOOK_MS = { local: 3000, podman: 6000 };
  const SEARCH_QUIET_MS = 180;

  const ICONS = [
    [/\.(png|jpe?g|webp|gif|bmp|tiff?|avif|ico|svg|psd|psb|pcraft)$/i, 'fa-regular fa-image'],
    [/\.(md|txt|rst|tex|pdf|docx?)$/i, 'fa-regular fa-file-lines'],
    [/\.(json|ya?ml|toml|ini|env|lock)$/i, 'fa-solid fa-sliders'],
    [/\.(zip|tar|gz|7z|rar)$/i, 'fa-regular fa-file-zipper'],
    [/\.(mp4|mov|webm|mkv)$/i, 'fa-regular fa-file-video'],
    [/\.(mp3|wav|ogg|flac)$/i, 'fa-regular fa-file-audio'],
    [/\.(js|mjs|cjs|ts|tsx|jsx|py|rs|go|c|h|cpp|java|rb|php|sh|ps1|html?|css|scss|sql)$/i, 'fa-regular fa-file-code']
  ];
  const iconOf = name => (ICONS.find(([test]) => test.test(name)) || [null, 'fa-regular fa-file'])[1];
  const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const nameOf = path => path.slice(path.lastIndexOf('/') + 1);
  const join = (dir, name) => dir ? `${dir}/${name}` : name;

  const state = {
    host: null, id: null, kind: 'local', onOpen: null, onChanged: null, onError: null,
    // What each folder holds, by path ('' is the project); the folders shown open; the file in the middle.
    dirs: new Map(), open: new Set(['']), selected: null,
    // A search by name: its words, what it found, and which request the answer belongs to.
    query: '', found: null, searchSeq: 0, searchTimer: null,
    // A name being written in place: a new file or folder in `dir`, or a new name for `path`.
    edit: null,
    timer: null, reading: false, menu: null, drag: null
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

  // --- Reading

  /** The folders shown open are read again, in one request; a folder that is no more is closed. */
  async function read() {
    if (!state.id || state.reading) return;
    state.reading = true;
    const id = state.id;
    try {
      const asked = [...state.open];
      const { dirs } = await storage().projectFiles(id, asked);
      if (state.id !== id) return;
      let changed = false;
      for (const dir of asked) {
        const now = dirs[dir];
        if (!now) {
          if (dir !== '') { state.open.delete(dir); state.dirs.delete(dir); changed = true; }
          continue;
        }
        const before = state.dirs.get(dir);
        if (!before || before.length !== now.length || before.some((entry, index) => entry.name !== now[index].name || entry.dir !== now[index].dir)) {
          state.dirs.set(dir, now);
          changed = true;
        }
      }
      state.onError?.('');
      if (changed && !state.edit) render();
    } catch (error) { if (state.id === id) fail(error); }
    finally { state.reading = false; }
  }

  function follow() {
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      // Not while the column is out of view, a name is being written or a menu is open.
      if (!state.host?.offsetParent || document.hidden || state.edit || state.menu || state.found) return;
      void read();
    }, LOOK_MS[state.kind] || LOOK_MS.local);
  }

  // --- Drawing

  function nameField(value, done) {
    const field = el('input', 'proj-tree-name-field');
    field.value = value;
    field.spellcheck = false;
    field.autocomplete = 'off';
    let ended = false;
    const end = (keep) => {
      if (ended) return;
      ended = true;
      done(keep ? field.value.trim() : null);
    };
    field.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); end(true); }
      else if (event.key === 'Escape') { event.preventDefault(); end(false); }
    });
    field.addEventListener('blur', () => end(true));
    field.addEventListener('click', event => event.stopPropagation());
    // The part before the extension is what is usually rewritten.
    setTimeout(() => { field.focus(); const dot = value.lastIndexOf('.'); field.setSelectionRange(0, dot > 0 ? dot : value.length); });
    return field;
  }

  function row(path, entry, depth) {
    const item = el('div', 'proj-tree-row');
    item.setAttribute('role', 'treeitem');
    item.dataset.path = path;
    item.dataset.dir = entry.dir ? '1' : '';
    item.style.setProperty('--depth', depth);
    item.title = path;
    if (entry.dir) item.setAttribute('aria-expanded', String(state.open.has(path)));
    if (!entry.dir && path === state.selected) item.classList.add('is-selected');
    item.draggable = !state.edit;
    item.append(icon(entry.dir ? `fa-solid fa-chevron-${state.open.has(path) ? 'down' : 'right'} proj-tree-twist` : `${iconOf(entry.name)} proj-tree-kind`));
    if (state.edit?.path === path) item.append(nameField(entry.name, name => void finishEdit(name)));
    else item.append(el('span', 'proj-tree-name', entry.name));
    return item;
  }

  function draft(depth) {
    const item = el('div', 'proj-tree-row is-draft');
    item.style.setProperty('--depth', depth);
    item.append(icon(state.edit.folder ? 'fa-solid fa-chevron-right proj-tree-twist' : 'fa-regular fa-file proj-tree-kind'), nameField(state.edit.copy ? nameOf(state.edit.copy) : '', name => void finishEdit(name)));
    return item;
  }

  function level(dir, depth, out) {
    if (state.edit && !state.edit.path && state.edit.dir === dir) out.push(draft(depth));
    for (const entry of state.dirs.get(dir) || []) {
      const path = join(dir, entry.name);
      out.push(row(path, entry, depth));
      if (entry.dir && state.open.has(path)) level(path, depth + 1, out);
    }
  }

  function render() {
    const host = state.host;
    if (!host) return;
    const top = host.scrollTop;
    const rows = [];
    if (state.found) {
      for (const file of state.found.files) {
        const item = el('div', 'proj-tree-row is-found');
        item.setAttribute('role', 'treeitem');
        item.dataset.path = file;
        item.title = file;
        if (file === state.selected) item.classList.add('is-selected');
        item.append(icon(`${iconOf(file)} proj-tree-kind`), el('span', 'proj-tree-name', nameOf(file)), el('span', 'proj-tree-where', parentOf(file)));
        rows.push(item);
      }
      if (!rows.length) rows.push(el('p', 'conversation-empty', t(state.found.loading ? 'artifacts.loading' : 'proj.searchNone')));
      else if (state.found.truncated) rows.push(el('p', 'conversation-empty', t('proj.searchMore')));
    } else {
      level('', 0, rows);
      if (!rows.length && state.dirs.has('')) rows.push(el('p', 'conversation-empty', t('proj.empty')));
    }
    host.replaceChildren(...rows);
    host.scrollTop = top;
  }

  // --- What is done to the files

  async function change(input) {
    const id = state.id;
    try {
      const done = await storage().changeProjectFile(id, input);
      if (state.id !== id) return null;
      state.onChanged?.(done);
      return done;
    } catch (error) { fail(error); return null; }
    finally { await read(); render(); }
  }

  /** The name written in place is taken: a new file or folder is made, or the file gets its new name. */
  async function finishEdit(name) {
    const edit = state.edit;
    if (!edit) return;
    state.edit = null;
    if (!name || /[\\/]/.test(name) || (edit.path && name === nameOf(edit.path))) {
      if (name && /[\\/]/.test(name)) fail(new Error(t('proj.nameInvalid')));
      render();
      return;
    }
    if (edit.path) {
      const to = join(parentOf(edit.path), name);
      const done = await change({ action: 'rename', path: edit.path, to });
      if (done && state.selected === edit.path) state.selected = to;
    } else if (edit.copy) {
      const to = join(edit.dir, name);
      if (to === edit.copy) { render(); return; }
      const done = await change({ action: 'copy', path: edit.copy, to });
      // The copy is what is worked on from here: it takes the place of the file it was made from.
      if (done) { state.selected = to; state.onOpen?.(to); }
    } else {
      const path = join(edit.dir, name);
      const done = await change({ action: edit.folder ? 'folder' : 'file', path });
      // A new file is opened at once: it was made to be written.
      if (done && !edit.folder) { state.selected = path; state.onOpen?.(path); }
    }
    render();
  }

  /** The folders over a path are opened, and a search put away, so that a name written in place is seen. */
  async function reveal(dir) {
    if (state.found) { state.query = ''; state.found = null; state.searchSeq++; clearTimeout(state.searchTimer); }
    let added = false;
    for (let at = dir; at; at = parentOf(at)) if (!state.open.has(at)) { state.open.add(at); added = true; }
    if (added) await read();
  }

  /** A name asked in place, in `dir`: of a new file or folder, or of the copy of the file `copy`. */
  async function startNew(dir, folder, copy = null) {
    await reveal(dir);
    state.edit = { dir, folder, copy };
    render();
  }

  async function startRename(path) {
    await reveal(parentOf(path));
    state.edit = { path };
    render();
  }

  async function remove(path, isDir) {
    const ok = await window.chatWorkspace.confirmAction({
      title: t('proj.removeTitle'),
      message: t(isDir ? 'proj.removeFolderMessage' : 'proj.removeFileMessage', { name: path }),
      confirmText: t('proj.remove')
    });
    if (!ok) return;
    const done = await change({ action: 'remove', path });
    if (done && (state.selected === path || state.selected?.startsWith(path + '/'))) state.selected = null;
  }

  // --- The menu of the right button

  function closeMenu() {
    state.menu?.remove();
    state.menu = null;
  }

  function openMenu(event, target) {
    closeMenu();
    const path = target?.dataset.path || '';
    const isDir = Boolean(target?.dataset.dir);
    const dir = !target ? '' : isDir ? path : parentOf(path);
    const menu = el('div', 'chat-add-menu proj-tree-menu');
    menu.setAttribute('role', 'menu');
    const item = (iconClass, key, run) => {
      const button = el('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.append(icon(iconClass), el('span', '', t(key)));
      button.addEventListener('click', () => { closeMenu(); run(); });
      menu.append(button);
    };
    item('fa-regular fa-file', 'proj.newFile', () => void startNew(dir, false));
    item('fa-regular fa-folder', 'proj.newFolder', () => void startNew(dir, true));
    if (target) {
      item('fa-solid fa-pen', 'proj.rename', () => void startRename(path));
      item('fa-solid fa-trash-can', 'proj.remove', () => void remove(path, isDir));
    }
    document.body.append(menu);
    const box = menu.getBoundingClientRect();
    // Kept inside the column: beside it there may be an editor painted above the page, which would cover the menu.
    const side = (state.host.closest('.proj-side') || state.host).getBoundingClientRect();
    menu.style.left = `${Math.max(side.left + 4, Math.min(event.clientX, side.right - box.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - box.height - 4))}px`;
    state.menu = menu;
  }

  // --- Search by name

  function search(value) {
    const query = String(value || '').trim();
    state.query = query;
    clearTimeout(state.searchTimer);
    const seq = ++state.searchSeq;
    if (!query) { state.found = null; render(); void read(); return; }
    if (!state.found) { state.found = { files: [], truncated: false, loading: true }; render(); }
    state.searchTimer = setTimeout(async () => {
      const id = state.id;
      try {
        const found = await storage().searchProjectFiles(id, query);
        if (state.id !== id || seq !== state.searchSeq) return;
        state.found = found;
        render();
      } catch (error) { if (seq === state.searchSeq) fail(error); }
    }, SEARCH_QUIET_MS);
  }

  // --- The host's events, bound once

  function bind(host) {
    host.addEventListener('click', (event) => {
      const item = event.target.closest('.proj-tree-row[data-path]');
      if (!item || state.edit) return;
      const path = item.dataset.path;
      if (item.dataset.dir) {
        if (state.open.has(path)) state.open.delete(path);
        else state.open.add(path);
        render();
        if (state.open.has(path)) void read();
        return;
      }
      state.selected = path;
      render();
      state.onOpen?.(path);
    });
    host.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (state.found || !state.id) return;
      openMenu(event, event.target.closest('.proj-tree-row[data-path]'));
    });
    host.addEventListener('keydown', (event) => {
      const item = host.querySelector('.proj-tree-row.is-selected');
      if (state.edit || state.found || !item) return;
      if (event.key === 'F2') { event.preventDefault(); state.edit = { path: item.dataset.path }; render(); }
      else if (event.key === 'Delete') { event.preventDefault(); void remove(item.dataset.path, false); }
    });
    // A file or a folder dragged onto a folder (or onto the empty part, for the project itself) is moved there.
    host.addEventListener('dragstart', (event) => {
      const item = event.target.closest('.proj-tree-row[data-path]');
      if (!item || state.found) { event.preventDefault(); return; }
      state.drag = item.dataset.path;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', state.drag);
    });
    const dropDir = (event) => {
      const item = event.target.closest('.proj-tree-row[data-path]');
      return !item ? '' : item.dataset.dir ? item.dataset.path : parentOf(item.dataset.path);
    };
    const allowed = dir => state.drag && parentOf(state.drag) !== dir && dir !== state.drag && !dir.startsWith(state.drag + '/');
    // An artifact taken from the shelf of a pod's project: let go on a folder (or on the empty part, for the
    // project itself), a copy of it goes into the pod there.
    window.addEventListener('synthorg-artifact-drag', (event) => {
      state.artifact = event.detail && event.detail.apart ? event.detail.path : null;
      if (!state.artifact) { host.classList.remove('is-drop'); host.querySelectorAll('.is-drop').forEach(node => node.classList.remove('is-drop')); }
    });
    host.addEventListener('dragover', (event) => {
      const dir = dropDir(event);
      host.querySelectorAll('.is-drop').forEach(node => node.classList.remove('is-drop'));
      if (state.artifact && state.id && !state.found) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        (dir ? host.querySelector(`.proj-tree-row[data-path="${CSS.escape(dir)}"]`) : host)?.classList.add('is-drop');
        return;
      }
      if (!allowed(dir)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      (dir ? host.querySelector(`.proj-tree-row[data-path="${CSS.escape(dir)}"]`) : host)?.classList.add('is-drop');
    });
    host.addEventListener('dragleave', (event) => { if (event.target === host) host.classList.remove('is-drop'); });
    host.addEventListener('dragend', () => { state.drag = null; host.classList.remove('is-drop'); host.querySelectorAll('.is-drop').forEach(node => node.classList.remove('is-drop')); });
    host.addEventListener('drop', async (event) => {
      const dir = dropDir(event);
      if (state.artifact && state.id) {
        const artifact = state.artifact;
        state.artifact = null;
        event.preventDefault();
        host.classList.remove('is-drop');
        host.querySelectorAll('.is-drop').forEach(node => node.classList.remove('is-drop'));
        const id = state.id;
        const to = join(dir, nameOf(artifact));
        try {
          const done = await storage().changeProjectArtifact(id, { action: 'place', path: artifact, to });
          if (state.id !== id) return;
          if (dir) state.open.add(dir);
          state.onChanged?.(done);
          state.onPlaced?.(nameOf(artifact), dir || '/');
        } catch (error) { fail(error); }
        await read();
        render();
        return;
      }
      const from = state.drag;
      state.drag = null;
      host.classList.remove('is-drop');
      if (!from || parentOf(from) === dir || dir === from || dir.startsWith(from + '/')) return;
      event.preventDefault();
      const to = join(dir, nameOf(from));
      if (dir) state.open.add(dir);
      const done = await change({ action: 'rename', path: from, to });
      if (done && state.selected === from) state.selected = to;
      render();
    });
    document.addEventListener('pointerdown', (event) => { if (state.menu && !state.menu.contains(event.target)) closeMenu(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
    window.addEventListener('blur', closeMenu);
    window.addEventListener('synthorg-locale-changed', () => { if (state.id) render(); });
  }

  window.projectTree = {
    /** The column on a project: `onOpen(path)` for a file pressed, `onChanged(done)` after a change made here, `onError(text)`. */
    async open(host, { id, kind, onOpen, onChanged, onError, onPlaced = null }) {
      if (!state.host) bind(host);
      Object.assign(state, { host, id, kind, onOpen, onChanged, onError, onPlaced, artifact: null, selected: null, query: '', found: null, edit: null });
      state.dirs = new Map();
      state.open = new Set(['']);
      host.replaceChildren();
      follow();
      await read();
      render();
    },
    close() {
      clearInterval(state.timer);
      closeMenu();
      Object.assign(state, { id: null, selected: null, found: null, edit: null });
      state.dirs = new Map();
      state.host?.replaceChildren();
    },
    /** Something changed the files from elsewhere (an editor, a model, a download): read now. */
    refresh() { if (state.id && !state.found) void read(); },
    search,
    /** What the bar over the file asks, the name written in place here: a new file in a folder, another name for a file, a copy of it under another name. */
    newFile(dir = '') { if (state.id) void startNew(dir, false); },
    rename(path) { if (state.id && path) void startRename(path); },
    copyAs(path) { if (state.id && path) void startNew(parentOf(path), false, path); },
    /** The file in the middle, marked in the column; its folders are opened so that it is seen. */
    select(path) {
      if (state.selected === path) return;
      state.selected = path || null;
      if (path && !state.found) {
        let added = false;
        for (let dir = parentOf(path); dir; dir = parentOf(dir)) if (!state.open.has(dir)) { state.open.add(dir); added = true; }
        if (added) { void read().then(() => { if (!state.edit) render(); }); return; }
      }
      if (!state.edit) render();
    }
  };
})();
