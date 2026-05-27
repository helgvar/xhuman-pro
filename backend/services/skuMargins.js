/**
 * SKU margin computation — the foundation of every optimization.
 *
 * For each civetta SKU of a tenant, compute the REAL net margin across multiple time windows:
 *   - pre-xHumanPro  (30g before go_live)
 *   - last_30d
 *   - last_15d
 *   - last_7d
 *
 * Margin formula (per window):
 *   gross_margin = revenue - cogs (qty × erp_cost)
 *   shipping_alloc = n_orders × tenant_shipping_cost  (oggi: sempre, finché non sappiamo la soglia free-ship)
 *   tp_cost = clicks × CPC
 *   net_margin = gross_margin - shipping_alloc - tp_cost
 *
 * Verdict logic ("dinamico, non statico"):
 *   - confronto net_margin/MOL% delle 3 finestre recenti vs baseline pre-xHumanPro
 *   - 'star'    → MOL stabilmente sopra baseline AND revenue NON crollato
 *   - 'win'     → MOL sopra baseline (anche se revenue lievemente sotto, comunque netto positivo)
 *   - 'ok'      → trend stabile
 *   - 'watch'   → MOL in calo o revenue in calo (uno solo)
 *   - 'loser'   → MOL sotto baseline AND revenue sotto baseline (perdita netta vs pre-xHuman)
 *   - 'burner'  → click 30g ma 0 ordini 60g (zero conversione, costo netto)
 *   - 'cold'    → 0 click 0 ordini (inerte: monitora ma non urgente)
 */

const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');
const { getTenantCpc } = require('./cpcConfig');

const DEFAULT_SHIPPING_COST = 4.90;

async function getTenantShippingCost(tenantId) {
  const { rows: [r] } = await pool.query(
    `SELECT config_value FROM tenant_configs WHERE tenant_id=$1 AND config_key='trovaprezzi_shipping_cost'`,
    [tenantId]
  );
  if (!r?.config_value) return DEFAULT_SHIPPING_COST;
  let val = r.config_value;
  try { val = decrypt(val); } catch {}
  const num = parseFloat(String(val).replace(',', '.'));
  return isFinite(num) && num > 0 ? num : DEFAULT_SHIPPING_COST;
}

async function getXHumanStartDate(tenantId) {
  const { rows: [r] } = await pool.query(
    `SELECT xhumanpro_start_date FROM tenants WHERE id=$1`, [tenantId]
  );
  return r?.xhumanpro_start_date || null;
}

/**
 * Compute SKU-level margins for a tenant over a given date range.
 * Returns array: [{ sku, rule_id, clicks, n_orders, qty, revenue, cogs, gross, tp_cost, shipping_alloc, net, mol_pct }]
 */
async function computeWindow(tenantId, fromDate, toDate, shippingCost, cpc) {
  if (cpc == null) cpc = await getTenantCpc(tenantId);
  // For each order line, allocate a share of the order's shipping cost to that SKU
  // proportional to the line's revenue (line_total / order_total).
  // This way a civetta line in a mixed cart absorbs only its weighted slice of shipping;
  // an order that's 100% civetta still attributes the full shipping to civetta SKUs.
  const { rows } = await pool.query(`
    WITH tp AS (
      SELECT product_code AS sku, SUM(clicks)::int AS clicks
      FROM zombie_clicks
      WHERE tenant_id = $1 AND fetch_date BETWEEN $2 AND $3
      GROUP BY 1
    ),
    order_lines AS (
      -- is_pickup=true per stati ritiro in farmacia: NO spedizione addebitata
      SELECT o.id AS order_id, oi.sku, oi.qty_ordered AS qty,
        COALESCE(oi.row_total_incl_tax, oi.row_total * 1.10) AS line_rev,
        (o.order_status IN ('Ritirato', 'ritiro_farmacia', 'ritiro_sede_tmp')) AS is_pickup
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.tenant_id = $1
        AND o.order_status IN ('complete','processing','Ritirato','ritiro_farmacia','ritiro_sede_tmp')
        AND o.order_date::date BETWEEN $2 AND $3
    ),
    order_totals AS (
      SELECT order_id, SUM(line_rev) AS tot_rev, BOOL_OR(is_pickup) AS is_pickup
      FROM order_lines GROUP BY order_id
    ),
    lines_with_shipping AS (
      SELECT ol.sku, ol.qty, ol.line_rev, ol.order_id,
        CASE
          WHEN ot.is_pickup THEN 0  -- Ritiro in farmacia: niente spese di spedizione
          WHEN ot.tot_rev > 0 THEN ($5::numeric * ol.line_rev / ot.tot_rev)
          ELSE 0
        END AS line_ship_alloc
      FROM order_lines ol JOIN order_totals ot ON ot.order_id = ol.order_id
    ),
    ord AS (
      SELECT sku,
        COUNT(DISTINCT order_id)::int AS n_orders,
        SUM(qty)::int                 AS qty,
        SUM(line_rev)::numeric        AS revenue,
        SUM(line_ship_alloc)::numeric AS shipping_alloc
      FROM lines_with_shipping GROUP BY sku
    )
    SELECT
      p.sku,
      p.price_rule_id,
      -- Cost effettivo: erp_cost reale se presente, altrimenti fallback all'imputed
      -- (avg per brand, popolato da migration 024).
      COALESCE(NULLIF(p.erp_cost, 0), p.erp_cost_imputed, 0) AS erp_cost,
      CASE
        WHEN p.erp_cost > 0 THEN 'real'
        WHEN p.erp_cost_imputed IS NOT NULL THEN 'imputed'
        ELSE 'missing'
      END AS cost_source,
      COALESCE(tp.clicks, 0)         AS clicks,
      COALESCE(ord.n_orders, 0)      AS n_orders,
      COALESCE(ord.qty, 0)           AS qty,
      ROUND(COALESCE(ord.revenue, 0)::numeric, 2)                                AS revenue,
      ROUND((COALESCE(ord.qty, 0) * COALESCE(NULLIF(p.erp_cost, 0), p.erp_cost_imputed, 0))::numeric, 2)        AS cogs,
      ROUND((COALESCE(tp.clicks, 0)::numeric * $4::numeric), 2)                  AS tp_cost,
      ROUND(COALESCE(ord.shipping_alloc, 0)::numeric, 2)                         AS shipping_alloc
    FROM products p
    LEFT JOIN tp ON tp.sku = p.sku
    LEFT JOIN ord ON ord.sku = p.sku
    WHERE p.tenant_id = $1 AND p.is_civetta = true
  `, [tenantId, fromDate, toDate, cpc, shippingCost]);

  // Derived fields
  for (const r of rows) {
    r.gross = +(parseFloat(r.revenue) - parseFloat(r.cogs)).toFixed(2);
    r.net = +(r.gross - parseFloat(r.tp_cost) - parseFloat(r.shipping_alloc)).toFixed(2);
    r.mol_pct = parseFloat(r.revenue) > 0
      ? +((r.net / parseFloat(r.revenue)) * 100).toFixed(1)
      : null;
  }
  return rows;
}

