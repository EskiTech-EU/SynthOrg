/**
 * Graph reasoning. Model-agnostic: it only needs a streaming chat endpoint.
 *
 *   1. open K continuations of the turn so far and cut each at the end of a
 *      thought (we own the history, so we stop a stream whenever we like);
 *   2. if they differ, a separate, complete inference compares them, then a
 *      structured-output turn states the choice. The judge's own thinking is
 *      dropped as soon as its answer is closed;
 *   3. re-inject the chosen path as the partial assistant turn and go on,
 *      until the model ends the turn by itself.
 *
 * With "entropy" on, a single trunk is streamed instead and branches open only
 * at the thoughts the model is unsure how to begin.
 *
 * The result is exposed as an ordinary SSE Response, so the chat code consumes
 * it exactly like a plain completion.
 */
(() => {
  const STEP_END = '\n\n';
  // Entropy (nats, over the top 10 tokens, so at most ln 10 = 2.30) of the FIRST
  // token of a new thought. Mid-sentence entropy only measures wording ("it" vs
  // "the"); at the start of a thought it measures direction ("Thus" vs "But" vs
  // "Now check"). Measured on MiniCPM5-2B: median 1.08, settled passages ~0,
  // real turning points 1.5–2.1; above this value ~30% of thoughts open branches.
  const FORK_ENTROPY_NATS = 1.5;
  const TOP_LOGPROBS = 10;
  const SAMPLING_KEYS = ['temperature', 'top_p', 'top_k', 'min_p', 'top_a', 'frequency_penalty', 'presence_penalty', 'repetition_penalty'];

  const judgePrompt = (pathText, options, guidance) =>
    `Below is a reasoning in progress and ${options.length} alternative ways to continue it. Your task is ONLY to compare the alternatives; do not continue or finish the reasoning yourself.\n\n` +
    `REASONING SO FAR:\n${pathText.trim() || '(just started)'}\n\nALTERNATIVE CONTINUATIONS:\n` +
    options.map((text, i) => `Option ${i}: ${text.trim()}`).join('\n\n') +
    `\n\nWhere do the alternatives differ? Which ones are correct? Which one moves forward, and which ones only repeat or reopen something already settled? Conclude by naming the best option.` +
    (guidance ? `\n\nAdditional criteria from the user for choosing:\n${guidance}` : '');

  /** Reads one SSE chat stream. onDelta may return false to cut the stream there. */
  async function readStream(response, controller, onDelta) {
    if (!response.ok) throw new Error(`Modello (${response.status}): ${await response.text()}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '', finish = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let json; try { json = JSON.parse(data); } catch { continue; }
          if (json.error) throw new Error(json.error.message || 'Errore durante lo streaming.');
          const choice = json.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finish = choice.finish_reason;
          if (onDelta(choice) === false) { controller.abort(); return 'cut'; }
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError') return 'cut';
      throw error;
    }
    return finish || 'stop';
  }

  const entropyOf = (top) => {
    const probs = top.map(t => Math.exp(t.logprob));
    const total = probs.reduce((a, b) => a + b, 0);
    return total > 0 ? -probs.reduce((h, p) => h + (p / total) * Math.log(p / total), 0) : 0;
  };

  /**
   * One continuation of `path`. Ends at the end of a thought, at a fork point
   * (entropy mode) or when the model ends the turn.
   */
  async function continuation({ send, base, path, seed, forkOnEntropy, onLive }) {
    const prefill = (path.reasoning || path.content)
      ? [{ role: 'assistant', content: path.content, ...(path.reasoning ? { reasoning_content: path.reasoning, reasoning: path.reasoning } : {}) }]
      : [];
    const body = { ...base, messages: [...base.messages, ...prefill], stream: true, ...(seed === undefined ? {} : { seed }),
      ...(forkOnEntropy ? { logprobs: true, top_logprobs: TOP_LOGPROBS } : {}) };
    const controller = new AbortController();
    const response = await send(body, controller.signal);

    // Some engines echo the re-injected prefix back: strip it before reading the new text.
    const acc = { reasoning: '', content: '' };
    const fresh = (kind) => {
      const prefix = path[kind] || '';
      if (acc[kind].startsWith(prefix)) return acc[kind].slice(prefix.length);
      return prefix.startsWith(acc[kind]) ? '' : acc[kind];
    };
    const toolCalls = [];
    let forked = false, emitted = { reasoning: 0, content: 0 };

    const finish = await readStream(response, controller, (choice) => {
      const delta = choice.delta || {};
      if (forkOnEntropy && !toolCalls.length) {
        // Checked before the token is taken: the undecided token is left to the branches.
        const top = choice.logprobs?.content?.at(-1)?.top_logprobs;
        const kind = (path.content || fresh('content')) ? 'content' : 'reasoning';
        const soFar = (path[kind] || '') + fresh(kind);
        const atThoughtStart = soFar === '' || soFar.endsWith(STEP_END);
        if (atThoughtStart && top?.length > 1 && entropyOf(top) > FORK_ENTROPY_NATS) { forked = true; return false; }
      }
      const r = delta.reasoning_content ?? delta.reasoning;
      if (typeof r === 'string') acc.reasoning += r;
      if (typeof delta.content === 'string') acc.content += delta.content;
      for (const tc of delta.tool_calls || []) {
        const slot = toolCalls[tc.index ?? 0] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
      if (onLive) {
        for (const kind of ['reasoning', 'content']) {
          const text = fresh(kind);
          if (text.length > emitted[kind]) { onLive(kind, text.slice(emitted[kind])); emitted[kind] = text.length; }
        }
      }
      if (toolCalls.length) return true; // never cut inside a tool call
      if (forkOnEntropy) return true;
      const text = fresh(fresh('content') ? 'content' : 'reasoning');
      return !(text.trim() && text.includes(STEP_END));
    });

    const step = { reasoning: fresh('reasoning'), content: fresh('content') };
    if (finish === 'cut' && !forked) {
      // Keep exactly one thought: drop whatever streamed past the boundary.
      const kind = step.content ? 'content' : 'reasoning';
      const lead = step[kind].length - step[kind].trimStart().length;
      const end = step[kind].indexOf(STEP_END, lead);
      if (end >= 0) step[kind] = step[kind].slice(0, end + STEP_END.length);
    }
    return { ...step, toolCalls, forked, done: finish !== 'cut', finish };
  }

  /**
   * A whole answer, read as a stream so that a long evaluation never trips an
   * idle-connection timeout. Only the closed answer is kept: the thinking that
   * led to it is dropped here.
   */
  async function complete(send, body) {
    const controller = new AbortController();
    const response = await send({ ...body, stream: true }, controller.signal);
    let content = '';
    await readStream(response, controller, (choice) => { if (typeof choice.delta?.content === 'string') content += choice.delta.content; return true; });
    // Some providers inline the thinking in the content instead of a separate channel.
    return { content: content.replace(/<(think|thought|reasoning|reflection)>[\s\S]*?<\/\1>/gi, '').trim() };
  }

  /** Evaluation and choice are two independent, complete steps. */
  async function choose({ send, base, path, options, guidance, structured }) {
    const sampling = Object.fromEntries(SAMPLING_KEYS.filter(k => base[k] !== undefined).map(k => [k, base[k]]));
    const question = { role: 'user', content: judgePrompt(path.reasoning + path.content, options, guidance) };
    const evaluation = (await complete(send, { model: base.model, ...sampling, messages: [question] })).content || '';
    if (structured) {
      const verdict = await complete(send, {
        model: base.model, ...sampling, chat_template_kwargs: { enable_thinking: false },
        // Only the closed answer travels on: the judge's thinking is not re-injected.
        messages: [question, { role: 'assistant', content: evaluation }, { role: 'user', content: 'Output the option you concluded is best.' }],
        response_format: { type: 'json_schema', json_schema: { name: 'choice', strict: true, schema: {
          type: 'object', properties: { choice: { type: 'integer', enum: options.map((_, i) => i) } }, required: ['choice'], additionalProperties: false } } }
      });
      try { const n = JSON.parse(verdict.content).choice; if (Number.isInteger(n) && options[n] !== undefined) return n; } catch {}
    }
    // No structured output on this model: read the option its evaluation names last.
    const named = [...evaluation.matchAll(/option\s*(\d+)/gi)].map(m => Number(m[1])).filter(n => options[n] !== undefined);
    return named.length ? named.at(-1) : 0;
  }

  async function explore({ send, base, settings, emit, stopSignal }) {
    // Stopped by the user: whatever was chosen so far is the answer.
    const stoppedHere = { reasoning: '', content: '', toolCalls: [], finish: 'stop' };
    const { branches: K, entropy, guidance, structured } = settings;
    const path = { reasoning: '', content: '' };
    const advance = (step, live) => {
      path.reasoning += step.reasoning; path.content += step.content;
      if (!live) { if (step.reasoning) emit({ reasoning_content: step.reasoning }); if (step.content) emit({ content: step.content }); }
    };
    const seedBase = Number.isFinite(Number(base.seed)) ? Number(base.seed) : Math.floor(Math.random() * 2 ** 31);
    let level = 0;

    for (;;) {
      if (entropy) {
        // Trunk: stream live until the model hesitates or ends the turn.
        const trunk = await continuation({ send, base, path, forkOnEntropy: true,
          onLive: (kind, text) => emit(kind === 'reasoning' ? { reasoning_content: text } : { content: text }) });
        advance(trunk, true);
        if (stopSignal?.aborted) return stoppedHere;
        if (!trunk.forked) return trunk;
      }
      const opened = await Promise.all(Array.from({ length: K }, (_, i) =>
        continuation({ send, base, path, seed: seedBase + level * 1000 + i })));
      level++;
      if (stopSignal?.aborted) return stoppedHere;
      const texts = opened.map(o => (o.reasoning + o.content).trim() + (o.toolCalls.length ? '\n' + JSON.stringify(o.toolCalls.map(t => t.function)) : ''));
      const best = new Set(texts).size === 1 ? 0
        : await choose({ send, base, path, options: texts, guidance, structured });
      if (stopSignal?.aborted) return stoppedHere;
      console.debug(`[grafo] livello ${level}: ${new Set(texts).size === 1 ? 'rami convergenti' : `scelto ramo ${best} di ${K}`}`);
      advance(opened[best], false);
      if (opened[best].done) return opened[best];
    }
  }

  /** Runs the graph and returns it as an SSE Response, like a plain completion. */
  function run({ send, payload, settings, stopSignal }) {
    const encoder = new TextEncoder();
    const { tools, tool_choice, ...rest } = payload;
    const base = { ...rest, ...(tools ? { tools, tool_choice } : {}) };
    const stream = new ReadableStream({
      async start(controller) {
        const write = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        const emit = (delta) => write({ choices: [{ index: 0, delta }] });
        try {
          const last = await explore({ send, base, settings, emit, stopSignal });
          if (last.toolCalls.length) emit({ tool_calls: last.toolCalls.map((tc, index) => ({ index, ...tc })) });
          write({ choices: [{ index: 0, delta: {}, finish_reason: last.toolCalls.length ? 'tool_calls' : (last.finish === 'cut' ? 'stop' : last.finish) }] });
        } catch (error) {
          // A stop that lands while a request is opening surfaces as an abort: end the turn cleanly.
          if (stopSignal?.aborted) write({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          else write({ error: { message: error?.message || String(error) } });
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  window.graphReasoning = { run };
})();
