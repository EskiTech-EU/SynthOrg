# Studio › Foto: progetti, photocraft nella scheda e le funzioni nostre

Codice: `scripts/build-photocraft.js` + `photocraft-patches/` (la build web di photocraft: `synthorg.rs` è il guscio verso la pagina, `synthorg_ui.rs` le funzioni nostre dentro l’editor), `server/photocraft.js` (quale build c’è, controllo delle release), `server/photo.js` (progetto, scritture, strumenti del modello, blocco `[FOTO]`, lavori), `server/photo-ml.js` (pod, modelli dal canale inerte, rimozione dello sfondo), `server/photo/rembg/` (il programma Rust), `server/photo-commands.json` (bigino), `resources/js/photo.js` (la scheda), `resources/js/studio.js` (le schede Testi/Foto), agganci in `chat.js` e `code-permissions.js`. Prove: `tests/photo.test.js`.

## Cos’è

Foto è la seconda scheda di **Studio** (Testi, Foto), con l’interruttore di Studio. La scheda mostra l’elenco dei **progetti di foto** (come Testi e Code); aperto un progetto mostra **photocraft dentro la pagina**, coi colori di SynthOrg: nessuna finestra a parte. Accanto alle schede, a progetto aperto: «Progetti», il nome, «Apri dalla cartella» (un file come documento), «Inserisci come livello» (un file nel documento aperto), stato dei lavori, impostazioni, chat.

Un progetto (`projects.section = 'photo'`, locale, stesso git che registra, stesse chat) nasce da «Nuovo progetto»: **vuoto** a una dimensione (predefinite o personalizzata, sfondo bianco/trasparente/nero) oppure **da un’immagine** di questo computer (copiata nella cartella; la tela è la sua, o un’altra dimensione su cui l’immagine viene inserita), più nome e cartella. Il manifesto `foto.json` tiene `document` (`<nome>.pcraft`) e `setup` {base, width, height, background}. La tela la costruisce la pagina nell’editor alla prima apertura (`prepareDocument` in `photo.js`) e la salva come documento del progetto; dalle volte dopo, aprire il progetto apre quel documento. Tornando ai progetti i documenti con modifiche non salvate vengono nominati e si chiede conferma.

Ordine alla creazione: `createProject` → `openProject` (è lì che parte il registro git) → `photoInit`. La dimensione è controllata prima di copiare la base: una richiesta rifiutata non lascia niente nella cartella.

## photocraft nella pagina

- **Build web nostra**: `scripts/build-photocraft.js` prende l’ultima release (`SYNTHORG_PHOTOCRAFT_TAG` la fissa), clona in `photocraft-src/`, applica `CHANGES` (sostituzioni di testo) e `COPIES`, compila `-p photocraft-web --target wasm32-unknown-unknown --profile wasm-release`, passa `wasm-bindgen` (versione dal `Cargo.lock`, sha256 controllato). Se una sostituzione non applica su una release nuova la build fallisce con messaggio. Output in `resources/photocraft/` con `build.json`. Misurato: v0.3.0, wasm 27,5 MB, 275 s da zero, ~190 s dopo una modifica nostra.
- **Nella scheda**: `iframe#photo-frame` su `photocraft/index.html` (stessa origine). Il guscio espone `window.synthorgPhotocraft = { control(metodo, parametriJson) → Promise, look(json), put(percorso, byte) }` e chiama `window.synthorgHost.write(percorso, byte)` / `.command(id, parametriJson)` / `.ready()` / `.failed()`.
- **Colori**: `look()` mappa i token CSS risolti sui `Tokens` di photocraft; il guscio li sovrappone a ogni frame. Cambio tema a caldo.
- **File**: aprire = la pagina legge i byte (`GET /api/photo/:id/file`, `no-store`: i file cambiano sotto lo stesso nome), `put`, poi `app.open`. File › Save e `photo_save` arrivano a `synthorgHost.write` → `POST /api/photo/:id/write` → file nella cartella + passo git. Le scritture sotto `.synthorg/` non si registrano.

## Le funzioni nostre dentro l’editor (`photocraft-patches/synthorg_ui.rs`)

