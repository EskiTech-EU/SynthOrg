'use strict';
/**
 * The bridge between a phone and this app.
 *
 * It is off until the user turns it on, with two switches: the connection,
 * for while the app is open, and the service, for when the app is closed
 * and goes on without its window. It never outlives the app: the router it
 * starts, the address it holds on I2P and every connection end with it.
 *
 * How a phone gets in. The user opens a pairing on this computer: a code is
 * shown once, as a QR code, for three minutes. It carries the address of this
 * computer on I2P, the key that address is read with (made for that phone
 * alone), this computer's channel key and a secret used once. The phone
 * reaches the address through I2P and proves it has seen the code; from then
 * on it is known by its own key, and the code is worth nothing.
 *
 * What passes. The phone asks (requests) and is told (events); this service
 * carries the messages and answers nothing itself but a ping. What the
 * phone asks is done by the page, where the assistant and the chats are: the
 * page takes the requests from `inbox` and gives back answers and events
 * through `send`. A phone that asks while no page is there is told so.
 *
 * Which way. I2P is how a phone finds this computer across the internet,
 * and the only way there: no server of anyone's in between, no way opened
 * through the routers. Its tunnels are one hop long unless the user asks for
 * more (setting `hops`): one router of the network between each side and the
 * other, which is what makes a request take a fraction of what three hops
 * take, at the price of less cover of who talks to whom. One faster way can
 * be turned on, with its own setting, a second channel with the same
 * handshake and the keys of the pairing: `lan`, a phone on the same local
 * network connecting straight to this computer's private address
 * (bridge-lan.js), which does not need the I2P channel to be up. That
 * channel carries the traffic; the I2P one is kept aside, and takes over
 * when the faster one falls.
 */
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { BridgeRouter } = require('./bridge-router');
const { respond, generateStatic, publicOf } = require('./bridge-noise');
const { base32 } = require('./bridge-sam');
const { Lan } = require('./bridge-lan');

/** Whether a channel came a faster way than I2P. */
const fast = (via) => via === 'lan';

const PROTOCOL = 1;
const PAIRING_MS = 180000;
const PAIRING_TRIES = 5;
// A phone that says nothing for this long is taken as gone: it is asked to say something (a ping) well within it.
const IDLE_MS = 120000;
const KEEPALIVE_MS = 45000;
// A faster channel (the local network) is given up sooner when it goes quiet: the phone pings it every few
// seconds, and what the computer says must not go on being sent where nobody listens.
const FAST_IDLE_MS = 25000;
const FAST_KEEPALIVE_MS = 8000;
// What a phone asks over the I2P channel even while a faster one carries the traffic.
const ASIDE = new Set(['ping', 'lan.offer']);
const PAGE_AWAY_MS = 45000;
const POLL_MOST_MS = 25000;
const QUEUE_MOST = 500;
const ACCEPTORS = 2;
const RETRY_MS = [5000, 15000, 60000];
// A router that has held a session on this computer's address does not give a
// working one on the same address again: made at once, the new session is
// handed the old destination with its old readers and loses it seconds later
// (a phone being paired never finds the address, "LeaseSet not found"); made
// later, the address is found but no stream is answered for minutes. Measured
// on i2pd 2.60. So the readers of the address never change under a running
// router: when they must (a pairing opened or withdrawn, a phone removed) the
// router is started again, which takes a second and keeps what it knows of
// the network.

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

const code32 = (bytes) => base32(bytes).toUpperCase();

