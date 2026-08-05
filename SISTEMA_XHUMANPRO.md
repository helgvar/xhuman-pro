# 📕 LIBRO MACCHINA xHUMANPRO
**Il documento unico del sistema — da rileggere OGNI GIORNO (ordine del capo, 11/7/2026).**
*"Il tuo compito è aumentare il fatturato e tagliare la spesa. I cicli sono automazioni schedulate: non puoi perderli per strada."*

---

## 0-bis. 📌 IL PIN DEL CAPO (13/7: "la sessione deve COMANDARE xHumanPro, non sostituirlo — se dico attiva, xHumanPro recepisce e NON stacca più")
Ogni ordine esplicito del capo su un prodotto va scritto in `capo_pins` (tenant_id, sku, azione, motivo) — NON eseguito come SQL one-shot che i motori risovrascrivono. Il pin: (1) è nella 1ª classe protetta (`is_feed_protected`) → veti DB + amnistia oraria; (2) vince su strict/quality/briglie nella build CSV; (3) si toglie SOLO con revoked_at esplicito. Il "girotondo" (io agisco → il motore risovrascrive) è vietato per costruzione. Trappola scoperta 13/7: il motore quarantene RINFRESCA quarantine_start mantenendo la reason vecchia (righe engine 1658) → i batch di sessione riappaiono come "blocchi nuovi" con etichette vecchie ("Igiene feed MasterPlan L1" = onde di inizio luglio riciclate, NON una seconda sessione).

## 0-ter. ⚖️ L'ARBITRO DELLE AZIONI (13/7, giornale n.19 — "le logiche si sovrappongono, una mette e l'altra leva")
**L'ultimo che scrive NON vince più.** Migrazione 058, trigger `trg_arbitro_azioni` su feed_actions:
1. **Ogni tocco a `recommended_price` è a verbale** in `azioni_touch_log` (chi, prima/dopo, motivo, quando; retention 30g). Un fuoco amico ora si vede in UNA query, non dopo ore di caccia.
2. **Le azioni manuali/di sessione** (`manual_pepita`, `manual`, `capo_pin`) **non possono essere neutralizzate da scrittori anonimi**: veto + verbale. Per toccarle: `set_config('xhp.writer','<nome>',true)` + `xhp.motivo` (la legge che giustifica) in transazione. L'igiene si firma (`igiene_prezzi_derivati`).
3. **Nessun rewrite di massa tocca le manuali**: feedEngine.persistActions disinnescato (cancellava TUTTO il tenant — era codice morto ma armato); feedDailyEngine preserva anche `muro_scavalco`/`manual`/`capo_pin` (prima li spazzava a ogni rerun: gli scavalchi del 12/7 erano già spariti così).
4. **Governor su BASE price** (fix 13/7): usava total_price mentre TP classifica per base → rialzava i PC manuali sopra il muro base (147+ corrotti, bonificati). Esclusi i merchant della nostra rete dal best_comp.
Debug fuoco amico: `SELECT * FROM azioni_touch_log WHERE writer='anonimo' OR operazione='veto_arbitro' ORDER BY touched_at DESC`.

