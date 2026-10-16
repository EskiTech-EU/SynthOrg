# Ponte col telefono

Collega un telefono a SynthOrg attraverso la rete I2P: nessuno dei due vede l'indirizzo dell'altro, e nessun server esterno vede chi parla con chi. Una richiesta su I2P impiega uno o due secondi qualunque sia il suo peso: per questo il telefono mostra ogni pagina subito dalla sua copia e chiede al computer tutto in una volta sola (vedi «Lo stato in una richiesta»). Sul telefono c'è la sezione Assistente, con in più i progetti: elenco, compiti ai Master, richieste di approvazione, esiti.

Questo documento descrive il lato desktop, che è fatto, e quello che l'app sul telefono deve fare per parlarci. Il riferimento eseguibile del lato telefono è `scripts/bridge-phone.js`.

## Come è fatto

| Parte | File | Cosa fa |
|---|---|---|
| Router | `server/bridge-router.js` | Avvia i2pd in un container suo, o usa un router esterno |
| Connessioni | `server/runtime/bridge-mux.c` | Dentro il container, porta tutte le connessioni al router su un solo canale |
| Senza finestra | `src-tauri/src/background.rs` | Il servizio: l'app che continua a finestra chiusa, icona nell'area di notifica, avvio con il computer |
| SAM | `server/bridge-sam.js` | Chiede al router destinazione, sessione e flussi |
| Canale | `server/bridge-noise.js` | Cifra e autentica dentro il flusso I2P |
| Ponte | `server/bridge.js` | Accoppiamento, telefoni, passaggio dei messaggi |
| Archivio | `server/bridge-store.js` | Impostazioni, chiavi, telefoni accoppiati |
| Pagina | `resources/js/bridge.js` | Esegue quello che il telefono chiede |
| Impostazioni | `resources/js/realtime-phone.js` | Scheda «Telefono» dell'assistente |
| QR | `resources/js/qr.js` | Disegna il codice di accoppiamento |

Il servizio locale trasporta soltanto. Le richieste del telefono le esegue la pagina, perché l'assistente, le chat e le chiamate ai modelli vivono lì.

### Collegamento e servizio

Il ponte ha due interruttori, indipendenti. Spenti entrambi non è in esecuzione niente.

| Interruttore | Quando tiene acceso il ponte |
|---|---|
| Collegamento | Mentre l'app è aperta |
| Servizio | Quando la finestra è chiusa |

- Il servizio è **spento di default** e si accende solo dal suo interruttore, nella scheda Telefono.
- **Con il servizio attivo chiudere la finestra non chiude SynthOrg**: la finestra viene nascosta e l'app continua, mai di nascosto. Ogni volta compare una notifica di Windows («SynthOrg è ancora attivo»), e nell'area di notifica resta un'icona con «Apri SynthOrg» e «Chiudi SynthOrg» (Windows 11 la mette tra le icone nascoste, dietro la freccia). Avviare di nuovo SynthOrg, anche con `start.bat`, riporta la finestra.
- **Con il servizio spento** chiudere la finestra chiude tutto.
- **Chiudere tutto** (finestra col servizio spento, «Chiudi SynthOrg», `synthorg.exe --quit`): la shell chiude il tubo verso il servizio locale, che ferma e aspetta il ponte e il suo router, i container di chat, progetti e computer use e i modelli locali, poi spegne la macchina WSL `synthorg-runtime` (il processo di pausa di podman rootless la terrebbe accesa per niente) ed esce; se entro 25 secondi non è uscito, la shell lo termina. Misurato con un container di chat acceso: tutto chiuso in 3,1 s, macchina WSL compresa, con il servizio acceso o spento.
- Per le prove senza interfaccia: `synthorg.exe --quit` chiude SynthOrg già aperto come «Chiudi SynthOrg» (senza SynthOrg aperto non avvia niente); `synthorg.exe --hide` fa quello che fa la chiusura della finestra.
- **Avvia con il computer** è un interruttore a sé: non dipende dal collegamento né dal servizio, e nient'altro lo accende o lo spegne. Acceso, scrive una voce di avvio per l'utente (`--background`: SynthOrg parte senza finestra, con l'icona nell'area di notifica); spento, la toglie. Su Windows è il valore `SynthOrg` in `HKCU\…\Run`, su Linux il file `~/.config/autostart/synthorg-background.desktop`.
- L'interruttore mostra **quello che c'è nel sistema**, non un'impostazione ricordata dall'app: la voce scritta compare sotto, e se l'utente l'ha disattivata dalle app di avvio di Windows viene detto e lasciata com'è. L'app non riscrive mai la voce da sola.
- Avviata con il computer, l'app accende il ponte solo se il servizio è attivo.
- **Solo servizio**: ad app aperta il ponte è spento. Per accoppiare un telefono viene acceso per la durata dell'accoppiamento e finché quel telefono resta collegato.
- A finestra nascosta la pagina resta caricata, perché è lì che gira l'assistente; le viene chiesto di tenere poca memoria.

