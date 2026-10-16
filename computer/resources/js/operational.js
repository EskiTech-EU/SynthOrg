/**
 * SynthOrg - Operational Registry for SynthOrg
 * Manages operational capability matrix, role assignments, dynamic tool delegates,
 * and unified candidate indexing.
 */

(function () {
  'use strict';

  class OperationalRegistry {
    constructor(catalog) {
      this.catalog = catalog;
      this.delegatesStorageKey = 'synthorg_operational_tool_delegates';
      this.storageKey = this.delegatesStorageKey;
      this.selectedMasterIdKey = 'synthorg_selected_master_id';
      this.selectedMicrotaskIdKey = 'synthorg_selected_microtask_id';
      this.selectedRealtimeMultiIdKey = 'synthorg_selected_realtime_multi_id';
      this.modelParamsKey = 'synthorg_model_custom_parameters';
      this.modelConfigsKey = 'synthorg_model_custom_configs';
      this.roles = this.initRoleDefinitions();
      this._initializedFromStorage = false;
    }

    /**
     * Synchronizes role selections, tool delegates, and model parameters with SQLite settings table.
     * Migrates pre-existing local storage to SQLite if needed, and hydrates state from SQLite.
     */
    async syncWithStorage() {
      try {
        if (!window.chatStorage || typeof window.chatStorage.getSettings !== 'function') return;
        const settings = await window.chatStorage.getSettings();
        if (!settings || typeof settings !== 'object') return;

        // 1. Master Orchestrator Model
        if (settings.role_master_model_id) {
          localStorage.setItem(this.selectedMasterIdKey, settings.role_master_model_id);
        } else {
          const local = localStorage.getItem(this.selectedMasterIdKey);
          if (local) window.chatStorage.setSetting('role_master_model_id', local).catch(() => {});
        }

        // 2. Microtask & Fast Router Model
        if (settings.role_microtask_model_id) {
          localStorage.setItem(this.selectedMicrotaskIdKey, settings.role_microtask_model_id);
        } else {
          const local = localStorage.getItem(this.selectedMicrotaskIdKey);
          if (local) window.chatStorage.setSetting('role_microtask_model_id', local).catch(() => {});
        }

        // 3. Realtime Multi (Vision + Audio) Model
        if (settings.role_realtime_multi_model_id) {
          localStorage.setItem(this.selectedRealtimeMultiIdKey, settings.role_realtime_multi_model_id);
        } else {
          const local = localStorage.getItem(this.selectedRealtimeMultiIdKey);
          if (local) window.chatStorage.setSetting('role_realtime_multi_model_id', local).catch(() => {});
        }

        // 5. Tool Delegates Map
        if (settings.operational_tool_delegates) {
          localStorage.setItem(this.delegatesStorageKey, settings.operational_tool_delegates);
        } else {
          const local = localStorage.getItem(this.delegatesStorageKey) || localStorage.getItem('undefined');
          if (local) {
            localStorage.setItem(this.delegatesStorageKey, local);
            window.chatStorage.setSetting('operational_tool_delegates', local).catch(() => {});
          }
        }

        // 6. Model Parameters
        if (settings.model_custom_parameters) {
          localStorage.setItem(this.modelParamsKey, settings.model_custom_parameters);
        } else {
          const local = localStorage.getItem(this.modelParamsKey);
          if (local) window.chatStorage.setSetting('model_custom_parameters', local).catch(() => {});
        }

        // 7. Model Configs
        if (settings.model_custom_configs) {
          localStorage.setItem(this.modelConfigsKey, settings.model_custom_configs);
        } else {
          const local = localStorage.getItem(this.modelConfigsKey);
          if (local) window.chatStorage.setSetting('model_custom_configs', local).catch(() => {});
        }

        this._initializedFromStorage = true;
      } catch (err) {
        console.warn('[OperationalRegistry] syncWithStorage error:', err);
      }
    }

    initRoleDefinitions() {
      return [
        {
          id: 'primary_master',
          code: 'ROLE_MASTER_ORCHESTRATOR',
          type: 'primary_role',
          icon: '<i class="fa-solid fa-crown"></i>',
          name: 'Master Orchestrator',
          nameKey: 'roles.masterName',
          badge: 'Ruolo Primario',
          badgeKey: 'roles.primaryMasterBadge',
          description: 'Modello principale con cui dialoga l\'utente. Riceve i prompt, seleziona i tool appropriati, delega i sotto-task e sintetizza le risposte finali.',
          descKey: 'roles.masterDesc',
          rule: {
            requiresInput: ['text'],
            requiresOutput: ['text'],
            excludesOutput: ['audio', 'speech', 'video', 'image', 'transcription'],
            prefersTools: true,
            prefersReasoning: true,
            minContext: 8000
          }
        },
        {
          id: 'primary_microtask',
          code: 'ROLE_MICROTASK_ROUTER',
          type: 'primary_role',
          icon: '<i class="fa-solid fa-bolt"></i>',
          name: 'Microtask & Fast Router',
          nameKey: 'roles.microtaskName',
          badge: 'Ruolo Sistema',
          badgeKey: 'roles.primaryMicrotaskBadge',
          description: 'Modello compatto, economico e a bassissima latenza per micro-operazioni rapide (generazione titoli chat, sintesi memorie, routing e categorizzazione veloce).',
          descKey: 'roles.microtaskDesc',
          rule: {
            requiresInput: ['text'],
            requiresOutput: ['text'],
            excludesOutput: ['audio', 'speech', 'video', 'image', 'transcription'],
            prefersFast: true,
            minContext: 8000
          }
        },
        {
          id: 'primary_realtime_multi',
          code: 'ROLE_REALTIME_MULTI',
          type: 'primary_role',
          icon: '<i class="fa-solid fa-video"></i>',
          name: 'Realtime',
          nameKey: 'roles.realtimeMultiName',
          badge: 'Ruolo Multimodale Live',
          badgeKey: 'roles.primaryRealtimeMultiBadge',
          description: 'Il modello con cui parla l’assistente. Vale ogni modello accettato dal Master: se non sente la voce, la trascrive il ruolo Trascrizione; la risposta la legge il ruolo Sintesi vocale.',
          descKey: 'roles.realtimeMultiDesc',
          rule: {
            requiresInput: ['text'],
            requiresOutput: ['text'],
            isRealtime: true
          }
        },
        {
          id: 'deep_research',
          code: 'TOOL_DEEP_RESEARCH',
          type: 'tool_category',
          icon: '<i class="fa-solid fa-compass"></i>',
          name: 'Deep Research & Web Grounding',
          nameKey: 'tools.suiteDeepResearch',
          badge: 'Ricerca Web',
          badgeKey: 'tools.suiteDeepResearchBadge',
          description: 'Accesso al web in due forme: il modello che guida da solo un browser, oppure la ricerca delegata a un modello specializzato.',
          descKey: 'tools.suiteDeepResearchDesc',
          checkNative: (master) => Boolean(master && master.id.includes('sonar')),
          nativeEngine: {
            nameKey: 'tools.webSearchEngine',
            icon: '<i class="fa-solid fa-globe"></i>',
            label: 'Nativo (Puppeteer + Stealth)',
            labelKey: 'tools.nativePuppeteerLabel',
            descriptionKey: 'tools.webSearchEngineDesc'
          },
          tools: [
            {
              id: 'web_search',
              name: 'Web Search (Puppeteer + Stealth)',
              nameKey: 'tools.webSearchName',
              icon: '<i class="fa-solid fa-globe"></i>',
              description: 'Ricerca web diretta ed estrazione anteprime in tempo reale con browser headless protetto da Puppeteer Stealth (anti-bot bypass). Supporta paginazione.',
              descKey: 'tools.webSearchDesc',
              ioSignature: 'query -> web_results',
              isNativeEngine: true,
              requiresInternet: true,
              filter: () => false
            },
            {
              id: 'web_browse',
              name: 'Web Browse & Extract (Puppeteer)',
              nameKey: 'tools.webBrowseName',
              icon: '<i class="fa-solid fa-arrow-up-right-from-square"></i>',
              description: 'Apre un URL web, naviga la pagina con Puppeteer Stealth ed estrae il contenuto testuale pulito e i link utili rilevati.',
              descKey: 'tools.webBrowseDesc',
              ioSignature: 'url -> page_content',
              isNativeEngine: true,
              requiresInternet: true,
              filter: () => false
            },
            {
              id: 'model_search',
              name: 'Model Search (AI Delegata)',
              nameKey: 'tools.modelSearchName',
              icon: '<i class="fa-solid fa-brain"></i>',
              description: 'Ricerca web multi-fase autonoma delegata a un modello AI specialistico (es. Perplexity Sonar Deep Research, Sonar Pro, Relace Search).',
              descKey: 'tools.modelSearchDesc',
              ioSignature: 'prompt -> text',
              requiresInternet: true,
              filter: (m) => m.hasWebSearch && m.outputModalities.includes('text') && !m.id.includes(':batch') && !OperationalRegistry.isSafetyOrGuardModel(m)
            }
          ]
        },
        {
          id: 'workspace_artifacts',
          code: 'TOOL_WORKSPACE_ARTIFACTS',
          type: 'tool_category',
          icon: '<i class="fa-solid fa-shapes"></i>',
          name: 'Workspace & Artifacts Manager',
          nameKey: 'tools.suiteArtifacts',
          badge: 'Artefatti & Workspace',
          badgeKey: 'tools.suiteArtifactsBadge',
          description: 'Gestione e consultazione degli artefatti generati e pubblicazione di file o archivi compressi .zip dal workspace della chat.',
          descKey: 'tools.suiteArtifactsDesc',
          checkNative: () => true,
          nativeEngine: {
            name: 'Gestione Artefatti del Workspace',
            nameKey: 'tools.artifactsEngineName',
            icon: '<i class="fa-solid fa-shapes"></i>',
            label: 'Nativo (SynthOrg Engine)',
            labelKey: 'tools.nativeSynthorgLabel',
            description: 'Elenca gli artefatti del workspace della chat e ne pubblica uno, da solo o come archivio .zip scaricabile. Opera sul filesystem del workspace, senza modelli.',
            descriptionKey: 'tools.artifactsEngineDesc'
          },
          tools: [
            {
              id: 'create_file',
              name: 'Create Workspace File',
              nameKey: 'tools.createFileName',
              icon: '<i class="fa-solid fa-file-circle-plus"></i>',
              description: 'Scrive un file di testo nel workspace di questa chat (report, script, csv, json, markdown) e lo mostra in chat come artefatto.',
              descKey: 'tools.createFileDesc',
              ioSignature: 'filename, content -> file',
              isNativeEngine: true,
              requiresInternet: false,
              filter: () => false
            },
            {
              id: 'read_file',
              name: 'Read Workspace File',
              nameKey: 'tools.readFileName',
              icon: '<i class="fa-solid fa-file-lines"></i>',
              description: 'Rilegge il contenuto di un file di testo del workspace di questa chat, per continuare a lavorarci sopra.',
              descKey: 'tools.readFileDesc',
              ioSignature: 'filename -> content',
              isNativeEngine: true,
              requiresInternet: false,
              filter: () => false
            },
            {
              id: 'list_artifacts',
              name: 'List Workspace Artifacts',
              nameKey: 'tools.listArtifactsName',
              icon: '<i class="fa-solid fa-list-check"></i>',
              description: 'Restituisce l’elenco di tutti gli artefatti salvati nel workspace di questa chat (immagini, video, audio/musica, report/documenti e archivi zip) con metadati e dimensioni.',
              descKey: 'tools.listArtifactsDesc',
              ioSignature: 'category? -> artifacts_list',
              isNativeEngine: true,
              requiresInternet: false,
              filter: () => false
            },
            {
              id: 'publish_artifact',
              name: 'Publish & Package Artifact',
              nameKey: 'tools.publishArtifactName',
              icon: '<i class="fa-solid fa-file-zipper"></i>',
              description: 'Rende disponibile in chat e nella sezione artefatti un file o cartella dell’ambiente di lavoro, oppure crea un archivio compresso (.zip) scaricabile.',
              descKey: 'tools.publishArtifactDesc',
              ioSignature: 'path, title?, as_zip? -> published_artifact',
              isNativeEngine: true,
              requiresInternet: false,
              filter: () => false
            },
            {
              // The model's terminal. Offered only in the chat of a Code
              // project, where it runs in the project's container or, for a
              // project in a folder of this machine, in the editor's own
              // terminal; the project's permissions say whether it waits for
              // the user first.
              id: 'sandbox_exec',
              name: 'Run Command (Project Terminal)',
              nameKey: 'tools.sandboxExecName',
              icon: '<i class="fa-solid fa-terminal"></i>',
              description: 'Esegue un comando nel terminale del progetto aperto in Code: il suo container, oppure il terminale dell’editor su questa macchina. Rispetta i permessi del progetto.',
              descKey: 'tools.sandboxExecDesc',
              ioSignature: 'command -> output',
              isNativeEngine: true,
              requiresInternet: false,
              filter: () => false
            }
          ]
        },
        {
          id: 'image_generation',
          code: 'TOOL_IMAGE_GEN',
          type: 'tool_category',
          icon: '<i class="fa-solid fa-palette"></i>',
          name: 'Image Generation Suite',
          nameKey: 'tools.suiteImage',
          badge: 'Sintesi Grafica',
          badgeKey: 'tools.suiteImageBadge',
          description: 'Capacità di sintesi grafica. Se il Master genera già immagini è coperto di default, ma l\'utente può sempre delegare a un fornitore specialistico.',
          descKey: 'tools.suiteImageDesc',
          checkNative: (master) => Boolean(master && master.hasImageOut),
          tools: [
            {
              id: 'text_to_image',
              name: 'Text to Image',
              nameKey: 'tools.textToImageName',
              icon: '<i class="fa-solid fa-wand-magic-sparkles"></i>',
              description: 'Genera un\'immagine ex novo da una descrizione testuale/prompt.',
              descKey: 'tools.textToImageDesc',
              ioSignature: 'text -> image',
              filter: (m) => m.inputModalities.includes('text') && m.outputModalities.includes('image')
            },
            {
              id: 'image_to_image',
              name: 'Image to Image',
              nameKey: 'tools.imageToImageName',
              icon: '<i class="fa-solid fa-arrows-rotate"></i>',
              description: 'Modifica o trasforma un\'immagine esistente in base a istruzioni fornite.',
              descKey: 'tools.imageToImageDesc',
              ioSignature: 'image -> image',
              filter: (m) => m.inputModalities.includes('image') && m.outputModalities.includes('image')
            }
          ]
        },
        {
          id: 'video_generation',
          code: 'TOOL_VIDEO_GEN',
          type: 'tool_category',
          icon: '<i class="fa-solid fa-clapperboard"></i>',
          name: 'Video Generation Suite',
          nameKey: 'tools.suiteVideo',
          badge: 'Sintesi Video',
          badgeKey: 'tools.suiteVideoBadge',
          description: 'Generazione e sintesi di video dinamici a partire da prompt testuali o da fotogrammi guida (Google Veo, Wan, Sora, Kling, Hailuo).',
          descKey: 'tools.suiteVideoDesc',
          checkNative: (master) => Boolean(master && (master.hasVideoOut || (master.outputModalities && master.outputModalities.includes('video')))),
          tools: [
            {
              id: 'text_to_video',
              name: 'Text to Video',
              nameKey: 'tools.textToVideoName',
              icon: '<i class="fa-solid fa-film"></i>',
              description: 'Genera clip video animate e cinematiche direttamente da un prompt testuale (Google Veo 3.1, Alibaba Wan, OpenAI Sora 2 Pro, Kling).',
              descKey: 'tools.textToVideoDesc',
              ioSignature: 'text -> video',
              checkNative: (master) => Boolean(master && (master.hasVideoOut || (master.outputModalities && master.outputModalities.includes('video')))),
              filter: (m) => (m.outputModalities.includes('video') || m.hasVideoOut) && m.inputModalities.includes('text')
            },
            {
              id: 'image_to_video',
              name: 'Image to Video',
              nameKey: 'tools.imageToVideoName',
              icon: '<i class="fa-solid fa-photo-film"></i>',
              description: 'Anima un\'immagine statica di riferimento trasformandola in una scena video in movimento (Kling, Wan, Hailuo, Veo).',
              descKey: 'tools.imageToVideoDesc',
              ioSignature: 'image+text -> video',
              checkNative: (master) => Boolean(master && (master.hasVideoOut || (master.outputModalities && master.outputModalities.includes('video')))),
              filter: (m) => (m.outputModalities.includes('video') || m.hasVideoOut) && (m.inputModalities.includes('image') || m.hasVision)
            }
          ]
        },
        {
          id: 'vision_analysis',
          code: 'TOOL_VISION_VLM',
          type: 'tool_category',
          icon: '<i class="fa-solid fa-eye"></i>',
          name: 'Vision & Multimodal Inspection',
          nameKey: 'tools.suiteVision',
          badge: 'Comprensione Visiva',
          badgeKey: 'tools.suiteVisionBadge',
          description: 'Capacità di leggere immagini, diagrammi, screenshot e video. Coperto di default se il Master è un VLM multimodale, altrimenti delegato.',
          descKey: 'tools.suiteVisionDesc',
          checkNative: (master) => Boolean(master && master.hasVision),
          tools: [
            {
              id: 'image_inspection',
              name: 'Image Analysis & OCR',
              nameKey: 'tools.imageInspectionName',
              icon: '<i class="fa-solid fa-image"></i>',
              description: 'Analisi visiva dettagliata di immagini, diagrammi, grafici e screenshot.',
              descKey: 'tools.imageInspectionDesc',
              ioSignature: 'image+text -> text',
              filter: (m) => m.hasVision && m.outputModalities.includes('text') && !OperationalRegistry.isOmniOrRealtimeModel(m) && !OperationalRegistry.isSafetyOrGuardModel(m)
            },
            {
              id: 'video_inspection',
              name: 'Video Analysis',
              nameKey: 'tools.videoInspectionName',
              icon: '<i class="fa-solid fa-video"></i>',
              description: 'Comprensione e tracciamento temporale di clip video.',
              descKey: 'tools.videoInspectionDesc',
              ioSignature: 'video+text -> text',
              filter: (m) => m.hasVideoIn && m.outputModalities.includes('text') && !OperationalRegistry.isOmniOrRealtimeModel(m) && !OperationalRegistry.isSafetyOrGuardModel(m)
            }
          ]
        },
        {
          id: 'audio_suite',
          code: 'TOOL_AUDIO_VOICE',
          type: 'tool_category',
          icon: '<i class="fa-solid fa-microphone"></i>',
          name: 'Audio & Speech Suite',
          nameKey: 'tools.suiteAudio',
          badge: 'Voce & Audio',
          badgeKey: 'tools.suiteAudioBadge',
          description: 'Capacità vocali e uditive (trascrizione STT multimodale, sintesi vocale TTS parlata).',
          descKey: 'tools.suiteAudioDesc',
          checkNative: (master) => Boolean(master && (master.hasAudioIn || (master.hasAudioOut && !master.id.includes('lyria') && !(master.description || '').toLowerCase().includes('music')))),
          tools: [
            {
              id: 'audio_transcription',
              name: 'Audio File Transcription (STT)',
              nameKey: 'tools.audioTranscriptionName',
              icon: '<i class="fa-solid fa-headphones"></i>',
              description: 'Trascrive un file audio (.mp3, .wav, .m4a, .webm, .ogg) presente nel workspace della chat o allegato, estraendone il testo integrale.',
              descKey: 'tools.audioTranscriptionDesc',
              ioSignature: 'file_path -> text',
              checkNative: (master) => Boolean(master && (master.hasAudioIn || master.hasTranscriptionOut)),
              filter: (m) => m.outputModalities.includes('transcription') || m.hasTranscriptionOut || m.id.includes('whisper') || m.id.includes('chirp') || m.id.includes('-asr') || m.id.includes('transcribe') || m.id.includes('-stt')
            },
            {
              id: 'voice_synthesis',
              name: 'Voice Output (TTS)',
              nameKey: 'tools.voiceSynthesisName',
              icon: '<i class="fa-solid fa-bullhorn"></i>',
              description: 'Modelli dedicati alla sintesi vocale e speech output naturale (Google Gemini Flash TTS, OpenAI GPT-Audio, Grok Voice TTS, Kokoro 82M).',
              descKey: 'tools.voiceSynthesisDesc',
              ioSignature: 'text -> speech',
              checkNative: (master) => Boolean(master && (master.outputModalities.includes('speech') || (master.hasAudioOut && !master.id.includes('lyria') && !(master.description || '').toLowerCase().includes('music')))),
              filter: (m) => (m.outputModalities.includes('speech') || (m.outputModalities.includes('audio') && !m.id.includes('lyria') && !(m.description || '').toLowerCase().includes('music')) || m.id.includes('tts')) && !m.id.includes('lyria') && !(m.description || '').toLowerCase().includes('music')
            }
          ]
        },
        {
          id: 'music_suite',
          code: 'TOOL_MUSIC_AUDIO',
          type: 'tool_category',
          icon: '<i class="fa-solid fa-music"></i>',
          name: 'Music & Audio Generation',
          nameKey: 'tools.suiteMusic',
          badge: 'Generazione Musica',
          badgeKey: 'tools.suiteMusicBadge',
          description: 'Composizione e sintesi di brani musicali completi e clip audio strumentali o cantati (Google Lyria).',
          descKey: 'tools.suiteMusicDesc',
          checkNative: (master) => Boolean(master && (master.id.includes('lyria') || (master.hasAudioOut && (master.description || '').toLowerCase().includes('music')))),
          tools: [
            {
              id: 'music_generation',
              name: 'Music Generation (Lyria)',
              nameKey: 'tools.musicGenerationName',
              icon: '<i class="fa-solid fa-compact-disc"></i>',
              description: 'Generazione avanzata di tracce musicali complete e clip audio strumentali/vocali tramite Google Lyria.',
              descKey: 'tools.musicGenerationDesc',
              ioSignature: 'text+image -> music/audio',
              checkNative: (master) => Boolean(master && (master.id.includes('lyria') || (master.hasAudioOut && (master.description || '').toLowerCase().includes('music')))),
              filter: (m) => m.id.includes('lyria') || ((m.outputModalities.includes('audio') || m.outputModalities.includes('speech')) && (m.description || '').toLowerCase().includes('music'))
            }
          ]
        },
        {
          id: 'document_ingestion',
          code: 'TOOL_DOCS_PARSER',
          type: 'tool_category',
          icon: '<i class="fa-solid fa-file-pdf"></i>',
          name: 'Document & PDF Ingestion',
          nameKey: 'tools.suiteDocs',
          badge: 'File & PDF',
          badgeKey: 'tools.suiteDocsBadge',
          description: 'Ingestione nativa di documenti multipagina, PDF complessi e allegati strutturati.',
          descKey: 'tools.suiteDocsDesc',
          checkNative: (master) => Boolean(master && master.hasFileIn),
          tools: [
            {
              id: 'pdf_parser',
              name: 'Large Document Parser',
              nameKey: 'tools.pdfParserName',
              icon: '<i class="fa-solid fa-file-lines"></i>',
              description: 'Elaborazione nativa di file PDF pesanti e documentazione aziendale.',
              descKey: 'tools.pdfParserDesc',
              ioSignature: 'file+text -> text',
              filter: (m) => m.hasFileIn && m.outputModalities.includes('text') && !OperationalRegistry.isSafetyOrGuardModel(m)
            }
          ]
        },
        {
          id: 'deep_reasoning',
          code: 'TOOL_REASONING_COT',
          type: 'tool_category',
          icon: '<i class="fa-solid fa-brain"></i>',
          name: 'Ragionamento delegato',
          nameKey: 'tools.suiteReasoning',
          badge: 'Delega',
          badgeKey: 'tools.suiteReasoningBadge',
          description: 'Il modello principale passa un problema difficile a un modello che ragiona e ne riceve la soluzione. Utile quando il principale è un modello leggero.',
          descKey: 'tools.suiteReasoningDesc',
          checkNative: (master) => Boolean(master && master.hasReasoning),
          tools: [
            {
              id: 'thinking_solver',
              name: 'Chiedi a un modello che ragiona',
              nameKey: 'tools.thinkingSolverName',
              icon: '<i class="fa-solid fa-lightbulb"></i>',
              // What the model reads: when to use it, and that the other model sees only what it is given.
              description: 'Passa un problema a un modello che ci ragiona sopra da capo e restituisce la sua soluzione. Quel modello non vede questa conversazione e non ha tool né file: nel problema scrivi tutto quello che serve (dati, vincoli, cosa va trovato). Usalo per problemi ben definiti di logica, matematica, algoritmi o scelte tra alternative; per quello che richiede di guardare il progetto o la conversazione fai da solo. Quello che torna è una proposta: verificala con quello che sai prima di usarla.',
              descKey: 'tools.thinkingSolverDesc',
              ioSignature: 'problem -> solution',
              filter: (m) => m.hasReasoning && m.outputModalities.includes('text') && !OperationalRegistry.isSafetyOrGuardModel(m)
            }
          ]
        }
      ];
    }

    /**
     * Checks if a model is a safety classifier, guardrail, or moderation model.
     * These models only assess safety/policy compliance and cannot be used as conversational LLMs,
     * vision inspection assistants, or general tools.
     */
    static isSafetyOrGuardModel(m) {
      if (!m) return false;
      const id = (m.id || '').toLowerCase();
      const name = (m.name || '').toLowerCase();
      const desc = (m.description || '').toLowerCase();
      return (
        id.includes('content-safety') ||
        id.includes('llama-guard') ||
        id.includes('guardrail') ||
        id.includes('moderation') ||
        id.includes('safety-guard') ||
        id.includes('shieldgemma') ||
        id.includes('prompt-guard') ||
        name.includes('content safety') ||
        name.includes('guardrail') ||
        name.includes('moderation') ||
        desc.includes('safety classifier') ||
        desc.includes('content moderation') ||
        desc.includes('guardrail') ||
        desc.includes('safety evaluation')
      );
    }

    /**
     * Checks if a model is an Omni or Realtime duplex continuous streaming model.
     * These models are designed for live multimodal voice/video sessions (ROLE_REALTIME / ROLE_REALTIME_MULTI)
     * rather than static text-based tool inspection (OCR / document vision).
     */
    static isOmniOrRealtimeModel(m) {
      if (!m) return false;
      const id = (m.id || '').toLowerCase();
      const name = (m.name || '').toLowerCase();
      return (
        id.includes('omni') ||
        id.includes('realtime') ||
        name.includes('realtime') ||
        name.includes('omni') ||
        Boolean(m.hasAudioOut && m.hasAudioIn)
      );
    }

    /**
     * Determines whether a model is eligible to serve as Master Orchestrator.
     * Must be a general-purpose conversational LLM (text in -> text out).
     * Excludes specialized audio, voice, speech, music, video, image generation, or transcription models.
     */
    isMasterEligible(m) {
      if (!m) return false;
      if (OperationalRegistry.isSafetyOrGuardModel(m)) return false;
      const inMods = Array.isArray(m.inputModalities) ? m.inputModalities : ['text'];
      const outMods = Array.isArray(m.outputModalities) ? m.outputModalities : ['text'];

      // Must support text input and conversational text output
      if (!inMods.includes('text') || !outMods.includes('text')) return false;

      // Cannot have non-text generative outputs (audio, speech, video, image, transcription)
      if (m.hasAudioOut || m.hasVideoOut || m.hasImageOut || m.hasTranscriptionOut) return false;
      if (outMods.some(out => ['audio', 'speech', 'video', 'image', 'transcription'].includes(out))) return false;

      const id = (m.id || '').toLowerCase();
      const name = (m.name || '').toLowerCase();
      const desc = (m.description || '').toLowerCase();

      // Exclude audio / speech / voice / transcription / music models
      if (
        id.includes('audio') ||
        id.includes('lyria') ||
        id.includes('whisper') ||
        id.includes('chirp') ||
        id.includes('tts') ||
        id.includes('voice') ||
        id.includes('-stt') ||
        id.includes('-asr') ||
        id.includes('transcribe')
      ) {
        return false;
      }

      // Exclude dedicated image / video generators
      if (
        id.includes('dall-e') ||
        id.includes('flux') ||
        id.includes('stable-diffusion') ||
        id.includes('midjourney') ||
        id.includes('sora') ||
        id.includes('kling') ||
        id.includes('veo') ||
        id.endsWith('-image') ||
        id.endsWith('-video') ||
        id.includes(':batch')
      ) {
        return false;
      }

      if (
        name.includes('gpt audio') ||
        name.includes('lyria') ||
        desc.includes('music generator') ||
        desc.includes('text-to-speech')
      ) {
        return false;
      }

      if (m.contextLength && m.contextLength < 8000) return false;

      return true;
    }

    getSelectedMasterId() {
      const stored = localStorage.getItem(this.selectedMasterIdKey);
      return stored || 'anthropic/claude-3.7-sonnet';
    }

    setSelectedMasterId(id) {
      if (id) {
        const model = this.catalog.models.find(m => m.id === id);
        if (model && !this.isMasterEligible(model)) {
          console.warn(`[OperationalRegistry] Il modello ${id} non è idoneo come Master Orchestrator (è un modello specialistico).`);
          return false;
        }
        localStorage.setItem(this.selectedMasterIdKey, id);
        window.chatStorage?.setSetting?.('role_master_model_id', id).catch(e => console.warn('[Storage] Master save failed:', e));
        return true;
      }
    }

    getCurrentMasterModel() {
      const masterId = this.getSelectedMasterId();
      const current = this.catalog.models.find(m => m.id === masterId);
      if (current && this.isMasterEligible(current)) {
        return current;
      }

      const preferredMasters = [
        'anthropic/claude-3.7-sonnet',
        'anthropic/claude-3.5-sonnet',
        'openai/gpt-4o',
        'google/gemini-2.5-flash',
        'deepseek/deepseek-chat'
      ];
      for (const pref of preferredMasters) {
        const candidate = this.catalog.models.find(m => m.id === pref);
        if (candidate && this.isMasterEligible(candidate)) {
          return candidate;
        }
      }

      const firstEligible = this.catalog.models.find(m => this.isMasterEligible(m));
      return firstEligible || current || this.catalog.models[0] || null;
    }

    /**
     * Determines whether a model is eligible to serve as Microtask & Fast Router.
     * Must be a fast, lightweight conversational text model.
     */
    isMicrotaskEligible(m) {
      if (!m) return false;
      if (OperationalRegistry.isSafetyOrGuardModel(m)) return false;
      const inMods = Array.isArray(m.inputModalities) ? m.inputModalities : ['text'];
      const outMods = Array.isArray(m.outputModalities) ? m.outputModalities : ['text'];

      // Text in, text out
      if (!inMods.includes('text') || !outMods.includes('text')) return false;

      // Cannot have non-text generative outputs (audio, speech, video, image, transcription)
      if (m.hasAudioOut || m.hasVideoOut || m.hasImageOut || m.hasTranscriptionOut) return false;
      if (outMods.some(out => ['audio', 'speech', 'video', 'image', 'transcription'].includes(out))) return false;

      const id = (m.id || '').toLowerCase();
      const name = (m.name || '').toLowerCase();
      const desc = (m.description || '').toLowerCase();

      // Exclude audio / speech / voice / transcription / music models
      if (
        id.includes('audio') ||
        id.includes('lyria') ||
        id.includes('whisper') ||
        id.includes('chirp') ||
        id.includes('tts') ||
        id.includes('voice') ||
        id.includes('-stt') ||
        id.includes('-asr') ||
        id.includes('transcribe')
      ) {
        return false;
      }

      // Exclude dedicated image / video generators
      if (
        id.includes('dall-e') ||
        id.includes('flux') ||
        id.includes('stable-diffusion') ||
        id.includes('midjourney') ||
        id.includes('sora') ||
        id.includes('kling') ||
        id.includes('veo') ||
        id.endsWith('-image') ||
        id.endsWith('-video') ||
        id.includes(':batch')
      ) {
        return false;
      }

      if (
        name.includes('gpt audio') ||
        name.includes('lyria') ||
        desc.includes('music generator') ||
        desc.includes('text-to-speech')
      ) {
        return false;
      }

      if (m.contextLength && m.contextLength < 8000) return false;

      return true;
    }

    getSelectedMicrotaskId() {
      const stored = localStorage.getItem(this.selectedMicrotaskIdKey);
      return stored || 'google/gemini-2.5-flash';
    }

    setSelectedMicrotaskId(id) {
      if (id) {
        const model = this.catalog.models.find(m => m.id === id);
        if (model && !this.isMicrotaskEligible(model)) {
          console.warn(`[OperationalRegistry] Il modello ${id} non è idoneo come Microtask.`);
          return false;
        }
        localStorage.setItem(this.selectedMicrotaskIdKey, id);
        window.chatStorage?.setSetting?.('role_microtask_model_id', id).catch(e => console.warn('[Storage] Microtask save failed:', e));
        return true;
      }
    }

    getCurrentMicrotaskModel() {
      const microId = this.getSelectedMicrotaskId();
      const current = this.catalog.models.find(m => m.id === microId);
      if (current && this.isMicrotaskEligible(current)) {
        return current;
      }

      const preferred = [
        'google/gemini-2.5-flash',
        'openai/gpt-4o-mini',
        'anthropic/claude-3.5-haiku',
        'meta-llama/llama-3.3-70b-instruct',
        'deepseek/deepseek-chat',
        'mistralai/mistral-small'
      ];
      for (const pref of preferred) {
        const candidate = this.catalog.models.find(m => m.id === pref);
        if (candidate && this.isMicrotaskEligible(candidate)) {
          return candidate;
        }
      }

      const firstEligible = this.catalog.models.find(m => this.isMicrotaskEligible(m));
      return firstEligible || current || null;
    }

    /**
     * Determines whether a model is eligible for the Realtime role: one that hears and sees, or any the Master accepts.
     * Must support simultaneous continuous audio input AND vision/video input (camera/screen).
     * Excludes pure image/video generators (Flux), pure TTS, pure STT, music, and batch endpoints.
     */
    isRealtimeMultiEligible(m) {
      if (!m) return false;
      if (OperationalRegistry.isSafetyOrGuardModel(m)) return false;
      const inMods = Array.isArray(m.inputModalities) ? m.inputModalities : [];
      const outMods = Array.isArray(m.outputModalities) ? m.outputModalities : [];
      const id = (m.id || '').toLowerCase();
      const desc = (m.description || '').toLowerCase();

      // Exclude batch endpoints
      if (id.includes(':batch')) return false;

      // Exclude dedicated image / video generators (Flux, Dall-E, Sora, etc.)
      if (
        id.includes('flux') ||
        id.includes('dall-e') ||
        id.includes('stable-diffusion') ||
        id.includes('midjourney') ||
        id.includes('sora') ||
        id.includes('kling') ||
        id.includes('veo') ||
        id.includes('wan') ||
        id.endsWith('-image') ||
        id.endsWith('-video') ||
        outMods.includes('image') ||
        outMods.includes('video')
      ) {
        return false;
      }

      // Exclude turn-based voice synthesis (TTS) & transcription (STT)
      if (
        id.includes('tts') ||
        desc.includes('text-to-speech') ||
        desc.includes('text to speech') ||
        id.includes('elevenlabs') ||
        id.includes('kokoro') ||
        id.includes('f5-tts') ||
        id.includes('whisper') ||
        id.includes('chirp') ||
        id.includes('-asr') ||
        id.includes('-stt') ||
        id.includes('transcribe') ||
        outMods.includes('transcription')
      ) {
        return false;
      }

      // Exclude music models
      if (
        id.includes('lyria') ||
        desc.includes('music generator') ||
        desc.includes('music and sound') ||
        desc.includes('music')
      ) {
        return false;
      }

      // A model on this computer that chats can take the role: what it does not hear is written down for it by
      // the Transcription role, and what it answers is said by the Speech synthesis one (realtime.js).
      if (m.isLocal) return inMods.includes('text') && outMods.includes('text');

      // A model that hears and sees, or any model the Master accepts: what a model does not hear is written
      // down for it by the Transcription role, and its answer is said by the Speech synthesis one (realtime.js).
      const hasAudioIn = inMods.includes('audio') || Boolean(m.hasAudioIn);
      const hasVisionIn = inMods.includes('image') || inMods.includes('video') || Boolean(m.hasVision);

      return (hasAudioIn && hasVisionIn) || this.isMasterEligible(m);
    }

    getSelectedRealtimeMultiId() {
      const stored = localStorage.getItem(this.selectedRealtimeMultiIdKey);
      return stored || 'google/gemini-2.5-flash';
    }

    setSelectedRealtimeMultiId(id) {
      if (id) {
        const model = this.catalog.models.find(m => m.id === id);
        if (model && !this.isRealtimeMultiEligible(model)) {
          console.warn(`[OperationalRegistry] Il modello ${id} non è idoneo per Realtime Multi.`);
          return false;
        }
        localStorage.setItem(this.selectedRealtimeMultiIdKey, id);
        window.chatStorage?.setSetting?.('role_realtime_multi_model_id', id).catch(e => console.warn('[Storage] Realtime Multi save failed:', e));
        return true;
      }
    }

    getCurrentRealtimeMultiModel() {
      const rtmId = this.getSelectedRealtimeMultiId();
      const current = this.catalog.models.find(m => m.id === rtmId);
      if (current && this.isRealtimeMultiEligible(current)) {
        return current;
      }

      const preferred = [
        'google/gemini-2.5-flash',
        'google/gemini-2.5-pro',
        'openai/gpt-4o',
        'openai/gpt-4o-realtime-preview'
      ];
      for (const pref of preferred) {
        const candidate = this.catalog.models.find(m => m.id === pref);
        if (candidate && this.isRealtimeMultiEligible(candidate)) {
          return candidate;
        }
      }

      const firstEligible = this.catalog.models.find(m => this.isRealtimeMultiEligible(m));
      return firstEligible || current || null;
    }

    /**
     * The registry as one chat sees it: the chat's own choices
     * (conversation.model_overrides_json) over the general ones. Everything
     * that reads roles, delegates or parameters through these getters — the
     * current models, the tool specs, the configurable items — follows. With
     * nothing of its own the chat gets the general registry itself.
     *
     * Only for reading: the setters stay the general ones. A chat's choices
     * are changed with ChatModels (window.chatModels).
     */
    forConversation(conversation) {
      const own = OperationalRegistry.parseOverrides(conversation?.model_overrides_json);
      if (!own) return this;
      const general = this;
      const scoped = Object.create(this);
      scoped.overrides = own;
      scoped.general = general;
      const roles = own.roles || {};
      scoped.getSelectedMasterId = () => roles.master || general.getSelectedMasterId();
      scoped.getSelectedMicrotaskId = () => roles.microtask || general.getSelectedMicrotaskId();
      // 'auto' in the chat means "the Master's own", even over a general delegate.
      scoped.getDelegatesMap = () => {
        const map = { ...general.getDelegatesMap() };
        Object.entries(own.tools || {}).forEach(([toolId, modelId]) => {
          if (!modelId || modelId === 'auto') delete map[toolId];
          else map[toolId] = modelId;
        });
        return map;
      };
      // A value the chat cleared (null) is not set at all: the model's default,
      // not the general value.
      scoped.getModelParameters = (modelId) => {
        const merged = { ...general.getModelParameters(modelId), ...((own.params || {})[modelId] || {}) };
        Object.keys(merged).forEach(key => { if (merged[key] === null) delete merged[key]; });
        return merged;
      };
      return scoped;
    }

    static parseOverrides(raw) {
      if (!raw) return null;
      try {
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return value && typeof value === 'object' && Object.keys(value).length ? value : null;
      } catch {
        return null;
      }
    }

    getDelegatesMap() {
      try {
        const raw = localStorage.getItem(this.delegatesStorageKey) || localStorage.getItem(this.storageKey);
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    }

    getToolDelegate(toolId) {
      const map = this.getDelegatesMap();
      if (toolId === 'model_search' && !map['model_search'] && map['web_research_agent']) {
        return map['web_research_agent'];
      }
      const val = map[toolId] || 'auto';
      if (val && val !== 'auto' && OperationalRegistry.isSafetyOrGuardModel({ id: val })) {
        return 'auto';
      }
      return val;
    }

    setToolDelegate(toolId, modelId) {
      const map = this.getDelegatesMap();
      if (!modelId || modelId === 'auto') {
        delete map[toolId];
      } else {
        map[toolId] = modelId;
      }
      const serialized = JSON.stringify(map);
      localStorage.setItem(this.delegatesStorageKey, serialized);
      if (this.storageKey) localStorage.setItem(this.storageKey, serialized);
      window.chatStorage?.setSetting?.('operational_tool_delegates', serialized).catch(e => console.warn('[Storage] Tool delegates save failed:', e));
    }

    getModelParameters(modelId) {
      if (!modelId) return {};
      try {
        const raw = localStorage.getItem(this.modelParamsKey);
        const all = raw ? JSON.parse(raw) : {};
        return all[modelId] || {};
      } catch {
        return {};
      }
    }

    setModelParameter(modelId, paramKey, val) {
      if (!modelId || !paramKey) return;
      try {
        const raw = localStorage.getItem(this.modelParamsKey);
        const all = raw ? JSON.parse(raw) : {};
        if (!all[modelId]) all[modelId] = {};
        if (val === null || val === undefined || val === '') {
          delete all[modelId][paramKey];
        } else {
          all[modelId][paramKey] = val;
        }
        const serialized = JSON.stringify(all);
        localStorage.setItem(this.modelParamsKey, serialized);
        window.chatStorage?.setSetting?.('model_custom_parameters', serialized).catch(e => console.warn('[Storage] Model params save failed:', e));
      } catch (e) {
        console.warn('Failed to save model parameter:', e);
      }
    }

    resetModelParameters(modelId) {
      if (!modelId) return;
      try {
        const raw = localStorage.getItem(this.modelParamsKey);
        const all = raw ? JSON.parse(raw) : {};
        delete all[modelId];
        const serialized = JSON.stringify(all);
        localStorage.setItem(this.modelParamsKey, serialized);
        window.chatStorage?.setSetting?.('model_custom_parameters', serialized).catch(e => console.warn('[Storage] Model params reset failed:', e));
      } catch (e) {
        console.warn('Failed to reset model parameters:', e);
      }
    }

    /**
     * Model Hyperparameter Configurations Management
     */
    getModelCustomConfig(modelId) {
      if (!modelId) return {};
      try {
        const stored = localStorage.getItem(this.modelConfigsKey);
        if (stored) {
          const parsed = JSON.parse(stored);
          return parsed[modelId] || {};
        }
      } catch (e) {
        console.warn('Error reading custom model config:', e);
      }
      return {};
    }

    setModelCustomConfig(modelId, config) {
      if (!modelId) return;
      try {
        const stored = localStorage.getItem(this.modelConfigsKey);
        const parsed = stored ? JSON.parse(stored) : {};
        parsed[modelId] = {
          ...(parsed[modelId] || {}),
          ...config
        };
        const serialized = JSON.stringify(parsed);
        localStorage.setItem(this.modelConfigsKey, serialized);
        window.chatStorage?.setSetting?.('model_custom_configs', serialized).catch(e => console.warn('[Storage] Custom config save failed:', e));
      } catch (e) {
        console.warn('Error saving custom model config:', e);
      }
    }

    resetModelCustomConfig(modelId) {
      if (!modelId) return;
      try {
        const stored = localStorage.getItem(this.modelConfigsKey);
        if (stored) {
          const parsed = JSON.parse(stored);
          delete parsed[modelId];
          const serialized = JSON.stringify(parsed);
          localStorage.setItem(this.modelConfigsKey, serialized);
          window.chatStorage?.setSetting?.('model_custom_configs', serialized).catch(e => console.warn('[Storage] Custom config reset failed:', e));
        }
      } catch (e) {
        console.warn('Error resetting custom model config:', e);
      }
    }

    /**
     * Evaluates all roles against currently available models in catalog
     */
    evaluateRoles() {
      const allModels = this.catalog.models || [];
      const hierarchy = this.catalog.getCategoriesHierarchy();
      const currentMaster = this.getCurrentMasterModel();
      const masterHasTools = Boolean(currentMaster && currentMaster.hasTools);

      return this.roles.map(role => {
        if (role.type === 'primary_role') {
          let eligibleModels = [];
          if (role.id === 'primary_master') {
            eligibleModels = allModels.filter(m => this.isMasterEligible(m));
          } else if (role.id === 'primary_microtask') {
            eligibleModels = allModels.filter(m => this.isMicrotaskEligible(m));
          } else if (role.id === 'primary_realtime_multi') {
            eligibleModels = allModels.filter(m => this.isRealtimeMultiEligible(m));
          } else {
            eligibleModels = allModels.filter(m => {
              const hasInputs = role.rule.requiresInput.every(inp => m.inputModalities.includes(inp));
              const hasOutputs = role.rule.requiresOutput.every(out => m.outputModalities.includes(out));
              return hasInputs && hasOutputs;
            });
          }

          const matchingCategories = Object.keys(hierarchy).filter(catKey => {
            const cat = hierarchy[catKey];
            const hasInputs = role.rule.requiresInput ? role.rule.requiresInput.every(inp => cat.inputModalities.includes(inp)) : true;
            const hasOutputs = role.rule.requiresOutput ? role.rule.requiresOutput.every(out => cat.outputModalities.includes(out)) : true;
            const noBadOuts = role.rule.excludesOutput ? !cat.outputModalities.some(o => role.rule.excludesOutput.includes(o)) : true;
            return hasInputs && hasOutputs && noBadOuts;
          });

          let assignedModel = currentMaster;
          if (role.id === 'primary_microtask') assignedModel = this.getCurrentMicrotaskModel();
          if (role.id === 'primary_realtime_multi') assignedModel = this.getCurrentRealtimeMultiModel();

          return {
            ...role,
            totalEligible: eligibleModels.length,
            withTools: eligibleModels.filter(m => m.hasTools).length,
            withReasoning: eligibleModels.filter(m => m.hasReasoning).length,
            withLargeContext: eligibleModels.filter(m => m.contextLength >= 128000).length,
            freeModels: eligibleModels.filter(m => m.pricing?.isFree).length,
            matchingCategories,
            currentMaster: assignedModel,
            masterHasTools: Boolean(assignedModel && assignedModel.hasTools),
            models: eligibleModels
          };
        }

        if (role.type === 'tool_category') {
          const isMasterNative = role.checkNative(currentMaster);

          // Evaluate each sub-tool
          const evaluatedTools = role.tools.map(tool => {
            const matchingModels = allModels.filter(tool.filter);

            const currentDelegate = this.getToolDelegate(tool.id);
            const toolIsMasterNative = tool.checkNative ? Boolean(currentMaster && tool.checkNative(currentMaster)) : isMasterNative;

            return {
              ...tool,
              eligibleModelsCount: matchingModels.length,
              models: matchingModels,
              currentDelegate,
              isMasterNative: toolIsMasterNative
            };
          });

          return {
            ...role,
            isMasterNative,
            masterHasTools,
            currentMasterName: currentMaster ? currentMaster.name : 'Nessuno',
            tools: evaluatedTools
          };
        }

        return role;
      });
    }

    /**
     * Returns a flat list of all configurable roles and tools for the sidebar navigation
     */
    getAllConfigurableItems() {
      const currentMaster = this.getCurrentMasterModel();
      const evaluated = this.evaluateRoles();
      const items = [];
      const tr = (k, fallback, params) => (k && window.i18n ? window.i18n.t(k, params) : fallback);

      // 1. Add Master
      const masterRole = evaluated.find(r => r.id === 'primary_master');
      if (masterRole) {
        items.push({
          id: 'master',
          type: 'master',
          group: tr('settings.groupCoreRoles', 'Regia Centrale'),
          name: tr(masterRole.nameKey, masterRole.name),
          icon: masterRole.icon,
          ioSignature: 'text -> text',
          description: tr(masterRole.descKey, masterRole.description),
          isNativeInMaster: true,
          assignedModelId: currentMaster ? currentMaster.id : '',
          assignedModelName: currentMaster ? currentMaster.name : tr('settings.statusUnset', 'Nessuno'),
          assignedProvider: currentMaster ? currentMaster.provider : '',
          eligibleModels: masterRole.models
        });
      }

      // 2. Add Microtask & Fast Router
      const microtaskRole = evaluated.find(r => r.id === 'primary_microtask');
      const currentMicrotask = this.getCurrentMicrotaskModel();
      if (microtaskRole) {
        items.push({
          id: 'microtask',
          type: 'microtask',
          group: tr('settings.groupCoreRoles', 'Regia Centrale'),
          name: tr(microtaskRole.nameKey, microtaskRole.name),
          icon: microtaskRole.icon,
          ioSignature: 'text -> text (low latency)',
          description: tr(microtaskRole.descKey, microtaskRole.description),
          isNativeInMaster: false,
          assignedModelId: currentMicrotask ? currentMicrotask.id : '',
          assignedModelName: currentMicrotask ? currentMicrotask.name : tr('settings.statusUnset', 'Nessuno'),
          assignedProvider: currentMicrotask ? currentMicrotask.provider : '',
          eligibleModels: microtaskRole.models
        });
      }

      // 3. Add Realtime Multi (Vision + Audio)
      const realtimeMultiRole = evaluated.find(r => r.id === 'primary_realtime_multi');
      const currentRealtimeMulti = this.getCurrentRealtimeMultiModel();
      if (realtimeMultiRole) {
        items.push({
          id: 'realtime_multi',
          type: 'realtime_multi',
          group: tr('settings.groupCoreRoles', 'Regia Centrale'),
          name: tr(realtimeMultiRole.nameKey, realtimeMultiRole.name),
          icon: realtimeMultiRole.icon,
          ioSignature: 'text (+audio) -> text',
          description: tr(realtimeMultiRole.descKey, realtimeMultiRole.description),
          isNativeInMaster: false,
          assignedModelId: currentRealtimeMulti ? currentRealtimeMulti.id : '',
          assignedModelName: currentRealtimeMulti ? currentRealtimeMulti.name : tr('settings.statusUnset', 'Nessuno'),
          assignedProvider: currentRealtimeMulti ? currentRealtimeMulti.provider : '',
          eligibleModels: realtimeMultiRole.models
        });
      }

      // 2. Add each Tool from the suites
      evaluated.filter(r => r.type === 'tool_category').forEach(suite => {
        const nativeTools = suite.tools.filter(tool => tool.isNativeEngine);
        const delegableTools = suite.tools.filter(tool => !tool.isNativeEngine);
        const suiteGroupName = tr(suite.nameKey, suite.name);

        if (nativeTools.length) {
          const engine = suite.nativeEngine || {};
          items.push({
            id: `${suite.id}__native`,
            suiteId: suite.id,
            type: 'tool',
            group: suiteGroupName,
            name: tr(engine.nameKey, engine.name) || `Motore Nativo — ${suite.badge}`,
            icon: engine.icon || nativeTools[0].icon,
            ioSignature: nativeTools.map(tool => tool.ioSignature).join('   ·   '),
            description: tr(engine.descriptionKey, engine.description) || nativeTools.map(tool => tr(tool.descKey, tool.description)).join(' '),
            functions: nativeTools.map(tool => ({ id: tool.id, name: tr(tool.nameKey, tool.name), ioSignature: tool.ioSignature, description: tr(tool.descKey, tool.description) })),
            isNativeInMaster: false,
            isNativeCovered: true,
            isNativeEngine: true,
            requiresInternet: nativeTools.some(tool => tool.requiresInternet),
            assignedModelId: null,
            assignedModelName: tr(engine.labelKey, engine.label) || 'Nativo (SynthOrg Engine)',
            assignedProvider: 'SynthOrg Engine',
            eligibleModels: []
          });
        }

        delegableTools.forEach(tool => {
          const delegateVal = this.getToolDelegate(tool.id);
          const isNativeCovered = tool.isMasterNative && delegateVal === 'auto';

          let assignedName = '';
          let assignedProv = '';

          if (isNativeCovered) {
            assignedName = currentMaster ? tr('settings.coveredByMaster', `Coperto dal Master (${currentMaster.name})`, { name: currentMaster.name }) : tr('tools.statusNative', 'Nativo');
            assignedProv = currentMaster ? currentMaster.provider : '';
          } else if (delegateVal && delegateVal !== 'auto') {
            const specModel = this.catalog.models.find(m => m.id === delegateVal);
            assignedName = specModel ? specModel.name : delegateVal;
            assignedProv = specModel ? specModel.provider : '';
          } else {
            assignedName = tr('settings.noModelAssignedShort', 'Nessun modello assegnato');
          }

          items.push({
            id: tool.id,
            suiteId: suite.id,
            type: 'tool',
            group: suiteGroupName,
            name: tr(tool.nameKey, tool.name),
            icon: tool.icon,
            ioSignature: tool.ioSignature,
            description: tr(tool.descKey, tool.description),
            isNativeInMaster: tool.isMasterNative,
            isNativeCovered,
            isNativeEngine: false,
            requiresInternet: Boolean(tool.requiresInternet),
            assignedModelId: delegateVal,
            assignedModelName: assignedName,
            assignedProvider: assignedProv,
            eligibleModels: tool.models
          });
        });
      });

      return items;
    }

    /**
     * ioSignature → OpenRouter function calling JSON Schema parameters.
     * Maps each known signature pattern to a structured parameters object.
     */
    static ioToSchema(ioSignature, toolId) {
      const sig = (ioSignature || '').trim().toLowerCase();

      // Native engine tools with well-known signatures
      if (toolId === 'web_search') {
        return {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query to look up on the web' },
            page: { type: 'integer', description: 'Optional page number (1, 2, 3...) to retrieve additional search results' }
          },
          required: ['query']
        };
      }
      if (toolId === 'web_browse') {
        return {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The exact URL of the web page to open and read' },
            max_chars: { type: 'integer', description: 'Optional maximum characters of text to extract (default 8000)' }
          },
          required: ['url']
        };
      }
      if (toolId === 'sandbox_exec') {
        return {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to execute in the container workspace' }
          },
          required: ['command']
        };
      }
      if (toolId === 'create_file') {
        return {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'Name of the file to write in this chat workspace, with its extension (e.g. "report.md", "data.csv", "script.py"). No directories: the workspace is flat.' },
            content: { type: 'string', description: 'The full text content of the file. Writing an existing name replaces it.' },
            title: { type: 'string', description: 'Optional label shown with the file in the chat.' },
            show_in_chat: { type: 'boolean', description: 'Whether to show the file in the conversation as an attachment (default true).' }
          },
          required: ['filename', 'content']
        };
      }
      if (toolId === 'read_file') {
        return {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'Name of the text file to read from this chat workspace, as listed by list_artifacts.' },
            max_chars: { type: 'integer', description: 'Optional maximum characters to return (default 20000).' }
          },
          required: ['filename']
        };
      }
      if (toolId === 'list_artifacts') {
        return {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: ['all', 'image', 'video', 'audio', 'document', 'archive', 'code'],
              description: 'Optional category filter to list specific file types (default: all)'
            }
          },
          required: []
        };
      }
      if (toolId === 'publish_artifact') {
        return {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative path of the file or directory inside the container/sandbox workspace (e.g. "report.pdf", "dist", "charts/figure.png")'
            },
            title: {
              type: 'string',
              description: 'Optional human-readable title or label to display for the artifact in chat'
            },
            as_zip: {
              type: 'boolean',
              description: 'Whether to package the target file or directory into a compressed .zip archive (default true for directories)'
            }
          },
          required: ['path']
        };
      }

      // Generative & analytical tools based on ioSignature
      if (sig.includes('text') && sig.includes('-> image') && !sig.includes('video')) {
        return {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Detailed description of the image to generate' },
            name: { type: 'string', description: 'REQUIRED short descriptive name/title for this artifact. Used as the file name, the title shown in the viewer/player, and to find it again in the artifacts panel or in the container workspace.' },
            description: { type: 'string', description: 'Optional one-line description of the artifact, shown as a subtitle in the viewer.' },
            style: { type: 'string', description: 'Optional style hint (e.g. photorealistic, anime, oil painting)' }
          },
          required: ['prompt', 'name']
        };
      }
      if (sig.includes('image') && sig.includes('-> image')) {
        return {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Instructions for how to modify or transform the image' },
            image_url: { type: 'string', description: 'URL of the source image to transform' },
            name: { type: 'string', description: 'REQUIRED short descriptive name/title for this artifact. Used as the file name, the title shown in the viewer/player, and to find it again in the artifacts panel or in the container workspace.' },
            description: { type: 'string', description: 'Optional one-line description of the artifact, shown as a subtitle in the viewer.' }
          },
          required: ['prompt', 'image_url', 'name']
        };
      }
      if (sig.includes('text') && sig.includes('-> video')) {
        return {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Detailed description of the video scene to generate' },
            name: { type: 'string', description: 'REQUIRED short descriptive name/title for this artifact. Used as the file name, the title shown in the viewer/player, and to find it again in the artifacts panel or in the container workspace.' },
            description: { type: 'string', description: 'Optional one-line description of the artifact, shown as a subtitle in the viewer.' },
            duration: { type: 'string', description: 'Optional desired duration (e.g. "5s", "10s")' }
          },
          required: ['prompt', 'name']
        };
      }
      if (sig.includes('image') && sig.includes('-> video')) {
        return {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Description of the motion/animation to apply to the image' },
            image_url: { type: 'string', description: 'URL of the source image to animate' },
            name: { type: 'string', description: 'REQUIRED short descriptive name/title for this artifact. Used as the file name, the title shown in the viewer/player, and to find it again in the artifacts panel or in the container workspace.' },
            description: { type: 'string', description: 'Optional one-line description of the artifact, shown as a subtitle in the viewer.' }
          },
          required: ['prompt', 'image_url', 'name']
        };
      }
      if (sig.includes('-> speech') || sig.includes('-> audio') && sig.includes('text')) {
        return {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The text content to synthesize into speech' },
            name: { type: 'string', description: 'REQUIRED short descriptive name/title for this artifact. Used as the file name, the title shown in the viewer/player, and to find it again in the artifacts panel or in the container workspace.' },
            description: { type: 'string', description: 'Optional one-line description of the artifact, shown as a subtitle in the viewer.' },
            voice: { type: 'string', description: 'Optional voice style or speaker name' }
          },
          required: ['text', 'name']
        };
      }
      if (toolId === 'audio_transcription' || sig.includes('file_path -> text') || (sig.includes('audio') && (sig.includes('-> transcription') || sig.includes('-> text')))) {
        return {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative path or filename of the audio file in the workspace or sandbox (e.g. "recording.mp3", "meeting.wav", "stt_voice_123.webm")'
            },
            audio_url: {
              type: 'string',
              description: 'Optional direct URL of the audio file to transcribe'
            },
            language: {
              type: 'string',
              description: 'Optional ISO-639-1 language code hint (e.g. "it", "en", "es")'
            }
          },
          required: ['path']
        };
      }
      if (sig.includes('audio') && sig.includes('-> audio')) {
        return {
          type: 'object',
          properties: {
            audio_url: { type: 'string', description: 'URL of the input audio stream' },
            prompt: { type: 'string', description: 'Optional text instructions for the voice interaction' }
          },
          required: ['audio_url']
        };
      }
      if (sig.includes('music') || sig.includes('lyria')) {
        return {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Description of the music to generate (genre, mood, instruments, tempo)' },
            name: { type: 'string', description: 'REQUIRED short descriptive name/title for this artifact. Used as the file name, the title shown in the viewer/player, and to find it again in the artifacts panel or in the container workspace.' },
            description: { type: 'string', description: 'Optional one-line description of the artifact, shown as a subtitle in the viewer.' },
            duration: { type: 'string', description: 'Optional desired duration (e.g. "30s", "1m")' }
          },
          required: ['prompt', 'name']
        };
      }
      if (sig.includes('image') && sig.includes('text') && sig.includes('-> text')) {
        return {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Question or analysis request about the image' },
            image_url: { type: 'string', description: 'URL of the image to analyze' }
          },
          required: ['prompt', 'image_url']
        };
      }
      if (sig.includes('video') && sig.includes('-> text')) {
        return {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Question or analysis request about the video' },
            video_url: { type: 'string', description: 'URL of the video to analyze' }
          },
          required: ['prompt', 'video_url']
        };
      }
      if (sig.includes('file') && sig.includes('-> text')) {
        return {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Question or extraction request about the document' },
            file_url: { type: 'string', description: 'URL of the PDF or document file' }
          },
          required: ['prompt']
        };
      }

      if (toolId === 'thinking_solver') {
        return {
          type: 'object',
          properties: {
            problem: { type: 'string', description: 'The complete problem, self-contained: the reasoning model does not see this conversation, so include every fact, constraint and what must be found.' }
          },
          required: ['problem']
        };
      }

      // Fallback: generic text prompt
      return {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The request or query to process' }
        },
        required: ['prompt']
      };
    }

    /**
     * Builds the dynamic tool specifications for the Master's function calling payload
     * and the corresponding system prompt section.
     *
     * Returns: { tools: Array<OpenRouterToolSchema>, promptSection: string, toolMeta: Map<toolId, {delegateModelId, isNativeEngine, requiresInternet}> }
     *
     * Only tools that are usable (native engine, natively covered by master, or have an
     * explicit delegate model assigned) are included. Unconfigured tools are omitted so
     * the model only sees what it can actually invoke.
     */
    buildActiveToolSpecs({ offline = false } = {}) {
      const currentMaster = this.getCurrentMasterModel();
      const evaluated = this.evaluateRoles();
      const tools = [];
      const promptLines = [];
      const toolMeta = new Map();

      evaluated.filter(r => r.type === 'tool_category').forEach(suite => {
        suite.tools.forEach(tool => {
          const delegateVal = this.getToolDelegate(tool.id);
          const isNativeEngine = Boolean(tool.isNativeEngine);
          const isMasterNative = tool.isMasterNative;
          const requiresInternet = Boolean(tool.requiresInternet);

          // A chat with its environment set to Isolated cannot use the network,
          // so a tool that needs it is not declared at all. Advertising it and
          // refusing the call afterwards spent prompt on something the model
          // could never use, and invited it to keep trying.
          if (offline && requiresInternet) return;

          // Determine if this tool is available for the Master to call
          let isAvailable = false;
          let routingLabel = '';
          let delegateModelId = null;

          if (isNativeEngine) {
            // Built-in SynthOrg engine (web_search, sandbox_exec)
            isAvailable = true;
            routingLabel = 'Engine: built-in (SynthOrg)';
          } else if (delegateVal && delegateVal !== 'auto') {
            // Explicitly assigned delegate model
            const specModel = this.catalog.models.find(m => m.id === delegateVal);
            isAvailable = true;
            delegateModelId = delegateVal;
            routingLabel = `Delegate: ${specModel ? specModel.name : delegateVal}`;
          } else if (tool.id === 'thinking_solver' && delegateVal === 'auto' && currentMaster?.hasReasoning) {
            // On auto the main model itself, in a clean session: only the problem goes in,
            // and there it reasons at the effort set for the tool, however little the turn does.
            isAvailable = true;
            delegateModelId = currentMaster.id;
            routingLabel = 'Sessione pulita di te stesso: stesso modello, senza questa conversazione e senza tool';
          } else if (isMasterNative && delegateVal === 'auto') {
            // Natively covered by the current Master model
            // These don't need a separate tool call — the Master handles them directly
            const isIt = typeof window !== 'undefined' && window.i18n && window.i18n.getLocale() === 'it';
            const nativeNotice = isIt
              ? `Coperto nativamente dalle tue capacità — rispondi direttamente, nessuna chiamata tool necessaria.`
              : `Covered natively by your own capabilities — use directly, no tool call needed.`;
            promptLines.push(`- ${tool.id}: ${tool.name}. I/O: ${tool.ioSignature}. ${nativeNotice}`);
            return; // skip schema generation
          } else {
            // Not configured, not available — skip entirely
            return;
          }

          // Build the function calling schema
          const parameters = OperationalRegistry.ioToSchema(tool.ioSignature, tool.id);
          tools.push({
            type: 'function',
            function: {
              name: tool.id,
              description: tool.description || tool.name,
              parameters
            }
          });

          // Build prompt line
          const paramNames = Object.keys(parameters.properties || {});
          const requiredParams = parameters.required || [];
          const paramDesc = paramNames.map(p => {
            const isReq = requiredParams.includes(p);
            return `${p}${isReq ? '' : '?'} (${parameters.properties[p].type})`;
          }).join(', ');
          promptLines.push(`- ${tool.id}: ${tool.name}. Input: ${paramDesc}. ${routingLabel}.`);

          // Store metadata for the dispatcher
          toolMeta.set(tool.id, {
            delegateModelId,
            // The registry the specs came from (a chat's own, when it has one),
            // so the delegated call uses that chat's parameters too.
            registry: this,
            isNativeEngine,
            requiresInternet,
            ioSignature: tool.ioSignature,
            suiteName: suite.name
          });
        });
      });

      const isIt = typeof window !== 'undefined' && window.i18n && window.i18n.getLocale() === 'it';
      const mediaRules = isIt
        ? '\n\n[REGOLE VISUALIZZAZIONE FILE E MEDIA]\n' +
          'Quando l\'esecuzione di un tool genera o salva un file multimediale (immagine, video, parlato audio, musica o documento), il risultato restituirà l\'URL del file (es. /api/conversations/...).\n' +
          'Includi e presenta SEMPRE il file generato all\'utente nella tua risposta finale usando il markdown appropriato:\n' +
          '- Immagini: ![Titolo Descrittivo](file_url)\n' +
          '- Video: ![video:Titolo Descrittivo](file_url)\n' +
          '- Parlato / Audio / Musica: [Titolo Descrittivo](file_url)\n' +
          '- Documenti / File: [file:Titolo Descrittivo|file_url]\n' +
          'Non omettere mai il link o riferimento quando un file viene prodotto o pubblicato.'
        : '\n\n[FILE & MEDIA DISPLAY RULES]\n' +
          'When a tool execution generates or saves a media file (image, video, speech audio, music, or document), its result will contain the file URL (e.g. /api/conversations/...).\n' +
          'ALWAYS embed and present the generated file to the user in your final response using appropriate markdown:\n' +
          '- Images: ![Descriptive Title](file_url)\n' +
          '- Videos: ![video:Descriptive Title](file_url)\n' +
          '- Speech / Audio / Music: [Descriptive Title](file_url)\n' +
          '- Documents / Files: [file:Descriptive Title|file_url]\n' +
          'Never omit the link or reference when a file was generated.';

      const promptSection = promptLines.length > 0
        ? (isIt
            ? '\n\n[STRUMENTI DISPONIBILI]\nHai a disposizione i seguenti strumenti. Chiamali tramite function calling quando la richiesta dell\'utente lo richiede:\n' + promptLines.join('\n') + mediaRules
            : '\n\n[AVAILABLE TOOLS]\nYou have the following tools available. Call them via function calling when the user\'s request requires it:\n' + promptLines.join('\n') + mediaRules)
        : '';

      return { tools, promptSection, toolMeta };
    }
  }

  window.OperationalRegistry = OperationalRegistry;
  window.operationalRegistry = new OperationalRegistry(window.openRouterCatalog);
})();
