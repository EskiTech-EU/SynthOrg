# Lavori IDE e impostazioni

Elenco del 2026-09-24. Per ogni punto: com'è oggi nel codice, cosa c'è da fare, cosa resta da decidere.
"Locale" = progetto nella cartella dell'utente, editor SideX (`vendor/sidex`). "Pod" = progetto container,
editor C disegnato a pixel (`server/code-editor`, mostrato da `resources/js/code-canvas.js`).

> **Dal 2026-10-10 i due editor stanno dentro la cornice unica di un progetto** (`resources/js/code-workspace.js`).
> La colonna dei file è della pagina (`resources/js/project-tree.js`, rotte `/projects/:id/files` in
> `server/project-files.js`): l'albero di SideX e quello dell'editor del pod partono chiusi, e il file premuto
> nella colonna viene aperto dall'editor (`code_open_file` per SideX, messaggio `IN_FILE` per il pod). La
> striscia del ramo è nella colonna per entrambi i tipi; Storico e Carica sono in fondo alla colonna. Il
> terminale: in SideX, dal 2026-10-11, è una scheda della sezione sotto l'editor (il pannello, dove sta anche
> la vista delle estensioni: `synthorgFrame.contribution.ts`); nel pod è ancora una finestrella sopra l'editor,
> disegnata dall'editor (`term.c`, `r_panel`). Dove i punti qui sotto parlano dell'albero dei file,
> del selettore Editor/Storico o della striscia sopra l'albero, vale questo.
>
> **Dal 2026-10-11 sotto le funzioni della cornice c'è la riga dei file aperti** (`#proj-filebar`, logica in
> `code-workspace.js`: `readBar`, `renderFile`, `fileDo`, `fileZoom`, `fileClose`, `fileNew`, `fileName`), uguale
> sopra ogni editor: a sinistra le schede dei file aperti (pallino = non salvato, × = chiudi, clic = porta in
> vista), a destra rinomina, nuovo, salva, salva con un altro nome, annulla, ripeti, zoom (−, %, +, adatta).
> Ogni editor dice cosa ha aperto come `{ files: [{ path, dirty }], shown, zoom }` e riceve le stesse parole
> (`undo`, `redo`, `save`, `zoomIn`, `zoomOut`, `zoomReset`, chiudi un file): SideX con `code_files` e
> `code_do` + `code_did` (`synthorgFrame.contribution.ts`; le sue schede sono spente, `workbench.editor.showTabs:
> none`), l'editor del pod con `OUT_FILES` e `IN_DO` / `IN_SHUT` (le sue schede non si disegnano quando i file
> li mostra la pagina), photocraft con `window.photo.bar/zoom/close` (interrogato dopo l'uso: non avvisa da
> solo), i testi con `window.studio.bar/zoom`. Nuovo, rinomina e copia chiedono il nome nella colonna dei file
> (`projectTree.newFile/rename/copyAs`, azione `copy` in `server/project-files.js`). La colonna si chiude a una
> striscia col suo tasto (`#proj-side-close`).

Ordine consigliato: prima i lavori piccoli e indipendenti (4, 5, 6 e la parte locale del 10), poi 1, 2 e 11,
poi 7, 8, 9 che toccano dati e comportamento. L'11 e il 9 vanno insieme: il pannello storico prende il posto
della vista git di SideX. Il 3 attraversa tutto: conviene usarlo come controllo finale di ogni altro punto.

**Stato al 2026-09-25.** Fatti e provati nell'app: 4, 5, 6, l'11, la parte senza decisioni di 1, 3 e 7; il 9 e
il 10 (pod) erano già fatti. Restano aperti: le decisioni di 1, 2, 3, 7, 8, 11; la prova a mano del 10 in
locale.

---

## 1. Tasto destro e popup

**Oggi**
- **Locale (SideX):** i menu del tasto destro sono quelli HTML di VS Code (in modalità web non esistono menu
  nativi, `vs/platform/window/common/window.ts:146-152`). I loro colori non seguono il tema SynthOrg:
  `synthorgAppearance.contribution.ts:58-92` non imposta `menu.*`, quindi restano quelli di Dark/Light Modern
  (fallback `#141414` / `#252525` in `vs/base/browser/ui/menu/menu.ts:357,1129`). Unica correzione già fatta:
  i menu della barra non escono più dal bordo (`menubar.ts:1148-1159`).
