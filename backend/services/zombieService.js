/**
 * ZombieService — Downloads click statistics CSV from Trovaprezzi analytics portal.
 *
 * Uses Puppeteer headless to:
 * 1. Login to services.7pixel.it
 * 2. Navigate to StatsOnProducts analytics page
 * 3. Trigger CSV download
 * 4. Parse CSV and return structured data
 *
 * FTP credentials are shared across all tenants.
 * Each tenant's file is named: {seller_name}_trovaprezzi_{YYYYMMDD}.csv
 * FTP upload runs daily at 00:05 for the previous day's data.
 */

const puppeteer = require('puppeteer-core');
const { parse } = require('csv-parse/sync');
const { decrypt } = require('./crypto');
const { pool } = require('../db/pool');

const LOGIN_URL = 'https://services.7pixel.it/Home/Login';
const ANALYTICS_BASE = 'https://services.7pixel.it/Analytics/StatsOnProducts';

class ZombieService {
  constructor() {
    this.browser = null;
    this.configCache = new Map();
    this.CONFIG_TTL = 10 * 60 * 1000; // 10 min
  }

  // ─── Config ──────────────────────────────────────────────

  async getConfig(tenantId) {
    const cached = this.configCache.get(tenantId);
    if (cached && cached.expires > Date.now()) return cached.config;

    const keys = ['trovaprezzi_username', 'trovaprezzi_password', 'trovaprezzi_seller_name'];
    const { rows } = await pool.query(
      `SELECT config_key, config_value FROM tenant_configs
       WHERE tenant_id = $1 AND config_key = ANY($2)`,
      [tenantId, keys]
    );

    const config = {};
    for (const row of rows) {
      try { config[row.config_key] = decrypt(row.config_value); }
      catch { config[row.config_key] = row.config_value; }
    }

    this.configCache.set(tenantId, { config, expires: Date.now() + this.CONFIG_TTL });
    return config;
  }

  async isConfigured(tenantId) {
    const config = await this.getConfig(tenantId);
    return !!(config.trovaprezzi_username && config.trovaprezzi_password);
  }

  hasFtpConfig() {
    return !!(process.env.ZOMBIE_FTP_HOST && process.env.ZOMBIE_FTP_USER && process.env.ZOMBIE_FTP_PASSWORD);
  }

  // ─── Browser management ──────────────────────────────────

