// AGCO cap on wristband credit purchases: $80 per transaction, suspendable
// via the 'reload_cap_suspended' feature flag once AGCO has inspected.
// Applies to CREDIT LOADS only — food/merch/drink POS sales are not capped.
const CREDIT_CAP_DOLLARS = 80;

// Returns the current per-purchase cap in dollars, or null when suspended.
// Fails CLOSED (cap enforced) if the flag can't be read.
async function getCreditCap(pool) {
  try {
    const r = await pool.query(
      `SELECT enabled FROM feature_flags WHERE key = 'reload_cap_suspended'`
    );
    if (r.rows.length && r.rows[0].enabled === true) return null;
  } catch (e) {
    console.error('creditCap: flag read failed, enforcing cap:', e.message);
  }
  return CREDIT_CAP_DOLLARS;
}

module.exports = { getCreditCap, CREDIT_CAP_DOLLARS };