- **Pod (editor C):** nessun menu contestuale.
  - Il tasto destro sull'albero seleziona solo la riga (`ui.c:1278`); nel testo e nel terminale non fa niente.
  - Il menu del browser è bloccato (`code-canvas.js:197`).
  - I popup sono un solo riquadro in alto (`draw_overlay`, `ui.c:970-1011`). Le conferme (elimina, chiudi
    senza salvare) hanno solo il testo e la riga "Invio conferma · Esc annulla", senza pulsanti.
- **Pagina (sezione Code):** nessun menu contestuale. Le finestre sono `<dialog class="workspace-dialog">`
  (`<dialog>` in fondo a `index.html`).

**Da fare**
- **SideX:** colori `menu.*` (sfondo, testo, selezione, separatori, bordo, ombra) iniettati dal tema, come gli
  altri token.
- **Pod: menu contestuale disegnato nell'editor, con la stessa grafica di SideX.**
  - Albero: nuovo file, nuova cartella, rinomina, elimina, copia percorso.
  - Testo: taglia, copia, incolla, seleziona tutto.
  - Scheda del terminale: copia, incolla, pulisci, nuovo terminale, chiudi.
- **Pod: popup di conferma con pulsanti veri** (Annulla / Elimina), cliccabili, oltre a Invio/Esc.
- **Verifica:** passare tutti i popup di SideX e della pagina con il tema chiaro e scuro.

> **Stato 2026-09-25: fatto, provato nell'app.**
> - **SideX:** menu del tasto destro, barra dei menu, Ctrl+P e palette, elenchi, suggerimenti e hover prendono i
>   colori del tema SynthOrg (`synthorgAppearance.contribution.ts`). La pagina manda i colori già risolti in
>   `#rrggbb`, perché alcuni token sono `color-mix()` e SideX legge solo esadecimali (`code-workspace.js`,
>   `appearance()`). Provato con il tema chiaro e con quello scuro.
> - **Pod:** menu del tasto destro disegnato dall'editor (`ui.c`, `menu_open`), su albero, testo e terminale
>   (scheda o area), con le voci elencate sopra. "Chiudi" nel terminale è "Chiudi terminale".
>   - Copia e "Copia percorso" restano negli appunti interni dell'editor, come Ctrl+C: dal pod non esce niente.
>   - Incolla dal menu chiede gli appunti di Windows all'host (`OUT_PASTE` → comando `editor_clipboard`, API
>     Win32). La via `navigator.clipboard` apriva la richiesta di permesso di WebView2.
>   - "Pulisci" svuota la cronologia e manda Ctrl+L alla shell, che ridisegna il prompt in alto.
> - **Pod:** le conferme (elimina, chiudi senza salvare) hanno i pulsanti Annulla ed Elimina / "Chiudi senza
>   salvare". Invio ed Esc funzionano ancora.

**Da decidere:** cosa hai visto di rotto. Se ci sono casi precisi (menu tagliato, fuori posto, colore
sbagliato), vanno aggiunti qui con uno screenshot.

---

## 2. Estensioni dell'IDE in un solo posto, nelle impostazioni

**Oggi**
- **Impostazioni › Ambiente & Sicurezza** ha già un elenco con interruttori (`main.js:816-925`, rotta
  `server/index.js:623-626`, `server/code-extensions.js`). Vale solo per il pod: le estensioni spente non
  entrano nell'immagine degli strumenti (`sandbox.js:745-758`) e cambiare un interruttore ricostruisce
  l'immagine (`sandbox.js:568`).
- **Nel locale** le stesse impostazioni non contano.
  - SideX ha la sua vista Estensioni e il marketplace, entrambi attivi (`main.ts:340`,
    `src-tauri/src/commands/extensions.rs:175`).
  - All'apertura di un progetto vengono riattivate tutte (`code_runtime.rs:696`
    `set_disabled_extensions(&[])`).
- Il marketplace sembra essere quello di ripiego di SideX (`product.ts:75`, `marketplace.siden.ai`): da
  confermare.

**Da fare**
- **Un solo elenco, in Impostazioni**, valido per locale e pod: stesso file `data/code-extensions.json`, letto
  anche da `code_runtime.rs` al posto di `set_disabled_extensions(&[])`.
- **Togliere da SideX** la vista Estensioni, la voce di menu e le azioni di installazione, con lo stesso
  meccanismo di `synthorgProjectScope.contribution.ts`.
- **Cercare e installare dalle impostazioni**, se si tiene il marketplace. Nel pod l'installazione passa dalla
  ricostruzione dell'immagine.

