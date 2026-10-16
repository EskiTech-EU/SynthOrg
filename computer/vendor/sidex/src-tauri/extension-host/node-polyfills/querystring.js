'use strict';

function escape(str) {
  return encodeURIComponent(str)
    .replace(/%20/g, '+')
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function unescape(str) {
  return decodeURIComponent(str.replace(/\+/g, ' '));
}

function stringify(obj, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  const encode = (options && options.encodeURIComponent) || escape;

  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return '';
  }

  const pairs = [];
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const encodedKey = encode(key);

    if (Array.isArray(value)) {
      for (const item of value) {
        pairs.push(encodedKey + eq + encode(String(item)));
      }
    } else {
      pairs.push(encodedKey + eq + encode(String(value)));
    }
  }

  return pairs.join(sep);
}

function parse(str, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  const decode = (options && options.decodeURIComponent) || unescape;
  const maxKeys = (options && options.maxKeys) || 1000;

  if (typeof str !== 'string') return {};

  const obj = Object.create(null);
  const pairs = str.split(sep);
  const limit = maxKeys > 0 ? Math.min(pairs.length, maxKeys) : pairs.length;

  for (let i = 0; i < limit; i++) {
    const pair = pairs[i];
    if (!pair) continue;

    const eqIdx = pair.indexOf(eq);
    let key, value;

    if (eqIdx >= 0) {
      key = decode(pair.substring(0, eqIdx));
      value = decode(pair.substring(eqIdx + eq.length));
    } else {
      key = decode(pair);
      value = '';
    }

    if (key in obj) {
      if (Array.isArray(obj[key])) {
        obj[key].push(value);
      } else {
        obj[key] = [obj[key], value];
      }
    } else {
      obj[key] = value;
    }
  }

  return obj;
}

function encode(obj, sep, eq, options) {
  return stringify(obj, sep, eq, options);
}

function decode(str, sep, eq, options) {
  return parse(str, sep, eq, options);
}

module.exports = {
  stringify,
  parse,
  encode,
  decode,
  escape,
  unescape,
};
