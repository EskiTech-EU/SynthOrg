'use strict';

const { syncInvoke } = require('./_sync_bridge');

// ── Helpers ─────────────────────────────────────────────────────────────

const _webcrypto = globalThis.crypto;
const _subtle = _webcrypto && _webcrypto.subtle;

function _hexEncode(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function _base64Encode(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function _encodeOutput(buf, encoding) {
  if (!encoding || encoding === 'buffer') return new Uint8Array(buf);
  if (encoding === 'hex') return _hexEncode(buf);
  if (encoding === 'base64') return _base64Encode(buf);
  if (encoding === 'latin1' || encoding === 'binary') {
    return Array.from(new Uint8Array(buf)).map(b => String.fromCharCode(b)).join('');
  }
  return new TextDecoder().decode(buf);
}

function _toUint8Array(data, inputEncoding) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') {
    if (inputEncoding === 'hex') {
      const bytes = new Uint8Array(data.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(data.substr(i * 2, 2), 16);
      return bytes;
    }
    if (inputEncoding === 'base64') {
      const bin = atob(data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    return new TextEncoder().encode(data);
  }
  throw new TypeError('data must be string, Buffer, or Uint8Array');
}

const _ALGO_MAP = {
  md5: 'MD5',
  sha1: 'SHA-1',
  'sha-1': 'SHA-1',
  sha256: 'SHA-256',
  'sha-256': 'SHA-256',
  sha384: 'SHA-384',
  'sha-384': 'SHA-384',
  sha512: 'SHA-512',
  'sha-512': 'SHA-512',
};

function _resolveAlgo(name) {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const mapped = _ALGO_MAP[key] || _ALGO_MAP[name.toLowerCase()];
  if (!mapped) throw new Error(`Unsupported hash algorithm: ${name}`);
  return mapped;
}

// ── Hash ────────────────────────────────────────────────────────────────

class Hash {
  constructor(algorithm) {
    this._algorithm = _resolveAlgo(algorithm);
    this._chunks = [];
    this._finalized = false;
  }

  update(data, inputEncoding) {
    if (this._finalized) throw new Error('Digest already called');
    this._chunks.push(_toUint8Array(data, inputEncoding));
    return this;
  }

  digest(encoding) {
    if (this._finalized) throw new Error('Digest already called');
    this._finalized = true;

    if (this._algorithm === 'MD5') {
      return this._digestMd5(encoding);
    }

    const result = syncInvoke('crypto_hash', {
      algorithm: this._algorithm,
      data: _base64Encode(this._mergeChunks()),
    });
    const decoded = Uint8Array.from(atob(result.digest), c => c.charCodeAt(0));
    return _encodeOutput(decoded.buffer, encoding);
  }

  _mergeChunks() {
    if (this._chunks.length === 1) return this._chunks[0];
    let totalLen = 0;
    for (const c of this._chunks) totalLen += c.length;
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of this._chunks) { merged.set(c, offset); offset += c.length; }
    return merged;
  }

  _digestMd5(encoding) {
    const result = syncInvoke('crypto_hash', {
      algorithm: 'MD5',
      data: _base64Encode(this._mergeChunks()),
    });
    const decoded = Uint8Array.from(atob(result.digest), c => c.charCodeAt(0));
    return _encodeOutput(decoded.buffer, encoding);
  }

  copy() {
    const h = new Hash(this._algorithm);
    h._chunks = this._chunks.slice();
    return h;
  }
}

// ── Hmac ────────────────────────────────────────────────────────────────

class Hmac {
  constructor(algorithm, key) {
    this._algorithm = _resolveAlgo(algorithm);
    this._key = _toUint8Array(key);
    this._chunks = [];
    this._finalized = false;
  }

  update(data, inputEncoding) {
    if (this._finalized) throw new Error('Digest already called');
    this._chunks.push(_toUint8Array(data, inputEncoding));
    return this;
  }

  digest(encoding) {
    if (this._finalized) throw new Error('Digest already called');
    this._finalized = true;

    let totalLen = 0;
    for (const c of this._chunks) totalLen += c.length;
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of this._chunks) { merged.set(c, offset); offset += c.length; }

    const result = syncInvoke('crypto_hmac', {
      algorithm: this._algorithm,
      key: _base64Encode(this._key),
      data: _base64Encode(merged),
    });
    const decoded = Uint8Array.from(atob(result.digest), c => c.charCodeAt(0));
    return _encodeOutput(decoded.buffer, encoding);
  }
}

// ── Cipher / Decipher (AES-CBC, AES-CTR, AES-GCM) ──────────────────────

class Cipheriv {
  constructor(algorithm, key, iv) {
    this._algo = algorithm.toLowerCase();
    this._key = _toUint8Array(key);
    this._iv = _toUint8Array(iv);
    this._chunks = [];
    this._finalized = false;
  }

  update(data, inputEncoding, outputEncoding) {
    this._chunks.push(_toUint8Array(data, inputEncoding));
    return outputEncoding ? '' : (typeof Buffer !== 'undefined' ? Buffer.alloc(0) : new Uint8Array(0));
  }

  final(outputEncoding) {
    this._finalized = true;
    let totalLen = 0;
    for (const c of this._chunks) totalLen += c.length;
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of this._chunks) { merged.set(c, offset); offset += c.length; }

    const result = syncInvoke('crypto_cipher', {
      algorithm: this._algo,
      key: _base64Encode(this._key),
      iv: _base64Encode(this._iv),
      data: _base64Encode(merged),
      encrypt: true,
    });

    const decoded = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
    return _encodeOutput(decoded.buffer, outputEncoding);
  }

  setAutoPadding() { return this; }
  getAuthTag() { return new Uint8Array(16); }
  setAAD() { return this; }
}

