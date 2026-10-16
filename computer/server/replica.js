'use strict';
/**
 * The same archive on two devices.
 *
 * The computer and a paired phone each keep the archive whole and run the
 * same rules on it (database.js, personal.js): what is done on a device is
 * written there at once, by that device, and the other one receives the rows
 * that came out of it. Nothing is asked of the other side to make a change,
 * and nothing is worked out again there: a row arrives as it was written.
 *
 * Every row written, in the tables named below, is noted by a trigger in
 * `sync_log`: which row, a number that only grows on this device (`seq`), the
 * moment (`at`), and whether the row is gone. A device asks the other for
 * what it noted after the number it has reached; that is the first copy too,
 * asked from zero. A row that came from a device is not sent back to it.
 *
 * The same row changed on both sides while they could not talk: the most
 * recent change stays, on both. At the same instant, the computer's.
 *
 * The first time two archives meet is another matter: a phone just installed
 * has written its own defaults a moment ago, and they are not more recent
 * than what the computer holds in any sense that counts. Until that first
 * exchange is over, where a row is on both sides the computer's stays; what
 * only one side has goes to the other.
 *
 * What stays on its device: the API keys and the bridge's own settings, the
 * cost ledgers, the credentials of external services, the approvals of the
 * Code projects.
 *
 * Written against `prepare().get/all/run` and `exec` alone: the phone runs
 * this file as it is, on its own SQLite (android/src-tauri/src/archive.rs).
 */
const { randomBytes } = require('node:crypto');

const SECRET = /(_api_key|_token|_secret|_password)$/i;
// What is about this device only: how its interface was left, and what it does with its pods.
const OWN = new Set(['ui_state', 'pod_copy']);
/** A setting that never leaves its device. */
const isSecret = (key) => key === 'bridge' || OWN.has(key) || SECRET.test(String(key || ''));

/*
 * table → `key`: the columns that name a row on every device (the primary
 * key when not said); `parents`: the rows it cannot be without, as
 * [table, column here]; `own`: rows that stay on their device.
 */
const TABLES = {
  conversations: {},
  // `sequence` numbers the messages of a device in the order it wrote them: the name is `id`.
  messages: { key: ['id'], parents: [['conversations', 'conversation_id']] },
  memories: { parents: [['conversations', 'conversation_id'], ['messages', 'source_message_id']] },
  memory_nodes: { parents: [['conversations', 'conversation_id']] },
  settings: { own: row => isSecret(row.key) },
  agenda_items: {},
  diary_entries: {},
  habits: {},
  habit_days: { parents: [['habits', 'habit_id']] },
  goals: {},
  goal_steps: { parents: [['goals', 'goal_id']] },
  notices: {},
  pauses: {},
  pauses_liked: {},
  handed_files: {},
  wellbeing_reviews: {},
  projects: {},
  project_steps: {}
};

const NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const ROWS_MOST = 400;
const BYTES_MOST = 1500000;

const name = (column) => `"${String(column).replace(/"/g, '""')}"`;

class Replica {
  /** `wins`: this device's change stays when two were made at the same instant (the computer). */
  constructor(store, { wins = true } = {}) {
    this.store = store;
    this.db = store.db;
    this.wins = wins;
    this.tables = new Map();
    this.install();
  }

