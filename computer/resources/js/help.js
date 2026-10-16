/**
 * SynthOrg - Help points.
 *
 * A small "?" beside the parts of the interface that need a word of
 * explanation; a click opens a card that explains that part. The tour covers
 * the broad lines, these cover the details, one element at a time.
 *
 * A point nobody has opened yet is solid; in each screen the first of them
 * also pulses, so a menu opened for the first time shows where to start.
 * Once opened, a point turns grey. The "?" button in the header shows and
 * hides all of them; showing them again turns every point back to new.
 */
(function () {
  'use strict';

  const SEEN_KEY = 'synthorg_help_seen';
  const HIDDEN_KEY = 'synthorg_help_hidden';
  const GAP = 10;

  const t = (key, params) => (window.i18n ? window.i18n.t(key, params || {}) : key);

  // Each point: the element it explains (the first match on screen) and the
  // i18n keys help.<id>.title / help.<id>.text.
  const POINTS = [
    { id: 'rtDiary', sel: '#view-realtime .rt-home-diary' },
    { id: 'rtAgenda', sel: '#view-realtime .rt-home-agenda' },
    { id: 'rtWellbeing', sel: '#view-realtime .rt-home-wellbeing' },
    { id: 'rtTasks', sel: '#view-realtime .rt-home-tasks' },
    { id: 'rtUsage', sel: '#view-realtime .rt-home-usage' },
    { id: 'rtSettings', sel: '#view-realtime .rt-settings-btn' },
    { id: 'rtDesk', sel: '#view-realtime .rt-stage:not(.is-calendar) .rt-desk' },
    { id: 'rtNotices', sel: '.rt-settings [data-tab="notices"]' },
    { id: 'rtJobs', sel: '.rt-settings [data-tab="jobs"]' },
    { id: 'chatArchived', sel: '#btn-chats-archived' },
    { id: 'sharedMemory', sel: '#btn-open-global-memory' },
    { id: 'chatMaster', sel: '#chat-header-master-info' },
    { id: 'artifacts', sel: '#btn-toggle-artifacts' },
    { id: 'chatMemory', sel: '#btn-open-chat-memory' },
    { id: 'chatEnv', sel: '#btn-toggle-env-info' },
    { id: 'chatTools', sel: '#btn-toggle-tool-info' },
    { id: 'stt', sel: '#chat-btn-stt' },
    { id: 'tts', sel: '#view-chat .message-tts-action' },
    { id: 'roleStatus', sel: '#settings-sidebar-items .settings-item-status-pill' },
    { id: 'catalogSync', sel: '#btn-sync-catalog' },
    { id: 'filters', sel: '#settings-main-workspace .fuzzy-search-wrap' },
    { id: 'modelTags', sel: '#settings-main-workspace .model-candidate-card .model-tags-row .tag-badge:last-child' },
    { id: 'inspect', sel: '#settings-main-workspace .model-candidate-card .model-actions-col .btn-secondary' },
    { id: 'paramsReset', sel: '#settings-main-workspace #btn-reset-model-params' },
    { id: 'paramsUnsupported', sel: '#settings-main-workspace .params-unsupported-box' },
    { id: 'promptMode', sel: '#settings-subview-prompts .prompt-segmented-control' },
    { id: 'scanPackages', sel: '#btn-scan-packages' },
    { id: 'packageFilters', sel: '#settings-subview-environment .env-filter-pills' },
    { id: 'codeKinds', sel: '#lab-new-kind' },
    { id: 'codeHistory', sel: '#proj-btn-history' },
    { id: 'codePerms', sel: '#code-perm-group' },
    { id: 'codePush', sel: '#proj-btn-push' },
    { id: 'codeChats', sel: '#code-chat-select' },
    { id: 'codeAi', sel: '#code-ai-close' }
  ];

  let layer = null;
  let dots = new Map();   // id -> button
  let card = null;
  let openId = null;
  let seen = new Set();

  function load() {
    try { seen = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { seen = new Set(); }
  }
  function saveSeen() {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen])); } catch {}
  }
  function isHidden() {
    try { return localStorage.getItem(HIDDEN_KEY) === 'true'; } catch { return false; }
  }
  function setHidden(value) {
    try {
      if (value) localStorage.setItem(HIDDEN_KEY, 'true');
      else localStorage.removeItem(HIDDEN_KEY);
    } catch {}
    const toggle = document.getElementById('btn-toggle-help');
    if (toggle) toggle.setAttribute('aria-pressed', String(!value));
  }

  function build() {
    layer = document.createElement('div');
    layer.className = 'help-layer';
    layer.innerHTML = `
      <div class="onb-card help-card" role="dialog" aria-labelledby="help-card-title" hidden>
        <span class="onb-arrow" aria-hidden="true"></span>
        <div class="help-card-head">
          <h3 id="help-card-title" class="onb-title"></h3>
          <button type="button" class="onb-close help-card-close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <p class="onb-text help-card-text"></p>
      </div>`;
    document.body.appendChild(layer);
    card = layer.querySelector('.help-card');
    card.querySelector('.help-card-close').addEventListener('click', () => close());
    POINTS.forEach(p => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'help-dot';
      dot.textContent = '?';
      dot.hidden = true;
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        if (openId === p.id) close(); else open(p.id);
      });
      layer.appendChild(dot);
      dots.set(p.id, dot);
    });
    document.addEventListener('pointerdown', (e) => {
      if (openId && !card.contains(e.target) && !e.target.closest?.('.help-dot')) close();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (openId && e.key === 'Escape') { e.stopPropagation(); close(); }
    }, true);
  }

  // The element as the user sees it: on screen, and not under a dialog, a
  // popover or the setup panel.
  function visibleTarget(sel) {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > window.innerHeight) return null;
    const x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1);
    // The points and the card itself do not count as covering it.
    const hit = document.elementsFromPoint(x, y).find(node => !layer.contains(node));
    if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) return null;
    return r;
  }

  // Inside an open modal dialog, or it would sit under it and be inert.
  function rehome() {
    const modal = [...document.querySelectorAll('dialog[open]')].filter(d => d.matches(':modal')).pop();
    const host = modal || document.body;
    if (layer.parentNode !== host) host.appendChild(layer);
  }

  function render() {
    if (!layer) return;
    rehome();
    const off = isHidden() || !!document.querySelector('.onb-root:not([hidden])');
    let first = true;
    POINTS.forEach(p => {
      const dot = dots.get(p.id);
      const r = off ? null : visibleTarget(p.sel);
      dot.hidden = !r;
      if (!r) {
        // What the card explains has gone: the card goes with it.
        if (openId === p.id) {
          openId = null;
          card.hidden = true;
        }
        return;
      }
      dot.style.left = `${Math.min(r.right, window.innerWidth - 10)}px`;
      dot.style.top = `${Math.max(r.top, 10)}px`;
      dot.title = t(`help.${p.id}.title`);
      dot.setAttribute('aria-label', t(`help.${p.id}.title`));
      const isNew = !seen.has(p.id);
      dot.classList.toggle('is-new', isNew);
      dot.classList.toggle('is-next', isNew && first);
      dot.classList.toggle('is-open', openId === p.id);
      if (isNew) first = false;
    });
    if (openId) place();
  }

  function open(id) {
    openId = id;
    seen.add(id);
    saveSeen();
    card.querySelector('.onb-title').textContent = t(`help.${id}.title`);
    card.querySelector('.help-card-text').textContent = t(`help.${id}.text`);
    card.querySelector('.help-card-close').setAttribute('aria-label', t('common.close'));
    card.hidden = false;
    card.classList.remove('is-entering');
    void card.offsetWidth;
    card.classList.add('is-entering');
    render();
  }

  function close() {
    openId = null;
    if (card) card.hidden = true;
    render();
  }

  // Below the point when there is room, otherwise above, left or right; the
  // arrow points at the dot.
  function place() {
    const dot = dots.get(openId);
    if (!dot || dot.hidden) return;
    const d = dot.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const cx = d.left + d.width / 2;
    const cy = d.top + d.height / 2;
    const arrow = card.querySelector('.onb-arrow');
    let side;
    if (vh - d.bottom >= ch + GAP + 16) side = 'bottom';
    else if (d.top >= ch + GAP + 16) side = 'top';
    else if (d.left >= cw + GAP + 16) side = 'left';
    else side = 'right';
    let left;
    let top;
    if (side === 'bottom' || side === 'top') {
      left = Math.min(Math.max(16, cx - cw / 2), vw - cw - 16);
      top = side === 'bottom' ? d.bottom + GAP : d.top - ch - GAP;
      arrow.style.left = `${Math.min(Math.max(18, cx - left), cw - 18)}px`;
      arrow.style.top = '';
    } else {
      top = Math.min(Math.max(16, cy - ch / 2), vh - ch - 16);
      left = side === 'left' ? d.left - cw - GAP : d.right + GAP;
      arrow.style.top = `${Math.min(Math.max(18, cy - top), ch - 18)}px`;
      arrow.style.left = '';
    }
    card.dataset.side = side;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function start() {
    if (layer) return;
    load();
    build();
    setHidden(isHidden());
    document.getElementById('btn-toggle-help')?.addEventListener('click', () => {
      if (openId) close();
      const showing = isHidden();
      // Shown again: every point starts over as not opened yet.
      if (showing) {
        seen = new Set();
        saveSeen();
      }
      setHidden(!showing);
      render();
    });
    // Views re-render on their own: follow them.
    setInterval(render, 400);
    window.addEventListener('resize', render);
    document.addEventListener('scroll', render, true);
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.helpPoints = { render, show: () => { setHidden(false); render(); } };
})();
