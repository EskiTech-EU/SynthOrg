'use strict';
/**
 * The way to a paired phone on the same local network, without I2P.
 *
 * Optional, and off until the user turns it on (the bridge's `lan` setting):
 * on I2P nobody on the network sees that a phone and this computer talk; on
 * the local network whoever runs it does, though not what they say.
 *
 * This computer listens on its private addresses only (10.x, 172.16–31.x,
 * 192.168.x), never on a public one nor on IPv6, and takes connections from
 * private addresses only. Nothing is asked of the router of the network (no
 * port is forwarded, no UPnP): from outside the network the port is not
 * there. Inside it, anybody can reach the port and nobody gets an answer but
 * a paired phone: the same handshake as on I2P, with the keys of the pairing
 * (bridge-noise.js). No pairing is made here.
 *
 * The phone learns the addresses through the channel it already has
 * (`lan.offer`, bridge.js) and keeps the last ones, so that the next time it
 * is on the same network it finds the computer even without the internet.
 * The port is chosen once and kept, for that.
 */
const net = require('node:net');
const os = require('node:os');
const { randomInt } = require('node:crypto');

const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];
/** Whether an IPv4 address is of a private network. */
const isPrivate = (address) => PRIVATE.some(range => range.test(String(address || '').replace(/^::ffff:/i, '')));

/** The private IPv4 addresses this computer has now. */
function privateAddresses() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && isPrivate(item.address)) found.push(item.address);
    }
  }
  return [...new Set(found)];
}

const freePort = () => randomInt(49152, 65536);

class Lan {
  /** `addresses` and `allowed` are replaced by the tests; `everyMs`: how often the computer's addresses are looked at again. */
  constructor({ addresses = privateAddresses, allowed = isPrivate, everyMs = 15000 } = {}) {
    this.find = addresses;
    this.allowed = allowed;
    this.everyMs = everyMs;
    this.servers = new Map();   // address -> server listening there
    this.port = 0;
    this.onSocket = null;
    this.onPort = null;
    this.timer = null;
  }

  get on() { return Boolean(this.onSocket); }

  /**
   * Listens on every private address, at `port` (or one chosen now, told to
   * `onPort` to be kept). Called again while on, it only looks at the
   * addresses again: a computer that changed network listens on the new one.
   */
  async start(onSocket, { port = 0, onPort = null } = {}) {
    this.onSocket = onSocket;
    this.onPort = onPort;
    if (!this.port) this.port = port || freePort();
    await this.scan();
    if (!this.timer) {
      this.timer = setInterval(() => { this.scan().catch(() => {}); }, this.everyMs);
      if (this.timer.unref) this.timer.unref();
    }
  }

  async scan() {
    if (!this.onSocket) return;
    const now = new Set(this.find());
    for (const [address, server] of this.servers) {
      if (!now.has(address)) { this.servers.delete(address); server.close(); }
    }
    for (const address of now) {
      if (!this.servers.has(address)) await this.listen(address);
    }
    this.onPort?.(this.port);
  }

  listen(address, retried = false) {
    return new Promise(resolve => {
      const server = net.createServer({ noDelay: true }, socket => {
        if (!this.onSocket || !this.allowed(socket.remoteAddress)) { socket.destroy(); return; }
        socket.setKeepAlive(true, 30000);
        this.onSocket(socket);
      });
      server.once('error', (error) => {
        server.close();
        // The port kept is taken by something else, and nothing listens on it yet: another one, once.
        if (error.code === 'EADDRINUSE' && !retried && !this.servers.size) {
          this.port = freePort();
          this.listen(address, true).then(resolve);
        } else resolve();
      });
      server.listen(this.port, address, () => {
        if (!this.onSocket) { server.close(); resolve(); return; }
        server.removeAllListeners('error');
        server.on('error', () => {});
        this.servers.set(address, server);
        resolve();
      });
    });
  }

  /** Where a phone on the same network finds this computer: `[{ host, port }]`. */
  addresses() {
    return [...this.servers.keys()].map(host => ({ host, port: this.port }));
  }

  stop() {
    this.onSocket = null;
    clearInterval(this.timer);
    this.timer = null;
    for (const server of this.servers.values()) server.close();
    this.servers.clear();
  }
}

module.exports = { Lan, isPrivate, privateAddresses };
