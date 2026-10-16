'use strict';
/**
 * The user's own things: the agenda and the diary. Both live only in the
 * local database and every row can be deleted by the user.
 *
 * Agenda. Two kinds of item:
 *   - reminder: a moment (start_at). When it comes, the app says so once
 *     (notified_at), and the item stays until it is done or deleted.
 *   - activity: something that lasts, from start_at to end_at.
 * Times are local wall-clock strings, "YYYY-MM-DDTHH:MM", as the user says
 * them: no zone conversions to get wrong.
 *
 * Diary. One entry per day. What the user tells about the day is kept as it
 * was said (raw_text): a new telling of the same day is added to it. Beside
 * it, the page written from the whole account (page_text) and the day's data
 * worked out of it (extracted_json: activities, mood, energy, people…). The
 * raw words are the source; page and data can be made again from them.
 *
 * Goals. What the user wants to get done: a name, a day it is due, steps,
 * and, when it is about code, the Code project it belongs to. They live in
 * the agenda: due days and steps are dates on its calendar.
 *
 * Proposals. What a model works out of the user's words — something to put
 * in the agenda, a habit, a step that seems done — is never carried out by
 * the model: it waits, marked as proposed, for the user to say yes or no.
 *
 * Notices. The character may show up while the user works — hours on the
 * same file, hours without a pause, a step due, a late hour, an exchange
 * with a model going badly — and propose a pause. What it said and how it
 * was answered is kept, so that it does not say it again too soon; a pause
 * taken is kept with its start and its end. The pauses the user likes are
 * proposed by a model and confirmed by the user, like the habits.
 *
 * Files. What the Master made for a task of the character — a picture, a
 * video, a sound, a document — is handed to the user in the character's
 * section. Kept here is what was handed and whether it was opened; the file
 * itself stays in the workspace of the chat that made it, and what is no
 * longer there is no longer shown.
 *
 * Jobs. Every request the section makes to a model in the background is
 * written down with what it cost (tokens in and out, tokens read from the
 * cache, time), so that the cost of the section is a number, not a guess.
 *
 * Activity. What was done in the app, day by day: the steps of the Code
 * projects (kept here as they are recorded, so that a project whose
 * container is off still has its past) and the messages written in the
 * chats. It is what progress is read from; it measures doing, not worth.
 */
const { randomUUID } = require('node:crypto');

const now = () => new Date().toISOString();
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/;

const HANDED_KINDS = ['image', 'video', 'audio', 'document'];

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
/**
 * The link of a file in a chat's workspace, as it is stored: without an
 * origin, since the port is chosen when the app starts. Anything else —
 * another address, a way out of the workspace — is no link: null.
 */
function workspaceLink(value) {
  const link = String(value || '').trim().replace(/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?=\/api\/)/i, '');
  if (link.length > 1000 || !/^\/api\/conversations\/[a-zA-Z0-9_-]{1,64}\/sandbox\/files\/[^?#]+$/.test(link)) return null;
  let parts;
  try { parts = link.split('/').slice(6).map(decodeURIComponent); } catch { return null; }
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\/\0]/.test(part))) return null;
  return link;
}
function text(value, max, name, empty = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(`${name} non valido (massimo ${max} caratteri).`);
  return value.trim();
}
/** A list of words as it is kept: lower case, no doubles, a JSON list; null when none was ever looked for. */
function words(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) fail('Parole non valide.');
  // An empty list is kept as one: looked for, and none found.
  return JSON.stringify([...new Set(value.map(w => String(w).toLowerCase().trim()).filter(w => w.length >= 2 && w.length <= 40))].slice(0, 24));
}
/** The moments, as messages keep theirs, that surely hold two local days and all between: a day more on each side. */
function around(start, end) {
  const moment = (dayText, days) => {
    const [y, m, d] = dayText.split('-').map(Number);
    const at = new Date(Date.UTC(Math.min(Math.max(y, 1970), 9000), m - 1, d + days));
    return at.toISOString();
  };
  return [moment(start, -1), moment(end, 2)];
}
/** A day, or null when none is given. */
function day(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !LOCAL_DAY.test(value)) fail(`${name}: serve un giorno nel formato AAAA-MM-GG.`);
  return value;
}
/** The day on this computer's calendar. */
function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function time(value, name, optional = false) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  if (typeof value !== 'string' || !LOCAL_TIME.test(value)) fail(`${name}: serve una data e ora nel formato AAAA-MM-GGTHH:MM.`);
  return value;
}

