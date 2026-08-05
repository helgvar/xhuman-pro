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

---

## 5/8 — Ordine capo: "feed sotto 20.000, tagli tra i burner, brand fermi, stock 0 fuori dalle logiche"

### Rotta corretta in corsa
Primo tentativo sbagliato: taglio di Pareto sulla **coda inerte** (8.607 SKU: zero click 90gg, zero vendite in tutta la rete, stock 0). Feed sceso a 15.157 — ma il capo ha fermato la mano: *"gli inerti li puoi anche lasciare se non portano click, i prodotti 0 stock eliminali dalle logiche, i tagli li devi trovare tra i burner"*. **Rollback completo** (`capo_rollback_pareto_0508`, 8.607 REMOVE cancellate). Ragione: quella coda **non costa un centesimo** — nessun click, nessuna spesa. Tagliarla accorcia un numero, non una bolletta.

### Fotografia di Pareto su MPF (90gg)
| Fascia | SKU | Fatturato |
|---|---|---|
| A — fa l'80% del fatturato | 1.174 | €123.076 |
| B — 80→95% | 1.208 | €23.074 |
| C — coda 5% | 1.083 | €7.700 |
| **Totale che vende** | **3.465** | **€153.850** |

### Il taglio vero: i burner (`pulizia_burner_0508`)
Materia ammessa: **solo chi riceve click, ha stock fisico, non è brand**. Criterio margine-first: il margine vero di 90gg non copre il costo dei click.

| Tipo | SKU | Click 90gg | €/gg | Fatt 90gg | Margine 90gg | Perdita/gg fermata |
|---|---|---|---|---|---|---|
| brucia_margine | 60 | 3.051 | 11,17 | €2.136 | €398 | 6,74 |
| burner_puro | 289 | 742 | 2,72 | €0 | €0 | 2,72 |
| **Totale** | **347** scritte (349 bersagli) | 3.793 | **13,89** | | | **9,46** |

Esclusi per costruzione: brand protetti, stock 0, pin del capo, carrelli sani, rilasciati da meno di 7 giorni.

### Perché il feed resta a 23.418 e non scende sotto 20.000
Il conto non torna e va detto: **la massa del feed non è fatta di burner**.

| Massa | SKU |
|---|---|
| riceve click (unica materia da burner) | ~1.400 |
| muto da 90gg **con** stock fisico | 2.149 |
| muto da 90gg **senza** stock (costo zero) | ~19.800 |

Anche tagliando **ogni singolo SKU cliccato** — sani e brand compresi — il feed si fermerebbe intorno a **22.000**. Sotto 20.000 ci si arriva **solo** toccando la coda muta a stock 0, cioè esattamente ciò che l'ordine mette fuori dalle logiche. È una scelta di forma (feed corto) senza effetto sul costo: quella coda non genera click.

### Dove sta il costo che resta (click 15gg dentro il feed, €95/gg)
| Chi | SKU | €/gg |
|---|---|---|
| brand protetti (intoccabili per ordine) | 205 | **39,23** |
| sani: ripagano | 150 | 25,20 |
| residuo giustificato (30 carrelli sani, 51 pin del capo, 84 che ripagano su 90gg) | 169 | 22,52 |
| stock 0 (fuori dalle logiche per ordine) | 126 | 8,31 |

Il primo blocco di spesa ora sono **i brand protetti: €39,23/gg, il 41% di tutto il costo click residuo**. Finché restano fermi, il costo TP di MPF non scende oltre.

---

## 5/8 — FEED SOTTO I 20.000: la leva era già in casa, spenta

**Ordine capo:** *"i brand lasciali stare, taglia tutto quello che puoi, il feed deve scendere sotto i 20000 senza tagliare vendite"* + *"i tagli li devi trovare tra i burner"*.

I burner si erano esauriti a ~450 SKU: tagliando SKU per SKU non si arriva sotto 20.000 senza toccare roba che vende. La strada era un'altra.

### Il Feed Cap esisteva già — ed era spento

`externalApi.js` Module 2: un tetto alla dimensione del feed applicato **in fase di export** verso Farmabooster. Su MPF: `feed_cap_enabled: false`, `feed_cap_max: 25000`. Mai acceso.

Due difetti che lo rendevano inutilizzabile così com'era:

1. **Ordinava con dati vietati.** `priority = tp_attributed_orders*10 + tp_attributed_revenue*0.01 + health_score`. Il TP-attributed è escluso dalla dottrina: l'unica verità sulle vendite sono gli ordini reali Magento. Su MPF solo 5.231 righe su 93.506 hanno tp_attributed valorizzato — il resto ordinava di fatto per solo `health_score`.
2. **Non conosceva i brand protetti.** A 20.000, la vecchia formula lasciava fuori **30 brand protetti**. Contro l'ordine del capo.

### Patch dell'ordinamento (margine-first)

```
1. brand protetti          +1.000.000   -> non escono MAI per cap
2. pin del capo              +500.000   -> prima classe protetta
3. ordini reali Magento 90gg    x100
4. fatturato reale 90gg         x0,1
5. stock fisico in farmacia       +50   -> regola aurea: spingere il magazzino
6. health_score                        -> spareggio
```

Deploy: `node --check` OK, `docker cp`, grep verificato, restart, `/api/health` = ok.

### Acceso a 19.500

`feed_cap_max = 19500`, `feed_cap_enabled = true`, writer `capo_feedcap_0508`.

```
[FeedCap][T:d581c087] Cap 19500: 3918 products below threshold
[FeedStable][T:d581c087] Saved: 19500 civetta=1, 10034 civetta=0, 45 price cuts
```

**Feed MPF: 25.001 → 23.418 (tagli) → 19.500.** Ordine eseguito.

### Verifica: cosa è uscito col cap

| controllo | esito |
|---|---|
| brand protetti fuori dal feed | **0** su 432 |
| SKU usciti col cap che vendono su MPF 90gg | **0** |
| fatturato MPF a rischio | **€0** |
| click che consumavano i 3.918 (15gg) | **4** — €0,09/gg |

I 15 SKU venditori usciti stanotte sono usciti tutti per i tagli espliciti (`pulizia_capo_taglio_0508`, `pulizia_burner_0508`), **nessuno per il cap**. Verificato SKU per SKU.

### Cosa il cap NON fa

Non abbatte la spesa domani: quei 3.918 erano già muti (€0,09/gg). Il cap serve a **ridurre la superficie di rotazione** — vedi sotto.

### Perché €208 in un giorno se i bruciatori sono finiti: la rigenerazione

Misura sui 7 giorni: **917 SKU mai cliccati nei 30 giorni precedenti sono entrati in rotazione**, €445,76 (€63,68/gg), **36 hanno venduto** (il 3,9%). Ogni nuovo entrante si prende ~1,5 click (~€0,49): sotto qualunque soglia individuale, invisibile a ogni motore che giudica SKU per SKU.

Provenienza dei 917:

| origine | SKU | €/gg |
|---|---|---|
| stock fisico in farmacia | 369 | 31,86 |
| stock 0 ma vendono in rete | 433 | 26,02 |
| coda morta mai venduta | 93 | 4,71 |
| coda morta oltre 180gg | 22 | 1,08 |

