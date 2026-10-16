'use strict';

const { syncInvoke, asyncInvoke } = require('./_sync_bridge');
const EventEmitter = require('./events');
const pathMod = require('./path');

// ── Helpers ──────────────────────────────────────────────────────────────

function makeError(code, message, syscall, path) {
  const err = new Error(`${code}: ${message}, ${syscall} '${path}'`);
  err.code = code;
  err.errno = code === 'ENOENT' ? -2 : code === 'EACCES' ? -13 : code === 'EEXIST' ? -17
    : code === 'EISDIR' ? -21 : code === 'ENOTDIR' ? -20 : code === 'ENOTEMPTY' ? -39 : -1;
  err.syscall = syscall;
  err.path = path;
  return err;
}

function classifyError(e, syscall, filepath) {
  const msg = (e && e.message) || String(e);
  const lower = msg.toLowerCase();
  if (lower.includes('not found') || lower.includes('enoent') || lower.includes('no such'))
    return makeError('ENOENT', 'no such file or directory', syscall, filepath);
  if (lower.includes('permission') || lower.includes('eacces'))
    return makeError('EACCES', 'permission denied', syscall, filepath);
  if (lower.includes('exist') || lower.includes('eexist'))
    return makeError('EEXIST', 'file already exists', syscall, filepath);
  if (lower.includes('is a directory') || lower.includes('eisdir'))
    return makeError('EISDIR', 'illegal operation on a directory', syscall, filepath);
  if (lower.includes('not a directory') || lower.includes('enotdir'))
    return makeError('ENOTDIR', 'not a directory', syscall, filepath);
  if (lower.includes('not empty') || lower.includes('enotempty'))
    return makeError('ENOTEMPTY', 'directory not empty', syscall, filepath);
  const err = new Error(msg);
  err.syscall = syscall;
  err.path = filepath;
  return err;
}

function normalizeEncoding(enc) {
  if (!enc || enc === 'buffer') return enc;
  const s = String(enc).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s === 'utf8' || s === 'utf-8') return 'utf8';
  return s;
}

function parseOptions(options, defaults) {
  if (typeof options === 'string') return { encoding: options, ...defaults };
  if (!options) return { ...defaults };
  return { ...defaults, ...options };
}

function toBuffer(data, encoding) {
  if (typeof data === 'string') {
    return typeof Buffer !== 'undefined' ? Buffer.from(data, encoding || 'utf8') : new TextEncoder().encode(data);
  }
  if (data instanceof Uint8Array) return data;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return data;
  return new TextEncoder().encode(String(data));
}

function encodeResult(data, encoding) {
  if (encoding === 'buffer') {
    if (typeof data === 'string') return typeof Buffer !== 'undefined' ? Buffer.from(data, 'utf8') : new TextEncoder().encode(data);
    return data;
  }
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)))
    return new TextDecoder(encoding || 'utf8').decode(data);
  return String(data);
}