### Il router

- **Incorporato**: pacchetto `i2pd` di Alpine, installato dal repository di Alpine in un'immagine fatta una volta (`localhost/synthorg-bridge-router`). Gira in un container senza capacità, senza cartelle del computer, con una rete separata dagli altri container. Le chiavi del router e i nodi che conosce stanno nel volume `synthorg-bridge-router`.
- **Nessuna porta pubblicata**: l'interfaccia SAM ascolta dentro il container. Accanto al router gira `synthorg-mux`, un nostro programma compilato dentro l'immagine, che porta tutte le connessioni a SAM sull'ingresso e l'uscita del container: un solo processo sul computer, qualunque sia il numero di connessioni. Con un processo `podman exec` per connessione ogni connessione costava circa 50 MB.
- **Si chiude con l'app**: il container parte in primo piano con l'ingresso tenuto dal servizio. Quando l'ingresso finisce (app chiusa, uccisa o caduta) `synthorg-mux` termina e il router viene fermato.
- **Niente nei log**: il container parte con `--log-driver=none`, perché sulla sua uscita passa il traffico con il router, chiavi comprese.
- **Esterno**: un router I2P già in esecuzione, all'indirizzo SAM indicato nelle impostazioni. SynthOrg non avvia e non chiude niente.

### Antivirus

SynthOrg non distribuisce e non scrive sul disco di Windows nessun programma I2P. Il router incorporato è un programma Linux che vive dentro il runtime dei container.

Il motivo: `i2pd.exe`, il router ufficiale per Windows, viene messo in quarantena da Microsoft Defender come `Trojan:Script/Wacatac.H!ml`. Il suffisso `!ml` indica un rilevamento del modello euristico, non la firma di un malware noto. i2pd è anche il componente che il malware I2PRAT (in circolazione da fine 2024) porta con sé per comunicare, e questo spiega l'attenzione degli antivirus verso quel programma.

Analisi di Microsoft Defender del 29 settembre 2026, senza eseguire i file:

| File | Esito |
|---|---|
| `i2pd_2.61.0_win64_mingw.zip` (ufficiale, non firmato) | Rilevato |
| Router Linux di Alpine, `i2pd` 2.60.0 | Nessuna minaccia |
| `synthorg-mux` | Nessuna minaccia |
| `synthorg.exe` e `synthorg-node.exe` (build di sviluppo) | Nessuna minaccia |
| `i2pinstall_2.13.0_windows.exe` da i2p.net (non firmato) | Nessuna minaccia |
| `I2P-Windows-Easy-Install-Bundle.exe` da i2p.net (firmato StormyCloud Inc) | Nessuna minaccia |
| `I2P-2.13.0.apk` da i2p.net | Nessuna minaccia |

Per chi usa il **router esterno** su Windows: il router Java di i2p.net passa l'analisi, i2pd per Windows no. La guida ufficiale di I2P avverte comunque che gli antivirus possono segnalare I2P per il suo comportamento di rete.

Senza runtime dei container resta solo il router esterno.

### L'indirizzo

Il computer ha una destinazione I2P stabile (Ed25519). Il suo leaseset è cifrato (`i2cp.leaseSetType=5`, `i2cp.leaseSetAuthType=1`): lo legge solo chi ha una delle chiavi elencate, una per telefono. Chi non ce l'ha riceve «LeaseSet not found» e non può sapere se il computer è acceso.

Senza telefoni accoppiati e senza accoppiamento aperto non c'è nessuna sessione: il computer non è raggiungibile da nessuno.

**I lettori dell'indirizzo non cambiano mai sotto un router in esecuzione.** Quando devono cambiare (un accoppiamento aperto o ritirato, un telefono rimosso) il ponte riavvia il router, che impiega circa un secondo e conserva quello che sa della rete. Il motivo, misurato su i2pd 2.60: un router che ha già tenuto una sessione su questo indirizzo non ne dà un'altra funzionante. Ricreata subito, la sessione riceve la vecchia destinazione con i vecchi lettori e la perde dopo 5 secondi, e un telefono da accoppiare non trova mai l'indirizzo («LeaseSet not found», 5 prove su 5); ricreata più tardi, l'indirizzo si trova ma per minuti nessun flusso riceve risposta.

## Accoppiamento

