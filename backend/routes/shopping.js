const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const shopping = require('../services/shoppingOptimizer');

const router = express.Router();
router.use(authMiddleware, tenantMiddleware);

router.get('/overview', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    res.json(await shopping.getOverview(req.tenantId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/burners', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const minClicks = Math.max(parseInt(req.query.minClicks) || 5, 1);
    res.json(await shopping.getBurners(req.tenantId, { limit, minClicks }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/opportunities', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    res.json(await shopping.getOpportunities(req.tenantId, { limit }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/feed-health', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    res.json(await shopping.getFeedHealth(req.tenantId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