Sono comandi della shell di photocraft (`crates/ui-egui/src/synthorg.rs` nella build), agganciati a `menus.rs` con quattro sostituzioni: voci in `UI_COMMANDS`, posizione in `PLACE_AFTER`, esecuzione in `invoke_unguarded`, abilitazione in `is_enabled`. Le etichette sono in inglese come il resto di photocraft.

- **Nei menu**: `Layer › Remove Background` (dopo Mask All Objects), `Select › Subject (Model)` (dopo Subject) e `Select › Object (Model)` (dopo quello). Il comando passa la richiesta alla pagina (`set_host` → `synthorgHost.command`), che la esegue (`removeBackgroundInDocument` in `photo.js`).
- **Per la pagina**, quello che la build web non ha perché upstream lo scrive contro il file system: `synthorg.layerImage {layer?|"merged", path}` (un livello da solo sulla tela, senza la sua maschera, o tutto il documento, come PNG dato alla pagina; risponde anche coi bordi della selezione), `synthorg.matte {path, layer?, output: mask|selection, offset, constrain}` (l’alfa di un’immagine diventa maschera del livello o selezione, **un solo passo di storico** «Remove Background»/«Select Subject»; il livello Background diventa prima un livello normale), `synthorg.place {path, center?, scale?, fit?}` (un’immagine come smart object, via `place_bytes` del motore), `synthorg.status {text, error}` (barra di stato dell’editor).
- **Il vincolo**: se il documento ha una selezione (o un tracciato della penna, che viene convertito con `path.toSelection`), la pagina mostra al modello solo quella parte più un margine del 6% e `synthorg.matte` moltiplica il risultato per la selezione: resta dentro. Così si dice «solo questo» quando i soggetti sono più d’uno.
- **Flusso**: `layerImage` → (ritaglio) → `.synthorg/rembg-in.png` → lavoro nel pod con `scratch: true` (risultato in `.synthorg/rembg-out.png`, niente nella cartella né nel registro) → `put` → `matte`. Misurato dal menu alla maschera: 5,7 s a 1 MP, 6,7 s a 12 MP (3,3 s il modello nel pod); in una prova fatta subito dopo una build, con la macchina occupata, le prime chiamate hanno preso 36–49 s.
- I comandi del motore su file (`layer.exportAs`, `file.placeEmbedded`) nella build web rispondono «not available on the web»: per questo esistono i nostri. Ogni comando accetta `"coalesce": chiave` per fondere più passi nello storico (non usato: i nostri fanno già un passo solo).

## Strumenti del modello (`server/photo.js`, cancello di `code-permissions.js`)

Il server decide (permesso, il file esiste, si può sovrascrivere) e, per ciò che agisce sull’editor, risponde con un’istruzione per la pagina `{ page: { op, … } }` che `chat.js` esegue con `window.photo.perform`. `photo_list`; `photo_commands {filter}`; `photo_inspect`; `photo_open`; `photo_select_object` (vedi sotto); `photo_place {path, center?, scale?, fit?}` (un file della cartella come livello: soggetto scontornato dentro un ambiente); `photo_run`, `photo_batch` (≤ 64); `photo_remove_background` (senza `path`: sul documento aperto, `layer?`, `output: mask|selection`, chiave `modifica:photocraft`; con `path`: su un file, scrive `<nome>.senza-sfondo.png`); `photo_save {path, overwrite?}` (`overwrite` chiede sempre, anche per il documento del progetto); `photo_screenshot` (il documento composto, da `layerImage merged`). Modo di default `photo_perm` = auto. Il blocco `[FOTO]` porta progetto, come comporre (translate, transform, moveTo), bigino e fino a 60 file; la pagina aggiunge documento aperto, selezione e livelli con id (`window.photo.describe()`). Il prompt dice di chiedere all’utente quando non si capisce su quale livello o file lavorare.

## Le funzioni nostre nel pod (`server/photo-ml.js`)

