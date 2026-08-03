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

// ============================================
// GET /api/reports/food-by-day
// Breakdown of food items sold per day (kitchen orders), grouped by
// day and item name. Optional query params:
//   start=YYYY-MM-DD, end=YYYY-MM-DD (inclusive, Eastern Time)
//   booth=main|icecream|all (defaults to all booths)
// ============================================
router.get('/food-by-day', authenticateToken, async (req, res) => {
  try {
    const { start, end, booth } = req.query;

    const params = [];
    let query = `
      SELECT
        (created_at AT TIME ZONE 'America/Toronto')::date AS day,
        COALESCE(
          NULLIF(item->>'name', ''),
          NULLIF(item->>'item_name', ''),
          NULLIF(item->>'title', ''),
          'Unknown Item'
        ) AS item_name,
        COALESCE(booth, 'main') AS booth,
        SUM(
          COALESCE(
            NULLIF(item->>'quantity', '')::numeric,
            NULLIF(item->>'qty', '')::numeric,
            1
          )
        ) AS quantity_sold,
        SUM(
          COALESCE(
            NULLIF(item->>'quantity', '')::numeric,
            NULLIF(item->>'qty', '')::numeric,
            1
          ) * COALESCE(NULLIF(item->>'price', '')::numeric, 0)
        ) AS revenue
      FROM kitchen_orders,
           LATERAL jsonb_array_elements(items) AS item
      WHERE status != 'cancelled'
    `;

    if (start) {
      params.push(start);
      query += ` AND (created_at AT TIME ZONE 'America/Toronto')::date >= $${params.length}`;
    }
    if (end) {
      params.push(end);
      query += ` AND (created_at AT TIME ZONE 'America/Toronto')::date <= $${params.length}`;
    }
    if (booth && booth !== 'all') {
      params.push(booth);
      query += ` AND COALESCE(booth, 'main') = $${params.length}`;
    }

    query += `
      GROUP BY day, item_name, COALESCE(booth, 'main')
      ORDER BY day ASC, quantity_sold DESC
    `;

    const { rows } = await pool.query(query, params);

    // Reshape into one entry per day with its items nested, plus day totals.
    const byDay = new Map();
    for (const row of rows) {
      const day = row.day.toISOString().split('T')[0];
      if (!byDay.has(day)) {
        byDay.set(day, { day, total_quantity: 0, total_revenue: 0, items: [] });
      }
      const entry = byDay.get(day);
      const quantity = parseFloat(row.quantity_sold) || 0;
      const revenue = parseFloat(row.revenue) || 0;
      entry.items.push({
        item_name: row.item_name,
        booth: row.booth,
        quantity_sold: quantity,
        revenue
      });
      entry.total_quantity += quantity;
      entry.total_revenue += revenue;
    }

    res.json({ days: Array.from(byDay.values()) });

  } catch (error) {
    console.error('Food-by-day report error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