  install() {
    const db = this.db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_log (
        tbl TEXT NOT NULL, pk TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL,
        gone INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(tbl, pk)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS sync_log_seq ON sync_log(seq);
      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK(id = 1), seq INTEGER NOT NULL DEFAULT 0,
        applying INTEGER NOT NULL DEFAULT 0, site TEXT NOT NULL, tables TEXT NOT NULL DEFAULT '', slot INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sync_peers (
        peer TEXT PRIMARY KEY, site TEXT NOT NULL DEFAULT '',
        got INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, fresh INTEGER NOT NULL DEFAULT 0
      );
      DROP TABLE IF EXISTS sync_writes;
    `);
    if (!db.prepare('SELECT 1 AS there FROM sync_state').get()) {
      // The computer numbers its messages in slot 0, a phone in one of the others (see `sequence`).
      const slot = this.wins ? 0 : 1 + randomBytes(1)[0] % 15;
      db.prepare("INSERT INTO sync_state(id, seq, applying, site, tables, slot) VALUES(1, 0, 0, ?, '', ?)").run(randomBytes(8).toString('hex'), slot);
    }
    this.slot = db.prepare('SELECT slot FROM sync_state').get().slot;
    db.exec('UPDATE sync_state SET applying = 0 WHERE applying != 0');
    // Added after the first version: a device already exchanged with is not meeting this archive for the first time.
    if (!db.prepare('PRAGMA table_info(sync_peers)').all().some(column => column.name === 'fresh')) db.exec('ALTER TABLE sync_peers ADD COLUMN fresh INTEGER NOT NULL DEFAULT 0');
    this.fillHomes();
    const known = new Set(String(db.prepare('SELECT tables FROM sync_state').get().tables || '').split(',').filter(Boolean));
    let added = false;
    for (const [table, spec] of Object.entries(TABLES)) {
      const columns = db.prepare(`PRAGMA table_info(${name(table)})`).all();
      // A table made on first use (personal.js): noted from the start that follows.
      if (!columns.length) continue;
      const key = spec.key || columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
      const uniques = [];
      for (const index of db.prepare(`PRAGMA index_list(${name(table)})`).all()) {
        if (!index.unique) continue;
        const cols = db.prepare(`PRAGMA index_info(${name(index.name)})`).all().map(column => column.name);
        const same = cols.length === key.length && cols.every(column => key.includes(column));
        // The device's own numbering of the rows is not a name: handled where the row is placed.
        const local = spec.key && cols.every(column => columns.find(c => c.name === column)?.pk);
        if (!same && !local && cols.every(Boolean)) uniques.push(cols);
      }
      this.tables.set(table, { ...spec, key, uniques, columns: columns.map(column => column.name) });
      if (known.has(table)) continue;
      const pk = (row) => `json_array(${key.map(column => `${row}.${name(column)}`).join(', ')})`;
      // Gone with the row it belonged to (2), not deleted by itself (1): told apart where it arrives.
      const [owner, link] = (spec.parents || [])[0] || [];
      const went = owner
        ? `CASE WHEN OLD.${name(link)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${name(owner)} WHERE ${name(this.keyOf(owner))} = OLD.${name(link)}) THEN 2 ELSE 1 END`
        : '1';
      // The moment is this device's clock, and always after the moment of the version it changes:
      // a change made on a row that came from the other device is the more recent of the two,
      // whatever the two clocks say. Updated or written, not replaced: a trigger takes the
      // conflict rule of the statement that fired it.
      const note = (row, gone) => `
          UPDATE sync_state SET seq = seq + 1;
          UPDATE sync_log SET seq = (SELECT seq FROM sync_state), at = MAX(${NOW}, at + 1), gone = ${gone}, origin = ''
            WHERE tbl = '${table}' AND pk = ${pk(row)};
          INSERT INTO sync_log(tbl, pk, seq, at, gone, origin)
            SELECT '${table}', ${pk(row)}, (SELECT seq FROM sync_state), ${NOW}, ${gone}, ''
            WHERE NOT EXISTS (SELECT 1 FROM sync_log WHERE tbl = '${table}' AND pk = ${pk(row)});`;
      db.exec(`
        DROP TRIGGER IF EXISTS sync_${table}_ins; DROP TRIGGER IF EXISTS sync_${table}_upd; DROP TRIGGER IF EXISTS sync_${table}_del;
        CREATE TRIGGER sync_${table}_ins AFTER INSERT ON ${name(table)} WHEN (SELECT applying FROM sync_state) = 0 BEGIN${note('NEW', 0)}
        END;
        CREATE TRIGGER sync_${table}_upd AFTER UPDATE ON ${name(table)} WHEN (SELECT applying FROM sync_state) = 0 BEGIN${note('NEW', 0)}
        END;
        CREATE TRIGGER sync_${table}_del AFTER DELETE ON ${name(table)} WHEN (SELECT applying FROM sync_state) = 0 BEGIN${note('OLD', went)}
        END;
      `);
      // What was there before the triggers: noted as of when it was last written, where the row says it.
      const dated = ['updated_at', 'created_at', 'at', 'started_at'].find(column => columns.some(c => c.name === column));
      const when = dated ? `COALESCE(CAST(unixepoch(${name(dated)}, 'subsec') * 1000 AS INTEGER), 0)` : '0';
      db.exec(`
        INSERT OR IGNORE INTO sync_log(tbl, pk, seq, at, gone, origin)
          SELECT '${table}', ${pk(name(table))}, (SELECT seq FROM sync_state) + ROW_NUMBER() OVER (ORDER BY rowid), ${when}, 0, '' FROM ${name(table)};
        UPDATE sync_state SET seq = seq + (SELECT COUNT(*) FROM ${name(table)});
      `);
      known.add(table);
      added = true;
    }
    if (added) db.prepare('UPDATE sync_state SET tables = ?').run([...known].join(','));
  }

  /** The column that names a row of a table whose rows others belong to. */
  keyOf(table) { return TABLES[table].key?.[0] || 'id'; }

  /**
   * The number of a message written now. Later than every message this device
   * holds, and never one another device can give: the moment it is written,
   * in this device's slot of sixteen. Two devices that write at once get
   * different numbers, in the order of their clocks.
   */
  sequence() {
    const last = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS last FROM messages').get().last || 0;
    const next = Date.now() * 16 + this.slot;
    return next > last ? next : last + 1 + ((this.slot - (last + 1)) % 16 + 16) % 16;
  }

  /** This archive, told from any other: a phone that finds another one starts from zero. */
  site() { return this.db.prepare('SELECT site FROM sync_state').get().site; }

  /**
   * The home of the chats from before the column existed, decided once: the
   * device that wrote their first message (its slot is in the number of every
   * message: the computer's is 0), or, for a chat without messages, the
   * device the row came from; this one otherwise. Never changed after.
   */
  fillHomes() {
    const db = this.db;
    if (!db.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'home')) return;
    const empty = db.prepare("SELECT id FROM conversations WHERE home = ''").all();
    if (!empty.length) return;
    const site = this.site();
    const peers = this.peerSites();
    const first = db.prepare('SELECT sequence FROM messages WHERE conversation_id = ? ORDER BY sequence LIMIT 1');
    const from = db.prepare(`SELECT p.site FROM sync_log l JOIN sync_peers p ON p.peer = l.origin
      WHERE l.tbl = 'conversations' AND l.pk = json_array(?) AND l.origin != '' AND p.site != ''`);
    const set = db.prepare('UPDATE conversations SET home = ? WHERE id = ?');
    for (const { id } of empty) {
      const opened = first.get(id);
      const origin = from.get(id)?.site || null;
      let home = site;
      if (opened && opened.sequence % 16 !== this.slot) home = origin || (this.wins ? site : peers[0] || site);
      else if (!opened && origin) home = origin;
      set.run(home, id);
    }
  }

  /** The sites of the devices this archive exchanged with, the one met last first. */
  peerSites() {
    return this.db.prepare("SELECT site FROM sync_peers WHERE site != '' ORDER BY rowid DESC").all().map(row => row.site);
  }

  /**
   * Whether a row is of this phone's own world: a chat born here, or what
   * belongs to one. Such rows never leave the phone; the computer (`wins`)
   * keeps nothing to itself.
   */
  private(table, data, homes) {
    if (this.wins || !data) return false;
    const site = this.site();
    if (table === 'conversations') return (data.home || site) === site;
    if (data.conversation_id === undefined || data.conversation_id === null) return false;
    if (!homes.has(data.conversation_id)) {
      const row = this.db.prepare('SELECT home FROM conversations WHERE id = ?').get(data.conversation_id);
      homes.set(data.conversation_id, row ? (row.home || site) : null);
    }
    return homes.get(data.conversation_id) === site;
  }
  head() { return this.db.prepare('SELECT seq FROM sync_state').get().seq; }

  next() {
    this.db.exec('UPDATE sync_state SET seq = seq + 1');
    return this.head();
  }

  /**
   * Where the exchange with a device has got to: `got` of its numbers are
   * here, `sent` of these are there; `fresh` until the first exchange with
   * its archive is over.
   */
  peer(id) {
    return this.db.prepare('SELECT peer, site, got, sent, fresh FROM sync_peers WHERE peer = ?').get(String(id)) || this.newPeer(id, '');
  }

  newPeer(id, site) { return { peer: String(id), site: String(site || ''), got: 0, sent: 0, fresh: 1 }; }

  savePeer(peer) {
    this.db.prepare(`INSERT INTO sync_peers(peer, site, got, sent, fresh) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(peer) DO UPDATE SET site = excluded.site, got = excluded.got, sent = excluded.sent, fresh = excluded.fresh`).run(peer.peer, peer.site, peer.got, peer.sent, peer.fresh ? 1 : 0);
  }

  forgetPeer(id) { this.db.prepare('DELETE FROM sync_peers WHERE peer = ?').run(String(id)); }

  row(table, key) {
    const spec = this.tables.get(table);
    return this.db.prepare(`SELECT * FROM ${name(table)} WHERE ${spec.key.map(column => `${name(column)} = ?`).join(' AND ')}`).get(...key);
  }

  /**
   * What this device noted after `after`, for `peer`: `{ rows, upto, more }`.
   * A row: `{ t, k, at, d }`, or `{ t, k, at, x: 1 }` for one that is gone.
   * A row goes with the ones it cannot be without when the device may not
   * have them yet.
   */
  collect(peer, after = 0) {
    this.install();
    const entries = this.db.prepare('SELECT tbl, pk, seq, at, gone FROM sync_log WHERE seq > ? AND origin != ? ORDER BY seq LIMIT ?').all(Number(after) || 0, String(peer), ROWS_MOST + 1);
    const more = entries.length > ROWS_MOST;
    if (more) entries.length = ROWS_MOST;
    const rows = [];
    const inside = new Set(entries.map(entry => `${entry.tbl} ${entry.pk}`));
    let upto = Number(after) || 0;
    let bytes = 0;
    let cut = false;
    const last = entries.length ? entries[entries.length - 1].seq : upto;
    const parent = this.db.prepare('SELECT seq, at, gone, origin FROM sync_log WHERE tbl = ? AND pk = ?');
    const homes = new Map();
    const add = (table, pk, at, gone, depth = 0) => {
      const spec = this.tables.get(table);
      if (!spec) return;
      const key = JSON.parse(pk);
      const data = gone ? null : this.row(table, key);
      if (data && spec.own?.(data)) return;
      // A phone's own world stays on the phone.
      if (this.private(table, data, homes)) return;
      if (data && depth < 4) {
        for (const [parentTable, column] of spec.parents || []) {
          if (data[column] === null || data[column] === undefined) continue;
          const parentPk = JSON.stringify([data[column]]);
          if (inside.has(`${parentTable} ${parentPk}`)) continue;
          const noted = parent.get(parentTable, parentPk);
          // Noted after this batch, and not by the device itself: it would arrive after the row that needs it.
          if (!noted || noted.gone || noted.seq <= last || noted.origin === String(peer)) continue;
          inside.add(`${parentTable} ${parentPk}`);
          add(parentTable, parentPk, noted.at, 0, depth + 1);
        }
      }
      const item = data ? { t: table, k: key, at, d: data } : { t: table, k: key, at, x: gone === 2 ? 2 : 1 };
      bytes += JSON.stringify(item).length;
      rows.push(item);
    };
    for (const entry of entries) {
      if (bytes > BYTES_MOST) { cut = true; break; }
      add(entry.tbl, entry.pk, entry.at, entry.gone);
      upto = entry.seq;
    }
    return { rows, upto, more: more || cut };
  }

  /** A change made here, noted by hand while the triggers are quiet. */
  note(table, key, gone = 0) {
    const pk = JSON.stringify(key);
    const last = this.db.prepare('SELECT at FROM sync_log WHERE tbl = ? AND pk = ?').get(table, pk);
    this.db.prepare("INSERT OR REPLACE INTO sync_log(tbl, pk, seq, at, gone, origin) VALUES(?, ?, ?, ?, ?, '')").run(table, pk, this.next(), Math.max(Date.now(), (last?.at || 0) + 1), gone ? 1 : 0);
  }

  /**
   * Rows of another device, written here as they are. Gives back what was
   * written: `[{ t, k, gone, row, before }]`. `first`: the two archives are
   * meeting for the first time.
   */
  apply(peer, rows, first = false) {
    this.install();
    const list = (Array.isArray(rows) ? rows : []).filter(item => item && this.tables.has(item.t) && Array.isArray(item.k));
    if (!list.length) return [];
    try {
      return this.store.transaction(() => this.applyAll(peer, list, first));
    } catch (error) {
      // One row that cannot be written must not hold the others back: each alone, the bad ones left out.
      const done = [];
      for (const item of list) {
        try { done.push(...this.store.transaction(() => this.applyAll(peer, [item], first))); } catch {}
      }
      return done;
    }
  }

  applyAll(peer, list, first = false) {
    const db = this.db;
    const done = [];
    db.exec('PRAGMA defer_foreign_keys = ON');
    db.exec('UPDATE sync_state SET applying = 1');
    try {
      const noted = db.prepare('SELECT at, gone, origin FROM sync_log WHERE tbl = ? AND pk = ?');
      const log = db.prepare('INSERT OR REPLACE INTO sync_log(tbl, pk, seq, at, gone, origin) VALUES(?, ?, ?, ?, ?, ?)');
      // The rows arriving together: one may come before the row it belongs to.
      const coming = new Set(list.filter(item => !item.x).map(item => `${item.t} ${JSON.stringify(item.k)}`));
      for (const item of list) {
        const spec = this.tables.get(item.t);
        const pk = JSON.stringify(item.k);
        const at = Number(item.at) || 0;
        const mine = noted.get(item.t, pk);
        if (first) {
          // The first meeting: what the computer has stays, here and there.
          if (this.wins && mine) continue;
        } else if (mine && mine.origin !== String(peer) && (mine.at > at || (mine.at === at && this.wins))) {
          // What is here is more recent, and was not this device's own: it stays, and goes to the other side.
          if (item.x && !mine.gone) this.resend(item.t, item.k);
          continue;
        }
        const before = this.row(item.t, item.k) || null;
        // Gone there with the row it belonged to, which is here: it stays, and goes back.
        if (item.x === 2 && before && this.owned(spec, before)) {
          this.note(item.t, item.k);
          continue;
        }
        if (item.x) {
          if (before) db.prepare(`DELETE FROM ${name(item.t)} WHERE ${spec.key.map(column => `${name(column)} = ?`).join(' AND ')}`).run(...item.k);
          log.run(item.t, pk, this.next(), at, item.x === 2 ? 2 : 1, String(peer));
          if (before) done.push({ t: item.t, k: item.k, gone: true, row: null, before });
          continue;
        }
        const data = item.d && typeof item.d === 'object' ? item.d : null;
        if (!data || spec.own?.(data)) continue;
        // The row it belongs to was deleted here: it goes too, on both sides.
        if (this.orphan(spec, data, coming)) {
          if (before) db.prepare(`DELETE FROM ${name(item.t)} WHERE ${spec.key.map(column => `${name(column)} = ?`).join(' AND ')}`).run(...item.k);
          this.note(item.t, item.k, 1);
          continue;
        }
        if (!this.unique(item.t, spec, item.k, data)) continue;
        const values = { ...data };
        if (item.t === 'messages') values.sequence = this.place(item.k[0], data, before);
        const columns = spec.columns.filter(column => values[column] !== undefined);
        if (before) {
          const set = columns.filter(column => !spec.key.includes(column));
          if (set.length) {
            db.prepare(`UPDATE ${name(item.t)} SET ${set.map(column => `${name(column)} = ?`).join(', ')} WHERE ${spec.key.map(column => `${name(column)} = ?`).join(' AND ')}`)
              .run(...set.map(column => values[column]), ...item.k);
          }
        } else {
          db.prepare(`INSERT INTO ${name(item.t)}(${columns.map(name).join(', ')}) VALUES(${columns.map(() => '?').join(', ')})`).run(...columns.map(column => values[column]));
        }
        // Placed at another number than it came with: that is a change made here, and goes back.
        if (item.t === 'messages' && data.sequence !== undefined && values.sequence !== data.sequence) this.note(item.t, item.k);
        else log.run(item.t, pk, this.next(), at, 0, String(peer));
        done.push({ t: item.t, k: item.k, gone: false, row: this.row(item.t, item.k), before });
      }
    } finally {
      db.exec('UPDATE sync_state SET applying = 0');
    }
    for (const change of done) {
      if (change.t === 'messages') this.store.touched?.((change.row || change.before).conversation_id, (change.row || change.before).sequence);
    }
    return done;
  }

  /** Whether the row this one belongs to is here. */
  owned(spec, data) {
    const [table, column] = (spec.parents || [])[0] || [];
    return Boolean(table && data[column] !== null && data[column] !== undefined && this.row(table, [data[column]]));
  }

  /** Whether a row's own parent is gone from here for good (deleted, not merely not arrived yet). */
  orphan(spec, data, coming) {
    for (const [table, column] of spec.parents || []) {
      const value = data[column];
      if (value === null || value === undefined) continue;
      if (this.row(table, [value]) || coming.has(`${table} ${JSON.stringify([value])}`)) continue;
      const noted = this.db.prepare('SELECT gone FROM sync_log WHERE tbl = ? AND pk = ?').get(table, JSON.stringify([value]));
      if (noted?.gone) {
        // A note kept its text when the message it came from went (ON DELETE SET NULL): so here.
        if (table === 'messages' && column === 'source_message_id') { data[column] = null; continue; }
        return true;
      }
    }
    return false;
  }

  /** A row deleted there but changed here after: it stays, with all that belongs to it, sent again. */
  resend(table, key) {
    if (!this.row(table, key)) return;
    this.note(table, key);
    for (const [child, spec] of this.tables) {
      for (const [parentTable, column] of spec.parents || []) {
        if (parentTable !== table) continue;
        const rows = this.db.prepare(`SELECT ${spec.key.map(name).join(', ')} FROM ${name(child)} WHERE ${name(column)} = ?`).all(key[0]);
        for (const row of rows) this.resend(child, spec.key.map(k => row[k]));
      }
    }
  }

  /**
   * Two devices made, each on its own, a row the table allows once (the page
   * of a day, the review of a week): one stays, the same on both, the one
   * whose name comes first. False when the row arriving is the one that goes.
   */
  unique(table, spec, key, data) {
    for (const columns of spec.uniques) {
      if (columns.some(column => data[column] === null || data[column] === undefined)) continue;
      const others = this.db.prepare(`SELECT ${spec.key.map(name).join(', ')} FROM ${name(table)} WHERE ${columns.map(column => `${name(column)} = ?`).join(' AND ')}`)
        .all(...columns.map(column => data[column]))
        .map(row => spec.key.map(k => row[k]))
        .filter(other => JSON.stringify(other) !== JSON.stringify(key));
      for (const other of others) {
        if (JSON.stringify(key) < JSON.stringify(other)) {
          this.db.prepare(`DELETE FROM ${name(table)} WHERE ${spec.key.map(column => `${name(column)} = ?`).join(' AND ')}`).run(...other);
          this.note(table, other, 1);
        } else {
          this.note(table, key, 1);
          return false;
        }
      }
    }
    return true;
  }

  /**
   * The number a message takes here: the one it was written with, so that
   * both devices read a conversation in the same order. Each device numbers
   * in a slot of its own, so the number is free; if it is not (two phones in
   * the same slot), one of the two messages takes a new number of this
   * device, and that goes back.
   */
  place(id, data, before) {
    const wanted = Number(data.sequence);
    if (!Number.isInteger(wanted) || wanted < 1) return before ? before.sequence : this.sequence();
    if (before && before.sequence === wanted) return wanted;
    const holder = this.db.prepare('SELECT id FROM messages WHERE sequence = ? AND id != ?').get(wanted, id);
    if (!holder) return wanted;
    if (this.wins) return before ? before.sequence : this.sequence();
    this.db.prepare('UPDATE messages SET sequence = ? WHERE id = ?').run(this.sequence(), holder.id);
    this.note('messages', [holder.id]);
    return wanted;
  }

  /**
   * One exchange with a device, both ways. `message`: `{ site, to, have, after, upto, rows }`,
   * what the device sends: its archive's mark, the mark it believes this one
   * has, how far it has received, and its own rows from `after` to `upto`.
   * Answered: the same from here, with what was written here (`applied`).
   */
  receive(peerId, message = {}) {
    const mine = this.site();
    let peer = this.peer(peerId);
    // Another archive than the one it knew (made again, or another computer): from zero, both ways.
    if (message.to && message.to !== mine) return { reset: true, site: mine, applied: [] };
    if (peer.site !== String(message.site || '')) peer = this.newPeer(peerId, message.site);
    let applied = [];
    const after = Number(message.after) || 0;
    if (Array.isArray(message.rows) && message.rows.length && after <= peer.got) {
      applied = this.apply(peerId, message.rows, Boolean(peer.fresh));
      peer.got = Math.max(peer.got, Number(message.upto) || 0);
    } else if (after <= peer.got) {
      peer.got = Math.max(peer.got, Number(message.upto) || 0);
    }
    peer.sent = Math.min(Number(message.have) || 0, this.head());
    const from = peer.sent;
    const out = this.collect(peerId, from);
    // Taken as received: if the answer is lost, the device says where it is at its next request.
    peer.sent = out.upto;
    if (!message.more && !out.more) peer.fresh = 0;
    this.savePeer(peer);
    return { site: mine, have: peer.got, after: from, upto: out.upto, more: out.more, rows: out.rows, applied };
  }

  /** What this device sends to start, or go on with, an exchange. */
  offer(peerId) {
    const peer = this.peer(peerId);
    const out = this.collect(peerId, peer.sent);
    return { site: this.site(), to: peer.site || null, have: peer.got, after: peer.sent, upto: out.upto, more: out.more, rows: out.rows };
  }

  /** The other device's answer to `offer`, or what it sends by itself: `{ reset }`, or what was written here. */
  answered(peerId, answer = {}) {
    let peer = this.peer(peerId);
    if (answer.reset) {
      this.savePeer(this.newPeer(peerId, answer.site));
      return { reset: true, applied: [] };
    }
    if (peer.site !== String(answer.site || '')) peer = this.newPeer(peerId, answer.site);
    let applied = [];
    let gap = false;
    const after = Number(answer.after) || 0;
    if (after <= peer.got) {
      if (Array.isArray(answer.rows) && answer.rows.length) applied = this.apply(peerId, answer.rows, Boolean(peer.fresh));
      peer.got = Math.max(peer.got, Number(answer.upto) || 0);
    } else {
      // Rows before these never arrived: asked again from where this device is.
      gap = true;
    }
    if (answer.have !== undefined) peer.sent = Math.max(peer.sent, Math.min(Number(answer.have) || 0, this.head()));
    this.savePeer(peer);
    // The first exchange is over when neither side has more for the other.
    if (peer.fresh && !gap && answer.have !== undefined && !answer.more && this.waiting(peerId) === 0) this.savePeer({ ...peer, fresh: 0 });
    return { reset: false, gap, applied, more: Boolean(answer.more) };
  }

  /** How many rows this device has not sent to `peer` yet. */
  waiting(peerId) {
    const peer = this.peer(peerId);
    return this.db.prepare('SELECT COUNT(*) AS rows FROM sync_log WHERE seq > ? AND origin != ?').get(peer.sent, String(peerId)).rows;
  }

  pending(peerId) { return this.waiting(peerId) > 0; }
}

/** A message as the page reads it (database.js gives the same). */
function messageOf(row) {
  let meta = {};
  try { meta = JSON.parse(row.meta_json || '{}'); } catch {}
  return {
    id: row.id, sequence: row.sequence, conversationId: row.conversation_id, role: row.role, kind: row.kind,
    status: row.status, content: row.content, modelId: row.model_id, modelName: row.model_name,
    timestamp: row.created_at, ...meta, isStreaming: row.status === 'streaming'
  };
}

const PATHS = {
  agenda_items: 'agenda', diary_entries: 'diary', habits: 'habits', goals: 'goals', notices: 'notices', pauses: 'pauses',
  handed_files: 'handed', wellbeing_reviews: 'reviews', memories: 'memories', projects: 'projects'
};

/**
 * Rows written by another device, as the writes the page knows how to show
 * again (resources/js/sync.js): `[{ method, path, data }]`.
 */
function changesOf(applied) {
  const changes = [];
  const seen = new Set();
  const once = (change) => {
    const mark = `${change.method} ${change.path} ${change.data?.id || ''}`;
    if (change.data === undefined && seen.has(mark)) return;
    seen.add(mark);
    changes.push(change);
  };
  const id = (value) => encodeURIComponent(String(value));
  for (const { t, k, gone, row, before } of applied || []) {
    const was = row || before || {};
    if (t === 'settings') {
      once(gone ? { method: 'DELETE', path: `/api/settings/${id(k[0])}` } : { method: 'PUT', path: `/api/settings/${id(k[0])}`, data: { key: k[0], value: row.value } });
    } else if (t === 'conversations') {
      // A chat that was not here is a new one for the lists; one that was, changed.
      once({ method: gone ? 'DELETE' : (before ? 'PATCH' : 'PUT'), path: `/api/conversations/${id(k[0])}` });
    } else if (t === 'messages') {
      if (gone) once({ method: 'DELETE', path: `/api/conversations/${id(was.conversation_id)}/messages` });
      else once({ method: 'POST', path: `/api/conversations/${id(was.conversation_id)}/messages`, data: messageOf(row) });
    } else if (t === 'memory_nodes') {
      once({ method: 'POST', path: `/api/conversations/${id(was.conversation_id)}/memory/nodes` });
    } else if (t === 'habit_days') {
      once({ method: 'PUT', path: '/api/habits/days' });
    } else if (t === 'goal_steps') {
      once({ method: 'PUT', path: `/api/goals/${id(was.goal_id)}/steps` });
    } else if (t === 'pauses_liked') {
      once({ method: 'PUT', path: '/api/pauses/liked' });
    } else if (t === 'project_steps') {
      once({ method: 'PUT', path: '/api/activity' });
    } else if (PATHS[t]) {
      once({ method: gone ? 'DELETE' : 'PUT', path: `/api/${PATHS[t]}/${id(k[0])}` });
    }
  }
  return changes;
}

module.exports = { Replica, changesOf, messageOf, isSecret, TABLES };
