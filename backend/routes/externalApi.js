/**
 * External API for Farmabooster
 *
 * Endpoints consumed by Farmabooster to get feed decisions:
 * - /feed/civetta — list of SKUs to include in TP feed
 * - /feed/prices — price overrides
 * - /feed/action-plan — full action plan
 * - /feed/acknowledge — confirm actions applied
 *
 * Auth: X-API-Key header (per-tenant key from tenant_configs)
 *
 * Stable cache: always serves the last valid complete result.
 * Persisted in tenant_configs (stable_feed_codes, stable_price_cuts).
 * Updated by healthCron after each feed engine run.
 */

const crypto = require('crypto');
const express = require('express');
const { pool } = require('../db/pool');

const router = express.Router();

// ─── API KEY AUTH (SHA256 hashed) ───────────────────────

async function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'X-API-Key header required' });

  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  // Check tenant_api_keys table (primary)
  const { rows } = await pool.query(
    `SELECT ak.id as key_id, ak.name as key_name, ak.tenant_id, t.name as tenant_name
     FROM tenant_api_keys ak
     JOIN tenants t ON t.id = ak.tenant_id AND t.status = 'active'
     WHERE ak.key_hash = $1 AND ak.active = true`,
    [keyHash]
  );

  if (rows.length === 0) {
    // Fallback: check tenant_configs (backward compat)
    const { rows: legacyRows } = await pool.query(
      `SELECT tc.tenant_id, t.name as tenant_name FROM tenant_configs tc
       JOIN tenants t ON t.id = tc.tenant_id AND t.status = 'active'
       WHERE tc.config_key = 'xhumanpro_api_key' AND (tc.config_value = $1 OR tc.config_value = $2)`,
      [apiKey, keyHash]
    );
    if (legacyRows.length === 0) return res.status(403).json({ error: 'Invalid API key' });
    req.tenantId = legacyRows[0].tenant_id;
    req.tenantName = legacyRows[0].tenant_name;
    req.apiKeyId = null;
    req.apiKeyName = 'legacy';
  } else {
    req.tenantId = rows[0].tenant_id;
    req.tenantName = rows[0].tenant_name;
    req.apiKeyId = rows[0].key_id;
    req.apiKeyName = rows[0].key_name;
    // Update last_used_at
    pool.query('UPDATE tenant_api_keys SET last_used_at = NOW() WHERE id = $1', [rows[0].key_id]).catch(() => {});
  }
  next();
}

router.use(apiKeyAuth);

// ─── STABLE CACHE ───────────────────────────────────────
// Always serves last valid complete result. Updated by healthCron.

const stableCache = new Map(); // tenantId → { feedCodes, priceCuts, updatedAt }

async function loadStableCache(tenantId) {
  if (stableCache.has(tenantId)) return stableCache.get(tenantId);
  try {
    const { rows } = await pool.query(
      `SELECT config_key, config_value FROM tenant_configs
       WHERE tenant_id = $1 AND config_key IN ('stable_feed_codes', 'stable_price_cuts', 'stable_civetta_response', 'stable_prices_response')`,
      [tenantId]
    );
    const entry = { feedCodes: null, removeCodes: null, priceCuts: null, updatedAt: null };
    for (const row of rows) {
      try {
        const val = JSON.parse(row.config_value);
        if (row.config_key === 'stable_feed_codes') {
          entry.feedCodes = val.codes;
          entry.removeCodes = val.removeCodes || null;
          entry.updatedAt = val.updatedAt;
        } else if (row.config_key === 'stable_price_cuts') {
          entry.priceCuts = val.products;
        }
      } catch { /* corrupt */ }
    }
    stableCache.set(tenantId, entry);
    if (entry.feedCodes) {
      console.log(`[FeedStable][T:${tenantId.slice(0, 8)}] Loaded: ${entry.feedCodes.length} civetta, ${(entry.priceCuts || []).length} price cuts`);
    }
    return entry;
  } catch (e) {
    console.warn(`[FeedStable][T:${tenantId.slice(0, 8)}] DB load failed:`, e.message);
    const empty = { feedCodes: null, priceCuts: null, updatedAt: null };
    stableCache.set(tenantId, empty);
    return empty;
  }
}

/**
 * Recalculate stable cache from feed_actions + products.
 * Called by healthCron after each feed engine run.
 *
 * CIVETTA=1 criteria (strict):
 * - civetta=1 in Magento AND NOT in quarantine AND NOT REMOVE
 * - OR explicitly ADD by feed engine (pepite)
 *
 * CIVETTA=0 (removeCodes): quarantined + REMOVE actions
 * Passed to Farmabooster every time so it can deactivate them.
 */
