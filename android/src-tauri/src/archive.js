/*
 * The archive on the phone: the computer's own files (computer/server), run
 * as they are.
 *
 * archive.rs gives this file their sources (`__sources`) and four functions
 * on the phone's SQLite (`__sql_exec`, `__sql_all`, `__sql_run`) and on the
 * system (`__random`, `__sha256`). Here they are made to look like what those
 * files ask of Node (`node:sqlite`, `node:crypto`, `node:fs`, `node:path`),
 * and the archive is opened. archive.rs then calls `__call(name, json)`:
 * a request of the page, or a step of the exchange with the computer.
 */
(function () {
  'use strict';

  class Statement {
    constructor(sql) { this.sql = sql; }
    all(...args) { return JSON.parse(__sql_all(this.sql, JSON.stringify(args))); }
    get(...args) { return this.all(...args)[0]; }
    run(...args) { return JSON.parse(__sql_run(this.sql, JSON.stringify(args))); }
  }

  // One database, opened by archive.rs: the name given is not used.
  class DatabaseSync {
    constructor(filename, options = {}) {
      this.isOpen = true;
      if (options.enableForeignKeyConstraints) __sql_exec('PRAGMA foreign_keys = ON');
    }
    prepare(sql) { return new Statement(sql); }
    exec(sql) { __sql_exec(sql); }
    close() { this.isOpen = false; }
  }

  const bytes = (count) => {
    const hex = __random(count);
    const list = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) list[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    list.toString = (encoding) => (encoding === 'hex' ? hex : Array.prototype.join.call(list, ','));
    return list;
  };

  const builtins = {
    'node:sqlite': { DatabaseSync },
    'node:crypto': {
      randomBytes: bytes,
      randomUUID() {
        const b = bytes(16);
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        const hex = Array.from(b, value => value.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      },
      createHash(kind) {
        if (kind !== 'sha256') throw new Error(`hash non disponibile: ${kind}`);
        let text = '';
        const hash = { update(part) { text += String(part); return hash; }, digest() { return __sha256(text); } };
        return hash;
      }
    },
    'node:fs': { mkdirSync() {} },
    'node:path': { dirname: (path) => String(path).replace(/[\\/][^\\/]*$/, '') }
  };

  const process = { env: {} };
  const modules = {};
  function require(name) {
    if (builtins[name]) return builtins[name];
    const key = String(name).replace(/^\.\//, '').replace(/\.js$/, '');
    if (modules[key]) return modules[key].exports;
    const source = __sources[key];
    if (source === undefined) throw new Error(`modulo mancante: ${name}`);
    const module = modules[key] = { exports: {} };
    new Function('require', 'module', 'exports', 'process', source)(require, module, module.exports, process);
    return module.exports;
  }

  const { Store } = require('./database');
  const { route } = require('./archive-api');
  const { changesOf } = require('./replica');

  let store = null;
  const archive = () => {
    if (!store) throw Object.assign(new Error('Archivio non aperto.'), { status: 503 });
    return store;
  };

  const calls = {
    /** `recover`: an answer this phone left unfinished is marked so. */
    open({ recover }) {
      store = new Store('phone', { recover: Boolean(recover), wins: false });
      return { site: store.replica().site() };
    },

    /** A request of the page. `handled: false`: not the archive's, the computer is asked. */
    request({ method, path, query, body }) {
      const parts = String(path).split('/').filter(Boolean);
      // Longer than any request of the archive: a file in a chat's workspace, which the computer has.
      if (parts.length > 5) return { handled: false };
      let input = {};
      if (['POST', 'PUT', 'PATCH'].includes(method)) {
        input = body === null || body === undefined ? {} : body;
        if (typeof input !== 'object' || Array.isArray(input)) return { handled: true, status: 400, data: { error: 'Oggetto JSON necessario.' } };
      }
      try {
        const answered = route(archive(), { method, parts, query: (key) => (Object.hasOwn(query || {}, key) ? query[key] : null), input }, {});
        // Sharing the numbers of the costs goes out through the computer's service: not offered from the phone.
        if (parts[1] === 'usage' && parts[2] === 'share') {
          if (!answered) return { handled: true, status: 404, data: { error: 'La condivisione dei consumi si fa dal computer.' } };
          if (method === 'GET' && !parts[3]) return { handled: true, status: 200, data: { ...answered.result, ready: false, due: false } };
        }
        if (!answered) return { handled: false };
        return { handled: true, status: 200, data: answered.result === undefined ? null : answered.result };
      } catch (error) {
        if (error && error.status) return { handled: true, status: error.status, data: { error: error.message } };
        return { handled: true, status: 500, data: { error: 'Impossibile completare l’operazione sul database.' }, detail: String((error && error.stack) || error) };
      }
    },

    /** What this phone has for the computer, with where the exchange has got to. */
    offer({ peer }) { return archive().replica().offer(peer); },

    /** The computer's answer, or what it sent by itself: written here, and given back as what the page shows again. */
    answered({ peer, answer }) {
      const took = archive().replica().answered(peer, answer);
      return { reset: took.reset, gap: Boolean(took.gap), more: Boolean(took.more), changes: changesOf(took.applied) };
    },

    /** How many rows wait to be sent to the computer. */
    waiting({ peer }) { return { rows: archive().replica().waiting(peer) }; },

    /** Unpaired: the archive stays, the exchange with that computer is forgotten. */
    forget({ peer }) { archive().replica().forgetPeer(peer); return {}; }
  };

  globalThis.__call = (name, text) => {
    try {
      const call = calls[name];
      if (!call) throw new Error(`chiamata sconosciuta: ${name}`);
      return JSON.stringify({ ok: true, value: call(JSON.parse(text)) });
    } catch (error) {
      return JSON.stringify({ ok: false, status: (error && error.status) || 500, message: String((error && error.message) || error), detail: String((error && error.stack) || '') });
    }
  };
})();
