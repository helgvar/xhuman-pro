# PILOTA MPF — registro operazioni

**Ordine del capo, 4/8/2026 sera:** *"ok inverti l'ordine, tutto quello che fai ora fino a mio nuovo ordine lo fai solo su MPF. salva tutte le operazioni che se funzionano le applichiamo altrove."*

Ogni operazione qui è **per-tenant, accesa solo su MPF** (`d581c087-6b92-4050-b52a-5bd5c087553a`), con interruttore in `health_config`. Nessun altro tenant cambia comportamento: senza il flag, il codice è identico a prima. Estendere altrove = una INSERT. Spegnere = una DELETE.

---

## Baseline MPF prima dell'intervento (4/8/2026, 20:50 ITA)

| Misura | Valore |
|---|---|
| Oggi | 633 click · €208,51 TP · €1.288,52 venduto · **16,2%** |
| 15gg | 10.580 click · €3.485 TP · €29.552 venduto · 11,8% |
| €/click | 2,79 (rete sana: 5,22–6,00) |
| Cap condanne | **249/249 saturo**, 0 su prodotti nel feed |
| Bruciatori bersaglio | 16 SKU · €251,66 costo · −€28,48 margine · €433 fatturato esposto |

---

## OP-1 — Il cap non si brucia più a vuoto
`backend/db/migrations/088_cap_non_si_brucia_a_vuoto.sql` — applicata **4/8 20:47:04 ITA**

**Difetto:** il budget giornaliero di condanne (`GREATEST(150, 1% del feed)`, mig 064) contava le righe scritte senza guardare se lo SKU fosse nel feed. MPF lo consumava al 100% in ri-condanne di prodotti già rimossi: 249 scritte, **0 sul feed**. I tagli veri non trovavano mai budget.

**Cosa fa:** tabella-specchio `feed_stable_sku` del CSV che esce a TP (233.921 codici, 10 tenant), auto-mantenuta da un trigger su `tenant_configs` — nessun servizio Node da toccare. Dove il pilota è acceso, il budget si conta solo sugli SKU davvero nel feed; una condanna su uno SKU già fuori è un no-op tracciato in `basket_veto_log` con suffisso `:NOOP_GIA_FUORI`.

**Soglia invariata** (150 o 1%): non allarga il permesso di condannare. Bypass `sessione_%` del capo intatto.

- Accendere altrove: `INSERT INTO health_config (tenant_id, config_key, config_value) VALUES ('<uuid>','cap_solo_feed','1');`
- Spegnere: `DELETE FROM health_config WHERE config_key='cap_solo_feed' AND tenant_id='<uuid>';`
- **Effetto immediato misurato:** cap MPF da 249/249 a **0/249**.

---

## OP-2 — L2 non assolve più chi vende in perdita
`backend/db/migrations/089_l2_richiede_ripago_pilota_mpf.sql` — applicata **4/8 20:47:09 ITA**

**Difetto:** in `trg_veto_condanna_vendente_fn` l'ordine era (1) mano del capo, (2) **L2 `vende_su_tenant_15g` = veto incondizionato**, (3) L4 `vende_e_ripaga`. L'ordine del capo del 4/8 — *"chi vende e ripaga il click non si tocca"* — era entrato come **scudo in più**, non come **criterio**: chi vendeva senza ripagare non veniva mai giudicato. Un solo ordine comprava 15 giorni di immunità totale. Stessa falla nella clausola seller-15gg di `is_feed_protected` (mig 080), anch'essa binaria.

Caso di scuola, `981647821` MENOPAUSA ACT 30CPR: un ordine da €30 il 26/7, poi 121 click e €39,86 di TP bruciati, **99 condanne respinte dalla guardia e 142 dal cap**.

