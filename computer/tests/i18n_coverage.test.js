'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'resources/js/i18n.js'), 'utf8');

const SCANNED = [
  'resources/index.html',
  'resources/js/main.js',
  'resources/js/chat.js',
  'resources/js/chat-workspace.js',
  'resources/js/code-workspace.js',
  'resources/js/studio.js',
  'resources/js/photo.js',
  'resources/js/operational.js',
  'resources/js/prompts.js'
];

// Keys built by concatenation at call time (`t('appearance.font' + id)`), so the
// literal prefix is what a scanner sees; the real keys exist with a suffix.
const DYNAMIC_PREFIXES = ['appearance.font', 'appearance.radius', 'appearance.sound'];

function dictionaries() {
  const itStart = source.indexOf('    it: {');
  const enStart = source.indexOf('    en: {');
  const keysOf = (block) => new Set([...block.matchAll(/^\s*'([a-zA-Z0-9_.]+)':/gm)].map(m => m[1]));
  return { it: keysOf(source.slice(itStart, enStart)), en: keysOf(source.slice(enStart)) };
}

function referencedKeys() {
  const used = new Set();
  for (const file of SCANNED) {
    const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of content.matchAll(/i18n\.t\(\s*'([^']+)'/g)) used.add(m[1]);
    for (const m of content.matchAll(/\btr?\(\s*'([^']+)'/g)) used.add(m[1]);
    for (const m of content.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1]);
  }
  return [...used].filter(key => /^[a-z]+\.[a-zA-Z]/.test(key));
}

test('every string the interface asks for exists in both languages', () => {
  const { it, en } = dictionaries();

  assert.ok(it.size > 300, 'il dizionario italiano deve essere popolato');
  assert.deepEqual([...it].filter(k => !en.has(k)), [], 'chiavi presenti solo in italiano');
  assert.deepEqual([...en].filter(k => !it.has(k)), [], 'chiavi presenti solo in inglese');

  const missing = referencedKeys()
    .filter(key => !it.has(key))
    .filter(key => !DYNAMIC_PREFIXES.includes(key));
  assert.deepEqual(missing, [], 'chiavi usate dai renderer ma mai definite');
});

test('dictionaries have no duplicate keys', () => {
  const itStart = source.indexOf('    it: {');
  const enStart = source.indexOf('    en: {');
  function findDupes(block) {
    const seen = new Set();
    const dupes = [];
    for (const m of block.matchAll(/^\s*'([a-zA-Z0-9_.]+)':/gm)) {
      if (seen.has(m[1])) dupes.push(m[1]);
      else seen.add(m[1]);
    }
    return dupes;
  }
  assert.deepEqual(findDupes(source.slice(itStart, enStart)), [], 'chiavi duplicate nel dizionario italiano');
  assert.deepEqual(findDupes(source.slice(enStart)), [], 'chiavi duplicate nel dizionario inglese');
});

test('interpolated placeholders are filled in both languages', () => {
  const sandbox = {
    window: {},
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { querySelectorAll: () => [] },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const i18n = sandbox.window.i18n;

  const cases = [
    ['chat.toolsBadge', { native: 5, delegated: 2 }, ['5', '2']],
    ['security.newPasswordLabel', { min: 12 }, ['12']],
    ['env.filterAll', { count: 7 }, ['7']],
    ['prompts.tokenCount', { tokens: 120, chars: 480 }, ['120', '480']],
    ['env.preinstallRunning', { list: 'numpy, pandas' }, ['numpy, pandas']],
    ['memory.chatTimelineDesc', { title: 'Test Chat' }, ['Test Chat']],
    ['memory.turnNumber', { number: 3 }, ['3']]
  ];

  for (const locale of ['it', 'en']) {
    i18n.currentLocale = locale;
    for (const [key, params, expected] of cases) {
      const text = i18n.t(key, params);
      assert.ok(!/\{[a-z]+\}/i.test(text), `[${locale}] ${key} lascia un segnaposto non sostituito: ${text}`);
      for (const value of expected) {
        assert.ok(text.includes(value), `[${locale}] ${key} deve contenere ${value}: ${text}`);
      }
    }
  }
});

test('the interface carries no hardcoded Italian left outside the dictionary', () => {
  // The renderers build markup as template strings, and text written straight
  // into them never reaches the dictionary: switching language left those
  // fragments in Italian.
  const ITALIAN = /[àèéìòù]|\b(di|del|della|dei|delle|il|lo|la|le|gli|un|una|per|con|nel|nella|sono|non|che|questa|questo|senza|come|dalla|ogni|tutti|tutte|viene|puoi|apri|salva|elimina|modifica|attiva|disattiva|cerca|nessun|nessuna|Nativi|Delegati|Ripristina|Chiudi|Copia|Scarica|Scrivi|Inserisci|Ripeti|Scegli|Conferm|Attenzione|Aggiorna|Abilita)\b/;

  const offenders = [];
  for (const file of ['resources/js/chat.js', 'resources/js/main.js']) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes('i18n.t(') || /^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const candidates = [
        ...[...line.matchAll(/>([^<>{}`]{5,95})</g)].map(m => m[1]),
        ...[...line.matchAll(/(?:title|placeholder|aria-label)="([^"$]{5,95})"/g)].map(m => m[1])
      ];
      for (const candidate of candidates) {
        const text = candidate.trim();
        if (text && ITALIAN.test(text) && /[a-z]/i.test(text) && !/^[\s\d.,:•|-]+$/.test(text)) {
          offenders.push(`${file}:${index + 1} → ${text}`);
        }
      }
    });
  }

  assert.deepEqual(offenders, [], 'testo visibile non passato per i18n');
});
