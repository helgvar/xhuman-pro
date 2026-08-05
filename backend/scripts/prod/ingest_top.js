// One-off: ingest top_results.csv (mappa listing scraper) in scraper_listing_map
const { pool } = require('/app/db/pool');
const { google } = require('googleapis');
const { getGlobal } = require('/app/services/globalConfig');

(async () => {
  const client = await pool.connect();
  try {
    const saJson = await getGlobal('google_service_account_json');
    const folderId = await getGlobal('scraper_drive_folder_id');
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(saJson),
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    const drive = google.drive({ version: 'v3', auth });
    const resp = await drive.files.list({
      q: `'${folderId}' in parents AND trashed = false AND createdTime > '2026-07-10T00:00:00Z'`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime asc',
      pageSize: 20,
    });
    const tops = (resp.data.files || []).filter(f => f.name === 'top_results.csv');
    console.log(`top_results.csv trovati (dal 10/7): ${tops.length}`);

    await client.query(`CREATE TABLE IF NOT EXISTS scraper_listing_map (
      product_code TEXT PRIMARY KEY,
      tp_url TEXT,
      tp_name TEXT,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    for (const f of tops) {
      const res = await drive.files.get({ fileId: f.id, alt: 'media' }, { responseType: 'text' });
      const text = typeof res.data === 'string' ? res.data : String(res.data);
      const lines = text.split('\n');
      const rows = [];
      for (const line of lines) {
        // formato: code,url,name,API,timestamp — il nome può contenere virgole? uso regex conservativa
        const m = line.match(/^(\w+),([^,]*),(.*),API,([\d\-\s:\.]+)\s*$/);
        if (!m) continue;
        rows.push([m[1].trim(), m[2].trim(), m[3].trim(), m[4].trim()]);
      }
      console.log(`${f.name} ${f.createdTime}: ${rows.length} righe parseate`);
      // batch upsert da 2000
      for (let i = 0; i < rows.length; i += 2000) {
        const batch = rows.slice(i, i + 2000);
        const vals = [];
        const params = [];
        batch.forEach((r, j) => {
          const b = j * 4;
          vals.push(`($${b+1},$${b+2},$${b+3},$${b+4}::timestamptz)`);
          params.push(r[0], r[1], r[2], r[4-1]);
        });
        await client.query(`
          INSERT INTO scraper_listing_map (product_code, tp_url, tp_name, first_seen, last_seen)
          SELECT v.code, v.url, v.name, v.ts, v.ts
          FROM (VALUES ${vals.join(',')}) v(code, url, name, ts)
          ON CONFLICT (product_code) DO UPDATE SET
            tp_url = EXCLUDED.tp_url, tp_name = EXCLUDED.tp_name,
            last_seen = GREATEST(scraper_listing_map.last_seen, EXCLUDED.last_seen)`,
          params);
      }
    }
    const { rows: [c] } = await client.query('SELECT COUNT(*) n, MAX(last_seen) mx FROM scraper_listing_map');
    console.log(`scraper_listing_map: ${c.n} codici, ultimo visto ${c.mx}`);
  } catch (e) { console.error('ERR:', e.message); }
  finally { client.release(); try { await pool.end(); } catch {} }
})();