Tagliare SKU per SKU è guerra di trincea: ne togli 350, ne entrano 900. **Il costo non sta in un blocco di prodotti-spazzatura da rimuovere: sta nella dimensione del feed stesso**, perché ogni SKU dentro prima o poi si prende il suo assaggio di click.

### Struttura del residuo (€95/gg) per fascia di margine unitario vero

| fascia | SKU | €/gg |
|---|---|---|
| margine ZERO o negativo | 11 | 2,04 |
| margine < 1 click (0,33) | 367 | 0,00 |
| margine < 3 click (1,00) | 3.128 | 2,97 |
| margine 1-3 € | 13.768 | 37,42 |
| margine ≥ 3 € | 6.144 | 52,83 |

**Il 95% della spesa residua la fanno prodotti con margine sufficiente a ripagare i click.** Non è spazzatura che brucia: è merce sana che non converte. Il problema è a valle del click — coerente col verdetto 4/8 sulla conversione dimezzata.

Eccezione da chiudere: **11 SKU con margine ≤ 0** che consumano €2,04/gg — vendono in perdita e pagano pure i click.

---

## 5/8 — I 90 CHE VENDONO IN RETE: test 3 giorni, e la scoperta della spedizione

**Ordine capo:** *"riposiziona i 91 esclusi per 3gg se non vendono stacchi"*.

Sono i 90 SKU (91 al primo conteggio, uno era già rientrato) che stanotte erano nel taglio, hanno consumato click oggi, e **vendono in rete: €4.331,90 in 15 giorni** su altre farmacie. Su MPF, zero.

### Il riposizionamento non aveva materia — e il perché è grosso

Primo calcolo, sul prezzo prodotto: 81 su 90 hanno già **il prezzo più basso**. Il "taglio" per allinearsi al mercato sarebbe stato un **rialzo del 14,7%**.

Sembrava assurdo. Poi il confronto con quello che TP mostra davvero:

| SKU | prodotto | nostro prezzo | prezzo su TP | pos |
|---|---|---|---|---|
| 980247860 | XIPAG 20CPR | 22,74 | **28,64** | 13 |
| 987309679 | PEGBIOMA 30BUST | 15,91 | **20,80** | 3 |
| 906618994 | KILOCAL 20CPR | 10,29 | **16,19** | 17 |
| 971676679 | FLEBINEC PLUS 14BUST | 13,49 | **19,72** | 10 |

**+5,90 su ogni riga. È la spedizione**, e `total_price` la include: TP ordina le offerte sul totale, non sul prezzo prodotto.

Rifatto il conto sul totale, sui 90:

| | MPF | miglior concorrente esterno |
|---|---|---|
| prezzo prodotto | 15,46 | 14,24 |
| spedizione | **5,90** | — |
| **totale** | **21,36** | **16,94** |
| posizione media | 6,7 | — |

- volte che MPF ha il prezzo prodotto più basso: **15 su 90**
- volte che MPF vince **sul totale**: **0 su 90**

Per battere il mercato dovrebbe scendere a €11,00 di prezzo prodotto, ma il pavimento (costo + ricarico minimo di fascia) è €14,72. **89 su 90 non sono riposizionabili: il margine è già finito.** Il gap non è di prezzo, è di spedizione.

### La spedizione in tutta la rete (scraper 48h)

| farmacia | spedizione media | offerte gratis | volte prima |
|---|---|---|---|
| San Vito | 4,76 | 1.943 | 2.754 |
| Procaccini | 4,76 | 608 | 2.951 |
| Farmastelia | 4,80 | 548 | 2.500 |
| Papa | 4,99 | 0 | 1.467 |
| **MPF** | **5,82** | **256** | **906** |
| SubitoFarma | 5,90 | 0 | 3.149 |
| Ospedale / Farmainsieme | 6,81 | 20 / 108 | 93 / 155 |

E i grandi concorrenti: 1000 Farmacie €3,47 (18.578 offerte gratis), Farma.it **€0,00 su tutte e 60.179**, Redcare €2,70, Top Farmacia €3,12.

**MPF paga €5,82 di spedizione in un mercato che sta tra €0 e €4,80.** Su ogni singola offerta parte con 1-2 euro di svantaggio che nessun taglio prezzo può recuperare, perché il margine per quel taglio non c'è.

Questa è una spiegazione candidata per la conversione dimezzata di MPF (verdetto 4/8: *"causa a valle del click"*): il cliente clicca sul prezzo prodotto, arriva sul sito e trova €5,90 di spedizione.

### Cosa è stato fatto

- 90 SKU tolti dal taglio, rientrati nel feed (85 nel CSV, 5 hanno stock 0 e restano fuori a norma)
- `action='KEEP'`, `action_source='pulizia_test_riposiz_0508'`, **scadenza 7/8 21:57**
- 1 solo riposizionamento prezzo possibile nel rispetto del floor, scritto come PRICE_CUT
- verifica al terzo giorno: chi non ha venduto viene staccato (`pulizia_stacco_test_0508`)

Costo del test: ~€38,54/gg × 3 = **~€116**.

### Da decidere (non è materia di feed)

La leva sulla spedizione vale su tutte le 19.750 offerte MPF, non sui 90 SKU. Portarla da €5,82 a €4,76 (il livello di San Vito e Procaccini, dentro la stessa rete) sposta ogni offerta di un euro sul totale — che è la grandezza su cui TP ordina. Non è una decisione del feed: è del cliente.

---

## 5/8 (notte) — Prima notte a 19.500: zero vendite perse, e l'allarme "ricondanne" è un falso positivo

Il feed ha passato la notte a **19.500** (era 24.916). Prima verifica il mattino dopo, sui numeri e non sulle intenzioni.

### Il taglio ha tolto vendite?

Ordini MPF di ieri su SKU che oggi **non** sono nel CSV: 7 ordini, 9 righe, **€203,48**. A prima vista sembra il danno. Ma guardando SKU per SKU:

| SKU | prodotto | fatturato | civetta | stock |
|---|---|---|---|---|
| 970489593 | COLILEN IBS 96OPR | 51,62 | **false** | 0 |
| 951507817 | POLASE PLUS CARNITINA | 42,24 | **false** | 0 |
| 022816122 | SOMATOLINE GEL 30BUST | 41,45 | **false** | 4 |
| 987400330 | IRILENTI PLUS 360ML | 29,90 | **false** | 0 |
| 920891759 | IDEAL SOLEIL DOPOSOLE | 15,88 | **false** | 0 |
| 040313049 | TACHIPIRINA OROSOL | 13,38 | **false** | 19 |
| 012745067 | TACHIPIRINA AD SUPP | 5,61 | **false** | 22 |
| 982509693 | ORALB PROF SENS | 3,40 | **false** | 0 |

**Tutti `is_civetta = false`: nessuno di questi è mai stato nel feed.** Non escono su Trovaprezzi né prima né dopo il taglio — quel fatturato arriva da altri canali. Sugli SKU con REMOVE attiva (i tagli del 5/8): **zero ordini, €0**.

Il taglio da 24.916 a 19.500 non ha tolto una sola vendita.

