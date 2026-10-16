'use strict';
/**
 * What a paired phone asks of this computer's service.
 *
 * The phone keeps the archive whole and runs its rules itself: what is done
 * there is written there, at once. `sync` is the exchange of the rows each
 * side wrote (replica.js): the phone sends its own and how far it has
 * received, this side writes them, tells the page, and answers with its own.
 * What is written here goes to the phones connected by itself, as the event
 * `sync`, a moment after it is written.
 *
 * `api` is for what only this computer has: the containers of the chats and
 * their files, the Code projects, the web, the models installed. The phone's
 * request goes to the local service as if it came from the page, with the
 * session token, and its answer comes back, bytes included (a picture, a
 * file of a chat). `snapshot` answers many of those readings at once: on I2P
 * every request costs a second or two there and back, whatever its size.
 * Each answer has a tag (a hash of it); the phone sends the tags of the
 * copies it keeps, and only what differs travels.
 *
 * Secrets stay here: the API keys and the bridge's own settings are never
 * sent to a phone, in a row or in an answer, nor written from one.
 *
 * What only this computer's shell can do (the vault's keys, turning the
 * service off) and the bridge's own traffic are not reachable from here.
 */
const http = require('node:http');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { changesOf } = require('./replica');

// The phone answers are one message of the bridge: at most 24 MB, the header included.
const BODY_MOST = 20 * 1024 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;

const CLOSED = [
  /^\/api\/shutdown$/,
  /^\/api\/bridge(\/|$)/,
  /^\/api\/changes(\/|$)/,
  /^\/api\/import$/
];

const SNAPSHOT_MOST = 120;
// What a phone reads in place of a secret that is set.
const HELD = 'sul-computer';
const SETTING = /^\/api\/settings\/([^/?]+)$/;
const secret = (key) => key === 'bridge' || /(_api_key|_token|_secret|_password)$/i.test(key);

/** The settings as a phone may read them. */
function withoutSecrets(path, data) {
  if (!data || typeof data !== 'object') return data;
  if (path === '/api/settings') {
    const shown = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === 'bridge') continue;
      shown[key] = secret(key) && value ? HELD : value;
    }
    return shown;
  }
  const match = SETTING.exec(path);
  if (match && secret(decodeURIComponent(match[1])) && 'value' in data) return { ...data, value: data.value ? HELD : data.value };
  return data;
}

const tagOf = (data) => createHash('sha256').update(JSON.stringify(data ?? null)).digest('hex').slice(0, 16);

