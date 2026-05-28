/**
 * Google Ads — sync campagne, daily performance, product performance.
 *
 * Auth: OAuth2 user-level con refresh_token. Le credenziali sono globali
 * (un'unica OAuth user che ha accesso all'MCC che gestisce gli account
 * farmacia). Il customer_id e' invece per tenant.
 *
 * Config richiesta (tutte criptate):
 *  global_config:
 *    - google_ads_developer_token         (visibile in https://ads.google.com/aw/apicenter)
 *    - google_ads_oauth_client_id         (OAuth2 client creato in Google Cloud Console)
 *    - google_ads_oauth_client_secret
 *    - google_ads_oauth_refresh_token     (ottenuto via scripts/google-ads-oauth.js)
 *    - google_ads_login_customer_id       (MCC id senza trattini, opzionale ma quasi sempre necessario)
 *  tenant_configs:
 *    - google_ads_customer_id             (CID del singolo account farmacia, senza trattini)
 *
 * Fasi sync per tenant:
 *  1. Campaigns anagrafica (campaign + campaign_budget)
 *  2. Campaign daily performance (last 30 days)
 *  3. Product daily performance via shopping_performance_view (last 30 days)
 *
 * Quando il dev token e' ancora "test access", le query su account di
 * produzione ritornano DEVELOPER_TOKEN_NOT_APPROVED — fail gracefully con
 * status='failed' + error_message che riconosciamo nella UI.
 */

const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');
const { getGlobal, getGlobals } = require('./globalConfig');

// ─── CONFIG / DIAGNOSTICA ─────────────────────────────

async function loadGlobalAdsConfig() {
  const keys = [
    'google_ads_developer_token',
    'google_ads_oauth_client_id',
    'google_ads_oauth_client_secret',
    'google_ads_oauth_refresh_token',
    'google_ads_login_customer_id',
  ];
  const vals = await getGlobals(keys);
  return vals;
}

async function loadTenantAdsConfig(tenantId) {
  const { rows } = await pool.query(
    `SELECT config_key, config_value FROM tenant_configs
     WHERE tenant_id=$1 AND config_key IN ('google_ads_customer_id','google_ads_login_customer_id')`,
    [tenantId]
  );
  const out = {};
  for (const r of rows) {
    try { out[r.config_key] = decrypt(r.config_value); }
    catch { out[r.config_key] = r.config_value; }
  }
  return out;
}

async function diagnoseConfig(tenantId) {
  const g = await loadGlobalAdsConfig();
  const tc = await loadTenantAdsConfig(tenantId);

  const missing = [];
  if (!g.google_ads_developer_token) missing.push('global_config.google_ads_developer_token');
  if (!g.google_ads_oauth_client_id) missing.push('global_config.google_ads_oauth_client_id');
  if (!g.google_ads_oauth_client_secret) missing.push('global_config.google_ads_oauth_client_secret');
  if (!g.google_ads_oauth_refresh_token) missing.push('global_config.google_ads_oauth_refresh_token');
  if (!tc.google_ads_customer_id) missing.push('tenant_configs.google_ads_customer_id');

  return {
    ready: missing.length === 0,
    missing,
    customer_id: tc.google_ads_customer_id || null,
    login_customer_id: tc.google_ads_login_customer_id || g.google_ads_login_customer_id || null,
  };
}

// ─── CLIENT ───────────────────────────────────────────

let _api = null; // GoogleAdsApi cached per process (uses dev_token + oauth client)

async function getAdsApi() {
  if (_api) return _api;
  const g = await loadGlobalAdsConfig();
  if (!g.google_ads_developer_token || !g.google_ads_oauth_client_id || !g.google_ads_oauth_client_secret) {
    throw new Error('Google Ads global config incomplete (developer_token / oauth_client_id / oauth_client_secret)');
  }
  const { GoogleAdsApi } = require('google-ads-api');
  _api = new GoogleAdsApi({
    developer_token: g.google_ads_developer_token,
    client_id: g.google_ads_oauth_client_id,
    client_secret: g.google_ads_oauth_client_secret,
  });
  return _api;
}

async function getCustomerClient(tenantId) {
  const api = await getAdsApi();
  const g = await loadGlobalAdsConfig();
  const tc = await loadTenantAdsConfig(tenantId);
  const refreshToken = g.google_ads_oauth_refresh_token;
  const customerId = String(tc.google_ads_customer_id || '').replace(/-/g, '');
  const loginCustomerId = String(tc.google_ads_login_customer_id || g.google_ads_login_customer_id || '').replace(/-/g, '');
  if (!refreshToken || !customerId) {
    throw new Error('Missing refresh_token or customer_id');
  }
  return api.Customer({
    customer_id: customerId,
    refresh_token: refreshToken,
    ...(loginCustomerId ? { login_customer_id: loginCustomerId } : {}),
  });
}

/**
 * Smoke test connessione: prova una query elementare. Restituisce:
 *   { ok: true, customers: [...] }            -> tutto OK
 *   { ok: false, code: 'DEVELOPER_TOKEN_NOT_APPROVED', ... } -> manca Basic access
 *   { ok: false, code: 'UNAUTHENTICATED' / 'PERMISSION_DENIED' / altro }
 */
