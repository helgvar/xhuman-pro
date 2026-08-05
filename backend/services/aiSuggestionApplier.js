/**
 * Auto-apply per suggerimenti AI a basso rischio.
 *
 * Regole di sicurezza (HARD):
 *  - Mai abbassare mol_floor_pct sotto 15
 *  - Mai disabilitare killer_skip
 *  - Solo severity = 'low' o 'medium'
 *  - Solo type: 'adjust_briglia' (cambio config_value) o 'quarantine_sku'
 *  - Cambi config solo per chiavi whitelisted
 *  - Variazione tp_target_incidence_max max ±0.5 per applicazione
 *
 * Esegue ogni 4h via cron. Salva tracking in ai_audit_suggestions
 * (status='applied', applied_at).
 */

const { pool } = require('../db/pool');

const SAFE_CONFIG_KEYS = new Set([
  'tp_target_incidence_max',
  'promote_store_seller_min_sales',
  'quarantine_release_min_store_sales',
  'killer_skip_min_store_sales',
  'salva_bilancio_min_margin_eur',
  'pepite_silver_position_max',
  'pepite_silver_sales_min',
  'pepite_golden_position_max',
  'prefer_erp_stock_only',
]);

const HARD_LIMITS = {
  mol_floor_pct: { min: 15 },                       // mai sotto 15
  tp_target_incidence_max: { min: 2.0, max: 8.0 },  // sane bounds
  promote_store_seller_min_sales: { min: 0, max: 5 },
  quarantine_release_min_store_sales: { min: 1, max: 5 },
  killer_skip_min_store_sales: { min: 1, max: 3 },  // non disabilitabile (default 1)
  salva_bilancio_min_margin_eur: { min: 1.5, max: 5 },
};

const MAX_DELTA = {
  tp_target_incidence_max: 0.5,                     // ±0.5 per round
};

