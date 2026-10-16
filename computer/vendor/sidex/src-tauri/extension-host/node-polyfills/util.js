'use strict';

// ── promisify ─────────────────────────────────────────────────────────────

function promisify(original) {
  if (typeof original !== 'function') {
    throw new TypeError('The "original" argument must be of type Function');
  }

  if (original[promisify.custom]) {
    const fn = original[promisify.custom];
    Object.defineProperty(fn, promisify.custom, { value: fn, enumerable: false });
    return fn;
  }

  function fn(...args) {
    return new Promise((resolve, reject) => {
      original.call(this, ...args, (err, ...values) => {
        if (err) return reject(err);
        resolve(values.length > 1 ? values : values[0]);
      });
    });
  }

  Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
  Object.defineProperty(fn, promisify.custom, { value: fn, enumerable: false });
  return fn;
}

promisify.custom = Symbol.for('nodejs.util.promisify.custom');

// ── callbackify ───────────────────────────────────────────────────────────

function callbackify(original) {
  if (typeof original !== 'function') {
    throw new TypeError('The "original" argument must be of type Function');
  }

  function callbackified(...args) {
    const cb = args.pop();
    if (typeof cb !== 'function') {
      throw new TypeError('The last argument must be of type Function');
    }
    const promise = original.apply(this, args);
    promise.then(
      (ret) => queueMicrotask(() => cb(null, ret)),
      (err) => {
        queueMicrotask(() => {
          if (!err) {
            const e = new Error('Promise was rejected with falsy value');
            e.reason = err;
            cb(e);
          } else {
            cb(err);
          }
        });
      },
    );
  }

  Object.setPrototypeOf(callbackified, Object.getPrototypeOf(original));
  return callbackified;
}

// ── inherits ──────────────────────────────────────────────────────────────

function inherits(ctor, superCtor) {
  if (ctor === undefined || ctor === null) {
    throw new TypeError('The constructor to "inherits" must not be null or undefined');
  }
  if (superCtor === undefined || superCtor === null) {
    throw new TypeError('The super constructor to "inherits" must not be null or undefined');
  }
  if (superCtor.prototype === undefined) {
    throw new TypeError('The super constructor must have a prototype');
  }
  Object.defineProperty(ctor, 'super_', { value: superCtor, writable: true, configurable: true });
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

// ── deprecate ─────────────────────────────────────────────────────────────

function deprecate(fn, msg, code) {
  let warned = false;
  function deprecated(...args) {
    if (!warned) {
      warned = true;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`DeprecationWarning: ${msg}${code ? ` (${code})` : ''}`);
      }
    }
    return fn.apply(this, args);
  }
  return deprecated;
}

// ── format ────────────────────────────────────────────────────────────────

function format(fmt, ...args) {
  if (typeof fmt !== 'string') {
    const parts = [];
    for (const arg of [fmt, ...args]) {
      parts.push(typeof arg === 'string' ? arg : inspect(arg));
    }
    return parts.join(' ');
  }

  let i = 0;
  let result = fmt.replace(/%[sdjifoO%]/g, (match) => {
    if (match === '%%') return '%';
    if (i >= args.length) return match;
    const arg = args[i++];
    switch (match) {
      case '%s': return String(arg);
      case '%d': return Number(arg).toString();
      case '%i': return parseInt(arg, 10).toString();
      case '%f': return parseFloat(arg).toString();
      case '%j':
        try { return JSON.stringify(arg); }
        catch { return '[Circular]'; }
      case '%o': case '%O': return inspect(arg);
      default: return match;
    }
  });

  while (i < args.length) {
    const arg = args[i++];
    result += ' ' + (typeof arg === 'string' ? arg : inspect(arg));
  }
  return result;
}

function formatWithOptions(_inspectOptions, fmt, ...args) {
  return format(fmt, ...args);
}

// ── inspect ───────────────────────────────────────────────────────────────

function inspect(obj, opts) {
  if (typeof opts === 'boolean') opts = { showHidden: opts };
  opts = opts || {};
  const depth = opts.depth !== undefined ? opts.depth : 2;
  const colors = !!opts.colors;
  return _inspectValue(obj, depth, colors, new Set());
}

inspect.defaultOptions = { showHidden: false, depth: 2, colors: false };
inspect.styles = {
  number: 'yellow', boolean: 'yellow', string: 'green',
  date: 'magenta', regexp: 'red', null: 'bold', undefined: 'grey',
  special: 'cyan', name: '',
};
inspect.colors = {
  bold: [1, 22], red: [31, 39], green: [32, 39], yellow: [33, 39],
  blue: [34, 39], magenta: [35, 39], cyan: [36, 39], white: [37, 39], grey: [90, 39],
};
inspect.custom = Symbol.for('nodejs.util.inspect.custom');

