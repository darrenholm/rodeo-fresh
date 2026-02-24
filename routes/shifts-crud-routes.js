const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Middleware to verify authentication
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }
  
  // In production, verify JWT token here
  next();
}

// GET all shifts
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM shifts 
      ORDER BY date, start_time
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching shifts:', error);
    res.status(500).json({ error: 'Failed to fetch shifts' });
  }
});

// GET single shift
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM shifts WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching shift:', error);
    res.status(500).json({ error: 'Failed to fetch shift' });
  }
});

// POST create new shift
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { date, start_time, end_time, role, notes, staff_name, staff_id } = req.body;
    
    if (!date || !start_time || !end_time || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const shiftId = 'shift_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    await pool.query(
      `INSERT INTO shifts 
       (id, date, start_time, end_time, role, notes, staff_name, staff_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [shiftId, date, start_time, end_time, role, notes || '', staff_name || 'Available', staff_id || null]
    );
    
    const result = await pool.query('SELECT * FROM shifts WHERE id = $1', [shiftId]);
    
    console.log(`✓ Created shift: ${role} ${start_time}-${end_time}`);
    
    res.json({
      success: true,
      shift: result.rows[0]
    });
    
  } catch (error) {
    console.error('Error creating shift:', error);
    console.error('Error details:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to create shift', details: error.message });
  }
});

// PUT update shift
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { date, start_time, end_time, role, notes } = req.body;
    
    if (!date || !start_time || !end_time || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Check if shift exists
    const checkResult = await pool.query('SELECT * FROM shifts WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    
    // Update only the fields that exist in all shift records
    const result = await pool.query(
      `UPDATE shifts 
       SET date = $1, start_time = $2, end_time = $3, role = $4, notes = $5
       WHERE id = $6
       RETURNING *`,
      [date, start_time, end_time, role, notes || '', id]
    );
    
    console.log(`✓ Updated shift: ${id}`);
    
    res.json({
      success: true,
      shift: result.rows[0]
    });
    
  } catch (error) {
    console.error('Error updating shift:', error);
    console.error('Error details:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to update shift', details: error.message });
  }
});

// DELETE shift
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if shift exists
    const checkResult = await pool.query('SELECT * FROM shifts WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    
    // Delete all assignments for this shift first
    await pool.query('DELETE FROM shift_assignments WHERE shift_id = $1', [id]);
    
    // Delete the shift
    await pool.query('DELETE FROM shifts WHERE id = $1', [id]);
    
    console.log(`✓ Deleted shift: ${id}`);
    
    res.json({
      success: true,
      message: 'Shift deleted successfully'
    });
    
  } catch (error) {
    console.error('Error deleting shift:', error);
    res.status(500).json({ error: 'Failed to delete shift' });
  }
});

module.exports = router;
