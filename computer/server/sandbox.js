'use strict';
const { execFile, spawn } = require('node:child_process');
const { DATA_DIR, dataDirFor } = require('./paths');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BaseImageStore, BASE_IMAGE } = require('./base-image');
const { CodeExtensionCatalog, SHARED_MODULES } = require('./code-extensions');
const ROOT = path.resolve(__dirname, '..');

let cachedEngine = null;
let lastCheckTime = 0;
/*
 * Whether the engine can cap a container's processor time. SynthOrg's own
 * podman (Windows) can. A Linux host's rootless podman can only when the
 * system hands the `cpu` controller down to the user's session, and several
 * (Ubuntu and Pop!_OS 22.04 among them) hand down memory and process count
 * alone: there `--cpus` makes every container fail to start. The cap is a
 * courtesy to the rest of the machine, not part of the boundary — memory and
 * process limits, the dropped capabilities and the network rules stay — so
 * where it is not available it is left out. Asked of the engine once.
 */
let cpuLimitAvailable = true;

/** `--cpus` for a container, or nothing where the engine cannot apply it. */
function cpuArgs(cpus) {
  return cpuLimitAvailable ? [`--cpus=${cpus}`] : [];
}

const EMBEDDED_PODMAN_EXE = path.join(ROOT, 'bin', 'podman', 'podman.exe');

const CANDIDATE_PATHS = [
  { engine: 'podman', bin: EMBEDDED_PODMAN_EXE, isEmbedded: true, label: 'Podman Standalone' },
  { engine: 'podman', bin: 'podman', isEmbedded: false, label: 'Podman (System)' },
  { engine: 'podman', bin: 'C:\\Program Files\\RedHat\\Podman\\podman.exe', isEmbedded: false, label: 'Podman (System)' },
  { engine: 'docker', bin: 'docker', isEmbedded: false, label: 'Docker' },
  { engine: 'docker', bin: path.join(process.env.LOCALAPPDATA || '', 'Programs\\DockerDesktop\\resources\\bin\\docker.exe'), isEmbedded: false, label: 'Docker Desktop' }
];

