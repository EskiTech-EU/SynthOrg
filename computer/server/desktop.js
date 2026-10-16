'use strict';

/*
 * Computer use: a desktop the model works on, in a container of its own.
 *
 * Each chat that has it switched on in its environment gets one container,
 * `synthorg-desk-<chat>`, from the desktop image: an X server with no screen
 * (Xvfb), the accessibility bus (AT-SPI), a small window manager and the apps.
 * It mounts the same files the chat's terminal sees (the chat's workspace, or
 * the Code project's volume) and has the network only when the chat does.
 *
 * Nothing runs there without the user: a session starts as a request with its
 * goal, and only the user's answer to that request (the card in the chat)
 * starts the desktop. No setting skips the question. The model then acts
 * through the session, and what comes back out of the container is the text
 * of the accessibility tree and pictures of the screen, never a file.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  detectEngine, runExec, runInContainer, copyIntoContainer, inspectContainer, removeContainer,
  ensureBaseImage, hardenedRunArgs, PACKAGE_CACHE_MOUNTS, getWorkspaceDir, ensureNetwork, ensureSeccompProfile,
  toContainerMountPath, normalizeImage
} = require('./sandbox');

const DESKTOP_DIR = '/opt/synthorg-desktop';
const DESKTOP_IMAGE_REPO = 'localhost/synthorg-desktop';
const DESKTOP_CONTAINER_PREFIX = 'synthorg-desk-';
const SOURCES = {
  driver: path.join(__dirname, 'desktop', 'driver.py'),
  policies: path.join(__dirname, 'desktop', 'firefox-policies.json')
};

// The desktop itself, then the apps the model can open. An app added here is
// found by the model on its own: the driver lists every installed .desktop.
const DESKTOP_PACKAGES = ['xvfb', 'dbus', 'at-spi2-core', 'py3-gobject3', 'py3-atspi', 'xdotool', 'openbox', 'font-dejavu', 'adwaita-icon-theme'];
const DESKTOP_APPS = ['firefox', 'mousepad', 'thunar'];

const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const WAIT_FOR_ANSWER_MS = 10 * 60 * 1000;
const SCREEN_MIN_INTERVAL_MS = 250;
// What the model may ask the desktop. `start` and `quit` belong to the session.
const ACTIONS = new Set(['tree', 'apps', 'open', 'click', 'click_at', 'type', 'key', 'scroll', 'wait', 'screenshot', 'inspect']);

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function sanitizeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

/** Changes whenever what goes into the image changes, so an old image is never used for a new driver. */
function desktopStamp() {
  const hash = crypto.createHash('sha256');
  hash.update([...DESKTOP_PACKAGES, ...DESKTOP_APPS].join(' '));
  for (const file of Object.values(SOURCES)) hash.update(fs.readFileSync(file));
  return hash.digest('hex').slice(0, 10);
}

function desktopImageRef(baseImage) {
  const key = normalizeImage(baseImage).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
  return `${DESKTOP_IMAGE_REPO}:${key}-${desktopStamp()}`;
}

/**
 * The desktop image for this SynthOrg build, made the first time it is needed:
 * our Alpine base, the desktop packages and the apps, installed by a throwaway
 * container with network and committed. The containers built from it need no
 * network to have their apps.
 */