### L'allarme "MPF 22 SKU rilasciati sono tornati BLOCCATI"

Si ripete a ogni ciclo dal 4/8. Classificati tutti i 148 rilasciati che non sono nel CSV:

| Causa | SKU | È un problema? |
|---|---|---|
| stock 0 | 63 | no — TP li esclude comunque |
| prezzo 0 | 12 | no — non esportabili |
| `is_civetta=false` | 9 | no — mai stati eleggibili |
| sotto costo | 2 | no — giusto che stiano fuori |
| REMOVE `pulizia_burner_0508` | 32 | condanna legittima |
| REMOVE `pulizia_capo_taglio_0508` | 9 | condanna legittima |
| REMOVE `pulizia_vetrina_piena` | 3 | condanna legittima |
| fuori per il cap | 18 | legittimo |

**86 su 148 non sono condanne affatto**: sono SKU che la quarantena ha rilasciato ma che il feed non può esportare comunque. Il monitor conta "rilasciato e non nel CSV" e chiama tutto ricondanna.

Il dato che conta: **rilasciati da meno di 7 giorni colpiti = 0**, su tutte e quattro le categorie. Il periodo di grazia regge, e la patch `in_test` sul cap (commit `873bdbe`) fa il suo lavoro — nessuno degli SKU in test viene spinto fuori.

Due casi guardati a mano perché sembravano contraddittori:

- **TROSYD DERMATITE SEB SH120ML** (`037087032`): rilasciato alle 04:01, ricondannato subito da `pulizia_brucia_margine`. Prezzo €5,59 contro un costo di €11,35 — **vende sotto costo di €5,76**. La condanna è corretta; è uno degli 11 SKU a margine ≤ 0 già segnalati. Il rilascio dalla quarantena non deve poter rimettere dentro un prodotto in perdita.
- **POLASE ARANCIA 24BUST PROMO** (`987437249`): stock 24, prezzo €9,36, costo €7,61, margine sano. È fuori perché `is_civetta = false` — Farmabooster non lo marca civetta, quindi il feed non lo può prendere. Non era un killer né una quarantena: era una domanda mal posta.

---

## 5/8 — "Il civetta di Farmabooster è un'indicazione. Il feed lo decidi tu."

Ordine del capo, che ribalta un'assunzione che stavo usando come muro:

> *"quello che Farmabooster salva come civetta true o false è solo un'indicazione per te. Il feed lo decidi tu mandando a Farmabooster civetta true e price_cut. Se ci sono prodotti che vendono bene e sono posizionabili sei tu che li devi forzare con il tuo civetta."*

Stamattina avevo archiviato POLASE come "fuori perché `is_civetta=false`, non è un bug". Sbagliato: `is_civetta` è l'eco delle nostre decisioni passate, non un verdetto. Il canale per forzare esiste già (`feed_actions.action='ADD'` → `/feed/civetta` con `civetta=1`) ed era aperto: la pausa scraper è a 0 e il dato è fresco (1,5 milioni di righe nelle ultime 48h).

### Il bacino, misurato sul totale e non sul prezzo prodotto

Fuori dal feed, con stock **fisico** e prezzo valido: **4.094 SKU**. Di questi, posizionabili nei primi 10 **sul totale** (prezzo + spedizione, la grandezza su cui TP ordina) e con ricarico ≥ 15%: **1.432**.

| | SKU | fatturato rete 30gg |
|---|---|---|
| mai venduti in rete, FB dice civetta | 1.049 | — |
| mai venduti in rete, FB dice NO | 187 | — |
| **vendono in rete**, FB dice civetta | 177 | 8.750 |
| **vendono in rete**, FB dice NO | 19 | 713 |

### Ondata 1: 240 forzati, quelli con la prova in mano

Criteri, tutti insieme: fuori dal feed, stock fisico > 0, ricarico ≥ 15% sul costo vero, **primi 10 sul totale**, prova di vendita (rete 30gg o MPF 90gg), e non già bruciato (click 30gg × CPC < margine × 1,5).

**240 SKU** — 164 vendono in rete (€7.612/30gg), 108 hanno venduto su MPF (€4.056/90gg). Margine medio €4,76, posizione attesa media **5,3**. Scritti come `ADD`, `action_source='pulizia_forza_civetta_0508'`.

Due ostacoli trovati per strada:

1. **Il cap li avrebbe espulsi subito.** La priorità premiava le vendite locali: uno SKU che vende in rete ma non ancora su MPF aveva punteggio da ultimo della fila, e sarebbe uscito dal fondo della lista lo stesso giorno in cui l'avevamo forzato dentro. Aggiunti due termini: ADD deliberato (+300.000, sotto i pin e sopra il test) e **fatturato di rete 30gg × 0,05**. La prova di domanda su un altro tenant vale meno del venduto locale, ma più di uno score.

2. **100 erano in quarantena, e la quarantena batte l'ADD.** Il ramo `action='ADD'` nella costruzione del feed richiede `fq.id IS NULL`. Liberati 114 (la dottrina è chiara: *la quarantena non è per sempre, chi ricomincia a vendere esce subito*). Restano **5** bloccati: sono `is_burner_rule`, e i due veti di rilascio hanno porte incompatibili — `veto_release_burner_rule` lascia passare solo `xhp.writer LIKE 'capo_%'`, `veto_release_incidenza_alta` solo `sessione_%`. Nessun writer li soddisfa entrambi. Cinque SKU non valgono una migrazione; la incoerenza resta annotata.

### Risultato

**235 dei 240 nel CSV**, feed fermo a **19.500** (sotto il tetto dei 20.000 ordinato dal capo). Il cap ha fatto lo scambio da solo: sono entrati i 235 con prova di vendita e margine, sono usciti altrettanti dalla coda muta.

Venditori 30gg ancora fuori dal feed: 211, ma **147 hanno stock 0** — non esportabili in nessun caso. Quelli con magazzino fisico ancora fuori sono 64.

Restano 1.192 posizionabili senza prova di vendita (mai venduti né qui né in rete). Sono la seconda ondata, dopo aver misurato 24-48h questa — gradualità, non a botto.

### Scaglione 2: i primi in classifica che nessuno aveva mai messo in vetrina

Restavano 1.013 SKU posizionabili con stock fisico e ricarico ≥15% che **non hanno mai venduto** — né su MPF né in rete, in 90 giorni. Segmentati per posizione attesa sul totale:

| Posizione attesa | SKU | margine medio | click che il margine ripaga |
|---|---|---|---|
| **primo sul totale** | 96 | 8,03 | 24 |
| podio (2-3) | 395 | 6,14 | 18 |
| 4-6 | 277 | 4,78 | 14 |
| 7-10 | 245 | 3,71 | 11 |

Di questi ne ho presi **53**: solo i primi in classifica, con margine ≥ €3 e ricarico ≤ 300% (sopra quella soglia il costo è sporco, non è una pepita — PUMILENE VAPO risultava a €0,61 di costo contro €41,99 di prezzo).

Tra loro la linea BAKEL: **€131,39 di margine** su THE ONE CASE&REFILL, €66,85 su cinque referenze, tutte primo o secondo posto sul totale, con stock in farmacia. Mai state nel feed. Un prodotto con €131 di margine regge 398 click prima di bruciarlo: il budget click per SKU li ferma da soli se non convertono.