class Personal {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agenda_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('reminder','activity')),
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        start_at TEXT NOT NULL,
        end_at TEXT,
        done INTEGER NOT NULL DEFAULT 0,
        notified_at TEXT,
        source TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agenda_start ON agenda_items(start_at);
      CREATE TABLE IF NOT EXISTS diary_entries (
        id TEXT PRIMARY KEY,
        day TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        extracted_json TEXT,
        source TEXT NOT NULL DEFAULT 'realtime',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS diary_day ON diary_entries(day);
    `);
    if (!this.db.prepare('PRAGMA table_info(diary_entries)').all().some(c => c.name === 'page_text')) {
      this.db.exec('ALTER TABLE diary_entries ADD COLUMN page_text TEXT;');
    }
    this.mergeDiaryDays();
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS diary_one_per_day ON diary_entries(day);
      CREATE TABLE IF NOT EXISTS habits (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sign TEXT NOT NULL CHECK(sign IN ('positive','negative')),
        status TEXT NOT NULL DEFAULT 'tracked' CHECK(status IN ('proposed','tracked','dismissed')),
        notes TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS habit_days (
        habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        done INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'diary',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(habit_id, day)
      );
      CREATE INDEX IF NOT EXISTS habit_days_day ON habit_days(day);
      CREATE TABLE IF NOT EXISTS wellbeing_reviews (
        id TEXT PRIMARY KEY,
        from_day TEXT NOT NULL,
        to_day TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(from_day, to_day)
      );
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        due_day TEXT,
        project_id TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','dropped')),
        closed_day TEXT,
        source TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goal_steps (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        due_day TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        done INTEGER NOT NULL DEFAULT 0,
        done_day TEXT,
        proposed_day TEXT,
        proposed_why TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS goal_steps_goal ON goal_steps(goal_id, position);
      CREATE TABLE IF NOT EXISTS project_steps (
        project_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        at TEXT NOT NULL,
        day TEXT NOT NULL,
        hour INTEGER NOT NULL,
        source TEXT,
        tool TEXT,
        title TEXT NOT NULL DEFAULT '',
        files INTEGER NOT NULL DEFAULT 0,
        additions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(project_id, hash)
      );
      CREATE INDEX IF NOT EXISTS project_steps_day ON project_steps(day);
      CREATE TABLE IF NOT EXISTS realtime_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        at TEXT NOT NULL,
        day TEXT NOT NULL,
        model TEXT,
        ok INTEGER NOT NULL DEFAULT 1,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL,
        ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS realtime_jobs_day ON realtime_jobs(day);
      CREATE TABLE IF NOT EXISTS notices (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        at TEXT NOT NULL,
        day TEXT NOT NULL,
        project_id TEXT,
        detail TEXT NOT NULL DEFAULT '',
        answer TEXT,
        answered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS notices_day ON notices(day);
      CREATE TABLE IF NOT EXISTS pauses (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        day TEXT NOT NULL,
        minutes INTEGER NOT NULL,
        ended_at TEXT,
        what TEXT NOT NULL DEFAULT '',
        reason TEXT,
        project_id TEXT
      );
      CREATE INDEX IF NOT EXISTS pauses_day ON pauses(day);
      CREATE TABLE IF NOT EXISTS pauses_liked (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        minutes INTEGER NOT NULL DEFAULT 10,
        status TEXT NOT NULL DEFAULT 'liked' CHECK(status IN ('proposed','liked','dismissed')),
        why TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'user',
        offered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS handed_files (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('image','video','audio','document')),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        filename TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        task TEXT NOT NULL DEFAULT '',
        seen_at TEXT
      );
      CREATE INDEX IF NOT EXISTS handed_files_at ON handed_files(at);
    `);
    const column = (table, name, ddl) => {
      if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl};`);
    };
    // proposed: put there by a model, waiting for the user; why: what in the user's words it came from
    column('agenda_items', 'proposed', 'INTEGER NOT NULL DEFAULT 0');
    column('agenda_items', 'why', 'TEXT');
    // keywords: the words that name it in an account (a JSON list); read_at: when the past days were read for it
    column('habits', 'keywords', 'TEXT');
    column('habits', 'read_at', 'TEXT');
    column('goals', 'keywords', 'TEXT');
  }

  /** Entries made when a day could have several: joined into the first of the day, in the order they were told. */
  mergeDiaryDays() {
    const days = this.db.prepare('SELECT day FROM diary_entries GROUP BY day HAVING COUNT(*) > 1').all();
    days.forEach(({ day }) => this.store.transaction(() => {
      const rows = this.db.prepare('SELECT * FROM diary_entries WHERE day=? ORDER BY created_at, rowid').all(day);
      const raw = rows.map(r => r.raw_text).join('\n\n');
      // The data of the pieces do not describe the whole day: they are worked out again.
      this.db.prepare('UPDATE diary_entries SET raw_text=?, extracted_json=NULL, page_text=NULL, updated_at=? WHERE id=?').run(raw, now(), rows[0].id);
      const drop = this.db.prepare('DELETE FROM diary_entries WHERE id=?');
      rows.slice(1).forEach(r => drop.run(r.id));
    }));
  }

  /* ---------------------------- agenda ---------------------------- */

  agendaItem(id) {
    const row = this.db.prepare('SELECT * FROM agenda_items WHERE id=?').get(id);
    if (!row) fail('Voce di agenda non trovata.', 404);
    return row;
  }

  /** Items touching [from, to) — a lasting activity counts on every day it covers — plus reminders still open from before. */
  agenda({ from, to, includeOpen = true } = {}) {
    const start = from && LOCAL_TIME.test(from) ? from : '0000-01-01T00:00';
    const end = to && LOCAL_TIME.test(to) ? to : '9999-12-31T23:59';
    const rows = this.db.prepare(`SELECT * FROM agenda_items
      WHERE proposed=0 AND ((start_at < ? AND COALESCE(end_at, start_at) >= ?)
         OR (? AND kind='reminder' AND done=0 AND start_at < ?))
      ORDER BY start_at, created_at`).all(end, start, includeOpen ? 1 : 0, start);
    return rows;
  }

  /** What a model proposed for the agenda and the user has not answered yet. */
  agendaProposals() {
    return this.db.prepare('SELECT * FROM agenda_items WHERE proposed=1 ORDER BY start_at, created_at').all();
  }

  saveAgendaItem(input, id = null) {
    const old = id ? this.agendaItem(id) : null;
    const kind = input.kind === undefined && old ? old.kind : input.kind;
    if (!['reminder', 'activity'].includes(kind)) fail('Tipo non valido: promemoria o attività.');
    const title = input.title === undefined && old ? old.title : text(input.title, 300, 'Titolo');
    const notes = input.notes === undefined ? (old?.notes || '') : text(input.notes, 4000, 'Note', true);
    const startAt = input.startAt === undefined && old ? old.start_at : time(input.startAt, 'Inizio');
    let endAt = input.endAt === undefined ? (old?.end_at ?? null) : time(input.endAt, 'Fine', true);
    if (kind === 'reminder') endAt = null;
    if (endAt && endAt < startAt) fail('La fine viene prima dell\'inizio.');
    const done = input.done === undefined ? (old?.done || 0) : (input.done ? 1 : 0);
    const proposed = input.proposed === undefined ? (old?.proposed || 0) : (input.proposed ? 1 : 0);
    const why = input.why === undefined ? (old?.why ?? null) : (text(input.why, 600, 'Motivo', true) || null);
    // A proposal is made once: the same thing on the same day is there already, in the agenda or waiting.
    if (!old && proposed) {
      const same = this.db.prepare('SELECT id FROM agenda_items WHERE lower(title)=lower(?) AND substr(start_at, 1, 10)=?').get(title, startAt.slice(0, 10));
      if (same) return this.agendaItem(same.id);
    }
    // Moved to another moment: it will be announced again then.
    const notifiedAt = old && startAt === old.start_at ? old.notified_at : null;
    const date = now();
    if (old) {
      this.db.prepare('UPDATE agenda_items SET kind=?,title=?,notes=?,start_at=?,end_at=?,done=?,notified_at=?,proposed=?,why=?,updated_at=? WHERE id=?')
        .run(kind, title, notes, startAt, endAt, done, notifiedAt, proposed, why, date, id);
      return this.agendaItem(id);
    }
    const newId = randomUUID();
    const source = input.source === 'realtime' ? 'realtime' : 'user';
    this.db.prepare('INSERT INTO agenda_items(id,kind,title,notes,start_at,end_at,done,notified_at,source,proposed,why,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(newId, kind, title, notes, startAt, endAt, done, null, source, proposed, why, date, date);
    return this.agendaItem(newId);
  }

  deleteAgendaItem(id) {
    this.agendaItem(id);
    this.db.prepare('DELETE FROM agenda_items WHERE id=?').run(id);
  }

  /** Reminders whose moment has come (at the caller's local time) and that were not announced yet; they are marked announced. */
  dueReminders(localNow) {
    if (!LOCAL_TIME.test(localNow || '')) fail('Ora locale non valida.');
    const rows = this.db.prepare("SELECT * FROM agenda_items WHERE kind='reminder' AND proposed=0 AND done=0 AND notified_at IS NULL AND start_at <= ? ORDER BY start_at").all(localNow);
    const mark = this.db.prepare('UPDATE agenda_items SET notified_at=? WHERE id=?');
    const date = now();
    rows.forEach(row => mark.run(date, row.id));
    return rows;
  }

  /* ----------------------------- diary ---------------------------- */

  diaryEntry(id) {
    const row = this.db.prepare('SELECT * FROM diary_entries WHERE id=?').get(id);
    if (!row) fail('Voce di diario non trovata.', 404);
    return row;
  }

  /**
   * The entries between two days, the latest first. fields: 'days' gives
   * the days alone, 'data' the day's data without the account and the page
   * (what the numbers are worked out of), anything else the whole entries.
   */
  diary({ from, to, limit = 200, fields = null } = {}) {
    const start = from && LOCAL_DAY.test(from) ? from : '0000-01-01';
    const end = to && LOCAL_DAY.test(to) ? to : '9999-12-31';
    const n = Math.max(1, Math.min(1000, Number(limit) || 200));
    const columns = fields === 'days' ? 'id, day' : fields === 'data' ? 'id, day, extracted_json' : '*';
    return this.db.prepare(`SELECT ${columns} FROM diary_entries WHERE day >= ? AND day <= ? ORDER BY day DESC, created_at DESC LIMIT ?`).all(start, end, n);
  }

  diaryCount() {
    return this.db.prepare('SELECT COUNT(*) AS days FROM diary_entries').get();
  }

  /**
   * With an id: the entry's fields given are replaced. Without: what was told
   * about a day — the day's entry is made, or, when the day has one, the
   * account is added to it.
   */
  saveDiaryEntry(input, id = null) {
    let old = id ? this.diaryEntry(id) : null;
    const day = input.day === undefined && old ? old.day : input.day;
    if (typeof day !== 'string' || !LOCAL_DAY.test(day)) fail('Giorno non valido (AAAA-MM-GG).');
    const sameDay = this.db.prepare('SELECT * FROM diary_entries WHERE day=?').get(day);
    if (old && sameDay && sameDay.id !== old.id) fail('Questo giorno ha già una pagina di diario.', 409);
    let raw = input.rawText === undefined && old ? old.raw_text : text(input.rawText, 50000, 'Racconto');
    if (!old && sameDay) {
      old = sameDay;
      id = sameDay.id;
      raw = text(`${sameDay.raw_text}\n\n${raw}`, 50000, 'Racconto');
    }
    let extracted = old?.extracted_json ?? null;
    if (input.extracted !== undefined) {
      if (input.extracted !== null && (typeof input.extracted !== 'object' || Array.isArray(input.extracted))) fail('Dati estratti non validi.');
      extracted = input.extracted === null ? null : JSON.stringify(input.extracted);
      if (extracted && extracted.length > 50000) fail('Dati estratti troppo grandi.');
    }
    const page = input.pageText === undefined ? (old?.page_text ?? null) : (text(input.pageText, 50000, 'Pagina', true) || null);
    const date = now();
    if (old) {
      this.db.prepare('UPDATE diary_entries SET day=?,raw_text=?,extracted_json=?,page_text=?,updated_at=? WHERE id=?').run(day, raw, extracted, page, date, id);
      return this.diaryEntry(id);
    }
    const newId = randomUUID();
    const source = input.source === 'user' ? 'user' : 'realtime';
    this.db.prepare('INSERT INTO diary_entries(id,day,raw_text,extracted_json,page_text,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(newId, day, raw, extracted, page, source, date, date);
    return this.diaryEntry(newId);
  }

  /** The day goes with all that was worked out of it: page, data, and what the habits did that day. */
  deleteDiaryEntry(id) {
    const entry = this.diaryEntry(id);
    this.store.transaction(() => {
      this.db.prepare('DELETE FROM habit_days WHERE day=?').run(entry.day);
      this.db.prepare('DELETE FROM diary_entries WHERE id=?').run(id);
    });
  }

  deleteDiary() {
    return this.store.transaction(() => {
      this.db.prepare('DELETE FROM habit_days').run();
      return { deleted: this.db.prepare('DELETE FROM diary_entries').run().changes };
    });
  }

  /* ----------------------------- habits --------------------------- */
  /*
   * A habit is something the user does again and again, good for them
   * (positive) or not (negative). 'proposed': noticed by the model in the
   * accounts, waiting for the user; 'tracked': followed day by day;
   * 'dismissed': turned down, kept so that it is not proposed again.
   * habit_days says, for a day, whether a habit was done (1) or not (0); a
   * day without a row is a day nothing is known about. 'diary' rows come from
   * the day's account and are made again with it; 'user' rows were set by
   * hand and stay.
   */

  habit(id) {
    const row = this.db.prepare('SELECT * FROM habits WHERE id=?').get(id);
    if (!row) fail('Abitudine non trovata.', 404);
    return row;
  }

  habits() {
    return this.db.prepare("SELECT * FROM habits ORDER BY CASE status WHEN 'tracked' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END, created_at").all();
  }

  saveHabit(input, id = null) {
    const old = id ? this.habit(id) : null;
    const name = input.name === undefined && old ? old.name : text(input.name, 80, 'Nome');
    const sign = input.sign === undefined && old ? old.sign : input.sign;
    if (!['positive', 'negative'].includes(sign)) fail('Segno non valido: positiva o negativa.');
    const status = input.status === undefined ? (old?.status || 'tracked') : input.status;
    if (!['proposed', 'tracked', 'dismissed'].includes(status)) fail('Stato non valido.');
    const notes = input.notes === undefined ? (old?.notes || '') : text(input.notes, 600, 'Note', true);
    const same = this.db.prepare('SELECT id FROM habits WHERE lower(name)=lower(?)').get(name);
    if (same && same.id !== id) fail('Questa abitudine c\'è già.', 409);
    // Another name or another description: the words that name it, and the past read for it, are of the old one.
    const renamed = old && (name !== old.name || notes !== old.notes);
    const keywords = input.keywords === undefined ? (renamed ? null : (old?.keywords ?? null)) : words(input.keywords);
    const readAt = input.readAt === undefined ? (renamed ? null : (old?.read_at ?? null)) : (input.readAt ? now() : null);
    const date = now();
    if (old) {
      this.db.prepare('UPDATE habits SET name=?,sign=?,status=?,notes=?,keywords=?,read_at=?,updated_at=? WHERE id=?').run(name, sign, status, notes, keywords, readAt, date, id);
      return this.habit(id);
    }
    const newId = randomUUID();
    const source = input.source === 'model' ? 'model' : 'user';
    this.db.prepare('INSERT INTO habits(id,name,sign,status,notes,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(newId, name, sign, status, notes, source, date, date);
    return this.habit(newId);
  }

  deleteHabit(id) {
    this.habit(id);
    this.db.prepare('DELETE FROM habits WHERE id=?').run(id);
  }

  habitDays({ from, to } = {}) {
    const start = from && LOCAL_DAY.test(from) ? from : '0000-01-01';
    const end = to && LOCAL_DAY.test(to) ? to : '9999-12-31';
    return this.db.prepare('SELECT * FROM habit_days WHERE day >= ? AND day <= ? ORDER BY day').all(start, end);
  }

  /** One habit on one day, set by hand: done, not done, or (done null) nothing known. */
  markHabit({ habitId, day, done }) {
    this.habit(habitId);
    if (typeof day !== 'string' || !LOCAL_DAY.test(day)) fail('Giorno non valido (AAAA-MM-GG).');
    if (done === null || done === undefined) {
      this.db.prepare('DELETE FROM habit_days WHERE habit_id=? AND day=?').run(habitId, day);
      return { habit_id: habitId, day, done: null };
    }
    if (typeof done !== 'boolean') fail('Valore non valido: fatta o non fatta.');
    this.db.prepare(`INSERT INTO habit_days(habit_id,day,done,source,updated_at) VALUES(?,?,?,'user',?)
      ON CONFLICT(habit_id,day) DO UPDATE SET done=excluded.done, source='user', updated_at=excluded.updated_at`)
      .run(habitId, day, done ? 1 : 0, now());
    return this.db.prepare('SELECT * FROM habit_days WHERE habit_id=? AND day=?').get(habitId, day);
  }

  /**
   * What the past days say of habits followed from now on: added where
   * nothing is known yet, never in place of what is there. marks: { habitId,
   * day, done }.
   */
  addDiaryMarks({ marks }) {
    if (!Array.isArray(marks) || marks.length > 5000) fail('Elenco non valido.');
    const insert = this.db.prepare("INSERT OR IGNORE INTO habit_days(habit_id,day,done,source,updated_at) VALUES(?,?,?,'diary',?)");
    const known = new Set(this.db.prepare('SELECT id FROM habits').all().map(h => h.id));
    const date = now();
    let added = 0;
    this.store.transaction(() => marks.forEach(mark => {
      if (!mark || typeof mark.done !== 'boolean' || !known.has(mark.habitId)) return;
      if (typeof mark.day !== 'string' || !LOCAL_DAY.test(mark.day)) return;
      added += insert.run(mark.habitId, mark.day, mark.done ? 1 : 0, date).changes;
    }));
    return { added };
  }

  /** What the day's account says of the habits: it replaces what an earlier reading of the account said, not what was set by hand. */
  setDiaryMarks({ day, marks }) {
    if (typeof day !== 'string' || !LOCAL_DAY.test(day)) fail('Giorno non valido (AAAA-MM-GG).');
    if (!Array.isArray(marks) || marks.length > 200) fail('Elenco non valido.');
    return this.store.transaction(() => {
      this.db.prepare("DELETE FROM habit_days WHERE day=? AND source='diary'").run(day);
      const byHand = new Set(this.db.prepare('SELECT habit_id FROM habit_days WHERE day=?').all(day).map(r => r.habit_id));
      const insert = this.db.prepare("INSERT OR REPLACE INTO habit_days(habit_id,day,done,source,updated_at) VALUES(?,?,?,'diary',?)");
      const date = now();
      marks.forEach(mark => {
        if (!mark || typeof mark.done !== 'boolean' || byHand.has(mark.habitId)) return;
        if (!this.db.prepare('SELECT id FROM habits WHERE id=?').get(String(mark.habitId))) return;
        insert.run(String(mark.habitId), day, mark.done ? 1 : 0, date);
      });
      return this.db.prepare('SELECT * FROM habit_days WHERE day=?').all(day);
    });
  }

  /* ---------------------------- reviews --------------------------- */

  reviews({ limit = 12 } = {}) {
    const n = Math.max(1, Math.min(200, Number(limit) || 12));
    return this.db.prepare('SELECT * FROM wellbeing_reviews ORDER BY to_day DESC, created_at DESC LIMIT ?').all(n);
  }

  /** The review of a period: written again, it takes the place of the one there was. */
  saveReview(input) {
    const from = input.fromDay, to = input.toDay;
    if (![from, to].every(d => typeof d === 'string' && LOCAL_DAY.test(d)) || to < from) fail('Periodo non valido.');
    const body = text(input.text, 8000, 'Riepilogo');
    const old = this.db.prepare('SELECT id FROM wellbeing_reviews WHERE from_day=? AND to_day=?').get(from, to);
    const id = old?.id || randomUUID();
    this.db.prepare(`INSERT INTO wellbeing_reviews(id,from_day,to_day,text,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET text=excluded.text, created_at=excluded.created_at`).run(id, from, to, body, now());
    return this.db.prepare('SELECT * FROM wellbeing_reviews WHERE id=?').get(id);
  }

  deleteReview(id) {
    if (!this.db.prepare('DELETE FROM wellbeing_reviews WHERE id=?').run(id).changes) fail('Riepilogo non trovato.', 404);
  }

  /* ------------------------------ goals --------------------------- */
  /*
   * 'open': being worked at; 'done': reached; 'dropped': given up. A step is
   * done or not; when the model reads in a day's account or in the project's
   * steps that one seems done, it proposes so (proposed_day, proposed_why)
   * and the user says yes or no: the model never closes a step by itself.
   */

  goal(id) {
    const row = this.db.prepare('SELECT * FROM goals WHERE id=?').get(id);
    if (!row) fail('Obiettivo non trovato.', 404);
    return { ...row, steps: this.db.prepare('SELECT * FROM goal_steps WHERE goal_id=? ORDER BY position, created_at').all(id) };
  }

  goals() {
    const steps = this.db.prepare('SELECT * FROM goal_steps ORDER BY position, created_at').all();
    return this.db.prepare("SELECT * FROM goals ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, COALESCE(due_day, '9999-12-31'), created_at").all()
      .map(goal => ({ ...goal, steps: steps.filter(step => step.goal_id === goal.id) }));
  }

  saveGoal(input, id = null) {
    const old = id ? this.goal(id) : null;
    const name = input.name === undefined && old ? old.name : text(input.name, 120, 'Nome');
    const notes = input.notes === undefined ? (old?.notes || '') : text(input.notes, 2000, 'Note', true);
    const due = input.dueDay === undefined ? (old?.due_day ?? null) : day(input.dueDay, 'Scadenza');
    let project = input.projectId === undefined ? (old?.project_id ?? null) : (input.projectId || null);
    if (project !== null) {
      project = String(project);
      if (!this.db.prepare('SELECT id FROM projects WHERE id=?').get(project)) fail('Progetto non trovato.', 404);
    }
    const status = input.status === undefined ? (old?.status || 'open') : input.status;
    if (!['open', 'done', 'dropped'].includes(status)) fail('Stato non valido.');
    // The day it was reached or given up: the one said, or today when it changes state.
    const keywords = input.keywords === undefined ? (old && name !== old.name ? null : (old?.keywords ?? null)) : words(input.keywords);
    let closed = input.closedDay === undefined ? (old?.closed_day ?? null) : day(input.closedDay, 'Giorno di chiusura');
    if (status === 'open') closed = null;
    else if (!closed) closed = localDay();
    const date = now();
    if (old) {
      this.db.prepare('UPDATE goals SET name=?,notes=?,due_day=?,project_id=?,status=?,closed_day=?,keywords=?,updated_at=? WHERE id=?')
        .run(name, notes, due, project, status, closed, keywords, date, id);
      return this.goal(id);
    }
    const newId = randomUUID();
    const source = input.source === 'realtime' ? 'realtime' : 'user';
    return this.store.transaction(() => {
      this.db.prepare('INSERT INTO goals(id,name,notes,due_day,project_id,status,closed_day,keywords,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(newId, name, notes, due, project, status, closed, keywords, source, date, date);
      (Array.isArray(input.steps) ? input.steps : []).slice(0, 50).forEach(step => this.saveGoalStep(newId, typeof step === 'string' ? { title: step } : step));
      return this.goal(newId);
    });
  }

  deleteGoal(id) {
    this.goal(id);
    this.db.prepare('DELETE FROM goals WHERE id=?').run(id);
  }

  goalStep(id) {
    const row = this.db.prepare('SELECT * FROM goal_steps WHERE id=?').get(id);
    if (!row) fail('Tappa non trovata.', 404);
    return row;
  }

  /**
   * A step of a goal, new or changed. `done` closes or reopens it (the day:
   * the one said, the one proposed, or today). `proposedDay` is the model
   * saying it seems done, null the user saying it is not.
   */
  saveGoalStep(goalId, input, id = null) {
    const old = id ? this.goalStep(id) : null;
    if (old && old.goal_id !== goalId) fail('La tappa è di un altro obiettivo.', 409);
    this.goal(goalId);
    const title = input.title === undefined && old ? old.title : text(input.title, 200, 'Tappa');
    const due = input.dueDay === undefined ? (old?.due_day ?? null) : day(input.dueDay, 'Scadenza');
    const position = input.position === undefined
      ? (old ? old.position : (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM goal_steps WHERE goal_id=?').get(goalId).next))
      : Math.max(0, Math.min(10000, Number(input.position) || 0));
    let done = old?.done || 0;
    let doneDay = old?.done_day ?? null;
    let proposedDay = old?.proposed_day ?? null;
    let proposedWhy = old?.proposed_why ?? null;
    if (input.proposedDay !== undefined) {
      proposedDay = day(input.proposedDay, 'Giorno proposto');
      proposedWhy = proposedDay ? text(input.proposedWhy ?? '', 600, 'Motivo', true) : null;
    }
    if (input.done !== undefined) {
      if (typeof input.done !== 'boolean') fail('Valore non valido: fatta o non fatta.');
      done = input.done ? 1 : 0;
      doneDay = done ? (day(input.doneDay, 'Giorno') || proposedDay || localDay()) : null;
      proposedDay = null;
      proposedWhy = null;
    }
    const date = now();
    if (old) {
      this.db.prepare('UPDATE goal_steps SET title=?,due_day=?,position=?,done=?,done_day=?,proposed_day=?,proposed_why=?,updated_at=? WHERE id=?')
        .run(title, due, position, done, doneDay, proposedDay, proposedWhy, date, id);
      return this.goalStep(id);
    }
    const newId = randomUUID();
    this.db.prepare('INSERT INTO goal_steps(id,goal_id,title,due_day,position,done,done_day,proposed_day,proposed_why,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(newId, goalId, title, due, position, done, doneDay, proposedDay, proposedWhy, date, date);
    return this.goalStep(newId);
  }

  deleteGoalStep(id) {
    this.goalStep(id);
    this.db.prepare('DELETE FROM goal_steps WHERE id=?').run(id);
  }

  /* ------------------------------ notices ------------------------- */

  /** A notice given: what it was about and what it said. */
  recordNotice(input) {
    const kind = text(input.kind, 40, 'Avviso');
    const at = new Date();
    const id = randomUUID();
    this.db.prepare('INSERT INTO notices(id,kind,at,day,project_id,detail) VALUES(?,?,?,?,?,?)')
      .run(id, kind, at.toISOString(), localDay(at), input.projectId ? String(input.projectId) : null, text(input.detail ?? '', 1000, 'Testo', true));
    // Three months of them are kept.
    this.db.prepare('DELETE FROM notices WHERE day < ?').run(localDay(new Date(at.getTime() - 92 * 86400000)));
    return this.db.prepare('SELECT * FROM notices WHERE id=?').get(id);
  }

  /** How a notice was answered: 'pause', 'later', 'ok', 'today' (no more of its kind today). */
  answerNotice(id, answer) {
    if (!['pause', 'later', 'ok', 'today'].includes(answer)) fail('Risposta non valida.');
    const done = this.db.prepare('UPDATE notices SET answer=?, answered_at=? WHERE id=?').run(answer, now(), String(id));
    if (!done.changes) fail('Avviso non trovato.', 404);
    return this.db.prepare('SELECT * FROM notices WHERE id=?').get(String(id));
  }

  deleteNotice(id) {
    const done = this.db.prepare('DELETE FROM notices WHERE id=?').run(String(id));
    if (!done.changes) fail('Avviso non trovato.', 404);
  }

  /** The notices of a day, the latest first: what decides whether another may be given. */
  notices({ day: dayText } = {}) {
    const wanted = dayText && LOCAL_DAY.test(dayText) ? dayText : localDay();
    return this.db.prepare('SELECT * FROM notices WHERE day=? ORDER BY at DESC').all(wanted);
  }

  /* ------------------------------ files --------------------------- */

  /**
   * A file handed to the user: its link in the workspace of the chat that
   * made it, as it is stored (no origin). Handed again — the same file
   * written anew — it is the same row, new again.
   */
  handFile(input) {
    const kind = String(input.kind || '');
    if (!HANDED_KINDS.includes(kind)) fail('Tipo di file non valido.');
    const url = workspaceLink(input.url);
    if (!url) fail('Il file non è nel workspace di una chat.');
    const filename = text(input.filename || decodeURIComponent(url.split('/').pop()), 300, 'Nome del file');
    const title = text(input.title || filename, 200, 'Titolo');
    const description = text(input.description ?? '', 600, 'Descrizione', true);
    const task = text(String(input.task ?? '').slice(0, 300), 300, 'Compito', true);
    // at: when it was made, for what was made before it was handed here; seen: the user has looked at it already
    const at = input.at && !Number.isNaN(Date.parse(input.at)) ? new Date(input.at).toISOString() : now();
    const seen = input.seen ? at : null;
    const existing = this.db.prepare('SELECT id FROM handed_files WHERE url=?').get(url);
    const id = existing?.id || randomUUID();
    if (existing) {
      this.db.prepare('UPDATE handed_files SET at=?,kind=?,title=?,description=?,filename=?,task=?,seen_at=? WHERE id=?')
        .run(at, kind, title, description, filename, task, seen, id);
    } else {
      this.db.prepare('INSERT INTO handed_files(id,at,kind,title,description,filename,url,task,seen_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, at, kind, title, description, filename, url, task, seen);
    }
    return this.handedFile(id);
  }

  handedFile(id) {
    const row = this.db.prepare('SELECT * FROM handed_files WHERE id=?').get(String(id));
    if (!row) fail('File non trovato.', 404);
    return row;
  }

  /**
   * The files handed, the latest first, a page at a time: `before` is the
   * moment of the last one already read. `query`: words looked for in
   * title, name, description and task, all of them; `kind`: one kind only.
   * `more` says whether older ones are left.
   */
  handedFiles({ limit = 30, before = null, query = '', kind = '' } = {}) {
    const most = Math.min(100, Math.max(1, Math.round(Number(limit)) || 30));
    const where = [];
    const values = [];
    if (before) { where.push('at < ?'); values.push(String(before)); }
    if (HANDED_KINDS.includes(kind)) { where.push('kind = ?'); values.push(kind); }
    String(query || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6).forEach(word => {
      const like = `%${word.replace(/[\\%_]/g, c => '\\' + c)}%`;
      where.push("(lower(title) LIKE ? ESCAPE '\\' OR lower(filename) LIKE ? ESCAPE '\\' OR lower(description) LIKE ? ESCAPE '\\' OR lower(task) LIKE ? ESCAPE '\\')");
      values.push(like, like, like, like);
    });
    const rows = this.db.prepare(`SELECT * FROM handed_files ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC, rowid DESC LIMIT ?`)
      .all(...values, most + 1);
    return { files: rows.slice(0, most), more: rows.length > most, unseen: this.db.prepare('SELECT COUNT(*) AS n FROM handed_files WHERE seen_at IS NULL').get().n };
  }

  /** The user has opened it. */
  seeFile(id) {
    const row = this.handedFile(id);
    if (!row.seen_at) this.db.prepare('UPDATE handed_files SET seen_at=? WHERE id=?').run(now(), row.id);
    return this.handedFile(row.id);
  }

  /** Taken out of what was handed; the file itself stays where it is, in its chat. */
  dropFile(id) {
    const done = this.db.prepare('DELETE FROM handed_files WHERE id=?').run(String(id));
    if (!done.changes) fail('File non trovato.', 404);
  }

  /* ------------------------------ pauses -------------------------- */

  /** A pause starts: how long it is meant to last and what it is for. One at a time: the one open is ended. */
  startPause(input) {
    const minutes = Math.round(Number(input.minutes));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) fail('Durata della pausa non valida (da 1 a 240 minuti).');
    const at = new Date();
    this.db.prepare('UPDATE pauses SET ended_at=? WHERE ended_at IS NULL').run(at.toISOString());
    const id = randomUUID();
    this.db.prepare('INSERT INTO pauses(id,started_at,day,minutes,what,reason,project_id) VALUES(?,?,?,?,?,?,?)')
      .run(id, at.toISOString(), localDay(at), minutes, text(input.what ?? '', 120, 'Pausa', true),
        input.reason ? text(input.reason, 40, 'Motivo', true) : null, input.projectId ? String(input.projectId) : null);
    return this.db.prepare('SELECT * FROM pauses WHERE id=?').get(id);
  }

  endPause(id) {
    const row = this.db.prepare('SELECT * FROM pauses WHERE id=?').get(String(id));
    if (!row) fail('Pausa non trovata.', 404);
    if (!row.ended_at) this.db.prepare('UPDATE pauses SET ended_at=? WHERE id=?').run(now(), row.id);
    return this.db.prepare('SELECT * FROM pauses WHERE id=?').get(row.id);
  }

  /** A pause recorded by mistake is taken out of the record. */
  deletePause(id) {
    const done = this.db.prepare('DELETE FROM pauses WHERE id=?').run(String(id));
    if (!done.changes) fail('Pausa non trovata.', 404);
  }

  /** The pause under way, if there is one. */
  openPause() {
    return this.db.prepare('SELECT * FROM pauses WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get() || null;
  }

  /** The pauses between two days, with how long each lasted in fact. */
  pauses({ from, to } = {}) {
    const start = from && LOCAL_DAY.test(from) ? from : '0000-01-01';
    const end = to && LOCAL_DAY.test(to) ? to : '9999-12-31';
    return this.db.prepare('SELECT * FROM pauses WHERE day >= ? AND day <= ? ORDER BY started_at').all(start, end).map(row => ({
      ...row,
      lasted: row.ended_at ? Math.max(0, Math.round((Date.parse(row.ended_at) - Date.parse(row.started_at)) / 60000)) : null
    }));
  }

  likedPause(id) {
    const row = this.db.prepare('SELECT * FROM pauses_liked WHERE id=?').get(String(id));
    if (!row) fail('Pausa non trovata.', 404);
    return row;
  }

  likedPauses() {
    return this.db.prepare("SELECT * FROM pauses_liked ORDER BY CASE status WHEN 'liked' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END, created_at").all();
  }

  /** A pause the user likes; `offered` says it was just proposed in a notice, so that the next notice proposes another. */
  saveLikedPause(input, id = null) {
    const old = id ? this.likedPause(id) : null;
    const name = input.name === undefined && old ? old.name : text(input.name, 80, 'Nome');
    const minutes = input.minutes === undefined ? (old?.minutes || 10) : Math.round(Number(input.minutes));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) fail('Durata non valida (da 1 a 240 minuti).');
    const status = input.status === undefined ? (old?.status || 'liked') : input.status;
    if (!['proposed', 'liked', 'dismissed'].includes(status)) fail('Stato non valido.');
    const why = input.why === undefined ? (old?.why || '') : text(input.why, 600, 'Motivo', true);
    const same = this.db.prepare('SELECT id FROM pauses_liked WHERE lower(name)=lower(?)').get(name);
    if (same && same.id !== id) {
      // Proposed again by a model: it is there already, whatever the user made of it.
      if (!old && input.source === 'model') return this.likedPause(same.id);
      fail('Questa pausa c\'è già.', 409);
    }
    const offered = input.offered ? now() : (old?.offered_at ?? null);
    const date = now();
    if (old) {
      this.db.prepare('UPDATE pauses_liked SET name=?,minutes=?,status=?,why=?,offered_at=?,updated_at=? WHERE id=?').run(name, minutes, status, why, offered, date, id);
      return this.likedPause(id);
    }
    const newId = randomUUID();
    this.db.prepare('INSERT INTO pauses_liked(id,name,minutes,status,why,source,offered_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(newId, name, minutes, status, why, input.source === 'model' ? 'model' : 'user', offered, date, date);
    return this.likedPause(newId);
  }

  deleteLikedPause(id) {
    this.likedPause(id);
    this.db.prepare('DELETE FROM pauses_liked WHERE id=?').run(String(id));
  }

  /**
   * What the last hours of a project hold, for the notices: the steps
   * recorded (when, who, which files), the moments the user wrote in the
   * project's chats, the pauses taken. Moments are as the clock gives them,
   * to be compared with now.
   */
  signals({ projectId, hours = 8 } = {}) {
    const project = this.db.prepare('SELECT id, name FROM projects WHERE id=?').get(String(projectId || ''));
    if (!project) fail('Progetto non trovato.', 404);
    const since = new Date(Date.now() - Math.max(1, Math.min(24, Number(hours) || 8)) * 3600000).toISOString();
    return {
      project,
      now: now(),
      steps: this.db.prepare('SELECT at, source, title, files FROM project_steps WHERE project_id=? AND at >= ? ORDER BY at').all(project.id, since),
      messages: this.db.prepare(`SELECT m.created_at AS at FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.project_id=? AND m.created_at >= ? AND m.role='user' AND m.kind='final' ORDER BY m.created_at`).all(project.id, since),
      pauses: this.db.prepare('SELECT started_at, ended_at, minutes FROM pauses WHERE started_at >= ? ORDER BY started_at').all(since)
    };
  }

  /* ------------------------------- jobs --------------------------- */

  /** A request made to a model in the background, with what it cost. */
  recordJob(input) {
    const kind = text(input.kind, 40, 'Lavoro');
    const count = (v) => Math.max(0, Math.round(Number(v) || 0));
    const at = new Date();
    this.db.prepare('INSERT INTO realtime_jobs(kind,at,day,model,ok,prompt_tokens,completion_tokens,cached_tokens,cost,ms) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(kind, at.toISOString(), localDay(at), input.model ? String(input.model).slice(0, 200) : null, input.ok === false ? 0 : 1,
        count(input.promptTokens), count(input.completionTokens), count(input.cachedTokens),
        Number.isFinite(Number(input.cost)) && input.cost !== null && input.cost !== undefined ? Number(input.cost) : null, count(input.ms));
    // A year of it is kept.
    this.db.prepare('DELETE FROM realtime_jobs WHERE day < ?').run(localDay(new Date(at.getTime() - 366 * 86400000)));
    return { recorded: true };
  }

  /** What the jobs cost between two days, by kind, and the last of each. */
  jobs({ from, to } = {}) {
    const start = from && LOCAL_DAY.test(from) ? from : '0000-01-01';
    const end = to && LOCAL_DAY.test(to) ? to : '9999-12-31';
    const kinds = this.db.prepare(`SELECT kind, COUNT(*) AS runs, SUM(ok) AS done, SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens, SUM(cached_tokens) AS cached_tokens, SUM(cost) AS cost,
        CAST(AVG(ms) AS INTEGER) AS ms, MAX(at) AS last_at
      FROM realtime_jobs WHERE day >= ? AND day <= ? GROUP BY kind ORDER BY SUM(prompt_tokens + completion_tokens) DESC`).all(start, end);
    const days = this.db.prepare(`SELECT day, COUNT(*) AS runs, SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens, SUM(cost) AS cost
      FROM realtime_jobs WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day`).all(start, end);
    return { from: start, to: end, kinds, days };
  }

  /* ----------------------------- activity ------------------------- */

  /** Steps of a project as its history gives them, kept once each. Times are turned into this computer's day and hour. */
  recordSteps(projectId, commits) {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO project_steps(project_id,hash,at,day,hour,source,tool,title,files,additions,deletions)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    let added = 0;
    this.store.transaction(() => (commits || []).forEach(commit => {
      const at = new Date(commit?.when);
      if (!commit?.hash || isNaN(at)) return;
      added += insert.run(String(projectId), String(commit.hash), at.toISOString(), localDay(at), at.getHours(),
        commit.source || null, commit.tool || null, String(commit.title || '').slice(0, 500),
        Number(commit.files) || 0, Number(commit.additions) || 0, Number(commit.deletions) || 0).changes;
    }));
    return added;
  }

  /** When each project was last changed: its latest step, by project. */
  lastSteps() {
    return Object.fromEntries(this.db.prepare('SELECT project_id, MAX(at) AS at FROM project_steps GROUP BY project_id').all().map(row => [row.project_id, row.at]));
  }

  /**
   * What was done in the app between two days: the steps of the projects by
   * project, day, hour and who made them (the user or a model), the messages
   * the user wrote by place, day and hour, and the projects with the last
   * day each was worked at.
   */
  activity({ from, to } = {}) {
    const start = from && LOCAL_DAY.test(from) ? from : '0000-01-01';
    const end = to && LOCAL_DAY.test(to) ? to : '9999-12-31';
    // The steps of a project that is no more go with it.
    this.db.prepare('DELETE FROM project_steps WHERE project_id NOT IN (SELECT id FROM projects)').run();
    const steps = this.db.prepare(`SELECT project_id, day, hour, COALESCE(source, 'user') AS source, COUNT(*) AS steps,
        SUM(files) AS files, SUM(additions) AS additions, SUM(deletions) AS deletions
      FROM project_steps WHERE day >= ? AND day <= ? GROUP BY project_id, day, hour, COALESCE(source, 'user') ORDER BY day, hour`).all(start, end);
    const messages = this.db.prepare(`SELECT c.project_id, c.kind,
        strftime('%Y-%m-%d', m.created_at, 'localtime') AS day, CAST(strftime('%H', m.created_at, 'localtime') AS INTEGER) AS hour, COUNT(*) AS messages
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.created_at >= ? AND m.created_at < ?
        AND m.role='user' AND m.kind='final' AND COALESCE(json_extract(m.meta_json, '$.report'), 0) = 0
        AND COALESCE(json_extract(m.meta_json, '$.demo'), 0) = 0 AND json_extract(m.meta_json, '$.by') IS NULL
        AND strftime('%Y-%m-%d', m.created_at, 'localtime') BETWEEN ? AND ?
      GROUP BY c.project_id, c.kind, day, hour ORDER BY day, hour`).all(...around(start, end), start, end);
    const projects = this.db.prepare(`SELECT p.id, p.name, p.kind, (SELECT MAX(day) FROM project_steps s WHERE s.project_id = p.id) AS last_step_day,
        (SELECT COUNT(*) FROM project_steps s WHERE s.project_id = p.id) AS steps
      FROM projects p ORDER BY p.name`).all();
    const pauses = this.db.prepare(`SELECT day, COUNT(*) AS pauses,
        SUM(CASE WHEN ended_at IS NULL THEN 0 ELSE MAX(0, CAST(ROUND((julianday(ended_at) - julianday(started_at)) * 1440) AS INTEGER)) END) AS minutes
      FROM pauses WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day`).all(start, end);
    return { from: start, to: end, steps, messages, projects, pauses };
  }

  /** The steps of one day, by project, with their titles: what the day's page and the calendar show of the work done. */
  activityOfDay(dayText) {
    if (typeof dayText !== 'string' || !LOCAL_DAY.test(dayText)) fail('Giorno non valido (AAAA-MM-GG).');
    return this.db.prepare(`SELECT s.project_id, p.name AS project, s.at, s.source, s.tool, s.title, s.files, s.additions, s.deletions
      FROM project_steps s JOIN projects p ON p.id = s.project_id WHERE s.day = ? ORDER BY s.at LIMIT 400`).all(dayText);
  }
}

module.exports = { Personal, workspaceLink };
