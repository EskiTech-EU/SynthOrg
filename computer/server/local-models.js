'use strict';
// Local inference: llama-server processes on the host, one per loaded model,
// as many at once as the memory holds. Each only runs inference and speaks the
// same OpenAI protocol as every remote provider, so a local model is a model
// like any other.
//
// What a model is — context, layers, recommended sampling, whether it thinks —
// is read from its GGUF header (gguf-info.js) and, once loaded, from what the
// engine declares about it. Nothing is capped here: the context is the one the
// file states unless the user asks for less, and where the weights go (video
// card, system memory, split between the two) is the user's choice per model.
const fs = require('node:fs');
const os = require('node:os');
const { dataDirFor } = require('./paths');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { parseGgufShardFilename } = require('@huggingface/gguf');
const { fail } = require('./database');
const { readLocal } = require('./gguf-info');
const { HuggingFaceHub } = require('./hf-hub');
const { ModelDownloads } = require('./local-downloads');

const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const ID_PREFIX = 'local/';
// Headroom left free on each GPU by llama.cpp's auto-fit, in MiB. Everything
// else (layers, context) is sized by the engine to fill the device.
const FIT_MARGIN_MIB = 256;
// Where the weights go. `auto` lets the engine fit what it can on the video
// card and keep the rest in system memory; the others are taken literally.
const PLACEMENTS = ['auto', 'gpu', 'cpu', 'split'];
const DEVICES_FRESH_MS = 2000;
const DEVICES_TIMEOUT_MS = 15000;
// The engine says what it reserved while loading — layers on the video card,
// buffers per device — at this log level; a request adds a few dozen lines.
const LOG_LEVEL = '4';
const BUFFER_LINE = /(\S+)\s+(?:model|KV|compute|output) buffer size\s*=\s*([\d.]+) MiB/;
const OFFLOAD_LINE = /offloaded (\d+)\/(\d+) layers to GPU/;
// Buffers the engine names after the processor or the host side of a device are system memory.
const inSystemMemory = (device) => /^CPU|_Host$/i.test(device);
const MIB = 1048576;
// The engine's own words when a load fails for lack of memory.
const OUT_OF_MEMORY = /out of memory|outofdevicememory|failed to allocate|unable to allocate|insufficient memory|bad_alloc/i;

const { freePort } = require('./net-util');

class LocalModelManager {
  constructor({ root, fetchImpl = globalThis.fetch, token = () => null }) {
    this.engineDir = process.env.SYNTHORG_LLAMA_DIR || path.join(root, 'bin', 'llama');
    this.modelsDir = path.join(dataDirFor(root), 'models');
    this.indexPath = path.join(this.modelsDir, 'index.json');
    this.catalogPath = path.join(__dirname, 'local-catalog.json');
    this.fetch = fetchImpl;
    this.engines = new Map();  // id → { id, child, port, apiKey, parallel, … }
    this.starting = new Map(); // id → in-flight start(), so concurrent callers share it
    this.loads = Promise.resolve(); // one load at a time: each sees the memory the previous one left
    this.scanning = null;
    this.devicesRead = null;
    this.idleFree = null; // video memory free with no model loaded
    this.kept = null;
    this.hub = new HuggingFaceHub({ token, fetchImpl });
    this.downloads = new ModelDownloads({
      modelsDir: this.modelsDir, hub: this.hub, fetchImpl,
      index: { get: () => this.index(), save: () => this.saveIndex() },
      onDone: (job) => this.adopt(job)
    });
  }

  engineAvailable() { return fs.existsSync(path.join(this.engineDir, EXE)); }

  catalog() {
    try { return JSON.parse(fs.readFileSync(this.catalogPath, 'utf8')).models || []; } catch { return []; }
  }

  // --- index: what was read from each file, where it came from, how to load it

