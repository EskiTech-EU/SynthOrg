/**
 * SynthOrg - the providers a model can be reached at directly.
 *
 * One list of models, the catalogue's. A model whose maker's key is here
 * (OpenAI, Anthropic, Google, DeepSeek, Meta) can be asked of the maker
 * directly instead of through OpenRouter: the same entry in the list, with a
 * choice of the way ("via"), kept per model, and one setting that says which
 * way a model goes when nothing was chosen for it. Nothing else changes for
 * whoever makes the call: the gateway (model-gateway.js) sends the request
 * where the choice says, in the maker's own format where that differs, and
 * gives back the answer in the shape OpenRouter gives it.
 *
 * Measured on 2026-10-16, from this app's origin: OpenAI, Anthropic, DeepSeek
 * and Meta answer the browser's CORS preflight for their chat endpoints;
 * Google does for its own Gemini API with the `x-goog-api-key` header, not
 * for its OpenAI-compatible door (`authorization` is not among the headers it
 * allows). So OpenAI, DeepSeek and Meta are spoken to in the format the app
 * already uses, Anthropic and Google in theirs, translated here.
 *
 * What each says of a request, from their documentation (to be checked with a
 * real key: none was used here): OpenAI the tokens read from its cache
 * (prompt_tokens_details.cached_tokens); Anthropic the ones read from and
 * written to its cache, separately; Google the ones from its context cache
 * (cachedContentTokenCount); DeepSeek cache hits and misses; Meta the tokens
 * in and out, nothing of a cache. None gives a cost in money: it is worked
 * out here from the catalogue's prices (model-gateway.js, `priced`), and
 * written down as worked out, not as given.
 */
