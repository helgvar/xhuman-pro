/**
 * AI Audit suggestions API.
 * Letti dalla dashboard, approvati/rigettati dall'utente.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const { auditTenantRun } = require('../services/aiAuditor');

// FIX 13/7: il router non montava authMiddleware/tenantMiddleware — req.user
// non veniva mai valorizzato e requireRole rispondeva 401 a CHIUNQUE (la
// pagina dashboard "AI Audit" era morta). Ora: auth + tenant context.
router.use(authMiddleware, tenantMiddleware);

// GET /api/ai-audit/suggestions - lista suggerimenti.
// Superadmin senza tenant selezionato = vista RETE (tutti i tenant, col nome).
router.get('/suggestions', requireRole('superadmin','admin','viewer'), async (req, res) => {
  const tenantId = req.tenantId;
  const status = req.query.status || 'pending';
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.severity, s.category, s.title, s.description, s.suggested_actions,
              s.run_at, s.ai_model, s.ai_tokens_in, s.ai_tokens_out, s.status, s.reviewed_at, s.reviewed_by,
              t.name AS tenant_name
       FROM ai_audit_suggestions s
       LEFT JOIN tenants t ON t.id = s.tenant_id
       WHERE ($1::uuid IS NULL OR s.tenant_id = $1) AND s.status = $2
       ORDER BY
         CASE s.severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         s.run_at DESC
       LIMIT $3`,
      [tenantId, status, limit]
    );
    res.json({ suggestions: rows, count: rows.length });
  } catch (e) {
    console.error('[aiAudit] list err:', e.message);
    res.status(500).json({ error: 'list_failed' });
  }
});

// POST /api/ai-audit/suggestions/:id/review - approva / rigetta
router.post('/suggestions/:id/review', requireRole('superadmin','admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { decision } = req.body;  // approved | rejected
  if (!['approved','rejected'].includes(decision)) {
    return res.status(400).json({ error: 'invalid_decision' });
  }
  try {
    await pool.query(
      `UPDATE ai_audit_suggestions
       SET status=$1, reviewed_at=NOW(), reviewed_by=$2
       WHERE id=$3 AND ($4::uuid IS NULL OR tenant_id=$4) AND status='pending'`,
      [decision, req.user?.email || 'unknown', id, req.tenantId]
    );
    res.json({ ok: true, decision });
  } catch (e) {
    console.error('[aiAudit] review err:', e.message);
    res.status(500).json({ error: 'review_failed' });
  }
});

// POST /api/ai-audit/run - trigger manuale
router.post('/run', requireRole('superadmin','admin'), async (req, res) => {
  try {
    const r = await auditTenantRun(req.tenantId);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ai-audit/stats - utilizzo token + suggestions per status
router.get('/stats', requireRole('superadmin','admin'), async (req, res) => {
  try {
    const { rows: [s] } = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status='pending') AS pending,
         COUNT(*) FILTER (WHERE status='approved') AS approved,
         COUNT(*) FILTER (WHERE status='rejected') AS rejected,
         COALESCE(SUM(ai_tokens_in),0) AS tokens_in_total,
         COALESCE(SUM(ai_tokens_out),0) AS tokens_out_total,
         MAX(run_at)::timestamp AS last_run
       FROM ai_audit_suggestions WHERE ($1::uuid IS NULL OR tenant_id=$1)`,
      [req.tenantId]
    );
    res.json(s);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ai-audit/digest - trigger manuale Telegram digest
router.post('/digest', requireRole('superadmin'), async (req, res) => {
  try {
    const { sendDigest } = require('../services/aiAuditCron');
    await sendDigest();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ai-audit/auto-apply - trigger auto-apply (dry-run flag opzionale)
router.post('/auto-apply', requireRole('superadmin'), async (req, res) => {
  try {
    const { processAutoApply } = require('../services/aiSuggestionApplier');
    const dryRun = req.query.dry_run === '1' || req.body?.dryRun === true;
    const r = await processAutoApply({ tenantId: req.tenantId, dryRun });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ai-audit/optimize - trigger LOOP completo (audit globale + auto-apply).
// Tipicamente parte dal cron ogni 6h, qui per trigger manuale.
router.post('/optimize', requireRole('superadmin'), async (req, res) => {
  try {
    const { runOptimizationLoop } = require('../services/aiAuditCron');
    // Fire-and-forget per non bloccare la response (può durare 2-5 min)
    runOptimizationLoop().catch(e => console.error('[aiAudit] optimize err:', e.message));
    res.json({ ok: true, message: 'Optimization loop started in background' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
