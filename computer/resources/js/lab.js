/**
 * SynthOrg - the Lab: every project in one list, and the making of a new one.
 *
 * A project has a name, a note of the user's, where it runs (a pod, or a
 * folder of this computer), the repository it follows if any, one permission
 * for the model, and the environments it has on together (Code, Photo,
 * Writing). The list is here; a project opened from it is worked in its
 * frame (code-workspace.js), which comes back here when left.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const t = (key, params) => window.i18n.t(key, params || {});
  const storage = () => window.chatStorage;

  // The environments, in the order they are drawn.
  const ENVS = ['code', 'photo', 'writing'];
  // Which section's switch an environment answers to (sections.js), and which of them need a folder of this computer.
  const SWITCH = { code: 'code', photo: 'studio', writing: 'studio' };
  const ON_FOLDER = [];
  const PERMS = ['auto', 'semi', 'manual'];

  let active = false;
  let busy = false;
  let github = null;
  let githubPoll = null;
  const draft = { kind: 'podman', perm: 'manual', envs: new Set(['code']) };

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
  const slug = value => String(value || '').toLowerCase().trim()
    .replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/[-_.]+$/, '').slice(0, 50);
  function formatDate(value) {
    const locale = window.i18n.getLocale?.() === 'en' ? 'en-GB' : 'it-IT';
    return new Date(value).toLocaleDateString(locale, { dateStyle: 'medium' });
  }
  function openExternal(url) {
    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) return invoke('plugin:shell|open', { path: url });
    window.open(url, '_blank', 'noopener');
    return Promise.resolve();
  }
  const sectionOn = env => window.sections?.on(SWITCH[env]) !== false;

  function showError(message) {
    $('lab-error').hidden = !message;
    $('lab-error-text').textContent = message || '';
  }

  // --- The list

  /** The note of a card, written in place: Enter or leaving the field keeps it, Esc leaves it as it was. */
  function editNote(item, holder) {
    const field = el('textarea', 'lab-card-note-field');
    field.maxLength = 500;
    field.rows = 2;
    field.value = item.notes || '';
    field.setAttribute('aria-label', t('lab.notes'));
    let done = false;
    const end = async (keep) => {
      if (done) return;
      done = true;
      const value = field.value.trim();
      if (keep && value !== (item.notes || '')) {
        try { await storage().setProjectNotes(item.id, value); showError(''); } catch (error) { showError(error.message); }
      }
      await load();
    };
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void end(true); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void end(false); }
    });
    field.addEventListener('blur', () => void end(true));
    holder.replaceWith(field);
    field.focus();
    field.select();
  }

  function card(item) {
    const article = el('article', 'lab-card');
    const open = el('button', 'lab-card-open');
    open.type = 'button';
    open.addEventListener('click', () => void openProject(item));
    open.append(el('span', 'lab-card-name', item.name));

    const note = el('button', item.notes ? 'lab-card-note' : 'lab-card-note is-empty', item.notes || t('lab.notesAdd'));
    note.type = 'button';
    note.title = t('lab.notesEdit');
    note.addEventListener('click', () => editNote(item, note));

    const foot = el('div', 'lab-card-foot');
    // The day of the last change, alone.
    const when = el('span', 'lab-card-date', formatDate(item.modified_at));
    when.title = t('lab.modified');
    const spent = Number(item.usage?.cost) || 0;
    const runs = Number(item.usage?.runs) || 0;
    const money = window.realtime?._usage?.money || (value => `$${value.toFixed(2)}`);
    const cost = el('span', 'lab-card-cost', t('code.projectCost', { cost: money(spent) }));
    cost.title = t(runs === 1 ? 'code.projectCostTitle1' : 'code.projectCostTitle', { cost: money(spent), runs });
    foot.append(when, cost);

    const remove = el('button', 'lab-card-remove');
    remove.type = 'button';
    remove.title = t(item.kind === 'podman' ? 'code.deleteProject' : 'code.removeProject');
    remove.setAttribute('aria-label', remove.title);
    remove.append(icon('fa-solid fa-trash-can'));
    remove.addEventListener('click', () => void removeProject(item));

    article.append(open, note, foot, remove);
    return article;
  }

  async function load() {
    try {
      const projects = await storage().listProjects('all');
      const grid = $('lab-grid');
      grid.replaceChildren(...projects.map(card));
      if (!projects.length) grid.append(el('p', 'conversation-empty', t('lab.empty')));
    } catch (error) { showError(error.message); }
  }

  async function removeProject(item) {
    if (busy) return;
    // A project in a pod is deleted whole; one in a folder is only taken off the list.
    const pod = item.kind === 'podman';
    const key = pod ? (item.repo ? 'code.removePodmanLinkedMessage' : 'code.removePodmanMessage') : item.repo ? 'code.removeLinkedMessage' : 'code.removeLocalMessage';
    const ok = await window.chatWorkspace.confirmAction({
      title: t(pod ? 'code.deleteTitle' : 'code.removeTitle'),
      message: t(key, { name: item.name, path: item.container_name || item.path, repo: item.repo || '' }),
      confirmText: t(pod ? 'code.deleteConfirm' : 'code.removeConfirm')
    });
    if (!ok) return;
    try { await storage().removeProject(item.id); showError(''); } catch (error) { showError(error.message); }
    await load();
  }

  // --- A project opened: in its frame (code-workspace.js), on the first of its environments

  async function openProject(item) {
    if (busy) return;
    const envs = ENVS.filter(env => item.envs.includes(env));
    if (!envs.some(sectionOn)) { showError(t('lab.sectionOff', { name: envs.map(env => t(`lab.env.${env}`)).join(', ') })); return; }
    busy = true;
    showError('');
    try {
      // Asked first, shown after: the frame with no project on its way comes back here.
      const opened = window.codeWorkspace.open(item.id);
      window.switchView('code');
      if (await opened) return;
      // Not opened: what the frame said is said here, where the project was chosen.
      const said = $('code-projects-error-text')?.textContent || t('lab.openFailed', { name: item.name });
      window.switchView('lab');
      showError(said);
    } catch (error) {
      window.switchView('lab');
      showError(error.message);
    } finally { busy = false; }
  }

  // --- GitHub: the account, from the button over the list

  function renderGithub() {
    const s = github || {};
    const button = $('lab-btn-github');
    button.classList.toggle('is-on', Boolean(s.connected));
    button.title = s.connected ? t('code.githubConnectedAs', { login: s.login }) : t('code.githubDisconnected');
    $('lab-github-title').textContent = button.title;
    const desc = $('lab-github-desc');
    desc.textContent = s.pending ? t('code.githubPending')
      : s.error ? s.error
      : s.connected ? t('code.githubConnectedDesc')
      : s.appRegistered ? t('code.githubConnectDesc') : t('code.githubRegisterDesc');
    desc.classList.toggle('is-error', Boolean(s.error) && !s.pending);
    $('lab-github-connect').hidden = Boolean(s.connected);
    $('lab-github-connect').disabled = Boolean(s.pending);
    $('lab-github-manage').hidden = !s.connected;
    $('lab-github-manage').disabled = Boolean(s.pending);
    $('lab-github-disconnect').hidden = !s.connected;
  }

  function stopGithubPoll() {
    if (githubPoll) { clearInterval(githubPoll); githubPoll = null; }
  }

  async function refreshGithub() {
    try { github = await storage().githubStatus(); }
    catch (error) { github = { error: error.message }; }
    renderGithub();
    // Waiting for the browser's answer is followed only while the dialog that asked is open.
    if (github.pending && !githubPoll && $('lab-github-dialog').open) githubPoll = setInterval(() => void refreshGithub(), 2000);
    if (!github.pending) stopGithubPoll();
  }

  async function githubFlow(start) {
    $('lab-github-error').textContent = '';
    try {
      const { url } = await start();
      await openExternal(url);
    } catch (error) { $('lab-github-error').textContent = error.message || String(error); }
    await refreshGithub();
  }

  // --- A new project

  function renderDraft() {
    for (const button of $('lab-new-perm').children) button.setAttribute('aria-checked', String(button.dataset.perm === draft.perm));
    for (const button of $('lab-new-kind').children) button.setAttribute('aria-checked', String(button.dataset.kind === draft.kind));
    const folder = draft.kind === 'local';
    $('lab-new-folder-row').hidden = !folder;
    // No environment is for a folder only: in a pod, the files of Photo and Writing are artifacts of the project, kept on this computer.
    if (!folder) for (const env of ON_FOLDER) draft.envs.delete(env);
    for (const button of $('lab-new-envs').children) {
      const env = button.dataset.env;
      const off = !sectionOn(env);
      button.disabled = off || (!folder && ON_FOLDER.includes(env));
      button.setAttribute('aria-pressed', String(draft.envs.has(env)));
      button.title = off ? t('lab.sectionOff', { name: t(`lab.env.${env}`) }) : '';
    }
    $('lab-new-hint').hidden = folder;
  }

  /** The repositories of the account, with "none" first; without an account, "none" alone. */
  async function loadRepos() {
    const select = $('lab-new-repo');
    select.replaceChildren(new Option(t('lab.repoNone'), ''));
    select.disabled = true;
    renderBranches(null);
    await refreshGithub();
    if (!github?.connected) { select.title = t('code.githubDisconnected'); return; }
    select.title = '';
    try {
      const repos = await storage().githubRepositories();
      for (const repo of repos) select.append(new Option(repo.private ? `${repo.full_name} (${t('code.repoPrivate')})` : repo.full_name, repo.full_name));
      select.disabled = false;
    } catch (error) { $('lab-new-error').textContent = error.message; }
  }

  /** The branches of the repository chosen: all of them (the project follows the whole repository), or one. */
  function renderBranches(listed) {
    const select = $('lab-new-branch');
    const main = listed?.defaultBranch || '';
    const names = [...(listed?.branches || [])].sort((a, b) => (b === main) - (a === main) || a.localeCompare(b));
    select.replaceChildren(new Option(t(listed ? 'lab.branchAll' : 'lab.branchNone'), ''),
      ...names.map(name => new Option(name === main ? `${name} — ${t('code.branchMain')}` : name, name)));
    select.disabled = !listed;
  }

  async function loadBranches() {
    const repo = $('lab-new-repo').value;
    renderBranches(null);
    if (!repo) return;
    $('lab-new-branch').replaceChildren(new Option(t('code.branchLoading'), ''));
    try {
      const listed = await storage().githubBranches(repo);
      if ($('lab-new-repo').value === repo) renderBranches(listed);
    } catch (error) {
      if ($('lab-new-repo').value === repo) { renderBranches(null); $('lab-new-error').textContent = error.message; }
    }
  }

  async function openNew() {
    if (busy) return;
    $('lab-new-form').reset();
    $('lab-new-error').textContent = '';
    draft.kind = 'podman';
    draft.envs = new Set(sectionOn('code') ? ['code'] : []);
    draft.perm = 'manual';
    renderDraft();
    $('lab-new-dialog').showModal();
    $('lab-new-name').focus();
    void loadRepos();
    // The permission starts from the one the settings give to new projects.
    try {
      const value = (await storage().getSetting('code_perm_code'))?.value;
      if (PERMS.includes(value)) { draft.perm = value; renderDraft(); }
    } catch {}
  }

  async function browseFolder() {
    const invoke = window.__TAURI__?.core?.invoke;
    const error = $('lab-new-error');
    if (!invoke) { error.textContent = t('code.desktopRequired'); return; }
    try {
      const selected = await invoke('plugin:dialog|open', { options: { directory: true, multiple: false, title: t('code.chooseFolderTitle') } });
      if (typeof selected !== 'string') return;
      $('lab-new-folder').value = selected;
      if (!$('lab-new-name').value.trim()) $('lab-new-name').value = (selected.split(/[\\/]/).filter(Boolean).pop() || '').slice(0, 80);
      error.textContent = '';
    } catch (err) { error.textContent = err.message || String(err); }
  }

  async function submitNew(event) {
    event.preventDefault();
    const error = $('lab-new-error');
    const repo = $('lab-new-repo').value;
    const branch = $('lab-new-branch').value;
    const data = { kind: draft.kind, name: $('lab-new-name').value.trim(), envs: ENVS.filter(env => draft.envs.has(env)), permission: draft.perm };
    if (!data.envs.length) { error.textContent = t('lab.envRequired'); return; }
    if (repo) Object.assign(data, { repo, repoMode: branch ? 'branch' : 'full' }, branch ? { repoBranch: branch } : {});
    if (draft.kind === 'local') {
      data.path = $('lab-new-folder').value;
      if (!data.path) { error.textContent = t('code.folderRequired'); return; }
    } else {
      // The pod is named after the project, or after its repository.
      data.container = slug(data.name) || slug(repo.split('/')[1] || '');
      if (!data.container) { error.textContent = t('lab.nameRequired'); return; }
    }
    const submit = $('lab-new-submit');
    submit.disabled = true;
    try {
      await storage().createProject(data);
      $('lab-new-dialog').close();
      showError('');
      await load();
    } catch (err) { error.textContent = err.message; }
    finally { submit.disabled = false; }
  }

  function start() {
    // The phone has its own zone of the projects (remote.js).
    if (window.SYNTHORG_REMOTE) return;

    $('lab-btn-new').addEventListener('click', () => void openNew());
    $('lab-new-close').addEventListener('click', () => $('lab-new-dialog').close());
    $('lab-new-cancel').addEventListener('click', () => $('lab-new-dialog').close());
    $('lab-new-form').addEventListener('submit', event => void submitNew(event));
    $('lab-new-browse').addEventListener('click', () => void browseFolder());
    $('lab-new-repo').addEventListener('change', () => { $('lab-new-error').textContent = ''; void loadBranches(); });
    $('lab-new-perm').addEventListener('click', (event) => {
      const chosen = event.target.closest('[data-perm]');
      if (chosen) { draft.perm = chosen.dataset.perm; renderDraft(); }
    });
    $('lab-new-kind').addEventListener('click', (event) => {
      const chosen = event.target.closest('[data-kind]');
      if (chosen) { draft.kind = chosen.dataset.kind; renderDraft(); }
    });
    $('lab-new-envs').addEventListener('click', (event) => {
      const chosen = event.target.closest('[data-env]');
      if (!chosen || chosen.disabled) return;
      const env = chosen.dataset.env;
      if (draft.envs.has(env)) draft.envs.delete(env); else draft.envs.add(env);
      $('lab-new-error').textContent = '';
      renderDraft();
    });

    $('lab-btn-github').addEventListener('click', () => {
      $('lab-github-error').textContent = '';
      $('lab-github-dialog').showModal();
      void refreshGithub();
    });
    $('lab-github-close').addEventListener('click', () => $('lab-github-dialog').close());
    $('lab-github-dialog').addEventListener('close', stopGithubPoll);
    $('lab-github-connect').addEventListener('click', () => void githubFlow(() => storage().githubConnect()));
    $('lab-github-manage').addEventListener('click', () => void githubFlow(() => storage().githubInstall()));
    $('lab-github-disconnect').addEventListener('click', async () => {
      try { await storage().githubDisconnect(); } catch (error) { $('lab-github-error').textContent = error.message; }
      await refreshGithub();
    });
    window.addEventListener('synthorg-locale-changed', () => { if (active) { void load(); renderGithub(); } });

    window.lab = {
      /** The Lab on screen or not: shown, it reads the projects again. */
      setActive(on) {
        active = on;
        if (on) { void load(); void refreshGithub(); }
      },
      /** An editor was left for the list of the projects: the list is this one. */
      show() { window.switchView('lab'); }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
