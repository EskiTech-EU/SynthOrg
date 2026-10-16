'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// What the page's script makes lives in its own realm: compared by shape, not by prototype.
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

/** providers.js as the page runs it, with what it needs of the page: a window, a storage of settings, a fetch of ours. */
function page({ settings = {}, fetchImpl = null } = {}) {
  const store = new Map(Object.entries(settings));
  const window = {
    chatStorage: {
      async getSetting(key) { return { value: store.get(key) ?? null }; },
      async setSetting(key, value) { store.set(key, value); return { ok: true }; }
    },
    dispatchEvent() { return true; },
    addEventListener() {}
  };
  const sandbox = {
    window, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: fetchImpl || (async () => { throw new Error('nessuna rete nel test'); }),
    AbortSignal: { timeout: () => undefined }, CustomEvent: class { constructor(name, init) { this.type = name; this.detail = init?.detail; } },
    TextDecoder, TextEncoder, ReadableStream, Response, console, Date, JSON, Math, Number, String, Array, Object, Map, Set, Promise
  };
  sandbox.window.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'providers.js'), 'utf8'), sandbox);
  return { providers: window.modelProviders, store, sandbox };
}

test('the makers are listed, each with its key setting, and a model knows its maker', () => {
  const { providers } = page();
  same(providers.PROVIDERS.map(p => p.id), ['openai', 'anthropic', 'google', 'deepseek', 'meta']);
  for (const provider of providers.PROVIDERS) assert.match(provider.setting, /_api_key$/, 'a secret setting: never copied to the phone (replica.js)');
  assert.equal(providers.providerOf('openai/gpt-5.5')?.id, 'openai');
  assert.equal(providers.providerOf('meta-llama/llama-4-maverick')?.id, 'meta');
  assert.equal(providers.providerOf('mistralai/mistral-large'), null);
  assert.equal(providers.providerOf('local/qwen'), null);
});

test('the maker’s own name for a catalogue model, as the maker lists it', () => {
  const { providers } = page();
  const anthropic = providers.PROVIDERS.find(p => p.id === 'anthropic');
  // Without the list: the dots become dashes for Anthropic, nothing changes for the others.
  assert.equal(providers.nativeId('anthropic/claude-sonnet-4.5', anthropic, []), 'claude-sonnet-4-5');
  assert.equal(providers.nativeId('openai/gpt-5.5', providers.PROVIDERS[0], []), 'gpt-5.5');
  // With the list: the spelling the maker uses, whichever of the two it is; a variant suffix is dropped.
  assert.equal(providers.nativeId('anthropic/claude-sonnet-4.5', anthropic, ['claude-sonnet-4-5', 'claude-opus-4-1']), 'claude-sonnet-4-5');
  assert.equal(providers.nativeId('openai/gpt-5.5:extended', providers.PROVIDERS[0], ['gpt-5.5', 'gpt-5.5-mini']), 'gpt-5.5');
  // An alias the catalogue spells its own way.
  const deepseek = providers.PROVIDERS.find(p => p.id === 'deepseek');
  assert.equal(providers.nativeId('deepseek/deepseek-r1', deepseek, ['deepseek-chat', 'deepseek-reasoner']), 'deepseek-reasoner');
  // Meta lists a longer name: taken when it is the only one that starts so, refused when two do.
  const meta = providers.PROVIDERS.find(p => p.id === 'meta');
  assert.equal(providers.nativeId('meta-llama/llama-4-maverick', meta, ['Llama-4-Maverick-17B-128E-Instruct-FP8', 'Llama-4-Scout-17B-16E-Instruct-FP8']), 'Llama-4-Maverick-17B-128E-Instruct-FP8');
  assert.equal(providers.nativeId('meta-llama/llama-4', meta, ['Llama-4-Maverick-17B-128E-Instruct-FP8', 'Llama-4-Scout-17B-16E-Instruct-FP8']), null);
  // A model the maker does not list goes nowhere directly.
  assert.equal(providers.nativeId('openai/gpt-4.1', providers.PROVIDERS[0], ['gpt-5.5']), null);
});

