'use strict';

class EventEmitter {
  constructor() {
    this._events = Object.create(null);
    this._maxListeners = EventEmitter.defaultMaxListeners;
  }

  static get defaultMaxListeners() {
    return 10;
  }

  static set defaultMaxListeners(n) {
    // noop for compat
  }

  setMaxListeners(n) {
    this._maxListeners = n;
    return this;
  }

  getMaxListeners() {
    return this._maxListeners;
  }

  emit(type, ...args) {
    const handlers = this._events[type];
    if (!handlers || handlers.length === 0) {
      if (type === 'error') {
        const err = args[0];
        throw err instanceof Error ? err : new Error('Unhandled error: ' + err);
      }
      return false;
    }
    for (const handler of handlers.slice()) {
      handler.apply(this, args);
    }
    return true;
  }

  on(type, listener) {
    return this.addListener(type, listener);
  }

  addListener(type, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('listener must be a function');
    }
    if (!this._events[type]) {
      this._events[type] = [];
    }
    this._events[type].push(listener);
    this.emit('newListener', type, listener);
    return this;
  }

  once(type, listener) {
    const wrapped = (...args) => {
      this.removeListener(type, wrapped);
      listener.apply(this, args);
    };
    wrapped._original = listener;
    return this.addListener(type, wrapped);
  }

  removeListener(type, listener) {
    const list = this._events[type];
    if (!list) return this;
    const idx = list.findIndex(fn => fn === listener || fn._original === listener);
    if (idx >= 0) {
      list.splice(idx, 1);
      if (list.length === 0) delete this._events[type];
      this.emit('removeListener', type, listener);
    }
    return this;
  }

  off(type, listener) {
    return this.removeListener(type, listener);
  }

  removeAllListeners(type) {
    if (type !== undefined) {
      delete this._events[type];
    } else {
      this._events = Object.create(null);
    }
    return this;
  }

  listeners(type) {
    const list = this._events[type];
    if (!list) return [];
    return list.map(fn => fn._original || fn);
  }

  rawListeners(type) {
    return (this._events[type] || []).slice();
  }

  listenerCount(type) {
    const list = this._events[type];
    return list ? list.length : 0;
  }

  prependListener(type, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('listener must be a function');
    }
    if (!this._events[type]) {
      this._events[type] = [];
    }
    this._events[type].unshift(listener);
    return this;
  }

  prependOnceListener(type, listener) {
    const wrapped = (...args) => {
      this.removeListener(type, wrapped);
      listener.apply(this, args);
    };
    wrapped._original = listener;
    return this.prependListener(type, wrapped);
  }

  eventNames() {
    return Object.keys(this._events);
  }
}

EventEmitter.EventEmitter = EventEmitter;
EventEmitter.once = function once(emitter, name) {
  return new Promise((resolve, reject) => {
    const onEvent = (...args) => {
      emitter.removeListener('error', onError);
      resolve(args);
    };
    const onError = (err) => {
      emitter.removeListener(name, onEvent);
      reject(err);
    };
    emitter.once(name, onEvent);
    if (name !== 'error') {
      emitter.once('error', onError);
    }
  });
};

EventEmitter.on = function on(emitter, event) {
  const unconsumed = [];
  const unconsumedPromises = [];
  let done = false;

  emitter.on(event, handler);
  emitter.on('error', errorHandler);

  const iterator = {
    next() {
      if (unconsumed.length) {
        return Promise.resolve({ value: unconsumed.shift(), done: false });
      }
      if (done) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((resolve) => unconsumedPromises.push(resolve));
    },
    return() {
      emitter.removeListener(event, handler);
      emitter.removeListener('error', errorHandler);
      done = true;
      for (const resolve of unconsumedPromises) {
        resolve({ value: undefined, done: true });
      }
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(err) {
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  function handler(...args) {
    if (unconsumedPromises.length) {
      unconsumedPromises.shift()({ value: args, done: false });
    } else {
      unconsumed.push(args);
    }
  }

  function errorHandler(err) {
    done = true;
    if (unconsumedPromises.length) {
      unconsumedPromises.shift()({ value: undefined, done: true });
    }
  }

  return iterator;
};

module.exports = EventEmitter;
