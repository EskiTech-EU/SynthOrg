'use strict';
// Editing a message cuts the history at that message in one server step, and
// the stop button reaches a command still running for a chat.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

const TOKEN = 'synthorg-test-token';

function fakeSandbox(calls = []) {
  return {
    async execute(id, command, options) { calls.push(['exec', id, command, options]); return { stdout: `ran: ${command}`, stderr: '', exitCode: 0, runId: options.runId }; },
    async interrupt(id, runId) { calls.push(['interrupt', id, runId]); return { interrupted: true }; },
    async interruptRun(runId, why) { calls.push(['interruptRun', runId, why]); return { interrupted: true }; },
    async stopAllContainers() { return { success: true, count: 0 }; }
  };
}

async function setup(t, calls = []) {
  const { server } = createApp({ token: TOKEN, dbPath: ':memory:', githubPort: 0, sandbox: fakeSandbox(calls) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (route, method = 'GET', data) => {
    const res = await fetch(base + route, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: res.status, body: await res.json() };
  };
  return { request };
}

const message = (role, content) => ({ id: `${role}-${content}`, role, content, kind: 'final', status: 'complete' });

test('editing a message removes it and everything after it, in one step', async t => {
  const { request } = await setup(t);
  const { body: conv } = await request('/conversations', 'POST', { title: 'edit' });
  for (const m of [message('user', 'uno'), message('assistant', 'r1'), message('user', 'due'), message('assistant', 'r2')]) {
    assert.equal((await request(`/conversations/${conv.id}/messages`, 'POST', m)).status, 200);
  }
  const cut = await request(`/conversations/${conv.id}/messages?from=user-due`, 'DELETE');
  assert.equal(cut.status, 200);
  assert.equal(cut.body.deleted, 2);
  const after = await request(`/conversations/${conv.id}`);
  assert.deepEqual(after.body.messages.map(m => m.content), ['uno', 'r1']);

  // an unknown message changes nothing
  const missing = await request(`/conversations/${conv.id}/messages?from=nope`, 'DELETE');
  assert.equal(missing.status, 404);
  assert.equal((await request(`/conversations/${conv.id}`)).body.messages.length, 2);

  // a message of another chat is not reachable through this one
  const { body: other } = await request('/conversations', 'POST', { title: 'other' });
  await request(`/conversations/${other.id}/messages`, 'POST', message('user', 'altro'));
  assert.equal((await request(`/conversations/${conv.id}/messages?from=user-altro`, 'DELETE')).status, 404);
  assert.equal((await request(`/conversations/${other.id}`)).body.messages.length, 1);

  // without `from` the chat is emptied, as before
  assert.equal((await request(`/conversations/${conv.id}/messages`, 'DELETE')).body.deleted, true);
  assert.equal((await request(`/conversations/${conv.id}`)).body.messages.length, 0);
});

test('a command carries its run id and the stop button interrupts it by that id', async t => {
  const calls = [];
  const { request } = await setup(t, calls);
  const { body: conv } = await request('/conversations', 'POST', { title: 'run' });
  const ran = await request(`/conversations/${conv.id}/sandbox/exec`, 'POST', { command: 'sleep 5', runId: 'abc-123', timeoutMs: 1000 });
  assert.equal(ran.status, 200);
  assert.equal(ran.body.runId, 'abc-123');
  assert.equal(calls[0][3].runId, 'abc-123');
  assert.equal(calls[0][3].timeoutMs, 1000);

  const stop = await request(`/conversations/${conv.id}/sandbox/interrupt`, 'POST', { runId: 'abc-123' });
  assert.equal(stop.status, 200);
  assert.deepEqual(stop.body, { interrupted: true });
  assert.deepEqual(calls[1], ['interrupt', conv.id, 'abc-123']);

  // an unknown chat is refused before anything reaches the sandbox
  assert.equal((await request('/conversations/nope/sandbox/interrupt', 'POST', { runId: 'abc-123' })).status, 404);
  assert.equal(calls.length, 2);
});

test('a command whose caller goes away is ended, not left running', async t => {
  const calls = [];
  const { server } = createApp({ token: TOKEN, dbPath: ':memory:', githubPort: 0, sandbox: {
    ...fakeSandbox(calls),
    async execute(id, command, options) { calls.push(['exec', options.runId]); await new Promise(r => setTimeout(r, 600)); return { stdout: '', stderr: '', exitCode: 0 }; }
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  const conv = await (await fetch(`${base}/conversations`, { method: 'POST', headers, body: JSON.stringify({ title: 'gone' }) })).json();
  const controller = new AbortController();
  const pending = fetch(`${base}/conversations/${conv.id}/sandbox/exec`, { method: 'POST', headers, body: JSON.stringify({ command: 'sleep 60', runId: 'run-gone' }), signal: controller.signal }).catch(() => null);
  await new Promise(r => setTimeout(r, 150));
  controller.abort();
  await pending;
  await new Promise(r => setTimeout(r, 700));
  assert.deepEqual(calls.find(c => c[0] === 'interruptRun'), ['interruptRun', 'run-gone', 'interrupted:disconnect']);
});
