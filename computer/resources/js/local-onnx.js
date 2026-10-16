/**
 * SynthOrg - Local models, the ONNX tab.
 *
 * The models the Foto tab's functions run (cutting a subject out of a
 * picture) are ONNX files, and like the GGUF ones they are not shipped: the
 * user takes them. SynthOrg lists a few of its own in the photo settings;
 * here is everything else — a search of Hugging Face with the Hub's own ONNX
 * filter, a repository's files, and the download of one.
 *
 * A file is downloaded by a container with the network and nothing of the
 * user's in it, into the volume the functions read, and checked against the
 * hash the Hub keeps for it. Then the program reads what the file says of
 * itself: its inputs and their sizes come from there. What no file says —
 * how the pictures it was trained on were normalised — starts from the
 * ImageNet values and is edited here. A model that is ready appears in the
 * photo settings of every project, beside SynthOrg's own.
 *
 * The tab is drawn by local-models.js, which asks this file for its pane.
 */
(function () {
  'use strict';
  const t = (key, params) => window.i18n?.t(key, params || {}) || key;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const SORTS = ['trendingScore', 'downloads', 'likes', 'lastModified', 'createdAt'];
  const FOLLOW_MS = 1500;
  const locale = () => (window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT');
  const number = value => Number(value).toLocaleString(locale());
  const megabytes = bytes => `${Math.round(bytes / 1048576).toLocaleString(locale())} MB`;

  const state = {
    models: {}, warm: null, error: '',
    hub: { query: '', sort: SORTS[0], repos: [], next: null, loading: false, error: '', asked: false },
    repo: null,      // { id, loading, data, error }
    busy: new Set(), // keys and paths with a request under way
    timer: null
  };

  const redraw = () => window.localModelsView?.redraw?.();

  function follow() {
    clearTimeout(state.timer);
    if (state.warm?.state !== 'running') return;
    state.timer = setTimeout(() => void refresh(), FOLLOW_MS);
  }

  async function refresh() {
    try {
      const status = await window.chatStorage.photoOnnx();
      state.models = status.models || {};
      state.warm = status.warm || null;
      state.error = '';
    } catch (error) { state.error = error.message; }
    redraw();
    follow();
  }

  async function search(more = false) {
    const hub = state.hub;
    hub.loading = true; hub.error = ''; hub.asked = true;
    if (!more) { hub.repos = []; hub.next = null; }
    redraw();
    try {
      const page = await window.chatStorage.photoOnnxSearch({ query: hub.query, sort: hub.sort, cursor: more ? hub.next : '' });
      hub.repos = more ? hub.repos.concat(page.repos) : page.repos;
      hub.next = page.next;
    } catch (error) { hub.error = error.message; }
    hub.loading = false;
    redraw();
  }

  async function openRepo(id) {
    state.repo = { id, loading: true, data: null, error: '' };
    redraw();
    try { state.repo.data = await window.chatStorage.photoOnnxRepo(id); }
    catch (error) { state.repo.error = error.message; }
    state.repo.loading = false;
    redraw();
  }

  async function act(key, work) {
    if (state.busy.has(key)) return;
    state.busy.add(key);
    redraw();
    try {
      const status = await work();
      if (status?.models) { state.models = status.models; state.warm = status.warm || null; }
      state.error = '';
    } catch (error) { state.error = error.message; }
    state.busy.delete(key);
    redraw();
    follow();
  }

  // --- what is shown ---------------------------------------------------------------------

  /** A tensor's declared shape in words: its numbers, with the open ones named. */
  function shapeText(shape) {
    return (shape || []).map(d => (d > 0 ? number(d) : t('localOnnx.anySize'))).join(' × ');
  }

  function modelCard(key, model) {
    const downloading = state.warm?.state === 'running' && state.warm.model === key;
    const input = model.inputs?.[0];
    let status;
    if (downloading) status = `<span class="lm-status"><i class="fa-solid fa-spinner fa-spin"></i> ${t(state.warm.phase === 'describe' ? 'localOnnx.reading' : 'localOnnx.downloading')}</span>`;
    else if (model.ready) status = `<span class="lm-status lm-status-on"><i class="fa-solid fa-check"></i> ${t('localOnnx.ready')}</span>`;
    else status = `<span class="lm-status">${t('localOnnx.notUsable')}</span>`;
    const triple = (name, values) => values.map((value, index) => `<input type="number" class="lm-input lo-number" name="${name}${index}" value="${esc(value)}" step="0.001" min="0" max="255" aria-label="${t('localOnnx.' + name)} ${'RGB'[index]}">`).join('');
    const params = model.ready ? `
      <form class="lo-params" data-onnx-form="params" data-key="${esc(key)}">
        <label class="lo-field"><span>${t('localOnnx.mean')}</span><span class="lo-triple">${triple('mean', model.mean)}</span></label>
        <label class="lo-field"><span>${t('localOnnx.std')}</span><span class="lo-triple">${triple('std', model.std)}</span></label>
        ${model.size !== undefined ? `<label class="lo-field"><span>${t('localOnnx.size')}</span><input type="number" class="lm-input lo-number" name="size" value="${esc(model.size)}" step="32" min="32" max="2048"></label>` : ''}
        <button class="btn" type="submit" ${state.busy.has(key) ? 'disabled' : ''}>${t('localOnnx.save')}</button>
      </form>
      <div class="lm-file-need">${t('localOnnx.paramsHint')}</div>` : '';
    return `
      <div class="lm-file lo-model">
        <div class="lm-file-main">
          <div class="lm-card-file">${esc(model.label)}</div>
          <div class="lm-file-facts">
            <span class="tag-badge">${esc(model.repo)}</span>
            <span class="tag-badge">${t('localOnnx.licence', { name: esc(model.licence) })}</span>
            ${input ? `<span class="tag-badge tag-ctx">${t('localOnnx.input', { shape: shapeText(input.shape) })}</span>` : ''}
          </div>
          ${model.error ? `<div class="lm-error">${esc(model.error)}</div>` : ''}
          ${params}
        </div>
        <div class="lm-file-action">
          ${status}
          <button class="btn btn-danger-outline" data-onnx-action="remove" data-id="${esc(key)}" ${downloading || state.busy.has(key) ? 'disabled' : ''}><i class="fa-solid fa-trash-can"></i> ${t('localOnnx.remove')}</button>
        </div>
      </div>`;
  }

  function repoPane() {
    const repo = state.repo;
    const back = `<button class="btn" data-onnx-action="repo-back"><i class="fa-solid fa-arrow-left"></i> ${t('localModels.back')}</button>`;
    if (repo.loading) return `${back}<div class="lm-empty"><i class="fa-solid fa-spinner fa-spin"></i> ${t('localModels.repoReading', { id: esc(repo.id) })}</div>`;
    if (repo.error) return `${back}<div class="lm-error">${esc(repo.error)}</div>`;
    const data = repo.data;
    const busy = state.warm?.state === 'running';
    const rows = data.files.map(file => {
      const key = `hf:${data.id}/${file.path}`;
      const mine = state.models[key];
      let action;
      if (mine?.ready) action = `<span class="lm-status lm-status-on"><i class="fa-solid fa-check"></i> ${t('localModels.alreadyHere')}</span>`;
      else if (state.warm?.state === 'running' && state.warm.model === key) action = `<span class="lm-status"><i class="fa-solid fa-spinner fa-spin"></i> ${t('localOnnx.downloading')}</span>`;
      else if (file.external) action = `<span class="lm-status">${t('localOnnx.external')}</span>`;
      else action = `<button class="btn btn-primary" data-onnx-action="add" data-id="${esc(file.path)}" ${busy || state.busy.has(file.path) ? 'disabled' : ''}><i class="fa-solid fa-download"></i> ${t('localModels.download')}</button>`;
      return `
        <div class="lm-file">
          <div class="lm-file-main">
            <div class="lm-card-file">${esc(file.path)}</div>
            <div class="lm-file-facts"><span class="tag-badge"><i class="fa-solid fa-hard-drive"></i> ${megabytes(file.size)}</span></div>
          </div>
          <div class="lm-file-action">${action}</div>
        </div>`;
    }).join('');
    return `
      ${back}
      <div class="lm-repo-head">
        <div class="lm-repo-title">${esc(data.id)} ${data.gated ? `<span class="tag-badge tag-batch"><i class="fa-solid fa-lock"></i> ${t('localModels.gated')}</span>` : ''}</div>
        <div class="lm-repo-url">https://huggingface.co/${esc(data.id)}</div>
        <div class="lm-file-need">${t('localOnnx.licence', { name: esc(data.license || t('localOnnx.licenceUnknown')) })}</div>
        ${data.gated ? `<div class="lm-error">${t('localOnnx.gatedNote')}</div>` : ''}
      </div>
      ${rows || `<div class="lm-empty">${t('localOnnx.repoNoFiles')}</div>`}`;
  }

  function pane() {
    const mine = Object.entries(state.models).map(([key, model]) => modelCard(key, model)).join('');
    const head = `
      <p class="env-subtext">${t('localOnnx.intro')}</p>
      ${state.error ? `<div class="lm-error">${esc(state.error)}</div>` : ''}
      <div class="lm-section-title">${t('localOnnx.mine')}</div>
      ${mine || `<div class="lm-empty">${t('localOnnx.mineEmpty')}</div>`}
      <div class="lm-section-title">${t('localOnnx.searchTitle')}</div>`;
    if (state.repo) return head + repoPane();
    const hub = state.hub;
    const list = hub.repos.map(repo => `
      <button class="lm-repo" data-onnx-action="repo" data-id="${esc(repo.id)}">
        <span class="lm-repo-name">${esc(repo.id)}</span>
        <span class="model-tags-row">
          <span class="tag-badge"><i class="fa-solid fa-download"></i> ${number(repo.downloads)}</span>
          <span class="tag-badge"><i class="fa-regular fa-heart"></i> ${number(repo.likes)}</span>
          ${repo.gated ? `<span class="tag-badge tag-batch"><i class="fa-solid fa-lock"></i> ${t('localModels.gated')}</span>` : ''}
        </span>
        ${repo.lastModified ? `<span class="lm-repo-date">${t('localModels.updated', { date: new Date(repo.lastModified).toLocaleDateString(locale(), { dateStyle: 'medium' }) })}</span>` : ''}
      </button>`).join('');
    return `${head}
      <form class="lm-search" data-onnx-form="search">
        <div class="fuzzy-search-wrap">
          <i class="fa-solid fa-magnifying-glass search-icon"></i>
          <input type="text" name="query" value="${esc(hub.query)}" placeholder="${t('localOnnx.searchPlaceholder')}" spellcheck="false" autocomplete="off">
        </div>
        <select class="select-control" name="sort" data-onnx-hub="sort">
          ${SORTS.map(sort => `<option value="${sort}" ${hub.sort === sort ? 'selected' : ''}>${t('localModels.sort_' + sort)}</option>`).join('')}
        </select>
        <button class="btn btn-primary" type="submit">${t('localModels.search')}</button>
      </form>
      ${hub.error ? `<div class="lm-error">${esc(hub.error)}</div>` : ''}
      ${list}
      ${hub.loading ? `<div class="lm-empty"><i class="fa-solid fa-spinner fa-spin"></i> ${t('localModels.searching')}</div>` : ''}
      ${!hub.loading && hub.asked && !hub.repos.length && !hub.error ? `<div class="lm-empty">${t('localModels.searchEmpty')}</div>` : ''}
      ${!hub.loading && hub.next ? `<button class="btn lm-more" data-onnx-action="more">${t('localModels.more')}</button>` : ''}`;
  }

  // --- what the user does ----------------------------------------------------------------------

  function onClick(event) {
    const target = event.target.closest('[data-onnx-action]');
    if (!target) return;
    const { onnxAction: action, id } = target.dataset;
    switch (action) {
      case 'repo': return void openRepo(id);
      case 'repo-back': state.repo = null; return redraw();
      case 'more': return void search(true);
      case 'add': return void act(id, () => window.chatStorage.photoOnnxAdd(state.repo.data.id, id));
      case 'remove': return void act(id, () => window.chatStorage.photoOnnxRemove(id));
      default:
    }
  }

  function onSubmit(event) {
    const form = event.target.closest('[data-onnx-form]');
    if (!form) return;
    event.preventDefault();
    if (form.dataset.onnxForm === 'search') {
      state.hub.query = form.elements.query.value;
      form.elements.query.blur();
      void search();
    } else if (form.dataset.onnxForm === 'params') {
      const read = name => [0, 1, 2].map(index => Number(form.elements[`${name}${index}`].value));
      const change = { mean: read('mean'), std: read('std') };
      if (form.elements.size) change.size = Number(form.elements.size.value);
      document.activeElement?.blur?.();
      void act(form.dataset.key, () => window.chatStorage.photoOnnxSet(form.dataset.key, change));
    }
  }

  function onChange(event) {
    const field = event.target.closest('[data-onnx-hub]');
    if (!field) return;
    state.hub[field.dataset.onnxHub] = field.value;
    state.hub.query = field.form?.elements.query?.value ?? state.hub.query;
    void search();
  }

  window.localOnnx = {
    pane,
    /** The tab was opened: what the user has, and a first page of the Hub. */
    opened(host) {
      if (host && !host.dataset.onnxBound) {
        host.dataset.onnxBound = '1';
        host.addEventListener('click', onClick);
        host.addEventListener('submit', onSubmit);
        host.addEventListener('change', onChange);
      }
      void refresh();
      if (!state.hub.asked) void search();
    }
  };
})();
