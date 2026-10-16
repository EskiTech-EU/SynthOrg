'use strict';
/**
 * The phone's side of the bridge, in Node: what the app on the phone does,
 * written once here so that it can be tried from a terminal and read as the
 * reference when that app is written. It pairs with the code of the QR
 * code, keeps what it needs to come back, and talks to the desktop.
 *
 *   node scripts/bridge-phone.js pair  <code> [name]
 *   node scripts/bridge-phone.js call  <method> [json params]
 *   node scripts/bridge-phone.js watch [seconds]
 *
 * It goes through the router the app has started (the bridge has to be on),
 * with a destination of its own: between the two everything passes through
 * I2P, as from a phone. `--sam host:port` goes through another router
 * instead. What it keeps is in scripts/.bridge-phone.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Sam, toI2p64 } = require('../server/bridge-sam');
const { initiate, generateStatic, publicOf } = require('../server/bridge-noise');
const { BridgeRouter } = require('../server/bridge-router');

/** RFC 4648 base32 without padding, either case: the alphabet of the code. */
function fromBase32(text) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of String(text).toLowerCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Codice non valido.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

/** What the code of the QR code says. */
function readCode(code) {
  const parts = String(code).trim().split(':');
  if (parts.length !== 6 || parts[0] !== 'SYNTHORG-BRIDGE') throw new Error('Non è un codice di SynthOrg.');
  if (parts[1] !== '1') throw new Error(`Versione del ponte non conosciuta: ${parts[1]}.`);
  const [publicKey, secret, readerKey] = parts.slice(3).map(fromBase32);
  if ([publicKey, secret, readerKey].some(bytes => bytes.length !== 32)) throw new Error('Codice non valido.');
  return { address: parts[2].toLowerCase() + '.b32.i2p', publicKey, secret, readerKey };
}

class Phone {
  /** `identity` is what the phone keeps between one use and the next; `sam` the router it goes through. */
  constructor({ sam, identity = null, tries = 6, retryMs = 4000, handshakeMs = 40000 }) {
    this.sam = sam;
    this.identity = identity;
    this.tries = tries;
    this.retryMs = retryMs;
    this.handshakeMs = handshakeMs;
    this.session = null;
    this.channel = null;
    this.nextId = 1;
    this.pending = new Map();
    this.onEvent = null;
    this.onClose = null;
    this.onStep = null;     // told what is being done, as it is done: (step) => {}
  }

  /**
   * The phone's own place on I2P, from which it reads the desktop's hidden
   * address. It is a new one every time: the desktop knows the phone by its
   * channel key, not by where it calls from, and a place never used before
   * carries nothing over from an earlier connection (an address used again
   * right after a restart is answered with the keys of the old connection
   * for a couple of minutes, and nothing gets through).
   */
  async online() {
    if (this.session && !this.session.closed) return this.session;
    this.session = await this.sam.session({
      privateKey: await this.sam.generate(),
      readerKey: Buffer.from(this.identity.readerKey, 'hex'),
      tunnels: 2
    });
    return this.session;
  }

  /** Pairs with the desktop that showed `code`; resolves with what the desktop says of itself. */
  async pair(code, { name = 'Telefono', platform = 'node' } = {}) {
    const read = readCode(code);
    this.identity = {
      staticKey: generateStatic().privateKey.toString('hex'),
      readerKey: read.readerKey.toString('hex'),
      desktop: { address: read.address, publicKey: read.publicKey.toString('hex') }
    };
    return this.open({ kind: 'pairing', psk: read.secret, payload: { name, platform } });
  }

  /** A session with the desktop it is paired with. */
  connect() {
    if (!this.identity) throw new Error('Telefono non ancora accoppiato.');
    return this.open({ kind: 'session', payload: { platform: 'node' } });
  }

  async open({ kind, psk = null, payload }) {
    this.onStep?.('tunnels');
    const session = await this.online();
    this.onStep?.('reaching');
    // The address of the desktop is looked up in the network: just after it changed, it may take more than one try.
    let socket = null;
    for (let attempt = 1; !socket; attempt++) {
      try { socket = await session.connect(this.identity.desktop.address); }
      catch (error) { if (error.code !== 'BRIDGE_UNREACHABLE' || attempt >= this.tries) throw error; await new Promise(resolve => setTimeout(resolve, this.retryMs)); }
    }
    this.onStep?.('handshake');
    const privateKey = Buffer.from(this.identity.staticKey, 'hex');
    // The first words over a stream just opened may never arrive, above all
    // from a place on I2P made a moment ago: the handshake is given a time,
    // and tried again over a new stream.
    let welcome = null;
    for (let attempt = 1; !welcome; attempt++) {
      try {
        this.channel = await initiate(socket, {
          kind, psk, payload, timeoutMs: this.handshakeMs,
          staticKey: { privateKey, publicKey: publicOf(privateKey) },
          remoteStatic: Buffer.from(this.identity.desktop.publicKey, 'hex')
        });
        welcome = await this.channel.receive();
      } catch (error) {
        try { socket.destroy(); } catch {}
        this.channel = null;
        if (error.code === 'BRIDGE_CHANNEL' || attempt >= 3 || this.tries <= 1) throw error;
        this.onStep?.('again');
        socket = await session.connect(this.identity.desktop.address);
      }
    }
    if (welcome.header.name !== 'welcome') throw new Error('Il desktop non ha risposto come atteso.');
    this.identity.deviceId = welcome.header.data.device.id;
    this.listen(this.channel);
    return welcome.header.data;
  }

