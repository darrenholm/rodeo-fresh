const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { sendEmail } = require('./email');

// ============================================================
//  SPONSOR SELF-REGISTRATION PORTAL
//
//  Sponsors sign in with an emailed magic link (no password) and
//  pre-enter their own guest list ahead of the event, capped at
//  sponsors.max_guests and limited to the zones in
//  sponsors.allocated_zones. Staff finalize each guest at check-in
//  (badge-checkin.html) where the photo + NFC card are added and the
//  badge is printed.
//
//  Tokens here carry { sponsor_id, role:'sponsor', name } and are
//  verified by sponsorAuth() below — NOT the staff authenticateToken
//  middleware (which rejects role:'sponsor'), so a sponsor session can
//  never reach staff/admin endpoints.
// ============================================================

const PORTAL_URL = process.env.SPONSOR_PORTAL_URL || 'https://staff.holmdalerodeo.ca/sponsor-login.html';
const TOKEN_TTL_MIN = 30;   // magic-link validity
const SESSION_TTL = '12h';  // signed-in session

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Keep only requested zones the sponsor is actually allowed to grant.
function sanitizeZones(requested, allocated) {
  if (!Array.isArray(requested)) return [];
  const allowed = new Set(Array.isArray(allocated) ? allocated : []);
  return [...new Set(requested.filter((z) => allowed.has(z)))];
}

// Verify a sponsor session token (separate audience from staff tokens).
function sponsorAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Sign-in required' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Your session expired — please sign in again' });
    if (!user || user.role !== 'sponsor' || !user.sponsor_id) {
      return res.status(403).json({ error: 'Sponsor access required' });
    }
    req.user = user;
    next();
  });
}

function guestCols() {
  return 'id, name, title, email, requested_zones, status, badge_id, created_at';
}

