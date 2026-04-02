const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const jwt = require('jsonwebtoken');

// ============================================
// STAFF WRISTBAND ROUTES
// ============================================

function normalizeUid(uid) {
    const cleaned = (uid || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
    const bytes = cleaned.match(/.{2}/g);
    return bytes ? bytes.sort().join('') : cleaned;
}

// ============================================
// GET /api/staff-wristband/:uid
// Look up staff member by wristband UID
// ============================================
router.get('/:uid', async (req, res) => {
    try {
        const uid = normalizeUid(req.params.uid);
        const result = await pool.query(
            `SELECT id, name, email, roles, drink_allowance, drinks_used, wristband_active
             FROM staff
             WHERE UPPER(rfid_uid) = $1 AND wristband_active = true`,
            [uid]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Staff wristband not found' });
        }
        const staff = result.rows[0];
        const drinksRemaining = (staff.drink_allowance || 8) - (staff.drinks_used || 0);
        res.json({
            ...staff,
            drinks_remaining: Math.max(0, drinksRemaining),
            is_admin: (staff.roles || []).includes('admin') || (staff.roles || []).includes('manager')
        });
    } catch (error) {
        console.error('Staff wristband lookup error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// POST /api/staff-wristband/login
// Wristband tap replaces email/password login
// Returns JWT token
// ============================================
router.post('/login', async (req, res) => {
    try {
        const { rfid_uid } = req.body;
        if (!rfid_uid) return res.status(400).json({ error: 'rfid_uid required' });

        const uid = normalizeUid(rfid_uid);
        const result = await pool.query(
            `SELECT id, name, email, roles, drink_allowance, drinks_used, wristband_active
             FROM staff
             WHERE UPPER(rfid_uid) = $1 AND wristband_active = true`,
            [uid]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Staff wristband not recognized' });
        }
        const staff = result.rows[0];

        const token = jwt.sign(
            { id: staff.id, email: staff.email, name: staff.name, roles: staff.roles },
            process.env.JWT_SECRET,
            { expiresIn: '12h' }
        );

        console.log(`✓ Staff wristband login: ${staff.name} (${uid})`);
        res.json({
            success: true,
            token,
            staff: {
                id: staff.id,
                name: staff.name,
                email: staff.email,
                roles: staff.roles,
                drinks_remaining: Math.max(0, (staff.drink_allowance || 8) - (staff.drinks_used || 0)),
                is_admin: (staff.roles || []).includes('admin') || (staff.roles || []).includes('manager')
            }
        });
    } catch (error) {
        console.error('Staff wristband login error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// POST /api/staff-wristband/link
// Link a wristband UID to a staff member
// ============================================
router.post('/link', authenticateToken, async (req, res) => {
    try {
        const { staff_id, rfid_uid } = req.body;
        if (!staff_id || !rfid_uid) {
            return res.status(400).json({ error: 'staff_id and rfid_uid required' });
        }

        const uid = normalizeUid(rfid_uid);

        // Check if UID already assigned to someone else
        const existing = await pool.query(
            'SELECT id, name FROM staff WHERE UPPER(rfid_uid) = $1 AND id != $2',
            [uid, staff_id]
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({
                error: `This wristband is already assigned to ${existing.rows[0].name}`
            });
        }

        const result = await pool.query(
            `UPDATE staff SET rfid_uid = $1, wristband_active = true
             WHERE id = $2 RETURNING id, name, email, rfid_uid, wristband_active`,
            [uid, staff_id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Staff member not found' });
        }

        console.log(`✓ Wristband linked: ${result.rows[0].name} → ${uid}`);
        res.json({ success: true, staff: result.rows[0] });
    } catch (error) {
        console.error('Link wristband error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// POST /api/staff-wristband/unlink
// Remove wristband from staff member
// ============================================
router.post('/unlink', authenticateToken, async (req, res) => {
    try {
        const { staff_id } = req.body;
        if (!staff_id) return res.status(400).json({ error: 'staff_id required' });

        const result = await pool.query(
            `UPDATE staff SET rfid_uid = NULL, wristband_active = false
             WHERE id = $1 RETURNING id, name`,
            [staff_id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Staff member not found' });
        }

        console.log(`✓ Wristband unlinked: ${result.rows[0].name}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Unlink wristband error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// POST /api/staff-wristband/serve-drink
// Serve a free drink to staff member
// ============================================
router.post('/serve-drink', authenticateToken, async (req, res) => {
    try {
        const { rfid_uid, drink_id } = req.body;
        if (!rfid_uid || !drink_id) {
            return res.status(400).json({ error: 'rfid_uid and drink_id required' });
        }

        const uid = normalizeUid(rfid_uid);

        // Get staff member
        const staffResult = await pool.query(
            `SELECT * FROM staff WHERE UPPER(rfid_uid) = $1 AND wristband_active = true`,
            [uid]
        );
        if (staffResult.rows.length === 0) {
            return res.status(404).json({ error: 'Staff wristband not found' });
        }
        const staff = staffResult.rows[0];

        // Check drink allowance
        const drinksRemaining = (staff.drink_allowance || 8) - (staff.drinks_used || 0);
        if (drinksRemaining <= 0) {
            return res.status(400).json({
                error: 'Staff drink allowance exhausted',
                drinks_used: staff.drinks_used,
                drink_allowance: staff.drink_allowance
            });
        }

        // Get drink info
        const drinkResult = await pool.query(
            'SELECT * FROM drinks WHERE id = $1 AND active = true',
            [drink_id]
        );
        if (drinkResult.rows.length === 0) {
            return res.status(404).json({ error: 'Drink not found' });
        }
        const drink = drinkResult.rows[0];

        if (drink.stock_remaining < 1) {
            return res.status(400).json({ error: 'Drink out of stock' });
        }

        // Deduct from drink allowance
        await pool.query(
            'UPDATE staff SET drinks_used = drinks_used + 1 WHERE id = $1',
            [staff.id]
        );

        // Deduct from inventory
        await pool.query(
            `UPDATE drinks SET stock_remaining = stock_remaining - 1,
             total_sold = total_sold + 1 WHERE id = $1`,
            [drink_id]
        );

        // Log the drink
        const logId = `sdlog_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await pool.query(
            `INSERT INTO staff_drink_log (id, staff_id, rfid_uid, drink_name, location, created_at)
             VALUES ($1, $2, $3, $4, 'bar', NOW())`,
            [logId, staff.id, uid, drink.name]
        );

        console.log(`✓ Staff drink: ${drink.name} → ${staff.name} (${drinksRemaining - 1} remaining)`);
        res.json({
            success: true,
            drink: drink.name,
            staff_name: staff.name,
            drinks_remaining: drinksRemaining - 1
        });
    } catch (error) {
        console.error('Staff serve drink error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// POST /api/staff-wristband/log-access
// Log door/area access event
// ============================================
router.post('/log-access', async (req, res) => {
    try {
        const { rfid_uid, location, access_type } = req.body;
        if (!rfid_uid || !location) {
            return res.status(400).json({ error: 'rfid_uid and location required' });
        }

        const uid = normalizeUid(rfid_uid);

        // Look up staff
        const staffResult = await pool.query(
            `SELECT id, name, roles FROM staff WHERE UPPER(rfid_uid) = $1 AND wristband_active = true`,
            [uid]
        );

        const granted = staffResult.rows.length > 0;
        const staff = granted ? staffResult.rows[0] : null;

        // Log the access attempt
        const logId = `access_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await pool.query(
            `INSERT INTO staff_access_log (id, staff_id, rfid_uid, location, access_type, granted, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [logId, staff?.id || null, uid, location, access_type || 'door', granted]
        );

        if (!granted) {
            return res.status(403).json({ error: 'Access denied', granted: false });
        }

        console.log(`✓ Access: ${staff.name} → ${location}`);
        res.json({
            success: true,
            granted: true,
            staff_name: staff.name,
            roles: staff.roles,
            location
        });
    } catch (error) {
        console.error('Access log error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// PUT /api/staff-wristband/allowance
// Update drink allowance for a staff member
// ============================================
router.put('/allowance', authenticateToken, async (req, res) => {
    try {
        const { staff_id, drink_allowance } = req.body;
        if (!staff_id || drink_allowance === undefined) {
            return res.status(400).json({ error: 'staff_id and drink_allowance required' });
        }

        const result = await pool.query(
            `UPDATE staff SET drink_allowance = $1 WHERE id = $2
             RETURNING id, name, drink_allowance, drinks_used`,
            [drink_allowance, staff_id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Staff member not found' });
        }

        console.log(`✓ Drink allowance updated: ${result.rows[0].name} → ${drink_allowance}`);
        res.json({ success: true, staff: result.rows[0] });
    } catch (error) {
        console.error('Allowance update error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// GET /api/staff-wristband/access-log/:staffId
// Get access log for a staff member
// ============================================
router.get('/access-log/:staffId', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT sal.*, s.name as staff_name
             FROM staff_access_log sal
             LEFT JOIN staff s ON sal.staff_id = s.id
             WHERE sal.staff_id = $1
             ORDER BY sal.created_at DESC
             LIMIT 100`,
            [req.params.staffId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Access log fetch error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
