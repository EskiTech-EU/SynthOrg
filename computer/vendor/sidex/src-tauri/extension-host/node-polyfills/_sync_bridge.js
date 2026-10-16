'use strict';

/**
 * Async-to-Sync bridge for Tauri invoke() calls.
 *
 * Node.js built-ins expose many synchronous APIs (readFileSync, existsSync, etc.)
 * but Tauri's invoke() is inherently async. This module provides three strategies
 * to bridge the gap, chosen at init time based on environment capabilities:
 *
 * 1. SharedArrayBuffer + Atomics (preferred): A dedicated worker thread performs
 *    the async invoke, signals completion via Atomics.notify, and the main thread
 *    blocks with Atomics.wait.
 *
 * 2. Synchronous XMLHttpRequest to a local Rust HTTP endpoint (fallback): The
 *    Tauri backend exposes a sync-capable HTTP server; XHR blocks until response.
 *
 * 3. In-memory cache (last resort): Pre-fetched data returned from cache; cache
 *    misses throw.
 */

const HEADER_BYTES = 8;     // 4 bytes status + 4 bytes length
const DEFAULT_BUF = 4 * 1024 * 1024; // 4 MiB shared buffer
const TIMEOUT_MS = 30000;

const STATUS_IDLE = 0;
const STATUS_PENDING = 1;
const STATUS_DONE = 2;
const STATUS_ERROR = 3;

let _strategy = null;
let _syncCallImpl = null;
let _cache = new Map();
let _syncHttpPort = null;

// ── Strategy 1: SharedArrayBuffer + Atomics ──────────────────────────────

function _initSharedBufferStrategy() {
  if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') {
    return false;
  }

  const sharedBuf = new SharedArrayBuffer(DEFAULT_BUF);
  const statusArr = new Int32Array(sharedBuf, 0, 2); // [status, dataLength]
  const dataBuf = new Uint8Array(sharedBuf, HEADER_BYTES);

  const workerCode = `
    'use strict';
    const { parentPort, workerData } = require('worker_threads');
    const statusArr = new Int32Array(workerData.sharedBuf, 0, 2);
    const dataBuf = new Uint8Array(workerData.sharedBuf, ${HEADER_BYTES});

    parentPort.on('message', async (msg) => {
      try {
        const result = await globalThis.__tauriInvoke(msg.command, msg.args);
        const encoded = new TextEncoder().encode(JSON.stringify(result));
        if (encoded.byteLength > dataBuf.byteLength) {
          throw new Error('Response too large for shared buffer');
        }
        dataBuf.set(encoded);
        Atomics.store(statusArr, 1, encoded.byteLength);
        Atomics.store(statusArr, 0, ${STATUS_DONE});
        Atomics.notify(statusArr, 0);
      } catch (err) {
        const encoded = new TextEncoder().encode(err.message || String(err));
        const len = Math.min(encoded.byteLength, dataBuf.byteLength);
        dataBuf.set(encoded.subarray(0, len));
        Atomics.store(statusArr, 1, len);
        Atomics.store(statusArr, 0, ${STATUS_ERROR});
        Atomics.notify(statusArr, 0);
      }
    });
  `;

  try {
    const { Worker } = require('worker_threads');
    const worker = new Worker(workerCode, {
      eval: true,
      workerData: { sharedBuf },
    });

    _syncCallImpl = function syncCallViaAtomics(command, args) {
      Atomics.store(statusArr, 0, STATUS_PENDING);
      Atomics.store(statusArr, 1, 0);

      worker.postMessage({ command, args });

      const waitResult = Atomics.wait(statusArr, 0, STATUS_PENDING, TIMEOUT_MS);
      if (waitResult === 'timed-out') {
        throw new Error(`syncCall timed out: ${command}`);
      }

      const status = Atomics.load(statusArr, 0);
      const len = Atomics.load(statusArr, 1);
      const raw = new TextDecoder().decode(dataBuf.slice(0, len));

      if (status === STATUS_ERROR) {
        throw new Error(raw);
      }

      return JSON.parse(raw);
    };

    return true;
  } catch (_e) {
    return false;
  }
}

// ── Strategy 2: Synchronous XHR to local Rust server ─────────────────────

function _initXhrStrategy() {
  if (typeof XMLHttpRequest === 'undefined') return false;

  _syncCallImpl = function syncCallViaXhr(command, args) {
    const port = _syncHttpPort || (globalThis.__sidexSyncPort || 24198);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `http://127.0.0.1:${port}/__sync_invoke`, false);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify({ command, args }));

    if (xhr.status !== 200) {
      throw new Error(`Sync XHR failed (${xhr.status}): ${xhr.responseText}`);
    }

    const response = JSON.parse(xhr.responseText);
    if (response.error) {
      throw new Error(response.error);
    }
    return response.result;
  };

  return true;
}

// ── Strategy 3: Cache-only (last resort) ─────────────────────────────────

function _initCacheStrategy() {
  _syncCallImpl = function syncCallViaCache(command, args) {
    const key = command + ':' + JSON.stringify(args);
    if (_cache.has(key)) {
      return _cache.get(key);
    }
    throw new Error(
      `syncCall cache miss: ${command}(${JSON.stringify(args)}). ` +
      'No SharedArrayBuffer or sync XHR available. Pre-cache this call or use the async API.'
    );
  };
  return true;
}

// ── Public API ───────────────────────────────────────────────────────────

function init(opts) {
  if (opts && opts.syncHttpPort) {
    _syncHttpPort = opts.syncHttpPort;
  }

  if (_initSharedBufferStrategy()) {
    _strategy = 'atomics';
  } else if (_initXhrStrategy()) {
    _strategy = 'xhr';
  } else {
    _initCacheStrategy();
    _strategy = 'cache';
  }
}

function getStrategy() {
  return _strategy;
}

/**
 * Synchronously call a Tauri command. Blocks the calling thread.
 */
function syncInvoke(command, args) {
  if (!_syncCallImpl) {
    init({});
  }
  return _syncCallImpl(command, args);
}

/**
 * Asynchronously call a Tauri command. Returns a Promise.
 */
function asyncInvoke(command, args) {
  const invoke = globalThis.__tauriInvoke || globalThis.__TAURI__?.invoke;
  if (invoke) {
    return invoke(command, args || {});
  }
  return Promise.reject(new Error(`No Tauri invoke available for: ${command}`));
}

/**
 * Pre-populate the sync cache for cache-only strategy or performance.
 */
function cacheSet(command, args, value) {
  const key = command + ':' + JSON.stringify(args);
  _cache.set(key, value);
}

function cacheClear() {
  _cache.clear();
}

module.exports = {
  init,
  getStrategy,
  syncInvoke,
  asyncInvoke,
  cacheSet,
  cacheClear,
  STATUS_IDLE,
  STATUS_PENDING,
  STATUS_DONE,
  STATUS_ERROR,
};
