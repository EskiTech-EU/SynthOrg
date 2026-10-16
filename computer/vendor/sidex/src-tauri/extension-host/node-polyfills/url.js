'use strict';

const _URL = globalThis.URL;
const _URLSearchParams = globalThis.URLSearchParams;

// ── url.parse() — compat wrapper around the WHATWG URL API ──────────────

function parse(urlString, parseQueryString, slashesDenoteHost) {
  if (typeof urlString !== 'string') {
    throw new TypeError('Parameter "urlString" must be a string');
  }

  let parsed;
  let isRelative = false;

  try {
    parsed = new _URL(urlString);
  } catch (_e) {
    if (slashesDenoteHost && urlString.startsWith('//')) {
      try {
        parsed = new _URL('http:' + urlString);
        isRelative = true;
      } catch (_e2) {
        return _parseManual(urlString, parseQueryString);
      }
    } else {
      return _parseManual(urlString, parseQueryString);
    }
  }

  const result = {
    protocol: isRelative ? null : (parsed.protocol || null),
    slashes: parsed.protocol ? urlString.indexOf('//') === parsed.protocol.length : false,
    auth: parsed.username ? (parsed.password ? `${parsed.username}:${parsed.password}` : parsed.username) : null,
    host: parsed.host || null,
    port: parsed.port || null,
    hostname: parsed.hostname || null,
    hash: parsed.hash || null,
    search: parsed.search || null,
    query: parseQueryString ? _searchParamsToObject(parsed.searchParams) : (parsed.search ? parsed.search.slice(1) : null),
    pathname: parsed.pathname || null,
    path: (parsed.pathname || '') + (parsed.search || ''),
    href: parsed.href,
  };

  return result;
}

function _parseManual(urlString, parseQueryString) {
  const result = {
    protocol: null, slashes: false, auth: null, host: null, port: null,
    hostname: null, hash: null, search: null, query: null, pathname: null,
    path: null, href: urlString,
  };

  let rest = urlString;

  const hashIdx = rest.indexOf('#');
  if (hashIdx !== -1) {
    result.hash = rest.slice(hashIdx);
    rest = rest.slice(0, hashIdx);
  }

  const qIdx = rest.indexOf('?');
  if (qIdx !== -1) {
    result.search = rest.slice(qIdx);
    result.query = parseQueryString
      ? _searchParamsToObject(new _URLSearchParams(rest.slice(qIdx + 1)))
      : rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
  }

  result.pathname = rest || null;
  result.path = (result.pathname || '') + (result.search || '');

  return result;
}

function _searchParamsToObject(sp) {
  const obj = {};
  sp.forEach((value, key) => {
    if (key in obj) {
      if (Array.isArray(obj[key])) obj[key].push(value);
      else obj[key] = [obj[key], value];
    } else {
      obj[key] = value;
    }
  });
  return obj;
}

// ── url.format() ────────────────────────────────────────────────────────

function format(urlObject) {
  if (typeof urlObject === 'string') return urlObject;

  if (urlObject instanceof _URL) return urlObject.href;

  let result = '';

  if (urlObject.protocol) {
    result += urlObject.protocol;
    if (!urlObject.protocol.endsWith(':')) result += ':';
  }

  if (urlObject.slashes || urlObject.protocol === 'http:' || urlObject.protocol === 'https:') {
    result += '//';
  }

  if (urlObject.auth) {
    result += urlObject.auth + '@';
  }

  if (urlObject.hostname) {
    result += urlObject.hostname;
  } else if (urlObject.host) {
    result += urlObject.host;
  }

  if (urlObject.port && urlObject.hostname) {
    result += ':' + urlObject.port;
  }

  if (urlObject.pathname) {
    if (result && !urlObject.pathname.startsWith('/')) result += '/';
    result += urlObject.pathname;
  }

  if (urlObject.search) {
    result += urlObject.search.startsWith('?') ? urlObject.search : '?' + urlObject.search;
  } else if (urlObject.query) {
    if (typeof urlObject.query === 'string') {
      result += '?' + urlObject.query;
    } else if (typeof urlObject.query === 'object') {
      const sp = new _URLSearchParams(urlObject.query);
      result += '?' + sp.toString();
    }
  }

  if (urlObject.hash) {
    result += urlObject.hash.startsWith('#') ? urlObject.hash : '#' + urlObject.hash;
  }

  return result;
}

// ── url.resolve() ───────────────────────────────────────────────────────

function resolve(from, to) {
  try {
    return new _URL(to, from).href;
  } catch (_e) {
    if (!from.includes('://')) {
      try {
        return new _URL(to, 'http://' + from).href.replace('http://', '');
      } catch (_e2) { /* fall through */ }
    }
    const base = from.endsWith('/') ? from : from.replace(/\/[^/]*$/, '/');
    return base + to;
  }
}

// ── fileURLToPath / pathToFileURL ───────────────────────────────────────

function fileURLToPath(url) {
  const u = typeof url === 'string' ? new _URL(url) : url;
  if (u.protocol !== 'file:') throw new TypeError('The URL must be of scheme file');
  let pathname = decodeURIComponent(u.pathname);
  if (typeof process !== 'undefined' && process.platform === 'win32') {
    if (pathname.startsWith('/')) pathname = pathname.slice(1);
    pathname = pathname.replace(/\//g, '\\');
  }
  return pathname;
}

function pathToFileURL(path) {
  let p = path;
  if (typeof process !== 'undefined' && process.platform === 'win32') {
    p = p.replace(/\\/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
  } else if (!p.startsWith('/')) {
    p = '/' + p;
  }
  return new _URL('file://' + encodeURI(p));
}

// ── domainToASCII / domainToUnicode ─────────────────────────────────────

function domainToASCII(domain) {
  try { return new _URL('http://' + domain).hostname; }
  catch (_e) { return ''; }
}

function domainToUnicode(domain) {
  return domain;
}

module.exports = {
  parse,
  format,
  resolve,
  fileURLToPath,
  pathToFileURL,
  domainToASCII,
  domainToUnicode,
  URL: _URL,
  URLSearchParams: _URLSearchParams,
};
