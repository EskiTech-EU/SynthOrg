'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Store } = require('../server/database');
const { createApp } = require('../server/index');
const { KNOWN_ROLES, KNOWN_TOOLS, KNOWN_JOBS, LANGUAGES } = require('../server/usage');
// Sharing is off in the app for now (share-endpoint.js): the tests of it turn it on.
process.env.SYNTHORG_SHARE_ON = '1';

const TOKEN = 'test-token';
const plain = (value) => JSON.parse(JSON.stringify(value));
const worker = () => import(pathToFileURL(path.join(__dirname, '../share-worker/worker.js')).href);

/** A package as the app makes it, from a few requests written down. */
function made(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const project = store.createProject({ name: 'Sito del cliente Rossi', kind: 'local', path: 'C:/lavoro/rossi' });
  const code = store.createConversation('Chat del progetto');
  store.db.prepare('UPDATE conversations SET project_id=? WHERE id=?').run(project.id, code.id);
  const usage = store.usage();
  usage.record({ conversationId: code.id, role: 'master', turn: 't1', model: 'google/gemini-3.8-flash', cost: 3.2, ms: 4000, firstMs: 900, promptTokens: 5000, completionTokens: 700 });
  usage.record({ conversationId: code.id, role: 'tool:thinking_solver', turn: 't1', model: 'openai/o5', cost: 2.1, ms: 9000 });
  usage.record({ role: 'speech', place: 'realtime', model: 'google/gemini-3.8-flash-lite-tts', generation: 'gen-tts-000001', ms: 1900 });
  usage.record({ conversationId: code.id, role: 'master', turn: 't2', model: 'local/Modello-di-Samu.gguf', local: true, ms: 8000, firstMs: 300, completionTokens: 200 });
  return usage.sharePackage({ profiles: { [project.id]: { languages: ['rust', 'typescript'], size: 'M' } }, app: '1.1.0' }).package;
}

/** A GitHub that keeps what is written to it. */
function github({ status = 201 } = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ content: {} }), { status });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const env = { GITHUB_REPO: 'synthorg/numbers', GITHUB_TOKEN: 'secret-token', GITHUB_BRANCH: 'main' };
const post = (body, headers = {}) => new Request('https://share.example/', { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.7', 'User-Agent': 'SynthOrg/1.1.0 (Windows; samus)', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('the names the service accepts are the ones the app may send', async () => {
  const { ROLES, TOOLS, JOBS, LANGUAGES: accepted } = await worker();
  assert.deepEqual([...ROLES].sort(), [...KNOWN_ROLES].sort());
  assert.deepEqual([...TOOLS].sort(), [...KNOWN_TOOLS, 'other'].sort());
  assert.deepEqual([...JOBS].sort(), [...KNOWN_JOBS, 'other'].sort());
  assert.deepEqual([...accepted].sort(), [...new Set(Object.values(LANGUAGES))].sort());
});

test('a package as the app makes it is taken and written to the repository, with nothing about who sent it', async t => {
  const { default: service } = await worker();
  const shared = made(t);
  const hub = github(); t.after(hub.restore);
  const response = await service.fetch(post(shared), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { stored: true });
  const [call] = hub.calls;
  assert.equal(call.url, `https://api.github.com/repos/synthorg/numbers/contents/packages/${shared.weeks.to}/${shared.id}.json`);
  assert.equal(call.options.method, 'PUT');
  assert.equal(call.options.headers.Authorization, 'Bearer secret-token');
  const body = JSON.parse(call.options.body);
  assert.equal(body.branch, 'main');
  const stored = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
  assert.deepEqual(stored, plain(shared), 'what is stored is what was shown to the user');
  const everything = JSON.stringify(body) + Buffer.from(body.content, 'base64').toString('utf8');
  for (const trace of ['203.0.113.7', 'samus', 'Windows', 'Rossi', 'gguf', 'gen-tts']) assert.equal(everything.includes(trace), false, `"${trace}" must not be stored`);
});

