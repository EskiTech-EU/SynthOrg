/**
 * Settings → Local models: the GGUF models on this computer and the Hugging
 * Face browser to get more.
 *
 * Everything shown about a model is what its GGUF header states and, once it
 * is loaded, what the engine reports (server/local-models.js): nothing here is
 * read out of a file name. Several models stay loaded at once; where each one
 * goes — video card, system memory, split — and how much context it gets are
 * the user's choices, sized against the memory free right now.
 */
(() => {
  'use strict';

  const t = (key, params) => window.i18n.t(key, params);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const api = (route, method = 'GET', data, timeoutMs) => window.chatStorage.request('/local-models' + route, method, data, timeoutMs);
  // Loading a model is bounded by its size and the disk, not by a timer.
  const LOAD_TIMEOUT_MS = 60 * 60 * 1000;
  const FOLLOW_MS = 1500;
  const GIB = 1024 ** 3;
  // The engine keeps this much video memory free when it places a model by itself.
  const FIT_MARGIN = 256 * 1024 * 1024;
  const SORTS = ['trendingScore', 'downloads', 'likes', 'lastModified', 'createdAt'];
  const PLACEMENTS = ['auto', 'gpu', 'cpu', 'split'];
  // What the search can be narrowed by; each is a filter of the Hub's own API (server/hf-hub.js).
  const SIZES = ['upTo3', '3to8', '8to16', '16to40', 'over40'];
  const ACCESS = ['open', 'gated'];
  // Licence identifiers as the Hub writes them; 'other' is its own word for one not in its list.
  const LICENSES = ['apache-2.0', 'mit', 'bsd-3-clause', 'cc-by-4.0', 'cc-by-sa-4.0', 'cc-by-nc-4.0', 'cc-by-nc-sa-4.0',
    'openrail', 'gemma', 'llama3.1', 'llama3.2', 'llama3.3', 'gpl-3.0', 'agpl-3.0', 'other'];
  const FILTERS = ['size', 'license', 'author', 'access'];

  const state = {
    tab: 'installed',
    listing: null,
    downloads: [],
    error: '',
    busy: new Set(),      // model ids with a request under way
    open: new Set(),      // model ids whose loading options are shown
    confirming: null,     // model id waiting for the second click on delete
    roles: [],            // the roles a model can be given, as Settings → Ruoli lists them
    hub: { query: '', kind: 'text', sort: SORTS[0], size: '', license: '', author: '', access: '', repos: [], next: null, loading: false, error: '', asked: false },
    repo: null,           // { id, loading, data, error }
    token: { set: false, editing: false },
    timer: null
  };

  const locale = () => (window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT');
  const number = (value) => Number(value).toLocaleString(locale());
  const size = (bytes) => (bytes >= GIB
    ? `${(bytes / GIB).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`
    : `${Math.round(bytes / (1024 * 1024)).toLocaleString(locale())} MB`);
  const count = (value) => {
    if (value >= 1e9) return `${(value / 1e9).toLocaleString(locale(), { maximumFractionDigits: 1 })} ${t('localModels.billion')}`;
    if (value >= 1e6) return `${(value / 1e6).toLocaleString(locale(), { maximumFractionDigits: 0 })} ${t('localModels.million')}`;
    return number(value);
  };

  const host = () => document.getElementById('hub-host');
  const visible = () => { const el = host(); return Boolean(el && el.offsetParent !== null); };

  // --- memory arithmetic, on the numbers the header and the engine give

  /** Video memory a new model can count on: free, less what loaded models reserved and have not used yet. */
  function videoAvailable(memory) {
    const free = (memory?.devices || []).reduce((sum, device) => sum + device.free, 0);
    return Math.max(0, free - (memory?.promised || 0) - FIT_MARGIN);
  }

  /** What a model takes at a context: weights (and projector) plus the attention cache. */
  function needs(weights, kvBytesPerToken, context) {
    const cache = kvBytesPerToken && context ? kvBytesPerToken * context : null;
    return { weights, cache, total: weights + (cache || 0) };
  }

  /** Where a model of that size ends up with the memory free now. */
  function fitOf(need, memory) {
    const video = videoAvailable(memory);
    const system = memory?.ram?.free || 0;
    if ((memory?.devices || []).length && need.total <= video) return 'gpu';
    if ((memory?.devices || []).length && video > 0 && need.total <= video + system) return 'split';
    if (need.total <= system) return 'cpu';
    return 'none';
  }

  /**
   * The longest context each placement can hold with the memory free now, capped at what the
   * model declares: null where the weights alone do not fit there or the file gives no cache size.
   */
  function contextLimits(weights, kvBytesPerToken, declared, memory) {
    if (!kvBytesPerToken || !memory) return null;
    const hasVideo = (memory.devices || []).length > 0;
    const video = hasVideo ? videoAvailable(memory) : 0;
    const system = memory.ram?.free || 0;
    const reach = (budget) => {
      if (budget <= weights) return null;
      const tokens = Math.floor((budget - weights) / kvBytesPerToken);
      return declared ? Math.min(tokens, declared) : tokens;
    };
    return {
      gpu: hasVideo ? reach(video) : null,
      cpu: reach(system),
      split: hasVideo && video > 0 ? reach(video + system) : null
    };
  }

  function limitsLine(limits) {
    const part = (key, value) => `${t('localModels.limit_' + key)}: ${value ? number(value) : t('localModels.limitNone')}`;
    return t('localModels.limitsTitle') + ' ' + ['gpu', 'cpu', 'split'].map(key => part(key, limits[key])).join(' · ');
  }

  // --- data

  async function refresh() {
    try {
      const [listing, downloads] = await Promise.all([api(''), api('/downloads')]);
      const before = state.listing ? state.listing.models.map(m => m.id + m.contextLength + m.vision).join('|') : null;
      const finished = state.downloads.some(job => !downloads.downloads.find(now => now.id === job.id));
      state.listing = listing;
      state.downloads = downloads.downloads;
      state.error = '';
      // The lists of the roles are built on the same models: the catalogue is told when they
      // change, and when it does not have them yet.
      const after = listing.models.map(m => m.id + m.contextLength + m.vision).join('|');
      const here = listing.models.filter(m => m.readable).map(m => m.id).sort().join('|');
      const known = (window.openRouterCatalog?.models || []).filter(m => m.isLocal).map(m => m.id).sort().join('|');
      if (listing.engineAvailable && ((before !== null && (before !== after || finished)) || here !== known)) await window.openRouterCatalog?.mergeLocalModels?.();
      state.roles = readRoles();
    } catch (error) {
      state.error = error.message;
    }
    render();
    follow();
  }

  /**
   * The roles of Settings → Ruoli, each with the local models it accepts and the model it has
   * now. What a role accepts is decided there, on what each model can do: nothing is decided here.
   */
  function readRoles() {
    const items = window.operationalRegistry?.getAllConfigurableItems?.() || [];
    return items.filter(item => !item.isNativeEngine).map(item => ({
      id: item.id, type: item.type, name: item.name, icon: item.icon || '',
      // A tool covered by the Master has no model of its own.
      assigned: item.type === 'tool' && item.isNativeCovered ? null : (item.assignedModelId || null),
      accepts: new Set((item.eligibleModels || []).filter(m => m.isLocal).map(m => m.id))
    }));
  }

  /** Gives a role this model, or (a tool, with no model) hands the tool back to the Master. */
  function assignRole(roleId, modelId) {
    const registry = window.operationalRegistry;
    const role = state.roles.find(entry => entry.id === roleId);
    if (!registry || !role) return;
    let taken = true;
    if (role.type === 'master') taken = registry.setSelectedMasterId(modelId);
    else if (role.type === 'microtask') taken = registry.setSelectedMicrotaskId(modelId);
    else if (role.type === 'realtime_multi') taken = registry.setSelectedRealtimeMultiId(modelId);
    else registry.setToolDelegate(role.id, modelId || 'auto');
    state.error = taken === false ? t('localModels.roleRefused') : '';
    state.roles = readRoles();
    try { window.chatManager?.renderChatHeader?.(); } catch {}
    document.dispatchEvent(new CustomEvent('synthorg-roles-changed'));
    render(true);
  }

  /** While something moves — a download, a model loading — the page keeps up with it. */
  function follow() {
    clearTimeout(state.timer);
    const moving = state.downloads.some(job => job.status === 'running') || state.listing?.models.some(m => m.loading) || state.busy.size;
    if (moving && (visible() || mounts.size)) state.timer = setTimeout(refresh, FOLLOW_MS);
  }

  async function act(key, work) {
    state.busy.add(key);
    render();
    try { await work(); state.error = ''; } catch (error) { state.error = error.message; }
    state.busy.delete(key);
    await refresh();
    // The header's manager shows the same models: it is told at once, not at its next look.
    window.loadedModels?.refresh();
  }

  async function search(more = false) {
    const hub = state.hub;
    if (hub.loading) return;
    hub.loading = true; hub.error = ''; hub.asked = true;
    if (!more) { hub.repos = []; hub.next = null; }
    render();
    try {
      const params = new URLSearchParams(more && hub.next ? { cursor: hub.next } : { q: hub.query, kind: hub.kind, sort: hub.sort });
      if (!(more && hub.next)) { for (const key of FILTERS) { if (hub[key]) params.set(key, hub[key]); } }
      const page = await api('/hub?' + params, 'GET', undefined, 40000);
      hub.repos = more ? [...hub.repos, ...page.repos] : page.repos;
      hub.next = page.next;
    } catch (error) {
      hub.error = error.message;
    }
    hub.loading = false;
    render();
  }

  async function openRepo(id) {
    state.repo = { id, loading: true, data: null, error: '' };
    render();
    refresh(); // the files are sized against the memory free now
    try {
      state.repo.data = await api('/repo?id=' + encodeURIComponent(id), 'GET', undefined, 60000);
    } catch (error) {
      state.repo.error = error.message;
    }
    state.repo.loading = false;
    render();
  }

  async function readToken() {
    try { state.token.set = Boolean((await window.chatStorage.getSetting('huggingface_token'))?.value); } catch {}
  }

  // --- drawing

  function memoryStrip(memory) {
    const devices = (memory?.devices || []).map(device => {
      const promised = memory.promised ? ` · ${t('localModels.memoryPromised', { size: size(memory.promised) })}` : '';
      return `<span class="lm-memory-item"><i class="fa-solid fa-microchip"></i> ${esc(device.name)}: ${t('localModels.memoryFree', { free: size(device.free), total: size(device.total) })}${promised}</span>`;
    });
    if (!devices.length) devices.push(`<span class="lm-memory-item"><i class="fa-solid fa-microchip"></i> ${t('localModels.memoryNoDevice')}</span>`);
    const ram = memory?.ram ? `<span class="lm-memory-item"><i class="fa-solid fa-memory"></i> ${t('localModels.memorySystem')}: ${t('localModels.memoryFree', { free: size(memory.ram.free), total: size(memory.ram.total) })}</span>` : '';
    return `<div class="lm-memory">${devices.join('')}${ram}</div>`;
  }

  function placementText(running) {
    const layers = running.gpuLayers;
    if (layers && layers.onGpu === 0) return t('localModels.runningCpu');
    if (layers && layers.onGpu >= layers.total) return t('localModels.runningGpu');
    if (layers) return t('localModels.runningSplit', { on: layers.onGpu, total: layers.total });
    return t('localModels.placement_' + running.placement);
  }

  function launchPanel(model, memory) {
    const launch = model.launch;
    const context = launch.context || model.declaredContext;
    const need = needs(model.size + model.projectorSize, model.kvBytesPerToken, context);
    // The memory this model already holds is free again for it when it is loaded anew.
    const own = model.running ? model.running.memory : { gpu: 0, ram: 0 };
    const video = videoAvailable(memory) + (model.running ? Math.min(own.gpu, (memory.devices || []).reduce((sum, d) => sum + d.total, 0)) : 0);
    const fits = (memory.devices || []).length ? need.total <= video : false;
    const lines = [];
    const limits = contextLimits(need.weights, model.kvBytesPerToken, model.declaredContext, memory);
    const everything = Object.values(limits || {}).some(value => value);
    if (limits && !everything) {
      lines.push(t('localModels.weightsLine', { weights: size(need.weights) }), t('localModels.weightsTooBig'));
    } else {
      lines.push(need.cache !== null
        ? t('localModels.needWithCache', { weights: size(need.weights), cache: size(need.cache), context: number(context), total: size(need.total) })
        : t('localModels.needWeightsOnly', { weights: size(need.weights) }));
      if (limits && need.total > video) lines.push(limitsLine(limits));
    }
    if ((memory.devices || []).length) {
      lines.push(fits ? t('localModels.fitsVideo', { free: size(video) }) : t('localModels.fitsVideoNot', { free: size(video) }));
      if (!fits && model.kvBytesPerToken && video > need.weights) {
        lines.push(t('localModels.contextThatFits', { context: number(Math.floor((video - need.weights) / model.kvBytesPerToken)) }));
      }
    }
    const projectors = state.listing.projectors || [];
    return `
      <div class="lm-launch">
        <label class="lm-field">
          <span>${t('localModels.placement')}</span>
          <select class="select-control" data-lm-launch="placement" data-id="${esc(model.id)}">
            ${PLACEMENTS.map(p => `<option value="${p}" ${launch.placement === p ? 'selected' : ''}>${t('localModels.placement_' + p)}</option>`).join('')}
          </select>
          <small>${t('localModels.placementHint_' + launch.placement)}</small>
        </label>
        ${launch.placement === 'split' ? `
        <label class="lm-field">
          <span>${t('localModels.gpuLayers')}</span>
          <input type="number" class="lm-input" min="0" step="1" value="${launch.gpuLayers ?? 0}" data-lm-launch="gpuLayers" data-id="${esc(model.id)}">
          <small>${model.layers ? t('localModels.gpuLayersHint', { layers: model.layers + 1 }) : ''}</small>
        </label>` : ''}
        <label class="lm-field">
          <span>${t('localModels.context')}</span>
          <input type="number" class="lm-input" min="1" step="1" ${model.declaredContext ? `max="${model.declaredContext}"` : ''} value="${launch.context ?? ''}" placeholder="${model.declaredContext ? number(model.declaredContext) : ''}" data-lm-launch="context" data-id="${esc(model.id)}">
          <small>${model.declaredContext ? t('localModels.contextHint', { context: number(model.declaredContext) }) : t('localModels.contextHintUnknown')}</small>
        </label>
        ${projectors.length ? `
        <label class="lm-field">
          <span>${t('localModels.projector')}</span>
          <select class="select-control" data-lm-launch="projector" data-id="${esc(model.id)}">
            <option value="">${t('localModels.projectorNone')}</option>
            ${projectors.map(name => `<option value="${esc(name)}" ${model.projector === name ? 'selected' : ''}>${esc(name)}</option>`).join('')}
          </select>
          <small>${t('localModels.projectorHint')}</small>
        </label>` : ''}
        <div class="lm-estimate">${lines.map(line => `<div>${line}</div>`).join('')}</div>
        ${model.running ? `<div class="lm-estimate lm-note">${t('localModels.appliesNextLoad')} <button class="btn" data-lm-action="reload" data-id="${esc(model.id)}">${t('localModels.reload')}</button></div>` : ''}
      </div>`;
  }

  /** The roles this model has, and the ones it can be given. */
  function rolesLine(model) {
    const has = state.roles.filter(role => role.assigned === model.id);
    const can = state.roles.filter(role => role.accepts.has(model.id) && role.assigned !== model.id);
    if (!has.length && !can.length) return '';
    // Every role the model can take is there to be pressed, as many as wanted: the ones it has are lit.
    // A role is left by giving it another model; a tool, by handing it back to the Master.
    const chip = (role, on) => `
      <button type="button" class="role-chip ${on ? 'is-on' : ''}" aria-pressed="${on}" data-lm-action="${on ? 'role-clear' : 'role-give'}" data-id="${esc(role.id)}" data-model="${esc(model.id)}"
        ${on && role.type !== 'tool' ? 'disabled' : ''} title="${esc(on ? (role.type === 'tool' ? t('localModels.roleClear') : t('localModels.roleKept')) : t('localModels.roleGive', { role: role.name }))}">${role.icon} ${esc(role.name)}</button>`;
    return `<div class="lm-roles"><span class="lm-roles-label">${t('localModels.rolesLabel')}</span>${has.map(role => chip(role, true)).join('')}${can.map(role => chip(role, false)).join('')}</div>`;
  }

  /**
   * One model as the roles page shows it beside its parameters (main.js): whether it is in memory, the buttons to
   * load and free it, and how it is loaded — the same controls as in this page, on the same state.
   */
  function sectionOf(id) {
    if (!state.listing) return `<div class="lm-section"><span class="lm-status"><i class="fa-solid fa-spinner fa-spin"></i> ${t('localModels.loading')}</span></div>`;
    const current = model(id);
    if (!current) return '';
    const busy = state.busy.has(id) || current.loading;
    let status;
    if (busy && !current.running) status = `<span class="lm-status"><i class="fa-solid fa-spinner fa-spin"></i> ${t('localModels.loading')}</span>`;
    else if (current.running) {
      const r = current.running;
      status = `<span class="lm-status lm-status-on"><i class="fa-solid fa-circle"></i> ${t('localModels.runningLine', { where: placementText(r), context: number(r.context), video: size(r.memory.gpu), system: size(r.memory.ram) })}</span>`;
    } else status = `<span class="lm-status">${t('localModels.notLoaded')}</span>`;
    return `
      <div class="lm-section">
        <div class="params-section-title"><i class="fa-solid fa-hard-drive"></i> ${t('localModels.sectionTitle')}</div>
        <div class="lm-section-head">
          ${status}
          ${current.running
            ? `<button class="btn" data-lm-action="unload" data-id="${esc(id)}" ${busy ? 'disabled' : ''}>${t('localModels.unload')}</button>`
            : `<button class="btn btn-primary" data-lm-action="load" data-id="${esc(id)}" ${busy ? 'disabled' : ''}>${t('localModels.load')}</button>`}
        </div>
        ${state.error ? `<div class="lm-error">${esc(state.error)}</div>` : ''}
        ${launchPanel(current, state.listing.memory)}
      </div>`;
  }

  const mounts = new Map(); // element → model id
  function drawMounts(force = false) {
    for (const [el, id] of mounts) {
      if (!el.isConnected) { mounts.delete(el); continue; }
      if (!force && el.contains(document.activeElement) && document.activeElement.matches('input[type="number"]')) continue;
      el.innerHTML = sectionOf(id);
    }
  }
  function mount(el, id) {
    if (!el) return;
    if (!el.dataset.bound) {
      el.dataset.bound = '1';
      el.addEventListener('click', onClick);
      el.addEventListener('change', onChange);
    }
    mounts.set(el, id);
    el.innerHTML = sectionOf(id);
    refresh();
  }

  function modelCard(model, memory) {
    const busy = state.busy.has(model.id) || model.loading;
    const tags = [];
    if (model.quantization) tags.push(`<span class="tag-badge">${esc(model.quantization)}</span>`);
    if (model.parameterCount) tags.push(`<span class="tag-badge">${t('localModels.parameters', { count: count(model.parameterCount) })}</span>`);
    if (model.declaredContext) tags.push(`<span class="tag-badge tag-ctx"><i class="fa-solid fa-database"></i> ${number(model.declaredContext)} ctx</span>`);
    tags.push(`<span class="tag-badge"><i class="fa-solid fa-hard-drive"></i> ${size(model.size + model.projectorSize)}</span>`);
    if (model.thinking) tags.push(`<span class="tag-badge tag-reason"><i class="fa-solid fa-brain"></i> Reasoning</span>`);
    if (model.vision) tags.push(`<span class="tag-badge tag-struct"><i class="fa-solid fa-image"></i> ${t('localModels.vision')}</span>`);
    if (model.architecture) tags.push(`<span class="tag-badge">${esc(model.architecture)}</span>`);

    let status;
    if (!model.readable) status = `<span class="lm-status lm-status-bad"><i class="fa-solid fa-triangle-exclamation"></i> ${t('localModels.unreadable')}</span>`;
    else if (busy && !model.running) status = `<span class="lm-status"><i class="fa-solid fa-spinner fa-spin"></i> ${t('localModels.loading')}</span>`;
    else if (model.running) {
      const r = model.running;
      status = `<span class="lm-status lm-status-on"><i class="fa-solid fa-circle"></i> ${t('localModels.runningLine', {
        where: placementText(r), context: number(r.context), video: size(r.memory.gpu), system: size(r.memory.ram)
      })}</span>`;
    } else status = `<span class="lm-status">${t('localModels.notLoaded')}</span>`;

    const confirming = state.confirming === model.id;
    return `
      <div class="lm-card ${model.running ? 'is-running' : ''}">
        <div class="lm-card-main">
          <div class="lm-card-title">
            <span class="model-name">${esc(model.name)}</span>
            ${model.source ? `<span class="model-provider-badge">${esc(model.source.repo)}</span>` : ''}
          </div>
          <div class="lm-card-file">${esc(model.file)}</div>
          ${model.description ? `<div class="lm-card-desc">${esc(model.description)}</div>` : ''}
          <div class="model-tags-row">${tags.join('')}</div>
          <div>${status}</div>
          ${model.readable ? rolesLine(model) : ''}
        </div>
        <div class="lm-card-actions">
          ${model.readable ? (model.running
            ? `<button class="btn" data-lm-action="unload" data-id="${esc(model.id)}" ${busy ? 'disabled' : ''}>${t('localModels.unload')}</button>`
            : `<button class="btn btn-primary" data-lm-action="load" data-id="${esc(model.id)}" ${busy ? 'disabled' : ''}>${t('localModels.load')}</button>`) : ''}
          ${model.readable ? `<button class="btn" data-lm-action="options" data-id="${esc(model.id)}" aria-expanded="${state.open.has(model.id)}"><i class="fa-solid fa-sliders"></i> ${t('localModels.options')}</button>` : ''}
          <button class="btn btn-danger-outline" data-lm-action="${confirming ? 'remove' : 'ask-remove'}" data-id="${esc(model.id)}" ${busy ? 'disabled' : ''}>${confirming ? t('localModels.removeConfirm') : t('localModels.remove')}</button>
        </div>
        ${model.readable && state.open.has(model.id) ? launchPanel(model, memory) : ''}
      </div>`;
  }

  function downloadRow(job) {
    const percent = job.total ? Math.min(100, (job.received / job.total) * 100) : 0;
    const label = job.status === 'running' ? t('localModels.downloadRunning')
      : job.status === 'failed' ? esc(job.error || t('localModels.downloadFailed'))
      : t('localModels.downloadPaused');
    return `
      <div class="lm-download">
        <div class="lm-download-head">
          <span class="lm-card-file">${esc(job.name)}</span>
          <span class="lm-download-figures">${size(job.received)} / ${size(job.total)} · ${percent.toLocaleString(locale(), { maximumFractionDigits: 0 })}%</span>
        </div>
        <div class="lm-bar"><div class="lm-bar-fill" style="width:${percent.toFixed(1)}%"></div></div>
        <div class="lm-download-foot">
          <span class="lm-status ${job.status === 'failed' ? 'lm-status-bad' : ''}">${label}</span>
          <span class="lm-download-actions">
            ${job.status === 'running'
              ? `<button class="btn" data-lm-action="download-stop" data-id="${esc(job.id)}">${t('localModels.downloadStop')}</button>`
              : `<button class="btn" data-lm-action="download-resume" data-id="${esc(job.id)}">${t('localModels.downloadResume')}</button>`}
            <button class="btn btn-danger-outline" data-lm-action="download-discard" data-id="${esc(job.id)}">${t('localModels.downloadDiscard')}</button>
          </span>
        </div>
      </div>`;
  }

  function installedPane() {
    const listing = state.listing;
    if (!listing) return `<div class="lm-empty">${t('localModels.reading')}</div>`;
    if (!listing.engineAvailable) return `<div class="lm-empty">${t('localModels.noEngine')}</div>`;
    const downloads = state.downloads.length ? `<div class="lm-section-title">${t('localModels.downloadsTitle')}</div>${state.downloads.map(downloadRow).join('')}` : '';
    const models = listing.models.length
      ? listing.models.map(model => modelCard(model, listing.memory)).join('')
      : `<div class="lm-empty">${t('localModels.empty')}</div>`;
    return `${memoryStrip(listing.memory)}${downloads}
      <div class="lm-section-title">${t('localModels.installedTitle')} <span class="lm-folder" title="${esc(listing.modelsDir)}">${esc(listing.modelsDir)}</span></div>
      ${models}`;
  }

  function tokenBox() {
    const token = state.token;
    if (!token.editing) {
      return `<button class="btn" data-lm-action="token-edit"><i class="fa-solid fa-key"></i> ${t(token.set ? 'localModels.tokenSet' : 'localModels.tokenUnset')}</button>`;
    }
    return `
      <form class="lm-token" data-lm-form="token">
        <input type="password" class="lm-input" name="token" placeholder="hf_…" autocomplete="off" spellcheck="false">
        <button class="btn btn-primary" type="submit">${t('localModels.tokenSave')}</button>
        ${token.set ? `<button class="btn btn-danger-outline" type="button" data-lm-action="token-clear">${t('localModels.tokenClear')}</button>` : ''}
        <button class="btn" type="button" data-lm-action="token-cancel">${t('localModels.cancel')}</button>
        <small>${t('localModels.tokenHint')}</small>
      </form>`;
  }

  function repoRow(repo) {
    const tags = [];
    if (repo.parameterCount) tags.push(`<span class="tag-badge">${t('localModels.parameters', { count: count(repo.parameterCount) })}</span>`);
    if (repo.contextLength) tags.push(`<span class="tag-badge tag-ctx"><i class="fa-solid fa-database"></i> ${number(repo.contextLength)} ctx</span>`);
    if (repo.architecture) tags.push(`<span class="tag-badge">${esc(repo.architecture)}</span>`);
    tags.push(`<span class="tag-badge"><i class="fa-solid fa-download"></i> ${number(repo.downloads)}</span>`);
    tags.push(`<span class="tag-badge"><i class="fa-regular fa-heart"></i> ${number(repo.likes)}</span>`);
    if (repo.license) tags.push(`<span class="tag-badge"><i class="fa-solid fa-scale-balanced"></i> ${esc(repo.license)}</span>`);
    if (repo.gated) tags.push(`<span class="tag-badge tag-batch"><i class="fa-solid fa-lock"></i> ${t('localModels.gated')}</span>`);
    return `
      <button class="lm-repo" data-lm-action="repo" data-id="${esc(repo.id)}">
        <span class="lm-repo-name">${esc(repo.id)}</span>
        ${repo.baseModel ? `<span class="lm-repo-date">${t('localModels.baseModel', { name: esc(repo.baseModel) })}</span>` : ''}
        <span class="model-tags-row">${tags.join('')}</span>
        ${repo.lastModified ? `<span class="lm-repo-date">${t('localModels.updated', { date: new Date(repo.lastModified).toLocaleDateString(locale(), { dateStyle: 'medium' }) })}</span>` : ''}
      </button>`;
  }

  function repoPane() {
    const repo = state.repo;
    const back = `<button class="btn" data-lm-action="repo-back"><i class="fa-solid fa-arrow-left"></i> ${t('localModels.back')}</button>`;
    if (repo.loading) return `${back}<div class="lm-empty"><i class="fa-solid fa-spinner fa-spin"></i> ${t('localModels.repoReading', { id: esc(repo.id) })}</div>`;
    if (repo.error) return `${back}<div class="lm-error">${esc(repo.error)}</div>`;
    const data = repo.data;
    const memory = state.listing?.memory;
    const header = data.header || {};
    const context = header.contextLength || data.contextLength;
    const installed = new Set((state.listing?.models || []).map(m => m.file));
    const facts = [
      data.parameterCount ? t('localModels.parameters', { count: count(data.parameterCount) }) : null,
      context ? t('localModels.declaredContext', { context: number(context) }) : null,
      data.architecture ? t('localModels.architecture', { name: esc(data.architecture) }) : null,
      data.license ? t('localModels.license', { name: esc(data.license) }) : null,
      data.baseModel ? t('localModels.baseModel', { name: esc(data.baseModel) }) : null,
      header.templateThinking ? 'Reasoning' : null,
      data.projectors.length ? t('localModels.vision') : null
    ].filter(Boolean);
    const sampling = Object.entries(header.sampling || {}).map(([key, value]) => `${esc(key)} ${number(value)}`).join(' · ');
    const rows = data.models.map(model => {
      const projector = data.projectors.find(p => p.path === model.projectorPath);
      const weights = model.size + (projector ? projector.size : 0);
      const need = needs(weights, header.kvBytesPerToken, context);
      let fit = memory ? fitOf(need, memory) : null;
      const limits = contextLimits(weights, header.kvBytesPerToken, context, memory);
      // Too big at the declared context but fine at a shorter one: say how long, not "no".
      if (fit === 'none' && limits && Object.values(limits).some(value => value)) fit = 'limited';
      const job = state.downloads.find(d => d.id === model.name);
      let action;
      if (installed.has(model.name)) action = `<span class="lm-status lm-status-on"><i class="fa-solid fa-check"></i> ${t('localModels.alreadyHere')}</span>`;
      else if (job) action = `<span class="lm-status">${job.status === 'running' ? t('localModels.downloadRunning') : t('localModels.downloadPaused')} · ${job.total ? Math.floor((job.received / job.total) * 100) : 0}%</span>`;
      else action = `<button class="btn btn-primary" data-lm-action="download" data-id="${esc(model.path)}" ${state.busy.has(model.path) ? 'disabled' : ''}><i class="fa-solid fa-download"></i> ${t('localModels.download')}</button>`;
      return `
        <div class="lm-file">
          <div class="lm-file-main">
            <div class="lm-card-file">${esc(model.name)}${model.parts.length > 1 ? ` · ${t('localModels.parts', { count: model.parts.length })}` : ''}</div>
            <div class="lm-file-facts">
              ${model.quantization ? `<span class="tag-badge">${esc(model.quantization)}</span>` : ''}
              <span class="tag-badge"><i class="fa-solid fa-hard-drive"></i> ${size(weights)}</span>
              ${projector ? `<span class="tag-badge tag-struct" title="${esc(projector.name)}"><i class="fa-solid fa-image"></i> ${t('localModels.withProjector', { size: size(projector.size) })}</span>` : ''}
              ${fit ? `<span class="tag-badge lm-fit-${fit}">${t('localModels.fit_' + fit)}</span>` : ''}
            </div>
            ${need.cache !== null && fit !== 'limited' ? `<div class="lm-file-need">${t('localModels.needWithCache', { weights: size(need.weights), cache: size(need.cache), context: number(context), total: size(need.total) })}</div>` : ''}
            ${fit === 'limited' ? `<div class="lm-file-need">${t('localModels.weightsLine', { weights: size(need.weights) })}</div><div class="lm-file-need">${limitsLine(limits)}</div>` : ''}
          </div>
          <div class="lm-file-action">${action}</div>
        </div>`;
    }).join('');
    return `
      ${back}
      <div class="lm-repo-head">
        <div class="lm-repo-title">${esc(data.id)} ${data.gated ? `<span class="tag-badge tag-batch"><i class="fa-solid fa-lock"></i> ${t('localModels.gated')}</span>` : ''}</div>
        <div class="lm-repo-url">https://huggingface.co/${esc(data.id)}</div>
        ${data.description ? `<div class="lm-repo-desc">${esc(data.description)}</div>` : ''}
        <div class="lm-file-need">${facts.join(' · ')}</div>
        ${sampling ? `<div class="lm-file-need">${t('localModels.recommendedSampling')}: ${sampling}</div>` : ''}
        ${data.gated && !state.token.set ? `<div class="lm-error">${t('localModels.gatedNeedsToken')}</div>` : ''}
      </div>
      ${memory ? memoryStrip(memory) : ''}
      ${rows || `<div class="lm-empty">${t('localModels.repoNoFiles')}</div>`}`;
  }

  function hubPane() {
    if (state.repo) return repoPane();
    const hub = state.hub;
    const list = hub.repos.map(repoRow).join('');
    return `
      <form class="lm-search" data-lm-form="search">
        <div class="fuzzy-search-wrap">
          <i class="fa-solid fa-magnifying-glass search-icon"></i>
          <input type="text" name="query" value="${esc(hub.query)}" placeholder="${t('localModels.searchPlaceholder')}" spellcheck="false" autocomplete="off">
        </div>
        <select class="select-control" name="kind" data-lm-hub="kind">
          <option value="text" ${hub.kind === 'text' ? 'selected' : ''}>${t('localModels.kindText')}</option>
          <option value="vision" ${hub.kind === 'vision' ? 'selected' : ''}>${t('localModels.kindVision')}</option>
        </select>
        <select class="select-control" name="sort" data-lm-hub="sort">
          ${SORTS.map(sort => `<option value="${sort}" ${hub.sort === sort ? 'selected' : ''}>${t('localModels.sort_' + sort)}</option>`).join('')}
        </select>
        <button class="btn btn-primary" type="submit">${t('localModels.search')}</button>
        <div class="lm-filters">
          <select class="select-control" name="size" data-lm-hub="size" aria-label="${t('localModels.sizeAny')}">
            <option value="">${t('localModels.sizeAny')}</option>
            ${SIZES.map(size => `<option value="${size}" ${hub.size === size ? 'selected' : ''}>${t('localModels.size_' + size)}</option>`).join('')}
          </select>
          <select class="select-control" name="license" data-lm-hub="license" aria-label="${t('localModels.licenseAny')}">
            <option value="">${t('localModels.licenseAny')}</option>
            ${LICENSES.map(license => `<option value="${license}" ${hub.license === license ? 'selected' : ''}>${license === 'other' ? t('localModels.licenseOther') : license}</option>`).join('')}
          </select>
          <select class="select-control" name="access" data-lm-hub="access" aria-label="${t('localModels.accessAny')}">
            <option value="">${t('localModels.accessAny')}</option>
            ${ACCESS.map(access => `<option value="${access}" ${hub.access === access ? 'selected' : ''}>${t('localModels.access_' + access)}</option>`).join('')}
          </select>
          <input type="text" class="lm-input" name="author" value="${esc(hub.author)}" placeholder="${t('localModels.authorPlaceholder')}" aria-label="${t('localModels.authorPlaceholder')}" spellcheck="false" autocomplete="off">
          ${FILTERS.some(key => hub[key]) ? `<button class="btn" type="button" data-lm-action="filters-clear">${t('localModels.filtersClear')}</button>` : ''}
        </div>
      </form>
      <div class="lm-token-row">${tokenBox()}</div>
      ${hub.error ? `<div class="lm-error">${esc(hub.error)}</div>` : ''}
      ${list}
      ${hub.loading ? `<div class="lm-empty"><i class="fa-solid fa-spinner fa-spin"></i> ${t('localModels.searching')}</div>` : ''}
      ${!hub.loading && hub.asked && !hub.repos.length && !hub.error ? `<div class="lm-empty">${t('localModels.searchEmpty')}</div>` : ''}
      ${!hub.loading && hub.next ? `<button class="btn lm-more" data-lm-action="more">${t('localModels.more')}</button>` : ''}`;
  }

  /** Drawn again when what it shows changes; not while a field of it is being typed in, unless `force`. */
  function render(force = false) {
    drawMounts(force);
    const el = host();
    if (!el || !visible()) return;
    if (!force && el.contains(document.activeElement) && document.activeElement.matches('input[type="text"], input[type="password"], input[type="number"]')) return;
    const scroll = el.scrollTop;
    el.innerHTML = `
      <div class="lm-page">
        <div class="env-header">
          <div>
            <h2 class="lm-title"><i class="fa-solid fa-hard-drive"></i> ${t('localModels.title')}</h2>
            <p class="env-subtext">${t('localModels.subtitle')}</p>
          </div>
        </div>
        <div class="settings-role-tabs-bar lm-tabs">
          <button class="settings-role-tab-btn ${state.tab === 'installed' ? 'active' : ''}" data-lm-action="tab" data-id="installed" type="button"><i class="fa-solid fa-layer-group"></i><span>${t('localModels.tabInstalled')}</span></button>
          <button class="settings-role-tab-btn ${state.tab === 'hub' ? 'active' : ''}" data-lm-action="tab" data-id="hub" type="button"><i class="fa-solid fa-cloud-arrow-down"></i><span>${t('localModels.tabHub')}</span></button>
          <button class="settings-role-tab-btn ${state.tab === 'onnx' ? 'active' : ''}" data-lm-action="tab" data-id="onnx" type="button"><i class="fa-solid fa-image"></i><span>${t('localOnnx.tab')}</span></button>
        </div>
        ${state.error ? `<div class="lm-error">${esc(state.error)}</div>` : ''}
        ${state.tab === 'installed' ? installedPane() : state.tab === 'onnx' ? (window.localOnnx?.pane() || '') : hubPane()}
      </div>`;
    el.scrollTop = scroll;
  }

  // --- what the user does

  const model = (id) => state.listing?.models.find(m => m.id === id);

  function saveLaunch(id, change) {
    const current = model(id);
    if (!current) return;
    const launch = { placement: current.launch.placement, gpuLayers: current.launch.gpuLayers, context: current.launch.context, projector: current.projector, ...change };
    return act(id, () => api('/launch', 'POST', { id, ...launch })).then(() => render(true));
  }

  async function onClick(event) {
    const target = event.target.closest('[data-lm-action]');
    if (!target) return;
    const { lmAction: action, id } = target.dataset;
    if (action !== 'ask-remove' && action !== 'remove') state.confirming = null;
    switch (action) {
      case 'tab':
        state.tab = id;
        if (id === 'hub' && !state.hub.asked) search();
        // The ONNX models of the photo functions: their own file draws the pane and answers its clicks.
        if (id === 'onnx') window.localOnnx?.opened(host());
        return render(true);
      case 'options':
        if (state.open.has(id)) state.open.delete(id); else state.open.add(id);
        return render(true);
      case 'load':
        return act(id, () => api('/start', 'POST', { id }, LOAD_TIMEOUT_MS));
      case 'unload':
        return act(id, async () => { await api('/stop', 'POST', { id }); window.modelGateway?.forgetEngine?.(id); });
      case 'reload':
        return act(id, async () => { await api('/stop', 'POST', { id }); window.modelGateway?.forgetEngine?.(id); await api('/start', 'POST', { id }, LOAD_TIMEOUT_MS); });
      case 'ask-remove':
        state.confirming = id;
        return render(true);
      case 'remove':
        state.confirming = null;
        return act(id, async () => { await api('/remove', 'POST', { id }); window.modelGateway?.forgetEngine?.(id); });
      case 'download':
        return act(id, () => api('/downloads/start', 'POST', { repo: state.repo.data.id, path: id }, 60000));
      case 'download-stop': return act(id, () => api('/downloads/stop', 'POST', { id }));
      case 'download-resume': return act(id, () => api('/downloads/resume', 'POST', { id }));
      case 'download-discard': return act(id, () => api('/downloads/discard', 'POST', { id }));
      case 'repo': return openRepo(id);
      case 'repo-back': state.repo = null; return render(true);
      case 'role-clear': return assignRole(id, null);
      case 'role-give': return assignRole(id, target.dataset.model);
      case 'filters-clear':
        for (const key of FILTERS) state.hub[key] = '';
        render(true);
        return search();
      case 'more': return search(true);
      case 'token-edit': state.token.editing = true; return render(true);
      case 'token-cancel': state.token.editing = false; return render(true);
      case 'token-clear':
        await window.chatStorage.setSetting('huggingface_token', '').catch(() => {});
        state.token = { set: false, editing: false };
        return render(true);
      default:
    }
  }

  function onChange(event) {
    const field = event.target;
    if (field.dataset.lmLaunch) {
      const id = field.dataset.id;
      const key = field.dataset.lmLaunch;
      let value = field.value;
      if (key === 'context') value = value === '' ? null : Number(value);
      if (key === 'gpuLayers') value = Number(value) || 0;
      if (key === 'projector') value = value || null;
      const change = { [key]: value };
      if (key === 'placement' && value === 'split' && model(id)?.launch.gpuLayers === null) change.gpuLayers = 0;
      saveLaunch(id, change);
    } else if (field.dataset.lmHub) {
      state.hub[field.dataset.lmHub] = field.value;
      state.hub.query = field.form?.elements.query?.value ?? state.hub.query;
      state.hub.author = (field.form?.elements.author?.value ?? state.hub.author).trim();
      search();
    }
  }

  async function onSubmit(event) {
    const form = event.target.closest('[data-lm-form]');
    if (!form) return;
    event.preventDefault();
    if (form.dataset.lmForm === 'search') {
      state.hub.query = form.elements.query.value;
      state.hub.author = form.elements.author.value.trim();
      form.elements.query.blur();
      form.elements.author.blur();
      search();
    } else if (form.dataset.lmForm === 'token') {
      const value = form.elements.token.value.trim();
      if (!value) return;
      try {
        await window.chatStorage.setSetting('huggingface_token', value);
        state.token = { set: true, editing: false };
        state.error = '';
      } catch (error) { state.error = error.message; }
      render(true);
    }
  }

  /** The tab shown: bound once, drawn, and followed while something in it moves. */
  function show() {
    const el = host();
    if (!el) return;
    if (!el.dataset.bound) {
      el.dataset.bound = '1';
      el.addEventListener('click', onClick);
      el.addEventListener('change', onChange);
      el.addEventListener('submit', onSubmit);
    }
    render(true);
    readToken().then(() => render());
    refresh();
  }

  window.localModelsView = { show, mount, changed: () => { if (visible() || mounts.size) refresh(); }, redraw: () => { if (state.tab === 'onnx') render(); } };
})();
