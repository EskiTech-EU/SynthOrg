'use strict';
/**
 * The channel between the phone and this computer, inside the I2P stream.
 *
 * I2P already hides who talks to whom and encrypts the way; this layer makes
 * sure of who is at the other end whatever router carries the stream (an
 * external router sees the stream's bytes), and keeps what is said out of
 * reach of a recording decrypted years later.
 *
 * It is the Noise protocol, pattern XK with hybrid forward secrecy:
 *
 *     <- s
 *     -> e, es, e1
 *     <- e, ee, ekem1
 *     -> s, se            (pairing: s, se, psk)
 *
 * X25519 for the Diffie-Hellman steps, ML-KEM-768 for e1/ekem1, ChaCha20-
 * Poly1305 and SHA-256. The phone starts (initiator) and knows this
 * computer's static key from the QR code; its own static key travels
 * encrypted in the third message. While pairing, the one-time secret of the
 * QR code is mixed in as the pre-shared key: only who has seen the code ends
 * the handshake.
 *
 * On the wire every handshake message and every record is a two-byte length
 * (big endian) followed by that many bytes. A record carries a piece of a
 * message: one byte (0: more pieces follow, 1: the last one) and the data.
 * A message is a four-byte length of its header, the header (JSON, UTF-8)
 * and, after it, bytes of its own (a recording, a file).
 */
const crypto = require('node:crypto');

const KINDS = { session: 1, pairing: 2 };
const NAMES = {
  session: 'Noise_XKhfs_25519+MLKEM768_ChaChaPoly_SHA256',
  pairing: 'Noise_XKhfspsk3_25519+MLKEM768_ChaChaPoly_SHA256'
};
const PROLOGUE = 'synthorg-bridge/1';
const KEY = 32;
const TAG = 16;
const KEM_PUBLIC = 1184;
const KEM_CIPHERTEXT = 1088;
const RECORD_MOST = 65535;
const PIECE = 16 * 1024;
const MESSAGE_MOST = 24 * 1024 * 1024;

const X25519_PUBLIC = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PRIVATE = Buffer.from('302e020100300506032b656e04220420', 'hex');
// SubjectPublicKeyInfo of ML-KEM-768 up to the key itself.
const KEM_SPKI = Buffer.from('308204b2300b0609608648016503040402038204a100', 'hex');

function fail(message) {
  throw Object.assign(new Error(message), { code: 'BRIDGE_CHANNEL' });
}

const sha256 = (...parts) => { const h = crypto.createHash('sha256'); parts.forEach(p => h.update(p)); return h.digest(); };
const hmac = (key, ...parts) => { const h = crypto.createHmac('sha256', key); parts.forEach(p => h.update(p)); return h.digest(); };

function hkdf(chainingKey, material, outputs) {
  const temp = hmac(chainingKey, material);
  const out = [];
  let last = Buffer.alloc(0);
  for (let i = 1; i <= outputs; i++) { last = hmac(temp, last, Buffer.from([i])); out.push(last); }
  return out;
}

function generateStatic() {
  const pair = crypto.generateKeyPairSync('x25519');
  return {
    privateKey: Buffer.from(pair.privateKey.export({ format: 'jwk' }).d, 'base64url'),
    publicKey: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url')
  };
}

function publicOf(privateKey) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([X25519_PRIVATE, privateKey]), format: 'der', type: 'pkcs8' });
  return Buffer.from(crypto.createPublicKey(key).export({ format: 'jwk' }).x, 'base64url');
}

function dh(privateKey, publicKey) {
  if (publicKey.length !== KEY) fail('Chiave pubblica non valida.');
  const shared = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({ key: Buffer.concat([X25519_PRIVATE, privateKey]), format: 'der', type: 'pkcs8' }),
    publicKey: crypto.createPublicKey({ key: Buffer.concat([X25519_PUBLIC, publicKey]), format: 'der', type: 'spki' })
  });
  // A point of small order gives zeros: a key nobody holds.
  if (shared.every(byte => byte === 0)) fail('Chiave pubblica non valida.');
  return shared;
}

function kemGenerate() {
  const pair = crypto.generateKeyPairSync('ml-kem-768');
  const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey: pair.privateKey, publicKey: spki.subarray(spki.length - KEM_PUBLIC) };
}

