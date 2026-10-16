// Resizing the undecorated window on Linux.
//
// On Windows the OS keeps a resize border around an undecorated window. On
// Linux nothing does: GTK gives such a window no border, and Tauri's own
// handler is only attached to a window's single webview, not to the webviews
// of a window that has several (ours has the page and the Code editor).
//
// So each webview carries thin strips along the edges it shares with the
// window. They only show the right cursor and hand the gesture to the window
// manager through startResizeDragging(): no geometry is computed here.
//
// The page has all four edges. Which edges of the Code editor are window
// edges depends on where the page has placed it: the host knows, says so
// through window.__synthorgResizeEdges() at every layout, and answers
// code_resize_edges for an editor that has just (re)loaded.
(() => {
  if (!/Linux/i.test(navigator.userAgent) || /Android/i.test(navigator.userAgent)) return;
  const SIZE = 5;
  const CORNER = 12;
  const STRIPS = [
    // [direction, cursor, edges it needs, css]
    ['North', 'ns-resize', ['top'], `top:0;left:0;right:0;height:${SIZE}px`],
    ['South', 'ns-resize', ['bottom'], `bottom:0;left:0;right:0;height:${SIZE}px`],
    ['West', 'ew-resize', ['left'], `top:0;bottom:0;left:0;width:${SIZE}px`],
    ['East', 'ew-resize', ['right'], `top:0;bottom:0;right:0;width:${SIZE}px`],
    ['NorthWest', 'nwse-resize', ['top', 'left'], `top:0;left:0;width:${CORNER}px;height:${CORNER}px`],
    ['NorthEast', 'nesw-resize', ['top', 'right'], `top:0;right:0;width:${CORNER}px;height:${CORNER}px`],
    ['SouthWest', 'nesw-resize', ['bottom', 'left'], `bottom:0;left:0;width:${CORNER}px;height:${CORNER}px`],
    ['SouthEast', 'nwse-resize', ['bottom', 'right'], `bottom:0;right:0;width:${CORNER}px;height:${CORNER}px`]
  ];
  const embedded = Boolean(window.__SYNTHORG_EMBEDDED__);
  const NONE = { top: false, right: false, bottom: false, left: false };
  let edges = embedded ? NONE : { top: true, right: true, bottom: true, left: true };
  let maximized = false;
  const strips = [];

  const appWindow = () => {
    try { return window.__TAURI__?.window?.getCurrentWindow?.() || null; } catch { return null; }
  };

  function refresh() {
    for (const { node, needs } of strips) {
      node.style.display = !maximized && needs.every(edge => edges[edge]) ? 'block' : 'none';
    }
  }

  async function syncMaximized() {
    try { maximized = Boolean(await appWindow()?.isMaximized()); } catch { maximized = false; }
    refresh();
  }

  function install() {
    if (!appWindow()) return;
    for (const [direction, cursor, needs, css] of STRIPS) {
      const node = document.createElement('div');
      node.setAttribute('aria-hidden', 'true');
      node.style.cssText = `position:fixed;z-index:2147483647;${css};cursor:${cursor};touch-action:none`;
      // mousedown, not pointerdown: the window manager takes the pointer for
      // the whole gesture and WebKit never sees the release, so it still holds
      // the pointer as pressed and the next press raises no pointerdown.
      node.addEventListener('mousedown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        appWindow()?.startResizeDragging(direction).catch(error => console.warn('[Window Resize]', error));
      });
      document.documentElement.appendChild(node);
      strips.push({ node, needs });
    }
    appWindow().onResized(syncMaximized).catch(() => {});
    syncMaximized();
    if (embedded) {
      window.__TAURI__?.core?.invoke?.('code_resize_edges')
        .then(next => window.__synthorgResizeEdges(next)).catch(() => {});
    }
  }

  window.__synthorgResizeEdges = next => {
    edges = { ...NONE, ...next };
    refresh();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
