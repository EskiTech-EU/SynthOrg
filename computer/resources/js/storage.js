/* Local SQL service. Browser storage is used only to import the legacy chat. */
(function () {
  'use strict';
  class ChatStorage {
    constructor() {
      this.base = 'http://127.0.0.1:4319/api';
      this._session = null;
    }
    /**
     * Session token for the local storage service. The desktop shell generates
     * it per run and hands it over the Tauri IPC, so it never touches disk and
     * no other local process can drive the API.
     */
    session() {
      if (!this._session) {
        this._session = (async () => {
          const invoke = window.__TAURI__?.core?.invoke;
          if (!invoke) return { token: '', origin: 'http://127.0.0.1:4319' };
          // The service binds whatever port the OS gives it and reports it back,
          // so the first calls can land before it has started listening.
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const info = await invoke('session_info');
            if (info && info.origin) {
              this.base = `${info.origin}/api`;
              window.SYNTHORG_STORAGE_ORIGIN = info.origin;
              return info;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          throw new Error(await this.unreachableReason());
        })().catch((error) => {
          this._session = null;
          throw error instanceof Error ? error : new Error(String(error));
        });
      }
      return this._session;
    }
    /**
     * Why the storage service did not answer.
     *
     * A failed request only tells the webview that nothing replied; the reason
     * is in the service's own output, which the desktop shell captures. The
     * common case is a previous instance still holding the port, and saying so
     * is the difference between a fixable message and a dead end.
     */
    async unreachableReason() {
      const base = 'Archivio locale non raggiungibile.';
      try {
        const invoke = window.__TAURI__?.core?.invoke;
        if (!invoke) return `${base} Riavvia SynthOrg e riprova.`;
        const status = await invoke('storage_status');
        const detail = String(status?.detail || '').trim();
        if (detail) {
          const lastLine = detail.split('\n').map(line => line.trim()).filter(Boolean).pop();
          if (lastLine) return `${base} ${lastLine}`;
        }
        if (!status?.running) return `${base} Il servizio si è arrestato all'avvio. Riavvia SynthOrg.`;
        return `${base} Riavvia SynthOrg e riprova.`;
      } catch {
        return `${base} Riavvia SynthOrg e riprova.`;
      }
    }

    async request(route, method = 'GET', data, timeoutMs = 15000) {
      // On the phone the archive is the computer's, through the app's shell: its IPC carries what
      // is written, which a request of the webview to the app's own address loses (android/).
      if (window.SYNTHORG_REMOTE && window.__TAURI__?.core?.invoke) {
        let got;
        try {
          got = await window.__TAURI__.core.invoke('archive_request', { method, path: '/api' + route, body: data === undefined ? null : data });
        } catch (error) { throw new Error(error?.message || String(error)); }
        if (got.status >= 400) throw new Error(got.data?.error || 'Errore nell’archivio del computer.');
        return got.data;
      }
      const { token } = await this.session();
      let response;
      try {
        response = await fetch(this.base + route, {
          method,
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(data === undefined ? {} : { 'Content-Type': 'application/json' })
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(timeoutMs)
        });
      } catch { throw new Error(await this.unreachableReason()); }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Errore nell’archivio locale.');
      return result;
    }
    async initialize() {
      await this.request('/health');
      let legacy;
      try { legacy = localStorage.getItem('synthorg_chat_history'); } catch {}
      if (legacy) {
        let messages;
        try {
          messages = JSON.parse(legacy);
          return await this.request('/import', 'POST', { messages });
        } catch (error) { return { imported: false, warning: `Importazione della vecchia chat non riuscita; l’originale è conservato. ${error.message}` }; }
      }
      return { imported: false };
    }
    list(query = '', archived = false) { return this.request(`/conversations?q=${encodeURIComponent(query)}&archived=${archived}`); }
    // What was written in the archive after a number, waiting up to `waitMs` for it (sync.js).
    changes(epoch, after, waitMs = 0) {
      return this.request(`/changes?epoch=${encodeURIComponent(epoch || '')}&after=${Number(after) || 0}&wait=${Math.max(0, Math.floor(waitMs))}`, 'GET', undefined, waitMs + 15000);
    }
    create(projectId = null, title) {
      return this.request('/conversations', 'POST', { ...(title ? { title } : {}), ...(projectId ? { projectId } : {}) });
    }
    // The chats that belong to a Code project, which the general list leaves out.
    listProjectChats(projectId) { return this.request(`/conversations?project=${encodeURIComponent(projectId)}`); }
    get(id) { return this.request(`/conversations/${encodeURIComponent(id)}`); }
    // The conversation without its messages: what a turn that starts from nothing runs on.
    getBare(id) { return this.request(`/conversations/${encodeURIComponent(id)}?messages=none`); }
    // The messages of a conversation after one, and the last there is: a conversation without end is not read whole.
    messagesAfter(id, sequence = 0, limit = 2000) { return this.request(`/conversations/${encodeURIComponent(id)}/messages?after=${Number(sequence) || 0}&limit=${limit}`); }
    // The Realtime character's conversation and the chat of its tasks, made on first use; forget: all of it gone.
    realtime() { return this.request('/realtime'); }
    realtimeForget() { return this.request('/realtime/forget', 'POST', {}); }
    // The agenda (reminders and activities) and the diary: local, deletable.
    agenda(from, to) {
      const q = new URLSearchParams();
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      return this.request('/agenda?' + q.toString());
    }
    saveAgenda(data, id) { return this.request('/agenda' + (id ? `/${encodeURIComponent(id)}` : ''), id ? 'PUT' : 'POST', data); }
    deleteAgenda(id) { return this.request(`/agenda/${encodeURIComponent(id)}`, 'DELETE'); }
    dueReminders(now) { return this.request('/agenda/due', 'POST', { now }); }
    // fields: 'days' for the days alone, 'data' for the day's data without account and page.
    diary(from, to, limit, fields) {
      const q = new URLSearchParams();
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      if (limit) q.set('limit', String(limit));
      if (fields) q.set('fields', fields);
      return this.request('/diary?' + q.toString());
    }
    diaryCount() { return this.request('/diary/count'); }
    saveDiary(data, id) { return this.request('/diary' + (id ? `/${encodeURIComponent(id)}` : ''), id ? 'PUT' : 'POST', data); }
    deleteDiary(id) { return this.request(`/diary/${encodeURIComponent(id)}`, 'DELETE'); }
    deleteAllDiary() { return this.request('/diary', 'DELETE'); }
    // The habits followed, what they did day by day, and the reviews of a period.
    habits() { return this.request('/habits'); }
    saveHabit(data, id) { return this.request('/habits' + (id ? `/${encodeURIComponent(id)}` : ''), id ? 'PUT' : 'POST', data); }
    deleteHabit(id) { return this.request(`/habits/${encodeURIComponent(id)}`, 'DELETE'); }
    habitDays(from, to) { return this.request(`/habits/days?from=${encodeURIComponent(from || '')}&to=${encodeURIComponent(to || '')}`); }
    markHabit(habitId, day, done) { return this.request('/habits/days', 'PUT', { habitId, day, done }); }
    setDiaryMarks(day, marks) { return this.request('/habits/days', 'POST', { day, marks }); }
    reviews(limit = 12) { return this.request(`/reviews?limit=${limit}`); }
    saveReview(data) { return this.request('/reviews', 'POST', data); }
    deleteReview(id) { return this.request(`/reviews/${encodeURIComponent(id)}`, 'DELETE'); }
    // The goals, with their steps, and what was done in the app day by day (steps of the projects, messages).
    goals() { return this.request('/goals'); }
    saveGoal(data, id) { return this.request('/goals' + (id ? `/${encodeURIComponent(id)}` : ''), id ? 'PUT' : 'POST', data); }
    deleteGoal(id) { return this.request(`/goals/${encodeURIComponent(id)}`, 'DELETE'); }
    saveGoalStep(goalId, data, id) { return this.request(`/goals/${encodeURIComponent(goalId)}/steps` + (id ? `/${encodeURIComponent(id)}` : ''), id ? 'PUT' : 'POST', data); }
    deleteGoalStep(goalId, id) { return this.request(`/goals/${encodeURIComponent(goalId)}/steps/${encodeURIComponent(id)}`, 'DELETE'); }
    activity(from, to) { return this.request(`/activity?from=${encodeURIComponent(from || '')}&to=${encodeURIComponent(to || '')}`, 'GET', undefined, 120000); }
    // What a model proposed for the agenda, the past days read for new habits, and what the background jobs cost.
    agendaProposals() { return this.request('/agenda/proposals'); }
    addDiaryMarks(marks) { return this.request('/habits/past', 'POST', { marks }); }
    recordJob(data) { return this.request('/jobs', 'POST', data); }
    jobs(from, to) { return this.request(`/jobs?from=${encodeURIComponent(from || '')}&to=${encodeURIComponent(to || '')}`); }
    // The character's notices while the user works, the pauses taken and the ones liked.
    notices(day) { return this.request(`/notices?day=${encodeURIComponent(day || '')}`); }
    recordNotice(data) { return this.request('/notices', 'POST', data); }
    answerNotice(id, answer) { return this.request(`/notices/${encodeURIComponent(id)}`, 'PUT', { answer }); }
    signals(projectId, hours = 8) { return this.request(`/notices/signals?project=${encodeURIComponent(projectId)}&hours=${hours}`); }
    pauses(from, to) { return this.request(`/pauses?from=${encodeURIComponent(from || '')}&to=${encodeURIComponent(to || '')}`); }
    startPause(data) { return this.request('/pauses', 'POST', data); }
    endPause(id) { return this.request(`/pauses/${encodeURIComponent(id)}`, 'PUT', {}); }
    deletePause(id) { return this.request(`/pauses/${encodeURIComponent(id)}`, 'DELETE'); }
    deleteNotice(id) { return this.request(`/notices/${encodeURIComponent(id)}`, 'DELETE'); }
    openPause() { return this.request('/pauses/open'); }
    likedPauses() { return this.request('/pauses/liked'); }
    saveLikedPause(data, id) { return this.request('/pauses/liked' + (id ? `/${encodeURIComponent(id)}` : ''), id ? 'PUT' : 'POST', data); }
    deleteLikedPause(id) { return this.request(`/pauses/liked/${encodeURIComponent(id)}`, 'DELETE'); }
    // The files the Master made for the character's tasks, handed to the user in its section.
    handedFiles({ limit = 30, before = '', query = '', kind = '' } = {}) {
      return this.request(`/handed?limit=${Number(limit) || 30}&before=${encodeURIComponent(before || '')}&q=${encodeURIComponent(query || '')}&kind=${encodeURIComponent(kind || '')}`);
    }
    handFile(data) { return this.request('/handed', 'POST', data); }
    seeFile(id) { return this.request(`/handed/${encodeURIComponent(id)}`, 'PUT', {}); }
    dropFile(id) { return this.request(`/handed/${encodeURIComponent(id)}`, 'DELETE'); }
    // What the models cost and how they do; the numbers are shared only when the user says so, each time.
    usage(from, to, projectId = null) { return this.request(`/usage?from=${encodeURIComponent(from || '')}&to=${encodeURIComponent(to || '')}${projectId ? `&project=${encodeURIComponent(projectId)}` : ''}`); }
    usageByProject() { return this.request('/usage/projects'); }
    usageOfChat(conversationId, day) { return this.request(`/usage/chat?id=${encodeURIComponent(conversationId)}&day=${encodeURIComponent(day || '')}`); }
    clearUsage() { return this.request('/usage', 'DELETE'); }
    usageCorrected(conversationId) { return this.request('/usage/corrected', 'POST', { conversationId }); }
    shareState() { return this.request('/usage/share'); }
    sharePackage(until) { return this.request(`/usage/share/package?until=${Number(until) || 0}`, 'GET', undefined, 180000); }
    shareAnswer(answer, until) { return this.request('/usage/share', 'POST', { answer, until }, 180000); }
    shareLater() { return this.request('/usage/share/later', 'POST', {}); }
    shared(id) { return this.request(`/usage/share/history/${encodeURIComponent(id)}`); }
    activityOfDay(day) { return this.request(`/activity/day?day=${encodeURIComponent(day)}`); }
    update(id, data) { return this.request(`/conversations/${encodeURIComponent(id)}`, 'PATCH', data); }
    remove(id) { return this.request(`/conversations/${encodeURIComponent(id)}`, 'DELETE'); }
    clear(id) { return this.request(`/conversations/${encodeURIComponent(id)}/messages`, 'DELETE'); }
    /** Cuts the history at a message, that one included: one server step, all or nothing. */
    truncate(id, fromId) { return this.request(`/conversations/${encodeURIComponent(id)}/messages?from=${encodeURIComponent(fromId)}`, 'DELETE'); }
    save(id, message) { return this.request(`/conversations/${encodeURIComponent(id)}/messages`, 'POST', message); }
    // The chat's level memory: what is still to summarize, a summary written, the whole tree, one node.
    memoryPending(id) { return this.request(`/conversations/${encodeURIComponent(id)}/memory/pending`); }
    memoryAddNode(id, node) { return this.request(`/conversations/${encodeURIComponent(id)}/memory/nodes`, 'POST', node); }
    memoryTree(id) { return this.request(`/conversations/${encodeURIComponent(id)}/memory/tree`); }
    memoryOpen(id, nodeId) { return this.request(`/conversations/${encodeURIComponent(id)}/memory-node/${encodeURIComponent(nodeId)}`); }
    memoryCompactionPlan(id) { return this.request(`/conversations/${encodeURIComponent(id)}/memory/compaction`); }
    memorySaveCompaction(id, data) { return this.request(`/conversations/${encodeURIComponent(id)}/memory/compaction`, 'POST', data); }
    memoryUpdateNode(id, nodeId, data) { return this.request(`/conversations/${encodeURIComponent(id)}/memory-node/${encodeURIComponent(nodeId)}`, 'PATCH', data); }
    context(id, query, options = {}) { return this.request(`/conversations/${encodeURIComponent(id)}/context`, 'POST', { query, ...options }); }
    memories(id, query = '', scope = '') {
      let url = `/memories?conversationId=${encodeURIComponent(id || '')}&q=${encodeURIComponent(query)}`;
      if (scope) url += `&scope=${encodeURIComponent(scope)}`;
      return this.request(url);
    }
    saveMemory(data, id) { return this.request('/memories' + (id ? `/${encodeURIComponent(id)}` : ''), id ? 'PUT' : 'POST', data); }
    deleteMemory(id) { return this.request(`/memories/${encodeURIComponent(id)}`, 'DELETE'); }
    getSandbox(id) { return this.request(`/conversations/${encodeURIComponent(id)}/sandbox`); }
    updateSandbox(id, data) { return this.request(`/conversations/${encodeURIComponent(id)}/sandbox`, 'PATCH', data); }
    resetSandbox(id) { return this.request(`/conversations/${encodeURIComponent(id)}/sandbox/reset`, 'POST', {}); }
    stopSandbox(id) { return this.request(`/conversations/${encodeURIComponent(id)}/sandbox/stop`, 'POST', {}); }
    // A command of the model: the run id lets the stop button end it while it runs; the
    // request waits as long as the command may, plus the time to end it.
    execSandbox(id, command, runId = null, timeoutMs = 5 * 60 * 1000) { return this.request(`/conversations/${encodeURIComponent(id)}/sandbox/exec`, 'POST', { command, runId, timeoutMs }, timeoutMs + 30000); }
    interruptSandboxExec(id, runId) { return this.request(`/conversations/${encodeURIComponent(id)}/sandbox/interrupt`, 'POST', { runId }, 30000); }
    // Computer use: a session asked to the user, then the model's actions on its desktop.
    desktopRequest(id, goal, apps) { return this.request(`/conversations/${encodeURIComponent(id)}/desktop/sessions`, 'POST', { goal, apps }); }
    desktopStatus(id, sessionId) { return this.request(`/conversations/${encodeURIComponent(id)}/desktop/status?session=${encodeURIComponent(sessionId)}`); }
    desktopDecide(id, sessionId, decision) { return this.request(`/conversations/${encodeURIComponent(id)}/desktop/decision`, 'POST', { sessionId, decision }); }
    desktopAct(id, sessionId, action) { return this.request(`/conversations/${encodeURIComponent(id)}/desktop/act`, 'POST', { ...action, sessionId }, 90000); }
    desktopEnd(id, sessionId, stopped = false) { return this.request(`/conversations/${encodeURIComponent(id)}/desktop/end`, 'POST', { sessionId, stopped }, 30000); }
    /** The desktop's screen as a picture (a Blob), for the live view. */
    async desktopScreen(id, sessionId, width = 1280) {
      const { token } = await this.session();
      const response = await fetch(`${this.base}/conversations/${encodeURIComponent(id)}/desktop/screen?session=${encodeURIComponent(sessionId)}&w=${Math.round(width)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Schermo non disponibile.');
      return response.blob();
    }
    projectPointers(projectId) { return this.request(`/projects/${encodeURIComponent(projectId)}/pointers`, 'GET', undefined, 90000); }
    copyProjectFiles(id, projectId, paths) { return this.request(`/conversations/${encodeURIComponent(id)}/sandbox/project-files`, 'POST', { projectId, paths }, 120000); }
    clearProjectCopies(id) { return this.request(`/conversations/${encodeURIComponent(id)}/sandbox/project-files`, 'DELETE'); }
    saveSandboxFile(id, filename, content, encoding = 'base64') { return this.request(`/conversations/${encodeURIComponent(id)}/sandbox/files`, 'POST', { filename, content, encoding }); }
    appendSandboxFile(id, filename, content) { return this.request(`/conversations/${encodeURIComponent(id)}/sandbox/files`, 'POST', { filename, content, encoding: 'base64', append: true }, 120000); }
    // From another chat into this one: some of its files (`paths`), or, without them, its whole pod.
    copySandboxFrom(id, sourceId, paths) { return this.request(`/conversations/${encodeURIComponent(id)}/sandbox/copy`, 'POST', paths ? { sourceId, paths } : { sourceId }, 10 * 60 * 1000); }
    listSandboxFiles(id, category = 'all') {
      let url = `/conversations/${encodeURIComponent(id)}/sandbox/files`;
      if (category && category !== 'all') url += `?category=${encodeURIComponent(category)}`;
      return this.request(url);
    }
    publishSandboxArtifact(id, options = {}) { return this.request(`/conversations/${encodeURIComponent(id)}/sandbox/publish`, 'POST', options); }
    webSearch(id, query, maxResults = 5, page = 1) { return this.request(`/conversations/${encodeURIComponent(id)}/tools/web-search`, 'POST', { query, maxResults, page }); }
    webBrowse(id, url, maxChars = 8000) { return this.request(`/conversations/${encodeURIComponent(id)}/tools/web-browse`, 'POST', { url, maxChars }); }
    listProjects(section = 'code') { return this.request(`/projects${section && section !== 'code' ? `?section=${encodeURIComponent(section)}` : ''}`); }
    project(id) { return this.request(`/projects/${encodeURIComponent(id)}`); }
    // The Studio: a project's text as two sheets a chapter, the map the model reads, the typeset document.
    studioTex() { return this.request('/studio/tex', 'GET', undefined, 30000); }
    studioWarmTex() { return this.request('/studio/tex/warm', 'POST', {}, 30000); }
    studioInit(id, data = {}) { return this.request(`/studio/${encodeURIComponent(id)}/init`, 'POST', data, 60000); }
    studioOverview(id) { return this.request(`/studio/${encodeURIComponent(id)}`, 'GET', undefined, 30000); }
    studioSettings(id, data) { return this.request(`/studio/${encodeURIComponent(id)}`, 'PATCH', data, 30000); }
    studioFocus(id, chapter) { return this.request(`/studio/${encodeURIComponent(id)}/focus`, 'POST', { chapter }); }
    studioChapter(id, chapter) { return this.request(`/studio/${encodeURIComponent(id)}/chapters/${encodeURIComponent(chapter)}`, 'GET', undefined, 30000); }
    studioSaveDraft(id, chapter, draft) { return this.request(`/studio/${encodeURIComponent(id)}/chapters/${encodeURIComponent(chapter)}`, 'PUT', { draft }, 60000); }
    studioEditClean(id, chapter, paragraphId, clean) { return this.request(`/studio/${encodeURIComponent(id)}/chapters/${encodeURIComponent(chapter)}`, 'PATCH', { id: paragraphId, clean }, 60000); }
    studioCleanRequest(id, chapter, limit) { return this.request(`/studio/${encodeURIComponent(id)}/chapters/${encodeURIComponent(chapter)}`, 'POST', { op: 'request', limit }, 30000); }
    studioCleanApply(id, chapter, text, hashes) { return this.request(`/studio/${encodeURIComponent(id)}/chapters/${encodeURIComponent(chapter)}`, 'POST', { op: 'apply', text, hashes }, 60000); }
    studioChapterAction(id, data) { return this.request(`/studio/${encodeURIComponent(id)}/chapter`, 'POST', data, 60000); }
    studioContext(id) { return this.request(`/studio/${encodeURIComponent(id)}/context`, 'GET', undefined, 60000); }
    studioTree(id) { return this.request(`/studio/${encodeURIComponent(id)}/tree`, 'GET', undefined, 60000); }
    studioPending(id, limit = 8) { return this.request(`/studio/${encodeURIComponent(id)}/pending?limit=${limit}`, 'GET', undefined, 60000); }
    studioAddNode(id, node) { return this.request(`/studio/${encodeURIComponent(id)}/nodes`, 'POST', node); }
    studioOpen(id, node) { return this.request(`/studio/${encodeURIComponent(id)}/nodes/${encodeURIComponent(node)}`, 'GET', undefined, 30000); }
    studioTool(id, name, data = {}) { return this.request(`/studio/${encodeURIComponent(id)}/tools/${encodeURIComponent(name)}`, 'POST', data, 120000); }
    studioCompile(id) { return this.request(`/studio/${encodeURIComponent(id)}/compile`, 'POST', {}, 30000); }
    studioCompileStatus(id) { return this.request(`/studio/${encodeURIComponent(id)}/compile`, 'GET', undefined, 15000); }
    studioCompileLog(id) { return this.request(`/studio/${encodeURIComponent(id)}/compile/log`, 'GET', undefined, 15000); }
    studioExport(id, what) { return this.request(`/studio/${encodeURIComponent(id)}/export`, 'POST', { what }, 60000); }
    // The Studio's Foto tab: the folder, what the editor saves into it, the model's tools, the functions of ours.
    photoStatus() { return this.request('/photo/status', 'GET', undefined, 15000); }
    photoCheckLatest() { return this.request('/photo/status/check', 'POST', {}, 30000); }
    photoModels() { return this.request('/photo/models', 'GET', undefined, 60000); }
    photoWarmModels(model) { return this.request('/photo/models/warm', 'POST', { model }, 30000); }
    photoOnnx() { return this.request('/photo/onnx', 'GET', undefined, 30000); }
    photoOnnxSearch({ query = '', sort = '', cursor = '' } = {}) { return this.request(`/photo/onnx/search?${new URLSearchParams({ q: query, sort, cursor })}`, 'GET', undefined, 40000); }
    photoOnnxRepo(id) { return this.request(`/photo/onnx/repo?${new URLSearchParams({ id })}`, 'GET', undefined, 40000); }
    photoOnnxAdd(repo, path) { return this.request('/photo/onnx/add', 'POST', { repo, path }, 60000); }
    photoOnnxSet(key, data) { return this.request('/photo/onnx/model', 'PATCH', { key, ...data }, 30000); }
    photoOnnxRemove(key) { return this.request(`/photo/onnx/model?${new URLSearchParams({ key })}`, 'DELETE', undefined, 90000); }
    photoDropModels() { return this.request('/photo/models', 'DELETE', undefined, 60000); }
    photoInit(id, data = {}) { return this.request(`/photo/${encodeURIComponent(id)}/init`, 'POST', data, 60000); }
    photoOverview(id) { return this.request(`/photo/${encodeURIComponent(id)}`, 'GET', undefined, 60000); }
    photoSettings(id, data) { return this.request(`/photo/${encodeURIComponent(id)}`, 'PATCH', data, 30000); }
    photoWrite(id, file, content, source = 'user') { return this.request(`/photo/${encodeURIComponent(id)}/write`, 'POST', { path: file, content, source }, 120000); }
    photoContext(id) { return this.request(`/photo/${encodeURIComponent(id)}/context`, 'GET', undefined, 60000); }
    photoTool(id, name, data = {}) { return this.request(`/photo/${encodeURIComponent(id)}/tools/${encodeURIComponent(name)}`, 'POST', data, 10 * 60 * 1000); }
    photoRemoveBackground(id, file, { scratch = false, box = null } = {}) { return this.request(`/photo/${encodeURIComponent(id)}/functions/remove-background`, 'POST', { path: file, scratch, box }, 30000); }
    photoJob(id) { return this.request(`/photo/${encodeURIComponent(id)}/job`, 'GET', undefined, 15000); }
    /** A file of the folder as bytes: what the editor is handed to open. */
    async photoFile(id, file) {
      const { token } = await this.session();
      const response = await fetch(`${this.base}/photo/${encodeURIComponent(id)}/file?path=${encodeURIComponent(file)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store', signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'File non disponibile.');
      return new Uint8Array(await response.arrayBuffer());
    }
    /** The project as a zip of its last recorded step: the bytes. */
    async projectArchive(id) {
      const { token } = await this.session();
      const response = await fetch(`${this.base}/projects/${encodeURIComponent(id)}/archive`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(300000) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Archivio non disponibile.');
      return new Uint8Array(await response.arrayBuffer());
    }
    async studioPdf(id) {
      const { token } = await this.session();
      const response = await fetch(`${this.base}/studio/${encodeURIComponent(id)}/pdf`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'PDF non disponibile.');
      return new Uint8Array(await response.arrayBuffer());
    }
    createProject(data) { return this.request('/projects', 'POST', data); }
    renameProject(id, name) { return this.request(`/projects/${encodeURIComponent(id)}`, 'PATCH', { name }); }
    projectFiles(id, dirs = ['']) { return this.request(`/projects/${encodeURIComponent(id)}/files?dirs=${encodeURIComponent(JSON.stringify(dirs))}`, 'GET', undefined, 30000); }
    searchProjectFiles(id, query) { return this.request(`/projects/${encodeURIComponent(id)}/files/search?q=${encodeURIComponent(query)}`, 'GET', undefined, 30000); }
    async projectArtifactFile(id, file) {
      const { token } = await this.session();
      const response = await fetch(`${this.base}/projects/${encodeURIComponent(id)}/artifacts/file?path=${encodeURIComponent(file)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Artefatto non disponibile.');
      return new Uint8Array(await response.arrayBuffer());
    }
    // Where the memory of the app is kept; asking for it to be moved (done at the next start), or taking that back.
    memoryStatus() { return this.request('/memory'); }
    memoryMove(dir) { return this.request('/memory', 'POST', { dir }); }
    memoryCancel() { return this.request('/memory', 'DELETE'); }
    memoryCopies() { return this.request('/memory/copies'); }
    // The disk of the pods' runtime: what its file takes, and the compaction of it (every pod stopped for it).
    runtimeDisk() { return this.request('/runtime/disk'); }
    runtimeCompact() { return this.request('/runtime/disk/compact', 'POST', {}); }
    setMemoryCopies(on) { return this.request('/memory/copies', 'POST', { on }); }
    projectArtifacts(id) { return this.request(`/projects/${encodeURIComponent(id)}/artifacts`); }
    changeProjectArtifact(id, change) { return this.request(`/projects/${encodeURIComponent(id)}/artifacts`, 'POST', change, 300000); }
    changeProjectFile(id, change) { return this.request(`/projects/${encodeURIComponent(id)}/files`, 'POST', change, 60000); }
    // One file whole, and a file written whole (text or bytes as base64): what the phone does to a project's files.
    readProjectFile(id, filePath) { return this.request(`/projects/${encodeURIComponent(id)}/files/read?path=${encodeURIComponent(filePath)}`, 'GET', undefined, 60000); }
    writeProjectFile(id, change) { return this.request(`/projects/${encodeURIComponent(id)}/files/write`, 'POST', change, 120000); }
    readProjectArtifact(id, filePath) { return this.request(`/projects/${encodeURIComponent(id)}/artifacts/read?path=${encodeURIComponent(filePath)}`, 'GET', undefined, 60000); }
    setProjectNotes(id, notes) { return this.request(`/projects/${encodeURIComponent(id)}`, 'PATCH', { notes }); }
    // What the model may do to the project without asking: code and terminal, each manual, semi or auto.
    setProjectPermissions(id, permissions) { return this.request(`/projects/${encodeURIComponent(id)}`, 'PATCH', { permissions }); }
    projectApprovals(id) { return this.request(`/projects/${encodeURIComponent(id)}/approvals`); }
    forgetApproval(id, rowId) { return this.request(`/projects/${encodeURIComponent(id)}/approvals/${encodeURIComponent(rowId)}`, 'DELETE'); }
    forgetAllApprovals(id) { return this.request(`/projects/${encodeURIComponent(id)}/approvals/all`, 'DELETE'); }
    // A command for the editor's terminal of a local project: allowed at once, or a request for the user.
    gateCommand(id, command, cwd = null) { return this.request(`/projects/${encodeURIComponent(id)}/terminal/gate`, 'POST', { command, cwd }); }
    // The user's answer to a pending request; approving runs the action, which can take as long as the action itself.
    decideApproval(id, approvalId, decision) { return this.request(`/projects/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}`, 'POST', { decision }, 6 * 60 * 1000); }
    // Opening a Podman project can pull its image on first use.
    openProject(id) { return this.request(`/projects/${encodeURIComponent(id)}/open`, 'POST', {}, 6 * 60 * 1000); }
    // Which step that open is on, while it runs: what the progress bar says.
    projectProgress(id) { return this.request(`/projects/${encodeURIComponent(id)}/progress`, 'GET', undefined, 8000); }
    removeProject(id) { return this.request(`/projects/${encodeURIComponent(id)}`, 'DELETE', undefined, 60000); }
    projectGit(id) { return this.request(`/projects/${encodeURIComponent(id)}/git`, 'GET', undefined, 120000); }
    projectGitAction(id, action, data = {}) { return this.request(`/projects/${encodeURIComponent(id)}/git/${encodeURIComponent(action)}`, 'POST', data, 6 * 60 * 1000); }
    // The history read back: the steps, one step's diff, the project and a file as they were, and going back to a step.
    projectHistory(id, { limit = 100, skip = 0, path = null } = {}) {
      const query = new URLSearchParams({ limit: String(limit), skip: String(skip) });
      if (path) query.set('path', path);
      return this.request(`/projects/${encodeURIComponent(id)}/history?${query}`, 'GET', undefined, 60000);
    }
    projectHistoryCommit(id, hash) { return this.request(`/projects/${encodeURIComponent(id)}/history/commit?hash=${encodeURIComponent(hash)}`, 'GET', undefined, 60000); }
    projectHistoryTree(id, hash) { return this.request(`/projects/${encodeURIComponent(id)}/history/tree?hash=${encodeURIComponent(hash)}`, 'GET', undefined, 60000); }
    projectHistoryFile(id, hash, path) { return this.request(`/projects/${encodeURIComponent(id)}/history/file?hash=${encodeURIComponent(hash)}&path=${encodeURIComponent(path)}`, 'GET', undefined, 60000); }
    restoreProject(id, hash, path = null) { return this.request(`/projects/${encodeURIComponent(id)}/history/restore`, 'POST', { hash, path }, 120000); }
    // A command the model ran in a local project's terminal: what it changed becomes the model's step.
    recordCommand(id, command) { return this.request(`/projects/${encodeURIComponent(id)}/terminal/record`, 'POST', { command }, 120000); }
    // The model's hands on a project: the file list it works from, the six
    // tools it calls, and their declarations for the turn.
    projectTree(id) { return this.request(`/projects/${encodeURIComponent(id)}/tree`, 'GET', undefined, 60000); }
    codeTool(id, name, data = {}) { return this.request(`/projects/${encodeURIComponent(id)}/tools/${encodeURIComponent(name)}`, 'POST', data, 120000); }
    codeToolSpecs() { return this.request('/code-tools'); }
    // The editor extensions a coding project's image carries.
    getCodeExtensions() { return this.request('/code-extensions', 'GET', undefined, 60000); }
    setCodeExtension(name, enabled) { return this.request(`/code-extensions/${encodeURIComponent(name)}`, 'PATCH', { enabled }, 60000); }
    githubStatus() { return this.request('/github'); }
    githubConnect() { return this.request('/github/connect', 'POST', {}); }
    githubInstall() { return this.request('/github/install', 'POST', {}); }
    githubDisconnect() { return this.request('/github', 'DELETE'); }
    githubRepositories() { return this.request('/github/repositories', 'GET', undefined, 60000); }
    githubBranches(repo) { return this.request(`/github/branches?repo=${encodeURIComponent(repo)}`, 'GET', undefined, 60000); }
    getPackages() { return this.request('/packages'); }
    togglePackageDefault(name, isDefault) { return this.request(`/packages/${encodeURIComponent(name)}`, 'PATCH', { isDefault }); }
    scanPackages() { return this.request('/packages/scan', 'POST', {}); }
    // The phone bridge: turned on and off, a phone paired or removed, and what passes between the phones and the page.
    bridgeStatus() { return this.request('/bridge'); }
    bridgeConfigure(change) { return this.request('/bridge', 'PUT', change, 120000); }
    // The window was closed with the app going on without it, or it is back.
    bridgeWindow(open) { return this.request('/bridge/window', 'PUT', { open: Boolean(open) }); }
    // Opening a pairing builds the tunnels the new phone comes through: most of a minute on a router just started.
    bridgeOpenPairing() { return this.request('/bridge/pairing', 'POST', {}, 240000); }
    bridgeClosePairing() { return this.request('/bridge/pairing', 'DELETE', undefined, 240000); }
    bridgeInbox(waitMs = 25000) { return this.request(`/bridge/inbox?wait=${Number(waitMs) || 0}`, 'GET', undefined, (Number(waitMs) || 0) + 15000); }
    bridgeSend(message) { return this.request('/bridge/send', 'POST', message, 120000); }
    bridgeRenameDevice(id, name) { return this.request(`/bridge/devices/${encodeURIComponent(id)}`, 'PATCH', { name }); }
    bridgeRemoveDevice(id) { return this.request(`/bridge/devices/${encodeURIComponent(id)}`, 'DELETE', undefined, 240000); }
    bridgeForget() { return this.request('/bridge/forget', 'POST', {}, 240000); }
    getSettings() { return this.request('/settings'); }
    getSetting(key) { return this.request(`/settings/${encodeURIComponent(key)}`); }
    setSetting(key, value) { return this.request(`/settings/${encodeURIComponent(key)}`, 'PUT', { value }); }
    deleteSetting(key) { return this.request(`/settings/${encodeURIComponent(key)}`, 'DELETE'); }
    getSecurityStatus() { return this.request('/security'); }

    /**
     * The heavy vault crypto runs in the native Rust layer via a Tauri command,
     * off the Node event loop and with the session key held in the native
     * process (never transiting here). Each op is: plan (Node closes the DB and
     * exposes paths) → Rust crypto → commit (Node writes meta / sets state).
     * When not running under Tauri (standalone server, tests) we fall back to
     * the single synchronous Node endpoint.
     */
    _vaultInvoke() { return window.__TAURI__?.core?.invoke || null; }

    async enableDatabaseEncryption(password, confirmPassword, targets = { sql: true, sandboxes: true }) {
      const invoke = this._vaultInvoke();
      if (!invoke) return this.request('/security/enable', 'POST', { password, confirmPassword, targets });
      if (confirmPassword && password !== confirmPassword) throw new Error('Le password non coincidono.');
      const plan = await this.request('/security/plan-dump', 'POST', { targets });
      const result = await invoke('vault_dump', { request: {
        password,
        salt_hex: null,
        dbs: plan.dbs,
        sandboxes_dir: plan.targets.sandboxes ? plan.sandboxesDir : null,
        sandboxes_enc_path: plan.targets.sandboxes ? plan.sandboxesEncPath : null,
        forget: false
      } });
      return this.request('/security/commit-dump', 'POST', { result, targets: plan.targets, stayUnlocked: true });
    }

    async unlockDatabase(password) {
      const invoke = this._vaultInvoke();
      if (!invoke) return this.request('/security/unlock', 'POST', { password });
      const plan = await this.request('/security/plan-undump', 'POST', {});
      if (plan.alreadyUnlocked) return plan.status;
      try {
        await invoke('vault_undump', { request: {
          password,
          salt_hex: plan.salt_hex,
          dbs: plan.dbs,
          sandboxes: plan.targets.sandboxes ? plan.sandboxes : null
        } });
      } catch (err) {
        await this.request('/security/commit-undump', 'POST', { ok: false }).catch(() => {});
        throw new Error('Password errata o archivio manomesso.');
      }
      return this.request('/security/commit-undump', 'POST', { ok: true });
    }

    async lockDatabase() {
      const invoke = this._vaultInvoke();
      if (!invoke) return this.request('/security/lock', 'POST', {});
      const plan = await this.request('/security/plan-dump', 'POST', {});
      const result = await invoke('vault_dump', { request: {
        password: null,
        salt_hex: plan.existingSaltHex,
        dbs: plan.dbs,
        sandboxes_dir: plan.targets.sandboxes ? plan.sandboxesDir : null,
        sandboxes_enc_path: plan.targets.sandboxes ? plan.sandboxesEncPath : null,
        forget: true
      } });
      return this.request('/security/commit-dump', 'POST', { result, targets: plan.targets, stayUnlocked: false });
    }
    disableDatabaseEncryption(password, targets = null) { return this.request('/security/disable', 'POST', { password, targets }); }
    changeDatabasePassword(currentPassword, newPassword, confirmPassword, targets = null) { return this.request('/security/change-password', 'POST', { currentPassword, newPassword, confirmPassword, targets }); }
  }
  /**
   * Resolves an artifact link against the storage service of this session.
   *
   * Links are stored without an origin because the port is assigned at runtime.
   * Links saved by earlier versions carry a hard-coded loopback origin, so those
   * are rewritten too rather than left pointing at a port nothing listens on.
   */
  window.synthorgResolveUrl = function (url) {
    const value = String(url === null || url === undefined ? '' : url);
    const origin = window.SYNTHORG_STORAGE_ORIGIN || '';
    if (!origin || !value) return value;
    if (value.startsWith('/api/')) return origin + value;
    const legacy = /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+(\/api\/.*)$/i.exec(value);
    return legacy ? origin + legacy[1] : value;
  };

  window.chatStorage = new ChatStorage();
})();
