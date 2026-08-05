const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const { pool } = require('../db/pool');
const ads = require('../services/googleAds');

const router = express.Router();
router.use(authMiddleware, tenantMiddleware);

// GET /api/google-ads/diagnose - cosa manca per attivare?
router.get('/diagnose', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    res.json(await ads.diagnoseConfig(req.tenantId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/google-ads/test - prova connessione (1 query elementare)
router.get('/test', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    res.json(await ads.testConnection(req.tenantId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/google-ads/sync - sync manuale per il tenant attivo
router.post('/sync', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.body?.days) || 30, 90);
    res.json(await ads.syncTenant(req.tenantId, { days }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/google-ads/runs - storico dei sync per il tenant
router.get('/runs', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, run_type, status, campaigns_count, campaign_days, product_rows,
             error_message, started_at, completed_at,
             EXTRACT(EPOCH FROM (completed_at - started_at))::int AS duration_sec
      FROM google_ads_runs
      WHERE tenant_id=$1
      ORDER BY started_at DESC LIMIT 20
    `, [req.tenantId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ANALYTICS (read-only, non tocca le campagne) ────────────────────────────

// GET /api/google-ads/overview?days=30 - KPI totali + trend giornaliero + per-campagna
router.get('/overview', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const t = req.tenantId;

    const kpi = (await pool.query(`
      SELECT
        COALESCE(SUM(cost_micros),0)/1e6      AS spend,
        COALESCE(SUM(conversion_value),0)     AS revenue,
        COALESCE(SUM(conversions),0)          AS conversions,
        COALESCE(SUM(clicks),0)               AS clicks,
        COALESCE(SUM(impressions),0)          AS impressions
      FROM google_ads_campaign_daily
      WHERE tenant_id=$1 AND report_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - $2::int
    `, [t, days])).rows[0];

    const trend = (await pool.query(`
      SELECT report_date::text AS d,
        ROUND(SUM(cost_micros)/1e6, 2)   AS spend,
        ROUND(SUM(conversion_value), 2)  AS revenue,
        SUM(conversions)                 AS conversions,
        SUM(clicks)                      AS clicks
      FROM google_ads_campaign_daily
      WHERE tenant_id=$1 AND report_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - $2::int
      GROUP BY report_date ORDER BY report_date
    `, [t, days])).rows;

    const campaigns = (await pool.query(`
      SELECT c.campaign_id, c.name, c.campaign_type, c.status,
        ROUND(SUM(d.cost_micros)/1e6, 2)  AS spend,
        ROUND(SUM(d.conversion_value), 2) AS revenue,
        SUM(d.conversions)                AS conversions,
        SUM(d.clicks)                     AS clicks,
        SUM(d.impressions)                AS impressions,
        CASE WHEN SUM(d.cost_micros)>0
          THEN ROUND(SUM(d.conversion_value)/(SUM(d.cost_micros)/1e6), 2) END AS roas,
        CASE WHEN SUM(d.conversions)>0
          THEN ROUND((SUM(d.cost_micros)/1e6)/SUM(d.conversions), 2) END AS cpa
      FROM google_ads_campaign_daily d
      JOIN google_ads_campaigns c
        ON c.tenant_id=d.tenant_id AND c.customer_id=d.customer_id AND c.campaign_id=d.campaign_id
      WHERE d.tenant_id=$1 AND d.report_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - $2::int
      GROUP BY c.campaign_id, c.name, c.campaign_type, c.status
      ORDER BY spend DESC
    `, [t, days])).rows;

    const lastRun = (await pool.query(`
      SELECT status, completed_at, product_rows FROM google_ads_runs
      WHERE tenant_id=$1 AND status='completed' ORDER BY started_at DESC LIMIT 1
    `, [t])).rows[0] || null;

    res.json({ days, kpi, trend, campaigns, lastRun });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/google-ads/products?days=30&sort=spend&limit=200
// Per-prodotto con MARGINE VERO (costo sorgente) e verdetto margine-first.
// margine_stimato assume 1 pezzo/conversione (non abbiamo units da Google Ads).
router.get('/products', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const limit = Math.min(parseInt(req.query.limit) || 300, 1000);
    const t = req.tenantId;

    const { rows } = await pool.query(`
      WITH agg AS (
        SELECT pd.offer_id,
          SUM(pd.cost_micros)/1e6      AS spend,
          SUM(pd.conversion_value)     AS revenue,
          SUM(pd.conversions)          AS conversions,
          SUM(pd.clicks)               AS clicks,
          SUM(pd.impressions)          AS impressions
        FROM google_ads_product_daily pd
        WHERE pd.tenant_id=$1 AND pd.report_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - $2::int
        GROUP BY pd.offer_id
      )
      SELECT a.offer_id AS sku,
        COALESCE(p.product_name, '') AS name,
        COALESCE(p.erp_stock,0) AS erp_stock,
        CASE WHEN COALESCE(p.erp_stock,0)>0 AND COALESCE(p.erp_purchase_cost,0)>0
             THEN p.erp_purchase_cost ELSE p.erp_cost END AS costo_vero,
        ROUND(a.spend,2)       AS spend,
        ROUND(a.revenue,2)     AS revenue,
        a.conversions,
        a.clicks,
        a.impressions,
        CASE WHEN a.spend>0 THEN ROUND(a.revenue/a.spend,2) END AS roas,
        ROUND((a.revenue - a.conversions * COALESCE(
          CASE WHEN COALESCE(p.erp_stock,0)>0 AND COALESCE(p.erp_purchase_cost,0)>0
               THEN p.erp_purchase_cost ELSE p.erp_cost END, 0))::numeric, 2) AS margine_stimato,
        is_feed_protected($1, a.offer_id) AS protetto
      FROM agg a
      LEFT JOIN products p ON p.tenant_id=$1 AND p.sku=a.offer_id
      ORDER BY ${req.query.sort === 'margine' ? 'margine_stimato' : 'spend'} DESC NULLS LAST
      LIMIT $3
    `, [t, days, limit]);

    // verdetto margine-first: brucia se spend>80% del margine (dottrina 80%)
    const out = rows.map(r => {
      const m = r.margine_stimato == null ? null : Number(r.margine_stimato);
      const s = Number(r.spend);
      let verdetto = 'ok';
      if (m == null) verdetto = 'no-costo';
      else if (m <= 0) verdetto = 'brucia';
      else if (s > m) verdetto = 'perdita';
      else if (s > 0.8 * m) verdetto = 'attenzione';
      const profit_roas = (m != null && s > 0) ? Math.round((m / s) * 100) / 100 : null;
      return { ...r, profit_roas, verdetto };
    });

    res.json({ days, count: out.length, products: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