## 0-quater. 🏛️ LE LEGGI VIVONO NEL DB, NON NEI MOTORI (14/7, giornale n.30 — risposta a "risuccederà?")
Ogni regressione dei giorni 13-14/7 aveva la stessa radice: la legge viveva nel CODICE di N motori (copie stantie, flag condivisi, preserve-list dimenticate). Dottrina: **ogni legge si applica AL MOMENTO DELLA SCRITTURA, nel DB** — vale per ogni motore presente e futuro. Migrazione 060:
- **L1 MAI RIALZI** (`trg_veto_rialzi_universale`): nessuna rec sopra il prezzo vivo (applied/exported/sell), da QUALSIASI sorgente. Harvest/calibratore/motore-futuro: tutti sbattono qui. Riattivazione harvest SOLO `global_config.margin_harvest_enabled='1'` (gate dedicato) + rimozione veti.
- **L2 CHI VENDE IN RETE NON SI CONDANNA** (`trg_veto_condanna_vendente_*`): killer/quarantene/REMOVE su SKU con ordini di rete 15g = INSERT soppresso a verbale (eccezione: quarantene manual_override della dieta). Fine del tiro-alla-fune engine-condanna/winback-libera.
- **L3 DELETE ANONIMI VETATI su fonti protette** (`aa_trg_arbitro_delete`): manual/pulizia_%/scavalco/pin cancellabili solo da scrittori firmati.
- **🔔 SIRENA CONFORMITÀ** (conformityMonitor, 07:00 IT): ricontrolla C1 protetti-bloccati, C2 vendenti-bloccati, C3 rialzi-vivi, C4 tocchi-anonimi → Telegram se >0. Il fuoco amico si scopre in ORE.
⚠️ TRAPPOLA FLAG CONDIVISI: mai più un flag che comanda N motori (la revoca pausa 13/7 ha riacceso harvest+calibratore). Un motore di RIALZO = un interruttore dedicato, spento di default.
- **CAP-CONDANNE = FRENO DEI MOTORI, NON DEGLI ORDINI DEL CAPO (15/7, mig 064)**: `trg_cap_condanne_fn` bypassa le azioni con `xhp.writer LIKE 'sessione_%'` (verificate caso per caso + a verbale). Il cap max(150,1% feed)/tenant/g resta contro le strage automatiche (dieta 9/7).
- **CARVE-OUT DIETA/VETRINA su TOP10+STOCK (15/7, mig 065)**: un burner che NON vende non va protetto dalla POSIZIONE — `is_feed_protected` non applica le clausole TOP10 e magazzino agli SKU in `dieta_provati`/`vetrina_piena_provati` (verificati fatturato-zero). Brand/carrello/pin/vendite-seller restano SEMPRE sovrani. La dieta deliberata (`feed_quarantine manual_override=true`) non si auto-rilascia; rientro solo per merito (primo ordine → L2).
- **LEGGE POSIZIONE SUL RILASCIO (15/7, mig 061, giornale n.36)**: la vendita di RETE libera un MINSAN su un tenant SOLO se lì la posizione fresca è raggiungibile (`pos_fresca() <= release_pos_max`, default 10) o se vende localmente. Non posizionato = resta bloccato A MONITOR; il **banco di test della lima** (06:15, max 20/tenant/g) lo libera CON PC in scala quando il margine lo consente. Il carrello 90g resta sovrano sopra tutto. "Liberarlo senza posizione = non venderebbe comunque e rischiamo click."
- **✂️ LIMA COSTANTE (15/7, ordine permanente, giornale n.35)**: ogni mattina 06:15 max 80 burner/tenant (click 15g, 0 vendite rete, non protetti) fuori dal feed, sorgente `pulizia_lima_costante` = classe protetta. Poco ma costante; Telegram giornaliero. 4 pass: burner, test-posizione-con-PC, vetrina-piena, rete-only-cap.
- **🔁 RETE-ONLY CAP (15/7, ordine permanente)**: un SKU che vende in RETE ma NON sul suo tenant (Papa "finanzia" le altre farmacie) resta ATTIVO finché la spesa click sta sotto `global_config.rete_only_cap_eur_month` (default 80€/mese); oltre → fuori (pass 4 lima). NON è dynamic pricing da tagliare in blocco (caso LAEVOLAC ~45€/mese resta): solo il tetto di spesa.
- **☠️ CATEGORIE MORTE (15/7)**: categoria TP per-tenant con conversione <5% e spesa ≥1€/g → si staccano i NON-venditori (0 ordini ovunque 90g), i pochi venditori RESTANO. Per-tenant (la stessa categoria può convertire altrove).
- **🏪 PATTERN VETRINA PIENA (15/7, mig 063, giornale n.38 — archetipo Saugella MPF)**: prodotto con prova schiacciante che il canale click non lo vende: click ≥60/90g (`vetrina_click_min`), ≤2 vendite DIRETTE, incidenza >50% (costo click > ½ fatturato diretto), carrello non ripaga (basket_margin < costo click), sell_price>0. Due porte: (5a) **vetrina piena** pos ≤3 (`vetrina_pos_max`) — più su non si va; (5b) **porta PC chiusa** — fuori perimetro o nessun gradino esterno sotto la nostra base ≥ floor. **CARVE-OUT regola aurea magazzino**: lo stock NON protegge i provati (escono solo da TP, restano su sito). Refresh+REMOVE nella lima 06:15 (solo operational+Farmacri); rientro per merito al primo ordine (L2). Esclusi sempre pin/brand/carrello-protetti.
  - **ESCLUSIONE RESTOCK (capo 15/7)**: altorotante di RETE (≥3 ord 90g) in rottura ERP (`erp_stock=0 AND supplier_stock>0`) NON si taglia — il floor è gonfiato dal costo grossista temporaneo, tornerà competitivo al restock. Vista `restock_watch`. Auto-gestione: al rientro magazzino il refresh giornaliero rivaluta da solo.
  - **P1 doppione di rete = DYNAMIC PRICING, non pattern** (capo 15/7: non toccare). **P2/P3 "senza listino"/"stock zero" NON esistono come pattern**: sono SPECCHIO SPORCO del sync (prodotti vivi e venduti su TP con sell_price=0/stock=0 nel NOSTRO DB — decimazione dump FB dal 9/7, ~90€/g su cui siamo ciechi, 550 vendono). Cura = FIX DATI + dossier FB, MAI rimozione. **P4 gap incolmabile = AUTOMATICO valutato CASO PER CASO** (porta 5c): taglia SOLO il **gap STRUTTURALE** (`erp_stock>0` → costo vero farmacia, e anche il miglior taglio legale resta > `gap_max` sopra il mercato → non venderemo mai su TP); il **gap da RESTOCK** (`erp_stock=0 & supplier_stock>0` altorotante → costo grossista temporaneo) resta ESCLUSO → `restock_watch`, rivalutato al rientro magazzino.

