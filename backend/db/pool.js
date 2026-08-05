const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client:', err.message);
});

async function initDB() {
  const fs = require('fs');
  const path = require('path');
  const migrationsDir = path.join(__dirname, 'migrations');

  // Tracking migrazioni (fix 9/7/2026): senza questa tabella OGNI boot
  // ri-eseguiva tutti i .sql — gli ALTER chiedono lock esclusivi e il boot
  // si incastrava dietro le query lunghe (2 ingorghi il 9/7).
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const { rows: done } = await pool.query('SELECT filename FROM schema_migrations');
  const doneSet = new Set(done.map(r => r.filename));

  // Run migrations in order
  const migrations = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  const skipped = migrations.filter(f => doneSet.has(f)).length;
  if (skipped > 0) console.log(`[DB] ${skipped} migrazioni già applicate, skip`);

  for (const file of migrations) {
    if (doneSet.has(file)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    try {
      await pool.query(sql);
      console.log(`[DB] Migration ${file} applied successfully`);
    } catch (err) {
      if (err.code === '42P07') {
        console.log(`[DB] Migration ${file} tables already exist, skipping`);
      } else {
        throw err;
      }
    }
    await pool.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
      [file]);
  }
}

module.exports = { pool, initDB };
