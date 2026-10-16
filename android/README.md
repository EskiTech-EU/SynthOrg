# SynthOrg sul telefono

L'app Android di SynthOrg: la stessa interfaccia del computer (Assistente con MO', chat, impostazioni) e lo stesso archivio, tenuto intero sul telefono e gestito con le stesse regole. Il telefono è indipendente quanto il computer: quello che si fa sul telefono lo fa il telefono, subito, e i modelli li chiama lui con la chiave API inserita nelle sue Impostazioni. Collegare un computer, attraverso il ponte I2P, serve a due cose: tenere uguali i due archivi, in sottofondo, e raggiungere i progetti Code, che lavorano sul computer.

## Com'è fatta

| Parte | Dove | Cosa fa |
|---|---|---|
| Interfaccia | `../computer/resources`, copiata in `ui/` da `scripts/stage-ui.js` | Gli stessi file del computer; `remote.js` e `sync.js` la adattano al telefono. Font locali in `fonts/` |
| Archivio | `src-tauri/src/archive.rs`, `native/quickjs` | Gli stessi file di `../computer/server` (`database.js`, `personal.js`, `memory-tree.js`, `usage.js`, `replica.js`, `archive-api.js`), eseguiti così come sono in QuickJS sul SQLite dell'app |
| Router I2P | `native/i2pd` | i2pd 2.61.0 compilato con l'NDK r28c e collegato dentro l'app; solo SAM, sul loopback |
| Ponte | `bridge-client` | Lato telefono del protocollo (`../computer/docs/ponte-telefono.md`): SAM, Noise XK + ML-KEM-768, richieste ed eventi |
| App | `src-tauri` | Collegamento e scambio delle righe (`link.rs`), archivio all'indirizzo `http://synthorg.localhost` (`proxy.rs`), copie di quello che ha solo il computer (`store.rs`) |

## Accoppiamento

All'apertura l'app propone di collegare un computer, oppure di usarla senza: il collegamento si può fare anche dopo, dal pulsante in alto. Sul computer: Impostazioni, scheda Telefono, Collega un telefono. Il router I2P parte all'apertura dell'app, anche prima dell'accoppiamento: quando si inquadra il codice ha già trovato la rete. Il codice si inquadra con la fotocamera, oppure si copia dal computer (è scritto sotto il QR, con il pulsante Copia codice) e si incolla nell'app; il tasto Indietro torna indietro nell'app e dalla sezione Assistente la manda in sottofondo, senza chiuderla.

Un telefono usato da solo e poi accoppiato porta le sue cose: i due archivi diventano uno. Scollegato, tiene tutto e continua da solo.

## L'archivio è sul telefono

Ogni richiesta della pagina all'archivio (`/api/...`) è risposta dal telefono, dal suo archivio, con le regole del computer: una modifica è scritta e visibile in pochi millisecondi, con o senza collegamento. Le righe che ne escono partono per il computer subito dopo (una richiesta `sync`, che riporta anche quelle del computer); quello che il computer scrive arriva da solo. Regole dello scambio e dei conflitti: `../computer/docs/ponte-telefono.md` e `../computer/server/replica.js`.

Quello che ha solo il computer (container e file di una chat, progetti Code, costi dei modelli) viene chiesto al computer; di quelle letture il telefono tiene una copia, mostrata subito e controllata dopo con una sola richiesta (`snapshot`). Le chiavi API non viaggiano in nessuno dei due sensi.

L'app gira come servizio in primo piano, con la sua notifica: il collegamento resta aperto anche quando si passa a un'altra app, e si chiude quando si toglie SynthOrg dalle app recenti o si preme «Chiudi SynthOrg» nella notifica.

## Sulla stessa rete locale

Se sul computer è acceso «Collegamento diretto in rete locale» (spento alla partenza), quando telefono e computer sono sulla stessa rete il telefono apre un secondo canale direttamente verso il computer, con le stesse chiavi dell'accoppiamento: tutto passa da lì, molto più veloce, e I2P resta di riserva. La pillola in alto dice «rete locale» quando il collegamento passa da lì. L'indirizzo del computer viene tenuto, così la volta dopo sulla stessa rete lo si trova anche senza internet. Dettagli in `../computer/docs/ponte-telefono.md`.

