const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length) process.env[key.trim()] = val.join('=').trim();
  });
}

const { Pool } = require('pg');
const { encrypt } = require('./services/crypto');

/**
 * Seed script for Farmacri tenant.
 * All secrets should be loaded from environment variables or .env file.
 *
 * Required env vars:
 *   FB_API_URL, FB_API_EMAIL, FB_API_PASSWORD
 *   MAGENTO_BASE_URL, MAGENTO_API_TOKEN
 *   GA4_PROPERTY_ID, GA4_CREDENTIALS_JSON (path to file or inline JSON)
 *   GOOGLE_MERCHANT_ID
 *   TP_FEED_URL, TP_USERNAME, TP_PASSWORD, TP_SELLER_NAME
 *   CLAUDE_API_KEY
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */
async function seedFarmacri() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // 1. Create tenant Farmacri
    const existing = await pool.query("SELECT id FROM tenants WHERE slug = 'farmacri'");
    let tenantId;
    if (existing.rows.length > 0) {
      tenantId = existing.rows[0].id;
      console.log(`Tenant "Farmacri" already exists (id: ${tenantId})`);
    } else {
      const result = await pool.query(
        `INSERT INTO tenants (name, slug, status) VALUES ($1, $2, 'active') RETURNING id, name, slug`,
        ['Farmacri', 'farmacri']
      );
      tenantId = result.rows[0].id;
      console.log('Tenant created:', result.rows[0]);
    }

    // 2. Load GA4 credentials from file if path provided
    let ga4Json = process.env.GA4_CREDENTIALS_JSON || '';
    if (ga4Json && fs.existsSync(ga4Json)) {
      ga4Json = fs.readFileSync(ga4Json, 'utf8');
    }

    // 3. Configurations (all from env)
    const configs = {
      farmabooster_api_url: process.env.FB_API_URL || '',
      farmabooster_api_email: process.env.FB_API_EMAIL || '',
      farmabooster_api_password: process.env.FB_API_PASSWORD || '',
      magento_base_url: process.env.MAGENTO_BASE_URL || '',
      magento_api_token: process.env.MAGENTO_API_TOKEN || '',
      magento_store_code: 'default',
      ga4_property_id: process.env.GA4_PROPERTY_ID || '',
      google_service_account_json: ga4Json,
      google_merchant_id: process.env.GOOGLE_MERCHANT_ID || '',
      trovaprezzi_feed_url: process.env.TP_FEED_URL || '',
      trovaprezzi_feed_separator: '$',
      trovaprezzi_shipping_cost: '5,00',
      trovaprezzi_output_format: 'trovaprezzi_csv',
      trovaprezzi_username: process.env.TP_USERNAME || '',
      trovaprezzi_password: process.env.TP_PASSWORD || '',
      trovaprezzi_seller_name: process.env.TP_SELLER_NAME || '',
      claude_api_key: process.env.CLAUDE_API_KEY || '',
      claude_model: 'claude-sonnet-4-5-20250929',
      telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN || '',
      telegram_chat_id: process.env.TELEGRAM_CHAT_ID || '',
    };

    let count = 0;
    for (const [key, value] of Object.entries(configs)) {
      if (!value) continue;
      const encrypted = encrypt(String(value));
      await pool.query(
        `INSERT INTO tenant_configs (tenant_id, config_key, config_value)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = $3`,
        [tenantId, key, encrypted]
      );
      count++;
    }

    console.log(`\n${count} configurazioni caricate per tenant Farmacri`);
    console.log('\nTenant Farmacri pronto!');

  } catch (err) {
    console.error('Seed Farmacri failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seedFarmacri();
