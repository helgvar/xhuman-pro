/**
 * A/B Test service — bid management su Trovaprezzi.
 *
 * Workflow:
 * 1. identifyCandidates(tenantId): trova SKU in pos TP 1 con alta CPA (click/ord)
 * 2. createTest(tenantId, sku, options): crea record ab_tests, calcola target_price,
 *    salva baseline. Status='pending_apply' fino a quando utente conferma su FB.
 * 3. markApplied(testId): utente conferma applicazione prezzo su Farmabooster, parte timer
 * 4. evaluateRunningTests(): cron orario, valuta ogni test attivo:
 *    - confronta orders nel periodo test vs baseline normalizzata sulla finestra
 *    - decide successful / rolled_back / extended in base a soglia 50% mantenimento
 * 5. rollbackTest(testId): se decisione rollback → log + Telegram per re-set prezzo
 *
 * Decision threshold:
 * - orders ratio >= 0.7 baseline → successful (mantiene)
 * - orders ratio < 0.5 baseline → rolled_back (ritorna prezzo orig)
 * - orders ratio 0.5-0.7 → inconclusive (estendi 24h)
 */

const { pool } = require('../db/pool');
const { sendTelegram, fmtEur } = require('./telegramNotifier');

const DEFAULT_BASELINE_DAYS = 14;
const DEFAULT_TEST_HOURS = 24;
const EXTENDED_TEST_HOURS = 48;
const MIN_BASELINE_CLICKS = 14;     // min click in baseline window per avere segnale
const MIN_BASELINE_ORDERS = 1;
const SUCCESS_RATIO = 0.7;
const ROLLBACK_RATIO = 0.5;

/**
 * Identifica SKU candidati A/B test: pos 1 TP, alta CPA, margine sufficiente.
 */
async function identifyCandidates(tenantId, opts = {}) {
  const days = opts.windowDays || 14;
  const minClicks = opts.minClicks || 20;
  const minCPA = opts.minCPA || 10;       // click per ordine minimo per candidare
  const minMolPct = opts.minMolPct || 15;

  const { rows } = await pool.query(`
    WITH zc AS (
      SELECT product_code AS sku, SUM(clicks)::int AS clk
      FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - $2::int
      GROUP BY 1
    ),
    ord AS (
      SELECT oi.sku, COUNT(DISTINCT o.id) AS n_ord,
        SUM(COALESCE(oi.row_total_incl_tax, oi.row_total*1.1)) AS rev
      FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE o.tenant_id = $1 AND o.order_date::date >= CURRENT_DATE - $2::int
        AND o.order_status IN ('complete','processing','Ritirato','ritiro_farmacia','ritiro_sede_tmp')
      GROUP BY 1
    ),
    snap AS (
      SELECT product_code AS sku, our_position, best_price, our_price, merchant_count,
        ROW_NUMBER() OVER (PARTITION BY product_code ORDER BY snapshot_date DESC) AS rn
      FROM competitor_snapshots WHERE tenant_id = $1 AND snapshot_date >= CURRENT_DATE - 7
    ),
    running AS (
      SELECT sku FROM ab_tests WHERE tenant_id = $1 AND status IN ('pending_apply', 'running')
    )
    SELECT p.sku, p.product_name, p.brand, p.sell_price,
      COALESCE(NULLIF(p.erp_cost,0), p.erp_cost_imputed, 0) AS cost,
      ROUND(((p.sell_price - COALESCE(NULLIF(p.erp_cost,0), p.erp_cost_imputed, 0))/NULLIF(p.sell_price,0)*100)::numeric, 1) AS mol_th,
      zc.clk AS clicks, ord.n_ord, ROUND(COALESCE(ord.rev, 0)::numeric, 2) AS rev,
      ROUND((zc.clk::numeric / NULLIF(ord.n_ord, 0))::numeric, 1) AS cpa,
      s.our_position, s.best_price, s.merchant_count
    FROM products p
    JOIN zc ON zc.sku = p.sku
    LEFT JOIN ord ON ord.sku = p.sku
    LEFT JOIN snap s ON s.sku = p.sku AND s.rn = 1
    LEFT JOIN running r ON r.sku = p.sku
    WHERE p.tenant_id = $1 AND p.is_civetta = true
      AND r.sku IS NULL
      AND zc.clk >= $3::int
      AND COALESCE(ord.n_ord, 0) >= 1
      AND (zc.clk::numeric / NULLIF(ord.n_ord, 0)) >= $4::numeric
      AND ((p.sell_price - COALESCE(NULLIF(p.erp_cost,0), p.erp_cost_imputed, 0))/NULLIF(p.sell_price,0)*100) >= $5::numeric
      AND (s.our_position = 1 OR s.our_position IS NULL)
      AND p.sell_price > 0
    ORDER BY (zc.clk::numeric / NULLIF(ord.n_ord, 0)) DESC LIMIT 100
  `, [tenantId, days, minClicks, minCPA, minMolPct]);

  return rows;
}

