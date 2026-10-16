'use strict';

const EventEmitter = require('./events.js');
const { Readable, Writable } = require('./stream.js');
const { syncInvoke, asyncInvoke } = require('./_sync_bridge.js');

const _startTime = Date.now();
const _exitCallbacks = [];
const _uncaughtHandlers = [];

// ── stdout / stderr / stdin ───────────────────────────────────────────────

class ProcessWriteStream extends Writable {
  constructor(fd) {
    super();
    this.fd = fd;
    this.isTTY = false;
    this.columns = 80;
    this.rows = 24;
  }

  _write(chunk, encoding, callback) {
    const str = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    if (this.fd === 1) {
      console.log(str.replace(/\n$/, ''));
    } else {
      console.error(str.replace(/\n$/, ''));
    }
    callback();
  }
}

class ProcessReadStream extends Readable {
  constructor() {
    super();
    this.isTTY = false;
  }

  _read() {}
}

// ── env proxy ─────────────────────────────────────────────────────────────

let _envCache = null;

function _getEnv() {
  if (_envCache) return _envCache;
  try {
    _envCache = syncInvoke('get_all_env', {});
  } catch {
    _envCache = {};
  }
  return _envCache;
}

const env = new Proxy({}, {
  get(_, key) {
    if (typeof key === 'symbol') return undefined;
    return _getEnv()[key];
  },
  set(_, key, value) {
    _getEnv()[key] = String(value);
    return true;
  },
  has(_, key) {
    return key in _getEnv();
  },
  deleteProperty(_, key) {
    delete _getEnv()[key];
    return true;
  },
  ownKeys() {
    return Object.keys(_getEnv());
  },
  getOwnPropertyDescriptor(_, key) {
    const envObj = _getEnv();
    if (key in envObj) {
      return { value: envObj[key], writable: true, enumerable: true, configurable: true };
    }
    return undefined;
  },
});

// ── cwd / chdir ───────────────────────────────────────────────────────────

let _cwd = null;

function cwd() {
  if (_cwd) return _cwd;
  try {
    _cwd = syncInvoke('get_cwd', {});
  } catch {
    _cwd = '/';
  }
  return _cwd;
}

function chdir(dir) {
  try {
    syncInvoke('set_cwd', { dir });
    _cwd = dir;
  } catch (e) {
    const err = new Error(`ENOENT: no such file or directory, chdir '${dir}'`);
    err.code = 'ENOENT';
    throw err;
  }
}

// ── hrtime ────────────────────────────────────────────────────────────────

function hrtime(prev) {
  const now = performance.now();
  const seconds = Math.floor(now / 1000);
  const nanos = Math.round((now % 1000) * 1e6);
  if (prev) {
    let ds = seconds - prev[0];
    let dn = nanos - prev[1];
    if (dn < 0) { ds--; dn += 1e9; }
    return [ds, dn];
  }
  return [seconds, nanos];
}

hrtime.bigint = function bigint() {
  return BigInt(Math.round(performance.now() * 1e6));
};

// ── nextTick ──────────────────────────────────────────────────────────────

const _tickQueue = [];
let _tickScheduled = false;

function nextTick(callback, ...args) {
  if (typeof callback !== 'function') {
    throw new TypeError('callback is not a function');
  }
  _tickQueue.push({ callback, args });
  if (!_tickScheduled) {
    _tickScheduled = true;
    queueMicrotask(_drainTicks);
  }
}

function _drainTicks() {
  _tickScheduled = false;
  while (_tickQueue.length > 0) {
    const { callback, args } = _tickQueue.shift();
    try {
      callback(...args);
    } catch (err) {
      if (_uncaughtHandlers.length > 0) {
        for (const handler of _uncaughtHandlers) handler(err);
      } else {
        console.error('Uncaught exception in nextTick:', err);
      }
    }
  }
}

// ── Platform detection ────────────────────────────────────────────────────

function _detectPlatform() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  if (/win/i.test(ua)) return 'win32';
  if (/mac|darwin/i.test(ua)) return 'darwin';
  if (/linux/i.test(ua)) return 'linux';
  try {
    const p = syncInvoke('get_platform', {});
    return p || 'linux';
  } catch {
    return 'linux';
  }
}