## Direttamente su internet

Se sul computer è acceso «Collegamento diretto su internet» (spento alla partenza), fuori dalla rete locale il telefono prova ad aprire una strada diretta verso il computer: con IPv6 dove entrambi ce l'hanno, attraverso i router con IPv4 dove lo permettono. Nessun server nostro in mezzo; per conoscere il proprio indirizzo pubblico ogni lato interroga un server STUN pubblico. La pillola dice «diretto». Non tutte le reti lo permettono (reti mobili, due router in cascata senza IPv6): lì tutto resta su I2P. L'ordine è sempre: rete locale, diretto, I2P; se la rete locale compare mentre si è sul diretto, il telefono ci passa da solo.

## L'accoppiamento è legato al telefono

Le chiavi dell'accoppiamento sono tenute cifrate con una chiave del Keystore di Android (`Vault.kt`, `src-tauri/src/vault.rs`), che non esce dal telefono: i file dell'app copiati su un altro dispositivo contengono un accoppiamento che non si può aprire.

## Cosa resta del computer

Solo i progetti Code: i loro file e i loro container stanno sul computer. Con un computer accoppiato il telefono ha la zona Progetti, e in una chat di progetto il turno del Master gira sul computer (il messaggio è scritto subito sul telefono, la risposta arriva come righe). Passano dal computer, quando è raggiungibile, anche il container e i file di una chat e la ricerca sul web, che il telefono non ha.

Tutto il resto lo fa il telefono, con o senza computer: chat, assistente, agenda, diario, impostazioni, chiamate ai modelli, registro dei suoi consumi. La chiave API è del telefono: le chiavi non viaggiano tra i dispositivi.

Con un computer accoppiato ma non raggiungibile non cambia niente di quello che fa il telefono; le righe scritte partono, nell'ordine, appena il computer torna, e comunque ogni 30 secondi i due archivi vengono riallineati. Se la stessa cosa è stata modificata più di recente sull'altro lato, resta la più recente.

## Compilare

Da Windows, con Android Studio installato (JBR 21), SDK, NDK r28c (`28.2.13676358`) e i target Rust `aarch64-linux-android` e `x86_64-linux-android`:

```bash
npm install
```

```bash
JAVA_HOME="C:/Program Files/Android/Android Studio/jbr" ANDROID_HOME="$LOCALAPPDATA/Android/Sdk" NDK_HOME="$LOCALAPPDATA/Android/Sdk/ndk/28.2.13676358" npx tauri android build --target aarch64 --apk
```

L'NDK dev'essere lo stesso con cui è compilato i2pd (r28c): con l'r27 l'app si chiude all'avvio per un simbolo della libreria C++ che manca.

Le librerie di i2pd si rifanno in WSL con `native/i2pd/build.sh` (vedi `native/i2pd/README.md`).

## Misure (emulatore x86_64, rete I2P vera, 1 ottobre 2026)

| Cosa | Tempo |
|---|---|
| Modifica di un'impostazione sul telefono: attesa della pagina | 7–14 ms (prima: 1,1 s) |
| Voce di agenda nuova: attesa della pagina, già nell'elenco | 7–16 ms |
| Chat nuova con un messaggio | 36 ms |
| Messaggio in chat: visibile dopo l'invio | 95 ms |
| Elenco delle chat all'apertura dell'app, non ancora collegata | 4–60 ms |
| Modifica fatta sul telefono, presente sul computer | 0,3–0,9 s |
| Modifica fatta sul computer, presente sul telefono | 1,2 s |
| Risposta scritta dal computer in 12 salvataggi: completa sul telefono dopo l'ultimo | 0,3 s |
| Accoppiamento (router appena avviato / già avviato) | 97 s / 30 s |
| Prima copia dell'archivio dopo l'accoppiamento (7 chat, 151 messaggi dell'assistente) | entro 5 s |
| Ritorno della rete: modifiche fatte senza rete presenti sul computer | 37 s |

APK per arm64: 22,9 MB (1,2 MB in più con il motore dell'archivio).