**Da decidere**
- Marketplace sì o no. Se sì: quale, quello di SideX o Open VSX.
- Le estensioni installate dall'utente valgono per tutti i progetti o per progetto.
- **Il punto di partenza nel locale.** Il file segna solo le estensioni accese, e senza file sono tutte spente:
  è pensato per il pod, dove l'editor è nostro e non le usa. Applicato così al locale spegnerebbe in SideX
  tutte le 84 estensioni, compresi i temi Dark/Light Modern su cui si appoggia il tema SynthOrg e le grammatiche
  dei linguaggi. Serve decidere se nel locale si parte da tutte accese, se alcune (temi, grammatiche) sono
  sempre accese, o se i due tipi di progetto partono in modo diverso dallo stesso elenco. Finché non è deciso,
  la vista Estensioni di SideX resta: toglierla adesso lascerebbe il locale senza un posto dove gestirle.

---

## 3. GUI pod e locale unificate per bene

**Oggi**: `code-workspace.js` distingue i due tipi in pochi punti.
- **`:84`**: editor diverso (webview SideX oppure canvas).
- **`:244`**: badge "Isolato" solo per il pod.
- **`:330`**: riga del percorso della scheda progetto.
- **`:392`**: messaggio di apertura.
- **`:418`**: testo di eliminazione.
- **`:890`**: `runCommand` solo locale. Da oggi anche il pod mostra i comandi del modello nel terminale,
  attraverso il server.

Barra superiore, permessi, barra git e pannello AI sono già in comune.

**Dove differiscono ancora**

| | Locale (SideX) | Pod (editor C) |
|---|---|---|
| Menu tasto destro | sì (non a tema) | no (punto 1) |
| Estensioni | sì, dalla vista di SideX | solo incluse, dalle impostazioni (punto 2) |
| Vista git / storico | Storico di SynthOrg; vista git di SideX tolta (punto 11) | Storico di SynthOrg (punto 9) |
| Trascinare file tra cartelle | da provare a mano (punto 10) | sì (punto 10) |
| Ricerca nei file, palette comandi | sì | solo Ctrl+P per nome file |
| Terminale | schede in alto, grafica SideX | schede in alto, stessa grafica |
| Titolo dell'albero | nome progetto | nome progetto (fatto il 2026-09-25) |
| Tendine | stile SideX | nessuna |

**Da fare**
- **Titolo dell'albero** con il nome del progetto: l'editor va lanciato con il nome, per esempio come
  secondo argomento.
- **Stesse icone, stessi colori, stesse scorciatoie da tastiera** nei due editor. Sulle scorciatoie c'è da
  scrivere una tabella di confronto.
- **Controllo per ogni punto di questo file**: che valga per entrambi i tipi di progetto.
- **Codice probabilmente morto da verificare:** `code_runtime.rs:344-348,700-709` porta nel container il
  provider git di SideX. Il pod però non usa più SideX.

> **Stato 2026-09-25.**
> - **Titolo dell'albero:** fatto. `editor_start` riceve `title` e lo passa all'editor come secondo argomento.
> - **Codice morto:** verificato. SideX non si apre mai su un progetto pod (`code-workspace.js` usa il canvas per
>   `runtime.kind === 'container'`), quindi in `code_runtime.rs` è morto tutto il ramo "SideX nel container":
>   `apply(..., Some(container))`, il `GitLauncher`, l'`Agent` (con `server/code-agent.cjs`), l'instradamento dei
>   comandi verso il container e il relay dell'extension host. È un blocco grande: da togliere in un passo a sé,
>   dopo il tuo ok.
>
> **Scorciatoie: SideX (come VS Code) e pod a confronto.** Uguali: Ctrl+S, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z,
> Ctrl+X/C/V, Ctrl+A, Ctrl+L, Ctrl+/, Ctrl+Shift+K, Alt+Su/Giù, Ctrl+F, Ctrl+H, F3 / Shift+F3, Ctrl+G, Ctrl+P,
> Ctrl+W, Ctrl+Tab, Ctrl+B, Ctrl+Shift+E, Ctrl+` e Ctrl+J, Ctrl+Shift+`, F2 e Canc nell'albero.
>
> | Tasti | SideX | Pod |
> |---|---|---|
> | Ctrl+Shift+P | palette dei comandi | niente |
> | Ctrl+Shift+F | cerca nei file | niente |
> | Ctrl+D | aggiunge la prossima occorrenza (più cursori) | seleziona la parola, poi passa alla prossima occorrenza |
> | Ctrl+Shift+D | vista Esegui e debug | duplica la riga (in SideX è Shift+Alt+Giù) |
> | Shift+Alt+Su/Giù | copia la riga sopra/sotto | niente |
> | Ctrl+N | file nuovo senza nome | chiede il nome e lo crea nell'albero |
> | Ctrl+Shift+T | riapre l'ultima scheda chiusa | nuovo terminale |
> | Ctrl+Shift+W | chiude la finestra (disattivato in SynthOrg) | chiude il terminale |
> | Ctrl+Shift+C | apre un terminale esterno (nel terminale di SideX non copia) | copia la selezione del terminale |
> | Ctrl+= / Ctrl+- / Ctrl+0 | zoom di tutta l'interfaccia | zoom del solo testo |
> | Ctrl+Alt+Su/Giù, Ctrl+clic | più cursori | niente (un solo cursore) |
>
> Da decidere con il resto del punto 3: quali differenze allineare (per esempio Ctrl+Shift+D e Ctrl+Shift+T nel
> pod) e quanto portare di palette e ricerca.

