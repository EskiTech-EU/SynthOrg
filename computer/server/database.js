'use strict';
const { DatabaseSync } = require('node:sqlite');
const { randomUUID, createHash } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { MemoryTree, given } = require('./memory-tree');
const { Personal } = require('./personal');
const { Usage } = require('./usage');
const { BridgeStore } = require('./bridge-store');
const { Replica, messageOf } = require('./replica');

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function text(value, max, name, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(`${name} non valido (massimo ${max} caratteri).`);
  return value;
}
function flag(value, fallback = false) {
  if (value === undefined) return Number(fallback);
  if (typeof value !== 'boolean') fail('Valore booleano non valido.');
  return Number(value);
}
const now = () => new Date().toISOString();
// The most the Realtime character's conversation takes of a request, in tokens, before its older part becomes summaries.
const REALTIME_CAP = 6000;
const PROJECT_SECTIONS = ['code', 'studio', 'photo'];
// The environments a project can have on together, and the section each one is worked in.
const PROJECT_ENVS = ['code', 'photo', 'writing'];
const ENV_SECTION = { code: 'code', photo: 'photo', writing: 'studio' };
/** The environments of a project: its own list, or the one its section stood for before projects had a list. */
function projectEnvs(project) {
  try {
    const list = JSON.parse(project.envs || 'null');
    if (Array.isArray(list)) { const known = PROJECT_ENVS.filter(env => list.includes(env)); if (known.length) return known; }
  } catch {}
  return [PROJECT_ENVS.find(env => ENV_SECTION[env] === project.section) || 'code'];
}
// The sections that are packages: in the installer, each with a switch of its own, on unless turned off.
const SWITCHABLE_SECTIONS = ['code', 'studio'];
// Which switch a project's section answers to: photos are a tab of the Studio.
const SECTION_SWITCH = { photo: 'studio' };
/**
 * Whether a section is on: the setting `sections` (written by the page's
 * sections.js) holds only what is off. Chat and the Realtime character are
 * not sections one can turn off.
 */
function sectionEnabled(store, name) {
  name = SECTION_SWITCH[name] || name;
  if (!SWITCHABLE_SECTIONS.includes(name)) return true;
  try {
    const parsed = JSON.parse(store.getSetting('sections') || '{}');
    return !(parsed && typeof parsed === 'object' && parsed[name] === false);
  } catch { return true; }
}
const PROJECTS_DDL = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('local','podman')),
    path TEXT NOT NULL, container_name TEXT UNIQUE, image TEXT,
    network INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, opened_at TEXT,
    repo TEXT, default_branch TEXT, branch_prefix TEXT, work_branch TEXT,
    repo_mode TEXT, repo_branch TEXT, auto_sync TEXT, repo_asked_at TEXT,
    perm_code TEXT, perm_terminal TEXT,
    section TEXT NOT NULL DEFAULT 'code',
    envs TEXT, notes TEXT
  );
