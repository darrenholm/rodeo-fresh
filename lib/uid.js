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

// Detects rows written by clients that byte-sorted the scan BEFORE this
// module stripped the wedge reader's trailing checksum byte: sorting moved
// the checksum off the end, so slice() dropped the largest REAL byte and
// kept the checksum. Such a row differs from the true (sorted) UID by
// exactly one byte pair each way, the missing byte is the true UID's
// largest, and the checksum byte it kept sorts lower.
function isSortedSwapCorruption(stored, query) {
  if (stored.length !== query.length) return false;
  const s = (stored.match(/.{2}/g) || []).slice();
  const extra = [];
  for (const b of (query.match(/.{2}/g) || [])) {
    const i = s.indexOf(b);
    if (i === -1) extra.push(b); else s.splice(i, 1);
  }
  // query is normalized (sorted), so its largest byte is the last pair
  return extra.length === 1 && s.length === 1 &&
    extra[0] === query.slice(-2) && s[0] < extra[0];
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

  // Rows corrupted by the sort-before-checksum-strip client bug: a live
  // scan carries the true UID, so heal the row on contact. Only a single
  // unambiguous match may heal — two candidates means we can't know which
  // row is this tag.
  const sameLen = await pool.query(
    `SELECT rfid_uid FROM ${table} WHERE LENGTH(rfid_uid) = $1`,
    [uid.length]
  );
  const corrupt = sameLen.rows.filter((r) =>
    isSortedSwapCorruption(r.rfid_uid.toUpperCase(), uid)
  );
  if (corrupt.length === 1) {
    try {
      await pool.query(
        `UPDATE ${table} SET rfid_uid = $1 WHERE rfid_uid = $2`,
        [uid, corrupt[0].rfid_uid]
      );
      console.log(`[uid] healed sorted-swap (${table}): ${corrupt[0].rfid_uid} -> ${uid}`);
      return uid;
    } catch (e) {
      return corrupt[0].rfid_uid;
    }
  }
  if (corrupt.length > 1) {
    console.warn(`[uid] sorted-swap AMBIGUOUS (${table}): ${uid} matched ${corrupt.length} rows - rejecting`);
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

  // The reverse: rows stored from a 4-byte-only reader (e.g. the badge
  // check-in desk's USB wedge types just the first 4 bytes of a 7-byte
  // card UID). A full phone scan carries all 7 bytes, so upgrade the short
  // row to the full UID on contact — healing is safe in this direction
  // because the full UID strictly extends what the row already holds.
  if (uid.length === 14) {
    const short = await pool.query(
      `SELECT rfid_uid FROM ${table} WHERE LENGTH(rfid_uid) = $1`,
      [8]
    );
    const matches = short.rows.filter((r) => bytesContain(uid, r.rfid_uid.toUpperCase()));
    if (matches.length === 1) {
      try {
        await pool.query(
          `UPDATE ${table} SET rfid_uid = $1 WHERE rfid_uid = $2`,
          [uid, matches[0].rfid_uid]
        );
        console.log(`[uid] short row upgraded (${table}): ${matches[0].rfid_uid} -> ${uid}`);
        return uid;
      } catch (e) {
        return matches[0].rfid_uid;
      }
    }
    if (matches.length > 1) {
      console.warn(`[uid] short-row upgrade AMBIGUOUS (${table}): ${uid} matched ${matches.length} rows - rejecting`);
    }
  }

  return uid;
}

module.exports = { normalizeUid, resolveUid, isSortedSwapCorruption };
