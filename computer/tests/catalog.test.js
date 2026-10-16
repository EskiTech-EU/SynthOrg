'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('OpenRouterCatalog fetchModels parses models correctly and sets capabilities', async () => {
  const code = fs.readFileSync(path.join(__dirname, '../resources/js/catalog.js'), 'utf8');

  const mockStorage = new Map();
  const mockModelsData = [
    {
      id: 'anthropic/claude-3.7-sonnet',
      name: 'Claude 3.7 Sonnet',
      description: 'Hybrid reasoning and instant model.',
      context_length: 200000,
      architecture: {
        input_modalities: ['text', 'image'],
        output_modalities: ['text']
      },
      supported_parameters: ['tools', 'tool_choice', 'reasoning'],
      pricing: {
        prompt: '0.000003',
        completion: '0.000015'
      }
    },
    {
      id: 'openrouter/auto',
      name: 'Auto (Best for Prompt)',
      description: 'Automatically routes to the best model.',
      context_length: 128000,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text']
      },
      supported_parameters: ['tools'],
      pricing: { prompt: '-1', completion: '-1' }
    },
    {
      id: 'openrouter/fusion',
      name: 'Fusion (Multi-Model)',
      description: 'Multi-model deliberation meta-endpoint.',
      context_length: 128000,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text']
      },
      supported_parameters: ['tools'],
      pricing: { prompt: '-1', completion: '-1' }
    },
    {
      id: 'openrouter/bodybuilder',
      name: 'Bodybuilder',
      description: 'Experimental meta-model.',
      context_length: 128000,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text']
      },
      supported_parameters: ['tools'],
      pricing: { prompt: '-1', completion: '-1' }
    },
    {
      id: 'perplexity/sonar',
      name: 'Perplexity: Sonar',
      description: 'Search-grounded model.',
      context_length: 127000,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text']
      },
      supported_parameters: ['tools'],
      pricing: { prompt: '0.000001', completion: '0.000001' }
    },
    {
      id: 'openai/gpt-6-astra',
      name: 'OpenAI: GPT-6 Astra',
      description: 'GPT-6 Astra is OpenAI flagship model for deep research and engineering.',
      context_length: 1000000,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text']
      },
      supported_parameters: ['tools', 'reasoning'],
      pricing: { prompt: '0.00001', completion: '0.00005' }
    }
  ];

  const sandbox = {
    window: {},
    localStorage: {
      getItem: (k) => mockStorage.get(k) || null,
      setItem: (k, v) => mockStorage.set(k, String(v)),
      removeItem: (k) => mockStorage.delete(k)
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: mockModelsData })
    }),
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  vm.runInContext('window.openRouterCatalog = new OpenRouterCatalog();', sandbox);

  const catalog = sandbox.window.openRouterCatalog;
  assert.ok(catalog, 'OpenRouterCatalog should be created');

  const models = await catalog.fetchModels();
  assert.equal(models.length, 3, 'Should fetch 3 models and exclude auto, fusion, bodybuilder');

  const claude = models.find(m => m.id === 'anthropic/claude-3.7-sonnet');
  assert.ok(claude, 'Claude should be present');
  assert.equal(claude.hasTools, true, 'Claude should have tools flag true');
  assert.equal(claude.hasVision, true, 'Claude should have vision flag true');
  assert.equal(claude.hasReasoning, true, 'Claude should have reasoning flag true');
  assert.equal(claude.hasWebSearch, false, 'Claude should NOT be a dedicated web search engine');
  assert.equal(claude.contextLength, 200000);

  assert.equal(models.find(m => m.id === 'openrouter/auto'), undefined, 'Auto router must be excluded');
  assert.equal(models.find(m => m.id === 'openrouter/fusion'), undefined, 'Fusion must be excluded');
  assert.equal(models.find(m => m.id === 'openrouter/bodybuilder'), undefined, 'Bodybuilder must be excluded');

  const sonar = models.find(m => m.id === 'perplexity/sonar');
  assert.ok(sonar, 'Sonar should be present');
  assert.equal(sonar.hasWebSearch, true, 'Sonar MUST be recognized as web search specialist');

  const astra = models.find(m => m.id === 'openai/gpt-6-astra');
  assert.ok(astra, 'Astra should be present');
  assert.equal(astra.hasWebSearch, false, 'Astra must NOT be recognized as web search specialist despite description word research');
});

test('the queued twins OpenRouter lists apart become a property of the model they belong to', async () => {
  const code = fs.readFileSync(path.join(__dirname, '../resources/js/catalog.js'), 'utf8');

  const mockStorage = new Map();
  const mockModelsData = [
    {
      id: 'google/gemini-3.8-flash',
      name: 'Google: Gemini 3.8 Flash',
      context_length: 1000000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'temperature', 'top_p', 'max_tokens'],
      pricing: { prompt: '0.00000075', completion: '0.00000375' }
    },
    {
      // Half the price, and without the two knobs the queue does not take.
      id: 'google/gemini-3.8-flash:batch',
      name: 'Google: Gemini 3.8 Flash (batch)',
      context_length: 1000000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'max_tokens'],
      pricing: { prompt: '0.000000375', completion: '0.000001875' }
    },
    {
      id: 'qwen/qwen3.8',
      name: 'Qwen: Qwen 3.8',
      context_length: 128000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['tools'],
      pricing: { prompt: '0.000001', completion: '0.000002' }
    },
    {
      // Same price queued: there is nothing to offer, so no switch appears.
      id: 'qwen/qwen3.8:batch',
      name: 'Qwen: Qwen 3.8 (batch)',
      context_length: 128000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['tools'],
      pricing: { prompt: '0.000001', completion: '0.000002' }
    }
  ];

  const sandbox = {
    window: {},
    localStorage: {
      getItem: (k) => mockStorage.get(k) || null,
      setItem: (k, v) => mockStorage.set(k, String(v)),
      removeItem: (k) => mockStorage.delete(k)
    },
    fetch: async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ data: mockModelsData }) }),
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  vm.runInContext('window.openRouterCatalog = new OpenRouterCatalog();', sandbox);

  const models = await sandbox.window.openRouterCatalog.fetchModels();

  // The twins are never models of their own.
  assert.equal(models.length, 2, 'only the two real models are listed');
  assert.equal(models.some(m => m.id.endsWith(':batch')), false, 'no ":batch" entry is listed');

  const gemini = models.find(m => m.id === 'google/gemini-3.8-flash');
  assert.ok(gemini.batch, 'the model that has a cheaper twin carries it');
  assert.equal(gemini.batch.id, 'google/gemini-3.8-flash:batch');
  assert.equal(gemini.batch.savingPercent, 50);
  assert.equal(gemini.batch.promptPerM, 0.375);
  assert.equal(gemini.batch.completionPerM, 1.875);
  // What the queue does not take is known here, so it is not sent there.
  assert.equal(gemini.batch.supportedParameters.includes('temperature'), false);
  assert.equal(gemini.batch.supportedParameters.includes('tools'), true);

  const qwen = models.find(m => m.id === 'qwen/qwen3.8');
  assert.equal(qwen.batch, null, 'a twin that saves nothing is not offered');
});