function kemEncapsulate(publicKey) {
  if (publicKey.length !== KEM_PUBLIC) fail('Chiave ML-KEM non valida.');
  const key = crypto.createPublicKey({ key: Buffer.concat([KEM_SPKI, publicKey]), format: 'der', type: 'spki' });
  const { sharedKey, ciphertext } = crypto.encapsulate(key);
  return { sharedKey: Buffer.from(sharedKey), ciphertext: Buffer.from(ciphertext) };
}

function kemDecapsulate(privateKey, ciphertext) {
  if (ciphertext.length !== KEM_CIPHERTEXT) fail('Testo cifrato ML-KEM non valido.');
  return Buffer.from(crypto.decapsulate(privateKey, ciphertext));
}

class Cipher {
  constructor(key = null) { this.key = key; this.nonce = 0n; }

  iv() {
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64LE(this.nonce, 4);
    return iv;
  }

  encrypt(ad, plaintext) {
    if (!this.key) return plaintext;
    const cipher = crypto.createCipheriv('chacha20-poly1305', this.key, this.iv(), { authTagLength: TAG });
    cipher.setAAD(ad, { plaintextLength: plaintext.length });
    const out = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    this.nonce += 1n;
    return out;
  }

  decrypt(ad, ciphertext) {
    if (!this.key) return ciphertext;
    if (ciphertext.length < TAG) fail('Messaggio troppo corto.');
    const decipher = crypto.createDecipheriv('chacha20-poly1305', this.key, this.iv(), { authTagLength: TAG });
    decipher.setAAD(ad, { plaintextLength: ciphertext.length - TAG });
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG));
    let out;
    try {
      out = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - TAG)), decipher.final()]);
    } catch {
      fail('Messaggio non autentico.');
    }
    this.nonce += 1n;
    return out;
  }
}

class Symmetric {
  constructor(name) {
    const bytes = Buffer.from(name, 'ascii');
    this.h = bytes.length <= 32 ? Buffer.concat([bytes, Buffer.alloc(32 - bytes.length)]) : sha256(bytes);
    this.ck = this.h;
    this.cipher = new Cipher();
  }
  mixHash(data) { this.h = sha256(this.h, data); }
  mixKey(material) {
    const [ck, key] = hkdf(this.ck, material, 2);
    this.ck = ck;
    this.cipher = new Cipher(key);
  }
  mixKeyAndHash(material) {
    const [ck, hash, key] = hkdf(this.ck, material, 3);
    this.ck = ck;
    this.mixHash(hash);
    this.cipher = new Cipher(key);
  }
  encryptAndHash(plaintext) {
    const out = this.cipher.encrypt(this.h, plaintext);
    this.mixHash(out);
    return out;
  }
  decryptAndHash(ciphertext) {
    const out = this.cipher.decrypt(this.h, ciphertext);
    this.mixHash(ciphertext);
    return out;
  }
  split() {
    const [first, second] = hkdf(this.ck, Buffer.alloc(0), 2);
    return [new Cipher(first), new Cipher(second)];
  }
}

/**
 * One side of a handshake. `kind` is 'session' or 'pairing' (then `psk` is
 * the one-time secret). The initiator gives the responder's static key in
 * `remoteStatic`; the responder learns the initiator's in the third message.
 */
class Handshake {
  constructor({ initiator, kind, staticKey, remoteStatic = null, psk = null }) {
    if (!NAMES[kind]) fail('Tipo di collegamento sconosciuto.');
    if (kind === 'pairing' && (!psk || psk.length !== KEY)) fail('Segreto di accoppiamento non valido.');
    this.initiator = initiator;
    this.kind = kind;
    this.psk = kind === 'pairing' ? psk : null;
    this.s = staticKey;
    this.rs = remoteStatic;
    this.state = new Symmetric(NAMES[kind]);
    this.state.mixHash(Buffer.concat([Buffer.from(PROLOGUE, 'ascii'), Buffer.from([KINDS[kind]])]));
    this.state.mixHash(initiator ? remoteStatic : staticKey.publicKey);
    this.step = 0;
  }

  ephemeral() {
    this.e = generateStatic();
    this.state.mixHash(this.e.publicKey);
    if (this.psk) this.state.mixKey(this.e.publicKey);
    return this.e.publicKey;
  }

  remoteEphemeral(key) {
    this.re = Buffer.from(key);
    this.state.mixHash(this.re);
    if (this.psk) this.state.mixKey(this.re);
  }

