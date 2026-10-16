/**
 * The sections of the app the user can switch off (Settings → Sections).
 *
 * A section that is off is not loaded: its scripts are not read, its tab and
 * its parts of a project's frame are taken out of the page, and whatever else speaks of it (the
 * tour, the assistant's notices, the Master's memory, the phone) asks here
 * first. Its files stay in the installation and what the user made with it
 * stays on disk: switching it back on brings everything back.
 *
 * The choice is one setting (`sections`, holding only what is off), mirrored
 * in the page's storage because it is needed before the archive answers: this
 * file runs while the page is still being read, and writes the script tags of
 * the sections that are on right where it stands.
 */
(function () {
  'use strict';

  const MIRROR = 'synthorg_sections';
  const RELOADED = 'synthorg_sections_reloaded';
  // What each section brings: scripts, in loading order, and the parts of the
  // page that are only its own.
  const SECTIONS = {
    code: {
      icon: 'fa-solid fa-code',
      scripts: ['/js/code-canvas.js'],
      own: ['#tab-btn-code']
    },
    // One section, its tabs together: the texts and the photos.
    studio: {
      icon: 'fa-solid fa-feather-pointed',
      scripts: ['/js/studio.js', '/js/photo.js'],
      own: ['#tab-btn-studio', '#studio-pane-text', '#studio-pane-photo', '#proj-fn-writing', '#proj-fn-photo', '#proj-tb-writing', '#studio-error', '#photo-error']
    }
  };

  const parse = (raw) => {
    try {
      const value = JSON.parse(raw || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };
  const mirrored = () => { try { return localStorage.getItem(MIRROR) || ''; } catch { return ''; } };
  // As the page was loaded: what decides which scripts are there until it is loaded again.
  const loaded = parse(mirrored());
  const on = (name) => loaded[name] !== false;
  const root = document.documentElement;
  const mark = () => {
    for (const name of Object.keys(SECTIONS)) root.setAttribute(`data-section-${name}`, on(name) ? 'on' : 'off');
  };
  const t = (key, params) => window.i18n.t(key, params);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  mark();
  for (const [name, section] of Object.entries(SECTIONS)) {
    if (!on(name)) continue;
    for (const src of section.scripts) document.write(`<script src="${src}"><\/script>`);
  }

  /** A model at work in a chat: reloading the page would cut its answer. */
  const working = () => Boolean(window.chatManager?.isGenerating);

  let note = '';

  /** Saves the choice and loads the page again, so that the section is there or not from the first line. */
  async function set(name, value) {
    if (!SECTIONS[name] || working()) return false;
    const next = { ...parse(mirrored()) };
    if (value) delete next[name]; else next[name] = false;
    const stored = Object.keys(next).length ? JSON.stringify(next) : '';
    await window.chatStorage.setSetting('sections', stored);
    try { if (stored) localStorage.setItem(MIRROR, stored); else localStorage.removeItem(MIRROR); } catch {}
    // A project open is closed first: a text being written is saved, and the editor of a
    // folder, painted over the page, would stay there with nothing left to take it away.
    const shell = document.getElementById('code-editor-shell');
    if (shell && !shell.hidden) { document.getElementById('code-btn-projects')?.click(); await new Promise(resolve => setTimeout(resolve, 400)); }
    try { await window.__TAURI__?.core?.invoke?.('code_layout', { visible: false }); } catch {}
    location.reload();
    return true;
  }

  /**
   * The archive has the last word: a choice made elsewhere (another start of
   * the app, a restored archive) is taken, and the page loaded again once to
   * follow it. On the phone it is followed from the next start.
   */
  async function follow() {
    let stored = '';
    try { stored = (await window.chatStorage.getSetting('sections'))?.value || ''; } catch { return; }
    if (JSON.stringify(parse(stored)) === JSON.stringify(parse(mirrored()))) { try { sessionStorage.removeItem(RELOADED); } catch {} return; }
    try { if (stored) localStorage.setItem(MIRROR, stored); else localStorage.removeItem(MIRROR); } catch { return; }
    let again = false;
    try { again = sessionStorage.getItem(RELOADED) === '1'; sessionStorage.setItem(RELOADED, '1'); } catch { again = true; }
    if (!again && !window.SYNTHORG_REMOTE && !working()) location.reload();
  }

  // --- Settings → Sections

  const host = () => document.getElementById('settings-subview-sections');

  function render() {
    const el = host();
    if (!el) return;
    const busy = working();
    el.innerHTML = `
      <div class="sections-page">
        <div class="env-header">
          <div>
            <h2 class="sections-title"><i class="fa-solid fa-table-cells-large"></i> ${esc(t('sections.title'))}</h2>
            <p class="env-subtext">${esc(t('sections.subtitle'))}</p>
          </div>
        </div>
        ${busy ? `<div class="sections-note" role="status">${esc(t('sections.busy'))}</div>` : ''}
        ${note ? `<div class="sections-note" role="alert">${esc(note)}</div>` : ''}
        ${Object.entries(SECTIONS).map(([name, section]) => `
          <div class="sections-row">
            <div class="sections-row-icon"><i class="${section.icon}"></i></div>
            <div class="sections-row-text">
              <strong>${esc(t(`sections.${name}.name`))}</strong>
              <span>${esc(t(`sections.${name}.what`))}</span>
              <small>${esc(t(on(name) ? `sections.${name}.onHint` : `sections.${name}.offHint`))}</small>
            </div>
            <label class="synth-switch" title="${esc(t(on(name) ? 'sections.switchOff' : 'sections.switchOn'))}">
              <input type="checkbox" data-section="${name}" ${on(name) ? 'checked' : ''} ${busy ? 'disabled' : ''} aria-label="${esc(t(`sections.${name}.name`))}">
              <span class="synth-slider"></span>
            </label>
          </div>`).join('')}
        <p class="env-subtext">${esc(t('sections.reloadHint'))}</p>
      </div>`;
  }

  function show() {
    const el = host();
    if (!el) return;
    if (!el.dataset.bound) {
      el.dataset.bound = '1';
      el.addEventListener('change', async (event) => {
        const field = event.target.closest('input[data-section]');
        if (!field) return;
        note = '';
        try {
          if (!(await set(field.dataset.section, field.checked))) { note = t('sections.busy'); render(); }
        } catch (error) { note = error.message; render(); }
      });
    }
    render();
  }

  window.sections = { names: () => Object.keys(SECTIONS), on, set, show };

  document.addEventListener('DOMContentLoaded', () => {
    for (const [name, section] of Object.entries(SECTIONS)) {
      if (on(name)) continue;
      for (const selector of section.own) document.querySelector(selector)?.remove();
    }
    void follow();
  });
})();
