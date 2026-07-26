const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET;

// ── Resend email helper ──
const RESEND_API_URL = 'https://api.resend.com/emails';
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;h
  if (!apiKey) {
    console.error('X RESEND_API_KEY not set');
    throw new Error('Email service not configured');
  }
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to: [to], subject, html })
  });
  const data = await response.json();
  if (!response.ok) {
    console.error('Email send failed:', data);
    throw new Error(data.message || 'Failed to send email');
  }
  return data;
}

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

    // If no password_hash yet, check against default password directly.
    //
    // KNOWN SECURITY DEBT: as of 2026-04-26, 79 volunteer staff accounts
    // have NULL password_hash and rely on this 'rodeo2026' fallback.
    // Volunteers haven't started using the system yet (login window opens
    // ~2 weeks before the event), so the active risk is currently low —
    // BUT the fallback MUST be removed before volunteers start logging in.
    // Approach: send password-reset links to all 79 accounts ~2.5 weeks
    // before event start so each volunteer sets their own password.
    // Tracked: task #29.
    if (!staff.password_hash) {
      if (password !== 'rodeo2026') {
        return res.status(401).json({ error: 'Invalid password' });
      }
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
      { id: staff.id, email: staff.email, name: staff.fullname, roles: staff.roles || ['staff'] },
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

// POST /api/auth/staff-change-password
router.post('/staff-change-password', async (req, res) => {
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

// ══════════════════════════════════════════════════════════
// POST /api/auth/forgot-password
// Staff enters email → gets a reset link via email
// ══════════════════════════════════════════════════════════
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const result = await pool.query(
      'SELECT id, email, fullname FROM staff WHERE LOWER(email) = LOWER($1)',
      [email.trim()]
    );

    // Always return success even if not found (prevent email enumeration)
    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
    }

    const staff = result.rows[0];

    // Generate a short-lived reset token (15 min)
    const resetToken = jwt.sign(
      { id: staff.id, email: staff.email, purpose: 'password-reset' },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    const resetUrl = `https://staff.holmdalerodeo.ca/reset-password.html?token=${resetToken}`;

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 30px;">
        <h2 style="color: #00B74A; text-align: center;">🤠 Holmdale Pro Rodeo</h2>
        <h3 style="text-align: center; color: #333;">Password Reset Request</h3>
        <p>Hi <strong>${staff.fullname}</strong>,</p>
        <p>We received a request to reset your staff portal password. Click the button below to set a new password:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetUrl}" style="background: #00B74A; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">Reset Password</a>
        </div>
        <p style="color: #888; font-size: 13px;">This link expires in 15 minutes. If you didn't request this, you can safely ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="color: #aaa; font-size: 12px; text-align: center;">Holmdale Pro Rodeo • August 2026 • Walkerton, Ontario</p>
      </div>
    `;

    await sendEmail({
      to: staff.email,
      subject: 'Reset Your Holmdale Staff Password',
      html
    });

    console.log(`[auth] Password reset email sent to ${staff.email}`);
    res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });

  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ══════════════════════════════════════════════════════════
// POST /api/auth/reset-password-with-token
// Validates the token from the email link, sets new password
// ══════════════════════════════════════════════════════════
router.post('/reset-password-with-token', async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token and new password required' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Ensure this is a password-reset token
    if (decoded.purpose !== 'password-reset') {
      return res.status(400).json({ error: 'Invalid reset token' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    const result = await pool.query(
      'UPDATE staff SET password_hash = $1 WHERE id = $2 RETURNING email, fullname',
      [hash, decoded.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    console.log(`[auth] Password reset via email for ${result.rows[0].email}`);
    res.json({ success: true, message: 'Password has been reset. You can now log in.' });

  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(400).json({ error: 'Invalid reset link.' });
    }
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