1. Dalla scheda «Telefono» l'utente apre un accoppiamento. Il ponte genera un segreto e una chiave di lettura per il nuovo telefono, e ricrea la sessione con quella chiave tra i lettori.
2. Compare il QR. Vale **una volta** e per **180 secondi**.
3. Il telefono raggiunge l'indirizzo via I2P e fa l'handshake di tipo `pairing` con il segreto.
4. Il computer registra la chiave del telefono. Il codice non vale più.

Cinque tentativi con il segreto sbagliato chiudono l'accoppiamento.

### Il codice

Testo in maiuscolo, sei campi separati da `:`, scritto nel QR in modo alfanumerico (versione 9, 53×53 moduli):

```
SYNTHORG-BRIDGE:1:<indirizzo>:<chiave>:<segreto>:<lettura>
```

| Campo | Contenuto |
|---|---|
| `1` | Versione del protocollo |
| indirizzo | 56 caratteri base32: l'indirizzo I2P senza `.b32.i2p` |
| chiave | Chiave pubblica X25519 del computer, base32, 52 caratteri |
| segreto | 32 byte, base32: la chiave pre-condivisa dell'accoppiamento |
| lettura | Chiave privata X25519 con cui il telefono legge il leaseset, base32 |

Base32 è RFC 4648 senza riempimento.

## Cosa deve fare il telefono

### Rete

- Un router I2P suo, incorporato o esterno, con interfaccia SAM 3.1 o successiva.
- Sessione `STYLE=STREAM`, `SIGNATURE_TYPE=7`, con `i2cp.leaseSetPrivKey=<lettura>` in base64 di I2P (`-` e `~` al posto di `+` e `/`) e `i2cp.leaseSetEncType=6,4` (`4` se il router non conosce il 6).
- **Una destinazione nuova a ogni sessione.** Il computer riconosce il telefono dalla chiave del canale, non da dove chiama. Una destinazione riusata subito dopo un riavvio riceve risposte cifrate con le chiavi della connessione precedente: misurato, nessun dato passa per circa due minuti.
- `STREAM CONNECT` verso `<indirizzo>.b32.i2p`. Appena cambiato l'indirizzo, la ricerca può fallire con `CANT_REACH_PEER`: riprovare ogni 4 secondi, fino a 6 volte.
- Se la connessione cade, ricreare la sessione SAM prima di riprovare.
- **Handshake a tempo.** Le prime parole su un flusso appena aperto a volte non arrivano, soprattutto da una destinazione creata da poco: misurato, l'handshake è riuscito in 2–22 s oppure non è riuscito affatto. Dare all'handshake 40 secondi, poi riprovare su un flusso nuovo, fino a 3 volte.

### Canale

Noise, schema XK con segretezza in avanti ibrida:

```
<- s
-> e, es, e1
<- e, ee, ekem1
-> s, se          (accoppiamento: s, se, psk)
```

| | Sessione | Accoppiamento |
|---|---|---|
| Nome | `Noise_XKhfs_25519+MLKEM768_ChaChaPoly_SHA256` | `Noise_XKhfspsk3_25519+MLKEM768_ChaChaPoly_SHA256` |
| Primo byte | `1` | `2` |
| Chiave pre-condivisa | nessuna | il segreto del codice |

- Prologo: i byte ASCII di `synthorg-bridge/1` seguiti dal primo byte.
- `e1` è una chiave pubblica ML-KEM-768 (1184 byte), `ekem1` il testo cifrato (1088 byte); il segreto condiviso entra con `MixKey`.
- Con la chiave pre-condivisa ogni `e` fa anche `MixKey` della chiave effimera, come da specifica Noise.
- Il telefono è l'iniziatore. Nel terzo messaggio manda come carico un JSON: `{"name": "...", "platform": "android"}`.
- Nonce di ChaCha20-Poly1305: 4 byte a zero e il contatore a 64 bit little endian.

### Sul filo

Ogni blocco è una lunghezza di 2 byte (big endian) seguita da quei byte.

1. Il telefono manda un blocco di 1 byte: il tipo di collegamento.
2. Tre blocchi di handshake.
3. Poi solo record cifrati. Un record in chiaro è 1 byte (`0`: seguono altri pezzi, `1`: ultimo pezzo) più i dati, al massimo 16 KB per pezzo.

Un messaggio è: 4 byte di lunghezza dell'intestazione (big endian), l'intestazione JSON in UTF-8, poi eventuali byte propri (una registrazione, un file). Massimo 24 MB.

### Messaggi