- Programma: `synthorg-rembg` (Rust, `tract-onnx` + `image`), compilato statico in un container Alpine da `scripts/build-rembg.js` (`apk add rust cargo build-base`, volume `synthorg-cache-cargo`, `--target x86_64-alpine-linux-musl` con `+crt-static` solo sul target). Misurato: **443 s**, binario **20 MB**, in `photo-tools-bin/` con stamp dei sorgenti.
- Immagine `localhost/synthorg-photo-tools:<base>-<stamp>` = base Alpine + il programma. Modelli (release rembg v0.0.0, Apache-2, sha256 fissati in `MODELS`): `u2net.onnx` 176 MB, `u2netp.onnx` 4,6 MB. Li scarica il **canale inerte** (container con rete, volume `synthorg-cache-photo-models` in scrittura, `sha256sum -c`, nessuna foto dentro) su clic dell'utente. La funzione gira in un container **senza rete**, volume in sola lettura, foto dentro via `podman cp -`, PNG fuori via `copyOutOfContainer`, `capAdd: []`, 3 GB, 2 CPU.
- Misure (2026-10-06, x86_64, 2 CPU, dentro il container; «wall» = con avvio e rimozione del container):

| Modello | Immagine | Totale | Inferenza | RSS di picco | wall |
|---|---|---|---|---|---|
| u2netp | 1 MP | 1,6 s | 1,4 s | 207 MB | 4 s |
| u2netp | 12 MP | 2,8 s | 1,8 s | 250 MB | 5 s |
| u2netp | 24 MP | 2,9 s | 1,4 s | 296 MB | 4 s |
| u2net | 1 MP | 3,2 s | 2,3 s | 377 MB | 4 s |
| u2net | 12 MP | 3,1 s | 2,1 s | 420 MB | 4 s |
| u2net | 24 MP | 3,6 s | 2,1 s | 467 MB | 5 s |

Scaldare la cache (download dei due modelli) 22 s. Default `u2net`, scelta nelle impostazioni della cartella.

## Modelli per lo scontorno (2026-10-07)

Nessun modello è distribuito con SynthOrg: li scarica l’utente (come i GGUF), dal canale inerte, con sha256 fissato in `MODELS` di `server/photo-ml.js`; la pagina mostra la licenza dichiarata dagli autori. Come per i GGUF, quello che il file del modello dice di sé si legge dal file (regola di Samu, 2026-10-07): il programma prende dal modello il lato dell’ingresso e capisce dall’uscita se sono logit (valori fuori da 0..1 → sigmoid); `synthorg-rembg --describe --model m.onnx` stampa ingressi e uscite dichiarati. In `MODELS` resta solo ciò che nessun file dice: `mean` e `std` (i metadati dei sei file provati sono vuoti: ImageNet per tutti tranne IS-Net, 0,5 e 1), `size` per l’unico con ingresso di qualunque misura (BRIA: per questo tract non lo caricava), licenza e memoria del container. Un lavoro usa tutti i processori del motore e la memoria che il modello chiede, fin dove la macchina ne ha (`engineCapacity`).

**Motore: ONNX Runtime** (deciso da Samu il 2026-10-07: «possiamo mettere tutti i runtime che servono»), al posto di tract. `synthorg-rembg` (Rust, crate `ort` con `load-dynamic`) carica `/usr/lib/libonnxruntime.so.1` del pacchetto Alpine `onnxruntime` 1.23.0 (33 MiB installato, circa 50 MB con le dipendenze), che l’immagine del pod installa dalla rete di build (canale inerte; `IMAGE_RECIPE = 2`). Il binario non è più statico (un binario statico musl non può caricare librerie): 1,6 MB invece di 20, compilazione 80 s invece di 499. Ottimizzazione del grafo al livello base: coi livelli estesi ONNX Runtime 1.23 rifiuta BiRefNet («Cannot parse data from external tensors»).

Misure su un ritratto 1058×1252 (dipinto di pubblico dominio), runtime WSL con 4 processori e 8 GB (container a 6,9 GB):

