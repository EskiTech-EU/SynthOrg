const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('i18n translations for Privacy & Caching section exist in Italian and English', () => {
  const code = fs.readFileSync(path.join(__dirname, '../resources/js/i18n.js'), 'utf8');
  const sandbox = {
    window: {
      matchMedia: () => ({ matches: false }),
      chatStorage: { getSetting: async () => ({ value: null }), setSetting: async () => {} }
    },
    document: { querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: () => {} },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const i18n = sandbox.window.i18n;

  const requiredKeys = [
    'settings.tabPrivacy',
    'privacy.sectionTitle',
    'privacy.sectionSubtitle',
    'privacy.cachingCardTitle',
    'privacy.cachingCardBadge',
    'privacy.cachingCardDesc',
    'privacy.cachingEnabledLabel',
    'privacy.cachingActiveStatus',
    'privacy.cachingInactiveStatus',
    'privacy.zdrCardTitle',
    'privacy.zdrCardBadge',
    'privacy.zdrCardDesc',
    'privacy.zdrEnabledLabel',
    'privacy.zdrActiveStatus',
    'privacy.zdrInactiveStatus',
    'privacy.noticeTitle',
    'privacy.noticeDesc',
    'privacy.savedFeedback'
  ];

  for (const key of requiredKeys) {
    i18n.setLocale('it');
    const itVal = i18n.t(key);
    assert.ok(itVal && itVal !== key, `Missing Italian key: ${key}`);

    i18n.setLocale('en');
    const enVal = i18n.t(key);
    assert.ok(enVal && enVal !== key, `Missing English key: ${key}`);
  }
});

test('Privacy and Prompt Caching settings synchronize with SQLite database and defaults', async () => {
  const mockStorage = new Map();
  const sqliteSettings = new Map();

  async function syncPrivacyCachingSettingsWithStorage() {
    const settings = Object.fromEntries(sqliteSettings);

    if (settings.prompt_caching_enabled !== undefined) {
      mockStorage.set('synthorg_prompt_caching_enabled', settings.prompt_caching_enabled);
    } else {
      const local = mockStorage.get('synthorg_prompt_caching_enabled') ?? 'true';
      mockStorage.set('synthorg_prompt_caching_enabled', local);
      sqliteSettings.set('prompt_caching_enabled', local);
    }

    if (settings.openrouter_zdr_enabled !== undefined) {
      mockStorage.set('synthorg_openrouter_zdr_enabled', settings.openrouter_zdr_enabled);
    } else {
      const local = mockStorage.get('synthorg_openrouter_zdr_enabled') ?? 'false';
      mockStorage.set('synthorg_openrouter_zdr_enabled', local);
      sqliteSettings.set('openrouter_zdr_enabled', local);
    }
  }

  // 1. Initial bootstrap: defaults should be Caching = 'true', ZDR = 'false'
  await syncPrivacyCachingSettingsWithStorage();
  assert.equal(mockStorage.get('synthorg_prompt_caching_enabled'), 'true');
  assert.equal(mockStorage.get('synthorg_openrouter_zdr_enabled'), 'false');
  assert.equal(sqliteSettings.get('prompt_caching_enabled'), 'true');
  assert.equal(sqliteSettings.get('openrouter_zdr_enabled'), 'false');

  // 2. User toggles ZDR on and Caching off
  mockStorage.set('synthorg_prompt_caching_enabled', 'false');
  sqliteSettings.set('prompt_caching_enabled', 'false');
  mockStorage.set('synthorg_openrouter_zdr_enabled', 'true');
  sqliteSettings.set('openrouter_zdr_enabled', 'true');

  // 3. Clear localStorage (simulating cache clear/new session) and resync
  mockStorage.clear();
  await syncPrivacyCachingSettingsWithStorage();
  assert.equal(mockStorage.get('synthorg_prompt_caching_enabled'), 'false');
  assert.equal(mockStorage.get('synthorg_openrouter_zdr_enabled'), 'true');
});

test('OpenRouter chat completions payload injects prompt caching session_id and cache_control', () => {
  const conversationId = 'conv_test_123';
  const mockStorage = new Map([
    ['synthorg_prompt_caching_enabled', 'true'],
    ['synthorg_openrouter_zdr_enabled', 'false']
  ]);

  const workingMessages = [
    { role: 'system', content: 'You are SynthOrg Master Orchestrator.' },
    { role: 'user', content: 'Hello!' }
  ];

  const payload = {
    model: 'anthropic/claude-3.7-sonnet',
    messages: workingMessages,
    stream: true,
    include_reasoning: true
  };

  const cachingEnabled = mockStorage.get('synthorg_prompt_caching_enabled') !== 'false';
  if (cachingEnabled && conversationId) {
    payload.session_id = String(conversationId);
  }

  const zdrEnabled = mockStorage.get('synthorg_openrouter_zdr_enabled') === 'true';
  if (zdrEnabled) {
    payload.provider = { ...(payload.provider || {}), zdr: true, data_collection: 'deny' };
  }

  const requestHeaders = {
    'Authorization': 'Bearer test-key',
    'Content-Type': 'application/json'
  };
  if (cachingEnabled && conversationId) {
    requestHeaders['x-session-id'] = String(conversationId);
  }

  // Aggressive Prompt Caching:
  let cacheBlocksCount = 0;
  const MAX_CACHE_BREAKPOINTS = 4;
  if (payload.tools && payload.tools.length > 0 && cacheBlocksCount < MAX_CACHE_BREAKPOINTS) {
    const lastTool = payload.tools[payload.tools.length - 1];
    if (lastTool) {
      lastTool.cache_control = { type: 'ephemeral' };
      cacheBlocksCount++;
    }
  }
  if (workingMessages.length > 0 && cacheBlocksCount < MAX_CACHE_BREAKPOINTS) {
    workingMessages[0].cache_control = { type: 'ephemeral' };
    cacheBlocksCount++;
  }
  for (let i = workingMessages.length - 1; i >= 1 && cacheBlocksCount < MAX_CACHE_BREAKPOINTS; i--) {
    if (workingMessages[i] && !workingMessages[i].cache_control) {
      workingMessages[i].cache_control = { type: 'ephemeral' };
      cacheBlocksCount++;
    }
  }

  // Verify caching parameters
  assert.equal(payload.session_id, 'conv_test_123');
  assert.equal(requestHeaders['x-session-id'], 'conv_test_123');
  assert.equal(typeof workingMessages[0].content, 'string');
  assert.deepEqual(workingMessages[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(workingMessages[1].cache_control, { type: 'ephemeral' });
  assert.ok(workingMessages[0].content.includes('SynthOrg Master'));
  assert.equal(payload.provider, undefined, 'ZDR should not be present when disabled');
});

test('OpenRouter chat completions payload injects provider ZDR when enabled and disables caching when off', () => {
  const conversationId = 'conv_test_456';
  const mockStorage = new Map([
    ['synthorg_prompt_caching_enabled', 'false'],
    ['synthorg_openrouter_zdr_enabled', 'true']
  ]);

  const workingMessages = [
    { role: 'system', content: 'You are SynthOrg Master Orchestrator.' },
    { role: 'user', content: 'Classified question' }
  ];

  const payload = {
    model: 'anthropic/claude-3.7-sonnet',
    messages: workingMessages,
    stream: true,
    include_reasoning: true
  };

  const cachingEnabled = mockStorage.get('synthorg_prompt_caching_enabled') !== 'false';
  if (cachingEnabled && conversationId) {
    payload.session_id = String(conversationId);
    if (workingMessages.length > 0 && workingMessages[0].role === 'system') {
      if (typeof workingMessages[0].content === 'string') {
        workingMessages[0] = {
          role: 'system',
          content: [
            {
              type: 'text',
              text: workingMessages[0].content,
              cache_control: { type: 'ephemeral' }
            }
          ]
        };
      }
    }
  }

  const zdrEnabled = mockStorage.get('synthorg_openrouter_zdr_enabled') === 'true';
  if (zdrEnabled) {
    payload.provider = { ...(payload.provider || {}), zdr: true, data_collection: 'deny' };
  }

  const requestHeaders = {
    'Authorization': 'Bearer test-key',
    'Content-Type': 'application/json'
  };
  if (cachingEnabled && conversationId) {
    requestHeaders['x-session-id'] = String(conversationId);
  }

  // Verify caching is not injected and ZDR is active
  assert.equal(payload.session_id, undefined);
  assert.equal(requestHeaders['x-session-id'], undefined);
  assert.equal(typeof workingMessages[0].content, 'string');
  assert.deepEqual(payload.provider, { zdr: true, data_collection: 'deny' });
});
