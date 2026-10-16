'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Store } = require('../server/database');

test('Chain of Thought (CoT) and multi-turn rendering in ChatManager', () => {
  const code = fs.readFileSync(path.join(__dirname, '../resources/js/chat.js'), 'utf8');
  const domElements = new Map();

  const sandbox = {
    window: {
      i18n: {
        t: (k, params) => {
          if (k === 'cot.multipleTurns' && params) return `${params.count} turni`;
          if (k === 'cot.turnLabel' && params) return `Turno ${params.index}`;
          return k;
        }
      },
      escapeHtml: (s) => s,
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    document: {
      getElementById: (id) => domElements.get(id) || null,
      querySelector: (sel) => null,
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

  const sampleMessage = {
    id: 'msg-test-cot',
    role: 'assistant',
    modelId: 'anthropic/claude-3.7-sonnet',
    modelName: 'Claude 3.7 Sonnet',
    content: 'Ecco i risultati completi della ricerca e analisi.',
    turns: [
      {
        index: 1,
        status: 'complete',
        reasoning: 'Analizzo la richiesta dell’utente. È necessario interrogare il web per dati aggiornati.',
        toolCalls: [
          {
            id: 'call_1_web',
            name: 'web_search',
            args: '{"query":"SynthOrg architecture"}',
            status: 'complete',
            result: '[{"title":"SynthOrg Docs","url":"https://example.com","snippet":"Modular AI orchestration."}]'
          }
        ],
        content: ''
      },
      {
        index: 2,
        status: 'complete',
        reasoning: 'I dati sono stati recuperati con successo dal tool web_search. Formulo la risposta sintetica finale.',
        toolCalls: [],
        content: 'Ecco i risultati completi della ricerca e analisi.'
      }
    ]
  };

  const html = cm.renderTurnsAndReasoning(sampleMessage);

  // 1. Assert CoT Card and Header
  assert.ok(html.includes('chat-cot-wrapper'), 'Should render chat-cot-wrapper');
  assert.ok(html.includes('chat-cot-card'), 'Should render chat-cot-card');
  assert.ok(html.includes('chat-cot-header'), 'Should render chat-cot-header');
  assert.ok(html.includes('fa-brain'), 'Should include brain icon');
  assert.ok(html.includes('2 turni'), 'Should render turn count badge');
  assert.ok(html.includes('1 tool'), 'Should render tools count badge');

  // 2. Assert Brief Preview when collapsed
  assert.ok(html.includes('chat-cot-brief-preview'), 'Should include brief preview bar for whole CoT');
  assert.ok(html.includes('preview-quote-icon'), 'Should include preview quote icon');
  assert.ok(html.includes('Analizzo la richiesta dell’utente'), 'Should include initial thought snippet in preview');

  // 3. Assert Turn 1
  assert.ok(html.includes('Turno 1'), 'Should render Turno 1 header badge');
  assert.ok(html.includes('web_search'), 'Should render tool name tag in Turn 1');
  assert.ok(html.includes('chat-turn-preview-line'), 'Should render compact preview line for Turn 1');
  assert.ok(html.includes('chat-turn-tool-card'), 'Should render tool card in Turn 1');
  assert.ok(html.includes('chat-tool-args-box'), 'Should render tool args box');
  // The chain of thought shows what the model did, not the terminal it did it
  // in: the tool's own output is no longer printed under the call.
  assert.ok(!html.includes('chat-tool-result-box'), 'Must not print the tool output box');
  assert.ok(!html.includes('Modular AI orchestration'), 'Must not print the tool output itself');

  // 4. Assert Turn 2
  assert.ok(html.includes('Turno 2'), 'Should render Turno 2 header badge');
  assert.ok(html.includes('Formulo la risposta sintetica finale'), 'Should render Turn 2 reasoning');

  // 5. Test toggle state persistence
  cm.toggleCot('msg-test-cot');
  assert.strictEqual(cm.cotCollapsedState.get('msg-test-cot'), true, 'toggleCot should flip collapsed state to true');
  cm.toggleCot('msg-test-cot');
  assert.strictEqual(cm.cotCollapsedState.get('msg-test-cot'), false, 'toggleCot should flip collapsed state back to false');

  cm.toggleTurn('msg-test-cot', 0);
  assert.strictEqual(cm.turnCollapsedState.get('msg-test-cot_turn_0'), true, 'toggleTurn should flip turn collapsed state to true');
  cm.toggleTurn('msg-test-cot', 0);
  assert.strictEqual(cm.turnCollapsedState.get('msg-test-cot_turn_0'), false, 'toggleTurn should flip turn collapsed state back to false');
});

test('DatabaseManager persists and restores turns and reasoning metadata', () => {
  const testDbPath = path.join(__dirname, `test_cot_${Date.now()}.db`);
  const db = new Store(testDbPath);

  try {
    const conv = db.createConversation('Test CoT Chat');
    assert.ok(conv.id);

    const messageWithTurns = {
      id: 'msg-db-turns-test',
      role: 'assistant',
      content: 'Risposta finale orchestrata.',
      reasoning: 'Ragionamento cumulativo completo',
      turns: [
        {
          index: 1,
          status: 'complete',
          reasoning: 'Passo 1: ispezione ambiente container',
          toolCalls: [
            {
              id: 'call_podman_exec',
              name: 'sandbox_exec',
              args: '{"command":"uname -a"}',
              status: 'complete',
              result: 'Linux synthorg-sandbox 6.1.0'
            }
          ]
        },
        {
          index: 2,
          status: 'complete',
          reasoning: 'Passo 2: elaborazione output di sistema',
          toolCalls: []
        }
      ]
    };

    db.saveMessage(conv.id, messageWithTurns);

    const loadedMessages = db.messages(conv.id);
    assert.strictEqual(loadedMessages.length, 1);
    const loaded = loadedMessages[0];

    assert.strictEqual(loaded.id, 'msg-db-turns-test');
    assert.strictEqual(loaded.reasoning, 'Ragionamento cumulativo completo');
    assert.ok(Array.isArray(loaded.turns), 'turns should be loaded as array');
    assert.strictEqual(loaded.turns.length, 2);
    assert.strictEqual(loaded.turns[0].toolCalls[0].name, 'sandbox_exec');
    assert.strictEqual(loaded.turns[0].toolCalls[0].result, 'Linux synthorg-sandbox 6.1.0');
    assert.strictEqual(loaded.turns[1].reasoning, 'Passo 2: elaborazione output di sistema');
  } finally {
    db.close();
    try { fs.unlinkSync(testDbPath); } catch {}
  }
});
