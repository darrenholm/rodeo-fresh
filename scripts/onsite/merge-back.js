// Merge event data from the local onsite DB back into the cloud (Railway) DB.
// Run ONCE after the event (Aug 3). Local is authoritative for event data.
//
//   node scripts/onsite/merge-back.js            <- DRY RUN (counts only)
//   node scripts/onsite/merge-back.js --apply    <- actually write to cloud
//
// Strategy per table (sequence bump at restore time guarantees no PK collisions):
//   wristbands       upsert, local wins (credits/spent/approvals changed onsite)
//   ticket_orders    upsert, local wins (gate check-in flags; walk-up sales)
//   bar_transactions insert-only
//   zone_access_log  insert-only (badge scans)
//   sponsor_guests   upsert, local wins (check-in status)
//   merch_sales      re-insert WITHOUT id (cloud assigns), deduped by order_id
//   drinks/products  upsert, local wins (stock + sold counters)
//   staff            upsert, local wins (drink allowances used)
//   events           tickets_sold = GREATEST(cloud, local)
// Afterwards: reset every cloud serial sequence to max(id)+1.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');

const envFile = path.join(__dirname, 'onsite.env');
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const cloud = new Pool({ connectionString: process.env.CLOUD_DATABASE_URL, ssl: { rejectUnauthorized: false } });
const local = new Pool({ connectionString: process.env.LOCAL_DATABASE_URL });

async function sharedColumns(table) {
  const q = `SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND table_schema='public'`;
  const [c, l] = await Promise.all([cloud.query(q, [table]), local.query(q, [table])]);
  const cs = new Set(c.rows.map(r => r.column_name));
  return l.rows.map(r => r.column_name).filter(x => cs.has(x));
}

// Copy local rows to cloud. mode: 'insert' (ON CONFLICT DO NOTHING) | 'upsert' (local wins)
async function copyTable(table, mode, opts = {}) {
  const cols = await sharedColumns(table);
  if (!cols.length) { console.log(`  ${table}: not in both DBs, skipped`); return; }
  const dropId = opts.dropId && cols.includes('id');
  const useCols = dropId ? cols.filter(c => c !== 'id') : cols;

  const { rows } = await local.query(`SELECT ${cols.map(c => `"${c}"`).join(',')} FROM "${table}" ${opts.where || ''}`);
  if (!rows.length) { console.log(`  ${table}: 0 local rows in scope`); return; }

  let conflict;
  if (dropId) {
    conflict = ''; // plain insert, cloud assigns id; dedupe handled by opts.where/dedupe
  } else if (mode === 'upsert') {
    const sets = useCols.filter(c => c !== 'id').map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
    conflict = `ON CONFLICT (id) DO UPDATE SET ${sets}`;
  } else {
    conflict = `ON CONFLICT (id) DO NOTHING`;
  }

  let written = 0;
  if (APPLY) {
    const client = await cloud.connect();
    try {
      await client.query('BEGIN');
      for (const row of rows) {
        if (opts.dedupe && await opts.dedupe(client, row)) continue;
        // node-postgres turns JS arrays into Postgres array literals, which a
        // json/jsonb column rejects ("invalid input syntax for type json").
        // Stringify arrays/objects so JSON round-trips intact; Dates stay Dates.
        const vals = useCols.map(c => {
          const v = row[c];
          if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
            return JSON.stringify(v);
          }
          return v;
        });
        const params = useCols.map((_, i) => `$${i + 1}`).join(',');
        const res = await client.query(
          `INSERT INTO "${table}" (${useCols.map(c => `"${c}"`).join(',')}) VALUES (${params}) ${conflict}`,
          vals
        );
        written += res.rowCount;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`${table}: ${e.message}`);
    } finally { client.release(); }
  }
  console.log(`  ${table}: ${rows.length} local rows in scope${APPLY ? `, ${written} written/updated` : ' (dry run)'}`);
}

(async () => {
  const cutoverFile = path.join(__dirname, 'CUTOVER_TIME.txt');
  const cutover = fs.existsSync(cutoverFile) ? fs.readFileSync(cutoverFile, 'utf8').trim() : null;
  console.log(`Merge-back ${APPLY ? '*** APPLY ***' : '(dry run)'} — cutover: ${cutover || 'unknown'}`);

  await copyTable('wristbands', 'upsert');
  await copyTable('ticket_orders', 'upsert');
  await copyTable('bar_transactions', 'insert');

  // kitchen_orders: SERIAL ids assigned independently on each side, so let the
  // cloud assign fresh ids and dedupe by (order_number, total, ~created_at).
  // The 2s window absorbs JS Date millisecond truncation vs pg microseconds.
  await copyTable('kitchen_orders', 'insert', {
    dropId: true,
    dedupe: async (client, row) => {
      const r = await client.query(
        `SELECT 1 FROM kitchen_orders
         WHERE order_number = $1 AND total = $2
           AND created_at BETWEEN $3::timestamptz - interval '2 seconds'
                               AND $3::timestamptz + interval '2 seconds'
         LIMIT 1`,
        [row.order_number, row.total, row.created_at]
      );
      return r.rows.length > 0;
    },
  });
  await copyTable('zone_access_log', 'insert');
  await copyTable('sponsor_guests', 'upsert');
  await copyTable('drinks', 'upsert');
  await copyTable('products', 'upsert');
  await copyTable('staff', 'upsert');

  // merch_sales: cloud assigns new ids; skip rows whose order_id already exists in cloud
  await copyTable('merch_sales', 'insert', {
    dropId: true,
    where: cutover ? `WHERE created_at > '${cutover}'` : '',
    dedupe: async (client, row) => {
      const r = await client.query('SELECT 1 FROM merch_sales WHERE order_id = $1 LIMIT 1', [row.order_id]);
      return r.rows.length > 0;
    },
  });

  // events: keep the higher tickets_sold
  const evs = await local.query('SELECT id, tickets_sold FROM events');
  if (APPLY) {
    for (const ev of evs.rows) {
      await cloud.query('UPDATE events SET tickets_sold = GREATEST(COALESCE(tickets_sold,0), $1) WHERE id = $2', [ev.tickets_sold || 0, ev.id]);
    }
  }
  console.log(`  events: tickets_sold reconciled for ${evs.rows.length} events${APPLY ? '' : ' (dry run)'}`);

  // Reset cloud serial sequences past any ids we just imported
  if (APPLY) {
    const seqFix = await cloud.query(`
      SELECT table_name, column_name, pg_get_serial_sequence(quote_ident(table_name), column_name) AS seq
      FROM information_schema.columns
      WHERE table_schema='public' AND column_default LIKE 'nextval%'`);
    for (const s of seqFix.rows.filter(r => r.seq)) {
      await cloud.query(`SELECT setval($1, GREATEST((SELECT COALESCE(MAX("${s.column_name}"),0) FROM "${s.table_name}") , 1))`, [s.seq]);
    }
    console.log(`  sequences: ${seqFix.rows.length} cloud sequences reset past imported ids`);
  }

  console.log(APPLY ? 'MERGE COMPLETE — cloud is primary again.' : 'Dry run complete. Re-run with --apply to write.');
  await cloud.end(); await local.end();
})().catch(async e => {
  console.error('MERGE FAILED (cloud table rolled back):', e.message);
  process.exit(1);
});