| Tipo | Forma |
|---|---|
| Richiesta | `{"t":"req","id":1,"method":"...","params":{}}` |
| Risposta | `{"t":"res","id":1,"ok":true,"result":{}}` |
| Rifiuto | `{"t":"res","id":1,"ok":false,"error":{"code":"...","message":"..."}}` |
| Evento | `{"t":"evt","name":"...","data":{}}` |

Il primo messaggio dopo l'handshake è l'evento `welcome`, con `device`, `desktop`, `page` e `keepaliveMs`.

**Il telefono deve mandare `ping` almeno ogni `keepaliveMs`** (45 secondi). Dopo 120 secondi di silenzio il computer lo considera andato.

## Richieste

| Metodo | Parametri | Risposta |
|---|---|---|
| `ping` | | `now`, `page` |
| `state` | | assistente, compiti, approvazioni in attesa |
| `assistant.history` | `before`, `limit` | `messages`, `more` |
| `assistant.say` | `text`, oppure una registrazione e `format` | `accepted` |
| `assistant.confirm` | `yes` | `accepted` |
| `assistant.interrupt` | | `accepted` |
| `assistant.stop` | | `accepted` |
| `projects.list` | | `projects` |
| `projects.chats` | `projectId` | `chats` |
| `projects.messages` | `chatId`, `before`, `limit` | `messages`, `more` |
| `projects.task` | `projectId`, `chatId`, `text` | `task` |
| `projects.stop` | `taskId` | `task` |
| `approvals.list` | | `approvals` |
| `approvals.decide` | `id`, `decision` (`allow` o `deny`) | `decided` |
| `agenda.list` | `from`, `to` | `items` |
| `files.list` | `before`, `limit` | `files`, `more` |
| `files.get` | `id` | dati del file, e il file nei byte |

| `chat.send` | `conversationId`, `text`, `id` | `accepted`: il Master risponde in quella chat, sul computer. `id` è quello del messaggio che il telefono ha già scritto nel suo archivio: resta un messaggio solo |
| `chat.stop` | `conversationId` | `stopped` |
| `chat.running` | | `running`: le chat in cui il computer sta rispondendo |
| `chat.live` | `conversationId` | `messages`: le risposte che il computer sta scrivendo in quella chat, intere, com'erano all'ultimo evento `chat.live` (`id`, `n`, `full`) |
| `plan.start` | `conversationId` | Il piano di quella chat di progetto viene avviato o ripreso (`resources/js/plan.js`) |
| `plan.stop` | `conversationId` | Il piano viene fermato dov'è |
| `plan.close` | `conversationId` | Il piano viene messo via |
| `plan.edit` | `conversationId`, `index`, `change` (`{title,instructions,check}`, o `null` per togliere il punto) | Un punto corretto o tolto, a piano fermo |
| `catalog.get` | `since`, `refresh` | `lastUpdated`, `same`; i modelli nei byte, JSON compresso gzip |
| `sync` | `site`, `to`, `have`, `after`, `upto`, `more`; le righe nei byte, JSON compresso gzip | `site`, `have`, `after`, `upto`, `more`, `count`; le righe nei byte, allo stesso modo. Oppure `reset`, `site` |
| `lan.offer` | | `addresses`: dove il computer ascolta sulla rete locale; rifiuto `lan_off` se l'impostazione è spenta |
| `api` | `method`, `path`, `body`, `range` | `status`, `type`, `data` (JSON) oppure i byte |
| `snapshot` | `items`: `[{ path, tag }]`, al massimo 120 | `encoding`, `count`, `changed`; l'elenco nei byte, JSON compresso gzip |

`ping`, `sync`, `lan.offer`, `api` e `snapshot` li risponde il servizio, anche quando la pagina non c'è; tutto il resto la pagina.

### L'archivio sta su tutti e due

Il telefono tiene l'archivio intero (chat e messaggi, memoria, note, agenda, diario, abitudini, obiettivi, avvisi, pause, file consegnati, impostazioni, elenco dei progetti) e ci applica le stesse regole del computer: gli stessi file di `server/` (`database.js`, `personal.js`, `memory-tree.js`, `usage.js`, `archive-api.js`), eseguiti così come sono dentro l'app (`android/src-tauri/src/archive.rs`). Quello che si fa su un dispositivo viene scritto lì, subito, da quel dispositivo: non si chiede niente all'altro per fare una modifica, e l'altro non la rifà: riceve le righe che ne sono uscite.

