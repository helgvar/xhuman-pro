"""
tp_algos.tp_reaction — A4, reaction function dei concorrenti.

Gira in SOLA OSSERVAZIONE sugli snapshot 2h che gia' raccogli: non tocca il
feed, non richiede FarmaBooster, e in due settimane produce il parametro che
decide se un taglio di prezzo crea o distrugge valore.

    valore di un taglio = posizione guadagnata x DURATA prima che il
                          concorrente si riallinei

Contro un repricer che risponde in 3 ore, tagliare compra tre ore di posizione
e cede margine per sempre. Contro un seller lento, lo stesso taglio compra
settimane. Sono due decisioni opposte sullo stesso SKU: senza questo numero il
motore le tratta allo stesso modo.
"""

import numpy as np
import pandas as pd


def detect_overtakes(
    snap: pd.DataFrame,
    own_seller: str,
    view: str = "total",
    horizon_h: int = 72,
    match_tol: float = 0.005,
) -> pd.DataFrame:
    """Per ogni evento in cui SUPERI un concorrente, misura quanto ci mette a
    reagire e come.

    response_type
      'undercut'  ti ripassa sotto
      'match'     si allinea entro match_tol
      'adjust'    muove il prezzo ma resta sopra
      'ignore'    nessun movimento entro horizon_h
    """
    key = f"key_{view}"
    snap = snap.sort_values("ts")
    ts_all = np.sort(snap["ts"].unique())
    events = []

    for minsan, g in snap.groupby("minsan"):
        piv = g.pivot_table(index="ts", columns="seller_id", values=key, aggfunc="first")
        piv = piv.reindex(ts_all)
        if own_seller not in piv.columns:
            continue
        mine = piv[own_seller]

        for comp in piv.columns:
            if comp == own_seller:
                continue
            theirs = piv[comp]
            ahead = mine < theirs                     # sono davanti a lui
            valid = mine.notna() & theirs.notna()
            # transizione dietro -> davanti
            crossed = ahead & (~ahead.shift(1).fillna(False)) & valid & valid.shift(1).fillna(False)

            for t0 in piv.index[crossed]:
                p0 = theirs.loc[t0]
                fwd = theirs.loc[t0:]
                fwd = fwd[(fwd.index - t0) <= pd.Timedelta(hours=horizon_h)]
                moved = fwd[(fwd - p0).abs() > 0.001]
                if moved.empty:
                    events.append(
                        dict(minsan=minsan, seller_id=comp, ts=t0, latency_h=np.nan,
                             response_type="ignore", price_before=p0, price_after=np.nan)
                    )
                    continue
                t1, p1 = moved.index[0], moved.iloc[0]
                my_p = mine.loc[t1] if t1 in mine.index and pd.notna(mine.loc[t1]) else mine.loc[t0]
                if p1 < my_p:
                    rt = "undercut"
                elif abs(p1 - my_p) / my_p <= match_tol:
                    rt = "match"
                else:
                    rt = "adjust"
                events.append(
                    dict(minsan=minsan, seller_id=comp, ts=t0,
                         latency_h=(t1 - t0).total_seconds() / 3600.0,
                         response_type=rt, price_before=p0, price_after=p1)
                )
    return pd.DataFrame(events)


def reaction_profile(events: pd.DataFrame, min_obs: int = 5) -> pd.DataFrame:
    """Profilo per concorrente.

    ATTENZIONE ALL'INTERPRETAZIONE. La latenza mediana misurata NON e' il ciclo
    del repricer avversario: e' il TEMPO DI ATTESA RESIDUO visto da te. Se il
    concorrente gira ogni C ore e tu tagli in un istante casuale, lo becchi in
    media a C/2. Un ciclo da 18h si misura come ~9h.

    Per il pricing e' la grandezza giusta: quello che conta e' quanto durera'
    davvero la posizione che compri, non ogni quanto lui si sveglia. Non usarla
    pero' per descrivere il concorrente.

    Sotto min_obs osservazioni il profilo NON e' utilizzabile: 'insufficient'
    va trattato come ignoto, non come lento.
    """
    if events.empty:
        return pd.DataFrame()
    g = events.groupby("seller_id")
    prof = pd.DataFrame({
        "n_obs": g.size(),
        # latenza CONDIZIONATA all'aver reagito: e' la durata della posizione
        # che compri quando lui difende
        "latency_median_h": g["latency_h"].median(),
        "latency_p25_h": g["latency_h"].quantile(0.25),
        # copertura: su che quota degli scavalchi difende
        "pct_react": g["response_type"].apply(lambda s: (s != "ignore").mean()),
        "pct_undercut": g["response_type"].apply(lambda s: (s == "undercut").mean()),
        "pct_match": g["response_type"].apply(lambda s: (s == "match").mean()),
        "pct_ignore": g["response_type"].apply(lambda s: (s == "ignore").mean()),
    }).reset_index()

    # VELOCITA' E COPERTURA SONO DUE ASSI DIVERSI e vanno tenuti separati.
    # Confonderli produce l'errore piu' pericoloso del modulo: un repricer che
    # risponde in 2 ore ma difende solo il 15% del catalogo ha molti eventi
    # 'ignore', e una regola che guardi pct_ignore lo classifica 'passivo' ->
    # il motore lo attacca proprio dove lui e' piu' rapido a punirti.
    fast = prof["latency_median_h"] <= 4
    slow = prof["latency_median_h"] > 24
    wide = prof["pct_react"] >= 0.5

    prof["archetype"] = np.select(
        [
            prof["n_obs"] < min_obs,
            prof["latency_median_h"].isna(),
            fast & wide,
            fast & ~wide,
            slow,
        ],
        ["insufficient", "passivo", "repricer_veloce", "difensore_selettivo",
         "lento"],
        default="intermedio",
    )
    prof["cut_policy"] = prof["archetype"].map({
        "repricer_veloce": "NON tagliare: compri poche ore e cedi margine per sempre",
        "difensore_selettivo": "difende una LISTA: profila per SKU prima di attaccare, "
                               "veloce dove presidia e assente altrove",
        "lento": "taglio conveniente: la posizione dura giorni",
        "passivo": "non reagisce: soglia di esecuzione bassa",
        "intermedio": "valuta caso per caso con la curva di resa (M2)",
        "insufficient": "dati insufficienti: tratta come ignoto, non come lento",
    })
    return prof.sort_values("n_obs", ascending=False).reset_index(drop=True)


