'use strict';
// Where the service keeps what it writes: database, workspaces, packages,
// images, models.
//
// In a checkout and on Windows that is `data/` next to the application, as it
// has always been. A packaged build on Linux and macOS is installed in a
// read-only system directory (/usr/lib/SynthOrg, /Applications), so the app
// passes the user's data directory in SYNTHORG_DATA_DIR.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// A test never writes in the data of the app: each test process, unless it names a folder itself, is given one of
// its own, removed when the process ends. (`NODE_TEST_CONTEXT` is what `node --test` sets in the processes it runs.)
function testDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-test-data-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

const DATA_DIR = process.env.SYNTHORG_DATA_DIR
  ? path.resolve(process.env.SYNTHORG_DATA_DIR)
  : process.env.NODE_TEST_CONTEXT ? testDataDir() : path.join(ROOT, 'data');

/** The data directory for an application root: tests pass roots of their own. */
function dataDirFor(root) {
  return !root || path.resolve(root) === ROOT ? DATA_DIR : path.join(root, 'data');
}

module.exports = { ROOT, DATA_DIR, dataDirFor };