**Da decidere:** quanto portare nel pod di quello che SideX ha già. Ricerca nel progetto e palette comandi
sono i due buchi più grossi.

---

## 4. Tasto "Sincronizza" dentro Ruoli e tool

**Oggi**
- **`#btn-sync-catalog`** stava nella barra in alto dell'app. Riscarica il catalogo
  modelli di OpenRouter (`loadData(true)`, `main.js:3172-3174`).
- **`#code-git-sync`** è un altro "sincronizza", nella barra git di Code (`index.html:240`). Fa solo il fetch
  da GitHub e resta dov'è.

**Da fare**
- **Spostare `#btn-sync-catalog`** dentro Impostazioni › Ruoli & Tool (`#settings-subview-roles`), vicino alla scelta dei modelli. Con il testo "Aggiorna catalogo modelli" e la data
  dell'ultimo aggiornamento.
- **Togliere il pulsante dalla barra in alto** e le chiavi `nav.sync` / `nav.syncTooltip` se non servono più.

> **Stato 2026-09-25: fatto, provato nell'app.** Il pulsante "Aggiorna catalogo modelli" sta in fondo alla colonna
> di Impostazioni › Ruoli & Tool, con la data dell'ultimo aggiornamento sotto (`catalog.lastUpdated`, si aggiorna
> anche al cambio lingua). Tolti il pulsante dalla barra in alto, `.btn-header-sync` e le chiavi `nav.sync*`.

---

## 5. Colorare tutte le tendine dell'IDE

**Oggi**: solo `#code-chat-select` ha lo stile nuovo (`styles.css:102-112`).
- **Freccia di sistema ancora visibile:** `#code-perm-code` e `#code-perm-terminal` (`styles.css:6413-6414`),
  e `#code-repo-select` (`styles.css:86`).
- **SideX:** il tema imposta solo `dropdown.background` e `dropdown.foreground`. Mancano:
  - `dropdown.border` e `dropdown.listBackground`
  - `quickInput.*` e `quickInputList.*` (Ctrl+P, palette)
  - `list.*` (selezione e hover)
  - `widget.shadow`

**Da fare**
- **Nella pagina:** una sola regola comune per tutte le `select` della sezione Code, invece di una per ogni
  id: `appearance: none`, freccia a gradiente, bordi al passaggio e al focus, `option` a tema.
- **In SideX:** aggiungere le chiavi mancanti in `synthorgAppearance.contribution.ts`.
- **Verifica:** tema chiaro e scuro.

> **Stato 2026-09-25: fatto, provato nell'app con il tema chiaro e con quello scuro.** Una sola regola per tutte le
> `select` di `#view-code` e dei dialoghi `code-*` (`styles.css`), con le varianti per i permessi (più bassa) e
> per i campi dei dialoghi (larghezza piena, alta come gli input). In SideX aggiunte le chiavi `dropdown.*`,
> `quickInput*`, `list.*`, `menu.*`, `widget.*`, `editorWidget.*`, `editorSuggestWidget.*` e `editorHoverWidget.*`.

---

## 6. Permessi dalla barra in alto al tab chat

**Oggi**
- **`#code-perm-group`** (Codice, Terminale, pulsante "Approvazioni ricordate") stava nella barra in alto di
  Code (JS `code-workspace.js`, `renderPermissions`).
- **Il pannello chat** (`#code-ai-panel`) è fatto di:
  - `.code-ai-head`, con il selettore chat;
  - `#code-chat-mount`, dove viene spostato il workspace della chat.
  - Dentro il workspace c'è la riga di `renderChatHeader()` (`chat.js:2907`): artifact, memoria,
    ambiente, tool.

**Da fare**
- **Una riga permessi nuova** in `#code-ai-panel`, tra `.code-ai-head` e `#code-chat-mount`. Deve stare lì e
  non dentro il workspace, perché il workspace è lo stesso del tab Chat e fuori da Code i permessi non hanno
  senso.