  async listen(channel) {
    try {
      for (;;) {
        const { header, body } = await channel.receive();
        if (header.t === 'res') {
          const waiting = this.pending.get(header.id);
          if (!waiting) continue;
          this.pending.delete(header.id);
          if (header.ok) waiting.resolve({ result: header.result, body });
          else waiting.reject(Object.assign(new Error(header.error?.message || 'Richiesta non riuscita.'), { code: header.error?.code }));
        } else if (header.t === 'evt') {
          this.onEvent?.(header.name, header.data, body);
        }
      }
    } catch (error) {
      if (this.channel === channel) this.channel = null;
      for (const waiting of this.pending.values()) waiting.reject(error);
      this.pending.clear();
      this.onClose?.(error);
    }
  }

  /** Asks the desktop for something; resolves with { result, body }. */
  call(method, params = {}, { body = null, timeoutMs = 120000 } = {}) {
    if (!this.channel) return Promise.reject(new Error('Non collegato.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Nessuna risposta a ${method}.`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      this.channel.send({ t: 'req', id, method, params }, body).catch(error => { this.pending.delete(id); clearTimeout(timer); reject(error); });
    });
  }

  close() {
    this.channel?.close();
    this.channel = null;
    this.session?.close();
    this.session = null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const samAt = args.indexOf('--sam');
  const external = samAt !== -1 ? args.splice(samAt, 2)[1] : null;
  const [command, ...rest] = args;
  if (!['pair', 'call', 'watch'].includes(command)) {
    console.log('Uso: bridge-phone.js pair <codice> [nome] | call <metodo> [parametri json] | watch [secondi]  [--sam host:porta]');
    process.exit(2);
  }
  const home = path.join(__dirname, '.bridge-phone');
  fs.mkdirSync(home, { recursive: true });
  const identityFile = path.join(home, 'identity.json');
  const started = Date.now();
  const since = () => ((Date.now() - started) / 1000).toFixed(1) + ' s';

  let sam;
  if (external) {
    const [host, port] = external.split(':');
    sam = new Sam({ host, port: Number(port) });
  } else {
    const router = new BridgeRouter();
    sam = new Sam({ dial: () => router.dial() });
  }
  if (!await sam.reachable()) {
    console.error(external ? `Nessun router I2P risponde a ${external}.` : "Il router dell'app non è avviato: attiva il ponte nelle impostazioni dell'assistente.");
    process.exit(1);
  }
  const identity = fs.existsSync(identityFile) ? JSON.parse(fs.readFileSync(identityFile, 'utf8')) : null;
  const phone = new Phone({ sam, identity });
  phone.onEvent = (name, data, body) => console.log(`[${since()}] evento ${name}`, JSON.stringify(data), body?.length ? `(+${body.length} byte)` : '');
  phone.onClose = () => console.log(`[${since()}] collegamento chiuso`);
  phone.onStep = (step) => console.log(`[${since()}] ${{ tunnels: 'preparo i tunnel del telefono', reaching: 'cerco il computer', handshake: 'apro il canale cifrato', again: 'nessuna risposta: riprovo su un nuovo flusso' }[step]}`);
  const leave = async (code) => { phone.close(); process.exit(code); };

  try {
    if (command === 'pair') {
      const welcome = await phone.pair(rest[0], { name: rest[1] || 'Telefono di prova' });
      fs.writeFileSync(identityFile, JSON.stringify(phone.identity, null, 2));
      console.log(`[${since()}] accoppiato con «${welcome.desktop.name}»`);
    } else {
      const welcome = await phone.connect();
      console.log(`[${since()}] collegato a «${welcome.desktop.name}», pagina ${welcome.page ? 'presente' : 'assente'}`);
      if (command === 'call') {
        const asked = Date.now();
        const answer = await phone.call(rest[0], rest[1] ? JSON.parse(rest[1]) : {});
        console.log(`[${since()}] risposta in ${Date.now() - asked} ms:`, JSON.stringify(answer.result, null, 2), answer.body?.length ? `(+${answer.body.length} byte)` : '');
      }
      if (command === 'watch' || rest.includes('--watch')) await new Promise(resolve => setTimeout(resolve, (Number(rest[0]) || 60) * 1000));
    }
    await leave(0);
  } catch (error) {
    console.error(`[${since()}] ${error.message}`);
    await leave(1);
  }
}

if (require.main === module) main();

module.exports = { Phone, readCode, fromBase32, toI2p64 };
