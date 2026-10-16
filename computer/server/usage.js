'use strict';
/**
 * What the models cost, and how they do.
 *
 * Every request the app makes to a model is written down as it ends: where
 * it was made (a chat, a project, the Realtime section), what for (the role:
 * the Master's turn, a delegated tool, the voice…), the model, the tokens,
 * the cost the provider gave, how long it took and how long before its first
 * word. From these rows come the total of a project, the overviews of the
 * Realtime section and, when the user agrees to it, the numbers shared.
 *
 * How a request went is told by what happened next, not by a model reading
 * it: the user stopped the answer, wrote again to correct it, or took the
 * project back to before the step the model made. These marks are set on the
 * turn when that happens.
 *
 * Bounds. The rows of the last ninety days are kept one by one; older ones
 * are folded into a row a day for each project, role and model, so that the
 * totals stay exact and the table stays small.
 *
 * Sharing. Nothing leaves this computer by itself. When enough spending has
 * been recorded the user is asked, each time, whether to share the numbers
 * of that stretch; what would be sent is worked out here and shown before it
 * goes: sums and medians by model and role, the weeks they are about, the
 * languages and the size of the project — never a text, a name, a file, an
 * identifier or a moment. A stretch the user said no to is not asked about
 * again, and nothing is lost by saying no.
 */
const { randomUUID } = require('node:crypto');
const { SHARE_ON, SHARE_ENDPOINT } = require('./share-endpoint');

const KEEP_DAYS = 90;                // rows kept one by one
const SHARE_EVERY = 5;                // dollars of spending recorded between a question and the next
const SHARE_LATER_MS = 24 * 3600000;  // a question closed without an answer comes back after this
const PENDING_HOURS = 48;             // a cost the provider has not given by then is not asked for any more
const ENOUGH = 20;                    // requests of a model in a role before its rates say something
const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ROLE = /^[a-z][a-z0-9_]{0,30}(:[a-z0-9_]{1,40})?$/;
const REMOTE_MODEL = /^[a-z0-9][a-z0-9._-]{0,60}\/[a-z0-9][a-z0-9._:-]{0,100}$/;
// The roles the app itself gives a request, and the tools it delegates: what may be named in what is shared.
const KNOWN_ROLES = ['master', 'microtask', 'compaction', 'realtime', 'speech', 'transcription', 'image', 'video', 'music', 'computer_use', 'tour', 'other'];
const KNOWN_TOOLS = ['text_to_image', 'image_to_image', 'text_to_video', 'image_to_video', 'image_inspection', 'video_inspection',
  'audio_transcription', 'voice_synthesis', 'music_generation', 'pdf_parser', 'thinking_solver', 'web_search', 'web_browse', 'model_search'];
const KNOWN_JOBS = ['page', 'analysis', 'study', 'tidy', 'data', 'review', 'advice'];
// File endings and the language they stand for: what a project is made of, by its most common ones.
const LANGUAGES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp', rb: 'ruby', php: 'php', lua: 'lua', sh: 'shell', ps1: 'shell', sql: 'sql', r: 'r', dart: 'dart', scala: 'scala',
  html: 'html', css: 'css', scss: 'css', vue: 'vue', svelte: 'svelte', md: 'markdown', json: 'data', yaml: 'data', yml: 'data', toml: 'data', xml: 'data', csv: 'data', ipynb: 'notebook'
};

const now = () => new Date().toISOString();
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
const count = (v) => Math.max(0, Math.round(Number(v) || 0));
const money = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v));
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

/** The value below which a share of the numbers fall (0.5: the median); null when there are none. */
function quantile(values, share) {
  const sorted = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * share;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

/** The week of a day, as "2026-W40" (ISO: weeks start on Monday, the first has the year's first Thursday). */
function weekOf(dayText) {
  const [y, m, d] = dayText.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday + 3);
  const first = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - first) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** What a project is made of, from the names of its files: its most common languages and a size, nothing else. */
