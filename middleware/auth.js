const jwt = require('jsonwebtoken');

// ============================================================
//  AUTH MIDDLEWARE — Multi-Role Support
//  
//  Roles: admin, manager, bartender, gate, food, merch
//  Users can have multiple roles stored as JSONB array.
//
//  Usage in routes:
//    router.get('/secret', authenticateToken, requireRole('admin'), handler);
//    router.get('/bar', authenticateToken, requireRole('bartender'), handler);
//    router.get('/reports', authenticateToken, requireRole('admin', 'manager'), handler);
// ============================================================

/**
 * Verify JWT token and attach user to request
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

/**
 * Check if user has ANY of the specified roles.
 * Admin always has access to everything.
 * Manager has access to everything except admin-only routes.
 * 
 * Usage: requireRole('staff')              — any authenticated user
 *        requireRole('manager')            — manager or admin
 *        requireRole('admin')              — admin only
 */
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    const userRoles = req.user.roles || [req.user.role || 'staff'];

    // Admin always has access
    if (userRoles.includes('admin')) {
      return next();
    }

    // Manager has access to manager + staff routes
    if (userRoles.includes('manager') && (allowedRoles.includes('manager') || allowedRoles.includes('staff'))) {
      return next();
    }

    // Check if user has any of the allowed roles
    const hasAccess = allowedRoles.some(role => userRoles.includes(role));

    if (!hasAccess) {
      return res.status(403).json({ 
        error: 'Access denied',
        required: allowedRoles,
        your_roles: userRoles
      });
    }

    next();
  };
};

/**
 * Backward-compatible shortcuts
 */
const requireAdmin = requireRole('admin');
const requireStaff = (req, res, next) => {
  // Any authenticated user with any role counts as staff
  next();
};

module.exports = { 
  authenticateToken, 
  requireRole,
  requireAdmin, 
  requireStaff 
};
