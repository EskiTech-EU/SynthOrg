'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * The editor extensions that go into a coding project's image.
 *
 * They are not a special kind of thing: like the packages of a chat sandbox,
 * they are stuff you may want in the environment or may not, and the choice
 * lives on the Environment page next to the others. None of them is needed to
 * run the pod — git, Node, the agent and the editor are what run it, and the
 * editor draws its own syntax colours — so every one of them is optional.
 *
 * What makes the choice real is the manifest file: the image's identity is a
 * hash of the runtime's files, this one included, so turning an extension off
 * gives the next project a different image and it is rebuilt without it. A
 * switch that only stopped them loading would have left the megabytes there.
 */

/** Not an extension: the dependencies the extensions themselves share. */
const SHARED_MODULES = 'node_modules';

function directorySize(dir) {
  let total = 0;
  const walk = current => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try { total += fs.statSync(full).size; } catch {}
      }
    }
  };
  walk(dir);
  return total;
}

/** The name an extension shows, from its own manifest, falling back to the folder. */
function describe(dir, name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const nls = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.nls.json'), 'utf8')); } catch { return {}; }
    })();
    const resolve = value => {
      if (typeof value !== 'string') return '';
      const key = /^%(.+)%$/.exec(value);
      return key ? String(nls[key[1]] || '') : value;
    };
    return {
      title: resolve(pkg.displayName) || name,
      description: resolve(pkg.description) || '',
      categories: Array.isArray(pkg.categories) ? pkg.categories.slice(0, 3) : []
    };
  } catch {
    return { title: name, description: '', categories: [] };
  }
}

class CodeExtensionCatalog {
  constructor({ dir, manifestPath }) {
    this.dir = dir;
    this.manifestPath = manifestPath;
    this.cache = null;
  }

  /**
   * Only the ones asked for are written down, and nothing is asked for by
   * default.
   *
   * In a container nothing loads them: the editor there is ours and draws its
   * own colours, and the extension host only starts when the workbench binds
   * to a container, which it no longer does. Carrying them would be fifty
   * megabytes that no process opens. An extension that a later build adds
   * stays out for the same reason, until someone turns it on.
   */
  enabledNames() {
    try {
      const manifest = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
      return new Set(Array.isArray(manifest.enabled) ? manifest.enabled : []);
    } catch { return new Set(); }
  }

  saveEnabled(names) {
    fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
    fs.writeFileSync(this.manifestPath, JSON.stringify({ enabled: [...names].sort() }, null, 2) + '\n');
    this.cache = null;
  }

  /** Every extension the build shipped, with what it weighs and whether it is in. */
  list() {
    if (!this.cache) {
      let entries = [];
      try { entries = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { entries = []; }
      this.cache = entries
        .filter(entry => entry.isDirectory() && entry.name !== SHARED_MODULES && !entry.name.startsWith('.'))
        .map(entry => {
          const full = path.join(this.dir, entry.name);
          return { name: entry.name, bytes: directorySize(full), ...describe(full, entry.name) };
        })
        .sort((a, b) => b.bytes - a.bytes);
    }
    const on = this.enabledNames();
    return this.cache.map(item => ({ ...item, enabled: on.has(item.name) }));
  }

  /** The names that belong in the image, for whoever builds it. */
  enabled() {
    return this.list().filter(item => item.enabled).map(item => item.name);
  }

  setEnabled(name, enabled) {
    const known = this.list().some(item => item.name === name);
    if (!known) {
      throw Object.assign(new Error(`Estensione non trovata: ${name}.`), { status: 404 });
    }
    const on = this.enabledNames();
    if (enabled) on.add(name);
    else on.delete(name);
    this.saveEnabled(on);
    return this.summary();
  }

  /** What the Environment page shows above the list. */
  summary() {
    const items = this.list();
    const on = items.filter(item => item.enabled);
    const shared = directorySize(path.join(this.dir, SHARED_MODULES));
    return {
      total: items.length,
      enabled: on.length,
      // The shared dependencies travel only if something still needs them.
      bytes: on.reduce((sum, item) => sum + item.bytes, 0) + (on.length ? shared : 0),
      totalBytes: items.reduce((sum, item) => sum + item.bytes, 0) + shared,
      sharedBytes: shared,
      items
    };
  }
}

module.exports = { CodeExtensionCatalog, SHARED_MODULES, directorySize };
