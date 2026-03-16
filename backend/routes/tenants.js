const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const { encrypt, decrypt } = require('../services/crypto');

const router = express.Router();

router.use(authMiddleware, tenantMiddleware);

// GET /api/tenants
router.get('/', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    let query, params;
    if (req.user.role === 'superadmin') {
      query = 'SELECT id, name, slug, status, created_at, updated_at FROM tenants ORDER BY name';
      params = [];
    } else {
      query = 'SELECT id, name, slug, status, created_at, updated_at FROM tenants WHERE id = $1';
      params = [req.user.tenantId];
    }
    const { rows } = await pool.query(query, params);
    res.json({ data: rows });
  } catch (err) {
    console.error('[Tenants] List error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/tenants
router.post('/', requireRole('superadmin'), async (req, res) => {
  try {
    const { name, slug } = req.body;
    if (!name || !slug) {
      return res.status(400).json({ error: 'Name and slug required' });
    }

    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: 'Slug must be lowercase alphanumeric with hyphens' });
    }

    const { rows } = await pool.query(
      'INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id, name, slug, status, created_at',
      [name, slug]
    );

    await pool.query(
      'INSERT INTO audit_log (tenant_id, user_id, action, details, ip_address) VALUES ($1, $2, $3, $4, $5)',
      [rows[0].id, req.user.id, 'tenant_created', JSON.stringify({ name, slug }), req.ip]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Slug already exists' });
    }
    console.error('[Tenants] Create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/tenants/:id
router.put('/:id', requireRole('superadmin'), async (req, res) => {
  try {
    const { name, status } = req.body;
    const updates = [];
    const params = [];
    let idx = 1;

    if (name) { updates.push(`name = $${idx++}`); params.push(name); }
    if (status) { updates.push(`status = $${idx++}`); params.push(status); }
    updates.push(`updated_at = NOW()`);
    params.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE tenants SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, name, slug, status, updated_at`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('[Tenants] Update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tenants/:id/config
router.get('/:id/config', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const tenantId = req.params.id;

    if (req.user.role === 'admin' && req.user.tenantId !== tenantId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { rows } = await pool.query(
      'SELECT config_key, config_value FROM tenant_configs WHERE tenant_id = $1',
      [tenantId]
    );

    const config = {};
    for (const row of rows) {
      try {
        const val = decrypt(row.config_value);
        if (req.user.role !== 'superadmin' && (row.config_key.includes('password') || row.config_key.includes('api_key') || row.config_key.includes('secret'))) {
          config[row.config_key] = '********';
        } else {
          config[row.config_key] = val;
        }
      } catch {
        config[row.config_key] = row.config_value;
      }
    }

    res.json({ tenantId, config });
  } catch (err) {
    console.error('[Tenants] Config get error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/tenants/:id/config
router.put('/:id/config', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const tenantId = req.params.id;

    if (req.user.role === 'admin' && req.user.tenantId !== tenantId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { config } = req.body;
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'Config object required' });
    }

    for (const [key, value] of Object.entries(config)) {
      const encrypted = encrypt(value);
      await pool.query(
        `INSERT INTO tenant_configs (tenant_id, config_key, config_value)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = $3`,
        [tenantId, key, encrypted]
      );
    }

    await pool.query(
      'INSERT INTO audit_log (tenant_id, user_id, action, details, ip_address) VALUES ($1, $2, $3, $4, $5)',
      [tenantId, req.user.id, 'config_updated', JSON.stringify({ keys: Object.keys(config) }), req.ip]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[Tenants] Config save error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