async function recalculateStableCache(tenantId) {
  // Filtro qualità feed: se health_config.feed_filter_inactive_filler='true',
  // escludo SKU senza nessun segnale (filler dormienti che diluiscono il feed).
  // Regola TIENI: health_score>=30 OR ord_tp>0 OR (erp+MOL>=18) OR MOL>=22
  //               OR (pos<=7 AND MOL>=12 AND stock>=5) "pepita borderline"
  //               OR (pos<=20 AND erp>=5 AND MOL>=15) "stock farmacia pos decente"
  const { rows: filterCfgRows } = await pool.query(
    `SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = 'feed_filter_inactive_filler'`,
    [tenantId]
  );
  const filterEnabled = filterCfgRows.length > 0 && filterCfgRows[0].config_value === 'true';

  // Filtro STRICT (direttiva 3/7/2026): nel CSV TP restano SOLO SKU vendibili
  // (pos <= 10) o che vendono (store/seller/rete), più le eccezioni meritate
  // (coorti fresche, azioni manuali, ADD engine, brand protetti).
  // Vive QUI — a monte della cache — perché is_civetta è un mirror di Magento
  // che productSync/civetta_sync sovrascrivono ogni ciclo: un flag locale non
  // sopravvive, un filtro alla build sì.
  const { rows: strictRows } = await pool.query(
    `SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = 'feed_filter_strict'`,
    [tenantId]
  );
  const strictEnabled = strictRows.length > 0 && strictRows[0].config_value === 'true';
  const { rows: brandRows } = await pool.query(
    `SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = 'killer_protected_brands'`,
    [tenantId]
  );
  const protectedBrands = brandRows.length > 0
    ? brandRows[0].config_value.split(',').map(b => b.trim().toUpperCase()).filter(Boolean)
    : [];

  // Posizione target DINAMICA per tenant (direttiva utente: mai hardcoded).
  // Fallback tenant-wide = MAX(scraper_position) tra le regole prezzo attive;
  // il per-prodotto usa la posizione della SUA regola (vedi strictFilter).
  let tenantMaxPos = 10;
  let strictPosMin = 0;
  if (strictEnabled) {
    const { rows: posRows } = await pool.query(
      `SELECT MAX((rule_data->>'scraper_position')::int) AS max_pos
       FROM price_rules
       WHERE tenant_id = $1 AND (rule_data->>'scraper_position')::int > 0`,
      [tenantId]
    );
    tenantMaxPos = posRows[0]?.max_pos || 10;
    // Hack test (SubitoFarma 4/7): floor di valutazione posizione — regole
    // grossista a target 5/6 valutate a 9 (GREATEST), il 12 diretto resta 12
    const { rows: minRows } = await pool.query(
      `SELECT config_value::int AS v FROM health_config
       WHERE tenant_id = $1 AND config_key = 'strict_pos_target_min'`,
      [tenantId]
    );
    strictPosMin = minRows[0]?.v || 0;
  }

  // Pre-compute SKU con ordini reali 30g (per evitare EXISTS nested = 92s timeout).
  // Una sola scansione orders+order_items, poi JOIN nella query principale.
  const ctePrefix = (filterEnabled || strictEnabled) ? `
    WITH skus_with_orders_30d AS (
      SELECT DISTINCT oi.sku
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.tenant_id = $1
        AND o.order_status NOT IN ('canceled','closed','pending_payment')
        AND o.order_date >= NOW() - INTERVAL '30 days'
    )` : '';

  const qualityFilter = filterEnabled ? `
        AND (
          EXISTS (
            SELECT 1 FROM product_health_scores phs
            WHERE phs.tenant_id = p.tenant_id AND phs.sku = p.sku
              AND (
                COALESCE(phs.health_score, 0) >= 30
                OR (phs.scraper_position IS NOT NULL AND phs.scraper_position <= 10
                    AND COALESCE(p.margin_pct, 0) >= 12
                    AND (COALESCE(p.erp_stock, 0) + COALESCE(p.supplier_stock, 0)) >= 3)
                OR (phs.scraper_position IS NOT NULL AND phs.scraper_position <= 25
                    AND COALESCE(p.erp_stock, 0) >= 3
                    AND COALESCE(p.margin_pct, 0) >= 15)
              )
          )
          OR EXISTS (SELECT 1 FROM skus_with_orders_30d so WHERE so.sku = p.sku)
          OR (COALESCE(p.erp_stock, 0) > 0 AND COALESCE(p.margin_pct, 0) >= 18)
          OR COALESCE(p.margin_pct, 0) >= 22
          -- Estensione utente 25/6: grossista valido + MOL discreto + prezzo non bagatelle
          OR (COALESCE(p.supplier_stock, 0) >= 5
              AND COALESCE(p.margin_pct, 0) >= 14
              AND COALESCE(p.sell_price, 0) >= 8)
          -- Brand protetti: la linea va tutta online, il filtro qualità non li tocca
          OR is_brand_protected(p.tenant_id, p.sku)
          -- PIN DEL CAPO: vince anche sul filtro qualità
          OR EXISTS (SELECT 1 FROM capo_pins cp WHERE cp.tenant_id = p.tenant_id
                       AND cp.sku = p.sku AND cp.revoked_at IS NULL)
        )` : '';

  const strictFilter = strictEnabled ? `
        AND (
          EXISTS (SELECT 1 FROM product_health_scores sph
                  WHERE sph.tenant_id = p.tenant_id AND sph.sku = p.sku
                    AND sph.scraper_position <= GREATEST(COALESCE(
                      NULLIF((SELECT (pr2.rule_data->>'scraper_position')::int
                              FROM price_rules pr2
                              WHERE pr2.tenant_id = p.tenant_id
                                AND pr2.rule_id = p.price_rule_id), 0),
                      $3::int), $4::int))
          OR EXISTS (SELECT 1 FROM skus_with_orders_30d so WHERE so.sku = p.sku)
          OR COALESCE(p.sales_30d_seller, 0) > 0
          OR COALESCE(p.sales_30d_aggregated, 0) >= 2
          OR EXISTS (SELECT 1 FROM activation_cohorts ac
                     WHERE ac.tenant_id = p.tenant_id AND ac.sku = p.sku
                       AND ac.activated_at >= NOW() - INTERVAL '14 days')
          OR EXISTS (SELECT 1 FROM feed_actions fam
                     WHERE fam.tenant_id = p.tenant_id AND fam.sku = p.sku
                       AND fam.action_source IN ('manual_pepita','margin_harvest_pilot','manual_review','pareto_ai'))
          OR fa.action = 'ADD'
          OR (fa.action = 'PRICE_CUT' AND fa.recommended_price IS NOT NULL)
          OR UPPER(COALESCE(p.brand, '')) = ANY($2::text[])
          -- PIN DEL CAPO: vince anche sullo strict
          OR EXISTS (SELECT 1 FROM capo_pins cp WHERE cp.tenant_id = p.tenant_id
                       AND cp.sku = p.sku AND cp.revoked_at IS NULL)
        )` : '';

  // REGOLA DI BACKUP (ordine capo 11/7): finché lo scraper FB non riparte
  // (pausa attiva), le attivazioni AI senza confronto competitor (ADD e
  // coorti) valgono solo se il civetta di Farmabooster è d'accordo (=1).
  // Il merito oggettivo (pos<=10 con dato reale, venduto seller) e i brand
  // protetti restano sovrani: lì il confronto o la vendita c'è.
  const scraperPausedBuild = await require('../services/scraperPause').isScraperOptimizationPaused();
  const civettaBackup = scraperPausedBuild ? 'AND p.is_civetta = true' : '';

  // Build civetta=1 list (keep in feed)
  const keepParams = strictEnabled ? [tenantId, protectedBrands, tenantMaxPos, strictPosMin] : [tenantId];
  const { rows: keepProducts } = await pool.query(`
    ${ctePrefix}
    SELECT p.sku
    FROM products p
    LEFT JOIN feed_actions fa ON fa.tenant_id = p.tenant_id AND fa.sku = p.sku
    LEFT JOIN feed_quarantine fq ON fq.tenant_id = p.tenant_id AND fq.sku = p.sku AND fq.reactivated = false
    WHERE p.tenant_id = $1
      AND (COALESCE(p.erp_stock, 0) + COALESCE(p.supplier_stock, 0)) > 0
      AND COALESCE(p.sell_price, 0) > 0   -- Skip SKU senza prezzo (sync sporco): non sprecare click TP
      -- OBLIO cross-tenant: SKU burner globali esclusi da TUTTI i tenant.
      -- ECCEZIONE stock safety net (9/7): il tenant con magazzino FISICO
      -- lo tiene in vetrina — la regola aurea batte l'oblio di rete
      AND (NOT EXISTS (SELECT 1 FROM cross_tenant_oblio o WHERE o.sku = p.sku AND o.status = 'active')
           OR (COALESCE(p.erp_stock, 0) >= COALESCE((SELECT hc3.config_value::int FROM health_config hc3
                 WHERE hc3.tenant_id = p.tenant_id AND hc3.config_key = 'stock_safety_net_min_units'), 5)
               AND COALESCE(p.margin_pct, 0) >= 20)
           OR is_brand_protected(p.tenant_id, p.sku))
      AND (
        (p.is_civetta = true AND (fa.action IS NULL OR fa.action NOT IN ('REMOVE')) AND fq.id IS NULL)
        OR
        -- REGOLA DI BACKUP (ordine capo 11/7, finché non riparte lo scraper):
        -- senza confronto competitor, un'attivazione AI (ADD/coorte) vale SOLO
        -- se Farmabooster è d'accordo (suo civetta=1). FB civetta=0 → fuori.
        (fa.action = 'ADD' AND fq.id IS NULL ${civettaBackup})
        OR
        -- PC attivo = scommessa in corso: senza listing il taglio non lavora
        (fa.action = 'PRICE_CUT' AND fa.recommended_price IS NOT NULL AND fq.id IS NULL)
        OR
        -- Coorti fresche (winback/push/pepite): il mirror Magento può stompare
        -- is_civetta prima che Farmabooster applichi civettaai — la coorte
        -- garantisce la membership CSV finché l'attivazione matura (14gg)
        (fq.id IS NULL AND (fa.action IS NULL OR fa.action <> 'REMOVE')
         AND EXISTS (SELECT 1 FROM activation_cohorts ac2
                     WHERE ac2.tenant_id = p.tenant_id AND ac2.sku = p.sku
                       AND ac2.activated_at >= NOW() - INTERVAL '14 days') ${civettaBackup})
        OR
        -- MERITO OGGETTIVO (fix circolo vizioso 10/7): is_civetta è l'ECO delle
        -- nostre decisioni passate (CSV→FB→Magento→mirror). Un'uscita transitoria
        -- spegneva il flag e il prodotto non rientrava MAI, anche in top10 con
        -- vendite. Posizione in classifica o venduto 30g = dentro, eco o non eco.
        (fq.id IS NULL AND (fa.action IS NULL OR fa.action <> 'REMOVE')
         AND (COALESCE(p.sales_30d_seller, 0) > 0
              OR EXISTS (SELECT 1 FROM product_health_scores sphm
                         WHERE sphm.tenant_id = p.tenant_id AND sphm.sku = p.sku
                           AND sphm.scraper_position <= 10)))
        OR
        -- PIN DEL CAPO (13/7: 'se ti dico attiva un prodotto, xHumanPro lo
        -- recepisce e NON lo stacca più'): ordine esplicito, sempre in feed
        -- finché non revocato — sopra ogni filtro, motore o quarantena
        (EXISTS (SELECT 1 FROM capo_pins cp WHERE cp.tenant_id = p.tenant_id
                   AND cp.sku = p.sku AND cp.revoked_at IS NULL))
        OR
        -- BRAND PROTETTI (dictat 10/7: 'Eucerin è protetto, va tutta online'):
        -- la linea del cliente è SEMPRE esposta per intero — nessun filtro di
        -- posizione, qualità o civetta può nasconderla. Restano sovrani solo
        -- quarantene/REMOVE deliberati (che i trigger comunque vietano qui).
        (fq.id IS NULL AND (fa.action IS NULL OR fa.action <> 'REMOVE')
         AND is_brand_protected(p.tenant_id, p.sku))
      )${qualityFilter}${strictFilter}
  `, keepParams);

  let feedCodes = keepProducts.map(p => p.sku);

  // 🐎 BRIGLIE LARGHE (ordine capo 12/7 sera, SubitoFarma 72h): finché il
  // flag non scade, il feed = TUTTO il vivo (stock+prezzo+saleable) tranne
  // l'OBLIO, più QUALUNQUE prodotto col nostro merchant in posizione <=N su
  // TP (anche civetta FB=0). Config: health_config.briglie_larghe = N
  // (posizione max), con expires_at. Alla scadenza si torna alle regole.
  try {
    const { rows: briglie } = await pool.query(
      `SELECT config_value::int AS pos_max FROM health_config
       WHERE tenant_id = $1 AND config_key = 'briglie_larghe'
         AND config_value ~ '^[0-9]+$'
         AND (expires_at IS NULL OR expires_at > NOW())`, [tenantId]);
    if (briglie.length > 0) {
      const posMax = briglie[0].pos_max;
      const { rows: wide } = await pool.query(`
        WITH mm AS (SELECT rx FROM (VALUES
          ('SubitoFarma','subitofarma'), ('Farmacia San Vito','san vito'), ('MPF','personal farma'),
          ('Papa','farmacia papa'), ('Farmacia Procaccini','procaccini'), ('Farmacri','farmacri'),
          ('Farmainsieme','farmainsieme'), ('Farmacia Mandanici','mandanici'),
          ('Farmacia Ospedale','ospedale'), ('Farmastelia','farmastelia')) v(tn, rx)
          JOIN tenants t ON t.name = v.tn WHERE t.id = $1)
        SELECT p.sku FROM products p
        WHERE p.tenant_id = $1 AND p.saleable = true
          AND (COALESCE(p.erp_stock, 0) + COALESCE(p.supplier_stock, 0)) > 0
          AND COALESCE(p.sell_price, 0) > 0
          AND (p.is_civetta = true
               OR EXISTS (SELECT 1 FROM scraper_competitors sc, mm
                          WHERE sc.product_code = p.sku AND sc.merchant ~* mm.rx
                            AND sc.position BETWEEN 1 AND $2))
          AND NOT EXISTS (SELECT 1 FROM cross_tenant_oblio o
                          WHERE o.sku = p.sku AND o.status = 'active')`,
        [tenantId, posMax]);
      // UNIONE col feed normale: le briglie larghe AGGIUNGONO, mai tolgono
      const wideSet = new Set(feedCodes);
      for (const w of wide) wideSet.add(w.sku);
      feedCodes = Array.from(wideSet);
      console.log(`[FeedStable][T:${tenantId.slice(0, 8)}] 🐎 BRIGLIE LARGHE attive (pos<=${posMax}): feed aperto a ${feedCodes.length} prodotti (solo oblio escluso)`);
    }
  } catch (e) { console.error('[FeedStable] briglie larghe err:', e.message); }

  // Isteresi (direttiva 4/7/2026): i dati scraper sono rumorosi e i CSV
  // oscillavano di migliaia di SKU tra build (Procaccini 13,6k->9,8k in ore).
  // Chi passa il filtro aggiorna last_pass in feed_membership; chi era membro
  // e ora fallisce lo STRICT resta in grazia per feed_exit_grace_hours (72h
  // default) purché passi i filtri BASE. Uscite immediate restano tali:
  // killer/REMOVE/quarantena/oblio/stock 0/prezzo 0.
  if (strictEnabled) {
    try {
      const { rows: graceCfg } = await pool.query(
        `SELECT config_value::int AS h FROM health_config
         WHERE tenant_id = $1 AND config_key = 'feed_exit_grace_hours'`, [tenantId]);
      const graceHours = graceCfg.length > 0 ? graceCfg[0].h : 72;
      for (let i = 0; i < feedCodes.length; i += 5000) {
        await pool.query(`
          INSERT INTO feed_membership (tenant_id, sku, last_pass)
          SELECT $1, unnest($2::text[]), NOW()
          ON CONFLICT (tenant_id, sku) DO UPDATE SET last_pass = NOW()
          WHERE feed_membership.last_pass < NOW() - INTERVAL '4 hours'`,
          [tenantId, feedCodes.slice(i, i + 5000)]);
      }
      if (graceHours > 0) {
        const { rows: graceRows } = await pool.query(`
          SELECT fm.sku
          FROM feed_membership fm
          JOIN products p ON p.tenant_id = fm.tenant_id AND p.sku = fm.sku
          LEFT JOIN feed_actions fa ON fa.tenant_id = p.tenant_id AND fa.sku = p.sku
          LEFT JOIN feed_quarantine fq ON fq.tenant_id = p.tenant_id AND fq.sku = p.sku AND fq.reactivated = false
          WHERE fm.tenant_id = $1
            AND fm.last_pass >= NOW() - ($2 || ' hours')::interval
            AND NOT (fm.sku = ANY($3::text[]))
            AND (COALESCE(p.erp_stock, 0) + COALESCE(p.supplier_stock, 0)) > 0
            AND COALESCE(p.sell_price, 0) > 0
            AND (fa.action IS NULL OR fa.action <> 'REMOVE')
            AND fq.id IS NULL
            AND (NOT EXISTS (SELECT 1 FROM cross_tenant_oblio o WHERE o.sku = p.sku AND o.status = 'active')
                 OR (COALESCE(p.erp_stock, 0) >= COALESCE((SELECT hc3.config_value::int FROM health_config hc3
                       WHERE hc3.tenant_id = p.tenant_id AND hc3.config_key = 'stock_safety_net_min_units'), 5)
                     AND COALESCE(p.margin_pct, 0) >= 20))
            AND NOT EXISTS (SELECT 1 FROM feed_killers fk WHERE fk.tenant_id = p.tenant_id AND fk.sku = p.sku AND fk.is_active)`,
          [tenantId, graceHours, feedCodes]);
        if (graceRows.length > 0) {
          feedCodes = feedCodes.concat(graceRows.map(r => r.sku));
          console.log(`[FeedStable][T:${tenantId.slice(0, 8)}] Isteresi: +${graceRows.length} in grazia (${graceHours}h)`);
        }
      }
      await pool.query(
        `DELETE FROM feed_membership WHERE tenant_id = $1 AND last_pass < NOW() - INTERVAL '30 days'`,
        [tenantId]);
    } catch (e) {
      console.error('[FeedStable] isteresi err:', e.message);
    }
  }

  // Module 2: Feed Cap — limit max products with priority sorting
  const { rows: capCfg } = await pool.query(
    `SELECT config_key, config_value FROM health_config WHERE tenant_id = $1 AND config_key IN ('feed_cap_enabled', 'feed_cap_max')`,
    [tenantId]
  );
  const capConfig = {};
  for (const r of capCfg) capConfig[r.config_key] = r.config_value;
  const feedCapEnabled = capConfig.feed_cap_enabled === 'true';
  const feedCapMax = parseInt(capConfig.feed_cap_max || 25000);

  let cappedProducts = [];
  if (feedCapEnabled && feedCodes.length > feedCapMax) {
    // Ordinamento del cap (rev. 5/8, ordine capo "feed sotto i 20.000 senza tagliare vendite").
    // La vecchia formula pesava tp_attributed_orders/revenue: dato VIETATO dalla dottrina
    // (l'unica verita' sulle vendite sono gli ordini reali Magento). Qui la priorita' e':
    //   1. brand protetti  -> non escono MAI dal feed per cap ("i brand lasciali stare")
    //   2. pin del capo    -> prima classe protetta
    //   3. vendite reali Magento 90gg (ordini, poi fatturato)
    //   4. stock fisico in farmacia (regola aurea: spingere il magazzino)
    //   5. health_score come spareggio
    // Chi resta in coda e finisce sotto la soglia e' materia muta: ne' vende ne' clicca.
    const { rows: priorityRows } = await pool.query(`
      WITH ord90 AS (
        SELECT oi.sku,
               COUNT(DISTINCT o.id) AS ordini,
               SUM(oi.qty_ordered * oi.price) AS fatt
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.tenant_id = $1
          AND o.order_date >= NOW() - INTERVAL '90 days'
          AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
        GROUP BY 1
      )
      SELECT ph.sku,
        (CASE WHEN is_brand_protected($1, ph.sku) THEN 1000000 ELSE 0 END +
         CASE WHEN EXISTS (SELECT 1 FROM capo_pins cp
                           WHERE cp.tenant_id = $1 AND cp.sku = ph.sku
                             AND cp.revoked_at IS NULL) THEN 500000 ELSE 0 END +
         COALESCE(o90.ordini, 0) * 100 +
         COALESCE(o90.fatt, 0) * 0.1 +
         CASE WHEN COALESCE(p.erp_stock, 0) > 0 THEN 50 ELSE 0 END +
         COALESCE(ph.health_score, 0)) AS priority_score
      FROM product_health_scores ph
      LEFT JOIN ord90 o90 ON o90.sku = ph.sku
      LEFT JOIN products p ON p.tenant_id = ph.tenant_id AND p.sku = ph.sku
      WHERE ph.tenant_id = $1 AND ph.sku = ANY($2)
    `, [tenantId, feedCodes]);

    const priorityMap = new Map(priorityRows.map(r => [r.sku, parseFloat(r.priority_score) || 0]));
    feedCodes.sort((a, b) => (priorityMap.get(b) || 0) - (priorityMap.get(a) || 0));

    cappedProducts = feedCodes.splice(feedCapMax);
    console.log(`[FeedCap][T:${tenantId.slice(0, 8)}] Cap ${feedCapMax}: ${cappedProducts.length} products below threshold`);
  }

  // Build civetta=0 list (quarantine + explicit REMOVE — ALWAYS included in response)
  const { rows: removeRows } = await pool.query(`
    SELECT DISTINCT sku FROM (
      SELECT fq.sku FROM feed_quarantine fq
      WHERE fq.tenant_id = $1 AND fq.reactivated = false
      UNION
      SELECT fa.sku FROM feed_actions fa
      WHERE fa.tenant_id = $1 AND fa.action = 'REMOVE'
    ) sub
  `, [tenantId]);

  const removeCodes = removeRows.map(r => r.sku);

  // Add capped products to remove list (Module 2)
  if (cappedProducts.length > 0) {
    const removeSet = new Set(removeCodes);
    for (const sku of cappedProducts) {
      if (!removeSet.has(sku)) removeCodes.push(sku);
    }
  }

  // Build price cuts list.
  // Includiamo ANCHE i record action='ADD' che hanno un recommended_price
  // (es. promotion_salva_bilancio). Sono SKU che mettiamo in feed civetta
  // CON un nuovo prezzo: senza emetterli qui, Farmabooster non aggiorna il
  // prezzo e l'SKU entrerebbe in feed con il vecchio (non competitivo).
  const { rows: priceCutRows } = await pool.query(`
    SELECT fa.sku as code, fa.recommended_price as newprice
    FROM feed_actions fa
    WHERE fa.tenant_id = $1
      AND fa.recommended_price IS NOT NULL
      AND (fa.action = 'PRICE_CUT' OR fa.action = 'ADD')
      -- VETO brand protetti (cintura oltre al trigger DB): i prezzi dei brand
      -- strategia-cliente non escono MAI nel payload verso Farmabooster
      AND NOT EXISTS (
        SELECT 1 FROM products p2
        JOIN health_config hc ON hc.tenant_id = p2.tenant_id
          AND hc.config_key = 'killer_protected_brands'
        WHERE p2.tenant_id = fa.tenant_id AND p2.sku = fa.sku
          AND UPPER(COALESCE(p2.brand, '')) IN
            (SELECT BTRIM(UPPER(x)) FROM unnest(STRING_TO_ARRAY(hc.config_value, ',')) x)
      )
  `, [tenantId]);

  const priceCuts = priceCutRows.map(r => ({ code: r.code, newprice: String(Math.round(parseFloat(r.newprice) * 100) / 100) }));

  const updatedAt = new Date().toISOString();
  const entry = { feedCodes, removeCodes, priceCuts, updatedAt };

  // 🪂 PARACADUTE FEED (capo 12/7: 'se continuiamo a troncare i feed di
  // Trovaprezzi andiamo in bancarotta'): un rebuild non può RESTRINGERE il
  // CSV oltre il 10% in un colpo. Se accade: si MANTIENE il feed precedente,
  // allarme Telegram, e serve una decisione umana.
  // Bypass deliberato (tagli voluti dal capo): health_config feed_drop_guard_off='1'
  try {
    const { rows: guardPrev } = await pool.query(
      `SELECT jsonb_array_length(config_value::jsonb->'codes') n, config_value
       FROM tenant_configs WHERE tenant_id = $1 AND config_key = 'stable_feed_codes'`, [tenantId]);
    const prevN = guardPrev.length > 0 ? parseInt(guardPrev[0].n) : 0;
    const { rows: guardOff } = await pool.query(
      `SELECT 1 FROM health_config WHERE tenant_id = $1
       AND config_key = 'feed_drop_guard_off' AND config_value = '1'`, [tenantId]);
    if (guardOff.length === 0 && prevN > 1000 && feedCodes.length < prevN * 0.90) {
      console.error(`[FeedStable][T:${tenantId.slice(0, 8)}] 🪂 PARACADUTE: build ${feedCodes.length} vs precedente ${prevN} (oltre -10%) — feed precedente MANTENUTO`);
      try {
        const { sendTelegram } = require('../services/telegramNotifier');
        await sendTelegram(
          `🪂 <b>PARACADUTE FEED</b>: la build voleva ridurre un CSV da ${prevN} a ${feedCodes.length} prodotti (oltre -10%). ` +
          `Feed precedente MANTENUTO — verificare la causa prima di autorizzare (bypass: feed_drop_guard_off=1).`,
          { key: `feed_guard_${tenantId}`, parseMode: 'HTML', throttleMs: 2 * 3600 * 1000 });
      } catch {}
      const prevCfg = JSON.parse(guardPrev[0].config_value);
      const prevEntry = { feedCodes: prevCfg.codes || [], removeCodes: prevCfg.removeCodes || [], priceCuts, updatedAt };
      stableCache.set(tenantId, prevEntry);
      return prevEntry;
    }
  } catch (e) { console.error('[FeedStable] paracadute err:', e.message); }

  stableCache.set(tenantId, entry);

  // Log entrata/uscita dal feed (direttiva 3/7/2026): diff del CSV vs build
  // precedente. Questo è il feed VERO che va a TP — il trigger su is_civetta
  // logga solo il mirror Magento, qui logghiamo la membership effettiva.
  try {
    const { rows: prevRows } = await pool.query(
      `SELECT config_value FROM tenant_configs WHERE tenant_id = $1 AND config_key = 'stable_feed_codes'`,
      [tenantId]
    );
    const prevCodes = prevRows.length > 0
      ? (JSON.parse(prevRows[0].config_value).codes || []) : [];
    const prevSet = new Set(prevCodes);
    const newSet = new Set(feedCodes);
    const entered = feedCodes.filter(s => !prevSet.has(s));
    const exited = prevCodes.filter(s => !newSet.has(s));
    for (const [list, dir] of [[entered, 'IN'], [exited, 'OUT']]) {
      for (let i = 0; i < list.length; i += 1000) {
        await pool.query(`
          INSERT INTO feed_movements (tenant_id, sku, direction, reason, sell_price, ricarico_pct, erp_stock)
          SELECT p.tenant_id, p.sku, $3, 'csv_build', p.sell_price,
            CASE WHEN COALESCE(p.erp_cost, 0) > 0
                 THEN ROUND(((p.sell_price - p.erp_cost) / p.erp_cost * 100)::numeric, 2) END,
            p.erp_stock
          FROM products p WHERE p.tenant_id = $1 AND p.sku = ANY($2)`,
          [tenantId, list.slice(i, i + 1000), dir]);
      }
    }
    if (entered.length || exited.length) {
      console.log(`[FeedMovements][T:${tenantId.slice(0, 8)}] CSV diff: IN=${entered.length} OUT=${exited.length}`);
    }
  } catch (e) {
    console.error('[FeedMovements] diff log error:', e.message);
  }

  // Persist to DB
  await pool.query(
    `INSERT INTO tenant_configs (tenant_id, config_key, config_value)
     VALUES ($1, 'stable_feed_codes', $2)
     ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = $2`,
    [tenantId, JSON.stringify({ codes: feedCodes, removeCodes, updatedAt })]
  );
  await pool.query(
    `INSERT INTO tenant_configs (tenant_id, config_key, config_value)
     VALUES ($1, 'stable_price_cuts', $2)
     ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = $2`,
    [tenantId, JSON.stringify({ products: priceCuts })]
  );

  console.log(`[FeedStable][T:${tenantId.slice(0, 8)}] Saved: ${feedCodes.length} civetta=1, ${removeCodes.length} civetta=0, ${priceCuts.length} price cuts`);
  return entry;
}