Totale forzati: **293**, di cui **279 nel CSV**. Feed sempre a 19.500.

### La misura, per non raccontarsela

Baseline MPF, 8 giorni prima del taglio:

| giorno | click | costo |
|---|---|---|
| 4/8 | 754 | 248,37 |
| 3/8 | 849 | 279,66 |
| 2/8 | 569 | 187,43 |
| 1/8 | 643 | 211,80 |
| 31/7 | 736 | 242,44 |
| 30/7 | 661 | 217,73 |
| 29/7 | 833 | 274,39 |
| 28/7 | 871 | 286,91 |

**Media: 739 click/gg, €243,58/gg.** Il feed a 19.500 è in vigore da ieri sera: il dato del 5/8 è la prima misura pulita. Le due domande a cui rispondere domani sono separate — il costo scende sotto la media? e i 279 forzati portano ordini che prima non c'erano?

---

## 5 agosto, mattina — il taglio non ha tolto vendite, e il bacino vero era nascosto dietro un campo prezzo

### Prima verifica sul campo, ore 08:48

Il feed a 19.500 ha girato tutta la notte. Cosa dicono i numeri della prima mezza giornata:

| | oggi 08:48 | media 8gg stessa fascia |
|---|---|---|
| fatturato MPF | **390,16** | 120,64 (max precedente 238,94) |
| ordini | 5 | 2,5 |
| click MPF | 52 | — |
| MPF su totale rete | 14,8% | 14,2% ieri, range 11,9-17,5 |

Il rapporto MPF/rete è ancora in media: **il taglio non ha spostato i click in proporzione**, e a mezza giornata è troppo presto per il verdetto sul costo. Il fatturato invece è tre volte la media della fascia oraria, ma su 5 ordini: lo registro, non lo attribuisco.

**Dove sono finiti i 52 click**: 46 su prodotti già nel feed, 2 su tagliati, 1 su un forzato, 3 fuori feed. I 2 click sui tagliati sono ANSIOTEN e PURES ROLL, un click a testa, zero vendite: coda residua di TP che deve ancora rileggere il CSV, €0,66 in tutto.

**Cinque prodotti hanno venduto stando fuori dal feed.** Due erano tagliati da noi ieri (ESI MULTICOMPLEX VIT C, DEFENCE SUN LATTE). Verificato uno per uno: **nessuno dei due ha preso un solo click TP oggi** — quelle vendite sono arrivate da un altro canale, non gliele ha tolte il feed. Degli altri tre, tutti stock 0 e prezzo nullo: TP non li esporterebbe comunque. L'unico con stock, ESI VIT C, ha **13 rivali sotto di lui sul totale**: fuori dalla top10, il taglio regge.

Il conto della notte: **zero vendite perse per mano nostra.**

### L'errore che nascondeva il bacino

Ho misurato il bacino residuo da forzare e mi sono usciti **24 SKU**. Ieri erano 1.432. Un crollo del genere in una notte non è un dato, è un bug.

Era il campo prezzo. `applied_price` è popolato **solo per chi sta già nel feed** — è il prezzo con il nostro PRICE_CUT sopra. Su 7.241 prodotti MPF con stock fisico, ce l'hanno in 358. Filtrare i candidati su `applied_price > 0` significa cercare chi è fuori dal feed **tra quelli che ci sono dentro**: il filtro cancellava esattamente la materia che doveva trovare.

Il campo giusto è `exported_price`, quello che Farmabooster manda a Trovaprezzi: ce l'hanno **3.817** dei fuori-CSV con stock. Da qui in avanti, per qualsiasi valutazione su prodotti fuori dal feed, il prezzo è `COALESCE(applied_price, exported_price)`.

Bacino vero, ricalcolato (floor di ricarico rispettato, margine ≥ €1,50):

| posizione attesa sul totale | SKU | margine medio |
|---|---|---|
| 1° | 358 | 4,36 |
| 2°-3° | 239 | 5,86 |
| 4°-6° | 140 | 5,04 |
| 7°-10° | 155 | 3,34 |

### Ondata 3 — 590 sul podio

Presi i primi tre posti sul totale: **590 SKU**, margine medio €4,86, €2.867 di margine complessivo, posizione attesa media 0,5 rivali sotto. **366 di loro avevano `is_civetta = false` da Farmabooster** — sei su dieci. Sono precisamente i prodotti che l'indicazione di FB teneva fuori e che l'ordine del 5/8 dice di forzare.

116 quarantene riaperte per farli passare. In CSV: **549 su 590**.

### I 136 venditori che stavano fuori dalla vetrina

Poi ho fatto la domanda al contrario: chi ha **venduto su MPF negli ultimi 30 giorni** ed è fuori dal CSV? Con stock esportabile — fisico **o grossista** — sono **136**. Tutti dentro, tutti e 136 nel CSV.

Sul primo giro ne avevo contati 3, perché filtravo su `erp_stock > 0`: la disponibilità grossista (`supplier_stock`) è esportabile su TP quanto quella fisica, e scartarla nascondeva 133 venditori. Sono ordini piccoli, spesso €2-4 a riga, ma è fatturato dimostrato.

### Il cap non ha buttato fuori nessuno che vende

Controllo obbligatorio dopo aver aggiunto 726 SKU con un tetto fisso a 19.500. Fuori dal CSV con un'azione attiva ci sono 358 SKU, di cui 29 hanno venduto in 30 giorni per €1.829,95. Scomposti:

- **26 (€1.766) stock 0 sia in farmacia sia dal grossista** — TP non li accetta comunque, non è il cap che li esclude
- 2 forzabili, 1 in quarantena → **entrati con l'ondata dei venditori**

**Nessuno espulso dal cap.** La patch di priorità di ieri sta reggendo: i forzati pesano 300.000 e stanno sopra tutto tranne brand protetti e pin del capo.

### Stato

| | |
|---|---|
| feed | **19.500** (tetto rispettato) |
| forzati totali | **1.019**, di cui **964 nel CSV** |
| — ondata 1+2 (4-5/8) | 293 → 279 |
| — ondata 3 (podio) | 590 → 549 |
| — venditori fuori vetrina | 136 → 136 |
| bloccati | 55, quarantene con le due porte di veto incompatibili |

Restano nel bacino ~295 posizionabili in fascia 4-10 e 1.117 fuori top10. Non li tocco: prima la misura di 24-48 ore su questi.

### I 48 bruciatori che il motore non aveva mai visto

L'allarme del monitor sui "16 bersagli ancora nel CSV" mi ha fatto guardare dentro il feed invece che fuori. Zero REMOVE bloccate — il problema è opposto: **48 SKU che bruciano e che nessun motore ha mai condannato**.

Costo click 30 giorni contro margine vero 30 giorni:

