'use strict';
// Compiles the project editor once, so no environment ever has to.
//
// The editor is a static musl binary of about a megabyte, and building it
// needs a C toolchain that weighs two hundred. That cost belongs here, to
// whoever builds SynthOrg, and not to whoever installs it: this runs the
// compiler in a throwaway container and leaves the binary and its two fonts
// in code-editor-bin, from where every project's image copies them. It sits
// outside resources/ so it is not also embedded into the executable as a web
// asset: it travels as a bundle resource, like server/ and extensions/.
//
// It runs inside `beforeBuildCommand`, so it must never be what stops the
// application from being built. A binary made from these same sources is
// already the answer and nothing is started; and when there is none and the
// container engine cannot be reached, it says so and lets the build carry on
// — a project whose image finds no prebuilt editor compiles one itself, as it
// did before any of this existed.
const path = require('node:path');
const { SandboxManager, prebuiltEditor, editorSourceStamp } = require('../server/sandbox');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const current = prebuiltEditor();
  if (current && !process.env.SYNTHORG_FORCE_EDITOR_BUILD) {
    console.log(`[build-editor] gia presente: ${path.relative(ROOT, current.binary)} (sorgenti ${editorSourceStamp()})`);
    return;
  }

  const sandbox = new SandboxManager({ root: ROOT });
  let result;
  try {
    result = await sandbox.buildEditor({ log: message => console.log(`[build-editor] ${message}`) });
  } catch (error) {
    console.warn(`[build-editor] non compilato: ${error.message}`);
    console.warn('[build-editor] l’editor verrà compilato dentro il container alla prima apertura di un progetto.');
    return;
  }
  if (result.skipped) {
    console.warn(`[build-editor] saltato: ${result.reason}`);
    return;
  }
  const kb = (result.bytes / 1024).toFixed(0);
  console.log(`[build-editor] ${path.relative(ROOT, result.dir)}/editor-${result.arch} (${kb} KB, sorgenti ${result.stamp})`);
}

main().catch(error => {
  console.error(`[build-editor] ${error.message}`);
  process.exit(1);
});
