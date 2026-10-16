'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { allowed, tellPhones } = require('../server/bridge-api');
const zlib = require('node:zlib');
const { Store } = require('../server/database');

const TOKEN = 'synthorg-sync-token';

async function setup(t) {
  const app = createApp({ token: TOKEN, dbPath: ':memory:' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = (route, method = 'GET', data, headers = {}) => fetch(base + route, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  return { ...app, request, api: app.bridge.local.api };
}

/** A phone's own archive, and its exchange with the computer's service as it goes through the bridge. */
function phoneOf(t, app, device = 'dev-1') {
  const phone = new Store(':memory:', { wins: false });
  t.after(() => phone.close());
  const take = (answer) => phone.replica().answered('computer', { ...answer.result, rows: JSON.parse(zlib.gunzipSync(answer.body).toString('utf8')).rows });
  const exchange = async () => {
    const written = [];
    for (let turn = 0; turn < 50; turn += 1) {
      const { rows, ...head } = phone.replica().offer('computer');
      const answer = await app.bridge.local.sync(device, head, zlib.gzipSync(JSON.stringify({ rows })));
      const took = take(answer);
      written.push(...took.applied);
      if (took.reset) continue;
      if (!head.more && !answer.result.more && !phone.replica().pending('computer')) return written;
    }
    throw new Error('the exchange never ended');
  };
  /** An event `sync` sent by the service, as the phone takes it. */
  const hear = (message) => phone.replica().answered('computer', { ...message.header.data, rows: JSON.parse(zlib.gunzipSync(Buffer.from(message.body, 'base64')).toString('utf8')).rows });
  return { phone, exchange, hear };
}

test('every write is recorded with who made it, reads are not', async t => {
  const { request, sync } = await setup(t);
  const first = await (await request('/changes')).json();
  assert.equal(first.reset, true);
  await request('/settings/app_locale', 'PUT', { value: 'it' });
  await request('/settings');
  const chat = await (await request('/conversations', 'POST', {})).json();
  await request(`/conversations/${chat.id}/context`, 'POST', { query: 'ciao' });
  const after = await (await request(`/changes?epoch=${first.epoch}&after=${first.rev}`)).json();
  assert.equal(after.reset, false);
  assert.deepEqual(after.changes.map(change => [change.method, change.path, change.origin]), [
    ['PUT', '/api/settings/app_locale', 'desktop'],
    ['POST', '/api/conversations', 'desktop']
  ]);
  assert.deepEqual(after.changes[0].data, { key: 'app_locale', value: 'it' });
  assert.equal(after.changes[1].data.id, chat.id);
  assert.equal(sync.rev, after.rev);
});

test('the page waiting for changes is woken by a write of the phone', async t => {
  const { request, api, sync } = await setup(t);
  const waiting = request(`/changes?epoch=${sync.epoch}&after=${sync.rev}&wait=5000`).then(response => response.json());
  await new Promise(resolve => setTimeout(resolve, 50));
  const { result } = await api('dev-1', { method: 'PUT', path: '/api/settings/theme_preferences', body: { value: '{"mode":"dark"}' } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { key: 'theme_preferences', value: '{"mode":"dark"}' });
  const woken = await waiting;
  assert.equal(woken.changes.length, 1);
  assert.equal(woken.changes[0].origin, 'phone:dev-1');
});

test('what the phone wrote in its archive arrives as rows, and the page is told as if it had been done here', async t => {
  const app = await setup(t);
  const { request, sync } = app;
  await request('/settings/realtime_name', 'PUT', { value: 'Desk' });
  const { phone, exchange } = phoneOf(t, app);
  await exchange();
  assert.equal(phone.getSetting('realtime_name'), 'Desk');

  const from = sync.rev;
  phone.setSetting('realtime_name', 'Phone');
  const item = phone.personal().saveAgendaItem({ kind: 'reminder', title: 'Dal telefono', startAt: '2026-10-02T09:00' });
  // Opened by the phone in the computer's world: the computer's, so it arrives.
  const chat = phone.createConversation('Nuova chat', null, 'peer');
  phone.saveMessage(chat.id, { id: 'm-phone', role: 'user', content: 'da là' });
  await exchange();
  assert.equal((await (await request('/settings/realtime_name')).json()).value, 'Phone');
  assert.deepEqual((await (await request('/agenda')).json()).map(row => row.id), [item.id]);
  assert.deepEqual((await (await request(`/conversations/${chat.id}`)).json()).messages.map(m => [m.id, m.content]), [['m-phone', 'da là']]);
  const told = (await (await request(`/changes?epoch=${sync.epoch}&after=${from}`)).json()).changes;
  assert.ok(told.every(change => change.origin === 'phone:dev-1'));
  assert.deepEqual(told.find(change => change.path === '/api/settings/realtime_name').data, { key: 'realtime_name', value: 'Phone' });
  assert.equal(told.find(change => change.path === `/api/conversations/${chat.id}/messages`).data.content, 'da là');
  assert.ok(told.some(change => change.path === `/api/agenda/${item.id}`));
});

test('a change the phone made while away loses against a more recent one made here', async t => {
  const app = await setup(t);
  const { request } = app;
  await request('/settings/realtime_name', 'PUT', { value: 'Prima' });
  const { phone, exchange } = phoneOf(t, app);
  await exchange();
  phone.setSetting('realtime_name', 'Phone');
  await new Promise(resolve => setTimeout(resolve, 15));
  await request('/settings/realtime_name', 'PUT', { value: 'Desk' });
  await exchange();
  assert.equal((await (await request('/settings/realtime_name')).json()).value, 'Desk');
  assert.equal(phone.getSetting('realtime_name'), 'Desk');
});

test('the phone reaches the archive, bytes included, but not what only this computer does', async t => {
  const { api } = await setup(t);
  const list = await api('dev-1', { method: 'GET', path: '/api/conversations' });
  assert.equal(list.result.status, 200);
  assert.ok(Array.isArray(list.result.data));
  for (const [method, path] of [['POST', '/api/shutdown'], ['GET', '/api/bridge'], ['POST', '/api/security/unlock'], ['GET', '/api/changes'], ['GET', '/api/../x']]) {
    await assert.rejects(api('dev-1', { method, path }), error => error.code === 'forbidden');
  }
  assert.equal(allowed('GET', '/api/security'), true);
  const page = await api('dev-1', { method: 'GET', path: '/api/health' });
  assert.equal(page.result.data.app, 'synthorg-storage');
});

test('what is written here goes to a connected phone by itself, as rows, a moment after', async t => {
  const app = await setup(t);
  const { request, sync, store } = app;
  const { phone, exchange, hear } = phoneOf(t, app);
  await exchange();
  const sent = [];
  const bridge = { connections: new Map([['dev-1', {}]]), send: async message => { sent.push(message); return { sent: 1 }; } };
  const stop = tellPhones({ bridge, sync, store: () => store, everyMs: 150, checkMs: 100000 });
  t.after(stop);
  const chat = await (await request('/conversations', 'POST', {})).json();
  for (const content of ['C', 'Ci', 'Cia', 'Ciao']) await request(`/conversations/${chat.id}/messages`, 'POST', { id: 'm1', role: 'assistant', content, status: content === 'Ciao' ? 'complete' : 'streaming' });
  await request('/settings/a', 'PUT', { value: '1' });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(sent.length, 1, 'one message for all of it');
  assert.equal(sent[0].header.name, 'sync');
  const took = hear(sent[0]);
  assert.equal(took.gap, false);
  assert.deepEqual(phone.messages(chat.id).map(m => [m.id, m.content, m.status]), [['m1', 'Ciao', 'complete']]);
  assert.equal(phone.getSetting('a'), '1');

  // Nothing new: nothing sent. What the phone itself wrote is not sent back to it.
  phone.setSetting('b', '2');
  await exchange();
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(sent.length, 1);
});

test('a snapshot answers many readings in one message, and only what differs from the phone\'s copies', async t => {
  const zlib = require('node:zlib');
  const { request, bridge } = await setup(t);
  const snapshot = bridge.local.snapshot;
  await request('/settings/app_locale', 'PUT', { value: 'it' });
  const chat = await (await request('/conversations', 'POST', {})).json();
  const unpack = (answer) => JSON.parse(zlib.gunzipSync(answer.body).toString('utf8')).items;

  const first = await snapshot('dev-1', { items: [{ path: '/api/settings' }, { path: '/api/conversations' }, { path: '/api/bridge' }, { path: '/api/nothing-here' }] });
  assert.deepEqual([first.result.encoding, first.result.count, first.result.changed], ['gzip', 4, 2]);
  const items = unpack(first);
  assert.deepEqual(items.map(item => [item.path, item.status]), [['/api/settings', 200], ['/api/conversations', 200], ['/api/bridge', 403], ['/api/nothing-here', 404]]);
  assert.equal(items[0].data.app_locale, 'it');
  assert.equal(items[1].data[0].id, chat.id);
  assert.match(items[0].tag, /^[0-9a-f]{16}$/);

  // the same again, with the tags of what was kept: nothing travels
  const again = unpack(await snapshot('dev-1', { items: items.slice(0, 2).map(item => ({ path: item.path, tag: item.tag })) }));
  assert.deepEqual(again, [{ path: '/api/settings', same: true }, { path: '/api/conversations', same: true }]);

  // one thing changes: only that one comes back, and a single reading has the same tag
  await request('/settings/app_locale', 'PUT', { value: 'en' });
  const later = unpack(await snapshot('dev-1', { items: items.slice(0, 2).map(item => ({ path: item.path, tag: item.tag })) }));
  assert.deepEqual(later.map(item => [item.path, item.same === true, item.data?.app_locale]), [['/api/settings', false, 'en'], ['/api/conversations', true, undefined]]);
  const single = await bridge.local.api('dev-1', { method: 'GET', path: '/api/settings' });
  assert.equal(single.result.tag, later[0].tag);
});

test('secrets stay on the computer: a phone is told a key is set, never the key, and cannot write it', async t => {
  const { HELD } = require('../server/bridge-api');
  const { request, api, bridge, sync, store } = await setup(t);
  await request('/settings/openrouter_api_key', 'PUT', { value: 'sk-or-v1-secret-of-the-user' });
  await request('/settings/bridge', 'PUT', { value: '{"enabled":true,"password":"router-secret"}' });
  await request('/settings/app_locale', 'PUT', { value: 'it' });

  const all = (await api('dev-1', { method: 'GET', path: '/api/settings' })).result.data;
  assert.deepEqual([all.openrouter_api_key, all.bridge, all.app_locale], [HELD, undefined, 'it']);
  assert.equal((await api('dev-1', { method: 'GET', path: '/api/settings/openrouter_api_key' })).result.data.value, HELD);
  assert.equal(JSON.stringify(await bridge.local.snapshot('dev-1', { items: [{ path: '/api/settings' }] }).then(a => require('node:zlib').gunzipSync(a.body).toString())).includes('secret'), false);

  // not written from a phone, whatever it sends
  await assert.rejects(api('dev-1', { method: 'PUT', path: '/api/settings/openrouter_api_key', body: { value: HELD } }), error => error.code === 'forbidden');
  await assert.rejects(api('dev-1', { method: 'DELETE', path: '/api/settings/openrouter_api_key' }), error => error.code === 'forbidden');
  assert.equal((await (await request('/settings/openrouter_api_key')).json()).value, 'sk-or-v1-secret-of-the-user', 'the page still reads it');

  // nor sent in a row, by itself or when asked
  const { phone, exchange, hear } = phoneOf(t, { bridge });
  await exchange();
  assert.equal(phone.getSetting('openrouter_api_key'), null);
  assert.equal(phone.getSetting('bridge'), null);
  assert.equal(phone.getSetting('app_locale'), 'it');
  const told = [];
  const phones = { connections: new Map([['dev-1', {}]]), send: async message => { told.push(message); return { sent: 1 }; } };
  const stop = tellPhones({ bridge: phones, sync, store: () => store, everyMs: 5, checkMs: 100000 });
  t.after(stop);
  await request('/settings/openrouter_api_key', 'PUT', { value: 'sk-or-v1-another-secret' });
  await request('/settings/app_locale', 'PUT', { value: 'en' });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(told.length, 1);
  hear(told[0]);
  assert.equal(phone.getSetting('app_locale'), 'en');
  assert.equal(zlib.gunzipSync(Buffer.from(told[0].body, 'base64')).toString('utf8').includes('secret'), false);

  // and a key set on the phone stays on the phone
  phone.setSetting('openrouter_api_key', 'sk-or-v1-of-the-phone');
  await exchange();
  assert.equal((await (await request('/settings/openrouter_api_key')).json()).value, 'sk-or-v1-another-secret');
});
