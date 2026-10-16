/**
 * Computer use: the `computer_use` tool of the Master.
 *
 * The Master gives a goal; this file asks the user (always: there is no
 * setting that answers for them), then runs a small session of its own with
 * the same model, on a desktop in the chat's container. The session reads the
 * screen as a numbered list of what is on it (the accessibility tree: every
 * window, button, field and link with its name) and acts on those numbers,
 * until it can say what it found or did. That answer goes back to the Master.
 *
 * In the chat the session is a card inside the turn, in three sizes: the
 * steps as text (the default), the live screen inside the card, or the live
 * screen on the whole window.
 */
(function () {
  const t = (key, params) => (window.i18n ? window.i18n.t(key, params || {}) : key);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const MAX_STEPS = 40;
  const LIVE_INTERVAL_MS = 350;
  const STEPS_SHOWN_COLLAPSED = 4;

  // What only lives while the page does: the sessions running now, the
  // questions waiting for the user, how each card is shown and its last picture.
  const running = new Map();   // callId -> { conversationId, sessionId, abort }
  const asking = new Map();    // callId -> { resolve, tc, conversationId }
  const views = new Map();     // callId -> 'collapsed' | 'expanded'
  const pictures = new Map();  // sessionId -> object URL of the last screen
  let fullscreen = null;       // callId shown on the whole window

  /* ---------------------------------------------------------------- the tool */

  const TOOL_SPEC = {
    type: 'function',
    function: {
      name: 'computer_use',
      description: 'Uses a computer to reach a goal: a Linux desktop with its own screen, in this chat\'s container, with a real browser (Firefox), a text editor and a file manager. A separate session of yours does the work step by step, reading the screen as a list of named elements, and returns what it found or did. Use it only when a graphical interface is really needed (a site that needs clicks, forms, logins the user does, apps with windows); to read a web page use web_browse, for files and commands the terminal. The user is asked every time and sees the goal: if they refuse, do not ask again on your own. The desktop has Internet only if the chat\'s environment does. Its /workspace is the chat\'s workspace: files saved there are the chat\'s artifacts.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'What to achieve, self-contained (the session does not see this conversation): the task, the details it needs (addresses, names, text to write) and what to report back at the end. Written in the language of the conversation, since the user reads it before allowing it.' },
          apps: { type: 'array', items: { type: 'string' }, description: 'Apps to use, e.g. ["firefox"]. Optional.' },
          start_url: { type: 'string', description: 'Optional page to open in the browser at the start.' }
        },
        required: ['goal']
      }
    }
  };

  /* -------------------------------------------------------- the session's tools */

  function sessionTools(canSee) {
    const tools = [
      fn('open_app', 'Opens an app from the list of installed apps. For the browser, pass the address to open as url.', {
        app: { type: 'string', description: 'The app\'s id or name from the list' },
        url: { type: 'string', description: 'Optional: a web address or a file path to open with it' }
      }, ['app']),
      fn('click', 'Clicks an element of the screen by its number in the list.', {
        element: { type: 'integer', description: 'The number in square brackets' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        double: { type: 'boolean', description: 'Double click' }
      }, ['element']),
      fn('type', 'Writes text on the keyboard. With element, first puts the cursor in that field.', {
        element: { type: 'integer', description: 'The field\'s number; leave out to write where the cursor already is' },
        text: { type: 'string' },
        replace: { type: 'boolean', description: 'Deletes what the field holds first' },
        submit: { type: 'boolean', description: 'Presses Enter after writing' }
      }, ['text']),
      fn('press_keys', 'Presses keys or shortcuts, xdotool style, separated by spaces: "Return", "Tab", "Escape", "ctrl+l", "ctrl+s", "alt+F4", "Down Down Return".', {
        keys: { type: 'string' }
      }, ['keys']),
      fn('scroll', 'Scrolls the page or an element.', {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', description: 'Wheel steps, 1-20 (default 5)' },
        element: { type: 'integer', description: 'Optional: the element to scroll' }
      }, ['direction']),
      fn('wait', 'Waits for a page or an app to finish loading, then reads the screen again.', {
        seconds: { type: 'number', description: '1-10' }
      }, ['seconds']),
      fn('finish', 'Ends the session with the result: what was found or done, with the details the one who asked needs. Say plainly what did not work.', {
        result: { type: 'string' }
      }, ['result'])
    ];
    if (canSee) {
      tools.splice(tools.length - 1, 0,
        fn('look', 'Shows you a picture of the screen. For what the list does not describe well: images, charts, canvases, apps that draw everything themselves.', {}, []),
        fn('click_point', 'Clicks a point of the screen, in pixels of the picture look gave you. Only for what has no number in the list.', {
          x: { type: 'integer' }, y: { type: 'integer' },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          double: { type: 'boolean' }
        }, ['x', 'y']));
    }
    return tools;
  }

  function fn(name, description, properties, required) {
    return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
  }

  function systemPrompt({ installed, network, canSee, locale }) {
    const apps = installed.map(app => `- ${app.id}: ${app.name}${app.what ? ` (${app.what})` : ''}`).join('\n');
    return [
      'You are using a Linux computer to reach the goal the user gives you. You work alone, step by step, with the tools; nobody answers questions during the session.',
      'After every action you get the screen as a list: each line is an element with its number in square brackets, its role (button, entry, link, menu item…), its name in quotes, its text after "=", and its state in parentheses (focused, checked, disabled, scrivibile = you can write in it). Indentation shows what is inside what. The window marked "(attiva)" has the keyboard. Numbers stay the same for the same element during the whole session.',
      'Act on elements by their number. To write in a field use type with its number. To open a web page open the browser with url, or put the address in the address bar (ctrl+l, then type with submit).',
      canSee ? 'When the list is not enough (images, charts, apps without a list) use look to see the screen, and click_point for what has no number.' : 'You cannot see pictures of the screen: work with the list.',
      network ? 'The computer has Internet.' : 'The computer has NO Internet: web pages outside will not load. Say so in the result if the goal needs them.',
      'Files: /workspace is the folder shared with the chat; what you save there reaches the user.',
      'Do not enter passwords, payment data or personal data that are not in the goal. If a page asks for them, or for a login, stop and say so in the result: the user will do it.',
      'Be quick: no step that is not needed. When the goal is reached, or cannot be reached, call finish with the result.',
      `Write the result in ${locale === 'en' ? 'English' : 'Italian'}.`,
      '',
      `Installed apps:\n${apps || '(none)'}`
    ].join('\n');
  }

  /* ------------------------------------------------------------- the run */

  /**
   * Runs one computer_use call to its end and returns the text the Master reads.
   * `tc` is the tool call in the message: its `cu` field is what the card shows.
   */
  async function run({ tc, args, conversationId, modelId, apiKey, registry, signal, onUpdate }) {
    const goal = String(args.goal || args.task || '').trim();
    if (!goal) return { text: 'ERRORE: serve un obiettivo (goal).', error: true };
    const callId = tc.id || `cu_${Date.now()}`;
    tc.id = callId;
    const apps = Array.isArray(args.apps) ? args.apps.map(String).slice(0, 6) : [];
    const update = () => { try { onUpdate?.(); } catch {} refreshAsk(); };

    // 1. The question to the user.
    let session;
    try {
      session = await window.chatStorage.desktopRequest(conversationId, goal, apps);
    } catch (error) {
      return { text: `ERRORE: ${error.message}`, error: true };
    }
    tc.cu = { sessionId: session.id, status: 'awaiting', goal, apps, network: session.network, steps: [], startUrl: args.start_url || null };
    tc.status = 'awaiting';
    const decision = await new Promise(resolve => {
      let settled = false;
      const done = value => {
        if (settled) return;
        settled = true;
        asking.delete(callId);
        refreshAsk();
        resolve(value);
      };
      asking.set(callId, { resolve: done, tc, conversationId, onUpdate: update });
      signal?.addEventListener('abort', () => done('stopped'), { once: true });
      setTimeout(() => done('expired'), 10 * 60 * 1000);
      // Drawn once the question is registered, so the card shows its buttons.
      update();
    });
    if (decision !== 'allow') {
      if (decision !== 'deny') window.chatStorage.desktopDecide(conversationId, session.id, 'deny').catch(() => {});
      tc.cu.status = decision === 'deny' ? 'denied' : (decision === 'expired' ? 'expired' : 'stopped');
      tc.status = 'error';
      update();
      if (decision === 'deny') return { text: "RIFIUTATO DALL'UTENTE: non ha consentito l'uso del computer. Non richiederlo da solo: spiega cosa volevi fare e chiedi come procedere.", error: true };
      if (decision === 'expired') return { text: "RIFIUTATO: l'utente non ha risposto alla richiesta di usare il computer. Non richiederlo da solo.", error: true };
      return { text: "INTERROTTO: l'utente ha fermato la risposta prima di decidere.", error: true };
    }

    // 2. The desktop starts (the first time the image is also built).
    const abort = new AbortController();
    const stopAll = () => (running.has(callId) ? stop(callId) : abort.abort());
    signal?.addEventListener('abort', stopAll, { once: true });
    running.set(callId, { conversationId, sessionId: session.id, abort });
    tc.cu.status = 'starting';
    tc.status = 'executing';
    update();
    let state;
    try {
      state = await window.chatStorage.desktopDecide(conversationId, session.id, 'allow');
      while (state.status === 'starting' && !abort.signal.aborted) {
        tc.cu.phase = state.phase;
        update();
        await sleep(700);
        state = await window.chatStorage.desktopStatus(conversationId, session.id);
      }
    } catch (error) {
      state = { status: 'failed', error: error.message };
    }
    if (abort.signal.aborted || state.status !== 'running') {
      running.delete(callId);
      signal?.removeEventListener('abort', stopAll);
      window.chatStorage.desktopEnd(conversationId, session.id, true).catch(() => {});
      tc.cu.status = abort.signal.aborted ? 'stopped' : 'failed';
      tc.cu.error = state.error || null;
      tc.status = 'error';
      update();
      return { text: abort.signal.aborted ? "INTERROTTO dall'utente prima che il computer partisse." : `ERRORE: il computer non è partito (${state.error || state.status}).`, error: true };
    }
    tc.cu.status = 'running';
    tc.cu.phase = null;
    update();
    live();

    // 3. The session.
    let outcome;
    try {
      outcome = await loop({ tc, goal, conversationId, sessionId: session.id, installed: state.installed || [], network: state.network, modelId, apiKey, registry, abort: abort.signal, update });
    } catch (error) {
      outcome = { text: abort.signal.aborted ? "INTERROTTO dall'utente con il pulsante Stop. Riferisci cosa era stato fatto fin lì, senza riprovare da solo." : `ERRORE durante la sessione: ${error.message}`, error: true };
    }
    // The last picture stays in the card after the desktop closes.
    await grab(conversationId, session.id, 1280).catch(() => {});
    running.delete(callId);
    signal?.removeEventListener('abort', stopAll);
    await window.chatStorage.desktopEnd(conversationId, session.id, abort.signal.aborted).catch(() => {});
    tc.cu.status = abort.signal.aborted ? 'stopped' : (outcome.error ? 'failed' : 'done');
    tc.cu.result = outcome.result || null;
    tc.status = outcome.error ? 'error' : 'complete';
    update();
    return outcome;
  }

  async function loop({ tc, goal, conversationId, sessionId, installed, network, modelId, apiKey, registry, abort, update }) {
    const model = window.openRouterCatalog?.models?.find(m => m.id === modelId);
    const canSee = Boolean(model?.inputModalities?.includes('image'));
    const locale = window.i18n?.getLocale?.() === 'en' ? 'en' : 'it';
    const act = request => window.chatStorage.desktopAct(conversationId, sessionId, request);
    const labels = new Map();   // element number -> how it reads in the list
    const learn = tree => {
      for (const line of String(tree || '').split('\n')) {
        const match = /^\s*\[(\d+)\]\s+(.+?)(?:\s+=\s+"|\s+\(|$)/.exec(line);
        if (match) labels.set(Number(match[1]), match[2].trim());
      }
    };
    const step = (icon, text, extra = {}) => {
      tc.cu.steps.push({ icon, text: String(text).slice(0, 240), at: Date.now(), ...extra });
      update();
    };

    // The first screen, with the page asked for already open.
    let first;
    if (tc.cu.startUrl) {
      const browser = installed.find(app => /firefox|browser|chrom/i.test(`${app.id} ${app.name}`));
      if (browser) {
        step('fa-window-maximize', t('cu.stepOpen', { app: browser.name }) + ` — ${tc.cu.startUrl}`);
        first = await act({ cmd: 'open', app: browser.id, args: [tc.cu.startUrl] });
      }
    }
    if (!first) first = await act({ cmd: 'tree' });
    learn(first.tree);

    const messages = [
      { role: 'system', content: systemPrompt({ installed, network, canSee, locale }) },
      { role: 'user', content: `GOAL:\n${goal}\n\nSCREEN NOW:\n${first.tree}` }
    ];
    const tools = sessionTools(canSee);

    for (let turn = 1; turn <= MAX_STEPS; turn++) {
      if (abort.aborted) throw new Error('stopped');
      forgetOldScreens(messages);
      const answer = await callModel({ modelId, apiKey, registry, messages, tools, abort, conversationId });
      const message = answer.choices?.[0]?.message || {};
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const said = typeof message.content === 'string' ? message.content.trim() : '';
      messages.push({ role: 'assistant', content: said || null, ...(calls.length ? { tool_calls: calls } : {}) });
      if (said && calls.length) step('fa-comment', said, { note: true });
      if (!calls.length) {
        // A model that answers in words instead of calling finish has finished.
        if (said) { step('fa-flag-checkered', t('cu.stepFinish')); return { text: said, result: said }; }
        messages.push({ role: 'user', content: 'Use the tools: act on the screen, or call finish with the result.' });
        continue;
      }
      const pictures = [];
      for (const call of calls) {
        if (abort.aborted) throw new Error('stopped');
        let input = {};
        try { input = JSON.parse(call.function?.arguments || '{}'); } catch {}
        const name = call.function?.name;
        if (name === 'finish') {
          const result = String(input.result || said || '').trim() || 'Sessione terminata senza risultato.';
          step('fa-flag-checkered', t('cu.stepFinish'));
          return { text: `Risultato della sessione al computer:\n${result}`, result };
        }
        let reply;
        try {
          reply = await perform(name, input, { act, labels, step, sessionId, conversationId });
        } catch (error) {
          reply = { text: `ERRORE: ${error.message}` };
          step('fa-triangle-exclamation', error.message, { error: true });
        }
        if (reply.tree) learn(reply.tree);
        if (reply.picture) pictures.push(reply.picture);
        messages.push({ role: 'tool', tool_call_id: call.id, content: reply.tree ? `${reply.text}\n\nSCREEN NOW:\n${reply.tree}` : reply.text, screen: Boolean(reply.tree) });
      }
      if (pictures.length) {
        messages.push({ role: 'user', content: [{ type: 'text', text: 'The screen (1280×800):' }, ...pictures.map(url => ({ type: 'image_url', image_url: { url } }))], picture: true });
      }
    }
    step('fa-hourglass-end', t('cu.stepLimit', { count: MAX_STEPS }), { error: true });
    return { text: `La sessione si è fermata dopo ${MAX_STEPS} passi senza chiamare finish: l'obiettivo potrebbe non essere raggiunto. Ultimi passi: ${tc.cu.steps.slice(-5).map(s => s.text).join(' · ')}`, error: false };
  }

  /** One tool of the session, as a desktop action; what the step line says, and what the model reads back. */
  // The accessibility roles, as the step lines say them to the user; the model reads them as they are.
  const ROLE_KEYS = ['push button', 'button', 'toggle button', 'entry', 'password text', 'text', 'link', 'menu item', 'menu', 'check box', 'radio button', 'combo box', 'page tab', 'list item', 'heading', 'label', 'frame', 'dialog', 'document web', 'icon', 'table cell', 'spin button', 'slider'];
  function spoken(label) {
    const role = ROLE_KEYS.find(key => label === key || label.startsWith(`${key} `));
    if (!role) return label;
    const said = t(`cu.role.${role.replace(/ /g, '_')}`);
    return said.startsWith('cu.role.') ? label : `${said}${label.slice(role.length)}`;
  }

  async function perform(name, input, { act, labels, step, sessionId, conversationId }) {
    const label = el => spoken(labels.get(Number(el)) || `[${el}]`);
    let request;
    let line;
    switch (name) {
      case 'open_app':
        request = { cmd: 'open', app: input.app, ...(input.url ? { args: [String(input.url)] } : {}) };
        line = ['fa-window-maximize', t('cu.stepOpen', { app: input.app }) + (input.url ? ` — ${input.url}` : '')];
        break;
      case 'click':
        request = { cmd: 'click', el: Number(input.element), button: input.button || 'left', count: input.double ? 2 : 1 };
        line = ['fa-arrow-pointer', t('cu.stepClick', { what: label(input.element) })];
        break;
      case 'click_point':
        request = { cmd: 'click_at', x: Number(input.x), y: Number(input.y), button: input.button || 'left', count: input.double ? 2 : 1 };
        line = ['fa-crosshairs', t('cu.stepClickPoint', { x: input.x, y: input.y })];
        break;
      case 'type': {
        request = { cmd: 'type', text: String(input.text ?? ''), replace: Boolean(input.replace), submit: Boolean(input.submit), ...(input.element !== undefined && input.element !== null ? { el: Number(input.element) } : {}) };
        const shown = String(input.text ?? '').length > 60 ? `${String(input.text).slice(0, 60)}…` : String(input.text ?? '');
        line = ['fa-keyboard', input.element !== undefined && input.element !== null ? t('cu.stepTypeIn', { text: shown, what: label(input.element) }) : t('cu.stepType', { text: shown })];
        break;
      }
      case 'press_keys':
        request = { cmd: 'key', keys: String(input.keys || '') };
        line = ['fa-keyboard', t('cu.stepKeys', { keys: input.keys })];
        break;
      case 'scroll':
        request = { cmd: 'scroll', direction: input.direction || 'down', amount: Number(input.amount) || 5, ...(input.element ? { el: Number(input.element) } : {}) };
        line = ['fa-arrows-up-down', t('cu.stepScroll', { direction: t(`cu.dir.${input.direction || 'down'}`) })];
        break;
      case 'wait':
        request = { cmd: 'wait', seconds: Math.max(1, Math.min(Number(input.seconds) || 2, 10)) };
        line = ['fa-hourglass-half', t('cu.stepWait', { seconds: request.seconds })];
        break;
      case 'look': {
        step('fa-eye', t('cu.stepLook'));
        const blob = await window.chatStorage.desktopScreen(conversationId, sessionId, 1280);
        return { text: 'Picture of the screen attached below.', picture: await toDataUrl(blob) };
      }
      default:
        return { text: `ERRORE: strumento sconosciuto ${name}` };
    }
    step(...line);
    const answer = await act(request);
    if (answer.ok === false) {
      step('fa-triangle-exclamation', answer.error || t('cu.stepFailed'), { error: true });
      return { text: `NOT DONE: ${answer.error || 'failed'}`, tree: answer.tree };
    }
    return { text: answer.note ? `Done. ${answer.note}` : 'Done.', tree: answer.tree };
  }

  /** Earlier screens are left out of what is sent: only the last one says how things are now. */
  function forgetOldScreens(messages) {
    let lastScreen = -1;
    let lastPicture = -1;
    messages.forEach((m, i) => { if (m.screen) lastScreen = i; if (m.picture) lastPicture = i; });
    messages.forEach((m, i) => {
      if (m.screen && i !== lastScreen && typeof m.content === 'string') {
        m.content = m.content.replace(/\n\nSCREEN NOW:\n[\s\S]*$/, '\n\n(screen of that moment left out)');
        m.screen = false;
      }
      if (m.picture && i !== lastPicture) {
        m.content = '(picture of an earlier screen left out)';
        m.picture = false;
      }
    });
  }

  async function callModel({ modelId, apiKey, registry, messages, tools, abort, conversationId }) {
    const payload = {
      model: modelId,
      messages: messages.map(({ screen, picture, ...m }) => m),
      tools,
      tool_choice: 'auto',
      stream: false
    };
    const params = registry?.getModelParameters?.(modelId) || {};
    const model = window.openRouterCatalog?.models?.find(m => m.id === modelId);
    const supported = model?.supportedParameters || [];
    if (params.temperature !== undefined && supported.includes('temperature')) payload.temperature = Number(params.temperature);
    if (params.reasoning_effort && params.reasoning_effort !== 'default' && (supported.includes('reasoning') || supported.includes('reasoning_effort'))) payload.reasoning = { effort: params.reasoning_effort };
    if (conversationId) payload.session_id = `${conversationId}-computer`;
    const response = await window.modelGateway.fetchChat({
      method: 'POST',
      registry,
      track: { conversationId, role: 'computer_use' },
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://synthorg.local',
        'X-Title': 'SynthOrg Computer Use'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.any ? AbortSignal.any([abort, AbortSignal.timeout(180000)]) : abort
    });
    if (!response.ok) throw new Error(`modello (${response.status}): ${(await response.text()).slice(0, 300)}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || 'errore del modello');
    return data;
  }

  /* ---------------------------------------------------------- the user's answer */

  function decide(callId, decision) {
    const entry = asking.get(callId);
    if (!entry) return;
    entry.resolve(decision === 'allow' ? 'allow' : 'deny');
    if (decision !== 'allow') {
      window.chatStorage.desktopDecide(entry.conversationId, entry.tc.cu.sessionId, 'deny').catch(() => {});
    }
  }

  function stop(callId) {
    const entry = running.get(callId);
    if (!entry) return decide(callId, 'deny');
    entry.abort.abort();
    // The desktop closes now, not after the action in progress: that action ends with it.
    window.chatStorage.desktopEnd(entry.conversationId, entry.sessionId, true).catch(() => {});
  }

  /**
   * A question whose card is not on screen (the chat of the Realtime tasks, a
   * chat left for another) is asked in a box above everything, so nothing
   * waits unseen.
   */
  function refreshAsk() {
    let box = document.getElementById('cu-ask-float');
    const unseen = [...asking.entries()].filter(([callId]) => {
      const card = document.querySelector(`.cu-card[data-cu-call="${CSS.escape(callId)}"]`);
      return !card || !card.offsetParent;
    });
    if (!unseen.length) { box?.remove(); return; }
    if (!box) {
      box = document.createElement('div');
      box.id = 'cu-ask-float';
      box.className = 'cu-ask-float';
      document.body.appendChild(box);
      box.addEventListener('click', event => {
        const button = event.target.closest('[data-cu-decide]');
        if (button) decide(button.dataset.cuCall, button.dataset.cuDecide);
      });
    }
    const [callId, entry] = unseen[0];
    box.innerHTML = `
      <div class="cu-ask-float-title"><i class="fa-solid fa-display"></i> ${esc(t('cu.askTitle'))}</div>
      <div class="cu-goal">${esc(entry.tc.cu.goal)}</div>
      ${meta(entry.tc.cu)}
      <div class="cu-ask-note">${esc(t('cu.askNote'))}</div>
      <div class="cu-ask-actions">
        <button type="button" class="btn" data-cu-call="${esc(callId)}" data-cu-decide="deny"><i class="fa-solid fa-xmark"></i> ${esc(t('chat.deny'))}</button>
        <button type="button" class="btn btn-primary" data-cu-call="${esc(callId)}" data-cu-decide="allow"><i class="fa-solid fa-check"></i> ${esc(t('cu.allow'))}</button>
      </div>
      ${unseen.length > 1 ? `<div class="cu-ask-more">${esc(t('cu.askMore', { count: unseen.length - 1 }))}</div>` : ''}`;
  }
  setInterval(() => { if (asking.size) refreshAsk(); }, 1000);

  /* --------------------------------------------------------------- the card */

  function meta(cu) {
    const parts = [
      `<span class="cu-chip ${cu.network ? 'is-on' : ''}"><i class="fa-solid fa-globe"></i> ${esc(cu.network ? t('cu.netOn') : t('cu.netOff'))}</span>`,
      ...(cu.apps || []).map(app => `<span class="cu-chip"><i class="fa-solid fa-window-maximize"></i> ${esc(app)}</span>`)
    ];
    return `<div class="cu-meta">${parts.join('')}</div>`;
  }

  function stateLabel(cu, callId) {
    const live = running.has(callId);
    switch (cu.status) {
      case 'awaiting': return asking.has(callId) ? t('cu.stateAwaiting') : t('cu.stateInterrupted');
      case 'starting': return live ? t(`cu.phase.${cu.phase || 'engine'}`) : t('cu.stateInterrupted');
      case 'running': return live ? t('cu.stateRunning', { count: cu.steps.length }) : t('cu.stateInterrupted');
      case 'done': return t('cu.stateDone', { count: cu.steps.length });
      case 'denied': return t('cu.stateDenied');
      case 'expired': return t('cu.stateExpired');
      case 'stopped': return t('cu.stateStopped');
      default: return cu.error ? `${t('cu.stateFailed')}: ${cu.error}` : t('cu.stateFailed');
    }
  }

  function stepsHtml(cu, limit) {
    const steps = limit ? cu.steps.slice(-limit) : cu.steps;
    const hidden = cu.steps.length - steps.length;
    return `
      <ol class="cu-steps">
        ${hidden > 0 ? `<li class="cu-step is-more">${esc(t('cu.moreSteps', { count: hidden }))}</li>` : ''}
        ${steps.map(s => `<li class="cu-step${s.error ? ' is-error' : ''}${s.note ? ' is-note' : ''}"><i class="fa-solid ${esc(s.icon)}"></i><span>${esc(s.text)}</span></li>`).join('')}
      </ol>`;
  }

  /** The card inside the tool call. */
  function render(tc) {
    const cu = tc.cu;
    if (!cu) return '';
    const callId = tc.id;
    const view = views.get(callId) || 'collapsed';
    const live = running.has(callId);
    const waiting = cu.status === 'awaiting' && asking.has(callId);
    const picture = pictures.get(cu.sessionId);
    const busy = live || waiting;
    const icon = cu.status === 'done' ? 'fa-circle-check' : (['failed', 'denied', 'expired', 'stopped'].includes(cu.status) || (!busy && cu.status !== 'done') ? 'fa-circle-minus' : (waiting ? 'fa-hand' : 'fa-circle-notch fa-spin'));
    return `
      <div class="cu-card is-${view}${live ? ' is-live' : ''}" data-cu-call="${esc(callId)}">
        <div class="cu-head">
          <span class="cu-title"><i class="fa-solid fa-display"></i> ${esc(t('cu.title'))}</span>
          <span class="cu-state"><i class="fa-solid ${icon}"></i> ${esc(stateLabel(cu, callId))}</span>
          <span class="cu-head-actions">
            ${(live || picture) && cu.status !== 'awaiting' ? `
              <button type="button" class="cu-icon-btn" data-cu-action="view" title="${esc(view === 'collapsed' ? t('cu.showScreen') : t('cu.showSteps'))}"><i class="fa-solid ${view === 'collapsed' ? 'fa-display' : 'fa-list'}"></i></button>
              <button type="button" class="cu-icon-btn" data-cu-action="full" title="${esc(t('cu.fullscreen'))}"><i class="fa-solid fa-expand"></i></button>` : ''}
            ${live ? `<button type="button" class="cu-icon-btn is-stop" data-cu-action="stop" title="${esc(t('cu.stop'))}"><i class="fa-solid fa-stop"></i></button>` : ''}
          </span>
        </div>
        <div class="cu-goal">${esc(cu.goal)}</div>
        ${meta(cu)}
        ${waiting ? `
          <div class="cu-ask">
            <div class="cu-ask-note">${esc(t('cu.askNote'))}</div>
            <div class="cu-ask-actions">
              <button type="button" class="btn" data-cu-action="deny"><i class="fa-solid fa-xmark"></i> ${esc(t('chat.deny'))}</button>
              <button type="button" class="btn btn-primary" data-cu-action="allow"><i class="fa-solid fa-check"></i> ${esc(t('cu.allow'))}</button>
            </div>
          </div>` : ''}
        ${view === 'expanded' && (live || picture) ? `
          <div class="cu-screen" data-cu-action="full">
            ${picture ? `<img alt="" data-cu-screen="${esc(cu.sessionId)}" src="${picture}">` : `<div class="cu-screen-wait" data-cu-screen-wait="${esc(cu.sessionId)}"><i class="fa-solid fa-circle-notch fa-spin"></i></div>`}
          </div>` : ''}
        ${cu.steps.length ? stepsHtml(cu, view === 'collapsed' ? STEPS_SHOWN_COLLAPSED : 0) : ''}
        ${cu.result && cu.status === 'done' ? `<div class="cu-result">${esc(cu.result)}</div>` : ''}
      </div>`;
  }

  // The card's buttons, wherever the card is.
  document.addEventListener('click', event => {
    const button = event.target.closest('.cu-card [data-cu-action]');
    if (!button) return;
    event.stopPropagation();
    const card = button.closest('.cu-card');
    const callId = card.dataset.cuCall;
    const action = button.dataset.cuAction;
    if (action === 'allow' || action === 'deny') decide(callId, action);
    else if (action === 'stop') stop(callId);
    else if (action === 'view') {
      views.set(callId, (views.get(callId) || 'collapsed') === 'collapsed' ? 'expanded' : 'collapsed');
      rerender(callId);
      live();
    } else if (action === 'full') openFull(callId);
  });

  function rerender(callId) {
    const target = callbacks.get(callId);
    if (target?.onUpdate) target.onUpdate();
    else window.chatManager?.render?.();
  }

  // Each running call's redraw, so a button on its card can redraw it.
  const callbacks = new Map();
  function bind(callId, onUpdate, tc) { callbacks.set(callId, { onUpdate, tc }); }

  /* ---------------------------------------------------- the screen, full window */

  function openFull(callId) {
    const entry = callbacks.get(callId);
    const cu = entry?.tc?.cu;
    if (!cu) return;
    fullscreen = callId;
    let layer = document.getElementById('cu-full');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'cu-full';
      layer.className = 'cu-full';
      document.body.appendChild(layer);
      layer.addEventListener('click', event => {
        const button = event.target.closest('[data-cu-full]');
        if (!button) return;
        if (button.dataset.cuFull === 'close') closeFull();
        if (button.dataset.cuFull === 'stop') stop(fullscreen);
      });
      document.addEventListener('keydown', event => { if (event.key === 'Escape' && fullscreen) closeFull(); });
    }
    paintFull();
    layer.classList.add('is-open');
    live();
  }

  function paintFull() {
    const layer = document.getElementById('cu-full');
    const entry = callbacks.get(fullscreen);
    const cu = entry?.tc?.cu;
    if (!layer || !cu) return;
    const picture = pictures.get(cu.sessionId);
    const liveNow = running.has(fullscreen);
    layer.innerHTML = `
      <div class="cu-full-bar">
        <span class="cu-title"><i class="fa-solid fa-display"></i> ${esc(t('cu.title'))}</span>
        <span class="cu-full-goal">${esc(cu.goal)}</span>
        <span class="cu-state">${esc(stateLabel(cu, fullscreen))}</span>
        ${liveNow ? `<button type="button" class="btn btn-sm cu-full-stop" data-cu-full="stop"><i class="fa-solid fa-stop"></i> ${esc(t('cu.stop'))}</button>` : ''}
        <button type="button" class="cu-icon-btn" data-cu-full="close" title="${esc(t('cu.closeFull'))}"><i class="fa-solid fa-compress"></i></button>
      </div>
      <div class="cu-full-body">
        <div class="cu-full-screen">${picture ? `<img alt="" data-cu-screen="${esc(cu.sessionId)}" src="${picture}">` : '<i class="fa-solid fa-circle-notch fa-spin"></i>'}</div>
        <aside class="cu-full-steps">${stepsHtml(cu, 0)}${cu.result && cu.status === 'done' ? `<div class="cu-result">${esc(cu.result)}</div>` : ''}</aside>
      </div>`;
    const list = layer.querySelector('.cu-full-steps');
    if (list) list.scrollTop = list.scrollHeight;
  }

  function closeFull() {
    fullscreen = null;
    document.getElementById('cu-full')?.classList.remove('is-open');
  }

  /* ------------------------------------------------------------ the live view */

  let liveLoop = null;
  /** Pictures of the screens someone is looking at: the expanded cards and the full window. */
  function live() {
    if (liveLoop) return;
    liveLoop = (async () => {
      while (true) {
        const wanted = [...running.entries()].filter(([callId]) =>
          fullscreen === callId || (views.get(callId) === 'expanded' && document.querySelector(`.cu-card[data-cu-call="${CSS.escape(callId)}"]`)?.offsetParent));
        if (!wanted.length) break;
        await Promise.all(wanted.map(([callId, entry]) => grab(entry.conversationId, entry.sessionId, fullscreen === callId ? 1600 : 960).catch(() => {})));
        await sleep(LIVE_INTERVAL_MS);
      }
      liveLoop = null;
    })();
  }

  async function grab(conversationId, sessionId, width) {
    const blob = await window.chatStorage.desktopScreen(conversationId, sessionId, width);
    const url = URL.createObjectURL(blob);
    const old = pictures.get(sessionId);
    pictures.set(sessionId, url);
    let shown = false;
    document.querySelectorAll(`img[data-cu-screen="${CSS.escape(sessionId)}"]`).forEach(img => { img.src = url; shown = true; });
    document.querySelectorAll(`[data-cu-screen-wait="${CSS.escape(sessionId)}"]`).forEach(box => {
      box.outerHTML = `<img alt="" data-cu-screen="${esc(sessionId)}" src="${url}">`;
      shown = true;
    });
    if (fullscreen && !document.querySelector(`#cu-full img[data-cu-screen="${CSS.escape(sessionId)}"]`)) paintFull();
    // The old picture goes once nothing shows it any more.
    if (old) setTimeout(() => URL.revokeObjectURL(old), shown ? 2000 : 0);
  }

  /* ------------------------------------------------------------------ utils */

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function toDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  window.computerUse = {
    spec: () => JSON.parse(JSON.stringify(TOOL_SPEC)),
    /** Runs the call; keeps the card's update callback so its buttons can redraw it. */
    run: options => {
      const callId = options.tc.id || `cu_${Date.now()}`;
      options.tc.id = callId;
      const onUpdate = () => {
        options.onUpdate?.();
        if (fullscreen === callId) paintFull();
      };
      bind(callId, onUpdate, options.tc);
      return run({ ...options, onUpdate });
    },
    render,
    decide,
    stop,
    _state: { running, asking, views, pictures }
  };
})();