- **Stessi controlli** (due tendine con lo stile del punto 5, più il pulsante approvazioni) e stesse funzioni
  JS; si sposta solo il markup.
- **Liberare la barra in alto.** Controllare che non restino riferimenti a `.code-editor-project` usati per il
  layout.

> **Stato 2026-09-25: fatto, provato nell'app.** La riga "Codice · Terminale · approvazioni ricordate" sta tra
> `.code-ai-head` e `#code-chat-mount`, su una riga sola alla larghezza del pannello (tolte le due icone davanti
> alle etichette, per farci stare le tendine). Il JS è lo stesso. `.code-editor-project` resta solo per il nome e
> i badge del progetto.

---

## 7. Impostazioni della chat separate da quelle globali, ruoli compresi

**Oggi**
- **Per chat esistono solo:**
  - titolo e archivio;
  - memoria della chat e i suoi valori (`memory_settings_json`, null = globali);
  - dossier globale sì/no;
  - rete e immagine del sandbox (`database.js:190-204`).
- **I ruoli sono solo globali:** master, microtask, realtime, delegati dei tool, thinker. Sono salvati in
  localStorage e nelle impostazioni del server (`operational.js:13-91`), e la chat li legge sempre da lì
  (`chat.js:385,461,1753,1871,3899`).
- **Punti confusi:**
  - Il dossier ha due interruttori sovrapposti: uno globale solo in localStorage,
    `synthorg_global_memory_enabled` (`chat-workspace.js:292-294`), e uno per chat
    (`global_memory_enabled`); `chat.js:397-403` li combina in AND.
  - `openGlobalMemories` è definita due volte (`chat-workspace.js:272,283`).
  - La scheda del master nella chat apre le Impostazioni globali (`chat.js:2956`).

**Da fare**
- **Ruoli per chat**, con lo stesso schema della memoria: colonna `roles_json` (null = globali, salvati solo
  i valori propri); la chat li legge da `Store.context()` o da un helper che unisce propri e globali.
- **Pannello "Impostazioni della chat"** aperto dalla scheda del master, con l'interruttore "Valori propri"
  come nella memoria. Le Impostazioni globali restano i valori di partenza per le chat nuove.
- **Dossier:** un solo interruttore globale lato server e un solo interruttore per chat.
- **Pulizia:** togliere la definizione doppia di `openGlobalMemories`.

> **Stato 2026-09-25: fatta la parte senza decisioni.**
> - **Dossier:** l'interruttore globale ora sta nel server (impostazione `global_memory_enabled`), e il server lo
>   applica sopra quello di ogni chat (`database.js`, `context`). Il vecchio valore in localStorage viene portato
>   sul server una volta e poi cancellato (`chat-workspace.js`, `globalDossierEnabled`). Test in
>   `tests/dossier_projects.test.js`.
> - **Pulizia:** tolta la prima definizione di `openGlobalMemories`, che veniva comunque sovrascritta.
> - **Ruoli per chat e pannello "Impostazioni della chat":** fermi sulle due decisioni qui sotto.

**Da decidere**
- **Cosa si può cambiare per chat:** solo il master, oppure anche microtask, thinker e delegati dei singoli
  tool, e i parametri del modello?
- **Chat di Code:** seguono le impostazioni della chat o c'è un livello "progetto" in mezzo?

---

## 8. Verificare l'unificazione GitHub

