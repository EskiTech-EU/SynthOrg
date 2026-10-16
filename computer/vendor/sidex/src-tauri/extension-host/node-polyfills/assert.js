'use strict';

const { inspect, isDeepStrictEqual } = require('./util.js');

class AssertionError extends Error {
  constructor(options) {
    const { message, actual, expected, operator, stackStartFn } = typeof options === 'string'
      ? { message: options }
      : (options || {});

    const msg = message || `${inspect(actual)} ${operator || '!='} ${inspect(expected)}`;
    super(msg);
    this.name = 'AssertionError';
    this.code = 'ERR_ASSERTION';
    this.actual = actual;
    this.expected = expected;
    this.operator = operator || '';
    this.generatedMessage = !message;

    if (stackStartFn && Error.captureStackTrace) {
      Error.captureStackTrace(this, stackStartFn);
    }
  }
}

function innerFail(obj) {
  if (obj.message instanceof Error) throw obj.message;
  throw new AssertionError(obj);
}

function assert(value, message) {
  if (!value) {
    innerFail({
      actual: value,
      expected: true,
      message: message || 'The expression evaluated to a falsy value',
      operator: '==',
      stackStartFn: assert,
    });
  }
}

assert.AssertionError = AssertionError;

assert.ok = function ok(value, message) {
  if (!value) {
    innerFail({
      actual: value,
      expected: true,
      message: message || 'The expression evaluated to a falsy value',
      operator: '==',
      stackStartFn: ok,
    });
  }
};

assert.equal = function equal(actual, expected, message) {
  if (actual != expected) {
    innerFail({ actual, expected, message, operator: '==', stackStartFn: equal });
  }
};

assert.notEqual = function notEqual(actual, expected, message) {
  if (actual == expected) {
    innerFail({ actual, expected, message, operator: '!=', stackStartFn: notEqual });
  }
};

assert.strictEqual = function strictEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    innerFail({ actual, expected, message, operator: '===', stackStartFn: strictEqual });
  }
};

assert.notStrictEqual = function notStrictEqual(actual, expected, message) {
  if (Object.is(actual, expected)) {
    innerFail({ actual, expected, message, operator: '!==', stackStartFn: notStrictEqual });
  }
};

function deepEqual(actual, expected, message) {
  if (!isLooseDeepEqual(actual, expected)) {
    innerFail({ actual, expected, message, operator: 'deepEqual', stackStartFn: deepEqual });
  }
}
assert.deepEqual = deepEqual;

function notDeepEqual(actual, expected, message) {
  if (isLooseDeepEqual(actual, expected)) {
    innerFail({ actual, expected, message, operator: 'notDeepEqual', stackStartFn: notDeepEqual });
  }
}
assert.notDeepEqual = notDeepEqual;

function deepStrictEqual(actual, expected, message) {
  if (!isDeepStrictEqual(actual, expected)) {
    innerFail({ actual, expected, message, operator: 'deepStrictEqual', stackStartFn: deepStrictEqual });
  }
}
assert.deepStrictEqual = deepStrictEqual;

function notDeepStrictEqual(actual, expected, message) {
  if (isDeepStrictEqual(actual, expected)) {
    innerFail({ actual, expected, message, operator: 'notDeepStrictEqual', stackStartFn: notDeepStrictEqual });
  }
}
assert.notDeepStrictEqual = notDeepStrictEqual;

assert.throws = function throws(fn, errorOrValidator, message) {
  if (typeof fn !== 'function') {
    throw new TypeError('The "fn" argument must be of type Function');
  }
  let threw = false;
  let caught;
  try {
    fn();
  } catch (e) {
    threw = true;
    caught = e;
  }
  if (!threw) {
    innerFail({
      actual: undefined,
      expected: errorOrValidator,
      message: message || 'Missing expected exception',
      operator: 'throws',
      stackStartFn: throws,
    });
  }
  if (errorOrValidator) {
    _validateError(caught, errorOrValidator, message);
  }
};

assert.doesNotThrow = function doesNotThrow(fn, errorOrMessage, message) {
  if (typeof fn !== 'function') {
    throw new TypeError('The "fn" argument must be of type Function');
  }
  try {
    fn();
  } catch (e) {
    if (typeof errorOrMessage === 'string') {
      message = errorOrMessage;
      errorOrMessage = undefined;
    }
    if (!errorOrMessage || _errorMatches(e, errorOrMessage)) {
      innerFail({
        actual: e,
        expected: errorOrMessage,
        message: message || `Got unwanted exception: ${e.message}`,
        operator: 'doesNotThrow',
        stackStartFn: doesNotThrow,
      });
    }
    throw e;
  }
};