  async ensureBrowser() {
    if (this.browser && this.browser.connected) return this.browser;

    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
    this.browser = await puppeteer.launch({
      headless: true,
      executablePath: execPath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-networking',
        '--no-first-run',
      ],
    });
    console.log('[Zombie] Browser launched');
    return this.browser;
  }

  async closeBrowser() {
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
      console.log('[Zombie] Browser closed');
    }
  }

  // ─── CSV Download via Puppeteer ──────────────────────────

  async downloadClicksCsv(tenantId, dateFrom, dateTo) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const config = await this.getConfig(tenantId);
    if (!config.trovaprezzi_username || !config.trovaprezzi_password) {
      throw new Error('Trovaprezzi credentials not configured');
    }

    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zombie-'));

    try {
      const cdp = await page.createCDPSession();
      await cdp.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
      });

      // 1. Login
      console.log(`[Zombie][T:${tenantId.slice(0, 8)}] Logging into Trovaprezzi...`);
      await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });

      await page.waitForSelector('input[type="text"], input[type="email"], input[name="Username"], input[name="Email"]', { timeout: 10000 });

      // Type username
      const usernameSelectors = ['input[name="Username"]', 'input[name="Email"]', 'input[type="email"]', 'input[type="text"]'];
      let typed = false;
      for (const sel of usernameSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.click({ clickCount: 3 });
            await el.type(config.trovaprezzi_username, { delay: 30 });
            typed = true;
            break;
          }
        } catch {}
      }
      if (!typed) throw new Error('Could not find username input field');

      // Type password
      const passwordSelectors = ['input[name="Password"]', 'input[type="password"]'];
      typed = false;
      for (const sel of passwordSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.click({ clickCount: 3 });
            await el.type(config.trovaprezzi_password, { delay: 50 });
            typed = true;
            break;
          }
        } catch {}
      }
      if (!typed) throw new Error('Could not find password input field');

      // Submit login
      const submitSelectors = ['button[type="submit"]', 'input[type="submit"]', 'button.login-btn', '#loginButton'];
      let submitted = false;
      for (const sel of submitSelectors) {
        try {
          const el = await page.$(sel);
          if (el) { await el.click(); submitted = true; break; }
        } catch {}
      }
      if (!submitted) await page.keyboard.press('Enter');

      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));

      const currentUrl = page.url();
      if (currentUrl.includes('/Login') || currentUrl.includes('/login')) {
        throw new Error('Login failed — still on login page. Check credentials.');
      }

      console.log(`[Zombie][T:${tenantId.slice(0, 8)}] Login OK. Navigating to analytics...`);

      // 2. Navigate to analytics page
      const analyticsUrl = `${ANALYTICS_BASE}/${dateFrom}/${dateTo}/-1/1/all/-1/`;
      await page.goto(analyticsUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(r => setTimeout(r, 3000));

      // 3. Check for data
      const pageContent = await page.content();
      const noDataIndicators = [
        'nessun dato', 'nessun risultato', 'no data', 'no results',
        'non ci sono dati', 'nessun prodotto', 'campagna sospesa',
        'campagna non attiva', 'budget esaurito',
      ];
      const pageLower = pageContent.toLowerCase();
      const noDataFound = noDataIndicators.some(ind => pageLower.includes(ind));

      const downloadSelectors = [
        '#exportCsv', '#downloadCsv',
        'a[href*="csv"]', 'a[href*="CSV"]', 'a[href*="download"]', 'a[href*="Export"]',
        'button[title*="CSV"]', 'button[title*="Download"]', 'button[title*="Esporta"]',
        '.download-csv', '.export-csv',
        'a.btn[href*="Export"]', 'a.btn[href*="Csv"]',
      ];

      let downloadEl = null;
      for (const sel of downloadSelectors) {
        try {
          const el = await page.$(sel);
          if (el) { downloadEl = el; break; }
        } catch {}
      }

      if (noDataFound && !downloadEl) {
        console.log(`[Zombie][T:${tenantId.slice(0, 8)}] No data on page (seller may be suspended/budget exhausted)`);
        return null;
      }

      // 4. Click download
      if (downloadEl) {
        await downloadEl.click();
      } else {
        // Tab fallback
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press('Tab');
          await new Promise(r => setTimeout(r, 100));
        }
        await page.keyboard.press('Enter');
      }

      // 5. Wait for file
      let csvFile = null;
      const maxWait = 30000;
      let waited = 0;
      while (waited < maxWait) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
        const files = fs.readdirSync(downloadDir);
        const ready = files.filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp') && !f.endsWith('.part'));
        if (ready.length > 0) {
          csvFile = path.join(downloadDir, ready[0]);
          break;
        }
      }

      if (!csvFile) {
        console.log(`[Zombie][T:${tenantId.slice(0, 8)}] No file downloaded after ${maxWait / 1000}s`);
        return null;
      }

      const csv = fs.readFileSync(csvFile, 'utf8');
      if (!csv || csv.trim().length === 0) return null;

      console.log(`[Zombie][T:${tenantId.slice(0, 8)}] CSV downloaded: ${csv.length} bytes`);
      return csv;

    } finally {
      await page.close().catch(() => {});
      try { require('fs').rmSync(downloadDir, { recursive: true, force: true }); } catch {}
    }
  }

  // ─── CSV Parsing ─────────────────────────────────────────

  parseClicksCsv(csvContent) {
    const records = parse(csvContent, {
      columns: true,
      delimiter: ',',
      quote: '"',
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });

    if (records.length === 0) return [];

    const firstRecord = records[0];
    const headers = Object.keys(firstRecord);
    const colMap = {};

    for (const header of headers) {
      const normalized = header.trim().toLowerCase();
      if (normalized === 'sku' || normalized === 'codice') colMap[header] = 'product_code';
      else if (normalized === 'prodotto' || normalized === 'nome prodotto') colMap[header] = 'product_name';
      else if (normalized === 'categoria') colMap[header] = 'trovaprezzi_category';
      else if (normalized === 'numero di click' || normalized === 'click' || normalized === 'clicks') colMap[header] = 'clicks';
    }

    // Fallback positional
    if (!Object.values(colMap).includes('product_code') && headers.length >= 4) {
      colMap[headers[0]] = 'product_code';
      colMap[headers[1]] = 'product_name';
      colMap[headers[2]] = 'trovaprezzi_category';
      colMap[headers[3]] = 'clicks';
    }

    const result = [];
    for (const record of records) {
      const mapped = { product_code: '', product_name: '', trovaprezzi_category: '', clicks: 0 };
      for (const [csvCol, dbCol] of Object.entries(colMap)) {
        if (record[csvCol] !== undefined) {
          mapped[dbCol] = dbCol === 'clicks' ? (parseInt(record[csvCol], 10) || 0) : String(record[csvCol]).trim();
        }
      }
      if (mapped.product_code) result.push(mapped);
    }
    return result;
  }

  // ─── DB Persistence ──────────────────────────────────────

  async persistToDb(tenantId, rows, fetchDate) {
    if (!rows || rows.length === 0) return;

    await pool.query('DELETE FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date = $2', [tenantId, fetchDate]);

    const BATCH = 200;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const values = [];
      const params = [];
      let idx = 1;

      for (const row of batch) {
        values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5})`);
        params.push(tenantId, fetchDate, row.product_code, row.product_name, row.trovaprezzi_category, row.clicks);
        idx += 6;
      }

      await pool.query(
        `INSERT INTO zombie_clicks (tenant_id, fetch_date, product_code, product_name, trovaprezzi_category, clicks)
         VALUES ${values.join(', ')}
         ON CONFLICT (tenant_id, fetch_date, product_code) DO UPDATE SET
           product_name = EXCLUDED.product_name,
           trovaprezzi_category = EXCLUDED.trovaprezzi_category,
           clicks = EXCLUDED.clicks`,
        params
      );
    }

    console.log(`[ZombieDB][T:${tenantId.slice(0, 8)}] Persisted ${rows.length} products for ${fetchDate}`);
  }

  // ─── FTP Upload ──────────────────────────────────────────

  async uploadToFtp(tenantId, csvContent, dateStr) {
    if (!this.hasFtpConfig()) return false;

    const config = await this.getConfig(tenantId);
    const sellerName = config.trovaprezzi_seller_name;
    if (!sellerName) {
      console.warn(`[ZombieFTP][T:${tenantId.slice(0, 8)}] Seller name not configured, skipping FTP`);
      return false;
    }

    const ftp = require('basic-ftp');
    const { Readable } = require('stream');
    const client = new ftp.Client();

    try {
      await client.access({
        host: process.env.ZOMBIE_FTP_HOST,
        user: process.env.ZOMBIE_FTP_USER,
        password: process.env.ZOMBIE_FTP_PASSWORD,
        secure: false,
      });

      const remotePath = `${sellerName}_trovaprezzi_${dateStr}.csv`;
      const stream = Readable.from([csvContent]);
      await client.uploadFrom(stream, remotePath);

      console.log(`[ZombieFTP][T:${tenantId.slice(0, 8)}] Uploaded to ${process.env.ZOMBIE_FTP_HOST}:${remotePath}`);
      return true;
    } catch (err) {
      console.warn(`[ZombieFTP][T:${tenantId.slice(0, 8)}] FTP failed:`, err.message);
      return false;
    } finally {
      client.close();
    }
  }

  // ─── Main run for a tenant ───────────────────────────────

  async runForTenant(tenantId) {
    const config = await this.getConfig(tenantId);
    if (!config.trovaprezzi_username || !config.trovaprezzi_password) {
      throw new Error('Trovaprezzi credentials not configured');
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().slice(0, 10).replace(/-/g, '');
    const fetchDate = yesterday.toISOString().slice(0, 10);

    const { rows: [run] } = await pool.query(
      `INSERT INTO zombie_runs (tenant_id, run_date, status, started_at)
       VALUES ($1, $2, 'running', NOW()) RETURNING id`,
      [tenantId, fetchDate]
    );

    try {
      const csvContent = await this.downloadClicksCsv(tenantId, dateStr, dateStr);

      if (!csvContent) {
        await pool.query(
          `UPDATE zombie_runs SET status = 'no_data', products_count = 0, total_clicks = 0,
           error_message = 'Nessun dato disponibile (seller sospeso o budget esaurito)',
           completed_at = NOW() WHERE id = $1`,
          [run.id]
        );
        return { products: 0, totalClicks: 0, ftpUploaded: false, fetchDate, noData: true };
      }

      const parsed = this.parseClicksCsv(csvContent);

      if (parsed.length === 0) {
        await pool.query(
          `UPDATE zombie_runs SET status = 'no_data', products_count = 0, total_clicks = 0,
           error_message = 'CSV scaricato ma senza prodotti',
           completed_at = NOW() WHERE id = $1`,
          [run.id]
        );
        return { products: 0, totalClicks: 0, ftpUploaded: false, fetchDate, noData: true };
      }

      await this.persistToDb(tenantId, parsed, fetchDate);

      let ftpUploaded = false;
      if (this.hasFtpConfig()) {
        ftpUploaded = await this.uploadToFtp(tenantId, csvContent, dateStr);
      }

      const totalClicks = parsed.reduce((sum, r) => sum + r.clicks, 0);

      await pool.query(
        `UPDATE zombie_runs SET status = 'completed', products_count = $1, total_clicks = $2,
         ftp_uploaded = $3, completed_at = NOW() WHERE id = $4`,
        [parsed.length, totalClicks, ftpUploaded, run.id]
      );

      console.log(`[Zombie][T:${tenantId.slice(0, 8)}] Completed: ${parsed.length} products, ${totalClicks} clicks`);
      return { products: parsed.length, totalClicks, ftpUploaded, fetchDate };

    } catch (err) {
      await pool.query(
        `UPDATE zombie_runs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
        [err.message.slice(0, 500), run.id]
      ).catch(() => {});
      throw err;
    }
  }

  // ─── Run for ALL configured tenants (cron) ────────────────

  async runForAllTenants() {
    const { rows: tenants } = await pool.query(
      `SELECT DISTINCT tc.tenant_id FROM tenant_configs tc
       WHERE tc.config_key = 'trovaprezzi_username'`
    );

    console.log(`[Zombie] Running for ${tenants.length} configured tenants`);
    const results = [];

    for (const { tenant_id } of tenants) {
      try {
        const result = await this.runForTenant(tenant_id);
        results.push({ tenantId: tenant_id, ...result });
      } catch (err) {
        console.error(`[Zombie][T:${tenant_id.slice(0, 8)}] Error:`, err.message);
        results.push({ tenantId: tenant_id, error: err.message });
      }
      // Delay between tenants
      await new Promise(r => setTimeout(r, 5000));
    }

    await this.closeBrowser();
    return results;
  }

  clearConfigCache(tenantId) {
    if (tenantId) this.configCache.delete(tenantId);
    else this.configCache.clear();
  }
}

module.exports = new ZombieService();