| Modello | Lato | File | ONNX Runtime | prima, tract | RSS di picco | Esito sul ritratto |
|---|---|---|---|---|---|---|
| U²-Net | 320 | 168 MB | 0,7 s | 2,8 s | 0,4 GB | prende testa e velo, perde il busto |
| IS-Net | 1024 | 170 MB | 1,4 s | 7,0 s | 0,8 GB | sbaglia soggetto |
| BiRefNet leggero | 1024 | 214 MB | 9,6 s | 55 s | 6,5 GB | figura intera, resta un pezzo di sfondo |
| BRIA RMBG 2.0 | 1024 | 977 MB | 20,8 s | non caricava | 6,9 GB | figura intera, resta un pezzo di sfondo |
| BiRefNet | 1024 | 928 MB | 22,6 s | 97 s | 6,9 GB | figura intera, pulita |

I tre grandi prendono tutta la memoria che il container ha: su una macchina con meno di 7–8 GB potrebbero non girare (non provato; con l’arena di ONNX Runtime spenta, misurato in Python: 5,3 GB e +40% di tempo). Predefinito ancora `u2net`: lo sceglie Samu. Un’immagine sola non basta per giudicare la qualità: servono foto vere.

## Scheda ONNX nei modelli locali (2026-10-07)

Impostazioni › Modelli locali › **ONNX (foto)** (`resources/js/local-onnx.js`, agganciato a `local-models.js` con una scheda in più). Cerca su Hugging Face col filtro `onnx` e il compito `image-segmentation` (`HuggingFaceHub.searchOnnx`), mostra i file `.onnx` di un repository (`repoOnnx`: dimensione, sha256 dell’LFS, e se i pesi stanno in un file a parte, che non è utilizzabile), scarica.

- **Download**: `PhotoManager.addUserModel` → canale inerte (stesso `warmModels`), file nel volume dei modelli col nome `hf--<autore>--<repo>--<percorso>.onnx`, verificato con lo sha256 che dà il Hub, alla revisione del repository. Poi `describeModel` (`synthorg-rembg --describe` nel pod senza rete) legge ingressi e uscite dal file: è utilizzabile se ha **un solo ingresso [lotto, 3, alto, largo]**; altrimenti resta in elenco come non utilizzabile, col motivo.
- **Registro**: impostazione `photo_onnx_models` (chiave `hf:<repo>/<percorso>` → file, url, sha256, etichetta, licenza, ingressi, `mean`, `std`, `size` solo se l’ingresso è di qualunque misura). `catalogue()` = elenco di SynthOrg + i modelli dell’utente pronti: è quello che vedono le impostazioni delle foto di ogni progetto.
- **Parametri dell’utente**: media e deviazione (partono da ImageNet), lato solo dove il file non lo dichiara.
- Provato: `briaai/RMBG-1.4` `onnx/model.onnx` (168 MB) scaricato in 28 s, pronto, usato su un progetto in 4,1 s con media 0,5 e deviazione 1. Un repository ad accesso su richiesta non si scarica (il container non porta la chiave di Hugging Face).
- Rotte: `GET /api/photo/onnx`, `GET …/onnx/search?q&sort&cursor`, `GET …/onnx/repo?id`, `POST …/onnx/add {repo, path}`, `PATCH …/onnx/model {key, mean?, std?, size?}`, `DELETE …/onnx/model?key`.

## Oggetto indicato: Segment Anything (2026-10-07)

`Select › Object (Model)` (attiva solo con una selezione) e lo strumento `photo_select_object {box?, output, layer?}`. Il modello è `samVitB` in `MODELS` (`use: 'object'`, due file: encoder 343 MB e decoder 16 MB, Apache-2.0), scaricato dalle impostazioni delle foto. Il programma (`--encoder --decoder --box`) dà all’encoder la foto col lato lungo a 1024 e al decoder i due angoli del riquadro (etichette 2 e 3); la maschera esce alla misura della foto. Nella pagina: i bordi della selezione (o il `box` del modello) sono il riquadro, la parte mostrata ha un margine del 25%, e il risultato **non** viene limitato alla selezione: la selezione indica, non taglia. Misurato: 5–6 s nel programma (3,7 GB), 12–14 s dal menu alla selezione. Sul dipinto di prova il risultato segue l’ovale disegnato dentro l’immagine: per giudicarlo servono foto vere.

