"""
tp_algos.tp_rules — le tre regole eseguibili senza modelli statistici.

A1  price_to_next_bivista   alza il prezzo fin sotto il concorrente successivo,
                            vincolato dalla PIU' STRETTA delle due classifiche
A2  step_map                mappa dei gradini: quanto costa scavalcare chi ti precede
A3  rule_of_three           sospensione statisticamente fondata degli SKU zombie
"""

import numpy as np
import pandas as pd

EPS = 0.01  # sottoquota minima: un centesimo


# ------------------------------------------------------------------ A1

def price_to_next_bivista(
    snap_now: pd.DataFrame,
    own_seller: str,
    catalog: pd.DataFrame,
    mode: str = "rank1_only",
    min_gap_pct: float = 0.015,
    max_raise_pct: float = 0.15,
    min_margin_pct: float = 0.05,
    units: pd.Series | None = None,
) -> pd.DataFrame:
    """A1 — Price-to-next su doppia classifica.

    Alzando il prezzo di delta, ENTRAMBE le chiavi (prezzo e prezzo+spedizione)
    salgono di delta, perche' la spedizione resta ferma. Il margine di manovra
    utilizzabile e' quindi il minimo dei due margini:

        headroom_v = key_del_concorrente_immediatamente_sopra_v - key_own_v - EPS
        delta      = min(headroom_price, headroom_total)

    Calcolarlo su una sola vista e' l'errore che fa guadagnare margine in una
    classifica mentre si scivola di posizioni nell'altra.

    mode
      'rank1_only'  (default, sicuro) agisce solo dove sei primo in ENTRAMBE le
                    viste: dopo il rialzo sei ancora primo, il gap al secondo
                    resta ~0.01, nessun click a rischio. Margine puro.
      'any_rank'    agisce a qualunque posizione. Preserva il RANK ma allarga il
                    GAP dal leader, e la quota di click dipende anche dal gap:
                    NON usarlo prima di aver stimato la curva di resa (M2).

    min_gap_pct   soglia sotto la quale non vale la pena muovere (rumore).
    units         venduto per SKU nel periodo, per quantificare il guadagno.
    """
    if mode not in ("rank1_only", "any_rank"):
        raise ValueError("mode deve essere 'rank1_only' o 'any_rank'")

    rows = []
    for minsan, g in snap_now.groupby("minsan"):
        me = g[g["seller_id"] == own_seller]
        if me.empty:
            continue
        me = me.iloc[0]
        others = g[g["seller_id"] != own_seller]
        if others.empty:
            continue

        head, ranks = {}, {}
        for v in ("price", "total"):
            k_me = me[f"key_{v}"]
            above = others[others[f"key_{v}"] > k_me][f"key_{v}"]
            # nessuno sopra di me = sono il piu' caro: nessun vincolo di rango
            head[v] = (above.min() - k_me - EPS) if len(above) else np.inf
            ranks[v] = int((others[f"key_{v}"] < k_me).sum()) + 1

        if mode == "rank1_only" and not (ranks["price"] == 1 and ranks["total"] == 1):
            continue

        delta = min(head["price"], head["total"])
        binding = "price" if head["price"] <= head["total"] else "total"
        if not np.isfinite(delta):
            delta = me["price"] * max_raise_pct
            binding = "unbounded"
        if delta <= 0:
            continue

        # cap prudenziale sul singolo movimento
        delta = min(delta, me["price"] * max_raise_pct)

        # gap corrente: se sei gia' incollato al concorrente non c'e' rendita
        gap_now = min(
            head["price"] / me["key_price"] if np.isfinite(head["price"]) else np.inf,
            head["total"] / me["key_total"] if np.isfinite(head["total"]) else np.inf,
        )
        if gap_now < min_gap_pct:
            continue

        new_price = np.floor((me["price"] + delta) * 100) / 100
        rows.append(
            dict(
                minsan=minsan,
                price_now=round(me["price"], 2),
                price_new=round(new_price, 2),
                delta=round(new_price - me["price"], 2),
                delta_pct=round((new_price - me["price"]) / me["price"], 4),
                headroom_price=round(head["price"], 2) if np.isfinite(head["price"]) else None,
                headroom_total=round(head["total"], 2) if np.isfinite(head["total"]) else None,
                binding_view=binding,
                pos_price=ranks["price"],
                pos_total=ranks["total"],
                n_offers=int(len(g)),
            )
        )

    out = pd.DataFrame(rows)
    if out.empty:
        return out

    # floor di margine: mai sotto costo + soglia (qui il rialzo non puo' violarlo,
    # ma il controllo resta per il caso in cui A1 venga usato anche al ribasso)
    if "cost" in catalog.columns:
        out = out.merge(catalog[["minsan", "cost"]], on="minsan", how="left")
        floor = out["cost"] * (1 + min_margin_pct)
        out["price_new"] = np.maximum(out["price_new"], floor.fillna(0))
        out["delta"] = (out["price_new"] - out["price_now"]).round(2)

    if units is not None:
        out = out.merge(units.rename("units").reset_index(), on="minsan", how="left")
        out["units"] = out["units"].fillna(0)
        out["margin_gain"] = (out["delta"] * out["units"]).round(2)
        out = out.sort_values("margin_gain", ascending=False)
    return out.reset_index(drop=True)


