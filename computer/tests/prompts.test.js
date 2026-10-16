const test = require('node:test');
const assert = require('node:assert/strict');
const { PromptManager, DEFAULT_PROMPT_SECTIONS, SYNTHORG_CORE_HIDDEN_PROMPT } = require('../resources/js/prompts.js');

test('PromptManager: initializes with default sections and short mode', () => {
  const pm = new PromptManager();
  assert.equal(pm.sections.length, 4);

  const identitySec = pm.getSection('identity');
  assert.ok(identitySec);
  assert.equal(identitySec.defaultMode, 'short');

  const text = pm.getSectionText('identity');
  assert.equal(text, identitySec.presets.short);
});

test('PromptManager: switches between short and long modes', () => {
  const pm = new PromptManager();
  const identitySec = pm.getSection('identity');

  pm.setSectionMode('identity', 'long');
  assert.equal(pm.getSectionText('identity'), identitySec.presets.long);

  pm.setSectionMode('identity', 'short');
  assert.equal(pm.getSectionText('identity'), identitySec.presets.short);
});

test('PromptManager: custom text editing and resetting', () => {
  const pm = new PromptManager();
  const customStr = 'Rispondi sempre come un robot futuristico.';

  pm.setSectionCustomText('identity', customStr);
  assert.equal(pm.getSectionState('identity').mode, 'custom');
  assert.equal(pm.getSectionText('identity'), customStr);

  // Resetting section
  pm.resetSection('identity');
  assert.equal(pm.getSectionState('identity').mode, 'short');
  assert.equal(pm.getSectionText('identity'), pm.getSection('identity').presets.short);
});

test('PromptManager: compileSystemPrompt includes hidden core context and all sections', () => {
  const pm = new PromptManager();
  const compiled = pm.compileSystemPrompt({
    modelId: 'anthropic/claude-3.7-sonnet',
    isChatOffline: false,
    memories: [{ content: 'User prefers dark mode', scope: 'global' }],
    toolsSection: '\n\n[AVAILABLE TOOLS]\n- web_search: Web Search'
  });

  // Check hidden core
  assert.ok(compiled.includes('[SYNTHORG SYSTEM ENVIRONMENT]'));
  assert.ok(compiled.includes('anthropic/claude-3.7-sonnet'));

  // Check directives & sections
  assert.ok(compiled.includes('[OPERATIONAL DIRECTIVES]'));
  assert.ok(compiled.includes('Identità & Tono'));
  assert.ok(compiled.includes('Stile di Risposta & Formattazione'));

  // Check memory separation
  assert.ok(compiled.includes('[GLOBAL USER DOSSIER]'));
  assert.ok(compiled.includes('User prefers dark mode'));

  // Check network state
  assert.ok(compiled.includes('Internet access is ENABLED'));

  // Check tools
  assert.ok(compiled.includes('[AVAILABLE TOOLS]'));

  // Check includeHidden: false excludes the hidden core prompt
  const compiledWithoutHidden = pm.compileSystemPrompt({
    modelId: 'anthropic/claude-3.7-sonnet',
    isChatOffline: false,
    includeHidden: false
  });
  assert.equal(compiledWithoutHidden.includes('[SYNTHORG SYSTEM ENVIRONMENT]'), false);
  assert.ok(compiledWithoutHidden.includes('[OPERATIONAL DIRECTIVES]'));
});

test('PromptManager: compiles localized system prompts in Italian and English', () => {
  const pm = new PromptManager();

  // Test Italian prompt compilation
  const itPrompt = pm.compileSystemPrompt({
    modelId: 'openai/gpt-4o',
    isChatOffline: true,
    locale: 'it',
    memories: [{ content: 'L\'utente preferisce codice commentato in italiano', scope: 'global' }],
    chatItems: [{ content: 'Primo turno di prova', sourceMessageId: 'm1' }],
    packages: [{ name: 'numpy', version: '1.26.4', title: 'Calcolo Scientifico' }],
    toolsSection: '\n\n[STRUMENTI DISPONIBILI]\n- web_search: Ricerca Web'
  });

  assert.ok(itPrompt.includes('[AMBIENTE DI SISTEMA SYNTHORG]'), 'Core prompt must be in Italian');
  assert.ok(itPrompt.includes('Sei il Master Orchestrator di SynthOrg'), 'Identity preset must be in Italian');
  assert.ok(itPrompt.includes('[DIRETTIVE OPERATIVE]'), 'Directives header must be in Italian');
  assert.ok(itPrompt.includes('[DOSSIER GLOBALE UTENTE]'), 'Dossier header must be in Italian');
  assert.ok(itPrompt.includes('L\'utente preferisce codice commentato in italiano'));
  assert.ok(itPrompt.includes('[CRONOLOGIA CONVERSAZIONE ATTIVA]'), 'Timeline header must be in Italian');
  assert.ok(itPrompt.includes('Turno #1 [msg_id: m1]'), 'Turn label must be in Italian');
  assert.ok(itPrompt.includes('[PACCHETTI AMBIENTE PRE-INSTALLATI]'), 'Packages header must be in Italian');
  assert.ok(itPrompt.includes('[ACCESSO RETE AMBIENTE: L\'accesso a Internet è attualmente DISABILITATO'), 'Offline notice must be in Italian');
  assert.ok(itPrompt.includes('[STRUMENTI DISPONIBILI]'));

  // Test English prompt compilation
  const enPrompt = pm.compileSystemPrompt({
    modelId: 'openai/gpt-4o',
    isChatOffline: false,
    locale: 'en',
    memories: [{ content: 'User prefers concise python code', scope: 'global' }],
    chatItems: [{ content: 'First test turn', sourceMessageId: 'm2' }],
    packages: [{ name: 'pandas', version: '2.2.1', title: 'Data Analysis' }]
  });

  assert.ok(enPrompt.includes('[SYNTHORG SYSTEM ENVIRONMENT]'), 'Core prompt must be in English');
  assert.ok(enPrompt.includes('You are SynthOrg Master Orchestrator'), 'Identity preset must be in English');
  assert.ok(enPrompt.includes('[OPERATIONAL DIRECTIVES]'), 'Directives header must be in English');
  assert.ok(enPrompt.includes('[GLOBAL USER DOSSIER]'), 'Dossier header must be in English');
  assert.ok(enPrompt.includes('[CHAT CONVERSATION TIMELINE]'), 'Timeline header must be in English');
  assert.ok(enPrompt.includes('Turn #1 [msg_id: m2]'), 'Turn label must be in English');
  assert.ok(enPrompt.includes('[PRE-INSTALLED ENVIRONMENT PACKAGES]'), 'Packages header must be in English');
  assert.ok(enPrompt.includes('[ENVIRONMENT NETWORK: Internet access is ENABLED'), 'Online notice must be in English');
});