(() => {
  'use strict';

  const bearer = key => ({ Authorization: `Bearer ${key}` });

  /** The providers, in the order the settings show them. */
  const PROVIDERS = [
    {
      id: 'openai', name: 'OpenAI', setting: 'openai_api_key', placeholder: 'sk-...', format: 'openai',
      chat: 'https://api.openai.com/v1/chat/completions', models: 'https://api.openai.com/v1/models',
      headers: bearer, catalog: ['openai']
    },
    {
      id: 'anthropic', name: 'Anthropic', setting: 'anthropic_api_key', placeholder: 'sk-ant-...', format: 'anthropic',
      chat: 'https://api.anthropic.com/v1/messages', models: 'https://api.anthropic.com/v1/models',
      // The last header is what Anthropic asks of a call made from a page rather than a server.
      headers: key => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }),
      catalog: ['anthropic']
    },
    {
      id: 'google', name: 'Google', setting: 'google_api_key', placeholder: 'AIza...', format: 'gemini',
      chat: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:{method}', models: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
      headers: key => ({ 'x-goog-api-key': key }), catalog: ['google']
    },
    {
      id: 'deepseek', name: 'DeepSeek', setting: 'deepseek_api_key', placeholder: 'sk-...', format: 'openai',
      chat: 'https://api.deepseek.com/chat/completions', models: 'https://api.deepseek.com/models',
      headers: bearer, catalog: ['deepseek']
    },
    {
      id: 'meta', name: 'Meta', setting: 'meta_api_key', placeholder: 'LLM|...', format: 'openai',
      chat: 'https://api.llama.com/compat/v1/chat/completions', models: 'https://api.llama.com/compat/v1/models',
      headers: bearer, catalog: ['meta-llama']
    }
  ];

  // Names a provider gives a model that the catalogue spells otherwise.
  const ALIASES = {
    deepseek: { 'deepseek-r1': 'deepseek-reasoner', 'deepseek-chat-v3.1': 'deepseek-chat', 'deepseek-v3.1': 'deepseek-chat', 'deepseek-v3.2': 'deepseek-chat', 'deepseek-v3.2-exp': 'deepseek-chat' }
  };

  // Fields of a request only OpenRouter understands: dropped before a maker sees it.
  const OPENROUTER_ONLY = ['provider', 'session_id', 'include_reasoning', 'transforms', 'models', 'route', 'reasoning', 'usage'];

  const SETTING_ROUTES = 'model_routes_json';     // { modelId: 'direct' | 'openrouter' }
  const SETTING_PREFER = 'providers_prefer_direct'; // 'true' | 'false': the way a model goes when nothing was chosen for it
  const LOCAL_PREFIX = 'synthorg_provider_key_';

  const state = {
    keys: {},          // provider id -> key (in memory; mirrored in localStorage and in the settings)
    models: {},        // provider id -> [native model ids], as the provider listed them
    routes: {},        // model id -> 'direct' | 'openrouter'
    preferDirect: true,
    checked: {},       // provider id -> { ok, count, error, at }
    loaded: false
  };

  const storage = () => window.chatStorage;
  const byId = id => PROVIDERS.find(p => p.id === id) || null;
  const safeGet = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const safeSet = (key, value) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch {} };

  /* ------------------------------------------------------------------ */
  /* Keys and choices                                                     */
  /* ------------------------------------------------------------------ */

  function getKey(providerId) {
    return state.keys[providerId] || safeGet(LOCAL_PREFIX + providerId) || '';
  }

  /** The key kept, here and in the settings; the provider's models asked for right after. */
  async function setKey(providerId, key) {
    const provider = byId(providerId);
    if (!provider) throw new Error('Provider sconosciuto.');
    const trimmed = String(key || '').trim();
    state.keys[providerId] = trimmed;
    safeSet(LOCAL_PREFIX + providerId, trimmed || null);
    delete state.checked[providerId];
    if (!trimmed) { state.models[providerId] = []; }
    try { await storage()?.setSetting?.(provider.setting, trimmed); } catch {}
    if (trimmed) await listModels(providerId).catch(() => {});
    announce();
  }

  /** The keys and the choices as the settings keep them: read once at start, and mirrored here. */
  async function load() {
    for (const provider of PROVIDERS) {
      let value = '';
      try { value = (await storage()?.getSetting?.(provider.setting))?.value || ''; } catch {}
      if (!value) value = safeGet(LOCAL_PREFIX + provider.id) || '';
      state.keys[provider.id] = value;
      safeSet(LOCAL_PREFIX + provider.id, value || null);
    }
    try { state.routes = JSON.parse((await storage()?.getSetting?.(SETTING_ROUTES))?.value || '{}') || {}; } catch { state.routes = {}; }
    try { const prefer = (await storage()?.getSetting?.(SETTING_PREFER))?.value; state.preferDirect = prefer !== 'false'; } catch {}
    state.loaded = true;
    // The models of every provider with a key, so the list can say which way each model may go.
    await Promise.all(PROVIDERS.filter(p => state.keys[p.id]).map(p => listModels(p.id).catch(() => {})));
    announce();
  }

  function announce() {
    try { window.dispatchEvent(new CustomEvent('synthorg-providers-changed')); } catch {}
  }

  async function setRoute(modelId, route) {
    if (!['direct', 'openrouter', null].includes(route)) throw new Error('Via non valida.');
    if (route === null) delete state.routes[modelId]; else state.routes[modelId] = route;
    try { await storage()?.setSetting?.(SETTING_ROUTES, JSON.stringify(state.routes)); } catch {}
    announce();
  }

  async function setPreferDirect(on) {
    state.preferDirect = on !== false;
    try { await storage()?.setSetting?.(SETTING_PREFER, state.preferDirect ? 'true' : 'false'); } catch {}
    announce();
  }

  /* ------------------------------------------------------------------ */
  /* The provider's models, and which of the catalogue's they are         */
  /* ------------------------------------------------------------------ */

  /** The ids a provider lists, whatever shape its list has. */
  function idsOf(body) {
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
    return list.map(item => String(item?.id || item?.name || '')).map(id => id.replace(/^models\//, '')).filter(Boolean);
  }

  async function listModels(providerId) {
    const provider = byId(providerId);
    const key = getKey(providerId);
    if (!provider || !key) return [];
    const res = await fetch(provider.models, { headers: provider.headers(key), signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      state.checked[providerId] = { ok: false, error: `${res.status} ${text.slice(0, 160)}`.trim(), at: Date.now() };
      throw new Error(state.checked[providerId].error);
    }
    const ids = idsOf(await res.json().catch(() => null));
    state.models[providerId] = ids;
    state.checked[providerId] = { ok: true, count: ids.length, at: Date.now() };
    return ids;
  }

  /** The key tried: the provider's list of models asked for with it. */
  async function test(providerId) {
    try {
      const ids = await listModels(providerId);
      announce();
      return { ok: true, count: ids.length };
    } catch (error) {
      announce();
      return { ok: false, error: error.message };
    }
  }

  /** The maker of a catalogue model (`openai/gpt-5` → openai), or null. */
  function providerOf(modelId) {
    const prefix = String(modelId || '').split('/')[0];
    return PROVIDERS.find(p => p.catalog.includes(prefix)) || null;
  }

  const normal = value => String(value || '').toLowerCase();

  /**
   * The maker's own name for a catalogue model, or null when the maker does
   * not list it. The catalogue spells `anthropic/claude-sonnet-4.5` what
   * Anthropic calls `claude-sonnet-4-5`; a name the maker lists under a longer
   * form (Meta: `llama-4-maverick` → `Llama-4-Maverick-17B-128E-Instruct-FP8`)
   * is taken when it is the only one that starts so.
   */
  function nativeId(modelId, provider = providerOf(modelId), listed = state.models[provider?.id]) {
    if (!provider) return null;
    const bare = String(modelId).slice(String(modelId).indexOf('/') + 1).replace(/:[a-z]+$/i, '');
    const candidates = [bare, bare.replace(/\./g, '-'), ALIASES[provider.id]?.[bare]].filter(Boolean);
    if (!Array.isArray(listed) || !listed.length) return provider.format === 'anthropic' ? candidates[1] : candidates[0];
    const lower = new Map(listed.map(id => [normal(id), id]));
    for (const candidate of candidates) { const hit = lower.get(normal(candidate)); if (hit) return hit; }
    const starting = listed.filter(id => normal(id).startsWith(normal(bare) + '-') || normal(id).startsWith(normal(bare.replace(/\./g, '-')) + '-'));
    return starting.length === 1 ? starting[0] : null;
  }

  /** Whether a catalogue model may go the direct way: its maker's key is here and the maker lists it. */
  function directOf(modelId) {
    const provider = providerOf(modelId);
    if (!provider || !getKey(provider.id)) return null;
    const native = nativeId(modelId, provider);
    return native ? { provider, model: native } : null;
  }

  /**
   * The way a model goes now: 'direct' with the provider and its name for the
   * model, or null for OpenRouter. The model's own choice first, then the
   * setting for the ones without a choice, and never direct where it cannot be.
   */
  function routeFor(modelId) {
    const direct = directOf(modelId);
    if (!direct) return null;
    const chosen = state.routes[modelId];
    if (chosen === 'openrouter') return null;
    if (chosen === 'direct' || state.preferDirect) return { ...direct, route: 'direct' };
    return null;
  }

  /** Models the makers list that the catalogue does not have: shown with what little is known of them. */
  function extraModels(catalogIds) {
    const known = new Set(catalogIds.map(normal));
    const out = [];
    for (const provider of PROVIDERS) {
      const prefix = provider.catalog[0];
      for (const native of state.models[provider.id] || []) {
        if (provider.format === 'gemini' && !/^gemini/i.test(native)) continue;
        if (provider.id === 'openai' && !/^(gpt|o\d|chatgpt)/i.test(native)) continue;
        const id = `${prefix}/${native.toLowerCase()}`;
        const taken = [...known].some(k => k === id || nativeIdMatches(k, native, provider));
        if (!taken) out.push({ id, name: native, provider: prefix, native, direct: provider.id });
      }
    }
    return out;
  }

  function nativeIdMatches(catalogId, native, provider) {
    if (!catalogId.startsWith(provider.catalog[0] + '/')) return false;
    return normal(nativeId(catalogId, provider, [native]) || '') === normal(native);
  }

  /* ------------------------------------------------------------------ */
  /* The request, in the maker's format                                   */
  /* ------------------------------------------------------------------ */

  const textOf = content => (typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(part => (typeof part === 'string' ? part : part?.type === 'text' ? part.text : '')).filter(Boolean).join('\n') : '');

  /** The request as OpenAI, DeepSeek and Meta take it: the same, less what only OpenRouter reads. */
  function toOpenAI(payload, native) {
    const body = { ...payload, model: native };
    for (const key of OPENROUTER_ONLY) delete body[key];
    if (payload.reasoning?.effort && payload.reasoning.effort !== 'none') body.reasoning_effort = payload.reasoning.effort;
    if (body.stream === true) body.stream_options = { include_usage: true, ...(body.stream_options || {}) };
    body.messages = (body.messages || []).map(message => stripCacheControl(message));
    return body;
  }

  function stripCacheControl(value) {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    if (value && typeof value === 'object') {
      const { cache_control, ...rest } = value;
      for (const key of Object.keys(rest)) rest[key] = stripCacheControl(rest[key]);
      return rest;
    }
    return value;
  }

  /** An image of a message (`image_url`), as Anthropic takes it. */
  function anthropicImage(part) {
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url || '';
    const data = /^data:([^;]+);base64,(.+)$/.exec(url);
    if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
    return { type: 'image', source: { type: 'url', url } };
  }

  /** A content, as Anthropic's blocks, the cache marks kept where they were. */
  function anthropicBlocks(content, cacheControl = null) {
    const blocks = [];
    if (typeof content === 'string') { if (content) blocks.push({ type: 'text', text: content }); }
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part) continue;
        if (typeof part === 'string') { blocks.push({ type: 'text', text: part }); continue; }
        let block = null;
        if (part.type === 'text') block = { type: 'text', text: String(part.text || '') };
        else if (part.type === 'image_url') block = anthropicImage(part);
        else if (part.type === 'file' && part.file?.file_data) block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: String(part.file.file_data).replace(/^data:[^,]+,/, '') } };
        if (!block) continue;
        if (part.cache_control) block.cache_control = part.cache_control;
        blocks.push(block);
      }
    }
    if (cacheControl && blocks.length) blocks[blocks.length - 1].cache_control = cacheControl;
    return blocks;
  }

  const EFFORT_BUDGET = { low: 2048, medium: 8192, high: 16384 };

  /**
   * The request as Anthropic's Messages API takes it: the system apart, the
   * tool calls and their results as blocks, the tools with their schema under
   * the name it uses, the effort as a thinking budget. `max_tokens` is
   * required there: the caller's, or the model's most, or a plain figure.
   */
  function toAnthropic(payload, native, model = null) {
    const system = [];
    const messages = [];
    for (const message of payload.messages || []) {
      if (!message) continue;
      if (message.role === 'system' || message.role === 'developer') {
        system.push(...anthropicBlocks(message.content, message.cache_control || null));
        continue;
      }
      if (message.role === 'tool') {
        const block = { type: 'tool_result', tool_use_id: String(message.tool_call_id || ''), content: textOf(message.content) };
        const last = messages[messages.length - 1];
        if (last && last.role === 'user' && last.content.some(b => b.type === 'tool_result')) last.content.push(block);
        else messages.push({ role: 'user', content: [block] });
        continue;
      }
      if (message.role === 'assistant') {
        const blocks = anthropicBlocks(message.content, message.cache_control || null);
        for (const call of message.tool_calls || []) {
          let input = {};
          try { input = JSON.parse(call.function?.arguments || '{}'); } catch { input = {}; }
          blocks.push({ type: 'tool_use', id: String(call.id || ''), name: String(call.function?.name || ''), input });
        }
        if (blocks.length) messages.push({ role: 'assistant', content: blocks });
        continue;
      }
      const blocks = anthropicBlocks(message.content, message.cache_control || null);
      if (blocks.length) messages.push({ role: 'user', content: blocks });
    }
    // Two of the same side in a row are one message there.
    const folded = [];
    for (const message of messages) {
      const last = folded[folded.length - 1];
      if (last && last.role === message.role) last.content.push(...message.content); else folded.push(message);
    }
    const body = {
      model: native,
      max_tokens: Number(payload.max_tokens) || Number(payload.max_completion_tokens) || Math.min(Number(model?.maxCompletionTokens) || 8192, 32000) || 8192,
      messages: folded,
      stream: payload.stream === true
    };
    if (system.length) body.system = system;
    for (const key of ['temperature', 'top_p', 'top_k']) if (payload[key] !== undefined && payload[key] !== null) body[key] = payload[key];
    if (payload.stop) body.stop_sequences = Array.isArray(payload.stop) ? payload.stop : [payload.stop];
    if (Array.isArray(payload.tools) && payload.tools.length) {
      body.tools = payload.tools.filter(tool => tool?.function).map(tool => ({
        name: String(tool.function.name || ''), description: String(tool.function.description || ''),
        input_schema: tool.function.parameters || { type: 'object', properties: {} }
      }));
      const choice = payload.tool_choice;
      if (choice === 'required') body.tool_choice = { type: 'any' };
      else if (choice === 'none') delete body.tools;
      else if (choice?.function?.name) body.tool_choice = { type: 'tool', name: choice.function.name };
    }
    const effort = payload.reasoning?.effort;
    if (effort && effort !== 'none' && model?.hasReasoning !== false) {
      const budget = EFFORT_BUDGET[effort] || EFFORT_BUDGET.medium;
      body.thinking = { type: 'enabled', budget_tokens: budget };
      if (body.max_tokens <= budget) body.max_tokens = budget + 4096;
      // Thinking takes the sampling as it is.
      delete body.temperature; delete body.top_p; delete body.top_k;
    }
    return body;
  }

  /** Anthropic's usage, as the app reads OpenRouter's: the prompt counts what was read, from the cache or not. */
  function anthropicUsage(usage = {}) {
    const read = Number(usage.cache_read_input_tokens) || 0;
    const written = Number(usage.cache_creation_input_tokens) || 0;
    const input = Number(usage.input_tokens) || 0;
    return {
      prompt_tokens: input + read + written,
      completion_tokens: Number(usage.output_tokens) || 0,
      total_tokens: input + read + written + (Number(usage.output_tokens) || 0),
      prompt_tokens_details: { cached_tokens: read },
      cache_creation_input_tokens: written
    };
  }

  const STOP = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter' };

  /** Anthropic's whole answer, as a chat completion. */
  function fromAnthropic(body, native) {
    const message = { role: 'assistant', content: '', tool_calls: [] };
    let reasoning = '';
    for (const block of body.content || []) {
      if (block.type === 'text') message.content += block.text || '';
      else if (block.type === 'thinking') reasoning += block.thinking || '';
      else if (block.type === 'tool_use') message.tool_calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
    }
    if (!message.tool_calls.length) delete message.tool_calls;
    if (reasoning) message.reasoning = reasoning;
    return {
      id: body.id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model || native,
      choices: [{ index: 0, message, finish_reason: STOP[body.stop_reason] || 'stop' }],
      usage: anthropicUsage(body.usage)
    };
  }

  /**
   * Anthropic's stream of events, read as it comes and written again as the
   * chunks OpenRouter sends: text as content, thinking as reasoning, a tool
   * call's name then its arguments piece by piece, the usage at the end.
   */
  function anthropicChunks(native) {
    let lastId = 'msg';
    const head = () => ({ id: lastId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: native });
    let usage = null;
    let stop = 'stop';
    const tools = new Map(); // block index -> tool call index
    let toolCount = 0;
    return (event, data) => {
      const out = [];
      if (event === 'message_start') {
        lastId = data.message?.id || lastId;
        usage = data.message?.usage || null;
      } else if (event === 'content_block_start') {
        const block = data.content_block || {};
        if (block.type === 'tool_use') {
          tools.set(data.index, toolCount);
          out.push({ ...head(), choices: [{ index: 0, delta: { tool_calls: [{ index: toolCount, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] } }] });
          toolCount += 1;
        }
      } else if (event === 'content_block_delta') {
        const delta = data.delta || {};
        if (delta.type === 'text_delta' && delta.text) out.push({ ...head(), choices: [{ index: 0, delta: { content: delta.text } }] });
        else if (delta.type === 'thinking_delta' && delta.thinking) out.push({ ...head(), choices: [{ index: 0, delta: { reasoning: delta.thinking } }] });
        else if (delta.type === 'input_json_delta' && tools.has(data.index)) {
          out.push({ ...head(), choices: [{ index: 0, delta: { tool_calls: [{ index: tools.get(data.index), function: { arguments: delta.partial_json || '' } }] } }] });
        }
      } else if (event === 'message_delta') {
        if (data.delta?.stop_reason) stop = STOP[data.delta.stop_reason] || 'stop';
        if (data.usage) usage = { ...(usage || {}), ...data.usage };
      } else if (event === 'message_stop') {
        out.push({ ...head(), choices: [{ index: 0, delta: {}, finish_reason: stop }], usage: anthropicUsage(usage || {}) });
      } else if (event === 'error') {
        out.push({ ...head(), error: { message: data.error?.message || 'errore del provider', type: data.error?.type } });
      }
      return out;
    };
  }

  /** Gemini's parts of a content, from a message's content. */
  function geminiParts(content) {
    const parts = [];
    if (typeof content === 'string') { if (content) parts.push({ text: content }); }
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part) continue;
        if (typeof part === 'string') { parts.push({ text: part }); continue; }
        if (part.type === 'text') parts.push({ text: String(part.text || '') });
        else if (part.type === 'image_url') {
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url || '';
          const data = /^data:([^;]+);base64,(.+)$/.exec(url);
          if (data) parts.push({ inlineData: { mimeType: data[1], data: data[2] } });
          else parts.push({ fileData: { fileUri: url } });
        } else if (part.type === 'input_audio' && part.input_audio?.data) {
          parts.push({ inlineData: { mimeType: `audio/${part.input_audio.format || 'wav'}`, data: part.input_audio.data } });
        } else if (part.type === 'file' && part.file?.file_data) {
          parts.push({ inlineData: { mimeType: 'application/pdf', data: String(part.file.file_data).replace(/^data:[^,]+,/, '') } });
        }
      }
    }
    return parts;
  }

  /** What a JSON schema of a tool keeps for Gemini: the fields it knows. */
  function geminiSchema(schema) {
    if (!schema || typeof schema !== 'object') return undefined;
    const out = {};
    for (const key of ['type', 'description', 'enum', 'format', 'nullable', 'required', 'minimum', 'maximum', 'minItems', 'maxItems']) if (schema[key] !== undefined) out[key] = schema[key];
    if (schema.properties) { out.properties = {}; for (const [name, value] of Object.entries(schema.properties)) out.properties[name] = geminiSchema(value); }
    if (schema.items) out.items = geminiSchema(schema.items);
    if (Array.isArray(schema.anyOf)) out.anyOf = schema.anyOf.map(geminiSchema);
    if (out.type && typeof out.type === 'string') out.type = out.type.toUpperCase();
    return out;
  }

  const EFFORT_GEMINI = { low: 1024, medium: 8192, high: 24576 };

  /** The request as the Gemini API takes it. The tool calls carry their ids in the names of the responses. */
  function toGemini(payload, native, model = null) {
    const system = [];
    const contents = [];
    const callNames = new Map(); // tool call id -> function name, for the results
    for (const message of payload.messages || []) {
      if (!message) continue;
      if (message.role === 'system' || message.role === 'developer') { system.push(...geminiParts(message.content)); continue; }
      if (message.role === 'tool') {
        let response;
        const text = textOf(message.content);
        try { response = JSON.parse(text); } catch { response = { result: text }; }
        if (!response || typeof response !== 'object' || Array.isArray(response)) response = { result: response };
        contents.push({ role: 'user', parts: [{ functionResponse: { name: callNames.get(String(message.tool_call_id)) || 'tool', response } }] });
        continue;
      }
      if (message.role === 'assistant') {
        const parts = geminiParts(message.content);
        for (const call of message.tool_calls || []) {
          let args = {};
          try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
          callNames.set(String(call.id), String(call.function?.name || ''));
          parts.push({ functionCall: { name: String(call.function?.name || ''), args } });
        }
        if (parts.length) contents.push({ role: 'model', parts });
        continue;
      }
      const parts = geminiParts(message.content);
      if (parts.length) contents.push({ role: 'user', parts });
    }
    const folded = [];
    for (const content of contents) {
      const last = folded[folded.length - 1];
      if (last && last.role === content.role) last.parts.push(...content.parts); else folded.push(content);
    }
    const generationConfig = {};
    if (payload.temperature !== undefined && payload.temperature !== null) generationConfig.temperature = payload.temperature;
    if (payload.top_p !== undefined && payload.top_p !== null) generationConfig.topP = payload.top_p;
    if (payload.top_k !== undefined && payload.top_k !== null) generationConfig.topK = payload.top_k;
    if (payload.max_tokens || payload.max_completion_tokens) generationConfig.maxOutputTokens = Number(payload.max_tokens || payload.max_completion_tokens);
    if (payload.stop) generationConfig.stopSequences = Array.isArray(payload.stop) ? payload.stop : [payload.stop];
    if (payload.response_format?.type === 'json_object' || payload.response_format?.type === 'json_schema') {
      generationConfig.responseMimeType = 'application/json';
      const schema = payload.response_format.json_schema?.schema;
      if (schema) generationConfig.responseSchema = geminiSchema(schema);
    }
    const effort = payload.reasoning?.effort;
    if (effort && model?.hasReasoning !== false) {
      generationConfig.thinkingConfig = effort === 'none' ? { thinkingBudget: 0 } : { thinkingBudget: EFFORT_GEMINI[effort] || EFFORT_GEMINI.medium, includeThoughts: true };
    }
    const body = { contents: folded };
    if (system.length) body.systemInstruction = { parts: system };
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    if (Array.isArray(payload.tools) && payload.tools.length && payload.tool_choice !== 'none') {
      body.tools = [{ functionDeclarations: payload.tools.filter(tool => tool?.function).map(tool => ({
        name: String(tool.function.name || ''), description: String(tool.function.description || ''),
        ...(tool.function.parameters && Object.keys(tool.function.parameters.properties || {}).length ? { parameters: geminiSchema(tool.function.parameters) } : {})
      })) }];
      const choice = payload.tool_choice;
      if (choice === 'required') body.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
      else if (choice?.function?.name) body.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.function.name] } };
    }
    return body;
  }

  function geminiUsage(meta = {}) {
    const prompt = Number(meta.promptTokenCount) || 0;
    const cached = Number(meta.cachedContentTokenCount) || 0;
    const thoughts = Number(meta.thoughtsTokenCount) || 0;
    const out = (Number(meta.candidatesTokenCount) || 0) + thoughts;
    return {
      prompt_tokens: prompt, completion_tokens: out, total_tokens: prompt + out,
      prompt_tokens_details: { cached_tokens: cached },
      completion_tokens_details: { reasoning_tokens: thoughts }
    };
  }

  const FINISH = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter', MALFORMED_FUNCTION_CALL: 'stop' };

  /** One answer of Gemini (a whole one, or one piece of its stream), as a chat completion or a chunk. */
  function fromGemini(body, native, asChunk, counter) {
    const candidate = body.candidates?.[0] || {};
    const content = candidate.content || {};
    let text = '';
    let reasoning = '';
    const calls = [];
    for (const part of content.parts || []) {
      if (part.functionCall) {
        calls.push({ index: counter.calls, id: `call_${Date.now().toString(36)}_${counter.calls}`, type: 'function', function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) } });
        counter.calls += 1;
      } else if (typeof part.text === 'string') {
        if (part.thought) reasoning += part.text; else text += part.text;
      }
    }
    const finish = candidate.finishReason ? (calls.length || counter.calls ? (candidate.finishReason === 'STOP' ? 'tool_calls' : FINISH[candidate.finishReason] || 'stop') : FINISH[candidate.finishReason] || 'stop') : null;
    const usage = body.usageMetadata ? geminiUsage(body.usageMetadata) : undefined;
    const head = { id: body.responseId || `gemini-${counter.started}`, created: Math.floor(counter.started / 1000), model: body.modelVersion || native };
    if (!asChunk) {
      const message = { role: 'assistant', content: text };
      if (reasoning) message.reasoning = reasoning;
      if (calls.length) message.tool_calls = calls;
      return { ...head, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish || (calls.length ? 'tool_calls' : 'stop') }], usage };
    }
    const delta = {};
    if (text) delta.content = text;
    if (reasoning) delta.reasoning = reasoning;
    if (calls.length) delta.tool_calls = calls;
    const chunk = { ...head, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] };
    if (usage) chunk.usage = usage;
    if (body.error) chunk.error = { message: body.error.message || 'errore del provider' };
    return chunk;
  }

  /* ------------------------------------------------------------------ */
  /* The answer, as a stream of OpenRouter's chunks                       */
  /* ------------------------------------------------------------------ */

  /** A stream of server-sent events read line by line: each event's name and data handed to `onEvent`. */
  function readEvents(body, onEvent, onEnd) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = null;
    let data = [];
    const flush = () => {
      if (data.length) {
        const text = data.join('\n');
        if (text.trim() && text.trim() !== '[DONE]') { let parsed = null; try { parsed = JSON.parse(text); } catch {} if (parsed) onEvent(event, parsed); }
      }
      event = null; data = [];
    };
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const raw of lines) {
            const line = raw.replace(/\r$/, '');
            if (!line) { flush(); continue; }
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
        }
        if (buffer) { const line = buffer.replace(/\r$/, ''); if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, '')); }
        flush();
        onEnd(null);
      } catch (error) { onEnd(error); }
    })();
  }

  /** The chunks, written as OpenRouter writes them. */
  function sseResponse(status, headers, chunkStream) {
    return new Response(chunkStream, { status, statusText: 'OK', headers: { 'Content-Type': 'text/event-stream', ...headers } });
  }

  function chunkStream(start) {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        const send = chunk => controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
        const end = (error) => {
          if (error) { try { controller.error(error); } catch {} return; }
          try { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); } catch {}
        };
        start(send, end);
      }
    });
  }

  /** Anthropic's answer, streamed or whole, as the shape the app reads. */
  async function answerFromAnthropic(response, native, wantStream) {
    if (!response.ok) return response;
    if (!wantStream) {
      const body = await response.json();
      return new Response(JSON.stringify(fromAnthropic(body, native)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const translate = anthropicChunks(native);
    return sseResponse(200, {}, chunkStream((send, end) => {
      readEvents(response.body, (event, data) => { for (const chunk of translate(event || data.type, data)) send(chunk); }, end);
    }));
  }

  async function answerFromGemini(response, native, wantStream) {
    if (!response.ok) return response;
    const counter = { calls: 0, started: Date.now() };
    if (!wantStream) {
      const body = await response.json();
      return new Response(JSON.stringify(fromGemini(body, native, false, counter)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return sseResponse(200, {}, chunkStream((send, end) => {
      readEvents(response.body, (event, data) => send(fromGemini(data, native, true, counter)), end);
    }));
  }

  /** An error of a maker, said the way OpenRouter says one, so the app shows it the same. */
  async function asOpenRouterError(response) {
    let message = `${response.status} ${response.statusText}`;
    let body = null;
    try { body = await response.clone().json(); } catch {}
    const found = body?.error?.message || body?.message || (Array.isArray(body) && body[0]?.error?.message);
    if (found) message = String(found);
    return new Response(JSON.stringify({ error: { message, code: response.status } }), { status: response.status, headers: { 'Content-Type': 'application/json' } });
  }

  /**
   * The request sent the direct way and the answer given back as OpenRouter
   * would give it. `route` is what `routeFor` said; `model` the catalogue's
   * entry, for what it knows of the model.
   */
  async function call(route, payload, options = {}, model = null) {
    const { provider, model: native } = route;
    const key = getKey(provider.id);
    const wantStream = payload.stream === true;
    const headers = { 'Content-Type': 'application/json', ...provider.headers(key) };
    let url = provider.chat;
    let body;
    if (provider.format === 'anthropic') body = toAnthropic(payload, native, model);
    else if (provider.format === 'gemini') {
      body = toGemini(payload, native, model);
      url = provider.chat.replace('{model}', encodeURIComponent(native)).replace('{method}', wantStream ? 'streamGenerateContent?alt=sse' : 'generateContent');
    } else body = toOpenAI(payload, native);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal });
    if (!response.ok) return asOpenRouterError(response);
    if (provider.format === 'anthropic') return answerFromAnthropic(response, native, wantStream);
    if (provider.format === 'gemini') return answerFromGemini(response, native, wantStream);
    return response;
  }

  window.modelProviders = {
    PROVIDERS, load, getKey, setKey, test, listModels, setRoute, setPreferDirect,
    providerOf, nativeId, directOf, routeFor, extraModels, call,
    toOpenAI, toAnthropic, fromAnthropic, anthropicChunks, anthropicUsage, toGemini, fromGemini, geminiUsage,
    routes: () => ({ ...state.routes }), preferDirect: () => state.preferDirect, checked: id => state.checked[id] || null, models: id => state.models[id] || [],
    // For the tests: the provider's list of models, without asking anyone.
    _setModels: (id, list) => { state.models[id] = list; }, _setKey: (id, key) => { state.keys[id] = key; }
  };
})();
