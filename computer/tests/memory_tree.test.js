'use strict';
// The chat's level memory: summaries per turn, groups of them, and the view of
// the conversation the model is given — whole below the cap, a small tree of
// summaries for the older part past it, rewritten only at a compaction.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/database');
const { MEMORY_BLOCK_TITLE } = require('../server/memory-tree');

function setup(t, { cap = 4000, share = 0.3 } = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.setSetting('memory_context_cap', String(cap));
  store.setSetting('memory_tree_share', String(share));
  const chat = store.createConversation('Livelli');
  store.updateConversation(chat.id, { memoryEnabled: true });
  return { store, chat, tree: store.memoryTree() };
}

// A turn: a question and an answer of about `size` characters each.
function addTurns(store, chatId, from, count, size = 1000) {
  for (let i = from; i < from + count; i++) {
    store.saveMessage(chatId, { id: `u${i}`, role: 'user', content: `domanda ${i} ` + 'x'.repeat(size) });
    store.saveMessage(chatId, { id: `a${i}`, role: 'assistant', content: `risposta ${i} ` + 'y'.repeat(size) });
  }
}

// What the page does in background: a summary for every turn, then every full group.
function summarizeAll(tree, chatId, pad = 0) {
  for (let round = 0; round < 20; round++) {
    const work = tree.pending(chatId, { limit: 500 });
    if (!work.missing.length && !work.groups.length) return;
    for (const turn of work.missing) tree.addNode(chatId, { level: 1, userMessageId: turn.userMessageId, assistantMessageId: turn.assistantMessageId, content: `sintesi del turno ${turn.turn}` + 's'.repeat(pad), facts: [`fatto ${turn.turn}`] });
    for (const group of work.groups) tree.addNode(chatId, { level: group.level, childIds: group.children.map(c => c.id), content: `sintesi di ${group.children.length} nodi di livello ${group.level - 1}` });
  }
}

test('every turn gets a summary, and full groups of a level get one above them', t => {
  const { store, chat, tree } = setup(t);
  addTurns(store, chat.id, 1, 30, 50);
  const first = tree.pending(chat.id, { limit: 500 });
  assert.equal(first.missing.length, 30);
  assert.equal(first.groups.length, 0, 'no group before the turns are summarized');
  summarizeAll(tree, chat.id);
  const { nodes, fan } = tree.tree(chat.id);
  const byLevel = level => nodes.filter(n => n.level === level);
  assert.equal(byLevel(1).length, 30);
  assert.equal(byLevel(2).length, Math.floor(30 / fan), 'one chapter per full group of turns');
  for (const chapter of byLevel(2)) assert.equal(nodes.filter(n => n.parentId === chapter.id).length, fan);
  assert.match(byLevel(2)[0].label, /^capitolo · turni 1–/);

  // only the oldest free nodes of a level can be grouped, in order
  const free = byLevel(1).filter(n => !n.parentId);
  if (free.length >= 2) {
    assert.throws(() => tree.addNode(chat.id, { level: 2, childIds: free.slice(1, 3).map(n => n.id), content: 'salto' }), /più vecchi/);
  }
  // a turn is summarized once
  const again = tree.addNode(chat.id, { level: 1, userMessageId: 'u1', assistantMessageId: 'a1', content: 'di nuovo' });
  assert.equal(again.content, 'sintesi del turno 1');
});

test('below the cap the model gets the whole conversation; past it, the older part as a small tree and the last turns whole', t => {
  const { store, chat, tree } = setup(t, { cap: 4000 });
  addTurns(store, chat.id, 1, 3, 500);
  store.saveMessage(chat.id, { id: 'q', role: 'user', content: 'nuova domanda' });
  const small = store.context(chat.id, 'nuova domanda');
  assert.equal(small.memoryView.active, false);
  assert.equal(small.messages.length, 7, 'every message, whole');

  store.truncateMessages(chat.id, 'q');
  addTurns(store, chat.id, 4, 30, 1000);
  summarizeAll(tree, chat.id, 400); // summaries of about 100 tokens, as real ones
  store.saveMessage(chat.id, { id: 'q2', role: 'user', content: 'e adesso?' });
  const big = store.context(chat.id, 'e adesso?');
  assert.equal(big.memoryView.active, true);
  assert.equal(big.messages[0].role, 'system');
  assert.ok(big.messages[0].content.startsWith(MEMORY_BLOCK_TITLE));
  assert.match(big.messages[0].content, /\[[0-9a-f]{10}\] capitolo · turni 1–/, 'the distant past as chapters, each with its code');
  const raw = big.messages.slice(1);
  assert.equal(raw.length, 4 * 2 + 1, 'the last four turns whole, then the new request');
  assert.equal(raw[raw.length - 1].content, 'e adesso?');
  assert.match(raw[0].content, /^domanda 30 /);

  // the small tree stays within its share of the cap
  const view = tree.tree(chat.id).view;
  const nodes = tree.tree(chat.id).nodes.filter(n => view.nodeIds.includes(n.id));
  assert.ok(nodes.reduce((a, n) => a + n.tokens, 0) <= 4000 * 0.3);
  assert.equal(view.untilTurn, 29);

  // next request, still under the cap with the view: the block at the top is the same, word for word (the cache holds)
  store.saveMessage(chat.id, { id: 'a-q2', role: 'assistant', content: 'breve' });
  store.saveMessage(chat.id, { id: 'q3', role: 'user', content: 'ancora' });
  const next = store.context(chat.id, 'ancora');
  assert.equal(next.messages[0].content, big.messages[0].content);
  assert.equal(next.messages.length, big.messages.length + 2, 'the new turn is only appended');
});

