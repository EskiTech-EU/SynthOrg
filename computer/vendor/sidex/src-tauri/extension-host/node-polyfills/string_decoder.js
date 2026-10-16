'use strict';

const { Buffer } = require('./buffer.js');

class StringDecoder {
  constructor(encoding) {
    this.encoding = (encoding || 'utf8').toLowerCase().replace(/[-_]/g, '');
    if (this.encoding === 'utf8') this.encoding = 'utf8';

    this._decoder = null;
    this._incomplete = null;
    this._incompleteLen = 0;

    switch (this.encoding) {
      case 'utf8':
        this._surrogateSize = 4;
        this._decoder = new TextDecoder('utf-8', { fatal: false });
        break;
      case 'utf16le':
      case 'ucs2':
        this._surrogateSize = 2;
        this._decoder = new TextDecoder('utf-16le', { fatal: false });
        break;
      case 'base64':
        this._surrogateSize = 3;
        break;
      case 'ascii':
      case 'latin1':
      case 'binary':
        this._surrogateSize = 1;
        break;
      case 'hex':
        this._surrogateSize = 2;
        break;
      default:
        this._surrogateSize = 4;
        this._decoder = new TextDecoder('utf-8', { fatal: false });
        break;
    }

    this._pendingBytes = [];
  }

  write(buf) {
    if (!buf || buf.length === 0) return '';

    if (typeof buf === 'string') {
      buf = Buffer.from(buf);
    } else if (!(buf instanceof Uint8Array)) {
      buf = new Uint8Array(buf);
    }

    let bytes;
    if (this._pendingBytes.length > 0) {
      const combined = new Uint8Array(this._pendingBytes.length + buf.length);
      combined.set(this._pendingBytes);
      combined.set(buf, this._pendingBytes.length);
      bytes = combined;
      this._pendingBytes = [];
    } else {
      bytes = buf;
    }

    switch (this.encoding) {
      case 'utf8':
        return this._writeUtf8(bytes);
      case 'utf16le':
      case 'ucs2':
        return this._writeUtf16le(bytes);
      case 'ascii':
        return this._decodeAscii(bytes);
      case 'latin1':
      case 'binary':
        return this._decodeLatin1(bytes);
      case 'base64':
        return this._writeBase64(bytes);
      case 'hex':
        return this._writeHex(bytes);
      default:
        return this._decoder.decode(bytes, { stream: true });
    }
  }

  end(buf) {
    let result = '';
    if (buf && buf.length > 0) {
      result = this.write(buf);
    }

    if (this._pendingBytes.length > 0) {
      switch (this.encoding) {
        case 'utf8':
          result += this._decoder
            ? this._decoder.decode(new Uint8Array(this._pendingBytes))
            : this._decodeLatin1(new Uint8Array(this._pendingBytes));
          break;
        case 'utf16le':
        case 'ucs2':
          result += this._decoder
            ? this._decoder.decode(new Uint8Array(this._pendingBytes))
            : '';
          break;
        case 'base64':
          result += Buffer.from(new Uint8Array(this._pendingBytes)).toString('base64');
          break;
        case 'hex':
          result += Buffer.from(new Uint8Array(this._pendingBytes)).toString('hex');
          break;
        default:
          result += this._decodeLatin1(new Uint8Array(this._pendingBytes));
          break;
      }
      this._pendingBytes = [];
    }

    return result;
  }

  _writeUtf8(bytes) {
    let completeEnd = bytes.length;
    if (completeEnd > 0) {
      const last = bytes[completeEnd - 1];
      if (last >= 0x80) {
        let trailingNeeded = 0;
        if ((last & 0xe0) === 0xc0) trailingNeeded = 2;
        else if ((last & 0xf0) === 0xe0) trailingNeeded = 3;
        else if ((last & 0xf8) === 0xf0) trailingNeeded = 4;
        else {
          let j = completeEnd - 1;
          while (j > 0 && j > completeEnd - 4 && (bytes[j] & 0xc0) === 0x80) j--;
          const lead = bytes[j];
          let needed = 1;
          if ((lead & 0xe0) === 0xc0) needed = 2;
          else if ((lead & 0xf0) === 0xe0) needed = 3;
          else if ((lead & 0xf8) === 0xf0) needed = 4;
          const available = completeEnd - j;
          if (available < needed) {
            completeEnd = j;
            trailingNeeded = 0;
            this._pendingBytes = Array.from(bytes.subarray(j));
          }
        }
        if (trailingNeeded > 0) {
          let j = completeEnd - 1;
          while (j > 0 && j > completeEnd - trailingNeeded && (bytes[j] & 0xc0) === 0x80) j--;
          const available = completeEnd - j;
          if (available < trailingNeeded) {
            completeEnd = j;
            this._pendingBytes = Array.from(bytes.subarray(j));
          }
        }
      }
    }

    if (completeEnd === 0) return '';
    return this._decoder
      ? this._decoder.decode(bytes.subarray(0, completeEnd), { stream: true })
      : new TextDecoder('utf-8').decode(bytes.subarray(0, completeEnd));
  }

  _writeUtf16le(bytes) {
    if (bytes.length % 2 !== 0) {
      this._pendingBytes = [bytes[bytes.length - 1]];
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    if (bytes.length === 0) return '';
    return this._decoder
      ? this._decoder.decode(bytes, { stream: true })
      : new TextDecoder('utf-16le').decode(bytes);
  }

  _writeBase64(bytes) {
    const remainder = bytes.length % 3;
    if (remainder > 0) {
      this._pendingBytes = Array.from(bytes.subarray(bytes.length - remainder));
      bytes = bytes.subarray(0, bytes.length - remainder);
    }
    if (bytes.length === 0) return '';
    return Buffer.from(bytes).toString('base64');
  }

  _writeHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return s;
  }

  _decodeAscii(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0x7f);
    return s;
  }

  _decodeLatin1(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
}

module.exports = { StringDecoder };
