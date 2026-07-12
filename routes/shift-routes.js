const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { authenticateToken } = require('../middleware/auth');

// Fallback when a shift predates the persons_required column
const DEFAULT_PERSONS_REQUIRED = 6;

const personsRequired = (shift) => {
  const n = parseInt(shift.persons_required);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PERSONS_REQUIRED;
};

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
      persons_required: personsRequired(shift),
      assigned_count: counts[shift.id] || 0,
      spots_available: personsRequired(shift) - (counts[shift.id] || 0)
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
    shift.persons_required = personsRequired(shift);
    shift.assigned_staff = assignmentsResult.rows;
    shift.assigned_count = assignmentsResult.rows.length;
    shift.spots_available = shift.persons_required - assignmentsResult.rows.length;
    
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
    const { staff_id, staff_name } = req.body;

    if (!staff_id || !staff_name) {
      return res.status(400).json({ error: 'Missing staff_id or staff_name' });
    }

    // Self-service signup is open to all staff; assigning someone ELSE requires admin/manager
    const userRoles = req.user.roles || [];
    const isPrivileged = userRoles.includes('admin') || userRoles.includes('manager');
    const isSelf = String(staff_id) === String(req.user.id);

    if (!isSelf && !isPrivileged) {
      return res.status(403).json({ error: 'Only admins can assign other staff to shifts' });
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
    const maxCapacity = personsRequired(shiftResult.rows[0]);

    if (currentCount >= maxCapacity) {
      return res.status(400).json({
        error: 'Shift is full',
        assigned_count: currentCount,
        max_capacity: maxCapacity
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
      [assignmentId, shiftId, staff_id, staff_name, req.user.id, isSelf]
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
      spots_available: maxCapacity - parseInt(updatedCountResult.rows[0].count)
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

    // Staff can drop their own shifts; removing someone ELSE requires admin/manager
    const userRoles = req.user.roles || [];
    const isPrivileged = userRoles.includes('admin') || userRoles.includes('manager');

    if (String(staffId) !== String(req.user.id) && !isPrivileged) {
      return res.status(403).json({ error: 'Only admins can remove other staff from shifts' });
    }

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

    const shiftRow = await pool.query(
      'SELECT persons_required FROM shifts WHERE id = $1',
      [shiftId]
    );
    const maxCapacity = shiftRow.rows.length ? personsRequired(shiftRow.rows[0]) : DEFAULT_PERSONS_REQUIRED;

    console.log(`✓ Removed ${result.rows[0].staff_name} from shift ${shiftId}`);

    res.json({
      success: true,
      removed: result.rows[0],
      assigned_count: parseInt(countResult.rows[0].count),
      spots_available: maxCapacity - parseInt(countResult.rows[0].count)
    });
    
  } catch (error) {
    console.error('Error removing assignment:', error);
    res.status(500).json({ error: 'Failed to remove assignment' });
  }
});

// Parse a persons_required value from a request body; returns null if absent/invalid
const parsePersonsRequired = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// POST create shift
router.post('/', authenticateToken, async (req, res) => {
  const { staff_name, staff_id, date, start_time, end_time, role, notes, event_id } = req.body;
  const persons_required = parsePersonsRequired(req.body.persons_required) || DEFAULT_PERSONS_REQUIRED;
  try {
    const id = `shift_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const result = await pool.query(
      `INSERT INTO shifts (id, staff_name, staff_id, date, start_time, end_time, role, persons_required, notes, event_id, created_date, updated_date, created_by_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW(), $11, $12) RETURNING *`,
      [id, staff_name, staff_id, date, start_time, end_time, role, persons_required, notes, event_id, req.user.userId || req.user.id, req.user.email]
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
  // COALESCE keeps the stored value when the client omits persons_required
  const persons_required = parsePersonsRequired(req.body.persons_required);
  try {
    const result = await pool.query(
      `UPDATE shifts SET staff_name = $1, staff_id = $2, date = $3, start_time = $4, end_time = $5, role = $6, persons_required = COALESCE($7, persons_required), notes = $8, event_id = $9, updated_date = NOW()
       WHERE id = $10 RETURNING *`,
      [staff_name, staff_id, date, start_time, end_time, role, persons_required, notes, event_id, req.params.id]
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
