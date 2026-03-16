/**
 * Google API Service - GA4 client management per tenant
 * Handles service account auth, client caching, connection testing
 */

const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');

class GoogleApiService {
  constructor() {
    this.ga4Clients = new Map();
    this.configCache = new Map();
    this.MAX_CLIENTS = 10;
    this.CONFIG_TTL = 10 * 60 * 1000; // 10 min
  }

  async getConfig(tenantId) {
    const cached = this.configCache.get(tenantId);
    if (cached && cached.expires > Date.now()) return cached.config;

    const { rows } = await pool.query(
      `SELECT config_key, config_value FROM tenant_configs
       WHERE tenant_id = $1
       AND config_key IN ('ga4_property_id', 'merchant_center_id', 'google_service_account_json')`,
      [tenantId]
    );

    const config = {};
    for (const row of rows) {
      try {
        config[row.config_key] = decrypt(row.config_value);
      } catch {
        config[row.config_key] = row.config_value;
      }
    }

    const result = {
      ga4PropertyId: config.ga4_property_id || null,
      merchantCenterId: config.merchant_center_id || null,
      serviceAccountJson: config.google_service_account_json || null,
    };

    this.configCache.set(tenantId, { config: result, expires: Date.now() + this.CONFIG_TTL });
    return result;
  }

  async hasGA4Credentials(tenantId) {
    const config = await this.getConfig(tenantId);
    return !!(config.serviceAccountJson && config.ga4PropertyId);
  }

  _parseServiceAccountJson(jsonStr) {
    const parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('Missing client_email or private_key in service account JSON');
    }
    return parsed;
  }

  async getGA4Client(tenantId) {
    if (this.ga4Clients.has(tenantId)) return this.ga4Clients.get(tenantId);

    const config = await this.getConfig(tenantId);
    if (!config.serviceAccountJson) {
      throw new Error(`Tenant ${tenantId}: No Google service account configured`);
    }
    if (!config.ga4PropertyId) {
      throw new Error(`Tenant ${tenantId}: No GA4 property ID configured`);
    }

    const credentials = this._parseServiceAccountJson(config.serviceAccountJson);
    const client = new BetaAnalyticsDataClient({ credentials });

    // LRU eviction
    if (this.ga4Clients.size >= this.MAX_CLIENTS) {
      const firstKey = this.ga4Clients.keys().next().value;
      this.ga4Clients.delete(firstKey);
    }
    this.ga4Clients.set(tenantId, client);
    return client;
  }

  async getGA4PropertyId(tenantId) {
    const config = await this.getConfig(tenantId);
    return config.ga4PropertyId;
  }

  /**
   * Test GA4 connection and check data availability
   */
  async testGA4Connection(tenantId) {
    const config = await this.getConfig(tenantId);
    const result = {
      hasCredentials: !!config.serviceAccountJson,
      hasPropertyId: !!config.ga4PropertyId,
      ga4PropertyId: config.ga4PropertyId,
      canConnect: false,
      hasTrovaprezziTraffic: false,
      hasEcommerce: false,
      sources: [],
      error: null,
    };

    if (!result.hasCredentials || !result.hasPropertyId) {
      result.error = 'Credenziali o Property ID mancanti';
      return result;
    }

    try {
      const client = await this.getGA4Client(tenantId);
      const propertyId = config.ga4PropertyId;

      // Check traffic sources (last 7 days)
      const [sourcesResponse] = await client.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'sessionSource' }],
        metrics: [{ name: 'sessions' }],
        limit: 50,
      });

      result.canConnect = true;
      result.sources = (sourcesResponse.rows || []).map(r => ({
        source: r.dimensionValues[0].value,
        sessions: parseInt(r.metricValues[0].value),
      })).sort((a, b) => b.sessions - a.sessions);

      result.hasTrovaprezziTraffic = result.sources.some(
        s => s.source.toLowerCase().includes('trovaprezzi')
      );

      // Check e-commerce events (last 30 days)
      const [ecomResponse] = await client.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: {
          orGroup: {
            expressions: [
              { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'purchase' } } },
              { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'add_to_cart' } } },
              { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'view_item' } } },
            ],
          },
        },
      });

      const ecomEvents = {};
      for (const row of (ecomResponse.rows || [])) {
        ecomEvents[row.dimensionValues[0].value] = parseInt(row.metricValues[0].value);
      }
      result.ecommerceEvents = ecomEvents;
      result.hasEcommerce = (ecomEvents.purchase || 0) > 0;

      // Check if purchase events have itemId
      if (result.hasEcommerce) {
        const [itemsResponse] = await client.runReport({
          property: `properties/${propertyId}`,
          dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
          dimensions: [{ name: 'itemId' }],
          metrics: [{ name: 'itemsPurchased' }],
          limit: 5,
        });
        const sampleItems = (itemsResponse.rows || []).map(r => ({
          itemId: r.dimensionValues[0].value,
          purchased: parseInt(r.metricValues[0].value),
        }));
        result.samplePurchasedItems = sampleItems;
        result.hasItemIds = sampleItems.length > 0 && sampleItems[0].itemId !== '(not set)';
      }
    } catch (err) {
      result.error = err.message;
    }

    return result;
  }

  clearTenant(tenantId) {
    this.ga4Clients.delete(tenantId);
    this.configCache.delete(tenantId);
  }
}

const googleApiService = new GoogleApiService();

module.exports = { googleApiService };
