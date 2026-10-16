'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Operational suites separate Music (Lyria) from Voice Synthesis (TTS) and support granular native check', () => {
  const code = fs.readFileSync(path.join(__dirname, '../resources/js/operational.js'), 'utf8');

  const mockStorage = new Map();
  const mockCatalog = {
    models: [
      {
        id: 'google/gemini-2.5-flash',
        name: 'Google: Gemini 2.5 Flash',
        description: 'Multimodal model with audio and video inputs.',
        inputModalities: ['text', 'image', 'audio', 'video'],
        outputModalities: ['text'],
        hasAudioIn: true,
        hasAudioOut: false,
        hasTools: true,
        hasReasoning: false,
        pricing: { promptPerM: 0.15, completionPerM: 0.6 }
      },
      {
        id: 'openai/gpt-audio',
        name: 'OpenAI: GPT-4o Audio',
        description: 'Omni model with native spoken voice output.',
        inputModalities: ['text', 'audio'],
        outputModalities: ['text', 'audio'],
        hasAudioIn: true,
        hasAudioOut: true,
        hasTools: true,
        pricing: { promptPerM: 2.5, completionPerM: 10.0 }
      },
      {
        id: 'openai/whisper-1',
        name: 'OpenAI: Whisper 1',
        description: 'Automatic speech recognition model.',
        inputModalities: ['audio'],
        outputModalities: ['transcription'],
        hasAudioIn: true,
        hasAudioOut: false,
        hasTranscriptionOut: true,
        hasTools: false,
        pricing: { promptPerM: 6.0, completionPerM: 0 }
      },
      {
        id: 'google/lyria-3-pro-preview',
        name: 'Google: Lyria 3 Pro Preview',
        description: 'Music and sound generation model capable of creating songs from prompts.',
        inputModalities: ['text', 'image'],
        outputModalities: ['audio', 'text'],
        hasAudioIn: false,
        hasAudioOut: true,
        hasTools: false,
        pricing: { promptPerM: 5.0, completionPerM: 20.0 }
      },
      {
        id: 'black-forest-labs/flux-1-schnell',
        name: 'Black Forest Labs: FLUX.1 Schnell',
        description: 'Fast text-to-image foundation model.',
        inputModalities: ['text'],
        outputModalities: ['image'],
        hasAudioIn: false,
        hasAudioOut: false,
        hasImageOut: true,
        hasTools: false,
        pricing: { promptPerM: 0.003, completionPerM: 0 }
      },
      {
        id: 'openai/tts-1',
        name: 'OpenAI: TTS-1',
        description: 'Text-to-speech voice generation model.',
        inputModalities: ['text'],
        outputModalities: ['speech'],
        hasAudioIn: false,
        hasAudioOut: true,
        hasTools: false,
        pricing: { promptPerM: 15.0, completionPerM: 0 }
      }
    ],
    getCategoriesHierarchy: () => ({})
  };

  const sandbox = {
    window: {
      openRouterCatalog: mockCatalog
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

  const registry = sandbox.window.operationalRegistry;
  assert.ok(registry, 'operationalRegistry must be defined on window');

  // Verify suites
  const musicSuite = registry.roles.find(r => r.id === 'music_suite');
  assert.ok(musicSuite, 'music_suite category must exist');
  assert.equal(musicSuite.name, 'Music & Audio Generation');

  const musicTool = musicSuite.tools.find(t => t.id === 'music_generation');
  assert.ok(musicTool, 'music_generation tool must exist in music_suite');

  const audioSuite = registry.roles.find(r => r.id === 'audio_suite');
  assert.ok(audioSuite, 'audio_suite category must exist');

  const ttsTool = audioSuite.tools.find(t => t.id === 'voice_synthesis');
  assert.ok(ttsTool, 'voice_synthesis tool must exist in audio_suite');

  const sttTool = audioSuite.tools.find(t => t.id === 'audio_transcription');
  assert.ok(sttTool, 'audio_transcription tool must exist in audio_suite');

  // Verify filtering
  const lyriaModel = mockCatalog.models.find(m => m.id === 'google/lyria-3-pro-preview');
  const gptAudioModel = mockCatalog.models.find(m => m.id === 'openai/gpt-audio');
  const geminiModel = mockCatalog.models.find(m => m.id === 'google/gemini-2.5-flash');
  const whisperModel = mockCatalog.models.find(m => m.id === 'openai/whisper-1');

  // Lyria must be in music_generation and NOT in voice_synthesis
  assert.equal(musicTool.filter(lyriaModel), true, 'Lyria must match music_generation');
  assert.equal(ttsTool.filter(lyriaModel), false, 'Lyria must NOT match voice_synthesis');

  // Spoken voice model must be in voice_synthesis and NOT in music_generation
  assert.equal(ttsTool.filter(gptAudioModel), true, 'GPT-Audio must match voice_synthesis');
  assert.equal(musicTool.filter(gptAudioModel), false, 'GPT-Audio must NOT match music_generation');

  // Pure STT (Whisper) must match STT; General text LLM (Gemini Flash) must NOT pollute the STT delegate list
  assert.equal(sttTool.filter(whisperModel), true, 'Whisper 1 must match audio_transcription (STT)');
  assert.equal(sttTool.filter(geminiModel), false, 'General text LLM must NOT be in pure STT tool list');

  // Test granular native coverage when Gemini Flash is Master
  registry.setSelectedMasterId('google/gemini-2.5-flash');
  const evaluated = registry.evaluateRoles();

  const evalAudioSuite = evaluated.find(r => r.id === 'audio_suite');
  const evalStt = evalAudioSuite.tools.find(t => t.id === 'audio_transcription');
  const evalTts = evalAudioSuite.tools.find(t => t.id === 'voice_synthesis');

  const evalMusicSuite = evaluated.find(r => r.id === 'music_suite');
  const evalMusic = evalMusicSuite.tools.find(t => t.id === 'music_generation');

  assert.equal(evalStt.isMasterNative, true, 'Gemini Master has audioIn, so STT is master native (no STT tool required)');
  assert.equal(evalTts.isMasterNative, false, 'Gemini Master does NOT have spoken audioOut, so TTS is NOT master native');
  assert.equal(evalMusic.isMasterNative, false, 'Gemini Master is not Lyria/music, so Music Generation is NOT master native');

  // Verify Master Orchestrator eligibility: specialized audio/music models must NEVER be eligible
  assert.equal(registry.isMasterEligible(geminiModel), true, 'Gemini Flash text LLM must be eligible for Master');
  assert.equal(registry.isMasterEligible(gptAudioModel), false, 'GPT-Audio must NOT be eligible for Master Orchestrator');
  assert.equal(registry.isMasterEligible(lyriaModel), false, 'Lyria music model must NOT be eligible for Master Orchestrator');
  assert.equal(registry.isMasterEligible(whisperModel), false, 'Whisper STT model must NOT be eligible for Master Orchestrator');

  const evalMaster = evaluated.find(r => r.id === 'primary_master');
  assert.ok(evalMaster, 'primary_master must exist');
  assert.equal(evalMaster.models.some(m => m.id === 'openai/gpt-audio'), false, 'GPT-Audio must be excluded from master eligible models');
  assert.equal(evalMaster.models.some(m => m.id === 'google/lyria-3-pro-preview'), false, 'Lyria must be excluded from master eligible models');
  assert.equal(evalMaster.models.some(m => m.id === 'google/gemini-2.5-flash'), true, 'Gemini Flash must be in master eligible models');

  // Setting an audio model as Master must be rejected
  const setResult = registry.setSelectedMasterId('openai/gpt-audio');
  assert.equal(setResult, false, 'Setting specialized audio model as Master must be rejected');
  assert.equal(registry.getSelectedMasterId(), 'google/gemini-2.5-flash', 'Master ID must remain unchanged');

  // Verify video suite
  const videoSuite = registry.roles.find(r => r.id === 'video_generation');
  assert.ok(videoSuite, 'video_generation category must exist');
  assert.equal(videoSuite.name, 'Video Generation Suite');

  const textToVideo = videoSuite.tools.find(t => t.id === 'text_to_video');
  assert.ok(textToVideo, 'text_to_video tool must exist in video_generation');

  const imageToVideo = videoSuite.tools.find(t => t.id === 'image_to_video');
  assert.ok(imageToVideo, 'image_to_video tool must exist in video_generation');

  // Verify realtime suite is excluded from tools (it belongs to a separate dedicated live section)
  const realtimeSuite = registry.roles.find(r => r.id === 'realtime_suite');
  assert.equal(realtimeSuite, undefined, 'realtime_suite must not be a tool category');

  const fastRouterSuite = registry.roles.find(r => r.id === 'fast_router');
  assert.equal(fastRouterSuite, undefined, 'fast_router must not be a tool category');

  // Test getAllConfigurableItems includes music_generation and video tools
  const allItems = registry.getAllConfigurableItems();
  const musicItem = allItems.find(i => i.id === 'music_generation');
  assert.ok(musicItem, 'music_generation should be listed in configurable items');
  assert.equal(musicItem.group, 'Music & Audio Generation');

  const t2vItem = allItems.find(i => i.id === 'text_to_video');
  assert.ok(t2vItem, 'text_to_video should be listed in configurable items');
  assert.equal(t2vItem.group, 'Video Generation Suite');

  const i2vItem = allItems.find(i => i.id === 'image_to_video');
  assert.ok(i2vItem, 'image_to_video should be listed in configurable items');
  assert.equal(i2vItem.group, 'Video Generation Suite');

  const rtSpeechItem = allItems.find(i => i.id === 'realtime_speech');
  assert.equal(rtSpeechItem, undefined, 'realtime_speech must not be in configurable tools');

  // Verify Microtask and Realtime are listed under Regia Centrale in configurable items
  const masterItem = allItems.find(i => i.id === 'master');
  assert.ok(masterItem, 'master should be listed in configurable items');
  assert.equal(masterItem.type, 'master');

  const microtaskItem = allItems.find(i => i.id === 'microtask');
  assert.ok(microtaskItem, 'microtask should be listed in configurable items');
  assert.equal(microtaskItem.group, 'Regia Centrale');
  assert.equal(microtaskItem.type, 'microtask');
  assert.equal(microtaskItem.eligibleModels.some(m => m.id === 'google/gemini-2.5-flash'), true);
  assert.equal(microtaskItem.eligibleModels.some(m => m.id === 'openai/gpt-audio'), false);

  // The Realtime Voice role was removed (2026-09-25): the character listens with
  // Realtime Multi and speaks with the speech-synthesis role.
  assert.equal(allItems.some(i => i.id === 'realtime'), false, 'the old Realtime Voice role is gone');

  // Verify Realtime Multi (Vision + Audio) is listed under Regia Centrale
  const realtimeMultiItem = allItems.find(i => i.id === 'realtime_multi');
  assert.ok(realtimeMultiItem, 'realtime_multi should be listed in configurable items');
  assert.equal(realtimeMultiItem.group, 'Regia Centrale');
  assert.equal(realtimeMultiItem.type, 'realtime_multi');
  assert.equal(realtimeMultiItem.eligibleModels.some(m => m.id === 'google/gemini-2.5-flash'), true, 'Gemini Flash (audio+vision) must be in Realtime Multi');
  assert.equal(realtimeMultiItem.eligibleModels.some(m => m.id === 'openai/gpt-audio'), false, 'GPT-Audio (no vision) must NOT be in Realtime Multi');
  assert.equal(realtimeMultiItem.eligibleModels.some(m => m.id === 'black-forest-labs/flux-1-schnell'), false, 'Flux must NOT be in Realtime Multi');
  assert.equal(realtimeMultiItem.eligibleModels.some(m => m.id === 'openai/tts-1'), false, 'TTS must NOT be in Realtime Multi');

  // Test Microtask, Realtime and Realtime Multi selection & persistence
  registry.setSelectedMicrotaskId('google/gemini-2.5-flash');
  assert.equal(registry.getSelectedMicrotaskId(), 'google/gemini-2.5-flash');
  assert.equal(registry.getCurrentMicrotaskModel()?.id, 'google/gemini-2.5-flash');


  registry.setSelectedRealtimeMultiId('google/gemini-2.5-flash');
  assert.equal(registry.getSelectedRealtimeMultiId(), 'google/gemini-2.5-flash');
  assert.equal(registry.getCurrentRealtimeMultiModel()?.id, 'google/gemini-2.5-flash');

  // Safety / guardrail models must be excluded from master, microtask, realtime, and delegates
  const safetyModel = {
    id: 'nvidia/nemotron-3.5-content-safety:free',
    name: 'NVIDIA: Nemotron 3.5 Content Safety',
    description: 'Content safety classifier for LLM guardrails.',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    hasVision: true,
    hasTools: false
  };
  assert.equal(sandbox.window.OperationalRegistry.isSafetyOrGuardModel(safetyModel), true);
  assert.equal(registry.isMasterEligible(safetyModel), false);
  assert.equal(registry.isMicrotaskEligible(safetyModel), false);
  assert.equal(registry.isRealtimeMultiEligible(safetyModel), false);

  // If a delegate was stored as a safety model, getToolDelegate returns 'auto'
  registry.setToolDelegate('image_inspection', 'nvidia/nemotron-3.5-content-safety:free');
  assert.equal(registry.getToolDelegate('image_inspection'), 'auto');
});

test('The Realtime role accepts every model the Master accepts, as well as those that hear and see', () => {
  const code = fs.readFileSync(path.join(__dirname, '../resources/js/operational.js'), 'utf8');
  const textOnly = { id: 'anthropic/claude-haiku', name: 'Anthropic: Claude Haiku', description: 'Fast text model.', inputModalities: ['text'], outputModalities: ['text'], contextLength: 200000, hasTools: true, pricing: { promptPerM: 1, completionPerM: 5 } };
  const omni = { id: 'google/gemini-2.5-flash', name: 'Google: Gemini 2.5 Flash', description: 'Multimodal model with audio and video inputs.', inputModalities: ['text', 'image', 'audio', 'video'], outputModalities: ['text'], hasAudioIn: true, hasTools: true, pricing: { promptPerM: 0.15, completionPerM: 0.6 } };
  const voice = { id: 'openai/tts-1', name: 'OpenAI: TTS-1', description: 'Text-to-speech voice generation model.', inputModalities: ['text'], outputModalities: ['speech'], hasAudioOut: true, pricing: { promptPerM: 15, completionPerM: 0 } };
  const storage = new Map();
  const sandbox = {
    window: { openRouterCatalog: { models: [textOnly, omni, voice], getCategoriesHierarchy: () => ({}) } },
    localStorage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const registry = sandbox.window.operationalRegistry;
  const item = registry.getAllConfigurableItems().find(i => i.id === 'realtime_multi');
  const ids = item.eligibleModels.map(m => m.id);
  assert.equal(registry.isMasterEligible(textOnly), true);
  assert.ok(ids.includes('anthropic/claude-haiku'), 'a text model the Master accepts is accepted');
  assert.ok(ids.includes('google/gemini-2.5-flash'), 'a model that hears and sees is still accepted');
  assert.equal(ids.includes('openai/tts-1'), false, 'a voice model is not');
  registry.setSelectedRealtimeMultiId('anthropic/claude-haiku');
  assert.equal(registry.getCurrentRealtimeMultiModel()?.id, 'anthropic/claude-haiku');
});