async function ensureDesktopImage(engineInfo, baseImages, onPhase = () => {}) {
  const base = engineInfo.baseArgs || [];
  const baseImage = await ensureBaseImage(engineInfo, baseImages);
  const ref = desktopImageRef(baseImage);
  if ((await runExec(engineInfo.bin, [...base, 'image', 'exists', ref], 10000)).ok) return ref;
  onPhase('image');
  const name = `synthorg-desktop-build-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const run = await runExec(engineInfo.bin, [...base, ...hardenedRunArgs({
      name, network: await ensureNetwork(engineInfo, 'build', true), image: baseImage, mounts: PACKAGE_CACHE_MOUNTS, memory: '1g', cpus: '2.0', pids: 512, workdir: '/', seccomp: await ensureSeccompProfile(engineInfo)
    })], 60000);
    if (!run.ok) throw new Error(`Impossibile avviare il container per preparare il desktop: ${run.stderr || run.error}`);
    const install = await runInContainer(engineInfo, name, [
      'mkdir -p /etc/apk/cache',
      `apk add ${[...DESKTOP_PACKAGES, ...DESKTOP_APPS].join(' ')}`,
      `mkdir -p ${DESKTOP_DIR} /usr/lib/firefox/distribution`
    ].join(' && '), BUILD_TIMEOUT_MS, '/');
    if (!install.ok) throw new Error(`Pacchetti del desktop non installabili: ${(install.stderr || install.stdout || install.error || '').trim().split(/\r?\n/).slice(-2).join(' ')}`);
    for (const [file, dir, as] of [[SOURCES.driver, DESKTOP_DIR, 'driver.py'], [SOURCES.policies, '/usr/lib/firefox/distribution', 'policies.json']]) {
      const copy = await copyIntoContainer(engineInfo, file, name, dir, as);
      if (!copy.ok) throw new Error(`Copia di ${path.basename(file)} nell'immagine non riuscita: ${copy.stderr || copy.error}`);
    }
    const check = await runInContainer(engineInfo, name, `python3 -c "import gi; gi.require_version('Atspi', '2.0'); gi.require_version('Gdk', '3.0')" && command -v Xvfb xdotool openbox >/dev/null`, 60000, '/');
    if (!check.ok) throw new Error(`Desktop incompleto nell'immagine: ${check.stderr || check.error}`);
    const commit = await runExec(engineInfo.bin, [...base, 'commit', '-q', name, ref], BUILD_TIMEOUT_MS);
    if (!commit.ok) throw new Error(`Impossibile salvare l'immagine del desktop: ${commit.stderr || commit.error}`);
  } finally {
    await removeContainer(engineInfo, name).catch(() => {});
  }
  // Older desktop images are superseded by this one. The stopped desktops
  // still on them would be recreated at their next session anyway; they go
  // now, or they would keep the old image on disk.
  const desks = await runExec(engineInfo.bin, [...base, 'ps', '-a', '--filter', `name=${DESKTOP_CONTAINER_PREFIX}`, '--format', '{{.Names}} {{.Image}} {{.State}}'], 10000);
  for (const line of (desks.stdout || '').split(/\r?\n/).filter(Boolean)) {
    const [container, image, state] = line.trim().split(/\s+/);
    if (image !== ref && state !== 'running') await removeContainer(engineInfo, container).catch(() => {});
  }
  const listed = await runExec(engineInfo.bin, [...base, 'images', '--format', '{{.Repository}}:{{.Tag}}', DESKTOP_IMAGE_REPO], 10000);
  for (const old of (listed.stdout || '').split(/\s+/).filter(tag => tag && tag !== ref)) {
    await runExec(engineInfo.bin, [...base, 'rmi', old], 60000);
  }
  return ref;
}

/** The driver inside a running desktop container: one JSON line each way, answers matched by id. */
class DesktopDriver {
  constructor(engineInfo, containerName) {
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.closed = false;
    this.child = spawn(engineInfo.bin, [...(engineInfo.baseArgs || []), 'exec', '-i', '-w', '/workspace', containerName, 'python3', '-u', `${DESKTOP_DIR}/driver.py`], { windowsHide: true });
    let buffer = '';
    this.ready = new Promise((resolve, reject) => { this._ready = { resolve, reject }; });
    this.child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 0 && message.ready) { this._ready.resolve(); continue; }
        const waiting = this.pending.get(message.id);
        if (!waiting) continue;
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        waiting.resolve(message);
      }
    });
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000); });
    const end = error => {
      if (this.closed) return;
      this.closed = true;
      const why = error?.message || this.stderr.trim().split(/\r?\n/).slice(-2).join(' ') || 'il desktop si è chiuso';
      this._ready.reject(new Error(why));
      for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error(why)); }
      this.pending.clear();
    };
    this.child.on('error', end);
    this.child.on('close', () => end());
  }

  call(request, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('il desktop non è più attivo'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('il desktop non ha risposto in tempo')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...request, id }) + '\n');
    });
  }

  stop() {
    if (this.closed) return;
    try { this.child.stdin.write(JSON.stringify({ id: this.nextId++, cmd: 'quit' }) + '\n'); } catch {}
    setTimeout(() => { try { this.child.kill(); } catch {} }, 1500).unref?.();
  }
}

