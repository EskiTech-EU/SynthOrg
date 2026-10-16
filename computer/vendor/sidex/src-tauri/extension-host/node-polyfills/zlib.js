'use strict';

const { Transform } = require('./stream.js');

const Z_NO_FLUSH = 0;
const Z_PARTIAL_FLUSH = 1;
const Z_SYNC_FLUSH = 2;
const Z_FULL_FLUSH = 3;
const Z_FINISH = 4;

const Z_OK = 0;
const Z_STREAM_END = 1;
const Z_NEED_DICT = 2;
const Z_ERRNO = -1;
const Z_STREAM_ERROR = -2;
const Z_DATA_ERROR = -3;
const Z_MEM_ERROR = -4;
const Z_BUF_ERROR = -5;

const Z_NO_COMPRESSION = 0;
const Z_BEST_SPEED = 1;
const Z_BEST_COMPRESSION = 9;
const Z_DEFAULT_COMPRESSION = -1;

const Z_DEFAULT_STRATEGY = 0;

const constants = {
  Z_NO_FLUSH, Z_PARTIAL_FLUSH, Z_SYNC_FLUSH, Z_FULL_FLUSH, Z_FINISH,
  Z_OK, Z_STREAM_END, Z_NEED_DICT, Z_ERRNO, Z_STREAM_ERROR,
  Z_DATA_ERROR, Z_MEM_ERROR, Z_BUF_ERROR,
  Z_NO_COMPRESSION, Z_BEST_SPEED, Z_BEST_COMPRESSION, Z_DEFAULT_COMPRESSION,
  Z_DEFAULT_STRATEGY,
  DEFLATE: 1, INFLATE: 2, GZIP: 3, GUNZIP: 4, DEFLATERAW: 5, INFLATERAW: 6, UNZIP: 7,
};

class ZlibBase extends Transform {
  constructor(format, opts = {}) {
    super(opts);
    this._format = format;
    this._chunks = [];
    this._finished = false;
  }

  _transform(chunk, encoding, callback) {
    if (typeof chunk === 'string') {
      chunk = new TextEncoder().encode(chunk);
    }
    this._chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    callback();
  }

  _flush(callback) {
    const totalLen = this._chunks.reduce((s, c) => s + c.length, 0);
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of this._chunks) {
      combined.set(c, offset);
      offset += c.length;
    }

    this._processData(combined).then(
      (result) => {
        this.push(new Uint8Array(result));
        callback();
      },
      (err) => callback(err),
    );
  }

  async _processData(_data) {
    throw new Error('_processData must be implemented by subclass');
  }
}

async function compressStream(data, format) {
  const cs = new CompressionStream(format);
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();

  const reader = cs.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  let total = 0;
  for (const c of chunks) total += c.length;
  const result = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { result.set(c, off); off += c.length; }
  return result;
}

async function decompressStream(data, format) {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();

  const reader = ds.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  let total = 0;
  for (const c of chunks) total += c.length;
  const result = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { result.set(c, off); off += c.length; }
  return result;
}

class Gzip extends ZlibBase {
  constructor(opts) { super('gzip', opts); }
  async _processData(data) { return compressStream(data, 'gzip'); }
}

class Gunzip extends ZlibBase {
  constructor(opts) { super('gunzip', opts); }
  async _processData(data) { return decompressStream(data, 'gzip'); }
}

class Deflate extends ZlibBase {
  constructor(opts) { super('deflate', opts); }
  async _processData(data) { return compressStream(data, 'deflate'); }
}

class Inflate extends ZlibBase {
  constructor(opts) { super('inflate', opts); }
  async _processData(data) { return decompressStream(data, 'deflate'); }
}

class DeflateRaw extends ZlibBase {
  constructor(opts) { super('deflate-raw', opts); }
  async _processData(data) { return compressStream(data, 'deflate-raw'); }
}

class InflateRaw extends ZlibBase {
  constructor(opts) { super('inflate-raw', opts); }
  async _processData(data) { return decompressStream(data, 'deflate-raw'); }
}

class Unzip extends ZlibBase {
  constructor(opts) { super('unzip', opts); }
  async _processData(data) {
    try {
      return await decompressStream(data, 'gzip');
    } catch {
      return decompressStream(data, 'deflate');
    }
  }
}

// Convenience functions

function createGzip(opts) { return new Gzip(opts); }
function createGunzip(opts) { return new Gunzip(opts); }
function createDeflate(opts) { return new Deflate(opts); }
function createInflate(opts) { return new Inflate(opts); }
function createDeflateRaw(opts) { return new DeflateRaw(opts); }
function createInflateRaw(opts) { return new InflateRaw(opts); }
function createUnzip(opts) { return new Unzip(opts); }

function _callbackBuffer(streamClass, buf, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  const chunks = [];
  const stream = new streamClass(opts);
  stream.on('data', (chunk) => chunks.push(chunk));
  stream.on('end', () => {
    let total = 0;
    for (const c of chunks) total += c.length;
    const result = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { result.set(c, off); off += c.length; }
    callback(null, result);
  });
  stream.on('error', (err) => callback(err));
  stream.end(buf);
}

function gzip(buf, opts, callback) { _callbackBuffer(Gzip, buf, opts, callback); }
function gunzip(buf, opts, callback) { _callbackBuffer(Gunzip, buf, opts, callback); }
function deflate(buf, opts, callback) { _callbackBuffer(Deflate, buf, opts, callback); }
function inflate(buf, opts, callback) { _callbackBuffer(Inflate, buf, opts, callback); }
function deflateRaw(buf, opts, callback) { _callbackBuffer(DeflateRaw, buf, opts, callback); }
function inflateRaw(buf, opts, callback) { _callbackBuffer(InflateRaw, buf, opts, callback); }
function unzip(buf, opts, callback) { _callbackBuffer(Unzip, buf, opts, callback); }

function gzipSync(buf) { throw new Error('zlib sync methods not supported; use async gzip()'); }
function gunzipSync(buf) { throw new Error('zlib sync methods not supported; use async gunzip()'); }
function deflateSync(buf) { throw new Error('zlib sync methods not supported; use async deflate()'); }
function inflateSync(buf) { throw new Error('zlib sync methods not supported; use async inflate()'); }
function deflateRawSync(buf) { throw new Error('zlib sync methods not supported; use async deflateRaw()'); }
function inflateRawSync(buf) { throw new Error('zlib sync methods not supported; use async inflateRaw()'); }
function unzipSync(buf) { throw new Error('zlib sync methods not supported; use async unzip()'); }

module.exports = {
  constants,
  Gzip, Gunzip, Deflate, Inflate, DeflateRaw, InflateRaw, Unzip,
  createGzip, createGunzip, createDeflate, createInflate,
  createDeflateRaw, createInflateRaw, createUnzip,
  gzip, gunzip, deflate, inflate, deflateRaw, inflateRaw, unzip,
  gzipSync, gunzipSync, deflateSync, inflateSync,
  deflateRawSync, inflateRawSync, unzipSync,
};
