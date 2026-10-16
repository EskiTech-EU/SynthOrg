/**
 * SynthOrg - OpenRouter Model Capability Registry & Normalizer
 * Tabulates all models, modalities, input/output capabilities, supported parameters, context, and pricing.
 */

const EXCLUDED_MODELS = new Set([
  'openrouter/auto',
  'openrouter/auto-beta',
  'openrouter/bodybuilder',
  'openrouter/fusion'
]);

function isExcludedModel(id) {
  if (!id) return true;
  if (EXCLUDED_MODELS.has(id)) return true;
  if (id.startsWith('openrouter/auto')) return true;
  if (id.includes('bodybuilder')) return true;
  if (id === 'openrouter/fusion') return true;
  if (id.includes(':batch')) return true;
  return false;
}

class OpenRouterCatalog {
  constructor() {
    this.models = [];
    this.lastUpdated = null;
    this.isLoading = false;
    this.storageKey = 'synthorg_openrouter_catalog_cache';
    this.apiKeyKey = 'synthorg_openrouter_api_key';
    this._inMemoryApiKey = '';
  }

  getApiKey() {
    return this._inMemoryApiKey || localStorage.getItem(this.apiKeyKey) || '';
  }

  setApiKey(key) {
    const trimmed = (key || '').trim();
    this._inMemoryApiKey = trimmed;
    try {
      if (!trimmed) {
        localStorage.removeItem(this.apiKeyKey);
      } else {
        localStorage.setItem(this.apiKeyKey, trimmed);
      }
    } catch {}
    if (window.chatStorage?.setSetting) {
      window.chatStorage.setSetting('openrouter_api_key', trimmed).catch(() => {});
    }
  }

  async syncApiKey() {
    try {
      if (window.chatStorage?.getSetting) {
        const res = await window.chatStorage.getSetting('openrouter_api_key');
        if (res?.value) {
          this._inMemoryApiKey = res.value;
          try { localStorage.setItem(this.apiKeyKey, res.value); } catch {}
          return res.value;
        }
      }
    } catch {}
    const local = localStorage.getItem(this.apiKeyKey) || '';
    if (local) {
      this._inMemoryApiKey = local;
      window.chatStorage?.setSetting?.('openrouter_api_key', local).catch(() => {});
    }
    return this._inMemoryApiKey;
  }

  loadCached() {
    try {
      const cached = localStorage.getItem(this.storageKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        const rawList = parsed.models || [];
        this.models = rawList.filter(m => !isExcludedModel(m.id));
        this.lastUpdated = parsed.lastUpdated ? new Date(parsed.lastUpdated) : null;
        return true;
      }
    } catch (e) {
      console.warn('Error reading cached catalog:', e);
    }
    return false;
  }