**Cosa fa:** nuova `vende_ma_brucia_margine(tenant, sku)` — criterio della Bibbia margine-first, `costo_click_15gg > 1,5 × margine_15gg`, con costo VERO (magazzino fisico → prezzo d'acquisto, altrimenti min-cost grossista, **mai il listino**). Dove il pilota è acceso, lo scudo L2 cade per questi. La caduta è tracciata in `azioni_touch_log` con `operazione='scudo_caduto'`.

**Non tocca mai:** brand protetti, pin del capo, carrelli sani, e chi ha meno di 5 click in 15gg.

**Escluso di proposito:** 53 SKU MPF sotto costo con 1-4 click (€1.596 di fatturato, margine −€180). Lì il difetto è il **prezzo**, non il feed: toglierli risparmierebbe €2,26/gg mettendo a rischio €1.596. Vietato da revenue-first — vanno riprezzati.

- Parametri (default se assenti): `l2_ripago_k` = 1.5 · `l2_ripago_click_min` = 5
- Accendere altrove: `INSERT INTO health_config (tenant_id, config_key, config_value) VALUES ('<uuid>','l2_richiede_ripago','1');`
- Spegnere: `DELETE FROM health_config WHERE config_key='l2_richiede_ripago' AND tenant_id='<uuid>';`
- **Effetto atteso:** 16 SKU perdono lo scudo = **€18,68/gg**, €433/15gg di fatturato esposto (in gran parte non-TP, quindi la perdita reale è minore).

### I 16 bersagli

| SKU | Nome | Click 15gg | Costo TP | Margine | Fatturato |
|---|---|---|---|---|---|
| 934424476 | DERMOVITAMINA FILM GEL 30ML | 215 | €70,82 | €3,70 | €11,20 |
| 981647821 | MENOPAUSA ACT 30CPR | 121 | €39,86 | €9,08 | €30,44 |
| 951044421 | SOLUZIONE SCHOUM ADVANCE 500ML | 67 | €22,07 | €2,32 | €37,40 |
| 981212677 | SOMAT SKIN EX PANCIA/FIANCHI | 47 | €15,48 | −€3,72 | €74,88 |
| 984599769 | ALTRAPELLE MEDICAL MICOSI PIEDI | 45 | €14,82 | €0,41 | €6,41 |
| 904104193 | SIDERAL 20CPS | 43 | €14,16 | −€2,25 | €49,02 |
| 982413940 | LIFT SPECIALIST B3 DARK SERUM | 42 | €13,83 | −€1,10 | €31,99 |
| 982013726 | VENOPLANT 40BUST | 42 | €13,83 | €4,53 | €68,49 |
| 971268634 | AUTOTEST VIH SCREENING HIV | 38 | €12,52 | −€22,24 | €23,76 |
| 974109163 | CERAVE CREMA PIEDI RIGENER 88ML | 37 | €12,19 | −€0,17 | €7,65 |
| 930252782 | IRILENS 0,4% GOCCE OCULARI 10ML | 16 | €5,27 | −€0,22 | €9,78 |
| 037087032 | TROSYD DERMATITE SEB SH 120ML | 13 | €4,28 | −€12,54 | €11,18 |
| 936065059 | DERMOVITAMINA CALM CR IDR 250ML | 13 | €4,28 | −€0,17 | €7,10 |
| 984651240 | TRASPIREX CLASSIC 20ML | 10 | €3,29 | €0,20 | €5,26 |
| 974879823 | ULIVIS ESTRATTO FOGLIE ULIVO 1L | 9 | €2,96 | €1,18 | €17,25 |
| 989332895 | AVENE SOL FLUIDO A/ETA SPF50 | 6 | €1,98 | −€7,50 | €41,34 |

---

## ⚠️ LIMITE TROVATO DOPO L'APPLICAZIONE — lo scudo cade, ma i motori non li prendono

Tolto lo scudo, resta la domanda: **quale motore li candida?** Verificato subito dopo l'applicazione.

| Motore | Prende i 16? | Perché |
|---|---|---|
| limaCostante | **2** | `limaCostanteCron.js:53` → `AND COALESCE(p.erp_stock,0) = 0`. Guardia magazzino del capo (24/7): la lima tocca SOLO grossista. |
| vetrina piena | **0** | `refresh_vetrina_piena()` simulata in BEGIN/ROLLBACK: MPF 358 → 379 righe, **nessuno dei 16**. La vetrina richiede zero ordini diretti; i 16 vendono, quindi sono esclusi per costruzione. |
| killer | **0** | richiede zero vendite. |

**Spaccatura dei 16 per stock:**

| Tipo | SKU | Costo 15gg | €/gg |
|---|---|---|---|
| grossista (`erp_stock=0`) | 3 | €17,46 | **€1,16** |
| magazzino fisico (`erp_stock>0`) | 13 | €234,20 | **€15,61** |

**Conseguenza:** dei €18,68/gg di bersaglio, i motori esistenti ne raggiungono **~€1,16/gg**. Gli altri **€15,61/gg (83%)** sono magazzino fisico, che nessun motore può proporre — regola esplicita del capo: *"stock fisico si SPINGE, non si toglie"*.

Non esiste oggi un motore per il caso **"vende + ha magazzino + il click costa più del margine"**. L'inversione L2 lo rende *giudicabile*, ma nessuno lo *giudica*.

**Le tre vie possibili (decisione del capo, nessuna presa):**
1. **Cap click per SKU sul magazzino** — non toglie dal feed, limita la spesa per SKU a `margine_eur/CPC`. Rispetta "mai togliere il magazzino": lo SKU resta, smette solo di bruciare oltre il suo margine.
2. **Deroga lima mirata** — la lima prende anche `erp_stock>0` quando `vende_ma_brucia_margine()`. Sfora la guardia magazzino: **non applicata**.
3. **Lasciarli** — €15,61/gg accettati come costo della presenza a magazzino.

Via 1 è l'unica che non tocca nessuna regola del capo.

---

## Controprove eseguite prima di applicare

| Verifica | Esito |
|---|---|
| Altri tenant col flag acceso | **0** |
| Venditori sani MPF (>€200 in 15gg) ancora protetti | **11 su 11** |
| Papa / Procaccini / Farmastelia / SubitoFarma: venditore campione protetto | **sì, tutti** |
| `981647821` protetto dopo | **no** — scudo caduto, come voluto |
| 363 venditori cliccati MPF (costo €1.317 / margine €1.985) | **intoccati, ripagano** |

---

## Misura

Motori MPF girano **06:00 e 20:00** (REMOVE) e **01/05/16** (quarantena). Il giro delle 20 era già passato all'applicazione: prima misura reale **5/8 dopo le 06:15**.

Cosa guardare:
```sql
-- scudi caduti e condanne passate
SELECT operazione, COUNT(*) FROM azioni_touch_log
WHERE tenant_id='d581c087-6b92-4050-b52a-5bd5c087553a'
  AND touched_at >= '2026-08-04 18:47Z' GROUP BY 1;   -- colonna: touched_at, non created_at
-- rumore ora respinto senza costare budget
SELECT COUNT(*) FROM basket_veto_log WHERE target_table LIKE '%NOOP_GIA_FUORI%';
-- i 16 sono usciti dal CSV?
SELECT COUNT(*) FROM feed_stable_sku WHERE tenant_id='d581c087-6b92-4050-b52a-5bd5c087553a'
  AND sku IN ('934424476','981647821','951044421','981212677','984599769','904104193',
              '982413940','982013726','971268634','974109163','930252782','037087032',
              '936065059','984651240','974879823','989332895');
```

**Criterio di successo (48h):** costo TP MPF giù ≥€18/gg, fatturato non sotto il −1,5% della media stesso-giorno-della-settimana, MOL non peggiore. Se il fatturato cala oltre, spegnere i due flag e ripartire dai numeri.

**Se funziona, si estende** a Farmastelia (9,8%) per prima, poi Farmainsieme (7,0%). Papa, Procaccini, SubitoFarma sono già a 4-5%: lì il guadagno è marginale e il rischio no.

---

## OP-3 — Tagli diretti di sessione (ordine capo 5/8 notte)
Ordine: *"981647821 sta facendo i buchi a terra... quali sono i tagli che stai facendo per abbassare il costo?"*

**402 REMOVE scritte** (writer `sessione_capo_0508_bruciatori`, esilio 7g) = **€25,47/gg**:
- 14 dei 16 bruciatori (€15,46/gg) — inclusi 981647821 e DERMOVITAMINA 934424476
- 388 zero-conv totali (0 vendite locali+rete 15g, grossista, <5 click, non protetti, no carrelli) — €11,49/gg
- Esclusi: `936065059` (pepita manuale del capo) e `981212677` (SOMAT: arbitro protegge PRICE_CUT manual_review in coda — cura giusta, ha €75 fatturato e margine negativo: riprezzo, non taglio)

**✅ MISURATO 4/8 21:25:** stable cache rigenerata alle 21:25 — **tutti i bersagli REMOVE fuori dal CSV** (0/468 ancora dentro, tra dispatched e pending). **981647821 fuori dal feed.** Dimensione feed MPF pubblicato: **25.001 → 24.478 (−523)** al giro cache successivo (~22:20) — i tagli sono nel CSV che TP prenderà al prossimo refresh (ogni 4h da 00:00 ITA). Il monitor aveva segnato "1 SKU rilasciato tornato bloccato" su MPF: era il nostro stesso writer di sessione che ricondannava un rilasciato — mig 090 per progetto, non anomalia. Le guardie continuano a vetare i venditori che RIPAGANO (47 veti/ora): comportamento corretto post-090, cade lo scudo solo a chi brucia.

## OP-4 — mig 090: TUTTI gli scudi cadono per chi brucia (5/8 notte)
`backend/db/migrations/090_scudi_cadono_se_brucia_pilota_mpf.sql` — applicata

**Difetto (ordine capo: "se il cap non lo ferma va corretto... ci saranno altri prodotti nella stessa condizione"):** la 089 aveva corretto UNO scudo, ma la catena ne aveva altri TRE, tutti binari:
1. **L4 ripaga-30gg a incidenza** (mig 085): contraddice finestre-15gg e margine-first (chi vende sotto costo "ripaga" per incidenza). Fermava 904104193, 989332895.
2. **L2-rete pos≤10** (mig 060/061): fermava proprio 981647821 (pos 1).
3. **Carve-out STOCK e TOP10** in `is_feed_protected`: fermavano 934424476, 984599769, 984651240 (silenziosi, via basket guard → `basket_veto_log`).

**Cosa fa:** principio unico dove `l2_richiede_ripago=1` — chi `vende_ma_brucia_margine()` perde OGNI scudo. Intoccabili restano solo le classi nominate dal capo: brand protetti, pin, carrelli sani, più la guardia freschezza dati (12h). Ogni caduta tracciata (`scudo_caduto` con lo scudo specifico).
- Stesso interruttore della 089: nessun flag nuovo. Spegnere tutto: `DELETE FROM health_config WHERE config_key='l2_richiede_ripago';`

## OP-5 — Lima PASS 1-bis "brucia-margine" (motore, 5/8 notte)
`backend/services/limaCostanteCron.js` — nuovo passaggio dopo PASS 1.

**Difetto:** nessun motore candidava i "vende ma brucia" — scudo caduto (089/090) restava a effetto zero senza mano umana: la lima esclude i venditori per costruzione, la vetrina richiede zero ordini, il killer zero vendite.

**Cosa fa:** sui tenant col pilota acceso, candida REMOVE (esilio 7g) chi: nel CSV + `vende_su_tenant_15g` + `vende_ma_brucia_margine()`, ordinati per click, max 80/tenant/giorno. Writer motore `lima_brucia_margine`, source `pulizia_brucia_margine` (classe preservata `pulizia_%`): **il cap-anti-strage governa**, a differenza dei tagli di sessione. Gira alle 06:15 ITA.

## OP-6 — mig 091 + taglio di massa "click senza vendite" (ordine capo 5/8)
Ordine: *"bisogna tagliare!! non possiamo spendere 200€ al giorno per 25 ordini... annulla tutti i veti che hai sul taglio prodotti ad esclusione di quelli brand"*

### Mappa MPF — tutto ciò che riceve click nel feed (15gg, 1.431 SKU, €2.048 = €136,55/gg)
| Classe | SKU | €/gg | Fatturato 15gg | Margine 15gg | Esito |
|---|---|---|---|---|---|
| A. Brand protetto | 205 | 39,23 | 4.310 | 1.786 | **veto del capo, intatto** |
| B. Pin del capo | 54 | 5,85 | 384 | 131 | intatto (ordini suoi) |
| C. Porta carrelli sani | 258 | 39,90 | 10.751 | 2.320 | intatto (incidenza 5,6%: ripaga) |
| D. Vende qui e ripaga | 18 | 1,34 | 485 | 141 | intatto |
| E. Vende qui ma brucia | 2 | 1,27 | 67 | 11 | **NON tagliato** (hanno PRICE_CUT in coda: la cura è il prezzo) |
| F. Vende in rete non qui, 5+ click | 76 | 16,68 | 0 | 0 | **TAGLIATO** |
| G. Vende in rete non qui, <5 click | 531 | 17,58 | 0 | 0 | **TAGLIATO** |
| H. Zero ovunque, 5+ click | 26 | 6,39 | 0 | 0 | **TAGLIATO** |
| I. Zero ovunque, coda lunga | 261 | 8,32 | 0 | 0 | **TAGLIATO** |

### mig 091 `091_mano_capo_annulla_veti_tranne_brand.sql` — applicata
Prima: `capo_%` scavalcava già guardia venditore (087) e ri-condanna (086), ma **non** `trg_veto_basket_fn` (is_feed_protected: carrelli, pin, stock, top10, seller, coorti) né `trg_cap_condanne_fn` (bypass solo `sessione_%`: un taglio di massa firmato capo si sarebbe fermato a ~250 righe).
Dopo: sulle REMOVE firmate `capo_%`/`manual%` resta **un solo veto, il brand**, più la guardia freschezza dati 12h (legge del capo, non scudo di prodotto). Ogni scavalco a verbale (`override_veto`). I motori automatici non cambiano di una virgola.

### Taglio eseguito (writer `capo_taglio_massivo_0508`, source `capo_taglio_click_zero_vendite`)
- Criterio: nel CSV + click 15gg > 0 + **zero vendite locali 15gg** + non brand + non carrelli sani + non pin.
- **894 bersagli → 887 REMOVE scritte** (esilio 7g). Le 7 mancanti sono PRICE_CUT `manual_pepita` già dispatched del capo (€0,24/gg totali): l'arbitro le protegge, corretto.
- Zero veti scattati: nessun brand nel mucchio, nessun dato stantio.

### 🔴 CORREZIONE — 93 SKU rimessi dentro (il taglio era in parte sbagliato)
Il capo ha contestato il criterio (*"vende 67€, ha sprecato 1,27 e lo stacchi?"*). Controllo a valle: **173 dei tagliati RIPAGAVANO il click 16-30 giorni fa** (€966 di margine per €130 di click, 7,4×). Segmentati per stock e volume click:

| Segmento | SKU | €/gg | Margine prodotto 16-30gg | Decisione |
|---|---|---|---|---|
| Stock ok, **<15 click** in 15gg | 93 | 8,64 | **€487,73** | 🔙 **RIENTRANO** |
| Stock ok, 15+ click, zero vendite | 13 | 12,74 | €95,82 | resta tagliato (verdetto solido) |
| Stock ZERO (non può vendere) | 67 | 4,83 | €382,60 | resta tagliato (serve restock, non feed) |

⭐ **L'errore: giudicare 15 giorni di zero vendite su 4 click.** Con ~4 click in 15gg e conversione ~5%, l'attesa matematica è 0,2 vendite: **zero è il risultato più probabile anche per un prodotto sano**. Il criterio "zero vendite 15gg" vale solo sopra una soglia di click che renda il verdetto significativo. Rinunciare a €8,64/gg di click per mettere a rischio €487/15gg (€32/gg) di margine è uno scambio pessimo. `capo_correzione_0508_rumore`, 93 DELETE.

### Proiezione misurata sui click di OGGI (633 click / €208,51) — dopo la correzione
| | SKU | Click oggi | Costo oggi |
|---|---|---|---|
| Tagliato stanotte (401 + 794) | 207 | 276 | **€90,91** |
| Resta nel feed | 189 | 357 | €117,60 |

**−44% del costo click MPF.** A fatturato invariato: incidenza 16,0% → **~9,0%**. Fatturato locale a rischio diretto: **zero** — tutti i tagliati hanno 0 vendite su MPF in 15gg, e i lenti-ma-sani sono rientrati.
Serie giornaliera MPF per il confronto: 4/8 €208 · 3/8 €280 · 2/8 €187 · 1/8 €212 · 31/7 €242 · 30/7 €218 · 29/7 €274 · 28/7 €287.

**Uscita dal CSV alle 22:26 — poi ANNULLATA (vedi sotto).** Il feed era sceso 25.001 → 23.591 (−1.410), ma alle 22:44 la rigenerazione successiva ha rimesso dentro tutti gli 894.

### 🪤 IL TAGLIO È EVAPORATO DOPO 7 SECONDI — causa e riparazione (4/8 22:50)

`feedDailyEngine.js:1602` all'inizio di ogni ricalcolo cancella tutte le `feed_actions` del tenant tranne una whitelist ristretta **e i source che iniziano per `pulizia_`**:

```sql
DELETE FROM feed_actions WHERE tenant_id = $1
  AND (action_source IS NULL
       OR (action_source NOT IN ('manual_pepita','margin_harvest_pilot','manual_review',
                                 'muro_scavalco','manual','capo_pin')
           AND action_source NOT LIKE 'pulizia_%')
       OR expires_at < NOW())
```

Il taglio era firmato `capo_taglio_click_zero_vendite`: fuori whitelist, senza prefisso. Scritto alle **20:20:18 UTC**, il motore è partito alle **20:20:25** (7 secondi dopo) e ha cancellato tutte e 894 le righe. Anche i 401 di `sessione_capo` sono spariti. Nessun errore, nessun alert: il CSV delle 22:44 aveva **894/894 tagliati di nuovo dentro** e la spesa click era ripartita.

⭐ La firma dell'Arbitro (`xhp.writer='capo_%'`) **non protegge da questo**: governa i veti alla scrittura, non la DELETE del rerun. Era già successo il 14/7 (520 REMOVE della pulizia classe A spazzati) — il commento a riga 1607 lo dice, e la toppa di allora fu proprio il prefisso `pulizia_%`. Infatti `pulizia_classeA_14lug` (268), `pulizia_lima_costante` (137) e `pulizia_vetrina_piena` (82) sono ancora in piedi.

**Riparazione — `pulizia_capo_taglio_0508`, 4/8 22:52:** taglio riscritto con lo stesso criterio già corretto (esclusi brand protetti, carrelli sani, pin, e chi ripagava il click 16-30gg fa con stock e <15 click), source col prefisso che sopravvive.

| | SKU | Click 15gg | Costo |
|---|---|---|---|
| Bersagli | 1.178 | 2.354 | **€51,76/gg** |
| Scritti | 1.172 | | €51,57/gg |

6 respinti dall'arbitro (righe manuali protette). Il set è più grande dei 794 di prima perché ingloba anche i 401 di `sessione_capo`, spazzati dallo stesso rerun. L'INSERT del motore è `ON CONFLICT DO NOTHING` (riga 1593): ora le righe sopravvissute **vincono** sul ricalcolo.

⚠️ **Regola operativa nuova:** ogni `feed_actions` scritta a mano deve avere `action_source` che inizia per `pulizia_`, e va **ricontrollata dopo il primo rerun del motore** — mai dare per fatto un taglio appena scritto.

**✅ USCITA DAL CSV CONFERMATA — cache MPF rigenerata 4/8 22:56 ITA:** feed **24.896 → 23.724 (−1.172)**, `tagliati_ancora_dentro = 0`. Restano nel CSV, tra i cliccati-senza-vendite, solo le tre classi volute: 135 brand protetti (€14,05/gg, veto del capo), 162 salvati dal filtro anti-rumore + pin (€12,78/gg), 13 che portano carrelli sani (€1,03/gg).

### 🔬 Verifica del campione sul taglio v2 — coorte, e 50 rilasciati rimessi dentro

L'alert `RICONDANNA MPF 18 SKU` ha spinto il controllo: **236 dei tagliati erano stati riattivati di recente**. Due domande, due risposte diverse.

**1) Il campione del singolo regge?** No, per la stragrande maggioranza:

