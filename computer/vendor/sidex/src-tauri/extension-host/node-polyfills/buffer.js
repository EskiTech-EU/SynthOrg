'use strict';

const HEX_CHARS = '0123456789abcdef';
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

function toUint8Array(data, encodingOrOffset, length) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) {
    const offset = typeof encodingOrOffset === 'number' ? encodingOrOffset : 0;
    const len = typeof length === 'number' ? length : data.byteLength - offset;
    return new Uint8Array(data, offset, len);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === 'string') {
    const encoding = (typeof encodingOrOffset === 'string' ? encodingOrOffset : 'utf8').toLowerCase();
    return encodeString(data, encoding);
  }
  if (Array.isArray(data)) return new Uint8Array(data);
  throw new TypeError('Invalid data type for Buffer.from');
}

function encodeString(str, encoding) {
  switch (encoding) {
    case 'utf8': case 'utf-8': return _encoder.encode(str);
    case 'ascii': case 'latin1': case 'binary': {
      const arr = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xff;
      return arr;
    }
    case 'base64': return base64Decode(str);
    case 'hex': return hexDecode(str);
    case 'utf16le': case 'ucs2': case 'ucs-2': {
      const arr = new Uint8Array(str.length * 2);
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        arr[i * 2] = code & 0xff;
        arr[i * 2 + 1] = (code >> 8) & 0xff;
      }
      return arr;
    }
    default: return _encoder.encode(str);
  }
}

function decodeBytes(arr, encoding) {
  switch (encoding) {
    case 'utf8': case 'utf-8': return _decoder.decode(arr);
    case 'ascii': {
      let s = '';
      for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i] & 0x7f);
      return s;
    }
    case 'latin1': case 'binary': {
      let s = '';
      for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
      return s;
    }
    case 'base64': return base64Encode(arr);
    case 'hex': return hexEncode(arr);
    case 'utf16le': case 'ucs2': case 'ucs-2': {
      let s = '';
      for (let i = 0; i < arr.length - 1; i += 2) {
        s += String.fromCharCode(arr[i] | (arr[i + 1] << 8));
      }
      return s;
    }
    default: return _decoder.decode(arr);
  }
}

function base64Encode(bytes) {
  let result = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    result += BASE64_CHARS[b0 >> 2];
    result += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    result += i + 1 < len ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    result += i + 2 < len ? BASE64_CHARS[b2 & 63] : '=';
  }
  return result;
}

function base64Decode(str) {
  str = str.replace(/[^A-Za-z0-9+/]/g, '');
  const len = str.length;
  const bytes = new Uint8Array(Math.floor(len * 3 / 4));
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const a = BASE64_CHARS.indexOf(str[i]);
    const b = BASE64_CHARS.indexOf(str[i + 1]);
    const c = BASE64_CHARS.indexOf(str[i + 2]);
    const d = BASE64_CHARS.indexOf(str[i + 3]);
    bytes[p++] = (a << 2) | (b >> 4);
    if (c >= 0) bytes[p++] = ((b & 15) << 4) | (c >> 2);
    if (d >= 0) bytes[p++] = ((c & 3) << 6) | d;
  }
  return bytes.subarray(0, p);
}

function hexEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += HEX_CHARS[bytes[i] >> 4] + HEX_CHARS[bytes[i] & 0xf];
  }
  return s;
}

function hexDecode(str) {
  str = str.replace(/[^0-9a-fA-F]/g, '');
  const bytes = new Uint8Array(str.length >> 1);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(str.substr(i * 2, 2), 16);
  }
  return bytes;
}

// ── Buffer Class ──────────────────────────────────────────────────────────

class Buffer extends Uint8Array {
  static from(data, encodingOrOffset, length) {
    const u8 = toUint8Array(data, encodingOrOffset, length);
    const buf = new Buffer(u8.length);
    buf.set(u8);
    return buf;
  }

  static alloc(size, fill, encoding) {
    const buf = new Buffer(size);
    if (fill !== undefined) {
      buf.fill(fill, 0, size, encoding);
    }
    return buf;
  }

  static allocUnsafe(size) {
    return new Buffer(size);
  }

  static concat(list, totalLength) {
    if (list.length === 0) return Buffer.alloc(0);
    if (totalLength === undefined) {
      totalLength = 0;
      for (const buf of list) totalLength += buf.length;
    }
    const result = Buffer.alloc(totalLength);
    let offset = 0;
    for (const buf of list) {
      const toCopy = Math.min(buf.length, totalLength - offset);
      result.set(buf instanceof Uint8Array ? buf : Buffer.from(buf), offset);
      offset += toCopy;
      if (offset >= totalLength) break;
    }
    return result;
  }

  static isBuffer(obj) {
    return obj instanceof Buffer;
  }

