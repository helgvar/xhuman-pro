"""
run_demo — genera un mercato sintetico e fa girare tutte le regole end-to-end.

    python3 run_demo.py

Serve per validare la logica PRIMA di collegare i dati veri: i concorrenti
sintetici hanno comportamenti noti (uno e' un repricer veloce, uno e' passivo),
quindi si verifica che A4 li riconosca. Se A4 non li separa, il bug e' nel
codice, non nei dati.
"""

import numpy as np
import pandas as pd

from tp_core import audit_minsan, dual_rank, latest_snapshot, match_rate
from tp_reaction import (defended_skus, detect_overtakes, reaction_profile,
                         unmeasurable_sellers)
from tp_rules import apply_cut_cap, price_to_next_bivista, rule_of_three, step_map

RNG = np.random.default_rng(7)
OWN = "subitofarma"
COMPETITORS = {"veloce_srl": 2, "medio_spa": 18, "passivo_farma": 999, "lento_bio": 60}


def make_market(n_sku=300, days=14, step_h=2, uncontested_share=0.25):
    """Mercato sintetico con reazione a latenza NOTA, per validare A4.

    Ordinamento corretto degli eventi: il concorrente non puo' reagire nello
    stesso timestep in cui tagliamo, altrimenti lo scavalco non e' mai
    osservabile e A4 non ha nulla da misurare (era il primo bug emerso).
    """
    minsan = [str(RNG.integers(1, 999_999_999)).zfill(9) for _ in range(n_sku)]
    base = np.round(RNG.gamma(4, 6, n_sku) + 4, 2)
    ts_index = pd.date_range("2026-07-01", periods=int(days * 24 / step_h), freq=f"{step_h}h")

    ship = {OWN: 4.90, "veloce_srl": 5.90, "medio_spa": 0.0,
            "passivo_farma": 6.90, "lento_bio": 3.50}

    # su una quota di SKU i concorrenti sono strutturalmente piu' cari:
    # e' li' che vive la rendita non incassata che A1 deve trovare
    uncontested = RNG.random(n_sku) < uncontested_share
    price = {OWN: np.round(base * RNG.uniform(0.94, 1.02, n_sku), 2)}
    for s in COMPETITORS:
        mult = np.where(uncontested, RNG.uniform(1.10, 1.30, n_sku),
                        RNG.uniform(0.94, 1.12, n_sku))
        price[s] = np.round(base * mult, 2)

    hours_behind = {s: np.full(n_sku, -1.0) for s in COMPETITORS}
    rows = []
    for i, ts in enumerate(ts_index):
        # 1. fotografia dello stato corrente
        for s in [OWN, *COMPETITORS]:
            rows.append(pd.DataFrame({"ts": ts, "minsan": minsan, "seller_id": s,
                                      "price": price[s], "shipping": ship[s]}))

        # 2. reazione dei concorrenti allo stato GIA' fotografato
        mine_tot = price[OWN] + ship[OWN]
        for s, lat in COMPETITORS.items():
            behind = mine_tot < (price[s] + ship[s])
            hours_behind[s] = np.where(behind, np.where(hours_behind[s] < 0, 0.0,
                                                        hours_behind[s] + step_h), -1.0)
            react = behind & (hours_behind[s] >= lat) & ~uncontested
            price[s] = np.where(react,
                                np.round(np.maximum(mine_tot - 0.02, base * 0.6) - ship[s], 2),
                                price[s])
            hours_behind[s] = np.where(react, -1.0, hours_behind[s])

        # 3. il nostro seller taglia
        cut = RNG.random(n_sku) < 0.03
        price[OWN] = np.where(cut, np.round(price[OWN] * 0.97, 2), price[OWN])

    snap = pd.concat(rows, ignore_index=True)
    catalog = pd.DataFrame({
        "minsan": minsan, "cost": np.round(base * 0.72, 2),
        "stock": RNG.integers(0, 60, n_sku), "price_page": price[OWN],
        "category_id": RNG.choice(["derma", "integratori", "veterinaria"], n_sku),
        "cpc_category": RNG.choice([0.22, 0.33, 0.45], n_sku),
    })
    clicks = RNG.negative_binomial(3, 0.055, n_sku)
    perf = pd.DataFrame({"minsan": minsan, "clicks": clicks,
                         "orders": RNG.binomial(clicks, 0.045)})
    # zombie veri iniettati di proposito: servono a verificare che il ramo
    # SUSPEND scatti. Un demo che non esercita tutti i rami non valida nulla.
    zid = RNG.choice(n_sku, 15, replace=False)
    perf.loc[zid, "clicks"] = RNG.integers(70, 200, 15)
    perf.loc[zid, "orders"] = 0
    perf["revenue_attributed"] = (perf["orders"] * RNG.normal(85.75, 20, n_sku)).clip(0).round(2)
    return snap, catalog, perf