> **Stato 2026-10-10: rami e sincronizzazione (decisione Samu).** Supera la nota del 2026-09-24 qui sotto per
> tutto ciò che riguarda rami, scarica e carica. GitHub resta solo dell'utente: i modelli non ci arrivano.
> - **Due modi di collegamento**, scelti nel dialogo della repository (anche alla creazione del progetto):
>   *repository intera* (tutti i rami, il principale come primo) oppure *un solo ramo* (anche il principale;
>   un ramo che su GitHub non c'è parte dal principale e nasce su GitHub al primo caricamento).
> - **Il ramo qui e il ramo con lo stesso nome su GitHub sono la stessa cosa.** Scarica porta qui i suoi passi,
>   Carica manda quelli fatti qui. Mai forzato, mai unito: se entrambi i lati hanno passi propri non si muove
>   niente e un dialogo fa scegliere tra «tieni il lavoro di qui su un ramo nuovo» e «tieni la versione di
>   GitHub» (i passi tolti dal ramo restano in `refs/synthorg/kept`).
> - **Intestazione sopra l'esplora file**: ramo, Scarica, Carica con i conteggi, interruttore di
>   sincronizzazione automatica (uno per ramo, spento di default: acceso, scarica all'apertura e carica a ogni
>   passo registrato). Con la repository intera il nome del ramo apre l'elenco per spostarsi o crearne uno
>   (nasce in locale, va su GitHub al primo Carica). Locale: dentro SideX (`vendor/sidex/src/synthorgBranch.ts`,
>   agganciata in `explorerViewlet.ts`). Pod: disegnata dalla pagina nello spazio che l'editor C lascia sopra
>   l'albero (`IN_INSET`, `OUT_SIDEBAR`). Stato e azioni sono sempre della pagina (`code-workspace.js`).
> - **Server** (`projects.js`): azioni `branches`, `switch`, `new-branch`, `pull`, `push`, `resolve`, `sync`,
>   `link` (con `mode` e `branch`), `unlink`; colonne `repo_mode`, `repo_branch`, `auto_sync`,
>   `repo_asked_at`. Prove con git vero in `tests/code_branches.test.js` (una cartella fa da GitHub).
> - **Via:** il dialogo «Carica su GitHub» con la scelta libera del ramo.
> - **Da fare:** creare una repository nuova da qui. Serve il permesso `administration: write` nell'app GitHub
>   (oggi escluso apposta) e chi ha già registrato l'app deve aggiornarla o ricrearla. Da decidere con Samu.
> - **Non provato:** un caricamento vero su GitHub (le prove nell'app hanno solo letto da GitHub).

> **Stato 2026-09-24: semplificato (decisione Samu, "tagliamo la testa al toro").** GitHub è solo dell'utente, i
> modelli non ci arrivano in nessun modo.
> - **Resta:** collegare o scollegare il repo, e un tasto "Carica su GitHub" con un dialogo per scegliere il ramo
>   (main, un ramo esistente o un ramo nuovo). Il caricamento non è mai forzato: se GitHub ha passi che qui non ci
>   sono, lo dice e non sovrascrive.
> - **Via:** ramo di lavoro con prefisso, pull request, merge dall'app, sincronizza.
> - **Nello Storico:** i passi già su GitHub hanno l'icona (qualsiasi ramo).
>
> Il resto di questa sezione è la situazione di prima.

**Oggi**: un solo modulo per l'accesso (`server/github.js`: GitHub App, OAuth PKCE, token in `integrations`)
e uno solo per git (`server/projects.js`, `runGit` `:373-391`).
- **Locale:** git dell'host nella cartella.
- **Pod:** `podman exec` nel container.
- **Pod con credenziali:** container usa e getta sul volume, così il container del modello non vede mai il
  token.
- Il tipo di progetto `github` è stato migrato a `podman` (`database.js:361-373`).

**Trovato, da verificare o sistemare**
- **"Sincronizza" fa solo fetch** (`projects.js:543-608`). Non c'è pull, cioè le modifiche remote non
  arrivano mai nel ramo locale.
- **Push solo sul ramo di lavoro** (`<prefisso>/lavoro`), pull request e merge via API: da provare da capo su
  locale e su pod, con un repo vero.
- **Permessi dell'agente mai usati:** push e pull request esistono come permessi, ma nessuno chiama
  `gitAction` con attore `agent`.
- **Tool MCP:** `clone_repo`, `pull_repo` e `push_repo` dell'MCP synthorg non risultano nel codice cercato.
  Trovare dove vivono e se usano lo stesso modulo.

**Da fare** (aggiornato alla decisione del 2026-09-24)
- **Lista di prove, su locale e su pod:**
  1. collegare un repo;
  2. clonare;
  3. modificare;
  4. "Carica su GitHub" su main, su un ramo esistente e su un ramo nuovo;
  5. caricamento quando GitHub ha passi che qui non ci sono: deve dirlo e non sovrascrivere;
  6. icona di GitHub sui passi dello Storico già caricati;
  7. scollegare il repo;
  8. token scaduto e rinnovo.

**Da decidere:** se le modifiche fatte direttamente su GitHub devono poter arrivare nel progetto. Oggi non
arrivano: "Sincronizza" non c'è più e il caricamento si ferma se GitHub è avanti. Se devono arrivare, va deciso
come e cosa succede quando ci sono modifiche locali non ancora caricate.

---

## 9. Vista git e storico navigabile (Ctrl+Z / Ctrl+Shift+Z)

> **Stato 2026-09-24: fatto (prima versione).** Decisione di Samu: niente Ctrl+Z di progetto. Resta quello di
> SideX e dell'editor del pod, e lo storico si naviga da una scheda "Storico", come un GitHub sul computer
> ("il save è come una push").
>
> **Server** (`projects.js`), rotte `/projects/:id/history`, `…/history/commit|tree|file|restore`:
> - elenco dei passi, con autore, tool e +/−;
> - diff di un passo;
> - il progetto e ogni file com'erano a un passo;
> - storia di un file che segue le rinomine;
> - ripristino di un file o del progetto, registrato come passo dopo aver salvato lo stato attuale.
>
> **Pagina** (`code-history.js`): interruttore Editor/Storico nella barra. Lo storico si sovrappone all'editor,
> così il pod e i suoi terminali non si ridimensionano, e nel locale SideX viene nascosto. Il badge "N in
> storico" lo apre, e i passi nuovi compaiono da soli (controllo ogni 4 s).
>
> **Salvataggi del pod**: l'editor C scrive "change" in `/tmp/.synthorg-run/events`. Il server lo segue con
> `tail -F` e registra il passo dopo 1,2 s di quiete.
>
> **Comandi del modello** (pod e locale): diventano un passo del modello (`$ comando`, tool `sandbox_exec`) e non
> finiscono più nel salvataggio successivo dell'utente.
>
> **Corretto:** i commit di cartelle nuove non hanno più come titolo i trailer (`--untracked-files=all`). Quelli
> vecchi si leggono comunque bene.
>
> **Resta:** GitHub nella stessa vista. Oggi c'è solo l'icona sui passi che sono già su GitHub; va deciso se
> caricare in automatico sul ramo di lavoro.

**Oggi**
- **Ogni modifica diventa un commit automatico** (`ProjectManager.checkpoint`, `projects.js:517-531`), con i
  trailer `SynthOrg-Source: user|agent` e `SynthOrg-Tool`. Sono salvataggi dell'editor raccolti per 1,2 s,
  più ogni modifica del modello (`code-tools.js:141-146`).
- **Non esiste niente per tornare indietro:** né rotte di log, diff o ripristino, né una vista. L'unico
  `git log` legge l'ultimo commit (`projects.js:496-502`).
- **Il prompt del modello promette una cosa che l'app non fa:** "sempre annullabile" (`chat.js:498`,
  `i18n.js:134`, `code-tools.js:14-18`).

*(La parte qui sotto è il piano di prima della decisione: niente Ctrl+Z di progetto, lo storico si naviga dalla
scheda Storico. Resta come riferimento.)*

**Da fare**
- **Server:**
  - `GET /projects/:id/history`: elenco dei checkpoint con autore (utente o modello), tool, file toccati e ora.
  - `GET .../history/:commit`: diff.
  - `POST .../history/restore`: ripristina lo stato di un checkpoint. Deve farlo senza perdere niente: il
    ripristino è un commit nuovo e la storia resta intera.
- **Undo / redo di progetto:** un cursore sulla storia (per esempio `refs/synthorg/cursore`).
  - Ctrl+Z porta i file al checkpoint precedente.
  - Ctrl+Shift+Z li porta avanti.
  - Una modifica nuova fatta dopo un passo indietro chiude i "passi avanti", come in ogni editor.
- **Vista:** pannello storico in Code, uguale per locale e pod. Mostra righe raggruppate per turno del modello
  o per salvataggio, apertura del diff, ripristino con un clic, e i passi del modello distinti da quelli
  dell'utente.
- **Solo dopo:** allineare il testo del prompt ("sempre annullabile").

**Da decidere**
- **Tasti.** Dentro l'editor, Ctrl+Z è l'annulla del testo del file aperto. L'annulla di progetto ha bisogno
  di un posto suo:
  - Ctrl+Z e Ctrl+Shift+Z solo quando il focus è sul pannello storico, oppure
  - una combinazione diversa (per esempio Ctrl+Alt+Z), oppure
  - Ctrl+Z nell'editor che, a file senza più annullamenti, passa allo storico di progetto.
- **Granularità di un passo:** un salvataggio, un turno intero del modello, o una singola modifica di un tool.

---

## 10. Trascinare i file tra le cartelle del progetto

> **Stato 2026-09-24.**
> - **Pod:** fatto e provato. Durante il trascinamento la cartella di arrivo si illumina e un'etichetta segue il
>   mouse. Tenendo il file fermo sopra una cartella chiusa, dopo 0,65 s questa si apre. Vicino ai bordi la lista
>   scorre, con Esc si annulla. Le schede aperte seguono il file; un clic senza movimento apre come prima.
> - **Locale:** aggiunto `.disable_drag_drop_handler()`, da provare a mano.
> - **Resta aperto:** lo spostamento nel pod non diventa ancora un passo git, perché i salvataggi dell'editor C
>   non arrivano all'host (punto 9).

In SideX normale si sposta un file trascinandolo su un'altra cartella dell'Esplora risorse. Qui non funziona.

**Oggi**
- **Locale (SideX):** l'Esplora risorse ha ancora il suo drag and drop (`explorerViewer.ts`, nessuna nostra
  modifica). Causa probabile: la webview di SideX nasce senza togliere il gestore del drop di file di Tauri
  (`src-tauri/src/code_view.rs:149`, manca `.disable_drag_drop_handler()`). Su Windows quel gestore
  intercetta il trascinamento HTML dentro la pagina. La finestra principale ce l'ha spento
  (`tauri.conf.json:25`, `dragDropEnabled: false`), quella di SideX no.