// ─── HELPERS ────────────────────────────────────────────

async function logDispatch(tenantId, endpoint, productsServed, req, responseBody) {
  const summary = {};
  if (responseBody) {
    if (responseBody.stats) summary.stats = responseBody.stats;
    if (responseBody.summary) summary.summary = responseBody.summary;
    if (responseBody.products && Array.isArray(responseBody.products)) {
      summary.productCount = responseBody.products.length;
      // Sample first 5 products for quick inspection
      summary.sample = responseBody.products.slice(0, 5);
    }
  }
  await pool.query(
    `INSERT INTO feed_dispatch_log (tenant_id, endpoint, products_served, request_ip, response_summary, api_key_name, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [tenantId, endpoint, productsServed, req.ip, JSON.stringify(summary), req.apiKeyName || null]
  ).catch(e => {
    // If column doesn't exist, fallback to basic log
    pool.query(
      `INSERT INTO feed_dispatch_log (tenant_id, endpoint, products_served, request_ip)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, endpoint, productsServed, req.ip]
    ).catch(() => {});
  });
}

// ─── ENDPOINTS ──────────────────────────────────────────

// GET /api/external/v1/feed/civetta
// civetta=1: feed COMPLETO — tutti i prodotti da pubblicare (FB svuota e ricarica)
// civetta=0: DIFF — solo i code rimossi rispetto al dispatch precedente (informativo)
router.get('/feed/civetta', async (req, res) => {
  try {
    let cached = await loadStableCache(req.tenantId);
    if (!cached.feedCodes) {
      cached = await recalculateStableCache(req.tenantId);
    }

    const currentFeed = new Set(cached.feedCodes);

    // Load previous dispatch feed to calculate DIFF
    const { rows: [prevDispatch] } = await pool.query(
      "SELECT config_value FROM tenant_configs WHERE tenant_id = $1 AND config_key = 'last_dispatched_feed'",
      [req.tenantId]
    );
    let removed = [];
    if (prevDispatch?.config_value) {
      try {
        const prevCodes = JSON.parse(prevDispatch.config_value).codes || [];
        // Removed = was in previous feed but NOT in current feed
        removed = prevCodes.filter(code => !currentFeed.has(code));
      } catch {}
    }

    // Build response: civetta=1 (full feed) + civetta=0 (removed since last dispatch)
    const products = [
      ...cached.feedCodes.map(code => ({ code, civetta: '1' })),
      ...removed.map(code => ({ code, civetta: '0' })),
    ];

    // Save current feed as "last dispatched" for next diff calculation
    await pool.query(
      `INSERT INTO tenant_configs (tenant_id, config_key, config_value)
       VALUES ($1, 'last_dispatched_feed', $2)
       ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = $2`,
      [req.tenantId, JSON.stringify({ codes: cached.feedCodes, dispatchedAt: new Date().toISOString() })]
    );

    // Mark actions as dispatched
    await pool.query(
      `UPDATE feed_actions SET status = 'dispatched', dispatched_at = NOW()
       WHERE tenant_id = $1 AND status = 'pending'`,
      [req.tenantId]
    ).catch(() => {});

    const response = {
      tenant: { id: req.tenantId, name: req.tenantName },
      generatedAt: cached.updatedAt,
      stats: {
        totalCivetta1: cached.feedCodes.length,
        totalCivetta0: removed.length,
        totalProducts: products.length,
      },
      note: 'civetta=1 e il feed COMPLETO da pubblicare. civetta=0 sono i code rimossi rispetto al dispatch precedente (informativo).',
      products,
    };

    console.log(`[FeedCivetta][T:${req.tenantId.slice(0, 8)}] Feed: ${cached.feedCodes.length} civetta=1, ${removed.length} rimossi vs precedente → ${req.apiKeyName}`);
    await logDispatch(req.tenantId, 'GET /feed/civetta', products.length, req, response);
    res.json(response);
  } catch (err) {
    console.error('[ExternalAPI] Civetta error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/external/v1/feed/civetta
// Query specific SKUs
router.post('/feed/civetta', async (req, res) => {
  try {
    const { codes } = req.body;
    if (!codes || !Array.isArray(codes)) {
      return res.status(400).json({ error: 'codes array required' });
    }
    if (codes.length > 50000) {
      return res.status(400).json({ error: 'Too many codes (max 50000)' });
    }

    let cached = await loadStableCache(req.tenantId);
    if (!cached.feedCodes) {
      cached = await recalculateStableCache(req.tenantId);
    }

    const feedSet = new Set(cached.feedCodes);
    const removeSet = new Set(cached.removeCodes || []);
    const products = codes.map(c => {
      const code = String(c).trim();
      // Explicit remove takes priority, then check feed set
      if (removeSet.has(code)) return { code, civetta: '0' };
      return { code, civetta: feedSet.has(code) ? '1' : '0' };
    });

    await logDispatch(req.tenantId, 'POST /feed/civetta', products.length, req, { products: products.slice(0, 5) });

    res.json({
      tenant: { id: req.tenantId, name: req.tenantName },
      generatedAt: cached.updatedAt,
      products,
    });
  } catch (err) {
    console.error('[ExternalAPI] Civetta query error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/external/v1/feed/prices
// Returns all active price overrides (from stable cache)
router.get('/feed/prices', async (req, res) => {
  try {
    let cached = await loadStableCache(req.tenantId);
    if (!cached.priceCuts) {
      cached = await recalculateStableCache(req.tenantId);
    }

    await logDispatch(req.tenantId, 'prices', (cached.priceCuts || []).length, req);

    console.log(`[FeedPrices][T:${req.tenantId.slice(0, 8)}] Serving ${(cached.priceCuts || []).length} price cuts (${cached.updatedAt})`);

    res.json({
      tenant: { id: req.tenantId, name: req.tenantName },
      generatedAt: cached.updatedAt,
      products: cached.priceCuts || [],
    });
  } catch (err) {
    console.error('[ExternalAPI] Prices error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/external/v1/feed/prices
// Query specific SKU prices
router.post('/feed/prices', async (req, res) => {
  try {
    const { codes } = req.body;
    if (!codes || !Array.isArray(codes)) {
      return res.status(400).json({ error: 'codes array required' });
    }
    if (codes.length > 5000) {
      return res.status(400).json({ error: 'Too many codes (max 5000)' });
    }

    let cached = await loadStableCache(req.tenantId);
    if (!cached.priceCuts) {
      cached = await recalculateStableCache(req.tenantId);
    }

    const priceMap = new Map((cached.priceCuts || []).map(p => [p.code, p.newprice]));
    const products = codes.map(c => {
      const code = String(c).trim();
      const newprice = priceMap.get(code);
      return newprice ? { code, newprice } : { code, newprice: null };
    }).filter(p => p.newprice !== null);

    res.json({
      tenant: { id: req.tenantId, name: req.tenantName },
      generatedAt: cached.updatedAt,
      products,
    });
  } catch (err) {
    console.error('[ExternalAPI] Prices query error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/external/v1/feed/action-plan
// Full action plan with summary
router.get('/feed/action-plan', async (req, res) => {
  try {
    const { rows: actions } = await pool.query(`
      SELECT fa.sku, fa.action, fa.action_reason, fa.recommended_price,
             fa.current_price, fa.price_cut_pct, fa.clicks_consumed,
             fa.cost_consumed, fa.has_conversions, fa.direct_revenue,
             fa.competitive_viable, fa.tp_position, fa.competitor_count,
             p.product_name, p.brand
      FROM feed_actions fa
      LEFT JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
      WHERE fa.tenant_id = $1
      ORDER BY fa.action, fa.cost_consumed DESC
    `, [req.tenantId]);

    const grouped = { REMOVE: [], ADD: [], PRICE_CUT: [], KEEP: [], MONITOR: [] };
    for (const a of actions) {
      if (grouped[a.action]) grouped[a.action].push({
        code: a.sku,
        name: a.product_name,
        brand: a.brand,
        action: a.action,
        reason: a.action_reason,
        position: a.tp_position,
        competitors: a.competitor_count,
        clicks: a.clicks_consumed,
        cost: parseFloat(a.cost_consumed) || 0,
        revenue: parseFloat(a.direct_revenue) || 0,
        hasConversions: a.has_conversions,
        currentPrice: parseFloat(a.current_price) || null,
        suggestedPrice: parseFloat(a.recommended_price) || null,
        priceCutPct: parseFloat(a.price_cut_pct) || null,
      });
    }

    const totalSavings = grouped.REMOVE.reduce((s, a) => s + a.cost, 0);

    // Get price cuts from stable cache for strategyOverrides
    let cached = await loadStableCache(req.tenantId);
    if (!cached.feedCodes) cached = await recalculateStableCache(req.tenantId);

    await logDispatch(req.tenantId, 'action-plan', actions.length, req);

    res.json({
      tenant: { id: req.tenantId, name: req.tenantName },
      generatedAt: cached.updatedAt,
      summary: {
        totalProducts: actions.length,
        feedActive: grouped.KEEP.length + grouped.PRICE_CUT.length,
        toRemove: grouped.REMOVE.length,
        toAdd: grouped.ADD.length,
        toPriceCut: grouped.PRICE_CUT.length,
        monitoring: grouped.MONITOR.length,
        estimatedMonthlySavings: +totalSavings.toFixed(2),
      },
      actions: grouped,
      strategyOverrides: {
        priceChanges: (cached.priceCuts || []),
        feedActions: [
          ...grouped.REMOVE.map(a => ({ code: a.code, action: 'REMOVE', reason: a.reason })),
          ...grouped.ADD.map(a => ({ code: a.code, action: 'ADD', reason: a.reason })),
        ],
        preparedAt: cached.updatedAt,
      },
    });
  } catch (err) {
    console.error('[ExternalAPI] Action plan error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/external/v1/feed/action-plan
// Query specific codes
router.post('/feed/action-plan', async (req, res) => {
  try {
    const { minsan, codes } = req.body;
    const skuList = minsan || codes;
    if (!skuList || !Array.isArray(skuList)) {
      return res.status(400).json({ error: '"minsan" or "codes" array required' });
    }
    if (skuList.length > 500) {
      return res.status(400).json({ error: 'Max 500 codes per request' });
    }

    let cached = await loadStableCache(req.tenantId);
    if (!cached.feedCodes) cached = await recalculateStableCache(req.tenantId);
    const feedSet = new Set(cached.feedCodes || []);
    const priceMap = new Map((cached.priceCuts || []).map(p => [p.code, p.newprice]));

    const { rows } = await pool.query(`
      SELECT fa.sku, fa.action, fa.action_reason, fa.recommended_price, fa.current_price,
             fa.clicks_consumed, fa.cost_consumed, fa.has_conversions, fa.direct_revenue,
             p.sell_price, p.margin, p.erp_stock
      FROM feed_actions fa
      JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
      WHERE fa.tenant_id = $1 AND fa.sku = ANY($2)
    `, [req.tenantId, skuList]);

    const actionMap = new Map(rows.map(r => [r.sku, r]));

    const products = skuList.map(code => {
      code = String(code).trim();
      const fa = actionMap.get(code);
      const priceOverride = priceMap.get(code);
      return {
        code,
        civettaRecommendation: feedSet.has(code) ? 'KEEP' : (fa?.action === 'ADD' ? 'ADD' : 'REMOVE'),
        priceOverrideActive: !!priceOverride,
        suggestedPrice: priceOverride ? parseFloat(priceOverride) : null,
        currentPrice: fa ? parseFloat(fa.current_price || fa.sell_price) : null,
        action: fa?.action || 'UNKNOWN',
        reason: fa?.action_reason || null,
        cost: fa ? parseFloat(fa.cost_consumed) : 0,
        margin: fa ? parseFloat(fa.margin) : null,
        stock: fa ? parseInt(fa.erp_stock) : null,
        civetta: feedSet.has(code) ? '1' : '0',
      };
    });

    res.json({
      tenant: { id: req.tenantId, name: req.tenantName },
      generatedAt: cached.updatedAt,
      products,
    });
  } catch (err) {
    console.error('[ExternalAPI] Action plan query error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/external/v1/scraper-updated
// Webhook FB (11/7): il dev di Farmabooster ci notifica quando lo scraper ha
// consegnato dati freschi → import immediato + riprezzo intraday. Reazione in
// secondi invece del polling orario. Body opzionale: { file, timestamp, note }.
router.post('/scraper-updated', async (req, res) => {
  console.log('[ScraperWebhook] notifica FB:', JSON.stringify(req.body || {}).slice(0, 200));
  res.json({ ok: true, received_at: new Date().toISOString() });
  // fire-and-forget: l'import gira dopo la risposta (il webhook non attende)
  setImmediate(() => {
    try {
      const { pollScraper } = require('../services/scraperPoller');
      pollScraper().catch(e => console.error('[ScraperWebhook] poll err:', e.message));
    } catch (e) {
      console.error('[ScraperWebhook] err:', e.message);
    }
  });
});

// POST /api/external/v1/feed/acknowledge
// Farmabooster confirms actions were applied
router.post('/feed/acknowledge', async (req, res) => {
  try {
    const { skus } = req.body;

    let updated;
    if (skus && Array.isArray(skus)) {
      const result = await pool.query(
        `UPDATE feed_actions SET status = 'applied', applied_at = NOW()
         WHERE tenant_id = $1 AND sku = ANY($2) AND status = 'dispatched'`,
        [req.tenantId, skus]
      );
      updated = result.rowCount;
    } else {
      const result = await pool.query(
        `UPDATE feed_actions SET status = 'applied', applied_at = NOW()
         WHERE tenant_id = $1 AND status = 'dispatched'`,
        [req.tenantId]
      );
      updated = result.rowCount;
    }

    res.json({ ok: true, acknowledged: updated });
  } catch (err) {
    console.error('[ExternalAPI] Acknowledge error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.recalculateStableCache = recalculateStableCache;
