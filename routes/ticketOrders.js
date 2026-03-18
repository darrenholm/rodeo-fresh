const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const pool = require('../config/database');
const router = express.Router();

// GET all ticket orders
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { event_id, status, email } = req.query;
    let query = 'SELECT * FROM ticket_orders WHERE 1=1';
    const params = [];
    let paramCount = 1;
    
    if (event_id) {
      query += ` AND event_id = $${paramCount}`;
      params.push(event_id);
      paramCount++;
    }
    
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
    res.status(500).json({ error: 'Failed to fetch ticket orders' });
  }
});

// GET single ticket order
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ticket_orders WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket order not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ticket order' });
  }
});

// GET by confirmation code
router.get('/confirmation/:code', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ticket_orders WHERE confirmation_code = $1', [req.params.code]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ticket' });
  }
});

// POST search ticket orders by name or email
router.post('/search', authenticateToken, async (req, res) => {
  try {
    const { searchValue, searchType } = req.body;
    if (!searchValue) {
      return res.status(400).json({ error: 'Search value required' });
    }
    
    let query;
    const searchPattern = `%${searchValue}%`;
    
    if (searchType === 'email') {
      query = 'SELECT * FROM ticket_orders WHERE customer_email ILIKE $1 ORDER BY created_date DESC';
    } else {
      query = 'SELECT * FROM ticket_orders WHERE customer_name ILIKE $1 OR customer_email ILIKE $1 OR confirmation_code ILIKE $1 ORDER BY created_date DESC';
    }
    
    const result = await pool.query(query, [searchPattern]);
    res.json({ results: result.rows });
  } catch (error) {
    console.error('Error searching tickets:', error);
    res.status(500).json({ error: 'Failed to search tickets' });
  }
});

// POST create ticket order
router.post('/', async (req, res) => {
  const { event_id, customer_name, customer_email, customer_phone, ticket_type, quantity_adult, quantity_child, total_price } = req.body;
  try {
    const id = `ticket_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const confirmation_code = `WW-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;
    
    const result = await pool.query(
      `INSERT INTO ticket_orders (id, event_id, customer_name, customer_email, customer_phone, ticket_type, quantity_adult, quantity_child, total_price, confirmation_code, status, created_date, updated_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', NOW(), NOW(), 'anonymous') RETURNING *`,
      [id, event_id, customer_name, customer_email, customer_phone, ticket_type, quantity_adult, quantity_child, total_price, confirmation_code]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating ticket order:', error);
    res.status(500).json({ error: 'Failed to create ticket order' });
  }
});

// PUT scan ticket (RFID)
router.put('/:id/scan', authenticateToken, async (req, res) => {
  const { rfid_tag_id } = req.body;
  try {
    const result = await pool.query(
      `UPDATE ticket_orders SET scanned = true, scanned_at = NOW(), rfid_tag_id = $1, status = 'confirmed', updated_date = NOW()
       WHERE id = $2 RETURNING *`,
      [rfid_tag_id, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to scan ticket' });
  }
});

// PUT update ticket status
router.put('/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  const { status } = req.body;
  try {
    const result = await pool.query(
      `UPDATE ticket_orders SET status = $1, updated_date = NOW() WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});

// POST scan ticket and save RFID
router.post('/:id/scan', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { rfid_tag_id } = req.body;

    console.log(`Scanning ticket ${id} with RFID ${rfid_tag_id}`);

    const result = await pool.query(
      `UPDATE ticket_orders 
       SET rfid_tag_id = $1, scanned = true, scanned_at = CURRENT_TIMESTAMP 
       WHERE id = $2 OR confirmation_code = $2
       RETURNING *`,
      [rfid_tag_id, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    console.log(`✓ Ticket scanned: ${result.rows[0].confirmation_code}`);

    res.json({ 
      success: true, 
      ticket: result.rows[0],
      message: 'Ticket scanned successfully'
    });
  } catch (error) {
    console.error('Error scanning ticket:', error);
    res.status(500).json({ error: 'Failed to scan ticket', details: error.message });
  }
});

// PATCH update ticket order fields
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const setClauses = [];
    const values = [];
    let paramIndex = 1;
    
    for (const [key, value] of Object.entries(updates)) {
      setClauses.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
    
    setClauses.push(`updated_date = NOW()`);
    values.push(id);
    
    const result = await pool.query(
      `UPDATE ticket_orders SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating ticket:', error);
    res.status(500).json({ error: 'Failed to update ticket', details: error.message });
  }
});

// POST verify 19+ for a wristband
router.post('/:id/verify-age', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      `UPDATE ticket_orders SET is_19_plus = true, updated_date = NOW() 
       WHERE id = $1 OR rfid_tag_id = $1 RETURNING *`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    
    console.log(`✓ Age verified for ticket: ${result.rows[0].confirmation_code}`);
    res.json({ success: true, ticket: result.rows[0] });
  } catch (error) {
    console.error('Error verifying age:', error);
    res.status(500).json({ error: 'Failed to verify age', details: error.message });
  }
});
// DELETE ticket order (admin only)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM ticket_orders WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    console.log(`✓ Deleted ticket order: ${req.params.id}`);
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    console.error('Error deleting ticket order:', error);
    res.status(500).json({ error: 'Failed to delete ticket order' });
  }
});
module.exports = router;
