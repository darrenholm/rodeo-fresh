/**
 * Clear all bar / food / merch test transaction data and reset wristbands.
 *
 * SAFE TO RE-RUN. Wipes:
 *   - bar_transactions (wristband credit ledger)
 *   - wristbands       (loaded balances + RFID assignments)
 *   - bar_purchases    (legacy bar table)
 *   - kitchen_orders   (food orders)
 *   - merch_sales      (merch sales)
 *
 * Untouched:
 *   - events, staff, shifts, ticket_orders, users
 *   - drinks, booth_menu (catalogs)
 *   - orders (customer storefront — different system)
 *   - sponsor_logos, vendor_logos
 *
 * How to run (either path works):
 *
 *   1. LOCAL with the Railway DATABASE_URL:
 *      $env:DATABASE_URL = "postgres://..."   # PowerShell, paste from Railway → Postgres → Connect
 *      node scripts/clear-test-sales.js
 *
 *   2. From the Railway service shell:
 *      railway run --service rodeo-fresh node scripts/clear-test-sales.js
 *      (uses the service's own env vars, no copy/paste needed)
 */

const pool = require('../config/database');

const TABLES_IN_ORDER = [
  'bar_transactions', // FK -> wristbands, must go first
  'wristbands',
  'bar_purchases',
  'kitchen_orders',
  'merch_sales',
];

async function main() {
  console.log('Counting rows before…');
  for (const t of TABLES_IN_ORDER) {
    try {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
      console.log(`  ${t.padEnd(20)} ${rows[0].n}`);
    } catch (err) {
      console.log(`  ${t.padEnd(20)} (table missing: ${err.message})`);
    }
  }

  console.log('\nTruncating…');
  for (const t of TABLES_IN_ORDER) {
    try {
      await pool.query(`TRUNCATE TABLE ${t} CASCADE`);
      console.log(`  TRUNCATE ${t} ✓`);
    } catch (err) {
      console.log(`  TRUNCATE ${t} skipped (${err.message})`);
    }
  }

  console.log('\nCounting rows after (should all be 0):');
  for (const t of TABLES_IN_ORDER) {
    try {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
      console.log(`  ${t.padEnd(20)} ${rows[0].n}`);
    } catch (_) {
      // ignore — already logged above
    }
  }

  await pool.end();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