class DesktopSessions {
  /**
   * @param {object} options
   * @param {Function} options.store - returns the open database (conversations and projects)
   * @param {object} options.baseImages - the base image store the sandbox uses
   */
  constructor({ store, baseImages, sandbox = null }) {
    this.store = store;
    this.baseImages = baseImages;
    // The chats' workspaces are the sandbox's: their volumes, and the copies on this disk that follow them.
    this.sandbox = sandbox;
    this.sessions = new Map();
    // One desktop per chat: a new session there ends the one before.
    this.byChat = new Map();
  }

  view(session) {
    return {
      id: session.id,
      chatId: session.chatId,
      status: session.status,
      phase: session.phase || null,
      goal: session.goal,
      apps: session.apps,
      network: session.network,
      where: session.where,
      installed: session.installed || [],
      size: session.size || null,
      error: session.error || null,
      createdAt: session.createdAt,
      endedAt: session.endedAt || null
    };
  }

  /** Where the desktop of this chat runs and what it may reach, from the chat's own settings. */
  placeFor(chatId) {
    const store = this.store();
    const conv = store.conversation(chatId);
    if (!conv.sandbox_desktop) fail("Computer use è spento nell'Ambiente di questa chat.", 403);
    const owner = conv.project_id ? store.project(conv.project_id) : null;
    if (owner && owner.kind !== 'podman') {
      fail(`Il progetto "${owner.name}" è una cartella di questo computer: il desktop gira solo accanto ai progetti in container.`, 409);
    }
    return owner
      ? { network: Boolean(owner.network), where: 'project', volume: owner.container_name }
      : { network: Boolean(conv.sandbox_network), where: 'chat' };
  }

  /** The model asks: a session waiting for the user, with its goal. */
  request(chatId, { goal, apps } = {}) {
    const text = String(goal || '').trim().slice(0, 1000);
    if (!text) fail("Serve l'obiettivo della sessione.");
    const place = this.placeFor(chatId);
    const session = {
      id: crypto.randomUUID(),
      chatId: sanitizeId(chatId),
      status: 'awaiting',
      goal: text,
      apps: (Array.isArray(apps) ? apps : []).map(app => String(app).slice(0, 60)).filter(Boolean).slice(0, 6),
      network: place.network,
      where: place.where,
      createdAt: new Date().toISOString()
    };
    session.timer = setTimeout(() => {
      if (session.status === 'awaiting') { session.status = 'expired'; session.endedAt = new Date().toISOString(); }
    }, WAIT_FOR_ANSWER_MS);
    session.timer.unref?.();
    this.sessions.set(session.id, session);
    return this.view(session);
  }

  get(chatId, sessionId) {
    const session = this.sessions.get(String(sessionId || ''));
    if (!session || session.chatId !== sanitizeId(chatId)) fail('Sessione non trovata.', 404);
    return session;
  }

  status(chatId, sessionId) {
    return this.view(this.get(chatId, sessionId));
  }

