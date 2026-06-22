// ─────────────────────────────────────────────────────────────
//  Add a per-year `level_override` to sponsor_schedule
//  File: migrations/add-sponsor-schedule-level-override.js
//  Run once: node migrations/add-sponsor-schedule-level-override.js
//
//  Adds a nullable VARCHAR(20) `level_override` to the sponsor_schedule table.
//  The sponsor level shown in the staff management table is normally derived
//  live from that year's amount (Title/Platinum/Gold/Silver/Bronze/Friend).
//  Setting level_override to one of those level names forces the displayed
//  level for that sponsor + year regardless of amount; NULL (the default)
//  keeps the automatic, amount-derived behaviour.
//
//  Idempotent (ADD COLUMN IF NOT EXISTS). The same ALTER also runs on startup
//  in server.js; this standalone script lets a fresh database or other
//  environment be brought in line manually and documents the change as code.
// ─────────────────────────────────────────────────────────────
const pool = require('../config/database');

async function run() {
  try {
    console.log('🔧 Adding level_override to sponsor_schedule...');
    await pool.query(`ALTER TABLE sponsor_schedule ADD COLUMN IF NOT EXISTS level_override VARCHAR(20)`);
    console.log('✅ sponsor_schedule: level_override ensured');
    console.log('🎉 Done.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

run();
