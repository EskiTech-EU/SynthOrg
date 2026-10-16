'use strict';
/**
 * Level memory of a chat.
 *
 * Every turn (a user message and the answer to it) gets a summary: a node of
 * level 1. Every `fan` consecutive nodes of a level are summarized together
 * into one node of the level above: chapters (2), then higher chapters (3+).
 * Nothing is thrown away: every node keeps its children, and a level-1 node
 * its two messages, so the model and the user can always go back down to the
 * original text.
 *
 * What the model is given, and why it saves:
 *   - below the user's context cap, the whole conversation, message by
 *     message, only ever growing at its end: the provider's prompt cache
 *     keeps it all;
 *   - when the next request would pass the cap, one compaction: the older
 *     part becomes a small tree of nodes — the coarsest ones for the distant
 *     past, finer ones towards the present, within a share of the cap — and
 *     the last turns stay whole. From there the prompt grows at its end
 *     again, until the next compaction. The cache is rewritten only then.
 *
 * The summaries are written by the page (they need a model); this module
 * says what is still to summarize, stores what comes back, and builds the
 * view. Summaries are a separate table, not the memory notes: notes are the
 * user's, and they go in the system prompt.
 */
const { randomBytes } = require('node:crypto');

/** A message as the model is given it: its words, and the tools it called to do what it says, when it called any. */
const given = ({ role, content, calls }) => (Array.isArray(calls) && calls.length ? { role, content, calls } : { role, content });

const DEFAULTS = Object.freeze({ cap: 32000, share: 0.3, keepRaw: 4 });
const LIMITS = Object.freeze({ capMin: 4000, capMax: 2000000, shareMax: 0.9, fanMin: 4, fanMax: 20, keepRawMax: 50 });
const COMPACTION_TITLE = '[RIASSUNTO DELLA CONVERSAZIONE PRECEDENTE]';
// A token is about four characters: close enough to decide when to compact.
const tokens = text => Math.ceil(String(text || '').length / 4);
const MEMORY_BLOCK_TITLE = '[MEMORIA DELLA CONVERSAZIONE]';

