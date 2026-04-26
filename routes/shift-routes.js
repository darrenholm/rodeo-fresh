const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { authenticateToken } = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// GET all shifts with assignment counts
router.get('/', authenticateToken, async (req, res) => {
  try {
    // Get all shifts
    const shiftsResult = await pool.query(`
      SELECT * FROM shifts 
      ORDER BY date, start_time
    `);
    
    // Get assignment counts for each shift
    const countsResult = await pool.query(`
      SELECT shift_id, COUNT(*) as assigned_count
      FROM shift_assignments
      GROUP BY shift_id
    `);
    
    const counts = {};
    countsResult.rows.forEach(row => {
      counts[row.shift_id] = parseInt(row.assigned_count);
    });
    
    // Add assignment counts to shifts
    const shifts = shiftsResult.rows.map(shift => ({
      ...shift,
      assigned_count: counts[shift.id] || 0,
      spots_available: 6 - (counts[shift.id] || 0)
    }));
    
    res.json(shifts);
    
  } catch (error) {
    console.error('Error fetching shifts:', error);
    res.status(500).json({ error: 'Failed to fetch shifts' });
  }
});

// GET shift details with assigned staff
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get shift
    const shiftResult = await pool.query(
      'SELECT * FROM shifts WHERE id = $1',
      [id]
    );
    
    if (shiftResult.rows.length === 0) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    
    // Get assigned staff
    const assignmentsResult = await pool.query(
      `SELECT * FROM shift_assignments 
       WHERE shift_id = $1 
       ORDER BY assigned_date`,
      [id]
    );
    
    const shift = shiftResult.rows[0];
    shift.assigned_staff = assignmentsResult.rows;
    shift.assigned_count = assignmentsResult.rows.length;
    shift.spots_available = 6 - assignmentsResult.rows.length;
    
    res.json(shift);
    
  } catch (error) {
    console.error('Error fetching shift:', error);
    res.status(500).json({ error: 'Failed to fetch shift' });
  }
});

// POST assign staff to shift (self-service or admin)
router.post('/:id/assign', authenticateToken, async (req, res) => {
  try {
    const { id: shiftId } = req.params;
    const { staff_id, staff_name, assigned_by } = req.body;
    
    if (!staff_id || !staff_name) {
      return res.status(400).json({ error: 'Missing staff_id or staff_name' });
    }
    
    // Check if shift exists
    const shiftResult = await pool.query(
      'SELECT * FROM shifts WHERE id = $1',
      [shiftId]
    );
    
    if (shiftResult.rows.length === 0) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    
    // Check current assignment count
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM shift_assignments WHERE shift_id = $1',
      [shiftId]
    );
    
    const currentCount = parseInt(countResult.rows[0].count);
    
    if (currentCount >= 6) {
      return res.status(400).json({ 
        error: 'Shift is full',
        assigned_count: currentCount,
        max_capacity: 6
      });
    }
    
    // Check if staff already assigned
    const existingResult = await pool.query(
      'SELECT * FROM shift_assignments WHERE shift_id = $1 AND staff_id = $2',
      [shiftId, staff_id]
    );
    
    if (existingResult.rows.length > 0) {
      return res.status(400).json({ error: 'Staff member already assigned to this shift' });
    }
    
    // Create assignment
    const assignmentId = 'assignment_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    await pool.query(
      `INSERT INTO shift_assignments 
       (id, shift_id, staff_id, staff_name, assigned_by, self_assigned) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [assignmentId, shiftId, staff_id, staff_name, assigned_by || staff_id, !assigned_by]
    );
    
    // Get updated shift info
    const updatedCountResult = await pool.query(
      'SELECT COUNT(*) FROM shift_assignments WHERE shift_id = $1',
      [shiftId]
    );
    
    console.log(`✓ Assigned ${staff_name} to shift ${shiftId}`);
    
    res.json({
      success: true,
      assignment_id: assignmentId,
      assigned_count: parseInt(updatedCountResult.rows[0].count),
      spots_available: 6 - parseInt(updatedCountResult.rows[0].count)
    });
    
  } catch (error) {
    console.error('Error assigning shift:', error);
    res.status(500).json({ error: 'Failed to assign shift' });
  }
});

// DELETE remove staff from shift
router.delete('/:shiftId/assign/:staffId', authenticateToken, async (req, res) => {
  try {
    const { shiftId, staffId } = req.params;
    
    const result = await pool.query(
      'DELETE FROM shift_assignments WHERE shift_id = $1 AND staff_id = $2 RETURNING *',
      [shiftId, staffId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    
    // Get updated count
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM shift_assignments WHERE shift_id = $1',
      [shiftId]
    );
    
    console.log(`✓ Removed ${result.rows[0].staff_name} from shift ${shiftId}`);
    
    res.json({
      success: true,
      removed: result.rows[0],
      assigned_count: parseInt(countResult.rows[0].count),
      spots_available: 6 - parseInt(countResult.rows[0].count)
    });
    
  } catch (error) {
    console.error('Error removing assignment:', error);
    res.status(500).json({ error: 'Failed to remove assignment' });
  }
});

// POST create shift
router.post('/', authenticateToken, async (req, res) => {
  const { staff_name, staff_id, date, start_time, end_time, role, notes, event_id } = req.body;
  try {
    const id = `shift_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const result = await pool.query(
      `INSERT INTO shifts (id, staff_name, staff_id, date, start_time, end_time, role, notes, event_id, created_date, updated_date, created_by_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), $10, $11) RETURNING *`,
      [id, staff_name, staff_id, date, start_time, end_time, role, notes, event_id, req.user.userId || req.user.id, req.user.email]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating shift:', error);
    res.status(500).json({ error: 'Failed to create shift' });
  }
});

// PUT update shift
router.put('/:id', authenticateToken, async (req, res) => {
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
    console.error('Error updating shift:', error);
    res.status(500).json({ error: 'Failed to update shift' });
  }
});

// DELETE shift
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM shifts WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    res.json({ message: 'Shift deleted successfully', id: result.rows[0].id });
  } catch (error) {
    console.error('Error deleting shift:', error);
    res.status(500).json({ error: 'Failed to delete shift' });
  }
});

// GET staff member's assigned shifts
router.get('/staff/:staffId', authenticateToken, async (req, res) => {
  try {
    const { staffId } = req.params;
    
    const result = await pool.query(
      `SELECT s.*, sa.assigned_date, sa.notes
       FROM shifts s
       JOIN shift_assignments sa ON s.id = sa.shift_id
       WHERE sa.staff_id = $1
       ORDER BY s.date, s.start_time`,
      [staffId]
    );
    
    // For each shift, get all assigned staff
    for (let shift of result.rows) {
      const staffResult = await pool.query(
        'SELECT staff_id, staff_name FROM shift_assignments WHERE shift_id = $1',
        [shift.id]
      );
      shift.coworkers = staffResult.rows;
    }
    
    res.json(result.rows);
    
  } catch (error) {
    console.error('Error fetching staff shifts:', error);
    res.status(500).json({ error: 'Failed to fetch staff shifts' });
  }
});

module.exports = router;
