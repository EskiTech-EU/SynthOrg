'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, randomBytes } = require('node:crypto');
const { Store } = require('../server/database');
const { createApp } = require('../server');
const { Bridge } = require('../server/bridge');
const { BridgeRouter, Mux } = require('../server/bridge-router');
const noise = require('../server/bridge-noise');
const sam = require('../server/bridge-sam');
const { Phone, readCode, fromBase32 } = require('../scripts/bridge-phone');
const qr = require('../resources/js/qr.js');
const W = require('../resources/js/realtime-wellbeing.js');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, what = 'what was waited for') => {
  for (let i = 0; i < 2000; i++) { if (await check()) return; await tick(5); }
  assert.fail(`never happened: ${what}`);
};

/** Two ends of one connection on this machine. */
function pair() {
  return new Promise((resolve, reject) => {
    let near;
    const server = net.createServer(far => { server.close(); resolve([near, far]); });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { near = net.connect(server.address().port, '127.0.0.1'); near.once('error', () => {}); });
  });
}

/* ------------------------------------------------------------------ */
/* The channel                                                          */
/* ------------------------------------------------------------------ */

async function channels({ kind = 'session', psk = null, given = psk, phone = noise.generateStatic(), allowed = () => true, payload = { name: 'Telefono' } } = {}) {
  const host = noise.generateStatic();
  const [near, far] = await pair();
  const answering = noise.respond(far, { staticKey: host, pairingSecret: () => psk, allowed });
  answering.catch(() => far.destroy());
  const asking = noise.initiate(near, { kind, staticKey: phone, remoteStatic: host.publicKey, psk: given, payload });
  const [answered, asked] = await Promise.allSettled([answering, asking]);
  return { host, phone, answered, asked, near, far };
}

test('a phone and the computer end the handshake with the same keys, and know each other', async t => {
  const { answered, asked, phone, host, near, far } = await channels();
  t.after(() => { near.destroy(); far.destroy(); });
  assert.deepEqual([answered.status, asked.status], ['fulfilled', 'fulfilled']);
  const here = answered.value;
  const there = asked.value;
  assert.equal(here.kind, 'session');
  assert.deepEqual(here.payload, { name: 'Telefono' });
  assert.ok(here.channel.remoteStatic.equals(phone.publicKey), 'the computer learns the key of the phone');
  assert.ok(there.remoteStatic.equals(host.publicKey));
  assert.ok(here.channel.hash.equals(there.hash), 'both saw the same handshake');

  await there.send({ t: 'req', id: 1, method: 'assistant.say', params: { text: 'ciao' } });
  assert.deepEqual((await here.channel.receive()).header, { t: 'req', id: 1, method: 'assistant.say', params: { text: 'ciao' } });
  // a message longer than a record, with bytes of its own, comes back whole
  const recording = randomBytes(200 * 1024);
  await here.channel.send({ t: 'res', id: 1, ok: true }, recording);
  const got = await there.receive();
  assert.deepEqual(got.header, { t: 'res', id: 1, ok: true });
  assert.ok(got.body.equals(recording));
  // and an empty one
  await there.send({ t: 'req', id: 2, method: 'ping' });
  assert.equal((await here.channel.receive()).body.length, 0);
});

test('pairing needs the secret of the code; a session needs a phone that is paired', async () => {
  const secret = randomBytes(32);
  const paired = await channels({ kind: 'pairing', psk: secret });
  assert.deepEqual([paired.answered.status, paired.answered.value.kind], ['fulfilled', 'pairing']);
  paired.near.destroy();

  const guessed = await channels({ kind: 'pairing', psk: secret, given: randomBytes(32) });
  assert.equal(guessed.answered.status, 'rejected');
  assert.equal(guessed.answered.reason.code, 'BRIDGE_CHANNEL');

  const closed = await channels({ kind: 'pairing', psk: null, given: secret });
  assert.match(closed.answered.reason.message, /Nessun accoppiamento aperto/);

  const stranger = await channels({ allowed: () => false });
  assert.match(stranger.answered.reason.message, /non accoppiato/);
});

test('what is written on the wire is not what is said, and a byte changed is refused', async t => {
  const host = noise.generateStatic();
  const phone = noise.generateStatic();
  const [near, far] = await pair();
  const [wire, tapped] = await pair();
  t.after(() => [near, far, wire, tapped].forEach(socket => socket.destroy()));
  // The phone talks to `near`; what it writes passes through here before it reaches the computer.
  const seen = [];
  let spoil = false;
  far.on('data', chunk => {
    seen.push(chunk);
    const out = Buffer.from(chunk);
    if (spoil) out[out.length - 1] ^= 1;
    wire.write(out);
  });
  wire.on('data', chunk => far.write(chunk));
  const answering = noise.respond(tapped, { staticKey: host, pairingSecret: () => null, allowed: () => true });
  const there = await noise.initiate(near, { kind: 'session', staticKey: phone, remoteStatic: host.publicKey });
  const here = (await answering).channel;
  await there.send({ t: 'req', id: 1, method: 'assistant.say', params: { text: 'la parola segreta' } });
  assert.equal((await here.receive()).header.params.text, 'la parola segreta');
  const all = Buffer.concat(seen);
  assert.equal(all.includes(Buffer.from('segreta')), false);
  assert.equal(all.includes(phone.publicKey), false, 'the key of the phone travels encrypted');
  spoil = true;
  await there.send({ t: 'req', id: 2, method: 'ping' });
  await assert.rejects(here.receive(), /non autentico/);
});

/* ------------------------------------------------------------------ */
/* Addresses and the router's words                                     */
/* ------------------------------------------------------------------ */

test('addresses and replies of the router are read as I2P writes them', () => {
  const bytes = randomBytes(64);
  assert.ok(sam.fromI2p64(sam.toI2p64(bytes)).equals(bytes));
  assert.equal(/[+/]/.test(sam.toI2p64(Buffer.alloc(300, 0xff))), false);
  assert.equal(sam.base32(Buffer.from('foobar')), 'mzxw6ytboi');
  assert.ok(fromBase32('MZXW6YTBOI').equals(Buffer.from('foobar')));

  // A destination: 256 bytes of encryption key, 96 of padding, the 32 of the
  // signing key, and a certificate saying Ed25519 (7) and X25519 (4).
  const signing = randomBytes(32);
  const publicPart = Buffer.concat([randomBytes(256), randomBytes(96), signing, Buffer.from([5, 0, 4, 0, 7, 0, 4])]);
  const privatePart = Buffer.concat([publicPart, randomBytes(32), randomBytes(32)]);
  const destination = sam.toI2p64(publicPart);
  assert.equal(sam.publicDestination(sam.toI2p64(privatePart)), destination);
  assert.match(sam.plainAddress(destination), /^[a-z2-7]{52}\.b32\.i2p$/);
  const hidden = sam.hiddenAddress(destination);
  assert.match(hidden, /^[a-z2-7]{56}\.b32\.i2p$/);
  assert.notEqual(hidden, sam.hiddenAddress(sam.toI2p64(Buffer.concat([publicPart.subarray(0, 352), randomBytes(32), publicPart.subarray(384)]))));
  // the address carries the signing key after three bytes mixed with its checksum
  const told = fromBase32(hidden.slice(0, 56));
  assert.ok(told.subarray(3, 35).equals(signing));

  assert.deepEqual(sam.parseReply('SESSION STATUS RESULT=OK DESTINATION=abc~-'), { words: ['SESSION', 'STATUS'], values: { RESULT: 'OK', DESTINATION: 'abc~-' }, line: 'SESSION STATUS RESULT=OK DESTINATION=abc~-' });
  assert.equal(sam.parseReply('STREAM STATUS RESULT=CANT_REACH_PEER MESSAGE="LeaseSet not found"').values.MESSAGE, 'LeaseSet not found');
});

test('the router is asked over its SAM interface: a session with its readers, streams accepted and opened', async t => {
  const asked = [];
  const streams = [];
  const open = new Set();
  const server = net.createServer(socket => {
    open.add(socket);
    let buffer = '';
    let stream = false;
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (stream) return;
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        asked.push(line);
        if (line.startsWith('HELLO')) socket.write('HELLO REPLY RESULT=OK VERSION=3.3\n');
        else if (line.startsWith('DEST GENERATE')) socket.write('DEST REPLY PUB=pub PRIV=priv\n');
        else if (line.startsWith('SESSION CREATE')) {
          if (line.includes('i2cp.leaseSetEncType=6,4')) socket.write('SESSION STATUS RESULT=I2P_ERROR MESSAGE="unknown encryption"\n');
          else { socket.write('PING 7\n'); socket.write(`SESSION STATUS RESULT=OK DESTINATION=${/DESTINATION=(\S+)/.exec(line)[1]}\n`); }
        } else if (line.startsWith('STREAM ACCEPT')) {
          socket.write('STREAM STATUS RESULT=OK\n');
          streams.push(socket);
        } else if (line.startsWith('STREAM CONNECT')) {
          if (line.includes('nowhere')) socket.write('STREAM STATUS RESULT=CANT_REACH_PEER MESSAGE="LeaseSet not found"\n');
          else { stream = true; socket.write('STREAM STATUS RESULT=OK\nhello'); }
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); open.forEach(socket => socket.destroy()); });
  const router = new sam.Sam({ port: server.address().port });
  assert.equal(await router.reachable(), true);
  assert.equal(await new sam.Sam({ port: 1, timeoutMs: 500 }).reachable(), false);
  assert.equal(await router.generate(), 'priv');

  const signing = randomBytes(32);
  const destination = sam.toI2p64(Buffer.concat([randomBytes(352), signing, Buffer.from([5, 0, 4, 0, 7, 0, 4]), randomBytes(64)]));
  const reader = noise.generateStatic();
  const session = await router.session({ privateKey: destination, readers: [{ name: 'd-1 2', publicKey: reader.publicKey }] });
  t.after(() => session.close());
  const created = asked.filter(line => line.startsWith('SESSION CREATE'));
  assert.equal(created.length, 2, 'a router that does not know the newer encryption is asked for the older');
  assert.match(created[1], /i2cp\.leaseSetEncType=4 i2cp\.leaseSetType=5 i2cp\.leaseSetAuthType=1 i2cp\.leaseSetClient\.dh\.0=d-12:/);
  assert.ok(created[1].includes(sam.toI2p64(reader.publicKey)));
  assert.deepEqual([session.hidden, session.encryption], [true, '4']);
  assert.match(session.address, /^[a-z2-7]{56}\.b32\.i2p$/);
  await until(() => asked.includes('PONG 7'), 'the ping answered');

  const accepting = session.accept();
  await until(() => streams.length === 1, 'the accept asked');
  streams[0].write(`${'caller'.repeat(10)} FROM_PORT=0 TO_PORT=0\nfirst bytes`);
  const accepted = await accepting;
  assert.equal(accepted.from, 'caller'.repeat(10));
  const got = await new Promise(resolve => { accepted.socket.once('data', resolve); accepted.socket.resume(); });
  assert.equal(String(got), 'first bytes', 'what came with the line of the caller is the stream\'s');

  const opened = await session.connect('somewhere.b32.i2p');
  assert.equal(String(await new Promise(resolve => { opened.once('data', resolve); opened.resume(); })), 'hello');
  await assert.rejects(session.connect('nowhere.b32.i2p'), error => error.code === 'BRIDGE_UNREACHABLE' && /LeaseSet not found/.test(error.message));
});

