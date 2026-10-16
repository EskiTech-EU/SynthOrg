'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('buildActiveToolSpecs generates dynamic tool schemas and prompt section from registry', () => {
  // Load the catalog source
  const catalogCode = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'catalog.js'), 'utf8');
  const operationalCode = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'operational.js'), 'utf8');

  const mockStorage = new Map();
  const sandbox = {
    window: {},
    localStorage: {
      getItem: (k) => mockStorage.get(k) || null,
      setItem: (k, v) => mockStorage.set(k, String(v)),
      removeItem: (k) => mockStorage.delete(k)
    },
    fetch: async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ data: [
        {
          id: 'anthropic/claude-3.7-sonnet',
          name: 'Claude 3.7 Sonnet',
          context_length: 200000,
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
          supported_parameters: ['tools', 'tool_choice', 'reasoning'],
          pricing: { prompt: '0.000003', completion: '0.000015' }
        },
        {
          id: 'perplexity/sonar-pro',
          name: 'Sonar Pro',
          context_length: 127000,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          supported_parameters: ['tools'],
          pricing: { prompt: '0.000001', completion: '0.000001' }
        },
        {
          id: 'black-forest-labs/flux-1.1-pro-ultra',
          name: 'FLUX 1.1 Pro Ultra',
          context_length: 4096,
          architecture: { input_modalities: ['text'], output_modalities: ['image'] },
          supported_parameters: [],
          pricing: { prompt: '0', completion: '0.04' }
        },
        {
          id: 'google/veo-3.1',
          name: 'Google Veo 3.1',
          context_length: 4096,
          architecture: { input_modalities: ['text'], output_modalities: ['video'] },
          supported_parameters: [],
          pricing: { prompt: '0', completion: '0.05' }
        }
      ]})
    }),
    console,
    Boolean
  };

  vm.createContext(sandbox);
  vm.runInContext(catalogCode, sandbox);
  vm.runInContext('window.openRouterCatalog = new OpenRouterCatalog();', sandbox);

  // Fetch models to populate catalog
  const catalogPromise = sandbox.window.openRouterCatalog.fetchModels();

  return catalogPromise.then(() => {
    // Now run operational.js
    vm.runInContext(operationalCode, sandbox);
    const registry = sandbox.window.operationalRegistry;

    assert.ok(registry, 'OperationalRegistry should be created');
    assert.ok(typeof registry.buildActiveToolSpecs === 'function', 'buildActiveToolSpecs should exist');

    // === Test 1: With no delegates configured, only native engine tools should appear ===
    const specs1 = registry.buildActiveToolSpecs();

    // web_search is a native engine → always present
    const webTool = specs1.tools.find(t => t.function.name === 'web_search');
    assert.ok(webTool, 'web_search should be in tools as a native engine');
    assert.equal(webTool.function.parameters.required[0], 'query', 'web_search should require query param');

    // text_to_image should NOT be present (no delegate configured)
    const imgTool = specs1.tools.find(t => t.function.name === 'text_to_image');
    assert.equal(imgTool, undefined, 'text_to_image should NOT appear without a delegate configured');

    // Since master (Claude) has vision, image_inspection should be in promptSection as "natively covered"
    assert.ok(
      specs1.promptSection.includes('image_inspection') || specs1.promptSection === '',
      'If master has vision, image_inspection should be mentioned as native in promptSection (or section empty if no active tools)'
    );

    // === Test 2: Assign a delegate for text_to_image → should now appear in tools ===
    registry.setToolDelegate('text_to_image', 'black-forest-labs/flux-1.1-pro-ultra');
    const specs2 = registry.buildActiveToolSpecs();

    const imgTool2 = specs2.tools.find(t => t.function.name === 'text_to_image');
    assert.ok(imgTool2, 'text_to_image should appear after assigning a delegate');
    assert.equal(imgTool2.function.parameters.required[0], 'prompt', 'text_to_image should require prompt param');
    assert.ok(imgTool2.function.parameters.properties.style, 'text_to_image should have optional style param');

    // toolMeta should have the delegate model
    assert.ok(specs2.toolMeta.has('text_to_image'), 'toolMeta should contain text_to_image');
    assert.equal(specs2.toolMeta.get('text_to_image').delegateModelId, 'black-forest-labs/flux-1.1-pro-ultra');

    // promptSection should mention the delegate
    assert.ok(specs2.promptSection.includes('FLUX'), 'Prompt section should mention delegate model name');

    // === Test 3: Assign delegate for text_to_video → video tool should appear ===
    registry.setToolDelegate('text_to_video', 'google/veo-3.1');
    const specs3 = registry.buildActiveToolSpecs();

    const vidTool = specs3.tools.find(t => t.function.name === 'text_to_video');
    assert.ok(vidTool, 'text_to_video should appear after assigning delegate');
    assert.ok(vidTool.function.parameters.properties.duration, 'text_to_video should have duration param');
    assert.equal(specs3.toolMeta.get('text_to_video').delegateModelId, 'google/veo-3.1');

    // === Test 4: Assign model_search delegate → should appear ===
    registry.setToolDelegate('model_search', 'perplexity/sonar-pro');
    const specs4 = registry.buildActiveToolSpecs();
    const searchTool = specs4.tools.find(t => t.function.name === 'model_search');
    assert.ok(searchTool, 'model_search should appear after assigning delegate');
    assert.equal(specs4.toolMeta.get('model_search').delegateModelId, 'perplexity/sonar-pro');
    assert.equal(specs4.toolMeta.get('model_search').requiresInternet, true, 'model_search requires internet');

    // === Test 4b: delegated reasoning on auto is the main model itself, in a clean session ===
    const master = registry.getCurrentMasterModel();
    assert.ok(master.hasReasoning, 'the test master reasons');
    const thinker = registry.buildActiveToolSpecs();
    const thinkerTool = thinker.tools.find(t => t.function.name === 'thinking_solver');
    assert.ok(thinkerTool, 'on auto, with a master that reasons, the tool is offered');
    assert.equal(JSON.stringify(thinkerTool.function.parameters.required), JSON.stringify(['problem']));
    assert.equal(thinker.toolMeta.get('thinking_solver').delegateModelId, master.id, 'its delegate is the master itself');
    assert.ok(/Sessione pulita di te stesso/.test(thinker.promptSection), 'the model is told the session is its own, without the conversation');
    // a master that does not reason: nothing to gain from a clean session of itself
    const reasoning = master.hasReasoning;
    master.hasReasoning = false;
    assert.equal(registry.buildActiveToolSpecs().tools.find(t => t.function.name === 'thinking_solver'), undefined, 'not offered when the master does not reason');
    master.hasReasoning = reasoning;
    // an explicit model still wins over auto
    registry.setToolDelegate('thinking_solver', 'perplexity/sonar-pro');
    assert.equal(registry.buildActiveToolSpecs().toolMeta.get('thinking_solver').delegateModelId, 'perplexity/sonar-pro');
    registry.setToolDelegate('thinking_solver', 'auto');

    // === Test 5: ioToSchema static method ===
    const imgSchema = registry.constructor.ioToSchema('text -> image', 'text_to_image');
    assert.ok(imgSchema.properties.prompt, 'Image schema should have prompt');
    assert.ok(imgSchema.properties.style, 'Image schema should have style');

    const vidSchema = registry.constructor.ioToSchema('text -> video', 'text_to_video');
    assert.ok(vidSchema.properties.prompt, 'Video schema should have prompt');
    assert.ok(vidSchema.properties.duration, 'Video schema should have duration');

    const ttsSchema = registry.constructor.ioToSchema('text -> speech', 'voice_synthesis');
    assert.ok(ttsSchema.properties.text, 'TTS schema should have text');
    assert.ok(ttsSchema.properties.voice, 'TTS schema should have voice');

    const sttSchema = registry.constructor.ioToSchema('audio -> transcription', 'audio_transcription');
    assert.ok(sttSchema.properties.audio_url, 'STT schema should have audio_url');

    const fallback = registry.constructor.ioToSchema('unknown_sig', 'unknown_tool');
    assert.ok(fallback.properties.prompt, 'Fallback schema should have generic prompt');

    // === Test 6: Remove delegate → tool disappears ===
    registry.setToolDelegate('text_to_image', null);
    const specs5 = registry.buildActiveToolSpecs();
    const removedTool = specs5.tools.find(t => t.function.name === 'text_to_image');
    assert.equal(removedTool, undefined, 'text_to_image should disappear after removing delegate');
  });
});
