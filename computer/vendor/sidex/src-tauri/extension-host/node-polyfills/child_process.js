'use strict';

const EventEmitter = require('./events');
const { syncInvoke, asyncInvoke } = require('./_sync_bridge');

let _nextId = 1;

// ── Readable stream stub ────────────────────────────────────────────────

class ReadableStub extends EventEmitter {
  constructor() {
    super();
    this.readable = true;
    this._ended = false;
  }

  _push(data) {
    if (this._ended) return;
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    this.emit('data', buf);
  }

  _end() {
    if (this._ended) return;
    this._ended = true;
    this.emit('end');
  }

  setEncoding() { return this; }
  pipe(dest) {
    this.on('data', (chunk) => dest.write(chunk));
    this.on('end', () => { if (typeof dest.end === 'function') dest.end(); });
    return dest;
  }
}

// ── Writable stream stub ────────────────────────────────────────────────

class WritableStub extends EventEmitter {
  constructor(processId) {
    super();
    this.writable = true;
    this._processId = processId;
  }

  write(data, encoding, cb) {
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    const str = typeof data === 'string' ? data : data.toString(encoding || 'utf8');
    asyncInvoke('process_stdin_write', { processId: this._processId, data: str })
      .then(() => { if (cb) cb(); })
      .catch((err) => this.emit('error', err));
    return true;
  }

  end(data, encoding, cb) {
    if (data != null) this.write(data, encoding);
    asyncInvoke('process_stdin_close', { processId: this._processId }).catch(() => {});
    if (typeof cb === 'function') cb();
    if (typeof encoding === 'function') encoding();
  }
}

// ── ChildProcess ────────────────────────────────────────────────────────

class ChildProcess extends EventEmitter {
  constructor(processId, command, args) {
    super();
    this.pid = processId;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.connected = true;
    this.spawnfile = command;
    this.spawnargs = [command, ...(args || [])];

    this.stdin = new WritableStub(processId);
    this.stdout = new ReadableStub();
    this.stderr = new ReadableStub();
    this.stdio = [this.stdin, this.stdout, this.stderr];

    this._pollHandle = null;
  }

  kill(signal) {
    signal = signal || 'SIGTERM';
    if (this.killed) return true;
    try {
      asyncInvoke('process_kill', { processId: this.pid, signal })
        .catch(() => {});
      this.killed = true;
      this.signalCode = signal;
      return true;
    } catch (_e) {
      return false;
    }
  }

  ref() { return this; }
  unref() { return this; }
  disconnect() { this.connected = false; }

  _startPolling() {
    const poll = () => {
      asyncInvoke('process_poll', { processId: this.pid })
        .then((state) => {
          if (state.stdout) this.stdout._push(state.stdout);
          if (state.stderr) this.stderr._push(state.stderr);

          if (state.exited) {
            this.exitCode = state.exitCode ?? null;
            this.signalCode = state.signal ?? null;
            this.stdout._end();
            this.stderr._end();
            this.emit('exit', this.exitCode, this.signalCode);
            this.emit('close', this.exitCode, this.signalCode);
          } else {
            this._pollHandle = setTimeout(poll, 50);
          }
        })
        .catch((err) => {
          this.emit('error', err);
          this.stdout._end();
          this.stderr._end();
          this.emit('close', 1, null);
        });
    };
    this._pollHandle = setTimeout(poll, 10);
  }
}

// ── spawn ───────────────────────────────────────────────────────────────

function spawn(command, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  options = options || {};

  const processId = _nextId++;

  const child = new ChildProcess(processId, command, args);

  asyncInvoke('process_spawn', {
    processId,
    command,
    args,
    cwd: options.cwd || undefined,
    env: options.env || undefined,
    shell: options.shell || false,
    detached: options.detached || false,
  }).then((result) => {
    child.pid = result.pid || processId;
    child._startPolling();
  }).catch((err) => {
    child.emit('error', err);
    child.emit('close', -1, null);
  });

  return child;
}

// ── exec ────────────────────────────────────────────────────────────────

function exec(command, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  options = options || {};

  const child = spawn(command, [], { ...options, shell: true });

  let stdout = '';
  let stderr = '';
  const maxBuffer = options.maxBuffer || 1024 * 1024;

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString(options.encoding || 'utf8');
    if (stdout.length > maxBuffer) {
      child.kill();
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString(options.encoding || 'utf8');
  });

  child.on('close', (code, signal) => {
    if (callback) {
      const err = code !== 0 ? Object.assign(new Error(`Command failed: ${command}`), { code, killed: child.killed, signal }) : null;
      callback(err, stdout, stderr);
    }
  });

  child.on('error', (err) => {
    if (callback) callback(err, stdout, stderr);
  });

  return child;
}

// ── execSync ────────────────────────────────────────────────────────────

