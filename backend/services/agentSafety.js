/**
 * Agent Safety — Regole invalicabili e livelli di sicurezza
 *
 * Le regole invalicabili NON possono essere superate da nessun utente,
 * nemmeno con password admin. Sono hardcoded e non modificabili.
 *
 * I livelli di sicurezza determinano se un'azione:
 * - safe: eseguita subito
 * - risky: richiede conferma esplicita
 * - critical: richiede password admin
 * - blocked: rifiutata sempre (regola invalicabile)
 */

const { pool } = require('../db/pool');

// ─── REGOLE INVALICABILI (hardcoded, non modificabili) ──

const UNBREAKABLE_RULES = [
  {
    id: 'max_remove_pct',
    description: 'Non puoi rimuovere piu del 30% del feed in una singola azione',
    check: (action, ctx) => {
      if (action.type === 'remove' && action.skus && action.skus.length > ctx.feedSize * 0.30) {
        return `Non puoi rimuovere ${action.skus.length} prodotti (${(action.skus.length / ctx.feedSize * 100).toFixed(0)}% del feed). Massimo: ${Math.floor(ctx.feedSize * 0.30)}`;
      }
    }
  },
  {
    id: 'price_below_cost',
    description: 'Il prezzo non puo scendere sotto il costo',
    check: (action, ctx) => {
      if (action.type === 'price_cut' && action.products) {
        for (const p of action.products) {
          if (p.newPrice <= p.cost) {
            return `Prezzo proposto per ${p.sku} (${p.newPrice}) e sotto il costo (${p.cost})`;
          }
        }
      }
    }
  },
  {
    id: 'max_price_cut_pct',
    description: 'Il taglio prezzo massimo e il 25%',
    check: (action, ctx) => {
      if (action.type === 'price_cut' && action.products) {
        for (const p of action.products) {
          const cutPct = ((p.currentPrice - p.newPrice) / p.currentPrice) * 100;
          if (cutPct > 25) {
            return `Taglio del ${cutPct.toFixed(0)}% per ${p.sku} supera il massimo (25%)`;
          }
        }
      }
    }
  },
  {
    id: 'min_feed_size',
    description: 'Il feed deve avere almeno 100 prodotti',
    check: (action, ctx) => {
      if (action.type === 'remove' && action.skus) {
        const remaining = ctx.feedSize - action.skus.length;
        if (remaining < 100) {
          return `Rimarrebbero solo ${remaining} prodotti nel feed. Minimo: 100`;
        }
      }
    }
  },
  {
    id: 'min_margin_brackets',
    description: 'Rispetta margini minimi per fascia (<10=18%, 10-30=14%, >30=12%)',
    check: (action, ctx) => {
      if (action.type === 'price_cut' && action.products) {
        for (const p of action.products) {
          const minMarkup = p.currentPrice < 10 ? 0.18 : p.currentPrice < 30 ? 0.14 : 0.12;
          const minPrice = p.cost * (1 + minMarkup);
          if (p.newPrice < minPrice) {
            const fascia = p.currentPrice < 10 ? '<10' : p.currentPrice < 30 ? '10-30' : '>30';
            return `Prezzo ${p.newPrice} per ${p.sku} viola il margine minimo ${(minMarkup * 100)}% (fascia ${fascia}). Minimo: ${minPrice.toFixed(2)}`;
          }
        }
      }
    }
  },
  {
    id: 'session_limit',
    description: 'Massimo 500 azioni per sessione',
    check: (action, ctx) => {
      if (ctx.sessionActions >= 500) {
        return 'Limite di 500 azioni per sessione raggiunto. Apri una nuova sessione.';
      }
    }
  },
  {
    id: 'no_negative_price',
    description: 'Il prezzo non puo essere negativo o zero',
    check: (action, ctx) => {
      if (action.type === 'price_cut' && action.products) {
        for (const p of action.products) {
          if (p.newPrice <= 0) return `Prezzo non puo essere ${p.newPrice} per ${p.sku}`;
        }
      }
    }
  },
];

// ─── SAFETY LEVELS ──────────────────────────────────────

function calculateSafetyLevel(action, ctx) {
  const skuCount = action.skus?.length || action.products?.length || 0;
  const feedPct = ctx.feedSize > 0 ? (skuCount / ctx.feedSize) * 100 : 0;

  if (action.type === 'remove') {
    if (skuCount <= 10) return 'safe';
    if (skuCount <= 100) return 'risky';
    return 'critical';
  }

  if (action.type === 'add') {
    if (skuCount <= 20) return 'safe';
    if (skuCount <= 200) return 'risky';
    return 'critical';
  }

  if (action.type === 'price_cut') {
    const maxCutPct = Math.max(...(action.products || []).map(p =>
      ((p.currentPrice - p.newPrice) / p.currentPrice) * 100
    ), 0);
    if (skuCount <= 5 && maxCutPct <= 5) return 'safe';
    if (skuCount <= 50 && maxCutPct <= 15) return 'risky';
    return 'critical';
  }

  if (action.type === 'add_rule' || action.type === 'remove_rule') {
    return 'safe';
  }

  if (action.type === 'recalculate') {
    return 'safe';
  }

  return 'risky';
}

