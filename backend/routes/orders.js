const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const { importOrders } = require('../services/magentoOrders');

const router = express.Router();

router.use(authMiddleware, tenantMiddleware);

// GET /api/orders - List orders with pagination
router.get('/', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const status = req.query.status;
    const search = req.query.search;

    let where = 'WHERE o.tenant_id = $1';
    const params = [tenantId];
    let idx = 2;

    if (status && ['complete', 'processing', 'pending'].includes(status)) {
      where += ` AND o.order_status = $${idx++}`;
      params.push(status);
    }

    if (search) {
      where += ` AND (o.order_number ILIKE $${idx} OR o.customer_email ILIKE $${idx} OR o.customer_lastname ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    // Count
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM orders o ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    // Orders
    const { rows: orders } = await pool.query(
      `SELECT o.id, o.order_number, o.order_status, o.customer_firstname, o.customer_lastname,
              o.customer_email, o.customer_province, o.subtotal, o.discount_amount,
              o.grand_total_products, o.order_date, o.imported_at
       FROM orders o ${where}
       ORDER BY o.order_date DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    );

    res.json({
      data: orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[Orders] List error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/orders/stats - Quick stats
router.get('/stats', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;

    const { rows } = await pool.query(
      `SELECT
         COUNT(*) as total_orders,
         COUNT(CASE WHEN order_status = 'complete' THEN 1 END) as complete_orders,
         COUNT(CASE WHEN order_status = 'processing' THEN 1 END) as processing_orders,
         COUNT(CASE WHEN order_status = 'pending' THEN 1 END) as pending_orders,
         COALESCE(SUM(grand_total_products), 0) as total_revenue,
         MIN(order_date) as oldest_order,
         MAX(order_date) as newest_order,
         (SELECT completed_at FROM import_jobs
          WHERE tenant_id = $1 AND job_type IN ('orders', 'orders_sync')
            AND status = 'completed' ORDER BY completed_at DESC LIMIT 1) as last_import_at
       FROM orders WHERE tenant_id = $1`,
      [tenantId]
    );

    res.json({ stats: rows[0] });
  } catch (err) {
    console.error('[Orders] Stats error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/orders/:id - Order detail with items
router.get('/:id', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { rows: orders } = await pool.query(
      `SELECT * FROM orders WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const { rows: items } = await pool.query(
      `SELECT sku, product_name, qty_ordered, price, row_total
       FROM order_items WHERE order_id = $1 ORDER BY product_name`,
      [req.params.id]
    );

    res.json({ order: orders[0], items });
  } catch (err) {
    console.error('[Orders] Detail error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/orders/import - Trigger manual import
router.post('/import', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const daysBack = parseInt(req.body.daysBack) || 365;

    // Check if there's already a running import
    const { rows: running } = await pool.query(
      `SELECT id FROM import_jobs
       WHERE tenant_id = $1 AND job_type = 'orders' AND status IN ('pending', 'running')`,
      [tenantId]
    );

    if (running.length > 0) {
      return res.status(409).json({ error: 'Import already in progress' });
    }

    // Create job
    const { rows } = await pool.query(
      `INSERT INTO import_jobs (tenant_id, job_type, status, metadata)
       VALUES ($1, 'orders', 'pending', $2) RETURNING id`,
      [tenantId, JSON.stringify({ daysBack, triggeredBy: req.user.email })]
    );
    const jobId = rows[0].id;

    // Run import in background
    importOrders(tenantId, daysBack, jobId).catch(err => {
      console.error('[Orders] Background import error:', err.message);
    });

    res.json({ jobId, message: `Import started (${daysBack} days back)` });
  } catch (err) {
    console.error('[Orders] Import trigger error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/orders/import/status - Last import jobs
router.get('/import/status', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { rows } = await pool.query(
      `SELECT id, status, started_at, completed_at, records_processed,
              records_imported, records_updated, error_message, metadata, created_at
       FROM import_jobs
       WHERE tenant_id = $1 AND job_type = 'orders'
       ORDER BY created_at DESC LIMIT 10`,
      [tenantId]
    );
    res.json({ jobs: rows });
  } catch (err) {
    console.error('[Orders] Import status error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
