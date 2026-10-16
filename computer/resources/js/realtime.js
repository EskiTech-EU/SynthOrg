/**
 * SynthOrg - Realtime.
 *
 * Talking to the character. It hears with the model of the Realtime Multi
 * role (audio in, text and tools out) and speaks with the Speech synthesis
 * one, while the puppet moves its mouth with the sound. It has one endless
 * conversation of its own, with the level memory always on. What needs tools
 * or real work it does at its computer: the Master does it in the "Realtime ·
 * compiti" chat in the background; when that is done, the character hears
 * the outcome and tells it.
 *
 * The diary is not a conversation: it is a session with fixed steps. The
 * user tells the day, the character asks the questions of a list, one at a
 * time, and the Master writes the day's page from the whole account, with
 * the day's data and what it taught about the user.
 *
 * What it knows about the user (the memories) is written in the background:
 * from the diary by the Master, from the conversations by an analysis that
 * runs when a session ends. Memories, the day's data and the prompts that
 * produce them are managed in the section's settings, behind the gear.
 *
 * The character's tools are a registry (REALTIME_TOOLS): what it will be able
 * to do later — reading mail — is added there.
 */
(function () {
  'use strict';

  const OUTPUT_RATE = 24000;     // pcm16 from the model
  const INPUT_RATE = 16000;      // what is sent: wav, mono, 16 bit
  const SILENCE_END_MS = 700;    // a pause this long ends what you are saying
  const MIN_SPEECH_MS = 350;
  const MAX_SPEECH_MS = 60000;
  const PRE_ROLL_MS = 300;       // kept before the voice starts, so the first syllable is not cut
  const MAX_TOOL_ROUNDS = 4;
  const ANSWER_GAP_MS = 2500;    // diary: a silence this long after an answer brings the next question
  // The voices of the Speech synthesis model, as OpenRouter lists them for
  // it (supported_voices); the first is the default. None listed: the model
  // picks its own, and no voice is sent.
  const voicesFor = (modelId) => window.openRouterCatalog?.models?.find(m => m.id === modelId)?.supportedVoices || [];
  const SPEECH_URL = 'https://openrouter.ai/api/v1/audio/speech';
  // Where the share of high second-formant energy makes a round or a spread mouth (measured on the voices).
  const ROUND_BELOW = 0.1;
  const SPREAD_ABOVE = 0.4;

  const DIARY_PAGE = 14;         // days of the diary read and shown at a time
  const KEPT_LINES = 80;         // spoken lines kept on this computer, the least used going first
  const KEPT_LINE_MOST = 300;    // characters: a line longer than this is not one said every day
  const SPOKEN_TASK_MOST = 260;  // characters of a task said aloud when it is handed over

  const t = (key, params) => (window.i18n ? window.i18n.t(key, params || {}) : key);
  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }

  /* ------------------------------------------------------------------ */
  /* Audio: the microphone, with voice detection                         */
  /* ------------------------------------------------------------------ */

  class Microphone {
    constructor({ onLevel, onSpeechStart, onSpeech, onSpeechEnd }) {
      this.onLevel = onLevel;
      this.onSpeechStart = onSpeechStart;
      this.onSpeech = onSpeech;
      this.onSpeechEnd = onSpeechEnd;
      this.paused = false;
      this.noise = 0.01;
    }

    async open() {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      });
      this.ctx = new AudioContext();
      this.rate = this.ctx.sampleRate;
      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.node = this.ctx.createScriptProcessor(2048, 1, 1);
      this.reset();
      this.node.onaudioprocess = (e) => this.frame(e.inputBuffer.getChannelData(0));
      this.source.connect(this.node);
      // A processor only runs when connected onward; the gain keeps it silent.
      this.mute = this.ctx.createGain();
      this.mute.gain.value = 0;
      this.node.connect(this.mute);
      this.mute.connect(this.ctx.destination);
    }

    reset() {
      this.chunks = [];
      this.preRoll = [];
      this.speaking = false;
      this.speechMs = 0;
      this.silenceMs = 0;
    }

    frame(input) {
      const data = new Float32Array(input);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      const ms = (data.length / this.rate) * 1000;
      this.onLevel?.(Math.min(1, rms * 12));
      if (this.paused) { this.reset(); return; }

      // The floor follows the room slowly, and only while nobody speaks.
      if (!this.speaking) this.noise = this.noise * 0.95 + rms * 0.05;
      const loud = rms > Math.max(0.018, this.noise * 3.2);

      if (!this.speaking) {
        this.preRoll.push(data);
        let kept = this.preRoll.reduce((n, c) => n + c.length, 0);
        while (kept - this.preRoll[0].length > (PRE_ROLL_MS / 1000) * this.rate) kept -= this.preRoll.shift().length;
        if (loud) {
          this.speaking = true;
          this.chunks = [...this.preRoll];
          this.speechMs = 0;
          this.silenceMs = 0;
          this.onSpeechStart?.();
        }
        return;
      }
      this.chunks.push(data);
      this.speechMs += ms;
      this.silenceMs = loud ? 0 : this.silenceMs + ms;
      if (this.silenceMs >= SILENCE_END_MS || this.speechMs >= MAX_SPEECH_MS) {
        const chunks = this.chunks;
        const long = this.speechMs - this.silenceMs >= MIN_SPEECH_MS;
        this.reset();
        // Too short to be words (a cough, a bump): dropped, and the listening goes on.
        if (long) this.onSpeech?.(toWav(chunks, this.rate));
        else this.onSpeechEnd?.();
      }
    }

    close() {
      try { this.node?.disconnect(); this.source?.disconnect(); this.mute?.disconnect(); } catch {}
      this.stream?.getTracks().forEach(track => track.stop());
      this.ctx?.close().catch(() => {});
      this.ctx = null;
    }
  }

  // Mono 16-bit wav at 16 kHz, base64: small enough and accepted everywhere.
  function toWav(chunks, rate) {
    const length = chunks.reduce((n, c) => n + c.length, 0);
    const joined = new Float32Array(length);
    let at = 0;
    chunks.forEach(c => { joined.set(c, at); at += c.length; });
    const ratio = rate / INPUT_RATE;
    const out = new Int16Array(Math.floor(length / ratio));
    for (let i = 0; i < out.length; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, length - 1);
      const v = joined[i0] + (joined[i1] - joined[i0]) * (pos - i0);
      out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
    }
    const buffer = new ArrayBuffer(44 + out.length * 2);
    const view = new DataView(buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, 36 + out.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, INPUT_RATE, true); view.setUint32(28, INPUT_RATE * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, out.length * 2, true);
    new Int16Array(buffer, 44).set(out);
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /* ------------------------------------------------------------------ */
  /* Audio: the voice, played as it arrives                              */
  /* ------------------------------------------------------------------ */

  class Player {
    constructor() {
      this.ctx = new AudioContext({ sampleRate: OUTPUT_RATE });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.35;
      this.analyser.connect(this.ctx.destination);
      this.samples = new Float32Array(this.analyser.fftSize);
      this.spectrum = new Float32Array(this.analyser.frequencyBinCount);
      this.envelope = 0;   // loudness, followed with a quick attack and a slower release
      this.floor = 0;      // a slow average of it, to tell a syllable's start
      this.sources = new Set();
      this.nextTime = 0;
      this.carry = null;
    }

    push(base64) {
      this.pushBytes(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
    }

    /** Raw 16-bit mono pcm at 24 kHz, in any cut: queued right after what is already playing. */
    pushBytes(chunk, rate = OUTPUT_RATE) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      let bytes = chunk;
      // A chunk may end halfway through a sample: the odd byte waits for the next.
      if (this.carry) { const b = new Uint8Array(bytes.length + 1); b[0] = this.carry[0]; b.set(bytes, 1); bytes = b; this.carry = null; }
      if (bytes.length % 2) { this.carry = bytes.slice(-1); bytes = bytes.slice(0, -1); }
      if (!bytes.length) return;
      // A copy of its own: a network chunk may start at an odd offset in its buffer.
      const pcm = new Int16Array(new Uint8Array(bytes).buffer);
      const buffer = this.ctx.createBuffer(1, pcm.length, rate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.analyser);
      const start = Math.max(this.ctx.currentTime + 0.06, this.nextTime);
      src.start(start);
      this.nextTime = start + buffer.duration;
      this.sources.add(src);
      src.onended = () => { this.sources.delete(src); if (!this.sources.size) this.onIdle?.(); };
    }

    /** How loud it is right now, 0..1. */
    level() {
      this.analyser.getFloatTimeDomainData(this.samples);
      let sum = 0;
      for (let i = 0; i < this.samples.length; i++) sum += this.samples[i] * this.samples[i];
      return Math.min(1, Math.sqrt(sum / this.samples.length) * 5);
    }

    /**
     * The mouth for what is being heard now, from the sound itself. The
     * analyser taps the audio that is playing, so the mouth moves with what
     * is heard, not with what has arrived.
     *   open:   the loudness envelope (quick attack, slower release) against
     *           a slowly decaying recent peak, so syllables keep their shape
     *           whatever the voice's volume;
     *   round / spread: where the second formant sits — low (500–1100 Hz)
     *           for "o", "u", high (1700–3200 Hz) for "i", "e" — plus the
     *           hiss of "s", "z" above 3.5 kHz, which spreads the lips too;
     *   onset:  a rise over the recent average, the start of a syllable.
     */
    shape() {
      const loud = this.level();
      this.envelope += (loud - this.envelope) * (loud > this.envelope ? 0.6 : 0.38);
      this.peak = Math.max(this.envelope, (this.peak || 0.3) * 0.996, 0.12);
      const onset = Math.max(0, this.envelope - this.floor - 0.06 * this.peak) / this.peak * 2;
      this.floor += (this.envelope - this.floor) * 0.05;
      if (this.envelope < 0.03) return { open: 0, round: 0, spread: 0, onset: 0 };
      this.analyser.getFloatFrequencyData(this.spectrum);
      const hz = this.ctx.sampleRate / this.analyser.fftSize;
      const band = (from, to) => {
        let sum = 0;
        for (let i = Math.floor(from / hz); i <= Math.min(this.spectrum.length - 1, Math.ceil(to / hz)); i++) sum += Math.pow(10, this.spectrum[i] / 10);
        return sum;
      };
      const back = band(500, 1100);
      const front = band(1700, 3200);
      const hiss = band(3500, 8000);
      const all = band(150, 8000) || 1;
      const clamp01 = (v) => Math.max(0, Math.min(1, v));
      const f2 = front / (front + back || 1);
      const hissy = hiss / all;
      return {
        // Above a third of the recent peak the mouth opens: it closes between syllables.
        open: clamp01((this.envelope / this.peak - 0.3) / 0.7),
        round: clamp01((ROUND_BELOW - f2) / ROUND_BELOW * 1.6),
        spread: clamp01(Math.max((f2 - SPREAD_ABOVE) / (1 - SPREAD_ABOVE) * 1.6, (hissy - 0.08) * 4)),
        onset: clamp01(onset),
        f2, hissy
      };
    }

    get playing() { return this.sources.size > 0; }

    stop() {
      this.sources.forEach(src => { try { src.stop(); } catch {} });
      this.sources.clear();
      this.nextTime = 0;
      this.carry = null;
    }
  }

  /**
   * The voice of the lines that are said again and again — the steps of the
   * diary session, its questions — kept on this computer once made: said
   * again, a line costs nothing and starts at once. Two stores: the sound,
   * and when each was last used, so that the least used can go without
   * reading the sound of all.
   */
  const keptLines = {
    opening: null,
    open() {
      if (!this.opening) {
        this.opening = new Promise(resolve => {
          try {
            const request = indexedDB.open('synthorg-realtime-voice', 1);
            request.onupgradeneeded = () => { request.result.createObjectStore('sound'); request.result.createObjectStore('used'); };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
            request.onblocked = () => resolve(null);
          } catch { resolve(null); }
        });
      }
      return this.opening;
    },
    done(request) {
      return new Promise(resolve => { request.onsuccess = () => resolve(request.result); request.onerror = () => resolve(null); });
    },
    async get(key) {
      const db = await this.open();
      if (!db) return null;
      try {
        const tx = db.transaction(['sound', 'used'], 'readwrite');
        const sound = await this.done(tx.objectStore('sound').get(key));
        if (sound) tx.objectStore('used').put(Date.now(), key);
        return sound || null;
      } catch { return null; }
    },
    async put(key, sound) {
      const db = await this.open();
      if (!db) return;
      try {
        const tx = db.transaction(['sound', 'used'], 'readwrite');
        tx.objectStore('sound').put(sound, key);
        tx.objectStore('used').put(Date.now(), key);
        const used = tx.objectStore('used');
        const [keys, times] = await Promise.all([this.done(used.getAllKeys()), this.done(used.getAll())]);
        if (!keys || keys.length <= KEPT_LINES) return;
        keys.map((k, i) => [k, times[i]]).sort((a, b) => a[1] - b[1]).slice(0, keys.length - KEPT_LINES)
          .forEach(([k]) => { tx.objectStore('sound').delete(k); used.delete(k); });
      } catch {}
    }
  };

  /* ------------------------------------------------------------------ */
  /* The character's tools                                               */
  /* ------------------------------------------------------------------ */

  // The model answers through a function every time: one of the tools, or
  // `say` for its own words. Made to choose, it does what is asked instead
  // of saying it will, and the instructions can be short.
  const SAY = {
    type: 'function',
    function: {
      name: 'say',
      description: 'Your own words to the user, when nothing else is asked for: talking, answering from what you know, asking what is missing.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    }
  };

  /** The words of a `say` call as far as its arguments have come: JSON that may still be half written. */
  /**
   * The outcome of a task as it stays in the character's conversation: its title, not the work. What the Master
   * wrote is in the chat of the tasks and in the files it made; here it would be read again at every exchange,
   * as if the character had done and said all of it.
   */
  function headOf(text) {
    const value = String(text ?? '');
    const head = /^\[(?:Hai finito il compito|Esito del compito affidato al Master): «[\s\S]*?»\]/.exec(value) || /^\[Il compito non è riuscito: [\s\S]*?\]/.exec(value);
    return head ? head[0] : value;
  }

  /**
   * Where a text starts only to repeat itself, or -1: a run of signs with no word in it (emoji after emoji), or
   * the same few characters said five times in a row. What comes before, and the first of the run, is kept.
   */
  function repeatsAt(text) {
    const signs = /[^\p{L}\p{N}]{24,}$/u.exec(text);
    if (signs) {
      const first = /^\s*(?:\p{Extended_Pictographic}\uFE0F?|\S)/u.exec(signs[0]);
      return signs.index + (first ? first[0].length : 0);
    }
    const same = /(.{2,40}?)\1{4,}$/su.exec(text);
    return same ? same.index + same[1].length : -1;
  }

  function wordsSoFar(args) {
    const found = /"text"\s*:\s*"((?:\\.|[^"\\])*)/.exec(String(args || ''));
    if (!found) return '';
    let raw = found[1];
    // An escape cut half way (\u00e) is left for when the rest of it has come.
    for (let i = 0; i < 7; i++) {
      try { return JSON.parse(`"${raw}"`); } catch { raw = raw.slice(0, -1); }
    }
    return '';
  }

  // Each tool: its function spec for the model and what it does. The model
  // only recognises what is asked and takes the data out of it; what follows
  // is done here. A tool that reads gives back a text, and the model goes on
  // from it. A tool that does something gives back { say, kept }: `say` is
  // said by the app in fixed words (parts, as say() takes them), `kept` is
  // only written in the conversation, and the exchange ends there, without
  // another request to the model. New abilities (mail read-only…) are added
  // here.
  const REALTIME_TOOLS = [
    {
      name: 'work',
      description: 'Call it whenever what is asked takes tools or real work: searching the web, making images, audio, video or documents, running code, calculations, anything long or precise. It is work you do at your computer. Give the whole task, with all it takes to do it: the work starts from the task alone.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          chat: { type: 'string', description: 'Only when the work is about one of the user\'s chats or projects (reading it through, an analysis, a report on it): its name, as the user said it. What that chat holds is given to the work.' }
        },
        required: ['task']
      },
      async run(args, rt) {
        const task = String(args.task || '').trim();
        if (!task) return 'ERRORE: compito vuoto.';
        // The chat the work is about is found here, by its name (realtime-liaison.js): the model only names it.
        const named = String(args.chat || '').trim() && rt.chatNamed ? await rt.chatNamed(String(args.chat)) : null;
        if (named?.text) return named.text;
        // Told to the user in fixed words when the exchange is over, and started then or when it is confirmed.
        rt.askTask(named?.chat ? { task, chat: named.chat } : task);
        return {};
      }
    },
    {
      name: 'notes_search',
      description: 'Call it when the user speaks of something about themselves that your notes do not say: looks for a word or a name among your older notes.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      available: (rt) => Boolean(rt.archived?.length),
      async run(args, rt) {
        const query = String(args.query || '').trim().slice(0, 100);
        if (!query) return 'ERRORE: parola vuota.';
        const found = (await window.chatStorage.memories(rt.conversationId, query, 'conversation')).filter(m => m.section === 'about_user').slice(0, 12);
        return found.length ? found.map(m => `- ${m.content}`).join('\n') : 'Niente nelle note.';
      }
    },
    {
      name: 'memory_open',
      description: 'Call it when an exact detail of a past conversation is needed: opens an entry of the memory, by its code in square brackets.',
      parameters: { type: 'object', properties: { node: { type: 'string' } }, required: ['node'] },
      available: (rt) => Boolean(rt.context?.memoryView?.active),
      async run(args, rt) {
        const nodeId = String(args.node || '').replace(/[^0-9a-f]/gi, '');
        const opened = await window.chatStorage.memoryOpen(rt.conversationId, nodeId);
        return opened.messages
          ? `${opened.node.label}:\n\n` + opened.messages.map(m => `[${m.role === 'user' ? 'Utente' : 'Tu'}] ${m.content}`).join('\n\n')
          : `${opened.node.label}:\n\n` + opened.children.map(c => `[${c.id}] ${c.label}\n${c.content}`).join('\n\n');
      }
    },
    {
      name: 'agenda_add',
      description: 'Call it when the user asks to note, plan or be reminded of something: adds to their agenda a reminder (a moment) or an activity (from a start to an end). Times are local, YYYY-MM-DDTHH:MM.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['reminder', 'activity'] },
          title: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          notes: { type: 'string' }
        },
        required: ['kind', 'title', 'start']
      },
      async run(args, rt) {
        const item = await window.chatStorage.saveAgenda({
          kind: args.kind === 'activity' ? 'activity' : 'reminder',
          title: String(args.title || ''),
          startAt: toStamp(args.start),
          endAt: args.kind === 'activity' && args.end ? toStamp(args.end, '23:59') : null,
          notes: String(args.notes || ''),
          source: 'realtime'
        });
        await rt.loadAgenda();
        return { say: fixedLine(item.kind === 'reminder' ? 'realtime.saidReminder' : 'realtime.saidActivity', item.title, spokenSpan(item)) };
      }
    },
    {
      name: 'agenda_update',
      description: 'Call it when the user moves or changes something of the agenda, or has done it: changes the item, by its id: title, times, notes, or done.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, notes: { type: 'string' }, done: { type: 'boolean' } },
        required: ['id']
      },
      async run(args, rt) {
        const data = {};
        if (args.title !== undefined) data.title = String(args.title);
        if (args.start !== undefined) data.startAt = toStamp(args.start);
        if (args.end !== undefined) data.endAt = args.end ? toStamp(args.end, '23:59') : null;
        if (args.notes !== undefined) data.notes = String(args.notes);
        if (args.done !== undefined) data.done = Boolean(args.done);
        const item = await window.chatStorage.saveAgenda(data, String(args.id || ''));
        await rt.loadAgenda();
        return { say: args.done === true ? fixedLine('realtime.saidAgendaDone', item.title) : fixedLine('realtime.saidAgendaChanged', item.title, spokenSpan(item)) };
      }
    },
    {
      name: 'agenda_delete',
      description: 'Call it when the user asks to take something out of the agenda: deletes the item, by its id.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run(args, rt) {
        const item = (rt.agenda || []).find(known => String(known.id) === String(args.id || ''));
        await window.chatStorage.deleteAgenda(String(args.id || ''));
        await rt.loadAgenda();
        return { say: fixedLine('realtime.saidAgendaDeleted', item?.title) };
      }
    },
    {
      name: 'goal_add',
      description: 'Call it when the user says what they want to get done: adds the goal, with the day it is due (YYYY-MM-DD) and its steps, when they name any.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          due: { type: 'string' },
          notes: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } }
        },
        required: ['name']
      },
      async run(args, rt) {
        const goal = await window.chatStorage.saveGoal({
          name: String(args.name || ''),
          dueDay: LOCAL_DAY.test(String(args.due || '')) ? String(args.due) : null,
          notes: String(args.notes || ''),
          steps: (Array.isArray(args.steps) ? args.steps : []).map(x => String(x).trim()).filter(Boolean),
          source: 'realtime'
        });
        await rt.loadGoals();
        rt.loadCalendar();
        return { say: fixedLine('realtime.saidGoal', goal.name, goal.due_day ? t('realtime.saidDue', { day: rt.dayLabel(goal.due_day) }) : '') };
      }
    },
    {
      name: 'goal_step',
      description: 'Call it for a step of a goal, by the goal\'s id: "add" a new one, "done" when the user says it is done, "reopen" when it is not. title: the step\'s title; due: YYYY-MM-DD.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string' },
          action: { type: 'string', enum: ['add', 'done', 'reopen'] },
          title: { type: 'string' },
          due: { type: 'string' }
        },
        required: ['goal', 'action', 'title']
      },
      async run(args, rt) {
        await rt.loadGoals();
        const goal = rt.goals.find(g => g.id === String(args.goal || ''));
        if (!goal) return 'ERRORE: obiettivo non trovato.';
        let title = String(args.title || '').trim();
        if (args.action === 'add') {
          await window.chatStorage.saveGoalStep(goal.id, { title, dueDay: LOCAL_DAY.test(String(args.due || '')) ? String(args.due) : null });
        } else {
          const step = goal.steps.find(x => plainWords(x.title) === plainWords(title)) || goal.steps.find(x => plainWords(x.title).includes(plainWords(title)) || plainWords(title).includes(plainWords(x.title)));
          if (!step) return `ERRORE: tappa non trovata. Le tappe di «${goal.name}»: ${goal.steps.map(x => x.title).join('; ') || 'nessuna'}.`;
          await window.chatStorage.saveGoalStep(goal.id, { done: args.action === 'done' }, step.id);
          title = step.title;
        }
        await rt.loadGoals();
        rt.loadCalendar();
        return { say: fixedLine(args.action === 'add' ? 'realtime.saidStepAdded' : args.action === 'done' ? 'realtime.saidStepDone' : 'realtime.saidStepReopened', title) };
      }
    },
    {
      name: 'goals_read',
      description: 'Call it before saying how a goal or a project is going: where the goals stand and the work recorded in the app between two days (YYYY-MM-DD).',
      parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
      async run(args, rt) {
        const from = LOCAL_DAY.test(String(args.from || '')) ? String(args.from) : W.shift(dayStamp(new Date()), -29);
        const to = LOCAL_DAY.test(String(args.to || '')) ? String(args.to) : dayStamp(new Date());
        return rt.goalsText(from, to);
      }
    },
    {
      name: 'diary_start',
      description: 'Call it when the user wants to tell about their day or write the diary: starts the diary session. day: YYYY-MM-DD, today when left out.',
      parameters: { type: 'object', properties: { day: { type: 'string' } }, required: [] },
      async run(args, rt) {
        const today = dayStamp(new Date());
        const day = LOCAL_DAY.test(String(args.day || '')) && String(args.day) <= today ? String(args.day) : today;
        // The session starts when the exchange is over, and opens with its own words.
        rt.diaryAsked = { day };
        return { kept: t(day === today ? 'realtime.diarySayOpening' : 'realtime.diarySayOpeningDay', { day: rt.dayLabel(day) }) };
      }
    },
    {
      name: 'diary_read',
      description: 'Call it when the user asks about past days: their diary between two days (YYYY-MM-DD), the page of each day and the day\'s data.',
      parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
      async run(args) {
        const entries = await window.chatStorage.diary(String(args.from || ''), String(args.to || ''), 60);
        if (!entries.length) return 'Nessuna pagina di diario in questi giorni.';
        return entries.map(e => `${e.day}: ${diarySummary(dayData(e))}\n${(e.page_text || e.raw_text).slice(0, 3000)}`).join('\n\n');
      }
    },
    {
      name: 'wellbeing_read',
      description: 'Call it before saying how the user has been or how a habit goes: mood, energy, stress, sleep and habits between two days (YYYY-MM-DD), in numbers, from the days they told. No diagnosis and no medical advice.',
      parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
      async run(args, rt) {
        const from = LOCAL_DAY.test(String(args.from || '')) ? String(args.from) : W.shift(dayStamp(new Date()), -29);
        const to = LOCAL_DAY.test(String(args.to || '')) ? String(args.to) : dayStamp(new Date());
        return rt.wellbeingText(await rt.wellbeingOf(from, to));
      }
    }
  ];

  /* ------------------------------------------------------------------ */
  /* The diary session and the memories: texts and formats               */
  /* ------------------------------------------------------------------ */

  // What the user can change in the section's settings, as it starts out.
  // The questions are asked in this order, all of them, after the account.
  const DEFAULTS = {
    it: {
      questions: [
        'Come ti sei sentito, e perché?',
        'Quanta energia avevi, da uno a cinque?',
        'Quante ore avevi dormito?',
        'Con chi hai passato del tempo?',
        'Qual è stata la cosa migliore della giornata, e quale la più difficile?',
        'Cosa vuoi fare nei prossimi giorni?'
      ],
      pagePrompt: 'Scrivi la pagina di diario di questa giornata a partire da quello che l\'utente ha raccontato a voce e dalle sue risposte alle domande. Scrivi in prima persona, come se la scrivesse lui, in prosa ordinata e scorrevole: metti i fatti in ordine di tempo, unisci le ripetizioni, togli esitazioni e giri di parole del parlato, integra le risposte nel racconto senza riportare le domande. Usa solo quello che ha detto: nessun fatto, giudizio o consiglio aggiunto. La lunghezza segue il racconto: un racconto breve dà una pagina breve.',
      memoryPrompt: 'Tieni le note che un assistente personale ha sul suo utente. Da quello che l\'utente ha detto ricava i fatti duraturi che vale la pena ricordare per mesi: nome, lavoro, progetti, gusti, persone della sua vita, abitudini, obiettivi. Lascia fuori i fatti di un solo giorno, gli umori passeggeri, quello che le note dicono già e quello che riguarda l\'assistente. Ogni nota è una frase breve, nella lingua dell\'utente. Quando un fatto nuovo cambia una nota, riscrivi quella nota; quando due note dicono la stessa cosa, riscrivine una e togli l\'altra.',
      reviewPrompt: 'Scrivi il riepilogo della settimana dell\'utente a partire dai dati dei giorni raccontati, dalle abitudini che segue, dai suoi obiettivi e dal lavoro registrato nell\'app. Parla a lui, dandogli del tu, in modo semplice e diretto, come a voce: niente elenchi, titoli o markdown. Di\' come è andata la settimana (umore, energia, stress, sonno) e cosa è cambiato rispetto alla settimana prima, poi le abitudini: quelle positive fatte e quelle negative evitate, e quelle andate peggio. Poi gli obiettivi: le tappe chiuse nella settimana, quelli in ritardo sulla scadenza, e quanto lavoro è stato registrato. Usa solo i numeri che ricevi e di\' su quanti giorni si basano; i giorni non raccontati non si contano. Il lavoro registrato dice quanto è stato fatto nell\'app, non quanto vale. Nessuna diagnosi e nessun consiglio medico. Al massimo dieci frasi.'
    },
    en: {
      questions: [
        'How did you feel, and why?',
        'How much energy did you have, from one to five?',
        'How many hours had you slept?',
        'Who did you spend time with?',
        'What was the best thing of the day, and what was the hardest?',
        'What do you want to do in the next days?'
      ],
      pagePrompt: 'Write the diary page of this day from what the user told aloud and from their answers to the questions. Write in the first person, as if they wrote it, in tidy flowing prose: put the facts in order of time, join the repetitions, drop the hesitations and detours of speech, work the answers into the account without repeating the questions. Use only what they said: no added facts, judgements or advice. The length follows the account: a short account gives a short page.',
      memoryPrompt: 'You keep the notes a personal assistant has about its user. From what the user said, work out the lasting facts worth remembering for months: name, work, projects, tastes, people in their life, habits, goals. Leave out the facts of a single day, passing moods, what the notes already say and anything about the assistant. Each note is one short sentence, in the user\'s language. When a new fact changes a note, rewrite that note; when two notes say the same thing, rewrite one and remove the other.',
      reviewPrompt: 'Write the review of the user\'s week from the data of the days they told, the habits they follow, their goals and the work recorded in the app. Speak to them, simply and directly, as if aloud: no lists, titles or markdown. Say how the week went (mood, energy, stress, sleep) and what changed from the week before, then the habits: the positive ones done and the negative ones avoided, and the ones that went worse. Then the goals: the steps closed in the week, the ones late on their due day, and how much work was recorded. Use only the numbers you are given and say how many days they rest on; days not told are not counted. The work recorded says how much was done in the app, not what it is worth. No diagnosis and no medical advice. Ten sentences at most.'
    }
  };
  const defaults = () => DEFAULTS[window.i18n?.getLocale?.() === 'en' ? 'en' : 'it'];
  // Where the user's own version of each is kept; none kept: the default, in the app's language.
  const CUSTOM_KEYS = { questions: 'realtime_diary_questions', pagePrompt: 'realtime_diary_prompt', memoryPrompt: 'realtime_memory_prompt', reviewPrompt: 'realtime_review_prompt' };
  // The numbers of the wellbeing page (realtime-wellbeing.js).
  const W = window.RealtimeWellbeing;
  const PERIODS = [7, 30, 90];

  const CATEGORIES = ['work', 'hobby', 'health', 'sport', 'social', 'learning', 'chores', 'rest', 'other'];
  const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/;

  /** The words said, compared without case, accents' variants or punctuation. */
  function plainWords(text) {
    return String(text || '').toLowerCase().replace(/[’`]/g, '\'').replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  }
  const phrases = (key) => t(key).split('|').map(plainWords).filter(Boolean);

  /**
   * An account's piece, and whether it closes the account: the whole piece is
   * one of the closing phrases, or it ends with one after a full stop ("… e
   * poi a letto. Ho finito."). The closing words are not part of the account.
   */
  function splitClosing(said) {
    const text = String(said || '').trim();
    const closing = phrases('realtime.diaryClosingWords');
    if (closing.includes(plainWords(text))) return { text: '', done: true };
    const last = /^([\s\S]*[.!?…])\s*([^.!?…]+)[.!?…]*$/.exec(text);
    if (last && closing.includes(plainWords(last[2]))) return { text: last[1].trim(), done: true };
    return { text, done: false };
  }

  /**
   * What was answered to a question asked in fixed words: 'yes', 'no', or
   * null when it is neither, or both. The words that count are whole words
   * of what was said, wherever they are in it.
   */
  function yesOrNo(said) {
    const heard = ` ${plainWords(said)} `;
    const has = (key) => phrases(key).some(phrase => heard.includes(` ${phrase} `));
    const yes = has('realtime.confirmYesWords');
    const no = has('realtime.confirmNoWords');
    return yes === no ? null : yes ? 'yes' : 'no';
  }

  /** A task as it is said aloud: a sentence, cut where it gets long. What is shown is all of it. */
  function spokenTask(task) {
    const text = String(task || '').replace(/\s+/g, ' ').trim();
    const cut = text.length > SPOKEN_TASK_MOST ? text.slice(0, text.lastIndexOf(' ', SPOKEN_TASK_MOST)) + '…' : text;
    return /[.!?…]$/.test(cut) ? cut : cut + '.';
  }

  function dayData(entry) {
    try { return entry?.extracted_json ? JSON.parse(entry.extracted_json) : null; } catch { return null; }
  }

  /** What the voice reads: no markdown, no code, no emoji (they are faces, not words). */
  /**
   * The language the voice speaks, and its accent. The speech endpoint has
   * no language field: the way OpenRouter offers is its passthrough
   * (provider.options), where each provider reads its own style field and
   * ignores the others' — Google's speech_metadata.style, OpenAI's
   * instructions. Voices without one (Fish, Deepgram…) take the language
   * from the text. The language is the app's.
   */
  const SPEECH_STYLE = {
    it: 'Parla in italiano, con la pronuncia e l\'accento naturali di una persona italiana.',
    en: 'Speak English, with the natural pronunciation and accent of a native English speaker.'
  };
  function speechLocale() {
    return window.i18n?.getLocale?.() === 'en' ? 'en' : 'it';
  }
  function speechProvider() {
    const style = SPEECH_STYLE[speechLocale()];
    return {
      options: {
        'google-vertex': { speech_metadata: { style } },
        'google-ai-studio': { speech_metadata: { style } },
        openai: { instructions: style }
      }
    };
  }

  /** The sample rate a voice's pcm comes at, from its content type ("audio/pcm;rate=44100"). */
  function pcmRate(response) {
    const m = /rate=(\d+)/.exec(response.headers.get('content-type') || '');
    return m ? Number(m[1]) : OUTPUT_RATE;
  }

  function speechText(text) {
    const clean = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`#>|]/g, '')
      .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    return clean && /[\p{L}\p{N}]/u.test(clean) ? clean : '';
  }

  /**
   * A text in pieces for the voice: sentence by sentence, the first one cut
   * at a comma (or after a few words) when long, so the first sound comes
   * soon; very short sentences ride with the next.
   */
  function speechPieces(text) {
    const clean = speechText(text);
    if (!clean) return [];
    const sentences = clean.split(/(?<=[.!?…])\s+/).filter(Boolean);
    const pieces = [];
    sentences.forEach(sentence => {
      const last = pieces[pieces.length - 1];
      if (last && last.length < 25 && pieces.length > 1) pieces[pieces.length - 1] = `${last} ${sentence}`;
      else pieces.push(sentence);
    });
    // A piece ends where a sentence ends, never inside one: each piece is made by the voice
    // on its own, and a cut after a comma or a count of letters is heard as a pause out of place.
    return pieces;
  }

  /** A moment as it is said: the day by its name, then the hour. */
  function spokenWhen(stamp) {
    const date = parseStamp(String(stamp || '').slice(0, 16));
    if (!date) return '';
    const day = date.toLocaleDateString(window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    return `${day}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /** When an agenda item is, as it is said: its moment, and its end when it has one. */
  function spokenSpan(item) {
    const from = spokenWhen(item.start_at);
    if (!item.end_at || !from) return from;
    const sameDay = String(item.end_at).slice(0, 10) === String(item.start_at).slice(0, 10);
    return `${from}, ${sameDay ? t('realtime.saidUntilTime', { time: String(item.end_at).slice(11, 16) }) : t('realtime.saidUntilDay', { day: spokenWhen(item.end_at) })}`;
  }

  /**
   * What the app says when a tool has done something, as say() takes it:
   * the fixed words, whose sound is kept, then what it was done to.
   */
  function fixedLine(key, title = '', more = '') {
    const parts = [{ text: t(key), fixed: true }];
    const name = String(title || '').replace(/\s+/g, ' ').trim().replace(/[.!?…]+$/, '').slice(0, 160);
    if (name || more) parts.push({ text: `${[name, more].filter(Boolean).join(', ')}.`, shown: `${[name && `«${name}»`, more].filter(Boolean).join(', ')}.` });
    return parts;
  }

  /** A line in parts as it is written. */
  const writtenLine = (parts) => (parts || []).map(part => part.shown || part.text).join(' ');

  function agendaLine(item) {
    const kind = item.kind === 'reminder' ? 'promemoria' : 'attività';
    const when = item.end_at ? `${item.start_at} → ${item.end_at}` : item.start_at;
    return `[${item.id}] ${kind}${item.done ? ' (fatto)' : ''}: ${item.title} — ${when}${item.notes ? ` (${item.notes})` : ''}`;
  }

  function diarySummary(x) {
    if (!x) return '';
    const parts = [];
    if (x.summary) parts.push(x.summary);
    if (x.mood?.label || x.mood?.score) parts.push(`umore ${x.mood.label || ''}${x.mood.score ? ` (${x.mood.score}/5)` : ''}`);
    if (x.energy) parts.push(`energia ${x.energy}/5`);
    if (Array.isArray(x.activities) && x.activities.length) parts.push('attività: ' + x.activities.map(a => `${a.name}${a.category ? ` [${a.category}]` : ''}`).join(', '));
    return parts.join('; ');
  }

  // Local wall-clock stamps, the way the agenda keeps them.
  const pad = (n) => String(n).padStart(2, '0');
  function dayStamp(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function localStamp(d) { return `${dayStamp(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  // What a model writes for a time — with seconds, a space, or a bare day — as the agenda keeps it.
  function toStamp(value, dayTime = '09:00') {
    const v = String(value || '').trim().replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v.slice(0, 16);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T${dayTime}`;
    return v;
  }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function parseStamp(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
  }

  /* ------------------------------------------------------------------ */
  /* The section                                                         */
  /* ------------------------------------------------------------------ */

  const rt = {
    view: null,
    ui: null,
    puppet: null,
    mic: null,
    player: null,
    active: false,          // the tab is on screen
    session: false,         // the microphone is on
    phase: 'idle',          // idle | listening | hearing | thinking | speaking
    busy: false,
    conversationId: null,
    tasksConversationId: null,
    context: null,
    notes: [],
    tasks: [],
    proposals: [],
    reports: [],            // outcomes of tasks, waiting to be told
    name: '',
    voice: '',              // empty: the first voice of the Speech synthesis model
    abort: null,
    loaded: false,
    agenda: [],             // the next two weeks, and reminders still open
    diary: [],
    diarySession: null,     // the diary session under way: { day, step, questions, index, … }
    diaryAsked: null,       // the character was asked for a session: it starts when it stops talking
    diaryDay: '',           // the day picked on the diary page; empty: today
    writing: new Set(),     // days whose page the Master is writing
    pageErrors: new Map(),  // day -> why its page was not written
    editingPage: null,      // the day whose page is being changed by hand
    hearing: new Set(),     // words being written down: the analysis waits for them
    analyzing: false,
    habits: [],             // followed, proposed and turned down
    period: 30,             // days shown on the wellbeing page
    wellbeing: null,        // the numbers of that period (wellbeingOf)
    reviews: [],            // the weekly reviews, the latest first
    reviewing: false,
    settingsTab: 'character',
    sideTab: null,          // null: the cards; otherwise the page open
    reminderTimer: null,
    // What the character may do by itself and how it is answered: chosen in the settings (realtime-features.js).
    features: { delegate: false, relay: false, voiceYes: true, askOutcome: true },
    // What waits to be told to the user before it is done: a task (its words, or { task, chat } when it is about a chat),
    // or a message to write in a chat ({ send: { id, title, text } }).
    toConfirm: [],
    // What the user is asked: to confirm a task { task, chat? }, or a message to write in a chat { task, send },
    // or whether to hear an outcome { task, outcome }.
    confirming: null,
    saidBefore: '',         // what the model said before handing a task: kept with the fixed words that follow
    calledBefore: null,     // and the tools it called then
    from: 'desk',           // where what was last said to the character came from: 'desk' or 'phone'
    phone: null,            // the phone bridge, when the page has one (bridge.js): { there(), hidden(), state(), tell() }

    async ensure() {
      if (this.loaded) return;
      const got = await window.chatStorage.realtime();
      this.conversationId = got.conversation.id;
      this.tasksConversationId = got.tasksConversationId;
      try { this.name = (await window.chatStorage.getSetting('realtime_name'))?.value || ''; } catch {}
      try { this.voice = (await window.chatStorage.getSetting('realtime_voice'))?.value || ''; } catch {}
      await this.loadNotes();
      try {
        const period = Number((await window.chatStorage.getSetting('realtime_wellbeing_period'))?.value);
        this.period = PERIODS.includes(period) ? period : 30;
      } catch {}
      try { this.calendarView = (await window.chatStorage.getSetting('realtime_calendar_view'))?.value === 'week' ? 'week' : 'month'; } catch {}
      await Promise.all([this.loadAgenda(), this.loadDiary(), this.loadWellbeing(), this.loadGoals(), this.loadFiles(), this.loadFeatures?.(), this.loadWatch?.()]);
      this.loaded = true;
      // What was said before the app was closed and not read yet, and the
      // review of the week that has ended.
      this.analyze();
      this.weeklyReview();
    },

    /** A text of the section the user can change: theirs, or the one it starts out with. */
    async custom(key) {
      let saved = '';
      try { saved = (await window.chatStorage.getSetting(CUSTOM_KEYS[key]))?.value || ''; } catch {}
      if (key === 'questions') {
        // A list, which may be empty: then the account alone makes the page.
        try {
          const own = JSON.parse(saved);
          if (Array.isArray(own)) return own.map(q => String(q).trim()).filter(Boolean);
        } catch {}
        return defaults().questions;
      }
      return saved.trim() || defaults()[key];
    },

    async loadNotes() {
      if (!this.conversationId) return;
      const all = ((await window.chatStorage.memories(this.conversationId, '', 'conversation')) || []).filter(m => m.section === 'about_user');
      // The ones in use go to the character at every exchange; the ones put away when the notes were tidied up do not.
      this.notes = all.filter(m => m.enabled !== 0);
      this.archived = all.filter(m => m.enabled === 0);
      this.renderSettings();
      this.tidy();
    },

    displayName() { return this.name || t('realtime.defaultName'); },

    build() {
      this.view = document.getElementById('view-realtime');
      if (!this.view || this.ui) return;
      this.view.innerHTML = `
        <div class="rt-layout">
          <div class="rt-stage">
            <div class="rt-room"></div>
            <button type="button" class="rt-settings-btn rt-room-gear"><i class="fa-solid fa-gear"></i></button>
            <div class="rt-calendar" hidden></div>
            <div class="rt-scene">
              <div class="rt-puppet" title=""></div>
              <div class="rt-desk"></div>
            </div>
            <p class="rt-status" role="status"></p>
            <div class="rt-captions">
              <p class="rt-caption rt-caption-user"></p>
              <p class="rt-caption rt-caption-bot"></p>
            </div>
            <div class="rt-controls">
              <button type="button" class="btn btn-primary rt-talk"></button>
              <button type="button" class="btn rt-interrupt" hidden></button>
              <button type="button" class="btn rt-stop-task" hidden></button>
              <button type="button" class="btn btn-primary rt-confirm-yes" hidden></button>
              <button type="button" class="btn rt-confirm-no" hidden></button>
            </div>
            <form class="rt-type">
              <input type="text" class="rt-type-input" maxlength="4000" spellcheck="false">
              <button type="submit" class="btn rt-type-send"><i class="fa-solid fa-paper-plane"></i></button>
            </form>
            <section class="rt-files" hidden></section>
          </div>
          <aside class="rt-side"></aside>
        </div>`;
      const q = (s) => this.view.querySelector(s);
      this.ui = {
        puppet: q('.rt-puppet'), status: q('.rt-status'),
        user: q('.rt-caption-user'), bot: q('.rt-caption-bot'),
        talk: q('.rt-talk'), interrupt: q('.rt-interrupt'), stopTask: q('.rt-stop-task'),
        confirmYes: q('.rt-confirm-yes'), confirmNo: q('.rt-confirm-no'),
        form: q('.rt-type'), input: q('.rt-type-input'), side: q('.rt-side'),
        stage: q('.rt-stage'), calendar: q('.rt-calendar'),
        // The room is the computer's: the phone keeps the cards in the side panel.
        layout: q('.rt-layout'), room: window.SYNTHORG_REMOTE ? null : q('.rt-room'), gear: q('.rt-room-gear')
      };
      this.ui.gear.title = t('realtime.settingsTitle');
      this.ui.gear.setAttribute('aria-label', t('realtime.settingsTitle'));
      this.ui.gear.addEventListener('click', () => this.openSettings());
      this.ui.room?.addEventListener('click', (e) => this.onSideClick(e));
      // Around an open page there is the room: a click there puts the page away.
      this.ui.layout.addEventListener('click', (e) => { if (this.ui.room && e.target === this.ui.layout && this.sideTab) { this.sideTab = null; this.renderSide(); } });
      this.ui.calendar.addEventListener('click', (e) => this.onCalendarClick(e));
      this.ui.calendar.addEventListener('keydown', (e) => this.onCalendarClick(e));
      this.puppet = new window.RealtimePuppet(this.ui.puppet);
      this.ui.talk.addEventListener('click', () => (this.session ? this.stopSession() : this.startSession()));
      this.ui.interrupt.addEventListener('click', () => this.interrupt());
      this.ui.stopTask.addEventListener('click', () => { this.from = 'desk'; this.stopTasks(); });
      this.ui.confirmYes.addEventListener('click', () => { this.from = 'desk'; this.confirmTask(true); });
      this.ui.confirmNo.addEventListener('click', () => { this.from = 'desk'; this.confirmTask(false); });
      this.ui.puppet.addEventListener('click', () => { if (this.phase === 'speaking') this.interrupt(); });
      this.ui.form.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = this.ui.input.value.trim();
        if (!text || this.busy || this.working()) return;
        this.ui.input.value = '';
        this.hear({ text });
      });
      this.ui.side.addEventListener('click', (e) => this.onSideClick(e));
      this.ui.side.addEventListener('change', (e) => this.onSideChange(e));
      this.ui.side.addEventListener('submit', (e) => this.onSideSubmit(e));
      this.ui.side.addEventListener('pointermove', (e) => this.onChartMove(e));
      this.ui.side.addEventListener('pointerleave', (e) => this.onChartMove(e));
      // The mouth follows the voice every frame, while the tab is shown.
      const tick = () => {
        if (!this.active) { this.levelFrame = null; return; }
        if (this.player?.playing) this.puppet.setMouthShape(this.player.shape());
        else this.puppet.setMouthShape({ open: 0 });
        this.levelFrame = requestAnimationFrame(tick);
      };
      this.startLevels = () => { if (!this.levelFrame) this.levelFrame = requestAnimationFrame(tick); };
      this.buildDesk();
      this.renderControls();
      this.renderSide();
    },

    async setActive(on) {
      if (on) {
        this.build();
        this.active = true;
        this.puppet?.start();
        this.desk?.start();
        this.startLevels?.();
        this.renderControls();
        try { await this.ensure(); } catch (err) { this.setStatus(err.message); }
        this.renderControls();
        this.renderSide();
        // What finished while the tab was closed is told now.
        this.tellNext();
        return;
      }
      if (!this.active) return;
      this.active = false;
      this.puppet?.stop();
      this.desk?.stop();
      // Leaving the tab closes the diary session with what was told, and
      // turns the microphone off; an answer under way finishes.
      if (this.diarySession) this.finishDiary(this.diarySession, { silent: true });
      // A task still to be confirmed is not handed: nobody is there to answer, unless a phone is talking to it.
      if (!this.phone?.talking?.()) {
        // An outcome asked about is asked about again when somebody is there.
        if (this.confirming?.outcome) this.reports.unshift(this.confirming.outcome);
        this.confirming = null;
        this.toConfirm = [];
      }
      if (this.session) this.stopSession();
      else this.analyze();
    },

    /**
     * The character uses a tool: it hops onto what the tool is about — the
     * card of its page, or the panel's heading when that page is open — and
     * back. The tool does not wait for it.
     */
    standOnWhatOpens(tool) {
      const side = this.ui?.side;
      if (!window.mascot?.ready || !this.active || !side) return;
      // The files are in the lower part of the stage, under it: it shows them from where it is.
      if (tool === 'files_show') return;
      const page = /^(agenda_|goal)/.test(tool) ? 'agenda' : /^diary_/.test(tool) ? 'diary' : tool === 'wellbeing_read' ? 'wellbeing'
        : tool === 'work' ? 'tasks' : tool === 'usage_read' ? 'usage' : 'settings';
      // In the room the thing of the page is on the stage; on the phone its card is in the panel.
      const el = page === 'settings' ? this.view.querySelector('.rt-settings-btn')
        : this.view.querySelector('.rt-home-' + page) || side.querySelector(this.sideTab === page ? '.rt-side-head h2' : '[data-side-home]');
      if (!el) return;
      window.mascot.stand(el).then(landed => {
        if (landed) setTimeout(() => { if (window.mascot.heading?.el === el) window.mascot.home(); }, 900);
      });
    },

    /** What comes in, voice or text: to the diary session when one is under way, otherwise to the character. */
    hear(input) {
      // While the Master works the character is at the computer: nothing more is asked of it until it is back.
      if (this.working()) return;
      this.from = input?.remote ? 'phone' : 'desk';
      if (this.confirming) { this.confirmHear(input); return; }
      if (this.diarySession) this.diaryHear(this.diarySession, input);
      else this.respond(input);
    },

    /**
     * Whether what the character says is written and not spoken: it is
     * answering a phone; or a phone is connected and the window is closed
     * (the app goes on without it); or a phone has been talking to it and
     * nobody is at the section on this computer. A phone that is only
     * connected, with its own assistant, changes nothing.
     */
    written() {
      if (!this.phone?.there()) return false;
      return this.from === 'phone' || Boolean(this.phone.hidden?.()) || (Boolean(this.phone.talking?.()) && !(this.active || this.session));
    },

    setPhase(phase) {
      // At the computer it does not listen.
      this.phase = this.working() && ['listening', 'hearing'].includes(phase) ? 'idle' : phase;
      phase = this.phase;
      const face = { idle: 'idle', listening: 'listening', hearing: 'listening', thinking: 'thinking', speaking: 'speaking' }[phase] || 'idle';
      this.puppet?.setState(face === 'idle' && this.working() ? 'working' : face);
      this.renderControls();
    },

    setStatus(text) { if (this.ui) this.ui.status.textContent = text || ''; },

    renderControls() {
      this.phone?.state();
      if (!this.ui) return;
      this.ui.talk.innerHTML = this.session
        ? `<i class="fa-solid fa-microphone-slash"></i> ${esc(t('realtime.stop'))}`
        : `<i class="fa-solid fa-microphone"></i> ${esc(t('realtime.start', { name: this.displayName() }))}`;
      this.ui.talk.classList.toggle('is-on', this.session);
      this.ui.interrupt.innerHTML = `<i class="fa-solid fa-hand"></i> ${esc(t('realtime.interrupt'))}`;
      this.ui.interrupt.hidden = !(this.phase === 'speaking' || this.phase === 'thinking');
      // At the computer it takes nothing in: the work can be stopped, and what there is to say waits for it to end.
      const atWork = this.working();
      this.ui.stopTask.innerHTML = `<i class="fa-solid fa-stop"></i> ${esc(t('realtime.stopTask'))}`;
      this.ui.stopTask.hidden = !atWork;
      const outcome = Boolean(this.confirming?.outcome);
      this.ui.confirmYes.innerHTML = `<i class="fa-solid fa-check"></i> ${esc(t(outcome ? 'realtime.outcomeYes' : 'realtime.confirmYes'))}`;
      this.ui.confirmNo.innerHTML = `<i class="fa-solid fa-xmark"></i> ${esc(t(outcome ? 'realtime.outcomeNo' : 'realtime.confirmNo'))}`;
      this.ui.confirmYes.hidden = this.ui.confirmNo.hidden = !this.confirming;
      this.ui.talk.disabled = atWork;
      this.ui.input.disabled = atWork;
      this.ui.form.querySelector('.rt-type-send').disabled = atWork;
      this.ui.input.placeholder = t(atWork ? 'realtime.typeWaiting' : this.confirming ? (outcome ? 'realtime.typeOutcome' : 'realtime.typeConfirm') : 'realtime.typePlaceholder', { name: this.displayName() });
      this.ui.puppet.title = this.phase === 'speaking' ? t('realtime.clickToInterrupt') : '';
      const status = {
        idle: this.session ? '' : t('realtime.statusOff'),
        listening: t('realtime.statusListening'),
        hearing: t('realtime.statusHearing'),
        thinking: t('realtime.statusThinking'),
        speaking: ''
      }[this.phase] || '';
      const working = this.tasks.filter(task => task.status === 'running' || task.status === 'waiting').length;
      this.desk?.setBusy(working > 0);
      this.atDesk?.();
      this.setStatus([
        this.lastError || '',
        this.diarySession ? this.diaryStepLabel(this.diarySession) : '',
        status,
        this.writing.size ? t('realtime.statusWriting') : '',
        this.confirming ? t(outcome ? 'realtime.statusAsking' : 'realtime.statusConfirming') : '',
        working ? t(working === 1 ? 'realtime.statusWorkingOne' : 'realtime.statusWorking', { count: working, name: this.displayName() }) : ''
      ].filter(Boolean).join(' · '));
    },

    async startSession() {
      if (!window.openRouterCatalog?.getApiKey?.()) { this.setStatus(t('realtime.noKey')); return; }
      try {
        await this.ensure();
        this.player = this.player || new Player();
        this.player.onIdle = () => this.afterSpeaking();
        this.mic = new Microphone({
          onLevel: (v) => this.puppet?.setHearing(v),
          onSpeechStart: () => {
            if (this.busy) return;
            this.setPhase('hearing');
            // Diary: the user speaks again, the next question waits.
            if (this.diarySession) this.diaryVoice(this.diarySession, true);
          },
          onSpeechEnd: () => {
            if (this.busy) return;
            if (this.phase === 'hearing') this.setPhase('listening');
            if (this.diarySession) this.diaryVoice(this.diarySession, false);
          },
          onSpeech: (wav) => { if (!this.busy) this.hear({ audio: wav }); }
        });
        await this.mic.open();
        this.session = true;
        this.listenAgain();
        this.setPhase('listening');
        // What finished while the microphone was off is told now.
        this.tellNext();
      } catch (err) {
        this.session = false;
        this.mic?.close();
        this.mic = null;
        this.setStatus(t('realtime.micError', { error: err.message }));
        this.setPhase('idle');
      }
    },

    stopSession() {
      this.session = false;
      this.mic?.close();
      this.mic = null;
      if (!this.busy && !this.player?.playing) this.setPhase('idle');
      else this.renderControls();
      // The conversation that has just ended is read for what it taught.
      this.analyze();
    },

    interrupt() {
      this.abort?.abort();
      this.player?.stop();
      this.busy = false;
      this.setPhase(this.session ? 'listening' : 'idle');
      this.listenAgain();
    },

    afterSpeaking() {
      if (this.busy) return;
      this.listenAgain();
      // A question of the diary is followed by listening, not by a smile.
      if (this.diarySession) { this.setPhase(this.session ? 'listening' : 'idle'); return; }
      this.puppet?.setState('happy');
      setTimeout(() => {
        if (this.phase !== 'speaking') return;
        this.setPhase(this.session ? 'listening' : 'idle');
        this.tellNext();
      }, 700);
    },

    /**
     * What waits to be told — a task's outcome, a reminder, a page written —
     * one at a time, when the character is free and no diary session is on.
     */
    tellNext() {
      // What the tasks made while the stage was not there to show it is handed now.
      this.handNext();
      if (this.busy || this.player?.playing || this.diarySession || this.working() || this.confirming || !this.reports.length) return;
      const report = this.reports.shift();
      if (report.ask && this.features.askOutcome) this.askOutcome(report);
      else if (report.say) {
        if (report.keep) this.keep('assistant', Array.isArray(report.say) ? writtenLine(report.say) : report.say);
        this.say(report.say, { fixed: Boolean(report.fixed) });
      } else this.respond({ report });
    },

    /**
     * A task is done and made no file: what it found is words, and may be
     * long. The user is asked, in fixed words, whether they want to hear it.
     */
    async askOutcome(report) {
      const parts = [{ text: t(report.done || 'realtime.outcomeDone'), fixed: true }, { text: '', shown: `«${report.ask}»` }, { text: t('realtime.outcomeQuestion'), fixed: true }];
      this.confirming = { task: report.ask, outcome: report };
      this.renderControls();
      await this.keep('assistant', writtenLine(parts));
      await this.say(parts);
    },

    /** Something to tell: now if it can be, otherwise as soon as it can. */
    tell(report) {
      this.reports.push(report);
      if (this.session || this.active || this.phone?.talking?.() || (this.phone?.there() && this.phone.hidden?.())) this.tellNext();
    },

    /**
     * A line said as it is written, without a model: the steps of the diary
     * session. Shown as the character's words and spoken with its voice.
     */
    async say(text, { fixed = false, atWork = false } = {}) {
      // At the computer it says nothing, but that it is going there (atWork).
      if (this.working() && !atWork) return;
      // A line may be made of parts, some said every time and kept, some said once:
      // [{ text, fixed, shown }], shown being what is written when it is more than what is said.
      const parts = Array.isArray(text) ? text : [{ text, fixed }];
      const apiKey = window.openRouterCatalog?.getApiKey?.();
      let written = false;
      this.busy = true;
      this.lastError = '';
      this.abort = new AbortController();
      if (this.mic) this.mic.paused = true;
      if (this.ui) { this.ui.user.textContent = ''; this.ui.bot.textContent = parts.map(part => part.shown || part.text).join(' '); }
      try {
        if (!apiKey) return;
        if (!this.player) {
          this.player = new Player();
          this.player.onIdle = () => this.afterSpeaking();
        }
        this.speechReset(apiKey);
        written = this.written();
        if (written) this.speechModel = null;
        for (const part of parts) {
          for (const piece of speechPieces(part.text)) {
            if (part.fixed && piece.length <= KEPT_LINE_MOST) await this.speakKept(piece);
            else this.speak(piece);
          }
        }
        await this.speechChain;
      } finally {
        this.busy = false;
        this.abort = null;
        if (!this.player?.playing) {
          this.listenAgain();
          this.setPhase(this.session ? 'listening' : 'idle');
        }
        // No voice to wait the end of: what is next to tell is told now.
        if (written) this.tellNext();
      }
    },

    /**
     * A line that is said again and again: its sound taken from the ones
     * kept, or made now, played as it comes and kept for the next time.
     */
    async speakKept(clean) {
      if (!this.speechModel) return;
      const voices = voicesFor(this.speechModel);
      const voice = voices.length ? (voices.includes(this.voice) ? this.voice : voices[0]) : '';
      const key = `${this.speechModel}|${voice}|${speechLocale()}|${clean}`;
      const kept = await keptLines.get(key);
      if (kept) {
        if (this.phase !== 'speaking') this.setPhase('speaking');
        this.player.pushBytes(new Uint8Array(kept.bytes), kept.rate);
        return;
      }
      const body = { model: this.speechModel, input: clean, response_format: 'pcm', provider: speechProvider() };
      if (voice) body.voice = voice;
      try {
        const response = await window.modelGateway.fetchApi(SPEECH_URL, {
          method: 'POST',
          track: { conversationId: this.conversationId, role: 'speech' },
          signal: this.abort?.signal,
          headers: { 'Authorization': `Bearer ${this.speechKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://synthorg.local', 'X-Title': 'SynthOrg Realtime' },
          body: JSON.stringify(body)
        });
        if (!response.ok) {
          let detail = '';
          try { detail = (await response.json())?.error?.message || ''; } catch {}
          throw new Error(detail || `HTTP ${response.status}`);
        }
        const rate = pcmRate(response);
        const reader = response.body.getReader();
        const chunks = [];
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (this.phase !== 'speaking') this.setPhase('speaking');
          chunks.push(value);
          this.player.pushBytes(value, rate);
        }
        // Whole, and only then kept: a line cut short by an interruption is not one to say again.
        const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        chunks.forEach(c => { bytes.set(c, at); at += c.length; });
        if (bytes.length) keptLines.put(key, { rate, bytes: bytes.buffer });
      } catch (err) {
        if (err.name !== 'AbortError') this.setStatus(t('realtime.ttsError', { error: err.message }));
      }
    },

    /* -------------------------------------------------------------- */
    /* One exchange                                                     */
    /* -------------------------------------------------------------- */

    /**
     * The character's instructions, in three parts, from what changes least
     * to what changes most: who it is and how it speaks; what it knows of the
     * user; the agenda, the goals, the diary and the time. The first two are
     * the same from an exchange to the next and are kept by the provider's
     * cache; a clock at the top would make every exchange new. What each
     * tool is for is said by the tool itself, once.
     */
    systemPrompt() {
      const now = new Date();
      const notes = this.notes.map(n => `- ${n.content}`).join('\n');
      const dossier = (this.context?.memories || []).filter(m => m.scope === 'global').map(m => `- ${m.content}`).join('\n');
      const rules = [
        `Sei ${this.displayName()}, il personaggio animato della sezione Assistente di SynthOrg: parli con l'utente a voce, come un amico curioso e alla mano.`,
        'Rispondi in modo breve e naturale, come in una conversazione parlata: niente elenchi, titoli, markdown, link o codice. Parla nella lingua dell\'utente.',
        // What the app tells the character is written in Italian: with the app in English, its own words are English.
        ...(window.i18n?.getLocale?.() === 'en' ? ['The user has the app in English: speak English, unless they write to you in another language.'] : []),
        'Le conversazioni passate sono qui sotto, riassunte quando sono lunghe; le tue note sull\'utente vengono dopo queste istruzioni.',
        'Accanto a te c\'è il tuo computer: quello che richiede strumenti o lavoro vero lo fai lì, con work.',
        'Una cosa chiesta si fa chiamando la sua funzione: dirla a parole non la fa. Un numero o un risultato lo dici solo se l\'hai ricevuto.',
        'La tua faccia mostra quello che provi: un\'emoji in una frase è la faccia che fai mentre la dici, e non viene letta. 😊 😂 😍 😮 😢 🤔 😉 😬 😠 🥳, e 😅 quando ti accorgi di aver sbagliato. Al massimo una per frase.'
      ].join('\n');
      const known = [
        notes ? `[COSA SAI DELL'UTENTE — note tue]\n${notes}` : '[COSA SAI DELL\'UTENTE]\nAncora niente.',
        dossier ? `[DOSSIER GLOBALE DELL'UTENTE]\n${dossier}` : ''
      ].filter(Boolean).join('\n\n');
      const today = [
        `Adesso è ${now.toLocaleString(window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}.`,
        `[AGENDA — prossimi giorni, ora locale]\n${this.agendaPrompt()}`,
        `[OBIETTIVI APERTI]\n${this.goalsPrompt()}`,
        `[DIARIO — ultimi giorni]\n${this.diaryPrompt()}`
      ].join('\n\n');
      return [{ text: rules, keep: true }, { text: known, keep: true }, { text: today }];
    },

    /** The last days of the diary as the character is told them: a line each; the pages are read with diary_read. */
    diaryPrompt() {
      const lines = (this.diary || []).slice(0, 3).map(e => {
        const summary = dayData(e)?.summary || (e.page_text || e.raw_text).replace(/\s+/g, ' ').slice(0, 200);
        return `${e.day}: ${summary}`;
      });
      return lines.length ? lines.join('\n') : 'Ancora nessuna pagina.';
    },

    tools() {
      return REALTIME_TOOLS.filter(tool => !tool.available || tool.available(this))
        .map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    },

    /**
     * One exchange: what you said (audio or text) or the outcome of a task,
     * the answer spoken and saved, the tools it calls run in between. When
     * the tools called have all done what was asked, what is left to say is
     * said by the app in fixed words and the model is not asked again.
     */
    async respond(input) {
      if (this.busy || this.working()) return;
      const registry = window.operationalRegistry;
      // It hears you with the Realtime Multi model (audio in, text out, tools)
      // and speaks with the Speech synthesis one.
      const model = registry?.getCurrentRealtimeMultiModel?.();
      const apiKey = window.openRouterCatalog?.getApiKey?.();
      // A model on this computer needs no key; the voice and the transcription, asked of a provider, still do.
      if (!model || (!apiKey && !model.isLocal)) { this.setStatus(t(model ? 'realtime.noKey' : 'realtime.noModel')); return; }
      // A model that takes no audio does not hear: what you say is written down first (the Transcription role)
      // and it is given the words; it answers in text, which the Speech synthesis role says.
      const hears = (model.inputModalities || []).includes('audio') || Boolean(model.hasAudioIn);
      this.busy = true;
      this.lastError = '';
      this.abort = new AbortController();
      this.speechReset(apiKey);
      // To a phone, or with nobody at this computer, the answer is written and not spoken.
      const written = this.written();
      if (written) this.speechModel = null;
      // Written instead of spoken: the voice still answers, microphone or not.
      if (!this.player) {
        this.player = new Player();
        this.player.onIdle = () => this.afterSpeaking();
      }
      if (this.mic) this.mic.paused = true;
      this.setPhase('thinking');
      this.ui.bot.textContent = '';
      const conversationId = this.conversationId;
      let lines = [];   // what the tools left to say, in fixed words
      try {
        await this.ensure();
        let heard = '';
        if (input.audio && !hears) {
          this.ui.user.textContent = '…';
          heard = await this.words(input.audio);
          if (!heard) throw new Error(t('realtime.needsTranscriber', { model: model.name }));
        }
        const userText = heard || input.text || (input.report ? input.report.text : '');
        // The outcome of a task is the Master's work, done in a context of its own: the character is given it
        // for this one turn, to tell it. In its conversation only the task's title stays, with what it said.
        const keptText = input.report ? (input.report.kept || headOf(userText)) : userText;
        this.context = await window.chatStorage.context(conversationId, userText, { includeGlobal: true, includeChat: true });
        const history = this.context.messages.flatMap((m, i) => this.sent(m, i));

        // What comes in now: your voice as audio, or text.
        const asAudio = Boolean(input.audio) && !heard;
        const user = window.chatManager.makeMessage('user', asAudio ? t('realtime.voiceMessage') : keptText, input.report ? { report: true } : {});
        let current;
        if (asAudio) {
          current = { role: 'user', content: [{ type: 'input_audio', input_audio: { data: input.audio, format: 'wav' } }] };
          this.ui.user.textContent = '…';
        } else {
          current = { role: 'user', content: userText };
          this.ui.user.textContent = input.report ? '' : userText;
        }
        await window.chatManager.persist(user, conversationId);
        // The words you said, written down for the memory; meanwhile the answer comes.
        if (asAudio) {
          const heard = this.transcribe(input.audio, user, conversationId);
          this.hearing.add(heard);
          heard.finally(() => this.hearing.delete(heard));
        }

        const messages = [{ role: 'system', parts: this.systemPrompt() }, ...history, current];
        let spoken = '';
        const closing = [];
        const made = [];   // the tools called, and what each gave back: kept with the answer
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          // An outcome is only to be told: no tool may be called for it.
          const out = await this.stream(model.id, apiKey, messages, { tools: !input.report });
          spoken += out.transcript;
          if (!out.toolCalls.length) break;
          messages.push({ role: 'assistant', content: out.transcript || null, tool_calls: out.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })) });
          const results = [];
          for (const tc of out.toolCalls) {
            const tool = REALTIME_TOOLS.find(x => x.name === tc.name);
            let result;
            try {
              this.standOnWhatOpens(tc.name);
              result = tool ? await tool.run(JSON.parse(tc.args || '{}'), this) : `ERRORE: strumento sconosciuto ${tc.name}.`;
            } catch (err) {
              result = `ERRORE: ${err.message}`;
            }
            results.push(result);
          }
          const given = results.map(result => (result && typeof result === 'object' ? writtenLine(result.say) || result.kept || 'Fatto.' : String(result)));
          out.toolCalls.forEach((tc, i) => made.push({ name: tc.name, args: tc.args || '{}', result: given[i].slice(0, 2000) }));
          const fixed = results.filter(result => result && typeof result === 'object');
          // Every tool did what was asked, or a task is to be started: the rest is said in fixed words, not by the model.
          if (fixed.length === results.length || this.toConfirm.length) {
            closing.push(...fixed);
            break;
          }
          // Something was read, or went wrong: the model goes on from it, and says what was done too.
          out.toolCalls.forEach((tc, i) => messages.push({ role: 'tool', tool_call_id: tc.id, content: given[i] }));
          this.setPhase('thinking');
        }
        const handing = this.toConfirm.length > 0;
        lines = closing.flatMap(result => result.say || []);
        const kept = [spoken.trim(), writtenLine(lines), ...closing.map(result => result.kept)].filter(Boolean).join(' ');
        // A model that answers nothing is said so, instead of a silence.
        if (!kept && !handing) throw new Error(t('realtime.emptyReply', { model: model.name }));
        // What is left of the text is said too; the turn ends when the voice has all of it.
        this.speechFeed('', true);
        await this.speechChain;
        if (handing) {
          this.saidBefore = [spoken.trim(), writtenLine(lines)].filter(Boolean).join(' ');
          this.calledBefore = made;
        } else {
          const answer = window.chatManager.makeMessage('assistant', kept, { modelId: model.id, modelName: model.name, ...(made.length ? { calls: made } : {}) });
          await window.chatManager.persist(answer, conversationId);
        }
        // The level memory, brought up to date in the background. What the
        // exchange taught about you is worked out when the session ends.
        window.chatManager.recordTurnChatMemory?.(conversationId).catch?.(() => {});
      } catch (err) {
        if (err.name !== 'AbortError') {
          // Kept in view until the next exchange: the listening status must not cover it.
          this.lastError = t('realtime.error', { error: err.message });
          this.puppet?.setState('idle');
        }
      } finally {
        this.busy = false;
        this.abort = null;
        if (!this.player?.playing) {
          this.listenAgain();
          if (this.phase !== 'idle') this.setPhase(this.session ? 'listening' : 'idle');
        }
        // What a tool did, in fixed words.
        if (lines.length) await this.say(lines);
        // Asked for while talking: the diary session starts now.
        const asked = this.diaryAsked;
        this.diaryAsked = null;
        if (asked && !this.diarySession) this.startDiary(asked.day, { interrupt: false });
        // A task for the Master: told to the user now, in fixed words.
        await this.confirmNext();
        // No voice to wait the end of: what is next to tell is told now.
        if (written) this.tellNext();
      }
    },

    /* -------------------------------------------------------------- */
    /* The voice: sentences to the Speech synthesis model as they come  */
    /* -------------------------------------------------------------- */

    speechReset(apiKey) {
      this.speechBuffer = '';
      this.speechChain = Promise.resolve();
      this.speechStarted = false;
      this.speechPieces = 0;
      this.speechKey = apiKey;
      const tts = window.operationalRegistry?.getToolDelegate?.('voice_synthesis');
      this.speechModel = tts && tts !== 'auto' ? tts : null;
      if (!this.speechModel) this.setStatus(t('realtime.noTts'));
    },

    /**
     * The text as it streams, handed to the voice in pieces that grow: the
     * first sentence as soon as it is whole, so the voice starts as early as
     * it can without cutting a sentence; then longer runs of sentences. Every piece is asked for
     * as soon as its text is there, so the next ones are ready while the
     * first play. `final` flushes whatever is left.
     */
    speechFeed(piece, final = false) {
      if (!this.speechModel) return;
      this.speechBuffer += piece || '';
      const buf = this.speechBuffer;
      const opening = this.speechPieces === 0;
      // A piece ends where a sentence ends, never inside one: the voice makes each piece on
      // its own, and a cut after a comma or a count of letters is heard as a pause out of place.
      const ends = /[.!?…](?=\s)|\n/g;
      const minimum = opening ? 8 : this.speechPieces === 1 ? 20 : 70;
      let cut = -1;
      let m;
      while ((m = ends.exec(buf))) {
        cut = m.index + 1;
        if (opening && cut >= minimum) break;   // the first sentence, not the last one
      }
      if (final) cut = buf.length;
      if (cut <= 0 || (cut < minimum && !final)) return;
      this.speechBuffer = buf.slice(cut);
      this.speechPieces++;
      this.speak(buf.slice(0, cut));
    },

    speak(text) {
      if (!this.speechModel) return;
      // The emoji are not read: they become the face the character makes
      // while this sentence is heard.
      const expression = window.RealtimePuppet?.expressionOf?.(text);
      const clean = speechText(text);
      if (!clean) {
        // Only an emoji: its face comes when what is queued has been said.
        if (expression) {
          this.speechChain = this.speechChain.then(() => {
            const startsIn = Math.max(0, this.player.nextTime - this.player.ctx.currentTime);
            setTimeout(() => this.puppet?.setExpression(expression, 2200), startsIn * 1000);
          });
        }
        return;
      }
      this.speechStarted = true;
      const voices = voicesFor(this.speechModel);
      const body = { model: this.speechModel, input: clean, response_format: 'pcm', provider: speechProvider() };
      if (voices.length) body.voice = voices.includes(this.voice) ? this.voice : voices[0];
      // Asked now, played in order: the next sentence is ready when this one ends.
      const request = window.modelGateway.fetchApi(SPEECH_URL, {
        method: 'POST',
        track: { conversationId: this.conversationId, role: 'speech' },
        signal: this.abort?.signal,
        headers: { 'Authorization': `Bearer ${this.speechKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://synthorg.local', 'X-Title': 'SynthOrg Realtime' },
        body: JSON.stringify(body)
      });
      request.catch(() => {});
      this.speechChain = this.speechChain.then(async () => {
        const response = await request;
        if (!response.ok) {
          let detail = '';
          try { detail = (await response.json())?.error?.message || ''; } catch {}
          throw new Error(detail || `HTTP ${response.status}`);
        }
        const reader = response.body.getReader();
        const rate = pcmRate(response);
        let first = true;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (this.phase !== 'speaking') this.setPhase('speaking');
          if (first && expression) {
            // When this sentence starts playing: after what is already queued.
            const startsIn = Math.max(0, this.player.nextTime - this.player.ctx.currentTime);
            const lasts = Math.min(8000, 1500 + clean.length * 70);
            setTimeout(() => this.puppet?.setExpression(expression, lasts), startsIn * 1000);
          }
          first = false;
          this.player.pushBytes(value, rate);
        }
      }).catch(err => {
        if (err.name !== 'AbortError') this.setStatus(t('realtime.ttsError', { error: err.message }));
      });
    },

    /**
     * The streamed answer: the words shown and spoken as they come, the tool
     * calls gathered. The model is made to answer through a function: a
     * tool, or `say` for its words, which are taken out of the call as its
     * arguments come. `tools: false`: only words may be answered (an outcome
     * to tell). A model that cannot be made to choose is left free to.
     */
    async stream(modelId, apiKey, messages, { tools: withTools = true } = {}) {
      const tools = this.tools();
      const payload = this.wire({
        model: modelId,
        stream: true,
        messages
      }, `realtime-${this.conversationId}`);
      // What the model takes, as the catalog lists it; not listed: taken as able.
      const can = window.openRouterCatalog?.models?.find(m => m.id === modelId)?.supportedParameters || [];
      const made = !can.length || can.includes('tool_choice');
      if (tools.length && (!can.length || can.includes('tools'))) {
        payload.tools = made ? [SAY, ...tools] : tools;
        payload.tool_choice = made
          ? (withTools ? 'required' : { type: 'function', function: { name: SAY.function.name } })
          : (withTools ? 'auto' : 'none');
      }
      const response = await window.modelGateway.fetchChat({
        method: 'POST',
        track: { conversationId: this.conversationId, role: 'realtime' },
        signal: this.abort.signal,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://synthorg.local', 'X-Title': 'SynthOrg Realtime' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.json())?.error?.message || ''; } catch {}
        throw new Error(detail || `HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let transcript = '';
      const calls = [];
      // What the model thinks before answering is not said: a block between thinking tags is left out as it
      // comes; if only the end of one comes (the template had opened it), what was shown until then was thinking.
      let thinking = false, held = '', runaway = false;
      const TAG = /<(\/?)(think|thinking|thought|reasoning|reflection)>/i;
      const words = (piece) => {
        if (!piece || runaway) return;
        held += piece;
        let out = '';
        for (;;) {
          const tag = TAG.exec(held);
          if (!tag) break;
          if (!thinking && !tag[1]) out += held.slice(0, tag.index);
          if (!thinking && tag[1]) { transcript = ''; out = ''; this.speechReset(apiKey); }
          thinking = !tag[1];
          held = held.slice(tag.index + tag[0].length);
        }
        // The start of a tag may be at the end of what has come: it waits for the rest.
        const open = held.lastIndexOf('<');
        const wait = open >= 0 && held.length - open < 14 ? held.slice(open) : '';
        if (!thinking) out += held.slice(0, held.length - wait.length);
        held = wait;
        if (!out) return;
        transcript += out;
        // A model that only repeats itself (the same few signs, over and over) is stopped where it started to.
        const loop = repeatsAt(transcript);
        if (loop >= 0) { runaway = true; transcript = transcript.slice(0, loop); this.ui.bot.textContent = transcript; reader.cancel().catch(() => {}); return; }
        this.ui.bot.textContent = transcript;
        this.speechFeed(out);
      };
      // The words of a `say` call: what has come of them since the last time.
      const said = (call) => {
        if (call.name !== SAY.function.name) return;
        const now = wordsSoFar(call.args);
        if (now.length <= call.said.length || !now.startsWith(call.said)) return;
        // After other words, a space between the two.
        words((call.said || !transcript || /\s$/.test(transcript) ? '' : ' ') + now.slice(call.said.length));
        call.said = now;
      };
      for (;;) {
        if (runaway) break;
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const data = line.startsWith('data:') ? line.slice(5).trim() : '';
          if (!data || data === '[DONE]') continue;
          let chunk;
          try { chunk = JSON.parse(data); } catch { continue; }
          if (chunk.error) throw new Error(chunk.error.message || 'Errore del modello');
          const delta = chunk.choices?.[0]?.delta || {};
          if (runaway) break;
          words(typeof delta.content === 'string' ? delta.content : '');
          (delta.tool_calls || []).forEach(tc => {
            const i = tc.index ?? 0;
            calls[i] = calls[i] || { id: '', name: '', args: '', said: '' };
            if (tc.id) calls[i].id = tc.id;
            if (tc.function?.name) calls[i].name += tc.function.name;
            if (tc.function?.arguments) calls[i].args += tc.function.arguments;
            said(calls[i]);
          });
        }
      }
      return {
        transcript,
        toolCalls: calls.filter(call => call && call.name !== SAY.function.name).map(({ id, name, args }) => ({ id: id || crypto.randomUUID(), name, args }))
      };
    },

    /**
     * The words of a recording, from the Transcription role's model. With
     * `listener`, when that role has no model the one that hears (Realtime
     * Multi) writes them down: the diary cannot do without the words.
     */
    async words(audio, { listener = false } = {}) {
      const registry = window.operationalRegistry;
      const apiKey = window.openRouterCatalog?.getApiKey?.();
      const assigned = registry?.getToolDelegate?.('audio_transcription');
      const transcriber = assigned && assigned !== 'auto' ? assigned : null;
      // The one that hears, only if it does: a model that takes no audio cannot write the words down.
      const multi = listener ? registry?.getCurrentRealtimeMultiModel?.() : null;
      const hears = multi && ((multi.inputModalities || []).includes('audio') || Boolean(multi.hasAudioIn));
      const modelId = transcriber || (hears ? multi.id : null);
      if (!modelId || !apiKey) return '';
      const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://synthorg.local', 'X-Title': 'SynthOrg Realtime' };
      // A transcription model has its own endpoint; a model that also chats
      // (audio in, text out) is asked through the chat one.
      if (transcriber) {
        const direct = await window.modelGateway.fetchApi('https://openrouter.ai/api/v1/audio/transcriptions', {
          method: 'POST', headers,
          track: { conversationId: this.conversationId, role: 'transcription' },
          body: JSON.stringify({ model: modelId, input_audio: { data: audio, format: 'wav' } })
        });
        if (direct.ok) return String((await direct.json())?.text || '').trim();
      }
      const response = await window.modelGateway.fetchChat({
        method: 'POST', headers,
        track: { conversationId: this.conversationId, role: 'transcription' },
        body: JSON.stringify(this.wire({
          model: modelId,
          stream: false,
          messages: [{ role: 'user', content: [
            { type: 'text', text: 'Transcribe the words of this audio exactly, in their language. Reply with the transcription only.' },
            { type: 'input_audio', input_audio: { data: audio, format: 'wav' } }
          ] }]
        }))
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
      return String(data?.choices?.[0]?.message?.content || '').trim();
    },

    /** Your words in a conversation, written in place of the placeholder; without a Transcription model, the placeholder stays. */
    async transcribe(audio, message, conversationId) {
      try {
        const text = await this.words(audio);
        if (!text) { if (this.ui.user.textContent === '…') this.ui.user.textContent = ''; return ''; }
        message.content = text;
        await window.chatManager.persist(message, conversationId);
        if (this.ui.user.textContent === '…') this.ui.user.textContent = text;
        return text;
      } catch {
        if (this.ui.user.textContent === '…') this.ui.user.textContent = '';
        return '';
      }
    },

    /* -------------------------------------------------------------- */
    /* Memories: what it knows about you                                */
    /* -------------------------------------------------------------- */

    /** The notes as a model is shown them, each with a short id to name it by; ids: short id -> note. */
    knownNotes() {
      const ids = new Map(this.notes.map((note, i) => [`n${i + 1}`, note]));
      const list = [...ids].map(([id, note]) => `[${id}] ${note.content}`).join('\n') || '(none)';
      return { ids, list };
    },

    /**
     * What a model worked out about the notes, carried out: notes added,
     * rewritten, removed. `ids` are the short ids the model was given.
     */
    async applyMemories(changes, ids, origin) {
      if (!changes || !this.conversationId) return 0;
      const conversationId = this.conversationId;
      const list = (v) => (Array.isArray(v) ? v : []);
      const save = (content, id) => window.chatStorage.saveMemory(
        { content: content.slice(0, 600), scope: 'conversation', conversationId, section: 'about_user', pinned: true, origin }, id);
      let done = 0;
      for (const item of list(changes.update)) {
        const note = ids.get(String(item?.id || ''));
        const content = String(item?.content || '').trim();
        if (!note || !content || content === note.content) continue;
        try { await save(content, note.id); done++; } catch {}
      }
      const rewritten = new Set(list(changes.update).map(item => String(item?.id || '')));
      for (const id of list(changes.remove)) {
        const note = ids.get(String(id));
        if (!note || rewritten.has(String(id))) continue;
        try { await window.chatStorage.deleteMemory(note.id); done++; } catch {}
      }
      for (const added of list(changes.add)) {
        const content = String(added || '').trim();
        if (!content || this.notes.some(n => plainWords(n.content) === plainWords(content))) continue;
        try { await save(content); done++; } catch {}
      }
      if (done) await this.loadNotes();
      return done;
    },

    /** Waits until nothing is being said, answered or written down (at most a minute). */
    async settled() {
      for (let i = 0; i < 120 && (this.busy || this.hearing.size); i++) {
        await Promise.allSettled([...this.hearing]);
        if (this.busy) await new Promise(resolve => setTimeout(resolve, 500));
      }
    },

    /* -------------------------------------------------------------- */
    /* Tasks for the Master                                             */
    /* -------------------------------------------------------------- */

    /**
     * A task for the Master. While there is one to do or under way the
     * character is at the computer and takes nothing in: the user waits for
     * the outcome, or stops the work.
     */
    startTask(text, chat = null) {
      const task = { id: crypto.randomUUID(), text, chat, status: 'waiting', result: '', started: Date.now(), stop: new AbortController() };
      this.tasks.unshift(task);
      this.renderSide();
      this.setPhase(this.phase);
      this.runTasks();
    },

    /** Whether the Master has a task to do or under way. */
    working() {
      return this.tasks.some(task => task.status === 'running' || task.status === 'waiting');
    },

    /** The microphone takes in what is said again, unless the character is at the computer. */
    listenAgain() {
      if (this.mic) this.mic.paused = this.working() || Boolean(this.confirming && !this.features.voiceYes);
    },

    /* -------------------------------------------------------------- */
    /* A task handed over: a turn of fixed words                        */
    /* -------------------------------------------------------------- */

    /**
     * A task the character wants to hand to the Master. It is never handed
     * by the model's own words: the app tells the user what the task is, in
     * fixed words, and asks them to confirm it, unless the character may
     * always hand tasks over (the section's settings). No model takes part.
     */
    askTask(task) {
      this.toConfirm.push(task);
    },

    /** What is said in the character's conversation in fixed words is kept in it like the rest. */
    async keep(role, content, meta = {}) {
      try { await window.chatManager.persist(window.chatManager.makeMessage(role, content, meta), this.conversationId); } catch {}
    },

    /**
     * A message of the conversation as it is sent to the model. An answer
     * that called tools is sent as it went: the calls, what each gave back,
     * then the words. What was done is there apart from what was said.
     */
    sent(message, index) {
      const known = (message.calls || []).filter(call => REALTIME_TOOLS.some(tool => tool.name === call.name));
      // An outcome kept whole by an earlier version: only its title is sent.
      if (message.role === 'user') return [{ role: 'user', content: headOf(message.content) }];
      if (message.role !== 'assistant' || !known.length) return [{ role: message.role, content: message.content }];
      const calls = known.map((call, i) => ({ ...call, id: `past_${index}_${i}` }));
      return [
        { role: 'assistant', content: null, tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.args || '{}' } })) },
        ...calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: call.result || 'Fatto.' })),
        ...(message.content ? [{ role: 'assistant', content: message.content }] : [])
      ];
    },

    /** The next task to hand over is told to the user: asked about, or handed at once. */
    async confirmNext() {
      if (this.confirming || this.busy || !this.toConfirm.length) return;
      const next = this.toConfirm[0];
      // A message to write in a chat has its own switch; a task, the tasks' one.
      const send = next && typeof next === 'object' ? next.send || null : null;
      const free = send ? this.features.relay : this.features.delegate;
      // One task at a time is asked about: while the Master works the next one waits.
      if (this.working() && !free) return;
      this.toConfirm.shift();
      const task = send ? send.text : (typeof next === 'string' ? next : next.task);
      const chat = !send && typeof next === 'object' ? next.chat || null : null;
      const start = () => (send ? this.relay(send) : this.startTask(task, chat));
      // The chat a message goes to is said before the message.
      const where = send ? [{ text: `${send.title}.`, shown: `«${send.title}».` }] : [];
      const before = this.saidBefore;
      const called = this.calledBefore?.length ? { calls: this.calledBefore } : {};
      this.saidBefore = '';
      this.calledBefore = null;
      const told = { text: spokenTask(task), shown: `«${task}»` };
      if (free) {
        const parts = send
          ? [{ text: t('realtime.relayHanded'), fixed: true }, ...where, told, { text: t('realtime.relayGoing'), fixed: true }]
          : [{ text: t('realtime.confirmHanded'), fixed: true }, told, { text: t('realtime.confirmGoing'), fixed: true }];
        await this.keep('assistant', [before, ...parts.map(part => part.shown || part.text)].filter(Boolean).join(' '), called);
        start();
        await this.say(parts, { atWork: true });
        this.confirmNext();
        return;
      }
      const parts = send
        ? [{ text: t('realtime.relayOpening'), fixed: true }, ...where, told, { text: t('realtime.confirmQuestion'), fixed: true }]
        : [{ text: t('realtime.confirmOpening'), fixed: true }, told, { text: t('realtime.confirmQuestion'), fixed: true }];
      this.confirming = { task, ...(send ? { send } : {}), ...(chat ? { chat } : {}) };
      this.renderControls();
      await this.keep('assistant', [before, ...parts.map(part => part.shown || part.text)].filter(Boolean).join(' '), called);
      await this.say(parts);
    },

    /** What is answered to the question, said or written: yes, no, or something else, and the question is asked again. */
    async confirmHear(input) {
      const pending = this.confirming;
      if (!pending || this.busy) return;
      if (input.audio && !this.features.voiceYes) return;
      let said = String(input.text || '');
      if (input.audio) {
        this.busy = true;
        this.setPhase('thinking');
        try { said = await this.words(input.audio, { listener: true }); } catch { said = ''; }
        this.busy = false;
        this.listenAgain();
        this.setPhase(this.session ? 'listening' : 'idle');
      }
      if (this.confirming !== pending || !said.trim()) return;
      const answer = yesOrNo(said);
      if (answer) { await this.confirmTask(answer === 'yes', said.trim()); return; }
      if (this.ui) this.ui.user.textContent = said.trim();
      const again = t(pending.outcome ? 'realtime.outcomeAgain' : 'realtime.confirmAgain');
      await this.keep('user', said.trim());
      await this.keep('assistant', again);
      await this.say(again, { fixed: true });
    },

    /** The user has answered, with a button or with their words: the task is handed to the Master, or left. */
    async confirmTask(yes, said = '') {
      const pending = this.confirming;
      if (!pending) return;
      this.confirming = null;
      // The answer may come while the question is still being said.
      if (this.busy || this.player?.playing) this.interrupt();
      if (pending.outcome) {
        await this.keep('user', said || t(yes ? 'realtime.outcomeYes' : 'realtime.outcomeNo'));
        if (this.ui) this.ui.user.textContent = said;
        this.renderControls();
        if (yes) {
          // Told by the character, from what the task found.
          this.reports.unshift({ text: pending.outcome.text });
          this.tellNext();
        } else {
          await this.keep('assistant', t('realtime.outcomeLeft'));
          await this.say(t('realtime.outcomeLeft'), { fixed: true });
        }
        return;
      }
      const line = t(yes ? (pending.send ? 'realtime.relayGoing' : 'realtime.confirmGoing') : 'realtime.confirmDropped');
      await this.keep('user', said || t(yes ? 'realtime.confirmYes' : 'realtime.confirmNo'));
      await this.keep('assistant', line);
      if (yes && pending.send) this.relay(pending.send);
      else if (yes) this.startTask(pending.task, pending.chat);
      if (!yes || pending.send) this.renderControls();
      await this.say(line, { fixed: true, atWork: true });
      if (this.ui) this.ui.user.textContent = said;
      this.confirmNext();
    },

    /** The tasks are done one at a time, in the order they were handed: they share a chat and its workspace. */
    async runTasks() {
      if (this.runningTasks) return;
      this.runningTasks = true;
      try {
        for (;;) {
          const task = [...this.tasks].reverse().find(waiting => waiting.status === 'waiting');
          if (!task) break;
          await this.runTask(task);
        }
      } finally {
        this.runningTasks = false;
      }
    },

    async runTask(task) {
      task.status = 'running';
      task.started = Date.now();
      this.renderSide();
      this.renderControls();
      let handed = [];
      try {
        const tasksId = this.tasksConversationId || (await window.chatStorage.realtime()).tasksConversationId;
        this.tasksConversationId = tasksId;
        // The Master starts from the task alone: what the chat holds of the tasks before stays there to be read.
        // The files made before, which the task may be about, are named to it by the app.
        // So is the chat the task is about: its last messages (realtime-liaison.js).
        const about = ((await this.filesAbout?.(task.text)) || '') + (task.chat ? (await this.chatAbout?.(task.chat)) || '' : '');
        // The copies of a project's files made for the task before are not this task's (realtime-liaison.js).
        await this.clearCopies?.(tasksId);
        // A task about a project may ask for copies of its files, in its own workspace.
        const tools = task.chat?.projectId ? this.projectTools?.(task.chat, tasksId) : null;
        const answer = await window.chatManager.runBackgroundTurn(tasksId, task.text + about, { whole: true, fresh: true, signal: task.stop.signal, ...(tools ? { tools } : {}) });
        if (task.status !== 'running') return;
        task.result = answer.content;
        // What it made comes out of the machine beside the character, and is handed to the user.
        handed = await this.handOver(answer, task.text);
        task.status = 'done';
      } catch (err) {
        // Stopped by the user: said when it was stopped.
        if (task.status !== 'running') return;
        task.status = 'error';
        task.result = err.message;
        this.desk?.show('failed', 2600);
      }
      this.renderSide();
      this.setPhase(this.phase);
      this.listenAgain();
      if (!this.working()) this.confirmNext();
      // The outcome reaches the character, which tells it when no task is left to do.
      // With no file made it is only words: the user is asked first whether they want to hear them.
      this.tell({
        ask: task.status === 'done' && !handed.length ? task.text : '',
        text: task.status === 'done'
          ? `[Hai finito il compito: «${task.text.slice(0, 300)}»]\n${String(task.result || '').slice(0, 6000)}${handed.length ? '\n\n' + this.handedText(handed) : ''}\n\nRacconta l'esito all'utente, in breve.`
          : `[Il compito non è riuscito: «${task.text.slice(0, 300)}». Errore: ${task.result}]\nDillo all'utente, in breve.`
      });
    },

    /**
     * The work is stopped: the task under way and the ones waiting. The user
     * can speak again at once; the Master's turn ends at its next step, and
     * what it wrote until then stays in the chat of the tasks.
     */
    stopTasks() {
      const stopped = this.tasks.filter(task => task.status === 'running' || task.status === 'waiting');
      if (!stopped.length) return;
      stopped.forEach(task => { task.status = 'stopped'; task.stop.abort(); });
      this.renderSide();
      this.setPhase(this.phase);
      this.listenAgain();
      this.tell({ say: t('realtime.taskStopped'), fixed: true });
    },

    /* -------------------------------------------------------------- */
    /* Agenda: reminders and activities                                 */
    /* -------------------------------------------------------------- */

    async loadAgenda() {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      try {
        this.agenda = await window.chatStorage.agenda(localStamp(today), localStamp(addDays(today, 15)));
      } catch {
        this.agenda = [];
      }
      this.renderSide();
    },

    /** The next days as the character is told them, with the ids it needs to change an item. */
    agendaPrompt() {
      const open = (this.agenda || []).filter(i => !i.done);
      return open.length ? open.slice(0, 40).map(agendaLine).join('\n') : 'Niente in agenda nei prossimi giorni.';
    },

    /** Every 20 seconds, whatever tab is open: the reminders whose moment has come. */
    startReminders() {
      if (this.reminderTimer) return;
      const check = async () => {
        if (!window.chatStorage) return;
        let due = [];
        try { due = await window.chatStorage.dueReminders(localStamp(new Date())); } catch { return; }
        due.forEach(item => this.announce(item));
        if (due.length) this.loadAgenda();
      };
      this.reminderTimer = setInterval(check, 20000);
      setTimeout(check, 4000);
    },

    announce(item) {
      try { window.playNotificationSound?.(); } catch {}
      this.toast(item);
      this.phone?.tell('reminder', { id: item.id, title: item.title, at: item.start_at, notes: item.notes || '' });
      // On the Realtime tab, or with the microphone on, the character says it.
      if (!(this.active || this.session) || !window.openRouterCatalog?.getApiKey?.()) return;
      this.tell({ say: fixedLine('realtime.saidReminderDue', item.title, String(item.notes || '').replace(/\s+/g, ' ').trim().slice(0, 200)), keep: true });
    },

    toast(item) {
      let box = document.getElementById('rt-toasts');
      if (!box) {
        box = document.createElement('div');
        box.id = 'rt-toasts';
        box.className = 'rt-toasts';
        document.body.appendChild(box);
      }
      const card = document.createElement('div');
      card.className = 'rt-toast';
      card.setAttribute('role', 'alert');
      const when = parseStamp(item.start_at);
      card.innerHTML = `
        <i class="fa-solid fa-bell" aria-hidden="true"></i>
        <div class="rt-toast-body">
          <strong>${esc(t('realtime.reminderTitle'))}</strong>
          <span>${esc(item.title)}</span>
          <em>${esc(when ? when.toLocaleString(window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : item.start_at)}</em>
          <div class="rt-toast-actions">
            <button type="button" class="btn btn-primary" data-act="done">${esc(t('realtime.reminderDone'))}</button>
            <button type="button" class="btn" data-act="snooze">${esc(t('realtime.reminderSnooze'))}</button>
          </div>
        </div>
        <button type="button" class="btn-chat-action" data-act="close" aria-label="${esc(t('common.close'))}"><i class="fa-solid fa-xmark"></i></button>`;
      card.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        try {
          if (act === 'done') await window.chatStorage.saveAgenda({ done: true }, item.id);
          if (act === 'snooze') await window.chatStorage.saveAgenda({ startAt: localStamp(new Date(Date.now() + 10 * 60000)) }, item.id);
        } catch {}
        card.remove();
        this.loadAgenda();
      });
      box.appendChild(card);
      // The character comes to the reminder; when the card goes it goes back where it belongs.
      window.mascot?.stand(card);
    },

    /* -------------------------------------------------------------- */
    /* Diary                                                            */
    /* -------------------------------------------------------------- */

    /** The latest days of the diary, whole: as many as the page shows, which starts with two weeks. */
    async loadDiary() {
      this.diaryShown = this.diaryShown || DIARY_PAGE;
      try {
        [this.diary, this.diaryDays] = await Promise.all([window.chatStorage.diary(null, null, this.diaryShown), window.chatStorage.diaryCount().then(c => c.days)]);
      } catch { this.diary = []; this.diaryDays = 0; }
      this.renderSide();
      this.renderSettings();
    },

    /**
     * The diary session. Fixed steps, no model in between:
     *   1. telling   — the character says the opening line and listens; every
     *                  piece said (or written) is added to the day's account
     *                  as it is. A closing phrase ("ho finito"), or the
     *                  button, ends the account.
     *   2. questions — the questions of the list, one at a time, in order.
     *                  An answer ends with a silence (ANSWER_GAP_MS), or at
     *                  once when written; a skipping phrase, or the button,
     *                  goes to the next.
     *   3. the page  — the session is over; the Master writes the page from
     *                  the day's whole account, in the background, and the
     *                  character says so when it is done.
     * What is said is saved piece by piece: closing the app loses nothing,
     * and the page can be written later from the diary's own page.
     */
    async startDiary(day, { interrupt = true } = {}) {
      if (this.diarySession || this.working() || this.confirming) return;
      if (interrupt && (this.busy || this.player?.playing)) this.interrupt();
      const today = dayStamp(new Date());
      const session = {
        day: LOCAL_DAY.test(day || '') && day <= today ? day : today,
        step: 'telling',
        questions: await this.custom('questions'),
        index: -1,
        answered: false,   // the question asked has an answer
        told: 0,           // pieces written down
        speaking: false,
        closed: false,     // ended: what is still being written down is kept, nothing more is asked
        gap: null,
        chain: Promise.resolve()   // what is heard and asked, one thing after the other
      };
      this.diarySession = session;
      this.sideTab = 'diary';
      this.renderSide();
      this.renderControls();
      if (!this.session) await this.startSession();
      if (this.diarySession !== session) return;
      await this.say(t(session.day === today ? 'realtime.diarySayOpening' : 'realtime.diarySayOpeningDay', { day: this.dayLabel(session.day) }), { fixed: true });
    },

    diaryStepLabel(session) {
      return session.step === 'telling'
        ? t('realtime.diaryStepTelling')
        : t('realtime.diaryStepQuestion', { number: session.index + 1, total: session.questions.length });
    },

    dayLabel(day, options = { weekday: 'long', day: 'numeric', month: 'long' }) {
      const date = parseStamp(`${day}T00:00`);
      return date ? date.toLocaleDateString(window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT', options) : day;
    },

    /** The user started or stopped speaking: while they speak, and until the words are written down, no question is asked. */
    diaryVoice(session, speaking) {
      session.speaking = speaking;
      if (speaking) { clearTimeout(session.gap); session.gap = null; return; }
      if (session.step === 'questions' && session.answered) this.diaryGap(session);
    },

    /** The silence after an answer: when it has lasted long enough, the next question. */
    diaryGap(session, ms = ANSWER_GAP_MS) {
      clearTimeout(session.gap);
      session.gap = setTimeout(() => {
        session.gap = null;
        this.diaryDo(session, () => {
          if (session.speaking || !session.answered) return;
          return this.diaryAsk(session, session.index + 1);
        });
      }, ms);
    },

    /** A step of the session, run after the ones before it; an error is shown and the session goes on. */
    diaryDo(session, step) {
      session.chain = session.chain.then(step).catch(err => {
        this.lastError = t('realtime.error', { error: err.message });
        this.renderControls();
      });
      return session.chain;
    },

    /** A piece said or written during the session, handled in the order it came. */
    diaryHear(session, input) {
      session.speaking = false;
      clearTimeout(session.gap);
      session.gap = null;
      const heardAt = Date.now();
      if (input.audio && this.ui) this.ui.user.textContent = '…';
      this.diaryDo(session, async () => {
        const said = String(input.text || await this.words(input.audio, { listener: true }) || '').trim();
        if (this.ui && !session.closed) this.ui.user.textContent = said;
        if (!said) { if (!session.closed) this.setStatus(t('realtime.diaryNotHeard')); return; }
        if (session.step === 'telling') {
          const { text, done } = splitClosing(said);
          if (text) await this.diaryWrite(session, text);
          if (done) await this.diaryAsk(session, 0);
          return;
        }
        if (phrases('realtime.diarySkipWords').includes(plainWords(said))) {
          await this.diaryAsk(session, session.index + 1);
          return;
        }
        const question = session.questions[session.index];
        await this.diaryWrite(session, session.answered ? said : `${t('realtime.diaryQuestionMark')} ${question}\n${said}`);
        session.answered = true;
        if (input.text) await this.diaryAsk(session, session.index + 1);
        else if (!session.speaking && !session.closed) this.diaryGap(session, Math.max(400, ANSWER_GAP_MS - (Date.now() - heardAt)));
      });
    },

    /** Added to the day's account: the day's entry is made by the first piece. */
    async diaryWrite(session, text) {
      await window.chatStorage.saveDiary({ day: session.day, rawText: text, source: 'realtime' });
      session.told++;
      await this.loadDiary();
    },

    /** The question at `index` is asked; past the last one, the session ends and the page is written. */
    async diaryAsk(session, index) {
      if (session.closed) return;
      clearTimeout(session.gap);
      session.gap = null;
      // After the questions of the list, one about the habits followed that the account did not name.
      if (index >= session.questions.length && !session.habitsAsked) {
        session.habitsAsked = true;
        const question = await this.habitsQuestion(session);
        if (question) session.questions.push(question);
      }
      // Then one about the open goals it did not name: work done outside the app shows only if told.
      if (index >= session.questions.length && !session.goalsAsked) {
        session.goalsAsked = true;
        await this.loadGoals();
        const question = await this.goalsQuestion(session);
        if (question) session.questions.push(question);
      }
      // Not waited for: it is a step of the chain that the end waits for.
      if (index >= session.questions.length) { this.finishDiary(session); return; }
      session.step = 'questions';
      session.index = index;
      session.answered = false;
      this.renderSide();
      this.renderControls();
      await this.say(session.questions[index], { fixed: true });
    },

    /**
     * The question about the habits: the ones followed that the day's account
     * does not seem to name, in one question built from their names. Without
     * it a habit not spoken of would be a day nothing is known about. Empty
     * when there is nothing to ask.
     */
    async habitsQuestion(session) {
      const account = await this.accountOf(session.day);
      const names = this.habits.filter(h => h.status === 'tracked' && !W.named(h.name, account, W.keywordsOf(h))).map(h => h.name);
      if (!names.length) return '';
      const key = (names.length === 1 ? 'realtime.diarySayHabit' : 'realtime.diarySayHabits') + (session.day === dayStamp(new Date()) ? '' : 'Day');
      return t(key, { list: names.join(', ') });
    },

    /** What was told about a day so far. */
    async accountOf(day) {
      try { return (await window.chatStorage.diary(day, day, 1))[0]?.raw_text || ''; } catch { return ''; }
    },

    /** The session ends: the page is written from what was told, if anything was. */
    async finishDiary(session, { silent = false } = {}) {
      if (session.closed) return;
      session.closed = true;
      clearTimeout(session.gap);
      if (this.diarySession === session) this.diarySession = null;
      this.renderSide();
      this.renderControls();
      // What was being written down when the session ended is part of the account.
      await session.chain;
      if (!session.told) {
        if (!silent) await this.say(t('realtime.diarySayNothing'), { fixed: true });
        return;
      }
      const written = this.writePage(session.day);
      if (!silent) await this.say(t('realtime.diarySayWriting'), { fixed: true });
      const page = await written;
      this.tell({ say: t(page ? 'realtime.diarySayWritten' : 'realtime.diarySayFailed'), fixed: true });
    },

    /**
     * The habits as the Master is shown them when it writes a day's page: the
     * ones followed, each with a short id to name it by (ids: short id ->
     * habit); the ones proposed or turned down, not to be proposed again;
     * what was done in the two weeks before, where a habit shows.
     */
    async knownHabits(day) {
      try { this.habits = await window.chatStorage.habits(); } catch {}
      const sign = (h) => (h.sign === 'negative' ? 'negative' : 'positive');
      const followed = this.habits.filter(h => h.status === 'tracked');
      const ids = new Map(followed.map((habit, i) => [`h${i + 1}`, habit]));
      const others = this.habits.filter(h => h.status !== 'tracked');
      let earlier = [];
      try { earlier = await window.chatStorage.diary(W.shift(day, -14), W.shift(day, -1), 14); } catch {}
      const before = earlier.map(e => {
        const x = dayData(e);
        const done = (Array.isArray(x?.activities) ? x.activities : []).map(a => a?.name).filter(Boolean);
        return done.length || x?.summary ? `${e.day}: ${done.join('; ') || x.summary}` : '';
      }).filter(Boolean);
      return {
        ids,
        followed: [...ids].map(([id, h]) => `[${id}] ${h.name} (${sign(h)})${h.notes ? ` — ${h.notes}` : ''}`).join('\n') || '(none)',
        others: others.slice(-60).map(h => `${h.name} (${sign(h)})`).join('\n') || '(none)',
        before: before.join('\n') || '(no day told)'
      };
    },

    /**
     * What the Master said of the habits for a day, carried out: the day's
     * marks take the place of the ones an earlier reading gave, and what it
     * proposes waits for the user on the wellbeing page.
     */
    async applyHabits(habits, ids, day) {
      if (!habits) return;
      const list = (v) => (Array.isArray(v) ? v : []);
      const marks = list(habits.marks)
        .map(mark => ({ habitId: ids.get(String(mark?.id || ''))?.id, done: mark?.done }))
        .filter(mark => mark.habitId && typeof mark.done === 'boolean');
      try { await window.chatStorage.setDiaryMarks(day, marks); } catch {}
      for (const proposed of list(habits.propose).slice(0, 3)) {
        const name = String(proposed?.name || '').trim().slice(0, 80);
        if (!name || this.habits.some(h => plainWords(h.name) === plainWords(name))) continue;
        try {
          await window.chatStorage.saveHabit({
            name,
            sign: proposed.sign === 'negative' ? 'negative' : 'positive',
            status: 'proposed',
            notes: String(proposed.why || '').trim().slice(0, 600),
            source: 'model'
          });
        } catch {}
      }
    },

    /* -------------------------------------------------------------- */
    /* Wellbeing: how the days go, and the habits                       */
    /* -------------------------------------------------------------- */

    /** The numbers between two days: the four measures, the minutes by category, the habits followed. All worked out here. */
    async wellbeingOf(from, to) {
      const [entries, marks, habits, activity, pauses] = await Promise.all([
        window.chatStorage.diary(from, to, 400, 'data'),
        window.chatStorage.habitDays(from, to),
        window.chatStorage.habits(),
        window.chatStorage.activity(from, to).catch(() => null),
        window.chatStorage.pauses(from, to).catch(() => [])
      ]);
      const days = W.daysBetween(from, to);
      const byDay = W.dataByDay(entries);
      const work = W.activityTotals(activity, days);
      return {
        from, to, days,
        told: entries.length,
        pauses: { ...W.pausesTotals(activity, days), list: pauses.filter(p => p.ended_at).reverse().slice(0, 60) },
        measures: Object.keys(W.MEASURES).map(measure => W.series(measure, days, byDay)),
        minutes: W.minutesByCategory(days, byDay),
        work,
        // How much was done in the app on the days a measure was high and on the days it was low.
        workBy: Object.keys(W.MEASURES).map(measure => W.workByMeasure(measure, days, byDay, work.byDay)).filter(Boolean),
        habits: habits.filter(h => h.status === 'tracked').map(habit => {
          const stats = W.habitStats(habit, days, marks, byDay);
          return { habit, ...stats, work: W.workByHabit(stats.cells, work.byDay) };
        })
      };
    },

    /** What the wellbeing page and its card show: the habits, the period's numbers, the reviews. */
    async loadWellbeing() {
      const today = dayStamp(new Date());
      try {
        const [habits, wellbeing, reviews] = await Promise.all([
          window.chatStorage.habits(),
          this.wellbeingOf(W.shift(today, -(this.period - 1)), today),
          window.chatStorage.reviews(12)
        ]);
        this.habits = habits;
        this.wellbeing = wellbeing;
        this.reviews = reviews;
      } catch {
        this.wellbeing = this.wellbeing || null;
      }
      this.renderSide();
      this.renderSettings();
      // A habit followed from now on: the words that name it, and what the days already told say of it.
      this.study();
    },

    /** A period's numbers in words, for a model: what the character reads and what the review is written from. */
    wellbeingText(w) {
      const names = { mood: 'mood (1-5)', energy: 'energy (1-5)', stress: 'stress (1-5)', sleep: 'sleep (hours)' };
      const lines = [`Period: ${w.from} to ${w.to} (${w.days.length} days). Days told: ${w.told}.`];
      w.measures.forEach(m => lines.push(m.points.length
        ? `${names[m.measure]}: average ${m.average} over ${m.points.length} days; by day: ${m.points.map(p => `${p.day.slice(5)} ${p.value}`).join(', ')}`
        : `${names[m.measure]}: no day says it`));
      if (w.minutes.length) lines.push(`Minutes told by kind of activity: ${w.minutes.map(x => `${x.category} ${x.minutes}`).join(', ')}`);
      if (w.pauses?.count) lines.push(`Pauses from work taken with the app's timer: ${w.pauses.count}, on ${w.pauses.days} days, ${w.pauses.minutes} minutes in all`);
      lines.push(w.habits.length ? 'Habits followed:' : 'No habit is followed.');
      w.habits.forEach(h => {
        const compare = h.mood.withDays && h.mood.withoutDays ? `; mood ${h.mood.with} on the ${h.mood.withDays} days done, ${h.mood.without} on the ${h.mood.withoutDays} not done` : '';
        lines.push(h.known
          ? `- ${h.habit.name} (${h.habit.sign}): done ${h.done} of the ${h.known} days something is known about${h.streak ? `; current run of good days: ${h.streak}` : ''}${compare}`
          : `- ${h.habit.name} (${h.habit.sign}): no day of the period says whether it was done`);
      });
      return lines.join('\n');
    },

    /* -------------------------------------------------------------- */
    /* The side panel                                                   */
    /* -------------------------------------------------------------- */

    /**
     * The side panel: cards for what the character keeps for you — agenda,
     * diary, tasks — each with a glimpse of what is inside; a card opens its
     * page, the arrow brings the cards back. The gear opens the section's
     * settings: the character, the memories, the diary's questions and prompts.
     */
    renderSide() {
      const side = this.ui?.side;
      if (!side) return;
      // A page being changed by hand: a refresh from the background would take the words away.
      if (this.editingPage && this.sideTab === 'diary' && document.activeElement?.matches?.('.rt-page-edit')) return;
      const pages = ['agenda', 'diary', 'wellbeing', 'tasks', 'usage'];
      if (!pages.includes(this.sideTab)) this.sideTab = null;
      const page = this.sideTab;
      this.showCalendar(page === 'agenda');
      // A field of the agenda's page being filled in: what is loaded in the background does not take it away.
      if (page === 'agenda' && this.renderedPage === 'agenda' && side.contains(document.activeElement)
        && document.activeElement.matches('input:not([type="checkbox"]), textarea, select')) return;
      const sectionLabel = (s) => t('realtime.section_' + s);
      // A re-render of the same page keeps its scroll; a new page starts at the top, sliding in.
      const samePage = this.renderedPage === (page || 'home');
      const scroll = samePage ? side.scrollTop : 0;
      this.renderedPage = page || 'home';
      const room = this.ui.room;
      if (room) {
        this.ui.layout.classList.toggle('has-page', Boolean(page));
        this.ui.layout.classList.toggle('is-agenda', page === 'agenda');
        this.ui.layout.classList.toggle('has-proposals', this.proposals.length > 0);
        room.innerHTML = this.renderHome();
      }
      side.innerHTML = `
        ${this.proposals.length ? `<section class="rt-card rt-proposals">
          <h3>${esc(t('realtime.proposalsTitle'))}</h3>
          ${this.proposals.map(p => `
            <div class="rt-proposal" data-proposal="${esc(p.id)}">
              <span class="rt-proposal-section">${esc(sectionLabel(p.section))}</span>
              <p>${esc(p.content)}</p>
              <div class="rt-proposal-actions">
                <button type="button" class="btn btn-primary" data-action="save-proposal">${esc(t('realtime.proposalSave'))}</button>
                <button type="button" class="btn" data-action="drop-proposal">${esc(t('realtime.proposalDrop'))}</button>
              </div>
            </div>`).join('')}
        </section>` : ''}
        <header class="rt-side-head">
          ${page
            ? `<button type="button" class="rt-back" data-side-home aria-label="${esc(t('realtime.back'))}" title="${esc(t('realtime.back'))}"><i class="fa-solid fa-chevron-left"></i></button>
               <h2>${esc(t('realtime.tab_' + page))}</h2>`
            : `<h2>${esc(t('realtime.sideTitle', { name: this.displayName() }))}</h2>`}
          <button type="button" class="rt-settings-btn" data-action="open-settings" aria-label="${esc(t('realtime.settingsTitle'))}" title="${esc(t('realtime.settingsTitle'))}"><i class="fa-solid fa-gear"></i></button>
        </header>
        <div class="rt-side-body ${page ? 'is-page' : 'is-home'}${samePage ? '' : ' is-entering'}">${page ? this.renderSideTab(page, sectionLabel) : room ? '' : this.renderHome()}</div>`;
      side.scrollTop = scroll;
      const kind = side.querySelector('.rt-agenda-kind');
      if (kind) side.querySelector('.rt-agenda-end-wrap').hidden = kind.value !== 'activity';
    },

    /** The cards, each with a glimpse of its page. */
    renderHome() {
      const now = new Date();
      const today = dayStamp(now);
      const nowStamp = localStamp(now);
      const open = (this.agenda || []).filter(i => !i.done);
      const todays = open.filter(i => i.start_at.slice(0, 10) === today || (i.kind === 'reminder' && i.start_at < nowStamp));
      const next = open.filter(i => i.start_at >= nowStamp || (i.end_at && i.end_at >= nowStamp)).sort((a, b) => a.start_at.localeCompare(b.start_at))[0];
      const locale = window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT';
      const when = (stamp) => {
        const day = stamp.slice(0, 10);
        const label = day === today ? '' : day === dayStamp(addDays(now, 1)) ? t('realtime.agendaTomorrow') + ' ' : parseStamp(stamp).toLocaleDateString(locale, { weekday: 'short', day: 'numeric' }) + ' ';
        return label + stamp.slice(11, 16);
      };
      const lastDay = (this.diary || [])[0];
      const dayName = (day) => day === today ? t('realtime.agendaToday') : day === dayStamp(addDays(now, -1)) ? t('realtime.yesterday') : parseStamp(day + 'T00:00').toLocaleDateString(locale, { day: 'numeric', month: 'short' });
      const running = this.tasks.filter(task => task.status === 'running' || task.status === 'waiting').length;
      const mood = this.wellbeing?.measures.find(m => m.measure === 'mood');
      const followed = this.habits.filter(h => h.status === 'tracked').length;
      const proposed = this.habits.filter(h => h.status === 'proposed').length + (this.likedPauses || []).filter(p => p.status === 'proposed').length;
      const diaryLine = this.diarySession ? this.diaryStepLabel(this.diarySession)
        : lastDay && this.writing.has(lastDay.day) ? t('realtime.diaryWriting')
        : lastDay ? (lastDay.page_text || lastDay.raw_text).replace(/\s+/g, ' ').slice(0, 120)
        : t('realtime.diaryStart');
      const card = this.ui.room ? (id, icon, big, small, extra = '') => this.roomObject(id, big, small, extra.replace(' is-wide', '')) : (id, icon, big, small, extra = '') => `
        <button type="button" class="rt-home-card rt-home-${id}${extra}" data-side-tab="${id}">
          <span class="rt-home-icon"><i class="fa-solid ${icon}" aria-hidden="true"></i></span>
          <span class="rt-home-title">${esc(t('realtime.tab_' + id))}</span>
          <span class="rt-home-big">${big}</span>
          <span class="rt-home-small">${small}</span>
        </button>`;
      return `${this.ui.room ? '' : '<div class="rt-home-grid">'}
        ${card('agenda', 'fa-calendar-days',
          esc(String(todays.length)) + `<small>${esc(t('realtime.homeToday'))}</small>`,
          next ? `<b>${esc(when(next.start_at))}</b> ${esc(next.title)}` : esc(t('realtime.homeNothingNext')))}
        ${card('diary', 'fa-book',
          lastDay ? esc(dayName(lastDay.day)) : '—',
          esc(diaryLine),
          this.diarySession || this.writing.size ? ' is-live' : '')}
        ${card('wellbeing', 'fa-heart-pulse',
          mood?.average !== null && mood?.average !== undefined ? esc(this.figure(mood.average)) + `<small>${esc(t('realtime.homeMood', { days: this.period }))}</small>` : '—',
          esc([
            t(followed === 1 ? 'realtime.homeHabit' : 'realtime.homeHabits', { count: followed }),
            proposed ? t(proposed === 1 ? 'realtime.homeProposal' : 'realtime.homeProposals', { count: proposed }) : ''
          ].filter(Boolean).join(' · ')),
          this.reviewing ? ' is-live' : '')}
        ${card('tasks', running ? 'fa-gear fa-spin' : 'fa-gears',
          running ? esc(String(running)) + `<small>${esc(t('realtime.homeRunning'))}</small>` : esc(String(this.tasks.length)),
          this.tasks[0] ? esc(this.tasks[0].text) : esc(t('realtime.homeTasksEmpty')),
          running ? ' is-live' : '')}
        ${(() => { const u = this.usageHome(); return card('usage', 'fa-coins', u.big, u.small, ' is-wide' + (u.live ? ' is-live' : '')); })()}
      ${this.ui.room ? '' : '</div>'}`;
    },

    /** A number as it is written in the app's language, with one decimal at most. */
    figure(value, digits = 1) {
      return Number(value).toLocaleString(window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT', { maximumFractionDigits: digits });
    },

    renderSideTab(tab) {
      if (tab === 'agenda') return this.renderAgendaTab();
      if (tab === 'diary') return this.renderDiaryTab();
      if (tab === 'wellbeing') return this.renderWellbeingTab();
      if (tab === 'usage') return this.renderUsageTab();
      if (tab === 'tasks') {
        return `<section class="rt-card">
          ${this.tasks.length ? `<ul class="rt-list">${this.tasks.slice(0, 20).map(task => `
            <li class="rt-task is-${task.status}">
              <i class="fa-solid ${{ running: 'fa-gear fa-spin', waiting: 'fa-hourglass-half', done: 'fa-circle-check', stopped: 'fa-circle-stop' }[task.status] || 'fa-triangle-exclamation'}" title="${esc(t('realtime.task_' + task.status))}"></i>
              <span>${esc(task.text.length > 160 ? task.text.slice(0, 159) + '…' : task.text)}</span>
            </li>`).join('')}</ul>` : `<p class="rt-hint">${esc(t('realtime.tasksEmpty'))}</p>`}
          <button type="button" class="btn rt-open-tasks"><i class="fa-solid fa-comments"></i> ${esc(t('realtime.openTasks'))}</button>
        </section>`;
      }
      return '';
    },

    /**
     * One measure over the period, as a small line chart: a 2px line through
     * the days that have a value, a dot on each when they are few, the last
     * value written at the line's end. The points ride in data-points for
     * the hover readout; every value is in the table below the charts too.
     */
    renderChart(series, days) {
      const width = 300, height = 100, left = 20, right = 32, top = 8, bottom = 22;
      const max = series.measure === 'sleep' ? Math.max(10, ...series.points.map(p => p.value)) : series.max;
      const min = series.min;
      const x = (index) => left + (days.length > 1 ? index / (days.length - 1) : 0.5) * (width - left - right);
      const y = (value) => top + (1 - (value - min) / (max - min)) * (height - top - bottom);
      const ticks = [min, (min + max) / 2, max];
      const points = series.points.map(p => ({ x: Math.round(x(p.index) * 10) / 10, y: Math.round(y(p.value) * 10) / 10, day: p.day, value: p.value }));
      const last = points[points.length - 1];
      const label = t('realtime.measure_' + series.measure);
      return `<div class="rt-chart" data-points="${esc(JSON.stringify(points))}" data-unit="${series.measure === 'sleep' ? 'h' : ''}">
        <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(t('realtime.chartLabel', { measure: label, days: days.length }))}">
          ${ticks.map(tick => `<line class="rt-chart-grid" x1="${left}" x2="${width - right}" y1="${y(tick)}" y2="${y(tick)}"/>
            <text class="rt-chart-tick" x="${left - 5}" y="${y(tick) + 3}" text-anchor="end">${esc(this.figure(tick))}</text>`).join('')}
          <text class="rt-chart-tick" x="${left}" y="${height - 4}">${esc(this.dayLabel(days[0], { day: 'numeric', month: 'short' }))}</text>
          <text class="rt-chart-tick" x="${width - right}" y="${height - 4}" text-anchor="end">${esc(this.dayLabel(days[days.length - 1], { day: 'numeric', month: 'short' }))}</text>
          <line class="rt-chart-cross" x1="0" x2="0" y1="${top}" y2="${height - bottom}" hidden/>
          ${points.length > 1 ? `<polyline class="rt-chart-line" points="${points.map(p => `${p.x},${p.y}`).join(' ')}"/>` : ''}
          ${points.length <= 31 ? points.slice(0, -1).map(p => `<circle class="rt-chart-dot" cx="${p.x}" cy="${p.y}" r="3"/>`).join('') : ''}
          ${last ? `<circle class="rt-chart-dot is-last" cx="${last.x}" cy="${last.y}" r="4"/>
            <text class="rt-chart-value" x="${last.x + 8}" y="${last.y + 4}">${esc(this.figure(last.value))}</text>` : ''}
        </svg>
        <div class="rt-chart-tip" role="status" hidden></div>
      </div>`;
    },

    /**
     * Wellbeing: the period, what the Master proposes to follow, how mood,
     * energy, stress and sleep went, the habits day by day, and the review of
     * the week. The numbers come from the days told; a day not told is not a
     * zero.
     */
    renderWellbeingTab() {
      const w = this.wellbeing;
      const today = dayStamp(new Date());
      const periods = `<div class="rt-periods" role="group" aria-label="${esc(t('realtime.periodLabel'))}">
        ${PERIODS.map(p => `<button type="button" class="rt-period${p === this.period ? ' is-on' : ''}" data-action="period" data-period="${p}" aria-pressed="${p === this.period}">${esc(t('realtime.periodDays', { days: p }))}</button>`).join('')}
      </div>`;
      const signBadge = (sign) => `<span class="rt-sign rt-sign-${sign}"><i class="fa-solid ${sign === 'negative' ? 'fa-circle-minus' : 'fa-circle-plus'}"></i> ${esc(t('realtime.sign_' + sign))}</span>`;
      const proposals = this.habits.filter(h => h.status === 'proposed').map(h => `
        <div class="rt-proposal" data-habit="${esc(h.id)}">
          <span class="rt-proposal-section">${esc(t('realtime.habitProposed'))}</span>
          <p><b>${esc(h.name)}</b> ${signBadge(h.sign)}</p>
          ${h.notes ? `<p class="rt-hint">${esc(h.notes)}</p>` : ''}
          <div class="rt-proposal-actions">
            <button type="button" class="btn btn-primary" data-action="habit-follow">${esc(t('realtime.habitFollow'))}</button>
            <button type="button" class="btn" data-action="habit-sign">${esc(t(h.sign === 'negative' ? 'realtime.habitMakePositive' : 'realtime.habitMakeNegative'))}</button>
            <button type="button" class="btn" data-action="habit-dismiss">${esc(t('realtime.habitDismiss'))}</button>
          </div>
        </div>`).join('') + (this.likedPauses || []).filter(p => p.status === 'proposed').map(p => `
        <div class="rt-proposal" data-pause="${esc(p.id)}">
          <span class="rt-proposal-section">${esc(t('realtime.pauseProposed'))}</span>
          <p><b>${esc(p.name)}</b> <span class="rt-hint">${esc(this.timeText(p.minutes))}</span></p>
          ${p.why ? `<p class="rt-hint">«${esc(p.why)}»</p>` : ''}
          <div class="rt-proposal-actions">
            <button type="button" class="btn btn-primary" data-action="pause-like">${esc(t('realtime.pauseLike'))}</button>
            <button type="button" class="btn" data-action="pause-dismiss">${esc(t('realtime.habitDismiss'))}</button>
          </div>
        </div>`).join('');
      if (!w) return `<section class="rt-card">${periods}<p class="rt-hint">${esc(t('realtime.wellLoading'))}</p></section>`;
      const liked = (this.likedPauses || []).filter(p => p.status === 'liked');
      const pauseRows = (w.pauses?.list || []).map(p => `<tr>
          <th>${esc(new Date(p.started_at).toLocaleString(window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</th>
          <td>${esc(p.what || '—')}</td><td>${p.lasted}</td>
          <td><button type="button" class="btn-chat-action" data-action="pause-remove" data-id="${esc(p.id)}" title="${esc(t('realtime.pauseRemove'))}" aria-label="${esc(t('realtime.pauseRemove'))}"><i class="fa-solid fa-trash-can"></i></button></td>
        </tr>`).join('');
      const pauses = `<section class="rt-card">
          <h3>${esc(t('realtime.pausesCard'))}</h3>
          ${w.pauses?.count
            ? `<p class="rt-hint">${esc(t(w.pauses.count === 1 ? 'realtime.pausesTaken1' : 'realtime.pausesTaken', { count: w.pauses.count, days: w.pauses.days, time: this.timeText(w.pauses.minutes) }))}</p>
              <details class="rt-table"><summary>${esc(t('realtime.tableView'))}</summary>
                <table>
                  <thead><tr><th>${esc(t('realtime.pausesWhen'))}</th><th>${esc(t('realtime.pausesCount'))}</th><th>${esc(t('realtime.pausesMinutes'))}</th><th></th></tr></thead>
                  <tbody>${pauseRows}</tbody>
                </table></details>`
            : `<p class="rt-hint">${esc(t('realtime.pausesNone'))}</p>`}
          <p class="rt-hint">${esc(liked.length ? t('realtime.pausesLikedList', { list: liked.map(p => p.name).join(', ') }) : t('realtime.pausesLikedNone'))}</p>
          <div class="rt-row">
            ${this.pause ? '' : `<button type="button" class="btn" data-action="pause-now"><i class="fa-solid fa-mug-hot"></i> ${esc(t('realtime.pauseNow'))}</button>`}
            <button type="button" class="btn" data-action="open-notices"><i class="fa-solid fa-bell"></i> ${esc(t('realtime.noticesManage'))}</button>
          </div>
        </section>`;

      const tiles = w.measures.map(m => {
        const label = t('realtime.measure_' + m.measure);
        if (!m.points.length) return `<div class="rt-tile"><span class="rt-tile-label">${esc(label)}</span><p class="rt-hint">${esc(t('realtime.measureNone'))}</p></div>`;
        const change = m.change ? `<span class="rt-tile-change">${esc(t(m.change > 0 ? 'realtime.changeUp' : 'realtime.changeDown', { value: this.figure(Math.abs(m.change)) }))}</span>` : '';
        return `<div class="rt-tile">
          <span class="rt-tile-label">${esc(label)}</span>
          <div class="rt-tile-head">
            <span class="rt-tile-value">${esc(this.figure(m.average))}<small>${esc(m.measure === 'sleep' ? t('realtime.unitHours') : t('realtime.unitOfFive'))}</small></span>
            <span class="rt-hint">${esc(t(m.points.length === 1 ? 'realtime.averageDay' : 'realtime.averageDays', { days: m.points.length }))}</span>
          </div>
          ${change}
          ${this.renderChart(m, w.days)}
        </div>`;
      }).join('');
      const values = new Map();
      w.measures.forEach(m => m.points.forEach(p => { if (!values.has(p.day)) values.set(p.day, {}); values.get(p.day)[m.measure] = p.value; }));
      const cell = (v) => (v === undefined ? '—' : esc(this.figure(v)));
      const table = values.size ? `<details class="rt-table"><summary>${esc(t('realtime.tableView'))}</summary>
        <table>
          <thead><tr><th>${esc(t('realtime.tableDay'))}</th>${w.measures.map(m => `<th>${esc(t('realtime.measure_' + m.measure))}</th>`).join('')}</tr></thead>
          <tbody>${[...values.keys()].sort().reverse().map(day => `<tr><th>${esc(this.dayLabel(day, { day: 'numeric', month: 'short' }))}</th>${w.measures.map(m => `<td>${cell(values.get(day)[m.measure])}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></details>` : '';
      const minutes = w.minutes.length ? `<p class="rt-hint">${esc(t('realtime.minutesTold'))} ${w.minutes.map(x => `${esc(t('realtime.category_' + (CATEGORIES.includes(x.category) ? x.category : 'other')))} ${esc(this.figure(x.minutes))}′`).join(' · ')}</p>` : '';

      const state = (done) => (done === null ? 'unknown' : done ? 'done' : 'missed');
      const habits = w.habits.map(h => {
        const compare = h.mood.withDays >= 2 && h.mood.withoutDays >= 2
          ? `<p class="rt-hint">${esc(t('realtime.habitCompare', { with: this.figure(h.mood.with), withDays: h.mood.withDays, without: this.figure(h.mood.without), withoutDays: h.mood.withoutDays }))}</p>` : '';
        const run = h.streak ? ` · ${t((h.habit.sign === 'negative' ? 'realtime.habitRunWithout' : 'realtime.habitRun') + (h.streak === 1 ? 'Day' : ''), { days: h.streak })}` : '';
        return `<li class="rt-habit rt-habit-${h.habit.sign}">
          <div class="rt-diary-head"><strong>${esc(h.habit.name)}</strong>${signBadge(h.habit.sign)}</div>
          <p class="rt-hint">${esc(h.known ? t('realtime.habitCount', { done: h.done, known: h.known }) + run : t('realtime.habitNoDays'))}</p>
          <div class="rt-cells">${'<i class="rt-cell-gap"></i>'.repeat((parseStamp(h.cells[0].day + 'T00:00').getDay() + 6) % 7)}${h.cells.map(c => {
            const label = `${this.dayLabel(c.day, { weekday: 'short', day: 'numeric', month: 'short' })}: ${t('realtime.cell_' + state(c.done))}`;
            return `<button type="button" class="rt-cell is-${state(c.done)}${c.day === today ? ' is-today' : ''}" data-action="habit-cell" data-habit="${esc(h.habit.id)}" data-day="${c.day}" data-state="${state(c.done)}" title="${esc(label)}" aria-label="${esc(label)}"></button>`;
          }).join('')}</div>
          ${compare}
          ${h.work ? `<p class="rt-hint">${esc(t('realtime.habitWork', { with: this.figure(h.work.with), withDays: h.work.withDays, without: this.figure(h.work.without), withoutDays: h.work.withoutDays }))}</p>` : ''}
        </li>`;
      }).join('');
      const legend = w.habits.length ? `<p class="rt-cell-legend rt-hint">
          <span><i class="rt-cell is-done"></i> ${esc(t('realtime.cell_done'))}</span>
          <span><i class="rt-cell is-missed"></i> ${esc(t('realtime.cell_missed'))}</span>
          <span><i class="rt-cell is-unknown"></i> ${esc(t('realtime.cell_unknown'))}</span>
          <span>${esc(t('realtime.cellHint'))}</span>
        </p>` : '';

      const review = this.reviews[0];
      const range = (r) => `${this.dayLabel(r.from_day, { day: 'numeric', month: 'short' })} – ${this.dayLabel(r.to_day, { day: 'numeric', month: 'short' })}`;
      const older = this.reviews.slice(1).map(r => `<details><summary>${esc(range(r))}</summary><p class="rt-diary-raw">${esc(r.text)}</p></details>`).join('');
      return `
        ${periods}
        ${proposals ? `<section class="rt-card rt-proposals">${proposals}</section>` : ''}
        <section class="rt-card">
          <h3>${esc(t('realtime.trendTitle'))}</h3>
          <p class="rt-hint">${esc(t('realtime.trendHint', { told: w.told, days: w.days.length }))}</p>
          <div class="rt-tiles">${tiles}</div>
          ${minutes}
          ${table}
        </section>
        <section class="rt-card">
          <h3>${esc(t('realtime.linkTitle'))}</h3>
          <p class="rt-hint">${esc(t('realtime.linkHint'))}</p>
          ${w.workBy.length ? `<table class="rt-link">
            <thead><tr><th></th><th>${esc(t('realtime.linkHigh'))}</th><th>${esc(t('realtime.linkLow'))}</th></tr></thead>
            <tbody>${w.workBy.map(x => `<tr><th>${esc(t('realtime.measure_' + x.measure))} <small>${esc(t('realtime.linkSplit', { value: this.figure(x.median) }))}</small></th>
              <td><b>${esc(this.figure(x.high))}</b> <small>${esc(t('realtime.linkDays', { days: x.highDays }))}</small></td>
              <td><b>${esc(this.figure(x.low))}</b> <small>${esc(t('realtime.linkDays', { days: x.lowDays }))}</small></td></tr>`).join('')}</tbody>
          </table>` : `<p class="rt-hint">${esc(t('realtime.linkNone'))}</p>`}
        </section>
        <section class="rt-card">
          <h3>${esc(t('realtime.habitsTitle'))}</h3>
          ${habits ? `<ul class="rt-list rt-habit-list">${habits}</ul>${legend}` : `<p class="rt-hint">${esc(t('realtime.habitsEmpty'))}</p>`}
          <button type="button" class="btn" data-action="open-habits"><i class="fa-solid fa-list-check"></i> ${esc(t('realtime.habitsManage'))}</button>
        </section>
        ${pauses}
        <section class="rt-card">
          <h3>${esc(t('realtime.reviewTitle'))}</h3>
          ${this.reviewing ? `<p class="rt-hint"><i class="fa-solid fa-pen-nib fa-fade"></i> ${esc(t('realtime.reviewWriting'))}</p>`
            : review ? `<p class="rt-hint">${esc(range(review))}</p><div class="rt-page">${review.text.split(/\n\s*\n/).map(p => `<p>${esc(p.trim())}</p>`).join('')}</div>`
            : `<p class="rt-hint">${esc(t('realtime.reviewEmpty'))}</p>`}
          ${this.reviewError ? `<p class="rt-hint">${esc(t('realtime.reviewFailed', { error: this.reviewError }))}</p>` : ''}
          <div class="rt-row">
            ${review && !this.reviewing ? `<button type="button" class="btn" data-action="review-read"><i class="fa-solid fa-volume-high"></i> ${esc(t('realtime.diaryRead'))}</button>` : ''}
            ${this.reviewing ? '' : `<button type="button" class="btn" data-action="review-write"><i class="fa-solid fa-pen-nib"></i> ${esc(t(review ? 'realtime.reviewAgain' : 'realtime.reviewWrite'))}</button>`}
          </div>
          ${older}
        </section>`;
    },

    /** The readout of a chart: a hairline on the day nearest to the pointer, and that day's value. */
    onChartMove(e) {
      const chart = e.target.closest?.('.rt-chart');
      this.ui.side.querySelectorAll('.rt-chart').forEach(other => {
        if (other === chart) return;
        other.querySelector('.rt-chart-tip').hidden = true;
        other.querySelector('.rt-chart-cross').setAttribute('hidden', '');
      });
      if (!chart || e.type === 'pointerleave') return;
      let points = [];
      try { points = JSON.parse(chart.dataset.points || '[]'); } catch {}
      const tip = chart.querySelector('.rt-chart-tip');
      const cross = chart.querySelector('.rt-chart-cross');
      if (!points.length) return;
      const svg = chart.querySelector('svg');
      const box = svg.getBoundingClientRect();
      const scale = box.width / svg.viewBox.baseVal.width;
      const at = (e.clientX - box.left) / scale;
      const near = points.reduce((a, b) => (Math.abs(b.x - at) < Math.abs(a.x - at) ? b : a));
      cross.setAttribute('x1', near.x);
      cross.setAttribute('x2', near.x);
      cross.removeAttribute('hidden');
      tip.replaceChildren();
      const value = document.createElement('strong');
      value.textContent = `${this.figure(near.value)}${chart.dataset.unit ? ' ' + chart.dataset.unit : ''}`;
      const day = document.createElement('span');
      day.textContent = this.dayLabel(near.day, { weekday: 'short', day: 'numeric', month: 'short' });
      tip.append(value, day);
      tip.hidden = false;
      const x = near.x * scale;
      tip.style.left = `${Math.min(Math.max(x, 40), box.width - 40)}px`;
    },

    /** The diary: the session under way or the button that starts one, then the pages, the latest first. */
    renderDiaryTab() {
      const today = dayStamp(new Date());
      const session = this.diarySession;
      const icon = (name, action, day, label) => `<button type="button" class="btn-chat-action" data-action="${action}" data-day="${esc(day)}" title="${esc(label)}" aria-label="${esc(label)}"><i class="fa-solid ${name}"></i></button>`;
      const pages = (this.diary || []).map(e => {
        const writing = this.writing.has(e.day);
        const error = this.pageErrors.get(e.day);
        let body;
        if (this.editingPage === e.day) {
          body = `<textarea class="rt-page-edit" rows="12" maxlength="50000">${esc(e.page_text || '')}</textarea>
            <div class="rt-row">
              <button type="button" class="btn btn-primary" data-action="page-save" data-day="${esc(e.day)}">${esc(t('realtime.save'))}</button>
              <button type="button" class="btn" data-action="page-cancel">${esc(t('realtime.cancel'))}</button>
            </div>`;
        } else if (writing) {
          body = `<p class="rt-hint"><i class="fa-solid fa-pen-nib fa-fade"></i> ${esc(t('realtime.diaryWriting'))}</p>`;
        } else if (e.page_text) {
          body = `<div class="rt-page">${e.page_text.split(/\n\s*\n/).map(p => `<p>${esc(p.trim())}</p>`).join('')}</div>`;
        } else {
          body = `<p class="rt-hint">${esc(error ? t('realtime.diaryPageFailed', { error }) : t('realtime.diaryNoPage'))}</p>
            <button type="button" class="btn btn-primary" data-action="page-write" data-day="${esc(e.day)}"><i class="fa-solid fa-pen-nib"></i> ${esc(t('realtime.diaryWrite'))}</button>`;
        }
        const tools = e.page_text && !writing && this.editingPage !== e.day
          ? icon('fa-volume-high', 'page-read', e.day, t('realtime.diaryRead')) + icon('fa-pen', 'page-edit', e.day, t('realtime.diaryEdit')) + icon('fa-rotate', 'page-write', e.day, t('realtime.diaryRewrite'))
          : '';
        return `<li class="rt-diary-entry">
          <div class="rt-diary-head">
            <strong>${esc(this.dayLabel(e.day))}</strong>
            ${tools}
            ${writing ? '' : `<button type="button" class="btn-chat-action" data-action="diary-delete" data-id="${esc(e.id)}" title="${esc(t('realtime.diaryDelete'))}" aria-label="${esc(t('realtime.diaryDelete'))}"><i class="fa-solid fa-xmark"></i></button>`}
          </div>
          ${body}
          ${e.page_text && error && !writing ? `<p class="rt-hint">${esc(t('realtime.diaryPageFailed', { error }))}</p>` : ''}
          <details><summary>${esc(t('realtime.diaryRaw'))}</summary><p class="rt-diary-raw">${esc(e.raw_text)}</p></details>
        </li>`;
      }).join('');
      const live = session ? `<div class="rt-diary-live">
          <strong>${esc(this.diaryStepLabel(session))} · ${esc(this.dayLabel(session.day, { day: 'numeric', month: 'long' }))}</strong>
          <p>${esc(session.step === 'telling' ? t('realtime.diaryTellingHint') : session.questions[session.index])}</p>
          <div class="rt-row">
            ${session.step === 'telling'
              ? `<button type="button" class="btn btn-primary" data-action="diary-next">${esc(t(session.questions.length ? 'realtime.diaryToQuestions' : 'realtime.diaryFinish'))}</button>`
              : `<button type="button" class="btn" data-action="diary-next">${esc(t('realtime.diarySkip'))}</button>
                 <button type="button" class="btn btn-primary" data-action="diary-finish">${esc(t('realtime.diaryFinish'))}</button>`}
          </div>
        </div>` : `<div class="rt-row">
          <input type="date" class="rt-diary-day" max="${today}" value="${esc(this.diaryDay || today)}" aria-label="${esc(t('realtime.diaryDayLabel'))}" title="${esc(t('realtime.diaryDayLabel'))}">
          <button type="button" class="btn btn-primary" data-action="diary-start"><i class="fa-solid fa-book-open"></i> ${esc(t('realtime.diaryStart'))}</button>
        </div>`;
      return `<section class="rt-card">
        <p class="rt-hint">${esc(t('realtime.diaryHint', { name: this.displayName() }))}</p>
        ${live}
        ${pages ? `<ul class="rt-list rt-diary-list">${pages}</ul>` : `<p class="rt-hint">${esc(t('realtime.diaryEmpty'))}</p>`}
        ${(this.diaryDays || 0) > this.diary.length ? `<button type="button" class="btn" data-action="diary-more">${esc(t('realtime.diaryMore', { shown: this.diary.length, days: this.diaryDays }))}</button>` : ''}
        ${pages ? `<button type="button" class="btn btn-danger-outline rt-diary-clear">${esc(t('realtime.diaryClear'))}</button>` : ''}
      </section>`;
    },

    async onSideClick(e) {
      // What opens something in the section: the character hops onto it, and it opens as it lands.
      const opener = e.target.closest('[data-side-home], [data-side-tab], [data-action="open-settings"], [data-action="open-habits"], [data-action="open-notices"]');
      // Where the thing pressed is, before anything moves: its page grows from there.
      const pressed = this.ui.room ? e.target.closest('.rt-room-object')?.querySelector('.rt-room-svg')?.getBoundingClientRect() : null;
      if (opener && window.mascot?.ready) {
        if (this.opening) return;
        this.opening = true;
        try { await window.mascot.stand(opener, { quick: true }); } finally { this.opening = false; }
        setTimeout(() => { if (window.mascot.heading?.el === opener) window.mascot.home(); }, 420);
      }
      if (e.target.closest('[data-side-home]')) {
        this.sideTab = null;
        this.renderSide();
        return;
      }
      const tabBtn = e.target.closest('[data-side-tab]');
      if (tabBtn) {
        this.sideTab = tabBtn.dataset.sideTab;
        this.editingPage = null;
        if (this.sideTab === 'agenda') { this.loadAgenda(); this.loadCalendar(); }
        if (this.sideTab === 'diary') this.loadDiary();
        if (this.sideTab === 'wellbeing') this.loadWellbeing();
        if (this.sideTab === 'usage') this.loadCosts();
        this.renderSide();
        if (pressed) this.growFrom(this.sideTab === 'agenda' ? this.ui.calendar : this.ui.side, pressed);
        return;
      }
      const target = e.target.closest('button, input[type="checkbox"]');
      if (!target) return;
      if (this.sideTab === 'agenda' && await this.onAgendaClick(e)) return;
      if (this.sideTab === 'usage' && await this.onUsageClick(e)) return;
      const action = target.dataset.action;
      const day = target.dataset.day;
      try {
        if (action === 'open-settings') {
          this.openSettings();
          return;
        }
        if (action === 'open-habits') {
          this.openSettings('wellbeing');
          return;
        }
        if (action === 'open-notices') {
          this.openSettings('notices');
          return;
        }
        // A pause the Master found in the user's words: one of the liked ones from now on, or turned down for good.
        if (action === 'pause-like' || action === 'pause-dismiss') {
          await window.chatStorage.saveLikedPause({ status: action === 'pause-like' ? 'liked' : 'dismissed' }, target.closest('[data-pause]').dataset.pause);
          await this.loadNotices();
          this.renderSide();
          return;
        }
        // A pause recorded by mistake.
        if (action === 'pause-remove') {
          await window.chatStorage.deletePause(target.dataset.id);
          await this.loadWellbeing();
          return;
        }
        // A pause taken without being asked: the same timer, the same record.
        if (action === 'pause-now') {
          await this.startPause(this.nextPause());
          this.renderSide();
          return;
        }
        if (action === 'period') {
          this.period = PERIODS.find(p => p === Number(target.dataset.period)) || 30;
          window.chatStorage.setSetting('realtime_wellbeing_period', String(this.period)).catch(() => {});
          await this.loadWellbeing();
          return;
        }
        // A proposal of the Master: followed, given the other sign, or turned down for good.
        const proposed = target.closest('[data-habit]')?.dataset.habit;
        if (action === 'habit-follow' || action === 'habit-dismiss' || action === 'habit-sign') {
          const habit = this.habits.find(h => h.id === proposed);
          if (!habit) return;
          await window.chatStorage.saveHabit(
            action === 'habit-sign' ? { sign: habit.sign === 'negative' ? 'positive' : 'negative' }
              : { status: action === 'habit-follow' ? 'tracked' : 'dismissed' },
            habit.id);
          await this.loadWellbeing();
          return;
        }
        // A day of a habit set by hand: not known, done, not done, and round again.
        if (action === 'habit-cell') {
          const next = { unknown: true, done: false, missed: null }[target.dataset.state];
          await window.chatStorage.markHabit(target.dataset.habit, target.dataset.day, next);
          await this.loadWellbeing();
          return;
        }
        if (action === 'review-read') {
          if (this.reviews[0] && !this.diarySession) {
            if (this.busy || this.player?.playing) this.interrupt();
            this.say(this.reviews[0].text);
          }
          return;
        }
        if (action === 'review-write') {
          this.weeklyReview({ manual: true });
          return;
        }
        if (action === 'diary-more') {
          this.diaryShown = (this.diaryShown || DIARY_PAGE) + DIARY_PAGE;
          await this.loadDiary();
          return;
        }
        if (action === 'diary-start') {
          this.startDiary(this.diaryDay);
          return;
        }
        // The button does what the closing or the skipping phrase does, after what is being written down.
        if (action === 'diary-next' && this.diarySession) {
          const session = this.diarySession;
          if (this.busy || this.player?.playing) this.interrupt();
          this.diaryDo(session, () => this.diaryAsk(session, session.index + 1));
          return;
        }
        if (action === 'diary-finish' && this.diarySession) {
          if (this.busy || this.player?.playing) this.interrupt();
          this.finishDiary(this.diarySession);
          return;
        }
        if (action === 'page-write') {
          const written = this.diary.find(entry => entry.day === day)?.page_text;
          if (written) {
            const ok = await window.chatWorkspace.confirmAction({
              title: t('realtime.diaryRewriteTitle'),
              message: t('realtime.diaryRewriteMessage'),
              confirmText: t('realtime.diaryRewrite')
            });
            if (!ok) return;
          }
          this.writePage(day);
          return;
        }
        if (action === 'page-read') {
          const page = this.diary.find(entry => entry.day === day)?.page_text;
          if (page && !this.diarySession) {
            if (this.busy || this.player?.playing) this.interrupt();
            this.say(page);
          }
          return;
        }
        if (action === 'page-edit') {
          this.editingPage = day;
          this.renderSide();
          this.ui.side.querySelector('.rt-page-edit')?.focus();
          return;
        }
        if (action === 'page-cancel') {
          this.editingPage = null;
          this.renderSide();
          return;
        }
        if (action === 'page-save') {
          const entry = this.diary.find(x => x.day === day);
          const page = this.ui.side.querySelector('.rt-page-edit')?.value || '';
          this.editingPage = null;
          if (entry) await window.chatStorage.saveDiary({ pageText: page }, entry.id);
          await this.loadDiary();
          return;
        }
        if (target.dataset.action === 'diary-delete') {
          const entry = this.diary.find(x => x.id === target.dataset.id);
          const ok = await window.chatWorkspace.confirmAction({
            title: t('realtime.diaryDeleteTitle'),
            message: t('realtime.diaryDeleteMessage', { day: entry ? this.dayLabel(entry.day) : '' }),
            confirmText: t('realtime.diaryDelete')
          });
          if (!ok) return;
          await window.chatStorage.deleteDiary(target.dataset.id);
          if (entry) this.pageErrors.delete(entry.day);
          this.editingPage = null;
          await this.loadDiary();
          return;
        }
        if (target.classList.contains('rt-diary-clear')) {
          const ok = await window.chatWorkspace.confirmAction({
            title: t('realtime.diaryClearTitle'),
            message: t('realtime.diaryClearMessage'),
            confirmText: t('realtime.diaryClear')
          });
          if (!ok) return;
          await window.chatStorage.deleteAllDiary();
          this.pageErrors.clear();
          this.editingPage = null;
          await this.loadDiary();
          return;
        }
        if (target.classList.contains('rt-open-tasks')) {
          const id = this.tasksConversationId || (await window.chatStorage.realtime()).tasksConversationId;
          window.switchView?.('chat');
          await window.chatManager.selectConversation(id);
          await window.chatWorkspace?.refresh?.();
          return;
        }
        const card = target.closest('[data-proposal]');
        if (card) {
          const proposal = this.proposals.find(p => p.id === card.dataset.proposal);
          if (proposal && target.dataset.action === 'save-proposal') {
            await window.chatStorage.saveMemory({ content: proposal.content, scope: 'global', section: proposal.section, pinned: true });
          }
          this.proposals = this.proposals.filter(p => p.id !== card.dataset.proposal);
          this.renderSide();
          return;
        }
      } catch (err) {
        this.setStatus(t('realtime.error', { error: err.message }));
      }
    },

    async onSideChange(e) {
      if (e.target.classList.contains('rt-agenda-kind')) {
        const wrap = this.ui.side.querySelector('.rt-agenda-end-wrap');
        if (wrap) wrap.hidden = e.target.value !== 'activity';
      }
      if (e.target.classList.contains('rt-diary-day')) this.diaryDay = LOCAL_DAY.test(e.target.value) ? e.target.value : '';
    },

    async onSideSubmit(e) {
      // Sent: the field that was being filled in no longer holds the page as it is.
      document.activeElement?.blur?.();
      await this.onAgendaSubmit(e);
    },

    /* -------------------------------------------------------------- */
    /* The section's settings: character, memories, diary               */
    /* -------------------------------------------------------------- */

    /**
     * One window for what the section keeps and how it works: the character
     * (name, voice), the memories (what it knows about you, the data of the
     * days, the analysis of the conversations) and the diary (the questions
     * and the instructions for the page).
     */
    async openSettings(tab) {
      if (!this.dialog) {
        const dialog = document.createElement('dialog');
        dialog.className = 'workspace-dialog rt-settings';
        dialog.setAttribute('aria-labelledby', 'rt-settings-title');
        dialog.addEventListener('click', (e) => this.onSettingsClick(e));
        dialog.addEventListener('change', (e) => this.onSettingsChange(e));
        dialog.addEventListener('submit', (e) => this.onSettingsSubmit(e));
        document.body.appendChild(dialog);
        this.dialog = dialog;
      }
      if (tab) this.settingsTab = tab;
      this.editingNote = null;
      this.settingsNote = '';
      try { await this.ensure(); } catch {}
      await this.loadTexts();
      this.renderSettings(true);
      if (!this.dialog.open) this.dialog.showModal();
    },

    /** The texts the user can change, as they are now, and when the conversations were last read. */
    async loadTexts() {
      const [questions, pagePrompt, memoryPrompt, reviewPrompt] = await Promise.all(['questions', 'pagePrompt', 'memoryPrompt', 'reviewPrompt'].map(key => this.custom(key)));
      this.texts = { questions: questions.join('\n'), pagePrompt, memoryPrompt, reviewPrompt };
      try { this.analyzedAt = JSON.parse((await window.chatStorage.getSetting('realtime_analyzed'))?.value || '{}').at || null; } catch { this.analyzedAt = null; }
      await this.loadUsage();
      try { this.cap = JSON.parse((await window.chatStorage.realtime()).conversation.memory_settings_json || '{}').cap || null; } catch { this.cap = null; }
      this.capNote = '';
    },

    /** Drawn again when what it shows changes; not while a field of it is being typed in, unless `force`. */
    renderSettings(force = false) {
      const dialog = this.dialog;
      if (!dialog || (!force && !dialog.open)) return;
      if (!force && dialog.contains(document.activeElement) && document.activeElement.matches('textarea, input[type="text"]')) return;
      const tabs = ['character', 'features', 'watch', 'memories', 'diary', 'wellbeing', 'notices', 'jobs'];
      if (!tabs.includes(this.settingsTab)) this.settingsTab = 'character';
      // The same page drawn again keeps its scroll; another page starts at the top.
      const body = dialog.querySelector('.rt-settings-body');
      const scroll = body && this.renderedSettings === this.settingsTab ? body.scrollTop : 0;
      this.renderedSettings = this.settingsTab;
      dialog.innerHTML = `
        <div class="memory-dialog-heading">
          <div class="memory-dialog-header-info">
            <h2 id="rt-settings-title"><i class="fa-solid fa-gear" style="color: var(--primary);"></i> ${esc(t('realtime.settingsTitle'))}</h2>
            <p>${esc(t('realtime.settingsDesc', { name: this.displayName() }))}</p>
          </div>
          <button type="button" class="btn-chat-action" data-action="close" aria-label="${esc(t('common.close'))}"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="memory-dialog-tabs rt-settings-tabs" role="tablist">
          ${tabs.map(tab => `<button type="button" class="memory-dialog-tab${tab === this.settingsTab ? ' active' : ''}" role="tab" aria-selected="${tab === this.settingsTab}" data-tab="${tab}">
            <i class="fa-solid ${{ character: 'fa-face-smile', features: 'fa-sliders', watch: 'fa-eye', phone: 'fa-mobile-screen', memories: 'fa-brain', diary: 'fa-book', wellbeing: 'fa-heart-pulse', notices: 'fa-bell', jobs: 'fa-gauge' }[tab]}"></i> ${esc(t('realtime.settingsTab_' + tab))}</button>`).join('')}
        </div>
        <div class="rt-settings-body">${this['renderSettings_' + this.settingsTab]()}</div>`;
      dialog.querySelector('.rt-settings-body').scrollTop = scroll;
    },

    renderSettings_character() {
      const registry = window.operationalRegistry;
      const listenModel = registry?.getCurrentRealtimeMultiModel?.();
      const speechId = registry?.getToolDelegate?.('voice_synthesis');
      const speechModel = speechId && speechId !== 'auto' ? window.openRouterCatalog?.models?.find(m => m.id === speechId) : null;
      const voiceList = voicesFor(speechId);
      return `<section class="rt-set-block">
        <label class="rt-field">${esc(t('realtime.nameLabel'))}
          <input type="text" class="rt-name" maxlength="40" value="${esc(this.name)}" placeholder="${esc(t('realtime.defaultName'))}">
        </label>
        <label class="rt-field">${esc(t('realtime.voiceLabel'))}
          ${voiceList.length
            ? `<select class="rt-voice select-control">${voiceList.map((v, i) => `<option value="${esc(v)}"${v === this.voice || (!voiceList.includes(this.voice) && i === 0) ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`
            : `<span class="rt-hint">${esc(t('realtime.voiceDefault'))}</span>`}
        </label>
        <p class="rt-hint">${esc(t('realtime.modelLine', { listen: listenModel?.name || '—', voice: speechModel?.name || (speechId && speechId !== 'auto' ? speechId : t('realtime.noneAssigned')) }))}</p>
      </section>`;
    },

    /** Where a note came from, and when it was last written. */
    noteOrigin(note) {
      const origin = String(note.origin || '');
      const from = origin === 'tidy' ? t('realtime.originTidy') : origin.startsWith('diary:') ? t('realtime.originDiary', { day: this.dayLabel(origin.slice(6), { day: 'numeric', month: 'long' }) })
        : origin === 'conversation' ? t('realtime.originConversation')
        : origin === 'user' ? t('realtime.originUser')
        : '';
      const date = new Date(note.updated_at);
      const when = isNaN(date) ? '' : date.toLocaleDateString(window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
      return [from, when].filter(Boolean).join(' · ');
    },

    renderSettings_memories() {
      const text = (key, rows) => this.renderText(key, rows);
      const notes = this.notes.map(note => (this.editingNote === note.id
        ? `<li class="rt-memory is-editing">
            <textarea class="rt-note-edit" rows="3" maxlength="600">${esc(note.content)}</textarea>
            <div class="rt-row">
              <button type="button" class="btn btn-primary" data-action="note-save" data-id="${esc(note.id)}">${esc(t('realtime.save'))}</button>
              <button type="button" class="btn" data-action="note-cancel">${esc(t('realtime.cancel'))}</button>
            </div>
          </li>`
        : `<li class="rt-memory">
            <div class="rt-memory-text"><span>${esc(note.content)}</span><small>${esc(this.noteOrigin(note))}</small></div>
            <button type="button" class="btn-chat-action" data-action="note-edit" data-id="${esc(note.id)}" title="${esc(t('realtime.noteEdit'))}" aria-label="${esc(t('realtime.noteEdit'))}"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="btn-chat-action" data-action="note-delete" data-id="${esc(note.id)}" title="${esc(t('realtime.noteDelete'))}" aria-label="${esc(t('realtime.noteDelete'))}"><i class="fa-solid fa-xmark"></i></button>
          </li>`)).join('');
      const scale = (label, value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? `<span class="rt-mood rt-mood-${Math.round(Number(value))}">${esc(label)} ${esc(String(value))}/5</span>` : '');
      const items = (label, list) => (Array.isArray(list) && list.length ? `<p><b>${esc(label)}</b> ${esc(list.map(String).join(', '))}</p>` : '');
      const days = (this.diary || []).map(e => {
        const x = dayData(e);
        const busy = this.recalculating?.has(e.day) || this.writing.has(e.day);
        const head = `<div class="rt-diary-head">
            <strong>${esc(this.dayLabel(e.day))}</strong>
            ${busy ? '<i class="fa-solid fa-rotate fa-spin"></i>' : `<button type="button" class="btn-chat-action" data-action="data-write" data-day="${esc(e.day)}" title="${esc(t('realtime.dataWrite'))}" aria-label="${esc(t('realtime.dataWrite'))}"><i class="fa-solid fa-rotate"></i></button>
            ${x ? `<button type="button" class="btn-chat-action" data-action="data-clear" data-id="${esc(e.id)}" title="${esc(t('realtime.dataClear'))}" aria-label="${esc(t('realtime.dataClear'))}"><i class="fa-solid fa-xmark"></i></button>` : ''}`}
          </div>`;
        if (!x) return `<li class="rt-day">${head}<p class="rt-hint">${esc(t('realtime.dataNone'))}</p></li>`;
        const minutes = (Array.isArray(x.activities) ? x.activities : []).reduce((sum, a) => sum + (Number(a?.minutes) || 0), 0);
        const activities = (Array.isArray(x.activities) ? x.activities : []).map(a => `<span class="rt-chip rt-chip-${esc(a?.category || 'other')}">${esc(a?.name || '')}${Number(a?.minutes) ? ` · ${esc(String(a.minutes))}′` : ''}</span>`).join('');
        const sleep = Number(x.sleep_hours) ? `<span class="rt-mood">${esc(t('realtime.dataSleep', { hours: x.sleep_hours }))}</span>` : '';
        return `<li class="rt-day">${head}
          ${x.summary ? `<p>${esc(x.summary)}</p>` : ''}
          <div class="rt-chips">
            ${x.mood?.score ? scale(`${t('realtime.dataMood')}${x.mood.label ? ` (${x.mood.label})` : ''}`, x.mood.score) : (x.mood?.label ? `<span class="rt-mood">${esc(t('realtime.dataMood'))}: ${esc(x.mood.label)}</span>` : '')}
            ${scale(t('realtime.dataEnergy'), x.energy)}${scale(t('realtime.dataStress'), x.stress)}${sleep}
          </div>
          ${activities ? `<div class="rt-chips">${activities}${minutes ? `<span class="rt-hint">${esc(t('realtime.dataMinutes', { minutes }))}</span>` : ''}</div>` : ''}
          <details><summary>${esc(t('realtime.dataMore'))}</summary>
            ${x.mood?.notes ? `<p><b>${esc(t('realtime.dataMood'))}</b> ${esc(x.mood.notes)}</p>` : ''}
            ${items(t('realtime.dataPeople'), x.people)}${items(t('realtime.dataHighlights'), x.highlights)}${items(t('realtime.dataDifficulties'), x.difficulties)}${items(t('realtime.dataGoals'), x.goals_mentioned)}${items(t('realtime.dataFood'), x.food)}
          </details>
        </li>`;
      }).join('');
      const archived = (this.archived || []).map(note => `<li class="rt-memory">
          <div class="rt-memory-text"><span>${esc(note.content)}</span><small>${esc(this.noteOrigin(note))}</small></div>
          <button type="button" class="btn-chat-action" data-action="note-restore" data-id="${esc(note.id)}" title="${esc(t('realtime.noteRestore'))}" aria-label="${esc(t('realtime.noteRestore'))}"><i class="fa-solid fa-rotate-left"></i></button>
          <button type="button" class="btn-chat-action" data-action="note-delete" data-id="${esc(note.id)}" title="${esc(t('realtime.noteDelete'))}" aria-label="${esc(t('realtime.noteDelete'))}"><i class="fa-solid fa-xmark"></i></button>
        </li>`).join('');
      const analyzed = this.analyzedAt && !isNaN(new Date(this.analyzedAt))
        ? new Date(this.analyzedAt).toLocaleString(window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
        : t('realtime.analysisNever');
      return `
        <section class="rt-set-block">
          <h3>${esc(t('realtime.notesTitle', { name: this.displayName() }))} <span class="rt-count">${this.notes.length}</span></h3>
          <p class="rt-hint">${esc(t('realtime.notesHint'))}</p>
          ${notes ? `<ul class="rt-list rt-memory-list">${notes}</ul>` : `<p class="rt-hint">${esc(t('realtime.notesEmpty'))}</p>`}
          <form class="rt-note-add rt-row">
            <input type="text" class="rt-note-new" maxlength="600" placeholder="${esc(t('realtime.noteAddPlaceholder'))}" aria-label="${esc(t('realtime.noteAddPlaceholder'))}">
            <button type="submit" class="btn">${esc(t('realtime.noteAdd'))}</button>
          </form>
          ${archived ? `<details class="rt-notes-archived"><summary>${esc(t('realtime.notesArchived', { count: this.archived.length }))}</summary>
            <p class="rt-hint">${esc(t('realtime.notesArchivedHint'))}</p>
            <ul class="rt-list rt-memory-list">${archived}</ul>
          </details>` : ''}
        </section>
        <section class="rt-set-block">
          <h3>${esc(t('realtime.capTitle'))}</h3>
          <p class="rt-hint">${esc(t('realtime.capHint'))}</p>
          <form class="rt-cap rt-row">
            <label class="rt-field">${esc(t('realtime.capLabel'))}
              <input type="number" class="rt-cap-value" min="4000" max="200000" step="1000" value="${esc(String(this.cap || ''))}">
            </label>
            <button type="submit" class="btn btn-primary">${esc(t('realtime.save'))}</button>
            <span class="rt-hint" role="status">${esc(this.capNote || '')}</span>
          </form>
        </section>
        <section class="rt-set-block">
          <h3>${esc(t('realtime.dataTitle'))} <span class="rt-count">${(this.diary || []).filter(e => e.extracted_json).length}</span></h3>
          <p class="rt-hint">${esc(t('realtime.dataHint'))}</p>
          ${days ? `<ul class="rt-list rt-day-list">${days}</ul>` : `<p class="rt-hint">${esc(t('realtime.dataEmpty'))}</p>`}
        </section>
        <section class="rt-set-block">
          <h3>${esc(t('realtime.analysisTitle'))}</h3>
          <p class="rt-hint">${esc(t('realtime.analysisHint'))}</p>
          <div class="rt-row">
            <button type="button" class="btn" data-action="analyze" ${this.analyzing ? 'disabled' : ''}><i class="fa-solid ${this.analyzing ? 'fa-rotate fa-spin' : 'fa-magnifying-glass'}"></i> ${esc(t(this.analyzing ? 'realtime.analysisRunning' : 'realtime.analysisRun'))}</button>
            <span class="rt-hint">${esc(this.settingsNote || t('realtime.analysisLast', { when: analyzed }))}</span>
          </div>
          ${text('memoryPrompt', 7)}
        </section>
        <section class="rt-set-block">
          <h3>${esc(t('realtime.forgetAll'))}</h3>
          <p class="rt-hint">${esc(t('realtime.forgetMessage'))}</p>
          <button type="button" class="btn btn-danger-outline" data-action="forget">${esc(t('realtime.forgetAll'))}</button>
        </section>`;
    },

    renderSettings_diary() {
      return `
        <section class="rt-set-block">
          <h3>${esc(t('realtime.questionsTitle'))}</h3>
          <p class="rt-hint">${esc(t('realtime.questionsHint'))}</p>
          ${this.renderText('questions', 8)}
        </section>
        <section class="rt-set-block">
          <h3>${esc(t('realtime.pagePromptTitle'))}</h3>
          <p class="rt-hint">${esc(t('realtime.pagePromptHint'))}</p>
          ${this.renderText('pagePrompt', 8)}
        </section>`;
    },

    /** The habits — followed, proposed, turned down — each changed in place; one added by hand; the review's instructions. */
    renderSettings_wellbeing() {
      const option = (value, label, current) => `<option value="${value}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
      const fields = (h) => `
        <input type="text" class="rt-habit-name" maxlength="80" value="${esc(h?.name || '')}" placeholder="${esc(t('realtime.habitNamePlaceholder'))}" aria-label="${esc(t('realtime.habitNameLabel'))}" required>
        <select class="rt-habit-sign select-control" aria-label="${esc(t('realtime.habitSignLabel'))}">
          ${option('positive', t('realtime.sign_positive'), h?.sign || 'positive')}${option('negative', t('realtime.sign_negative'), h?.sign)}
        </select>
        ${h ? `<select class="rt-habit-status select-control" aria-label="${esc(t('realtime.habitStatusLabel'))}">
          ${['tracked', 'proposed', 'dismissed'].map(s => option(s, t('realtime.status_' + s), h.status)).join('')}
        </select>` : ''}
        <input type="text" class="rt-habit-notes" maxlength="600" value="${esc(h?.notes || '')}" placeholder="${esc(t('realtime.habitNotesPlaceholder'))}" aria-label="${esc(t('realtime.habitNotesLabel'))}">`;
      const rows = this.habits.map(h => `<li>
        <form class="rt-habit-form" data-id="${esc(h.id)}">
          ${fields(h)}
          <div class="rt-row">
            <button type="submit" class="btn btn-primary">${esc(t('realtime.save'))}</button>
            <button type="button" class="btn btn-danger-outline" data-action="habit-delete" data-id="${esc(h.id)}">${esc(t('realtime.habitDelete'))}</button>
            <span class="rt-hint">${esc(t(h.source === 'model' ? 'realtime.habitFromModel' : 'realtime.habitFromUser'))}</span>
          </div>
        </form>
      </li>`).join('');
      return `
        <section class="rt-set-block">
          <h3>${esc(t('realtime.habitsTitle'))} <span class="rt-count">${this.habits.filter(h => h.status === 'tracked').length}</span></h3>
          <p class="rt-hint">${esc(t('realtime.habitsHint'))}</p>
          ${this.settingsNote ? `<p class="rt-hint" role="status">${esc(this.settingsNote)}</p>` : ''}
          ${rows ? `<ul class="rt-list rt-habit-forms">${rows}</ul>` : `<p class="rt-hint">${esc(t('realtime.habitsEmpty'))}</p>`}
        </section>
        <section class="rt-set-block">
          <h3>${esc(t('realtime.habitAddTitle'))}</h3>
          <form class="rt-habit-form rt-habit-add">
            ${fields(null)}
            <div class="rt-row"><button type="submit" class="btn">${esc(t('realtime.noteAdd'))}</button></div>
          </form>
        </section>
        <section class="rt-set-block">
          <h3>${esc(t('realtime.reviewTitle'))}</h3>
          <p class="rt-hint">${esc(t('realtime.reviewHint'))}</p>
          ${this.renderText('reviewPrompt', 8)}
        </section>`;
    },

    /** A text the user can change, with what saves it and what brings the default back. */
    renderText(key, rows) {
      const label = t('realtime.textLabel_' + key);
      return `<div class="rt-text" data-key="${key}">
        <textarea class="rt-text-input" rows="${rows}" maxlength="8000" aria-label="${esc(label)}" title="${esc(label)}" spellcheck="false">${esc(this.texts?.[key] ?? '')}</textarea>
        <div class="rt-row">
          <button type="button" class="btn btn-primary" data-action="text-save">${esc(t('realtime.save'))}</button>
          <button type="button" class="btn" data-action="text-reset">${esc(t('realtime.textReset'))}</button>
          <span class="rt-hint rt-text-state" role="status"></span>
        </div>
      </div>`;
    },

    async onSettingsClick(e) {
      const tab = e.target.closest('[data-tab]');
      if (tab) {
        this.settingsTab = tab.dataset.tab;
        this.editingNote = null;
        this.settingsNote = '';
        this.renderSettings(true);
        return;
      }
      const target = e.target.closest('button');
      if (!target) return;
      const action = target.dataset.action;
      if (this.settingsTab === 'notices' && action !== 'close' && await this.onNoticesSettings(e)) return;
      if (this.settingsTab === 'watch' && action !== 'close' && await this.onWatchSettings(e)) return;
      try {
        if (action === 'close') { this.dialog.close(); return; }
        if (action === 'note-edit') {
          this.editingNote = target.dataset.id;
          this.renderSettings(true);
          this.dialog.querySelector('.rt-note-edit')?.focus();
          return;
        }
        if (action === 'note-cancel') {
          this.editingNote = null;
          this.renderSettings(true);
          return;
        }
        if (action === 'note-save') {
          const note = this.notes.find(n => n.id === target.dataset.id);
          const content = this.dialog.querySelector('.rt-note-edit')?.value.trim() || '';
          this.editingNote = null;
          if (note && content && content !== note.content) {
            await window.chatStorage.saveMemory({ content, scope: 'conversation', conversationId: this.conversationId, section: 'about_user', pinned: true, origin: 'user' }, note.id);
          }
          await this.loadNotes();
          this.renderSettings(true);
          return;
        }
        if (action === 'note-restore') {
          const note = (this.archived || []).find(n => n.id === target.dataset.id);
          if (note) await window.chatStorage.saveMemory({ content: note.content, scope: 'conversation', conversationId: this.conversationId, section: 'about_user', pinned: true, enabled: true }, note.id);
          await this.loadNotes();
          this.renderSettings(true);
          return;
        }
        if (action === 'note-delete') {
          await window.chatStorage.deleteMemory(target.dataset.id);
          await this.loadNotes();
          this.renderSettings(true);
          return;
        }
        if (action === 'habit-delete') {
          const habit = this.habits.find(h => h.id === target.dataset.id);
          const ok = await window.chatWorkspace.confirmAction({
            title: t('realtime.habitDeleteTitle'),
            message: t('realtime.habitDeleteMessage', { name: habit?.name || '' }),
            confirmText: t('realtime.habitDelete')
          });
          if (!ok) return;
          await window.chatStorage.deleteHabit(target.dataset.id);
          await this.loadWellbeing();
          this.renderSettings(true);
          return;
        }
        if (action === 'data-write') {
          const day = target.dataset.day;
          this.recalculating = this.recalculating || new Set();
          this.recalculating.add(day);
          this.renderSettings(true);
          try { await this.writeData(day); }
          finally { this.recalculating.delete(day); this.renderSettings(true); }
          return;
        }
        if (action === 'data-clear') {
          await window.chatStorage.saveDiary({ extracted: null }, target.dataset.id);
          await this.loadDiary();
          this.renderSettings(true);
          return;
        }
        if (action === 'analyze') {
          this.settingsNote = '';
          const result = await this.analyze({ manual: true });
          await this.loadTexts();
          this.settingsNote = result.failed ? t('realtime.analysisFailed', { error: result.error || '' })
            : result.read ? t('realtime.analysisDone', { read: result.read, changed: result.changed })
            : t('realtime.analysisNothing');
          this.renderSettings(true);
          return;
        }
        if (action === 'text-save' || action === 'text-reset') {
          const box = target.closest('.rt-text');
          const key = box.dataset.key;
          const input = box.querySelector('.rt-text-input');
          let value = '';
          if (action === 'text-save') {
            value = key === 'questions'
              ? JSON.stringify(input.value.split('\n').map(q => q.trim()).filter(Boolean))
              : input.value.trim();
          }
          await window.chatStorage.setSetting(CUSTOM_KEYS[key], value);
          await this.loadTexts();
          input.value = this.texts[key];
          box.querySelector('.rt-text-state').textContent = t(action === 'text-save' ? 'realtime.textSaved' : 'realtime.textResetDone');
          return;
        }
        if (action === 'forget') {
          const ok = await window.chatWorkspace.confirmAction({
            title: t('realtime.forgetTitle', { name: this.displayName() }),
            message: t('realtime.forgetMessage'),
            confirmText: t('realtime.forgetConfirm')
          });
          if (!ok) return;
          this.interrupt();
          const got = await window.chatStorage.realtimeForget();
          this.conversationId = got.conversation.id;
          this.tasksConversationId = got.tasksConversationId;
          this.reports = [];
          this.proposals = [];
          this.ui.user.textContent = '';
          this.ui.bot.textContent = '';
          await this.loadNotes();
          await this.loadTexts();
          this.renderSide();
          this.renderSettings(true);
        }
      } catch (err) {
        this.settingsNote = t('realtime.error', { error: err.message });
        this.renderSettings(true);
      }
    },

    onSettingsChange(e) {
      if (this.settingsTab === 'notices') { this.onNoticesSettings(e); return; }
      if (this.settingsTab === 'watch') { this.onWatchSettings(e); return; }
      if (this.settingsTab === 'features') { this.onFeaturesSettings(e); return; }
      if (e.target.classList.contains('rt-voice')) {
        this.voice = e.target.value;
        window.chatStorage.setSetting('realtime_voice', this.voice).catch(() => {});
      }
      if (e.target.classList.contains('rt-name')) {
        this.name = e.target.value.trim();
        window.chatStorage.setSetting('realtime_name', this.name).catch(() => {});
        this.renderControls();
        this.renderSide();
      }
    },

    async onSettingsSubmit(e) {
      if (this.settingsTab === 'notices') { this.onNoticesSettings(e); return; }
      const cap = e.target.closest('.rt-cap');
      if (cap) {
        e.preventDefault();
        const value = Math.round(Number(cap.querySelector('.rt-cap-value').value));
        try {
          if (!Number.isFinite(value) || value < 4000) throw new Error(t('realtime.capLeast'));
          const saved = await window.chatStorage.update(this.conversationId, { memorySettings: { cap: value } });
          this.cap = JSON.parse(saved.memory_settings_json || '{}').cap || value;
          this.capNote = t('realtime.textSaved');
        } catch (err) {
          this.capNote = t('realtime.error', { error: err.message });
        }
        this.renderSettings(true);
        return;
      }
      const habit = e.target.closest('.rt-habit-form');
      if (habit) {
        e.preventDefault();
        const id = habit.dataset.id || null;
        try {
          await window.chatStorage.saveHabit({
            name: habit.querySelector('.rt-habit-name').value.trim(),
            sign: habit.querySelector('.rt-habit-sign').value,
            status: habit.querySelector('.rt-habit-status')?.value || 'tracked',
            notes: habit.querySelector('.rt-habit-notes').value.trim()
          }, id);
          this.settingsNote = t(id ? 'realtime.textSaved' : 'realtime.habitAdded');
        } catch (err) {
          this.settingsNote = t('realtime.error', { error: err.message });
        }
        await this.loadWellbeing();
        this.renderSettings(true);
        return;
      }
      const form = e.target.closest('.rt-note-add');
      if (!form) return;
      e.preventDefault();
      const input = form.querySelector('.rt-note-new');
      const content = input.value.trim();
      if (!content) return;
      try {
        await window.chatStorage.saveMemory({ content, scope: 'conversation', conversationId: this.conversationId, section: 'about_user', pinned: true, origin: 'user' });
        input.value = '';
        await this.loadNotes();
        this.renderSettings(true);
      } catch (err) {
        this.settingsNote = t('realtime.error', { error: err.message });
        this.renderSettings(true);
      }
    }
  };

  /**
   * The character's voice for other places — the tour: says a text with the
   * Speech synthesis model and moves a puppet's mouth with the sound, the
   * same way as on the Realtime tab. One text at a time: a new one stops the
   * last.
   *
   * Texts known ahead (the next steps of the tour) can be prepared with
   * prefetch(): their audio is asked for in order, a few at a time, and kept,
   * so when their turn comes the voice starts at once instead of waiting for
   * a model that makes the whole audio before sending it.
   */
  const voiceOver = {
    player: null,
    frame: null,
    puppet: null,
    turn: 0,               // which say() is current: an older one stops where it is
    cache: new Map(),      // model|voice|text -> { promise, done }
    queue: [],
    fetching: 0,
    available() {
      const id = window.operationalRegistry?.getToolDelegate?.('voice_synthesis');
      return Boolean(id && id !== 'auto' && window.openRouterCatalog?.getApiKey?.());
    },
    request(clean) {
      const model = window.operationalRegistry.getToolDelegate('voice_synthesis');
      const voices = voicesFor(model);
      const body = { model, input: clean, response_format: 'pcm', provider: speechProvider() };
      if (voices.length) body.voice = voices.includes(rt.voice) ? rt.voice : voices[0];
      return { key: `${model}|${body.voice || ''}|${speechLocale()}|${clean}`, body };
    },
    /** The whole audio of a text, asked once and kept: { chunks, rate } or null. */
    load(clean) {
      const { key, body } = this.request(clean);
      if (this.cache.has(key)) return this.cache.get(key);
      const entry = { done: false, promise: null };
      entry.promise = (async () => {
        try {
          const response = await window.modelGateway.fetchApi(SPEECH_URL, {
            method: 'POST',
            track: { conversationId: rt.conversationId, role: 'speech' },
            headers: { 'Authorization': `Bearer ${window.openRouterCatalog.getApiKey()}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://synthorg.local', 'X-Title': 'SynthOrg Tour' },
            body: JSON.stringify(body)
          });
          if (!response.ok) { this.cache.delete(key); return null; }
          const rate = pcmRate(response);
          const chunks = [];
          const reader = response.body.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          return { chunks, rate };
        } catch {
          this.cache.delete(key);
          return null;
        } finally {
          entry.done = true;
        }
      })();
      this.cache.set(key, entry);
      // A handful of texts is all a tour needs: the oldest go first.
      if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value);
      return entry;
    },
    /** Prepares texts in the order given, piece by piece, two at a time. */
    prefetch(texts) {
      if (!this.available()) return;
      texts.flatMap(speechPieces).forEach(clean => {
        const { key } = this.request(clean);
        if (!this.cache.has(key) && !this.queue.includes(clean)) this.queue.push(clean);
      });
      const pump = () => {
        while (this.fetching < 2 && this.queue.length) {
          const clean = this.queue.shift();
          this.fetching++;
          this.load(clean).promise.finally(() => { this.fetching--; pump(); });
        }
      };
      pump();
    },
    stop() {
      this.turn++;
      this.player?.stop();
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = null;
      this.puppet?.setMouthShape({ open: 0 });
    },
    /**
     * Says a text, prepared or not. onWaiting() when its audio is not ready
     * yet, onPlaying() when it starts. Resolves true once all of it is
     * handed to the player.
     */
    async say(text, puppet, { onWaiting, onPlaying } = {}) {
      this.stop();
      const pieces = speechPieces(text);
      if (!pieces.length || !this.available()) return false;
      const turn = this.turn;
      this.player = this.player || new Player();
      this.puppet = puppet || null;
      // Out of the queue, to the front, all at once: these are needed now.
      this.queue = this.queue.filter(q => !pieces.includes(q));
      const entries = pieces.map(piece => this.load(piece));
      if (!entries[0].done) onWaiting?.();
      let started = false;
      for (const entry of entries) {
        const audio = await entry.promise;
        if (turn !== this.turn) return false;
        if (!audio) continue;
        if (!started) {
          started = true;
          onPlaying?.();
          const lips = () => {
            if (turn !== this.turn) return;
            this.puppet?.setMouthShape(this.player.playing ? this.player.shape() : { open: 0 });
            this.frame = requestAnimationFrame(lips);
          };
          lips();
        }
        // Queued right after what is playing: the pieces join into one speech.
        audio.chunks.forEach(chunk => this.player.pushBytes(chunk, audio.rate));
      }
      return started;
    }
  };

  window.realtime = {
    setActive: (on) => rt.setActive(on),
    voice: voiceOver,
    tools: REALTIME_TOOLS,
    _state: rt,
    _util: { t, esc, dayStamp, localStamp, parseStamp, plainWords, dayData, yesOrNo, spokenTask, wordsSoFar, fixedLine, writtenLine },
    _audio: { Microphone, Player, toWav }
  };

  // Reminders ring from the moment the app is up, on any tab.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => rt.startReminders());
  else rt.startReminders();
})();
