/**
 * SynthOrg - the character's desk, and the files it hands over.
 *
 * Beside the character, on the stage, stand a small computer and a printer,
 * drawn in code like it. The computer is the character's: it works there on
 * the tasks (the Master does them), and while one is under way its screen
 * writes. What
 * a task made comes out of the machine: a sheet out of the printer for a
 * document, a photo for a picture, a disc out of the computer's drive for a
 * sound or a video. The character goes to take it, carries it down and lays
 * it on the small table in the lower part of the stage, which holds the
 * latest ones. A file is looked at by coming close to it: a picture or a
 * document grows from the table, a disc is played on the computer's screen.
 * All that was handed is among the artifacts, in the column of the chats.
 *
 * What was handed is kept on the server (handed_files): the link of the file
 * in the workspace of the chat of the tasks, never the file. They are read a
 * page at a time, the latest first.
 *
 * The numbers (what comes out for a file, how a file is looked at, where
 * things are drawn, what the character is told) are functions of their own,
 * kept apart from the page. The rest are methods of the section's object
 * (realtime.js), kept in a file of their own.
 */
(function () {
  'use strict';

  // The drawing's own units: the machine is drawn in a box this big.
  const VIEW = { width: 220, height: 170 };
  const SCREEN = { x: 23, y: 31, width: 76, height: 56 };
  const SHEET = { x: 147, y: 124, width: 48, height: 32 };   // the sheet, out of the printer
  const DISC = { x: 24, y: 128, width: 46, height: 14 };     // the disc, on the drive's tray
  const PRINTER = { x: 130, y: 96, width: 84, height: 44 };
  const DRIVE = { x: 6, y: 112, width: 110, height: 40 };
  const MONITOR = { x: 14, y: 22, width: 94, height: 80 };
  const KEYBOARD = { x: -28, y: 153, width: 52, height: 12 };
  const OUT_MS = { sheet: 1100, photo: 1400, disc: 900 };    // how long a thing takes to come out
  const PAGE = 30;                 // files read at a time
  const TABLE = 4;                 // the latest files, laid on the table
  // A speaker on its stand at each side of the computer, as far from its middle as the other and standing on
  // the same ground; the printer past the right one, moved there from where its parts are drawn.
  const SPEAKER = { width: 32, height: 106, gap: 14 };
  const GROUND = 156;
  const SPEAKERS = [MONITOR.x - SPEAKER.gap - SPEAKER.width, MONITOR.x + MONITOR.width + SPEAKER.gap]
    .map(x => ({ x, y: GROUND - SPEAKER.height, width: SPEAKER.width, height: SPEAKER.height }));
  const PRINTER_MOVED = SPEAKERS[1].x + SPEAKER.width + 8 - PRINTER.x;
  const moved = (part) => ({ ...part, x: part.x + PRINTER_MOVED });
  // Close to the computer: the part of the drawing that fills the stage, the computer between its speakers.
  const CLOSE = { x: SPEAKERS[0].x, y: MONITOR.y - 4, width: SPEAKERS[1].x + SPEAKER.width - SPEAKERS[0].x, height: KEYBOARD.y + KEYBOARD.height + 4 - (MONITOR.y - 4) };

  const TEXT_MOST = 200000;        // characters of a document shown in the section; the whole of it opens full screen
  const ROWS_MOST = 500;
  const TEXT_FILE = /\.(txt|log|json|ya?ml|xml|html?|css|js|mjs|ts|jsx|tsx|py|rs|go|java|c|h|cpp|sh|sql|ini|toml|env|asm|tex|srt|vtt)$/;

  const clamp = (v, low, high) => Math.min(high, Math.max(low, v));
  const ease = (p) => 1 - Math.pow(1 - clamp(p, 0, 1), 3);

  /** What comes out of the machine for a kind of file. */
  function outOf(kind) {
    return kind === 'image' ? 'photo' : kind === 'audio' || kind === 'video' ? 'disc' : 'sheet';
  }

  /** How a file is looked at, going by its kind and its name. */
  function viewOf(file) {
    if (['image', 'video', 'audio'].includes(file?.kind)) return file.kind;
    const name = String(file?.filename || '').toLowerCase();
    if (name.endsWith('.pdf')) return 'pdf';
    if (/\.(md|markdown)$/.test(name)) return 'markdown';
    if (/\.(csv|tsv)$/.test(name)) return 'table';
    return TEXT_FILE.test(name) ? 'text' : 'none';
  }

  /** The letters written on a sheet: what kind of document it is. */
  function badgeOf(filename) {
    const m = /\.([a-z0-9]{1,10})$/i.exec(String(filename || ''));
    return m ? m[1].slice(0, 4).toUpperCase() : '';
  }

  /** A part of the drawing, on the page: `rect` is where the drawing is on the page. */
  function onPage(part, rect) {
    const k = rect.width / VIEW.width;
    return { left: rect.left + part.x * k, top: rect.top + part.y * k, width: part.width * k, height: part.height * k };
  }

  /** Where what the character carries is drawn, from where the character is: at its side, as big as it can hold. */
  function carried(box) {
    const width = box.width * 0.78;
    return { left: box.left + box.width * 0.56, top: box.top + box.height * 0.34, width };
  }

  /** How far out a thing is at a moment (0 to 1) of its coming out: it starts fast and settles. */
  function outAt(moment) { return ease(moment); }

  /**
   * A table's text as rows of fields: comma, semicolon or tab between the
   * fields (whichever the first line has most of), quotes around a field
   * that holds one. At most `most` rows; `more` says whether rows were left out.
   */
  function rowsOf(text, most = ROWS_MOST) {
    const source = String(text || '').replace(/^\uFEFF/, '');
    const first = source.split(/\r?\n/, 1)[0] || '';
    const count = (mark) => first.split(mark).length - 1;
    const mark = ['\t', ';', ','].reduce((best, m) => (count(m) > count(best) ? m : best), ',');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let more = false;
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (quoted) {
        if (c === '"' && source[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"' && !field) quoted = true;
      else if (c === mark) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && source[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(f => f !== '')) rows.push(row);
        row = [];
        if (rows.length >= most) { more = /\S/.test(source.slice(i + 1)); break; }
      } else field += c;
    }
    if (!more && (field || row.length)) { row.push(field); if (row.some(f => f !== '')) rows.push(row); }
    return { rows, more };
  }

  /** What the character is told about the files a task made. `names`: kind -> its name. */
  function handedLine(files, names) {
    if (!files?.length) return '';
    const list = files.map(file => `${names[file.kind] || file.kind} «${String(file.title || file.filename).slice(0, 80)}»`).join(', ');
    return `[File fatti, che l'utente vede già qui sotto: ${list}.]`;
  }

  // Words compared by their roots, without case or accents: the ones of four letters or more.
  const words = (said) => String(said || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(word => word.length >= 4);
  const stem = (word) => word.slice(0, Math.max(4, word.length - 2));
  const alike = (a, b) => a.startsWith(stem(b)) || b.startsWith(stem(a));

  /**
   * The files a task may be about, among the ones made before (the latest
   * first): the ones whose title or description has a word of the task, by
   * the word's root, and the latest ones, which a task speaks of without a
   * name ("that one", "the last one").
   */
  function filesFor(task, files, { latest = 3, most = 6 } = {}) {
    const asked = words(task);
    const named = (files || []).filter(file => words(`${file.title} ${file.description}`).some(word => asked.some(other => alike(word, other))));
    const picked = new Set([...(files || []).slice(0, latest), ...named]);
    return (files || []).filter(file => picked.has(file)).slice(0, most);
  }

  /** The files as a task is told them, after its own words: the name each is found by in the workspace, and what it is. */
  function aboutLine(files, names) {
    if (!files?.length) return '';
    return `\n\n[File fatti prima, nel workspace:\n${files.map(file => `- ${file.filename} — ${names[file.kind] || file.kind} «${String(file.title || '').slice(0, 80)}»`).join('\n')}]`;
  }

  /**
   * Which file is asked for, among the ones there are (the latest first):
   * the one that has most of the words said, by their roots, the latest of
   * them when they are as many; with none of the words, and a kind, the
   * latest of that kind ("the picture of before"); with neither, none.
   */
  function fileAsked(files, { query = '', kind = '' } = {}) {
    const among = (files || []).filter(file => !kind || file.kind === kind);
    const asked = words(query);
    let best = null, most = 0;
    among.forEach(file => {
      const has = words(`${file.title} ${file.description} ${file.task} ${file.filename}`);
      const found = asked.filter(word => has.some(other => alike(word, other))).length;
      if (found > most) { best = file; most = found; }
    });
    return best || (kind ? among[0] || null : null);
  }

  const pure = { VIEW, SHEET, DISC, SPEAKERS, PRINTER_MOVED, OUT_MS, outOf, viewOf, badgeOf, onPage, carried, outAt, rowsOf, handedLine, filesFor, aboutLine, fileAsked };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ---------------------------------------------------------------- */
  /* The machine                                                        */
  /* ---------------------------------------------------------------- */

  const SVG = 'http://www.w3.org/2000/svg';
  function el(name, attrs, parent) {
    const node = document.createElementNS(SVG, name);
    Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
    if (parent) parent.appendChild(node);
    return node;
  }
  const still = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  const rectOf = (node) => {
    if (!node || !node.isConnected) return null;
    const r = node.getBoundingClientRect();
    return r.width < 2 || r.height < 2 ? null : { left: r.left, top: r.top, width: r.width, height: r.height };
  };

  class Desk {
    constructor(container) {
      this.container = container;
      this.busy = false;        // the Master is at work
      this.out = null;          // what is coming out, or is out: { what, started, ms }
      this.sign = null;         // a sign on the screen for a while: { what: 'done' | 'failed', until }
      this.running = false;
      this.build();
      this.draw(performance.now());
    }

    build() {
      const uid = ++Desk.count;
      const id = (name) => `rt-desk-${name}-${uid}`;
      const svg = el('svg', { viewBox: `0 0 ${VIEW.width} ${VIEW.height}`, class: 'rt-desk-svg', role: 'img' });
      const defs = el('defs', {}, svg);
      const shell = el('linearGradient', { id: id('shell'), x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
      el('stop', { offset: '0%', class: 'rt-desk-light' }, shell);
      el('stop', { offset: '100%', class: 'rt-desk-dark' }, shell);
      const glass = el('linearGradient', { id: id('glass'), x1: '0', y1: '0', x2: '1', y2: '1' }, defs);
      el('stop', { offset: '0%', class: 'rt-desk-glass-light' }, glass);
      el('stop', { offset: '100%', class: 'rt-desk-glass-dark' }, glass);
      const silver = el('linearGradient', { id: id('silver'), x1: '0', y1: '0', x2: '1', y2: '1' }, defs);
      el('stop', { offset: '0%', class: 'rt-disc-light' }, silver);
      el('stop', { offset: '55%', class: 'rt-disc-mid' }, silver);
      el('stop', { offset: '100%', class: 'rt-disc-dark' }, silver);
      el('rect', { ...rectAttrs(SCREEN), rx: 8 }, el('clipPath', { id: id('screen') }, defs));
      // What comes out is seen from the slot down: the rest is still inside.
      el('rect', { x: 138, y: SHEET.y, width: 70, height: 46 }, el('clipPath', { id: id('slot') }, defs));
      el('rect', { x: 10, y: DISC.y - 1, width: 76, height: 40 }, el('clipPath', { id: id('drive') }, defs));
      const fill = `url(#${id('shell')})`;

      el('ellipse', { cx: 102 + PRINTER_MOVED / 2, cy: 160, rx: 114 + PRINTER_MOVED / 2 + SPEAKER.width / 2, ry: 7, class: 'rt-shadow', opacity: 0.22 }, svg);
      el('path', { d: `M114 140 q${(18 + PRINTER_MOVED) / 2} 14 ${18 + PRINTER_MOVED} -4`, class: 'rt-desk-cable' }, svg);

      // The speakers: a box on a stand each, a small cone over a large one. They move with a sound (styles.css).
      SPEAKERS.forEach(place => {
        const speaker = el('g', { class: 'rt-speaker', transform: `translate(${place.x} ${place.y})` }, svg);
        el('rect', { x: 13.5, y: 56, width: 5, height: 47, class: 'rt-speaker-stand' }, speaker);
        el('rect', { x: 3, y: 101, width: 26, height: 5, rx: 2.5, class: 'rt-speaker-stand' }, speaker);
        el('rect', { x: 1, y: 1, width: 30, height: 56, rx: 4, class: 'rt-speaker-box' }, speaker);
        el('circle', { cx: 16, cy: 14, r: 6, class: 'rt-speaker-ring' }, speaker);
        el('circle', { cx: 16, cy: 14, r: 3.4, class: 'rt-speaker-cone is-small' }, speaker);
        el('circle', { cx: 16, cy: 38, r: 11.5, class: 'rt-speaker-ring' }, speaker);
        el('circle', { cx: 16, cy: 38, r: 7.5, class: 'rt-speaker-cone is-large' }, speaker);
        el('circle', { cx: 16, cy: 38, r: 2.2, class: 'rt-speaker-dot' }, speaker);
      });
      el('path', { d: 'M30 150 q-6 3 -8 7', class: 'rt-desk-cable' }, svg);

      // The computer: a screen on a case that lies flat, its drive in front.
      this.computer = el('g', {}, svg);
      el('rect', { x: 18, y: 151, width: 14, height: 5, rx: 2, class: 'rt-desk-foot' }, this.computer);
      el('rect', { x: 90, y: 151, width: 14, height: 5, rx: 2, class: 'rt-desk-foot' }, this.computer);
      el('rect', { x: 50, y: 98, width: 22, height: 18, rx: 3, class: 'rt-desk-neck' }, this.computer);
      el('rect', { ...rectAttrs(DRIVE), rx: 7, fill, class: 'rt-desk-shell' }, this.computer);
      el('rect', { x: 14, y: 22, width: 94, height: 80, rx: 13, fill, class: 'rt-desk-shell' }, this.computer);
      el('rect', { ...rectAttrs(SCREEN), rx: 8, fill: `url(#${id('glass')})`, class: 'rt-desk-glass' }, this.computer);
      el('circle', { cx: 61, cy: 94.5, r: 1.8, class: 'rt-desk-dot' }, this.computer);

      const view = el('g', { 'clip-path': `url(#${id('screen')})` }, this.computer);
      this.cursor = el('rect', { x: 31, y: 40, width: 6, height: 9, rx: 1, class: 'rt-desk-ink' }, view);
      this.lines = [52, 36, 58, 28, 44].map((width, i) => ({ width, node: el('rect', { x: 31, y: 40 + i * 9, width: 0, height: 4, rx: 2, class: 'rt-desk-ink' }, view) }));
      this.progress = el('g', {}, view);
      el('rect', { x: 32, y: 62, width: 58, height: 9, rx: 4.5, class: 'rt-desk-bar' }, this.progress);
      this.progressFill = el('rect', { x: 34, y: 64, width: 0, height: 5, rx: 2.5, class: 'rt-desk-ink' }, this.progress);
      this.progressSheet = el('path', { d: 'M54 40 h10 l5 5 v12 h-15 Z M64 40 v5 h5', class: 'rt-desk-glyph' }, this.progress);
      this.progressDisc = el('g', { class: 'rt-desk-glyph' }, this.progress);
      el('circle', { cx: 61, cy: 48, r: 9 }, this.progressDisc);
      el('circle', { cx: 61, cy: 48, r: 2.5 }, this.progressDisc);
      this.done = el('path', { d: 'M46 60 l10 11 l20 -24', class: 'rt-desk-sign' }, view);
      this.failed = el('path', { d: 'M61 42 v20 M61 72 v1', class: 'rt-desk-sign' }, view);
      el('path', { d: 'M27 35 q20 -6 44 -2', class: 'rt-desk-shine' }, view);

      // The drive: a slot, and the tray that comes out of it with the disc on it.
      const drive = el('g', { 'clip-path': `url(#${id('drive')})` }, this.computer);
      this.tray = el('rect', { x: 18, y: DISC.y, width: 58, height: 0, rx: 2, class: 'rt-desk-tray' }, drive);
      this.disc = el('g', {}, drive);
      this.discShape = el('ellipse', { cx: 47, cy: DISC.y, rx: 23, ry: 0, fill: `url(#${id('silver')})`, class: 'rt-disc-edge' }, this.disc);
      this.discHole = el('ellipse', { cx: 47, cy: DISC.y, rx: 5, ry: 0, class: 'rt-disc-hole' }, this.disc);
      el('rect', { x: 18, y: 124, width: 58, height: 4, rx: 2, class: 'rt-desk-slot' }, this.computer);
      this.led = el('circle', { cx: 87, cy: 126, r: 2.2, class: 'rt-desk-led' }, this.computer);
      el('circle', { cx: 101, cy: 126, r: 4, class: 'rt-desk-button' }, this.computer);
      [0, 1, 2].forEach(i => el('path', { d: `M84 ${138 + i * 4} h22`, class: 'rt-desk-vent' }, this.computer));

      // The keyboard, in front of the computer on the side the character works from: its keys go down while the Master writes.
      this.keyboard = el('g', { class: 'rt-desk-keyboard' }, svg);
      el('path', { d: `M${KEYBOARD.x} ${KEYBOARD.y + KEYBOARD.height} l7 ${-KEYBOARD.height} h${KEYBOARD.width - 14} l7 ${KEYBOARD.height} Z`, fill, class: 'rt-desk-shell' }, this.keyboard);
      this.keys = [0, 1].flatMap(row => Array.from({ length: 6 - row }, (_, i) => el('rect', { x: KEYBOARD.x + 9 + row * 3 + i * 6.4, y: KEYBOARD.y + 2 + row * 4, width: 4.6, height: 2.4, rx: 1, class: 'rt-desk-key' }, this.keyboard)));
      el('rect', { x: KEYBOARD.x + 16, y: KEYBOARD.y + 9.5, width: 20, height: 1.6, rx: 0.8, class: 'rt-desk-key' }, this.keyboard);

      // The printer: blank sheets standing at its back, the printed one out of the slot in front.
      this.printer = el('g', { class: 'rt-desk-printer', transform: `translate(${PRINTER_MOVED} 0)` }, svg);
      el('path', { d: 'M148 100 L154 62 L194 62 L200 100 Z', class: 'rt-desk-feed' }, this.printer);
      el('rect', { x: 157, y: 56, width: 34, height: 46, rx: 2, class: 'rt-paper', transform: 'rotate(-3 174 100)' }, this.printer);
      el('rect', { x: 159, y: 59, width: 34, height: 44, rx: 2, class: 'rt-paper' }, this.printer);
      el('rect', { x: 140, y: 139, width: 8, height: 17, rx: 2, class: 'rt-desk-foot' }, this.printer);
      el('rect', { x: 196, y: 139, width: 8, height: 17, rx: 2, class: 'rt-desk-foot' }, this.printer);
      el('path', { d: 'M136 150 h72 l-5 7 h-62 Z', class: 'rt-desk-lip' }, this.printer);
      el('rect', { ...rectAttrs(PRINTER), rx: 8, fill, class: 'rt-desk-shell' }, this.printer);
      el('rect', { x: 139, y: 104, width: 12, height: 5, rx: 2.5, class: 'rt-desk-button' }, this.printer);
      el('rect', { x: 155, y: 104, width: 12, height: 5, rx: 2.5, class: 'rt-desk-button' }, this.printer);
      this.printerLed = el('circle', { cx: 204, cy: 106.5, r: 2.2, class: 'rt-desk-led' }, this.printer);
      el('rect', { x: 140, y: 119, width: 62, height: 5, rx: 2.5, class: 'rt-desk-slot' }, this.printer);
      const slot = el('g', { 'clip-path': `url(#${id('slot')})` }, this.printer);
      this.sheet = el('g', {}, slot);
      el('rect', { x: SHEET.x, y: SHEET.y, width: SHEET.width, height: SHEET.height, rx: 1.5, class: 'rt-paper' }, this.sheet);
      this.sheetText = el('g', {}, this.sheet);
      [[36, 0], [28, 6], [34, 12], [20, 18]].forEach(([width, y]) => el('rect', { x: SHEET.x + 6, y: SHEET.y + 6 + y, width, height: 2.4, rx: 1.2, class: 'rt-paper-ink' }, this.sheetText));
      this.sheetPhoto = el('g', {}, this.sheet);
      el('rect', { x: SHEET.x + 4, y: SHEET.y + 4, width: SHEET.width - 8, height: SHEET.height - 11, rx: 1, class: 'rt-photo-sky' }, this.sheetPhoto);
      el('circle', { cx: SHEET.x + 34, cy: SHEET.y + 11, r: 3.5, class: 'rt-photo-sun' }, this.sheetPhoto);
      el('path', { d: `M${SHEET.x + 4} ${SHEET.y + 25} l11 -11 l9 8 l6 -5 l14 8 Z`, class: 'rt-photo-hill' }, this.sheetPhoto);

      this.svg = svg;
      this.container.appendChild(svg);
    }

    /** The Master is at work on a task, or not. */
    setBusy(on) {
      this.busy = Boolean(on);
      if (!this.running) this.draw(performance.now());
    }

    /** A sign on the screen for a moment: a task done, or one that failed. */
    show(what, ms = 1800) {
      this.sign = { what, until: performance.now() + ms };
      if (!this.running) this.draw(performance.now());
    }

    /** A thing comes out of the machine ('sheet', 'photo', 'disc'): resolves when it is out, and it stays out until taken. */
    print(what) {
      const ms = still() ? 0 : OUT_MS[what] || OUT_MS.sheet;
      this.out = { what, started: performance.now(), ms };
      return new Promise(resolve => setTimeout(() => { this.draw(performance.now()); resolve(); }, ms + 40));
    }

    /** What came out was taken: the machine is as it was. */
    take() {
      this.out = null;
      if (!this.running) this.draw(performance.now());
    }

    /** Where a part of the machine is on the page: what came out, or the top of what it comes out of. */
    where(part) {
      const rect = rectOf(this.svg);
      return rect ? onPage(part, rect) : null;
    }
    outlet(what) { return this.where(what === 'disc' ? DISC : moved(SHEET)); }
    /** Where the character looks while it works: the middle of the screen. */
    screen() {
      const at = this.where(SCREEN);
      return at ? { x: at.left + at.width / 2, y: at.top + at.height / 2 } : null;
    }
    /** Where the character stands to take a thing: on the printer for what it prints, on the screen for a disc, which comes out under it. */
    standing(what) { return this.where(what === 'disc' ? MONITOR : moved(PRINTER)); }

    start() {
      if (this.running) return;
      this.running = true;
      const loop = (now) => {
        if (!this.running) return;
        this.draw(now);
        this.frame = requestAnimationFrame(loop);
      };
      this.frame = requestAnimationFrame(loop);
    }
    stop() {
      this.running = false;
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = null;
    }

    draw(now) {
      const t = now / 1000;
      if (this.sign && now > this.sign.until) this.sign = null;
      const out = this.out;
      const came = out ? (out.ms ? clamp((now - out.started) / out.ms, 0, 1) : 1) : 0;
      const coming = Boolean(out) && came < 1;
      const mode = coming ? 'out' : this.sign ? this.sign.what : this.busy ? 'work' : 'idle';
      const shown = (node, on) => node.setAttribute('opacity', on ? '1' : '0');

      // The screen: a cursor that waits, lines written while the Master works, a bar while a thing comes out.
      shown(this.cursor, mode === 'idle' && t % 1.1 < 0.6);
      const written = (t * 1.7) % (this.lines.length + 2.5);
      this.lines.forEach((line, i) => {
        line.node.setAttribute('width', String(mode === 'work' ? line.width * clamp(written - i, 0, 1) : 0));
      });
      shown(this.progress, mode === 'out');
      this.progressFill.setAttribute('width', String(54 * came));
      shown(this.progressSheet, out?.what !== 'disc');
      shown(this.progressDisc, out?.what === 'disc');
      shown(this.done, mode === 'done');
      shown(this.failed, mode === 'failed');

      // The keys: one goes down after the other while the Master writes.
      const down = mode === 'work' ? Math.floor(t * 9) % this.keys.length : -1;
      this.keys.forEach((key, i) => key.setAttribute('opacity', i === (down * 7) % this.keys.length ? '1' : '0.45'));

      // Lights: steady when still, quick when something is going on.
      const quick = t % 0.3 < 0.15;
      this.led.setAttribute('opacity', this.busy || (coming && out.what === 'disc') ? (quick ? '1' : '0.25') : '0.45');
      this.printerLed.setAttribute('opacity', coming && out.what !== 'disc' ? (quick ? '1' : '0.25') : '0.45');

      // The sheet slides out of the slot; the printer shakes a little while it prints.
      const paper = out && out.what !== 'disc' ? outAt(came) : 0;
      this.sheet.setAttribute('transform', `translate(0 ${(paper - 1) * (SHEET.height + 2)})`);
      shown(this.sheet, paper > 0);
      shown(this.sheetText, out?.what === 'sheet');
      shown(this.sheetPhoto, out?.what === 'photo');
      this.printer.setAttribute('transform', coming && out.what !== 'disc' ? `translate(${Math.sin(t * 46) * 0.5} 0)` : '');

      // The tray comes out of the drive with the disc lying on it.
      const open = out && out.what === 'disc' ? outAt(came) : 0;
      this.tray.setAttribute('height', String(DISC.height * open));
      this.discShape.setAttribute('cy', String(DISC.y + 7 * open));
      this.discShape.setAttribute('ry', String(6.5 * open));
      this.discHole.setAttribute('cy', String(DISC.y + 7 * open));
      this.discHole.setAttribute('ry', String(1.5 * open));
      shown(this.disc, open > 0.05);
    }
  }
  Desk.count = 0;

  function rectAttrs(part) { return { x: part.x, y: part.y, width: part.width, height: part.height }; }

  /* ---------------------------------------------------------------- */
  /* What a file looks like, small                                      */
  /* ---------------------------------------------------------------- */

  const rt = window.realtime._state;
  const { t, esc } = window.realtime._util;
  const locale = () => (window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT');
  const resolved = (url) => (window.synthorgResolveUrl ? window.synthorgResolveUrl(url) : url);
  const KIND_ICON = { image: 'fa-image', video: 'fa-film', audio: 'fa-music', document: 'fa-file-lines' };
  const KINDS = Object.keys(KIND_ICON);
  const kindNames = () => Object.fromEntries(KINDS.map(kind => [kind, t('realtime.fileKind_' + kind)]));

  /** A sheet with its corner folded, the kind of document written on it. */
  function sheetDrawing(file) {
    return `<svg viewBox="0 0 48 56" class="rt-thumb-svg" aria-hidden="true">
      <path d="M6 3 h26 l10 10 v38 a2 2 0 0 1 -2 2 h-34 a2 2 0 0 1 -2 -2 v-46 a2 2 0 0 1 2 -2 Z" class="rt-paper"/>
      <path d="M32 3 v8 a2 2 0 0 0 2 2 h8 Z" class="rt-paper-fold"/>
      <rect x="10" y="19" width="24" height="2.6" rx="1.3" class="rt-paper-ink"/>
      <rect x="10" y="25" width="28" height="2.6" rx="1.3" class="rt-paper-ink"/>
      <rect x="10" y="31" width="18" height="2.6" rx="1.3" class="rt-paper-ink"/>
      ${badgeOf(file.filename) ? `<rect x="8" y="38" width="32" height="12" rx="3" class="rt-paper-badge"/>
      <text x="24" y="47" text-anchor="middle" class="rt-paper-letters">${esc(badgeOf(file.filename))}</text>` : ''}
    </svg>`;
  }

  /** A disc: a note on it for a sound, a film's frame for a video. */
  function discDrawing(file, uid) {
    const mark = file.kind === 'video'
      ? '<path d="M25.5 22.5 v11 l9 -5.5 Z" class="rt-disc-mark"/>'
      : '<path d="M26 34 v-11 l8 -2 v10" class="rt-disc-mark is-line"/><circle cx="24" cy="34" r="2.4" class="rt-disc-mark"/><circle cx="32" cy="31.5" r="2.4" class="rt-disc-mark"/>';
    return `<svg viewBox="0 0 56 56" class="rt-thumb-svg" aria-hidden="true">
      <defs><linearGradient id="rt-disc-${uid}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" class="rt-disc-light"/><stop offset="55%" class="rt-disc-mid"/><stop offset="100%" class="rt-disc-dark"/>
      </linearGradient></defs>
      <circle cx="28" cy="28" r="25" fill="url(#rt-disc-${uid})" class="rt-disc-edge"/>
      <path d="M28 3 a25 25 0 0 1 21.6 12.5 l-12.1 7 a11 11 0 0 0 -9.5 -5.5 Z" class="rt-disc-sheen"/>
      <path d="M28 53 a25 25 0 0 1 -21.6 -12.5 l12.1 -7 a11 11 0 0 0 9.5 5.5 Z" class="rt-disc-sheen"/>
      <circle cx="28" cy="28" r="12" class="rt-disc-label"/>
      ${mark}
      <circle cx="28" cy="28" r="2.2" class="rt-disc-hole"/>
    </svg>`;
  }

  let drawn = 0;
  /** The file as a small thing to pick up: a photo, a disc, a sheet. */
  function thumb(file) {
    if (file.kind === 'image') return `<span class="rt-thumb is-photo"><img src="${esc(resolved(file.url))}" alt="" loading="lazy" draggable="false"></span>`;
    if (file.kind === 'audio' || file.kind === 'video') return `<span class="rt-thumb is-disc">${discDrawing(file, ++drawn)}</span>`;
    return `<span class="rt-thumb is-sheet">${sheetDrawing(file)}</span>`;
  }

  function whenOf(file) {
    const at = new Date(file.at);
    if (Number.isNaN(at.getTime())) return '';
    const today = new Date().toDateString() === at.toDateString();
    return at.toLocaleString(locale(), today ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  /* ---------------------------------------------------------------- */
  /* The section's methods                                              */
  /* ---------------------------------------------------------------- */

  Object.assign(rt, {
    desk: null,
    files: [],               // what was handed, the latest first, as far as it was read
    filesUnseen: 0,
    fileOpen: null,          // the id of the file being looked at
    computerOpen: false,     // the computer is close up, its screen listing the discs
    discs: [],               // the sounds and the videos handed, the latest first
    toHand: [],              // recorded, waiting to be handed on the stage
    coming: new Set(),       // on their way: their place among the files is kept, empty
    handing: false,

    /** The machine beside the character and the lower part of the stage: made once, with the stage. */
    buildDesk() {
      const q = (s) => this.view.querySelector(s);
      Object.assign(this.ui, { scene: q('.rt-scene'), desk: q('.rt-desk'), filesBox: q('.rt-files') });
      if (!this.ui.desk || this.desk) return;
      this.desk = new Desk(this.ui.desk);
      this.ui.desk.title = t('realtime.deskTitle');
      this.ui.filesBox.addEventListener('click', (e) => this.onFilesClick(e));
      // The computer is pressed to come close to it.
      this.ui.desk.addEventListener('click', () => this.openComputer().catch(() => {}));
      // The row of the files goes sideways: the wheel moves it, as it would a column.
      this.ui.filesBox.addEventListener('wheel', (e) => {
        const row = e.target.closest('.rt-files-row');
        if (!row || row.scrollWidth <= row.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        row.scrollLeft += e.deltaY;
        e.preventDefault();
      }, { passive: false });
      this.renderFiles();
    },

    /**
     * The stage while the Master works: the character beside the computer,
     * its eyes on the screen and its hands on the keys, both as big as each
     * other. It stays so while what the work made is handed over.
     */
    atDesk() {
      const on = Boolean(this.working() || this.handing);
      if (!this.ui?.stage || !this.desk || this.ui.stage.classList.contains('is-working') === on) return;
      this.ui.stage.classList.toggle('is-working', on);
      const eyes = on ? () => (this.working() ? this.desk.screen() : null) : null;
      this.puppet?.setFocus(eyes);
      window.mascot?.puppet?.setFocus(eyes);
    },

    /** Whether the stage is there to show a file being handed: the section on screen, the machine in view, nothing else going on. */
    stageFree() {
      return Boolean(this.active && this.desk && rectOf(this.ui.desk) && !this.diarySession);
    },

    async loadFiles() {
      try {
        await this.readPast();
        const got = await window.chatStorage.handedFiles({ limit: Math.max(PAGE, this.files.length) });
        this.files = got.files;
        this.filesUnseen = got.unseen;
        if (this.fileOpen && !this.files.some(file => file.id === this.fileOpen)) this.fileOpen = null;
      } catch {}
      this.renderFiles();
    },

    /**
     * What the tasks made before the files were handed in the section: read
     * once from the chat of the tasks, with the moment each was made, as
     * files already seen.
     */
    async readPast() {
      let read = '';
      try { read = (await window.chatStorage.getSetting('realtime_files_read'))?.value || ''; } catch {}
      if (read) return;
      const tasksId = this.tasksConversationId || (await window.chatStorage.realtime()).tasksConversationId;
      const loaded = await window.chatStorage.get(tasksId);
      const messages = loaded.messages || [];
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (message.role !== 'assistant') continue;
        const asked = messages.slice(0, i).reverse().find(m => m.role === 'user')?.content || '';
        for (const file of window.chatManager.shownFiles(message)) {
          try { await window.chatStorage.handFile({ ...file, task: asked.slice(0, 300), at: message.timestamp || message.created_at, seen: true }); } catch {}
        }
      }
      await window.chatStorage.setSetting('realtime_files_read', new Date().toISOString());
    },

    /** What a task of the Master made, from its answer: recorded, and handed on the stage when the stage is there. */
    async handOver(answer, task) {
      const handed = [];
      for (const file of window.chatManager.shownFiles(answer)) {
        try { handed.push(await window.chatStorage.handFile({ ...file, task: String(task || '').slice(0, 300) })); } catch {}
      }
      if (handed.length) {
        this.toHand.push(...handed);
        await this.loadFiles();
        this.handNext();
      }
      return handed;
    },

    /** What the character is told about the files of a task. */
    handedText(files) {
      return handedLine(files, kindNames());
    },

    /** The files made before that a task may be about, as the task is told them; nothing when there is none. */
    async filesAbout(task) {
      try {
        return aboutLine(filesFor(task, (await window.chatStorage.handedFiles({ limit: PAGE })).files), kindNames());
      } catch {
        return '';
      }
    },

    /**
     * A file is asked for again, in words or by its kind: it is opened in
     * the lower part of the stage, and what there is to say is said in fixed
     * words. With neither, the files are shown as they are, in their row.
     */
    async showAsked({ query = '', kind = '' } = {}) {
      const got = await window.chatStorage.handedFiles({ limit: PAGE });
      if (!got.files.length) return { say: [{ text: t('realtime.saidNoFiles'), fixed: true }] };
      const wanted = Boolean(String(query).trim() || kind);
      let file = wanted ? fileAsked(got.files, { query, kind }) : null;
      // Not among the latest: looked for among the older ones, by the roots of the words.
      if (wanted && !file && got.more) {
        try { file = (await window.chatStorage.handedFiles({ limit: 1, query: words(query).map(stem).slice(0, 6).join(' '), kind })).files[0] || null; } catch {}
      }
      if (this.sideTab === 'agenda') { this.sideTab = null; this.renderSide(); }
      if (!file) {
        this.closeFile();
        return { say: [{ text: t(wanted ? 'realtime.saidNoFile' : 'realtime.saidFiles'), fixed: true }] };
      }
      if (!this.files.some(known => known.id === file.id)) this.files.push(file);
      this.files.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      await this.openFile(file.id, { hop: false });
      return { say: [{ text: t('realtime.saidFile'), fixed: true }] };
    },

    /**
     * The files waiting are handed, one after the other. The first of them
     * is then shown, unless the user is looking at another: that one stays.
     */
    async handNext() {
      if (this.handing || !this.toHand.length || !this.stageFree()) return;
      this.handing = true;
      try {
        while (this.toHand.length && this.stageFree()) await this.handOne(this.toHand[0]);
      } finally {
        this.handing = false;
        this.atDesk();
      }
      if (this.toHand.length) return;
      this.desk.show('done');
      // The file waits on the table, for the user to open.
      window.mascot?.home?.();
    },

    /**
     * One file, from the machine to its place among the files: it comes out,
     * the character goes to take it, carries it down and lays it there.
     * With no motion wanted it is there at once.
     */
    async handOne(file) {
      const mascot = window.mascot;
      const what = outOf(file.kind);
      const place = () => rectOf(this.ui.filesBox.querySelector(`[data-file="${CSS.escape(file.id)}"] .rt-thumb`));
      if (!this.files.some(known => known.id === file.id)) this.files.unshift(file);
      let item = null;
      if (mascot?.ready && !still() && this.desk.outlet(what)) {
        // Its place among the files is kept, empty, until it is laid there.
        this.coming.add(file.id);
        this.renderFiles();
        try {
          this.puppet?.setExpression('surprise', 900);
          const out = this.desk.print(what);
          // As big as the machine lets it be: the machine is small while a file is open.
          const size = clamp((rectOf(this.ui.desk)?.width || 0) * 0.36, 30, 84);
          const there = await mascot.stand(this.ui.desk, { rect: () => this.desk.standing(what), size, press: this.ui.desk });
          await out;
          if (there && place()) {
            item = this.lift(file, this.desk.outlet(what));
            this.desk.take();
            await new Promise(resolve => setTimeout(resolve, 220));
            item.follow();
            await mascot.stand(this.ui.filesBox, { rect: place, size: Math.max(size, 44), press: false });
          }
        } catch {}
        this.desk.take();
        item?.drop();
        this.coming.delete(file.id);
      }
      this.toHand = this.toHand.filter(waiting => waiting.id !== file.id);
      this.renderFiles();
      if (!item) return;
      this.puppet?.setExpression('joy', 1400);
      this.ui.filesBox.querySelector(`[data-file="${CSS.escape(file.id)}"]`)?.classList.add('is-landed');
    },

    /**
     * The thing itself, out of the machine: drawn over the page where it
     * came out, then at the character's side wherever the character is
     * drawn, until it is dropped.
     */
    lift(file, from) {
      const mascot = window.mascot;
      const node = document.createElement('div');
      node.className = `rt-carried is-${outOf(file.kind)}`;
      node.setAttribute('aria-hidden', 'true');
      node.innerHTML = thumb(file);
      document.body.appendChild(node);
      let held = false;
      const draw = (box) => {
        node.style.width = `${box.width}px`;
        node.style.transform = `translate(${Math.round(box.left * 10) / 10}px, ${Math.round(box.top * 10) / 10}px) rotate(${held ? 9 : 0}deg)`;
      };
      const size = Math.max(30, from.width);
      draw({ left: from.left + from.width / 2 - size / 2, top: from.top + from.height / 2 - size * 0.55, width: size });
      const own = mascot.draw;
      return {
        follow() {
          held = true;
          if (mascot.box) draw(carried(mascot.box));
          mascot.draw = function (state) { own.call(this, state); draw(carried(state)); };
        },
        drop() { mascot.draw = own; node.remove(); }
      };
    },

    /* ------------------------------ the lower part ------------------ */

    /**
     * The table in the lower part of the stage: the latest files handed, as
     * the things they came out as. With nothing handed yet it is not there.
     */
    renderFiles() {
      const box = this.ui?.filesBox;
      if (!box) return;
      // What waits to be handed on the stage is not among the files yet.
      const files = this.files.filter(file => this.coming.has(file.id) || !this.toHand.some(waiting => waiting.id === file.id));
      const open = files.find(file => file.id === this.fileOpen) || null;
      if (!open) this.fileOpen = null;
      const onTable = files.slice(0, TABLE);
      this.ui.stage.classList.toggle('has-files', onTable.length > 0);
      box.hidden = !onTable.length;
      if (!box.firstElementChild) box.innerHTML = '<header class="rt-files-head"></header><div class="rt-files-row" role="list"></div>';
      const unseen = Math.max(0, this.filesUnseen - this.toHand.filter(waiting => !this.coming.has(waiting.id)).length);
      box.querySelector('.rt-files-head').innerHTML = `
        <h3>${esc(t('realtime.filesTitle'))}</h3>
        ${unseen ? `<span class="rt-files-new">${esc(t(unseen === 1 ? 'realtime.filesNewOne' : 'realtime.filesNew', { count: unseen }))}</span>` : ''}`;
      box.title = t('realtime.filesHint');
      box.querySelector('.rt-files-row').innerHTML = onTable.map(file => `
        <button type="button" role="listitem" class="rt-file is-${esc(file.kind)}${file.seen_at ? '' : ' is-new'}${file.id === this.fileOpen ? ' is-open' : ''}${this.coming.has(file.id) ? ' is-coming' : ''}"
          data-file="${esc(file.id)}" title="${esc(`${file.title} — ${t('realtime.fileKind_' + file.kind)}, ${whenOf(file)}`)}">
          ${thumb(file)}
          <span class="rt-file-name">${esc(file.title)}</span>
        </button>`).join('');
      this.renderZoom(open);
    },

    /**
     * The open file, close up over the stage. What is shown of it is made
     * when it is opened and left alone by the redraws, so that what plays
     * goes on playing.
     */
    renderZoom(open) {
      let zoom = this.ui.zoom;
      // What is close up: a file, or the computer with the list of its discs.
      const shown = open?.id || (this.computerOpen ? 'computer' : '');
      if (!zoom) {
        if (!shown) return;
        zoom = this.ui.zoom = document.createElement('div');
        zoom.className = 'rt-zoom';
        zoom.hidden = true;
        zoom.innerHTML = `<div class="rt-zoom-shade" data-action="file-close"></div>
          <div class="rt-zoom-frame" role="dialog">
            <div class="rt-zoom-desk" aria-hidden="true"></div>
            <div class="rt-zoom-screen"><header class="rt-zoom-head"></header><div class="rt-file-holder"></div></div>
          </div>`;
        // The same machine as on the stage, drawn again as big as the stage lets it be.
        new Desk(zoom.querySelector('.rt-zoom-desk'));
        zoom.addEventListener('click', (e) => {
          // Around the computer there is nothing to press: a click there goes back to the stage.
          if (e.target === zoom.querySelector('.rt-zoom-frame')) { this.computerOpen = false; this.closeFile(); } else this.onFilesClick(e);
        });
        window.addEventListener('resize', () => { if (!zoom.hidden) this.zoomLayout(zoom); });
        this.ui.stage.appendChild(zoom);
      }
      const holder = zoom.querySelector('.rt-file-holder');
      const head = zoom.querySelector('.rt-zoom-head');
      if ((holder.dataset.open || '') === shown) {
        if (open) head.innerHTML = this.fileHead(open);
        return;
      }
      if (!shown) { this.zoomOut(zoom, holder); return; }
      // Already at the computer: what is on its screen changes, and nothing moves.
      const there = !zoom.hidden && zoom.classList.contains('is-disc');
      const what = open ? outOf(open.kind) : 'disc';
      holder.dataset.open = shown;
      holder.replaceChildren(open ? this.fileView(open) : this.discList());
      head.innerHTML = open ? this.fileHead(open) : this.computerHead();
      zoom.className = `rt-zoom is-${what} is-${open ? open.kind : 'audio'}`;
      zoom.hidden = false;
      this.zoomLayout(zoom);
      if (!(there && what === 'disc')) this.zoomMove(zoom, this.zoomSmall(zoom, open), false);
      if (!open || what !== 'disc') return;
      // A disc is played by the computer: it starts as the screen comes close, and the speakers move with a sound.
      const media = holder.querySelector('audio, video');
      ['play', 'playing'].forEach(name => media?.addEventListener(name, () => zoom.classList.add('is-playing')));
      ['pause', 'ended', 'emptied'].forEach(name => media?.addEventListener(name, () => zoom.classList.remove('is-playing')));
      media?.play().catch(() => {});
    },

    /** The computer is pressed: it comes close, and its screen lists the sounds and the videos handed. */
    async openComputer() {
      if (this.computerOpen || this.handing) return;
      const read = await Promise.all(['audio', 'video'].map(kind => window.chatStorage.handedFiles({ limit: PAGE, kind }).then(got => got.files).catch(() => [])));
      this.discs = read.flat().sort((a, b) => String(b.at).localeCompare(String(a.at)));
      // A disc is opened like any file: it has to be among the ones known.
      for (const disc of this.discs) if (!this.files.some(known => known.id === disc.id)) this.files.push(disc);
      this.files.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      this.computerOpen = true;
      this.fileOpen = null;
      this.renderFiles();
    },

    /** On the computer's screen, with no disc playing: the discs there are. */
    discList() {
      const node = document.createElement('div');
      node.className = 'rt-file-view is-discs';
      node.innerHTML = this.discs.length ? this.discs.map(file => `
        <button type="button" class="rt-disc-row" data-file="${esc(file.id)}">
          <i class="fa-solid ${KIND_ICON[file.kind]}" aria-hidden="true"></i>
          <span class="rt-disc-name">${esc(file.title)}</span>
          <small>${esc(whenOf(file))}</small>
        </button>`).join('') : `<p class="rt-hint">${esc(t('realtime.discsNone'))}</p>`;
      return node;
    },

    computerHead() {
      return `
        <span class="rt-files-open"><i class="fa-solid fa-compact-disc" aria-hidden="true"></i><strong>${esc(t('realtime.discsTitle'))}</strong></span>
        <span class="rt-file-acts"><button type="button" class="rt-file-act" data-action="file-close" aria-label="${esc(t('realtime.fileClose'))}" title="${esc(t('realtime.fileClose'))}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`;
    },

    /**
     * Close to the computer: its drawing as big as the stage lets the computer
     * and its two speakers be, in the middle of it, the file on its screen.
     * Anything else is a frame of its own, which needs no placing.
     */
    zoomLayout(zoom) {
      const frame = zoom.querySelector('.rt-zoom-frame');
      const place = (node, box) => Object.assign(node.style, box ? { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` } : { left: '', top: '', width: '', height: '' });
      const screen = zoom.querySelector('.rt-zoom-screen');
      if (!zoom.classList.contains('is-disc')) { [screen, zoom.querySelector('.rt-zoom-desk')].forEach(node => place(node, null)); this.zoomScale = null; return; }
      const room = { width: frame.clientWidth, height: frame.clientHeight };
      const k = Math.min(room.width * 0.9 / CLOSE.width, room.height * 0.9 / CLOSE.height);
      const left = room.width / 2 - (CLOSE.x + CLOSE.width / 2) * k;
      const top = room.height / 2 - (CLOSE.y + CLOSE.height / 2) * k;
      const at = (part) => ({ left: left + part.x * k, top: top + part.y * k, width: part.width * k, height: part.height * k });
      place(zoom.querySelector('.rt-zoom-desk'), at({ x: 0, y: 0, ...VIEW }));
      place(screen, at(SCREEN));
      this.zoomScale = { k, left, top };
    },

    /**
     * How the frame is drawn when it is still where the file was: for a disc,
     * the large computer shrunk exactly onto the small one on the stage; for
     * the rest, the frame shrunk onto the file on the table.
     */
    zoomSmall(zoom, file) {
      const frame = zoom.querySelector('.rt-zoom-frame');
      const to = frame.getBoundingClientRect();
      if (!to.width || !to.height) return null;
      // With no file it is the computer itself that is close.
      if (!file || outOf(file.kind) === 'disc') {
        const desk = rectOf(this.ui.desk);
        if (!desk || !this.zoomScale) return null;
        const s = desk.width / (VIEW.width * this.zoomScale.k);
        return `translate(${desk.left - to.left - s * this.zoomScale.left}px, ${desk.top - to.top - s * this.zoomScale.top}px) scale(${s})`;
      }
      const from = rectOf(this.ui.filesBox.querySelector(`[data-file="${CSS.escape(file.id)}"] .rt-thumb`)) || rectOf(this.ui.filesBox);
      return from ? `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})` : null;
    },

    /** The frame comes close from where the file is, or goes back there. With no motion wanted it is there at once. */
    zoomMove(zoom, small, back) {
      if (still() || !small) return Promise.resolve();
      const disc = zoom.classList.contains('is-disc');
      const near = { transform: 'none', opacity: 1 };
      // The computer is the same thing far and near: it does not fade, it grows.
      const far = { transform: small, opacity: disc ? 1 : 0.3 };
      return zoom.querySelector('.rt-zoom-frame').animate(back ? [near, far] : [far, near], { duration: back ? 300 : 480, easing: 'cubic-bezier(.2,.8,.3,1)' }).finished.catch(() => {});
    },

    zoomOut(zoom, holder) {
      const was = holder.dataset.open;
      const file = this.files.find(known => known.id === was) || null;
      holder.dataset.open = '';
      holder.querySelectorAll('audio, video').forEach(media => media.pause());
      zoom.classList.remove('is-playing');
      const gone = () => { if (!holder.dataset.open) { zoom.hidden = true; holder.replaceChildren(); } };
      (file || was === 'computer' ? this.zoomMove(zoom, this.zoomSmall(zoom, file), true) : Promise.resolve()).then(gone);
    },

    /** The name of the open file and what can be done with it. */
    fileHead(file) {
      const view = viewOf(file);
      const act = (action, icon, label) => `<button type="button" class="rt-file-act" data-action="${action}" aria-label="${esc(label)}" title="${esc(label)}"><i class="fa-solid ${icon}" aria-hidden="true"></i></button>`;
      return `
        <span class="rt-files-open">
          <i class="fa-solid ${KIND_ICON[file.kind]}" aria-hidden="true"></i>
          <strong>${esc(file.title)}</strong>
          <small>${esc(whenOf(file))}</small>
        </span>
        <span class="rt-file-acts">
          ${['image', 'video', 'pdf', 'markdown', 'text', 'table'].includes(view) ? act('file-full', 'fa-expand', t('artifact.openFullscreen')) : ''}
          <a class="rt-file-act" href="${esc(resolved(file.url))}${file.url.includes('?') ? '&' : '?'}download=1" download="${esc(file.filename)}" aria-label="${esc(t('realtime.fileSave'))}" title="${esc(t('realtime.fileSave'))}"><i class="fa-solid fa-download" aria-hidden="true"></i></a>
          ${act('file-chat', 'fa-comments', t('realtime.openTasks'))}
          ${act('file-drop', 'fa-trash-can', t('realtime.fileDrop'))}
          ${act('file-close', 'fa-xmark', t('realtime.fileClose'))}
        </span>`;
    },

    /** The open file, shown: made once for each opening, so that what plays is not started again by a redraw. */
    fileView(file) {
      const view = viewOf(file);
      const url = resolved(file.url);
      const node = document.createElement('div');
      node.className = `rt-file-view is-${view}`;
      const about = file.description ? `<p class="rt-file-about">${esc(file.description)}</p>` : '';
      if (view === 'image') {
        node.innerHTML = `<img class="rt-view-image" src="${esc(url)}" alt="${esc(file.title)}" data-action="file-full">${about}`;
      } else if (view === 'video') {
        node.innerHTML = `<video class="rt-view-video" src="${esc(url)}" controls playsinline preload="metadata"></video>${about}`;
      } else if (view === 'audio') {
        node.innerHTML = `<div class="rt-view-disc">${discDrawing(file, ++drawn)}</div>
          <div class="rt-view-sound"><strong>${esc(file.title)}</strong>${about}<audio src="${esc(url)}" controls preload="metadata"></audio></div>`;
        const audio = node.querySelector('audio');
        const disc = node.querySelector('.rt-view-disc');
        ['play', 'playing'].forEach(name => audio.addEventListener(name, () => disc.classList.add('is-playing')));
        ['pause', 'ended', 'emptied'].forEach(name => audio.addEventListener(name, () => disc.classList.remove('is-playing')));
      } else if (view === 'pdf') {
        node.innerHTML = `<iframe class="chat-doc-pdf-frame rt-view-pdf" data-pdf-src="${esc(file.url)}" title="${esc(file.title)}"></iframe>`;
        window.chatManager.loadPdfFrames(node);
      } else if (view === 'none') {
        node.innerHTML = `<div class="rt-view-none">${thumb(file)}<p>${esc(t('realtime.fileNoView', { name: file.filename }))}</p>
          <a class="btn" href="${esc(url)}${url.includes('?') ? '&' : '?'}download=1" download="${esc(file.filename)}"><i class="fa-solid fa-download"></i> ${esc(t('realtime.fileSave'))}</a></div>`;
      } else {
        node.innerHTML = `<article class="rt-view-sheet"><p class="rt-hint"><i class="fa-solid fa-spinner fa-spin"></i></p></article>`;
        const sheet = node.querySelector('.rt-view-sheet');
        fetch(url).then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.text(); }).then(text => {
          const cut = text.length > TEXT_MOST;
          const shown = cut ? text.slice(0, TEXT_MOST) : text;
          let more = cut;
          if (view === 'markdown') sheet.innerHTML = window.chatManager.formatMarkdown(shown);
          else if (view === 'table') {
            const table = rowsOf(shown);
            more = more || table.more;
            const [head, ...rows] = table.rows;
            sheet.innerHTML = head ? `<table class="rt-view-table"><thead><tr>${head.map(f => `<th>${esc(f)}</th>`).join('')}</tr></thead>
              <tbody>${rows.map(row => `<tr>${row.map(f => `<td>${esc(f)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '';
          } else sheet.innerHTML = `<pre class="chat-doc-plain">${esc(shown)}</pre>`;
          if (more) sheet.insertAdjacentHTML('beforeend', `<button type="button" class="btn rt-view-more" data-action="file-full">${esc(t('artifact.showWhole'))} <i class="fa-solid fa-arrow-right"></i></button>`);
        }).catch(() => { sheet.innerHTML = `<p class="rt-hint">${esc(t('artifact.previewUnavailable'))}</p>`; });
      }
      return node;
    },

    /** A file is opened, close up. `hop`: the user opened it from the table, and the character goes to it. */
    async openFile(id, { hop = true } = {}) {
      const file = this.files.find(known => known.id === id);
      if (!file) return false;
      const button = this.ui.filesBox.querySelector(`[data-file="${CSS.escape(id)}"]`);
      if (hop && button && window.mascot?.ready && !this.handing) {
        const landed = window.mascot.stand(button, { quick: true });
        await landed;
        setTimeout(() => { if (window.mascot.heading?.el === button || !button.isConnected) window.mascot.home(); }, 420);
      }
      this.fileOpen = id;
      if (!file.seen_at) {
        file.seen_at = new Date().toISOString();
        this.filesUnseen = Math.max(0, this.filesUnseen - 1);
        window.chatStorage.seeFile(id).catch(() => {});
      }
      this.renderFiles();
      return true;
    },

    /** The open file is put away. A disc chosen on the computer's screen leaves the computer close, with its list; closed again, the stage is back. */
    closeFile() {
      if (!this.fileOpen) this.computerOpen = false;
      this.fileOpen = null;
      this.renderFiles();
    },

    /** The open file, as big as the window. */
    fullFile(file) {
      const view = viewOf(file);
      const kind = view === 'image' || view === 'video' || view === 'pdf' ? view : 'text';
      this.ui.zoom?.querySelector('video')?.pause();
      window.chatManager.openLightbox(kind === 'pdf' ? file.url : resolved(file.url), kind, kind === 'text' ? file.filename : file.title);
    },

    async onFilesClick(e) {
      const target = e.target.closest('[data-action], [data-file]');
      if (!target || !(this.ui.filesBox.contains(target) || this.ui.zoom?.contains(target))) return;
      const action = target.dataset.action;
      const open = this.files.find(file => file.id === this.fileOpen);
      if (action === 'file-close') { this.closeFile(); return; }
      if (action === 'file-full' && open) { this.fullFile(open); return; }
      if (action === 'file-chat') {
        const id = this.tasksConversationId || (await window.chatStorage.realtime()).tasksConversationId;
        window.switchView?.('chat');
        await window.chatManager.selectConversation(id);
        await window.chatWorkspace?.refresh?.();
        return;
      }
      if (action === 'file-drop' && open) {
        const ok = await window.chatWorkspace.confirmAction({
          title: t('realtime.fileDropTitle'),
          message: t('realtime.fileDropMessage', { name: open.title }),
          confirmText: t('realtime.fileDrop')
        });
        if (!ok) return;
        try { await window.chatStorage.dropFile(open.id); } catch {}
        this.files = this.files.filter(file => file.id !== open.id);
        this.discs = this.discs.filter(file => file.id !== open.id);
        this.fileOpen = null;
        await this.loadFiles();
        return;
      }
      if (target.dataset.file) {
        if (target.dataset.file === this.fileOpen) this.closeFile();
        else await this.openFile(target.dataset.file);
      }
    }
  });

  // The files are shown by the app: the model only says that one is asked for, and which.
  window.realtime.tools.push({
    name: 'files_show',
    description: 'Call it when the user asks to see, hear or read again a file made for them, or which files there are: shows it to them. query: the words they name it by. kind: image, video, audio or document.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        kind: { type: 'string', enum: ['image', 'video', 'audio', 'document'] }
      }
    },
    run: (args, section) => section.showAsked({ query: String(args.query || ''), kind: KINDS.includes(args.kind) ? args.kind : '' })
  });

  window.realtime._desk = { Desk, thumb, ...pure };
})();