  index() {
    if (!this.kept) {
      let read = {};
      try { read = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')); } catch {}
      this.kept = { files: read.files || {}, downloads: read.downloads || {} };
    }
    return this.kept;
  }

  saveIndex() {
    fs.mkdirSync(this.modelsDir, { recursive: true });
    fs.writeFileSync(this.indexPath, JSON.stringify(this.index(), null, 1));
  }

  /** Reads the header of every GGUF that is new or changed; returns the file names. */
  scan() {
    if (!this.scanning) this.scanning = this._scan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async _scan() {
    let names = [];
    try { names = fs.readdirSync(this.modelsDir).filter(f => f.toLowerCase().endsWith('.gguf')); } catch {}
    const { files } = this.index();
    let changed = false;
    for (const name of names) {
      const stat = fs.statSync(path.join(this.modelsDir, name));
      const entry = files[name];
      if (entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) continue;
      let info = null;
      try { info = await readLocal(path.join(this.modelsDir, name)); } catch {}
      // A file replaced by another one keeps nothing of what the engine said about the old one.
      files[name] = { source: entry?.source, description: entry?.description, projector: entry?.projector, launch: entry?.launch, size: stat.size, mtimeMs: stat.mtimeMs, info };
      changed = true;
    }
    for (const name of Object.keys(files)) {
      if (!names.includes(name)) { delete files[name]; changed = true; }
    }
    if (changed) this.saveIndex();
    return names;
  }

  /** The files of a model: one, or every part of a split one. */
  partsOf(name, names) {
    const shard = parseGgufShardFilename(name);
    if (!shard) return [name];
    return names.filter(other => parseGgufShardFilename(other)?.prefix === shard.prefix).sort();
  }

  // --- memory: what the machine has free right now

  devices(fresh = false) {
    if (!fresh && this.devicesRead && Date.now() - this.devicesRead.at < DEVICES_FRESH_MS) return this.devicesRead.value;
    const value = new Promise(resolve => {
      if (!this.engineAvailable()) return resolve([]);
      execFile(path.join(this.engineDir, EXE), ['--list-devices'], { cwd: this.engineDir, windowsHide: true, timeout: DEVICES_TIMEOUT_MS }, (error, stdout, stderr) => {
        const devices = [];
        for (const line of `${stdout}\n${stderr}`.split('\n')) {
          const match = /^\s*(\S+):\s+(.+?)\s+\((\d+) MiB, (\d+) MiB free\)\s*$/.exec(line);
          if (match) devices.push({ id: match[1], name: match[2], total: Number(match[3]) * MIB, free: Number(match[4]) * MIB });
        }
        resolve(devices);
      });
    });
    this.devicesRead = { at: Date.now(), value };
    return value;
  }

  /**
   * Video memory the loaded models reserved and have not touched yet. The
   * system counts memory as used only once it is written, so a model loaded
   * with a large context leaves most of it looking free: a second model sized
   * on that figure would end up sharing memory the first one will need.
   */
  async promised() {
    if (!this.engines.size || this.idleFree === null) return 0;
    const devices = await this.devices(true);
    const free = devices.reduce((sum, device) => sum + device.free, 0);
    const reserved = [...this.engines.values()].reduce((sum, engine) => sum + engine.memory.gpu, 0);
    return Math.max(0, reserved - Math.max(0, this.idleFree - free));
  }

  // --- listing

  /** Every model in data/models as its header describes it, with how it is loaded now. */
  async list() {
    const names = await this.scan();
    const { files } = this.index();
    const curated = this.catalog();
    const projectors = names.filter(name => files[name].info?.projector);
    const models = names
      .filter(name => { const info = files[name].info; return !info?.projector && !info?.adapter && !(info?.split && info.split.index > 0); })
      .map(file => {
        const entry = files[file];
        const info = entry.info || {};
        const pick = curated.find(c => c.file.toLowerCase() === file.toLowerCase()) || {};
        const engine = this.engines.get(ID_PREFIX + file);
        const projector = entry.projector && projectors.includes(entry.projector) ? entry.projector : null;
        const launch = { placement: 'auto', gpuLayers: null, context: null, ...(entry.launch || {}) };
        const caps = entry.caps || null;
        return {
          id: ID_PREFIX + file,
          file,
          readable: Boolean(entry.info),
          name: pick.name || info.name || file.replace(/\.gguf$/i, ''),
          // What the file says of itself, or what its authors wrote on the Hub it came from.
          description: pick.description || info.description || entry.description || '',
          size: this.partsOf(file, names).reduce((sum, part) => sum + (files[part]?.size || 0), 0),
          architecture: info.architecture || null,
          quantization: info.quantization || null,
          sizeLabel: info.sizeLabel || null,
          parameterCount: info.parameterCount || null,
          license: info.license || null,
          layers: info.layers || null,
          kvBytesPerToken: info.kvBytesPerToken || null,
          // What the file states, and what requests can count on right now.
          declaredContext: info.contextLength || null,
          contextLength: engine ? engine.context : (launch.context || info.contextLength || null),
          thinking: Boolean(info.templateThinking || caps?.supports_preserve_reasoning || caps?.supports_reasoning_effort || pick.thinking),
          vision: Boolean(projector),
          projector,
          projectorSize: projector ? files[projector].size : 0,
          recommended: { ...(info.sampling || {}), ...(pick.recommended || {}) },
          source: entry.source || null,
          launch,
          caps,
          running: engine ? { placement: engine.placement, context: engine.context, parallel: engine.parallel, gpuLayers: engine.gpuLayers, memory: engine.memory, startedAt: engine.startedAt } : null,
          loading: this.starting.has(ID_PREFIX + file)
        };
      });
    return {
      engineAvailable: this.engineAvailable(),
      modelsDir: this.modelsDir,
      // `promised` is video memory already reserved by loaded models that still reads as free.
      memory: { devices: await this.devices(), promised: await this.promised(), ram: { total: os.totalmem(), free: os.freemem() } },
      projectors,
      models
    };
  }

  fileOf(id) {
    if (typeof id !== 'string' || !id.startsWith(ID_PREFIX)) fail('Modello locale non valido.');
    const file = path.basename(id.slice(ID_PREFIX.length));
    if (!file.toLowerCase().endsWith('.gguf') || !fs.existsSync(path.join(this.modelsDir, file))) fail('Modello locale non trovato.', 404);
    return file;
  }

  // --- how a model is loaded: the user's choice, kept per model

  async setLaunch(id, input = {}) {
    const file = this.fileOf(id);
    const names = await this.scan();
    const entry = this.index().files[file];
    const info = entry.info || {};
    const launch = { placement: 'auto', gpuLayers: null, context: null };
    if (!PLACEMENTS.includes(input.placement)) fail('Collocazione non valida.');
    launch.placement = input.placement;
    if (launch.placement === 'split') {
      const layers = Math.floor(Number(input.gpuLayers));
      if (!Number.isFinite(layers) || layers < 0) fail('Numero di livelli non valido.');
      launch.gpuLayers = layers;
    }
    if (input.context !== null && input.context !== undefined && input.context !== '') {
      const context = Math.floor(Number(input.context));
      if (!Number.isFinite(context) || context < 1) fail('Contesto non valido.');
      if (info.contextLength && context > info.contextLength) fail(`Il modello dichiara un contesto di ${info.contextLength} token.`);
      launch.context = context;
    }
    if (input.projector) {
      if (!names.includes(input.projector) || !this.index().files[input.projector]?.info?.projector) fail('Proiettore non valido.');
      entry.projector = input.projector;
    } else {
      entry.projector = null;
    }
    entry.launch = launch;
    this.saveIndex();
    return { saved: true, running: this.engines.has(id) };
  }

  /**
   * `declared`: the context the file states. `promised`: video memory other
   * loaded models will still take, which the engine's fit must leave alone.
   */
  launchArgs(launch = {}, declared = null, promised = 0) {
    const args = launch.context ? ['-c', String(launch.context)] : [];
    switch (launch.placement) {
      case 'gpu': return [...args, '--fit', 'off', '-ngl', 'all'];
      case 'cpu': return [...args, '--fit', 'off', '--device', 'none'];
      case 'split': return [...args, '--fit', 'off', '-ngl', String(launch.gpuLayers || 0)];
      default: {
        // The fit may move layers to system memory, never take context away:
        // its floor is the context the file states, or the one the user chose.
        const floor = launch.context || declared;
        return [...args, '--fit', 'on', '--fit-target', String(FIT_MARGIN_MIB + Math.ceil(promised / MIB)), ...(floor ? ['--fit-ctx', String(floor)] : [])];
      }
    }
  }

  /**
   * What is in memory now and what was there last, without reading the disk or the video card: for the small
   * manager in the header, which asks often. `recent` are the models loaded before that are not loaded now,
   * the latest first.
   */
  loaded(recent = 3) {
    const { files } = this.index();
    const curated = this.catalog();
    const nameOf = file => curated.find(c => c.file.toLowerCase() === file.toLowerCase())?.name || files[file]?.info?.name || file.replace(/\.gguf$/i, '');
    const fileOf = id => String(id).slice(ID_PREFIX.length);
    const there = file => fs.existsSync(path.join(this.modelsDir, file));
    return {
      engineAvailable: this.engineAvailable(),
      loaded: [...this.engines.values()].sort((a, b) => a.startedAt - b.startedAt).map(engine => ({
        id: engine.id, name: nameOf(fileOf(engine.id)), placement: engine.placement, gpuLayers: engine.gpuLayers, memory: engine.memory, context: engine.context, startedAt: engine.startedAt
      })),
      loading: [...this.starting.keys()].map(id => ({ id, name: nameOf(fileOf(id)) })),
      recent: Object.entries(files)
        .filter(([file, entry]) => entry.loadedAt && entry.info && !entry.info.projector && !entry.info.adapter && !this.engines.has(ID_PREFIX + file) && !this.starting.has(ID_PREFIX + file) && there(file))
        .sort((a, b) => b[1].loadedAt - a[1].loadedAt)
        .slice(0, recent)
        .map(([file, entry]) => ({ id: ID_PREFIX + file, name: nameOf(file), loadedAt: entry.loadedAt, sizeLabel: entry.info.sizeLabel || null, quantization: entry.info.quantization || null }))
    };
  }

  // --- engines

  async start(id, { parallel = 4 } = {}) {
    if (!this.engineAvailable()) fail('Motore locale non installato (bin/llama).', 503);
    const file = this.fileOf(id);
    parallel = Math.max(1, Math.floor(Number(parallel)) || 4);

    const engine = this.engines.get(id);
    if (engine && engine.parallel >= parallel) { engine.lastUsed = Date.now(); return engine.access; }
    if (this.starting.has(id)) { await this.starting.get(id).catch(() => {}); return this.start(id, { parallel }); }
    const load = this.loads.then(() => this._load(id, file, parallel));
    this.loads = load.catch(() => {});
    this.starting.set(id, load);
    try { return await load; } finally { this.starting.delete(id); }
  }

  async _load(id, file, parallel) {
    await this.stop(id);
    await this.scan();
    const entry = this.index().files[file];
    if (!entry?.info) fail('Il file GGUF non è leggibile.', 422);
    if (entry.info.projector || entry.info.adapter) fail('Questo file non è un modello: si carica insieme a un modello.', 422);
    for (;;) {
      const outcome = await this._spawn(id, file, entry, parallel);
      if (outcome.engine) return outcome.engine.access;
      // Not enough memory next to what is loaded: the model used least recently
      // and doing nothing leaves, and the load is tried again.
      const idle = OUT_OF_MEMORY.test(outcome.log) ? await this.idleEngine() : null;
      if (!idle) fail(`Il motore locale non si è avviato: ${outcome.log.trim().split('\n').slice(-3).join(' ')}`, 500);
      await this.stop(idle.id);
    }
  }

  async idleEngine() {
    for (const engine of [...this.engines.values()].sort((a, b) => a.lastUsed - b.lastUsed)) {
      try {
        const slots = await (await this.fetch(`http://127.0.0.1:${engine.port}/slots`, { headers: { Authorization: `Bearer ${engine.apiKey}` } })).json();
        if (Array.isArray(slots) && slots.some(slot => slot.is_processing)) continue;
      } catch {}
      return engine;
    }
    return null;
  }

  async _spawn(id, file, entry, parallel) {
    const port = await freePort();
    const apiKey = randomBytes(24).toString('hex');
    // With nothing loaded, what reads as free is what the models have to share.
    if (!this.engines.size) this.idleFree = (await this.devices(true)).reduce((sum, device) => sum + device.free, 0);
    const args = ['-m', path.join(this.modelsDir, file), '--host', '127.0.0.1', '--port', String(port), '--api-key', apiKey,
      '--jinja', '--no-webui', '-lv', LOG_LEVEL, '-np', String(parallel), '-kvu', ...this.launchArgs(entry.launch, entry.info.contextLength, await this.promised())];
    if (entry.projector && fs.existsSync(path.join(this.modelsDir, entry.projector))) args.push('--mmproj', path.join(this.modelsDir, entry.projector));
    const child = spawn(path.join(this.engineDir, EXE), args, { cwd: this.engineDir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    let pending = '';
    let offloaded = null;
    const memory = { gpu: 0, ram: 0 };
    child.stderr.on('data', chunk => {
      log = (log + chunk).slice(-8000);
      if (this.engines.get(id)?.child === child) return; // loaded: nothing more to read
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const layers = OFFLOAD_LINE.exec(line);
        if (layers) offloaded = { onGpu: Number(layers[1]), total: Number(layers[2]) };
        const buffer = BUFFER_LINE.exec(line);
        if (buffer) memory[inSystemMemory(buffer[1]) ? 'ram' : 'gpu'] += Math.round(Number(buffer[2]) * MIB);
      }
    });
    let exited = false;
    child.once('error', () => { exited = true; });
    child.once('exit', () => { exited = true; if (this.engines.get(id)?.child === child) this.engines.delete(id); });

    // Loading is bounded by the weights' size and the disk, not by a timer:
    // wait for the engine to either answer or exit.
    const headers = { Authorization: `Bearer ${apiKey}` };
    while (!exited) {
      try {
        const res = await this.fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 400));
    }
    if (exited) return { log };

    // What the engine made of the file: the context it really allocated and
    // what the chat template can do. Requests are built on these.
    let props = {};
    try { props = await (await this.fetch(`http://127.0.0.1:${port}/props`, { headers })).json(); } catch {}
    entry.caps = props.chat_template_caps || entry.caps || null;
    entry.modalities = props.modalities || null;
    // When it was last loaded: what the header's small manager offers again first (`loaded`).
    entry.loadedAt = Date.now();
    this.saveIndex();
    const engine = {
      id, child, port, apiKey, parallel,
      placement: entry.launch?.placement || 'auto',
      context: props.default_generation_settings?.n_ctx || entry.launch?.context || entry.info.contextLength || null,
      // With nothing reserved on a device, the layers the engine counted are in system memory.
      gpuLayers: offloaded && memory.gpu === 0 ? { onGpu: 0, total: offloaded.total } : offloaded,
      memory,
      startedAt: Date.now(),
      lastUsed: Date.now(),
      access: { id, port, apiKey, parallel }
    };
    this.engines.set(id, engine);
    return { engine };
  }

  /** Whether a loaded model is answering a request now. */
  async busy(id) {
    const engine = this.engines.get(id);
    if (!engine) return false;
    try {
      const slots = await (await this.fetch(`http://127.0.0.1:${engine.port}/slots`, { headers: { Authorization: `Bearer ${engine.apiKey}` } })).json();
      return Array.isArray(slots) && slots.some(slot => slot.is_processing);
    } catch { return false; }
  }

  /** Unloads one model, or all of them when none is named. */
  async stop(id) {
    const targets = id === undefined ? [...this.engines.values()] : [this.engines.get(id)].filter(Boolean);
    await Promise.all(targets.map(engine => {
      this.engines.delete(engine.id);
      const child = engine.child;
      if (child.exitCode !== null || child.signalCode !== null) return null;
      return new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    }));
  }

  /** Closing the app: every engine stops, downloads keep what arrived. */
  close() {
    this.downloads.stopAll();
    return this.stop();
  }

  // --- files

  /** Deletes a model: its parts, and its projector when no other model uses it. */
  async remove(id) {
    const file = this.fileOf(id);
    await this.stop(id);
    const names = await this.scan();
    const { files } = this.index();
    const projector = files[file]?.projector;
    for (const part of this.partsOf(file, names)) { fs.rmSync(path.join(this.modelsDir, part), { force: true }); delete files[part]; }
    if (projector && !Object.values(files).some(entry => entry.projector === projector)) {
      fs.rmSync(path.join(this.modelsDir, projector), { force: true });
      delete files[projector];
    }
    this.saveIndex();
    return { removed: true };
  }

  /** A finished download: remember where the model came from and what goes with it. */
  async adopt(job) {
    await this.scan();
    const entry = this.index().files[job.model];
    if (!entry) return;
    entry.source = { repo: job.repo, revision: job.revision };
    // A download started before descriptions were kept carries none: it is read now.
    entry.description = job.description || await this.hub.describe(job.repo, job.revision).catch(() => null);
    if (job.projector) entry.projector = job.projector;
    this.saveIndex();
  }
}

module.exports = { LocalModelManager, ID_PREFIX, PLACEMENTS };