## 0-quinquies. 💎 IL MARGINE VERO ALLA SORGENTE (16/7 — scolpito nella pietra, mig 066/067)
**"Il costo/sorgente di un prodotto cambia infinite volte al giorno: ora lo vende il magazzino ERP farmacia, ora il grossista. Ogni ottimizzazione DEVE sapere, IN QUEL PRECISO ISTANTE, dov'è, chi lo vende e qual è il margine REALE."**
- `erp_cost` = MIN_COST del **grossista** (NON il costo-acquisto farmacia). `erp_purchase_cost` = costo-acquisto **vero** farmacia.
- La SORGENTE del momento la dice lo stock (fresco a ogni sync): `erp_stock>0` → magazzino farmacia, costo = `erp_purchase_cost`; `erp_stock=0 & supplier>0` → grossista, costo = `erp_cost` MIN_COST.
- **Funzioni obbligatorie (mig 066)**: `costo_vero()`, `prezzo_vero()` (applied>exported>sell), `margine_unitario_vero()`, `sorgente_vendita()`. Leggono products LIVE. **Ogni sezione che DECIDE (taglio/prezzo/margine/incidenza) DEVE usarle — MAI `erp_cost` secco, MAI `products.margin` pre-calcolato (stantio + col MIN_COST).**
- Prova del disastro evitato (audit 16/7): Oral-B iO2 risultava margine **−€18** (finto, erp_cost su prodotto venduto dal grossista) → col costo vero è **+€12,42**. Tagliarlo = perdere fatturato vero per un artefatto.
- Corretti: `refresh_sku_basket_stats` (margine carrello, mig 067), `productHealth` (COGS + revenue score → margine_vero live). ⚠️ DA MIGRARE ancora al costo_vero: aiMarginCalibrator, skuMargins, priceJump floor, feedEngine — usare le funzioni 066 a ogni tocco.
- **⭐⭐ CHIARIMENTO CAPO 23/7 (scolpito, "non può sbagliare più")**: i prezzi sono TRE, non due → `costo d'acquisto (fresco)` < **`prezzo di VENDITA`** < `prezzo di LISTINO`. Il listino sta SOPRA: tra costo e listino c'è **sempre di mezzo il prezzo di vendita**, quindi il margine si ragiona SOLO tra **costo e prezzo di vendita** (`prezzo_vero − costo_vero`), MAI col listino (`sell_price`/`exported_price`/`p.margin`). Verificato 23/7 sul venduto reale: **`prezzo_vero()` ≈ venduto a centesimi** (regge anche con sell_price=0), `sell_price` = listino (più alto). **Costo FRESCO = ≤ 4h**; oltre → fail-closed, NON condannare. Unico cambio sorgente (magazzino finito → grossista) è **ricalcolato prima dell'export Magento**, nessuna trappola. Audit "ancora su listino": 🔴 soglia KILLER (feedDailyEngine ~431/450), SB cut giornaliero (~964/978), feedEngine REMOVE categoria (~573); 🟠 feed build keep (externalApi ~189-201); 🟡 shoppingOptimizer/civettaGap/feedHygiene; 🔵 ruleOptimizer MOL, crossTenantPricing, abTest. ✅ già fix 23/7: pepite GOLDEN+SILVER. Trigger: 15 pepite false + 023547060 (listino 8,59 / venduto bulk 6,58 / costo 6,51).

