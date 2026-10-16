'use strict';
/**
 * What the phone bridge keeps: its settings, this computer's keys and the
 * phones paired with it.
 *
 * Settings. Two switches say when the bridge is on: `enabled` (the
 * connection) while the app is open, `service` when it is closed and goes on
 * without its window. Both off, the bridge is off altogether. Whether the
 * app starts with the computer is not kept here: it is what the system
 * holds, written and removed by the user's own switch.
 * All of it is in the local database, and goes under the vault with it.
 *
 * Keys. This computer has an address on I2P (a destination, whose private
 * key is kept here) and a key of its own for the channel (bridge-noise.js).
 * They are made the first time the bridge is turned on and stay the same, so
 * that a paired phone finds the computer again; "forget everything" makes
 * new ones, and every phone has to be paired again.
 *
 * Devices. A phone is its channel key, the key it reads this computer's
 * address with, and a name. Removing a phone takes both away: it can no
 * longer open a session, nor find where the computer is.
 */
const { randomUUID } = require('node:crypto');

const MODES = ['embedded', 'external'];
const BANDWIDTHS = ['L', 'O', 'P', 'X'];
const DEFAULTS = Object.freeze({
  enabled: false,
  service: false,
  mode: 'embedded',
  host: '127.0.0.1',
  port: 7656,
  user: '',
  password: '',
  transit: true,
  bandwidth: 'O',
  name: '',
  // The way on the local network, beside I2P (bridge-lan.js): off until the user turns it on.
  lan: false,
  // How long the I2P tunnels are, in routers of the network between each side and the other: one, unless the user
  // asks for more. One hop is what makes a request take a fraction of what three take; three is the cover I2P is
  // known for. No server of anyone's and no way opened through the routers, whatever the number.
  hops: 1
});
const HOPS = [1, 2, 3];

const now = () => new Date().toISOString();

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

class BridgeStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_keys (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bridge_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT '',
        public_key TEXT NOT NULL UNIQUE,
        reader_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT
      );
    `);
  }

  /** The settings as they are used: what was chosen over what they start out with. */
  settings() {
    let saved = {};
    try { saved = JSON.parse(this.store.getSetting('bridge') || '{}') || {}; } catch {}
    return this.clean({ ...DEFAULTS, ...saved });
  }

  clean(input) {
    const port = Math.floor(Number(input.port));
    return {
      enabled: input.enabled === true,
      service: input.service === true,
      lan: input.lan === true,
      hops: HOPS.includes(Math.floor(Number(input.hops))) ? Math.floor(Number(input.hops)) : DEFAULTS.hops,
      mode: MODES.includes(input.mode) ? input.mode : DEFAULTS.mode,
      host: String(input.host || DEFAULTS.host).trim().slice(0, 200) || DEFAULTS.host,
      port: port > 0 && port < 65536 ? port : DEFAULTS.port,
      user: String(input.user || '').slice(0, 200),
      password: String(input.password || '').slice(0, 200),
      transit: input.transit !== false,
      bandwidth: BANDWIDTHS.includes(input.bandwidth) ? input.bandwidth : DEFAULTS.bandwidth,
      name: String(input.name || '').trim().slice(0, 60)
    };
  }

  /** Only what differs from the defaults is written. */
  saveSettings(change) {
    const next = this.clean({ ...this.settings(), ...change });
    const kept = {};
    for (const key of Object.keys(DEFAULTS)) if (next[key] !== DEFAULTS[key]) kept[key] = next[key];
    this.store.setSetting('bridge', Object.keys(kept).length ? JSON.stringify(kept) : null);
    return next;
  }

  key(name) {
    return this.db.prepare('SELECT value FROM bridge_keys WHERE name=?').get(name)?.value || null;
  }

  setKey(name, value) {
    this.db.prepare(`INSERT INTO bridge_keys(name, value, created_at) VALUES(?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET value=excluded.value, created_at=excluded.created_at`).run(name, value, now());
  }

  devices() {
    return this.db.prepare('SELECT * FROM bridge_devices ORDER BY created_at').all();
  }

  device(id) {
    return this.db.prepare('SELECT * FROM bridge_devices WHERE id=?').get(String(id)) || null;
  }

  deviceByKey(publicKey) {
    return this.db.prepare('SELECT * FROM bridge_devices WHERE public_key=?').get(publicKey) || null;
  }

  /** A phone that has just been paired. One that pairs again takes its old place. */
  addDevice({ name, platform, publicKey, readerKey }) {
    const label = String(name || '').trim().slice(0, 60) || 'Telefono';
    const old = this.deviceByKey(publicKey);
    if (old) {
      this.db.prepare('UPDATE bridge_devices SET name=?, platform=?, reader_key=?, last_seen_at=? WHERE id=?')
        .run(label, String(platform || '').slice(0, 40), readerKey, now(), old.id);
      return this.device(old.id);
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO bridge_devices(id, name, platform, public_key, reader_key, created_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(id, label, String(platform || '').slice(0, 40), publicKey, readerKey, now(), now());
    return this.device(id);
  }

  renameDevice(id, name) {
    const label = String(name || '').trim().slice(0, 60);
    if (!label) fail('Nome mancante.');
    if (!this.device(id)) fail('Dispositivo non trovato.', 404);
    this.db.prepare('UPDATE bridge_devices SET name=? WHERE id=?').run(label, String(id));
    return this.device(id);
  }

  seen(id) {
    this.db.prepare('UPDATE bridge_devices SET last_seen_at=? WHERE id=?').run(now(), String(id));
  }

  removeDevice(id) {
    if (!this.device(id)) fail('Dispositivo non trovato.', 404);
    this.db.prepare('DELETE FROM bridge_devices WHERE id=?').run(String(id));
  }

  /** New keys, no phones: what was paired before no longer finds this computer. */
  forget() {
    this.db.exec('DELETE FROM bridge_devices; DELETE FROM bridge_keys;');
  }
}

module.exports = { BridgeStore, DEFAULTS, MODES, BANDWIDTHS, HOPS };
