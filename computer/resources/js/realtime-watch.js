/**
 * SynthOrg - the assistant between the user and their chats: what is worked
 * out without a model.
 *
 * The character can read a chat, write in it as the user would, and watch
 * over it while the user is away (realtime-liaison.js). What those need and
 * no model has to do is here: finding the chat the user named, putting a
 * chat or a turn in the few lines a request can carry, the limits a watched
 * chat is held to, and reading the answer of the Master that judges a turn.
 */
(function () {
  'use strict';

  const STEM = 5;                 // letters of a word that have to match
  const ASKED_REQUEST = 2000;     // characters of a request given to be judged
  const ANSWER_HEAD = 1500;       // of an answer: its start…
  const ANSWER_TAIL = 4500;       // …and its end, where what was done is said
  const CALLS_MOST = 30;          // tool calls of a turn given one by one
  const MATERIAL = 20000;         // characters of a chat given to be analysed
  const MATERIAL_EACH = 4000;     // of which, at most, a single message
  // Words that say "a chat" or "a project" without saying which.
  const SKIP = new Set(['chat', 'chats', 'progetto', 'progetti', 'project', 'projects', 'il', 'lo', 'la', 'i', 'gli', 'le', 'l', 'un', 'una', 'di', 'del', 'dello', 'della', 'dei',
    'nel', 'nella', 'sul', 'sulla', 'su', 'in', 'a', 'al', 'alla', 'per', 'con', 'che', 'e', 'ed', 'mio', 'mia', 'quello', 'quella', 'the', 'of', 'on', 'my', 'and', 'for', 'to', 'that']);

  const plain = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const stems = (text) => plain(text).split(' ').filter(word => word && !SKIP.has(word)).map(word => word.slice(0, STEM));
  const oneLine = (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? '') || '').replace(/\s+/g, ' ').trim();
  const cut = (text, most) => { const whole = String(text || '').trim(); return whole.length > most ? whole.slice(0, most).trimEnd() + ' […]' : whole; };
  /** A long text as its start and its end. */
  const ends = (text, head, tail) => {
    const whole = String(text || '').trim();
    return whole.length > head + tail ? `${whole.slice(0, head).trimEnd()}\n[…]\n${whole.slice(-tail).trimStart()}` : whole;
  };

  /**
   * The chat the user named, among theirs: [{ id, title, project }], the most
   * recent first. The words said are looked for in the chat's title and in
   * its project's name. `found` is the chat; with a project named and not one
   * of its chats, the most recent of that project. When chats of different
   * projects match as well, none is chosen and `among` lists them.
   */
  function findChat(query, chats) {
    const asked = [...new Set(stems(query))];
    if (!asked.length || !Array.isArray(chats)) return { found: null, among: [] };
    const whole = plain(query);
    const scored = chats.map((chat, order) => {
      const title = stems(chat.title), project = stems(chat.project);
      const hits = asked.filter(word => title.includes(word) || project.includes(word)).length;
      const inTitle = asked.filter(word => title.includes(word)).length;
      return { chat, order, hits, score: hits * 10 + inTitle + (plain(chat.title) === whole ? 100 : 0) };
    }).filter(entry => entry.hits > 0 && entry.hits * 2 >= asked.length);
    if (!scored.length) return { found: null, among: [] };
    const best = Math.max(...scored.map(entry => entry.score));
    const top = scored.filter(entry => entry.score === best).sort((a, b) => a.order - b.order);
    const sameProject = top.every(entry => (entry.chat.projectId || '') === (top[0].chat.projectId || '')) && Boolean(top[0].chat.projectId);
    if (top.length === 1 || sameProject) return { found: top[0].chat, among: [] };
    return { found: null, among: top.slice(0, 6).map(entry => entry.chat) };
  }

  const callsOf = (message) => (message?.turns || []).flatMap(turn => turn?.toolCalls || []).filter(call => call && call.name);

  /** The tools a turn called, a line each: what was asked and what came back. */
  function callsText(message, { most = CALLS_MOST, args = 160, result = 240 } = {}) {
    const list = callsOf(message);
    const lines = list.slice(-most).map(call => {
      const outcome = call.approvalOutcome === 'deny' ? 'refused' : call.approvalOutcome === 'expired' ? 'permission not given in time' : cut(oneLine(call.result), result);
      return `- ${call.name}(${cut(oneLine(call.args), args)})${outcome ? ` -> ${outcome}` : ''}`;
    });
    return [...(list.length > most ? [`(${list.length - most} earlier calls left out)`] : []), ...lines].join('\n');
  }

  /** A plan as a few lines: where it is and its points. */
  function planText(plan) {
    if (!plan || !Array.isArray(plan.points) || !plan.points.length) return '';
    const points = plan.points.map((point, index) => `${index + 1}. [${point.status || 'todo'}] ${cut(oneLine(point.title), 160)}`);
    return `Status: ${plan.status}${plan.reason ? ` (${cut(oneLine(plan.reason), 200)})` : ''}. Point ${Math.min((plan.current || 0) + 1, plan.points.length)} of ${plan.points.length}.\n${points.join('\n')}`;
  }

  /**
   * A turn as it is given to be judged: what was asked and by whom, the tools
   * called, the answer and how it ended.
   */
  function turnDigest({ request = '', by = '', answer = null, stopped = false, failed = false } = {}) {
    const tools = callsText(answer);
    const ended = stopped ? 'stopped before its end' : failed || answer?.status === 'error' ? 'ended with an error' : 'complete';
    return [
      `[REQUEST - written by ${by === 'assistant' ? 'you, as an instruction' : 'the user'}]\n${cut(request, ASKED_REQUEST) || '(none)'}`,
      `[TOOLS CALLED]\n${tools || '(none)'}`,
      `[ANSWER - ${ended}]\n${ends(answer?.content, ANSWER_HEAD, ANSWER_TAIL) || '(empty)'}`
    ].join('\n\n');
  }

  /** The last request of a chat and the answer to it, from its messages. */
  function lastTurn(messages) {
    const list = (messages || []).filter(message => message && message.kind !== 'execution');
    let at = list.length - 1;
    while (at >= 0 && list[at].role !== 'assistant') at--;
    const answer = at >= 0 ? list[at] : null;
    let asked = at - 1;
    while (asked >= 0 && list[asked].role !== 'user') asked--;
    const request = asked >= 0 ? list[asked] : null;
    return { request: request?.content || '', by: request?.by || '', answer, failed: answer?.status === 'error' };
  }

  /**
   * The last messages of a chat as a text to analyse, the newest kept when
   * they do not all fit. `label(message)` names who wrote each.
   */
  function material(messages, label, budget = MATERIAL) {
    const kept = [];
    let room = budget;
    const list = (messages || []).filter(message => message && message.kind !== 'execution' && (message.content || callsOf(message).length));
    for (let i = list.length - 1; i >= 0 && room > 0; i--) {
      const message = list[i];
      const tools = callsOf(message).map(call => call.name);
      const body = `${label(message)}\n${cut(message.content, Math.min(MATERIAL_EACH, room))}${tools.length ? `\n(${tools.length}: ${[...new Set(tools)].join(', ')})` : ''}`;
      kept.unshift(body);
      room -= body.length;
    }
    return { text: kept.join('\n\n'), left: list.length - kept.length };
  }

  /* ------------------------------------------------------------------ */
  /* Watching over a chat                                                 */
  /* ------------------------------------------------------------------ */

  // What judges a turn is told once, the same for every chat watched.
  const WATCH_RULES = [
    'You watch over an AI that is working in a chat of the user\'s while the user is away. You are given the user\'s principles, which hold for every chat watched, the orders the user left for this chat, and the last turn of that chat: what was asked, the tools the AI called with what came back, and its answer.',
    'Decide what happens next. Answer with a JSON object and nothing else: {"verdict": "continue" | "done" | "ask", "message": "", "why": ""}.',
    '"continue": the orders are not finished and the work can go on, or the AI did something wrong that it can put right. "message" is what is written to that AI as the user would write it: the next thing to do, or what to correct and how. It stands on its own, is specific, and asks for one step whose result can be checked.',
    '"done": everything the orders ask for is done, and the turns show it rather than only say it. "message" is empty.',
    '"ask": going on needs the user: a choice the orders do not make, something that cannot be undone, an access or a secret that is missing, the same failure again after it was corrected, or a question only the user can answer. "message" is empty.',
    '"why" is one sentence for the user, in the language of the orders: what you saw and what you decided.',
    'Hold the AI to the orders and to the principles. Work it says it did and the tools do not show is not done; a check that was not run has not passed. Add no goals of your own. When what you are given is not enough to decide, the verdict is "ask".'
  ].join('\n');

  const PERMIT_RULES = [
    'An AI working in a chat of the user\'s asks permission for one action. The user is away and has left the decision to you for this chat. You are given the user\'s principles, the orders for this chat and the action.',
    'Answer with a JSON object and nothing else: {"allow": true | false, "why": ""}. "why" is one sentence for the user, in the language of the orders.',
    'Allow what the orders need and the principles do not forbid. Refuse what the orders do not need, what the principles forbid, and what cannot be judged from what you are given.'
  ].join('\n');

  /** What the Master is given to judge a turn: the part that changes from a chat and a turn to the next. */
  function watchRequest({ title = '', project = '', entry = {}, plan = null, turn = {} }) {
    const sent = (entry.log || []).filter(line => line.kind === 'continue' && line.message).slice(-3).map(line => `- ${cut(oneLine(line.message), 300)}`);
    return [
      `[CHAT]\n${title}${project ? ` - project ${project}` : ''}`,
      `[ORDERS FOR THIS CHAT]\n${String(entry.orders || '').trim()}`,
      `[SO FAR]\nInstructions you wrote since the user was last here: ${entry.steps || 0} of ${entry.maxSteps} allowed.${sent.length ? `\nThe last ones:\n${sent.join('\n')}` : ''}`,
      plan ? `[PLAN OF THE CHAT]\n${planText(plan)}` : '',
      `[LAST TURN]\n${turnDigest(turn)}`
    ].filter(Boolean).join('\n\n');
  }

  function permitRequest({ title = '', project = '', entry = {}, tool = '', approval = {} }) {
    const what = approval.summary || {};
    const action = [
      `Tool: ${tool || approval.kind || ''}`,
      approval.kind ? `Kind: ${approval.kind}` : '',
      approval.reason ? `Asked because: ${approval.reason}` : '',
      what.path ? `Path: ${what.path}` : '',
      what.to ? `To: ${what.to}` : '',
      what.detail ? `Detail:\n${cut(what.detail, 3000)}` : ''
    ].filter(Boolean).join('\n');
    return [`[CHAT]\n${title}${project ? ` - project ${project}` : ''}`, `[ORDERS FOR THIS CHAT]\n${String(entry.orders || '').trim()}`, `[ACTION]\n${action}`].join('\n\n');
  }

  function parseObject(reply) {
    const text = String(reply || '');
    try { const whole = JSON.parse(text); if (whole && typeof whole === 'object' && !Array.isArray(whole)) return whole; } catch {}
    const found = /\{[\s\S]*\}/.exec(text);
    if (!found) return null;
    try { const part = JSON.parse(found[0]); return part && typeof part === 'object' && !Array.isArray(part) ? part : null; } catch { return null; }
  }

  /** The Master's judgement of a turn, or null when what it answered is not one. */
  function parseVerdict(reply) {
    const data = parseObject(reply);
    if (!data || !['continue', 'done', 'ask'].includes(data.verdict)) return null;
    const message = data.verdict === 'continue' ? String(data.message || '').trim() : '';
    if (data.verdict === 'continue' && !message) return null;
    return { verdict: data.verdict, message, why: cut(oneLine(data.why), 400) };
  }

  /** The Master's answer on a permission, or null when it is not one: then nothing is decided. */
  function parsePermit(reply) {
    const data = parseObject(reply);
    if (!data || typeof data.allow !== 'boolean') return null;
    return { allow: data.allow, why: cut(oneLine(data.why), 400) };
  }

  /** Whether a chat has all it takes to be watched: orders and both limits, chosen by the user. */
  function ready(entry) {
    return Boolean(entry && String(entry.orders || '').trim()) && Number.isInteger(entry.maxSteps) && entry.maxSteps > 0 && Number.isFinite(entry.maxSpend) && entry.maxSpend >= 0;
  }

  /**
   * The limit a watched chat has reached, if any: 'steps' when the character
   * has written to it as many times as allowed since the user was last
   * there, 'spend' when what the chat cost today is what was allowed. A chat
   * that cost nothing (a model on this computer) never reaches the second.
   */
  function limitHit(entry, spentToday) {
    if (!entry) return null;
    if ((entry.steps || 0) >= entry.maxSteps) return 'steps';
    if (spentToday > 0 && spentToday >= entry.maxSpend) return 'spend';
    return null;
  }

  /** A line of a watched chat's record, the last ones kept. */
  function logged(entry, line, most = 30) {
    entry.log = [...(entry.log || []), { at: new Date().toISOString(), ...line }].slice(-most);
    return entry;
  }

  const api = {
    findChat, callsOf, callsText, planText, turnDigest, lastTurn, material,
    WATCH_RULES, PERMIT_RULES, watchRequest, permitRequest, parseVerdict, parsePermit, ready, limitHit, logged, cut, oneLine
  };
  if (typeof window !== 'undefined') window.RealtimeWatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