def main():
    snap, catalog, perf = make_market()
    print(f"snapshot: {len(snap):,} righe | {snap['minsan'].nunique()} SKU | "
          f"{snap['ts'].nunique()} finestre da 2h\n")

    # --- integrita' Minsan -------------------------------------------------
    cat_aud = audit_minsan(catalog)
    # rompo di proposito 12 codici come farebbe un export che li tratta da numero
    broken = cat_aud.sample(12, random_state=1).index
    cat_aud.loc[broken, "minsan_flag"] = "zero_stripped"
    print("== M1 tasso di abbinamento ==")
    print(match_rate(cat_aud).to_string(index=False), "\n")

    # --- doppio ranking ----------------------------------------------------
    ranked = dual_rank(snap)
    now = latest_snapshot(ranked)
    mine = now[now["seller_id"] == OWN]
    disagree = (mine["pos_price"] != mine["pos_total"]).mean()
    print(f"== M1 doppia classifica ==\nSKU con posizione DIVERSA tra le due viste: "
          f"{disagree:.1%}\n  -> su questi ottimizzare su una sola vista e' un errore\n")

    # --- A1 ----------------------------------------------------------------
    units = perf.set_index("minsan")["orders"]
    a1 = price_to_next_bivista(now, OWN, catalog, mode="rank1_only", units=units)
    print("== A1 price-to-next bivista (solo dove sei primo in entrambe) ==")
    if a1.empty:
        print("nessuna rendita da incassare\n")
    else:
        print(f"SKU azionabili: {len(a1)} | rialzo medio {a1['delta_pct'].mean():.2%} | "
              f"margine recuperato sul periodo: EUR {a1['margin_gain'].sum():,.2f}")
        print(f"vincolo che morde: {a1['binding_view'].value_counts().to_dict()}")
        print(a1.head(5)[["minsan", "price_now", "price_new", "binding_view",
                          "headroom_price", "headroom_total", "margin_gain"]].to_string(index=False), "\n")

    # --- A2 ----------------------------------------------------------------
    steps = step_map(now, OWN, view="total")
    print("== A2 mappa dei gradini ==")
    if not steps.empty:
        first = steps[steps["positions_gained"] == 1]
        print(f"gradini totali mappati: {len(steps):,}")
        print(f"costo mediano del PRIMO scavalco: {first['cut_pct'].median():.2%}")
        cheap = first[first["cut_pct"] < 0.005]
        print(f"scavalchi che costano <0.5%: {len(cheap)} -> candidati R2 prioritari\n")

    # --- A3 ----------------------------------------------------------------
    ms = cat_aud.set_index("minsan")["minsan_flag"]
    a3 = rule_of_three(perf, catalog, match_status=ms)
    a3 = apply_cut_cap(a3.merge(perf[["minsan", "revenue_attributed"]], on="minsan",
                                suffixes=("", "_y")), "revenue_attributed")
    print("== A3 regola del tre ==")
    print(a3["verdict"].value_counts().to_string())
    susp = a3[a3["verdict"] == "SUSPEND"]
    print(f"spesa recuperata sospendendo: EUR {susp['spend'].sum():,.2f}")
    print(f"SKU bloccati da match rotto (non giudicabili): "
          f"{(a3['verdict'] == 'FIX_MATCH').sum()}\n")

    # --- A4 ----------------------------------------------------------------
    print("== A4 reaction function ==")
    ev = detect_overtakes(ranked, OWN, view="total", horizon_h=72)
    prof = reaction_profile(ev)
    print(f"eventi di scavalco rilevati: {len(ev):,}")
    print(prof[["seller_id", "n_obs", "latency_median_h", "pct_undercut",
                "pct_ignore", "archetype"]].to_string(index=False))
    unm = unmeasurable_sellers(ranked, OWN, ev)
    if not unm.empty:
        print("\n-- concorrenti NON misurabili --")
        print(unm.to_string(index=False))
    sel = prof[prof["archetype"] == "difensore_selettivo"]["seller_id"]
    if len(sel):
        d = defended_skus(ev, sel.iloc[0])
        if not d.empty:
            print(f"\n-- {sel.iloc[0]}: segmentazione per SKU --")
            print(f"SKU presidiati: {int(d['defended'].sum())} / {len(d)} "
                  f"-> gli altri sono terreno libero")
    print("\nciclo vero iniettato nel simulatore (ore):", COMPETITORS)
    print("-> la mediana attesa e' ~ciclo/2: e' il tempo di attesa residuo,")
    print("   non il ciclo del repricer. E' la grandezza giusta per il pricing.")


if __name__ == "__main__":
    main()
