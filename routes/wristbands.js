const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// ── Normalize/resolve UIDs so all devices produce the same result ──
// (shared with badges.js and staff-wristband.js; resolveUid also matches +
// heals legacy rows stored with the gate wedge readers' extra trailing byte)
const { normalizeUid, resolveUid } = require('../lib/uid');

// ============================================
// WRISTBAND ROUTES
// ============================================

// GET wristband by RFID UID
router.get('/rfid/:uid', authenticateToken, async (req, res) => {
  try {
    const uid = await resolveUid(pool, 'wristbands', req.params.uid);
    const result = await pool.query(
      `SELECT w.*, t.event_id, t.status as ticket_status
       FROM wristbands w
       LEFT JOIN ticket_orders t ON w.ticket_order_id = t.id
       WHERE UPPER(w.rfid_uid) = $1`,
      [uid]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wristband not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching wristband:', error);
    res.status(500).json({ error: 'Failed to fetch wristband' });
  }
});

// POST link wristband to ticket (Gate 1)
router.post('/link', authenticateToken, async (req, res) => {
  try {
    const { rfid_uid, ticket_order_id, ticket_type } = req.body;
    if (!rfid_uid || !ticket_order_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Registration: resolves to the canonical 7-byte UID (wedge readers'
    // extra trailing byte stripped; heals a legacy row if one matches, so
    // the duplicate-key handler below fires instead of double-registering)
    const uid = await resolveUid(pool, 'wristbands', rfid_uid);

    const ticketResult = await pool.query(
      'SELECT customer_name, customer_email FROM ticket_orders WHERE id = $1',
      [ticket_order_id]
    );
    if (ticketResult.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    const ticket = ticketResult.rows[0];

    const id = `wristband_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const result = await pool.query(
      `INSERT INTO wristbands (
        id, rfid_uid, ticket_order_id, customer_name, customer_email, ticket_type
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [id, uid, ticket_order_id, ticket.customer_name, ticket.customer_email, ticket_type || 'adult']
    );

    console.log(`✓ Wristband linked: ${uid} → ${ticket_order_id}`);
    res.json({ success: true, wristband: result.rows[0] });

  } catch (error) {
    console.error('Error linking wristband:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'This wristband is already registered' });
    }
    res.status(500).json({ error: 'Failed to link wristband' });
  }
});

// POST approve age 19+ (Gate 2)
router.post('/approve-age', authenticateToken, async (req, res) => {
  try {
    const { rfid_uid } = req.body;
    if (!rfid_uid) {
      return res.status(400).json({ error: 'Missing rfid_uid' });
    }

    const uid = await resolveUid(pool, 'wristbands', rfid_uid);
    const result = await pool.query(
      `UPDATE wristbands 
       SET alcohol_approved = true, 
           approved_date = NOW(), 
           approved_by = $1
       WHERE UPPER(rfid_uid) = $2
       RETURNING *`,
      [req.user.email, uid]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wristband not found' });
    }

    console.log(`✓ Age approved: ${uid} by ${req.user.email}`);
    res.json({ success: true, wristband: result.rows[0] });

  } catch (error) {
    console.error('Error approving age:', error);
    res.status(500).json({ error: 'Failed to approve age' });
  }
});

// POST revoke age 19+ (Gate 2 — undo accidental approval)
router.post('/revoke-age', authenticateToken, async (req, res) => {
  try {
    const { rfid_uid } = req.body;
    if (!rfid_uid) {
      return res.status(400).json({ error: 'Missing rfid_uid' });
    }

    const uid = await resolveUid(pool, 'wristbands', rfid_uid);
    const result = await pool.query(
      `UPDATE wristbands 
       SET alcohol_approved = false,
           approved_date = NULL,
           approved_by = NULL
       WHERE UPPER(rfid_uid) = $1
       RETURNING *`,
      [uid]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wristband not found' });
    }

    console.log(`✓ Age revoked: ${uid} by ${req.user.email}`);
    res.json({ success: true, wristband: result.rows[0] });

  } catch (error) {
    console.error('Error revoking age:', error);
    res.status(500).json({ error: 'Failed to revoke age' });
  }
});

// POST add credits (Credit Booth)
router.post('/add-credits', authenticateToken, async (req, res) => {
  try {
    const { rfid_uid, amount } = req.body;
    if (!rfid_uid || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const uid = await resolveUid(pool, 'wristbands', rfid_uid);
    const checkResult = await pool.query(
      'SELECT * FROM wristbands WHERE UPPER(rfid_uid) = $1',
      [uid]
    );
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Wristband not found' });
    }
    const wristband = checkResult.rows[0];

    if (!wristband.alcohol_approved) {
      return res.status(403).json({ error: 'Age not verified. Please visit Gate 2.' });
    }

    const result = await pool.query(
      `UPDATE wristbands SET credits = credits + $1 WHERE UPPER(rfid_uid) = $2 RETURNING *`,
      [amount, uid]
    );

    const transactionId = `transaction_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await pool.query(
      `INSERT INTO bar_transactions (id, wristband_id, amount, transaction_type, description, created_by)
       VALUES ($1, $2, $3, 'purchase', 'Credit purchase', $4)`,
      [transactionId, wristband.id, amount, req.user.email]
    );

    console.log(`✓ Credits added: ${uid} +$${amount}`);
    res.json({ success: true, wristband: result.rows[0], new_balance: result.rows[0].credits });

  } catch (error) {
    console.error('Error adding credits:', error);
    res.status(500).json({ error: 'Failed to add credits' });
  }
});

// POST redeem credits (Bar / Food / Merch)
router.post('/redeem', authenticateToken, async (req, res) => {
  try {
    const { rfid_uid, amount = 7.00, category = 'drink', description } = req.body;
    if (!rfid_uid) {
      return res.status(400).json({ error: 'Missing rfid_uid' });
    }

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1000) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    const normalizedAmt = Math.round(amt * 100) / 100;

    const VALID_CATEGORIES = ['drink', 'food', 'merch', 'other'];
    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const requireAlcoholApproved = category === 'drink';
    const alcoholClause = requireAlcoholApproved ? 'AND alcohol_approved = true' : '';

    const uid = await resolveUid(pool, 'wristbands', rfid_uid);

    const result = await pool.query(
      `UPDATE wristbands
       SET credits = credits - $1, credits_spent = credits_spent + $1
       WHERE UPPER(rfid_uid) = $2 ${alcoholClause} AND credits >= $1
       RETURNING *`,
      [normalizedAmt, uid]
    );

    if (result.rowCount === 0) {
      const check = await pool.query(
        'SELECT alcohol_approved, credits FROM wristbands WHERE UPPER(rfid_uid) = $1',
        [uid]
      );
      if (check.rows.length === 0) {
        return res.status(404).json({ error: 'Wristband not found' });
      }
      if (requireAlcoholApproved && !check.rows[0].alcohol_approved) {
        return res.status(403).json({ error: 'Not approved for alcohol' });
      }
      return res.status(400).json({ error: 'Insufficient credits', available: check.rows[0].credits, required: normalizedAmt });
    }

    const wristband = result.rows[0];

    const DEFAULT_DESCRIPTIONS = {
      drink: 'Drink served',
      food:  'Food purchased',
      merch: 'Merch purchased',
      other: 'Credit redeemed',
    };
    const txnDescription = description || DEFAULT_DESCRIPTIONS[category];

    const transactionId = `transaction_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await pool.query(
      `INSERT INTO bar_transactions (id, wristband_id, amount, transaction_type, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [transactionId, wristband.id, normalizedAmt, category, txnDescription, req.user.email]
    );

    console.log(`✓ ${category} redeemed: ${uid} -$${normalizedAmt}, balance: $${wristband.credits}`);
    res.json({ success: true, wristband, new_balance: wristband.credits, message: 'Redeemed successfully' });

  } catch (error) {
    console.error('Error redeeming:', error);
    res.status(500).json({ error: 'Failed to redeem' });
  }
});

// GET all wristbands (Admin)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT w.*, t.confirmation_code, t.event_id
       FROM wristbands w
       LEFT JOIN ticket_orders t ON w.ticket_order_id = t.id
       ORDER BY w.created_date DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching wristbands:', error);
    res.status(500).json({ error: 'Failed to fetch wristbands' });
  }
});

// POST cancel/refund a drink (Bar)
// Send drink_id so the refund amount comes from the drinks table (and the
// serving goes back into stock). The client-supplied `amount` is only a
// fallback for old app builds — it under-refunded $9/$10 drinks at a flat $7.
router.post('/cancel-drink', authenticateToken, async (req, res) => {
  try {
    const { rfid_uid, drink_id, amount = 7 } = req.body;
    if (!rfid_uid) return res.status(400).json({ error: 'Missing rfid_uid' });

    let refund = amount;
    let drink = null;
    if (drink_id) {
      const drinkResult = await pool.query('SELECT * FROM drinks WHERE id = $1', [drink_id]);
      if (drinkResult.rows.length === 0) return res.status(404).json({ error: 'Drink not found' });
      drink = drinkResult.rows[0];
      refund = drink.price;
    }

    const uid = await resolveUid(pool, 'wristbands', rfid_uid);
    // Refund credits and free up one slot in the per-visit serving counter.
    const result = await pool.query(
      `UPDATE wristbands
       SET credits = credits + $1,
           credits_spent = GREATEST(0, credits_spent - $1),
           visit_drink_count = GREATEST(0, COALESCE(visit_drink_count, 0) - 1)
       WHERE UPPER(rfid_uid) = $2 RETURNING *`,
      [refund, uid]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Wristband not found' });

    if (drink) {
      await pool.query(
        `UPDATE drinks SET stock_remaining = stock_remaining + 1,
         total_sold = GREATEST(0, total_sold - 1) WHERE id = $1`,
        [drink_id]
      );
    }

    const transactionId = `transaction_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await pool.query(
      `INSERT INTO bar_transactions (id, wristband_id, amount, transaction_type, description, drink_name, created_by)
       VALUES ($1, $2, $3, 'refund', $4, $5, $6)`,
      [transactionId, result.rows[0].id, -refund, `${drink ? drink.name : 'Drink'} cancelled`, drink ? drink.name : null, req.user.email]
    );

    console.log(`✓ Drink cancelled: ${uid} +$${refund}${drink ? ` (${drink.name})` : ' (legacy amount)'}`);
    res.json({ success: true, refund, wristband: result.rows[0] });

  } catch (error) {
    console.error('Error cancelling drink:', error);
    res.status(500).json({ error: 'Failed to cancel drink' });
  }
});

// POST start a bar visit — resets the per-visit serving counter to 0.
// Called by the bar POS every time staff scans/loads a customer's wristband,
// so each fresh scan allows up to the AGCO limit of servings again.
router.post('/start-visit', authenticateToken, async (req, res) => {
  try {
    const { rfid_uid } = req.body;
    if (!rfid_uid) return res.status(400).json({ error: 'Missing rfid_uid' });

    const uid = await resolveUid(pool, 'wristbands', rfid_uid);
    const result = await pool.query(
      `UPDATE wristbands SET visit_drink_count = 0
       WHERE UPPER(rfid_uid) = $1 RETURNING rfid_uid, visit_drink_count`,
      [uid]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Wristband not found' });

    res.json({ success: true, visit_drink_count: 0 });
  } catch (error) {
    console.error('Error starting visit:', error);
    res.status(500).json({ error: 'Failed to start visit' });
  }
});

// GET wristband balance (for kiosk balance checker)
router.get('/balance/:uid', async (req, res) => {
  try {
    const uid = await resolveUid(pool, 'wristbands', req.params.uid);
    const result = await pool.query(
      'SELECT rfid_uid, customer_name, credits, credits_spent, alcohol_approved, badge_type, unlimited, area_access FROM wristbands WHERE UPPER(rfid_uid) = $1',
      [uid]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wristband not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching balance:', error);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

module.exports = router;
