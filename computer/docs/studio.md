# Studio: testi lunghi

Studio ha due schede: **Testi** (questo documento) e **Foto** (photocraft dentro la pagina, `docs/foto.md`). Un solo interruttore per tutte e due.

Codice: `server/studio.js` (progetto, fogli, mappa, strumenti del modello, LaTeX), `server/studio-tex.js` (immagine con Tectonic, cache dei pacchetti, compilazione nel container), `resources/js/studio.js` (sezione: elenco, fogli, correzione, mappa, pagine), agganci in `resources/js/chat.js` (tool e blocco `[STUDIO]` nelle chat di progetto), `server/code-permissions.js` (gli strumenti di Studio passano dallo stesso cancello del codice), `scripts/fetch-tectonic.js` e `scripts/fetch-pdfjs.js`. Prove: `tests/studio.test.js`.

## Cos'è

Un progetto di Studio è un progetto come quelli di Code (stessa tabella `projects`, colonna `section = 'studio'`, stesso git che registra, stesse chat di progetto), ma la cartella contiene capitoli e non codice:

```
studio.json              tipo (romanzo | copione | saggio), lingua (it | en), titolo, autore, impostazioni, ordine dei capitoli, capitolo in lavorazione
capitoli/<id>.json       un capitolo: i suoi paragrafi
esportazioni/            quello che l'utente esporta (PDF, .tex, .md)
```

Ogni paragrafo ha due testi: la **brutta** (`draft`, quello che l'autore scrive) e la **bella** (`clean`, lo stesso paragrafo sistemato dal modello), più l'impronta della brutta da cui la bella è stata fatta (`cleanOf`) e se la bella è stata corretta a mano (`own`).

- La brutta cambia → la bella è «da rifare» (`stale`): dopo la pausa del progetto (interruttore «Sistema mentre scrivo», oppure «Sistema ora») i paragrafi da rifare vanno al Master della chat del progetto, con il vicino prima e dopo come contesto, e tornano nella bella. Si corregge ortografia, grammatica, punteggiatura e formattazione tenendo stile e significato; il prompt sta in `cleanupRequest`. Una risposta arrivata quando la brutta è già cambiata ancora viene scartata (confronto delle impronte).
- La bella si può correggere a mano: resta così finché la brutta non cambia.
- Dalla chat il modello può fare di più con i suoi strumenti: `studio_read` (paragrafi numerati), `studio_open` (una voce della mappa), `studio_replace`, `studio_insert`, `studio_delete`, `studio_chapter`. Con lo stesso numero di paragrafi, una sostituzione tiene la brutta dell'autore e cambia la bella; altrimenti i paragrafi nuovi hanno brutta e bella uguali. Ogni strumento è un passo dello storico con autore «SynthOrg (modello)».
- Permessi: gli strumenti passano dal cancello di `code-permissions.js` (modi manuale/semi/auto, selettore «Testo» nel pannello della chat). Un progetto di Studio senza modo proprio parte in **automatico** (impostazione `studio_perm_text`), perché è l'utente che chiede le modifiche in chat; in semi la chiave è `modifica:capitolo N`, e aggiungere/spostare/eliminare capitoli chiede sempre.

## La mappa del testo

Speculare alla memoria a livelli delle chat (`docs` in `server/memory-tree.js`): nodi con titolo e riassunto sul testo invece che sui turni.

- Livello 1: una scena = paragrafi consecutivi di un capitolo fino a ~1200 token. Livello 2: il capitolo. Livello 3: una parte = 6 capitoli consecutivi (solo da 12 capitoli in su).
- Tabella `studio_nodes` (chiave `livello:capitolo:da-a`, impronta del testo coperto). `pending` dice cosa manca o è vecchio, dal basso verso l'alto; la pagina chiede i riassunti al modello Microtask in sottofondo (`updateMap` in `studio.js`) e li deposita con `addNode`.
- A ogni turno della chat del progetto il modello riceve il blocco `[STUDIO]` (`view`): i nodi più grossi, raffinati verso il capitolo in lavorazione finché si sta entro tetto × quota (`settings.cap`, `settings.share` in `studio.json`; quota 0 = solo il livello più alto). Con `studio_open` scende fino ai paragrafi originali.

## L'impaginazione

- Motore: **Tectonic** (XeTeX in Rust), binario statico musl scaricato da `scripts/fetch-tectonic.js` con sha256 della release, in `tectonic-bin/` (risorsa del bundle). Non gira mai sul computer: viene copiato nell'immagine `localhost/synthorg-studio-tools:<base>-<stamp>` (base Alpine di SynthOrg + `/opt/synthorg-studio/tectonic` + `/work`).
- Pacchetti TeX: come le altre librerie. Un container **con rete** (`warmCache`, il canale inerte) compila i documenti di prova nostri (`warmDocuments`: ogni costrutto dei tre modelli, nelle due lingue, nessun testo dell'utente) con il volume `synthorg-cache-tectonic` montato in scrittura. Lo avvia l'utente (pulsante «Scarica i pacchetti TeX», nella scheda impaginato quando mancano o nelle impostazioni).
- Compilazione (`compile`): container **senza rete**, cache montata in sola lettura, `--only-cached`; il `.tex` entra via stdin (`podman cp -`), esce solo il PDF (`podman cp` verso `data/studio/<id>/main.pdf`). Il sorgente generato sta in `data/studio/<id>/main.tex`.
- Modelli: romanzo = `book` A5 con `\chapter`; saggio = `article` A4 con indice e `\section`; copione = Fountain → macro nostre (`\slug`, `\cue`, `\paren`, `\dialogue`, `\transition`, `\centered`, `\action`) in TeX Gyre Cursor. Font via `fontspec`, lingua via `polyglossia`. Testo: `*corsivo*`, `**grassetto**`, `# titolo interno`, `> citazione`, `- elenco`, `---` stacco; virgolette dritte → «» (it) o “” (en).
- Pagine: `resources/vendor/pdfjs/` (pdf.js, scaricato da `scripts/fetch-pdfjs.js` con integrity del pacchetto npm) disegna il PDF nella terza scheda. Niente visualizzatore di sistema.
- Esportazione: solo su richiesta, nella sottocartella `esportazioni` del progetto (PDF, .tex, .md).

## Rotte

`GET/POST /api/studio/tex[/warm]`, `DELETE /api/studio/tex`; `POST /api/studio/:id/init`; `GET|PATCH /api/studio/:id`; `POST …/focus`; `GET|PUT|PATCH|POST …/chapters/:cid` (lettura, brutta, bella a mano, `op: request | apply` per la correzione); `POST …/chapter` (add/rename/remove/move); `GET …/context`, `…/tree`, `…/pending`; `POST …/nodes`, `GET …/nodes/:node`; `POST …/tools/:name` (col cancello dei permessi); `POST|GET …/compile`, `GET …/compile/log`, `GET …/pdf` (byte), `POST …/export`. `GET /api/projects?section=studio` elenca i progetti di Studio (senza parametro: quelli di Code); `GET /api/projects/:id` dice la sezione.
