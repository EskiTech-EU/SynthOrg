'use strict';
/**
 * The I2P router the bridge goes through.
 *
 * Embedded: i2pd in a container of its own, in the same runtime as every
 * other environment of the app. It is Alpine's own package, installed from
 * Alpine's repository into an image made once; the container has the network
 * and nothing else: no folder of this computer, no capability, its own
 * network apart from the other containers. What the router keeps from one
 * start to the next (its keys, the routers it knows) is in a volume, which
 * is what makes the second start faster than the first.
 *
 * Nothing of it is reachable from this computer's network: no port is
 * published. Its SAM interface listens inside the container. Beside the
 * router runs a small program of ours (runtime/bridge-mux.c, built into the
 * image) that carries every connection to SAM over the container's own
 * input and output: one process on this computer, however many connections.
 *
 * It ends with the app, however the app ends. The container is started in
 * the foreground, its input held by this service: when the input ends (the
 * app closed, killed or crashed) that program ends and the router is
 * stopped. Nothing is left running.
 *
 * External: a router the user already runs, reached at the SAM address given
 * in the settings. The app starts and stops nothing.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Duplex } = require('node:stream');
const { Sam } = require('./bridge-sam');

// One router for the app. A service started beside the app to try something (SYNTHORG_BRIDGE_ROUTER) takes a
// name of its own: with the same name it would remove the app's router to start its own, and the other way round.
const CONTAINER = /^[a-z0-9][a-z0-9-]{2,60}$/.test(process.env.SYNTHORG_BRIDGE_ROUTER || '') ? process.env.SYNTHORG_BRIDGE_ROUTER : 'synthorg-bridge-router';
const VOLUME = CONTAINER;
const IMAGE_NAME = 'localhost/synthorg-bridge-router';
const DATA = '/var/lib/i2pd';
const SAM_PORT = 7656;
const MUX = '/usr/local/bin/synthorg-mux';
const MUX_SOURCE = path.join(__dirname, 'runtime', 'bridge-mux.c');
const BANDWIDTHS = ['L', 'O', 'P', 'X'];
const EXTERNAL_PORT = 7656;
const START_MS = 90000;
const OPEN_MS = 8000;
const PIECE = 32 * 1024;
const HEAD = 9;
// The router, with what it says sent where the frames are not; then the
// program that carries the connections, which ends when the container's
// input does; then the router is stopped. If the router goes away by itself
// the container goes with it.
const RUN = [
  'i2pd "$@" >&2 &',
  'router=$!',
  '(while kill -0 $router 2>/dev/null; do sleep 2; done; kill $$ 2>/dev/null) &',
  `${MUX} 127.0.0.1 ${SAM_PORT}`,
  'kill $router 2>/dev/null',
  'wait $router 2>/dev/null'
].join('\n');

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

/**
 * What runs the containers, as the rest of the app uses it: asked for when
 * it is needed, so that what never starts a router loads nothing.
 */
function runtime() {
  const sandbox = require('./sandbox');
  const { BaseImageStore } = require('./base-image');
  const { DATA_DIR } = require('./paths');
  return {
    detectEngine: sandbox.detectEngine,
    runExec: sandbox.runExec,
    ensureNetwork: sandbox.ensureNetwork,
    ensureSeccompProfile: sandbox.ensureSeccompProfile,
    userns: sandbox.USERNS_ARGS,
    cpuArgs: sandbox.cpuArgs,
    baseImage: engine => sandbox.ensureBaseImage(engine, new BaseImageStore({ dir: path.join(DATA_DIR, 'images') })),
    muxSource: () => fs.readFileSync(MUX_SOURCE)
  };
}

/** A process seen as a connection: what is written goes to its input, what it prints is what is read. */
class ProcessStream extends Duplex {
  constructor(child) {
    super();
    this.child = child;
    child.stdout.on('data', chunk => { if (!this.push(chunk)) child.stdout.pause(); });
    child.stdout.once('end', () => this.push(null));
    child.stdin.on('error', () => {});
    child.once('error', error => this.destroy(error));
    child.once('exit', () => { setImmediate(() => { if (!this.destroyed) this.destroy(); }); });
  }
  _read() { this.child.stdout.resume(); }
  _write(chunk, encoding, done) {
    if (this.child.stdin.destroyed) { done(new Error('Collegamento chiuso.')); return; }
    this.child.stdin.write(chunk, encoding, done);
  }
  _final(done) { this.child.stdin.end(); done(); }
  _destroy(error, done) {
    try { this.child.kill(); } catch {}
    done(error);
  }
}

