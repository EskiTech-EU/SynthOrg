'use strict';

const EventEmitter = require('./events.js');

const kDestroyed = Symbol('destroyed');
const kErrored = Symbol('errored');

// ── Readable ──────────────────────────────────────────────────────────────

class Readable extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.readable = true;
    this.readableEnded = false;
    this.readableFlowing = null;
    this.readableHighWaterMark = opts.highWaterMark || 16384;
    this.readableObjectMode = !!opts.objectMode;
    this.encoding = opts.encoding || null;
    this[kDestroyed] = false;
    this[kErrored] = null;

    this._buffer = [];
    this._readableState = {
      ended: false,
      reading: false,
      length: 0,
    };

    if (typeof opts.read === 'function') {
      this._read = opts.read;
    }
    if (typeof opts.destroy === 'function') {
      this._destroy = opts.destroy;
    }
  }

  get destroyed() { return this[kDestroyed]; }

  _read(_size) {}

  read(size) {
    if (this._buffer.length === 0) {
      if (this._readableState.ended) return null;
      this._read(this.readableHighWaterMark);
      if (this._buffer.length === 0) return null;
    }

    let chunk;
    if (size === undefined || size >= this._readableState.length) {
      if (this.readableObjectMode) {
        chunk = this._buffer.shift();
        this._readableState.length -= 1;
      } else {
        chunk = Buffer.concat
          ? Buffer.concat(this._buffer)
          : this._concatBuffers(this._buffer);
        this._readableState.length = 0;
        this._buffer = [];
      }
    } else {
      chunk = this._buffer.shift();
      this._readableState.length -= (this.readableObjectMode ? 1 : chunk.length);
    }

    if (this._readableState.ended && this._buffer.length === 0) {
      this.readableEnded = true;
      queueMicrotask(() => this.emit('end'));
    }

    return chunk;
  }

  _concatBuffers(list) {
    if (list.length === 0) return new Uint8Array(0);
    if (list.length === 1) return list[0];
    let total = 0;
    for (const buf of list) total += buf.length;
    const result = new Uint8Array(total);
    let offset = 0;
    for (const buf of list) {
      result.set(buf instanceof Uint8Array ? buf : new Uint8Array(buf), offset);
      offset += buf.length;
    }
    return result;
  }

  push(chunk, encoding) {
    if (chunk === null) {
      this._readableState.ended = true;
      if (this._buffer.length === 0) {
        this.readableEnded = true;
        queueMicrotask(() => this.emit('end'));
      }
      return false;
    }

    if (typeof chunk === 'string') {
      chunk = new TextEncoder().encode(chunk);
    }

    this._buffer.push(chunk);
    this._readableState.length += this.readableObjectMode ? 1 : chunk.length;

    if (this.readableFlowing) {
      queueMicrotask(() => {
        while (this._buffer.length > 0 && this.readableFlowing) {
          const c = this._buffer.shift();
          this._readableState.length -= this.readableObjectMode ? 1 : c.length;
          this.emit('data', c);
        }
      });
    }

    return this._readableState.length < this.readableHighWaterMark;
  }

  pipe(dest, opts) {
    const src = this;
    src.readableFlowing = true;

    function onData(chunk) {
      const canContinue = dest.write(chunk);
      if (!canContinue && src.pause) src.pause();
    }

    function onEnd() {
      if (!opts || opts.end !== false) {
        dest.end();
      }
    }

    function onDrain() {
      if (src.resume) src.resume();
    }

    src.on('data', onData);
    src.on('end', onEnd);
    dest.on('drain', onDrain);

    dest.emit('pipe', src);

    // Flush existing buffer
    while (this._buffer.length > 0) {
      const c = this._buffer.shift();
      this._readableState.length -= this.readableObjectMode ? 1 : c.length;
      this.emit('data', c);
    }

    return dest;
  }

  unpipe(dest) {
    this.readableFlowing = false;
    if (dest) dest.emit('unpipe', this);
    return this;
  }

  pause() {
    this.readableFlowing = false;
    return this;
  }

  resume() {
    if (!this.readableFlowing) {
      this.readableFlowing = true;
      while (this._buffer.length > 0 && this.readableFlowing) {
        const c = this._buffer.shift();
        this._readableState.length -= this.readableObjectMode ? 1 : c.length;
        this.emit('data', c);
      }
    }
    return this;
  }

  setEncoding(enc) {
    this.encoding = enc;
    return this;
  }

  on(ev, fn) {
    const res = super.on(ev, fn);
    if (ev === 'data' && this.readableFlowing !== false) {
      this.resume();
    }
    return res;
  }

  destroy(err) {
    if (this[kDestroyed]) return this;
    this[kDestroyed] = true;
    this._buffer = [];
    this._readableState.length = 0;

    const doDestroy = (e) => {
      if (e) {
        this[kErrored] = e;
        this.emit('error', e);
      }
      this.emit('close');
    };

    if (this._destroy) {
      this._destroy(err, doDestroy);
    } else {
      doDestroy(err);
    }
    return this;
  }

  [Symbol.asyncIterator]() {
    let ended = false;
    const buffer = [];
    let resolve = null;

    this.on('data', (chunk) => {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: chunk, done: false });
      } else {
        buffer.push(chunk);
      }
    });

    this.on('end', () => {
      ended = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined, done: true });
      }
    });

    this.on('error', (err) => {
      ended = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r(Promise.reject(err));
      }
    });

    return {
      next: () => {
        if (buffer.length > 0) {
          return Promise.resolve({ value: buffer.shift(), done: false });
        }
        if (ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((r) => { resolve = r; });
      },
      return: () => {
        this.destroy();
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() { return this; },
    };
  }
}

