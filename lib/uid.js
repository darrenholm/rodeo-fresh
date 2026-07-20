// Shared RFID UID handling for wristbands, badges and staff bands.
//
// Stored rfid_uid values are the scanned hex bytes SORTED byte-pair-wise
// (normalizeUid) so phones, Web NFC and USB wedge readers that report the
// same bytes in different orders all produce the same key.
//
// The gate/check-in USB wedge readers additionally append one extra byte
// after the 7-byte ISO UID (e.g. Android reads 07101D5D7B80DF, the wedge
// outputs 07101D5D7B80DFE3), which made wedge-registered bands "not found"
// on the bar terminals. Two-part fix:
//  - normalizeUid drops the trailing extra byte from raw 16-hex input, so
//    new registrations store the true 7-byte UID, and
//  - resolveUid falls back to a byte-multiset match against legacy 16-char
//    stored rows (the extra byte sorts to an arbitrary position, so prefix
//    matching won't work) and heals them to the canonical 14-char UID.

function normalizeUid(uid) {
  let cleaned = (uid || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  // USB wedge readers emit UID + 1 extra trailing byte for 7-byte ISO UIDs
  if (cleaned.length === 16) cleaned = cleaned.slice(0, 14);
  const bytes = cleaned.match(/.{2}/g);
  return bytes ? bytes.sort().join('') : cleaned;
}

// Can `query` be produced by deleting byte pairs from `stored`?
// (both are sorted-hex strings)
function bytesContain(stored, query) {
  const s = (stored.match(/.{2}/g) || []).slice();
  for (const b of (query.match(/.{2}/g) || [])) {
    const i = s.indexOf(b);
    if (i === -1) return false;
    s.splice(i, 1);
  }
  return true;
}

// Resolve a scanned UID to the rfid_uid actually stored on a row of `table`.
// Returns the key to query with: the normalized input when it matches (or
// nothing matches), else the legacy stored value it healed/mapped to.
async function resolveUid(pool, table, rawUid) {
  const uid = normalizeUid(rawUid);
  const exact = await pool.query(
    `SELECT rfid_uid FROM ${table} WHERE UPPER(rfid_uid) = $1 LIMIT 1`,
    [uid]
  );
  if (exact.rows.length > 0) return uid;
  if (uid.length !== 14) return uid;

  const legacy = await pool.query(
    `SELECT rfid_uid FROM ${table} WHERE LENGTH(rfid_uid) = 16`
  );
  const hit = legacy.rows.find((r) => bytesContain(r.rfid_uid.toUpperCase(), uid));
  if (!hit) return uid;

  // Heal the row to the canonical 14-char UID so future scans exact-match.
  try {
    await pool.query(
      `UPDATE ${table} SET rfid_uid = $1 WHERE rfid_uid = $2`,
      [uid, hit.rfid_uid]
    );
    console.log(`✓ UID healed (${table}): ${hit.rfid_uid} → ${uid}`);
    return uid;
  } catch (e) {
    // unique clash — keep querying by the stored legacy value
    return hit.rfid_uid;
  }
}

module.exports = { normalizeUid, resolveUid };
