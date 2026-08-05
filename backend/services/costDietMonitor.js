/**
 * Cost Diet Monitor (direttiva utente 9/7/2026)
 *
 * Dopo ogni taglio di dieta costi (quarantene reason 'cost_diet_%') valuta
 * ogni mattina se gli ORDINI del tenant sono calati rispetto alla baseline
 * pre-taglio e avvisa su Telegram. Regole supervisor: mai giorni parziali,
 * multi-evidenza (ordini E fatturato), soglia alta, falso negativo meglio di
 * falso positivo. Timezone Europe/Rome su entrambi i lati dei confronti.
 *
 * In più verifica che il taglio sia EFFETTIVO: i click degli SKU quarantenati
 * devono azzerarsi dopo il refresh TP (4h) — se dopo 2 giorni cliccano ancora
 * >20% del pre-taglio, il feed non è stato recepito.
 */

const { pool } = require('../db/pool');
const { sendTelegram, fmtEur } = require('./telegramNotifier');

async function runCostDietMonitor() {
  const { rows: tenants } = await pool.query(`
    SELECT t.id, t.name,
      MIN(fq.quarantine_start) AS cut_start,
      COUNT(*) AS n_tagli
    FROM feed_quarantine fq
    JOIN tenants t ON t.id = fq.tenant_id
    WHERE fq.reason LIKE 'cost_diet_%' AND fq.reactivated = false
      AND t.status = 'active'
    GROUP BY t.id, t.name`);

  if (tenants.length === 0) {
    console.log('[CostDiet] nessuna dieta attiva, monitor a riposo');
    return;
  }

  const righe = [];
  let allarmi = 0;

  for (const t of tenants) {
    try {
      // Budget TP esaurito: cali di ordini ambigui, non attribuibili al taglio
      const { rows: silenced } = await pool.query(`
        SELECT 1 FROM health_config
        WHERE tenant_id = $1 AND config_key = 'tp_budget_exhausted' AND config_value = '1'`, [t.id]);
      if (silenced.length > 0) {
        righe.push(`⏸ ${t.name}: budget TP esaurito, valutazione sospesa`);
        continue;
      }

      // Ordini/fatturato di IERI (giorno pieno, Europe/Rome) vs baseline:
      // stessi giorni-settimana PRE-taglio (fino a 4 campioni, cercando
      // indietro 8 settimane). Il giorno del taglio è contaminato: si valuta
      // solo da ieri >= giorno dopo il taglio.
      const { rows: [ev] } = await pool.query(`
        WITH ref AS (
          SELECT ((NOW() AT TIME ZONE 'Europe/Rome')::date - 1) AS ieri,
                 ($2::timestamptz AT TIME ZONE 'Europe/Rome')::date AS cut_day
        ),
        base_days AS (
          SELECT d FROM ref, LATERAL (
            SELECT ref.ieri - (7 * k) AS d FROM generate_series(1, 8) k
          ) s
          WHERE s.d < ref.cut_day
          ORDER BY d DESC LIMIT 4
        ),
        ieri AS (
          SELECT COUNT(*) n, COALESCE(SUM(o.subtotal_incl_tax), 0) rev
          FROM orders o, ref
          WHERE o.tenant_id = $1 AND o.order_date::date = ref.ieri
            AND o.order_status NOT IN ('canceled','closed')
        ),
        base AS (
          SELECT COUNT(DISTINCT bd.d) n_giorni,
                 COUNT(o.id)::numeric / NULLIF(COUNT(DISTINCT bd.d), 0) ord_avg,
                 COALESCE(SUM(o.subtotal_incl_tax), 0) / NULLIF(COUNT(DISTINCT bd.d), 0) rev_avg
          FROM base_days bd
          LEFT JOIN orders o ON o.tenant_id = $1 AND o.order_date::date = bd.d
            AND o.order_status NOT IN ('canceled','closed')
        )
        SELECT (SELECT ieri FROM ref) AS giorno_ieri,
               (SELECT cut_day FROM ref) AS cut_day,
               i.n AS ord_ieri, ROUND(i.rev) AS rev_ieri,
               b.n_giorni, ROUND(b.ord_avg, 1) AS ord_base, ROUND(b.rev_avg) AS rev_base
        FROM ieri i, base b`, [t.id, t.cut_start]);

      // Efficacia del taglio: click di ieri sugli SKU quarantenati vs media
      // giornaliera pre-taglio (7g prima del taglio)
      const { rows: [clk] } = await pool.query(`
        WITH ref AS (
          SELECT ((NOW() AT TIME ZONE 'Europe/Rome')::date - 1) AS ieri,
                 ($2::timestamptz AT TIME ZONE 'Europe/Rome')::date AS cut_day
        ),
        cut_skus AS (
          SELECT sku FROM feed_quarantine
          WHERE tenant_id = $1 AND reason LIKE 'cost_diet_%' AND reactivated = false
        )
        SELECT
          COALESCE(SUM(z.clicks) FILTER (WHERE z.fetch_date = (SELECT ieri FROM ref)), 0) AS click_ieri,
          ROUND(COALESCE(SUM(z.clicks) FILTER (
            WHERE z.fetch_date >= (SELECT cut_day FROM ref) - 7
              AND z.fetch_date < (SELECT cut_day FROM ref)), 0) / 7.0, 1) AS click_g_pre
        FROM zombie_clicks z
        WHERE z.tenant_id = $1 AND z.product_code IN (SELECT sku FROM cut_skus)`, [t.id, t.cut_start]);

      const giorniPost = ev && ev.giorno_ieri && ev.cut_day
        ? Math.floor((new Date(ev.giorno_ieri) - new Date(ev.cut_day)) / 86400000) : 0;

      if (!ev || giorniPost < 1) {
        righe.push(`🕐 ${t.name}: taglio di oggi (${t.n_tagli} SKU), prima valutazione domani`);
        continue;
      }
      if (!ev.n_giorni || Number(ev.n_giorni) < 2 || Number(ev.ord_base) < 5) {
        righe.push(`➖ ${t.name}: baseline insufficiente (${ev.n_giorni || 0} campioni, ${ev.ord_base || 0} ord/g), non valutabile`);
        continue;
      }

      const ordPct = Number(ev.ord_ieri) / Number(ev.ord_base) * 100;
      const revPct = Number(ev.rev_ieri) / Number(ev.rev_base) * 100;
      const risparmioG = Math.round((Number(clk.click_g_pre) - Number(clk.click_ieri)) * 0.3294);

      let stato = '🟢';
      // RED: multi-evidenza, soglia alta (ordini <70% E fatturato <75%)
      if (ordPct < 70 && revPct < 75) { stato = '🔴'; allarmi++; }
      else if (ordPct < 85 && revPct < 85) { stato = '🟡'; allarmi++; }

      righe.push(
        `${stato} ${t.name} (g+${giorniPost}, ${t.n_tagli} SKU fermi): ` +
        `ordini ${ev.ord_ieri} vs ${ev.ord_base} base (${Math.round(ordPct)}%), ` +
        `rev ${fmtEur(ev.rev_ieri)} vs ${fmtEur(ev.rev_base)} (${Math.round(revPct)}%), ` +
        `risparmio ~${fmtEur(Math.max(risparmioG, 0))}/g`
      );

      // Taglio non recepito: dopo 2+ giorni gli SKU fermi cliccano ancora
      if (giorniPost >= 2 && Number(clk.click_g_pre) >= 10
          && Number(clk.click_ieri) > Number(clk.click_g_pre) * 0.2) {
        allarmi++;
        righe.push(`⚠️ ${t.name}: taglio NON effettivo — SKU quarantenati cliccano ancora ` +
          `(${clk.click_ieri} ieri vs ${clk.click_g_pre}/g pre-taglio). Verificare pipe feed/FB.`);
      }
    } catch (e) {
      console.error(`[CostDiet] ${t.name} err:`, e.message);
      righe.push(`❓ ${t.name}: errore valutazione (${e.message.slice(0, 60)})`);
    }
  }

  const maxCutAgeDays = 3;
  const { rows: [fresh] } = await pool.query(`
    SELECT COUNT(*) n FROM feed_quarantine
    WHERE reason LIKE 'cost_diet_%' AND reactivated = false
      AND quarantine_start >= NOW() - ($1 || ' days')::interval`, [maxCutAgeDays]);

  console.log('[CostDiet]', righe.join(' | '));

  // Telegram: sempre nei primi 3 giorni post-taglio (finestra critica),
  // dopo solo se c'è qualcosa da segnalare (zero rumore)
  if (allarmi > 0 || Number(fresh.n) > 0) {
    const header = allarmi > 0
      ? `🚨 <b>DIETA COSTI — ${allarmi} segnalazioni</b>`
      : `✂️ <b>Dieta costi — report post-taglio</b>`;
    const footer = allarmi > 0
      ? `\n\nRollback tenant: UPDATE feed_quarantine SET reactivated=true WHERE tenant_id='&lt;id&gt;' AND reason LIKE 'cost_diet_%';`
      : '';
    await sendTelegram(`${header}\n\n${righe.join('\n')}${footer}`);
  }
}

let cronStarted = false;

function startCostDietMonitor() {
  if (cronStarted) return;
  cronStarted = true;
  // Ogni giorno alle 08:10 UTC (10:10 Italia, dopo import click e ordini)
  const schedule = () => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(8, 10, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(() => {
      runCostDietMonitor().catch(e => console.error('[CostDiet] err:', e.message));
      schedule();
    }, next - now);
  };
  schedule();
  console.log('[CostDiet] Monitor attivo — ogni giorno 08:10 UTC (10:10 Italia)');
}

module.exports = { runCostDietMonitor, startCostDietMonitor };