function _detectArch() {
  try {
    const a = syncInvoke('get_arch', {});
    return a || 'x64';
  } catch {
    return 'x64';
  }
}

// ── exit ──────────────────────────────────────────────────────────────────

function exit(code) {
  code = code || 0;
  for (const fn of _exitCallbacks) {
    try { fn(code); } catch {}
  }
  try {
    asyncInvoke('process_exit', { code });
  } catch {}
}

// ── memoryUsage ───────────────────────────────────────────────────────────

function memoryUsage() {
  if (typeof performance !== 'undefined' && performance.memory) {
    return {
      rss: performance.memory.totalJSHeapSize || 0,
      heapTotal: performance.memory.totalJSHeapSize || 0,
      heapUsed: performance.memory.usedJSHeapSize || 0,
      external: 0,
      arrayBuffers: 0,
    };
  }
  return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
}

memoryUsage.rss = function rss() {
  return memoryUsage().rss;
};

function uptime() {
  return (Date.now() - _startTime) / 1000;
}

// ── process object ────────────────────────────────────────────────────────

const process = Object.create(EventEmitter.prototype);
EventEmitter.call(process);

Object.assign(process, {
  env,
  cwd,
  chdir,

  platform: _detectPlatform(),
  arch: _detectArch(),
  pid: 1,
  ppid: 0,

  versions: {
    node: '20.0.0',
    v8: '11.0',
    modules: '108',
    openssl: '3.0.0',
  },
  version: 'v20.0.0',

  argv: ['sidex', 'extension-host'],
  argv0: 'sidex',
  execPath: '/usr/local/bin/sidex',
  execArgv: [],

  title: 'sidex-extension-host',

  stdout: new ProcessWriteStream(1),
  stderr: new ProcessWriteStream(2),
  stdin: new ProcessReadStream(),

  nextTick,
  exit,
  abort() { exit(134); },
  kill(pid, signal) {
    try { asyncInvoke('process_kill', { pid, signal }); } catch {}
  },

  hrtime,

  memoryUsage,
  uptime,

  cpuUsage(prev) {
    const now = { user: 0, system: 0 };
    if (prev) {
      now.user -= prev.user;
      now.system -= prev.system;
    }
    return now;
  },

  emitWarning(warning, type, code) {
    if (typeof warning === 'string') {
      warning = new Error(warning);
      warning.name = type || 'Warning';
      if (code) warning.code = code;
    }
    process.emit('warning', warning);
    console.warn(`${warning.name}: ${warning.message}`);
  },

  config: { variables: {} },
  release: { name: 'node', sourceUrl: '', headersUrl: '' },

  features: {
    inspector: false,
    debug: false,
    uv: false,
    ipv6: true,
    tls_alpn: false,
    tls_sni: false,
    tls_ocsp: false,
    tls: false,
  },

  noDeprecation: false,
  throwDeprecation: false,
  traceDeprecation: false,
  traceProcessWarnings: false,

  binding() {
    throw new Error('process.binding is not supported in SideX polyfill');
  },

  umask(mask) {
    if (mask !== undefined) return 0o22;
    return 0o22;
  },
});

// Event handler registration
const origOn = process.on.bind(process);
process.on = function (event, handler) {
  if (event === 'exit') {
    _exitCallbacks.push(handler);
  } else if (event === 'uncaughtException') {
    _uncaughtHandlers.push(handler);
  }
  return origOn(event, handler);
};

// Install global error handler
if (typeof globalThis !== 'undefined') {
  globalThis.addEventListener?.('error', (event) => {
    if (_uncaughtHandlers.length > 0) {
      for (const handler of _uncaughtHandlers) {
        handler(event.error || new Error(event.message));
      }
      event.preventDefault();
    }
  });

  globalThis.addEventListener?.('unhandledrejection', (event) => {
    process.emit('unhandledRejection', event.reason, event.promise);
  });
}

module.exports = process;
