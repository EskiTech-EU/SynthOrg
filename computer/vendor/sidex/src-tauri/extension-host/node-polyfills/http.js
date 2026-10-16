'use strict';

const EventEmitter = require('./events');
const { asyncInvoke } = require('./_sync_bridge');

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

// ── IncomingMessage ─────────────────────────────────────────────────────

class IncomingMessage extends EventEmitter {
  constructor(response, options) {
    super();
    this.readable = true;
    this.httpVersion = '1.1';
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.complete = false;

    if (response) {
      this.statusCode = response.status;
      this.statusMessage = response.statusText || STATUS_CODES[response.status] || '';
      this.headers = {};
      this.rawHeaders = [];
      if (response.headers) {
        if (typeof response.headers.forEach === 'function') {
          response.headers.forEach((value, key) => {
            this.headers[key.toLowerCase()] = value;
            this.rawHeaders.push(key, value);
          });
        } else if (typeof response.headers === 'object') {
          for (const [key, value] of Object.entries(response.headers)) {
            this.headers[key.toLowerCase()] = value;
            this.rawHeaders.push(key, value);
          }
        }
      }
    } else {
      this.statusCode = 0;
      this.statusMessage = '';
      this.headers = {};
      this.rawHeaders = [];
    }

    this.method = options && options.method || 'GET';
    this.url = options && options.path || '/';

    this._body = null;
    this._consumed = false;
  }

  _pushBody(data) {
    const buf = typeof data === 'string'
      ? (typeof Buffer !== 'undefined' ? Buffer.from(data, 'utf8') : new TextEncoder().encode(data))
      : data;
    this.emit('data', buf);
    this.complete = true;
    this.emit('end');
  }

  setEncoding() { return this; }
  pipe(dest) {
    this.on('data', (chunk) => dest.write(chunk));
    this.on('end', () => { if (typeof dest.end === 'function') dest.end(); });
    return dest;
  }
  resume() { return this; }
  pause() { return this; }
  destroy() { this.emit('close'); }
}

// ── ServerResponse ──────────────────────────────────────────────────────

class ServerResponse extends EventEmitter {
  constructor(req) {
    super();
    this.writable = true;
    this.statusCode = 200;
    this.statusMessage = 'OK';
    this.headersSent = false;
    this.finished = false;
    this._headers = {};
    this._body = [];
    this._req = req;
  }

  setHeader(name, value) {
    this._headers[name.toLowerCase()] = value;
  }

  getHeader(name) {
    return this._headers[name.toLowerCase()];
  }

  removeHeader(name) {
    delete this._headers[name.toLowerCase()];
  }

  getHeaders() {
    return { ...this._headers };
  }

  hasHeader(name) {
    return name.toLowerCase() in this._headers;
  }

  writeHead(statusCode, statusMessage, headers) {
    this.statusCode = statusCode;
    if (typeof statusMessage === 'string') {
      this.statusMessage = statusMessage;
    } else if (typeof statusMessage === 'object') {
      headers = statusMessage;
    }
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        this._headers[k.toLowerCase()] = v;
      }
    }
    this.headersSent = true;
    return this;
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    const str = typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8');
    this._body.push(str);
    if (callback) callback();
    return true;
  }

  end(data, encoding, callback) {
    if (typeof data === 'function') { callback = data; data = undefined; }
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (data != null) this.write(data, encoding);
    this.finished = true;
    this.emit('finish');
    if (callback) callback();
  }
}

// ── ClientRequest ───────────────────────────────────────────────────────

class ClientRequest extends EventEmitter {
  constructor(options, callback) {
    super();
    this.writable = true;
    this.finished = false;
    this.aborted = false;

    if (typeof options === 'string') {
      const parsed = new URL(options);
      options = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
      };
    }

    this._options = {
      protocol: options.protocol || 'http:',
      hostname: options.hostname || options.host || 'localhost',
      port: options.port || (options.protocol === 'https:' ? 443 : 80),
      path: options.path || '/',
      method: (options.method || 'GET').toUpperCase(),
      headers: options.headers || {},
      timeout: options.timeout || 0,
    };

    this._body = [];
    this._callback = callback;

    if (callback) this.once('response', callback);
  }

  setHeader(name, value) {
    this._options.headers[name.toLowerCase()] = value;
    return this;
  }

  getHeader(name) {
    return this._options.headers[name.toLowerCase()];
  }

  removeHeader(name) {
    delete this._options.headers[name.toLowerCase()];
  }

  flushHeaders() {}
  setNoDelay() {}
  setSocketKeepAlive() {}

  setTimeout(timeout, callback) {
    this._options.timeout = timeout;
    if (callback) this.once('timeout', callback);
    return this;
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    const str = typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8');
    this._body.push(str);
    if (callback) callback();
    return true;
  }

  end(data, encoding, callback) {
    if (typeof data === 'function') { callback = data; data = undefined; }
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (data != null) this.write(data, encoding);
    this.finished = true;

    this._send()
      .then(() => { if (callback) callback(); })
      .catch((err) => {
        this.emit('error', err);
        if (callback) callback(err);
      });
  }

  abort() {
    this.aborted = true;
    this.emit('abort');
    this.emit('close');
  }

  destroy(error) {
    this.aborted = true;
    if (error) this.emit('error', error);
    this.emit('close');
  }

  async _send() {
    const opts = this._options;
    const url = `${opts.protocol}//${opts.hostname}:${opts.port}${opts.path}`;

    const fetchOpts = {
      method: opts.method,
      headers: opts.headers,
    };

    if (this._body.length > 0 && opts.method !== 'GET' && opts.method !== 'HEAD') {
      fetchOpts.body = this._body.join('');
    }

    if (opts.timeout > 0 && typeof AbortController !== 'undefined') {
      const ac = new AbortController();
      fetchOpts.signal = ac.signal;
      setTimeout(() => {
        ac.abort();
        this.emit('timeout');
      }, opts.timeout);
    }

    try {
      const response = await fetch(url, fetchOpts);
      const incoming = new IncomingMessage(response, opts);
      this.emit('response', incoming);

      const text = await response.text();
      incoming._pushBody(text);
    } catch (err) {
      if (err.name === 'AbortError') {
        this.emit('timeout');
      }
      throw err;
    }
  }
}

