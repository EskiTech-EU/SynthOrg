'use strict';
// What a GGUF file says about itself. The header is read with Hugging Face's
// own parser and nothing is guessed from file names: context, layers, the size
// of the attention cache, the sampling its authors recommend and the chat
// template all come from the metadata the file carries.
const { gguf, GGMLFileQuantizationType } = require('@huggingface/gguf');

// `general.sampling.*` as llama.cpp writes it → the names the requests use.
const SAMPLING_KEYS = {
  temp: 'temperature',
  top_k: 'top_k',
  top_p: 'top_p',
  min_p: 'min_p',
  xtc_probability: 'xtc_probability',
  xtc_threshold: 'xtc_threshold',
  penalty_last_n: 'repeat_last_n',
  penalty_repeat: 'repetition_penalty',
  mirostat: 'mirostat',
  mirostat_tau: 'mirostat_tau',
  mirostat_eta: 'mirostat_eta'
};
// The attention cache holds keys and values as 16-bit floats unless told otherwise.
const KV_BYTES_PER_VALUE = 2;

const number = (value) => (typeof value === 'bigint' ? Number(value) : (typeof value === 'number' && Number.isFinite(value) ? value : null));
const text = (value) => (typeof value === 'string' && value ? value : null);

/**
 * Bytes of attention cache one token of context takes, summed over the layers:
 * heads × (key length + value length) per layer, as llama.cpp sizes it. null
 * when the architecture does not declare what is needed (no attention cache,
 * or a layout of its own): then only the engine can tell.
 */
function kvBytesPerToken(metadata, arch) {
  const get = (name) => metadata[`${arch}.${name}`];
  const layers = number(get('block_count'));
  const heads = get('attention.head_count');
  const headsKv = get('attention.head_count_kv') ?? heads;
  const embedding = number(get('embedding_length'));
  if (!layers || heads === undefined || !embedding) return null;
  const perLayer = (value, layer) => number(Array.isArray(value) ? value[layer] : value);
  let total = 0;
  for (let layer = 0; layer < layers; layer++) {
    const n = perLayer(heads, layer);
    const nKv = perLayer(headsKv, layer);
    if (!n || nKv === null) return null;
    const keyLength = number(get('attention.key_length')) ?? embedding / n;
    const valueLength = number(get('attention.value_length')) ?? embedding / n;
    total += nKv * (keyLength + valueLength) * KV_BYTES_PER_VALUE;
  }
  return total || null;
}

function summarize({ metadata, parameterCount }) {
  const arch = text(metadata['general.architecture']);
  const type = text(metadata['general.type']);
  const template = text(metadata['tokenizer.chat_template']);
  const sampling = {};
  for (const [key, name] of Object.entries(SAMPLING_KEYS)) {
    const value = number(metadata[`general.sampling.${key}`]);
    if (value !== null) sampling[name] = Number(value.toPrecision(7));
  }
  const fileType = number(metadata['general.file_type']);
  const splitCount = number(metadata['split.count']);
  return {
    name: text(metadata['general.name']),
    description: text(metadata['general.description']),
    architecture: arch,
    // A projector is the half of a vision model that reads the image: it is
    // loaded next to a model, never on its own.
    projector: type === 'mmproj' || type === 'projector' || arch === 'clip',
    adapter: type === 'adapter',
    quantization: fileType === null ? null : (GGMLFileQuantizationType[fileType] || null),
    sizeLabel: text(metadata['general.size_label']),
    organization: text(metadata['general.organization']),
    license: text(metadata['general.license']),
    parameterCount: number(parameterCount),
    contextLength: arch ? number(metadata[`${arch}.context_length`]) : null,
    layers: arch ? number(metadata[`${arch}.block_count`]) : null,
    kvBytesPerToken: arch ? kvBytesPerToken(metadata, arch) : null,
    chatTemplate: Boolean(template),
    // The template's own switch for thinking; what the engine declares once
    // the model is loaded is kept next to this.
    templateThinking: Boolean(template && template.includes('enable_thinking')),
    sampling,
    split: splitCount && splitCount > 1 ? { index: number(metadata['split.no']) || 0, count: splitCount } : null
  };
}

async function readLocal(filePath) {
  return summarize(await gguf(filePath, { allowLocalFile: true, computeParametersCount: true }));
}

/** The same header, read from the Hub with range requests: no download. */
async function readRemote(url, { headers = {}, fetchImpl = globalThis.fetch } = {}) {
  return summarize(await gguf(url, { additionalFetchHeaders: headers, fetch: fetchImpl, computeParametersCount: true }));
}

module.exports = { readLocal, readRemote, summarize };
