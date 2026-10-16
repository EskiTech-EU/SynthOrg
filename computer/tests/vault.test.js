'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { VaultManager } = require('../server/vault');
const { Store } = require('../server/database');

test('VaultManager: enables encryption, rejects bad password, unlocks and roundtrips SQLite database', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-vault-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');

  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // 1. Create a store and insert some data
  let store = new Store(dbPath);
  const conv = store.createConversation('Segreto');
  store.saveMessage(conv.id, { role: 'user', content: 'Messaggio super segreto' });
  store.setSetting('test_key', 'test_value');
  assert.equal(store.getSetting('test_key'), 'test_value');
  store.close();

  const vault = new VaultManager({ dbPath });
  assert.equal(vault.isEncrypted(), false);
  assert.equal(vault.isLocked(), false);

  // 2. Enable encryption
  const status = vault.enable('masterPassword123');
  assert.equal(status.isEncrypted, true);
  assert.equal(status.isUnlocked, true);
  assert.equal(fs.existsSync(dbPath + '.enc'), true);
  assert.equal(fs.existsSync(path.join(tmpDir, 'synthorg.vault.json')), true);

  // 3. Lock database
  vault.lock();
  assert.equal(vault.isLocked(), true);
  assert.equal(fs.existsSync(dbPath), false, 'Plaintext db must be wiped on lock');

  // 4. Attempt unlock with WRONG password
  assert.throws(() => vault.unlock('wrongPass'), (err) => {
    return err.status === 401;
  });
  assert.equal(vault.isLocked(), true);
  assert.equal(fs.existsSync(dbPath), false);

  // 5. Unlock with CORRECT password
  const unlockedStatus = vault.unlock('masterPassword123');
  assert.equal(unlockedStatus.isUnlocked, true);
  assert.equal(fs.existsSync(dbPath), true);

  // Verify SQLite database still readable and data intact
  store = new Store(dbPath);
  const restoredConv = store.conversation(conv.id);
  assert.equal(restoredConv.title, 'Segreto');
  assert.equal(store.getSetting('test_key'), 'test_value');
  store.close();

  // 6. Change password
  vault.changePassword('masterPassword123', 'newSecretPassword456');
  vault.lock();
  assert.throws(() => vault.unlock('masterPassword123'), /Password errata/);
  vault.unlock('newSecretPassword456');
  assert.equal(vault.isLocked(), false);

  // 7. Disable encryption
  vault.disable('newSecretPassword456');
  assert.equal(vault.isEncrypted(), false);
  assert.equal(vault.isLocked(), false);
  assert.equal(fs.existsSync(dbPath), true);
  assert.equal(fs.existsSync(dbPath + '.enc'), false);

  store = new Store(dbPath);
  assert.equal(store.getSetting('test_key'), 'test_value');
  store.close();
});

test('VaultManager: dual encryption of SQL and Podman sandbox workspaces', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-dual-vault-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const sandboxesDir = path.join(tmpDir, 'sandboxes');

  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // Create test SQLite database
  const store = new Store(dbPath);
  store.setSetting('app_theme', 'dark');
  store.close();

  // Create test sandboxes workspace structure
  const chatWsDir = path.join(sandboxesDir, 'chat_xyz', 'workspace');
  fs.mkdirSync(chatWsDir, { recursive: true });
  fs.writeFileSync(path.join(chatWsDir, 'script.py'), 'print("hello podman")', 'utf8');
  fs.writeFileSync(path.join(chatWsDir, 'output.log'), 'Execution finished 200', 'utf8');

  const vault = new VaultManager({ dbPath, sandboxesDir });

  // 1. Enable dual encryption
  const status = vault.enable('p@ssw0rdDual', null, { sql: true, sandboxes: true });
  assert.equal(status.isEncrypted, true);
  assert.equal(status.targets.sql, true);
  assert.equal(status.targets.sandboxes, true);
  assert.equal(fs.existsSync(dbPath + '.enc'), true);
  assert.equal(fs.existsSync(path.join(tmpDir, 'sandboxes.enc')), true);

  // 2. Lock
  vault.lock();
  assert.equal(vault.isLocked(), true);
  assert.equal(fs.existsSync(dbPath), false, 'Plaintext db wiped on lock');
  assert.equal(fs.existsSync(sandboxesDir), false, 'Plaintext sandboxes wiped on lock');

  // 3. Unlock with correct password
  vault.unlock('p@ssw0rdDual');
  assert.equal(vault.isLocked(), false);
  assert.equal(fs.existsSync(dbPath), true);
  assert.equal(fs.existsSync(sandboxesDir), true);
  assert.equal(
    fs.readFileSync(path.join(chatWsDir, 'script.py'), 'utf8'),
    'print("hello podman")'
  );
  assert.equal(
    fs.readFileSync(path.join(chatWsDir, 'output.log'), 'utf8'),
    'Execution finished 200'
  );

  // 4. Disable only sandboxes
  vault.disable('p@ssw0rdDual', { sql: false, sandboxes: true });
  const midStatus = vault.getStatus();
  assert.equal(midStatus.isEncrypted, true);
  assert.equal(midStatus.targets.sql, true);
  assert.equal(midStatus.targets.sandboxes, false);
  assert.equal(fs.existsSync(path.join(tmpDir, 'sandboxes.enc')), false);
  assert.equal(fs.existsSync(chatWsDir), true);

  // 5. Disable sql completely
  vault.disable('p@ssw0rdDual', { sql: true, sandboxes: false });
  const finalStatus = vault.getStatus();
  assert.equal(finalStatus.isEncrypted, false);
  assert.equal(fs.existsSync(dbPath), true);
  assert.equal(fs.existsSync(dbPath + '.enc'), false);
});