**Le righe** (`server/replica.js`). Ogni riga scritta nelle tabelle dell'archivio viene annotata da un trigger in `sync_log`: quale riga, un numero che su quel dispositivo cresce soltanto (`seq`), il momento (`at`) e se la riga non c'è più. Con `sync` il telefono manda le sue righe da `after` a `upto` e dice fin dove ha ricevuto (`have`); il computer le scrive, avvisa la pagina e risponde con le proprie, da dove il telefono è arrivato. Si ripete finché uno dei due ha `more`. La prima volta, chiesta da zero, è la prima copia: non c'è un passaggio a parte. Una riga arrivata da un dispositivo non gli viene rimandata.

Una riga viaggia così: `{ t, k, at, d }` (tabella, chiave, momento, la riga com'è), oppure `{ t, k, at, x }` per una riga che non c'è più (`x` è 2 quando è sparita insieme alla riga a cui apparteneva, per esempio i messaggi di una chat cancellata).

**Quello che il computer scrive arriva da solo.** Dopo una scrittura, entro 250 ms, il servizio manda ai telefoni collegati l'evento `sync` con le righe nuove (un messaggio mentre viene scritto parte com'è in quel momento). Se il telefono si accorge che gliene manca un pezzo (`after` oltre il punto in cui è arrivato) fa una richiesta `sync`.

**La stessa cosa cambiata su tutti e due mentre erano scollegati: resta la più recente, su entrambi.** Il momento di una modifica è l'orologio del dispositivo, ma sempre dopo quello della versione che modifica: chi cambia una riga arrivata dall'altro è il più recente, qualunque cosa dicano i due orologi. A parità di istante resta quella del computer. Una chat cancellata da un lato e scritta dall'altro dopo resta, intera. Due pagine di diario dello stesso giorno fatte separatamente diventano una (resta quella con l'identificativo che viene prima).

**I messaggi tengono lo stesso numero sui due lati**, così una conversazione si legge nello stesso ordine: il numero è il momento in cui il messaggio è scritto, in una casella propria del dispositivo (sedici caselle: il computer la 0, un telefono una delle altre), e comunque dopo tutti i messaggi che il dispositivo ha già.

**Un archivio rifatto, o un altro computer**: ogni archivio ha un suo segno (`site`). Il telefono dice a quale crede di parlare (`to`); se non è quello, il computer risponde `reset` e lo scambio riparte da zero nei due sensi. Un telefono usato da solo e poi accoppiato porta le sue cose: i due archivi diventano uno.

Nell'app Android le richieste della pagina all'archivio passano dall'IPC di Tauri (`archive_request`): la WebView di Android perde il corpo delle richieste verso un indirizzo gestito dall'app.

### Quanto sono lunghi i tunnel

Su internet c'è una strada sola, I2P: nessun server di terzi, nessuna porta aperta, nessun varco nei router. I tunnel del computer sono di **un salto** (impostazione `hops` del ponte, 1, 2 o 3; nell'app: Impostazioni, Telefono, «Lunghezza dei tunnel I2P»): un router della rete tra ogni lato e l'altro, e una richiesta impiega una frazione del tempo di tre salti. Con tre salti nessun router della rete sa chi parla con chi, la copertura per cui I2P è nota. Il telefono costruisce i suoi tunnel con lo stesso numero di salti del riferimento (`android/bridge-client/src/sam.rs`, uno). Cambiare l'impostazione rifà la sessione sul computer.

### Sulla stessa rete locale, senza I2P

Facoltativo, e spento finché l'utente non lo accende (impostazione `lan` del ponte; nell'app: Impostazioni, Telefono, «Collegamento diretto in rete locale»). Su I2P nessuno sulla rete vede che telefono e computer si parlano; sulla rete locale chi la gestisce lo vede, anche se non vede cosa si dicono. Spento, tutto passa sempre da I2P.

