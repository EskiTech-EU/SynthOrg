'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Store } = require('../server/database');
const { GitHubManager } = require('../server/github');

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeGitHub() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method: options.method || 'GET', body, headers: options.headers || {} });
    if (url === 'https://api.github.com/app-manifests/manifest-code/conversions') {
      return json({ id: 42, slug: 'synthorg-code-abc', name: 'SynthOrg Code abc', html_url: 'https://github.com/apps/synthorg-code-abc', client_id: 'Iv1.client', client_secret: 'shh-secret', pem: 'PRIVATE KEY', webhook_secret: null }, 201);
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      if (body.grant_type === 'refresh_token') return json({ access_token: 'ghu_refreshed', expires_in: 28800, refresh_token: 'ghr_new', refresh_token_expires_in: 15897600 });
      return json({ access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first', refresh_token_expires_in: 15897600, token_type: 'bearer' });
    }
    if (url === 'https://api.github.com/user') return json({ login: 'octocat' });
    if (url === 'https://api.github.com/user/installations?per_page=100') {
      return json({ total_count: 2, installations: [{ id: 7, app_id: 42 }, { id: 8, app_id: 99 }] });
    }
    if (url.startsWith('https://api.github.com/user/installations/7/repositories')) {
      return json({ repositories: [
        { id: 1, full_name: 'octocat/zeta', name: 'zeta', private: true, default_branch: 'main', html_url: 'https://github.com/octocat/zeta' },
        { id: 2, full_name: 'octocat/alpha', name: 'alpha', private: false, default_branch: 'dev', html_url: 'https://github.com/octocat/alpha' }
      ] });
    }
    return json({ message: 'Not Found' }, 404);
  };
  return { calls, fetchImpl };
}

function setup(t) {
  const store = new Store(':memory:');
  const { calls, fetchImpl } = fakeGitHub();
  const github = new GitHubManager({ store: () => store, fetchImpl, port: 0 });
  t.after(() => { github.close(); store.close(); });
  return { store, calls, github };
}

const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('connecting registers a least-privilege app, installs it and authorizes with PKCE', async t => {
  const { store, calls, github } = setup(t);
  const { url } = await github.startConnect();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/github\/register\?state=[a-f0-9]{48}$/);
  const base = new URL(url).origin;
  const state = new URL(url).searchParams.get('state');
  assert.equal(github.status().pending, true);

  assert.equal((await fetch(`${base}/github/register?state=wrong`)).status, 400);
  const html = await (await fetch(url)).text();
  assert.ok(html.includes(`action="https://github.com/settings/apps/new?state=${state}"`));
  const manifest = JSON.parse(decode(/name="manifest" value="([^"]*)"/.exec(html)[1]));
  assert.deepEqual(manifest.default_permissions, { contents: 'write', pull_requests: 'write', metadata: 'read' });
  assert.equal(manifest.public, false);
  assert.equal(manifest.redirect_url, `${base}/github/manifest`);
  assert.deepEqual(manifest.callback_urls, [`${base}/github/callback`]);
  assert.equal(manifest.setup_url, `${base}/github/installed`);

  const converted = await fetch(`${base}/github/manifest?code=manifest-code&state=${state}`, { redirect: 'manual' });
  assert.equal(converted.status, 302);
  assert.equal(converted.headers.get('location'), `https://github.com/apps/synthorg-code-abc/installations/new?state=${state}`);
  const app = store.getIntegration('github_app');
  assert.equal(app.client_id, 'Iv1.client');
  assert.equal(app.pem, undefined, 'the private key is not kept');

  const installed = await fetch(`${base}/github/installed?installation_id=7&setup_action=install`, { redirect: 'manual' });
  assert.equal(installed.status, 302);
  const authorize = new URL(installed.headers.get('location'));
  assert.equal(authorize.origin + authorize.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(authorize.searchParams.get('client_id'), 'Iv1.client');
  assert.equal(authorize.searchParams.get('redirect_uri'), `${base}/github/callback`);
  assert.equal(authorize.searchParams.get('state'), state);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');

  assert.equal((await fetch(`${base}/github/callback?code=oauth-code&state=wrong`)).status, 400);
  assert.equal(store.getIntegration('github_auth'), null);

  const done = await fetch(`${base}/github/callback?code=oauth-code&state=${state}`);
  assert.equal(done.status, 200);
  const exchange = calls.find(call => call.url === 'https://github.com/login/oauth/access_token');
  assert.equal(exchange.body.code, 'oauth-code');
  assert.equal(exchange.body.client_secret, 'shh-secret');
  assert.equal(createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), authorize.searchParams.get('code_challenge'));

  const status = github.status();
  assert.equal(status.connected, true);
  assert.equal(status.login, 'octocat');
  assert.equal(status.pending, false);
  assert.ok(!JSON.stringify(status).includes('ghu_') && !JSON.stringify(status).includes('shh-secret'), 'status never carries secrets');
});

test('an expired token is refreshed with the app credentials', async t => {
  const { store, calls, github } = setup(t);
  store.setIntegration('github_app', { id: 42, slug: 'synthorg-code-abc', client_id: 'Iv1.client', client_secret: 'shh-secret' });
  store.setIntegration('github_auth', { access_token: 'ghu_old', refresh_token: 'ghr_old', expires_at: Date.now() - 1000, refresh_expires_at: Date.now() + 1e9, login: 'octocat' });
  assert.equal(await github.token(), 'ghu_refreshed');
  const refresh = calls.find(call => call.body?.grant_type === 'refresh_token');
  assert.equal(refresh.body.refresh_token, 'ghr_old');
  const auth = store.getIntegration('github_auth');
  assert.equal(auth.refresh_token, 'ghr_new');
  assert.equal(auth.login, 'octocat');
});

test('repositories come only from this app’s installations, and disconnecting forgets the token', async t => {
  const { store, calls, github } = setup(t);
  store.setIntegration('github_app', { id: 42, slug: 'synthorg-code-abc', client_id: 'Iv1.client', client_secret: 'shh-secret' });
  store.setIntegration('github_auth', { access_token: 'ghu_live', expires_at: null, login: 'octocat' });
  const repos = await github.listRepositories();
  assert.deepEqual(repos.map(repo => repo.full_name), ['octocat/alpha', 'octocat/zeta']);
  assert.ok(!calls.some(call => call.url.includes('/installations/8/')));
  assert.equal(calls[0].headers.Authorization, 'Bearer ghu_live');
  await assert.rejects(github.getRepository('not a repo'), error => error.status === 400);

  github.disconnect();
  await assert.rejects(github.token(), error => error.status === 409);
});