test('VaultManager: Rust-orchestrated plan/commit path is interoperable with the sync unlock', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-vault-plan-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  t.after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  // Seed some data.
  let store = new Store(dbPath);
  const conv = store.createConversation('Piano');
  store.setSetting('secret', 'ok-42');
  store.close();

  const vault = new VaultManager({ dbPath });
  const PW = 'planCommitPassword123';

  // Stand in for the native Rust vault_dump/vault_undump using Node crypto in
  // the exact same wire format (scrypt + AES-256-GCM, tag stored separately).
  const rustDump = (plan, saltHex) => {
    const salt = saltHex ? Buffer.from(saltHex, 'hex') : require('node:crypto').randomBytes(32);
    const key = vault._deriveKey(PW, salt);
    const dbs = plan.dbs.map(d => {
      const plain = fs.existsSync(d.plain_path) ? fs.readFileSync(d.plain_path) : Buffer.alloc(0);
      const enc = vault._encryptWithKey(plain, key);
      fs.writeFileSync(d.enc_path, enc.encrypted);
      return { enc_path: d.enc_path, iv: enc.iv, tag: enc.tag };
    });
    return { salt_hex: salt.toString('hex'), dbs, sandboxes: null };
  };
  const rustUndump = (plan) => {
    const key = vault._deriveKey(PW, Buffer.from(plan.salt_hex, 'hex'));
    for (const d of plan.dbs) {
      const enc = fs.readFileSync(d.enc_path);
      fs.writeFileSync(d.plain_path, vault._decryptWithKey(enc, key, d.iv, d.tag));
    }
  };

  // 1. Enable through plan/commit.
  const planE = vault.planDump('enable', { targets: { sql: true, sandboxes: false }, beforeClose: () => {} });
  const enableStatus = vault.commitDump({ result: rustDump(planE, null), targets: planE.targets, stayUnlocked: true });
  assert.equal(enableStatus.isEncrypted, true);
  assert.equal(enableStatus.isUnlocked, true);
  assert.equal(fs.existsSync(dbPath + '.enc'), true);
  assert.equal(fs.existsSync(dbPath), true, 'enable keeps the plaintext so the app stays live');

  // 2. Lock through plan/commit (uses the existing salt; wipes plaintext).
  const planL = vault.planDump('lock', { beforeClose: () => {} });
  vault.commitDump({ result: rustDump(planL, planL.existingSaltHex), targets: planL.targets, stayUnlocked: false });
  assert.equal(vault.isLocked(), true);
  assert.equal(fs.existsSync(dbPath), false, 'lock wipes the plaintext');

  // 3. Interop: a .enc produced through the Rust path must open with sync unlock().
  const vault2 = new VaultManager({ dbPath });
  vault2.unlock(PW);
  assert.equal(vault2.isLocked(), false);
  store = new Store(dbPath);
  assert.equal(store.conversation(conv.id).title, 'Piano');
  assert.equal(store.getSetting('secret'), 'ok-42');
  store.close();

  // 4. Lock again with the sync path, then unlock through plan/commit undump.
  vault2.lock();
  assert.equal(fs.existsSync(dbPath), false);
  const planU = vault2.planUndump({ beforeClose: () => {} });
  rustUndump(planU);
  const undumpStatus = vault2.commitUndump(true);
  assert.equal(undumpStatus.isUnlocked, true);
  store = new Store(dbPath);
  assert.equal(store.getSetting('secret'), 'ok-42', 'data intact after plan/commit undump');
  store.close();
});
