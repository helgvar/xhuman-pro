"""
tp_core — normalizzazione, audit abbinamento, doppio ranking.

CONTRATTO DI INPUT (CSV o DataFrame)

snapshots.csv        ts, minsan, seller_id, price, shipping
    Una riga per offerta presente sulla scheda a quel timestamp.
    'minsan' DEVE essere letto come stringa: pd.read_csv(..., dtype={'minsan': str})

own_catalog.csv      minsan, cost, stock, price_page, category_id, cpc_category
own_perf.csv         minsan, clicks, orders, revenue_attributed
    revenue_attributed = fatturato dell'ORDINE intero attribuito allo SKU cliccato,
    non il fatturato di riga.
"""

import re
import numpy as np
import pandas as pd

MINSAN_RE = re.compile(r"^[0-9]{9}$")


# ---------------------------------------------------------------- normalizzazione

def normalize_minsan(value) -> str:
    """Riporta il Minsan a 9 cifre stringa. Recupera gli zeri iniziali mangiati
    da una coercizione numerica avvenuta a monte (il caso di gran lunga piu'
    frequente di distacco dell'offerta dalla scheda)."""
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return ""
    s = str(value).strip()
    if s.endswith(".0"):          # residuo tipico di un passaggio in float
        s = s[:-2]
    s = re.sub(r"[^0-9]", "", s)
    if 0 < len(s) < 9:            # zeri iniziali persi -> ripristinabili
        s = s.zfill(9)
    return s


def audit_minsan(df: pd.DataFrame, col: str = "minsan") -> pd.DataFrame:
    """Aggiunge minsan_norm e un flag diagnostico per riga.

    'zero_stripped' e' recuperabile automaticamente.
    'invalid' va aperto a mano: quasi sempre kit/bundle senza Minsan proprio,
    che per definizione non agganciano mai la scheda.
    """
    out = df.copy()
    raw = out[col].astype(str)
    out["minsan_norm"] = raw.map(normalize_minsan)
    out["minsan_flag"] = np.select(
        [
            ~out["minsan_norm"].str.match(MINSAN_RE),
            (raw.str.replace(r"\D", "", regex=True).str.len() < 9)
            & out["minsan_norm"].str.match(MINSAN_RE),
        ],
        ["invalid", "zero_stripped"],
        default="ok",
    )
    return out


def match_rate(df: pd.DataFrame, by: str = "category_id") -> pd.DataFrame:
    """Tasso di abbinamento per categoria. KPI di primo livello: finche' non e'
    alto e stabile, ogni altra metrica per SKU mente."""
    g = df.groupby(by)["minsan_flag"]
    return pd.DataFrame(
        {"n_sku": g.size(), "ok": g.apply(lambda s: (s == "ok").sum())}
    ).assign(match_rate=lambda d: (d["ok"] / d["n_sku"]).round(4)).reset_index()


# ---------------------------------------------------------------- doppio ranking

def dual_rank(snap: pd.DataFrame) -> pd.DataFrame:
    """Calcola le DUE posizioni simultanee di ogni offerta.

    Trovaprezzi espone sia l'ordinamento per solo prezzo sia quello per
    prezzo+spedizione: ogni offerta vive in due classifiche contemporaneamente
    e va ottimizzata sul vincolo piu' stretto.
    """
    out = snap.copy()
    out["key_price"] = out["price"]
    out["key_total"] = out["price"] + out["shipping"]
    grp = ["ts", "minsan"]
    out["pos_price"] = out.groupby(grp)["key_price"].rank(method="min").astype(int)
    out["pos_total"] = out.groupby(grp)["key_total"].rank(method="min").astype(int)
    out["n_offers"] = out.groupby(grp)["seller_id"].transform("size")
    for v in ("price", "total"):
        out[f"best_{v}"] = out.groupby(grp)[f"key_{v}"].transform("min")
        out[f"gap_{v}"] = (out[f"key_{v}"] - out[f"best_{v}"]) / out[f"best_{v}"]
    return out


def latest_snapshot(snap: pd.DataFrame) -> pd.DataFrame:
    """Ultima fotografia disponibile del mercato."""
    return snap[snap["ts"] == snap["ts"].max()].copy()