/**
 * Crea un A/B test per uno SKU. Calcola target_price per scendere a pos 2 o 3.
 * NB: il prezzo NON viene applicato automaticamente — l'utente deve farlo su Farmabooster.
 */
async function createTest(tenantId, sku, opts = {}) {
  const targetPos = opts.targetPosition || 2;
  const baselineDays = opts.baselineDays || DEFAULT_BASELINE_DAYS;
  const testHours = opts.testHours || DEFAULT_TEST_HOURS;
  const createdBy = opts.createdBy || 'system';

  // 1. Recupera prodotto + posizione + competitor
  const { rows: [prod] } = await pool.query(
    `SELECT p.sku, p.product_name, p.sell_price,
       COALESCE(NULLIF(p.erp_cost,0), p.erp_cost_imputed, 0) AS cost
     FROM products p WHERE p.tenant_id = $1 AND p.sku = $2`, [tenantId, sku]);
  if (!prod) throw new Error('SKU not found');

  // 2. Trova competitor in posizione targetPos e prima
  const { rows: comp } = await pool.query(
    `SELECT product_code, total_price, merchant, position
     FROM scraper_competitors WHERE product_code = $1
       AND updated_at > NOW() - INTERVAL '48 hours'
     ORDER BY position ASC LIMIT 10`, [sku]);
  if (!comp.length) throw new Error('No competitor data for this SKU');

  // Filtra fuori noi stessi (cerco la nostra posizione dal seller_name)
  const { rows: [tenantCfg] } = await pool.query(
    `SELECT config_value FROM tenant_configs WHERE tenant_id = $1 AND config_key = 'trovaprezzi_seller_name'`,
    [tenantId]);
  let ourSellerName = null;
  try { const { decrypt } = require('./crypto'); ourSellerName = decrypt(tenantCfg?.config_value); } catch {}

  const competitorsExt = comp.filter(c =>
    !ourSellerName || (c.merchant || '').toLowerCase().trim() !== ourSellerName.toLowerCase().trim()
  );
  if (!competitorsExt.length) throw new Error('No external competitors found');

  // Strategia: per scendere a pos N, dobbiamo essere SOPRA il prezzo del competitor che
  // attualmente è in posizione (N-1). Quindi prendiamo i competitor sopra di noi (prezzo>nostro)
  // ordinati per prezzo ASC e selezioniamo l'(N-2)-esimo (pos2→idx0, pos3→idx1).
  const above = competitorsExt
    .map(c => ({ ...c, price: parseFloat(c.total_price) }))
    .filter(c => c.price > parseFloat(prod.sell_price))
    .sort((a, b) => a.price - b.price);

  if (!above.length) {
    throw new Error(`Nessun competitor sopra il nostro prezzo €${prod.sell_price} (siamo gia' il piu' alto?)`);
  }

  const targetIdx = Math.max(0, targetPos - 2);
  const targetCompetitor = above[targetIdx] || above[above.length - 1];
  // target_price = competitor_price + €0.01 per stare immediatamente sopra di lui
  const targetPrice = +(targetCompetitor.price + 0.01).toFixed(2);

  // Safety: non aumentare il prezzo di più del 5% (test cauto)
  const maxIncrease = parseFloat(prod.sell_price) * 1.05;
  if (targetPrice > maxIncrease) {
    throw new Error(`Target price ${targetPrice} aumento >5% sul prezzo attuale ${prod.sell_price}, troppo aggressivo`);
  }

  if (targetPrice <= parseFloat(prod.sell_price)) {
    throw new Error(`Target price ${targetPrice} non porterebbe a scendere (current ${prod.sell_price})`);
  }

  // 3. Calcola baseline (window pre-test)
  const { rows: [base] } = await pool.query(`
    SELECT COALESCE(SUM(zc.clicks), 0)::int AS clicks,
      COALESCE(SUM(o.n_ord), 0)::int AS orders,
      COALESCE(SUM(o.rev), 0)::numeric AS revenue
    FROM (SELECT 1) x
    LEFT JOIN (SELECT SUM(clicks) AS clicks FROM zombie_clicks
               WHERE tenant_id = $1 AND product_code = $2 AND fetch_date >= CURRENT_DATE - $3::int) zc ON true
    LEFT JOIN (SELECT COUNT(DISTINCT o.id) AS n_ord, SUM(COALESCE(oi.row_total_incl_tax, oi.row_total*1.1)) AS rev
               FROM orders o JOIN order_items oi ON oi.order_id=o.id
               WHERE o.tenant_id = $1 AND oi.sku = $2 AND o.order_date::date >= CURRENT_DATE - $3::int
                 AND o.order_status IN ('complete','processing','Ritirato','ritiro_farmacia','ritiro_sede_tmp')) o ON true
  `, [tenantId, sku, baselineDays]);

  if ((base.clicks || 0) < MIN_BASELINE_CLICKS || (base.orders || 0) < MIN_BASELINE_ORDERS) {
    throw new Error(`Baseline insufficiente: ${base.clicks} click, ${base.orders} ord (min ${MIN_BASELINE_CLICKS}/${MIN_BASELINE_ORDERS})`);
  }
  const baselineCpa = base.orders > 0 ? +(base.clicks / base.orders).toFixed(2) : null;

  const evalAt = new Date(Date.now() + testHours * 3600 * 1000);
  const endAt  = new Date(Date.now() + EXTENDED_TEST_HOURS * 3600 * 1000);

  const { rows: [test] } = await pool.query(`
    INSERT INTO ab_tests (
      tenant_id, sku, product_name, hypothesis,
      original_price, target_price, original_position, target_position,
      next_competitor_name, next_competitor_price,
      baseline_window_days, baseline_clicks, baseline_orders, baseline_revenue, baseline_cpa,
      evaluation_at, expected_end_at, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    RETURNING *
  `, [tenantId, sku, prod.product_name,
      `Pos 1 → pos ${targetPos}: ridurre click marginali mantenendo conversioni`,
      prod.sell_price, targetPrice, 1, targetPos,
      targetCompetitor.merchant, targetCompetitor.total_price,
      baselineDays, base.clicks, base.orders, base.revenue, baselineCpa,
      evalAt.toISOString(), endAt.toISOString(), createdBy]);

  await pool.query(
    `INSERT INTO ab_test_events (test_id, event_type, snapshot, note, actor)
     VALUES ($1, 'created', $2, $3, $4)`,
    [test.id, JSON.stringify({ baseline: base, target_price: targetPrice }),
     `Created test ${prod.sell_price}→${targetPrice} (pos ${targetPos})`, createdBy]);

  return test;
}

