// Scarica le prime righe di top_results.csv + results.csv correnti e conta i codici distinti
const { pool } = require('/app/db/pool');
const { google } = require('googleapis');
const { getGlobal } = require('/app/services/globalConfig');

(async () => {
  try {
    const saJson = await getGlobal('google_service_account_json');
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(saJson),
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    const drive = google.drive({ version: 'v3', auth });
    const files = {
      top_results: '1x43FO0P0xzk', // prefix — need full id, re-list
    };
    const folderId = await getGlobal('scraper_drive_folder_id');
    const resp = await drive.files.list({
      q: `'${folderId}' in parents AND trashed = false AND createdTime > '2026-07-10T00:00:00Z'`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 20,
    });
    const latestTop = (resp.data.files || []).find(f => f.name === 'top_results.csv');
    const latestRes = (resp.data.files || []).find(f => f.name === 'results.csv');
    for (const [label, f] of [['TOP_RESULTS', latestTop], ['RESULTS', latestRes]]) {
      if (!f) { console.log(label, 'non trovato'); continue; }
      const res = await drive.files.get({ fileId: f.id, alt: 'media' }, { responseType: 'text' });
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      const lines = text.split('\n');
      console.log(`\n===== ${label} (${f.createdTime}) — ${lines.length} righe =====`);
      console.log(lines.slice(0, 6).join('\n'));
      // codici distinti (prima colonna)
      const codes = new Set();
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(/[;,]/)[0]?.trim();
        if (c) codes.add(c);
      }
      console.log(`>>> codici distinti: ${codes.size}`);
    }
  } catch (e) { console.error('ERR:', e.message); }
  finally { try { await pool.end(); } catch {} }
})();
