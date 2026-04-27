const { Pool } = require('pg');
const STAGING_DB = 'postgresql://postgres:VOJOprZyVrLpmlwirepThSHHCGRVIOzI@switchyard.proxy.rlwy.net:22243/railway';
const pool = new Pool({ connectionString: STAGING_DB, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
const statements = [
  `UPDATE staff SET drink_allowance = 8 WHERE drink_allowance IS NULL`,
  `UPDATE staff SET drinks_used = 0 WHERE drinks_used IS NULL`,
  `UPDATE staff SET drink_allowance = drink_allowance * 7, drinks_used = drinks_used * 7`,
  `ALTER TABLE staff ALTER COLUMN drink_allowance TYPE DECIMAL(10,2) USING drink_allowance::DECIMAL(10,2)`,
  `ALTER TABLE staff ALTER COLUMN drinks_used TYPE DECIMAL(10,2) USING drinks_used::DECIMAL(10,2)`,
  `ALTER TABLE staff ALTER COLUMN drink_allowance SET DEFAULT 56.00`,
  `ALTER TABLE staff ALTER COLUMN drinks_used SET DEFAULT 0`,
  `ALTER TABLE staff ALTER COLUMN drink_allowance SET NOT NULL`,
  `ALTER TABLE staff ALTER COLUMN drinks_used SET NOT NULL`,
];
(async () => {
  try {
    await pool.query('SELECT 1'); console.log('Connected');
    for (let i = 0; i < statements.length; i++) {
      try { const res = await pool.query(statements[i]); console.log(`[${i+1}] OK (${res.rowCount ?? 0})`); }
      catch (e) { console.log(`[${i+1}] ERROR: ${e.message}`); }
    }
    const sample = await pool.query("SELECT id, drink_allowance, drinks_used FROM staff WHERE id LIKE 'staff_load_%' LIMIT 3");
    console.log('Sample after migration:', sample.rows);
  } catch (e) { console.error('FATAL:', e.message); }
  finally { await pool.end(); }
})();
