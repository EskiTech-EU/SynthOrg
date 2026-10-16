'use strict';
/**
 * The desktop's side of the bridge for the Rust tests, without I2P: the real
 * channel code of the desktop (computer/server/bridge-noise.js) answering on
 * a plain TCP socket, with a small version of what computer/server/bridge.js
 * does around it (pairing once, devices known by key, welcome, ping).
 *
 *   node node-peer.js [--keepalive ms]
 *
 * Prints one JSON line: { port, code, desktopPublic }. Exits when stdin ends,
 * so the test that started it takes it down with it.
 *
 * Methods beyond ping, for the tests:
 *   echo    -> { params, bodyLength } and the body back
 *   fail    -> ok:false, code "test_fail"
 *   emit    -> event "test.event" { n } with a 3-byte body, then {}
 *   pings   -> { count } of pings received on all connections
 *   drop    -> {} then the connection is closed
 *   via     -> { via } the way the request came: "tcp" (the network)
 */
const net = require('node:net');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const server = path.join(__dirname, '..', '..', '..', 'computer', 'server');
const { respond, generateStatic } = require(path.join(server, 'bridge-noise.js'));
const { base32 } = require(path.join(server, 'bridge-sam.js'));

const args = process.argv.slice(2);
const at = args.indexOf('--keepalive');
const keepaliveMs = at !== -1 ? Number(args[at + 1]) : 45000;
const channels = new Set();

const desktop = generateStatic();
let secret = randomBytes(32);
let failures = 0;
const devices = new Map();   // public key hex -> { id, name, platform }
let pings = 0;

const code32 = (bytes) => base32(bytes).toUpperCase();
// Any 35 bytes make an address of the right shape: the test network ignores it.
const code = ['SYNTHORG-BRIDGE', 1, code32(randomBytes(35)), code32(desktop.publicKey), code32(secret), code32(randomBytes(32))].join(':');

async function greet(socket) {
  let opened;
  try {
    opened = await respond(socket, {
      staticKey: desktop,
      pairingSecret: () => secret,
      allowed: key => devices.has(key.toString('hex'))
    });
  } catch (error) {
    socket.destroy();
    if (secret && error.code === 'BRIDGE_CHANNEL' && ++failures >= 5) secret = null;
    return;
  }
  const key = opened.channel.remoteStatic.toString('hex');
  let device = devices.get(key);
  if (opened.kind === 'pairing') {
    device = { id: randomUUID(), name: opened.payload.name, platform: opened.payload.platform };
    devices.set(key, device);
    secret = null;
  }
  const channel = opened.channel;
  const via = 'tcp';
  channels.add(channel);
  channel.send({ t: 'evt', name: 'welcome', data: {
    protocol: 1, paired: opened.kind === 'pairing', device: { id: device.id, name: device.name },
    desktop: { name: 'node-peer', version: 'test', platform: device.platform }, page: true, keepaliveMs
  } }).catch(() => {});
  try {
    for (;;) {
      const { header, body } = await channel.receive();
      if (header.t !== 'req') continue;
      const answer = (result, bytes = null) => channel.send({ t: 'res', id: header.id, ok: true, result }, bytes);
      switch (header.method) {
        case 'ping': pings++; await answer({ now: new Date().toISOString(), page: true }); break;
        case 'echo': await answer({ params: header.params, bodyLength: body.length }, body.length ? body : null); break;
        case 'fail': await channel.send({ t: 'res', id: header.id, ok: false, error: { code: 'test_fail', message: 'Failed on purpose.' } }); break;
        case 'emit':
          await channel.send({ t: 'evt', name: 'test.event', data: { n: header.params.n } }, Buffer.from([1, 2, 3]));
          await answer({});
          break;
        case 'pings': await answer({ count: pings }); break;
        case 'hello': await answer({ platform: device.platform, name: device.name }); break;
        case 'drop': await answer({}); setTimeout(() => channel.close(), 50); break;
        case 'via': await answer({ via }); break;
        default: await channel.send({ t: 'res', id: header.id, ok: false, error: { code: 'unknown_method', message: 'No such request.' } });
      }
    }
  } catch {
    channel.close();
  }
}

const listener = net.createServer(socket => { greet(socket); });
listener.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: listener.address().port, code, desktopPublic: desktop.publicKey.toString('hex') }) + '\n');
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.stdin.resume();
