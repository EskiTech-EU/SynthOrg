'use strict';
// Tries what the uninstaller removes (src-tauri/nsis/hooks.nsh) without installing or uninstalling anything: the hook
// is compiled alone into a small program and run against folders made here and a registry key of its own.
// Windows only; needs the NSIS that `tauri build` downloads (%LOCALAPPDATA%\tauri\NSIS).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

const NSIS = path.join(process.env.LOCALAPPDATA || '', 'tauri', 'NSIS', 'makensis.exe');
const SOURCE = path.resolve(__dirname, '..', 'src-tauri', 'nsis', 'hooks-check.nsi');
const KEY = 'HKCU\\Software\\SynthOrgHookCheck';
if (process.platform !== 'win32' || !fs.existsSync(NSIS)) { console.log('[check-uninstall-hook] saltato: serve Windows con NSIS di Tauri.'); process.exit(0); }

const reg = args => spawnSync('reg.exe', args, { stdio: 'ignore', windowsHide: true });

/** A place as an installation leaves it; the memory beside the app, or in a folder of the user's with other things of theirs. */
function world({ memoryElsewhere = true, marked = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-hook-'));
  const put = (parts, body = 'x') => { const file = path.join(root, ...parts); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
  // The engine.
  put(['install', 'data', 'models', 'm.gguf'], 'pesi');
  put(['install', 'data', 'packages', 'cache', 'numpy.whl']);
  put(['install', 'data', 'images', 'alpine.tar.gz']);
  put(['install', 'data', 'seccomp.json'], '{}');
  put(['profile', 'EBWebView', 'Default', 'storage']);
  put(['editor', 'Code', 'settings.json'], '{}');
  // The memory when it is beside the app, with the chats' working folders.
  put(['install', 'data', 'synthorg.sqlite'], 'database');
  put(['install', 'data', 'sandboxes', 'chat-1', 'workspace', 'nota.txt']);
  put(['install', 'data', 'pod-projects', 'p.git', 'HEAD']);
  put(['install', 'data', 'memoria.json'], '{}');
  // The memory kept elsewhere, among other things of the user's.
  put(['disk', 'le mie foto.txt'], 'non toccare');
  put(['disk', 'SynthOrg Memoria', 'synthorg.sqlite'], 'database');
  put(['disk', 'SynthOrg Memoria', 'artifacts', 'a.psd']);
  if (marked) put(['disk', 'SynthOrg Memoria', '.synthorg-memoria']);
  reg(['delete', KEY, '/f']);
  if (memoryElsewhere) reg(['add', KEY, '/v', 'MemoryDir', '/t', 'REG_SZ', '/d', path.join(root, 'disk', 'SynthOrg Memoria'), '/f']);
  return root;
}

// The pods' disk is a WSL distribution: the check gives it a name that is never there, and removing a name that
// does not exist does nothing, so here only the folders and the registry tell.
function run(root, { check, update = 0 }) {
  const out = path.join(root, 'hook.exe');
  execFileSync(NSIS, ['/V1', SOURCE], { env: { ...process.env, HOOK_ROOT: root, HOOK_OUT: out, HOOK_CHECK: String(check), HOOK_UPDATE: String(update) }, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
  execFileSync(out, [], { windowsHide: true, timeout: 120000 });
  fs.rmSync(out, { force: true });
}
const there = (root, ...parts) => fs.existsSync(path.join(root, ...parts));
const keyThere = () => reg(['query', KEY]).status === 0;
const engineGone = root => !there(root, 'install', 'data', 'models') && !there(root, 'install', 'data', 'packages') && !there(root, 'install', 'data', 'images')
  && !there(root, 'install', 'data', 'seccomp.json') && !there(root, 'profile') && !there(root, 'editor');
const memoryThere = root => there(root, 'install', 'data', 'synthorg.sqlite') && there(root, 'install', 'data', 'sandboxes', 'chat-1', 'workspace', 'nota.txt')
  && there(root, 'install', 'data', 'pod-projects', 'p.git', 'HEAD') && there(root, 'install', 'data', 'memoria.json') && there(root, 'disk', 'SynthOrg Memoria', 'artifacts', 'a.psd');

try {
  // An update: everything stays, ticked or not.
  let root = world();
  run(root, { check: 1, update: 1 });
  assert.ok(memoryThere(root) && there(root, 'install', 'data', 'models', 'm.gguf') && there(root, 'profile') && there(root, 'editor', 'Code') && keyThere(), 'in un aggiornamento non va tolto niente');
  fs.rmSync(root, { recursive: true, force: true });

  // Not ticked: the engine goes, the memory stays — beside the app and elsewhere — with what says where it is.
  root = world();
  run(root, { check: 0 });
  assert.ok(engineGone(root), 'il motore va tolto anche senza il segno di spunta');
  assert.ok(memoryThere(root) && keyThere(), 'senza il segno di spunta la memoria resta');
  fs.rmSync(root, { recursive: true, force: true });

  // Ticked: the memory too, beside the app and elsewhere — and nothing else of that folder.
  root = world();
  run(root, { check: 1 });
  assert.ok(engineGone(root));
  assert.ok(!there(root, 'install'), 'la cartella dell’app, vuota, se ne va con i suoi dati');
  assert.ok(!there(root, 'disk', 'SynthOrg Memoria'), 'la memoria tenuta altrove');
  assert.equal(fs.readFileSync(path.join(root, 'disk', 'le mie foto.txt'), 'utf8'), 'non toccare');
  assert.ok(!keyThere(), 'la chiave del registro');
  fs.rmSync(root, { recursive: true, force: true });

  // Ticked, and the registry names a folder that does not carry the app's mark: it is not the memory, it stays.
  root = world({ marked: false });
  run(root, { check: 1 });
  assert.ok(there(root, 'disk', 'SynthOrg Memoria', 'synthorg.sqlite'), 'una cartella senza il segno dell’app non si tocca');
  assert.ok(!there(root, 'install'));
  fs.rmSync(root, { recursive: true, force: true });

  // Ticked, the memory beside the app: nothing is named in the registry, the data go.
  root = world({ memoryElsewhere: false });
  run(root, { check: 1 });
  assert.ok(!there(root, 'install') && there(root, 'disk', 'SynthOrg Memoria'), 'senza indicazione nel registro si toglie solo ciò che è accanto all’app');
  fs.rmSync(root, { recursive: true, force: true });

  // Not ticked, and nothing of the memory is beside the app (it is all elsewhere): the app's folder goes whole.
  root = world();
  for (const name of ['synthorg.sqlite', 'sandboxes', 'pod-projects', 'memoria.json']) fs.rmSync(path.join(root, 'install', 'data', name), { recursive: true, force: true });
  run(root, { check: 0 });
  assert.ok(!there(root, 'install') && there(root, 'disk', 'SynthOrg Memoria', 'synthorg.sqlite'));
  fs.rmSync(root, { recursive: true, force: true });
  console.log('[check-uninstall-hook] ok: 6 casi');
} finally {
  reg(['delete', KEY, '/f']);
}