class MemoryTree {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_nodes (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        level INTEGER NOT NULL CHECK(level >= 1),
        first_seq INTEGER NOT NULL,
        last_seq INTEGER NOT NULL,
        parent_id TEXT,
        content TEXT NOT NULL,
        facts_json TEXT NOT NULL DEFAULT '[]',
        tokens INTEGER NOT NULL,
        mechanical INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_nodes_conversation ON memory_nodes(conversation_id, level, first_seq);
    `);
    const columns = this.db.prepare('PRAGMA table_info(conversations)').all();
    // Where the last compaction cut the conversation, and which nodes stand for what came before.
    if (!columns.some(c => c.name === 'memory_view_json')) this.db.exec('ALTER TABLE conversations ADD COLUMN memory_view_json TEXT;');
    // Without the level memory: the classic summary made when the model's window was about to fill.
    if (!columns.some(c => c.name === 'compaction_json')) this.db.exec('ALTER TABLE conversations ADD COLUMN compaction_json TEXT;');
    // A chat's own cap, share and recent turns, where it does not follow the global ones.
    if (!columns.some(c => c.name === 'memory_settings_json')) this.db.exec('ALTER TABLE conversations ADD COLUMN memory_settings_json TEXT;');
  }

  /**
   * The values a chat works with: its own where it has them, the global ones
   * (Settings) for the rest. Without a chat, the global ones alone.
   */
  settings(conversationId = null) {
    const global = this.globalSettings();
    const own = conversationId ? this.chatSettings(conversationId) : null;
    return { ...global, ...(own || {}) };
  }

  /** The global values, set once for every chat. */
  globalSettings() {
    // A setting never given (or removed) is null: that means the default, not zero.
    const read = key => { const raw = this.store.getSetting(key); return raw === null || raw === undefined || raw === '' ? NaN : Number(raw); };
    return normalize({ cap: read('memory_context_cap'), share: read('memory_tree_share'), keepRaw: read('memory_recent_turns') }, DEFAULTS);
  }

  /** A chat's own values, if it has any: only the ones it sets, the rest comes from the global ones. */
  chatSettings(conversationId) {
    const row = this.db.prepare('SELECT memory_settings_json FROM conversations WHERE id=?').get(conversationId);
    if (!row?.memory_settings_json) return null;
    try {
      const raw = JSON.parse(row.memory_settings_json);
      const out = normalize(raw, {});
      return Object.keys(out).length ? out : null;
    } catch { return null; }
  }

  /** Sets a chat's own values; null (or an empty object) goes back to the global ones. */
  setChatSettings(conversationId, input) {
    this.store.conversation(conversationId);
    const values = input && typeof input === 'object' ? normalize({ cap: num(input.cap), share: num(input.share), keepRaw: num(input.keepRaw) }, {}) : {};
    this.db.prepare('UPDATE conversations SET memory_settings_json=? WHERE id=?').run(Object.keys(values).length ? JSON.stringify(values) : null, conversationId);
    return this.chatSettings(conversationId);
  }

  /** Whether a new chat starts with the level memory on (global; off unless set). */
  defaultEnabled() {
    const raw = this.store.getSetting('memory_default_enabled');
    return raw === 'true' || raw === '1';
  }

  /**
   * How many nodes go into one of the level above. Worked out from the cap:
   * one level of the newest nodes takes about a quarter of the small tree.
   */
  fan(conversationId, settings = this.settings(conversationId)) {
    const row = this.db.prepare('SELECT AVG(tokens) AS avg FROM memory_nodes WHERE conversation_id=? AND level=1').get(conversationId);
    const perNode = Math.max(40, Math.round(row?.avg || 120));
    const budget = settings.cap * Math.max(settings.share, 0.1);
    return Math.min(LIMITS.fanMax, Math.max(LIMITS.fanMin, Math.round(budget / (4 * perNode))));
  }

  /** The view a chat has, if the nodes it is made of are all still there; otherwise none, and it is forgotten. */
  validView(conversationId) {
    const view = this.readView(conversationId);
    if (!view) return null;
    const known = this.db.prepare(`SELECT COUNT(*) AS n FROM memory_nodes WHERE conversation_id=? AND id IN (${view.nodeIds.map(() => '?').join(',') || "''"})`).get(conversationId, ...view.nodeIds).n;
    if (known === view.nodeIds.length) return view;
    this.writeView(conversationId, null);
    return null;
  }

  /**
   * The completed turns: a user message and the answer after it. Kept in
   * mind for as long as the conversation's messages stay as they are: every
   * exchange asks for them several times, and a conversation may have tens
   * of thousands. Every change made through the store is counted; how many
   * messages there are, the last one and the last change to any tell of a
   * change made by other means.
   */
  turns(conversationId) {
    const count = this.db.prepare('SELECT COUNT(*) AS n, MAX(sequence) AS last FROM messages WHERE conversation_id=?').get(conversationId);
    const touched = this.db.prepare('SELECT MAX(updated_at) AS at FROM messages WHERE conversation_id=?').get(conversationId);
    const change = this.store.changes?.get(conversationId) || { n: 0, from: Infinity };
    const state = `${count.n}|${count.last}|${touched.at}`;
    this.kept = this.kept || new Map();
    const kept = this.kept.get(conversationId);
    if (kept && kept.n === change.n && kept.state === state) return kept.turns;
    // Changed through the store: the turns before the first message changed stand, the rest is read.
    // Changed by other means, or never read: all of it is.
    const stand = kept && kept.n !== change.n ? kept.turns.filter(turn => turn.lastSeq < change.from) : [];
    const turns = stand.concat(this.readTurns(conversationId, stand.length ? stand[stand.length - 1].lastSeq + 1 : 0, stand.length));
    change.from = Infinity;
    this.kept.delete(conversationId);
    this.kept.set(conversationId, { n: change.n, state, turns });
    // A few conversations at a time: the oldest asked for goes.
    if (this.kept.size > 6) this.kept.delete(this.kept.keys().next().value);
    return turns;
  }

  /** The turns made of the messages from one on, numbered after the `before` that come first. */
  readTurns(conversationId, fromSeq = 0, before = 0) {
    const rows = this.db.prepare(`SELECT sequence, id, role, content, meta_json FROM messages
      WHERE conversation_id=? AND sequence>=? AND kind='final' AND status='complete' AND role IN ('user','assistant') ORDER BY sequence`).all(conversationId, fromSeq)
      .filter(row => { try { return !JSON.parse(row.meta_json || '{}').demo; } catch { return true; } });
    const turns = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].role !== 'user') continue;
      const answer = rows[i + 1]?.role === 'assistant' ? rows[i + 1] : null;
      if (!answer) continue;
      turns.push({ index: before + turns.length + 1, user: rows[i], assistant: answer, firstSeq: rows[i].sequence, lastSeq: answer.sequence });
      i++;
    }
    return turns;
  }

  nodes(conversationId) {
    return this.db.prepare('SELECT * FROM memory_nodes WHERE conversation_id=? ORDER BY level, first_seq').all(conversationId);
  }

  /**
   * What is still to summarize: turns without a node, full groups of a level
   * without a parent, and nodes that got the text cut short when no summary
   * could be written — those only while the model does not have them in its
   * prompt: rewriting one there would change the prompt's start, and its cache.
   */
  /**
   * Summaries saved when a reply that was not a summary was kept as one — a model thinking aloud, its
   * instructions said back. What they hold is no part of the conversation and must not be read as such, not even
   * until they are written again: each is put back at once to the text itself cut short (a turn), or to its
   * children's (a group), and marked to be summarized anew. Returns how many.
   */
  repairLeaked(conversationId) {
    const bad = this.db.prepare(`SELECT * FROM memory_nodes WHERE conversation_id=? AND (${LEAKED.map(() => 'content LIKE ?').join(' OR ')}) ORDER BY level, first_seq`).all(conversationId, ...LEAKED);
    if (!bad.length) return 0;
    const byFirst = new Map(this.turns(conversationId).map(t => [t.firstSeq, t]));
    const cut = (text, n) => (text.length > n ? text.slice(0, n - 1) + '…' : text);
    const write = this.db.prepare("UPDATE memory_nodes SET content=?, facts_json='[]', tokens=?, mechanical=1 WHERE id=?");
    for (const node of bad) {
      let content;
      if (node.level === 1) {
        const turn = byFirst.get(node.first_seq);
        content = turn ? mechanicalSummary(this.db, turn) : '(turno non più disponibile)';
      } else {
        // Its children were put right before it: the lower levels come first.
        const kids = this.db.prepare('SELECT content FROM memory_nodes WHERE parent_id=? ORDER BY first_seq').all(node.id);
        content = kids.map(kid => cut(kid.content, 200)).join(' … ') || '(riassunto da riscrivere)';
      }
      // A note of the turn that was itself a leak would put it back.
      if (LEAKED_RE.test(content)) content = '(riassunto da riscrivere)';
      write.run(content, tokens(content), node.id);
    }
    return bad.length;
  }

  pending(conversationId, { limit = 20 } = {}) {
    this.store.conversation(conversationId);
    this.repairLeaked(conversationId);
    const fan = this.fan(conversationId);
    const done = new Set(this.db.prepare('SELECT first_seq FROM memory_nodes WHERE conversation_id=? AND level=1').all(conversationId).map(r => r.first_seq));
    const missing = this.turns(conversationId).filter(t => !done.has(t.firstSeq)).slice(0, limit).map(t => ({
      turn: t.index, userMessageId: t.user.id, assistantMessageId: t.assistant.id,
      user: clean(t.user.content), assistant: clean(t.assistant.content)
    }));
    const groups = [];
    const top = this.db.prepare('SELECT MAX(level) AS level FROM memory_nodes WHERE conversation_id=?').get(conversationId)?.level || 0;
    for (let level = 1; level <= top; level++) {
      const free = this.db.prepare('SELECT * FROM memory_nodes WHERE conversation_id=? AND level=? AND parent_id IS NULL ORDER BY first_seq').all(conversationId, level);
      if (free.length >= fan) groups.push({ level: level + 1, children: free.slice(0, fan).map(publicNode) });
    }
    const inView = new Set(this.readView(conversationId)?.nodeIds || []);
    const byFirst = new Map(this.turns(conversationId).map(t => [t.firstSeq, t]));
    const upgrade = this.db.prepare('SELECT * FROM memory_nodes WHERE conversation_id=? AND mechanical=1 ORDER BY level, first_seq').all(conversationId)
      .filter(node => !inView.has(node.id)).slice(0, 10).map(node => {
        if (node.level === 1) {
          const turn = byFirst.get(node.first_seq);
          return turn ? { id: node.id, level: 1, user: clean(turn.user.content), assistant: clean(turn.assistant.content) } : null;
        }
        const kids = this.db.prepare('SELECT * FROM memory_nodes WHERE parent_id=? ORDER BY first_seq').all(node.id);
        // a group is rewritten once its children have real summaries
        return kids.some(k => k.mechanical) ? null : { id: node.id, level: node.level, children: kids.map(publicNode) };
      }).filter(Boolean);
    return { fan, missing, groups, upgrade };
  }

  /** Stores a summary the page wrote: of one turn (level 1), or of a group of nodes (level 2+). */
  addNode(conversationId, input) {
    this.store.conversation(conversationId);
    const level = Number(input.level);
    const content = String(input.content || '').trim().slice(0, 8000);
    if (!content) fail('Riassunto vuoto.');
    const facts = Array.isArray(input.facts) ? input.facts.map(f => String(f).trim()).filter(Boolean).slice(0, 24).map(f => f.slice(0, 400)) : [];
    const id = randomBytes(5).toString('hex');
    const date = new Date().toISOString();
    const insert = (first, last, parentOf) => this.store.transaction(() => {
      this.db.prepare(`INSERT INTO memory_nodes(id,conversation_id,level,first_seq,last_seq,parent_id,content,facts_json,tokens,mechanical,created_at)
        VALUES(?,?,?,?,?,NULL,?,?,?,?,?)`).run(id, conversationId, level, first, last, content, JSON.stringify(facts),
        tokens(content) + tokens(facts.join('; ')), input.mechanical ? 1 : 0, date);
      for (const child of parentOf) this.db.prepare('UPDATE memory_nodes SET parent_id=? WHERE id=?').run(id, child);
    });
    if (level === 1) {
      const turn = this.turns(conversationId).find(t => t.user.id === input.userMessageId && t.assistant.id === input.assistantMessageId);
      if (!turn) fail('Turno non trovato in questa chat.', 404);
      const existing = this.db.prepare('SELECT id FROM memory_nodes WHERE conversation_id=? AND level=1 AND first_seq=?').get(conversationId, turn.firstSeq);
      if (existing) return this.node(conversationId, existing.id);
      insert(turn.firstSeq, turn.lastSeq, []);
      return this.node(conversationId, id);
    }
    if (!Number.isInteger(level) || level < 2) fail('Livello non valido.');
    const childIds = Array.isArray(input.childIds) ? input.childIds.map(String) : [];
    if (childIds.length < 2) fail('Servono almeno due nodi da unire.');
    // Only the oldest free nodes of the level below, in order: the tree grows from the past.
    const free = this.db.prepare('SELECT * FROM memory_nodes WHERE conversation_id=? AND level=? AND parent_id IS NULL ORDER BY first_seq').all(conversationId, level - 1);
    const expected = free.slice(0, childIds.length).map(n => n.id);
    if (expected.length !== childIds.length || expected.some((nodeId, i) => nodeId !== childIds[i])) fail('I nodi da unire non sono i più vecchi ancora liberi di quel livello.', 409);
    const children = free.slice(0, childIds.length);
    insert(children[0].first_seq, children[children.length - 1].last_seq, childIds);
    return this.node(conversationId, id);
  }

  /** A node as the user may correct it: only its text and facts. */
  updateNode(conversationId, nodeId, input) {
    const node = this.db.prepare('SELECT * FROM memory_nodes WHERE conversation_id=? AND id=?').get(conversationId, String(nodeId));
    if (!node) fail('Voce di memoria non trovata.', 404);
    const content = String(input.content ?? node.content).trim().slice(0, 8000);
    if (!content) fail('Riassunto vuoto.');
    const facts = Array.isArray(input.facts) ? input.facts.map(f => String(f).trim()).filter(Boolean).slice(0, 24) : JSON.parse(node.facts_json);
    this.db.prepare('UPDATE memory_nodes SET content=?, facts_json=?, tokens=?, mechanical=0 WHERE id=?')
      .run(content, JSON.stringify(facts), tokens(content) + tokens(facts.join('; ')), node.id);
    return this.node(conversationId, node.id);
  }

  node(conversationId, nodeId) {
    const node = this.db.prepare('SELECT * FROM memory_nodes WHERE conversation_id=? AND id=?').get(conversationId, String(nodeId));
    if (!node) fail('Voce di memoria non trovata.', 404);
    return this.describe(conversationId, node);
  }

  describe(conversationId, node, turns = this.turns(conversationId)) {
    const range = turnRange(turns, node);
    return { ...publicNode(node), fromTurn: range.from, toTurn: range.to, label: label(node.level, range) };
  }

  /** What opening a node shows: the nodes it contains, or, for a turn, its two messages whole. */
  open(conversationId, nodeId) {
    const node = this.db.prepare('SELECT * FROM memory_nodes WHERE conversation_id=? AND id=?').get(conversationId, String(nodeId).trim());
    if (!node) fail(`Nessuna voce "${nodeId}" nella memoria di questa chat.`, 404);
    const turns = this.turns(conversationId);
    if (node.level === 1) {
      const turn = turns.find(t => t.firstSeq === node.first_seq);
      if (!turn) fail('I messaggi di questo turno non esistono più.', 404);
      return {
        node: this.describe(conversationId, node, turns),
        messages: [
          { role: 'user', id: turn.user.id, content: turn.user.content },
          { role: 'assistant', id: turn.assistant.id, content: clean(turn.assistant.content) }
        ]
      };
    }
    const children = this.db.prepare('SELECT * FROM memory_nodes WHERE conversation_id=? AND parent_id=? ORDER BY first_seq').all(conversationId, node.id);
    return { node: this.describe(conversationId, node, turns), children: children.map(child => this.describe(conversationId, child, turns)) };
  }

  /** The whole tree, for the panel: every node, the view the model has now, the settings. */
  tree(conversationId) {
    this.store.conversation(conversationId);
    const turns = this.turns(conversationId);
    const view = this.readView(conversationId);
    return {
      settings: this.settings(conversationId),
      global: this.globalSettings(),
      own: this.chatSettings(conversationId),
      fan: this.fan(conversationId),
      turns: turns.length,
      view: view ? { untilTurn: turns.filter(t => t.lastSeq <= view.untilSeq).length, nodeIds: view.nodeIds, at: view.at } : null,
      compaction: (c => (c ? { untilTurn: turns.filter(t => t.lastSeq <= c.untilSeq).length, at: c.at } : null))(this.readCompaction(conversationId)),
      nodes: this.nodes(conversationId).map(node => this.describe(conversationId, node, turns))
    };
  }

  readView(conversationId) {
    const row = this.db.prepare('SELECT memory_view_json FROM conversations WHERE id=?').get(conversationId);
    try { return row?.memory_view_json ? JSON.parse(row.memory_view_json) : null; } catch { return null; }
  }

  writeView(conversationId, view) {
    this.db.prepare('UPDATE conversations SET memory_view_json=? WHERE id=?').run(view ? JSON.stringify(view) : null, conversationId);
  }

  /**
   * The conversation as the model is given it. `history` is every message
   * that goes to the model ({ sequence, role, content }), the new request
   * last. Below the cap it comes back as it is; past it, the older part
   * becomes the small tree.
   */
  view(conversationId, history) {
    const settings = this.settings(conversationId);
    let view = this.readView(conversationId);
    const known = view ? this.db.prepare(`SELECT id FROM memory_nodes WHERE conversation_id=? AND id IN (${view.nodeIds.map(() => '?').join(',') || "''"})`).all(conversationId, ...view.nodeIds) : [];
    if (view && known.length !== view.nodeIds.length) { view = null; this.writeView(conversationId, null); }
    const size = v => (v ? v.nodeIds.reduce((a, nodeId) => a + (this.tokensOf(nodeId) || 0), 0) : 0)
      + history.filter(m => !v || m.sequence > v.untilSeq).reduce((a, m) => a + tokens(m.content), 0);
    if (size(view) > settings.cap) {
      const compacted = this.compact(conversationId, history, settings, view);
      if (compacted) view = compacted;
    }
    const tail = history.filter(m => !view || m.sequence > view.untilSeq).map(given);
    if (!view) return { messages: tail, memoryView: { active: false } };
    const turns = this.turns(conversationId);
    const nodes = view.nodeIds.map(nodeId => this.db.prepare('SELECT * FROM memory_nodes WHERE id=?').get(nodeId));
    return {
      messages: [{ role: 'system', content: render(nodes.map(n => this.describe(conversationId, n, turns)), nodes) }, ...tail],
      memoryView: { active: true, untilTurn: turns.filter(t => t.lastSeq <= view.untilSeq).length, nodes: nodes.length }
    };
  }

  tokensOf(nodeId) {
    return this.db.prepare('SELECT tokens FROM memory_nodes WHERE id=?').get(nodeId)?.tokens;
  }

  /**
   * One compaction: everything before the last `keepRaw` turns is covered by
   * nodes, the coarsest available, then refined towards the present while
   * the small tree stays within its share of the cap.
   */
  compact(conversationId, history, settings, current = null) {
    const turns = this.turns(conversationId);
    if (turns.length <= settings.keepRaw) return null;
    const lastCovered = turns[turns.length - settings.keepRaw - 1];
    const untilSeq = lastCovered.lastSeq;
    // Nothing new to cover (the last turns alone pass the cap): the view stays, and so does the cache.
    if (current && current.untilSeq >= untilSeq) return current;
    // A turn not summarized yet (the summaries run behind, or failed) gets its text, cut short.
    for (const turn of turns.filter(t => t.lastSeq <= untilSeq)) {
      const exists = this.db.prepare('SELECT 1 FROM memory_nodes WHERE conversation_id=? AND level=1 AND first_seq=?').get(conversationId, turn.firstSeq);
      if (!exists) this.addNode(conversationId, { level: 1, userMessageId: turn.user.id, assistantMessageId: turn.assistant.id, content: mechanicalSummary(this.db, turn), mechanical: true });
    }
    const all = this.nodes(conversationId);
    const byParent = new Map();
    for (const node of all) {
      const key = node.parent_id || '';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(node);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.first_seq - b.first_seq);
    // Coarsest cover: from the roots down, splitting only a node that crosses the cut.
    const cover = [];
    const walk = list => {
      for (const node of list) {
        if (node.first_seq > untilSeq) continue;
        if (node.last_seq <= untilSeq) cover.push(node);
        else walk(byParent.get(node.id) || []);
      }
    };
    walk((byParent.get('') || []).slice().sort((a, b) => a.first_seq - b.first_seq));
    cover.sort((a, b) => a.first_seq - b.first_seq);
    // Refine the newest coarse node first, while the whole stays within the share of the cap.
    const budget = Math.max(0, settings.cap * settings.share);
    let size = cover.reduce((a, n) => a + n.tokens, 0);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = cover.length - 1; i >= 0; i--) {
        const kids = byParent.get(cover[i].id);
        if (!kids || !kids.length) continue;
        const grow = kids.reduce((a, n) => a + n.tokens, 0) - cover[i].tokens;
        if (size + grow <= budget) { cover.splice(i, 1, ...kids); size += grow; changed = true; break; }
      }
    }
    const view = { untilSeq, nodeIds: cover.map(n => n.id), at: new Date().toISOString() };
    this.writeView(conversationId, view);
    return view;
  }

  /**
   * The classic compaction, for a chat without the level memory: when the
   * conversation is about to fill the model's window, the model is sent all of
   * it and asked for a summary, which then stands for everything before the
   * last turns. This says what to send; the page asks the model.
   */
  compactionPlan(conversationId) {
    this.store.conversation(conversationId);
    const { keepRaw } = this.settings(conversationId);
    const turns = this.turns(conversationId);
    const previous = this.readCompaction(conversationId);
    if (turns.length <= keepRaw) return { possible: false };
    const untilSeq = turns[turns.length - keepRaw - 1].lastSeq;
    if (previous && previous.untilSeq >= untilSeq) return { possible: false };
    const messages = this.db.prepare(`SELECT sequence, role, content, meta_json FROM messages WHERE conversation_id=? AND kind='final' AND status='complete'
      AND role IN ('user','assistant') AND sequence<=? AND sequence>? ORDER BY sequence`).all(conversationId, untilSeq, previous ? previous.untilSeq : 0)
      .filter(row => { try { return !JSON.parse(row.meta_json || '{}').demo; } catch { return true; } })
      .map(row => ({ role: row.role, content: row.role === 'assistant' ? clean(row.content) : row.content }));
    return { possible: true, untilSeq, previousSummary: previous?.summary || null, messages, keepTurns: keepRaw };
  }

  saveCompaction(conversationId, input) {
    this.store.conversation(conversationId);
    const summary = String(input.summary || '').trim();
    if (!summary) fail('Riassunto vuoto.');
    const untilSeq = Number(input.untilSeq);
    if (!Number.isInteger(untilSeq) || untilSeq <= 0) fail('Punto di taglio non valido.');
    const previous = this.readCompaction(conversationId);
    if (previous && previous.untilSeq >= untilSeq) fail('Questa parte della conversazione è già riassunta.', 409);
    const compaction = { untilSeq, summary: summary.slice(0, 200000), at: new Date().toISOString() };
    this.db.prepare('UPDATE conversations SET compaction_json=? WHERE id=?').run(JSON.stringify(compaction), conversationId);
    return { untilSeq, at: compaction.at, tokens: tokens(compaction.summary) };
  }

  readCompaction(conversationId) {
    const row = this.db.prepare('SELECT compaction_json FROM conversations WHERE id=?').get(conversationId);
    try { return row?.compaction_json ? JSON.parse(row.compaction_json) : null; } catch { return null; }
  }

  /** A chat without the level memory: its whole history, or, after a compaction, the summary and what came after. */
  classicView(conversationId, history) {
    const compaction = this.readCompaction(conversationId);
    const tail = history.filter(m => !compaction || m.sequence > compaction.untilSeq).map(given);
    if (!compaction) return { messages: tail, compaction: null };
    return {
      messages: [{ role: 'system', content: `${COMPACTION_TITLE}\nLa parte più vecchia di questa chat è stata riassunta per restare nella finestra di contesto; dopo questo blocco vengono i messaggi successivi, interi.\n\n${compaction.summary}` }, ...tail],
      compaction: { at: compaction.at, untilTurn: this.turns(conversationId).filter(t => t.lastSeq <= compaction.untilSeq).length }
    };
  }

  /** Messages removed (an edit cut the chat, or it was emptied): what summarized them goes, and so does the view. */
  forgetFrom(conversationId, fromSeq) {
    this.store.transaction(() => {
      const gone = this.db.prepare('SELECT id FROM memory_nodes WHERE conversation_id=? AND last_seq>=?').all(conversationId, fromSeq).map(r => r.id);
      for (const nodeId of gone) {
        this.db.prepare('UPDATE memory_nodes SET parent_id=NULL WHERE parent_id=?').run(nodeId);
        this.db.prepare('DELETE FROM memory_nodes WHERE id=?').run(nodeId);
      }
      const view = this.readView(conversationId);
      if (view && view.untilSeq >= fromSeq) this.writeView(conversationId, null);
      // a classic summary that covered removed messages no longer tells the truth
      const compaction = this.readCompaction(conversationId);
      if (compaction && compaction.untilSeq >= fromSeq) this.db.prepare('UPDATE conversations SET compaction_json=NULL WHERE id=?').run(conversationId);
    });
  }
}

/** Only valid values survive; one missing or out of range takes the fallback's (none, for a chat's own). */
function normalize(values, fallback) {
  const out = {};
  const { cap, share, keepRaw } = values || {};
  if (Number.isFinite(cap) && cap > 0) out.cap = Math.min(LIMITS.capMax, Math.max(LIMITS.capMin, Math.round(cap)));
  else if (fallback.cap !== undefined) out.cap = fallback.cap;
  if (Number.isFinite(share) && share >= 0) out.share = Math.min(LIMITS.shareMax, share);
  else if (fallback.share !== undefined) out.share = fallback.share;
  // the last turns the model always gets whole, after a compaction
  if (Number.isFinite(keepRaw) && keepRaw >= 0) out.keepRaw = Math.min(LIMITS.keepRawMax, Math.round(keepRaw));
  else if (fallback.keepRaw !== undefined) out.keepRaw = fallback.keepRaw;
  return out;
}

const num = value => (value === null || value === undefined || value === '' ? NaN : Number(value));

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

/** An answer as the memory keeps it: without the model's thinking tags. */
// The outcome of a task handed to the Master, as it was once kept whole in the assistant's conversation: the
// work is the Master's, done in a context of its own, and only its title belongs to this conversation's memory.
const TASK_OUTCOME = /^\[(?:Hai finito il compito|Esito del compito affidato al Master): «[\s\S]*?»\]/;

function clean(text) {
  const head = TASK_OUTCOME.exec(String(text || ''));
  if (head) return head[0];
  return String(text || '')
    .replace(/<(think|thought|reasoning|reflection)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(think|thought|reasoning|reflection)[^>]*>[\s\S]*$/gi, '')
    .trim();
}

function publicNode(node) {
  let facts = [];
  try { facts = JSON.parse(node.facts_json || '[]'); } catch {}
  return { id: node.id, level: node.level, parentId: node.parent_id || null, content: node.content, facts, tokens: node.tokens, mechanical: Boolean(node.mechanical) };
}

function turnRange(turns, node) {
  const inside = turns.filter(t => t.firstSeq >= node.first_seq && t.lastSeq <= node.last_seq);
  return { from: inside[0]?.index || null, to: inside[inside.length - 1]?.index || null };
}

function label(level, range) {
  const turnsText = range.from === range.to ? `turno ${range.from}` : `turni ${range.from}–${range.to}`;
  if (level === 1) return turnsText;
  if (level === 2) return `capitolo · ${turnsText}`;
  return `sovracapitolo di livello ${level - 2} · ${turnsText}`;
}

/** A turn the summaries have not reached: the older summary note if there is one, else its text cut short. */
// What a summary never says: these are a model's own thinking, or the instructions it was given.
const LEAKED = ['Utente: [Esito del compito affidato al Master: «%»]' + String.fromCharCode(10) + '_%' + String.fromCharCode(10) + 'Risposta:%', '%The user wants me to%', '%thinking process%', '%Analyze User Input%', '%Rispondi solo con un oggetto JSON%', '%copiati testuali dai riassunti%', '%copied textually: decisions%', '%<think>%', '%</think>%'];
const LEAKED_RE = /The user wants me to|thinking process|Analyze User Input|Rispondi solo con un oggetto JSON|copiati testuali dai riassunti|copied textually: decisions|<\/?think>/i;

function mechanicalSummary(db, turn) {
  const note = db.prepare("SELECT content FROM memories WHERE source_message_id=? AND section='turn_summary' ORDER BY updated_at DESC LIMIT 1").get(turn.assistant.id);
  if (note?.content) return note.content.slice(0, 2000);
  const cut = (text, n) => (text.length > n ? text.slice(0, n - 1) + '…' : text);
  return `Utente: ${cut(clean(turn.user.content), 300)}\nRisposta: ${cut(clean(turn.assistant.content), 500)}`;
}

function render(described, nodes) {
  const lines = [
    MEMORY_BLOCK_TITLE,
    'Qui sotto c\'è la parte più vecchia di questa chat, riassunta: dal punto più lontano al più recente, più dettagliata man mano che si avvicina a ora. Dopo questo blocco vengono i messaggi recenti, interi.',
    'Ogni voce ha un codice tra parentesi quadre. Con il tool memory_open puoi aprirla: di un capitolo vedi i riassunti che contiene, di un turno i messaggi originali. Aprila quando ti serve il testo esatto o un dettaglio che il riassunto non riporta; non inventarlo.',
    ''
  ];
  described.forEach((node, i) => {
    lines.push(`[${node.id}] ${node.label}`);
    lines.push(nodes[i].content);
    if (node.facts.length) lines.push('Fatti: ' + node.facts.join('; '));
    lines.push('');
  });
  return lines.join('\n').trim();
}

module.exports = { MemoryTree, DEFAULTS, LIMITS, MEMORY_BLOCK_TITLE, COMPACTION_TITLE, estimateTokens: tokens, given };