  /** The next message this side sends, carrying `payload`. */
  write(payload = Buffer.alloc(0)) {
    const step = this.step++;
    const parts = [];
    if (this.initiator && step === 0) {
      parts.push(this.ephemeral());
      this.state.mixKey(dh(this.e.privateKey, this.rs));
      this.e1 = kemGenerate();
      parts.push(this.state.encryptAndHash(this.e1.publicKey));
    } else if (!this.initiator && step === 1) {
      parts.push(this.ephemeral());
      this.state.mixKey(dh(this.e.privateKey, this.re));
      const { sharedKey, ciphertext } = kemEncapsulate(this.re1);
      parts.push(this.state.encryptAndHash(ciphertext));
      this.state.mixKey(sharedKey);
    } else if (this.initiator && step === 2) {
      parts.push(this.state.encryptAndHash(this.s.publicKey));
      this.state.mixKey(dh(this.s.privateKey, this.re));
      if (this.psk) this.state.mixKeyAndHash(this.psk);
    } else fail('Passo del collegamento fuori ordine.');
    parts.push(this.state.encryptAndHash(payload));
    return Buffer.concat(parts);
  }

  /** The message the other side sent: its payload. */
  read(message) {
    const step = this.step++;
    let at = 0;
    const take = (length) => {
      if (at + length > message.length) fail('Messaggio di collegamento troppo corto.');
      const piece = message.subarray(at, at + length);
      at += length;
      return piece;
    };
    if (!this.initiator && step === 0) {
      this.remoteEphemeral(take(KEY));
      this.state.mixKey(dh(this.s.privateKey, this.re));
      this.re1 = this.state.decryptAndHash(take(KEM_PUBLIC + TAG));
    } else if (this.initiator && step === 1) {
      this.remoteEphemeral(take(KEY));
      this.state.mixKey(dh(this.e.privateKey, this.re));
      const ciphertext = this.state.decryptAndHash(take(KEM_CIPHERTEXT + TAG));
      this.state.mixKey(kemDecapsulate(this.e1.privateKey, ciphertext));
    } else if (!this.initiator && step === 2) {
      this.rs = this.state.decryptAndHash(take(KEY + TAG));
      this.state.mixKey(dh(this.e.privateKey, this.rs));
      if (this.psk) this.state.mixKeyAndHash(this.psk);
    } else fail('Passo del collegamento fuori ordine.');
    return this.state.decryptAndHash(message.subarray(at));
  }

  get done() { return this.step === 3; }

  /** The two ciphers of the channel: what this side sends with, what it reads with. */
  ciphers() {
    if (!this.done) fail('Collegamento non concluso.');
    const [first, second] = this.state.split();
    return this.initiator ? { send: first, receive: second } : { send: second, receive: first };
  }

  /** What both sides have seen: the same at both ends of one handshake, and only there. */
  get hash() { return this.state.h; }
}

/** Reads length-prefixed blocks off a stream, one at a time, in order. */
class Blocks {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiting = [];
    this.ended = null;
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.pump(); });
    const end = (error) => {
      if (this.ended) return;
      this.ended = error || Object.assign(new Error('Collegamento chiuso.'), { code: 'BRIDGE_CLOSED' });
      this.pump();
    };
    socket.on('error', end);
    socket.on('close', () => end());
    socket.on('end', () => end());
    socket.resume();
  }

  pump() {
    while (this.waiting.length) {
      if (this.buffer.length >= 2) {
        const length = this.buffer.readUInt16BE(0);
        if (this.buffer.length >= 2 + length) {
          const block = this.buffer.subarray(2, 2 + length);
          this.buffer = this.buffer.subarray(2 + length);
          this.waiting.shift().resolve(Buffer.from(block));
          continue;
        }
      }
      if (this.ended) { this.waiting.shift().reject(this.ended); continue; }
      return;
    }
  }

  read() {
    return new Promise((resolve, reject) => { this.waiting.push({ resolve, reject }); this.pump(); });
  }

  write(block) {
    if (block.length > RECORD_MOST) fail('Blocco troppo grande.');
    const head = Buffer.alloc(2);
    head.writeUInt16BE(block.length);
    return new Promise((resolve, reject) => {
      if (this.ended || this.socket.destroyed) return reject(this.ended || new Error('Collegamento chiuso.'));
      this.socket.write(Buffer.concat([head, block]), error => (error ? reject(error) : resolve()));
    });
  }
}

/** The channel once the handshake is done: whole messages in, whole messages out. */
class Channel {
  constructor(blocks, ciphers, { remoteStatic, hash }) {
    this.blocks = blocks;
    this.ciphers = ciphers;
    this.remoteStatic = remoteStatic;
    this.hash = hash;
    this.sending = Promise.resolve();
  }