class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function allowed(method, path) {
  if (!/^\/api\/[^?#]*$/.test(path) || path.includes('..')) return false;
  if (CLOSED.some(pattern => pattern.test(path))) return false;
  // The vault is opened and closed by the shell, which holds its keys: the phone sees its state only.
  if (/^\/api\/security(\/|$)/.test(path)) return method === 'GET';
  return true;
}

const pack = (value) => zlib.gzipSync(Buffer.from(JSON.stringify(value)));

/**
 * The requests. `port` and `token` are those of the running service;
 * `sync` the record of writes the page follows, `store` the archive (null
 * while the vault is closed), `onApplied` what else is done when rows of a
 * phone are written here.
 */
function archiveMethods({ port, token, sync, store = () => null, onApplied = null }) {
  const api = (device, params = {}) => new Promise((resolve, reject) => {
    const method = String(params.method || 'GET').toUpperCase();
    const target = String(params.path || '');
    const [path, query = ''] = target.split('?');
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return reject(new Refusal('bad_request', 'Metodo non valido.'));
    if (!allowed(method, path)) return reject(new Refusal('forbidden', 'Richiesta non consentita dal telefono.'));
    const setting = SETTING.exec(path);
    if (method !== 'GET' && setting && secret(decodeURIComponent(setting[1]))) return reject(new Refusal('forbidden', 'Questa impostazione si cambia solo dal computer.'));
    const payload = ['POST', 'PUT', 'PATCH'].includes(method) ? Buffer.from(JSON.stringify(params.body && typeof params.body === 'object' ? params.body : {})) : null;
    const headers = {
      Host: `127.0.0.1:${port()}`,
      Authorization: `Bearer ${token}`,
      'X-Synthorg-Origin': `phone:${device}`
    };
    if (params.range) headers.Range = String(params.range).slice(0, 100);
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const request = http.request({ host: '127.0.0.1', port: port(), method, path: query ? `${path}?${query}` : path, headers, timeout: TIMEOUT_MS }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > BODY_MOST) { response.destroy(); reject(new Refusal('too_big', 'Risposta troppo grande per il telefono.')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const type = String(response.headers['content-type'] || '');
        const head = { status: response.statusCode, type };
        for (const name of ['content-range', 'content-disposition', 'accept-ranges']) {
          if (response.headers[name]) head[name] = response.headers[name];
        }
        if (type.startsWith('application/json')) {
          let data = null;
          try { data = bytes.length ? JSON.parse(bytes.toString('utf8')) : null; } catch {}
          if (method === 'GET') {
            data = withoutSecrets(path, data);
            if (response.statusCode === 200) head.tag = tagOf(data);
          }
          resolve({ result: { ...head, data }, body: null });
        } else {
          resolve({ result: head, body: bytes });
        }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Refusal('timeout', 'Il computer non ha risposto in tempo.')));
    request.on('error', error => reject(error instanceof Refusal ? error : new Refusal('unavailable', error.message)));
    if (payload) request.write(payload);
    request.end();
  });

  /**
   * The exchange of rows with a phone. `params`: `{ site, to, have, after, upto }`
   * and, in the bytes, `{ rows }` compressed. Answered the same way.
   */
  const exchange = async (device, params = {}, body = null) => {
    const archive = store();
    if (!archive) throw new Refusal('locked', 'L\'archivio del computer è chiuso: va aperto dal computer.');
    let rows = [];
    if (body && body.length) {
      try { rows = JSON.parse(zlib.gunzipSync(body).toString('utf8')).rows || []; } catch { throw new Refusal('bad_request', 'Righe non valide.'); }
    }
    const { applied, rows: mine, ...head } = archive.replica().receive(device, { ...params, rows });
    if (applied.length) {
      // The page shows what the phone did, as if it had been done here.
      for (const change of changesOf(applied)) sync.record({ method: change.method, path: change.path, key: change.path, origin: `phone:${device}`, result: change.data });
      try { onApplied?.(applied); } catch {}
    }
    return { result: { ...head, count: mine?.length || 0 }, body: pack({ rows: mine || [] }) };
  };

  /**
   * Many readings in one message. `items`: `[{ path, tag }]`, the tag being
   * that of the copy the phone keeps. Answered: `{ path, same: true }` for a
   * copy still good, `{ path, status, type, tag, data }` for what differs,
   * `{ path, status }` for what is not there or is not JSON. The list goes
   * compressed, in the bytes of the message.
   */
  const snapshot = async (device, params = {}) => {
    const asked = (Array.isArray(params.items) ? params.items : []).slice(0, SNAPSHOT_MOST)
      .map(item => ({ path: String(item?.path || ''), tag: String(item?.tag || '') }))
      .filter(item => item.path);
    const items = await Promise.all(asked.map(async ({ path, tag }) => {
      try {
        const { result } = await api(device, { method: 'GET', path });
        if (result.status !== 200 || !result.tag) return { path, status: result.status };
        if (result.tag === tag) return { path, same: true };
        return { path, status: 200, type: result.type, tag: result.tag, data: result.data };
      } catch (error) {
        return { path, status: error.code === 'forbidden' ? 403 : 502 };
      }
    }));
    const packed = pack({ items });
    return { result: { encoding: 'gzip', count: items.length, changed: items.filter(item => item.data !== undefined).length }, body: packed };
  };

  return { api, snapshot, sync: exchange };
}

/**
 * What is written here goes to the phones connected, a moment after: the
 * rows, as the event `sync`. While a message is being written it is saved
 * again and again, and a row travels as it is when it leaves. A phone that
 * never exchanged anything asks first (`sync`), and is told from there on.
 */
function tellPhones({ bridge, sync, store, everyMs = 250, checkMs = 3000 }) {
  let timer = null;
  let running = false;
  let again = false;
  const tell = async () => {
    timer = null;
    if (running) { again = true; return; }
    running = true;
    try {
      for (const device of [...(bridge.connections?.keys() || [])]) {
        for (let turn = 0; turn < 50; turn += 1) {
          const replica = store()?.replica();
          if (!replica) return;
          const peer = replica.peer(device);
          if (!peer.site) break;
          const out = replica.collect(device, peer.sent);
          // Nothing for this phone: only what stays here was written.
          if (out.upto <= peer.sent || (!out.rows.length && !out.more)) break;
          const { sent } = await bridge.send({
            device,
            header: { t: 'evt', name: 'sync', data: { site: replica.site(), after: peer.sent, upto: out.upto, more: out.more, count: out.rows.length } },
            body: pack({ rows: out.rows }).toString('base64')
          });
          if (!sent) break;
          // The phone may have asked meanwhile: where it says it is counts, never further back than this.
          const now = replica.peer(device);
          if (now.site === peer.site) replica.savePeer({ ...now, sent: Math.max(now.sent, out.upto) });
          if (!out.more) break;
        }
      }
    } catch {} finally {
      running = false;
      if (again) { again = false; soon(); }
    }
  };
  const soon = () => {
    if (timer || !bridge.connections?.size) return;
    // On I2P a message costs a second or two, so what is written in the next moment goes with it; on the local
    // network it costs nothing, and a phone there is told at once.
    const local = [...bridge.connections.values()].some(connection => connection.via === 'lan');
    timer = setTimeout(tell, local ? Math.min(everyMs, 30) : everyMs);
    if (timer.unref) timer.unref();
  };
  const off = sync.on(soon);
  // What is written without a request of the page (the steps of a project, a job of the service).
  const check = setInterval(soon, checkMs);
  if (check.unref) check.unref();
  return () => { off(); clearInterval(check); clearTimeout(timer); };
}

module.exports = { archiveMethods, tellPhones, allowed, Refusal, HELD };
