/**
 * CPC Resolver - per-tenant Trovaprezzi cost-per-click.
 *
 * Legge `health_config.avg_tp_cpc` per ciascun tenant. Fallback al DEFAULT.
 * Cache 10 min per evitare hit DB ad ogni calcolo aggregato.
 *
 * USO TIPICO:
 *   const { getTenantCpc, DEFAULT_CPC } = require('./cpcConfig');
 *   const cpc = await getTenantCpc(tenantId);
 *   const spend = clicks * cpc;
 */

const { pool } = require('../db/pool');

const DEFAULT_CPC = 0.27;
// `health_config.avg_tp_cpc` e' sempre il CPC NETTO (IVA esclusa). Il costo che
// paghiamo davvero e' netto + IVA 22%: 0,27 -> 0,3294. Ogni cifra mostrata come
// "spesa" o usata come numeratore di un'incidenza deve essere LORDA.
const VAT_MULT = 1.22;
const TTL_MS = 10 * 60 * 1000;

const _cache = new Map(); // tenantId → { cpc, expires }

async function getTenantCpc(tenantId) {
  if (!tenantId) return DEFAULT_CPC;
  const cached = _cache.get(tenantId);
  if (cached && cached.expires > Date.now()) return cached.cpc;

  let cpc = DEFAULT_CPC;
  try {
    const { rows } = await pool.query(
      `SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = 'avg_tp_cpc'`,
      [tenantId]
    );
    if (rows[0]?.config_value) {
      const v = parseFloat(rows[0].config_value);
      if (isFinite(v) && v > 0 && v < 5) cpc = v;
    }
  } catch { /* fallback to default */ }

  _cache.set(tenantId, { cpc, expires: Date.now() + TTL_MS });
  return cpc;
}

// CPC lordo = quello che esce davvero dal conto corrente. Usare questo per
// spesa e incidenza; `getTenantCpc` resta il netto per chi confronta con tariffe.
async function getTenantCpcGross(tenantId) {
  return (await getTenantCpc(tenantId)) * VAT_MULT;
}

function invalidateCpcCache(tenantId) {
  if (tenantId) _cache.delete(tenantId); else _cache.clear();
}

module.exports = { getTenantCpc, getTenantCpcGross, invalidateCpcCache, DEFAULT_CPC, VAT_MULT };
