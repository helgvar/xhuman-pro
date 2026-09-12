const { pool } = require('../db/pool');
const { importProducts } = require('./farmaboosterProducts');
const { isJobRunning } = require('./requestQueue');
const { withTenantLock, farmaboosterQueue } = require('./apiQueue');
const { sendTelegram } = require('./telegramNotifier');

const SYNC_INTERVAL_MS = 60 * 60 * 1000;      // 1 hour (era 6h; prezzi e stock_source cambiano intra-giorno,
                                              // cfr. feedback_pricing_freshness_critical)
const STAGGER_DELAY_MS = 60 * 1000;           // 60s delay between tenants (protegge FB server)

// Ordine capo 10/09: "ad ogni loop di dati i pc vengono ricontrollati in base al
// costo attuale e ricalcolati o cancellati". Il costo d'acquisto e' una serie
// temporale: appena il sync porta a casa i costi nuovi, ogni price cut vivo del
// tenant viene ripesato sul costo di RIACQUISTO di adesso e, se ha sfondato il
// floor di fascia, ricalcolato giu' / rialzato fino al minimo consentito (solo
// se e' il costo ad averlo affondato, ordine capo 10/09) / cancellato.
// Il guardiano gira DENTRO il lock del tenant, subito dopo l'import: nessun
// altro motore sta scrivendo su quel tenant in quel momento.
// Legge capo 10/09: "tutti i pc vanno rivalutati ad ogni aggiornamento per
// valutare se il costo di riferimento e' cambiato". Nessun tetto: se un taglio
// e' sotto il minimo non puo' aspettare il giro dopo.
const PC_GUARD_CAP = null;

/**
 * Ricontrolla i price cut del tenant sul costo appena importato.
 * Non deve MAI far fallire il sync: ogni errore e' loggato e ingoiato.
 */
