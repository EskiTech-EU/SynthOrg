'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  sourcesStamp, mirrorFromPod, notePushed, filesUnder, imagesToDrop, parseDistroList, chatVolumeName, getContainerName, libVolumeName, imageKey
} = require('../server/sandbox');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const put = (file, body = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };

test('the stamp of the tools image follows the bytes of the sources, never their dates', t => {
  const dir = tempDir(t, 'synthorg-stamp-');
  put(path.join(dir, 'agent.cjs'), 'agent');
  put(path.join(dir, 'ext', 'a', 'package.json'), '{"name":"a"}');
  put(path.join(dir, 'ext', 'b', 'syntaxes', 'b.json'), '{}');
  const sources = () => ({ files: [['agent', path.join(dir, 'agent.cjs')]], dirs: [['extensions', path.join(dir, 'ext')]] });
  const first = sourcesStamp(sources());
  // A build copies the files again: new dates, same bytes.
  const later = new Date(Date.now() + 3600 * 1000);
  for (const file of filesUnder(dir).keys()) fs.utimesSync(path.join(dir, file), later, later);
  fs.utimesSync(path.join(dir, 'ext', 'a'), later, later);
  assert.equal(sourcesStamp(sources()), first, 'le date non contano');
  // A byte changed anywhere in the tree: another image.
  put(path.join(dir, 'ext', 'b', 'syntaxes', 'b.json'), '{"changed":true}');
  assert.notEqual(sourcesStamp(sources()), first);
  // A file added, or missing, counts too.
  put(path.join(dir, 'ext', 'c', 'package.json'), '{}');
  const withC = sourcesStamp(sources());
  assert.notEqual(withC, first);
  fs.rmSync(path.join(dir, 'agent.cjs'));
  assert.notEqual(sourcesStamp(sources()), withC);
});

test('the copy follows the pod: changed files come, the pod’s removed ones go, this side’s own stay', t => {
  const pod = tempDir(t, 'synthorg-pod-');
  const copy = tempDir(t, 'synthorg-copy-');
  const manifest = path.join(tempDir(t, 'synthorg-manifest-'), 'pod-files.json');
  put(path.join(pod, 'out', 'result.txt'), 'first');
  put(path.join(pod, 'plot.png'), 'png');
  // Written on this side only: a spoken answer's audio, a published archive noted later.
  put(path.join(copy, 'tts_123.wav'), 'audio');
  let done = mirrorFromPod(pod, copy, manifest);
  assert.equal(done.copied, 2);
  assert.equal(fs.readFileSync(path.join(copy, 'out', 'result.txt'), 'utf8'), 'first');
  assert.ok(fs.existsSync(path.join(copy, 'tts_123.wav')));
  assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')).files, ['out/result.txt', 'plot.png']);

  // Nothing changed: nothing copied.
  assert.equal(mirrorFromPod(pod, copy, manifest).copied, 0);

  // The pod changed one, removed one; this side kept a file of its own in the meantime.
  put(path.join(pod, 'out', 'result.txt'), 'second');
  fs.rmSync(path.join(pod, 'plot.png'));
  put(path.join(copy, 'artifact_out_1.zip'), 'zip');
  done = mirrorFromPod(pod, copy, manifest);
  assert.equal(done.copied, 1);
  assert.equal(done.removed, 1);
  assert.equal(fs.readFileSync(path.join(copy, 'out', 'result.txt'), 'utf8'), 'second');
  assert.ok(!fs.existsSync(path.join(copy, 'plot.png')), 'tolto dal pod, tolto dalla copia');
  assert.ok(fs.existsSync(path.join(copy, 'artifact_out_1.zip')), 'ciò che è solo di qua resta');
  assert.ok(fs.existsSync(path.join(copy, 'tts_123.wav')));

  // A whole folder gone from the pod leaves no empty folder behind.
  fs.rmSync(path.join(pod, 'out'), { recursive: true });
  mirrorFromPod(pod, copy, manifest);
  assert.ok(!fs.existsSync(path.join(copy, 'out')));

  // Files this side put into the pod are the pod's from then on: when the pod drops them, so does the copy.
  put(path.join(copy, 'upload.csv'), 'a,b');
  notePushed(manifest, ['upload.csv']);
  assert.ok(JSON.parse(fs.readFileSync(manifest, 'utf8')).files.includes('upload.csv'));
  done = mirrorFromPod(pod, copy, manifest);
  assert.equal(done.removed, 1);
  assert.ok(!fs.existsSync(path.join(copy, 'upload.csv')));
});

