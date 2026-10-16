'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Store } = require('../server/database');
// These tests exercise the chat's turn memory, which a new chat starts without: their chats turn it on.
function withChatMemory(store) {
  const create = store.createConversation.bind(store);
  store.createConversation = (...args) => { const c = create(...args); return store.updateConversation(c.id, { memoryEnabled: true }); };
  return store;
}
function setup(t) { const store = withChatMemory(new Store(':memory:')); t.after(() => store.close()); return store; }
const note = (content, scope = 'global', extra = {}) => ({ content, scope, enabled: true, pinned: false, ...extra });

test('conversation CRUD, title generation, search and archive are isolated', t => {
  const s = setup(t), a = s.createConversation(), b = s.createConversation('Seconda');
  const msg = s.saveMessage(a.id, { role: 'user', content: 'Progetto SQL 100%_esatto' });
  assert.equal(s.conversation(a.id).title, 'Progetto SQL 100%_esatto');
  assert.equal(s.messages(b.id).length, 0);
  assert.throws(() => s.saveMessage(b.id, { ...msg, content: 'overwrite' }), /altra chat|altra|un’altra/);
  assert.equal(s.listConversations('100%_')[0].id, a.id);
  assert.equal(s.listConversations("' OR 1=1 --").length, 0);
  s.updateConversation(a.id, { title: 'Rinominata', archived: true });
  assert.equal(s.listConversations().length, 1);
  assert.equal(s.listConversations('', true)[0].title, 'Rinominata');
  s.updateConversation(a.id, { archived: false });
  assert.equal(s.listConversations().length, 2);
  s.deleteConversation(a.id); assert.equal(s.messages(b.id).length, 0);
});

test('legacy import is atomic, idempotent, safe after deletion, and preserves timestamps', t => {
  const s = setup(t);
  const legacy = [{ role: 'user', content: 'Vecchia chat', timestamp: '2025-01-01T00:00:00Z' }, { role: 'assistant', content: 'Parziale', isStreaming: true }];
  const result = s.importLegacy(legacy);
  assert.equal(s.messages(result.conversationId)[0].timestamp, '2025-01-01T00:00:00.000Z');
  assert.equal(s.messages(result.conversationId)[1].status, 'interrupted');
  assert.equal(s.importLegacy(legacy).imported, false);
  assert.throws(() => s.importLegacy([{ role: 'user', content: 'valid' }, { role: 'assistant', content: 'bad', modelId: 'x'.repeat(201) }]));
  assert.equal(s.listConversations().length, 1, 'failed import rolls back the entire chat');
  s.deleteConversation(result.conversationId);
  assert.equal(s.importLegacy(legacy).imported, false, 'deleting a migrated chat must not re-import it');
  assert.equal(s.listConversations().length, 0);
});

test('context excludes other chats, execution traces, demo, errors and unfinished responses', t => {
  const s = setup(t), a = s.createConversation(), b = s.createConversation();
  for (const item of [
    { role: 'user', content: 'Domanda' }, { role: 'assistant', content: 'Risposta' },
    { role: 'assistant', content: 'Ragionamento', kind: 'execution' }, { role: 'tool', content: 'Tool result' },
    { role: 'system', content: 'Internal system' }, { role: 'assistant', content: 'Errore', status: 'error' },
    { role: 'assistant', content: 'Streaming', status: 'streaming' }, { role: 'assistant', content: 'Demo', demo: true }
  ]) s.saveMessage(a.id, item);
  s.saveMessage(b.id, { role: 'user', content: 'Privato B' });
  assert.deepEqual(s.context(a.id, '').messages, [{ role: 'user', content: 'Domanda' }, { role: 'assistant', content: 'Risposta' }]);
});

test('memory scopes, relevance, pinning, accent-insensitive search and opt out', t => {
  const s = setup(t), a = s.createConversation(), b = s.createConversation();
  const global = s.saveMemory(note('Preferisco TypeScript'));
  const local = s.saveMemory(note('Il database è SQLite', 'conversation', { conversationId: a.id }));
  const pinned = s.saveMemory(note('Rispondi in italiano', 'global', { pinned: true }));
  s.saveMemory(note('Caffè senza zucchero'));
  s.saveMemory(note('SQLite segreto B', 'conversation', { conversationId: b.id }));
  assert.deepEqual(new Set(s.context(a.id, 'TypeScript SQLite').memories.map(m => m.id)), new Set([global.id, local.id, pinned.id]));
  assert(!s.context(b.id, 'SQLite').memories.some(m => m.id === local.id));
  assert(s.context(a.id, 'caffe').memories.some(m => m.content.includes('Caffè')));
  assert.equal(s.context(a.id, '!!! " OR * (').memories.length, 1);
  s.updateConversation(a.id, { memoryEnabled: false });
  assert.equal(s.context(a.id, 'TypeScript SQLite').memories.length, 0);
  assert.equal(s.listMemories(a.id, '', 'global').length, 3);
  assert.equal(s.listMemories(a.id, '', 'conversation').length, 1);
  assert.equal(s.listMemories(b.id, '', 'conversation').length, 1);
  assert.equal(s.listMemories(b.id, '', 'global').length, 3);
});

test('edits, disabling and deleting notes immediately update the full text index', t => {
  const s = setup(t), chat = s.createConversation();
  const item = s.saveMemory(note('Progetto orchidea'));
  assert.equal(s.context(chat.id, 'orchidea').memories.length, 1);
  s.saveMemory(note('Progetto tulipano'), item.id);
  assert.equal(s.context(chat.id, 'orchidea').memories.length, 0);
  assert.equal(s.context(chat.id, 'tulipano').memories.length, 1);
  s.saveMemory(note('Progetto tulipano', 'global', { enabled: false }), item.id);
  assert.equal(s.context(chat.id, 'tulipano').memories.length, 0);
  s.deleteMemory(item.id); assert.equal(s.listMemories(chat.id).length, 0);
});

