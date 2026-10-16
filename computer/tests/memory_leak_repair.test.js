'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/database');

test('a summary that holds a model’s thinking, or a task’s whole outcome, is never read as the conversation', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const chat = store.createConversation('Assistente');
  const add = (role, content) => store.saveMessage(chat.id, { id: require('node:crypto').randomUUID(), role, content, status: 'complete' });
  const pairs = [
    ['Come si chiamano tre vulcani italiani?', 'Etna, Vesuvio e Stromboli.'],
    ['[Esito del compito affidato al Master: «Valuta un ThinkPad del 2021 con 64 GB.»]\nUn ThinkPad del 2021 equipaggiato con 64 GB di RAM si colloca oggi in una fascia interessante…\n\n### 1. Profilo hardware\n* CPU: Intel Core 11ª Gen', 'Quel ThinkPad è ottimo per programmare.'],
    ['Che ore sono?', 'Sono le tre.']
  ].map(([user, assistant]) => ({ user: add('user', user), assistant: add('assistant', assistant) }));
  const tree = store.memoryTree();
  const node = (pair, content) => tree.addNode(chat.id, { level: 1, userMessageId: pair.user.id, assistantMessageId: pair.assistant.id, content, facts: ['x'] });
  // As they were saved: the model thinking aloud, the outcome kept whole, and a real summary.
  const leaked = node(pairs[0], 'The user wants me to summarize a conversation turn for chat memory.\nHere\'s a thinking process:\n1. Analyze User Input');
  const whole = node(pairs[1], `Utente: ${pairs[1].user.content.slice(0, 300)}\nRisposta: Quel ThinkPad è ottimo per programmare.`);
  const good = node(pairs[2], 'L’utente ha chiesto l’ora e gli è stata detta.');

  assert.equal(tree.repairLeaked(chat.id), 2);
  const now = id => store.db.prepare('SELECT content, mechanical, facts_json FROM memory_nodes WHERE id=?').get(id);
  // Put back to the text itself, cut short, and marked to be written again.
  assert.equal(now(leaked.id).content, 'Utente: Come si chiamano tre vulcani italiani?\nRisposta: Etna, Vesuvio e Stromboli.');
  assert.equal(now(leaked.id).mechanical, 1);
  assert.equal(now(leaked.id).facts_json, '[]');
  // Of the task, the title and what was said of it: none of the Master's work.
  assert.equal(now(whole.id).content, 'Utente: [Esito del compito affidato al Master: «Valuta un ThinkPad del 2021 con 64 GB.»]\nRisposta: Quel ThinkPad è ottimo per programmare.');
  assert.deepEqual([now(good.id).content, now(good.id).mechanical], ['L’utente ha chiesto l’ora e gli è stata detta.', 0]);
  // Nothing left to repair; what is to be summarized anew is given without the Master's work.
  assert.equal(tree.repairLeaked(chat.id), 0);
  const work = tree.pending(chat.id);
  assert.deepEqual(work.upgrade.map(item => item.user), ['Come si chiamano tre vulcani italiani?', '[Esito del compito affidato al Master: «Valuta un ThinkPad del 2021 con 64 GB.»]']);
});