test('the router of the app runs in a container of its own, reached through the engine and ended with the app', async t => {
  const ran = [];         // what the engine was asked, in order
  const spawned = [];
  let images = new Set();
  let samUp = true;
  const open = new Set();
  const samServer = net.createServer(socket => { open.add(socket); socket.on('error', () => {}); socket.on('data', () => socket.write('HELLO REPLY RESULT=OK VERSION=3.3\n')); });
  await new Promise(resolve => samServer.listen(0, '127.0.0.1', resolve));
  t.after(() => { samServer.close(); open.forEach(socket => socket.destroy()); });
  const engine = { available: true, bin: 'engine', baseArgs: ['--exec', 'podman'] };
  const tools = {
    detectEngine: async () => engine,
    runExec: async (bin, args) => {
      ran.push(args.slice(2));
      const [command, ...rest] = args.slice(2);
      if (command === 'image' && rest[0] === 'exists') return { ok: images.has(rest[1]), stdout: '', stderr: '' };
      if (command === 'commit') images.add(rest[1]);
      return { ok: true, stdout: '', stderr: '' };
    },
    ensureNetwork: async (info, key) => `synthorg-net-${key}`,
    ensureSeccompProfile: async () => '/mnt/synthorg-data/seccomp.json',
    userns: ['--uidmap=0:1:65535', '--gidmap=0:1:65535'],
    baseImage: async () => 'localhost/synthorg-base:3.23.6',
    muxSource: () => Buffer.from('int main(void) { return 0; }')
  };
  const image = 'localhost/synthorg-bridge-router:3.23.6-' + createHash('sha256').update('int main(void) { return 0; }').digest('hex').slice(0, 10);
  // The program in the container, played here: frames in, sockets to SAM, frames out.
  const carry = (child) => {
    const sockets = new Map();
    let buffer = Buffer.alloc(0);
    const frame = (type, id, payload = Buffer.alloc(0)) => { const head = Buffer.alloc(9); head[0] = type.charCodeAt(0); head.writeUInt32BE(id, 1); head.writeUInt32BE(payload.length, 5); child.stdout.write(Buffer.concat([head, payload])); };
    child.stdin.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 9 && buffer.length >= 9 + buffer.readUInt32BE(5)) {
        const type = String.fromCharCode(buffer[0]);
        const id = buffer.readUInt32BE(1);
        const payload = buffer.subarray(9, 9 + buffer.readUInt32BE(5));
        buffer = buffer.subarray(9 + payload.length);
        if (type === 'O') {
          if (!samUp) { frame('C', id); continue; }
          const socket = net.connect(samServer.address().port, '127.0.0.1');
          sockets.set(id, socket);
          socket.on('connect', () => frame('O', id));
          socket.on('data', data => frame('D', id, data));
          socket.on('error', () => {});
          socket.on('close', () => { if (sockets.delete(id)) frame('C', id); });
        } else if (type === 'D') sockets.get(id)?.write(payload);
        else if (type === 'C') { const socket = sockets.get(id); sockets.delete(id); socket?.destroy(); }
      }
    });
    return () => { for (const socket of sockets.values()) socket.destroy(); sockets.clear(); };
  };
  // What the engine starts: the container in the foreground, and a process for each connection to SAM.
  const spawnImpl = (bin, args, options) => {
    const { PassThrough } = require('node:stream');
    const listeners = {};
    const child = { exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), once: (name, run) => { (listeners[name] = listeners[name] || []).push(run); }, kill() { child.end(0); },
      end(code) { if (child.exitCode !== null) return; child.exitCode = code; child.stdout.end(); (listeners.exit || []).forEach(run => run(code)); } };
    spawned.push({ bin, args: args.slice(2), options, child });
    if (args[2] === 'exec' && args.includes('nc')) {
      const socket = net.connect(samServer.address().port, '127.0.0.1');
      socket.on('error', () => child.end(1));
      child.stdin.pipe(socket);
      socket.pipe(child.stdout, { end: false });
      socket.on('close', () => child.end(0));
      child.kill = () => { socket.destroy(); child.end(0); };
    } else if (args[2] === 'exec') {
      // something written into the container that builds the image
      const written = [];
      child.stdin.on('data', chunk => written.push(chunk));
      child.stdin.on('finish', () => { child.written = Buffer.concat(written).toString(); child.end(0); });
    } else {
      const close = carry(child);
      const end = child.end;
      child.end = (code) => { close(); end(code); };
      child.stdin.on('finish', () => child.end(0));
    }
    return child;
  };
  const router = new BridgeRouter({ tools, spawnImpl });
  assert.equal(router.embeddedAvailable(), false, 'not known until it is asked');
  assert.equal(await router.check(), true);

  let left = 0;
  router.onExit = () => { left++; };
  await router.start({ mode: 'embedded', transit: false, bandwidth: 'P' });
  assert.equal(router.running, true);
  // the image is made once: Alpine's own package, and our program built there with a compiler that does not stay
  assert.deepEqual(ran.filter(args => args[0] === 'exec').map(args => args.slice(2).join(' ')), [
    'apk add --no-cache i2pd',
    'apk add --no-cache --virtual .synthorg-mux gcc musl-dev',
    'gcc -Os -static -s -Wall -o /usr/local/bin/synthorg-mux /tmp/bridge-mux.c',
    'sh -c rm -f /tmp/bridge-mux.c && apk del --no-cache .synthorg-mux'
  ]);
  const source = spawned.find(entry => entry.args[0] === 'exec' && entry.args.includes('cat > /tmp/bridge-mux.c'));
  assert.equal(source.child.written, 'int main(void) { return 0; }');
  assert.deepEqual(ran.find(args => args[0] === 'commit').slice(1), ['synthorg-bridge-router-build', image], 'named after the base and the program: a newer one of either makes a newer image');
  const run = spawned.find(entry => entry.args[0] === 'run');
  const said = run.args.join(' ');
  assert.match(said, /^run --rm -i --init --name=synthorg-bridge-router --log-driver=none --network=synthorg-net-bridge /);
  assert.ok(run.args.includes('--cap-drop=ALL') && run.args.includes('--user=i2pd') && run.args.includes('--security-opt=no-new-privileges'));
  assert.equal(run.args.some(arg => /^--cap-add/.test(arg)), false, 'no capability');
  assert.equal(run.args.some(arg => arg === '-p' || /^--publish/.test(arg)), false, 'no port of this computer');
  assert.deepEqual(run.args.filter((arg, i) => run.args[i - 1] === '-v'), ['synthorg-bridge-router:/var/lib/i2pd:U'], 'a volume of its own, no folder of this computer');
  assert.ok(run.args.includes('--sam.enabled=true') && run.args.includes('--sam.address=127.0.0.1'));
  for (const off of ['http', 'httpproxy', 'socksproxy', 'bob', 'i2cp', 'i2pcontrol', 'upnp']) assert.ok(run.args.includes(`--${off}.enabled=false`), off);
  assert.ok(run.args.includes('--notransit') && run.args.includes('--bandwidth=P'));
  assert.equal(run.options.stdio[0], 'pipe', 'its input is held by the service: when it ends, the router ends');
  assert.match(run.args[run.args.indexOf('-c') + 1], /synthorg-mux 127\.0\.0\.1 7656\nkill \$router/);
  assert.ok(run.args[run.args.indexOf('-c') + 1].startsWith('i2pd "$@" >&2 &'), 'what the router says stays out of the frames');
  // every connection to SAM goes over the container's own input and output: no process more
  const before = spawned.length;
  assert.equal(await router.sam.reachable(), true);
  const [one, two] = await Promise.all([router.mux.open(), router.mux.open()]);
  one.write('HELLO VERSION\n');
  assert.match(String(await new Promise(resolve => one.once('data', resolve))), /HELLO REPLY/);
  two.destroy();
  one.destroy();
  assert.equal(spawned.length, before);
  // what is not this service reaches the router with a process of its own
  const dialled = await router.dial();
  assert.deepEqual(spawned[spawned.length - 1].args, ['exec', '-i', 'synthorg-bridge-router', 'nc', '127.0.0.1', '7656']);
  dialled.destroy();

  await router.stop();
  assert.deepEqual([router.running, left, run.child.exitCode], [false, 0, 0], 'stopped by the app: nothing went away by itself');
  assert.deepEqual(ran[ran.length - 1], ['rm', '-f', 'synthorg-bridge-router']);

  // the image is there: the second start does not make it again
  const builds = ran.filter(args => args[0] === 'commit').length;
  await router.start({ mode: 'embedded' });
  assert.equal(ran.filter(args => args[0] === 'commit').length, builds);
  const second = spawned.filter(entry => entry.args[0] === 'run')[1];
  assert.equal(second.args.includes('--notransit'), false);
  // the container goes away by itself: the bridge is told
  second.child.end(137);
  assert.deepEqual([router.running, left], [false, 1]);
  left = 0;

  // what was connected ends with the container
  await router.start({ mode: 'embedded' });
  const held = await router.mux.open();
  let ended = false;
  held.on('close', () => { ended = true; });
  spawned.filter(entry => entry.args[0] === 'run').pop().child.end(1);
  await until(() => ended, 'the connection ended');
  await assert.rejects(new Mux({ stdin: { destroyed: true, write() {} }, stdout: { on() {}, once() {} }, once() {} }).open().then(() => null, error => { throw error; }), /non risponde|chiuso/);

  // a router that never answers is said, with what it printed last
  samUp = false;
  const failing = router.start({ mode: 'embedded' });
  const runs = spawned.filter(entry => entry.args[0] === 'run').length;
  await until(() => spawned.filter(entry => entry.args[0] === 'run').length === runs + 1, 'the next start');
  const third = spawned.filter(entry => entry.args[0] === 'run').pop();
  third.child.stderr.write('filesystem error: cannot create directory\n');
  await tick(5);
  third.child.end(1);
  await assert.rejects(failing, error => error.status === 500 && /cannot create directory/.test(error.message));
  samUp = true;

  // no runtime for containers: the embedded router is not there, the user's own still is
  engine.available = false;
  assert.equal(await router.check(), false);
  await assert.rejects(router.start({ mode: 'embedded' }), error => error.status === 503 && /Router esterno/.test(error.message));
  await assert.rejects(router.start({ mode: 'external', host: '127.0.0.1', port: 1 }), error => error.status === 503);
  await router.start({ mode: 'external', host: '127.0.0.1', port: samServer.address().port });
  assert.deepEqual([router.running, router.mode], [true, 'external']);
  const started = spawned.length;
  await router.stop();
  assert.equal(spawned.length, started, 'nothing of the user is started or stopped');
});

