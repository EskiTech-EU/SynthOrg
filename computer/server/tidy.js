'use strict';
// What is on disk is what the database knows, and nothing else.
//
// Every folder the app keeps for a chat or a project carries that chat's or project's id as its name. When the app
// starts, and when the archive is unlocked, each of them is checked against the rows: a folder whose chat or
// project is no longer there is removed, with the settings kept under its name. Deleting on screen removes these
// things at once (index.js, projects.js); this is what makes it true also after a crash, a restored archive, a
// chat deleted from a phone while the computer was off.
//
// The files of the chats live in their volumes, on the disk of the pods; the data folder holds a copy of each, which
// follows the volume after every command (sandbox.js, pullWorkspace) and seeds it again when the volume is gone. When
// the memory of the app is kept elsewhere (memory.js) that copy is copied there, chat by chat, as it changes, and a
// chat whose folder is gone is given its files back from the memory's copy. With the memory beside the app there is
// one folder and no copy. When the vault keeps the chats' files encrypted, the encrypted file is the copy.
const fs = require('node:fs');
const path = require('node:path');

const safeId = id => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36);
const COPY = 'chat-files';

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Every file under a folder: its place in it → size and time of change. */
function filesOf(dir) {
  const out = new Map();
  const walk = (full, relative) => {
    for (const entry of entries(full)) {
      const next = path.join(full, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next, name);
      else if (entry.isFile()) { try { const stat = fs.statSync(next); out.set(name, { size: stat.size, at: stat.mtimeMs / 1000 }); } catch {} }
    }
  };
  walk(dir, '');
  return out;
}

function emptyDirs(dir) {
  for (const entry of entries(dir)) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    emptyDirs(full);
    try { if (!fs.readdirSync(full).length) fs.rmdirSync(full); } catch {}
  }
}

/** Makes `to` hold what `from` holds: what changed is copied, what is no longer there is removed. */
function mirror(from, to) {
  const source = filesOf(from);
  const kept = filesOf(to);
  let copied = 0;
  for (const [name, stat] of source) {
    const have = kept.get(name);
    // Same size, changed at the same time — as near as the coarsest disk a memory may be on can tell (two seconds).
    if (have && have.size === stat.size && Math.abs(have.at - stat.at) < 2.5) continue;
    const target = path.join(to, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(from, name), target);
    try { fs.utimesSync(target, stat.at, stat.at); } catch {}
    copied += 1;
  }
  for (const name of kept.keys()) if (!source.has(name)) fs.rmSync(path.join(to, name), { force: true });
  emptyDirs(to);
  return copied;
}

class Tidy {
  /**
   * `dataDir`: where the chats' working folders are. `memoryDir()`: where the memory is now. `store()`: the
   * database, null while the archive is locked. `plainCopy()`: false when the vault keeps the chats' files encrypted.
   */
  constructor({ dataDir, memoryDir, store, plainCopy = () => true, log = () => {} }) {
    this.dataDir = path.resolve(dataDir);
    this.memoryDir = () => path.resolve(memoryDir());
    this.store = store;
    this.plainCopy = plainCopy;
    this.log = log;
    this.timers = new Map();
    this.watcher = null;
    this.delayMs = 1500;
  }

  get sandboxes() { return path.join(this.dataDir, 'sandboxes'); }
  workspace(id) { return path.join(this.sandboxes, safeId(id), 'workspace'); }
  copyOf(id) { return path.join(this.memoryDir(), COPY, safeId(id)); }
  /** Whether the chats' files are copied: the memory is elsewhere, and the vault does not keep them encrypted. */
  copies() { return this.memoryDir().toLowerCase() !== this.dataDir.toLowerCase() && this.plainCopy(); }

  /** One chat's files, brought to the memory. */
  sync(id) {
    if (!safeId(id) || !this.copies()) return 0;
    const from = this.workspace(id);
    if (!fs.existsSync(from)) return 0;
    try { return mirror(from, this.copyOf(id)); } catch (error) { this.log(`file della chat ${safeId(id)} non copiati nella memoria: ${error.message}`); return 0; }
  }

  /** A chat deleted: its copy in the memory goes with it (its working folder is the sandbox's to remove). */
  forgetChat(id) {
    clearTimeout(this.timers.get(safeId(id)));
    this.timers.delete(safeId(id));
    if (safeId(id)) fs.rmSync(path.join(this.memoryDir(), COPY, safeId(id)), { recursive: true, force: true, maxRetries: 3 });
  }

