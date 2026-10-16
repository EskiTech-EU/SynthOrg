/**
 * SynthOrg - Theme & Appearance Manager
 * Manages 3-tier color system (Mode, Shade, Accent), Corner Geometry, and Typography.
 */

(function () {
  'use strict';

  // The colours the three pickers offer. The neutral three belong to the
  // secondary alone; everything else is offered as both, so one list of hues
  // serves the two layers.
  const ACCENTS = ['emerald', 'teal', 'blue', 'indigo', 'violet', 'magenta', 'rose', 'amber', 'orange', 'lime', 'cyan'];
  const SHADES = ['slate', 'charcoal', 'zinc', ...ACCENTS];
  // The third layer. Dark and light each have their own three: they are not
  // interchangeable — cream is not a dark background — so the choice is kept
  // per side and the picker shows the three that belong to the side in use.
  const BACKGROUNDS = { dark: ['nero', 'blunotte', 'grigio'], light: ['bianco', 'grigiochiaro', 'crema'] };
  // How much of a message is drawn: only the words, or the frames too.
  const BUBBLES = ['clean', 'boxed'];
  // How the lines between the parts of the window are drawn: stopping short of
  // each other, as on a sheet of paper, or meeting to close each part in a box.
  const LINES = ['sheet', 'boxed'];

  class ThemeManager {
    constructor() {
      this.STORAGE_KEY = 'synthorg_theme_prefs';
      this.prefs = this.loadPrefs();
      this.apply();
      this.listenSystemTheme();
    }

    getDefaults() {
      return {
        mode: 'system',
        bgDark: 'nero', // The page itself, on the dark side
        bgLight: 'bianco', // and on the light one
        shade: 'slate', // Decorative card gradients and halos only
        accent: 'blue', // Icons, secondary text, borders and controls
        radius: 'standard', // 'sharp' | 'standard' | 'soft'
        bubbles: 'clean', // 'clean' | 'boxed': the frames around messages and reasoning
        lines: 'sheet', // 'sheet' | 'boxed': the lines between the parts of the window
        font: 'inter' // 'inter' | 'mono' | 'system' | 'outfit'
      };
    }

    loadPrefs() {
      try {
        const saved = localStorage.getItem(this.STORAGE_KEY);
        const stored = saved ? JSON.parse(saved) : {};
        const defaults = this.getDefaults();
        const options = {
          mode: ['dark', 'light', 'system'],
          bgDark: BACKGROUNDS.dark,
          bgLight: BACKGROUNDS.light,
          shade: SHADES,
          accent: ACCENTS,
          radius: ['sharp', 'standard', 'soft'],
          bubbles: BUBBLES,
          lines: LINES,
          font: ['inter', 'mono', 'system', 'outfit']
        };
        // Import the old standalone picker only when no unified preference exists.
        const legacyAccent = localStorage.getItem('synthorg_theme_accent');
        if (!stored?.accent && options.accent.includes(legacyAccent)) defaults.accent = legacyAccent;
        return Object.fromEntries(Object.entries(defaults).map(([key, value]) =>
          [key, options[key].includes(stored?.[key]) ? stored[key] : value]
        ));
      } catch {
        return this.getDefaults();
      }
    }

    savePrefs() {
      try {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.prefs));
      } catch (e) {
        console.warn('Could not save theme preferences:', e);
      }
      if (typeof window !== 'undefined' && window.chatStorage?.setSetting) {
        window.chatStorage.setSetting('theme_preferences', JSON.stringify(this.prefs)).catch(() => {});
      }
    }

    async syncWithStorage() {
      try {
        if (typeof window === 'undefined' || !window.chatStorage || typeof window.chatStorage.getSetting !== 'function') return;
        const res = await window.chatStorage.getSetting('theme_preferences');
        if (res?.value) {
          try {
            const parsed = JSON.parse(res.value);
            if (parsed && typeof parsed === 'object') {
              const defaults = this.getDefaults();
              const options = {
                mode: ['dark', 'light', 'system'],
                bgDark: BACKGROUNDS.dark,
                bgLight: BACKGROUNDS.light,
                shade: SHADES,
                accent: ACCENTS,
                radius: ['sharp', 'standard', 'soft'],
                bubbles: BUBBLES,
                lines: LINES,
                font: ['inter', 'mono', 'system', 'outfit']
              };
              Object.keys(defaults).forEach(key => {
                if (options[key].includes(parsed[key])) {
                  this.prefs[key] = parsed[key];
                }
              });
              this.apply();
              try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.prefs)); } catch {}
              return;
            }
          } catch {}
        }
        if (this.prefs && window.chatStorage?.setSetting) {
          window.chatStorage.setSetting('theme_preferences', JSON.stringify(this.prefs)).catch(() => {});
        }
      } catch (err) {
        console.warn('[ThemeManager] syncWithStorage error:', err);
      }
    }

    setMode(mode) {
      if (['dark', 'light', 'system'].includes(mode)) {
        this.prefs.mode = mode;
        this.savePrefs();
        this.apply();
      }
    }

    /** The page's own colour, for the side (dark or light) it belongs to. */
    setBackground(background) {
      const key = BACKGROUNDS.dark.includes(background) ? 'bgDark'
        : BACKGROUNDS.light.includes(background) ? 'bgLight' : null;
      if (!key) return;
      this.prefs[key] = background;
      this.savePrefs();
      this.apply();
    }

    setShade(shade) {
      if (SHADES.includes(shade)) {
        this.prefs.shade = shade;
        this.savePrefs();
        this.apply();
      }
    }

    setAccent(accent) {
      if (ACCENTS.includes(accent)) {
        this.prefs.accent = accent;
        this.savePrefs();
        this.apply();
      }
    }

    /** Whether a message is drawn inside its frames, or only read. */
    setBubbles(bubbles) {
      if (BUBBLES.includes(bubbles)) {
        this.prefs.bubbles = bubbles;
        this.savePrefs();
        this.apply();
      }
    }

    /** Whether the lines between the parts stop short of each other or close into boxes. */
    setLines(lines) {
      if (LINES.includes(lines)) {
        this.prefs.lines = lines;
        this.savePrefs();
        this.apply();
      }
    }

    setRadius(radius) {
      if (['sharp', 'standard', 'soft'].includes(radius)) {
        this.prefs.radius = radius;
        this.savePrefs();
        this.apply();
      }
    }

    setFont(font) {
      if (['inter', 'mono', 'system', 'outfit'].includes(font)) {
        this.prefs.font = font;
        this.savePrefs();
        this.apply();
      }
    }

    getEffectiveMode() {
      if (this.prefs.mode === 'system') {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      }
      return this.prefs.mode;
    }

    listenSystemTheme() {
      if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
          if (this.prefs.mode === 'system') {
            this.apply();
          }
        });
      }
    }

    apply() {
      const root = document.documentElement;
      const effectiveMode = this.getEffectiveMode();

      root.setAttribute('data-theme-mode', effectiveMode);
      root.setAttribute('data-theme-bg', effectiveMode === 'light' ? this.prefs.bgLight : this.prefs.bgDark);
      root.setAttribute('data-theme-setting', this.prefs.mode);
      root.setAttribute('data-theme-shade', this.prefs.shade);
      root.setAttribute('data-theme-accent', this.prefs.accent);
      root.setAttribute('data-theme-radius', this.prefs.radius);
      root.setAttribute('data-theme-bubbles', this.prefs.bubbles);
      root.setAttribute('data-theme-lines', this.prefs.lines);
      root.setAttribute('data-theme-font', this.prefs.font);
      // Old versions set a competing palette on body, shadowing root variables.
      document.body?.removeAttribute('data-theme-accent');

      // Trigger custom event for UI updates if needed
      window.dispatchEvent(new CustomEvent('synthorg-theme-changed', { detail: this.prefs }));
    }
  }

  window.themeManager = new ThemeManager();
})();
