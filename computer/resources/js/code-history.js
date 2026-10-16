/**
 * Code tab: the project's history, as a place to look at.
 *
 * Every save and every change of the model is already a step of the project's
 * git record; this reads it back like a repository page — the steps by day,
 * who made each one, what it changed line by line, the whole project as it was
 * at any step, one file through time — and takes a file or the whole project
 * back to a step. Going back is a step too: nothing is rewritten or lost.
 *
 * The same for a local project and a container one: the service runs git where
 * the code is. Nothing from the repository is ever put in the page as markup,
 * only as text.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const t = (key, params) => window.i18n?.t(key, params || {}) || key;
  const PAGE = 100;
  const POLL_MS = 4000;
  const BIG_DIFF_LINES = 400;
  const STATUS_KEYS = { A: 'code.histAdded', M: 'code.histModified', D: 'code.histDeleted', R: 'code.histRenamed', C: 'code.histCopied', T: 'code.histModified' };

  const state = {
    projectId: null, commits: [], more: false, github: null,
    path: null, text: '', selected: null, step: null,
    mode: 'commit', tree: null, treeFilter: '', file: null,
    poll: null, head: null, busy: false, note: null
  };

  // ---- small builders ---------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function icon(name) { const node = el('i', name); node.setAttribute('aria-hidden', 'true'); return node; }
  function button(className, iconName, label, onClick, title) {
    const node = el('button', className);
    node.type = 'button';
    if (iconName) node.append(icon(iconName));
    if (label) node.append(el('span', null, label));
    if (title) { node.title = title; node.setAttribute('aria-label', title); }
    node.addEventListener('click', onClick);
    return node;
  }
  const locale = () => (window.i18n?.getLocale?.() || 'it') === 'en' ? 'en-GB' : 'it-IT';
  function timeOf(iso) { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }); }
  function fullDate(iso) { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(locale(), { dateStyle: 'long', timeStyle: 'short' }); }
  function dayOf(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const that = new Date(d); that.setHours(0, 0, 0, 0);
    const days = Math.round((today - that) / 86400000);
    if (days === 0) return t('code.histToday');
    if (days === 1) return t('code.histYesterday');
    return d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  function who(step) { return step.source === 'agent' ? t('code.histModel') : step.source === 'user' ? t('code.histYou') : (step.author || ''); }
  function whoIcon(step) { return step.source === 'agent' ? 'fa-solid fa-robot' : 'fa-solid fa-user'; }
  function counts(step) {
    const box = el('span', 'code-hist-counts');
    box.append(el('span', 'code-hist-plus', `+${step.additions || 0}`), el('span', 'code-hist-minus', `−${step.deletions || 0}`));
    return box;
  }

  // ---- loading ------------------------------------------------------------------

  async function load({ append = false, keep = true } = {}) {
    if (!state.projectId) return;
    const id = state.projectId;
    const skip = append ? state.commits.length : 0;
    const page = await window.chatStorage.projectHistory(id, { limit: PAGE, skip, path: state.path });
    if (id !== state.projectId) return;
    state.commits = append ? state.commits.concat(page.commits) : page.commits;
    state.more = page.more;
    state.github = page.github;
    if (!state.path && !append) state.head = page.commits[0]?.hash || null;
    renderList();
    // No step is chosen for the user: what is open stays in the middle until one is pressed.
    const stillThere = keep && state.selected && state.commits.some(c => c.hash === state.selected);
    if (!stillThere && state.selected) deselect();
  }

  /** The step in the middle is put away: what was open is there again. */
  function deselect() {
    state.selected = null; state.step = null; state.note = null; state.mode = 'commit';
    renderList(); renderDetail();
  }

  async function select(hash) {
    // The step already in the middle, pressed again, is put away.
    if (state.selected === hash) { deselect(); return; }
    state.selected = hash; state.mode = 'commit'; state.step = null; state.note = null;
    renderList(); renderDetail();
    const id = state.projectId;
    try {
      const step = await window.chatStorage.projectHistoryCommit(id, hash);
      if (id !== state.projectId || state.selected !== hash) return;
      state.step = step;
    } catch (error) { state.note = { error: true, text: error.message }; }
    renderDetail();
  }

  // A step made elsewhere (a save, the model) shows up while the tab is open.
  async function poll() {
    if (!state.projectId || state.busy || document.hidden) return;
    try {
      const page = await window.chatStorage.projectHistory(state.projectId, { limit: 1 });
      const head = page.commits[0]?.hash || null;
      if (head !== state.head) { state.head = head; await load(); }
    } catch {}
  }

  // ---- the list of steps ------------------------------------------------------------

  function renderList() {
    const list = $('code-history-steps');
    if (!list) return;
    list.replaceChildren();
    const chip = $('code-history-path');
    chip.hidden = !state.path;
    $('code-history-path-text').textContent = state.path || '';
    const needle = state.text.trim().toLowerCase();
    const shown = needle ? state.commits.filter(c => [c.title, c.author, c.tool, c.short, who(c)].some(v => String(v || '').toLowerCase().includes(needle))) : state.commits;
    if (!shown.length) {
      list.append(el('p', 'code-hist-empty', t(state.commits.length ? 'code.histNoMatch' : 'code.histEmpty')));
    }
    let day = null;
    for (const step of shown) {
      const label = dayOf(step.when);
      if (label !== day) { day = label; list.append(el('div', 'code-hist-day', label)); }
      const row = el('button', `code-hist-step${step.hash === state.selected ? ' is-selected' : ''}`);
      row.type = 'button';
      row.addEventListener('click', () => select(step.hash));
      const avatar = el('span', `code-hist-avatar is-${step.source || 'other'}`);
      avatar.append(icon(whoIcon(step)));
      const main = el('span', 'code-hist-step-main');
      const title = el('span', 'code-hist-step-title', step.title || t('code.histUntitled'));
      const meta = el('span', 'code-hist-step-meta');
      meta.append(el('span', null, who(step)), el('span', null, timeOf(step.when)));
      if (step.files) meta.append(el('span', null, t(step.files === 1 ? 'code.histOneFile' : 'code.histFiles', { count: step.files })));
      meta.append(counts(step));
      main.append(title, meta);
      const side = el('span', 'code-hist-step-side');
      if (step.hash === state.head && !state.path) side.append(el('span', 'code-hist-now', t('code.histCurrent')));
      if (step.onGithub) { const cloud = icon('fa-brands fa-github code-hist-cloud'); cloud.title = t('code.histOnGithub'); side.append(cloud); }
      side.append(el('span', 'code-hist-hash', step.short));
      row.append(avatar, main, side);
      list.append(row);
    }
    $('code-history-more').hidden = !state.more;
    const repo = $('code-history-github');
    repo.hidden = !state.github;
    if (state.github) $('code-history-github-text').textContent = `${state.github.repo} · ${state.github.branch}`;
  }

  // ---- the right side: a step, the project at a step, a file at a step ----------------

  function renderDetail() {
    const box = $('code-history-detail');
    if (!box) return;
    box.replaceChildren();
    // The frame of the project shows this over what is open only while there is something to show.
    window.codeWorkspace?.historyDetail?.(Boolean(state.selected || state.note));
    if (!state.selected && !state.note) return;
    box.append(button('btn-chat-action code-hist-close', 'fa-solid fa-xmark', null, deselect, t('common.close')));
    if (!state.selected) { box.append(el('p', `code-hist-note${state.note.error ? ' is-error' : ''}`, state.note.text)); return; }
    if (state.note) box.append(el('p', `code-hist-note${state.note.error ? ' is-error' : ''}`, state.note.text));
    if (state.mode === 'tree') return renderTree(box);
    if (state.mode === 'file') return renderFile(box);
    if (!state.step) { box.append(el('p', 'code-hist-empty', t('code.histLoading'))); return; }
    renderStep(box, state.step);
  }

  function stepHeader(step) {
    const head = el('div', 'code-hist-head');
    head.append(el('h3', 'code-hist-title', step.title || t('code.histUntitled')));
    if (step.body) head.append(el('p', 'code-hist-body', step.body));
    const meta = el('div', 'code-hist-meta');
    const author = el('span', `code-hist-author is-${step.source || 'other'}`);
    author.append(icon(whoIcon(step)), el('span', null, who(step)));
    meta.append(author);
    if (step.tool && step.tool !== 'restore') meta.append(el('span', 'code-branch-badge', step.tool));
    meta.append(el('span', null, fullDate(step.when)), el('span', 'code-hist-hash', step.short));
    head.append(meta);
    return head;
  }

  function renderStep(box, step) {
    box.append(stepHeader(step));
    const actions = el('div', 'code-hist-actions');
    actions.append(button('btn', 'fa-solid fa-folder-tree', t('code.histBrowse'), () => openTree()));
    if (step.hash !== state.head) actions.append(button('btn', 'fa-solid fa-clock-rotate-left', t('code.histRestoreAll'), () => restore(null)));
    box.append(actions);
    const total = step.files.reduce((sum, f) => ({ add: sum.add + (f.additions || 0), del: sum.del + (f.deletions || 0) }), { add: 0, del: 0 });
    const summary = el('div', 'code-hist-summary');
    summary.append(el('span', null, t(step.files.length === 1 ? 'code.histOneFileChanged' : 'code.histFilesChanged', { count: step.files.length })), counts({ additions: total.add, deletions: total.del }));
    box.append(summary);
    if (step.tooLarge) box.append(el('p', 'code-hist-note', t('code.histTooLarge')));
    for (const file of step.files) box.append(fileCard(step, file));
  }

  function fileCard(step, file) {
    const card = el('section', 'code-hist-file');
    const head = el('div', 'code-hist-file-head');
    const status = el('span', `code-hist-status is-${file.status}`, file.status);
    status.title = t(STATUS_KEYS[file.status] || 'code.histModified');
    const name = el('span', 'code-hist-file-name', file.oldPath ? `${file.oldPath} → ${file.path}` : file.path);
    const tools = el('span', 'code-hist-file-tools');
    tools.append(counts(file));
    tools.append(button('btn-chat-action', 'fa-solid fa-timeline', null, () => filterFile(file.path), t('code.histFileHistory')));
    if (file.status !== 'D') tools.append(button('btn-chat-action', 'fa-regular fa-file-lines', null, () => openFile(file.path), t('code.histViewFile')));
    if (step.hash !== state.head || file.status === 'D') tools.append(button('btn-chat-action', 'fa-solid fa-clock-rotate-left', null, () => restore(file.path), t('code.histRestoreFile')));
    const toggle = icon('fa-solid fa-chevron-down code-hist-chevron');
    head.append(toggle, status, name, tools);
    const body = el('div', 'code-hist-diff');
    const lines = file.hunks ? file.hunks.split('\n').length : 0;
    let collapsed = lines > BIG_DIFF_LINES;
    const fill = () => {
      body.replaceChildren();
      if (file.binary) { body.append(el('p', 'code-hist-note', t('code.histBinary'))); return; }
      if (!file.hunks) { body.append(el('p', 'code-hist-note', t(file.status === 'R' ? 'code.histOnlyRenamed' : 'code.histNoText'))); return; }
      if (collapsed) {
        body.append(button('btn code-hist-expand', 'fa-solid fa-eye', t('code.histShowDiff', { count: lines }), () => { collapsed = false; fill(); }));
        return;
      }
      body.append(diffTable(file.hunks));
      if (file.truncated) body.append(el('p', 'code-hist-note', t('code.histDiffCut')));
    };
    head.addEventListener('click', event => {
      if (event.target.closest('button')) return;
      card.classList.toggle('is-folded');
    });
    fill();
    card.append(head, body);
    return card;
  }

  // A unified diff as a table: old and new line numbers, then the line, coloured by what happened to it.
  function diffTable(hunks) {
    const table = el('table', 'code-hist-lines');
    const tbody = el('tbody');
    let oldLine = 0, newLine = 0;
    for (const line of hunks.split('\n')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      const row = el('tr');
      if (hunk) {
        oldLine = Number(hunk[1]); newLine = Number(hunk[2]);
        row.className = 'is-hunk';
        const cell = el('td', null, line); cell.colSpan = 3;
        row.append(cell);
      } else if (line.startsWith('\\')) {
        row.className = 'is-meta';
        const cell = el('td', null, line); cell.colSpan = 3;
        row.append(cell);
      } else {
        const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
        row.className = `is-${kind}`;
        row.append(el('td', 'code-hist-ln', kind === 'add' ? '' : String(oldLine)), el('td', 'code-hist-ln', kind === 'del' ? '' : String(newLine)), el('td', 'code-hist-code', line));
        if (kind !== 'add') oldLine++;
        if (kind !== 'del') newLine++;
      }
      tbody.append(row);
    }
    table.append(tbody);
    return table;
  }

  function back(label) {
    return button('btn code-hist-back', 'fa-solid fa-arrow-left', label, () => { state.mode = state.mode === 'file' && state.tree ? 'tree' : 'commit'; state.note = null; renderDetail(); });
  }

  async function openTree() {
    state.mode = 'tree'; state.tree = null; state.treeFilter = ''; state.note = null;
    renderDetail();
    const id = state.projectId, hash = state.selected;
    try {
      const tree = await window.chatStorage.projectHistoryTree(id, hash);
      if (id !== state.projectId || hash !== state.selected || state.mode !== 'tree') return;
      state.tree = tree;
    } catch (error) { state.note = { error: true, text: error.message }; }
    renderDetail();
  }

  function renderTree(box) {
    const step = state.commits.find(c => c.hash === state.selected) || state.step || { short: state.selected.slice(0, 7) };
    const bar = el('div', 'code-hist-crumbs');
    bar.append(back(t('code.histBackToStep')), el('span', 'code-hist-crumb', t('code.histFilesAt', { version: step.short })));
    box.append(bar);
    if (!state.tree) { box.append(el('p', 'code-hist-empty', t('code.histLoading'))); return; }
    const search = el('input', 'code-hist-search');
    search.type = 'search';
    search.placeholder = t('code.histFilterFiles');
    search.value = state.treeFilter;
    const list = el('div', 'code-hist-tree');
    const fill = () => {
      list.replaceChildren();
      const needle = state.treeFilter.toLowerCase();
      let lastDir = null;
      for (const file of state.tree.files) {
        if (needle && !file.toLowerCase().includes(needle)) continue;
        const slash = file.lastIndexOf('/');
        const dir = slash === -1 ? '' : file.slice(0, slash);
        if (dir !== lastDir) {
          lastDir = dir;
          if (dir) { const head = el('div', 'code-hist-tree-dir'); head.append(icon('fa-regular fa-folder'), el('span', null, dir)); list.append(head); }
        }
        const row = button(`code-hist-tree-file${dir ? ' is-nested' : ''}`, 'fa-regular fa-file', file.slice(slash + 1), () => openFile(file));
        list.append(row);
      }
      if (state.tree.truncated) list.append(el('p', 'code-hist-note', t('code.histTreeCut')));
    };
    search.addEventListener('input', () => { state.treeFilter = search.value; fill(); });
    fill();
    box.append(search, list);
  }

  async function openFile(path) {
    state.mode = 'file'; state.file = { path, loading: true }; state.note = null;
    renderDetail();
    const id = state.projectId, hash = state.selected;
    try {
      const file = await window.chatStorage.projectHistoryFile(id, hash, path);
      if (id !== state.projectId || hash !== state.selected || state.mode !== 'file') return;
      state.file = file;
    } catch (error) { state.file = { path, error: error.message }; }
    renderDetail();
  }

  function renderFile(box) {
    const file = state.file;
    const step = state.commits.find(c => c.hash === state.selected) || state.step || { short: state.selected.slice(0, 7) };
    const bar = el('div', 'code-hist-crumbs');
    bar.append(back(t(state.tree ? 'code.histBackToFiles' : 'code.histBackToStep')), el('span', 'code-hist-crumb', `${file.path} · ${step.short}`));
    const tools = el('span', 'code-hist-file-tools');
    tools.append(button('btn-chat-action', 'fa-solid fa-timeline', null, () => filterFile(file.path), t('code.histFileHistory')));
    if (state.selected !== state.head) tools.append(button('btn-chat-action', 'fa-solid fa-clock-rotate-left', null, () => restore(file.path), t('code.histRestoreFile')));
    bar.append(tools);
    box.append(bar);
    if (file.loading) { box.append(el('p', 'code-hist-empty', t('code.histLoading'))); return; }
    if (file.error) { box.append(el('p', 'code-hist-note is-error', file.error)); return; }
    if (file.tooLarge) { box.append(el('p', 'code-hist-note', t('code.histFileTooLarge'))); return; }
    if (file.binary) { box.append(el('p', 'code-hist-note', t('code.histBinary'))); return; }
    const table = el('table', 'code-hist-lines is-file');
    const tbody = el('tbody');
    file.content.replace(/\n$/, '').split('\n').forEach((line, index) => {
      const row = el('tr');
      row.append(el('td', 'code-hist-ln', String(index + 1)), el('td', 'code-hist-code', line));
      tbody.append(row);
    });
    table.append(tbody);
    box.append(table);
  }

  // ---- actions ----------------------------------------------------------------------

  function filterFile(path) {
    state.path = path; state.selected = null; state.text = '';
    const search = $('code-history-filter');
    if (search) search.value = '';
    load({ keep: false }).catch(showError);
  }

  async function restore(path) {
    const step = state.commits.find(c => c.hash === state.selected) || state.step;
    if (!step) return;
    const ok = await window.chatWorkspace.confirmAction({
      title: t(path ? 'code.histRestoreFileTitle' : 'code.histRestoreAllTitle'),
      message: path ? t('code.histRestoreFileMessage', { file: path, version: step.short, when: fullDate(step.when) })
        : t('code.histRestoreAllMessage', { version: step.short, when: fullDate(step.when) }),
      confirmText: t('code.histRestoreConfirm')
    });
    if (!ok) return;
    state.busy = true;
    try {
      await window.chatStorage.restoreProject(state.projectId, step.hash, path);
      state.selected = null;
      await load({ keep: false });
      state.note = { error: false, text: t(path ? 'code.histRestoredFile' : 'code.histRestoredAll', { file: path || '', version: step.short }) };
      renderDetail();
    } catch (error) { showError(error); }
    finally { state.busy = false; }
  }

  function showError(error) { state.note = { error: true, text: error.message || String(error) }; renderDetail(); }

  // ---- open / close -----------------------------------------------------------------

  function bind() {
    const search = $('code-history-filter');
    if (!search || search.dataset.bound) return;
    search.dataset.bound = '1';
    search.addEventListener('input', () => { state.text = search.value; renderList(); });
    $('code-history-path-clear').addEventListener('click', () => { state.path = null; state.selected = null; load({ keep: false }).catch(showError); });
    $('code-history-more').addEventListener('click', () => load({ append: true }).catch(showError));
  }

  async function open(projectId) {
    bind();
    if (projectId !== state.projectId) {
      Object.assign(state, { projectId, commits: [], more: false, github: null, path: null, text: '', selected: null, step: null, mode: 'commit', tree: null, file: null, head: null, note: null });
      $('code-history-filter').value = '';
    }
    renderList(); renderDetail();
    clearInterval(state.poll);
    state.poll = setInterval(poll, POLL_MS);
    try { await load(); } catch (error) { showError(error); }
  }

  function close() {
    clearInterval(state.poll); state.poll = null;
    if (state.selected || state.note) deselect();
  }

  window.addEventListener('synthorg-locale-changed', () => { if (state.poll) { renderList(); renderDetail(); } });
  window.codeHistory = { open, close, refresh: () => load().catch(showError) };
})();
