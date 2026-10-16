# SynthOrg

SynthOrg è un'app da scrivania per lavorare con i modelli AI senza passare da servizi nostri: i modelli remoti li chiami con le tue chiavi, quelli locali girano sul tuo computer, tutto il resto resta sul tuo disco.

## Cosa fa

- **Chat** con un ambiente isolato per ogni chat: il modello esegue codice e comandi in un container Podman, con rete accesa o spenta a tua scelta, e può usare un desktop Linux in un altro container (computer use), sempre con il tuo permesso.
- **Modelli**: una lista sola con il catalogo OpenRouter, le chiavi dirette di OpenAI, Anthropic, Google, DeepSeek e Meta come via alternativa sullo stesso modello, e i modelli locali GGUF con llama.cpp. Costi e token registrati per ogni richiesta.
- **Code**: progetti in una cartella o in un pod, editor con terminale dentro il pod, ogni modifica del modello è un passo di git che puoi guardare e annullare, GitHub collegato con Scarica e Carica espliciti, permessi del modello per codice e terminale.
- **Studio e Foto**: testi lunghi a capitoli con LaTeX compilato in un pod; editor fotografico nella pagina con le funzioni del modello.
- **Assistente**: un personaggio che prende le richieste a voce o per iscritto, dà compiti al modello, tiene agenda, diario e abitudini, e avvisa in locale.
- **Telefono**: app Android con il suo archivio, chat del telefono e chat del computer separate, collegata al computer attraverso I2P (nessun server in mezzo) o in rete locale; progetti, file e storico raggiungibili dal telefono.

## Dati e sicurezza

- Nessun account, nessuna telemetria: dal computer non parte niente che tu non abbia chiesto.
- Archivio SQLite sul tuo disco, cifrabile con una master password; la Memoria si può tenere su un altro disco o cartella sincronizzata.
- I pod girano rootless, senza il disco di Windows montato, con capability tolte e profilo seccomp ristretto.

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

Il repository contiene i sorgenti e gli script. Quello che gli script scaricano o compilano (runtime Node, llama.cpp, Tectonic, l'editor, le estensioni, le librerie native del telefono) non è nel repository: `npm run stage` nella cartella `computer/` lo prepara, `android/native/i2pd/build.sh` compila il router per il telefono.

## Licenza

SynthOrg è distribuito sotto la [GNU Affero General Public License, versione 3](LICENSE). Puoi usarlo, studiarlo, modificarlo e ridistribuirlo, anche a pagamento, purché ogni versione modificata resti sotto la stessa licenza con i sorgenti disponibili a chi la usa, compreso chi la usa attraverso una rete.

L'editor della sezione Code deriva da [SideX](computer/vendor/sidex/LICENSE) (MIT), a sua volta derivato da VS Code (MIT); le licenze dei componenti di terze parti sono nelle rispettive cartelle.

## Stato

In sviluppo. Le prove automatiche coprono il servizio; l'app è provata a mano su Windows, su Ubuntu in WSL e sul telefono.
