const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length) process.env[key.trim()] = val.join('=').trim();
  });
}

const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const email = process.argv[2] || 'admin@xhumanpro.com';
const password = process.argv[3] || 'Admin123!';
const name = process.argv[4] || 'Super Admin';

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // 1. Create SuperAdmin user
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      console.log(`User ${email} already exists (id: ${existingUser.rows[0].id})`);
    } else {
      const passwordHash = await bcrypt.hash(password, 12);
      const userResult = await pool.query(
        `INSERT INTO users (email, password_hash, name, role, tenant_id, status)
         VALUES ($1, $2, $3, 'superadmin', NULL, 'active')
         RETURNING id, email, role`,
        [email, passwordHash, name]
      );
      console.log('SuperAdmin created:', userResult.rows[0]);
      console.log(`Email: ${email}`);
      console.log(`Password: ${password}`);
    }

    // 2. Create demo tenant
    const existingTenant = await pool.query("SELECT id FROM tenants WHERE slug = 'demo-ecommerce'");
    let tenantId;
    if (existingTenant.rows.length > 0) {
      tenantId = existingTenant.rows[0].id;
      console.log(`Tenant "Demo E-commerce" already exists (id: ${tenantId})`);
    } else {
      const tenantResult = await pool.query(
        `INSERT INTO tenants (name, slug, status) VALUES ($1, $2, 'active') RETURNING id, name, slug`,
        ['Demo E-commerce', 'demo-ecommerce']
      );
      tenantId = tenantResult.rows[0].id;
      console.log('Tenant created:', tenantResult.rows[0]);
    }

    console.log('\nSetup complete. 2FA will be configured on first login.');
    console.log(`\nLogin: ${email} / ${password}`);
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();
