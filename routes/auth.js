const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// ============================================================
//  AUTH ROUTES — Updated with Multi-Role Support
// ============================================================

/**
 * POST /api/auth/register
 * Register a new user (admin only in production)
 */
router.post('/register',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }),
    body('name').trim().notEmpty()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, name, role = 'user', roles } = req.body;

    try {
      const userExists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (userExists.rows.length > 0) {
        return res.status(400).json({ error: 'User already exists' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const userRoles = roles || [role === 'admin' ? 'admin' : 'gate'];

      const result = await pool.query(
        `INSERT INTO users (email, password, name, role, roles, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) 
         RETURNING id, email, name, role, roles`,
        [email, hashedPassword, name, role, JSON.stringify(userRoles)]
      );

      const user = result.rows[0];
      const token = jwt.sign(
        { userId: user.id, email: user.email, role: user.role, roles: user.roles },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN }
      );

      res.status(201).json({
        message: 'User created successfully',
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role, roles: user.roles }
      });
    } catch (error) {
      console.error('Registration error:', error);
      res.status(500).json({ error: 'Registration failed' });
    }
  }
);

/**
 * POST /api/auth/login
 * Login — returns JWT with roles
 */
router.post('/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
      const result = await pool.query(
        'SELECT id, email, password, name, role, roles, must_change_password FROM users WHERE email = $1',
        [email]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = result.rows[0];
      const validPassword = await bcrypt.compare(password, user.password);

      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Ensure roles array exists (backward compat)
      const userRoles = user.roles || [user.role || 'user'];

      const token = jwt.sign(
        { userId: user.id, email: user.email, role: user.role, roles: userRoles },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN }
      );

      res.json({
        message: 'Login successful',
        token,
        user: { 
          id: user.id, 
          email: user.email, 
          name: user.name,
          role: user.role,
          roles: userRoles,
          must_change_password: user.must_change_password || false
        }
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  }
);

/**
 * POST /api/auth/verify
 * Verify JWT — returns user with roles
 */
router.post('/verify', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query(
      'SELECT id, email, name, role, roles FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    res.json({ valid: true, user: result.rows[0] });
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ============================================================
//  ROLE MANAGEMENT — Admin only
// ============================================================

/**
 * GET /api/auth/users
 * List all users with roles (admin only)
 */
router.get('/users', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, name, role, roles, created_at FROM users ORDER BY name`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * PUT /api/auth/users/:id/roles
 * Update a user's roles (admin only)
 */
router.put('/users/:id/roles', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { roles } = req.body;

    const validRoles = ['admin', 'manager', 'staff'];
    const filtered = (roles || []).filter(r => validRoles.includes(r));

    if (filtered.length === 0) {
      return res.status(400).json({ error: 'At least one valid role required. Valid: admin, manager, staff' });
    }

    const { rows } = await pool.query(
      `UPDATE users SET roles = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, name, roles`,
      [JSON.stringify(filtered), id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    console.log(`[auth] Roles updated for ${rows[0].email}: ${filtered.join(', ')}`);
    res.json({ success: true, user: rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update roles' });
  }
});

/**
 * POST /api/auth/create-staff
 * Create a new staff user with roles (admin only)
 */
router.post('/create-staff', authenticateToken, requireRole('admin'),
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }),
    body('name').trim().notEmpty()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, name, roles = ['staff'] } = req.body;

    try {
      const userExists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (userExists.rows.length > 0) {
        return res.status(400).json({ error: 'User already exists' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const primaryRole = roles.includes('admin') ? 'admin' : 'staff';

      const result = await pool.query(
        `INSERT INTO users (email, password, name, role, roles, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) 
         RETURNING id, email, name, role, roles`,
        [email, hashedPassword, name, primaryRole, JSON.stringify(roles)]
      );

      console.log(`[auth] Staff created: ${email} with roles: ${roles.join(', ')}`);

      res.status(201).json({
        success: true,
        user: result.rows[0]
      });
    } catch (error) {
      console.error('Create staff error:', error);
      res.status(500).json({ error: 'Failed to create staff account' });
    }
  }
);

/**
 * DELETE /api/auth/users/:id
 * Delete a user (admin only, can't delete self)
 */
router.delete('/users/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;

    if (id === req.user.userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    const { rows } = await pool.query('DELETE FROM users WHERE id = $1 RETURNING email', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    console.log(`[auth] User deleted: ${rows[0].email}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});


// Change password endpoint
router.post('/change-password', async (req, res) => {
  try {
    const { email, currentPassword, newPassword } = req.body;
    if (!email || !currentPassword || !newPassword) {
      return res.status(400).json({ error: 'All fields required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = rows[0];
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1, must_change_password = false WHERE id = $2', [hash, user.id]);
    console.log('[auth] Password changed for:', email);
    res.json({ success: true });
  } catch (error) {
    console.error('[auth] Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
