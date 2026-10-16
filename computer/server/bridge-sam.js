'use strict';
/**
 * What is asked of the I2P router, through its SAM interface (version 3):
 * a destination of our own, a session on it, and the streams that reach it.
 *
 * The router may be the one the app starts (bridge-router.js) or one the
 * user already runs: both are spoken to in the same way, over a loopback
 * socket. A session lives as long as its first socket stays open; every
 * stream accepted or opened takes a socket of its own, which after the
 * router's answer carries the stream's bytes and nothing else.
 */
const net = require('node:net');
const zlib = require('node:zlib');
const { createHash, randomBytes } = require('node:crypto');

const SIGNATURE_ED25519 = 7;
const SIGNATURE_BLINDED = 11;
// Encrypted with ML-KEM-768 + X25519 where the other router knows it, with X25519 alone otherwise.
const ENCRYPTION = ['6,4', '4'];

function fail(message, code = 'BRIDGE_ROUTER') {
  throw Object.assign(new Error(message), { code });
}

/** I2P writes base64 with - and ~ in place of + and /. */
const toI2p64 = (bytes) => Buffer.from(bytes).toString('base64').split('+').join('-').split('/').join('~');
const fromI2p64 = (text) => Buffer.from(String(text).split('-').join('+').split('~').join('/'), 'base64');

function base32(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/** The public destination inside a private one: what is given out. */
function publicDestination(privateKey) {
  const bytes = fromI2p64(privateKey);
  if (bytes.length < 387) fail('Destinazione non valida.');
  const certificate = bytes.readUInt16BE(385);
  return toI2p64(bytes.subarray(0, 387 + certificate));
}

/** The address of a destination whose leaseset anyone may read. */
function plainAddress(destination) {
  return base32(createHash('sha256').update(fromI2p64(destination)).digest()) + '.b32.i2p';
}

/**
 * The address of a destination whose leaseset is encrypted, each reader with
 * a key of its own: it carries the signing key, from which the router works
 * out where the leaseset of the day is kept.
 */
function hiddenAddress(destination) {
  const bytes = fromI2p64(destination);
  if (bytes.length < 387 || bytes.readUInt16BE(387) !== SIGNATURE_ED25519) fail('Destinazione non adatta a un indirizzo nascosto.');
  const key = bytes.subarray(352, 384);
  const data = Buffer.concat([Buffer.from([0x04, SIGNATURE_ED25519, SIGNATURE_BLINDED]), key]);
  const sum = zlib.crc32(key);
  data[0] ^= sum & 255;
  data[1] ^= (sum >>> 8) & 255;
  data[2] ^= (sum >>> 16) & 255;
  return base32(data) + '.b32.i2p';
}

/** A reply of the router: its words and its KEY=value pairs. */
function parseReply(line) {
  const words = [];
  const values = {};
  const pattern = /([A-Za-z0-9_.]+)=("(?:[^"\\]|\\.)*"|\S*)|(\S+)/g;
  let match;
  while ((match = pattern.exec(line))) {
    if (match[3] !== undefined) words.push(match[3]);
    else values[match[1]] = match[2].startsWith('"') ? match[2].slice(1, -1).replace(/\\(.)/g, '$1') : match[2];
  }
  return { words, values, line };
}

