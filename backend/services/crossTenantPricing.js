/**
 * Cross-Tenant Pricing — fornisce al feedEngine la mappa SKU → prezzi negli
 * altri tenant per affinare le decisioni di PRICE_CUT.
 *
 * Logica decisionale del PRICE_CUT (in cascata):
 *   1) target competitivo da scraper TP (logica esistente, basata su competitor)
 *   2) target cross-tenant: se altro nostro tenant vende lo stesso SKU sotto
 *      il nostro prezzo E ha buon margine, usa quel prezzo come riferimento
 *      (sappiamo che è sostenibile)
 *   3) target Pareto: se SKU e' nei top 20% pareto, valutare allineamento al
 *      prezzo medio cross-tenant (non oltre il min)
 *   4) margin floor (regole concordate con il cliente):
 *        - prezzo < 10€ → margine min 18%
 *        - prezzo 10-30€ → margine min 14%
 *        - prezzo > 30€ → margine min 12%
 *      Mai scendere sotto il floor anche se altri tenant lo fanno (potrebbero
 *      vendere sottocosto o avere costi di acquisto migliori).
 *   5) revenue-first guard: stimare Δfatturato_perso. Se il taglio rischia di
 *      ridurre revenue piu' del risparmio TP atteso, abortire (delegato al
 *      caller via flag `safeToApply`).
 */

const { pool } = require('../db/pool');

let _cachedSkuMap = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

/**
 * Carica la mappa cross-tenant: { sku: { prices: [...], min, max, avg, n_tenants } }
 * Filtrata per SKU che hanno almeno 2 tenant con prezzo > 0.
 * Cache 30 min per evitare query massive ad ogni run.
 */
async function loadCrossTenantPriceMap(force = false) {
  if (!force && _cachedSkuMap && (Date.now() - _cachedAt) < CACHE_TTL_MS) {
    return _cachedSkuMap;
  }
  const { rows } = await pool.query(`
    SELECT p.sku, t.name AS tenant_name, p.tenant_id, p.sell_price
    FROM products p
    JOIN tenants t ON t.id = p.tenant_id
    WHERE p.sell_price > 0 AND t.status = 'active'
      AND (COALESCE(p.erp_stock,0) > 0 OR COALESCE(p.supplier_stock,0) > 0)
  `);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.sku)) map.set(r.sku, []);
    map.get(r.sku).push({ tenant_id: r.tenant_id, tenant_name: r.tenant_name, sell_price: parseFloat(r.sell_price) });
  }
  // Compute aggregate per SKU
  const result = new Map();
  for (const [sku, entries] of map.entries()) {
    if (entries.length < 2) continue; // serve cross-tenant signal
    const prices = entries.map(e => e.sell_price);
    result.set(sku, {
      n_tenants: entries.length,
      min: Math.min(...prices),
      max: Math.max(...prices),
      avg: +(prices.reduce((s, p) => s + p, 0) / prices.length).toFixed(2),
      entries,
    });
  }
  _cachedSkuMap = result;
  _cachedAt = Date.now();
  return result;
}

/**
 * Calcola il margin floor per un dato sell_price secondo le regole concordate.
 * Restituisce il prezzo minimo accettabile dato erp_cost e fascia di prezzo.
 *
 * Regole:
 *   sell_price < 10€   → margine min 18% → floor = erp_cost / (1 - 0.18)
 *   sell_price 10-30€  → margine min 14% → floor = erp_cost / (1 - 0.14)
 *   sell_price > 30€   → margine min 12% → floor = erp_cost / (1 - 0.12)
 */
function marginFloor(currentSellPrice, erpCost) {
  if (!erpCost || erpCost <= 0) return null;
  const minMarginPct = currentSellPrice < 10 ? 0.18
    : currentSellPrice <= 30 ? 0.14
    : 0.12;
  return +(erpCost / (1 - minMarginPct)).toFixed(2);
}

