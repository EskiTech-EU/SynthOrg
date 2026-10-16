'use strict';

const { syncInvoke } = require('./_sync_bridge.js');

const POLYFILL_DIR = '__POLYFILL_DIR__';

const _moduleCache = Object.create(null);

const BUILTIN_MODULES = {
  events: './events.js',
  stream: './stream.js',
  buffer: './buffer.js',
  util: './util.js',
  assert: './assert.js',
  process: './process.js',
  string_decoder: './string_decoder.js',
  querystring: './querystring.js',
  zlib: './zlib.js',
  timers: './timers.js',
  console: './console.js',
  module: './module.js',
  path: './path.js',
  fs: './fs.js',
  os: './os.js',
  url: './url.js',
  crypto: './crypto.js',
  http: './http.js',
  https: './https.js',
  net: './net.js',
  tls: './tls.js',
  dns: './dns.js',
  child_process: './child_process.js',
  worker_threads: './worker_threads.js',
  perf_hooks: './perf_hooks.js',
  'fs/promises': './fs.js',
  'stream/promises': './stream.js',
  'timers/promises': './timers.js',
  'node:events': './events.js',
  'node:stream': './stream.js',
  'node:buffer': './buffer.js',
  'node:util': './util.js',
  'node:assert': './assert.js',
  'node:process': './process.js',
  'node:string_decoder': './string_decoder.js',
  'node:querystring': './querystring.js',
  'node:zlib': './zlib.js',
  'node:timers': './timers.js',
  'node:console': './console.js',
  'node:module': './module.js',
  'node:path': './path.js',
  'node:fs': './fs.js',
  'node:os': './os.js',
  'node:url': './url.js',
  'node:crypto': './crypto.js',
  'node:http': './http.js',
  'node:https': './https.js',
  'node:net': './net.js',
  'node:tls': './tls.js',
  'node:dns': './dns.js',
  'node:child_process': './child_process.js',
  'node:worker_threads': './worker_threads.js',
  'node:perf_hooks': './perf_hooks.js',
};

