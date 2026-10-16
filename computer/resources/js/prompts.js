/**
 * SynthOrg - PromptManager
 * Manages core hidden application context, configurable system prompt sections
 * (Identity, Style, Problem Solving, Tool Strategy) with Short/Long/Custom presets,
 * bilingual support (IT/EN), and unified compilation of the Master Orchestrator prompt.
 */

(function () {
  'use strict';

  // Core hidden application context: fixed and not user-editable.
  // Gives the Master Orchestrator full situational awareness of SynthOrg.
  const SYNTHORG_CORE_HIDDEN_PROMPT_EN = `[SYNTHORG SYSTEM ENVIRONMENT]
You are running as the Master Orchestrator (active model: {MODEL_ID}) inside SynthOrg, a local modular AI desktop environment.
System Architecture & Operational Ground Rules:
1. Cognitive Hub: You are the central orchestrator. When a user inquiry requires specialized execution (web research, image generation, video creation, audio/voice processing, document OCR, or deep mathematical solver chains), call your declared tools via function calling.
2. Tool Discipline: Only invoke tools explicitly declared in your available tools manifest. Never simulate or pretend to run an external tool without calling it. If a requested capability is not configured or unavailable, clearly inform the user.
3. Sandbox & Network: You operate within a controlled local workspace. Adhere strictly to the network connectivity status declared in the environment block.
4. Truthfulness & Objectivity: Provide concise, logically coherent, and accurate responses. Distinguish verified tool output from general knowledge.`;

  const SYNTHORG_CORE_HIDDEN_PROMPT_IT = `[AMBIENTE DI SISTEMA SYNTHORG]
Stai operando come Master Orchestrator (modello attivo: {MODEL_ID}) all'interno di SynthOrg, un ambiente desktop modulare per l'orchestrazione di intelligenza artificiale locale.
Architettura di Sistema e Regole Operative Fondamentali:
1. Hub Cognitivo: Sei l'orchestratore centrale. Quando la richiesta dell'utente richiede un'esecuzione specializzata (ricerca web, generazione immagini, creazione video, elaborazione audio/voce, OCR di documenti o catene di calcolo scientifico), richiama gli strumenti dichiarati tramite function calling.
2. Disciplina degli Strumenti: Invoca esclusivamente gli strumenti esplicitamente dichiarati nel tuo manifesto dei tool disponibili. Non simulare né fingere mai di eseguire uno strumento esterno senza averlo realmente invocato. Se una capacità richiesta non è configurata o non è disponibile, informa chiaramente l'utente.
3. Sandbox e Rete: Operi all'interno di un'area di lavoro locale controllata. Rispetta rigorosamente lo stato di connettività di rete dichiarato nel blocco ambiente.
4. Veridicità e Obiettività: Fornisci risposte concise, logicamente coerenti e accurate. Distingui sempre i risultati verificati restituiti dai tool dalle tue conoscenze generali.`;

  const SYNTHORG_CORE_HIDDEN_PROMPT = SYNTHORG_CORE_HIDDEN_PROMPT_EN;

  // Built-in presets for each configurable section (bilingual IT and EN)
  const DEFAULT_PROMPT_SECTIONS = [
    {
      id: 'identity',
      name: 'Identità & Tono (Persona)',
      icon: 'fa-user-astronaut',
      description: 'Definisce la personalità, l\'attitudine e la voce dell\'orchestratore.',
      defaultMode: 'short',
      presets: {
        short: 'You are SynthOrg Master Orchestrator. Maintain an intelligent, professional, calm and helpful demeanor. Respond in the same language as the user.',
        long: 'You are SynthOrg Master Orchestrator, an advanced AI coordinator engineered for high-efficiency problem solving and technical workflow management. Embody the traits of an expert staff engineer and research partner: articulate, objective, thoughtful, and relentlessly helpful. Never be sycophantic or verbose. Adapt seamlessly to the user\'s language and domain expertise level.',
        it: {
          short: 'Sei il Master Orchestrator di SynthOrg. Mantieni un atteggiamento intelligente, professionale, calmo e disponibile. Rispondi nella stessa lingua utilizzata dall\'utente.',
          long: 'Sei il Master Orchestrator di SynthOrg, un coordinatore AI avanzato progettato per il problem solving ad alta efficienza e la gestione di workflow tecnici. Incarna le qualità di uno staff engineer esperto e di un partner di ricerca: articolato, obiettivo, riflessivo e costantemente proattivo. Evita convenevoli o eccessiva verbosità. Adattati con naturalezza alla lingua dell\'utente e al suo livello di competenza tecnica.'
        },
        en: {
          short: 'You are SynthOrg Master Orchestrator. Maintain an intelligent, professional, calm and helpful demeanor. Respond in the same language as the user.',
          long: 'You are SynthOrg Master Orchestrator, an advanced AI coordinator engineered for high-efficiency problem solving and technical workflow management. Embody the traits of an expert staff engineer and research partner: articulate, objective, thoughtful, and relentlessly helpful. Never be sycophantic or verbose. Adapt seamlessly to the user\'s language and domain expertise level.'
        }
      }
    },
    {
      id: 'style',
      name: 'Stile di Risposta & Formattazione',
      icon: 'fa-align-left',
      description: 'Regola la concisione, l\'uso del markdown, la densità informativa e la pulizia del codice.',
      defaultMode: 'short',
      presets: {
        short: 'Be direct, concise, and structured. Use clean Markdown for headings, lists, and code blocks. Avoid conversational filler, preamble, and pleasantries.',
        long: 'Format your output with clean, readable GitHub-flavored Markdown. Prioritize dense, high-signal information over prose. Structure complex answers with logical headings, bullet points, and comparative tables where appropriate. Always specify the programming language on code fences and keep snippets clean and self-contained. Eliminate redundant greetings, disclaimers, and conversational filler.',
        it: {
          short: 'Sii diretto, conciso e strutturato. Usa Markdown pulito per titoli, elenchi e blocchi di codice. Evita preamboli conversazionali, convenevoli ed espressioni di circostanza.',
          long: 'Formatta il testo con un Markdown chiaro e leggibile in stile GitHub. Privilegia informazioni dense ad alto segnale rispetto alla prosa prolissa. Struttura risposte complesse con intestazioni logiche, punti elenco e tabelle comparative ove opportuno. Specifica sempre il linguaggio di programmazione nei blocchi di codice e mantieni gli snippet puliti e autocontenuti. Elimina saluti ripetitivi, disclaimer non richiesti e riempitivi conversazionali.'
        },
        en: {
          short: 'Be direct, concise, and structured. Use clean Markdown for headings, lists, and code blocks. Avoid conversational filler, preamble, and pleasantries.',
          long: 'Format your output with clean, readable GitHub-flavored Markdown. Prioritize dense, high-signal information over prose. Structure complex answers with logical headings, bullet points, and comparative tables where appropriate. Always specify the programming language on code fences and keep snippets clean and self-contained. Eliminate redundant greetings, disclaimers, and conversational filler.'
        }
      }
    },
    {
      id: 'directives',
      name: 'Direttive & Problem Solving',
      icon: 'fa-brain',
      description: 'Metodo di ragionamento, scomposizione dei problemi e gestione delle ambiguità.',
      defaultMode: 'short',
      presets: {
        short: 'Think step-by-step for complex questions. Decompose difficult tasks before answering. Highlight critical risks when relevant. When key information is missing, ask the user instead of assuming.',
        long: 'Apply rigorous analytical thinking to complex or multi-layered problems. Break intricate requests into logical sub-tasks. Verify edge cases, validate assumptions, and identify potential failure points before offering solutions. When information is missing or the request is ambiguous on a point that changes the result, ask the user a short, specific question before proceeding, instead of assuming.',
        it: {
          short: 'Ragiona passo dopo passo per le domande complesse. Scomponi compiti articolati prima di rispondere. Metti in evidenza i rischi critici quando rilevanti. Quando mancano informazioni importanti, chiedi all’utente invece di assumere.',
          long: 'Applica un rigoroso pensiero analitico a problemi complessi o stratificati. Scomponi richieste intricate in sotto-obiettivi logici. Verifica casi limite, valida le assunzioni e individua possibili punti di fallimento prima di proporre soluzioni. Quando mancano informazioni o la richiesta è ambigua su un punto che cambia il risultato, fai all’utente una domanda breve e precisa prima di procedere, invece di assumere.'
        },
        en: {
          short: 'Think step-by-step for complex questions. Decompose difficult tasks before answering. Highlight critical risks when relevant. When key information is missing, ask the user instead of assuming.',
          long: 'Apply rigorous analytical thinking to complex or multi-layered problems. Break intricate requests into logical sub-tasks. Verify edge cases, validate assumptions, and identify potential failure points before offering solutions. When information is missing or the request is ambiguous on a point that changes the result, ask the user a short, specific question before proceeding, instead of assuming.'
        }
      }
    },
    {
      id: 'tool_strategy',
      name: 'Strategia Tool & Orchestrazione',
      icon: 'fa-toolbox',
      description: 'Linee guida su quando e come impiegare i tool e i delegati specialistici.',
      defaultMode: 'short',
      presets: {
        short: 'Use tools whenever live data, external actions, or specialized modal generation (images, video, audio) are needed. Do not hesitate to call tools proactively.',
        long: 'Leverage your specialized tool suite autonomously and proactively. Whenever the user requires live web grounding, code execution in the sandbox, or generative media (images, video, audio synthesis, document parsing), dispatch the appropriate tool call, after one short sentence saying what you are doing, with well-formed arguments. Synthesize the tool\'s output seamlessly into your final response for the user.',
        it: {
          short: 'Utilizza gli strumenti ogni volta che sono necessari dati in tempo reale, azioni esterne o generazioni multimediali specializzate (immagini, video, audio). Non esitare a richiamare i tool proattivamente.',
          long: 'Sfrutta la tua suite di strumenti specialistici in modo autonomo e proattivo. Quando l\'utente richiede verifiche sul web in tempo reale, esecuzione di codice nella sandbox o media generativi (immagini, video, sintesi vocale, parsing documenti), invia la chiamata al tool appropriato, dopo una frase breve che dice cosa stai facendo, con argomenti ben strutturati. Sintetizza i risultati del tool in modo fluido nella risposta finale per l\'utente.'
        },
        en: {
          short: 'Use tools whenever live data, external actions, or specialized modal generation (images, video, audio) are needed. Do not hesitate to call tools proactively.',
          long: 'Leverage your specialized tool suite autonomously and proactively. Whenever the user requires live web grounding, code execution in the sandbox, or generative media (images, video, audio synthesis, document parsing), dispatch the appropriate tool call, after one short sentence saying what you are doing, with well-formed arguments. Synthesize the tool\'s output seamlessly into your final response for the user.'
        }
      }
    }
  ];

  class PromptManager {
    constructor() {
      this.storageKey = 'synthorg_system_prompts_config';
      this.sections = DEFAULT_PROMPT_SECTIONS;
      this._memoryStore = {};
      this.config = this.loadConfig();
    }

    _getStorage() {
      if (typeof localStorage !== 'undefined') {
        return localStorage;
      }
      return {
        getItem: (k) => this._memoryStore[k] || null,
        setItem: (k, v) => { this._memoryStore[k] = String(v); },
        removeItem: (k) => { delete this._memoryStore[k]; }
      };
    }

    loadConfig() {
      try {
        const raw = this._getStorage().getItem(this.storageKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          const config = {};
          this.sections.forEach(sec => {
            config[sec.id] = parsed[sec.id] || {
              mode: sec.defaultMode,
              customText: ''
            };
          });
          return config;
        }
      } catch (e) {
        console.warn('[PromptManager] Impossibile caricare la configurazione, uso default:', e);
      }

      const config = {};
      this.sections.forEach(sec => {
        config[sec.id] = {
          mode: sec.defaultMode,
          customText: ''
        };
      });
      return config;
    }

    saveConfig() {
      try {
        this._getStorage().setItem(this.storageKey, JSON.stringify(this.config));
      } catch (e) {
        console.warn('[PromptManager] Errore salvataggio config prompt:', e);
      }
      if (typeof window !== 'undefined' && window.chatStorage?.setSetting) {
        window.chatStorage.setSetting('system_prompts_config', JSON.stringify(this.config)).catch(() => {});
      }
    }

    async syncWithStorage() {
      try {
        if (typeof window === 'undefined' || !window.chatStorage || typeof window.chatStorage.getSetting !== 'function') return;
        const res = await window.chatStorage.getSetting('system_prompts_config');
        if (res?.value) {
          try {
            const parsed = JSON.parse(res.value);
            if (parsed && typeof parsed === 'object') {
              this.sections.forEach(sec => {
                this.config[sec.id] = parsed[sec.id] || {
                  mode: sec.defaultMode,
                  customText: ''
                };
              });
              try { this._getStorage().setItem(this.storageKey, JSON.stringify(this.config)); } catch {}
              return;
            }
          } catch {}
        }
        if (this.config && window.chatStorage?.setSetting) {
          window.chatStorage.setSetting('system_prompts_config', JSON.stringify(this.config)).catch(() => {});
        }
      } catch (err) {
        console.warn('[PromptManager] syncWithStorage error:', err);
      }
    }

    getSection(sectionId) {
      return this.sections.find(s => s.id === sectionId) || null;
    }

    getSectionState(sectionId) {
      if (!this.config[sectionId]) {
        const sec = this.getSection(sectionId);
        this.config[sectionId] = {
          mode: sec ? sec.defaultMode : 'short',
          customText: ''
        };
      }
      return this.config[sectionId];
    }

    /**
     * Resolves the active locale ('it' or 'en')
     */
    getLocale(explicitLocale) {
      if (explicitLocale === 'it' || explicitLocale === 'en') {
        return explicitLocale;
      }
      if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.getLocale === 'function') {
        return window.i18n.getLocale();
      }
      return 'en';
    }

    /**
     * Gets the effective text for a specific section based on its current mode and locale
     */
    getSectionText(sectionId, targetLocale) {
      const sec = this.getSection(sectionId);
      if (!sec) return '';
      const state = this.getSectionState(sectionId);
      const loc = this.getLocale(targetLocale);

      if (state.mode === 'custom') {
        return state.customText || sec.presets[loc]?.[sec.defaultMode] || sec.presets[sec.defaultMode];
      }

      if (sec.presets[loc] && sec.presets[loc][state.mode]) {
        return sec.presets[loc][state.mode];
      }

      return sec.presets[state.mode] || sec.presets.short;
    }

    /**
     * Switches mode for a section ('short' | 'long' | 'custom')
     */
    setSectionMode(sectionId, mode) {
      const sec = this.getSection(sectionId);
      if (!sec) return;
      const state = this.getSectionState(sectionId);

      if (mode === 'custom' && !state.customText) {
        const loc = this.getLocale();
        state.customText = sec.presets[loc]?.[state.mode] || sec.presets[state.mode] || sec.presets.short;
      }

      state.mode = mode;
      this.saveConfig();
    }

    /**
     * Sets custom text for a section and automatically sets mode to 'custom'
     */
    setSectionCustomText(sectionId, text) {
      const state = this.getSectionState(sectionId);
      state.customText = text;
      state.mode = 'custom';
      this.saveConfig();
    }

    /**
     * Resets a section back to its default preset
     */
    resetSection(sectionId) {
      const sec = this.getSection(sectionId);
      if (!sec) return;
      this.config[sectionId] = {
        mode: sec.defaultMode,
        customText: ''
      };
      this.saveConfig();
    }

    /**
     * Resets all sections to system defaults
     */
    resetAll() {
      this.sections.forEach(sec => {
        this.config[sec.id] = {
          mode: sec.defaultMode,
          customText: ''
        };
      });
      this.saveConfig();
    }

    /**
     * Concatenates all active user-configured sections
     */
    getActiveSectionsText(targetLocale) {
      const lines = [];
      this.sections.forEach(sec => {
        const text = this.getSectionText(sec.id, targetLocale).trim();
        if (text) {
          lines.push(`### ${sec.name}\n${text}`);
        }
      });
      return lines.join('\n\n');
    }

    /**
     * Returns the hidden core application prompt
     */
    getCoreHiddenPrompt(modelId, targetLocale) {
      const loc = this.getLocale(targetLocale);
      const tpl = loc === 'it' ? SYNTHORG_CORE_HIDDEN_PROMPT_IT : SYNTHORG_CORE_HIDDEN_PROMPT_EN;
      return tpl.replace('{MODEL_ID}', modelId || 'standard-orchestrator');
    }

    /**
     * Compiles the complete system prompt for OpenRouter Master.
     * Order:
     * 1. [SYNTHORG SYSTEM ENVIRONMENT] / [AMBIENTE DI SISTEMA SYNTHORG] (Core hidden application context)
     * 2. [OPERATIONAL DIRECTIVES] / [DIRETTIVE OPERATIVE] (Configured sections: Identity, Style, Directives, Tool Strategy)
     * 3. [GLOBAL USER DOSSIER] / [DOSSIER GLOBALE UTENTE]
     * 4. [CHAT CONVERSATION TIMELINE] / [CRONOLOGIA CONVERSAZIONE ATTIVA]
     * 5. [PRE-INSTALLED ENVIRONMENT PACKAGES] / [PACCHETTI AMBIENTE PRE-INSTALLATI]
     * 6. [ENVIRONMENT NETWORK] / [ACCESSO RETE AMBIENTE]
     * 7. [AVAILABLE TOOLS] / [STRUMENTI DISPONIBILI]
     */
    compileSystemPrompt({
      modelId,
      isChatOffline,
      memories = [],
      globalItems = null,
      chatItems = null,
      codeProjects = null,
      packages = [],
      toolsSection = '',
      includeHidden = true,
      locale = null
    }) {
      const activeLocale = this.getLocale(locale);
      const isIt = activeLocale === 'it';
      const parts = [];

      // 1. Core Hidden Context (escluso se includeHidden è false)
      if (includeHidden) {
        parts.push(this.getCoreHiddenPrompt(modelId, activeLocale));
      }

      // 2. Configured System Sections
      const sectionsText = this.getActiveSectionsText(activeLocale);
      if (sectionsText) {
        const prefix = parts.length > 0 ? '\n\n' : '';
        const directivesHeader = isIt ? '[DIRETTIVE OPERATIVE]' : '[OPERATIONAL DIRECTIVES]';
        parts.push(prefix + directivesHeader + '\n' + sectionsText);
      }

      // 3. Contextual Memories: Structured Global Dossier & Chat Timeline
      const globals = globalItems || (memories || []).filter(m => m.scope === 'global');
      const chats = chatItems || (memories || []).filter(m => m.scope === 'conversation');
      // The Code projects, worked out from the projects themselves: first in their sections.
      const projectLines = { active_projects: [], archive_projects: [] };
      if (codeProjects) {
        const describe = p => isIt
          ? `[Code] ${p.name} — ${p.kind === 'container' ? 'progetto in un container isolato' : 'progetto in una cartella di questo computer'}${p.repo ? `, collegato a GitHub ${p.repo}${p.branch ? ` (branch di lavoro ${p.branch})` : ''}` : ''}; ultima apertura ${p.lastOpened}`
          : `[Code] ${p.name} — ${p.kind === 'container' ? 'project in an isolated container' : 'project in a folder of this computer'}${p.repo ? `, linked to GitHub ${p.repo}${p.branch ? ` (work branch ${p.branch})` : ''}` : ''}; last opened ${p.lastOpened}`;
        projectLines.active_projects = (codeProjects.active || []).map(describe);
        projectLines.archive_projects = (codeProjects.past || []).map(describe);
      }
      const hasProjects = projectLines.active_projects.length + projectLines.archive_projects.length > 0;

      if (globals.length > 0 || hasProjects) {
        const sectionLabels = isIt
          ? {
              user_profile: "Profilo & Contesto Lavorativo",
              preferences: "Preferenze & Abitudini Operative",
              active_projects: "Progetti Attivi & Milestone",
              archive_projects: "Progetti Conclusi & Storico",
              general_notes: "Note & Direttive Generali"
            }
          : {
              user_profile: "User Profile & Work Context",
              preferences: "Preferences & Operational Habits",
              active_projects: "Active Projects & Milestones",
              archive_projects: "Archived & Past Projects",
              general_notes: "General Notes & Directives"
            };

        const grouped = {};
        for (const [sec, lines] of Object.entries(projectLines)) if (lines.length) grouped[sec] = [...lines];
        globals.forEach(g => {
          const sec = g.section || 'general_notes';
          if (!grouped[sec]) grouped[sec] = [];
          grouped[sec].push(g.content);
        });

        const dossierHeader = isIt ? '[DOSSIER GLOBALE UTENTE]' : '[GLOBAL USER DOSSIER]';
        const dossierIntro = isIt
          ? 'Le seguenti note verificate descrivono l\'utente, le sue preferenze operative e i progetti attivi o passati:'
          : 'The following verified background notes describe the user, their workflow preferences, and ongoing/past projects:';

        const dossierLines = ['\n\n' + dossierHeader, dossierIntro];
        for (const [secKey, label] of Object.entries(sectionLabels)) {
          if (grouped[secKey] && grouped[secKey].length > 0) {
            dossierLines.push(`### ${label}`);
            grouped[secKey].forEach(c => dossierLines.push(`- ${c}`));
          }
        }
        for (const [secKey, items] of Object.entries(grouped)) {
          if (!sectionLabels[secKey] && items.length > 0) {
            dossierLines.push(`### ${secKey}`);
            items.forEach(c => dossierLines.push(`- ${c}`));
          }
        }
        parts.push(dossierLines.join('\n'));
      }

      if (chats.length > 0) {
        const timelineHeader = isIt ? '[CRONOLOGIA CONVERSAZIONE ATTIVA]' : '[CHAT CONVERSATION TIMELINE]';
        const timelineIntro = isIt
          ? 'I seguenti checkpoint sequenziali riassumono i turni precedenti di questa conversazione. Usali per preservare la continuità:'
          : 'The following sequential checkpoints summarize past turns in this conversation. Use them to preserve continuity:';
        const turnWord = isIt ? 'Turno' : 'Turn';

        const timelineLines = [
          '\n\n' + timelineHeader,
          timelineIntro
        ];
        chats.forEach((c, idx) => {
          const msgRef = c.sourceMessageId ? ` [msg_id: ${c.sourceMessageId}]` : '';
          timelineLines.push(`- ${turnWord} #${idx + 1}${msgRef}: ${c.content}`);
        });
        parts.push(timelineLines.join('\n'));
      }

      // Fallback for uncategorized memories without scope
      if (globals.length === 0 && chats.length === 0 && memories && memories.length > 0) {
        const uncategorizedHeader = isIt ? '[NOTE CONTESTUALI MEMORIZZATE]' : '[SAVED CONTEXTUAL NOTES]';
        parts.push('\n\n' + uncategorizedHeader + '\n' + memories.map(m => `- ${m.content}`).join('\n'));
      }

      // 4. Pre-installed Packages & Environment
      if (packages && packages.length > 0) {
        const pkgHeader = isIt ? '[PACCHETTI AMBIENTE PRE-INSTALLATI]' : '[PRE-INSTALLED ENVIRONMENT PACKAGES]';
        const pkgIntro = isIt
          ? 'Le seguenti librerie sono già installate e disponibili in questo ambiente sandbox. Puoi importarle direttamente; NON eseguire comandi di installazione pip/npm per esse:'
          : 'The following libraries are already installed and cached in this sandbox environment. You can directly import/require them; do NOT execute pip/npm download commands for them:';

        const pkgLines = [
          '\n\n' + pkgHeader,
          pkgIntro
        ];
        packages.forEach(p => {
          const ver = p.version && p.version !== 'installed' ? ` (v${p.version})` : '';
          const title = p.title || p.name;
          pkgLines.push(`- ${p.name}${ver}: ${title}`);
        });
        parts.push(pkgLines.join('\n'));
      }

      // 5. Sandbox Network Connectivity State
      if (isChatOffline) {
        const offlineNotice = isIt
          ? '\n\n[ACCESSO RETE AMBIENTE: L\'accesso a Internet è attualmente DISABILITATO per l\'ambiente sandbox di questa chat (Isolato / Offline). Gli strumenti che richiedono internet sono bloccati. Se l\'utente richiede informazioni web in tempo reale, spiega che questa chat è in modalità Isolata Offline e può essere riattivata dal pulsante "Ambiente Chat" nella barra superiore.]'
          : '\n\n[ENVIRONMENT NETWORK: Internet access is currently DISABLED for this chat sandbox environment (Isolated / Offline). Tools requiring internet are blocked. If the user asks for real-time web info, explain that this chat is in Offline Isolated mode and can be toggled on from the "Ambiente Chat" button in the top bar.]';
        parts.push(offlineNotice);
      } else {
        const onlineNotice = isIt
          ? '\n\n[ACCESSO RETE AMBIENTE: L\'accesso a Internet è ABILITATO per questa chat.]'
          : '\n\n[ENVIRONMENT NETWORK: Internet access is ENABLED for this chat.]';
        parts.push(onlineNotice);
      }

      // 6. Dynamic Tool Section
      if (toolsSection) {
        parts.push(toolsSection);
      }

      return parts.join('');
    }
  }

  // Export for browser
  if (typeof window !== 'undefined') {
    window.PromptManager = PromptManager;
    window.promptManager = new PromptManager();
  }

  // Export for Node.js / tests
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      PromptManager,
      DEFAULT_PROMPT_SECTIONS,
      SYNTHORG_CORE_HIDDEN_PROMPT,
      SYNTHORG_CORE_HIDDEN_PROMPT_IT,
      SYNTHORG_CORE_HIDDEN_PROMPT_EN
    };
  }
})();
