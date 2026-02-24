require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function migrate() {
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS last_login TIMESTAMP`);
  console.log('Migration complete!');
  process.exit(0);
}

migrate().catch(e => { console.error(e); process.exit(1); });
