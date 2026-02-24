const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const pool = require('../config/database');
const router = express.Router();

// GET dashboard stats
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Get total staff count
    const staffCount = await pool.query('SELECT COUNT(*) as count FROM staff');
    
    // Get total events
    const eventsCount = await pool.query('SELECT COUNT(*) as count FROM events');
    
    // Get upcoming events
    const upcomingEvents = await pool.query(
      'SELECT COUNT(*) as count FROM events WHERE date >= NOW()'
    );
    
    // Get total ticket orders
    const ticketOrders = await pool.query('SELECT COUNT(*) as count, SUM(total_price) as revenue FROM ticket_orders');
    
    // Get total product orders
    const productOrders = await pool.query('SELECT COUNT(*) as count, SUM(total_amount) as revenue FROM orders');
    
    // Get recent ticket orders
    const recentTickets = await pool.query(
      'SELECT * FROM ticket_orders ORDER BY created_date DESC LIMIT 10'
    );
    
    // Get recent product orders
    const recentOrders = await pool.query(
      'SELECT * FROM orders ORDER BY created_date DESC LIMIT 10'
    );
    
    res.json({
      staff: {
        total: parseInt(staffCount.rows[0].count)
      },
      events: {
        total: parseInt(eventsCount.rows[0].count),
        upcoming: parseInt(upcomingEvents.rows[0].count)
      },
      tickets: {
        total: parseInt(ticketOrders.rows[0].count),
        revenue: parseFloat(ticketOrders.rows[0].revenue || 0)
      },
      orders: {
        total: parseInt(productOrders.rows[0].count),
        revenue: parseFloat(productOrders.rows[0].revenue || 0)
      },
      recent: {
        tickets: recentTickets.rows,
        orders: recentOrders.rows
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

module.exports = router;