class Bridge {
  constructor({ store, router = null, version = '', pairingMs = PAIRING_MS, idleMs = IDLE_MS, retryMs = RETRY_MS, local = {}, lan = null }) {
    this.store = store;
    // Requests the service answers itself, without the page: the archive (bridge-api.js).
    this.local = local;
    this.router = router || new BridgeRouter();
    this.version = version;
    this.pairingMs = pairingMs;
    this.idleMs = idleMs;
    this.retryMs = retryMs;
    this.addressUsed = false; // the running router has held a session on this computer's address
    this.phase = 'off';       // off | router | tunnels | ready | error
    this.error = '';
    this.session = null;
    this.linked = 0;          // goes up at every new session: what belongs to an older one stops
    this.connections = new Map();   // device id -> the connection its traffic goes on
    this.standby = new Map();       // device id -> its I2P connection, kept aside while a faster one carries the traffic
    this.lan = lan || new Lan();
    this.pairing = null;
    this.queue = [];
    this.pollers = new Set();
    this.attended = 0;
    this.windowOpen = true;   // the app has its window; without it, it is the service that keeps the bridge on
    this.held = false;        // kept on for a pairing, and for the phone just paired, whatever the switches say of now
    this.work = Promise.resolve();
    this.retries = 0;
    this.retryTimer = null;
    this.router.onExit = () => this.lost('Il router I2P si è fermato.');
  }

  /** What the bridge keeps, or null while the database is locked or being closed. */
  db() {
    try {
      const store = this.store();
      return store && store.db.isOpen !== false ? store.bridge() : null;
    } catch {
      return null;
    }
  }

  /** One change at a time: starting, stopping and linking never overlap. */
  run(task) {
    const next = this.work.then(task, task);
    this.work = next.catch(() => {});
    return next;
  }

  name() {
    return this.db()?.settings().name || os.hostname() || 'SynthOrg';
  }

  /* ---------------------------------------------------------------- */
  /* On and off                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Brings the bridge to what the settings say, given that the database may
   * have just been locked or unlocked: on if it is to be on and can be, off
   * if the database is no longer there.
   */
  follow() {
    if (this.shuttingDown) return;
    const db = this.db();
    if (!db) {
      if (this.phase !== 'off') this.stop().catch(() => {});
      return;
    }
    const wanted = this.wanted(db.settings());
    if (wanted && this.phase === 'off') this.start().catch(() => {});
    else if (!wanted && this.phase !== 'off') this.stop().catch(() => {});
    this.followLan();
  }

  /**
   * The local network's way, brought to what the settings say: listening
   * while the bridge is to be on, the setting is, and there is a phone to
   * come in; closed otherwise, with the channels that were on it.
   */
  followLan() {
    const db = this.db();
    const settings = db?.settings();
    const on = Boolean(db && !this.shuttingDown && settings.lan && this.wanted(settings) && db.devices().length && db.key('static_private'));
    if (!on) {
      if (this.lan.on) this.lan.stop();
      for (const connection of [...this.connections.values()]) if (connection.via === 'lan') this.detach(connection, 'lan_off');
      return;
    }
    const kept = Number(db.key('lan_port')) || 0;
    this.lan.start(socket => { this.greet(socket, null, 'lan').catch(() => {}); }, {
      port: kept,
      onPort: (port) => { try { if (port && Number(this.db()?.key('lan_port')) !== port) this.db()?.setKey('lan_port', String(port)); } catch {} }
    }).catch(() => {});
  }

  /** Whether the bridge is to be on now: the connection with the window open, the service without it. */
  wanted(settings) {
    if (this.held && (settings.enabled || settings.service)) return true;
    return this.windowOpen ? settings.enabled : settings.service;
  }

  /** The pairing is over and the phone it brought is gone: the switches decide again. */
  release() {
    if (!this.held || this.pairing || this.connections.size) return;
    this.held = false;
    this.follow();
  }

  /** The window was closed and the app goes on, or it is back. */
  setWindow(open) {
    this.windowOpen = open !== false;
    this.follow();
    return this.status();
  }

  async configure(change) {
    const db = this.db();
    if (!db) fail('Il database è bloccato.', 423);
    const before = db.settings();
    const after = db.saveSettings(change || {});
    // The tunnels' length is set when the session is made: a change makes everything again.
    const routerChanged = ['mode', 'host', 'port', 'user', 'password', 'transit', 'bandwidth', 'hops'].some(key => before[key] !== after[key]);
    if (!this.wanted(after)) await this.stop();
    else if (this.phase === 'off' || this.phase === 'error' || routerChanged) await this.start();
    this.followLan();
    // The phones may open the local way now, rather than at their next try.
    if (after.lan && !before.lan) {
      for (const connection of this.connections.values()) connection.channel.send({ t: 'evt', name: 'lan', data: { allowed: true } }).catch(() => {});
    }
    return this.status();
  }