`;
const stopwords = new Set('come cosa questo questa quello quella della delle degli nella nelle sono per con che una uno gli del dei hai puoi vorrei please what when where this that the and for you your'.split(' '));
function searchTerms(query) {
  return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(word => word.length > 2 && !stopwords.has(word)))].slice(0, 20).map(word => `"${word}"`).join(' OR ');
}

class Store {
  constructor(filename, { recover = true, wins = true } = {}) {
    // Whether this device's change stays when the other made one at the same instant (replica.js): the computer's does.
    this.wins = wins;
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename, { timeout: 5000, enableForeignKeyConstraints: true });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.db.close(); fail('Database creato da una versione più recente.', 503); }
    if (version === 0) this.transaction(() => this.db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
        memory_enabled INTEGER NOT NULL DEFAULT 1,
        global_memory_enabled INTEGER NOT NULL DEFAULT 1,
        sandbox_network INTEGER NOT NULL DEFAULT 0,
        sandbox_image TEXT NOT NULL DEFAULT 'alpine:latest',
        project_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
        kind TEXT NOT NULL DEFAULT 'final' CHECK(kind IN ('final','execution')),
        status TEXT NOT NULL CHECK(status IN ('complete','streaming','error','interrupted')),
        content TEXT NOT NULL, model_id TEXT, model_name TEXT, meta_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX messages_conversation ON messages(conversation_id, sequence);
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('global','conversation')),
        conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
        source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        section TEXT DEFAULT 'general_notes',
        enabled INTEGER NOT NULL DEFAULT 1, pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK((scope='global' AND conversation_id IS NULL) OR (scope='conversation' AND conversation_id IS NOT NULL))
      );
      CREATE INDEX memories_scope ON memories(conversation_id, enabled);
      CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER memories_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES(new.rowid,new.content);
      END;
      CREATE TRIGGER memories_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts,rowid,content) VALUES('delete',old.rowid,old.content);
      END;
      CREATE TRIGGER memories_update AFTER UPDATE OF content ON memories BEGIN
        INSERT INTO memories_fts(memories_fts,rowid,content) VALUES('delete',old.rowid,old.content);
        INSERT INTO memories_fts(rowid,content) VALUES(new.rowid,new.content);
      END;
      CREATE TABLE imports (fingerprint TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL);
      PRAGMA user_version=1;
    `));

    // Ensure sandbox columns and memory section column exist for existing databases
    try {
      const convColumns = this.db.prepare('PRAGMA table_info(conversations)').all();
      if (!convColumns.some(c => c.name === 'global_memory_enabled')) {
        this.db.exec("ALTER TABLE conversations ADD COLUMN global_memory_enabled INTEGER NOT NULL DEFAULT 1;");
      }
      if (!convColumns.some(c => c.name === 'sandbox_network')) {
        this.db.exec("ALTER TABLE conversations ADD COLUMN sandbox_network INTEGER NOT NULL DEFAULT 0;");
      }
      // A chat that belongs to a Code project: it lives in that project's
      // panel, gets its file tools, and stays out of the general chat list.
      if (!convColumns.some(c => c.name === 'project_id')) {
        this.db.exec('ALTER TABLE conversations ADD COLUMN project_id TEXT;');
      }
      // 'chat' for every conversation of the Chat tab and of Code; 'realtime'
      // for the one of the Realtime character, which no list shows;
      // 'realtime_tasks' for the chat where the Master does the character's
      // tasks, shown apart above the chat list.
      if (!convColumns.some(c => c.name === 'kind')) {
        this.db.exec("ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';");
      }
      // The device a chat was born on (the site of its archive, replica.js), written once and never changed: on a
      // phone the chats of its own world and those of the computer are told apart by it, and the phone's own never
      // leave it. Filled in by the replica when it installs (the rows from before take the device they came from).
      if (!convColumns.some(c => c.name === 'home')) {
        this.db.exec("ALTER TABLE conversations ADD COLUMN home TEXT NOT NULL DEFAULT '';");
      }
      // The chat's own models and parameters; null: the general ones.
      if (!convColumns.some(c => c.name === 'model_overrides_json')) {
        this.db.exec('ALTER TABLE conversations ADD COLUMN model_overrides_json TEXT;');
      }
      // The chat's environment switches besides the network: the model's terminal
      // in the chat's container, and computer use (a desktop in a container of
      // its own, every session asked to the user). Both start off.
      if (!convColumns.some(c => c.name === 'sandbox_terminal')) {
        this.db.exec('ALTER TABLE conversations ADD COLUMN sandbox_terminal INTEGER NOT NULL DEFAULT 0;');
      }
      if (!convColumns.some(c => c.name === 'sandbox_desktop')) {
        this.db.exec('ALTER TABLE conversations ADD COLUMN sandbox_desktop INTEGER NOT NULL DEFAULT 0;');
      }
      if (!convColumns.some(c => c.name === 'sandbox_image')) {
        this.db.exec("ALTER TABLE conversations ADD COLUMN sandbox_image TEXT NOT NULL DEFAULT 'alpine:latest';");
      }
      const memColumns = this.db.prepare('PRAGMA table_info(memories)').all();
      if (!memColumns.some(c => c.name === 'section')) {
        this.db.exec("ALTER TABLE memories ADD COLUMN section TEXT DEFAULT 'general_notes';");
      }
      // Where a note came from, for the ones written by the app itself
      // ('conversation', 'diary:2026-09-27', 'user'); null: not recorded.
      if (!memColumns.some(c => c.name === 'origin')) {
        this.db.exec('ALTER TABLE memories ADD COLUMN origin TEXT;');
      }
      // A conversation may have no end (the Realtime character's): what is asked of it at
      // every exchange must not read all of it. By day, for the activity; by the last
      // change, to know at a glance whether anything in a conversation changed.
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
        CREATE INDEX IF NOT EXISTS messages_touched ON messages(conversation_id, updated_at);
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    } catch {}

    // Code projects. Where a project runs (a folder of this computer, or a
    // container) and whether it is linked to a GitHub repository are two
    // independent choices: `kind` answers the first, `repo` the second.
    // `path` is the folder the editor opens: the user's own folder for local
    // projects, the mounted workspace for Podman ones.
    this.db.exec(PROJECTS_DDL);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS integrations (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const projectColumns = this.db.prepare('PRAGMA table_info(projects)').all();
    if (!projectColumns.some(c => c.name === 'repo')) this.db.exec('ALTER TABLE projects ADD COLUMN repo TEXT;');
    if (!projectColumns.some(c => c.name === 'default_branch')) this.db.exec('ALTER TABLE projects ADD COLUMN default_branch TEXT;');
    if (!projectColumns.some(c => c.name === 'branch_prefix')) this.db.exec('ALTER TABLE projects ADD COLUMN branch_prefix TEXT;');
    if (!projectColumns.some(c => c.name === 'work_branch')) this.db.exec('ALTER TABLE projects ADD COLUMN work_branch TEXT;');
    // How the project follows its repository: all of it ('full') or one branch ('branch', named in repo_branch),
    // and the branches that sync on their own (a JSON list; none unless the user turns one on).
    if (!projectColumns.some(c => c.name === 'repo_mode')) this.db.exec('ALTER TABLE projects ADD COLUMN repo_mode TEXT;');
    if (!projectColumns.some(c => c.name === 'repo_branch')) this.db.exec('ALTER TABLE projects ADD COLUMN repo_branch TEXT;');
    if (!projectColumns.some(c => c.name === 'auto_sync')) this.db.exec('ALTER TABLE projects ADD COLUMN auto_sync TEXT;');
    // When GitHub was last asked what this repository has; NULL = never, so nothing is known of its side.
    if (!projectColumns.some(c => c.name === 'repo_asked_at')) this.db.exec('ALTER TABLE projects ADD COLUMN repo_asked_at TEXT;');
    // What the model may do without asking, per project; NULL means the defaults from the settings.
    if (!projectColumns.some(c => c.name === 'perm_code')) this.db.exec('ALTER TABLE projects ADD COLUMN perm_code TEXT;');
    if (!projectColumns.some(c => c.name === 'perm_terminal')) this.db.exec('ALTER TABLE projects ADD COLUMN perm_terminal TEXT;');
    // Which section of the app a project belongs to: 'code' (the editor) or 'studio' (long texts).
    // The folder, the record and the chats are the same; what is in the folder is not.
    if (!projectColumns.some(c => c.name === 'section')) this.db.exec("ALTER TABLE projects ADD COLUMN section TEXT NOT NULL DEFAULT 'code';");
    // The environments on in a project (a JSON list; NULL = the one its section stands for), and the user's note on it.
    if (!projectColumns.some(c => c.name === 'envs')) this.db.exec('ALTER TABLE projects ADD COLUMN envs TEXT;');
    if (!projectColumns.some(c => c.name === 'notes')) this.db.exec('ALTER TABLE projects ADD COLUMN notes TEXT;');
    // The actions the user already approved in a project, for the semi-automatic mode.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, kind TEXT NOT NULL,
        key TEXT NOT NULL, label TEXT, created_at TEXT NOT NULL,
        UNIQUE(project_id, kind, key)
      );
    `);
    // What a project's chats made that was already brought among its artifacts (project-files.js): which file of
    // which chat, as it was then, and where its copy was put. So that a copy the user renamed or removed does not
    // come back, and one the chat made anew does.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_artifacts_taken (
        project_id TEXT NOT NULL, source TEXT NOT NULL, stamp TEXT NOT NULL, path TEXT NOT NULL, taken_at TEXT NOT NULL,
        PRIMARY KEY(project_id, source)
      );
    `);
    this.migrateGithubProjects();

    // Every table there is, before the first write: what is written from here on is noted for the other device.
    this.memoryTree();
    this.personal();
    this.replica();

    // A process restart must never leave an unfinished answer looking complete.
    if (recover) this.recoverIncomplete();
  }
  /** The answers this device was writing when it stopped. One the paired device is writing now is its own (replica.js notes who wrote a row last). */
  recoverIncomplete() {
    this.db.prepare(`UPDATE messages SET status='interrupted' WHERE status='streaming'
      AND NOT EXISTS (SELECT 1 FROM sync_log WHERE tbl='messages' AND pk=json_array(messages.id) AND origin != '')`).run();
  }
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  close() { this.db.close(); }
  conversation(id) {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
    if (!row) fail('Chat non trovata.', 404);
    return row;
  }
  /**
   * The chats of one place: the general list when no project is named, a
   * project's own when one is. The two never mix — a chat that belongs to a
   * project would be noise in the sidebar, and a general chat has no files to
   * work on.
   */
  /**
   * `world`: on a phone, 'own' for the chats born here, 'others' for those of the computers; null for all. Every row
   * says its world ('own', 'peer' for the computer paired now, 'other' for a computer of before).
   */
  listConversations(query = '', archived = false, projectId = null, world = null) {
    text(query, 200, 'Ricerca', true);
    const pattern = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
    const scope = projectId === null ? 'c.project_id IS NULL' : 'c.project_id=?';
    const scopeArgs = projectId === null ? [] : [projectId];
    const homes = this.homes();
    const where = world === 'own' ? ' AND (c.home=? OR c.home=\'\')' : world === 'others' ? ' AND c.home!=? AND c.home!=\'\'' : '';
    const whereArgs = world === 'own' || world === 'others' ? [homes.site] : [];
    const rows = this.db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.kind='final') AS message_count
      FROM conversations c WHERE ${scope} AND c.kind='chat' AND c.archived=? AND (c.title LIKE ? ESCAPE '\\' OR EXISTS
      (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.content LIKE ? ESCAPE '\\'))${where}
      ORDER BY c.updated_at DESC, c.id`).all(...scopeArgs, Number(archived), pattern, pattern, ...whereArgs);
    for (const row of rows) row.world = homes.worldOf(row.home);
    return rows;
  }
  /** This archive's site, the sites of the computers it exchanged with, and which world a home belongs to. */
  homes() {
    const replica = this.replica();
    const site = replica.site();
    const peers = new Set(replica.peerSites());
    return { site, peers, worldOf: home => (home === site || !home ? 'own' : peers.has(home) ? 'peer' : 'other') };
  }
  /** `home`: where the chat is born: here ('own', the default), or on the computer paired with this phone ('peer'). */
  createConversation(title = 'Nuova chat', projectId = null, home = null) {
    text(title, 120, 'Titolo');
    if (projectId !== null) this.project(projectId);
    const replica = this.replica();
    let site = replica.site();
    if (home === 'peer') {
      const peer = replica.peerSites()[0];
      if (!peer) fail('Nessun computer accoppiato: la chat può nascere solo qui.', 409);
      site = peer;
    } else if (home !== null && home !== undefined && home !== 'own') fail('Casa della chat non valida.');
    const id = randomUUID(), date = now();
    // The chat's level memory is a feature of ours, not the expected setup: a new chat starts
    // with it off, unless the global switch (Settings) says otherwise.
    this.db.prepare('INSERT INTO conversations(id,title,project_id,memory_enabled,created_at,updated_at,home) VALUES(?,?,?,?,?,?,?)')
      .run(id, title.trim(), projectId, this.memoryTree().defaultEnabled() ? 1 : 0, date, date, site);
    return this.conversation(id);
  }
  updateConversation(id, input) {
    const old = this.conversation(id);
    const title = input.title === undefined ? old.title : text(input.title, 120, 'Titolo').trim();
    const sandboxNetwork = input.sandboxNetwork === undefined ? (old.sandbox_network ?? 0) : flag(input.sandboxNetwork, false);
    const sandboxImage = input.sandboxImage === undefined ? (old.sandbox_image || 'alpine:latest') : text(input.sandboxImage, 100, 'Immagine', true).trim() || 'alpine:latest';
    const localVal = input.memoryEnabled !== undefined ? input.memoryEnabled : input.memory_enabled;
    const memoryEnabled = localVal === undefined ? (old.memory_enabled ?? 1) : flag(localVal, true);
    const globalVal = input.globalMemoryEnabled !== undefined ? input.globalMemoryEnabled : input.global_memory_enabled;
    const globalMemoryEnabled = globalVal === undefined ? (old.global_memory_enabled ?? 1) : flag(globalVal, true);
    const sandboxTerminal = input.sandboxTerminal === undefined ? (old.sandbox_terminal ?? 0) : flag(input.sandboxTerminal, false);
    const sandboxDesktop = input.sandboxDesktop === undefined ? (old.sandbox_desktop ?? 0) : flag(input.sandboxDesktop, false);
    this.db.prepare('UPDATE conversations SET title=?,archived=?,memory_enabled=?,global_memory_enabled=?,sandbox_network=?,sandbox_terminal=?,sandbox_desktop=?,sandbox_image=?,updated_at=? WHERE id=?')
      .run(title, flag(input.archived, old.archived), memoryEnabled, globalMemoryEnabled, sandboxNetwork, sandboxTerminal, sandboxDesktop, sandboxImage, now(), id);
    // The chat's own memory values (cap, share, recent turns); null goes back to the global ones.
    if (input.memorySettings !== undefined) this.memoryTree().setChatSettings(id, input.memorySettings);
    if (input.modelOverrides !== undefined) this.setModelOverrides(id, input.modelOverrides);
    return this.conversation(id);
  }
  /**
   * The chat's own models and parameters: { roles: {master, microtask},
   * tools: {toolId: modelId|'auto'}, params: {modelId: {key: value}} }.
   * Whatever is missing comes from the general settings; null clears them all.
   */
  setModelOverrides(id, value) {
    let json = null;
    if (value !== null) {
      if (typeof value !== 'object' || Array.isArray(value)) fail('Modelli della chat non validi.');
      const clean = {};
      for (const key of ['roles', 'tools', 'params']) {
        const part = value[key];
        if (part === undefined || part === null) continue;
        if (typeof part !== 'object' || Array.isArray(part)) fail('Modelli della chat non validi.');
        if (Object.keys(part).length) clean[key] = part;
      }
      if (Object.keys(clean).length) json = JSON.stringify(clean);
      if (json && json.length > 20000) fail('Modelli della chat troppo grandi.');
    }
    this.db.prepare('UPDATE conversations SET model_overrides_json=? WHERE id=?').run(json, id);
  }
  /**
   * The Realtime character's conversation, made on first use: one, endless,
   * with the level memory always on, so nothing it heard is lost. Beside it
   * the chat where the Master does the tasks the character hands over — an
   * ordinary chat, made again if the user deletes it.
   */
  realtime() {
    // One of each. Two archives that met may hold two (each device made its own before meeting):
    // the one with something in it stays, the oldest among those; an empty double goes.
    const one = (kind) => {
      const rows = this.db.prepare(`SELECT c.id, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) AS held
        FROM conversations c WHERE c.kind=? ORDER BY held = 0, c.created_at, c.id`).all(kind);
      for (const extra of rows.slice(1)) if (!extra.held) this.db.prepare('DELETE FROM conversations WHERE id=?').run(extra.id);
      return rows[0]?.id || null;
    };
    const own = one('realtime');
    let conversation = own ? this.conversation(own) : null;
    if (!conversation) {
      const id = randomUUID(), date = now();
      this.db.prepare("INSERT INTO conversations(id,title,memory_enabled,kind,created_at,updated_at) VALUES(?,?,1,'realtime',?,?)")
        .run(id, 'Assistente', date, date);
      conversation = this.conversation(id);
    }
    // Spoken exchanges are short and never end: a cap sized for a chat with documents would
    // hand the model tens of thousands of tokens at every sentence. Its own, unless it was set.
    if (!conversation.memory_settings_json) {
      this.memoryTree().setChatSettings(conversation.id, { cap: REALTIME_CAP });
      conversation = this.conversation(conversation.id);
    }
    // A kind of its own, so the chat list leaves it out and shows it apart.
    let tasksId = this.getSetting('realtime_tasks_conversation_id');
    const kept = one('realtime_tasks');
    if (kept && kept !== tasksId) { tasksId = kept; this.setSetting('realtime_tasks_conversation_id', tasksId); }
    if (!tasksId || !this.db.prepare("SELECT id FROM conversations WHERE id=? AND kind IN ('chat','realtime_tasks')").get(tasksId)) {
      tasksId = this.createConversation('Assistente · compiti').id;
      this.setSetting('realtime_tasks_conversation_id', tasksId);
    }
    this.db.prepare("UPDATE conversations SET kind='realtime_tasks' WHERE id=? AND kind='chat'").run(tasksId);
    // The section was called Realtime: the chats made then take its name of now, unless the user gave them one.
    this.db.prepare("UPDATE conversations SET title='Assistente' WHERE kind='realtime' AND title='Realtime'").run();
    this.db.prepare("UPDATE conversations SET title='Assistente · compiti' WHERE id=? AND title='Realtime · compiti'").run(tasksId);
    const tasks = this.db.prepare(`SELECT c.id, c.title, c.updated_at, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.kind='final') AS message_count
      FROM conversations c WHERE c.id=?`).get(tasksId);
    return { conversation, tasksConversationId: tasksId, tasks };
  }
  /** Everything the character knows, gone: its conversation, its memory, its notes. */
  realtimeForget() {
    this.db.prepare("DELETE FROM conversations WHERE kind='realtime'").run();
    return this.realtime();
  }
  deleteConversation(id) { this.conversation(id); this.forgetConversationSettings(id); this.db.prepare('DELETE FROM conversations WHERE id=?').run(id); }
  /** The settings kept under a chat's name (its plan): they go with the chat. */
  forgetConversationSettings(id) {
    this.db.prepare('DELETE FROM settings WHERE key=?').run(`plan_${id}`);
    this.pruneUiState(key => key === `synthorg_plan_on_${id}`);
  }
  /** Takes out of the kept state of the interface (ui-state.js) the values the test names. Returns how many. */
  pruneUiState(gone) {
    let state;
    try { state = JSON.parse(this.getSetting('ui_state') || 'null'); } catch { return 0; }
    if (!state || typeof state !== 'object' || Array.isArray(state)) return 0;
    const keys = Object.keys(state).filter(gone);
    if (!keys.length) return 0;
    for (const key of keys) delete state[key];
    this.setSetting('ui_state', JSON.stringify(state));
    return keys.length;
  }
  projectConversationIds(projectId) { return this.db.prepare('SELECT id FROM conversations WHERE project_id=?').all(projectId).map(row => row.id); }
  /**
   * A conversation's messages changed, from the one at `sequence` on: what
   * is kept in mind of them is good only up to there. n counts the changes,
   * from is the earliest message changed since they were last read.
   */
  touched(conversationId, sequence = 0) {
    this.changes = this.changes || new Map();
    const change = this.changes.get(conversationId) || { n: 0, from: Infinity };
    this.changes.set(conversationId, { n: change.n + 1, from: Math.min(change.from, Number(sequence) || 0) });
  }
  clearMessages(id) {
    this.conversation(id);
    this.db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id);
    this.touched(id, 0);
    this.memoryTree().forgetFrom(id, 0);
  }
  /**
   * The Code projects, as the global dossier shows them: worked out from the
   * projects themselves at every request, never written as notes, so they are
   * always current. Opened in the last `dossier_active_days` days (30 unless
   * set) they are active, the others are past. Kept in the order they were
   * created and dated by the day, so the text changes only when a project does
   * — it sits in the system prompt, and the prompt cache depends on it.
   */
  dossierProjects(today = new Date()) {
    const raw = Number(this.getSetting('dossier_active_days'));
    const activeDays = Number.isFinite(raw) && raw > 0 ? Math.min(3650, Math.round(raw)) : 30;
    const since = new Date(today.getTime() - activeDays * 86400000).toISOString().slice(0, 10);
    const rows = this.db.prepare('SELECT id, name, kind, repo, work_branch, default_branch, created_at, opened_at FROM projects ORDER BY created_at, name').all();
    const active = [], past = [];
    for (const row of rows) {
      const lastOpened = (row.opened_at || row.created_at).slice(0, 10);
      const item = { id: row.id, name: row.name, kind: row.kind === 'podman' ? 'container' : 'local', repo: row.repo || null, branch: row.repo ? (row.work_branch || row.default_branch || null) : null, lastOpened };
      (lastOpened >= since ? active : past).push(item);
    }
    return { activeDays, active, past };
  }

  /** The chat's level memory: its summaries, and the view of the conversation the model is given. */
  memoryTree() {
    if (!this._memoryTree) this._memoryTree = new MemoryTree(this);
    return this._memoryTree;
  }
  /** The agenda and the diary. */
  personal() {
    if (!this._personal) this._personal = new Personal(this);
    return this._personal;
  }
  /** The phone bridge: its settings, this computer's keys, the phones paired. */
  bridge() {
    if (!this._bridge) this._bridge = new BridgeStore(this);
    return this._bridge;
  }
  /** The same archive on the paired device: what is written here noted, what is written there taken in. */
  replica() {
    if (!this._replica) this._replica = new Replica(this, { wins: this.wins });
    return this._replica;
  }
  /** What the models cost and how they do. */
  usage() {
    if (!this._usage) this._usage = new Usage(this);
    return this._usage;
  }
  /** Cuts the history at a message: it and everything after it go, in one step, so an edit resumes from there or changes nothing. */
  truncateMessages(conversationId, fromId) {
    this.conversation(conversationId);
    const row = this.db.prepare('SELECT sequence FROM messages WHERE id=? AND conversation_id=?').get(String(fromId), conversationId);
    if (!row) fail('Messaggio non trovato in questa chat.', 404);
    const deleted = this.db.prepare('DELETE FROM messages WHERE conversation_id=? AND sequence>=?').run(conversationId, row.sequence).changes;
    this.touched(conversationId, row.sequence);
    // What summarized the removed turns goes with them.
    this.memoryTree().forgetFrom(conversationId, row.sequence);
    return deleted;
  }
  messages(id) {
    this.conversation(id);
    return this.db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY sequence').all(id).map(messageOf);
  }
  /** The messages after one, and the last there is: what a conversation without end is read by. */
  messagesAfter(id, sequence = 0, limit = 2000) {
    this.conversation(id);
    const after = Math.max(0, Number(sequence) || 0);
    const n = Math.max(1, Math.min(5000, Number(limit) || 2000));
    return this.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(id, after, n).map(messageOf);
  }
  lastSequence(id) {
    return this.db.prepare('SELECT MAX(sequence) AS last FROM messages WHERE conversation_id=?').get(id)?.last || 0;
  }
  /** The last thing asked in a conversation, alone: what a turn that starts from nothing is given. */
  lastAsked(id) {
    const row = this.db.prepare("SELECT role, content FROM messages WHERE conversation_id=? AND role='user' AND kind='final' AND status='complete' ORDER BY sequence DESC LIMIT 1").get(id);
    return row ? [{ role: row.role, content: row.content }] : [];
  }
  saveMessage(conversationId, input) {
    const conversation = this.conversation(conversationId);
    const id = input.id || randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) fail('ID messaggio non valido.');
    if (!['user','assistant','tool','system'].includes(input.role)) fail('Ruolo non valido.');
    const kind = input.kind || (['tool','system'].includes(input.role) ? 'execution' : 'final');
    const status = input.status || 'complete';
    if (!['final','execution'].includes(kind) || !['complete','streaming','error','interrupted'].includes(status)) fail('Stato messaggio non valido.');
    const content = text(input.content, 500000, 'Messaggio', true);
    const existing = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    if (existing && existing.conversation_id !== conversationId) fail('Messaggio appartenente a un’altra chat.', 409);
    if (existing && (existing.role !== input.role || existing.kind !== kind)) fail('Tipo messaggio immutabile.', 409);
    const memoryNotes = Array.isArray(input.memoryNotes) ? input.memoryNotes.slice(0, 8).map(note => ({ id: text(note.id, 100, 'ID memoria'), content: text(note.content, 2000, 'Nota memoria'), scope: note.scope === 'global' ? 'global' : 'conversation' })) : [];
    if (memoryNotes.reduce((sum, note) => sum + note.content.length, 0) > 6000) fail('Contesto memoria troppo grande.');
    const metadata = {
      demo: Boolean(input.demo),
      memoryIds: Array.isArray(input.memoryIds) ? input.memoryIds.filter(x => typeof x === 'string').slice(0, 8) : [],
      memoryNotes,
      turns: Array.isArray(input.turns) ? input.turns : undefined,
      reasoning: typeof input.reasoning === 'string' ? input.reasoning : undefined,
      // Not the user's words: something the app told the model (a task's outcome, a reminder come due).
      report: input.report ? true : undefined,
      // An answer cut short before its end: by an error, or stopped by the user. What the error said is kept apart from the text.
      cut: ['error', 'stop'].includes(input.cut) ? input.cut : undefined,
      cutDetail: input.cut === 'error' && typeof input.cutDetail === 'string' ? input.cutDetail.slice(0, 1000) : undefined,
      // The turn the app writes when the user presses «Prosegui» on such an answer.
      resume: input.resume ? true : undefined,
      // The user's side of the chat, written by the assistant on their behalf (resources/js/realtime-liaison.js).
      by: input.by === 'assistant' ? 'assistant' : undefined,
      // A turn the plan of a Code project injected (resources/js/plan.js): which point, or its check.
      plan: input.plan && typeof input.plan === 'object'
        ? { phase: ['point', 'check', 'final'].includes(input.plan.phase) ? input.plan.phase : 'point', index: Number(input.plan.index) || 0, of: Number(input.plan.of) || 0, title: String(input.plan.title || '').slice(0, 200), attempt: Number(input.plan.attempt) || undefined }
        : undefined,
      // The tools the answer called, and what each gave back: what was done, apart from what was said.
      calls: Array.isArray(input.calls) && input.calls.length
        ? input.calls.slice(0, 8).map(call => ({ name: text(call?.name, 60, 'Strumento'), args: text(call?.args ?? '{}', 4000, 'Argomenti', true), result: String(call?.result ?? '').slice(0, 2000) }))
        : undefined
    };
    const date = now();
    // Written again where it is, or added after the last: what is kept in mind of the conversation is good up to it.
    this.touched(conversationId, existing ? existing.sequence : this.lastSequence(conversationId) + 1);
    this.transaction(() => {
      const modelId = input.modelId == null ? null : text(input.modelId, 200, 'Modello', true);
      const modelName = input.modelName == null ? null : text(input.modelName, 200, 'Nome modello', true);
      if (existing) {
        this.db.prepare('UPDATE messages SET status=?,content=?,model_id=?,model_name=?,meta_json=?,updated_at=? WHERE id=?')
          .run(status, content, modelId, modelName, JSON.stringify(metadata), date, id);
      } else {
        // Numbered by the device that writes it, so that the paired one keeps the same number (replica.js).
        this.db.prepare(`INSERT INTO messages(sequence,id,conversation_id,role,kind,status,content,model_id,model_name,meta_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(this.replica().sequence(), id, conversationId, input.role, kind, status, content, modelId, modelName,
            JSON.stringify(metadata), input.timestamp && !isNaN(Date.parse(input.timestamp)) && new Date(input.timestamp).toISOString() || date, date);
      }
      const title = conversation.title === 'Nuova chat' && input.role === 'user' ? content.trim().replace(/\s+/g, ' ').slice(0, 70) || 'Nuova chat' : conversation.title;
      this.db.prepare('UPDATE conversations SET title=?,updated_at=? WHERE id=?').run(title, date, conversationId);
    });
    return { ...input, id, conversationId, kind, status };
  }
  importLegacy(messages) {
    if (!Array.isArray(messages) || messages.length > 5000) fail('Cronologia precedente non valida.');
    if (!messages.length) return { imported: false };
    const fingerprint = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
    const old = this.db.prepare('SELECT * FROM imports WHERE fingerprint=?').get(fingerprint);
    if (old) return { imported: false, conversationId: old.conversation_id };
    // Validate everything before beginning; original browser history stays untouched.
    for (const message of messages) {
      if (!message || !['user','assistant','tool','system'].includes(message.role)) fail('Ruolo non valido nella cronologia.');
      text(message.content, 500000, 'Messaggio importato', true);
    }
    return this.transaction(() => {
        const conversation = this.createConversation('Chat importata');
        for (const message of messages) this.saveMessage(conversation.id, { ...message, id: randomUUID(), status: message.isStreaming ? 'interrupted' : 'complete' });
        this.db.prepare('INSERT INTO imports VALUES(?,?)').run(fingerprint, conversation.id);
        return { imported: true, conversationId: conversation.id };
    });
  }
  listMemories(conversationId, query = '', scope = null) {
    if (conversationId) this.conversation(conversationId);
    text(query, 200, 'Ricerca memoria', true);
    const pattern = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
    if (scope === 'global') {
      return this.db.prepare(`SELECT * FROM memories WHERE scope='global' AND content LIKE ? ESCAPE '\\'
        ORDER BY pinned DESC, updated_at DESC`).all(pattern);
    }
    if (scope === 'conversation') {
      return this.db.prepare(`SELECT * FROM memories WHERE scope='conversation' AND conversation_id=? AND content LIKE ? ESCAPE '\\'
        ORDER BY pinned DESC, updated_at DESC`).all(conversationId || null, pattern);
    }
    return this.db.prepare(`SELECT * FROM memories WHERE (scope='global' OR conversation_id=?) AND content LIKE ? ESCAPE '\\'
      ORDER BY pinned DESC, updated_at DESC`).all(conversationId || null, pattern);
  }
  saveMemory(input, id = randomUUID()) {
    const content = text(input.content, 2000, 'Memoria').trim();
    if (!['global','conversation'].includes(input.scope)) fail('Ambito memoria non valido.');
    const conversationId = input.scope === 'conversation' ? input.conversationId : null;
    if (conversationId) this.conversation(conversationId);
    if (input.scope === 'conversation' && !conversationId) fail('Seleziona una chat.');
    const source = input.sourceMessageId || null;
    if (source) {
      const message = this.db.prepare('SELECT * FROM messages WHERE id=?').get(source);
      if (!message || (conversationId && message.conversation_id !== conversationId)) fail('Messaggio di origine non valido.');
    }
    const section = input.section ? text(input.section, 50, 'Sezione', true).trim() : 'general_notes';
    // Not given on a change: the note keeps the origin it has.
    const origin = input.origin === undefined
      ? (this.db.prepare('SELECT origin FROM memories WHERE id=?').get(id)?.origin ?? null)
      : (input.origin === null ? null : text(input.origin, 50, 'Origine', true).trim() || null);
    const date = now();
    this.db.prepare(`INSERT INTO memories(id,content,scope,conversation_id,source_message_id,section,origin,enabled,pinned,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,scope=excluded.scope,
      conversation_id=excluded.conversation_id,source_message_id=excluded.source_message_id,section=excluded.section,origin=excluded.origin,enabled=excluded.enabled,pinned=excluded.pinned,updated_at=excluded.updated_at`)
      .run(id, content, input.scope, conversationId, source, section, origin, flag(input.enabled, true), flag(input.pinned), date, date);
    return this.db.prepare('SELECT * FROM memories WHERE id=?').get(id);
  }
  deleteMemory(id) {
    if (!this.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes) fail('Memoria non trovata.', 404);
  }
  project(id) {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!row) fail('Progetto non trovato.', 404);
    return row;
  }
  /** The projects of one section ('code' unless said otherwise), or 'all' of them. */
  listProjects(section = 'code') {
    if (section === 'all') return this.db.prepare('SELECT * FROM projects ORDER BY COALESCE(opened_at, created_at) DESC, name').all();
    if (!PROJECT_SECTIONS.includes(section)) fail('Sezione non valida.');
    return this.db.prepare('SELECT * FROM projects WHERE section=? ORDER BY COALESCE(opened_at, created_at) DESC, name').all(section);
  }
  createProject({ id = randomUUID(), name, kind, path, containerName = null, image = null, network = false, repo = null, defaultBranch = null, branchPrefix = null, workBranch = null, repoMode = null, repoBranch = null, section = 'code', envs = null, notes = null }) {
    if (!PROJECT_SECTIONS.includes(section)) fail('Sezione non valida.');
    if (envs !== null && (!Array.isArray(envs) || !envs.length || envs.some(env => !PROJECT_ENVS.includes(env)))) fail('Ambienti non validi.');
    const date = now();
    this.db.prepare('INSERT INTO projects(id,name,kind,path,container_name,image,network,repo,default_branch,branch_prefix,work_branch,repo_mode,repo_branch,section,envs,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, text(name, 80, 'Nome progetto').trim(), kind, text(path, 1024, 'Percorso progetto'), containerName, image, Number(Boolean(network)), repo, defaultBranch, branchPrefix, workBranch, repo ? repoMode : null, repo ? repoBranch : null, section, envs ? JSON.stringify(envs) : null, typeof notes === 'string' && notes.trim() ? text(notes, 500, 'Note').trim() : null, date, date);
    return this.project(id);
  }
  /** The user's note on a project; empty takes it away. */
  setProjectNotes(id, notes) {
    this.project(id);
    const value = typeof notes === 'string' && notes.trim() ? text(notes, 500, 'Note').trim() : null;
    this.db.prepare('UPDATE projects SET notes=?,updated_at=? WHERE id=?').run(value, now(), id);
    return this.project(id);
  }
  /**
   * GitHub used to be a third kind of project, which forced a container and a
   * repository together. Those projects keep their container and their
   * repository; what they lose is the kind, and they keep the branch namespace
   * their existing branches are already under.
   */
  migrateGithubProjects() {
    const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'").get();
    if (!schema || !schema.sql.includes("'github'")) return;
    this.db.exec(`
      UPDATE projects SET kind='podman', network=1, branch_prefix=COALESCE(branch_prefix,'synthorg') WHERE kind='github';
      ALTER TABLE projects RENAME TO projects_legacy;
    `);
    this.db.exec(PROJECTS_DDL);
    this.db.exec(`
      INSERT INTO projects(id,name,kind,path,container_name,image,network,created_at,updated_at,opened_at,repo,default_branch,branch_prefix,work_branch)
        SELECT id,name,kind,path,container_name,image,network,created_at,updated_at,opened_at,repo,default_branch,branch_prefix,work_branch FROM projects_legacy;
      DROP TABLE projects_legacy;
    `);
  }
  /** Linking or unlinking the repository of a project already in the list. */
  setProjectRepo(id, { repo = null, defaultBranch = null, mode = null, branch = null }) {
    const before = this.project(id);
    // Another repository, or none: the switches of the old one's branches mean nothing any more.
    const same = Boolean(repo) && repo === before.repo;
    this.db.prepare('UPDATE projects SET repo=?,default_branch=COALESCE(?,default_branch),repo_mode=?,repo_branch=?,auto_sync=?,repo_asked_at=?,updated_at=? WHERE id=?')
      .run(repo, defaultBranch, repo ? mode : null, repo ? branch : null, same ? before.auto_sync : null, same ? before.repo_asked_at : null, now(), id);
    return this.project(id);
  }
  /** GitHub was just asked what the project's repository has. */
  noteProjectRepoAsked(id) {
    this.db.prepare('UPDATE projects SET repo_asked_at=? WHERE id=?').run(now(), id);
  }
  /** The one branch a single-branch project follows, when it moves to another. */
  setProjectRepoBranch(id, branch) {
    this.project(id);
    this.db.prepare('UPDATE projects SET repo_branch=?,updated_at=? WHERE id=?').run(branch, now(), id);
    return this.project(id);
  }
  /** The branches that download and upload on their own. */
  setProjectAutoSync(id, branches) {
    this.project(id);
    const list = [...new Set(branches)].sort();
    this.db.prepare('UPDATE projects SET auto_sync=?,updated_at=? WHERE id=?').run(list.length ? JSON.stringify(list) : null, now(), id);
    return this.project(id);
  }
  /** The branch namespace this project's work goes up to, fixed at creation. */
  setProjectBranchPrefix(id, prefix) {
    this.project(id);
    this.db.prepare('UPDATE projects SET branch_prefix=?,updated_at=? WHERE id=?').run(prefix, now(), id);
    return this.project(id);
  }
  /** The branch the project is on, as last seen: what the lists outside the editor show. */
  setProjectWorkBranch(id, branch) {
    this.project(id);
    this.db.prepare('UPDATE projects SET work_branch=?,updated_at=? WHERE id=?').run(branch, now(), id);
    return this.project(id);
  }
  /** Credentials and registrations for external services; never exposed through the settings API. */
  getIntegration(key) {
    const row = this.db.prepare('SELECT value FROM integrations WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  }
  setIntegration(key, value) {
    if (value === null || value === undefined) {
      this.db.prepare('DELETE FROM integrations WHERE key=?').run(key);
      return;
    }
    this.db.prepare(`INSERT INTO integrations(key, value, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, JSON.stringify(value), now());
  }
  renameProject(id, name) {
    this.project(id);
    this.db.prepare('UPDATE projects SET name=?,updated_at=? WHERE id=?').run(text(name, 80, 'Nome progetto').trim(), now(), id);
    return this.project(id);
  }
  /** The two permission modes of a project; null puts one back to the default from the settings. */
  setProjectPermissions(id, { code, terminal }) {
    this.project(id);
    const ok = v => v === null || v === undefined || ['manual', 'semi', 'auto'].includes(v);
    if (!ok(code) || !ok(terminal)) fail('Modalità non valida: manual, semi o auto.');
    if (code !== undefined) this.db.prepare('UPDATE projects SET perm_code=?,updated_at=? WHERE id=?').run(code, now(), id);
    if (terminal !== undefined) this.db.prepare('UPDATE projects SET perm_terminal=?,updated_at=? WHERE id=?').run(terminal, now(), id);
    return this.project(id);
  }
  listApprovals(projectId) {
    return this.db.prepare('SELECT id, kind, key, label, created_at FROM project_approvals WHERE project_id=? ORDER BY created_at DESC, id DESC').all(projectId);
  }
  hasApproval(projectId, kind, key) {
    return Boolean(this.db.prepare('SELECT 1 FROM project_approvals WHERE project_id=? AND kind=? AND key=?').get(projectId, kind, key));
  }
  addApproval(projectId, kind, key, label = null) {
    this.db.prepare('INSERT OR IGNORE INTO project_approvals(project_id, kind, key, label, created_at) VALUES(?,?,?,?,?)').run(projectId, kind, text(key, 4096, 'Chiave approvazione'), label ? String(label).slice(0, 300) : null, now());
  }
  removeApproval(projectId, rowId) {
    if (!this.db.prepare('DELETE FROM project_approvals WHERE project_id=? AND id=?').run(projectId, Number(rowId)).changes) fail('Approvazione non trovata.', 404);
  }
  clearApprovals(projectId) {
    return this.db.prepare('DELETE FROM project_approvals WHERE project_id=?').run(projectId).changes;
  }
  touchProject(id) {
    this.db.prepare('UPDATE projects SET opened_at=? WHERE id=?').run(now(), id);
    return this.project(id);
  }
  deleteProject(id) {
    this.project(id);
    // The project's own chats go with it: they have no meaning without the
    // files they were about.
    for (const chat of this.projectConversationIds(id)) this.forgetConversationSettings(chat);
    this.db.prepare('DELETE FROM conversations WHERE project_id=?').run(id);
    this.db.prepare("DELETE FROM settings WHERE key IN (?, ?)").run(`plan_mode_${id}`, `plan_tries_${id}`);
    this.db.prepare('DELETE FROM project_approvals WHERE project_id=?').run(id);
    this.db.prepare('DELETE FROM project_artifacts_taken WHERE project_id=?').run(id);
    this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
  }
  /** What was already taken from the project's chats: source ("chat/path") → the state of the file when it was taken. */
  artifactsTaken(projectId) {
    return new Map(this.db.prepare('SELECT source, stamp FROM project_artifacts_taken WHERE project_id=?').all(projectId).map(row => [row.source, row.stamp]));
  }
  markArtifactTaken(projectId, source, stamp, path) {
    this.db.prepare('INSERT INTO project_artifacts_taken(project_id, source, stamp, path, taken_at) VALUES(?,?,?,?,?) ON CONFLICT(project_id, source) DO UPDATE SET stamp=excluded.stamp, path=excluded.path, taken_at=excluded.taken_at')
      .run(projectId, String(source), String(stamp), String(path), new Date().toISOString());
  }
  getSetting(key) {
    text(key, 100, 'Chiave impostazione');
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? row.value : null;
  }
  getSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const result = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }
  setSetting(key, value) {
    text(key, 100, 'Chiave impostazione');
    if (value === null || value === undefined || value === '') {
      this.db.prepare('DELETE FROM settings WHERE key=?').run(key);
      return null;
    }
    const str = String(value);
    const date = now();
    this.db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, str, date);
    return str;
  }
  deleteSetting(key) {
    text(key, 100, 'Chiave impostazione');
    this.db.prepare('DELETE FROM settings WHERE key=?').run(key);
    return true;
  }
  context(conversationId, query, options = {}) {
    const conversation = this.conversation(conversationId);
    text(query, 500000, 'Richiesta', true);
    // A summary that holds a model's own thinking is never read as part of the conversation (memory-tree.js).
    try { this.memoryTree().repairLeaked(conversationId); } catch {}
    // A turn that starts from nothing (a task handed to the Master): the request alone, whatever
    // the conversation holds. What it holds is not read, and costs nothing however long it is.
    if (options.fresh) return { messages: this.lastAsked(conversationId), memoryView: { active: false }, compaction: null, ...this.contextNotes(conversation, query, options) };
    // With the level memory on and a view made, what came before the view's cut is in its
    // summaries: only what came after is read. A long conversation costs what its last turns do.
    const cut = conversation.memory_enabled ? (this.memoryTree().validView(conversationId)?.untilSeq || 0) : 0;
    const history = (cut ? this.messagesAfter(conversationId, cut, 5000) : this.messages(conversationId))
      .filter(m => m.kind === 'final' && m.status === 'complete' && !m.demo && ['user','assistant'].includes(m.role));
    // With the chat's memory on, the conversation comes as its level view: whole
    // below the cap, the older part as a small tree of summaries past it.
    let messages = history.map(given);
    let memoryView = { active: false };
    let compaction = null;
    if (conversation.memory_enabled) {
      const view = this.memoryTree().view(conversationId, history);
      messages = view.messages;
      memoryView = view.memoryView;
    } else {
      // without it, the classic compaction: the summary made when the model's window was about to fill
      const view = this.memoryTree().classicView(conversationId, history);
      messages = view.messages;
      compaction = view.compaction;
    }

    return { messages, memoryView, compaction, ...this.contextNotes(conversation, query, options) };
  }

  /** The notes that go with a request: the ones of the dossier and of the chat that fit it. */
  contextNotes(conversation, query, options = {}) {
    const conversationId = conversation.id;
    // Global memory toggle:
    // When options.includeGlobal is specified by caller, respect it; fallback to conversation.memory_enabled for test compatibility.
    // Also respect conversation.global_memory_enabled for this specific chat.
    const masterGlobalActive = options.includeGlobal !== undefined ? Boolean(options.includeGlobal) : Boolean(conversation.memory_enabled);
    // Above both, the dossier's one global switch (Memorie condivise).
    const dossierOn = this.getSetting('global_memory_enabled') !== 'false';
    const includeGlobal = dossierOn && masterGlobalActive && Boolean(conversation.global_memory_enabled ?? 1);

    // Chat memory toggle:
    const callerChatActive = options.includeChat !== undefined ? Boolean(options.includeChat) : true;
    const includeChat = callerChatActive && Boolean(conversation.memory_enabled);

    let candidates = [];
    if (includeGlobal || includeChat) {
      const scopeConditions = [];
      const params = [];
      if (includeGlobal) {
        scopeConditions.push("scope='global'");
      }
      if (includeChat) {
        scopeConditions.push("(scope='conversation' AND conversation_id=?)");
        params.push(conversationId);
      }
      const scopeClause = scopeConditions.join(' OR ');

      candidates = this.db.prepare(`SELECT * FROM memories WHERE enabled=1 AND pinned=1 AND (${scopeClause}) AND COALESCE(section,'') != 'turn_summary' ORDER BY updated_at DESC LIMIT 8`).all(...params);
      const terms = searchTerms(query);
      if (terms) {
        candidates.push(...this.db.prepare(`SELECT m.* FROM memories_fts JOIN memories m ON m.rowid=memories_fts.rowid
          WHERE memories_fts MATCH ? AND m.enabled=1 AND m.pinned=0 AND (${scopeClause}) AND COALESCE(m.section,'') != 'turn_summary'
          ORDER BY bm25(memories_fts), m.updated_at DESC LIMIT 8`).all(terms, ...params));
      }
    }

    let budget = 6000;
    const memories = [];
    for (const item of candidates) {
      if (memories.length === 8) break;
      if (item.content.length > budget) continue;
      budget -= item.content.length;
      memories.push({
        id: item.id,
        content: item.content,
        scope: item.scope,
        section: item.section || 'general_notes',
        sourceMessageId: item.source_message_id || null
      });
    }

    let globalItems = [];
    if (includeGlobal) {
      globalItems = this.db.prepare(`SELECT * FROM memories WHERE scope='global' AND enabled=1 ORDER BY updated_at ASC`).all().map(item => ({
        id: item.id,
        content: item.content,
        scope: item.scope,
        section: item.section || 'general_notes',
        sourceMessageId: item.source_message_id || null
      }));
    }

    let chatItems = [];
    if (includeChat) {
      chatItems = this.db.prepare(`SELECT * FROM memories WHERE scope='conversation' AND conversation_id=? AND enabled=1 AND COALESCE(section,'') != 'turn_summary' ORDER BY updated_at ASC`).all(conversationId).map(item => ({
        id: item.id,
        content: item.content,
        scope: item.scope,
        section: item.section || 'turn_summary',
        sourceMessageId: item.source_message_id || null
      }));
    }

    // the dossier's Code projects go with the rest of the dossier
    const dossierProjects = includeGlobal ? this.dossierProjects() : null;
    return { memories, globalItems, chatItems, dossierProjects };
  }
}
module.exports = {
  PROJECT_SECTIONS, PROJECT_ENVS, ENV_SECTION, projectEnvs, SWITCHABLE_SECTIONS, sectionEnabled, Store, fail };
