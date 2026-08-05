# Regole del loop standard — cosa deve girare da solo

**Ordine del capo, 5/8/2026:** *"tutto quello che stiamo facendo deve diventare la regola dei loop standard."*

Questo documento separa tre cose che finora erano mescolate:

1. **Già dentro i motori** — gira senza di me.
2. **Provato ma ancora a mano** — ha portato risultati misurati, ma se non lancio io un SQL non succede. È il debito vero.
3. **Da provare** — ipotesi non ancora misurate.

Il registro delle singole operazioni resta in `PILOTA_MPF_OPERAZIONI.md`. Qui ci sta solo ciò che deve diventare **legge ricorrente**.

---

## 1. Già dentro i motori

| Regola | Dove | Perimetro |
|---|---|---|
| Il cap condanne conta solo SKU davvero nel feed | mig 088 + `feed_stable_sku` | MPF (flag `cap_solo_feed`) |
| L2 non assolve chi vende senza ripagare il click | mig 089 | MPF |
| L4-30gg non assolve se il margine 15gg è bruciato | mig 090 | MPF |
| Writer `capo_%` scavalca basket guard e cap | mig 091 | rete |
| Veto rialzi universale, veto sotto-costo, veto brand, veto regola Sconto | trigger su `feed_actions` | rete |
| Arbitro azioni: l'ultimo che scrive non vince | mig 058 + `azioni_touch_log` | rete |
| Riattivazione blocchi margine (R1 rete, R2 restock, R3 test) | mig 072, cron 05:00 | rete |
| Guardiano prezzi sul costo del momento | mig 073, cron 2h | rete |

---

## 2. Provato, misurato, **ancora a mano** — il debito

### 2.1 La scala del click: sotto 15 click lo zero non è una condanna

**Misura (Papa, 30gg, SKU nel feed):**

| Click 30gg | SKU | Ne vende almeno uno | % |
|---|---|---|---|
| 1 | 1.079 | 267 | 24,7 |
| 2-4 | 689 | 247 | 35,8 |
| 5-14 | 253 | 129 | 51,0 |
| 15-39 | 65 | 56 | 86,2 |
| 40+ | 30 | 27 | 90,0 |

Sopra i 15 click 9 SKU su 10 vendono: lì lo zero è una condanna provata. Sotto i 5, tre quarti non vendono comunque — ma non sai se è il prodotto o se non l'hai testato abbastanza. **Con 2 click non hai fatto un esperimento, hai fatto rumore.**

**Regola da codificare:** ogni motore che condanna per "zero vendite" deve dichiarare la fascia di click. Tre trattamenti distinti, mai uno solo:
- **≥15 click, zero ordini** → condanna diretta, nessun dubbio.
- **5-14 click** → sospetto: condanna solo se anche il margine unitario è negativo o nullo.
- **1-4 click** → rumore: non condannare per merito, rimuovere per **costo aggregato** e riammettere a rotazione.

### 2.2 Il rumore si taglia in blocco, non uno a uno

Nessun SKU a 1-4 click merita una condanna individuale. Ma il blocco costa:

| Tenant | SKU rumore | Costo/giorno | Data |
|---|---|---|---|
| MPF | 330 (già trattati) | 18,21 | 5/8 |
| Papa | 1.130 | 18,94 | 5/8 |
| Farmastelia | 2.019 | 34,02 | 5/8 |

**Regola da codificare** — filtri obbligatori prima di togliere un blocco di rumore:
1. Brand protetti del tenant (`health_config.killer_protected_brands`) — **fuori solo dove il cliente li ha chiesti**. Dal 5/8 esiste **solo su MPF**: UNI/GAD/MYC/EUC erano finiti su Papa e Procaccini per propagazione (stesso `updated_at` al microsecondo), non per volontà di quei clienti. Non inventare uno scudo dove la config non c'è.
2. Ordini reali Magento a 30 giorni, whitelist stati — se ha venduto anche una volta, resta.
3. `action_source` deve iniziare per `pulizia_` o il rerun engine la cancella.
4. Writer `capo_%` solo sotto ordine esplicito, sempre a verbale.
5. Intoccabili: `capo_pin`, `muro_scavalco`, `manual`. **Non** `manual_pepita` — vedi 2.7.

### 2.7 Nessuna finestra oltre i 30 giorni — mai

**Ordine del capo 5/8, ripetuto:** *"i 90gg sono troppi come già ti ho detto 7659 volte."* Si giudica cosa vende e cosa no su **15 o 30 giorni**. Le finestre lunghe non sono prudenza: fanno sembrare vivo un prodotto morto da due mesi.

Conseguenze già applicate:
- Cade la salvaguardia *"venduto fra 31 e 90 giorni con stock fisico"* — era la finestra a 90gg travestita da regola aurea.
- `crossTenantOblio.js` passa a 15gg su ordini e click.

**Trappola: quando si stringe una finestra, ricontrollare ogni criterio di continuità che ci vive dentro.** In `crossTenantOblio.js` la finestra era già stata portata a 15 giorni ma la continuità era rimasta `COUNT(DISTINCT date_trunc('month', fetch_date)) >= 2`: due mesi distinti dentro 15 giorni esistono solo a cavallo del cambio mese, quindi **dal 16 di ogni mese il cron trovava zero candidati**. Non dà errore, dà zero righe — e "zero nuovi burner" sembra un risultato legittimo. Corretto a settimane distinte il 5/8.

