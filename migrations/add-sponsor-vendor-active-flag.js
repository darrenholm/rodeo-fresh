// ─────────────────────────────────────────────────────────────
//  Add an `active` flag to sponsors and vendors
//  File: migrations/add-sponsor-vendor-active-flag.js
//  Run once: node migrations/add-sponsor-vendor-active-flag.js
//
//  Adds a boolean `active` (DEFAULT true) to BOTH the sponsors and vendors
//  tables. Inactive records (active = false) are hidden from the staff
//  management list by default to reduce clutter, but kept in the database.
//
//  DEFAULT true means every existing row stays active/visible after the
//  column is added. Idempotent (ADD COLUMN IF NOT EXISTS). The same ALTERs
//  also run on startup in server.js; this standalone script lets a fresh
//  database or other environment be brought in line manually and documents
//  the schema change as code.
// ─────────────────────────────────────────────────────────────
const pool = require('../config/database');

async function run() {
  try {
    console.log('🔧 Adding active flag to sponsors and vendors...');
    for (const table of ['sponsors', 'vendors']) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`);
      console.log(`✅ ${table}: active ensured`);
    }
    console.log('🎉 Done.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

run();