  start() {
    return this.run(async () => {
      const db = this.db();
      if (!db) fail('Il database è bloccato.', 423);
      await this.startNow(db);
    });
  }

  /** The start itself, for who already has the turn. */
  async startNow(db) {
    {
      await this.halt();
      clearTimeout(this.retryTimer);
      const settings = db.settings();
      this.error = '';
      this.setPhase('router');
      try {
        const sam = await this.router.start(settings);
        if (!db.key('static_private')) db.setKey('static_private', generateStatic().privateKey.toString('hex'));
        if (!db.key('destination_private')) db.setKey('destination_private', await sam.generate());
        await this.link();
        this.retries = 0;
      } catch (error) {
        if (this.shuttingDown) return;
        await this.halt();
        this.error = error.message;
        this.setPhase('error');
        throw error;
      }
    }
  }

  stop() {
    return this.run(async () => {
      clearTimeout(this.retryTimer);
      this.retries = 0;
      this.dropAll();
      await this.halt();
      this.error = '';
      this.setPhase('off');
      this.followLan();
    });
  }

  /**
   * The app is closing: everything is closed now, without waiting behind a
   * start still building its tunnels (that may take a minute); the start
   * then fails on its own and nothing is tried again.
   */
  async shutdown() {
    this.shuttingDown = true;
    clearTimeout(this.retryTimer);
    this.lan.stop();
    this.dropAll();
    await this.halt();
    this.phase = 'off';
  }

  /** Every channel closed, whichever way it came. */
  dropAll() {
    for (const connection of [...this.standby.values()]) this.detach(connection, 'closed');
    for (const connection of [...this.connections.values()]) this.detach(connection, 'closed');
  }

  /** The channels that came through I2P closed: the faster ones, once open, do not depend on it. */
  dropI2p() {
    for (const connection of [...this.standby.values()]) this.detach(connection, 'closed');
    for (const connection of [...this.connections.values()]) if (!fast(connection.via)) this.detach(connection, 'closed');
  }

  /** Everything of I2P closed, without saying what comes next. */
  async halt() {
    this.linked++;
    this.closePairingNow();
    this.dropI2p();
    if (this.session) { this.session.close(); this.session = null; }
    await this.router.stop();
    this.addressUsed = false;
  }

  /** The router or the session went away by itself: said, and tried again a few times. */
  lost(reason) {
    if (this.shuttingDown || this.phase === 'off' || this.phase === 'error' || this.phase === 'router') return;
    this.run(async () => {
      await this.halt();
      this.error = reason;
      this.setPhase('error');
      const wait = this.retryMs[this.retries];
      if (wait === undefined) return;
      this.retries++;
      this.retryTimer = setTimeout(() => { if (this.phase === 'error') this.start().catch(() => {}); }, wait);
      if (this.retryTimer.unref) this.retryTimer.unref();
    });
  }

  /**
   * The session on this computer's address, readable by the paired phones
   * and by the one being paired. With nobody to read it there is no session:
   * the computer is nowhere to be found.
   */
  async link() {
    const db = this.db();
    const sam = this.router.sam;
    if (!db || !sam) fail('Il ponte non è avviato.', 409);
    const linked = ++this.linked;
    this.dropI2p();
    if (this.session) { this.session.close(); this.session = null; }
    const readers = db.devices().map(device => ({ name: 'd' + device.id.replace(/-/g, '').slice(0, 12), publicKey: Buffer.from(device.reader_key, 'hex') }));
    if (this.pairing) readers.push({ name: 'pairing', publicKey: this.pairing.reader.publicKey });
    if (!readers.length) { this.setPhase('ready'); return; }
    this.setPhase('tunnels');
    let router = sam;
    if (this.addressUsed) {
      router = await this.router.start(db.settings());
      if (linked !== this.linked) return;
    }
    this.addressUsed = true;
    const session = await router.session({
      privateKey: db.key('destination_private'),
      readers,
      hops: db.settings().hops,
      onClose: () => { if (this.session === session) this.lost('Il router I2P ha chiuso la sessione.'); }
    });
    if (linked !== this.linked) { session.close(); return; }
    this.session = session;
    this.setPhase('ready');
    for (let i = 0; i < ACCEPTORS; i++) this.acceptLoop(session);
  }