function _inspectValue(val, depth, colors, seen) {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';

  const type = typeof val;
  if (type === 'string') return `'${val}'`;
  if (type === 'number' || type === 'boolean') return String(val);
  if (type === 'bigint') return val.toString() + 'n';
  if (type === 'symbol') return val.toString();
  if (type === 'function') return `[Function: ${val.name || 'anonymous'}]`;

  if (val instanceof Date) return val.toISOString();
  if (val instanceof RegExp) return val.toString();
  if (val instanceof Error) return val.stack || val.toString();

  if (val[inspect.custom]) {
    return val[inspect.custom](depth, { colors });
  }

  if (seen.has(val)) return '[Circular]';

  if (depth < 0) {
    return Array.isArray(val) ? '[Array]' : '[Object]';
  }

  seen.add(val);

  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    const items = val.map((v) => _inspectValue(v, depth - 1, colors, seen));
    return `[ ${items.join(', ')} ]`;
  }

  if (val instanceof Map) {
    const entries = [];
    val.forEach((v, k) => {
      entries.push(`${_inspectValue(k, depth - 1, colors, seen)} => ${_inspectValue(v, depth - 1, colors, seen)}`);
    });
    return `Map(${val.size}) { ${entries.join(', ')} }`;
  }

  if (val instanceof Set) {
    const items = [];
    val.forEach((v) => items.push(_inspectValue(v, depth - 1, colors, seen)));
    return `Set(${val.size}) { ${items.join(', ')} }`;
  }

  const keys = Object.keys(val);
  if (keys.length === 0) return '{}';

  const name = val.constructor && val.constructor.name !== 'Object' ? val.constructor.name + ' ' : '';
  const items = keys.map((k) => {
    const v = _inspectValue(val[k], depth - 1, colors, seen);
    return `${k}: ${v}`;
  });
  return `${name}{ ${items.join(', ')} }`;
}

// ── types ─────────────────────────────────────────────────────────────────

const types = {
  isDate(val) { return val instanceof Date; },
  isRegExp(val) { return val instanceof RegExp; },
  isPromise(val) { return val instanceof Promise; },
  isMap(val) { return val instanceof Map; },
  isSet(val) { return val instanceof Set; },
  isWeakMap(val) { return val instanceof WeakMap; },
  isWeakSet(val) { return val instanceof WeakSet; },
  isArrayBuffer(val) { return val instanceof ArrayBuffer; },
  isSharedArrayBuffer(val) { return typeof SharedArrayBuffer !== 'undefined' && val instanceof SharedArrayBuffer; },
  isDataView(val) { return val instanceof DataView; },
  isTypedArray(val) { return ArrayBuffer.isView(val) && !(val instanceof DataView); },
  isUint8Array(val) { return val instanceof Uint8Array; },
  isUint16Array(val) { return val instanceof Uint16Array; },
  isUint32Array(val) { return val instanceof Uint32Array; },
  isInt8Array(val) { return val instanceof Int8Array; },
  isInt16Array(val) { return val instanceof Int16Array; },
  isInt32Array(val) { return val instanceof Int32Array; },
  isFloat32Array(val) { return val instanceof Float32Array; },
  isFloat64Array(val) { return val instanceof Float64Array; },
  isBigInt64Array(val) { return typeof BigInt64Array !== 'undefined' && val instanceof BigInt64Array; },
  isBigUint64Array(val) { return typeof BigUint64Array !== 'undefined' && val instanceof BigUint64Array; },
  isGeneratorFunction(val) { return typeof val === 'function' && val.constructor?.name === 'GeneratorFunction'; },
  isGeneratorObject(val) { return val && typeof val.next === 'function' && typeof val.throw === 'function'; },
  isAsyncFunction(val) { return typeof val === 'function' && val.constructor?.name === 'AsyncFunction'; },
  isMapIterator(val) { return Object.prototype.toString.call(val) === '[object Map Iterator]'; },
  isSetIterator(val) { return Object.prototype.toString.call(val) === '[object Set Iterator]'; },
  isNativeError(val) { return val instanceof Error; },
  isStringObject(val) { return val instanceof String; },
  isNumberObject(val) { return val instanceof Number; },
  isBooleanObject(val) { return val instanceof Boolean; },
  isSymbolObject(val) { return Object.prototype.toString.call(val) === '[object Symbol]'; },
  isBoxedPrimitive(val) {
    return val instanceof String || val instanceof Number || val instanceof Boolean ||
      Object.prototype.toString.call(val) === '[object Symbol]';
  },
  isExternal() { return false; },
  isProxy() { return false; },
  isModuleNamespaceObject(val) { return val && val[Symbol.toStringTag] === 'Module'; },
};

// ── misc ──────────────────────────────────────────────────────────────────

function isDeepStrictEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isDeepStrictEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return a.toString() === b.toString();
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !isDeepStrictEqual(v, b.get(k))) return false;
    }
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!isDeepStrictEqual(a[key], b[key])) return false;
  }
  return true;
}

function isArray(ar) { return Array.isArray(ar); }
function isBoolean(arg) { return typeof arg === 'boolean'; }
function isNull(arg) { return arg === null; }
function isNullOrUndefined(arg) { return arg == null; }
function isNumber(arg) { return typeof arg === 'number'; }
function isString(arg) { return typeof arg === 'string'; }
function isSymbol(arg) { return typeof arg === 'symbol'; }
function isUndefined(arg) { return arg === undefined; }
function isRegExp(re) { return re instanceof RegExp; }
function isObject(arg) { return typeof arg === 'object' && arg !== null; }
function isDate(d) { return d instanceof Date; }
function isError(e) { return e instanceof Error; }
function isFunction(arg) { return typeof arg === 'function'; }
function isPrimitive(arg) { return arg === null || (typeof arg !== 'object' && typeof arg !== 'function'); }

module.exports = {
  promisify,
  callbackify,
  inherits,
  deprecate,
  format,
  formatWithOptions,
  inspect,
  types,
  isDeepStrictEqual,
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  isArray, isBoolean, isNull, isNullOrUndefined, isNumber, isString,
  isSymbol, isUndefined, isRegExp, isObject, isDate, isError, isFunction, isPrimitive,
};
