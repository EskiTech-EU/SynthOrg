'use strict';
// Compiles the Foto section's background-removal program once, so no
// environment of the user's ever has to.
//
// It is a small musl binary (server/photo/rembg, Rust around ONNX Runtime, which
// it loads from Alpine's package in the pod image), and
// building it wants a Rust toolchain and the crates it depends on: that cost
// belongs to whoever builds SynthOrg. The compiler runs in a throwaway
// container with the network (the builder's inert channel: cargo fills a
// cache volume, nothing of the user's is near) and leaves the binary in
// photo-tools-bin, from where the functions' image copies it. Outside
// resources/ so it is a bundle resource and not a web asset.
//
// It runs inside the build, so it must never be what stops the application
// from being built: a binary made from these same sources is the answer and
// nothing is started; without a container engine it says so and the build
// goes on, and the Foto section reports that its functions are not included.
const path = require('node:path');
const { buildRembg, prebuiltRembg, sourceStamp } = require('../server/photo-ml');
const { SandboxManager } = require('../server/sandbox');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const current = prebuiltRembg();
  if (current && !process.env.SYNTHORG_FORCE_REMBG_BUILD) {
    console.log(`[build-rembg] gia presente: ${path.relative(ROOT, current.binary)} (sorgenti ${sourceStamp()})`);
    return;
  }
  const sandbox = new SandboxManager({ root: ROOT });
  let result;
  try {
    result = await buildRembg({ baseImages: sandbox.baseImages, log: message => console.log(`[build-rembg] ${message}`) });
  } catch (error) {
    console.warn(`[build-rembg] non compilato: ${error.message}`);
    console.warn('[build-rembg] le funzioni della sezione Foto non saranno incluse in questa build.');
    return;
  }
  if (result.skipped) {
    console.warn(`[build-rembg] saltato: ${result.reason}`);
    return;
  }
  console.log(`[build-rembg] ${path.relative(ROOT, result.dir)}/synthorg-rembg-${result.arch} (${(result.bytes / 1048576).toFixed(1)} MB, ${result.seconds} s, sorgenti ${result.stamp})`);
}

main().catch(error => {
  console.error(`[build-rembg] ${error.message}`);
  process.exit(1);
});