## Rifinitura dei bordi (2026-10-07)

`synthorg.matte {refine: true, radius?}` passa la maschera per `photocraft_algo::matting::refine_mask` (filtro guidato con l’immagine piena come guida, raggio intelligente; raggio = lato/300 fra 2 e 24 px), prima di farne maschera o selezione, nello stesso passo di storico. È un interruttore del progetto (Impostazioni delle foto › Bordi, `settings.refine`), **spento di partenza**: sul dipinto di prova il bordo rifinito segue la trama della tela ed è più frastagliato di quello del modello (confronto in `bordi-confronto.png` nello scratchpad della sessione); su foto con capelli potrebbe andare diversamente, non provato. `decontaminate` e `defringe` di photocraft (alone del vecchio sfondo) non sono collegati.

## Immagini generate dalla chat (2026-10-07)

La chat di un progetto di foto ha **solo strumenti per le immagini**: i `photo_*` e, fra quelli generali, solo quelli che producono un’immagine (`text_to_image`, `image_to_image`, o altri con firma `-> image`); via ricerca web, terminale, computer use, video, audio e il resto, e via anche il loro testo dal prompt. Restano gli strumenti del piano e della memoria a livelli, se accesi. Un’immagine generata lì viene salvata nella cartella del progetto (passo git del modello) e inserita come nuovo livello del documento aperto (`window.photo.addGenerated`); senza documento aperto, viene aperta. Per `image_url` il modello passa «documento» (il documento aperto, composto) o un file della cartella (`window.photo.sourceImage`). Provato nell’editor con un’immagine fatta a mano; non provato con un modello vero che genera.

## Interruttore

Foto segue l’interruttore di Studio (`SECTION_SWITCH = { photo: 'studio' }` in `server/database.js`; `resources/js/sections.js` carica `studio.js` e `photo.js` insieme). Studio spenta: `/api/photo/status` risponde, tutto il resto 403.

## Rotte

`GET /api/photo/status` (sempre), `POST …/status/check`, `GET|DELETE /api/photo/models`, `POST …/models/warm`, `POST /api/photo/:id/init {base?, width?, height?, background?}`, `GET|PATCH …/:id`, `GET …/file?path=` (byte, prima del controllo del token, `no-store`), `POST …/write {path, content base64, source}`, `GET …/context`, `POST …/tools/:name`, `POST …/functions/remove-background {path, scratch}`, `GET …/job`.

## Trappole

- «Non finestra incastrata, come SideX locale» vuol dire **dentro la pagina**: la prima versione (eseguibile in finestra sua, sezione a parte) è stata rifiutata e rifatta. La seconda (editor subito, cartella scelta da un menu) è diventata progetti con «Nuovo progetto» su richiesta.
- `ui-egui` ha `photocraft-io` solo fra le dev-dependencies: nel nostro modulo import/export passano da `app.services.import/export`.
- La rotta dei file con `max-age` faceva rileggere al browser il risultato precedente di una funzione: ora `no-store`.
- I `app.save` di appoggio fanno comparire avvisi «Saved … with 1 warning» nell’editor: le catture usano `synthorg.layerImage`.
- Heredoc bash con `\\` o apostrofi si rompono: gli script di modifica vanno scritti in un file.
- Il flag `+crt-static` passato a `RUSTFLAGS` in Alpine rompe le proc-macro: solo sul target, con `CARGO_TARGET_<TRIPLE>_RUSTFLAGS`.
- Il runtime WSL monta `/mnt/synthorg-data` dal primo chiamante: con due istanze di SynthOrg e dati diversi la seconda non vede il suo `data/`.
- Edge headless parte in tema chiaro su dati nuovi: per provare lo scuro, `themeManager.setMode('dark')`.
- Nell’app installata la build sta nel bundle della pagina; accanto al servizio c’è solo `photocraft/build.json` (risorsa in `tauri.conf.json`).
- Da fare: tour e punti «?» (dopo Video); prova nell’app Tauri vera e su Linux (finora Edge headless, coi dialoghi di sistema simulati); misura a 24 MP del flusso sul documento aperto; photocraft è solo in inglese.