function resolvePath(base, relative) {
  const parts = base.replace(/\\/g, '/').split('/');
  parts.pop();
  for (const seg of relative.replace(/\\/g, '/').split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

function readFileFromRust(filePath) {
  return syncInvoke('read_file_text', { path: filePath });
}

function fileExistsFromRust(filePath) {
  try {
    syncInvoke('file_exists', { path: filePath });
    return true;
  } catch {
    return false;
  }
}

function tryResolveFile(base) {
  const candidates = [
    base,
    base + '.js',
    base + '.json',
    base + '.node',
    base + '/index.js',
    base + '/index.json',
  ];
  for (const c of candidates) {
    if (fileExistsFromRust(c)) return c;
  }
  return null;
}

function loadModule(filePath) {
  if (_moduleCache[filePath]) {
    return _moduleCache[filePath].exports;
  }

  const source = readFileFromRust(filePath);

  if (filePath.endsWith('.json')) {
    const parsed = JSON.parse(source);
    _moduleCache[filePath] = { exports: parsed };
    return parsed;
  }

  const mod = {
    id: filePath,
    filename: filePath,
    loaded: false,
    exports: {},
    children: [],
    paths: [],
  };
  _moduleCache[filePath] = mod;

  const dirname = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const localRequire = createRequire(dirname);

  const wrapper = `(function(exports, require, module, __filename, __dirname) {\n${source}\n});`;

  try {
    const fn = (0, eval)(wrapper);
    fn(mod.exports, localRequire, mod, filePath, dirname);
  } catch (err) {
    delete _moduleCache[filePath];
    throw err;
  }

  mod.loaded = true;
  return mod.exports;
}

function resolvePackage(extensionPath, packageName) {
  let subpath = '';
  const slashIdx = packageName.indexOf('/');
  let pkgName = packageName;
  if (slashIdx > 0 && !packageName.startsWith('@')) {
    pkgName = packageName.substring(0, slashIdx);
    subpath = packageName.substring(slashIdx);
  } else if (packageName.startsWith('@') && slashIdx > 0) {
    const secondSlash = packageName.indexOf('/', slashIdx + 1);
    if (secondSlash > 0) {
      pkgName = packageName.substring(0, secondSlash);
      subpath = packageName.substring(secondSlash);
    }
  }

  let dir = extensionPath;
  while (dir && dir !== '/' && dir !== '.') {
    const nmDir = dir + '/node_modules/' + pkgName;
    const pkgJsonPath = nmDir + '/package.json';

    if (fileExistsFromRust(pkgJsonPath)) {
      if (subpath) {
        const resolved = tryResolveFile(nmDir + subpath);
        if (resolved) return resolved;
      }
      try {
        const pkgJson = JSON.parse(readFileFromRust(pkgJsonPath));
        const main = pkgJson.main || 'index.js';
        const resolved = tryResolveFile(nmDir + '/' + main);
        if (resolved) return resolved;
      } catch {}
      const fallback = tryResolveFile(nmDir + '/index.js');
      if (fallback) return fallback;
    }

    const parent = dir.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

function createRequire(extensionPath) {
  function require(moduleName) {
    if (typeof moduleName !== 'string' || moduleName.length === 0) {
      throw new Error('require: module name must be a non-empty string');
    }

    // Strip node: prefix for builtin lookup
    const normalized = moduleName.startsWith('node:') ? moduleName : moduleName;

    if (BUILTIN_MODULES[normalized]) {
      const polyfillPath = POLYFILL_DIR + '/' + BUILTIN_MODULES[normalized].replace('./', '');
      if (_moduleCache[polyfillPath]) return _moduleCache[polyfillPath].exports;
      try {
        return loadModule(polyfillPath);
      } catch {
        // Some builtins may not have a polyfill file yet; return a stub
        const stub = {};
        _moduleCache[polyfillPath] = { exports: stub };
        return stub;
      }
    }

    if (moduleName.startsWith('.') || moduleName.startsWith('/')) {
      const absolute = moduleName.startsWith('/')
        ? moduleName
        : resolvePath(extensionPath + '/dummy', moduleName);
      const resolved = tryResolveFile(absolute);
      if (!resolved) {
        const err = new Error(`Cannot find module '${moduleName}' from '${extensionPath}'`);
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      return loadModule(resolved);
    }

    const resolved = resolvePackage(extensionPath, moduleName);
    if (resolved) return loadModule(resolved);

    const err = new Error(`Cannot find module '${moduleName}'\nSearched in: ${extensionPath}/node_modules`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }

  require.resolve = function resolve(moduleName) {
    if (BUILTIN_MODULES[moduleName]) return moduleName;
    if (moduleName.startsWith('.') || moduleName.startsWith('/')) {
      const absolute = moduleName.startsWith('/')
        ? moduleName
        : resolvePath(extensionPath + '/dummy', moduleName);
      const resolved = tryResolveFile(absolute);
      if (resolved) return resolved;
    } else {
      const resolved = resolvePackage(extensionPath, moduleName);
      if (resolved) return resolved;
    }
    const err = new Error(`Cannot find module '${moduleName}'`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  };

  require.resolve.paths = function paths(moduleName) {
    const result = [];
    let dir = extensionPath;
    while (dir && dir !== '/' && dir !== '.') {
      result.push(dir + '/node_modules');
      const parent = dir.split('/').slice(0, -1).join('/');
      if (parent === dir) break;
      dir = parent;
    }
    return result;
  };

  require.cache = _moduleCache;
  require.main = null;
  require.extensions = {
    '.js': loadModule,
    '.json': loadModule,
    '.node': () => { throw new Error('.node addons not supported in SideX polyfill'); },
  };

  return require;
}

function isBuiltin(moduleName) {
  const name = moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName;
  return name in BUILTIN_MODULES || ('node:' + name) in BUILTIN_MODULES;
}

function clearCache() {
  for (const key of Object.keys(_moduleCache)) {
    delete _moduleCache[key];
  }
}

module.exports = {
  createRequire,
  isBuiltin,
  clearCache,
  _moduleCache,
  BUILTIN_MODULES,
};
