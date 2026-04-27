const { Pool } = require('pg');
const STAGING_DB = 'postgresql://postgres:VOJOprZyVrLpmlwirepThSHHCGRVIOzI@switchyard.proxy.rlwy.net:22243/railway';
const pool = new Pool({ connectionString: STAGING_DB, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });

function generateUids(count, byteCount = 4) {
  const seq = new Array(byteCount).fill(0);
  const out = [];
  while (out.length < count) {
    out.push(seq.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(''));
    let i = byteCount - 1;
    while (i >= 0 && seq[i] === 255) i--;
    if (i < 0) break;
    seq[i]++;
    for (let j = i + 1; j < byteCount; j++) seq[j] = seq[i];
  }
  return out;
}

(async () => {
  try {
    await pool.query('SELECT 1');
    console.log('Connected');
    console.log('Removing old test data...');
    await pool.query("DELETE FROM bar_transactions WHERE wristband_id LIKE 'wb_load_%'");
    await pool.query("DELETE FROM wristbands WHERE id LIKE 'wb_load_%'");
    await pool.query("DELETE FROM staff_drink_log WHERE staff_id LIKE 'staff_load_%'");
    await pool.query("DELETE FROM staff WHERE id LIKE 'staff_load_%'");
    const wristbandUids = generateUids(3500, 4);
    const staffUids = generateUids(50, 7).map(u => '0F' + u);
    console.log('First wristband UID:', wristbandUids[0]);
    console.log('Inserting 3500 wristbands...');
    const wb = await pool.query(`INSERT INTO wristbands (id, rfid_uid, ticket_order_id, customer_name, customer_email, ticket_type, alcohol_approved, credits) SELECT 'wb_load_' || LPAD((idx-1)::text, 5, '0'), u.uid, 'tkt_load_' || LPAD((idx-1)::text, 5, '0'), 'Load Test Customer ' || (idx-1), 'loadtest' || (idx-1) || '@staging.test', 'adult', ((idx-1) % 5 != 0), CASE WHEN (idx-1) % 5 != 0 THEN (((idx-1) % 20) * 7)::DECIMAL(10,2) ELSE 0::DECIMAL(10,2) END FROM unnest($1::text[]) WITH ORDINALITY AS u(uid, idx) ON CONFLICT (rfid_uid) DO NOTHING`, [wristbandUids]);
    console.log('  inserted:', wb.rowCount);
    console.log('Inserting 50 staff...');
    const st = await pool.query(`INSERT INTO staff (id, no, fname, lname, fullname, email, adult, smartserve, y2026, rfid_uid, drink_allowance, drinks_used, wristband_active) SELECT 'staff_load_' || LPAD((idx-1)::text, 3, '0'), 9000 + (idx-1), 'Test' || (idx-1), 'Staff' || (idx-1), 'Test' || (idx-1) || ' Staff' || (idx-1), 'staff' || (idx-1) || '@staging.test', true, true, true, u.uid, 8, 0, true FROM unnest($1::text[]) WITH ORDINALITY AS u(uid, idx) ON CONFLICT (id) DO NOTHING`, [staffUids]);
    console.log('  inserted:', st.rowCount);
    const counts = await pool.query("SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM wristbands WHERE id LIKE 'wb_load_%') AS load_wristbands, (SELECT COUNT(*) FROM staff WHERE id LIKE 'staff_load_%') AS load_staff");
    console.log(counts.rows[0]);
    const sample = await pool.query("SELECT rfid_uid FROM wristbands WHERE id = 'wb_load_00000'");
    console.log('First wristband stored as:', sample.rows[0].rfid_uid);
  } catch (e) { console.error('FATAL:', e.message); }
  finally { await pool.end(); }
})();
