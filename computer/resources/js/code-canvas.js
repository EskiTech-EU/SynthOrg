/**
 * The editor of a container project, as the desktop sees it: a canvas.
 *
 * The editor itself runs inside the project's container (server/code-editor).
 * What arrives here is pixels — changed rectangles and scroll copies — and what
 * leaves is keyboard, mouse, size and theme. This file paints and forwards; it
 * never interprets what the container sends as anything but an image, and no
 * path, file or clipboard content ever travels from the container to this side.
 */
(() => {
  const OUT = { RESIZE: 1, RECT: 2, COPY: 3, FRAME: 4, CURSOR: 5, PASTE: 6, SIDEBAR: 7, FILES: 8, ENDED: 0xFF };
  const IN = { RESIZE: 1, MOVE: 2, BUTTON: 3, WHEEL: 4, KEY: 5, TEXT: 6, THEME: 7, FOCUS: 8, QUIT: 9, PASTE: 10, INSET: 11, SAVE: 12, TREE: 13, OPEN: 14, DO: 15, SHUT: 16 };
  const DO = { undo: 1, redo: 2, save: 3, zoomIn: 4, zoomOut: 5, zoomReset: 6 };
  const KEYS = { ArrowLeft: 1, ArrowRight: 2, ArrowUp: 3, ArrowDown: 4, Home: 5, End: 6, PageUp: 7, PageDown: 8, Backspace: 9, Delete: 10, Enter: 11, Tab: 12, Escape: 13, Insert: 14 };
  const CURSORS = ['default', 'text', 'pointer', 'ew-resize', 'ns-resize', 'grabbing', 'no-drop', 'nwse-resize'];
  const THEME_TOKENS = ['--bg-app', '--bg-surface', '--bg-input', '--text-main', '--text-muted', '--primary', '--on-primary', '--border-subtle'];
  const MAX_PASTE_PIECE = 60000;

  let canvas = null, ctx = null, sink = null, host = null;
  let running = false, onEnded = null, scale = 1;
  // The strip the page draws over the file tree: its height, asked of the editor as empty
  // space, and where the editor says its tree is (two numbers, the only layout it tells).
  let inset = 0, onSidebar = null, onFiles = null;
  let queue = Promise.resolve();

  const invoke = () => window.__TAURI__?.core?.invoke;

  /** Input is ordered: one invoke at a time, in the order the user produced it. */
  function send(type, payload) {
    if (!running) return;
    const body = new Uint8Array(3 + payload.length);
    body[0] = type; body[1] = payload.length & 0xFF; body[2] = payload.length >> 8;
    body.set(payload, 3);
    queue = queue.then(() => invoke()('editor_input', body)).catch(() => {});
  }
  const i16 = (...values) => { const out = new Uint8Array(values.length * 2); const view = new DataView(out.buffer); values.forEach((v, i) => view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(v))), true)); return out; };
  const join = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
  const mods = (e) => (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
  const point = (e) => { const box = canvas.getBoundingClientRect(); return [(e.clientX - box.left) * scale, (e.clientY - box.top) * scale]; };

  // ---- painting ------------------------------------------------------------

  function paintRect(view, at, length) {
    const x = view.getUint16(at, true), y = view.getUint16(at + 2, true), w = view.getUint16(at + 4, true), h = view.getUint16(at + 6, true);
    if (!w || !h || x + w > canvas.width || y + h > canvas.height) throw new Error('rettangolo fuori dalla finestra');
    const image = ctx.createImageData(w, h), pixels = image.data, bytes = new Uint8Array(view.buffer, view.byteOffset + at + 8, length - 8);
    const total = w * h * 4;
    let i = 0, o = 0;
    while (o < total) {
      const n = bytes[i++];
      if (n < 128) {
        const r = bytes[i], g = bytes[i + 1], b = bytes[i + 2]; i += 3;
        const end = Math.min(total, o + (n + 1) * 4);
        for (; o < end; o += 4) { pixels[o] = r; pixels[o + 1] = g; pixels[o + 2] = b; pixels[o + 3] = 255; }
      } else {
        const end = Math.min(total, o + (n - 127) * 4);
        for (; o < end; o += 4) { pixels[o] = bytes[i]; pixels[o + 1] = bytes[i + 1]; pixels[o + 2] = bytes[i + 2]; pixels[o + 3] = 255; i += 3; }
      }
      if (i > bytes.length) throw new Error('rettangolo troncato');
    }
    ctx.putImageData(image, x, y);
  }

  function paintFrame(buffer) {
    const view = new DataView(buffer);
    if (view.byteLength && view.getUint8(0) === OUT.ENDED) { ended(new TextDecoder().decode(new Uint8Array(buffer, 1))); return; }
    let at = 0;
    while (at + 5 <= view.byteLength) {
      const type = view.getUint8(at), length = view.getUint32(at + 1, true);
      at += 5;
      if (at + length > view.byteLength) throw new Error('fotogramma troncato');
      if (type === OUT.RESIZE) {
        canvas.width = view.getUint16(at, true); canvas.height = view.getUint16(at + 2, true);
      } else if (type === OUT.RECT) paintRect(view, at, length);
      else if (type === OUT.COPY) {
        const [sx, sy, w, h, dx, dy] = [0, 2, 4, 6, 8, 10].map(k => view.getUint16(at + k, true));
        if (sx + w <= canvas.width && sy + h <= canvas.height && dx + w <= canvas.width && dy + h <= canvas.height) ctx.drawImage(canvas, sx, sy, w, h, dx, dy, w, h);
      } else if (type === OUT.CURSOR) canvas.style.cursor = CURSORS[view.getUint8(at)] || 'default';
      else if (type === OUT.PASTE) void pasteFromMenu();
      else if (type === OUT.SIDEBAR && length >= 4) {
        onSidebar?.({ width: Math.min(view.getUint16(at, true), canvas.width) / scale, top: Math.min(view.getUint16(at + 2, true), canvas.height) / scale });
      }
      else if (type === OUT.FILES) {
        // The zoom, then a line for each open file: in view or not, unsaved or not, its place in the project.
        const [zoom, ...lines] = new TextDecoder().decode(new Uint8Array(buffer, at, length)).split('\n');
        const files = lines.filter(line => line.length > 3).map(line => ({ path: line.slice(3), dirty: line[1] === 'D', shown: line[0] === 'A' }));
        onFiles?.({ files: files.map(({ path, dirty }) => ({ path, dirty })), shown: files.find(file => file.shown)?.path || null, zoom: Number(zoom) || 100 });
      }
      at += length;
    }
  }

  function ended(detail) {
    if (!running) return;
    running = false;
    onEnded?.(detail.trim());
  }

  // ---- what the editor needs to know about this side -------------------------

  function sendSize() {
    const box = host.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return;
    scale = window.devicePixelRatio || 1;
    send(IN.RESIZE, new Uint8Array(new Uint16Array([Math.round(box.width * scale), Math.round(box.height * scale), Math.round(scale * 100)]).buffer));
    sendInset();
  }

  function sendInset() {
    send(IN.INSET, new Uint8Array(new Uint16Array([Math.round(inset * scale)]).buffer));
  }

  /** Every unsaved file is written, and this resolves once the editor has had the time to do it. */
  async function saveAll() {
    if (!running) return;
    send(IN.SAVE, new Uint8Array(0));
    await queue;
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  /** Leaves `height` CSS pixels empty between the tree's title and its rows. */
  function setInset(height) {
    inset = Math.max(0, Math.min(400, Number(height) || 0));
    if (running) sendInset();
  }

  function sendTheme() {
    const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const style = getComputedStyle(document.documentElement);
    const payload = new Uint8Array(26);
    payload[0] = document.documentElement.getAttribute('data-theme-mode') === 'light' ? 0 : 1;
    THEME_TOKENS.forEach((token, index) => {
      // Any CSS colour syntax, resolved by the browser itself.
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = '#000'; probe.fillStyle = style.getPropertyValue(token).trim() || '#000';
      probe.fillRect(0, 0, 1, 1);
      payload.set(probe.getImageData(0, 0, 1, 1).data.subarray(0, 3), 1 + index * 3);
    });
    payload[25] = (window.i18n?.currentLocale || 'it') === 'it' ? 1 : 0;
    send(IN.THEME, payload);
  }

  // ---- input -----------------------------------------------------------------

  let clickCount = 0, clickAt = 0, clickX = 0, clickY = 0;

  function onKeyDown(e) {
    if (e.isComposing) return;
    const command = e.ctrlKey || e.metaKey;
    // Paste is the browser's: it fires the paste event, which carries this side's clipboard in.
    if (command && !e.altKey && e.key.toLowerCase() === 'v') return;
    if (e.shiftKey && !command && !e.altKey && e.key === 'Insert') return;   // the terminals' other paste
    let code = KEYS[e.key];
    if (!code && /^F([1-9]|1[0-2])$/.test(e.key)) code = 20 + Number(e.key.slice(1));
    if (!code && (command || e.altKey) && e.key.length === 1) code = e.key.toUpperCase().charCodeAt(0);
    if (!code) return;                                   // plain text arrives through the input event
    e.preventDefault();
    const payload = new Uint8Array(4);
    payload[0] = 1; payload[1] = code & 0xFF; payload[2] = code >> 8; payload[3] = mods(e);
    send(IN.KEY, payload);
  }

  function onInput() {
    if (sink.value) send(IN.TEXT, new TextEncoder().encode(sink.value));
    sink.value = '';
  }

  function onPaste(e) {
    e.preventDefault();
    sendPaste(e.clipboardData?.getData('text/plain') || '');
  }

  // Paste chosen from the editor's own menu: it has no clipboard of this side, so it asks
  // the desktop, which reads it without the webview's permission prompt. Unreadable means
  // empty, and the editor then pastes what it copied itself.
  async function pasteFromMenu() {
    let text = '';
    try { text = await invoke()('editor_clipboard'); } catch {}
    sendPaste(typeof text === 'string' ? text : '');
  }

  function sendPaste(text) {
    const bytes = new TextEncoder().encode(text);
    for (let at = 0; at === 0 || at < bytes.length; at += MAX_PASTE_PIECE) {
      const piece = bytes.subarray(at, at + MAX_PASTE_PIECE);
      send(IN.PASTE, join(new Uint8Array([at + MAX_PASTE_PIECE >= bytes.length ? 1 : 0]), piece));
    }
  }

  function onPointerDown(e) {
    sink.focus({ preventScroll: true });
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = point(e), now = performance.now();
    clickCount = now - clickAt < 400 && Math.abs(x - clickX) < 6 && Math.abs(y - clickY) < 6 ? clickCount + 1 : 1;
    clickAt = now; clickX = x; clickY = y;
    send(IN.BUTTON, join(new Uint8Array([e.button, 1]), i16(x, y), new Uint8Array([mods(e), Math.min(clickCount, 3)])));
  }
  function onPointerUp(e) {
    const [x, y] = point(e);
    send(IN.BUTTON, join(new Uint8Array([e.button, 0]), i16(x, y), new Uint8Array([mods(e), 1])));
  }
  let moveQueued = null;
  function onPointerMove(e) {
    // At most one move per animation frame: the editor redraws once per frame anyway.
    const first = !moveQueued;
    moveQueued = point(e);
    if (first) requestAnimationFrame(() => { const [x, y] = moveQueued; moveQueued = null; send(IN.MOVE, i16(x, y)); });
  }
  function onWheel(e) {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 600 : 1;
    const [x, y] = point(e);
    send(IN.WHEEL, join(i16(x, y, e.deltaX * unit * scale, e.deltaY * unit * scale), new Uint8Array([mods(e)])));
  }
  const onFocus = (on) => () => send(IN.FOCUS, new Uint8Array([on ? 1 : 0]));

  // ---- lifecycle ---------------------------------------------------------------

  function mount(container) {
    if (canvas) return;
    host = container;
    canvas = document.createElement('canvas');
    canvas.className = 'code-canvas';
    ctx = canvas.getContext('2d', { alpha: false });
    // The keyboard lands in an invisible field: that is what gives dead keys, IME and paste for free.
    sink = document.createElement('textarea');
    sink.className = 'code-canvas-sink';
    sink.setAttribute('aria-label', 'Editor');
    for (const [name, value] of [['autocapitalize', 'off'], ['autocomplete', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false']]) sink.setAttribute(name, value);
    host.append(canvas, sink);
    sink.addEventListener('keydown', onKeyDown);
    sink.addEventListener('input', onInput);
    sink.addEventListener('compositionend', onInput);
    sink.addEventListener('paste', onPaste);
    sink.addEventListener('copy', e => e.preventDefault());   // nothing leaves the container, the clipboard included
    sink.addEventListener('cut', e => e.preventDefault());
    sink.addEventListener('focus', onFocus(true));
    sink.addEventListener('blur', onFocus(false));
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    new ResizeObserver(() => { if (running) sendSize(); }).observe(host);
    window.matchMedia('(resolution: 1dppx)').addEventListener?.('change', () => { if (running) sendSize(); });
    window.addEventListener('synthorg-theme-changed', () => { if (running) sendTheme(); });
    window.addEventListener('synthorg-locale-changed', () => { if (running) sendTheme(); });
  }

  async function start(container, runtime, { ended: endedCallback, title = '', sidebar = null, files = null } = {}) {
    if (!invoke()) throw new Error('desktop');
    mount(container);
    onEnded = endedCallback;
    onSidebar = sidebar;
    onFiles = files;
    const frames = new window.__TAURI__.core.Channel();
    frames.onmessage = (message) => {
      try { paintFrame(message instanceof ArrayBuffer ? message : new Uint8Array(message).buffer); }
      catch (error) { ended(error.message); void stop(); }
    };
    await invoke()('editor_start', { runtime, title, frames });
    running = true;
    canvas.hidden = false;
    // The files are in the page's column: the editor keeps its own tree closed.
    send(IN.TREE, new Uint8Array([0]));
    sendTheme();
    sendSize();
    sink.focus({ preventScroll: true });
  }

  async function stop() {
    running = false;
    if (canvas) canvas.hidden = true;
    try { await invoke()?.('editor_stop'); } catch {}
  }

  /** Opens a file of the project, named by its place in it, in a tab of the editor. */
  function openFile(path) {
    const bytes = new TextEncoder().encode(String(path));
    if (bytes.length && bytes.length < 4000) send(IN.OPEN, bytes);
  }

  /** What the page's bar asks: 'undo', 'redo', 'save' on the file in view; 'zoomIn', 'zoomOut', 'zoomReset'. */
  function perform(what) {
    if (running && DO[what]) send(IN.DO, new Uint8Array([DO[what]]));
  }

  /** Closes an open file, named by its place in the project, as its tab's cross would. */
  function closeFile(path) {
    const bytes = new TextEncoder().encode(String(path));
    if (bytes.length && bytes.length < 4000) send(IN.SHUT, bytes);
  }

  window.codeCanvas = { start, stop, setInset, saveAll, openFile, closeFile, perform, focus: () => sink?.focus({ preventScroll: true }), get running() { return running; } };
})();
