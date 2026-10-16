'use strict';
// The Hugging Face Hub, asked through its public API: which repositories hold
// GGUF chat models, which files each one has and how large they are. What the
// Hub already parsed out of the GGUF (architecture, context, parameters) is
// taken as it comes; the rest of the header is read from the file itself with
// range requests, so the size is known before anything is downloaded.
const { parseGgufShardFilename, parseGGUFQuantLabel, GGUF_QUANT_ORDER, GGMLFileQuantizationType } = require('@huggingface/gguf');
const { readRemote } = require('./gguf-info');
const { fail } = require('./database');

const BASE = 'https://huggingface.co';
const PAGE = 30;
const SORTS = ['trendingScore', 'downloads', 'likes', 'lastModified', 'createdAt'];
// The Hub's task of a chat model that reads text only, and of one that also reads images.
const KINDS = { text: 'text-generation', vision: 'image-text-to-text' };
const LISTED = ['gguf', 'downloads', 'likes', 'gated', 'lastModified', 'pipeline_tag', 'author', 'tags'];
// What the search can be narrowed by, each one a filter of the Hub's own API:
// the parameter count it read from the GGUF, the licence the authors declared,
// who published the repository, whether its files need an accepted licence.
const SIZES = { upTo3: 'max:3B', '3to8': 'min:3B,max:8B', '8to16': 'min:8B,max:16B', '16to40': 'min:16B,max:40B', over40: 'min:40B' };
const LICENSE_ID = /^[a-z0-9][a-z0-9.+-]{0,39}$/;
const AUTHOR = /^[\w.-]{1,96}$/;
const ACCESS = { open: 'false', gated: 'true' };
// How much of a model card is kept as the description of a model.
const EXCERPT_CHARS = 600;
const EXCERPT_BLOCKS = 3;
const CARD_CHARS = 200000;
// ONNX models for the Foto tab's functions: the Hub's library filter, and the task they are published under.
const ONNX_TASK = 'image-segmentation';
const ONNX_LISTED = ['downloads', 'likes', 'gated', 'lastModified', 'author'];
const REPO_ID = /^[\w.-]{1,96}\/[\w.-]{1,96}$/;
const REQUEST_MS = 30000;
// llama.cpp finds the projector of a repository the same way when it downloads one itself.
const isProjectorName = (name) => /mmproj/i.test(name);

const quantRank = (label) => {
  const index = GGUF_QUANT_ORDER.indexOf(GGMLFileQuantizationType[label]);
  return index === -1 ? GGUF_QUANT_ORDER.length : index;
};

/**
 * The first lines of prose of a model card: what its authors say the model is,
 * without the card's header, markup, tables, lists and code. null when the card
 * has no such lines.
 */
function cardExcerpt(markdown) {
  const body = String(markdown || '').slice(0, CARD_CHARS)
    .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?(```|$)/g, '\n\n')
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '');
  const kept = [];
  let length = 0;
  for (const block of body.split(/\r?\n[ \t]*\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(line => line.trim() && !/^\s*(#|\||!\[|\[!\[)/.test(line));
    if (!lines.length || /^\s*([-*+] |\d+[.)] |>)/.test(lines[0])) continue;
    // A list written right under a sentence is not part of it.
    const list = lines.findIndex(line => /^\s*([-*+] |\d+[.)] )/.test(line));
    if (list > 0) lines.length = list;
    const text = lines.join(' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|\*|`|~~/g, '')
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (all, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }[name]))
      .replace(/\s+/g, ' ').trim();
    // A line of links or a caption is not what the model is.
    if (text.length < 40 || !/[.!?:。]/.test(text)) continue;
    kept.push(text);
    length += text.length;
    if (length >= EXCERPT_CHARS || kept.length === EXCERPT_BLOCKS) break;
  }
  let excerpt = kept.join(' ');
  if (excerpt.length > EXCERPT_CHARS) {
    const cut = excerpt.slice(0, EXCERPT_CHARS);
    const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    excerpt = sentence > EXCERPT_CHARS / 2 ? cut.slice(0, sentence + 1) : cut.slice(0, cut.lastIndexOf(' ')) + '…';
  }
  return excerpt || null;
}

/** The licence and the model a repository derives from, as the Hub wrote them in its tags. */
function fromTags(tags) {
  const list = Array.isArray(tags) ? tags.filter(tag => typeof tag === 'string') : [];
  const value = (prefix) => {
    const tag = list.find(entry => entry.startsWith(prefix) && !/^[a-z]+:/.test(entry.slice(prefix.length)));
    return tag ? tag.slice(prefix.length) : null;
  };
  return { license: value('license:'), baseModel: value('base_model:') };
}

class HuggingFaceHub {
  constructor({ token = () => null, fetchImpl = globalThis.fetch } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
    this.headers = new Map(); // repo@sha → header summary of one of its files
    this.cards = new Map();   // repo@revision → description read from its model card
  }

