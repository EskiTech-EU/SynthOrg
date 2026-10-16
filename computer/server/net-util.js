'use strict';
const net = require('node:net');

/** A port the OS has free right now, on loopback: bound once and let go, for a child to bind straight after. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

module.exports = { freePort };