  static isEncoding(enc) {
    return ['utf8', 'utf-8', 'ascii', 'latin1', 'binary', 'base64', 'hex', 'utf16le', 'ucs2', 'ucs-2'].includes(
      (enc || '').toLowerCase(),
    );
  }

  static byteLength(string, encoding) {
    if (typeof string !== 'string') {
      return string.length || string.byteLength || 0;
    }
    return encodeString(string, (encoding || 'utf8').toLowerCase()).length;
  }

  static compare(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    if (a.length < b.length) return -1;
    if (a.length > b.length) return 1;
    return 0;
  }

  toString(encoding, start, end) {
    encoding = (encoding || 'utf8').toLowerCase();
    start = start || 0;
    end = end !== undefined ? end : this.length;
    const sub = this.subarray(start, end);
    return decodeBytes(sub, encoding);
  }

  toJSON() {
    return { type: 'Buffer', data: Array.from(this) };
  }

  slice(start, end) {
    const sliced = super.slice(start, end);
    const buf = new Buffer(sliced.length);
    buf.set(sliced);
    return buf;
  }

  subarray(start, end) {
    const sub = super.subarray(start, end);
    Object.setPrototypeOf(sub, Buffer.prototype);
    return sub;
  }

  copy(target, targetStart, sourceStart, sourceEnd) {
    targetStart = targetStart || 0;
    sourceStart = sourceStart || 0;
    sourceEnd = sourceEnd !== undefined ? sourceEnd : this.length;
    const toCopy = Math.min(sourceEnd - sourceStart, target.length - targetStart);
    target.set(this.subarray(sourceStart, sourceStart + toCopy), targetStart);
    return toCopy;
  }

  equals(other) {
    if (this.length !== other.length) return false;
    for (let i = 0; i < this.length; i++) {
      if (this[i] !== other[i]) return false;
    }
    return true;
  }

  compare(other) {
    return Buffer.compare(this, other);
  }

  indexOf(val, byteOffset, encoding) {
    return this._indexOfImpl(val, byteOffset, encoding, false);
  }

  lastIndexOf(val, byteOffset, encoding) {
    return this._indexOfImpl(val, byteOffset, encoding, true);
  }

  includes(val, byteOffset, encoding) {
    return this.indexOf(val, byteOffset, encoding) !== -1;
  }

  _indexOfImpl(val, byteOffset, encoding, reverse) {
    if (typeof byteOffset === 'string') {
      encoding = byteOffset;
      byteOffset = 0;
    }
    byteOffset = byteOffset || 0;

    let needle;
    if (typeof val === 'number') {
      needle = [val & 0xff];
    } else if (typeof val === 'string') {
      needle = encodeString(val, (encoding || 'utf8').toLowerCase());
    } else {
      needle = val;
    }

    if (needle.length === 0) return -1;

    if (reverse) {
      for (let i = Math.min(byteOffset || this.length - 1, this.length - needle.length); i >= 0; i--) {
        if (this._matchAt(i, needle)) return i;
      }
    } else {
      for (let i = byteOffset; i <= this.length - needle.length; i++) {
        if (this._matchAt(i, needle)) return i;
      }
    }
    return -1;
  }

  _matchAt(offset, needle) {
    for (let j = 0; j < needle.length; j++) {
      if (this[offset + j] !== needle[j]) return false;
    }
    return true;
  }

  fill(val, offset, end, encoding) {
    offset = offset || 0;
    end = end !== undefined ? end : this.length;
    if (typeof val === 'number') {
      super.fill(val, offset, end);
    } else if (typeof val === 'string') {
      const bytes = encodeString(val, (encoding || 'utf8').toLowerCase());
      for (let i = offset; i < end; i++) {
        this[i] = bytes[(i - offset) % bytes.length];
      }
    }
    return this;
  }

  write(string, offset, length, encoding) {
    if (typeof offset === 'string') {
      encoding = offset;
      offset = 0;
      length = this.length;
    } else if (typeof length === 'string') {
      encoding = length;
      length = this.length - (offset || 0);
    }
    offset = offset || 0;
    encoding = (encoding || 'utf8').toLowerCase();
    const bytes = encodeString(string, encoding);
    const toCopy = Math.min(bytes.length, length || this.length - offset, this.length - offset);
    this.set(bytes.subarray(0, toCopy), offset);
    return toCopy;
  }

