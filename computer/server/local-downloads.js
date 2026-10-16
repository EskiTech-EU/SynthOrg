'use strict';
// Model downloads from the Hub into data/models. A model is gigabytes: each
// file comes down as `<name>.part` and a restart continues from the bytes
// already on disk with a Range request. Repository, revision and files are
// written in the index before the first byte, so a download interrupted by
// closing the app is still there to continue. A finished file is checked
// against the SHA-256 the Hub publishes for it before it takes its name.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { fail } = require('./database');

const PART = '.part';
// Nothing arriving for this long means the connection is gone, whatever the size.
const STALL_MS = 60000;

class ModelDownloads {
  /**
   * @param index  { get(), save() }: the models' index, where downloads are kept
   * @param onDone called with the job when every file is in place
   */
  constructor({ modelsDir, hub, index, onDone = () => {}, fetchImpl = globalThis.fetch }) {
    this.modelsDir = modelsDir;
    this.hub = hub;
    this.index = index;
    this.onDone = onDone;
    this.fetch = fetchImpl;
    this.active = new Map(); // id → { controller, received, error, status }
  }

  kept() { return this.index.get().downloads; }

  /** Running downloads and the interrupted ones that can be continued. */
  list() {
    return Object.entries(this.kept()).map(([id, job]) => {
      const live = this.active.get(id);
      const total = job.files.reduce((sum, file) => sum + file.size, 0);
      return {
        id, repo: job.repo, name: job.name, total,
        received: live ? live.received : this.onDisk(job),
        status: live ? live.status : (job.error ? 'failed' : 'paused'),
        error: live?.error || job.error || null
      };
    });
  }

  onDisk(job) {
    let bytes = 0;
    for (const file of job.files) {
      const done = this.size(path.join(this.modelsDir, file.name));
      bytes += done !== null ? done : (this.size(path.join(this.modelsDir, file.name + PART)) || 0);
    }
    return bytes;
  }

  size(file) { try { return fs.statSync(file).size; } catch { return null; } }

  /** Starts the download of one model of a repository, with its projector when it has one. */
  async start(repoId, modelPath) {
    const repo = await this.hub.repo(repoId);
    const model = repo.models.find(entry => entry.path === modelPath);
    if (!model) fail('File non trovato nel repository.', 404);
    const projector = repo.projectors.find(entry => entry.path === model.projectorPath) || null;
    const files = [...model.parts, ...(projector ? projector.parts : [])].map(part => ({ ...part, name: path.basename(part.path) }));
    const id = model.name;
    if (this.active.has(id)) return this.list().find(job => job.id === id);
    const missing = files.reduce((sum, file) => sum + (this.size(path.join(this.modelsDir, file.name)) === file.size ? 0 : file.size - (this.size(path.join(this.modelsDir, file.name + PART)) || 0)), 0);
    if (missing === 0) fail('Questo modello è già nella cartella.', 409);
    fs.mkdirSync(this.modelsDir, { recursive: true });
    const free = fs.statfsSync(this.modelsDir);
    if (Number(free.bavail) * Number(free.bsize) < missing) fail('Sul disco non c’è spazio per questo modello.', 507);
    this.kept()[id] = { repo: repo.id, revision: repo.revision, description: repo.description || null, name: id, model: model.name, projector: projector?.name || null, files };
    this.index.save();
    return this.run(id);
  }

  resume(id) {
    if (!this.kept()[id]) fail('Download non trovato.', 404);
    if (this.active.has(id)) return this.list().find(job => job.id === id);
    return this.run(id);
  }

  run(id) {
    const job = this.kept()[id];
    delete job.error;
    const live = { controller: new AbortController(), received: this.onDisk(job), status: 'running', error: null };
    this.active.set(id, live);
    this.fetchAll(job, live).then(() => {
      this.active.delete(id);
      delete this.kept()[id];
      this.index.save();
      this.onDone(job);
    }, (error) => {
      this.active.delete(id);
      // Stopped by the user: the parts stay, nothing to report.
      if (!live.controller.signal.aborted && this.kept()[id]) { this.kept()[id].error = error.message || 'Download interrotto.'; this.index.save(); }
    });
    return this.list().find(entry => entry.id === id);
  }

  /** Stops a running download; what arrived stays on disk to continue from. */
  cancel(id) {
    this.active.get(id)?.controller.abort();
    return { stopped: true };
  }

  /** Forgets a download and deletes what arrived of it. */
  discard(id) {
    const job = this.kept()[id];
    if (!job) return { discarded: true };
    this.active.get(id)?.controller.abort();
    for (const file of job.files) fs.rmSync(path.join(this.modelsDir, file.name + PART), { force: true });
    delete this.kept()[id];
    this.index.save();
    return { discarded: true };
  }

  stopAll() { for (const live of this.active.values()) live.controller.abort(); }

  async fetchAll(job, live) {
    for (const file of job.files) {
      const target = path.join(this.modelsDir, file.name);
      if (this.size(target) === file.size) continue;
      await this.fetchFile(job, file, live);
      await this.verify(file, live.controller.signal);
      fs.renameSync(target + PART, target);
    }
  }

  async fetchFile(job, file, live) {
    const part = path.join(this.modelsDir, file.name + PART);
    let offset = this.size(part) || 0;
    if (offset >= file.size && file.size > 0) return;
    const stall = new AbortController();
    let timer = null;
    const alive = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(), STALL_MS); };
    alive();
    try {
      const response = await this.fetch(this.hub.fileUrl(job.repo, job.revision, file.path), {
        headers: { ...this.hub.authorization(), ...(offset ? { Range: `bytes=${offset}-` } : {}) },
        signal: AbortSignal.any([live.controller.signal, stall.signal])
      });
      if (response.status === 401 || response.status === 403) throw new Error('Il repository richiede l’accesso: serve la chiave Hugging Face e l’accettazione della licenza sul sito.');
      if (response.status === 416) return;
      if (response.status === 200) { live.received -= offset; offset = 0; } // the Range was ignored: from the start
      else if (response.status !== 206) throw new Error(`Hugging Face ha risposto ${response.status}.`);
      const out = fs.createWriteStream(part, { flags: offset ? 'a' : 'w' });
      try {
        for await (const chunk of response.body) {
          alive();
          live.received += chunk.length;
          if (!out.write(chunk)) await once(out, 'drain');
        }
      } finally {
        await new Promise(resolve => out.end(resolve));
      }
    } catch (error) {
      if (stall.signal.aborted) throw new Error('La connessione si è fermata: il download si può riprendere.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (file.size > 0 && this.size(part) < file.size) throw new Error('La connessione è caduta: il download si può riprendere.');
  }

  /** The bytes on disk are the ones the Hub published: same SHA-256. */
  async verify(file, signal) {
    if (!file.sha256) return;
    const part = path.join(this.modelsDir, file.name + PART);
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(part, { highWaterMark: 4 * 1024 * 1024, signal })) hash.update(chunk);
    if (hash.digest('hex') !== file.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error('Il file scaricato non corrisponde a quello pubblicato: va scaricato di nuovo.');
    }
  }
}

module.exports = { ModelDownloads, PART };