test('anything that is not the numbers expected refuses the package whole', async t => {
  const { default: service, clean } = await worker();
  const shared = made(t);
  const hub = github(); t.after(hub.restore);
  const change = (edit) => { const copy = plain(shared); edit(copy); return copy; };
  const bad = [
    change(p => { p.user = 'samus'; }),
    change(p => { p.groups[0].note = 'il progetto del cliente Rossi'; }),
    change(p => { p.groups[0].model = 'C:\\Users\\samus\\modello segreto'; }),
    change(p => { p.groups[0].model = 'local/Modello-di-Samu.gguf'; }),
    change(p => { p.groups[0].role = 'tool:il_mio_strumento'; }),
    change(p => { p.groups[0].role = 'agent:marco'; }),
    change(p => { p.groups[0].place = 'casa di Samu'; }),
    change(p => { p.groups[0].project = { languages: ['rust'], size: 'M', name: 'Rossi' }; }),
    change(p => { p.groups[0].project = { languages: ['linguaggio-mio'], size: 'M' }; }),
    change(p => { p.groups[0].project = { languages: ['rust', 'go', 'c', 'java'], size: 'M' }; }),
    change(p => { p.groups[0].cost = '3.2 dollari'; }),
    change(p => { p.groups[0].cost = -1; }),
    change(p => { p.groups[0].runs = 1.5; }),
    change(p => { p.groups[0].ok = p.groups[0].runs + 1; }),
    change(p => { p.groups[0].ms_p50 = 'presto'; }),
    change(p => { delete p.groups[0].cost; }),
    change(p => { p.weeks.from = '2026-09-28T10:41:00Z'; }),
    change(p => { p.weeks = { from: '2026-W41', to: '2026-W40' }; }),
    change(p => { p.id = 'samus-pc'; }),
    change(p => { p.app = '1.1.0 (build di Samu)'; }),
    change(p => { p.schema = 2; }),
    change(p => { p.groups = []; }),
    change(p => { p.groups = Array.from({ length: 501 }, () => p.groups[0]); }),
    [shared], 'ciao', null
  ];
  for (const wrong of bad) {
    assert.throws(() => clean(wrong), undefined, JSON.stringify(wrong).slice(0, 120));
    const response = await service.fetch(post(wrong), env);
    assert.equal(response.status, 400);
  }
  assert.equal((await service.fetch(post('{not json'), env)).status, 400);
  assert.equal(hub.calls.length, 0, 'nothing refused is written anywhere');
  assert.deepEqual(clean(plain(shared)), plain(shared));
});

test('only a package is taken: by POST, of a bounded size, when the service is set up', async t => {
  const { default: service } = await worker();
  const shared = made(t);
  const hub = github(); t.after(hub.restore);
  assert.equal((await service.fetch(new Request('https://share.example/', { method: 'GET' }), env)).status, 405);
  assert.equal((await service.fetch(post(shared), { GITHUB_REPO: 'synthorg/numbers' })).status, 503);
  assert.equal((await service.fetch(post(shared), { ...env, GITHUB_REPO: 'not a repository' })).status, 503);
  assert.equal((await service.fetch(post('x'.repeat(300 * 1024)), env)).status, 413);
  const limited = { ...env, LIMITER: { limit: async ({ key }) => ({ success: key !== '203.0.113.7' }) } };
  assert.equal((await service.fetch(post(shared), limited)).status, 429);
  assert.equal(hub.calls.length, 0);
});

test('the same package twice is there already; a repository that refuses is said so', async t => {
  const { default: service } = await worker();
  const shared = made(t);
  const twice = github({ status: 422 });
  assert.deepEqual(await (await service.fetch(post(shared), env)).json(), { stored: true, already: true });
  twice.restore();
  const down = github({ status: 500 }); t.after(down.restore);
  assert.equal((await service.fetch(post(shared), env)).status, 502);
});

/* ------------------------------------------------------------------ */
/* From the app to the repository                                       */
/* ------------------------------------------------------------------ */