async function reconfirmPriceCuts(tenant) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT esito, tenant, n FROM reconfirm_price_cuts_v2(false, $1::uuid, $2::int)',
      [tenant.id, PC_GUARD_CAP]
    );
    await client.query('COMMIT');

    const n = (e) => rows.filter(r => r.esito === e).reduce((s, r) => s + parseInt(r.n, 10), 0);
    const giu = n('ricalcolato_giu');
    const rialzo = n('rialzo_riparazione');
    const cancellati = n('cancellato') + n('cancellato_veto')
                     + n('cancellato_dato_assente') + n('cancellato_costo_vecchio')
                     + n('cancellato_regola_fb');
    const costoVecchio = n('fermo_costo_vecchio') + n('cancellato_costo_vecchio');
    // Ordine capo 10/09: su muro e sconto non si emettono price cut, e un PC che
    // entra in regola muro viene annullato. Una ADD non si cancella mai (uscirebbe
    // dal feed): le si toglie solo il prezzo. Mig 113/114.
    const regolaFb = n('cancellato_regola_fb');
    const addSenzaPrezzo = n('prezzo_add_annullato');
    const coda = n('in_coda');
    const toccati = giu + rialzo + cancellati + addSenzaPrezzo;

    if (toccati > 0) {
      console.log(`[ProductSync/PcGuardian] "${tenant.name}": costo nuovo -> giu=${giu}, rialzo_riparazione=${rialzo}, cancellati=${cancellati} (di cui regola_fb=${regolaFb}), add_senza_prezzo=${addSenzaPrezzo}, costo_vecchio=${costoVecchio}, in_coda=${coda}`);
      if (toccati >= 50) {
        try {
          await sendTelegram(`🛡️ <b>Guardiano PC</b> — ${tenant.name}\nCosto d'acquisto cambiato: ricalcolati giù ${giu}, rialzati al minimo consentito ${rialzo}, cancellati ${cancellati}${regolaFb > 0 ? ` (${regolaFb} entrati in muro/sconto)` : ''}${addSenzaPrezzo > 0 ? `, ADD lasciate senza prezzo ${addSenzaPrezzo}` : ''}.${coda > 0 ? `\nIn coda al prossimo giro: ${coda}.` : ''}`);
        } catch (_) {}
      }
    } else {
      console.log(`[ProductSync/PcGuardian] "${tenant.name}": nessun PC fuori floor sul costo di adesso`);
    }
    return { giu, rialzo, cancellati, regolaFb, addSenzaPrezzo, costoVecchio, coda };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[ProductSync/PcGuardian] "${tenant.name}" ERRORE:`, e.message);
    return null;
  } finally {
    client.release();
  }
}

let syncRunning = false;
let syncRunningSince = null;
const LOCK_MAX_AGE_MS = 90 * 60 * 1000; // 90min: oltre questo, il lock e' considerato zombie

/**
 * Sync products for all active tenants with Farmabooster configured.
 * Staggered to avoid overlapping API calls.
 */
async function syncAllProducts() {
  if (syncRunning) {
    const ageMs = syncRunningSince ? Date.now() - syncRunningSince : 0;
    if (ageMs < LOCK_MAX_AGE_MS) {
      console.log(`[ProductSync] Previous sync still running (${Math.round(ageMs / 60000)}min), skipping`);
      return;
    }
    console.warn(`[ProductSync] Lock zombie da ${Math.round(ageMs / 60000)}min, forzato reset (anti-stuck)`);
  }

  syncRunning = true;
  syncRunningSince = Date.now();

  try {
    const { rows: tenants } = await pool.query(
      `SELECT DISTINCT t.id, t.name FROM tenants t
       JOIN tenant_configs tc ON tc.tenant_id = t.id
       WHERE t.status = 'active'
         AND tc.config_key = 'farmabooster_api_url'
         AND tc.config_value IS NOT NULL
         AND tc.config_value != ''`
    );

    console.log(`[ProductSync] Starting sync for ${tenants.length} tenant(s)`);

    for (let i = 0; i < tenants.length; i++) {
      const tenant = tenants[i];

      // Skip if circuit breaker is open
      if (farmaboosterQueue.isOpen()) {
        console.log(`[ProductSync] Circuit breaker OPEN, skipping remaining tenants`);
        break;
      }

      if (isJobRunning(tenant.id, 'products_import')) {
        console.log(`[ProductSync] Tenant "${tenant.name}" has import running, skipping`);
        continue;
      }

      try {
        // Tenant serialization: one at a time via global lock
        await withTenantLock(tenant.id, async () => {
          const { rows } = await pool.query(
            `INSERT INTO import_jobs (tenant_id, job_type, status, metadata)
             VALUES ($1, 'products_sync', 'pending', $2) RETURNING id`,
            [tenant.id, JSON.stringify({ trigger: 'cron' })]
          );

          await importProducts(tenant.id, rows[0].id);
          console.log(`[ProductSync] Tenant "${tenant.name}" sync complete`);

          // Costi appena aggiornati -> riconferma immediata di tutti i price cut vivi
          await reconfirmPriceCuts(tenant);
        });
      } catch (err) {
        console.error(`[ProductSync] Tenant "${tenant.name}" sync failed:`, err.message);
      }
    }

    console.log('[ProductSync] All tenants synced');
  } catch (err) {
    console.error('[ProductSync] Global sync error:', err.message);
  } finally {
    syncRunning = false;
    syncRunningSince = null;
  }
}

function startProductSync() {
  // First run in 5 min (offset da OrderSync che parte a 30s), poi ogni SYNC_INTERVAL_MS
  const INITIAL_DELAY_MS = 5 * 60 * 1000;
  console.log(`[ProductSync] Cron started - every ${SYNC_INTERVAL_MS / 60000}min (first run in ${INITIAL_DELAY_MS / 60000}min), ${STAGGER_DELAY_MS / 1000}s stagger`);
  setTimeout(() => {
    syncAllProducts().catch(e => console.error('[ProductSync] First-run error:', e.message));
    setInterval(syncAllProducts, SYNC_INTERVAL_MS);
  }, INITIAL_DELAY_MS);
}

module.exports = { startProductSync, syncAllProducts, reconfirmPriceCuts };
