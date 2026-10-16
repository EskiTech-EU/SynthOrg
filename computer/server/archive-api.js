'use strict';
/**
 * The requests the archive answers by itself.
 *
 * The interface reads and writes the archive at `/api/...`. What needs only
 * the archive (chats and their messages, the level memory, the notes, the
 * agenda, the diary, habits, goals, notices, pauses, the files handed, the
 * settings) is answered here, by the same rules on the computer and on the
 * phone: the computer's service calls this from its handler (index.js), the
 * phone's shell runs this file on its own archive (android/src-tauri).
 *
 * What needs the machine (containers, the files of a workspace, the Code
 * projects, the web, the vault) is not here: `route` gives back null and the
 * computer's service goes on with its own handler, while a phone asks the
 * computer for it through the bridge.
 *
 * `request`: `{ method, parts, query, input }` — `parts` is the path split
 * (`['api', 'agenda', id]`), `query` reads a value of the query string.
 * `extra`: what only the computer knows about a request (see each use).
 */
const { fail, projectEnvs } = require('./database');

function route(store, { method, parts, query, input = {} }, extra = {}) {
  const [, resource, id, action, subaction] = parts;
  let result;
  if (resource === 'import' && !id && method === 'POST') result = store.importLegacy(input.messages);
  else if (resource === 'conversations') {
    // `project` names whose chats these are: the general ones when it is
    // absent, a Code project's own when it is there.
    // `home`: on a phone, 'own' for its world, 'others' for the computers'; a new chat is born here or, with 'peer', on the computer paired.
    if (!id && method === 'GET') result = store.listConversations(query('q') || '', query('archived') === 'true', query('project') || null, query('home') || null);
    else if (!id && method === 'POST') result = store.createConversation(input.title, input.projectId || null, input.home || null);
    // messages=none: the conversation alone, for what does not need what it holds
    else if (id && !action && method === 'GET') result = { conversation: store.conversation(id), messages: query('messages') === 'none' ? [] : store.messages(id) };
    // A conversation read from a message on: what one without end is asked for.
    else if (id && action === 'messages' && !subaction && method === 'GET') {
      result = { messages: store.messagesAfter(id, query('after'), query('limit')), last: store.lastSequence(id) };
    }
    else if (id && !action && method === 'PATCH') result = store.updateConversation(id, input);
    else if (id && !action && method === 'DELETE') { store.deleteConversation(id); result = { deleted: true }; }
    else if (id && action === 'messages' && method === 'POST') result = store.saveMessage(id, input);
    else if (id && action === 'messages' && method === 'DELETE') {
      // With `from`, the history is cut at that message (an edit); without, emptied.
      const from = query('from');
      if (from) result = { deleted: store.truncateMessages(id, from) };
      else { store.clearMessages(id); result = { deleted: true }; }
    }
    else if (id && action === 'context' && method === 'POST') result = store.context(id, input.query || '', input);
    // The chat's level memory: what is still to summarize, the summaries the page
    // writes, the whole tree for the panel, and one node opened (by the model's
    // memory_open tool, or by the user) or corrected.
    else if (id && action === 'memory' && subaction === 'pending' && method === 'GET') result = store.memoryTree().pending(id);
    else if (id && action === 'memory' && subaction === 'tree' && method === 'GET') result = store.memoryTree().tree(id);
    else if (id && action === 'memory' && subaction === 'nodes' && method === 'POST') result = store.memoryTree().addNode(id, input);
    // Without the level memory: what to send the model for a summary, and the summary it wrote.
    else if (id && action === 'memory' && subaction === 'compaction' && method === 'GET') result = store.memoryTree().compactionPlan(id);
    else if (id && action === 'memory' && subaction === 'compaction' && method === 'POST') result = store.memoryTree().saveCompaction(id, input);
    else if (id && action === 'memory-node' && subaction && method === 'GET') { store.conversation(id); result = store.memoryTree().open(id, subaction); }
    else if (id && action === 'memory-node' && subaction && method === 'PATCH') { store.conversation(id); result = store.memoryTree().updateNode(id, subaction, input); }
    // The chat's container, its desktop, the web: the machine's.
    else return null;
  } else if (resource === 'agenda') {
    const personal = store.personal();
    if (!id && method === 'GET') result = personal.agenda({ from: query('from'), to: query('to'), includeOpen: query('open') !== 'false' });
    else if (!id && method === 'POST') result = personal.saveAgendaItem(input);
    else if (id === 'due' && method === 'POST') result = personal.dueReminders(input.now);
    else if (id === 'proposals' && method === 'GET') result = personal.agendaProposals();
    else if (id && method === 'PUT') result = personal.saveAgendaItem(input, id);
    else if (id && method === 'DELETE') { personal.deleteAgendaItem(id); result = { deleted: true }; }
    else fail('Endpoint non trovato.', 404);
  } else if (resource === 'diary') {
    const personal = store.personal();
    if (!id && method === 'GET') result = personal.diary({ from: query('from'), to: query('to'), limit: query('limit'), fields: query('fields') });
    else if (id === 'count' && method === 'GET') result = personal.diaryCount();
    else if (!id && method === 'POST') result = personal.saveDiaryEntry(input);
    else if (!id && method === 'DELETE') result = personal.deleteDiary();
    else if (id && method === 'PUT') result = personal.saveDiaryEntry(input, id);
    else if (id && method === 'DELETE') { personal.deleteDiaryEntry(id); result = { deleted: true }; }
    else fail('Endpoint non trovato.', 404);
  } else if (resource === 'habits') {
    const personal = store.personal();
    if (!id && method === 'GET') result = personal.habits();
    else if (!id && method === 'POST') result = personal.saveHabit(input);
    // what the habits did day by day: read, set by hand, or set from a day's account
    else if (id === 'days' && method === 'GET') result = personal.habitDays({ from: query('from'), to: query('to') });
    else if (id === 'days' && method === 'PUT') result = personal.markHabit(input);
    else if (id === 'days' && method === 'POST') result = personal.setDiaryMarks(input);
    // what the past days say of habits followed from now on
    else if (id === 'past' && method === 'POST') result = personal.addDiaryMarks(input);
    else if (id && method === 'PUT') result = personal.saveHabit(input, id);
    else if (id && method === 'DELETE') { personal.deleteHabit(id); result = { deleted: true }; }
    else fail('Endpoint non trovato.', 404);
  } else if (resource === 'goals') {
    const personal = store.personal();
    if (!id && method === 'GET') result = personal.goals();
    else if (!id && method === 'POST') result = personal.saveGoal(input);
    else if (id && !action && method === 'PUT') result = personal.saveGoal(input, id);
    else if (id && !action && method === 'DELETE') { personal.deleteGoal(id); result = { deleted: true }; }
    else if (id && action === 'steps' && !subaction && method === 'POST') result = personal.saveGoalStep(id, input);
    else if (id && action === 'steps' && subaction && method === 'PUT') result = personal.saveGoalStep(id, input, subaction);
    else if (id && action === 'steps' && subaction && method === 'DELETE') { personal.deleteGoalStep(subaction); result = { deleted: true }; }
    else fail('Endpoint non trovato.', 404);
  } else if (resource === 'notices') {
    const personal = store.personal();
    if (!id && method === 'GET') result = personal.notices({ day: query('day') });
    else if (!id && method === 'POST') result = personal.recordNotice(input);
    else if (id === 'signals' && method === 'GET') result = personal.signals({ projectId: query('project'), hours: query('hours') });
    else if (id && method === 'PUT') result = personal.answerNotice(id, input.answer);
    else if (id && method === 'DELETE') { personal.deleteNotice(id); result = { deleted: true }; }
    else fail('Endpoint non trovato.', 404);
  } else if (resource === 'pauses') {
    const personal = store.personal();
    if (!id && method === 'GET') result = personal.pauses({ from: query('from'), to: query('to') });
    else if (!id && method === 'POST') result = personal.startPause(input);
    else if (id === 'open' && method === 'GET') result = { pause: personal.openPause() };
    // the pauses the user likes: proposed by a model, confirmed by the user
    else if (id === 'liked' && !action && method === 'GET') result = personal.likedPauses();
    else if (id === 'liked' && !action && method === 'POST') result = personal.saveLikedPause(input);
    else if (id === 'liked' && action && method === 'PUT') result = personal.saveLikedPause(input, action);
    else if (id === 'liked' && action && method === 'DELETE') { personal.deleteLikedPause(action); result = { deleted: true }; }
    else if (id && method === 'PUT') result = personal.endPause(id);
    else if (id && method === 'DELETE') { personal.deletePause(id); result = { deleted: true }; }
    else fail('Endpoint non trovato.', 404);
  } else if (resource === 'handed') {
    // the files handed to the user in the character's section
    const personal = store.personal();
    const read = () => personal.handedFiles({ limit: query('limit'), before: query('before'), query: query('q'), kind: query('kind') });
    if (!id && method === 'GET') {
      result = read();
      // `fileThere` (the computer's): a file that is no longer in its workspace is no longer among the ones handed.
      const gone = extra.fileThere ? result.files.filter(file => !extra.fileThere(file.url)) : [];
      if (gone.length) { gone.forEach(file => personal.dropFile(file.id)); result = read(); }
    } else if (!id && method === 'POST') {
      // A file is handed by the device that holds the workspaces.
      if (!extra.fileThere) return null;
      if (!extra.fileThere(input.url)) fail('File non trovato nel workspace.', 404);
      result = personal.handFile(input);
    } else if (id && method === 'PUT') result = personal.seeFile(id);
    else if (id && method === 'DELETE') { personal.dropFile(id); result = { deleted: true }; }
    else fail('Endpoint non trovato.', 404);
  } else if (resource === 'jobs') {
    const personal = store.personal();
    if (!id && method === 'GET') result = personal.jobs({ from: query('from'), to: query('to') });
    else if (!id && method === 'POST') result = personal.recordJob(input);
    else fail('Endpoint non trovato.', 404);
  } else if (resource === 'activity') {
    const personal = store.personal();
    // `reading` (the computer's): the steps of the projects in containers are being read.
    if (!id && method === 'GET') result = { ...personal.activity({ from: query('from'), to: query('to') }), reading: extra.reading || false };
    else if (id === 'day' && method === 'GET') result = personal.activityOfDay(query('day'));
    else fail('Endpoint non trovato.', 404);
  } else if (resource === 'reviews') {
    const personal = store.personal();
    if (!id && method === 'GET') result = personal.reviews({ limit: query('limit') });
    else if (!id && method === 'POST') result = personal.saveReview(input);
    else if (id && method === 'DELETE') { personal.deleteReview(id); result = { deleted: true }; }
    else fail('Endpoint non trovato.', 404);
  } else if (resource === 'realtime') {
    if (!id && method === 'GET') result = store.realtime();
    else if (id === 'forget' && method === 'POST') result = store.realtimeForget();
    else fail('Endpoint non trovato.', 404);
  } else if (resource === 'memories') {
    if (!id && method === 'GET') result = store.listMemories(query('conversationId'), query('q') || '', query('scope') || null);
    else if (!id && method === 'POST') result = store.saveMemory(input);
    // the Code projects the dossier shows, worked out from the projects
    else if (id === 'code-projects' && method === 'GET') result = store.dossierProjects();
    else if (id && method === 'PUT') {
      if (!store.db.prepare('SELECT id FROM memories WHERE id=?').get(id)) fail('Memoria non trovata.', 404);
      result = store.saveMemory(input, id);
    } else if (id && method === 'DELETE') { store.deleteMemory(id); result = { deleted: true }; }
    else fail('Endpoint non trovato.', 404);
  } else if (resource === 'usage') {
    // What the models cost and how they do: written as each request ends,
    // read by the projects' cards and by the Realtime section. Sharing the
    // numbers goes out of the device: the machine's (index.js).
    const usage = store.usage();
    if (!id && method === 'GET') result = usage.overview({ from: query('from'), to: query('to'), projectId: query('project') || null });
    else if (!id && method === 'POST') result = usage.record(input);
    else if (!id && method === 'DELETE') result = usage.clear();
    else if (id === 'projects' && method === 'GET') result = usage.projects();
    else if (id === 'pending' && method === 'GET') result = usage.pending();
    else if (id === 'chat' && !action && method === 'GET') result = usage.spentBy(query('id'), query('day'));
    else if (id === 'corrected' && method === 'POST') result = usage.markCorrected(input.conversationId);
    else if (id === 'share' && !action && method === 'GET') result = usage.shareState();
    else if (id === 'share' && action === 'later' && method === 'POST') result = usage.shareLater();
    else if (id === 'share' && action === 'history' && subaction && method === 'GET') result = usage.shared(subaction);
    else if (id === 'share') return null;
    else if (id && method === 'PUT') result = usage.resolve(id, input);
    else fail('Endpoint non trovato.', 404);
  } else if (resource === 'projects' && !id && method === 'GET') {
    // The list alone: what is done with a project is the machine's. One section at a time (the Code tab's unless
    // asked otherwise), or 'all' for the Lab, which shows every project with the environments it has on.
    // `modified_at` is the project's latest step, or its making while it has none.
    const spent = store.usage().projects();
    const changed = store.personal().lastSteps();
    result = store.listProjects(query('section') || 'code').map(project => ({ ...project, envs: projectEnvs(project), modified_at: changed[project.id] || project.created_at, usage: spent[project.id] || null }));
  } else if (resource === 'settings') {
    if (!id && method === 'GET') result = store.getSettings();
    else if (id && method === 'GET') result = { key: id, value: store.getSetting(id) };
    else if (id && (method === 'PUT' || method === 'POST')) result = { key: id, value: store.setSetting(id, input.value) };
    else if (id && method === 'DELETE') { store.deleteSetting(id); result = { deleted: true }; }
    else fail('Endpoint non trovato.', 404);
  } else return null;
  return { result };
}

module.exports = { route };
