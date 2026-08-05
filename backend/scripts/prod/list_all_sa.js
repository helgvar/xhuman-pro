// Lista TUTTO ciò che il service account vede su Drive (ogni folder condiviso),
// a caccia della consegna scraper completa (~90MB ogni 5-6h)
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

    // 1. Tutti i file recenti visibili (qualsiasi folder), i più grossi prima
    const resp = await drive.files.list({
      q: "trashed = false AND modifiedTime > '2026-07-09T00:00:00Z'",
      fields: 'files(id, name, parents, createdTime, modifiedTime, size, mimeType)',
      orderBy: 'modifiedTime desc',
      pageSize: 200,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: 'allDrives',
    });
    const files = resp.data.files || [];
    console.log(`File visibili modificati dal 9/7: ${files.length}`);
    for (const f of files) {
      const mb = (parseInt(f.size || 0) / 1024 / 1024).toFixed(1);
      console.log(`${f.name} | ${mb}MB | mod ${f.modifiedTime} | parent ${(f.parents||['?'])[0]} | ${f.mimeType}`);
    }

    // 2. Tutti i folder visibili (per capire cosa ci è stato condiviso)
    const resp2 = await drive.files.list({
      q: "trashed = false AND mimeType = 'application/vnd.google-apps.folder'",
      fields: 'files(id, name, createdTime)',
      pageSize: 100,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: 'allDrives',
    });
    console.log('\n=== FOLDER visibili al service account ===');
    for (const f of resp2.data.files || []) {
      console.log(`${f.name} | id ${f.id} | creato ${f.createdTime}`);
    }
  } catch (e) { console.error('ERR:', e.message); }
  finally { try { await pool.end(); } catch {} }
})();
