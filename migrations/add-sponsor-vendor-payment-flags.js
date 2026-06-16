// ─────────────────────────────────────────────────────────────
//  Add record-level payment flags to sponsors and vendors
//  File: migrations/add-sponsor-vendor-payment-flags.js
//  Run once: node migrations/add-sponsor-vendor-payment-flags.js
//
//  Adds two booleans to BOTH the sponsors and vendors tables:
//    paid     — admin marker that payment has been received, including
//               offline payments (cheque / cash / e-transfer). This is
//               deliberately separate from vendors.payment_status, which is
//               managed by the Moneris online-payment flow (routes/moneris.js)
//               and carries payment_date. The manual checkbox must not clobber
//               that system-managed state, and sponsors have no payment_status.
//    in_kind  — contribution provided as goods/services rather than cash.
//
//  Idempotent (ADD COLUMN IF NOT EXISTS). The same ALTERs also run on startup
//  in server.js; this standalone script lets a fresh database or other
//  environment be brought in line manually and documents the schema change
//  as code (the vendors/sponsors tables are otherwise not defined in any
//  migration file).
// ─────────────────────────────────────────────────────────────
const pool = require('../config/database');

async function run() {
  try {
    console.log('🔧 Adding paid / in_kind flags to sponsors and vendors...');
    for (const table of ['sponsors', 'vendors']) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS paid BOOLEAN DEFAULT false`);
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS in_kind BOOLEAN DEFAULT false`);
      console.log(`✅ ${table}: paid, in_kind ensured`);
    }
    console.log('🎉 Done.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

run();