## 0. IL PRINCIPIO SUPREMO (11/7 — governa tutti gli altri)
**xHumanPro è un POTENZIAMENTO di Farmabooster, NON un sostituto.**
FB è il motore: regole, prezzi, selezione civetta, muri, export. Noi siamo il turbo:
1. **Togliamo lo spreco che le regole non vedono** (burner veri, oblio cross-tenant, zero-vendite)
2. **Aggiungiamo l'intelligenza che le regole non hanno** (pepite SB, banda d'oro, trend, carrello, esplorazione dei ciechi)
3. **Vigiliamo** (sirene, checkout, posizioni, coerenza dati) e **segnaliamo al cliente** ciò che FB deve correggere (dossier), mai scavalcandolo in silenzio
- Default: DECIDE FB. Interveniamo SOLO dove aggiungiamo valore misurabile, sempre dentro la sua cornice. Ogni volta che stai per "correggere" FB, chiediti: sto potenziando o sto sostituendo? Se sostituisci, fermati e segnala.

## 1. LA MISSIONE (il mantra, sempre insieme)
**Fatturato SU + MOL ~20% (mai sotto 15%) + Costo TP GIÙ.** Incidenza = guard rail, fatturato = North Star. Mai tagliare spesa a discapito del fatturato netto.

## 1b. ✅ PAUSA SCRAPER REVOCATA (ordine capo 13/7 — giornale n.17)
Pausa 11-13/7 chiusa: scraper FB ripristinato (2-4 consegne piene/giorno, ~90-104k MINSAN, sentinella `scraperDeliveryWatch` conferma ogni ora). Flag `global_config.scraper_optimization_paused='0'`. Tutti i loop scraper-based di nuovo VIVI (Pareto AI, governor, calibratore, caccia igiene, winback PC, B0). La regola di backup (`civettaBackup`) resta nel codice e si riattiva da sola se il flag torna '1'.
Residuo: coorti `gap_sblocco_capo_20260711` (103k) scadono ~25/7 — rinnovare se servono ancora.
**FLOOR PER-TENANT IN CONFIG (13/7)**: `health_config.ricarico_floor_pct` (SubitoFarma 11, Farmastelia 13, default fascia). OGNI pezzo di codice che calcola floor DEVE leggere da lì — mai hardcodare (il floor 15% hardcoded nell'igiene ha falciato 225 PC legali di FS il 13/7 alle 06:00).

## 2. LA REGOLA AUREA PREZZI (perimetro VERO dettato dal capo 12/7 — INVIOLABILE)
**Il concetto cardine: MAI ALZARE i prezzi su prodotti già ben posizionati** (il trauma TIOBEC/harvest).
1. **Regole MURO (type 4) = territorio FB al 100%**: NESSUN prezzo AI, mai
2. **Regole SCONTO (type 2) = promozioni del cliente**: MAI price cut
3. **Cut permessi su**: **Salva Bilancio (type 3) SEMPRE** + **Ricarico (type 1) SOLO con vendite di RETE consolidate** (≥2 ordini/30g su qualunque tenant)
4. **Mai sotto il costo d'acquisto VERO** (`erp_purchase_cost` con stock fisico; `erp_cost` = min_cost fornitore, NON è il costo pagato!)
5. **Mai sopra il prezzo regola FB** (`sell_price`) — rialzi VIETATI (harvest/calibratore sospesi)
6. **Movimenti da 1 CENTESIMO su riferimento LIVE** (scala dallo scrape fresco ≤48h), mai da cache
- **I TIPI regola sono in `rule_data->>'type'`: 1=Ricarico, 2=Sconto, 3=SB, 4=Muro — MAI euristiche su nomi/soglie** (mig. 051-052)
- Enforcement: `is_price_cut_allowed()` + trigger `trg_veto_sotto_costo_fn` (log FUORI_PERIMETRO_CUT/REGOLA_MURO/SOTTO_COSTO/SOPRA_REGOLA_FB) + `trg_veto_brand_protetti`. Log: `basket_veto_log`

## 2b. 🪂 I DUE PARACADUTE DEL FEED (capo 12/7 sera: "se continuiamo a troncare i feed andiamo in bancarotta")
1. **Paracadute CSV** (recalculateStableCache): un rebuild non può restringere il feed oltre il **−10%** in un colpo → feed precedente MANTENUTO + Telegram + serve decisione umana. Bypass deliberato: `health_config.feed_drop_guard_off='1'`. (Il 7/7 su Farmastelia avrebbe fermato il crollo da 55k a 32k.)
2. **Tetto condanne giornaliero** (mig. 055, trigger DB): quarantene+killer+REMOVE per tenant limitati a **max(150, 1% del feed)/giorno** — oltre: veto CAP_GIORNALIERO. Un burner vero non scappa; un feed troncato non si recupera.

## 3. LE SETTE CLASSI PROTETTE (mai bloccabili — `is_feed_protected()`)
1. **Carrello** (≥2 ordini 90g, o 1 con margine carrello ≥ costo click) — il DICTAT
2. **Brand protetti** (`killer_protected_brands` per tenant: UNI/GAD/MYC/EUC su MPF…) — linea TUTTA online in ogni gate
3. **Stock fisico** (erp ≥5 pz + MOL ≥20%) — la regola aurea del magazzino
4. **Venduto seller FB** (`sales_30d_seller > 0`)
5. **TOP 10 di posizione** — la visibilità è sacra
6. **Freschezza**: dati prodotto >12h = NESSUNA condanna possibile (fail-closed)
7. **Coorte fresca <72h** (mig. 050, 12/7): chi è appena stato attivato ha diritto all'osservazione — la notte post-sblocco i motori avevano condannato 781 liberati dopo poche ORE con 3-4 click. La soglia vera è dinamica (margine/CPC×1.5), mai 3-click fissi su un neonato
+ **Trend in salita** (entrante/caldo): bloccato con domanda in crescita = evidenza scaduta → decade a ogni ciclo igiene
- Enforcement: trigger `trg_veto_basket_*` su killer/quarantene/REMOVE + amnistia ORARIA (poller) + ciclo igiene 4×

## 4. L'ORDINE DEI RAGIONAMENTI (11/7)
**Prima i dati freschi, poi il giudizio, poi (ultima) la condanna.** Aggiungere = ok anche su dati imperfetti; togliere = solo dati <6-12h e zero segnali di merito. Ordine ondate: 1° sync, 2° liberazioni/ADD, 3° prezzi, 4° blocchi (batch piccoli + checkpoint).
**Regola del capo (11/7 sera): controlla SEMPRE a quanto risale l'ultimo update — i dati cambiano veloci.** Ogni analisi/risposta/decisione parte dal timestamp (products.updated_at, scraper scraped_at, ultimo import ordini, updated_at del CSV) e lo DICHIARA. Dato più vecchio del suo ciclo naturale (prodotti >2h, scraper >48h, ordini >1h) = prima ri-sincronizza o segnala, poi ragiona.

## 5. GLI ORARI SACRI (tutto sincronizzato coi passaggi TP)
| Ora (Italia) | Cosa | Servizio |
|---|---|---|
| 00:05 | 🌙 Briefing di mezzanotte (piano di battaglia) | midnightBriefing |
| **06:00 / 11:00 / 14:00 / 18:00** | 🧹 **CICLO IGIENE**: amnistia 7 classi + trend-risers + oblio-meriti + prezzi derivati + caccia opportunità + **cut-back prezzi-saliti** (ordine capo 12/7: venduti col prezzo salito → 4° base −1c, solo SB, solo con dump pieno fresco ≥50k) + REBUILD TOTALE | feedHygieneCycle |
| **06:10 / 11:10 / 14:10 / 18:10** | 🎯 **PARETO AI** (Fable 5, fallback Opus su quota): cut SB sul Pareto-set, scala 1°-4°, banda d'oro, visibilità sana | paretoPositioner |
| Ogni ora | Poller scraper (import + riprezzo su slice nuova + amnistia oraria) | scraperPoller |
| Ogni ora (+8min) | 📦 Sentinella consegne scraper: piena/decimata/silenzio → Telegram (ordine capo 11/7) | scraperDeliveryWatch |
| Ogni ora (+90s) | 💾 Monitor disco: avviso >92%, critico >95% | diskMonitor |
| Ogni ora | Sync prodotti (costi!) e ordini | productSync/orderSync |
| Ogni 2h | Sirene: silenzio assoluto, DATI STANTII (**→ AUTO-SYNC**, non solo alert), venditori-fuori-dal-CSV | salesAnomalyMonitor |
| Ogni 2h | Mirror prezzi applicati da Magento | appliedPriceMirror |
| 07:45 | Winback + amnistia completa + refresh sku_basket_stats | winbackMonitor |
| 08:10-10:15 | Verdetto dieta / posizioni / priceJump / banda d'oro / trend | costDiet, positionLog, priceJump, posEconomics, demandTrends |
| 08-22 ogni ora | ⚔️ Tabella operativa (Telegram 9/13/17/21 + allarme 2h sotto ritmo) | hourlyBattleCheck |
| Webhook | FB ci notifica slice scraper → reazione in SECONDI | POST /api/external/v1/scraper-updated |

## 6. IL CHECK QUOTIDIANO (rileggendo questo documento, verifica:)
1. `basket_veto_log`: i veti girano? Chi martella? (engine burner_high_incidence = rumore noto, conversione in agenda)
2. `ops_snapshots`: foto notturna vs mattina — venditori nel CSV mai in calo, blocchi-su-protetti = 0
3. Import: ordini/prodotti < 4-5h su OGNI tenant, scraper slice fresche, FB fetch recente (`feed_dispatch_log`)
4. Tutti i cron registrati al boot? (18-20 righe attese nei log)
5. PC applicati da FB (mirror): % applicazione sana (~90%)
6. I 12 check dell'audit completo (blocchi su protetti, scaduti, rec violazioni, prezzi alzati, venditori fuori, brand line, oblio, stantii)

## 7. TRAPPOLE NOTE (le cicatrici — non ricascarci)
- `sell_price` = prezzo REGOLA FB (si muove!); `exported_price` = esportato (incl. PrezzoAI); `applied_price` = Magento live; la verità TP = scrape. MAI usare cache come target
- `is_civetta` = TAG FB DIRETTO (`product_civetta`, sync orario per-prodotto, dal 11/7): Magento NON sovrascrive più (solo audit deriva 1×/g alle 03 UTC, alert >2%). UPDATE locali durano <1h. Il MERITO (pos ≤10 o venduto) tiene dentro il CSV, il flag non comanda
- Confronti orari: `order_date::time` è Europe/Rome, NOW() è UTC — AT TIME ZONE su entrambi
- Confronti giornalieri: stesso giorno-settimana, giorni ATTIVI (Papa!), MAI partial-day
- Zero click = budget TP esaurito (flag `tp_budget_exhausted`), non guasto — ma verifica che il flag non sia STANTIO
- Scraper Drive: `top_results.csv` = MAPPA listing visitati (~23k/passaggio, → `scraper_listing_map`); `results.csv` = dettaglio competitor. **RIPRISTINATO PIENO dal 12/7** (regression 9-12/7 risolta lato FB): 2-4 consegne piene/giorno, ~90-104k MINSAN/1,3-2,8M prezzi, file fino a 205MB (MAX_FILE_SIZE 500MB). Sentinella `scraperDeliveryWatch` ogni ora (PIENA ≥100k righe, sirena silenzio >16h). OGNI query che decide prezzi/posizioni DEVE filtrare `scraped_at >= NOW()-'48 hours'`; composizione listing giudicata sui dati ACCUMULATI, mai sulla singola consegna. I timestamp scraper sono in ORA ITALIANA, non UTC
- Giacenza Magento ≠ erp+supplier stock: i dropship con supplier_stock=1 hanno qty Magento >1 (SF: 4.053 SKU). Per confronti con query Magento usare stock>=1, non >1
- SubitoFarma: floor 11% (eccezione cliente), va sotto per scelta. MPF: alta marginalità by design (6% podio è normale), UNI/GAD/MYC/EUC intoccabili
- **TENANT STATISTICI (capo 12/7): San Vito e Ospedale NON sono operational** — pipe prezzi spente BY DESIGN (SV 9%, Ospedale 0% = normale, NON guasti). Flag `health_config.tenant_mode='statistical'`: NIENTE azioni prezzo su di loro (gate nel cut-back igiene; escluderli da ogni onda futura). Farmacri fermo = BUDGET TP finito (decisione cliente sul refill, non guasto)
- **Scraper post-ripristino (13/7): 2-4 consegne piene/giorno** (meglio del previsto ~12h): sirena silenzio a 16h, gate cut-back igiene a 14h. Finestre freschezza prezzi restano 48h
- I muri (N venditori stesso centesimo): salirci sopra = finire dietro a TUTTI. Ma il filtro muri vale per i RIALZI e gli scavalchi su regola Muro: per i TAGLI, 1 cent sotto un muro ESTERNO = batterli tutti insieme (14/7: la "mannaia muri" nelle onde escludeva a torto l'80% dei candidati — 8 top-click Mandanici su 11 avevano un muro da qualche parte nel listing)
- Deploy = docker cp + RESTART (senza restart gira il codice vecchio) — ma MAI restart con run AI/sync in volo
- psql multi-statement in un -c = UNA transazione; SSH di casa cade: run lunghi = docker exec -d o dentro il container
- `docker exec` SENZA `-i` non passa lo stdin: `psql < file.sql` via nohup gira a vuoto senza errori (13/7). Sempre `docker exec -i` per SQL da file
- FUOCO AMICO (13/7): dopo OGNI cambio di legge (funzioni/trigger/perimetro), grep di TUTTI i cleaner/igiene che applicano la legge vecchia PRIMA del prossimo giro sacro — l'igiene con `NOT is_salva_bilancio` + floor 15% hardcoded ha falciato ~1.100 PC legali in 2 giri (225 FS + ~880 rete). Ora: `is_price_cut_allowed`, scavalchi muro esclusi, floor da `ricarico_floor_pct`
- La rete si cannibalizza (4.113 listing fotocopia): coordinatore per-listing in attesa di policy leader dal capo

## 8. APERTI LATO CLIENTE (da sollecitare)
- Pipe prezzi FB→Magento: **Ospedale SPENTA** (996 azioni ferme), San Vito all'8%
- 548 PrezzoAI vecchi su prodotti MURO da azzerare sul pannello FB + regole con spunta "anche sotto costo"
- Farmastelia: 15.541 fantasmi TP (pannello TP/modulo feed)
- Webhook scraper: dev FB deve attivare la chiamata
- **RIPRISTINO DUMP SCRAPER COMPLETO (urgente, datato)**: fino all'8/7 arrivavano ~104k MINSAN/1,5M prezzi a consegna (results.csv ~90MB); dal 9/7 slice decimate a ~7,7k (2-6MB). Messaggio per il dev: "dal 9/7 il dump results.csv è passato da ~1,5M righe a ~80k per file — ripristinate il dump completo o indicateci il nuovo canale; i due Google Sheets 'results' comparsi nel folder sono mirror parziali, non il dump". Inoltre: timestamp in ora italiana (non UTC) — da uniformare
- Lista VIP scraper (top seller ogni passaggio) al fornitore
- SubitoFarma: 123 venditori con competitor sotto floor 11% — decisione eccezione
- Policy coordinatore di rete (chi vince il listing conteso: stock? margine? tenant fisso?)
- ~~RESIZE DISCO~~ ✅ FATTO 12/7: disco a 320GB (301 utili, 23% usato). Mandato capo: "mantenere quanti più dati possibili e giocare con le statistiche" → retention estese: scraper_competitors 30g, scraper_position_history 90g, scraper_listing_map 90g. Storici (health/action history) intatti. diskMonitor orario resta di guardia
