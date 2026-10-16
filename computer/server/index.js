'use strict';
const http = require('node:http');
const { DATA_DIR } = require('./paths');
const { Tidy } = require('./tidy');
const memory = require('./memory');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { Store, fail } = require('./database');
const { VaultManager } = require('./vault');
const { SandboxManager, assertSafeImage, createExtensionCatalog, runtimeStamp, TOOLS_IMAGE_REPO } = require('./sandbox');
const { PackageManager } = require('./packages');
const { ProjectManager } = require('./projects');
const { GitHubManager, DEFAULT_PORT: GITHUB_PORT } = require('./github');
const { CodeTools, COPIES_DIR, toolSpecs } = require('./code-tools');
const { ProjectFiles } = require('./project-files');
const { CodePermissions } = require('./code-permissions');
const { StudioManager } = require('./studio');
const { Photocraft } = require('./photocraft');
const { PhotoManager } = require('./photo');
const { sectionEnabled } = require('./database');
const { DesktopSessions, desktopStamp, DESKTOP_IMAGE_REPO } = require('./desktop');
const { performWebSearch, fetchPageContent } = require('./web-search');
const { LocalModelManager } = require('./local-models');
const { workspaceLink } = require('./personal');
const { Bridge } = require('./bridge');
const { Sync } = require('./sync');
const { archiveMethods, tellPhones } = require('./bridge-api');
const archive = require('./archive-api');
const ROOT = path.resolve(__dirname, '..');
// 0 asks the OS for any free port. The desktop shell uses that: refusing to
// start because something else holds a fixed port is not an acceptable failure
// for an end user. An explicit value is still honoured for standalone runs.
const PORT = process.env.SYNTHORG_PORT === undefined ? 4319 : Number(process.env.SYNTHORG_PORT) || 0;
const SERVER_VERSION = 10;
// The app's own version, as the numbers shared carry it.
const APP_VERSION = (() => { try { return String(require('../package.json').version || ''); } catch { return ''; } })();
const instance = createHash('sha256').update(ROOT.toLowerCase()).digest('hex').slice(0, 16);

function getFileCategory(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.ico'].includes(ext)) return 'image';
  if (['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'].includes(ext)) return 'audio';
  if (['.md', '.pdf', '.txt', '.csv', '.json', '.html', '.xml', '.doc', '.docx'].includes(ext)) return 'document';
  if (['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.bz2'].includes(ext)) return 'archive';
  if (['.js', '.mjs', '.ts', '.py', '.sh', '.c', '.cpp', '.rs', '.go', '.java', '.css', '.sql'].includes(ext)) return 'code';
  return 'other';
}

function createZipArchive(sourcePath, destZipPath) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      const psScript = `Compress-Archive -Path '${sourcePath.replace(/'/g, "''")}' -DestinationPath '${destZipPath.replace(/'/g, "''")}' -Force`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`Errore creazione archivio zip: ${stderr || err.message}`));
        resolve();
      });
    } else {
      execFile('zip', ['-r', destZipPath, path.basename(sourcePath)], { cwd: path.dirname(sourcePath), timeout: 30000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`Errore creazione archivio zip: ${stderr || err.message}`));
        resolve();
      });
    }
  });
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.wasm': 'application/wasm',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogg': 'video/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.zip': 'application/zip'
  }[ext] || 'application/octet-stream';
}

/**
 * The file a workspace link points at, where it really is on this computer;
 * null when the link is no workspace link, the file is not there, or it is
 * a way out of the workspace.
 */
function workspaceFile(link) {
  const match = /^\/api\/conversations\/([^/]+)\/sandbox\/files\/(.+)$/.exec(workspaceLink(link) || '');
  if (!match) return null;
  const wsDir = path.join(DATA_DIR, 'sandboxes', match[1].replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36), 'workspace');
  try {
    const root = fs.realpathSync(wsDir);
    const real = fs.realpathSync(path.resolve(wsDir, match[2].split('/').map(decodeURIComponent).join(path.sep)));
    return real.startsWith(root + path.sep) && fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
}

// Origins the Tauri webview can present: custom protocol on macOS/Linux,
// http://tauri.localhost on Windows (WebView2 has no custom-scheme support).
const TAURI_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];

// `tauri dev` serves the frontend from its own loopback server, so in
// development the webview presents http://127.0.0.1:<dev port> instead. The
// bearer token is what actually guards the API; the origin check only keeps
// remote pages out, and a loopback origin is not one.
const LOOPBACK_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i;

