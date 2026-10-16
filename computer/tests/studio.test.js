'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../server/database');
const { ProjectManager } = require('../server/projects');
const { CodePermissions } = require('../server/code-permissions');
const {
  StudioManager, TOOLS, toolSpecs, splitParagraphs, mergeDraft, latexDocument, warmDocuments, proseBlock, screenplayBlock,
  inlineTex, escapeTex, parseCleanup, hashOf, isClean, MANIFEST, CHAPTERS_DIR, STUDIO_BLOCK_TITLE
} = require('../server/studio');

function tempDir(t, prefix = 'synthorg-studio-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

const fakeSandbox = {
  baseImages: null,
  async ensureProjectContainer(options) { return { containerName: options.containerName, volume: options.containerName, state: 'created', exec: { bin: 'podman', args: [] } }; },
  async removeProjectContainer() { return { removed: true }; },
  async stopAllContainers() { return { success: true, count: 0 }; }
};

/** A real folder, real git, a real manifest: nothing faked under the Studio. */
async function studio(t, input = {}) {
  const store = new Store(':memory:');
  const folder = tempDir(t);
  const projects = new ProjectManager({ store: () => store, sandbox: fakeSandbox, dataDir: tempDir(t, 'synthorg-data-') });
  const permissions = new CodePermissions({ store: () => store });
  const manager = new StudioManager({ store: () => store, projects, permissions, sandbox: fakeSandbox, dataDir: tempDir(t, 'synthorg-build-') });
  const created = await projects.create({ kind: 'local', path: folder, name: 'Romanzo', section: 'studio' });
  const opened = await projects.open(created.id);
  assert.equal(opened.git.ready, true, opened.git.error);
  await manager.init(store.project(created.id), { type: 'romanzo', title: 'La casa', author: 'Io', language: 'it', ...input });
  t.after(() => store.close());
  return { store, folder, projects, permissions, manager, id: created.id };
}

test('paragraphs are what the author separates with a blank line, and keep their identity across edits', () => {
  assert.deepEqual(splitParagraphs('uno\n\ndue\n \n\ntre\r\n\r\nquattro  \n'), ['uno', 'due', 'tre', 'quattro']);
  const a = { id: 'aaaaaaaaaa', draft: 'uno', clean: 'Uno.', cleanOf: hashOf('uno'), own: false };
  const b = { id: 'bbbbbbbbbb', draft: 'due', clean: 'Due.', cleanOf: hashOf('due'), own: false };
  const c = { id: 'cccccccccc', draft: 'tre', clean: 'Tre.', cleanOf: hashOf('tre'), own: false };
  // Untouched: the same paragraphs, clean text and all.
  assert.deepEqual(mergeDraft([a, b, c], ['uno', 'due', 'tre']), [a, b, c]);
  // One edited in place: it is still the second paragraph, now stale.
  const edited = mergeDraft([a, b, c], ['uno', 'due bis', 'tre']);
  assert.equal(edited[1].id, 'bbbbbbbbbb');
  assert.equal(edited[1].clean, 'Due.');
  assert.equal(isClean(edited[1]), false);
  assert.equal(isClean(edited[0]), true);
  // One added in the middle: new, with no clean text; the others untouched.
  const added = mergeDraft([a, b, c], ['uno', 'nuovo', 'due', 'tre']);
  assert.deepEqual(added.map(p => p.id === 'aaaaaaaaaa' || p.id === 'bbbbbbbbbb' || p.id === 'cccccccccc'), [true, false, true, true]);
  assert.equal(added[1].clean, '');
  // One removed: gone.
  assert.deepEqual(mergeDraft([a, b, c], ['uno', 'tre']).map(p => p.id), ['aaaaaaaaaa', 'cccccccccc']);
  // Two edited at once keep their order.
  const both = mergeDraft([a, b, c], ['uno!', 'due!', 'tre']);
  assert.deepEqual(both.map(p => p.id), ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']);
});

test('the LaTeX is escaped, marked up and shaped by type, and the sample documents cover every construct', () => {
  assert.equal(escapeTex('a & b % c $ d # e _ f { g } h ~ i ^ j \\ k'), 'a \\& b \\% c \\$ d \\# e \\_ f \\{ g \\} h \\textasciitilde{} i \\textasciicircum{} j \\textbackslash{} k');
  assert.equal(inlineTex('*corsivo* e **grassetto** "citato" -- fine...', 'it'), '\\emph{corsivo} e \\textbf{grassetto} «citato» – fine…');
  assert.equal(inlineTex('"quoted"', 'en'), '“quoted”');
  assert.equal(proseBlock('# Titolo', 'it', 'romanzo'), '\\innerheading{Titolo}');
  assert.equal(proseBlock('# Titolo', 'it', 'saggio'), '\\subsection{Titolo}');
  assert.equal(proseBlock('> una\n> due', 'it', 'romanzo'), '\\begin{quote}\nuna\\\\\ndue\n\\end{quote}');
  assert.equal(proseBlock('- a\n- b', 'it', 'romanzo'), '\\begin{itemize}\n\\item a\n\\item b\n\\end{itemize}');
  assert.equal(proseBlock('---', 'it', 'romanzo'), '\\scenebreak');
  assert.equal(proseBlock('riga uno\nriga due', 'it', 'romanzo'), 'riga uno\\\\\nriga due');
  assert.equal(screenplayBlock('INT. CUCINA - GIORNO', 'it'), '\\slug{INT. CUCINA - GIORNO}');
  assert.equal(screenplayBlock('.PIAZZA, NOTTE', 'it'), '\\slug{PIAZZA, NOTTE}');
  assert.equal(screenplayBlock('MARIA\n(sottovoce)\nNon dirlo.', 'it'), '\\cue{MARIA}\n\\paren{sottovoce}\n\\dialogue{Non dirlo.}');
  assert.equal(screenplayBlock('@Voce fuori campo\nCiao.', 'it'), '\\cue{Voce fuori campo}\n\\dialogue{Ciao.}');
  assert.equal(screenplayBlock('> TAGLIO SU:', 'it'), '\\transition{TAGLIO SU:}');
  assert.equal(screenplayBlock('> FINE <', 'it'), '\\centered{FINE}');
  assert.equal(screenplayBlock('Una stanza piena di luce.', 'it'), '\\action{Una stanza piena di luce.}');
  const p = text => ({ id: 'aaaaaaaaaa', draft: text, clean: text, cleanOf: hashOf(text), own: false });
  const novel = latexDocument({ type: 'romanzo', language: 'it', title: 'T & T', author: 'A' }, [{ title: 'Uno', paragraphs: [p('Ciao.'), p('')] }]);
  assert.ok(novel.includes('\\documentclass[11pt,openany,twoside]{book}'));
  assert.ok(novel.includes('\\setdefaultlanguage{italian}'));
  assert.ok(novel.includes('\\title{T \\& T}'));
  assert.ok(novel.includes('\\chapter{Uno}'));
  assert.ok(novel.includes('\\frontmatter') && novel.includes('\\mainmatter'));
  const script = latexDocument({ type: 'copione', language: 'en', title: 'S', author: '' }, [{ title: 'One', paragraphs: [p('INT. ROOM - DAY')] }]);
  assert.ok(script.includes('texgyrecursor-regular.otf'));
  assert.ok(script.includes('\\sequence{One}'));
  assert.ok(script.includes('\\setdefaultlanguage{english}'));
  const essay = latexDocument({ type: 'saggio', language: 'it', title: 'E', author: '' }, [{ title: 'Intro', paragraphs: [p('x')] }]);
  assert.ok(essay.includes('\\tableofcontents') && essay.includes('\\section{Intro}'));
  // The sample documents: one per type and language, nothing of a user's, every macro the templates define.
  const warm = warmDocuments();
  assert.deepEqual(Object.keys(warm).sort(), ['warm-copione-en.tex', 'warm-copione-it.tex', 'warm-romanzo-en.tex', 'warm-romanzo-it.tex', 'warm-saggio-en.tex', 'warm-saggio-it.tex']);
  for (const macro of ['\\scenebreak', '\\innerheading', '\\begin{quote}', '\\begin{itemize}', '\\begin{enumerate}', '\\emph', '\\textbf']) assert.ok(warm['warm-romanzo-it.tex'].includes(macro), macro);
  for (const macro of ['\\slug', '\\cue', '\\paren', '\\dialogue', '\\transition', '\\centered', '\\action']) assert.ok(warm['warm-copione-it.tex'].includes(macro), macro);
});

test('the model’s answer to a cleanup is read as JSON, in a fence or not, and anything else is refused', () => {
  assert.deepEqual(parseCleanup('{"paragraphs":[{"id":"a","text":" Ciao. "}]}'), [{ id: 'a', text: 'Ciao.' }]);
  assert.deepEqual(parseCleanup('```json\n{"paragraphs":[{"id":"a","text":"Ciao."}]}\n```'), [{ id: 'a', text: 'Ciao.' }]);
  assert.equal(parseCleanup('Ecco il testo sistemato: Ciao.'), null);
  assert.equal(parseCleanup('{"x":1}'), null);
});

test('a folder becomes a text: a manifest, a first chapter, the draft laid over the paragraphs and recorded', async t => {
  const { manager, folder, id, projects } = await studio(t);
  assert.ok(fs.existsSync(path.join(folder, MANIFEST)));
  const overview = manager.overview(id);
  assert.equal(overview.type, 'romanzo');
  assert.equal(overview.title, 'La casa');
  assert.equal(overview.chapters.length, 1);
  assert.equal(overview.perm.text, 'auto');
  assert.equal(overview.settings.auto, true);
  const chapterId = overview.chapters[0].id;
  assert.ok(fs.existsSync(path.join(folder, CHAPTERS_DIR, `${chapterId}.json`)));

  const start = (await projects.gitStatus(id)).commits;
  const saved = await manager.saveDraft(id, chapterId, { draft: 'Era una notte.\n\nPioveva forte' });
  assert.equal(saved.paragraphs.length, 2);
  assert.ok(saved.paragraphs.every(p => p.stale && p.clean === ''));
  assert.equal((await projects.gitStatus(id)).commits, start + 1);
  assert.equal((await projects.gitStatus(id)).last.source, 'user');
  // The same draft again changes nothing and records nothing.
  const again = await manager.saveDraft(id, chapterId, { draft: 'Era una notte.\n\nPioveva forte' });
  assert.equal(again.git, null);
  assert.equal((await projects.gitStatus(id)).commits, start + 1);
  // Word counts and the pending count reach the overview.
  const after = manager.overview(id);
  assert.equal(after.chapters[0].pending, 2);
  assert.equal(after.words, 5);
});

test('the cleanup: only stale paragraphs are asked, answers land only where the draft did not move, hand corrections hold', async t => {
  const { manager, id } = await studio(t);
  const chapterId = manager.overview(id).chapters[0].id;
  const saved = await manager.saveDraft(id, chapterId, { draft: 'prima\n\nseconda\n\nterza' });
  const [p1, p2, p3] = saved.paragraphs;

  const request = manager.cleanupRequest(id, chapterId);
  assert.deepEqual(request.ids, [p1.id, p2.id, p3.id]);
  assert.equal(request.messages[0].role, 'system');
  assert.match(request.messages[0].content, /romanzo scritto in italiano/);
  assert.match(request.messages[1].content, new RegExp(`\\[${p1.id}\\]\\nprima`));
  assert.ok(request.maxTokens > 0);

  // The author kept typing on the second paragraph: its old answer is dropped, the others land.
  await manager.saveDraft(id, chapterId, { draft: 'prima\n\nseconda cambiata\n\nterza' });
  const applied = await manager.applyCleanup(id, chapterId, { text: JSON.stringify({ paragraphs: [{ id: p1.id, text: 'Prima.' }, { id: p2.id, text: 'Seconda.' }, { id: p3.id, text: 'Terza.' }] }), hashes: request.hashes });
  assert.equal(applied.applied, 2);
  const [q1, q2, q3] = applied.paragraphs;
  assert.equal(q1.clean, 'Prima.'); assert.equal(q1.stale, false);
  assert.equal(q2.clean, ''); assert.equal(q2.stale, true);
  assert.equal(q3.clean, 'Terza.'); assert.equal(q3.stale, false);
  // Now only the second is asked, with its neighbours as context and not as work.
  const next = manager.cleanupRequest(id, chapterId);
  assert.deepEqual(next.ids, [p2.id]);
  assert.match(next.messages[1].content, /Paragrafo precedente[^]*Prima\./);
  assert.match(next.messages[1].content, /Paragrafo seguente[^]*Terza\./);
  // Nothing stale: nothing to ask.
  await manager.applyCleanup(id, chapterId, { text: '{"paragraphs":[{"id":"' + p2.id + '","text":"Seconda cambiata."}]}', hashes: next.hashes });
  assert.equal(manager.cleanupRequest(id, chapterId), null);

  // A correction by hand is the author's and is not stale.
  const own = await manager.editClean(id, chapterId, { id: p1.id, clean: 'Prima, davvero.' });
  assert.equal(own.paragraphs[0].clean, 'Prima, davvero.');
  assert.equal(own.paragraphs[0].own, true);
  assert.equal(own.paragraphs[0].stale, false);
  assert.equal(manager.cleanupRequest(id, chapterId), null);
  // A broken answer is refused, not half-applied.
  await assert.rejects(manager.applyCleanup(id, chapterId, { text: 'non è json' }), /formato atteso/);
});

test('chapters are added, renamed, moved and removed, by number, id or title, and never below one', async t => {
  const { manager, id, projects } = await studio(t);
  await manager.chapterAction(id, { action: 'add', title: 'Due', text: 'Testo del due.\n\nAltro.' });
  await manager.chapterAction(id, { action: 'add', title: 'Tre' });
  let overview = manager.overview(id);
  assert.deepEqual(overview.chapters.map(c => c.title), ['Capitolo 1', 'Due', 'Tre']);
  assert.equal(overview.chapters[1].paragraphs, 2);
  await manager.chapterAction(id, { action: 'rename', chapter: 1, title: 'Uno' });
  await manager.chapterAction(id, { action: 'move', chapter: 'Tre', to: 1 });
  overview = manager.overview(id);
  assert.deepEqual(overview.chapters.map(c => c.title), ['Tre', 'Uno', 'Due']);
  await manager.chapterAction(id, { action: 'remove', chapter: overview.chapters[0].id });
  overview = manager.overview(id);
  assert.deepEqual(overview.chapters.map(c => c.title), ['Uno', 'Due']);
  await manager.chapterAction(id, { action: 'remove', chapter: 2 });
  await assert.rejects(manager.chapterAction(id, { action: 'remove', chapter: 1 }), /almeno un capitolo/);
  await assert.rejects(manager.chapterAction(id, { action: 'rename', chapter: 9, title: 'x' }), /non trovato/);
  // Every one of those was a step of the record, by the user here.
  assert.equal((await projects.gitStatus(id)).last.source, 'user');
});

test('the model’s tools read numbered paragraphs and change the text, each change recorded under the tool’s name', async t => {
  const { manager, id, projects } = await studio(t);
  assert.deepEqual(Object.keys(TOOLS).sort(), ['studio_chapter', 'studio_delete', 'studio_insert', 'studio_open', 'studio_read', 'studio_replace']);
  for (const spec of toolSpecs()) { assert.equal(spec.type, 'function'); assert.ok(spec.function.description.length > 20); }
  const chapterId = manager.overview(id).chapters[0].id;
  await manager.saveDraft(id, chapterId, { draft: 'uno\n\ndue\n\ntre' });

  const read = await manager.run(id, 'studio_read', { chapter: 1 });
  assert.equal(read.total, 3);
  assert.match(read.text, /1\| \(solo brutta\) uno/);

  // Same count: the paragraph keeps the author's draft and gets the model's clean text.
  const replaced = await manager.run(id, 'studio_replace', { chapter: 1, from: 2, text: 'Due, ma meglio.' });
  assert.equal(replaced.replaced, 1);
  let chapter = manager.chapter(id, chapterId);
  assert.equal(chapter.paragraphs[1].draft, 'due');
  assert.equal(chapter.paragraphs[1].clean, 'Due, ma meglio.');
  assert.equal(chapter.paragraphs[1].stale, false);
  const last = (await projects.gitStatus(id)).last;
  assert.equal(last.source, 'agent');
  assert.equal(last.author, 'SynthOrg (modello)');
  assert.equal(last.message, 'riscrive Capitolo 1 2');
  assert.equal((await projects.history(id, { limit: 1 })).commits[0].tool, 'studio_replace');

  // A different count: the range is replaced by new paragraphs, draft and clean alike.
  await manager.run(id, 'studio_replace', { chapter: 1, from: 1, to: 2, text: 'Solo uno.' });
  chapter = manager.chapter(id, chapterId);
  assert.deepEqual(chapter.paragraphs.map(p => p.draft), ['Solo uno.', 'tre']);

  const inserted = await manager.run(id, 'studio_insert', { chapter: 1, after: 0, text: 'Inizio.\n\nAncora.' });
  assert.equal(inserted.inserted, 2);
  chapter = manager.chapter(id, chapterId);
  // The inserted ones are clean already; the author's own draft-only paragraph is still waiting.
  assert.deepEqual(chapter.paragraphs.map(p => p.clean), ['Inizio.', 'Ancora.', 'Solo uno.', '']);
  await manager.run(id, 'studio_delete', { chapter: 1, from: 1, to: 2 });
  chapter = manager.chapter(id, chapterId);
  assert.deepEqual(chapter.paragraphs.map(p => p.draft), ['Solo uno.', 'tre']);
  await assert.rejects(manager.run(id, 'studio_delete', { chapter: 1, from: 5 }), /Intervallo non valido/);
  await assert.rejects(manager.run(id, 'studio_read', { chapter: 7 }), /non trovato/);
  await assert.rejects(manager.run(id, 'nope', {}), /non trovato/);
  await manager.run(id, 'studio_chapter', { action: 'add', title: 'Nuovo' });
  assert.equal(manager.overview(id).chapters.length, 2);
  assert.equal((await projects.history(id, { limit: 1 })).commits[0].tool, 'studio_chapter');
});

test('the map: scenes, chapters and parts are asked for in order, kept by key, given within the cap, and opened', async t => {
  const { manager, id } = await studio(t);
  const first = manager.overview(id).chapters[0].id;
  await manager.saveDraft(id, first, { draft: 'Una scena.\n\nAltra frase.' });
  await manager.chapterAction(id, { action: 'add', title: 'Due', text: 'Capitolo due.' });

  // Scenes first; a chapter only once its scenes are summarized.
  let pending = manager.pending(id);
  assert.deepEqual(pending.map(p => p.level), [1, 1]);
  assert.match(pending[0].text, /1\| Una scena\./);
  for (const item of pending) manager.addNode(id, { key: item.key, hash: item.hash, title: `Scena ${item.chapter}`, content: `Riassunto ${item.chapter}`, facts: ['fatto'] });
  pending = manager.pending(id);
  assert.deepEqual(pending.map(p => p.level), [2, 2]);
  assert.match(pending[0].text, /\[Scena 1\]\nRiassunto 1\nFatti: fatto/);
  for (const item of pending) manager.addNode(id, { key: item.key, hash: item.hash, title: '', content: `Capitolo ${item.chapter} in breve`, facts: [] });
  assert.deepEqual(manager.pending(id), []);

  // The text changed: that scene and its chapter are stale, nothing else.
  await manager.saveDraft(id, first, { draft: 'Una scena diversa.\n\nAltra frase.' });
  pending = manager.pending(id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].level, 1);
  const tree = manager.tree(id);
  assert.deepEqual(tree.nodes.map(n => n.state), ['stale', 'stale', 'current', 'current']);

  // The view: the map, within the share of the cap, the chapter in focus refined to its scenes.
  const view = manager.view(id);
  assert.ok(view.system.startsWith(STUDIO_BLOCK_TITLE));
  assert.match(view.system, /Capitolo 1 «Capitolo 1», paragrafi 1-2/);
  assert.match(view.system, /riassunto non aggiornato/);
  assert.match(view.system, /Capitolo 2 «Due»/);
  const context = manager.context(id);
  assert.equal(context.studio, true);
  assert.equal(context.tools.length, 6);

  // Opening: a chapter gives its scenes; a scene gives the paragraphs numbered.
  const chapterNode = tree.nodes.find(n => n.level === 2 && n.chapter === 2);
  const opened = manager.open(id, chapterNode.id);
  assert.equal(opened.children.length, 1);
  const scene = manager.open(id, opened.children[0].node);
  assert.match(scene.text, /1\| Capitolo due\./);
  assert.throws(() => manager.open(id, 'nope'), /Voce non trovata/);

  // A tiny cap: the chapters alone, no scene expanded.
  await manager.setSettings(id, { cap: 4000, share: 0 });
  const small = manager.view(id);
  assert.ok(!/paragrafi 1-2/.test(small.system));
});

test('the document is written out only when asked, into the project’s own export folder', async t => {
  const { manager, id, folder } = await studio(t);
  const chapterId = manager.overview(id).chapters[0].id;
  await manager.saveDraft(id, chapterId, { draft: 'Ciao & ciao.' });
  await manager.applyCleanup(id, chapterId, { text: JSON.stringify({ paragraphs: [{ id: manager.chapter(id, chapterId).paragraphs[0].id, text: 'Ciao & ciao.' }] }) });
  const tex = await manager.exportDocument(id, { what: 'tex' });
  assert.equal(path.dirname(tex.path), path.join(folder, 'esportazioni'));
  assert.ok(fs.readFileSync(tex.path, 'utf8').includes('Ciao \\& ciao.'));
  const md = await manager.exportDocument(id, { what: 'md' });
  assert.ok(fs.readFileSync(md.path, 'utf8').includes('# La casa'));
  await assert.rejects(manager.exportDocument(id, { what: 'pdf' }), /impagina prima/);
  assert.equal(manager.compileStatus(id).state, 'idle');
  assert.equal(manager.compileStatus(id).pdf, null);
});

test('over HTTP: a Studio project is listed apart from the Code ones, its chat gets the map, its tools pass the gate', async t => {
  const { createApp } = require('../server');
  const { server } = createApp({ token: 'tok', dbPath: ':memory:', sandbox: fakeSandbox });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = async (route, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${route}`, { method, headers: { Authorization: 'Bearer tok', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const folder = tempDir(t);
  const code = (await call('/projects', 'POST', { kind: 'local', path: tempDir(t), name: 'Codice' })).body;
  const text = (await call('/projects', 'POST', { kind: 'local', path: folder, name: 'Testo', section: 'studio' })).body;
  assert.equal(text.section, 'studio');
  assert.deepEqual((await call('/projects')).body.map(p => p.id), [code.id]);
  assert.deepEqual((await call('/projects?section=studio')).body.map(p => p.id), [text.id]);
  assert.equal((await call(`/projects/${text.id}`)).body.section, 'studio');

  await call(`/projects/${text.id}/open`, 'POST', {});
  assert.equal((await call(`/studio/${text.id}/init`, 'POST', { type: 'saggio', title: 'Il saggio', language: 'en' })).status, 200);
  const overview = (await call(`/studio/${text.id}`)).body;
  assert.equal(overview.type, 'saggio');
  assert.equal(overview.perm.text, 'auto');
  const chapterId = overview.chapters[0].id;
  assert.equal((await call(`/studio/${text.id}/chapters/${chapterId}`, 'PUT', { draft: 'Hello there.' })).status, 200);
  assert.equal((await call(`/studio/${text.id}/chapters/${chapterId}`, 'POST', { op: 'request' })).body.request.ids.length, 1);
  const context = (await call(`/studio/${text.id}/context`)).body;
  assert.equal(context.studio, true);
  assert.ok(context.system.startsWith(STUDIO_BLOCK_TITLE));
  // The text mode of a Studio project starts automatic: a change from the chat lands at once.
  const insert = await call(`/studio/${text.id}/tools/studio_insert`, 'POST', { chapter: 1, text: 'Added by the model.' });
  assert.equal(insert.status, 200);
  assert.equal(insert.body.inserted, 1);
  assert.equal((await call(`/studio/${text.id}/tools/studio_read`, 'POST', { chapter: 1 })).body.total, 2);
  // Manual: the same change waits for the user.
  await call(`/projects/${text.id}`, 'PATCH', { permissions: { code: 'manual' } });
  const parked = await call(`/studio/${text.id}/tools/studio_delete`, 'POST', { chapter: 1, from: 2 });
  assert.equal(parked.body.pending, true);
  assert.equal(parked.body.approval.summary.path, 'capitolo 1');
  const denied = await call(`/projects/${text.id}/approvals/${parked.body.approval.id}`, 'POST', { decision: 'deny' });
  assert.equal(denied.body.approved, false);
  assert.equal((await call(`/studio/${text.id}/tools/studio_read`, 'POST', { chapter: 1 })).body.total, 2);
  // Reading never waits.
  assert.equal((await call(`/studio/${text.id}/tools/studio_read`, 'POST', { chapter: 1 })).status, 200);
  // The PDF is not there until typeset; the export says so.
  assert.equal((await call(`/studio/${text.id}/pdf`)).status, 404);
  assert.equal((await call(`/studio/${text.id}/export`, 'POST', { what: 'md' })).status, 200);
  assert.equal((await call(`/studio/${code.id}`)).status, 400);
});
