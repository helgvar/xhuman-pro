# Ticket Farmabooster — Farmacia Mandanici: il feed civetta non viene più ritirato

**Data:** 12/09/2026 · **Priorità:** alta · **Tenant:** Farmacia Mandanici

## Sintomo
La chiamata a `GET /api/external/v1/feed/civetta` per Farmacia Mandanici si è
interrotta il **10/09/2026 alle 22:18** (ora italiana) e non è più ripresa.
Nessun'altra farmacia è coinvolta: tutte le altre nove continuano a ritirare
regolarmente.

## Misura, ultime 72 ore

| Farmacia | Ritiri 72h | Ultimo ritiro | Prodotti serviti |
|---|---:|---|---:|
| **Mandanici** | **48** | **10/09 22:18** | 5.071 |
| Farmastelia | 96 | 12/09 21:07 | 22.862 |
| SubitoFarma | 114 | 12/09 22:08 | 18.139 |
| Farmacri | 156 | 12/09 22:32 | 39.737 |
| Ospedale | 173 | 12/09 21:11 | 6.333 |
| Procaccini | 185 | 12/09 22:07 | 15.958 |
| MPF | 188 | 12/09 22:40 | 18.903 |
| Papa | 189 | 12/09 22:22 | 17.310 |
| San Vito | 191 | 12/09 22:32 | 47.363 |
| Farmainsieme | 223 | 12/09 22:35 | 19.325 |

Prima del 10/09 Mandanici veniva ritirato 23-28 volte al giorno, con la stessa
cadenza degli altri. Lo stacco è netto, non progressivo.

## Cosa abbiamo verificato dalla nostra parte (tutto in ordine)
- **Chiave API**: la riga della farmacia è attiva; ultimo utilizzo registrato
  10/09 22:18 — coincide esattamente con l'ultimo ritiro. Nessuna revoca,
  nessuna rotazione, nessuna scadenza in mezzo.
- **Rifiuti di autenticazione**: **zero** nei log delle ultime 72 ore
  (nessun 401, nessun "invalid api key", nessun "unauthorized"), per Mandanici
  come per gli altri. Non stiamo respingendo nessuno.
- **Endpoint**: lo stesso endpoint, sullo stesso processo, sta servendo le altre
  nove farmacie senza interruzioni fino a pochi minuti fa.
- **Dati della farmacia vivi**: prodotti aggiornati il 12/09 22:09, ordini in
  arrivo fino al 12/09 20:51, file click consegnato il 12/09. La farmacia
  lavora, è solo il ritiro del feed che manca.
- **Feed pronto**: la lista stabile di Mandanici viene ricostruita ogni 30
  minuti e contiene circa 4.900 codici, prezzi compresi. È in attesa, nessuno
  la ritira.

## Conclusione
La richiesta HTTP **non arriva più**. Non è un rifiuto da parte nostra: è la
chiamata che ha smesso di partire dal vostro lato per questa singola farmacia.

## Cosa chiediamo
1. Verificare se lo scheduler/job che ritira il feed civetta di Farmacia
   Mandanici è fermo, in errore o disabilitato dal 10/09 sera.
2. Se è stato disattivato per una modifica di configurazione della farmacia,
   dirci quale, così allineiamo la nostra parte.
3. Farci sapere se serve una nuova chiave: possiamo rigenerarla e consegnarla
   sul canale sicuro concordato (mai via e-mail o chat).

## Impatto
Da due giorni Mandanici serve a Trovaprezzi la lista del 10/09 sera. Nel
frattempo sono ferme in attesa **1.317 aggiunte** già calcolate, più tutti gli
aggiornamenti di prezzo prodotti da allora.
