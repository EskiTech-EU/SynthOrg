'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../resources/js/model-gateway.js'), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** An answer that arrives in pieces, as a provider's stream does. */
function stream(pieces, { type = 'text/event-stream', headers = {}, gap = 5, fail = false } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for (const piece of pieces) { await wait(gap); controller.enqueue(typeof piece === 'string' ? encoder.encode(piece) : piece); }
      if (fail) controller.error(new DOMException('Aborted', 'AbortError')); else controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': type, ...headers } });
}
const event = (data) => `data: ${JSON.stringify(data)}\n\n`;

/** The gateway in a page made for the test: a provider that answers what the test says, a service that keeps what is written. */
function page({ answers = [], pending = [], generations = {}, local = false, params = {} } = {}) {
  const written = [];
  const resolved = [];
  const asked = [];
  const timers = [];
  const queue = [...answers];
  const window = {
    chatStorage: {
      request: async (route, method = 'GET', data) => {
        if (route === '/usage' && method === 'POST') { written.push(data); return { id: written.length, waiting: data.cost === null && Boolean(data.generation) }; }
        if (route === '/usage/pending') return pending.filter(row => !resolved.some(done => done.id === row.id));
        if (/^\/usage\/\d+$/.test(route) && method === 'PUT') { resolved.push({ id: Number(route.split('/')[2]), ...data }); return { resolved: true }; }
        if (route === '/local-models/start') return { id: data.id, port: 9999, apiKey: 'k', parallel: 4 };
        throw new Error('unexpected ' + route);
      }
    },
    operationalRegistry: { getModelParameters: () => params },
    openRouterCatalog: { getApiKey: () => 'key', models: [] },
    dispatchEvent() {}
  };
  const sandbox = {
    window, console, Response, ReadableStream, TextDecoder, TextEncoder, AbortSignal, AbortController, DOMException, Date, JSON, Promise, Number, Object, Map,
    // what is asked for later runs when the test says so
    setTimeout: (run, ms) => { timers.push({ run, ms }); return timers.length; }, clearTimeout() {},
    fetch: async (url, options = {}) => {
      asked.push({ url: String(url), options });
      if (String(url).includes('/generation?id=')) {
        const id = decodeURIComponent(String(url).split('id=')[1]);
        return generations[id] ? new Response(JSON.stringify({ data: generations[id] }), { status: 200, headers: { 'Content-Type': 'application/json' } }) : new Response('{}', { status: 404 });
      }
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const settle = async () => { for (let i = 0; i < 40 && !written.length; i++) await wait(5); await wait(10); };
  // what was put off runs now: twice at most, since what is still not known is put off again
  const later = async (rounds = 2) => { for (let i = 0; i < rounds && timers.length; i++) { await timers.shift().run(); await wait(5); } };
  return { gateway: window.modelGateway, written, resolved, asked, timers, settle, later, local };
}

const call = (body, extra = {}) => ({ method: 'POST', headers: { Authorization: 'Bearer key', 'Content-Type': 'application/json', 'X-Title': 'SynthOrg Orchestrator' }, body: JSON.stringify(body), ...extra });

test('a streamed answer reaches the caller whole, and its numbers are written down beside it', async () => {
  const usage = { prompt_tokens: 1200, completion_tokens: 300, cost: 0.0021, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 40 } };
  const p = page({ answers: [stream([
    event({ id: 'gen-1', provider: 'Google', choices: [{ delta: { role: 'assistant' } }] }),
    event({ choices: [{ delta: { reasoning: 'penso' } }] }),
    // a frame split in two, as the network does
    'data: {"choices":[{"delta":{"content":"Caff', 'è ☕"}}]}\n\n',
    event({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }),
    'data: [DONE]\n\n'
  ], { headers: { 'x-generation-id': 'gen-1' } })] });
  const response = await p.gateway.fetchChat(call({ model: 'google/gemini-3.8-flash', stream: true, messages: [{ role: 'user', content: 'ciao' }] }, { track: { conversationId: 'c1', role: 'master', turn: 'turn-1' } }));
  assert.equal(response.ok, true);
  const text = await response.text();
  assert.match(text, /Caffè ☕/);
  assert.match(text, /\[DONE\]/);
  await p.settle();
  const [row] = p.written;
  assert.deepEqual([row.conversationId, row.role, row.turn, row.model, row.provider, row.ok, row.stopped, row.local, row.queued],
    ['c1', 'master', 'turn-1', 'google/gemini-3.8-flash', 'Google', true, false, false, false]);
  assert.deepEqual([row.promptTokens, row.completionTokens, row.cachedTokens, row.reasoningTokens, row.cost], [1200, 300, 800, 40, 0.0021]);
  assert.ok(row.firstMs >= 5 && row.firstMs < row.ms, `first word ${row.firstMs} ms of ${row.ms}`);
  const sent = p.asked[0];
  assert.equal(sent.options.track, undefined, 'what the call is, is not part of the request');
  assert.equal(JSON.parse(sent.options.body).track, undefined);
  assert.equal(JSON.stringify(p.written).includes('ciao'), false, 'nothing of what was asked is written down');
  assert.equal(JSON.stringify(p.written).includes('Caff'), false, 'nothing of what was answered is written down');
});

test('what a call is comes from what it says, from its title, or from the door it goes through', async () => {
  const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
  const p = page({ answers: [
    json({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 } }),
    json({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.00005 } }),
    json({ text: 'Va bene.', usage: { seconds: 1.4, cost: 0.0000233 } }, { 'x-generation-id': 'gen-stt-1' }),
    json({ choices: [{ message: { content: 'ok' } }], usage: { cost: 0.001 } }),
    json({ choices: [{ message: { content: 'ok' } }], usage: { cost: 0.002 } })
  ] });
  const title = (name) => ({ Authorization: 'Bearer key', 'X-Title': name });
  await (await p.gateway.fetchChat(call({ model: 'a/master', stream: false }, { track: { conversationId: 'c1', role: 'master', turn: 'turn-7' } }))).json();
  await (await p.gateway.fetchChat({ method: 'POST', headers: { ...title('SynthOrg Microtask'), 'x-session-id': 'c1' }, body: JSON.stringify({ model: 'a/small', stream: false }) })).json();
  const heard = await (await p.gateway.fetchApi('https://openrouter.ai/api/v1/audio/transcriptions', { method: 'POST', headers: title('SynthOrg Realtime'), body: JSON.stringify({ model: 'mistralai/voxtral' }) })).json();
  assert.equal(heard.text, 'Va bene.');
  await (await p.gateway.fetchChat({ method: 'POST', headers: title('SynthOrg Tool Delegate'), track: { conversationId: 'c2', role: 'tool:thinking_solver' }, body: JSON.stringify({ model: 'a/thinker', stream: false }) })).json();
  await (await p.gateway.fetchChat({ method: 'POST', headers: title('Something else'), body: JSON.stringify({ model: 'a/b', stream: false }) })).json();
  await p.settle(); await wait(30);
  assert.deepEqual(plain(p.written.map(r => [r.role, r.conversationId, r.turn, r.place ?? null, r.cost])), [
    ['master', 'c1', 'turn-7', null, 0.0001],
    ['microtask', 'c1', 'turn-7', null, 0.00005],
    ['transcription', null, null, 'realtime', 0.0000233],
    ['tool:thinking_solver', 'c2', null, null, 0.001],
    ['other', null, null, null, 0.002]
  ], 'a request of a chat belongs to the turn of the Master under way in that chat');
  assert.equal(p.asked[2].options.track, undefined);
});

