'use strict';

const http = require('./http');

function request(urlOrOptions, optionsOrCallback, callback) {
  let options;
  if (typeof urlOrOptions === 'string') {
    const parsed = new URL(urlOrOptions);
    options = {
      protocol: 'https:',
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
    };
    if (typeof optionsOrCallback === 'object') {
      Object.assign(options, optionsOrCallback);
    } else if (typeof optionsOrCallback === 'function') {
      callback = optionsOrCallback;
    }
  } else {
    options = { ...(urlOrOptions || {}), protocol: 'https:' };
    if (!options.port) options.port = 443;
    callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
  }

  return new http.ClientRequest(options, callback);
}

function get(urlOrOptions, optionsOrCallback, callback) {
  const req = request(urlOrOptions, optionsOrCallback, callback);
  req.end();
  return req;
}

function createServer(options, requestListener) {
  if (typeof options === 'function') {
    requestListener = options;
    options = {};
  }
  return new http.Server({ ...(options || {}), tls: true }, requestListener);
}

module.exports = {
  Agent: http.Agent,
  ClientRequest: http.ClientRequest,
  IncomingMessage: http.IncomingMessage,
  Server: http.Server,
  ServerResponse: http.ServerResponse,
  createServer,
  request,
  get,
  METHODS: http.METHODS,
  STATUS_CODES: http.STATUS_CODES,
  globalAgent: new http.Agent(),
};
