/*
 * Allowlist sanitizer for rendered message content.
 *
 * Chat bodies are assembled from model output, from pages fetched by the browse
 * tool and from filenames created inside the sandbox container, then written
 * with innerHTML. The renderer escapes that input before building its markup —
 * that is what makes it safe — and this pass is the second layer: it parses the
 * finished markup and keeps only known tags and attributes, so a later edit to
 * a template cannot quietly reintroduce an executable attribute.
 *
 * Parsing happens inside a <template>, whose content is an inert document
 * fragment: no script runs and no media request is issued while the tree is
 * being inspected.
 */
(function () {
  'use strict';

  const ALLOWED_TAGS = new Set([
    'A', 'AUDIO', 'BLOCKQUOTE', 'BR', 'BUTTON', 'CODE', 'DIV', 'EM', 'H2', 'H3',
    'H4', 'I', 'IMG', 'LI', 'OL', 'P', 'PRE', 'SPAN', 'STRONG', 'TABLE', 'TBODY',
    'TD', 'TH', 'THEAD', 'TR', 'UL', 'VIDEO'
  ]);

  // Removed with their subtree: unwrapping these would keep hostile content.
  const DROP_WITH_CONTENT = new Set([
    'SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET',
    'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION',
    'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT'
  ]);

  const GLOBAL_ATTRS = new Set(['class', 'title']);

  const TAG_ATTRS = {
    A: new Set(['href', 'target', 'rel', 'download']),
    IMG: new Set(['src', 'alt', 'loading']),
    VIDEO: new Set(['src', 'controls', 'preload', 'playsinline']),
    AUDIO: new Set(['src', 'controls', 'preload']),
    BUTTON: new Set(['type'])
  };

  // Data attributes the delegated handlers read. Anything else is dropped.
  const DATA_ATTRS = new Set([
    'data-media-src', 'data-media-kind', 'data-media-title',
    'data-file-src', 'data-copy-code', 'data-stop-propagation',
    'data-artifact-name', 'data-artifact-url', 'data-artifact-category'
  ]);

  const URL_ATTRS = new Set(['href', 'src', 'data-media-src', 'data-file-src', 'data-artifact-url']);
  const SAFE_SCHEME = /^(https?:|blob:|data:(image|audio|video)\/)/i;

  function safeUrlValue(value) {
    const trimmed = String(value || '').trim().replace(/^[\x00-\x20]+/, '');
    if (!trimmed) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return SAFE_SCHEME.test(trimmed) ? trimmed : null;
    if (trimmed.startsWith('//')) return null;
    return trimmed;
  }

  function cleanElement(element) {
    const tag = element.tagName;

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const allowed = name.startsWith('data-')
        ? DATA_ATTRS.has(name)
        : GLOBAL_ATTRS.has(name) || Boolean(TAG_ATTRS[tag] && TAG_ATTRS[tag].has(name));

      // Covers every on* handler, style, and anything not explicitly listed.
      if (!allowed) { element.removeAttribute(attribute.name); continue; }

      if (URL_ATTRS.has(name)) {
        const url = safeUrlValue(attribute.value);
        if (url === null) element.removeAttribute(attribute.name);
        else element.setAttribute(attribute.name, url);
      }
    }

    if (tag === 'A' && element.hasAttribute('href')) {
      element.setAttribute('rel', 'noopener noreferrer');
      if (element.getAttribute('target')) element.setAttribute('target', '_blank');
    }
  }

  function sanitize(html) {
    if (html === null || html === undefined) return '';
    if (typeof document === 'undefined' || !document.createElement) return String(html);

    let template;
    try {
      template = document.createElement('template');
      template.innerHTML = String(html);
    } catch (_) {
      return '';
    }
    if (!template.content) return String(html);

    // Snapshot first: the tree is modified while it is walked.
    for (const element of Array.from(template.content.querySelectorAll('*'))) {
      if (!template.content.contains(element)) continue;
      const tag = element.tagName;

      if (DROP_WITH_CONTENT.has(tag)) { element.remove(); continue; }

      if (!ALLOWED_TAGS.has(tag)) {
        // Unknown but not dangerous: keep the text, drop the element.
        const parent = element.parentNode;
        if (!parent) continue;
        while (element.firstChild) parent.insertBefore(element.firstChild, element);
        element.remove();
        continue;
      }

      cleanElement(element);
    }

    return template.innerHTML;
  }

  window.synthorgSanitize = sanitize;
})();
