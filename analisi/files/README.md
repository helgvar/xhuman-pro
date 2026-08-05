# Algoritmi Trovaprezzi — pacchetto di test

Quattro algoritmi eseguibili **senza FarmaBooster e senza modelli statistici**.
Girano sulla sola matrice prezzi dello scraper e sui dati di performance del
pannello TP.

```
python3 run_demo.py     # genera un mercato sintetico e fa girare tutto
```

Il demo serve a validare la logica prima di collegare i dati veri: i concorrenti
sintetici hanno latenza di reazione **nota** (2h, 18h, 60h, mai), quindi si
verifica che A4 li separi correttamente. Se non li separa, il bug è nel codice.

---

## Cosa fa cosa

| | Algoritmo | Input necessario | Output |
|---|---|---|---|
| **A1** | `price_to_next_bivista` | matrice prezzi | rialzi a click invariati |
| **A2** | `step_map` | matrice prezzi | costo di ogni scavalco |
| **A3** | `rule_of_three` | click/ordini per SKU | sospensioni fondate |
| **A4** | `detect_overtakes` + `reaction_profile` | snapshot 2h storici | latenza e archetipo dei concorrenti |

A1 e A2 girano su **una sola fotografia** del mercato: risultato lo stesso
giorno. A4 ha bisogno di ~2 settimane di storico ma non tocca il feed, quindi
si può lanciare subito in sola osservazione mentre si sviluppa il resto.

---

## Contratto di input

```
snapshots.csv   ts, minsan, seller_id, price, shipping
own_catalog.csv minsan, cost, stock, price_page, category_id, cpc_category
own_perf.csv    minsan, clicks, orders, revenue_attributed
```

Due vincoli tassativi.

**Il Minsan si legge come stringa.** Sempre, in ogni punto della pipeline:

```python
pd.read_csv("snapshots.csv", dtype={"minsan": str})
```

Un solo passaggio in numerico mangia gli zeri iniziali, l'offerta si stacca
dalla scheda e continua a bruciare CPC in silenzio. `normalize_minsan()` li
recupera, ma la validazione va fatta **sul file di feed generato**, non
sull'attributo a monte.

**`revenue_attributed` è il fatturato dell'ordine intero**, attribuito allo SKU
cliccato — non il fatturato di riga. Su un AOV di €85 con scontrini multi-riga,
attribuire per riga fa apparire perdenti proprio le referenze civetta che
portano il carrello, e A3 le sospende.

---

## Sostituire i dati sintetici con i tuoi

```python
snap = pd.read_csv("snapshots.csv", dtype={"minsan": str},
                   parse_dates=["ts"])
catalog = pd.read_csv("own_catalog.csv", dtype={"minsan": str})
perf = pd.read_csv("own_perf.csv", dtype={"minsan": str})

ranked = dual_rank(snap)
now = latest_snapshot(ranked)

a1 = price_to_next_bivista(now, own_seller="subitofarma", catalog=catalog,
                           mode="rank1_only", units=perf.set_index("minsan")["orders"])
```

`make_market()` in `run_demo.py` si può cancellare del tutto una volta
collegati i dati veri.

---

## Tre cose che il demo ha già scoperto e che vanno tenute presenti

**1. Le due classifiche divergono sulla maggioranza del catalogo.**
Nel mercato sintetico il 69% degli SKU ha posizione diversa tra vista "prezzo" e
vista "prezzo+spedizione". Su quelli, ottimizzare guardando una sola classifica
significa guadagnare margine in una e crollare di posizioni nell'altra. Per
questo A1 usa `min(headroom_price, headroom_total)`.

**2. La latenza misurata non è il ciclo del repricer avversario.**
È il tempo di attesa residuo visto da te: se lui gira ogni C ore e tu tagli in
un istante casuale, lo becchi in media a C/2. Un ciclo da 18h si misura come
~9h. Per il pricing è la grandezza giusta — è quanto durerà davvero la
posizione che compri — ma non descrive il concorrente.

**3. Velocità e copertura sono due assi diversi.**
Un concorrente che risponde in 2 ore ma difende solo una parte del catalogo
produce moltissimi eventi "ignore". Una regola che guardi la percentuale di
non-reazione lo classifica *passivo*, e il motore lo attacca proprio dove è più
rapido a punirti. `reaction_profile()` tiene i due assi separati e introduce
l'archetipo `difensore_selettivo`; `defended_skus()` estrae la lista che
presidia davvero. Tutto il resto del suo catalogo è terreno libero.

---

## Limite strutturale, da leggere prima di usare A4

Con snapshot ogni 2 ore **non è misurabile una latenza inferiore a 2 ore**. Un
concorrente che ripriza più in fretta della frequenza di scraping non genera mai
un evento di scavalco osservabile: nei dati risulta semplicemente sempre davanti.

Il rischio è un'inversione: il concorrente più aggressivo sparisce dal report e
chi legge conclude che non esiste. `unmeasurable_sellers()` intercetta questo
caso e lo marca come il più veloce di tutti, non come assente.

---

## Guardrail già implementati

- `mode="rank1_only"` di default in A1: agisce solo dove sei primo in entrambe
  le viste, quindi dopo il rialzo sei ancora primo e nessun click è a rischio.
  `mode="any_rank"` preserva il rango ma allarga il gap dal leader, e la quota
  di click dipende anche dal gap: **non usarlo prima di aver stimato la curva
  di resa** (modulo M2 della spec).
- `apply_cut_cap()`: massimo 5% del fatturato TP sospeso a settimana.
- A3 non giudica mai uno SKU con match rotto → verdetto `FIX_MATCH`.
  Sospendere uno SKU sano che ha solo il codice rotto è l'errore più costoso
  del sistema: esce dal feed e non rientra fino al reintegro bimestrale.
- A3 non tocca gli SKU a zero click → `KEEP_SILENT`. Costo zero, opzione
  gratuita. Si taglia solo dove ci sono click a vuoto.