test('a cost the answer does not carry is asked of the provider later, by its generation', async () => {
  const audio = stream([new Uint8Array(4000), new Uint8Array(4000)], { type: 'audio/pcm;rate=24000', headers: { 'x-generation-id': 'gen-tts-9' } });
  const p = page({ answers: [audio], pending: [{ id: 1, generation: 'gen-tts-9', at: new Date(Date.now() - 60000).toISOString() }, { id: 2, generation: 'gen-unknown', at: new Date(Date.now() - 60000).toISOString() }],
    generations: { 'gen-tts-9': { total_cost: 0.000272, tokens_prompt: 2, tokens_completion: 45, provider_name: 'Google AI Studio' } } });
  const response = await p.gateway.fetchApi('https://openrouter.ai/api/v1/audio/speech', { method: 'POST', headers: { 'X-Title': 'SynthOrg Voice Delegate' }, track: { conversationId: 'c1', role: 'speech' }, body: JSON.stringify({ model: 'google/tts', input: 'Va bene.' }) });
  assert.equal((await response.arrayBuffer()).byteLength, 8000, 'the audio reaches the caller whole');
  await p.settle();
  assert.deepEqual([p.written[0].role, p.written[0].cost, p.written[0].generation, p.written[0].model], ['speech', null, 'gen-tts-9', 'google/tts']);
  assert.equal(JSON.stringify(p.written).includes('Va bene'), false);
  p.timers.splice(0, p.timers.length - 1);
  await p.later();
  assert.deepEqual(plain(p.resolved), [{ id: 1, cost: 0.000272, promptTokens: 2, completionTokens: 45, provider: 'Google AI Studio' }]);
  assert.equal(p.asked.filter(a => a.url.includes('/generation?id=')).length >= 2, true, 'the one not known yet is asked for again');
});

