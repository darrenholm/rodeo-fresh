const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// ============================================
// BAR CREDITS COMPATIBILITY ROUTE
// Maps the frontend's BarPurchase entity to the wristbands table
// Frontend calls: GET /api/bar-credits?rfid_tag_id=xxx
// ============================================

// GET - filter bar credits by rfid_tag_id (or other fields)
// This is what Bartender.jsx calls via entities.BarPurchase.filter({ rfid_tag_id: tagId })
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { rfid_tag_id, id } = req.query;

    // If filtering by ID, look up specific wristband
    if (id) {
      const result = await pool.query(
        `SELECT w.id, w.rfid_uid as rfid_tag_id, w.customer_name, 
                w.credits as ticket_quantity, w.credits_spent as drinks_redeemed,
                w.alcohol_approved, w.ticket_order_id,
                CASE WHEN w.alcohol_approved THEN 'active' ELSE 'pending' END as status
         FROM wristbands w
         WHERE w.id = $1`,
        [id]
      );
      return res.json(result.rows);
    }

    // If filtering by rfid_tag_id, look up by RFID
    if (rfid_tag_id) {
      const result = await pool.query(
        `SELECT w.id, w.rfid_uid as rfid_tag_id, w.customer_name,
                w.credits as ticket_quantity, w.credits_spent as drinks_redeemed,
                w.alcohol_approved, w.ticket_order_id,
                CASE WHEN w.alcohol_approved THEN 'active' ELSE 'pending' END as status
         FROM wristbands w
         WHERE w.rfid_uid = $1`,
        [rfid_tag_id]
      );
      return res.json(result.rows);
    }

    // No filter — return all
    const result = await pool.query(
      `SELECT w.id, w.rfid_uid as rfid_tag_id, w.customer_name,
              w.credits as ticket_quantity, w.credits_spent as drinks_redeemed,
              w.alcohol_approved, w.ticket_order_id,
              CASE WHEN w.alcohol_approved THEN 'active' ELSE 'pending' END as status
       FROM wristbands w
       ORDER BY w.created_date DESC`
    );
    res.json(result.rows);

  } catch (error) {
    console.error('Error fetching bar credits:', error);
    res.status(500).json({ error: 'Failed to fetch bar credits' });
  }
});

// PUT - update bar credits (used by Bartender to record drinks redeemed)
// Frontend calls: entities.BarPurchase.update(id, { drinks_redeemed: newCount })
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { drinks_redeemed } = req.body;

    if (drinks_redeemed !== undefined) {
      // Calculate credits_spent from drinks_redeemed
      // Each "drink redeemed" = 1 credit spent
      const result = await pool.query(
        `UPDATE wristbands 
         SET credits_spent = $1
         WHERE id = $2
         RETURNING id, rfid_uid as rfid_tag_id, customer_name,
                   credits as ticket_quantity, credits_spent as drinks_redeemed,
                   alcohol_approved`,
        [drinks_redeemed, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Bar credit record not found' });
      }

      // Also record a transaction
      try {
        const transactionId = `transaction_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await pool.query(
          `INSERT INTO bar_transactions (id, wristband_id, amount, transaction_type, description, created_by)
           VALUES ($1, $2, $3, 'drink', 'Drinks redeemed via bartender', $4)`,
          [transactionId, id, 1, req.user?.email || 'bartender']
        );
      } catch (txErr) {
        console.log('Transaction log note:', txErr.message);
      }

      return res.json(result.rows[0]);
    }

    res.status(400).json({ error: 'No update fields provided' });

  } catch (error) {
    console.error('Error updating bar credits:', error);
    res.status(500).json({ error: 'Failed to update bar credits' });
  }
});

module.exports = router;
