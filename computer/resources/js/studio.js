/**
 * SynthOrg - Writing, an environment of a project.
 *
 * Long texts: a novel, a screenplay, an essay, in a folder of the user's. In
 * the frame of an open project (code-workspace.js) this is what is in the
 * middle while a chapter is. A text is chapters; a chapter is two sheets side
 * by side. On the left the draft, where the author types as they like; on
 * the right the clean copy, the same paragraphs set right by the model
 * (spelling, grammar, punctuation, formatting), keeping the author's style
 * and meaning. The correction runs by itself after a pause, when its switch
 * is on, or when asked; it only ever touches the paragraphs whose draft
 * changed. From the chat beside the sheets the model can be asked for more:
 * add, remove, rewrite, with the tools the service gives it on this project.
 *
 * The map the model reads — summaries with titles per scene, chapter and
 * part — is written here in the background by the Microtask model, from what
 * the service says is missing. The typeset document is compiled in a
 * container and its pages are drawn in the third sheet with pdf.js.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const t = (key, params) => window.i18n?.t(key, params || {}) || key;
  const TYPE_LABELS = { romanzo: 'studio.typeRomanzo', copione: 'studio.typeCopione', saggio: 'studio.typeSaggio' };
  const SAVE_QUIET_MS = 1200;
  const MAP_QUIET_MS = 6000;
  const CLEAN_ROUNDS = 6;
  const PDFJS_URL = '/vendor/pdfjs/pdf.min.mjs';
  const PDFJS_WORKER = '/vendor/pdfjs/pdf.worker.min.mjs';

  let active = false;
  let busy = false;
  // The open project (its overview from the service) and the chapter on the sheets.
  let project = null;
  let chapter = null;
  // What the draft sheet holds that the service has not: saved after a quiet moment.
  let dirty = false;
  let saveTimer = null;
  let saving = null;
  // The correction: after the project's pause, or on request; one run at a time.
  let cleanTimer = null;
  let cleaning = false;
  let cleanAgain = false;
  // The map of the text, brought up to date after the text settles.
  let mapTimer = null;
  let mapping = false;
  let mapAgain = false;
  // The typeset pages: the compile being followed, and what is drawn.
  let compilePoll = null;
  let warmPoll = null;
  let pdfLib = null;
  let pdfDoc = null;
  let pdfAt = null;
  let pdfRenderToken = 0;
  let pdfShown = false;
  let chapterDialogMode = null;

  function el(tag, className, key, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (key) { node.setAttribute('data-i18n', key); node.textContent = t(key); }
    else if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(className) {
    const node = document.createElement('i');
    node.className = className;
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function showError(message) {
    $('studio-error').hidden = !message;
    $('studio-error-text').textContent = message || '';
    if (message) console.warn('[studio]', message);
  }

  /** The badge in the bar: what the Studio is doing for this chapter right now. */
  function setState(key, params, spinning = true) {
    const badge = $('studio-state');
    if (!key) { badge.hidden = true; return; }
    badge.hidden = false;
    badge.querySelector('i').hidden = !spinning;
    $('studio-state-text').textContent = t(key, params);
  }

  // --- the projects ----------------------------------------------------------------

  // --- the open project ------------------------------------------------------------

  async function refreshOverview() {
    if (!project) return;
    try {
      const overview = await window.chatStorage.studioOverview(project.id);
      project = { ...overview, git: project.git };
      render();
    } catch (error) { showError(error.message); }
  }

  function render() {
    if (!project) return;
    const type = $('studio-active-type');
    type.textContent = t(TYPE_LABELS[project.type] || 'studio.typeRomanzo');
    $('studio-active-words').textContent = t('studio.words', { count: project.words });
    $('studio-auto').checked = Boolean(project.settings?.auto);
    renderChapters();
  }

  function renderChapters() {
    window.codeWorkspace?.fileChanged?.();
    const list = $('studio-chapter-list');
    list.replaceChildren();
    for (const item of project.chapters) {
      const row = el('li', 'studio-chapter' + (chapter && item.id === chapter.id ? ' is-active' : ''));
      const open = el('button', 'studio-chapter-open');
      open.type = 'button';
      open.append(el('span', 'studio-chapter-number', null, String(item.number)), el('span', 'studio-chapter-title', null, item.title));
      const meta = el('span', 'studio-chapter-meta', null, t('studio.chapterMeta', { words: item.words }));
      if (item.pending) { meta.append(' · ', el('span', 'studio-chapter-pending', null, t('studio.chapterPending', { count: item.pending }))); }
      open.append(meta);
      open.addEventListener('click', () => void selectChapter(item.id));
      const actions = el('span', 'studio-chapter-actions');
      const button = (cls, title, fn) => { const b = el('button', 'btn-chat-action'); b.type = 'button'; b.title = t(title); b.setAttribute('aria-label', t(title)); b.append(icon(cls)); b.addEventListener('click', event => { event.stopPropagation(); fn(); }); return b; };
      actions.append(
        button('fa-solid fa-arrow-up', 'studio.chapterUp', () => void chapterAction({ action: 'move', chapter: item.number, to: item.number - 1 })),
        button('fa-solid fa-arrow-down', 'studio.chapterDown', () => void chapterAction({ action: 'move', chapter: item.number, to: item.number + 1 })),
        button('fa-solid fa-pen', 'studio.chapterRename', () => openChapterDialog('rename', item)),
        button('fa-solid fa-trash-can', 'studio.chapterRemove', () => void removeChapter(item))
      );
      row.append(open, actions);
      list.append(row);
    }
  }

  async function chapterAction(input) {
    if (!project) return;
    await flushSave();
    try {
      const overview = await window.chatStorage.studioChapterAction(project.id, input);
      project = { ...overview, git: project.git };
      render();
      if (input.action === 'add' && overview.focus) await selectChapter(overview.focus);
      else if (chapter && !project.chapters.some(c => c.id === chapter.id)) await selectChapter(project.chapters[0]?.id);
      else renderChapters();
    } catch (error) { showError(error.message); }
  }

  async function removeChapter(item) {
    const ok = await window.chatWorkspace.confirmAction({ title: t('studio.chapterRemove'), message: t('studio.chapterRemoveMessage', { title: item.title }), confirmText: t('studio.chapterRemove') });
    if (!ok) return;
    await chapterAction({ action: 'remove', chapter: item.number });
  }

  function openChapterDialog(mode, item = null) {
    chapterDialogMode = { mode, item };
    $('studio-chapter-title').textContent = t(mode === 'rename' ? 'studio.chapterRename' : 'studio.chapterAdd');
    $('studio-chapter-name').value = item ? item.title : t(project?.type === 'copione' ? 'studio.chapterDefaultScene' : project?.type === 'saggio' ? 'studio.chapterDefaultSection' : 'studio.chapterDefault', { n: (project?.chapters.length || 0) + 1 });
    $('studio-chapter-error').textContent = '';
    $('studio-chapter-dialog').showModal();
    $('studio-chapter-name').select();
  }

  async function submitChapter(event) {
    event.preventDefault();
    const title = $('studio-chapter-name').value.trim();
    if (!title) { $('studio-chapter-error').textContent = t('studio.titleRequired'); return; }
    const { mode, item } = chapterDialogMode || {};
    $('studio-chapter-dialog').close();
    if (mode === 'rename' && item) await chapterAction({ action: 'rename', chapter: item.number, title });
    else await chapterAction({ action: 'add', title, after: chapter ? chapter.number : undefined });
  }

  // --- the two sheets --------------------------------------------------------------

  async function selectChapter(chapterId) {
    if (chapterId) window.codeWorkspace?.showing?.(`capitoli/${chapterId}.json`);
    if (!project || !chapterId) { chapter = null; $('studio-draft').value = ''; $('studio-clean').replaceChildren(); return; }
    await flushSave();
    clearTimeout(cleanTimer);
    try {
      const loaded = await window.chatStorage.studioChapter(project.id, chapterId);
      chapter = loaded;
      dirty = false;
      const draft = $('studio-draft');
      if (draft.value !== loaded.draft) draft.value = loaded.draft;
      renderClean();
      renderChapters();
      if (project.focus !== chapterId) {
        project.focus = chapterId;
        window.chatStorage.studioFocus(project.id, chapterId).catch(() => {});
      }
      if (project.settings?.auto && loaded.paragraphs.some(p => p.stale && p.draft.trim())) scheduleClean();
    } catch (error) { showError(error.message); }
  }

  /** The clean sheet: one block per paragraph, editable, marked when it is behind the draft or the author's own. */
  function renderClean() {
    const box = $('studio-clean');
    box.replaceChildren();
    if (!chapter) return;
    if (!chapter.paragraphs.length) { box.append(el('p', 'studio-clean-empty', 'studio.cleanEmpty')); return; }
    chapter.paragraphs.forEach(p => {
      const block = el('div', 'studio-para' + (p.stale ? ' is-stale' : '') + (p.own ? ' is-own' : ''));
      block.dataset.id = p.id;
      block.dataset.index = String(p.index);
      const number = el('span', 'studio-para-number', null, String(p.index));
      number.title = t(p.stale ? (p.clean ? 'studio.paraStale' : 'studio.paraWaiting') : p.own ? 'studio.paraOwn' : 'studio.paraClean');
      number.addEventListener('click', () => locateDraft(p.index));
      const text = el('div', 'studio-para-text', null, p.clean || '');
      text.contentEditable = 'plaintext-only';
      text.spellcheck = true;
      if (!p.clean) { text.setAttribute('data-placeholder', t(p.draft.trim() ? 'studio.paraWaiting' : 'studio.paraEmpty')); }
      text.addEventListener('blur', () => void commitClean(p.id, text));
      text.addEventListener('keydown', event => { if (event.key === 'Escape') { text.textContent = p.clean || ''; text.blur(); } });
      block.append(number, text);
      box.append(block);
    });
  }

  async function commitClean(paragraphId, node) {
    if (!chapter || !project) return;
    const p = chapter.paragraphs.find(x => x.id === paragraphId);
    const value = node.innerText.replace(/ /g, ' ').trim();
    if (!p || value === (p.clean || '').trim()) return;
    try {
      const updated = await window.chatStorage.studioEditClean(project.id, chapter.id, paragraphId, value);
      applyChapter(updated);
      scheduleMap();
    } catch (error) { showError(error.message); }
  }

  /** Where the n-th paragraph starts and ends in the draft sheet, as the service splits it. */
  function draftRanges(text) {
    const ranges = [];
    const re = /\n[ \t]*\n+/g;
    let start = 0, match;
    const push = (from, to) => { const slice = text.slice(from, to); if (slice.trim()) { const lead = slice.length - slice.replace(/^\s+/, '').length; const trail = slice.length - slice.replace(/\s+$/, '').length; ranges.push({ from: from + lead, to: to - trail }); } };
    while ((match = re.exec(text))) { push(start, match.index); start = match.index + match[0].length; }
    push(start, text.length);
    return ranges;
  }

  function locateDraft(index) {
    const draft = $('studio-draft');
    const text = draft.value.replace(/\r\n?/g, '\n');
    const ranges = draftRanges(text);
    const range = ranges[index - 1];
    if (!range) return;
    draft.focus();
    draft.setSelectionRange(range.from, range.to);
    // Scroll so the paragraph is in view: the line height is what the browser says it is.
    const before = text.slice(0, range.from).split('\n').length - 1;
    const lineHeight = parseFloat(getComputedStyle(draft).lineHeight) || 22;
    draft.scrollTop = Math.max(0, before * lineHeight - draft.clientHeight / 3);
  }

  function applyChapter(updated) {
    if (!chapter || updated.id !== chapter.id) return;
    chapter = { ...updated, draft: chapter.draft };
    renderClean();
    const entry = project?.chapters.find(c => c.id === chapter.id);
    if (entry) { entry.words = updated.words; entry.pending = updated.paragraphs.filter(p => p.stale && p.draft.trim()).length; entry.paragraphs = updated.paragraphs.length; }
    project.words = project.chapters.reduce((a, c) => a + (c.words || 0), 0);
    $('studio-active-words').textContent = t('studio.words', { count: project.words });
    renderChapters();
  }

  function onDraftInput() {
    if (!chapter) return;
    if (!dirty) { dirty = true; window.codeWorkspace?.fileChanged?.(); }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), SAVE_QUIET_MS);
    if (project?.settings?.auto) scheduleClean();
  }

  /** The draft to the service, once the burst of typing ends; the clean sheet follows. */
  async function save() {
    clearTimeout(saveTimer);
    if (!dirty || !chapter || !project) return saving;
    if (saving) { await saving; return save(); }
    const chapterId = chapter.id;
    const value = $('studio-draft').value;
    dirty = false;
    saving = (async () => {
      try {
        const updated = await window.chatStorage.studioSaveDraft(project.id, chapterId, value);
        if (chapter && chapter.id === chapterId) { chapter.draft = value; applyChapter(updated); }
        if (updated.git) project.git = updated.git;
        scheduleMap();
      } catch (error) { dirty = true; showError(error.message); }
      finally { saving = null; window.codeWorkspace?.fileChanged?.(); }
    })();
    return saving;
  }

  async function flushSave() {
    if (dirty) await save();
    else if (saving) await saving;
  }

  function scheduleClean() {
    clearTimeout(cleanTimer);
    const pause = Number(project?.settings?.pauseMs) || 4000;
    cleanTimer = setTimeout(() => void clean(), pause);
  }

  /** The chat whose models this project's corrections are billed to and made with: the one in the panel. */
  function panelConversation() {
    const current = window.chatManager?.conversation;
    return current && project && current.project_id === project.id ? current : null;
  }

  async function askMaster(messages, maxTokens) {
    const conversation = panelConversation();
    const registry = window.chatManager?.registryFor ? window.chatManager.registryFor(conversation) : window.operationalRegistry;
    const master = registry?.getCurrentMasterModel?.();
    const modelId = master?.id || registry?.getSelectedMasterId?.();
    const apiKey = window.openRouterCatalog?.getApiKey?.() || (window.modelGateway?.isLocal?.(modelId) ? 'local' : '');
    if (!modelId || !apiKey) throw new Error(t('realtime.noKey'));
    const response = await window.modelGateway.fetchChat({
      method: 'POST',
      registry,
      track: { conversationId: conversation?.id || null, role: 'master' },
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://synthorg.local', 'X-Title': 'SynthOrg Studio' },
      body: JSON.stringify({ model: modelId, messages, stream: false, max_tokens: maxTokens, temperature: 0.2 }),
      signal: AbortSignal.timeout(240000)
    });
    if (!response.ok) throw new Error(`${t('studio.modelError')} (${response.status}): ${(await response.text()).slice(0, 200)}`);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error(t('studio.modelEmpty'));
    return content.replace(/<(think|thought|reasoning|reflection)[^>]*>[\s\S]*?<\/\1>/gi, '').trim();
  }

  /**
   * The correction of this chapter: the stale paragraphs go to the model in
   * batches until none is left, each answer kept only for the paragraphs the
   * author did not touch meanwhile.
   */
  async function clean() {
    clearTimeout(cleanTimer);
    if (!project || !chapter) return;
    if (cleaning) { cleanAgain = true; return; }
    cleaning = true;
    const chapterId = chapter.id;
    try {
      await flushSave();
      for (let round = 0; round < CLEAN_ROUNDS; round++) {
        if (!chapter || chapter.id !== chapterId) break;
        const { request } = await window.chatStorage.studioCleanRequest(project.id, chapterId);
        if (!request) break;
        setState('studio.stateCleaning', { count: request.ids.length });
        const text = await askMaster(request.messages, request.maxTokens);
        const updated = await window.chatStorage.studioCleanApply(project.id, chapterId, text, request.hashes);
        if (chapter && chapter.id === chapterId) applyChapter(updated);
        if (updated.git) project.git = updated.git;
        if (!updated.applied) break;
      }
      setState(null);
      scheduleMap();
    } catch (error) {
      setState('studio.stateCleanFailed', {}, false);
      showError(error.message);
      setTimeout(() => { if ($('studio-state-text').textContent === t('studio.stateCleanFailed')) setState(null); }, 6000);
    } finally {
      cleaning = false;
      if (cleanAgain) { cleanAgain = false; scheduleClean(); }
    }
  }

  // --- the map of the text ---------------------------------------------------------

  function scheduleMap() {
    clearTimeout(mapTimer);
    mapTimer = setTimeout(() => void updateMap(), MAP_QUIET_MS);
  }

  function parseNode(reply) {
    const body = String(reply || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    try {
      const parsed = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
      const content = String(parsed.summary || '').trim();
      if (!content) return null;
      return { title: String(parsed.title || '').trim().slice(0, 120), content, facts: Array.isArray(parsed.facts) ? parsed.facts.map(String).filter(Boolean).slice(0, 20) : [] };
    } catch { return null; }
  }

  /** The nodes the service says are missing, written by the Microtask model; a model that does not answer ends the run. */
  async function updateMap(force = false) {
    clearTimeout(mapTimer);
    if (!project) return;
    if (mapping) { mapAgain = true; return; }
    mapping = true;
    const projectId = project.id;
    try {
      const conversation = panelConversation();
      const registry = window.chatManager?.registryFor ? window.chatManager.registryFor(conversation) : window.operationalRegistry;
      for (let round = 0; round < 10; round++) {
        if (!project || project.id !== projectId) break;
        const pending = await window.chatStorage.studioPending(projectId, 6);
        if (!pending.length) break;
        let done = 0;
        for (const item of pending) {
          const instructions = item.level === 1
            ? 'Riassumi questa parte di un testo (una scena, dei paragrafi numerati) per la mappa che il modello usa per orientarsi nel libro. Rispondi solo con un oggetto JSON: {"title": "un titolo breve della scena", "summary": "3-5 frasi: cosa succede, chi c’è, dove e quando, cosa cambia", "facts": ["nomi, luoghi, oggetti, date e fatti stabiliti, copiati testuali"]}. Scrivi nella lingua del testo. Non aggiungere niente che il testo non dica.'
            : item.level === 2
              ? `Unisci questi riassunti di scene consecutive del capitolo «${item.chapterTitle}» in un riassunto del capitolo. Rispondi solo con un oggetto JSON: {"title": "un titolo breve del capitolo, se il suo non basta", "summary": "il filo del capitolo in poche frasi", "facts": ["i fatti che restano importanti, copiati testuali, al massimo 12"]}. Scrivi nella lingua dei riassunti.`
              : 'Unisci questi riassunti di capitoli consecutivi in un riassunto della parte. Rispondi solo con un oggetto JSON: {"title": "un titolo breve della parte", "summary": "il filo di questi capitoli in poche frasi", "facts": ["i fatti che restano importanti, copiati testuali, al massimo 12"]}. Scrivi nella lingua dei riassunti.';
          const reply = await window.chatManager.callMicrotaskModel([{ role: 'system', content: instructions }, { role: 'user', content: item.text.slice(0, 24000) }], { maxTokens: 1500, registry, conversationId: conversation?.id || null });
          const made = parseNode(reply);
          if (!made) { round = 10; break; }
          await window.chatStorage.studioAddNode(projectId, { key: item.key, hash: item.hash, ...made });
          done++;
        }
        if (!done) break;
      }
    } catch (error) { if (force) showError(error.message); }
    finally {
      mapping = false;
      if (mapAgain) { mapAgain = false; scheduleMap(); }
    }
  }

  async function openMapDialog() {
    if (!project) return;
    $('studio-map-dialog').showModal();
    await renderMap();
  }

  async function renderMap() {
    const list = $('studio-map-list');
    list.replaceChildren(el('p', 'conversation-empty', 'code.projectsLoading'));
    try {
      const tree = await window.chatStorage.studioTree(project.id);
      list.replaceChildren();
      if (!tree.nodes.length) { list.append(el('p', 'conversation-empty', 'studio.mapEmpty')); return; }
      for (const node of tree.nodes.slice().sort((a, b) => b.level - a.level || a.chapter - b.chapter || a.first - b.first)) {
        const row = el('div', `studio-map-node is-level-${node.level} is-${node.state}`);
        const label = node.level === 3 ? t('studio.mapPart', { from: node.first, to: node.last }) : node.level === 2 ? t('studio.mapChapter', { n: node.chapter, title: node.chapterTitle }) : t('studio.mapScene', { n: node.chapter, from: node.first, to: node.last });
        const head = el('div', 'studio-map-head');
        head.append(el('strong', '', null, label + (node.title ? ` · ${node.title}` : '')), el('span', 'code-kind-badge', `studio.mapState_${node.state}`));
        row.append(head);
        if (node.content) row.append(el('p', 'studio-map-summary', null, node.content));
        if (node.facts?.length) row.append(el('p', 'studio-map-facts', null, t('studio.mapFacts') + ' ' + node.facts.join('; ')));
        list.append(row);
      }
    } catch (error) { list.replaceChildren(el('p', 'code-new-error', null, error.message)); }
  }

  // --- the typeset pages -------------------------------------------------------------

  function showPdf(visible) {
    pdfShown = visible;
    $('studio-pdf-pane').hidden = !visible;
    const button = $('studio-pdf-toggle');
    button.setAttribute('aria-pressed', String(visible));
    if (visible && pdfDoc) void drawPdf();
  }

  function pdfStatus(key, params) {
    $('studio-pdf-status').textContent = key ? t(key, params) : '';
  }

  function pdfHelp({ text = '', warm = false, log = false } = {}) {
    const box = $('studio-pdf-help');
    box.hidden = !text;
    $('studio-pdf-help-text').textContent = text;
    $('studio-tex-warm').hidden = !warm;
    $('studio-pdf-log').hidden = !log;
    $('studio-pdf-log-text').hidden = true;
  }

  async function compile() {
    if (!project) return;
    await flushSave();
    showPdf(true);
    pdfHelp();
    try {
      const status = await window.chatStorage.studioCompile(project.id);
      followCompile(status);
    } catch (error) { pdfStatus('studio.pdfFailed'); pdfHelp({ text: error.message }); }
  }

  function followCompile(status) {
    clearInterval(compilePoll);
    renderCompile(status);
    if (status.state !== 'running') return;
    compilePoll = setInterval(async () => {
      if (!project) { clearInterval(compilePoll); return; }
      try {
        const next = await window.chatStorage.studioCompileStatus(project.id);
        renderCompile(next);
        if (next.state !== 'running') { clearInterval(compilePoll); if (next.state === 'done') void loadPdf(); }
      } catch (error) { clearInterval(compilePoll); pdfStatus('studio.pdfFailed'); pdfHelp({ text: error.message }); }
    }, 1000);
  }

  async function refreshCompile() {
    if (!project) return;
    try { followCompile(await window.chatStorage.studioCompileStatus(project.id)); } catch {}
  }

  const PHASES = { starting: 'studio.phaseStarting', engine: 'studio.phaseEngine', image: 'studio.phaseImage', compile: 'studio.phaseCompile', cache: 'studio.phaseCache' };

  function renderCompile(status) {
    const button = $('studio-compile');
    button.disabled = status.state === 'running';
    if (status.state === 'running') { pdfStatus(PHASES[status.phase] || 'studio.phaseStarting'); return; }
    if (status.state === 'failed') {
      pdfStatus('studio.pdfFailed');
      if (status.needsCache) pdfHelp({ text: t('studio.texMissing'), warm: true, log: true });
      else pdfHelp({ text: status.error || t('studio.pdfFailed'), log: true });
      return;
    }
    if (status.pdf) pdfStatus('studio.pdfAt', { date: new Date(status.pdf.at).toLocaleString(window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT', { dateStyle: 'medium', timeStyle: 'short' }) });
    else pdfStatus('studio.pdfNone');
    if (status.warnings?.length) pdfHelp({ text: t('studio.pdfWarnings', { count: status.warnings.length }), log: true });
    else pdfHelp();
  }

  async function showLog() {
    if (!project) return;
    const pre = $('studio-pdf-log-text');
    try {
      const { log, error } = await window.chatStorage.studioCompileLog(project.id);
      pre.textContent = [error, log].filter(Boolean).join('\n\n') || '(vuoto)';
      pre.hidden = !pre.hidden;
    } catch (err) { pre.textContent = err.message; pre.hidden = false; }
  }

  /** The TeX packages, once: started from the pages or from the settings; the compile that needed them runs again after. */
  async function warmTex(thenCompile) {
    try {
      pdfStatus('studio.phaseCache');
      pdfHelp({ text: t('studio.texDownloading') });
      await window.chatStorage.studioWarmTex();
      clearInterval(warmPoll);
      warmPoll = setInterval(async () => {
        try {
          const status = await window.chatStorage.studioTex();
          renderTexStatus(status);
          const warm = status.warm;
          if (!warm || warm.state === 'running') { pdfHelp({ text: t('studio.texDownloading') + (warm?.phase ? ` (${t(PHASES[warm.phase] || 'studio.phaseCache')})` : '') }); return; }
          clearInterval(warmPoll);
          if (warm.state === 'done') { pdfHelp(); if (thenCompile) await compile(); else pdfStatus('studio.texReady'); }
          else { pdfStatus('studio.pdfFailed'); pdfHelp({ text: `${t('studio.texFailed')} ${warm.error || ''}` }); }
        } catch (error) { clearInterval(warmPoll); pdfHelp({ text: error.message }); }
      }, 2000);
    } catch (error) { pdfHelp({ text: error.message, warm: true }); }
  }

  async function loadPdfLib() {
    if (pdfLib) return pdfLib;
    pdfLib = await import(PDFJS_URL);
    pdfLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return pdfLib;
  }

  async function loadPdf() {
    if (!project) return;
    try {
      const data = await window.chatStorage.studioPdf(project.id);
      const lib = await loadPdfLib();
      const doc = await lib.getDocument({ data }).promise;
      if (pdfDoc) { try { await pdfDoc.destroy(); } catch {} }
      pdfDoc = doc;
      pdfAt = Date.now();
      await drawPdf();
    } catch (error) { pdfStatus('studio.pdfFailed'); pdfHelp({ text: error.message }); }
  }

  /** Every page as a canvas, as wide as the pane, drawn at the screen's density. */
  async function drawPdf() {
    const pages = $('studio-pdf-pages');
    if (!pdfDoc || !pdfShown) return;
    const token = ++pdfRenderToken;
    pages.replaceChildren();
    const width = Math.max(200, pages.clientWidth - 24);
    const ratio = window.devicePixelRatio || 1;
    for (let n = 1; n <= pdfDoc.numPages; n++) {
      if (token !== pdfRenderToken || !pdfDoc) return;
      const page = await pdfDoc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const viewport = page.getViewport({ scale: scale * ratio });
      const canvas = document.createElement('canvas');
      canvas.className = 'studio-pdf-page';
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
      canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
      pages.append(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }
  }

  // --- export, settings, permissions --------------------------------------------------

  async function exportAs(what) {
    if (!project) return;
    const out = $('studio-export-result');
    out.textContent = t('studio.exporting');
    try {
      const result = await window.chatStorage.studioExport(project.id, what);
      out.textContent = t('studio.exported', { path: result.path });
    } catch (error) { out.textContent = error.message; }
  }

  function renderTexStatus(status) {
    const box = $('studio-tex-status');
    if (!box) return;
    if (!status.engine) box.textContent = t('studio.texNoEngine');
    else if (status.warm?.state === 'running') box.textContent = t('studio.texDownloading');
    else if (status.warm?.state === 'failed') box.textContent = `${t('studio.texFailed')} ${status.warm.error || ''}`;
    else box.textContent = t(status.warmed ? 'studio.texReady' : 'studio.texMissingShort');
  }

  async function openSettings() {
    if (!project) return;
    $('studio-set-title').value = project.title || '';
    $('studio-set-author').value = project.author || '';
    $('studio-set-type').value = project.type;
    $('studio-set-language').value = project.language;
    $('studio-set-pause').value = String(Math.round((project.settings.pauseMs || 4000) / 1000));
    $('studio-set-cap').value = String(project.settings.cap);
    $('studio-set-share').value = String(project.settings.share);
    $('studio-settings-error').textContent = '';
    $('studio-tex-status').textContent = '…';
    $('studio-settings-dialog').showModal();
    try { renderTexStatus(await window.chatStorage.studioTex()); } catch (error) { $('studio-tex-status').textContent = error.message; }
  }

  async function submitSettings(event) {
    event.preventDefault();
    if (!project) return;
    try {
      const overview = await window.chatStorage.studioSettings(project.id, {
        title: $('studio-set-title').value, author: $('studio-set-author').value,
        type: $('studio-set-type').value, language: $('studio-set-language').value,
        pauseMs: Number($('studio-set-pause').value) * 1000, cap: Number($('studio-set-cap').value), share: Number($('studio-set-share').value)
      });
      project = { ...overview, git: project.git };
      render();
      $('studio-settings-dialog').close();
    } catch (error) { $('studio-settings-error').textContent = error.message; }
  }

  async function setAuto(on) {
    if (!project) return;
    try {
      const overview = await window.chatStorage.studioSettings(project.id, { auto: on });
      project = { ...overview, git: project.git };
      if (on && chapter?.paragraphs.some(p => p.stale && p.draft.trim())) scheduleClean();
      else clearTimeout(cleanTimer);
    } catch (error) { showError(error.message); $('studio-auto').checked = Boolean(project.settings.auto); }
  }


  // --- the project's chat, moved in beside the sheets ----------------------------------

  let chatHome = null;
  let generalChat = null;

  // --- the text in the project's frame ---------------------------------------------------
  // The frame of an open project (code-workspace.js) is what opens the project, holds its chat
  // and its files; this is the text of it: attached when the project has Writing on, shown when
  // the text is what is in the middle.

  /** The text of a project, read and laid on the sheets; a folder with no text yet gets its first chapter. */
  async function attach(id, title = '') {
    if (project?.id === id) return true;
    if (busy) return false;
    if (project) await detach();
    busy = true;
    try {
      let overview;
      try { overview = await window.chatStorage.studioOverview(id); }
      catch (error) {
        if (!/non contiene ancora/.test(error.message)) throw error;
        await window.chatStorage.studioInit(id, { title });
        overview = await window.chatStorage.studioOverview(id);
      }
      project = overview;
      chapter = null;
      dirty = false;
      pdfDoc = null; pdfAt = null;
      $('studio-pdf-pages').replaceChildren();
      showError('');
      render();
      await selectChapter(project.focus || project.chapters[0]?.id);
      if (project.compile?.pdf) { showPdf(true); void loadPdf(); }
      void refreshCompile();
      return true;
    } catch (error) {
      showError(error.message);
      return false;
    } finally { busy = false; }
  }

  /** The project is left: what was being written is saved, and the sheets are emptied. */
  async function detach() {
    if (!project) return;
    await flushSave();
    clearTimeout(cleanTimer);
    clearInterval(compilePoll);
    project = null;
    chapter = null;
    if (pdfDoc) { try { await pdfDoc.destroy(); } catch {} pdfDoc = null; }
    showError('');
  }

  // The size of the text of the two sheets, as a percentage: asked from the bar, the same for every text.
  const ZOOM_KEY = 'synthorg_studio_zoom';
  let zoom = 100;
  try { const kept = Number(localStorage.getItem(ZOOM_KEY)); if (kept >= 60 && kept <= 250) zoom = kept; } catch {}
  function applyZoom() {
    document.documentElement.style.setProperty('--studio-zoom', String(zoom / 100));
  }
  applyZoom();

  window.studio = {
    /** The project whose text is in view, for what goes along with the work on it. */
    current() { return project && active ? { id: project.id, name: project.title || project.project.name } : null; },
    attach,
    detach,
    /** The chapter kept in a file of the project's folder, laid on the sheets. */
    async openChapter(id) {
      if (!project || !project.chapters.some(item => item.id === id)) return false;
      await selectChapter(id);
      return true;
    },
    /** The chapter on the sheets, as the file it is kept in. */
    chapterFile() { return chapter ? `capitoli/${chapter.id}.json` : null; },
    /**
     * What the bar over the sheets shows and asks. The chapter on the sheets is its one tab, by its title; the zoom is
     * the size of the text of the two sheets, kept on this computer.
     */
    bar() {
      const file = chapter ? `capitoli/${chapter.id}.json` : null;
      const title = chapter && project?.chapters.find(item => item.id === chapter.id)?.title;
      return { files: file ? [{ path: file, name: title || null, dirty: dirty || Boolean(saving), fixed: true }] : [], shown: file, zoom: zoom };
    },
    zoom(what) {
      zoom = what === 'zoomReset' ? 100 : Math.max(60, Math.min(250, zoom + (what === 'zoomIn' ? 10 : -10)));
      applyZoom();
      try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch {}
    },
    addChapter() { if (project) openChapterDialog('add'); },
    /** The settings of the text, asked from the bar. */
    settings() { return openSettings(); },
    /** Export, asked from the bar: the formats to choose from. */
    exportDialog() { if (project) { $('studio-export-result').textContent = ''; $('studio-export-dialog').showModal(); } },
    renameChapter() {
      const item = chapter && project?.chapters.find(entry => entry.id === chapter.id);
      if (item) openChapterDialog('rename', item);
    },
    save: flushSave,
    /** A model just changed the text through its tools: the sheets catch up. */
    async noteToolChange() {
      if (!project) return;
      await flushSave();
      const current = chapter?.id;
      await refreshOverview();
      if (current && project.chapters.some(c => c.id === current)) {
        try {
          const loaded = await window.chatStorage.studioChapter(project.id, current);
          chapter = loaded;
          const draft = $('studio-draft');
          if (draft.value !== loaded.draft && !dirty) draft.value = loaded.draft;
          renderClean();
        } catch (error) { showError(error.message); }
      } else if (project.chapters.length) await selectChapter(project.focus || project.chapters[0].id);
      scheduleMap();
    },
    /** The text in view or not: out of view, what was being written is saved. */
    async setActive(on) {
      active = on;
      if (!on) await flushSave();
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    $('studio-chapter-add').addEventListener('click', () => openChapterDialog('add'));
    $('studio-chapter-form').addEventListener('submit', event => void submitChapter(event));
    $('studio-chapter-close').addEventListener('click', () => $('studio-chapter-dialog').close());
    $('studio-chapter-cancel').addEventListener('click', () => $('studio-chapter-dialog').close());
    $('studio-draft').addEventListener('input', onDraftInput);
    $('studio-draft').addEventListener('blur', () => void save());
    $('studio-draft').addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save().then(() => clean()); }
    });
    $('studio-auto').addEventListener('change', event => void setAuto(event.target.checked));
    $('studio-clean-now').addEventListener('click', () => void clean());
    $('studio-compile').addEventListener('click', () => void compile());
    $('studio-pdf-toggle').addEventListener('click', () => showPdf($('studio-pdf-pane').hidden));
    $('studio-tex-warm').addEventListener('click', () => void warmTex(true));
    $('studio-pdf-log').addEventListener('click', () => void showLog());
    $('studio-export-close').addEventListener('click', () => $('studio-export-dialog').close());
    document.querySelectorAll('#studio-export-dialog .code-kind-option').forEach(option => option.addEventListener('click', () => void exportAs(option.dataset.what)));
    $('studio-map').addEventListener('click', () => void openMapDialog());
    $('studio-map-close').addEventListener('click', () => $('studio-map-dialog').close());
    $('studio-map-refresh').addEventListener('click', async () => { await updateMap(true); await renderMap(); });
    $('studio-settings-close').addEventListener('click', () => $('studio-settings-dialog').close());
    $('studio-settings-cancel').addEventListener('click', () => $('studio-settings-dialog').close());
    $('studio-settings-form').addEventListener('submit', event => void submitSettings(event));
    $('studio-tex-warm-settings').addEventListener('click', () => void warmTex(false));
    $('studio-tex-drop').addEventListener('click', async () => {
      const ok = await window.chatWorkspace.confirmAction({ title: t('studio.texDrop'), message: t('studio.texDropMessage'), confirmText: t('studio.texDrop') });
      if (!ok) return;
      try { await window.chatStorage.request('/studio/tex', 'DELETE'); renderTexStatus(await window.chatStorage.studioTex()); } catch (error) { $('studio-settings-error').textContent = error.message; }
    });
    let resizeTimer = null;
    new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (pdfDoc && pdfShown) void drawPdf(); }, 200); }).observe($('studio-pdf-pages'));
    window.addEventListener('pagehide', () => { if (dirty) void save(); });
  });
})();