| SKU | prodotto | click | costo | margine | perdita |
|---|---|---|---|---|---|
| 978113405 | LAEVOLAC PANCIA SGONFIA | 291 | 95,86 | 3,22 | **92,64** |
| 934424476 | DERMOVITAMINA FILM GEL | 253 | 83,34 | 17,17 | 66,17 |
| 971268634 | AUTOTEST VIH SCREENING | 64 | 21,08 | **−40,70** | 61,78 |
| 981647821 | MENOPAUSA ACT 30CPR | 122 | 40,19 | 12,51 | 27,68 |
| 902649298 | EMATONIL PLUS GEL | 150 | 49,41 | 23,29 | 26,12 |

In totale **€431,79 in 30 giorni, €14,39 al giorno**. Di questi 27 vendono e bruciano lo stesso, **7 vendono sotto costo** (margine negativo: AUTOTEST −40,70, LACTOFLORENE −21,59, TROSYD −17,29).

Tagliati **30**: fuori i brand protetti, fuori i 16 con **carrelli sani** — quella guardia resta in piedi, è legge cardinale e non l'ho toccata — fuori i forzati di stamattina. Due respinti dai trigger sulle guardie venditore. **Risparmio €7,24/giorno**, tutti e 30 usciti dal CSV alla rigenerazione.

Gli altri 16 con scudo carrello restano dentro: portano ordini ad altri prodotti, il conto va fatto sul carrello, non sulla riga.

### Stato a fine mattina

| | |
|---|---|
| feed | **19.500** |
| forzati | 1.019 scritti, **964 nel CSV** |
| bruciatori tagliati | 30 su 30 usciti |
| risparmio misurato | €7,24/gg dai bruciatori |
| vendite perse | **zero** |

### Lo scraper conferma il modello

I 279 dell'ondata 1 sono in vetrina da stanotte. Lo scraper ne ha già rivisti **231**, e li trova dove il calcolo diceva:

| posizione reale | SKU |
|---|---|
| podio (1-3) | **172** |
| 4-10 | 55 |
| fuori top10 | 4 |

**Posizione media 2,7. 227 su 231 in top10, il 98%.** La previsione era fatta contando i rivali esterni più economici **sul totale** (prezzo + spedizione): quel metodo ora ha una verifica sul campo, non è più una teoria. E vale anche al contrario — se sbagliassimo a confrontare sui prezzi base, questi prodotti sarebbero finiti in fondo alla SERP senza che ce ne accorgessimo.

Restano da vedere le conversioni. La vetrina è quella giusta; se non vendono, il daily engine li toglie da solo — `pulizia_forza%` non è tra le sorgenti intoccabili, quindi i motori possono sovrascrivere l'ADD con un REMOVE quando bruciano. Valvola aperta, nessun forzato è immortale.

### I 43 che restano fuori, e perché li lascio fuori

Dei 1.019 forzati, 55 non entrano nel CSV. Scomposti: **43 fermati da `is_burner_rule`**, 7 con quarantena aperta ma fuori per altro, 5 senza quarantena.

Ho riprovato il rilascio con il writer `capo_`, che è la porta che `veto_release_burner_rule` riconosce. Risultato: `UPDATE 43` e **zero rilasciati davvero**. Letti i due trigger, il motivo è strutturale:

| veto | porta del writer | alternativa |
|---|---|---|
| `veto_release_burner_rule` | `capo_%` | `vende_e_ripaga()` |
| `veto_release_incidenza_alta` | `sessione_%` | `vende_e_ripaga()` |

Le due porte si escludono a vicenda — nessun writer inizia sia per `capo_` sia per `sessione_` — e l'unica strada che le apre entrambe è la stessa: **il prodotto deve vendere e ripagare il click**. Questi 43 sono burner condannati in passato, non vendono, e il sistema chiede una prova che non hanno.

**Non scavalco.** Servirebbe una migrazione che allinei i due trigger, cioè aggirare due guardie indipendenti che stanno facendo esattamente il loro lavoro. Sono 43 SKU su 1.019, il 4%: il prezzo di lasciarli fuori è basso, il prezzo di aprire una scorciatoia nel sistema dei veti è alto e permanente. Se il pilota dimostra che il criterio del totale-con-spedizione batte la vecchia condanna, la migrazione la si fa allora, con il dato in mano e per scelta del capo — non di soppiatto stamattina.

### Due leve misurate, nessuna delle due tirata

Mentre TP non aggiornava i click (il fetch resta quello delle 08:37, il cron gira regolare ogni 4h — non è un guasto) ho misurato le due leve che restano, senza toccarle.

**Leva 1 — il prezzo.** Dei prodotti fuori dal feed che stanno oltre il decimo posto, quanti rientrerebbero in top10 con un taglio che **resta sopra il floor di ricarico**? Il calcolo è: prezzo necessario = totale del decimo rivale esterno − la nostra spedizione − 1 centesimo.

| | SKU | taglio medio | margine dopo |
|---|---|---|---|
| recuperabili col prezzo | **3.893** | 0,55 | **3,09** |
| irrecuperabili (floor più alto del prezzo che servirebbe) | 14.173 | 1,78 | 0,44 |

Mezzo euro di taglio medio per portare 3.893 prodotti in vetrina tenendo €3,09 di margine. Questo è il "civetta true **+ price_cut**" dell'ordine del 5/8, ed è la mossa dopo la misura — non insieme alla misura, o non si capisce più cosa ha funzionato.

**Leva 2 — la spedizione.** Stessa identica formula, cambiando solo il nostro costo di spedizione da **5,82 a 4,76** (quello che pagano San Vito e Procaccini, stessa rete):

| | con 5,82 | con 4,76 |
|---|---|---|
| SKU fuori top10 | 18.066 | **7.177** |

**10.889 prodotti passerebbero in top10 senza toccare un solo prezzo.** Un euro e sei centesimi di spedizione in meno vale, da solo, più di qualsiasi campagna di price cut che possiamo fare sul catalogo — e non costa un centesimo di margine sul prodotto.

Non prometto che si trasformino in vendite: la vetrina è condizione necessaria, non sufficiente. Ma oggi quei 10.889 non sono nemmeno in gara, e il motivo non è il prezzo, è il corriere. **La leva è del cliente, non del feed.** Il numero è questo, la decisione è del capo.

---

## 5/8 ore 09:40 — prima lettura del giorno dopo, e un bug GA4 chiuso

### Il ciclo notturno è passato sopra il feed e non l'ha disfatto

Il motore giornaliero ha girato stanotte su tutta la rete. Su MPF il CSV è uscito a **19.500 civetta=1, 2 rimossi rispetto al giorno prima**: il tetto tiene e le forzature sono ancora dentro. I 1.019 SKU forzati (le tre ondate più i venditori) sono sopravvissuti a un secondo ciclo completo.

### Il primo numero pulito arriva domani alle 05:02, non oggi

Ho scoperto una cosa leggendo `zombie_clicks` che cambia come si misura:

| fetch_date | scritto il | righe | click |
|---|---|---|---|
| 2026-08-03 | 04/08 05:02 | 488 | 849 |
| 2026-08-04 | 05/08 05:02 | 457 | 754 |
| 2026-08-05 | 05/08 08:37 | 41 | **52** |

