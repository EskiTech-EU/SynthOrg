'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

/**
 * The base image every environment is built from, kept once and for all.
 *
 * It comes from Alpine's own release CDN, not from a registry, and it is
 * checked against the sha256 that release publishes: we know the bytes are the
 * ones Alpine shipped and that they are the same bytes every time. "latest"
 * never moves under the application's feet, because no tag named latest is
 * involved.
 *
 * It is kept in a folder of its own that belongs to no project and to no
 * container engine. Removing every project, resetting the engine or
 * recreating the WSL distribution leaves the archive exactly where it is:
 * one download, and never again for this version.
 *
 * To move to a newer Alpine, change VERSION and the two digests. The next
 * environment created notices the version it holds is not this one and
 * imports the new one; existing containers are untouched until they are
 * rebuilt.
 */
const VERSION = '3.23.6';
const BRANCH = 'v3.23';
const CDN = 'https://dl-cdn.alpinelinux.org/alpine';

/** Published by Alpine in releases/<arch>/latest-releases.yaml for this version. */
const RELEASES = {
  x64: {
    file: `alpine-minirootfs-${VERSION}-x86_64.tar.gz`,
    arch: 'x86_64',
    size: 3699883,
    sha256: '6fc0e3639a1c01f156970d7626aab90bc90697117069dbc39ad880b84efa319a'
  },
  arm64: {
    file: `alpine-minirootfs-${VERSION}-aarch64.tar.gz`,
    arch: 'aarch64',
    size: 4026314,
    sha256: 'b17a57958e29735ff0e6e64254d958e65903687a70ca30cc430b33a965ad49d7'
  }
};

/** What the engine calls it once imported: our name, our version, no registry. */
const IMAGE_NAME = 'localhost/synthorg-base';
const BASE_IMAGE = `${IMAGE_NAME}:${VERSION}`;

function releaseFor(arch = process.arch) {
  const release = RELEASES[arch];
  if (!release) {
    throw Object.assign(new Error(`Architettura non supportata per l'immagine base: ${arch}.`), { status: 501 });
  }
  return release;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * The master folder: the archives, and beside each one a note saying where it
 * came from and what it hashed to, so what is on disk can be told apart from
 * something that merely has the right name.
 */
class BaseImageStore {
  constructor({ dir, fetchImpl = globalThis.fetch, arch = process.arch, release = null } = {}) {
    this.dir = dir;
    this.fetchImpl = fetchImpl;
    // `release` is how the tests point this at bytes they control; nothing in
    // the application passes it, and the pin above is what ships.
    this.release = release || releaseFor(arch);
    this.pending = null;
  }

  get version() { return this.release.version || VERSION; }
  get image() { return `${IMAGE_NAME}:${this.version}`; }
  get archive() { return path.join(this.dir, this.release.file); }
  get marker() { return `${this.archive}.json`; }
  get url() { return this.release.url || `${CDN}/${BRANCH}/releases/${this.release.arch}/${this.release.file}`; }

  /** Whether the archive on disk is the one this build expects, bytes included. */
  verified() {
    try {
      const note = JSON.parse(fs.readFileSync(this.marker, 'utf8'));
      if (note.sha256 !== this.release.sha256) return false;
      const data = fs.readFileSync(this.archive);
      return data.length === this.release.size && sha256(data) === this.release.sha256;
    } catch { return false; }
  }

  /**
   * The archive, downloaded if this machine does not have it yet. Concurrent
   * callers share the one download: several projects opening at once must not
   * fetch the same file several times.
   */
  ensure() {
    if (!this.pending) {
      this.pending = this.download().catch(error => {
        this.pending = null;
        throw error;
      });
    }
    return this.pending;
  }

  async download() {
    if (this.verified()) return this.archive;
    let response;
    try {
      response = await this.fetchImpl(this.url, { redirect: 'follow', signal: AbortSignal.timeout(5 * 60 * 1000) });
    } catch (error) {
      throw Object.assign(new Error(`Immagine base non scaricabile da ${this.url}: ${error.message}`), { status: 502 });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`Immagine base non scaricabile (${response.status}) da ${this.url}.`), { status: 502 });
    }
    const data = Buffer.from(await response.arrayBuffer());
    const digest = sha256(data);
    if (digest !== this.release.sha256) {
      // Never keep bytes that are not the ones Alpine published: a mirror that
      // hands back something else must fail loudly, not end up in an image.
      throw Object.assign(
        new Error(`L'immagine base scaricata non corrisponde alla firma pubblicata da Alpine (atteso ${this.release.sha256}, ottenuto ${digest}).`),
        { status: 502 }
      );
    }
    fs.mkdirSync(this.dir, { recursive: true });
    // Written beside the target and renamed, so an interrupted download never
    // leaves a half file that looks finished.
    const temporary = `${this.archive}.part`;
    fs.writeFileSync(temporary, data);
    fs.renameSync(temporary, this.archive);
    fs.writeFileSync(this.marker, JSON.stringify({
      url: this.url, version: this.version, arch: this.release.arch, size: data.length, sha256: digest, at: new Date().toISOString()
    }, null, 2) + '\n');
    return this.archive;
  }

  /** What the folder holds, for the environment page and for diagnostics. */
  status() {
    const present = this.verified();
    return {
      image: this.image,
      version: this.version,
      arch: this.release.arch,
      url: this.url,
      path: this.archive,
      size: this.release.size,
      present
    };
  }
}

module.exports = { BaseImageStore, BASE_IMAGE, IMAGE_NAME, VERSION, RELEASES, releaseFor };