def defended_skus(events: pd.DataFrame, seller_id: str, min_events: int = 3,
                  react_thresh: float = 0.5) -> pd.DataFrame:
    """Per un difensore selettivo: QUALI SKU presidia davvero.

    E' la lista da non attaccare. Tutto il resto del suo catalogo e' terreno
    libero, e senza questa segmentazione il profilo aggregato e' inutilizzabile.
    """
    ev = events[events["seller_id"] == seller_id]
    if ev.empty:
        return pd.DataFrame()
    g = ev.groupby("minsan")
    out = pd.DataFrame({
        "n_events": g.size(),
        "pct_react": g["response_type"].apply(lambda s: (s != "ignore").mean()),
        "latency_median_h": g["latency_h"].median(),
    }).reset_index()
    out = out[out["n_events"] >= min_events]
    out["defended"] = out["pct_react"] >= react_thresh
    return out.sort_values(["defended", "pct_react"], ascending=False).reset_index(drop=True)


def unmeasurable_sellers(snap: pd.DataFrame, own_seller: str, events: pd.DataFrame,
                         view: str = "total", min_events: int = 3) -> pd.DataFrame:
    """LIMITE STRUTTURALE DEL METODO, da leggere prima di usare i profili.

    Con snapshot ogni 2h non puoi misurare una latenza inferiore a 2h. Un
    concorrente che ripriza piu' in fretta della tua frequenza di scraping non
    genera MAI un evento di scavalco osservabile: nei dati risulta semplicemente
    sempre davanti a te.

    Il risultato e' un'inversione pericolosa: il concorrente piu' aggressivo
    sparisce dal report, e chi legge conclude che non esiste. Va invece marcato
    come il PIU' veloce di tutti e trattato come il caso peggiore.
    """
    key = f"key_{view}"
    present = snap[snap["seller_id"] != own_seller]["seller_id"].unique()
    seen = set(events["seller_id"].unique()) if not events.empty else set()
    rows = []
    for s in present:
        n_ev = int((events["seller_id"] == s).sum()) if not events.empty else 0
        if n_ev >= min_events:
            continue
        sub = snap[snap["seller_id"].isin([s, own_seller])]
        piv = sub.pivot_table(index=["ts", "minsan"], columns="seller_id",
                              values=key, aggfunc="first").dropna()
        if piv.empty or s not in piv.columns or own_seller not in piv.columns:
            continue
        share_ahead = float((piv[s] < piv[own_seller]).mean())
        rows.append(dict(
            seller_id=s, n_events=n_ev, share_ahead_of_us=round(share_ahead, 3),
            diagnosis=("repricer sub-snapshot: piu' veloce della frequenza di "
                       "scraping, trattare come il piu' aggressivo"
                       if share_ahead > 0.5 else
                       "presenza marginale o mai in competizione diretta"),
        ))
    return pd.DataFrame(rows)


def cut_value(latency_h: float, demand_daily: float, delta_share: float,
              rpc: float, delta_price: float, units_daily: float,
              permanent: bool = True, horizon_days: int = 90) -> dict:
    """Valore atteso di un taglio, contro il suo costo.

    Il ricavo dura quanto la finestra di reazione. Il costo, se il concorrente
    si riallinea, dura per sempre: hai ceduto margine senza tenere la posizione.
    """
    gain = (latency_h / 24.0) * demand_daily * delta_share * rpc
    cost_days = horizon_days if permanent else latency_h / 24.0
    cost = delta_price * units_daily * cost_days
    return {"gain": round(gain, 2), "cost": round(cost, 2),
            "net": round(gain - cost, 2), "execute": gain > cost * 1.2}