  /** `header` is an object, `body` bytes that go with it. Messages leave in the order they were sent. */
  send(header, body = null) {
    const head = Buffer.from(JSON.stringify(header), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(head.length);
    const message = Buffer.concat([length, head, body ? Buffer.from(body) : Buffer.alloc(0)]);
    if (message.length > MESSAGE_MOST) fail('Messaggio troppo grande.');
    const run = async () => {
      for (let at = 0; at < message.length || at === 0; at += PIECE) {
        const piece = message.subarray(at, at + PIECE);
        const last = at + PIECE >= message.length;
        await this.blocks.write(this.ciphers.send.encrypt(Buffer.alloc(0), Buffer.concat([Buffer.from([last ? 1 : 0]), piece])));
        if (last) break;
      }
    };
    this.sending = this.sending.then(run, run);
    return this.sending;
  }

  async receive() {
    const pieces = [];
    let size = 0;
    for (;;) {
      const record = this.ciphers.receive.decrypt(Buffer.alloc(0), await this.blocks.read());
      if (!record.length) fail('Pezzo vuoto.');
      pieces.push(record.subarray(1));
      size += record.length - 1;
      if (size > MESSAGE_MOST) fail('Messaggio troppo grande.');
      if (record[0] === 1) break;
      if (record[0] !== 0) fail('Pezzo non valido.');
    }
    const message = Buffer.concat(pieces);
    if (message.length < 4) fail('Messaggio troppo corto.');
    const length = message.readUInt32BE(0);
    if (4 + length > message.length) fail('Intestazione troppo lunga.');
    let header;
    try { header = JSON.parse(message.subarray(4, 4 + length).toString('utf8')); } catch { fail('Intestazione non valida.'); }
    if (!header || typeof header !== 'object' || Array.isArray(header)) fail('Intestazione non valida.');
    return { header, body: message.subarray(4 + length) };
  }

  close() { try { this.blocks.socket.destroy(); } catch {} }
}

/**
 * This computer's side: answers a handshake on a stream just accepted.
 * `pairingSecret()` gives the one-time secret when a pairing is open (or
 * null); `allowed(publicKey)` says whether a device may open a session.
 * Resolves with { channel, kind, payload }: the payload is what the phone
 * sent in its last message (who it is).
 */
async function respond(socket, { staticKey, pairingSecret, allowed, timeoutMs = 120000 }) {
  const blocks = new Blocks(socket);
  const timer = setTimeout(() => socket.destroy(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    const first = await blocks.read();
    if (first.length !== 1) fail('Apertura non valida.');
    const kind = first[0] === KINDS.session ? 'session' : first[0] === KINDS.pairing ? 'pairing' : null;
    if (!kind) fail('Tipo di collegamento sconosciuto.');
    const psk = kind === 'pairing' ? pairingSecret() : null;
    if (kind === 'pairing' && !psk) fail('Nessun accoppiamento aperto.');
    const handshake = new Handshake({ initiator: false, kind, staticKey, psk });
    handshake.read(await blocks.read());
    await blocks.write(handshake.write());
    const payload = handshake.read(await blocks.read());
    if (kind === 'session' && !allowed(handshake.rs)) fail('Dispositivo non accoppiato.');
    let said = {};
    if (payload.length) { try { said = JSON.parse(payload.toString('utf8')); } catch { fail('Presentazione non valida.'); } }
    return { kind, payload: said, channel: new Channel(blocks, handshake.ciphers(), { remoteStatic: Buffer.from(handshake.rs), hash: handshake.hash }) };
  } finally {
    clearTimeout(timer);
  }
}

/** The phone's side, as the app on the phone does it: used by the tests and by the reference client. */
async function initiate(socket, { kind, staticKey, remoteStatic, psk = null, payload = {}, timeoutMs = 120000 }) {
  const blocks = new Blocks(socket);
  const timer = setTimeout(() => socket.destroy(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    const handshake = new Handshake({ initiator: true, kind, staticKey, remoteStatic, psk });
    await blocks.write(Buffer.from([KINDS[kind]]));
    await blocks.write(handshake.write());
    handshake.read(await blocks.read());
    await blocks.write(handshake.write(Buffer.from(JSON.stringify(payload), 'utf8')));
    return new Channel(blocks, handshake.ciphers(), { remoteStatic: Buffer.from(remoteStatic), hash: handshake.hash });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { Handshake, Channel, Blocks, respond, initiate, generateStatic, publicOf, NAMES, PROLOGUE, KINDS, MESSAGE_MOST };