/** A socket that is read a line at a time until it is handed over as a stream. */
function openLines({ dial, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const ready = (socket) => {
      clearTimeout(timer);
      let buffer = Buffer.alloc(0);
      let released = false;
      let closed = null;
      const waiting = [];
      const pump = () => {
        while (waiting.length && !released) {
          const at = buffer.indexOf(10);
          if (at >= 0) {
            const line = buffer.subarray(0, at).toString('utf8').replace(/\r$/, '');
            buffer = buffer.subarray(at + 1);
            // The router asks whether we are still there, on any socket, at any time.
            if (/^PING\b/.test(line)) { socket.write('PONG' + line.slice(4) + '\n'); continue; }
            waiting.shift().resolve(line);
            continue;
          }
          if (closed) { waiting.shift().reject(closed); continue; }
          return;
        }
      };
      const onData = chunk => { buffer = Buffer.concat([buffer, chunk]); pump(); };
      const onEnd = (error) => {
        closed = closed || Object.assign(error instanceof Error ? error : new Error('Il router I2P ha chiuso il collegamento.'), { code: 'BRIDGE_ROUTER' });
        pump();
      };
      socket.on('data', onData);
      socket.on('error', onEnd);
      socket.on('close', onEnd);
      resolve({
        socket,
        send(text) { socket.write(text + '\n'); },
        line(limitMs = 0) {
          return new Promise((res, rej) => {
            const entry = { resolve: res, reject: rej };
            if (limitMs) {
              const limit = setTimeout(() => {
                const index = waiting.indexOf(entry);
                if (index !== -1) waiting.splice(index, 1);
                rej(Object.assign(new Error('Il router I2P non risponde.'), { code: 'BRIDGE_ROUTER' }));
              }, limitMs);
              if (limit.unref) limit.unref();
              entry.resolve = value => { clearTimeout(limit); res(value); };
              entry.reject = error => { clearTimeout(limit); rej(error); };
            }
            waiting.push(entry);
            pump();
          });
        },
        /** From here on the socket is the stream: what was read past the last line goes with it. */
        release() {
          released = true;
          socket.off('data', onData);
          socket.off('error', onEnd);
          socket.off('close', onEnd);
          // Held until whoever takes the stream reads it; an error before then is theirs to find.
          socket.pause();
          socket.on('error', () => {});
          if (buffer.length) socket.unshift(buffer);
          buffer = Buffer.alloc(0);
          return socket;
        }
      });
    };
    Promise.resolve().then(dial).then(socket => {
      // A process answers as soon as it is started; a network socket when it is connected.
      if (socket.connecting !== true) { ready(socket); return; }
      timer = setTimeout(() => socket.destroy(Object.assign(new Error('Il router I2P non risponde.'), { code: 'BRIDGE_ROUTER' })), timeoutMs);
      if (timer.unref) timer.unref();
      socket.once('error', error => { clearTimeout(timer); reject(Object.assign(error, { code: 'BRIDGE_ROUTER' })); });
      socket.once('connect', () => ready(socket));
    }, error => reject(Object.assign(error, { code: 'BRIDGE_ROUTER' })));
  });
}

class Sam {
  /** `dial` gives a connection to the router's SAM interface; without it, the one at `host` and `port`. */
  constructor({ host = '127.0.0.1', port, user = '', password = '', timeoutMs = 8000, dial = null } = {}) {
    this.host = host;
    this.port = Number(port);
    this.dial = dial || (() => { const socket = net.connect({ host: this.host, port: this.port }); socket.setNoDelay(true); return socket; });
    this.user = user;
    this.password = password;
    this.timeoutMs = timeoutMs;
  }

  async open() {
    const lines = await openLines({ dial: this.dial, timeoutMs: this.timeoutMs });
    try {
      const login = this.user ? ` USER="${this.user.replace(/["\\]/g, '\\$&')}" PASSWORD="${this.password.replace(/["\\]/g, '\\$&')}"` : '';
      lines.send(`HELLO VERSION MIN=3.1 MAX=3.3${login}`);
      const reply = parseReply(await lines.line(this.timeoutMs));
      if (reply.values.RESULT !== 'OK') fail(reply.values.RESULT === 'I2P_ERROR' && /auth/i.test(reply.values.MESSAGE || '') ? 'Il router I2P chiede nome utente e password.' : `Il router I2P ha rifiutato il collegamento: ${reply.values.MESSAGE || reply.values.RESULT || reply.line}`);
      lines.version = reply.values.VERSION || '3.1';
      return lines;
    } catch (error) {
      lines.socket.destroy();
      throw error;
    }
  }

  /** Whether a router answers there. */
  async reachable() {
    try { const lines = await this.open(); lines.socket.destroy(); return true; } catch { return false; }
  }

  /** A new destination: its private key, which holds the public one. */
  async generate() {
    const lines = await this.open();
    try {
      lines.send(`DEST GENERATE SIGNATURE_TYPE=${SIGNATURE_ED25519}`);
      const reply = parseReply(await lines.line(this.timeoutMs));
      if (!reply.values.PRIV) fail(`Il router I2P non ha creato la destinazione: ${reply.line}`);
      return reply.values.PRIV;
    } finally {
      lines.socket.destroy();
    }
  }