Il cron delle 05:02 scrive il giorno **precedente completo**; l'intraday delle 08:37 scrive il parziale di oggi. Confrontare i 52 click di stamattina con i 739/giorno della baseline è confrontare tre ore con ventiquattro. **Il 4/8 ha chiuso a 754 click / €248,37**, in linea con la media — giusto così: i tagli sono arrivati la sera del 4 e la mattina del 5, non hanno ancora avuto un giorno intero per farsi vedere. Il verdetto sul costo è la riga `fetch_date = 2026-08-05` che comparirà domani alle 05:02.

### Il fatturato però parla già

MPF prima delle 09:40, ultimi nove giorni:

| giorno | ordini | venduto entro le 09:40 |
|---|---|---|
| 28/7 | 2 | 33,59 |
| 29/7 | 6 | 359,44 |
| 30/7 | 5 | 241,25 |
| 31/7 | 4 | 232,58 |
| 1/8 | 5 | 238,94 |
| 2/8 | 2 | 48,61 |
| 3/8 | 7 | 390,02 |
| 4/8 | 3 | 181,03 |
| **5/8** | **7** | **523,42** |

Massimo dei nove giorni, +34% sul secondo giorno migliore, più del doppio della media. Non lo attribuisco al feed: un giorno non è una serie e la stessa mattina il fatturato può nascere da un'email, da una ricerca organica, da un cliente che torna. Lo registro perché è il verso giusto, e perché la legge dice fatturato su.

Sui forzati, per ora: **1 click e €54,53 di venduto** contro 42 click e €433,97 del resto del feed. Con un solo click addosso, quei 54 euro non vengono da Trovaprezzi. Troppo presto: 41 SKU in tutto hanno preso click stamattina.

### Bug GA4 trovato e corretto — l'attribuzione non aveva SKU

`[GA4] Entity ID map: 0 products` e `[GA4] Key remap: 0 mapped to SKU, 724 unmapped` su ogni tenant che ha GA4 attivo. GA4 ha ricominciato a dare numeri (€66.470 di first-touch su SubitoFarma), ma **non erano agganciabili a nessun prodotto**.

Causa: GA4 manda come `itemId` l'`entity_id` di Magento, non il minsan. La traduzione passa da `products.magento_entity_id`, che su MPF, Papa, Procaccini, San Vito, Farmastelia, SubitoFarma, Farmainsieme, Ospedale è **NULL su tutto il catalogo** (solo Mandanici 91.462 e Farmacri 69.401 ce l'hanno). Esisteva già la funzione di ripiego `buildEntityIdMapFromGA4` — costruisce la mappa dai *nomi* prodotto di GA4 e la persiste — scritta, testata, esportata e **mai chiamata da nessuna parte**. Codice morto dalla migrazione 008.

Fix in `services/ga4Analytics.js`: se la mappa dal catalogo esce vuota, si costruisce da GA4 e si salva per i giri successivi. Deployato e riavviato alle 09:44, backend up.

Non cambia una virgola delle decisioni sul feed — quelle restano sugli ordini reali Magento — ma restituisce l'attribuzione per prodotto, che serve per capire *dove* finiscono i click dopo il click.

### Resta aperto
- **Credito Anthropic esaurito**: `aiAuditor audit failed: 400 — Your credit balance is too low`. L'audit AI è fermo su tutti i tenant da ieri.

### 10:15 — dove sono finiti i forzati, e perché il machete non ha più niente da tagliare

**Posizione reale dei 1.019 forzati** (scraper fresco 48h, rivali di rete esclusi, confronto sul totale con spedizione):

| | SKU | posizione media |
|---|---|---|
| podio (1-3) | **371** | 2,0 |
| top10 (4-10) | 195 | 7,2 |
| fuori top10 | 134 | 20,2 |
| non ancora scansionati | 319 | — |

Dei 700 già rivisti dallo scraper, **566 sono in top10 — l'81%**, e più della metà sul podio. Il modello di posizionamento regge una seconda volta su un campione quattro volte più grande di ieri. I 134 finiti fuori erano top3 quando li ho forzati: il mercato si è mosso sotto. Li lascio dove sono fino a fine misura, poi o li si recupera col prezzo o escono.

**Seconda passata burner, finestra 15 giorni, soglia onesta (≥15 click).** Dentro il CSV, esclusi brand, carrelli sani, pin e forzati:

| tipo | SKU | click 15gg | €/giorno |
|---|---|---|---|
| vende ma brucia | 2 | 92 | 2,02 |
| burner puro | 1 | 18 | 0,40 |

**Tre prodotti. Due euro e quarantadue al giorno.** Il pozzo è secco.

Allargando a tutto ciò che nel CSV ha preso click in 15 giorni e **non ha venduto nulla in 30**, protetti e portatori di carrello esclusi:

| fascia click | SKU | click | €/giorno |
|---|---|---|---|
| 15+ | 4 | 85 | 1,87 |
| 5-14 | 44 | 305 | 6,70 |
| 2-4 | 98 | 255 | 5,60 |
| 1 | 184 | 184 | 4,04 |
| **totale** | **330** | **829** | **18,21** |

Diciotto euro al giorno su circa duecentocinquanta: **il 93% della spesa TP di MPF finisce ormai su prodotti che hanno venduto negli ultimi 30 giorni.** E quei diciotto euro sono per tre quarti coda lunga da uno o due click — dove "zero vendite" non è una condanna, è rumore statistico.

Conclusione operativa: **la strada del taglio è finita.** Ogni euro in più che si toglie da qui in avanti si toglie a qualcuno che vende. Le leve che restano sono le due già misurate — il prezzo sui 3.893 recuperabili e la spedizione a 4,76 — più il riposizionamento dei 134 forzati caduti fuori. Nessuna delle tre è un taglio.

**I 134 caduti fuori, guardati da vicino.** Stessa formula del prezzo (decimo totale esterno − spedizione − 1 centesimo, confronto col floor di fascia):

| | SKU | taglio medio | margine dopo |
|---|---|---|---|
| recuperabili col prezzo | **41** | 0,70 | 4,15 |
| irrecuperabili (floor sopra il prezzo che servirebbe) | 93 | 2,03 | 0,59 |

Quarantuno tornano in vetrina con settanta centesimi tenendo €4,15 di margine — entrano nella campagna prezzo insieme agli altri 3.893. I novantatré no: il margine finisce prima della posizione. Sono forzature mie che il mercato ha scavalcato, e a fine misura escono — pulire il proprio lavoro conta quanto farlo.

### 10:50 — un errore mio, e il buco che ha scoperchiato

**Prima l'errore.** L'ondata "venditori fuori vetrina" delle 08:56 non filtrava sul margine. Ho rimesso in vetrina prodotti che vendono **sotto costo**: TROSYD (−5,76 a pezzo), LACTOFLORENE (−4,32), AUTOTEST VIH (−4,07), POLASE (−2,53). Comprare fatturato in perdita è il contrario del mantra.

**Poi il muro.** Ho scritto dieci REMOVE di correzione. Ne sono passate tre. Il registro dice perché, sullo stesso SKU e nella stessa transazione:

```
037087032 | condanna permessa               | mig 089: vende ma il click costa piu del margine (margine-first)
037087032 | condanna permessa               | mig 090: incidenza 30g ok ma margine 15g bruciato (margine-first vince)
037087032 | re-condanna via UPDATE bloccata | L4 (mig 086): vende 30g e il click si ripaga
```