async function testConnection(tenantId) {
  try {
    const customer = await getCustomerClient(tenantId);
    const rows = await customer.query(`SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer LIMIT 1`);
    return { ok: true, customer: rows[0]?.customer || null };
  } catch (e) {
    const errStr = String(e?.message || e);
    let code = 'UNKNOWN';
    if (errStr.includes('DEVELOPER_TOKEN_NOT_APPROVED')) code = 'DEVELOPER_TOKEN_NOT_APPROVED';
    else if (errStr.includes('CUSTOMER_NOT_ENABLED')) code = 'CUSTOMER_NOT_ENABLED';
    else if (errStr.includes('USER_PERMISSION_DENIED') || errStr.includes('PERMISSION_DENIED')) code = 'PERMISSION_DENIED';
    else if (errStr.includes('UNAUTHENTICATED')) code = 'UNAUTHENTICATED';
    else if (errStr.includes('Missing refresh_token') || errStr.includes('global config incomplete')) code = 'CONFIG_INCOMPLETE';
    return { ok: false, code, message: errStr.slice(0, 500) };
  }
}

// ─── FETCH HELPERS ────────────────────────────────────

function microsToNumber(v) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function fetchCampaigns(customer) {
  const rows = await customer.query(`
    SELECT
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type,
      campaign.advertising_channel_sub_type,
      campaign.status,
      campaign.bidding_strategy_type,
      campaign.maximize_conversion_value.target_roas,
      campaign.target_roas.target_roas,
      campaign.target_cpa.target_cpa_micros,
      campaign_budget.amount_micros,
      campaign.start_date,
      campaign.end_date
    FROM campaign
    WHERE campaign.status != 'REMOVED'
      AND campaign.advertising_channel_type IN ('SHOPPING','PERFORMANCE_MAX','SEARCH')
  `);
  return rows;
}

async function fetchCampaignDaily(customer, days = 30) {
  return customer.query(`
    SELECT
      campaign.id, segments.date,
      metrics.impressions, metrics.clicks, metrics.cost_micros,
      metrics.conversions, metrics.conversions_value,
      metrics.view_through_conversions,
      metrics.search_impression_share,
      metrics.search_top_impression_share,
      metrics.search_budget_lost_impression_share,
      metrics.search_rank_lost_impression_share
    FROM campaign
    WHERE segments.date DURING LAST_${days}_DAYS
      AND campaign.status != 'REMOVED'
  `);
}

async function fetchProductDaily(customer, days = 30) {
  return customer.query(`
    SELECT
      segments.product_item_id,
      campaign.id, segments.date,
      metrics.impressions, metrics.clicks, metrics.cost_micros,
      metrics.conversions, metrics.conversions_value
    FROM shopping_performance_view
    WHERE segments.date DURING LAST_${days}_DAYS
  `);
}

// ─── UPSERTS ──────────────────────────────────────────

async function upsertCampaigns(tenantId, customerId, rows) {
  if (!rows.length) return 0;
  let n = 0;
  for (const r of rows) {
    const c = r.campaign || {};
    const b = r.campaign_budget || {};
    await pool.query(`
      INSERT INTO google_ads_campaigns
        (tenant_id, customer_id, campaign_id, name, campaign_type, channel_subtype,
         status, bidding_strategy, target_roas, target_cpa_micros, budget_micros,
         start_date, end_date, raw_data, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
      ON CONFLICT (tenant_id, customer_id, campaign_id)
      DO UPDATE SET name=EXCLUDED.name, campaign_type=EXCLUDED.campaign_type,
        channel_subtype=EXCLUDED.channel_subtype, status=EXCLUDED.status,
        bidding_strategy=EXCLUDED.bidding_strategy, target_roas=EXCLUDED.target_roas,
        target_cpa_micros=EXCLUDED.target_cpa_micros, budget_micros=EXCLUDED.budget_micros,
        start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date,
        raw_data=EXCLUDED.raw_data, updated_at=NOW()
    `, [
      tenantId, customerId, String(c.id),
      c.name || '',
      c.advertising_channel_type || '',
      c.advertising_channel_sub_type || '',
      c.status || '',
      c.bidding_strategy_type || '',
      c.target_roas?.target_roas ?? c.maximize_conversion_value?.target_roas ?? null,
      c.target_cpa?.target_cpa_micros ?? null,
      b.amount_micros ?? null,
      c.start_date || null,
      c.end_date || null,
      JSON.stringify(r),
    ]);
    n++;
  }
  return n;
}

