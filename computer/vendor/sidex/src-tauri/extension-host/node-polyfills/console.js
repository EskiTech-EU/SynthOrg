'use strict';

const _console = typeof globalThis.console !== 'undefined' ? globalThis.console : {};

function noop() {}

const Console = class Console {
  constructor(opts) {
    if (opts && opts.stdout) {
      this._stdout = opts.stdout;
      this._stderr = opts.stderr || opts.stdout;
    } else {
      this._stdout = null;
      this._stderr = null;
    }
    this._counts = new Map();
    this._timers = new Map();
    this._groupDepth = 0;
  }

  _prefix() {
    return '  '.repeat(this._groupDepth);
  }

  log(...args) {
    if (this._stdout) {
      this._stdout.write(this._prefix() + args.map(String).join(' ') + '\n');
    } else {
      _console.log(...args);
    }
  }

  info(...args) { this.log(...args); }
  debug(...args) { this.log(...args); }

  warn(...args) {
    if (this._stderr) {
      this._stderr.write(this._prefix() + args.map(String).join(' ') + '\n');
    } else {
      (_console.warn || _console.log || noop)(...args);
    }
  }

  error(...args) {
    if (this._stderr) {
      this._stderr.write(this._prefix() + args.map(String).join(' ') + '\n');
    } else {
      (_console.error || _console.log || noop)(...args);
    }
  }

  dir(obj, options) {
    const { inspect } = require('./util.js');
    this.log(inspect(obj, options));
  }

  dirxml(...args) { this.log(...args); }

  trace(...args) {
    const err = new Error();
    this.error('Trace:', ...args, '\n' + (err.stack || '').split('\n').slice(2).join('\n'));
  }

  assert(condition, ...args) {
    if (!condition) {
      this.error('Assertion failed:', ...args);
    }
  }

  count(label) {
    label = label || 'default';
    const count = (this._counts.get(label) || 0) + 1;
    this._counts.set(label, count);
    this.log(`${label}: ${count}`);
  }

  countReset(label) {
    label = label || 'default';
    this._counts.delete(label);
  }

  time(label) {
    label = label || 'default';
    this._timers.set(label, performance.now());
  }

  timeLog(label, ...args) {
    label = label || 'default';
    const start = this._timers.get(label);
    if (start === undefined) {
      this.warn(`Timer '${label}' does not exist`);
      return;
    }
    this.log(`${label}: ${(performance.now() - start).toFixed(3)}ms`, ...args);
  }

  timeEnd(label) {
    label = label || 'default';
    const start = this._timers.get(label);
    if (start === undefined) {
      this.warn(`Timer '${label}' does not exist`);
      return;
    }
    this.log(`${label}: ${(performance.now() - start).toFixed(3)}ms`);
    this._timers.delete(label);
  }

  group(...args) {
    if (args.length > 0) this.log(...args);
    this._groupDepth++;
  }

  groupCollapsed(...args) { this.group(...args); }

  groupEnd() {
    if (this._groupDepth > 0) this._groupDepth--;
  }

  clear() {
    if (_console.clear) _console.clear();
  }

  table(data, columns) {
    if (_console.table) {
      _console.table(data, columns);
    } else {
      this.log(data);
    }
  }
};

const defaultConsole = new Console({});

module.exports = Object.assign(defaultConsole, {
  Console,
  log: defaultConsole.log.bind(defaultConsole),
  info: defaultConsole.info.bind(defaultConsole),
  debug: defaultConsole.debug.bind(defaultConsole),
  warn: defaultConsole.warn.bind(defaultConsole),
  error: defaultConsole.error.bind(defaultConsole),
  dir: defaultConsole.dir.bind(defaultConsole),
  trace: defaultConsole.trace.bind(defaultConsole),
  assert: defaultConsole.assert.bind(defaultConsole),
  count: defaultConsole.count.bind(defaultConsole),
  countReset: defaultConsole.countReset.bind(defaultConsole),
  time: defaultConsole.time.bind(defaultConsole),
  timeLog: defaultConsole.timeLog.bind(defaultConsole),
  timeEnd: defaultConsole.timeEnd.bind(defaultConsole),
  group: defaultConsole.group.bind(defaultConsole),
  groupCollapsed: defaultConsole.groupCollapsed.bind(defaultConsole),
  groupEnd: defaultConsole.groupEnd.bind(defaultConsole),
  clear: defaultConsole.clear.bind(defaultConsole),
  table: defaultConsole.table.bind(defaultConsole),
});