// ── Writable ──────────────────────────────────────────────────────────────

class Writable extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.writable = true;
    this.writableEnded = false;
    this.writableFinished = false;
    this.writableHighWaterMark = opts.highWaterMark || 16384;
    this.writableObjectMode = !!opts.objectMode;
    this[kDestroyed] = false;
    this[kErrored] = null;

    this._writableState = {
      length: 0,
      corked: 0,
      buffered: [],
      writing: false,
      ended: false,
      finished: false,
    };

    if (typeof opts.write === 'function') {
      this._write = opts.write;
    }
    if (typeof opts.writev === 'function') {
      this._writev = opts.writev;
    }
    if (typeof opts.destroy === 'function') {
      this._destroy = opts.destroy;
    }
    if (typeof opts.final === 'function') {
      this._final = opts.final;
    }
  }

  get destroyed() { return this[kDestroyed]; }

  _write(chunk, encoding, callback) {
    callback();
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = 'utf8';
    }
    callback = callback || (() => {});

    if (this.writableEnded) {
      const err = new Error('write after end');
      this.emit('error', err);
      if (callback) callback(err);
      return false;
    }

    if (typeof chunk === 'string') {
      chunk = new TextEncoder().encode(chunk);
    }

    this._writableState.length += this.writableObjectMode ? 1 : (chunk.length || 0);

    const afterWrite = (err) => {
      this._writableState.writing = false;
      this._writableState.length -= this.writableObjectMode ? 1 : (chunk.length || 0);
      if (err) {
        this[kErrored] = err;
        this.emit('error', err);
      }
      callback(err || null);
      if (this._writableState.length < this.writableHighWaterMark) {
        this.emit('drain');
      }
      this._drainBuffered();
    };

    if (this._writableState.corked || this._writableState.writing) {
      this._writableState.buffered.push({ chunk, encoding, callback: afterWrite });
    } else {
      this._writableState.writing = true;
      this._write(chunk, encoding, afterWrite);
    }

    return this._writableState.length < this.writableHighWaterMark;
  }

  _drainBuffered() {
    if (this._writableState.writing || this._writableState.corked) return;
    if (this._writableState.buffered.length === 0) {
      if (this._writableState.ended && !this._writableState.finished) {
        this._finishWriting();
      }
      return;
    }
    const entry = this._writableState.buffered.shift();
    this._writableState.writing = true;
    this._write(entry.chunk, entry.encoding, entry.callback);
  }

  _finishWriting() {
    const done = () => {
      this._writableState.finished = true;
      this.writableFinished = true;
      this.emit('finish');
      this.emit('close');
    };
    if (this._final) {
      this._final(done);
    } else {
      done();
    }
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }

    if (callback) this.once('finish', callback);

    if (chunk !== undefined && chunk !== null) {
      this.write(chunk, encoding);
    }

    this.writableEnded = true;
    this._writableState.ended = true;

    if (!this._writableState.writing && this._writableState.buffered.length === 0) {
      this._finishWriting();
    }

    return this;
  }

  cork() {
    this._writableState.corked++;
  }

  uncork() {
    if (this._writableState.corked > 0) {
      this._writableState.corked--;
      if (this._writableState.corked === 0) {
        this._drainBuffered();
      }
    }
  }

  destroy(err) {
    if (this[kDestroyed]) return this;
    this[kDestroyed] = true;
    this._writableState.buffered = [];
    this._writableState.length = 0;

    const doDestroy = (e) => {
      if (e) {
        this[kErrored] = e;
        this.emit('error', e);
      }
      this.emit('close');
    };

    if (this._destroy) {
      this._destroy(err, doDestroy);
    } else {
      doDestroy(err);
    }
    return this;
  }
}

// ── Duplex ────────────────────────────────────────────────────────────────

