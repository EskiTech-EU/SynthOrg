'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('OpenRouterCatalog fetches and merges specialized modalities (transcription, speech, image, video)', async () => {
  const code = fs.readFileSync(path.join(__dirname, '../resources/js/catalog.js'), 'utf8');

  const mockStorage = new Map();
  const mockEndpointsData = {
    'https://openrouter.ai/api/v1/models': [
      {
        id: 'google/gemini-2.5-flash',
        name: 'Google: Gemini 2.5 Flash',
        architecture: {
          input_modalities: ['text', 'image', 'audio'],
          output_modalities: ['text']
        },
        supported_parameters: ['tools']
      }
    ],
    'https://openrouter.ai/api/v1/models?output_modalities=transcription': [
      {
        id: 'openai/whisper-1',
        name: 'OpenAI: Whisper 1',
        architecture: {
          input_modalities: ['audio'],
          output_modalities: ['transcription']
        },
        pricing: { prompt: '0.006', completion: '0' }
      },
      {
        id: 'google/chirp-3',
        name: 'Google: Chirp 3',
        architecture: {
          input_modalities: ['audio'],
          output_modalities: ['transcription']
        }
      }
    ],
    'https://openrouter.ai/api/v1/models?output_modalities=speech': [
      {
        id: 'google/gemini-3.1-flash-tts-preview',
        name: 'Google: Gemini 3.1 Flash TTS Preview',
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['speech']
        }
      }
    ],
    'https://openrouter.ai/api/v1/models?output_modalities=image': [
      {
        id: 'recraft/recraft-v4',
        name: 'Recraft: Recraft V4',
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['image']
        }
      }
    ],
    'https://openrouter.ai/api/v1/models?output_modalities=video': [
      {
        id: 'google/veo-3.1',
        name: 'Google: Veo 3.1',
        architecture: {
          input_modalities: ['text', 'image'],
          output_modalities: ['video']
        }
      }
    ]
  };

  const sandbox = {
    window: {},
    localStorage: {
      getItem: (k) => mockStorage.get(k) || null,
      setItem: (k, v) => mockStorage.set(k, String(v)),
      removeItem: (k) => mockStorage.delete(k)
    },
    fetch: async (url) => {
      const data = mockEndpointsData[url] || [];
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data })
      };
    },
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  vm.runInContext('window.openRouterCatalog = new OpenRouterCatalog();', sandbox);

  const catalog = sandbox.window.openRouterCatalog;
  const models = await catalog.fetchModels(true);

  assert.equal(models.length, 6, 'Must merge all 6 models from all endpoints');

  const whisper = models.find(m => m.id === 'openai/whisper-1');
  assert.ok(whisper, 'openai/whisper-1 must be present in catalog');
  assert.equal(whisper.hasAudioIn, true, 'Whisper must have hasAudioIn');
  assert.equal(whisper.hasTranscriptionOut, true, 'Whisper must have hasTranscriptionOut');

  const chirp = models.find(m => m.id === 'google/chirp-3');
  assert.ok(chirp, 'google/chirp-3 must be present in catalog');

  const geminiTts = models.find(m => m.id === 'google/gemini-3.1-flash-tts-preview');
  assert.ok(geminiTts, 'google/gemini-3.1-flash-tts-preview must be present in catalog');
  assert.equal(geminiTts.hasAudioOut, true, 'Gemini TTS must have hasAudioOut = true');

  const recraft = models.find(m => m.id === 'recraft/recraft-v4');
  assert.ok(recraft, 'Recraft image model must be present');
  assert.equal(recraft.hasImageOut, true);

  const veo = models.find(m => m.id === 'google/veo-3.1');
  assert.ok(veo, 'Google Veo video model must be present');
  assert.equal(veo.hasVideoIn, false);
});