test('a compaction reaching turns not summarized yet uses their text, cut short, or the older summary note', t => {
  const { store, chat, tree } = setup(t, { cap: 4000 });
  addTurns(store, chat.id, 1, 20, 1000);
  store.saveMemory({ content: 'nota vecchia del turno 2', scope: 'conversation', conversationId: chat.id, section: 'turn_summary', sourceMessageId: 'a2', pinned: true });
  store.saveMessage(chat.id, { id: 'q', role: 'user', content: 'domanda' });
  const ctx = store.context(chat.id, 'domanda');
  assert.equal(ctx.memoryView.active, true);
  const nodes = tree.tree(chat.id).nodes;
  assert.equal(nodes.filter(n => n.level === 1).length, 16, 'every covered turn has a node');
  assert.ok(nodes.every(n => n.mechanical));
  assert.equal(nodes.find(n => n.label === 'turno 2').content, 'nota vecchia del turno 2');
  assert.match(nodes.find(n => n.label === 'turno 1').content, /^Utente: domanda 1 x+…\nRisposta: risposta 1 y+…$/);
  // the old summary notes no longer go into the prompt as notes: the tree has them
  assert.equal(ctx.chatItems.length, 0);

  // cut-short nodes come back to be rewritten, except those the model has in its prompt now
  const inView = new Set(tree.tree(chat.id).view.nodeIds);
  const upgrade = tree.pending(chat.id).upgrade;
  assert.ok(upgrade.every(n => !inView.has(n.id)));
  const outside = nodes.filter(n => n.mechanical && !inView.has(n.id));
  assert.equal(upgrade.length, Math.min(10, outside.length));
  if (upgrade.length) {
    const target = upgrade[0];
    tree.updateNode(chat.id, target.id, { content: 'riassunto vero', facts: ['un fatto'] });
    assert.equal(tree.node(chat.id, target.id).mechanical, false);
    assert.ok(!tree.pending(chat.id).upgrade.some(n => n.id === target.id));
  }
});

test('the share of the cap decides how detailed the small tree is', t => {
  const run = share => {
    const { store, chat, tree } = setup(t, { cap: 8000, share });
    addTurns(store, chat.id, 1, 60, 500);
    summarizeAll(tree, chat.id);
    store.saveMessage(chat.id, { id: 'q', role: 'user', content: 'domanda' });
    store.context(chat.id, 'domanda');
    const { view, nodes } = tree.tree(chat.id);
    return nodes.filter(n => view.nodeIds.includes(n.id));
  };
  const coarse = run(0), fine = run(0.5);
  assert.ok(fine.length > coarse.length, 'more room, more nodes');
  assert.ok(Math.min(...fine.map(n => n.level)) < Math.min(...coarse.map(n => n.level)) || fine.length > coarse.length);
  // both cover the same turns, once
  const turns = nodes => nodes.reduce((a, n) => a + (n.toTurn - n.fromTurn + 1), 0);
  assert.equal(turns(coarse), turns(fine));
});

test('opening a node gives what it contains, down to the original messages; an edit takes its summaries away', t => {
  const { store, chat, tree } = setup(t);
  addTurns(store, chat.id, 1, 30, 50);
  summarizeAll(tree, chat.id);
  const chapter = tree.tree(chat.id).nodes.find(n => n.level === 2);
  const opened = tree.open(chat.id, chapter.id);
  assert.equal(opened.children.length, tree.tree(chat.id).fan);
  const paragraph = tree.open(chat.id, opened.children[0].id);
  assert.deepEqual(paragraph.messages.map(m => m.role), ['user', 'assistant']);
  assert.match(paragraph.messages[0].content, /^domanda 1 /);
  assert.throws(() => tree.open(chat.id, 'nonesiste'), /Nessuna voce/);

  // the user corrects a summary
  const fixed = tree.updateNode(chat.id, chapter.id, { content: 'riassunto corretto a mano' });
  assert.equal(fixed.content, 'riassunto corretto a mano');

  // cutting the chat at turn 5 removes the summaries that covered it, and above
  store.truncateMessages(chat.id, 'u5');
  const left = tree.tree(chat.id).nodes;
  assert.equal(left.filter(n => n.level === 1).length, 4);
  assert.equal(left.filter(n => n.level > 1).length, 0);
  assert.ok(left.every(n => !n.parentId));
  store.clearMessages(chat.id);
  assert.equal(tree.tree(chat.id).nodes.length, 0);
});

