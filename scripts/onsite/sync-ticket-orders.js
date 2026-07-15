// Pull online ticket sales (cloud) into the local onsite DB so gate check-in
// can link wristbands for tickets bought during the event.
// One-way cloud -> local, idempotent. Run every 2 minutes via Scheduled Task:
//   node scripts/onsite/sync-ticket-orders.js
// Exits 0 quietly when the internet/cloud is unreachable (expected mode).

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// load onsite.env
const envFile = path.join(__dirname, 'onsite.env');
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const cloud = new Pool({ connectionString: process.env.CLOUD_DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
const local = new Pool({ connectionString: process.env.LOCAL_DATABASE_URL, connectionTimeoutMillis: 5000 });

(async () => {
  let cloudRows;
  try {
    // Everything web-created in the last 7 days — small table, idempotent upsert
    const r = await cloud.query(
      `SELECT * FROM ticket_orders
       WHERE created_by IN ('web','webhook')
         AND created_date > NOW() - INTERVAL '7 days'`
    );
    cloudRows = r.rows;
  } catch (e) {
    console.log(`[sync] cloud unreachable (${e.message}) — skipping this run`);
    process.exit(0); // offline is an expected state, not an error
  }

  if (!cloudRows.length) { console.log('[sync] no online orders in window'); await done(); return; }

  // Column intersection so schema drift between the two DBs can't break inserts
  const [cCols, lCols] = await Promise.all([
    cloud.query(`SELECT column_name FROM information_schema.columns WHERE table_name='ticket_orders'`),
    local.query(`SELECT column_name FROM information_schema.columns WHERE table_name='ticket_orders'`),
  ]);
  const localSet = new Set(lCols.rows.map(r => r.column_name));
  const cols = cCols.rows.map(r => r.column_name).filter(c => localSet.has(c));

  let inserted = 0;
  for (const row of cloudRows) {
    const vals = cols.map(c => row[c]);
    const params = cols.map((_, i) => `$${i + 1}`).join(',');
    const res = await local.query(
      `INSERT INTO ticket_orders (${cols.map(c => `"${c}"`).join(',')})
       VALUES (${params})
       ON CONFLICT (id) DO NOTHING`,
      vals
    );
    inserted += res.rowCount;
  }

  // Keep local tickets_sold at least as high as cloud (tier pricing thresholds)
  try {
    const ce = await cloud.query(`SELECT id, tickets_sold FROM events`);
    for (const ev of ce.rows) {
      await local.query(
        `UPDATE events SET tickets_sold = GREATEST(COALESCE(tickets_sold,0), $1) WHERE id = $2`,
        [ev.tickets_sold || 0, ev.id]
      );
    }
  } catch (e) {
    console.log('[sync] tickets_sold sync skipped:', e.message);
  }

  console.log(`[sync] ${cloudRows.length} online orders in window, ${inserted} new locally`);
  await done();

  async function done() { await cloud.end().catch(() => {}); await local.end().catch(() => {}); }
})().catch(async e => {
  console.error('[sync] FAILED:', e.message);
  process.exit(1);
});
