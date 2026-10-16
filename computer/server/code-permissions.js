'use strict';
const crypto = require('node:crypto');
const { fail } = require('./database');

/**
 * What the model may do to a Code project without asking.
 *
 * Two independent switches per project, one for the code (the five tools that
 * change files) and one for the terminal (commands in the project's
 * container), each set to one of three modes:
 *
 *   manual  every action waits for the user, nothing is remembered;
 *   semi    an action the user already approved in this project passes by
 *           itself, a new one asks and, once approved, joins the list;
 *   auto    nothing asks.
 *
 * "The same action" is decided here, by a plain function and never by a
 * model. For the terminal it is the command itself, spaces collapsed. For the
 * code it is the file plus the kind of operation: a change to a file
 * (edit_file, overwrite_file) is remembered per file, while creating,
 * deleting or renaming a file changes what exists in the project and in semi
 * mode always asks.
 *
 * One rule stands above every mode: a command that reaches outside the
 * working directory (an absolute path elsewhere, `..`, the home directory)
 * always asks, auto included. The working directory is /workspace in a
 * container and the project's own folder on this machine. File tools cannot leave the project at all —
 * they are refused before they get here — so for them there is nothing to ask.
 *
 * An action that has to ask is not run: the caller gets a pending request to
 * show, and the answer comes back through `decide`, which runs the action
 * when it is approved. A request nobody answers expires.
 */

const MODES = ['manual', 'semi', 'auto'];
const KINDS = ['code', 'terminal'];
const DEFAULT_MODE = 'manual';
const PENDING_TTL_MS = 10 * 60 * 1000;
const WORKDIR = '/workspace';
// The Studio's tools follow the same two kinds: a change inside a chapter is
// remembered per chapter; adding, removing or moving a chapter always asks in semi mode.
// The Foto tools: a command on the open document is one change, remembered
// once per project in semi mode (it is undoable in photocraft's own history);
// saving a file is structure; overwriting one always asks, whatever the mode.
const STRUCTURE_TOOLS = new Set(['create_file', 'delete_file', 'rename_file', 'studio_chapter', 'photo_save']);
const CHANGE_TOOLS = new Set(['edit_file', 'overwrite_file', 'studio_replace', 'studio_insert', 'studio_delete', 'photo_run', 'photo_batch', 'photo_place', 'photo_remove_background', 'photo_select_object']);
const PREVIEW_LINES = 40;

function assertMode(value) {
  if (!MODES.includes(value)) fail('Modalità non valida: manual, semi o auto.');
  return value;
}

