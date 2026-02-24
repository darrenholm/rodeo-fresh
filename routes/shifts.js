const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const pool = require('../config/database');
const router = express.Router();

// GET all shifts
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { event_id, date, role } = req.query;
    let query = 'SELECT * FROM shifts WHERE 1=1';
    const params = [];
    let paramCount = 1;
    
    if (event_id) {
      query += ` AND event_id = $${paramCount}`;
      params.push(event_id);
      paramCount++;
    }
    
    if (date) {
      query += ` AND date = $${paramCount}`;
      params.push(date);
      paramCount++;
    }
    
    if (role) {
      query += ` AND role = $${paramCount}`;
      params.push(role);
      paramCount++;
    }
    
    query += ' ORDER BY date ASC, start_time ASC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch shifts' });
  }
});

// POST create shift
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  const { staff_name, staff_id, date, start_time, end_time, role, notes, event_id } = req.body;
  try {
    const id = `shift_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const result = await pool.query(
      `INSERT INTO shifts (id, staff_name, staff_id, date, start_time, end_time, role, notes, event_id, created_date, updated_date, created_by_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), $10, $11) RETURNING *`,
      [id, staff_name, staff_id, date, start_time, end_time, role, notes, event_id, req.user.userId, req.user.email]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create shift' });
  }
});

// PUT update shift
router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { staff_name, staff_id, date, start_time, end_time, role, notes, event_id } = req.body;
  try {
    const result = await pool.query(
      `UPDATE shifts SET staff_name = $1, staff_id = $2, date = $3, start_time = $4, end_time = $5, role = $6, notes = $7, event_id = $8, updated_date = NOW()
       WHERE id = $9 RETURNING *`,
      [staff_name, staff_id, date, start_time, end_time, role, notes, event_id, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update shift' });
  }
});

// DELETE shift
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM shifts WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    res.json({ message: 'Shift deleted successfully', id: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete shift' });
  }
});

module.exports = router;