class Decipheriv {
  constructor(algorithm, key, iv) {
    this._algo = algorithm.toLowerCase();
    this._key = _toUint8Array(key);
    this._iv = _toUint8Array(iv);
    this._chunks = [];
    this._finalized = false;
  }

  update(data, inputEncoding, outputEncoding) {
    this._chunks.push(_toUint8Array(data, inputEncoding));
    return outputEncoding ? '' : (typeof Buffer !== 'undefined' ? Buffer.alloc(0) : new Uint8Array(0));
  }

  final(outputEncoding) {
    this._finalized = true;
    let totalLen = 0;
    for (const c of this._chunks) totalLen += c.length;
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of this._chunks) { merged.set(c, offset); offset += c.length; }

    const result = syncInvoke('crypto_cipher', {
      algorithm: this._algo,
      key: _base64Encode(this._key),
      iv: _base64Encode(this._iv),
      data: _base64Encode(merged),
      encrypt: false,
    });

    const decoded = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
    return _encodeOutput(decoded.buffer, outputEncoding);
  }

  setAutoPadding() { return this; }
  setAuthTag() { return this; }
  setAAD() { return this; }
}

// ── pbkdf2 ──────────────────────────────────────────────────────────────

function pbkdf2(password, salt, iterations, keylen, digest, callback) {
  if (typeof digest === 'function') { callback = digest; digest = 'sha1'; }
  try {
    const result = pbkdf2Sync(password, salt, iterations, keylen, digest);
    process.nextTick(() => callback(null, result));
  } catch (err) {
    process.nextTick(() => callback(err));
  }
}

function pbkdf2Sync(password, salt, iterations, keylen, digest) {
  digest = digest || 'sha1';
  const result = syncInvoke('crypto_pbkdf2', {
    password: _base64Encode(_toUint8Array(password)),
    salt: _base64Encode(_toUint8Array(salt)),
    iterations,
    keylen,
    digest: _resolveAlgo(digest),
  });
  const decoded = Uint8Array.from(atob(result.key), c => c.charCodeAt(0));
  if (typeof Buffer !== 'undefined') return Buffer.from(decoded);
  return decoded;
}

// ── randomBytes / randomUUID ────────────────────────────────────────────

function randomBytes(size, callback) {
  const buf = new Uint8Array(size);
  _webcrypto.getRandomValues(buf);
  const result = typeof Buffer !== 'undefined' ? Buffer.from(buf) : buf;
  if (callback) {
    process.nextTick(() => callback(null, result));
    return;
  }
  return result;
}

function randomFillSync(buf, offset, size) {
  offset = offset || 0;
  size = size || buf.length - offset;
  const view = new Uint8Array(buf.buffer || buf, buf.byteOffset + offset, size);
  _webcrypto.getRandomValues(view);
  return buf;
}

function randomFill(buf, offset, size, callback) {
  if (typeof offset === 'function') { callback = offset; offset = 0; size = buf.length; }
  if (typeof size === 'function') { callback = size; size = buf.length - offset; }
  try {
    randomFillSync(buf, offset, size);
    callback(null, buf);
  } catch (err) {
    callback(err);
  }
}

function randomUUID(options) {
  return _webcrypto.randomUUID();
}

function randomInt(min, max, callback) {
  if (max === undefined) { max = min; min = 0; }
  if (typeof max === 'function') { callback = max; max = min; min = 0; }
  const range = max - min;
  const buf = new Uint32Array(1);
  _webcrypto.getRandomValues(buf);
  const result = min + (buf[0] % range);
  if (callback) { process.nextTick(() => callback(null, result)); return; }
  return result;
}

// ── Utility functions ───────────────────────────────────────────────────

function timingSafeEqual(a, b) {
  const bufA = _toUint8Array(a);
  const bufB = _toUint8Array(b);
  if (bufA.length !== bufB.length) throw new RangeError('Input buffers must have the same byte length');
  let result = 0;
  for (let i = 0; i < bufA.length; i++) result |= bufA[i] ^ bufB[i];
  return result === 0;
}

function getHashes() {
  return ['md5', 'sha1', 'sha256', 'sha384', 'sha512'];
}

function getCiphers() {
  return ['aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc', 'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr', 'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm'];
}

// ── Public API ──────────────────────────────────────────────────────────

function createHash(algorithm) {
  return new Hash(algorithm);
}

function createHmac(algorithm, key) {
  return new Hmac(algorithm, key);
}

function createCipheriv(algorithm, key, iv) {
  return new Cipheriv(algorithm, key, iv);
}

function createDecipheriv(algorithm, key, iv) {
  return new Decipheriv(algorithm, key, iv);
}

module.exports = {
  Hash,
  Hmac,
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomFillSync,
  randomFill,
  randomUUID,
  randomInt,
  pbkdf2,
  pbkdf2Sync,
  timingSafeEqual,
  getHashes,
  getCiphers,
  constants: {},
};