async function getCurrentConfig(tenantId, key) {
  const { rows } = await pool.query(
    `SELECT config_value FROM health_config
     WHERE tenant_id=$1 AND config_key=$2
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [tenantId, key]
  );
  return rows[0]?.config_value || null;
}

function isWithinDelta(key, from, to) {
  const delta = MAX_DELTA[key];
  if (!delta) return true;
  return Math.abs(parseFloat(to) - parseFloat(from)) <= delta;
}

function isWithinLimits(key, val) {
  // 1. Validazione stretta: il valore DEVE essere una rappresentazione
  // numerica pulita (es. "5.5" sì, "5.5 (test)" no, "0_temporaneo" no).
  const str = String(val).trim();
  if (!/^-?\d+(\.\d+)?$/.test(str)) return false;
  const num = parseFloat(str);
  if (!Number.isFinite(num)) return false;
  // 2. Limiti hard per chiave
  const limit = HARD_LIMITS[key];
  if (!limit) return true;
  if (limit.min != null && num < limit.min) return false;
  if (limit.max != null && num > limit.max) return false;
  return true;
}

// Direzioni vietate (cfr. MANDATO PRIMARIO: aumentare fatturato).
// L'auto-apply NON puo' RESTRINGERE l'ammissione di SKU al feed senza review umana.
// L'AI puo' suggerirlo (severity high) ma deve passare per approvazione manuale.
const NARROWING_DIRECTIONS = {
  prefer_erp_stock_only: { fromTo: ['0', '1'], reason: 'esclude supplier_stock, riduce ADD' },
  promote_store_seller_min_sales: { type: 'increase', reason: 'restringe l\'ammissione' },
  pepite_silver_position_max: { type: 'decrease', reason: 'riduce pepite silver' },
  pepite_golden_position_max: { type: 'decrease', reason: 'riduce pepite golden' },
  pepite_silver_sales_min: { type: 'increase', reason: 'restringe silver' },
  salva_bilancio_min_margin_eur: { type: 'increase', reason: 'riduce PRICE_CUT competitivi' },
};

function isNarrowingDirection(key, from, to) {
  const rule = NARROWING_DIRECTIONS[key];
  if (!rule) return null;
  const fromN = parseFloat(from);
  const toN = parseFloat(to);
  if (rule.fromTo) {
    if (String(from) === rule.fromTo[0] && String(to) === rule.fromTo[1]) return rule.reason;
    return null;
  }
  if (rule.type === 'increase' && toN > fromN) return rule.reason;
  if (rule.type === 'decrease' && toN < fromN) return rule.reason;
  return null;
}

async function applyAction(tenantId, action) {
  if (!action || !action.type) return { ok: false, reason: 'no_action' };

  if (action.type === 'adjust_briglia' || action.type === 'config_change') {
    const key = action.target;
    if (!SAFE_CONFIG_KEYS.has(key)) {
      return { ok: false, reason: `key_not_whitelisted: ${key}` };
    }
    const to = action.params?.to ?? action.params?.value;
    if (to == null) return { ok: false, reason: 'no_target_value' };
    if (!isWithinLimits(key, to)) {
      return { ok: false, reason: `out_of_limits: ${key}=${to}` };
    }
    const current = await getCurrentConfig(tenantId, key);
    if (current && !isWithinDelta(key, current, to)) {
      return { ok: false, reason: `delta_too_big: ${current}→${to}` };
    }
    // Blocco direzione restrittiva (cfr. MANDATO PRIMARIO: aumentare fatturato).
    if (current) {
      const narrowing = isNarrowingDirection(key, current, to);
      if (narrowing) {
        return { ok: false, reason: `narrowing_direction_blocked: ${key} ${current}→${to} (${narrowing})` };
      }
    }
    // Upsert config
    await pool.query(
      `INSERT INTO health_config (tenant_id, config_key, config_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value=$3`,
      [tenantId, key, String(to)]
    );
    return { ok: true, change: `${key}: ${current ?? 'default'} → ${to}` };
  }

  if (action.type === 'quarantine_sku') {
    // MANDATO CAPO (12-13/7): l'auto-apply NON può RESTRINGERE (narrowing).
    // Le quarantene suggerite dall'AI restano PENDING per review umana
    // nella pagina AiAudit — mai applicate in automatico.
    return { ok: false, reason: 'narrowing_richiede_review_umana (mandato 12/7)' };
    // eslint-disable-next-line no-unreachable
    const sku = action.target;
    if (!sku) return { ok: false, reason: 'no_sku' };
    const days = parseInt(action.params?.days) || 15;
    if (days < 7 || days > 60) return { ok: false, reason: 'invalid_days' };
    await pool.query(
      `INSERT INTO feed_quarantine (tenant_id, sku, quarantine_level, quarantine_start, quarantine_end, reason, reactivated)
       VALUES ($1, $2, 2, NOW(), NOW() + ($3 || ' days')::interval, $4, false)
       ON CONFLICT (tenant_id, sku) DO UPDATE SET
         reactivated=false, quarantine_level=2,
         quarantine_end=NOW() + ($3 || ' days')::interval`,
      [tenantId, sku, String(days), `AI auto: ${action.reasoning || 'killer fresh'}`]
    );
    return { ok: true, change: `quarantine ${sku} for ${days}d` };
  }

  return { ok: false, reason: `unsupported_type: ${action.type}` };
}

/**
 * Processa suggerimenti pending applicabili.
 * Filtri: severity in (low, medium), action type in whitelist.
 * High severity → resta pending per review manuale.
 */
async function processAutoApply({ tenantId = null, dryRun = false } = {}) {
  const filters = [`status='pending'`, `severity IN ('low','medium')`];
  const params = [];
  if (tenantId) { params.push(tenantId); filters.push(`tenant_id=$${params.length}`); }
  const { rows: suggestions } = await pool.query(
    `SELECT id, tenant_id, severity, category, title, suggested_actions
     FROM ai_audit_suggestions
     WHERE ${filters.join(' AND ')}
       AND run_at > NOW() - INTERVAL '24 hours'
     ORDER BY id DESC LIMIT 50`,
    params
  );

  let applied = 0, skipped = 0;
  const log = [];
  for (const s of suggestions) {
    const actions = Array.isArray(s.suggested_actions) ? s.suggested_actions : [];
    let anyApplied = false;
    const changeLog = [];
    for (const a of actions) {
      const safeActionTypes = ['adjust_briglia','config_change','quarantine_sku'];
      if (!safeActionTypes.includes(a.type)) {
        log.push({ sid: s.id, action: a.type, result: 'skip_unsafe_type' });
        continue;
      }
      if (dryRun) {
        log.push({ sid: s.id, action: a.type, target: a.target, result: 'dry_run' });
        continue;
      }
      const r = await applyAction(s.tenant_id, a);
      log.push({ sid: s.id, action: a.type, target: a.target, ...r });
      if (r.ok) { anyApplied = true; changeLog.push(r.change); }
    }
    if (anyApplied) {
      await pool.query(
        `UPDATE ai_audit_suggestions
         SET status='applied', applied_at=NOW(), reviewed_by='ai_auto_applier'
         WHERE id=$1`,
        [s.id]
      );
      applied++;
    } else {
      skipped++;
    }
  }
  return { processed: suggestions.length, applied, skipped, log };
}

module.exports = { processAutoApply };
