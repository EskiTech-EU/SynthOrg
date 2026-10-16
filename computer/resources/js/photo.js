/**
 * SynthOrg - Photo, an environment of a project.
 *
 * In the frame of an open project (code-workspace.js) this is what is in the
 * middle while a photo is: photocraft itself, its web build in a frame that
 * fills the pane, painted in SynthOrg's colours and following them when they
 * change. Nothing is opened in a window.
 *
 * A project is made with its canvas — empty at a size, or from an image —
 * and this file builds that canvas in the editor the first time the project
 * is opened, saving it as the project's document; afterwards opening the
 * project opens the document.
 *
 * The rest is the page's side of the editor. It hands it its look, gives it
 * the files of the project folder (to open as documents, or to insert as
 * layers) and takes what it saves, which the service writes into the folder
 * as a step of the record. It carries out on it what the model asks through
 * its tools once the service has allowed it. And it runs SynthOrg's own
 * functions, which sit in the editor's menus like the editor's own: the
 * model that removes a background runs in a pod, so the editor hands the
 * request here, this file takes the layer's pixels, has the pod work on
 * them, and gives the result back to the editor as a mask on the layer or a
 * selection — limited to the selection the document already has, if any.
 * Beside the editor sits the project's chat, the same chat element the rest
 * of the app uses.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const t = (key, params) => window.i18n?.t(key, params || {}) || key;
  const FRAME_URL = 'photocraft/index.html';
  const READY_TIMEOUT_MS = 90000;
  const JOB_POLL_MS = 300;
  const WARM_POLL_MS = 2000;
  // Around a selection, how much of the picture the model also sees: a share of the selection's longer side.
  const SELECTION_MARGIN = 0.06;
  // Around an object that is pointed at, more: the model that is told where it is wants to see what is around it.
  const OBJECT_MARGIN = 0.25;
  // The CSS tokens photocraft's colours are made from.
  const LOOK_COLORS = ['--bg-app', '--bg-header', '--bg-surface', '--bg-surface-hover', '--bg-card', '--bg-input', '--bg-pill', '--bg-active',
    '--text-main', '--text-neutral', '--text-muted', '--text-dim', '--primary', '--on-primary', '--accent-primary-subtle', '--accent-primary-border',
    '--border-subtle', '--border-default', '--color-danger'];

  let active = false;
  let project = null;
  // The editor in the frame: its API once it has started, and the one start everybody waits for.
  let editor = null;
  let starting = null;
  let commands = null;
  // What the editor is saving right now, by path: a capture of ours waiting for the bytes, or a write to the folder to wait for.
  const captures = new Map();
  const writes = new Map();
  const sources = new Map();
  let warmPoll = null;
  let busy = false;
  let working = false;
  // The model a function found missing: what the download button of its notice fetches.
  let missingModel = null;
  let colorProbe = null;
  let captureCount = 0;

  function el(tag, className, key, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (key) { node.setAttribute('data-i18n', key); node.textContent = t(key); }
    else if (text !== undefined) node.textContent = text;
    return node;
  }

  function showError(message) {
    $('photo-error').hidden = !message;
    $('photo-error-text').textContent = message || '';
    if (message) console.warn('[photo]', message);
  }

  function formatDate(value) {
    const locale = window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT';
    return new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  }

  // --- the look ---------------------------------------------------------------------

  // The editor reads #rrggbb(aa); some tokens are color-mix(), so the browser resolves them first.
  function hexColor(value) {
    if (!value) return '';
    colorProbe ||= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
    colorProbe.clearRect(0, 0, 1, 1);
    colorProbe.fillStyle = '#000'; colorProbe.fillStyle = value;
    colorProbe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = colorProbe.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b, ...(a < 255 ? [a] : [])].map(n => n.toString(16).padStart(2, '0')).join('');
  }

  /**
   * SynthOrg's colours as photocraft's own tokens: the theme the overrides
   * sit on (its dark or its light one, for what the tokens do not reach) and
   * every token the page has a colour for.
   */
  function look() {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const c = Object.fromEntries(LOOK_COLORS.map(key => [key, hexColor(style.getPropertyValue(key).trim())]));
    const dark = (root.getAttribute('data-theme-mode') || 'dark') !== 'light';
    const tokens = {
      chrome: c['--bg-header'], canvas: c['--bg-app'], canvas_dot: c['--border-subtle'], dock: c['--bg-surface'], card: c['--bg-card'],
      card_border: c['--border-subtle'], field: c['--bg-input'], field_border: c['--border-default'], hover: c['--bg-surface-hover'], pressed: c['--bg-active'],
      text: c['--text-main'], text_dim: c['--text-muted'], text_faint: c['--text-dim'], icon: c['--text-neutral'],
      accent: c['--primary'], accent_soft: c['--accent-primary-subtle'], accent_border: c['--accent-primary-border'], accent_text: c['--on-primary'],
      separator: c['--border-subtle'], shadow: dark ? '#00000066' : '#1919231f', primary_bg: c['--primary'], primary_text: c['--on-primary'],
      danger: c['--color-danger'], tab_strip: c['--bg-pill'], row_selected: c['--bg-active']
    };
    for (const key of Object.keys(tokens)) if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(tokens[key] || '')) delete tokens[key];
    return { theme: dark ? 'pro' : 'studioLight', tokens, background: c['--bg-app'] };
  }

  function sendLook() {
    const current = look();
    // The stage behind the frame has the same colour: no flash while the editor starts.
    $('photo-stage').style.background = current.background || '';
    try { editor?.look(JSON.stringify(current)); } catch (error) { console.warn('[photo] look', error); }
  }

  // --- the editor in the frame ---------------------------------------------------------

  function toBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }

  /**
   * What the editor writes: called by it, synchronously, with the path it
   * saves to and the bytes. A capture of ours takes the bytes and nothing is
   * written; anything else goes to the folder through the service.
   */
  function hostWrite(file, bytes) {
    const copy = new Uint8Array(bytes);
    const waiting = captures.get(file);
    if (waiting) { captures.delete(file); waiting(copy); return; }
    if (!project) { showError(t('photo.noProject')); return; }
    const source = sources.get(file) || 'user';
    sources.delete(file);
    const done = window.chatStorage.photoWrite(project.id, file, toBase64(copy), source)
      .then(result => { showError(''); void refreshFiles(); return result; })
      .catch(error => { showError(error.message); throw error; });
    writes.set(file, done);
    done.catch(() => {}).finally(() => { if (writes.get(file) === done) writes.delete(file); });
  }

  /** Starts the editor in the frame, once; resolves when it answers. */
  function start() {
    if (editor) return Promise.resolve(editor);
    if (starting) return starting;
    const frame = $('photo-frame');
    const status = $('photo-stage-status');
    status.textContent = t('photo.loading');
    status.hidden = false;
    starting = new Promise((resolve, reject) => {
      const began = Date.now();
      let failed = null;
      const host = { write: hostWrite, command: hostCommand, ready() {}, failed(message) { failed = message; } };
      const attach = () => { try { frame.contentWindow.synthorgHost = host; } catch {} };
      frame.addEventListener('load', attach, { once: true });
      frame.src = FRAME_URL;
      const timer = setInterval(() => {
        attach();
        const api = frame.contentWindow?.synthorgPhotocraft;
        if (api) {
          clearInterval(timer);
          editor = api;
          status.hidden = true;
          sendLook();
          resolve(api);
        } else if (failed || Date.now() - began > READY_TIMEOUT_MS) {
          clearInterval(timer);
          starting = null;
          status.textContent = `${t('photo.loadFailed')} ${failed || ''}`.trim();
          reject(new Error(status.textContent));
        }
      }, 100);
    });
    return starting;
  }

  /** One request on the editor's control channel: the same methods the desktop app answers on its socket. */
  async function control(method, params = {}) {
    const api = await start();
    const reply = JSON.parse(await api.control(method, JSON.stringify(params)));
    if (reply && reply.ok === false) throw new Error(String(reply.error || 'photocraft ha rifiutato la richiesta'));
    return reply && Object.prototype.hasOwnProperty.call(reply, 'result') ? reply.result : reply;
  }

  /** One command of the editor: the engine's, the shell's, or one of SynthOrg's. */
  function exec(command, params = {}) {
    return control('engine.execute', { command, params });
  }

  /** A file of the folder, opened in the editor as a document. */
  async function openFile(file) {
    if (!project) throw new Error(t('photo.noProject'));
    const api = await start();
    api.put(file, await window.chatStorage.photoFile(project.id, file));
    const opened = await control('app.open', { path: file });
    window.codeWorkspace?.showing?.(file);
    return opened;
  }

  /** The documents open in the editor, each by the file it was opened from (or its name, if it has none), and which is in view. */
  async function documents() {
    if (!project || !editor) return { list: [], active: -1, zoom: null };
    const state = await inspect();
    const list = (state?.session?.documents || []).map((doc, index) => ({ index, path: doc.path || doc.name, dirty: Boolean(doc.dirty) }));
    const active = Number(state?.session?.active ?? -1);
    // Each document has a view of its own: the zoom told is that of the one in view.
    const zoom = Number(state?.views?.[active]?.zoom);
    return { list, active, zoom: zoom > 0 ? Math.round(zoom * 100) : null };
  }

  /** What the editor has open, every layer composed, as a PNG: handed over under a name of ours and taken on the way. */
  async function capture() {
    const file = `.synthorg/capture-${++captureCount}.png`;
    const bytes = new Promise(resolve => captures.set(file, resolve));
    try { await exec('synthorg.layerImage', { path: file, layer: 'merged' }); }
    catch (error) { captures.delete(file); throw error; }
    return bytes;
  }

  /** A file of the folder, inserted in the open document as a new layer. */
  async function placeFile(file, { center, scale, fit } = {}) {
    if (!project) throw new Error(t('photo.noProject'));
    const api = await start();
    api.put(file, await window.chatStorage.photoFile(project.id, file));
    return exec('synthorg.place', { path: file, ...(center ? { center } : {}), ...(scale ? { scale } : {}), ...(fit === false ? { fit: false } : {}) });
  }

  async function inspect() {
    return control('ui.inspect');
  }

  async function openDocument() {
    const state = await inspect();
    return state?.document ? { ...state.document, dirty: Boolean(state.session?.documents?.[state.session?.active]?.dirty) } : null;
  }

  // --- what the model's tools do here, once the service has allowed them --------------

  async function perform(page, { source = 'agent' } = {}) {
    switch (page.op) {
      case 'execute': {
        const result = await exec(page.command, page.params || {});
        return { command: page.command, result };
      }
      case 'batch': {
        const results = [];
        for (const step of page.steps) {
          try { results.push({ command: step.command, ok: true, result: await exec(step.command, step.params || {}) }); }
          catch (error) { results.push({ command: step.command, ok: false, error: error.message }); break; }
        }
        return { completed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results };
      }
      case 'inspect': return exec('document.inspect');
      case 'commands': {
        try {
          if (!commands) { const listed = await control('engine.commands'); commands = Array.isArray(listed) ? listed : listed?.commands || []; }
        } catch { return { source: 'bigino', commands: page.fallback }; }
        const hits = commands.filter(c => `${c.id} ${c.label || ''} ${c.menu || ''}`.toLowerCase().includes(page.filter));
        return { source: 'photocraft', total: hits.length, commands: hits.slice(0, page.limit).map(c => ({ id: c.id, label: c.label || null, menu: c.menu || null, params: c.params || null, enabled: c.enabled !== false })) };
      }
      case 'open': {
        const opened = await openFile(page.path);
        return { path: page.path, ...(opened || {}) };
      }
      case 'place': {
        const placed = await placeFile(page.path, page);
        return { path: page.path, ...(placed || {}) };
      }
      case 'removeBackground': return removeBackgroundInDocument({ layer: page.layer ?? null, output: page.output });
      case 'selectObject': return removeBackgroundInDocument({ layer: page.layer ?? null, output: page.output, object: true, box: page.box || null });
      case 'save': {
        sources.set(page.path, source);
        const saved = await control('app.save', { path: page.path });
        // The editor has handed the bytes over; the step is there once the service has written them.
        const written = await writes.get(page.path);
        return { path: page.path, warnings: saved?.warnings || [], bytes: written?.bytes ?? null };
      }
      case 'screenshot': {
        // The document as it is now, every layer composed: what the user sees on the canvas.
        // (In the page the app cannot photograph its own window: the browser gives it no such call.)
        const doc = await openDocument();
        if (!doc) throw new Error('Nessun documento aperto nell’editor.');
        return { document: doc.name, width: doc.width, height: doc.height, picture: { bytes: await capture(), name: 'photocraft.png' } };
      }
      default: throw new Error(`Operazione sconosciuta: ${page.op}`);
    }
  }

  function layerLines(layers, depth = 0, out = []) {
    for (const layer of layers || []) {
      if (out.length >= 40) break;
      out.push(`${'  '.repeat(depth)}- id ${layer.id} «${layer.name}» ${layer.kind}${layer.hasMask ? ', con maschera' : ''}${layer.visible === false ? ', nascosto' : ''}${layer.selected ? ', attivo' : ''}`);
      if (layer.children) layerLines(layer.children, depth + 1, out);
    }
    return out;
  }

  /** For the model's context: what the editor has open — the document, its selection, its layers. */
  async function describe() {
    if (!editor) return 'Editor: non ancora avviato in questa sessione (si avvia aprendo un progetto nella scheda Foto dello Studio).';
    try {
      const doc = await openDocument();
      if (!doc) return 'Editor: nessun documento aperto. Aprine uno con photo_open.';
      const state = await exec('document.inspect');
      const box = state.selectionBounds;
      return [
        `Editor: documento aperto «${doc.name}» ${doc.width || '?'}×${doc.height || '?'}, revisione ${doc.revision ?? '?'}${doc.dirty ? ', non salvato' : ''}.`,
        `Selezione: ${state.hasSelection && box ? `presente, da x ${box[0]} y ${box[1]}, ${box[2]}×${box[3]}` : 'nessuna'}.`,
        'Livelli, dal più alto al più basso:',
        ...layerLines(state.layers)
      ].join('\n');
    } catch (error) { return `Editor: stato non leggibile (${error.message}).`; }
  }

  // --- the projects ---------------------------------------------------------------------

  // --- a new project: its canvas, its size, its folder -----------------------------------

  // --- the open project --------------------------------------------------------------------

  function fileOptions(select, key) {
    const first = el('option', '', null, t(key, { count: project.total }));
    first.value = '';
    select.replaceChildren(first, ...project.files.map(file => {
      const size = file.width && file.height ? ` · ${file.width}×${file.height}` : '';
      const option = el('option', '', null, `${file.path}${size}`);
      option.value = file.path;
      return option;
    }));
    select.value = '';
    select.disabled = !project.files.length;
  }

  function renderFiles() {
    fileOptions($('photo-place'), 'photo.placeCount');
  }

  function renderBar() {
    if (project) renderFiles();
  }

  async function refreshFiles() {
    if (!project) return;
    try {
      const overview = await window.chatStorage.photoOverview(project.id);
      if (project && overview.id === project.id) { project = overview; renderFiles(); }
    } catch {}
  }

  /**
   * The project's document in the editor. It is there: opened. It is not yet:
   * the canvas the project was made with is built — the base image as it is,
   * or a canvas of the chosen size with the base placed on it — and saved as
   * the project's document, the first step of its own.
   */
  async function prepareDocument() {
    const status = $('photo-stage-status');
    await start();
    status.textContent = t('photo.preparing');
    status.hidden = false;
    try {
      // Whatever a project left open before is not this project's.
      await exec('file.closeAll').catch(() => {});
      if (!project.document) return;
      if (project.documentExists) { await openFile(project.document); return; }
      const setup = project.setup;
      if (!setup) return;
      if (setup.base && !setup.width) {
        // The image as it is, under the project's name: a copy of it takes the name, and the image's own tab goes.
        await openFile(setup.base);
        await exec('image.duplicate', { name: project.project.name });
        await exec('file.close', { document: 0 });
      }
      else {
        await exec('file.new', { width: setup.width, height: setup.height, background: setup.background, name: project.project.name });
        if (setup.base) await placeFile(setup.base);
      }
      await perform({ op: 'save', path: project.document }, { source: 'user' });
      project.documentExists = true;
    } finally { status.hidden = true; }
  }

  /**
   * The photos of a project in the project's frame (code-workspace.js, which opens the project and
   * holds its chat and its files): the folder read, and its document opened in the editor. A folder
   * with no document yet gets an empty canvas.
   */
  async function attach(id) {
    if (project?.id === id) return true;
    if (busy || working) return false;
    if (project && !(await detach())) return false;
    busy = true;
    try {
      let overview;
      try { overview = await window.chatStorage.photoOverview(id); }
      catch (error) {
        if (!/non è ancora/.test(error.message)) throw error;
        overview = await window.chatStorage.photoInit(id, {});
      }
      project = overview;
      showError('');
      renderBar();
      await prepareDocument();
      return true;
    } catch (error) {
      showError(error.message);
      return false;
    } finally { busy = false; }
  }

  /** The project is left. Documents with unsaved changes are named first: closing them loses the changes. False when the user keeps them. */
  async function detach() {
    if (!project) return true;
    if (busy || working) return false;
    if (editor) {
      let unsaved = [];
      try { unsaved = ((await inspect())?.session?.documents || []).filter(doc => doc.dirty).map(doc => doc.name); } catch {}
      if (unsaved.length) {
        const ok = await window.chatWorkspace.confirmAction({ title: t('photo.unsavedTitle'), message: t('photo.unsavedMessage', { names: unsaved.join(', ') }), confirmText: t('photo.unsavedConfirm') });
        if (!ok) return false;
      }
      await exec('file.closeAll').catch(() => {});
    }
    project = null;
    showJob('');
    showError('');
    return true;
  }

  // --- images the chat's image models make ------------------------------------------------

  function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /**
   * An image an image model made in the project's chat: written into the
   * project folder (a step of its record, the model's) and inserted in the
   * open document as a new layer — or opened, when no document is open.
   */
  async function addGenerated(name, base64) {
    if (!project) throw new Error(t('photo.noProject'));
    const clean = String(name || 'immagine.png').split(/[\\/]/).pop().replace(/[^\p{L}\p{N} ._-]+/gu, '_') || 'immagine.png';
    const file = /\.(png|jpe?g|webp)$/i.test(clean) ? clean : `${clean}.png`;
    await window.chatStorage.photoWrite(project.id, file, base64, 'agent');
    void refreshFiles();
    const api = await start();
    api.put(file, fromBase64(base64));
    if (await openDocument()) {
      const placed = await exec('synthorg.place', { path: file });
      return { path: file, layer: placed?.layer ?? null, bounds: placed?.bounds || null };
    }
    await control('app.open', { path: file });
    return { path: file, layer: null, bounds: null };
  }

  /**
   * The image an image model is asked to start from, as a data URL: the open
   * document as it is now ("documento", or nothing a file is named by), or a
   * file of the project folder.
   */
  async function sourceImage(value) {
    if (!project) throw new Error(t('photo.noProject'));
    const wanted = String(value || '').trim();
    if (/^(data:|https?:)/i.test(wanted)) return wanted;
    let bytes, mime = 'image/png';
    if (!wanted || /^(documento|document)$/i.test(wanted)) {
      if (!await openDocument()) throw new Error(t('photo.nothingOpen'));
      bytes = await capture();
    } else {
      bytes = await window.chatStorage.photoFile(project.id, wanted);
      if (/\.jpe?g$/i.test(wanted)) mime = 'image/jpeg';
      else if (/\.webp$/i.test(wanted)) mime = 'image/webp';
    }
    return `data:${mime};base64,${toBase64(bytes)}`;
  }

  // --- SynthOrg's functions, asked from the editor's menus or by the model ------------------

  const PHASES = { starting: 'photo.phaseStarting', engine: 'photo.phaseEngine', image: 'photo.phaseImage', run: 'photo.phaseRun', copy: 'photo.phaseCopy', models: 'photo.phaseModels' };

  function showJob(text, { spinning = true, warm = false } = {}) {
    const badge = $('photo-job');
    badge.hidden = !text;
    badge.querySelector('i').hidden = !spinning;
    $('photo-job-text').textContent = text || '';
    $('photo-model-warm').hidden = !warm;
  }

  /** The same words in the editor's own status bar, where the eyes are. */
  function editorStatus(text, error = false) {
    return exec('synthorg.status', { text, error }).catch(() => {});
  }

  /**
   * The part of a picture around a selection, with a margin: what the model
   * is shown when the user has marked where the subject is, so it looks
   * there and not at the whole picture. Returns where that part sits.
   */
  async function cropTo(bytes, [sx, sy, sw, sh], width, height, share = SELECTION_MARGIN) {
    const margin = Math.round(Math.max(sw, sh) * share);
    const x = Math.max(0, sx - margin), y = Math.max(0, sy - margin);
    const w = Math.min(width, sx + sw + margin) - x, h = Math.min(height, sy + sh + margin) - y;
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), x, y, w, h);
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), offset: [x, y] };
  }

  async function waitJob() {
    for (;;) {
      const job = await window.chatStorage.photoJob(project.id);
      if (job.state !== 'running') return job;
      showJob(t(PHASES[job.phase] || 'photo.phaseStarting'));
      await new Promise(resolve => setTimeout(resolve, JOB_POLL_MS));
    }
  }

  /**
   * A model's matte put into the open document, in one step of its history.
   *
   * Without `object` the model finds the subject by itself: from the active
   * layer (or the one named) as a mask on it, or as the document's selection
   * (`output: 'selection'`, read from all the layers together). A selection
   * the document has — or a path drawn with the pen, which becomes one — is
   * the limit: the model is shown that part, and the result stays inside it.
   *
   * With `object` the model is told where the object is: `box` ([x, y, w, h]
   * in the document), or the bounds of the selection drawn around it. There
   * the selection points, it does not cut: the result is the object, also
   * where the selection was drawn a little inside it.
   *
   * Either way, with the project's setting on, the matte's edge is then
   * fitted to the picture at full size by the editor.
   */
  async function removeBackgroundInDocument({ layer = null, output = 'mask', object = false, box = null } = {}) {
    if (!project) throw new Error(t('photo.noProject'));
    if (!project.functions?.included) throw new Error(t('photo.functionsMissing'));
    if (working) throw new Error(t('photo.functionBusy'));
    working = true;
    const began = Date.now();
    const label = t(object ? 'photo.selectingObject' : output === 'selection' ? 'photo.selectingSubject' : 'photo.removingBackground');
    try {
      if (!await openDocument()) throw new Error(t('photo.nothingOpen'));
      showError('');
      showJob(label);
      void editorStatus(label);
      const state = await exec('document.inspect');
      if (!state.hasSelection && !box) {
        try { if ((await exec('path.list'))?.workPath) await exec('path.toSelection', { name: 'work' }); } catch {}
      }
      // The editor hands the pixels over as a file of ours, taken on the way. A selection is made from
      // what is seen, every layer together; a mask from the layer it goes on.
      const file = `.synthorg/layer-${++captureCount}.png`;
      const taken = new Promise(resolve => captures.set(file, resolve));
      let info;
      try { info = await exec('synthorg.layerImage', { path: file, ...(layer !== null ? { layer } : output === 'selection' ? { layer: 'merged' } : {}) }); }
      catch (error) { captures.delete(file); throw error; }
      let bytes = await taken;
      let offset = [0, 0];
      const around = object ? (box || info.selection) : info.selection;
      if (object && !around) throw new Error(t('photo.objectNeedsSelection'));
      if (around) ({ bytes, offset } = await cropTo(bytes, around, info.width, info.height, object ? OBJECT_MARGIN : SELECTION_MARGIN));
      await window.chatStorage.photoWrite(project.id, '.synthorg/rembg-in.png', toBase64(bytes));
      // For the model that is pointed at: the rectangle, in the pixels of the part it is shown.
      const pointed = object ? [around[0] - offset[0], around[1] - offset[1], around[0] - offset[0] + around[2], around[1] - offset[1] + around[3]] : null;
      await window.chatStorage.photoRemoveBackground(project.id, '.synthorg/rembg-in.png', { scratch: true, box: pointed });
      const job = await waitJob();
      if (job.state !== 'done') throw Object.assign(new Error(job.error || t('photo.jobFailed')), { needsModel: Boolean(job.needsModel), model: job.model });
      showJob(label);
      const api = await start();
      api.put(job.output, await window.chatStorage.photoFile(project.id, job.output));
      const result = await exec('synthorg.matte', {
        path: job.output, output, offset, object, constrain: !object, refine: project.settings?.refine === true,
        ...(info.layer !== null && info.layer !== undefined ? { layer: info.layer } : {})
      });
      const seconds = ((Date.now() - began) / 1000).toFixed(1);
      const done = t(object ? 'photo.objectSelected' : output === 'selection' ? 'photo.subjectSelected' : 'photo.backgroundRemoved', { seconds });
      showJob(done, { spinning: false });
      void editorStatus(done);
      setTimeout(() => { if ($('photo-job-text').textContent === done) showJob(''); }, 8000);
      return { ...result, name: info.name, seconds: Number(seconds) };
    } catch (error) {
      missingModel = error.needsModel ? error.model || null : null;
      showJob(error.needsModel ? `${t('photo.jobFailed')} ${error.message}` : '', { spinning: false, warm: Boolean(error.needsModel) });
      void editorStatus(error.message, true);
      throw error;
    } finally { working = false; }
  }

  /**
   * A function picked from the editor's menus. The editor calls this in the
   * middle of drawing a frame, so the work starts once it has returned.
   */
  function hostCommand(id) {
    const request = { 'synthorg.removeBackground': { output: 'mask' }, 'synthorg.selectSubject': { output: 'selection' }, 'synthorg.selectObject': { output: 'selection', object: true } }[id];
    if (!request) return;
    setTimeout(() => { removeBackgroundInDocument(request).catch(error => showError(error.message)); }, 0);
  }

  /** The model, downloaded once: from the settings, or from the notice of a function that found it missing. */
  async function warmModel(model = null) {
    try {
      await window.chatStorage.photoWarmModels(model || project?.settings?.model);
      showJob(t('photo.modelDownloading'));
      clearInterval(warmPoll);
      warmPoll = setInterval(async () => {
        try {
          const status = await window.chatStorage.photoModels();
          renderModelsStatus(status);
          const warm = status.warm;
          if (!warm || warm.state === 'running') return;
          clearInterval(warmPoll);
          if (warm.state === 'done') { showJob(t('photo.modelReady'), { spinning: false }); setTimeout(() => { if ($('photo-job-text').textContent === t('photo.modelReady')) showJob(''); }, 8000); }
          else showJob(`${t('photo.modelFailed')} ${warm.error || ''}`, { spinning: false, warm: true });
        } catch (error) { clearInterval(warmPoll); showJob(''); showError(error.message); }
      }, WARM_POLL_MS);
    } catch (error) { showError(error.message); }
  }

  function renderModelsStatus(status) {
    const box = $('photo-models-status');
    if (!box || !project) return;
    const model = project.settings?.model;
    if (!status.engine) box.textContent = t('studio.texNoEngine');
    else if (!status.prebuilt) box.textContent = t('photo.functionsMissing');
    else if (status.warm?.state === 'running') box.textContent = t('photo.modelDownloading');
    else if (status.models?.[model]) box.textContent = t('photo.modelReady');
    else box.textContent = t('photo.modelMissing', { label: project.models?.[model]?.label || model });
    // The licence its authors give it, said before the download: it is the user who takes the model.
    const licence = project.models?.[model]?.licence;
    if (licence && status.engine && status.prebuilt) box.textContent += ` ${t('photo.modelLicence', { licence })}`;
    // The model that is told where the object is: one, with its own download.
    const objectKey = project.settings?.objectModel;
    const objectModel = project.models?.[objectKey];
    const objectBox = $('photo-object-status');
    if (objectBox && objectModel) {
      objectBox.textContent = !status.engine ? t('studio.texNoEngine') : !status.prebuilt ? t('photo.functionsMissing')
        : status.warm?.state === 'running' && status.warm.model === objectKey ? t('photo.modelDownloading')
        : `${objectModel.label}: ${status.models?.[objectKey] ? t('photo.modelReady') : t('photo.objectModelMissing')} ${t('photo.modelLicence', { licence: objectModel.licence })}`;
    }
  }

  // --- settings and permissions ---------------------------------------------------------

  async function openSettings() {
    if (!project) return;
    const select = $('photo-set-model');
    select.replaceChildren(...Object.entries(project.models || {}).filter(([, model]) => model.use !== 'object').map(([key, model]) => {
      const option = el('option', '', null, model.label);
      option.value = key;
      option.selected = key === project.settings?.model;
      return option;
    }));
    $('photo-settings-error').textContent = '';
    $('photo-set-refine').checked = project.settings?.refine === true;
    $('photo-object-status').textContent = '…';
    $('photo-app-status').textContent = '…';
    $('photo-models-status').textContent = '…';
    $('photo-settings-dialog').showModal();
    try { renderAppStatus(await window.chatStorage.photoStatus()); } catch (error) { $('photo-app-status').textContent = error.message; }
    try { renderModelsStatus(await window.chatStorage.photoModels()); } catch (error) { $('photo-models-status').textContent = error.message; }
  }

  function renderAppStatus(status) {
    const box = $('photo-app-status');
    if (!status.available) { box.textContent = t('photo.appMissing'); return; }
    const parts = [t('photo.appInstalled', { tag: status.installed.tag, commit: (status.installed.commit || '').slice(0, 9) })];
    if (status.latest) parts.push(status.latest.tag === status.installed.tag ? t('photo.appUpToDate', { date: formatDate(status.latest.checkedAt) }) : t('photo.appBehind', { tag: status.latest.tag, date: formatDate(status.latest.checkedAt) }));
    box.textContent = parts.join(' ');
  }

  async function checkLatest() {
    $('photo-app-check').disabled = true;
    try { renderAppStatus(await window.chatStorage.photoCheckLatest()); } catch (error) { $('photo-settings-error').textContent = error.message; }
    finally { $('photo-app-check').disabled = false; }
  }

  async function setModel(model) {
    if (!project) return;
    try {
      project = await window.chatStorage.photoSettings(project.id, { model });
      renderModelsStatus(await window.chatStorage.photoModels());
    } catch (error) { $('photo-settings-error').textContent = error.message; }
  }


  // --- the folder's chat, moved in beside the editor -------------------------------------

  let chatHome = null;
  let generalChat = null;

  window.photo = {
    current() { return project && active ? { id: project.id, name: project.project.name } : null; },
    hasProject() { return Boolean(project); },
    attach,
    detach,
    /** A file of the project's folder, opened as a document: asked by the column of the files. */
    async open(file) {
      if (!project) return false;
      try {
        // Already open: brought to view as it is, with what was done to it.
        const there = editor ? (await documents()).list.find(doc => doc.path === file) : null;
        if (there) { await exec('document.activate', { document: there.index }); window.codeWorkspace?.showing?.(file); }
        else await openFile(file);
        showError('');
        return true;
      }
      catch (error) { showError(error.message); return false; }
    },
    perform,
    /**
     * What the bar over the editor shows and asks: the open documents as its tabs, the one in view saved to its file,
     * a step back, a step forward, the zoom of the canvas, a document closed.
     */
    async bar() {
      const { list, active, zoom } = await documents();
      return { files: list.map(({ path, dirty }) => ({ path, dirty })), shown: list[active]?.path || null, zoom };
    },
    async save() {
      const { list, active } = await documents();
      if (list[active]) await perform({ op: 'save', path: list[active].path }, { source: 'user' });
    },
    undo() { return exec('edit.undo'); },
    redo() { return exec('edit.redo'); },
    zoom(what) { return exec(what === 'zoomIn' ? 'view.zoomIn' : what === 'zoomOut' ? 'view.zoomOut' : 'view.fitOnScreen'); },
    /** The editor's own preferences, asked from the bar as its menu would open them: the General page, from where the others are reached. */
    settings() { return control('ui.menu.invoke', { id: 'edit.preferences.general' }); },
    /** Export, asked from the bar: the document in view with every layer composed, as a PNG, and the name it would take. Nothing is written yet. */
    async exportImage() {
      const { list, active } = await documents();
      if (!list[active]) return null;
      const base = list[active].path.slice(list[active].path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
      return { name: `${base}.png`, bytes: await capture() };
    },
    /** The exported picture written in the folder of the project, as a step of the user. */
    async exportWrite(name, bytes) {
      const result = await window.chatStorage.photoWrite(project.id, name, toBase64(bytes), 'user');
      void refreshFiles();
      return result;
    },
    /** Closes a document. The editor closes it as it is: what is not saved is asked about here first. False when it stays open. */
    async close(file) {
      const doc = (await documents()).list.find(item => item.path === file);
      if (!doc) return true;
      if (doc.dirty) {
        const ok = await window.chatWorkspace.confirmAction({ title: t('proj.closeUnsavedTitle'), message: t('proj.closeUnsavedMessage', { name: file }), confirmText: t('proj.closeUnsavedConfirm') });
        if (!ok) return false;
      }
      await exec('file.close', { document: doc.index });
      return true;
    },
    describe,
    addGenerated,
    sourceImage,
    /** A model just saved or made a file: the list of the folder catches up. */
    async noteToolChange() { await refreshFiles(); },
    /** The editor in view or not. Once started, it stays as it is while something else is in view. */
    async setActive(on) {
      active = on;
      if (on) sendLook();
    },
    _control: control
  };

  document.addEventListener('DOMContentLoaded', () => {
    $('photo-place').addEventListener('change', event => { const file = event.target.value; event.target.value = ''; if (file) placeFile(file).then(() => showError('')).catch(error => showError(error.message)); });
    $('photo-model-warm').addEventListener('click', () => void warmModel(missingModel));
    $('photo-settings').addEventListener('click', () => void openSettings());
    $('photo-settings-close').addEventListener('click', () => $('photo-settings-dialog').close());
    $('photo-app-check').addEventListener('click', () => void checkLatest());
    $('photo-set-model').addEventListener('change', event => void setModel(event.target.value));
    $('photo-models-warm').addEventListener('click', () => void warmModel());
    $('photo-object-warm').addEventListener('click', () => void warmModel(project?.settings?.objectModel));
    $('photo-set-refine').addEventListener('change', async event => {
      if (!project) return;
      try { project = await window.chatStorage.photoSettings(project.id, { refine: event.target.checked }); }
      catch (error) { $('photo-settings-error').textContent = error.message; event.target.checked = project.settings?.refine === true; }
    });
    $('photo-models-drop').addEventListener('click', async () => {
      const ok = await window.chatWorkspace.confirmAction({ title: t('photo.modelDrop'), message: t('photo.modelDropMessage'), confirmText: t('photo.modelDrop') });
      if (!ok) return;
      try { await window.chatStorage.photoDropModels(); renderModelsStatus(await window.chatStorage.photoModels()); } catch (error) { $('photo-settings-error').textContent = error.message; }
    });
    window.addEventListener('synthorg-theme-changed', sendLook);
    window.addEventListener('synthorg-locale-changed', () => renderBar());
  });
})();
