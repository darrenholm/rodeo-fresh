const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:VOJOprZyVrLpmlwirepThSHHCGRVIOzI@switchyard.proxy.rlwy.net:22243/railway', ssl: { rejectUnauthorized: false } });
(async () => {
  await pool.query("UPDATE wristbands SET credits = 70, credits_spent = 0, alcohol_approved = true WHERE rfid_uid = '00000001'");
  const r = await pool.query("SELECT rfid_uid, credits, credits_spent, alcohol_approved FROM wristbands WHERE rfid_uid = '00000001'");
  console.log(r.rows[0]);
  await pool.end();
})();
