/**
 * Feed Prediction Engine v2
 *
 * Prediction GLOBALE: "Oggi spendi X e incassi Y → con queste azioni
 * nei prossimi 7gg prevediamo di spendere Z e incassare W"
 *
 * Monitoring: ogni 2h confronta previsione vs realtà
 * Correzione: se fuori range negativo, interviene
 */

const { pool } = require('../db/pool');

/**
 * Generate/update global prediction based on feed engine results
 * Called after computeFeedActions saves to health_config
 */
async function generatePredictions(tenantId) {
  // Global prediction is already saved by feedEngine in health_config
  // Here we create per-action predictions for REMOVE/ADD products only
  // (not PRICE_CUT — too many, and not KEEP — no change expected)

  const { rows: actionableProducts } = await pool.query(`
    SELECT fa.sku, fa.action, fa.clicks_consumed, fa.cost_consumed,
           fa.direct_revenue, fa.current_price, fa.recommended_price
    FROM feed_actions fa
    WHERE fa.tenant_id = $1 AND fa.action IN ('REMOVE', 'ADD')
  `, [tenantId]);

  const cpcRow = await pool.query(
    `SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = 'avg_tp_cpc'`,
    [tenantId]
  );
  const cpc = parseFloat(cpcRow.rows[0]?.config_value) || 0.3294;

  let created = 0;
  for (const a of actionableProducts) {
    const windowDays = 7;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + windowDays);

    let predClicks = 0, predOrders = 0, predRevenue = 0, predSavings = 0, confidence = 0.5;

    if (a.action === 'REMOVE') {
      // Expect: clicks drop to 0, save the daily average
      const dailyClicks = (parseInt(a.clicks_consumed) || 0) / 14;
      predSavings = +(dailyClicks * windowDays * cpc).toFixed(2);
      confidence = dailyClicks > 1 ? 0.85 : 0.6;
    } else if (a.action === 'ADD') {
      // Conservative estimate for new products
      predClicks = 3;
      predOrders = 0.15;
      predRevenue = +(predOrders * (parseFloat(a.recommended_price || a.current_price) || 0)).toFixed(2);
      confidence = 0.4;
    }

    await pool.query(`
      INSERT INTO feed_predictions (tenant_id, sku, action,
        predicted_clicks_7d, predicted_orders_7d, predicted_revenue_7d, predicted_savings_7d,
        confidence, prediction_window_days, prediction_expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (tenant_id, sku) DO UPDATE SET
        action = $3, predicted_clicks_7d = $4, predicted_orders_7d = $5,
        predicted_revenue_7d = $6, predicted_savings_7d = $7,
        confidence = $8, prediction_expires_at = $10,
        status = 'active', actual_clicks = 0, actual_orders = 0,
        actual_revenue = 0, actual_savings = 0, deviation_pct = 0,
        correction_action = NULL, corrected_at = NULL,
        prediction_created_at = NOW()
    `, [tenantId, a.sku, a.action,
        predClicks, predOrders, predRevenue, predSavings,
        confidence, windowDays, expiresAt.toISOString()]);
    created++;
  }

  if (created > 0) console.log(`[Prediction] ${created} predictions for REMOVE/ADD products`);
  return { created };
}

/**
 * Monitor predictions: compare actuals vs predicted
 */
async function monitorPredictions(tenantId) {
  const { rows: active } = await pool.query(`
    SELECT fp.*,
      (SELECT COALESCE(SUM(clicks), 0) FROM zombie_clicks
       WHERE tenant_id = $1 AND product_code = fp.sku
       AND fetch_date >= fp.prediction_created_at::date) as clicks_since,
      (SELECT COUNT(DISTINCT oi.order_id) FROM order_items oi
       JOIN orders o ON o.id = oi.order_id AND o.tenant_id = $1
       WHERE oi.sku = fp.sku AND oi.tenant_id = $1
       AND o.order_date >= fp.prediction_created_at) as orders_since
    FROM feed_predictions fp
    WHERE fp.tenant_id = $1 AND fp.status IN ('active', 'on_track')
  `, [tenantId]);

  let corrections = 0;
  for (const pred of active) {
    const daysElapsed = (Date.now() - new Date(pred.prediction_created_at).getTime()) / 86400000;
    const actualClicks = parseInt(pred.clicks_since) || 0;
    const actualOrders = parseInt(pred.orders_since) || 0;
    const expired = daysElapsed >= pred.prediction_window_days;

    let status = 'on_track';
    let correction = null;

    if (pred.action === 'REMOVE') {
      // Success = no more clicks
      if (actualClicks > 5 && daysElapsed >= 3) {
        status = 'underperforming';
        correction = { action: 'MONITOR', reason: `Ancora ${actualClicks} click post-rimozione in ${Math.floor(daysElapsed)}gg` };
      } else {
        status = expired ? 'expired' : 'on_track';
      }
    } else if (pred.action === 'ADD') {
      if (expired && actualOrders === 0 && actualClicks > 3) {
        status = 'underperforming';
        correction = { action: 'REMOVE', reason: `Pepite fallita: ${actualClicks} click, 0 ordini in ${pred.prediction_window_days}gg` };
      } else if (actualOrders > 0) {
        status = 'exceeded';
      } else {
        status = expired ? 'expired' : 'on_track';
      }
    }

    await pool.query(`
      UPDATE feed_predictions SET actual_clicks = $3, actual_orders = $4, status = $5
      WHERE tenant_id = $1 AND sku = $2
    `, [tenantId, pred.sku, actualClicks, actualOrders, status]);

    if (correction && !pred.correction_action) {
      await pool.query(`
        UPDATE feed_predictions SET correction_action = $3, correction_reason = $4, corrected_at = NOW(), status = 'corrected'
        WHERE tenant_id = $1 AND sku = $2
      `, [tenantId, pred.sku, correction.action, correction.reason]);

      await pool.query(`
        INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source, computed_at)
        VALUES ($1, $2, $3, $4, 'prediction_correction', NOW())
        ON CONFLICT (tenant_id, sku) DO UPDATE SET
          action = $3, action_reason = $4, action_source = 'prediction_correction', computed_at = NOW()
      `, [tenantId, pred.sku, correction.action, correction.reason]);
      corrections++;
    }
  }

  if (corrections > 0) console.log(`[Prediction] ${corrections} corrections applied`);
  return { monitored: active.length, corrections };
}

/**
 * Calibrate (placeholder — runs after enough data)
 */
async function calibratePredictions(tenantId) {
  // Will be meaningful after 2+ weeks of data
}

module.exports = { generatePredictions, monitorPredictions, calibratePredictions };