function magicLinkHtml(sponsor, link) {
  const who = sponsor.contact_name ? sponsor.contact_name.split(/\s+/)[0] : (sponsor.name || 'there');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:Arial,sans-serif;">
<div style="max-width:500px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
  <div style="background:#1c1917;padding:24px;text-align:center;">
    <h1 style="margin:0;color:#facc15;font-size:24px;letter-spacing:2px;">🤠 HOLMDALE PRO RODEO</h1>
    <p style="margin:8px 0 0;color:#a8a29e;font-size:14px;">Sponsor Guest Registration</p>
  </div>
  <div style="padding:24px;">
    <p style="color:#44403c;font-size:14px;line-height:1.6;">Hi ${who},</p>
    <p style="color:#44403c;font-size:14px;line-height:1.6;">Click the button below to sign in and register your guests for the <strong>Holmdale Pro Rodeo</strong>. This link is good for ${TOKEN_TTL_MIN} minutes and can be used once.</p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${link}" style="display:inline-block;padding:16px 40px;background:#00B74A;color:white;font-size:18px;font-weight:bold;text-decoration:none;border-radius:10px;">Sign In &amp; Register Guests</a>
    </div>
    <p style="color:#78716c;font-size:13px;line-height:1.6;">If the button doesn't work, copy this link into your browser:<br><a href="${link}" style="color:#00B74A;word-break:break-all;">${link}</a></p>
    <p style="color:#78716c;font-size:13px;">Didn't request this? You can safely ignore this email.</p>
  </div>
  <div style="background:#1c1917;padding:16px 24px;text-align:center;">
    <p style="margin:0;color:#a8a29e;font-size:12px;">Holmdale Rodeo Grounds — Walkerton, Ontario<br>Questions? Contact us at info@holmdalerodeo.ca</p>
  </div>
</div>
</body></html>`;
}

// ─── POST /api/sponsor-portal/request-link  — email a magic sign-in link (public) ───
router.post('/request-link', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const result = await pool.query(
      `SELECT id, name, contact_name, email FROM sponsors
       WHERE LOWER(email) = $1 AND active = true AND portal_enabled = true
       ORDER BY id LIMIT 1`,
      [email]
    );
    const sponsor = result.rows[0];

    if (sponsor) {
      const raw = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `UPDATE sponsors SET login_token_hash = $1,
           login_token_exp = NOW() + INTERVAL '${TOKEN_TTL_MIN} minutes'
         WHERE id = $2`,
        [sha256(raw), sponsor.id]
      );
      const link = `${PORTAL_URL}?token=${raw}`;
      try {
        await sendEmail({
          to: sponsor.email,
          subject: '🤠 Sign in to register your Holmdale Rodeo guests',
          html: magicLinkHtml(sponsor, link),
        });
      } catch (e) {
        console.error('✗ Sponsor magic-link email failed:', e.message);
      }
    }

    // Always the same response — never reveal whether an email is registered.
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /sponsor-portal/request-link error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sponsor-portal/verify  — exchange a magic-link token for a session (public) ───
router.post('/verify', async (req, res) => {
  try {
    const token = (req.body.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const result = await pool.query(
      `SELECT id, name, contact_name FROM sponsors
       WHERE login_token_hash = $1 AND login_token_exp > NOW()
         AND active = true AND portal_enabled = true
       LIMIT 1`,
      [sha256(token)]
    );
    const sponsor = result.rows[0];
    if (!sponsor) {
      return res.status(401).json({ error: 'This sign-in link is invalid or has expired. Please request a new one.' });
    }

    // One-time use: burn the token now.
    await pool.query(
      'UPDATE sponsors SET login_token_hash = NULL, login_token_exp = NULL WHERE id = $1',
      [sponsor.id]
    );

    const sessionToken = jwt.sign(
      { sponsor_id: sponsor.id, role: 'sponsor', name: sponsor.name },
      process.env.JWT_SECRET,
      { expiresIn: SESSION_TTL }
    );
    res.json({
      success: true,
      token: sessionToken,
      sponsor: { id: sponsor.id, name: sponsor.name, contact_name: sponsor.contact_name },
    });
  } catch (err) {
    console.error('POST /sponsor-portal/verify error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sponsor-portal/me  — sponsor profile + allotment + zones ───
router.get('/me', sponsorAuth, async (req, res) => {
  try {
    const id = req.user.sponsor_id;
    const sr = await pool.query(
      'SELECT id, name, contact_name, email, max_guests, allocated_zones FROM sponsors WHERE id = $1',
      [id]
    );
    const s = sr.rows[0];
    if (!s) return res.status(404).json({ error: 'Sponsor not found' });

    const allocated = Array.isArray(s.allocated_zones) ? s.allocated_zones : [];
    let zones = [];
    if (allocated.length) {
      const zr = await pool.query(
        'SELECT key, label FROM access_zones WHERE key = ANY($1) AND active = true ORDER BY sort, key',
        [allocated]
      );
      zones = zr.rows;
    }
    const cr = await pool.query(
      `SELECT COUNT(*)::int AS n FROM sponsor_guests WHERE sponsor_id = $1 AND status <> 'cancelled'`,
      [id]
    );

    res.json({
      id: s.id, name: s.name, contact_name: s.contact_name, email: s.email,
      max_guests: s.max_guests, allocated_zones: allocated, zones,
      guest_count: cr.rows[0].n,
    });
  } catch (err) {
    console.error('GET /sponsor-portal/me error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sponsor-portal/guests  — this sponsor's guest list ───
router.get('/guests', sponsorAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${guestCols()} FROM sponsor_guests
       WHERE sponsor_id = $1 AND status <> 'cancelled'
       ORDER BY created_at`,
      [req.user.sponsor_id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('GET /sponsor-portal/guests error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sponsor-portal/guests  — add a guest (enforces the cap) ───
router.post('/guests', sponsorAuth, async (req, res) => {
  try {
    const id = req.user.sponsor_id;
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Guest name is required' });

    const sr = await pool.query('SELECT max_guests, allocated_zones FROM sponsors WHERE id = $1', [id]);
    const s = sr.rows[0];
    const cap = s.max_guests; // NULL = unset

    const cr = await pool.query(
      `SELECT COUNT(*)::int AS n FROM sponsor_guests WHERE sponsor_id = $1 AND status <> 'cancelled'`,
      [id]
    );
    if (cap != null && cr.rows[0].n >= cap) {
      return res.status(409).json({ error: `You have reached your guest limit of ${cap}.` });
    }

    const zones = sanitizeZones(req.body.requested_zones, s.allocated_zones);
    const ins = await pool.query(
      `INSERT INTO sponsor_guests (sponsor_id, name, title, email, requested_zones)
       VALUES ($1,$2,$3,$4,$5) RETURNING ${guestCols()}`,
      [id, name, (req.body.title || '').trim() || null, (req.body.email || '').trim() || null, JSON.stringify(zones)]
    );
    res.json({ success: true, guest: ins.rows[0] });
  } catch (err) {
    console.error('POST /sponsor-portal/guests error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/sponsor-portal/guests/:id  — edit a still-pending guest ───
router.put('/guests/:id', sponsorAuth, async (req, res) => {
  try {
    const id = req.user.sponsor_id;
    const ex = await pool.query('SELECT status, sponsor_id FROM sponsor_guests WHERE id = $1', [req.params.id]);
    const g = ex.rows[0];
    if (!g || g.sponsor_id !== id) return res.status(404).json({ error: 'Guest not found' });
    if (g.status !== 'pending') {
      return res.status(409).json({ error: 'This guest is already checked in and can no longer be edited.' });
    }

    const sr = await pool.query('SELECT allocated_zones FROM sponsors WHERE id = $1', [id]);
    const zonesParam = req.body.requested_zones !== undefined
      ? JSON.stringify(sanitizeZones(req.body.requested_zones, sr.rows[0].allocated_zones))
      : null;

    const upd = await pool.query(
      `UPDATE sponsor_guests SET
         name            = COALESCE($1, name),
         title           = $2,
         email           = $3,
         requested_zones = COALESCE($4::jsonb, requested_zones),
         updated_at      = NOW()
       WHERE id = $5 RETURNING ${guestCols()}`,
      [(req.body.name || '').trim() || null, (req.body.title || '').trim() || null,
       (req.body.email || '').trim() || null, zonesParam, req.params.id]
    );
    res.json({ success: true, guest: upd.rows[0] });
  } catch (err) {
    console.error('PUT /sponsor-portal/guests/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/sponsor-portal/guests/:id  — cancel a still-pending guest ───
router.delete('/guests/:id', sponsorAuth, async (req, res) => {
  try {
    const id = req.user.sponsor_id;
    const ex = await pool.query('SELECT status, sponsor_id FROM sponsor_guests WHERE id = $1', [req.params.id]);
    const g = ex.rows[0];
    if (!g || g.sponsor_id !== id) return res.status(404).json({ error: 'Guest not found' });
    if (g.status !== 'pending') {
      return res.status(409).json({ error: 'Checked-in guests cannot be removed.' });
    }
    await pool.query(`UPDATE sponsor_guests SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /sponsor-portal/guests/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