# ------------------------------------------------------------------ A2

def step_map(snap_now: pd.DataFrame, own_seller: str, view: str = "total") -> pd.DataFrame:
    """A2 — Mappa dei gradini.

    La curva click/prezzo non e' continua. Ridurre il prezzo dell'1% non da'
    l'1% di click in piu': non da' nulla finche' non scavalchi qualcuno, poi da'
    un blocco intero di click tutto insieme. Questa funzione elenca, per ogni
    SKU, ogni singolo gradino: prezzo necessario, costo del salto, posizioni
    guadagnate.

    Il valore del salto (quanti click vale) arriva da M2, non da qui. Questo
    modulo produce solo il COSTO, che e' gia' sufficiente per scartare a priori
    i salti troppo cari.
    """
    key = f"key_{view}"
    rows = []
    for minsan, g in snap_now.groupby("minsan"):
        me = g[g["seller_id"] == own_seller]
        if me.empty:
            continue
        me = me.iloc[0]
        below = g[(g["seller_id"] != own_seller) & (g[key] < me[key])].sort_values(
            key, ascending=False
        )
        my_rank = len(below) + 1
        for n_over, (_, comp) in enumerate(below.iterrows(), start=1):
            needed = comp[key] - EPS
            rows.append(
                dict(
                    minsan=minsan,
                    view=view,
                    rank_now=my_rank,
                    rank_target=my_rank - n_over,
                    beats=comp["seller_id"],
                    price_needed=round(needed - me["shipping"] if view == "total" else needed, 2),
                    cut=round(me[key] - needed, 2),
                    cut_pct=round((me[key] - needed) / me[key], 4),
                    positions_gained=n_over,
                )
            )
    return pd.DataFrame(rows)


def wasted_margin(snap_now: pd.DataFrame, own_seller: str) -> pd.DataFrame:
    """Rendita non incassata: quanto stai regalando dove sei gia' primo.
    E' la fotografia sintetica di cio' che A1 recupera."""
    a1 = price_to_next_bivista(
        snap_now, own_seller, pd.DataFrame({"minsan": []}), mode="rank1_only"
    )
    return a1


# ------------------------------------------------------------------ A3

def rule_of_three(
    perf: pd.DataFrame,
    catalog: pd.DataFrame,
    match_status: pd.Series | None = None,
    cr_target: float = 0.05,
    margin_pct: float = 0.20,
    aov: float = 85.75,
) -> pd.DataFrame:
    """A3 — Regola del tre.

    Con 0 conversioni su n click, il limite superiore al 95% della CR vera e'
    3/n. Sopra quella soglia non stai pagando uno SKU sfortunato: stai pagando
    uno SKU che non converte.

    Test di sospensione, in versione economica (piu' netta della sola soglia
    sui click): sospendi se anche NELLO SCENARIO PIU' OTTIMISTA compatibile con
    i dati lo SKU perde soldi

        (3/n) * aov * margin_pct  <  cpc_categoria

    PRECONDIZIONE OBBLIGATORIA: match_status == 'ok'.
    Sospendere uno SKU sano che ha solo il codice rotto e' l'errore piu' costoso
    del sistema: esce dal feed e non rientra fino al reintegro bimestrale.
    """
    df = perf.merge(catalog[["minsan", "cpc_category"]], on="minsan", how="left")
    if match_status is not None:
        df = df.merge(match_status.rename("minsan_flag").reset_index(), on="minsan", how="left")
    else:
        df["minsan_flag"] = "ok"

    df["click_threshold"] = int(np.ceil(3 / cr_target))
    df["cr_upper_95"] = np.where(df["orders"] == 0, 3 / df["clicks"].clip(lower=1), np.nan)
    df["rpc_upper"] = df["cr_upper_95"] * aov * margin_pct
    df["spend"] = (df["clicks"] * df["cpc_category"]).round(2)

    df["verdict"] = np.select(
        [
            df["minsan_flag"] != "ok",
            df["orders"] > 0,
            df["clicks"] == 0,
            (df["clicks"] >= df["click_threshold"]) & (df["rpc_upper"] < df["cpc_category"]),
        ],
        [
            "FIX_MATCH",       # non giudicabile: prima ripara il codice
            "KEEP",
            "KEEP_SILENT",     # coda muta: costo zero, opzione gratuita, non si tocca
            "SUSPEND",
        ],
        default="WATCH",       # click a vuoto ma ancora dentro l'incertezza
    )
    return df.sort_values("spend", ascending=False).reset_index(drop=True)


def apply_cut_cap(df: pd.DataFrame, revenue_col: str, cap_pct: float = 0.05) -> pd.DataFrame:
    """Guardrail: non piu' del 5% del fatturato TP sospeso a settimana.
    Un errore di regola deve essere visibile prima di diventare irreversibile."""
    tot = df[revenue_col].sum()
    cand = df[df["verdict"] == "SUSPEND"].sort_values("spend", ascending=False).copy()
    cand["cum"] = cand[revenue_col].cumsum()
    keep = cand[cand["cum"] <= tot * cap_pct].index
    out = df.copy()
    out.loc[cand.index.difference(keep), "verdict"] = "SUSPEND_QUEUED"
    return out
