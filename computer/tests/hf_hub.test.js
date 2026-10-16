'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HuggingFaceHub, cardExcerpt } = require('../server/hf-hub');

const CARD = `---
license: apache-2.0
base_model: acme/Model-7B
---

<div align="center">
  <img
    src="https://example.org/logo.png"
    alt="Acme"
  />
  <a href="https://example.org"><strong>Docs</strong></a> •
  <a href="https://example.org/chat"><strong>Chat</strong></a>
</div>

# Model-7B
[![badge](https://example.org/b.svg)](https://example.org)

**Model-7B** is a general-purpose model for [on-device](https://example.org/x) use. It reads text &amp; writes text.
It has the following features:
- Type: causal language model
- Context: 32,768 tokens

\`\`\`
llama-cli -hf acme/Model-7B-GGUF --temp 0.1 and a long line of code that is not prose.
\`\`\`

| Quant | Size |
|-------|------|
| Q4    | 4 GB |

> A note in a quote that is long enough to be taken for a sentence of the card.

A second paragraph that says how the model was trained, in one sentence.
`;

test('the description of a model is the prose of its card, without markup, lists, tables and code', () => {
  assert.equal(cardExcerpt(CARD),
    'Model-7B is a general-purpose model for on-device use. It reads text & writes text. It has the following features: '
    + 'A second paragraph that says how the model was trained, in one sentence.');
  assert.equal(cardExcerpt('---\nlicense: mit\n---\n\n# Title\n\n- only\n- a list\n'), null);
  assert.equal(cardExcerpt(''), null);
});

test('a long card is cut at the end of a sentence', () => {
  const sentence = 'This sentence is part of a long description of the model. ';
  const excerpt = cardExcerpt(sentence.repeat(40));
  assert.ok(excerpt.length <= 600);
  assert.ok(excerpt.endsWith('model.'));
});

/** A Hub that answers from a table of addresses and keeps what it was asked. */
function fakeHub(answers) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    const key = Object.keys(answers).find(prefix => String(url).startsWith(prefix));
    if (!key) return new Response('not found', { status: 404 });
    const body = answers[key];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  };
  return { hub: new HuggingFaceHub({ fetchImpl }), asked };
}

test('the search filters are the ones of the Hub, and what the Hub tagged comes back with each repository', async () => {
  const { hub, asked } = fakeHub({
    'https://huggingface.co/api/models?': [{
      id: 'acme/Model-7B-GGUF', downloads: 10, likes: 2, gated: false,
      tags: ['gguf', 'base_model:acme/Model-7B', 'base_model:quantized:acme/Model-7B', 'license:apache-2.0'],
      gguf: { total: 7e9, architecture: 'llama', context_length: 32768 }
    }]
  });
  const page = await hub.search({ query: 'model', size: '3to8', license: 'Apache-2.0', author: 'acme', access: 'open' });
  const params = new URL(asked[0]).searchParams;
  assert.equal(params.get('num_parameters'), 'min:3B,max:8B');
  assert.deepEqual(params.getAll('filter'), ['gguf', 'license:apache-2.0']);
  assert.equal(params.get('author'), 'acme');
  assert.equal(params.get('gated'), 'false');
  assert.equal(params.get('search'), 'model');
  assert.equal(page.repos[0].license, 'apache-2.0');
  assert.equal(page.repos[0].baseModel, 'acme/Model-7B');

  // Nothing asked for, nothing added.
  await hub.search({});
  const plain = new URL(asked[1]).searchParams;
  for (const name of ['num_parameters', 'author', 'gated']) assert.equal(plain.get(name), null);
  assert.deepEqual(plain.getAll('filter'), ['gguf']);

  for (const bad of [{ size: 'huge' }, { license: 'a b' }, { author: 'a/b' }, { access: 'maybe' }]) {
    await assert.rejects(() => hub.search(bad));
  }
  assert.equal(asked.length, 2);
});

test('a repository of converted files is described by the card of the model they come from', async () => {
  const info = (tags) => ({ id: 'conv/Model-7B-GGUF', sha: 'abc', siblings: [], tags, cardData: { base_model: 'acme/Model-7B' } });
  const own = '# Files\n\nThese are the converted files of the model, in several sizes to choose from.\n';
  const cards = {
    'https://huggingface.co/acme/Model-7B/resolve/main/README.md': '# Model\n\nModel-7B is a model that writes text, described by the people who made it.\n',
    'https://huggingface.co/conv/Model-7B-GGUF/resolve/abc/README.md': own
  };

  const converted = fakeHub({ 'https://huggingface.co/api/models/conv/Model-7B-GGUF': info(['base_model:quantized:acme/Model-7B']), ...cards });
  assert.equal((await converted.hub.repo('conv/Model-7B-GGUF')).description, 'Model-7B is a model that writes text, described by the people who made it.');

  // A model tuned from another one is a different model: its own card describes it.
  const tuned = fakeHub({ 'https://huggingface.co/api/models/conv/Model-7B-GGUF': info(['base_model:finetune:acme/Model-7B']), ...cards });
  assert.equal((await tuned.hub.repo('conv/Model-7B-GGUF')).description, 'These are the converted files of the model, in several sizes to choose from.');
  assert.ok(!tuned.asked.some(url => url.includes('/acme/Model-7B/')));

  // No card that can be read: no description, and the repository is still listed.
  const bare = fakeHub({ 'https://huggingface.co/api/models/conv/Model-7B-GGUF': info([]) });
  assert.equal((await bare.hub.repo('conv/Model-7B-GGUF')).description, null);
});
