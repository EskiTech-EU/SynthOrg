/**
 * Model gateway: one door for every chat completion.
 * Remote models go to OpenRouter untouched. Local models (id "local/…") go to
 * the llama.cpp engines the storage service runs on this machine, one per
 * loaded model, which speak the same protocol; a model is loaded on first use.
 */
(() => {
  const OPENROUTER_CHAT = 'https://openrouter.ai/api/v1/chat/completions';
  const OPENROUTER_BATCH = 'https://openrouter.ai/api/v1/batches';
  const LOCAL_PREFIX = 'local/';
  // How often the queue is asked about the turn: soon at first, then rarely.
  const BATCH_POLL_FIRST_MS = 2000;
  const BATCH_POLL_MAX_MS = 20000;
  // How many times the queue may answer "never heard of it" before we believe it.
  const BATCH_UNKNOWN_TRIES = 15;
  // Tuning the queued twin may not take; sent anyway, the job is refused.
  const TUNING_PARAMS = ['temperature', 'top_p', 'top_k', 'min_p', 'frequency_penalty',
    'presence_penalty', 'repetition_penalty', 'logprobs', 'top_logprobs'];
  // Loading a model is bounded by its size and the disk, not by a timer.
  const START_TIMEOUT_MS = 60 * 60 * 1000;
  // Fields only OpenRouter understands.
  const REMOTE_ONLY = ['provider', 'session_id', 'include_reasoning', 'reasoning', 'usage', 'transforms', 'models', 'route'];

  const engines = new Map(); // model id → { id, port, apiKey, parallel }
  let stopSignal = null; // set by the chat for the running turn: the user's stop button

  /** One signal out of several; tolerates missing ones. */
  function anySignal(...signals) {
    const list = signals.filter(Boolean);
    if (list.length < 2) return list[0];
    return AbortSignal.any(list);
  }

  const isLocal = (modelId) => typeof modelId === 'string' && modelId.startsWith(LOCAL_PREFIX);

  async function ensureEngine(modelId, parallel = 4) {
    const known = engines.get(modelId);
    if (known && known.parallel >= parallel) return known;
    const engine = await window.chatStorage.request('/local-models/start', 'POST', { id: modelId, parallel }, START_TIMEOUT_MS);
    engines.set(modelId, engine);
    return engine;
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

  /**
   * The chat templates of many local models take one system message, and only as the first: anything else makes
   * the engine refuse the request ("System message must be at the beginning"). What a provider accepts anywhere —
   * a note added along the conversation, a second system message — is gathered here into one, at the start.
   */
  function systemFirst(messages) {
    if (!Array.isArray(messages)) return messages;
    const isSystem = (message) => message?.role === 'system' || message?.role === 'developer';
    const systems = messages.filter(isSystem);
    if (!systems.length || (systems.length === 1 && messages[0] === systems[0] && systems[0].role === 'system')) return messages;
    const textOf = (content) => (typeof content === 'string' ? content
      : Array.isArray(content) ? content.map(part => (typeof part === 'string' ? part : part?.text || '')).filter(Boolean).join('\n') : '');
    const text = systems.map(message => textOf(message.content)).filter(Boolean).join('\n\n');
    return [{ role: 'system', content: text }, ...messages.filter(message => !isSystem(message))];
  }

  /**
   * Turns of the user that follow one another with nothing between them (an answer that never came) are one turn
   * for a local template: many refuse two in a row, and a small model answers them all at once, badly.
   */
  function oneTurnEach(messages) {
    if (!Array.isArray(messages)) return messages;
    const out = [];
    for (const message of messages) {
      const last = out[out.length - 1];
      if (last && last.role === 'user' && message?.role === 'user' && typeof last.content === 'string' && typeof message.content === 'string') {
        out[out.length - 1] = { ...last, content: `${last.content}\n${message.content}` };
      } else out.push(message);
    }
    return out;
  }

  /**
   * What a model wrote, without what it thought before writing it: a block between thinking tags, or — when the
   * template opened the block itself and only its end is in the text — everything up to that end.
   */
  function withoutThinking(text) {
    let out = String(text ?? '').replace(/<(think|thinking|thought|reasoning|reflection)[^>]*>[\s\S]*?<\/\1>/gi, '');
    const end = out.search(/<\/(think|thinking|thought|reasoning|reflection)>/i);
    if (end >= 0) out = out.slice(out.indexOf('>', end) + 1);
    return out.trim();
  }

  /** Same payload the caller built for OpenRouter, adapted to the local engine. */
  function toLocalPayload(payload) {
    const model = window.openRouterCatalog?.models?.find(m => m.id === payload.model);
    const local = stripCacheControl({ ...payload });
    local.messages = oneTurnEach(systemFirst(local.messages));
    // The effort chosen for a remote model travels in `reasoning`; a local
    // template that takes one reads it as a variable of its own.
    const effort = (model?.supportedParameters || []).includes('reasoning_effort') ? payload.reasoning?.effort : null;
    for (const key of REMOTE_ONLY) delete local[key];
    // The authors' recommended sampling applies wherever the user set nothing.
    for (const [key, value] of Object.entries(model?.recommendedParameters || {})) {
      if (local[key] === undefined) local[key] = value;
    }
    // The engine's name for the same parameter.
    if (local.repetition_penalty !== undefined) { local.repeat_penalty = local.repetition_penalty; delete local.repetition_penalty; }
    // Hybrid models only think when the template is told to, explicitly.
    if (model?.hasReasoning) local.chat_template_kwargs = { enable_thinking: true, ...(local.chat_template_kwargs || {}) };
    if (effort) local.chat_template_kwargs = { ...(local.chat_template_kwargs || {}), reasoning_effort: effort };
    local.cache_prompt = true;
    return local;
  }

  async function localFetch(path, body, signal, parallel) {
    const send = async () => {
      const { port, apiKey } = await ensureEngine(body.model, parallel);
      return fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal
      });
    };
    try { return await send(); } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
      engines.delete(body.model); // engine gone (app restarted, model unloaded): load it again once
      return send();
    }
  }

  // --- the same turn, queued -------------------------------------------------
  //
  // Half the price is served from another door: the batch API takes a job of
  // requests and answers when it has run them. Nothing above this file changes
  // — the turn is the same turn, tool calls included, and the caller gets the
  // stream it asked for; only later. Whether the wait is worth the saving is
  // the user's call, made once in the model's parameters.

  /** The queued twin of a model, as the catalogue folded it in; null if none. */
  const batchTwin = (modelId) => window.openRouterCatalog?.models?.find(m => m.id === modelId)?.batch || null;

  /** The queue carries text: a turn with an image, a file or audio goes the usual way. */
  function isTextOnly(payload) {
    return (payload.messages || []).every(message => !Array.isArray(message.content)
      || message.content.every(part => !part || part.type === 'text'));
  }

  /** Says how long this turn has been queued, for whoever is drawing the wait. */
  function announceWait(detail) {
    window.dispatchEvent(new CustomEvent('synthorg-batch-wait', { detail }));
  }

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });

  /** The chat completion inside a finished batch, whatever shape it arrives in. */
  async function completionOf(batch, customId, headers) {
    let results = batch.results ?? batch.output ?? null;
    if (typeof results === 'string') {
      const res = await fetch(results, { headers });
      const text = await res.text();
      results = text.trim().split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    }
    const list = Array.isArray(results) ? results : Array.isArray(results?.data) ? results.data : null;
    if (!list?.length) throw new Error('Batch: il lavoro è finito senza risposta.');
    const row = list.find(r => (r?.custom_id ?? r?.customId) === customId) || list[0];
    const failure = row?.error || row?.response?.error;
    if (failure) throw new Error(failure.message || String(failure));
    const body = row?.response?.body ?? row?.response ?? row?.body ?? row;
    if (!body?.choices?.length) throw new Error('Batch: risposta senza contenuto.');
    return body;
  }

  /** The finished answer, handed back as the stream the caller asked for. */
  function asResponse(completion, wantStream) {
    if (!wantStream) {
      return new Response(JSON.stringify(completion), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const choice = completion.choices?.[0] || {};
    const message = choice.message || {};
    const head = { id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: completion.model };
    const chunks = [];
    const reasoning = message.reasoning || message.reasoning_content;
    if (reasoning) chunks.push({ ...head, choices: [{ index: 0, delta: { reasoning } }] });
    if (message.content) chunks.push({ ...head, choices: [{ index: 0, delta: { content: message.content } }] });
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      chunks.push({ ...head, choices: [{ index: 0, delta: { tool_calls: message.tool_calls.map((call, index) => ({
        index, id: call.id, type: 'function',
        function: { name: call.function?.name || '', arguments: call.function?.arguments || '' }
      })) } }] });
    }
    chunks.push({ ...head, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }], usage: completion.usage });
    const body = chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  async function fetchBatched(payload, options, twin) {
    const headers = { ...(options.headers || {}), 'Content-Type': 'application/json' };
    const allowed = new Set(twin.supportedParameters || []);
    const body = { ...payload, model: twin.id, stream: false };
    if (allowed.size) { for (const key of TUNING_PARAMS) { if (key in body && !allowed.has(key)) delete body[key]; } }
    const customId = 'chat-' + Date.now().toString(36);
    // The API reads `model` before `requests` and refuses the job otherwise.
    const job = {
      model: twin.id,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
      requests: [{ custom_id: customId, method: 'POST', url: '/v1/chat/completions', body }]
    };
    const since = Date.now();
    announceWait({ jobId: null, status: 'sending', since });
    const created = await fetch(OPENROUTER_BATCH, { method: 'POST', headers, body: JSON.stringify(job) });
    // What the queue refuses, it refuses in the same shape as a chat call: the
    // caller shows it the way it shows any other error.
    if (!created.ok) { announceWait(null); return created; }
    const jobId = (await created.json())?.id;
    if (!jobId) { announceWait(null); throw new Error('Batch: il lavoro non ha ricevuto un identificativo.'); }
    announceWait({ jobId, status: 'queued', since });

    let wait = BATCH_POLL_FIRST_MS;
    // A job accepted a moment ago is not yet answerable: for a little while the
    // queue says it does not know it. That is not the job being lost.
    let unknown = 0;
    for (;;) {
      try {
        await sleep(wait, stopSignal);
      } catch (error) {
        // The stop button: the job goes with it, so nothing keeps running on the bill.
        fetch(OPENROUTER_BATCH + '/' + jobId + '/cancel', { method: 'POST', headers }).catch(() => {});
        announceWait(null);
        throw error;
      }
      const res = await fetch(OPENROUTER_BATCH + '/' + jobId, { headers });
      if (res.status === 404 && ++unknown <= BATCH_UNKNOWN_TRIES) continue;
      if (!res.ok) { announceWait(null); return res; }
      unknown = 0;
      const batch = await res.json();
      if (batch.status === 'completed') {
        announceWait(null);
        return asResponse(await completionOf(batch, customId, headers), payload.stream === true);
      }
      if (['failed', 'cancelled', 'expired'].includes(batch.status)) {
        announceWait(null);
        throw new Error(batch.error?.message || 'Batch: il lavoro è terminato come "' + batch.status + '".');
      }
      announceWait({ jobId, status: batch.status, since });
      wait = Math.min(BATCH_POLL_MAX_MS, Math.round(wait * 1.5));
    }
  }

  // --- what each request cost -------------------------------------------------
  //
  // Every request that goes through this door is written down as it ends:
  // where it was made, what for, the model, the tokens, the cost the provider
  // gave, how long it took. The answer goes to the caller as it came: what is
  // read here is a copy of the stream. Nothing of what was asked or answered
  // is kept, only its numbers.
  //
  // `track` in the options of a call says what the call is: { conversationId,
  // role, turn }. Without it the role is read from the call's title and the
  // chat from its session. It is not part of the request.

  const GENERATION = 'https://openrouter.ai/api/v1/generation?id=';
  const TITLES = {
    'SynthOrg Orchestrator': 'master', 'SynthOrg Microtask': 'microtask', 'SynthOrg Compaction': 'compaction',
    'SynthOrg Realtime': 'realtime', 'SynthOrg Tour': 'speech', 'SynthOrg Computer Use': 'computer_use',
    'SynthOrg Voice Delegate': 'speech', 'SynthOrg STT Delegate': 'transcription', 'SynthOrg Image Delegate': 'image',
    'SynthOrg Video Delegate': 'video', 'SynthOrg Music Delegate': 'music'
  };
  const ENDPOINTS = [[/\/audio\/speech/, 'speech'], [/\/audio\/transcriptions/, 'transcription'], [/\/images/, 'image'], [/\/videos/, 'video']];
  const RESOLVE_FIRST_MS = 20000;   // the provider knows what a request cost some seconds after it ended
  const RESOLVE_AGAIN_MS = 90000;
  const TURN_MS = 30 * 60000;       // a request of a chat belongs to its Master's turn for this long
  const turns = new Map();          // chat -> { turn, at }: the Master's turn under way
  let resolving = null;

  const header = (headers, name) => {
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) || '';
    const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
    return key ? String(headers[key]) : '';
  };

  /** What a call is, from what it says of itself and from how it is made. */
  function describe(url, options, payload, track = {}) {
    const title = header(options.headers, 'X-Title');
    const conversationId = track.conversationId || header(options.headers, 'x-session-id') || null;
    const role = track.role || (ENDPOINTS.find(([pattern]) => pattern.test(url)) || [])[1] || TITLES[title] || 'other';
    let turn = track.turn || null;
    if (conversationId && role === 'master' && turn) turns.set(conversationId, { turn, at: Date.now() });
    if (conversationId && !turn) {
      const known = turns.get(conversationId);
      if (known && Date.now() - known.at < TURN_MS) turn = known.turn;
    }
    return {
      conversationId, role, turn,
      place: /^SynthOrg (Realtime|Tour)$/.test(title) ? 'realtime' : undefined,
      model: String(payload?.model || ''),
      local: isLocal(payload?.model),
      started: Date.now()
    };
  }

  function write(info, result) {
    if (!info.model || typeof window.chatStorage?.request !== 'function') return;
    const usage = result.usage || {};
    const timings = result.timings || {};
    const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? timings.prompt_n;
    const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? timings.predicted_n;
    // What was read from a cache, under the name each provider gives it (DeepSeek: hits).
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? usage.prompt_cache_hit_tokens ?? timings.cache_n;
    // A maker asked directly gives no cost in money: worked out from the catalogue's prices, and said so.
    const priced = usage.cost == null && info.direct && !info.local ? priceOf(info.model, promptTokens, completionTokens, cachedTokens) : null;
    window.chatStorage.request('/usage', 'POST', {
      conversationId: info.conversationId, role: info.role, turn: info.turn, place: info.place,
      model: info.model, provider: result.provider || (info.direct ? `direct:${info.direct}` : null), local: info.local, queued: Boolean(info.queued),
      ok: result.ok !== false, stopped: Boolean(result.stopped),
      promptTokens,
      completionTokens,
      cachedTokens,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
      cost: usage.cost ?? priced,
      costSource: usage.cost != null ? 'provider' : priced != null ? 'priced' : null,
      generation: result.generation || null,
      ms: Date.now() - info.started,
      firstMs: result.firstAt ? result.firstAt - info.started : null
    }).then(saved => { if (saved?.waiting) resolveLater(RESOLVE_FIRST_MS); }).catch(() => {});
  }

  /**
   * What a request cost by the catalogue's prices: the tokens read at the
   * prompt price, the ones read from the cache at the cache price (the prompt
   * price where the catalogue has none), the ones written at the completion
   * price. Null for a model the catalogue does not price per token.
   */
  function priceOf(modelId, promptTokens, completionTokens, cachedTokens) {
    const model = window.openRouterCatalog?.models?.find(m => m.id === modelId);
    const pricing = model?.pricing;
    if (!pricing || pricing.billing !== 'token' || !(pricing.promptPerM >= 0) || !(pricing.completionPerM >= 0)) return null;
    const prompt = Math.max(0, Number(promptTokens) || 0);
    const cached = Math.min(prompt, Math.max(0, Number(cachedTokens) || 0));
    const completion = Math.max(0, Number(completionTokens) || 0);
    const cacheRate = pricing.cacheReadPerM > 0 ? pricing.cacheReadPerM : pricing.promptPerM;
    const cost = ((prompt - cached) * pricing.promptPerM + cached * cacheRate + completion * pricing.completionPerM) / 1e6;
    return Math.round(cost * 1e8) / 1e8;
  }

  /** The costs the provider had not given when the requests ended, asked for by their generation. */
  function resolveLater(ms) {
    // A page without a clock of its own (a test) asks for nothing later.
    if (resolving || typeof setTimeout !== 'function') return;
    resolving = setTimeout(async () => {
      resolving = null;
      const key = window.openRouterCatalog?.getApiKey?.();
      if (!key) return;
      let left = 0;
      try {
        for (const row of await window.chatStorage.request('/usage/pending')) {
          if (Date.now() - Date.parse(row.at) < RESOLVE_FIRST_MS - 2000) { left++; continue; }
          const res = await fetch(GENERATION + encodeURIComponent(row.generation), { headers: { Authorization: `Bearer ${key}` } });
          const data = res.ok ? (await res.json().catch(() => null))?.data : null;
          if (data && Number.isFinite(Number(data.total_cost))) {
            await window.chatStorage.request(`/usage/${row.id}`, 'PUT', { cost: Number(data.total_cost), promptTokens: data.tokens_prompt, completionTokens: data.tokens_completion, provider: data.provider_name });
          } else left++;
        }
      } catch { left++; }
      if (left) resolveLater(RESOLVE_AGAIN_MS);
    }, ms);
  }

  /**
   * The answer handed on to the caller as it is, and read beside it for its
   * numbers: the usage a stream ends with, the moment of its first word, the
   * generation a cost can be asked by.
   */
  function observe(response, info) {
    try {
      const generation = header(response.headers, 'x-generation-id');
      // An answer that is not a stream to copy (an error, no body) is written down by what is known of it.
      if (!response.ok || !response.body || typeof response.body.tee !== 'function' || typeof Response !== 'function') {
        write(info, { ok: response.ok, generation: response.ok ? generation : null });
        return response;
      }
      const [mine, theirs] = response.body.tee();
      const kind = header(response.headers, 'content-type');
      const found = { generation, ok: true };
      (async () => {
        const reader = mine.getReader();
        const decoder = new TextDecoder();
        let text = '';
        const event = (line) => {
          if (!line.startsWith('data:')) return;
          const body = line.slice(5).trim();
          if (!body || body === '[DONE]') return;
          let chunk;
          try { chunk = JSON.parse(body); } catch { return; }
          if (chunk.usage) found.usage = chunk.usage;
          if (chunk.timings) found.timings = chunk.timings;
          if (chunk.provider) found.provider = chunk.provider;
          if (chunk.error) found.ok = false;
          const delta = chunk.choices?.[0]?.delta;
          if (!found.firstAt && delta && (delta.content || delta.reasoning || delta.reasoning_content || delta.tool_calls || delta.audio)) found.firstAt = Date.now();
        };
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (/event-stream/.test(kind)) {
              text += decoder.decode(value, { stream: true });
              const lines = text.split('\n');
              text = lines.pop();
              lines.forEach(event);
            } else if (/json/.test(kind)) {
              text += decoder.decode(value, { stream: true });
            } else if (!found.firstAt) found.firstAt = Date.now();
          }
          if (/event-stream/.test(kind)) event(text);
          else if (/json/.test(kind)) {
            let body = null;
            try { body = JSON.parse(text); } catch {}
            if (body?.usage) found.usage = body.usage;
            if (body?.timings) found.timings = body.timings;
            if (body?.provider) found.provider = body.provider;
            if (body?.error) found.ok = false;
          }
        } catch {
          // Ended before its end: by the stop button, or by a fault on the way.
          found.stopped = stopSignal?.aborted === true;
          found.ok = found.stopped && Boolean(found.firstAt);
        }
        write(info, found);
      })();
      return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch {
      return response;
    }
  }

  /** A call made, and written down when it ends; a call that could not be made is written down as one that failed. */
  async function tracked(info, run) {
    try {
      return observe(await run(), info);
    } catch (error) {
      write(info, { ok: false, stopped: stopSignal?.aborted === true });
      throw error;
    }
  }

  /** fetch() for the provider's other doors (speech, transcriptions, images, videos), written down the same way. */
  function fetchApi(url, options = {}) {
    const { track, ...request } = options;
    let payload = null;
    try { payload = JSON.parse(request.body); } catch {}
    return tracked(describe(String(url), request, payload, track), () => fetch(url, request));
  }

  /** Drop-in for fetch(OPENROUTER_CHAT, options). */
  async function fetchChat(options = {}) {
    // `registry`: the model registry of the chat making the call, for its own
    // parameters; `track`: what the call is, for the record. Neither is part
    // of the request.
    // `stop`: what stops the turn this request belongs to, when it is not the chat's own stop button (a turn
    // in the background, a plan). Apart from `signal`, which also carries the caller's wall-clock timeout.
    const { registry, track, stop = null, ...request } = options;
    options = request;
    const halt = anySignal(stop, stopSignal) || null;
    let payload;
    try { payload = JSON.parse(options.body); } catch { payload = null; }
    if (!payload) return fetch(OPENROUTER_CHAT, { ...options, signal: anySignal(options.signal, stopSignal) });
    // A chat with local models of its own takes the place, in memory, of the chat before it (local-keeper.js).
    if (isLocal(payload.model) && track?.conversationId) await window.localKeeper?.using(track.conversationId);
    const info = describe(OPENROUTER_CHAT, options, payload, track);
    // A model on this computer says how much it read and wrote when it is asked to.
    const local = (body) => toLocalPayload(body.stream === true ? { ...body, stream_options: { include_usage: true, ...(body.stream_options || {}) } } : body);

    const params = (registry || window.operationalRegistry)?.getModelParameters?.(payload.model) || {};
    if (params.graph_enabled === true && payload.stream === true && window.graphReasoning) {
      const model = window.openRouterCatalog?.models?.find(m => m.id === payload.model);
      const branches = Math.max(2, parseInt(params.graph_branches, 10) || 3);
      const canFork = model?.isLocal === true || (model?.supportedParameters || []).includes('top_logprobs');
      // Each request the graph makes is one on the bill: written down one by one.
      const route = isLocal(payload.model) ? null : window.modelProviders?.routeFor?.(payload.model);
      const send = isLocal(payload.model)
        ? (body, signal) => tracked({ ...info, started: Date.now() }, () => localFetch('/v1/chat/completions', local(body), anySignal(signal, halt), branches))
        : route
          ? (body, signal) => tracked({ ...info, direct: route.provider.id, started: Date.now() }, () => window.modelProviders.call(route, body, { signal: anySignal(signal, halt) }, model))
          : (body, signal) => tracked({ ...info, started: Date.now() }, () => fetch(OPENROUTER_CHAT, { ...options, body: JSON.stringify(body), signal: anySignal(signal, halt) }));
      return window.graphReasoning.run({ send, payload, stopSignal: halt, settings: {
        branches,
        entropy: params.graph_entropy === true && canFork,
        guidance: (params.graph_guidance || '').trim(),
        structured: Boolean(model?.hasStructuredOutputs || model?.hasResponseFormat)
      } });
    }

    if (!isLocal(payload.model)) {
      // The model's maker, asked directly, when its key is here and the model's way says so (providers.js): the
      // request in the maker's format, the answer in OpenRouter's. The queue is OpenRouter's alone.
      const route = window.modelProviders?.routeFor?.(payload.model);
      if (route) {
        const model = window.openRouterCatalog?.models?.find(m => m.id === payload.model) || null;
        return tracked({ ...info, direct: route.provider.id }, () => window.modelProviders.call(route, payload, { signal: anySignal(options.signal, stopSignal) }, model));
      }
      // Queued: the caller's signal is a wall-clock timeout sized for an answer
      // that comes back at once, and this one waits its turn, so only the stop
      // button ends it.
      const twin = params.batch_enabled === true ? batchTwin(payload.model) : null;
      if (twin && isTextOnly(payload)) return tracked({ ...info, queued: true }, () => fetchBatched(payload, options, twin));
      return tracked(info, () => fetch(OPENROUTER_CHAT, { ...options, signal: anySignal(options.signal, stopSignal) }));
    }
    // The caller's signal is a wall-clock timeout sized for a remote API; a local
    // model thinking at length must end on its own EOS, not on that timer.
    return tracked(info, () => localFetch('/v1/chat/completions', local(payload), halt || undefined));
  }

  // The costs still waiting from the last time the app was open.
  resolveLater(RESOLVE_FIRST_MS + 15000);

  window.modelGateway = { systemFirst, oneTurnEach, withoutThinking, setStopSignal: (signal) => { stopSignal = signal || null; }, isLocal, fetchChat, fetchApi, ensureEngine, localFetch, toLocalPayload, forgetEngine: (modelId) => (modelId ? engines.delete(modelId) : engines.clear()) };
})();