// ─── CHECK ACTION ───────────────────────────────────────

async function checkAction(action, tenantId, sessionId) {
  // 1. Get context
  const { rows: [feedCount] } = await pool.query(
    "SELECT COUNT(*) as cnt FROM products WHERE tenant_id = $1 AND is_civetta = true AND (COALESCE(erp_stock,0) + COALESCE(supplier_stock,0)) > 0",
    [tenantId]
  );
  const { rows: [sessionCount] } = await pool.query(
    "SELECT COUNT(*) as cnt FROM agent_actions_log WHERE session_id = $1 AND status = 'executed'",
    [sessionId]
  );

  const ctx = {
    feedSize: parseInt(feedCount.cnt) || 0,
    sessionActions: parseInt(sessionCount.cnt) || 0,
  };

  // 2. Check unbreakable rules
  for (const rule of UNBREAKABLE_RULES) {
    const violation = rule.check(action, ctx);
    if (violation) {
      return {
        allowed: false,
        safetyLevel: 'blocked',
        reason: violation,
        ruleId: rule.id,
      };
    }
  }

  // 3. Check tenant-specific rules
  const { rows: tenantRules } = await pool.query(
    "SELECT * FROM agent_tenant_rules WHERE tenant_id = $1 AND is_active = true AND (expires_at IS NULL OR expires_at > NOW())",
    [tenantId]
  );

  for (const rule of tenantRules) {
    const violation = checkTenantRule(rule, action);
    if (violation) {
      return {
        allowed: false,
        safetyLevel: 'blocked',
        reason: `Regola tenant: ${violation}`,
        ruleId: `tenant_${rule.id}`,
      };
    }
  }

  // 4. Calculate safety level
  const safetyLevel = calculateSafetyLevel(action, ctx);

  return {
    allowed: true,
    safetyLevel,
    requiresConfirmation: safetyLevel === 'risky',
    requiresPassword: safetyLevel === 'critical',
    context: ctx,
  };
}

function checkTenantRule(rule, action) {
  const cfg = rule.rule_config;

  if (rule.rule_type === 'exclude_price_rule' && action.type === 'price_cut') {
    // Check if any product in the action has this price rule type
    if (action.products) {
      for (const p of action.products) {
        if (p.ruleType === cfg.price_rule_type) {
          return `Prodotto ${p.sku} ha regola "${cfg.price_rule_type}" - prezzo non modificabile (${rule.reason || ''})`;
        }
      }
    }
  }

  if (rule.rule_type === 'exclude_brand') {
    if (action.products) {
      for (const p of action.products) {
        if (p.brand && p.brand.toLowerCase().includes(cfg.brand.toLowerCase())) {
          return `Brand "${cfg.brand}" protetto (${rule.reason || ''})`;
        }
      }
    }
  }

  if (rule.rule_type === 'protect_sku' && action.type === 'remove') {
    const protectedSkus = cfg.skus || [];
    if (action.skus) {
      for (const sku of action.skus) {
        if (protectedSkus.includes(sku)) {
          return `SKU ${sku} protetto (${rule.reason || ''})`;
        }
      }
    }
  }

  if (rule.rule_type === 'exclude_sku' && action.type === 'add') {
    const excludedSkus = cfg.skus || [];
    if (action.skus) {
      for (const sku of action.skus) {
        if (excludedSkus.includes(sku)) {
          return `SKU ${sku} escluso dal feed (${rule.reason || ''})`;
        }
      }
    }
  }

  if (rule.rule_type === 'max_price_cut_pct' && action.type === 'price_cut') {
    const maxPct = cfg.max_pct || 10;
    if (action.products) {
      for (const p of action.products) {
        const cutPct = ((p.currentPrice - p.newPrice) / p.currentPrice) * 100;
        if (cutPct > maxPct) {
          return `Taglio ${cutPct.toFixed(1)}% supera il limite tenant di ${maxPct}% (${rule.reason || ''})`;
        }
      }
    }
  }

  return null;
}

// ─── VERIFY PASSWORD ────────────────────────────────────

async function verifyAdminPassword(userId, password) {
  const bcrypt = require('bcrypt');
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (rows.length === 0) return false;
  return bcrypt.compare(password, rows[0].password_hash);
}

module.exports = {
  UNBREAKABLE_RULES,
  checkAction,
  calculateSafetyLevel,
  verifyAdminPassword,
};
