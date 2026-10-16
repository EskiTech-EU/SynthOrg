'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fail } = require('./database');
const { ROOT } = require('./paths');

/**
 * photocraft, the photo editor of the Studio's Foto tab, as far as the
 * service knows it.
 *
 * It does not run here. It is a web build (scripts/build-photocraft.js: the
 * newest release's source plus SynthOrg's side of the shell) that the page
 * loads in a frame of the Foto tab, where it is painted in SynthOrg's colours
 * and driven through `window.synthorgPhotocraft`. There is no process, no
 * window and no socket: the app lives in the page, and what the model does to
 * it goes page-side, after this service has settled the permission.
 *
 * What is left for the service: saying which build the installation carries,
 * and asking upstream — only when the user asks — whether a newer release is
 * out. A newer release reaches the user with the next build of SynthOrg.
 */
const API_LATEST = 'https://api.github.com/repos/storytold/photocraft/releases/latest';

function firstExisting(candidates) {
  return candidates.find(dir => fs.existsSync(dir)) || candidates[0];
}

// A web asset: the page loads it from /photocraft/index.html. An installed app has the build inside the
// page's own bundle, and beside the service only the stamp that says which build it is.
const PHOTOCRAFT_DIR = firstExisting([path.join(ROOT, 'resources', 'photocraft'), path.join(ROOT, 'photocraft')]);

/** The build of photocraft this installation carries, or null. */
function installedBuild(dir = PHOTOCRAFT_DIR) {
  const stampFile = path.join(dir, 'build.json');
  if (!fs.existsSync(stampFile)) return null;
  try {
    const stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
    if (!stamp.tag) return null;
    return { tag: stamp.tag, commit: stamp.commit || null, builtAt: stamp.builtAt || null, changes: stamp.changes || null, wasmBytes: stamp.wasmBytes || null };
  } catch { return null; }
}

class Photocraft {
  constructor({ store, dir = PHOTOCRAFT_DIR, fetchImpl = globalThis.fetch }) {
    this.store = store;
    this.dir = dir;
    this.fetchImpl = fetchImpl;
  }

  build() { return installedBuild(this.dir); }

  status() {
    const build = this.build();
    let latest = null;
    try { latest = JSON.parse(this.store()?.getSetting('photocraft_latest') || 'null'); } catch {}
    return { available: Boolean(build), installed: build, latest };
  }

  /** What upstream has published, asked only when the user asks: nothing is downloaded. */
  async checkLatest() {
    const response = await this.fetchImpl(API_LATEST, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SynthOrg' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) fail(`GitHub non risponde (${response.status}).`, 502);
    const release = await response.json();
    const latest = { tag: release.tag_name, publishedAt: release.published_at, url: release.html_url, checkedAt: new Date().toISOString() };
    this.store().setSetting('photocraft_latest', JSON.stringify(latest));
    return { ...this.status(), latest };
  }
}

module.exports = { Photocraft, installedBuild, PHOTOCRAFT_DIR };
