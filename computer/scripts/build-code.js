'use strict';

// Build the pinned SideX workbench with the editor-only runtime profile.
const { spawnSync } = require('node:child_process');
const { readdirSync, cpSync, mkdirSync, existsSync, rmSync } = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'vendor', 'sidex');
const destination = path.join(root, 'resources');

if (!existsSync(path.join(source, 'node_modules', 'vite', 'bin', 'vite.js'))) {
  throw new Error('Install editor dependencies first: npm --prefix vendor/sidex ci --ignore-scripts');
}
for (const args of [
  [path.join(root, 'scripts', 'fetch-code-extensions.js')],
  ['scripts/generate-extension-meta.js'],
  ['--max-old-space-size=12288', 'node_modules/vite/bin/vite.js', 'build'],
  ['scripts/postbuild.js'],
]) {
  const result = spawnSync(process.execPath, args, { cwd: source, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

mkdirSync(path.join(destination, 'code'), { recursive: true });
// These directories belong exclusively to the generated workbench. Remove old
// content hashes so repeated builds do not inflate the packaged application.
for (const name of ['assets', 'extensions', 'wasm']) {
  const target = path.resolve(destination, name);
  if (path.dirname(target) !== destination) throw new Error('Invalid staging directory');
  rmSync(target, { recursive: true, force: true });
}
for (const entry of readdirSync(path.join(source, 'dist'))) {
  // SideX's asset paths are rooted at the application origin. Keep the shell's
  // index intact and place only the editor document under /code/.
  const target = entry === 'index.html' ? path.join(destination, 'code', entry) : path.join(destination, entry);
  cpSync(path.join(source, 'dist', entry), target, { recursive: true });
}
console.log('Code workbench staged in resources/code/index.html');