/**
 * Build SKU-level analysis across pre/30d/15d/7d windows and assign verdict.
 * Returns { sku, byWindow: {...}, deltas: {...}, verdict, signals: [...] }
 */
async function classifySkus(tenantId) {
  const shippingCost = await getTenantShippingCost(tenantId);
  const cpc = await getTenantCpc(tenantId);
  const goLive = await getXHumanStartDate(tenantId);
  const today = new Date(); today.setHours(0,0,0,0);

  const window = (daysBack, daysSpan) => {
    const to = new Date(today); to.setDate(to.getDate() - daysBack);
    const from = new Date(to);  from.setDate(from.getDate() - daysSpan + 1);
    return { from: from.toISOString().slice(0,10), to: to.toISOString().slice(0,10) };
  };

  // Baseline pre-xHuman: 30g prima del go-live (se goLive non valido, fall-back a 60-90g fa)
  let baselineRange;
  if (goLive) {
    const to = new Date(goLive); to.setDate(to.getDate() - 1);
    const from = new Date(to); from.setDate(from.getDate() - 29);
    baselineRange = { from: from.toISOString().slice(0,10), to: to.toISOString().slice(0,10) };
  } else {
    baselineRange = window(60, 30); // 60-90g fa
  }

  const ranges = {
    pre:  baselineRange,
    d30:  window(0, 30),
    d15:  window(0, 15),
    d7:   window(0, 7),
  };

  const [pre, d30, d15, d7] = await Promise.all([
    computeWindow(tenantId, ranges.pre.from, ranges.pre.to, shippingCost, cpc),
    computeWindow(tenantId, ranges.d30.from, ranges.d30.to, shippingCost, cpc),
    computeWindow(tenantId, ranges.d15.from, ranges.d15.to, shippingCost, cpc),
    computeWindow(tenantId, ranges.d7.from,  ranges.d7.to,  shippingCost, cpc),
  ]);

  const idx = (rows) => { const m = new Map(); for (const r of rows) m.set(r.sku, r); return m; };
  const mPre = idx(pre), m30 = idx(d30), m15 = idx(d15), m7 = idx(d7);

  // Universe = ogni SKU che appare in almeno una finestra
  const allSkus = new Set([...mPre.keys(), ...m30.keys(), ...m15.keys(), ...m7.keys()]);

  const out = [];
  for (const sku of allSkus) {
    const w = {
      pre: mPre.get(sku) || null,
      d30: m30.get(sku) || null,
      d15: m15.get(sku) || null,
      d7:  m7.get(sku)  || null,
    };

    // Verdict logic
    const signals = [];
    let verdict = 'cold';

    const cur = w.d30;
    const has = (x) => x && (x.clicks > 0 || x.n_orders > 0);

    if (!has(w.pre) && !has(cur) && !has(w.d15) && !has(w.d7)) {
      verdict = 'cold';
    } else if (cur && cur.clicks > 0 && cur.n_orders === 0) {
      verdict = 'burner';
      signals.push(`${cur.clicks} click 30g, 0 ordini → costo TP €${cur.tp_cost} netto perso`);
    } else if (cur && cur.n_orders > 0) {
      const curMol = cur.mol_pct;
      const preMol = w.pre?.mol_pct;
      const curRev = parseFloat(cur.revenue);
      const preRev = w.pre ? parseFloat(w.pre.revenue) : 0;

      if (preMol == null && curMol != null) {
        // No baseline → giudichiamo solo l'attuale
        verdict = curMol >= 20 ? 'star' : curMol >= 10 ? 'ok' : curMol >= 0 ? 'watch' : 'loser';
      } else if (preMol != null && curMol != null) {
        const dMol = +(curMol - preMol).toFixed(1);
        const dRev = preRev > 0 ? +((curRev - preRev) / preRev * 100).toFixed(1) : null;
        signals.push(`ΔMOL ${dMol >= 0 ? '+' : ''}${dMol}pp vs pre-xH`);
        if (dRev != null) signals.push(`Δrev ${dRev >= 0 ? '+' : ''}${dRev}%`);
        if (dMol >= 2 && (dRev == null || dRev >= -10)) verdict = 'star';
        else if (dMol >= 0 && (dRev == null || dRev >= -5)) verdict = 'win';
        else if (dMol >= -2 && (dRev == null || dRev >= -10)) verdict = 'ok';
        else if (cur.net < 0) verdict = 'loser';
        else verdict = 'watch';
      } else if (curMol != null) {
        verdict = curMol < 0 ? 'loser' : 'watch';
      }
    } else if (cur && cur.clicks === 0) {
      verdict = 'cold';
    }

    out.push({
      sku,
      rule_id: cur?.price_rule_id || w.d15?.price_rule_id || w.d7?.price_rule_id || w.pre?.price_rule_id,
      verdict,
      signals,
      windows: w,
    });
  }

  return { tenantId, goLive, shippingCost, cpc, ranges, skus: out };
}

