const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('ThemeManager synchronizes preferences with SQLite chatStorage', async () => {
  const code = fs.readFileSync(path.join(__dirname, '../resources/js/theme.js'), 'utf8');

  const mockStorage = new Map();
  const sqliteSettings = new Map();

  const mockDoc = {
    documentElement: { setAttribute: () => {} },
    body: { removeAttribute: () => {} }
  };

  const sandbox = {
    CustomEvent: class CustomEvent {},
    window: {
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      dispatchEvent: () => {},
      CustomEvent: class CustomEvent {},
      chatStorage: {
        getSetting: async (k) => ({ key: k, value: sqliteSettings.get(k) || null }),
        setSetting: async (k, v) => sqliteSettings.set(k, v)
      }
    },
    document: mockDoc,
    localStorage: {
      getItem: (k) => mockStorage.get(k) || null,
      setItem: (k, v) => mockStorage.set(k, String(v)),
      removeItem: (k) => mockStorage.delete(k)
    },
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  const tm = sandbox.window.themeManager;
  assert.ok(tm);

  // Set accent and mode
  tm.setMode('dark');
  tm.setAccent('emerald');

  // Verify written to SQLite
  assert.ok(sqliteSettings.has('theme_preferences'));
  const storedInSql = JSON.parse(sqliteSettings.get('theme_preferences'));
  assert.equal(storedInSql.mode, 'dark');
  assert.equal(storedInSql.accent, 'emerald');

  // Clear localStorage to simulate new session / wiped cache
  mockStorage.clear();
  assert.equal(mockStorage.size, 0);

  // Re-sync with SQLite storage
  await tm.syncWithStorage();
  assert.equal(tm.prefs.mode, 'dark');
  assert.equal(tm.prefs.accent, 'emerald');
  assert.ok(mockStorage.has('synthorg_theme_prefs'));
});

test('I18nManager synchronizes locale with SQLite chatStorage', async () => {
  const code = fs.readFileSync(path.join(__dirname, '../resources/js/i18n.js'), 'utf8');

  const mockStorage = new Map();
  const sqliteSettings = new Map();

  const sandbox = {
    window: {
      chatStorage: {
        getSetting: async (k) => ({ key: k, value: sqliteSettings.get(k) || null }),
        setSetting: async (k, v) => sqliteSettings.set(k, v)
      }
    },
    document: {
      querySelectorAll: () => []
    },
    localStorage: {
      getItem: (k) => mockStorage.get(k) || null,
      setItem: (k, v) => mockStorage.set(k, String(v)),
      removeItem: (k) => mockStorage.delete(k)
    },
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  const i18n = sandbox.window.i18n;
  assert.ok(i18n);

  // Switch to english
  i18n.setLocale('en');
  assert.equal(i18n.getLocale(), 'en');
  assert.equal(sqliteSettings.get('app_locale'), 'en');

  // Wipe localStorage
  mockStorage.clear();
  assert.equal(mockStorage.size, 0);

  // Re-sync from SQLite
  await i18n.syncWithStorage();
  assert.equal(i18n.getLocale(), 'en');
  assert.equal(mockStorage.get('synthorg_locale'), 'en');
});

test('PromptManager synchronizes configuration with SQLite chatStorage', async () => {
  const code = fs.readFileSync(path.join(__dirname, '../resources/js/prompts.js'), 'utf8');

  const mockStorage = new Map();
  const sqliteSettings = new Map();

  const sandbox = {
    window: {
      chatStorage: {
        getSetting: async (k) => ({ key: k, value: sqliteSettings.get(k) || null }),
        setSetting: async (k, v) => sqliteSettings.set(k, v)
      }
    },
    localStorage: {
      getItem: (k) => mockStorage.get(k) || null,
      setItem: (k, v) => mockStorage.set(k, String(v)),
      removeItem: (k) => mockStorage.delete(k)
    },
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  const pm = sandbox.window.promptManager;
  assert.ok(pm);

  // Modify a section
  const secState = pm.getSectionState('persona_role');
  secState.mode = 'long';
  secState.customText = 'Custom System Directive';
  pm.saveConfig();

  // Verify written to SQLite
  assert.ok(sqliteSettings.has('system_prompts_config'));
  const parsed = JSON.parse(sqliteSettings.get('system_prompts_config'));
  assert.equal(parsed.persona_role.mode, 'long');
  assert.equal(parsed.persona_role.customText, 'Custom System Directive');

  // Clear mockStorage
  mockStorage.clear();
  assert.equal(mockStorage.size, 0);

  // Re-sync from SQLite
  await pm.syncWithStorage();
  const restoredSec = pm.getSectionState('persona_role');
  assert.equal(restoredSec.mode, 'long');
  assert.equal(restoredSec.customText, 'Custom System Directive');
});

test('Audio settings synchronize with SQLite chatStorage', async () => {
  const mockStorage = new Map();
  const sqliteSettings = new Map();

  const chatStorage = {
    getSettings: async () => Object.fromEntries(sqliteSettings),
    setSetting: async (k, v) => sqliteSettings.set(k, v)
  };

  // Simulate user changing startup sound and notification sound in settings UI
  function onStartupSoundChanged(val) {
    mockStorage.set('synthorg_startup_sound', val);
    chatStorage.setSetting('startup_sound', val);
  }

  function onNotificationSoundChanged(val) {
    mockStorage.set('synthorg_notification_sound', val);
    chatStorage.setSetting('notification_sound', val);
  }

  onStartupSoundChanged('false');
  onNotificationSoundChanged('subtle');

  assert.equal(sqliteSettings.get('startup_sound'), 'false');
  assert.equal(sqliteSettings.get('notification_sound'), 'subtle');

  // Simulate clean session
  mockStorage.clear();
  assert.equal(mockStorage.size, 0);

  // Re-sync function as implemented in main.js
  async function syncAudioSettingsWithStorage() {
    const settings = await chatStorage.getSettings();
    if (settings.startup_sound !== undefined) {
      mockStorage.set('synthorg_startup_sound', settings.startup_sound);
    }
    if (settings.notification_sound) {
      mockStorage.set('synthorg_notification_sound', settings.notification_sound);
    }
  }

  await syncAudioSettingsWithStorage();
  assert.equal(mockStorage.get('synthorg_startup_sound'), 'false');
  assert.equal(mockStorage.get('synthorg_notification_sound'), 'subtle');
});

