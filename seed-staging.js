// ============================================================
// RE-SEED with proper RFID UIDs that survive normalizeUid().
// The route normalizes by stripping non-hex chars + sorting bytes,
// so we need pre-sorted hex UIDs.
// ============================================================

const { Pool } = require('pg');

const STAGING_DB = 'postgresql://postgres:VOJOprZyVrLpmlwirepThSHHCGRVIOzI@switchyard.proxy.rlwy.net:22243/railway';

const pool = new Pool({
  connectionString: STAGING_DB,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

// Generate N unique 4-byte hex UIDs in non-decreasing byte order.
// These survive normalizeUid() unchanged.
function generateUids(count, byteCount = 4) {
  const seq = new Array(byteCount).fill(0);
  const out = [];
  while (out.length < count) {
    out.push(seq.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(''));
    // Increment to next non-decreasing sequence
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
    console.log('Connecting to staging Postgres...');
    await pool.query('SELECT 1');
    console.log('Connected\n');

    // Wipe old test wristbands and staff
    console.log('Removing old test data with bad UIDs...');
    const d1 = await pool.query(`DELETE FROM bar_transactions WHERE wristband_id LIKE 'wb_load_%'`);
    console.log(`  bar_transactions deleted: ${d1.rowCount}`);
    const d2 = await pool.query(`DELETE FROM wristbands WHERE id LIKE 'wb_load_%'`);
    console.log(`  wristbands deleted: ${d2.rowCount}`);
    const d3 = await pool.query(`DELETE FROM staff_drink_log WHERE staff_id LIKE 'staff_load_%'`);
    console.log(`  staff_drink_log deleted: ${d3.rowCount}`);
    const d4 = await pool.query(`DELETE FROM staff WHERE id LIKE 'staff_load_%'`);
    console.log(`  staff deleted: ${d4.rowCount}`);
    console.log('');

    // Generate fresh UIDs
    const wristbandUids = generateUids(3500, 4);  // 4-byte UIDs for wristbands
    const staffUids = generateUids(50, 7).map(u => '0F' + u); // 7-byte for staff, prefixed to keep distinct
    console.log(`Generated ${wristbandUids.length} wristband UIDs (sample: ${wristbandUids.slice(0, 3).join(', ')})`);
    console.log(`Generated ${staffUids.length} staff UIDs (sample: ${staffUids.slice(0, 3).join(', ')})\n`);

    // Re-insert wristbands with valid UIDs
    console.log('Inserting 3500 wristbands...');
    const wbInsert = await pool.query(`
      INSERT INTO wristbands (id, rfid_uid, ticket_order_id, customer_name, customer_email, ticket_type, alcohol_approved, credits)
      SELECT
        'wb_load_' || LPAD((idx-1)::text, 5, '0'),
        u.uid,
        'tkt_load_' || LPAD((idx-1)::text, 5, '0'),
        'Load Test Customer ' || (idx-1),
        'loadtest' || (idx-1) || '@staging.test',
        'adult',
        ((idx-1) % 5 != 0),
        CASE WHEN (idx-1) % 5 != 0 THEN (((idx-1) % 20) * 7)::DECIMAL(10,2) ELSE 0::DECIMAL(10,2) END
      FROM unnest($1::text[]) WITH ORDINALITY AS u(uid, idx)
      ON CONFLICT (rfid_uid) DO NOTHING
    `, [wristbandUids]);
    console.log(`  inserted: ${wbInsert.rowCount}`);

    // Re-insert staff with valid UIDs
    console.log('Inserting 50 staff...');
    const stInsert = await pool.query(`
      INSERT INTO staff (id, no, fname, lname, fullname, email, adult, smartserve, y2026, rfid_uid, drink_allowance, drinks_used, wristband_active)
      SELECT
        'staff_load_' || LPAD((idx-1)::text, 3, '0'),
        9000 + (idx-1),
        'Test' || (idx-1),
        'Staff' || (idx-1),
        'Test' || (idx-1) || ' Staff' || (idx-1),
        'staff' || (idx-1) || '@staging.test',
        true, true, true,
        u.uid,
        8, 0, true
      FROM unnest($1::text[]) WITH ORDINALITY AS u(uid, idx)
      ON CONFLICT (id) DO NOTHING
    `, [staffUids]);
    console.log(`  inserted: ${stInsert.rowCount}`);

    // Save first 10 UIDs to a file for the load test to reference
    const fs = require('fs');
    const sample = {
      wristband_uids: wristbandUids,
      staff_uids: staffUids,
      first_wristband: wristbandUids[0],
      last_wristband: wristbandUids[wristbandUids.length - 1],
    };
    fs.writeFileSync('/tmp/seed/wristband-uids.json', JSON.stringify(sample, null, 2));

    // Verify
    console.log('\n=== Verification ===');
    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM events) AS events,
        (SELECT COUNT(*) FROM drinks) AS drinks,
        (SELECT COUNT(*) FROM ticket_orders WHERE id LIKE 'tkt_load_%') AS load_tickets,
        (SELECT COUNT(*) FROM wristbands WHERE id LIKE 'wb_load_%') AS load_wristbands,
        (SELECT COUNT(*) FROM staff WHERE id LIKE 'staff_load_%') AS load_staff
    `);
    console.log(counts.rows[0]);

    // Spot-check: pick one and verify the lookup query would work
    const spot = await pool.query(`SELECT rfid_uid FROM wristbands WHERE id = 'wb_load_00000' LIMIT 1`);
    if (spot.rows[0]) {
      console.log(`\nFirst wristband rfid_uid: ${spot.rows[0].rfid_uid}`);
      console.log(`Use this in your load test as a working sample UID.`);
    }
    console.log('\nDone.');
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();