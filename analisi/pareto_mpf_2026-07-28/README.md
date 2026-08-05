# Pareto MPF — Riattivazione feed 28/07/2026

Tenant: **MPF / Personal Farma** (`d581c087-6b92-4050-b52a-5bd5c087553a`).
Obiettivo: SKU Pareto (top 80% fatturato rete 90g) disponibili in MPF (farmacia/grossista), FUORI dal feed, riposizionabili da soli o via price-cut, senza sfondare il floor ricarico. Tutto capo-firmato `sessione_capo_28lug`.

## Risultato eseguito
- **337 ADD** floor-safe (Wave-1) — standalone, undercut competitor esterno, ricarico ≥ floor al costo live, posizione predetta 1.
- **21 PC** floor-safe (Wave-2) — 8 Salva Bilancio + 13 Ricarico pos>4, cut a `comp_min−1c`, mai sotto costo, mai Sconto/Muro.
- **11 ritirati** dal guardiano-costo (Wave-1 iniziale 348 → 337): 10 sotto-floor + 1 sotto-costo (SKU 042154029).

## Guardiano-costo (dottrina applicata)
Ogni azione riconfermata sul **costo del momento** (`costo_vero`), prezzo reale (`prezzo_vero` = applied/exported, mai listino), freschezza sync ≤4h + scraper ≤4h. Floor ricarico per fascia: <10€→18%, 10–30€→14%, >30€→12%. Mai brand protetti (UNI/GAD/MYC/EUC/Eucerin/Gibaud/Ceramol), mai capo_pin, mai oblio attivo.

## File
| File | Cosa |
|------|------|
| `pareto_mpf.sql` / `pareto_csv.sql` | query analisi Pareto∩MPF∩fuori-feed∩positionability |
| `pareto_mpf.csv` | export completo (2168 SKU candidati con verdetto) |
| `pareto_mpf.html` | cruscotto analisi (1360 positionabili floor-safe) |
| `build_pareto.py` | generatore cruscotto |
| `wave1_add.sql` | Wave-1: INSERT feed_actions ADD standalone floor-safe |
| `wave2_pc.sql` | Wave-2: INSERT feed_actions PRICE_CUT floor-safe + guardiano |
| `retract.sql` | ritiro 11 ADD sotto-floor/sotto-costo |
| `mpf_solo.sql` | vista MPF-standalone: cliccato/zero-ordine-MPF, breakdown blocker |
| `mpf_cut_all.sql` | taglio no-vendita-MPF (364 landed, 1211 bloccati da trigger rete) |
| `mpf_after.sql` | breakdown bloccati-da-trigger (basket/vendente/brand) |
| `mpf_cut_done.csv` / `mpf_cut_detail.csv` | dettaglio tagliati |
| `mpf_tagliati.html` / `mpf_cut_audit.html` | cruscotti taglio |
| `mpf_costo.sql` / `mpf_costo2.sql` | audit freschezza costi + wrong-price |
| `mpf_minsan.sql` | verifica minsan protetti vs vendite reali |

## Da fare (post-scrape 29/07)
- Verificare **posizione REALE** dei 337 ADD + 21 PC dopo lo scrape.
- Se un costo si muove o uno SKU non entra top: guardiano ritira.
- Wave-3 REINSERISCI a prezzo FB (320): dopo misura, verifica floor-safe post-build.