class Duplex extends EventEmitter {
  constructor(opts = {}) {
    super();

    Readable.call(this, opts);
    Writable.call(this, opts);

    this.allowHalfOpen = opts.allowHalfOpen !== false;

    if (typeof opts.read === 'function') this._read = opts.read;
    if (typeof opts.write === 'function') this._write = opts.write;
    if (typeof opts.final === 'function') this._final = opts.final;
    if (typeof opts.destroy === 'function') this._destroy = opts.destroy;
  }
}

// Copy Readable & Writable prototype methods onto Duplex
const rProto = Readable.prototype;
const wProto = Writable.prototype;
for (const method of Object.getOwnPropertyNames(rProto)) {
  if (method === 'constructor') continue;
  if (!Duplex.prototype[method]) {
    Object.defineProperty(
      Duplex.prototype,
      method,
      Object.getOwnPropertyDescriptor(rProto, method),
    );
  }
}
for (const method of Object.getOwnPropertyNames(wProto)) {
  if (method === 'constructor') continue;
  if (!Duplex.prototype[method]) {
    Object.defineProperty(
      Duplex.prototype,
      method,
      Object.getOwnPropertyDescriptor(wProto, method),
    );
  }
}

// ── Transform ─────────────────────────────────────────────────────────────

class Transform extends Duplex {
  constructor(opts = {}) {
    super(opts);
    this._transformState = {
      afterTransform: null,
      needTransform: false,
      transforming: false,
      writecb: null,
      writechunk: null,
    };

    if (typeof opts.transform === 'function') {
      this._transform = opts.transform;
    }
    if (typeof opts.flush === 'function') {
      this._flush = opts.flush;
    }
  }

  _transform(chunk, encoding, callback) {
    callback(null, chunk);
  }

  _write(chunk, encoding, callback) {
    this._transformState.writecb = callback;
    this._transformState.writechunk = chunk;

    this._transform(chunk, encoding, (err, data) => {
      if (err) {
        callback(err);
        return;
      }
      if (data !== undefined && data !== null) {
        this.push(data);
      }
      callback();
    });
  }

  _read(_size) {
    const ts = this._transformState;
    if (ts.writechunk !== null && ts.writecb && !ts.transforming) {
      ts.transforming = true;
      this._transform(ts.writechunk, null, (err, data) => {
        ts.transforming = false;
        if (data !== undefined && data !== null) {
          this.push(data);
        }
      });
    }
  }

  _finishWriting() {
    const done = (err, data) => {
      if (err) {
        this.emit('error', err);
      }
      if (data !== undefined && data !== null) {
        this.push(data);
      }
      this.push(null);
      this._writableState.finished = true;
      this.writableFinished = true;
      this.emit('finish');
      this.emit('close');
    };

    if (this._flush) {
      this._flush(done);
    } else {
      done(null, null);
    }
  }
}

// ── PassThrough ───────────────────────────────────────────────────────────

class PassThrough extends Transform {
  constructor(opts) {
    super(opts);
  }

  _transform(chunk, encoding, callback) {
    callback(null, chunk);
  }
}

// ── pipeline / finished utilities ─────────────────────────────────────────

function pipeline(...args) {
  let callback;
  if (typeof args[args.length - 1] === 'function') {
    callback = args.pop();
  }

  const streams = args.flat ? args.flat() : args;
  if (streams.length < 2) {
    throw new Error('pipeline requires at least 2 streams');
  }

  let error;
  function destroyer(stream, err) {
    if (!stream.destroyed) {
      stream.destroy(err);
    }
  }

  for (let i = 0; i < streams.length - 1; i++) {
    streams[i].pipe(streams[i + 1]);
  }

  for (const stream of streams) {
    stream.on('error', (err) => {
      error = err;
      for (const s of streams) destroyer(s, err);
      if (callback) callback(err);
    });
  }

  const last = streams[streams.length - 1];
  last.on('finish', () => {
    if (callback && !error) callback(null);
  });

  if (!callback) {
    return new Promise((resolve, reject) => {
      last.on('finish', resolve);
      last.on('error', reject);
    });
  }
}

function finished(stream, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }

  const prom = new Promise((resolve, reject) => {
    function onFinish() {
      cleanup();
      resolve();
    }
    function onEnd() {
      cleanup();
      resolve();
    }
    function onError(err) {
      cleanup();
      reject(err);
    }
    function onClose() {
      cleanup();
      resolve();
    }
    function cleanup() {
      stream.removeListener('finish', onFinish);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    }

    stream.on('finish', onFinish);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.on('close', onClose);
  });

  if (callback) {
    prom.then(() => callback(null), callback);
    return () => {};
  }
  return prom;
}

// ── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
  Stream: Readable,
  pipeline,
  finished,
};
module.exports.Stream = module.exports;
