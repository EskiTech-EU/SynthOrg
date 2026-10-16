'use strict';
/**
 * What changed in the archive, for the page to show it.
 *
 * The page on this computer writes the archive through the service; a paired
 * phone writes its own copy and its rows arrive here (replica.js). Every
 * write that succeeds is noted with a number that only grows, who made it
 * (`desktop`, or `phone:<id>`) and, when it is small, what it gave back, so
 * the page can show what it did not write itself without asking again. The
 * page waits for the next numbers with `wait`.
 *
 * The numbers start again with the service: `epoch` changes with it, and a
 * page that holds numbers of another epoch, or older than the oldest kept,
 * reads everything again.
 */
const { randomBytes } = require('node:crypto');

const KEPT = 2000;
const DATA_MOST = 32 * 1024;
const WAIT_MOST = 25000;

// Requests that write nothing of what is shown: they ask something of the archive, or of a container.
const QUIET = [
  /^\/api\/bridge(\/|$)/,
  /^\/api\/security(\/|$)/,
  /^\/api\/changes(\/|$)/,
  /^\/api\/conversations\/[^/]+\/context$/,
  /^\/api\/conversations\/[^/]+\/tools\//,
  /^\/api\/conversations\/[^/]+\/desktop\/(act|screen|status)$/,
  /^\/api\/conversations\/[^/]+\/sandbox\/(exec|interrupt)$/,
  /^\/api\/local-models\//,
  /^\/api\/projects\/[^/]+\/terminal\/gate$/,
  /^\/api\/usage\/share\/package$/
];

class Sync {
  constructor() {
    this.epoch = randomBytes(6).toString('hex');
    this.rev = 0;
    this.log = [];
    this.waiters = new Set();
    this.listeners = new Set();
  }

  /** Whether a write to this path is something the other side shows. */
  noted(method, path) {
    return method !== 'GET' && method !== 'OPTIONS' && path.startsWith('/api/') && !QUIET.some(pattern => pattern.test(path));
  }

  /** The thing a write is about: the path, and the id in what was sent when the path names a collection. */
  key(path, input) {
    const id = input && typeof input === 'object' && typeof input.id === 'string' ? input.id : '';
    return id && !path.endsWith(`/${id}`) ? `${path}#${id}` : path;
  }

  /** A write that succeeded. */
  record({ method, path, key, origin, result }) {
    let data;
    if (result !== undefined) {
      const text = JSON.stringify(result);
      if (text !== undefined && text.length <= DATA_MOST) data = result;
    }
    const change = { rev: ++this.rev, method, path, key, origin, ...(data === undefined ? {} : { data }) };
    this.log.push(change);
    if (this.log.length > KEPT) this.log.splice(0, this.log.length - KEPT);
    for (const wake of [...this.waiters]) wake();
    for (const listener of this.listeners) {
      try { listener(change); } catch {}
    }
    return change;
  }

  /** What was written after `after`, or `reset` when that number is no longer known. */
  since(epoch, after) {
    const from = Number(after) || 0;
    const lost = this.log.length > 0 && from < this.log[0].rev - 1;
    if (epoch !== this.epoch || from > this.rev || lost) {
      return { epoch: this.epoch, rev: this.rev, reset: true, changes: [] };
    }
    return { epoch: this.epoch, rev: this.rev, reset: false, changes: this.log.filter(change => change.rev > from) };
  }

  /** The same, waiting up to `waitMs` for something new. */
  wait(epoch, after, waitMs = 0, onGone = null) {
    const now = this.since(epoch, after);
    if (now.reset || now.changes.length || waitMs <= 0) return Promise.resolve(now);
    return new Promise(resolve => {
      let timer = null;
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(this.since(epoch, after));
      };
      timer = setTimeout(wake, Math.min(waitMs, WAIT_MOST));
      this.waiters.add(wake);
      onGone?.(() => { clearTimeout(timer); this.waiters.delete(wake); });
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

module.exports = { Sync };
