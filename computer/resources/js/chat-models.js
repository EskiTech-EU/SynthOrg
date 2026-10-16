/**
 * SynthOrg - A chat's own models and parameters.
 *
 * Opened from the chat header: the active Master and the Tool & Deleghe
 * panel. A chat can choose its own Master, its own Microtask model, its own
 * model for every delegated tool and its own parameters for each of them;
 * whatever it does not choose comes from Settings. The choices are kept on
 * the conversation (model_overrides_json) and read through
 * operationalRegistry.forConversation(), so a turn uses them and the other
 * chats do not see them.
 */
(function () {
  'use strict';

  const SAVE_DELAY = 300;

  const t = (key, params) => (window.i18n ? window.i18n.t(key, params || {}) : key);
  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }

  let dialog = null;
  let ui = null;
  let itemId = 'master';
  let tab = 'model';
  const pendingSaves = new Map(); // conversation id -> timer

  const chat = () => window.chatManager;
  const conversation = () => chat()?.conversation || null;
  const scoped = () => chat()?.registryFor?.(conversation()) || window.operationalRegistry;

  /** A copy of the chat's own choices, to change and write back. */
  function own() {
    const parsed = window.OperationalRegistry?.parseOverrides(conversation()?.model_overrides_json);
    return parsed ? JSON.parse(JSON.stringify(parsed)) : {};
  }

  /**
   * Takes effect at once on the chat in memory (header, next turn); reaches
   * the server shortly after, one request for a burst of changes.
   */
  function write(next) {
    const conv = conversation();
    if (!conv) return;
    ['roles', 'tools', 'params'].forEach(key => {
      if (next[key] && !Object.keys(next[key]).length) delete next[key];
    });
    if (next.params) {
      Object.keys(next.params).forEach(id => { if (!Object.keys(next.params[id]).length) delete next.params[id]; });
      if (!Object.keys(next.params).length) delete next.params;
    }
    const value = Object.keys(next).length ? next : null;
    conv.model_overrides_json = value ? JSON.stringify(value) : null;
    const id = conv.id;
    clearTimeout(pendingSaves.get(id));
    pendingSaves.set(id, setTimeout(() => {
      pendingSaves.delete(id);
      window.chatStorage.update(id, { modelOverrides: value })
        .catch(err => window.chatWorkspace?.error?.(err));
    }, SAVE_DELAY));
    try { chat()?.renderChatHeader?.(); } catch {}
    // A local model chosen for this chat is loaded now, and takes the place of another chat's (local-keeper.js).
    window.localKeeper?.chatChanged(conv);
  }

  // The roles a chat turn uses: the Master, the Microtask model (memory
  // summaries) and the tools that take a model. The Realtime roles are not
  // used by a chat, and the built-in engines have no model.
  function roles(registry) {
    return registry.getAllConfigurableItems()
      .filter(i => i.type === 'master' || i.type === 'microtask' || (i.type === 'tool' && !i.isNativeEngine));
  }

  function ownModel(o, item) {
    if (item.type === 'master' || item.type === 'microtask') return o.roles?.[item.type];
    return o.tools?.[item.id];
  }

  function targetModelId(registry, item) {
    if (item.type === 'master') return registry.getCurrentMasterModel()?.id || null;
    if (item.type === 'microtask') return registry.getCurrentMicrotaskModel()?.id || null;
    const delegate = registry.getToolDelegate(item.id);
    if (delegate && delegate !== 'auto') return delegate;
    return item.isNativeCovered ? registry.getCurrentMasterModel()?.id || null : null;
  }

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'workspace-dialog chat-models-dialog';
    dialog.setAttribute('aria-labelledby', 'chat-models-title');
    dialog.innerHTML = `
      <div class="chat-models-head">
        <div>
          <h2 id="chat-models-title"></h2>
          <p class="chat-models-lead"></p>
        </div>
        <button type="button" class="btn-chat-action chat-models-close"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="chat-models-body">
        <nav class="chat-models-roles"></nav>
        <section class="chat-models-main">
          <div class="chat-models-role-head"></div>
          <div class="chat-models-tabs" role="tablist">
            <button type="button" role="tab" data-tab="model"></button>
            <button type="button" role="tab" data-tab="params"></button>
          </div>
          <div class="chat-models-pane"></div>
        </section>
      </div>`;
    document.body.appendChild(dialog);
    ui = {
      title: dialog.querySelector('#chat-models-title'),
      lead: dialog.querySelector('.chat-models-lead'),
      close: dialog.querySelector('.chat-models-close'),
      roles: dialog.querySelector('.chat-models-roles'),
      head: dialog.querySelector('.chat-models-role-head'),
      tabs: [...dialog.querySelectorAll('.chat-models-tabs [data-tab]')],
      pane: dialog.querySelector('.chat-models-pane')
    };
    ui.close.addEventListener('click', () => dialog.close());
    ui.roles.addEventListener('click', (e) => {
      const row = e.target.closest('[data-item]');
      if (!row) return;
      itemId = row.dataset.item;
      render();
    });
    ui.tabs.forEach(btn => btn.addEventListener('click', () => {
      tab = btn.dataset.tab;
      render();
    }));
    ui.head.addEventListener('click', (e) => {
      if (!e.target.closest('[data-action="general"]')) return;
      const o = own();
      const item = currentItem(scoped());
      if (item.type === 'master' || item.type === 'microtask') { if (o.roles) delete o.roles[item.type]; }
      else if (o.tools) delete o.tools[item.id];
      write(o);
      render();
    });
  }

  function currentItem(registry) {
    const list = roles(registry);
    return list.find(i => i.id === itemId) || list[0];
  }

  function render() {
    const registry = renderSide();
    const item = registry && currentItem(registry);
    if (!item) return;
    if (tab === 'model') renderModel(registry, item);
    else renderParams(registry, item);
  }

  /** Everything but the pane: the roles, the chosen one's origin, the tabs. */
  function renderSide() {
    const registry = scoped();
    const o = registry.overrides || {};
    const list = roles(registry);
    const item = currentItem(registry);
    if (!item) return null;
    itemId = item.id;

    ui.title.textContent = t('chatModels.title');
    ui.lead.textContent = t('chatModels.lead', { chat: conversation()?.title || '' });
    ui.close.setAttribute('aria-label', t('common.close'));

    ui.roles.innerHTML = list.map(i => {
      const modelId = targetModelId(registry, i);
      const mine = ownModel(o, i) !== undefined || Boolean(modelId && o.params?.[modelId]);
      return `
        <button type="button" class="chat-models-role${i.id === item.id ? ' is-active' : ''}" data-item="${esc(i.id)}">
          <span class="chat-models-role-name"><span>${i.icon || ''}</span> ${esc(i.name)}</span>
          <span class="chat-models-role-model">${esc(i.assignedModelName || '')}</span>
          ${mine ? `<span class="chat-own-badge">${esc(t('chatModels.ownBadge'))}</span>` : ''}
        </button>`;
    }).join('');

    const modelId = targetModelId(registry, item);
    const modelOwn = ownModel(o, item) !== undefined;
    const paramsOwn = Boolean(modelId && o.params?.[modelId]);
    ui.head.innerHTML = `
      <p class="chat-models-role-title"><span>${item.icon || ''}</span> ${esc(item.name)}</p>
      <p class="chat-models-role-desc">${esc(item.description || '')}</p>
      <p class="chat-models-origin">
        ${esc(t('chatModels.modelLine', { name: item.assignedModelName || '—' }))}
        <em>${esc(t(modelOwn ? 'chatModels.fromChat' : 'chatModels.fromSettings'))}</em>
        ${modelOwn ? `<button type="button" class="onb-skip" data-action="general">${esc(t('chatModels.useGeneral'))}</button>` : ''}
      </p>
      <p class="chat-models-origin">
        ${esc(t('chatModels.paramsLine'))}
        <em>${esc(t(paramsOwn ? 'chatModels.fromChat' : 'chatModels.fromSettings'))}</em>
      </p>`;

    ui.tabs.forEach(btn => {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', String(on));
      btn.textContent = t(btn.dataset.tab === 'model' ? 'chatModels.tabModel' : 'chatModels.tabParams');
    });
    return registry;
  }

  function renderModel(registry, item) {
    ui.pane.innerHTML = '<div class="guide-picker"></div>';
    const selected = item.type === 'tool' ? registry.getToolDelegate(item.id) : item.assignedModelId;
    window.modelPicker?.render(ui.pane.querySelector('.guide-picker'), item, selected, (id) => {
      const o = own();
      if (item.type === 'master' || item.type === 'microtask') {
        o.roles = { ...(o.roles || {}), [item.type]: id };
      } else {
        o.tools = { ...(o.tools || {}), [item.id]: id };
      }
      write(o);
      // The list stays as it is (search, scroll); the rest shows the new model.
      renderSide();
    });
  }

  function renderParams(registry, item) {
    ui.pane.innerHTML = '<div class="settings-params-panel chat-models-params"></div>';
    // The chat keeps its own values; a cleared one (null) is the model's default.
    const store = {
      getModelParameters: (id) => scoped().getModelParameters(id),
      setModelParameter: (id, key, value) => {
        if (!id || !key) return;
        const o = own();
        o.params = o.params || {};
        o.params[id] = { ...(o.params[id] || {}), [key]: value === undefined || value === '' ? null : value };
        write(o);
        renderSide();
      },
      resetModelParameters: (id) => {
        const o = own();
        if (o.params) delete o.params[id];
        write(o);
        render();
      }
    };
    window.renderParamsPanel?.({
      container: ui.pane.firstChild,
      itemId: item.id,
      registry,
      store,
      resetLabel: t('chatModels.paramsReset')
    });
  }

  /** Opens on a role: 'master' (the header), a tool id (Tool & Deleghe), or the last one. */
  function open(id) {
    if (!conversation()) return;
    if (!dialog) build();
    if (id) {
      itemId = id;
      tab = 'model';
    }
    render();
    if (!dialog.open) dialog.showModal();
  }

  window.chatModels = { open };
})();
