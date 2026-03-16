const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');

const router = express.Router();

router.use(authMiddleware, tenantMiddleware);

// GET /api/users/me
router.get('/me', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.tenant_id, u.totp_enabled, u.status, u.last_login,
              t.name as tenant_name, t.slug as tenant_slug
       FROM users u
       LEFT JOIN tenants t ON u.tenant_id = t.id
       WHERE u.id = $1`,
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('[Users] Me error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/users
router.get('/', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    let query, params;
    if (req.user.role === 'superadmin') {
      query = `SELECT u.id, u.email, u.name, u.role, u.tenant_id, u.totp_enabled, u.status, u.last_login, u.created_at,
                      t.name as tenant_name
               FROM users u LEFT JOIN tenants t ON u.tenant_id = t.id
               ORDER BY u.created_at DESC`;
      params = [];
    } else {
      query = `SELECT u.id, u.email, u.name, u.role, u.tenant_id, u.totp_enabled, u.status, u.last_login, u.created_at,
                      t.name as tenant_name
               FROM users u LEFT JOIN tenants t ON u.tenant_id = t.id
               WHERE u.tenant_id = $1
               ORDER BY u.created_at DESC`;
      params = [req.user.tenantId];
    }

    const { rows } = await pool.query(query, params);
    res.json({ data: rows });
  } catch (err) {
    console.error('[Users] List error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/users
router.post('/', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { email, password, name, role, tenantId } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name required' });
    }

    const allowedRoles = req.user.role === 'superadmin'
      ? ['superadmin', 'admin', 'viewer']
      : ['admin', 'viewer'];

    const userRole = role || 'viewer';
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({ error: `Cannot create user with role: ${userRole}` });
    }

    const userTenantId = req.user.role === 'superadmin'
      ? (tenantId || null)
      : req.user.tenantId;

    if (req.user.role === 'admin' && tenantId && tenantId !== req.user.tenantId) {
      return res.status(403).json({ error: 'Cannot create users for other tenants' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role, tenant_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, name, role, tenant_id, status, created_at`,
      [email.toLowerCase().trim(), passwordHash, name, userRole, userTenantId]
    );

    await pool.query(
      'INSERT INTO audit_log (tenant_id, user_id, action, details, ip_address) VALUES ($1, $2, $3, $4, $5)',
      [userTenantId, req.user.id, 'user_created', JSON.stringify({ email, role: userRole }), req.ip]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already in use' });
    }
    console.error('[Users] Create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/users/:id
router.put('/:id', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const targetId = req.params.id;
    const { name, role, status, password } = req.body;

    if (req.user.role === 'admin') {
      const { rows: targetRows } = await pool.query(
        'SELECT tenant_id FROM users WHERE id = $1', [targetId]
      );
      if (targetRows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      if (targetRows[0].tenant_id !== req.user.tenantId) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const updates = [];
    const params = [];
    let idx = 1;

    if (name) { updates.push(`name = $${idx++}`); params.push(name); }
    if (role) {
      if (req.user.role !== 'superadmin' && role === 'superadmin') {
        return res.status(403).json({ error: 'Cannot assign superadmin role' });
      }
      updates.push(`role = $${idx++}`);
      params.push(role);
    }
    if (status) { updates.push(`status = $${idx++}`); params.push(status); }
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      updates.push(`password_hash = $${idx++}`);
      params.push(hash);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    params.push(targetId);

    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}
       RETURNING id, email, name, role, tenant_id, status, updated_at`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('[Users] Update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/users/:id (soft delete)
router.delete('/:id', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const targetId = req.params.id;

    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    if (req.user.role === 'admin') {
      const { rows: targetRows } = await pool.query(
        'SELECT tenant_id FROM users WHERE id = $1', [targetId]
      );
      if (targetRows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      if (targetRows[0].tenant_id !== req.user.tenantId) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const { rows } = await pool.query(
      "UPDATE users SET status = 'disabled', updated_at = NOW() WHERE id = $1 RETURNING id, email, status",
      [targetId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [targetId]);

    res.json(rows[0]);
  } catch (err) {
    console.error('[Users] Delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
