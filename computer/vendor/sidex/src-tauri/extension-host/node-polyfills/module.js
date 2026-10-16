'use strict';

const _builtinModules = [
  'assert', 'buffer', 'child_process', 'console', 'crypto', 'dns',
  'events', 'fs', 'http', 'https', 'module', 'net', 'os', 'path',
  'process', 'querystring', 'stream', 'string_decoder', 'timers',
  'tls', 'url', 'util', 'worker_threads', 'zlib',
];

class Module {
  constructor(id, parent) {
    this.id = id || '';
    this.filename = id || '';
    this.loaded = false;
    this.parent = parent || null;
    this.children = [];
    this.exports = {};
    this.paths = [];
    this.path = id ? id.replace(/\\/g, '/').split('/').slice(0, -1).join('/') : '';
  }

  require(moduleName) {
    const { createRequire } = require('./require.js');
    const localRequire = createRequire(this.path || '.');
    return localRequire(moduleName);
  }

  _compile(content, filename) {
    const dirname = filename.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    const { createRequire } = require('./require.js');
    const localRequire = createRequire(dirname);

    const wrapper = `(function(exports, require, module, __filename, __dirname) {\n${content}\n});`;
    const fn = (0, eval)(wrapper);
    fn(this.exports, localRequire, this, filename, dirname);
    this.loaded = true;
  }

  static createRequire(filename) {
    const { createRequire } = require('./require.js');
    const dir = typeof filename === 'string'
      ? filename.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
      : '.';
    return createRequire(dir);
  }

  static isBuiltin(moduleName) {
    const name = moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName;
    return _builtinModules.includes(name);
  }

  static get builtinModules() {
    return _builtinModules.slice();
  }

  static _resolveFilename(request, parent) {
    const { createRequire } = require('./require.js');
    const dir = parent && parent.path ? parent.path : '.';
    const localRequire = createRequire(dir);
    return localRequire.resolve(request);
  }

  static _cache = {};
  static _extensions = {
    '.js': function (module, filename) {
      const { syncInvoke } = require('./_sync_bridge.js');
      const content = syncInvoke('read_file_text', { path: filename });
      module._compile(content, filename);
    },
    '.json': function (module, filename) {
      const { syncInvoke } = require('./_sync_bridge.js');
      const content = syncInvoke('read_file_text', { path: filename });
      module.exports = JSON.parse(content);
    },
    '.node': function () {
      throw new Error('.node native addons are not supported in SideX polyfill');
    },
  };

  static wrap(script) {
    return `(function(exports, require, module, __filename, __dirname) {\n${script}\n});`;
  }

  static _nodeModulePaths(from) {
    const parts = from.replace(/\\/g, '/').split('/');
    const paths = [];
    for (let i = parts.length; i > 0; i--) {
      if (parts[i - 1] === 'node_modules') continue;
      paths.push(parts.slice(0, i).join('/') + '/node_modules');
    }
    return paths;
  }
}

Module.Module = Module;

module.exports = Module;
