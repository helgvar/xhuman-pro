/**
 * rumoreLoop — il rumore non si discute, si dimentica
 *
 * Ordine capo 13/09: "facciamo un check sul rumore approfondito su tutta la rete,
 * 1/4 click e 0 vendite ovunque vanno in oblio".
 *
 * Il rumore e' merce che prende pochissimi click, li prende da settimane, e non
 * vende da NESSUNA PARTE nella rete. Non e' un venditore debole: e' un costo
 * senza contropartita. Un solo click non basta a condannare (dottrina: "zero
 * vendite su pochi click e' rumore, misurabile solo a >=15 click") — per questo
 * la condanna qui non guarda il singolo click ma la CONTINUITA': chi prende
 * click in due settimane distinte ha avuto la sua occasione.
 *
 * Due destini, decisi dalla larghezza del danno:
 *   - rumore su 2+ tenant  -> OBLIO globale (cross_tenant_oblio): fuori ovunque
 *   - rumore su 1 tenant   -> REMOVE locale: altrove puo' ancora essere provato
 *
 * Tre cancelli fail-closed, perche' un taglio sbagliato costa piu' del rumore:
 *   1. ordini freschi (<=3h): senza sync recente "0 vendite" e' una bugia
 *   2. file click fresco (<=3gg): su dati vecchi un 4 click puo' essere un 9
 *   3. Farmabooster non deve dire che ha venduto (conflitto dati = non si tocca)
 *
 * Gira lunedi' 05:15 UTC / 07:15 IT — dopo il file click (05:01 IT), dopo la
 * lima (06:15 IT) e dopo il loop rete-only (06:45 IT).
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');
const { getTenantCpcGross } = require('./cpcConfig');

// Banda del rumore. Sopra i 4 click si entra nel territorio dei portatori di
// traffico, che non si tagliano mai in blocco.
const CLICK_MIN = 1;
const CLICK_MAX = 4;

// Continuita': settimane distinte con click negli ultimi 90 giorni. Uno SKU
// entrato ieri non ha avuto tempo di vendere.
const SETTIMANE_MIN = 2;

// Vendite: 90 giorni, tutta la rete. "Ovunque" e' letterale.
const GIORNI_VENDITA = 90;

// Gradualita': si smaltisce a cicli, non in un botto.
const MAX_REMOVE_PER_TENANT = 400;

// Cancelli di freschezza.
const ORE_MAX_SYNC_ORDINI = 3;
const GIORNI_MAX_FILE_CLICK = 3;

const ORDER_STATUS = ['complete', 'processing', 'pending', 'holded', 'payment_review',
  'fraud', 'ritiro_farmacia', 'Ritirato'];

const RUN_DOW      = 1;    // lunedi'
const RUN_HOUR_UTC = 5;
const RUN_MIN_UTC  = 15;   // 07:15 IT

/** Ordini freschi: senza questo "0 vendite" non e' una misura, e' un'assenza di dati. */
async function ordiniFreschi(tenantId) {
  const { rows } = await pool.query(`
    SELECT EXTRACT(EPOCH FROM (NOW() - MAX(completed_at))) / 3600 ore
      FROM import_jobs
     WHERE tenant_id = $1 AND job_type = 'orders_sync' AND status = 'completed'`,
    [tenantId]);
  const ore = rows[0]?.ore == null ? null : parseFloat(rows[0].ore);
  return { ok: ore !== null && ore <= ORE_MAX_SYNC_ORDINI, ore };
}

/** File click fresco: su un file di 5 giorni fa un "4 click" puo' essere un 9. */
async function clickFreschi(tenantId) {
  const { rows } = await pool.query(`
    SELECT MAX(fetch_date) ultimo, (CURRENT_DATE - MAX(fetch_date)) giorni
      FROM zombie_clicks WHERE tenant_id = $1`, [tenantId]);
  const g = rows[0]?.giorni == null ? null : parseInt(rows[0].giorni, 10);
  return { ok: g !== null && g <= GIORNI_MAX_FILE_CLICK, giorni: g, ultimo: rows[0]?.ultimo };
}

/**
 * Censimento del rumore su un tenant. Restituisce le righe gia' filtrate da
 * tutte le guardie: quello che torna e' condannabile, non "da valutare".
 */