  saveCache() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({
        lastUpdated: this.lastUpdated,
        models: this.models
      }));
    } catch (e) {
      console.warn('Failed to cache catalog:', e);
    }
  }

  /**
   * Fetches models directly from OpenRouter API and normalizes capability matrix
   */
  async fetchModels(forceRefresh = false) {
    if (this.isLoading) return this.models;
    this.isLoading = true;

    try {
      const headers = {
        'HTTP-Referer': 'https://github.com/SynthOrg/SynthOrg',
        'X-Title': 'SynthOrg AI Orchestrator'
      };

      const apiKey = this.getApiKey();
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      // OpenRouter partitions specialized modalities (transcription/whisper, speech/tts, image, video) across query parameters
      const endpoints = [
        'https://openrouter.ai/api/v1/models',
        'https://openrouter.ai/api/v1/models?output_modalities=transcription',
        'https://openrouter.ai/api/v1/models?output_modalities=speech',
        'https://openrouter.ai/api/v1/models?output_modalities=image',
        'https://openrouter.ai/api/v1/models?output_modalities=video'
      ];

      const responses = await Promise.allSettled(
        endpoints.map(url => fetch(url, { headers }).then(r => {
          if (!r.ok) return { data: [] };
          return r.json();
        }))
      );

      const modelMap = new Map();
      for (const res of responses) {
        if (res.status === 'fulfilled' && res.value && Array.isArray(res.value.data)) {
          for (const m of res.value.data) {
            if (!modelMap.has(m.id)) {
              modelMap.set(m.id, m);
            } else {
              const existing = modelMap.get(m.id);
              const exArch = existing.architecture || {};
              const newArch = m.architecture || {};
              const inMods = Array.from(new Set([...(exArch.input_modalities || []), ...(newArch.input_modalities || [])]));
              const outMods = Array.from(new Set([...(exArch.output_modalities || []), ...(newArch.output_modalities || [])]));
              existing.architecture = {
                ...exArch,
                ...newArch,
                input_modalities: inMods,
                output_modalities: outMods
              };
            }
          }
        }
      }

      const rawModels = Array.from(modelMap.values());

      if (!rawModels.length) {
        throw new Error('No models returned from OpenRouter endpoints');
      }

      // The half-price twins OpenRouter lists apart — "… (batch)", id ending in
      // ":batch" — are not models of their own: they are the same model, served
      // from the queue. They stay out of the list and become a switch on the
      // model they belong to.
      const twins = new Map();
      for (const m of rawModels) {
        if (typeof m.id === 'string' && m.id.endsWith(':batch')) twins.set(m.id.slice(0, -6), m);
      }
      // Filter out meta-models (auto-router, bodybuilder, fusion) and offline batch-only endpoints (:batch)
      const filteredRaw = rawModels.filter(m => !isExcludedModel(m.id));

      this.models = filteredRaw.map(m => {
        const model = this.normalizeModel(m);
        const twin = twins.get(model.id);
        if (twin) model.batch = this.batchVariant(model, twin);
        return model;
      });
      this.lastUpdated = new Date();
      this.saveCache();
      await this.mergeLocalModels();
      this.mergeDirectModels();

      return this.models;
    } catch (err) {
      console.error('Failed to fetch OpenRouter models:', err);
      // Fallback to cache if available
      if (!this.models.length) {
        this.loadCached();
      }
      // Local models do not depend on the network: keep them listed offline.
      await this.mergeLocalModels();
      this.mergeDirectModels();
      throw err;
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Adds the GGUF models served by the local engine. They go through the same
   * normalization as remote ones, so every list and filter treats them alike.
   * Never cached: the folder is read fresh each time.
   */
  async mergeLocalModels() {
    let listing;
    try { listing = await window.chatStorage.request('/local-models'); } catch { return; }
    if (!listing?.engineAvailable) return;
    // Context, vision, thinking and recommended sampling are what the GGUF
    // header and the engine state about each file (server/local-models.js).
    const locals = (listing.models || []).filter(m => m.readable !== false).map(m => ({
      ...this.normalizeModel({
        id: m.id,
        name: m.name,
        description: m.description,
        context_length: m.contextLength || 0,
        architecture: { input_modalities: m.vision ? ['text', 'image'] : ['text'], output_modalities: ['text'], tokenizer: 'gguf' },
        pricing: { prompt: '0', completion: '0' },
        supported_parameters: ['temperature', 'top_p', 'top_k', 'min_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty',
          'seed', 'max_tokens', 'stop', 'tools', 'tool_choice', 'response_format', 'structured_outputs', 'logprobs', 'top_logprobs',
          ...(m.thinking ? ['include_reasoning'] : []),
          // Only templates the engine says take an effort level get the control.
          ...(m.caps?.supports_reasoning_effort ? ['reasoning_effort'] : [])]
      }),
      isLocal: true,
      recommendedParameters: m.recommended || {}
    }));
    this.models = [...this.models.filter(m => !m.isLocal), ...locals];
  }

  /**
   * Adds what the makers list under their own keys and the catalogue does not
   * have (providers.js, extraModels): one list, so a model reachable only
   * directly is chosen like any other. Little is known of such a model: text
   * in and out, tools, no price (its cost stays unknown in the record).
   */
  mergeDirectModels() {
    const providers = window.modelProviders;
    if (!providers?.extraModels) return;
    const kept = this.models.filter(m => !m.isDirectOnly);
    const extras = providers.extraModels(kept.map(m => m.id)).map(extra => ({
      ...this.normalizeModel({
        id: extra.id, name: extra.name, description: '',
        architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'unknown' },
        pricing: {},
        supported_parameters: ['temperature', 'top_p', 'max_tokens', 'stop', 'tools', 'tool_choice', 'response_format']
      }),
      isDirectOnly: true,
      directProvider: extra.direct
    }));
    // No price is known for them: not free, unlisted (their cost stays a gap in the record).
    for (const extra of extras) { extra.pricing.billing = 'unlisted'; extra.pricing.isFree = false; }
    this.models = [...kept, ...extras];
  }

  /**
   * What the queued twin of a model costs and accepts, or null when there is
   * nothing to gain: a few twins cost the same, and a handful cost more.
   */
  batchVariant(model, raw) {
    const twin = this.normalizeModel(raw);
    const base = model.pricing.promptPerM;
    const saving = base > 0 ? 1 - twin.pricing.promptPerM / base : 0;
    if (!(saving > 0.01)) return null;
    return {
      id: twin.id,
      promptPerM: twin.pricing.promptPerM,
      completionPerM: twin.pricing.completionPerM,
      savingPercent: Math.round(saving * 100),
      supportedParameters: twin.supportedParameters
    };
  }

  /**
   * Normalizes a raw OpenRouter model item into an indexed capability record
   */
  normalizeModel(raw) {
    const id = raw.id || '';
    const name = raw.name || id;
    const provider = id.includes('/') ? id.split('/')[0] : 'unknown';
    const supportedParams = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];

    // Modalities parsing
    const arch = raw.architecture || {};
    const inputMods = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
    const outputMods = Array.isArray(arch.output_modalities) ? arch.output_modalities : [];
    const modalityStr = arch.modality || '';

    let hasVision = inputMods.includes('image');
    let hasAudioIn = inputMods.includes('audio');
    let hasFileIn = inputMods.includes('file');
    let hasVideoIn = inputMods.includes('video');
    let hasImageOut = outputMods.includes('image');
    let hasVideoOut = outputMods.includes('video');
    let hasAudioOut = outputMods.includes('audio') || outputMods.includes('speech');
    let hasTranscriptionOut = outputMods.includes('transcription');

    if (!inputMods.length && modalityStr) {
      const parts = modalityStr.split('->');
      const inPart = parts[0] || '';
      const outPart = parts[1] || '';
      hasVision = inPart.includes('image');
      hasAudioIn = inPart.includes('audio');
      hasFileIn = inPart.includes('file');
      hasVideoIn = inPart.includes('video');
      hasImageOut = outPart.includes('image');
      hasVideoOut = outPart.includes('video');
      hasAudioOut = outPart.includes('audio') || outPart.includes('speech');
      hasTranscriptionOut = outPart.includes('transcription');
    }

    // Protocol & capability flags
    const hasTools = supportedParams.includes('tools');
    const hasToolChoice = supportedParams.includes('tool_choice');
    const hasStructuredOutputs = supportedParams.includes('structured_outputs');
    const hasResponseFormat = supportedParams.includes('response_format');
    const hasReasoning = supportedParams.includes('reasoning') || 
                         supportedParams.includes('include_reasoning') || 
                         supportedParams.includes('reasoning_effort') || 
                         !!raw.reasoning;

    // Dedicated search & web grounding capability
    const hasWebSearch = Boolean(
      provider === 'perplexity' ||
      id.includes('sonar') ||
      id.endsWith(':online') ||
      id === 'relace/relace-search'
    );

    // Reasoning metadata
    const reasoningMeta = raw.reasoning || null;

    // Context & limit metrics
    const contextLength = raw.context_length || 0;
    const topProvider = raw.top_provider || {};
    const maxCompletionTokens = topProvider.max_completion_tokens || 0;
    const isModerated = Boolean(topProvider.is_moderated);

    // Pricing calculation (Normalized to $ per 1 Million Tokens)
    const pricing = raw.pricing || {};
    const promptPricePerToken = parseFloat(pricing.prompt || '0');
    const completionPricePerToken = parseFloat(pricing.completion || '0');
    const cacheReadPricePerToken = parseFloat(pricing.input_cache_read || '0');

    const isAutoRouter = (id === 'openrouter/auto');
    const isFusionRouter = (id === 'openrouter/fusion');
    const isVariablePricing = isAutoRouter || isFusionRouter || (promptPricePerToken < 0) || (completionPricePerToken < 0);

    const promptPerM = isVariablePricing ? -1 : promptPricePerToken * 1000000;
    const completionPerM = isVariablePricing ? -1 : completionPricePerToken * 1000000;
    const cacheReadPerM = isVariablePricing ? -1 : cacheReadPricePerToken * 1000000;
    
    const hasAnyPrice = Object.entries(pricing).some(([key, val]) => {
      if (key === 'overrides') return false;
      return parseFloat(val) > 0;
    });
    // The catalog prices everything per token, but transcription is billed on
    // audio length, video and music per clip, some images per image. For those
    // the token figures are zero or meaningless, so classify how the model is
    // billed: 'free', 'variable', 'unlisted' (no price in the catalog),
    // 'nonToken' (paid, not per token) or 'token'.
    const textOut = outputMods.length ? outputMods.includes('text') : (!modalityStr || (modalityStr.split('->')[1] || '').includes('text'));
    const mediaOut = !textOut || hasVideoOut || hasAudioOut || hasImageOut;
    const listedAsZero = !isVariablePricing && !hasAnyPrice;
    let billing;
    if (id.endsWith(':free')) billing = 'free';
    else if (hasTranscriptionOut) billing = 'nonToken';
    else if (listedAsZero) billing = mediaOut ? 'unlisted' : 'free';
    else if (isVariablePricing) billing = 'variable';
    else if (promptPricePerToken === 0 && completionPricePerToken === 0) billing = 'nonToken';
    else if (!textOut && completionPricePerToken === 0) billing = 'nonToken';
    else billing = 'token';
    const isFree = billing === 'free';

    return {
      id,
      name,
      provider,
      description: raw.description || '',
      created: raw.created ? new Date(raw.created * 1000) : null,
      contextLength,
      maxCompletionTokens,
      isModerated,
      isAutoRouter,
      isFusionRouter,
      isVariablePricing,
      // Modalities
      inputModalities: inputMods.length ? inputMods : ['text'],
      outputModalities: outputMods.length ? outputMods : ['text'],
      hasVision,
      hasAudioIn,
      hasFileIn,
      hasVideoIn,
      hasImageOut,
      hasVideoOut,
      hasAudioOut,
      hasTranscriptionOut,
      // Capabilities & Parameters
      hasTools,
      hasToolChoice,
      hasStructuredOutputs,
      hasResponseFormat,
      hasReasoning,
      hasWebSearch,
      reasoningMeta,
      supportedParameters: supportedParams,
      // The voices a speech model takes, as OpenRouter lists them (empty: it chooses its own).
      supportedVoices: Array.isArray(raw.supported_voices) ? raw.supported_voices.filter(v => typeof v === 'string') : [],
      tokenizer: arch.tokenizer || 'unknown',
      // Pricing ($/1M tokens)
      pricing: {
        promptPerM,
        completionPerM,
        cacheReadPerM,
        isFree,
        billing,
        isAutoRouter,
        isVariablePricing: isAutoRouter,
        rawPrompt: pricing.prompt,
        rawCompletion: pricing.completion,
        overrides: pricing.overrides || []
      },
      // Raw payload for inspector
      raw
    };
  }

  /**
   * Filters and sorts models based on user constraints
   */
  filterModels({
    query = '',
    provider = 'all',
    visionOnly = false,
    audioInOnly = false,
    fileInOnly = false,
    toolsOnly = false,
    structuredOutputsOnly = false,
    reasoningOnly = false,
    freeOnly = false,
    minContext = 0,
    sortBy = 'name',
    sortOrder = 'asc'
  } = {}) {
    let list = this.models.filter(m => {
      // Text search
      if (query) {
        const q = query.toLowerCase();
        const match = m.id.toLowerCase().includes(q) ||
                      m.name.toLowerCase().includes(q) ||
                      m.provider.toLowerCase().includes(q) ||
                      m.description.toLowerCase().includes(q);
        if (!match) return false;
      }

      // Provider filter
      if (provider !== 'all' && m.provider.toLowerCase() !== provider.toLowerCase()) {
        return false;
      }

      // Modalities
      if (visionOnly && !m.hasVision) return false;
      if (audioInOnly && !m.hasAudioIn) return false;
      if (fileInOnly && !m.hasFileIn) return false;

      // Capabilities
      if (toolsOnly && !m.hasTools) return false;
      if (structuredOutputsOnly && !(m.hasStructuredOutputs || m.hasResponseFormat)) return false;
      if (reasoningOnly && !m.hasReasoning) return false;
      if (freeOnly && !m.pricing.isFree) return false;

      // Context
      if (minContext > 0 && m.contextLength < minContext) return false;

      return true;
    });

    // Sorting
    list.sort((a, b) => {
      let valA, valB;
      switch (sortBy) {
        case 'context':
          valA = a.contextLength;
          valB = b.contextLength;
          break;
        case 'promptPrice':
          valA = a.pricing.promptPerM;
          valB = b.pricing.promptPerM;
          break;
        case 'completionPrice':
          valA = a.pricing.completionPerM;
          valB = b.pricing.completionPerM;
          break;
        case 'created':
          valA = a.created ? a.created.getTime() : 0;
          valB = b.created ? b.created.getTime() : 0;
          break;
        case 'provider':
          valA = a.provider;
          valB = b.provider;
          break;
        case 'name':
        default:
          valA = a.name.toLowerCase();
          valB = b.name.toLowerCase();
          break;
      }

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    return list;
  }

  getDistinctProviders() {
    const set = new Set();
    this.models.forEach(m => {
      if (m.provider) set.add(m.provider);
    });
    return Array.from(set).sort();
  }

  getStats() {
    const total = this.models.length;
    let vision = 0;
    let tools = 0;
    let reasoning = 0;
    let structured = 0;
    let free = 0;
    let audio = 0;
    let largeContext = 0;

    for (const m of this.models) {
      if (m.hasVision) vision++;
      if (m.hasTools) tools++;
      if (m.hasReasoning) reasoning++;
      if (m.hasStructuredOutputs || m.hasResponseFormat) structured++;
      if (m.pricing.isFree) free++;
      if (m.hasAudioIn || m.hasAudioOut) audio++;
      if (m.contextLength >= 128000) largeContext++;
    }

    return {
      total,
      vision,
      tools,
      reasoning,
      structured,
      free,
      audio,
      largeContext
    };
  }

  /**
   * Generates the hierarchical taxonomy:
   * Category (Input combo -> Output combo) -> Provider -> Models with tags
   */
  getCategoriesHierarchy() {
    const categories = {};

    for (const m of this.models) {
      const inSorted = m.inputModalities.slice().sort();
      const outSorted = m.outputModalities.slice().sort();
      const catKey = `${inSorted.join('+')} -> ${outSorted.join('+')}`;

      if (!categories[catKey]) {
        categories[catKey] = {
          key: catKey,
          inputModalities: inSorted,
          outputModalities: outSorted,
          totalModels: 0,
          providers: {}
        };
      }

      const cat = categories[catKey];
      cat.totalModels++;

      if (!cat.providers[m.provider]) {
        cat.providers[m.provider] = [];
      }

      // Model leaf with capability tags
      cat.providers[m.provider].push({
        id: m.id,
        name: m.name,
        provider: m.provider,
        contextLength: m.contextLength,
        maxCompletionTokens: m.maxCompletionTokens,
        tags: {
          tools: m.hasTools,
          structured_outputs: m.hasStructuredOutputs || m.hasResponseFormat,
          reasoning: m.hasReasoning,
          is_free: m.pricing.isFree,
          is_moderated: m.isModerated,
          context_tier: m.contextLength >= 1000000 ? '1M+' : (m.contextLength >= 128000 ? '128k+' : (m.contextLength >= 32000 ? '32k+' : 'standard')),
          price_tier: m.pricing.isFree ? 'free' : m.pricing.billing !== 'token' ? m.pricing.billing : (m.pricing.promptPerM < 1 ? 'budget' : (m.pricing.promptPerM > 10 ? 'frontier' : 'standard'))
        },
        pricing: {
          promptPerM: m.pricing.promptPerM,
          completionPerM: m.pricing.completionPerM,
          isFree: m.pricing.isFree
        }
      });
    }

    // Sort models inside each provider by name
    for (const cat of Object.values(categories)) {
      for (const prov of Object.keys(cat.providers)) {
        cat.providers[prov].sort((a, b) => a.name.localeCompare(b.name));
      }
    }

    return categories;
  }

  /**
   * Exports the JSON schema format ready to be exposed as an Orchestrator Tool
   */
  getToolDefinition() {
    const hierarchy = this.getCategoriesHierarchy();
    const availableCategories = Object.keys(hierarchy).map(k => ({
      category: k,
      models_count: hierarchy[k].totalModels,
      providers: Object.keys(hierarchy[k].providers)
    }));

    return {
      name: "synthorg_model_catalog",
      description: "Query and discover AI models by I/O Modality Category, Provider, and Capability Tags (tools, reasoning, structured_outputs, context, pricing).",
      categories_summary: availableCategories,
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "The I/O modality combo category (e.g. 'text -> text', 'image+text -> text', 'file+image+text -> text')",
            enum: Object.keys(hierarchy)
          },
          provider: {
            type: "string",
            description: "Optional provider filter (e.g. 'anthropic', 'openai', 'deepseek', 'google', 'meta-llama')"
          },
          required_capabilities: {
            type: "array",
            items: {
              type: "string",
              enum: ["tools", "structured_outputs", "reasoning", "is_free"]
            },
            description: "Required capability tags that the model must satisfy"
          },
          min_context_tokens: {
            type: "integer",
            description: "Minimum context window tokens required for the task"
          }
        },
        required: ["category"]
      }
    };
  }
}

window.openRouterCatalog = new OpenRouterCatalog();
