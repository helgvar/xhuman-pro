/**
 * Google Drive Scraper Service
 *
 * Downloads and parses scraper CSV files (results.csv, walls.csv) from Google Drive.
 * Data is GLOBAL (shared across all tenants) - the scraper folder is the same.
 *
 * CSV format (no header, positional):
 *   code, position, basePrice, shipping, merchant, reviews, timestamp
 *   926832419,1,"83,98","0,00",FarmaNika,8.275,2025-05-10 03:25:23.443024
 *
 * Prices use Italian format (comma = decimal, quotes around prices).
 * Reviews use Italian format (dot = thousands separator).
 */

const { google } = require('googleapis');
const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB per file
const MAX_FILES_AGE_HOURS = 72;
const BATCH_DOWNLOAD_SIZE = 2;
const BATCH_DELAY_MS = 500;
const MAX_FILES_PER_TYPE = 2; // Only latest N files per type (results/walls)

/**
 * Get Google Drive client using service account credentials from DB
 */
async function getDriveClient(tenantId) {
  // Drive è UGUALE PER TUTTI i tenant (memoria utente). Cerchiamo prima in
  // global_config (sorgente unica), poi fallback tenant_configs se per qualche
  // ragione c'è override per tenant. Senza questo fallback, tenant che non
  // hanno scraper_drive_folder_id in tenant_configs (es. Ospedale, SubitoFarma)
  // fallivano con "not configured" anche se la config esiste a livello globale.
  const { getGlobal } = require('./globalConfig');
  let saJson = await getGlobal('google_service_account_json');
  let folderId = await getGlobal('scraper_drive_folder_id');

  if (!saJson || !folderId) {
    // Fallback per-tenant (legacy)
    const { rows } = await pool.query(
      `SELECT config_key, config_value FROM tenant_configs
       WHERE tenant_id = $1 AND config_key IN ('google_service_account_json', 'ga4_credentials_json', 'scraper_drive_folder_id')`,
      [tenantId]
    );
    const config = {};
    for (const row of rows) {
      try { config[row.config_key] = decrypt(row.config_value); }
      catch { config[row.config_key] = row.config_value; }
    }
    saJson = saJson || config.google_service_account_json || config.ga4_credentials_json;
    folderId = folderId || config.scraper_drive_folder_id;
  }

  if (!saJson || !folderId) {
    throw new Error('Google Drive not configured (missing service account or folder ID) — verifica global_config.google_service_account_json + global_config.scraper_drive_folder_id');
  }

  const credentials = JSON.parse(saJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const drive = google.drive({ version: 'v3', auth });

  return { drive, folderId };
}

/**
 * List CSV files in Drive folder (results.csv + walls.csv only)
 */
async function listScraperFiles(drive, folderId) {
  const cutoff = new Date(Date.now() - MAX_FILES_AGE_HOURS * 3600 * 1000).toISOString();

  let allFiles = [];
  let pageToken = null;

  do {
    const resp = await drive.files.list({
      q: `'${folderId}' in parents AND (mimeType = 'text/csv' OR mimeType = 'application/octet-stream') AND trashed = false AND createdTime > '${cutoff}'`,
      fields: 'nextPageToken, files(id, name, createdTime, size)',
      orderBy: 'createdTime asc',
      pageSize: 1000,
      pageToken,
    });
    allFiles.push(...(resp.data.files || []));
    pageToken = resp.data.nextPageToken;
  } while (pageToken);

  // Filter only results.csv and walls.csv (exclude top_results.csv)
  const scraperFiles = allFiles.filter(f =>
    f.name === 'results.csv' || f.name === 'walls.csv'
  );

  // Skip files > 200MB
  const validFiles = scraperFiles.filter(f => {
    const size = parseInt(f.size || 0);
    if (size > MAX_FILE_SIZE) {
      console.log(`[DriveScraper] Skipping ${f.name} (${(size / 1024 / 1024).toFixed(1)}MB > ${MAX_FILE_SIZE / 1024 / 1024}MB limit)`);
      return false;
    }
    return true;
  });

  // Only keep latest N files per type (they're sorted asc, so take from end)
  const resultFiles = validFiles.filter(f => f.name === 'results.csv').slice(-MAX_FILES_PER_TYPE);
  const wallFiles = validFiles.filter(f => f.name === 'walls.csv').slice(-MAX_FILES_PER_TYPE);
  // Return in chronological order (older first for correct merge)
  const selected = [...resultFiles, ...wallFiles].sort((a, b) =>
    new Date(a.createdTime) - new Date(b.createdTime)
  );

  console.log(`[DriveScraper] Selected ${selected.length} files (${resultFiles.length} results + ${wallFiles.length} walls) from ${validFiles.length} total`);
  return selected;
}

/**
 * Download a single file content as text
 */
async function downloadFile(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'text' }
  );
  return res.data;
}