Lo stock fisico **non è un veto** sotto questa regola, è una nota di merito. Un prodotto di magazzino che prende click e non vende in 30 giorni non si sta girando pagando la vetrina: si taglia, e si guarda per primo se il fatturato cede.

`manual_pepita` non protegge: pepita che ha preso click e non ha venduto in 30gg = ipotesi falsificata. Diverso da `capo_pin`, che è una decisione e resta.

### 2.3 Le guardie sono cieche sul margine

`vende_e_ripaga()` confronta il **fatturato** col costo del click. `porta_carrelli_sani()` confronta il **margine del carrello** col costo del click. **Nessuna delle due guarda il margine del prodotto**: chi vende sottocosto supera ogni test, perché vende.

Conto corretto: `netto 90gg = margine_carrello − costo_click + margine_unitario × pezzi`.

Su MPF quattro prodotti dichiarati "sani" erano netti negativi (RETINOL −48,40, RAMATONIC −13,11, LASONIL −12,06, BEPANTHENOL −8,41). Sulla rete: **176 SKU sotto costo, ~€5.270 in 90 giorni, €58/giorno**.

**Regola da codificare:** il margine unitario vero entra dentro le due funzioni. Costo vero = `erp_purchase_cost` se stock fisico, altrimenti `erp_cost`. Non l'ho applicata da solo perché tocca tutta la rete, non il pilota — serve la parola del capo.

### 2.4 Chi forza in vetrina filtra sul margine, sempre

Il 5/8 ho forzato venditori senza filtro margine e sono entrati quattro prodotti sottocosto. Errore mio, corretto in giornata. **Vendere non basta**: prima di ogni ADD forzato serve `prezzo_vero − costo_vero > 0`.

### 2.5 Il freno di budget di fine mese

Papa il 30/7 ha fatto 18 click e il 31/7 zero, mentre tutta la rete girava: budget TP mensile esaurito con un giorno e mezzo di anticipo.

| Mese | Giorni attivi | Costo TP |
|---|---|---|
| Maggio | 29 | 4.550,33 |
| Giugno | 30 | 3.329,90 |
| Luglio | 30 | 4.793,76 |

**Regola da codificare:** pacing mensile per tenant. Dal giorno 20, se `speso_mese / tetto > giorni_trascorsi / giorni_mese + 5%`, stringere i filtri sul rumore invece di arrivare allo spegnimento secco. Un feed che si spegne il 30 perde due giorni pieni di fatturato per non aver rinunciato a €20/giorno di rumore.

### 2.6 Le finestre di misura non sono confrontabili fra loro

`zombie_clicks` è scritto due volte: il cron 05:02 scrive il **giorno prima completo**, il cron intraday scrive il giorno corrente **parziale**, e l'UPSERT finale cancella i parziali. Non esiste storia intraday.

**Regola:** mai confrontare un parziale con una media giornaliera. Si confronta o quota-sulla-rete, o riga piena contro riga piena.

---

## 3. Da provare

- **Aggregatore coda lunga**: i 1-4 click non vanno solo tolti, vanno testati a rotazione a costo controllato. Senza questo, il taglio del rumore è definitivo e cieco.
- **Spedizione MPF €5,82 → €4,76**: mette 10.889 prodotti in top10 a costo margine zero. Decisione del capo.
- **Price cut sui recuperabili**: 3.893 SKU MPF + 41 forzati caduti fuori top10. Gradualità 500-1500 per ciclo.
- **`products.magento_entity_id` è NULL su 8 tenant su 10**: la mappa GA4 ora si ricostruisce da sola (fix 5/8), ma la sorgente vera resta vuota.

---

## Sessione 5/8/2026 — cosa è stato fatto e cosa misurare

| Tenant | Feed prima | Feed dopo | REMOVE | Risparmio teorico/gg |
|---|---|---|---|---|
| MPF | 20.394 | 19.500 | 894 + 9 sottocosto | ~25,47 |
| Papa | 24.939 | **23.509** | 1.124 + 278 + 125 oblio | ~40,2 |
| Farmastelia | 26.738 | **24.371** | 2.039 + 269 + 70 oblio | ~62,4 |

Più l'OBLIO di rete: 450 SKU, 751 REMOVE su 7 tenant, €22,30/giorno.

**Teorico, non reale**: i click TP si rigenerano per rotazione della coda. Il risparmio vero si legge sulla riga piena di domani (cron 05:02), non oggi.

Baseline contro cui misurare — ultima giornata piena, 4/8:

| Tenant | Click | Costo TP | Venduto | Incidenza |
|---|---|---|---|---|
| MPF | 754 | 248,37 | — | — |
| Papa | 466 | 153,50 | 2.525,34 | 6,1% |
| Farmastelia | 626 | 206,20 | 2.513,19 | 8,2% |

Le due domande restano separate: **il costo scende?** e **il fatturato tiene?** Un taglio che abbassa il costo perdendo fatturato non è un risultato.

---

## Nota di metodo

Finché queste regole vivono in un documento e non in una migrazione, il sistema non le applica: le applico io. Ogni riga della sezione 2 è debito — vale finché qualcuno la esegue a mano, e sparisce il giorno che smetto. La sezione 1 è l'unica che gira da sola.