test('with the chat memory off, the conversation goes whole and nothing is summarized into it', t => {
  const { store, chat } = setup(t, { cap: 4000 });
  store.updateConversation(chat.id, { memoryEnabled: false });
  addTurns(store, chat.id, 1, 30, 1000);
  const ctx = store.context(chat.id, 'x');
  assert.equal(ctx.memoryView.active, false);
  assert.equal(ctx.messages.length, 60);
});

test('settings not given, or removed, mean the defaults', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const tree = store.memoryTree();
  assert.deepEqual(tree.settings(), { cap: 32000, share: 0.3, keepRaw: 4 });
  store.setSetting('memory_tree_share', '0');
  assert.equal(tree.settings().share, 0, 'zero on purpose stays zero');
  store.setSetting('memory_tree_share', null);
  store.setSetting('memory_context_cap', '100');
  assert.deepEqual(tree.settings(), { cap: 4000, share: 0.3, keepRaw: 4 }, 'a cap below the minimum is raised to it');
});

test('without the level memory: the classic compaction replaces the older part with the model\'s summary, once, then the chat goes on', t => {
  const { store, chat, tree } = setup(t);
  store.updateConversation(chat.id, { memoryEnabled: false });
  store.setSetting('memory_recent_turns', '3');
  addTurns(store, chat.id, 1, 10, 50);
  const plan = tree.compactionPlan(chat.id);
  assert.equal(plan.possible, true);
  assert.equal(plan.keepTurns, 3);
  assert.equal(plan.messages.length, 7 * 2, 'everything before the last three turns');
  assert.equal(plan.previousSummary, null);
  tree.saveCompaction(chat.id, { untilSeq: plan.untilSeq, summary: 'riassunto dei turni 1-7' });

  store.saveMessage(chat.id, { id: 'q', role: 'user', content: 'avanti' });
  const ctx = store.context(chat.id, 'avanti');
  assert.equal(ctx.messages[0].role, 'system');
  assert.match(ctx.messages[0].content, /riassunto dei turni 1-7$/);
  assert.equal(ctx.messages.length, 1 + 3 * 2 + 1, 'the summary, the last three turns, the new request');
  assert.equal(ctx.compaction.untilTurn, 7);
  assert.equal(tree.compactionPlan(chat.id).possible, false, 'nothing new to summarize yet');

  // the next compaction includes the previous summary and what came after it
  store.saveMessage(chat.id, { id: 'a-q', role: 'assistant', content: 'ok' });
  addTurns(store, chat.id, 20, 2, 50);
  const again = tree.compactionPlan(chat.id);
  assert.equal(again.previousSummary, 'riassunto dei turni 1-7');
  assert.ok(again.messages.length > 0 && again.messages.length < 14);
  assert.throws(() => tree.saveCompaction(chat.id, { untilSeq: plan.untilSeq, summary: 'vecchio' }), /già riassunta/);

  // an edit before the cut makes the summary untrue: it goes
  store.truncateMessages(chat.id, 'u5');
  assert.equal(store.context(chat.id, 'x').compaction, null);
  assert.equal(store.context(chat.id, 'x').messages.length, 8);
});

test('the recent turns kept whole are a setting, used by the level view too', t => {
  const { store, chat, tree } = setup(t, { cap: 4000 });
  store.setSetting('memory_recent_turns', '2');
  addTurns(store, chat.id, 1, 30, 1000);
  summarizeAll(tree, chat.id, 400);
  store.saveMessage(chat.id, { id: 'q', role: 'user', content: 'e ora?' });
  const ctx = store.context(chat.id, 'e ora?');
  assert.equal(ctx.messages.slice(1).length, 2 * 2 + 1);
  assert.equal(tree.settings().keepRaw, 2);
});

test('global values for every chat, a chat\'s own where it sets them, and the switch for new chats', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const tree = store.memoryTree();
  assert.equal(store.createConversation('a').memory_enabled, 0, 'off for new chats unless the global switch says otherwise');
  store.setSetting('memory_default_enabled', 'true');
  const chat = store.createConversation('b');
  assert.equal(chat.memory_enabled, 1);

  store.setSetting('memory_context_cap', '20000');
  store.setSetting('memory_recent_turns', '6');
  assert.deepEqual(tree.settings(chat.id), { cap: 20000, share: 0.3, keepRaw: 6 }, 'the global ones');

  store.updateConversation(chat.id, { memorySettings: { cap: 8000, keepRaw: '2' } });
  assert.deepEqual(tree.chatSettings(chat.id), { cap: 8000, keepRaw: 2 });
  assert.deepEqual(tree.settings(chat.id), { cap: 8000, share: 0.3, keepRaw: 2 }, 'its own, and the global share');
  assert.deepEqual(tree.settings(), { cap: 20000, share: 0.3, keepRaw: 6 }, 'the global ones are untouched');
  const other = store.createConversation('c');
  assert.equal(tree.settings(other.id).cap, 20000, 'other chats keep the global ones');
  assert.equal(tree.tree(chat.id).own.cap, 8000);

  store.updateConversation(chat.id, { memorySettings: null });
  assert.equal(tree.chatSettings(chat.id), null);
  assert.equal(tree.settings(chat.id).cap, 20000, 'back to the global ones');
});
