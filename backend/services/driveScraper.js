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
 *
 * ⏱️ Il timestamp dentro il CSV è ora di BUCAREST (UTC+3), non UTC: un file
 * creato su Drive alle 15:01:11Z porta righe timbrate 18:00:08 — tre ore
 * esatte, verificato l'11/8/2026 su results.csv, hot_results.csv e
 * hot_changes.csv. Scritto com'era, mandava 319.426 righe nel FUTURO e faceva
 * sembrare tutto 3 ore più fresco di quanto fosse. La conversione la fa
 * Postgres (`AT TIME ZONE 'Europe/Bucharest'`), non JS: così l'ora legale è
 * gestita dal database e non da un +3 scritto a mano.
 *
 * 📦 CADENZA NUOVA (ordine capo 11/8 sera): file piccoli (~2.000 prodotti)
 * ogni 15 minuti invece di un file gigante ogni 4-5 ore. Non si prendono più
 * "gli ultimi N file per tipo": si prende OGNI file mai visto (registro
 * `scraper_files_seen`), e ogni file si fonde nella base completa con UPSERT —
 * i piccoli aggiornano, non sostituiscono.
 */

const { google } = require('googleapis');
const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB (12/7: FB ha consegnato un results da 205MB — il tetto vecchio 200MB l'avrebbe scartato)
const MAX_FILES_AGE_HOURS = 72;
const BATCH_DOWNLOAD_SIZE = 2;
const BATCH_DELAY_MS = 500;
// Tetto per GIRO, non per tipo: i file nuovi non si perdono, si smaltiscono
// nei giri successivi (il poller passa ogni 5 minuti). Serve solo a non far
// durare un'ora il primo giro quando c'è un arretrato di file grossi.
const MAX_FILES_PER_RUN = 8;

// Nomi consegnati dal fornitore. results/walls hanno lo stesso formato
// posizionale; top_results è la mappa dei listing (parser suo).
const NOMI_DETTAGLIO = ['results.csv', 'walls.csv'];
const NOMI_MAPPA = ['top_results.csv'];
// 🚫 ORDINE CAPO 11/8 sera: "hot_results e hot_change ignorali, i file sono
// sempre results". Elencati qui e non fra gli sconosciuti, così il log non
// urla a ogni giro per file che scartiamo di proposito.
const NOMI_IGNORATI = ['hot_results.csv', 'hot_changes.csv'];

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
async function listScraperFiles(drive, folderId, opts = {}) {
  const cutoff = new Date(Date.now() - MAX_FILES_AGE_HOURS * 3600 * 1000).toISOString();

  let allFiles = [];
  let pageToken = null;

  do {
    const resp = await drive.files.list({
      // Finestra su modifiedTime e non su createdTime: se il fornitore
      // sovrascrive un file al posto di caricarne uno nuovo, createdTime resta
      // vecchio e il file sparirebbe dall'elenco pur essendo appena cambiato.
      // I fogli Google entrano nell'elenco solo per essere DETTI: non si
      // scaricano con alt=media e l'export sopra i 10 MB Drive lo rifiuta
      // ("This file is too large to be exported"). Senza di loro nell'elenco
      // il buco era invisibile: 2 file 'results' da 8 MB dell'11/8 non li
      // vedeva nessuno, nemmeno il log dei nomi sconosciuti.
      q: `'${folderId}' in parents AND (mimeType = 'text/csv' OR mimeType = 'application/octet-stream' OR mimeType = 'application/vnd.google-apps.spreadsheet') AND trashed = false AND modifiedTime > '${cutoff}'`,
      fields: 'nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, size)',
      orderBy: 'modifiedTime asc',
      pageSize: 1000,
      pageToken,
    });
    allFiles.push(...(resp.data.files || []));
    pageToken = resp.data.nextPageToken;
  } while (pageToken);

  // results/walls/hot_* = dettaglio competitor; top_results.csv = MAPPA dei
  // listing visitati dallo scraper (~23k/passaggio). Scartarla ci rendeva ciechi
  // sulla copertura reale (scoperto 11/7: FB scrappa tutto, noi vedevamo solo
  // la fetta a rotazione dei results.csv)
  const noti = [...NOMI_DETTAGLIO, ...NOMI_MAPPA];
  const eFoglio = f => f.mimeType === 'application/vnd.google-apps.spreadsheet';
  const scraperFiles = allFiles.filter(f => noti.includes(f.name) && !eFoglio(f));

  // Nomi che non conosciamo: non li ingeriamo alla cieca, ma li DICIAMO. Un
  // file scartato in silenzio è un buco che nessuno scopre (es. 'results'
  // senza estensione, 8MB, visto l'11/8).
  const ignorati = allFiles.filter(f => (!noti.includes(f.name) || eFoglio(f)) && !NOMI_IGNORATI.includes(f.name));
  if (ignorati.length > 0) {
    const nomi = [...new Set(ignorati.map(f => `${f.name}${eFoglio(f) ? ' [foglio Google]' : ''}`))].join(', ');
    console.log(`[DriveScraper] ${ignorati.length} file con nome non riconosciuto, ignorati: ${nomi}`);
  }

  // Skip files troppo grossi
  const validFiles = scraperFiles.filter(f => {
    const size = parseInt(f.size || 0);
    if (size > MAX_FILE_SIZE) {
      console.log(`[DriveScraper] Skipping ${f.name} (${(size / 1024 / 1024).toFixed(1)}MB > ${MAX_FILE_SIZE / 1024 / 1024}MB limit)`);
      return false;
    }
    return true;
  });

  // Controllo a mano: si vuole l'elenco intero, registro compreso, e lo
  // sfoltimento lo fa chi chiama (nessun log, non è un giro di ingestione).
  if (opts.ignoraRegistro) return validFiles;

  // Fuori quelli già ingeriti: chiave (id, modified_time). Stesso id con
  // modified_time nuovo = il fornitore ha sovrascritto, si rifà.
  const { rows: visti } = await pool.query(
    `SELECT file_id, modified_time FROM scraper_files_seen WHERE file_id = ANY($1::text[])`,
    [validFiles.map(f => f.id)]
  );
  const vistoAl = new Map(visti.map(r => [r.file_id, r.modified_time ? new Date(r.modified_time).getTime() : 0]));
  const nuovi = validFiles.filter(f => {
    const t = vistoAl.get(f.id);
    if (t === undefined) return true;
    return new Date(f.modifiedTime || f.createdTime).getTime() > t;
  });

  // Ordine cronologico (il più vecchio per primo: chi arriva dopo sovrascrive)
  nuovi.sort((a, b) => new Date(a.modifiedTime || a.createdTime) - new Date(b.modifiedTime || b.createdTime));
  const selected = nuovi.slice(0, MAX_FILES_PER_RUN);
  const rimandati = nuovi.length - selected.length;

  console.log(`[DriveScraper] ${validFiles.length} file in finestra ${MAX_FILES_AGE_HOURS}h, ${nuovi.length} mai visti, ne prendo ${selected.length}${rimandati > 0 ? ` (${rimandati} al giro dopo)` : ''}`);
  return selected;
}

/**
 * Segna un file come ingerito. Si scrive DOPO il salvataggio: se il processo
 * muore a metà, il file resta "mai visto" e al giro dopo si rifà — meglio
 * rifare (l'UPSERT è idempotente) che perdere una consegna.
 */
async function segnaFileVisto(f, righe) {
  await pool.query(
    `INSERT INTO scraper_files_seen (file_id, file_name, created_time, modified_time, size_bytes, rows_parsed)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6)
     ON CONFLICT (file_id) DO UPDATE SET
       modified_time = EXCLUDED.modified_time,
       size_bytes = EXCLUDED.size_bytes,
       rows_parsed = EXCLUDED.rows_parsed,
       processed_at = NOW()`,
    [f.id, f.name, f.createdTime || null, f.modifiedTime || f.createdTime || null,
     parseInt(f.size || 0) || null, righe]
  ).catch(e => console.error(`[DriveScraper] registro file err (${f.name}): ${e.message}`));
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
 * Parse top_results.csv: la MAPPA dei listing TP visitati dallo scraper.
 * Formato: code,url,name,API,timestamp (il nome può contenere virgole → regex).
 * È la copertura REALE dello scrape (~23k listing/passaggio): senza di essa
 * non si può distinguere "listing mai visto" da "dettaglio non ancora arrivato".
 */
function parseTopResults(content) {
  const lines = content.split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    const m = line.match(/^(\d+),([^,]*),(.*),API,([\d\-\s:.]+)\s*$/);
    if (!m) continue;
    rows.push({ code: m[1].trim(), url: m[2].trim(), name: m[3].trim(), scrapedAt: m[4].trim() });
  }
  return rows;
}

/**
 * Upsert della mappa listing in scraper_listing_map (first_seen/last_seen).
 * Retention: i listing spariti dallo scrape da >30g vengono rimossi.
 */
async function persistListingMap(rows) {
  if (rows.length === 0) return 0;
  const BATCH = 2000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vals = [];
    const params = [];
    batch.forEach((r, j) => {
      const b = j * 4;
      vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4}::timestamp)`);
      params.push(r.code, r.url, r.name, r.scrapedAt);
    });
    await pool.query(
      // ts arriva senza fuso ed è ora di Bucarest: la conversione la fa il DB
      `INSERT INTO scraper_listing_map (product_code, tp_url, tp_name, first_seen, last_seen)
       SELECT v.code, v.url, v.name,
              (v.ts AT TIME ZONE 'Europe/Bucharest'), (v.ts AT TIME ZONE 'Europe/Bucharest')
       FROM (VALUES ${vals.join(',')}) v(code, url, name, ts)
       ON CONFLICT (product_code) DO UPDATE SET
         tp_url = EXCLUDED.tp_url, tp_name = EXCLUDED.tp_name,
         last_seen = GREATEST(scraper_listing_map.last_seen, EXCLUDED.last_seen)`,
      params
    );
  }
  await pool.query(
    `DELETE FROM scraper_listing_map WHERE last_seen < NOW() - INTERVAL '90 days'`
  );
  return rows.length;
}

/**
 * Merge dei record nell'indice — vince lo scatto più fresco
 * index = { code: { merchant: record } }
 */
/**
 * Ora dello SCATTO di una riga (stringa nuda del CSV, ora di Bucarest).
 * Serve solo per confrontare due righe fra loro: il fuso lo mette Postgres
 * al salvataggio, qui conta la distanza relativa, non l'ora assoluta.
 */
function oraScatto(r) {
  if (!r || !r.scrapedAt) return null;
  const t = Date.parse(String(r.scrapedAt).trim().replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
}

/**
 * Il nuovo record scalza quello già in memoria solo se lo scatto è più recente.
 * A parità di scatto è lo stesso dato riletto (il fornitore ricarica gli stessi
 * file): si tiene quello che c'è già. Chi non ha timestamp non scalza chi ce
 * l'ha: un dato senza ora non può smentire un dato datato.
 */
function scattoPiuFresco(nuovo, attuale) {
  const tn = oraScatto(nuovo);
  const ta = oraScatto(attuale);
  if (tn === null && ta === null) return true;   // nessuno dei due datato: vale l'ultimo letto
  if (tn === null) return false;
  if (ta === null) return true;
  return tn > ta;
}

function mergeIntoIndex(index, records) {
  for (const r of records) {
    if (!index[r.code]) index[r.code] = {};
    // ⏱️ ORDINE CAPO 11/8 sera: vince lo scatto più FRESCO, non l'ultimo file
    // letto. Il file grosso arriva DOPO i piccoli ma dentro ha righe vecchie di
    // ore (misurato: un results.csv delle 18:41 contiene scatti dalle 07:00,
    // 924.887 righe più vecchie di 2h). Quando piccoli e grosso cadono nello
    // stesso giro si fondono qui PRIMA di toccare il DB, quindi la guardia
    // anti-regressione dell'UPSERT non li vede nemmeno: senza questo confronto
    // il grosso riportava indietro prezzi già aggiornati dai piccoli.
    const attuale = index[r.code][r.merchant];
    if (attuale && !scattoPiuFresco(r, attuale)) continue;
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
      // scraped_at: stringa nuda del CSV, ora di Bucarest. NULL se manca —
      // COALESCE mette NOW(), mai un'ora inventata.
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, COALESCE(($${idx++})::timestamp AT TIME ZONE 'Europe/Bucharest', NOW()))`);
      params.push(
        e.code, e.merchant, e.position,
        e.basePrice, e.shippingCost, e.totalPrice,
        e.reviews, e.source, e.scrapedAt || null
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
         updated_at = NOW()
       -- Un file vecchio ingerito dopo uno nuovo non deve riportare indietro il
       -- prezzo: si sovrascrive SOLO con uno scatto più recente. Con file ogni
       -- 15 minuti l'ordine di arrivo non è più garantito, e il fornitore
       -- ricarica lo stesso contenuto due volte (visti due file da 1.058.776
       -- righe identiche a 24 minuti di distanza).
       -- Ordine capo 11/8 sera: strettamente maggiore, non ">=". A parità di
       -- scatto il dato è lo stesso: riscriverlo aggiorna updated_at e fa
       -- sembrare fresca una riga che nessuno ha ri-guardato.
       WHERE EXCLUDED.scraped_at > scraper_competitors.scraped_at`,
      params
    );
    saved += batch.length;
  }

  // Retention 30 GIORNI (12/7, disco a 320GB — mandato capo: 'mantenere
  // quanti più dati possibili e giocare con le statistiche'). Un mese di
  // mercato = trend, bande, stagionalità. ATTENZIONE: ogni query che DECIDE
  // prezzi/posizioni DEVE filtrare scraped_at (guardrail 48h) — la tabella
  // non è "solo fresco".
  await pool.query(
    `DELETE FROM scraper_competitors WHERE updated_at < NOW() - INTERVAL '30 days'`
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
      console.log('[DriveScraper] nessun file nuovo da ingerire');
      if (jobId) await updateJob({ status: 'completed', completed_at: new Date(), metadata: JSON.stringify({ phase: 'done', phase_label: 'Nessun file nuovo', pct: 100 }) });
      return { filesProcessed: 0, products: 0, entries: 0 };
    }

    // 3. Download and parse files in batches
    const index = {};
    const daSegnare = [];
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
        if (NOMI_MAPPA.includes(dl.file.name)) {
          const rows = parseTopResults(dl.content);
          const saved = await persistListingMap(rows);
          await segnaFileVisto(dl.file, saved);
          filesProcessed++;
          console.log(`[DriveScraper] Parsed ${dl.file.name} (${dl.file.createdTime}): ${saved} listing in mappa`);
          continue;
        }
        const records = parseCSV(dl.content, dl.file.name);
        mergeIntoIndex(index, records);
        // Il dettaglio si salva tutto insieme dopo il merge: il file si segna
        // solo se quel salvataggio va a buon fine (lista sotto).
        daSegnare.push({ file: dl.file, righe: records.length });
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

    // Salvataggio andato a buon fine: solo ora i file di dettaglio sono "visti"
    for (const d of daSegnare) await segnaFileVisto(d.file, d.righe);

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

// Le funzioni interne servono anche ai controlli a mano (ri-lettura di un
// gruppo di file per verificare che in tabella ci sia davvero lo scatto più
// fresco): meglio esporle che riscriverle a parte e farle divergere.
module.exports = {
  importScraperData, getDriveClient,
  listScraperFiles, downloadFile, parseCSV, mergeIntoIndex, persistToDB, oraScatto,
};