test('the way a model goes: direct only with the key and the listing, the model’s own choice over the setting', async () => {
  const { providers } = page();
  assert.equal(providers.routeFor('openai/gpt-5.5'), null, 'no key: OpenRouter');
  providers._setKey('openai', 'sk-test');
  providers._setModels('openai', ['gpt-5.5', 'gpt-5.5-mini']);
  same(providers.routeFor('openai/gpt-5.5').model, 'gpt-5.5');
  assert.equal(providers.routeFor('openai/gpt-5.5').provider.id, 'openai');
  assert.equal(providers.routeFor('openai/o9'), null, 'not listed by the maker: OpenRouter');
  assert.equal(providers.routeFor('anthropic/claude-sonnet-4.5'), null, 'no key for that maker');
  await providers.setRoute('openai/gpt-5.5', 'openrouter');
  assert.equal(providers.routeFor('openai/gpt-5.5'), null, 'the model was told to stay on OpenRouter');
  await providers.setRoute('openai/gpt-5.5', null);
  await providers.setPreferDirect(false);
  assert.equal(providers.routeFor('openai/gpt-5.5'), null, 'the setting says OpenRouter unless chosen');
  await providers.setRoute('openai/gpt-5.5', 'direct');
  assert.equal(providers.routeFor('openai/gpt-5.5')?.route, 'direct');
  await assert.rejects(providers.setRoute('openai/gpt-5.5', 'elsewhere'));
});

test('what the makers list and the catalogue lacks is offered as a model of its own', () => {
  const { providers } = page();
  providers._setKey('openai', 'k');
  providers._setModels('openai', ['gpt-5.5', 'gpt-6-preview', 'whisper-1', 'text-embedding-3-large']);
  providers._setKey('google', 'k');
  providers._setModels('google', ['gemini-2.5-pro', 'gemini-3-ultra', 'imagen-4']);
  const extras = providers.extraModels(['openai/gpt-5.5', 'google/gemini-2.5-pro']);
  same(extras.map(e => e.id).sort(), ['google/gemini-3-ultra', 'openai/gpt-6-preview']);
  assert.equal(extras.find(e => e.id === 'openai/gpt-6-preview').direct, 'openai');
});

test('a request for OpenAI, DeepSeek or Meta is the same request, less what only OpenRouter reads', () => {
  const { providers } = page();
  const payload = {
    model: 'openai/gpt-5.5', stream: true, provider: { zdr: true }, route: 'fallback', usage: { include: true }, reasoning: { effort: 'high' },
    messages: [{ role: 'system', content: [{ type: 'text', text: 'sei', cache_control: { type: 'ephemeral' } }] }, { role: 'user', content: 'ciao' }],
    tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }]
  };
  const body = providers.toOpenAI(payload, 'gpt-5.5');
  assert.equal(body.model, 'gpt-5.5');
  for (const key of ['provider', 'route', 'usage', 'reasoning']) assert.ok(!(key in body), key);
  assert.equal(body.reasoning_effort, 'high');
  same(body.stream_options, { include_usage: true });
  assert.equal(body.messages[0].content[0].cache_control, undefined, 'the cache marks are OpenRouter’s');
  assert.equal(JSON.stringify(payload.messages[0].content[0].cache_control), '{"type":"ephemeral"}', 'the caller’s request is not changed');
});

