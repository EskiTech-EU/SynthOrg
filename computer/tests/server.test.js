'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server');
const TEST_TOKEN = 'synthorg-test-token';

async function setup(t) {
  const { server } = createApp({ token: TEST_TOKEN, dbPath: ':memory:', allowedOrigins: ['http://localhost:54321'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, request: (route, method = 'GET', data) => fetch(base + '/api' + route, {
    method, headers: { Authorization: 'Bearer synthorg-test-token', 'Content-Type': 'application/json', Origin: 'http://localhost:54321' },
    body: data === undefined ? undefined : JSON.stringify(data)
  }) };
}
test('HTTP conversation and memory workflow', async t => {
  const { request } = await setup(t);
  const chat = await (await request('/conversations', 'POST', {})).json();
  assert(chat.id);
  // A new chat starts without turn memory; this workflow is about it.
  assert.equal(chat.memory_enabled, 0);
  assert.equal((await request(`/conversations/${chat.id}`, 'PATCH', { memoryEnabled: true })).status, 200);
  assert.equal((await request(`/conversations/${chat.id}/messages`, 'POST', { role: 'user', content: 'Ciao' })).status, 200);
  const memory = await (await request('/memories', 'POST', { content: 'Usa italiano', scope: 'global', pinned: true })).json();
  const localMemory = await (await request('/memories', 'POST', { content: 'Nota locale', scope: 'conversation', conversationId: chat.id })).json();
  const globalOnly = await (await request(`/memories?conversationId=${chat.id}&scope=global`)).json();
  const convOnly = await (await request(`/memories?conversationId=${chat.id}&scope=conversation`)).json();
  assert.equal(globalOnly.length, 1);
  assert.equal(globalOnly[0].id, memory.id);
  assert.equal(convOnly.length, 1);
  assert.equal(convOnly[0].id, localMemory.id);
  const context = await (await request(`/conversations/${chat.id}/context`, 'POST', { query: 'Ciao' })).json();
  assert.equal(context.messages.length, 1); assert.equal(context.memories[0].id, memory.id);
  assert.equal((await request('/memories/' + memory.id, 'DELETE')).status, 200);
  assert.equal((await request('/memories/' + localMemory.id, 'DELETE')).status, 200);
  assert.equal((await request('/conversations/' + chat.id, 'DELETE')).status, 200);
  assert.equal((await request('/conversations/' + chat.id)).status, 404);
});
test('local API rejects external origins, hostile Host and a missing session token', async t => {
  const { base } = await setup(t);
  assert.equal((await fetch(base + '/api/conversations', { headers: { Origin: 'https://evil.example', Authorization: 'Bearer synthorg-test-token' } })).status, 403);
  assert.equal((await fetch(base + '/api/conversations')).status, 401);
  assert.equal((await fetch(base + '/api/conversations', { headers: { Authorization: 'Bearer wrong-token' } })).status, 401);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(base + '/api/health', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  const preflight = await fetch(base + '/api/conversations', { method: 'OPTIONS', headers: { Origin: 'http://localhost:54321' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:54321');
});
test('invalid payloads are rejected and static server cannot expose local data', async t => {
  const { request, base } = await setup(t);
  assert.equal((await request('/conversations', 'POST', { title: '' })).status, 400);
  assert.equal((await request('/memories', 'POST', { content: 'x', scope: 'conversation' })).status, 400);
  assert.equal((await fetch(base + '/api/conversations', { method: 'POST', headers: { Authorization: 'Bearer synthorg-test-token', 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(base + '/%2e%2e%5cdata%5csynthorg.sqlite')).status, 403);
  assert.equal((await fetch(base + '/server/database.js')).status, 404);
  const index = await fetch(base + '/'); assert.equal(index.status, 200);
  assert((await index.text()).includes('conversation-list'));
  assert.equal((await fetch(base + '/js/storage.js')).status, 200);
});

test('conversation sandbox status and configuration API', async t => {
  const { request } = await setup(t);
  const chat = await (await request('/conversations', 'POST', { title: 'Chat con Sandbox' })).json();
  assert(chat.id);
  
  // Initial sandbox status (offline/isolated by default)
  const statusRes = await request(`/conversations/${chat.id}/sandbox`);
  assert.equal(statusRes.status, 200);
  const status = await statusRes.json();
  assert.equal(status.chatId, chat.id);
  assert.equal(status.networkEnabled, false);
  assert.equal(typeof status.engine.available, 'boolean');
  assert(status.workspacePath.includes(chat.id));

  // Toggle network permission
  const patchRes = await request(`/conversations/${chat.id}/sandbox`, 'PATCH', { networkEnabled: true, image: 'python:3.11-slim' });
  assert.equal(patchRes.status, 200);
  const updatedStatus = await patchRes.json();
  assert.equal(updatedStatus.networkEnabled, true);
  assert.equal(updatedStatus.image, 'python:3.11-slim');

  // Reset container endpoint
  const resetRes = await request(`/conversations/${chat.id}/sandbox/reset`, 'POST', {});
  assert.equal(resetRes.status, 200);
});

test('tools web-search API respects conversation sandbox network permission', async t => {
  const { request } = await setup(t);
  const chat = await (await request('/conversations', 'POST', { title: 'Test Web Search' })).json();
  assert(chat.id);

  // 1. When chat sandbox network is offline (default 0), web-search must be rejected with 403
  const blockedRes = await request(`/conversations/${chat.id}/tools/web-search`, 'POST', { query: 'test query' });
  assert.equal(blockedRes.status, 403);
  const blockedJson = await blockedRes.json();
  assert(blockedJson.error.includes('Isolato') || blockedJson.error.includes('Offline'));

  // 2. When chat sandbox network is enabled (1), web-search proceeds
  await request(`/conversations/${chat.id}/sandbox`, 'PATCH', { networkEnabled: true });
  const onlineCheck = await (await request(`/conversations/${chat.id}/tools/check-network`)).json();
  assert.equal(onlineCheck.networkEnabled, true);

  const searchRes = await request(`/conversations/${chat.id}/tools/web-search`, 'POST', { query: 'GitHub' });
  assert.equal(searchRes.status, 200);
  const searchJson = await searchRes.json();
  assert.equal(searchJson.query, 'GitHub');
  assert(Array.isArray(searchJson.results));
});