/* ------------------------------------------------------------------ */
/* The bridge, with a network played here                               */
/* ------------------------------------------------------------------ */

/**
 * I2P as the bridge sees it: sessions on addresses, streams between them. An
 * address with readers is found only by a session that reads with one of
 * their keys.
 */
function network() {
  const hosts = new Map();
  const log = [];
  class Sam {
    async reachable() { return true; }
    async generate() { return 'destination-' + randomBytes(8).toString('hex'); }
    async session({ privateKey, readers = [], readerKey = null, onClose = null }) {
      const address = createHash('sha256').update(privateKey).digest('hex').slice(0, 56) + '.b32.i2p';
      const host = { readers: readers.map(reader => reader.publicKey.toString('hex')), waiting: [], closed: false };
      hosts.set(address, host);
      log.push(['session', address, host.readers.length]);
      const session = {
        address, closed: false,
        accept: () => new Promise((resolve, reject) => { if (host.closed) reject(new Error('closed')); else host.waiting.push({ resolve, reject }); }),
        async connect(target) {
          const to = hosts.get(target);
          const reads = readerKey && to?.readers.includes(noise.publicOf(readerKey).toString('hex'));
          if (!to || to.closed || (to.readers.length && !reads)) throw Object.assign(new Error('Collegamento non riuscito: LeaseSet not found'), { code: 'BRIDGE_UNREACHABLE' });
          const taker = to.waiting.shift();
          if (!taker) throw Object.assign(new Error('Collegamento non riuscito: nobody accepts'), { code: 'BRIDGE_UNREACHABLE' });
          const [near, far] = await pair();
          far.pause();
          taker.resolve({ socket: far, from: 'caller' });
          return near;
        },
        close() {
          if (session.closed) return;
          session.closed = true;
          host.closed = true;
          host.waiting.splice(0).forEach(taker => taker.reject(new Error('closed')));
          if (hosts.get(address) === host) hosts.delete(address);
        },
        drop() { session.close(); onClose?.(); }
      };
      host.session = session;
      return session;
    }
  }
  return { Sam, hosts, log };
}

function bridged({ pairingMs = 60000, idleMs = 60000, retryMs = [] } = {}) {
  const net = network();
  const router = {
    sam: null, starts: [], stops: 0, fails: null,
    embeddedAvailable: () => true,
    get running() { return Boolean(this.sam); },
    async start(settings) { if (this.fails) throw new Error(this.fails); this.starts.push({ ...settings }); this.sam = new net.Sam(); return this.sam; },
    async stop() { if (this.sam) this.stops++; this.sam = null; }
  };
  let store = new Store(':memory:');
  const holder = { store };
  const bridge = new Bridge({ store: () => holder.store, root: path.join(__dirname, '..'), router, version: '9.9.9', pairingMs, idleMs, retryMs });
  const phone = (identity = null) => new Phone({ sam: new net.Sam(), identity, tries: 1 });
  const close = async () => { await bridge.stop(); try { store.close(); } catch {} };
  return { bridge, router, net, holder, phone, close, store };
}

/** The page, played: takes what there is for it and answers each request with `answer`. */
function page(bridge, answer = (request) => ({ header: { t: 'res', id: request.id, ok: true, result: { did: request.method, with: request.params } } })) {
  const seen = [];
  let open = true;
  (async () => {
    while (open) {
      const { messages } = await bridge.inbox(20);
      for (const message of messages) {
        seen.push(message);
        if (message.kind === 'request') await bridge.send({ device: message.device, ...answer(message) });
      }
    }
  // The test has ended and taken the database with it: the page goes too.
  })().catch(() => {});
  return { seen, close: () => { open = false; } };
}

test('off until it is turned on; on, the computer is nowhere to be found until a phone is paired', async t => {
  const { bridge, router, net, close } = bridged();
  t.after(close);
  assert.deepEqual([bridge.status().phase, bridge.status().settings.enabled, bridge.status().address], ['off', false, null]);
  bridge.follow();
  await tick(10);
  assert.equal(router.starts.length, 0, 'nothing starts by itself');
  await assert.rejects(bridge.openPairing(), error => error.status === 409);

  const status = await bridge.configure({ enabled: true, name: 'Studio', bandwidth: 'P' });
  assert.deepEqual([status.phase, status.address, status.devices.length, status.name], ['ready', null, 0, 'Studio']);
  assert.deepEqual([router.starts[0].mode, router.starts[0].transit, router.starts[0].bandwidth], ['embedded', true, 'P']);
  assert.equal(net.hosts.size, 0, 'no session: nothing to reach');
  // changing how the router runs starts it again; a name does not
  await bridge.configure({ name: 'Casa' });
  assert.equal(router.starts.length, 1);
  await bridge.configure({ transit: false });
  assert.deepEqual([router.starts.length, router.starts[1].transit], [2, false]);

  await bridge.configure({ enabled: false });
  assert.deepEqual([bridge.status().phase, router.running], ['off', false]);
});

test('a phone is paired with the code, once; then it comes back with its own key', async t => {
  const { bridge, net, phone, close, store } = bridged();
  t.after(close);
  await bridge.configure({ enabled: true, name: 'Studio' });
  const opened = await bridge.openPairing();
  const told = page(bridge);
  t.after(told.close);
  assert.match(opened.pairing.code, /^SYNTHORG-BRIDGE:1:[A-Z0-9]{56}:[A-Z2-7]{52}:[A-Z2-7]{52}:[A-Z2-7]{52}$/);
  assert.ok(new Date(opened.pairing.expiresAt) > new Date());
  const code = readCode(opened.pairing.code);
  assert.equal(code.address, opened.address);
  assert.ok(code.publicKey.equals(noise.publicOf(Buffer.from(store.bridge().key('static_private'), 'hex'))));
  assert.deepEqual(net.log[net.log.length - 1], ['session', opened.address, 1], 'the address is readable by the phone to come, and by nobody else');
  assert.match(qr.svg(opened.pairing.code), /^<svg /);

  const mine = phone();
  const events = [];
  mine.onEvent = (name, data) => events.push([name, data]);
  const welcome = await mine.pair(opened.pairing.code, { name: 'Pixel', platform: 'android' });
  assert.deepEqual([welcome.paired, welcome.device.name, welcome.desktop.name, welcome.desktop.version, welcome.protocol], [true, 'Pixel', 'Studio', '9.9.9', 1]);
  const status = bridge.status();
  assert.deepEqual(plain(status.devices.map(d => [d.name, d.platform, d.connected])), [['Pixel', 'android', true]]);
  assert.deepEqual([status.pairing, status.address], [null, opened.address], 'the code is used; the address stays');
  await until(() => told.seen.some(m => m.kind === 'connected'), 'the page told of the phone');
  assert.deepEqual(told.seen.filter(m => m.kind !== 'status').map(m => m.kind), ['paired', 'connected']);

  // the same code, read by somebody else: it is worth nothing
  const thief = phone();
  await assert.rejects(thief.pair(opened.pairing.code, { name: 'Altro' }));
  assert.equal(bridge.status().devices.length, 1);

  // requests go to the page and come back; a ping is answered here
  assert.deepEqual((await mine.call('projects.list', { all: true })).result, { did: 'projects.list', with: { all: true } });
  const sent = await mine.call('assistant.say', {}, { body: Buffer.from('recording') });
  assert.equal(told.seen.find(m => m.method === 'assistant.say').body, Buffer.from('recording').toString('base64'));
  assert.equal(sent.result.did, 'assistant.say');
  assert.equal((await mine.call('ping')).result.page, true);
  assert.equal(told.seen.some(m => m.method === 'ping'), false);

  // the page tells every phone, or one
  assert.deepEqual(await bridge.send({ header: { t: 'evt', name: 'reminder', data: { title: 'Dentista' } } }), { sent: 1 });
  await until(() => events.some(([name]) => name === 'reminder'), 'the event');
  assert.deepEqual(await bridge.send({ device: 'nobody', header: { t: 'evt', name: 'x' } }), { sent: 0 });
  await assert.rejects(bridge.send({ header: { t: 'req', id: 1, method: 'x' } }), /non valido/);

  // gone and back: a session, no code
  mine.channel.close();
  await until(() => !bridge.status().devices[0].connected, 'the phone gone');
  const again = phone(mine.identity);
  const back = await again.connect();
  assert.deepEqual([back.paired, back.device.id], [false, welcome.device.id]);
  assert.equal(bridge.status().devices[0].connected, true);

  // a key that was never paired, with everything else right
  const stranger = phone({ ...mine.identity, staticKey: noise.generateStatic().privateKey.toString('hex') });
  await assert.rejects(stranger.connect());
  assert.equal(bridge.status().devices.length, 1);
});

test('the app closing while the bridge is still starting: closed at once, and not started again', async t => {
  const { bridge, router, close } = bridged();
  t.after(close);
  let release;
  router.start = async function (settings) { this.starts.push({ ...settings }); await new Promise(resolve => { release = resolve; }); this.sam = null; throw new Error('router gone'); };
  const starting = bridge.configure({ enabled: true }).catch(() => {});
  await until(() => router.starts.length === 1, 'the start begun');
  const began = Date.now();
  await bridge.shutdown();
  assert.ok(Date.now() - began < 1000, 'not waiting behind the start');
  assert.equal(bridge.status().phase, 'off');
  release();
  await starting;
  bridge.follow();
  await tick(20);
  assert.deepEqual([bridge.status().phase, router.starts.length], ['off', 1], 'nothing tried again');
});