- **Pod (editor C):** il trascinamento non esiste. L'albero gestisce solo clic e doppio clic (`ui.c`).

**Da fare**
- **Locale:** aggiungere `.disable_drag_drop_handler()` al `WebviewBuilder` di `code_view.rs`, poi provare:
  spostamento di file e cartelle, rilascio sulla radice, annullamento con Esc, trascinamento di più file.
- **Pod:** trascinamento nell'albero (`DRAG_TREE_MOVE`).
  - Mentre trascini: la riga fantasma segue il mouse e la cartella di destinazione è evidenziata; tenendola
    ferma sopra si apre.
  - Al rilascio: `rename()` nel container, con conferma se il nome esiste già.
  - I file aperti in una scheda seguono il nuovo percorso.
- **Tutti e due:** lo spostamento finisce nello storico (punto 9) come un checkpoint normale.

**Da decidere:** se trascinare file da Windows dentro il progetto rientra qui. Per il pod è la direzione
ammessa (Windows→pod), ma è un canale nuovo.

---

## 11. Via i comandi git manuali dall'IDE

Il menu dei branch nella barra del titolo di SideX (filtro "Filter branches, stashes, tags…") è un'aggiunta di
SideX (`vendor/sidex/src/vs/workbench/browser/parts/titlebar/titlebarPart.ts:966`, azioni `:1275-1290`). Offre:
- New, Rename e Delete Branch;
- Fetch All Remotes, Pull, Push;
- Commit, Merge, Rebase;
- Stash, Pop e Apply.

