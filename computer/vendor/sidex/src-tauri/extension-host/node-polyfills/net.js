'use strict';

const EventEmitter = require('./events');
const { asyncInvoke } = require('./_sync_bridge');

let _nextSocketId = 1;
let _nextServerId = 1;

// ── Socket ──────────────────────────────────────────────────────────────

class Socket extends EventEmitter {
  constructor(options) {
    super();
    options = options || {};
    this._id = _nextSocketId++;
    this._connected = false;
    this._destroyed = false;
    this._ended = false;
    this._pollHandle = null;

    this.readable = true;
    this.writable = true;
    this.connecting = false;
    this.destroyed = false;

    this.remoteAddress = null;
    this.remotePort = null;
    this.remoteFamily = null;
    this.localAddress = null;
    this.localPort = null;

    this.bytesRead = 0;
    this.bytesWritten = 0;

    this.bufferSize = 0;
    this.timeout = 0;

    if (options.fd != null) {
      this._id = options.fd;
    }
  }

  connect(...args) {
    let options, connectListener;
    if (typeof args[0] === 'object') {
      options = args[0];
      connectListener = args[1];
    } else if (typeof args[0] === 'number') {
      options = { port: args[0], host: args[1] || '127.0.0.1' };
      connectListener = typeof args[2] === 'function' ? args[2] : (typeof args[1] === 'function' ? args[1] : undefined);
      if (typeof args[1] === 'function') options.host = '127.0.0.1';
    } else if (typeof args[0] === 'string') {
      options = { path: args[0] };
      connectListener = args[1];
    } else {
      options = {};
    }

    if (connectListener) this.once('connect', connectListener);
    this.connecting = true;

    const host = options.host || '127.0.0.1';
    const port = options.port;

    asyncInvoke('tcp_connect', {
      socketId: this._id,
      host,
      port,
      path: options.path || undefined,
    }).then(() => {
      this.connecting = false;
      this._connected = true;
      this.remoteAddress = host;
      this.remotePort = port;
      this.remoteFamily = host.includes(':') ? 'IPv6' : 'IPv4';
      this.emit('connect');
      this.emit('ready');
      this._startPolling();
    }).catch((err) => {
      this.connecting = false;
      this._emitError(err);
    });

    return this;
  }

  _startPolling() {
    const poll = () => {
      if (this._destroyed) return;
      asyncInvoke('tcp_read', { socketId: this._id })
        .then((result) => {
          if (result.data && result.data.length > 0) {
            const buf = typeof Buffer !== 'undefined'
              ? Buffer.from(result.data, 'utf8')
              : new TextEncoder().encode(result.data);
            this.bytesRead += buf.length;
            this.emit('data', buf);
          }
          if (result.closed) {
            this._connected = false;
            this.emit('end');
            this.emit('close', false);
          } else {
            this._pollHandle = setTimeout(poll, 20);
          }
        })
        .catch((err) => {
          if (!this._destroyed) this._emitError(err);
        });
    };
    this._pollHandle = setTimeout(poll, 10);
  }

  write(data, encoding, callback) {
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (this._destroyed || !this._connected) {
      const err = new Error('Socket is not connected');
      if (callback) callback(err);
      else this._emitError(err);
      return false;
    }

    const str = typeof data === 'string' ? data : data.toString(encoding || 'utf8');
    this.bytesWritten += str.length;

    asyncInvoke('tcp_write', { socketId: this._id, data: str })
      .then(() => { if (callback) callback(null); })
      .catch((err) => {
        if (callback) callback(err);
        else this._emitError(err);
      });

    return true;
  }

  end(data, encoding, callback) {
    if (typeof data === 'function') { callback = data; data = undefined; }
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (this._ended) return this;
    this._ended = true;

    const finish = () => {
      asyncInvoke('tcp_shutdown', { socketId: this._id })
        .then(() => {
          this.emit('finish');
          if (callback) callback();
        })
        .catch(() => {
          if (callback) callback();
        });
    };

    if (data != null) {
      this.write(data, encoding, finish);
    } else {
      finish();
    }
    return this;
  }

  destroy(error) {
    if (this._destroyed) return this;
    this._destroyed = true;
    this.destroyed = true;

    if (this._pollHandle) {
      clearTimeout(this._pollHandle);
      this._pollHandle = null;
    }

    asyncInvoke('tcp_close', { socketId: this._id }).catch(() => {});

    if (error) this.emit('error', error);
    this.emit('close', !!error);
    return this;
  }

