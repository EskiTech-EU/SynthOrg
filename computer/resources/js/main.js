/**
 * SynthOrg - Main Application Controller
 * Wires Chat, Settings, Fuzzy Search Engine, i18n, and OpenRouter API sync.
 */

(function () {
  'use strict';

  /**
   * Shared translation helper.
   *
   * It lives at module scope because several renderers already referenced `t`
   * without defining it: the prompts section did, and threw a ReferenceError
   * that left its page blank.
   */
  // Must match the minimum the vault enforces server-side; the form used to
  // allow six and let the service reject it.
  const MIN_MASTER_PASSWORD = 12;

  const t = (key, params) => (window.i18n ? window.i18n.t(key, params || {}) : key);

  function jsToken(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[^A-Za-z0-9._:/@~-]/g, '');
  }

  // Application State
  const state = {
    activeView: 'chat', // 'realtime' | 'chat' | 'code' | 'studio' | 'settings'
    settingsSection: 'roles', // 'roles' | 'appearance'
    selectedSettingId: 'master', // 'master' or tool IDs
    settingsRoleActiveTab: 'models', // 'models' | 'params'
    settingsFuzzyQuery: '',
    settingsProviderFilter: 'all',
    // Where the models listed are: 'all', 'api' (asked of a provider) or 'local' (on this computer).
    settingsSourceFilter: 'all',
    settingsContextFilter: 0,
    settingsSortBy: 'relevance',
    settingsPage: 1,
    settingsPageSize: 25,
    selectedModelForDrawer: null
  };

  function getFuzzyEngine() {
    if (!window.fuzzyEngine && window.FuzzySearchEngine) {
      window.fuzzyEngine = new window.FuzzySearchEngine();
    }
    return window.fuzzyEngine;
  }

  // Cached DOM elements
  const elements = {};

  function cacheElements() {
    elements.tabBtnRealtime = document.getElementById('tab-btn-realtime');
    elements.tabBtnChat = document.getElementById('tab-btn-chat');
    elements.tabBtnLab = document.getElementById('tab-btn-lab');
    elements.viewLab = document.getElementById('view-lab');
    elements.tabBtnCode = document.getElementById('tab-btn-code');
    elements.viewCode = document.getElementById('view-code');
    elements.tabBtnStudio = document.getElementById('tab-btn-studio');
    elements.viewStudio = document.getElementById('view-studio');
    elements.tabBtnSettings = document.getElementById('tab-btn-settings');
    elements.viewRealtime = document.getElementById('view-realtime');
    elements.viewChat = document.getElementById('view-chat');
    elements.viewSettings = document.getElementById('view-settings');

    elements.iconSync = document.getElementById('icon-sync');
    elements.btnSync = document.getElementById('btn-sync-catalog');
    elements.labelCatalogUpdated = document.getElementById('label-catalog-updated');
    elements.btnToggleLang = document.getElementById('btn-toggle-lang');
    elements.labelCurrentLang = document.getElementById('label-current-lang');
    elements.btnOpenKeyModal = document.getElementById('btn-open-key-modal');
    elements.labelApiKey = document.getElementById('label-api-key');
    elements.statusIndicatorKey = document.getElementById('status-indicator-key');

    // Chat Elements
    elements.chatInput = document.getElementById('chat-input');
    elements.btnSendChat = document.getElementById('chat-btn-send');
    elements.btnStt = document.getElementById('chat-btn-stt');
    elements.btnTtsRead = document.getElementById('chat-btn-tts-read');
    elements.btnOpenChatMemory = document.getElementById('btn-open-chat-memory');

    // Settings Sub-Navigation & Sub-Views
    elements.settingsTabBtnRoles = document.getElementById('settings-tab-btn-roles');
    elements.settingsTabBtnAppearance = document.getElementById('settings-tab-btn-appearance');
    elements.settingsTabBtnPrompts = document.getElementById('settings-tab-btn-prompts');
    elements.settingsTabBtnEnvironment = document.getElementById('settings-tab-btn-environment');
    elements.settingsTabBtnPhone = document.getElementById('settings-tab-btn-phone');
    elements.settingsTabBtnSections = document.getElementById('settings-tab-btn-sections');
    elements.settingsSubviewRoles = document.getElementById('settings-subview-roles');
    elements.settingsSubviewAppearance = document.getElementById('settings-subview-appearance');
    elements.settingsSubviewPrompts = document.getElementById('settings-subview-prompts');
    elements.settingsSubviewEnvironment = document.getElementById('settings-subview-environment');
    elements.settingsSubviewPhone = document.getElementById('settings-subview-phone');
    elements.settingsSubviewSections = document.getElementById('settings-subview-sections');

    // Settings Roles & Tool Elements
    elements.settingsSidebarItems = document.getElementById('settings-sidebar-items');
    elements.settingsMainWorkspace = document.getElementById('settings-main-workspace');

    // Drawer Elements
    elements.drawerBackdrop = document.getElementById('drawer-backdrop');
    elements.inspectorDrawer = document.getElementById('inspector-drawer');
    elements.drawerModelName = document.getElementById('drawer-model-name');
    elements.drawerModelId = document.getElementById('drawer-model-id');
    elements.drawerContent = document.getElementById('drawer-content');
    elements.btnCloseDrawer = document.getElementById('btn-close-drawer');

    // Modal Elements
    elements.modalKeyBackdrop = document.getElementById('modal-key-backdrop');
    elements.inputApiKey = document.getElementById('input-api-key');
    elements.btnSaveKey = document.getElementById('btn-save-key');
    elements.btnCancelKey = document.getElementById('btn-cancel-key');
    elements.btnRemoveKey = document.getElementById('btn-remove-key');
  }

  // Currency & Token Formatters
  function formatTokens(count) {
    if (!count) return '0';
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
    return count.toString();
  }

  function getModelAveragePrice(m) {
    // Models not priced per token have no comparable figure: sort them last.
    const billing = m.pricing.billing;
    if (billing === 'unlisted' || billing === 'nonToken') return -1;
    const pIn = m.pricing.promptPerM;
    const pOut = m.pricing.completionPerM;
    if (pIn < 0 && pOut < 0) return -1;
    if (pIn < 0) return pOut;
    if (pOut < 0) return pIn;
    return (pIn + pOut) / 2;
  }

  function formatPriceTag(m) {
    // A model on this computer has no price: the tag says where it is.
    if (m.isLocal) return `<span class="tag-badge tag-local"><i class="fa-solid fa-hard-drive"></i> ${t('settings.tagLocal')}</span>`;
    if (m.isAutoRouter || m.isFusionRouter || m.pricing.isAutoRouter || m.pricing.isFusionRouter || m.pricing.promptPerM < 0) {
      return `<span class="tag-badge" style="color: var(--primary); border-color: var(--color-secondary-border);"><i class="fa-solid fa-shuffle"></i> ${window.i18n ? window.i18n.t('settings.variablePricing') : 'Variabile (Auto-Routing)'}</span>`;
    }
    if (m.pricing.isFree) {
      return '<span class="tag-badge" style="color: var(--primary); border-color: var(--color-secondary-border);"><i class="fa-solid fa-gift"></i> Free ($0)</span>';
    }
    // Billed per clip, per image or on audio length, or not priced in the
    // catalog at all: the token figures would be zero or meaningless.
    if (m.pricing.billing === 'unlisted' || m.pricing.billing === 'nonToken') {
      const label = window.i18n.t(m.pricing.billing === 'unlisted' ? 'guide.priceUnlisted' : 'guide.priceNotTokens');
      return `<span class="tag-badge tag-price"><i class="fa-solid fa-circle-info"></i> ${escapeHtml(label)}</span>`;
    }
    const inPrice = m.pricing.promptPerM < 1 ? '$' + m.pricing.promptPerM.toFixed(3) : '$' + m.pricing.promptPerM.toFixed(2);
    const outPrice = m.pricing.completionPerM < 1 ? '$' + m.pricing.completionPerM.toFixed(3) : '$' + m.pricing.completionPerM.toFixed(2);
    const avgPrice = getModelAveragePrice(m);
    const avgStr = avgPrice < 1 ? '$' + avgPrice.toFixed(3) : '$' + avgPrice.toFixed(2);
    return `<span class="tag-badge tag-price" title="Prezzo medio: ${avgStr} / 1M token (In: ${inPrice} / Out: ${outPrice})">In: ${inPrice} / Out: ${outPrice} <span style="opacity: 0.75; font-weight: normal; margin-left: 4px;">(Med: ${avgStr})</span></span>`;
  }

  function copyToClipboard(text, btnElement) {
    navigator.clipboard.writeText(text).then(() => {
      if (btnElement) {
        const originalHtml = btnElement.innerHTML;
        btnElement.innerHTML = '<i class="fa-solid fa-check" style="color: var(--primary);"></i>';
        setTimeout(() => {
          btnElement.innerHTML = originalHtml;
        }, 1200);
      }
    }).catch(err => {
      console.error('Clipboard copy error:', err);
    });
  }

  // Switch between Chat and Settings views
  function switchView(viewName) {
    if (!['realtime', 'chat', 'lab', 'hub', 'code', 'studio', 'settings'].includes(viewName)) return;
    // An open project has one frame, whatever its environments: the view 'code'.
    if (viewName === 'studio') viewName = 'code';
    if (!elements.tabBtnChat) cacheElements();
    state.activeView = viewName;

    elements.tabBtnRealtime?.classList.toggle('active', viewName === 'realtime');
    elements.tabBtnChat?.classList.toggle('active', viewName === 'chat');
    // The Lab is its list and the projects opened from it, whichever editor they are in.
    elements.tabBtnLab?.classList.toggle('active', ['lab', 'code', 'studio'].includes(viewName));
    document.getElementById('tab-btn-hub')?.classList.toggle('active', viewName === 'hub');
    const viewHub = document.getElementById('view-hub');
    if (viewHub) viewHub.style.display = viewName === 'hub' ? 'flex' : 'none';
    if (viewName === 'hub') window.localModelsView?.show();
    elements.tabBtnCode?.classList.toggle('active', viewName === 'code');
    elements.tabBtnStudio?.classList.toggle('active', viewName === 'studio');
    elements.tabBtnSettings?.classList.toggle('active', viewName === 'settings');

    if (elements.viewRealtime) elements.viewRealtime.style.display = viewName === 'realtime' ? 'flex' : 'none';
    if (elements.viewChat) elements.viewChat.style.display = viewName === 'chat' ? 'flex' : 'none';
    window.realtime?.setActive(viewName === 'realtime');
    if (elements.viewLab) elements.viewLab.style.display = viewName === 'lab' ? 'flex' : 'none';
    window.lab?.setActive(viewName === 'lab');
    if (elements.viewCode) elements.viewCode.style.display = viewName === 'code' ? 'flex' : 'none';
    if (elements.viewSettings) elements.viewSettings.style.display = viewName === 'settings' ? 'flex' : 'none';
    window.codeWorkspace?.setActive(viewName === 'code');

    if (viewName === 'chat') {
      window.chatManager.render();
      setTimeout(() => elements.chatInput?.focus(), 50);
    } else if (viewName === 'settings') {
      if (state.settingsSection === 'roles') {
        renderSettingsView();
      } else if (state.settingsSection === 'appearance') {
        renderAppearanceSection();
      } else if (state.settingsSection === 'prompts') {
        renderPromptsSection();
      } else if (state.settingsSection === 'environment') {
        renderEnvironmentSection();
      } else if (state.settingsSection === 'phone') {
        window.realtime?._state?.phoneShow?.();
      } else if (state.settingsSection === 'sections') {
        window.sections?.show();
      }
    }
  }

  // Switch between Settings Sub-sections (Ruoli & Tool vs Aspetto & Grafica vs Prompt di Sistema vs Ambiente & Pacchetti)
  function switchSettingsSection(sectionName) {
    // The local models' page is the Hub now: whatever still asks for it as a settings section is taken there.
    if (sectionName === 'local') { switchView('hub'); return; }
    if (!elements.settingsTabBtnRoles) cacheElements();
    state.settingsSection = sectionName;

    elements.settingsTabBtnRoles?.classList.toggle('active', sectionName === 'roles');
    elements.settingsTabBtnAppearance?.classList.toggle('active', sectionName === 'appearance');
    elements.settingsTabBtnPrompts?.classList.toggle('active', sectionName === 'prompts');
    elements.settingsTabBtnEnvironment?.classList.toggle('active', sectionName === 'environment');
    elements.settingsTabBtnPhone?.classList.toggle('active', sectionName === 'phone');
    elements.settingsTabBtnSections?.classList.toggle('active', sectionName === 'sections');

    if (elements.settingsSubviewRoles) {
      elements.settingsSubviewRoles.style.display = sectionName === 'roles' ? 'flex' : 'none';
    }
    if (elements.settingsSubviewAppearance) {
      elements.settingsSubviewAppearance.style.display = sectionName === 'appearance' ? 'flex' : 'none';
    }
    if (elements.settingsSubviewPrompts) {
      elements.settingsSubviewPrompts.style.display = sectionName === 'prompts' ? 'flex' : 'none';
    }
    if (elements.settingsSubviewEnvironment) {
      elements.settingsSubviewEnvironment.style.display = sectionName === 'environment' ? 'flex' : 'none';
    }
    if (elements.settingsSubviewPhone) {
      elements.settingsSubviewPhone.style.display = sectionName === 'phone' ? 'flex' : 'none';
    }
    if (elements.settingsSubviewSections) {
      elements.settingsSubviewSections.style.display = sectionName === 'sections' ? 'flex' : 'none';
    }

    if (sectionName === 'roles') {
      renderSettingsView();
    } else if (sectionName === 'appearance') {
      renderAppearanceSection();
    } else if (sectionName === 'prompts') {
      renderPromptsSection();
    } else if (sectionName === 'environment') {
      renderEnvironmentSection();
    } else if (sectionName === 'phone') {
      window.realtime?._state?.phoneShow?.();
    } else if (sectionName === 'sections') {
      window.sections?.show();
    }
  }
  window.switchSettingsSection = switchSettingsSection;

  /**
   * Render Appearance & Customization Section
   */
  function renderAppearanceSection() {
    const container = elements.settingsSubviewAppearance;
    if (!container || !window.themeManager) return;
    const prefs = window.themeManager.prefs;
    const modes = [
      { id: 'light', icon: 'fa-sun', label: t('appearance.modeLight') },
      { id: 'dark', icon: 'fa-moon', label: t('appearance.modeDark') },
      { id: 'system', icon: 'fa-desktop', label: t('appearance.modeSystem') }
    ];
    const accents = [
      { id: 'blue', color: '#8aafff', label: t('appearance.accentBlue') },
      { id: 'indigo', color: '#8185d5', label: t('appearance.accentIndigo') },
      { id: 'violet', color: '#b5a0ef', label: t('appearance.accentViolet') },
      { id: 'magenta', color: '#dfa1e6', label: t('appearance.accentMagenta') },
      { id: 'rose', color: '#eda4c2', label: t('appearance.accentRose') },
      { id: 'amber', color: '#e6bd70', label: t('appearance.accentAmber') },
      { id: 'orange', color: '#f0b183', label: t('appearance.accentOrange') },
      { id: 'lime', color: '#bad983', label: t('appearance.accentLime') },
      { id: 'emerald', color: '#6ed4ae', label: t('appearance.accentEmerald') },
      { id: 'teal', color: '#6fd0c4', label: t('appearance.accentTeal') },
      { id: 'cyan', color: '#76cbd5', label: t('appearance.accentCyan') }
    ];
    // The page itself: three on the dark side, three on the light one. Which
    // three are offered follows the side in use, because cream is not a dark
    // background and night blue is not a light one.
    const effectiveMode = window.themeManager.getEffectiveMode();
    const backgrounds = effectiveMode === 'light'
      ? [
        { id: 'bianco', color: '#ffffff', label: t('appearance.bgWhite') },
        { id: 'grigiochiaro', color: '#e9eaee', label: t('appearance.bgLightGrey') },
        { id: 'crema', color: '#f6f1e7', label: t('appearance.bgCream') }
      ]
      : [
        { id: 'nero', color: '#101113', label: t('appearance.bgBlack') },
        { id: 'blunotte', color: '#0c1020', label: t('appearance.bgNavy') },
        { id: 'grigio', color: '#17181a', label: t('appearance.bgGrey') }
      ];
    const backgroundKey = effectiveMode === 'light' ? 'bgLight' : 'bgDark';

    // The secondary takes the same hues plus three neutrals of its own.
    const shades = [
      { id: 'slate', color: '#8295b5', label: t('appearance.shadeSlate') },
      { id: 'charcoal', color: '#a49787', label: t('appearance.shadeCharcoal') },
      { id: 'zinc', color: '#9898a6', label: t('appearance.shadeZinc') },
      ...accents
    ];
    const chips = (items, key) => items.map(item => `
      <button type="button" class="appearance-accent-chip ${prefs[key] === item.id ? 'active' : ''}"
        data-appearance-key="${key}" data-appearance-value="${item.id}" aria-pressed="${prefs[key] === item.id}">
        <span class="accent-circle-preview" style="--swatch: ${item.color}" aria-hidden="true"></span>
        <span>${item.label}</span><i class="fa-solid fa-check appearance-check-icon" aria-hidden="true"></i>
      </button>`).join('');
    const modeLabel = modes.find(item => item.id === prefs.mode).label;
    const backgroundLabel = `${modeLabel} · ${(backgrounds.find(item => item.id === prefs[backgroundKey]) || backgrounds[0]).label}`;
    const primaryLabel = accents.find(item => item.id === prefs.accent).label;
    const shadeLabel = shades.find(item => item.id === prefs.shade).label;
    const focused = document.activeElement;
    const focusKey = focused?.dataset.appearanceKey;
    const focusValue = focused?.dataset.appearanceValue;
    const scrollTop = container.scrollTop;

    container.innerHTML = `
      <div class="appearance-section-heading">
        <div><h2>${t('appearance.title')}</h2><p>${t('appearance.subtitle')}</p></div>
        <span class="appearance-save-note"><i class="fa-solid fa-check" aria-hidden="true"></i> ${t('appearance.autosave')}</span>
      </div>
      <div class="appearance-layout">
        <div class="appearance-controls">
          <section class="appearance-card" aria-labelledby="appearance-mode-title">
            <h3 class="appearance-card-title" id="appearance-mode-title"><span class="appearance-step">1</span>${t('appearance.modeTitle')}</h3>
            <p class="appearance-description">${t('appearance.modeDesc')}</p>
            <div class="appearance-options-row" role="group" aria-labelledby="appearance-mode-title">
              ${modes.map(mode => `<button type="button" class="appearance-option-btn ${prefs.mode === mode.id ? 'active' : ''}"
                data-appearance-key="mode" data-appearance-value="${mode.id}" aria-pressed="${prefs.mode === mode.id}">
                <span class="mode-mini mode-mini-${mode.id}" aria-hidden="true"></span>
                <span class="appearance-option-label"><i class="fa-solid ${mode.icon}" aria-hidden="true"></i>${mode.label}<i class="fa-solid fa-check appearance-check-icon" aria-hidden="true"></i></span>
              </button>`).join('')}
            </div>
          </section>
          <section class="appearance-card" aria-labelledby="appearance-background-title">
            <h3 class="appearance-card-title" id="appearance-background-title"><span class="appearance-step">2</span>${t('appearance.backgroundTitle')}</h3>
            <p class="appearance-description">${t('appearance.backgroundDesc')}</p>
            <div class="appearance-accent-grid" role="group" aria-labelledby="appearance-background-title">${chips(backgrounds, backgroundKey)}</div>
          </section>
          <section class="appearance-card" aria-labelledby="appearance-primary-title">
            <h3 class="appearance-card-title" id="appearance-primary-title"><span class="appearance-step">3</span>${t('appearance.accentTitle')}</h3>
            <p class="appearance-description">${t('appearance.accentDesc')}</p>
            <div class="appearance-accent-grid" role="group" aria-labelledby="appearance-primary-title">${chips(accents, 'accent')}</div>
          </section>
          <section class="appearance-card" aria-labelledby="appearance-shade-title">
            <h3 class="appearance-card-title" id="appearance-shade-title"><span class="appearance-step">4</span>${t('appearance.shadeTitle')}</h3>
            <p class="appearance-description">${t('appearance.shadeDesc')}</p>
            <div class="appearance-accent-grid appearance-shade-grid" role="group" aria-labelledby="appearance-shade-title">${chips(shades, 'shade')}</div>
          </section>
          <section class="appearance-card appearance-details" aria-labelledby="appearance-typography-title">
            <h3 class="appearance-card-title" id="appearance-typography-title"><span class="appearance-step">5</span>${t('appearance.typographyTitle')}</h3>
            <div class="appearance-details-fields">
              <label for="select-appearance-font">${t('appearance.fontTitle')}<select id="select-appearance-font" class="select-control" data-appearance-key="font">
                ${['inter', 'mono', 'system', 'outfit'].map(id => `<option value="${id}" ${prefs.font === id ? 'selected' : ''}>${t('appearance.font' + id[0].toUpperCase() + id.slice(1))}</option>`).join('')}
              </select></label>
              <label for="select-appearance-radius">${t('appearance.radiusTitle')}<select id="select-appearance-radius" class="select-control" data-appearance-key="radius">
                ${['sharp', 'standard', 'soft'].map(id => `<option value="${id}" ${prefs.radius === id ? 'selected' : ''}>${t('appearance.radius' + id[0].toUpperCase() + id.slice(1))}</option>`).join('')}
              </select></label>
              <label for="select-appearance-lines">${t('appearance.linesTitle')}<select id="select-appearance-lines" class="select-control" data-appearance-key="lines">
                ${[['sheet', t('appearance.linesSheet')], ['boxed', t('appearance.linesBoxed')]].map(([id, label]) => `<option value="${id}" ${prefs.lines === id ? 'selected' : ''}>${label}</option>`).join('')}
              </select></label>
              <label for="select-appearance-bubbles">${t('appearance.bubblesTitle')}<select id="select-appearance-bubbles" class="select-control" data-appearance-key="bubbles">
                ${[['clean', t('appearance.bubblesClean')], ['boxed', t('appearance.bubblesBoxed')]].map(([id, label]) => `<option value="${id}" ${prefs.bubbles === id ? 'selected' : ''}>${label}</option>`).join('')}
              </select></label>
            </div>
          </section>
          <section class="appearance-card" aria-labelledby="appearance-audio-title">
            <h3 class="appearance-card-title" id="appearance-audio-title"><span class="appearance-step"><i class="fa-solid fa-volume-high"></i></span>${t('appearance.audioTitle')}</h3>
            <p class="appearance-description">${t('appearance.audioDesc')}</p>
            <div class="appearance-audio-fields">
              <label class="appearance-audio-field" for="select-appearance-sound-startup">
                <span>${t('appearance.startupSoundTitle')}</span>
                <select id="select-appearance-sound-startup" class="select-control" data-audio-key="startup">
                  <option value="true" ${localStorage.getItem('synthorg_startup_sound') !== 'false' ? 'selected' : ''}>${t('appearance.startupSoundEnabled')}</option>
                  <option value="false" ${localStorage.getItem('synthorg_startup_sound') === 'false' ? 'selected' : ''}>${t('appearance.startupSoundDisabled')}</option>
                </select>
              </label>
              <label class="appearance-audio-field" for="select-appearance-sound-notification">
                <span>${t('appearance.notificationSoundTitle')}</span>
                <select id="select-appearance-sound-notification" class="select-control" data-audio-key="notification">
                  ${['pulse', 'subtle', 'chime', 'none'].map(key => {
                    const current = localStorage.getItem('synthorg_notification_sound') || 'pulse';
                    return `<option value="${key}" ${current === key ? 'selected' : ''}>${t('appearance.sound' + key[0].toUpperCase() + key.slice(1))}</option>`;
                  }).join('')}
                </select>
              </label>
              <label class="appearance-audio-field" for="select-appearance-sound-environment">
                <span>${t('appearance.envSoundTitle')}</span>
                <select id="select-appearance-sound-environment" class="select-control" data-audio-key="environment">
                  <option value="true" ${localStorage.getItem('synthorg_env_sound') !== 'false' ? 'selected' : ''}>${t('appearance.envSoundEnabled')}</option>
                  <option value="false" ${localStorage.getItem('synthorg_env_sound') === 'false' ? 'selected' : ''}>${t('appearance.envSoundDisabled')}</option>
                </select>
              </label>
            </div>
          </section>
        </div>
        <aside class="appearance-preview" aria-label="${t('appearance.previewAria')}">
          <p class="preview-eyebrow">${t('appearance.previewEyebrow')}</p>
          <div class="preview-canvas">
            <div class="preview-toolbar"><i class="fa-solid fa-microchip" aria-hidden="true"></i><span>SynthOrg</span><span>Workspace</span></div>
            <div class="preview-model-card">
              <div class="preview-model-icon"><i class="fa-solid fa-layer-group" aria-hidden="true"></i></div>
              <h3>${t('appearance.previewHeading')}</h3>
              <p>${t('appearance.previewBody')}</p>
              <div class="preview-model-meta"><i class="fa-solid fa-check" aria-hidden="true"></i> ${t('appearance.previewReady')}</div>
            </div>
            <div class="preview-composer"><span>${t('appearance.previewComposer')}</span><span class="preview-send"><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></span></div>
          </div>
          <dl class="preview-legend" aria-live="polite">
            <div><dt>${t('appearance.legendBackground')}</dt><dd><span class="preview-dot preview-dot-mode"></span>${backgroundLabel}</dd></div>
            <div><dt>${t('appearance.legendPrimary')}</dt><dd><span class="preview-dot"></span>${primaryLabel}</dd></div>
            <div><dt>${t('appearance.legendShade')}</dt><dd><span class="preview-dot preview-dot-shade"></span>${shadeLabel}</dd></div>
          </dl>
        </aside>
      </div>`;
    const setters = { mode: 'setMode', accent: 'setAccent', shade: 'setShade', font: 'setFont', radius: 'setRadius', bubbles: 'setBubbles', lines: 'setLines',
      bgDark: 'setBackground', bgLight: 'setBackground' };
    container.querySelectorAll('[data-appearance-key]').forEach(control => {
      control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'click', () => {
        window.themeManager[setters[control.dataset.appearanceKey]](control.dataset.appearanceValue || control.value);
        renderAppearanceSection();
      });
    });
    const startupSoundSelect = container.querySelector('[data-audio-key="startup"]');
    if (startupSoundSelect) {
      startupSoundSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        try { localStorage.setItem('synthorg_startup_sound', val); } catch {}
        if (window.chatStorage?.setSetting) {
          window.chatStorage.setSetting('startup_sound', val).catch(() => {});
        }
        if (val === 'true') {
          playStartupChime();
        }
      });
    }
    const envSoundSelect = container.querySelector('[data-audio-key="environment"]');
    if (envSoundSelect) {
      envSoundSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        try { localStorage.setItem('synthorg_env_sound', val); } catch {}
        if (window.chatStorage?.setSetting) {
          window.chatStorage.setSetting('env_sound', val).catch(() => {});
        }
        if (val === 'true') {
          playEnvironmentReady();
        }
      });
    }
    const notifSoundSelect = container.querySelector('[data-audio-key="notification"]');
    if (notifSoundSelect) {
      notifSoundSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        try { localStorage.setItem('synthorg_notification_sound', val); } catch {}
        if (window.chatStorage?.setSetting) {
          window.chatStorage.setSetting('notification_sound', val).catch(() => {});
        }
        if (val !== 'none') {
          playNotificationSound(val);
        }
      });
    }
    if (focusKey) {
      const selector = `[data-appearance-key="${focusKey}"]${focusValue ? `[data-appearance-value="${focusValue}"]` : ''}`;
      container.querySelector(selector)?.focus({ preventScroll: true });
    }
    container.scrollTop = scrollTop;
  }
  window.renderAppearanceSection = renderAppearanceSection;

  /**
   * Render System Prompts Section (APIC-inspired modular prompt manager)
   */
  // Settings › Prompts & memory › Chat memory: the values for every chat, and
  // whether a new chat starts with the level memory on. Each chat can have its own.
  function renderMemorySettings(container) {
    const subContent = document.createElement('div');
    subContent.className = 'privacy-workspace';
    subContent.innerHTML = `
      <div class="privacy-section-heading">
        <div>
          <h2><i class="fa-solid fa-layer-group" style="color: var(--primary); margin-right: 8px;"></i> ${t('privacy.memoryCardTitle')}</h2>
        </div>
        <div id="privacy-saved-feedback" class="privacy-save-feedback" style="display: none;">
          <i class="fa-solid fa-check"></i> <span>${t('privacy.savedFeedback')}</span>
        </div>
      </div>
      <!-- Chat memory: the global values, and whether new chats start with it on -->
      <article class="privacy-card privacy-card-wide" id="memory-global-card">
        <div class="privacy-card-header">
          <div class="privacy-card-title-group">
            <div class="privacy-card-icon"><i class="fa-solid fa-layer-group"></i></div>
            <div>
              <h3 class="privacy-card-title">${t('privacy.memoryCardTitle')}</h3>
              <span class="privacy-badge"><i class="fa-solid fa-sitemap"></i> ${t('privacy.memoryCardBadge')}</span>
            </div>
          </div>
        </div>
        <p class="privacy-card-desc">${t('memory.levelsHint')}</p>
        <div class="privacy-card-toggle-row">
          <label class="privacy-toggle-label" for="toggle-memory-default">
            <span class="privacy-toggle-title">${t('privacy.memoryDefaultLabel')}</span>
            <span class="privacy-toggle-status">${t('privacy.memoryDefaultHint')}</span>
          </label>
          <label class="synth-switch" for="toggle-memory-default">
            <input type="checkbox" id="toggle-memory-default">
            <span class="synth-slider"></span>
          </label>
        </div>
        <div class="memory-levels-settings">
          <label class="memory-field" for="memory-global-cap"><span>${t('memory.levelsCap')}</span><input type="number" id="memory-global-cap" min="4000" step="1000"><small>${t('memory.levelsCapHint')}</small></label>
          <label class="memory-field" for="memory-global-share"><span>${t('memory.levelsShare')}</span><input type="number" id="memory-global-share" min="0" max="90" step="5"><small>${t('memory.levelsShareHint')}</small></label>
          <label class="memory-field" for="memory-global-recent"><span>${t('memory.levelsRecent')}</span><input type="number" id="memory-global-recent" min="0" max="50" step="1"><small>${t('memory.levelsRecentHint')}</small></label>
        </div>
        <p class="memory-levels-hint">${t('privacy.memoryPerChatNote')}</p>
      </article>

      <!-- Global dossier: which Code projects count as active -->
      <article class="privacy-card privacy-card-wide" id="dossier-global-card">
        <div class="privacy-card-header">
          <div class="privacy-card-title-group">
            <div class="privacy-card-icon"><i class="fa-solid fa-address-card"></i></div>
            <div><h3 class="privacy-card-title">${t('privacy.dossierCardTitle')}</h3></div>
          </div>
        </div>
        <p class="privacy-card-desc">${t('privacy.dossierCardDesc')}</p>
        <div class="memory-levels-settings">
          <label class="memory-field" for="dossier-active-days"><span>${t('privacy.dossierActiveDays')}</span><input type="number" id="dossier-active-days" min="1" max="3650" step="1"><small>${t('privacy.dossierActiveDaysHint')}</small></label>
        </div>
      </article>
    `;
    container.appendChild(subContent);
    const showSavedFeedback = () => {
      const feedback = subContent.querySelector('#privacy-saved-feedback');
      if (!feedback) return;
      feedback.style.display = 'inline-flex';
      clearTimeout(feedback._timer);
      feedback._timer = setTimeout(() => { feedback.style.display = 'none'; }, 2200);
    };
    // Chat memory: the global values and the switch for new chats, kept by the service.
    (async () => {
      const read = async key => { try { return (await window.chatStorage.getSetting(key)).value; } catch { return null; } };
      const [enabled, capValue, shareValue, recentValue] = await Promise.all(['memory_default_enabled', 'memory_context_cap', 'memory_tree_share', 'memory_recent_turns'].map(read));
      const toggle = subContent.querySelector('#toggle-memory-default');
      const capField = subContent.querySelector('#memory-global-cap');
      const shareField = subContent.querySelector('#memory-global-share');
      const recentField = subContent.querySelector('#memory-global-recent');
      if (!toggle || !capField) return;
      toggle.checked = enabled === 'true';
      capField.value = capValue ?? 32000;
      shareField.value = shareValue === null || shareValue === undefined ? 30 : Math.round(Number(shareValue) * 100);
      recentField.value = recentValue ?? 4;
      toggle.addEventListener('change', () => {
        window.chatStorage.setSetting('memory_default_enabled', toggle.checked ? 'true' : 'false').then(showSavedFeedback).catch(() => {});
      });
      const saveValues = () => Promise.all([
        window.chatStorage.setSetting('memory_context_cap', String(Math.max(4000, parseInt(capField.value, 10) || 32000))),
        window.chatStorage.setSetting('memory_tree_share', String(Math.min(90, Math.max(0, parseInt(shareField.value, 10) || 0)) / 100)),
        window.chatStorage.setSetting('memory_recent_turns', String(Math.min(50, Math.max(0, parseInt(recentField.value, 10) || 0))))
      ]).then(showSavedFeedback).catch(() => {});
      capField.addEventListener('change', saveValues);
      const daysField = subContent.querySelector('#dossier-active-days');
      if (daysField) {
        read('dossier_active_days').then(v => { daysField.value = v ?? 30; });
        daysField.addEventListener('change', () => {
          window.chatStorage.setSetting('dossier_active_days', String(Math.min(3650, Math.max(1, parseInt(daysField.value, 10) || 30)))).then(showSavedFeedback).catch(() => {});
        });
      }
      shareField.addEventListener('change', saveValues);
      recentField.addEventListener('change', saveValues);
    })();

  }

  // The two tabs of Settings › Prompts & memory.
  let promptsActiveSubTab = 'prompts'; // 'prompts' | 'memory'
  function promptsSubnav() {
    return `
      <div class="env-subnav-bar prompts-subnav">
        <button type="button" class="env-subnav-btn ${promptsActiveSubTab === 'prompts' ? 'active' : ''}" data-prompts-subtab="prompts">
          <i class="fa-solid fa-terminal"></i><span>${t('prompts.tabSystem')}</span>
        </button>
        <button type="button" class="env-subnav-btn ${promptsActiveSubTab === 'memory' ? 'active' : ''}" data-prompts-subtab="memory">
          <i class="fa-solid fa-layer-group"></i><span>${t('privacy.memoryCardTitle')}</span>
        </button>
      </div>`;
  }
  function bindPromptsSubnav(container) {
    container.querySelectorAll('[data-prompts-subtab]').forEach(btn => {
      btn.addEventListener('click', () => { promptsActiveSubTab = btn.dataset.promptsSubtab; renderPromptsSection(); });
    });
  }

  function renderPromptsSection() {
    const container = elements.settingsSubviewPrompts;
    if (!container || !window.promptManager) return;
    if (promptsActiveSubTab === 'memory') {
      container.innerHTML = promptsSubnav();
      bindPromptsSubnav(container);
      renderMemorySettings(container);
      return;
    }
    const pm = window.promptManager;
    const scrollTop = container.scrollTop;

    const sections = pm.sections;
    const currentMasterId = window.operationalRegistry ? window.operationalRegistry.getSelectedMasterId() : 'anthropic/claude-3.7-sonnet';

    const cardsHtml = sections.map(sec => {
      const secState = pm.getSectionState(sec.id);
      const text = pm.getSectionText(sec.id);
      const approxTokens = Math.ceil(text.length / 4);

      return `
        <article class="prompt-card" id="prompt-card-${sec.id}">
          <div class="prompt-card-header">
            <div class="prompt-card-info">
              <div class="prompt-card-icon"><i class="fa-solid ${sec.icon}"></i></div>
              <div>
                <h3 class="prompt-card-title">${sec.name}</h3>
                <p class="prompt-card-desc">${sec.description}</p>
              </div>
            </div>
            <div class="prompt-segmented-control" role="group" aria-label="Modalità preset per ${sec.name}">
              <button type="button" class="prompt-pill-btn ${secState.mode === 'short' ? 'active' : ''}"
                data-prompt-action="set-mode" data-section="${sec.id}" data-mode="short"
                title="Versione sintetica, diretta e concisa">
                <i class="fa-solid fa-bolt"></i> Corto
              </button>
              <button type="button" class="prompt-pill-btn ${secState.mode === 'long' ? 'active' : ''}"
                data-prompt-action="set-mode" data-section="${sec.id}" data-mode="long"
                title="Versione esaustiva, dettagliata e approfondita">
                <i class="fa-solid fa-book-open"></i> Lungo
              </button>
              <button type="button" class="prompt-pill-btn ${secState.mode === 'custom' ? 'active' : ''}"
                data-prompt-action="set-mode" data-section="${sec.id}" data-mode="custom"
                title="Istruzioni personalizzate scritte da te">
                <i class="fa-solid fa-pen"></i> Personalizzato
              </button>
            </div>
          </div>
          <div class="prompt-editor-wrap">
            <textarea class="prompt-editor-textarea" data-section="${sec.id}" rows="3"
              placeholder="${t('prompts.editorPlaceholder')}"
              spellcheck="false">${text}</textarea>
            <div class="prompt-editor-meta">
              <span class="prompt-char-count">
                <i class="fa-solid fa-calculator"></i> ${t('prompts.tokenCount', { tokens: approxTokens, chars: text.length })}
              </span>
              <button type="button" class="btn btn-sm btn-prompt-reset" data-prompt-action="reset-section" data-section="${sec.id}">
                <i class="fa-solid fa-rotate-left"></i> ${t('prompts.resetSection')}
              </button>
            </div>
          </div>
        </article>
      `;
    }).join('');

    // Compile preview (esclude il blocco core nascosto per non esporlo nel prompt completo)
    const fullPreview = pm.compileSystemPrompt({
      modelId: currentMasterId,
      isChatOffline: false,
      memories: [],
      includeHidden: false,
      toolsSection: '\n\n[AVAILABLE TOOLS]\n- web_search: Web Search (Puppeteer + Stealth). Input: query (string). Engine: built-in (SynthOrg).'
    });

    container.innerHTML = promptsSubnav() + `
      <div class="prompts-section-heading">
        <div>
          <h2><i class="fa-solid fa-terminal" style="color: var(--primary); margin-right: 8px;"></i> ${t('prompts.heading')}</h2>
          <p>${t('prompts.headingDesc')}</p>
        </div>
        <div class="prompts-header-actions">
          <button type="button" class="btn btn-secondary btn-sm" id="btn-prompts-reset-all">
            <i class="fa-solid fa-rotate-left"></i> ${t('prompts.resetAll')}
          </button>
          <span class="appearance-save-note"><i class="fa-solid fa-check" aria-hidden="true"></i> ${t('appearance.autosave')}</span>
        </div>
      </div>

      <div class="prompts-layout">
        <!-- Hidden Core Banner -->
        <div class="prompt-core-banner">
          <div class="prompt-core-header">
            <span class="prompt-core-tag"><i class="fa-solid fa-shield-halved"></i> ${t('prompts.coreTag')}</span>
            <span class="prompt-core-note">${t('prompts.coreNote')}</span>
          </div>
          <p class="prompt-core-desc">
            ${t('prompts.coreDesc')}
          </p>
        </div>

        <!-- Section Cards -->
        <div class="prompt-cards-grid">
          ${cardsHtml}
        </div>

        <!-- Live Preview Inspector -->
        <details class="prompt-live-preview-card">
          <summary class="prompt-preview-summary">
            <span><i class="fa-solid fa-eye" style="color: var(--primary); margin-right: 6px;"></i> Ispezione Prompt Finale Completo (Live Preview)</span>
            <span class="prompt-preview-badge">~${Math.ceil(fullPreview.length / 4)} token totali</span>
          </summary>
          <div class="prompt-preview-body">
            <div class="prompt-preview-actions">
              <button type="button" class="btn btn-sm btn-secondary" id="btn-copy-full-prompt">
                <i class="fa-solid fa-copy"></i> Copia prompt completo
              </button>
            </div>
            <pre class="prompt-preview-pre"><code>${fullPreview.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>
          </div>
        </details>
      </div>
    `;

    // Attach event listeners
    container.querySelectorAll('[data-prompt-action="set-mode"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const secId = btn.dataset.section;
        const mode = btn.dataset.mode;
        pm.setSectionMode(secId, mode);
        renderPromptsSection();
      });
    });

    container.querySelectorAll('.prompt-editor-textarea').forEach(textarea => {
      textarea.addEventListener('input', () => {
        const secId = textarea.dataset.section;
        pm.setSectionCustomText(secId, textarea.value);
        const card = document.getElementById(`prompt-card-${secId}`);
        if (card) {
          card.querySelectorAll('.prompt-pill-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.mode === 'custom');
          });
          const meta = card.querySelector('.prompt-char-count');
          if (meta) {
            const val = textarea.value;
            meta.innerHTML = `<i class="fa-solid fa-calculator"></i> ~${Math.ceil(val.length / 4)} token (${val.length} caratteri)`;
          }
        }
      });
    });

    container.querySelectorAll('[data-prompt-action="reset-section"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const secId = btn.dataset.section;
        pm.resetSection(secId);
        renderPromptsSection();
      });
    });

    const resetAllBtn = container.querySelector('#btn-prompts-reset-all');
    if (resetAllBtn) {
      resetAllBtn.addEventListener('click', () => {
        if (confirm('Ripristinare tutte le sezioni di prompt ai valori predefiniti?')) {
          pm.resetAll();
          renderPromptsSection();
        }
      });
    }

    const copyBtn = container.querySelector('#btn-copy-full-prompt');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        copyToClipboard(fullPreview, copyBtn);
      });
    }

    bindPromptsSubnav(container);
    container.scrollTop = scrollTop;
  }
  window.renderPromptsSection = renderPromptsSection;

  /**
   * Render Environment & Security Section (Modular with Sub-tabs)
   */
  let envActiveSubTab = 'packages'; // 'packages' | 'security'
  let envActiveFilter = 'all';
  let envSearchQuery = '';

  function setupPasswordToggles(root) {
    if (!root) return;
    root.querySelectorAll('.btn-toggle-pw').forEach(btn => {
      if (btn._hasPwToggle) return;
      btn._hasPwToggle = true;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const wrap = btn.closest('.password-field-wrap');
        const input = wrap?.querySelector('input');
        const icon = btn.querySelector('i');
        if (!input) return;
        if (input.type === 'password') {
          input.type = 'text';
          if (icon) icon.className = 'fa-regular fa-eye-slash';
        } else {
          input.type = 'password';
          if (icon) icon.className = 'fa-regular fa-eye';
        }
      });
    });
  }

  async function renderEnvironmentSection() {
    const container = elements.settingsSubviewEnvironment;
    if (!container) return;

    // Sub-navigation bar
    const subnavHtml = `
      <div class="env-subnav-bar">
        <button type="button" class="env-subnav-btn ${envActiveSubTab === 'packages' ? 'active' : ''}" data-env-subtab="packages">
          <i class="fa-solid fa-box-open"></i>
          <span>${t('env.tabPackages')}</span>
        </button>
        <button type="button" class="env-subnav-btn ${envActiveSubTab === 'security' ? 'active' : ''}" data-env-subtab="security">
          <i class="fa-solid fa-shield-halved"></i>
          <span>${t('env.tabSecurity')}</span>
        </button>
        <button type="button" class="env-subnav-btn ${envActiveSubTab === 'privacy' ? 'active' : ''}" data-env-subtab="privacy">
          <i class="fa-solid fa-bolt"></i>
          <span>${t('privacy.sectionTitle')}</span>
        </button>
      </div>
    `;

    if (envActiveSubTab === 'security') {
      container.innerHTML = subnavHtml;
      bindSubnavButtons();
      await renderSecuritySection(container);
      return;
    }

    if (envActiveSubTab === 'privacy') {
      container.innerHTML = subnavHtml;
      bindSubnavButtons();
      renderPrivacyCachingContent(container);
      return;
    }

    // Packages Sub-section
    let packages = [];
    try {
      packages = await window.chatStorage.getPackages();
    } catch (e) {
      console.warn('[Environment] Impossibile recuperare pacchetti:', e.message);
    }

    // The editor extensions of a coding project live here too: same page, same
    // switch, because they are one more thing the environment may carry.
    let extensions = { items: [], enabled: 0, total: 0, bytes: 0 };
    try {
      extensions = await window.chatStorage.getCodeExtensions();
    } catch (e) {
      console.warn('[Environment] Impossibile recuperare le estensioni:', e.message);
    }

    const filtered = (packages || []).filter(pkg => {
      if (envActiveFilter === 'python' && pkg.runtime !== 'python') return false;
      if (envActiveFilter === 'nodejs' && pkg.runtime !== 'nodejs') return false;
      if (envActiveFilter === 'default' && !pkg.isDefault) return false;
      if (envSearchQuery) {
        const q = envSearchQuery.toLowerCase();
        const text = `${pkg.name} ${pkg.title || ''} ${pkg.description || ''}`.toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });

    container.innerHTML = subnavHtml + `
      <div class="env-header">
        <div class="env-title-group">
          <h2><i class="fa-solid fa-box-open"></i> ${t('env.packagesHeading')}</h2>
          <p>${t('env.packagesDesc')}</p>
        </div>
        <button class="btn btn-secondary" id="btn-scan-packages" style="display: inline-flex; align-items: center; gap: 8px;">
          <i class="fa-solid fa-arrows-rotate"></i>
          <span>${t('env.btnScanCache')}</span>
        </button>
      </div>

      <div class="env-toolbar">
        <input type="search" class="env-search-input" id="input-packages-search" placeholder="${t('env.searchPackages')}" value="${escapeHtml(envSearchQuery)}">
        <div class="env-filter-pills">
          <button type="button" class="section-pill ${envActiveFilter === 'all' ? 'active' : ''}" data-env-filter="all">${t('env.filterAll', { count: packages.length })}</button>
          <button type="button" class="section-pill ${envActiveFilter === 'python' ? 'active' : ''}" data-env-filter="python">Python</button>
          <button type="button" class="section-pill ${envActiveFilter === 'nodejs' ? 'active' : ''}" data-env-filter="nodejs">Node.js</button>
          <button type="button" class="section-pill ${envActiveFilter === 'default' ? 'active' : ''}" data-env-filter="default">${t('env.filterDefault', { count: packages.filter(p => p.isDefault).length })}</button>
        </div>
      </div>

      <div class="packages-grid">
        ${filtered.map(pkg => `
          <div class="package-card">
            <div class="package-card-header">
              <div class="package-tags-wrap">
                <span class="package-runtime-tag ${pkg.runtime}">
                  <i class="fa-brands ${pkg.runtime === 'python' ? 'fa-python' : 'fa-node-js'}"></i>
                  ${pkg.runtime === 'python' ? 'Python' : 'Node.js'}
                </span>
                <span class="package-version-tag">v${escapeHtml(pkg.version || 'installed')}</span>
              </div>
              <label class="package-toggle-label" title="${t('env.packageToggleTooltip')}">
                <input type="checkbox" data-pkg-name="${pkg.name}" ${pkg.isDefault ? 'checked' : ''}>
                <span>${t('env.packageDefault')}</span>
              </label>
            </div>
            <h4>${escapeHtml(pkg.title || pkg.name)}</h4>
            <p class="package-desc">${escapeHtml(pkg.description || '')}</p>
            <div class="package-import-hint">
              <code>${pkg.runtime === 'python' ? `import ${pkg.name}` : `const ${pkg.name} = require('${pkg.name}');`}</code>
            </div>
          </div>
        `).join('') || `<p style="color: var(--text-dim); padding: 24px;">${t('env.noPackages')}</p>`}
      </div>

      <div class="env-header env-header-secondary">
        <div class="env-title-group">
          <h2><i class="fa-solid fa-puzzle-piece"></i> ${t('env.extensionsHeading')}</h2>
          <p>${t('env.extensionsDesc')}</p>
        </div>
        <span class="env-extensions-summary">${extensions.items
          ? t('env.extensionsSummary', { enabled: extensions.enabled, total: extensions.total, mb: (extensions.bytes / 1048576).toFixed(0) })
          : ''}</span>
      </div>
      <p class="env-extensions-hint">${t('env.extensionsRebuild')}</p>

      <div class="packages-grid">
        ${(extensions.items || []).map(ext => `
          <div class="package-card">
            <div class="package-card-header">
              <div class="package-tags-wrap">
                <span class="package-version-tag">${(ext.bytes / 1048576).toFixed(1)} MB</span>
                ${ext.categories.slice(0, 1).map(category => `<span class="package-version-tag">${escapeHtml(category)}</span>`).join('')}
              </div>
              <label class="package-toggle-label" title="${t('env.extensionToggleTooltip')}">
                <input type="checkbox" data-ext-name="${escapeHtml(ext.name)}" ${ext.enabled ? 'checked' : ''}>
                <span>${t('env.extensionEnabled')}</span>
              </label>
            </div>
            <h4>${escapeHtml(ext.title || ext.name)}</h4>
            <p class="package-desc">${escapeHtml(ext.description || '')}</p>
            <div class="package-import-hint"><code>${escapeHtml(ext.name)}</code></div>
          </div>
        `).join('') || `<p style="color: var(--text-dim); padding: 24px;">${t('env.noExtensions')}</p>`}
      </div>
    `;

    bindSubnavButtons();

    // Turning one off changes what the next project's image is built from, so
    // the list is re-read rather than assumed after every change.
    container.querySelectorAll('[data-ext-name]').forEach(box => {
      box.addEventListener('change', async event => {
        const input = event.target;
        input.disabled = true;
        try {
          await window.chatStorage.setCodeExtension(input.dataset.extName, input.checked);
          await renderEnvironmentSection();
        } catch (error) {
          input.checked = !input.checked;
          input.disabled = false;
          console.warn('[Environment] Estensione non aggiornata:', error.message);
        }
      });
    });

    // Bind event listeners for packages
    const searchInput = container.querySelector('#input-packages-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        envSearchQuery = e.target.value.trim();
        renderEnvironmentSection();
      });
    }

    container.querySelectorAll('[data-env-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        envActiveFilter = btn.dataset.envFilter;
        renderEnvironmentSection();
      });
    });

    const scanBtn = container.querySelector('#btn-scan-packages');
    if (scanBtn) {
      scanBtn.addEventListener('click', async () => {
        scanBtn.disabled = true;
        scanBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Scansione in corso…';
        try {
          await window.chatStorage.scanPackages();
          await window.chatManager?.refreshPackagesCache?.();
          await renderEnvironmentSection();
        } finally {
          scanBtn.disabled = false;
        }
      });
    }

    container.querySelectorAll('input[data-pkg-name]').forEach(input => {
      input.addEventListener('change', async (e) => {
        const name = input.dataset.pkgName;
        const isDefault = e.target.checked;
        try {
          await window.chatStorage.togglePackageDefault(name, isDefault);
          await window.chatManager?.refreshPackagesCache?.();
          if (envActiveFilter === 'default') {
            await renderEnvironmentSection();
          }
        } catch (err) {
          console.error('[Environment] Errore toggle pacchetto:', err);
          e.target.checked = !isDefault;
        }
      });
    });

    function bindSubnavButtons() {
      container.querySelectorAll('[data-env-subtab]').forEach(btn => {
        btn.addEventListener('click', () => {
          envActiveSubTab = btn.dataset.envSubtab;
          renderEnvironmentSection();
        });
      });
    }
  }

  async function renderSecuritySection(container) {
    let status = {
      isEncrypted: false,
      isUnlocked: true,
      canLock: false,
      targets: { sql: false, sandboxes: false },
      sql: { isEncrypted: false, isUnlocked: true },
      sandboxes: { isEncrypted: false, isUnlocked: true }
    };
    try {
      status = await window.chatStorage.getSecurityStatus();
    } catch (e) {
      console.warn('[Security] Impossibile recuperare stato:', e);
    }

    const subContent = document.createElement('div');
    subContent.className = 'security-workspace';

    const sqlEnc = !!status.sql?.isEncrypted;
    const sandboxesEnc = !!status.sandboxes?.isEncrypted;

    // Dual Status Cards Grid HTML
    const statusGridHtml = `
      <div class="sec-status-grid">
        <!-- Card 1: SQLite Database -->
        <div class="sec-status-card ${sqlEnc ? 'is-protected' : 'is-unprotected'}">
          <div class="sec-status-header">
            <div class="sec-status-header-main">
              <div class="sec-status-icon-badge ${sqlEnc ? 'is-protected' : 'is-unprotected'}">
                <i class="fa-solid fa-database"></i>
              </div>
              <div class="sec-status-card-titles">
                <span class="sec-card-name">Database SQLite</span>
                <span class="sec-card-category">Storage Relazionale & Memorie</span>
              </div>
            </div>
            <span class="sec-badge ${sqlEnc ? 'sec-badge-protected' : 'sec-badge-unprotected'}">
              <i class="fa-solid ${sqlEnc ? 'fa-shield-halved' : 'fa-unlock'}"></i>
              ${sqlEnc ? 'Cifrato' : 'In Chiaro'}
            </span>
          </div>
          <p class="sec-status-card-desc">
            ${sqlEnc 
              ? 'Tutte le chat, memorie a lungo termine, agenti, task e credenziali API sono protette a riposo con crittografia autenticata AES-256-GCM.' 
              : 'Conversazioni, cronologia, memorie e chiavi API sono salvate in formato standard aperto senza crittografia.'}
          </p>
          <div class="sec-status-card-footer">
            <i class="fa-regular fa-file"></i>
            <span>${sqlEnc ? 'Percorso attivo: <code>data/synthorg.sqlite.enc</code>' : 'Percorso attivo: <code>data/synthorg.sqlite</code>'}</span>
          </div>
        </div>

        <!-- Card 2: Podman Sandbox -->
        <div class="sec-status-card ${sandboxesEnc ? 'is-protected' : 'is-unprotected'}">
          <div class="sec-status-header">
            <div class="sec-status-header-main">
              <div class="sec-status-icon-badge ${sandboxesEnc ? 'is-protected' : 'is-unprotected'}">
                <i class="fa-solid fa-cube"></i>
              </div>
              <div class="sec-status-card-titles">
                <span class="sec-card-name">Sandbox & Workspace Podman</span>
                <span class="sec-card-category">Ambienti Virtuali & Container</span>
              </div>
            </div>
            <span class="sec-badge ${sandboxesEnc ? 'sec-badge-protected' : 'sec-badge-unprotected'}">
              <i class="fa-solid ${sandboxesEnc ? 'fa-shield-halved' : 'fa-unlock'}"></i>
              ${sandboxesEnc ? 'Cifrato' : 'In Chiaro'}
            </span>
          </div>
          <p class="sec-status-card-desc">
            ${sandboxesEnc 
              ? 'I workspace di ogni sessione chat, file generati dagli agenti e script di calcolo sono compressi e protetti con AES-256-GCM.' 
              : 'I file e workspace dei container risiedono su disco locale in cartelle non cifrate. I container persistono e si riattivano all’occorrenza.'}
          </p>
          <div class="sec-status-card-footer">
            <i class="fa-regular fa-folder"></i>
            <span>${sandboxesEnc ? 'Archivio: <code>data/sandboxes.enc</code>' : 'Directory: <code>data/sandboxes/</code>'}</span>
          </div>
        </div>
      </div>
    `;

    if (!status.isEncrypted) {
      subContent.innerHTML = `
        ${statusGridHtml}

        <div class="sec-enable-layout">
          <div class="sec-card">
            <div class="sec-card-header">
              <h3><i class="fa-solid fa-key" style="color: var(--primary);"></i> ${t('security.enableTitle')}</h3>
              <p>${t('security.enableDesc')}</p>
            </div>
            <form id="form-enable-vault" onsubmit="return false;" style="display: flex; flex-direction: column; gap: 16px;">
              <div class="sec-targets-select-box">
                <div class="sec-targets-title"><i class="fa-solid fa-sliders"></i> Seleziona Componenti da Cifrare</div>
                <div class="sec-targets-options">
                  <label class="sec-target-checkbox-item" for="check-target-sql">
                    <input type="checkbox" id="check-target-sql" checked>
                    <div class="sec-target-meta">
                      <span class="sec-target-label"><i class="fa-solid fa-database"></i> Database SQLite</span>
                      <span class="sec-target-hint">Cifra l'archivio centrale (cronologia chat, memorie, chiavi API, impostazioni)</span>
                    </div>
                  </label>
                  <label class="sec-target-checkbox-item" for="check-target-sandboxes">
                    <input type="checkbox" id="check-target-sandboxes" checked>
                    <div class="sec-target-meta">
                      <span class="sec-target-label"><i class="fa-solid fa-cube"></i> Sandbox & Workspace Podman</span>
                      <span class="sec-target-hint">${t('security.targetSandboxHint')}</span>
                    </div>
                  </label>
                </div>
              </div>

              <div class="sec-input-row">
                <label for="input-vault-new-pw">${t('security.newPasswordLabel', { min: MIN_MASTER_PASSWORD })}</label>
                <div class="password-field-wrap">
                  <input type="password" id="input-vault-new-pw" class="vault-password-input" placeholder="${t('security.newPasswordPlaceholder')}" required minlength="${MIN_MASTER_PASSWORD}" autocomplete="new-password">
                  <button type="button" class="btn-toggle-pw"><i class="fa-regular fa-eye"></i></button>
                </div>
              </div>
              <div class="sec-input-row">
                <label for="input-vault-confirm-pw">${t('security.confirmPasswordLabel')}</label>
                <div class="password-field-wrap">
                  <input type="password" id="input-vault-confirm-pw" class="vault-password-input" placeholder="${t('security.confirmPasswordPlaceholder')}" required minlength="${MIN_MASTER_PASSWORD}" autocomplete="new-password">
                  <button type="button" class="btn-toggle-pw"><i class="fa-regular fa-eye"></i></button>
                </div>
              </div>
              <label class="sec-confirm-checkbox" for="check-vault-ack">
                <input type="checkbox" id="check-vault-ack" required>
                <span>${t('security.ackPrefix')} <strong>${t('security.ackStrong')}</strong> ${t('security.ackSuffix')}</span>
              </label>
              <div id="vault-enable-feedback" style="display: none;"></div>
              <div>
                <button type="submit" class="btn btn-primary" id="btn-submit-enable-vault" style="display: inline-flex; align-items: center; gap: 8px;">
                  <i class="fa-solid fa-lock"></i>
                  <span>Cifra Componenti Selezionati Ora</span>
                </button>
              </div>
            </form>
          </div>

          <aside class="sec-warning-box sec-warning-sidebar">
            <div class="sec-warning-sidebar-header">
              <div class="sec-warning-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
              <h4>${t('security.warningTitle')}</h4>
            </div>
            <div class="sec-warning-text">
              <p>${t('security.warningBody')}</p>
              <div class="sec-warning-loss-alert">
                <i class="fa-solid fa-circle-exclamation"></i>
                <div>
                  <strong style="color: #f59e0b;">${t('security.warningLoss')}</strong>
                  <span>${t('security.warningNoRecovery')}</span>
                </div>
              </div>
            </div>
          </aside>
        </div>
      `;
    } else {
      subContent.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(255, 255, 255, 0.02); border: 1px solid var(--border-default); border-radius: var(--radius-md); padding: 14px 18px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <i class="fa-solid fa-shield-halved" style="color: #10b981; font-size: 18px;"></i>
            <span style="font-size: 13px; font-weight: 500; color: var(--text-main);">Crittografia Master Password attiva ${status.encryptedAt ? `(dal ${new Date(status.encryptedAt).toLocaleDateString()})` : ''}</span>
          </div>
          <div>
            <button type="button" class="btn btn-secondary" id="btn-vault-lock-now" style="display: inline-flex; align-items: center; gap: 8px;">
              <i class="fa-solid fa-lock"></i>
              <span>Blocca SynthOrg Ora</span>
            </button>
          </div>
        </div>

        ${statusGridHtml}

        <div class="sec-manage-grid">
          <div class="sec-card">
            <div class="sec-card-header">
              <h3><i class="fa-solid fa-key" style="color: var(--primary);"></i> ${t('security.changeTitle')}</h3>
              <p>${t('security.changeDesc')}</p>
            </div>
            <form id="form-change-vault-pw" onsubmit="return false;" style="display: flex; flex-direction: column; gap: 14px;">
              <div class="sec-targets-select-box">
                <div class="sec-targets-title"><i class="fa-solid fa-sliders"></i> ${t('security.changeTargets')}</div>
                <div class="sec-targets-options">
                  <label class="sec-target-checkbox-item" for="check-change-target-sql">
                    <input type="checkbox" id="check-change-target-sql" ${status.targets?.sql ? 'checked' : ''}>
                    <div class="sec-target-meta">
                      <span class="sec-target-label"><i class="fa-solid fa-database"></i> Database SQLite</span>
                    </div>
                  </label>
                  <label class="sec-target-checkbox-item" for="check-change-target-sandboxes">
                    <input type="checkbox" id="check-change-target-sandboxes" ${status.targets?.sandboxes ? 'checked' : ''}>
                    <div class="sec-target-meta">
                      <span class="sec-target-label"><i class="fa-solid fa-cube"></i> Sandbox & Workspace Podman</span>
                    </div>
                  </label>
                </div>
              </div>

              <div class="sec-input-row">
                <label for="input-change-old-pw">${t('security.currentPasswordLabel')}</label>
                <div class="password-field-wrap">
                  <input type="password" id="input-change-old-pw" placeholder="${t('security.currentPasswordPlaceholder')}" required autocomplete="current-password">
                  <button type="button" class="btn-toggle-pw"><i class="fa-regular fa-eye"></i></button>
                </div>
              </div>
              <div class="sec-input-row">
                <label for="input-change-new-pw">${t('security.changeNewLabel', { min: MIN_MASTER_PASSWORD })}</label>
                <div class="password-field-wrap">
                  <input type="password" id="input-change-new-pw" placeholder="${t('security.changeNewPlaceholder')}" required minlength="${MIN_MASTER_PASSWORD}" autocomplete="new-password">
                  <button type="button" class="btn-toggle-pw"><i class="fa-regular fa-eye"></i></button>
                </div>
              </div>
              <div class="sec-input-row">
                <label for="input-change-confirm-pw">${t('security.changeConfirmLabel')}</label>
                <div class="password-field-wrap">
                  <input type="password" id="input-change-confirm-pw" placeholder="${t('security.changeConfirmPlaceholder')}" required minlength="${MIN_MASTER_PASSWORD}" autocomplete="new-password">
                  <button type="button" class="btn-toggle-pw"><i class="fa-regular fa-eye"></i></button>
                </div>
              </div>
              <div id="vault-change-feedback" style="display: none;"></div>
              <div>
                <button type="submit" class="btn btn-primary" id="btn-submit-change-pw">
                  <i class="fa-solid fa-rotate"></i> Aggiorna Password
                </button>
              </div>
            </form>
          </div>

          <div class="sec-card" style="border-color: rgba(239, 68, 68, 0.25);">
            <div class="sec-card-header">
              <h3 style="color: #ef4444;"><i class="fa-solid fa-lock-open"></i> Disattiva Crittografia (Ritorna in chiaro)</h3>
              <p>Decifra i componenti selezionati e ripristina la memorizzazione standard senza password su disco locale.</p>
            </div>
            <form id="form-disable-vault" onsubmit="return false;" style="display: flex; flex-direction: column; gap: 14px;">
              <div class="sec-targets-select-box">
                <div class="sec-targets-title"><i class="fa-solid fa-sliders"></i> Seleziona Componenti da Decifrare</div>
                <div class="sec-targets-options">
                  ${status.targets?.sql ? `
                  <label class="sec-target-checkbox-item" for="check-disable-target-sql">
                    <input type="checkbox" id="check-disable-target-sql" checked>
                    <div class="sec-target-meta">
                      <span class="sec-target-label"><i class="fa-solid fa-database"></i> Database SQLite</span>
                      <span class="sec-target-hint">Decifra e ripristina <code>data/synthorg.sqlite</code> in chiaro</span>
                    </div>
                  </label>` : ''}
                  ${status.targets?.sandboxes ? `
                  <label class="sec-target-checkbox-item" for="check-disable-target-sandboxes">
                    <input type="checkbox" id="check-disable-target-sandboxes" checked>
                    <div class="sec-target-meta">
                      <span class="sec-target-label"><i class="fa-solid fa-cube"></i> Sandbox & Workspace Podman</span>
                      <span class="sec-target-hint">Estrae i workspace in <code>data/sandboxes/</code> in chiaro</span>
                    </div>
                  </label>` : ''}
                </div>
              </div>

              <div class="sec-input-row">
                <label for="input-disable-vault-pw">${t('security.disableConfirmLabel')}</label>
                <div class="password-field-wrap">
                  <input type="password" id="input-disable-vault-pw" placeholder="${t('security.currentPasswordShort')}" required autocomplete="current-password">
                  <button type="button" class="btn-toggle-pw"><i class="fa-regular fa-eye"></i></button>
                </div>
              </div>
              <div id="vault-disable-feedback" style="display: none;"></div>
              <div>
                <button type="submit" class="btn btn-danger-action" id="btn-submit-disable-vault">
                  <i class="fa-solid fa-triangle-exclamation"></i> Disattiva Crittografia Selezionata
                </button>
              </div>
            </form>
          </div>
        </div>
      `;
    }

    // What the model may do to a project without asking, for projects that
    // never set their own: the same two switches the editor bar shows.
    let permDefaults = { code: 'manual', terminal: 'manual' };
    try {
      const [code, terminal] = await Promise.all([window.chatStorage.getSetting('code_perm_code'), window.chatStorage.getSetting('code_perm_terminal')]);
      permDefaults = { code: code?.value || 'manual', terminal: terminal?.value || 'manual' };
    } catch (e) { console.warn('[Security] permessi predefiniti non letti:', e.message); }
    const permOption = (kind, mode) => `<option value="${mode}" ${permDefaults[kind] === mode ? 'selected' : ''}>${t({ manual: 'code.permManual', semi: 'code.permSemi', auto: 'code.permAuto' }[mode] || 'code.permManual')}</option>`;
    const permSelect = kind => `<select class="select-control" data-perm-default="${kind}">${['manual', 'semi', 'auto'].map(mode => permOption(kind, mode)).join('')}</select>`;
    subContent.insertAdjacentHTML('beforeend', `
      <div class="sec-perm-block">
        <h3><i class="fa-solid fa-user-shield"></i> ${t('env.permHeading')}</h3>
        <p class="sec-perm-desc">${t('env.permDesc')}</p>
        <div class="sec-perm-grid">
          <label class="sec-perm-field"><span><i class="fa-solid fa-file-pen"></i> ${t('code.permCode')}</span>${permSelect('code')}<small>${t('code.permCodeHint')}</small></label>
          <label class="sec-perm-field"><span><i class="fa-solid fa-terminal"></i> ${t('code.permTerminal')}</span>${permSelect('terminal')}<small>${t('code.permTerminalHint')}</small></label>
        </div>
        <p class="sec-perm-note">${t('env.permOutside')}</p>
      </div>`);
    subContent.querySelectorAll('[data-perm-default]').forEach(select => {
      select.addEventListener('change', () => {
        window.chatStorage.setSetting('code_perm_' + select.dataset.permDefault, select.value).catch(err => console.warn('[Security] permesso non salvato:', err.message));
      });
    });

    // Where the memory of the app is kept — the database and what is the user's own beside it — and the asking for
    // it to be kept elsewhere: another disk, a NAS, a folder that is kept online. Moved when the app next starts.
    const place = document.createElement('div');
    place.className = 'sec-perm-block mem-place';
    subContent.appendChild(place);
    const sizeOf = bytes => bytes === null || bytes === undefined ? '' : bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1048576))} MB`;
    const escPlace = value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const drawPlace = (state, problem = '') => {
      place.innerHTML = `
        <h3><i class="fa-solid fa-hard-drive"></i> ${t('mem.placeHeading')}</h3>
        <p class="sec-perm-desc">${t('mem.placeDesc')}</p>
        <p class="mem-place-dir"><code>${escPlace(state.dir)}</code> <span>${state.missing ? t('mem.placeMissing') : sizeOf(state.bytes)}</span></p>
        ${state.home ? `<p class="sec-perm-note">${t('mem.placeHome')}</p>` : ''}
        ${state.moveTo ? `<p class="mem-place-pending"><i class="fa-solid fa-clock"></i> ${t(state.moveTo === state.dir ? 'mem.placePendingHome' : 'mem.placePending', { dir: escPlace(state.moveTo) })}</p>` : ''}
        ${state.error || problem ? `<p class="mem-place-error" role="alert">${escPlace(problem || state.error)}</p>` : ''}
        <div class="mem-place-actions">
          <button type="button" class="btn" data-mem="pick" ${state.missing ? 'disabled' : ''}><i class="fa-solid fa-folder-open"></i> ${t('mem.placePick')}</button>
          ${!state.home && !state.moveTo ? `<button type="button" class="btn" data-mem="home" ${state.missing ? 'disabled' : ''}>${t('mem.placeBack')}</button>` : ''}
          ${state.moveTo ? `<button type="button" class="btn" data-mem="cancel">${t('mem.placeCancel')}</button>` : ''}
        </div>`;
      const ask = async run => { try { drawPlace(await run()); } catch (err) { drawPlace(state, err.message); } };
      place.querySelector('[data-mem="pick"]')?.addEventListener('click', async () => {
        let picked = null;
        try { picked = await window.__TAURI__?.core?.invoke('plugin:dialog|open', { options: { directory: true, multiple: false, title: t('mem.placePick') } }); } catch (err) { drawPlace(state, err.message || String(err)); return; }
        if (typeof picked === 'string') void ask(() => window.chatStorage.memoryMove(picked));
      });
      place.querySelector('[data-mem="home"]')?.addEventListener('click', () => void ask(() => window.chatStorage.memoryMove(null)));
      place.querySelector('[data-mem="cancel"]')?.addEventListener('click', () => void ask(() => window.chatStorage.memoryCancel()));
    };
    try { drawPlace(await window.chatStorage.memoryStatus()); }
    catch (e) { place.remove(); console.warn('[Security] posto della memoria non letto:', e.message); }

    // The pods' projects, copied into the memory after every step of their record: the switch, and each project
    // with how its copy stands.
    const copies = document.createElement('div');
    copies.className = 'sec-perm-block mem-copies';
    subContent.appendChild(copies);
    const drawCopies = (state, problem = '') => {
      const rows = state.projects.map(project => `
        <li><span class="mem-copies-name">${escPlace(project.name)}</span>
          <span class="mem-copies-state ${project.error ? 'is-error' : ''}">${project.error ? escPlace(project.error) : t(project.copied ? 'mem.copiesDone' : 'mem.copiesNone')}</span></li>`).join('');
      copies.innerHTML = `
        <h3><i class="fa-solid fa-box-archive"></i> ${t('mem.copiesHeading')}</h3>
        <p class="sec-perm-desc">${t('mem.copiesDesc')}</p>
        <div class="privacy-card-toggle-row">
          <label class="privacy-toggle-label" for="toggle-mem-copies">
            <span class="privacy-toggle-title">${t('mem.copiesSwitch')}</span>
            <span class="privacy-toggle-status">${t(state.on ? 'mem.copiesOn' : 'mem.copiesOff')}</span>
          </label>
          <label class="synth-switch" for="toggle-mem-copies">
            <input type="checkbox" id="toggle-mem-copies" ${state.on ? 'checked' : ''}>
            <span class="synth-slider"></span>
          </label>
        </div>
        ${problem ? `<p class="mem-place-error" role="alert">${escPlace(problem)}</p>` : ''}
        ${rows ? `<ul class="mem-copies-list">${rows}</ul>` : `<p class="sec-perm-note">${t('mem.copiesEmpty')}</p>`}`;
      copies.querySelector('#toggle-mem-copies').addEventListener('change', async event => {
        try { drawCopies(await window.chatStorage.setMemoryCopies(event.target.checked)); } catch (err) { drawCopies(state, err.message); }
      });
    };
    try { drawCopies(await window.chatStorage.memoryCopies()); }
    catch (e) { copies.remove(); console.warn('[Security] copie dei progetti non lette:', e.message); }

    // The disk of the pods' runtime: what the file takes on this computer against what is in it, and the button
    // that brings the file back to its contents (the pods are stopped while it runs).
    const disk = document.createElement('div');
    disk.className = 'sec-perm-block mem-disk';
    subContent.appendChild(disk);
    const mb = bytes => `${(bytes / 1073741824).toFixed(bytes >= 10737418240 ? 0 : 1)} GB`;
    const drawDisk = (state, problem = '', busy = '') => {
      if (!state.supported || !state.registered) { disk.remove(); return; }
      const lines = [];
      if (state.bytes !== null) lines.push(t('mem.diskFile', { size: mb(state.bytes) }));
      if (state.used !== null) lines.push(t('mem.diskUsed', { size: mb(state.used) }));
      disk.innerHTML = `
        <h3><i class="fa-solid fa-hard-drive"></i> ${t('mem.diskHeading')}</h3>
        <p class="sec-perm-desc">${t('mem.diskDesc')}</p>
        ${lines.length ? `<p class="sec-perm-note">${lines.map(escPlace).join(' · ')}</p>` : ''}
        ${state.pending ? `<p class="mem-place-error" role="alert">${t('mem.diskPending')}</p>` : ''}
        ${problem ? `<p class="mem-place-error" role="alert">${escPlace(problem)}</p>` : ''}
        ${busy ? `<p class="sec-perm-note">${escPlace(busy)}</p>` : ''}
        <div class="mem-place-actions">
          <button type="button" class="btn" data-disk="compact" ${busy ? 'disabled' : ''}><i class="fa-solid fa-compress"></i> ${t('mem.diskCompact')}</button>
        </div>`;
      disk.querySelector('[data-disk="compact"]')?.addEventListener('click', async () => {
        if (!window.confirm(t('mem.diskConfirm'))) return;
        drawDisk(state, '', t('mem.diskRunning'));
        try {
          const done = await window.chatStorage.runtimeCompact();
          drawDisk(await window.chatStorage.runtimeDisk(), '', t('mem.diskDone', { before: mb(done.before), after: mb(done.after), seconds: done.seconds }));
        } catch (err) { drawDisk(state, err.message); }
      });
    };
    try { drawDisk(await window.chatStorage.runtimeDisk()); }
    catch (e) { disk.remove(); console.warn('[Security] disco dei pod non letto:', e.message); }
    container.appendChild(subContent);
    setupPasswordToggles(subContent);

    // Bind event handlers for Enable
    const formEnable = subContent.querySelector('#form-enable-vault');
    if (formEnable) {
      formEnable.addEventListener('submit', async () => {
        const pw = subContent.querySelector('#input-vault-new-pw').value;
        const confirmPw = subContent.querySelector('#input-vault-confirm-pw').value;
        const ack = subContent.querySelector('#check-vault-ack').checked;
        const feedback = subContent.querySelector('#vault-enable-feedback');
        const btn = subContent.querySelector('#btn-submit-enable-vault');

        const targetSql = !!subContent.querySelector('#check-target-sql')?.checked;
        const targetSandboxes = !!subContent.querySelector('#check-target-sandboxes')?.checked;

        if (!targetSql && !targetSandboxes) {
          feedback.className = 'vault-feedback-banner vault-feedback-error';
          feedback.innerText = 'Seleziona almeno un componente da cifrare (Database o Sandbox).';
          feedback.style.display = 'flex';
          return;
        }

        if (!ack) {
          feedback.className = 'vault-feedback-banner vault-feedback-error';
          feedback.innerText = 'È necessario confermare la presa d’atto prima di procedere.';
          feedback.style.display = 'flex';
          return;
        }
        if (pw !== confirmPw) {
          feedback.className = 'vault-feedback-banner vault-feedback-error';
          feedback.innerText = 'Le password inserite non coincidono.';
          feedback.style.display = 'flex';
          return;
        }

        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Cifratura in corso…';
        try {
          await window.chatStorage.enableDatabaseEncryption(pw, confirmPw, { sql: targetSql, sandboxes: targetSandboxes });
          renderEnvironmentSection();
        } catch (err) {
          feedback.className = 'vault-feedback-banner vault-feedback-error';
          feedback.innerText = err.message || 'Errore durante l’abilitazione della crittografia.';
          feedback.style.display = 'flex';
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-lock"></i> Cifra Componenti Selezionati Ora';
        }
      });
    }

    // Bind event handlers for Lock
    const btnLockNow = subContent.querySelector('#btn-vault-lock-now');
    if (btnLockNow) {
      btnLockNow.addEventListener('click', async () => {
        btnLockNow.disabled = true;
        try {
          await window.chatStorage.lockDatabase();
          showVaultUnlockDialog(() => {
            renderEnvironmentSection();
            window.chatWorkspace?.renderConversations?.();
          });
        } catch (err) {
          console.error('[Security Lock]', err);
          btnLockNow.disabled = false;
        }
      });
    }

    // Bind event handlers for Change Password
    const formChange = subContent.querySelector('#form-change-vault-pw');
    if (formChange) {
      formChange.addEventListener('submit', async () => {
        const oldPw = subContent.querySelector('#input-change-old-pw').value;
        const newPw = subContent.querySelector('#input-change-new-pw').value;
        const confirmPw = subContent.querySelector('#input-change-confirm-pw').value;
        const feedback = subContent.querySelector('#vault-change-feedback');
        const btn = subContent.querySelector('#btn-submit-change-pw');

        const targetSql = !!subContent.querySelector('#check-change-target-sql')?.checked;
        const targetSandboxes = !!subContent.querySelector('#check-change-target-sandboxes')?.checked;

        if (!targetSql && !targetSandboxes) {
          feedback.className = 'vault-feedback-banner vault-feedback-error';
          feedback.innerText = 'Seleziona almeno un componente da cifrare con la nuova password.';
          feedback.style.display = 'flex';
          return;
        }

        if (newPw !== confirmPw) {
          feedback.className = 'vault-feedback-banner vault-feedback-error';
          feedback.innerText = 'Le nuove password non coincidono.';
          feedback.style.display = 'flex';
          return;
        }

        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Aggiornamento…';
        try {
          await window.chatStorage.changeDatabasePassword(oldPw, newPw, confirmPw, { sql: targetSql, sandboxes: targetSandboxes });
          feedback.className = 'vault-feedback-banner vault-feedback-success';
          feedback.innerText = 'Master password aggiornata con successo.';
          feedback.style.display = 'flex';
          formChange.reset();
        } catch (err) {
          feedback.className = 'vault-feedback-banner vault-feedback-error';
          feedback.innerText = err.message || 'Errore durante l’aggiornamento della password.';
          feedback.style.display = 'flex';
        } finally {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Aggiorna Password';
        }
      });
    }

    // Bind event handlers for Disable
    const formDisable = subContent.querySelector('#form-disable-vault');
    if (formDisable) {
      formDisable.addEventListener('submit', async () => {
        const pw = subContent.querySelector('#input-disable-vault-pw').value;
        const feedback = subContent.querySelector('#vault-disable-feedback');
        const btn = subContent.querySelector('#btn-submit-disable-vault');

        const disableSql = !!subContent.querySelector('#check-disable-target-sql')?.checked;
        const disableSandboxes = !!subContent.querySelector('#check-disable-target-sandboxes')?.checked;

        if (!disableSql && !disableSandboxes) {
          feedback.className = 'vault-feedback-banner vault-feedback-error';
          feedback.innerText = 'Seleziona almeno un componente da decifrare.';
          feedback.style.display = 'flex';
          return;
        }

        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Disattivazione…';
        try {
          await window.chatStorage.disableDatabaseEncryption(pw, { sql: disableSql, sandboxes: disableSandboxes });
          renderEnvironmentSection();
        } catch (err) {
          feedback.className = 'vault-feedback-banner vault-feedback-error';
          feedback.innerText = err.message || 'Password errata o errore durante la decifratura.';
          feedback.style.display = 'flex';
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Disattiva Crittografia Selezionata';
        }
      });
    }
  }

  function showVaultUnlockDialog(onSuccess) {
    const dialog = document.getElementById('vault-unlock-dialog');
    if (!dialog) {
      if (typeof onSuccess === 'function') onSuccess();
      return;
    }
    const form = document.getElementById('vault-unlock-form');
    const input = document.getElementById('input-vault-unlock-password');
    const errorBanner = document.getElementById('vault-unlock-error');
    const submitBtn = document.getElementById('btn-vault-unlock-submit');

    if (input) input.value = '';
    if (errorBanner) { errorBanner.style.display = 'none'; errorBanner.innerText = ''; }
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fa-solid fa-lock-open"></i> <span>Sblocca Database</span>'; }

    setupPasswordToggles(dialog);

    const handleSubmit = async (e) => {
      e?.preventDefault();
      const pw = input?.value?.trim();
      if (!pw) return;

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Verifica in corso…</span>';
      }
      try {
        await window.chatStorage.unlockDatabase(pw);
        try { dialog.close(); } catch (_) { dialog.removeAttribute('open'); }
        if (typeof onSuccess === 'function') onSuccess();
      } catch (err) {
        if (errorBanner) {
          errorBanner.innerText = window.i18n ? window.i18n.t('vault.wrongPassword') : 'Password errata o archivio corrotto. Riprova.';
          errorBanner.style.display = 'block';
        }
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<i class="fa-solid fa-lock-open"></i> <span>Sblocca Database</span>';
        }
        if (input) {
          input.value = '';
          input.focus();
        }
      }
    };

    if (form) {
      form.onsubmit = handleSubmit;
    }

    try {
      dialog.showModal();
    } catch (_) {
      dialog.setAttribute('open', 'true');
    }
    setTimeout(() => input?.focus(), 50);
  }

  window.renderEnvironmentSection = renderEnvironmentSection;
  window.showVaultUnlockDialog = showVaultUnlockDialog;

  /**
   * Render Privacy & Caching Settings Sub-section inside Environment
   * Manages OpenRouter Prompt Caching (session_id sticky routing)
   * and Zero Data Retention (provider.zdr + provider.data_collection)
   */
  function renderPrivacyCachingContent(container) {
    if (!container) return;

    const subContent = document.createElement('div');
    subContent.className = 'privacy-workspace';

    const cachingActive = localStorage.getItem('synthorg_prompt_caching_enabled') !== 'false';
    const zdrActive = localStorage.getItem('synthorg_openrouter_zdr_enabled') === 'true';

    subContent.innerHTML = `
      <div class="privacy-section-heading">
        <div>
          <h2><i class="fa-solid fa-server" style="color: var(--primary); margin-right: 8px;"></i> ${t('privacy.sectionTitle')}</h2>
          <p>${t('privacy.sectionSubtitle')}</p>
        </div>
        <div id="privacy-saved-feedback" class="privacy-save-feedback" style="display: none;">
          <i class="fa-solid fa-check"></i> <span>${t('privacy.savedFeedback')}</span>
        </div>
      </div>

      <div class="privacy-cards-grid">
        <!-- Prompt Caching Card -->
        <article class="privacy-card">
          <div class="privacy-card-header">
            <div class="privacy-card-title-group">
              <div class="privacy-card-icon"><i class="fa-solid fa-bolt"></i></div>
              <div>
                <h3 class="privacy-card-title">${t('privacy.cachingCardTitle')}</h3>
                <span class="privacy-badge"><i class="fa-solid fa-layer-group"></i> ${t('privacy.cachingCardBadge')}</span>
              </div>
            </div>
          </div>
          <p class="privacy-card-desc">${t('privacy.cachingCardDesc')}</p>
          <div class="privacy-card-toggle-row">
            <label class="privacy-toggle-label" for="toggle-prompt-caching">
              <span class="privacy-toggle-title">${t('privacy.cachingEnabledLabel')}</span>
              <span class="privacy-toggle-status" id="prompt-caching-status-text">
                ${cachingActive
                  ? `<span class="status-active"><i class="fa-solid fa-circle-check"></i> ${t('privacy.cachingActiveStatus')}</span>`
                  : `<span class="status-inactive"><i class="fa-solid fa-circle-pause"></i> ${t('privacy.cachingInactiveStatus')}</span>`}
              </span>
            </label>
            <label class="synth-switch" for="toggle-prompt-caching">
              <input type="checkbox" id="toggle-prompt-caching" ${cachingActive ? 'checked' : ''}>
              <span class="synth-slider"></span>
            </label>
          </div>
        </article>

        <!-- Zero Data Retention Card -->
        <article class="privacy-card">
          <div class="privacy-card-header">
            <div class="privacy-card-title-group">
              <div class="privacy-card-icon"><i class="fa-solid fa-user-shield"></i></div>
              <div>
                <h3 class="privacy-card-title">${t('privacy.zdrCardTitle')}</h3>
                <span class="privacy-badge badge-accent"><i class="fa-solid fa-lock"></i> ${t('privacy.zdrCardBadge')}</span>
              </div>
            </div>
          </div>
          <p class="privacy-card-desc">${t('privacy.zdrCardDesc')}</p>
          <div class="privacy-card-toggle-row">
            <label class="privacy-toggle-label" for="toggle-openrouter-zdr">
              <span class="privacy-toggle-title">${t('privacy.zdrEnabledLabel')}</span>
              <span class="privacy-toggle-status" id="openrouter-zdr-status-text">
                ${zdrActive
                  ? `<span class="status-active"><i class="fa-solid fa-shield-halved"></i> ${t('privacy.zdrActiveStatus')}</span>`
                  : `<span class="status-inactive"><i class="fa-solid fa-circle-xmark"></i> ${t('privacy.zdrInactiveStatus')}</span>`}
              </span>
            </label>
            <label class="synth-switch" for="toggle-openrouter-zdr">
              <input type="checkbox" id="toggle-openrouter-zdr" ${zdrActive ? 'checked' : ''}>
              <span class="synth-slider"></span>
            </label>
          </div>
        </article>
      </div>

      <!-- Informative Notice Box -->
      <div class="privacy-notice-box">
        <div class="privacy-notice-icon"><i class="fa-solid fa-circle-info"></i></div>
        <div class="privacy-notice-content">
          <h4>${t('privacy.noticeTitle')}</h4>
          <p>${t('privacy.noticeDesc')}</p>
        </div>
      </div>
    `;

    container.appendChild(subContent);

    const showSavedFeedback = () => {
      const feedback = subContent.querySelector('#privacy-saved-feedback');
      if (feedback) {
        feedback.style.display = 'inline-flex';
        clearTimeout(feedback._timer);
        feedback._timer = setTimeout(() => {
          feedback.style.display = 'none';
        }, 2200);
      }
    };

    const cachingInput = subContent.querySelector('#toggle-prompt-caching');
    const cachingStatusText = subContent.querySelector('#prompt-caching-status-text');
    if (cachingInput) {
      cachingInput.addEventListener('change', (e) => {
        const val = e.target.checked;
        const strVal = val ? 'true' : 'false';
        try { localStorage.setItem('synthorg_prompt_caching_enabled', strVal); } catch {}
        if (window.chatStorage?.setSetting) {
          window.chatStorage.setSetting('prompt_caching_enabled', strVal).catch(() => {});
        }
        if (cachingStatusText) {
          cachingStatusText.innerHTML = val
            ? `<span class="status-active"><i class="fa-solid fa-circle-check"></i> ${t('privacy.cachingActiveStatus')}</span>`
            : `<span class="status-inactive"><i class="fa-solid fa-circle-pause"></i> ${t('privacy.cachingInactiveStatus')}</span>`;
        }
        showSavedFeedback();
      });
    }

    const zdrInput = subContent.querySelector('#toggle-openrouter-zdr');
    const zdrStatusText = subContent.querySelector('#openrouter-zdr-status-text');
    if (zdrInput) {
      zdrInput.addEventListener('change', (e) => {
        const val = e.target.checked;
        const strVal = val ? 'true' : 'false';
        try { localStorage.setItem('synthorg_openrouter_zdr_enabled', strVal); } catch {}
        if (window.chatStorage?.setSetting) {
          window.chatStorage.setSetting('openrouter_zdr_enabled', strVal).catch(() => {});
        }
        if (zdrStatusText) {
          zdrStatusText.innerHTML = val
            ? `<span class="status-active"><i class="fa-solid fa-shield-halved"></i> ${t('privacy.zdrActiveStatus')}</span>`
            : `<span class="status-inactive"><i class="fa-solid fa-circle-xmark"></i> ${t('privacy.zdrInactiveStatus')}</span>`;
        }
        showSavedFeedback();
      });
    }
  }

  function renderPrivacyCachingSection() {
    envActiveSubTab = 'privacy';
    renderEnvironmentSection();
  }
  window.renderPrivacyCachingContent = renderPrivacyCachingContent;
  window.renderPrivacyCachingSection = renderPrivacyCachingSection;

  // Settings: Select active role or tool
  function selectSettingItem(itemId) {
    state.selectedSettingId = itemId;
    state.settingsFuzzyQuery = '';
    state.settingsProviderFilter = 'all';
    state.settingsSourceFilter = 'all';
    state.settingsContextFilter = 0;
    state.settingsSortBy = 'relevance';
    state.settingsPage = 1;
    renderSettingsView();
  }

  function changeSettingsPage(newPage) {
    state.settingsPage = newPage;
    const scrollContainer = elements.settingsMainWorkspace?.querySelector('.settings-models-scroll');
    if (scrollContainer) scrollContainer.scrollTop = 0;
    renderSettingsModelsList();
  }

  function changeSettingsPageSize(newSize) {
    state.settingsPageSize = parseInt(newSize, 10) || 25;
    state.settingsPage = 1;
    const scrollContainer = elements.settingsMainWorkspace?.querySelector('.settings-models-scroll');
    if (scrollContainer) scrollContainer.scrollTop = 0;
    renderSettingsModelsList();
  }

  function getActiveRoleTargetModel(activeItem, registry = window.operationalRegistry) {
    if (!activeItem) return null;
    const currentMaster = registry.getCurrentMasterModel();
    if (activeItem.type === 'master') {
      return currentMaster;
    }
    if (activeItem.type === 'microtask') {
      return registry.getCurrentMicrotaskModel();
    }
    if (activeItem.type === 'realtime_multi') {
      return registry.getCurrentRealtimeMultiModel();
    }
    if (activeItem.assignedModelId && activeItem.assignedModelId !== 'auto') {
      return window.openRouterCatalog?.models?.find(m => m.id === activeItem.assignedModelId) || null;
    }
    if (activeItem.isNativeCovered && currentMaster) {
      return currentMaster;
    }
    return (activeItem.eligibleModels && activeItem.eligibleModels[0]) || currentMaster || null;
  }

  // Settings: Assign model as default
  function assignModelAsDefault(modelId) {
    const allItems = window.operationalRegistry.getAllConfigurableItems();
    const currentItem = allItems.find(i => i.id === state.selectedSettingId);
    if (!currentItem) return;

    if (currentItem.type === 'master') {
      window.operationalRegistry.setSelectedMasterId(modelId);
    } else if (currentItem.type === 'microtask') {
      window.operationalRegistry.setSelectedMicrotaskId(modelId);
    } else if (currentItem.type === 'realtime_multi') {
      window.operationalRegistry.setSelectedRealtimeMultiId(modelId);
    } else {
      window.operationalRegistry.setToolDelegate(currentItem.id, modelId);
    }

    state.settingsPage = 1;
    renderSettingsView(true);
    window.chatManager.renderChatHeader();
  }

  function getNativeControlHtml(activeItem, currentMaster) {
    if (activeItem.type === 'tool' && activeItem.isNativeInMaster) {
      if (activeItem.isNativeCovered) {
        return `
          <div class="settings-native-box">
            <span style="font-size: 12px; color: var(--primary); font-weight: 600;">
              <i class="fa-solid fa-circle-check"></i> ${window.i18n.t('settings.nativeCovered')} (${escapeHtml(currentMaster ? currentMaster.name : '')})
            </span>
          </div>
        `;
      } else {
        return `
          <div class="settings-native-box">
            <span style="font-size: 12px; color: var(--primary);">
              <i class="fa-solid fa-bolt"></i> ${window.i18n ? window.i18n.t('settings.delegateActive') : 'Delega Fornitore Specialista Attiva'}
            </span>
            <button class="btn btn-primary" onclick="window.assignModelAsDefault('auto')" style="font-size: 11px; padding: 4px 10px;">
              ${window.i18n.t('settings.nativeRestore')}
            </button>
          </div>
        `;
      }
    }
    return '';
  }

  function renderSettingsSidebar(allItems) {
    if (!elements.settingsSidebarItems) return;
    let sidebarHtml = '';
    let currentGroup = '';

    allItems.forEach(item => {
      if (item.group !== currentGroup) {
        currentGroup = item.group;
        sidebarHtml += `<div class="settings-sidebar-group-title">${escapeHtml(currentGroup)}</div>`;
      }

      const isActive = item.id === state.selectedSettingId;
      let statusPill = '';

      if (item.type === 'master') {
        statusPill = `<span class="settings-item-status-pill status-master"><i class="fa-solid fa-crown"></i> ${window.i18n ? window.i18n.t('settings.statusMaster') : 'Master'}</span>`;
      } else if (item.type === 'microtask') {
        statusPill = `<span class="settings-item-status-pill" style="background: rgba(59, 130, 246, 0.12); color: var(--primary); border: 1px solid rgba(59, 130, 246, 0.25);"><i class="fa-solid fa-bolt"></i> ${window.i18n ? window.i18n.t('settings.statusFast') : 'Fast'}</span>`;
      } else if (item.type === 'realtime_multi') {
        statusPill = `<span class="settings-item-status-pill" style="background: rgba(236, 72, 153, 0.12); color: #ec4899; border: 1px solid rgba(236, 72, 153, 0.25);"><i class="fa-solid fa-video"></i> ${window.i18n ? window.i18n.t('settings.statusOmni') : 'Omni'}</span>`;
      } else if (item.isNativeCovered) {
        statusPill = `<span class="settings-item-status-pill status-native"><i class="fa-solid fa-check"></i> ${window.i18n ? window.i18n.t('settings.statusNative') : 'Nativo'}</span>`;
      } else if (item.assignedModelId && item.assignedModelId !== 'auto') {
        statusPill = `<span class="settings-item-status-pill status-delegated"><i class="fa-solid fa-bolt"></i> ${window.i18n ? window.i18n.t('settings.statusDelegated') : 'Delegato'}</span>`;
      } else {
        statusPill = `<span class="settings-item-status-pill" style="color: var(--text-dim);">${window.i18n ? window.i18n.t('settings.statusDisabled') : 'Non imp.'}</span>`;
      }

      sidebarHtml += `
        <div class="settings-sidebar-item ${isActive ? 'active' : ''}" data-item-id="${escapeHtml(item.id)}" onclick="window.selectSettingItem('${jsToken(item.id)}')">
          <div class="settings-item-top">
            <div class="settings-item-name">
              <span>${item.icon}</span>
              <span>${escapeHtml(item.name)}</span>
            </div>
            ${statusPill}
          </div>
          <div class="settings-item-assigned" title="${escapeHtml(item.assignedModelName)}">
            ${escapeHtml(item.assignedModelName)}
          </div>
        </div>
      `;
    });

    elements.settingsSidebarItems.innerHTML = sidebarHtml;
  }

  function renderSettingsModelsList() {
    if (!elements.settingsMainWorkspace) return;

    const allItems = window.operationalRegistry.getAllConfigurableItems();
    if (!allItems.length) return;

    const activeItem = allItems.find(i => i.id === state.selectedSettingId) || allItems[0];
    const currentMaster = window.operationalRegistry.getCurrentMasterModel();

    // Determine assigned/default model ID for this setting item
    let assignedModelId = null;
    if (activeItem.type === 'master') {
      assignedModelId = currentMaster?.id;
    } else if (activeItem.type === 'microtask') {
      assignedModelId = window.operationalRegistry.getSelectedMicrotaskId();
    } else if (activeItem.type === 'realtime_multi') {
      assignedModelId = window.operationalRegistry.getSelectedRealtimeMultiId();
    } else {
      assignedModelId = (!activeItem.isNativeCovered && activeItem.assignedModelId && activeItem.assignedModelId !== 'auto' ? activeItem.assignedModelId : null);
    }

    // 1. Filter Eligible Models
    let filtered = activeItem.eligibleModels.slice();

    // Where they are: on this computer or at a provider.
    if (state.settingsSourceFilter !== 'all') {
      filtered = filtered.filter(m => Boolean(m.isLocal) === (state.settingsSourceFilter === 'local'));
    }

    // Provider Filter
    if (state.settingsProviderFilter !== 'all') {
      filtered = filtered.filter(m => m.provider.toLowerCase() === state.settingsProviderFilter.toLowerCase());
    }

    // Context Length Filter
    if (state.settingsContextFilter > 0) {
      filtered = filtered.filter(m => m.contextLength >= state.settingsContextFilter);
    }

    // Fuzzy Search (Weighted token-bag & gap-tolerant matching)
    const engine = getFuzzyEngine();
    let results = engine ? engine.search(filtered, state.settingsFuzzyQuery) : filtered;

    // Sorting (with pinned assigned model always at top)
    if (state.settingsSortBy !== 'relevance' || !state.settingsFuzzyQuery.trim()) {
      results.sort((a, b) => {
        // Pin assigned model always first
        if (assignedModelId) {
          if (a.id === assignedModelId) return -1;
          if (b.id === assignedModelId) return 1;
        }
        // Then the models on this computer: a few among hundreds, and the ones looked for by name.
        if (Boolean(a.isLocal) !== Boolean(b.isLocal)) return a.isLocal ? -1 : 1;

        const avgA = getModelAveragePrice(a);
        const avgB = getModelAveragePrice(b);

        switch (state.settingsSortBy) {
          case 'price-asc':
            if (avgA >= 0 && avgB >= 0) return avgA - avgB;
            if (avgA < 0 && avgB >= 0) return 1;
            if (avgA >= 0 && avgB < 0) return -1;
            return a.name.localeCompare(b.name);
          case 'price-desc':
            if (avgA >= 0 && avgB >= 0) return avgB - avgA;
            if (avgA < 0 && avgB >= 0) return 1;
            if (avgA >= 0 && avgB < 0) return -1;
            return a.name.localeCompare(b.name);
          case 'context-desc':
            return b.contextLength - a.contextLength;
          case 'name-asc':
          default:
            return a.name.localeCompare(b.name);
        }
      });
    }

    // Ensure currently assigned model is pinned to index 0 even if fuzzy search ranked it lower
    if (assignedModelId) {
      const assignedIdx = results.findIndex(m => m.id === assignedModelId);
      if (assignedIdx > 0) {
        const [assignedObj] = results.splice(assignedIdx, 1);
        results.unshift(assignedObj);
      }
    }

    // Pagination Calculation
    const totalItems = results.length;
    const pageSize = state.settingsPageSize || 25;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    if (state.settingsPage > totalPages) {
      state.settingsPage = totalPages;
    }
    if (state.settingsPage < 1) {
      state.settingsPage = 1;
    }

    const startIndex = totalItems === 0 ? 0 : (state.settingsPage - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, totalItems);
    const pageResults = results.slice(startIndex, endIndex);

    // Update match count
    const matchCountEl = elements.settingsMainWorkspace.querySelector('.settings-match-count');
    if (matchCountEl) {
      if (totalItems === 0) {
        matchCountEl.textContent = `0 ${window.i18n.t('settings.compatibleModels')}`;
      } else if (totalItems <= pageSize) {
        matchCountEl.textContent = `${totalItems} ${window.i18n.t('settings.compatibleModels')}`;
      } else {
        matchCountEl.textContent = `${startIndex + 1}–${endIndex} di ${totalItems} ${window.i18n.t('settings.compatibleModels')}`;
      }
    }

    // Update model cards list
    const scrollContainer = elements.settingsMainWorkspace.querySelector('.settings-models-scroll');
    if (scrollContainer) {
      if (results.length === 0) {
        scrollContainer.innerHTML = `
          <div style="text-align: center; padding: 48px; color: var(--text-dim);">
            <div style="font-size: 32px; margin-bottom: 8px;"><i class="fa-solid fa-magnifying-glass"></i></div>
            ${window.i18n.t('settings.noModelsFound')}
          </div>
        `;
      } else {
        scrollContainer.innerHTML = pageResults.map(m => {
          const isCurrentDefault = activeItem.type === 'master'
            ? (m.id === currentMaster?.id)
            : (m.id === activeItem.assignedModelId && !activeItem.isNativeCovered);

          let pinnedBadgeHtml = '';
          if (isCurrentDefault) {
            pinnedBadgeHtml = `<span class="pinned-badge is-assigned-pin"><i class="fa-solid fa-thumbtack"></i> ${window.i18n.t('settings.assignedBadge')}</span>`;
          }

          let tags = '';
          if (m.hasTools) tags += `<span class="tag-badge tag-tools" title="${t('settings.tagToolsTooltip')}"><i class="fa-solid fa-screwdriver-wrench"></i> Tools</span>`;
          if (m.hasStructuredOutputs) tags += `<span class="tag-badge tag-struct" title="JSON Schema"><i class="fa-solid fa-file-code"></i> JSON</span>`;
          if (m.hasReasoning) tags += `<span class="tag-badge tag-reason" title="Reasoning"><i class="fa-solid fa-brain"></i> Reasoning</span>`;
          tags += `<span class="tag-badge tag-ctx"><i class="fa-solid fa-database"></i> ${formatTokens(m.contextLength)} ctx</span>`;
          // A local model also says whether it is in memory now.
          tags += formatPriceTag(m);
          const inMemory = m.isLocal ? window.loadedModels?.stateOf(m.id) : null;
          if (inMemory) tags += `<span class="tag-badge tag-in-memory is-${inMemory}"><i class="fa-solid fa-circle"></i> ${inMemory === 'loaded' ? t('settings.tagInMemory') : t('localModels.loading')}</span>`;
          // What the same model costs from the queue, when it has a twin there:
          // the figure is the one OpenRouter prices it at, not a rule of thumb.
          if (m.batch) {
            const queued = (value) => (value < 1 ? '$' + value.toFixed(3) : '$' + value.toFixed(2));
            tags += `<span class="tag-badge tag-batch" title="${t('settings.batchTagTooltip', { prompt: queued(m.batch.promptPerM), completion: queued(m.batch.completionPerM) })}"><i class="fa-solid fa-layer-group"></i> ${t('settings.batchTag', { percent: m.batch.savingPercent })}</span>`;
          }

          const actionBtn = isCurrentDefault
            ? `<button class="btn-assign-default is-current"><i class="fa-solid fa-check"></i> ${window.i18n.t('settings.btnCurrentDefault')}</button>`
            : `<button class="btn-assign-default" onclick="window.assignModelAsDefault('${jsToken(m.id)}')">${window.i18n.t('settings.btnAssignDefault')} <i class="fa-solid fa-arrow-right"></i></button>`;

          return `
            <div class="model-candidate-card ${isCurrentDefault ? 'is-active-default is-pinned-assigned' : ''}">
              <div class="model-main-info">
                <div class="model-title-row">
                  <span class="model-name">${escapeHtml(m.name)}</span>
                  <span class="model-provider-badge">${escapeHtml(m.provider)}</span>
                  ${window.modelProviders?.routeFor?.(m.id) ? `<span class="tag-badge tag-direct" title="${t('settings.directTagTooltip')}"><i class="fa-solid fa-bolt"></i> ${t('settings.directTag')}</span>` : ''}
                  ${pinnedBadgeHtml}
                </div>
                <div class="model-slug-row">
                  <span>${escapeHtml(m.id)}</span>
                  <span class="btn-copy-mini" onclick="event.stopPropagation(); window.copyToClipboard('${jsToken(m.id)}', this)" title="${t('settings.copyModelId')}">
                    <i class="fa-regular fa-copy"></i>
                  </span>
                </div>
                <div class="model-tags-row">
                  ${tags}
                </div>
              </div>

              <div class="model-actions-col">
                ${actionBtn}
                <button class="btn btn-secondary" onclick="window.openDrawer('${jsToken(m.id)}')" title="${window.i18n ? window.i18n.t('settings.btnInspectModelTooltip') : 'Ispeziona modello'}">
                  <i class="fa-solid fa-sliders"></i>
                </button>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // Update pagination bar
    const paginationBar = elements.settingsMainWorkspace.querySelector('#settings-pagination-bar');
    if (paginationBar) {
      if (totalItems <= pageSize) {
        paginationBar.style.display = totalItems === 0 ? 'none' : 'flex';
        paginationBar.innerHTML = `
          <div class="pagination-info">
            ${totalItems} ${window.i18n.t('settings.compatibleModels')}
          </div>
          <div class="pagination-page-size">
            <span>${window.i18n.t('settings.paginationPerItem')}:</span>
            <select class="select-control pagination-size-select" onchange="window.changeSettingsPageSize(this.value)">
              <option value="25" ${pageSize === 25 ? 'selected' : ''}>25</option>
              <option value="50" ${pageSize === 50 ? 'selected' : ''}>50</option>
              <option value="100" ${pageSize === 100 ? 'selected' : ''}>100</option>
            </select>
          </div>
        `;
      } else {
        paginationBar.style.display = 'flex';
        const curPage = state.settingsPage;
        let pageButtonsHtml = '';

        pageButtonsHtml += `
          <button class="pagination-btn" ${curPage === 1 ? 'disabled' : ''} onclick="window.changeSettingsPage(${curPage - 1})" title="${window.i18n.t('settings.paginationPrev')}">
            <i class="fa-solid fa-chevron-left"></i>
          </button>
        `;

        const pages = [];
        if (totalPages <= 7) {
          for (let i = 1; i <= totalPages; i++) pages.push(i);
        } else {
          pages.push(1);
          if (curPage > 4) pages.push('...');
          const start = Math.max(2, curPage - 1);
          const end = Math.min(totalPages - 1, curPage + 1);
          for (let i = start; i <= end; i++) {
            if (!pages.includes(i)) pages.push(i);
          }
          if (curPage < totalPages - 3) pages.push('...');
          if (!pages.includes(totalPages)) pages.push(totalPages);
        }

        pages.forEach(p => {
          if (p === '...') {
            pageButtonsHtml += `<span class="pagination-ellipsis">…</span>`;
          } else {
            const isActive = p === curPage;
            pageButtonsHtml += `
              <button class="pagination-btn ${isActive ? 'active' : ''}" onclick="window.changeSettingsPage(${p})">
                ${p}
              </button>
            `;
          }
        });

        pageButtonsHtml += `
          <button class="pagination-btn" ${curPage === totalPages ? 'disabled' : ''} onclick="window.changeSettingsPage(${curPage + 1})" title="${window.i18n.t('settings.paginationNext')}">
            <i class="fa-solid fa-chevron-right"></i>
          </button>
        `;

        paginationBar.innerHTML = `
          <div class="pagination-info">
            ${window.i18n.t('settings.paginationPage')} <strong>${curPage}</strong> ${window.i18n.t('settings.paginationOf')} <strong>${totalPages}</strong> (${totalItems} ${window.i18n.t('settings.compatibleModels')})
          </div>

          <div class="pagination-controls">
            ${pageButtonsHtml}
          </div>

          <div class="pagination-page-size">
            <span>${window.i18n.t('settings.paginationPerItem')}:</span>
            <select class="select-control pagination-size-select" onchange="window.changeSettingsPageSize(this.value)">
              <option value="25" ${pageSize === 25 ? 'selected' : ''}>25</option>
              <option value="50" ${pageSize === 50 ? 'selected' : ''}>50</option>
              <option value="100" ${pageSize === 100 ? 'selected' : ''}>100</option>
            </select>
          </div>
        `;
      }
    }
  }

  /**
   * Render Settings View (Sidebar + Main Workspace)
   */
  function renderSettingsView(forceRerender = false) {
    if (!elements.settingsSidebarItems || !elements.settingsMainWorkspace) return;

    const allItems = window.operationalRegistry.getAllConfigurableItems();
    if (!allItems.length) return;

    if (!state.selectedSettingId || !allItems.find(i => i.id === state.selectedSettingId)) {
      state.selectedSettingId = 'master';
    }

    const activeItem = allItems.find(i => i.id === state.selectedSettingId) || allItems[0];
    const currentMaster = window.operationalRegistry.getCurrentMasterModel();
    const masterHasTools = Boolean(currentMaster && currentMaster.hasTools);
    const targetModel = getActiveRoleTargetModel(activeItem);

    // 1. Render Settings Sidebar
    renderSettingsSidebar(allItems);

    // 2. Check if workspace structure already exists for this setting item
    const isAlreadyRendered = !forceRerender && elements.settingsMainWorkspace.dataset.renderedItemId === activeItem.id;

    if (isAlreadyRendered) {
      const nativeBox = elements.settingsMainWorkspace.querySelector('#settings-native-control-container');
      if (nativeBox) {
        nativeBox.innerHTML = getNativeControlHtml(activeItem, currentMaster);
      }

      const warningBox = elements.settingsMainWorkspace.querySelector('#settings-master-tools-warning');
      if (warningBox) {
        warningBox.innerHTML = (!masterHasTools && activeItem.type === 'tool') ? `
          <div style="background: var(--danger-subtle); border-bottom: 1px solid var(--danger-border); padding: 10px 24px; font-size: 12px; color: var(--color-danger); display: flex; align-items: center; gap: 10px;">
            <i class="fa-solid fa-triangle-exclamation" style="font-size: 14px;"></i>
            <span>${window.i18n ? window.i18n.t('settings.masterNoToolsWarning', { name: currentMaster ? currentMaster.name : '' }) : `Il Master corrente (${escapeHtml(currentMaster ? currentMaster.name : '')}) non supporta Tool Calling nativo: l'invocazione di questo tool richiederà un router o un wrapper esterno.`}</span>
          </div>
        ` : '';
      }

      const roleBadge = elements.settingsMainWorkspace.querySelector('#role-tab-model-name');
      if (roleBadge) {
        roleBadge.textContent = targetModel ? targetModel.name : '';
        roleBadge.title = targetModel ? targetModel.id : '';
      }

      const paneModels = elements.settingsMainWorkspace.querySelector('#settings-pane-models');
      const paneParams = elements.settingsMainWorkspace.querySelector('#settings-pane-params');
      const btnTabModels = elements.settingsMainWorkspace.querySelector('#role-tab-btn-models');
      const btnTabParams = elements.settingsMainWorkspace.querySelector('#role-tab-btn-params');

      if (btnTabModels && btnTabParams && paneModels && paneParams) {
        if (state.settingsRoleActiveTab === 'params') {
          btnTabModels.classList.remove('active');
          btnTabParams.classList.add('active');
          paneModels.style.display = 'none';
          paneParams.style.display = 'flex';
          renderSettingsParamsPanel();
          return;
        } else {
          btnTabParams.classList.remove('active');
          btnTabModels.classList.add('active');
          paneParams.style.display = 'none';
          paneModels.style.display = 'flex';
        }
      }

      const inputFuzzy = document.getElementById('settings-fuzzy-input');
      if (inputFuzzy && inputFuzzy.value !== state.settingsFuzzyQuery && document.activeElement !== inputFuzzy) {
        inputFuzzy.value = state.settingsFuzzyQuery;
      }
      const btnClearFuzzy = document.getElementById('settings-btn-clear-fuzzy');
      if (btnClearFuzzy) {
        btnClearFuzzy.style.display = state.settingsFuzzyQuery ? 'block' : 'none';
      }

      renderSettingsModelsList();
      return;
    }

    // Preserve focus & cursor in case fuzzy input was active during re-render
    const activeEl = document.activeElement;
    const wasFuzzyFocused = activeEl && activeEl.id === 'settings-fuzzy-input';
    const selStart = wasFuzzyFocused ? activeEl.selectionStart : null;
    const selEnd = wasFuzzyFocused ? activeEl.selectionEnd : null;

    // Distinct Providers for Filter Dropdown
    const distinctProviders = Array.from(new Set(activeItem.eligibleModels.map(m => m.provider))).sort();
    let providerOpts = `<option value="all">${window.i18n.t('settings.filterAllProviders')}</option>`;
    distinctProviders.forEach(p => {
      const isSel = p.toLowerCase() === state.settingsProviderFilter.toLowerCase() ? 'selected' : '';
      providerOpts += `<option value="${escapeHtml(p)}" ${isSel}>${escapeHtml(p)}</option>`;
    });

    const nativeControlHtml = getNativeControlHtml(activeItem, currentMaster);

    elements.settingsMainWorkspace.dataset.renderedItemId = activeItem.id;
    elements.settingsMainWorkspace.innerHTML = `
      <div class="settings-ws-header">
        <div class="settings-ws-title-group">
          <div class="settings-ws-icon">${activeItem.icon}</div>
          <div class="settings-ws-heading">
            <h2>
              <span>${escapeHtml(activeItem.name)}</span>
              <span class="signature-pill">[ ${escapeHtml(activeItem.ioSignature)} ]</span>
            </h2>
            <p>${escapeHtml(activeItem.description)}</p>
          </div>
        </div>
        <div id="settings-native-control-container">
          ${nativeControlHtml}
        </div>
      </div>

      <div id="settings-master-tools-warning">
        ${(!masterHasTools && activeItem.type === 'tool') ? `
          <div style="background: var(--danger-subtle); border-bottom: 1px solid var(--danger-border); padding: 10px 24px; font-size: 12px; color: var(--color-danger); display: flex; align-items: center; gap: 10px;">
            <i class="fa-solid fa-triangle-exclamation" style="font-size: 14px;"></i>
            <span>${window.i18n ? window.i18n.t('settings.masterNoToolsWarning', { name: currentMaster ? currentMaster.name : '' }) : `Il Master corrente (${escapeHtml(currentMaster ? currentMaster.name : '')}) non supporta Tool Calling nativo: l'invocazione di questo tool richiederà un router o un wrapper esterno.`}</span>
          </div>
        ` : ''}
      </div>

      <div class="settings-role-tabs-bar">
        <button class="settings-role-tab-btn ${state.settingsRoleActiveTab === 'models' ? 'active' : ''}" id="role-tab-btn-models" type="button">
          <i class="fa-solid fa-layer-group"></i>
          <span>${window.i18n.t('settings.tabModels')}</span>
        </button>
        <button class="settings-role-tab-btn ${state.settingsRoleActiveTab === 'params' ? 'active' : ''}" id="role-tab-btn-params" type="button">
          <i class="fa-solid fa-sliders"></i>
          <span>${window.i18n.t('settings.tabParams')}</span>
          <span class="role-tab-badge-model" id="role-tab-model-name" title="${escapeHtml(targetModel ? targetModel.id : '')}">${escapeHtml(targetModel ? targetModel.name : '')}</span>
        </button>
      </div>

      <!-- Tab Pane 1: Modelli Compatibili (Search, Filters, Cards, Pagination) -->
      <div id="settings-pane-models" style="display: ${state.settingsRoleActiveTab === 'models' ? 'flex' : 'none'}; flex-direction: column; flex: 1; min-height: 0;">
        <div class="settings-filter-bar">
          <div class="fuzzy-search-wrap">
            <i class="fa-solid fa-magnifying-glass search-icon"></i>
            <input type="text" id="settings-fuzzy-input" value="${escapeHtml(state.settingsFuzzyQuery)}" placeholder="${window.i18n.t('settings.searchPlaceholder')}" spellcheck="false" autocomplete="off">
            <span class="search-clear" id="settings-btn-clear-fuzzy" style="${state.settingsFuzzyQuery ? 'display: block;' : 'display: none;'}"><i class="fa-solid fa-xmark"></i></span>
          </div>

          ${activeItem.eligibleModels.some(m => m.isLocal) ? `
          <div class="source-filter" role="group" aria-label="${t('settings.sourceLabel')}">
            ${[['all', t('settings.source_all')], ['api', t('settings.source_api')], ['local', t('settings.source_local')]].map(([source, label]) => `<button type="button" class="source-filter-btn ${state.settingsSourceFilter === source ? 'active' : ''}" data-source="${source}" aria-pressed="${state.settingsSourceFilter === source}">${label}</button>`).join('')}
          </div>` : ''}

          <select id="settings-select-provider" class="select-control">
            ${providerOpts}
          </select>

          <select id="settings-select-context" class="select-control">
            <option value="0" ${state.settingsContextFilter === 0 ? 'selected' : ''}>${window.i18n.t('settings.filterAllContexts')}</option>
            <option value="32000" ${state.settingsContextFilter === 32000 ? 'selected' : ''}>&gt;= 32k</option>
            <option value="128000" ${state.settingsContextFilter === 128000 ? 'selected' : ''}>&gt;= 128k</option>
            <option value="1000000" ${state.settingsContextFilter === 1000000 ? 'selected' : ''}>&gt;= 1M</option>
          </select>

          <select id="settings-select-sort" class="select-control">
            <option value="relevance" ${state.settingsSortBy === 'relevance' ? 'selected' : ''}>${window.i18n.t('settings.filterSortRelevance')}</option>
            <option value="price-asc" ${state.settingsSortBy === 'price-asc' ? 'selected' : ''}>${window.i18n.t('settings.filterSortPriceAsc')}</option>
            <option value="price-desc" ${state.settingsSortBy === 'price-desc' ? 'selected' : ''}>${window.i18n.t('settings.filterSortPriceDesc')}</option>
            <option value="context-desc" ${state.settingsSortBy === 'context-desc' ? 'selected' : ''}>${window.i18n.t('settings.filterSortContextDesc')}</option>
            <option value="name-asc" ${state.settingsSortBy === 'name-asc' ? 'selected' : ''}>${window.i18n.t('settings.filterSortNameAsc')}</option>
          </select>

          <div class="settings-match-count"></div>
        </div>

        <div class="settings-models-scroll"></div>
        <div class="settings-pagination-bar" id="settings-pagination-bar"></div>
      </div>

      <!-- Tab Pane 2: Parametri Modello (Hyperparameters) -->
      <div id="settings-pane-params" style="display: ${state.settingsRoleActiveTab === 'params' ? 'flex' : 'none'}; flex-direction: column; flex: 1; min-height: 0;">
        <div class="settings-params-panel" id="settings-params-panel"></div>
      </div>
    `;

    // Bind Internal Role Tabs
    const btnTabModels = document.getElementById('role-tab-btn-models');
    const btnTabParams = document.getElementById('role-tab-btn-params');
    const paneModels = document.getElementById('settings-pane-models');
    const paneParams = document.getElementById('settings-pane-params');

    btnTabModels?.addEventListener('click', () => {
      state.settingsRoleActiveTab = 'models';
      btnTabModels.classList.add('active');
      btnTabParams?.classList.remove('active');
      if (paneModels) paneModels.style.display = 'flex';
      if (paneParams) paneParams.style.display = 'none';
      renderSettingsModelsList();
    });

    btnTabParams?.addEventListener('click', () => {
      state.settingsRoleActiveTab = 'params';
      btnTabParams.classList.add('active');
      btnTabModels?.classList.remove('active');
      if (paneModels) paneModels.style.display = 'none';
      if (paneParams) paneParams.style.display = 'flex';
      renderSettingsParamsPanel();
    });

    // Bind Search and Filter listeners
    const inputFuzzy = document.getElementById('settings-fuzzy-input');
    const btnClearFuzzy = document.getElementById('settings-btn-clear-fuzzy');
    let fuzzyDebounce;

    inputFuzzy?.addEventListener('input', (e) => {
      state.settingsFuzzyQuery = e.target.value;
      state.settingsPage = 1;
      if (btnClearFuzzy) {
        btnClearFuzzy.style.display = state.settingsFuzzyQuery ? 'block' : 'none';
      }
      clearTimeout(fuzzyDebounce);
      fuzzyDebounce = setTimeout(() => {
        renderSettingsModelsList();
      }, 50);
    });

    btnClearFuzzy?.addEventListener('click', () => {
      state.settingsFuzzyQuery = '';
      state.settingsPage = 1;
      if (inputFuzzy) {
        inputFuzzy.value = '';
        inputFuzzy.focus();
      }
      btnClearFuzzy.style.display = 'none';
      renderSettingsModelsList();
    });

    document.getElementById('settings-select-provider')?.addEventListener('change', (e) => {
      state.settingsProviderFilter = e.target.value;
      state.settingsPage = 1;
      renderSettingsModelsList();
    });

    elements.settingsMainWorkspace.querySelector('.source-filter')?.addEventListener('click', (e) => {
      const chosen = e.target.closest('[data-source]');
      if (!chosen) return;
      state.settingsSourceFilter = chosen.dataset.source;
      state.settingsPage = 1;
      elements.settingsMainWorkspace.querySelectorAll('.source-filter-btn').forEach(button => {
        const on = button === chosen;
        button.classList.toggle('active', on);
        button.setAttribute('aria-pressed', String(on));
      });
      renderSettingsModelsList();
    });

    document.getElementById('settings-select-context')?.addEventListener('change', (e) => {
      state.settingsContextFilter = parseInt(e.target.value, 10) || 0;
      state.settingsPage = 1;
      renderSettingsModelsList();
    });

    document.getElementById('settings-select-sort')?.addEventListener('change', (e) => {
      state.settingsSortBy = e.target.value;
      state.settingsPage = 1;
      renderSettingsModelsList();
    });

    // Populate active tab content
    if (state.settingsRoleActiveTab === 'params') {
      renderSettingsParamsPanel();
    } else {
      renderSettingsModelsList();
    }

    // Restore focus if needed
    if (wasFuzzyFocused && state.settingsRoleActiveTab === 'models') {
      const newInput = document.getElementById('settings-fuzzy-input');
      if (newInput) {
        newInput.focus();
        if (selStart !== null && selEnd !== null) {
          try { newInput.setSelectionRange(selStart, selEnd); } catch (_) {}
        }
      }
    }
  }

  // Model Parameter Definitions (Filterable by model.supportedParameters)
  const PARAM_DEFS = [
    {
      key: 'temperature',
      label: 'Temperature',
      icon: '<i class="fa-solid fa-fire"></i>',
      desc: 'Controlla la casualità e la creatività. Valori più bassi (0.1–0.4) rendono le risposte precise e deterministiche; valori più alti (0.7–1.2) stimolano inventiva e varietà.',
      type: 'slider',
      min: 0,
      max: 2,
      step: 0.05,
      default: 1.0,
      format: v => Number(v).toFixed(2)
    },
    {
      key: 'top_p',
      label: 'Top P (Nucleus Sampling)',
      icon: '<i class="fa-solid fa-chart-pie"></i>',
      desc: 'Campionamento a nucleo di probabilità cumulata. Il modello considera solo i token con probabilità cumulativa fino a P. Alternativa raccomandata alla temperatura.',
      type: 'slider',
      min: 0,
      max: 1,
      step: 0.01,
      default: 1.0,
      format: v => Number(v).toFixed(2)
    },
    {
      key: 'top_k',
      label: 'Top K',
      icon: '<i class="fa-solid fa-list-ol"></i>',
      desc: 'Limita il vocabolario di campionamento ai K token più probabili. Imposta a 0 per disattivare il limite di ranking.',
      type: 'slider',
      min: 0,
      max: 100,
      step: 1,
      default: 0,
      format: v => parseInt(v, 10) === 0 ? 'Off (0)' : parseInt(v, 10).toString()
    },
    {
      key: 'frequency_penalty',
      label: 'Frequency Penalty',
      icon: '<i class="fa-solid fa-repeat"></i>',
      desc: 'Penalizza i token in proporzione al numero di volte che sono già apparsi nel testo. Utile per prevenire loop e ripetizioni continuative.',
      type: 'slider',
      min: -2,
      max: 2,
      step: 0.1,
      default: 0.0,
      format: v => Number(v).toFixed(1)
    },
    {
      key: 'presence_penalty',
      label: 'Presence Penalty',
      icon: '<i class="fa-solid fa-eye"></i>',
      desc: 'Penalizza qualsiasi token già apparso almeno una volta nel testo generato. Incoraggia il modello a esplorare nuovi concetti.',
      type: 'slider',
      min: -2,
      max: 2,
      step: 0.1,
      default: 0.0,
      format: v => Number(v).toFixed(1)
    },
    {
      key: 'repetition_penalty',
      label: 'Repetition Penalty',
      icon: '<i class="fa-solid fa-arrows-rotate"></i>',
      desc: 'Fattore moltiplicativo di penalizzazione per token ripetuti (comune su modelli open source Llama/Mistral/Qwen). 1.0 = neutro.',
      type: 'slider',
      min: 0,
      max: 2,
      step: 0.05,
      default: 1.0,
      format: v => Number(v).toFixed(2)
    },
    {
      key: 'min_p',
      label: 'Min P',
      icon: '<i class="fa-solid fa-filter"></i>',
      desc: 'Scarta i token che hanno una probabilità inferiore a una percentuale fissa del token con probabilità massima.',
      type: 'slider',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.0,
      format: v => Number(v).toFixed(2)
    },
    {
      key: 'top_a',
      label: 'Top A',
      icon: '<i class="fa-solid fa-arrow-down-short-wide"></i>',
      desc: 'Taglia la coda dei token in modo dinamico in base al quadrato della probabilità massima (quando la fiducia è alta, restringe la scelta).',
      type: 'slider',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.0,
      format: v => Number(v).toFixed(2)
    },
    {
      key: 'seed',
      label: 'Seed (Deterministico)',
      icon: '<i class="fa-solid fa-dice"></i>',
      desc: 'Numero intero casuale. Fissando lo stesso seed, il modello produrrà risposte identiche o coerenti a parità di prompt.',
      type: 'number',
      placeholder: 'Es. 42 (vuoto = casuale/disattivato)'
    },
    {
      key: 'max_tokens',
      label: 'Max Completion Tokens',
      icon: '<i class="fa-solid fa-text-height"></i>',
      desc: 'Numero massimo di token che il modello può generare in output per singola risposta. Vuoto per il massimo supportato dal modello.',
      type: 'number',
      placeholder: 'Es. 4096 (vuoto = max provider)'
    },
    {
      key: 'reasoning_effort',
      label: 'Reasoning Effort (CoT)',
      icon: '<i class="fa-solid fa-brain"></i>',
      desc: 'Budget di riflessione e Chain of Thought (pensiero interno) per modelli di ragionamento (es. OpenAI o1, o3-mini, Gemini Thinking).',
      type: 'select',
      options: [
        { value: 'default', label: 'Default Modello' },
        { value: 'low', label: 'Low (Rapido / Risposte essenziali)' },
        { value: 'medium', label: 'Medium (Standard bilanciato)' },
        { value: 'high', label: 'High (Analisi complessa / Ragionamento esteso)' }
      ]
    }
  ];

  /**
   * Render Model Parameters Panel
   * Shows ONLY parameters supported by targetModel.supportedParameters
   */
  /**
   * The parameters of a role's model. By default the Settings panel on the
   * general registry; a chat passes its own container, the role, the
   * registry it sees (`registry`) and where its parameters are kept (`store`,
   * with the registry's getModelParameters / setModelParameter /
   * resetModelParameters).
   */
  function renderSettingsParamsPanel(opts = {}) {
    const container = opts.container || elements.settingsMainWorkspace?.querySelector('#settings-params-panel');
    if (!container) return;
    const registry = opts.registry || window.operationalRegistry;
    const store = opts.store || window.operationalRegistry;
    const rerender = () => renderSettingsParamsPanel(opts);

    const allItems = registry.getAllConfigurableItems();
    const activeItem = (opts.itemId && allItems.find(i => i.id === opts.itemId)) || allItems.find(i => i.id === state.selectedSettingId) || allItems[0];
    if (!activeItem) return;

    // Special Case: Native Engine (e.g. Puppeteer Web Search)
    if (activeItem.isNativeEngine) {
      const engineFunctions = Array.isArray(activeItem.functions) ? activeItem.functions : [];
      container.innerHTML = `
        <div class="params-engine-notice">
          <i class="fa-solid fa-shield-halved"></i>
          <h3>${escapeHtml(activeItem.name)}</h3>
          <p>${escapeHtml(activeItem.description || '')}</p>
          ${engineFunctions.length ? `
            <ul class="params-engine-functions">
              ${engineFunctions.map(fn => `<li><code>${escapeHtml(fn.id)}</code> — ${escapeHtml(fn.ioSignature)}</li>`).join('')}
            </ul>
          ` : ''}
          <p style="color: var(--text-muted); font-size: 11.5px;">
            ${window.i18n ? window.i18n.t('settings.nativeEngineDeterministicNote') : "Non c'è un modello da assegnare: il motore è deterministico e non ha parametri di sampling."} ${engineFunctions.length > 1 ? (window.i18n ? window.i18n.t('settings.nativeEngineDistinctFunctionsNote') : 'Le funzioni elencate restano distinte per il modello, che le chiama separatamente.') : ''}
          </p>
        </div>
      `;
      return;
    }

    const targetModel = getActiveRoleTargetModel(activeItem, registry);
    if (!targetModel) {
      container.innerHTML = `
        <div class="params-empty-state">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <p>${t('settings.noModelAssigned')}</p>
        </div>
      `;
      return;
    }

    const supportedParamsList = targetModel.supportedParameters || [];
    const savedParams = store.getModelParameters(targetModel.id) || {};

    // Filter parameter definitions
    const isParamSupported = (def) => {
      if (def.key === 'reasoning_effort') {
        return supportedParamsList.includes('reasoning') || supportedParamsList.includes('reasoning_effort');
      }
      return supportedParamsList.includes(def.key);
    };

    const supportedDefs = PARAM_DEFS.filter(isParamSupported);
    const unsupportedDefs = PARAM_DEFS.filter(def => !isParamSupported(def));

    // High-level capabilities chips
    const capList = [];
    if (supportedParamsList.includes('tools')) capList.push('<span class="tag-badge tag-tools"><i class="fa-solid fa-screwdriver-wrench"></i> Tool Calling</span>');
    if (supportedParamsList.includes('structured_outputs') || supportedParamsList.includes('response_format')) capList.push('<span class="tag-badge tag-struct"><i class="fa-solid fa-file-code"></i> Structured JSON</span>');
    if (supportedParamsList.includes('reasoning') || supportedParamsList.includes('reasoning_effort')) capList.push('<span class="tag-badge tag-reason"><i class="fa-solid fa-brain"></i> Reasoning CoT</span>');
    if (targetModel.inputModalities?.length) capList.push(`<span class="tag-badge"><i class="fa-solid fa-arrow-right-to-bracket"></i> In: ${targetModel.inputModalities.join(', ')}</span>`);
    if (targetModel.outputModalities?.length) capList.push(`<span class="tag-badge"><i class="fa-solid fa-arrow-right-from-bracket"></i> Out: ${targetModel.outputModalities.join(', ')}</span>`);

    // Build controls HTML
    let controlsHtml = '';
    if (supportedDefs.length === 0) {
      controlsHtml = `
        <div style="background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px;">
          <i class="fa-solid fa-info-circle" style="color: var(--primary); margin-right: 6px;"></i>
          Questo modello non espone parametri di sampling regolabili via OpenRouter API (utilizza parametri fissi gestiti direttamente dal provider).
        </div>
      `;
    } else {
      controlsHtml = `
        <div class="params-section-title">
          <i class="fa-solid fa-sliders"></i> Parametri Regolabili (${supportedDefs.length})
        </div>
        <div class="params-controls-grid">
          ${supportedDefs.map(def => {
            // Unset values show what the model's authors recommend, when the catalogue knows it.
            const recommended = targetModel.recommendedParameters?.[def.key];
            const currentVal = savedParams[def.key] !== undefined ? savedParams[def.key] : (recommended !== undefined ? recommended : (def.default !== undefined ? def.default : ''));

            if (def.type === 'slider') {
              // Nothing set and nothing recommended: the request leaves the parameter
              // out and the provider or the engine uses its own default, whatever it is.
              const unset = savedParams[def.key] === undefined && recommended === undefined;
              const displayVal = unset ? 'Default' : def.format(currentVal);
              return `
                <div class="param-control-card" data-param-key="${def.key}">
                  <div class="param-card-header">
                    <div class="param-card-label">
                      ${def.icon}
                      <span>${escapeHtml(def.label)}</span>
                    </div>
                    <span class="param-card-val-badge" id="param-badge-${def.key}">${displayVal}</span>
                  </div>
                  <div class="param-input-slider-row">
                    <input type="range" class="param-range-slider"
                      data-param-key="${def.key}"
                      min="${def.min}" max="${def.max}" step="${def.step}"
                      value="${currentVal}">
                    <input type="number" class="param-number-input"
                      data-param-key="${def.key}"
                      min="${def.min}" max="${def.max}" step="${def.step}"
                      placeholder="Default"
                      value="${unset ? '' : currentVal}">
                  </div>
                  <div class="param-card-desc">${escapeHtml(def.desc)}</div>
                </div>
              `;
            }

            if (def.type === 'number') {
              return `
                <div class="param-control-card" data-param-key="${def.key}">
                  <div class="param-card-header">
                    <div class="param-card-label">
                      ${def.icon}
                      <span>${escapeHtml(def.label)}</span>
                    </div>
                    <span class="param-card-val-badge" id="param-badge-${def.key}">${currentVal !== '' ? currentVal : 'Default'}</span>
                  </div>
                  <div class="param-input-slider-row">
                    <input type="number" class="param-number-input" style="width: 100%; text-align: left;"
                      data-param-key="${def.key}"
                      placeholder="${escapeHtml(def.placeholder || '')}"
                      value="${currentVal}">
                  </div>
                  <div class="param-card-desc">${escapeHtml(def.desc)}</div>
                </div>
              `;
            }

            if (def.type === 'select') {
              const optionsHtml = def.options.map(opt => `
                <option value="${opt.value}" ${currentVal === opt.value ? 'selected' : ''}>${escapeHtml(opt.label)}</option>
              `).join('');
              return `
                <div class="param-control-card" data-param-key="${def.key}">
                  <div class="param-card-header">
                    <div class="param-card-label">
                      ${def.icon}
                      <span>${escapeHtml(def.label)}</span>
                    </div>
                    <span class="param-card-val-badge" id="param-badge-${def.key}">${escapeHtml(currentVal || 'default')}</span>
                  </div>
                  <div class="param-input-slider-row">
                    <select class="select-control param-select-input" data-param-key="${def.key}">
                      ${optionsHtml}
                    </select>
                  </div>
                  <div class="param-card-desc">${escapeHtml(def.desc)}</div>
                </div>
              `;
            }
            return '';
          }).join('')}
        </div>
      `;
    }

    // Unsupported Parameters Box
    let unsupportedHtml = '';
    if (unsupportedDefs.length > 0) {
      unsupportedHtml = `
        <div class="params-unsupported-box">
          <div class="params-unsupported-title">
            <i class="fa-solid fa-circle-info"></i> ${window.i18n.t('settings.paramsUnsupportedTitle')}
          </div>
          <div class="params-unsupported-chips">
            ${unsupportedDefs.map(u => `
              <span class="unsupported-param-pill">
                <i class="fa-solid fa-ban" style="font-size: 9px; opacity: 0.6;"></i> ${escapeHtml(u.key)}
              </span>
            `).join('')}
          </div>
          <div class="params-unsupported-desc">
            Questi parametri non sono accettati dall'API di <strong>${escapeHtml(targetModel.name)}</strong> e vengono automaticamente omessi durante le richieste per evitare errori HTTP 400.
          </div>
        </div>
      `;
    }

    // Delegated reasoning: its clean session has an effort of its own, kept apart
    // from the model's parameters (on auto that model is the main one).
    let thinkerHtml = '';
    if (activeItem.id === 'thinking_solver') {
      const thinkerEffort = store.getModelParameters('tool:thinking_solver')?.reasoning_effort || 'high';
      const reasons = supportedParamsList.includes('reasoning') || supportedParamsList.includes('reasoning_effort');
      const effortLabel = v => t({ high: 'settings.thinkerEffortHigh', medium: 'settings.thinkerEffortMedium', low: 'settings.thinkerEffortLow', default: 'settings.thinkerEffortDefault' }[v] || 'settings.thinkerEffortHigh');
      const efforts = ['high', 'medium', 'low', 'default'];
      thinkerHtml = `
        <div class="params-section-title"><i class="fa-solid fa-lightbulb"></i> ${t('settings.thinkerTitle')}</div>
        <div class="params-controls-grid">
          <div class="param-control-card" data-param-key="thinker_effort" style="grid-column: 1 / -1;">
            <div class="param-card-header">
              <div class="param-card-label"><i class="fa-solid fa-brain"></i><span>${t('settings.thinkerEffort')}</span></div>
              <span class="param-card-val-badge" id="param-badge-thinker_effort">${escapeHtml(effortLabel(thinkerEffort))}</span>
            </div>
            <div class="param-input-slider-row">
              <select class="select-control" id="param-thinker-effort">
                ${efforts.map(v => `<option value="${v}" ${v === thinkerEffort ? 'selected' : ''}>${escapeHtml(effortLabel(v))}</option>`).join('')}
              </select>
            </div>
            <div class="param-card-desc">${t('settings.thinkerDesc')}${reasons ? '' : ' ' + t('settings.thinkerNoReasoning')}</div>
          </div>
        </div>
      `;
    }
    // The queued twin of this model, where OpenRouter has one: the same model
    // at half the price, answered when the queue gets to it. It is a switch
    // here and not an entry of its own in the list, because it is not another
    // model — it is this one, waiting its turn.
    const twin = targetModel.batch;
    const batchOn = savedParams.batch_enabled === true;
    const lostParams = twin
      ? PARAM_DEFS.filter(def => supportedParamsList.includes(def.key) && !(twin.supportedParameters || []).includes(def.key)).map(def => def.key)
      : [];
    const money = (value) => `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;
    const batchHtml = twin ? `
      <div class="params-section-title">
        <i class="fa-solid fa-layer-group"></i> ${t('settings.batchTitle')}
        <span class="tag-badge tag-struct" style="margin-left: 8px;"><i class="fa-solid fa-tag"></i> ${t('settings.batchBadge', { percent: twin.savingPercent })}</span>
      </div>
      <div class="params-controls-grid">
        <div class="param-control-card" data-param-key="batch_enabled" style="grid-column: 1 / -1;">
          <label class="synth-toggle-wrapper" for="param-batch-enabled">
            <span class="synth-switch"><input type="checkbox" id="param-batch-enabled" ${batchOn ? 'checked' : ''}><span class="synth-slider"></span></span>
            <span><strong>${t('settings.batchEnable')}</strong></span>
          </label>
          <div class="param-card-desc">
            ${t('settings.batchEnableDesc', {
              prompt: money(targetModel.pricing.promptPerM),
              completion: money(targetModel.pricing.completionPerM),
              batchPrompt: money(twin.promptPerM),
              batchCompletion: money(twin.completionPerM)
            })}
            ${lostParams.length ? `<br>${t('settings.batchDropsParams', { params: lostParams.join(', ') })}` : ''}
          </div>
        </div>
      </div>
    ` : '';

    // Graph reasoning: model-agnostic, so it is offered for every model.
    const graphOn = savedParams.graph_enabled === true;
    const graphK = parseInt(savedParams.graph_branches, 10) || 3;
    // Entropy needs per-token probabilities: local engine, or a provider exposing top_logprobs.
    const graphEntropyOk = targetModel.isLocal === true || supportedParamsList.includes('top_logprobs');
    const graphHtml = `
      <div class="params-section-title">
        <i class="fa-solid fa-diagram-project"></i> ${t('settings.graphTitle')}
        <span class="tag-badge tag-reason" style="margin-left: 8px;"><i class="fa-solid fa-flask"></i> ${t('settings.graphBadge')}</span>
      </div>
      <div class="params-controls-grid">
        <div class="param-control-card" data-param-key="graph_enabled">
          <label class="synth-toggle-wrapper" for="param-graph-enabled">
            <span class="synth-switch"><input type="checkbox" id="param-graph-enabled" ${graphOn ? 'checked' : ''}><span class="synth-slider"></span></span>
            <span><strong>${t('settings.graphEnable')}</strong></span>
          </label>
          <div class="param-card-desc">${t('settings.graphEnableDesc')}</div>
        </div>
        <div class="param-control-card" data-param-key="graph_branches">
          <div class="param-card-header">
            <div class="param-card-label"><i class="fa-solid fa-code-branch"></i><span>${t('settings.graphBranches')}</span></div>
            <span class="param-card-val-badge" id="param-badge-graph_branches">${graphK}</span>
          </div>
          <div class="param-input-slider-row">
            <input type="number" class="param-number-input" style="width: 100%; text-align: left;" data-param-key="graph_branches" min="2" step="1" value="${graphK}">
          </div>
          <div class="param-card-desc">${t('settings.graphBranchesDesc')}</div>
        </div>
        ${graphEntropyOk ? `
        <div class="param-control-card" data-param-key="graph_entropy">
          <label class="synth-toggle-wrapper" for="param-graph-entropy">
            <span class="synth-switch"><input type="checkbox" id="param-graph-entropy" ${savedParams.graph_entropy === true ? 'checked' : ''}><span class="synth-slider"></span></span>
            <span><strong>${t('settings.graphEntropy')}</strong></span>
          </label>
          <div class="param-card-desc">${t('settings.graphEntropyDesc')}</div>
        </div>` : ''}
        <div class="param-control-card" data-param-key="graph_guidance" style="grid-column: 1 / -1;">
          <div class="param-card-header">
            <div class="param-card-label"><i class="fa-solid fa-compass"></i><span>${t('settings.graphGuidance')}</span></div>
          </div>
          <textarea class="param-number-input" id="param-graph-guidance" rows="3" style="width: 100%; text-align: left; resize: vertical;" placeholder="${escapeHtml(t('settings.graphGuidancePlaceholder'))}">${escapeHtml(savedParams.graph_guidance || '')}</textarea>
          <div class="param-card-desc">${t('settings.graphGuidanceDesc')}</div>
        </div>
      </div>
    `;

    container.innerHTML = `
      <div class="params-model-hero">
        <div class="params-hero-info">
          <div class="params-hero-title-row">
            <span class="params-hero-title">${escapeHtml(targetModel.name)}</span>
            <span class="model-provider-badge">${escapeHtml(targetModel.provider)}</span>
          </div>
          <div class="params-hero-id">
            ${escapeHtml(targetModel.id)}
            <span class="btn-copy-mini" onclick="event.stopPropagation(); window.copyToClipboard('${jsToken(targetModel.id)}', this)" title="${t('settings.copyModelId')}">
              <i class="fa-regular fa-copy"></i>
            </span>
          </div>
          <div class="params-hero-meta">
            <span><i class="fa-solid fa-database"></i> Context: <strong>${formatTokens(targetModel.contextLength)}</strong></span>
            ${targetModel.maxCompletionTokens ? `<span><i class="fa-solid fa-arrow-up-from-bracket"></i> Max Out: <strong>${formatTokens(targetModel.maxCompletionTokens)}</strong></span>` : ''}
            ${formatPriceTag(targetModel)}
          </div>
        </div>

        <div class="params-hero-actions">
          <div id="params-save-notice" class="params-save-indicator" style="display: none;">
            <i class="fa-solid fa-check"></i> ${window.i18n.t('settings.paramsAutoSaved')}
          </div>
          <button class="btn-reset-params" id="btn-reset-model-params" title="${t('settings.paramsResetTooltip')}">
            <i class="fa-solid fa-arrow-rotate-left"></i> ${escapeHtml(opts.resetLabel || window.i18n.t('settings.paramsResetAll'))}
          </button>
        </div>
      </div>

      ${capList.length ? `
        <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
          <span style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--text-dim); margin-right: 4px;">
            ${window.i18n.t('settings.paramsCapabilitiesTitle')}
          </span>
          ${capList.join('')}
        </div>
      ` : ''}

      ${targetModel.isLocal ? '<div class="params-local-mount"></div>' : ''}
      ${thinkerHtml}
      ${controlsHtml}
      ${batchHtml}
      ${graphHtml}
      ${unsupportedHtml}
    `;
    // A model on this computer: whether it is in memory and how it is loaded, drawn and kept by local-models.js.
    if (targetModel.isLocal) window.localModelsView?.mount(container.querySelector('.params-local-mount'), targetModel.id);

    // Attach Event Listeners for Live Editing & Auto-Saving
    let saveNoticeTimeout;
    const triggerSavedNotice = () => {
      const notice = container.querySelector('#params-save-notice');
      if (notice) {
        notice.style.display = 'inline-flex';
        clearTimeout(saveNoticeTimeout);
        saveNoticeTimeout = setTimeout(() => {
          notice.style.display = 'none';
        }, 1500);
      }
    };

    container.querySelector('#param-batch-enabled')?.addEventListener('change', (e) => {
      store.setModelParameter(targetModel.id, 'batch_enabled', e.target.checked ? true : null);
      triggerSavedNotice();
    });

    container.querySelector('#param-thinker-effort')?.addEventListener('change', (e) => {
      const v = e.target.value;
      store.setModelParameter('tool:thinking_solver', 'reasoning_effort', v === 'high' ? null : v);
      const badge = container.querySelector('#param-badge-thinker_effort');
      if (badge) badge.textContent = effortLabel(v);
      triggerSavedNotice();
    });

    // Graph reasoning controls
    const saveGraph = (key, val) => {
      store.setModelParameter(targetModel.id, key, val);
      triggerSavedNotice();
    };
    container.querySelector('#param-graph-enabled')?.addEventListener('change', (e) => saveGraph('graph_enabled', e.target.checked ? true : null));
    container.querySelector('#param-graph-entropy')?.addEventListener('change', (e) => saveGraph('graph_entropy', e.target.checked ? true : null));
    container.querySelector('#param-graph-guidance')?.addEventListener('input', (e) => saveGraph('graph_guidance', e.target.value.trim()));
    container.querySelector('input[data-param-key="graph_branches"]')?.addEventListener('input', (e) => {
      const v = Math.max(2, parseInt(e.target.value, 10) || 3);
      const badge = container.querySelector('#param-badge-graph_branches');
      if (badge) badge.textContent = String(v);
      saveGraph('graph_branches', v);
    });

    // Sliders and Number inputs sync
    supportedDefs.filter(d => d.type === 'slider').forEach(def => {
      const slider = container.querySelector(`input[type="range"][data-param-key="${def.key}"]`);
      const numInput = container.querySelector(`input[type="number"][data-param-key="${def.key}"]`);
      const badge = container.querySelector(`#param-badge-${def.key}`);

      const updateVal = (newVal) => {
        const floatVal = parseFloat(newVal);
        if (isNaN(floatVal)) return;
        const clamped = Math.min(def.max, Math.max(def.min, floatVal));
        if (slider) slider.value = clamped;
        if (numInput) numInput.value = clamped;
        if (badge) badge.textContent = def.format(clamped);
        store.setModelParameter(targetModel.id, def.key, clamped);
        triggerSavedNotice();
      };

      // An emptied field takes the user's value away: back to what the model's
      // authors recommend, or to the default of whoever runs the model.
      const clearVal = () => {
        const recommended = targetModel.recommendedParameters?.[def.key];
        store.setModelParameter(targetModel.id, def.key, null);
        if (slider) slider.value = recommended !== undefined ? recommended : def.default;
        if (numInput && recommended !== undefined && document.activeElement !== numInput) numInput.value = recommended;
        if (badge) badge.textContent = recommended !== undefined ? def.format(recommended) : 'Default';
        triggerSavedNotice();
      };

      slider?.addEventListener('input', (e) => updateVal(e.target.value));
      numInput?.addEventListener('input', (e) => (e.target.value.trim() === '' ? clearVal() : updateVal(e.target.value)));
    });

    // Pure Number inputs
    supportedDefs.filter(d => d.type === 'number').forEach(def => {
      const numInput = container.querySelector(`input[type="number"][data-param-key="${def.key}"]`);
      const badge = container.querySelector(`#param-badge-${def.key}`);

      numInput?.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        if (val === '') {
          if (badge) badge.textContent = 'Default';
          store.setModelParameter(targetModel.id, def.key, null);
        } else {
          const parsed = parseInt(val, 10);
          if (!isNaN(parsed)) {
            if (badge) badge.textContent = parsed.toString();
            store.setModelParameter(targetModel.id, def.key, parsed);
          }
        }
        triggerSavedNotice();
      });
    });

    // Select inputs
    supportedDefs.filter(d => d.type === 'select').forEach(def => {
      const select = container.querySelector(`select[data-param-key="${def.key}"]`);
      const badge = container.querySelector(`#param-badge-${def.key}`);

      select?.addEventListener('change', (e) => {
        const val = e.target.value;
        if (badge) badge.textContent = val;
        store.setModelParameter(targetModel.id, def.key, val);
        triggerSavedNotice();
      });
    });

    // Reset button
    const btnReset = container.querySelector('#btn-reset-model-params');
    btnReset?.addEventListener('click', () => {
      store.resetModelParameters(targetModel.id);
      rerender();
      triggerSavedNotice();
    });
  }

  // Inspector Drawer
  function openDrawer(modelId) {
    const model = window.openRouterCatalog.models.find(m => m.id === modelId);
    if (!model) return;

    state.selectedModelForDrawer = model;
    elements.drawerModelName.innerText = model.name;
    elements.drawerModelId.innerText = model.id;

    const allParams = [
      'tools', 'tool_choice', 'structured_outputs', 'response_format',
      'reasoning', 'include_reasoning', 'reasoning_effort',
      'temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty',
      'repetition_penalty', 'min_p', 'seed', 'stop', 'logprobs', 'top_logprobs',
      'logit_bias', 'max_tokens'
    ];

    const paramChips = allParams.map(param => {
      const isSupported = model.supportedParameters.includes(param);
      return `
        <span class="param-chip ${isSupported ? 'active' : ''}">
          <i class="fa-solid ${isSupported ? 'fa-check' : 'fa-xmark'}"></i> ${param}
        </span>
      `;
    }).join('');

    elements.drawerContent.innerHTML = `
      <div class="drawer-section" id="drawer-roles"></div>
      ${model.isLocal ? '<div class="drawer-section" id="drawer-local"></div>' : ''}
      <div class="drawer-section">
        <h3>Descrizione</h3>
        <p style="font-size: 13px; color: var(--text-muted); line-height: 1.6;">
          ${escapeHtml(model.description || 'Nessuna descrizione fornita dal provider.')}
        </p>
      </div>

      <div class="drawer-section">
        <h3>Specifiche Tecniche</h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px; color: var(--text-muted);">
          <div><strong>Provider:</strong> ${escapeHtml(model.provider)}</div>
          ${(() => {
            // The way this model goes: through OpenRouter, or to its maker directly when its key is here.
            const direct = window.modelProviders?.directOf?.(model.id);
            if (!direct) return `<div><strong>${t('settings.routeLabel')}:</strong> ${model.isDirectOnly ? escapeHtml(t('settings.routeDirectOnly')) : 'OpenRouter'}</div>`;
            const chosen = window.modelProviders.routes()[model.id] || (window.modelProviders.preferDirect() ? 'direct' : 'openrouter');
            return `<div><strong>${t('settings.routeLabel')}:</strong>
              <select class="model-route-select" onchange="window.modelProviders.setRoute('${jsToken(model.id)}', this.value)">
                <option value="direct" ${chosen === 'direct' ? 'selected' : ''}>${escapeHtml(t('settings.routeDirect', { provider: direct.provider.name, model: direct.model }))}</option>
                <option value="openrouter" ${chosen === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
              </select></div>`;
          })()}
          <div><strong>Tokenizer:</strong> ${escapeHtml(model.tokenizer)}</div>
          <div><strong>Context Window:</strong> ${model.contextLength.toLocaleString()} token</div>
          <div><strong>Max Output:</strong> ${model.maxCompletionTokens ? model.maxCompletionTokens.toLocaleString() + ' token' : 'N/D'}</div>
          <div><strong>Input Modalities:</strong> ${model.inputModalities.join(', ')}</div>
          <div><strong>Output Modalities:</strong> ${model.outputModalities.join(', ')}</div>
        </div>
      </div>

      <div class="drawer-section">
        <h3>${model.isLocal ? "Parametri" : "Parametri OpenRouter"} (${model.supportedParameters.length} supportati)</h3>
        <div class="param-grid">
          ${paramChips}
        </div>
      </div>

      <div class="drawer-section">
        <h3>Prezzi Normalizzati (1M Token)</h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px;">
          <div style="background: var(--bg-surface); padding: 8px 12px; border-radius: 6px;">
            <div style="font-size: 11px; color: var(--text-dim);">Prompt (Input)</div>
            <div style="font-size: 14px; font-weight: 700; color: var(--primary);">
              ${mPricingStr(model.pricing.promptPerM, model.pricing.isAutoRouter)}
            </div>
          </div>
          <div style="background: var(--bg-surface); padding: 8px 12px; border-radius: 6px;">
            <div style="font-size: 11px; color: var(--text-dim);">Completion (Output)</div>
            <div style="font-size: 14px; font-weight: 700; color: var(--primary);">
              ${mPricingStr(model.pricing.completionPerM, model.pricing.isAutoRouter)}
            </div>
          </div>
        </div>
      </div>
    `;

    renderDrawerRoles();
    if (model.isLocal) window.localModelsView?.mount(elements.drawerContent.querySelector('#drawer-local'), model.id);
    elements.drawerBackdrop.classList.add('open');
    elements.inspectorDrawer.classList.add('open');
  }

  /**
   * The roles of the model open in the drawer: every role that accepts it is a button, lit when the model has it.
   * As many as wanted are given from here. A role is left by giving it another model; a tool goes back to the Master.
   */
  function renderDrawerRoles() {
    const host = elements.drawerContent?.querySelector('#drawer-roles');
    const model = state.selectedModelForDrawer;
    if (!host || !model) return;
    const registry = window.operationalRegistry;
    const roles = (registry?.getAllConfigurableItems?.() || []).filter(item => !item.isNativeEngine && (item.eligibleModels || []).some(m => m.id === model.id));
    const has = (item) => !(item.type === 'tool' && item.isNativeCovered) && item.assignedModelId === model.id;
    host.innerHTML = `
      <h3>${escapeHtml(t('settings.drawerRoles'))}</h3>
      ${roles.length ? `<div class="role-chips">${roles.map(item => {
        const on = has(item);
        const fixed = on && item.type !== 'tool';
        return `<button type="button" class="role-chip ${on ? 'is-on' : ''}" aria-pressed="${on}" data-role="${escapeHtml(item.id)}" ${fixed ? 'disabled' : ''} title="${escapeHtml(on ? (fixed ? t('localModels.roleKept') : t('localModels.roleClear')) : t('localModels.roleGive', { role: item.name }))}">${item.icon || ''} ${escapeHtml(item.name)}</button>`;
      }).join('')}</div>
      <p class="role-chips-note">${escapeHtml(t('settings.drawerRolesNote'))}</p>` : `<p class="role-chips-note">${escapeHtml(t('settings.drawerRolesNone'))}</p>`}`;
    host.onclick = (event) => {
      const chip = event.target.closest('[data-role]');
      if (!chip || chip.disabled) return;
      const item = roles.find(role => role.id === chip.dataset.role);
      if (!item) return;
      const give = !has(item);
      if (item.type === 'master') registry.setSelectedMasterId(model.id);
      else if (item.type === 'microtask') registry.setSelectedMicrotaskId(model.id);
      else if (item.type === 'realtime_multi') registry.setSelectedRealtimeMultiId(model.id);
      else registry.setToolDelegate(item.id, give ? model.id : 'auto');
      renderSettingsView(true);
      try { window.chatManager.renderChatHeader(); } catch {}
      renderDrawerRoles();
    };
  }

  function mPricingStr(val, isAuto) {
    if (isAuto || val < 0) return 'Variabile';
    if (val === 0) return '$0.00 (Free)';
    if (val < 1) return '$' + val.toFixed(3);
    return '$' + val.toFixed(2);
  }

  function closeDrawer() {
    elements.drawerBackdrop.classList.remove('open');
    elements.inspectorDrawer.classList.remove('open');
    state.selectedModelForDrawer = null;
  }

  // Update API Key indicator in header
  function updateKeyBadge() {
    const key = window.openRouterCatalog.getApiKey();
    if (key) {
      elements.labelApiKey.innerText = `API Key: ${key.substring(0, 6)}...`;
      elements.btnOpenKeyModal.classList.add('active');
    } else {
      elements.labelApiKey.innerText = window.i18n.t('nav.apiKeyPublic');
      elements.btnOpenKeyModal.classList.remove('active');
    }
  }

  // Fetch OpenRouter catalog models
  async function loadData(forceRefresh = false) {
    elements.iconSync?.classList.add('spinning');
    try {
      await window.openRouterCatalog.fetchModels(forceRefresh);
      window.chatManager.renderChatHeader();
      if (state.activeView === 'settings') {
        renderSettingsView(true);
      }
    } catch (err) {
      console.error('Catalog load error:', err);
    } finally {
      elements.iconSync?.classList.remove('spinning');
      updateCatalogDate();
    }
  }

  // When the model list under Ruoli & Tool was last downloaded.
  function updateCatalogDate() {
    if (!elements.labelCatalogUpdated) return;
    const when = window.openRouterCatalog?.lastUpdated;
    const locale = window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT';
    elements.labelCatalogUpdated.textContent = when
      ? window.i18n.t('settings.catalogUpdated', { date: new Date(when).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) })
      : window.i18n.t('settings.catalogNever');
  }

  // Escape HTML helper
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Setup Event Listeners
  function setupListeners() {
    // Language Toggle (IT <-> EN)
    const updateLangBadge = () => {
      const cur = window.i18n ? window.i18n.getLocale() : 'it';
      if (elements.labelCurrentLang) {
        elements.labelCurrentLang.innerText = cur.toUpperCase();
      }
      if (elements.btnToggleLang) {
        const titleText = cur === 'it' ? 'Lingua: Italiano (Clicca per passare a EN)' : 'Language: English (Click to switch to IT)';
        elements.btnToggleLang.setAttribute('title', titleText);
        elements.btnToggleLang.setAttribute('aria-label', titleText);
      }
    };

    updateLangBadge();

    elements.btnToggleLang?.addEventListener('click', () => {
      const cur = window.i18n ? window.i18n.getLocale() : 'it';
      const next = cur === 'it' ? 'en' : 'it';
      if (window.i18n) {
        window.i18n.setLocale(next);
      }
      updateLangBadge();
      updateKeyBadge();
      updateCatalogDate();
      if (window.chatManager) {
        window.chatManager.renderChatHeader();
        window.chatManager.render();
        // Rebuilt by script, so its data-i18n span no longer exists and
        // applyToDOM cannot reach it: without this the send button keeps the
        // previous language until the next state change.
        window.chatManager.updateSendButtonState();
      }
      window.chatWorkspace?.refresh?.().catch?.(() => {});
      if (state.activeView === 'settings') {
        renderSettingsView(false);
      }
    });

    // API Key Modal
    elements.btnOpenKeyModal?.addEventListener('click', () => {
      elements.inputApiKey.value = window.openRouterCatalog.getApiKey();
      drawProviderKeys();
      elements.modalKeyBackdrop.classList.add('open');
      elements.inputApiKey.focus();
    });

    // The makers' own keys (providers.js): one row each, with a try of the key and what it answered.
    function drawProviderKeys() {
      const rows = document.getElementById('provider-keys-rows');
      const providers = window.modelProviders;
      if (!rows || !providers) return;
      rows.innerHTML = providers.PROVIDERS.map(provider => {
        const checked = providers.checked(provider.id);
        const key = providers.getKey(provider.id);
        const status = !key ? '' : checked?.ok ? t('modal.providerOk', { count: checked.count }) : checked ? t('modal.providerFailed', { error: checked.error }) : '';
        return `
          <div class="provider-key-row" data-provider="${provider.id}">
            <label class="provider-key-name" for="provider-key-${provider.id}">${escapeHtml(provider.name)}</label>
            <div class="input-with-icon"><i class="fa-solid fa-lock"></i><input type="password" id="provider-key-${provider.id}" placeholder="${escapeHtml(provider.placeholder)}" spellcheck="false" autocomplete="off" value="${escapeHtml(key)}"></div>
            <button type="button" class="btn btn-secondary provider-key-test" data-test="${provider.id}">${t('modal.providerTest')}</button>
            <small class="provider-key-status ${checked && !checked.ok ? 'is-error' : ''}">${escapeHtml(status)}</small>
          </div>`;
      }).join('');
      const prefer = document.getElementById('provider-prefer-direct');
      if (prefer) prefer.checked = providers.preferDirect();
    }
    document.getElementById('provider-keys-rows')?.addEventListener('click', async (e) => {
      const button = e.target.closest('[data-test]');
      if (!button) return;
      const id = button.dataset.test;
      const input = document.getElementById(`provider-key-${id}`);
      button.disabled = true;
      try {
        await window.modelProviders.setKey(id, input?.value || '');
        if (input?.value) await window.modelProviders.test(id);
      } finally { button.disabled = false; }
      drawProviderKeys();
    });
    document.getElementById('provider-prefer-direct')?.addEventListener('change', (e) => {
      window.modelProviders?.setPreferDirect(e.target.checked);
    });
    // The makers' lists changed (a key put, a try made): the catalogue and the lists drawn from it follow.
    window.addEventListener('synthorg-providers-changed', () => {
      window.openRouterCatalog?.mergeDirectModels?.();
      if (state.activeView === 'settings') renderSettingsView(false);
    });

    document.getElementById('btn-onboarding-restart')?.addEventListener('click', () => {
      // The tour, straight away: it starts from the Chat tab.
      elements.modalKeyBackdrop.classList.remove('open');
      window.switchView?.('chat');
      window.onboarding?.start();
    });

    // The same save as the key window, for the setup conversation.
    window.applyApiKey = (key) => {
      window.openRouterCatalog.setApiKey(key);
      updateKeyBadge();
      return loadData(true);
    };

    elements.btnCancelKey?.addEventListener('click', () => {
      elements.modalKeyBackdrop.classList.remove('open');
    });

    elements.modalKeyBackdrop?.addEventListener('click', (e) => {
      if (e.target === elements.modalKeyBackdrop) {
        elements.modalKeyBackdrop.classList.remove('open');
      }
    });

    elements.btnSaveKey?.addEventListener('click', async () => {
      const key = elements.inputApiKey.value.trim();
      window.openRouterCatalog.setApiKey(key);
      // The makers' keys as the rows hold them now: a changed one is kept, and its models asked for.
      for (const provider of window.modelProviders?.PROVIDERS || []) {
        const value = document.getElementById(`provider-key-${provider.id}`)?.value ?? null;
        if (value !== null && value.trim() !== window.modelProviders.getKey(provider.id)) await window.modelProviders.setKey(provider.id, value).catch(() => {});
      }
      updateKeyBadge();
      elements.modalKeyBackdrop.classList.remove('open');
      loadData(true);
    });

    elements.btnRemoveKey?.addEventListener('click', () => {
      window.openRouterCatalog.setApiKey('');
      elements.inputApiKey.value = '';
      updateKeyBadge();
      elements.modalKeyBackdrop.classList.remove('open');
    });

    // Catalog Sync
    elements.btnSync?.addEventListener('click', () => {
      loadData(true);
    });

    // Drawer Close
    elements.btnCloseDrawer?.addEventListener('click', closeDrawer);
    elements.drawerBackdrop?.addEventListener('click', closeDrawer);

    // Chat Listeners
    elements.btnSendChat?.addEventListener('click', () => {
      // While a turn is running the same button is the stop button.
      if (window.chatManager.isGenerating) { window.chatManager.stopGeneration(); return; }
      const text = elements.chatInput.value;
      if (text.trim()) {
        window.chatManager.sendMessage(text);
      }
    });

    elements.btnStt?.addEventListener('click', () => {
      window.chatManager?.toggleSpeechRecognition();
    });

    elements.btnTtsRead?.addEventListener('click', () => {
      window.chatManager?.playLastMessageTTS();
    });

    elements.chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // Enter only ever sends: it must not stop a running turn by accident.
        if (!window.chatManager.isGenerating) elements.btnSendChat.click();
      }
    });

    // Window Controls (Minimize, Maximize/Restore, Close)
    setupWindowControls();

    // Auto-resize chat textarea
    elements.chatInput?.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 160) + 'px';
    });

    // Keyboard ESC
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeDrawer();
        elements.modalKeyBackdrop?.classList.remove('open');
      }
    });

  }

  // Window controls.
  //
  // The window is undecorated so the titlebar is ours, but every geometry
  // operation is delegated to the OS through Tauri: maximize() honours the work
  // area and the DPI of the monitor the window is on, and startDragging() goes
  // through WM_NCLBUTTONDOWN/HTCAPTION, so Aero Snap, snap layouts and
  // drag-to-restore behave exactly as the platform defines them. Nothing here
  // computes window geometry by hand.
  const nativeWindow = () => {
    try { return window.__TAURI__?.window?.getCurrentWindow?.() || null; } catch (_) { return null; }
  };

  // The window is created hidden so the user never sees an unpainted frame.
  async function revealWindow() {
    const appWindow = nativeWindow();
    if (!appWindow) return;
    // Started with the computer for the phone bridge's service: the app goes on without a window.
    try { if ((await window.__TAURI__?.core?.invoke?.('background_state'))?.hidden) return; } catch (_) {}
    try {
      await appWindow.show();
      await appWindow.setFocus();
    } catch (error) {
      console.warn('[Window Show]', error);
    }
  }

  function setupWindowControls() {
    const btnMin = document.getElementById('btn-win-minimize');
    const btnMax = document.getElementById('btn-win-maximize');
    const btnClose = document.getElementById('btn-win-close');
    const header = document.querySelector('.app-header');
    if (!btnMin || !btnMax || !btnClose) return;

    const appWindow = nativeWindow();
    const NON_DRAG = '#window-controls-bar, .nav-tabs, .header-tools, button, input';

    const updateMaxIcon = (isMax) => {
      const icon = btnMax.querySelector('i');
      if (icon) icon.className = isMax ? 'fa-regular fa-window-restore' : 'fa-regular fa-square';
      const label = isMax ? 'Ripristina' : 'Ingrandisci';
      btnMax.title = label;
      btnMax.setAttribute('aria-label', label);
    };

    const syncMaxIcon = async () => {
      if (!appWindow) return updateMaxIcon(Boolean(document.fullscreenElement));
      try { updateMaxIcon(await appWindow.isMaximized()); } catch (error) { console.warn('[Window Sync]', error); }
    };

    const toggleMaximize = async () => {
      if (appWindow) {
        try { await appWindow.toggleMaximize(); } catch (error) { console.warn('[Window Maximize]', error); }
        return syncMaxIcon();
      }
      // Browser fallback, used when the UI is opened outside the desktop shell.
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch (_) {}
    };

    btnMin.addEventListener('click', async () => {
      if (!appWindow) return;
      try { await appWindow.minimize(); } catch (error) { console.warn('[Window Minimize]', error); }
    });

    btnMax.addEventListener('click', toggleMaximize);

    // Two buttons, each saying what it does: this one takes the window away and
    // leaves SynthOrg going, with its icon in the notification area.
    document.getElementById('btn-win-hide')?.addEventListener('click', async () => {
      try { await window.__TAURI__?.core?.invoke?.('background_hide'); } catch (error) { console.warn('[Window Hide]', error); }
    });

    // And this one closes everything, whatever the phone's service is set to.
    btnClose.addEventListener('click', async () => {
      try { await window.__TAURI__.core.invoke('background_quit'); return; } catch (error) { console.warn('[Window Close]', error); }
      try { window.close(); } catch (_) {}
    });

    if (header) {
      header.addEventListener('dblclick', (e) => {
        if (e.target.closest(NON_DRAG)) return;
        toggleMaximize();
      });

      // mousedown, not pointerdown: on Linux the window manager takes the
      // pointer for the whole drag and WebKit never sees the release, so every
      // second press would raise no pointerdown at all.
      header.addEventListener('mousedown', async (e) => {
        if (e.button !== 0 || !appWindow) return;
        if (e.target.closest(NON_DRAG)) return;
        try { await appWindow.startDragging(); } catch (error) { console.warn('[Window Drag]', error); }
      });
    }

    document.addEventListener('fullscreenchange', () => {
      if (!appWindow) updateMaxIcon(Boolean(document.fullscreenElement));
    });

    if (appWindow) {
      appWindow.onResized(syncMaxIcon).catch((error) => console.warn('[Window Events]', error));
    }
    syncMaxIcon();
  }

  /**
   * Cinematic Ambient Startup Swell synthesized via Web Audio API.
   * Evokes a high-end sci-fi / neural engine coming online: warm sub-rise,
   * lush analog synth pad swell with resonant filter sweep, and airy spatial decay.
   * Completely free of harsh percussive strikes or metallic bell/dong sounds.
   */
  function playStartupChime() {
    if (localStorage.getItem('synthorg_startup_sound') === 'false') return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      const now = ctx.currentTime + 0.05;

      // Master output bus with smooth fade-in and long spatial release
      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(0.0001, now);
      masterGain.gain.exponentialRampToValueAtTime(0.28, now + 0.35);
      masterGain.gain.exponentialRampToValueAtTime(0.00005, now + 3.0);

      // Resonant lowpass filter that opens smoothly and gently rolls off
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(180, now);
      filter.frequency.exponentialRampToValueAtTime(1400, now + 1.2);
      filter.frequency.exponentialRampToValueAtTime(320, now + 2.8);
      filter.Q.setValueAtTime(1.8, now);

      masterGain.connect(filter);
      filter.connect(ctx.destination);

      // 1. Warm Sub-Bass Rise (smooth glide from 55Hz to 82Hz)
      const subOsc = ctx.createOscillator();
      const subGain = ctx.createGain();
      subOsc.type = 'sine';
      subOsc.frequency.setValueAtTime(55.0, now);
      subOsc.frequency.exponentialRampToValueAtTime(82.4, now + 1.5);
      subGain.gain.setValueAtTime(0.0001, now);
      subGain.gain.exponentialRampToValueAtTime(0.35, now + 0.3);
      subGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.6);
      subOsc.connect(subGain);
      subGain.connect(ctx.destination); // Direct to keep low-end unmodulated
      subOsc.start(now);
      subOsc.stop(now + 2.8);

      // 2. Cinematic Ambient Pad Chord (Fmaj9 / Dm9 open voicing)
      const padVoices = [
        { freq: 87.31,  type: 'triangle', gain: 0.50, detune: -2 }, // F2
        { freq: 130.81, type: 'sine',     gain: 0.45, detune: 2 },  // C3
        { freq: 220.00, type: 'triangle', gain: 0.38, detune: -3 }, // A3
        { freq: 261.63, type: 'sine',     gain: 0.35, detune: 3 },  // C4
        { freq: 329.63, type: 'triangle', gain: 0.30, detune: -2 }, // E4
        { freq: 392.00, type: 'sine',     gain: 0.25, detune: 4 },  // G4
        // Ethereal air shimmer (soft breath on top, no harsh attack)
        { freq: 1046.50, type: 'sine',    gain: 0.05, detune: -4 }, // C6
        { freq: 1567.98, type: 'sine',    gain: 0.03, detune: 5 }   // G6
      ];

      padVoices.forEach(v => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();

        osc.type = v.type;
        osc.frequency.setValueAtTime(v.freq, now);
        if (v.detune) osc.detune.setValueAtTime(v.detune, now);

        // Silky soft swell envelope (0.22s attack eliminates all clicks/dong hits)
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(v.gain, now + 0.22);
        g.gain.exponentialRampToValueAtTime(0.00001, now + 2.7);

        osc.connect(g);
        g.connect(masterGain);

        osc.start(now);
        osc.stop(now + 2.8);
      });

      // Cleanup audio context after swell fades
      setTimeout(() => {
        try { ctx.close(); } catch (_) {}
      }, 3400);
    } catch (err) {
      console.warn('[Startup Sound]', err);
    }
  }

  /**
   * Synthesizes notification sounds for AI response completion / task finish.
   * Styles: 'pulse' (Cinematic Pulse), 'subtle' (Minimal Blip), 'chime' (Soft Chime).
   */
  function playNotificationSound(style) {
    const selected = style || localStorage.getItem('synthorg_notification_sound') || 'pulse';
    if (selected === 'none') return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const now = ctx.currentTime + 0.02;

      if (selected === 'subtle') {
        // Minimal soft blip/tick (880Hz -> 1320Hz, 40ms, whisper-soft)
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1320, now + 0.035);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.10, now + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.00001, now + 0.045);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.05);
      } else if (selected === 'chime') {
        // Soft melodic two-tone chime (E5 -> B5, warm and gentle)
        const notes = [659.25, 987.77];
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const t = now + (idx * 0.08);
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, t);
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(0.14, t + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.00001, t + 0.40);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(t);
          osc.stop(t + 0.42);
        });
      } else {
        // Default: 'pulse' - Modern warm cinematic pulse chord with lowpass sweep
        const master = ctx.createGain();
        master.gain.setValueAtTime(0.0001, now);
        master.gain.exponentialRampToValueAtTime(0.20, now + 0.02);
        master.gain.exponentialRampToValueAtTime(0.00001, now + 0.38);

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(2200, now);
        filter.frequency.exponentialRampToValueAtTime(650, now + 0.35);

        master.connect(filter);
        filter.connect(ctx.destination);

        [440, 554.37, 659.25].forEach((freq) => {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, now);
          g.gain.setValueAtTime(0.0001, now);
          g.gain.exponentialRampToValueAtTime(0.28, now + 0.015);
          g.gain.exponentialRampToValueAtTime(0.00001, now + 0.35);
          osc.connect(g);
          g.connect(master);
          osc.start(now);
          osc.stop(now + 0.38);
        });
      }

      setTimeout(() => {
        try { ctx.close(); } catch (_) {}
      }, 800);
    } catch (err) {
      console.warn('[Notification Sound]', err);
    }
  }

  /**
   * The project's environment is up: a short two-note rise, warm and quiet.
   * Its own sound, apart from the startup swell and from the notification
   * ones: this says "the container is ready", not "a model answered".
   * Silenced with localStorage 'synthorg_env_sound' = 'false'.
   */
  function playEnvironmentReady() {
    if (localStorage.getItem('synthorg_env_sound') === 'false') return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const now = ctx.currentTime + 0.02;

      const master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(0.16, now + 0.05);
      master.gain.exponentialRampToValueAtTime(0.00001, now + 0.75);

      // Soft top end: the rise should read as breath, not as a bell.
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1200, now);
      filter.frequency.exponentialRampToValueAtTime(2600, now + 0.25);
      master.connect(filter);
      filter.connect(ctx.destination);

      // D5 then A5, the second one over the tail of the first.
      [{ freq: 587.33, at: 0 }, { freq: 880.0, at: 0.13 }].forEach(({ freq, at }) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const t = now + at;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.00001, t + 0.55);
        osc.connect(gain);
        gain.connect(master);
        osc.start(t);
        osc.stop(t + 0.6);
      });

      setTimeout(() => { try { ctx.close(); } catch (_) {} }, 1200);
    } catch (err) {
      console.warn('[Environment Sound]', err);
    }
  }

  let splashStartTime = performance.now();

  /**
   * Smoothly dissolves the startup splash screen into the main workspace.
   */
  function hideSplashScreen(minDurationMs = 1200) {
    const splash = document.getElementById('app-splash-screen');
    if (!splash || splash.dataset.dismissed === 'true') return;
    splash.dataset.dismissed = 'true';

    const elapsed = performance.now() - splashStartTime;
    const delay = Math.max(0, minDurationMs - elapsed);

    setTimeout(() => {
      splash.classList.add('is-leaving');
      setTimeout(() => {
        splash.style.display = 'none';
        splash.remove();
      }, 700);
    }, delay);
  }

  /**
   * Startup unlock: ask for the master password in place of the loading
   * indicator, keeping the splash's translucent backdrop. The key is derived
   * and cached in the native layer for the whole session, so this is asked once.
   * Falls back to the modal dialog if the splash markup is missing.
   */
  function showSplashUnlock(onSuccess) {
    // On the phone the vault is opened on the computer: the phone waits for it (remote.js).
    if (window.remote?.active) { window.remote.waitUnlock(onSuccess); return; }
    const splash = document.getElementById('app-splash-screen');
    const form = document.getElementById('splash-unlock-form');
    const input = document.getElementById('splash-unlock-input');
    const submitBtn = document.getElementById('splash-unlock-submit');
    const errorEl = document.getElementById('splash-unlock-error');
    const progress = document.getElementById('splash-progress-track');
    const status = document.getElementById('splash-status-text');

    if (!splash || splash.dataset.dismissed === 'true' || !form || !input) {
      hideSplashScreen(300);
      showVaultUnlockDialog(onSuccess);
      return;
    }

    if (progress) progress.style.display = 'none';
    if (status) status.style.display = 'none';
    form.hidden = false;
    form.classList.add('is-visible');
    setTimeout(() => input.focus(), 60);

    const restoreLoading = () => {
      form.classList.remove('is-visible');
      form.hidden = true;
      if (progress) progress.style.display = '';
      if (status) status.style.display = '';
    };

    form.onsubmit = async (e) => {
      e.preventDefault();
      const pw = input.value.trim();
      if (!pw) return;
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
      if (errorEl) { errorEl.hidden = true; errorEl.textContent = ''; }
      try {
        await window.chatStorage.unlockDatabase(pw);
        restoreLoading();
        if (typeof onSuccess === 'function') onSuccess();
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-lock-open"></i>';
        input.value = '';
        input.focus();
        if (errorEl) {
          errorEl.textContent = window.i18n ? window.i18n.t('vault.wrongPassword') : 'Password errata o archivio corrotto. Riprova.';
          errorEl.hidden = false;
        }
      }
    };
  }
  window.showSplashUnlock = showSplashUnlock;

  // Expose global methods for inline HTML event handlers
  window.switchView = switchView;
  window.switchSettingsSection = switchSettingsSection;
  window.renderAppearanceSection = renderAppearanceSection;
  window.selectSettingItem = selectSettingItem;
  window.renderParamsPanel = renderSettingsParamsPanel;
  window.assignModelAsDefault = assignModelAsDefault;
  window.openDrawer = openDrawer;
  window.closeDrawer = closeDrawer;
  window.copyToClipboard = copyToClipboard;
  window.changeSettingsPage = changeSettingsPage;
  window.changeSettingsPageSize = changeSettingsPageSize;
  window.playStartupChime = playStartupChime;
  window.playNotificationSound = playNotificationSound;
  window.playEnvironmentReady = playEnvironmentReady;
  window.hideSplashScreen = hideSplashScreen;

  // Application bootstrap
  document.addEventListener('DOMContentLoaded', () => {
    splashStartTime = performance.now();
    // Play the startup chime as soon as the DOM is ready
    playStartupChime();

    cacheElements();

    // Initialize Theme System
    if (window.themeManager) {
      window.themeManager.apply();
    }

    window.i18n.applyToDOM();
    setupListeners();
    setupWindowControls();
    // Two frames: let the themed, translated UI paint before the frame appears.
    requestAnimationFrame(() => requestAnimationFrame(revealWindow));
    window.chatWorkspace.bind();

    async function syncAudioSettingsWithStorage() {
      try {
        if (!window.chatStorage || typeof window.chatStorage.getSettings !== 'function') return;
        const settings = await window.chatStorage.getSettings();
        if (!settings || typeof settings !== 'object') return;

        if (settings.startup_sound !== undefined) {
          try { localStorage.setItem('synthorg_startup_sound', settings.startup_sound); } catch {}
        } else {
          const local = localStorage.getItem('synthorg_startup_sound');
          if (local !== null && window.chatStorage?.setSetting) {
            window.chatStorage.setSetting('startup_sound', local).catch(() => {});
          }
        }

        if (settings.notification_sound) {
          try { localStorage.setItem('synthorg_notification_sound', settings.notification_sound); } catch {}
        } else {
          const local = localStorage.getItem('synthorg_notification_sound');
          if (local && window.chatStorage?.setSetting) {
            window.chatStorage.setSetting('notification_sound', local).catch(() => {});
          }
        }

        if (settings.env_sound !== undefined) {
          try { localStorage.setItem('synthorg_env_sound', settings.env_sound); } catch {}
        } else {
          const local = localStorage.getItem('synthorg_env_sound');
          if (local !== null && window.chatStorage?.setSetting) {
            window.chatStorage.setSetting('env_sound', local).catch(() => {});
          }
        }
      } catch (err) {
        console.warn('[Main] syncAudioSettingsWithStorage error:', err);
      }
    }

    async function syncPrivacyCachingSettingsWithStorage() {
      try {
        if (!window.chatStorage || typeof window.chatStorage.getSettings !== 'function') return;
        const settings = await window.chatStorage.getSettings();
        if (!settings || typeof settings !== 'object') return;

        if (settings.prompt_caching_enabled !== undefined) {
          try { localStorage.setItem('synthorg_prompt_caching_enabled', settings.prompt_caching_enabled); } catch {}
        } else {
          const local = localStorage.getItem('synthorg_prompt_caching_enabled') ?? 'true';
          try { localStorage.setItem('synthorg_prompt_caching_enabled', local); } catch {}
          if (window.chatStorage?.setSetting) {
            window.chatStorage.setSetting('prompt_caching_enabled', local).catch(() => {});
          }
        }

        if (settings.openrouter_zdr_enabled !== undefined) {
          try { localStorage.setItem('synthorg_openrouter_zdr_enabled', settings.openrouter_zdr_enabled); } catch {}
        } else {
          const local = localStorage.getItem('synthorg_openrouter_zdr_enabled') ?? 'false';
          try { localStorage.setItem('synthorg_openrouter_zdr_enabled', local); } catch {}
          if (window.chatStorage?.setSetting) {
            window.chatStorage.setSetting('openrouter_zdr_enabled', local).catch(() => {});
          }
        }
      } catch (err) {
        console.warn('[Main] syncPrivacyCachingSettingsWithStorage error:', err);
      }
    }

    // Settings changed on the other side: the badge and the settings page on screen follow,
    // unless the user is writing in that page right now.
    // What is in memory changed, or a role was given elsewhere (the local models' page, the header's manager):
    // the lists that say so are drawn again.
    const settingsShown = () => Boolean(elements.settingsMainWorkspace?.offsetParent);
    document.addEventListener('synthorg-loaded-models', () => { if (settingsShown() && state.settingsRoleActiveTab === 'models') renderSettingsModelsList(); });
    document.addEventListener('synthorg-roles-changed', () => { if (settingsShown()) renderSettingsView(true); renderDrawerRoles(); });
    document.addEventListener('synthorg-changed', (event) => {
      const changed = event.detail?.settings || [];
      if (!changed.length) return;
      updateKeyBadge();
      if (state.activeView !== 'settings') return;
      if (elements.viewSettings?.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
      switchSettingsSection(state.settingsSection);
    });

    const startAppBootstrap = async () => {
      updateKeyBadge();
      try {
        await Promise.allSettled([
          window.openRouterCatalog?.syncApiKey?.(),
          // The makers' own keys and the way chosen for each model (providers.js).
          window.modelProviders?.load?.(),
          window.operationalRegistry?.syncWithStorage?.(),
          window.themeManager?.syncWithStorage?.(),
          window.i18n?.syncWithStorage?.(),
          window.promptManager?.syncWithStorage?.(),
          syncAudioSettingsWithStorage(),
          syncPrivacyCachingSettingsWithStorage()
        ]);
      } catch (_) {}
      updateKeyBadge();
      loadData(false);
      window.chatManager.initialize();
      // What the other side (a phone, or this computer seen from the phone) writes shows here too.
      window.archiveSync?.start();
      // Dismiss the splash screen once the initial workspace bootstrap is complete
      hideSplashScreen(1200);
      // First launch: the setup question comes after the splash has faded.
      setTimeout(() => window.onboarding?.maybeStart?.(), 2000);
    };

    if (window.chatStorage?.getSecurityStatus) {
      window.chatStorage.getSecurityStatus().then((secStatus) => {
        if (secStatus?.isEncrypted && !secStatus?.isUnlocked) {
          // Ask for the master password right in the splash, then boot.
          showSplashUnlock(() => {
            startAppBootstrap();
          });
        } else {
          startAppBootstrap();
        }
      }).catch(() => {
        startAppBootstrap();
      });
    } else {
      startAppBootstrap();
    }
  });
})();