/** One of the connections carried over the container's input and output. */
class MuxStream extends Duplex {
  constructor(mux, id) {
    super();
    this.mux = mux;
    this.id = id;
    this.gone = false;   // closed at the other end: nothing more to tell it
  }
  _read() {}
  _write(chunk, encoding, done) {
    const pieces = [];
    for (let at = 0; at < chunk.length; at += PIECE) pieces.push(chunk.subarray(at, at + PIECE));
    const next = () => {
      const piece = pieces.shift();
      if (!piece) { done(); return; }
      this.mux.frame('D', this.id, piece, error => (error ? done(error) : next()));
    };
    next();
  }
  _destroy(error, done) {
    this.mux.channels.delete(this.id);
    if (!this.gone) this.mux.frame('C', this.id);
    done(error);
  }
}

/** The container's input and output, as the connections they carry (the other end is runtime/bridge-mux.c). */
class Mux {
  constructor(child) {
    this.child = child;
    this.channels = new Map();
    this.waiting = new Map();
    this.next = 1;
    this.buffer = Buffer.alloc(0);
    this.ended = false;
    child.stdout.on('data', chunk => this.read(chunk));
    child.stdout.once('end', () => this.end());
    child.once('exit', () => this.end());
  }

  read(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= HEAD) {
      const length = this.buffer.readUInt32BE(5);
      if (this.buffer.length < HEAD + length) break;
      const type = String.fromCharCode(this.buffer[0]);
      const id = this.buffer.readUInt32BE(1);
      const payload = this.buffer.subarray(HEAD, HEAD + length);
      this.buffer = this.buffer.subarray(HEAD + length);
      this.take(type, id, payload);
    }
  }

  take(type, id, payload) {
    const waiting = this.waiting.get(id);
    const stream = this.channels.get(id);
    if (type === 'O' && waiting) {
      this.waiting.delete(id);
      waiting.resolve();
    } else if (type === 'D' && stream) {
      stream.push(Buffer.from(payload));
    } else if (type === 'C') {
      if (waiting) { this.waiting.delete(id); waiting.reject(Object.assign(new Error('Il router I2P non risponde.'), { code: 'BRIDGE_ROUTER' })); }
      if (stream) { stream.gone = true; stream.push(null); stream.destroy(); }
    }
  }

  frame(type, id, payload = null, done = null) {
    if (this.ended || this.child.stdin.destroyed) { done?.(new Error('Collegamento chiuso.')); return; }
    const head = Buffer.alloc(HEAD);
    head[0] = type.charCodeAt(0);
    head.writeUInt32BE(id, 1);
    head.writeUInt32BE(payload ? payload.length : 0, 5);
    this.child.stdin.write(payload && payload.length ? Buffer.concat([head, payload]) : head, error => done?.(error || null));
  }

  /** A new connection to the router's SAM interface. */
  open() {
    if (this.ended) return Promise.reject(Object.assign(new Error('Il router I2P non è avviato.'), { code: 'BRIDGE_ROUTER' }));
    const id = this.next++;
    const stream = new MuxStream(this, id);
    stream.on('error', () => {});
    this.channels.set(id, stream);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); stream.destroy(); reject(Object.assign(new Error('Il router I2P non risponde.'), { code: 'BRIDGE_ROUTER' })); }, OPEN_MS);
      if (timer.unref) timer.unref();
      this.waiting.set(id, {
        resolve: () => { clearTimeout(timer); resolve(stream); },
        reject: error => { clearTimeout(timer); stream.gone = true; stream.destroy(); reject(error); }
      });
      this.frame('O', id);
    });
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    const error = Object.assign(new Error('Il router I2P si è fermato.'), { code: 'BRIDGE_ROUTER' });
    for (const waiting of [...this.waiting.values()]) waiting.reject(error);
    this.waiting.clear();
    for (const stream of [...this.channels.values()]) { stream.gone = true; stream.push(null); stream.destroy(); }
    this.channels.clear();
  }
}

class BridgeRouter {
  constructor({ tools = null, spawnImpl = spawn } = {}) {
    this.toolsOverride = tools;
    this.spawn = spawnImpl;
    this.sam = null;
    this.mode = null;
    this.available = false;
    this.child = null;
    this.mux = null;
    this.log = '';
  }

  get tools() {
    if (!this.toolsOverride) this.toolsOverride = runtime();
    return this.toolsOverride;
  }

  /** What of the connection program is in the image's name: an image with another stamp is of a program of before. */
  imageStamp() {
    return createHash('sha256').update(this.tools.muxSource()).digest('hex').slice(0, 10);
  }

  engine() {
    return this.tools.detectEngine();
  }

  /** Whether the embedded router can be started here: there is a runtime for containers. */
  async check() {
    try { this.available = Boolean((await this.engine()).available); } catch { this.available = false; }
    return this.available;
  }

  embeddedAvailable() { return this.available; }

  async exec(args, timeoutMs = 60000) {
    const engine = await this.engine();
    return this.tools.runExec(engine.bin, [...(engine.baseArgs || []), ...args], timeoutMs);
  }

