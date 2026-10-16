/**
 * SynthOrg - Realtime, the work in the background.
 *
 * Everything the section asks of the Master when nobody is waiting for an
 * answer goes through here, so that it is asked once, in as few words as it
 * takes, and its cost is written down.
 *
 * The jobs:
 *   page     — a day's page of the diary, with the day's data, the notes
 *              about the user, what the habits did, the goals' steps that
 *              seem done and what to put in the agenda: one request. What was
 *              said to the character and not read yet rides along, so that a
 *              day told does not cost a second request for the conversation.
 *   analysis — what was said to the character since the last reading, read
 *              for the notes, the dossier and the agenda. Only the user's
 *              words go, with a line of the answer for context; a few words
 *              wait for more to come before a request is made for them.
 *   study    — for the habits and goals just added: the words that name them
 *              in an account, and, for a habit followed from now on, what
 *              the days already told say of it. All the days in one request,
 *              or a few when they are many.
 *   tidy     — the notes about the user, when they have grown past a bound:
 *              rewritten as fewer, the old ones put away (not deleted) where
 *              the character can still look for them. The notes go to the
 *              character at every exchange: without a bound they would be
 *              what costs most after a year.
 *   data     — a day's data alone, when asked for again.
 *   review   — the week's review, from numbers worked out here.
 *
 * How a request is made:
 *   - one at a time, in a queue; the same job asked twice while it waits or
 *     runs is one job;
 *   - what does not change from a request to the next (the instructions)
 *     comes first and is marked for the provider's cache; what changes comes
 *     last;
 *   - the answer's length is capped, the thinking is kept low unless the
 *     user set it, JSON is asked for as JSON where the model can;
 *   - the app's own settings on caching and on data retention are followed;
 *   - tokens in and out, tokens read from the cache, cost and time are
 *     recorded (Realtime settings, Work in the background).
 *
 * These are methods of the section's object (realtime.js), kept in a file of
 * their own.
 */