// ── createServer (delegated to Rust tcp_listen) ─────────────────────────

class Server extends EventEmitter {
  constructor(options, requestListener) {
    super();
    if (typeof options === 'function') {
      requestListener = options;
      options = {};
    }
    this._options = options || {};
    this._listening = false;
    this._serverId = null;

    if (requestListener) this.on('request', requestListener);
  }

  listen(...args) {
    let port, hostname, callback;
    if (typeof args[0] === 'object') {
      port = args[0].port;
      hostname = args[0].host || '0.0.0.0';
      callback = args[1];
    } else {
      port = args[0];
      hostname = typeof args[1] === 'string' ? args[1] : '0.0.0.0';
      callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    }

    if (callback) this.once('listening', callback);

    asyncInvoke('http_server_listen', {
      port: port || 0,
      host: hostname,
      tls: this._options.tls || false,
    }).then((result) => {
      this._serverId = result.serverId;
      this._listening = true;
      this._address = { address: hostname, family: 'IPv4', port: result.port || port };
      this.emit('listening');
      this._startAccepting();
    }).catch((err) => {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });

    return this;
  }

  _startAccepting() {
    const accept = () => {
      if (!this._listening) return;
      asyncInvoke('http_server_accept', { serverId: this._serverId })
        .then((reqData) => {
          if (reqData) {
            const req = new IncomingMessage(null, {
              method: reqData.method,
              path: reqData.url,
            });
            req.headers = reqData.headers || {};
            req.method = reqData.method || 'GET';
            req.url = reqData.url || '/';
            req.connection = { remoteAddress: reqData.remoteAddress || '127.0.0.1' };

            const res = new ServerResponse(req);
            res._requestId = reqData.requestId;

            res.on('finish', () => {
              asyncInvoke('http_server_respond', {
                serverId: this._serverId,
                requestId: reqData.requestId,
                statusCode: res.statusCode,
                headers: res._headers,
                body: res._body.join(''),
              }).catch(() => {});
            });

            this.emit('request', req, res);

            if (reqData.body) {
              req._pushBody(reqData.body);
            } else {
              req.complete = true;
              req.emit('end');
            }
          }
          setTimeout(accept, 10);
        })
        .catch(() => {
          if (this._listening) setTimeout(accept, 100);
        });
    };
    setTimeout(accept, 10);
  }

  close(callback) {
    this._listening = false;
    if (this._serverId != null) {
      asyncInvoke('http_server_close', { serverId: this._serverId }).catch(() => {});
    }
    this.emit('close');
    if (callback) callback();
    return this;
  }

  address() { return this._address || null; }
  get listening() { return this._listening; }
  ref() { return this; }
  unref() { return this; }
}

// ── Factory functions ───────────────────────────────────────────────────

function request(urlOrOptions, optionsOrCallback, callback) {
  let options;
  if (typeof urlOrOptions === 'string') {
    const parsed = new URL(urlOrOptions);
    options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
    };
    if (typeof optionsOrCallback === 'object') {
      Object.assign(options, optionsOrCallback);
      // callback stays as-is
    } else if (typeof optionsOrCallback === 'function') {
      callback = optionsOrCallback;
    }
  } else {
    options = urlOrOptions || {};
    callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
  }

  return new ClientRequest(options, callback);
}

function get(urlOrOptions, optionsOrCallback, callback) {
  const req = request(urlOrOptions, optionsOrCallback, callback);
  req.end();
  return req;
}

function createServer(options, requestListener) {
  return new Server(options, requestListener);
}

// ── STATUS_CODES ────────────────────────────────────────────────────────

const STATUS_CODES = {
  100: 'Continue', 101: 'Switching Protocols', 102: 'Processing',
  200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information',
  204: 'No Content', 205: 'Reset Content', 206: 'Partial Content',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found',
  303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable',
  407: 'Proxy Authentication Required', 408: 'Request Timeout', 409: 'Conflict',
  410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed',
  413: 'Payload Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable', 417: 'Expectation Failed', 418: "I'm a Teapot",
  422: 'Unprocessable Entity', 425: 'Too Early', 426: 'Upgrade Required',
  428: 'Precondition Required', 429: 'Too Many Requests',
  431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported',
};

module.exports = {
  Agent: class Agent {},
  ClientRequest,
  IncomingMessage,
  Server,
  ServerResponse,
  createServer,
  request,
  get,
  METHODS,
  STATUS_CODES,
  globalAgent: new (class Agent {})(),
};