async function upsertCampaignDaily(tenantId, customerId, rows) {
  let n = 0;
  for (const r of rows) {
    const c = r.campaign || {};
    const s = r.segments || {};
    const m = r.metrics || {};
    if (!c.id || !s.date) continue;
    await pool.query(`
      INSERT INTO google_ads_campaign_daily
        (tenant_id, customer_id, campaign_id, report_date,
         impressions, clicks, cost_micros, conversions, conversion_value, view_through_conv,
         search_impression_share, search_top_impression_share,
         search_budget_lost_is, search_rank_lost_is)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (tenant_id, customer_id, campaign_id, report_date)
      DO UPDATE SET impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks,
        cost_micros=EXCLUDED.cost_micros, conversions=EXCLUDED.conversions,
        conversion_value=EXCLUDED.conversion_value, view_through_conv=EXCLUDED.view_through_conv,
        search_impression_share=EXCLUDED.search_impression_share,
        search_top_impression_share=EXCLUDED.search_top_impression_share,
        search_budget_lost_is=EXCLUDED.search_budget_lost_is,
        search_rank_lost_is=EXCLUDED.search_rank_lost_is
    `, [
      tenantId, customerId, String(c.id), s.date,
      Number(m.impressions || 0), Number(m.clicks || 0), microsToNumber(m.cost_micros),
      Number(m.conversions || 0), Number(m.conversions_value || 0),
      Number(m.view_through_conversions || 0),
      m.search_impression_share ?? null,
      m.search_top_impression_share ?? null,
      m.search_budget_lost_impression_share ?? null,
      m.search_rank_lost_impression_share ?? null,
    ]);
    n++;
  }
  return n;
}

async function upsertProductDaily(tenantId, customerId, rows) {
  let n = 0;
  for (const r of rows) {
    const s = r.segments || {};
    const c = r.campaign || {};
    const m = r.metrics || {};
    if (!s.product_item_id || !c.id || !s.date) continue;
    await pool.query(`
      INSERT INTO google_ads_product_daily
        (tenant_id, customer_id, campaign_id, offer_id, report_date,
         impressions, clicks, cost_micros, conversions, conversion_value)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (tenant_id, customer_id, campaign_id, offer_id, report_date)
      DO UPDATE SET impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks,
        cost_micros=EXCLUDED.cost_micros, conversions=EXCLUDED.conversions,
        conversion_value=EXCLUDED.conversion_value
    `, [
      tenantId, customerId, String(c.id), String(s.product_item_id), s.date,
      Number(m.impressions || 0), Number(m.clicks || 0), microsToNumber(m.cost_micros),
      Number(m.conversions || 0), Number(m.conversions_value || 0),
    ]);
    n++;
  }
  return n;
}

// ─── SYNC ENTRYPOINT ──────────────────────────────────

async function syncTenant(tenantId, { days = 30 } = {}) {
  const diag = await diagnoseConfig(tenantId);
  const { rows: [run] } = await pool.query(
    `INSERT INTO google_ads_runs (tenant_id, run_type, status, started_at)
     VALUES ($1, 'full', 'running', NOW()) RETURNING id`,
    [tenantId]
  );

  if (!diag.ready) {
    await pool.query(
      `UPDATE google_ads_runs SET status='skipped_no_token', completed_at=NOW(),
       error_message=$2 WHERE id=$1`,
      [run.id, `Config mancante: ${diag.missing.join(', ')}`]
    );
    return { skipped: true, missing: diag.missing };
  }

  try {
    const customer = await getCustomerClient(tenantId);
    const customerIdStr = diag.customer_id.replace(/-/g, '');

    const camps = await fetchCampaigns(customer);
    const nCamp = await upsertCampaigns(tenantId, customerIdStr, camps);

    const dailyRows = await fetchCampaignDaily(customer, days);
    const nDaily = await upsertCampaignDaily(tenantId, customerIdStr, dailyRows);

    let nProd = 0;
    try {
      const prodRows = await fetchProductDaily(customer, days);
      nProd = await upsertProductDaily(tenantId, customerIdStr, prodRows);
    } catch (e) {
      // shopping_performance_view fallisce per account senza campagne Shopping. Non blocca.
      console.warn(`[GoogleAds] product perf skipped for tenant ${tenantId}: ${e.message?.slice(0, 200)}`);
    }

    await pool.query(
      `UPDATE google_ads_runs SET status='completed', completed_at=NOW(),
       campaigns_count=$2, campaign_days=$3, product_rows=$4 WHERE id=$1`,
      [run.id, nCamp, nDaily, nProd]
    );
    return { ok: true, campaigns: nCamp, campaign_days: nDaily, product_rows: nProd };
  } catch (e) {
    const errStr = String(e?.message || e).slice(0, 800);
    await pool.query(
      `UPDATE google_ads_runs SET status='failed', completed_at=NOW(),
       error_message=$2 WHERE id=$1`,
      [run.id, errStr]
    );
    return { error: errStr };
  }
}

async function syncAllOperational(opts) {
  const { rows: tenants } = await pool.query(`
    SELECT t.id, t.name FROM tenants t
    JOIN tenant_configs tc ON tc.tenant_id=t.id
    WHERE tc.config_key='xhumanpro_magento_mode' AND tc.config_value='operational'
    ORDER BY t.name
  `);
  const results = [];
  for (const t of tenants) {
    try {
      const r = await syncTenant(t.id, opts);
      results.push({ tenant: t.name, ...r });
    } catch (e) {
      results.push({ tenant: t.name, error: e.message });
    }
  }
  return results;
}

module.exports = {
  diagnoseConfig,
  testConnection,
  syncTenant,
  syncAllOperational,
};