test('the readers of the address never change under a running router: it is started again', async t => {
  const { bridge, router, net, phone, close } = bridged();
  t.after(close);
  await bridge.configure({ enabled: true });
  assert.equal(router.starts.length, 1);
  // the first session on the address: the router that was started holds it
  const first = phone();
  await first.pair((await bridge.openPairing()).pairing.code, { name: 'Uno' });
  assert.equal(router.starts.length, 1);
  // a second phone: new readers, so a router that has not held the address yet
  const opened = await bridge.openPairing();
  assert.equal(router.starts.length, 2);
  assert.deepEqual(net.log[net.log.length - 1], ['session', opened.address, 2]);
  const second = phone();
  await second.pair(opened.pairing.code, { name: 'Due' });
  assert.equal(router.starts.length, 2, 'the code used: its reader stays, nothing starts again');
  // a phone removed: its reader goes, with a router started again
  await bridge.removeDevice(bridge.status().devices[0].id);
  assert.equal(router.starts.length, 3);
  assert.deepEqual([bridge.status().phase, bridge.status().devices.length], ['ready', 1]);
  // turned off and on: a new router anyway, once
  await bridge.configure({ enabled: false });
  await bridge.configure({ enabled: true });
  assert.equal(router.starts.length, 4);
});

test('a phone that asks while no page is there is told so', async t => {
  const { bridge, phone, close } = bridged();
  t.after(close);
  await bridge.configure({ enabled: true });
  const mine = phone();
  await mine.pair((await bridge.openPairing()).pairing.code);
  await assert.rejects(mine.call('state'), error => error.code === 'page_away');
  assert.equal((await mine.call('ping')).result.page, false);
  const told = page(bridge);
  t.after(told.close);
  await tick(30);
  assert.equal((await mine.call('state')).result.did, 'state');
});

test('a code runs out, is withdrawn, and is closed by guesses at its secret', async t => {
  const { bridge, net, phone, close } = bridged({ pairingMs: 60 });
  t.after(close);
  await bridge.configure({ enabled: true });
  const first = await bridge.openPairing();
  await until(() => !bridge.status().pairing && !bridge.status().preparingPairing, 'the code run out');
  assert.equal(net.hosts.size, 0, 'with the code goes the key it carried: nothing to reach again');
  await assert.rejects(phone().pair(first.pairing.code));

  bridge.pairingMs = 60000;
  const second = await bridge.openPairing();
  assert.notEqual(second.pairing.code, first.pairing.code);
  assert.equal((await bridge.closePairing()).pairing, null);
  await assert.rejects(phone().pair(second.pairing.code));

  const third = await bridge.openPairing();
  const wrong = third.pairing.code.split(':');
  wrong[4] = 'A'.repeat(52);
  for (let i = 0; i < 5; i++) await assert.rejects(phone().pair(wrong.join(':')));
  await until(() => !bridge.status().pairing, 'the pairing closed');
  await assert.rejects(phone().pair(third.pairing.code), 'the right code, too late');
});

test('a phone removed cannot come back nor find the computer; the others stay', async t => {
  const { bridge, net, phone, close } = bridged();
  t.after(close);
  await bridge.configure({ enabled: true });
  const told = page(bridge);
  t.after(told.close);
  const one = phone();
  const first = await one.pair((await bridge.openPairing()).pairing.code, { name: 'Uno' });
  const two = phone();
  const second = await two.pair((await bridge.openPairing()).pairing.code, { name: 'Due' });
  // pairing the second one built the address again: the first comes back by itself
  const oneBack = phone(one.identity);
  await oneBack.connect();
  assert.deepEqual(plain(bridge.status().devices.map(d => [d.name, d.connected])), [['Uno', true], ['Due', true]]);

  assert.equal(bridge.renameDevice(first.device.id, 'Telefono di casa').devices[0].name, 'Telefono di casa');
  assert.throws(() => bridge.renameDevice(first.device.id, '  '), /Nome mancante/);

  const status = await bridge.removeDevice(first.device.id);
  assert.deepEqual(plain(status.devices.map(d => d.name)), ['Due']);
  assert.deepEqual(net.log[net.log.length - 1].slice(2), [1], 'one reader left');
  await assert.rejects(phone(one.identity).connect(), /LeaseSet not found/);
  const twoBack = phone(two.identity);
  assert.equal((await twoBack.connect()).device.id, second.device.id);
  await assert.rejects(bridge.removeDevice('nobody'), error => error.status === 404);

  // new keys: nobody is paired any more, and the address is another
  const before = bridge.status().address;
  const forgotten = await bridge.forget();
  assert.deepEqual([forgotten.devices.length, forgotten.address, forgotten.phase], [0, null, 'ready']);
  await assert.rejects(phone(two.identity).connect());
  const fresh = await bridge.openPairing();
  assert.notEqual(fresh.address, before);
});

test('a phone that says nothing for long is let go; the newest connection of a phone is the one kept', async t => {
  const { bridge, phone, close } = bridged({ idleMs: 80 });
  t.after(close);
  await bridge.configure({ enabled: true });
  const told = page(bridge);
  t.after(told.close);
  const mine = phone();
  await mine.pair((await bridge.openPairing()).pairing.code);
  bridge.idleMs = 60000;
  await until(() => told.seen.some(m => m.kind === 'disconnected' && m.reason === 'idle'), 'let go');
  const first = phone(mine.identity);
  await first.connect();
  let closed = false;
  first.onClose = () => { closed = true; };
  const second = phone(mine.identity);
  await second.connect();
  await until(() => closed, 'the older connection closed');
  assert.equal(bridge.connections.size, 1);
  assert.equal((await second.call('ping')).result.page, true);
});

test('the bridge follows the database when it is locked, and tries again when the router goes away', async t => {
  const { bridge, router, net, holder, phone, close } = bridged({ retryMs: [20] });
  t.after(close);
  await bridge.configure({ enabled: true });
  const mine = phone();
  await mine.pair((await bridge.openPairing()).pairing.code);
  const store = holder.store;

  // the session goes away by itself
  [...net.hosts.values()][0].session.drop();
  await until(() => bridge.status().phase === 'error', 'the loss seen');
  assert.match(bridge.status().error, /ha chiuso la sessione/);
  await until(() => bridge.status().phase === 'ready' && bridge.status().address, 'started again');
  assert.equal((await phone(mine.identity).connect()).paired, false);

  // locked: everything stops, and nothing can be asked
  holder.store = null;
  bridge.follow();
  await until(() => bridge.phase === 'off', 'stopped');
  assert.deepEqual([router.running, bridge.status().locked, bridge.status().devices.length], [false, true, 0]);
  await assert.rejects(bridge.configure({ enabled: true }), error => error.status === 423);
  // unlocked: it was on, it is on again
  holder.store = store;
  bridge.follow();
  await until(() => bridge.status().phase === 'ready' && bridge.status().address, 'on again');

  // a router that does not start is said, not tried for ever
  await bridge.configure({ enabled: false });
  router.fails = 'Un router i2pd è già in esecuzione su questo computer.';
  await assert.rejects(bridge.configure({ enabled: true }), /già in esecuzione/);
  assert.deepEqual([bridge.status().phase, bridge.status().error], ['error', router.fails]);
  assert.equal(bridge.status().settings.enabled, true, 'what the user chose stays chosen');
  router.fails = null;
  assert.equal((await bridge.configure({ enabled: true })).phase, 'ready');
});

test('two switches: the connection for the open app, the service for the closed one, both off for nothing at all', async t => {
  const { bridge, router, phone, close, store } = bridged();
  t.after(close);
  const settled = async () => { await tick(5); await bridge.work; };
  assert.deepEqual([bridge.status().settings.enabled, bridge.status().settings.service, bridge.status().windowOpen], [false, false, true]);

  // the service alone: off while the window is open, on when it is closed
  let status = await bridge.configure({ service: true, autostart: true });
  assert.deepEqual([status.phase, status.wanted, router.running], ['off', false, false]);
  // starting with the computer is not a setting of the bridge: it is what the system holds, moved by its own switch alone
  assert.deepEqual(['autostart' in status.settings, JSON.parse(store.getSetting('bridge'))], [false, { service: true }]);
  bridge.setWindow(false);
  await settled();
  assert.deepEqual([bridge.status().phase, bridge.status().wanted, router.running], ['ready', true, true]);
  bridge.setWindow(true);
  await settled();
  assert.deepEqual([bridge.status().phase, router.running], ['off', false]);

  // the connection alone: on with the window open, off when the app goes on without it
  status = await bridge.configure({ enabled: true, service: false });
  assert.equal(status.phase, 'ready');
  bridge.setWindow(false);
  await settled();
  assert.equal(bridge.status().phase, 'off');

  // both: on whatever the window does, and what is connected stays connected
  bridge.setWindow(true);
  status = await bridge.configure({ service: true });
  const starts = router.starts.length;
  const mine = phone();
  await mine.pair((await bridge.openPairing()).pairing.code);
  bridge.setWindow(false);
  await settled();
  bridge.setWindow(true);
  await settled();
  assert.deepEqual([bridge.status().phase, router.starts.length, bridge.status().devices[0].connected], ['ready', starts, true]);

  // both off: nothing runs
  status = await bridge.configure({ enabled: false, service: false });
  assert.deepEqual([status.phase, router.running, bridge.connections.size], ['off', false, 0]);
  bridge.setWindow(false);
  await settled();
  assert.equal(bridge.status().phase, 'off');
});

test('with the service alone a phone is paired with the window open: the bridge is on for that, and off again after', async t => {
  const { bridge, router, phone, close } = bridged({ pairingMs: 60000 });
  t.after(close);
  const settled = async () => { await tick(5); await bridge.work; };
  await assert.rejects(bridge.openPairing(), error => error.status === 409 && /spento/.test(error.message));
  await bridge.configure({ service: true });
  assert.equal(bridge.status().phase, 'off');

  const opened = await bridge.openPairing();
  assert.deepEqual([opened.phase, Boolean(opened.pairing), opened.wanted], ['ready', true, true]);
  // withdrawn: nothing to stay on for
  await bridge.closePairing();
  await until(() => bridge.status().phase === 'off', 'off again');
  assert.equal(router.running, false);

  // used: the phone stays until it goes, then the switches decide
  const mine = phone();
  await mine.pair((await bridge.openPairing()).pairing.code);
  await settled();
  assert.deepEqual([bridge.status().phase, bridge.status().devices[0].connected], ['ready', true]);
  mine.channel.close();
  await until(() => bridge.status().phase === 'off', 'off after the phone left');
  // the window is closed: the phone finds the computer with the key it has
  bridge.setWindow(false);
  await settled();
  assert.equal((await phone(mine.identity).connect()).paired, false);
});