  /**
   * A session on `privateKey`. `readers` are the keys allowed to read its
   * leaseset ([{ name, publicKey }]): with them the address is hidden from
   * everyone else. `readerKey` is the other side of it: the key this session
   * reads hidden leasesets with. Resolves when the tunnels are built, which
   * on a router just started takes most of a minute.
   */
  async session({ privateKey, readers = [], readerKey = null, tunnels = 3, hops = 1, buildTimeoutMs = 180000, onClose = null }) {
    const id = 'synthorg-' + randomBytes(6).toString('hex');
    let lastError = null;
    for (const encryption of ENCRYPTION) {
      const lines = await this.open();
      const options = [
        `inbound.length=${hops}`, `outbound.length=${hops}`,
        `inbound.quantity=${tunnels}`, `outbound.quantity=${tunnels}`,
        `i2cp.leaseSetEncType=${encryption}`
      ];
      if (readers.length) {
        options.push('i2cp.leaseSetType=5', 'i2cp.leaseSetAuthType=1');
        readers.forEach((reader, index) => options.push(`i2cp.leaseSetClient.dh.${index}=${String(reader.name).replace(/[^A-Za-z0-9_-]/g, '') || 'device'}:${toI2p64(reader.publicKey)}`));
      }
      if (readerKey) options.push(`i2cp.leaseSetPrivKey=${toI2p64(readerKey)}`);
      lines.send(`SESSION CREATE STYLE=STREAM ID=${id} DESTINATION=${privateKey} SIGNATURE_TYPE=${SIGNATURE_ED25519} ${options.join(' ')}`);
      let reply;
      try {
        reply = parseReply(await lines.line(buildTimeoutMs));
      } catch (error) {
        lines.socket.destroy();
        throw error;
      }
      if (reply.values.RESULT === 'OK') {
        const destination = publicDestination(reply.values.DESTINATION || privateKey);
        const session = new Session(this, { id, lines, destination, hidden: readers.length > 0, encryption });
        lines.socket.on('close', () => { session.closed = true; onClose?.(); });
        // Whatever the router says on this socket from now on is a ping or the end.
        session.idle();
        return session;
      }
      lines.socket.destroy();
      lastError = reply.values.MESSAGE || reply.values.RESULT || reply.line;
    }
    fail(`Il router I2P non ha aperto la sessione: ${lastError}`);
  }
}

class Session {
  constructor(sam, { id, lines, destination, hidden, encryption }) {
    this.sam = sam;
    this.id = id;
    this.lines = lines;
    this.destination = destination;
    this.hidden = hidden;
    this.encryption = encryption;
    this.address = hidden ? hiddenAddress(destination) : plainAddress(destination);
    this.closed = false;
  }

  idle() {
    const next = () => this.lines.line().then(next, () => {});
    next();
  }

  /** The next stream that reaches the destination: { socket, from } (the caller's destination). */
  async accept() {
    const lines = await this.sam.open();
    try {
      lines.send(`STREAM ACCEPT ID=${this.id} SILENT=false`);
      const reply = parseReply(await lines.line(this.sam.timeoutMs));
      if (reply.values.RESULT !== 'OK') fail(`Il router I2P non accetta collegamenti: ${reply.values.MESSAGE || reply.values.RESULT || reply.line}`);
      // Nothing more until somebody calls: then a line with who it is, and the stream.
      const from = (await lines.line()).split(' ')[0];
      return { socket: lines.release(), from };
    } catch (error) {
      lines.socket.destroy();
      throw error;
    }
  }

  /** A stream to somebody else's destination or address: what the phone does. */
  async connect(target, { timeoutMs = 90000 } = {}) {
    const lines = await this.sam.open();
    try {
      lines.send(`STREAM CONNECT ID=${this.id} DESTINATION=${target} SILENT=false`);
      const reply = parseReply(await lines.line(timeoutMs));
      if (reply.values.RESULT !== 'OK') fail(`Collegamento non riuscito: ${reply.values.MESSAGE || reply.values.RESULT || reply.line}`, 'BRIDGE_UNREACHABLE');
      return lines.release();
    } catch (error) {
      lines.socket.destroy();
      throw error;
    }
  }

  close() {
    this.closed = true;
    try { this.lines.socket.destroy(); } catch {}
  }
}

module.exports = { Sam, Session, toI2p64, fromI2p64, base32, publicDestination, plainAddress, hiddenAddress, parseReply };