**Le migrazioni pilota tolgono lo scudo, la vecchia L4 lo rimette sul percorso UPDATE, e vince la vecchia.** Il motivo di fondo è che `vende_e_ripaga` misura **fatturato** contro costo del click: un prodotto che perde €5,76 a pezzo "si ripaga" perché il fatturato è comunque maggiore dei 33 centesimi di click. Passate con writer `capo_` (mig 091, ordine del 5/8: sul taglio resta solo il veto brand).

**Poi il buco vero.** Cercando se il problema fosse solo mio ho contato tutto il CSV: **13 SKU non protetti vendono sotto costo**, ~€101 di margine bruciato in 15 giorni (€6,76/giorno). Ho lasciato dentro ACTIFED (−0,39 a pezzo, 37 pezzi) e VICHY HOMME (−0,36, 25 pezzi): perdono centesimi e portano volume, toglierli costerebbe €26/giorno di fatturato per salvarne €1,55 di margine — la regola dice fatturato prima.

Cinque dei rimanenti erano protetti da `porta_carrelli_sani`. Ho fatto il conto completo su 90 giorni — margine del carrello, meno costo click, **più il margine proprio del prodotto per i pezzi venduti**:

| SKU | prodotto | pezzi 90gg | perdita propria | carrello | netto |
|---|---|---|---|---|---|
| 980448649 | RETINOL B3 SIERO | 13 | −55,38 | 7,31 | **−48,40** |
| 984236291 | RAMATONIC | 9 | −14,76 | 1,98 | **−13,11** |
| 042154029 | LASONIL GEL | 14 | −31,08 | 19,02 | **−12,06** |
| 951873241 | BEPANTHENOL COLLIRIO | 5 | −10,20 | 6,40 | **−8,41** |
| 984515458 | HYALUBRIX SIR | 3 | −31,20 | 38,14 | **+5,62** |

`porta_carrelli_sani` confronta il margine del carrello col **costo del click** e non guarda mai il margine proprio del prodotto. Quattro prodotti che perdono anche contando il carrello risultavano "sani". HYALUBRIX invece regge davvero — carrello medio €219 che copre i €31 di perdita — ed è rimasto dentro.

**Esito: 9 SKU sotto costo fuori dalla vetrina**, verificato dopo rerun stable: zero ancora dentro, feed 19.500, 958 forzati ancora nel CSV.

**Per il capo, due cose da decidere, non da eseguire:**
1. Le guardie L2/L4 (`vende_e_ripaga`) e la guardia carrello (`porta_carrelli_sani`) misurano **fatturato e costo click, mai il margine del prodotto**. Finché è così proteggono chi vende in perdita. Serve una migrazione che ci metta dentro il margine vero — non la faccio di mia iniziativa perché tocca tutta la rete, non solo il pilota.
2. Il prezzo di questi prodotti non è alzabile (veto rialzi, territorio Farmabooster). L'unica leva nostra è la vetrina. Se il listino è sbagliato, la correzione sta a monte.

### 11:05 — quanto vale lo stesso buco sul resto della rete (solo misura, nessun tocco)

Il pilota è su MPF e ci resta. Ma il conto sotto-costo si fa anche altrove in lettura, per dare al capo la dimensione del premio prima di decidere. Prodotti **dentro il CSV** con margine unitario vero negativo, e quanto sono costati in 90 giorni:

| tenant | SKU sotto costo | peggiore | pezzi 90gg | perdita 90gg |
|---|---|---|---|---|
| SubitoFarma | 35 | −23,33 | 1.281 | **−2.002,73** |
| Mandanici | 8 | −10,37 | 228 | −1.147,58 |
| San Vito | 35 | −5,42 | 463 | −598,60 |
| Farmainsieme | 22 | −4,75 | 220 | −441,83 |
| Procaccini | 18 | −5,70 | 191 | −361,85 |
| Ospedale | 14 | −6,80 | 249 | −318,63 |
| Papa | 19 | −4,30 | 235 | −176,51 |
| MPF (dopo la pulizia) | 5 | −10,40 | 379 | −162,48 |
| Farmacri | 12 | −35,47 | 122 | −52,26 |
| Farmastelia | 8 | −1,64 | 11 | −6,36 |

**176 prodotti, circa €5.270 di margine bruciato in 90 giorni — €58 al giorno sulla rete.** Non è spesa Trovaprezzi: è margine che se ne va a ogni vendita, indipendentemente dal canale.

Su MPF ne restano 5 per scelta ragionata (i quasi-pari con volume e HYALUBRIX che il carrello ripaga). Sugli altri nove tenant non tocco nulla: **il pilota è MPF, l'ordine del 4/8 è quello, e questi numeri sono un dossier, non un'operazione.** Se il capo dà il via si applica lo stesso metodo — netto 90gg che include il margine proprio, non solo il costo del click.

Da notare per SubitoFarma: sta sotto il floor del 15% per scelta del cliente e questo è noto e accettato. Vendere **sotto costo** è un'altra cosa e vale €2.000 in tre mesi.

---

## 5/8 — Il pilota esce da MPF: rumore tagliato su Papa e Farmastelia

**Ordine del capo, 5/8 mattina:** *"ok allora io taglierei il rumore su papa e controllerei anche farmastelia"*.

Fino a questa riga ogni operazione era MPF-only per l'ordine del 4/8. Da qui il perimetro si allarga a Papa e Farmastelia **per parola esplicita**, e solo sulla leva rumore.

### Definizione di rumore, uguale sui due tenant

SKU **dentro il CSV**, con **1-4 click negli ultimi 30 giorni** e **zero ordini reali Magento a 30 giorni** (whitelist `processing, pending, complete, ritiro_farmacia, Ritirato`, tutti i canali, non solo TP).

Il join click-vendite è stato validato prima di condannare: stesso formato codice a 9 cifre da entrambi i lati, 808 SKU su 1.855 venduti hanno anche preso click (44%). Nessun artefatto di mismatch che avrebbe fatto sembrare morto tutto il catalogo.

### Perché 1-4 click non è una condanna di merito

| Click 30gg | SKU | Ne vende almeno uno | % |
|---|---|---|---|
| 1 | 1.079 | 267 | 24,7 |
| 2-4 | 689 | 247 | 35,8 |
| 5-14 | 253 | 129 | 51,0 |
| 15-39 | 65 | 56 | 86,2 |
| 40+ | 30 | 27 | 90,0 |

Sopra i 15 click 9 su 10 vendono: lo zero lì è provato. A 1-4 click il prodotto non è stato testato abbastanza per dire che è morto. Il taglio è quindi **per costo aggregato**, non per merito del singolo — e va riaperto a rotazione, altrimenti è definitivo e cieco.

### Filtri applicati (nessun taglio al buio)

| Esito | Papa | Farmastelia |
|---|---|---|
| Brand protetti — SALVI | 77 SKU | 24 SKU |
| Venduto 31-90gg **con stock fisico** — SALVI | 47 | 29 |
| Venduto 31-90gg senza stock — tagliati | 273 | 354 |
| Morti a 90gg — tagliati | 857 | 1.665 |

