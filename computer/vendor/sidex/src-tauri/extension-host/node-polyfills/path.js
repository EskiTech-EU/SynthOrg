'use strict';

function assertString(val, name) {
  if (typeof val !== 'string') {
    throw new TypeError(name + ' must be a string, received ' + typeof val);
  }
}

function normalizeArray(parts, allowAboveRoot) {
  const res = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || p === '.') continue;
    if (p === '..') {
      if (res.length && res[res.length - 1] !== '..') {
        res.pop();
      } else if (allowAboveRoot) {
        res.push('..');
      }
    } else {
      res.push(p);
    }
  }
  return res;
}

function splitPath(filename) {
  const m = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/.exec(filename);
  return [m[1], m[2], m[3], m[4]];
}

const posix = {
  sep: '/',
  delimiter: ':',

  resolve: function resolve() {
    let resolvedPath = '';
    let resolvedAbsolute = false;

    for (let i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
      const path = i >= 0 ? arguments[i] : '/';
      assertString(path, 'path');
      if (!path) continue;
      resolvedPath = path + '/' + resolvedPath;
      resolvedAbsolute = path.charAt(0) === '/';
    }

    resolvedPath = normalizeArray(resolvedPath.split('/'), !resolvedAbsolute).join('/');
    return (resolvedAbsolute ? '/' : '') + resolvedPath || '.';
  },

  normalize: function normalize(path) {
    assertString(path, 'path');
    if (!path) return '.';

    const isAbs = path.charAt(0) === '/';
    const trailingSlash = path.charAt(path.length - 1) === '/';

    let out = normalizeArray(path.split('/'), !isAbs).join('/');
    if (!out && !isAbs) out = '.';
    if (out && trailingSlash) out += '/';

    return (isAbs ? '/' : '') + out;
  },

  isAbsolute: function isAbsolute(path) {
    assertString(path, 'path');
    return path.charAt(0) === '/';
  },

  join: function join() {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) {
      const arg = arguments[i];
      assertString(arg, 'arguments[' + i + ']');
      if (arg) parts.push(arg);
    }
    return posix.normalize(parts.join('/'));
  },

  relative: function relative(from, to) {
    assertString(from, 'from');
    assertString(to, 'to');

    from = posix.resolve(from);
    to = posix.resolve(to);

    if (from === to) return '';

    const fromParts = from.split('/');
    const toParts = to.split('/');

    const length = Math.min(fromParts.length, toParts.length);
    let samePartsLength = length;
    for (let i = 0; i < length; i++) {
      if (fromParts[i] !== toParts[i]) {
        samePartsLength = i;
        break;
      }
    }

    const outputParts = [];
    for (let i = samePartsLength; i < fromParts.length; i++) {
      outputParts.push('..');
    }
    outputParts.push.apply(outputParts, toParts.slice(samePartsLength));

    return outputParts.join('/');
  },

  dirname: function dirname(path) {
    assertString(path, 'path');
    if (!path) return '.';
    const parts = splitPath(path);
    const root = parts[0];
    let dir = parts[1];
    if (!root && !dir) return '.';
    if (dir) dir = dir.substring(0, dir.length - 1);
    return root + dir;
  },

  basename: function basename(path, ext) {
    assertString(path, 'path');
    let base = splitPath(path)[2];
    if (ext && base.endsWith(ext)) {
      base = base.slice(0, base.length - ext.length);
    }
    return base;
  },

  extname: function extname(path) {
    assertString(path, 'path');
    return splitPath(path)[3];
  },

  parse: function parse(path) {
    assertString(path, 'path');
    const parts = splitPath(path);
    return {
      root: parts[0],
      dir: posix.dirname(path),
      base: parts[2],
      ext: parts[3],
      name: parts[2].slice(0, parts[2].length - parts[3].length),
    };
  },

  format: function format(pathObject) {
    if (pathObject === null || typeof pathObject !== 'object') {
      throw new TypeError('Parameter "pathObject" must be an object');
    }

    const dir = pathObject.dir || pathObject.root || '';
    const base = pathObject.base || ((pathObject.name || '') + (pathObject.ext || ''));

    if (!dir) return base;
    if (dir === pathObject.root) return dir + base;
    return dir + '/' + base;
  },

  toNamespacedPath: function toNamespacedPath(path) {
    return path;
  },
};

