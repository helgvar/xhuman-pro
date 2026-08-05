// Ispeziona i due Google Sheets "results": tab, dimensioni, prime righe
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
    const sheets = google.sheets({ version: 'v4', auth });

    const resp = await drive.files.list({
      q: "trashed = false AND mimeType = 'application/vnd.google-apps.spreadsheet' AND name = 'results'",
      fields: 'files(id, name, modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 10,
    });
    for (const f of resp.data.files || []) {
      console.log(`\n===== SHEET ${f.id} (mod ${f.modifiedTime}) =====`);
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: f.id,
        fields: 'sheets(properties(title,gridProperties(rowCount,columnCount)))',
      });
      for (const s of meta.data.sheets || []) {
        const p = s.properties;
        console.log(`tab "${p.title}": ${p.gridProperties.rowCount} righe x ${p.gridProperties.columnCount} colonne`);
      }
      const firstTab = meta.data.sheets?.[0]?.properties?.title;
      if (firstTab) {
        const vals = await sheets.spreadsheets.values.get({
          spreadsheetId: f.id,
          range: `${firstTab}!A1:H5`,
        });
        console.log('prime righe:', JSON.stringify(vals.data.values, null, 0));
      }
    }
  } catch (e) { console.error('ERR:', e.message); }
  finally { try { await pool.end(); } catch {} }
})();