class Stats {
  constructor(raw) {
    this.dev = raw.dev || 0;
    this.ino = raw.ino || 0;
    this.mode = raw.mode || 0;
    this.nlink = raw.nlink || 1;
    this.uid = raw.uid || 0;
    this.gid = raw.gid || 0;
    this.rdev = raw.rdev || 0;
    this.size = raw.size || 0;
    this.blksize = raw.blksize || 4096;
    this.blocks = raw.blocks || Math.ceil(this.size / 512);
    this.atimeMs = raw.atimeMs || raw.atime_ms || Date.now();
    this.mtimeMs = raw.mtimeMs || raw.mtime_ms || Date.now();
    this.ctimeMs = raw.ctimeMs || raw.ctime_ms || Date.now();
    this.birthtimeMs = raw.birthtimeMs || raw.birthtime_ms || this.ctimeMs;
    this.atime = new Date(this.atimeMs);
    this.mtime = new Date(this.mtimeMs);
    this.ctime = new Date(this.ctimeMs);
    this.birthtime = new Date(this.birthtimeMs);
    this._type = raw.type || raw.file_type || 'file';
  }
  isFile() { return this._type === 'file'; }
  isDirectory() { return this._type === 'directory' || this._type === 'dir'; }
  isSymbolicLink() { return this._type === 'symlink'; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
}

class Dirent {
  constructor(name, type) { this.name = name; this._type = type || 'file'; }
  isFile() { return this._type === 'file'; }
  isDirectory() { return this._type === 'directory' || this._type === 'dir'; }
  isSymbolicLink() { return this._type === 'symlink'; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
}

// ── Sync methods ─────────────────────────────────────────────────────────

function readFileSync(filepath, options) {
  const opts = parseOptions(options, { encoding: null });
  const p = String(filepath);
  try {
    const result = syncInvoke('read_file', { path: p });
    const content = (typeof result === 'object' && result !== null && result.content !== undefined) ? result.content : result;
    if (!opts.encoding) {
      if (typeof content === 'string') {
        return typeof Buffer !== 'undefined' ? Buffer.from(content, 'utf8') : new TextEncoder().encode(content);
      }
      return content;
    }
    return encodeResult(content, opts.encoding);
  } catch (e) { throw classifyError(e, 'read', p); }
}

function writeFileSync(filepath, data, options) {
  const opts = parseOptions(options, { encoding: 'utf8', mode: 0o666, flag: 'w' });
  const p = String(filepath);
  const content = typeof data === 'string' ? data : (data instanceof Uint8Array ? new TextDecoder().decode(data) : String(data));
  try {
    syncInvoke('write_file', { path: p, content: content });
  } catch (e) { throw classifyError(e, 'write', p); }
}

function appendFileSync(filepath, data, options) {
  const opts = parseOptions(options, { encoding: 'utf8', mode: 0o666, flag: 'a' });
  const p = String(filepath);
  let existing = '';
  try { existing = readFileSync(p, 'utf8'); } catch (_e) { /* new file */ }
  const append = typeof data === 'string' ? data : String(data);
  writeFileSync(p, existing + append, opts);
}

function existsSync(filepath) {
  try {
    const result = syncInvoke('exists', { path: String(filepath) });
    if (typeof result === 'boolean') return result;
    if (typeof result === 'object' && result !== null) return !!result.exists;
    return !!result;
  } catch (_e) { return false; }
}

function statSync(filepath, options) {
  const p = String(filepath);
  try {
    const raw = syncInvoke('stat', { path: p });
    return new Stats(typeof raw === 'object' ? raw : {});
  } catch (e) { throw classifyError(e, 'stat', p); }
}

function lstatSync(filepath, options) {
  return statSync(filepath, options);
}

function fstatSync(fd) {
  return new Stats({ type: 'file', size: 0 });
}

function readdirSync(dirpath, options) {
  const opts = parseOptions(options, { encoding: 'utf8', withFileTypes: false });
  const p = String(dirpath);
  try {
    const result = syncInvoke('read_dir', { path: p });
    const entries = Array.isArray(result) ? result : (result && result.entries ? result.entries : []);
    if (opts.withFileTypes) {
      return entries.map(e => {
        if (typeof e === 'string') return new Dirent(e, 'file');
        return new Dirent(e.name || e, e.type || e.file_type || 'file');
      });
    }
    return entries.map(e => typeof e === 'string' ? e : (e.name || String(e)));
  } catch (e) { throw classifyError(e, 'scandir', p); }
}

function mkdirSync(dirpath, options) {
  const opts = (typeof options === 'number') ? { mode: options, recursive: false }
    : parseOptions(options, { mode: 0o777, recursive: false });
  const p = String(dirpath);
  try {
    syncInvoke('mkdir', { path: p, recursive: !!opts.recursive });
    return opts.recursive ? p : undefined;
  } catch (e) { throw classifyError(e, 'mkdir', p); }
}

function rmdirSync(dirpath, options) {
  const opts = parseOptions(options, { recursive: false });
  const p = String(dirpath);
  try {
    syncInvoke('delete', { path: p, recursive: !!opts.recursive });
  } catch (e) { throw classifyError(e, 'rmdir', p); }
}

function rmSync(filepath, options) {
  const opts = parseOptions(options, { recursive: false, force: false });
  const p = String(filepath);
  try {
    syncInvoke('delete', { path: p, recursive: !!opts.recursive });
  } catch (e) {
    if (opts.force && e.code === 'ENOENT') return;
    throw classifyError(e, 'rm', p);
  }
}

function unlinkSync(filepath) {
  const p = String(filepath);
  try {
    syncInvoke('delete', { path: p, recursive: false });
  } catch (e) { throw classifyError(e, 'unlink', p); }
}

function renameSync(oldPath, newPath) {
  const o = String(oldPath), n = String(newPath);
  try {
    syncInvoke('rename', { from: o, to: n });
  } catch (e) { throw classifyError(e, 'rename', o); }
}

function copyFileSync(src, dest, mode) {
  const s = String(src), d = String(dest);
  try {
    const data = readFileSync(s);
    writeFileSync(d, data);
  } catch (e) { throw classifyError(e, 'copyfile', s); }
}

function chmodSync(_path, _mode) { /* no-op in sandbox */ }
function chownSync(_path, _uid, _gid) { /* no-op in sandbox */ }

function accessSync(filepath, mode) {
  const p = String(filepath);
  if (!existsSync(p)) throw makeError('ENOENT', 'no such file or directory', 'access', p);
}

function realpathSync(filepath, options) {
  const p = String(filepath);
  if (!existsSync(p)) throw makeError('ENOENT', 'no such file or directory', 'realpath', p);
  return pathMod.resolve(p);
}
realpathSync.native = realpathSync;

function mkdtempSync(prefix, options) {
  const opts = parseOptions(options, { encoding: 'utf8' });
  const suffix = Math.random().toString(36).slice(2, 8);
  const dir = prefix + suffix;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readlinkSync(filepath) { return String(filepath); }
function symlinkSync(target, path) { copyFileSync(target, path); }
function linkSync(existingPath, newPath) { copyFileSync(existingPath, newPath); }
function utimesSync(_path, _atime, _mtime) { /* no-op */ }
function futimesSync(_fd, _atime, _mtime) { /* no-op */ }
function truncateSync(filepath, len) {
  const content = readFileSync(filepath, 'utf8');
  writeFileSync(filepath, content.slice(0, len || 0));
}

// ── Async callback methods ───────────────────────────────────────────────

function wrapAsync(syncFn) {
  return function (...args) {
    const cb = args.pop();
    if (typeof cb !== 'function') throw new TypeError('Callback must be a function');
    try {
      const result = syncFn(...args);
      typeof setImmediate === 'function' ? setImmediate(() => cb(null, result)) : setTimeout(() => cb(null, result), 0);
    } catch (e) {
      typeof setImmediate === 'function' ? setImmediate(() => cb(e)) : setTimeout(() => cb(e), 0);
    }
  };
}

const readFile = wrapAsync(readFileSync);
const writeFile = wrapAsync(writeFileSync);
const appendFile = wrapAsync(appendFileSync);
const stat = wrapAsync(statSync);
const lstat = wrapAsync(lstatSync);
const readdir = wrapAsync(readdirSync);
const mkdir = wrapAsync(mkdirSync);
const rmdir = wrapAsync(rmdirSync);
const rm = wrapAsync(rmSync);
const unlink = wrapAsync(unlinkSync);
const rename = wrapAsync(renameSync);
const copyFile = wrapAsync(copyFileSync);
const chmod = wrapAsync(chmodSync);
const chown = wrapAsync(chownSync);
const access = wrapAsync(accessSync);
const realpath = wrapAsync(realpathSync);
realpath.native = wrapAsync(realpathSync);
const mkdtemp = wrapAsync(mkdtempSync);
const readlink = wrapAsync(readlinkSync);
const symlink = wrapAsync(symlinkSync);
const link = wrapAsync(linkSync);
const utimes = wrapAsync(utimesSync);
const truncate = wrapAsync(truncateSync);

function exists(filepath, cb) {
  if (typeof cb !== 'function') return;
  const result = existsSync(filepath);
  typeof setImmediate === 'function' ? setImmediate(() => cb(result)) : setTimeout(() => cb(result), 0);
}

// ── Streams ──────────────────────────────────────────────────────────────

class ReadStream extends EventEmitter {
  constructor(filepath, options) {
    super();
    this.path = String(filepath);
    this.flags = (options && options.flags) || 'r';
    this.encoding = (options && options.encoding) || null;
    this.fd = (options && options.fd) || null;
    this.mode = (options && options.mode) || 0o666;
    this.start = (options && options.start) || 0;
    this.end = (options && options.end) || Infinity;
    this.highWaterMark = (options && options.highWaterMark) || 64 * 1024;
    this.readable = true;
    this.destroyed = false;
    this.bytesRead = 0;
    this._flowing = false;

    const self = this;
    const kick = () => {
      try {
        let data = readFileSync(self.path);
        if (typeof data === 'string') data = typeof Buffer !== 'undefined' ? Buffer.from(data) : new TextEncoder().encode(data);
        const slice = self.end !== Infinity ? data.slice(self.start, self.end + 1) : data.slice(self.start);
        self.bytesRead = slice.length;
        if (self.encoding) {
          self.emit('data', new TextDecoder(self.encoding).decode(slice));
        } else {
          self.emit('data', slice);
        }
        self.emit('end');
        self.emit('close');
        self.readable = false;
      } catch (e) {
        self.emit('error', classifyError(e, 'read', self.path));
      }
    };
    typeof setImmediate === 'function' ? setImmediate(kick) : setTimeout(kick, 0);
  }
  setEncoding(enc) { this.encoding = enc; return this; }
  pause() { this._flowing = false; return this; }
  resume() { this._flowing = true; return this; }
  pipe(dest) { this.on('data', (chunk) => dest.write(chunk)); this.on('end', () => { if (dest.end) dest.end(); }); return dest; }
  destroy(err) { this.destroyed = true; this.readable = false; if (err) this.emit('error', err); this.emit('close'); return this; }
}

class WriteStream extends EventEmitter {
  constructor(filepath, options) {
    super();
    this.path = String(filepath);
    this.flags = (options && options.flags) || 'w';
    this.encoding = (options && options.encoding) || 'utf8';
    this.fd = (options && options.fd) || null;
    this.mode = (options && options.mode) || 0o666;
    this.writable = true;
    this.destroyed = false;
    this.bytesWritten = 0;
    this._chunks = [];
    if (this.flags === 'a' || this.flags === 'as') {
      try { this._chunks.push(readFileSync(this.path, 'utf8')); } catch (_e) { /* ok */ }
    }
  }
  write(chunk, encoding, cb) {
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    const str = typeof chunk === 'string' ? chunk : new TextDecoder(encoding || this.encoding).decode(chunk);
    this._chunks.push(str);
    this.bytesWritten += (typeof chunk === 'string' ? typeof Buffer !== 'undefined' ? Buffer.byteLength(chunk) : new TextEncoder().encode(chunk).length : chunk.length);
    if (cb) { typeof setImmediate === 'function' ? setImmediate(cb) : setTimeout(cb, 0); }
    return true;
  }
  end(chunk, encoding, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    try {
      writeFileSync(this.path, this._chunks.join(''));
      this.writable = false;
      this.emit('finish');
      this.emit('close');
    } catch (e) { this.emit('error', e); }
    if (cb) { typeof setImmediate === 'function' ? setImmediate(cb) : setTimeout(cb, 0); }
    return this;
  }
  destroy(err) { this.destroyed = true; this.writable = false; if (err) this.emit('error', err); this.emit('close'); return this; }
}

function createReadStream(filepath, options) { return new ReadStream(filepath, options); }
function createWriteStream(filepath, options) { return new WriteStream(filepath, options); }

// ── Watch ────────────────────────────────────────────────────────────────

const _watchers = new Map();

function watchFile(filepath, optionsOrListener, listener) {
  let options = { interval: 5007, persistent: true };
  if (typeof optionsOrListener === 'function') {
    listener = optionsOrListener;
  } else if (optionsOrListener) {
    options = { ...options, ...optionsOrListener };
  }
  const p = String(filepath);
  let prev = null;
  try { prev = statSync(p); } catch (_e) { prev = new Stats({ size: 0, type: 'file' }); }

  const timer = setInterval(() => {
    let curr;
    try { curr = statSync(p); } catch (_e) { curr = new Stats({ size: 0, type: 'file' }); }
    if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
      if (listener) listener(curr, prev);
      prev = curr;
    }
  }, options.interval);

  if (!options.persistent && timer.unref) timer.unref();
  _watchers.set(p, timer);
  return { close() { clearInterval(timer); _watchers.delete(p); } };
}

function unwatchFile(filepath, listener) {
  const p = String(filepath);
  const timer = _watchers.get(p);
  if (timer) { clearInterval(timer); _watchers.delete(p); }
}

function watch(filepath, optionsOrListener, listener) {
  let options = { persistent: true, recursive: false, encoding: 'utf8' };
  if (typeof optionsOrListener === 'function') {
    listener = optionsOrListener;
  } else if (optionsOrListener) {
    if (typeof optionsOrListener === 'string') { options.encoding = optionsOrListener; }
    else { options = { ...options, ...optionsOrListener }; }
  }

  const watcher = new EventEmitter();
  watcher.close = function () { clearInterval(watcher._timer); };
  const p = String(filepath);
  let prevEntries = null;
  try { prevEntries = JSON.stringify(readdirSync(p)); } catch (_e) {
    try { prevEntries = JSON.stringify(statSync(p)); } catch (_e2) { prevEntries = ''; }
  }

  watcher._timer = setInterval(() => {
    let currEntries;
    try { currEntries = JSON.stringify(readdirSync(p)); } catch (_e) {
      try { currEntries = JSON.stringify(statSync(p)); } catch (_e2) { currEntries = ''; }
    }
    if (currEntries !== prevEntries) {
      prevEntries = currEntries;
      const eventType = 'change';
      watcher.emit('change', eventType, pathMod.basename(p));
      if (listener) listener(eventType, pathMod.basename(p));
    }
  }, 1000);

  if (!options.persistent && watcher._timer.unref) watcher._timer.unref();
  return watcher;
}

// ── fd-based stubs (many extensions don't use these but they must exist) ─

let _nextFd = 100;
const _fdPaths = new Map();

function openSync(filepath, flags, mode) {
  const p = String(filepath);
  const f = flags || 'r';
  if (f === 'r' || f === 'rs' || f === 'r+') {
    if (!existsSync(p)) throw makeError('ENOENT', 'no such file or directory', 'open', p);
  }
  if (f === 'w' || f === 'w+' || f === 'wx') {
    try { writeFileSync(p, ''); } catch (_e) { /* may already exist */ }
  }
  const fd = _nextFd++;
  _fdPaths.set(fd, { path: p, flags: f });
  return fd;
}

function closeSync(fd) { _fdPaths.delete(fd); }
function open(filepath, flags, mode, cb) {
  if (typeof mode === 'function') { cb = mode; mode = undefined; }
  if (typeof flags === 'function') { cb = flags; flags = 'r'; }
  try { const fd = openSync(filepath, flags, mode); typeof setImmediate === 'function' ? setImmediate(() => cb(null, fd)) : setTimeout(() => cb(null, fd), 0); }
  catch (e) { typeof setImmediate === 'function' ? setImmediate(() => cb(e)) : setTimeout(() => cb(e), 0); }
}
function close(fd, cb) { closeSync(fd); if (cb) { typeof setImmediate === 'function' ? setImmediate(() => cb(null)) : setTimeout(() => cb(null), 0); } }

function readSync(fd, buffer, offset, length, position) {
  const info = _fdPaths.get(fd);
  if (!info) throw makeError('EBADF', 'bad file descriptor', 'read', '');
  const data = readFileSync(info.path);
  const src = (typeof data === 'string') ? (typeof Buffer !== 'undefined' ? Buffer.from(data) : new TextEncoder().encode(data)) : data;
  const start = position != null ? position : 0;
  const end = Math.min(start + length, src.length);
  const bytesRead = end - start;
  for (let i = 0; i < bytesRead; i++) buffer[offset + i] = src[start + i];
  return bytesRead;
}

function writeSync(fd, bufferOrStr, offsetOrPos, lengthOrEnc) {
  const info = _fdPaths.get(fd);
  if (!info) throw makeError('EBADF', 'bad file descriptor', 'write', '');
  const content = typeof bufferOrStr === 'string' ? bufferOrStr : new TextDecoder().decode(bufferOrStr);
  writeFileSync(info.path, content);
  return typeof bufferOrStr === 'string' ? (typeof Buffer !== 'undefined' ? Buffer.byteLength(bufferOrStr) : new TextEncoder().encode(bufferOrStr).length) : bufferOrStr.length;
}

// ── Promises API ─────────────────────────────────────────────────────────

function wrapPromise(syncFn) {
  return function (...args) {
    return new Promise((resolve, reject) => {
      try { resolve(syncFn(...args)); } catch (e) { reject(e); }
    });
  };
}

const promises = {
  readFile: wrapPromise(readFileSync),
  writeFile: wrapPromise(writeFileSync),
  appendFile: wrapPromise(appendFileSync),
  stat: wrapPromise(statSync),
  lstat: wrapPromise(lstatSync),
  readdir: wrapPromise(readdirSync),
  mkdir: wrapPromise(mkdirSync),
  rmdir: wrapPromise(rmdirSync),
  rm: wrapPromise(rmSync),
  unlink: wrapPromise(unlinkSync),
  rename: wrapPromise(renameSync),
  copyFile: wrapPromise(copyFileSync),
  access: wrapPromise(accessSync),
  realpath: wrapPromise(realpathSync),
  mkdtemp: wrapPromise(mkdtempSync),
  chmod: wrapPromise(chmodSync),
  chown: wrapPromise(chownSync),
  readlink: wrapPromise(readlinkSync),
  symlink: wrapPromise(symlinkSync),
  link: wrapPromise(linkSync),
  utimes: wrapPromise(utimesSync),
  truncate: wrapPromise(truncateSync),
  open: wrapPromise(openSync),
};

// ── Constants ────────────────────────────────────────────────────────────

const constants = {
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128,
  O_TRUNC: 512, O_APPEND: 1024, O_SYNC: 1052672,
  S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFCHR: 8192,
  S_IFBLK: 24576, S_IFIFO: 4096, S_IFLNK: 40960, S_IFSOCK: 49152,
};

// ── Export ────────────────────────────────────────────────────────────────

const fs = {
  readFileSync, writeFileSync, appendFileSync, existsSync, statSync, lstatSync,
  fstatSync, readdirSync, mkdirSync, rmdirSync, rmSync, unlinkSync, renameSync,
  copyFileSync, chmodSync, chownSync, accessSync, realpathSync, mkdtempSync,
  readlinkSync, symlinkSync, linkSync, utimesSync, futimesSync, truncateSync,
  openSync, closeSync, readSync, writeSync,
  readFile, writeFile, appendFile, stat, lstat, readdir, mkdir, rmdir, rm,
  unlink, rename, copyFile, chmod, chown, access, realpath, mkdtemp,
  readlink, symlink, link, utimes, truncate, exists, open, close,
  createReadStream, createWriteStream,
  watchFile, unwatchFile, watch,
  promises, constants, Stats, Dirent, ReadStream, WriteStream,
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
};

module.exports = fs;