  /** The whole check. Returns what was removed and copied, by kind. */
  run() {
    const store = this.store();
    const done = { chatFolders: 0, chatCopies: 0, projectFolders: 0, settings: 0, restored: 0, copied: 0 };
    if (!store) return done;
    const chats = new Set(store.db.prepare('SELECT id FROM conversations').all().map(row => safeId(row.id)));
    const projects = new Set(store.db.prepare('SELECT id FROM projects').all().map(row => String(row.id).replace(/[^a-zA-Z0-9_-]/g, '')));
    const memory = this.memoryDir();
    const drop = (full, kind) => { try { fs.rmSync(full, { recursive: true, force: true, maxRetries: 3 }); done[kind] += 1; } catch (error) { this.log(`non rimosso ${full}: ${error.message}`); } };

    // The chats' working folders and their copies in the memory.
    for (const entry of entries(this.sandboxes)) if (entry.isDirectory() && !chats.has(entry.name)) drop(path.join(this.sandboxes, entry.name), 'chatFolders');
    const copyRoot = path.join(memory, COPY);
    for (const entry of entries(copyRoot)) if (!chats.has(entry.name)) drop(path.join(copyRoot, entry.name), 'chatCopies');
    // A chat whose working folder is not there (the data folder was lost, another computer): its files come back.
    for (const entry of entries(copyRoot)) {
      const work = this.workspace(entry.name);
      // Only a folder that is not there: one that is there and empty is a chat whose files were removed.
      if (fs.existsSync(work)) continue;
      try { done.restored += mirror(path.join(copyRoot, entry.name), work) ? 1 : 0; } catch (error) { this.log(`file della chat ${entry.name} non ripresi dalla memoria: ${error.message}`); }
    }
    if (this.copies()) for (const id of chats) done.copied += this.sync(id);
    // No copy is kept: beside the app there is one folder, and under the vault the encrypted file.
    else if (fs.existsSync(copyRoot)) fs.rmSync(copyRoot, { recursive: true, force: true, maxRetries: 3 });

    // What the memory holds of the projects.
    for (const [dir, nameOf] of [['artifacts', name => name], ['studio', name => name], ['pod-projects', name => name.replace(/\.git$/, '')]]) {
      for (const entry of entries(path.join(memory, dir))) {
        const id = nameOf(entry.name);
        if (!projects.has(id) && ![...projects].some(known => known.slice(0, 36) === id)) drop(path.join(memory, dir, entry.name), 'projectFolders');
      }
    }
    // The settings kept under the name of a chat or of a project.
    for (const { key } of store.db.prepare("SELECT key FROM settings WHERE key LIKE 'plan\\_%' ESCAPE '\\'").all()) {
      const owner = /^plan_(mode|tries)_(.+)$/.exec(key);
      const known = owner ? projects.has(owner[2].replace(/[^a-zA-Z0-9_-]/g, '')) : chats.has(safeId(key.slice(5)));
      if (!known) { store.db.prepare('DELETE FROM settings WHERE key=?').run(key); done.settings += 1; }
    }
    done.settings += store.pruneUiState(key => key.startsWith('synthorg_plan_on_') && !chats.has(safeId(key.slice('synthorg_plan_on_'.length))));
    const total = done.chatFolders + done.chatCopies + done.projectFolders + done.settings;
    if (total || done.restored) this.log(`ordine: ${done.chatFolders} cartelle di chat, ${done.chatCopies} copie, ${done.projectFolders} cartelle di progetti e ${done.settings} impostazioni senza più il loro proprietario rimosse; ${done.restored} chat riprese dalla memoria.`);
    return done;
  }

  /** Follows the chats' working folders: a file written there, by anyone, is in the memory a moment later. */
  watch() {
    if (this.watcher || !this.copies()) return;
    fs.mkdirSync(this.sandboxes, { recursive: true });
    try {
      this.watcher = fs.watch(this.sandboxes, { recursive: true }, (event, name) => {
        const id = safeId(String(name || '').split(/[\\/]/)[0]);
        if (!id) return;
        clearTimeout(this.timers.get(id));
        const timer = setTimeout(() => { this.timers.delete(id); this.sync(id); }, this.delayMs);
        timer.unref?.();
        this.timers.set(id, timer);
      });
      this.watcher.on('error', () => this.unwatch());
      this.watcher.unref?.();
    } catch (error) { this.log(`cartelle delle chat non seguite: ${error.message}`); }
  }

  unwatch() {
    try { this.watcher?.close(); } catch {}
    this.watcher = null;
  }

  /** At closing: what was waiting to be copied is copied now. */
  flush() {
    for (const [id, timer] of this.timers) { clearTimeout(timer); this.sync(id); }
    this.timers.clear();
    this.unwatch();
  }
}

module.exports = { Tidy, mirror, filesOf, COPY };
