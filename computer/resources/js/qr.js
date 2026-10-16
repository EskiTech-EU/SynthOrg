/**
 * SynthOrg - QR codes, drawn here.
 *
 * What the phone reads to be paired is a secret: it is turned into a QR
 * code in the page, by this file alone, and goes nowhere else. Text made of
 * digits, capital letters and " $%*+-./:" is written in the alphanumeric
 * mode, which takes less room; anything else as bytes (UTF-8). Error
 * correction level M, versions 1 to 40, the mask with the lowest penalty.
 *
 *   window.synthQr.matrix(text)  -> rows of booleans (true: dark)
 *   window.synthQr.svg(text)     -> the code as an SVG, with its quiet zone
 */
(function (root) {
  'use strict';

  const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  // Level M, versions 1..40: error correction codewords per block, and the blocks.
  const EC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
  const LEVEL_M = 0;

  /** The modules that hold data and error correction, function patterns taken away. */
  function rawModules(version) {
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const align = Math.floor(version / 7) + 2;
      result -= (25 * align - 10) * align - 55;
      if (version >= 7) result -= 36;
    }
    return result;
  }

  function dataCodewords(version) {
    return Math.floor(rawModules(version) / 8) - EC_PER_BLOCK[version - 1] * BLOCKS[version - 1];
  }

  /* ---- Reed-Solomon over GF(256), polynomial 0x11D ---- */

  function multiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function divisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let rootOf = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = multiply(result[j], rootOf);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      rootOf = multiply(rootOf, 0x02);
    }
    return result;
  }

  function remainder(data, generator) {
    const result = generator.map(() => 0);
    for (const byte of data) {
      const factor = byte ^ result.shift();
      result.push(0);
      generator.forEach((coefficient, i) => { result[i] ^= multiply(coefficient, factor); });
    }
    return result;
  }

  /* ---- the text as bits ---- */

  function bitsOf(text, version) {
    const bits = [];
    const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    const alphanumeric = [...text].every(char => ALPHANUMERIC.includes(char));
    if (alphanumeric) {
      push(0b0010, 4);
      push(text.length, version < 10 ? 9 : version < 27 ? 11 : 13);
      for (let i = 0; i + 1 < text.length; i += 2) push(ALPHANUMERIC.indexOf(text[i]) * 45 + ALPHANUMERIC.indexOf(text[i + 1]), 11);
      if (text.length % 2) push(ALPHANUMERIC.indexOf(text[text.length - 1]), 6);
    } else {
      const bytes = new TextEncoder().encode(text);
      push(0b0100, 4);
      push(bytes.length, version < 10 ? 8 : 16);
      bytes.forEach(byte => push(byte, 8));
    }
    return bits;
  }

  function codewords(text) {
    for (let version = 1; version <= 40; version++) {
      const capacity = dataCodewords(version) * 8;
      const bits = bitsOf(text, version);
      if (bits.length > capacity) continue;
      for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
      while (bits.length % 8) bits.push(0);
      for (let pad = 0xEC; bits.length < capacity; pad ^= 0xEC ^ 0x11) for (let i = 7; i >= 0; i--) bits.push((pad >>> i) & 1);
      const data = [];
      for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
      return { version, data };
    }
    throw new Error('Testo troppo lungo per un codice QR.');
  }

  /** The data cut in blocks, each with its error correction, interleaved as they are drawn. */
  function interleave(version, data) {
    const blocks = BLOCKS[version - 1];
    const ecLength = EC_PER_BLOCK[version - 1];
    const total = Math.floor(rawModules(version) / 8);
    const shortBlocks = blocks - total % blocks;
    const shortLength = Math.floor(total / blocks);
    const generator = divisor(ecLength);
    const parts = [];
    for (let i = 0, at = 0; i < blocks; i++) {
      const length = shortLength - ecLength + (i < shortBlocks ? 0 : 1);
      const block = data.slice(at, at + length);
      at += length;
      const ec = remainder(block, generator);
      // A short block leaves its last data place empty: skipped when interleaving.
      if (i < shortBlocks) block.push(null);
      parts.push(block.concat(ec));
    }
    const result = [];
    for (let i = 0; i < parts[0].length; i++) {
      parts.forEach(part => { if (part[i] !== null) result.push(part[i]); });
    }
    return result;
  }

  /* ---- the drawing ---- */

  function alignmentPositions(version) {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const result = [6];
    for (let position = version * 4 + 10; result.length < count; position -= step) result.splice(1, 0, position);
    return result;
  }

  function draw(version, stream) {
    const size = version * 4 + 17;
    const dark = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, value) => { dark[y][x] = Boolean(value); fixed[y][x] = true; };

    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, distance !== 2 && distance !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const align = alignmentPositions(version);
    align.forEach((cy, i) => align.forEach((cx, j) => {
      const corner = (i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0);
      if (corner) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));

    const format = (mask) => {
      const data = (LEVEL_M << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412;
      const bit = (i) => (bits >>> i) & 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    format(0);
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + i % 3;
        const b = Math.floor(i / 3);
        set(a, b, (bits >>> i) & 1);
        set(b, a, (bits >>> i) & 1);
      }
    }

    // The codewords, in a zigzag from the bottom right, two columns at a time.
    let index = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vertical : vertical;
          if (fixed[y][x] || index >= stream.length * 8) continue;
          dark[y][x] = ((stream[index >>> 3] >>> (7 - (index & 7))) & 1) === 1;
          index++;
        }
      }
    }

    const MASKS = [
      (x, y) => (x + y) % 2 === 0,
      (x, y) => y % 2 === 0,
      (x) => x % 3 === 0,
      (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
      (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
      (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
      (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0
    ];
    const apply = (mask) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (!fixed[y][x] && MASKS[mask](x, y)) dark[y][x] = !dark[y][x];
      }
    };

    const penalty = () => {
      let result = 0;
      const runs = (line) => {
        let run = 1;
        for (let i = 1; i <= line.length; i++) {
          if (i < line.length && line[i] === line[i - 1]) { run++; continue; }
          if (run >= 5) result += run - 2;
          run = 1;
        }
        // A finder-like pattern with four light modules on a side.
        const text = line.map(v => (v ? '1' : '0')).join('');
        for (const pattern of ['10111010000', '00001011101']) {
          for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + 1)) result += 40;
        }
      };
      for (let y = 0; y < size; y++) runs(dark[y]);
      for (let x = 0; x < size; x++) runs(dark.map(row => row[x]));
      for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) {
        const value = dark[y][x];
        if (value === dark[y][x + 1] && value === dark[y + 1][x] && value === dark[y + 1][x + 1]) result += 3;
      }
      const count = dark.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
      result += Math.floor(Math.abs(count * 20 - size * size * 10) / (size * size)) * 10;
      return result;
    };

    let best = 0;
    let least = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      apply(mask);
      format(mask);
      const found = penalty();
      if (found < least) { least = found; best = mask; }
      apply(mask);
    }
    apply(best);
    format(best);
    return dark;
  }

  function matrix(text) {
    const { version, data } = codewords(String(text));
    return draw(version, interleave(version, data));
  }

  /** The code as an SVG: dark modules in `color`, on `background`, four modules of quiet zone around. */
  function svg(text, { color = '#000', background = '#fff', title = '' } = {}) {
    const rows = matrix(text);
    const quiet = 4;
    const size = rows.length + quiet * 2;
    let path = '';
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (!row[x]) continue;
        let end = x;
        while (end + 1 < row.length && row[end + 1]) end++;
        path += `M${x + quiet} ${y + quiet}h${end - x + 1}v1h-${end - x + 1}z`;
        x = end;
      }
    });
    const label = String(title).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img"${label ? ` aria-label="${label}"` : ''}>`
      + `<rect width="${size}" height="${size}" fill="${background}"/><path d="${path}" fill="${color}"/></svg>`;
  }

  const api = { matrix, svg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.synthQr = api;
})(typeof window !== 'undefined' ? window : globalThis);
