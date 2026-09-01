// Bulk repair for RFID rows corrupted by the sort-before-checksum-strip
// client bug (staff-portal pages byte-sorted scans before sending, so
// lib/uid.js sliced off the largest real byte instead of the wedge
// reader's trailing checksum byte).
//
// The true UID never made it into the corrupted row, so this script
// recovers it from every real scan the database has kept — access-log and
// drink-log entries carry the normalized UID that was actually on the tag
// at scan time. Rows with no matching logged scan can't be repaired
// offline; they self-heal on their next tap (lib/uid.js) or can be
// re-linked in Edit Staff.
//
// Usage:
//   node scripts/repair-sorted-uid-rows.js            # dry run (default)
//   node scripts/repair-sorted-uid-rows.js --apply    # write repairs
require('dotenv').config();
const pool = require('../config/database');
const { normalizeUid, isSortedSwapCorruption } = require('../lib/uid');

const APPLY = process.argv.includes('--apply');

async function tableExists(name) {
  const r = await pool.query('SELECT to_regclass($1) AS t', [name]);
  return !!r.rows[0].t;
}

// Every UID a physical tag has ever produced at a scanner, deduped.
async function collectScannedUids() {
  const uids = new Set();
  const sources = [
    { table: 'staff_access_log', column: 'rfid_uid' },
    { table: 'staff_drink_log', column: 'rfid_uid' },
    { table: 'transactions', column: 'rfid_uid' },
    { table: 'access_log', column: 'rfid_uid' },
  ];
  for (const { table, column } of sources) {
    if (!(await tableExists(table))) continue;
    try {
      const r = await pool.query(
        `SELECT DISTINCT ${column} AS uid FROM ${table} WHERE ${column} IS NOT NULL`
      );
      for (const row of r.rows) {
        const uid = normalizeUid(row.uid);
        if (uid.length === 14 || uid.length === 8) uids.add(uid);
      }
      console.log(`  ${table}: ${r.rows.length} distinct UIDs`);
    } catch (e) {
      console.log(`  ${table}: skipped (${e.message})`);
    }
  }
  return [...uids];
}

async function repairTable(table, scannedUids) {
  const rows = (
    await pool.query(
      `SELECT rfid_uid FROM ${table} WHERE rfid_uid IS NOT NULL AND (LENGTH(rfid_uid) = 14 OR LENGTH(rfid_uid) = 8)`
    )
  ).rows.map((r) => r.rfid_uid);
  const stored = new Set(rows.map((r) => r.toUpperCase()));

  // Propose first, apply second: a repair is only safe when it's 1:1 in
  // both directions — one scanned UID per row AND one row per scanned UID
  // (two rows claiming the same scan would collapse into duplicates).
  const proposals = [];
  let ambiguous = 0;
  for (const row of rows) {
    const upper = row.toUpperCase();
    if (scannedUids.includes(upper)) continue; // row matches a real scan — healthy
    const matches = scannedUids.filter(
      (uid) => !stored.has(uid) && isSortedSwapCorruption(upper, uid)
    );
    if (matches.length === 1) {
      proposals.push({ row, target: matches[0] });
    } else if (matches.length > 1) {
      ambiguous++;
      console.warn(`  AMBIGUOUS (left alone): ${row} could be any of ${matches.join(', ')}`);
    }
  }
  const claims = {};
  for (const p of proposals) claims[p.target] = (claims[p.target] || 0) + 1;

  let repaired = 0;
  for (const { row, target } of proposals) {
    if (claims[target] > 1) {
      ambiguous++;
      console.warn(`  AMBIGUOUS (left alone): ${claims[target]} rows all match scan ${target}, one is ${row}`);
      continue;
    }
    repaired++;
    if (APPLY) {
      await pool.query(`UPDATE ${table} SET rfid_uid = $1 WHERE rfid_uid = $2`, [target, row]);
      console.log(`  repaired: ${row} -> ${target}`);
    } else {
      console.log(`  would repair: ${row} -> ${target}`);
    }
  }
  return { total: rows.length, repaired, ambiguous };
}

// Corrupt rows never produce a successful scan, so an active wristband
// whose UID appears in no log line is either unused or still corrupt.
async function listUnverifiedStaff(scannedUids) {
  const r = await pool.query(
    `SELECT fullname, rfid_uid FROM staff WHERE rfid_uid IS NOT NULL AND wristband_active = true`
  );
  return r.rows.filter((row) => !scannedUids.includes(row.rfid_uid.toUpperCase()));
}

(async function main() {
  console.log(APPLY ? '── APPLY mode ──' : '── DRY RUN (pass --apply to write) ──');
  console.log('Collecting true UIDs from scan logs…');
  const scannedUids = await collectScannedUids();
  console.log(`${scannedUids.length} distinct scanned UIDs found\n`);

  for (const table of ['staff', 'wristbands']) {
    if (!(await tableExists(table))) continue;
    console.log(`Checking ${table}…`);
    const { total, repaired, ambiguous } = await repairTable(table, scannedUids);
    console.log(`  ${table}: ${total} rows, ${repaired} ${APPLY ? 'repaired' : 'repairable'}, ${ambiguous} ambiguous\n`);
  }

  const unverified = await listUnverifiedStaff(scannedUids);
  if (unverified.length) {
    console.log('Active staff wristbands with no logged successful scan —');
    console.log('possibly still corrupt; they self-heal at next tap, or re-link in Edit Staff:');
    for (const s of unverified) console.log(`  ${s.fullname}  (${s.rfid_uid})`);
  } else {
    console.log('Every active staff wristband has a logged successful scan.');
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
