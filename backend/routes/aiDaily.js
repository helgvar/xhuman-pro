const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const explainer = require('../services/aiDailyExplainer');

const router = express.Router();
router.use(authMiddleware, tenantMiddleware);

// GET /api/ai-daily/note?date=2026-05-27 - ultima nota del tenant (default oggi)
router.get('/note', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const date = req.query.date || null;
    const { rows: [row] } = await pool.query(
      date
        ? `SELECT * FROM agent_daily_notes WHERE tenant_id=$1 AND note_date=$2`
        : `SELECT * FROM agent_daily_notes WHERE tenant_id=$1 ORDER BY note_date DESC LIMIT 1`,
      date ? [req.tenantId, date] : [req.tenantId]
    );
    res.json({ note: row || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ai-daily/history?days=14 - cronologia ultime N note del tenant
router.get('/history', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 14, 90);
    const { rows } = await pool.query(
      `SELECT id, note_date, model, input_tokens, output_tokens, cost_usd_estimated,
              note_text, telegram_sent, created_at
       FROM agent_daily_notes
       WHERE tenant_id=$1 AND note_date > CURRENT_DATE - $2::int
       ORDER BY note_date DESC`,
      [req.tenantId, days]
    );
    res.json({ notes: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ai-daily/status - stato toggle del tenant corrente
router.get('/status', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const enabled = await explainer.isTenantEnabled(req.tenantId);
    res.json({ enabled });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ai-daily/toggle - abilita/disabilita per il tenant corrente
router.post('/toggle', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const enabled = req.body.enabled === true;
    await pool.query(
      `INSERT INTO tenant_configs (tenant_id, config_key, config_value)
       VALUES ($1, 'claude_optimizer_enabled', $2)
       ON CONFLICT (tenant_id, config_key) DO UPDATE
         SET config_value = EXCLUDED.config_value`,
      [req.tenantId, enabled ? 'true' : 'false']
    );
    res.json({ enabled });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ai-daily/run-now - forza generazione nota per il tenant corrente (test)
router.post('/run-now', requireRole('superadmin'), async (req, res) => {
  try {
    const enabled = await explainer.isTenantEnabled(req.tenantId);
    if (!enabled) return res.status(400).json({ error: 'Tenant non abilitato (attiva il toggle prima)' });
    const { rows: [t] } = await pool.query(`SELECT name FROM tenants WHERE id=$1`, [req.tenantId]);
    // forza regenerazione: cancella la nota di oggi se esiste
    await pool.query(
      `DELETE FROM agent_daily_notes WHERE tenant_id=$1 AND note_date=CURRENT_DATE`,
      [req.tenantId]
    );
    const result = await explainer.runDailyExplainerForTenant(req.tenantId, t.name);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
