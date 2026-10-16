'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../resources/js/chat.js'), 'utf8');

// Renders without a browser DOM, so what is asserted here is the escaping the
// renderer itself performs — the layer that has to hold on its own. The
// allowlist pass in sanitize.js only runs in the webview and is additional.
function renderer() {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', style: {}, hidden: true, innerHTML: '', textContent: '', focus() {}, querySelectorAll: () => [] });
    return nodes.get(id);
  };
  const window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    chatStorage: {}, operationalRegistry: {}, openRouterCatalog: { getApiKey: () => '' },
    chatWorkspace: { refresh: async () => {}, renderActive() {}, error() {}, perform: async () => {} }
  };
  const context = vm.createContext({
    window, document: { getElementById: node }, crypto: webcrypto, console,
    localStorage: { getItem: () => null, setItem: () => {} },
    AbortSignal, TextDecoder, fetch: async () => { throw Error('no network'); }
  });
  vm.runInContext(source, context);
  return (text) => window.chatManager.formatMarkdown(text);
}

test('rendered content carries no inline event handler for model-supplied data', () => {
  const render = renderer();

  // Breaking out of the JS string literal an onclick used to interpolate into.
  const payloads = [
    `[file:titolo|x');alert(1);//]`,
    `[artifact:t|http://a/b');window.location='//evil';//]`,
    `![immagine](http://127.0.0.1:4319/a.png')`,
    `[link](http://a/b')`,
    `![v](http://a/b.mp4')`
  ];

  for (const payload of payloads) {
    const html = render(payload);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `handler inline presente per ${payload}\n${html}`);
    assert.ok(!html.includes("');"), `apice non neutralizzato per ${payload}\n${html}`);
  }
});

test('single quotes in model output are escaped before reaching any attribute', () => {
  const render = renderer();
  const html = render(`Testo con un'apice e [file:l'artefatto|http://127.0.0.1:4319/a.txt]`);
  assert.ok(html.includes('&#39;'), 'l’apice deve essere trasformato in entità');
  assert.ok(!/\son[a-z]+\s*=/i.test(html));
});

test('only safe url schemes survive in links and media', () => {
  const render = renderer();

  const hostile = [
    '[clic](javascript:alert(1))',
    '[clic](JaVaScRiPt:alert(1))',
    '[clic](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[clic](vbscript:msgbox)',
    '![x](javascript:alert(1))'
  ];
  for (const payload of hostile) {
    const html = render(payload);
    assert.ok(!/javascript:/i.test(html), `schema javascript sopravvissuto: ${payload}\n${html}`);
    assert.ok(!/vbscript:/i.test(html), `schema vbscript sopravvissuto: ${payload}\n${html}`);
    assert.ok(!/data:text\/html/i.test(html), `data:text/html sopravvissuto: ${payload}\n${html}`);
  }

  // Legitimate targets keep working.
  const ok = render('[report](http://127.0.0.1:4319/api/conversations/a/sandbox/files/r.pdf)');
  assert.ok(ok.includes('http://127.0.0.1:4319/api/conversations/a/sandbox/files/r.pdf'));
  assert.ok(render('![i](https://cdn.example/x.png)').includes('https://cdn.example/x.png'));
  assert.ok(render('![i](data:image/png;base64,iVBORw0KGgo=)').includes('data:image/png;base64'));
});

test('raw html in model output is inert and media still renders through data attributes', () => {
  const render = renderer();

  const injected = render('<img src=x onerror=alert(1)> e <script>alert(2)</script>');
  assert.ok(!injected.includes('<img src=x'), 'il tag deve restare testo');
  assert.ok(!injected.includes('<script>'), 'lo script deve restare testo');
  assert.ok(injected.includes('&lt;img'), 'il markup deve essere mostrato come testo');

  // The feature the inline handlers used to provide is preserved.
  const media = render('![grafico](http://127.0.0.1:4319/api/conversations/a/sandbox/files/g.png)');
  assert.ok(media.includes('data-media-src='), 'il lightbox passa da un data attribute');
  assert.ok(media.includes('data-media-kind="image"'));

  const card = render('[file:Report|http://127.0.0.1:4319/api/conversations/a/sandbox/files/r.pdf]');
  assert.ok(card.includes('data-file-src='), 'la file card passa da un data attribute');
});