test('an answer refused, a request that could not be made, a stream that breaks: written down as they went', async () => {
  const p = page({ answers: [
    new Response('{"error":{"message":"No credit"}}', { status: 402, headers: { 'Content-Type': 'application/json' } }),
    new Error('network down'),
    stream([event({ choices: [{ delta: { content: 'Parziale' } }] })], { fail: true, headers: { 'x-generation-id': 'gen-cut' } })
  ] });
  const refused = await p.gateway.fetchChat(call({ model: 'a/b', stream: true }));
  assert.equal(refused.status, 402);
  assert.match(await refused.text(), /No credit/, 'the caller reads the error as it came');
  await assert.rejects(p.gateway.fetchChat(call({ model: 'a/b', stream: true })), /network down/);
  const cut = await p.gateway.fetchChat(call({ model: 'a/b', stream: true }));
  await assert.rejects(cut.text());
  await p.settle(); await wait(30);
  assert.deepEqual(plain(p.written.map(r => [r.ok, r.stopped, r.generation, r.firstMs === null])), [[false, false, null, true], [false, false, null, true], [false, false, 'gen-cut', false]]);
});

test('the stop button: what was written so far is an answer stopped, not a fault', async () => {
  const p = page({ answers: [stream([event({ choices: [{ delta: { content: 'Inizio' } }] })], { fail: true, headers: { 'x-generation-id': 'gen-stop' } })] });
  const stop = new AbortController();
  p.gateway.setStopSignal(stop.signal);
  const response = await p.gateway.fetchChat(call({ model: 'a/b', stream: true }, { track: { conversationId: 'c1', role: 'master', turn: 't' } }));
  stop.abort();
  await assert.rejects(response.text());
  await p.settle();
  assert.deepEqual([p.written[0].ok, p.written[0].stopped, p.written[0].generation], [true, true, 'gen-stop']);
});

test('a model on this computer is asked to say how much it read and wrote, and costs nothing', async () => {
  const p = page({ answers: [stream([
    event({ choices: [{ delta: { content: 'ciao' } }] }),
    event({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 9 }, timings: { prompt_n: 40, predicted_n: 9 } })
  ])] });
  await (await p.gateway.fetchChat(call({ model: 'local/MiniCPM.gguf', stream: true, usage: { include: true }, messages: [] }))).text();
  await p.settle();
  const sent = JSON.parse(p.asked[0].options.body);
  assert.deepEqual(plain(sent.stream_options), { include_usage: true });
  assert.equal(sent.usage, undefined);
  assert.match(p.asked[0].url, /^http:\/\/127\.0\.0\.1:9999\//);
  assert.deepEqual([p.written[0].local, p.written[0].promptTokens, p.written[0].completionTokens, p.written[0].cost], [true, 40, 9, null]);
});