assert.rejects = async function rejects(asyncFn, errorOrValidator, message) {
  let fn;
  if (typeof asyncFn === 'function') {
    fn = asyncFn;
  } else if (asyncFn && typeof asyncFn.then === 'function') {
    fn = () => asyncFn;
  } else {
    throw new TypeError('The "asyncFn" argument must be a function or Promise');
  }

  let threw = false;
  let caught;
  try {
    await fn();
  } catch (e) {
    threw = true;
    caught = e;
  }
  if (!threw) {
    innerFail({
      actual: undefined,
      expected: errorOrValidator,
      message: message || 'Missing expected rejection',
      operator: 'rejects',
      stackStartFn: rejects,
    });
  }
  if (errorOrValidator) {
    _validateError(caught, errorOrValidator, message);
  }
};

assert.doesNotReject = async function doesNotReject(asyncFn, errorOrMessage, message) {
  let fn;
  if (typeof asyncFn === 'function') {
    fn = asyncFn;
  } else if (asyncFn && typeof asyncFn.then === 'function') {
    fn = () => asyncFn;
  } else {
    throw new TypeError('The "asyncFn" argument must be a function or Promise');
  }

  try {
    await fn();
  } catch (e) {
    if (typeof errorOrMessage === 'string') {
      message = errorOrMessage;
      errorOrMessage = undefined;
    }
    innerFail({
      actual: e,
      expected: errorOrMessage,
      message: message || `Got unwanted rejection: ${e.message}`,
      operator: 'doesNotReject',
      stackStartFn: doesNotReject,
    });
  }
};

assert.fail = function fail(message) {
  if (arguments.length === 0) message = 'Failed';
  if (message instanceof Error) throw message;
  innerFail({
    actual: undefined,
    expected: undefined,
    message,
    operator: 'fail',
    stackStartFn: fail,
  });
};

assert.ifError = function ifError(err) {
  if (err !== null && err !== undefined) {
    throw err instanceof Error ? err : new AssertionError({
      actual: err,
      expected: null,
      message: `ifError got unwanted exception: ${err}`,
      operator: 'ifError',
    });
  }
};

assert.match = function match(string, regexp, message) {
  if (!regexp.test(string)) {
    innerFail({
      actual: string,
      expected: regexp,
      message: message || `The input did not match the regular expression ${regexp}`,
      operator: 'match',
      stackStartFn: match,
    });
  }
};

assert.doesNotMatch = function doesNotMatch(string, regexp, message) {
  if (regexp.test(string)) {
    innerFail({
      actual: string,
      expected: regexp,
      message: message || `The input was expected to not match the regular expression ${regexp}`,
      operator: 'doesNotMatch',
      stackStartFn: doesNotMatch,
    });
  }
};

// Strict mode object that mirrors the API but uses strict comparisons
assert.strict = Object.assign(
  function strict(value, message) { assert.ok(value, message); },
  {
    ok: assert.ok,
    equal: assert.strictEqual,
    notEqual: assert.notStrictEqual,
    deepEqual: assert.deepStrictEqual,
    notDeepEqual: assert.notDeepStrictEqual,
    throws: assert.throws,
    rejects: assert.rejects,
    doesNotThrow: assert.doesNotThrow,
    doesNotReject: assert.doesNotReject,
    fail: assert.fail,
    ifError: assert.ifError,
    match: assert.match,
    doesNotMatch: assert.doesNotMatch,
    AssertionError,
  },
);

// ── Helpers ───────────────────────────────────────────────────────────────

function _validateError(caught, expected, message) {
  if (typeof expected === 'function') {
    if (expected.prototype !== undefined && caught instanceof expected) return;
    if (expected(caught) === true) return;
    innerFail({
      actual: caught,
      expected,
      message: message || `Error validator did not accept: ${inspect(caught)}`,
      operator: 'throws',
    });
  }
  if (expected instanceof RegExp) {
    if (expected.test(caught.message || String(caught))) return;
    innerFail({
      actual: caught,
      expected,
      message: message || `Error message did not match: ${expected}`,
      operator: 'throws',
    });
  }
  if (typeof expected === 'object' && expected !== null) {
    for (const key of Object.keys(expected)) {
      if (!isDeepStrictEqual(caught[key], expected[key])) {
        innerFail({
          actual: caught,
          expected,
          message: message || `Error property "${key}" did not match`,
          operator: 'throws',
        });
      }
    }
  }
}

function _errorMatches(err, expected) {
  if (typeof expected === 'function') return err instanceof expected;
  if (expected instanceof RegExp) return expected.test(err.message || String(err));
  return false;
}

function isLooseDeepEqual(a, b) {
  if (a == b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isLooseDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return a.toString() === b.toString();

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!isLooseDeepEqual(a[key], b[key])) return false;
  }
  return true;
}

module.exports = assert;
