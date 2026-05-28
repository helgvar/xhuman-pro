const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');

const router = express.Router();
router.use(authMiddleware, tenantMiddleware);

// GET /api/logs?level=error&source=healthCron&tenant_id=...&from=2026-05-27&to=2026-05-28&q=text&limit=200
router.get('/', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 2000);
    const filters = [];
    const params = [];
    let p = 1;

    if (req.query.level) {
      const levels = String(req.query.level).split(',').filter(Boolean);
      filters.push(`level = ANY($${p++})`);
      params.push(levels);
    }
    if (req.query.source) {
      filters.push(`source = $${p++}`);
      params.push(req.query.source);
    }
    // Default: log del tenant corrente + log globali (tenant_id NULL = sistema/process/cross-tenant)
    // ?scope=tenant → solo log con tenant_id == corrente
    // ?scope=global → solo log globali (tenant_id NULL)
    // ?scope=all → tutti i log (solo superadmin)
    // ?tenant_id=X → override esplicito (solo superadmin)
    const scope = req.query.scope || 'default';
    if (req.query.tenant_id && req.user?.role === 'superadmin') {
      filters.push(`tenant_id = $${p++}`);
      params.push(req.query.tenant_id);
    } else if (scope === 'all' && req.user?.role === 'superadmin') {
      // nessun filtro
    } else if (scope === 'tenant') {
      filters.push(`tenant_id = $${p++}`);
      params.push(req.tenantId);
    } else if (scope === 'global') {
      filters.push(`tenant_id IS NULL`);
    } else {
      // default: tenant corrente OR globali
      filters.push(`(tenant_id = $${p} OR tenant_id IS NULL)`);
      params.push(req.tenantId);
      p++;
    }
    if (req.query.from) {
      filters.push(`ts >= $${p++}`);
      params.push(req.query.from);
    }
    if (req.query.to) {
      filters.push(`ts <= $${p++}`);
      params.push(req.query.to);
    }
    if (req.query.q) {
      filters.push(`(message ILIKE $${p} OR stack ILIKE $${p})`);
      params.push(`%${req.query.q}%`);
      p++;
    }
    if (req.query.trace_id) {
      filters.push(`trace_id = $${p++}`);
      params.push(req.query.trace_id);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT id, ts, level, source, tenant_id, trace_id, message, payload, stack,
              hostname, process_uptime_sec
       FROM log_events
       ${where}
       ORDER BY ts DESC
       LIMIT $${p}`,
      params
    );
    res.json({ count: rows.length, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/summary?scope=default|tenant|global|all - count per level last 24h
// Default applica stesso filtro tenant della route principale: tenant corrente OR globali.
router.get('/summary', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const scope = req.query.scope || 'default';
    let where = `ts > NOW() - INTERVAL '24 hours'`;
    const params = [];
    if (scope === 'all' && req.user?.role === 'superadmin') {
      // nessun filtro tenant
    } else if (scope === 'tenant') {
      where += ` AND tenant_id = $1`;
      params.push(req.tenantId);
    } else if (scope === 'global') {
      where += ` AND tenant_id IS NULL`;
    } else {
      where += ` AND (tenant_id = $1 OR tenant_id IS NULL)`;
      params.push(req.tenantId);
    }

    const { rows } = await pool.query(
      `SELECT level, COUNT(*)::int AS count FROM log_events WHERE ${where}
       GROUP BY level ORDER BY array_position(ARRAY['fatal','error','warn','info','debug'], level)`,
      params
    );
    const { rows: topSources } = await pool.query(
      `SELECT source, level, COUNT(*)::int AS count FROM log_events
       WHERE ${where} AND level IN ('error','fatal')
       GROUP BY source, level ORDER BY count DESC LIMIT 15`,
      params
    );
    res.json({ levels: rows, top_error_sources: topSources, scope });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/sources - source distinct ultimi 7gg
router.get('/sources', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT source, COUNT(*)::int AS n
      FROM log_events
      WHERE source IS NOT NULL AND ts > NOW() - INTERVAL '7 days'
      GROUP BY source ORDER BY n DESC
    `);
    res.json({ sources: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/logs/test - genera log di test (solo superadmin)
router.post('/test', requireRole('superadmin'), async (req, res) => {
  const log = require('../services/logger');
  const level = req.body.level || 'info';
  const message = req.body.message || `Test log @ ${new Date().toISOString()}`;
  log[level](message, { test: true, requestedBy: req.user?.email });
  await log.flush();
  res.json({ ok: true, level, message });
});

module.exports = router;