test('memory retrieval has hard item/character limits', t => {
  const s = setup(t), chat = s.createConversation();
  for (let i = 0; i < 12; i++) s.saveMemory(note('x'.repeat(1999) + i % 10, 'global', { pinned: true }));
  const selected = s.context(chat.id, '').memories;
  assert.equal(selected.length, 3);
  assert.equal(selected.reduce((n, m) => n + m.content.length, 0), 6000);
});

test('deleting chat cascades local memory but retains global memory and clears provenance', t => {
  const s = setup(t), chat = s.createConversation();
  const message = s.saveMessage(chat.id, { role: 'user', content: 'Origine' });
  const global = s.saveMemory(note('Globale', 'global', { sourceMessageId: message.id }));
  s.saveMemory(note('Locale', 'conversation', { conversationId: chat.id, sourceMessageId: message.id }));
  s.deleteConversation(chat.id);
  const remaining = s.listMemories(null);
  assert.equal(remaining.length, 1); assert.equal(remaining[0].id, global.id); assert.equal(remaining[0].source_message_id, null);
});

test('clearing messages retains notes and removes source links', t => {
  const s = setup(t), chat = s.createConversation();
  const message = s.saveMessage(chat.id, { role: 'user', content: 'Origine' });
  s.saveMemory(note('Locale', 'conversation', { conversationId: chat.id, sourceMessageId: message.id }));
  s.clearMessages(chat.id);
  assert.equal(s.messages(chat.id).length, 0); assert.equal(s.listMemories(chat.id).length, 1);
  assert.equal(s.listMemories(chat.id)[0].source_message_id, null);
});

test('SQLite persists across reopen and recovers incomplete generations', t => {
  const directory = path.resolve(__dirname, '../.tmp/test-db-' + randomUUID());
  const file = path.join(directory, 'synthorg.sqlite');
  t.after(() => {
    const intended = path.resolve(__dirname, '../.tmp') + path.sep;
    assert(directory.startsWith(intended) && path.basename(directory).startsWith('test-db-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let s = new Store(file);
  const chat = s.createConversation('Persistente');
  s.saveMessage(chat.id, { role: 'assistant', content: 'Parziale salvato', status: 'streaming' });
  s.saveMemory(note('Preferenza persistente'));
  s.close(); s = new Store(file);
  try {
    assert.equal(s.conversation(chat.id).title, 'Persistente');
    assert.equal(s.messages(chat.id)[0].status, 'interrupted');
    assert.equal(s.messages(chat.id)[0].content, 'Parziale salvato');
    assert.equal(s.listMemories(chat.id).length, 1);
    assert.equal(s.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 1);
  } finally { s.close(); }
});

test('conversation-level dual memory toggles: local timeline and global dossier independently toggled', t => {
  const s = setup(t);
  const chat = s.createConversation('Dual Memory Test');
  s.saveMemory(note('Profilo utente globale', 'global'));
  s.saveMemory(note('Sintesi turno locale', 'conversation', { conversationId: chat.id }));

  // Both active by default
  const ctxBoth = s.context(chat.id, '', { includeGlobal: true, includeChat: true });
  assert.equal(ctxBoth.globalItems.length, 1);
  assert.equal(ctxBoth.chatItems.length, 1);

  // Disable only global dossier for this chat
  s.updateConversation(chat.id, { globalMemoryEnabled: false });
  const ctxNoGlobal = s.context(chat.id, '', { includeGlobal: true, includeChat: true });
  assert.equal(ctxNoGlobal.globalItems.length, 0, 'Global dossier should be excluded when toggled off for this chat');
  assert.equal(ctxNoGlobal.chatItems.length, 1, 'Local chat timeline should remain active');

  // Disable local timeline as well
  s.updateConversation(chat.id, { memoryEnabled: false });
  const ctxNone = s.context(chat.id, '', { includeGlobal: true, includeChat: true });
  assert.equal(ctxNone.globalItems.length, 0);
  assert.equal(ctxNone.chatItems.length, 0);

  // Re-enable global dossier while local timeline remains off
  s.updateConversation(chat.id, { globalMemoryEnabled: true });
  const ctxGlobalOnly = s.context(chat.id, '', { includeGlobal: true, includeChat: false });
  assert.equal(ctxGlobalOnly.globalItems.length, 1);
  assert.equal(ctxGlobalOnly.chatItems.length, 0);
});

test('settings table stores and updates configuration keys in SQLite', t => {
  const s = setup(t);
  assert.equal(s.getSetting('openrouter_api_key'), null);
  assert.deepEqual(s.getSettings(), {});

  s.setSetting('openrouter_api_key', 'sk-or-v1-testkey123');
  assert.equal(s.getSetting('openrouter_api_key'), 'sk-or-v1-testkey123');
  assert.deepEqual(s.getSettings(), { openrouter_api_key: 'sk-or-v1-testkey123' });

  // Update
  s.setSetting('openrouter_api_key', 'sk-or-v1-newkey456');
  assert.equal(s.getSetting('openrouter_api_key'), 'sk-or-v1-newkey456');

  // Delete
  s.deleteSetting('openrouter_api_key');
  assert.equal(s.getSetting('openrouter_api_key'), null);
});