function profileOf(files) {
  const names = (files || []).filter(name => typeof name === 'string' && name && !/(^|\/)(node_modules|vendor|dist|build|target|\.git)\//.test(name));
  const counts = new Map();
  names.forEach(name => {
    const ending = /\.([A-Za-z0-9]{1,10})$/.exec(name.split('/').pop());
    const language = ending ? LANGUAGES[ending[1].toLowerCase()] : null;
    if (language) counts.set(language, (counts.get(language) || 0) + 1);
  });
  const known = [...counts.values()].reduce((a, b) => a + b, 0);
  const languages = [...counts].filter(([, n]) => n / known >= 0.1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([language]) => language);
  const size = names.length < 50 ? 'S' : names.length < 500 ? 'M' : names.length < 5000 ? 'L' : 'XL';
  return { languages, size };
}

/** A role as it may be named outside this computer: the app's own names, or "other". */
function publicRole(role) {
  const [kind, name] = String(role || '').split(':');
  if (!name) return KNOWN_ROLES.includes(kind) ? kind : 'other';
  if (kind === 'tool') return KNOWN_TOOLS.includes(name) ? role : 'tool:other';
  if (kind === 'job') return KNOWN_JOBS.includes(name) ? role : 'job:other';
  return 'other';
}

/** A model as it may be named outside this computer: the provider's public name; a model on this computer is "local". */
function publicModel(model, local) {
  if (local || String(model || '').startsWith('local/')) return 'local';
  const id = String(model || '').toLowerCase();
  return REMOTE_MODEL.test(id) ? id : 'other';
}

/** The numbers of a group of requests. rows: { ok, stopped, corrected, reverted, turn, cost, ms, first_ms, … }. */
function measure(rows) {
  const sum = (key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  const turns = new Map();
  rows.forEach(row => {
    if (!row.turn) return;
    const turn = turns.get(row.turn) || { cost: 0, stopped: 0, corrected: 0, reverted: 0 };
    turn.cost += Number(row.cost) || 0;
    turn.stopped = turn.stopped || row.stopped;
    turn.corrected = turn.corrected || row.corrected;
    turn.reverted = turn.reverted || row.reverted;
    turns.set(row.turn, turn);
  });
  const all = [...turns.values()];
  const cost = sum('cost');
  const prompt = sum('prompt_tokens');
  // Words a second, once the first has come: the time of writing, not of waiting.
  const speed = rows.filter(row => row.ok && row.completion_tokens > 0 && row.first_ms !== null && row.ms - row.first_ms >= 200)
    .map(row => row.completion_tokens / ((row.ms - row.first_ms) / 1000));
  return {
    runs: rows.length,
    ok: sum('ok'),
    errors: rows.length - sum('ok'),
    stopped: all.length ? all.filter(t => t.stopped).length : sum('stopped'),
    turns: all.length,
    corrected: all.filter(t => t.corrected).length,
    reverted: all.filter(t => t.reverted).length,
    unpriced: rows.filter(row => row.cost === null && !row.local).length,
    prompt_tokens: prompt,
    completion_tokens: sum('completion_tokens'),
    cached_tokens: sum('cached_tokens'),
    reasoning_tokens: sum('reasoning_tokens'),
    cost: round(cost, 6),
    cost_per_run: rows.length ? round(cost / rows.length, 6) : null,
    cost_per_turn: all.length ? round(all.reduce((a, t) => a + t.cost, 0) / all.length, 6) : null,
    cached_share: prompt ? round(sum('cached_tokens') / prompt, 3) : null,
    ms_p50: quantile(rows.filter(r => r.ok).map(r => r.ms), 0.5),
    ms_p90: quantile(rows.filter(r => r.ok).map(r => r.ms), 0.9),
    first_ms_p50: quantile(rows.filter(r => r.ok && r.first_ms !== null).map(r => r.first_ms), 0.5),
    first_ms_p90: quantile(rows.filter(r => r.ok && r.first_ms !== null).map(r => r.first_ms), 0.9),
    tokens_per_second_p50: speed.length ? round(quantile(speed, 0.5), 1) : null,
    enough: rows.length >= ENOUGH
  };
}

class Usage {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        day TEXT NOT NULL,
        conversation_id TEXT,
        project_id TEXT,
        place TEXT NOT NULL DEFAULT 'other',
        role TEXT NOT NULL,
        turn TEXT,
        model TEXT NOT NULL,
        provider TEXT,
        local INTEGER NOT NULL DEFAULT 0,
        queued INTEGER NOT NULL DEFAULT 0,
        ok INTEGER NOT NULL DEFAULT 1,
        stopped INTEGER NOT NULL DEFAULT 0,
        corrected INTEGER NOT NULL DEFAULT 0,
        reverted INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL,
        ms INTEGER NOT NULL DEFAULT 0,
        first_ms INTEGER,
        generation TEXT
      );
      CREATE INDEX IF NOT EXISTS model_usage_day ON model_usage(day);
      CREATE INDEX IF NOT EXISTS model_usage_project ON model_usage(project_id);
      CREATE INDEX IF NOT EXISTS model_usage_talk ON model_usage(conversation_id, id);
      CREATE TABLE IF NOT EXISTS model_usage_days (
        day TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '',
        place TEXT NOT NULL,
        role TEXT NOT NULL,
        model TEXT NOT NULL,
        runs INTEGER NOT NULL DEFAULT 0,
        ok INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(day, project_id, place, role, model)
      );
      CREATE TABLE IF NOT EXISTS usage_shares (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        answer TEXT NOT NULL CHECK(answer IN ('shared','declined')),
        from_id INTEGER NOT NULL,
        until_id INTEGER NOT NULL,
        runs INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        package_json TEXT
      );
    `);
    // Where a cost came from: 'provider' when the provider gave it, 'priced' when it was worked out here from the
    // catalogue's prices (a model asked of its maker directly: none of them says a cost in money).
    if (!this.db.prepare('PRAGMA table_info(model_usage)').all().some(column => column.name === 'cost_source')) {
      this.db.exec('ALTER TABLE model_usage ADD COLUMN cost_source TEXT');
    }
  }

  /* ------------------------------ writing --------------------------- */

  /** Where a request was made, from the chat it was made in. */
  placeOf(conversationId) {
    if (!conversationId) return { conversationId: null, projectId: null, place: 'other' };
    const row = this.db.prepare('SELECT id, kind, project_id FROM conversations WHERE id=?').get(String(conversationId));
    if (!row) return { conversationId: null, projectId: null, place: 'other' };
    const place = row.project_id ? 'project' : row.kind === 'realtime' ? 'realtime' : row.kind === 'realtime_tasks' ? 'tasks' : 'chat';
    return { conversationId: row.id, projectId: row.project_id || null, place };
  }

  /** A request that ended, with what is known of it. A cost not known yet is asked of the provider later, by its generation. */
  record(input) {
    const role = String(input.role || 'other').toLowerCase();
    if (!ROLE.test(role)) fail('Ruolo non valido.');
    const model = String(input.model || '').trim().slice(0, 200);
    if (!model) fail('Modello non valido.');
    const where = this.placeOf(input.conversationId);
    const place = where.place === 'other' && ['realtime', 'tour'].includes(String(input.place)) ? String(input.place) : where.place;
    const local = input.local ? 1 : 0;
    const at = new Date();
    const cost = local ? 0 : money(input.cost);
    const generation = cost === null && typeof input.generation === 'string' && /^[A-Za-z0-9_-]{6,120}$/.test(input.generation) ? input.generation : null;
    const first = input.firstMs === null || input.firstMs === undefined ? null : count(input.firstMs);
    const costSource = cost === null ? null : input.costSource === 'priced' ? 'priced' : 'provider';
    const done = this.db.prepare(`INSERT INTO model_usage(at,day,conversation_id,project_id,place,role,turn,model,provider,local,queued,ok,stopped,
        prompt_tokens,completion_tokens,cached_tokens,reasoning_tokens,cost,ms,first_ms,generation,cost_source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(at.toISOString(), localDay(at), where.conversationId, where.projectId, place, role,
        input.turn ? String(input.turn).slice(0, 80) : null, model, input.provider ? String(input.provider).slice(0, 80) : null,
        local, input.queued ? 1 : 0, input.ok === false ? 0 : 1, input.stopped ? 1 : 0,
        count(input.promptTokens), count(input.completionTokens), count(input.cachedTokens), count(input.reasoningTokens),
        cost, count(input.ms), first, generation, costSource);
    this.recorded = (this.recorded || 0) + 1;
    // Now and then, what is old is folded.
    if (this.recorded % 500 === 1) this.fold();
    return { id: Number(done.lastInsertRowid), waiting: Boolean(generation) };
  }

  /** The requests whose cost the provider had not given when they ended: asked for again, for two days. */
  pending() {
    const since = new Date(Date.now() - PENDING_HOURS * 3600000).toISOString();
    this.db.prepare('UPDATE model_usage SET generation=NULL WHERE generation IS NOT NULL AND at < ?').run(since);
    return this.db.prepare('SELECT id, generation, at FROM model_usage WHERE generation IS NOT NULL ORDER BY id LIMIT 50').all();
  }

  /** The cost of a request, as the provider gave it afterwards. */
  resolve(id, input) {
    const row = this.db.prepare('SELECT id, generation, prompt_tokens, completion_tokens FROM model_usage WHERE id=?').get(Number(id));
    if (!row) fail('Richiesta non trovata.', 404);
    if (!row.generation) return { id: row.id, resolved: false };
    const cost = money(input.cost);
    if (cost === null) fail('Costo non valido.');
    this.db.prepare(`UPDATE model_usage SET cost=?, cost_source='provider', generation=NULL, provider=COALESCE(?, provider),
        prompt_tokens=CASE WHEN prompt_tokens=0 THEN ? ELSE prompt_tokens END,
        completion_tokens=CASE WHEN completion_tokens=0 THEN ? ELSE completion_tokens END WHERE id=?`)
      .run(cost, input.provider ? String(input.provider).slice(0, 80) : null, count(input.promptTokens), count(input.completionTokens), row.id);
    return { id: row.id, resolved: true };
  }

  /**
   * The user wrote again to correct the answer: the last turn of the Master
   * in that chat is marked, when it is of the last hour.
   */
  markCorrected(conversationId) {
    const last = this.db.prepare("SELECT turn, at FROM model_usage WHERE conversation_id=? AND role='master' AND turn IS NOT NULL ORDER BY id DESC LIMIT 1").get(String(conversationId || ''));
    if (!last || Date.now() - Date.parse(last.at) > 3600000) return { marked: 0 };
    return { marked: this.db.prepare('UPDATE model_usage SET corrected=1 WHERE conversation_id=? AND turn=?').run(String(conversationId), last.turn).changes };
  }

  /**
   * The project was taken back to before steps a model made: the turns those
   * steps came from are marked. moments: when each of those steps was made.
   * The turn of a step is the one whose request ended last before it, within
   * ten minutes.
   */
  markReverted(projectId, moments) {
    let marked = 0;
    const find = this.db.prepare("SELECT conversation_id, turn FROM model_usage WHERE project_id=? AND role='master' AND turn IS NOT NULL AND at <= ? AND at >= ? ORDER BY id DESC LIMIT 1");
    const mark = this.db.prepare('UPDATE model_usage SET reverted=1 WHERE conversation_id=? AND turn=? AND reverted=0');
    [...new Set((moments || []).map(m => Date.parse(m)).filter(Number.isFinite))].forEach(moment => {
      const row = find.get(String(projectId), new Date(moment + 2000).toISOString(), new Date(moment - 600000).toISOString());
      if (row) marked += mark.run(row.conversation_id, row.turn).changes;
    });
    return { marked };
  }

  /** The record emptied by the user: every row goes. What was shared before was shared, and its list stays. */
  clear() {
    return this.store.transaction(() => {
      const rows = this.db.prepare('DELETE FROM model_usage').run().changes;
      this.db.prepare('DELETE FROM model_usage_days').run();
      this.store.setSetting('usage_share_later', '');
      return { cleared: rows };
    });
  }

  /** Rows older than what is kept one by one become a row a day for each project, role and model. */
  fold() {
    const before = localDay(new Date(Date.now() - KEEP_DAYS * 86400000));
    return this.store.transaction(() => {
      this.db.prepare(`INSERT INTO model_usage_days(day,project_id,place,role,model,runs,ok,prompt_tokens,completion_tokens,cached_tokens,cost)
          SELECT day, COALESCE(project_id, ''), place, role, model, COUNT(*), SUM(ok), SUM(prompt_tokens), SUM(completion_tokens), SUM(cached_tokens), COALESCE(SUM(cost), 0)
          FROM model_usage WHERE day < ? GROUP BY day, COALESCE(project_id, ''), place, role, model
        ON CONFLICT(day,project_id,place,role,model) DO UPDATE SET runs=runs+excluded.runs, ok=ok+excluded.ok, prompt_tokens=prompt_tokens+excluded.prompt_tokens,
          completion_tokens=completion_tokens+excluded.completion_tokens, cached_tokens=cached_tokens+excluded.cached_tokens, cost=cost+excluded.cost`).run(before);
      return { folded: this.db.prepare('DELETE FROM model_usage WHERE day < ?').run(before).changes };
    });
  }

  /* ------------------------------ reading --------------------------- */

  /** What each project cost since it is there, all told: { project_id: { cost, runs, last_day } }. */
  projects() {
    const totals = {};
    const add = (row) => {
      if (!row.project_id) return;
      const t = totals[row.project_id] || (totals[row.project_id] = { cost: 0, runs: 0, tokens: 0, last_day: null });
      t.cost = round(t.cost + (row.cost || 0), 6);
      t.runs += row.runs;
      t.tokens += row.tokens || 0;
      if (!t.last_day || row.last_day > t.last_day) t.last_day = row.last_day;
    };
    this.db.prepare('SELECT project_id, SUM(cost) AS cost, COUNT(*) AS runs, SUM(prompt_tokens + completion_tokens) AS tokens, MAX(day) AS last_day FROM model_usage WHERE project_id IS NOT NULL GROUP BY project_id').all().forEach(add);
    this.db.prepare("SELECT project_id, SUM(cost) AS cost, SUM(runs) AS runs, SUM(prompt_tokens + completion_tokens) AS tokens, MAX(day) AS last_day FROM model_usage_days WHERE project_id != '' GROUP BY project_id").all().forEach(add);
    return totals;
  }

  /**
   * What a chat cost on a day, all its requests together: the limit a chat
   * watched over by the assistant is held to. `waiting`: requests whose cost
   * the provider has not given yet.
   */
  spentBy(conversationId, day) {
    const row = this.db.prepare(`SELECT COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS runs,
        COALESCE(SUM(CASE WHEN cost IS NULL AND local = 0 AND ok = 1 THEN 1 ELSE 0 END), 0) AS waiting
      FROM model_usage WHERE conversation_id = ? AND day = ?`).get(String(conversationId || ''), LOCAL_DAY.test(String(day)) ? String(day) : '');
    return { cost: Number(row?.cost) || 0, runs: Number(row?.runs) || 0, waiting: Number(row?.waiting) || 0 };
  }

  /** The rows between two days, light: what the overviews are worked out of. */
  rows({ from, to, projectId = null } = {}) {
    const start = from && LOCAL_DAY.test(from) ? from : '0000-01-01';
    const end = to && LOCAL_DAY.test(to) ? to : '9999-12-31';
    return this.db.prepare(`SELECT id, day, project_id, place, role, turn, model, provider, local, queued, ok, stopped, corrected, reverted,
        prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, cost, ms, first_ms FROM model_usage
      WHERE day >= ? AND day <= ? ${projectId ? 'AND project_id = ?' : ''} ORDER BY id`).all(...[start, end, projectId].filter(v => v !== null));
  }

  /**
   * The overview of a period: what was spent, day by day, by project, by
   * place, and how each model did in each role. The rates of a model say
   * something only with enough requests (`enough`).
   */
  overview({ from, to, projectId = null } = {}) {
    const rows = this.rows({ from, to, projectId });
    const groups = (key) => {
      const map = new Map();
      rows.forEach(row => { const k = key(row); if (!map.has(k)) map.set(k, []); map.get(k).push(row); });
      return map;
    };
    const names = new Map(this.store.listProjects('all').map(p => [p.id, p.name]));
    const light = (m) => ({ runs: m.runs, turns: m.turns, cost: m.cost, prompt_tokens: m.prompt_tokens, completion_tokens: m.completion_tokens });
    return {
      from: from || null, to: to || null,
      total: measure(rows),
      byDay: [...groups(r => r.day)].map(([day, list]) => ({ day, ...light(measure(list)) })),
      byPlace: [...groups(r => r.place)].map(([place, list]) => ({ place, ...light(measure(list)) })).sort((a, b) => b.cost - a.cost),
      byProject: [...groups(r => r.project_id || '')].filter(([id]) => id)
        .map(([id, list]) => ({ project_id: id, name: names.get(id) || null, ...light(measure(list)), last_day: list[list.length - 1].day })).sort((a, b) => b.cost - a.cost),
      byModel: [...groups(r => `${r.role}\n${r.model}`)].map(([key, list]) => ({ role: key.split('\n')[0], model: key.split('\n')[1], local: Boolean(list[0].local), ...measure(list) }))
        .sort((a, b) => a.role.localeCompare(b.role) || b.runs - a.runs)
    };
  }

  /* ------------------------------ sharing --------------------------- */

  /** Whether sharing exists at all in this build (share-endpoint.js); off, the page says nothing about it. */
  shareOn() { return SHARE_ON || process.env.SYNTHORG_SHARE_ON === '1'; }

  /** Where the numbers go when the user shares them; empty when sharing is off or there is nowhere yet, and then nothing is asked. */
  endpoint() {
    if (!this.shareOn()) return '';
    const own = String(this.store.getSetting('usage_share_endpoint') || process.env.SYNTHORG_SHARE_ENDPOINT || SHARE_ENDPOINT || '').trim();
    return /^https:\/\/[^\s]+$/.test(own) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[^\s]*)?$/.test(own) ? own : '';
  }

  mark() { return count(this.store.getSetting('usage_share_mark')); }

  /** Whether it is time to ask: somewhere to send to, enough spending recorded since the last question, no question put off. */
  shareState() {
    const mark = this.mark();
    const waiting = this.db.prepare('SELECT COUNT(*) AS runs, COALESCE(SUM(cost), 0) AS cost, MAX(id) AS until FROM model_usage WHERE id > ?').get(mark);
    const later = Date.parse(this.store.getSetting('usage_share_later') || '') || 0;
    const endpoint = this.endpoint();
    return {
      on: this.shareOn(),
      ready: Boolean(endpoint),
      every: SHARE_EVERY,
      runs: waiting.runs,
      cost: round(waiting.cost, 6),
      until: waiting.until || mark,
      due: Boolean(endpoint) && waiting.cost >= SHARE_EVERY && Date.now() >= later,
      history: this.db.prepare('SELECT id, at, answer, runs, cost FROM usage_shares ORDER BY at DESC LIMIT 50').all()
    };
  }

  /** The projects the stretch not asked about yet was spent on. */
  shareProjects() {
    return this.db.prepare('SELECT DISTINCT project_id FROM model_usage WHERE id > ? AND project_id IS NOT NULL').all(this.mark()).map(row => row.project_id);
  }

  /** The question closed without an answer: asked again tomorrow. */
  shareLater() {
    this.store.setSetting('usage_share_later', new Date(Date.now() + SHARE_LATER_MS).toISOString());
    return { later: true };
  }

  /**
   * What would be shared of the stretch not asked about yet, up to a row:
   * the requests grouped by model, role, place and kind of project, with
   * their sums and medians. profiles: what each project is made of
   * ({ project_id: { languages, size } }); a project without one is "unknown".
   */
  sharePackage({ until, profiles = {}, app = '' } = {}) {
    const mark = this.mark();
    // Up to the row the user was shown, never past the last one there is: what comes later is asked about later.
    const newest = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM model_usage').get().id;
    const last = Math.min(count(until) || newest, newest);
    const rows = this.db.prepare(`SELECT id, day, project_id, place, role, turn, model, provider, local, queued, ok, stopped, corrected, reverted,
        prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, cost, ms, first_ms FROM model_usage WHERE id > ? AND id <= ? ORDER BY id`).all(mark, last);
    if (!rows.length) fail('Non c’è niente da condividere.', 409);
    // What goes is what was shown: the same stretch asked for again within the hour is the same package, to the letter.
    const key = JSON.stringify([mark, last, profiles, app]);
    if (this.built?.key === key && Date.now() - this.built.at < 3600000) return this.built.value;
    const keep = (value) => { this.built = { key, at: Date.now(), value }; return value; };
    const kind = (row) => {
      if (!row.project_id) return null;
      const p = profiles[row.project_id];
      return p ? { languages: [...p.languages].slice(0, 3), size: p.size } : { languages: [], size: 'unknown' };
    };
    const map = new Map();
    rows.forEach(row => {
      const project = kind(row);
      const key = JSON.stringify([publicModel(row.model, row.local), publicRole(row.role), row.place, project, Boolean(row.queued)]);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    });
    const whole = (v) => (v === null ? null : Math.round(v / 10) * 10);
    const groups = [...map].map(([key, list]) => {
      const [model, role, place, project, queued] = JSON.parse(key);
      const m = measure(list);
      return {
        model, role, place, project, queued,
        runs: m.runs, ok: m.ok, stopped: m.stopped, turns: m.turns, corrected: m.corrected, reverted: m.reverted, unpriced: m.unpriced,
        prompt_tokens: m.prompt_tokens, completion_tokens: m.completion_tokens, cached_tokens: m.cached_tokens, reasoning_tokens: m.reasoning_tokens,
        cost: m.cost, ms_p50: whole(m.ms_p50), ms_p90: whole(m.ms_p90), first_ms_p50: whole(m.first_ms_p50), first_ms_p90: whole(m.first_ms_p90),
        tokens_per_second_p50: m.tokens_per_second_p50
      };
    }).sort((a, b) => b.runs - a.runs || a.model.localeCompare(b.model));
    const weeks = rows.map(row => weekOf(row.day)).sort();
    return keep({
      from: mark, until: last,
      runs: rows.length,
      cost: round(rows.reduce((a, r) => a + (r.cost || 0), 0), 6),
      package: {
        schema: 1,
        id: randomUUID(),
        app: /^\d+\.\d+\.\d+$/.test(String(app)) ? String(app) : '',
        weeks: { from: weeks[0], to: weeks[weeks.length - 1] },
        groups
      }
    });
  }

  /** The user's answer about a stretch: it is not asked about again. What was shared is kept, to be seen. */
  answerShare({ answer, from, until, runs, cost, package: shared = null }) {
    if (!['shared', 'declined'].includes(answer)) fail('Risposta non valida.');
    const last = count(until);
    if (last <= this.mark()) fail('Questi dati hanno già avuto una risposta.', 409);
    return this.store.transaction(() => {
      const id = shared?.id || randomUUID();
      this.db.prepare('INSERT INTO usage_shares(id,at,answer,from_id,until_id,runs,cost,package_json) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, now(), answer, count(from), last, count(runs), Number(cost) || 0, answer === 'shared' ? JSON.stringify(shared) : null);
      this.store.setSetting('usage_share_mark', String(last));
      this.store.setSetting('usage_share_later', '');
      // A handful of them is kept: what was sent a year ago is on the other side.
      this.db.prepare('DELETE FROM usage_shares WHERE id NOT IN (SELECT id FROM usage_shares ORDER BY at DESC LIMIT 50)').run();
      return { id, answer, until: last };
    });
  }

  /** What was shared, as it went. */
  shared(id) {
    const row = this.db.prepare('SELECT * FROM usage_shares WHERE id=?').get(String(id));
    if (!row) fail('Condivisione non trovata.', 404);
    return { ...row, package: row.package_json ? JSON.parse(row.package_json) : null };
  }
}

module.exports = { Usage, measure, quantile, weekOf, profileOf, publicRole, publicModel, KEEP_DAYS, SHARE_EVERY, ENOUGH, KNOWN_ROLES, KNOWN_TOOLS, KNOWN_JOBS, LANGUAGES };