  async acceptLoop(session) {
    while (this.session === session && !session.closed) {
      let stream;
      try {
        stream = await session.accept();
      } catch {
        if (this.session !== session || session.closed) return;
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      this.greet(stream.socket, session).catch(() => {});
    }
  }

  /**
   * A stream that has just arrived: the handshake, then a pairing or a
   * session. On the faster way (`via` 'lan') only the session of a phone
   * already paired is let in: a pairing is made on I2P.
   */
  async greet(socket, session, via = 'i2p') {
    const db = this.db();
    if (!db) { socket.destroy(); return; }
    const privateKey = Buffer.from(db.key('static_private'), 'hex');
    const pairing = fast(via) ? null : this.pairing;
    let opened;
    try {
      opened = await respond(socket, {
        staticKey: { privateKey, publicKey: publicOf(privateKey) },
        pairingSecret: () => (pairing && this.pairing === pairing && Date.now() < pairing.expiresAt ? pairing.secret : null),
        allowed: key => {
          const device = this.db()?.deviceByKey(key.toString('hex'));
          return Boolean(device);
        }
      });
    } catch (error) {
      socket.destroy();
      // Guesses at the secret close the pairing: the code has to be shown again.
      if (pairing && this.pairing === pairing && error.code === 'BRIDGE_CHANNEL' && ++pairing.failures >= PAIRING_TRIES) this.closePairing().catch(() => {});
      return;
    }
    const refused = via === 'lan' ? (!this.lan.on || opened.kind === 'pairing') : this.session !== session;
    if (refused) { opened.channel.close(); return; }
    const key = opened.channel.remoteStatic.toString('hex');
    let device;
    if (opened.kind === 'pairing') {
      device = db.addDevice({ name: opened.payload.name, platform: opened.payload.platform, publicKey: key, readerKey: pairing.reader.publicKey.toString('hex') });
      // Used: the code is worth nothing from now on. Its reading key stays in the session as the phone's own.
      clearTimeout(pairing.timer);
      this.pairing = null;
      this.tell({ kind: 'paired', device: this.describe(device) });
    } else {
      device = db.deviceByKey(key);
      db.seen(device.id);
    }
    this.attach(device, opened.channel, opened.kind === 'pairing', via);
    if (opened.kind === 'pairing') this.followLan();
  }

  /* ---------------------------------------------------------------- */
  /* Connections                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * A channel of a phone. A faster one carries the traffic and the I2P one
   * is kept aside; a new I2P channel replaces the old one, in its place; a
   * new faster one takes the place of the faster one there was.
   */
  attach(device, channel, justPaired, via = 'i2p') {
    const id = device.id;
    const connection = { device, channel, via, since: Date.now(), idle: null };
    const old = this.connections.get(id);
    const quiet = (gone) => { if (gone) { clearTimeout(gone.idle); gone.channel.close(); } };
    if (old && fast(via) && old.via === 'i2p') {
      quiet(this.standby.get(id));
      this.standby.set(id, old);
      this.connections.set(id, connection);
    } else if (old && via === 'i2p' && fast(old.via)) {
      quiet(this.standby.get(id));
      this.standby.set(id, connection);
    } else if (old && fast(via) && fast(old.via)) {
      // The phone came home again: the I2P channel kept aside stays where it is.
      quiet(old);
      this.connections.set(id, connection);
    } else {
      quiet(this.standby.get(id));
      this.standby.delete(id);
      if (old) this.detach(old, 'replaced');
      this.connections.set(id, connection);
    }
    this.touch(connection);
    channel.send({ t: 'evt', name: 'welcome', data: { protocol: PROTOCOL, paired: justPaired, device: { id: device.id, name: device.name }, desktop: { name: this.name(), version: this.version }, page: this.attending(), keepaliveMs: Math.min(fast(via) ? FAST_KEEPALIVE_MS : KEEPALIVE_MS, Math.floor(this.idleMs / 2)) } }).catch(() => {});
    this.tell(old ? { kind: 'status' } : { kind: 'connected', device: this.describe(device) });
    this.listen(connection);
  }

  /** Whether a channel is still one of its phone's: the one in use, or the one kept aside. */
  owns(connection) {
    const id = connection.device.id;
    return this.connections.get(id) === connection || this.standby.get(id) === connection;
  }

  /** Where a phone on the same network finds this computer, asked through a channel it has. */
  offerLan(connection, header) {
    const reply = (result, error = null) => connection.channel.send(error ? { t: 'res', id: header.id, ok: false, error } : { t: 'res', id: header.id, ok: true, result }).catch(() => {});
    const settings = this.db()?.settings();
    if (!settings) return reply(null, { code: 'failed', message: 'Il database è bloccato.' });
    if (!settings.lan) return reply(null, { code: 'lan_off', message: 'Il computer tiene il collegamento solo su I2P.' });
    const addresses = this.lan.addresses();
    if (!addresses.length) return reply(null, { code: 'no_path', message: 'Il computer non è su una rete locale.' });
    return reply({ addresses });
  }

  touch(connection) {
    clearTimeout(connection.idle);
    connection.idle = setTimeout(() => this.detach(connection, 'idle'), fast(connection.via) ? Math.min(this.idleMs, FAST_IDLE_MS) : this.idleMs);
    if (connection.idle.unref) connection.idle.unref();
  }

  async listen(connection) {
    const { channel, device } = connection;
    try {
      for (;;) {
        const { header, body } = await channel.receive();
        if (!this.owns(connection)) return;
        this.touch(connection);
        if (header.t !== 'req' || typeof header.method !== 'string' || header.id === undefined) continue;
        // A phone uses the faster channel while it has one. A request of its on the I2P channel kept aside says
        // the faster one is gone for it (out of range, without a word): the computer goes back to I2P at once.
        if (!ASIDE.has(header.method) && this.standby.get(device.id) === connection) {
          const used = this.connections.get(device.id);
          if (used && used !== connection) this.detach(used, 'unused');
        }
        if (header.method === 'ping') {
          channel.send({ t: 'res', id: header.id, ok: true, result: { now: new Date().toISOString(), page: this.attending() } }).catch(() => {});
          continue;
        }
        if (header.method === 'lan.offer') {
          this.offerLan(connection, header);
          continue;
        }
        if (Object.hasOwn(this.local, header.method)) {
          this.answerHere(connection, header, body);
          continue;
        }
        if (!this.attending()) {
          channel.send({ t: 'res', id: header.id, ok: false, error: { code: 'page_away', message: 'L\'app è aperta ma la sua pagina non risponde.' } }).catch(() => {});
          continue;
        }
        this.tell({
          kind: 'request', device: device.id, id: header.id, method: header.method.slice(0, 80),
          params: header.params && typeof header.params === 'object' ? header.params : {},
          body: body.length ? body.toString('base64') : null
        });
      }
    } catch {
      this.detach(connection, 'closed');
    }
  }

  /** A request the service answers: the answer goes back when it is ready, while the others go on. */
  async answerHere(connection, header, body) {
    let answer;
    try {
      const { result, body: bytes = null } = await this.local[header.method](connection.device.id, header.params && typeof header.params === 'object' ? header.params : {}, body);
      answer = [{ t: 'res', id: header.id, ok: true, result }, bytes];
    } catch (error) {
      answer = [{ t: 'res', id: header.id, ok: false, error: { code: error.code && typeof error.code === 'string' && !error.code.startsWith('E') ? error.code : 'failed', message: String(error.message || error).slice(0, 500) } }, null];
    }
    if (!this.owns(connection)) return;
    connection.channel.send(answer[0], answer[1]).catch(() => this.detach(connection, 'closed'));
  }

  detach(connection, reason) {
    clearTimeout(connection.idle);
    connection.channel.close();
    const id = connection.device.id;
    if (this.standby.get(id) === connection) { this.standby.delete(id); return; }
    if (this.connections.get(id) !== connection) return;
    if (fast(connection.via)) {
      // The I2P channel kept aside takes the traffic again: the phone is still there, off the faster way.
      const standby = this.standby.get(id);
      if (standby) {
        this.standby.delete(id);
        this.connections.set(id, standby);
        this.tell({ kind: 'status' });
        return;
      }
    }
    this.connections.delete(connection.device.id);
    try { this.db()?.seen(connection.device.id); } catch {}
    this.tell({ kind: 'disconnected', device: this.describe(connection.device), reason });
    this.release();
  }

  /**
   * What the page sends to a phone (`device`: its id, or '*' for every phone
   * connected): an answer or an event, with bytes of its own when it has any.
   * Says to how many it went.
   */
  async send({ device = '*', header, body = null }) {
    if (!header || typeof header !== 'object' || !['res', 'evt'].includes(header.t)) fail('Messaggio non valido.');
    const bytes = body ? Buffer.from(String(body), 'base64') : null;
    const targets = device === '*' ? [...this.connections.values()] : [this.connections.get(String(device))].filter(Boolean);
    let sent = 0;
    await Promise.all(targets.map(async connection => {
      try { await connection.channel.send(header, bytes); sent++; } catch { this.detach(connection, 'closed'); }
    }));
    return { sent };
  }

  /* ---------------------------------------------------------------- */
  /* Pairing                                                            */
  /* ---------------------------------------------------------------- */

  /** Opens a pairing and gives the code to show. The address is made readable by the new phone first. */
  openPairing() {
    return this.run(async () => {
      const db = this.db();
      if (!db) fail('Il database è bloccato.', 423);
      const settings = db.settings();
      if (!settings.enabled && !settings.service) fail('Il ponte è spento.', 409);
      // A phone is paired with the window open, where the code is shown: with
      // the service alone the bridge is turned on for it, and off again after.
      this.held = true;
      if (!this.router.running || !['ready', 'tunnels'].includes(this.phase)) {
        this.work = Promise.resolve();
        try { await this.startNow(db); } catch (error) { this.held = false; throw error; }
      }
      this.closePairingNow();
      const pairing = { secret: randomBytes(32), reader: generateStatic(), expiresAt: 0, failures: 0, timer: null, code: '' };
      this.pairing = pairing;
      try {
        await this.link();
      } catch (error) {
        this.pairing = null;
        this.error = error.message;
        this.setPhase('error');
        throw error;
      }
      const privateKey = Buffer.from(db.key('static_private'), 'hex');
      pairing.expiresAt = Date.now() + this.pairingMs;
      pairing.code = ['SYNTHORG-BRIDGE', PROTOCOL, this.session.address.replace(/\.b32\.i2p$/, '').toUpperCase(),
        code32(publicOf(privateKey)), code32(pairing.secret), code32(pairing.reader.privateKey)].join(':');
      pairing.timer = setTimeout(() => { if (this.pairing === pairing) this.closePairing().catch(() => {}); }, this.pairingMs);
      if (pairing.timer.unref) pairing.timer.unref();
      this.tell({ kind: 'status' });
      return this.status();
    });
  }

  closePairingNow() {
    if (!this.pairing) return false;
    clearTimeout(this.pairing.timer);
    this.pairing = null;
    return true;
  }

  /** The code is withdrawn, and with it the key it carried: the address is linked again without it. */
  closePairing() {
    return this.run(async () => {
      if (!this.closePairingNow()) return this.status();
      if (this.router.running) await this.link();
      this.tell({ kind: 'status' });
      setImmediate(() => this.release());
      return this.status();
    });
  }

  removeDevice(id) {
    return this.run(async () => {
      const db = this.db();
      if (!db) fail('Il database è bloccato.', 423);
      db.removeDevice(id);
      // Its channels close whichever way they came: it is no longer let in.
      const aside = this.standby.get(String(id));
      if (aside) { this.standby.delete(String(id)); clearTimeout(aside.idle); aside.channel.close(); }
      const live = this.connections.get(String(id));
      if (live) this.detach(live, 'removed');
      if (this.router.running) await this.link();
      this.followLan();
      this.tell({ kind: 'status' });
      return this.status();
    });
  }

  renameDevice(id, name) {
    const db = this.db();
    if (!db) fail('Il database è bloccato.', 423);
    const device = db.renameDevice(id, name);
    const connection = this.connections.get(device.id);
    if (connection) connection.device = device;
    return this.status();
  }

  /** New keys and no phones. */
  async forget() {
    const db = this.db();
    if (!db) fail('Il database è bloccato.', 423);
    const wanted = this.wanted(db.settings());
    await this.stop();
    db.forget();
    if (wanted) await this.start();
    return this.status();
  }

  /* ---------------------------------------------------------------- */
  /* The page                                                           */
  /* ---------------------------------------------------------------- */

  attending() {
    return Date.now() - this.attended < PAGE_AWAY_MS;
  }

  setPhase(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.tell({ kind: 'status' });
  }

  /** Something for the page: a request of a phone, or a change it shows. */
  tell(message) {
    this.queue.push(message);
    if (this.queue.length > QUEUE_MOST) this.queue.splice(0, this.queue.length - QUEUE_MOST);
    for (const wake of [...this.pollers]) wake();
  }

  /** What there is for the page, or what comes within `waitMs`. */
  inbox(waitMs = POLL_MOST_MS, onGone = null) {
    const wasAway = !this.attending();
    this.attended = Date.now();
    if (wasAway) this.announcePage(true);
    const drain = () => ({ messages: this.queue.splice(0), status: this.status() });
    if (this.queue.length || waitMs <= 0) return Promise.resolve(drain());
    return new Promise(resolve => {
      let timer = null;
      const wake = () => {
        clearTimeout(timer);
        this.pollers.delete(wake);
        this.attended = Date.now();
        resolve(drain());
      };
      timer = setTimeout(wake, Math.min(Math.max(0, waitMs), POLL_MOST_MS));
      this.pollers.add(wake);
      onGone?.(() => { clearTimeout(timer); this.pollers.delete(wake); });
    });
  }

  /** The phones are told whether the page is there to answer them. */
  announcePage(there) {
    for (const connection of this.connections.values()) {
      connection.channel.send({ t: 'evt', name: 'page', data: { there } }).catch(() => {});
    }
  }

  describe(device) {
    return {
      id: device.id, name: device.name, platform: device.platform || '',
      createdAt: device.created_at, lastSeenAt: device.last_seen_at || null,
      connected: this.connections.has(device.id),
      // Which way its traffic goes now: 'lan' (the local network) or 'i2p'.
      via: this.connections.get(device.id)?.via || null
    };
  }

  /** The state, after asking whether the embedded router can run here. */
  async fullStatus() {
    await this.router.check?.();
    return this.status();
  }

  status() {
    const db = this.db();
    const settings = db ? db.settings() : null;
    return {
      protocol: PROTOCOL,
      locked: !db,
      embeddedAvailable: this.router.embeddedAvailable(),
      settings,
      name: db ? this.name() : '',
      windowOpen: this.windowOpen,
      wanted: settings ? this.wanted(settings) : false,
      phase: this.phase,
      error: this.error,
      address: this.session?.address || null,
      lan: { listening: this.lan.on, addresses: this.lan.addresses() },
      devices: db ? db.devices().map(device => this.describe(device)) : [],
      pairing: this.pairing && this.pairing.code ? { code: this.pairing.code, expiresAt: new Date(this.pairing.expiresAt).toISOString() } : null,
      preparingPairing: Boolean(this.pairing && !this.pairing.code)
    };
  }
}

module.exports = { Bridge, PROTOCOL };
