'use strict';
const fs = require('node:fs');
const { DATA_DIR } = require('./paths');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { fail, PROJECT_SECTIONS, PROJECT_ENVS, ENV_SECTION, projectEnvs, sectionEnabled } = require('./database');
const { profileOf } = require('./usage');
const { assertSafeImage, PROJECT_CONTAINER_PREFIX, DEFAULT_PROJECT_IMAGE } = require('./sandbox');

// Where a project runs. Whether it is linked to a GitHub repository is the
// other, independent choice: both kinds can have one, and both kinds have git.
const KINDS = ['local', 'podman'];

// Where a container project's files are, as the editor and the model see them.
const CONTAINER_WORKDIR = '/workspace';

/**
 * Git here is two different things, and keeping them apart is the whole point.
 *
 * Locally it is the record: every save and every tool call the model makes is
 * committed, on whatever branch the project is already on. Nothing is
 * duplicated, nothing is branched, and nothing can change the code without
 * ending up in the history — which is what makes the work reversible.
 *
 * GitHub is the other plane, and it is the user's alone. A project follows
 * its repository in one of two ways: all of it, every branch there to move
 * between, or one branch only — main or any other. Either way the branch here
 * and the branch of the same name on GitHub are one thing: download brings its
 * steps here, upload sends the ones made here. Neither ever overwrites: when
 * both sides have steps the other lacks, the user is asked. No model reaches
 * any of it.
 */
const BRANCH_PREFIX_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const DEFAULT_BRANCH_PREFIX = 'lavoro';
const DEFAULT_LOCAL_BRANCH = 'main';
const REPO_MODES = ['full', 'branch'];
const REMOTE_REFS = 'refs/remotes/origin';
// Where the steps taken off a branch by "keep GitHub's" stay, so that choice loses nothing.
const KEPT_REFS = 'refs/synthorg/kept';
// A branch that syncs on its own uploads once the steps stop arriving for a moment.
const AUTO_PUSH_QUIET_MS = 2000;
const NETWORK_TIMEOUT_MS = 5 * 60 * 1000;
// How many branches of a list get their distance from GitHub counted.
const BRANCH_COUNT_LIMIT = 40;

/**
 * What each side may ask for.
 *
 * `checkpoint` is open to both because it is not a decision: it is the
 * recorder, and it runs after a save or a tool call rather than being chosen.
 * Everything that talks to GitHub is the user's alone.
 */
const GIT_ACTIONS = {
  checkpoint: { actors: ['user', 'agent'] },
  branches: { actors: ['user'] },
  switch: { actors: ['user'] },
  'new-branch': { actors: ['user'] },
  pull: { actors: ['user'] },
  push: { actors: ['user'] },
  resolve: { actors: ['user'] },
  sync: { actors: ['user'] },
  link: { actors: ['user'] },
  unlink: { actors: ['user'] }
};

/**
 * Configuration every git command runs with, passed through the environment
 * rather than the command line. The working tree is written by the model, so
 * its own hooks, fsmonitor, credential helpers and proxy settings must never
 * run or see a credential; command-line configuration takes precedence over
 * them. `nowhere` is a path that does not exist: as a config file it reads
 * empty, as a hooks directory it holds no hook.
 */
function gitEnv({ workdir, nowhere, extra = [] }) {
  const entries = [
    ['safe.directory', workdir],
    ['core.hooksPath', nowhere],
    ['core.fsmonitor', 'false'],
    ['credential.helper', ''],
    ['http.proxy', ''],
    ['http.sslVerify', 'true'],
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always'],
    ...extra
  ];
  // Git's answers are read here, so they come in the one language they are matched in.
  // Commands that only read (status above all) take no lock: one asked while a step is
  // being recorded — the automatic upload, the bar refreshing — must not make that step fail.
  const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nowhere, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

// Who a commit is by. The model writes under a name of its own so the history
// says, on its face, which changes are not the user's.
const AGENT_AUTHOR = { name: 'SynthOrg (modello)', email: 'agent@synthorg.invalid' };
const USER_FALLBACK = { name: 'SynthOrg (tu)', email: 'you@synthorg.invalid' };
const SOURCES = ['user', 'agent'];
// Written into every commit, so the git view can say where a change came from
// without guessing from the author's name.
const SOURCE_TRAILER = 'SynthOrg-Source';
const TOOL_TRAILER = 'SynthOrg-Tool';

/** "La mia API" -> "la-mia-api": the part of the container name the user picks. */
function containerSlug(value) {
  return String(value || '').toLowerCase().trim()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-_.]+$/, '')
    .slice(0, 50);
}

/** The namespace this project's branches on GitHub live under. */
function branchPrefix(value) {
  const slug = containerSlug(value).replace(/[-_.]+$/, '');
  return BRANCH_PREFIX_PATTERN.test(slug) ? slug : DEFAULT_BRANCH_PREFIX;
}

/** A branch, as the user named it: what git accepts as a branch name, nothing that reads as an option. */
function pushBranchName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 200 || !/^[A-Za-z0-9._\/-]+$/.test(name) || name.startsWith('-') || name.startsWith('/')
    || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock') || name.includes('..') || name.includes('//')
    || name.split('/').some(part => part.startsWith('.')) || name === 'HEAD') fail('Nome del ramo non valido.');
  return name;
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isDirectory(value) {
  try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

/**
 * The name of a change, for a commit nobody bothered to name. Reads the short
 * status: two letters, a space, then the path — and for a rename, the path it
 * ended up at.
 */
function describeChanges(porcelain) {
  const names = [];
  for (const line of String(porcelain).split(/\r?\n/)) {
    if (line.length < 4) continue;
    const file = line.slice(3).trim().split(' -> ').pop().replace(/^"|"$/g, '').replace(/\/+$/, '');
    if (file) names.push(file.split('/').pop());
  }
  if (!names.length) return 'modifiche';
  const unique = [...new Set(names)];
  return unique.length <= 3 ? unique.join(', ') : `${unique.slice(0, 3).join(', ')} e altri ${unique.length - 3}`;
}

// --- reading the history back ------------------------------------------------

// Hash, parents, title, date, author, and the two trailers every step carries.
const HISTORY_FORMAT = ['%H', '%P', '%s', '%cI', '%an',
  `%(trailers:key=${SOURCE_TRAILER},valueonly,separator=%x2C)`,
  `%(trailers:key=${TOOL_TRAILER},valueonly,separator=%x2C)`].join('%x00');
// What the first step is compared with: git's empty tree.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const HISTORY_FILE_MAX = 2 * 1024 * 1024;
const HISTORY_FILE_LINES = 3000;                         // lines of diff per file before it is cut
// Saves that come close together are one step: the same quiet time the page waits for a local project.
const SAVE_QUIET_MS = 1200;
// How often the local projects are looked at for steps made outside the app.
const STEPS_LOOK_MS = 5 * 60 * 1000;

function historyHash(value) {
  const hash = String(value || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) fail('Versione non valida.');
  return hash.toLowerCase();
}

/** A path inside the project, as git names it: relative, forward slashes, never outside, never an option. */
function historyPath(value) {
  const file = String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!file || file.length > 1000 || file.includes('\0') || file.startsWith('/') || file.startsWith('-')
    || file.split('/').some(part => part === '..' || part === '')) fail('Percorso non valido.');
  return file;
}

/** One entry of HISTORY_FORMAT, with the --numstat lines that may follow it (or the body, for a single step). */
function parseHistoryEntry(chunk) {
  const newline = chunk.indexOf('\n');
  const head = newline === -1 ? chunk : chunk.slice(0, newline);
  let [hash, parents, title, when, author, source, tool, ...rest] = head.split('\0');
  // Steps recorded before new folders were named by their files have no title of their own:
  // their trailers ended up as the subject. Who made them is still there.
  const legacy = new RegExp(`^${SOURCE_TRAILER}: (\\w+)(?: ${TOOL_TRAILER}: (\\S+))?$`).exec(title || '');
  if (legacy) { source = source || legacy[1]; tool = tool || legacy[2] || ''; title = ''; }
  let files = 0, additions = 0, deletions = 0;
  const tail = newline === -1 ? '' : chunk.slice(newline + 1);
  for (const line of tail.split('\n')) {
    const stat = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!stat) continue;
    files++;
    if (stat[1] !== '-') additions += Number(stat[1]);
    if (stat[2] !== '-') deletions += Number(stat[2]);
  }
  // For a single step the body follows the tool trailer: what is not a trailer is the description.
  const body = rest.length ? [rest.join('\0'), tail].join('\n').split('\n')
    .filter(line => !new RegExp(`^(${SOURCE_TRAILER}|${TOOL_TRAILER}):`).test(line)).join('\n').trim() : '';
  return {
    hash, short: (hash || '').slice(0, 7), parents: (parents || '').split(' ').filter(Boolean),
    title: title || '', when, author,
    source: SOURCES.includes(source) ? source : null,
    tool: tool || null,
    files, additions, deletions,
    ...(rest.length ? { body } : {})
  };
}

/** `git diff --name-status -z`: a status, then one path, or two for a rename or a copy. */
function parseNameStatus(out) {
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length && parts[i];) {
    const code = parts[i++];
    const kind = code[0];
    if (kind === 'R' || kind === 'C') files.push({ status: kind, oldPath: parts[i++], path: parts[i++] });
    else files.push({ status: kind, oldPath: null, path: parts[i++] });
  }
  return files;
}

