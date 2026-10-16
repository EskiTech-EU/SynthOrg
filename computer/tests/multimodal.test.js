'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Multimodal formatMarkdown correctly parses images, videos, PDFs, archives and code blocks', () => {
  const code = fs.readFileSync(path.join(__dirname, '../resources/js/chat.js'), 'utf8');
  const sandbox = {
    window: {
      i18n: { t: (k) => k },
      escapeHtml: (s) => s,
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    localStorage: { getItem: () => null, setItem: () => null }
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  const cm = sandbox.window.chatManager;
  assert.ok(cm, 'chatManager should be instantiated');

  const input = [
    'Ecco una foto:',
    '![Architettura di Rete](https://example.com/network.png)',
    '',
    'Ecco una clip video:',
    '![Video Demo](https://example.com/demo.mp4)',
    '',
    'Ecco un documento PDF:',
    '[Specifiche Tecniche.pdf](https://example.com/specs.pdf)',
    '',
    'Ecco un archivio zip:',
    '[file:Dataset.zip|https://example.com/dataset.zip]',
    '',
    'Ecco uno script python:',
    '[model_runner.py](https://example.com/model_runner.py)',
    '',
    '```javascript',
    'console.log("hello multimodal");',
    '```'
  ].join('\n');

  const html = cm.formatMarkdown(input);

  // Assert Image artifact
  assert.ok(html.includes('chat-artifact-image'), 'Should contain chat-artifact-image');
  assert.ok(html.includes('src="https://example.com/network.png"'), 'Should contain image source');
  // The lightbox is now reached through a delegated listener rather than an
  // inline handler, so the markup carries the data instead of a call.
  assert.ok(html.includes('data-media-src='), 'Should expose the image to the lightbox handler');
  assert.ok(html.includes('data-media-kind="image"'), 'Should mark the media as an image');

  // Assert Video artifact
  assert.ok(html.includes('chat-artifact-video'), 'Should contain chat-artifact-video');
  assert.ok(html.includes('video src="https://example.com/demo.mp4"'), 'Should contain video tag');

  // Assert PDF preview card
  assert.ok(html.includes('chat-file-card'), 'Should contain chat-file-card');
  assert.ok(html.includes('card-pdf'), 'Should contain card-pdf class');
  assert.ok(html.includes('fa-file-pdf'), 'Should contain fa-file-pdf icon');
  assert.ok(html.includes('Specifiche Tecniche.pdf'), 'Should contain file title');

  // Assert Archive preview card
  assert.ok(html.includes('card-archive'), 'Should contain card-archive class');
  assert.ok(html.includes('fa-file-zipper'), 'Should contain fa-file-zipper icon');
  assert.ok(html.includes('Dataset.zip'), 'Should contain file title');

  // Assert Code file preview card
  assert.ok(html.includes('card-code'), 'Should contain card-code class');
  assert.ok(html.includes('fa-file-code'), 'Should contain fa-file-code icon');

  // Assert Code block with copy button
  assert.ok(html.includes('chat-code-block'), 'Should contain chat-code-block');
  assert.ok(html.includes('chat-code-copy-btn'), 'Should contain copy button');
  assert.ok(html.includes('hello multimodal'), 'Should contain code content');
});
