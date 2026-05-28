const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const cc = require('../services/crossChannelAnalysis');

const router = express.Router();
router.use(authMiddleware, tenantMiddleware);

// GET /api/cross-channel/summary?days=30 - KPI aggregati + top anomalie
router.get('/summary', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const summary = await cc.getSummary(req.tenantId, days);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cross-channel/products?days=30&anomaly=loss_leader
router.get('/products', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const anomalyFilter = req.query.anomaly;
    let rows = await cc.getCrossChannelData(req.tenantId, days);
    if (anomalyFilter) {
      rows = rows.filter(r => r.anomalies.some(a => a.code === anomalyFilter));
    }
    res.json({ days, count: rows.length, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
