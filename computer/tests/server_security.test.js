'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createApp } = require('../server');
const TEST_TOKEN = 'synthorg-test-token';

async function setup(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-server-sec-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const { server } = createApp({ token: TEST_TOKEN, dbPath, allowedOrigins: ['http://localhost:54321'] });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      resolve();
    });
    server.closeAllConnections();
  }));

  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    request: (route, method = 'GET', data) => fetch(base + '/api' + route, {
      method,
      headers: { Authorization: 'Bearer synthorg-test-token', 'Content-Type': 'application/json', Origin: 'http://localhost:54321' },
      body: data === undefined ? undefined : JSON.stringify(data)
    })
  };
}

test('HTTP Security API: status, enable, lock, 423 guard, unlock with password and disable', async t => {
  const { request } = await setup(t);

  // 1. Initial status: unencrypted
  const initStatus = await (await request('/security')).json();
  assert.equal(initStatus.isEncrypted, false);
  assert.equal(initStatus.isUnlocked, true);

  // Create a conversation
  const createdChat = await (await request('/conversations', 'POST', { title: 'Dati Riservati' })).json();
  assert(createdChat.id);

  // 2. Enable encryption
  const enableRes = await request('/security/enable', 'POST', { password: 'passWordSegreta123' });
  assert.equal(enableRes.status, 200);
  const enabledStatus = await enableRes.json();
  assert.equal(enabledStatus.isEncrypted, true);
  assert.equal(enabledStatus.isUnlocked, true);

  // 3. Lock database
  const lockRes = await request('/security/lock', 'POST', {});
  assert.equal(lockRes.status, 200);
  const lockedStatus = await lockRes.json();
  assert.equal(lockedStatus.isUnlocked, false);

  // 4. Data access while locked MUST return HTTP 423 Locked
  const convReq = await request('/conversations');
  assert.equal(convReq.status, 423);
  const convErr = await convReq.json();
  assert(convErr.error.includes('crittografato') || convErr.error.includes('password'));

  // 5. Unlock with wrong password must fail with 401
  const badUnlock = await request('/security/unlock', 'POST', { password: 'wrongPassword' });
  assert.equal(badUnlock.status, 401);

  // 6. Unlock with correct password
  const goodUnlock = await request('/security/unlock', 'POST', { password: 'passWordSegreta123' });
  assert.equal(goodUnlock.status, 200);
  const goodStatus = await goodUnlock.json();
  assert.equal(goodStatus.isUnlocked, true);

  // 7. Verify conversation accessible again
  const convs = await (await request('/conversations')).json();
  assert.equal(convs.length, 1);
  assert.equal(convs[0].title, 'Dati Riservati');

  // 8. Disable encryption
  const disableRes = await request('/security/disable', 'POST', { password: 'passWordSegreta123' });
  assert.equal(disableRes.status, 200);
  const disabledStatus = await disableRes.json();
  assert.equal(disabledStatus.isEncrypted, false);
});

test('session token gates the API: no token, wrong token and health probe', async t => {
  const { base } = await setup(t);
  const origin = { Origin: 'http://localhost:54321' };

  // Health stays open: it is the liveness probe the shell uses before the
  // token handshake can happen.
  assert.equal((await fetch(base + '/api/health', { headers: origin })).status, 200);

  assert.equal((await fetch(base + '/api/conversations', { headers: origin })).status, 401);
  assert.equal((await fetch(base + '/api/conversations', {
    headers: { ...origin, Authorization: 'Bearer ' + 'x'.repeat(TEST_TOKEN.length) }
  })).status, 401);
  assert.equal((await fetch(base + '/api/shutdown', { method: 'POST', headers: origin })).status, 401);
  assert.equal((await fetch(base + '/api/conversations', {
    headers: { ...origin, Authorization: `Bearer ${TEST_TOKEN}` }
  })).status, 200);
});

test('master password: minimum length enforced and unlock attempts are throttled', async t => {
  const { request } = await setup(t);

  assert.equal((await request('/security/enable', 'POST', { password: 'corta123' })).status, 400);

  const password = 'passWordSegreta123';
  assert.equal((await request('/security/enable', 'POST', { password })).status, 200);
  assert.equal((await request('/security/lock', 'POST', {})).status, 200);

  // Five wrong guesses are answered normally, then the guard trips: the vault
  // files are on disk, so an unthrottled endpoint is a guessing oracle.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await request('/security/unlock', 'POST', { password: 'wrongPassword' })).status, 401);
  }
  const blocked = await request('/security/unlock', 'POST', { password: 'wrongPassword' });
  assert.equal(blocked.status, 429);

  // The correct password is refused too while the lockout window is open.
  assert.equal((await request('/security/unlock', 'POST', { password })).status, 429);
});

test('the development frontend origin is accepted while remote origins are not', async t => {
  const { base } = await setup(t);

  // `tauri dev` serves the frontend from its own loopback server, so in
  // development the webview presents http://127.0.0.1:<dev port>. Rejecting it
  // left the application unable to reach its own storage when started with
  // `npm start`, while working from the packaged build.
  // The packaged origin (tauri://localhost) comes from the default allowlist,
  // which this fixture replaces; what matters here is the loopback dev origin.
  for (const origin of ['http://127.0.0.1:1430', 'http://localhost:1430', 'http://127.0.0.1']) {
    const res = await fetch(base + '/api/health', { headers: { Origin: origin } });
    assert.equal(res.status, 200, `origine ${origin} deve essere accettata`);
    assert.equal(res.headers.get('access-control-allow-origin'), origin, `serve l'header CORS per ${origin}`);
  }

  for (const origin of ['https://evil.example', 'http://127.0.0.1.evil.com', 'http://localhost.evil.com']) {
    const res = await fetch(base + '/api/health', { headers: { Origin: origin } });
    assert.equal(res.status, 403, `origine ${origin} deve restare bloccata`);
  }
});