  /** The user's answer. Only "allow" starts a desktop; the start goes on in the background. */
  decide(chatId, sessionId, decision) {
    const session = this.get(chatId, sessionId);
    if (session.status !== 'awaiting') fail(`La richiesta non è più in attesa (${session.status}).`, 409);
    clearTimeout(session.timer);
    if (decision !== 'allow') {
      session.status = 'denied';
      session.endedAt = new Date().toISOString();
      return this.view(session);
    }
    // The chat's settings may have changed while the card waited.
    Object.assign(session, this.placeFor(chatId));
    session.status = 'starting';
    session.phase = 'engine';
    const previous = this.byChat.get(session.chatId);
    if (previous && previous !== session.id) this.end(chatId, previous).catch(() => {});
    this.byChat.set(session.chatId, session.id);
    session.starting = this._start(session).then(() => {
      if (session.status === 'starting') { session.status = 'running'; session.phase = null; }
    }).catch(error => {
      session.status = 'failed';
      session.error = error.message;
      session.endedAt = new Date().toISOString();
      session.driver?.stop();
    });
    return this.view(session);
  }

  async _start(session) {
    const engineInfo = await detectEngine();
    if (!engineInfo.available) throw new Error('Nessun container engine (Podman) disponibile.');
    const base = engineInfo.baseArgs || [];
    const image = await ensureDesktopImage(engineInfo, this.baseImages, phase => { session.phase = phase; });
    session.phase = 'container';
    const name = `${DESKTOP_CONTAINER_PREFIX}${session.chatId}`;
    const wsl = Boolean(engineInfo.isWsl);
    const mount = session.where === 'project'
      ? `${session.volume}:/workspace:rw`
      : `${await this._chatWorkspace(session.chatId, engineInfo, wsl)}:/workspace:rw`;
    // The desktop joins its environment's own isolated network (the same the
    // chat's sandbox or the project's container uses), so with the network on
    // it reaches the Internet but not any other environment's pod.
    const envKey = session.where === 'project' ? session.volume : `chat-${session.chatId}`;
    const network = await ensureNetwork(engineInfo, envKey, session.network);
    // What the container was made with; anything different makes a new one.
    const seccomp = await ensureSeccompProfile(engineInfo);
    const label = `${image}|${network}|${mount}|nocaps|ro|${seccomp ? 'scc' : 'default'}`;
    const info = await inspectContainer(engineInfo, name);
    if (info.exists) {
      const current = await runExec(engineInfo.bin, [...base, 'container', 'inspect', '--format', '{{index .Config.Labels "synthorg.desktop"}}', name], 8000);
      if ((current.stdout || '').trim() !== label) await removeContainer(engineInfo, name);
      else if (!info.running) {
        const started = await runExec(engineInfo.bin, [...base, 'start', name], 30000);
        if (!started.ok) await removeContainer(engineInfo, name);
      }
    }
    if (!(await inspectContainer(engineInfo, name)).running) {
      const created = await runExec(engineInfo.bin, [...base, ...hardenedRunArgs({
        name,
        network,
        image,
        mounts: [mount],
        memory: '2g',
        cpus: '2.0',
        pids: 2048,
        // A chat's workspace is written with the chat's own mapping; a
        // project's volume with the projects' fixed one.
        userns: session.where === 'project',
        // Nothing is installed here at run time: the desktop, the browser and
        // the apps run with no capability at all (measured: same behaviour).
        capAdd: [],
        seccomp,
        // The system is read-only, for root too: the one place that can be
        // written and lasts is /workspace. /tmp, /run and /var/tmp are in
        // memory and gone when the desktop stops (the apps' settings, the
        // browser's profile), so every session starts from the same desktop.
        // Browsers keep their pages in shared memory; the engine's 64 MB crash them.
        extra: ['--read-only', '--shm-size=512m', '--label', `synthorg.desktop=${label}`]
      })], 60000);
      if (!created.ok) throw new Error(`Impossibile avviare il container del desktop: ${created.stderr || created.error}`);
    }
    session.container = name;
    session.phase = 'desktop';
    const driver = new DesktopDriver(engineInfo, name);
    session.driver = driver;
    await driver.ready;
    const started = await driver.call({ cmd: 'start', width: 1280, height: 800 }, 60000);
    if (!started.ok) throw new Error(started.error || 'il desktop non è partito');
    session.installed = started.apps || [];
    session.size = started.size;
  }

