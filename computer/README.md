# SynthOrg

Workspace desktop per conversazioni AI, configurazione dei modelli e memoria persistente.

## Avvio

Per **usare** l'applicazione non serve installare niente: il runtime Node viaggia dentro il pacchetto. Su Windows avvia `start.bat` oppure `npm start`.

Per **svilupparla** servono Node.js 24 o superiore e Rust 1.91 o superiore. Dopo `npm ci`, eseguire `npm run setup:code` una volta per preparare le dipendenze dell'editor.

La shell desktop è [Tauri 2](https://tauri.app): apre la finestra nativa e avvia il servizio SQL su loopback come processo figlio, usando il **Node impacchettato** e non quello eventualmente installato sulla macchina. La porta la sceglie il sistema fra quelle libere, quindi nessuna porta occupata può impedire l'avvio. Una sola istanza per volta; la seconda porta in primo piano quella già aperta.
Non servono pacchetti aggiuntivi per SQLite: viene usato [`node:sqlite`](https://nodejs.org/api/sqlite.html).

| Comando | Effetto |
| --- | --- |
| `npm start` / `npm run dev` | finestra Tauri in sviluppo, con l'archivio collegato |
| `npm run build` | pacchetti nativi (NSIS, dmg, deb, AppImage) in `src-tauri/target/*/release/bundle` |
| `npm run server` | solo il servizio SQL, senza finestra |
| `npm run fetch-node` | scarica il runtime Node da impacchettare per la piattaforma corrente |
| `npm run setup:code` | installa le dipendenze SideX e scarica le estensioni integrate con checksum verificato |
| `npm run build:code` | compila l'editor e prepara gli asset in `resources/` |
| `npm test` | suite Node, senza rete e senza chiamate ai modelli |

## Shell desktop (Tauri)

### Struttura

```
src-tauri/
  Cargo.toml          dipendenze Rust (tauri, window-state, single-instance)
  tauri.conf.json     finestra, CSP, bundle, risorse
  build.rs            tauri-build
  src/main.rs         finestra, sidecar Node, token di sessione
  capabilities/       permessi concessi al webview
  icons/              icone generate da `npx tauri icon`
  runtime/            node_modules di produzione, preparato dal build (ignorato da git)
```

La shell HTML/JS viene servita direttamente da `resources/`. L'editor della sezione Code viene compilato da `vendor/sidex` e copiato nello stesso percorso da `build:code`, eseguito anche prima di avvio e packaging.

### Editor Code

SideX è integrato come libreria Rust nello stesso runtime Tauri. La sezione Code usa un webview figlio nella finestra principale: cambiare sezione conserva editor e terminali, mentre aprire una cartella ricarica solo il workbench. I servizi dell'editor partono al primo accesso a Code.

Restano file, ricerca, Git, terminale, task, debugger, estensioni e completamento tradizionale. Chat, server agentico Go, orchestrazione e relativo completamento AI sono esclusi dall'entry point integrato. Tema, colori e stile seguono SynthOrg; le impostazioni funzionali restano disponibili nell'IDE. Il profilo dell'editor è separato sotto `SynthOrg/Code` e non importa dati da installazioni SideX.

Il riferimento upstream, le modifiche e i limiti di compatibilità delle estensioni sono in [vendor/sidex/SYNTHORG.md](vendor/sidex/SYNTHORG.md). Questa integrazione è verificata su Windows; packaging e funzionamento sulle altre piattaforme richiedono ancora verifica. Su Windows un job object termina anche i processi discendenti dell'editor quando l'app esce forzatamente.

### Ciclo di vita

`main.rs` genera un token casuale di 32 byte a ogni avvio, avvia `node server/index.js` come processo figlio passandogli `SYNTHORG_TOKEN` e `SYNTHORG_PORT`, e lo termina all'uscita (`RunEvent::Exit`). Il webview ottiene lo stesso token chiamando il comando `session_info`: **il token non passa mai dal disco**.

La porta non è fissa: il servizio si mette in ascolto su una porta libera scelta dal sistema e la comunica alla shell su stdout (`SYNTHORG_PORT=<n>`), che la passa al webview con `session_info`. Il webview riprova finché non la riceve, perché le prime chiamate possono precedere l'avvio del servizio.

Per questo gli URL degli artefatti sono salvati **senza origine** (`/api/conversations/...`) e risolti a video contro l'origine della sessione corrente; i link salvati dalle versioni che incidevano `127.0.0.1:4319` vengono riscritti allo stesso modo, così i media delle conversazioni vecchie continuano ad aprirsi.

### Nessun processo sopravvive all'app

Il servizio non può restare orfano. Alla chiusura normale la shell lo termina (`RunEvent::Exit`), ma la garanzia vera non dipende da quello: il figlio nasce con lo **stdin collegato a una pipe** che la shell tiene aperta per tutta la sua vita e non usa per altro. Se la shell sparisce — finestra chiusa, Alt+F4, terminata dal task manager, crash — il sistema chiude la pipe, il figlio riceve EOF e chiude l'archivio.

Verificato uccidendo la shell con `Stop-Process -Force`, il caso peggiore in cui nessun gestore di chiusura viene eseguito: il servizio muore comunque.

La radice da cui viene risolto `server/index.js` cambia fra sviluppo e pacchetto: in debug ha precedenza il checkout (`CARGO_MANIFEST_DIR/..`), perché il build copia `server/` dentro `target/` e usare quella copia farebbe girare codice vecchio creando un secondo `data/`. In release si usa la resource directory del bundle.

La finestra nasce nascosta e viene mostrata dal frontend a interfaccia dipinta; se il JavaScript fallisce prima, un timer in Rust la mostra comunque dopo 5 secondi, così un errore non lascia l'app senza finestra.

Una sola istanza per volta: la seconda esecuzione porta in primo piano la finestra esistente ed esce.

### Finestra

La finestra è senza decorazioni e la barra del titolo è HTML, ma ogni operazione sulla geometria passa dall'OS: `maximize()` rispetta la work area e il DPI del monitor corrente, `startDragging()` usa `WM_NCLBUTTONDOWN`/`HTCAPTION`, quindi Aero Snap, snap layouts, Win+frecce e il ridimensionamento dai bordi funzionano nativamente. Nessuna geometria viene calcolata in JavaScript. `tauri-plugin-window-state` ricorda posizione e dimensioni fra un avvio e l'altro.

### Permessi e CSP

`capabilities/default.json` concede le operazioni sulla finestra, `window-state`, i dialoghi nativi e l'apertura di collegamenti. Le operazioni IDE su file, terminali, Git ed estensioni passano dai comandi Rust integrati; il servizio SQL resta autenticato con token di sessione.

La CSP in `tauri.conf.json` blocca `object-src`, limita i frame a origine locale e blob, e consente worker/blob e WebAssembly usati dall'editor. Font e stili esterni restano limitati a Google Fonts; le risorse locali passano dal protocollo asset con scope home/temp. `script-src` mantiene `'unsafe-inline'` per i gestori della shell. La modifica automatica Tauri di `script-src` e `style-src` è disabilitata per conservare questa policy esplicita: gli hash degli HTML delle estensioni e i nonce interferirebbero con i gestori della shell e gli stili generati dall'editor. Il contenuto non fidato è trattato nella sezione dedicata.

### Runtime Node impacchettato

`scripts/fetch-node.js` scarica il runtime ufficiale per la piattaforma corrente e lo scrive in `src-tauri/binaries/node-<target-triple>`, il nome che Tauri si aspetta da un `externalBin`. Tauri lo colloca accanto all'eseguibile togliendo il triple, e la shell lo risolve in quest'ordine: il binario accanto all'eseguibile, poi quello del checkout, e solo come ultima risorsa `node` dal PATH.

Lo scaricamento avviene da solo: `beforeDevCommand` per `npm start`, `beforeBuildCommand` per `npm run build`. Ogni piattaforma scarica il proprio, non esiste cross-download; il file è escluso dal versionamento.

Costo: il binario pesa circa 87 MB non compresso e porta l'installer Windows da ~5 MB a circa 40 MB. È il prezzo per non chiedere niente all'utente.

### Risorse nel bundle

`bundle.resources` usa la forma mappata (`"../server": "server"`) e non la lista: con i percorsi relativi Tauri depositerebbe i file sotto `_up_/`, dove il resolver Rust non li cerca.

`npm run build` esegue prima `npm run stage`, che copia in `src-tauri/runtime/node_modules` la sola chiusura di produzione letta da `package-lock.json`. Senza, il bundle si porterebbe dietro anche la CLI di Tauri e il resto delle devDependencies.

Su Windows l'installer NSIS è configurato `currentUser`: l'app finisce in `%LOCALAPPDATA%`, dove può scrivere il proprio `data/`. In `Program Files` non potrebbe.

### Compilazione multipiattaforma

Non esiste cross-compilazione praticabile: ogni sistema si compila sul proprio host. Da Windows non si producono build macOS (servono SDK Xcode e firma) e Linux richiede WebKitGTK.

`.github/workflows/build.yml` esegue la matrice completa: Windows x86_64, macOS aarch64 (`macos-latest`) e x86_64 (`macos-13`), Linux x86_64 (`ubuntu-24.04`). In locale `npm run build` produce solo i pacchetti dell'OS su cui gira.

Note per gli altri sistemi:

- Il webview su Linux è WebKitGTK, non Chromium: il CSS va provato davvero lì, è il punto dove ci si aspettano differenze.
- `ubuntu-24.04` alza il minimo a glibc 2.39 per `.deb` e AppImage.
- Su macOS il bundle `.app` non è scrivibile, quindi `data/` accanto al binario non va bene: va spostato in `~/Library/Application Support` prima di considerare macOS supportato.
- Le build non sono firmate: SmartScreen su Windows e Gatekeeper su macOS avviseranno.

## Chat e memoria

- Crea, cerca (titoli e messaggi), rinomina, archivia, ripristina o elimina chat dalla sidebar.
- La cronologia precedente viene importata una sola volta per contenuto; il dato originale nel browser resta conservato. L'importazione può leggere solo la cronologia dell'origine corrente: apri la finestra/origine precedente per recuperare dati salvati su un'altra porta. La GUI di sviluppo ha un'origine distinta.
- Puoi cambiare chat mentre arriva una risposta. È consentita una sola generazione alla volta; la risposta continua nella chat di origine. Le bozze sono separate per chat durante la sessione.
- **Memorizza** apre una nota modificabile. Le note possono essere limitate alla chat oppure globali; sono salvate solo su azione dell'utente.
- La memoria usa ricerca lessicale [SQLite FTS5](https://www.sqlite.org/fts5.html), non ricerca semantica o estrazione automatica. Le note marcate **Includi sempre** hanno precedenza; seguono quelle pertinenti alle parole della richiesta. Massimo 8 note / 6.000 caratteri per risposta, priorità alle note fisse più recenti.
- **Usa memoria** abilita/disabilita il recupero per la chat. Disattivare o eliminare una nota la esclude dalle richieste future. Le copie già inviate, visibili sotto le risposte, restano nel registro della conversazione.
- Eliminare una chat elimina i suoi messaggi e le sue memorie locali. Le memorie globali sopravvivono, senza il collegamento al messaggio eliminato. Svuotare una chat conserva le memorie.
- Senza API key la risposta è esplicitamente dimostrativa e non entra nel contesto delle richieste reali.

## Dati e contesto

Il database è `data/synthorg.sqlite`, con file WAL/SHM durante l'uso. È escluso dal versionamento.
Per una copia manuale coerente arresta il processo `node server/index.js` prima di copiare l'intera cartella `data`; non copiare solo il file principale mentre il servizio sta scrivendo.

Le tabelle `conversations`, `messages`, `memories` e `imports` hanno migrazioni versionate, chiavi esterne e scritture transazionali. Il servizio espone operazioni specifiche e query parametrizzate, senza un endpoint SQL arbitrario.

## Sicurezza del servizio locale

- Il servizio ascolta solo su loopback e verifica `Host` e `Origin` (origini ammesse: quelle del webview Tauri).
- Ogni chiamata `/api/*` richiede un **token di sessione**: la shell lo genera a ogni avvio, lo passa all'archivio via variabile d'ambiente e al webview via IPC. Non viene mai scritto su disco, non è indovinabile e non sopravvive alla chiusura dell'app. Fanno eccezione `/api/health` (sonda di liveness) e il download degli artefatti sandbox, che servono file già leggibili dal filesystem e cifrati a riposo quando il vault è bloccato.
- La master password del vault (AES-256-GCM, scrypt) deve essere di almeno 12 caratteri. Dopo 5 tentativi errati di sblocco la finestra di attesa raddoppia a ogni errore fino a 5 minuti, per impedire che l'endpoint diventi un oracolo di tentativi contro i file `.enc` presenti su disco.
- Dopo lo sblocco resta in memoria **la chiave derivata**, non la password: un dump di processo non restituisce una passphrase che l'utente potrebbe riutilizzare altrove.

## Contenuto non fidato

Il corpo dei messaggi è costruito da output dei modelli, da pagine scaricate dal tool di navigazione e da nomi di file creati dentro la sandbox, e finisce in `innerHTML`.

- Il renderer applica l'escape **anche all'apice singolo**: senza, un valore poteva chiudere la stringa JavaScript di un attributo `onclick` e diventare codice. L'escape HTML da solo non basta in quel contesto, perché le entità vengono decodificate prima che il JavaScript venga letto.
- Nessun dato non fidato viaggia più dentro un gestore inline: lightbox, file card, copia codice e copia markdown passano da attributi `data-*` letti da listener delegati.
- Gli URL passano da una **allowlist di schemi** (`http`, `https`, `blob`, `data:` solo per immagini/audio/video). `javascript:`, `vbscript:` e `data:text/html` diventano `#`.
- `resources/js/sanitize.js` è il secondo strato: riparsa il markup prodotto dentro un `<template>` inerte e conserva solo tag e attributi in allowlist, eliminando ogni `on*` e ogni `style`.
- Gli identificatori dei modelli, che arrivano da un servizio esterno, sono ridotti ai caratteri leciti prima di finire in un attributo.

## Sandbox dei container

Ogni chat ha il proprio container, creato dall'host: il codice eseguito non ha modo di parlare con il motore (nessun socket Docker/Podman montato) e quindi non può creare volumi propri né modificare i mount.

- L'immagine richiesta è validata come riferimento OCI prima di diventare un argomento di `run`. Senza, un valore come `-v/:/host` veniva interpretato come flag e non come nome immagine.
- Il container parte con `--cap-drop=ALL` e riceve solo le capability che servono a un gestore di pacchetti (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETGID`, `SETUID`, `KILL`). Restano fuori, fra le altre, `MKNOD`, `SYS_CHROOT`, `NET_RAW`, `SETFCAP` e `SETPCAP`. Restano attivi `no-new-privileges`, limiti di memoria, CPU e PID, e la rete disattivata salvo richiesta esplicita.
- Sono montati soltanto il workspace della chat, la cartella cache degli artefatti e lo store condiviso delle librerie; nient'altro dell'host è visibile. La pubblicazione di un artefatto risolve i percorsi con `realpath`: un link simbolico piantato nel workspace non può più far uscire dall'host un file esterno.

## Pacchetti e preinstallazione

I pacchetti attivi non vengono installati in ogni container: vivono in uno **store condiviso** montato in tutti.

```
data/packages/cache              artefatti scaricati (.whl / .tgz) -> /root/.cache
data/packages/lib/<immagine>/    store condiviso delle librerie
  python/                        -> /opt/synthorg/python   (PYTHONPATH)
  node/                          -> /opt/synthorg/node     (NODE_PATH)
```

Un container nuovo nasce con lo store già montato e già sui percorsi di ricerca: se il pacchetto è nello store è importabile **subito, senza installare nulla**. È questa la differenza rispetto al recuperarlo a mano dalla cache.

Lo store è **indicizzato per immagine**. I wheel compilati sono legati a una libc e a una versione di Python, entrambe decise dall'immagine: far condividere una directory a un container Alpine (musl) e a uno Debian (glibc) significherebbe dare a ciascuno binari che non può caricare. Le chat sulla stessa immagine condividono, un'immagine diversa ha il suo store.

### Cosa succede alla creazione di un container

1. Si confronta l'elenco dei pacchetti attivi con il contenuto dello store, **sul lato host**: nessun comando nel container.
2. Se non manca nulla lo stato passa subito a `done` e il container non fa alcun lavoro.
3. Se manca qualcosa, e solo per ciò che manca, si installa **nello store** (`pip install --target /opt/synthorg/python`, `npm install --prefix /opt/synthorg/node`), prima dalla cartella cache con l'indice disattivato e, se l'artefatto non c'è, scaricandolo prima lì (`pip download --dest`, `npm pack --pack-destination`).
4. Le scritture nello store sono serializzate per chiave immagine: due chat non riempiono la stessa directory in parallelo.

L'operazione gira in background — un'immagine senza runtime richiede un `apk add` che dura minuti — e non blocca il comando che ha creato il container. Stato e log sono in `GET /api/conversations/:id/sandbox` e nel popover Ambiente.

Il pacchetto attivo viene anche dichiarato al modello nella sezione `[PACCHETTI AMBIENTE PRE-INSTALLATI]` del system prompt, così non prova a reinstallarlo.

### L'interprete viene dall'immagine

Lo store porta le **librerie**, non il runtime. Con l'immagine predefinita `alpine:latest` non ci sono né `python3` né `node`, quindi il primo container deve installarli con `apk add` prima di poter usare lo store. Per un uso prevalentemente Python conviene impostare l'immagine della chat su `python:3.12-alpine`, e allora un container nuovo è operativo immediatamente.

### Elenco dinamico

L'elenco cresce da solo: ogni artefatto che finisce in `data/packages/cache` viene riconosciuto dallo scan e aggiunto al manifest, sia che ce l'abbia messo la preinstallazione sia che ce l'abbia messo il modello. Lo scan è rieseguito dopo ogni preinstallazione e, con un debounce, dopo ogni comando eseguito nella sandbox.

La cache si gestisce dall'esterno: le route sono `GET /packages`, `POST /packages/scan` e `PATCH /packages/:name`, non c'è una rimozione. «Ripristina ambiente» ricrea il **container** e non tocca né la cartella cache né lo store; per togliere un pacchetto si cancella il suo artefatto da `data/packages/cache` e la sua directory dallo store, e alla creazione successiva verrà riscaricato.

## Verifica

`npm test` verifica isolamento delle conversazioni, memoria e ricerca, importazione idempotente/atomica, persistenza, recupero dopo interruzioni, API locali, autenticazione di sessione, limiti sulla master password, confini del workspace della sandbox, validazione dell'immagine container, costruzione degli script di preinstallazione e sanitizzazione del contenuto renderizzato. Non effettua chiamate ai modelli, non avvia container e non fa richieste di rete reali: le prove che richiedono un motore container si eseguono a mano.

## Licenza

SynthOrg è software proprietario. Copyright (c) 2026 SynthOrg, tutti i diritti riservati: l'uso è consentito solo nei termini di un accordo di licenza commerciale scritto. Vedi [LICENSE](LICENSE).

I componenti di terze parti restano soggetti alle rispettive licenze, elencate nella sezione 4 del file LICENSE: Font Awesome Free 6.5.2, Tauri e le dipendenze Rust, le dipendenze npm, i caratteri Inter / JetBrains Mono / Outfit, e l'icona applicazione di [Freepik](https://www.freepik.com) via [Flaticon](https://www.flaticon.com).
