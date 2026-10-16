'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const TEST_TOKEN = 'synthorg-test-token';

test('Sandbox files API saves and serves media files', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(__dirname, '../.tmp/test-media-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const { createApp } = require('../server/index');
  const { server, store } = createApp({ token: TEST_TOKEN, dbPath, allowedOrigins: () => ['http://127.0.0.1:4319'] });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await new Promise(r => server.close(r));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // 1. Create a conversation
  const conv = store.createConversation('Test Media Chat');
  const convId = conv.id;

  // 2. POST /api/conversations/:id/sandbox/files to save an image
  const sampleB64 = Buffer.from('fake-png-image-content-for-test').toString('base64');
  const postRes = await fetch(`${baseUrl}/api/conversations/${convId}/sandbox/files`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer synthorg-test-token'
    },
    body: JSON.stringify({
      filename: 'test_generated_image.png',
      content: sampleB64,
      encoding: 'base64'
    })
  });

  assert.equal(postRes.status, 200, 'POST sandbox file should return 200');
  const postData = await postRes.json();
  assert.equal(postData.ok, true);
  assert.equal(postData.filename, 'test_generated_image.png');
  assert.ok(postData.url.includes(`/api/conversations/${convId}/sandbox/files/test_generated_image.png`));

  // 3. GET /api/conversations/:id/sandbox/files/:filename to retrieve the image
  const getRes = await fetch(`${baseUrl}/api/conversations/${convId}/sandbox/files/test_generated_image.png`);
  assert.equal(getRes.status, 200, 'GET sandbox file should return 200');
  assert.equal(getRes.headers.get('content-type'), 'image/png');
  const getBuf = await getRes.arrayBuffer();
  assert.equal(Buffer.from(getBuf).toString('utf8'), 'fake-png-image-content-for-test');
});