| Fascia click 15gg | SKU | €/gg |
|---|---|---|
| 15+ (verdetto solido) | 16 | 9,16 |
| 8-14 (borderline) | 23 | 5,07 |
| **<8 (campione debole)** | **1.133** | **37,33** |

Ma il campione è il **numero di click**, non i giorni — e sotto soglia il singolo non si giudica, **la coorte sì**: i 1.087 residui con <8 click a testa sommano **1.616 click** in 15 giorni. A conversione 5% l'attesa è **81 vendite**. Reali: **ZERO**. Dove ogni verdetto individuale sarebbe nullo, quello di gruppo è schiacciante — ed è il trattamento aggregato che la coda lunga richiede. La coorte è già ripulita da brand, carrelli, pin e da chi ripagava prima: si condanna il residuo, non il grezzo.

**2) Hanno avuto il tempo di provarsi?** 50 no: rilasciati da meno di 7 giorni, non hanno finito il test (dottrina esilio 7gg + test 3gg). Condannarli è *churn*, non giudizio, e brucia la macchina di riattivazione che li aveva liberati — è esattamente ciò che l'alert stava segnalando. **Rimessi dentro** (`capo_correzione_0508_finestra_test`, €4,90/gg), si ri-valutano a finestra piena. I 186 rilasciati da 7-15gg restano tagliati: i loro click sono maturati tutti dentro il feed, il campione è valido.

