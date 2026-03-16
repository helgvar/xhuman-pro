const { pool } = require('../db/pool');

async function tenantMiddleware(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (req.user.role === 'superadmin') {
    if (req.query.tenantId) {
      const { rows } = await pool.query(
        'SELECT id, name, slug, status FROM tenants WHERE id = $1',
        [req.query.tenantId]
      );
      req.tenant = rows[0] || null;
      req.tenantId = rows[0]?.id || null;
    } else {
      req.tenant = null;
      req.tenantId = null;
    }
    return next();
  }

  if (req.user.tenantId) {
    const { rows } = await pool.query(
      'SELECT id, name, slug, status FROM tenants WHERE id = $1',
      [req.user.tenantId]
    );
    if (rows.length === 0) {
      return res.status(403).json({ error: 'Tenant not found' });
    }
    if (rows[0].status !== 'active') {
      return res.status(403).json({ error: 'Tenant suspended' });
    }
    req.tenant = rows[0];
    req.tenantId = rows[0].id;
  } else {
    req.tenant = null;
    req.tenantId = null;
  }

  next();
}

module.exports = { tenantMiddleware };