const win32 = {
  sep: '\\',
  delimiter: ';',

  resolve: function resolve() {
    let resolvedPath = '';
    let resolvedAbsolute = false;

    for (let i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
      const path = i >= 0 ? arguments[i] : 'C:\\';
      if (typeof path !== 'string') continue;
      if (!path) continue;
      resolvedPath = path + '\\' + resolvedPath;
      resolvedAbsolute = /^[a-zA-Z]:[\\\/]/.test(path) || path.charAt(0) === '\\';
    }

    resolvedPath = resolvedPath.replace(/\//g, '\\');
    const parts = resolvedPath.split('\\');
    const normalized = [];
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') {
        if (normalized.length && normalized[normalized.length - 1] !== '..') {
          normalized.pop();
        }
      } else {
        normalized.push(p);
      }
    }

    const prefix = resolvedAbsolute ? (resolvedPath.match(/^[a-zA-Z]:/)?.[0] || '') + '\\' : '';
    return prefix + normalized.join('\\') || '.';
  },

  normalize: function normalize(path) {
    if (typeof path !== 'string') throw new TypeError('path must be a string');
    if (!path) return '.';
    const replaced = path.replace(/\//g, '\\');
    const match = /^([a-zA-Z]:|\\\\[^\\]+\\[^\\]+)?(\\)?/.exec(replaced);
    const root = (match[1] || '') + (match[2] || '');
    const parts = replaced.slice(root.length).split('\\');
    const normalized = [];
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') { normalized.pop(); } else { normalized.push(p); }
    }
    let result = root + normalized.join('\\');
    if (path.endsWith('\\') || path.endsWith('/')) result += '\\';
    return result || '.';
  },

  isAbsolute: function isAbsolute(path) {
    if (typeof path !== 'string') throw new TypeError('path must be a string');
    return /^[a-zA-Z]:[\\\/]/.test(path) || path.startsWith('\\\\');
  },

  join: function join() {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) {
      if (typeof arguments[i] !== 'string') throw new TypeError('arguments must be strings');
      if (arguments[i]) parts.push(arguments[i]);
    }
    return win32.normalize(parts.join('\\'));
  },

  relative: function relative(from, to) {
    from = win32.resolve(from);
    to = win32.resolve(to);
    if (from === to) return '';
    const fromParts = from.split('\\');
    const toParts = to.split('\\');
    const length = Math.min(fromParts.length, toParts.length);
    let same = length;
    for (let i = 0; i < length; i++) {
      if (fromParts[i].toLowerCase() !== toParts[i].toLowerCase()) { same = i; break; }
    }
    const out = [];
    for (let i = same; i < fromParts.length; i++) out.push('..');
    out.push.apply(out, toParts.slice(same));
    return out.join('\\');
  },

  dirname: function dirname(path) {
    const norm = path.replace(/\//g, '\\');
    const idx = norm.lastIndexOf('\\');
    if (idx < 0) return '.';
    return norm.slice(0, idx) || norm.slice(0, 1);
  },

  basename: function basename(path, ext) {
    const norm = path.replace(/\//g, '\\');
    let base = norm.slice(norm.lastIndexOf('\\') + 1);
    if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
    return base;
  },

  extname: function extname(path) {
    const base = win32.basename(path);
    const idx = base.lastIndexOf('.');
    if (idx <= 0) return '';
    return base.slice(idx);
  },

  parse: function parse(path) {
    const dir = win32.dirname(path);
    const base = win32.basename(path);
    const ext = win32.extname(path);
    const root = /^([a-zA-Z]:\\|\\\\)/.exec(path)?.[0] || '';
    return { root, dir, base, ext, name: base.slice(0, base.length - ext.length) };
  },

  format: function format(obj) {
    const dir = obj.dir || obj.root || '';
    const base = obj.base || ((obj.name || '') + (obj.ext || ''));
    if (!dir) return base;
    return dir + (dir.endsWith('\\') ? '' : '\\') + base;
  },

  toNamespacedPath: function toNamespacedPath(path) {
    if (typeof path !== 'string') return path;
    if (!path) return path;
    const resolved = win32.resolve(path);
    if (resolved.startsWith('\\\\')) {
      return '\\\\?\\UNC\\' + resolved.slice(2);
    }
    if (/^[a-zA-Z]:/.test(resolved)) {
      return '\\\\?\\' + resolved;
    }
    return path;
  },
};

posix.posix = posix;
posix.win32 = win32;
win32.posix = posix;
win32.win32 = win32;

const exported = Object.assign({}, posix);
exported.posix = posix;
exported.win32 = win32;

module.exports = exported;
