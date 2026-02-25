const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const JWT_SECRET = process.env.JWT_SECRET || 'rodeo2026secret';

// POST /api/auth/staff-login
router.post('/staff-login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM staff WHERE LOWER(email) = LOWER($1)',
      [email.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    const staff = result.rows[0];

    // If no password_hash yet, check against default password directly
    if (!staff.password_hash) {
      if (password !== 'rodeo2026') {
        return res.status(401).json({ error: 'Invalid password' });
      }
      // Auto-hash the default password on first login
      const hash = await bcrypt.hash('rodeo2026', 10);
      await pool.query('UPDATE staff SET password_hash = $1 WHERE id = $2', [hash, staff.id]);
    } else {
      const valid = await bcrypt.compare(password, staff.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid password' });
      }
    }

    // Update last_login if column exists
    try {
      await pool.query('UPDATE staff SET last_login = NOW() WHERE id = $1', [staff.id]);
    } catch (e) { /* column may not exist yet, ignore */ }

    const token = jwt.sign(
      { id: staff.id, email: staff.email, name: staff.fullname },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      staff: {
        id: staff.id,
        name: staff.fullname,
        email: staff.email
      }
    });

  } catch (err) {
    console.error('Staff login error:', err);
    res.status(500).json({ error: 'Login failed', detail: err.message });
  }
});

// POST /api/auth/verify
router.post('/verify', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, staff: decoded });
  } catch (e) {
    res.status(401).json({ valid: false, error: 'Invalid token' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { currentPassword, newPassword } = req.body;

    const result = await pool.query('SELECT * FROM staff WHERE id = $1', [decoded.id]);
    const staff = result.rows[0];

    // Check current password
    if (staff.password_hash) {
      const valid = await bcrypt.compare(currentPassword, staff.password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
    } else {
      if (currentPassword !== 'rodeo2026') return res.status(401).json({ error: 'Current password incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE staff SET password_hash = $1 WHERE id = $2', [hash, decoded.id]);

    res.json({ success: true, message: 'Password changed' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to change password' });
  }
});
// POST /api/auth/reset-staff-password (admin use)
router.post('/reset-staff-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const result = await pool.query(
      'UPDATE staff SET password_hash = NULL WHERE LOWER(email) = LOWER($1) RETURNING email, fullname',
      [email.trim()]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    res.json({ success: true, message: 'Password reset to default (rodeo2026)', staff: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