/** Constant-time bearer-token check against the session token. */
function authorized(req, expected) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!match) return false;
  const given = Buffer.from(match[1], 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Throttles operations that take the master password. The vault files sit on
 * disk, so an unthrottled endpoint is an online oracle for offline-grade
 * guessing; after 5 failures the delay doubles up to 5 minutes.
 */
function createPasswordGuard() {
  let failures = 0;
  let blockedUntil = 0;
  return {
    check() {
      const remaining = blockedUntil - Date.now();
      if (remaining > 0) fail(`Troppi tentativi con password errata. Riprova tra ${Math.ceil(remaining / 1000)} secondi.`, 429);
    },
    fail() {
      failures += 1;
      if (failures >= 5) blockedUntil = Date.now() + Math.min(2 ** Math.min(failures - 4, 9), 300) * 1000;
    },
    succeed() { failures = 0; blockedUntil = 0; }
  };
}
function createApp({ dbPath = null, memoryData = DATA_DIR, allowedOrigins = TAURI_ORIGINS, token, githubPort = GITHUB_PORT, fetchImpl = globalThis.fetch, sandbox: sandboxOverride = null, bridge: bridgeOverride = null, photocraft: photocraftOverride = null, photoMl: photoMlOverride = null, warmRuntime = false } = {}) {
  // The database is in the memory of the app, which the user may keep elsewhere (memory.js); a path given by the
  // caller (the tests) is used as it is, with everything beside it as before.
  const inMemory = !dbPath;
  if (inMemory) dbPath = path.join(memory.memoryDir(memoryData), 'synthorg.sqlite');
  // Generated per process and handed to the webview over the Tauri IPC:
  // it is never written to disk.
  const sessionToken = token || process.env.SYNTHORG_TOKEN || randomBytes(32).toString('hex');
  const passwordGuard = createPasswordGuard();
  const guardPassword = (run) => {
    let value;
    try {
      value = run();
    } catch (error) {
      if (error.status === 401) passwordGuard.fail();
      throw error;
    }
    passwordGuard.succeed();
    return value;
  };
  const vault = new VaultManager({ root: ROOT, dbPath, sandboxesDir: inMemory ? path.join(memoryData, 'sandboxes') : null });
  let store = vault.isLocked() ? null : new Store(dbPath, { recover: false });
  const packageManager = new PackageManager({ root: ROOT });
  const sandbox = sandboxOverride || new SandboxManager({
    root: ROOT,
    // Read at container-creation time, so toggling a package on the Environment
    // page affects the next container without restarting the service.
    defaultPackages: () => packageManager.listDefault(),
    // Artifacts landing in the shared folder become catalogue entries.
    onCacheChanged: () => packageManager.scan()
  });
  // What is on disk follows the rows (tidy.js): checked when the archive is open, the chats' files copied to a
  // memory that is kept elsewhere.
  const tidy = new Tidy({
    dataDir: memoryData, memoryDir: () => path.dirname(dbPath), store: () => (vault.isLocked() ? null : store),
    plainCopy: () => !vault.getStatus().sandboxes.isEncrypted, log: message => console.log(`[SynthOrg] ${message}`)
  });
  const tidyUp = () => {
    if (!inMemory) return;
    if (!store || vault.isLocked()) { tidy.unwatch(); return; }
    try { tidy.run(); tidy.unwatch(); tidy.watch(); } catch (error) { console.warn(`[SynthOrg] ordine non fatto: ${error.message}`); }
  };
  const github = new GitHubManager({ store: () => store, fetchImpl, port: githubPort });
  const projects = new ProjectManager({ store: () => store, sandbox, github, dataDir: path.dirname(dbPath) });
  const codeTools = new CodeTools({ store: () => store, sandbox, projects });
  const projectFiles = new ProjectFiles({ store: () => store, sandbox, projects });
  // What the model may do to a project without asking: the gate every change
  // and every command goes through, and the questions it leaves pending.
  const permissions = new CodePermissions({ store: () => store });
  // The Studio: long texts in a folder, two sheets a chapter, typeset in a container.
  const studio = new StudioManager({ store: () => store, projects, permissions, sandbox, dataDir: path.dirname(dbPath) });
  // The Studio's Foto tab: photocraft runs in the page; here the folder, the permissions and the functions of ours in a pod.
  const photocraft = photocraftOverride || new Photocraft({ store: () => store, fetchImpl });
  const photo = new PhotoManager({ store: () => store, projects, permissions, sandbox, photocraft, hub: { repoOnnx: id => localModels.hub.repoOnnx(id), fileUrl: (repo, revision, file) => localModels.hub.fileUrl(repo, revision, file) }, dataDir: path.dirname(dbPath), ...(photoMlOverride ? { mlImpl: photoMlOverride } : {}) });
  // Computer use: desktops in containers, each session asked to the user first.
  const desktops = new DesktopSessions({ store: () => store, baseImages: sandbox.baseImages, sandbox });
  // When the vault keeps the chats' files encrypted, locking takes their volumes off the disk of the pods too,
  // each copy brought up to date first: nothing of theirs stays in clear. `always`: the vault is being turned on now.
  const dropChatPods = async (always = false) => {
    if (!store || !(always || vault.getStatus().sandboxes.isEncrypted)) return;
    const ids = store.db.prepare('SELECT id FROM conversations').all().map(row => row.id);
    await sandbox.dropChatWorkspaces?.(ids).catch(error => console.warn(`[SynthOrg] volumi delle chat non tolti: ${error.message}`));
  };
  const codeExtensions = createExtensionCatalog(ROOT);
  // The Hugging Face key is a setting like the others: read when a request to the Hub needs it.
  const localModels = new LocalModelManager({ root: ROOT, token: () => { try { return store?.getSetting('huggingface_token') || null; } catch { return null; } } });
  // The phone bridge: off until the user turns it on, closed with the app.
  // What changed in the archive, for the page and the phones to show the same thing.
  const sync = new Sync();
  const local = archiveMethods({
    port: () => server.address().port, token: sessionToken, sync,
    store: () => (vault.isLocked() ? null : store),
    // A chat deleted on a phone: its container and its files go with it, as when it is deleted here.
    onApplied: (applied) => {
      for (const change of applied) {
        if (change.t !== 'conversations' || !change.gone) continue;
        sandbox.deleteWorkspace(change.k[0]).catch(() => {});
        desktops.forget(change.k[0]).catch(() => {});
        tidy.forgetChat(change.k[0]);
      }
    }
  });
  const bridge = bridgeOverride || new Bridge({ store: () => (vault.isLocked() ? null : store), version: APP_VERSION, local });
  // Of every image of ours, the tags this build makes: the others are builds of before, removed at start (sandbox.pruneImages).
  const imageKeepers = () => {
    const endsWith = stamp => tag => Boolean(stamp) && tag.endsWith('-' + stamp);
    const studioTex = require('./studio-tex');
    const photoMl = require('./photo-ml');
    const router = require('./bridge-router');
    return [
      { repo: TOOLS_IMAGE_REPO, keep: endsWith(runtimeStamp()) },
      { repo: DESKTOP_IMAGE_REPO, keep: endsWith(desktopStamp()) },
      { repo: studioTex.STUDIO_IMAGE_REPO, keep: endsWith(studioTex.prebuiltTectonic()?.stamp) },
      { repo: photoMl.PHOTO_IMAGE_REPO, keep: endsWith(photoMl.prebuiltRembg()?.stamp) },
      { repo: router.IMAGE_NAME, keep: endsWith(bridge.router?.imageStamp?.()) }
    ];
  };
  const stopTelling = tellPhones({ bridge, sync, store: () => (vault.isLocked() ? null : store) });
  const resources = path.join(ROOT, 'resources');
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const port = server.address().port;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) fail('Host non consentito.', 403);
      const origin = req.headers.origin;
      const origins = typeof allowedOrigins === 'function' ? allowedOrigins() : allowedOrigins;
      if (origin && !LOOPBACK_ORIGIN.test(origin) && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...origins].includes(origin)) fail('Origine non consentita.', 403);
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); return res.end();
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      // Artifact links are stored relative: the port is chosen at runtime, so
      // baking an origin into the database would break every saved media link
      // as soon as the service binds a different port. The webview resolves
      // them against the storage origin it holds for the session.
      const mediaOrigin = '';
      const parts = url.pathname.split('/').filter(Boolean);
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { app: 'synthorg-storage', version: SERVER_VERSION, instance });
      if (url.pathname === '/api/shutdown' && req.method === 'POST') { if (!authorized(req, sessionToken)) fail('Token di sessione non valido.', 401); json(res, 200, { ok: true }); setTimeout(() => { try { server.close(); } catch {} process.exit(0); }, 100); return; }

      // Sandbox workspace artifact file serving (images, videos, pdfs, logs, etc.)
      if (parts[0] === 'api' && parts[1] === 'conversations' && parts[3] === 'sandbox' && parts[4] === 'files' && parts.length >= 6) {
        if (req.method !== 'GET') fail('Metodo non consentito.', 405);
        const convId = parts[2];
        const subPath = parts.slice(5).map(decodeURIComponent).join(path.sep);
        const wsDir = path.join(DATA_DIR, 'sandboxes', String(convId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36), 'workspace');
        const resolvedTarget = path.resolve(wsDir, subPath);
        if (!resolvedTarget.startsWith(wsDir + path.sep) && resolvedTarget !== wsDir) fail('Percorso non consentito.', 403);
        // A file the pod made a moment ago (a desktop still open) may not be in the copy yet.
        if (!fs.existsSync(resolvedTarget)) await sandbox.pullWorkspace?.(convId, { force: true }).catch(() => {});
        let real;
        try { real = fs.realpathSync(resolvedTarget); } catch { fail('File non trovato.', 404); }
        if (!real.startsWith(wsDir + path.sep) || !fs.statSync(real).isFile()) fail('File non trovato.', 404);
        const mime = getMimeType(real);
        const filename = path.basename(real);
        const isDownload = url.searchParams.get('download') === '1';
        const stat = fs.statSync(real);
        const fileSize = stat.size;
        const range = req.headers.range;
        if (range && !isDownload) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
          if (start >= fileSize) {
            res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
            return res.end();
          }
          const chunksize = (end - start) + 1;
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': mime
          });
          return fs.createReadStream(real, { start, end }).pipe(res);
        } else {
          res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': mime,
            'Content-Disposition': `${isDownload ? 'attachment' : 'inline'}; filename="${encodeURIComponent(filename)}"`
          });
          return fs.createReadStream(real).pipe(res);
        }
      }

      // A photo of a Foto project for the page's <img>, which carries no token: loopback and host-checked like the sandbox files above.
      if (parts[0] === 'api' && parts[1] === 'photo' && parts[3] === 'file' && parts.length === 4 && req.method === 'GET') {
        if (!store) fail('Database bloccato.', 423);
        if (!sectionEnabled(store, 'studio')) fail('La sezione Studio è spenta.', 403);
        const { full, mime } = photo.filePath(parts[2], url.searchParams.get('path'));
        const stat = fs.statSync(full);
        // A file of the folder changes under the same name (a save, a function's result): never from a cache.
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
        return fs.createReadStream(full).pipe(res);
      }
      if (parts[0] === 'api' && parts.length > 5) fail('Endpoint non trovato.', 404);
      if (parts[0] !== 'api') {
        if (req.method !== 'GET') fail('Metodo non consentito.', 405);
        const file = path.resolve(resources, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
        if (!file.startsWith(resources + path.sep)) fail('Percorso non consentito.', 403);
        let real;
        try { real = fs.realpathSync(file); } catch { fail('File non trovato.', 404); }
        if (!real.startsWith(resources + path.sep) || !fs.statSync(real).isFile()) fail('File non trovato.', 404);
        const type = getMimeType(real);
        res.writeHead(200, { 'Content-Type': type }); return res.end(fs.readFileSync(real));
      }
      if (!authorized(req, sessionToken)) fail('Token di sessione non valido.', 401);
      let input = {};
      if (['POST','PUT','PATCH'].includes(req.method)) {
        if (!req.headers['content-type']?.startsWith('application/json')) fail('Richiesta JSON necessaria.', 415);
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 50 * 1024 * 1024) fail('Richiesta troppo grande.', 413); chunks.push(chunk); }
        try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('JSON non valido.'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Oggetto JSON necessario.');
      }
      const [, resource, id, action, subaction] = parts;
      const method = req.method;
      let result;
      // Who writes: the page, or a phone through the bridge (bridge-api.js).
      const writer = /^phone:[\w-]{1,100}$/.test(req.headers['x-synthorg-origin'] || '') ? req.headers['x-synthorg-origin'] : 'desktop';
      const noted = sync.noted(method, url.pathname);
      const syncKey = noted ? sync.key(url.pathname, input) : '';

      // Security & Vault API
      if (resource === 'security') {
        if (!id && method === 'GET') {
          result = vault.getStatus();
        } else if (id === 'enable' && method === 'POST') {
          if (!input.password) fail('Password richiesta.');
          if (input.confirmPassword && input.password !== input.confirmPassword) fail('Le password non coincidono.');
          result = vault.enable(input.password, {
            targets: input.targets,
            beforeClose: () => {
              if (store) {
                try { store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
                store.close();
                store = null;
              }
            }
          });
          store = new Store(dbPath, { recover: false });
        } else if (id === 'unlock' && method === 'POST') {
          if (!input.password) fail('Password richiesta.');
          passwordGuard.check();
          try {
            result = vault.unlock(input.password);
          } catch (error) {
            if (error.status === 401) passwordGuard.fail();
            throw error;
          }
          passwordGuard.succeed();
          if (store) { try { store.close(); } catch {} }
          store = new Store(dbPath, { recover: false });
          store.recoverIncomplete();
        } else if (id === 'lock' && method === 'POST') {
          await sandbox.stopAllContainers().catch(() => {});
          await dropChatPods();
          result = vault.lock({
            beforeClose: () => {
              if (store) {
                try { store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
                store.close();
                store = null;
              }
            }
          });
          store = null;
        } else if (id === 'plan-dump' && method === 'POST') {
          // Frontend-orchestrated Rust path. mode: 'enable' when targets are
          // supplied (first-time), otherwise 'lock' (targets/salt from meta).
          const mode = input.targets ? 'enable' : 'lock';
          if (mode === 'lock') await sandbox.stopAllContainers().catch(() => {});
          if (mode === 'lock' || input.targets?.sandboxes) await dropChatPods(mode === 'enable');
          result = vault.planDump(mode, {
            targets: input.targets,
            beforeClose: () => {
              if (store) {
                try { store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
                store.close();
                store = null;
              }
            }
          });
        } else if (id === 'commit-dump' && method === 'POST') {
          result = vault.commitDump({ result: input.result, targets: input.targets, stayUnlocked: input.stayUnlocked });
          if (input.stayUnlocked) {
            store = new Store(dbPath, { recover: false });
          } else {
            store = null;
          }
        } else if (id === 'plan-undump' && method === 'POST') {
          passwordGuard.check();
          result = vault.planUndump({
            beforeClose: () => {
              if (store) { try { store.close(); } catch {} store = null; }
            }
          });
          if (result.alreadyUnlocked) {
            store = new Store(dbPath, { recover: false });
          }
        } else if (id === 'commit-undump' && method === 'POST') {
          if (input.ok) {
            passwordGuard.succeed();
            result = vault.commitUndump(true);
            store = new Store(dbPath, { recover: false });
            store.recoverIncomplete();
          } else {
            passwordGuard.fail();
            result = vault.commitUndump(false);
          }
        } else if (id === 'disable' && method === 'POST') {
          if (!input.password) fail('Password richiesta.');
          passwordGuard.check();
          result = guardPassword(() => vault.disable(input.password, {
            targets: input.targets,
            beforeClose: () => {
              if (store) {
                try { store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
                store.close();
                store = null;
              }
            }
          }));
          if (!store) store = new Store(dbPath, { recover: false });
        } else if (id === 'change-password' && method === 'POST') {
          if (!input.currentPassword) fail('Password attuale richiesta.');
          if (!input.newPassword) fail('Nuova password richiesta.');
          if (input.confirmPassword && input.newPassword !== input.confirmPassword) fail('Le nuove password non coincidono.');
          passwordGuard.check();
          result = guardPassword(() => vault.changePassword(input.currentPassword, input.newPassword, {
            beforeClose: () => {
              if (store) {
                try { store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
              }
            }
          }));
        } else fail('Endpoint non trovato.', 404);
        // The bridge keeps its keys in the database: it follows it when it is locked or unlocked.
        bridge.follow();
        // And so does what is on disk: checked against the rows when they can be read again.
        if (method === 'POST') tidyUp();
        json(res, 200, result);
        return;
      }

      // Check for database lock on data routes
      if (['conversations', 'memories', 'settings', 'import', 'projects', 'github', 'code-tools', 'bridge'].includes(resource)) {
        if (!store || vault.isLocked()) {
          fail('Il database SQLite è crittografato. Inserire la master password per sbloccarlo.', 423);
        }
      }

      // What needs only the archive is answered by its own rules, the same on the phone (archive-api.js).
      const reading = resource === 'activity' && !id && method === 'GET' ? (await projects.recordLocalSteps(), projects.recordContainerSteps()) : false;
      // The Lab's list says when each project was last changed: what was done to a folder by other means is looked at first.
      if (resource === 'projects' && !id && method === 'GET' && url.searchParams.get('section') === 'all') await projects.recordLocalSteps();
      const archived = archive.route(store, { method, parts, query: name => url.searchParams.get(name), input }, { fileThere: workspaceFile, reading });
      if (archived) {
        result = archived.result;
        // A chat deleted: its container and its files go with it.
        if (resource === 'conversations' && id && !action && method === 'DELETE') { await sandbox.deleteWorkspace(id); desktops.forget(id).catch(() => {}); tidy.forgetChat(id); }
      } else if (resource === 'conversations') {
        if (id && action === 'desktop') {
          // Computer use. A session is created waiting for the user; only the
          // user's answer (the card in the chat) starts its desktop, and no
          // setting answers for them.
          store.conversation(id);
          const sessionId = method === 'GET' ? url.searchParams.get('session') : input.sessionId;
          if (subaction === 'sessions' && method === 'POST') result = desktops.request(id, input);
          else if (subaction === 'status' && method === 'GET') result = desktops.status(id, sessionId);
          else if (subaction === 'decision' && method === 'POST') result = desktops.decide(id, sessionId, input.decision === 'allow' ? 'allow' : 'deny');
          else if (subaction === 'act' && method === 'POST') { const { sessionId: _, ...action } = input; result = await desktops.act(id, sessionId, action); }
          else if (subaction === 'end' && method === 'POST') result = await desktops.end(id, sessionId, { stopped: Boolean(input.stopped) });
          else if (subaction === 'screen' && method === 'GET') {
            const width = Math.max(320, Math.min(parseInt(url.searchParams.get('w'), 10) || 1280, 1920));
            const picture = await desktops.screen(id, sessionId, width);
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
            return res.end(picture);
          } else fail('Percorso non trovato.', 404);
        }
        else if (id && action === 'sandbox') {
          if (!subaction && method === 'GET') result = await sandbox.getStatus(id, store.conversation(id));
          else if (!subaction && method === 'PATCH') {
            // Rejected here as well as at container creation, so an invalid
            // reference never reaches the database in the first place.
            const requestedImage = input.image === undefined ? undefined : assertSafeImage(input.image);
            store.updateConversation(id, { sandboxNetwork: input.networkEnabled, sandboxTerminal: input.terminalEnabled, sandboxDesktop: input.desktopEnabled, sandboxImage: requestedImage });
            result = await sandbox.getStatus(id, store.conversation(id));
          } else if (subaction === 'reset' && method === 'POST') {
            store.conversation(id);
            result = await sandbox.resetContainer(id);
          } else if (subaction === 'stop' && method === 'POST') {
            store.conversation(id);
            result = await sandbox.stopContainer(id);
          } else if (subaction === 'interrupt' && method === 'POST') {
            // The stop button: the command still running for this chat ends, with its whole process tree.
            store.conversation(id);
            result = await sandbox.interrupt(id, String(input.runId || ''));
          } else if (subaction === 'exec' && method === 'POST') {
            const conv = store.conversation(id);
            // A chat that belongs to a Code project runs where that project's
            // code is, not in a sandbox of its own that knows nothing about it.
            const owner = conv.project_id ? store.project(conv.project_id) : null;
            if (owner && owner.kind !== 'podman') {
              fail(`Il progetto "${owner.name}" gira nella tua cartella, non in un container: da qui non si eseguono comandi.`, 409);
            }
            const inProject = owner ? await sandbox.ensureProjectRunning(owner) : null;
            const runId = typeof input.runId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(input.runId) ? input.runId : randomUUID();
            // Whoever asked is gone (page reloaded, app closing): nobody will read
            // the result, so the command ends instead of running on unseen.
            res.on('close', () => { if (!res.writableEnded) sandbox.interruptRun?.(runId, 'interrupted:disconnect').catch(() => {}); });
            const execute = async () => {
              const ran = await sandbox.execute(id, input.command, {
                networkEnabled: Boolean(owner ? owner.network : conv.sandbox_network),
                image: owner ? owner.image : conv.sandbox_image,
                timeoutMs: input.timeoutMs,
                runId,
                containerName: inProject
              });
              // What the command changed in the project is the model's step, not the next save's.
              if (owner) await projects.recordCommand(owner, input.command).catch(() => {});
              return ran;
            };
            // In a project the command is the model's, and the project's
            // terminal mode says whether it runs now or waits for the user.
            result = owner ? await permissions.gate(owner, 'terminal', { command: input.command, cwd: input.cwd, runId }, execute) : await execute();
          } else if (subaction === 'project-files') {
            // Files of a project copied into this chat's workspace, or those copies taken away
            // (the assistant's tasks: resources/js/realtime-liaison.js). The project is not started.
            store.conversation(id);
            const copiesDir = path.join(DATA_DIR, 'sandboxes', String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36), 'workspace');
            fs.mkdirSync(copiesDir, { recursive: true });
            if (method === 'POST') {
              result = await codeTools.copyTo(String(input.projectId || ''), copiesDir, input.paths);
              // Into the pod, where the assistant's task will read them.
              await sandbox.pushWorkspace?.(id, [result.folder]).catch(error => console.warn(`[SynthOrg] copie non portate nel pod: ${error.message}`));
            } else if (method === 'DELETE') {
              result = codeTools.clearCopies(copiesDir);
              await sandbox.removeFromWorkspace?.(id, COPIES_DIR).catch(() => {});
            } else fail('Metodo non consentito.', 405);
          } else if (subaction === 'copy' && method === 'POST') {
            // From another chat into this one, on the user's request: some files of its
            // workspace (`paths`), or its whole pod — every file, its image and its network
            // switch. What the model may do here (terminal, computer use) stays this chat's.
            store.conversation(id);
            const source = store.conversation(String(input.sourceId || ''));
            if (source.id === id) fail('La chat di origine è questa stessa chat.');
            const workspaceOf = chatId => path.join(DATA_DIR, 'sandboxes', String(chatId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36), 'workspace');
            const from = workspaceOf(source.id), to = workspaceOf(id);
            fs.mkdirSync(from, { recursive: true });
            fs.mkdirSync(to, { recursive: true });
            const fromReal = fs.realpathSync(from);
            if (Array.isArray(input.paths)) {
              const copied = [];
              for (const wanted of input.paths.slice(0, 500)) {
                // A link planted by a container must not carry a file of the computer in here.
                let real;
                try { real = fs.realpathSync(path.resolve(from, String(wanted))); } catch { continue; }
                if (!real.startsWith(fromReal + path.sep) || !fs.statSync(real).isFile()) continue;
                const base = path.basename(real).replace(/[^a-zA-Z0-9._-]/g, '_');
                const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
                let name = base;
                for (let n = 2; fs.existsSync(path.join(to, name)); n++) name = `${stem}-${n}${ext}`;
                fs.copyFileSync(real, path.join(to, name));
                copied.push({ name, category: getFileCategory(path.join(to, name)), url: `${mediaOrigin}/api/conversations/${encodeURIComponent(id)}/sandbox/files/${encodeURIComponent(name)}` });
              }
              if (copied.length) await sandbox.pushWorkspace?.(id, copied.map(item => item.name)).catch(error => console.warn(`[SynthOrg] file non portati nel pod: ${error.message}`));
              result = { copied };
            } else {
              let files = 0;
              fs.cpSync(fromReal, to, {
                recursive: true, force: true,
                filter: entry => { const stat = fs.lstatSync(entry); if (stat.isSymbolicLink()) return false; if (stat.isFile()) files++; return true; }
              });
              store.updateConversation(id, { sandboxNetwork: Boolean(source.sandbox_network), sandboxImage: source.sandbox_image || 'alpine:latest' });
              // Its container is made again, from the image just taken, the next time it is needed;
              // the files taken go into its volume now.
              await sandbox.resetContainer(id);
              await sandbox.pushWorkspace?.(id, null).catch(error => console.warn(`[SynthOrg] file non portati nel pod: ${error.message}`));
              result = { files, status: await sandbox.getStatus(id, store.conversation(id)) };
            }
          } else if (subaction === 'files') {
            store.conversation(id);
            const wsDir = path.join(DATA_DIR, 'sandboxes', String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36), 'workspace');
            fs.mkdirSync(wsDir, { recursive: true });
            if (method === 'GET') {
              // What the pod wrote since the last look is in the copy first.
              await sandbox.pullWorkspace?.(id).catch(() => {});
              const reqCategory = url.searchParams.get('category');
              const listFilesRecursive = (dir, relPrefix = '') => {
                let items = [];
                let entries = [];
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
                for (const entry of entries) {
                  // Ignore hidden files and internal TTS speech audio cache
                  if (entry.name.startsWith('.') || entry.name.startsWith('tts_') || entry.name.startsWith('_tts_')) continue;
                  const full = path.join(dir, entry.name);
                  const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
                  if (entry.isDirectory()) {
                    items = items.concat(listFilesRecursive(full, rel));
                  } else if (entry.isFile()) {
                    try {
                      const stat = fs.statSync(full);
                      const mime = getMimeType(full);
                      const category = getFileCategory(full);
                      if (!reqCategory || reqCategory === 'all' || category === reqCategory) {
                        items.push({
                          name: entry.name,
                          path: rel,
                          size: stat.size,
                          mtime: stat.mtimeMs,
                          mime,
                          category,
                          url: `${mediaOrigin}/api/conversations/${encodeURIComponent(id)}/sandbox/files/${rel.split('/').map(encodeURIComponent).join('/')}`
                        });
                      }
                    } catch {}
                  }
                }
                return items;
              };
              const files = listFilesRecursive(wsDir);
              files.sort((a, b) => b.mtime - a.mtime);
              result = { files, total: files.length };
            } else if (method === 'POST') {
              if (!input.filename) fail('Nome file richiesto.');
              const safeFilename = path.basename(String(input.filename).replace(/[^a-zA-Z0-9._-]/g, '_'));
              if (!safeFilename || safeFilename === '.' || safeFilename === '..') fail('Nome file non valido.');
              const targetPath = path.join(wsDir, safeFilename);

              let fileSize = 0;
              if (input.downloadUrl) {
                const fetchRes = await fetch(input.downloadUrl, {
                  headers: input.downloadHeaders || {}
                });
                if (!fetchRes.ok) fail(`Errore download da ${input.downloadUrl}: ${fetchRes.status}`);
                const arrayBuf = await fetchRes.arrayBuffer();
                const nodeBuf = Buffer.from(arrayBuf);
                fs.writeFileSync(targetPath, nodeBuf);
                fileSize = nodeBuf.length;
              } else {
                if (input.content === undefined || input.content === null) fail('Contenuto file o downloadUrl richiesto.');
                const encoding = input.encoding === 'utf-8' || input.encoding === 'utf8' ? 'utf8' : 'base64';
                const buf = Buffer.from(input.content, encoding);
                // A large file arrives in pieces: the first writes it, the others add to it.
                if (input.append === true) fs.appendFileSync(targetPath, buf);
                else fs.writeFileSync(targetPath, buf);
                fileSize = fs.statSync(targetPath).size;
              }
              // A file put in the copy from this side reaches the pod, where the model works.
              if (input.append !== true || input.last === true) await sandbox.pushWorkspace?.(id, [safeFilename]).catch(error => console.warn(`[SynthOrg] file non portato nel pod: ${error.message}`));
              const mime = getMimeType(targetPath);
              const category = getFileCategory(targetPath);
              result = {
                ok: true,
                filename: safeFilename,
                url: `${mediaOrigin}/api/conversations/${encodeURIComponent(id)}/sandbox/files/${encodeURIComponent(safeFilename)}`,
                size: fileSize,
                mime,
                category
              };
            } else fail('Metodo non consentito.', 405);
          } else if (subaction === 'publish' && method === 'POST') {
            store.conversation(id);
            const wsDir = path.join(DATA_DIR, 'sandboxes', String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36), 'workspace');
            fs.mkdirSync(wsDir, { recursive: true });
            if (!input.path) fail('Percorso del file o cartella richiesto.');
            const normalizedSub = path.normalize(String(input.path).trim()).replace(/^(\.\.[\/\\])+/, '');
            const requestedPath = path.resolve(wsDir, normalizedSub);
            if (!fs.existsSync(requestedPath)) fail(`File o cartella non trovata: ${input.path}`, 404);

            // The container has the workspace bind-mounted read-write and runs as
            // root, so it can plant a symlink or junction pointing anywhere on the
            // host. A textual comparison accepts it, and the archiver then copies
            // the target back inside the workspace, where it becomes downloadable.
            // Both sides go through realpath, and the boundary carries the
            // separator so a sibling directory sharing the prefix cannot pass.
            let targetPath;
            let workspaceReal;
            try {
              workspaceReal = fs.realpathSync(wsDir);
              targetPath = fs.realpathSync(requestedPath);
            } catch { fail(`File o cartella non trovata: ${input.path}`, 404); }
            if (targetPath !== workspaceReal && !targetPath.startsWith(workspaceReal + path.sep)) {
              fail('Percorso non consentito fuori dal workspace.', 403);
            }

            const stat = fs.statSync(targetPath);
            const isDir = stat.isDirectory();
            const shouldZip = Boolean(input.as_zip) || isDir;

            let artifactFilename;
            let artifactPath;

            if (shouldZip) {
              const baseName = path.basename(targetPath).replace(/[^a-zA-Z0-9._-]/g, '_');
              artifactFilename = `artifact_${baseName}_${Date.now()}.zip`;
              artifactPath = path.join(workspaceReal, artifactFilename);
              await createZipArchive(targetPath, artifactPath);
            } else {
              artifactFilename = path.basename(targetPath);
              artifactPath = targetPath;
            }

            const artifactStat = fs.statSync(artifactPath);
            const relPath = path.relative(workspaceReal, artifactPath).replace(/\\/g, '/');
            const mime = getMimeType(artifactPath);
            const category = getFileCategory(artifactPath);
            const urlPath = `${mediaOrigin}/api/conversations/${encodeURIComponent(id)}/sandbox/files/${relPath.split('/').map(encodeURIComponent).join('/')}`;
            const title = input.title || artifactFilename;

            let markdown = '';
            if (category === 'image') {
              markdown = `![${title}](${urlPath})`;
            } else if (category === 'video') {
              markdown = `![video:${title}](${urlPath})`;
            } else {
              markdown = `[file:${title}|${urlPath}]`;
            }

            result = {
              ok: true,
              filename: artifactFilename,
              path: relPath,
              url: urlPath,
              size: artifactStat.size,
              mime,
              category,
              title,
              markdown
            };
          } else fail('Endpoint non trovato.', 404);
        } else if (id && action === 'tools') {
          const conv = store.conversation(id);
          if (subaction === 'web-search' && method === 'POST') {
            if (!conv.sandbox_network) {
              fail('Accesso a Internet non consentito: l’ambiente di questa chat è impostato su Isolato (Offline). Abilita la rete dal pannello Ambiente Chat.', 403);
            }
            result = await performWebSearch(input.query, { maxResults: input.maxResults || 5, page: input.page || 1 });
          } else if (subaction === 'web-browse' && method === 'POST') {
            if (!conv.sandbox_network) {
              fail('Accesso a Internet non consentito: l’ambiente di questa chat è impostato su Isolato (Offline). Abilita la rete dal pannello Ambiente Chat.', 403);
            }
            if (!input.url) fail('URL richiesto per la navigazione web.');
            result = await fetchPageContent(input.url, { maxChars: input.maxChars || 8000 });
          } else if (subaction === 'check-network' && method === 'GET') {
            result = { networkEnabled: Boolean(conv.sandbox_network) };
          } else fail('Endpoint non trovato.', 404);
        } else fail('Endpoint non trovato.', 404);
      } else if (resource === 'packages') {
        if (!id && method === 'GET') result = packageManager.list();
        else if (id === 'scan' && method === 'POST') result = await packageManager.scan();
        else if (id && method === 'PATCH') result = packageManager.toggleDefault(id, input.isDefault);
        else fail('Endpoint non trovato.', 404);

      // The editor extensions of a coding project: listed and switched off
      // here like any other thing the environment may carry.
      } else if (resource === 'code-extensions') {
        if (!id && method === 'GET') result = codeExtensions.summary();
        else if (id && method === 'PATCH') result = codeExtensions.setEnabled(id, input.enabled !== false);
        else fail('Endpoint non trovato.', 404);
      } else if (resource === 'local-models') {
        const asked = (name) => url.searchParams.get(name) || '';
        if (!id && method === 'GET') result = await localModels.list();
        else if (id === 'loaded' && method === 'GET') result = localModels.loaded();
        else if (id === 'start' && method === 'POST') result = await localModels.start(input.id, { parallel: input.parallel });
        // `idle`: only if it is doing nothing — what frees a model by itself (the page's keeper) never cuts an answer.
        else if (id === 'stop' && method === 'POST') {
          if (input.idle && input.id && await localModels.busy(input.id)) result = { stopped: false, busy: true };
          else { await localModels.stop(input.id || undefined); result = { stopped: true }; }
        }
        else if (id === 'launch' && method === 'POST') result = await localModels.setLaunch(input.id, input);
        else if (id === 'remove' && method === 'POST') result = await localModels.remove(input.id);
        // The Hugging Face browser: repositories, their files, downloads.
        else if (id === 'hub' && method === 'GET') result = await localModels.hub.search({ query: asked('q'), sort: asked('sort'), kind: asked('kind'), size: asked('size'), license: asked('license'), author: asked('author'), access: asked('access'), cursor: asked('cursor') });
        else if (id === 'repo' && method === 'GET') result = await localModels.hub.repo(asked('id'));
        else if (id === 'downloads' && !action && method === 'GET') result = { downloads: localModels.downloads.list() };
        else if (id === 'downloads' && action === 'start' && method === 'POST') result = await localModels.downloads.start(input.repo, input.path);
        else if (id === 'downloads' && action === 'resume' && method === 'POST') result = localModels.downloads.resume(input.id);
        else if (id === 'downloads' && action === 'stop' && method === 'POST') result = localModels.downloads.cancel(input.id);
        else if (id === 'downloads' && action === 'discard' && method === 'POST') result = localModels.downloads.discard(input.id);
        else fail('Endpoint non trovato.', 404);
      // What the models cost and how they do: written as each request ends,
      // read by the projects' cards and by the Realtime section. Sharing the
      // numbers is asked of the user each time, and only with somewhere to send.
      } else if (resource === 'usage') {
        const usage = store.usage();
        const profiles = async () => {
          const found = {};
          const wanted = new Set(usage.shareProjects());
          for (const project of store.listProjects().filter(p => wanted.has(p.id))) { try { found[project.id] = await projects.profile(project); } catch {} }
          return found;
        };
        if (id === 'share' && action === 'package' && method === 'GET') result = usage.sharePackage({ until: url.searchParams.get('until'), profiles: await profiles(), app: APP_VERSION });
        else if (id === 'share' && !action && method === 'POST') {
          // What goes is worked out here, again, from the rows: never what the page says it is.
          const built = usage.sharePackage({ until: input.until, profiles: await profiles(), app: APP_VERSION });
          if (input.answer === 'share') {
            const endpoint = usage.endpoint();
            if (!endpoint) fail('Non c’è ancora un indirizzo a cui condividere.', 409);
            let sent;
            try {
              sent = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(built.package), signal: AbortSignal.timeout(30000) });
            } catch (error) {
              fail(`Invio non riuscito: ${error.message}. I dati restano su questo computer.`, 502);
            }
            if (!sent.ok) fail(`Invio non riuscito (${sent.status}). I dati restano su questo computer.`, 502);
            result = usage.answerShare({ answer: 'shared', ...built });
          } else if (input.answer === 'decline') {
            result = usage.answerShare({ answer: 'declined', ...built, package: null });
          } else fail('Risposta non valida.');
        }
        else fail('Endpoint non trovato.', 404);
      } else if (resource === 'projects') {
        if (!id && method === 'POST') result = await projects.create(input);
        else if (id && !action && method === 'GET') result = store.project(id);
        else if (id && !action && method === 'PATCH') result = projects.update(id, input);
        else if (id && !action && method === 'DELETE') {
          result = await projects.remove(id);
          for (const chat of result.chats) { desktops.forget(chat).catch(() => {}); tidy.forgetChat(chat); }
        }
        else if (id && action === 'open' && !subaction && method === 'POST') result = await projects.open(id);
        // Which step that open is on: the page polls it while the request above
        // is still running, so its progress bar says something true.
        else if (id && action === 'progress' && !subaction && method === 'GET') result = projects.progress(id);
        else if (id && action === 'git' && !subaction && method === 'GET') result = await projects.gitStatus(id);
        else if (id && action === 'archive' && !subaction && method === 'GET') {
          // The project as a zip, bytes to the page, which saves them where downloads go.
          const { bytes } = await projects.archive(id);
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
          return res.end(bytes);
        }
        // Everything reaching the server over HTTP is the user acting on his
        // own projects; a model only ever gets there through an agent of its
        // own, which asks with actor 'agent' and is held to fewer operations.
        else if (id && action === 'git' && subaction && method === 'POST') result = await projects.gitAction(id, subaction, input, 'user');
        // The history read back like a repository page, and a file or the
        // whole project taken back to one of its steps (itself a new step).
        else if (id && action === 'history' && !subaction && method === 'GET') {
          result = await projects.history(id, { limit: url.searchParams.get('limit'), skip: url.searchParams.get('skip'), path: url.searchParams.get('path') });
        }
        else if (id && action === 'history' && subaction === 'commit' && method === 'GET') result = await projects.historyCommit(id, url.searchParams.get('hash'));
        else if (id && action === 'history' && subaction === 'tree' && method === 'GET') result = await projects.historyTree(id, url.searchParams.get('hash'));
        else if (id && action === 'history' && subaction === 'file' && method === 'GET') result = await projects.historyFile(id, url.searchParams.get('hash'), url.searchParams.get('path'));
        else if (id && action === 'history' && subaction === 'restore' && method === 'POST') result = await projects.restore(id, { hash: input.hash, path: typeof input.path === 'string' ? input.path : null });
        // The model's hands on the project: six tools, each one recorded as it
        // lands. What they are is public, so the chat can declare them.
        // The column of the files, the page's own: the folders open in it, a search by name, and what the user does to the files there.
        else if (id && action === 'files' && !subaction && method === 'GET') {
          let dirs = [''];
          try { dirs = JSON.parse(url.searchParams.get('dirs') || '[""]'); } catch { fail('Elenco delle cartelle non valido.'); }
          result = await projectFiles.list(id, dirs);
        }
        else if (id && action === 'files' && subaction === 'search' && method === 'GET') result = await projectFiles.search(id, url.searchParams.get('q'));
        // One file as it is now, and a file written whole (a change made by hand, a file brought from the phone): the user's step.
        else if (id && action === 'files' && subaction === 'read' && method === 'GET') result = await projectFiles.read(id, url.searchParams.get('path'));
        else if (id && action === 'files' && subaction === 'write' && method === 'POST') result = await projectFiles.write(id, input);
        // One artifact, small enough to be looked at where the files of the computer cannot be reached (the phone).
        else if (id && action === 'artifacts' && subaction === 'read' && method === 'GET') result = projectFiles.readArtifact(id, url.searchParams.get('path'));
        // The artifacts: what is worked on at this computer, apart from the files of a pod's project.
        else if (id && action === 'artifacts' && !subaction && method === 'GET') result = await projectFiles.artifacts(id);
        else if (id && action === 'artifacts' && subaction === 'file' && method === 'GET') {
          const { full, size } = projectFiles.artifactFile(id, url.searchParams.get('path'));
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-store' });
          return fs.createReadStream(full).pipe(res);
        }
        else if (id && action === 'artifacts' && !subaction && method === 'POST') result = await projectFiles.changeArtifact(id, input);
        else if (id && action === 'files' && !subaction && method === 'POST') result = await projectFiles.change(id, input);
        else if (id && action === 'tree' && !subaction && method === 'GET') result = await codeTools.tree(id);
        else if (id && action === 'pointers' && !subaction && method === 'GET') result = await codeTools.pointers(id);
        else if (id && action === 'tools' && subaction && method === 'POST') {
          // The project's code mode decides whether the change lands now or
          // waits for the user; a read never waits.
          const project = store.project(id);
          result = await permissions.gate(project, 'code', { name: subaction, input }, () => codeTools.run(id, subaction, input));
        }
        // A command on a local project runs in the editor's terminal, on this
        // machine, from the page: here only the permission is settled. The
        // answer is either a go or the request to put in front of the user.
        else if (id && action === 'terminal' && subaction === 'gate' && method === 'POST') {
          const project = store.project(id);
          if (typeof input.command !== 'string' || !input.command.trim()) fail('Comando mancante.');
          result = await permissions.gate(project, 'terminal', { command: input.command, cwd: input.cwd }, async () => ({ allowed: true }));
        }
        // ...and once it has run there, what it changed is recorded as the model's step.
        else if (id && action === 'terminal' && subaction === 'record' && method === 'POST') {
          if (typeof input.command !== 'string' || !input.command.trim()) fail('Comando mancante.');
          result = await projects.recordCommand(store.project(id), input.command);
        }
        // The user's answer to a pending request, the list of what was
        // approved in semi mode, and forgetting entries of it.
        else if (id && action === 'approvals' && !subaction && method === 'GET') result = { modes: permissions.modes(store.project(id)), remembered: permissions.list(id), pending: permissions.pendingFor(id) };
        else if (id && action === 'approvals' && subaction && method === 'POST') {
          // An approved command runs while this request waits: if it goes away, the command ends.
          const runId = permissions.runIdOf(subaction);
          if (runId) res.on('close', () => { if (!res.writableEnded) sandbox.interruptRun?.(runId, 'interrupted:disconnect').catch(() => {}); });
          result = await permissions.decide(id, subaction, input.decision === 'allow' ? 'allow' : 'deny');
        }
        else if (id && action === 'approvals' && subaction === 'all' && method === 'DELETE') result = { removed: permissions.forgetAll(id) };
        else if (id && action === 'approvals' && subaction && method === 'DELETE') { permissions.forget(id, subaction); result = { removed: 1 }; }
        else fail('Endpoint non trovato.', 404);
      // Where the memory of the app is kept, and the asking for it to be moved (done at the next start: memory.js).
      } else if (resource === 'memory') {
        if (!id && method === 'GET') result = memory.status(memoryData);
        else if (!id && method === 'POST') result = memory.plan(input.dir ?? null, memoryData);
        else if (!id && method === 'DELETE') result = memory.cancel(memoryData);
        // The copies of the pods' projects kept in it: whether they are made, and how each one's last went.
        else if (id === 'copies' && !action && method === 'GET') result = projects.memoryCopies();
        else if (id === 'copies' && !action && method === 'POST') { result = projects.setMemoryCopies(input.on !== false); if (inMemory) memory.tellPodsCopied(result.on); }
        else fail('Endpoint non trovato.', 404);
      // The runtime of the pods: its disk, and the compaction of it (every pod stopped for it).
      } else if (resource === 'runtime') {
        if (id === 'disk' && !action && method === 'GET') result = await sandbox.runtimeDisk();
        else if (id === 'disk' && action === 'compact' && method === 'POST') {
          desktops.stopAll();
          result = await sandbox.compactRuntime();
        }
        else fail('Endpoint non trovato.', 404);
      } else if (resource === 'code-tools') {
        if (!id && method === 'GET') result = { tools: toolSpecs() };
      // The Studio: the TeX packages (one download, started by the user), then
      // everything of one project — its chapters, the two sheets, the map the
      // model reads, the model's tools behind the same gate as the code, the
      // typeset document and its export.
      } else if (resource === 'studio') {
        studio.ensureTables();
        if (id === 'tex' && !action && method === 'GET') result = await studio.texStatus();
        else if (id === 'tex' && action === 'warm' && method === 'POST') result = studio.startWarm();
        else if (id === 'tex' && !action && method === 'DELETE') result = await require('./studio-tex').dropCache();
        else if (id && action === 'init' && method === 'POST') result = await studio.init(studio.project(id), input);
        else if (id && !action && method === 'GET') result = studio.overview(id);
        else if (id && !action && method === 'PATCH') result = await studio.setSettings(id, input);
        else if (id && action === 'focus' && method === 'POST') result = studio.setFocus(id, input.chapter);
        else if (id && action === 'chapters' && subaction && method === 'GET') result = studio.chapter(id, subaction);
        else if (id && action === 'chapters' && subaction && method === 'PUT') result = await studio.saveDraft(id, subaction, input);
        else if (id && action === 'chapters' && subaction && method === 'PATCH') result = await studio.editClean(id, subaction, input);
        else if (id && action === 'chapters' && subaction && method === 'POST') {
          if (input.op === 'request') result = { request: studio.cleanupRequest(id, subaction, { limit: Number(input.limit) || undefined }) };
          else if (input.op === 'apply') result = await studio.applyCleanup(id, subaction, input);
          else fail('Operazione non valida: request o apply.');
        }
        else if (id && action === 'chapter' && !subaction && method === 'POST') result = await studio.chapterAction(id, input, 'user');
        else if (id && action === 'context' && !subaction && method === 'GET') result = studio.context(id);
        else if (id && action === 'tree' && !subaction && method === 'GET') result = studio.tree(id);
        else if (id && action === 'pending' && !subaction && method === 'GET') result = studio.pending(id, { limit: Number(url.searchParams.get('limit')) || undefined });
        else if (id && action === 'nodes' && !subaction && method === 'POST') result = studio.addNode(id, input);
        else if (id && action === 'nodes' && subaction && method === 'GET') result = studio.open(id, subaction);
        else if (id && action === 'tools' && subaction && method === 'POST') {
          // The same gate as the code tools: the project's own mode, or, for a
          // Studio project that has none, the Studio's default (automatic: the
          // user asked the chat for the change).
          const project = studio.project(id);
          const fallback = store.getSetting('studio_perm_text');
          const gated = project.perm_code ? project : { ...project, perm_code: ['manual', 'semi', 'auto'].includes(fallback) ? fallback : 'auto' };
          result = await permissions.gate(gated, 'code', { name: subaction, input }, () => studio.run(id, subaction, input));
        }
        else if (id && action === 'compile' && !subaction && method === 'POST') result = studio.startCompile(id);
        else if (id && action === 'compile' && !subaction && method === 'GET') result = studio.compileStatus(id);
        else if (id && action === 'compile' && subaction === 'log' && method === 'GET') result = studio.compileLog(id);
        else if (id && action === 'pdf' && !subaction && method === 'GET') {
          // The rendering itself, bytes to the page: the one answer here that is not JSON.
          const pdf = studio.pdfPath(id);
          if (!pdf) fail('Nessun PDF: impagina prima il documento.', 404);
          const stat = fs.statSync(pdf);
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': stat.size, 'Content-Disposition': 'inline; filename="documento.pdf"' });
          return fs.createReadStream(pdf).pipe(res);
        }
        else if (id && action === 'export' && !subaction && method === 'POST') result = await studio.exportDocument(id, input);
        else fail('Endpoint non trovato.', 404);
      // The Studio's Foto tab. The state is readable with the section off; everything else is refused then.
      } else if (resource === 'photo') {
        if (id === 'status' && !action && method === 'GET') result = photocraft.status();
        else if (!sectionEnabled(store, 'studio')) fail('La sezione Studio è spenta.', 403);
        else if (id === 'status' && action === 'check' && method === 'POST') result = await photocraft.checkLatest();
        else if (id === 'models' && !action && method === 'GET') result = await photo.modelsStatus();
        else if (id === 'models' && action === 'warm' && method === 'POST') result = photo.startWarm(input.model);
        else if (id === 'models' && !action && method === 'DELETE') result = await require('./photo-ml').dropCache();
        // The user's own models, from Hugging Face: searched, added (downloaded by the inert channel), tuned, removed.
        else if (id === 'onnx' && !action && method === 'GET') result = photo.userModelsStatus();
        else if (id === 'onnx' && action === 'search' && method === 'GET') result = await localModels.hub.searchOnnx({ query: url.searchParams.get('q') || '', sort: url.searchParams.get('sort') || '', cursor: url.searchParams.get('cursor') || '' });
        else if (id === 'onnx' && action === 'repo' && method === 'GET') result = await localModels.hub.repoOnnx(url.searchParams.get('id') || '');
        else if (id === 'onnx' && action === 'add' && method === 'POST') result = await photo.addUserModel(input);
        else if (id === 'onnx' && action === 'model' && method === 'PATCH') result = photo.setUserModel(String(input.key || ''), input);
        else if (id === 'onnx' && action === 'model' && method === 'DELETE') result = await photo.removeUserModel(url.searchParams.get('key') || '');
        else if (id && action === 'init' && method === 'POST') { await photo.init(photo.project(id), input); result = photo.overview(id); }
        else if (id && !action && method === 'GET') result = photo.overview(id);
        else if (id && !action && method === 'PATCH') result = await photo.setSettings(id, input);
        // What the editor saved, into the folder: a step of the record.
        else if (id && action === 'write' && !subaction && method === 'POST') {
          if (typeof input.content !== 'string') fail('Contenuto mancante.');
          result = await photo.writeFile(id, input.path, Buffer.from(input.content, 'base64'), { source: input.source === 'agent' ? 'agent' : 'user', tool: input.source === 'agent' ? 'photo_save' : null });
        }
        else if (id && action === 'context' && !subaction && method === 'GET') result = photo.context(id);
        else if (id && action === 'tools' && subaction && method === 'POST') {
          // The same gate as the code tools: the folder's own mode, or the Foto default (automatic: the user asked in chat; overwriting asks anyway).
          const project = photo.project(id);
          const gated = project.perm_code ? project : { ...project, perm_code: photo.permOf(project) };
          result = await permissions.gate(gated, 'code', { name: subaction, input }, () => photo.run(id, subaction, input));
        }
        else if (id && action === 'functions' && subaction === 'remove-background' && method === 'POST') result = photo.startRemoveBackground(id, input.path, { scratch: input.scratch === true, box: Array.isArray(input.box) && input.box.length === 4 && input.box.every(Number.isFinite) ? input.box : null });
        else if (id && action === 'job' && !subaction && method === 'GET') result = photo.jobStatus(id);
        else fail('Endpoint non trovato.', 404);

      } else if (resource === 'github') {
        if (!id && method === 'GET') result = github.status();
        else if (!id && method === 'DELETE') result = github.disconnect();
        else if (id === 'connect' && method === 'POST') result = await github.startConnect();
        else if (id === 'install' && method === 'POST') result = await github.startInstall();
        else if (id === 'repositories' && method === 'GET') result = await github.listRepositories();
        // A repository's branches, for choosing which one a project follows before it exists.
        else if (id === 'branches' && method === 'GET') {
          const repo = await github.getRepository(url.searchParams.get('repo'));
          result = { defaultBranch: repo.default_branch, branches: await github.listBranches(repo.full_name) };
        }
        else fail('Endpoint non trovato.', 404);
      // The phone bridge: turned on and off, a phone paired or removed, and
      // what passes between the phones and the page.
      } else if (resource === 'bridge') {
        if (!id && method === 'GET') result = await bridge.fullStatus();
        else if (!id && method === 'PUT') result = await bridge.configure(input);
        // The app's window closed with the app going on, or back: which of the two switches counts.
        else if (id === 'window' && method === 'PUT') result = bridge.setWindow(input.open);
        else if (id === 'pairing' && method === 'POST') result = await bridge.openPairing();
        else if (id === 'pairing' && method === 'DELETE') result = await bridge.closePairing();
        else if (id === 'inbox' && method === 'GET') {
          let gone = () => {};
          res.on('close', () => { if (!res.writableEnded) gone(); });
          result = await bridge.inbox(Number(url.searchParams.get('wait')) || 0, stop => { gone = stop; });
        }
        else if (id === 'send' && method === 'POST') result = await bridge.send(input);
        else if (id === 'forget' && method === 'POST') result = await bridge.forget();
        else if (id === 'devices' && action && method === 'PATCH') result = bridge.renameDevice(action, input.name);
        else if (id === 'devices' && action && method === 'DELETE') result = await bridge.removeDevice(action);
        else fail('Endpoint non trovato.', 404);
      // What was written since a number: the page waits here for what the phones change.
      } else if (resource === 'changes') {
        if (!id && method === 'GET') {
          let gone = () => {};
          res.on('close', () => { if (!res.writableEnded) gone(); });
          result = await sync.wait(url.searchParams.get('epoch') || '', url.searchParams.get('after'), Number(url.searchParams.get('wait')) || 0, stop => { gone = stop; });
        } else fail('Endpoint non trovato.', 404);
      } else fail('Endpoint non trovato.', 404);
      if (noted) sync.record({ method, path: url.pathname, key: syncKey, origin: writer, result });
      json(res, 200, result);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Impossibile completare l’operazione sul database.' });
      else res.end();
      if (!error.status) console.error(error);
    }
  });
  // Everything the service started, stopped, and waited for: the phone
  // bridge and its router, the containers of chats, projects and computer
  // use, the local models. Nothing it started outlives it.
  let closing = null;
  const closeAll = () => {
    if (!closing) {
      closing = (async () => {
        stopTelling();
        github.close();
        localModels.close();
        projects.stopWatching();
        projects.stopSyncs();
        desktops.stopAll();
        tidy.flush();
        await Promise.allSettled([(bridge.shutdown || bridge.stop).call(bridge), sandbox.stopAllContainers()]);
        if (store) {
          try { store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
          try { store.close(); } catch {}
        }
      })();
    }
    return closing;
  };
  server.on('close', () => { closeAll(); });
  server.once('listening', () => {
    if (store) store.recoverIncomplete();
    tidyUp();
    if (inMemory && store) memory.tellPodsCopied(projects.copyOn());
    bridge.follow();
    // The runtime of the pods boots now, while the page loads, instead of at the first command; then the images of
    // earlier builds go. Only the app's own service: never a server made by the tests.
    if (warmRuntime) sandbox.warmEngine?.({ keepers: imageKeepers() }).catch(error => console.warn(`[SynthOrg] runtime dei pod non preparato: ${error.message}`));
  });
  return { server, get store() { return store; }, vault, bridge, sync, closeAll, sandbox };
}
if (require.main === module) {
  if (!process.env.SYNTHORG_TOKEN) {
    console.warn('[SynthOrg] SYNTHORG_TOKEN assente: l’archivio genera un token effimero e l’interfaccia non potrà autenticarsi. Avvia l’app con "npm start".');
  }
  // Before anything is open: a move of the memory that was asked for is carried out; a memory that is not where it
  // should be stops the start here, with the reason, and is never replaced by an empty one.
  const settled = memory.settle(DATA_DIR, { log: message => console.log(`[SynthOrg] ${message}`) });
  if (settled.missing) {
    console.error(`[SynthOrg] La memoria non è raggiungibile: ${settled.dir}. Collega il disco o la cartella dove l'hai messa e riavvia.`);
    process.exit(1);
  }
  const { server, closeAll, sandbox } = createApp({ warmRuntime: true });

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    try { server.close(); } catch {}
    server.closeAllConnections?.();
    // Containers and router are stopped and waited for; if the engine hangs,
    // the service leaves anyway (the shell gives it a little longer, then ends it).
    const deadline = setTimeout(() => process.exit(0), 20000);
    // Only the app's own process, when it ends, stops the WSL runtime: never a
    // server made by the tests, which would stop it under a running app.
    closeAll()
      .then(() => sandbox.shutdownRuntime?.())
      .catch(() => {})
      .finally(() => { clearTimeout(deadline); process.exit(0); });
  };

  server.listen(PORT, '127.0.0.1', () => {
    const actual = server.address().port;
    // Machine-readable line the desktop shell parses to learn the chosen port.
    console.log(`SYNTHORG_PORT=${actual}`);
    console.log(`SynthOrg SQL: http://127.0.0.1:${actual}`);
  });

  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE'
      ? `[SynthOrg] La porta ${PORT} è già occupata.`
      : error.message);
    process.exit(1);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);

  // Parent liveness. The shell keeps the write end of this pipe open for as
  // long as it lives; when it goes away — window closed, Alt+F4, killed from
  // the task manager, crashed — the read end reaches EOF and the service must
  // not survive it. This is the portable guarantee: no orphan is possible.
  if (process.env.SYNTHORG_PARENT_PIPE === '1') {
    process.stdin.resume();
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
    process.stdin.on('error', shutdown);
  }
}
module.exports = { createApp, PORT, instance, SERVER_VERSION };
