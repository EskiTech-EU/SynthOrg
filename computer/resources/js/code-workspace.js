/**
 * SynthOrg - the frame of an open project.
 *
 * One frame for every environment. On the left the files of the project, in
 * a column of the page (project-tree.js); in the middle what is open, under
 * the functions and over the toolbars; on the right the project's chat. What
 * is in the middle belongs to the environment the file opens with: the code
 * editor (the SideX workbench for a folder of this computer, the editor that
 * runs inside the pod for a pod), photocraft (photo.js), the sheets of a text
 * (studio.js). A project has one or more of them on, and the one in view is
 * also the one the chat works with.
 *
 * The frame is what opens the project and holds what is the project's rather
 * than an environment's: its record and its repository, its chats, what the
 * model may do in it.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const t = (key, params) => window.i18n?.t(key, params || {}) || key;
  // Where a project runs. Being linked to a repository is the other, separate
  // choice: every project can have one, and none is a kind of its own.
  const KIND_ICONS = { local: 'fa-solid fa-folder-open', podman: 'fa-solid fa-cube' };
  const KIND_LABELS = { local: 'code.kindLocal', podman: 'code.kindPodman' };

  let active = false;
  let created = false;
  let running = false;
  let pending = false;
  let busy = false;
  // The project in the frame; null while none is open.
  let project = null;
  // An open asked for and not yet begun: the view may be shown before the project is there.
  let opening = false;
  // The environments, in their order, the switch each answers to (sections.js) and how the chat calls them.
  const ENVS = ['code', 'photo', 'writing'];
  const ENV_SWITCH = { code: 'code', photo: 'studio', writing: 'studio' };
  const ENV_SECTION = { code: 'code', photo: 'photo', writing: 'studio' };
  const ENV_ICONS = { code: 'fa-solid fa-code', photo: 'fa-solid fa-image', writing: 'fa-solid fa-feather-pointed' };
  const envOn = env => window.sections?.on(ENV_SWITCH[env]) !== false;
  // What Photo opens, among the files of a project.
  const PHOTO_FILE = /\.(png|jpe?g|webp|gif|bmp|tiff?|tga|ico|qoi|exr|hdr|avif|jxl|dng|cr2|cr3|nef|arw|pef|orf|rw2|raf|psd|psb|pcraft)$/i;
  // A chapter of a text, as the file it is kept in.
  const CHAPTER_FILE = /^capitoli\/([^/]+)\.json$/;
  // A file asked of the code editor before it was up.
  let pendingFile = null;
  // The workbench of a folder project has loaded and hears the files it is named (it says so itself).
  let workbenchReady = false;
  // What an editor has open, as the bar shows it: its files (by their place in the project, with whether each has
  // unsaved changes), the one in view, the zoom as a percentage.
  const NOTHING_OPEN = { files: [], shown: null, zoom: null };
  // What the code editor has open: it says so itself, whenever it changes.
  let codeBar = NOTHING_OPEN;
  // What the editor in view has open: what the bar is drawn from.
  let bar = NOTHING_OPEN;
  // The file the bar is giving another name to: opened again under the new one.
  let renaming = null;
  // What the bar asked of the workbench and is waiting to hear done.
  const asked = new Map();
  // Commands of the model still running in the editor's terminal. If this page
  // goes away (reload, app closing), nobody is left to read their result: they
  // are interrupted instead of running on unseen.
  const runningCommands = new Set();
  window.addEventListener('pagehide', () => {
    for (const id of runningCommands) window.__TAURI__?.core?.invoke('code_stop_command', { id }).catch(() => {});
  });
  // The folder the editor webview currently holds.
  let loadedFolder = null;
  // The container project whose editor is running on the canvas.
  let canvasProject = null;
  // The open project's git state, as the bar and its buttons read it.
  let git = null;
  let gitBusy = false;
  // "A new branch", among the branches of a repository to pick from.
  const NEW_BRANCH = '\u0000new';
  // What git accepts as a branch name; the service checks again, this only spares a round trip.
  const BRANCH_NAME = /^(?!-)(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!\.)[A-Za-z0-9._\/-]{1,200}(?<!\/)(?<!\.)(?<!\.lock)$/;
  // The list of branches being shown, and which request it answers.
  let branchMenu = null;
  let menuSeq = 0;
  let syncTimer = null;
  // What the record said last, to tell when the files may have changed.
  let gitMark = '';
  // Saves arrive in bursts — one per keystroke with autosave on. The record is
  // written once the burst ends, so a commit is a piece of work and not a key.
  const CHECKPOINT_QUIET_MS = 1200;
  let checkpointTimer = null;
  let github = null;
  let githubPoll = null;
  // The open in flight: when it started, and whether its end is still to be announced.
  let openedAt = 0;
  let pendingReady = false;
  // What the column shows: the files, or the steps of the history (code-history.js). A step
  // pressed there is laid over what is open in the middle.
  let view = 'editor';
  let historyShown = false;

  const APPEARANCE_COLORS = ['--bg-app', '--bg-surface', '--bg-input', '--bg-header', '--bg-pill', '--bg-active',
    '--text-main', '--text-neutral', '--text-muted', '--primary', '--on-primary', '--border-subtle', '--border-default', '--line-color'];
  let colorProbe = null;

  // SideX reads only #rrggbb(aa); some tokens are color-mix(), so the browser resolves them first.
  function hexColor(value) {
    if (!value) return '';
    colorProbe ||= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
    colorProbe.clearRect(0, 0, 1, 1);
    colorProbe.fillStyle = '#000'; colorProbe.fillStyle = value;
    colorProbe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = colorProbe.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b, ...(a < 255 ? [a] : [])].map(n => n.toString(16).padStart(2, '0')).join('');
  }

  function appearance() {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const tokens = Object.fromEntries(APPEARANCE_COLORS.map(key => [key, hexColor(style.getPropertyValue(key).trim())]));
    for (const key of ['--font-sans', '--radius-sm']) tokens[key] = style.getPropertyValue(key).trim();
    return { mode: root.getAttribute('data-theme-mode'), tokens, locale: window.i18n?.currentLocale || 'it' };
  }

  function bounds() {
    const box = $('code-container').getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }

  // The editor is a native child webview painted above the page, so anything
  // the page opens on top of it has to hide it. The chat's media viewer is not
  // a dialog and has no backdrop of its own: it says so on the body, and an
  // artifact opened full screen from the panel would otherwise be painted over.
  function obscured() {
    return historyShown || document.body.classList.contains('lightbox-active')
      || !!document.querySelector('#modal-key-backdrop.open, #drawer-backdrop.open, dialog[open]');
  }

  async function sync() {
    pending = true;
    if (running) return;
    running = true;
    const status = $('code-status');
    const retry = $('code-retry');
    const progress = $('code-progress');
    try {
      while (pending) {
        pending = false;
        const invoke = window.__TAURI__?.core?.invoke;
        // The code editor is wanted while Code is what is in the middle.
        const wanted = active && project && project.env === 'code';
        // A container project's editor runs inside the container and reaches this
        // page as pixels on a canvas; only local projects use the embedded workbench.
        const isolated = project?.runtime?.kind === 'container';
        if (canvasProject && (!project || project.id !== canvasProject || !isolated)) {
          await window.codeCanvas.stop();
          canvasProject = null;
        }
        if (isolated) {
          if (created) await invoke?.('code_layout', { visible: false, bounds: null, appearance: null });
          if (wanted && canvasProject !== project.id) {
            status.textContent = t('code.phaseEditor');
            status.hidden = false;
            progress.hidden = false;
            retry.hidden = true;
            const starting = project.id;
            await window.codeCanvas.start($('code-container'), project.runtime, {
              title: project.name,
              files: state => { if (project?.id === starting) codeShows(state); },
              ended: detail => {
                if (canvasProject !== starting) return;
                canvasProject = null;
                status.hidden = false;
                progress.hidden = true;
                status.textContent = detail || t('code.editorEnded');
                retry.hidden = false;
              }
            });
            canvasProject = starting;
            status.hidden = true;
            progress.hidden = true;
            announceReady();
            deliverFile();
          } else if (wanted && view === 'editor') window.codeCanvas.focus();
          continue;
        }
        if (!invoke) {
          if (wanted) throw new Error(t('code.desktopRequired'));
          break;
        }
        if (wanted && !created) {
          status.textContent = t('code.loading');
          status.hidden = false;
          progress.hidden = false;
          retry.hidden = true;
          await invoke('code_initialize');
          if (!active || !project || project.env !== 'code') continue;
          workbenchReady = false;
          await invoke('code_create', { bounds: bounds(), appearance: appearance(), folder: project.folder, runtime: project.runtime });
          created = true;
          loadedFolder = project.folder;
        }
        if (created) {
          if (wanted && loadedFolder !== project.folder) {
            workbenchReady = false;
            await invoke('code_open', { folder: project.folder, runtime: project.runtime });
            loadedFolder = project.folder;
          }
          // Read again here: the awaits above can take seconds (container start,
          // project switch) and the user may have left the Code tab meanwhile.
          const visible = Boolean(active && project && project.env === 'code') && !obscured();
          await invoke('code_layout', { visible, bounds: visible ? bounds() : null,
            appearance: visible ? appearance() : null });
          if (visible) { status.hidden = true; progress.hidden = true; announceReady(); deliverFile(); }
        }
      }
    } catch (error) {
      pendingReady = false;
      status.hidden = false;
      progress.hidden = true;
      status.textContent = error.message || String(error);
      retry.hidden = false;
      // The editor is painted above the page: whatever failed, it must not stay
      // on top of a tab that is not Code.
      if (created && !(active && project)) {
        try { await window.__TAURI__?.core?.invoke('code_layout', { visible: false, bounds: null, appearance: null }); } catch {}
      }
    } finally { running = false; }
  }

  function el(tag, className, key, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (key) { node.setAttribute('data-i18n', key); node.textContent = t(key); }
    else if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(className) {
    const node = document.createElement('i');
    node.className = className;
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function openExternal(url) {
    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) return invoke('plugin:shell|open', { path: url });
    window.open(url, '_blank', 'noopener');
    return Promise.resolve();
  }

  function showError(message) {
    $('code-projects-error').hidden = !message;
    $('code-projects-error-text').textContent = message || '';
  }

  function setBusy(value, message) {
    busy = value;
    $('code-projects-status').hidden = !value;
    $('code-progress-track').hidden = !value;
    $('code-projects-status-text').textContent = message || '';
  }

  // What the server is doing while `open` runs, in words. The page asks for the
  // step rather than guessing from the clock, so a long first start says which
  // part is long.
  const PHASE_KEYS = {
    opening: 'code.opening', engine: 'code.phaseEngine', image: 'code.phaseImage',
    container: 'code.phaseContainer', starting: 'code.phaseStarting', creating: 'code.phaseCreating',
    tools: 'code.phaseTools', git: 'code.phaseGit'
  };

  /** Polls the step of an open in flight; returns the function that stops it. */
  function followProgress(item) {
    let timer = null;
    let stopped = false;
    const tick = async () => {
      try {
        const state = await window.chatStorage.projectProgress(item.id);
        const key = state && PHASE_KEYS[state.phase];
        if (!stopped && key) $('code-projects-status-text').textContent = t(key, { name: item.container_name || item.name });
      } catch { /* whatever went wrong, the open itself is the one that reports it */ }
      if (!stopped) timer = setTimeout(tick, 900);
    };
    timer = setTimeout(tick, 400);
    return () => { stopped = true; clearTimeout(timer); };
  }

  /** The environment is up: say so once, and only when the wait was long enough to notice. */
  function announceReady() {
    if (!pendingReady) return;
    pendingReady = false;
    if (Date.now() - openedAt < 1500) return;
    window.playEnvironmentReady?.();
  }

  function render() {
    $('code-projects').hidden = Boolean(project);
    $('code-editor-shell').hidden = !project;
    if (!project) return;
    $('code-active-name').textContent = project.name;
    $('code-active-icon').className = KIND_ICONS[project.kind];
    const kind = $('code-active-kind');
    kind.setAttribute('data-i18n', KIND_LABELS[project.kind]);
    kind.textContent = t(KIND_LABELS[project.kind]);
    const isolated = project.runtime?.kind === 'container';
    $('code-active-isolated').hidden = !isolated;
    const missing = project.tools?.git === false ? ' ' + t('code.toolsMissing', { error: project.tools.error }) : '';
    $('code-active-isolated').title = isolated ? t('code.isolatedHint', { name: project.runtime.container }) + missing : '';
    $('code-active-isolated').classList.toggle('is-warning', Boolean(missing));
    renderEnv();
    renderPermissions();
    renderGit();
  }

  /* ---- the environments of the project, and the one in the middle ---- */

  const show = (id, on) => { const node = $(id); if (node) node.hidden = !on; };

  /** What is in the middle, with its functions over it and its toolbars under it; the others stay as they are, out of view. */
  function renderEnv() {
    if (!project) return;
    const env = project.env;
    document.querySelector('.proj-center').dataset.env = env || '';
    show('code-container', env === 'code');
    show('studio-pane-photo', env === 'photo');
    show('studio-pane-text', env === 'writing');
    show('proj-fn-photo', env === 'photo');
    show('proj-fn-writing', env === 'writing');
    show('proj-tb-writing', env === 'writing');
    // With one environment, and none of its own functions, the row over the open files has nothing to hold.
    show('proj-functions', project.envs.length > 1 || env === 'photo' || env === 'writing');
    const tabs = $('proj-envs');
    tabs.hidden = project.envs.length < 2;
    tabs.replaceChildren(...project.envs.map(name => {
      const tab = el('button', `proj-env${name === env ? ' is-active' : ''}`);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(name === env));
      tab.append(icon(ENV_ICONS[name]), el('span', '', `lab.env.${name}`));
      tab.addEventListener('click', () => void setEnv(name));
      return tab;
    }));
    // The code and its terminal have a permission each; where there is no code, one permission is all there is.
    const coded = project.envs.includes('code');
    $('code-perm-code-label').setAttribute('data-i18n', coded ? 'code.permCode' : 'proj.permChanges');
    $('code-perm-code-label').textContent = t(coded ? 'code.permCode' : 'proj.permChanges');
    $('code-perm-terminal-wrap').hidden = !coded;
  }

  /* ---- what is open in the editor in view: its files as tabs, and what every editor has ---- */

  /** The file in the middle, by its place in the project: each editor says its own. */
  function fileShown() {
    return project ? bar.shown : null;
  }

  /** Asks the editor in view what it has open, and draws the bar from it. The code editor says it on its own. */
  async function readBar() {
    if (!project) { bar = NOTHING_OPEN; renderFile(); return; }
    const id = project.id, env = project.env;
    let next = NOTHING_OPEN;
    try {
      if (env === 'code') next = codeBar;
      else if (env === 'photo') next = (await window.photo?.bar?.()) || NOTHING_OPEN;
      else if (env === 'writing') next = window.studio?.bar?.() || NOTHING_OPEN;
    } catch { /* an editor that cannot answer now has nothing to show */ }
    if (!project || project.id !== id || project.env !== env) return;
    bar = next;
    // In a pod's project what the photo editor and the texts show is an artifact, not a file of the column.
    window.projectTree.select(project.runtime?.kind === 'container' && env !== 'code' ? null : bar.shown);
    renderFile();
    window.projectShelf.refresh();
  }

  // The photo editor does not say when its documents change: it is asked again a moment after it was used.
  let barTimer = 0;
  function readBarSoon() {
    clearTimeout(barTimer);
    barTimer = setTimeout(() => void readBar(), 250);
  }

  function renderFile() {
    const tabs = $('proj-tabs');
    const env = project?.env;
    if (!bar.files.length) {
      const none = el('span', 'proj-tabs-empty', 'proj.fileNone');
      tabs.replaceChildren(none);
    } else {
      tabs.replaceChildren(...bar.files.map(file => {
        const tab = el('div', `proj-tab${file.path === bar.shown ? ' is-active' : ''}`);
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(file.path === bar.shown));
        tab.tabIndex = 0;
        tab.title = file.path;
        if (file.dirty) tab.append(el('span', 'proj-tab-dot'));
        tab.append(el('span', 'proj-tab-name', null, file.name || file.path.slice(file.path.lastIndexOf('/') + 1)));
        // Brought to view by the editor that has it open: a document of the photo editor may have no file yet.
        const show = () => { if (file.path === bar.shown) return; if (env === 'photo') void window.photo.open(file.path); else void openFile(file.path); };
        tab.addEventListener('click', show);
        tab.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(); } });
        // The middle button closes, as on the tabs of an editor.
        tab.addEventListener('auxclick', event => { if (event.button === 1 && !file.fixed) { event.preventDefault(); void fileClose(file.path); } });
        if (!file.fixed) {
          const close = el('button', 'proj-tab-close');
          close.type = 'button';
          close.title = t('proj.fileClose');
          close.setAttribute('aria-label', t('proj.fileClose'));
          close.append(icon('fa-solid fa-xmark'));
          close.addEventListener('click', event => { event.stopPropagation(); void fileClose(file.path); });
          tab.append(close);
        }
        return tab;
      }));
      tabs.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    const path = fileShown();
    for (const id of ['proj-file-rename', 'proj-file-save', 'proj-file-undo', 'proj-file-redo']) $(id).disabled = !path;
    // A chapter is not a file to copy, and a document of the photo editor is not born empty.
    $('proj-file-save-as').disabled = !path || env === 'writing';
    $('proj-file-new').disabled = !project || env === 'photo';
    // The code has nothing to export yet: how it is built is to be said per project.
    $('proj-file-export').disabled = !path || env === 'code';
    const zoomed = bar.zoom !== null && bar.zoom !== undefined;
    $('proj-file-zoom').textContent = zoomed ? `${bar.zoom}%` : '';
    for (const id of ['proj-file-zoom-out', 'proj-file-zoom-in', 'proj-file-zoom-fit']) $(id).disabled = !zoomed;
    // The editor of a pod has nothing to set but the size of its text, which is the zoom here.
    const settings = $('proj-file-settings');
    const none = !project || (env === 'code' && project.runtime?.kind === 'container');
    settings.disabled = none;
    settings.title = t(none && project ? 'proj.fileSettingsNone' : 'proj.fileSettings');
  }

  /** The code editor says what it has open: drawn in the bar, the file in view marked in the column. */
  function codeShows(state) {
    codeBar = state;
    if (project?.env !== 'code') return;
    bar = codeBar;
    window.projectTree.select(bar.shown);
    renderFile();
  }

  /** A file of a folder project, from its place on this computer to its place in the project; null outside it. */
  function inProject(absolute) {
    if (!absolute || !project?.folder) return null;
    const flat = value => value.replace(/\\/g, '/');
    const root = flat(project.folder).replace(/\/+$/, ''), full = flat(absolute);
    return full.toLowerCase().startsWith(root.toLowerCase() + '/') ? full.slice(root.length + 1) : null;
  }

  /** A file of a folder project, from its place in the project to its place on this computer. */
  function onComputer(path) {
    const separator = project.folder.includes('\\') ? '\\' : '/';
    return project.folder.replace(/[\\/]+$/, '') + separator + path.split('/').join(separator);
  }

  /** Asks the workbench of a folder project for something of the bar's; over when it says so. */
  function askWorkbench(what, path = null) {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke || !created || !workbenchReady) return Promise.resolve();
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const end = () => { clearTimeout(timer); asked.delete(id); resolve(); };
      const timer = setTimeout(end, 10000);
      asked.set(id, end);
      invoke('code_do', { what, id, path }).catch(end);
    });
  }

  /** 'save', 'undo' or 'redo' on the file in view, by the editor that shows it. */
  async function fileDo(what) {
    if (!project || !fileShown()) return;
    try {
      if (project.env === 'writing') {
        if (what === 'save') await window.studio.save();
        else { $('studio-draft').focus(); document.execCommand(what); }
      } else if (project.env === 'photo') await window.photo[what]();
      else if (project.runtime?.kind === 'container') {
        if (what === 'save') await window.codeCanvas.saveAll();
        else { window.codeCanvas.perform(what); window.codeCanvas.focus(); }
      } else await askWorkbench(what);
      viewerNote('');
    } catch (error) { viewerNote(error.message || String(error)); }
    if (project?.env !== 'code') void readBar();
  }

  /** 'zoomIn', 'zoomOut', or 'zoomReset' — the size the editor starts with, or for a picture the whole of it in view. */
  async function fileZoom(what) {
    if (!project) return;
    try {
      if (project.env === 'writing') window.studio.zoom(what);
      else if (project.env === 'photo') await window.photo.zoom(what);
      else if (project.runtime?.kind === 'container') window.codeCanvas.perform(what);
      else await askWorkbench(what);
    } catch (error) { viewerNote(error.message || String(error)); }
    if (project?.env !== 'code') void readBar();
  }

  /** The settings of the editor in view: its own, opened by it. */
  async function fileSettings() {
    if (!project) return;
    try {
      if (project.env === 'writing') await window.studio.settings();
      else if (project.env === 'photo') await window.photo.settings();
      else if (project.runtime?.kind !== 'container') await askWorkbench('settings');
      viewerNote('');
    } catch (error) { viewerNote(error.message || String(error)); }
  }

  /** Closes an open file, as the cross of its tab in its own editor would: unsaved changes are asked about, by the editor or here. */
  async function fileClose(path) {
    if (!project) return;
    try {
      if (project.env === 'photo') await window.photo.close(path);
      else if (project.env === 'code' && project.runtime?.kind === 'container') window.codeCanvas.closeFile(path);
      else if (project.env === 'code') await askWorkbench('close', onComputer(path));
    } catch (error) { viewerNote(error.message || String(error)); }
    if (project?.env !== 'code') void readBar();
  }

  /**
   * Export: the finished file made from what is in view. A text chooses its format; a picture is shown as it will be
   * written, with the name it takes, and written in the folder of the project once confirmed.
   */
  let exporting = null;
  async function fileExport() {
    if (!project || !fileShown()) return;
    if (project.env === 'writing') { window.studio.exportDialog(); return; }
    if (project.env !== 'photo') return;
    try {
      const made = await window.photo.exportImage();
      if (!made) return;
      if (exporting?.url) URL.revokeObjectURL(exporting.url);
      exporting = { bytes: made.bytes, url: URL.createObjectURL(new Blob([made.bytes], { type: 'image/png' })) };
      const image = $('proj-export-image');
      const size = $('proj-export-size');
      size.textContent = '';
      image.onload = () => {
        const bytes = made.bytes.length;
        size.textContent = t('proj.exportSize', { width: image.naturalWidth, height: image.naturalHeight, size: bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB` });
      };
      image.src = exporting.url;
      $('proj-export-name').value = made.name;
      $('proj-export-error').textContent = '';
      $('proj-export-confirm').disabled = false;
      $('proj-export-dialog').showModal();
      $('proj-export-name').select();
    } catch (error) { viewerNote(error.message || String(error)); }
  }

  async function submitExport(event) {
    event.preventDefault();
    if (!exporting || !project) return;
    const name = $('proj-export-name').value.trim();
    if (!/^[^\\/]+\.png$/i.test(name)) { $('proj-export-error').textContent = t('proj.exportNameInvalid'); return; }
    $('proj-export-confirm').disabled = true;
    try {
      await window.photo.exportWrite(name, exporting.bytes);
      closeExport();
      window.projectTree.refresh();
      void refreshGit();
    } catch (error) {
      $('proj-export-error').textContent = error.message || String(error);
      $('proj-export-confirm').disabled = false;
    }
  }

  function closeExport() {
    $('proj-export-dialog').close();
    if (exporting?.url) URL.revokeObjectURL(exporting.url);
    exporting = null;
    $('proj-export-image').removeAttribute('src');
  }

  /** A new file beside the one in view, its name written in the column; in a text, a new chapter. */
  function fileNew() {
    if (!project) return;
    if (project.env === 'writing') { window.studio.addChapter(); return; }
    const path = fileShown();
    openSide(true);
    window.projectShelf.showFiles();
    $('proj-search').value = '';
    window.projectTree.newFile(path && path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
  }

  /** Another name for the file in view, or a copy of it under another name: what is in the editor is written first, the name is asked in the column. */
  async function fileName(copy) {
    const path = fileShown();
    if (!project || !path) return;
    if (project.env === 'writing') { if (!copy) window.studio.renameChapter(); return; }
    const id = project.id;
    await fileDo('save');
    if (project?.id !== id) return;
    // An artifact kept apart from the project's files has its name among the artifacts, not among the files.
    if (project.runtime?.kind === 'container' && project.env !== 'code') {
      openSide(true);
      if (copy) window.projectShelf.copyAs(path); else window.projectShelf.rename(path);
      return;
    }
    openSide(true);
    window.projectShelf.showFiles();
    $('proj-search').value = '';
    if (copy) window.projectTree.copyAs(path);
    else { renaming = path; window.projectTree.rename(path); }
  }

  /** The project as a zip of its last recorded step, saved where downloads go. */
  async function exportZip() {
    if (!project) return;
    const button = $('proj-btn-zip');
    const name = project.name;
    button.disabled = true;
    try {
      const bytes = await window.chatStorage.projectArchive(project.id);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      link.download = `${String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'progetto'}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 60000);
      viewerNote('');
    } catch (error) { viewerNote(error.message || String(error)); }
    finally { button.disabled = false; }
  }

  /**
   * A column beside what is open, as wide as its handle is dragged: kept in pixels on this computer, never so wide
   * that the middle is left with too little. `fromLeft` for the column of the files, measured from the left edge;
   * the chat is measured from the right one.
   */
  const MIDDLE_MIN = 560;
  function bindResizer(handle, { key, variable, min, max, start, fromLeft, other }) {
    const shell = $('code-editor-shell');
    let width = start;
    try { const kept = Number(localStorage.getItem(key)); if (kept >= min && kept <= max) width = kept; } catch {}
    const apply = () => {
      shell.style.setProperty(variable, `${Math.round(width)}px`);
      handle.setAttribute('aria-valuemin', min);
      handle.setAttribute('aria-valuemax', max);
      handle.setAttribute('aria-valuenow', Math.round(width));
    };
    const keep = () => { try { localStorage.setItem(key, String(Math.round(width))); } catch {} void sync(); };
    const limit = value => {
      const room = shell.getBoundingClientRect().width - other().getBoundingClientRect().width - MIDDLE_MIN;
      return Math.max(min, Math.min(value, max, Math.max(min, room)));
    };
    apply();
    handle.tabIndex = 0;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('is-dragging');
      const box = shell.getBoundingClientRect();
      const move = e => { width = limit(fromLeft ? e.clientX - box.left : box.right - e.clientX); apply(); };
      const end = () => {
        handle.classList.remove('is-dragging');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        keep();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
    handle.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      width = limit(width + ((event.key === 'ArrowRight') === fromLeft ? 16 : -16));
      apply();
      keep();
    });
  }

  /** The column of the files open, or closed to a strip with its button alone. */
  function openSide(open) {
    const side = $('proj-side');
    if (side.classList.contains('is-closed') === !open) return;
    side.classList.toggle('is-closed', !open);
    const button = $('proj-side-close');
    button.setAttribute('aria-expanded', String(open));
    button.querySelector('i').className = open ? 'fa-solid fa-chevron-left' : 'fa-solid fa-chevron-right';
    try { localStorage.setItem(SIDE_CLOSED_KEY, open ? '0' : '1'); } catch {}
    // The editor is painted over its container: it has to be told the new size.
    void sync();
  }

  function viewerNote(text) {
    const note = $('proj-viewer-note');
    note.hidden = !text;
    note.textContent = text || '';
  }

  /** Brings an environment of the project to the middle; the one that was there keeps its state, out of view. */
  async function setEnv(next) {
    if (!project || !project.envs.includes(next)) return false;
    const id = project.id;
    const previous = project.env;
    if (previous !== next) {
      if (previous === 'writing') await window.studio?.setActive(false);
      if (previous === 'photo') await window.photo?.setActive(false);
      if (!project || project.id !== id) return false;
      project.env = next;
    }
    viewerNote('');
    if (view === 'history') setView('editor');
    renderEnv();
    // An environment reads the project the first time it is brought here.
    if (next === 'writing') { await window.studio.attach(id, project.name); await window.studio.setActive(active); }
    if (next === 'photo') { await window.photo.attach(id); await window.photo.setActive(active); }
    if (!project || project.id !== id) return false;
    await readBar();
    void sync();
    return true;
  }

  /** Which environment opens a file of the project, among those it has on. */
  function envOfFile(path) {
    if (project.envs.includes('writing') && (CHAPTER_FILE.test(path) || path === 'studio.json')) return 'writing';
    if (project.envs.includes('photo') && PHOTO_FILE.test(path)) return 'photo';
    if (project.envs.includes('code')) return 'code';
    return null;
  }

  /** A file pressed in the column: brought to the middle by the environment that opens it. */
  async function openFile(path, { artifact = false } = {}) {
    if (!project) return;
    const target = envOfFile(path);
    if (!target) { viewerNote(t(artifact ? 'shelf.noEditor' : 'proj.noEnvFor', { file: path })); return; }
    // In a pod's project the photo editor and the texts work on the artifacts, kept at this computer: a file of the
    // pod is not one of them, and one of them is not opened as code.
    const apart = project.runtime?.kind === 'container';
    if (apart && !artifact && target !== 'code') { viewerNote(t('shelf.inPod', { file: path })); return; }
    if (apart && artifact && target === 'code') { viewerNote(t('shelf.noEditor', { file: path })); return; }
    if (!(await setEnv(target))) return;
    if (target === 'writing') {
      const chapter = path.match(CHAPTER_FILE)?.[1];
      if (chapter) await window.studio.openChapter(chapter);
    } else if (target === 'photo') await window.photo.open(path);
    else { pendingFile = path; deliverFile(); }
  }

  /** The file asked of the code editor is handed to it once it is up: SideX by its place on this computer, the pod's editor by its place in the project. */
  function deliverFile() {
    if (!pendingFile || !project || project.env !== 'code') return;
    const path = pendingFile;
    if (project.runtime?.kind === 'container') {
      if (canvasProject !== project.id) return;
      pendingFile = null;
      window.codeCanvas.openFile(path);
      window.codeCanvas.focus();
      return;
    }
    if (!created || loadedFolder !== project.folder || !workbenchReady) return;
    pendingFile = null;
    window.__TAURI__?.core?.invoke('code_open_file', { path: onComputer(path) })
      .catch(error => viewerNote(error.message || String(error)));
  }

  /* ---- what the model may do without asking: two switches, per project ---- */

  const PERM_MODES = ['manual', 'semi', 'auto'];

  function permOptions(select, value) {
    select.replaceChildren(...PERM_MODES.map(mode => {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = t({ manual: 'code.permManual', semi: 'code.permSemi', auto: 'code.permAuto' }[mode] || 'code.permManual');
      option.selected = mode === value;
      return option;
    }));
  }

  function renderPermissions() {
    const group = $('code-perm-group');
    if (!project) { group.hidden = true; return; }
    group.hidden = false;
    const modes = project.modes || { code: 'manual', terminal: 'manual' };
    permOptions($('code-perm-code'), modes.code);
    permOptions($('code-perm-terminal'), modes.terminal);
    // Both kinds have a terminal for the model: the container's, or the editor's own on this machine.
    $('code-perm-terminal-wrap').hidden = false;
    $('code-perm-code').title = t('code.permCodeHint');
    $('code-perm-terminal').title = t('code.permTerminalHint');
    renderPlanSettings();
  }

  /* ---- the plan of this project's chats: started by the user or by itself, and how many times a point is tried ---- */

  async function renderPlanSettings() {
    const select = $('code-perm-plan');
    const tries = $('code-perm-plan-tries');
    if (!select || !tries || !project || !window.planMode) return;
    const id = project.id;
    const settings = await window.planMode.settings(id);
    if (!project || project.id !== id) return;
    select.replaceChildren(...['manual', 'auto'].map(mode => {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = t(mode === 'auto' ? 'plan.modeAuto' : 'plan.modeManual');
      option.selected = mode === settings.mode;
      return option;
    }));
    select.title = t('plan.modeHint');
    tries.value = String(settings.tries);
    tries.title = t('plan.triesHint');
  }

  async function setPlanSetting(change) {
    if (!project || !window.planMode) return;
    try { await window.planMode.setSettings(project.id, change); } catch (error) { showError(error.message); }
    void renderPlanSettings();
  }

  async function loadPermissions() {
    if (!project) return;
    try {
      const info = await window.chatStorage.projectApprovals(project.id);
      if (!project) return;
      project.modes = info.modes;
      renderPermissions();
    } catch (error) { showError(error.message); }
  }

  async function setPermission(kind, value) {
    if (!project) return;
    try {
      const updated = await window.chatStorage.setProjectPermissions(project.id, { [kind]: value });
      project.modes = { code: updated.perm_code || project.modes?.code || 'manual', terminal: updated.perm_terminal || project.modes?.terminal || 'manual' };
      await loadPermissions();
    } catch (error) { showError(error.message); void loadPermissions(); }
  }

  async function openPermDialog() {
    if (!project) return;
    const dialog = $('code-perm-dialog');
    const list = $('code-perm-items');
    list.replaceChildren();
    dialog.showModal();
    try {
      const info = await window.chatStorage.projectApprovals(project.id);
      list.replaceChildren();
      if (!info.remembered.length) {
        list.append(el('li', 'code-perm-empty', 'code.permListEmpty'));
        $('code-perm-forget-all').disabled = true;
        return;
      }
      $('code-perm-forget-all').disabled = false;
      for (const item of info.remembered) {
        const row = el('li', 'code-perm-item');
        const kind = el('span', 'code-kind-badge', item.kind === 'terminal' ? 'code.permKindTerminal' : 'code.permKindCode');
        const label = el('code', 'code-perm-key', null, item.label || item.key);
        const forget = el('button', 'btn code-perm-forget', 'code.permForget');
        forget.type = 'button';
        forget.addEventListener('click', async () => {
          try { await window.chatStorage.forgetApproval(project.id, item.id); await openPermDialog(); } catch (error) { showError(error.message); }
        });
        row.append(kind, label, forget);
        list.append(row);
      }
    } catch (error) { showError(error.message); }
  }

  /** The environments a project has on, as the service stores them; one made before they existed has the one its section stood for. */
  function envsOf(row) {
    let list = row.envs;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
    const known = Array.isArray(list) ? ENVS.filter(env => list.includes(env)) : [];
    return known.length ? known : [ENVS.find(env => ENV_SECTION[env] === row.section) || 'code'];
  }

  /** The project is left: each environment lets go of it (Photo asks first, when a document has unsaved changes). False when the user stays. */
  async function closeProject() {
    if (!project) return true;
    if (window.photo && !(await window.photo.detach())) return false;
    await window.studio?.detach();
    setView('editor');
    unmountChat();
    window.projectTree.close();
    window.projectShelf.close();
    $('proj-search').value = '';
    project = null;
    git = null;
    branchMenu = null;
    pendingFile = null;
    codeBar = NOTHING_OPEN;
    bar = NOTHING_OPEN;
    renaming = null;
    clearTimeout(syncTimer);
    viewerNote('');
    render();
    void sync();
    return true;
  }

  async function openProject(item) {
    if (busy) return;
    const message = item.repo ? t('code.preparingRepo', { repo: item.repo })
      : item.kind === 'podman' ? t('code.startingContainer', { name: item.container_name })
      : t('code.opening');
    setBusy(true, message);
    openedAt = Date.now();
    pendingReady = true;
    const stopFollowing = followProgress(item);
    try {
      const result = await window.chatStorage.openProject(item.id);
      showError('');
      const opened = result.project;
      // The environments whose section is on; the first of them is what the project opens on.
      const envs = envsOf(opened).filter(envOn);
      if (!envs.length) throw new Error(t('proj.sectionsOff'));
      project = { id: opened.id, name: opened.name, kind: opened.kind, repo: opened.repo, folder: result.folder, runtime: result.runtime, tools: result.container?.tools, modes: null, envs, env: null };
      git = result.git || null;
      setView('editor');
      render();
      void loadPermissions();
      void window.projectTree.open($('proj-tree'), {
        id: project.id, kind: project.kind,
        onOpen: path => void openFile(path),
        onPlaced: (file, to) => { viewerNote(t('shelf.placed', { file, to })); void refreshGit(); },
        // What is done to the files in the column is a step of the record: the bar catches up.
        onChanged: done => {
          if (done?.git && done.git.ready !== undefined) { git = done.git; renderGit(); } else void refreshGit();
          // The file in view has another name: it is in view under that one.
          if (done?.action === 'rename' && project?.env !== 'writing' && (done.path === renaming || done.path === fileShown())) void openFile(done.to);
          renaming = null;
        },
        onError: text => { const note = $('proj-tree-error'); note.hidden = !text; note.textContent = text || ''; }
      });
      window.projectShelf.open({
        id: project.id,
        onOpen: path => void openFile(path, { artifact: true }),
        onError: text => viewerNote(text),
        // The history is a view of the files' tab: entering the artifacts puts it away.
        onTab: on => { if (on && view === 'history') setView('editor'); }
      });
      await mountChat();
      await setEnv(envs[0]);
    } catch (error) {
      pendingReady = false;
      project = null;
      render();
      showError(error.message);
    } finally { stopFollowing(); setBusy(false); }
  }

  /**
   * The editor or the history, over the same area. The history is laid over a
   * container project's canvas rather than taking its place, so the editor and
   * its terminals keep their size and keep running underneath.
   */
  function setView(next) {
    view = next === 'history' && project ? 'history' : 'editor';
    const history = view === 'history';
    $('proj-btn-history').setAttribute('aria-pressed', String(history));
    // The steps take the place of the files in the column; the middle stays as it is until one is pressed.
    $('proj-history-list').hidden = !history;
    $('proj-tree').hidden = history;
    document.querySelector('.proj-side-top').hidden = history;
    if (!history) { historyShown = false; $('code-history').hidden = true; }
    if (history && active) void window.codeHistory.open(project.id);
    else window.codeHistory.close();
    publishBranch();
    void sync();
  }

  async function backToProjects() {
    if (busy || !(await closeProject())) return;
    window.lab?.show();
  }

  // --- the project's AI ----------------------------------------------------

  /**
   * The panel beside the editor is the chat itself, moved here.
   *
   * Not a copy: the same element, the same ChatManager, the same streaming and
   * the same history. It comes in when a project is open on the Code tab and
   * goes back where it was on the way out, so the Chat tab always finds it.
   * What changes is which conversation it holds — one of the project's own,
   * which is what gives it the file tools.
   */
  let chatHome = null;
  let generalChat = null;

  function chatElement() {
    return document.querySelector('.conversation-workspace');
  }

  async function mountChat() {
    const workspace = chatElement();
    if (!workspace || chatHome) return;
    // Where to put it back, exactly: the Chat tab must not notice it left.
    chatHome = { parent: workspace.parentNode, next: workspace.nextSibling };
    generalChat = window.chatManager?.conversation?.id || null;
    $('code-chat-mount').append(workspace);
    await loadProjectChats();
  }

  function unmountChat() {
    if (!chatHome) return;
    const workspace = chatElement();
    if (workspace) chatHome.parent.insertBefore(workspace, chatHome.next);
    chatHome = null;
    // The Chat tab goes back to the conversation it was on, not to the
    // project's, which belongs here.
    const previous = generalChat;
    generalChat = null;
    if (previous) void window.chatManager?.selectConversation(previous);
  }

  async function loadProjectChats(select = null) {
    if (!project) return;
    const list = $('code-chat-select');
    try {
      let chats = await window.chatStorage.listProjectChats(project.id);
      if (!chats.length) {
        // A project always has somewhere to talk: the first chat is made here.
        // Named as a chat and not after the project — which project it is, is
        // not a choice: it is the one open, and the bar above already says so.
        chats = [await window.chatStorage.create(project.id, t('code.aiChatName', { n: 1 }))];
      }
      list.replaceChildren();
      for (const chat of chats) {
        const option = el('option', '', null, chat.title);
        option.value = chat.id;
        list.append(option);
      }
      const wanted = select && chats.some(chat => chat.id === select) ? select : chats[0].id;
      list.value = wanted;
      if (window.chatManager?.conversation?.id !== wanted) await window.chatManager?.selectConversation(wanted);
    } catch (error) {
      showError(error.message);
    }
  }

  async function newProjectChat() {
    if (!project) return;
    try {
      const next = $('code-chat-select').options.length + 1;
      const chat = await window.chatStorage.create(project.id, t('code.aiChatName', { n: next }));
      await loadProjectChats(chat.id);
      document.getElementById('chat-input')?.focus();
    } catch (error) { showError(error.message); }
  }

  /**
   * The chat is closed to a strip and opened again by its own button, as the
   * column of the chats is: closed, the strip is that button alone. The strip
   * is beside the editor, never over it — a folder project paints a native
   * webview above the page, and a button under that would be gone for good.
   */
  const CHAT_CLOSED_KEY = 'synthorg_project_chat_closed';
  const SIDE_CLOSED_KEY = 'synthorg_project_files_closed';

  function toggleAi(visible) {
    $('code-ai-panel').classList.toggle('is-closed', !visible);
    const button = $('code-ai-close');
    button.setAttribute('aria-expanded', String(visible));
    button.querySelector('i').className = visible ? 'fa-solid fa-chevron-right' : 'fa-solid fa-chevron-left';
    try { localStorage.setItem(CHAT_CLOSED_KEY, visible ? '0' : '1'); } catch {}
    // The editor is painted over its container: it has to be told the new size.
    void sync();
  }

  // --- git on the open project ---------------------------------------------

  /**
   * The bar of an open project. Git records on its own, so there is nothing
   * here to press in order to save. What a linked repository adds — the branch,
   * download, upload — is in the strip over the file tree (see below).
   */
  function renderGit() {
    const actions = $('code-git-actions');
    const s = (project && git) || {};
    // Under the name only what is not as it should be: changes not recorded yet, or what git could not do.
    actions.hidden = !project || !(s.changes || s.error);
    if (!project) { publishBranch(); return; }
    $('code-active-branch').hidden = !s.branch;
    $('code-active-branch-name').textContent = s.branch || '';
    $('code-active-branch').title = s.last
      ? t('code.gitLastHint', { message: s.last.message, source: t(s.last.source === 'agent' ? 'code.gitSourceAgent' : 'code.gitSourceUser') })
      : '';
    // How many steps the history holds, on the button that opens it.
    $('proj-history-count').textContent = s.commits ? String(s.commits) : '';
    // Work that is not in the history yet is the exception now, not the rule:
    // it shows while a burst of saves is still being gathered, or when git
    // could not record.
    $('code-git-changes').hidden = !s.changes;
    $('code-git-changes-text').textContent = t('code.gitPending', { count: s.changes || 0 });
    $('code-git-error').hidden = !s.error;
    $('code-git-error').textContent = s.error || '';
    $('code-git-error').title = s.error || '';
    $('code-git-repo').disabled = gitBusy;
    publishBranch();
    followSync();
    // A step recorded is files changed: the column reads them again.
    const mark = `${s.commits || 0}:${s.changes || 0}:${s.branch || ''}`;
    if (mark !== gitMark) { gitMark = mark; window.projectTree.refresh(); }
  }

  async function refreshGit() {
    if (!project) return;
    try { git = await window.chatStorage.projectGit(project.id); }
    catch (error) { git = { ready: false, error: error.message }; }
    renderGit();
  }

  /**
   * Git records nothing by itself: the desktop says when the editor has
   * written, the burst of saves is gathered, and what is on disk is committed
   * once. Quiet on purpose — it is a record being kept, not an action.
   */
  function noteChange() {
    if (!project) return;
    clearTimeout(checkpointTimer);
    checkpointTimer = setTimeout(() => void checkpoint(), CHECKPOINT_QUIET_MS);
  }

  async function checkpoint() {
    if (!project) return;
    // A button in flight records anyway on its way: let it, and come back.
    if (gitBusy) { noteChange(); return; }
    try { git = await window.chatStorage.projectGitAction(project.id, 'checkpoint', {}); }
    catch (error) { git = { ...(git || {}), error: error.message }; }
    renderGit();
  }

  /** Every git button goes through here, so one failure never leaves a dead bar. */
  async function runGit(action, input = {}) {
    if (!project || gitBusy) return null;
    gitBusy = true;
    renderGit();
    try {
      const result = await window.chatStorage.projectGitAction(project.id, action, input);
      const status = result && result.ready !== undefined ? result : null;
      if (status) {
        git = status;
        project.repo = status.repo || null;
      }
      return result;
    } catch (error) {
      git = { ...(git || {}), error: error.message };
      return null;
    } finally {
      gitBusy = false;
      renderGit();
    }
  }

  // --- the branch strip: the branch here and the branch on GitHub -----------

  /**
   * A linked project has a strip over its file tree: the branch it is on,
   * the steps to download and to upload, and the switch that makes this branch
   * sync on its own. The state and every action are this page's. A local
   * project shows the strip inside its workbench (synthorgBranch.ts), which is
   * told the state and says what was pressed; a container project's editor is
   * pixels, so the strip is drawn here, in the room the editor leaves for it.
   */
  function branchState() {
    const s = git || {};
    if (!project || !s.repo || !s.ready || !s.branch) return { visible: false };
    const full = s.mode === 'full';
    const error = s.error || s.sync?.error || null;
    const note = s.diverged ? '' : !s.asked ? t('code.branchNoteUnknown')
      : !s.onGithub ? t('code.branchNoteNew') : (!s.unpushed && !s.behind ? t('code.branchNoteEven') : '');
    return {
      visible: true,
      mode: full ? 'full' : 'branch',
      branch: s.branch,
      // Before GitHub has been asked, how many steps it lacks is not known: no number is shown.
      unpushed: s.asked ? s.unpushed || 0 : 0,
      behind: s.behind || 0,
      diverged: Boolean(s.diverged),
      auto: Boolean(s.auto),
      busy: gitBusy || Boolean(s.sync?.busy),
      canPull: true,
      canPush: Boolean(s.born) && !s.diverged && (!s.onGithub || s.unpushed > 0),
      error,
      text: {
        branchTitle: t(full ? 'code.branchTitleFull' : 'code.branchTitleSingle', { repo: s.repo }),
        pull: t('code.branchPull'),
        pullTitle: s.behind ? t('code.branchPullCount', { count: s.behind, branch: s.branch }) : t('code.branchPullTitle', { branch: s.branch }),
        push: t('code.branchPush'),
        pushTitle: !s.asked ? t('code.branchPushUnknown', { branch: s.branch })
          : !s.onGithub ? t('code.branchPushNew', { branch: s.branch })
          : s.unpushed ? t('code.branchPushCount', { count: s.unpushed, branch: s.branch }) : t('code.branchPushNone', { branch: s.branch }),
        autoTitle: t(s.auto ? 'code.branchAutoOn' : 'code.branchAutoOff', { branch: s.branch }),
        diverged: t('code.branchDiverged'),
        note,
        pickPlaceholder: t('code.branchPick'),
        newBranch: t('code.branchNewOption'),
        newBranchPrompt: t('code.branchNewPrompt', { branch: s.branch }),
        newBranchPlaceholder: t('code.branchNewPlaceholder'),
        invalidName: t('code.branchInvalid')
      },
      menu: branchMenu
    };
  }

  function publishBranch() {
    renderBranchHead(branchState());
    renderPush();
  }

  /** "Carica", under the files: the steps made here sent to GitHub; with no repository yet, choosing one comes first. */
  function renderPush() {
    const button = $('proj-btn-push');
    const s = git || {};
    const state = branchState();
    button.disabled = !project || gitBusy || Boolean(s.sync?.busy) || (state.visible && !state.canPush);
    button.title = !project ? '' : state.visible ? state.text.pushTitle : t(s.repo ? 'code.branchNoteUnknown' : 'proj.pushNoRepo');
    $('proj-push-count').textContent = state.visible && state.unpushed ? String(state.unpushed) : '';
  }

  async function pushFromColumn() {
    if (!project) return;
    if (!git?.repo) { openRepoDialog(); return; }
    await saveEditors();
    await branchCommand({ type: 'push' });
  }

  /** The strip of a linked project, over its files: the branch, whether it syncs on its own, download. */
  function renderBranchHead(state) {
    const head = $('code-branch-head');
    head.hidden = !state.visible;
    if (!state.visible) { closeBranchMenu(); return; }
    head.classList.toggle('is-busy', state.busy);
    $('code-branch-name-text').textContent = state.branch;
    $('code-branch-name').title = state.text.branchTitle;
    $('code-branch-chevron').hidden = state.mode !== 'full';
    const auto = $('code-branch-auto');
    auto.title = state.text.autoTitle;
    auto.setAttribute('aria-label', state.text.autoTitle);
    auto.setAttribute('aria-pressed', String(state.auto));
    auto.disabled = state.busy;
    $('code-branch-pull-text').textContent = state.text.pull;
    $('code-branch-pull').title = state.text.pullTitle;
    $('code-branch-pull-count').textContent = state.behind ? String(state.behind) : '';
    $('code-branch-pull').disabled = state.busy || !state.canPull;
    $('code-branch-diverged').hidden = !state.diverged;
    $('code-branch-diverged-text').textContent = state.text.diverged;
    $('code-branch-diverged').disabled = state.busy;
    const note = $('code-branch-note');
    note.textContent = state.error || state.text.note;
    note.title = state.error || '';
    note.classList.toggle('is-error', Boolean(state.error));
    note.hidden = !note.textContent;
    renderBranchMenu(state);
  }

  /** Download and upload move files on disk: what is only in an editor is written first. */
  async function saveEditors() {
    if (project?.runtime?.kind === 'container' && canvasProject === project.id) await window.codeCanvas.saveAll();
    if (project?.env === 'writing') await window.studio?.setActive(true);
  }

  /** What the strip asks for, whichever of the two draws it. */
  async function branchCommand(command) {
    if (!project || !command || typeof command !== 'object') return;
    switch (command.type) {
      // The workbench was (re)loaded: it has no state yet, and no list to bring back.
      case 'ready': branchMenu = null; publishBranch(); break;
      case 'menu': await openBranchMenu(); break;
      case 'repo': openRepoDialog(); break;
      case 'resolve': openDivergedDialog(); break;
      case 'auto': await runGit('sync', { auto: Boolean(command.auto) }); break;
      case 'pull': {
        const result = await runGit('pull');
        if (result?.diverged) openDivergedDialog();
        break;
      }
      case 'push': {
        const result = await runGit('push');
        if (result?.diverged) openDivergedDialog();
        break;
      }
      case 'switch': branchMenu = null; await runGit('switch', { branch: String(command.branch || '') }); break;
      case 'new-branch': branchMenu = null; await runGit('new-branch', { name: String(command.name || '') }); break;
      default: break;
    }
  }

  /**
   * A branch that syncs on its own uploads a moment after each step: while
   * that is pending the status is asked again, so the strip shows it done
   * without anything being pressed. It stops at an error or a difference.
   */
  function followSync() {
    clearTimeout(syncTimer);
    const s = git || {};
    if (!project || !s.auto || s.sync?.error || s.diverged || gitBusy) return;
    if (s.sync?.busy || s.unpushed > 0) syncTimer = setTimeout(() => void refreshGit(), 2500);
  }

  // --- the list of branches (whole repository) ------------------------------

  function branchDetail(item) {
    const parts = [];
    if (item.current) parts.push(t('code.branchCurrent'));
    if (item.main) parts.push(t('code.branchMain'));
    if (!item.local) parts.push(t('code.branchOnlyGithub'));
    else if (!item.onGithub) parts.push(t('code.branchOnlyHere'));
    else if (item.unpushed || item.behind) parts.push([item.behind ? `↓${item.behind}` : '', item.unpushed ? `↑${item.unpushed}` : ''].filter(Boolean).join(' '));
    if (item.auto) parts.push(t('code.branchAuto'));
    return parts.join(' · ');
  }

  /** First what is known here, at once; then the same list after asking GitHub. */
  async function openBranchMenu() {
    if (!project || git?.mode !== 'full') return;
    const id = ++menuSeq;
    const opened = project.id;
    branchMenu = { id, loading: true, items: [{ name: git.branch, current: true, detail: t('code.branchCurrent') }] };
    publishBranch();
    for (const fetch of [false, true]) {
      let listed = null;
      try { listed = await window.chatStorage.projectGitAction(opened, 'branches', { fetch }); }
      catch (error) { if (fetch) { git = { ...(git || {}), error: error.message }; } }
      if (project?.id !== opened || branchMenu?.id !== id) return;
      if (listed) branchMenu = { id, loading: !fetch, items: listed.branches.map(item => ({ name: item.name, current: item.current, detail: branchDetail(item) })) };
      else if (fetch) branchMenu = { ...branchMenu, loading: false };
      publishBranch();
    }
    // GitHub was just asked: the counts of the branch in the editor may have changed.
    void refreshGit();
  }

  async function submitNewBranch(event) {
    event.preventDefault();
    const name = $('code-branch-new-name').value.trim();
    const error = $('code-branch-menu-error');
    if (!BRANCH_NAME.test(name) || name === 'HEAD') { error.textContent = t('code.branchInvalid'); return; }
    error.textContent = '';
    await saveEditors();
    await branchCommand({ type: 'new-branch', name });
  }

  function closeBranchMenu() {
    const menu = $('code-branch-menu');
    if (menu.hidden) return;
    menu.hidden = true;
    menu.dataset.id = '';
    branchMenu = null;
  }

  /** The list of the branches, under the strip. */
  function renderBranchMenu(state) {
    const menu = $('code-branch-menu');
    if (!state.menu) { menu.hidden = true; menu.dataset.id = ''; return; }
    const head = $('code-branch-head');
    if (menu.dataset.id !== String(state.menu.id)) {
      $('code-branch-new-name').value = '';
      $('code-branch-menu-error').textContent = '';
    }
    menu.dataset.id = String(state.menu.id);
    menu.style.top = `${head.offsetTop + 38}px`;
    const list = $('code-branch-list');
    list.replaceChildren(...state.menu.items.map(item => {
      const row = el('button', `code-branch-item${item.current ? ' is-current' : ''}`);
      row.type = 'button';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(item.current));
      row.append(Object.assign(document.createElement('i'), { className: `fa-solid ${item.current ? 'fa-check' : 'fa-code-branch'}` }), el('span', '', null, item.name), el('small', '', null, item.detail));
      row.disabled = state.busy;
      if (!item.current) row.addEventListener('click', () => void (async () => { await saveEditors(); await branchCommand({ type: 'switch', branch: item.name }); })());
      return row;
    }));
    if (state.menu.loading) list.append(el('div', 'code-branch-loading', 'code.branchLoading'));
    menu.hidden = false;
  }

  // --- the branch differs on GitHub: nothing is merged, the user chooses ----

  function renderDivergedChoice() {
    const keep = document.querySelector('input[name="code-diverged-keep"]:checked')?.value;
    $('code-diverged-name-row').hidden = keep !== 'branch';
  }

  function openDivergedDialog() {
    const s = git || {};
    if (!project || !s.diverged || $('code-diverged-dialog').open) return;
    $('code-diverged-lead').textContent = t('code.divergedLead', { branch: s.branch, ahead: s.unpushed, behind: s.behind });
    $('code-diverged-branch-desc').textContent = t(s.mode === 'full' ? 'code.divergedBranchDescFull' : 'code.divergedBranchDescSingle', { branch: s.branch });
    $('code-diverged-github-desc').textContent = t('code.divergedGithubDesc', { branch: s.branch, ahead: s.unpushed });
    document.querySelector('input[name="code-diverged-keep"][value="branch"]').checked = true;
    $('code-diverged-name').value = '';
    $('code-diverged-error').textContent = '';
    $('code-diverged-submit').disabled = false;
    renderDivergedChoice();
    $('code-diverged-dialog').showModal();
  }

  async function submitDiverged(event) {
    event.preventDefault();
    if (!project || gitBusy) return;
    const keep = document.querySelector('input[name="code-diverged-keep"]:checked')?.value;
    const name = $('code-diverged-name').value.trim();
    const error = $('code-diverged-error');
    if (keep === 'branch' && (!BRANCH_NAME.test(name) || name === 'HEAD')) { error.textContent = t('code.branchInvalid'); return; }
    error.textContent = '';
    $('code-diverged-submit').disabled = true;
    await saveEditors();
    const result = await runGit('resolve', keep === 'branch' ? { keep, name } : { keep });
    $('code-diverged-submit').disabled = false;
    if (result) $('code-diverged-dialog').close();
    else error.textContent = git?.error || '';
  }

  // --- the repository of a project, in one dialog for both entry points ----

  function renderGithub() {
    const s = github || {};
    const desc = $('code-github-desc');
    $('code-github-title').textContent = s.connected ? t('code.githubConnectedAs', { login: s.login }) : t('code.githubDisconnected');
    desc.textContent = s.pending ? t('code.githubPending')
      : s.error ? s.error
      : s.connected ? t('code.githubConnectedDesc')
      : s.appRegistered ? t('code.githubConnectDesc') : t('code.githubRegisterDesc');
    desc.classList.toggle('is-error', Boolean(s.error) && !s.pending);
    $('code-github-connect').hidden = Boolean(s.connected);
    $('code-github-connect').disabled = Boolean(s.pending);
    $('code-github-manage').hidden = !s.connected;
    $('code-github-manage').disabled = Boolean(s.pending);
    $('code-github-disconnect').hidden = !s.connected;
    $('code-repo-select').disabled = !s.connected;
    $('code-github-refresh').disabled = !s.connected;
    $('code-repo-submit').disabled = !s.connected;
    for (const radio of document.querySelectorAll('input[name="code-repo-mode"]')) radio.disabled = !s.connected;
  }

  function stopGithubPoll() {
    if (githubPoll) { clearInterval(githubPoll); githubPoll = null; }
  }

  async function refreshGithub() {
    const wasPending = Boolean(github?.pending);
    try { github = await window.chatStorage.githubStatus(); }
    catch (error) { github = { error: error.message }; }
    renderGithub();
    if (github.pending && !githubPoll) githubPoll = setInterval(() => void refreshGithub(), 2000);
    if (!github.pending) stopGithubPoll();
    if (github.connected && (wasPending || !$('code-repo-select').options.length)) await loadRepositories();
  }

  async function githubFlow(start) {
    $('code-repo-error').textContent = '';
    try {
      const { url } = await start();
      await openExternal(url);
    } catch (error) { $('code-repo-error').textContent = error.message || String(error); }
    await refreshGithub();
  }

  async function loadRepositories() {
    const select = $('code-repo-select');
    const previous = select.value || git?.repo || '';
    try {
      const repos = await window.chatStorage.githubRepositories();
      select.replaceChildren();
      const placeholder = el('option', '', repos.length ? 'code.repoPlaceholder' : 'code.githubNoRepos');
      placeholder.value = '';
      select.append(placeholder);
      for (const repo of repos) {
        const option = el('option', '', null, repo.private ? `${repo.full_name} (${t('code.repoPrivate')})` : repo.full_name);
        option.value = repo.full_name;
        option.dataset.name = repo.name;
        select.append(option);
      }
      if (repos.some(repo => repo.full_name === previous)) select.value = previous;
      await loadRepoBranches();
    } catch (error) { $('code-repo-error').textContent = error.message; }
  }

  function repoMode() {
    return document.querySelector('input[name="code-repo-mode"]:checked')?.value === 'branch' ? 'branch' : 'full';
  }

  /** The one branch the dialog names: a branch of the repository, or a new one. */
  function repoBranchChoice() {
    const picked = $('code-repo-branch').value;
    return picked === NEW_BRANCH ? $('code-repo-branch-new').value.trim() : picked;
  }

  function renderRepoChoice() {
    const single = repoMode() === 'branch';
    const isNew = single && $('code-repo-branch').value === NEW_BRANCH;
    $('code-repo-branch-row').hidden = !single;
    $('code-repo-branch-new-row').hidden = !isNew;
    const main = $('code-repo-branch').dataset.main || '';
    const branch = repoBranchChoice();
    $('code-repo-hint').textContent = !single ? t('code.repoHintFull')
      : isNew ? (branch ? t('code.repoHintNew', { branch, main }) : t('code.repoHintNewEmpty', { main }))
      : branch ? t('code.repoHintBranch', { branch }) : t('code.repoHint');
  }

  /** The branches of the repository picked in the dialog, the main one first, then "a new one". */
  async function loadRepoBranches() {
    const repo = $('code-repo-select').value;
    const select = $('code-repo-branch');
    const wanted = select.dataset.wanted || '';
    select.replaceChildren();
    select.dataset.main = '';
    if (!repo) { renderRepoChoice(); return; }
    select.append(new Option(t('code.branchLoading'), ''));
    select.disabled = true;
    let listed = null;
    try { listed = await window.chatStorage.githubBranches(repo); }
    catch (error) { $('code-repo-error').textContent = error.message; }
    if ($('code-repo-select').value !== repo) return;
    const main = listed?.defaultBranch || '';
    const names = [...(listed?.branches || [])].sort((a, b) => (b === main) - (a === main) || a.localeCompare(b));
    select.replaceChildren(...names.map(name => new Option(name === main ? `${name} — ${t('code.branchMain')}` : name, name)),
      new Option(t('code.branchNewOption'), NEW_BRANCH));
    select.dataset.main = main;
    select.disabled = false;
    if (wanted && names.includes(wanted)) select.value = wanted;
    else if (wanted) { select.value = NEW_BRANCH; $('code-repo-branch-new').value = wanted; }
    else select.value = names[0] || NEW_BRANCH;
    renderRepoChoice();
  }

  function openRepoDialog() {
    if (!project) return;
    const mode = git?.mode || 'full';
    const branch = git?.mode === 'branch' ? git.branch || '' : '';
    for (const radio of document.querySelectorAll('input[name="code-repo-mode"]')) radio.checked = radio.value === mode;
    $('code-repo-branch').dataset.wanted = branch;
    $('code-repo-branch-new').value = '';
    $('code-repo-error').textContent = '';
    $('code-repo-open').hidden = !git?.url;
    $('code-repo-submit-text').textContent = t(git?.repo ? 'code.repoChange' : 'code.repoConfirm');
    $('code-repo-none').hidden = !git?.repo;
    renderRepoChoice();
    $('code-repo-dialog').showModal();
    // The list of repositories is kept between openings: its branches are asked again for this one.
    if ($('code-repo-select').options.length) void loadRepoBranches();
    void refreshGithub();
  }

  async function submitRepo(event) {
    event.preventDefault();
    const repo = $('code-repo-select').value;
    if (!repo) { $('code-repo-error').textContent = t('code.repoRequired'); return; }
    const mode = repoMode();
    const branch = mode === 'branch' ? repoBranchChoice() : '';
    if (mode === 'branch' && (!BRANCH_NAME.test(branch) || branch === 'HEAD')) {
      $('code-repo-error').textContent = t(branch ? 'code.branchInvalid' : 'code.repoBranchRequired');
      return;
    }
    $('code-repo-error').textContent = '';
    // Linking never replaces the work here: it records what the project follows and brings it down.
    const same = repo === git?.repo && mode === git?.mode && (mode === 'full' || branch === git?.branch);
    if (!same) {
      $('code-repo-submit').disabled = true;
      await saveEditors();
      const linked = await runGit('link', { repo, mode, branch });
      $('code-repo-submit').disabled = false;
      if (!linked) { $('code-repo-error').textContent = git?.error || ''; return; }
    }
    $('code-repo-dialog').close();
    if (git?.diverged) openDivergedDialog();
  }

  async function clearRepo() {
    const ok = await window.chatWorkspace.confirmAction({
      title: t('code.repoUnlinkTitle'),
      message: t('code.repoUnlinkMessage', { repo: git?.repo || '' }),
      confirmText: t('code.repoUnlink')
    });
    if (!ok) return;
    if (await runGit('unlink')) $('code-repo-dialog').close();
    else $('code-repo-error').textContent = git?.error || '';
  }

  // --- new project dialog ---------------------------------------------------

  window.codeWorkspace = {
    // The project in the frame while Code is what is in view, for what goes along with the work on it (the character's notices).
    current() {
      return project && active && project.env === 'code' ? { id: project.id, name: project.name } : null;
    },
    /** The project in the frame, whatever is on screen. */
    opened() {
      return project ? project.id : null;
    },
    /**
     * The environment in view of an open project, as the chat names the
     * sections ('code', 'photo', 'studio'): its tools are the ones the
     * project's chat works with. Null for a project that is not the one open.
     */
    envOf(id) {
      return project && project.id === id && project.env ? ENV_SECTION[project.env] : null;
    },
    /** A step of the history is laid over what is open, or put away (said by code-history.js). */
    historyDetail(on) {
      const shown = Boolean(on) && view === 'history';
      if (shown === historyShown) return;
      historyShown = shown;
      $('code-history').hidden = !shown;
      void sync();
    },
    /** A file of the project is what is in the middle now (a chapter chosen from its toolbar): marked in the column. */
    showing(path) {
      if (project) window.projectTree.select(path);
      void readBar();
    },
    /** What the bar shows of the editor in view changed (a chapter given another title, a text with unsaved changes). */
    fileChanged() {
      void readBar();
    },
    /**
     * Opens a project as its card does: asked by the Lab, and by the
     * assistant before it writes in one of the project's chats. True when it
     * is the one open.
     */
    async open(id) {
      if (project?.id === id) return true;
      if (busy || opening) return false;
      opening = true;
      try {
        const item = (await window.chatStorage.listProjects('all')).find(entry => entry.id === id);
        if (!item || !(await closeProject())) return false;
        await openProject(item);
        return project?.id === id;
      } finally { opening = false; }
    },
    // A model just changed a file through its tools: the service has already
    // recorded it, the bar only has to catch up.
    noteToolChange() {
      if (project) void refreshGit();
      window.projectShelf.refresh();
    },
    // A command of the model on a local project: typed into the "SynthOrg"
    // terminal of the editor's panel, so the user watches it run; the output
    // comes back when the terminal reports the end of the command.
    // A command of the model in the editor's terminal. The workbench interrupts
    // it itself at `timeoutMs`; this side waits a little longer for that answer.
    runCommand(command, { timeoutMs = 5 * 60 * 1000, signal = null } = {}) {
      return new Promise((resolve, reject) => {
        const tauri = window.__TAURI__;
        if (!project || project.runtime?.kind === 'container' || !tauri?.core?.invoke || !created) { reject(new Error('Il terminale dell’editor non è disponibile per questo progetto.')); return; }
        const id = crypto.randomUUID();
        let unlisten = null;
        // The stop button: the workbench interrupts the command and answers with what ran so far. A terminal
        // that does not answer (a shell left waiting for more input, a program deaf to the interrupt) is not
        // waited for: a moment after the stop the command is given back as interrupted, and the turn ends.
        const onAbort = () => {
          tauri.core.invoke('code_stop_command', { id }).catch(() => {});
          setTimeout(() => {
            if (!runningCommands.has(id)) return;
            cleanup();
            resolve({ id, output: '', exit_code: null, error: 'interrupted:stop' });
          }, 3000);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        runningCommands.add(id);
        const timer = setTimeout(() => { onAbort(); cleanup(); reject(new Error('Il terminale non ha risposto in tempo.')); }, timeoutMs + 30000);
        const cleanup = () => { clearTimeout(timer); runningCommands.delete(id); signal?.removeEventListener('abort', onAbort); if (unlisten) unlisten(); };
        tauri.event.listen('synthorg-code-command-done', event => {
          if (event.payload?.id !== id) return;
          cleanup();
          resolve(event.payload);
        }).then(stop => {
          unlisten = stop;
          return tauri.core.invoke('code_run_command', { request: { id, command, cwd: null, timeout_ms: timeoutMs } });
        }).catch(error => { cleanup(); reject(error); });
      });
    },
    setActive(value) {
      active = value;
      // The frame is of an open project: with none, and none on its way, the list of the projects is the place.
      if (active && !project && !busy && !opening) { window.lab?.show(); return; }
      // Coming back to the frame: the record may have moved on without the bar,
      // and the chat has to be here rather than on the Chat tab.
      if (active && project) { void refreshGit(); void mountChat(); window.projectTree.refresh(); }
      if (active && project && view === 'history') void window.codeHistory.open(project.id);
      if (!active) { unmountChat(); window.codeHistory.close(); }
      // The environment in the middle wakes or rests with the frame.
      if (project?.env === 'writing') void window.studio?.setActive(active);
      if (project?.env === 'photo') void window.photo?.setActive(active);
      void sync();
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    $('code-retry')?.addEventListener('click', sync);
    $('code-btn-projects').addEventListener('click', () => void backToProjects());
    // "N in storico" opens the history it counts.
    // The model's permissions on the open project, and the list of what was approved in semi mode.
    $('code-perm-code').addEventListener('change', event => void setPermission('code', event.target.value));
    $('code-perm-terminal').addEventListener('change', event => void setPermission('terminal', event.target.value));
    $('code-perm-plan')?.addEventListener('change', event => void setPlanSetting({ mode: event.target.value }));
    $('code-perm-plan-tries')?.addEventListener('change', event => void setPlanSetting({ tries: event.target.value }));
    $('code-perm-list').addEventListener('click', () => void openPermDialog());
    $('code-perm-close').addEventListener('click', () => $('code-perm-dialog').close());
    $('code-perm-forget-all').addEventListener('click', async () => {
      if (!project) return;
      try { await window.chatStorage.forgetAllApprovals(project.id); await openPermDialog(); } catch (error) { showError(error.message); }
    });

    // This page can be loaded again (a reload in a debug build) while the
    // editor webview of the previous load is still up and visible: nothing
    // here would know of it, and it would stay painted over whatever tab is
    // open. Hiding it costs nothing when there is none.
    window.__TAURI__?.core?.invoke?.('code_layout', { visible: false, bounds: null, appearance: null })
      ?.catch(() => {});

    // The desktop says when the editor has written something; git is told from
    // here, because this page is the one that holds the open project.
    window.__TAURI__?.event?.listen?.('synthorg-code-changed', () => noteChange());
    // The workbench has loaded: a file pressed meanwhile is handed to it now.
    window.__TAURI__?.event?.listen?.('synthorg-code-frame-ready', () => { workbenchReady = true; deliverFile(); });
    // The workbench names the file in its tab in view, and says when what the bar asked of it is done.
    window.__TAURI__?.event?.listen?.('synthorg-code-files', event => {
      if (!project || project.runtime?.kind === 'container') return;
      const state = event.payload || {};
      const files = (Array.isArray(state.files) ? state.files : []).map(file => ({ path: inProject(file.path), dirty: Boolean(file.dirty) })).filter(file => file.path);
      codeShows({ files, shown: inProject(state.shown), zoom: Number(state.zoom) || 100 });
    });
    window.__TAURI__?.event?.listen?.('synthorg-code-did', event => asked.get(event.payload)?.());
    $('proj-file-rename').addEventListener('click', () => void fileName(false));
    $('proj-file-new').addEventListener('click', () => fileNew());
    $('proj-file-save').addEventListener('click', () => void fileDo('save'));
    $('proj-file-save-as').addEventListener('click', () => void fileName(true));
    $('proj-file-undo').addEventListener('click', () => void fileDo('undo'));
    $('proj-file-redo').addEventListener('click', () => void fileDo('redo'));
    $('proj-file-export').addEventListener('click', () => void fileExport());
    $('proj-export-form').addEventListener('submit', event => void submitExport(event));
    $('proj-export-cancel').addEventListener('click', closeExport);
    $('proj-export-close').addEventListener('click', closeExport);
    $('proj-export-dialog').addEventListener('cancel', event => { event.preventDefault(); closeExport(); });
    $('proj-file-settings').addEventListener('click', () => void fileSettings());
    $('proj-file-zoom-out').addEventListener('click', () => void fileZoom('zoomOut'));
    $('proj-file-zoom-in').addEventListener('click', () => void fileZoom('zoomIn'));
    $('proj-file-zoom-fit').addEventListener('click', () => void fileZoom('zoomReset'));
    // The tabs scroll sideways with the wheel.
    $('proj-tabs').addEventListener('wheel', event => { if (event.deltaY && !event.deltaX) { event.currentTarget.scrollLeft += event.deltaY; event.preventDefault(); } }, { passive: false });
    // The photo editor is asked what it has open after it was used: it does not say so itself.
    for (const type of ['pointerup', 'keyup', 'wheel']) $('studio-pane-photo')?.addEventListener(type, () => { if (project?.env === 'photo') readBarSoon(); }, { passive: true });
    $('proj-side-close').addEventListener('click', () => openSide($('proj-side').classList.contains('is-closed')));
    // An artifact dragged from the column over the photo editor: let go there, it becomes a layer of the document.
    // The editor is in a frame, which would take the drag for itself: while one lasts, the middle is covered by
    // the place to let it go.
    const drop = document.createElement('div');
    drop.className = 'proj-drop';
    drop.id = 'proj-drop-layer';
    drop.textContent = t('shelf.dropLayer');
    $('proj-viewer').append(drop);
    let dragged = null;
    window.addEventListener('synthorg-artifact-drag', event => {
      dragged = event.detail;
      const offered = Boolean(dragged) && project?.env === 'photo' && ['image', 'document'].includes(dragged.file?.kind) && Boolean(fileShown());
      drop.classList.toggle('is-offered', offered);
      drop.classList.remove('is-over');
      drop.textContent = t('shelf.dropLayer');
    });
    drop.addEventListener('dragover', event => { if (!dragged) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', event => {
      const taken = dragged;
      if (!taken) return;
      event.preventDefault();
      window.photo.perform({ op: 'place', path: taken.path }, { source: 'user' })
        .then(() => { viewerNote(''); void readBar(); })
        .catch(error => viewerNote(error.message || String(error)));
    });
    $('proj-btn-zip').addEventListener('click', () => void exportZip());
    bindResizer($('proj-side-resizer'), { key: 'synthorg_project_files_width', variable: '--proj-side-w', min: 180, max: 520, start: 250, fromLeft: true, other: () => $('code-ai-panel') });
    bindResizer($('proj-chat-resizer'), { key: 'synthorg_project_chat_width', variable: '--proj-chat-w', min: 280, max: 720, start: 380, fromLeft: false, other: () => $('proj-side') });
    let sideClosed = false;
    try { sideClosed = localStorage.getItem(SIDE_CLOSED_KEY) === '1'; } catch {}
    if (sideClosed) openSide(false);

    // The project's AI beside the editor.
    $('code-chat-select').addEventListener('change', event => void loadProjectChats(event.target.value));
    $('code-chat-new').addEventListener('click', () => void newProjectChat());
    $('code-ai-close').addEventListener('click', () => toggleAi($('code-ai-panel').classList.contains('is-closed')));
    let chatClosed = false;
    try { chatClosed = localStorage.getItem(CHAT_CLOSED_KEY) === '1'; } catch {}
    if (chatClosed) toggleAi(false);

    // The git bar of the open project.
    $('code-git-repo').addEventListener('click', () => openRepoDialog());

    // Under the files: the history of the project, and its steps sent to GitHub.
    $('proj-btn-history').addEventListener('click', () => { window.projectShelf.showFiles(); setView(view === 'history' ? 'editor' : 'history'); });
    $('proj-btn-push').addEventListener('click', () => void pushFromColumn());
    $('proj-search').addEventListener('input', event => { if (!window.projectShelf.on) window.projectTree.search(event.target.value); });

    // The branch strip. A local project's is inside its workbench and speaks through the desktop.
    window.__TAURI__?.event?.listen?.('synthorg-code-git-command', event => void branchCommand(event.payload));
    $('code-branch-name').addEventListener('click', () => {
      if (git?.mode !== 'full') openRepoDialog();
      else if ($('code-branch-menu').hidden) void openBranchMenu();
      else { closeBranchMenu(); publishBranch(); }
    });
    for (const [id, command] of [['code-branch-pull', { type: 'pull' }], ['code-branch-diverged', { type: 'resolve' }]]) {
      $(id).addEventListener('click', () => void (async () => { await saveEditors(); await branchCommand(command); })());
    }
    $('code-branch-auto').addEventListener('click', () => void (async () => { await saveEditors(); await branchCommand({ type: 'auto', auto: !git?.auto }); })());
    $('code-branch-new').addEventListener('submit', event => void submitNewBranch(event));
    document.addEventListener('pointerdown', event => {
      if ($('code-branch-menu').hidden || event.target.closest('#code-branch-menu, #code-branch-name')) return;
      closeBranchMenu();
    });
    $('code-branch-menu').addEventListener('keydown', event => { if (event.key === 'Escape') { closeBranchMenu(); window.codeCanvas?.focus(); } });

    // The branch differs on GitHub: the user's choice.
    $('code-diverged-form').addEventListener('submit', event => void submitDiverged(event));
    $('code-diverged-cancel').addEventListener('click', () => $('code-diverged-dialog').close());
    $('code-diverged-close').addEventListener('click', () => $('code-diverged-dialog').close());
    for (const radio of document.querySelectorAll('input[name="code-diverged-keep"]')) radio.addEventListener('change', renderDivergedChoice);

    // The repository dialog: the GitHub account and the repository, once.
    $('code-repo-form').addEventListener('submit', event => void submitRepo(event));
    $('code-repo-close').addEventListener('click', () => $('code-repo-dialog').close());
    $('code-repo-none').addEventListener('click', () => void clearRepo());
    $('code-repo-open').addEventListener('click', () => { if (git?.url) void openExternal(git.url); });
    $('code-repo-dialog').addEventListener('close', stopGithubPoll);
    $('code-repo-select').addEventListener('change', () => { $('code-repo-branch').dataset.wanted = ''; void loadRepoBranches(); });
    for (const radio of document.querySelectorAll('input[name="code-repo-mode"]')) radio.addEventListener('change', renderRepoChoice);
    $('code-repo-branch').addEventListener('change', renderRepoChoice);
    $('code-repo-branch-new').addEventListener('input', renderRepoChoice);
    $('code-github-connect').addEventListener('click', () => githubFlow(() => window.chatStorage.githubConnect()));
    $('code-github-manage').addEventListener('click', () => githubFlow(() => window.chatStorage.githubInstall()));
    $('code-github-refresh').addEventListener('click', () => void loadRepositories());
    $('code-github-disconnect').addEventListener('click', async () => {
      try { await window.chatStorage.githubDisconnect(); } catch (error) { $('code-repo-error').textContent = error.message; }
      $('code-repo-select').replaceChildren();
      await refreshGithub();
    });

    new ResizeObserver(() => { if (active) void sync(); }).observe($('code-container'));
    for (const id of ['modal-key-backdrop', 'drawer-backdrop']) {
      const modal = $(id);
      if (modal) new MutationObserver(() => { if (created) void sync(); }).observe(modal, { attributes: true, attributeFilter: ['class'] });
    }
    new MutationObserver(() => { if (created) void sync(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // A dialog opening was read by obscured() but never woke it: the memories,
    // the repository, git, a new project all open over the editor, and nothing
    // here asked to hide it. The attribute is watched page-wide, so a dialog
    // added later counts too.
    new MutationObserver(() => { if (created) void sync(); })
      .observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });
    window.addEventListener('synthorg-theme-changed', () => { if (created) void sync(); });
    window.addEventListener('synthorg-locale-changed', () => { if (created) void sync(); publishBranch(); });
  });
})();
