# SynthOrg

SynthOrg è un'app da scrivania per lavorare con i modelli AI senza passare da servizi nostri: i modelli remoti li chiami con le tue chiavi, quelli locali girano sul tuo computer, tutto il resto resta sul tuo disco.

## Cosa fa

- **Chat** con un ambiente isolato per ogni chat: il modello esegue codice e comandi in un container Podman, con rete accesa o spenta a tua scelta, e può usare un desktop Linux in un altro container (computer use), sempre con il tuo permesso. Memoria a livelli per le chat lunghe (riassunti per turno, capitoli, sovracapitoli) e memorie condivise tra tutte le chat. Immagini, video, musica, voce e trascrizioni con i modelli del catalogo.
- **Modelli**: una lista sola con il catalogo OpenRouter, le chiavi dirette di OpenAI, Anthropic, Google, DeepSeek e Meta come via alternativa sullo stesso modello, e i modelli locali GGUF con llama.cpp (Vulkan), anche più di uno in memoria insieme. Ragionamento a grafo per i modelli locali: più continuazioni aperte, confrontate e scelte a ogni pensiero. Costi e token registrati per ogni richiesta, per progetto e per ruolo.
- **Code**: progetti in una cartella o in un pod, editor SideX e un editor nostro con terminale che gira dentro il pod, ogni modifica del modello è un passo di git che puoi guardare e annullare, GitHub collegato con Scarica e Carica espliciti, permessi del modello per codice e terminale, modalità piano con punti verificati uno a uno.
- **Writing**: testi lunghi a capitoli, brutta e bella copia per paragrafo, correzione dal modello, LaTeX compilato con Tectonic dentro un pod e letto nella pagina.
- **Photo**: PhotoCraft nella pagina, con il nostro tema, e sopra le funzioni che i modelli aggiungono: rimozione dello sfondo in locale (BiRefNet su ONNX Runtime), maschere, selezione usata come vincolo, livelli, tutto richiamabile anche dalla chat del progetto.
- **Assistente**: un personaggio, MO', che prende le richieste a voce o per iscritto, dà compiti al modello e consegna i file che ne escono, legge le tue chat e le sorveglia a fine turno con le regole che gli dai, tiene agenda, diario, abitudini e consumi, e avvisa in locale senza chiamare nessun modello.
- **Telefono**: app Android con il suo archivio, chat del telefono e chat del computer separate, assistente e memorie in comune, collegata al computer attraverso I2P (nessun server in mezzo, canale Noise XK con ML-KEM-768) o in rete locale; progetti, file e storico raggiungibili dal telefono.
- Interfaccia in italiano e inglese, guida fatta facendo le cose, ogni comportamento che persiste ha il suo interruttore.

## Dati e sicurezza

- Nessun account, nessuna telemetria: dal computer non parte niente che tu non abbia chiesto.
- Archivio SQLite sul tuo disco, cifrabile con una master password (scrypt e AES-GCM); la Memoria si può tenere su un altro disco o cartella sincronizzata.
- I pod girano rootless, senza il disco di Windows montato, con capability tolte e profilo seccomp ristretto. Le chiavi dei modelli non viaggiano mai verso il telefono.

## Installazione

- **Windows**: l'installer `.exe`. Serve WSL2 per i pod: l'app crea e gestisce da sola la propria distro.
- **Linux**: il pacchetto `.deb` (Ubuntu 22.04 o più recente; `podman` consigliato per i pod).
- **Android**: l'`.apk` per arm64. Il telefono funziona anche da solo, con la sua chiave; accoppiato al computer con un codice QR.

Le chiavi dei modelli si inseriscono nelle Impostazioni. I modelli locali e i pesi per le foto si scaricano dall'app: non sono nel pacchetto.

## Com'è organizzato il repository

| Cartella | Contenuto |
| --- | --- |
| `computer/` | L'app da scrivania: shell Tauri (`src-tauri/`), servizio Node (`server/`), interfaccia (`resources/`), test (`tests/`), documentazione (`docs/`). Come si compila: [computer/README.md](computer/README.md) |
| `android/` | L'app Android: stessa interfaccia, archivio in QuickJS, router I2P compilato dentro l'app, lato telefono del ponte. Come si compila: [android/README.md](android/README.md) |

Il repository contiene i sorgenti e gli script. Quello che gli script scaricano o compilano (runtime Node, llama.cpp, Tectonic, PhotoCraft, l'editor, le estensioni, le librerie native del telefono) non è nel repository: `npm run stage` nella cartella `computer/` lo prepara, `android/native/i2pd/build.sh` compila il router per il telefono.

## Licenza

SynthOrg è distribuito sotto la [GNU Affero General Public License, versione 3](LICENSE). Puoi usarlo, studiarlo, modificarlo e ridistribuirlo, anche a pagamento, purché ogni versione modificata resti sotto la stessa licenza con i sorgenti disponibili a chi la usa, compreso chi la usa attraverso una rete.

SynthOrg si appoggia a progetti di altri, con le loro licenze:

| Componente | Cosa fa in SynthOrg | Licenza |
| --- | --- | --- |
| [SideX](computer/vendor/sidex/LICENSE) (da VS Code) | l'editor della sezione Code | MIT |
| [PhotoCraft](https://github.com/storytold/photocraft) | l'editor della sezione Photo, compilato per il web e incastonato nella pagina | MIT / Apache-2.0 |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | i modelli locali GGUF | MIT |
| [Tectonic](https://tectonic-typesetting.github.io) | la compilazione del LaTeX nei pod | MIT |
| [pdf.js](https://mozilla.github.io/pdf.js/) | la lettura dei PDF nella pagina | Apache-2.0 |
| [ONNX Runtime](https://onnxruntime.ai) e [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) | la rimozione dello sfondo in locale | MIT |
| [i2pd](https://github.com/PurpleI2P/i2pd) | il router I2P dentro l'app Android | BSD-3-Clause |
| [QuickJS](https://bellard.org/quickjs/) via rquickjs | l'archivio sul telefono, con lo stesso codice del computer | MIT |
| [Tauri](https://tauri.app), [Podman](https://podman.io) | la finestra e i pod | MIT / Apache-2.0 |

Le licenze complete sono nelle rispettive cartelle e nei pacchetti.

## Stato

In sviluppo. Le prove automatiche coprono il servizio; l'app è provata a mano su Windows, su Ubuntu in WSL e sul telefono.