  /** Runs a command in a container with `input` as what it reads. */
  async feed(args, input, timeoutMs = 60000) {
    const engine = await this.engine();
    return new Promise(resolve => {
      const child = this.spawn(engine.bin, [...(engine.baseArgs || []), ...args], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      let said = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
      child.stderr?.on('data', chunk => { said = (said + chunk).slice(-2000); });
      child.stdin.on('error', () => {});
      child.once('error', error => { clearTimeout(timer); resolve({ ok: false, stderr: error.message }); });
      child.once('exit', code => { clearTimeout(timer); resolve({ ok: code === 0, stderr: said.trim() }); });
      child.stdin.end(input);
    });
  }

  /**
   * The image the router runs from: the app's base image with Alpine's i2pd
   * package and our connection program in it, made the first time and kept.
   * Its name carries the version of the base and the program's source, so a
   * newer one of either makes a newer image; the older ones are removed.
   */
  async ensureImage() {
    const engine = await this.engine();
    const { ensureNetwork, userns } = this.tools;
    const base = await this.tools.baseImage(engine);
    const baseRef = typeof base === 'string' ? base : base.image;
    const source = this.tools.muxSource();
    const image = `${IMAGE_NAME}:${baseRef.split(':').pop()}-${this.imageStamp()}`;
    if ((await this.exec(['image', 'exists', image], 15000)).ok) return image;
    const builder = `${CONTAINER}-build`;
    await this.exec(['rm', '-f', builder], 20000);
    const made = await this.exec([
      'run', '-d', '--init', `--name=${builder}`, `--network=${await ensureNetwork(engine, 'build', true)}`,
      '--security-opt=no-new-privileges', '--cap-drop=ALL',
      // What a package manager needs to unpack files and make the package's user.
      ...['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETGID', 'SETUID'].map(cap => `--cap-add=${cap}`),
      ...userns, baseRef, 'sleep', '900'
    ], 60000);
    if (!made.ok) fail(`Impossibile preparare il router I2P: ${made.stderr || made.error || 'il container non parte'}`, 502);
    const last = (result) => `${result.stderr || ''}\n${result.stdout || ''}\n${result.error || ''}`.trim().split('\n').pop();
    try {
      const installed = await this.exec(['exec', builder, 'apk', 'add', '--no-cache', 'i2pd'], 5 * 60 * 1000);
      if (!installed.ok) fail(`Impossibile installare il router I2P dal repository di Alpine: ${last(installed)}`, 502);
      // The compiler is there for as long as it takes to build the program, and leaves no trace in the image.
      const compiler = await this.exec(['exec', builder, 'apk', 'add', '--no-cache', '--virtual', '.synthorg-mux', 'gcc', 'musl-dev'], 10 * 60 * 1000);
      if (!compiler.ok) fail(`Impossibile preparare il router I2P: ${last(compiler)}`, 502);
      const written = await this.feed(['exec', '-i', builder, 'sh', '-c', 'cat > /tmp/bridge-mux.c'], source);
      if (!written.ok) fail(`Impossibile preparare il router I2P: ${written.stderr}`, 502);
      const built = await this.exec(['exec', builder, 'gcc', '-Os', '-static', '-s', '-Wall', '-o', MUX, '/tmp/bridge-mux.c'], 5 * 60 * 1000);
      if (!built.ok) fail(`Impossibile preparare il router I2P: ${last(built)}`, 502);
      const cleaned = await this.exec(['exec', builder, 'sh', '-c', 'rm -f /tmp/bridge-mux.c && apk del --no-cache .synthorg-mux'], 5 * 60 * 1000);
      if (!cleaned.ok) fail(`Impossibile preparare il router I2P: ${last(cleaned)}`, 502);
      const committed = await this.exec(['commit', builder, image], 2 * 60 * 1000);
      if (!committed.ok) fail(`Impossibile salvare l'immagine del router I2P: ${last(committed)}`, 502);
    } finally {
      await this.exec(['rm', '-f', builder], 20000);
    }
    // The images of before, made for another base or another program.
    const listed = await this.exec(['images', '--format', '{{.Repository}}:{{.Tag}}', IMAGE_NAME], 20000);
    for (const old of String(listed.stdout || '').split(/\s+/).filter(name => name.startsWith(`${IMAGE_NAME}:`) && name !== image)) {
      await this.exec(['rmi', old], 30000);
    }
    return image;
  }

  /**
   * A connection to the SAM interface of the router that is running, from a
   * process of its own: for what is not this service (the reference client
   * of the phone, a check from a terminal).
   */
  async dial() {
    const engine = await this.engine();
    const child = this.spawn(engine.bin, [...(engine.baseArgs || []), 'exec', '-i', CONTAINER, 'nc', '127.0.0.1', String(SAM_PORT)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    return new ProcessStream(child);
  }

  /**
   * The router to go through, ready to be asked: started if it is ours,
   * checked if it is the user's. `transit` lets other people's tunnels pass
   * through this router, which is what every router is asked to do and what
   * covers our own traffic; `bandwidth` is how much of the line they may take.
   */
  async start({ mode = 'embedded', host = '127.0.0.1', port = EXTERNAL_PORT, user = '', password = '', transit = true, bandwidth = 'O' } = {}) {
    await this.stop();
    if (mode === 'external') {
      const sam = new Sam({ host, port, user, password });
      if (!await sam.reachable()) fail(`Nessun router I2P risponde a ${host}:${port}. Controlla che sia avviato e che l'interfaccia SAM sia attiva.`, 503);
      this.sam = sam;
      this.mode = mode;
      return sam;
    }
    if (!await this.check()) fail('Il router incorporato gira nel runtime dei container, che su questo computer non è disponibile. Scegli «Router esterno» per passare da un router I2P già in esecuzione.', 503);
    const engine = await this.engine();
    const { ensureNetwork, ensureSeccompProfile, userns, cpuArgs } = this.tools;
    const image = await this.ensureImage();
    await this.exec(['rm', '-f', CONTAINER], 30000);
    const seccomp = await ensureSeccompProfile(engine);
    const args = [
      'run', '--rm', '-i', '--init', `--name=${CONTAINER}`,
      // What the container writes is the traffic with the router, keys included: the engine keeps none of it.
      '--log-driver=none',
      `--network=${await ensureNetwork(engine, 'bridge', true)}`,
      // U: the volume belongs to the user the router runs as, whatever it was made with.
      '-v', `${VOLUME}:${DATA}:U`,
      '--memory=512m', ...(cpuArgs ? cpuArgs('1.0') : ['--cpus=1.0']), '--pids-limit=256', '--stop-timeout=1',
      '--security-opt=no-new-privileges',
      ...(seccomp ? ['--security-opt', `seccomp=${seccomp}`] : []),
      '--cap-drop=ALL',
      // The user Alpine's package made for it, to whom the router's folder belongs.
      '--user=i2pd',
      ...userns,
      image,
      'sh', '-c', RUN, 'router',
      `--datadir=${DATA}`, '--certsdir=/usr/share/i2pd/certificates',
      // Its own configuration and no tunnels of its own: only what is said here.
      '--conf=/dev/null', '--tunconf=/dev/null', `--tunnelsdir=${DATA}/none`,
      '--log=stdout', '--loglevel=error',
      '--sam.enabled=true', '--sam.address=127.0.0.1', `--sam.port=${SAM_PORT}`,
      '--http.enabled=false', '--httpproxy.enabled=false', '--socksproxy.enabled=false',
      '--bob.enabled=false', '--i2cp.enabled=false', '--i2pcontrol.enabled=false',
      '--upnp.enabled=false',
      `--bandwidth=${BANDWIDTHS.includes(bandwidth) ? bandwidth : 'O'}`,
      ...(transit ? [] : ['--notransit'])
    ];
    const child = this.spawn(engine.bin, [...(engine.baseArgs || []), ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.log = '';
    const keep = chunk => { this.log = (this.log + chunk).slice(-2000); };
    child.stderr.on('data', keep);
    child.stdin.on('error', () => {});
    let exited = false;
    child.once('error', error => { exited = true; keep(error.message); });
    child.once('exit', () => {
      exited = true;
      if (this.child !== child) return;
      this.child = null;
      this.mux = null;
      this.sam = null;
      this.mode = null;
      this.onExit?.();
    });
    this.child = child;
    const mux = new Mux(child);
    this.mux = mux;

    const sam = new Sam({ dial: () => mux.open() });
    const deadline = Date.now() + START_MS;
    while (!exited && Date.now() < deadline) {
      if (await sam.reachable()) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (exited || Date.now() >= deadline) {
      const said = this.log.trim().split('\n').pop();
      await this.stop();
      fail(`Il router I2P non si è avviato${said ? `: ${said}` : '.'}`, 500);
    }
    this.sam = sam;
    this.mode = mode;
    return sam;
  }

  get running() { return Boolean(this.sam); }

  async stop() {
    const child = this.child;
    this.child = null;
    this.mux = null;
    this.sam = null;
    this.mode = null;
    if (!child) return;
    // Its input ended, the container stops the router and goes; the engine is asked too, in case it lingers.
    try { child.stdin.end(); } catch {}
    await this.exec(['rm', '-f', CONTAINER], 30000).catch(() => {});
    if (child.exitCode === null && !child.signalCode) { try { child.kill(); } catch {} }
  }
}

module.exports = { BridgeRouter, ProcessStream, Mux, MuxStream, BANDWIDTHS, EXTERNAL_PORT, CONTAINER, VOLUME, IMAGE_NAME };
