/**
 * PAUSA OTTIMIZZAZIONE SCRAPER (ordine capo 11/7/2026)
 *
 * "Da ora fino a che non te lo dico io: non bloccare MINSAN con regole legate
 *  alle posizioni dei competitor, metti in pausa l'ottimizzazione legata allo
 *  scraper." — lo scraper FB era FERMO dal 9/7: dati posizioni monchi,
 * qualunque condanna o prezzo calcolato da lì è inaffidabile.
 *
 * Flag: global_config.scraper_optimization_paused = '1' (pausa) / '0' (riattiva).
 * Riattivazione: UPDATE global_config SET config_value='0'
 *                WHERE config_key='scraper_optimization_paused';
 * Gated: paretoPositioner, priceJumpMonitor (governor+harvest+autofix),
 *        aiMarginCalibrator, positionLog floor_overrides, winback branch PC,
 *        feedHygieneCycle caccia-opportunità. Le LIBERAZIONI (amnistie,
 *        winback release, coorti, rebuild) restano attive: la pausa ferma solo
 *        blocchi e prezzi position-driven.
 */

const { pool } = require('../db/pool');

async function isScraperOptimizationPaused() {
  try {
    const { rows } = await pool.query(
      "SELECT config_value FROM global_config WHERE config_key = 'scraper_optimization_paused'");
    return rows.length > 0 && rows[0].config_value === '1';
  } catch (e) {
    console.error('[ScraperPause] check err (fail-open):', e.message);
    return false;
  }
}

module.exports = { isScraperOptimizationPaused };
