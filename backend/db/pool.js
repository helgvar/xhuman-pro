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

  // Run migrations in order
  const migrations = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of migrations) {
    const tableName = file === '001_initial.sql' ? 'tenants' :
                      file === '002_orders.sql' ? 'orders' :
                      file === '003_products.sql' ? 'products' : null;

    if (tableName) {
      const { rows } = await pool.query(
        "SELECT EXISTS (SELECT FROM pg_tables WHERE tablename = $1)", [tableName]
      );
      if (rows[0].exists) {
        console.log(`[DB] Migration ${file} already applied, skipping`);
        continue;
      }
    }

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
  }
}

module.exports = { pool, initDB };
