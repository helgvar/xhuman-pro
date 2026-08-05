/**
 * 📖 LIBRO GIORNALE DEGLI ORDINI DEL CAPO (13/7/2026)
 * Ogni ordine impartito dal capo, per tenant, con data/ora, azione ed esito.
 * La dashboard lo mostra per singolo tenant; la sessione lo consulta per
 * capire se azioni simili sono già state fatte.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// GET /api/capo-ordini?tenant_id=<uuid>|rete — newest first.
// Con tenant_id: righe del tenant + righe globali (tenant_id NULL).
router.get('/', async (req, res) => {
  const { tenant_id } = req.query;
  try {
    let rows;
    if (tenant_id && tenant_id !== 'tutti') {
      ({ rows } = await pool.query(`
        SELECT co.*, t.name AS tenant_name
        FROM capo_ordini co LEFT JOIN tenants t ON t.id = co.tenant_id
        WHERE co.tenant_id = $1 OR co.tenant_id IS NULL
        ORDER BY co.ordinato_at DESC LIMIT 300`,
        [tenant_id === 'rete' ? null : tenant_id]));
      if (tenant_id === 'rete') {
        ({ rows } = await pool.query(`
          SELECT co.*, NULL AS tenant_name FROM capo_ordini co
          WHERE co.tenant_id IS NULL ORDER BY co.ordinato_at DESC LIMIT 300`));
      }
    } else {
      ({ rows } = await pool.query(`
        SELECT co.*, t.name AS tenant_name
        FROM capo_ordini co LEFT JOIN tenants t ON t.id = co.tenant_id
        ORDER BY co.ordinato_at DESC LIMIT 300`));
    }
    res.json({ items: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
