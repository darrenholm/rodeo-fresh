const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const pool = require('../config/database');

const router = express.Router();

/**
 * GET /api/staff
 * Get all staff members
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { year, adult, smartserve } = req.query;
    
    let query = 'SELECT * FROM staff WHERE 1=1';
    const params = [];
    let paramCount = 1;
    
    // Filter by year availability
    if (year) {
      query += ` AND y${year} = $${paramCount}`;
      params.push(true);
      paramCount++;
    }
    
    // Filter by adult status
    if (adult !== undefined) {
      query += ` AND adult = $${paramCount}`;
      params.push(adult === 'true');
      paramCount++;
    }
    
    // Filter by smartserve certification
    if (smartserve !== undefined) {
      query += ` AND smartserve = $${paramCount}`;
      params.push(smartserve === 'true');
      paramCount++;
    }
    
    query += ' ORDER BY no ASC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching staff:', error);
    res.status(500).json({ error: 'Failed to fetch staff' });
  }
});

/**
 * GET /api/staff/:id
 * Get single staff member
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM staff WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching staff member:', error);
    res.status(500).json({ error: 'Failed to fetch staff member' });
  }
});

/**
 * POST /api/staff
 * Create new staff member
 */
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  const {
    fname, lname, email, phone, adult, smartserve,
    y2024, y2025, y2026, y2027, y2028
  } = req.body;

  try {
    // Generate ID
    const id = `staff_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const fullname = `${fname} ${lname}`;
    
    // Get next staff number
    const maxNoResult = await pool.query('SELECT MAX(no) as max_no FROM staff');
    const nextNo = (maxNoResult.rows[0].max_no || 0) + 1;

    const result = await pool.query(
      `INSERT INTO staff (
        id, no, fname, lname, fullname, email, phone, adult, smartserve,
        y2024, y2025, y2026, y2027, y2028,
        created_date, updated_date, created_by_id, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW(), $15, $16)
      RETURNING *`,
      [
        id, nextNo, fname, lname, fullname, email, phone, adult, smartserve,
        y2024, y2025, y2026, y2027, y2028,
        req.user.userId, req.user.email
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating staff member:', error);
    res.status(500).json({ error: 'Failed to create staff member' });
  }
});

/**
 * PUT /api/staff/:id
 * Update staff member
 */
router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  const {
    fname, lname, email, phone, adult, smartserve,
    y2024, y2025, y2026, y2027, y2028
  } = req.body;

  try {
    const fullname = `${fname} ${lname}`;
    
    const result = await pool.query(
      `UPDATE staff SET
        fname = $1, lname = $2, fullname = $3, email = $4, phone = $5,
        adult = $6, smartserve = $7, y2024 = $8, y2025 = $9, y2026 = $10,
        y2027 = $11, y2028 = $12, updated_date = NOW()
      WHERE id = $13
      RETURNING *`,
      [
        fname, lname, fullname, email, phone, adult, smartserve,
        y2024, y2025, y2026, y2027, y2028, req.params.id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating staff member:', error);
    res.status(500).json({ error: 'Failed to update staff member' });
  }
});

/**
 * DELETE /api/staff/:id
 * Delete staff member
 */
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM staff WHERE id = $1 RETURNING id',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    res.json({ message: 'Staff member deleted successfully', id: result.rows[0].id });
  } catch (error) {
    console.error('Error deleting staff member:', error);
    res.status(500).json({ error: 'Failed to delete staff member' });
  }
});

module.exports = router;
