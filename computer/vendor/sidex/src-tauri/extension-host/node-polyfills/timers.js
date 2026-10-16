'use strict';

const _activeTimers = new Map();
let _timerIdCounter = 1;

class Timeout {
  constructor(id, callback, delay, args, repeat) {
    this._id = id;
    this._callback = callback;
    this._delay = delay;
    this._args = args;
    this._repeat = repeat;
    this._destroyed = false;
    this._nativeId = null;
    this.ref = () => this;
    this.unref = () => this;
    this.hasRef = () => !this._destroyed;
    this[Symbol.toPrimitive] = () => this._id;
  }

  refresh() {
    if (this._destroyed) return this;
    if (this._nativeId !== null) {
      if (this._repeat) {
        clearInterval(this._nativeId);
      } else {
        clearTimeout(this._nativeId);
      }
    }
    this._schedule();
    return this;
  }

  close() {
    this._destroyed = true;
    if (this._nativeId !== null) {
      if (this._repeat) {
        clearInterval(this._nativeId);
      } else {
        clearTimeout(this._nativeId);
      }
      this._nativeId = null;
    }
    _activeTimers.delete(this._id);
  }

  _schedule() {
    if (this._repeat) {
      this._nativeId = setInterval(() => {
        if (!this._destroyed) this._callback(...this._args);
      }, this._delay);
    } else {
      this._nativeId = setTimeout(() => {
        if (!this._destroyed) {
          this._callback(...this._args);
          _activeTimers.delete(this._id);
        }
      }, this._delay);
    }
  }
}

class Immediate {
  constructor(id, callback, args) {
    this._id = id;
    this._callback = callback;
    this._args = args;
    this._destroyed = false;
    this.ref = () => this;
    this.unref = () => this;
    this.hasRef = () => !this._destroyed;
    this[Symbol.toPrimitive] = () => this._id;
  }
}

function setTimeout_(callback, delay, ...args) {
  if (typeof callback !== 'function') {
    throw new TypeError('callback is not a function');
  }
  const id = _timerIdCounter++;
  const timeout = new Timeout(id, callback, delay || 0, args, false);
  _activeTimers.set(id, timeout);
  timeout._schedule();
  return timeout;
}

function clearTimeout_(timer) {
  if (timer && typeof timer === 'object' && timer.close) {
    timer.close();
  } else if (typeof timer === 'number') {
    const t = _activeTimers.get(timer);
    if (t) t.close();
    else clearTimeout(timer);
  }
}

function setInterval_(callback, delay, ...args) {
  if (typeof callback !== 'function') {
    throw new TypeError('callback is not a function');
  }
  const id = _timerIdCounter++;
  const timeout = new Timeout(id, callback, delay || 0, args, true);
  _activeTimers.set(id, timeout);
  timeout._schedule();
  return timeout;
}

function clearInterval_(timer) {
  if (timer && typeof timer === 'object' && timer.close) {
    timer.close();
  } else if (typeof timer === 'number') {
    const t = _activeTimers.get(timer);
    if (t) t.close();
    else clearInterval(timer);
  }
}

function setImmediate_(callback, ...args) {
  if (typeof callback !== 'function') {
    throw new TypeError('callback is not a function');
  }
  const id = _timerIdCounter++;
  const imm = new Immediate(id, callback, args);
  _activeTimers.set(id, imm);

  const nativeId = typeof globalThis.setImmediate === 'function'
    ? globalThis.setImmediate(() => {
        if (!imm._destroyed) {
          callback(...args);
          _activeTimers.delete(id);
        }
      })
    : setTimeout(() => {
        if (!imm._destroyed) {
          callback(...args);
          _activeTimers.delete(id);
        }
      }, 0);

  imm._nativeId = nativeId;
  return imm;
}

function clearImmediate_(timer) {
  if (timer && typeof timer === 'object') {
    timer._destroyed = true;
    _activeTimers.delete(timer._id);
    if (timer._nativeId !== undefined) {
      if (typeof globalThis.clearImmediate === 'function') {
        globalThis.clearImmediate(timer._nativeId);
      } else {
        clearTimeout(timer._nativeId);
      }
    }
  }
}

// Promisified versions (timers/promises)
const promises = {
  setTimeout: function setTimeoutPromise(delay, value, options) {
    return new Promise((resolve, reject) => {
      const signal = options && options.signal;
      if (signal && signal.aborted) {
        return reject(new DOMException('The operation was aborted', 'AbortError'));
      }
      const timer = setTimeout_(() => resolve(value), delay);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout_(timer);
          reject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
      }
    });
  },

  setImmediate: function setImmediatePromise(value, options) {
    return new Promise((resolve, reject) => {
      const signal = options && options.signal;
      if (signal && signal.aborted) {
        return reject(new DOMException('The operation was aborted', 'AbortError'));
      }
      const imm = setImmediate_(() => resolve(value));
      if (signal) {
        signal.addEventListener('abort', () => {
          clearImmediate_(imm);
          reject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
      }
    });
  },

  setInterval: function setIntervalPromise(delay, value, options) {
    const signal = options && options.signal;
    return {
      [Symbol.asyncIterator]() {
        let timer = null;
        let resolve = null;
        let done = false;

        if (signal) {
          signal.addEventListener('abort', () => {
            done = true;
            if (timer) clearInterval_(timer);
            if (resolve) resolve({ value: undefined, done: true });
          }, { once: true });
        }

        timer = setInterval_(() => {
          if (resolve) {
            const r = resolve;
            resolve = null;
            r({ value, done: false });
          }
        }, delay);

        return {
          next() {
            if (done) return Promise.resolve({ value: undefined, done: true });
            return new Promise((r) => { resolve = r; });
          },
          return() {
            done = true;
            if (timer) clearInterval_(timer);
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  },
};

module.exports = {
  setTimeout: setTimeout_,
  clearTimeout: clearTimeout_,
  setInterval: setInterval_,
  clearInterval: clearInterval_,
  setImmediate: setImmediate_,
  clearImmediate: clearImmediate_,
  Timeout,
  Immediate,
  promises,
  active: deprecatedNoop,
  unenroll: deprecatedNoop,
  enroll: deprecatedNoop,
};

function deprecatedNoop() {}