function execSync(command, options) {
  options = options || {};
  const result = syncInvoke('process_exec_sync', {
    command,
    cwd: options.cwd || undefined,
    env: options.env || undefined,
    timeout: options.timeout || 0,
    maxBuffer: options.maxBuffer || 1024 * 1024,
    shell: options.shell !== undefined ? options.shell : true,
    input: options.input ? options.input.toString() : undefined,
  });

  if (result.status !== 0 && options.stdio !== 'ignore') {
    const err = new Error(`Command failed: ${command}\n${result.stderr || ''}`);
    err.status = result.status;
    err.stderr = result.stderr;
    err.stdout = result.stdout;
    err.signal = result.signal || null;
    throw err;
  }

  if (options.encoding === 'buffer' || options.encoding == null) {
    return typeof Buffer !== 'undefined'
      ? Buffer.from(result.stdout || '', 'utf8')
      : new TextEncoder().encode(result.stdout || '');
  }
  return result.stdout || '';
}

// ── execFile ────────────────────────────────────────────────────────────

function execFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; options = {}; }
  if (typeof options === 'function') { callback = options; options = {}; }
  if (!Array.isArray(args)) { options = args; args = []; }
  options = options || {};

  const child = spawn(file, args, options);

  let stdout = '';
  let stderr = '';
  const maxBuffer = options.maxBuffer || 1024 * 1024;

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString(options.encoding || 'utf8');
    if (stdout.length > maxBuffer) child.kill();
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString(options.encoding || 'utf8');
  });

  child.on('close', (code, signal) => {
    if (callback) {
      const err = code !== 0 ? Object.assign(new Error(`Command failed: ${file}`), { code, killed: child.killed, signal }) : null;
      callback(err, stdout, stderr);
    }
  });

  child.on('error', (err) => {
    if (callback) callback(err, stdout, stderr);
  });

  return child;
}

// ── execFileSync ────────────────────────────────────────────────────────

function execFileSync(file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  options = options || {};

  const result = syncInvoke('process_exec_sync', {
    command: file,
    args,
    cwd: options.cwd || undefined,
    env: options.env || undefined,
    timeout: options.timeout || 0,
    maxBuffer: options.maxBuffer || 1024 * 1024,
    shell: false,
    input: options.input ? options.input.toString() : undefined,
  });

  if (result.status !== 0) {
    const err = new Error(`Command failed: ${file} ${args.join(' ')}\n${result.stderr || ''}`);
    err.status = result.status;
    err.stderr = result.stderr;
    err.stdout = result.stdout;
    err.signal = result.signal || null;
    throw err;
  }

  if (options.encoding === 'buffer' || options.encoding == null) {
    return typeof Buffer !== 'undefined'
      ? Buffer.from(result.stdout || '', 'utf8')
      : new TextEncoder().encode(result.stdout || '');
  }
  return result.stdout || '';
}

// ── fork (simulated via spawn) ──────────────────────────────────────────

function fork(modulePath, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  options = options || {};

  const execPath = options.execPath || process?.execPath || 'node';
  const execArgv = options.execArgv || process?.execArgv || [];
  const forkArgs = [...execArgv, modulePath, ...args];

  const child = spawn(execPath, forkArgs, {
    ...options,
    stdio: options.stdio || 'pipe',
  });

  child.send = function send(message, _sendHandle, _options, callback) {
    if (typeof callback === 'undefined' && typeof _options === 'function') callback = _options;
    if (typeof callback === 'undefined' && typeof _sendHandle === 'function') callback = _sendHandle;
    const json = JSON.stringify(message);
    child.stdin.write(json + '\n', 'utf8', callback);
    return true;
  };

  return child;
}

// ── spawnSync ───────────────────────────────────────────────────────────

function spawnSync(command, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  options = options || {};

  try {
    const result = syncInvoke('process_exec_sync', {
      command,
      args,
      cwd: options.cwd || undefined,
      env: options.env || undefined,
      timeout: options.timeout || 0,
      maxBuffer: options.maxBuffer || 1024 * 1024,
      shell: options.shell || false,
      input: options.input ? options.input.toString() : undefined,
    });

    const encode = (str) => {
      if (!str) return typeof Buffer !== 'undefined' ? Buffer.alloc(0) : new Uint8Array(0);
      return typeof Buffer !== 'undefined' ? Buffer.from(str, 'utf8') : new TextEncoder().encode(str);
    };

    return {
      pid: result.pid || 0,
      output: [null, encode(result.stdout), encode(result.stderr)],
      stdout: encode(result.stdout),
      stderr: encode(result.stderr),
      status: result.status ?? null,
      signal: result.signal ?? null,
      error: undefined,
    };
  } catch (err) {
    return {
      pid: 0,
      output: [null, null, null],
      stdout: null,
      stderr: null,
      status: null,
      signal: null,
      error: err,
    };
  }
}

module.exports = {
  ChildProcess,
  spawn,
  exec,
  execSync,
  execFile,
  execFileSync,
  fork,
  spawnSync,
};