  // Numeric read/write methods
  readUInt8(offset) { return this[offset]; }
  readUInt16BE(offset) { return (this[offset] << 8) | this[offset + 1]; }
  readUInt16LE(offset) { return this[offset] | (this[offset + 1] << 8); }
  readUInt32BE(offset) {
    return (this[offset] * 0x1000000) + ((this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]);
  }
  readUInt32LE(offset) {
    return ((this[offset + 3] * 0x1000000) + ((this[offset + 2] << 16) | (this[offset + 1] << 8) | this[offset])) >>> 0;
  }
  readInt8(offset) { const v = this[offset]; return v > 127 ? v - 256 : v; }
  readInt16BE(offset) { const v = this.readUInt16BE(offset); return v > 0x7fff ? v - 0x10000 : v; }
  readInt16LE(offset) { const v = this.readUInt16LE(offset); return v > 0x7fff ? v - 0x10000 : v; }
  readInt32BE(offset) { return (this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]; }
  readInt32LE(offset) { return this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16) | (this[offset + 3] << 24); }
  readFloatBE(offset) { return new DataView(this.buffer, this.byteOffset).getFloat32(offset, false); }
  readFloatLE(offset) { return new DataView(this.buffer, this.byteOffset).getFloat32(offset, true); }
  readDoubleBE(offset) { return new DataView(this.buffer, this.byteOffset).getFloat64(offset, false); }
  readDoubleLE(offset) { return new DataView(this.buffer, this.byteOffset).getFloat64(offset, true); }

  writeUInt8(value, offset) { this[offset] = value & 0xff; return offset + 1; }
  writeUInt16BE(value, offset) { this[offset] = (value >> 8) & 0xff; this[offset + 1] = value & 0xff; return offset + 2; }
  writeUInt16LE(value, offset) { this[offset] = value & 0xff; this[offset + 1] = (value >> 8) & 0xff; return offset + 2; }
  writeUInt32BE(value, offset) {
    this[offset] = (value >>> 24) & 0xff; this[offset + 1] = (value >>> 16) & 0xff;
    this[offset + 2] = (value >>> 8) & 0xff; this[offset + 3] = value & 0xff;
    return offset + 4;
  }
  writeUInt32LE(value, offset) {
    this[offset] = value & 0xff; this[offset + 1] = (value >>> 8) & 0xff;
    this[offset + 2] = (value >>> 16) & 0xff; this[offset + 3] = (value >>> 24) & 0xff;
    return offset + 4;
  }
  writeInt8(value, offset) { if (value < 0) value = 256 + value; this[offset] = value & 0xff; return offset + 1; }
  writeInt16BE(value, offset) { return this.writeUInt16BE(value < 0 ? 0x10000 + value : value, offset); }
  writeInt16LE(value, offset) { return this.writeUInt16LE(value < 0 ? 0x10000 + value : value, offset); }
  writeInt32BE(value, offset) { return this.writeUInt32BE(value < 0 ? 0x100000000 + value : value, offset); }
  writeInt32LE(value, offset) { return this.writeUInt32LE(value < 0 ? 0x100000000 + value : value, offset); }
  writeFloatBE(value, offset) { new DataView(this.buffer, this.byteOffset).setFloat32(offset, value, false); return offset + 4; }
  writeFloatLE(value, offset) { new DataView(this.buffer, this.byteOffset).setFloat32(offset, value, true); return offset + 4; }
  writeDoubleBE(value, offset) { new DataView(this.buffer, this.byteOffset).setFloat64(offset, value, false); return offset + 8; }
  writeDoubleLE(value, offset) { new DataView(this.buffer, this.byteOffset).setFloat64(offset, value, true); return offset + 8; }

  readBigInt64LE(offset) { return new DataView(this.buffer, this.byteOffset).getBigInt64(offset, true); }
  readBigInt64BE(offset) { return new DataView(this.buffer, this.byteOffset).getBigInt64(offset, false); }
  readBigUInt64LE(offset) { return new DataView(this.buffer, this.byteOffset).getBigUint64(offset, true); }
  readBigUInt64BE(offset) { return new DataView(this.buffer, this.byteOffset).getBigUint64(offset, false); }
  writeBigInt64LE(value, offset) { new DataView(this.buffer, this.byteOffset).setBigInt64(offset, value, true); return offset + 8; }
  writeBigInt64BE(value, offset) { new DataView(this.buffer, this.byteOffset).setBigInt64(offset, value, false); return offset + 8; }
  writeBigUInt64LE(value, offset) { new DataView(this.buffer, this.byteOffset).setBigUint64(offset, value, true); return offset + 8; }
  writeBigUInt64BE(value, offset) { new DataView(this.buffer, this.byteOffset).setBigUint64(offset, value, false); return offset + 8; }

  swap16() {
    for (let i = 0; i < this.length; i += 2) {
      const t = this[i]; this[i] = this[i + 1]; this[i + 1] = t;
    }
    return this;
  }

  swap32() {
    for (let i = 0; i < this.length; i += 4) {
      const t0 = this[i]; const t1 = this[i + 1];
      this[i] = this[i + 3]; this[i + 1] = this[i + 2];
      this[i + 2] = t1; this[i + 3] = t0;
    }
    return this;
  }
}

Buffer.poolSize = 8192;

module.exports = { Buffer };
