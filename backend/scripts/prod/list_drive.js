// Lista TUTTI i file del folder scraper con createdTime + modifiedTime + size
const { pool } = require('/app/db/pool');
const { google } = require('googleapis');
const { getGlobal } = require('/app/services/globalConfig');

(async () => {
  try {
    const saJson = await getGlobal('google_service_account_json');
    const folderId = await getGlobal('scraper_drive_folder_id');
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(saJson),
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    const drive = google.drive({ version: 'v3', auth });
    const resp = await drive.files.list({
      q: `'${folderId}' in parents AND trashed = false`,
      fields: 'files(id, name, createdTime, modifiedTime, size, mimeType)',
      orderBy: 'modifiedTime desc',
      pageSize: 100,
    });
    for (const f of resp.data.files || []) {
      console.log(`${f.name} | created ${f.createdTime} | modified ${f.modifiedTime} | ${(parseInt(f.size||0)/1024/1024).toFixed(1)}MB | ${f.id.slice(0,12)}…`);
    }
  } catch (e) { console.error('ERR:', e.message); }
  finally { try { await pool.end(); } catch {} }
})();