(function () {
  'use strict';

  const rt = window.realtime._state;
  const { t, dayStamp, localStamp, plainWords, dayData } = window.realtime._util;
  const W = window.RealtimeWellbeing;

  const READ_BUDGET = 24000;      // characters of accounts or conversation read by one request
  const PAGE_RIDE = 8000;         // characters of conversation that may ride along with a page
  const MIN_WORDS = 12;           // fewer words of the user than this wait for more before an analysis
  const RETRY_MS = 10 * 60000;    // a job that failed is not tried again before this
  // The most an answer may be, in tokens, by job. Thinking counts in it for many models: there is room for it.
  const CAPS = { page: 4000, analysis: 1500, study: 3000, tidy: 3000, data: 1500, review: 1500, advice: 600, watch: 1200, permit: 400 };
  const JOBS = ['page', 'analysis', 'study', 'tidy', 'data', 'review', 'advice', 'watch', 'permit'];
  const NOTES_MOST = 40;          // notes in use past which they are tidied up
  const NOTES_AFTER = 25;         // the most they are afterwards
  const PAST_DAYS = 90;           // the days read for a habit followed from now on: as far back as the wellbeing page shows

  // The formats the answers must come in. They are not the user's to change: the code reads them.
  const PAGE_MARK = '=====';
  const DATA_SHAPE = '{"summary": "one or two sentences", "mood": {"score": 1-5 or null, "label": "a word or two", "notes": "why, if said"}, "energy": 1-5 or null, "stress": 1-5 or null, "sleep_hours": number or null, "activities": [{"name": "…", "category": "work|hobby|health|sport|social|learning|chores|rest|other", "minutes": number or null, "notes": "…"}], "people": ["…"], "highlights": ["…"], "difficulties": ["…"], "goals_mentioned": ["…"], "food": ["…"]}';
  const DATA_RULES = 'The day\'s data: only what the user said; what they did not say is null or an empty list, never a guess. Text values in the language of the account.';
  const MEMORY_SHAPE = '{"add": ["a new note"], "update": [{"id": "n1", "content": "the note rewritten"}], "remove": ["n2"]}';
  const MEMORY_RULES = 'The ids of the notes are the ones in square brackets in the list of the notes already there. "update" rewrites a note; "remove" is only for a note merged into another or made false by what the user said. Nothing to change: empty lists.';
  const HABITS_SHAPE = '{"marks": [{"id": "h1", "done": true}], "propose": [{"name": "a short name", "sign": "positive|negative", "why": "what in the accounts shows it"}]}';
  const HABITS_RULES = 'The habits: "marks" is about the habits the user follows, listed with their ids. For each, "done": true when the account says they did it that day, false when it says they did not; a habit the account does not speak of is left out of "marks". When a question lists habits, the ones listed there that the answer does not give as done are "done": false. "propose" is for something the user does again and again that is not in the lists of habits: it must show in the account of this day and in at least one of the days before. "positive": good for them; "negative": something they would be better off without. Do not propose what the lists already have, under another name either. Nothing to mark or propose: empty lists.';
  const GOALS_SHAPE = '{"steps_done": [{"id": "g1.s2", "why": "what in the account or in the work recorded shows it"}]}';
  const GOALS_RULES = 'The goals: the user\'s open goals are listed with their steps, each with an id. "steps_done" is for the open steps that the account, or the work recorded in the app that day, shows as finished on this day: finished, not only worked at. It is a proposal the user will confirm: when in doubt leave the step out. Nothing finished: an empty list.';
  const AGENDA_SHAPE = '[{"kind": "reminder|activity", "title": "short, as the user would write it", "start": "YYYY-MM-DDTHH:MM", "end": "YYYY-MM-DDTHH:MM, for an activity", "why": "the user\'s words it comes from"}]';
  const AGENDA_RULES = 'The agenda: something the user said they will do, or must remember, on a day still to come, which the agenda given does not have already. A reminder is a moment; an activity lasts from a start to an end, and is one only when the user said when it ends or how long it lasts: an end is never made up. The day must be said or plain from the words ("tomorrow", "on Thursday"), worked out from the date given as now; the hour is 09:00 when none is said. It is a proposal the user will confirm: a wish without a day is not one. Nothing to propose: an empty list.';
  const PAUSES_SHAPE = '[{"name": "a few words, as the user would say it", "minutes": number, "why": "the user\'s words it comes from"}]';
  const PAUSES_RULES = 'The pauses: something short the user says they like to do to take a break from work (a coffee, a walk, some stretching), with the minutes it takes (10 when not said). Only what they say of themselves, and not what the list of the pauses already has, under another name either. It is a proposal the user will confirm. Nothing to propose: an empty list.';
  const DOSSIER_SECTIONS = ['user_profile', 'preferences', 'active_projects', 'archive_projects', 'general_notes'];

  const setting = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const list = (v) => (Array.isArray(v) ? v : []);
  const wordsIn = (text) => (String(text || '').match(/[\p{L}\p{N}]+/gu) || []).length;

  /** A JSON object out of a model's reply, whatever is around it; null when there is none. */
  function parseJson(reply) {
    if (!reply) return null;
    const body = String(reply);
    const from = body.indexOf('{');
    const to = body.lastIndexOf('}');
    if (from < 0 || to <= from) return null;
    try {
      const value = JSON.parse(body.slice(from, to + 1));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch { return null; }
  }

  /**
   * The Master's reply for a diary page: the page, the mark, the JSON. A
   * reply without the mark is split where its last JSON object starts; one
   * without JSON is all page.
   */
  function parsePage(reply) {
    const text = String(reply || '').replace(/\r/g, '').trim();
    let at = text.lastIndexOf(PAGE_MARK);
    let json = at >= 0 ? parseJson(text.slice(at + PAGE_MARK.length)) : null;
    if (at < 0) {
      for (let i = text.lastIndexOf('\n{'); i >= 0 && !json; i = text.lastIndexOf('\n{', i - 1)) {
        json = parseJson(text.slice(i));
        if (json && (json.data || json.memories)) at = i; else json = null;
      }
    }
    const page = (at >= 0 ? text.slice(0, at) : text)
      .replace(/^```[a-z]*\n?|\n?```$/g, '')
      .replace(/^#{1,6}\s+.*\n+/, '')
      .replace(/[=\s]+$/, '')
      .trim();
    const object = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
    return { page, json: object(json) || {} };
  }

  Object.assign(rt, {
    jobsQueue: Promise.resolve(),
    jobsWaiting: new Map(),    // key -> the promise of a job waiting or running
    jobsFailed: new Map(),     // key -> when it last failed
    usage: null,               // what the jobs cost in the last thirty days (loadUsage)

    /**
     * A request as it goes out: the app's settings on caching and on data
     * retention applied. A system message given in parts (what stays the
     * same first, what changes last) keeps its parts, the ones that stay
     * marked for the cache; for a model on this computer it is one text.
     * parts: [{ text, keep }] or a string.
     */
    wire(payload, session) {
      const local = Boolean(window.modelGateway?.isLocal?.(payload.model));
      const caching = !local && setting('synthorg_prompt_caching_enabled', 'true') !== 'false';
      payload.messages = payload.messages.map(message => {
        if (!Array.isArray(message.parts)) return message;
        const parts = message.parts.filter(part => part && part.text);
        const { parts: _, ...rest } = message;
        if (!caching) return { ...rest, content: parts.map(part => part.text).join('\n\n') };
        return { ...rest, content: parts.map(part => ({ type: 'text', text: part.text, ...(part.keep ? { cache_control: { type: 'ephemeral' } } : {}) })) };
      });
      // The character speaks: a model on this computer that can think before answering is told not to.
      if (local) payload.chat_template_kwargs = { enable_thinking: false, ...(payload.chat_template_kwargs || {}) };
      if (caching && session) payload.session_id = String(session);
      if (!local && setting('synthorg_openrouter_zdr_enabled', 'false') === 'true') {
        payload.provider = { ...(payload.provider || {}), zdr: true, data_collection: 'deny' };
      }
      return payload;
    },

    /** A job of the queue: run after the ones before it; asked again while it waits or runs, it is the same job. */
    job(key, run) {
      if (this.jobsWaiting.has(key)) return this.jobsWaiting.get(key);
      const promise = this.jobsQueue.then(run);
      this.jobsQueue = promise.catch(() => {});
      this.jobsWaiting.set(key, promise);
      promise.then(() => this.jobsFailed.delete(key), () => this.jobsFailed.set(key, Date.now()))
        .finally(() => { this.jobsWaiting.delete(key); this.renderControls(); });
      return promise;
    },

    /** Whether a job that failed may be tried again by itself: not at once, or a fault would be asked for over and over. */
    mayRetry(key) {
      const failed = this.jobsFailed.get(key);
      return !failed || Date.now() - failed > RETRY_MS;
    },

    /**
     * One request to the Master. kind: the job, for the record. stable: the
     * instructions, the same from a request to the next; user: what is to be
     * read. json: the answer is a JSON object and nothing else. Returns the
     * answer's text. An answer cut short by the cap is asked for once more
     * with twice the room. about: the chat the request is about, when it is
     * not the character's own: what it costs is counted with that chat.
     */
    async master(kind, { stable, user, json = false, cap = CAPS[kind], about = null }) {
      const registry = window.operationalRegistry;
      const master = registry?.getCurrentMasterModel?.();
      if (!master) throw new Error(t('realtime.noMaster'));
      const local = Boolean(window.modelGateway?.isLocal?.(master.id));
      const apiKey = window.openRouterCatalog?.getApiKey?.() || (local ? 'local' : '');
      if (!apiKey) throw new Error(t('realtime.noKey'));
      const supported = window.openRouterCatalog?.models?.find(m => m.id === master.id)?.supportedParameters || [];
      const own = registry?.getModelParameters?.(master.id) || {};
      const payload = {
        model: master.id,
        stream: false,
        messages: [{ role: 'system', parts: [{ text: stable, keep: true }] }, { role: 'user', content: user }],
        max_tokens: cap
      };
      if (!local) payload.usage = { include: true };
      // Reading and sorting need a steady hand; the writing keeps the temperature the user gave the Master.
      if (supported.includes('temperature')) {
        if (json) payload.temperature = 0.2;
        else if (own.temperature !== undefined) payload.temperature = Number(own.temperature);
      }
      if (supported.includes('reasoning') || supported.includes('reasoning_effort')) {
        payload.reasoning = { effort: own.reasoning_effort && own.reasoning_effort !== 'default' ? own.reasoning_effort : 'low' };
      }
      if (json && supported.includes('response_format')) payload.response_format = { type: 'json_object' };
      this.wire(payload, 'realtime-jobs');
      const started = Date.now();
      const record = (ok, usage = {}) => window.chatStorage.recordJob({
        kind, model: master.id, ok, ms: Date.now() - started,
        promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens, cost: usage.cost
      }).catch(() => {});
      let data = null;
      try {
        const response = await window.modelGateway.fetchChat({
          method: 'POST',
          track: { conversationId: about || this.conversationId, role: `job:${kind}` },
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://synthorg.local', 'X-Title': 'SynthOrg Realtime' },
          body: JSON.stringify(payload)
        });
        data = await response.json().catch(() => null);
        if (!response.ok || data?.error) throw new Error(data?.error?.message || `HTTP ${response.status}`);
      } catch (err) {
        record(false, data?.usage);
        throw err;
      }
      const choice = data?.choices?.[0];
      const reply = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
      const cut = choice?.finish_reason === 'length';
      record(Boolean(reply) && !cut, data?.usage);
      if (cut && cap < CAPS[kind] * 2) return this.master(kind, { stable, user, json, cap: cap * 2, about });
      if (!reply) throw new Error(t('realtime.emptyReply', { model: master.name || master.id }));
      return reply;
    },

    /* -------------------------------------------------------------- */
    /* What was said to the character and not read yet                  */
    /* -------------------------------------------------------------- */

    /**
     * The conversation since the last reading, as it is given to be read:
     * the user's words whole, a line of each answer for what a "yes" was
     * said to, nothing of what the app told the character. It stops at
     * `budget` characters: what is left is for the next reading.
     *   text: the stretch; words: the user's words in it; last: the last
     *   message it covers; more: there is more after it.
     * Null when there is no conversation or nothing new in it.
     */
    async unread(budget = READ_BUDGET) {
      if (!this.conversationId) return null;
      const conversationId = this.conversationId;
      let mark = {};
      try { mark = JSON.parse((await window.chatStorage.getSetting('realtime_analyzed'))?.value || '{}'); } catch {}
      if (!mark.conversationId) {
        // Never read before: what is there was read exchange by exchange as it was said.
        await this.read((await window.chatStorage.messagesAfter(conversationId, 0, 1)).last);
        return null;
      }
      const from = mark.conversationId === conversationId ? Number(mark.sequence) || 0 : 0;
      // Only what came after the last reading: the conversation has no end, and is not read whole.
      const all = (await window.chatStorage.messagesAfter(conversationId, from, 2000)).messages || [];
      const placeholder = [t('realtime.voiceMessage'), '(messaggio vocale)', '(voice message)'];
      // What the app told the character, saved before such messages were marked.
      const told = /^\[(Esito del compito|Il compito affidato|Promemoria arrivato)/;
      const turns = all.filter(m => m.sequence > from && m.kind === 'final' && m.status === 'complete' && ['user', 'assistant'].includes(m.role) && m.content);
      if (!turns.length) return null;
      const lines = [];
      let size = 0, words = 0, last = from, more = false;
      let skipAnswer = false;
      for (const m of turns) {
        let line = '';
        if (m.role === 'user') {
          // What follows something the app said is the character telling it: not the user's, not read.
          skipAnswer = Boolean(m.report) || told.test(m.content) || placeholder.includes(m.content);
          if (!skipAnswer) line = `[User] ${m.content.slice(0, 2000)}`;
        } else if (!skipAnswer) {
          line = `[Assistant] ${m.content.replace(/\s+/g, ' ').slice(0, 160)}`;
        }
        if (line && size + line.length > budget && lines.length) { more = true; break; }
        if (line) {
          lines.push(line);
          size += line.length;
          if (m.role === 'user') words += wordsIn(m.content);
        }
        last = m.sequence;
      }
      return { text: lines.join('\n'), words, last, more };
    },

    /** The conversation is read up to a message: the next reading starts after it. */
    async read(sequence) {
      const at = new Date().toISOString();
      await window.chatStorage.setSetting('realtime_analyzed', JSON.stringify({ conversationId: this.conversationId, sequence, at }));
      this.analyzedAt = at;
    },

    /** What the agenda holds from now on, as a model is shown it, and the moment it is. */
    async agendaText() {
      const now = new Date();
      let items = [];
      try { items = await window.chatStorage.request(`/agenda?from=${localStamp(now)}&to=${dayStamp(new Date(now.getTime() + 60 * 86400000))}T00:00&open=true`); } catch {}
      let waiting = [];
      try { waiting = await window.chatStorage.agendaProposals(); } catch {}
      const line = (i) => `${i.start_at}${i.end_at ? ' → ' + i.end_at : ''} ${i.kind}: ${i.title}`;
      return [
        `Now: ${localStamp(now)}, ${now.toLocaleDateString('en-GB', { weekday: 'long' })}.`,
        `Agenda from now on:\n${items.filter(i => !i.done).slice(0, 60).map(line).join('\n') || '(nothing)'}`,
        waiting.length ? `Already proposed, waiting for the user:\n${waiting.map(line).join('\n')}` : ''
      ].filter(Boolean).join('\n');
    },

    /** What a model proposed for the agenda, kept as proposals: only days still to come, only what is well formed. */
    async applyAgenda(items) {
      const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
      const now = localStamp(new Date());
      let added = 0;
      for (const item of list(items).slice(0, 5)) {
        const title = String(item?.title || '').trim().slice(0, 300);
        const start = String(item?.start || '').slice(0, 16);
        const kind = item?.kind === 'activity' ? 'activity' : 'reminder';
        const end = kind === 'activity' && stamp.test(String(item?.end || '').slice(0, 16)) ? String(item.end).slice(0, 16) : null;
        if (!title || !stamp.test(start) || start <= now || (end && end < start)) continue;
        try {
          const saved = await window.chatStorage.saveAgenda({ kind, title, startAt: start, endAt: end, proposed: true, why: String(item.why || '').trim().slice(0, 600), source: 'realtime' });
          if (saved.proposed) added++;
        } catch {}
      }
      if (added) this.loadCalendar?.();
      return added;
    },

    /** The pauses the app knows of, whatever the user made of them: a model is not to propose them again. */
    pausesText() {
      const known = (this.likedPauses || []).map(p => p.name);
      return `Pauses already in the list: ${known.length ? known.join(', ') : 'none'}`;
    },

    /** Pauses the user likes, as a model found them in the user's words: kept as proposals, for the user to confirm. */
    async applyPauses(items) {
      let added = 0;
      for (const item of list(items).slice(0, 3)) {
        const name = String(item?.name || '').trim().slice(0, 80);
        const minutes = Math.round(Number(item?.minutes));
        if (!name || (this.likedPauses || []).some(p => plainWords(p.name) === plainWords(name))) continue;
        try {
          const saved = await window.chatStorage.saveLikedPause({
            name, minutes: Number.isFinite(minutes) && minutes >= 1 && minutes <= 60 ? minutes : 10,
            status: 'proposed', why: String(item.why || '').trim().slice(0, 600), source: 'model'
          });
          this.likedPauses = [...(this.likedPauses || []), saved];
          added++;
        } catch {}
      }
      if (added) { this.renderSide(); this.renderSettings(); }
      return added;
    },

    /** Facts every chat should know, proposed for the global dossier: shown to the user, who saves them or not. */
    applyDossier(items) {
      list(items).slice(0, 3).forEach(p => {
        const content = String(p?.content || '').trim().slice(0, 600);
        if (!content || this.proposals.some(x => x.content === content)) return;
        this.proposals.push({ id: crypto.randomUUID(), section: DOSSIER_SECTIONS.includes(p.section) ? p.section : 'general_notes', content });
      });
    },

    /* -------------------------------------------------------------- */
    /* The jobs                                                         */
    /* -------------------------------------------------------------- */

    /**
     * The analysis of the conversations: what was said to the character
     * since the last reading, read by the Master for the notes about the
     * user, the global dossier and the agenda. It runs when a session ends
     * (microphone off, tab left) and when the section is first opened. A
     * few words wait for more before a request is made for them, unless it
     * is asked for by hand. A long stretch is read in pieces.
     */
    analyze({ manual = false } = {}) {
      if (!this.conversationId) return Promise.resolve({ read: 0, changed: 0 });
      if (!manual && !this.mayRetry('analysis')) return Promise.resolve({ read: 0, changed: 0 });
      return this.job('analysis', async () => {
        this.analyzing = true;
        this.renderSettings();
        const result = { read: 0, changed: 0, waiting: 0, failed: false };
        try {
          await this.settled();
          const prompt = await this.custom('memoryPrompt');
          for (let piece = 0; piece < 20; piece++) {
            const stretch = await this.unread();
            if (!stretch) break;
            if (!stretch.words) { await this.read(stretch.last); if (!stretch.more) break; continue; }
            if (!manual && !stretch.more && stretch.words < MIN_WORDS) { result.waiting = stretch.words; break; }
            const { ids, list: notes } = this.knownNotes();
            const data = parseJson(await this.master('analysis', {
              json: true,
              stable: [
                'You are given a stretch of conversation between a user and their assistant: the user\'s words, and the first line of each answer only to show what the user was answering to. Four things are asked of you.',
                `1. THE NOTES ABOUT THE USER\n${prompt}`,
                '2. THE GLOBAL DOSSIER\nA fact every other chat of the app should know about the user (who they are, how they like to work, a project) can be proposed for the global dossier: rarely.',
                `3. THE AGENDA\n${AGENDA_RULES}`,
                `4. THE PAUSES\n${PAUSES_RULES}`,
                `Reply only with JSON: {"memories": ${MEMORY_SHAPE}, "dossier": [{"section": "${DOSSIER_SECTIONS.join('|')}", "content": "one or two sentences"}], "agenda": ${AGENDA_SHAPE}, "pauses": ${PAUSES_SHAPE}}\n${MEMORY_RULES}`
              ].join('\n\n'),
              user: `${await this.agendaText()}\n\n${this.pausesText()}\n\nNotes already there:\n${notes}\n\nConversation:\n${stretch.text}`
            }));
            if (!data) throw new Error(t('realtime.diaryNoData'));
            result.changed += await this.applyMemories(data.memories, ids, 'conversation');
            result.changed += await this.applyAgenda(data.agenda);
            result.changed += await this.applyPauses(data.pauses);
            this.applyDossier(data.dossier);
            result.read += stretch.words;
            await this.read(stretch.last);
            if (!stretch.more) break;
          }
        } catch (err) {
          result.failed = true;
          result.error = err.message;
          throw Object.assign(err, { result });
        } finally {
          this.analyzing = false;
          this.renderSide();
          this.renderSettings();
        }
        return result;
      }).catch(err => err.result || { read: 0, changed: 0, failed: true, error: err.message });
    },

    /**
     * The day's page, written by the Master from the whole account of the
     * day. One request gives the page, the day's data, the notes about the
     * user, what the habits did, the goals' steps that seem done and what to
     * put in the agenda; what was said to the character and not read yet is
     * read in the same request. Returns the page, or null when it could not
     * be written (the reason is shown on the day).
     */
    writePage(day) {
      return this.job(`page:${day}`, async () => {
        this.writing.add(day);
        this.pageErrors.delete(day);
        this.renderSide();
        this.renderControls();
        try {
          const entry = (await window.chatStorage.diary(day, day, 1))[0];
          if (!entry) throw new Error(t('realtime.diaryNoAccount'));
          if (!this.conversationId) await this.ensure();
          const [pagePrompt, memoryPrompt] = await Promise.all([this.custom('pagePrompt'), this.custom('memoryPrompt')]);
          const { ids, list: notes } = this.knownNotes();
          const known = await this.knownHabits(day);
          await this.loadGoals();
          const goals = this.knownGoals();
          const [work, agenda, stretch] = await Promise.all([this.workOfDay(day), this.agendaText(), this.unread(PAGE_RIDE).catch(() => null)]);
          const talk = stretch?.words ? stretch : null;
          const reply = await this.master('page', {
            stable: [
              'You are given what a person told about one day: their account, then their answers to a few questions (each question is marked, the answer follows it). After it there may be what the same person said to their assistant since the last reading. Seven things are asked of you.',
              `1. THE PAGE\n${pagePrompt}\nThe page is written from the account and the answers only.`,
              `2. THE DAY'S DATA\n${DATA_RULES}\nFrom the account and the answers only.`,
              `3. THE NOTES ABOUT THE USER\n${memoryPrompt}\nFrom the account, the answers and the conversation.`,
              `4. THE HABITS\n${HABITS_RULES}\nFrom the account and the answers only.`,
              `5. THE GOALS\n${GOALS_RULES}`,
              `6. THE AGENDA\n${AGENDA_RULES}\nFrom the account, the answers and the conversation.`,
              `7. THE PAUSES\n${PAUSES_RULES}\nFrom the account, the answers and the conversation.`,
              `FORMAT OF THE REPLY, to follow exactly:\nFirst the page, as plain text: no title, no date, no markdown, paragraphs separated by an empty line.\nThen a line with only ${PAGE_MARK}\nThen one JSON object: {"data": ${DATA_SHAPE}, "memories": ${MEMORY_SHAPE}, "habits": ${HABITS_SHAPE}, "goals": ${GOALS_SHAPE}, "agenda": ${AGENDA_SHAPE}, "pauses": ${PAUSES_SHAPE}}\n${MEMORY_RULES}`
            ].join('\n\n'),
            user: [
              `Day of the account: ${day} (${new Date(`${day}T12:00`).toLocaleDateString('en-GB', { weekday: 'long' })})`,
              agenda,
              this.pausesText(),
              `Notes already there:\n${notes}`,
              `Habits the user follows:\n${known.followed}`,
              `Habits already proposed or turned down:\n${known.others}`,
              `What they did in the days before:\n${known.before}`,
              `Open goals and their steps:\n${goals.list}`,
              `Work recorded in the app on this day:\n${work}`,
              `Account:\n${entry.raw_text}`,
              talk ? `Conversation with the assistant since the last reading:\n${talk.text}` : ''
            ].filter(Boolean).join('\n\n')
          });
          const { page, json } = parsePage(reply);
          if (!page) throw new Error(t('realtime.diaryEmptyPage'));
          const data = json.data && typeof json.data === 'object' ? json.data : null;
          await window.chatStorage.saveDiary({ pageText: page, ...(data ? { extracted: data } : {}) }, entry.id);
          await this.applyMemories(json.memories, ids, `diary:${day}`);
          await this.applyHabits(json.habits, known.ids, day);
          await this.applyGoals(json.goals, goals.ids, day);
          await this.applyAgenda(json.agenda);
          await this.applyPauses(json.pauses);
          // The conversation that rode along is read: no request of its own will be made for it.
          if (stretch && (talk || !stretch.more)) await this.read(stretch.last);
          await this.loadDiary();
          await this.loadWellbeing();
          // The page came without its data: they are asked for on their own.
          if (!data) this.writeData(day).catch(() => {});
          // A page of last week may be what its review was waiting for.
          this.weeklyReview();
          return page;
        } catch (err) {
          this.pageErrors.set(day, err.message);
          return null;
        } finally {
          this.writing.delete(day);
          this.renderSide();
          this.renderControls();
          this.renderSettings();
        }
      });
    },

    /** The day's data alone, worked out again from the account by the Master. */
    writeData(day) {
      return this.job(`data:${day}`, async () => {
        const entry = (await window.chatStorage.diary(day, day, 1))[0];
        if (!entry) throw new Error(t('realtime.diaryNoAccount'));
        const data = parseJson(await this.master('data', {
          json: true,
          stable: `You turn what a person told about their day into data for their private diary. ${DATA_RULES}\nReply only with JSON of this shape: ${DATA_SHAPE}`,
          user: `Day: ${day}\n\nAccount:\n${entry.raw_text}`
        }));
        if (!data) throw new Error(t('realtime.diaryNoData'));
        await window.chatStorage.saveDiary({ extracted: data }, entry.id);
        await this.loadDiary();
        await this.loadWellbeing();
        return data;
      });
    },

    /**
     * The study of what was just added. For the habits followed and the
     * open goals that have none, the words that name them in an account
     * (the forms people say them in), which decide what is asked about at
     * the end of a diary session. For a habit followed from now on, what the
     * days already told say of it: all the days in one request, or a few
     * when they are many; only where nothing is known yet.
     */
    study() {
      const habits = this.habits.filter(h => h.status === 'tracked');
      const goals = (this.goals || []).filter(g => g.status === 'open');
      const unnamed = [...habits.filter(h => !h.keywords), ...goals.filter(g => !g.keywords)];
      const unread = habits.filter(h => !h.read_at);
      if ((!unnamed.length && !unread.length) || !this.mayRetry('study')) return Promise.resolve(null);
      return this.job('study', async () => {
        this.studying = true;
        this.renderSide();
        try {
          const ids = new Map();
          [...new Set([...unnamed, ...unread])].forEach((item, i) => ids.set(`k${i + 1}`, item));
          const idOf = (item) => [...ids].find(([, x]) => x === item)[0];
          const isHabit = (item) => habits.includes(item);
          let days = [];
          if (unread.length) {
            const today = dayStamp(new Date());
            const [entries, marks] = await Promise.all([window.chatStorage.diary(W.shift(today, -(PAST_DAYS - 1)), today, PAST_DAYS), window.chatStorage.habitDays(W.shift(today, -(PAST_DAYS - 1)), today)]);
            const known = new Set(marks.map(m => `${m.habit_id} ${m.day}`));
            days = entries.filter(e => unread.some(h => !known.has(`${h.id} ${e.day}`))).sort((a, b) => a.day.localeCompare(b.day));
          }
          // The days in pieces of what one request reads; with no day to read, one request for the words alone.
          const pieces = [];
          let piece = [], size = 0;
          days.forEach(e => {
            const text = e.raw_text.slice(0, 6000);
            if (piece.length && size + text.length > READ_BUDGET) { pieces.push(piece); piece = []; size = 0; }
            piece.push({ day: e.day, text });
            size += text.length;
          });
          if (piece.length || !pieces.length) pieces.push(piece);
          const describe = (item) => `[${idOf(item)}] ${isHabit(item) ? 'habit' : 'goal'}: ${item.name}${item.notes ? ` — ${item.notes}` : ''}`;
          let marked = 0;
          for (const [index, part] of pieces.entries()) {
            const wantsWords = index === 0 && unnamed.length;
            if (!wantsWords && !part.length) continue;
            const data = parseJson(await this.master('study', {
              json: true,
              stable: [
                'You are given habits a person follows and goals they have, each with an id, and you may be given what the person told about some days, each day under its date. Two things may be asked of you.',
                'THE WORDS: for each item listed under "Words wanted", the words that would show, in the person\'s own account of a day, that they are speaking of it: the noun, the verb in the forms people say it in, close synonyms. In the person\'s language, lower case, single words or very short phrases, from five to twelve. Words so common that they would show in any account are left out.',
                'THE DAYS: for each day given and each habit listed under "Habits to read", whether the account of that day says the habit was done (true) or says it was not (false). A habit the account of a day does not speak of is left out for that day: never a guess.',
                'Reply only with JSON: {"words": {"k1": ["…"]}, "days": {"YYYY-MM-DD": {"k1": true}}}. What is not asked for is an empty object.'
              ].join('\n\n'),
              user: [
                `Words wanted:\n${wantsWords ? unnamed.map(describe).join('\n') : '(none)'}`,
                `Habits to read:\n${part.length ? unread.map(describe).join('\n') : '(none)'}`,
                part.length ? `Days:\n${part.map(d => `### ${d.day}\n${d.text}`).join('\n\n')}` : ''
              ].filter(Boolean).join('\n\n')
            }));
            if (!data) throw new Error(t('realtime.diaryNoData'));
            for (const [id, given] of Object.entries(data.words && typeof data.words === 'object' ? data.words : {})) {
              const item = ids.get(id);
              const keywords = list(given).map(w => String(w)).filter(Boolean);
              if (!item || !unnamed.includes(item) || !keywords.length) continue;
              await (isHabit(item) ? window.chatStorage.saveHabit({ keywords }, item.id) : window.chatStorage.saveGoal({ keywords }, item.id)).catch(() => {});
            }
            const marks = [];
            for (const [day, said] of Object.entries(data.days && typeof data.days === 'object' ? data.days : {})) {
              if (!part.some(d => d.day === day) || !said || typeof said !== 'object') continue;
              for (const [id, done] of Object.entries(said)) {
                const habit = ids.get(id);
                if (habit && unread.includes(habit) && typeof done === 'boolean') marks.push({ habitId: habit.id, day, done });
              }
            }
            if (marks.length) marked += (await window.chatStorage.addDiaryMarks(marks)).added;
          }
          // An item the model gave no words for keeps its name as its only word: it is not asked again.
          for (const item of unnamed) {
            const now = isHabit(item) ? (await window.chatStorage.habits()).find(h => h.id === item.id) : (await window.chatStorage.goals()).find(g => g.id === item.id);
            if (now && !now.keywords) await (isHabit(item) ? window.chatStorage.saveHabit({ keywords: [item.name] }, item.id) : window.chatStorage.saveGoal({ keywords: [item.name] }, item.id)).catch(() => {});
          }
          for (const habit of unread) await window.chatStorage.saveHabit({ readAt: true }, habit.id).catch(() => {});
          return { marked, days: days.length };
        } finally {
          this.studying = false;
          await this.loadGoals();
          await this.loadWellbeing();
        }
      }).catch(err => { this.studyError = err.message; this.renderSide(); return null; });
    },

    /**
     * The notes tidied up. The notes in use go to the character at every
     * exchange and to the Master with every page: past a number they are
     * rewritten by the Master as fewer, joined by subject, nothing lasting
     * lost. The old ones are put away, not deleted: the settings show them,
     * they can be brought back, and the character can look among them.
     */
    tidy() {
      if (this.notes.length <= NOTES_MOST || !this.mayRetry('tidy')) return Promise.resolve(null);
      return this.job('tidy', async () => {
        const old = [...this.notes];
        const given = old.map((note, i) => `[n${i + 1}] ${note.content}`).join('\n');
        const data = parseJson(await this.master('tidy', {
          json: true,
          stable: [
            `You are given the notes a personal assistant has about its user, from the most recent to the oldest. They have grown too many. Rewrite them as at most ${NOTES_AFTER} notes.`,
            'Join the notes about the same subject into one. Keep every lasting fact: names, places, dates, numbers, as they are written. Where two notes disagree, what the more recent one says stands. Leave out only what is the fact of a single day or is said twice.',
            'Each note is one or two sentences, in the language of the notes.',
            'Reply only with JSON: {"notes": ["…"]}'
          ].join('\n\n'),
          user: `Notes:\n${given}`
        }));
        const notes = list(data?.notes).map(n => String(n || '').trim().slice(0, 600)).filter(Boolean);
        // Too few to hold what there was, or no fewer than before: nothing is changed.
        if (notes.length < 3 || notes.length > NOTES_AFTER + 5) throw new Error(t('realtime.diaryNoData'));
        const base = { scope: 'conversation', conversationId: this.conversationId, section: 'about_user' };
        for (const content of notes) await window.chatStorage.saveMemory({ ...base, content, pinned: true, origin: 'tidy' });
        for (const note of old) await window.chatStorage.saveMemory({ ...base, content: note.content, pinned: false, enabled: false }, note.id);
        await this.loadNotes();
        return { before: old.length, after: notes.length };
      }).catch(() => null);
    },

    /**
     * The weekly review: the week that ended (Monday to Sunday) read by the
     * Master, which writes a short review the character says and the
     * wellbeing page keeps. Written once per week, the first time the section
     * is used after the week ended, and only if a day of it was told. The
     * Master is given numbers worked out here, not the accounts.
     */
    weeklyReview({ manual = false } = {}) {
      if (!manual && !this.mayRetry('review')) return Promise.resolve(null);
      return this.job('review', async () => {
        const week = W.weekBefore(dayStamp(new Date()));
        if (!manual && (await window.chatStorage.reviews(12)).some(r => r.from_day === week.from && r.to_day === week.to)) return null;
        const now = await this.wellbeingOf(week.from, week.to);
        if (!now.told) { if (manual) throw new Error(t('realtime.reviewNoDays')); return null; }
        this.reviewing = true;
        this.reviewError = '';
        this.renderSide();
        try {
          const before = await this.wellbeingOf(W.shift(week.from, -7), W.shift(week.to, -7));
          const text = await this.master('review', {
            stable: `${await this.custom('reviewPrompt')}\n\nReply with the review only, as plain text.`,
            user: `THE WEEK\n${this.wellbeingText(now)}\n\n${await this.goalsText(week.from, week.to)}\n\nTHE WEEK BEFORE\n${before.told ? this.wellbeingText(before) : 'No day told.'}`
          });
          await window.chatStorage.saveReview({ fromDay: week.from, toDay: week.to, text });
          this.reviewing = false;
          await this.loadWellbeing();
          // Asked for by hand, it is read on the page; the week's own is told.
          if (!manual) this.tell({ say: text });
          return text;
        } finally {
          this.reviewing = false;
          this.renderSide();
        }
      }).catch(err => { this.reviewError = err.message; this.renderSide(); return null; });
    },

    /* -------------------------------------------------------------- */
    /* What the jobs cost                                               */
    /* -------------------------------------------------------------- */

    async loadUsage() {
      const today = dayStamp(new Date());
      try { this.usage = await window.chatStorage.jobs(W.shift(today, -29), today); } catch { this.usage = null; }
    },

    /** The jobs, what each is for and when it runs, and what each cost in the last thirty days. */
    renderSettings_jobs() {
      const esc = window.realtime._util.esc;
      const number = (v) => Number(v || 0).toLocaleString(window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT');
      const money = (v) => (v === null || v === undefined ? '—' : `$ ${Number(v).toLocaleString(window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`);
      const kinds = new Map((this.usage?.kinds || []).map(k => [k.kind, k]));
      const total = (key) => (this.usage?.kinds || []).reduce((sum, k) => sum + (Number(k[key]) || 0), 0);
      const master = window.operationalRegistry?.getCurrentMasterModel?.();
      const rows = JOBS.map(kind => {
        const k = kinds.get(kind);
        return `<tr>
          <th>${esc(t('realtime.job_' + kind))}<small>${esc(t('realtime.jobWhen_' + kind))}</small></th>
          <td>${k ? number(k.runs) : '0'}${k && k.done < k.runs ? `<small>${esc(t('realtime.jobFailed', { count: k.runs - k.done }))}</small>` : ''}</td>
          <td>${k ? number(k.prompt_tokens) : '0'}${k?.cached_tokens ? `<small>${esc(t('realtime.jobCached', { tokens: number(k.cached_tokens) }))}</small>` : ''}</td>
          <td>${k ? number(k.completion_tokens) : '0'}</td>
          <td>${k ? money(k.cost) : '—'}</td>
          <td>${k ? esc(t('realtime.jobSeconds', { seconds: this.figure(k.ms / 1000) })) : '—'}</td>
        </tr>`;
      }).join('');
      return `
        <section class="rt-set-block">
          <h3>${esc(t('realtime.jobsTitle'))}</h3>
          <p class="rt-hint">${esc(t('realtime.jobsHint', { model: master?.name || master?.id || t('realtime.noneAssigned') }))}</p>
          <table class="rt-link rt-jobs">
            <thead><tr><th>${esc(t('realtime.jobsJob'))}</th><th>${esc(t('realtime.jobsRuns'))}</th><th>${esc(t('realtime.jobsIn'))}</th><th>${esc(t('realtime.jobsOut'))}</th><th>${esc(t('realtime.jobsCost'))}</th><th>${esc(t('realtime.jobsTime'))}</th></tr></thead>
            <tbody>${rows}
              <tr class="rt-jobs-total"><th>${esc(t('realtime.jobsTotal'))}</th><td>${number(total('runs'))}</td><td>${number(total('prompt_tokens'))}</td><td>${number(total('completion_tokens'))}</td><td>${this.usage?.kinds?.some(k => k.cost !== null) ? money(total('cost')) : '—'}</td><td></td></tr>
            </tbody>
          </table>
          <p class="rt-hint">${esc(t('realtime.jobsPeriod'))}</p>
        </section>
        <section class="rt-set-block">
          <h3>${esc(t('realtime.jobsHowTitle'))}</h3>
          <ul class="rt-list rt-jobs-how">${['queue', 'ride', 'wait', 'cache', 'cap', 'bound', 'kept', 'local', 'notices'].map(key => `<li class="rt-hint">${esc(t('realtime.jobsHow_' + key))}</li>`).join('')}</ul>
        </section>`;
    }
  });

  window.realtime._jobs = { parsePage, parseJson, READ_BUDGET, MIN_WORDS, CAPS, NOTES_MOST, NOTES_AFTER, PAST_DAYS };
})();
