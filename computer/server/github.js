'use strict';
const http = require('node:http');
const { randomBytes, createHash } = require('node:crypto');
const { fail } = require('./database');

const API = 'https://api.github.com';
const WEB = 'https://github.com';
// GitHub only redirects back to the callback URLs registered with the app, so
// the sign-in listener needs a port that stays the same across runs. It is
// open only while a sign-in is in progress.
const DEFAULT_PORT = 47819;
const FLOW_TIMEOUT_MS = 15 * 60 * 1000;
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

function assertRepoName(value) {
  const name = String(value == null ? '' : value).trim();
  if (!REPO_PATTERN.test(name) || name.includes('..')) fail('Repository GitHub non valida: usa la forma "proprietario/nome".');
  return name;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(title, message, extra = '') {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SynthOrg</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#101113;color:#eeeef1}main{max-width:460px;padding:32px;text-align:center}h1{font-size:20px;font-weight:600}p{color:#a4a5af;line-height:1.5}button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #8aafff;background:#8aafff;color:#101113;cursor:pointer}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${extra}</main></body></html>`;
}

/**
 * GitHub access for Code projects, as a private GitHub App owned by the user.
 *
 * The app is created from a manifest, so its permissions are fixed here and
 * reviewed by the user on GitHub: contents and pull requests, nothing that can
 * change repository settings or branch protection. Tokens stay in this process
 * and the database; the webview only ever sees the connection status.
 */
class GitHubManager {
  constructor({ store, fetchImpl = globalThis.fetch, port = DEFAULT_PORT } = {}) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.port = port;
    this.flow = null;
    this.listener = null;
    this.lastError = null;
  }

  app() { return this.store().getIntegration('github_app'); }
  auth() { return this.store().getIntegration('github_auth'); }

  status() {
    const app = this.app();
    const auth = this.auth();
    return {
      appRegistered: Boolean(app?.client_id),
      appName: app?.name || null,
      appUrl: app?.html_url || null,
      connected: Boolean(auth?.access_token),
      login: auth?.login || null,
      pending: Boolean(this.flow),
      error: this.lastError
    };
  }

  async startConnect() {
    const registered = Boolean(this.app()?.client_id);
    await this.beginFlow(registered ? 'authorize' : 'register');
    return { url: registered ? this.authorizeUrl() : `${this.base()}/github/register?state=${this.flow.state}` };
  }

  async startInstall() {
    const app = this.app();
    if (!app?.slug) fail('Collega prima GitHub: l’app di SynthOrg non è ancora registrata.', 409);
    await this.beginFlow('install');
    return { url: this.installUrl(app) };
  }

  disconnect() {
    this.store().setIntegration('github_auth', null);
    return this.status();
  }

  close() {
    if (this.flow) clearTimeout(this.flow.timer);
    this.flow = null;
    this.closeListener();
  }

  // --- sign-in flow ---------------------------------------------------------

  async beginFlow(mode) {
    await this.listen();
    if (this.flow) clearTimeout(this.flow.timer);
    const flow = { mode, state: randomBytes(24).toString('hex'), verifier: randomBytes(48).toString('base64url') };
    flow.timer = setTimeout(() => { if (this.flow === flow) this.finish('Accesso a GitHub scaduto: riprova.'); }, FLOW_TIMEOUT_MS);
    flow.timer.unref?.();
    this.flow = flow;
    this.lastError = null;
  }

  finish(error = null) {
    if (this.flow) clearTimeout(this.flow.timer);
    this.flow = null;
    this.lastError = error;
    // Let the response that ended the flow reach the browser first.
    setTimeout(() => this.closeListener(), 250).unref?.();
  }

  listen() {
    if (this.listener) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch(error => {
          if (!res.headersSent) this.send(res, error.status && error.status < 500 ? error.status : 502, page('Accesso a GitHub non riuscito', error.message));
          this.finish(error.message);
        });
      });
      server.once('error', error => reject(Object.assign(new Error(error.code === 'EADDRINUSE'
        ? `La porta ${this.port} serve all’accesso a GitHub ma è occupata da un altro programma.`
        : error.message), { status: 409 })));
      server.listen(this.port, '127.0.0.1', () => { this.listener = server; resolve(); });
    });
  }

  closeListener() {
    const server = this.listener;
    this.listener = null;
    if (server) { server.close(); server.closeAllConnections?.(); }
  }

  base() { return `http://127.0.0.1:${this.listener.address().port}`; }

  installUrl(app) {
    return `${WEB}/apps/${encodeURIComponent(app.slug)}/installations/new?state=${this.flow.state}`;
  }

  authorizeUrl() {
    const params = new URLSearchParams({
      client_id: this.app().client_id,
      redirect_uri: `${this.base()}/github/callback`,
      state: this.flow.state,
      code_challenge: createHash('sha256').update(this.flow.verifier).digest('base64url'),
      code_challenge_method: 'S256'
    });
    return `${WEB}/login/oauth/authorize?${params}`;
  }

  manifest() {
    const base = this.base();
    return {
      name: `SynthOrg Code ${randomBytes(3).toString('hex')}`,
      url: 'https://github.com/SynthOrg/SynthOrg',
      description: 'SynthOrg Code: agents work only on dedicated branches and open pull requests; merging stays with you.',
      public: false,
      redirect_url: `${base}/github/manifest`,
      callback_urls: [`${base}/github/callback`],
      setup_url: `${base}/github/installed`,
      setup_on_update: true,
      request_oauth_on_install: false,
      hook_attributes: { url: 'https://github.com/SynthOrg/SynthOrg', active: false },
      default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      default_events: []
    };
  }

  send(res, status, html) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end(html);
  }

  redirect(res, location) {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const flow = this.flow;
    if (req.method !== 'GET' || !flow) return this.send(res, 404, page('SynthOrg', 'Nessun accesso a GitHub in corso.'));
    const stateOk = url.searchParams.get('state') === flow.state;

    if (url.pathname === '/github/register' && flow.mode === 'register' && stateOk) {
      const action = `${WEB}/settings/apps/new?state=${flow.state}`;
      const form = `<form id="manifest-form" method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(this.manifest()))}"><button type="submit">Continua su GitHub</button></form><script>document.getElementById('manifest-form').submit();</script>`;
      return this.send(res, 200, page('Registrazione su GitHub', 'GitHub ti chiede di creare l’app privata di SynthOrg con i permessi già impostati.', form));
    }

    if (url.pathname === '/github/manifest' && flow.mode === 'register' && stateOk) {
      await this.convertManifest(url.searchParams.get('code'));
      flow.mode = 'install';
      return this.redirect(res, this.installUrl(this.app()));
    }

    // Where GitHub sends the browser after repositories are picked. It does not
    // always carry the state back; nothing here trusts the request beyond
    // continuing to GitHub's own authorization page, which checks the state.
    if (url.pathname === '/github/installed' && flow.mode === 'install') {
      if (this.auth()?.access_token) {
        this.send(res, 200, page('Repository aggiornate', 'Puoi chiudere questa pagina e tornare a SynthOrg.'));
        return this.finish();
      }
      flow.mode = 'authorize';
      return this.redirect(res, this.authorizeUrl());
    }

    if (url.pathname === '/github/callback' && flow.mode === 'authorize' && stateOk) {
      const error = url.searchParams.get('error');
      if (error) {
        const message = url.searchParams.get('error_description') || error;
        this.send(res, 400, page('Accesso annullato', message));
        return this.finish(`GitHub: ${message}`);
      }
      await this.exchange({ code: url.searchParams.get('code'), redirect_uri: `${this.base()}/github/callback`, code_verifier: flow.verifier });
      // Authorized but installed nowhere: without an installation there are no
      // repositories to work on, so continue straight to picking them.
      if (!(await this.installations()).length) {
        flow.mode = 'install';
        return this.redirect(res, this.installUrl(this.app()));
      }
      this.send(res, 200, page('GitHub collegato', 'Puoi chiudere questa pagina e tornare a SynthOrg.'));
      return this.finish();
    }

    return this.send(res, 400, page('SynthOrg', 'Richiesta non valida o scaduta. Riprova da SynthOrg.'));
  }

  async convertManifest(code) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(code || ''))) fail('Codice di registrazione GitHub non valido.');
    const app = await this.request(`${API}/app-manifests/${code}/conversions`, { method: 'POST' });
    // The private key and webhook secret are not needed by a user-token client
    // and are deliberately not kept.
    this.store().setIntegration('github_app', {
      id: app.id, slug: app.slug, name: app.name, html_url: app.html_url,
      client_id: app.client_id, client_secret: app.client_secret
    });
  }

  async exchange(params) {
    const app = this.app();
    if (!app?.client_id) fail('App GitHub non registrata.', 409);
    const data = await this.request(`${WEB}/login/oauth/access_token`, {
      method: 'POST',
      body: { client_id: app.client_id, client_secret: app.client_secret, ...params }
    });
    if (data.error || !data.access_token) fail(`GitHub: ${data.error_description || data.error || 'token non ricevuto'}`, 502);
    const now = Date.now();
    const auth = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || null,
      expires_at: data.expires_in ? now + data.expires_in * 1000 : null,
      refresh_expires_at: data.refresh_token_expires_in ? now + data.refresh_token_expires_in * 1000 : null,
      login: this.auth()?.login || null
    };
    if (!auth.login) auth.login = (await this.request(`${API}/user`, { token: auth.access_token })).login || null;
    this.store().setIntegration('github_auth', auth);
    return auth;
  }

  // --- API ------------------------------------------------------------------

  async request(url, { method = 'GET', token, body } = {}) {
    const isApi = url.startsWith(API);
    const headers = { Accept: isApi ? 'application/vnd.github+json' : 'application/json', 'User-Agent': 'SynthOrg' };
    if (isApi) headers['X-GitHub-Api-Version'] = '2022-11-28';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    } catch (error) { fail(`GitHub non raggiungibile: ${error.message}`, 502); }
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) {
      // 409 is how a merge reports a conflict: it has to reach the user as
      // what it is, not as "GitHub is broken".
      const status = response.status === 404 ? 404 : response.status === 401 ? 409
        : [403, 409, 422].includes(response.status) ? response.status : 502;
      fail(`GitHub: ${data.message || `errore ${response.status}`}`, status);
    }
    return data;
  }

  async token() {
    const auth = this.auth();
    if (!auth?.access_token) fail('GitHub non è collegato: collegalo da Code → Nuovo progetto → GitHub.', 409);
    if (!auth.expires_at || auth.expires_at - 60000 > Date.now()) return auth.access_token;
    const expired = () => {
      this.store().setIntegration('github_auth', null);
      return 'Il collegamento a GitHub è scaduto: collegati di nuovo.';
    };
    if (!auth.refresh_token || (auth.refresh_expires_at && auth.refresh_expires_at <= Date.now())) fail(expired(), 409);
    try {
      return (await this.exchange({ grant_type: 'refresh_token', refresh_token: auth.refresh_token })).access_token;
    } catch { fail(expired(), 409); }
  }

  async api(pathname, options = {}) {
    return this.request(`${API}${pathname}`, { ...options, token: await this.token() });
  }

  async installations() {
    const app = this.app();
    const data = await this.api('/user/installations?per_page=100');
    return (data.installations || []).filter(installation => installation.app_id === app?.id);
  }

  async listRepositories() {
    const repositories = [];
    for (const installation of await this.installations()) {
      for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
        const data = await this.api(`/user/installations/${installation.id}/repositories?per_page=100&page=${pageNumber}`);
        const items = data.repositories || [];
        repositories.push(...items.map(repo => ({
          id: repo.id, full_name: repo.full_name, name: repo.name, private: Boolean(repo.private),
          default_branch: repo.default_branch, html_url: repo.html_url
        })));
        if (items.length < 100) break;
      }
    }
    return repositories.sort((a, b) => a.full_name.localeCompare(b.full_name));
  }

  async getRepository(fullName) {
    const name = assertRepoName(fullName);
    const repo = await this.api(`/repos/${name}`);
    return {
      id: repo.id, full_name: repo.full_name, name: repo.name, default_branch: repo.default_branch,
      html_url: repo.html_url, canPush: Boolean(repo.permissions?.push)
    };
  }

  /** The repository's branch names, for the user to pick where a push goes. */
  async listBranches(fullName) {
    const name = assertRepoName(fullName);
    const names = [];
    for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
      const page = await this.api(`/repos/${name}/branches?per_page=100&page=${pageNumber}`);
      names.push(...(page || []).map(branch => branch.name));
      if (!page || page.length < 100) break;
    }
    return names;
  }
}

module.exports = { GitHubManager, assertRepoName, DEFAULT_PORT };