  setTimeout(timeout, callback) {
    this.timeout = timeout;
    if (callback) this.once('timeout', callback);
    return this;
  }

  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
  address() {
    return { address: this.localAddress, family: this.remoteFamily, port: this.localPort };
  }

  setEncoding(encoding) {
    this._encoding = encoding;
    return this;
  }

  pipe(dest) {
    this.on('data', (chunk) => dest.write(chunk));
    this.on('end', () => { if (typeof dest.end === 'function') dest.end(); });
    return dest;
  }

  _emitError(err) {
    const error = err instanceof Error ? err : new Error(String(err));
    error.code = error.code || 'ECONNREFUSED';
    this.emit('error', error);
    this.destroy();
  }
}

// ── Server ──────────────────────────────────────────────────────────────

class Server extends EventEmitter {
  constructor(options, connectionListener) {
    super();
    if (typeof options === 'function') {
      connectionListener = options;
      options = {};
    }
    this._options = options || {};
    this._id = _nextServerId++;
    this._listening = false;
    this._closed = false;
    this._pollHandle = null;
    this._address = null;

    this.maxConnections = undefined;
    this.connections = 0;

    if (connectionListener) this.on('connection', connectionListener);
  }

  listen(...args) {
    let port, host, backlog, callback;

    if (typeof args[0] === 'object' && !Array.isArray(args[0])) {
      const opts = args[0];
      port = opts.port;
      host = opts.host || '0.0.0.0';
      backlog = opts.backlog;
      callback = args[1];
    } else {
      port = args[0];
      if (typeof args[1] === 'string') { host = args[1]; backlog = args[2]; callback = args[3]; }
      else if (typeof args[1] === 'number') { host = '0.0.0.0'; backlog = args[1]; callback = args[2]; }
      else { host = '0.0.0.0'; callback = args[1]; }
    }

    if (typeof backlog === 'function') { callback = backlog; backlog = undefined; }
    if (callback) this.once('listening', callback);

    asyncInvoke('tcp_listen', {
      serverId: this._id,
      host: host || '0.0.0.0',
      port: port || 0,
      backlog: backlog || 511,
    }).then((result) => {
      this._listening = true;
      this._address = { address: host || '0.0.0.0', family: 'IPv4', port: result.port || port };
      this.emit('listening');
      this._startAccepting();
    }).catch((err) => {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });

    return this;
  }

  _startAccepting() {
    const accept = () => {
      if (this._closed) return;
      asyncInvoke('tcp_accept', { serverId: this._id })
        .then((conn) => {
          if (conn && conn.socketId != null) {
            const socket = new Socket({ fd: conn.socketId });
            socket._connected = true;
            socket.remoteAddress = conn.remoteAddress || '127.0.0.1';
            socket.remotePort = conn.remotePort || 0;
            socket.remoteFamily = 'IPv4';
            this.connections++;
            socket.on('close', () => { this.connections--; });
            socket._startPolling();
            this.emit('connection', socket);
          }
          this._pollHandle = setTimeout(accept, 20);
        })
        .catch((err) => {
          if (!this._closed) {
            this._pollHandle = setTimeout(accept, 100);
          }
        });
    };
    this._pollHandle = setTimeout(accept, 10);
  }

  close(callback) {
    if (this._closed) {
      if (callback) callback(new Error('Server already closed'));
      return this;
    }
    this._closed = true;
    this._listening = false;

    if (this._pollHandle) {
      clearTimeout(this._pollHandle);
      this._pollHandle = null;
    }

    asyncInvoke('tcp_server_close', { serverId: this._id })
      .then(() => {
        this.emit('close');
        if (callback) callback();
      })
      .catch((err) => {
        this.emit('close');
        if (callback) callback(err);
      });

    return this;
  }

  address() {
    return this._address;
  }

  ref() { return this; }
  unref() { return this; }
  getConnections(callback) {
    callback(null, this.connections);
  }

  get listening() { return this._listening; }
}

// ── Factory functions ───────────────────────────────────────────────────

function createConnection(...args) {
  const socket = new Socket();
  return socket.connect(...args);
}

function createServer(options, connectionListener) {
  return new Server(options, connectionListener);
}

function connect(...args) {
  return createConnection(...args);
}

function isIP(input) {
  if (isIPv4(input)) return 4;
  if (isIPv6(input)) return 6;
  return 0;
}

function isIPv4(input) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(input);
}

function isIPv6(input) {
  return /^([\da-fA-F]{0,4}:){2,7}[\da-fA-F]{0,4}$/.test(input);
}

module.exports = {
  Socket,
  Server,
  Stream: Socket,
  createConnection,
  createServer,
  connect,
  isIP,
  isIPv4,
  isIPv6,
};