- **Il computer ascolta solo sui suoi indirizzi privati** (10.x, 172.16–31.x, 192.168.x), mai su un indirizzo pubblico né su IPv6, e accetta connessioni solo da indirizzi privati. Al router della rete non viene chiesto niente (nessuna porta inoltrata, niente UPnP): da fuori la porta non c'è. La porta è scelta una volta e tenuta.
- **Chi può entrare**: solo un telefono già accoppiato, con lo stesso handshake e le chiavi del suo accoppiamento. Sulla rete locale non si fa nessun accoppiamento. Chiunque altro raggiunga la porta non riceve risposta.
- **Come si trovano**: il telefono chiede gli indirizzi sul canale che ha già (`lan.offer`, risposta `{ addresses: [{ host, port }] }`; `lan_off` se l'impostazione è spenta) e li tiene. Quando l'impostazione viene accesa il computer manda l'evento `lan`. Niente viene annunciato sulla rete.
- **Due canali**: quello locale porta il traffico, quello I2P resta da parte e riprende quando il locale cade (il telefono è uscito dalla rete). Il canale locale non ha bisogno di quello I2P: con gli indirizzi tenuti, un telefono che si trova sulla stessa rete (stessi primi tre numeri dell'indirizzo) prova lì anche quando I2P non c'è.
- **Tempi stretti**: sulla rete locale una richiesta non costa niente, quindi le righe partono dopo 15 ms dal telefono e 30 ms dal computer (su I2P 120 e 250 ms, per farne viaggiare di più insieme). Il telefono manda un `ping` ogni 8 secondi sul canale locale: se esce dalla rete se ne accorge entro due.

### Quello che ha solo il computer

### Due mondi sul telefono

Ogni chat ha una casa (`conversations.home`): il sito dell'archivio che l'ha creata, scritto una volta e mai cambiato, replicato con la riga. Sul telefono l'interruttore «Telefono | PC» in alto (visibile con un computer accoppiato) sceglie il mondo: la lista delle chat è quella del mondo (`GET /api/conversations?home=own|others`, ogni riga con `world`: `own`, `peer` per il computer accoppiato ora, `other` per un computer di prima) e una chat nuova nasce nel mondo mostrato (`POST /api/conversations` con `home: 'own'|'peer'`; le chat di un progetto sono sempre del computer). Le righe del mondo Telefono (chat e ciò che ne dipende: messaggi, memorie, albero) non vengono mai mandate al computer (`replica.js`, `private`); quelle del mondo PC arrivano con lo scambio e quello che si fa lì torna al computer. Assistente, agenda, diario, memorie, impostazioni e chiavi sono gli stessi nei due mondi. Le chat di prima della casa prendono il dispositivo che ha scritto il loro primo messaggio (`fillHomes`, dallo slot del numero del messaggio).

### I progetti dal telefono

La zona Progetti del telefono (`android/ui/js/remote.js`, `projects`) è a pagine: l'elenco, poi un progetto con quattro schede (Chat, File, Storico, Artefatti), poi un file, un passo o un artefatto; il tasto Indietro risale di un livello. Tutto passa da `api` al computer accoppiato: senza computer la zona non c'è.

- File: le cartelle si aprono sul posto (`GET /projects/:id/files?dirs=`), la ricerca per nome (`files/search`), un file si legge intero (`GET files/read?path=`, fino a 2 MB, testo o byte in base64) e si scrive intero (`POST files/write` con `content` o `base64`, fino a 10 MB): una modifica a mano o un file caricato dal telefono, in entrambi i casi un passo dell'utente nello storico.
- Storico: i passi per giorno (`history`), un passo con i file cambiati e le differenze (`history/commit`), il ripristino di un file o del progetto a quel passo, chiesto prima (`history/restore`).
- Artefatti: l'elenco (`artifacts`) e uno da guardare (`GET artifacts/read?path=`, fino a 4 MB: le immagini si vedono, i testi si leggono, il resto «si apre sul computer»).

Il telefono è indipendente quanto il computer: chiama i modelli con la sua chiave, e i turni del Master e l'assistente girano sul telefono. Del computer restano i progetti Code (in una chat di progetto il turno gira sul computer, `chat.send`), il container e i file di una chat, il web, i modelli installati: il telefono li chiede con `api`, che porta la richiesta al servizio locale come se venisse dalla pagina (stesso controllo del vault, stesse verifiche), con il telefono come autore. Non sono raggiungibili lo spegnimento del servizio, il ponte stesso, l'importazione e le operazioni del vault. Prima di una richiesta di questo tipo, e prima di una richiesta alla pagina (`chat.send`, `assistant.say`), il telefono manda le righe che ha ancora da mandare: quello che ha scritto è già sul computer quando serve.

Su I2P conta il numero di richieste, non il loro peso. Per queste letture:

- **Ogni lettura riuscita ha un'impronta** (`tag`, 16 cifre esadecimali: SHA-256 della risposta JSON). Il telefono la tiene accanto alla copia.
- **La pagina riceve subito la copia.** Una lettura di cui il telefono ha la copia è risposta senza aspettare il computer; solo quello che non è mai stato letto aspetta.
- **`snapshot` controlla le copie tutte insieme.** Il telefono manda percorso e impronta di ogni copia non ancora controllata; il computer risponde `{ path, same: true }` per quelle ancora buone, `{ path, status, type, tag, data }` per quelle cambiate, `{ path, status }` per quello che non c'è più o non è JSON. Parte all'apertura del collegamento (dopo lo scambio delle righe) e, raggruppando le richieste di 150 ms, quando la pagina legge una copia non controllata.
- **La pagina è avvisata di quello che è cambiato**: l'app manda alla pagina l'evento `refreshed` con i percorsi, e `sync.js` mostra di nuovo solo quelle parti.

Senza un computer accoppiato, o mentre non è raggiungibile, queste richieste rispondono che serve il computer; tutto il resto dell'app funziona sull'archivio del telefono.

### I segreti restano dove sono

Le chiavi API e le impostazioni del ponte non lasciano il dispositivo su cui sono: non viaggiano nelle righe, in nessuno dei due sensi, né nelle risposte di `api` e `snapshot` (lì, al posto di una chiave impostata, il telefono legge `sul-computer`). Un telefono non può scriverle né cancellarle sul computer (`forbidden`). Non viaggiano nemmeno i registri dei costi (ogni dispositivo tiene il conto di quello che ha chiamato lui), le credenziali dei servizi esterni e le approvazioni dei progetti Code.

Una registrazione va nei byte del messaggio. `format` è `wav` oppure un formato che la pagina sa decodificare (Opus in Ogg, AAC in MP4, MP3): conviene compresso, perché 160 KB impiegano circa 9 secondi.

### Rifiuti

| Codice | Quando |
|---|---|
| `page_away` | L'app è aperta ma la pagina non risponde |
| `unknown_method` | Richiesta che non esiste |
| `empty` | Niente da dire, o compito vuoto |
| `working` | Il Master sta svolgendo un compito |
| `busy` | L'assistente sta ancora rispondendo |
| `diary` | Sul computer è in corso il diario |
| `forbidden` | Richiesta non consentita dal telefono (un segreto, il ponte, lo spegnimento) |
| `no_key`, `no_model` | Manca la chiave API o il modello del ruolo |
| `bad_audio` | Registrazione illeggibile |
| `nothing_to_confirm` | Nessun compito aspetta una conferma |
| `no_project`, `no_chat`, `no_task`, `no_approval`, `no_file` | Non trovato |
| `too_big` | File oltre 16 MB |

## Eventi

| Nome | Quando |
|---|---|
| `welcome` | Appena collegato |
| `page` | La pagina è tornata a rispondere |
| `assistant.message` | Un messaggio nella conversazione dell'assistente, da qualunque parte arrivi |
| `assistant.state` | Cambia lo stato: fase, compiti, conferma in attesa |
| `chat.message` | Un messaggio in una chat di progetto che il telefono segue |
| `task.update` | Un compito mandato a un progetto cambia stato |
| `approval.pending` | Un modello aspetta un'approvazione |
| `approval.settled` | L'approvazione è stata decisa o è scaduta |
| `reminder` | È arrivato un promemoria dell'agenda |
| `lan` | Il computer ha acceso il collegamento in rete locale: `allowed` |
| `sync` | Righe scritte sul computer: `site`, `after`, `upto`, `more`, `count`; le righe nei byte, JSON compresso gzip |
| `chat.running` | In una chat il computer comincia o finisce di rispondere |
| `chat.live` | Una risposta mentre il computer la scrive: `conversationId`, `id` del messaggio, `n` (contatore di quel messaggio). Il primo evento porta `full`, il messaggio intero; i successivi `ops`, solo i cambiamenti dall'evento prima (`{p,o,t}`: il testo al percorso `p` tiene i primi `o` caratteri e prosegue con `t`; `{p,v}`: il valore diventa `v`; `{p,d:1}`: tolto), circa ogni 100 ms; l'ultimo ha `done`. Un telefono a cui manca un `n` chiede il messaggio intero con la richiesta `chat.live`. Le card di approvazione arrivano così. L'archivio riceve la risposta ai suoi passaggi e alla fine, come prima. Riferimento: `resources/js/live-patch.js` |

Un messaggio salvato più volte mentre viene scritto arriva di nuovo solo se cambia testo o stato. Si aggiorna per `id`.

## Comportamento

- **Risposte scritte.** Quello che arriva dal telefono riceve risposta scritta: sul computer non viene detto niente a voce. Lo stesso vale quando un telefono è collegato e nessuno è nella sezione Assistente.
- **Conferma dei compiti.** Un compito che l'assistente vuole passare al Master viene chiesto anche sul telefono (`assistant.state.confirming`) e si conferma con `assistant.confirm`. Con la delega attiva parte subito. Allo stesso modo viene chiesto se si vuole sentire l'esito di un compito che non ha prodotto file: `confirming.outcome` è `true`, `confirming.task` è il compito, e si risponde con lo stesso `assistant.confirm`.
- **Compiti ai progetti.** Un compito mandato dal telefono a un progetto è dell'utente e parte subito. Per un progetto in container il container viene avviato prima.
- **Un compito alla volta.** Mentre il Master lavora per l'assistente, `assistant.say` viene rifiutato con `working`.

## Misure

### Sulla rete locale (1 ottobre 2026)

App vera nell'emulatore, servizio di prova sullo stesso computer (la rete tra i due è quella virtuale dell'emulatore: su una rete Wi‑Fi vera i tempi vanno misurati di nuovo).

| Cosa | Su I2P | Sulla rete locale |
|---|---|---|
| Modifica fatta sul telefono, presente sul computer | 0,3–0,9 s | circa 0,2 s con l'attesa di prima; ora l'attesa è 15 ms |
| Modifica fatta sul computer, presente sul telefono | 1,2 s | 0,34 s con l'attesa di prima; ora l'attesa è 30 ms |
| Messaggio di 300 KB dal telefono, presente sul computer | circa 18 s per 160 KB | 0,12 s |
| Collegamento locale aperto dopo aver acceso l'interruttore | | circa 3 s |
| Interruttore spento: ritorno su I2P | | subito, senza interruzione |

### Archivio sui due lati (1 ottobre 2026)

App vera nell'emulatore, rete I2P vera, servizio di prova con una copia dell'archivio del computer.

| Cosa | Tempo |
|---|---|
| Scrittura di un'impostazione dal telefono: attesa della pagina | 7–14 ms |
| Voce di agenda nuova dal telefono: attesa della pagina, già nell'elenco | 7–16 ms |
| La stessa modifica presente sul computer | 0,3–0,9 s |
| Modifica fatta sul computer presente sul telefono (evento `sync`) | 1,2 s |
| Chat nuova con un messaggio, dal telefono: attesa della pagina / sul computer | 36 ms / 0,3 s |
| Ritorno della rete dopo modifiche sui due lati: tutto allineato | 37 s |

### Pagine e stato (30 settembre 2026)

Prima dell'archivio sul telefono: ogni scrittura aspettava il computer.

App vera nell'emulatore, rete I2P vera, copia dell'archivio del computer, un altro telefono già accoppiato.

| Cosa | Tempo |
|---|---|
| Accoppiamento, con un altro telefono già accoppiato | 46 s |
| 16 letture mai fatte, chieste insieme al computer | 3,8 s (una sola: 1,1 s) |
| Le stesse 16 letture, dalla copia | 37 ms |
| Scrittura di un'impostazione dal telefono | 1,1 s; rilettura dalla copia 5 ms |
| App riaperta, non ancora collegata: 16 letture | 49 ms |
| Ricollegamento dopo la riapertura dell'app | 54 s |
| Copie aggiornate dopo il collegamento (`snapshot`, una richiesta) | 2,3 s |
| `snapshot` di 6 letture, dal telefono di riferimento | 0,75–2,0 s |


Rete I2P vera, router nel container, telefono simulato con `scripts/bridge-phone.js`.

| Cosa | Tempo |
|---|---|
| Avvio del router | 1,5 s |
| Accensione del ponte dall'app | 6,3 s |
| Indirizzo pronto per l'accoppiamento | 19–48 s |
| Accoppiamento del telefono | 43–57 s |
| Primo collegamento di una sessione nuova | 19–104 s |
| Ritorno con la sessione ancora aperta | 3,9 s |
| Una richiesta e la sua risposta | 1,1–1,8 s |
| Risposta dell'assistente a una frase | 5,2 s |
| Compito a un progetto, sola lettura | 26,7 s |
| Telefono collegato a finestra chiusa | 16–29 s |
| Risposta dell'assistente a finestra chiusa | 3,2–6,5 s |
| Router sparito dopo la chiusura forzata dell'app | 0,4–0,9 s |

| Cosa | Peso |
|---|---|
| App aperta | 610 MB |
| App a finestra chiusa, ponte acceso | 309 MB |
| Immagine del router | 24,7 MB |
| Memoria del router appena avviato | 6 MB |
| Memoria del router dopo due minuti d'uso | 25–29 MB |

Il primo collegamento è la parte lenta ed è variabile: il telefono costruisce i tunnel, pubblica il proprio leaseset e cerca quello del computer. Conviene tenere viva la sessione mentre l'app del telefono è aperta.

## Provare dal terminale

Con il ponte attivo nell'app:

```bash
node scripts/bridge-phone.js pair "<codice>" "Nome del telefono"
```

```bash
node scripts/bridge-phone.js call projects.list
```

```bash
node scripts/bridge-phone.js call assistant.say '{"text":"Ciao"}' --watch
```

Il client passa dal router dell'app, con una destinazione sua e un processo `podman exec` per connessione. Quello che tiene sta in `scripts/.bridge-phone`.