/** A unified diff cut per file, in the order git wrote them: the hunks, counted, long ones cut. */
function splitPatch(patch) {
  const sections = [];
  for (const block of patch.split(/^(?=diff --git )/m)) {
    if (!block.startsWith('diff --git ')) continue;
    const at = block.search(/^@@ /m);
    const header = at === -1 ? block : block.slice(0, at);
    const binary = /^Binary files |^GIT binary patch/m.test(header);
    let lines = at === -1 ? [] : block.slice(at).replace(/\n$/, '').split('\n');
    let additions = 0, deletions = 0;
    for (const line of lines) {
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
    const truncated = lines.length > HISTORY_FILE_LINES;
    if (truncated) lines = lines.slice(0, HISTORY_FILE_LINES);
    sections.push({ binary, hunks: lines.join('\n'), additions, deletions, truncated });
  }
  return sections;
}

/**
 * Code projects: where the editor and, later, the agents work.
 *
 * A project is an entry pointing at work the user owns. Two choices describe
 * it and neither implies the other: it runs in a folder of this computer or in
 * a container of its own, and it is linked to a GitHub repository or it is
 * not. Git is always there either way.
 *
 * Nothing here deletes files: removing a project forgets the entry and, for
 * container projects, the dedicated container, while the folder (local) or the
 * volume (container) stays where it is.
 */
class ProjectManager {
  constructor({ store, sandbox, github = null, dataDir = null, gitConfig = [] }) {
    this.store = store;
    // Configuration added to every git command; the tests use it to stand a folder in for GitHub.
    this.gitConfig = gitConfig;
    this.sandbox = sandbox;
    this.github = github;
    // A directory of ours that stays empty, so the path inside it never exists.
    this.hostNowhere = path.join(dataDir || DATA_DIR, 'git-none', 'nothing-here');
    // Absolute: git is run inside what is kept under it, where a relative path would mean another place.
    this.dataDir = path.resolve(dataDir || DATA_DIR);
    // The copy of the pods' projects kept in the memory (see `copyToMemory`): what was last copied of each, the
    // copies waiting to be made, and how the last one of each went.
    this.copied = new Map();
    this.copyTimers = new Map();
    this.copyState = new Map();
    this.copyDelayMs = 1500;
    this.identity = null;
    // What `open` is doing right now, per project. Opening a container project
    // is one request that can take twenty seconds on its first start, and the
    // page has nothing to show meanwhile: it asks here which step is running.
    this.opening = new Map();
    // Automatic sync, per project: the upload waiting for the steps to stop, and how the last one went.
    this.syncs = new Map();
  }

  /** The step `open` is on, for the page's progress bar; null when it is not opening. */
  progress(id) {
    const state = this.opening.get(String(id));
    return { phase: state ? state.phase : null, since: state ? state.since : null };
  }

  /**
   * The folder decides which part of the disk the project exposes, so only an
   * existing absolute directory is accepted, resolved through links, and never
   * the root of a drive.
   */
  resolveFolder(value) {
    if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) fail('Scegli una cartella con un percorso assoluto.');
    let real;
    try { real = fs.realpathSync(value); } catch { fail('La cartella scelta non esiste.'); }
    if (!isDirectory(real)) fail('Il percorso scelto non è una cartella.');
    if (path.parse(real).root === real) fail('Non puoi usare la radice di un disco come progetto: scegli una sottocartella.');
    return real;
  }

  /** The repository the user picked, or none. Both are normal. */
  async resolveRepo(value) {
    if (value === undefined || value === null || value === '') return null;
    if (!this.github) fail('GitHub non disponibile.', 501);
    const repo = await this.github.getRepository(value);
    if (!repo.canPush) fail(`Il tuo account non può scrivere su ${repo.full_name}.`, 403);
    return repo;
  }

  /** How a project follows its repository: all of it, or the one branch named. */
  repoChoice(repo, mode, branch) {
    if (!repo) return { repoMode: null, repoBranch: null };
    if (mode !== undefined && mode !== null && !REPO_MODES.includes(mode)) fail('Modo di collegamento non valido.');
    if (mode !== 'branch') return { repoMode: 'full', repoBranch: null };
    return { repoMode: 'branch', repoBranch: pushBranchName(branch || repo.default_branch) };
  }

  async create(input) {
    if (!KINDS.includes(input.kind)) fail('Tipo di progetto non valido.');
    // Studio and Foto projects are local folders: their files are written here, by the user and the model.
    // A project made from the Lab names its environments, several together; one made from a section has that section's.
    let envs = null;
    if (input.envs !== undefined) {
      if (!Array.isArray(input.envs) || input.envs.some(env => !PROJECT_ENVS.includes(env))) fail('Ambienti non validi.');
      envs = PROJECT_ENVS.filter(env => input.envs.includes(env));
      if (!envs.length) fail('Scegli almeno un ambiente.');
    }
    const section = envs ? ENV_SECTION[envs[0]] : PROJECT_SECTIONS.includes(input.section) ? input.section : 'code';
    // Every environment works in a pod as in a folder: the photos and the texts are reached through the pod's container.
    const sections = envs ? envs.map(env => ENV_SECTION[env]) : [section];
    if (input.permission !== undefined && !['manual', 'semi', 'auto'].includes(input.permission)) fail('Modalità non valida: manual, semi o auto.');
    const store = this.store();
    for (const one of sections) if (!sectionEnabled(store, one)) fail(`La sezione ${one === 'code' ? 'Code' : 'Studio'} è spenta.`, 403);
    // One permission for the whole project, when it is given: the code and the terminal alike.
    const made = (project) => input.permission ? store.setProjectPermissions(project.id, { code: input.permission, terminal: input.permission }) : project;
    const extra = { envs, notes: typeof input.notes === 'string' ? input.notes : null };
    const id = randomUUID();
    const repo = await this.resolveRepo(input.repo);
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : repo ? repo.full_name : null;
    const link = { repo: repo?.full_name || null, defaultBranch: repo?.default_branch || null, ...this.repoChoice(repo, input.repoMode, input.repoBranch) };

    if (input.kind === 'local') {
      // A folder of the user's, edited on this machine: no container by choice.
      const folder = this.resolveFolder(input.path);
      if (store.listProjects('all').some(p => p.kind === 'local' && samePath(p.path, folder))) fail('Questa cartella è già un progetto.', 409);
      const projectName = name || path.basename(folder);
      return made(store.createProject({
        id, name: projectName, kind: 'local', path: folder,
        branchPrefix: branchPrefix(projectName), section, ...extra, ...link
      }));
    }

    const slug = containerSlug(input.container || (repo ? repo.name : name));
    if (!slug) fail('Nome del processo non valido: usa lettere, numeri, "-", "_" o ".".');
    const containerName = PROJECT_CONTAINER_PREFIX + slug;
    if (store.listProjects('all').some(p => p.container_name === containerName)) fail(`Il processo "${slug}" esiste già: scegli un altro nome.`, 409);
    const image = assertSafeImage(input.image || DEFAULT_PROJECT_IMAGE);
    const projectName = name || slug;
    // The files live in the engine's volume named like the container, never
    // on this disk: the path is the one inside the container.
    return made(store.createProject({
      id, name: projectName, kind: 'podman', path: CONTAINER_WORKDIR, containerName, image,
      network: input.network !== false, branchPrefix: branchPrefix(projectName), ...extra, ...link
    }));
  }

  rename(id, input) {
    // The branch namespace stays as it was: branches already pushed under it
    // keep meaning what they meant.
    return this.store().renameProject(id, input.name);
  }

  /** Name, note and permission modes: whatever the request carries, the rest untouched. */
  update(id, input = {}) {
    let project = this.store().project(id);
    if (input.name !== undefined) project = this.rename(id, input);
    if (input.notes !== undefined) project = this.store().setProjectNotes(id, input.notes);
    if (input.permissions && typeof input.permissions === 'object') {
      project = this.store().setProjectPermissions(id, { code: input.permissions.code, terminal: input.permissions.terminal });
    }
    return project;
  }

  async open(id) {
    const store = this.store();
    const project = store.project(id);
    // A section turned off runs nothing: a project opens while one of its environments is on.
    if (!projectEnvs(project).some(env => sectionEnabled(store, ENV_SECTION[env]))) fail(`La sezione ${(project.section || 'code') === 'code' ? 'Code' : 'Studio'} è spenta.`, 403);
    const key = String(id);
    const phase = name => this.opening.set(key, { phase: name, since: Date.now() });
    phase('opening');
    try {
      if (project.kind === 'local') {
        // The folder can be moved or deleted outside SynthOrg between sessions.
        // Local projects are edited on this machine, by the user's choice.
        if (!isDirectory(project.path)) fail(`La cartella del progetto non è più disponibile: ${project.path}`, 410);
        phase('git');
        const git = await this.prepareGit(project);
        return { project: store.touchProject(id), folder: project.path, container: null, runtime: { kind: 'host' }, git };
      }
      // Container projects: files, terminals, git, tasks and extensions all live
      // in the container, whose volume is /workspace. The desktop only shows
      // the editor and asks the container for what it needs.
      const container = await this.sandbox.ensureProjectContainer({
        containerName: project.container_name,
        image: project.image,
        networkEnabled: Boolean(project.network),
        onPhase: phase
      });
      const runtime = {
        kind: 'container',
        engine: container.exec,
        container: container.containerName,
        workdir: CONTAINER_WORKDIR,
        volume: container.volume
      };
      phase('git');
      const git = await this.prepareGit(project);
      this.watchChanges(project).catch(() => {});
      return { project: store.touchProject(id), folder: CONTAINER_WORKDIR, container, runtime, git };
    } finally {
      this.opening.delete(key);
    }
  }

  /**
   * A local project's saves reach the page from the editor and the page records
   * them. A container project's editor is pixels on the page and says nothing:
   * it notes each change in its container instead, and this follows the notes
   * and records a step once they stop for a moment, as the page does.
   */
  async watchChanges(project) {
    if (project.kind === 'local' || !project.container_name) return;
    const key = String(project.id);
    if (!this.watchers) this.watchers = new Map();
    if (this.watchers.has(key)) return;
    const entry = { child: null, timer: null };
    this.watchers.set(key, entry);
    const record = () => {
      entry.timer = null;
      let current = null;
      try { current = this.store().project(project.id); } catch { return; }
      this.checkpoint(current, { source: 'user' }).catch(() => {});
    };
    try {
      entry.child = await this.sandbox.followEvents(project.container_name, line => {
        if (line !== 'change') return;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(record, SAVE_QUIET_MS);
      });
    } catch { entry.child = null; }
    if (!entry.child) { this.watchers.delete(key); return; }
    entry.child.on('close', () => {
      clearTimeout(entry.timer);
      if (this.watchers.get(key) === entry) this.watchers.delete(key);
    });
  }

  stopWatching(id = null) {
    for (const [key, entry] of this.watchers || []) {
      if (id !== null && key !== String(id)) continue;
      clearTimeout(entry.timer);
      try { entry.child.kill(); } catch {}
      this.watchers.delete(key);
    }
  }

  /** A command the model ran in the project: what it changed is recorded under its name. */
  recordCommand(project, command) {
    const line = String(command || '').split(/\r?\n/)[0].trim();
    return this.checkpoint(project, { message: `$ ${line.length > 120 ? `${line.slice(0, 117)}...` : line}`, source: 'agent', tool: 'sandbox_exec' });
  }

  async remove(id) {
    const store = this.store();
    const project = store.project(id);
    this.stopWatching(id);
    clearTimeout(this.copyTimers.get(id));
    this.copyTimers.delete(id);
    this.copied.delete(id);
    this.copyState.delete(id);
    // A project in a pod is the app's from end to end, so all of it goes: the pod and its volume first — if they
    // cannot be removed the project stays in the list, never a volume left with nothing on screen that owns it —
    // then what the memory holds of it. A project in a folder is taken off the list: the folder is the user's.
    let containerRemoved = null;
    if (project.container_name) {
      const gone = await this.sandbox.removeProjectContainer(project.container_name, { volume: true });
      if (!gone.removed) fail('Il pod non può essere eliminato adesso: il motore dei container non risponde. Il progetto resta nell’elenco.', 503);
      containerRemoved = true;
    }
    const chats = store.projectConversationIds(id);
    store.deleteProject(id);
    this.forgetFiles(id);
    // Its chats went with it: their containers and their files too.
    for (const chat of chats) await Promise.resolve(this.sandbox.deleteWorkspace?.(chat)).catch(() => {});
    return { deleted: true, keptPath: project.kind === 'local' ? project.path : null, containerRemoved, chats };
  }

  /** What the memory holds of a project, besides its rows: the copy of its record, its artifacts, its typeset texts. */
  forgetFiles(id) {
    const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe) return;
    for (const dir of [path.join('pod-projects', `${safe}.git`), path.join('artifacts', safe), path.join('studio', safe.slice(0, 36))]) {
      fs.rmSync(path.join(this.dataDir, dir), { recursive: true, force: true, maxRetries: 3 });
    }
  }

  // --- running git ----------------------------------------------------------

  workdirOf(project) {
    return project.kind === 'local' ? project.path : CONTAINER_WORKDIR;
  }

  /** The branch the project was last seen on, else the repository's main one. */
  pushBranchOf(project) {
    return project.work_branch || project.default_branch || null;
  }

  /** 'full' or 'branch' for a linked project, null without a repository. */
  modeOf(project) {
    return project.repo ? (project.repo_mode === 'branch' ? 'branch' : 'full') : null;
  }

  /** The branches the user turned automatic sync on for. */
  autoOf(project) {
    try { const list = JSON.parse(project.auto_sync || '[]'); return Array.isArray(list) ? list.filter(name => typeof name === 'string') : []; }
    catch { return []; }
  }

  /** The automatic sync of a project as it is right now: running, and what stopped it last. */
  syncOf(id) {
    const entry = this.syncs.get(String(id));
    return { busy: Boolean(entry?.busy), error: entry?.error || null };
  }

  async currentBranch(project) {
    return (await this.tryGit(project, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) || null;
  }

  remoteUrl(project) {
    if (!project.repo) fail('Questo progetto non è collegato a nessuna repository GitHub.', 409);
    return `https://github.com/${project.repo}.git`;
  }

  /**
   * The user's own git identity, read once from his global configuration,
   * because his own saves should be committed as him and not as SynthOrg.
   * Our configuration deliberately ignores that file everywhere else.
   */
  hostIdentity() {
    if (this.identity) return this.identity;
    const read = key => new Promise(resolve => {
      execFile('git', ['config', '--global', '--get', key], { timeout: 5000, windowsHide: true },
        (error, stdout) => resolve(error ? '' : String(stdout).trim()));
    });
    this.identity = Promise.all([read('user.name'), read('user.email')])
      .then(([name, email]) => (name && email ? { name, email } : USER_FALLBACK))
      .catch(() => USER_FALLBACK);
    return this.identity;
  }

  /**
   * Git on the host, for a local project: in the user's own folder, with the
   * repository's own configuration and hooks kept out of the way.
   */
  hostGit(project, args, env, timeoutMs) {
    const clean = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.startsWith('GIT_') && key !== 'SSH_ASKPASS' && key !== 'SSH_AUTH_SOCK'));
    return new Promise(resolve => {
      execFile('git', args, {
        cwd: project.path, env: { ...clean, ...env }, timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024, windowsHide: true
      }, (error, stdout, stderr) => resolve({
        ok: !error,
        stdout: stdout || '',
        stderr: stderr || '',
        error: error ? (error.code === 'ENOENT' ? 'git non è installato su questo computer.' : error.message) : null
      }));
    });
  }

  /**
   * Runs git where the project's code is, and the same way in both worlds.
   *
   * Without a credential — everything that only reads or records — it runs in
   * the folder or, for a container project, inside the project's own
   * container: the working tree is right there and it costs one `exec`, which
   * is what makes a commit per save affordable.
   *
   * With a credential it runs in a throwaway container instead, because the
   * model has a shell in the project's one and a token handed to a process it
   * can look into would no longer be the server's alone. The remote is always
   * the project's repository by explicit URL, never whatever the repository's
   * own configuration calls "origin".
   */
  async runGit(project, args, { auth = false, author = null, timeoutMs = 120000 } = {}) {
    const extra = [...this.gitConfig];
    if (author) extra.push(['user.name', author.name], ['user.email', author.email]);
    let secret = null;
    if (auth) {
      secret = Buffer.from(`x-access-token:${await this.github.token()}`).toString('base64');
      extra.push(['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${secret}`]);
    }
    const workdir = this.workdirOf(project);
    let res;
    if (project.kind === 'local') {
      res = await this.hostGit(project, args, gitEnv({ workdir, nowhere: this.hostNowhere, extra }), timeoutMs);
    } else if (auth) {
      res = await this.sandbox.runGit({ volume: project.container_name, image: project.image, args, env: gitEnv({ workdir, nowhere: '/dev/null', extra }), network: true, timeoutMs });
    } else {
      res = await this.sandbox.execGit({ containerName: project.container_name, args, env: gitEnv({ workdir, nowhere: '/dev/null', extra }), timeoutMs });
    }
    return { ...res, secret };
  }

  async git(project, args, options = {}) {
    const res = await this.runGit(project, args, options);
    if (!res.ok) {
      let detail = `${res.stderr || ''}\n${res.stdout || ''}`.trim() || res.error || 'errore sconosciuto';
      if (res.secret) detail = detail.split(res.secret).join('***');
      fail(`Git ${args[0]}: ${detail.split(/\r?\n/).filter(Boolean).slice(-3).join(' ')}`, 502);
    }
    return res.stdout || '';
  }

  /** For questions git answers with an exit code: "does this ref exist?" */
  async tryGit(project, args) {
    const res = await this.runGit(project, args, { timeoutMs: 30000 });
    return res.ok ? (res.stdout || '').trim() : null;
  }

  /**
   * A question to git about a project that may not be running, without
   * starting it: in its folder, or in its container when that is up;
   * otherwise in a throwaway container on the project's volume, with no
   * network. Null when there is no answer.
   */
  async askGit(project, args) {
    let res = null;
    try { res = await this.runGit(project, args, { timeoutMs: 30000 }); } catch {}
    if (res?.ok) return res.stdout || '';
    if (project.kind === 'local') return null;
    try {
      res = await this.sandbox.runGit({
        volume: project.container_name, image: project.image, args,
        env: gitEnv({ workdir: this.workdirOf(project), nowhere: '/dev/null', extra: [] }), network: false, timeoutMs: 60000
      });
    } catch { return null; }
    return res?.ok ? (res.stdout || '') : null;
  }

  async hasRef(project, ref) {
    return Boolean(await this.tryGit(project, ['rev-parse', '--verify', '--quiet', ref]));
  }

  /** What the project's working tree holds: a repository, or nothing yet. */
  async inspect(project) {
    if (project.kind !== 'local') return this.sandbox.inspectWorkspace(project.container_name);
    let entries = [];
    try { entries = fs.readdirSync(project.path); } catch { return { repo: false, empty: true }; }
    return { repo: entries.includes('.git'), empty: entries.length === 0 };
  }

  /**
   * Makes sure the project has a repository. A linked one is cloned the first
   * time; without one git still exists, because the history is the point and
   * not the remote.
   */
  async prepareGit(project) {
    try {
      const store = this.store();
      const state = await this.inspect(project);
      if (!state.repo) {
        if (project.repo && !state.empty) {
          fail(project.kind === 'local'
            ? 'La cartella contiene file ma non è un repository: scegline una vuota, o una già clonata da questa repository.'
            : 'Il volume del progetto contiene file ma nessun repository: il codice non può essere scaricato qui.', 409);
        }
        if (project.kind !== 'local' && state.empty && this.hasCopy(project)) {
          // The pod was made anew (its disk thrown away, another computer): the project comes back from the memory.
          await this.restoreFromMemory(project);
        } else if (project.repo) {
          await this.cloneRepo(project);
        } else {
          await this.git(project, ['init', '-b', DEFAULT_LOCAL_BRANCH, this.workdirOf(project)]);
        }
      }
      const current = project;
      // A repository that has never been committed to starts its history now,
      // so there is something to come back to before anything is touched.
      let status = await this.statusOf(current);
      if (!status.born && status.changes) {
        status = await this.checkpoint(current, { message: 'Stato iniziale del progetto', source: 'user' });
      }
      // A branch set to sync on its own downloads when the project opens. GitHub
      // not answering is said in the bar and never keeps the project shut.
      if (status.auto) {
        status = await this.quietPull(current, status);
        if (status.born && status.unpushed && !status.diverged) this.scheduleAutoPush(current);
      }
      return status;
    } catch (error) {
      // Git failing must never keep the editor shut: the project opens, and
      // the git panel says what went wrong.
      return { ready: false, error: error.message };
    }
  }

  /** Where the work stands, as the interface and the rules read it. */
  async statusOf(project) {
    // The row as it is now: the caller's copy may be from before a link, a switch or a download.
    try { project = this.store().project(project.id); } catch {}
    const output = await this.git(project, ['status', '--porcelain=v2', '--branch']);
    let branch = null;
    let born = true;
    let changes = 0;
    for (const line of String(output).split(/\r?\n/)) {
      if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim();
      else if (line.startsWith('# branch.oid ')) born = !line.includes('(initial)');
      else if (line.trim() && !line.startsWith('#')) changes += 1;
    }
    if (branch === '(detached)') branch = null;
    const linked = Boolean(project.repo);
    // What the lists outside the editor show is the branch the project is on.
    if (linked && branch && project.work_branch !== branch) {
      try { project = this.store().setProjectWorkBranch(project.id, branch); } catch {}
    }
    const status = {
      ready: true,
      repo: project.repo,
      url: linked ? `https://github.com/${project.repo}` : null,
      defaultBranch: project.default_branch,
      // 'full': every branch of the repository; 'branch': this one only.
      mode: this.modeOf(project),
      pushBranch: linked ? branch : null,
      branch,
      born,
      changes,
      commits: 0,
      // Against the branch of the same name on GitHub, as last downloaded:
      // steps made here it lacks, steps it has that are not here.
      onGithub: false,
      // False until GitHub has been asked at least once: before that nothing is known of its side.
      asked: linked && Boolean(project.repo_asked_at),
      unpushed: null,
      behind: 0,
      diverged: false,
      auto: linked && Boolean(branch) && this.autoOf(project).includes(branch),
      sync: this.syncOf(project.id),
      last: null
    };
    const remote = linked && branch ? `${REMOTE_REFS}/${branch}` : null;
    if (remote && await this.hasRef(project, remote)) {
      status.onGithub = true;
      if (born) {
        const counts = await this.tryGit(project, ['rev-list', '--left-right', '--count', `${remote}...HEAD`]);
        const [behind, ahead] = (counts || '').split(/\s+/).map(Number);
        if (Number.isFinite(behind) && Number.isFinite(ahead)) {
          status.behind = behind;
          status.unpushed = ahead;
          status.diverged = behind > 0 && ahead > 0;
        }
      } else {
        const behind = await this.tryGit(project, ['rev-list', '--count', remote]);
        status.behind = Number(behind) || 0;
        status.unpushed = 0;
      }
    }
    if (!born) return status;
    const count = await this.tryGit(project, ['rev-list', '--count', 'HEAD']);
    if (count !== null) status.commits = Number(count);
    // A branch GitHub does not have yet: everything on it is still to upload.
    if (linked && branch && !status.onGithub) status.unpushed = status.commits;
    status.last = await this.lastCommit(project);
    // A pod's project whose record is not as it was when it was last copied into the memory: copied again, soon.
    this.copySoon(project, `${status.branch || ''}:${status.last?.hash || ''}:${status.commits}`);
    return status;
  }

  /** The most recent entry of the record, with where the change came from. */
  async lastCommit(project) {
    const format = ['%H', '%s', '%cI', '%an', `%(trailers:key=${SOURCE_TRAILER},valueonly,separator=%x2C)`].join('%x00');
    const line = await this.tryGit(project, ['log', '-1', `--format=${format}`]);
    if (!line) return null;
    const [hash, message, when, author, source] = line.split('\0');
    return { hash: (hash || '').slice(0, 10), message, when, author, source: SOURCES.includes(source) ? source : null };
  }

  gitStatus(id) {
    return this.statusOf(this.store().project(id));
  }

  // --- the pods' projects, copied into the memory ------------------------------------------------
  //
  // A project in a pod lives in the pod's volume, in the disk of the pods: not in the memory of the app, and gone
  // with that disk. Every change to it is already a step of its record, so the record is what is kept: after a
  // step, what the copy does not have yet is taken out of the pod as a bundle of git's — only the difference, and
  // nothing of what the project ignores — and put into a bare repository in the memory, one per project. A pod
  // that is found empty, with such a copy, is filled again from it: the disk of the pods can be thrown away.
  //
  // It runs by itself, so it has a switch of its own (the setting `pod_copy`, on unless turned off) and says how
  // it went (`memoryCopies`).

  copyDir(project) {
    return path.join(this.dataDir, 'pod-projects', `${String(project.id).replace(/[^a-zA-Z0-9_-]/g, '')}.git`);
  }

  copyOn() {
    try { return this.store().getSetting('pod_copy') !== 'off'; } catch { return true; }
  }

  /** The record has a state the copy was not made of yet: one is made soon, once for a burst of steps. */
  copySoon(project, key) {
    if (project.kind === 'local' || !key || this.copied.get(project.id) === key || !this.copyOn()) return;
    clearTimeout(this.copyTimers.get(project.id));
    const timer = setTimeout(() => {
      this.copyTimers.delete(project.id);
      this.copyToMemory(project).then(done => { if (done) this.copied.set(project.id, key); }).catch(() => {});
    }, this.copyDelayMs);
    timer.unref?.();
    this.copyTimers.set(project.id, timer);
  }

  /** Git in the pod, with what it writes out taken as bytes. */
  async podGitBytes(project, args, input = null) {
    const res = await this.sandbox.execInContainer({
      containerName: project.container_name, argv: ['git', '-c', `safe.directory=${CONTAINER_WORKDIR}`, '-C', CONTAINER_WORKDIR, ...args],
      input, timeoutMs: 300000, encoding: 'buffer'
    });
    return res;
  }

  /**
   * Brings the copy in the memory up to the pod's record: the branches and the tags as they are there. True when
   * the copy is as the pod; the reason it is not is kept for `memoryCopies`.
   */
  async copyToMemory(project) {
    if (project.kind === 'local') return false;
    const note = { at: new Date().toISOString(), error: null };
    try {
      const refsOf = text => new Map(String(text || '').split(/\r?\n/).map(line => line.trim().split(' ')).filter(parts => parts.length === 2).map(([hash, ref]) => [ref, hash]));
      const there = refsOf(await this.tryGit(project, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags']));
      if (!there.size) { this.copyState.set(project.id, { ...note, empty: true }); return false; }
      const bare = this.copyDir(project);
      const copy = { id: project.id, kind: 'local', path: bare };
      if (!fs.existsSync(path.join(bare, 'HEAD'))) {
        fs.mkdirSync(bare, { recursive: true });
        await this.git(copy, ['init', '--bare', '-b', DEFAULT_LOCAL_BRANCH, bare]);
      }
      const here = refsOf(await this.tryGit(copy, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags']));
      const missing = [...there.values()].filter(hash => !this.hasObject(bare, hash));
      if (missing.length) {
        // Only what the copy does not have: everything the pod's branches reach, less what the copy's already do.
        const have = [...new Set(here.values())];
        let bundle = await this.podGitBytes(project, ['bundle', 'create', '-', '--branches', '--tags', ...have.map(hash => `^${hash}`)]);
        // A commit of the copy that the pod no longer has (its record was rewritten): the whole of it, then.
        if (!bundle.ok && have.length) bundle = await this.podGitBytes(project, ['bundle', 'create', '-', '--branches', '--tags']);
        if (!bundle.ok) fail(`il pod non ha consegnato il suo storico: ${bundle.stderr || bundle.error}`, 502);
        const file = path.join(bare, `incoming-${randomUUID()}.bundle`);
        fs.writeFileSync(file, bundle.stdout);
        try { await this.git(copy, ['bundle', 'unbundle', file]); } finally { fs.rmSync(file, { force: true }); }
      }
      // The names, as they are in the pod: moved, added, taken away.
      for (const [ref, hash] of there) if (here.get(ref) !== hash) await this.git(copy, ['update-ref', ref, hash]);
      for (const ref of here.keys()) if (!there.has(ref)) await this.git(copy, ['update-ref', '-d', ref]);
      const branch = await this.tryGit(project, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (branch && there.has(`refs/heads/${branch.trim()}`)) await this.git(copy, ['symbolic-ref', 'HEAD', `refs/heads/${branch.trim()}`]);
      this.copyState.set(project.id, note);
      return true;
    } catch (error) {
      this.copyState.set(project.id, { ...note, error: error.message });
      return false;
    }
  }

  hasObject(bare, hash) {
    try { execFileSync('git', ['--git-dir', bare, 'cat-file', '-e', `${hash}^{commit}`], { stdio: 'ignore', windowsHide: true, timeout: 15000 }); return true; } catch { return false; }
  }

  /** Whether the memory holds a copy of the project with something in it. */
  hasCopy(project) {
    const bare = this.copyDir(project);
    if (!fs.existsSync(path.join(bare, 'HEAD'))) return false;
    try { return Boolean(String(execFileSync('git', ['--git-dir', bare, 'for-each-ref', '--count=1', 'refs/heads'], { windowsHide: true, timeout: 15000 })).trim()); } catch { return false; }
  }

  /**
   * An empty pod is given back the project from the copy in the memory: its record whole, every branch, and the
   * files of the branch it was on. The bundle goes in as a file of the pod's own disk and is removed there.
   */
  async restoreFromMemory(project) {
    const bare = this.copyDir(project);
    const copy = { id: project.id, kind: 'local', path: bare };
    const file = path.join(bare, `outgoing-${randomUUID()}.bundle`);
    let bytes;
    try { await this.git(copy, ['bundle', 'create', file, '--branches', '--tags']); bytes = fs.readFileSync(file); } finally { fs.rmSync(file, { force: true }); }
    const head = (await this.tryGit(copy, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) || DEFAULT_LOCAL_BRANCH;
    const inPod = '/tmp/synthorg-restore.bundle';
    const put = await this.sandbox.execInContainer({ containerName: project.container_name, argv: ['sh', '-c', `cat > ${inPod}`], input: bytes, timeoutMs: 300000 });
    if (!put.ok) fail(`la copia non è entrata nel pod: ${put.stderr || put.error}`, 502);
    try {
      await this.git(project, ['init', '-b', head.trim(), this.workdirOf(project)]);
      // Not a fetch: git is run with every transport but https closed, and reading a bundle that way is one.
      const heads = await this.git(project, ['bundle', 'unbundle', inPod]);
      for (const line of String(heads || '').split(/\r?\n/)) {
        const [hash, ref] = line.trim().split(' ');
        if (hash && /^refs\/(heads|tags)\//.test(ref || '')) await this.git(project, ['update-ref', ref, hash]);
      }
      await this.git(project, ['reset', '--hard']);
    } finally {
      await this.sandbox.execInContainer({ containerName: project.container_name, argv: ['rm', '-f', inPod] }).catch(() => {});
    }
  }

  /** For the settings: whether the copies are made, and each pod's project with how its last copy went. */
  memoryCopies() {
    const store = this.store();
    let projects = [];
    try { projects = store.listProjects ? store.listProjects('all') : []; } catch {}
    return {
      on: this.copyOn(),
      projects: projects.filter(project => project.kind !== 'local').map(project => {
        const state = this.copyState.get(project.id) || null;
        return { id: project.id, name: project.name, copied: this.hasCopy(project), at: state?.at || null, error: state?.error || null };
      })
    };
  }

  setMemoryCopies(on) {
    this.store().setSetting('pod_copy', on ? 'on' : 'off');
    if (!on) { for (const timer of this.copyTimers.values()) clearTimeout(timer); this.copyTimers.clear(); }
    return this.memoryCopies();
  }

  /**
   * Where the artifacts of a project are: what is worked on with the editors
   * that run at this computer — the photos and their documents, the texts —
   * and what those editors export. For a project in a folder they are files of
   * that folder like the others. For a project in a pod they are not in the
   * pod: they are kept in a folder of this computer, beside the app's own
   * data, and a file goes into the pod only when the user puts it there
   * (project-files.js, `place`).
   */
  artifactsDir(project) {
    if (project.kind === 'local') return project.path;
    const dir = path.join(this.dataDir, 'artifacts', String(project.id).replace(/[^a-zA-Z0-9_-]/g, ''));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * A step of the record of a project's artifacts. In a folder it is a step of
   * the project like any other. For a pod's project the artifacts have a record
   * of their own, in their folder: the project's own record is the pod's, and
   * these files are not in it.
   */
  async recordArtifacts(project, { message, source = 'user', tool = null } = {}) {
    if (project.kind === 'local') return this.checkpoint(project, { message, source, tool });
    if (!SOURCES.includes(source)) fail('Origine della modifica non valida.');
    const dir = this.artifactsDir(project);
    // Only what git needs to work in that folder: not the project's row, which is the pod's.
    const folder = { id: project.id, kind: 'local', path: dir };
    if (!fs.existsSync(path.join(dir, '.git', 'HEAD'))) await this.git(folder, ['init', '-b', DEFAULT_LOCAL_BRANCH, dir]);
    const porcelain = await this.git(folder, ['status', '--porcelain', '--untracked-files=all']);
    if (!porcelain.trim()) return null;
    const author = source === 'agent' ? AGENT_AUTHOR : await this.hostIdentity();
    const title = typeof message === 'string' && message.trim() ? message.trim().slice(0, 500).split(/\r?\n/)[0] : describeChanges(porcelain);
    const trailers = [`${SOURCE_TRAILER}: ${source}`];
    if (typeof tool === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(tool)) trailers.push(`${TOOL_TRAILER}: ${tool}`);
    await this.git(folder, ['add', '--all']);
    await this.git(folder, ['commit', '--no-verify', '-m', title, '-m', trailers.join('\n')], { author });
    // The page reads a step's answer as the state of the project's record: this one is not it.
    return null;
  }

  /**
   * The project as a zip: the files of its last recorded step, as git packs
   * them (what the project ignores is left out, and so is the history). Git
   * writes the archive beside its own files, where nothing of the project is;
   * it is read from there and removed.
   */
  async archive(id) {
    const project = this.store().project(id);
    if (!(await this.tryGit(project, ['rev-parse', '--verify', '--quiet', 'HEAD']))) fail('Il progetto non ha ancora nulla di registrato da esportare.', 409);
    const name = `synthorg-archive-${randomUUID()}.zip`;
    const made = await this.runGit(project, ['archive', '--format=zip', '-o', `.git/${name}`, 'HEAD'], { timeoutMs: 300000 });
    let bytes = null;
    try {
      if (!made.ok) fail(`Archivio non creato: ${made.stderr || made.error}`, 502);
      if (project.kind === 'local') bytes = fs.readFileSync(path.join(project.path, '.git', name));
      else {
        const read = await this.sandbox.execInContainer({ containerName: project.container_name, argv: ['cat', `${CONTAINER_WORKDIR}/.git/${name}`], timeoutMs: 300000, encoding: 'buffer' });
        if (!read.ok) fail(`Archivio non letto: ${read.stderr || read.error}`, 502);
        bytes = read.stdout;
      }
    } finally {
      if (project.kind === 'local') fs.rmSync(path.join(project.path, '.git', name), { force: true });
      else await this.sandbox.execInContainer({ containerName: project.container_name, argv: ['rm', '-f', `${CONTAINER_WORKDIR}/.git/${name}`] }).catch(() => {});
    }
    return { bytes, name: `${String(project.name || 'progetto').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'progetto'}.zip` };
  }

  /**
   * The recorder. Everything that changed is committed as it stands, on the
   * branch the project is already on: no staging to decide, no branch to
   * create, nothing duplicated. It runs after a save and after every tool call
   * a model makes, which is what keeps the code and its history in step.
   *
   * Nothing to commit is not a failure: it is the normal answer when a save
   * rewrote a file with the same bytes.
   */
  async checkpoint(project, { message, source = 'user', tool = null } = {}) {
    if (!SOURCES.includes(source)) fail('Origine della modifica non valida.');
    // Every new file by name, not a new folder as one line: the title is made of them.
    const porcelain = await this.git(project, ['status', '--porcelain', '--untracked-files=all']);
    if (!porcelain.trim()) return this.statusOf(project);
    const author = source === 'agent' ? AGENT_AUTHOR : await this.hostIdentity();
    const title = typeof message === 'string' && message.trim()
      ? message.trim().slice(0, 500).split(/\r?\n/)[0]
      : describeChanges(porcelain);
    const trailers = [`${SOURCE_TRAILER}: ${source}`];
    if (typeof tool === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(tool)) trailers.push(`${TOOL_TRAILER}: ${tool}`);
    // `--no-verify` is belt and braces: the hooks path already points nowhere.
    await this.git(project, ['add', '--all']);
    await this.git(project, ['commit', '--no-verify', '-m', title, '-m', trailers.join('\n')], { author });
    await this.recordSteps(project, 20);
    if (project.repo && project.auto_sync) this.scheduleAutoPush(project);
    return this.statusOf(project);
  }

  /**
   * The project's latest steps copied into the activity record, which the
   * agenda reads progress from. Done where git can be reached anyway — after
   * a step, when the history is read — because a container project that is
   * off cannot be asked. Never a reason to fail.
   */
  async recordSteps(project, count = 500) {
    try {
      const args = ['log', `--format=%x1e${HISTORY_FORMAT}`, '--numstat', `--max-count=${count}`];
      let res = await this.runGit(project, args, { timeoutMs: 60000 });
      // A container project that is off cannot be asked: its history is read
      // from its volume by a container made for this and thrown away, without
      // network. The project's own container is not started.
      if (!res.ok && project.kind !== 'local') {
        res = await this.sandbox.runGit({ volume: project.container_name, image: project.image, args, env: gitEnv({ workdir: this.workdirOf(project), nowhere: '/dev/null', extra: [] }), network: false, timeoutMs: 120000 });
      }
      if (!res.ok) return 0;
      const commits = (res.stdout || '').split('\x1e').filter(chunk => chunk.trim()).map(parseHistoryEntry);
      return this.store().personal().recordSteps(project.id, commits);
    } catch {
      return 0;
    }
  }

  /**
   * What a project is made of: its most common languages and its size, from
   * the names of the files its history holds. It is what is said of a project
   * when the user shares the numbers of the models: no name, no path.
   * Worked out once an hour at most.
   */
  async profile(project) {
    this.profiles = this.profiles || new Map();
    const known = this.profiles.get(project.id);
    if (known && Date.now() - known.at < 3600000) return known.profile;
    const args = ['ls-files'];
    let res = await this.runGit(project, args, { timeoutMs: 60000 });
    if (!res.ok && project.kind !== 'local') {
      res = await this.sandbox.runGit({ volume: project.container_name, image: project.image, args, env: gitEnv({ workdir: this.workdirOf(project), nowhere: '/dev/null', extra: [] }), network: false, timeoutMs: 120000 });
    }
    if (!res.ok) fail('Il progetto non si può leggere.', 502);
    const profile = profileOf((res.stdout || '').split(/\r?\n/).filter(Boolean));
    this.profiles.set(project.id, { at: Date.now(), profile });
    return profile;
  }

  /**
   * The steps a model made that a restore takes back: the turns they came
   * from are marked as taken back, which is what says how a model did.
   * Never a reason to fail.
   */
  async markReverted(project, hash, file = null) {
    try {
      const args = ['log', `--format=%cI%x00%(trailers:key=${SOURCE_TRAILER},valueonly,separator=%x2C)`, `${hash}..HEAD`];
      if (file !== null) args.push('--', file);
      const out = await this.tryGit(project, args);
      const moments = String(out || '').split(/\r?\n/).map(line => line.split('\0')).filter(([, source]) => source === 'agent').map(([when]) => when);
      if (moments.length) this.store().usage().markReverted(project.id, moments);
    } catch {}
  }

  /**
   * The local projects' steps brought up to date: their git is always there
   * to ask. Every step made through the app is recorded as it is made; this
   * is for what was done to the folder by other means, so it looks at most
   * once every few minutes, and reads the history only when its head moved.
   */
  async recordLocalSteps() {
    this.stepsSeen = this.stepsSeen || new Map();
    for (const project of this.store().listProjects('all')) {
      if (project.kind !== 'local') continue;
      const seen = this.stepsSeen.get(project.id);
      if (seen && Date.now() - seen.at < STEPS_LOOK_MS) continue;
      const head = await this.tryGit(project, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      if (head && head !== seen?.head) await this.recordSteps(project, 5000);
      this.stepsSeen.set(project.id, { head, at: Date.now() });
    }
  }

  /**
   * The container projects' steps, read once for each while the service is
   * up: from then on every step is recorded as it is made. It runs in the
   * background, one project after the other; true while it is under way.
   */
  recordContainerSteps() {
    this.stepsRead = this.stepsRead || new Set();
    const todo = this.store().listProjects('all').filter(p => p.kind !== 'local' && !this.stepsRead.has(p.id));
    if (!todo.length) return Boolean(this.stepsReading);
    todo.forEach(p => this.stepsRead.add(p.id));
    this.stepsReading = (this.stepsReading || Promise.resolve()).then(async () => {
      for (const project of todo) await this.recordSteps(project, 5000);
    }).catch(() => {}).finally(() => { this.stepsReading = null; });
    return true;
  }

  // --- the history, as a place to look at -------------------------------------
  //
  // Every save and every change a model makes is already a commit: this is the
  // other half, the record read back like a repository page — the list of
  // steps, what each one changed, the project as it was at any of them, a file
  // through time — and any file or the whole project taken back to a step.
  // Going back is itself a step: nothing is ever rewritten or lost.

  /** The steps, newest first; with `path`, only those that touched that file (across renames). */
  async history(id, { limit = 100, skip = 0, path: file = null } = {}) {
    const project = this.store().project(id);
    limit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    skip = Math.max(Number(skip) || 0, 0);
    if (!await this.hasRef(project, 'HEAD')) return { commits: [], more: false, github: null };
    const args = ['log', `--format=%x1e${HISTORY_FORMAT}`, '--numstat', `--max-count=${limit + 1}`, `--skip=${skip}`];
    if (file !== null) args.push('--follow', '--', historyPath(file));
    const out = await this.git(project, args, { timeoutMs: 60000 });
    const commits = out.split('\x1e').filter(chunk => chunk.trim()).map(parseHistoryEntry);
    // The steps just read are activity too: kept for when git cannot be asked.
    if (file === null) { try { this.store().personal().recordSteps(project.id, commits); } catch {} }
    const more = commits.length > limit;
    commits.length = Math.min(commits.length, limit);
    // With a repository, which steps GitHub already has: the same list, one place.
    let github = null;
    if (project.repo) {
      const pushed = new Set(((await this.tryGit(project, ['rev-list', '--max-count=5000', '--remotes=origin'])) || '').split(/\s+/).filter(Boolean));
      for (const commit of commits) commit.onGithub = pushed.has(commit.hash);
      github = { repo: project.repo, branch: (await this.currentBranch(project)) || this.pushBranchOf(project) };
    }
    return { commits, more, github };
  }

  /** One step: who, when, and each file it changed with its diff. */
  async historyCommit(id, hash) {
    const project = this.store().project(id);
    hash = historyHash(hash);
    const head = await this.git(project, ['log', '-1', `--format=${HISTORY_FORMAT}%x00%b`, hash]);
    const commit = parseHistoryEntry(head.replace(/\n+$/, ''));
    const parent = commit.parents[0] || EMPTY_TREE;
    const names = await this.git(project, ['diff', '--name-status', '-z', '-M', parent, hash]);
    const files = parseNameStatus(names);
    let patch = null;
    const res = await this.runGit(project, ['diff', '-M', '--no-color', '--no-ext-diff', '--unified=3', parent, hash], { timeoutMs: 60000 });
    if (res.ok) patch = res.stdout || '';
    const sections = patch === null ? [] : splitPatch(patch);
    files.forEach((entry, index) => Object.assign(entry, sections[index] || { binary: false, hunks: '', additions: 0, deletions: 0, truncated: patch === null }));
    return { ...commit, files, tooLarge: patch === null };
  }

  /** Every file of the project as it was at that step. */
  async historyTree(id, hash) {
    const project = this.store().project(id);
    hash = historyHash(hash);
    const out = await this.git(project, ['ls-tree', '-r', '-z', '--name-only', hash]);
    const files = out.split('\0').filter(Boolean);
    return { hash, files: files.slice(0, 20000), truncated: files.length > 20000 };
  }

  /** One file as it was at that step. Large or binary files say so instead of coming whole. */
  async historyFile(id, hash, file) {
    const project = this.store().project(id);
    hash = historyHash(hash);
    const at = `${hash}:${historyPath(file)}`;
    const size = Number(await this.tryGit(project, ['cat-file', '-s', at]));
    if (!Number.isFinite(size) || await this.tryGit(project, ['cat-file', '-t', at]) !== 'blob') fail('Il file non esiste in questa versione.', 404);
    if (size > HISTORY_FILE_MAX) return { hash, path: file, size, tooLarge: true, binary: false, content: null };
    const content = await this.git(project, ['show', at]);
    const binary = content.slice(0, 8000).includes('\0');
    return { hash, path: file, size, tooLarge: false, binary, content: binary ? null : content };
  }

  /**
   * Takes a file, or the whole project, back to how it was at a step. What is
   * there now is recorded first, and the restore is recorded after it: two
   * ordinary steps, so it can itself be undone the same way.
   */
  async restore(id, { hash, path: file = null } = {}) {
    const project = this.store().project(id);
    hash = historyHash(hash);
    if (!await this.hasRef(project, `${hash}^{commit}`)) fail('Versione non trovata nello storico.', 404);
    const short = hash.slice(0, 7);
    await this.checkpoint(project, { message: 'Modifiche prima del ripristino', source: 'user' });
    await this.markReverted(project, hash, file === null ? null : historyPath(file));
    if (file !== null) {
      const target = historyPath(file);
      if (await this.tryGit(project, ['cat-file', '-t', `${hash}:${target}`]) !== null) {
        await this.git(project, ['restore', `--source=${hash}`, '--staged', '--worktree', '--', target]);
      } else {
        // Not there yet at that step: taking it back there means taking it away.
        await this.git(project, ['rm', '-r', '-q', '--ignore-unmatch', '--', target]);
      }
      return this.checkpoint(project, { message: `Ripristinato ${target} alla versione ${short}`, source: 'user', tool: 'restore' });
    }
    await this.git(project, ['restore', `--source=${hash}`, '--staged', '--worktree', '--', ':/']);
    return this.checkpoint(project, { message: `Progetto riportato alla versione ${short}`, source: 'user', tool: 'restore' });
  }


  /**
   * Every git operation the app can perform, with the caller it belongs to.
   * `actor` is 'user' when the request comes from the user and 'agent' when it
   * comes from a model working on the project.
   */
  async gitAction(id, action, input = {}, actor = 'user') {
    const store = this.store();
    const rule = Object.prototype.hasOwnProperty.call(GIT_ACTIONS, action) ? GIT_ACTIONS[action] : null;
    if (!rule) fail('Operazione git non trovata.', 404);
    if (!rule.actors.includes(actor)) fail(`Il modello non può eseguire "${action}": è un'operazione che decidi tu.`, 403);
    const project = store.project(id);

    if (action === 'checkpoint') {
      return this.checkpoint(project, { message: input.message, source: actor, tool: input.tool });
    }

    if (action === 'link') {
      const repo = await this.resolveRepo(input.repo);
      if (!repo) fail('Scegli una repository da collegare.');
      const choice = this.repoChoice(repo, input.mode, input.branch);
      const linked = store.setProjectRepo(id, { repo: repo.full_name, defaultBranch: repo.default_branch, mode: choice.repoMode, branch: choice.repoBranch });
      await this.alignRepo(linked);
      return this.statusOf(store.project(id));
    }

    if (action === 'unlink') {
      // The code and its history stay exactly where they are.
      this.dropSync(id);
      return this.statusOf(store.setProjectRepo(id, { repo: null }));
    }

    this.remoteUrl(project);
    if (action === 'branches') return this.branchList(project, { fetch: Boolean(input.fetch) });
    if (action === 'switch') return this.switchBranch(project, input.branch);
    if (action === 'new-branch') return this.newBranch(project, input.name);
    if (action === 'pull') return this.pull(project);
    if (action === 'resolve') return this.resolve(project, input);
    if (action === 'sync') return this.setAutoSync(project, input);
    return this.push(project, { message: input.message });
  }

  // --- GitHub: the branch here and the branch there -------------------------

  /**
   * Brings what GitHub has into the remote-tracking refs, touching nothing
   * else. One branch, or — for a project that follows the whole repository —
   * all of them, forgetting the ones deleted there. False when the one branch
   * asked for is not on GitHub.
   */
  async fetchRemote(project, branch = null, { timeoutMs = NETWORK_TIMEOUT_MS } = {}) {
    const url = this.remoteUrl(project);
    const asked = () => { try { this.store().noteProjectRepoAsked(project.id); } catch {} };
    if (!branch) {
      await this.git(project, ['fetch', '--no-tags', '--prune', url, `+refs/heads/*:${REMOTE_REFS}/*`], { auth: true, timeoutMs });
      asked();
      return true;
    }
    const res = await this.runGit(project, ['fetch', '--no-tags', url, `+refs/heads/${branch}:${REMOTE_REFS}/${branch}`], { auth: true, timeoutMs });
    if (res.ok) { asked(); return true; }
    const detail = `${res.stderr || ''}${res.stdout || ''}`;
    if (/couldn't find remote ref|could not find remote ref/i.test(detail)) {
      // Not there (any more): what was remembered of it is forgotten too.
      await this.tryGit(project, ['update-ref', '-d', `${REMOTE_REFS}/${branch}`]);
      asked();
      return false;
    }
    fail(`Git fetch: ${this.gitDetail(res)}`, 502);
  }

  gitDetail(res) {
    let detail = `${res.stderr || ''}\n${res.stdout || ''}`.trim() || res.error || 'errore sconosciuto';
    if (res.secret) detail = detail.split(res.secret).join('***');
    return detail.split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
  }

  /**
   * The first download of a linked project. The whole repository, or one
   * branch of it alone; a branch GitHub does not have yet starts from the
   * repository's main one, under its own name.
   */
  async cloneRepo(project) {
    const url = this.remoteUrl(project);
    const dir = this.workdirOf(project);
    const options = { auth: true, timeoutMs: 15 * 60 * 1000 };
    const wanted = this.modeOf(project) === 'branch' ? (project.repo_branch || project.default_branch) : null;
    const names = await this.github.listBranches(project.repo);
    try { this.store().noteProjectRepoAsked(project.id); } catch {}
    if (!names.length) {
      // A repository with nothing in it yet: the history starts here.
      await this.git(project, ['init', '-b', wanted || project.default_branch || DEFAULT_LOCAL_BRANCH, dir]);
      return;
    }
    if (!wanted) {
      await this.git(project, ['clone', '--origin', 'origin', url, dir], options);
      return;
    }
    const from = names.includes(wanted) ? wanted : (names.includes(project.default_branch) ? project.default_branch : names[0]);
    await this.git(project, ['clone', '--origin', 'origin', '--single-branch', '--branch', from, url, dir], options);
    if (from !== wanted) {
      await this.git(project, ['branch', '-m', from, wanted]);
      await this.tryGit(project, ['update-ref', '-d', `${REMOTE_REFS}/${from}`]);
    }
  }

  /**
   * A repository linked to a project that already has its own history, or the
   * way it is followed changed. Nothing of the work here is ever replaced:
   *  - the whole repository: its branches are downloaded, the project stays
   *    where it is;
   *  - one branch: the project moves to it. When the history here has nothing
   *    in common with it, the branch here takes its name instead and the two
   *    show as different, for the user to decide.
   */
  async alignRepo(project) {
    if (!(await this.inspect(project)).repo) return;
    await this.checkpoint(project, { source: 'user' });
    const born = await this.hasRef(project, 'HEAD');
    const current = await this.currentBranch(project);
    if (this.modeOf(project) === 'full') {
      await this.fetchRemote(project);
      const main = project.default_branch;
      if (!born && main && await this.hasRef(project, `${REMOTE_REFS}/${main}`)) {
        await this.git(project, ['switch', '-C', main, '--no-track', `${REMOTE_REFS}/${main}`]);
      }
      return;
    }
    const branch = project.repo_branch;
    const remote = `${REMOTE_REFS}/${branch}`;
    const found = await this.fetchRemote(project, branch);
    if (!born) {
      if (found) await this.git(project, ['switch', '-C', branch, '--no-track', remote]);
      else await this.git(project, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      return;
    }
    if (current === branch) return;
    if (await this.hasRef(project, `refs/heads/${branch}`)) {
      await this.git(project, ['switch', branch]);
    } else if (!found) {
      // New on both sides: it starts from where the project is.
      await this.git(project, ['switch', '-c', branch]);
    } else if (current && await this.tryGit(project, ['merge-base', 'HEAD', remote]) === null) {
      await this.git(project, ['branch', '-m', current, branch]);
    } else {
      await this.git(project, ['switch', '-c', branch, '--no-track', remote]);
    }
  }

  /**
   * The branches to move between. A project that follows one branch lists
   * that one; one that follows the repository lists every branch, here or on
   * GitHub, the main one first. What GitHub has is what was last downloaded,
   * unless `fetch` asks it again.
   */
  async branchList(project, { fetch = false } = {}) {
    const mode = this.modeOf(project);
    if (fetch) await this.fetchRemote(project, mode === 'full' ? null : (await this.currentBranch(project)) || project.repo_branch);
    const current = await this.currentBranch(project);
    const out = await this.tryGit(project, ['for-each-ref', '--format=%(refname)', 'refs/heads', REMOTE_REFS]) || '';
    const local = new Set();
    const remote = new Set();
    for (const ref of out.split(/\r?\n/)) {
      if (ref.startsWith('refs/heads/')) local.add(ref.slice('refs/heads/'.length));
      else if (ref.startsWith(`${REMOTE_REFS}/`) && ref !== `${REMOTE_REFS}/HEAD`) remote.add(ref.slice(REMOTE_REFS.length + 1));
    }
    if (current) local.add(current);
    const main = project.default_branch;
    const auto = this.autoOf(project);
    const names = mode === 'full' ? [...new Set([...local, ...remote])] : (current ? [current] : []);
    names.sort((a, b) => (b === main) - (a === main) || a.localeCompare(b));
    const branches = [];
    for (const name of names) {
      const entry = { name, current: name === current, main: name === main, local: local.has(name), onGithub: remote.has(name), auto: auto.includes(name), unpushed: null, behind: null };
      if (entry.local && entry.onGithub && branches.length < BRANCH_COUNT_LIMIT) {
        const counts = await this.tryGit(project, ['rev-list', '--left-right', '--count', `${REMOTE_REFS}/${name}...refs/heads/${name}`]);
        const [behind, ahead] = (counts || '').split(/\s+/).map(Number);
        if (Number.isFinite(behind) && Number.isFinite(ahead)) { entry.behind = behind; entry.unpushed = ahead; }
      }
      branches.push(entry);
    }
    return { mode, current, defaultBranch: main, branches };
  }

  /** Only a project that follows the whole repository has branches to move between. */
  requireFull(project) {
    if (this.modeOf(project) !== 'full') fail('Questo progetto segue un solo ramo: per averli tutti collega la repository intera.', 409);
  }

  /** Download for a branch that syncs on its own: a failure is noted for the bar, never thrown. */
  async quietPull(project, status) {
    try {
      const pulled = await this.pull(project, { timeoutMs: 45000 });
      this.noteSync(project.id, null);
      return { ...pulled, sync: this.syncOf(project.id) };
    } catch (error) {
      this.noteSync(project.id, error.message);
      return { ...status, sync: this.syncOf(project.id) };
    }
  }

  /** Moves the project to another branch. What is in the editor is recorded first, on the branch it was made on. */
  async switchBranch(project, value) {
    this.requireFull(project);
    const name = pushBranchName(value);
    await this.checkpoint(project, { source: 'user' });
    if (await this.currentBranch(project) !== name) {
      if (await this.hasRef(project, `refs/heads/${name}`)) await this.git(project, ['switch', name]);
      else if (await this.hasRef(project, `${REMOTE_REFS}/${name}`)) await this.git(project, ['switch', '-c', name, '--no-track', `${REMOTE_REFS}/${name}`]);
      else fail(`Il ramo "${name}" non esiste.`, 404);
    }
    const status = await this.statusOf(project);
    return status.auto ? this.quietPull(project, status) : status;
  }

  /** A new branch from where the project is. It exists here; GitHub gets it with the first upload. */
  async newBranch(project, value) {
    this.requireFull(project);
    const name = pushBranchName(value);
    if (await this.hasRef(project, `refs/heads/${name}`) || await this.hasRef(project, `${REMOTE_REFS}/${name}`)) fail(`Il ramo "${name}" esiste già.`, 409);
    await this.checkpoint(project, { source: 'user' });
    await this.git(project, ['switch', '-c', name]);
    return this.statusOf(project);
  }

  /**
   * Download: the steps GitHub has on this branch and the project has not.
   * They are added only when nothing made here would be left aside; when both
   * sides have steps of their own nothing moves, and the status says so
   * (`diverged`) for the user to choose.
   */
  async pull(project, { timeoutMs = NETWORK_TIMEOUT_MS } = {}) {
    let status = await this.checkpoint(project, { source: 'user' });
    if (!status.branch) fail('Il progetto non è su nessun ramo.', 409);
    await this.fetchRemote(project, this.modeOf(project) === 'full' ? null : status.branch, { timeoutMs });
    status = await this.statusOf(project);
    if (!status.onGithub || !status.behind || status.unpushed) return { ...status, pulled: 0 };
    const remote = `${REMOTE_REFS}/${status.branch}`;
    // A project with no step of its own yet simply becomes what GitHub has.
    if (status.born) await this.git(project, ['merge', '--ff-only', remote]);
    else await this.git(project, ['reset', '--hard', remote]);
    await this.recordSteps(project, 100);
    return { ...(await this.statusOf(project)), pulled: status.behind };
  }

  /**
   * Upload: the steps of this branch to the branch of the same name on
   * GitHub, created there if it is new. Never forced: when GitHub has steps
   * that are not here it refuses, and the status says so (`rejected`).
   */
  async push(project, { message = null, record = true } = {}) {
    const url = this.remoteUrl(project);
    const status = record ? await this.checkpoint(project, { message, source: 'user' }) : await this.statusOf(project);
    if (!status.born) fail('Non c’è ancora niente da caricare: il progetto non ha nessun passo.', 409);
    const branch = status.branch;
    if (!branch) fail('Il progetto non è su nessun ramo.', 409);
    // The step uploaded is named, so one recorded meanwhile is not taken for uploaded.
    const head = await this.tryGit(project, ['rev-parse', '--verify', 'HEAD']);
    if (!head) fail('Non c’è ancora niente da caricare: il progetto non ha nessun passo.', 409);
    const pushed = await this.runGit(project, ['push', url, `${head}:refs/heads/${branch}`], { auth: true, timeoutMs: NETWORK_TIMEOUT_MS });
    if (!pushed.ok) {
      const detail = `${pushed.stderr || ''}${pushed.stdout || ''}`;
      if (!/non-fast-forward|fetch first|rejected/i.test(detail)) fail(`Git push: ${this.gitDetail(pushed)}`, 502);
      await this.fetchRemote(project, branch);
      return { ...(await this.statusOf(project)), pushed: null, rejected: true };
    }
    await this.git(project, ['update-ref', `${REMOTE_REFS}/${branch}`, head]);
    return { ...(await this.statusOf(project)), pushed: { branch, url: `https://github.com/${project.repo}/tree/${branch}` } };
  }

  /**
   * The user's answer when the branch here and on GitHub both have steps of
   * their own.
   *  - `github`: the branch becomes what GitHub has. The steps made here leave
   *    the branch and stay in the repository, under refs/synthorg/kept.
   *  - `branch`: the work here goes on under a new name, and the branch goes
   *    back to what GitHub has. A project that follows one branch follows the
   *    new one from then on.
   */
  async resolve(project, input = {}) {
    const store = this.store();
    let status = await this.checkpoint(project, { source: 'user' });
    const branch = status.branch;
    if (!branch) fail('Il progetto non è su nessun ramo.', 409);
    await this.fetchRemote(project, branch);
    status = await this.statusOf(project);
    if (!status.diverged) return status;
    const remote = `${REMOTE_REFS}/${branch}`;
    if (input.keep === 'github') {
      await this.git(project, ['update-ref', `${KEPT_REFS}/${branch}/${Date.now()}`, 'HEAD']);
      await this.git(project, ['reset', '--hard', remote]);
      await this.recordSteps(project, 100);
      return this.statusOf(project);
    }
    if (input.keep !== 'branch') fail('Scelta non valida.');
    const name = pushBranchName(input.name);
    const taken = await this.hasRef(project, `refs/heads/${name}`) || await this.hasRef(project, `${REMOTE_REFS}/${name}`)
      || (await this.github.listBranches(project.repo)).includes(name);
    if (taken) fail(`Il ramo "${name}" esiste già: scegli un altro nome.`, 409);
    await this.git(project, ['branch', '-m', branch, name]);
    if (this.modeOf(project) === 'full') await this.git(project, ['branch', '--no-track', branch, remote]);
    else store.setProjectRepoBranch(project.id, name);
    return this.statusOf(store.project(project.id));
  }

  // --- automatic sync: one switch per branch, off unless the user turns it on

  async setAutoSync(project, input = {}) {
    const store = this.store();
    const branch = input.branch ? pushBranchName(input.branch) : await this.currentBranch(project);
    if (!branch) fail('Il progetto non è su nessun ramo.', 409);
    const list = this.autoOf(project).filter(name => name !== branch);
    if (input.auto) list.push(branch);
    project = store.setProjectAutoSync(project.id, list);
    this.noteSync(project.id, null);
    let status = await this.statusOf(project);
    if (!input.auto || status.branch !== branch) return status;
    // Turned on for the branch in the editor: it is brought in step now, not at the next save.
    status = await this.quietPull(project, status);
    if (status.sync.error || !status.born || !status.unpushed || status.diverged) return status;
    try { return await this.push(project, { record: false }); }
    catch (error) { this.noteSync(project.id, error.message); return this.statusOf(project); }
  }

  syncEntry(id) {
    const key = String(id);
    let entry = this.syncs.get(key);
    if (!entry) { entry = { timer: null, busy: false, again: false, error: null }; this.syncs.set(key, entry); }
    return entry;
  }

  noteSync(id, error) {
    this.syncEntry(id).error = error || null;
  }

  dropSync(id) {
    const entry = this.syncs.get(String(id));
    if (entry) clearTimeout(entry.timer);
    this.syncs.delete(String(id));
  }

  /** After a recorded step: the upload of a branch that syncs on its own, once the steps stop for a moment. */
  scheduleAutoPush(project) {
    const entry = this.syncEntry(project.id);
    if (entry.busy) { entry.again = true; return; }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { void this.runAutoPush(String(project.id)); }, AUTO_PUSH_QUIET_MS);
    entry.timer.unref?.();
  }

  async runAutoPush(key) {
    const entry = this.syncs.get(key);
    if (!entry || entry.busy) return;
    let project;
    try { project = this.store().project(key); } catch { this.dropSync(key); return; }
    if (!project.repo) return;
    entry.busy = true;
    entry.again = false;
    try {
      const branch = await this.currentBranch(project);
      // Refused (GitHub has steps that are not here) is not an error: the
      // status shows the two as different, and nothing is retried on its own.
      if (branch && this.autoOf(project).includes(branch)) await this.push(project, { record: false });
      entry.error = null;
    } catch (error) {
      entry.error = error.message;
    } finally {
      entry.busy = false;
      if (entry.again && this.syncs.get(key) === entry) this.scheduleAutoPush(project);
    }
  }

  /** Nothing of the automatic sync is left waiting: for when the server closes. */
  stopSyncs() {
    for (const entry of this.syncs.values()) clearTimeout(entry.timer);
    this.syncs.clear();
  }
}

module.exports = {
  ProjectManager, containerSlug, branchPrefix, pushBranchName, describeChanges,
  GIT_ACTIONS, REPO_MODES, KINDS, CONTAINER_WORKDIR, DEFAULT_BRANCH_PREFIX, SOURCE_TRAILER
};
