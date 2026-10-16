/**
 * The header's small manager of the local models: which are in memory now —
 * they stay there across chats, until they are taken out — with a button to
 * free each one, and the last ones that were loaded, to load again with one
 * click. Everything else about a model (where it goes, how much context) is
 * in Settings → Local models, which this opens.
 *
 * The button says how many are loaded; the list is asked of the service
 * (server/local-models.js, `loaded`), which answers without reading the disk.
 */
(() => {
  'use strict';
  if (window.SYNTHORG_REMOTE) return;

  const t = (key, params) => window.i18n.t(key, params);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const api = (route, method = 'GET', data, timeoutMs) => window.chatStorage.request('/local-models' + route, method, data, timeoutMs);
  const LOAD_TIMEOUT_MS = 60 * 60 * 1000;
  const GIB = 1024 ** 3;
  const size = (bytes) => bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`;

  const state = { data: null, busy: new Set(), error: '', open: false };
  let button, panel;

  function memoryOf(model) {
    const parts = [];
    if (model.memory?.gpu) parts.push(t('loadedModels.video', { size: size(model.memory.gpu) }));
    if (model.memory?.ram) parts.push(t('loadedModels.system', { size: size(model.memory.ram) }));
    return parts.join(' · ');
  }

  function render() {
    const data = state.data;
    const count = data ? data.loaded.length : 0;
    const loading = data ? data.loading.length + [...state.busy].filter(id => !data.loaded.some(m => m.id === id) && !data.loading.some(m => m.id === id)).length : 0;
    button.dataset.state = loading ? 'loading' : count ? 'on' : 'off';
    button.querySelector('.header-tool-count').textContent = count ? String(count) : '';
    button.title = count ? t(count === 1 ? 'loadedModels.titleOne' : 'loadedModels.titleMany', { count }) : t('loadedModels.titleNone');
    button.setAttribute('aria-label', button.title);
    if (!state.open) return;
    if (!data) { panel.innerHTML = `<p class="loaded-models-note">${esc(state.error || t('localModels.loading'))}</p>`; return; }
    const row = (model, kind) => {
      const busy = state.busy.has(model.id);
      // How much it holds and where: the amounts say by themselves whether it is on the video card, in system memory or split.
      const detail = kind === 'loaded' ? memoryOf(model)
        : kind === 'loading' ? t('localModels.loading')
        : [model.sizeLabel, model.quantization].filter(Boolean).join(' · ');
      const action = kind === 'loaded' ? `<button type="button" class="btn" data-loaded-action="unload" data-id="${esc(model.id)}" ${busy ? 'disabled' : ''}>${esc(t('localModels.unload'))}</button>`
        : kind === 'recent' ? `<button type="button" class="btn" data-loaded-action="load" data-id="${esc(model.id)}" ${busy ? 'disabled' : ''}>${busy ? '<i class="fa-solid fa-spinner fa-spin"></i>' : esc(t('localModels.load'))}</button>`
        : '<i class="fa-solid fa-spinner fa-spin loaded-models-spin"></i>';
      return `<li class="loaded-models-row is-${kind}"><span class="loaded-models-dot"></span><span class="loaded-models-text"><span class="loaded-models-name" title="${esc(model.name)}">${esc(model.name)}</span>${detail ? `<span class="loaded-models-detail">${esc(detail)}</span>` : ''}</span>${action}</li>`;
    };
    const inMemory = [...data.loaded.map(m => row(m, 'loaded')), ...data.loading.filter(m => !data.loaded.some(l => l.id === m.id)).map(m => row(m, 'loading'))];
    panel.innerHTML = `
      <div class="loaded-models-head"><span>${esc(t('loadedModels.inMemory'))}</span>${data.loaded.length > 1 ? `<button type="button" class="loaded-models-link" data-loaded-action="unload-all">${esc(t('loadedModels.freeAll'))}</button>` : ''}</div>
      ${inMemory.length ? `<ul class="loaded-models-list">${inMemory.join('')}</ul>` : `<p class="loaded-models-note">${esc(t(data.engineAvailable ? 'loadedModels.none' : 'loadedModels.noEngine'))}</p>`}
      ${data.recent.length ? `<div class="loaded-models-head"><span>${esc(t('loadedModels.recent'))}</span></div><ul class="loaded-models-list">${data.recent.map(m => row(m, 'recent')).join('')}</ul>` : ''}
      ${state.error ? `<p class="loaded-models-error" role="alert">${esc(state.error)}</p>` : ''}
      <button type="button" class="loaded-models-link loaded-models-all" data-loaded-action="settings">${esc(t('loadedModels.all'))}</button>`;
  }

  let known = '';
  async function refresh() {
    try { state.data = await api('/loaded'); }
    catch (error) { if (state.open && !state.data) state.error = error.message; }
    render();
    // The lists of models elsewhere say which ones are in memory: they are told when that changes.
    const now = state.data ? [...state.data.loaded.map(m => m.id), '|', ...state.data.loading.map(m => m.id)].join(',') : '';
    if (now !== known) { known = now; document.dispatchEvent(new CustomEvent('synthorg-loaded-models')); }
  }

  async function act(ids, run) {
    state.error = '';
    for (const id of ids) state.busy.add(id);
    render();
    try { await run(); }
    catch (error) { state.error = error.message; }
    finally { for (const id of ids) state.busy.delete(id); await refresh(); window.localModelsView?.changed?.(); }
  }

  function setOpen(open) {
    state.open = open;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) { state.error = ''; render(); void refresh(); }
  }

  function onClick(event) {
    const target = event.target.closest('[data-loaded-action]');
    if (!target) return;
    const { loadedAction: action, id } = target.dataset;
    if (action === 'load') return void act([id], () => api('/start', 'POST', { id }, LOAD_TIMEOUT_MS));
    if (action === 'unload') return void act([id], async () => { await api('/stop', 'POST', { id }); window.modelGateway?.forgetEngine?.(id); });
    if (action === 'unload-all') {
      const ids = state.data.loaded.map(m => m.id);
      return void act(ids, async () => { for (const one of ids) { await api('/stop', 'POST', { id: one }); window.modelGateway?.forgetEngine?.(one); } });
    }
    if (action === 'settings') { setOpen(false); window.switchView('hub'); }
  }

  function start() {
    button = document.getElementById('btn-loaded-models');
    panel = document.getElementById('loaded-models-panel');
    if (!button || !panel) return;
    button.addEventListener('click', (event) => { event.stopPropagation(); setOpen(!state.open); });
    panel.addEventListener('click', (event) => { event.stopPropagation(); onClick(event); });
    document.addEventListener('click', () => { if (state.open) setOpen(false); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.open) setOpen(false); });
    render();
    void refresh();
    // Often while the list is open or something is moving, seldom otherwise: a model is also loaded by a chat's request.
    let tick = 0;
    setInterval(() => {
      tick += 1;
      const moving = state.open || state.busy.size || state.data?.loading.length;
      if (document.hidden || (!moving && tick % 4)) return;
      void refresh();
    }, 2000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  window.loadedModels = {
    refresh,
    /** 'loaded', 'loading' or null. */
    stateOf: (id) => state.data?.loaded.some(m => m.id === id) ? 'loaded' : state.data?.loading.some(m => m.id === id) ? 'loading' : null
  };
})();
