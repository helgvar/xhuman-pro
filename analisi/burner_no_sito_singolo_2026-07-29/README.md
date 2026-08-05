# Burner che NON vendono sul sito singolo — tutti i tenant operativi (29/07/2026)

## Definizione
Burner = SKU con **click TP negli ultimi 30gg** (costo = click × €0,3294) e **ZERO ordini su QUEL tenant negli ultimi 90gg** (order_status NOT IN canceled/closed/pending_payment). Rete IGNORATA di proposito. Solo stock>0 (erp o grossista). Tenant operativi: Mandanici, Procaccini, Farmainsieme, Farmastelia, MPF, Papa, SubitoFarma (esclusi San Vito/Ospedale statistici, Farmacri budget congelato).

## Riepilogo (30gg)
| tenant | burner | spesa €/30g | brand-prot | tagliabili | spesa tagliabile | di cui vende-rete 15g |
|--------|-------:|-----------:|-----------:|-----------:|-----------------:|----------------------:|
| Farmastelia | 5028 | 3468 | 0 | 5028 | 3468 | 1550 |
| SubitoFarma | 4206 | 3025 | 0 | 4206 | 3025 | 863 |
| MPF | 4273 | 2591 | 237 | 4036 | 2263 | 1190 |
| Procaccini | 3112 | 2291 | 46 | 3066 | 2260 | 569 |
| Papa | 3775 | 2245 | 79 | 3696 | 2191 | 908 |
| Mandanici | 2586 | 1570 | 0 | 2586 | 1570 | 900 |
| Farmainsieme | 876 | 490 | 0 | 876 | 490 | 274 |
| **TOTALE** | **23856** | **~15680** | **362** | **23494** | **~15267** | **6254** |

Spesa tagliabile ≈ **€15,3k/30gg ≈ €509/giorno**. La colonna `vende-rete 15g` (6254 SKU) = quelli oggi salvati SOLO dall'evidenza rete: sono il target del taglio "senza considerare la rete".

## Set TAGLIO PULITO — zero vendite ovunque 15gg (29/07)
Sottoinsieme dei tagliabili che NON vendono da nessuna parte in 15gg (né rete né sito) e non qui in 90gg, stock>0, non brand. Nessun veto li salva — passano anche la guardia 15gg. Taglio incontestabile.

| tenant | burner | spesa €/30g | €/giorno |
|--------|-------:|-----------:|---------:|
| SubitoFarma | 3355 | 2161 | 72.0 |
| Farmastelia | 3492 | 2033 | 67.8 |
| Procaccini | 2503 | 1691 | 56.4 |
| MPF | 2857 | 1494 | 49.8 |
| Papa | 2801 | 1485 | 49.5 |
| Mandanici | 1686 | 971 | 32.4 |
| Farmainsieme | 602 | 342 | 11.4 |
| **TOTALE** | **17296** | **~9977** | **~333** |

## ESEGUITO — taglio 29/07 (feed_quarantine)
17.302 SKU messi in quarantena. writer `sessione_capo_29lug`, motivo `taglio_coda_lunga_burner_zero_vendite_15gg_29lug`, `manual_override=true` (bypassa veto basket+vendente), brand escluso. Reattivazione lasciata possibile (dottrina OBLIO: chi ricomincia a vendere esce). Escono dal feed al prossimo build TP.

| tenant | tagliati |
|--------|-------:|
| Farmastelia | 3492 |
| SubitoFarma | 3357 |
| MPF | 2857 |
| Papa | 2804 |
| Procaccini | 2504 |
| Mandanici | 1686 |
| Farmainsieme | 602 |
| **TOT** | **17.302** |

## PERCHE il sistema non li escludeva da solo
- **16.934/17.302 (98%) SOTTO soglia killer** — il killer è margine-first PER-SKU: taglia solo se `costo_click ≥ 1,5×margine_vero` di quel sku. Solo 368 la superano.
- **Click medio 1,8/30gg, 15.953 (92%) con ≤3 click** — ognuno brucia ~€0,59/30gg, invisibile singolarmente. Il sistema valuta ogni SKU da solo, non somma mai il bleed collettivo. €333/gg = morte per 1000 tagli.
- Solo 436 stock-protetti (magazzino safety net), 1.939 con erp_stock>0.
- **GAP**: nessun motore taglia la coda lunga zero-conversione. Il killer caccia i grossi bruciatori, non le 17k formiche. Candidato a nuovo motore (aggregatore coda lunga).

## File
- `burner_no_sito_singolo.csv` — 23.864 righe (tutti i burner zero-vendita-sito 90gg, include chi vende in rete).
- `burner_zero_vendite_15gg.csv` — 17.300 righe (SET PULITO: zero vendite ovunque 15gg). Colonne: tenant, sku, nome_prod, clicks30, costo30_eur, erp_stock, supplier_stock, pos, costo, prezzo.

## Nota veti (check loop salva-rete 90gg)
Sul percorso di TAGLIO (feed_quarantine INSERT / feed_actions REMOVE) NON esiste alcun loop che salva su vendite-RETE a 90gg. La sola guardia rete è `vende_in_rete_15g` = **15 giorni** e per di più condizionata a "posizionato qui pos≤10" (`trg_veto_condanna_vendente_fn`). Il 90gg che esiste (`is_basket_protected`) è **PER-TENANT** (carrelli su QUESTO sito), non rete. Le protezioni rete a 30/90gg (`sales_30d_aggregated`, cross_tenant_oblio) vivono sul lato ADD/build, non bloccano i tagli.

Bypass per taglio deliberato: writer `sessione_%` + `manual_override=true` supera veto basket E veto vendente; resta solo il veto brand (strategia cliente, intoccabile).