/**
 * Parse Italian price format: "83,98" -> 83.98
 */
function parsePrice(str) {
  if (!str) return 0;
  const cleaned = str.replace(/[€$£\s"]/g, '').replace(',', '.');
  return parseFloat(cleaned) || 0;
}

/**
 * Parse Italian reviews format: "8.275" -> 8275 (dot = thousands)
 */
function parseReviews(str) {
  if (!str) return 0;
  return parseInt(String(str).replace(/\./g, ''), 10) || 0;
}

/**
 * Smart CSV field parser that handles quoted fields with commas
 */
function parseFields(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else current += ch;
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Parse a CSV file content into scraper records
 */
function parseCSV(content, fileName) {
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  const records = [];

  for (const line of lines) {
    const fields = parseFields(line);
    if (fields.length < 6) continue;

    const code = fields[0].trim();
    // code must be numeric (minsan/AIC)
    if (!code || !/^\d+$/.test(code)) continue;

    const position = parseInt(fields[1]) || 99;
    const basePrice = parsePrice(fields[2]);
    const shippingCost = parsePrice(fields[3]);
    const merchant = fields[4].trim();
    const reviews = parseReviews(fields[5]);
    const timestamp = fields[6] ? fields[6].trim() : null;

    if (!merchant) continue;

    records.push({
      code,
      position,
      basePrice,
      shippingCost,
      totalPrice: basePrice + shippingCost,
      merchant,
      reviews,
      source: fileName,
      scrapedAt: timestamp,
    });
  }

  return records;
}

/**
 * Merge records into index (newer overwrites older)
 * index = { code: { merchant: record } }
 */
function mergeIntoIndex(index, records) {
  for (const r of records) {
    if (!index[r.code]) index[r.code] = {};
    // Newer file always overwrites
    index[r.code][r.merchant] = r;
  }
}

/**
 * Persist scraper index to PostgreSQL (batch upsert)
 */
async function persistToDB(index) {
  const entries = [];
  for (const [code, merchants] of Object.entries(index)) {
    for (const record of Object.values(merchants)) {
      entries.push(record);
    }
  }

  if (entries.length === 0) return 0;

  const BATCH_SIZE = 500;
  let saved = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    let idx = 1;

    for (const e of batch) {
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(
        e.code, e.merchant, e.position,
        e.basePrice, e.shippingCost, e.totalPrice,
        e.reviews, e.source, e.scrapedAt || new Date()
      );
    }

    await pool.query(
      `INSERT INTO scraper_competitors (product_code, merchant, position, base_price, shipping_cost, total_price, reviews, source, scraped_at)
       VALUES ${values.join(',')}
       ON CONFLICT (product_code, merchant) DO UPDATE SET
         position = EXCLUDED.position,
         base_price = EXCLUDED.base_price,
         shipping_cost = EXCLUDED.shipping_cost,
         total_price = EXCLUDED.total_price,
         reviews = EXCLUDED.reviews,
         source = EXCLUDED.source,
         scraped_at = EXCLUDED.scraped_at,
         updated_at = NOW()`,
      params
    );
    saved += batch.length;
  }

  // Clean up old records (> 48 hours)
  await pool.query(
    `DELETE FROM scraper_competitors WHERE updated_at < NOW() - INTERVAL '48 hours'`
  );

  return saved;
}

/**
 * Main import function: download CSVs from Drive, parse, persist to DB
 */
async function importScraperData(tenantId, jobId = null) {
  const startedAt = new Date();

  const updateJob = async (fields) => {
    if (!jobId) return;
    const sets = Object.entries(fields).map(([k, v], i) => `${k} = $${i + 1}`);
    const values = Object.values(fields);
    await pool.query(
      `UPDATE import_jobs SET ${sets.join(', ')} WHERE id = $${values.length + 1}`,
      [...values, jobId]
    ).catch(() => {});
  };

  try {
    console.log(`[DriveScraper] Starting import for tenant ${tenantId}`);

    if (jobId) {
      await updateJob({ status: 'running', started_at: new Date(), metadata: JSON.stringify({ phase: 'connecting', phase_label: 'Connessione a Google Drive...', pct: 0 }) });
    }

    // 1. Connect to Drive
    const { drive, folderId } = await getDriveClient(tenantId);

    // 2. List files
    if (jobId) await updateJob({ metadata: JSON.stringify({ phase: 'listing', phase_label: 'Elenco file scraper...', pct: 5 }) });
    const files = await listScraperFiles(drive, folderId);
    console.log(`[DriveScraper] Found ${files.length} CSV files (last ${MAX_FILES_AGE_HOURS}h)`);

    if (files.length === 0) {
      console.log('[DriveScraper] No CSV files found');
      if (jobId) await updateJob({ status: 'completed', completed_at: new Date(), metadata: JSON.stringify({ phase: 'done', phase_label: 'Nessun file trovato', pct: 100 }) });
      return { filesProcessed: 0, products: 0, entries: 0 };
    }

    // 3. Download and parse files in batches
    const index = {};
    let filesProcessed = 0;

    for (let i = 0; i < files.length; i += BATCH_DOWNLOAD_SIZE) {
      const batch = files.slice(i, i + BATCH_DOWNLOAD_SIZE);

      const downloads = await Promise.all(
        batch.map(async (f) => {
          try {
            const content = await downloadFile(drive, f.id);
            return { file: f, content };
          } catch (err) {
            console.error(`[DriveScraper] Failed to download ${f.name}: ${err.message}`);
            return null;
          }
        })
      );

      for (const dl of downloads) {
        if (!dl) continue;
        const records = parseCSV(dl.content, dl.file.name);
        mergeIntoIndex(index, records);
        filesProcessed++;
        console.log(`[DriveScraper] Parsed ${dl.file.name} (${dl.file.createdTime}): ${records.length} records`);
      }

      const pct = 10 + Math.round((filesProcessed / files.length) * 60);
      if (jobId) {
        await updateJob({
          metadata: JSON.stringify({
            phase: 'downloading', phase_label: `Download ${filesProcessed}/${files.length} file...`,
            pct, files_processed: filesProcessed, files_total: files.length,
          })
        });
      }

      // Delay between batches
      if (i + BATCH_DOWNLOAD_SIZE < files.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    // 4. Count products and entries
    const productCount = Object.keys(index).length;
    let entryCount = 0;
    for (const merchants of Object.values(index)) {
      entryCount += Object.keys(merchants).length;
    }
    console.log(`[DriveScraper] Merged: ${productCount} products, ${entryCount} competitor entries`);

    // 5. Persist to DB
    if (jobId) await updateJob({ metadata: JSON.stringify({ phase: 'saving', phase_label: `Salvataggio ${entryCount} record...`, pct: 75 }) });
    const saved = await persistToDB(index);
    console.log(`[DriveScraper] Saved ${saved} records to DB`);

    // 6. Log refresh
    await pool.query(
      `INSERT INTO scraper_refresh_log (source, files_processed, products_count, entries_count, started_at, completed_at, status)
       VALUES ('drive', $1, $2, $3, $4, NOW(), 'completed')`,
      [filesProcessed, productCount, entryCount, startedAt]
    );

    // 7. Complete job
    if (jobId) {
      await pool.query(
        `UPDATE import_jobs SET status = 'completed', completed_at = NOW(),
         records_processed = $1, records_imported = $2,
         metadata = $3 WHERE id = $4`,
        [entryCount, productCount,
         JSON.stringify({ phase: 'done', phase_label: 'Completato', pct: 100, files_processed: filesProcessed, products: productCount, entries: entryCount }),
         jobId]
      );
    }

    console.log(`[DriveScraper] Import complete: ${filesProcessed} files, ${productCount} products, ${entryCount} entries`);
    return { filesProcessed, products: productCount, entries: entryCount };

  } catch (err) {
    console.error(`[DriveScraper] Import error:`, err.message);

    await pool.query(
      `INSERT INTO scraper_refresh_log (source, started_at, completed_at, status, error_message)
       VALUES ('drive', $1, NOW(), 'failed', $2)`,
      [startedAt, err.message]
    ).catch(() => {});

    if (jobId) {
      await pool.query(
        `UPDATE import_jobs SET status = 'failed', completed_at = NOW(), error_message = $1 WHERE id = $2`,
        [err.message, jobId]
      ).catch(() => {});
    }

    throw err;
  }
}

module.exports = { importScraperData, getDriveClient };