test('over the network: the settings, a pairing, what passes between a phone and the page', async t => {
  const net = network();
  const router = { sam: null, embeddedAvailable: () => true, get running() { return Boolean(this.sam); }, async start() { this.sam = new net.Sam(); return this.sam; }, async stop() { this.sam = null; } };
  let app;
  const bridge = new Bridge({ store: () => app?.store, root: path.join(__dirname, '..'), router, version: '1.0.0' });
  app = createApp({ token: 'secret', dbPath: ':memory:', githubPort: 0, bridge, sandbox: { async stopAllContainers() { return { success: true, count: 0 }; }, async deleteWorkspace() {} } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const call = async (method, url, body, token = 'secret') => {
    const response = await fetch(base + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, ...(await response.json()) };
  };
  assert.equal((await call('GET', '/bridge', null, 'wrong')).status, 401);
  assert.deepEqual([(await call('GET', '/bridge')).phase, (await call('GET', '/settings/bridge')).value], ['off', null]);
  assert.equal((await call('POST', '/bridge/pairing', {})).status, 409);
  const on = await call('PUT', '/bridge', { enabled: true, mode: 'external', host: 'localhost', port: 7777 });
  assert.deepEqual([on.phase, on.settings.mode, on.settings.port], ['ready', 'external', 7777]);
  assert.deepEqual(JSON.parse((await call('GET', '/settings/bridge')).value), { enabled: true, mode: 'external', host: 'localhost', port: 7777 }, 'only what differs from the defaults is written');

  const opened = await call('POST', '/bridge/pairing', {});
  const mine = new Phone({ sam: new net.Sam(), tries: 1 });
  const pairing = mine.pair(opened.pairing.code, { name: 'Pixel' });
  const first = await call('GET', '/bridge/inbox?wait=2000');
  await pairing;
  const seen = [...first.messages, ...(await call('GET', '/bridge/inbox?wait=0')).messages];
  assert.ok(seen.some(m => m.kind === 'paired' && m.device.name === 'Pixel'));

  const asking = mine.call('projects.list');
  const got = await call('GET', '/bridge/inbox?wait=2000');
  const request = got.messages.find(m => m.kind === 'request');
  assert.deepEqual([request.method, got.status.devices[0].connected], ['projects.list', true]);
  assert.deepEqual((await call('POST', '/bridge/send', { device: request.device, header: { t: 'res', id: request.id, ok: true, result: { projects: [] } }, body: Buffer.from('x').toString('base64') })).sent, 1);
  const answer = await asking;
  assert.deepEqual([answer.result, String(answer.body)], [{ projects: [] }, 'x']);

  const device = got.status.devices[0].id;
  assert.equal((await call('PATCH', `/bridge/devices/${device}`, { name: 'Mio' })).devices[0].name, 'Mio');
  assert.equal((await call('DELETE', `/bridge/devices/${device}`)).devices.length, 0);
  assert.equal((await call('POST', '/bridge/forget', {})).phase, 'ready');
  assert.equal((await call('PUT', '/bridge', { enabled: false })).phase, 'off');
  // the window closed with the app going on: the service's turn
  assert.equal((await call('PUT', '/bridge', { service: true })).phase, 'off');
  const closed = await call('PUT', '/bridge/window', { open: false });
  assert.deepEqual([closed.windowOpen, closed.wanted], [false, true]);
  await until(async () => (await call('GET', '/bridge')).phase === 'ready', 'on with the window closed');
  assert.equal((await call('PUT', '/bridge/window', { open: true })).windowOpen, true);
  await until(async () => (await call('GET', '/bridge')).phase === 'off', 'off with the window open');
  assert.equal((await call('GET', '/bridge/nothing')).status, 404);
});

/* ------------------------------------------------------------------ */
/* The code shown to the phone                                          */
/* ------------------------------------------------------------------ */

test('the QR code of a pairing is drawn as the codes a camera reads', () => {
  const print = (text) => createHash('sha256').update(qr.matrix(text).map(row => row.map(v => (v ? 1 : 0)).join('')).join('\n')).digest('hex');
  const code = 'SYNTHORG-BRIDGE:1:' + 'A'.repeat(56) + ':' + 'B'.repeat(52) + ':' + 'C'.repeat(52) + ':' + 'D'.repeat(52);
  // Each of these was read back by a decoder that is not ours (jsQR) when the fingerprint was taken.
  assert.deepEqual([qr.matrix('HELLO').length, print('HELLO')], [21, '77ae2525f1e2d57e0f3aa8f80bf9019d7f85f747d17c5f160884a64f2c310c7d']);
  assert.deepEqual([qr.matrix(code).length, print(code)], [53, '6dbf4f02e63a9b4397e9f152ac7a7c4478587606c87b14721222cd0ce21e058e']);
  assert.deepEqual([qr.matrix('Città — perché no?').length, print('Città — perché no?')], [25, '462800605d14227c719198d4a806bc461f41e9c30ced157b1b36be1ff85e8111']);
  // the three corners every reader looks for
  const rows = qr.matrix(code);
  const corner = (x, y) => [0, 1, 2, 3, 4, 5, 6].map(i => rows[y][x + i]).every(Boolean) && rows[y + 1][x + 1] === false && rows[y + 3][x + 3] === true;
  assert.ok(corner(0, 0) && corner(rows.length - 7, 0) && corner(0, rows.length - 7));
  assert.throws(() => qr.matrix('x'.repeat(4000)), /troppo lungo/);
  const drawn = qr.svg(code, { title: 'Codice "QR"' });
  assert.match(drawn, /viewBox="0 0 61 61"/);
  assert.match(drawn, /aria-label="Codice &quot;QR&quot;"/);
  assert.equal(drawn.includes(code), false, 'the drawing does not carry the code as text');
});

/* ------------------------------------------------------------------ */
/* The page: what a phone asks, done where the assistant is             */
/* ------------------------------------------------------------------ */

function phonePage({ connected = true, enabled = true, service = false, shell = null } = {}) {
  const sent = [];        // what the page gives the service for the phones
  const spoken = [];      // what is asked of the voice
  const kept = [];
  const turns = [];
  const settings = new Map();
  const inbox = [];
  const windows = [];     // what the service was told of the window
  let wake = null;
  const device = { id: 'phone-1', name: 'Pixel', connected };
  const status = () => ({ protocol: 1, locked: false, embeddedAvailable: true, phase: enabled ? 'ready' : 'off', error: '', address: 'x.b32.i2p', name: 'Studio',
    settings: { enabled, service, mode: 'embedded', host: '127.0.0.1', port: 7656, user: '', password: '', transit: true, bandwidth: 'O', name: '' }, devices: [{ ...device }], pairing: null, preparingPairing: false });
  const node = () => ({ hidden: false, disabled: false, className: '', dataset: {}, innerHTML: '', textContent: '', value: '', placeholder: '', title: '',
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, setAttribute() {}, addEventListener() {}, querySelector: () => node(), querySelectorAll: () => [] });
  const approvals = [];
  const window = {
    RealtimeWellbeing: W,
    synthQr: qr,
    i18n: { t: (key, p) => key + (p && Object.keys(p).length ? ' ' + JSON.stringify(p) : ''), getLocale: () => 'it' },
    openRouterCatalog: { getApiKey: () => 'key', models: [] },
    operationalRegistry: { getCurrentRealtimeMultiModel: () => ({ id: 'model/listens', name: 'Listens' }), getToolDelegate: (tool) => (tool === 'voice_synthesis' ? 'model/voice' : 'auto') },
    modelGateway: {
      fetchApi: async (url, options) => { spoken.push(JSON.parse(options.body).input); return { ok: true, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: true }) }) } }; }
    },
    chatStorage: {
      realtime: async () => ({ conversation: { id: 'rt' }, tasksConversationId: 'tasks' }),
      context: async () => ({ messages: [], memories: [] }),
      getSetting: async (key) => ({ value: settings.get(key) ?? null }),
      setSetting: async (key, value) => { settings.set(key, value); },
      get: async (id) => ({ conversation: { id, project_id: id === 'rt' ? null : 'p1' }, messages: kept.filter(row => row[0] === id).map(row => row[3]) }),
      listProjects: async () => [{ id: 'p1', name: 'Sito', kind: 'local', opened_at: '2026-09-28T10:00:00Z' }, { id: 'p2', name: 'Server', kind: 'podman', repo: 'me/server' }],
      listProjectChats: async (id) => (id === 'p1' ? [{ id: 'c1', title: 'Chat 1', updated_at: 'now', message_count: 2 }] : []),
      create: async (projectId, title) => ({ id: 'new-chat', title, project_id: projectId }),
      openProject: async (id) => { turns.push({ opened: id }); },
      agenda: async (from, to) => [{ id: 'a1', title: 'Dentista', from, to }],
      handedFiles: async () => ({ files: [{ id: 'f1', name: 'faro.png', kind: 'image', url: '/api/conversations/tasks/sandbox/files/faro.png', created_at: 'now', seen_at: null }], more: false }),
      bridgeStatus: async () => status(),
      bridgeWindow: async (open) => { windows.push(open); return status(); },
      bridgeInbox: () => new Promise(resolve => {
        const give = () => resolve({ messages: inbox.splice(0), status: status() });
        if (inbox.length) give(); else wake = give;
      }),
      bridgeSend: async (message) => { sent.push(plain(message)); return { sent: 1 }; }
    },
    chatManager: {
      makeMessage: (role, content, meta = {}) => ({ id: crypto.randomUUID(), role, content, timestamp: '2026-09-29T09:00:00.000Z', status: 'complete', ...meta }),
      persist: async (message, id) => { kept.push([id, message.role, message.content, { ...message }]); },
      recordTurnChatMemory: async () => {},
      shownFiles: (answer) => answer.files || [],
      runBackgroundTurn: (id, text, options) => new Promise((done, fail) => {
        const turn = { id, text, options, done, fail };
        options.signal?.addEventListener('abort', () => fail(new DOMException('Turno fermato.', 'AbortError')));
        turns.push(turn);
      }),
      awaitApproval(tc, approval) { return new Promise(resolve => approvals.push({ id: approval.id, resolve })); },
      settleApproval(id, answer) { approvals.find(a => a.id === id)?.resolve(answer); },
      async decideApproval(id, decision) { this.settleApproval(id, { approved: decision === 'allow' }); },
      cancelPendingApprovals() {}
    }
  };
  if (shell) window.__TAURI__ = shell;
  const document = { readyState: 'complete', addEventListener() {}, getElementById: () => null, body: node(), createElement: () => node() };
  const sandbox = { window, document, console, crypto, AbortController, DOMException, performance, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, indexedDB: undefined,
    atob: (text) => Buffer.from(text, 'base64').toString('latin1'), btoa: (text) => Buffer.from(text, 'latin1').toString('base64'), Uint8Array, fetch: async () => ({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer }) };
  vm.createContext(sandbox);
  for (const file of ['realtime.js', 'realtime-features.js', 'realtime-phone.js', 'bridge.js']) vm.runInContext(read('resources/js/' + file), sandbox);
  const rt = window.realtime._state;
  rt.build = () => {};
  rt.ui = { stage: node(), status: node(), talk: node(), interrupt: node(), stopTask: node(), confirmYes: node(), confirmNo: node(), input: node(), form: node(), puppet: node(), user: node(), bot: node(), side: null };
  rt.player = { playing: false, stop() {}, pushBytes() {}, nextTime: 0, ctx: { currentTime: 0 } };
  rt.systemPrompt = () => [{ text: 'rules' }];
  rt.renderSettings = () => {};
  rt.renderSide = () => {};
  rt.handNext = () => {};
  rt.handOver = async (answer) => answer.files || [];
  rt.handedText = () => '';
  rt.loaded = true;
  rt.conversationId = 'rt';
  const answers = [];
  // What the model answers, given to the voice as it comes, as the real stream does.
  rt.stream = async () => { const answer = answers.shift() || { transcript: '', toolCalls: [] }; rt.speechFeed(answer.transcript); return answer; };
  // Parts of the section that live in files not loaded here.
  rt.analyze = () => {};
  rt.weeklyReview = () => {};
  rt.diaryStepLabel = () => '';
  let nextId = 1;
  /** The phone asks: resolves with the answer the page gives back for it. */
  const ask = async (method, params = {}, body = null) => {
    const id = nextId++;
    inbox.push({ kind: 'request', device: 'phone-1', id, method, params, body: body ? Buffer.from(body).toString('base64') : null });
    if (wake) { const give = wake; wake = null; give(); }
    await until(() => sent.some(m => m.header.t === 'res' && m.header.id === id), `the answer to ${method}`);
    return sent.find(m => m.header.t === 'res' && m.header.id === id);
  };
  const events = (name) => sent.filter(m => m.header.t === 'evt' && m.header.name === name).map(m => m.header.data);
  return { window, rt, bridge: window.phoneBridge, ask, events, sent, spoken, kept, turns, answers, approvals, device, settings, windows,
    tool: (name) => window.realtime.tools.find(x => x.name === name) };
}