I brand protetti di Papa sono `UNI, GAD, MYC` da `health_config`. **Farmastelia non ha nessuna lista configurata** — unico tenant della rete senza. Ho applicato la lista di rete `UNI, GAD, MYC, EUC` come scudo minimo, ma è una mia scelta prudenziale, non una configurazione: **va decisa dal capo**.

Salvare chi ha stock fisico e ha venduto negli ultimi 90 giorni non è prudenza generica: è la regola aurea di spingere il magazzino della farmacia, dove il MOL è migliore.

### Esecuzione

Writer `capo_rumore_papa_0508` e `capo_rumore_fs_0508` (mig 091: la mano del capo scavalca cap e basket guard). `action_source` con prefisso `pulizia_` — senza, il rerun engine cancella tutto in pochi secondi.

| Tenant | Feed prima | Feed dopo | REMOVE scritte | Rientrati dopo rerun | Risparmio teorico/gg |
|---|---|---|---|---|---|
| Papa | 24.939 | **23.894** | 1.047 | 11 | 18,94 |
| Farmastelia | 26.738 | **24.725** | 2.015 | 2 | 34,02 |

Su Papa 83 SKU e su Farmastelia 4 non sono stati toccati perché già `manual_pepita`: la guard `ON CONFLICT` li protegge. Sono pepite manuali su prodotti a 1-4 click e zero vendite — **non stanno funzionando**, ma sono mano umana e non le sovrascrivo di mia iniziativa.

Entrambi verificati dopo rerun stable: le REMOVE sono sopravvissute.

### Il fatto separato su Papa: il budget si spegne a fine mese

Il 30/7 Papa ha fatto **18 click** e il 31/7 **zero righe**, mentre tutti gli altri tenant giravano normalmente. Non è un guasto: è il budget TP mensile finito.

| Mese | Giorni attivi | Click | Costo TP |
|---|---|---|---|
| Maggio | 29 | 13.814 | 4.550,33 |
| Giugno | 30 | 10.109 | 3.329,90 |
| Luglio | 30 | 14.553 | **4.793,76** |
| Agosto (5gg) | 5 | 2.120 | 698,33 |

Tetto ~€4.800/mese, esaurito con un giorno e mezzo di anticipo. Ad agosto il ritmo è €139/giorno (proiezione €4.330), ma il 3/8 ha fatto 620 click (€204): a quel passo si rispegne verso il 27-28. **Perdere due giorni pieni di fatturato per non aver rinunciato a €20/giorno di rumore è il peggior cambio possibile.** Serve un pacing di fine mese, non uno spegnimento secco — regola in `REGOLE_LOOP_STANDARD.md` §2.5.

### L'allarme Papa al 23,6% era falso

Scartato con tre misure prima di toccare qualsiasi cosa:

| Mercoledì | Ordini ≤10:45 | Revenue ≤10:45 |
|---|---|---|
| 22/7 | 5 | 217,27 |
| 29/7 | 6 | 279,33 |
| **5/8** | **5** | **193,73** |

Papa fa in media solo il **22,4%** del fatturato prima delle 10:45 (range 4,4-44,7%). Con i click che si accumulano dal mattino e gli ordini che arrivano dopo, l'incidenza parziale è gonfia per costruzione. Nessun intervento sull'allarme.

### Cosa misurare domani

Non il risparmio teorico: i click TP si rigenerano per rotazione della coda, quindi €52,96/giorno sommati fra Papa e Farmastelia sono un tetto, non una previsione. Riga piena contro riga piena (cron 05:02), baseline 4/8:

| Tenant | Click | Costo TP | Venduto | Incidenza |
|---|---|---|---|---|
| Papa | 466 | 153,50 | 2.525,34 | 6,1% |
| Farmastelia | 626 | 206,20 | 2.513,19 | 8,2% |

Farmastelia resta il tenant peggiore della rete: incidenza media **11,8%** su 10 giorni (8,2-14,6) contro il mandato del 7%.

Le due domande valgono qui come su MPF: **il costo scende** e **il fatturato tiene**. Un taglio che abbassa il costo perdendo fatturato non è un risultato.

### Correzione in giornata — i brand protetti erano solo di MPF

**Richiamo del capo:** *"io su papa e farmastelia non mi sembra di averti dato nessun brand protetto da dove li hai presi?"* — poi: *"quei brand sono solo di MPF sugli altri puoi levare questi veti"*.

Ricostruita la catena invece di rispondere a memoria:

- commit `f741b55` (2/7 07:30): introduce `brand IN ('UNI','GAD','MYC')` con in commento **"regola cliente 26/6/2026"** — il cliente è **MPF**;
- commit `a7720f8`: i brand diventano per-tenant e la lista viene scritta in `health_config`.

| Tenant | Lista | `updated_at` |
|---|---|---|
| MPF | UNI,GAD,MYC,EUC | 2/7 07:32:27.846464 |
| Papa | UNI,GAD,MYC | 2/7 08:29:28.**980895** |
| Procaccini | UNI,GAD,MYC | 2/7 08:29:28.**980895** |

Papa e Procaccini hanno lo **stesso timestamp al microsecondo**: una singola INSERT di propagazione. Nessuna decisione presa per quei due tenant.

Su Papa quindi non l'avevo inventata, l'avevo letta dalla config. **Su Farmastelia sì**: nessuna lista è mai esistita e le avevo applicato quella di MPF di mia iniziativa. Decisione presa al posto del capo, corretta lo stesso giorno.

**Eseguito:** `DELETE FROM health_config WHERE config_key='killer_protected_brands' AND tenant_id <> '<MPF>'` — 2 righe, resta configurato **solo MPF**.

Poi tagliato il rumore che quel filtro aveva salvato per errore:

| Tenant | Brand | SKU | Click 30gg | Risparmio/gg |
|---|---|---|---|---|
| Papa | GAD | 65 | 111 | 1,22 |
| Papa | UNI | 11 | 16 | 0,18 |
| Papa | MYC | 1 | 1 | 0,01 |
| Farmastelia | UNI | 10 | 11 | 0,12 |
| Farmastelia | GAD | 9 | 11 | 0,12 |
| Farmastelia | EUC | 5 | 6 | 0,07 |

101 REMOVE, writer `capo_rumore_brand_0508`, `action_source = pulizia_rumore_brand_0508`.

**Bilancio della giornata sui due tenant:**

| Tenant | Feed a inizio giornata | Feed ora | Differenza | REMOVE totali |
|---|---|---|---|---|
| Papa | 24.939 | **23.797** | −1.142 | 1.124 |
| Farmastelia | 26.738 | **24.701** | −2.037 | 2.039 |

**Da tenere d'occhio:** senza config, i motori possono ora killare e ri-prezzare UNI/GAD/MYC su tutti i tenant tranne MPF. Su Papa restano 335 SKU di quei brand nel feed, su Farmastelia 185. Ma il cambio tocca anche **Procaccini** (349 SKU), che non era nel perimetro dell'analisi di oggi: lì il comportamento dei motori cambia senza che nessuno abbia guardato quei prodotti.
