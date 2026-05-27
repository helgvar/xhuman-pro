const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const { chat, confirmPendingAction, executeCriticalAction } = require('../services/claudeAgent');

const router = express.Router();
router.use(authMiddleware, tenantMiddleware);

// ─── SESSIONS ──────────────────────────────────────────

// GET /api/agent/sessions — lista sessioni (ultimi 90gg)
router.get('/sessions', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id, s.title, s.status, s.messages_count, s.actions_executed,
             s.created_at, s.last_message_at,
             u.name as created_by
      FROM agent_sessions s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.tenant_id = $1
        AND s.created_at > NOW() - INTERVAL '90 days'
      ORDER BY s.last_message_at DESC
    `, [req.tenantId]);
    res.json({ sessions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent/sessions — crea nuova sessione
router.post('/sessions', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { rows: [session] } = await pool.query(
      "INSERT INTO agent_sessions (tenant_id, user_id, title) VALUES ($1, $2, 'Nuova sessione') RETURNING *",
      [req.tenantId, req.user.id]
    );
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agent/sessions/:id — dettaglio sessione con messaggi
router.get('/sessions/:id', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { rows: [session] } = await pool.query(
      "SELECT * FROM agent_sessions WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.tenantId]
    );
    if (!session) return res.status(404).json({ error: 'Sessione non trovata' });

    const { rows: messages } = await pool.query(
      "SELECT id, role, content, actions_taken, tokens_used, model, created_at FROM agent_messages WHERE session_id = $1 ORDER BY created_at",
      [req.params.id]
    );

    res.json({ session, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent/sessions/:id/chat — invia messaggio, ritorna JSON
router.post('/sessions/:id/chat', requireRole('superadmin', 'admin'), async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Messaggio vuoto' });

  try {
    // Verify session belongs to tenant
    const { rows: [session] } = await pool.query(
      "SELECT id FROM agent_sessions WHERE id = $1 AND tenant_id = $2 AND status = 'active'",
      [req.params.id, req.tenantId]
    );
    if (!session) return res.status(404).json({ error: 'Sessione non trovata o archiviata' });

    // Call Claude agent (may take 30-90s for Opus with tools)
    const result = await chat(req.tenantId, req.params.id, req.user.id, message.trim());

    res.json({
      message: result.message,
      actions: result.actions,
      tokensUsed: result.tokensUsed,
      model: result.model,
    });
  } catch (err) {
    console.error('[Agent] Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent/sessions/:id/archive — archivia sessione
router.post('/sessions/:id/archive', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    await pool.query(
      "UPDATE agent_sessions SET status = 'archived' WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.tenantId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ACTIONS ───────────────────────────────────────────

// GET /api/agent/actions — log azioni eseguite
router.get('/actions', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.*, s.title as session_title
      FROM agent_actions_log a
      LEFT JOIN agent_sessions s ON s.id = a.session_id
      WHERE a.tenant_id = $1
      ORDER BY a.created_at DESC
      LIMIT 100
    `, [req.tenantId]);
    res.json({ actions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent/actions/:id/confirm — conferma azione rischiosa
router.post('/actions/:id/confirm', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const result = await confirmPendingAction(parseInt(req.params.id), req.tenantId, req.user.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent/actions/:id/execute-critical — esegui azione critica con password
router.post('/actions/:id/execute-critical', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password richiesta' });

    const result = await executeCriticalAction(parseInt(req.params.id), req.tenantId, req.user.id, password);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RULES ─────────────────────────────────────────────

// GET /api/agent/rules — regole tenant attive
router.get('/rules', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM agent_tenant_rules WHERE tenant_id = $1 AND is_active = true ORDER BY created_at",
      [req.tenantId]
    );
    res.json({ rules: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent/rules — aggiunge regola manualmente
router.post('/rules', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { rule_type, rule_config, reason } = req.body;
    if (!rule_type || !rule_config) return res.status(400).json({ error: 'rule_type e rule_config richiesti' });

    const { rows: [rule] } = await pool.query(
      "INSERT INTO agent_tenant_rules (tenant_id, rule_type, rule_config, reason, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [req.tenantId, rule_type, JSON.stringify(rule_config), reason, req.user.id]
    );
    res.json(rule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/agent/rules/:id — rimuove regola
router.delete('/rules/:id', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    await pool.query(
      "UPDATE agent_tenant_rules SET is_active = false WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.tenantId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PENDING ACTIONS ───────────────────────────────────

// GET /api/agent/pending — azioni in attesa di conferma
router.get('/pending', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM agent_pending_actions WHERE tenant_id = $1 AND status = 'pending' AND expires_at > NOW() ORDER BY created_at DESC",
      [req.tenantId]
    );
    res.json({ pending: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