async function app(t, { fetchImpl }) {
  const { server } = createApp({ token: TOKEN, dbPath: ':memory:', githubPort: 0, fetchImpl, sandbox: { async stopAllContainers() { return { success: true, count: 0 }; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const real = globalThis.fetch;
  return async (route, method = 'GET', data) => {
    const res = await real(base + route, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: res.status, body: await res.json() };
  };
}

test('the user says yes: the numbers go, as shown, and the stretch is not asked about again', async t => {
  const { default: service } = await worker();
  const stored = [];
  const sent = [];
  // the app's own connection to the service, which writes to a GitHub that keeps what it is given
  const fetchImpl = async (url, options) => {
    sent.push({ url, options });
    const real = globalThis.fetch;
    globalThis.fetch = async (hubUrl, hubOptions) => { stored.push({ url: String(hubUrl), body: JSON.parse(hubOptions.body) }); return new Response('{}', { status: 201 }); };
    try { return await service.fetch(new Request(url, options), env); } finally { globalThis.fetch = real; }
  };
  const request = await app(t, { fetchImpl });
  const chat = (await request('/conversations', 'POST', { title: 'Una chat' })).body;
  for (let i = 0; i < 3; i++) assert.equal((await request('/usage', 'POST', { conversationId: chat.id, role: 'master', turn: `t${i}`, model: 'google/gemini-3.8-flash', cost: 1.8, ms: 3000, firstMs: 700, completionTokens: 300 })).status, 200);
  let state = (await request('/usage/share')).body;
  assert.deepEqual([state.ready, state.due, state.cost], [false, false, 5.4], 'nowhere to send yet: nothing is asked');
  const refused = await request('/usage/share', 'POST', { answer: 'share', until: state.until });
  assert.equal(refused.status, 409);
  await request('/settings/usage_share_endpoint', 'PUT', { value: 'https://share.synthorg.example/' });
  state = (await request('/usage/share')).body;
  assert.deepEqual([state.ready, state.due], [true, true]);
  const shown = (await request(`/usage/share/package?until=${state.until}`)).body;
  assert.deepEqual([shown.runs, shown.cost, shown.package.groups.length], [3, 5.4, 1]);
  // a request made while the user reads is not in what was shown, and does not go
  await request('/usage', 'POST', { conversationId: chat.id, role: 'master', turn: 'late', model: 'google/gemini-3.8-flash', cost: 0.7 });
  const answered = await request('/usage/share', 'POST', { answer: 'share', until: state.until, package: { schema: 1, groups: [{ note: 'what the page says is not what goes' }] } });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.answer, 'shared');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://share.synthorg.example/');
  assert.deepEqual(Object.keys(sent[0].options.headers), ['Content-Type'], 'nothing about the user rides along');
  const gone = JSON.parse(Buffer.from(stored[0].body.content, 'base64').toString('utf8'));
  assert.deepEqual(gone, shown.package, 'what goes is what was shown, to the letter');
  assert.deepEqual(gone.groups.map(g => [g.model, g.role, g.place, g.runs, g.cost]), [['google/gemini-3.8-flash', 'master', 'chat', 3, 5.4]]);
  assert.equal(JSON.stringify(gone).includes(chat.id), false);
  state = (await request('/usage/share')).body;
  assert.deepEqual([state.due, state.runs, state.cost], [false, 1, 0.7]);
  assert.deepEqual(state.history.map(h => [h.answer, h.runs, h.cost]), [['shared', 3, 5.4]]);
  assert.deepEqual((await request(`/usage/share/history/${state.history[0].id}`)).body.package, gone);
});

test('a sending that fails leaves the numbers here and the question open; saying no sends nothing', async t => {
  let calls = 0;
  const request = await app(t, { fetchImpl: async () => { calls++; if (calls === 1) throw new Error('no network'); return new Response('{}', { status: 500 }); } });
  const chat = (await request('/conversations', 'POST', { title: 'Una chat' })).body;
  await request('/usage', 'POST', { conversationId: chat.id, role: 'master', turn: 't', model: 'a/b', cost: 6 });
  await request('/settings/usage_share_endpoint', 'PUT', { value: 'https://share.synthorg.example/' });
  const until = (await request('/usage/share')).body.until;
  const first = await request('/usage/share', 'POST', { answer: 'share', until });
  assert.equal(first.status, 502);
  assert.match(first.body.error, /no network.*restano su questo computer/);
  assert.equal((await request('/usage/share', 'POST', { answer: 'share', until })).status, 502);
  assert.equal((await request('/usage/share')).body.due, true, 'still to be answered');
  assert.equal((await request('/usage/share/later', 'POST', {})).body.later, true);
  assert.equal((await request('/usage/share')).body.due, false);
  const no = await request('/usage/share', 'POST', { answer: 'decline', until });
  assert.deepEqual([no.status, no.body.answer], [200, 'declined']);
  assert.equal(calls, 2, 'nothing is sent for a no');
  assert.deepEqual((await request('/usage/share')).body.history.map(h => h.answer), ['declined']);
  assert.equal((await request('/usage/share', 'POST', { answer: 'maybe', until })).status >= 400, true);
});

test('the projects come with what they cost', async t => {
  const request = await app(t, { fetchImpl: async () => new Response('{}') });
  assert.deepEqual((await request('/projects')).body, []);
  assert.deepEqual((await request('/usage/projects')).body, {});
  const overview = (await request('/usage?from=2026-01-01&to=2099-01-01')).body;
  assert.deepEqual([overview.total.runs, overview.byModel.length], [0, 0]);
  assert.equal((await request('/usage', 'POST', { role: 'master' })).status, 400);
  assert.equal((await request('/usage/corrected', 'POST', { conversationId: 'nobody' })).body.marked, 0);
});