test('ChatManager delegateToolCall routes to specialized OpenRouter endpoints', async (t) => {
  // Load chat.js into a sandbox context
  const chatJsPath = path.join(__dirname, '../resources/js/chat.js');
  const chatJsCode = fs.readFileSync(chatJsPath, 'utf8');

  const requestedUrls = [];
  const requestedBodies = [];

  const fakeFetch = async (url, opts = {}) => {
    requestedUrls.push(url);
    if (opts.body) {
      try {
        requestedBodies.push(JSON.parse(opts.body));
      } catch {
        requestedBodies.push(opts.body);
      }
    }

    // 1. Image API response
    if (url === 'https://openrouter.ai/api/v1/images') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ b64_json: Buffer.from('sample-image-data').toString('base64'), media_type: 'image/png' }]
        })
      };
    }

    // 2. Video API submit response
    if (url === 'https://openrouter.ai/api/v1/videos') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'job_vid_123',
          polling_url: 'https://openrouter.ai/api/v1/videos/job_vid_123',
          status: 'pending'
        })
      };
    }

    // 2b. Video API polling response
    if (url === 'https://openrouter.ai/api/v1/videos/job_vid_123') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'completed',
          unsigned_urls: ['https://storage.openrouter.ai/output.mp4']
        })
      };
    }

    // 2c. Video file download
    if (url === 'https://storage.openrouter.ai/output.mp4') {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from('sample-mp4-video-bytes')
      };
    }

    // 3. Audio/Speech (TTS) response
    if (url === 'https://openrouter.ai/api/v1/audio/speech') {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from('sample-mp3-speech-bytes')
      };
    }

    // 3b. Transcription (STT) response
    if (url === 'https://openrouter.ai/api/v1/audio/transcriptions') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: 'Trascrizione accurata del file audio.' })
      };
    }

    // 4. Sandbox file download
    if (url.includes('/sandbox/files/')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from('sample-audio-stream-bytes')
      };
    }

    // Default chat/completions response
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'Trascrizione accurata del file audio.' } }]
      })
    };
  };

  const savedFiles = [];
  const fakeChatStorage = {
    saveSandboxFile: async (convId, filename, content, encoding) => {
      savedFiles.push({ convId, filename, content, encoding });
      return {
        ok: true,
        filename,
        url: `/api/conversations/${convId}/sandbox/files/${filename}`
      };
    }
  };

  const sandbox = {
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
      escapeHtml: (s) => String(s || ''),
      chatStorage: fakeChatStorage
    },
    document: {
      addEventListener: () => {},
      getElementById: () => null,
      querySelectorAll: () => []
    },
    fetch: fakeFetch,
    AbortSignal: { timeout: () => undefined },
    AbortController,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    setTimeout: (fn) => setTimeout(fn, 1),
    clearTimeout: () => {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Uint8Array,
    String,
    Buffer
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  // Same load order as index.html: chat completions go through the model gateway.
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../resources/js/model-gateway.js'), 'utf8'), sandbox);
  vm.runInContext(chatJsCode, sandbox);

  const cm = sandbox.window.chatManager;
  assert.ok(cm, 'ChatManager should be initialized');

  // Test 1: Image Generation tool routing
  const tcImg = { id: 'call_img', name: 'text_to_image', status: 'executing' };
  const imgRes = await cm.delegateToolCall(
    'text_to_image',
    { prompt: 'A futuristic workstation', style: 'cinematic concept art' },
    'test-key',
    { delegateModelId: 'black-forest-labs/flux.2-pro', ioSignature: 'text -> image' },
    'conv-123',
    tcImg
  );

  assert.ok(requestedUrls.includes('https://openrouter.ai/api/v1/images'), 'Must call /api/v1/images');
  assert.ok(imgRes.includes('A futuristic workstation'), 'Result must reference the artifact name');
  assert.ok(!imgRes.includes('!['), 'Result must not re-embed markdown (render layer shows it once)');
  assert.ok(tcImg.media?.url.includes('/api/conversations/conv-123/sandbox/files/'), 'tc.media.url must reference the saved file');
  assert.ok(tcImg.media?.filename.includes('a_futuristic_workstation'), 'Filename must be derived from the artifact name');
  assert.equal(tcImg.media?.type, 'image', 'tc.media must have image type');
  assert.equal(tcImg.media?.title, 'A futuristic workstation', 'tc.media must carry the artifact name as title');
  assert.equal(savedFiles.length, 1, 'File must be saved to sandbox');

  // Test 2: Video Generation tool routing
  const tcVid = { id: 'call_vid', name: 'text_to_video', status: 'executing' };
  const vidRes = await cm.delegateToolCall(
    'text_to_video',
    { prompt: 'A cinematic laboratory scene', duration: '5s' },
    'test-key',
    { delegateModelId: 'alibaba/wan-3.0-prime', ioSignature: 'text -> video' },
    'conv-123',
    tcVid
  );

  assert.ok(requestedUrls.includes('https://openrouter.ai/api/v1/videos'), 'Must call /api/v1/videos');
  assert.ok(vidRes.includes('A cinematic laboratory scene'), 'Result must reference the artifact name');
  assert.ok(!vidRes.includes('!['), 'Result must not re-embed markdown (render layer shows it once)');
  assert.equal(tcVid.media?.type, 'video');
  assert.equal(tcVid.media?.title, 'A cinematic laboratory scene', 'tc.media must carry the artifact name as title');

  // Test 3: Voice Synthesis (TTS) tool routing
  const tcTts = { id: 'call_tts', name: 'voice_synthesis', status: 'executing' };
  const ttsRes = await cm.delegateToolCall(
    'voice_synthesis',
    { text: 'Prova sintesi vocale in italiano', voice: 'voce naturale' },
    'test-key',
    { delegateModelId: 'google/gemini-3.1-flash-tts-preview', ioSignature: 'text -> speech' },
    'conv-123',
    tcTts
  );

  assert.ok(requestedUrls.includes('https://openrouter.ai/api/v1/audio/speech'), 'Must call /api/v1/audio/speech');
  assert.ok(ttsRes.includes('Prova sintesi vocale in italiano'), 'Result must reference the artifact name');
  assert.equal(tcTts.media?.type, 'audio');

  // Test 4: renderGeneratedMediaAttachments shows attachment if AI omitted the link
  const dummyMsg = {
    id: 'msg-1',
    content: 'Ecco i risultati delle tue richieste.',
    turns: [
      {
        index: 1,
        toolCalls: [tcImg, tcVid, tcTts]
      }
    ]
  };

  const attachmentsHtml = cm.renderGeneratedMediaAttachments(dummyMsg);
  assert.ok(attachmentsHtml.includes('chat-generated-media-attachments'), 'Must generate attachments container');
  assert.ok(attachmentsHtml.includes(tcImg.media.url), 'Must include image URL');
  assert.ok(attachmentsHtml.includes(tcVid.media.url), 'Must include video URL');
  assert.ok(attachmentsHtml.includes(tcTts.media.url), 'Must include audio URL');

  // If the message already includes the image URL, it should NOT duplicate it
  const msgWithImg = {
    id: 'msg-2',
    content: `Ecco l'immagine: ![Workstation](${tcImg.media.url})`,
    turns: [
      {
        index: 1,
        toolCalls: [tcImg]
      }
    ]
  };
  const attachmentsHtml2 = cm.renderGeneratedMediaAttachments(msgWithImg);
  assert.equal(attachmentsHtml2, '', 'Must not duplicate attachment if already embedded in message');

  // Test 5: formatProviderError formats 404 image download errors cleanly
  const rawNvidia502 = JSON.stringify({
    error: {
      message: 'Provider returned error',
      code: 502,
      metadata: {
        raw: JSON.stringify({
          error: {
            message: "404, message='Not Found', url='https://raw.githubusercontent.com/octocat/Spoon-Knife/main/octocat.png'",
            type: 'InternalServerError',
            code: 500
          }
        }),
        provider_name: 'Nvidia'
      }
    }
  });
  const formattedErr = sandbox.window.formatProviderError(502, rawNvidia502, 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free');
  assert.ok(formattedErr.includes('404 Not Found'));
  assert.ok(formattedErr.includes('https://raw.githubusercontent.com/octocat/Spoon-Knife/main/octocat.png'));
  assert.ok(formattedErr.includes('non è accessibile o non esiste'));

  // Test 6: Audio File Transcription (STT) on workspace file
  const tcStt = { id: 'call_stt', name: 'audio_transcription', status: 'executing' };
  const sttRes = await cm.delegateToolCall(
    'audio_transcription',
    { path: 'meeting.mp3', language: 'it' },
    'test-key',
    { delegateModelId: 'mistralai/voxtral-mini-3b-2507', ioSignature: 'file_path -> text' },
    'conv-123',
    tcStt
  );
  assert.ok(sttRes.includes('Trascrizione del file audio: [meeting.mp3]'));
  assert.ok(sttRes.includes('Trascrizione accurata del file audio.'));
  assert.equal(tcStt.media?.type, 'audio');
  // Transcription models are served on /audio/transcriptions, not chat/completions.
  assert.ok(requestedUrls.includes('https://openrouter.ai/api/v1/audio/transcriptions'), 'Must call /api/v1/audio/transcriptions');
  assert.ok(!requestedUrls.includes('https://openrouter.ai/api/v1/chat/completions'), 'STT must not go through chat/completions');
  const sttBody = requestedBodies.find(b => b && b.model === 'mistralai/voxtral-mini-3b-2507');
  assert.equal(sttBody.input_audio.format, 'mp3');
  assert.equal(sttBody.language, 'it');

  // The voice sent to /audio/speech is one the model has (catalog), never a made-up default.
  sandbox.window.openRouterCatalog = { models: [{ id: 'google/gemini-3.1-flash-tts-preview', outputModalities: ['speech'], raw: { supported_voices: ['Zephyr', 'Kore'] } }] };
  assert.equal(cm.speechVoiceFor('google/gemini-3.1-flash-tts-preview', 'kore'), 'Kore');
  assert.equal(cm.speechVoiceFor('google/gemini-3.1-flash-tts-preview', 'voce naturale'), 'Zephyr');
  assert.equal(cm.audioEndpointFor('google/gemini-3.1-flash-tts-preview', 'chat'), 'speech');
});