test('a request for Anthropic: the system apart, tools and results as blocks, the cache marks kept, a thinking budget', () => {
  const { providers } = page();
  const payload = {
    model: 'anthropic/claude-sonnet-4.5', stream: false, temperature: 0.3, max_tokens: 2000, stop: ['END'], reasoning: { effort: 'low' },
    messages: [
      { role: 'system', content: 'sei un aiuto', cache_control: { type: 'ephemeral' } },
      { role: 'user', content: [{ type: 'text', text: 'guarda' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'leggi', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'contenuto' },
      { role: 'tool', tool_call_id: 'call_2', content: 'altro' },
      { role: 'user', content: 'e ora?' }
    ],
    tools: [{ type: 'function', function: { name: 'leggi', description: 'legge', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    tool_choice: 'required'
  };
  const body = providers.toAnthropic(payload, 'claude-sonnet-4-5', { hasReasoning: true });
  assert.equal(body.model, 'claude-sonnet-4-5');
  same(body.system, [{ type: 'text', text: 'sei un aiuto', cache_control: { type: 'ephemeral' } }]);
  same(body.messages.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(body.messages[0].content[1].type, 'image');
  assert.equal(body.messages[0].content[1].source.media_type, 'image/png');
  same(body.messages[1].content, [{ type: 'tool_use', id: 'call_1', name: 'leggi', input: { path: 'a.txt' } }]);
  // Two results and the next question are one message of the user's, the results first.
  same(body.messages[2].content.map(b => b.type), ['tool_result', 'tool_result', 'text']);
  same(body.tools, [{ name: 'leggi', description: 'legge', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }]);
  same(body.tool_choice, { type: 'any' });
  same(body.stop_sequences, ['END']);
  same(body.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.ok(body.max_tokens > 2048, 'room for the answer after the thinking');
  assert.equal(body.temperature, undefined, 'thinking takes the sampling as it is');
  assert.equal(body.stream, false);
  // Without an effort the caller's sampling and limit stay.
  const plain = providers.toAnthropic({ ...payload, reasoning: undefined }, 'claude-sonnet-4-5', null);
  assert.equal(plain.temperature, 0.3);
  assert.equal(plain.max_tokens, 2000);
  assert.equal(plain.thinking, undefined);
});

test('Anthropic’s answer and its stream come back as OpenRouter’s shapes, the cache counted in the prompt', () => {
  const { providers } = page();
  const whole = providers.fromAnthropic({
    id: 'msg_1', model: 'claude-sonnet-4-5', stop_reason: 'tool_use',
    content: [{ type: 'thinking', thinking: 'penso' }, { type: 'text', text: 'Leggo.' }, { type: 'tool_use', id: 'toolu_1', name: 'leggi', input: { path: 'x' } }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }
  }, 'claude-sonnet-4-5');
  assert.equal(whole.choices[0].finish_reason, 'tool_calls');
  assert.equal(whole.choices[0].message.content, 'Leggo.');
  assert.equal(whole.choices[0].message.reasoning, 'penso');
  same(whole.choices[0].message.tool_calls, [{ id: 'toolu_1', type: 'function', function: { name: 'leggi', arguments: '{"path":"x"}' } }]);
  same(whole.usage, { prompt_tokens: 130, completion_tokens: 5, total_tokens: 135, prompt_tokens_details: { cached_tokens: 100 }, cache_creation_input_tokens: 20 });

  const translate = providers.anthropicChunks('claude-sonnet-4-5');
  const chunks = [
    ...translate('message_start', { message: { id: 'msg_2', usage: { input_tokens: 7, cache_read_input_tokens: 3 } } }),
    ...translate('content_block_start', { index: 0, content_block: { type: 'text' } }),
    ...translate('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Ciao' } }),
    ...translate('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'leggi' } }),
    ...translate('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"pa' } }),
    ...translate('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'th":"y"}' } }),
    ...translate('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
    ...translate('message_stop', {})
  ];
  assert.equal(chunks[0].choices[0].delta.content, 'Ciao');
  assert.equal(chunks[0].id, 'msg_2');
  same(chunks[1].choices[0].delta.tool_calls[0], { index: 0, id: 'toolu_2', type: 'function', function: { name: 'leggi', arguments: '' } });
  assert.equal(chunks[2].choices[0].delta.tool_calls[0].function.arguments + chunks[3].choices[0].delta.tool_calls[0].function.arguments, '{"path":"y"}');
  const last = chunks[chunks.length - 1];
  assert.equal(last.choices[0].finish_reason, 'tool_calls');
  same(last.usage, { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19, prompt_tokens_details: { cached_tokens: 3 }, cache_creation_input_tokens: 0 });
});

test('a request for Gemini: contents by turn, the system apart, the tools as declarations, the cache and thoughts counted', () => {
  const { providers } = page();
  const payload = {
    model: 'google/gemini-2.5-pro', stream: true, temperature: 0.2, max_tokens: 500, reasoning: { effort: 'medium' },
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'rispondi corto' },
      { role: 'user', content: 'quanto fa 2+2?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calc', arguments: '{"expr":"2+2"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '4' }
    ],
    tools: [{ type: 'function', function: { name: 'calc', description: 'calcola', parameters: { type: 'object', properties: { expr: { type: 'string', description: 'cosa' } }, required: ['expr'], additionalProperties: false } } }]
  };
  const body = providers.toGemini(payload, 'gemini-2.5-pro', { hasReasoning: true });
  same(body.systemInstruction, { parts: [{ text: 'rispondi corto' }] });
  same(body.contents.map(c => c.role), ['user', 'model', 'user']);
  same(body.contents[1].parts, [{ functionCall: { name: 'calc', args: { expr: '2+2' } } }]);
  // A result that is a JSON value goes as it is, under `result`; one that is a JSON object goes as the object.
  same(body.contents[2].parts, [{ functionResponse: { name: 'calc', response: { result: 4 } } }]);
  same(body.tools[0].functionDeclarations[0].parameters, { type: 'OBJECT', properties: { expr: { type: 'STRING', description: 'cosa' } }, required: ['expr'] });
  assert.equal(body.generationConfig.temperature, 0.2);
  assert.equal(body.generationConfig.maxOutputTokens, 500);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  same(body.generationConfig.thinkingConfig, { thinkingBudget: 8192, includeThoughts: true });

  const counter = { calls: 0, started: 1700000000000 };
  const chunk = providers.fromGemini({
    candidates: [{ content: { role: 'model', parts: [{ text: 'pens', thought: true }, { text: 'Fa ' }, { functionCall: { name: 'calc', args: { expr: '2+2' } } }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 6, cachedContentTokenCount: 30, thoughtsTokenCount: 11 }
  }, 'gemini-2.5-pro', true, counter);
  assert.equal(chunk.choices[0].delta.content, 'Fa ');
  assert.equal(chunk.choices[0].delta.reasoning, 'pens');
  assert.equal(chunk.choices[0].delta.tool_calls[0].function.name, 'calc');
  assert.equal(chunk.choices[0].finish_reason, 'tool_calls');
  same(chunk.usage, { prompt_tokens: 40, completion_tokens: 17, total_tokens: 57, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 11 } });
});

test('the direct call: the maker’s door, its headers, its format, and the answer as OpenRouter gives it', async () => {
  const calls = [];
  const sse = (events) => new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const { providers } = page({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('https://api.anthropic.com')) {
      return sse([
        ['message_start', { type: 'message_start', message: { id: 'msg_9', usage: { input_tokens: 4 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }]
      ]);
    }
    if (url.includes('generativelanguage')) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'quattro' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: { message: 'chiave non valida', type: 'invalid_request_error' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  } });
  providers._setKey('anthropic', 'sk-ant-1'); providers._setKey('google', 'AIza'); providers._setKey('openai', 'sk-1');
  providers._setModels('anthropic', ['claude-sonnet-4-5']); providers._setModels('google', ['gemini-2.5-pro']); providers._setModels('openai', ['gpt-5.5']);

  // Anthropic, streamed: the chunks the app reads, text and usage.
  const a = await providers.call(providers.routeFor('anthropic/claude-sonnet-4.5'), { model: 'anthropic/claude-sonnet-4.5', stream: true, messages: [{ role: 'user', content: 'ciao' }] });
  assert.equal(calls[0].options.headers['x-api-key'], 'sk-ant-1');
  assert.equal(calls[0].options.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(JSON.parse(calls[0].options.body).model, 'claude-sonnet-4-5');
  const text = await a.text();
  const chunks = text.split('\n\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]')).map(l => JSON.parse(l.slice(6)));
  assert.equal(chunks[0].choices[0].delta.content, 'ok');
  assert.equal(chunks[chunks.length - 1].usage.prompt_tokens, 4);
  assert.ok(text.trim().endsWith('data: [DONE]'));

  // Gemini, whole: the maker's URL with the model in it and the key in its header, the answer as a completion.
  const g = await providers.call(providers.routeFor('google/gemini-2.5-pro'), { model: 'google/gemini-2.5-pro', stream: false, messages: [{ role: 'user', content: '2+2' }] });
  assert.match(calls[1].url, /models\/gemini-2\.5-pro:generateContent$/);
  assert.equal(calls[1].options.headers['x-goog-api-key'], 'AIza');
  const body = await g.json();
  assert.equal(body.choices[0].message.content, 'quattro');
  assert.equal(body.usage.prompt_tokens, 3);

  // A refusal of the maker, said as OpenRouter says one.
  const o = await providers.call(providers.routeFor('openai/gpt-5.5'), { model: 'openai/gpt-5.5', stream: true, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(o.status, 401);
  assert.equal((await o.json()).error.message, 'chiave non valida');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer sk-1');
});

test('the cost of a direct request is worked out from the catalogue’s prices and said so', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'model-gateway.js'), 'utf8');
  // What the gateway writes down: the cost's source, and the cache under every name the makers use.
  assert.ok(code.includes("costSource: usage.cost != null ? 'provider' : priced != null ? 'priced' : null"));
  assert.ok(code.includes('usage.prompt_cache_hit_tokens'));
  assert.ok(code.includes('window.modelProviders?.routeFor?.(payload.model)'));
  // The sum itself, as the page runs it.
  const start = code.indexOf('  function priceOf(');
  const end = code.indexOf('\n  }\n', start) + 4;
  const sandbox = { window: { openRouterCatalog: { models: [
    { id: 'openai/gpt-5.5', pricing: { billing: 'token', promptPerM: 2, completionPerM: 8, cacheReadPerM: 0.5 } },
    { id: 'openai/gpt-image', pricing: { billing: 'nonToken', promptPerM: 0, completionPerM: 0 } }
  ] } }, Math, Number };
  vm.createContext(sandbox);
  vm.runInContext(code.slice(start, end) + '\nthis.priceOf = priceOf;', sandbox);
  // 1000 read, 400 of them from the cache, 200 written: 600×2 + 400×0.5 + 200×8 per million.
  assert.equal(sandbox.priceOf('openai/gpt-5.5', 1000, 200, 400), (600 * 2 + 400 * 0.5 + 200 * 8) / 1e6);
  assert.equal(sandbox.priceOf('openai/gpt-image', 1000, 1, 0), null, 'not priced per token: no cost, a gap in the record');
  assert.equal(sandbox.priceOf('nobody/none', 1, 1, 0), null);
});

test('the record keeps where a cost came from', () => {
  const { Store } = require('../server/database');
  const store = new Store(':memory:');
  try {
    const usage = store.usage();
    const given = usage.record({ model: 'openai/gpt-5.5', role: 'master', cost: 0.01, promptTokens: 10, completionTokens: 2 });
    const priced = usage.record({ model: 'openai/gpt-5.5', role: 'master', cost: 0.02, costSource: 'priced', provider: 'direct:openai', promptTokens: 10, completionTokens: 2 });
    const unknown = usage.record({ model: 'openai/gpt-6-preview', role: 'master', cost: null, provider: 'direct:openai' });
    const rows = store.db.prepare('SELECT id, cost, cost_source, provider FROM model_usage ORDER BY id').all();
    same(rows.map(r => [r.cost_source, r.provider]), [['provider', null], ['priced', 'direct:openai'], [null, 'direct:openai']]);
    assert.equal(rows[2].cost, null, 'what no one priced stays a gap, not a zero');
    assert.ok(given.id < priced.id && priced.id < unknown.id);
  } finally { store.close(); }
});