**Regola (Samu, 2026-09-24):**
- L'utente non gestisce git: lo gestiamo noi, in automatico.
- Merge e simili dipendono dalle approvazioni in chat.
- Su GitHub il modello può spingere solo sui branch.
- Il git locale serve a vedere cosa è successo e a tornare indietro (punto 9), non si comanda a mano.

**Da fare**
- **Menu dei branch:** togliere le azioni. Se resta qualcosa, solo il nome del ramo in sola lettura, oppure un
  collegamento al pannello storico del punto 9.
- **Controllo sorgente di SideX** (`workbench.view.scm`, riga di commit, pulsanti sincronizza e pubblica della
  barra di stato): nascondere, e sostituire con il pannello storico del punto 9.
- **Palette dei comandi:** togliere i comandi `git.*` di scrittura, con lo stesso meccanismo di
  `synthorgProjectScope.contribution.ts`. Diff e blame possono restare se servono a guardare.
- **Pod:** nessuna interfaccia git da togliere. Controllare che non ne arrivi una con le estensioni (punto 2).
- **Punto 8:** "sincronizza", push e pull request passano solo dalle azioni SynthOrg e dalle approvazioni in
  chat, mai da comandi git dell'editor.

> **Stato 2026-09-25: fatto, provato nell'app.**
> - **Menu dei rami:** tolto (`titlebarPart.ts`). Il ramo resta visibile nella barra di SynthOrg sopra l'editor.
> - **Controllo sorgente:** la vista e la sua icona non vengono registrate (`synthorgProjectScope.contribution.ts`),
>   e Ctrl+Shift+G non apre più niente. Dalla barra di stato sono tolti il ramo, sincronizza e commit
>   (`git.contribution.ts`).
> - **Comandi `git.*`:** in SynthOrg vengono registrati solo quelli che guardano (`openDiff`, `openChange`,
>   `openFile`, `openAllChanges`, `refresh`, `showOutput`, `copyToClipboard`). Commit, stage, rami, stash, tag,
>   remote, fetch, pull, push, clone, init, `openOnGitHub` non esistono più. La palette con "git" non trova niente.
> - **Restano:** i segni delle righe cambiate nel margine e i colori dei file modificati nell'albero.

**Da decidere:** se la vista diff di SideX resta disponibile in sola lettura (confronto di un file con un
checkpoint), o se tutto passa dal pannello storico.
