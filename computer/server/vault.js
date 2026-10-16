'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { dataDirFor } = require('./paths');

const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 32;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MIN_PASSWORD_LEN = 12;

class VaultManager {
  constructor({ root = path.resolve(__dirname, '..'), dbPath = path.join(dataDirFor(root), 'synthorg.sqlite'), sandboxesDir = null } = {}) {
    this.root = root;
    this.dbPath = path.resolve(dbPath);
    this.dir = path.dirname(this.dbPath);
    this.encPath = this.dbPath + '.enc';
    this.metaPath = path.join(this.dir, 'synthorg.vault.json');
    // The working folders of the chats are beside the database, unless the database is in a memory kept elsewhere
    // (memory.js): they are not memory, and stay in the data folder.
    this.sandboxesDir = sandboxesDir ? path.resolve(sandboxesDir) : path.join(this.dir, 'sandboxes');
    // Encrypted, they are memory: beside the database, wherever that is.
    this.sandboxesEncPath = path.join(this.dir, 'sandboxes.enc');
    const before = `${this.sandboxesDir}.enc`;
    if (before !== this.sandboxesEncPath && fs.existsSync(before) && !fs.existsSync(this.sandboxesEncPath)) {
      try { fs.renameSync(before, this.sandboxesEncPath); } catch { fs.copyFileSync(before, this.sandboxesEncPath); fs.rmSync(before, { force: true }); }
    }
    this._isUnlocked = !this.isEncrypted();
    this._sessionKey = null;
  }