**Taglio finale: 1.119 SKU · 2.118 click/15gg · €46,58/gg.**

### ✅ PROVA DEL FUOCO — rerun del motore forzato, il taglio ha retto

Non aspettato il giro delle 06: motore forzato a mano su MPF via `POST /api/onboarding/:tenantId/run` con `{"steps":["feed"]}` (dentro il container niente `curl` e `localhost` rifiuta: usare `wget` su `127.0.0.1:3001`).

- **21:05:51 → 21:06:07 UTC** — engine completo: `REMOVE 356 · KEEP 680 · PRICE_CUT 72 · MONITOR 1.101 · ADD 0`, incidenza calcolata 8,9%, 96 killer.
- **Dopo il rerun: `pulizia_capo_taglio_0508` = 1.122 righe intatte, €46,67/gg.** Il DELETE di pulizia ha toccato solo roba sua (`zero_click_demand` 3, `convertitore_costoso` 1). **Sopravvivenza dimostrata sul campo, non per lettura del codice.**
- Cache stabile forzata alle 21:06:41 UTC: feed **23.759**, `tagliati_ancora_dentro = 0`.

**Trappola nella trappola:** la verifica dei 50 rilasciati fatta via `azioni_touch_log` dava `rientrati = 0` — falso. Il log delle DELETE è **parziale** (la correzione da 93 righe ne aveva loggate 2). Verificato per **lista SKU** su `feed_stable_sku`: dei 53 rilasciati da <7gg, **46 sono nel CSV**, 4 restano fuori per motivi propri (filtro strict / stock), 3 erano stati liberati nell'ultima ora e sono finiti nel taglio dopo la correzione — tolti anche quelli. Regola: **dopo una DELETE si verifica per lista SKU, mai dal touch log.**