/**
 * Aggregate SKU classification into per-rule summary + tenant-wide counts.
 */
function summarize(classification) {
  const ruleAgg = new Map();
  const tenantCounts = { star: 0, win: 0, ok: 0, watch: 0, loser: 0, burner: 0, cold: 0 };
  let netTotal30d = 0, revTotal30d = 0, costTotal30d = 0;

  for (const s of classification.skus) {
    tenantCounts[s.verdict] = (tenantCounts[s.verdict] || 0) + 1;
    const rid = s.rule_id || 'no_rule';
    if (!ruleAgg.has(rid)) {
      ruleAgg.set(rid, { rule_id: rid, by_verdict: { star:0, win:0, ok:0, watch:0, loser:0, burner:0, cold:0 },
        rev_30d: 0, net_30d: 0, tp_cost_30d: 0, n_skus: 0, sample_losers: [], sample_stars: [] });
    }
    const agg = ruleAgg.get(rid);
    agg.by_verdict[s.verdict]++;
    agg.n_skus++;
    if (s.windows.d30) {
      agg.rev_30d += parseFloat(s.windows.d30.revenue);
      agg.net_30d += s.windows.d30.net;
      agg.tp_cost_30d += parseFloat(s.windows.d30.tp_cost);
      revTotal30d += parseFloat(s.windows.d30.revenue);
      netTotal30d += s.windows.d30.net;
      costTotal30d += parseFloat(s.windows.d30.tp_cost);
    }
    if (s.verdict === 'loser' && agg.sample_losers.length < 5) agg.sample_losers.push(s.sku);
    if (s.verdict === 'star' && agg.sample_stars.length < 5) agg.sample_stars.push(s.sku);
  }

  for (const agg of ruleAgg.values()) {
    agg.rev_30d = +agg.rev_30d.toFixed(0);
    agg.net_30d = +agg.net_30d.toFixed(0);
    agg.tp_cost_30d = +agg.tp_cost_30d.toFixed(0);
    agg.mol_pct = agg.rev_30d > 0 ? +(agg.net_30d / agg.rev_30d * 100).toFixed(1) : null;
  }

  return {
    tenant_id: classification.tenantId,
    go_live: classification.goLive,
    shipping_cost: classification.shippingCost,
    ranges: classification.ranges,
    tenant_counts: tenantCounts,
    n_skus_total: classification.skus.length,
    tenant_rev_30d: +revTotal30d.toFixed(0),
    tenant_net_30d: +netTotal30d.toFixed(0),
    tenant_tp_cost_30d: +costTotal30d.toFixed(0),
    tenant_mol_pct: revTotal30d > 0 ? +(netTotal30d / revTotal30d * 100).toFixed(2) : null,
    by_rule: [...ruleAgg.values()].sort((a, b) => b.rev_30d - a.rev_30d),
  };
}

module.exports = { computeWindow, classifySkus, summarize, getTenantShippingCost, getXHumanStartDate };
