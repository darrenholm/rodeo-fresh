const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// GET - filter bar credits by rfid_tag_id
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { rfid_tag_id, id } = req.query;

    if (rfid_tag_id) {
      // First check wristbands table
      const wbResult = await pool.query(
        `SELECT id, rfid_uid as rfid_tag_id, customer_name,
                credits as ticket_quantity, credits_spent as drinks_redeemed,
                alcohol_approved, 'active' as status
         FROM wristbands WHERE rfid_uid = $1`,
        [rfid_tag_id]
      );

      if (wbResult.rows.length > 0) {
        return res.json(wbResult.rows);
      }

      // Fallback: check ticket_orders table
      const toResult = await pool.query(
        `SELECT id, rfid_tag_id, customer_name,
                COALESCE(bar_credits, 0) as ticket_quantity,
                0 as drinks_redeemed,
                is_19_plus as alcohol_approved,
                'active' as status
         FROM ticket_orders WHERE rfid_tag_id = $1`,
        [rfid_tag_id]
      );

      return res.json(toResult.rows);
    }

    if (id) {
      // Try wristbands first, then ticket_orders
      const wbResult = await pool.query(
        `SELECT id, rfid_uid as rfid_tag_id, customer_name,
                credits as ticket_quantity, credits_spent as drinks_redeemed,
                alcohol_approved, 'active' as status
         FROM wristbands WHERE id = $1`,
        [id]
      );
      if (wbResult.rows.length > 0) return res.json(wbResult.rows);

      const toResult = await pool.query(
        `SELECT id, rfid_tag_id, customer_name,
                COALESCE(bar_credits, 0) as ticket_quantity,
                0 as drinks_redeemed,
                is_19_plus as alcohol_approved,
                'active' as status
         FROM ticket_orders WHERE id = $1`,
        [id]
      );
      return res.json(toResult.rows);
    }

    // No filter
    const result = await pool.query(
      `SELECT id, rfid_uid as rfid_tag_id, customer_name,
              credits as ticket_quantity, credits_spent as drinks_redeemed,
              alcohol_approved, 'active' as status
       FROM wristbands ORDER BY created_date DESC`
    );
    res.json(result.rows);

  } catch (error) {
    console.error('Error fetching bar credits:', error);
    res.status(500).json({ error: 'Failed to fetch bar credits' });
  }
});

// PUT - update bar credits (redeem drinks)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { drinks_redeemed } = req.body;

    if (drinks_redeemed === undefined) {
      return res.status(400).json({ error: 'No update fields provided' });
    }

    // Try wristbands first
    const wbResult = await pool.query(
      `UPDATE wristbands SET credits_spent = $1 WHERE id = $2
       RETURNING id, rfid_uid as rfid_tag_id, customer_name,
                 credits as ticket_quantity, credits_spent as drinks_redeemed`,
      [drinks_redeemed, id]
    );

    if (wbResult.rows.length > 0) return res.json(wbResult.rows[0]);

    // Fallback: update ticket_orders (store drinks_redeemed in bar_credits as negative offset)
    // For ticket_orders, we track redeemed drinks separately
    // We'll use bar_credits to store REMAINING credits
    const toResult = await pool.query(
      `UPDATE ticket_orders SET bar_credits = GREATEST(bar_credits - 1, 0) WHERE id = $1
       RETURNING id, rfid_tag_id, customer_name,
                 COALESCE(bar_credits, 0) + $2 as ticket_quantity,
                 $2 as drinks_redeemed`,
      [id, drinks_redeemed]
    );

    if (toResult.rows.length > 0) return res.json(toResult.rows[0]);

    res.status(404).json({ error: 'Record not found' });

  } catch (error) {
    console.error('Error updating bar credits:', error);
    res.status(500).json({ error: 'Failed to update bar credits' });
  }
});

module.exports = router;