test('what a phone says to the assistant is answered in writing, and nothing is said aloud on the computer', async () => {
  const { rt, bridge, ask, events, spoken, kept, answers } = phonePage();
  await until(() => bridge.status && rt.phone, 'the bridge up');
  assert.equal(bridge.there(), true);
  answers.push({ transcript: 'Ciao! Tutto bene. 😊', toolCalls: [] });
  const answer = await ask('assistant.say', { text: 'Ciao, come va?' });
  assert.deepEqual(answer.header, { t: 'res', id: 1, ok: true, result: { accepted: true } });
  await until(() => events('assistant.message').length === 2, 'both sides of the exchange told');
  assert.deepEqual(events('assistant.message').map(m => [m.role, m.text]), [['user', 'Ciao, come va?'], ['assistant', 'Ciao! Tutto bene. 😊']]);
  assert.deepEqual(spoken, [], 'no voice was asked for');
  assert.deepEqual(kept.map(row => row.slice(0, 3)), [['rt', 'user', 'Ciao, come va?'], ['rt', 'assistant', 'Ciao! Tutto bene. 😊']], 'it is the same conversation as on the computer');
  assert.equal(rt.from, 'phone');
  assert.ok(events('assistant.state').length > 0);
  assert.deepEqual([events('assistant.state').pop().busy, events('assistant.state').pop().phase], [false, 'idle']);

  // the history, as the phone reads it back: what the app tells the assistant is not part of it
  kept.push(['rt', 'user', '[Esito del compito]', { id: 'r1', role: 'user', content: '[Esito del compito]', report: true }]);
  const history = await ask('assistant.history', { limit: 1 });
  assert.deepEqual([history.header.result.messages.map(m => m.text), history.header.result.more], [['Ciao! Tutto bene. 😊'], true]);

  // at the computer, with the section on screen, the voice answers as before
  rt.active = true;
  answers.push({ transcript: 'Eccomi qui.', toolCalls: [] });
  rt.hear({ text: 'Ci sei?' });
  await until(() => spoken.length > 0, 'the voice asked for');
  assert.deepEqual([rt.from, spoken.join(' ')], ['desk', 'Eccomi qui.']);
  await until(() => !rt.busy, 'the exchange ended');
  assert.deepEqual(events('assistant.message').slice(-2).map(m => m.text), ['Ci sei?', 'Eccomi qui.'], 'and the phone is told what was said there too');
});

test('a phone is refused what cannot be done now, with the reason', async () => {
  const { rt, bridge, ask, window } = phonePage();
  await until(() => bridge.status && rt.phone, 'the bridge up');
  assert.deepEqual((await ask('assistant.say', { text: '  ' })).header.error.code, 'empty');
  assert.deepEqual((await ask('no.such.thing')).header.error.code, 'unknown_method');
  assert.deepEqual((await ask('assistant.confirm', { yes: true })).header.error.code, 'nothing_to_confirm');
  rt.startTask('Un compito');
  assert.deepEqual((await ask('assistant.say', { text: 'Ciao' })).header.error.code, 'working');
  rt.stopTasks();
  rt.diarySession = { step: 'account' };
  assert.deepEqual((await ask('assistant.say', { text: 'Ciao' })).header.error.code, 'diary');
  rt.diarySession = null;
  window.operationalRegistry.getCurrentRealtimeMultiModel = () => null;
  assert.deepEqual((await ask('assistant.say', { text: 'Ciao' })).header.error.code, 'no_model');
  window.openRouterCatalog.getApiKey = () => '';
  assert.deepEqual((await ask('assistant.say', { text: 'Ciao' })).header.error.code, 'no_key');
  assert.deepEqual((await ask('projects.task', { projectId: 'nope', text: 'x' })).header.error.code, 'no_project');
  assert.deepEqual((await ask('projects.stop', { taskId: 'nope' })).header.error.code, 'no_task');
  assert.deepEqual((await ask('approvals.decide', { id: 'nope', decision: 'allow' })).header.error.code, 'no_approval');
});

test('a task the assistant wants to hand over is asked about on the phone, and answered from it', async () => {
  const { rt, bridge, ask, events, spoken, turns, answers, tool } = phonePage();
  await until(() => bridge.status && rt.phone, 'the bridge up');
  answers.push({ transcript: '', toolCalls: [{ id: 't1', name: 'work', args: JSON.stringify({ task: 'Cerca il prezzo del faro' }) }] });
  assert.ok(tool('work'));
  await ask('assistant.say', { text: 'Quanto costa il faro?' });
  await until(() => rt.confirming, 'the question asked');
  assert.equal(events('assistant.state').pop().confirming.task, 'Cerca il prezzo del faro');
  assert.match(events('assistant.message').pop().text, /realtime\.confirmOpening.*«Cerca il prezzo del faro».*realtime\.confirmQuestion/);
  // the section is not on screen, and is left: the question stays, a phone is there to answer it
  await rt.setActive(false);
  rt.active = true;
  await rt.setActive(false);
  assert.ok(rt.confirming);
  assert.deepEqual((await ask('assistant.confirm', { yes: true })).header.result, { accepted: true });
  await until(() => turns.length === 1, 'the task handed');
  assert.deepEqual([turns[0].id, turns[0].text], ['tasks', 'Cerca il prezzo del faro']);
  assert.equal(events('assistant.state').pop().working, true);
  assert.deepEqual(events('assistant.state').pop().tasks.map(task => [task.text, task.status]), [['Cerca il prezzo del faro', 'running']]);
  // it made no file: the phone is asked whether the outcome is to be told, and answers
  answers.push({ transcript: 'Costa due milioni.', toolCalls: [] });
  turns[0].done({ content: 'Il faro costa 2 milioni.' });
  await until(() => rt.confirming?.outcome, 'the outcome asked about');
  assert.deepEqual(events('assistant.state').pop().confirming, { task: 'Cerca il prezzo del faro', outcome: true });
  assert.match(events('assistant.message').pop().text, /realtime\.outcomeDone «Cerca il prezzo del faro» realtime\.outcomeQuestion/);
  assert.deepEqual((await ask('assistant.confirm', { yes: true })).header.result, { accepted: true });
  await until(() => events('assistant.message').some(m => m.text === 'Costa due milioni.'), 'the outcome told');
  assert.deepEqual(spoken, []);
  assert.equal(events('assistant.message').some(m => /Esito del compito/.test(m.text)), false, 'what the app told the assistant is not shown');

  // with nobody on the phone a question left behind is dropped, as before
  const alone = phonePage({ connected: false });
  await until(() => alone.bridge.status && alone.rt.phone, 'the bridge up');
  alone.rt.active = true;
  alone.rt.confirming = { task: 'x' };
  await alone.rt.setActive(false);
  assert.equal(alone.rt.confirming, null);
  assert.deepEqual([alone.rt.written(), alone.sent.length], [false, 0]);
});