function runExec(bin, args, timeout = 5000, env = null) {
  return new Promise(resolve => {
    const options = { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 };
    if (env) options.env = { ...process.env, ...env };
    execFile(bin, args, options, (error, stdout, stderr) => {
      // Keep the output on failure too: a non-zero exit is exactly when the
      // command's own diagnostics matter.
      if (error) return resolve({ ok: false, error: error.message, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
      resolve({ ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

/*
 * The embedded runtime: an Alpine distro of WSL where podman never runs as
 * root and the Windows disk is never mounted. `synthorg-podman` is the one
 * entry point: it runs podman as the unprivileged user `synthorg`, inside a
 * cgroup delegated to it, and mounts SynthOrg's own data folder — and nothing
 * else — readable by that user alone. `server/runtime/rootless-setup.sh` is
 * what makes a distro that way, run by `ensureRuntimeDistro` right after the
 * distro is imported, and again if a start finds the setup unfinished.
 */
/*
 * The distro is SynthOrg's own, made by SynthOrg (`ensureRuntimeDistro`): the
 * Alpine archive it keeps for the base image, imported into WSL under the
 * data folder of this app, then set up rootless. It carries a mark
 * (`/etc/synthorg-pods`, with this app's identifier) and only a distro with
 * that mark is ever used: one of another program that happens to have the
 * name is refused, never adopted and never changed. Measured on 2026-10-15:
 * before this, SynthOrg looked a distro up by name alone and found, and
 * reconfigured, the one of another app (API Organizer, which called its own
 * `synthorg-runtime`).
 */
const RUNTIME_DISTRO = 'synthorg-pods';
const RUNTIME_PODMAN = 'synthorg-podman';
const DATA_MOUNT = '/mnt/synthorg-data';
const ROOTLESS_SETUP = path.join(__dirname, 'runtime', 'rootless-setup.sh');
const RUNTIME_DIR = path.join(DATA_DIR, 'runtime');
const RUNTIME_MARK = '/etc/synthorg-pods';
const APP_ID = 'org.synthorg.orchestrator';
/**
 * Every container of a project — the project's own, the build of its tools
 * image, the git runs — uses this one user namespace: root inside is
 * subordinate id 100000 outside, never the user, and a volume written by one
 * is readable by the others. Chat containers do not: they write SynthOrg's
 * data folder, which is the user's, and keep the plain rootless mapping.
 */
const USERNS_ARGS = ['--uidmap=0:1:65535', '--gidmap=0:1:65535'];
const HOST_TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

/**
 * Where a folder of this machine appears inside the runtime. Only SynthOrg's
 * data folder is there at all: anything else is refused, not mounted.
 */
function toContainerMountPath(winPath, isWsl) {
  if (!isWsl) return winPath;
  const base = path.resolve(DATA_DIR);
  const rel = path.relative(base, path.resolve(winPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Percorso fuori dalla cartella dati di SynthOrg, non montabile in un container: ${winPath}`);
  }
  return rel ? `${DATA_MOUNT}/${rel.split(path.sep).join('/')}` : DATA_MOUNT;
}

/** Runs a command with a file on its standard input, and collects its output like runExec. */
function runExecFromFile(bin, args, file, timeout = 5000) {
  return new Promise(resolve => {
    const child = spawn(bin, args, { windowsHide: true });
    const out = []; const err = []; let settled = false;
    const done = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { child.kill(); done({ ok: false, error: 'tempo scaduto', stdout: '', stderr: '' }); }, timeout);
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    child.on('error', error => done({ ok: false, error: error.message, stdout: '', stderr: '' }));
    child.on('close', code => done({ ok: code === 0, error: code === 0 ? null : `exit ${code}`, stdout: Buffer.concat(out).toString('utf8').trim(), stderr: Buffer.concat(err).toString('utf8').trim() }));
    const stream = fs.createReadStream(file);
    stream.on('error', error => { child.kill(); done({ ok: false, error: error.message, stdout: '', stderr: '' }); });
    stream.pipe(child.stdin);
  });
}

/** Two processes joined by a pipe: the first one's output is the second one's input. */
function pipeline(first, second, timeout) {
  return new Promise(resolve => {
    const a = spawn(first.bin, first.args, { windowsHide: true });
    const b = spawn(second.bin, second.args, { windowsHide: true });
    const errA = []; const errB = []; const out = []; let settled = false; let exitA = null; let exitB = null;
    const done = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { a.kill(); b.kill(); done({ ok: false, error: 'tempo scaduto', stdout: '', stderr: '' }); }, timeout);
    const finish = () => {
      if (exitA === null || exitB === null) return;
      const ok = exitA === 0 && exitB === 0;
      done({ ok, error: ok ? null : `exit ${exitA}/${exitB}`, stdout: Buffer.concat(out).toString('utf8').trim(), stderr: [Buffer.concat(errA).toString('utf8'), Buffer.concat(errB).toString('utf8')].join('\n').trim() });
    };
    a.stderr.on('data', c => errA.push(c)); b.stderr.on('data', c => errB.push(c)); b.stdout.on('data', c => out.push(c));
    a.on('error', error => done({ ok: false, error: error.message, stdout: '', stderr: '' }));
    b.on('error', error => done({ ok: false, error: error.message, stdout: '', stderr: '' }));
    a.on('close', code => { exitA = code; finish(); });
    b.on('close', code => { exitB = code; finish(); });
    a.stdout.pipe(b.stdin);
  });
}

/**
 * A folder, or one file, of this machine copied into a container as a tar
 * stream over the engine's standard input. Nothing of the disk is mounted
 * anywhere for it. `renameTo` gives a file another name once it is inside.
 */
async function copyIntoContainer(engineInfo, source, containerName, targetDir, renameTo = null) {
  const isDir = fs.statSync(source).isDirectory();
  // One 512-byte block per record: rootless `podman cp -` stops reading at the
  // end-of-archive marker, and tar's default 10 KB padding after it then hits a
  // closed pipe ("read/write on closed pipe") on anything but small archives.
  const tarArgs = isDir ? ['-b', '1', '-cf', '-', '-C', source, '.'] : ['-b', '1', '-cf', '-', '-C', path.dirname(source), path.basename(source)];
  const res = await pipeline({ bin: HOST_TAR, args: tarArgs }, { bin: engineInfo.bin, args: [...(engineInfo.baseArgs || []), 'cp', '-', `${containerName}:${targetDir}`] }, 10 * 60 * 1000);
  if (!res.ok) return res;
  if (!renameTo || renameTo === path.basename(source)) return res;
  return runInContainer(engineInfo, containerName, `mv '${targetDir}/${path.basename(source)}' '${targetDir}/${renameTo}'`, 30000, '/');
}

/**
 * The other direction exists for one thing only: SynthOrg's own build taking
 * the editor it just compiled out of a throwaway container. Nothing a model
 * ever runs goes through here.
 */
function copyOutOfContainer(engineInfo, containerName, containerPath, outDir) {
  return pipeline({ bin: engineInfo.bin, args: [...(engineInfo.baseArgs || []), 'cp', `${containerName}:${containerPath}`, '-'] }, { bin: HOST_TAR, args: ['-xf', '-', '-C', outDir] }, 5 * 60 * 1000);
}

/**
 * A project volume written before the fixed map (USERNS_ARGS) came in belongs
 * to the runtime user itself: in the container that is nobody, and its root
 * can no longer write the project. In the rootless namespace the runtime user
 * is uid 0 and the container's root is uid 1: what 0 owns goes to 1, anything
 * else (users the project made itself) is left as it is. Nothing to do on a
 * volume made since, or on an engine that is not the rootless runtime.
 */
async function repairVolumeOwner(engineInfo, volume) {
  const base = engineInfo.baseArgs || [];
  if (!base.includes(RUNTIME_PODMAN)) return false;
  const where = await runExec(engineInfo.bin, [...base, 'volume', 'inspect', volume, '--format', '{{.Mountpoint}}'], 15000);
  const mount = (where.stdout || '').trim();
  if (!where.ok || !mount.startsWith('/')) return false;
  const find = 'find "$1" -xdev \\( -user 0 -o -group 0 \\)';
  const probe = await runExec(engineInfo.bin, [...base, 'unshare', 'sh', '-c', `${find} | head -n 1`, 'sh', mount], 5 * 60 * 1000);
  if (!probe.ok || !(probe.stdout || '').trim()) return false;
  const fix = await runExec(engineInfo.bin, [...base, 'unshare', 'sh', '-c',
    'find "$1" -xdev -user 0 -exec chown -h 1 {} + && find "$1" -xdev -group 0 -exec chgrp -h 1 {} +', 'sh', mount], 10 * 60 * 1000);
  if (!fix.ok) throw Object.assign(new Error(`Impossibile rendere di nuovo scrivibile il volume ${volume}: ${fix.stderr || fix.error}`), { status: 502 });
  return true;
}

/** Turns a distro that still answers as root into the rootless runtime, once. */
async function setupRootlessRuntime() {
  const setup = await runExecFromFile('wsl.exe', ['-d', RUNTIME_DISTRO, '--exec', 'sh', '-s'], ROOTLESS_SETUP, 10 * 60 * 1000);
  if (!setup.ok) throw new Error(`Configurazione rootless del runtime non riuscita: ${parseDistroList(setup.stderr || setup.stdout).slice(-3).join(' ') || setup.error}`);
  // wsl.conf is read when the distro starts: stop it, the next call starts it fresh.
  await runExec('wsl.exe', ['--terminate', RUNTIME_DISTRO], 30000);
}

/** What the mark in the distro says, or null: not ours, or not there. */
async function runtimeMark() {
  const read = await runExec('wsl.exe', ['-d', RUNTIME_DISTRO, '--exec', 'cat', RUNTIME_MARK], 15000);
  if (!read.ok) return null;
  try {
    const mark = JSON.parse(read.stdout);
    return mark && mark.app === APP_ID ? mark : null;
  } catch { return null; }
}

/**
 * The runtime of the pods, made if this machine does not have it: the Alpine
 * archive of the base image (one download, verified against Alpine's own
 * digest) imported into WSL as a distro under this app's data folder, then
 * set up: podman and what it needs installed from Alpine's repositories, the
 * mark written, the unprivileged user and the cgroup made, the Windows disks
 * never mounted. Measured: about a minute, once. A distro of that name that
 * is not ours is left exactly as it is, and said.
 */
let runtimeEnsured = null;
let baseImagesDefault = null;
function defaultBaseImages() {
  if (!baseImagesDefault) baseImagesDefault = new BaseImageStore({ dir: path.join(DATA_DIR, 'images') });
  return baseImagesDefault;
}
function ensureRuntimeDistro(store) {
  if (!runtimeEnsured) {
    runtimeEnsured = makeRuntimeDistro(store).catch(error => { runtimeEnsured = null; throw error; });
  }
  return runtimeEnsured;
}

async function makeRuntimeDistro(store) {
  if (await runtimeRegistered()) {
    if (await runtimeMark()) return { created: false };
    throw Object.assign(new Error(`Nella WSL c'è già una distro chiamata ${RUNTIME_DISTRO} che non è di SynthOrg: non viene toccata. Rinominala o toglila (wsl --unregister ${RUNTIME_DISTRO}) perché SynthOrg possa fare la sua.`), { status: 409 });
  }
  const archive = await store.ensure();
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // What the folder is, for whoever opens it.
  fs.writeFileSync(path.join(RUNTIME_DIR, 'LEGGIMI.txt'), `Il disco dei pod di SynthOrg (distro WSL «${RUNTIME_DISTRO}»): immagini, volumi dei progetti e delle chat, pacchetti.\nSi gestisce dalle impostazioni dell'app (Memoria → Disco dei pod); non spostare né rinominare a mano.\n`);
  const where = path.join(RUNTIME_DIR, 'distro');
  const imported = await runExec('wsl.exe', ['--import', RUNTIME_DISTRO, where, archive, '--version', '2'], 10 * 60 * 1000);
  if (!imported.ok) {
    throw Object.assign(new Error(`Impossibile creare la distro ${RUNTIME_DISTRO}: ${parseDistroList(imported.stderr || imported.stdout).join(' ') || imported.error}`), { status: 502 });
  }
  try {
    await setupRootlessRuntime();
    if (!(await runtimeMark())) throw new Error('la distro non porta il segno di SynthOrg dopo la configurazione');
  } catch (error) {
    // Half made: taken away, so the next start makes it again from the beginning.
    await runExec('wsl.exe', ['--unregister', RUNTIME_DISTRO], 5 * 60 * 1000).catch(() => {});
    throw Object.assign(new Error(`Il runtime dei pod non si è potuto preparare: ${error.message}`), { status: 502 });
  }
  return { created: true };
}

async function detectEngine(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedEngine && now - lastCheckTime < 30000) {
    return cachedEngine;
  }

  // 1. SynthOrg's own WSL runtime, on Windows: made if this machine has none, used only when it carries our mark.
  // A test never makes one (nor sets the data mount, below): it uses the runtime that is there, or none.
  let runtimeError = '';
  if (process.platform === 'win32') try {
    if (!process.env.NODE_TEST_CONTEXT) await ensureRuntimeDistro(defaultBaseImages());
    else if (!(await runtimeRegistered()) || !(await runtimeMark())) throw new Error('nessun runtime di SynthOrg su questa macchina');
    const wrapped = await runExec('wsl.exe', ['-d', RUNTIME_DISTRO, RUNTIME_PODMAN, '--version'], 8000);
    let version = wrapped.ok && wrapped.stdout ? wrapped.stdout : null;
    if (!version && !process.env.NODE_TEST_CONTEXT) {
      // Ours, but its setup did not finish (the app stopped in it): done again, then asked again.
      await setupRootlessRuntime();
      const again = await runExec('wsl.exe', ['-d', RUNTIME_DISTRO, RUNTIME_PODMAN, '--version'], 8000);
      if (again.ok && again.stdout) version = again.stdout;
    }
    if (!version) throw new Error(`il runtime ${RUNTIME_DISTRO} non risponde: ${parseDistroList(wrapped.stderr || wrapped.stdout).slice(-2).join(' ') || wrapped.error || 'nessuna risposta'}`);
    if (version) {
      // The wrapper mounts SynthOrg's data folder, and nothing else, when told where it is.
      // Never from a test: the folder stays mounted for as long as the runtime runs, and a test's own data folder
      // (paths.js) mounted there would be what the app finds in place of its own.
      if (!process.env.NODE_TEST_CONTEXT) {
        process.env.SYNTHORG_DATA_WIN = path.resolve(DATA_DIR);
        process.env.WSLENV = [...new Set([...String(process.env.WSLENV || '').split(':').filter(Boolean), 'SYNTHORG_DATA_WIN'])].join(':');
      }
      cachedEngine = {
        engine: 'podman',
        bin: 'wsl.exe',
        // `--exec`: podman gets the arguments as they are. Without it WSL hands
        // the line to the distro's shell, which expands $, quotes and spaces
        // inside every command before podman ever sees it.
        baseArgs: ['-d', RUNTIME_DISTRO, '--exec', RUNTIME_PODMAN],
        version,
        available: true,
        isWsl: true,
        isEmbedded: true,
        rootless: true,
        label: 'Podman Standalone'
      };
      lastCheckTime = now;
      return cachedEngine;
    }
  } catch (error) { runtimeError = error.message; }

  // 2. Candidate paths (embedded bin/podman/podman.exe, system podman, system docker)
  for (const candidate of CANDIDATE_PATHS) {
    if (!candidate.bin) continue;
    try {
      if (candidate.bin.includes('\\') && !fs.existsSync(candidate.bin)) continue;
      const res = await runExec(candidate.bin, ['--version'], 4000);
      if (res.ok && res.stdout) {
        cachedEngine = {
          engine: candidate.engine,
          bin: candidate.bin,
          baseArgs: [],
          version: res.stdout,
          available: true,
          isWsl: false,
          isEmbedded: Boolean(candidate.isEmbedded),
          label: candidate.label
        };
        // Which resource controllers this user's containers may use (podman says; docker and an engine that does not say are taken as able).
        if (candidate.engine === 'podman') {
          const info = await runExec(candidate.bin, ['info', '--format', '{{range .Host.CgroupControllers}}{{.}} {{end}}'], 15000).catch(() => null);
          const controllers = info && info.ok ? String(info.stdout || '').trim().split(/\s+/).filter(Boolean) : [];
          cpuLimitAvailable = !controllers.length || controllers.includes('cpu');
          cachedEngine.cpuLimit = cpuLimitAvailable;
        }
        lastCheckTime = now;
        return cachedEngine;
      }
    } catch {}
  }

  cachedEngine = {
    engine: 'none',
    bin: null,
    baseArgs: [],
    version: null,
    available: false,
    isWsl: false,
    isEmbedded: false,
    label: 'None',
    // Why the runtime of this app is not there, for the page.
    error: runtimeError || null
  };
  lastCheckTime = now;
  return cachedEngine;
}

/**
 * OCI reference accepted for a sandbox container.
 *
 * The value reaches `podman run` as a positional argument, so anything starting
 * with "-" would be parsed as a flag instead of an image name: a stored value
 * such as "-v/:/host" turns a chat setting into control over the container's
 * mounts. Requiring a leading alphanumeric and a strict reference shape closes
 * that, and rejects whitespace and shell metacharacters on the way.
 */
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._-]*(:[0-9]+)?(\/[a-z0-9][a-z0-9._-]*)*(:[a-zA-Z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/;

function assertSafeImage(image) {
  const value = String(image == null ? '' : image).trim() || BASE_IMAGE;
  if (value.length > 100 || !IMAGE_PATTERN.test(value)) {
    throw Object.assign(
      new Error(`Immagine container non valida: "${value}". Usa un riferimento come "alpine:latest" o "docker.io/library/python:3.12-alpine".`),
      { status: 400 }
    );
  }
  return value;
}

/*
 * One isolated network per environment, so a pod that has the network on
 * reaches the Internet but not the pod of any other environment. Podman's
 * default bridge lets every container on it talk to every other, which would
 * let one chat's pod reach another chat's — the pod is the sacrificial piece,
 * but the boundary between environments is not. A netavark network created
 * with `isolate=true` blocks traffic to and from every other network while
 * masquerade still carries it out to the Internet, so each environment sits
 * on its own wire. Nothing in SynthOrg talks pod-to-pod (the editor and the
 * agent go through `podman exec` and stdio), so isolating costs nothing.
 *
 * On Windows the podman is SynthOrg's own. On Linux it is the host's, and an
 * older one (3.x, as Ubuntu and Pop!_OS 22.04 ship) has no netavark and
 * refuses the option. There the same boundary is kept another way: each
 * container gets a network stack of its own (`slirp4netns`, what rootless
 * podman uses when no network is named), which reaches the Internet and no
 * other container at all. The engine is asked once; what it answered is
 * remembered for the life of the service.
 */
const NETWORK_PREFIX = 'synthorg-net-';
const PRIVATE_STACK = 'slirp4netns';
const ensuredNetworks = new Set();
// True once the engine has refused `isolate`: every environment's wire is then a private stack.
let privateStacks = false;

function networkNameFor(envKey) {
  const safe = String(envKey || 'shared').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80);
  return `${NETWORK_PREFIX}${safe}`;
}

/**
 * The isolated network of an environment, created the first time it is needed.
 * Returns its name, to pass as the container's `network`. `none` when the
 * environment's network is off: an environment with no Internet has no wire.
 */
async function ensureNetwork(engineInfo, envKey, networkEnabled) {
  if (!networkEnabled) return 'none';
  if (privateStacks) return PRIVATE_STACK;
  const name = networkNameFor(envKey);
  if (ensuredNetworks.has(name)) return name;
  const base = engineInfo.baseArgs || [];
  const exists = await runExec(engineInfo.bin, [...base, 'network', 'exists', name], 8000);
  if (!exists.ok) {
    const created = await runExec(engineInfo.bin, [...base, 'network', 'create', '--opt', 'isolate=true', name], 20000);
    const said = `${created.stderr || ''}${created.error || ''}`;
    // An engine without netavark does not know the option: a private stack per container, from now on.
    if (!created.ok && /unsupported option|unknown option|invalid option/i.test(said) && /isolate/i.test(said)) {
      privateStacks = true;
      return PRIVATE_STACK;
    }
    // A race can create it between the check and here; that error is fine.
    if (!created.ok && !/already exists/i.test(said)) {
      throw Object.assign(new Error(`Impossibile creare la rete isolata ${name}: ${created.stderr || created.error}`), { status: 502 });
    }
  }
  ensuredNetworks.add(name);
  return name;
}

/*
 * Our seccomp profile: the engine's own default, minus a handful of syscalls
 * the desktop and the sandboxes never need and that only widen the kernel's
 * attack surface — the key-management calls (keyctl, add_key, request_key) and
 * userfaultfd. The default already blocks the big ones (bpf, perf_event_open,
 * kexec, module loading); this closes the rest.
 *
 * The profile is built from the engine's default at runtime, so it always
 * matches the podman that ships with SynthOrg (on Windows the whole stack —
 * podman, crun, the distro — is ours) and, on a Linux host, the podman there.
 * Removing syscalls from a known-good default cannot break an app that does
 * not use them, so this is safe across versions. If the default cannot be
 * read for any reason, the engine's built-in default still applies: hardening
 * never falls open.
 */
const SECCOMP_DENY = ['keyctl', 'add_key', 'request_key', 'userfaultfd'];
let seccompProfile; // undefined = not built yet, null = unavailable, string = container path

async function readDefaultSeccomp(engineInfo) {
  const distroPath = '/usr/share/containers/seccomp.json';
  if (engineInfo.isWsl) {
    const res = await runExec('wsl.exe', ['-d', RUNTIME_DISTRO, 'cat', distroPath], 8000);
    return res.ok && res.stdout ? res.stdout : null;
  }
  for (const candidate of [distroPath, '/etc/containers/seccomp.json']) {
    try { return fs.readFileSync(candidate, 'utf8'); } catch {}
  }
  return null;
}

/** The path to our seccomp profile, as the container runtime sees it; null to keep the engine's built-in default. */
async function ensureSeccompProfile(engineInfo) {
  if (seccompProfile !== undefined) return seccompProfile;
  seccompProfile = null;
  try {
    const raw = await readDefaultSeccomp(engineInfo);
    if (!raw) return seccompProfile;
    const profile = JSON.parse(raw);
    const deny = new Set(SECCOMP_DENY);
    for (const rule of profile.syscalls || []) {
      if (Array.isArray(rule.names)) rule.names = rule.names.filter(name => !deny.has(name));
    }
    // An explicit deny in front wins over anything, and empty rules are dropped.
    profile.syscalls = (profile.syscalls || []).filter(rule => !Array.isArray(rule.names) || rule.names.length);
    profile.syscalls.unshift({ names: [...SECCOMP_DENY], action: 'SCMP_ACT_ERRNO', errnoRet: 1 });
    const outFile = path.join(DATA_DIR, 'seccomp.json');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(profile));
    // On WSL the wrapper mounts the data folder at DATA_MOUNT for the runtime;
    // on a Linux host podman reads the file where it is.
    seccompProfile = engineInfo.isWsl ? `${DATA_MOUNT}/seccomp.json` : outFile;
  } catch {
    seccompProfile = null;
  }
  return seccompProfile;
}

/** An environment's network, gone with the environment. Fails quietly if a container still holds it. */
async function removeNetwork(engineInfo, envKey) {
  const name = networkNameFor(envKey);
  ensuredNetworks.delete(name);
  await runExec(engineInfo.bin, [...(engineInfo.baseArgs || []), 'network', 'rm', name], 15000);
}

/** Our isolated networks that no container is attached to any more: removed. The build one stays. */
async function pruneNetworks(engineInfo) {
  const base = engineInfo.baseArgs || [];
  const listed = await runExec(engineInfo.bin, [...base, 'network', 'ls', '--format', '{{.Name}}'], 8000);
  for (const name of (listed.stdout || '').split(/\s+/).filter(n => n.startsWith(NETWORK_PREFIX) && n !== `${NETWORK_PREFIX}build`)) {
    const used = await runExec(engineInfo.bin, [...base, 'ps', '-aq', '--filter', `network=${name}`], 6000);
    if (!(used.stdout || '').trim()) { ensuredNetworks.delete(name); await runExec(engineInfo.bin, [...base, 'network', 'rm', name], 10000); }
  }
}

// A command of the model runs in a session of its own (setsid, when the image
// has it) under a shell that first notes its own pid. Interrupting it (stop
// button, or the time limit) ends that whole process group and the process
// tree under that pid, inside the container: nothing keeps running unseen
// once the client that started it is gone. Only a process that leaves the
// session by itself (a daemon) escapes, and the container's init reaps it
// when it ends.
const RUN_PID_DIR = '/tmp/.synthorg-run';
const RUN_INNER = 'mkdir -p ' + RUN_PID_DIR + ' && echo $$ > "' + RUN_PID_DIR + '/$1" && sh -c "$2"; rc=$?; rm -f "' + RUN_PID_DIR + '/$1"; exit $rc';
const RUN_WRAPPER = 'pg=$(cut -d" " -f5 /proc/$$/stat 2>/dev/null); if [ "$pg" != "$$" ] && command -v setsid >/dev/null 2>&1; then exec setsid sh -c "$0" "$@"; fi; exec sh -c "$0" "$@"';
const RUN_KILL = [
  'f="' + RUN_PID_DIR + '/$1"; p=$(cat "$f" 2>/dev/null) || exit 0; rm -f "$f"',
  'tree() { echo "$1"; for d in /proc/[0-9]*; do c=${d#/proc/}; [ "$c" = "$1" ] && continue; pp=$(sed -n \'s/^PPid:[[:space:]]*//p\' "$d/status" 2>/dev/null); [ "$pp" = "$1" ] && tree "$c"; done; }',
  'pids=$(tree "$p"); pg=$(cut -d" " -f5 "/proc/$p/stat" 2>/dev/null)',
  'if [ -n "$pg" ] && [ "$pg" = "$p" ]; then kill -TERM -- "-$pg" 2>/dev/null; fi; kill -TERM $pids 2>/dev/null; sleep 1',
  'if [ -n "$pg" ] && [ "$pg" = "$p" ]; then kill -KILL -- "-$pg" 2>/dev/null; fi; kill -KILL $pids 2>/dev/null; exit 0'
].join('\n');
const RUN_TIMEOUT_MS = 60000;
// A project's editor, when open, runs the model's commands in its terminals, in
// view (server/code-editor/run.c). The request and the answer are files in the
// same folder, reached with this service's own exec: the editor's channel to
// the desktop stays pixels only. Exit 90 = no editor here, or it did not take
// the command: it runs the older way. Otherwise stdout is the output and the
// last line of stderr is "<exit code> <reason or ->".
const TERM_RUN = [
  'd=' + RUN_PID_DIR + '; id=$1',
  'p=$(cat "$d/editor.pid" 2>/dev/null) && kill -0 "$p" 2>/dev/null || exit 90',
  'printf "%s" "$2" > "$d/.$id.req.tmp" && mv "$d/.$id.req.tmp" "$d/$id.req" || exit 90',
  'i=0; while [ ! -e "$d/$id.acc" ] && [ ! -e "$d/$id.exit" ]; do i=$((i+1)); if [ $i -gt 60 ]; then rm -f "$d/$id.req"; [ -e "$d/$id.acc" ] || [ -e "$d/$id.exit" ] || exit 90; fi; sleep 0.05; done',
  'while [ ! -e "$d/$id.exit" ]; do kill -0 "$p" 2>/dev/null || { rm -f "$d/$id.acc"; echo "-1 terminal closed" >&2; exit 0; }; sleep 0.1; done',
  'cat "$d/$id.out" 2>/dev/null; cat "$d/$id.exit" >&2; rm -f "$d/$id.acc" "$d/$id.out" "$d/$id.exit" "$d/$id.stop"'
].join('\n');
// The editor's change notes, followed from now on (the file exists before tail looks at it).
const FOLLOW_EVENTS = 'd=' + RUN_PID_DIR + '; mkdir -p "$d" && touch "$d/events" && exec tail -n 0 -F "$d/events" 2>/dev/null';
// Ends a command running in the editor's terminal: the editor sends Ctrl+C, then ends what is left.
const TERM_STOP = 'd=' + RUN_PID_DIR + '; printf "%s" "$2" > "$d/.$1.stop.tmp" && mv "$d/.$1.stop.tmp" "$d/$1.stop"';

function sanitizeRunId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(id) ? id : null;
}

function sanitizeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36);
}

/**
 * The copy, on this disk, of a chat's files. The files themselves live in a
 * volume of the engine (`chatVolumeName`), on the disk of the pods, where the
 * container reads and writes them at the speed of its own disk: measured,
 * two thousand small files take 3.6 s to write on this disk mounted in the
 * runtime and 0.04 s in a volume. This folder follows the volume
 * (`pullWorkspace`, after every command and desktop session): it is what the
 * page lists and serves, what the vault encrypts and what the memory copies,
 * and nothing in the pod ever writes it. What is put here from this side (a
 * file uploaded, files of a project or of another chat) is pushed into the
 * volume (`pushWorkspace`), the one direction files have always travelled.
 */
function getWorkspaceDir(chatId) {
  const safeId = sanitizeId(chatId);
  const dir = path.join(DATA_DIR, 'sandboxes', safeId, 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The record of which files of the copy came from the pod: only those are removed when the pod no longer has them. */
function pulledManifestPath(chatId) {
  return path.join(DATA_DIR, 'sandboxes', sanitizeId(chatId), 'pod-files.json');
}

/** Files of the copy that stay on this side: never pushed, never counted as the pod's. */
const HOST_ONLY = name => name.startsWith('tts_') || name.startsWith('_tts_') || name.startsWith('.synthorg');

function entriesOf(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Every regular file under a folder: its place → size and time of change. Links are not files. */
function filesUnder(dir) {
  const out = new Map();
  const walk = (full, relative) => {
    for (const entry of entriesOf(full)) {
      const next = path.join(full, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(next, name);
      else if (entry.isFile()) { try { const stat = fs.statSync(next); out.set(name, { size: stat.size, at: stat.mtimeMs }); } catch {} }
    }
  };
  walk(dir, '');
  return out;
}

function dropEmptyDirs(dir) {
  for (const entry of entriesOf(dir)) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    dropEmptyDirs(full);
    try { if (!fs.readdirSync(full).length) fs.rmdirSync(full); } catch {}
  }
}

/**
 * Makes the copy hold what the pod holds. `from` is the volume as this side
 * sees it, `to` the copy; the manifest says which files of the copy came from
 * the pod the last time. A file the pod changed is copied again, one the pod
 * no longer has is removed from the copy if it came from the pod, and one that
 * was only ever on this side (a published archive, a spoken answer's audio) is
 * left alone. Returns what was copied and removed, and the files now the pod's.
 */
function mirrorFromPod(from, to, manifestFile) {
  let before = [];
  try { before = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).files || []; } catch {}
  const source = filesUnder(from);
  const kept = filesUnder(to);
  let copied = 0;
  let removed = 0;
  for (const [name, stat] of source) {
    if (name.split('/').some(HOST_ONLY)) continue;
    const have = kept.get(name);
    if (have && have.size === stat.size && Math.abs(have.at - stat.at) < 1000) continue;
    const target = path.join(to, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(from, name), target);
    try { fs.utimesSync(target, stat.at / 1000, stat.at / 1000); } catch {}
    copied += 1;
  }
  for (const name of before) {
    if (source.has(name) || !kept.has(name)) continue;
    try { fs.rmSync(path.join(to, name), { force: true }); removed += 1; } catch {}
  }
  dropEmptyDirs(to);
  const files = [...source.keys()].filter(name => !name.split('/').some(HOST_ONLY)).sort();
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify({ files }));
  return { copied, removed, files: files.length };
}

/** Adds files this side put into the pod to the record of the pod's files. */
function notePushed(manifestFile, names) {
  let files = [];
  try { files = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).files || []; } catch {}
  const all = new Set(files);
  for (const name of names) all.add(name);
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify({ files: [...all].sort() }));
}

/** A volume of the engine, made if it is not there. Says whether it was made now. */
async function ensureVolume(engineInfo, name) {
  const base = engineInfo.baseArgs || [];
  const exists = await runExec(engineInfo.bin, [...base, 'volume', 'exists', name], 10000);
  if (exists.ok) return { name, created: false };
  const made = await runExec(engineInfo.bin, [...base, 'volume', 'create', name], 20000);
  if (!made.ok) throw Object.assign(new Error(`Impossibile creare il volume ${name}: ${made.stderr || made.error}`), { status: 502 });
  return { name, created: true };
}

/**
 * Where a volume's files are, seen from this side: on the runtime of Windows
 * through the share WSL serves of the distro (never a mount the other way),
 * on a Linux host the folder of the user's own engine. Null when the volume
 * is not there, or the engine's files are not this user's to read (Docker).
 */
const volumeMounts = new Map();
async function volumeHostPath(engineInfo, volume) {
  if (volumeMounts.has(volume)) return volumeMounts.get(volume);
  const base = engineInfo.baseArgs || [];
  const res = await runExec(engineInfo.bin, [...base, 'volume', 'inspect', volume, '--format', '{{.Mountpoint}}'], 15000);
  const mount = (res.stdout || '').trim();
  if (!res.ok || !mount.startsWith('/')) return null;
  const host = engineInfo.isWsl ? `\\\\wsl.localhost\\${RUNTIME_DISTRO}${mount.split('/').join('\\')}` : mount;
  try { fs.accessSync(host, fs.constants.R_OK); } catch { return null; }
  volumeMounts.set(volume, host);
  return host;
}

function getSharedCacheDir() {
  const dir = path.join(DATA_DIR, 'packages', 'cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Mount points of the shared library store inside every container: one volume, two folders in it.
const SHARED_BASE = '/opt/synthorg';
const SHARED_PY = `${SHARED_BASE}/python`;
const SHARED_NODE = `${SHARED_BASE}/node`;

/**
 * The store of a given image lives in a volume of the engine, on the disk of
 * the pods: pip and npm write thousands of small files, and a folder of this
 * disk mounted in the runtime takes them ninety times slower (measured) than
 * the pods' own disk. The artifact cache stays here: it holds whole wheels and
 * tarballs, few and large, and the catalogue on the Environment page reads it.
 */
function libVolumeName(image) {
  return `synthorg-lib-${imageKey(image)}`;
}

/**
 * The shared store is keyed by image reference.
 *
 * Compiled wheels are bound to a libc and a Python version, both of which come
 * from the image: letting an Alpine (musl) container and a Debian (glibc) one
 * share one directory would hand each of them binaries it cannot load. Chats on
 * the same image share; a different image gets its own store.
 */
function imageKey(image) {
  return String(image || 'alpine:latest').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

/**
 * Host directories holding the packages every container sees.
 *
 * This is what makes an installed package present in a *new* container: the
 * store is mounted and put on PYTHONPATH/NODE_PATH, so nothing has to be
 * installed again when a chat spins up its own container.
 */
function sharedLibPaths(image) {
  const base = path.join(DATA_DIR, 'packages', 'lib', imageKey(image));
  return { base, python: path.join(base, 'python'), node: path.join(base, 'node') };
}

/** Same paths, created on disk. Only the container-creation path needs this:
 *  reporting status must not have side effects on the filesystem. */
function getSharedLibDirs(image) {
  const dirs = sharedLibPaths(image);
  fs.mkdirSync(dirs.python, { recursive: true });
  fs.mkdirSync(dirs.node, { recursive: true });
  return dirs;
}

/**
 * Whether a package is already in the shared Python store, checked on the host
 * so a container does not have to be started to find out.
 *
 * Distribution names are compared the way PEP 503 does — case-insensitive, with
 * runs of "-", "_" and "." treated as the same separator — because "typing-
 * extensions" is installed as "typing_extensions-4.12.0.dist-info".
 */
function normalizeDistName(value) {
  return String(value).toLowerCase().replace(/[-_.]+/g, '_');
}

function pythonPackagePresent(storeDir, name) {
  const wanted = normalizeDistName(name);
  let entries = [];
  try { entries = fs.readdirSync(storeDir); } catch { return false; }
  return entries.some(entry => {
    // "<dist>-<version>.dist-info" is the authoritative marker pip leaves.
    const meta = /^(.+?)-[^-]*\.(dist-info|egg-info|data)$/i.exec(entry);
    const candidate = meta ? meta[1] : entry.replace(/\.(py|pyd|so)$/i, '');
    return normalizeDistName(candidate) === wanted;
  });
}

function nodePackagePresent(storeDir, name) {
  return fs.existsSync(path.join(storeDir, 'node_modules', name));
}

function getContainerName(chatId) {
  // Bind the container 1:1 to the chat via a hash of the (idempotently
  // sanitized) id, so two chats can never collide on a truncated prefix. The
  // sanitize is idempotent, so callers passing the raw id or the safeId both
  // resolve to the same name.
  const hash = crypto.createHash('sha256').update(sanitizeId(chatId)).digest('hex').slice(0, 32);
  return `synthorg-chat-${hash}`;
}

/** The volume with the chat's files, named like its container (as a project's is). */
function chatVolumeName(chatId) {
  return getContainerName(chatId);
}

async function inspectContainer(engineInfo, containerName) {
  const args = [...(engineInfo.baseArgs || []), 'container', 'inspect', containerName];
  const res = await runExec(engineInfo.bin, args, 4000);
  if (!res.ok) return { exists: false, running: false };
  try {
    const data = JSON.parse(res.stdout);
    const state = data?.[0]?.State;
    return {
      exists: true,
      running: Boolean(state?.Running),
      status: state?.Status || 'created',
      image: data?.[0]?.ImageName || null,
      // Any bind mount means the container was created by an older SynthOrg,
      // when the workspace still lived on this disk.
      bindMounts: (data?.[0]?.Mounts || []).some(mount => mount?.Type === 'bind'),
      // A chat container from before the volumes: its workspace was a folder of this disk.
      workspaceBind: (data?.[0]?.Mounts || []).some(mount => mount?.Type === 'bind' && mount?.Destination === '/workspace'),
      // Without an init as pid 1, what an interrupted command leaves behind is never reaped.
      init: Boolean(data?.[0]?.HostConfig?.Init)
    };
  } catch {
    return { exists: true, running: false, status: 'unknown' };
  }
}

async function removeContainer(engineInfo, containerName) {
  const args = [...(engineInfo.baseArgs || []), 'rm', '-f', containerName];
  return runExec(engineInfo.bin, args, 30000);
}


/**
 * Preinstallation of the packages marked as active on the Environment page.
 *
 * The shared cache directory is an artifact folder: it holds real .whl and .tgz
 * files, which is what the catalogue scanner reads. Preinstall therefore works
 * in two steps — download into the folder when the package is missing, then
 * install from the folder with the index disabled. A package downloaded once is
 * installed offline by every later container, and because the artifact lands in
 * the folder under its own name, the Environment list grows on its own.
 *
 * The store and the cache are written only here, by a throwaway container that
 * runs nothing but the package manager. Chat containers mount both read-only:
 * what a model does in its own container can never change what another chat
 * imports, nor leave files for the desktop to pick up.
 */
const PREINSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const SAFE_PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

/**
 * Package names reach a shell inside the container. They originate from cache
 * filenames, so a crafted file could otherwise smuggle shell syntax into every
 * other chat's container.
 */
function shellSafePackages(packages, runtime) {
  return [...new Set(
    (packages || [])
      .filter(pkg => pkg && (pkg.runtime || 'python') === runtime)
      .map(pkg => String(pkg.name || '').trim())
      .filter(name => SAFE_PACKAGE_NAME.test(name))
  )];
}

// The script is handed to `sh -c` as a single argument and, on Windows, travels
// through wsl.exe's command-line translation, where embedded newlines do not
// survive. Commands are therefore joined with ";" and no shell variable is used:
// a lost separator would otherwise turn an assignment into an env prefix and
// silently blank the command that follows it.
const PIP_BASE = 'pip3 install --break-system-packages --no-input --disable-pip-version-check';

/**
 * Fills the shared Python store. Installing with --target writes into the
 * mounted directory rather than into this container, so the result is visible
 * to every container built on the same image, including ones created later.
 */
function pythonPreinstallScript(names, networkEnabled) {
  const list = names.join(' ');
  const install = `${PIP_BASE} --target ${SHARED_PY} --no-index --find-links /root/.cache`;
  const steps = [];
  steps.push(networkEnabled
    ? 'command -v pip3 >/dev/null 2>&1 || apk add --no-cache python3 py3-pip'
    : `command -v pip3 >/dev/null 2>&1 || { echo "[synthorg] python assente e rete disattivata: ${list} non installabili"; exit 1; }`);
  steps.push(`echo "[synthorg] installo nello store condiviso dalla cache: ${list}"`);
  const retry = networkEnabled
    ? `{ echo "[synthorg] non in cache, scarico: ${list}"; pip3 download --dest /root/.cache ${list} || true; ${install} ${list}; }`
    : `{ echo "[synthorg] mancante in cache e rete disattivata: ${list}"; exit 1; }`;
  steps.push(`${install} ${list} || ${retry}`);
  return steps.join('; ');
}

/** Same idea for Node: the store is a node_modules tree on NODE_PATH. */
function nodePreinstallScript(names, networkEnabled) {
  const list = names.join(' ');
  const steps = [];
  steps.push(networkEnabled
    ? 'command -v npm >/dev/null 2>&1 || apk add --no-cache nodejs npm'
    : `command -v npm >/dev/null 2>&1 || { echo "[synthorg] node assente e rete disattivata: ${list} non installabili"; exit 1; }`);
  if (networkEnabled) {
    // Deposits the tarballs in the shared folder so the catalogue can see them.
    steps.push(`npm pack --pack-destination /root/.cache ${list} >/dev/null 2>&1 || true`);
  }
  steps.push(`echo "[synthorg] installo nello store condiviso: ${list}"`);
  steps.push(networkEnabled
    ? `npm install --prefix ${SHARED_NODE} --no-fund --no-audit --cache /root/.cache/npm ${list}`
    : `npm install --prefix ${SHARED_NODE} --no-fund --no-audit --offline --cache /root/.cache/npm ${list}`);
  return steps.join('; ');
}

async function runInContainer(engineInfo, containerName, script, timeout, workdir = '/workspace') {
  const args = [...(engineInfo.baseArgs || []), 'exec', '-i', '-w', workdir, containerName, 'sh', '-c', script];
  return runExec(engineInfo.bin, args, timeout);
}

/**
 * Local image derived from a project's base image with what every project
 * container ships with: git, Node and the editor's runtime files. Built once
 * per base image and runtime build, so a project whose network is off still
 * has everything.
 */
const TOOLS_IMAGE_REPO = 'localhost/synthorg-code-tools';

/**
 * The canonical spelling of an image reference: `alpine`, `library/alpine`
 * and `docker.io/library/alpine:latest` are the same image and must share one
 * tools build and one cache.
 */
function normalizeImage(image) {
  let value = assertSafeImage(image);
  let digest = '';
  const at = value.indexOf('@');
  if (at !== -1) { digest = value.slice(at); value = value.slice(0, at); }
  const slash = value.indexOf('/');
  const first = slash === -1 ? '' : value.slice(0, slash);
  const looksLikeRegistry = first.includes('.') || first.includes(':') || first === 'localhost';
  if (slash === -1) value = `docker.io/library/${value}`;
  else if (!looksLikeRegistry) value = `docker.io/${value}`;
  const lastSlash = value.lastIndexOf('/');
  if (!value.slice(lastSlash).includes(':') && !digest) value += ':latest';
  return value + digest;
}

/**
 * The editor's runtime, shipped into the tools image: the extension host,
 * the bundled extensions, the shell integration scripts and the agent. In the
 * repository these sit in vendor/ and resources/; in the installed app the
 * resource directory is the root itself.
 */
const CODE_RUNTIME_DIR = '/opt/synthorg-code';
const CODE_AGENT = `${CODE_RUNTIME_DIR}/agent.cjs`;
const firstExisting = candidates => candidates.find(dir => fs.existsSync(dir)) || candidates[0];
const CODE_RUNTIME_SOURCES = {
  'agent.cjs': path.join(__dirname, 'code-agent.cjs'),
  // The editor itself: C sources, compiled inside the image they will run in.
  'editor-src': path.join(__dirname, 'code-editor'),
  'extension-host': firstExisting([path.join(ROOT, 'vendor', 'sidex', 'src-tauri', 'extension-host'), path.join(ROOT, 'extension-host')]),
  'shell-integration': firstExisting([path.join(ROOT, 'vendor', 'sidex', 'src', 'vs', 'workbench', 'contrib', 'terminal', 'common', 'scripts'), path.join(ROOT, 'shell-integration')]),
  extensions: firstExisting([path.join(ROOT, 'resources', 'extensions'), path.join(ROOT, 'extensions')])
};

/** Which editor extensions the user kept. Absent means all of them. */
const EXTENSIONS_MANIFEST = path.join(DATA_DIR, 'code-extensions.json');

/** The catalogue the Environment page lists and the image build reads. */
function createExtensionCatalog(root = ROOT) {
  const dir = root === ROOT
    ? CODE_RUNTIME_SOURCES.extensions
    : firstExisting([path.join(root, 'resources', 'extensions'), path.join(root, 'extensions')]);
  return new CodeExtensionCatalog({ dir, manifestPath: path.join(dataDirFor(root), 'code-extensions.json') });
}

/**
 * Identifies this runtime build: a changed agent, extension host or extension
 * bundle yields a new tools image, so existing projects pick the change up on
 * their next open.
 */
/**
 * What the sources are, never when they were written. A build of SynthOrg
 * copies the extensions again (scripts/build-code.js) and an installer writes
 * every file anew: their dates change, their bytes do not, and an image made
 * from the same bytes is the same image. Measured: with dates in the stamp the
 * tools image was rebuilt (9 s, the apk install and 40 MB of extensions copied
 * in) after every build, and every project container recreated with it.
 */
function sourcesStamp({ files = [], dirs = [] }) {
  const hash = crypto.createHash('sha256');
  const one = (label, full) => {
    hash.update(`${label}:`);
    try { hash.update(fs.readFileSync(full)); } catch { hash.update('missing'); }
    hash.update(';');
  };
  for (const [label, full] of files) one(label, full);
  for (const [label, dir] of dirs) {
    let listed = [];
    try { listed = editorSourceFiles(dir); } catch { hash.update(`${label}:missing;`); continue; }
    for (const full of listed) one(`${label}/${path.relative(dir, full).split(path.sep).join('/')}`, full);
  }
  return hash.digest('hex');
}

// The sources are read once: forty megabytes of extensions do not change while
// the service runs. Which of them the user keeps can, so the manifest is read every time.
let cachedSources = null;
function runtimeStamp() {
  if (!cachedSources) {
    cachedSources = sourcesStamp({
      files: [
        ['agent', CODE_RUNTIME_SOURCES['agent.cjs']],
        ...['server.cjs', 'host.cjs'].map(name => [`host/${name}`, path.join(CODE_RUNTIME_SOURCES['extension-host'], name)])
      ],
      dirs: [['editor', CODE_RUNTIME_SOURCES['editor-src']], ['extensions', CODE_RUNTIME_SOURCES.extensions]]
    });
  }
  // Which extensions the user kept is part of what the image *is*: turning one
  // off has to give the next project a different image, or the megabytes would
  // stay in it and only stop being loaded.
  return crypto.createHash('sha256').update(cachedSources).update(readManifest()).digest('hex').slice(0, 10);
}

function readManifest() {
  try { return fs.readFileSync(EXTENSIONS_MANIFEST); } catch { return Buffer.from('missing'); }
}

function toolsImageRef(image) {
  return `${TOOLS_IMAGE_REPO}:${imageKey(normalizeImage(image)).toLowerCase()}-${runtimeStamp()}`;
}

/**
 * The editor, built once and shipped.
 *
 * Compiling it needs a C toolchain, and a toolchain is two hundred megabytes
 * to produce one megabyte of program. That cost belongs to whoever builds
 * SynthOrg, not to whoever uses it: `npm run build:editor` compiles it in a
 * throwaway container and leaves the binary and its two fonts here, and every
 * environment afterwards just copies them in.
 *
 * The stamp is what keeps it honest. A prebuilt binary is used only if it was
 * made from exactly these sources; change one line of C and it is ignored,
 * and the container compiles as it used to until the build is run again.
 */
// Outside resources/ on purpose: that directory is the frontend, and every
// file in it is also embedded into the executable as a web asset. A binary
// and two fonts have no business being served to a webview; they travel as a
// bundle resource instead, next to server/ and extensions/.
const EDITOR_PREBUILT_DIR = firstExisting([path.join(ROOT, 'code-editor-bin'), path.join(ROOT, 'resources', 'code-editor-bin')]);

/** Which binary belongs in a container on this machine. */
function containerArch(arch = process.arch) {
  return arch === 'arm64' ? 'aarch64' : 'x86_64';
}

/** Every file of the editor's sources, subdirectories included, in a stable order. */
function editorSourceFiles(dir = CODE_RUNTIME_SOURCES['editor-src']) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...editorSourceFiles(full)); else out.push(full);
  }
  return out;
}

function editorSourceStamp() {
  const hash = crypto.createHash('sha256');
  const dir = CODE_RUNTIME_SOURCES['editor-src'];
  for (const file of editorSourceFiles(dir)) {
    hash.update(`${path.relative(dir, file).split(path.sep).join('/')}:`);
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex').slice(0, 16);
}

/** The prebuilt editor for this machine, or null if there is none to trust. */
function prebuiltEditor(arch = process.arch, dir = EDITOR_PREBUILT_DIR) {
  const binary = path.join(dir, `editor-${containerArch(arch)}`);
  const mono = path.join(dir, 'mono.ttf');
  const ui = path.join(dir, 'ui.ttf');
  const stampFile = path.join(dir, 'build.json');
  if (![binary, mono, ui, stampFile].every(file => fs.existsSync(file))) return null;
  try {
    const built = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
    if (built.sources !== editorSourceStamp()) return null;
  } catch { return null; }
  return { dir, binary, mono, ui };
}

/** Package downloads survive across tools builds, in a volume of the engine. */
const PACKAGE_CACHE_MOUNTS = ['synthorg-cache-apk:/etc/apk/cache'];

/**
 * What every project container ships with. Only Alpine-based images are
 * supported: a single package manager, and the smallest runtime there is.
 * One line, ";"-joined, for the same wsl.exe reason as the preinstall scripts.
 */
const TOOLS_INSTALL_SCRIPT = [
  'command -v apk >/dev/null 2>&1 || { echo "[synthorg] solo immagini basate su Alpine sono supportate per i progetti" >&2; exit 1; }',
  'mkdir -p /etc/apk/cache',
  'apk add git nodejs bash',
  'command -v git >/dev/null 2>&1 || { echo "[synthorg] git non installato" >&2; exit 1; }',
  'command -v bash >/dev/null 2>&1 || { echo "[synthorg] bash non installato" >&2; exit 1; }',
  'command -v node >/dev/null 2>&1 || { echo "[synthorg] node non installato" >&2; exit 1; }'
].join('; ');

/**
 * Builds the project editor (server/code-editor) where it will run: one static
 * binary and two fonts. The compiler and the font package are only there for
 * the build; what stays in the image is about 1 MB.
 */
const EDITOR_BUILD_SCRIPT = [
  'apk add --virtual .synthorg-build build-base ttf-dejavu',
  `mkdir -p ${CODE_RUNTIME_DIR}/fonts`,
  `cp /usr/share/fonts/dejavu/DejaVuSansMono.ttf ${CODE_RUNTIME_DIR}/fonts/mono.ttf`,
  `cp /usr/share/fonts/dejavu/DejaVuSans.ttf ${CODE_RUNTIME_DIR}/fonts/ui.ttf`,
  `cd ${CODE_RUNTIME_DIR}/editor-src`,
  `gcc -O2 -static -o ${CODE_RUNTIME_DIR}/editor main.c vterm/src/*.c -Ivterm/include -lm`,
  `strip ${CODE_RUNTIME_DIR}/editor`,
  'cd /',
  `rm -rf ${CODE_RUNTIME_DIR}/editor-src`,
  'apk del .synthorg-build'
].join(' && ');

const TOOLS_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Base image of a new project and of a new chat: ours, imported from the
 * archive in the master folder. No registry is involved, and the version is
 * the one this build pinned rather than whatever "latest" means today.
 */
const DEFAULT_PROJECT_IMAGE = BASE_IMAGE;

/**
 * Puts the base image in the engine if it is not there yet, from the archive
 * kept once in the master folder. Checked when an environment is created and
 * not otherwise: an engine that already holds this version does nothing, and
 * the download happens only the first time this machine ever needs it.
 */
async function ensureBaseImage(engineInfo, store) {
  const base = engineInfo.baseArgs || [];
  const exists = await runExec(engineInfo.bin, [...base, 'image', 'exists', store.image], 10000);
  if (exists.ok) return store.image;
  const archive = await store.ensure();
  // The archive travels on the engine's standard input: the distro has no view of this disk.
  const imported = await runExecFromFile(engineInfo.bin, [...base, 'import', '-', store.image], archive, 5 * 60 * 1000);
  if (!imported.ok) {
    throw Object.assign(
      new Error(`Impossibile importare l'immagine base ${store.image}: ${imported.stderr || imported.stdout || imported.error}`),
      { status: 502 }
    );
  }
  return store.image;
}

const TOOLS_CHECK_SCRIPT = `command -v git >/dev/null 2>&1 && echo git; command -v bash >/dev/null 2>&1 && echo bash; command -v node >/dev/null 2>&1 && echo node; test -f ${CODE_AGENT} && echo agent; test -x ${CODE_RUNTIME_DIR}/editor && echo editor`;

/**
 * Returns the image a project container should be created from: the tools
 * image for `image`, built now if this engine does not have it yet. The build
 * runs in a throwaway container with network access and is committed, so the
 * project container itself never needs the network for git or the editor.
 */
async function ensureToolsImage(engineInfo, image, baseImages) {
  const base = engineInfo.baseArgs || [];
  const ref = toolsImageRef(image);
  const exists = await runExec(engineInfo.bin, [...base, 'image', 'exists', ref], 10000);
  if (exists.ok) return { image: ref, built: false };
  // Building on our own base means importing it first; any other image the
  // user chose is the engine's business, as it always was.
  if (baseImages && normalizeImage(image) === normalizeImage(baseImages.image)) {
    await ensureBaseImage(engineInfo, baseImages);
  }

  const name = `synthorg-code-tools-${crypto.randomBytes(4).toString('hex')}`;
  const wsl = Boolean(engineInfo.isWsl);
  try {
    // No workspace is mounted here, so the image's own root is the workdir.
    // The package cache is: a second build on the same image downloads nothing.
    const run = await runExec(engineInfo.bin, [...base, ...hardenedRunArgs({
      name, network: await ensureNetwork(engineInfo, 'build', true), image: normalizeImage(image), mounts: PACKAGE_CACHE_MOUNTS, memory: '1g', cpus: '1.0', pids: 256, workdir: '/', seccomp: await ensureSeccompProfile(engineInfo)
    })], TOOLS_BUILD_TIMEOUT_MS);
    if (!run.ok) throw new Error(`Impossibile avviare ${image} per preparare gli strumenti: ${run.stderr || run.stdout || run.error}`);
    const install = await runInContainer(engineInfo, name, TOOLS_INSTALL_SCRIPT, TOOLS_BUILD_TIMEOUT_MS, '/');
    if (!install.ok) throw new Error(`Strumenti non installabili in ${image}: ${(install.stderr || install.stdout || install.error || '').trim().split(/\r?\n/).slice(-2).join(' ')}`);
    // The editor's runtime, from this SynthOrg build. `podman cp dir/. target/` needs the target to exist.
    const prepare = await runInContainer(engineInfo, name, `mkdir -p ${CODE_RUNTIME_DIR}/extension-host ${CODE_RUNTIME_DIR}/shell-integration ${CODE_RUNTIME_DIR}/extensions ${CODE_RUNTIME_DIR}/editor-src ${CODE_RUNTIME_DIR}/fonts`, 30000, '/');
    if (!prepare.ok) throw new Error(`Impossibile preparare ${CODE_RUNTIME_DIR}: ${prepare.stderr || prepare.error}`);
    // Shipped already compiled: the container never sees a C toolchain.
    const prebuilt = prebuiltEditor();
    for (const [target, source] of Object.entries(CODE_RUNTIME_SOURCES)) {
      if (prebuilt && target === 'editor-src') continue;
      if (!fs.existsSync(source)) throw new Error(`File del runtime dell'editor mancante: ${source}`);
      const isDir = fs.statSync(source).isDirectory();
      const copy = isDir
        ? await copyIntoContainer(engineInfo, source, name, `${CODE_RUNTIME_DIR}/${target}`)
        : await copyIntoContainer(engineInfo, source, name, CODE_RUNTIME_DIR, target);
      if (!copy.ok) throw new Error(`Copia di ${target} nell'immagine non riuscita: ${copy.stderr || copy.error}`);
    }
    // The extensions the user switched off never reach the committed image:
    // they are dropped before the commit, so they are absent from it and not
    // merely unloaded.
    const extensions = new CodeExtensionCatalog({ dir: CODE_RUNTIME_SOURCES.extensions, manifestPath: EXTENSIONS_MANIFEST });
    const dropped = extensions.list().filter(item => !item.enabled).map(item => item.name);
    if (dropped.length) {
      const target = `${CODE_RUNTIME_DIR}/extensions`;
      const keptAny = extensions.list().some(item => item.enabled);
      const names = [...dropped, ...(keptAny ? [] : [SHARED_MODULES])]
        .map(name => `'${target}/${name.replace(/'/g, "'\\''")}'`)
        .join(' ');
      const prune = await runInContainer(engineInfo, name, `rm -rf ${names}`, 5 * 60 * 1000, '/');
      if (!prune.ok) throw new Error(`Impossibile togliere le estensioni disattivate: ${prune.stderr || prune.error}`);
    }

    if (prebuilt) {
      // A copy and a chmod, instead of two hundred megabytes of compiler.
      for (const [file, dir, as] of [[prebuilt.binary, CODE_RUNTIME_DIR, 'editor'], [prebuilt.mono, `${CODE_RUNTIME_DIR}/fonts`, 'mono.ttf'], [prebuilt.ui, `${CODE_RUNTIME_DIR}/fonts`, 'ui.ttf']]) {
        const copy = await copyIntoContainer(engineInfo, file, name, dir, as);
        if (!copy.ok) throw new Error(`Copia dell'editor già compilato non riuscita: ${copy.stderr || copy.error}`);
      }
      const ready = await runInContainer(engineInfo, name, `chmod 755 ${CODE_RUNTIME_DIR}/editor && ${CODE_RUNTIME_DIR}/editor --version >/dev/null 2>&1 || test -x ${CODE_RUNTIME_DIR}/editor`, 60000, '/');
      if (!ready.ok) throw new Error(`L'editor già compilato non è utilizzabile in questa immagine: ${ready.stderr || ready.error}`);
    } else {
      const editor = await runInContainer(engineInfo, name, EDITOR_BUILD_SCRIPT, TOOLS_BUILD_TIMEOUT_MS, '/');
      if (!editor.ok) throw new Error(`Compilazione dell'editor non riuscita: ${(editor.stderr || editor.stdout || editor.error || '').trim().split(/\r?\n/).slice(-3).join(' ')}`);
    }
    const commit = await runExec(engineInfo.bin, [...base, 'commit', '-q', name, ref], TOOLS_BUILD_TIMEOUT_MS);
    if (!commit.ok) throw new Error(`Impossibile salvare l'immagine ${ref}: ${commit.stderr || commit.error}`);
  } finally {
    await removeContainer(engineInfo, name).catch(() => {});
  }
  // Earlier runtime builds of the same base image are superseded: a container
  // still on one of them is recreated on its next open, so nothing keeps them.
  const prefix = ref.slice(0, ref.lastIndexOf('-') + 1);
  const listed = await runExec(engineInfo.bin, [...base, 'images', '--format', '{{.Repository}}:{{.Tag}}', TOOLS_IMAGE_REPO], 10000);
  for (const old of (listed.stdout || '').split(/\s+/).filter(tag => tag.startsWith(prefix) && tag !== ref)) {
    await runExec(engineInfo.bin, [...base, 'rmi', old], 60000);
  }
  return { image: ref, built: true };
}

/**
 * `run` arguments every SynthOrg container is created with. Only the name,
 * mounts, environment and resource limits differ between chat sandboxes and
 * code projects; the hardening does not. No device is ever passed: a
 * container renders, computes and builds on the CPU alone.
 */
const PACKAGE_MANAGER_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETGID', 'SETUID', 'KILL'];

function hardenedRunArgs({ name, network, image, mounts = [], env = [], memory, cpus, pids, workdir = '/workspace', userns = true, extra = [], capAdd = PACKAGE_MANAGER_CAPS, seccomp = null }) {
  return [
    'run', '-d',
    // catatonit as pid 1: it reaps what interrupted commands leave behind.
    '--init',
    `--name=${name}`,
    `--network=${network}`,
    ...mounts.flatMap(mount => ['-v', mount]),
    ...env.flatMap(entry => ['--env', entry]),
    '-w', workdir,
    `--memory=${memory}`,
    ...cpuArgs(cpus),
    `--pids-limit=${pids}`,
    // PID 1 does not handle SIGTERM; without this the engine waits its full
    // default grace period on every stop or reset.
    '--stop-timeout=1',
    '--security-opt=no-new-privileges',
    // Our tightened profile when we have it; without it the engine's default,
    // never unconfined.
    ...(seccomp ? ['--security-opt', `seccomp=${seccomp}`] : []),
    // Start from no capabilities and add back only what a package manager
    // needs to unpack and chown files. This drops, among others, MKNOD
    // (device creation), SYS_CHROOT, NET_RAW (raw sockets and ARP tricks when
    // networking is on) and SETFCAP/SETPCAP (file capabilities), none of which
    // a code sandbox has any use for.
    '--cap-drop=ALL',
    ...capAdd.map(cap => `--cap-add=${cap}`),
    // Root inside is not the user outside; see USERNS_ARGS.
    ...(userns ? USERNS_ARGS : []),
    ...extra,
    image,
    'sleep', 'infinity'
  ];
}

const CHAT_CONTAINER_PREFIX = 'synthorg-chat-';
const PROJECT_CONTAINER_PREFIX = 'synthorg-code-';
const PROJECT_CONTAINER_PATTERN = /^synthorg-code-[a-z0-9][a-z0-9_.-]{0,62}$/;
// Git with a credential runs in a throwaway container built from the
// project's own tools image, which already carries git. Nothing is pulled
// from a registry for it, and there is no shell in between: the command is
// git and its arguments.

/**
 * A project container name reaches the engine as an argument, like the image:
 * the fixed prefix plus a leading alphanumeric keeps it from being read as a
 * flag, and from ever naming a chat's container. The project's volume, where
 * its files live, carries the same name.
 */
function assertProjectContainerName(name) {
  const value = String(name == null ? '' : name);
  if (!PROJECT_CONTAINER_PATTERN.test(value)) {
    throw Object.assign(new Error(`Nome container non valido: "${value}".`), { status: 400 });
  }
  return value;
}

/**
 * Which images of ours are superseded: of each repository a keeper says which
 * tags are the ones this build makes (the stamp of now); every other tag of
 * that repository is a build of before, kept on disk by nothing.
 */
function imagesToDrop(refs, keepers) {
  const out = [];
  for (const ref of refs) {
    const colon = ref.lastIndexOf(':');
    if (colon <= 0) continue;
    const repo = ref.slice(0, colon);
    const tag = ref.slice(colon + 1);
    const keeper = keepers.find(item => item.repo === repo);
    if (keeper && !keeper.keep(tag)) out.push(ref);
  }
  return out;
}

/**
 * Images of earlier builds removed, with the stopped containers of projects
 * and desktops still made from them: those are made again at their next open,
 * from the image of now, their files being in their volumes. What no image
 * names any more (dangling layers) goes too. A running container keeps its
 * image: the engine refuses, and the next cleanup gets it.
 */
async function pruneImages(engineInfo, keepers = []) {
  const base = engineInfo.baseArgs || [];
  const listed = await runExec(engineInfo.bin, [...base, 'images', '--format', '{{.Repository}}:{{.Tag}}'], 20000);
  const refs = (listed.stdout || '').split(/\s+/).filter(Boolean);
  let removed = 0;
  for (const ref of imagesToDrop(refs, keepers)) {
    const on = await runExec(engineInfo.bin, [...base, 'ps', '-a', '--filter', `ancestor=${ref}`, '--format', '{{.Names}} {{.State}}'], 15000);
    for (const line of (on.stdout || '').split(/\r?\n/).filter(Boolean)) {
      const [name, state] = line.trim().split(/\s+/);
      if (state !== 'running' && (name.startsWith(PROJECT_CONTAINER_PREFIX) || name.startsWith('synthorg-desk-'))) await removeContainer(engineInfo, name).catch(() => {});
    }
    const gone = await runExec(engineInfo.bin, [...base, 'rmi', ref], 120000);
    if (gone.ok) removed += 1;
  }
  const dangling = await runExec(engineInfo.bin, [...base, 'image', 'prune', '-f'], 120000);
  return { removed, dangling: (dangling.stdout || '').split(/\s+/).filter(Boolean).length };
}

/** The names in what `wsl.exe --list` prints: UTF-16 read as bytes, one name a line. */
function parseDistroList(stdout) {
  return String(stdout || '').replace(/[\u0000\r]/g, '').split('\n').map(line => line.trim()).filter(Boolean);
}

/** Whether the runtime is on this machine: asked of the list, which starts nothing. */
async function runtimeRegistered() {
  const listed = await runExec('wsl.exe', ['--list', '--quiet'], 10000);
  return parseDistroList(listed.stdout).includes(RUNTIME_DISTRO);
}

async function runtimeRunning() {
  const running = await runExec('wsl.exe', ['--list', '--running', '--quiet'], 10000);
  return parseDistroList(running.stdout).includes(RUNTIME_DISTRO);
}

/** The folder of the runtime's disk, as WSL registered it; null when the runtime is not registered. */
async function runtimeBasePath() {
  const query = await runExec('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s'], 10000);
  if (!query.ok) return null;
  let base = null;
  let named = false;
  for (const raw of String(query.stdout || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('HKEY_')) { if (named && base) break; base = null; named = false; continue; }
    const value = /^(\S+)\s+REG_SZ\s+(.*)$/.exec(line);
    if (!value) continue;
    if (value[1] === 'DistributionName') named = value[2].trim() === RUNTIME_DISTRO;
    if (value[1] === 'BasePath') base = value[2].trim().replace(/^\\\\\?\\/, '');
  }
  return named && base ? base : null;
}

/**
 * The runtime's disk as a file of this computer: what it takes, and what is
 * really in it (asked of the runtime only when it is already running: the
 * number is not worth starting the machine for). The file only grows: what the
 * pods free inside it is used again by them, never given back to this disk.
 * `compactRuntime` is what gives it back.
 */
const IMPORT_NOTE = path.join(DATA_DIR, 'runtime-import.json');
async function runtimeDisk() {
  if (process.platform !== 'win32') return { supported: false };
  const base = await runtimeBasePath();
  const note = readImportNote();
  if (!base) return { supported: true, registered: false, pending: Boolean(note) };
  const file = path.join(base, 'ext4.vhdx');
  let bytes = null;
  try { bytes = fs.statSync(file).size; } catch {}
  let used = null;
  if (await runtimeRunning()) {
    const df = await runExec('wsl.exe', ['-d', RUNTIME_DISTRO, '--exec', 'df', '-k', '/'], 15000);
    const row = (df.stdout || '').split(/\r?\n/).find(line => /\s\/\s*$/.test(line));
    const usedKb = row ? Number(row.trim().split(/\s+/)[2]) : NaN;
    if (Number.isFinite(usedKb)) used = usedKb * 1024;
  }
  return { supported: true, registered: true, file, bytes, used, pending: Boolean(note) };
}

function readImportNote() {
  try { return JSON.parse(fs.readFileSync(IMPORT_NOTE, 'utf8')); } catch { return null; }
}

/**
 * The runtime made again from its archive: the step of `compactRuntime` that
 * may be left half done if the app stops in it, finished at the next start.
 * The archive is the runtime until the import has succeeded, and only then
 * goes.
 */
async function importRuntime(note) {
  if (!note || !note.tar || !note.base) return false;
  if (!fs.existsSync(note.tar)) { fs.rmSync(IMPORT_NOTE, { force: true }); return false; }
  let imported = null;
  for (let attempt = 0; attempt < 2 && !(imported && imported.ok); attempt++) {
    imported = await runExec('wsl.exe', ['--import', RUNTIME_DISTRO, note.base, note.tar, '--version', '2'], 60 * 60 * 1000);
  }
  if (!imported.ok) {
    throw Object.assign(new Error(`Il runtime non si è potuto reimportare da ${note.tar}: ${parseDistroList(imported.stderr || imported.stdout).join(' ') || imported.error}. L'archivio è lì: riprova dalle impostazioni, o riavvia l'app.`), { status: 502 });
  }
  fs.rmSync(note.tar, { force: true });
  fs.rmSync(IMPORT_NOTE, { force: true });
  return true;
}

class SandboxManager {
  constructor(options = {}) {
    this.root = options.root || ROOT;
    // Supplied by the server so the sandbox layer stays unaware of the manifest.
    this.defaultPackages = typeof options.defaultPackages === 'function' ? options.defaultPackages : () => [];
    this.onCacheChanged = typeof options.onCacheChanged === 'function' ? options.onCacheChanged : () => {};
    this.preinstalls = new Map();
    this._storeLocks = new Map();
    // The copies of the chats' files being brought up to date, and when each last was.
    this._pulls = new Map();
    this._pulledAt = new Map();
    // Commands of the model still running, by run id: the stop button ends them.
    this.runs = new Map();
    // The master folder: one download of the base image, for good, outside any
    // project and outside the engine. Removing every project leaves it there.
    this.baseImages = options.baseImages || new BaseImageStore({ dir: path.join(dataDirFor(this.root), 'images') });
  }

  preinstallStatus(chatId) {
    return this.preinstalls.get(sanitizeId(chatId)) || { state: 'none', packages: [], log: '' };
  }

  /**
   * Runs detached: a fresh Alpine has neither python nor node, so a first
   * preinstall can take minutes and must never block the exec that triggered it.
   * Progress is readable through GET /sandbox. The work happens in a throwaway
   * container of the chat's image, the only kind that mounts the store and the
   * cache read-write.
   */
  /**
   * The store of an image, as the containers mount it and as this side reads
   * it: a volume of the engine when its files can be read from here, else (an
   * engine whose files are not this user's, Docker) the folders of this disk,
   * mounted as they always were. `mount(mode)` gives the `-v` arguments.
   */
  async storeOf(engineInfo, image) {
    const volume = libVolumeName(image);
    let host = null;
    try {
      await ensureVolume(engineInfo, volume);
      host = await volumeHostPath(engineInfo, volume);
    } catch { host = null; }
    if (host) {
      return { volume, python: path.join(host, 'python'), node: path.join(host, 'node'), mount: mode => [`${volume}:${SHARED_BASE}:${mode}`] };
    }
    const dirs = getSharedLibDirs(image);
    const wsl = Boolean(engineInfo.isWsl);
    return {
      volume: null, python: dirs.python, node: dirs.node,
      mount: mode => [`${toContainerMountPath(dirs.python, wsl)}:${SHARED_PY}:${mode}`, `${toContainerMountPath(dirs.node, wsl)}:${SHARED_NODE}:${mode}`]
    };
  }

  _startPreinstall(safeId, engineInfo, options = {}) {
    let packages = [];
    try { packages = this.defaultPackages() || []; } catch { packages = []; }
    const image = assertSafeImage(options.image);

    const python = shellSafePackages(packages, 'python');
    const node = shellSafePackages(packages, 'nodejs');
    const all = [...python, ...node];

    // No package marked active: nothing to look at, not even the store.
    if (!all.length) {
      this.preinstalls.set(safeId, {
        state: 'done', packages: [], fromStore: [], installed: [],
        log: 'Nessun pacchetto attivo da preinstallare.',
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
      });
      return;
    }

    const networkEnabled = Boolean(options.networkEnabled);
    const entry = {
      state: 'running',
      packages: all,
      fromStore: [],
      installed: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      log: ''
    };
    this.preinstalls.set(safeId, entry);

    // One store, one writer: two chats filling the same directory at once would
    // race on the same dist-info trees.
    const key = imageKey(image);
    const previous = this._storeLocks.get(key) || Promise.resolve();
    const task = previous.then(async () => {
      const store = await this.storeOf(engineInfo, image);
      // Only what the shared store is missing needs a container to do any work.
      // A chat whose packages are already there starts with them importable and
      // not a single command runs.
      const missingPython = python.filter(name => !pythonPackagePresent(store.python, name));
      const missingNode = node.filter(name => !nodePackagePresent(store.node, name));
      entry.installed = [...missingPython, ...missingNode];
      entry.fromStore = all.filter(name => !entry.installed.includes(name));
      if (!entry.installed.length) {
        entry.state = 'done';
        entry.finishedAt = new Date().toISOString();
        entry.log = `Già presenti nello store condiviso (${key}): ${all.join(', ')}.`;
        this.preinstalls.set(safeId, entry);
        return;
      }

      const chunks = [];
      let failed = false;
      const steps = [];
      if (missingPython.length) steps.push(['python', pythonPreinstallScript(missingPython, networkEnabled)]);
      if (missingNode.length) steps.push(['nodejs', nodePreinstallScript(missingNode, networkEnabled)]);

      const name = `synthorg-preinstall-${crypto.randomBytes(4).toString('hex')}`;
      const wsl = Boolean(engineInfo.isWsl);
      try {
        const run = await runExec(engineInfo.bin, [...(engineInfo.baseArgs || []), ...hardenedRunArgs({
          name,
          network: networkEnabled ? 'bridge' : 'none',
          image,
          userns: false,
          mounts: [
            `${toContainerMountPath(getSharedCacheDir(), wsl)}:/root/.cache:rw`,
            ...store.mount('rw')
          ],
          memory: '1g', cpus: '1.0', pids: 256, workdir: '/', seccomp: await ensureSeccompProfile(engineInfo)
        })], 60000);
        if (!run.ok) throw new Error(`Impossibile avviare il container di installazione: ${run.stderr || run.stdout || run.error}`);
        for (const [runtime, script] of steps) {
          const res = await runInContainer(engineInfo, name, script, PREINSTALL_TIMEOUT_MS, '/');
          chunks.push(`--- ${runtime} ---\n${(res.stdout || '').trim()}\n${(res.stderr || '').trim()}`.trim());
          if (!res.ok) failed = true;
        }
      } finally {
        await removeContainer(engineInfo, name).catch(() => {});
      }

      entry.state = failed ? 'failed' : 'done';
      entry.finishedAt = new Date().toISOString();
      entry.log = chunks.join('\n\n').slice(-8000);
      this.preinstalls.set(safeId, entry);

      // Artifacts just downloaded into the shared folder become catalogue entries.
      try { await this.onCacheChanged(); } catch {}
    }).catch(error => {
      entry.state = 'failed';
      entry.finishedAt = new Date().toISOString();
      entry.log = `${entry.log}\n${error.message}`.trim().slice(-8000);
      this.preinstalls.set(safeId, entry);
    });

    this._storeLocks.set(key, task);
  }

  async getStatus(chatId, conversationData = {}) {
    const engineInfo = await detectEngine();
    const safeId = sanitizeId(chatId);
    const containerName = getContainerName(safeId);
    const workspaceDir = getWorkspaceDir(safeId);
    const image = conversationData.sandbox_image || 'alpine:latest';

    let containerInfo = { exists: false, running: false, status: 'not_created' };
    if (engineInfo.available) {
      containerInfo = await inspectContainer(engineInfo, containerName);
    }

    return {
      chatId: safeId,
      engine: {
        type: engineInfo.engine,
        available: engineInfo.available,
        version: engineInfo.version,
        isPodman: engineInfo.engine === 'podman',
        isEmbedded: Boolean(engineInfo.isEmbedded),
        label: engineInfo.label || engineInfo.engine
      },
      container: {
        name: containerName,
        exists: containerInfo.exists,
        running: containerInfo.running,
        status: containerInfo.status
      },
      preinstall: this.preinstallStatus(safeId),
      sharedStore: {
        key: imageKey(image),
        // The volume of the engine that holds it; shown where a folder was shown before.
        relative: libVolumeName(image)
      },
      networkEnabled: Boolean(conversationData.sandbox_network),
      terminalEnabled: Boolean(conversationData.sandbox_terminal),
      desktopEnabled: Boolean(conversationData.sandbox_desktop),
      image,
      workspacePath: workspaceDir,
      workspaceRelative: path.relative(this.root, workspaceDir)
    };
  }

  async ensureContainerRunning(chatId, options = {}, engineInfo) {
    const safeId = sanitizeId(chatId);
    const containerName = getContainerName(safeId);
    let info = await inspectContainer(engineInfo, containerName);

    // A container from before the volumes mounted a folder of this disk as its
    // workspace: it is made again on the volume, which takes the folder's files.
    if (info.exists && info.workspaceBind) {
      await removeContainer(engineInfo, containerName).catch(() => {});
      info = { exists: false, running: false };
    }

    if (info.exists && info.running) {
      return containerName;
    }

    if (info.exists && !info.running) {
      // Container exists but was paused/stopped: resume it instantly preserving all installed packages
      const startRes = await runExec(engineInfo.bin, [...(engineInfo.baseArgs || []), 'start', containerName], 8000);
      if (startRes.ok) {
        // Activating a package should take effect the next time the container
        // starts, not only when it is recreated. When the shared store already
        // holds everything this returns without running any command.
        this._startPreinstall(safeId, engineInfo, options);
        return containerName;
      }
      // If start failed (e.g. image corrupt), remove and recreate below
      await removeContainer(engineInfo, containerName).catch(() => {});
    }

    // Create fresh persistent container for this chat: its files in its volume,
    // the shared package cache and the shared library store beside them.
    const image = assertSafeImage(options.image);
    const workspace = await this.ensureChatWorkspace(safeId, engineInfo);
    const store = await this.storeOf(engineInfo, image);
    const mountCache = toContainerMountPath(getSharedCacheDir(), Boolean(engineInfo.isWsl));
    // The chat's own isolated network (its sandbox and its desktop share it,
    // being one environment); none when the chat has no Internet.
    const network = await ensureNetwork(engineInfo, `chat-${safeId}`, options.networkEnabled);

    const createArgs = [
      ...(engineInfo.baseArgs || []),
      ...hardenedRunArgs({
        name: containerName,
        network,
        image,
        userns: false,
        mounts: [
          `${workspace.source}:/workspace:rw`,
          // The cache and the shared library store are locked for the chat:
          // packages installed once are importable in every container built
          // on the same image, but only the preinstall step ever writes them.
          `${mountCache}:/root/.cache:ro`,
          ...store.mount('ro')
        ],
        env: [
          `PYTHONPATH=${SHARED_PY}`,
          `NODE_PATH=${SHARED_NODE}/node_modules`,
          `PATH=${SHARED_PY}/bin:${SHARED_NODE}/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
        ],
        memory: '512m',
        cpus: '1.0',
        pids: 64,
        seccomp: await ensureSeccompProfile(engineInfo)
      })
    ];

    let createRes = await runExec(engineInfo.bin, createArgs, 20000);

    // A container inspect can fail while the name is still taken — after an
    // abrupt shutdown, for instance — and the engine then refuses the name.
    // Clear the stale one and try once more rather than leaving the chat with a
    // sandbox it can never start.
    if (!createRes.ok && /already in use|is already in use|Conflict/i.test(`${createRes.stderr || ''}${createRes.error || ''}`)) {
      await removeContainer(engineInfo, containerName).catch(() => {});
      createRes = await runExec(engineInfo.bin, createArgs, 20000);
    }

    if (!createRes.ok) {
      throw new Error(`Impossibile avviare il container per la chat: ${createRes.stderr || createRes.stdout || createRes.error}`);
    }

    this._startPreinstall(safeId, engineInfo, options);

    return containerName;
  }

  /**
   * The chat's volume, made if it is not there yet, with the files of the copy
   * on this disk put in when it is new: a chat from before the volumes, or one
   * whose files came back from the memory or out of the vault. What the
   * container mounts as /workspace: the volume, or, on an engine whose files
   * this side cannot read (Docker), the copy itself as it always was.
   */
  async ensureChatWorkspace(chatId, engineInfo = null) {
    const safeId = sanitizeId(chatId);
    engineInfo = engineInfo || await detectEngine();
    const base = engineInfo.baseArgs || [];
    const volume = chatVolumeName(safeId);
    const copy = getWorkspaceDir(safeId);
    const made = await ensureVolume(engineInfo, volume);
    const host = await volumeHostPath(engineInfo, volume);
    if (!host) {
      if (made.created) await runExec(engineInfo.bin, [...base, 'volume', 'rm', '-f', volume], 20000).catch(() => {});
      return { source: toContainerMountPath(copy, Boolean(engineInfo.isWsl)), volume: null };
    }
    if (made.created && filesUnder(copy).size) await this.pushWorkspace(safeId, null, engineInfo);
    return { source: volume, volume };
  }

  /**
   * Files of the copy put into the chat's volume: the ones named, or all of
   * them. They travel as a tar on the standard input of a throwaway container
   * of our base image, which unpacks them in the volume: this disk is never
   * mounted for it, and the files are the container's root's, as the chat's
   * container is. Noted as the pod's, so a later pull may remove them.
   */
  async pushWorkspace(chatId, names = null, engineInfo = null) {
    const safeId = sanitizeId(chatId);
    engineInfo = engineInfo || await detectEngine();
    if (!engineInfo.available) return { pushed: 0 };
    const base = engineInfo.baseArgs || [];
    const copy = getWorkspaceDir(safeId);
    const volume = chatVolumeName(safeId);
    await ensureVolume(engineInfo, volume);
    const host = await volumeHostPath(engineInfo, volume);
    // Without a volume of its own the copy is what the container mounts: nothing to carry.
    if (!host) return { pushed: 0 };
    const wanted = names === null
      ? [...filesUnder(copy).keys()]
      : names.map(name => String(name || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(name => name && !name.split('/').some(part => part === '..' || part === '.' || !part));
    const list = wanted.filter(name => !name.split('/').some(HOST_ONLY) && fs.existsSync(path.join(copy, name)));
    if (!list.length) return { pushed: 0 };
    const image = await ensureBaseImage(engineInfo, this.baseImages);
    const unpack = [...base, 'run', '--rm', '-i', '--network=none', '--security-opt=no-new-privileges', '--cap-drop=ALL',
      ...['CHOWN', 'DAC_OVERRIDE', 'FOWNER'].map(cap => `--cap-add=${cap}`), '-v', `${volume}:/workspace:rw`, image, 'tar', '-xf', '-', '-C', '/workspace'];
    // A command line has a length: the files go a hundred at a time.
    for (let at = 0; at < list.length; at += 100) {
      const part = list.slice(at, at + 100);
      const res = await pipeline({ bin: HOST_TAR, args: ['-b', '1', '-cf', '-', '-C', copy, ...part] }, { bin: engineInfo.bin, args: unpack }, 10 * 60 * 1000);
      if (!res.ok) throw Object.assign(new Error(`File non portati nel pod della chat: ${res.stderr || res.error}`), { status: 502 });
    }
    // What went in as a folder is noted file by file.
    const pushed = [];
    for (const name of list) {
      const full = path.join(copy, name);
      if (fs.statSync(full).isDirectory()) pushed.push(...[...filesUnder(full).keys()].map(inner => `${name}/${inner}`));
      else pushed.push(name);
    }
    notePushed(pulledManifestPath(safeId), pushed);
    return { pushed: pushed.length };
  }

  /** A folder of the chat's workspace taken away, in the volume as in the copy. */
  async removeFromWorkspace(chatId, folder, engineInfo = null) {
    const safeId = sanitizeId(chatId);
    const name = String(folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!name || name.split('/').some(part => part === '..' || part === '.' || !part)) throw Object.assign(new Error('Cartella non valida.'), { status: 400 });
    fs.rmSync(path.join(getWorkspaceDir(safeId), name), { recursive: true, force: true });
    engineInfo = engineInfo || await detectEngine();
    if (!engineInfo.available) return { removed: false };
    const base = engineInfo.baseArgs || [];
    const volume = chatVolumeName(safeId);
    if (!(await runExec(engineInfo.bin, [...base, 'volume', 'exists', volume], 10000)).ok) return { removed: false };
    const image = await ensureBaseImage(engineInfo, this.baseImages);
    const res = await runExec(engineInfo.bin, [...base, 'run', '--rm', '--network=none', '--security-opt=no-new-privileges', '--cap-drop=ALL',
      ...['CHOWN', 'DAC_OVERRIDE', 'FOWNER'].map(cap => `--cap-add=${cap}`), '-v', `${volume}:/workspace:rw`, image, 'rm', '-rf', `/workspace/${name}`], 120000);
    return { removed: res.ok };
  }

  /**
   * The copy brought up to date with the volume: after a command of the model,
   * after a desktop session, before the page lists the files. Once at a time
   * for a chat, and not again within a moment unless asked (`force`).
   */
  async pullWorkspace(chatId, { force = false } = {}) {
    const safeId = sanitizeId(chatId);
    const running = this._pulls.get(safeId);
    if (running) return running;
    if (!force && Date.now() - (this._pulledAt.get(safeId) || 0) < 1500) return { copied: 0, removed: 0, skipped: true };
    const task = (async () => {
      const engineInfo = await detectEngine();
      if (!engineInfo.available) return { copied: 0, removed: 0 };
      const host = await volumeHostPath(engineInfo, chatVolumeName(safeId));
      if (!host) return { copied: 0, removed: 0 };
      const out = mirrorFromPod(host, getWorkspaceDir(safeId), pulledManifestPath(safeId));
      this._pulledAt.set(safeId, Date.now());
      return out;
    })().catch(error => {
      console.warn(`[Sandbox] file della chat ${safeId} non ripresi dal pod: ${error.message}`);
      return { copied: 0, removed: 0, error: error.message };
    }).finally(() => this._pulls.delete(safeId));
    this._pulls.set(safeId, task);
    return task;
  }

  /**
   * The chats' volumes taken away, each copy brought up to date first: when the
   * vault locks the chats' files, what it encrypts is the whole of them and
   * nothing stays in clear on the disk of the pods. The next use of a chat
   * makes its volume again from the copy.
   */
  async dropChatWorkspaces(chatIds = []) {
    const engineInfo = await detectEngine();
    if (!engineInfo.available) return { dropped: 0 };
    const base = engineInfo.baseArgs || [];
    let dropped = 0;
    for (const id of chatIds) {
      const safeId = sanitizeId(id);
      await this.pullWorkspace(safeId, { force: true });
      await removeContainer(engineInfo, getContainerName(safeId)).catch(() => {});
      await removeContainer(engineInfo, `synthorg-desk-${safeId}`).catch(() => {});
    }
    const listed = await runExec(engineInfo.bin, [...base, 'volume', 'ls', '--format', '{{.Name}}'], 15000);
    for (const volume of (listed.stdout || '').split(/\s+/).filter(name => name.startsWith(CHAT_CONTAINER_PREFIX))) {
      const gone = await runExec(engineInfo.bin, [...base, 'volume', 'rm', '-f', volume], 60000);
      volumeMounts.delete(volume);
      if (gone.ok) dropped += 1;
    }
    return { dropped };
  }

  /**
   * The runtime started while the app is still loading, so its two seconds of
   * boot are not waited for at the first command; then the images of earlier
   * builds removed. On Windows only a runtime already registered is started:
   * asking the list starts nothing. An import left half done (see
   * `compactRuntime`) is finished first.
   */
  async warmEngine({ keepers = [] } = {}) {
    if (process.platform === 'win32') {
      const note = readImportNote();
      if (note) {
        try { await importRuntime(note); } catch (error) { console.warn(`[Sandbox] ${error.message}`); return { warmed: false, error: error.message }; }
      }
      if (!(await runtimeRegistered())) return { warmed: false };
    }
    const engineInfo = await detectEngine();
    if (!engineInfo.available) return { warmed: false };
    const pruned = await pruneImages(engineInfo, keepers).catch(error => ({ error: error.message }));
    return { warmed: true, pruned };
  }

  /** The runtime's disk, for the settings: what the file takes and what is in it. */
  runtimeDisk() {
    return runtimeDisk();
  }

  /**
   * The runtime's disk brought back to what it holds. WSL's disk file never
   * shrinks (its sparse mode is off in WSL itself, as unsafe), so the runtime
   * is written out as an archive, taken off, and put back from the archive:
   * the new file is as large as its contents. Measured: 33 GB of file for
   * 5.5 GB of images and volumes. Every pod is stopped for it, and the archive
   * stands in for the runtime until the import has succeeded; if the app stops
   * in between, the next start finishes the import (`warmEngine`).
   */
  async compactRuntime(onPhase = () => {}) {
    if (process.platform !== 'win32') throw Object.assign(new Error('Il disco del runtime si compatta solo su Windows.'), { status: 501 });
    if (this._compacting) throw Object.assign(new Error('Compattazione già in corso.'), { status: 409 });
    this._compacting = true;
    const started = Date.now();
    try {
      const base = await runtimeBasePath();
      if (!base) throw Object.assign(new Error('Runtime dei pod non trovato.'), { status: 404 });
      const file = path.join(base, 'ext4.vhdx');
      const before = fs.statSync(file).size;
      onPhase('stopping');
      await this.stopAllContainers().catch(() => {});
      const df = await runExec('wsl.exe', ['-d', RUNTIME_DISTRO, '--exec', 'df', '-k', '/'], 30000);
      const row = (df.stdout || '').split(/\r?\n/).find(line => /\s\/\s*$/.test(line));
      const usedKb = row ? Number(row.trim().split(/\s+/)[2]) : NaN;
      if (!Number.isFinite(usedKb)) throw Object.assign(new Error('Impossibile leggere quanto spazio usa il runtime.'), { status: 502 });
      const used = usedKb * 1024;
      const tar = path.join(path.dirname(base), `synthorg-runtime-${Date.now()}.tar`);
      const stat = fs.statfsSync(path.dirname(base));
      const free = Number(stat.bavail) * Number(stat.bsize);
      if (free < used * 1.2 + 512 * 1024 * 1024) {
        throw Object.assign(new Error(`Spazio insufficiente per l'archivio: servono circa ${Math.ceil(used * 1.2 / 1048576)} MB liberi sul disco del runtime.`), { status: 507 });
      }
      onPhase('export');
      await runExec('wsl.exe', ['--terminate', RUNTIME_DISTRO], 60000);
      const exported = await runExec('wsl.exe', ['--export', RUNTIME_DISTRO, tar], 60 * 60 * 1000);
      let archived = 0;
      try { archived = fs.statSync(tar).size; } catch {}
      if (!exported.ok || archived < used * 0.3) {
        fs.rmSync(tar, { force: true });
        throw Object.assign(new Error(`Archivio del runtime non riuscito: ${parseDistroList(exported.stderr || exported.stdout).join(' ') || exported.error || 'archivio troppo piccolo'}`), { status: 502 });
      }
      // From here the archive is the runtime, until the import has succeeded.
      const note = { tar, base, at: new Date().toISOString(), before, used };
      fs.writeFileSync(IMPORT_NOTE, JSON.stringify(note, null, 2));
      onPhase('unregister');
      const gone = await runExec('wsl.exe', ['--unregister', RUNTIME_DISTRO], 10 * 60 * 1000);
      if (!gone.ok) {
        fs.rmSync(IMPORT_NOTE, { force: true });
        fs.rmSync(tar, { force: true });
        throw Object.assign(new Error(`Il runtime non si è potuto togliere: ${parseDistroList(gone.stderr || gone.stdout).join(' ') || gone.error}`), { status: 502 });
      }
      onPhase('import');
      await importRuntime(note);
      // Nothing of the runtime of before is still known here.
      cachedEngine = null;
      lastCheckTime = 0;
      volumeMounts.clear();
      ensuredNetworks.clear();
      const after = fs.statSync(file).size;
      return { before, after, used, seconds: Math.round((Date.now() - started) / 1000) };
    } finally {
      this._compacting = false;
    }
  }

  async stopContainer(chatId) {
    const engineInfo = await detectEngine();
    if (!engineInfo.available) {
      return { success: true, stopped: false, message: 'Nessun container engine attivo.' };
    }
    const safeId = sanitizeId(chatId);
    const containerName = getContainerName(safeId);
    const res = await runExec(engineInfo.bin, [...(engineInfo.baseArgs || []), 'stop', '-t', '2', containerName], 20000);
    return { success: res.ok, stopped: res.ok, output: res.stdout || res.stderr };
  }

  /**
   * The dedicated container of a code project. Its files live in a volume of
   * the engine named like the container, mounted at /workspace: nothing of
   * the project is on this disk and nothing of this disk is in the container.
   * Limits are sized for builds, the hardening is the same as a chat sandbox.
   */
  async ensureProjectContainer({ containerName, image, networkEnabled, onPhase = () => {} }) {
    const name = assertProjectContainerName(containerName);
    onPhase('engine');
    const engineInfo = await detectEngine();
    if (!engineInfo.available) {
      throw Object.assign(new Error('Nessun container engine (Podman o Docker) rilevato o avviato sul sistema.'), { status: 503 });
    }
    const base = engineInfo.baseArgs || [];
    // How the desktop reaches this container: the editor's agent, terminals,
    // tasks and git all run through this command, never on the host.
    const exec = { bin: engineInfo.bin, args: [...base] };
    const finish = async state => {
      onPhase('tools');
      return {
        containerName: name, volume: name, engine: engineInfo.label, state, exec,
        tools: await this._ensureContainerTools(engineInfo, name)
      };
    };
    // The image the project must run on: the base image plus this build's runtime.
    const baseImage = normalizeImage(image);
    onPhase('image');
    const toolsImage = (await ensureToolsImage(engineInfo, baseImage, this.baseImages)).image;
    onPhase('container');
    let info = await inspectContainer(engineInfo, name);
    // A container from an older build, one that still mounted a folder of this
    // disk, or one without an init process is replaced: its files are in the
    // volume, which stays.
    if (info.exists && (info.bindMounts || !info.init || (info.image && info.image !== toolsImage))) {
      await removeContainer(engineInfo, name);
      info = { exists: false, running: false };
    }
    if (info.running) return finish('running');
    await repairVolumeOwner(engineInfo, name);
    if (info.exists) {
      onPhase('starting');
      const startRes = await runExec(engineInfo.bin, [...base, 'start', name], 20000);
      if (!startRes.ok) {
        throw Object.assign(new Error(`Impossibile riavviare il container ${name}: ${startRes.stderr || startRes.error}`), { status: 502 });
      }
      return finish('started');
    }
    onPhase('creating');
    // The project's own isolated network (its container and its desktop share
    // it); keyed by the container name, which is stable per project.
    const network = await ensureNetwork(engineInfo, name, networkEnabled);
    const args = [...base, ...hardenedRunArgs({
      name,
      network,
      image: toolsImage,
      mounts: [`${name}:/workspace:rw`],
      memory: '4g',
      cpus: '2.0',
      pids: 1024,
      seccomp: await ensureSeccompProfile(engineInfo)
    })];
    const res = await runExec(engineInfo.bin, args, 5 * 60 * 1000);
    if (!res.ok) {
      throw Object.assign(new Error(`Impossibile creare il container ${name}: ${res.stderr || res.stdout || res.error}`), { status: 502 });
    }
    return finish('created');
  }

  /** What the project container actually has; the tools image guarantees it, this reports it. */
  async _ensureContainerTools(engineInfo, containerName) {
    const check = await runInContainer(engineInfo, containerName, TOOLS_CHECK_SCRIPT, 15000);
    const found = new Set((check.stdout || '').split(/\s+/));
    const tools = { git: found.has('git'), bash: found.has('bash'), node: found.has('node'), agent: found.has('agent'), editor: found.has('editor'), error: null };
    if (!tools.git || !tools.bash || !tools.node || !tools.agent || !tools.editor) {
      tools.error = `Strumenti mancanti nel container (${['git', 'bash', 'node', 'agent', 'editor'].filter(t => !tools[t]).join(', ')}): rimuovi e ricrea il progetto.`;
    }
    return tools;
  }

  /** What the project's volume holds, asked of the container: a repository, or nothing yet. */
  async inspectWorkspace(containerName) {
    const name = assertProjectContainerName(containerName);
    const engineInfo = await detectEngine();
    const res = await runInContainer(engineInfo, name, 'test -d /workspace/.git && echo repo; ls -A /workspace | head -1 | grep -q . && echo files', 15000);
    const found = new Set((res.stdout || '').split(/\s+/));
    return { repo: found.has('repo'), empty: !found.has('files') };
  }

  /**
   * Git for GitHub projects runs in a throwaway container, never in the
   * project's own one: the model has a shell there, and a credential handed to
   * a process it can inspect would no longer be the server's alone. Values
   * travel in the environment, not on a command line. The project's volume is
   * the working tree.
   */
  async runGit({ volume, image, args, env = {}, network = false, timeoutMs = 120000 }) {
    const name = assertProjectContainerName(volume);
    if (!Array.isArray(args) || !args.length || args.some(arg => typeof arg !== 'string')) {
      throw Object.assign(new Error('Comando git non valido.'), { status: 400 });
    }
    const engineInfo = await detectEngine();
    if (!engineInfo.available) {
      throw Object.assign(new Error('Nessun container engine (Podman o Docker) rilevato o avviato sul sistema.'), { status: 503 });
    }
    const names = Object.keys(env);
    const childEnv = { ...env };
    // wsl.exe forwards only the variables WSLENV names.
    if (engineInfo.isWsl) childEnv.WSLENV = [process.env.WSLENV, ...names.map(key => `${key}/u`)].filter(Boolean).join(':');
    const runArgs = [
      ...(engineInfo.baseArgs || []),
      'run', '--rm',
      `--network=${network ? 'bridge' : 'none'}`,
      '-v', `${name}:/workspace:rw`,
      '-w', '/workspace',
      ...names.flatMap(key => ['--env', key]),
      '--memory=1g',
      '--pids-limit=256',
      '--security-opt=no-new-privileges',
      '--cap-drop=ALL',
      '--cap-add=CHOWN',
      '--cap-add=DAC_OVERRIDE',
      '--cap-add=FOWNER',
      ...USERNS_ARGS,
      toolsImageRef(image || DEFAULT_PROJECT_IMAGE),
      'git',
      ...args
    ];
    return runExec(engineInfo.bin, runArgs, timeoutMs, childEnv);
  }

  /**
   * Git inside the project's own container, for everything that needs no
   * credential: recording what changed. It is the same working tree the
   * editor writes to, and `exec` on a container that is already running costs
   * a fraction of starting a new one — which matters when a commit follows
   * every save and every tool call. Anything that talks to GitHub goes to
   * runGit instead, where the credential never meets a process the model can
   * look into.
   */
  async execGit({ containerName, args, env = {}, timeoutMs = 60000 }) {
    const name = assertProjectContainerName(containerName);
    if (!Array.isArray(args) || !args.length || args.some(arg => typeof arg !== 'string')) {
      throw Object.assign(new Error('Comando git non valido.'), { status: 400 });
    }
    const engineInfo = await detectEngine();
    if (!engineInfo.available) {
      throw Object.assign(new Error('Nessun container engine (Podman o Docker) rilevato o avviato sul sistema.'), { status: 503 });
    }
    const names = Object.keys(env);
    const childEnv = { ...env };
    // wsl.exe forwards only the variables WSLENV names.
    if (engineInfo.isWsl) childEnv.WSLENV = [process.env.WSLENV, ...names.map(key => `${key}/u`)].filter(Boolean).join(':');
    const args2 = [
      ...(engineInfo.baseArgs || []),
      'exec', '-i', '-w', '/workspace',
      ...names.flatMap(key => ['--env', key]),
      name, 'git', ...args
    ];
    return runExec(engineInfo.bin, args2, timeoutMs, childEnv);
  }

  /**
   * Follows the change notes the project's editor writes when the user saves,
   * creates, moves or deletes a file (server/code-editor ui.c note_change):
   * one line each, and only the fact — no path, no content. The child keeps
   * running while the container does; `onLine` gets every line.
   */
  async followEvents(containerName, onLine) {
    const name = assertProjectContainerName(containerName);
    const engineInfo = await detectEngine();
    if (!engineInfo.available) return null;
    const child = spawn(engineInfo.bin, [...(engineInfo.baseArgs || []), 'exec', name, 'sh', '-c', FOLLOW_EVENTS], { windowsHide: true });
    let pending = '';
    child.stdout.on('data', data => {
      pending = (pending + data.toString()).slice(-4096);
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) onLine(line.trim());
    });
    child.on('error', () => {});
    return child;
  }

  /**
   * One command inside the project's container, with an optional payload on
   * its standard input. The arguments are an argv, never a command line: a
   * path travels as one argument and no shell ever parses it.
   */
  execInContainer({ containerName, argv, input = null, timeoutMs = 60000, encoding = 'utf8' }) {
    const name = assertProjectContainerName(containerName);
    if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string')) {
      throw Object.assign(new Error('Comando non valido.'), { status: 400 });
    }
    return detectEngine().then(engineInfo => {
      if (!engineInfo.available) {
        throw Object.assign(new Error('Nessun container engine (Podman o Docker) rilevato o avviato sul sistema.'), { status: 503 });
      }
      const args = [...(engineInfo.baseArgs || []), 'exec', '-i', '-w', '/workspace', name, ...argv];
      return new Promise(resolve => {
        const child = spawn(engineInfo.bin, args, { windowsHide: true });
        const out = [];
        const err = [];
        let settled = false;
        const timer = setTimeout(() => { settled = true; child.kill(); resolve({ ok: false, error: 'tempo scaduto', stdout: '', stderr: '' }); }, timeoutMs);
        timer.unref?.();
        child.stdout.on('data', chunk => out.push(chunk));
        child.stderr.on('data', chunk => err.push(chunk));
        child.on('error', error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, error: error.message, stdout: '', stderr: '' });
        });
        child.on('close', code => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const stdout = Buffer.concat(out);
          resolve({
            ok: code === 0,
            stdout: encoding === 'buffer' ? stdout : stdout.toString('utf8'),
            stderr: Buffer.concat(err).toString('utf8').trim(),
            error: code === 0 ? null : `uscita ${code}`
          });
        });
        if (input !== null) child.stdin.end(input);
        else child.stdin.end();
      });
    });
  }

  /**
   * Compiles the editor once, here, so no environment ever has to.
   *
   * The toolchain lives and dies inside a throwaway container; what comes out
   * is the static binary and the two fonts, written where every environment
   * built afterwards will find them. Run by `npm run build:editor`, and it
   * says so and stops rather than failing when this machine has no engine.
   */
  async buildEditor({ outDir = EDITOR_PREBUILT_DIR, log = () => {} } = {}) {
    const engineInfo = await detectEngine();
    if (!engineInfo.available) {
      return { skipped: true, reason: 'Nessun container engine disponibile: l’editor verrà compilato nel container al primo progetto.' };
    }
    const base = engineInfo.baseArgs || [];
    const wsl = Boolean(engineInfo.isWsl);
    const arch = containerArch();
    const image = await ensureBaseImage(engineInfo, this.baseImages);
    const name = `synthorg-editor-build-${crypto.randomBytes(4).toString('hex')}`;
    const source = CODE_RUNTIME_SOURCES['editor-src'];
    fs.mkdirSync(outDir, { recursive: true });
    try {
      log(`compilo in ${image} (${arch})`);
      const run = await runExec(engineInfo.bin, [...base, ...hardenedRunArgs({
        name, network: await ensureNetwork(engineInfo, 'build', true), image, mounts: PACKAGE_CACHE_MOUNTS, memory: '2g', cpus: '2.0', pids: 512, workdir: '/', seccomp: await ensureSeccompProfile(engineInfo)
      })], TOOLS_BUILD_TIMEOUT_MS);
      if (!run.ok) throw new Error(`Container di build non avviato: ${run.stderr || run.stdout || run.error}`);
      const deps = await runInContainer(engineInfo, name, 'mkdir -p /src /out; apk add build-base ttf-dejavu', TOOLS_BUILD_TIMEOUT_MS, '/');
      if (!deps.ok) throw new Error(`Strumenti di compilazione non installabili: ${deps.stderr || deps.error}`);
      const copy = await copyIntoContainer(engineInfo, source, name, '/src');
      if (!copy.ok) throw new Error(`Sorgenti non copiati: ${copy.stderr || copy.error}`);
      const build = await runInContainer(engineInfo, name, [
        'cd /src',
        'gcc -O2 -static -o /out/editor main.c vterm/src/*.c -Ivterm/include -lm',
        'strip /out/editor',
        'cp /usr/share/fonts/dejavu/DejaVuSansMono.ttf /out/mono.ttf',
        'cp /usr/share/fonts/dejavu/DejaVuSans.ttf /out/ui.ttf'
      ].join(' && '), TOOLS_BUILD_TIMEOUT_MS, '/');
      if (!build.ok) throw new Error(`Compilazione non riuscita: ${(build.stderr || build.stdout || build.error || '').trim().split(/\r?\n/).slice(-3).join(' ')}`);
      for (const [from, to] of [['editor', `editor-${arch}`], ['mono.ttf', 'mono.ttf'], ['ui.ttf', 'ui.ttf']]) {
        const out = await copyOutOfContainer(engineInfo, name, `/out/${from}`, outDir);
        if (!out.ok) throw new Error(`Estrazione di ${from} non riuscita: ${out.stderr || out.error}`);
        if (from !== to) fs.renameSync(path.join(outDir, from), path.join(outDir, to));
      }
    } finally {
      await removeContainer(engineInfo, name).catch(() => {});
    }
    // The stamp says which sources this binary is: a later change to the C
    // makes it stale, and a stale one is never used.
    const stamp = { sources: editorSourceStamp(), arch, image, at: new Date().toISOString() };
    fs.writeFileSync(path.join(outDir, 'build.json'), JSON.stringify(stamp, null, 2) + '\n');
    const size = fs.statSync(path.join(outDir, `editor-${arch}`)).size;
    return { skipped: false, dir: outDir, arch, bytes: size, stamp: stamp.sources };
  }

  /**
   * The project's container, ready to take a command. Cheap when it already
   * is: one inspect, and the full path only when it has to be started.
   */
  async ensureProjectRunning(project) {
    const name = assertProjectContainerName(project.container_name);
    const engineInfo = await detectEngine();
    if (!engineInfo.available) {
      throw Object.assign(new Error('Nessun container engine (Podman o Docker) rilevato o avviato sul sistema.'), { status: 503 });
    }
    const info = await inspectContainer(engineInfo, name);
    if (info.running) return name;
    await this.ensureProjectContainer({
      containerName: name,
      image: project.image,
      networkEnabled: Boolean(project.network)
    });
    return name;
  }

  /** Removes the project's container; with `volume`, its volume too, and the files in it. */
  async removeProjectContainer(containerName, { volume = false } = {}) {
    const name = assertProjectContainerName(containerName);
    const engineInfo = await detectEngine();
    if (!engineInfo.available) return { removed: false, volumeRemoved: false };
    const res = await removeContainer(engineInfo, name);
    // The project's own isolated network goes with it (keyed by the container name).
    await removeNetwork(engineInfo, name).catch(() => {});
    if (res.ok || /no such container|no container with name/i.test(`${res.stderr || ''} ${res.error || ''}`)) {
      if (!volume) return { removed: true };
      // The project's files: the volume that carries its name, which nothing else uses.
      const gone = await runExec(engineInfo.bin, [...(engineInfo.baseArgs || []), 'volume', 'rm', '-f', name], 60000);
      if (gone.ok || /no such volume/i.test(`${gone.stderr || ''} ${gone.error || ''}`)) return { removed: true, volumeRemoved: true };
      throw Object.assign(new Error(`Impossibile eliminare il volume ${name}: ${gone.stderr || gone.error}`), { status: 502 });
    }
    throw Object.assign(new Error(`Impossibile eliminare il container ${name}: ${res.stderr || res.error}`), { status: 502 });
  }

  /**
   * The Linux runtime of the containers, stopped when the app closes. Its
   * containers are stopped first; what stays after them (rootless podman's
   * pause process, which by design never ends) would keep the WSL machine
   * running for nothing. Only the runtime SynthOrg made is touched, and only
   * if it is running: asking does not start it (`--list --running`).
   */
  async shutdownRuntime() {
    if (process.platform !== 'win32') return { stopped: false };
    const running = await runExec('wsl.exe', ['--list', '--running', '--quiet'], 10000);
    // wsl.exe writes its lists in UTF-16.
    const names = String(running.stdout || '').replace(/ /g, '').split(/\s+/).filter(Boolean);
    if (!names.includes(RUNTIME_DISTRO)) return { stopped: false };
    const res = await runExec('wsl.exe', ['--terminate', RUNTIME_DISTRO], 30000);
    return { stopped: res.ok };
  }

  async stopAllContainers() {
    const engineInfo = await detectEngine();
    if (!engineInfo.available) {
      return { success: true, count: 0 };
    }
    const ids = [];
    // The desktops of computer use too (desktop.js names them so).
    // The Foto section's throwaway containers too (photo-ml.js), should a crash have left one.
    for (const prefix of [CHAT_CONTAINER_PREFIX, PROJECT_CONTAINER_PREFIX, 'synthorg-desk-', 'synthorg-photo-']) {
      const listRes = await runExec(engineInfo.bin, [...(engineInfo.baseArgs || []), 'ps', '-q', '--filter', `name=${prefix}`], 6000);
      if (listRes.ok && listRes.stdout) ids.push(...listRes.stdout.split(/\s+/).filter(Boolean));
    }
    const stopRes = ids.length ? await runExec(engineInfo.bin, [...(engineInfo.baseArgs || []), 'stop', '-t', '2', ...ids], 30000) : { ok: true };
    // Our isolated networks no container holds any more go too (pruneNetworks
    // leaves the ones still in use, so this is safe with the app running).
    await pruneNetworks(engineInfo).catch(() => {});
    return { success: stopRes.ok, count: ids.length };
  }

  async resetContainer(chatId) {
    const engineInfo = await detectEngine();
    const safeId = sanitizeId(chatId);
    const containerName = getContainerName(safeId);
    if (!engineInfo.available) {
      return { success: true, removed: false, message: 'Nessun container engine attivo.' };
    }
    const res = await removeContainer(engineInfo, containerName);
    return { success: res.ok, removed: res.ok, output: res.stdout || res.stderr };
  }

  async deleteWorkspace(chatId) {
    const safeId = sanitizeId(chatId);
    await this.resetContainer(safeId).catch(() => {});
    // The chat's isolated network, once its sandbox is gone. Its desktop shares
    // this network, so this runs after the desktop was removed (chat delete
    // calls desktops.forget first, which removes the desktop container).
    await detectEngine().then(async engine => {
      if (!engine.available) return;
      await removeNetwork(engine, `chat-${safeId}`).catch(() => {});
      // The chat's files, in the volume that carries its container's name.
      const volume = chatVolumeName(safeId);
      volumeMounts.delete(volume);
      await runExec(engine.bin, [...(engine.baseArgs || []), 'volume', 'rm', '-f', volume], 60000);
    }).catch(() => {});
    const dir = path.join(DATA_DIR, 'sandboxes', safeId);
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[Sandbox] Impossibile eliminare workspace per chat ${safeId}:`, err.message);
      }
    }
  }

  async execute(chatId, command, options = {}) {
    const engineInfo = await detectEngine();
    if (!engineInfo.available) {
      throw Object.assign(new Error('Nessun container engine (Podman o Docker) rilevato o avviato sul sistema.'), { status: 503 });
    }

    const safeId = sanitizeId(chatId);
    const timeout = Math.min(Math.max(Number(options.timeoutMs) || RUN_TIMEOUT_MS, 1000), 60 * 60 * 1000);
    const runId = sanitizeRunId(options.runId) || crypto.randomUUID();
    // A chat that belongs to a container project runs its commands in that
    // project's container: the code is there. A second one would put the
    // sandbox next to the work instead of around it.
    const containerName = options.containerName
      ? assertProjectContainerName(options.containerName)
      : await this.ensureContainerRunning(safeId, options, engineInfo);

    // In a project, the editor's terminal first: the command runs where the user sees it.
    if (options.containerName && options.inTerminal !== false) {
      const shown = await this.executeInTerminal({ engineInfo, containerName, command, runId, timeout, chatId: safeId, networkEnabled: options.networkEnabled });
      if (shown) return shown;
    }

    const ran = await this._exec({ engineInfo, containerName, command, runId, timeout, chatId: safeId, networkEnabled: options.networkEnabled });
    // In a chat, what the command wrote reaches the copy on this disk now: the page lists it next.
    if (!options.containerName) await this.pullWorkspace(safeId, { force: true });
    return ran;
  }

  _exec({ engineInfo, containerName, command, runId, timeout, chatId: safeId, networkEnabled }) {
    // Fast exec inside the living container: preserves installed packages, filesystem and environment
    const args = [
      ...(engineInfo.baseArgs || []),
      'exec',
      '-i',
      `-w`, `/workspace`,
      containerName,
      'sh', '-c', RUN_WRAPPER, RUN_INNER, 'sh', runId, command
    ];

    return new Promise((resolve, reject) => {
      const child = spawn(engineInfo.bin, args, { windowsHide: true });
      const entry = { chatId: safeId, containerName, child, engineInfo, ended: null };
      this.runs.set(runId, entry);

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { entry.ended = entry.ended || 'timeout'; this.endRun(runId).catch(() => {}); }, timeout);

      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });

      child.on('error', err => { clearTimeout(timer); this.runs.delete(runId); reject(err); });
      child.on('close', code => {
        clearTimeout(timer);
        this.runs.delete(runId);
        const note = {
          timeout: `[interrotto: tempo scaduto dopo ${Math.round(timeout / 1000)} s; il comando e i suoi processi sono stati terminati]`,
          'interrupted:stop': '[interrotto dall’utente con il pulsante di stop; il comando e i suoi processi sono stati terminati]',
          'interrupted:disconnect': '[interrotto: la pagina che aveva chiesto il comando si è chiusa; il comando e i suoi processi sono stati terminati]'
        }[entry.ended] || '';
        resolve({
          exitCode: code,
          stdout: stdout.trim(),
          stderr: [stderr.trim(), note].filter(Boolean).join('\n'),
          isolated: !networkEnabled,
          containerName,
          runId,
          interrupted: entry.ended
        });
      });
    });
  }

  /**
   * A command in the project editor's terminal. Null when there is no editor
   * running in the container or it did not take the command: nothing ran, and
   * the caller runs it the older way.
   */
  executeInTerminal({ engineInfo, containerName, command, runId, timeout, chatId, networkEnabled }) {
    return new Promise((resolve, reject) => {
      const child = spawn(engineInfo.bin, [...(engineInfo.baseArgs || []), 'exec', containerName, 'sh', '-c', TERM_RUN, 'sh', runId, command], { windowsHide: true });
      const entry = { chatId, containerName, child, engineInfo, ended: null, terminal: true };
      this.runs.set(runId, entry);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { entry.ended = entry.ended || 'timeout'; this.endRun(runId).catch(() => {}); }, timeout);
      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('error', err => { clearTimeout(timer); this.runs.delete(runId); reject(err); });
      child.on('close', code => {
        clearTimeout(timer);
        this.runs.delete(runId);
        if (code === 90) { resolve(null); return; }
        const last = stderr.trim().split(/\r?\n/).pop() || '';
        const space = last.indexOf(' ');
        const exit = space > 0 ? Number(last.slice(0, space)) : NaN;
        const said = space > 0 ? last.slice(space + 1).trim() : '';
        if (said.startsWith('reject:')) { resolve(null); return; }
        const reason = said && said !== '-' ? said : null;
        resolve({
          exitCode: Number.isInteger(exit) && exit >= 0 ? exit : null,
          stdout: stdout.replace(/\s+$/, ''),
          stderr: Number.isNaN(exit) && !entry.ended ? `[il terminale dell'editor non ha restituito l'esito: ${stderr.trim().slice(-300) || `uscita ${code}`}]` : '',
          isolated: !networkEnabled,
          containerName,
          runId,
          interrupted: reason || entry.ended,
          inTerminal: true
        });
      });
    });
  }

  /** Ends a running command: its process tree in the container first, then the client waiting on it. */
  async endRun(runId) {
    const entry = this.runs.get(runId);
    if (!entry) return false;
    const { engineInfo, containerName, child } = entry;
    if (entry.terminal) {
      // The editor ends it, as it would a Ctrl+C, and answers with the reason; if it cannot, nobody waits forever.
      await runExec(engineInfo.bin, [...(engineInfo.baseArgs || []), 'exec', containerName, 'sh', '-c', TERM_STOP, 'sh', runId, entry.ended || 'interrupted:stop'], 15000);
      setTimeout(() => { if (child.exitCode === null && !child.killed) child.kill(); }, 12000).unref?.();
      return true;
    }
    await runExec(engineInfo.bin, [...(engineInfo.baseArgs || []), 'exec', containerName, 'sh', '-c', RUN_KILL, 'sh', runId], 15000);
    if (child.exitCode === null && !child.killed) child.kill();
    return true;
  }

  /** The stop button of the chat that started the command. */
  async interrupt(chatId, runId) {
    const entry = this.runs.get(String(runId));
    if (!entry || entry.chatId !== sanitizeId(chatId)) return { interrupted: false };
    return this.interruptRun(runId, 'interrupted:stop');
  }

  /** Ends a running command for a reason the service found itself (its client went away). */
  async interruptRun(runId, why) {
    const entry = this.runs.get(String(runId));
    if (!entry) return { interrupted: false };
    entry.ended = entry.ended || why;
    await this.endRun(String(runId));
    return { interrupted: true };
  }
}

module.exports = {
  cpuArgs,
  SandboxManager,
  detectEngine,
  runExec,
  runInContainer,
  ensureNetwork,
  ensureSeccompProfile,
  networkNameFor,
  NETWORK_PREFIX,
  copyIntoContainer,
  copyOutOfContainer,
  inspectContainer,
  removeContainer,
  ensureBaseImage,
  PACKAGE_CACHE_MOUNTS,
  toContainerMountPath,
  USERNS_ARGS,
  RUNTIME_PODMAN,
  getWorkspaceDir,
  getContainerName,
  assertSafeImage,
  assertProjectContainerName,
  hardenedRunArgs,
  PROJECT_CONTAINER_PREFIX,
  toolsImageRef,
  TOOLS_IMAGE_REPO,
  normalizeImage,
  ensureToolsImage,
  runtimeStamp,
  prebuiltEditor,
  editorSourceStamp,
  containerArch,
  EDITOR_PREBUILT_DIR,
  EXTENSIONS_MANIFEST,
  createExtensionCatalog,
  TOOLS_INSTALL_SCRIPT,
  DEFAULT_PROJECT_IMAGE,
  CODE_RUNTIME_DIR,
  CODE_AGENT,
  shellSafePackages,
  pythonPreinstallScript,
  nodePreinstallScript,
  imageKey,
  getSharedLibDirs,
  pythonPackagePresent,
  nodePackagePresent,
  SHARED_PY,
  SHARED_NODE,
  SHARED_BASE,
  chatVolumeName,
  libVolumeName,
  ensureVolume,
  volumeHostPath,
  filesUnder,
  mirrorFromPod,
  notePushed,
  pulledManifestPath,
  imagesToDrop,
  pruneImages,
  parseDistroList,
  runtimeBasePath,
  sourcesStamp
};
