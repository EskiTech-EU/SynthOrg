/**
 * SynthOrg - First-run setup.
 *
 * A panel with three steps, one screen each: the OpenRouter key (checked
 * against OpenRouter before it is kept), the models of every role, the end.
 * Models are set either from a recommended configuration, where any row can
 * be changed before applying, or one role at a time, with a few recommended
 * models and the full list of compatible ones. At the end it offers a tour
 * of the interface done on the real elements: each step waits for the user
 * to do the thing it describes.
 */
(function () {
  'use strict';

  const DONE_KEY = 'onboarding_done';
  const LOCAL_DONE_KEY = 'synthorg_onboarding_done';

  // The recommended configuration: low cost, good enough for each role.
  // 'auto' means the Master covers the tool itself.
  const RECOMMENDED = {
    master: 'google/gemini-3.8-flash',
    microtask: 'nvidia/nemotron-3.5-lightning:free',
    realtime_multi: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    model_search: 'relace/relace-search',
    text_to_image: 'google/gemini-3.1-flash-image',
    image_to_image: 'google/gemini-3.1-flash-image',
    text_to_video: 'alibaba/wan-3.0-prime',
    image_to_video: 'alibaba/wan-3.0-prime',
    image_inspection: 'auto',
    video_inspection: 'auto',
    audio_transcription: 'mistralai/voxtral-mini-3b-2507',
    music_generation: 'google/lyria-3-clip-preview',
    voice_synthesis: 'google/gemini-3.1-flash-tts-preview'
  };

  const t = (key, params) => (window.i18n ? window.i18n.t(key, params || {}) : key);
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const registry = () => window.operationalRegistry;
  const catalog = () => window.openRouterCatalog;

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }

  function hasKey() {
    return !!catalog()?.getApiKey?.();
  }

  function openExternal(url) {
    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) return invoke('plugin:shell|open', { path: url }).catch(() => window.open(url, '_blank'));
    window.open(url, '_blank', 'noopener');
  }

  function markDone() {
    try { localStorage.setItem(LOCAL_DONE_KEY, 'true'); } catch {}
    window.chatStorage?.setSetting?.(DONE_KEY, 'true').catch?.(() => {});
  }

  function money(value) {
    const n = Number(value) || 0;
    return '$' + (n < 1 ? n.toFixed(3) : n.toFixed(2));
  }

  // How the model is billed comes from the catalog (pricing.billing): token
  // figures are shown only for models actually priced per token.
  function priceLabel(model) {
    const p = model?.pricing;
    if (!p) return '';
    switch (p.billing) {
      case 'free': return t('guide.free');
      case 'variable': return t('guide.variable');
      case 'unlisted': return t('guide.priceUnlisted');
      case 'nonToken': return t('guide.priceNotTokens');
    }
    return t('guide.priceLine', { in: money(p.promptPerM), out: money(p.completionPerM) });
  }

  // For sorting by price: free first, then token prices, then everything the
  // catalog does not price per token.
  function sortPrice(model) {
    const p = model.pricing || {};
    if (p.billing === 'free') return 0;
    if (p.billing && p.billing !== 'token') return Infinity;
    if (p.promptPerM < 0 || p.completionPerM < 0) return Infinity;
    return (p.promptPerM + p.completionPerM) / 2;
  }

  function findModel(id) {
    return (catalog()?.models || []).find(m => m.id === id) || null;
  }

  function items() {
    return registry()?.getAllConfigurableItems?.() || [];
  }

  // Every role a model can take: the four main ones, then the tools (native
  // engines have nothing to choose).
  function configurableRoles() {
    return items().filter(item => item.type !== 'tool' || !item.isNativeEngine);
  }

  function assign(item, modelId) {
    const reg = registry();
    if (!reg || !item) return;
    if (item.type === 'master') reg.setSelectedMasterId(modelId);
    else if (item.type === 'microtask') reg.setSelectedMicrotaskId(modelId);
    else if (item.type === 'realtime_multi') reg.setSelectedRealtimeMultiId(modelId);
    else reg.setToolDelegate(item.id, modelId);
    try { window.chatManager?.renderChatHeader?.(); } catch {}
  }

  /* ------------------------------------------------------------------ */
  /* Panel                                                               */
  /* ------------------------------------------------------------------ */

  const STEP_ORDER = ['key', 'models', 'done'];

  let panel = null;
  let ui = null;
  let draft = {};      // preset: role id -> model id, before applying
  let roleIndex = 0;   // role by role: which role is on screen
  let roleChoice = null;

  function buildPanel() {
    panel = document.createElement('div');
    panel.className = 'guide-backdrop';
    panel.innerHTML = `
      <section class="guide-panel" role="dialog" aria-modal="true" aria-labelledby="guide-title">
        <header class="guide-head">
          <img src="icons/synthorg_logo.png" alt="" class="guide-logo">
          <h2 id="guide-title">${esc(t('guide.title'))}</h2>
          <button type="button" class="guide-close" aria-label="${esc(t('guide.close'))}" title="${esc(t('guide.close'))}"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <ol class="guide-steps">
          ${STEP_ORDER.map((s, i) => `<li data-step="${s}"><span>${i + 1}</span>${esc(t('guide.step_' + s))}</li>`).join('')}
        </ol>
        <div class="guide-body"></div>
        <footer class="guide-foot"></footer>
      </section>
      <div class="guide-zoom" hidden><img alt=""></div>`;
    document.body.appendChild(panel);
    ui = {
      steps: panel.querySelector('.guide-steps'),
      body: panel.querySelector('.guide-body'),
      foot: panel.querySelector('.guide-foot'),
      zoom: panel.querySelector('.guide-zoom')
    };
    panel.querySelector('.guide-close').addEventListener('click', () => closeGuide());
    ui.zoom.addEventListener('click', () => { ui.zoom.hidden = true; });
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (!ui.zoom.hidden) ui.zoom.hidden = true;
      else closeGuide();
    });
  }

  function closeGuide() {
    markDone();
    panel?.remove();
    panel = null;
    ui = null;
  }

  /** Puts a screen in the body; `step` lights up the stepper. */
  function show(step, bodyHtml, footer) {
    ui.steps.querySelectorAll('li').forEach(li => {
      const pos = STEP_ORDER.indexOf(li.dataset.step);
      const cur = STEP_ORDER.indexOf(step);
      li.classList.toggle('is-current', pos === cur);
      li.classList.toggle('is-done', pos < cur);
    });
    ui.body.innerHTML = bodyHtml;
    ui.body.scrollTop = 0;
    ui.foot.innerHTML = '';
    const left = document.createElement('div');
    const right = document.createElement('div');
    left.className = 'guide-foot-side';
    right.className = 'guide-foot-side';
    (footer || []).forEach(b => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn${b.primary ? ' btn-primary' : ''}`;
      btn.innerHTML = `${b.icon ? `<i class="fa-solid ${b.icon}"></i> ` : ''}${esc(b.label)}`;
      if (b.disabled) btn.disabled = true;
      btn.addEventListener('click', b.onClick);
      (b.left ? left : right).appendChild(btn);
    });
    ui.foot.append(left, right);
    ui.body.querySelectorAll('img.guide-image').forEach(img => {
      img.addEventListener('error', () => img.remove());
      img.addEventListener('click', () => {
        ui.zoom.querySelector('img').src = img.src;
        ui.zoom.hidden = false;
      });
    });
    ui.body.querySelectorAll('[data-open]').forEach(a => a.addEventListener('click', () => openExternal(a.dataset.open)));
  }

  /* ------------------------------------------------------------------ */
  /* Step 1: the key                                                     */
  /* ------------------------------------------------------------------ */

  function howToHtml() {
    const link = (url, site) => `<button type="button" class="btn guide-link" data-open="${esc(url)}"><i class="fa-solid fa-arrow-up-right-from-square"></i> ${esc(t('onboarding.openSite', { site }))}</button>`;
    const img = (src) => `<img class="guide-image" src="${src}" alt="" title="${esc(t('onboarding.zoomHint'))}">`;
    const parts = [
      [t('onboarding.accountText'), link('https://openrouter.ai', 'openrouter.ai')],
      [t('onboarding.creditsText'), link('https://openrouter.ai/settings/credits', 'Credits')],
      [t('onboarding.keyText'), img('/onboarding/openrouter-keys.png') + link('https://openrouter.ai/workspaces/default/keys', 'API Keys')],
      [t('onboarding.keyFormText'), img('/onboarding/openrouter-key-form.png')],
      [t('onboarding.keyCopyText'), img('/onboarding/openrouter-key-copy.png')]
    ];
    return `
      <details class="guide-howto"${hasKey() ? '' : ' open'}>
        <summary>${esc(t('guide.howTo'))}</summary>
        <ol class="guide-howto-list">
          ${parts.map(([text, extra]) => `<li><p>${esc(text)}</p>${extra}</li>`).join('')}
        </ol>
      </details>`;
  }

  function showKey(replacing = false) {
    const key = catalog()?.getApiKey?.() || '';
    const configured = key && !replacing;
    show('key', `
      <p class="guide-lead">${esc(t('guide.keyIntro'))}</p>
      ${configured ? `
        <div class="guide-status is-ok"><i class="fa-solid fa-circle-check"></i> ${esc(t('guide.keyConfigured', { key: 'sk-or-…' + key.slice(-4) }))}</div>
        <button type="button" class="btn guide-inline" id="guide-key-replace">${esc(t('guide.keyReplace'))}</button>` : `
        <form class="guide-input-row" id="guide-key-form">
          <input type="password" class="guide-input" placeholder="${esc(t('guide.keyPlaceholder'))}" spellcheck="false" autocomplete="off">
          <button type="submit" class="btn btn-primary">${esc(t('guide.keySave'))}</button>
        </form>
        <p class="guide-note" id="guide-key-note"></p>`}
      ${howToHtml()}`,
    [
      { label: t('guide.skipAll'), left: true, onClick: () => closeGuide() },
      { label: t('guide.next'), primary: true, icon: 'fa-arrow-right', onClick: () => showModels() }
    ]);

    ui.body.querySelector('#guide-key-replace')?.addEventListener('click', () => showKey(true));
    const form = ui.body.querySelector('#guide-key-form');
    if (!form) return;
    const input = form.querySelector('input');
    const submit = form.querySelector('button');
    const note = ui.body.querySelector('#guide-key-note');
    setTimeout(() => input.focus(), 50);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = input.value.trim();
      note.className = 'guide-note';
      if (!value.startsWith('sk-or-')) {
        note.textContent = t('guide.keyFormat');
        note.classList.add('is-error');
        return;
      }
      submit.disabled = true;
      input.disabled = true;
      note.textContent = t('guide.keyChecking');
      const check = await verifyKey(value);
      if (check.status === 'invalid') {
        note.textContent = t('guide.keyInvalid');
        note.classList.add('is-error');
        submit.disabled = false;
        input.disabled = false;
        input.focus();
        return;
      }
      await (window.applyApiKey ? window.applyApiKey(value) : Promise.resolve(catalog()?.setApiKey(value)));
      showKey();
      const status = ui.body.querySelector('.guide-status');
      const lines = [];
      if (check.status === 'unverified') lines.push(t('guide.keyUnverified'));
      else if (check.credits != null) lines.push(check.credits > 0 ? t('guide.keyCredits', { amount: money(check.credits) }) : t('guide.keyNoCredits'));
      if (status && lines.length) status.insertAdjacentHTML('afterend', `<p class="guide-note">${esc(lines.join(' '))}</p>`);
    });
  }

  async function verifyKey(key) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
      if (res.status === 401 || res.status === 403) return { status: 'invalid' };
      if (!res.ok) return { status: 'unverified' };
      let credits = null;
      try {
        const cr = await fetch('https://openrouter.ai/api/v1/credits', { headers: { Authorization: `Bearer ${key}` } });
        if (cr.ok) {
          const data = (await cr.json())?.data;
          if (data) credits = Number(data.total_credits || 0) - Number(data.total_usage || 0);
        }
      } catch {}
      return { status: 'valid', credits };
    } catch {
      return { status: 'unverified' };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Step 2: the models                                                  */
  /* ------------------------------------------------------------------ */

  async function showModels() {
    if (!(catalog()?.models || []).length) {
      show('models', `<p class="guide-lead"><i class="fa-solid fa-circle-notch fa-spin"></i> ${esc(t('guide.catalogLoading'))}</p>`, []);
      for (let i = 0; i < 60 && panel && !(catalog()?.models || []).length; i++) await wait(500);
      if (!panel) return;
      if (!(catalog()?.models || []).length) {
        show('models', `<p class="guide-lead">${esc(t('guide.catalogFailed'))}</p>`, [
          { label: t('guide.back'), left: true, icon: 'fa-arrow-left', onClick: () => showKey() },
          { label: t('guide.next'), primary: true, icon: 'fa-arrow-right', onClick: () => showDone() }
        ]);
        return;
      }
    }
    show('models', `
      <p class="guide-lead">${esc(t('guide.modelsIntro'))}</p>
      <div class="guide-options">
        <button type="button" class="guide-option" data-mode="preset">
          <i class="fa-solid fa-wand-magic-sparkles"></i>
          <strong>${esc(t('guide.presetOption'))}</strong>
          <span>${esc(t('guide.presetDesc'))}</span>
        </button>
        <button type="button" class="guide-option" data-mode="manual">
          <i class="fa-solid fa-list-check"></i>
          <strong>${esc(t('guide.manualOption'))}</strong>
          <span>${esc(t('guide.manualDesc'))}</span>
        </button>
      </div>`,
    [{ label: t('guide.back'), left: true, icon: 'fa-arrow-left', onClick: () => showKey() }]);
    ui.body.querySelectorAll('[data-mode]').forEach(btn => btn.addEventListener('click', () => {
      if (btn.dataset.mode === 'preset') {
        draft = { ...RECOMMENDED };
        showPreset();
      } else {
        roleIndex = 0;
        showRole();
      }
    }));
  }

  /** The recommended configuration: every row can be changed before applying. */
  function showPreset() {
    const roles = configurableRoles().filter(item => draft[item.id]);
    const missing = roles.filter(item => draft[item.id] !== 'auto' && !findModel(draft[item.id]));
    const rows = roles.filter(item => !missing.includes(item)).map(item => {
      const id = draft[item.id];
      const changed = id !== RECOMMENDED[item.id];
      const model = id === 'auto' ? null : findModel(id);
      return `<tr>
        <td>${esc(item.name)}</td>
        <td>${model
          ? `<strong>${esc(model.name)}</strong><span>${esc(model.id)}</span>`
          : `<strong>${esc(t('guide.coveredByMaster'))}</strong>`}${changed ? `<em>${esc(t('guide.changed'))}</em>` : ''}</td>
        <td>${model ? esc(priceLabel(model)) : ''}</td>
        <td><button type="button" class="btn guide-change" data-role="${esc(item.id)}">${esc(t('guide.change'))}</button></td>
      </tr>`;
    }).join('');
    show('models', `
      <p class="guide-lead">${esc(t('guide.presetIntro'))}</p>
      <div class="guide-table-wrap"><table class="guide-table"><tbody>${rows}</tbody></table></div>
      ${missing.length ? `<p class="guide-note">${esc(t('guide.presetMissing', { list: missing.map(i => i.name).join(', ') }))}</p>` : ''}`,
    [
      { label: t('guide.back'), left: true, icon: 'fa-arrow-left', onClick: () => showModels() },
      { label: t('guide.presetApply'), primary: true, icon: 'fa-check', onClick: () => applyPreset() }
    ]);
    ui.body.querySelectorAll('.guide-change').forEach(btn => btn.addEventListener('click', () => {
      const item = configurableRoles().find(i => i.id === btn.dataset.role);
      showPresetPicker(item);
    }));
  }

  /** The full list for one row of the recommended configuration. */
  function showPresetPicker(item) {
    show('models', `
      <div class="guide-role-head">
        <p class="guide-role-title"><span>${item.icon || ''}</span> ${esc(item.name)}</p>
        <p class="guide-note">${esc(item.description || '')}</p>
      </div>
      <div class="guide-picker"></div>`,
    [{ label: t('guide.backToTable'), left: true, icon: 'fa-arrow-left', onClick: () => showPreset() }]);
    renderPicker(ui.body.querySelector('.guide-picker'), item, draft[item.id], (id) => {
      draft[item.id] = id;
      showPreset();
    });
  }

  function applyPreset() {
    // The Master first: which tools it covers depends on it.
    const roles = configurableRoles().sort((a, b) => (a.type === 'master' ? -1 : b.type === 'master' ? 1 : 0));
    roles.forEach(item => {
      const id = draft[item.id];
      if (!id) return;
      if (id === 'auto' || findModel(id)) assign(item, id);
    });
    showDone();
  }

  /** Role by role: recommended models first, then every compatible one. */
  function showRole() {
    const roles = configurableRoles();
    if (roleIndex >= roles.length) { showDone(); return; }
    const item = roles[roleIndex];
    roleChoice = null;
    const current = item.assignedModelId && item.assignedModelId !== '' ? item.assignedModelName : '';
    show('models', `
      <div class="guide-role-head">
        <span class="guide-role-count">${esc(t('guide.roleCount', { current: roleIndex + 1, total: roles.length }))}</span>
        <p class="guide-role-title"><span>${item.icon || ''}</span> ${esc(item.name)}</p>
        <p class="guide-note">${esc(item.description || '')}</p>
        ${current ? `<p class="guide-note">${esc(t('guide.manualRoleCurrent', { name: current }))}</p>` : ''}
      </div>
      <div class="guide-picker"></div>`,
    [
      { label: t('guide.back'), left: true, icon: 'fa-arrow-left', onClick: () => { if (roleIndex === 0) showModels(); else { roleIndex--; showRole(); } } },
      { label: t('guide.skipRole'), onClick: () => { roleIndex++; showRole(); } },
      { label: t('guide.next'), primary: true, icon: 'fa-arrow-right', onClick: () => {
        // Saved on leaving the role: the Master chosen here changes what the
        // next roles can hand back to it.
        if (roleChoice) assign(item, roleChoice);
        roleIndex++;
        showRole();
      } }
    ]);
    // What the role has now shows as selected; Next without a click keeps it.
    const currentId = item.type === 'tool' && item.isNativeCovered ? 'auto' : item.assignedModelId;
    renderPicker(ui.body.querySelector('.guide-picker'), item, currentId, (id) => { roleChoice = id; });
  }

  function proposals(item) {
    const eligible = (item.eligibleModels || []).filter(m => m && m.id);
    const out = [];
    const rec = RECOMMENDED[item.id];
    const recModel = rec && rec !== 'auto' ? eligible.find(m => m.id === rec) : null;
    if (recModel) out.push(recModel);
    const others = eligible.filter(m => m.id !== recModel?.id);
    const cheapest = others
      .filter(m => m.pricing?.billing === 'token')
      .sort((a, b) => sortPrice(a) - sortPrice(b))
      .slice(0, 3);
    // Roles whose models the catalog does not price per token: plain list.
    if (cheapest.length < 3) {
      others.filter(m => !cheapest.includes(m) && !m.pricing?.isFree)
        .slice(0, 3 - cheapest.length)
        .forEach(m => cheapest.push(m));
    }
    out.push(...cheapest);
    const free = others.find(m => m.pricing?.isFree && !cheapest.includes(m));
    if (free) out.push(free);
    return out;
  }

  /**
   * The model list for one role: "use the Master" where it can, a few
   * recommended models, then every compatible model with search and sort.
   * `onPick(id)` is called with the chosen id ('auto' for the Master).
   */
  function renderPicker(container, item, selectedId, onPick) {
    const eligible = (item.eligibleModels || []).filter(m => m && m.id);
    const rec = RECOMMENDED[item.id];
    let selected = selectedId;
    let query = '';
    let sort = 'price';

    const option = (id, name, sub, price, badge) => `
      <button type="button" class="guide-model${id === selected ? ' is-selected' : ''}" data-id="${esc(id)}">
        <span class="guide-model-name">${esc(name)}${badge ? ` <em>${esc(badge)}</em>` : ''}</span>
        ${sub ? `<span class="guide-model-id">${esc(sub)}</span>` : ''}
        <span class="guide-model-price">${esc(price || '')}</span>
      </button>`;
    const modelOption = (m) => option(m.id, m.name, m.id, priceLabel(m), m.id === rec ? t('guide.recommended') : '');

    const top = [];
    if (item.type === 'tool' && item.isNativeInMaster) {
      top.push(option('auto', t('guide.useMaster'), '', '', rec === 'auto' ? t('guide.recommended') : ''));
    }
    proposals(item).forEach(m => top.push(modelOption(m)));

    container.innerHTML = `
      <h4 class="guide-section">${esc(t('guide.recommendedSection'))}</h4>
      <div class="guide-models">${top.join('')}</div>
      <h4 class="guide-section">${esc(t('guide.allSection', { count: eligible.length }))}</h4>
      <div class="guide-list-tools">
        <input type="search" class="guide-input" placeholder="${esc(t('guide.searchPlaceholder'))}" spellcheck="false">
        <select class="guide-input guide-sort">
          <option value="price">${esc(t('guide.sortPriceAsc'))}</option>
          <option value="priceDesc">${esc(t('guide.sortPriceDesc'))}</option>
          <option value="name">${esc(t('guide.sortName'))}</option>
        </select>
      </div>
      <div class="guide-models guide-all"></div>`;
    const all = container.querySelector('.guide-all');

    const renderAll = () => {
      const q = query.toLowerCase();
      const list = eligible
        .filter(m => !q || `${m.name} ${m.id} ${m.provider || ''}`.toLowerCase().includes(q))
        .sort((a, b) => {
          // The models on this computer come first, whatever the order of the rest.
          if (Boolean(a.isLocal) !== Boolean(b.isLocal)) return a.isLocal ? -1 : 1;
          if (sort === 'name') return a.name.localeCompare(b.name);
          const d = sortPrice(a) - sortPrice(b);
          return sort === 'priceDesc' ? -d || 0 : d || 0;
        });
      all.innerHTML = list.length ? list.map(modelOption).join('') : `<p class="guide-note">${esc(t('guide.noResults'))}</p>`;
    };
    renderAll();

    container.querySelector('input[type="search"]').addEventListener('input', (e) => { query = e.target.value.trim(); renderAll(); });
    container.querySelector('.guide-sort').addEventListener('change', (e) => { sort = e.target.value; renderAll(); });
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('.guide-model');
      if (!btn) return;
      selected = btn.dataset.id;
      container.querySelectorAll('.guide-model').forEach(b => b.classList.toggle('is-selected', b.dataset.id === selected));
      onPick(selected);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Step 3: the end                                                     */
  /* ------------------------------------------------------------------ */

  function showDone() {
    // The tour walks through the computer's screen: on the phone the setup ends at the chat.
    const phone = Boolean(window.remote?.active);
    // The tour is one click away: its first steps' voice starts being made now.
    if (!phone) window.onboarding?.prepareTour?.();
    const master = registry()?.getCurrentMasterModel?.();
    show('done', `
      <div class="guide-status is-ok"><i class="fa-solid fa-circle-check"></i> ${esc(t('guide.doneText'))}</div>
      ${master ? `<p class="guide-note">${esc(t('guide.doneMaster', { name: master.name }))}</p>` : ''}
      ${hasKey() ? '' : `<p class="guide-note is-error">${esc(t('guide.doneNoKey'))}</p>`}`,
    [
      { label: t('guide.back'), left: true, icon: 'fa-arrow-left', onClick: () => showModels() },
      { label: t('guide.startChat'), primary: phone, icon: 'fa-comments', onClick: () => { closeGuide(); window.switchView?.('chat'); } },
      ...(phone ? [] : [{ label: t('guide.showUi'), primary: true, icon: 'fa-route', onClick: () => { closeGuide(); window.switchView?.('chat'); start(); } }])
    ]);
  }

  function openGuide() {
    if (panel) return;
    buildPanel();
    showKey();
  }

  /* ------------------------------------------------------------------ */
  /* Interface tour: the user does each thing on the real interface      */
  /* ------------------------------------------------------------------ */

  // There is no Next button: every step lights up one element, says what to
  // do with it, and moves on by itself once the interface shows it was done.
  // Clicks outside the lit element do nothing; Skip is there for a step that
  // cannot be done (a button still disabled, a view that does not load).

  const PAD = 6;
  const GAP = 14;
  const DONE_PAUSE = 1000;
  const $ = (sel) => (sel ? document.querySelector(sel) : null);
  const chat = () => window.chatManager;

  function viewIs(name) {
    const el = document.getElementById('view-' + name);
    return !!el && el.style.display !== 'none';
  }
  function ensureView(name) {
    if (!viewIs(name)) window.switchView?.(name);
  }
  function ensureSection(name) {
    ensureView('settings');
    if (!$(`#settings-tab-btn-${name}.active`)) window.switchSettingsSection?.(name);
  }
  const shown = (sel) => !!visibleRect($(sel));

  // A section switched off (sections.js) is not toured.
  const toured = (chapter) => chapter !== 'code' || (window.sections?.on('code') !== false && !document.getElementById('tab-btn-code')?.hidden);
  const CHAPTERS = ['realtime', 'chat', 'settings', 'code', 'first'].filter(toured);

  // Each step: `target` is lit (several selectors light the area around all
  // of them), together with `area`, the part of the screen where the result
  // shows up, once it is on screen; the step is done on a click inside
  // `click`, or when `check` turns true. `init` takes what `check` compares
  // against when the step starts.
  const STEPS = [
    {
      chapter: 'realtime', key: 'rtTab', target: '#tab-btn-realtime', area: '#view-realtime',
      check: () => viewIs('realtime')
    },
    {
      chapter: 'realtime', key: 'rtBack', target: '#tab-btn-chat', area: '#view-realtime',
      check: () => viewIs('chat')
    },
    {
      chapter: 'chat', key: 'newChat', target: '#btn-new-chat',
      before: () => ensureView('chat'),
      init: () => chat()?.conversation?.id || null,
      check: (prev) => { const id = chat()?.conversation?.id; return !!id && id !== prev; }
    },
    {
      chapter: 'chat', key: 'envOpen', target: '#btn-toggle-env-info', area: '#chat-env-dialog',
      before: () => { ensureView('chat'); window.chatShell?.chatSettings(true); },
      check: () => !!$('#chat-env-dialog[open]')
    },
    {
      chapter: 'chat', key: 'envClose', target: '#chat-env-dialog',
      check: () => !$('#chat-env-dialog[open]')
    },
    {
      chapter: 'settings', key: 'settingsTab', target: '#tab-btn-settings',
      check: () => viewIs('settings')
    },
    {
      chapter: 'settings', key: 'memoryOpen', target: '#btn-open-global-memory',
      before: () => ensureView('settings'),
      check: () => !!$('#global-memory-dialog[open]')
    },
    {
      chapter: 'settings', key: 'memoryClose', target: '#global-memory-dialog',
      check: () => !$('#global-memory-dialog[open]')
    },
    {
      chapter: 'settings', key: 'master', target: '#settings-sidebar-items [data-item-id="master"]', area: '#settings-main-workspace',
      before: () => ensureSection('roles'),
      click: '#settings-sidebar-items [data-item-id="master"]'
    },
    {
      chapter: 'settings', key: 'params', target: '#role-tab-btn-params', area: '#settings-main-workspace',
      before: () => ensureSection('roles'),
      click: '#role-tab-btn-params'
    },
    {
      chapter: 'settings', key: 'search', target: ['#role-tab-btn-models', '#settings-main-workspace .fuzzy-search-wrap'], typing: true, area: '#settings-main-workspace',
      before: () => ensureSection('roles'),
      check: () => shown('#settings-fuzzy-input') && ($('#settings-fuzzy-input').value || '').trim().length >= 2
    },
    {
      chapter: 'settings', key: 'tools', target: '#settings-sidebar-items', area: '#settings-main-workspace',
      before: () => ensureSection('roles'),
      click: '#settings-sidebar-items [data-item-id]:not([data-item-id="master"])'
    },
    {
      chapter: 'settings', key: 'appearance', target: '#settings-tab-btn-appearance', area: '#settings-subview-appearance',
      before: () => ensureView('settings'),
      click: '#settings-tab-btn-appearance'
    },
    {
      chapter: 'settings', key: 'accent', target: 'section[aria-labelledby="appearance-primary-title"]', area: '#settings-subview-appearance',
      before: () => ensureSection('appearance'),
      click: '[data-appearance-key="accent"]'
    },
    {
      chapter: 'settings', key: 'prompts', target: '#settings-tab-btn-prompts', area: '#settings-subview-prompts',
      before: () => ensureView('settings'),
      click: '#settings-tab-btn-prompts'
    },
    {
      chapter: 'settings', key: 'chatMemory', target: '[data-prompts-subtab="memory"]', area: '#settings-subview-prompts',
      before: () => ensureSection('prompts'),
      click: '[data-prompts-subtab="memory"]'
    },
    {
      chapter: 'settings', key: 'environment', target: '#settings-tab-btn-environment', area: '#settings-subview-environment',
      before: () => ensureView('settings'),
      click: '#settings-tab-btn-environment'
    },
    {
      chapter: 'settings', key: 'security', target: '[data-env-subtab="security"]', area: '#settings-subview-environment',
      before: () => ensureSection('environment'),
      click: '[data-env-subtab="security"]'
    },
    {
      chapter: 'code', key: 'codeTab', target: '#tab-btn-code',
      check: () => viewIs('code')
    },
    {
      // Only when a project is already open: new ones start from the list.
      chapter: 'code', key: 'codeBack', target: '#code-btn-projects',
      skipIf: () => !!$('#code-editor-shell')?.hidden,
      check: () => !!$('#code-editor-shell')?.hidden
    },
    {
      chapter: 'code', key: 'codeNew', target: '#code-btn-new', area: '#code-projects',
      before: () => ensureView('code'),
      check: () => !!$('#code-new-dialog[open]')
    },
    {
      chapter: 'code', key: 'codeKinds', target: '#code-new-dialog',
      check: () => !$('#code-new-dialog[open]')
    },
    {
      chapter: 'first', key: 'backChat', target: '#tab-btn-chat',
      check: () => viewIs('chat')
    },
    {
      chapter: 'first', key: 'send', target: '#view-chat .chat-input-wrapper', typing: true,
      before: () => ensureView('chat'),
      init: () => (chat()?.messages || []).length,
      check: (count) => (chat()?.messages || []).length > count
    }
  ].filter(step => toured(step.chapter));

  // The character goes along: it hops from a step to the next and stands on
  // what is to be used, reads each step aloud (Speech synthesis model) with
  // its mouth on the voice, and reacts — pleased at each step done, surprised
  // at a click in the wrong place, celebrating at the end.
  const VOICE_KEY = 'synthorg_tour_voice';
  let buddy = null;
  let stoodOn = null;     // where the character was last sent by the tour
  let voiceOn = true;
  let root = null;
  let els = {};
  let index = 0;
  let ticker = null;
  let active = false;
  let stepState = null;   // what `init` returned for the current step
  let completing = false; // the step is done, the next one is on its way
  let scrolled = false;   // the target was scrolled into view once
  let skipped = new Set(); // steps passed over with Skip

  function build() {
    root = document.createElement('div');
    root.className = 'onb-root';
    root.innerHTML = `
      <div class="onb-block" data-side="top"></div>
      <div class="onb-block" data-side="left"></div>
      <div class="onb-block" data-side="right"></div>
      <div class="onb-block" data-side="bottom"></div>
      <div class="onb-spot" hidden></div>
      <span class="onb-ping" hidden></span>
      <div class="onb-card" role="dialog" aria-modal="false" aria-labelledby="onb-title" aria-live="polite">
        <span class="onb-arrow" aria-hidden="true"></span>
        <div class="onb-head">
          <span class="onb-chapter"></span>
          <button type="button" class="onb-voice"><i class="fa-solid fa-volume-high"></i></button>
          <button type="button" class="onb-close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="onb-progress" aria-hidden="true"></div>
        <h3 id="onb-title" class="onb-title"></h3>
        <p class="onb-text"></p>
        <p class="onb-task"><i class="fa-solid" aria-hidden="true"></i><span></span></p>
        <div class="onb-actions">
          <button type="button" class="onb-skip"></button>
          <span class="onb-count"></span>
        </div>
        <div class="onb-finish" hidden>
          <ul class="onb-summary"></ul>
          <button type="button" class="btn btn-primary onb-end"></button>
        </div>
      </div>`;
    document.body.appendChild(root);
    els = {
      blocks: [...root.querySelectorAll('.onb-block')],
      spot: root.querySelector('.onb-spot'),
      ping: root.querySelector('.onb-ping'),
      card: root.querySelector('.onb-card'),
      arrow: root.querySelector('.onb-arrow'),
      chapter: root.querySelector('.onb-chapter'),
      progress: root.querySelector('.onb-progress'),
      title: root.querySelector('.onb-title'),
      text: root.querySelector('.onb-text'),
      task: root.querySelector('.onb-task'),
      taskIcon: root.querySelector('.onb-task i'),
      taskText: root.querySelector('.onb-task span'),
      actions: root.querySelector('.onb-actions'),
      skip: root.querySelector('.onb-skip'),
      count: root.querySelector('.onb-count'),
      finish: root.querySelector('.onb-finish'),
      summary: root.querySelector('.onb-summary'),
      end: root.querySelector('.onb-end'),
      close: root.querySelector('.onb-close'),
      voice: root.querySelector('.onb-voice')
    };
    els.close.addEventListener('click', () => stop());
    els.voice.addEventListener('click', () => {
      voiceOn = !voiceOn;
      try { localStorage.setItem(VOICE_KEY, voiceOn ? 'on' : 'off'); } catch {}
      renderVoice();
      if (voiceOn) { sayStep(); prepareVoice(index + 1); } else { window.realtime?.voice?.stop(); setVoiceWaiting(false); }
    });
    els.skip.addEventListener('click', () => {
      if (completing) return;
      skipped.add(index);
      go(index + 1);
    });
    els.end.addEventListener('click', () => stop());
    // A click on the dimmed area: nothing happens there, and the card says so.
    els.blocks.forEach(b => b.addEventListener('pointerdown', () => nudge()));
    // The flash replaces the spot's pulse: give the pulse back when it ends.
    els.spot.addEventListener('animationend', () => els.spot.classList.remove('is-nudged'));
    els.card.addEventListener('animationend', () => els.card.classList.remove('is-nudged'));
  }

  function renderVoice() {
    const can = Boolean(window.realtime?.voice?.available());
    els.voice.hidden = !can;
    els.voice.classList.toggle('is-off', !voiceOn);
    els.voice.innerHTML = `<i class="fa-solid ${voiceOn ? 'fa-volume-high' : 'fa-volume-xmark'}"></i>`;
    const label = t(voiceOn ? 'tour.voiceOff' : 'tour.voiceOn');
    els.voice.title = label;
    els.voice.setAttribute('aria-label', label);
  }

  /** What the character says at a step (or at the end): what it is about, then what to do. */
  function stepSpeech(i) {
    const step = STEPS[i];
    return step
      ? `${t(`tour.${step.key}.text`, { name: buddyName() })} ${t(`tour.${step.key}.do`)}`
      : `${t('tour.finishTitle')}! ${t('tour.finishText')}`;
  }

  /**
   * The voice of the next steps, made ahead, in order: when a step comes its
   * audio is already there. From `from`, the next `count` steps (the end
   * included when it is among them).
   */
  function prepareVoice(from, count = 3) {
    if (!voiceOn || !window.realtime?.voice?.available()) return;
    const texts = [];
    for (let i = from; i < Math.min(STEPS.length + 1, from + count); i++) {
      if (i < STEPS.length && STEPS[i].skipIf?.()) continue;
      texts.push(stepSpeech(i));
    }
    window.realtime.voice.prefetch(texts);
  }

  /** While the step's voice is being made: a thinking face and a spinning icon, so it is clear it is coming. */
  function setVoiceWaiting(waiting) {
    if (!els.voice) return;
    els.voice.classList.toggle('is-loading', waiting);
    if (waiting) {
      els.voice.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>';
      els.voice.title = t('tour.voiceLoading');
      buddy?.setState('thinking');
    } else {
      renderVoice();
      buddy?.setState('idle');
    }
  }

  function sayStep() {
    if (!voiceOn || !window.realtime?.voice?.available()) return;
    window.realtime.voice.say(stepSpeech(index), buddy, {
      onWaiting: () => setVoiceWaiting(true),
      onPlaying: () => setVoiceWaiting(false)
    }).then(ok => { if (!ok && els.voice?.classList.contains('is-loading')) setVoiceWaiting(false); });
  }

  function buddyName() {
    return window.realtime?._state?.displayName?.() || t('realtime.defaultName');
  }

  function nudge() {
    if (!active || completing || index >= STEPS.length) return;
    buddy?.setExpression('surprise', 900);
    els.card.classList.remove('is-nudged');
    els.spot.classList.remove('is-nudged');
    void els.card.offsetWidth;
    els.card.classList.add('is-nudged');
    els.spot.classList.add('is-nudged');
  }

  function onKey(e) {
    if (!active || e.key !== 'Escape') return;
    // Escape closes the dialog the step is about, not the tour.
    if (document.querySelector('dialog[open]')) return;
    stop();
  }

  // Clicks are seen on the way down, before the interface re-renders the
  // element that was clicked; the interface still gets them.
  function onClick(e) {
    if (!active || completing) return;
    const step = STEPS[index];
    if (step?.click && e.target.closest?.(step.click)) setTimeout(complete, 0);
  }

  function go(next) {
    while (next < STEPS.length && STEPS[next].skipIf?.()) next++;
    if (next >= STEPS.length) { finish(); return; }
    index = next;
    completing = false;
    scrolled = false;
    const step = STEPS[index];
    try { step.before?.(); } catch (err) { console.warn('[Tour]', err); }
    try { stepState = step.init ? step.init() : null; } catch { stepState = null; }

    const chapterNo = CHAPTERS.indexOf(step.chapter) + 1;
    els.chapter.textContent = t('tour.chapterLabel', { current: chapterNo, total: CHAPTERS.length, name: t('tour.chapter.' + step.chapter) });
    els.count.textContent = t('tour.stepCount', { current: index + 1, total: STEPS.length });
    els.progress.innerHTML = STEPS.map((s, i) => `<span class="${i < index ? 'is-past' : ''}${i === index ? ' is-active' : ''}${i > 0 && STEPS[i - 1].chapter !== s.chapter ? ' is-chapter' : ''}"></span>`).join('');
    els.title.textContent = t(`tour.${step.key}.title`);
    els.text.textContent = t(`tour.${step.key}.text`, { name: buddyName() });
    els.taskText.textContent = t(`tour.${step.key}.do`);
    els.taskIcon.className = `fa-solid ${step.typing ? 'fa-keyboard' : 'fa-hand-pointer'}`;
    els.task.classList.remove('is-done');
    els.skip.textContent = t('tour.skip');
    els.close.title = t('onboarding.exit');
    els.close.setAttribute('aria-label', t('onboarding.exit'));
    els.actions.hidden = false;
    els.finish.hidden = true;
    els.task.hidden = false;
    els.spot.classList.remove('is-done', 'is-nudged');
    els.card.classList.remove('is-nudged', 'is-finish');
    els.card.classList.remove('is-entering');
    void els.card.offsetWidth;
    els.card.classList.add('is-entering');
    buddy?.setState('idle');
    sayStep();
    prepareVoice(index + 1);
    // Rendered views need a frame before their elements can be measured.
    requestAnimationFrame(() => requestAnimationFrame(tick));
  }

  function complete() {
    if (!active || completing || index >= STEPS.length) return;
    completing = true;
    els.task.classList.add('is-done');
    els.taskIcon.className = 'fa-solid fa-circle-check';
    els.taskText.textContent = t('tour.done');
    els.spot.classList.add('is-done');
    els.ping.hidden = true;
    buddy?.setExpression('joy', DONE_PAUSE + 300);
    setTimeout(() => { if (active && completing) go(index + 1); }, DONE_PAUSE);
  }

  function finish() {
    index = STEPS.length;
    completing = false;
    try { markDone(); } catch {}
    els.chapter.textContent = t('tour.finishLabel');
    els.progress.innerHTML = STEPS.map(() => '<span class="is-past"></span>').join('');
    els.title.textContent = t('tour.finishTitle');
    els.text.textContent = t('tour.finishText');
    els.task.hidden = true;
    els.actions.hidden = true;
    els.summary.innerHTML = CHAPTERS.map(c => {
      const missed = STEPS.filter((s, i) => s.chapter === c && skipped.has(i)).length;
      return `<li class="${missed ? 'is-skipped' : ''}"><i class="${missed ? 'fa-regular fa-circle' : 'fa-solid fa-circle-check'}"></i> ${esc(t('tour.chapter.' + c))}${missed ? ` <span>${esc(t('tour.skippedCount', { count: missed }))}</span>` : ''}</li>`;
    }).join('');
    els.end.textContent = t('tour.finishClose');
    els.finish.hidden = false;
    els.card.classList.add('is-finish');
    buddy?.setExpression('party', 5000);
    sayStep();
    els.card.classList.remove('is-entering');
    void els.card.offsetWidth;
    els.card.classList.add('is-entering');
    requestAnimationFrame(tick);
    setTimeout(() => els.end.focus(), 50);
  }

  function visibleRect(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width < 2 || r.height < 2 ? null : r;
  }

  // The area around every element of the step that is on screen.
  function targetRect(sel) {
    const sels = Array.isArray(sel) ? sel : [sel];
    const rects = sels.map(s => visibleRect($(s))).filter(Boolean);
    if (!rects.length) return null;
    const left = Math.min(...rects.map(r => r.left));
    const top = Math.min(...rects.map(r => r.top));
    const right = Math.max(...rects.map(r => r.right));
    const bottom = Math.max(...rects.map(r => r.bottom));
    return { left, top, width: right - left, height: bottom - top };
  }

  function union(a, b) {
    const left = Math.min(a.left, b.left);
    const top = Math.min(a.top, b.top);
    return { left, top, width: Math.max(a.left + a.width, b.left + b.width) - left, height: Math.max(a.top + a.height, b.top + b.height) - top };
  }

  // A modal dialog makes the rest of the page inert and sits above it: while
  // one is open the tour lives inside it, so it stays visible and clickable.
  function rehome() {
    const modal = [...document.querySelectorAll('dialog[open]')].filter(d => d.matches(':modal')).pop();
    const host = modal || document.body;
    if (root.parentNode !== host) host.appendChild(root);
  }

  function tick() {
    if (!active) return;
    rehome();
    const step = STEPS[index];
    if (step && !completing && step.check) {
      let ok = false;
      try { ok = !!step.check(stepState); } catch {}
      if (ok) complete();
    }
    place();
  }

  function place() {
    if (!active) return;
    const step = STEPS[index];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const card = els.card;
    const rect = step ? targetRect(step.target) : null;
    // The lit area also takes in where the result of the action shows up,
    // and what the previous step showed stays lit until the next action.
    const areas = [step?.area, STEPS[index - 1]?.area].filter(Boolean);
    const area = areas.length && rect ? targetRect(areas) : null;
    const lit = area ? union(rect, area) : rect;

    // A target below the fold of its panel is brought into view once.
    if (rect && !scrolled && (rect.top < 0 || rect.top + rect.height > vh)) {
      scrolled = true;
      const first = (Array.isArray(step.target) ? step.target : [step.target]).map($).find(Boolean);
      first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    card.classList.toggle('is-waiting', !!step && !rect);

    if (!rect) {
      els.spot.hidden = true;
      els.ping.hidden = true;
      setBlocks(null, vw, vh);
      card.dataset.side = 'none';
      card.style.left = `${Math.max(16, (vw - card.offsetWidth) / 2)}px`;
      card.style.top = `${Math.max(16, (vh - card.offsetHeight) / 2)}px`;
      standBuddy();
      return;
    }

    const pad = (r) => ({
      left: Math.max(0, r.left - PAD),
      top: Math.max(0, r.top - PAD),
      width: Math.min(vw, r.width + PAD * 2),
      height: Math.min(vh, r.height + PAD * 2)
    });
    const hole = pad(lit);
    els.spot.hidden = false;
    Object.assign(els.spot.style, {
      left: `${hole.left}px`, top: `${hole.top}px`, width: `${hole.width}px`, height: `${hole.height}px`
    });
    setBlocks(hole, vw, vh);

    // The ring that says "here" sits on small click targets only: on a list,
    // a panel or a text field it would hide what it points at.
    const small = rect.width <= 260 && rect.height <= 80;
    els.ping.hidden = completing || !!step.typing || !small;
    if (!els.ping.hidden) {
      els.ping.style.left = `${rect.left + rect.width / 2}px`;
      els.ping.style.top = `${rect.top + rect.height / 2}px`;
    }

    // The card goes on the side with the most room; the arrow points at the
    // middle of the element, clamped to the card's edge.
    // When the lit area leaves no room around it, the card sits beside the
    // element to act on, over the area.
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const fit = (box) => {
      const room = {
        bottom: vh - (box.top + box.height), top: box.top,
        right: vw - (box.left + box.width), left: box.left
      };
      if (room.bottom >= ch + GAP + 16) return 'bottom';
      if (room.top >= ch + GAP + 16) return 'top';
      if (room.right >= cw + GAP + 16) return 'right';
      if (room.left >= cw + GAP + 16) return 'left';
      return null;
    };
    let box = hole;
    let side = fit(hole);
    if (!side && area) {
      box = pad(rect);
      side = fit(box);
    }
    side = side || 'inside';

    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    let left;
    let top;
    if (side === 'bottom' || side === 'top') {
      left = Math.min(Math.max(16, cx - cw / 2), vw - cw - 16);
      top = side === 'bottom' ? box.top + box.height + GAP : box.top - ch - GAP;
      els.arrow.style.left = `${Math.min(Math.max(18, cx - left), cw - 18)}px`;
      els.arrow.style.top = '';
    } else if (side === 'right' || side === 'left') {
      top = Math.min(Math.max(16, cy - ch / 2), vh - ch - 16);
      left = side === 'right' ? box.left + box.width + GAP : box.left - cw - GAP;
      els.arrow.style.top = `${Math.min(Math.max(18, cy - top), ch - 18)}px`;
      els.arrow.style.left = '';
    } else {
      left = vw - cw - 24;
      top = vh - ch - 24;
    }
    card.dataset.side = side;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    standBuddy();
  }

  /**
   * The character goes to the step: onto what is to be used, which gives way
   * under it, or onto the card while there is nothing to stand on (a step
   * that waits, the end). Sent once for each step; sent again when something
   * else moved it meanwhile.
   */
  function standBuddy() {
    const mascot = window.mascot;
    if (!active || !mascot?.ready) return;
    buddy = mascot.puppet;
    if (stoodOn && stoodOn.index === index && mascot.heading?.rect === stoodOn.rect) return;
    const step = STEPS[index];
    const cardRect = () => visibleRect(els.card);
    const onTarget = () => (step && active ? targetRect(step.target) : null);
    const rect = () => onTarget() || cardRect();
    const first = step ? (Array.isArray(step.target) ? step.target : [step.target]).map($).find(Boolean) : null;
    stoodOn = { index, rect };
    mascot.stand(null, { rect, avoid: () => (onTarget() ? cardRect() : null), press: onTarget() && first?.matches?.('button, a, [role="button"], .nav-tab, .rt-home-card') ? first : false });
  }

  // Four panels around the hole block clicks elsewhere; the hole itself lets
  // them through to the real element.
  function setBlocks(hole, vw, vh) {
    const [topB, leftB, rightB, bottomB] = els.blocks;
    if (!hole) {
      Object.assign(topB.style, { left: '0px', top: '0px', width: `${vw}px`, height: `${vh}px` });
      [leftB, rightB, bottomB].forEach(b => Object.assign(b.style, { width: '0px', height: '0px' }));
      root.classList.add('is-centered');
      return;
    }
    root.classList.remove('is-centered');
    Object.assign(topB.style, { left: '0px', top: '0px', width: `${vw}px`, height: `${hole.top}px` });
    Object.assign(bottomB.style, { left: '0px', top: `${hole.top + hole.height}px`, width: `${vw}px`, height: `${Math.max(0, vh - hole.top - hole.height)}px` });
    Object.assign(leftB.style, { left: '0px', top: `${hole.top}px`, width: `${hole.left}px`, height: `${hole.height}px` });
    Object.assign(rightB.style, { left: `${hole.left + hole.width}px`, top: `${hole.top}px`, width: `${Math.max(0, vw - hole.left - hole.width)}px`, height: `${hole.height}px` });
  }

  function start() {
    if (active || window.remote?.active) return;
    if (!root) build();
    active = true;
    root.hidden = false;
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('resize', place);
    // Views render asynchronously and actions finish asynchronously: follow both.
    ticker = setInterval(tick, 200);
    skipped = new Set();
    buddy = window.mascot?.puppet || null;
    stoodOn = null;
    try { voiceOn = localStorage.getItem(VOICE_KEY) !== 'off'; } catch { voiceOn = true; }
    renderVoice();
    // The first steps' voice starts being made right away.
    prepareVoice(0, 4);
    go(0);
  }

  function stop() {
    if (!active) return;
    active = false;
    completing = false;
    clearInterval(ticker);
    ticker = null;
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('resize', place);
    if (root) {
      root.hidden = true;
      stoodOn = null;
      window.mascot?.home();
      window.realtime?.voice?.stop();
      els.voice?.classList.remove('is-loading');
      if (root.parentNode !== document.body) document.body.appendChild(root);
    }
  }

  /** Called once the workspace has booted. */
  async function maybeStart() {
    try { if (localStorage.getItem(LOCAL_DONE_KEY) === 'true') return; } catch {}
    try {
      const res = await window.chatStorage?.getSetting?.(DONE_KEY);
      if (res?.value === 'true') {
        try { localStorage.setItem(LOCAL_DONE_KEY, 'true'); } catch {}
        return;
      }
    } catch {}
    // An installation that already has a key is not a first launch.
    if (hasKey()) { markDone(); return; }
    openGuide();
  }

  window.onboarding = { openGuide, start, stop, maybeStart, prepareTour: () => { try { voiceOn = localStorage.getItem(VOICE_KEY) !== 'off'; } catch {} prepareVoice(0, 3); } };
  // The model list of the setup, also used by a chat's own models.
  window.modelPicker = { render: renderPicker, priceLabel };
})();