test('a task for a project goes to its Master at once, and the phone follows it', async () => {
  const { bridge, rt, ask, events, turns, kept, window } = phonePage();
  await until(() => bridge.status && rt.phone, 'the bridge up');
  const list = (await ask('projects.list')).header.result.projects;
  assert.deepEqual(list.map(p => [p.id, p.name, p.kind, p.repo, p.running]), [['p1', 'Sito', 'local', null, 0], ['p2', 'Server', 'container', 'me/server', 0]]);
  assert.deepEqual((await ask('projects.chats', { projectId: 'p1' })).header.result.chats, [{ id: 'c1', title: 'Chat 1', updatedAt: 'now', messages: 2 }]);

  const started = (await ask('projects.task', { projectId: 'p1', text: 'Aggiungi la pagina contatti' })).header.result.task;
  assert.deepEqual([started.status, started.chatId, started.projectId], ['running', 'c1', 'p1']);
  await until(() => turns.length === 1, 'the turn asked');
  assert.deepEqual([turns[0].id, turns[0].text, turns[0].options.whole, Boolean(turns[0].options.fresh)], ['c1', 'Aggiungi la pagina contatti', true, false]);
  assert.equal((await ask('projects.list')).header.result.projects[0].running, 1);
  // what is written in that chat meanwhile is told
  const writing = window.chatManager.makeMessage('assistant', 'Sto creando contatti.html');
  await window.chatManager.persist(writing, 'c1');
  // saved again as it is, as an answer being written is: told once
  await window.chatManager.persist(writing, 'c1');
  await window.chatManager.persist({ ...writing, reasoning: 'penso' }, 'c1');
  await window.chatManager.persist(window.chatManager.makeMessage('assistant', 'In un\'altra chat'), 'c9');
  assert.deepEqual(events('chat.message').map(m => [m.chatId, m.text]), [['c1', 'Sto creando contatti.html']]);
  turns[0].done({ content: 'Pagina creata.', files: [{ name: 'contatti.html', url: '/api/x', kind: 'document' }] });
  await until(() => events('task.update').some(task => task.status === 'done'), 'the task ended');
  assert.deepEqual(plain(events('task.update').map(task => [task.status, task.answer, task.files.length])), [['running', '', 0], ['done', 'Pagina creata.', 1]]);

  // a project in a container is started first; without a chat it gets one
  const second = (await ask('projects.task', { projectId: 'p2', text: 'Riavvia il servizio' })).header.result.task;
  await until(() => turns.length === 3, 'opened and asked');
  assert.deepEqual([plain(turns[1]), turns[2].id, second.chatId], [{ opened: 'p2' }, 'new-chat', 'new-chat']);
  // stopped from the phone
  const stopped = (await ask('projects.stop', { taskId: second.id })).header.result.task;
  assert.equal(stopped.id, second.id);
  await until(() => events('task.update').some(task => task.id === second.id && task.status === 'stopped'), 'the task stopped');
  assert.equal(bridge.tasks.get(second.id).status, 'stopped');
  assert.equal(kept.length, 4);

  assert.deepEqual((await ask('agenda.list', { from: '2026-09-29T00:00', to: '2026-09-30T00:00' })).header.result.items[0].title, 'Dentista');
  assert.deepEqual((await ask('files.list')).header.result.files.map(f => [f.id, f.name, f.kind, f.seen]), [['f1', 'faro.png', 'image', false]]);
  const file = await ask('files.get', { id: 'f1' });
  assert.deepEqual([file.header.result.size, file.header.result.type, file.body], [3, 'image/png', Buffer.from([1, 2, 3]).toString('base64')]);
});

test('what a model waits an answer for reaches the phone, and the phone answers it', async () => {
  const { rt, bridge, ask, events, window, approvals } = phonePage();
  await until(() => bridge.status && rt.phone, 'the bridge up');
  const chat = window.chatManager;
  chat._codeProjectId = 'p1';
  const waiting = chat.awaitApproval({ name: 'edit_file' }, { id: 'ap1', kind: 'code', name: 'edit_file', summary: { path: 'index.html' }, expiresAt: '2026-09-29T10:00:00.000Z' }, {});
  assert.deepEqual(events('approval.pending'), [{ id: 'ap1', projectId: 'p1', kind: 'code', name: 'edit_file', summary: { path: 'index.html' }, expiresAt: '2026-09-29T10:00:00.000Z' }]);
  assert.deepEqual((await ask('approvals.list')).header.result.approvals.map(a => a.id), ['ap1']);
  assert.deepEqual((await ask('state')).header.result.approvals.length, 1);
  assert.deepEqual((await ask('approvals.decide', { id: 'ap1', decision: 'allow' })).header.result, { decided: true });
  assert.deepEqual(await waiting, { approved: true });
  assert.deepEqual(events('approval.settled'), [{ id: 'ap1', outcome: 'allow' }]);
  assert.deepEqual([(await ask('approvals.list')).header.result.approvals.length, approvals.length], [0, 1]);
  // decided on the computer: the phone is told it is no longer waiting
  const other = chat.awaitApproval({ name: 'sandbox_exec' }, { id: 'ap2', kind: 'terminal', name: 'sandbox_exec', expiresAt: 'later' }, {});
  chat.settleApproval('ap2', { approved: false, expired: true });
  assert.deepEqual([await other, events('approval.settled').pop()], [{ approved: false, expired: true }, { id: 'ap2', outcome: 'expired' }]);
  // a reminder that rings
  rt.toast = () => {};
  rt.announce({ id: 'a1', title: 'Dentista', start_at: '2026-09-29T15:00', notes: '' });
  assert.deepEqual(events('reminder'), [{ id: 'a1', title: 'Dentista', at: '2026-09-29T15:00', notes: '' }]);
});

test('the window closed with the app going on: the service is told, and what the assistant says is written', async () => {
  const asked = [];
  const system = { entry: null };   // what the system holds of the start with the computer
  let onWindow = null;
  const shell = {
    core: { invoke: async (command, args) => { asked.push([command, args?.request ? { ...args.request } : args ? { ...args } : null]); return { hidden: false, service: true, autostart: system.entry ? 'on' : 'off', entry: system.entry }; } },
    event: { listen: async (name, run) => { if (name === 'synthorg-window') onWindow = run; return () => {}; } }
  };
  const { rt, bridge, windows, answers, spoken, events } = phonePage({ service: true, shell });
  await until(() => bridge.status && rt.phone && onWindow, 'the bridge up');
  // the shell knows what closing the window is to do, in the words of the interface
  assert.deepEqual(plain(asked.find(([command]) => command === 'background_configure')), ['background_configure', { service: true, open: 'realtime.phoneTrayOpen', quit: 'realtime.phoneTrayQuit', tooltip: 'realtime.phoneTrayTooltip', notice_title: 'realtime.phoneTrayNoticeTitle', notice: 'realtime.phoneTrayNotice' }], 'the service, and nothing of the start with the computer');
  assert.equal(asked.filter(([command]) => command === 'background_configure').length, 1, 'told once, not at every change of state');
  rt.active = true;
  rt.session = true;
  rt.stopSession = () => { rt.session = false; };
  assert.equal(rt.written(), false);

  onWindow({ payload: { open: false } });
  await until(() => windows.length === 1, 'the service told');
  assert.deepEqual([windows, bridge.hidden, rt.session, rt.written()], [[false], true, false, true], 'the section was on screen, but nobody is there to hear');
  answers.push({ transcript: 'Promemoria: dentista alle tre.', toolCalls: [] });
  rt.tell({ text: '[Promemoria arrivato]' });
  await until(() => events('assistant.message').some(m => /dentista/.test(m.text)), 'told to the phone');
  assert.deepEqual(spoken, []);

  onWindow({ payload: { open: true } });
  await until(() => windows.length === 2, 'the service told');
  assert.deepEqual([windows, bridge.hidden, rt.written()], [[false, true], false, false]);

  // started with the computer: hidden from the first moment
  const hidden = phonePage({ service: true, shell: { core: { invoke: async (command) => (command === 'background_state' ? { hidden: true } : {}) }, event: { listen: async () => () => {} } } });
  await until(() => hidden.windows.length === 1, 'the service told');
  assert.deepEqual([hidden.windows, hidden.bridge.hidden], [[false], true]);
});