  authorization() {
    const token = this.token();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async get(url) {
    let response;
    try {
      response = await this.fetch(url, { headers: this.authorization(), signal: AbortSignal.timeout(REQUEST_MS) });
    } catch {
      fail('Hugging Face non è raggiungibile.', 502);
    }
    // Without a key the Hub answers 401 for a repository that does not exist too.
    if (response.status === 401 || response.status === 403) fail(this.token() ? 'Questo repository richiede l’accesso: la licenza va accettata sul sito di Hugging Face con l’account della chiave.' : 'Repository non trovato, oppure richiede l’accesso: in quel caso serve la chiave Hugging Face.', 403);
    if (response.status === 404) fail('Repository non trovato su Hugging Face.', 404);
    if (!response.ok) fail(`Hugging Face ha risposto ${response.status}.`, 502);
    return response;
  }

  /** One page of repositories; `cursor` is the address of the next page, as the Hub gave it. */
  async search({ query = '', sort = 'trendingScore', kind = 'text', size = '', license = '', author = '', access = '', cursor = '' } = {}) {
    let url;
    if (cursor) {
      if (!String(cursor).startsWith(`${BASE}/api/models?`)) fail('Pagina non valida.');
      url = cursor;
    } else {
      const params = new URLSearchParams({ filter: 'gguf', pipeline_tag: KINDS[kind] || KINDS.text, sort: SORTS.includes(sort) ? sort : SORTS[0], direction: '-1', limit: String(PAGE) });
      if (String(query).trim()) params.set('search', String(query).trim().slice(0, 200));
      if (size) { if (!SIZES[size]) fail('Filtro sui parametri non valido.'); params.set('num_parameters', SIZES[size]); }
      license = String(license).trim().toLowerCase();
      if (license) { if (!LICENSE_ID.test(license)) fail('Licenza non valida.'); params.append('filter', `license:${license}`); }
      author = String(author).trim();
      if (author) { if (!AUTHOR.test(author)) fail('Autore non valido.'); params.set('author', author); }
      if (access) { if (!ACCESS[access]) fail('Filtro sull’accesso non valido.'); params.set('gated', ACCESS[access]); }
      for (const field of LISTED) params.append('expand[]', field);
      url = `${BASE}/api/models?${params}`;
    }
    const response = await this.get(url);
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') || '');
    const rows = await response.json();
    return {
      next: next ? next[1] : null,
      repos: (Array.isArray(rows) ? rows : []).map(row => ({
        ...fromTags(row.tags),
        id: row.id,
        author: row.author || String(row.id).split('/')[0],
        downloads: row.downloads || 0,
        likes: row.likes || 0,
        gated: Boolean(row.gated),
        lastModified: row.lastModified || null,
        architecture: row.gguf?.architecture || null,
        contextLength: row.gguf?.context_length || null,
        parameterCount: row.gguf?.total || null
      }))
    };
  }

  /**
   * A repository: its GGUF files grouped as they are loaded (a model split in
   * several parts is one model), each with its size, and the projector that
   * goes with them when the repository has one.
   */
  async repo(id) {
    if (!REPO_ID.test(String(id))) fail('Repository non valido.');
    const info = await (await this.get(`${BASE}/api/models/${id}?blobs=true`)).json();
    const groups = new Map();
    for (const sibling of info.siblings || []) {
      const filePath = sibling.rfilename;
      if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.gguf') || filePath.includes('..')) continue;
      const shard = parseGgufShardFilename(filePath);
      const key = shard ? shard.prefix : filePath;
      const group = groups.get(key) || { parts: [], expected: shard ? Number(shard.total) : 1 };
      group.parts.push({ path: filePath, size: sibling.size || sibling.lfs?.size || 0, sha256: sibling.lfs?.sha256 || null });
      groups.set(key, group);
    }
    const entries = [...groups.values()]
      .filter(group => group.parts.length === group.expected)
      .map(group => {
        const parts = group.parts.sort((a, b) => a.path.localeCompare(b.path));
        const name = parts[0].path.split('/').pop();
        return {
          path: parts[0].path,
          name,
          size: parts.reduce((sum, part) => sum + part.size, 0),
          quantization: parseGGUFQuantLabel(name) || null,
          projector: isProjectorName(name),
          parts
        };
      });
    const projectors = entries.filter(entry => entry.projector);
    const models = entries.filter(entry => !entry.projector).sort((a, b) => a.size - b.size);
    for (const model of models) model.projectorPath = this.projectorFor(model, projectors)?.path || null;
    const baseModel = [].concat(info.cardData?.base_model || [])[0] || null;
    // The Hub marks a repository of converted files with the model they were converted from.
    const convertedFrom = (info.tags || []).map(tag => /^base_model:quantized:(.+)$/.exec(String(tag))?.[1]).find(Boolean) || null;
    const [header, description] = await Promise.all([this.header(info, models), this.describe(info.id, info.sha, convertedFrom)]);
    return {
      id: info.id,
      revision: info.sha,
      author: info.author || String(info.id).split('/')[0],
      gated: Boolean(info.gated),
      downloads: info.downloads || 0,
      likes: info.likes || 0,
      lastModified: info.lastModified || null,
      license: info.cardData?.license || null,
      baseModel,
      description,
      architecture: info.gguf?.architecture || null,
      contextLength: info.gguf?.context_length || null,
      parameterCount: info.gguf?.total || null,
      header,
      models,
      projectors
    };
  }

  /** The projector in the same quantization, or the most precise one there is. */
  projectorFor(model, projectors) {
    if (!projectors.length) return null;
    return projectors.find(p => p.quantization && p.quantization === model.quantization)
      || [...projectors].sort((a, b) => quantRank(a.quantization) - quantRank(b.quantization))[0];
  }

  /**
   * What the header of the repository's model says beyond the Hub's summary:
   * layers and attention cache (to size the memory it takes), recommended
   * sampling. The quantizations of one model share it, so one file is read.
   */
  async header(info, models) {
    if (!models.length) return null;
    const key = `${info.id}@${info.sha}`;
    if (this.headers.has(key)) return this.headers.get(key);
    let header = null;
    try {
      const timed = (url, init = {}) => this.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_MS) });
      header = await readRemote(this.fileUrl(info.id, info.sha, models[0].parts[0].path), { headers: this.authorization(), fetchImpl: timed });
    } catch {}
    if (header) this.headers.set(key, header);
    return header;
  }

  /**
   * What the authors wrote about a model: the opening of a model card. The
   * card of a repository of converted files is about the conversion, so the
   * card read first is the one of the model they were converted from
   * (`convertedFrom`, the same model in another format); the repository's own
   * otherwise, or when that one says nothing.
   */
  async describe(id, revision, convertedFrom = null) {
    const key = `${id}@${revision}`;
    if (this.cards.has(key)) return this.cards.get(key);
    let description = convertedFrom && REPO_ID.test(String(convertedFrom)) ? cardExcerpt(await this.card(convertedFrom, 'main')) : null;
    if (!description) description = cardExcerpt(await this.card(id, revision));
    this.cards.set(key, description);
    return description;
  }

  /** The model card of a repository as it is written; empty when it has none or it cannot be read. */
  async card(id, revision) {
    try { return await (await this.get(this.fileUrl(id, revision, 'README.md'))).text(); } catch { return ''; }
  }

  /**
   * One page of repositories that publish ONNX models for cutting a subject
   * out of a picture (the Hub's own filter and task): what the Foto tab's
   * functions can run. `cursor` as in `search`.
   */
  async searchOnnx({ query = '', sort = 'trendingScore', cursor = '' } = {}) {
    let url;
    if (cursor) {
      if (!String(cursor).startsWith(`${BASE}/api/models?`)) fail('Pagina non valida.');
      url = cursor;
    } else {
      const params = new URLSearchParams({ filter: 'onnx', pipeline_tag: ONNX_TASK, sort: SORTS.includes(sort) ? sort : SORTS[0], direction: '-1', limit: String(PAGE) });
      if (String(query).trim()) params.set('search', String(query).trim().slice(0, 200));
      for (const field of ONNX_LISTED) params.append('expand[]', field);
      url = `${BASE}/api/models?${params}`;
    }
    const response = await this.get(url);
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') || '');
    const rows = await response.json();
    return {
      next: next ? next[1] : null,
      repos: (Array.isArray(rows) ? rows : []).map(row => ({
        id: row.id, author: row.author || String(row.id).split('/')[0], downloads: row.downloads || 0, likes: row.likes || 0,
        gated: Boolean(row.gated), lastModified: row.lastModified || null
      }))
    };
  }

  /**
   * A repository's ONNX files, each with its size and the hash the Hub keeps
   * for it. A model is one file with its weights inside; one that keeps them
   * in a file beside it (`.onnx_data`, `.onnx.data`) is listed as such, and
   * cannot be used: the program loads a single file.
   */
  async repoOnnx(id) {
    // An owner and a name, neither made of dots alone: the id goes into an address.
    if (!REPO_ID.test(String(id)) || String(id).split('/').some(part => /^\.+$/.test(part))) fail('Repository non valido.');
    const info = await (await this.get(`${BASE}/api/models/${id}?blobs=true`)).json();
    const names = new Set((info.siblings || []).map(sibling => sibling.rfilename));
    const files = [];
    for (const sibling of info.siblings || []) {
      const filePath = sibling.rfilename;
      if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.onnx') || filePath.includes('..')) continue;
      files.push({
        path: filePath, name: filePath.split('/').pop(), size: sibling.size || sibling.lfs?.size || 0, sha256: sibling.lfs?.sha256 || null,
        external: names.has(`${filePath}_data`) || names.has(`${filePath}.data`)
      });
    }
    files.sort((a, b) => a.size - b.size);
    return {
      id: info.id, revision: info.sha, author: info.author || String(info.id).split('/')[0], gated: Boolean(info.gated),
      downloads: info.downloads || 0, likes: info.likes || 0, lastModified: info.lastModified || null,
      license: info.cardData?.license || null, files
    };
  }

  fileUrl(repo, revision, filePath) {
    return `${BASE}/${repo}/resolve/${encodeURIComponent(revision)}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  }
}

module.exports = { HuggingFaceHub, SORTS, KINDS, SIZES, cardExcerpt };
