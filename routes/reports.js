const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// ============================================
// GET /api/reports/today-sales
// Get today's ticket sales summary
// ============================================
router.get('/today-sales', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_orders,
        COALESCE(SUM(quantity), 0) as total_tickets,
        COALESCE(SUM(total_price::numeric), 0) as total_revenue,
        COALESCE(SUM(quantity_adult), 0) as total_adults,
        COALESCE(SUM(quantity_child), 0) as total_children
      FROM ticket_orders 
      WHERE created_date::date = CURRENT_DATE
        AND status IN ('confirmed', 'paid')
    `);

    res.json(result.rows[0]);

  } catch (error) {
    console.error('Today sales report error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
