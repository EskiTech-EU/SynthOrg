'use strict';

const { syncInvoke } = require('./_sync_bridge');

let _cachedInfo = null;

function getInfo() {
  if (!_cachedInfo) {
    try {
      _cachedInfo = syncInvoke('os_info', {});
    } catch (_e) {
      _cachedInfo = {};
    }
  }
  return _cachedInfo;
}

function platform() {
  const info = getInfo();
  if (info.platform) return info.platform;
  if (typeof globalThis.__sidexPlatform === 'string') return globalThis.__sidexPlatform;
  return 'linux';
}

function arch() {
  const info = getInfo();
  if (info.arch) return info.arch;
  return 'x64';
}

function homedir() {
  const info = getInfo();
  if (info.homedir) return info.homedir;
  return '/home/user';
}

function tmpdir() {
  const info = getInfo();
  if (info.tmpdir) return info.tmpdir;
  if (platform() === 'win32') return 'C:\\Users\\Default\\AppData\\Local\\Temp';
  if (platform() === 'darwin') return '/tmp';
  return '/tmp';
}

function hostname() {
  const info = getInfo();
  if (info.hostname) return info.hostname;
  return 'localhost';
}

function type() {
  const p = platform();
  if (p === 'darwin') return 'Darwin';
  if (p === 'win32') return 'Windows_NT';
  return 'Linux';
}

function release() {
  const info = getInfo();
  if (info.release) return info.release;
  return '0.0.0';
}

function totalmem() {
  const info = getInfo();
  if (typeof info.totalmem === 'number') return info.totalmem;
  return 8 * 1024 * 1024 * 1024;
}

function freemem() {
  try {
    const info = syncInvoke('os_info', {});
    if (typeof info.freemem === 'number') return info.freemem;
  } catch (_e) { /* fall through */ }
  return 4 * 1024 * 1024 * 1024;
}

function cpus() {
  const info = getInfo();
  if (Array.isArray(info.cpus) && info.cpus.length > 0) return info.cpus;
  const count = (typeof info.cpu_count === 'number') ? info.cpu_count : 4;
  const model = info.cpu_model || 'Unknown CPU';
  const speed = info.cpu_speed || 2400;
  const result = [];
  for (let i = 0; i < count; i++) {
    result.push({
      model: model,
      speed: speed,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    });
  }
  return result;
}

function networkInterfaces() {
  const info = getInfo();
  if (info.networkInterfaces) return info.networkInterfaces;
  return {
    lo: [
      {
        address: '127.0.0.1',
        netmask: '255.0.0.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: true,
        cidr: '127.0.0.1/8',
      },
    ],
  };
}

function userInfo(options) {
  const info = getInfo();
  const encoding = (options && options.encoding) || 'utf8';

  const username = info.username || info.user || 'user';
  const home = info.homedir || homedir();
  const shell = info.shell || (platform() === 'win32' ? '' : '/bin/sh');
  const uid = typeof info.uid === 'number' ? info.uid : -1;
  const gid = typeof info.gid === 'number' ? info.gid : -1;

  return {
    uid,
    gid,
    username: encoding === 'buffer' ? Buffer.from(username) : username,
    homedir: encoding === 'buffer' ? Buffer.from(home) : home,
    shell: encoding === 'buffer' ? Buffer.from(shell) : shell,
  };
}

function endianness() {
  const buf = new ArrayBuffer(2);
  new DataView(buf).setInt16(0, 256, true);
  return new Int16Array(buf)[0] === 256 ? 'LE' : 'BE';
}

function uptime() {
  try {
    const info = syncInvoke('os_info', {});
    if (typeof info.uptime === 'number') return info.uptime;
  } catch (_e) { /* fall through */ }
  return 0;
}

function loadavg() {
  try {
    const info = syncInvoke('os_info', {});
    if (Array.isArray(info.loadavg)) return info.loadavg;
  } catch (_e) { /* fall through */ }
  return [0, 0, 0];
}

const EOL = platform() === 'win32' ? '\r\n' : '\n';

const constants = {
  signals: {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
    SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
    SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18,
    SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23,
    SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28,
    SIGIO: 29, SIGPWR: 30, SIGSYS: 31,
  },
  errno: {
    E2BIG: -7, EACCES: -13, EADDRINUSE: -98, EADDRNOTAVAIL: -99,
    EAFNOSUPPORT: -97, EAGAIN: -11, EALREADY: -114, EBADF: -9,
    EBUSY: -16, ECANCELED: -125, ECHILD: -10, ECONNABORTED: -103,
    ECONNREFUSED: -111, ECONNRESET: -104, EDEADLK: -35, EDESTADDRREQ: -89,
    EDOM: -33, EEXIST: -17, EFAULT: -14, EFBIG: -27, EHOSTUNREACH: -113,
    EINTR: -4, EINVAL: -22, EIO: -5, EISCONN: -106, EISDIR: -21,
    ELOOP: -40, EMFILE: -24, EMLINK: -31, EMSGSIZE: -90,
    ENAMETOOLONG: -36, ENETDOWN: -100, ENETUNREACH: -101, ENFILE: -23,
    ENOBUFS: -105, ENODEV: -19, ENOENT: -2, ENOMEM: -12, ENOSPC: -28,
    ENOSYS: -38, ENOTCONN: -107, ENOTDIR: -20, ENOTEMPTY: -39,
    ENOTSOCK: -88, ENOTSUP: -95, EPERM: -1, EPIPE: -32, ERANGE: -34,
    EROFS: -30, ETIMEDOUT: -110, EXDEV: -18,
  },
  priority: {
    PRIORITY_LOW: 19,
    PRIORITY_BELOW_NORMAL: 10,
    PRIORITY_NORMAL: 0,
    PRIORITY_ABOVE_NORMAL: -7,
    PRIORITY_HIGH: -14,
    PRIORITY_HIGHEST: -20,
  },
};

module.exports = {
  platform,
  arch,
  homedir,
  tmpdir,
  hostname,
  type,
  release,
  totalmem,
  freemem,
  cpus,
  networkInterfaces,
  userInfo,
  endianness,
  uptime,
  loadavg,
  EOL,
  constants,
  devNull: platform() === 'win32' ? '\\\\.\\nul' : '/dev/null',
  version: 'sidex-polyfill',
};
