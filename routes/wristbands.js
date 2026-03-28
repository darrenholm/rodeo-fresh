const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// ── Normalize UID so all devices produce the same result ──
function normalizeUid(uid) {
  const cleaned = uid.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  const bytes = cleaned.match(/.{2}/g);
  return bytes ? bytes.sort().join('') : cleaned;
}

// ============================================
// WRISTBAND ROUTES
// ============================================

// GET wristband by RFID UID
router.get('/rfid/:uid', authenticateToken, async (req, res) => {
  try {
    const uid = normalizeUid(req.params.uid);
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

    const uid = normalizeUid(rfid_uid);

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

    const uid = normalizeUid(rfid_uid);
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

// POST add credits (Credit Booth)
router.post('/add-credits', authenticateToken, async (req, res) => {
  try {
    const { rfid_uid, amount } = req.body;
    if (!rfid_uid || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const uid = normalizeUid(rfid_uid);
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

// POST redeem drink (Bar)
router.post('/redeem', authenticateToken, async (req, res) => {
  try {
    const { rfid_uid, amount = 7.00 } = req.body;
    if (!rfid_uid) {
      return res.status(400).json({ error: 'Missing rfid_uid' });
    }

    const uid = normalizeUid(rfid_uid);
    const wristbandResult = await pool.query(
      'SELECT * FROM wristbands WHERE UPPER(rfid_uid) = $1',
      [uid]
    );
    if (wristbandResult.rows.length === 0) {
      return res.status(404).json({ error: 'Wristband not found' });
    }
    const wristband = wristbandResult.rows[0];

    if (!wristband.alcohol_approved) {
      return res.status(403).json({ error: 'Not approved for alcohol' });
    }
    if (wristband.credits < amount) {
      return res.status(400).json({ error: 'Insufficient credits', available: wristband.credits, required: amount });
    }

    const result = await pool.query(
      `UPDATE wristbands 
       SET credits = credits - $1, credits_spent = credits_spent + $1
       WHERE UPPER(rfid_uid) = $2 RETURNING *`,
      [amount, uid]
    );

    const transactionId = `transaction_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await pool.query(
      `INSERT INTO bar_transactions (id, wristband_id, amount, transaction_type, description, created_by)
       VALUES ($1, $2, $3, 'drink', 'Drink served', $4)`,
      [transactionId, wristband.id, amount, req.user.email]
    );

    console.log(`✓ Drink served: ${uid} -$${amount}, balance: $${result.rows[0].credits}`);
    res.json({ success: true, wristband: result.rows[0], new_balance: result.rows[0].credits, message: 'Drink served successfully' });

  } catch (error) {
    console.error('Error redeeming drink:', error);
    res.status(500).json({ error: 'Failed to redeem drink' });
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
router.post('/cancel-drink', authenticateToken, async (req, res) => {
  try {
    const { rfid_uid } = req.body;
    if (!rfid_uid) return res.status(400).json({ error: 'Missing rfid_uid' });

    const uid = normalizeUid(rfid_uid);
    const result = await pool.query(
      `UPDATE wristbands 
       SET credits = credits + 7,
           credits_spent = GREATEST(0, credits_spent - 7)
       WHERE UPPER(rfid_uid) = $1 RETURNING *`,
      [uid]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Wristband not found' });

    console.log(`✓ Drink cancelled: ${uid} +$7`);
    res.json({ success: true, wristband: result.rows[0] });

  } catch (error) {
    console.error('Error cancelling drink:', error);
    res.status(500).json({ error: 'Failed to cancel drink' });
  }
});

// GET wristband balance (for kiosk balance checker)
router.get('/balance/:uid', async (req, res) => {
  try {
    const uid = normalizeUid(req.params.uid);
    const result = await pool.query(
      'SELECT rfid_uid, customer_name, credits, credits_spent, alcohol_approved FROM wristbands WHERE UPPER(rfid_uid) = $1',
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