test('a link in the pod is not a file of the copy', t => {
  const pod = tempDir(t, 'synthorg-pod-');
  const copy = tempDir(t, 'synthorg-copy-');
  put(path.join(pod, 'real.txt'), 'real');
  let planted = false;
  try { fs.symlinkSync(path.join(os.tmpdir()), path.join(pod, 'escape'), 'junction'); planted = true; } catch {}
  try { fs.symlinkSync(path.join(pod, 'real.txt'), path.join(pod, 'alias.txt'), 'file'); } catch {}
  const done = mirrorFromPod(pod, copy, path.join(copy, '..', `${path.basename(copy)}-manifest.json`));
  assert.equal(done.copied, 1);
  assert.ok(!fs.existsSync(path.join(copy, 'escape')));
  assert.ok(!fs.existsSync(path.join(copy, 'alias.txt')));
  t.diagnostic(planted ? 'junction piantata e ignorata' : 'junction non creabile qui');
});

test('of every image of ours only the tags of this build stay', () => {
  const keepers = [
    { repo: 'localhost/synthorg-code-tools', keep: tag => tag.endsWith('-now') },
    { repo: 'localhost/synthorg-desktop', keep: tag => tag.endsWith('-d1') },
    { repo: 'localhost/synthorg-studio-tools', keep: () => false }
  ];
  const refs = [
    'localhost/synthorg-code-tools:localhost_synthorg-base_3.23.6-now',
    'localhost/synthorg-code-tools:localhost_synthorg-base_3.23.6-old',
    'localhost/synthorg-code-tools:docker.io_library_alpine_latest-now',
    'localhost/synthorg-code-tools:docker.io_library_alpine_latest-older',
    'localhost/synthorg-desktop:localhost_synthorg-base_3.23.6-d0',
    'localhost/synthorg-studio-tools:localhost_synthorg-base_3.23.6-s1',
    'localhost/synthorg-base:3.23.6',
    'docker.io/library/alpine:latest',
    '<none>:<none>'
  ];
  assert.deepEqual(imagesToDrop(refs, keepers), [
    'localhost/synthorg-code-tools:localhost_synthorg-base_3.23.6-old',
    'localhost/synthorg-code-tools:docker.io_library_alpine_latest-older',
    'localhost/synthorg-desktop:localhost_synthorg-base_3.23.6-d0',
    // No stamp of now for the studio (engine not shipped): all of its images are of before.
    'localhost/synthorg-studio-tools:localhost_synthorg-base_3.23.6-s1'
  ]);
});

test('the names wsl.exe lists are read through its UTF-16 output', () => {
  const utf16 = Buffer.from('synthorg-runtime\r\nUbuntu\r\n', 'utf16le').toString('utf8');
  assert.deepEqual(parseDistroList(utf16), ['synthorg-runtime', 'Ubuntu']);
  assert.deepEqual(parseDistroList(''), []);
});

test('a chat’s volume is named like its container, the store’s like its image', () => {
  assert.equal(chatVolumeName('chat-1'), getContainerName('chat-1'));
  assert.equal(libVolumeName('alpine:latest'), `synthorg-lib-${imageKey('alpine:latest')}`);
  assert.match(libVolumeName('docker.io/library/python:3.12-slim'), /^synthorg-lib-[a-zA-Z0-9._-]+$/);
});
