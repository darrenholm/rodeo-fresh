const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const pool = require('../config/database');
const router = express.Router();

// GET all orders
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status, email } = req.query;
    let query = 'SELECT * FROM orders WHERE 1=1';
    const params = [];
    let paramCount = 1;
    
    if (status) {
      query += ` AND status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }
    
    if (email) {
      query += ` AND customer_email = $${paramCount}`;
      params.push(email);
      paramCount++;
    }
    
    query += ' ORDER BY created_date DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// GET single order
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// POST create order
router.post('/', async (req, res) => {
  const { customer_name, customer_email, items, total_amount, shipping_address, stripe_session_id } = req.body;
  try {
    const id = `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const result = await pool.query(
      `INSERT INTO orders (id, customer_name, customer_email, items, total_amount, shipping_address, stripe_session_id, status, created_date, updated_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW(), NOW(), 'anonymous') RETURNING *`,
      [id, customer_name, customer_email, JSON.stringify(items), total_amount, JSON.stringify(shipping_address), stripe_session_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// PUT update order status
router.put('/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  const { status, tracking_number, shipment_id } = req.body;
  try {
    const result = await pool.query(
      `UPDATE orders SET status = $1, tracking_number = $2, shipment_id = $3, updated_date = NOW()
       WHERE id = $4 RETURNING *`,
      [status, tracking_number, shipment_id, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update order' });
  }
});

module.exports = router;