async function censisci(tenantId, cpcGross) {
  const { rows } = await pool.query(`
    WITH protetti AS (
      SELECT DISTINCT UPPER(TRIM(b)) brand
        FROM health_config hc, LATERAL unnest(string_to_array(hc.config_value, ',')) b
       WHERE hc.config_key = 'killer_protected_brands' AND TRIM(b) <> ''
    ),
    -- click di QUESTO tenant: 30gg per la banda, 90gg per la continuita'
    cl AS (
      SELECT product_code sku,
             SUM(clicks) FILTER (WHERE fetch_date >= CURRENT_DATE - 30)::int click30,
             SUM(clicks)::int                                                click90,
             COUNT(DISTINCT date_trunc('week', fetch_date))::int             settimane,
             MAX(fetch_date)                                                 ultimo_click
        FROM zombie_clicks
       WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - 90
       GROUP BY 1
      HAVING SUM(clicks) FILTER (WHERE fetch_date >= CURRENT_DATE - 30) BETWEEN $3 AND $4
         AND COUNT(DISTINCT date_trunc('week', fetch_date)) >= $5
    )
    SELECT cl.sku, cl.click30, cl.click90, cl.settimane, cl.ultimo_click,
           LEFT(COALESCE(p.product_name, ''), 60) prodotto,
           NULLIF(UPPER(COALESCE(p.brand, '')), '') brand,
           COALESCE(p.erp_stock, 0) erp_stock,
           COALESCE(NULLIF(p.exported_price,0), NULLIF(p.sell_price,0), 0) prezzo,
           ROUND(cl.click30 * $6::numeric, 2) spesa30,
           -- larghezza del danno: su quanti tenant fa rumore lo stesso SKU
           (SELECT COUNT(DISTINCT z.tenant_id) FROM zombie_clicks z
             WHERE z.product_code = cl.sku AND z.fetch_date >= CURRENT_DATE - 30
             GROUP BY z.product_code)::int n_tenant_click
      FROM cl
      JOIN products p ON p.tenant_id = $1 AND p.sku = cl.sku
     WHERE COALESCE(NULLIF(p.exported_price,0), NULLIF(p.sell_price,0), 0) > 0
       -- Farmabooster dice che ha venduto: conflitto di dati, non si tocca
       AND COALESCE(p.sales_30d_seller, 0) = 0
       -- 0 VENDITE OVUNQUE: ordini reali Magento, tutta la rete, 90 giorni
       AND NOT EXISTS (
             SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE oi.sku = cl.sku
                AND o.order_status = ANY($2)
                AND o.order_date >= NOW() - make_interval(days => $7::int))
       -- classi protette
       AND (p.brand IS NULL OR UPPER(p.brand) NOT IN (SELECT brand FROM protetti))
       AND NOT is_brand_protected($1, cl.sku)
       AND NOT porta_carrelli_sani($1, cl.sku)
       AND NOT is_basket_protected($1, cl.sku)
       -- gia' gestiti altrove
       AND NOT EXISTS (SELECT 1 FROM capo_pins cp
             WHERE cp.tenant_id = $1 AND cp.sku = cl.sku AND cp.revoked_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM cross_tenant_oblio o
             WHERE o.sku = cl.sku AND o.status = 'active')
       AND NOT EXISTS (SELECT 1 FROM feed_quarantine q
             WHERE q.tenant_id = $1 AND q.sku = cl.sku AND q.reactivated = false)
       AND NOT EXISTS (SELECT 1 FROM feed_actions fa
             WHERE fa.tenant_id = $1 AND fa.sku = cl.sku AND fa.action = 'REMOVE')
     ORDER BY cl.click30 DESC, cl.click90 DESC
     LIMIT $8`,
    [tenantId, ORDER_STATUS, CLICK_MIN, CLICK_MAX, SETTIMANE_MIN, cpcGross,
     GIORNI_VENDITA, MAX_REMOVE_PER_TENANT]);
  return rows;
}

