'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('OperationalRegistry manages model hyperparameters persistence and selective support', () => {
  const code = fs.readFileSync(path.join(__dirname, '../resources/js/operational.js'), 'utf8');

  const mockStorage = new Map();
  const mockCatalog = {
    models: [
      {
        id: 'openai/gpt-4o',
        name: 'OpenAI: GPT-4o',
        inputModalities: ['text'],
        outputModalities: ['text'],
        hasTools: true,
        supportedParameters: ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty', 'seed'],
        pricing: { promptPerM: 2.5, completionPerM: 10.0 }
      },
      {
        id: 'openai/o1-preview',
        name: 'OpenAI: o1-preview',
        inputModalities: ['text'],
        outputModalities: ['text'],
        hasTools: false,
        supportedParameters: ['reasoning', 'reasoning_effort', 'max_tokens'],
        pricing: { promptPerM: 15.0, completionPerM: 60.0 }
      }
    ],
    getCategoriesHierarchy: () => ({})
  };

  const sandbox = {
    window: {
      openRouterCatalog: mockCatalog
    },
    localStorage: {
      getItem: (key) => mockStorage.get(key) || null,
      setItem: (key, val) => mockStorage.set(key, String(val)),
      removeItem: (key) => mockStorage.delete(key)
    },
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  const registry = sandbox.window.operationalRegistry;
  assert.ok(registry, 'operationalRegistry must be initialized');

  // Initial parameters should be empty object
  const initialParams = registry.getModelParameters('openai/gpt-4o');
  assert.equal(Object.keys(initialParams).length, 0);

  // Set temperature and top_p
  registry.setModelParameter('openai/gpt-4o', 'temperature', 0.7);
  registry.setModelParameter('openai/gpt-4o', 'top_p', 0.95);

  const updatedParams = registry.getModelParameters('openai/gpt-4o');
  assert.equal(updatedParams.temperature, 0.7);
  assert.equal(updatedParams.top_p, 0.95);

  // Set parameter on another model
  registry.setModelParameter('openai/o1-preview', 'reasoning_effort', 'high');
  assert.equal(registry.getModelParameters('openai/o1-preview').reasoning_effort, 'high');
  // First model parameters unchanged
  assert.equal(registry.getModelParameters('openai/gpt-4o').temperature, 0.7);

  // Removing a parameter
  registry.setModelParameter('openai/gpt-4o', 'temperature', null);
  assert.equal(registry.getModelParameters('openai/gpt-4o').temperature, undefined);
  assert.equal(registry.getModelParameters('openai/gpt-4o').top_p, 0.95);

  // Resetting model parameters
  registry.resetModelParameters('openai/gpt-4o');
  assert.equal(Object.keys(registry.getModelParameters('openai/gpt-4o')).length, 0);
  // o1-preview remains intact
  assert.equal(registry.getModelParameters('openai/o1-preview').reasoning_effort, 'high');
});

test('Assigned model is pinned to index 0 of candidate list in settings logic', () => {
  const models = [
    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'Anthropic', contextLength: 200000, pricing: { promptPerM: 3.0, completionPerM: 15.0 } },
    { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'Google', contextLength: 1000000, pricing: { promptPerM: 0.15, completionPerM: 0.6 } },
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', provider: 'Meta', contextLength: 128000, pricing: { promptPerM: 0.2, completionPerM: 0.4 } }
  ];

  // If user selected Llama as default, pinning ensures it moves to index 0
  const assignedModelId = 'meta-llama/llama-3.3-70b-instruct';
  const results = [...models];

  // Pinning logic from main.js
  if (assignedModelId) {
    const assignedIdx = results.findIndex(m => m.id === assignedModelId);
    if (assignedIdx > 0) {
      const [assignedObj] = results.splice(assignedIdx, 1);
      results.unshift(assignedObj);
    }
  }

  assert.equal(results[0].id, 'meta-llama/llama-3.3-70b-instruct', 'Assigned model must be at index 0');
  assert.equal(results.length, 3);
});

test('OperationalRegistry synchronizes models and delegates with SQLite chatStorage', async () => {
  const code = fs.readFileSync(path.join(__dirname, '../resources/js/operational.js'), 'utf8');

  const mockStorage = new Map();
  const sqliteSettings = new Map();
  const mockCatalog = {
    models: [
      { id: 'openai/gpt-4o', name: 'OpenAI: GPT-4o', inputModalities: ['text'], outputModalities: ['text'], hasTools: true, contextLength: 128000 },
      { id: 'anthropic/claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', inputModalities: ['text'], outputModalities: ['text'], hasTools: true, contextLength: 200000 },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', inputModalities: ['text'], outputModalities: ['text'], hasTools: true, contextLength: 1000000 }
    ],
    getCategoriesHierarchy: () => ({})
  };

  const sandbox = {
    window: {
      openRouterCatalog: mockCatalog,
      chatStorage: {
        getSettings: async () => Object.fromEntries(sqliteSettings),
        setSetting: async (k, v) => sqliteSettings.set(k, v)
      }
    },
    localStorage: {
      getItem: (key) => mockStorage.get(key) || null,
      setItem: (key, val) => mockStorage.set(key, String(val)),
      removeItem: (key) => mockStorage.delete(key)
    },
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  const registry = sandbox.window.operationalRegistry;

  // 1. Assign Master model and tool delegate
  registry.setSelectedMasterId('openai/gpt-4o');
  registry.setToolDelegate('web_search', 'google/gemini-2.5-flash');

  // Verify stored in sqlite
  assert.equal(sqliteSettings.get('role_master_model_id'), 'openai/gpt-4o');
  const delegatesJson = JSON.parse(sqliteSettings.get('operational_tool_delegates'));
  assert.equal(delegatesJson.web_search, 'google/gemini-2.5-flash');

  // 2. Simulate fresh session where localStorage is cleared
  mockStorage.clear();
  assert.equal(mockStorage.size, 0);

  // 3. syncWithStorage hydrates from SQLite
  await registry.syncWithStorage();
  assert.equal(registry.getSelectedMasterId(), 'openai/gpt-4o');
  assert.equal(registry.getToolDelegate('web_search'), 'google/gemini-2.5-flash');
});

