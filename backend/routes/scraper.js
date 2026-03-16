const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const { importScraperData } = require('../services/driveScraper');

const router = express.Router();

router.use(authMiddleware, tenantMiddleware);

// GET /api/scraper/stats - Scraper data overview
router.get('/stats', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(DISTINCT product_code) as total_products,
         COUNT(*) as total_entries,
         COUNT(DISTINCT merchant) as total_merchants,
         MIN(updated_at) as oldest_entry,
         MAX(updated_at) as newest_entry
       FROM scraper_competitors
       WHERE updated_at > NOW() - INTERVAL '48 hours'`
    );

    const { rows: lastRefresh } = await pool.query(
      `SELECT * FROM scraper_refresh_log ORDER BY completed_at DESC LIMIT 1`
    );

    res.json({
      stats: rows[0],
      lastRefresh: lastRefresh[0] || null,
    });
  } catch (err) {
    console.error('[Scraper] Stats error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/scraper/product/:code - Competitors for a product
router.get('/product/:code', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT product_code, merchant, position, base_price, shipping_cost, total_price, reviews, source, scraped_at, updated_at
       FROM scraper_competitors
       WHERE product_code = $1 AND updated_at > NOW() - INTERVAL '48 hours'
       ORDER BY position ASC`,
      [req.params.code]
    );
    res.json({ competitors: rows });
  } catch (err) {
    console.error('[Scraper] Product competitors error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/scraper/import - Trigger manual scraper import
router.post('/import', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const tenantId = req.tenantId;

    // Check running import
    const { rows: running } = await pool.query(
      `SELECT id FROM import_jobs
       WHERE tenant_id = $1 AND job_type = 'scraper_import' AND status IN ('pending', 'running')`,
      [tenantId]
    );

    if (running.length > 0) {
      return res.status(409).json({ error: 'Importazione scraper già in corso' });
    }

    // Create job
    const { rows } = await pool.query(
      `INSERT INTO import_jobs (tenant_id, job_type, status, metadata)
       VALUES ($1, 'scraper_import', 'pending', $2) RETURNING id`,
      [tenantId, JSON.stringify({ triggeredBy: req.user.email })]
    );
    const jobId = rows[0].id;

    // Run in background
    importScraperData(tenantId, jobId).catch(err => {
      console.error('[Scraper] Background import error:', err.message);
    });

    res.json({ jobId, message: 'Import scraper avviato' });
  } catch (err) {
    console.error('[Scraper] Import trigger error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/scraper/import/status - Last import jobs
router.get('/import/status', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, status, started_at, completed_at, records_processed,
              records_imported, records_updated, error_message, metadata, created_at
       FROM import_jobs
       WHERE tenant_id = $1 AND job_type = 'scraper_import'
       ORDER BY created_at DESC LIMIT 10`,
      [req.tenantId]
    );
    res.json({ jobs: rows });
  } catch (err) {
    console.error('[Scraper] Import status error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/scraper/top-merchants - Top merchants by product count
router.get('/top-merchants', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT merchant, COUNT(DISTINCT product_code) as product_count,
              AVG(position) as avg_position, AVG(total_price) as avg_price,
              MAX(reviews) as max_reviews
       FROM scraper_competitors
       WHERE updated_at > NOW() - INTERVAL '48 hours'
       GROUP BY merchant
       ORDER BY product_count DESC
       LIMIT 50`
    );
    res.json({ merchants: rows });
  } catch (err) {
    console.error('[Scraper] Top merchants error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