async function markApplied(testId, actor = 'manual') {
  await pool.query(
    `UPDATE ab_tests SET status='running', applied_at=NOW() WHERE id=$1 AND status='pending_apply'`,
    [testId]);
  await pool.query(
    `INSERT INTO ab_test_events (test_id, event_type, note, actor) VALUES ($1, 'applied', $2, $3)`,
    [testId, 'User confirmed price applied on Farmabooster', actor]);
  return await getTest(testId);
}

async function getTest(testId) {
  const { rows: [t] } = await pool.query('SELECT * FROM ab_tests WHERE id = $1', [testId]);
  return t;
}

/**
 * Valuta tutti i test in stato 'running' la cui evaluation_at è passata.
 */
async function evaluateRunningTests() {
  const { rows: tests } = await pool.query(
    `SELECT * FROM ab_tests WHERE status='running' AND evaluation_at <= NOW() ORDER BY evaluation_at`);

  const results = [];
  for (const t of tests) {
    try {
      const r = await evaluateOne(t);
      results.push(r);
    } catch (e) { console.error('[ABTest] eval FAIL', t.id, e.message); }
  }
  return results;
}

async function evaluateOne(test) {
  // Misura il periodo dal applied_at ad ora
  const appliedAt = new Date(test.applied_at);
  const elapsedHours = (Date.now() - appliedAt.getTime()) / 3600000;
  const baselineHours = test.baseline_window_days * 24;
  // Normalizza baseline a stessa durata del test
  const normFactor = elapsedHours / baselineHours;

  const { rows: [m] } = await pool.query(`
    SELECT COALESCE(SUM(zc.clicks), 0)::int AS clicks, COALESCE(SUM(o.n_ord), 0)::int AS orders, COALESCE(SUM(o.rev), 0)::numeric AS revenue
    FROM (SELECT 1) x
    LEFT JOIN (SELECT SUM(clicks) AS clicks FROM zombie_clicks WHERE tenant_id=$1 AND product_code=$2 AND fetch_date >= $3::timestamp) zc ON true
    LEFT JOIN (SELECT COUNT(DISTINCT o.id) AS n_ord, SUM(COALESCE(oi.row_total_incl_tax, oi.row_total*1.1)) AS rev FROM orders o JOIN order_items oi ON oi.order_id=o.id
               WHERE o.tenant_id=$1 AND oi.sku=$2 AND o.order_date >= $3::timestamp
                 AND o.order_status IN ('complete','processing','Ritirato','ritiro_farmacia','ritiro_sede_tmp')) o ON true
  `, [test.tenant_id, test.sku, test.applied_at]);

  const expectedOrders = test.baseline_orders * normFactor;
  const orderRatio = expectedOrders > 0 ? m.orders / expectedOrders : 0;

  await pool.query(
    `UPDATE ab_tests SET test_clicks=$1::int, test_orders=$2::int, test_revenue=$3::numeric,
       test_cpa = CASE WHEN $2::int > 0 THEN $1::numeric/$2::numeric ELSE NULL END
     WHERE id=$4`,
    [m.clicks, m.orders, m.revenue, test.id]);

  let decision, reason;
  if (orderRatio >= SUCCESS_RATIO) {
    decision = 'successful';
    reason = `orders kept ${(orderRatio*100).toFixed(0)}% of baseline (${m.orders}/${expectedOrders.toFixed(1)})`;
  } else if (orderRatio < ROLLBACK_RATIO) {
    decision = 'rolled_back';
    reason = `orders dropped to ${(orderRatio*100).toFixed(0)}% baseline (${m.orders}/${expectedOrders.toFixed(1)}) → rollback`;
  } else if (elapsedHours >= EXTENDED_TEST_HOURS) {
    decision = 'inconclusive';
    reason = `inconclusive: ${(orderRatio*100).toFixed(0)}% baseline dopo ${elapsedHours.toFixed(0)}h`;
  } else {
    // estendi il test
    const newEval = new Date(Date.now() + (DEFAULT_TEST_HOURS * 3600 * 1000));
    await pool.query(`UPDATE ab_tests SET evaluation_at=$1 WHERE id=$2`, [newEval.toISOString(), test.id]);
    await pool.query(
      `INSERT INTO ab_test_events (test_id, event_type, snapshot, note) VALUES ($1, 'checkpoint_extended', $2, $3)`,
      [test.id, JSON.stringify({ measured: m, ratio: orderRatio, expected_orders: expectedOrders }),
       `orders ${(orderRatio*100).toFixed(0)}% baseline — extending`]);
    return { test_id: test.id, status: 'extended', ratio: orderRatio };
  }

  await pool.query(
    `UPDATE ab_tests SET status=$1, decision_reason=$2, decided_at=NOW(),
       rolled_back_at = CASE WHEN $1='rolled_back' THEN NOW() ELSE NULL END
     WHERE id=$3`,
    [decision, reason, test.id]);
  await pool.query(
    `INSERT INTO ab_test_events (test_id, event_type, snapshot, note)
     VALUES ($1, $2, $3, $4)`,
    [test.id, decision === 'successful' ? 'success_decided' : decision === 'rolled_back' ? 'rollback_decided' : 'inconclusive_decided',
     JSON.stringify({ measured: m, ratio: orderRatio, expected_orders: expectedOrders }), reason]);

  // Telegram alert
  const emoji = decision === 'successful' ? '✅' : decision === 'rolled_back' ? '🔄' : '⚖️';
  await sendTelegram(
    `${emoji} <b>A/B Test ${decision.toUpperCase()}</b>\n\n` +
    `SKU: <code>${test.sku}</code> · ${test.product_name || ''}\n` +
    `Originale: ${fmtEur(test.original_price)} (pos 1) → Test: ${fmtEur(test.target_price)} (pos ${test.target_position})\n\n` +
    `<b>Risultato</b>: ${m.orders} ord / ${m.clicks} click in ${elapsedHours.toFixed(0)}h\n` +
    `<b>Atteso</b>: ${expectedOrders.toFixed(1)} ord (baseline norm)\n` +
    `Ratio: ${(orderRatio*100).toFixed(0)}%\n\n` +
    (decision === 'rolled_back'
      ? `🔧 <b>AZIONE: ripristinare prezzo originale ${fmtEur(test.original_price)} su Farmabooster.</b>`
      : decision === 'successful'
        ? `✅ Mantieni il nuovo prezzo ${fmtEur(test.target_price)} su Farmabooster.`
        : `⚖️ Esito incerto: decidi tu se mantenere o rollback.`),
    { key: 'ab-test-decided-' + test.id });

  return { test_id: test.id, status: decision, ratio: orderRatio, measured: m };
}

module.exports = { identifyCandidates, createTest, markApplied, getTest, evaluateRunningTests, evaluateOne };