/**
 * Suggerisce il prezzo target per un SKU del tenant corrente, integrando:
 * - prezzo competitivo (input dal caller, dato dal scraper TP)
 * - prezzo cross-tenant min/avg
 * - margin floor (regole cliente)
 *
 * @param {object} args
 * @param {string} args.tenantId - tenant corrente (escluso dal cross-tenant)
 * @param {string} args.sku
 * @param {number} args.currentSellPrice
 * @param {number} args.erpCost
 * @param {number|null} args.competitiveTarget - target dal scraper (o null)
 * @param {Map} args.crossTenantMap - mappa pre-loaded da loadCrossTenantPriceMap()
 * @returns {{ recommendedPrice, source, floor, crossTenantMin, crossTenantAvg, otherTenantsCount, abortReason }}
 */
function suggestPriceCut({ tenantId, sku, currentSellPrice, erpCost, competitiveTarget, crossTenantMap }) {
  const floor = marginFloor(currentSellPrice, erpCost);
  const crossEntry = crossTenantMap?.get(sku);
  const otherEntries = (crossEntry?.entries || []).filter(e => e.tenant_id !== tenantId);

  if (otherEntries.length === 0) {
    // Nessun signal cross-tenant: usa target competitivo se disponibile, altrimenti hold
    if (competitiveTarget != null && competitiveTarget < currentSellPrice) {
      const recommended = floor ? Math.max(competitiveTarget, floor) : competitiveTarget;
      return { recommendedPrice: recommended, source: 'scraper_only', floor, crossTenantMin: null, crossTenantAvg: null, otherTenantsCount: 0 };
    }
    return { recommendedPrice: null, source: 'no_signal', floor, crossTenantMin: null, crossTenantAvg: null, otherTenantsCount: 0, abortReason: 'no_competitive_or_cross_signal' };
  }

  const otherPrices = otherEntries.map(e => e.sell_price);
  const crossMin = Math.min(...otherPrices);
  const crossAvg = +(otherPrices.reduce((s, p) => s + p, 0) / otherPrices.length).toFixed(2);

  // Target cross-tenant: il min degli altri (che converge naturalmente al market price tra i nostri)
  // Se il min cross-tenant e' >= currentSellPrice, vuol dire che siamo gia' competitivi tra di noi
  // → non serve cut da cross-tenant
  let crossTarget = null;
  if (crossMin < currentSellPrice) crossTarget = crossMin;

  // Combina con scraper target: prendi il piu' aggressivo (= il piu' basso)
  let target = null;
  let source = 'no_signal';
  if (competitiveTarget != null && crossTarget != null) {
    target = Math.min(competitiveTarget, crossTarget);
    source = competitiveTarget <= crossTarget ? 'scraper_competitive' : 'cross_tenant';
  } else if (competitiveTarget != null) {
    target = competitiveTarget;
    source = 'scraper_competitive';
  } else if (crossTarget != null) {
    target = crossTarget;
    source = 'cross_tenant';
  }

  if (target == null || target >= currentSellPrice) {
    return { recommendedPrice: null, source: 'already_aligned', floor, crossTenantMin: crossMin, crossTenantAvg: crossAvg, otherTenantsCount: otherEntries.length, abortReason: 'no_lower_target' };
  }

  // Applica floor: non andare mai sotto il margine minimo
  let recommendedPrice = target;
  let aborted = false;
  if (floor != null && recommendedPrice < floor) {
    if (currentSellPrice <= floor) {
      // Siamo gia' sotto il floor (caso sospetto): non tagliare oltre
      return { recommendedPrice: null, source, floor, crossTenantMin: crossMin, crossTenantAvg: crossAvg, otherTenantsCount: otherEntries.length, abortReason: 'already_below_floor' };
    }
    recommendedPrice = floor;
    aborted = true; // segnaliamo che il taglio e' stato limitato dal floor
  }

  // Round a 2 decimali
  recommendedPrice = +recommendedPrice.toFixed(2);
  if (recommendedPrice >= currentSellPrice) {
    return { recommendedPrice: null, source, floor, crossTenantMin: crossMin, crossTenantAvg: crossAvg, otherTenantsCount: otherEntries.length, abortReason: 'rounded_up_to_current' };
  }

  return {
    recommendedPrice,
    source,
    floor,
    crossTenantMin: crossMin,
    crossTenantAvg: crossAvg,
    otherTenantsCount: otherEntries.length,
    cutLimitedByFloor: aborted,
    cutPct: +(((currentSellPrice - recommendedPrice) / currentSellPrice) * 100).toFixed(1),
  };
}

module.exports = { loadCrossTenantPriceMap, marginFloor, suggestPriceCut };
