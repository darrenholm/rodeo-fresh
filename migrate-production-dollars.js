const { Pool } = require('pg');
const PROD_DB = 'postgresql://postgres:COyDBluhawfWgCtowICyHlAVxJWdGxSi@mainline.proxy.rlwy.net:31899/railway';
const pool = new Pool({ connectionString: PROD_DB, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });

(async () => {
  try {
    await pool.query('SELECT 1');
    console.log('Connected to PRODUCTION');

    // 1. Ensure drinks table exists
    await pool.query(`CREATE TABLE IF NOT EXISTS drinks (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      price DECIMAL(10,2) DEFAULT 7.00,
      stock_quantity INTEGER DEFAULT 0,
      stock_remaining INTEGER DEFAULT 0,
      total_sold INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT true,
      created_date TIMESTAMP DEFAULT NOW()
    )`);
    console.log('[1] drinks table OK');

    // 2. Ensure staff_drink_log table exists
    await pool.query(`CREATE TABLE IF NOT EXISTS staff_drink_log (
      id VARCHAR(255) PRIMARY KEY,
      staff_id VARCHAR(255),
      rfid_uid VARCHAR(255),
      drink_name VARCHAR(255),
      location VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_staff_drink_log_staff ON staff_drink_log(staff_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_staff_drink_log_created ON staff_drink_log(created_at DESC)`);
    console.log('[2] staff_drink_log table OK');

    // 3. Ensure stripe_payments table exists
    await pool.query(`CREATE TABLE IF NOT EXISTS stripe_payments (
      payment_intent_id VARCHAR(255) PRIMARY KEY,
      rfid_uid VARCHAR(255),
      tickets INTEGER,
      amount INTEGER,
      status VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('[3] stripe_payments table OK');

    // 4. Ensure UPPER index on wristbands (for gate scan perf)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wristbands_rfid_upper ON wristbands(UPPER(rfid_uid))`);
    console.log('[4] wristbands UPPER index OK');

    // 5. Check current staff column type
    const colType = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name='staff' AND column_name='drink_allowance'`);
    const currentType = colType.rows[0]?.data_type;
    console.log(`[5] staff.drink_allowance current type: ${currentType}`);

    if (currentType === 'integer') {
      console.log('  Running INTEGER -> DECIMAL conversion with x7 multiplication...');
      const before = await pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE drink_allowance IS NULL) AS null_a, COUNT(*) FILTER (WHERE drinks_used IS NULL) AS null_u FROM staff`);
      console.log('  Before:', before.rows[0]);
      await pool.query(`UPDATE staff SET drink_allowance = 8 WHERE drink_allowance IS NULL`);
      await pool.query(`UPDATE staff SET drinks_used = 0 WHERE drinks_used IS NULL`);
      await pool.query(`UPDATE staff SET drink_allowance = drink_allowance * 7, drinks_used = drinks_used * 7`);
      await pool.query(`ALTER TABLE staff ALTER COLUMN drink_allowance TYPE DECIMAL(10,2) USING drink_allowance::DECIMAL(10,2)`);
      await pool.query(`ALTER TABLE staff ALTER COLUMN drinks_used TYPE DECIMAL(10,2) USING drinks_used::DECIMAL(10,2)`);
      await pool.query(`ALTER TABLE staff ALTER COLUMN drink_allowance SET DEFAULT 56.00`);
      await pool.query(`ALTER TABLE staff ALTER COLUMN drinks_used SET DEFAULT 0`);
      await pool.query(`ALTER TABLE staff ALTER COLUMN drink_allowance SET NOT NULL`);
      await pool.query(`ALTER TABLE staff ALTER COLUMN drinks_used SET NOT NULL`);
      console.log('  Migration complete');
    } else {
      console.log('  Already DECIMAL, skipping conversion');
    }

    const sample = await pool.query(`SELECT id, drink_allowance, drinks_used FROM staff ORDER BY id LIMIT 3`);
    console.log('\nSample staff rows after migration:');
    sample.rows.forEach(r => console.log(' ', r));

    const tableCheck = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('drinks','staff_drink_log','stripe_payments') ORDER BY table_name`);
    console.log('\nKey tables present:', tableCheck.rows.map(r => r.table_name));

    console.log('\nProduction migration complete.');
  } catch (e) { console.error('FATAL:', e.message); }
  finally { await pool.end(); }
})();
