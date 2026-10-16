# Ricezione dei numeri condivisi

Servizio Cloudflare (Worker) che riceve i numeri che un utente di SynthOrg sceglie di condividere e li scrive come file in una repository GitHub privata.

Finché questo servizio non è pubblicato e il suo indirizzo non è scritto nell'app, l'app non chiede niente a nessuno e non invia niente.

## Cosa arriva

Un file JSON per ogni condivisione, in `packages/<settimana>/<id>.json`:

- versione dell'app e settimane a cui i numeri si riferiscono;
- per ogni gruppo (modello, ruolo, luogo, tipo di progetto): richieste, turni, risposte fermate, corrette e ripristinate, token, costo, mediane dei tempi.

Non arrivano testi, nomi di progetti o di file, identificativi, date o orari. Il servizio non salva indirizzo, intestazioni o altro su chi ha inviato. Un pacchetto con un campo in più o un testo non previsto viene rifiutato per intero.

## Pubblicazione

1. Creare la repository privata su GitHub, con almeno un commit sul ramo `main`.
2. Creare un token *fine-grained* limitato a quella repository, con permesso **Contents: Read and write** e nessun altro.
3. Scrivere `owner/nome` della repository in `GITHUB_REPO` dentro `wrangler.toml`.
4. Dalla cartella `share-worker`:

```bash
npx wrangler login
```

```bash
npx wrangler secret put GITHUB_TOKEN
```

```bash
npx wrangler deploy
```

5. Scrivere l'indirizzo pubblicato (per esempio `https://synthorg-share.<account>.workers.dev`) in `server/share-endpoint.js`, campo `SHARE_ENDPOINT`.

Per limitare gli invii ripetuti si può attivare il blocco `LIMITER` in `wrangler.toml` oppure una regola di rate limiting dal pannello Cloudflare.

## Prova in locale

Le prove automatiche dell'app (`tests/share_worker.test.js`) eseguono il servizio con una GitHub finta. Per provarlo a mano:

```bash
npx wrangler dev
```

e nell'app, solo per la prova, impostare `usage_share_endpoint` a `http://127.0.0.1:8787`.
