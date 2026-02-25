const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

router.get('/', authenticateToken, async (req, res) => {
  try {
    const { rfid_tag_id, id } = req.query;

    if (rfid_tag_id) {
      const result = await pool.query(
        `SELECT id, rfid_tag_id, customer_name,
                COALESCE(bar_credits, 0) as ticket_quantity,
                COALESCE(bar_redeemed, 0) as drinks_redeemed,
                is_19_plus as alcohol_approved,
                'active' as status
         FROM ticket_orders WHERE rfid_tag_id = $1`,
        [rfid_tag_id]
      );
      return res.json(result.rows);
    }

    if (id) {
      const result = await pool.query(
        `SELECT id, rfid_tag_id, customer_name,
                COALESCE(bar_credits, 0) as ticket_quantity,
                COALESCE(bar_redeemed, 0) as drinks_redeemed,
                is_19_plus as alcohol_approved,
                'active' as status
         FROM ticket_orders WHERE id = $1`,
        [id]
      );
      return res.json(result.rows);
    }

    const result = await pool.query(
      `SELECT id, rfid_tag_id, customer_name,
              COALESCE(bar_credits, 0) as ticket_quantity,
              COALESCE(bar_redeemed, 0) as drinks_redeemed,
              is_19_plus as alcohol_approved,
              'active' as status
       FROM ticket_orders WHERE bar_credits > 0
       ORDER BY created_date DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching bar credits:', error);
    res.status(500).json({ error: 'Failed to fetch bar credits' });
  }
});

router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { drinks_redeemed } = req.body;

    if (drinks_redeemed === undefined) {
      return res.status(400).json({ error: 'No update fields provided' });
    }

    const result = await pool.query(
      `UPDATE ticket_orders SET bar_redeemed = $1 WHERE id = $2
       RETURNING id, rfid_tag_id, customer_name,
                 COALESCE(bar_credits, 0) as ticket_quantity,
                 $1 as drinks_redeemed`,
      [drinks_redeemed, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Record not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating bar credits:', error);
    res.status(500).json({ error: 'Failed to update bar credits' });
  }
});

module.exports = router;