  /** The chat's files as the desktop mounts them: its volume (made and filled by the sandbox), or the copy on this disk where there is no sandbox to ask. */
  async _chatWorkspace(chatId, engineInfo, wsl) {
    if (this.sandbox?.ensureChatWorkspace) return (await this.sandbox.ensureChatWorkspace(chatId, engineInfo)).source;
    return toContainerMountPath(getWorkspaceDir(chatId), wsl);
  }

  /** One action of the model on the desktop; the answer carries the screen as it is afterwards. */
  async act(chatId, sessionId, request = {}) {
    const session = this.get(chatId, sessionId);
    if (session.status === 'starting') await session.starting;
    if (session.status !== 'running') fail(`La sessione non è attiva (${session.status}).`, 409);
    const cmd = String(request.cmd || '');
    if (!ACTIONS.has(cmd)) fail(`Azione non prevista: ${cmd}`);
    const { id, ...rest } = request;
    const timeout = cmd === 'open' ? 60000 : 30000;
    try {
      return await session.driver.call({ ...rest, cmd }, timeout);
    } catch (error) {
      if (session.driver.closed) {
        session.status = 'failed';
        session.error = error.message;
        session.endedAt = new Date().toISOString();
      }
      throw error;
    }
  }

  /** The picture of the screen, for the live view. A few per second at most, whoever asks. */
  async screen(chatId, sessionId, width = 1280) {
    const session = this.get(chatId, sessionId);
    if (session.status !== 'running') {
      if (session.lastShot) return session.lastShot.data;
      fail('Nessuno schermo attivo.', 409);
    }
    const now = Date.now();
    if (session.lastShot && now - session.lastShot.at < SCREEN_MIN_INTERVAL_MS && session.lastShot.width === width) return session.lastShot.data;
    if (session.shooting) return session.shooting;
    session.shooting = session.driver.call({ cmd: 'screenshot', width, quality: 70 }, 15000).then(answer => {
      if (!answer.ok) throw new Error(answer.error || 'screenshot non riuscito');
      const data = Buffer.from(answer.jpeg, 'base64');
      session.lastShot = { at: Date.now(), data, width };
      return data;
    }).finally(() => { session.shooting = null; });
    return session.shooting;
  }

  /** The end of a session: its desktop closes and its container stops, ready for the next one. */
  async end(chatId, sessionId, outcome = {}) {
    const session = this.get(chatId, sessionId);
    clearTimeout(session.timer);
    if (['ended', 'denied', 'expired', 'failed'].includes(session.status)) return this.view(session);
    session.status = 'ended';
    session.stoppedByUser = Boolean(outcome.stopped);
    session.endedAt = new Date().toISOString();
    session.driver?.stop();
    if (this.byChat.get(session.chatId) === session.id) this.byChat.delete(session.chatId);
    if (session.container) {
      detectEngine().then(engineInfo => runExec(engineInfo.bin, [...(engineInfo.baseArgs || []), 'stop', '-t', '2', session.container], 30000)).catch(() => {});
    }
    // What the desktop left in the chat's files (a download, a document saved) reaches the copy on this disk.
    if (session.where !== 'project') this.sandbox?.pullWorkspace?.(session.chatId, { force: true }).catch(() => {});
    return this.view(session);
  }

  /** A chat deleted: its desktop goes with it. */
  async forget(chatId) {
    const id = sanitizeId(chatId);
    for (const session of this.sessions.values()) {
      if (session.chatId === id) { session.driver?.stop(); this.sessions.delete(session.id); }
    }
    const engineInfo = await detectEngine();
    if (engineInfo.available) await removeContainer(engineInfo, `${DESKTOP_CONTAINER_PREFIX}${id}`).catch(() => {});
  }

  stopAll() {
    for (const session of this.sessions.values()) session.driver?.stop();
  }
}

module.exports = { DesktopSessions, DesktopDriver, ensureDesktopImage, desktopImageRef, desktopStamp, DESKTOP_CONTAINER_PREFIX, DESKTOP_IMAGE_REPO, DESKTOP_APPS };
