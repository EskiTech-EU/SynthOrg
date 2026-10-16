# Il piano nelle chat di progetto

Codice: `resources/js/plan.js` (motore e interfaccia), agganci in `resources/js/chat.js` (turni, strumenti), `resources/js/bridge.js` (richieste dal telefono), `resources/js/code-workspace.js` e `resources/js/remote.js` (impostazioni accanto ai permessi). Prove: `tests/plan.test.js`.

## Cosa fa

Con «Piano» acceso accanto al campo di scrittura, in una chat di progetto, la richiesta non viene svolta in un turno solo.

1. **Stesura.** Il Master riceve la richiesta con un'istruzione in più nel prompt di sistema e lo strumento `plan_write`: scrive i punti in ordine, ognuno con `title`, `instructions` (cosa fare) e `check` (come si verifica). Se gli mancano informazioni non scrive il piano e le chiede.
2. **Avvio.** Manuale: il piano resta «da avviare», l'utente lo legge, corregge o toglie punti, e lo avvia. Automatico: parte da solo.
3. **Punti.** Per ogni punto, in ordine, SynthOrg inietta un turno con le istruzioni di quel punto (più l'elenco dei punti con il loro stato). Il Master lavora con i suoi strumenti e dichiara finito il punto con `plan_done`; se non può andare avanti senza l'utente chiama `plan_stop`.
4. **Verifica.** Dichiarato finito, SynthOrg inietta un turno di verifica: lo stesso Master controlla il punto contro il suo criterio e risponde con `plan_check` (`passed`, `missing`). Passato: punto successivo. Non passato: lo stesso punto viene iniettato di nuovo con quello che manca.
5. **Fine.** Fatti tutti i punti, un ultimo turno iniettato chiede il riepilogo per l'utente.

Un punto viene iniettato al massimo N volte (conta ogni iniezione: dopo una verifica non passata, o dopo un turno finito senza `plan_done`). Poi il piano si ferma («serve il tuo intervento») e aspetta: l'utente può scrivere in chat, correggere il punto, riprendere (i tentativi del punto ripartono) o chiudere il piano.

## Dove stanno le cose

| Cosa | Dove |
|---|---|
| Il piano di una chat | impostazione `plan_<id chat>` (JSON: `status`, `current`, `tries`, `points[]`, `reason`) |
| Avvio manuale o automatico, per progetto | impostazione `plan_mode_<id progetto>` (`manual`, `auto`) |
| Tentativi per punto, per progetto | impostazione `plan_tries_<id progetto>` (1–50, 5 se non impostato) |
| Interruttore «Piano» di una chat | sul dispositivo (`localStorage`) |
| Turni iniettati | messaggi `user` con `plan: { phase: point \| check \| final, index, of, title, attempt }`, mostrati come una riga con il testo dietro |

Stati del piano: `draft` (da avviare), `running`, `paused` (fermato dall'utente o da un turno fallito), `blocked` (tentativi finiti, o fermato dal Master), `done`, `closed`.

Il piano gira sul computer, dove sta il progetto. Il telefono lo vede dall'archivio e chiede al computer di avviarlo, fermarlo, correggerlo o chiuderlo (`plan.start`, `plan.stop`, `plan.edit`, `plan.close`); una richiesta mandata dal telefono con il piano acceso porta `plan: true` in `chat.send`.

Un turno del piano ha fino a 20 passi con gli strumenti (una risposta normale ne ha 6).