async function trattaTenant(tenant, cpcGross, dry) {
  const fo = await ordiniFreschi(tenant.id);
  if (!fo.ok) {
    return { saltato: `orders_sync ${fo.ore == null ? 'MAI' : fo.ore.toFixed(1) + 'h'} fa (max ${ORE_MAX_SYNC_ORDINI}h)` };
  }
  const fc = await clickFreschi(tenant.id);
  if (!fc.ok) {
    return { saltato: `file click ${fc.giorni == null ? 'MAI' : fc.giorni + 'gg'} fa (max ${GIORNI_MAX_FILE_CLICK}gg)` };
  }

  const cand = await censisci(tenant.id, cpcGross);
  if (!cand.length) return { cand: 0, oblio: 0, remove: 0, spesa: 0 };

  const spesa = cand.reduce((s, r) => s + parseFloat(r.spesa30 || 0), 0);
  if (dry) {
    return { cand: cand.length, oblio: cand.filter(r => r.n_tenant_click >= 2).length,
      remove: cand.filter(r => r.n_tenant_click < 2).length,
      spesa: Math.round(spesa * 100) / 100, dry: true };
  }

  const client = await pool.connect();
  let oblio = 0, remove = 0;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL xhp.writer = 'sessione_rumore'`);
    await client.query(`SELECT set_config('xhp.motivo', $1, true)`,
      ['rumore di rete: 1-4 click continui, 0 vendite ovunque in 90gg']);

    for (const r of cand) {
      const perche = `rumore: ${r.click30} click 30gg (${r.click90} su 90gg, ${r.settimane} settimane), `
        + `0 vendite OVUNQUE in rete da ${GIORNI_VENDITA}gg. ${r.spesa30} EUR/30gg bruciati.`;

      if (r.n_tenant_click >= 2) {
        // Danno di rete: fuori da tutti i negozi in un colpo solo.
        const ins = await client.query(`
          INSERT INTO cross_tenant_oblio (sku, product_name, brand, added_reason,
            tenants_affected, click_at_add, cost_at_add, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
          ON CONFLICT DO NOTHING`,
          [r.sku, r.prodotto, r.brand,
           `Rumore di rete: ${r.n_tenant_click} tenant, ${perche}`,
           r.n_tenant_click, r.click30, r.spesa30]);
        oblio += ins.rowCount;
        continue;
      }

      const ins = await client.query(`
        INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source,
          current_price, erp_stock, supplier_stock, computed_at, status)
        VALUES ($1, $2, 'REMOVE', $3, 'pulizia_rumore', $4, $5, 0, NOW(), 'pending')
        ON CONFLICT ON CONSTRAINT uq_feed_action_tenant_sku DO UPDATE SET
          action = 'REMOVE', action_source = 'pulizia_rumore',
          action_reason = EXCLUDED.action_reason, computed_at = NOW(), status = 'pending'
        WHERE feed_actions.action_source NOT IN ('muro_scavalco','manual_pepita','manual','capo_pin')`,
        [tenant.id, r.sku, perche, r.prezzo, r.erp_stock]);
      remove += ins.rowCount;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return { cand: cand.length, oblio, remove, spesa: Math.round(spesa * 100) / 100,
    vetati: cand.length - oblio - remove };
}

async function runRumoreLoop({ dry = false, soloTenant = null } = {}) {
  const { rows: tenants } = await pool.query(
    `SELECT id, name FROM tenants WHERE status = 'active'
       ${soloTenant ? 'AND name = $1' : ''} ORDER BY name`,
    soloTenant ? [soloTenant] : []);

  const esiti = [];
  for (const t of tenants) {
    try {
      const cpc = await getTenantCpcGross(t.id);
      const r = await trattaTenant(t, cpc, dry);
      esiti.push({ tenant: t.name, ...r });
      if (r.saltato) {
        console.log(`[Rumore]${dry ? ' DRY' : ''} ${t.name} — SALTATO: ${r.saltato}`);
      } else {
        console.log(`[Rumore]${dry ? ' DRY' : ''} ${t.name} — ${r.cand} candidati, `
          + `${r.oblio} in OBLIO globale, ${r.remove} REMOVE locali, ${r.spesa} EUR/30gg`
          + (r.vetati ? ` (${r.vetati} respinti da un veto)` : ''));
      }
    } catch (e) {
      console.error(`[Rumore] ${t.name} err: ${e.message}`);
      esiti.push({ tenant: t.name, errore: e.message });
    }
  }

  if (!dry) {
    const tot = esiti.reduce((a, e) => ({
      oblio: a.oblio + (e.oblio || 0),
      remove: a.remove + (e.remove || 0),
      spesa: a.spesa + (e.spesa || 0)
    }), { oblio: 0, remove: 0, spesa: 0 });
    const saltati = esiti.filter(e => e.saltato);

    if (tot.oblio || tot.remove || saltati.length) {
      const righe = esiti.filter(e => (e.oblio || e.remove))
        .sort((a, b) => b.spesa - a.spesa)
        .map(e => `• ${e.tenant}: ${e.remove} fuori, ${e.oblio} in oblio — ${e.spesa.toFixed(2)} EUR/30gg`)
        .join('\n');
      await sendTelegram(
        `🔇 <b>Rumore di rete</b>\n` +
        `1-${CLICK_MAX} click continui (${SETTIMANE_MIN}+ settimane), 0 vendite ovunque in ${GIORNI_VENDITA}gg.\n\n` +
        (righe || '<i>niente da tagliare</i>') + '\n\n' +
        `Totale: <b>${tot.remove}</b> REMOVE + <b>${tot.oblio}</b> OBLIO globale, ` +
        `<b>${tot.spesa.toFixed(2)} EUR/30gg</b> di click tolti dal rumore.\n` +
        (saltati.length
          ? `\n⏸ Saltati (dati non freschi): ${saltati.map(s => `${s.tenant} (${s.saltato})`).join(', ')}`
          : '')
      ).catch(() => {});
    }
  }
  return esiti;
}

function start() {
  const tick = () => {
    const n = new Date();
    if (n.getUTCDay() === RUN_DOW && n.getUTCHours() === RUN_HOUR_UTC
        && n.getUTCMinutes() === RUN_MIN_UTC) {
      runRumoreLoop({}).catch(e => console.error('[Rumore] run err:', e.message));
    }
  };
  setInterval(tick, 60 * 1000);
  console.log(`[Rumore] armato — lunedi' ${String(RUN_HOUR_UTC).padStart(2,'0')}:`
    + `${String(RUN_MIN_UTC).padStart(2,'0')} UTC (07:15 IT), tetto ${MAX_REMOVE_PER_TENANT}/tenant`);
}

module.exports = { start, runRumoreLoop, censisci };
