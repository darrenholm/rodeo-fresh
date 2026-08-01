// Shared RFID UID handling for wristbands, badges and staff bands.
// Stored rfid_uid values are the scanned hex bytes SORTED byte-pair-wise.
function normalizeUid(uid) {
  let cleaned = (uid || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  if (cleaned.length === 16 || cleaned.length === 10) {
    cleaned = cleaned.slice(0, cleaned.length - 2);
  }
  const bytes = cleaned.match(/.{2}/g);
  return bytes ? bytes.sort().join('') : cleaned;
}

function bytesContain(stored, query) {
  const s = (stored.match(/.{2}/g) || []).slice();
  for (const b of (query.match(/.{2}/g) || [])) {
    const i = s.indexOf(b);
    if (i === -1) return false;
    s.splice(i, 1);
  }
  return true;
}

async function resolveUid(pool, table, rawUid) {
  const uid = normalizeUid(rawUid);
  const exact = await pool.query(
    `SELECT rfid_uid FROM ${table} WHERE UPPER(rfid_uid) = $1 LIMIT 1`,
    [uid]
  );
  if (exact.rows.length > 0) return uid;
  if (uid.length !== 14 && uid.length !== 8) return uid;

  // Legacy USB wedge rows: stored value is one byte longer than the scan.
  const legacy = await pool.query(
    `SELECT rfid_uid FROM ${table} WHERE LENGTH(rfid_uid) = $1`,
    [uid.length + 2]
  );
  const hit = legacy.rows.find((r) => bytesContain(r.rfid_uid.toUpperCase(), uid));
  if (hit) {
    try {
      await pool.query(
        `UPDATE ${table} SET rfid_uid = $1 WHERE rfid_uid = $2`,
        [uid, hit.rfid_uid]
      );
      console.log(`[uid] healed (${table}): ${hit.rfid_uid} -> ${uid}`);
      return uid;
    } catch (e) {
      return hit.rfid_uid;
    }
  }

  // Short-reader rows: 4-byte (8 hex) scan matched against full 7-byte rows.
  // NEVER heal here - writing the short value back would destroy the true UID.
  if (uid.length === 8) {
    const full = await pool.query(
      `SELECT rfid_uid FROM ${table} WHERE LENGTH(rfid_uid) = 14`
    );
    const matches = full.rows.filter((r) => bytesContain(r.rfid_uid.toUpperCase(), uid));
    if (matches.length === 1) {
      console.log(`[uid] short-read matched (${table}): ${uid} -> ${matches[0].rfid_uid}`);
      return matches[0].rfid_uid;
    }
    if (matches.length > 1) {
      console.warn(`[uid] short-read AMBIGUOUS (${table}): ${uid} matched ${matches.length} rows - rejecting`);
      return uid;
    }
  }

  return uid;
}

module.exports = { normalizeUid, resolveUid };
