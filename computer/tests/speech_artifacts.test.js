'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('ChatManager playMessageTTS synthesizes and saves audio file in workspace', async () => {
  const chatCode = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'chat.js'), 'utf8');

  let savedAudio = null;
  let ttsApiCalled = false;
  const domElements = new Map();

  const mockStorage = {
    saveSandboxFile: async (convId, filename, content, encoding) => {
      savedAudio = { convId, filename, content, encoding, url: `/api/conversations/${convId}/sandbox/files/${filename}` };
      return savedAudio;
    }
  };

  const sandbox = {
    window: {
      chatStorage: mockStorage,
      openRouterCatalog: { getApiKey: () => 'test-sk-api-key' },
      operationalRegistry: {
        getToolDelegate: (toolId) => toolId === 'voice_synthesis' ? 'openai/tts-1' : null
      },
      i18n: { t: (k) => k },
      escapeHtml: (s) => s,
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    document: {
      getElementById: (id) => domElements.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    localStorage: { getItem: () => null, setItem: () => null },
    fetch: async (url, opts) => {
      if (url.includes('/audio/speech')) {
        ttsApiCalled = true;
        const fakeMp3 = Buffer.from('FAKE_MP3_AUDIO_STREAM');
        return {
          ok: true,
          arrayBuffer: async () => fakeMp3.buffer
        };
      }
      return { ok: false, status: 404 };
    },
    console,
    AbortSignal,
    // The audio plays from memory as soon as the model gives it.
    atob, Blob,
    URL: { createObjectURL: () => 'blob:tts-test' },
    Audio: class { constructor(src) { this.src = src; this.paused = true; } async play() { played.push(this.src); this.paused = false; this.onplay?.(); } pause() { this.paused = true; this.onpause?.(); } }
  };
  const played = [];

  vm.createContext(sandbox);
  // Same load order as index.html: every request to a model goes through the model gateway.
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'model-gateway.js'), 'utf8'), sandbox);
  vm.runInContext(chatCode, sandbox);

  const cm = sandbox.window.chatManager;
  cm.conversation = { id: 'conv-tts-test' };
  cm.messages = [
    {
      id: 'msg-assistant-1',
      role: 'assistant',
      content: 'Questo è un messaggio di prova per la sintesi vocale TTS con SynthOrg.'
    }
  ];

  // Set up mock DOM container for player
  const playerContainer = { innerHTML: '', querySelector: () => null };
  const ttsButton = { innerHTML: '', classList: { add: () => {}, remove: () => {}, toggle: () => {} } };
  domElements.set('tts-player-container-msg-assistant-1', playerContainer);
  domElements.set('btn-tts-msg-assistant-1', ttsButton);

  await cm.playMessageTTS('msg-assistant-1');

  assert.equal(ttsApiCalled, true, 'Should call /api/v1/audio/speech endpoint');
  assert.ok(savedAudio, 'Audio file should be saved in sandbox workspace');
  assert.equal(savedAudio.convId, 'conv-tts-test');
  assert.ok(savedAudio.filename.startsWith('tts_msg-assi_'));
  assert.ok(savedAudio.filename.endsWith('.mp3'));
  assert.ok(playerContainer.innerHTML.includes('<audio'), 'Inline audio player should be rendered');
  assert.deepEqual(played, ['blob:tts-test'], 'the audio is started, from memory');

  // A message without its row of actions (still being written): read all the same, with no player.
  cm.messages.push({ id: 'msg-assistant-2', role: 'assistant', content: 'Secondo messaggio.', isStreaming: true });
  await cm.playMessageTTS('msg-assistant-2');
  assert.equal(played.length, 2);
  // Asked again while it plays, it stops.
  await cm.playMessageTTS('msg-assistant-2');
  assert.equal(cm._tts.audio.paused, true);
});

test('ChatManager toggleSpeechRecognition handles STT recording state', async () => {
  const chatCode = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'chat.js'), 'utf8');

  const domElements = new Map();
  const sttBtn = {
    classList: {
      classes: new Set(),
      add: function(c) { this.classes.add(c); },
      remove: function(c) { this.classes.delete(c); },
      contains: function(c) { return this.classes.has(c); }
    },
    title: ''
  };
  const chatInput = { value: '', style: {} };
  domElements.set('chat-btn-stt', sttBtn);
  domElements.set('chat-input', chatInput);

  let recognitionStarted = false;
  let recognitionStopped = false;

  class MockSpeechRecognition {
    constructor() {
      this.continuous = false;
      this.interimResults = false;
      this.lang = '';
    }
    start() { recognitionStarted = true; }
    stop() { recognitionStopped = true; }
  }

  const sandbox = {
    window: {
      SpeechRecognition: MockSpeechRecognition,
      i18n: { t: (k) => k },
      escapeHtml: (s) => s,
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    document: {
      getElementById: (id) => domElements.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    navigator: {},
    localStorage: { getItem: () => null, setItem: () => null },
    console,
    AbortSignal
  };

  vm.createContext(sandbox);
  vm.runInContext(chatCode, sandbox);

  const cm = sandbox.window.chatManager;

  // 1. Toggle ON
  await cm.toggleSpeechRecognition();
  assert.equal(cm.isRecordingSTT, true, 'isRecordingSTT should be true');
  assert.ok(sttBtn.classList.contains('is-recording'), 'Button should have is-recording class');
  assert.equal(recognitionStarted, true, 'Recognition should be started');

  // 2. Toggle OFF
  await cm.toggleSpeechRecognition();
  assert.equal(cm.isRecordingSTT, false, 'isRecordingSTT should be false');
  assert.equal(sttBtn.classList.contains('is-recording'), false, 'Button should not have is-recording class');
  assert.equal(recognitionStopped, true, 'Recognition should be stopped');
});