**Blindatura nel codice (commit 8841772, NON ancora deployata):** `feedDailyEngine.js` conserva ora anche ogni `action_source LIKE 'capo\_%'`. La mano del capo non deve dipendere dal ricordarsi un prefisso. Deploy al prossimo momento senza cicli in volo (`docker cp` + `docker restart`); fino ad allora regge il prefisso `pulizia_`.

⚠️ **Da rivedere entro 7 giorni:** i 607 SKU delle classi F+G (€34,26/gg) **vendono in rete ma non su MPF**. Regola del capo: sono candidati **PC riposizionamento**, non morti. L'esilio è a 7 giorni proprio per questo: se il riposizionamento prezzo li rende competitivi, rientrano.

## Non fatto, in attesa di ordine

- Taglio pulito 3.721 SKU rete (€114/gg) — zero vendite locali e rete 15gg, stock 0, nel CSV, non protetti. Ora **sbloccato** su MPF dalla OP-1 (415 SKU / €11 gg).
- Cap click per SKU sul magazzino fisico MPF (1.118 SKU, ~€62/gg) — sfora "mai togliere il magazzino", decisione del capo.
- Riprezzare i 53 SKU sotto costo con pochi click (€1.596 di fatturato a margine −€180).
- Riattivare GA4 (`ga4_channel_daily` vuota su tutta la rete): senza, la conversione del sito MPF resta non misurabile.