test('starting with the computer is a switch of its own: it shows what the system holds, and only the user moves it', async () => {
  const asked = [];
  const system = { entry: null, blocked: false };
  const state = () => ({ hidden: false, service: false, autostart: !system.entry ? 'off' : system.blocked ? 'blocked' : 'on', entry: system.entry });
  const shell = {
    core: { invoke: async (command, args) => {
      asked.push(command);
      if (command === 'background_autostart') system.entry = args.on ? '"C:\\SynthOrg\\synthorg.exe" --background' : null;
      return state();
    } },
    event: { listen: async () => () => {} }
  };
  const { rt, bridge, window } = phonePage({ enabled: false, service: false, connected: false, shell });
  await until(() => bridge.status && bridge.shell, 'the shell read');
  rt.dialog = null;
  let html = rt.phonePage();
  assert.match(html, /class="rt-phone-autostart"  >/, 'there to be turned on with everything else off');
  assert.equal(html.includes('rt-phone-entry'), false);

  // the switches of the bridge do not touch it
  bridge.setStatus({ ...bridge.status, settings: { ...bridge.status.settings, enabled: true, service: true } });
  bridge.setStatus({ ...bridge.status, settings: { ...bridge.status.settings, enabled: false, service: false } });
  await tick(5);
  assert.equal(asked.includes('background_autostart'), false);
  assert.equal(system.entry, null);

  // the user turns it on: written, and shown as it is written
  rt.renderSettings = () => {};
  await rt.onPhoneSettings({ type: 'change', target: { checked: true, matches: (selector) => selector === '.rt-phone-autostart' } });
  assert.deepEqual([asked.filter(command => command === 'background_autostart').length, bridge.shell.autostart], [1, 'on']);
  html = rt.phonePage();
  assert.match(html, /class="rt-phone-autostart" checked >/);
  assert.match(html, /realtime\.phoneAutostartEntry \{&quot;entry&quot;:&quot;\\&quot;C:/);
  assert.match(rt.phoneNote, /realtime\.phoneAutostartOn/);

  // turned off in the system's own list: said, and left as the user left it
  system.blocked = true;
  await bridge.readShell();
  html = rt.phonePage();
  assert.match(html, /realtime\.phoneAutostartBlocked/);
  assert.match(html, /class="rt-phone-autostart" checked >/);
  assert.equal(asked.filter(command => command === 'background_autostart').length, 1);

  // the user turns it off: removed
  await rt.onPhoneSettings({ type: 'change', target: { checked: false, matches: (selector) => selector === '.rt-phone-autostart' } });
  assert.deepEqual([system.entry, bridge.shell.autostart], [null, 'off']);
  assert.match(rt.phonePage(), /class="rt-phone-autostart"  >/);
  assert.ok(window.phoneBridge);
});

test('with the bridge off the page asks nothing of the service and tells nothing', async () => {
  const { rt, bridge, sent, window } = phonePage({ enabled: false, connected: false });
  await until(() => bridge.status && rt.phone, 'the state read');
  await tick(20);
  assert.deepEqual([bridge.running, bridge.there(), rt.written()], [false, false, false]);
  await window.chatManager.persist(window.chatManager.makeMessage('assistant', 'Ciao'), 'rt');
  rt.renderControls();
  assert.deepEqual(sent, []);
});

test('the phone\'s page of the settings shows the state, the code of a pairing and the phones', async () => {
  const { rt, bridge, window } = phonePage();
  await until(() => bridge.status && rt.phone, 'the bridge up');
  rt.dialog = null;
  let html = rt.phonePage();
  assert.match(html, /realtime\.phonePhaseConnectedOne/);
  assert.match(html, /class="rt-phone-on" checked/);
  assert.match(html, /class="rt-phone-service"  >/);
  assert.match(html, /class="rt-phone-autostart"  disabled>/, 'outside the app there is no system to write to');
  assert.match(html, /realtime\.phoneAutostartUnavailable/);
  assert.match(html, /data-action="phone-pair"/);
  assert.match(html, /Pixel/);
  assert.match(html, /realtime\.phoneDeviceConnected/);
  assert.equal(html.includes('<svg'), false);
  bridge.status = { ...bridge.status, pairing: { code: 'SYNTHORG-BRIDGE:1:AAAA:BBBB:CCCC:DDDD', expiresAt: new Date(Date.now() + 90000).toISOString() } };
  html = rt.phonePage();
  assert.match(html, /<svg [^>]*viewBox/);
  assert.match(html, /realtime\.phonePairingLeft \{&quot;seconds&quot;:(89|90)\}/);
  // drawn, and written too, to be copied to a phone that cannot scan it
  assert.match(html, /<code class="rt-phone-code">SYNTHORG-BRIDGE:1:/);
  assert.match(html, /data-action="phone-pair-copy"/);
  // the service alone: off while the app is open, and said so; a phone can be paired all the same
  bridge.status = { ...bridge.status, pairing: null, phase: 'off', settings: { ...bridge.status.settings, enabled: false, service: true } };
  html = rt.phonePage();
  assert.match(html, /realtime\.phonePhaseAtClose/);
  assert.match(html, /class="rt-phone-service" checked/);
  assert.match(html, /data-action="phone-pair" >/);
  bridge.status = { ...bridge.status, settings: { ...bridge.status.settings, service: false } };
  html = rt.phonePage();
  assert.match(html, /realtime\.phonePhaseOff/);
  assert.match(html, /data-action="phone-pair" disabled/);
  bridge.status = { ...bridge.status, phase: 'ready', settings: { ...bridge.status.settings, enabled: true } };
  // run out: no code is shown
  bridge.status = { ...bridge.status, pairing: { code: 'X', expiresAt: new Date(Date.now() - 1000).toISOString() } };
  assert.equal(rt.phonePage().includes('<svg'), false);
  // the user's own router, picked and not saved yet
  bridge.status = { ...bridge.status, pairing: null };
  rt.phoneDraft = { mode: 'external' };
  html = rt.phonePage();
  assert.match(html, /class="rt-phone-host"/);
  assert.equal(html.includes('rt-phone-transit'), false);
  rt.phoneDraft = null;
  bridge.status = { ...bridge.status, embeddedAvailable: false };
  assert.match(rt.phonePage(), /realtime\.phoneEmbeddedMissing/);
  bridge.status = { ...bridge.status, locked: true };
  assert.match(rt.phonePage(), /realtime\.phoneLocked/);
  // the texts are there in both languages
  const source = read('resources/js/i18n.js');
  for (const key of new Set([...read('resources/js/realtime-phone.js').matchAll(/t\('(realtime\.[A-Za-z_]+)'/g)].map(m => m[1]))) {
    if (key.endsWith('_')) continue;
    assert.equal(source.split(`'${key}':`).length, 3, key);
  }
  for (const letter of ['L', 'O', 'P', 'X']) assert.equal(source.split(`'realtime.phoneBandwidth_${letter}':`).length, 3);
  // The section's object is filled by several files: what the bridge adds to it has names no other file uses.
  const files = fs.readdirSync(path.join(__dirname, '../resources/js')).filter(name => name.startsWith('realtime') && name.endsWith('.js'));
  const added = ['written', 'from', 'phone', ...Object.keys(rt).filter(name => /^(phone|onPhone)/.test(name))];
  assert.ok(added.length > 10);
  for (const name of added) {
    const starts = [`    ${name}(`, `    async ${name}(`, `    ${name}:`];
    const defined = files.filter(file => read('resources/js/' + file).split('\n').some(line => starts.some(start => line.startsWith(start))));
    assert.deepEqual([name, defined.length], [name, 1], `${name} is defined in ${defined.join(', ')}`);
  }
  assert.ok(window.synthQr);
});

/* ------------------------------------------------------------------ */
/* The local network's way                                              */
/* ------------------------------------------------------------------ */

test('on the same local network a paired phone opens a second channel, which carries the traffic; I2P stays aside', async t => {
  const { Lan, isPrivate } = require('../server/bridge-lan');
  assert.deepEqual(['10.0.0.5', '192.168.1.9', '172.20.3.4', '::ffff:192.168.1.9', '172.32.0.1', '8.8.8.8', '127.0.0.1', '169.254.1.1', 'fe80::1'].map(isPrivate), [true, true, true, true, false, false, false, false, false]);

  const netw = network();
  const router = { sam: null, embeddedAvailable: () => true, get running() { return Boolean(this.sam); }, async start() { this.sam = new netw.Sam(); return this.sam; }, async stop() { this.sam = null; } };
  const store = new Store(':memory:');
  // Played on the loopback: the computer's "private address" is 127.0.0.1 here.
  const lan = new Lan({ addresses: () => ['127.0.0.1'], allowed: () => true, everyMs: 100000 });
  const bridge = new Bridge({ store: () => store, router, version: '1.0.0', lan });
  t.after(async () => { await bridge.shutdown(); store.close(); });
  const seen = page(bridge);
  t.after(() => seen.close());

  await bridge.configure({ enabled: true });
  const opened = await bridge.openPairing();
  const phone = new Phone({ sam: new netw.Sam(), tries: 1 });
  await phone.pair(opened.pairing.code, { name: 'Pixel' });
  const id = phone.identity.deviceId;
  assert.equal(bridge.status().devices[0].via, 'i2p');

  // Off until the user turns it on: nothing listens, and the phone is told so.
  assert.deepEqual(bridge.status().lan, { listening: false, addresses: [] });
  await assert.rejects(phone.call('lan.offer'), error => error.code === 'lan_off');

  let allowed = 0;
  phone.onEvent = (name) => { if (name === 'lan') allowed++; };
  await bridge.configure({ lan: true });
  await until(() => bridge.status().lan.addresses.length === 1 && allowed === 1, 'listening, and the phone told');
  const { result } = await phone.call('lan.offer');
  assert.deepEqual(result.addresses, bridge.status().lan.addresses);
  assert.equal(result.addresses[0].host, '127.0.0.1');
  assert.equal(Number(store.bridge().key('lan_port')), result.addresses[0].port, 'the port is kept for the next time');

  // The second channel: the same handshake, with the keys of the pairing.
  const direct = async (staticHex, kind = 'session', psk = null) => {
    const socket = net.connect(result.addresses[0].port, result.addresses[0].host);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const privateKey = Buffer.from(staticHex, 'hex');
    const channel = await noise.initiate(socket, { kind, psk, payload: { platform: 'node' }, timeoutMs: 3000, staticKey: { privateKey, publicKey: noise.publicOf(privateKey) }, remoteStatic: Buffer.from(phone.identity.desktop.publicKey, 'hex') });
    return { socket, channel, welcome: await channel.receive() };
  };
  const local = await direct(phone.identity.staticKey);
  assert.equal(local.welcome.header.name, 'welcome');
  assert.equal(local.welcome.header.data.device.id, id);
  assert.equal(bridge.status().devices[0].via, 'lan');
  assert.equal(bridge.standby.size, 1, 'the I2P channel is kept aside');

  // What the page sends goes the local way; a request on it is answered there.
  await local.channel.send({ t: 'req', id: 7, method: 'projects.list', params: {} });
  const answer = await local.channel.receive();
  assert.deepEqual([answer.header.t, answer.header.id, answer.header.ok], ['res', 7, true]);
  // The channel kept aside still answers (its ping keeps it alive).
  assert.ok((await phone.call('ping')).result.now);

  // A stranger gets nothing, and no pairing is made on the local network.
  await assert.rejects(direct(noise.generateStatic().privateKey.toString('hex')));
  assert.equal(bridge.status().devices.length, 1);

  // The phone goes out of range without a word: the local channel is still open for the computer. The phone's
  // next request comes on the I2P channel, and the computer goes back to it at once, with what it says.
  await phone.call('projects.list');
  assert.equal(bridge.status().devices[0].via, 'i2p');
  assert.equal(bridge.standby.size, 0);
  await until(() => local.socket.destroyed || local.socket.readableEnded, 'the local channel given up');
  assert.equal((await bridge.send({ header: { t: 'evt', name: 'chat.live', data: {} } })).sent, 1);

  // The phone leaves the network: the I2P channel takes the traffic again.
  const back = await direct(phone.identity.staticKey);
  assert.equal(bridge.status().devices[0].via, 'lan');
  back.socket.destroy();
  await until(() => bridge.status().devices[0].via === 'i2p', 'back on I2P');
  assert.equal(bridge.status().devices[0].connected, true);

  // I2P falls while the phone is on the local network: the local channel stays.
  const again = await direct(phone.identity.staticKey);
  assert.equal(bridge.status().devices[0].via, 'lan');
  await bridge.halt();
  assert.deepEqual([bridge.status().devices[0].connected, bridge.status().devices[0].via], [true, 'lan']);

  // Turned off: the local channels close and nothing listens.
  await bridge.configure({ lan: false });
  await until(() => again.socket.destroyed || again.socket.readableEnded, 'the local channel closed');
  assert.deepEqual(bridge.status().lan, { listening: false, addresses: [] });
});

test('across the internet there is I2P alone, with tunnels of one hop unless asked otherwise', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const settings = store.bridge();
  // One hop out of the box; one to three, anything else is one again.
  assert.equal(settings.settings().hops, 1);
  assert.equal(settings.saveSettings({ hops: 3 }).hops, 3);
  assert.equal(settings.saveSettings({ hops: 7 }).hops, 1);
  assert.equal(settings.saveSettings({ hops: '2' }).hops, 2);
  assert.ok(!('direct' in settings.settings()), 'no setting of a way across the internet other than I2P');
  // The number reaches the session: its tunnels are built that long.
  const netw = network();
  let asked = null;
  const sam = new netw.Sam();
  const made = sam.session.bind(sam);
  sam.session = (options) => { asked = options; return made(options); };
  const router = { sam: null, embeddedAvailable: () => true, get running() { return Boolean(this.sam); }, async start() { this.sam = sam; return sam; }, async stop() { this.sam = null; } };
  const bridge = new Bridge({ store: () => store, router, version: '1.0.0' });
  t.after(() => bridge.shutdown());
  await bridge.configure({ enabled: true, hops: 2 });
  await bridge.openPairing();
  assert.equal(asked?.hops, 2);
  // No way across the internet is offered or taken: the request is unknown to the service and goes to the page.
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'bridge.js'), 'utf8');
  assert.ok(!/direct\.offer|bridge-direct|stun/i.test(source));
  assert.ok(!require('node:fs').existsSync(require('node:path').join(__dirname, '..', 'server', 'bridge-direct.js')));
});