function normalizeCommand(command) {
  return String(command ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * Whether a command names anything outside the working directory. It reads
 * the command as words: an absolute path not under /workspace, a `..`
 * segment, the home directory. Deliberately strict, so a false alarm only
 * costs a question and a miss is the rarer case.
 */
function samePath(value, root) {
  const a = String(value).replace(/\\/g, '/').replace(/\/+$/, ''), b = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
  const fold = /^[a-zA-Z]:/.test(b) ? s => s.toLowerCase() : s => s;   // Windows paths compare without case
  return fold(a) === fold(b) || fold(a).startsWith(fold(b) + '/');
}

function leavesWorkdir(command, cwd, root = WORKDIR) {
  if (cwd && !samePath(cwd, root)) return 'cwd';
  const text = String(command ?? '');
  if (/(^|[\s"'=:])~(\/|\\|$|\s)/.test(text) || /\$\{?HOME\b/.test(text) || /%USERPROFILE%|%HOMEPATH%|\$env:USERPROFILE|\$env:HOME/i.test(text)) return 'home';
  for (const rawWord of text.split(/\s+/)) {
    const word = rawWord.replace(/^["']+|["']+$/g, '');
    if (!word) continue;
    // an option carrying a path: --file=/etc/passwd
    const candidates = word.includes('=') ? [word, word.slice(word.indexOf('=') + 1)] : [word];
    for (const candidate of candidates) {
      if (/(^|[\/\\])\.\.([\/\\]|$)/.test(candidate)) return 'parent';
      const absolute = candidate.startsWith('/') || candidate.startsWith('\\') || /^[a-zA-Z]:[\/\\]/.test(candidate);
      if (absolute && !samePath(candidate, root)) return 'absolute';
    }
  }
  return null;
}

/** Where a project's commands run: its folder here, /workspace in a container. */
function workdirOf(project) {
  return project.kind === 'local' ? project.path : WORKDIR;
}

function codeKey(tool, input) {
  const path = String(input?.path ?? (input?.chapter !== undefined ? `capitolo ${input.chapter}` : (tool === 'photo_run' || tool === 'photo_batch' || tool === 'photo_remove_background' || tool === 'photo_select_object') ? 'photocraft' : '')).trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  return `${STRUCTURE_TOOLS.has(tool) ? 'struttura' : 'modifica'}:${path}`;
}

function preview(text) {
  const lines = String(text ?? '').split('\n');
  const shown = lines.slice(0, PREVIEW_LINES).join('\n');
  return lines.length > PREVIEW_LINES ? `${shown}\n… (${lines.length - PREVIEW_LINES} righe in più)` : shown;
}

/** What the user is shown when asked: one line of title and the substance. */
function describe(kind, name, input) {
  if (kind === 'terminal') return { title: 'command', path: null, detail: normalizeCommand(input?.command) };
  const path = String(input?.path ?? '');
  switch (name) {
    case 'edit_file': {
      const from = Number(input?.from_line) || 1, to = Number(input?.to_line) || from;
      return { title: 'edit', path, range: `${from}${to > from ? `-${to}` : ''}`, match: typeof input?.match === 'string' ? input.match : null, detail: preview(input?.content) };
    }
    case 'overwrite_file': return { title: 'overwrite', path, detail: preview(input?.content) };
    case 'create_file': return { title: 'create', path, detail: preview(input?.content) };
    case 'delete_file': return { title: 'delete', path, detail: '' };
    case 'rename_file': return { title: 'rename', path, to: String(input?.to ?? ''), detail: '' };
    case 'studio_replace': return { title: 'replace', path: `capitolo ${input?.chapter}`, range: `${Number(input?.from) || 1}${input?.to && Number(input.to) > Number(input.from) ? `-${Number(input.to)}` : ''}`, detail: preview(input?.text) };
    case 'studio_insert': return { title: 'insert', path: `capitolo ${input?.chapter}`, range: `dopo ${Number(input?.after) || 0}`, detail: preview(input?.text) };
    case 'studio_delete': return { title: 'delete', path: `capitolo ${input?.chapter}`, range: `${Number(input?.from) || 1}${input?.to && Number(input.to) > Number(input.from) ? `-${Number(input.to)}` : ''}`, detail: '' };
    case 'studio_chapter': return { title: String(input?.action || 'chapter'), path: input?.chapter !== undefined ? `capitolo ${input.chapter}` : String(input?.title || ''), detail: preview(input?.text) };
    case 'photo_run': return { title: 'command', path: String(input?.command || ''), detail: preview(JSON.stringify(input?.params ?? {}, null, 1)) };
    case 'photo_batch': return { title: 'batch', path: `${Array.isArray(input?.steps) ? input.steps.length : 0} comandi`, detail: preview((Array.isArray(input?.steps) ? input.steps : []).map(s => s?.command).filter(Boolean).join('\n')) };
    case 'photo_save': return { title: input?.overwrite ? 'overwrite' : 'save', path, detail: '' };
    case 'photo_select_object': return { title: 'selectObject', path: Array.isArray(input?.box) ? input.box.join(', ') : 'selezione', detail: '' };
    case 'photo_place': return { title: 'place', path, detail: '' };
    case 'photo_remove_background': return { title: 'removeBackground', path: path || (input?.output === 'selection' ? 'selezione' : 'livello'), detail: '' };
    default: return { title: name, path, detail: '' };
  }
}

class CodePermissions {
  constructor({ store, ttlMs = PENDING_TTL_MS, now = Date.now } = {}) {
    this.store = store;
    this.ttlMs = ttlMs;
    this.now = now;
    this.pending = new Map();
  }

  /** The two modes in force for a project: its own, or the defaults from the settings. */
  modes(project) {
    const store = this.store();
    const fallback = kind => {
      const value = store.getSetting(`code_perm_${kind}`);
      return MODES.includes(value) ? value : DEFAULT_MODE;
    };
    return {
      code: MODES.includes(project.perm_code) ? project.perm_code : fallback('code'),
      terminal: MODES.includes(project.perm_terminal) ? project.perm_terminal : fallback('terminal')
    };
  }

  /**
   * Allow or ask, and why. `request` is `{ name, input }` for the code and
   * `{ command, cwd }` for the terminal.
   */
  evaluate(project, kind, request) {
    if (!KINDS.includes(kind)) fail('Tipo di permesso sconosciuto.');
    const mode = this.modes(project)[kind];
    if (kind === 'terminal') {
      const key = normalizeCommand(request.command);
      const outside = leavesWorkdir(request.command, request.cwd, workdirOf(project));
      if (outside) return { verdict: 'ask', reason: 'outside', mode, key, remember: false };
      if (mode === 'auto') return { verdict: 'allow', reason: 'auto', mode, key };
      if (mode === 'semi') {
        if (this.store().hasApproval(project.id, kind, key)) return { verdict: 'allow', reason: 'remembered', mode, key };
        return { verdict: 'ask', reason: 'new', mode, key, remember: true };
      }
      return { verdict: 'ask', reason: 'manual', mode, key, remember: false };
    }
    const name = request.name;
    if (!STRUCTURE_TOOLS.has(name) && !CHANGE_TOOLS.has(name)) return { verdict: 'allow', reason: 'read', mode, key: null };
    const key = codeKey(name, request.input);
    // Writing over a file the user has is the one thing no mode lets through on its own.
    if (name === 'photo_save' && request.input?.overwrite === true) return { verdict: 'ask', reason: 'overwrite', mode, key, remember: false };
    if (mode === 'auto') return { verdict: 'allow', reason: 'auto', mode, key };
    if (mode === 'semi') {
      if (STRUCTURE_TOOLS.has(name)) return { verdict: 'ask', reason: 'structure', mode, key, remember: false };
      if (this.store().hasApproval(project.id, kind, key)) return { verdict: 'allow', reason: 'remembered', mode, key };
      return { verdict: 'ask', reason: 'new', mode, key, remember: true };
    }
    return { verdict: 'ask', reason: 'manual', mode, key, remember: false };
  }

  /**
   * Runs `run()` when the action may pass; otherwise parks it and answers
   * with the request to put in front of the user.
   */
  async gate(project, kind, request, run) {
    const decision = this.evaluate(project, kind, request);
    if (decision.verdict === 'allow') return run();
    const id = crypto.randomUUID();
    const name = kind === 'terminal' ? 'sandbox_exec' : request.name;
    const summary = describe(kind, name, kind === 'terminal' ? request : request.input);
    const createdAt = this.now();
    const entry = {
      id, projectId: project.id, kind, name, key: decision.key, remember: decision.remember, runId: request.runId || null,
      label: kind === 'terminal' ? summary.detail : `${name} ${summary.path}${summary.to ? ` → ${summary.to}` : ''}`,
      run, createdAt,
      timer: setTimeout(() => this.pending.delete(id), this.ttlMs)
    };
    if (entry.timer.unref) entry.timer.unref();
    this.pending.set(id, entry);
    return {
      pending: true,
      approval: {
        id, kind, name, mode: decision.mode, reason: decision.reason, remember: decision.remember,
        summary, expiresAt: new Date(createdAt + this.ttlMs).toISOString()
      }
    };
  }

  /** The user's answer. Approving runs the action; in semi mode it is remembered. */
  async decide(projectId, id, decision) {
    const entry = this.pending.get(String(id));
    if (!entry || entry.projectId !== projectId) fail('Richiesta di approvazione scaduta o inesistente.', 404);
    this.pending.delete(entry.id);
    clearTimeout(entry.timer);
    if (decision !== 'allow') return { approved: false };
    if (entry.remember && entry.key) this.store().addApproval(projectId, entry.kind, entry.key, entry.label);
    return { approved: true, result: await entry.run() };
  }

  /** The run id of the command a pending request would start, so its caller can end it. */
  runIdOf(id) {
    return this.pending.get(String(id))?.runId || null;
  }

  list(projectId) {
    return this.store().listApprovals(projectId);
  }

  forget(projectId, rowId) {
    return this.store().removeApproval(projectId, rowId);
  }

  forgetAll(projectId) {
    return this.store().clearApprovals(projectId);
  }

  /** Requests still waiting, for a page that reopens a chat mid-question. */
  pendingFor(projectId) {
    return [...this.pending.values()].filter(p => p.projectId === projectId).map(p => ({ id: p.id, kind: p.kind, name: p.name, label: p.label, createdAt: new Date(p.createdAt).toISOString() }));
  }
}

module.exports = { CodePermissions, MODES, KINDS, DEFAULT_MODE, STRUCTURE_TOOLS, CHANGE_TOOLS, assertMode, normalizeCommand, leavesWorkdir, workdirOf, codeKey, describe };
