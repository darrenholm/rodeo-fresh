const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const pool = require('../config/database');
const router = express.Router();

// ╔══════════════════════════════════════════╗
// ║            SPONSORS CRUD                 ║
// ╚══════════════════════════════════════════╝

router.get('/sponsors', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sponsors ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error('GET /sponsors error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/sponsors/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sponsors WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sponsors', authenticateToken, async (req, res) => {
  try {
    const { name, contact_name, phone, email, city, province, address, postal_code, logo_url, notes } = req.body;
    const result = await pool.query(
      `INSERT INTO sponsors (name, contact_name, phone, email, city, province, address, postal_code, logo_url, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [name, contact_name, phone, email, city, province, address, postal_code, logo_url, notes]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('POST /sponsors error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/sponsors/:id', authenticateToken, async (req, res) => {
  try {
    const { name, contact_name, phone, email, city, province, address, postal_code, logo_url, notes } = req.body;
    const result = await pool.query(
      `UPDATE sponsors SET name=$1, contact_name=$2, phone=$3, email=$4, city=$5, province=$6,
       address=$7, postal_code=$8, logo_url=$9, notes=$10, updated_at=NOW()
       WHERE id=$11 RETURNING *`,
      [name, contact_name, phone, email, city, province, address, postal_code, logo_url, notes, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/sponsors/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM sponsor_schedule WHERE sponsor_id = $1', [req.params.id]);
    await pool.query('DELETE FROM sponsors WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ╔══════════════════════════════════════════╗
// ║          SPONSOR SCHEDULE                ║
// ╚══════════════════════════════════════════╝

router.get('/sponsor-schedule', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sponsor_schedule ORDER BY year DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/sponsor-schedule/:sponsorId', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sponsor_schedule WHERE sponsor_id = $1 ORDER BY year DESC',
      [req.params.sponsorId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/sponsor-schedule/:sponsorId', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { entries } = req.body;
    await client.query('BEGIN');
    await client.query('DELETE FROM sponsor_schedule WHERE sponsor_id = $1', [req.params.sponsorId]);
    for (const e of entries) {
      if (parseFloat(e.amount) > 0 || e.year) {
        await client.query(
          'INSERT INTO sponsor_schedule (sponsor_id, year, amount, paid) VALUES ($1,$2,$3,$4)',
          [req.params.sponsorId, e.year, parseFloat(e.amount) || 0, e.paid || false]
        );
      }
    }
    await client.query('COMMIT');
    const result = await pool.query(
      'SELECT * FROM sponsor_schedule WHERE sponsor_id = $1 ORDER BY year DESC',
      [req.params.sponsorId]
    );
    res.json(result.rows);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ╔══════════════════════════════════════════╗
// ║            VENDORS CRUD                  ║
// ╚══════════════════════════════════════════╝

router.get('/vendors', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vendors ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/vendors', authenticateToken, async (req, res) => {
  try {
    const { name, contact_name, phone, email, city, province, address, postal_code, product, booth_size, comment } = req.body;
    const result = await pool.query(
      `INSERT INTO vendors (name, contact_name, phone, email, city, province, address, postal_code, product, booth_size, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [name, contact_name, phone, email, city, province, address, postal_code, product, booth_size, comment]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/vendors/:id', authenticateToken, async (req, res) => {
  try {
    const { name, contact_name, phone, email, city, province, address, postal_code, product, booth_size, comment } = req.body;
    const result = await pool.query(
      `UPDATE vendors SET name=$1, contact_name=$2, phone=$3, email=$4, city=$5, province=$6,
       address=$7, postal_code=$8, product=$9, booth_size=$10, comment=$11, updated_at=NOW()
       WHERE id=$12 RETURNING *`,
      [name, contact_name, phone, email, city, province, address, postal_code, product, booth_size, comment, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/vendors/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM vendor_schedule WHERE vendor_id = $1', [req.params.id]);
    await pool.query('DELETE FROM vendors WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ╔══════════════════════════════════════════╗
// ║          VENDOR SCHEDULE                 ║
// ╚══════════════════════════════════════════╝

router.get('/vendor-schedule', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vendor_schedule ORDER BY year DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/vendor-schedule/:vendorId', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { entries } = req.body;
    await client.query('BEGIN');
    await client.query('DELETE FROM vendor_schedule WHERE vendor_id = $1', [req.params.vendorId]);
    for (const e of entries) {
      if (parseFloat(e.amount) > 0 || e.year) {
        await client.query(
          'INSERT INTO vendor_schedule (vendor_id, year, amount, paid) VALUES ($1,$2,$3,$4)',
          [req.params.vendorId, e.year, parseFloat(e.amount) || 0, e.paid || false]
        );
      }
    }
    await client.query('COMMIT');
    const result = await pool.query(
      'SELECT * FROM vendor_schedule WHERE vendor_id = $1 ORDER BY year DESC',
      [req.params.vendorId]
    );
    res.json(result.rows);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ╔══════════════════════════════════════════╗
// ║         SIGN LOCATIONS CRUD              ║
// ╚══════════════════════════════════════════╝

router.get('/sign-locations', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sign_locations ORDER BY location');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sign-locations', authenticateToken, async (req, res) => {
  try {
    const { location, cross_street, installed, install_date, removed } = req.body;
    const result = await pool.query(
      `INSERT INTO sign_locations (location, cross_street, installed, install_date, removed)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [location, cross_street, installed || false, install_date || null, removed || false]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/sign-locations/:id', authenticateToken, async (req, res) => {
  try {
    const { location, cross_street, installed, install_date, removed } = req.body;
    const result = await pool.query(
      `UPDATE sign_locations SET location=$1, cross_street=$2, installed=$3, install_date=$4, removed=$5
       WHERE id=$6 RETURNING *`,
      [location, cross_street, installed || false, install_date || null, removed || false, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/sign-locations/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM sign_locations WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ╔══════════════════════════════════════════╗
// ║      PUBLIC VENDOR REGISTRATION          ║
// ╚══════════════════════════════════════════╝

router.post('/vendors/register', async (req, res) => {
  try {
    const {
      name, contact_name, phone, email, city, province,
      address, postal_code, product, booth_size, vendor_type, comment, payment_method
    } = req.body;

    if (!name || !contact_name || !email || !phone) {
      return res.status(400).json({ error: 'Business name, contact name, email, and phone are required' });
    }

    // Check for duplicate — allow retry if not yet paid
    const existing = await pool.query(
      'SELECT id, payment_status FROM vendors WHERE email = $1 AND name = $2',
      [email, name]
    );

    if (existing.rows.length > 0) {
      const v = existing.rows[0];
      if (v.payment_status === 'paid') {
        return res.status(409).json({ error: 'This business has already registered and paid' });
      }
      // Not yet paid — return existing record so payment can be retried
      const confirmation_code = `VND-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;
      console.log(`Returning existing unpaid vendor: ${name} (${v.id})`);
      return res.json({ success: true, vendor: v, id: v.id, confirmation_code });
    }

    const result = await pool.query(
      `INSERT INTO vendors (name, contact_name, phone, email, city, province, address, postal_code, product, booth_size, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        name, contact_name, phone, email, city, province,
        address || '', postal_code || '', product || '', booth_size || '',
        `Type: ${vendor_type || 'not specified'}. Payment: ${payment_method || 'pay later'}. ${comment || ''}`
      ]
    );

    const vendor = result.rows[0];
    const confirmation_code = `VND-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;

    // Send confirmation email to vendor
    try {
      const apiKey = process.env.RESEND_API_KEY;
      const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

      if (apiKey) {
        const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:Arial,sans-serif;">
<div style="max-width:500px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
<div style="background:#1c1917;padding:24px;text-align:center;">
<h1 style="margin:0;color:#facc15;font-size:24px;letter-spacing:2px;">🤠 HOLMDALE PRO RODEO</h1>
<p style="margin:8px 0 0;color:#a8a29e;font-size:14px;">Vendor Registration Confirmed</p>
</div>
<div style="padding:24px;">
<h2 style="margin:0 0 16px;color:#1c1917;font-size:20px;">Welcome, ${contact_name}!</h2>
<p style="color:#44403c;font-size:14px;line-height:1.6;">Thank you for registering <strong>${name}</strong> as a vendor for the Holmdale Pro Rodeo.</p>
<div style="background:#f5f5f4;border-radius:10px;padding:16px;margin:16px 0;">
<table style="width:100%;font-size:14px;color:#44403c;">
<tr><td style="padding:4px 0;font-weight:bold;">Business</td><td>${name}</td></tr>
<tr><td style="padding:4px 0;font-weight:bold;">Contact</td><td>${contact_name}</td></tr>
<tr><td style="padding:4px 0;font-weight:bold;">Vendor Type</td><td>${vendor_type || 'Not specified'}</td></tr>
<tr><td style="padding:4px 0;font-weight:bold;">Booth Size</td><td>${booth_size || 'Not specified'}</td></tr>
<tr><td style="padding:4px 0;font-weight:bold;">Payment</td><td>${payment_method === 'pay_now' ? 'Paid online' : 'Invoice to follow'}</td></tr>
</table>
</div>
<p style="color:#44403c;font-size:14px;"><strong>Event Dates:</strong> July 31 - August 2, 2026<br><strong>Location:</strong> 588 Sideroad 10 S., Walkerton, ON</p>
</div>
<div style="background:#1c1917;padding:16px 24px;text-align:center;">
<p style="margin:0;color:#a8a29e;font-size:12px;">Questions? Email <a href="mailto:info@holmdalerodeo.ca" style="color:#facc15;">info@holmdalerodeo.ca</a></p>
</div>
</div>
</body></html>`;

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from, to: [email],
            subject: '🤠 Holmdale Pro Rodeo — Vendor Registration Confirmed', html
          })
        });

        // Notify admin
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from, to: ['darren@holmgraphics.ca'],
            subject: `📋 New Vendor Registration: ${name}`,
            html: `<h2>New Vendor Registration</h2>
<p><strong>${name}</strong> (${contact_name}) registered as a ${vendor_type} vendor.</p>
<p>Email: ${email} | Phone: ${phone}</p>
<p>Booth: ${booth_size} | Payment: ${payment_method}</p>
<p>Products: ${product || 'N/A'}</p>
<p>Notes: ${comment || 'None'}</p>`
          })
        });

        console.log(`✓ Vendor registration email sent to ${email}`);
      }
    } catch (emailErr) {
      console.error('Vendor email failed:', emailErr.message);
    }

    console.log(`✓ Vendor registered: ${name} (${contact_name})`);
    res.json({ success: true, vendor, id: vendor.id, confirmation_code });

  } catch (error) {
    console.error('Vendor registration error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