  isEncrypted() {
    if (!fs.existsSync(this.metaPath)) return false;
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
      const targets = this._resolveTargets(meta);
      if (targets.sql && fs.existsSync(this.encPath)) return true;
      if (targets.sandboxes && fs.existsSync(this.sandboxesEncPath)) return true;
    } catch {}
    return false;
  }

  isLocked() {
    return this.isEncrypted() && !this._isUnlocked;
  }

  _resolveTargets(meta = {}) {
    if (meta.targets && typeof meta.targets === 'object') {
      return {
        sql: Boolean(meta.targets.sql),
        sandboxes: Boolean(meta.targets.sandboxes)
      };
    }
    // Backward compatibility with version 1
    return {
      sql: true,
      sandboxes: false
    };
  }

  getStatus() {
    const encrypted = this.isEncrypted();
    let encryptedAt = null;
    let targets = { sql: false, sandboxes: false };
    if (fs.existsSync(this.metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
        encryptedAt = meta.encryptedAt || null;
        targets = this._resolveTargets(meta);
      } catch {}
    }

    const isUnlocked = !this.isLocked();

    return {
      isEncrypted: encrypted,
      isUnlocked,
      targets,
      sql: {
        isEncrypted: Boolean(targets.sql),
        isUnlocked: Boolean(targets.sql ? isUnlocked : true)
      },
      sandboxes: {
        isEncrypted: Boolean(targets.sandboxes),
        isUnlocked: Boolean(targets.sandboxes ? isUnlocked : true)
      },
      encryptedAt,
      canLock: encrypted && isUnlocked
    };
  }

  _deriveKey(password, saltBuffer) {
    if (!password || typeof password !== 'string' || password.length < 6) {
      throw Object.assign(new Error('La password deve contenere almeno 6 caratteri.'), { status: 400 });
    }
    return crypto.scryptSync(password, saltBuffer, KEY_LEN, SCRYPT_PARAMS);
  }

  _encryptWithKey(buffer, key) {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      encrypted,
      iv: iv.toString('hex'),
      tag: tag.toString('hex')
    };
  }

  _decryptWithKey(encBuffer, key, ivHex, tagHex) {
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encBuffer), decipher.final()]);
    } catch {
      throw Object.assign(new Error('Password errata o archivio crittografato manomesso.'), { status: 401 });
    }
  }

  _packSandboxes() {
    if (!fs.existsSync(this.sandboxesDir)) return Buffer.alloc(0);
    const files = [];
    function scan(dir, base) {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.join(base, entry.name).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          scan(full, rel);
        } else if (entry.isFile()) {
          const content = fs.readFileSync(full);
          files.push({ path: rel, data: content.toString('base64'), mode: fs.statSync(full).mode });
        }
      }
    }
    scan(this.sandboxesDir, '');
    const jsonStr = JSON.stringify(files);
    return zlib.gzipSync(Buffer.from(jsonStr, 'utf8'));
  }

  _unpackSandboxes(compressedBuffer) {
    if (!compressedBuffer || compressedBuffer.length === 0) return;
    const jsonStr = zlib.gunzipSync(compressedBuffer).toString('utf8');
    const files = JSON.parse(jsonStr);
    fs.mkdirSync(this.sandboxesDir, { recursive: true });
    for (const f of files) {
      const dest = path.join(this.sandboxesDir, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(f.data, 'base64'), { mode: f.mode });
    }
  }

  _wipeSandboxes() {
    if (fs.existsSync(this.sandboxesDir)) {
      try {
        fs.rmSync(this.sandboxesDir, { recursive: true, force: true });
      } catch {}
    }
  }

  _wipePlainSql() {
    const files = [this.dbPath, this.dbPath + '-wal', this.dbPath + '-shm'];
    for (const f of files) {
      if (fs.existsSync(f)) {
        try {
          const len = fs.statSync(f).size;
          if (len > 0 && len < 200 * 1024 * 1024) {
            fs.writeFileSync(f, Buffer.alloc(Math.min(len, 64 * 1024)));
          }
          fs.unlinkSync(f);
        } catch {}
      }
    }
  }

  enable(password, options = {}) {
    if (!password || password.length < MIN_PASSWORD_LEN) {
      throw Object.assign(new Error(`La password deve contenere almeno ${MIN_PASSWORD_LEN} caratteri.`), { status: 400 });
    }
    const opts = (options && typeof options === 'object') ? options : {};
    const rawTargets = opts.targets || (opts.sql !== undefined || opts.sandboxes !== undefined ? opts : { sql: true, sandboxes: true });
    const resolvedTargets = {
      sql: rawTargets.sql !== false,
      sandboxes: rawTargets.sandboxes !== false
    };
    const beforeClose = typeof opts.beforeClose === 'function' ? opts.beforeClose : null;

    if (!resolvedTargets.sql && !resolvedTargets.sandboxes) {
      throw Object.assign(new Error('Selezionare almeno un elemento da crittografare (Database o Sandbox).'), { status: 400 });
    }

    if (typeof beforeClose === 'function') {
      beforeClose();
    }

    const salt = crypto.randomBytes(SALT_LEN);
    const key = this._deriveKey(password, salt);
    fs.mkdirSync(this.dir, { recursive: true });

    const meta = {
      version: 2,
      algorithm: ALGORITHM,
      kdf: 'scrypt',
      salt: salt.toString('hex'),
      targets: resolvedTargets,
      encryptedAt: new Date().toISOString()
    };

    // 1. SQL
    if (resolvedTargets.sql) {
      let plainBuffer;
      if (fs.existsSync(this.dbPath)) {
        plainBuffer = fs.readFileSync(this.dbPath);
      } else {
        plainBuffer = Buffer.alloc(0);
      }
      const encSql = this._encryptWithKey(plainBuffer, key);
      fs.writeFileSync(this.encPath, encSql.encrypted);
      meta.sql = { iv: encSql.iv, tag: encSql.tag };
    }

    // 2. Sandboxes
    if (resolvedTargets.sandboxes) {
      const packedBuffer = this._packSandboxes();
      const encSandboxes = this._encryptWithKey(packedBuffer, key);
      fs.writeFileSync(this.sandboxesEncPath, encSandboxes.encrypted);
      meta.sandboxes = { iv: encSandboxes.iv, tag: encSandboxes.tag };
    }

    fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2), 'utf8');

    this._sessionKey = key;
    this._isUnlocked = true;
    return this.getStatus();
  }

  unlock(password) {
    if (!this.isEncrypted()) {
      this._isUnlocked = true;
      return this.getStatus();
    }
    const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
    const targets = this._resolveTargets(meta);
    const salt = Buffer.from(meta.salt, 'hex');
    const key = this._deriveKey(password, salt);

    // 1. Decrypt SQL if active
    if (targets.sql && fs.existsSync(this.encPath)) {
      const sqlMeta = meta.sql || { iv: meta.iv, tag: meta.tag };
      const encSql = fs.readFileSync(this.encPath);
      const decryptedSql = this._decryptWithKey(encSql, key, sqlMeta.iv, sqlMeta.tag);
      fs.writeFileSync(this.dbPath, decryptedSql);
    }

    // 2. Decrypt Sandboxes if active
    if (targets.sandboxes && fs.existsSync(this.sandboxesEncPath)) {
      const sbMeta = meta.sandboxes;
      const encSb = fs.readFileSync(this.sandboxesEncPath);
      const decryptedSb = this._decryptWithKey(encSb, key, sbMeta.iv, sbMeta.tag);
      this._unpackSandboxes(decryptedSb);
    }

    this._sessionKey = key;
    this._isUnlocked = true;
    return this.getStatus();
  }

  lock({ beforeClose } = {}) {
    if (!this.isEncrypted()) {
      throw Object.assign(new Error('Impossibile bloccare: la crittografia non è configurata.'), { status: 400 });
    }
    if (typeof beforeClose === 'function') {
      beforeClose();
    }

    const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
    const targets = this._resolveTargets(meta);

    if (this._sessionKey) {
      const key = this._sessionKey;

      if (targets.sql && fs.existsSync(this.dbPath)) {
        const plainBuffer = fs.readFileSync(this.dbPath);
        const encSql = this._encryptWithKey(plainBuffer, key);
        fs.writeFileSync(this.encPath, encSql.encrypted);
        meta.sql = { iv: encSql.iv, tag: encSql.tag };
      }

      if (targets.sandboxes && fs.existsSync(this.sandboxesDir)) {
        const packedBuffer = this._packSandboxes();
        const encSb = this._encryptWithKey(packedBuffer, key);
        fs.writeFileSync(this.sandboxesEncPath, encSb.encrypted);
        meta.sandboxes = { iv: encSb.iv, tag: encSb.tag };
      }

      fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2), 'utf8');
    }

    if (targets.sql) {
      this._wipePlainSql();
    }
    if (targets.sandboxes) {
      this._wipeSandboxes();
    }

    this._isUnlocked = false;
    this._sessionKey = null;
    return this.getStatus();
  }

  // === Rust-delegated dump/undump (frontend-orchestrated) ===
  // Each operation splits into a plan step (close the DB, expose the file paths)
  // and a commit step (write meta, wipe plaintext, set state), so the frontend
  // can run the heavy crypto in the native Rust layer in between. The derived
  // session key lives in Rust, so Node holds none of it on this path.

  planDump(mode, { targets, beforeClose } = {}) {
    let resolvedTargets;
    let existingSaltHex = null;
    if (mode === 'lock') {
      if (!this.isEncrypted()) {
        throw Object.assign(new Error('Impossibile bloccare: la crittografia non è configurata.'), { status: 400 });
      }
      const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
      resolvedTargets = this._resolveTargets(meta);
      existingSaltHex = meta.salt || null;
    } else {
      const raw = targets || { sql: true, sandboxes: true };
      resolvedTargets = { sql: raw.sql !== false, sandboxes: raw.sandboxes !== false };
      if (!resolvedTargets.sql && !resolvedTargets.sandboxes) {
        throw Object.assign(new Error('Selezionare almeno un elemento da crittografare (Database o Sandbox).'), { status: 400 });
      }
    }
    if (typeof beforeClose === 'function') beforeClose();
    fs.mkdirSync(this.dir, { recursive: true });
    const dbs = resolvedTargets.sql ? [{ plain_path: this.dbPath, enc_path: this.encPath }] : [];
    return {
      targets: resolvedTargets,
      existingSaltHex,
      dbs,
      sandboxesDir: this.sandboxesDir,
      sandboxesEncPath: this.sandboxesEncPath
    };
  }

  commitDump({ result, targets, stayUnlocked }) {
    const resolvedTargets = { sql: Boolean(targets && targets.sql), sandboxes: Boolean(targets && targets.sandboxes) };
    const meta = {
      version: 2,
      algorithm: ALGORITHM,
      kdf: 'scrypt',
      salt: result.salt_hex,
      targets: resolvedTargets,
      encryptedAt: new Date().toISOString()
    };
    if (resolvedTargets.sql && result.dbs && result.dbs[0]) {
      meta.sql = { iv: result.dbs[0].iv, tag: result.dbs[0].tag };
    }
    if (resolvedTargets.sandboxes && result.sandboxes) {
      meta.sandboxes = { iv: result.sandboxes.iv, tag: result.sandboxes.tag };
    }
    fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2), 'utf8');

    // On lock we destroy the plaintext; on enable we keep it so the app stays live.
    if (!stayUnlocked) {
      if (resolvedTargets.sql) this._wipePlainSql();
      if (resolvedTargets.sandboxes) this._wipeSandboxes();
    }

    this._sessionKey = null; // the key lives in Rust on this path
    this._isUnlocked = Boolean(stayUnlocked);
    return this.getStatus();
  }

  planUndump({ beforeClose } = {}) {
    if (!this.isEncrypted()) {
      this._isUnlocked = true;
      return { alreadyUnlocked: true, status: this.getStatus() };
    }
    const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
    const targets = this._resolveTargets(meta);
    if (typeof beforeClose === 'function') beforeClose();
    const dbs = [];
    if (targets.sql && fs.existsSync(this.encPath)) {
      const sqlMeta = meta.sql || { iv: meta.iv, tag: meta.tag };
      dbs.push({ enc_path: this.encPath, plain_path: this.dbPath, iv: sqlMeta.iv, tag: sqlMeta.tag });
    }
    let sandboxes = null;
    if (targets.sandboxes && fs.existsSync(this.sandboxesEncPath) && meta.sandboxes) {
      sandboxes = { enc_path: this.sandboxesEncPath, dir: this.sandboxesDir, iv: meta.sandboxes.iv, tag: meta.sandboxes.tag };
    }
    return { salt_hex: meta.salt, targets, dbs, sandboxes };
  }

  commitUndump(ok) {
    if (ok) {
      this._isUnlocked = true;
      this._sessionKey = null; // the key lives in Rust on this path
    }
    return this.getStatus();
  }

  disable(password, options = {}) {
    if (!this.isEncrypted()) {
      return this.getStatus();
    }
    const opts = (options && typeof options === 'object') ? options : {};
    const rawTargets = opts.targets || (opts.sql !== undefined || opts.sandboxes !== undefined ? opts : null);
    const beforeClose = typeof opts.beforeClose === 'function' ? opts.beforeClose : null;

    const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
    const currentTargets = this._resolveTargets(meta);
    const salt = Buffer.from(meta.salt, 'hex');
    const key = this._deriveKey(password, salt);

    if (beforeClose) {
      beforeClose();
    }

    // If targets are specified, disable selectively
    const disableSql = rawTargets ? Boolean(rawTargets.sql) : currentTargets.sql;
    const disableSandboxes = rawTargets ? Boolean(rawTargets.sandboxes) : currentTargets.sandboxes;

    // Decrypt SQL if needed
    if (disableSql && currentTargets.sql) {
      if (fs.existsSync(this.encPath)) {
        const sqlMeta = meta.sql || { iv: meta.iv, tag: meta.tag };
        const encSql = fs.readFileSync(this.encPath);
        const decryptedSql = this._decryptWithKey(encSql, key, sqlMeta.iv, sqlMeta.tag);
        fs.writeFileSync(this.dbPath, decryptedSql);
        fs.unlinkSync(this.encPath);
      }
      currentTargets.sql = false;
    }

    // Decrypt Sandboxes if needed
    if (disableSandboxes && currentTargets.sandboxes) {
      if (fs.existsSync(this.sandboxesEncPath)) {
        const sbMeta = meta.sandboxes;
        const encSb = fs.readFileSync(this.sandboxesEncPath);
        const decryptedSb = this._decryptWithKey(encSb, key, sbMeta.iv, sbMeta.tag);
        this._unpackSandboxes(decryptedSb);
        fs.unlinkSync(this.sandboxesEncPath);
      }
      currentTargets.sandboxes = false;
    }

    // If both are now disabled, remove vault completely
    if (!currentTargets.sql && !currentTargets.sandboxes) {
      if (fs.existsSync(this.metaPath)) fs.unlinkSync(this.metaPath);
      this._isUnlocked = true;
      this._sessionKey = null;
    } else {
      meta.targets = currentTargets;
      fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2), 'utf8');
      this._isUnlocked = true;
    }

    return this.getStatus();
  }

  changePassword(oldPassword, newPassword, options = {}) {
    if (!this.isEncrypted()) {
      throw Object.assign(new Error('La crittografia non è attiva.'), { status: 400 });
    }
    if (!newPassword || newPassword.length < MIN_PASSWORD_LEN) {
      throw Object.assign(new Error(`La nuova password deve contenere almeno ${MIN_PASSWORD_LEN} caratteri.`), { status: 400 });
    }

    const opts = (options && typeof options === 'object') ? options : {};
    const rawTargets = opts.targets || (opts.sql !== undefined || opts.sandboxes !== undefined ? opts : null);
    const beforeClose = typeof opts.beforeClose === 'function' ? opts.beforeClose : null;

    const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
    const targets = this._resolveTargets(meta);
    const oldSalt = Buffer.from(meta.salt, 'hex');
    const oldKey = this._deriveKey(oldPassword, oldSalt);

    let sqlPlain = null;
    if (targets.sql) {
      if (fs.existsSync(this.dbPath)) {
        sqlPlain = fs.readFileSync(this.dbPath);
      } else if (fs.existsSync(this.encPath)) {
        const sqlMeta = meta.sql || { iv: meta.iv, tag: meta.tag };
        sqlPlain = this._decryptWithKey(fs.readFileSync(this.encPath), oldKey, sqlMeta.iv, sqlMeta.tag);
      }
    }

    let sbPacked = null;
    if (targets.sandboxes) {
      if (fs.existsSync(this.sandboxesDir)) {
        sbPacked = this._packSandboxes();
      } else if (fs.existsSync(this.sandboxesEncPath)) {
        const sbMeta = meta.sandboxes;
        sbPacked = this._decryptWithKey(fs.readFileSync(this.sandboxesEncPath), oldKey, sbMeta.iv, sbMeta.tag);
      }
    }

    if (typeof beforeClose === 'function') {
      beforeClose();
    }

    const newSalt = crypto.randomBytes(SALT_LEN);
    const newKey = this._deriveKey(newPassword, newSalt);

    meta.salt = newSalt.toString('hex');
    meta.encryptedAt = new Date().toISOString();

    if (targets.sql && sqlPlain) {
      const encSql = this._encryptWithKey(sqlPlain, newKey);
      fs.writeFileSync(this.encPath, encSql.encrypted);
      meta.sql = { iv: encSql.iv, tag: encSql.tag };
    }

    if (targets.sandboxes && sbPacked) {
      const encSb = this._encryptWithKey(sbPacked, newKey);
      fs.writeFileSync(this.sandboxesEncPath, encSb.encrypted);
      meta.sandboxes = { iv: encSb.iv, tag: encSb.tag };
    }

    fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2), 'utf8');

    this._sessionKey = newKey;
    this._isUnlocked = true;
    return this.getStatus();
  }
}

module.exports = { VaultManager, ALGORITHM };
