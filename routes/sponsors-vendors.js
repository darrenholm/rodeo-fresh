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
      `UPDATE sponsors SET name=$1, contact_name=$2, phone=$3, email=$4, city=$5, province=$6, address=$7, postal_code=$8, logo_url=$9, notes=$10, updated_at=NOW()
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
    const result = await pool.query('SELECT * FROM sponsor_schedule WHERE sponsor_id = $1 ORDER BY year DESC', [req.params.sponsorId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Replace all schedule entries for a sponsor
router.put('/sponsor-schedule/:sponsorId', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { entries } = req.body; // [{ year, amount, paid }]
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
    const result = await pool.query('SELECT * FROM sponsor_schedule WHERE sponsor_id = $1 ORDER BY year DESC', [req.params.sponsorId]);
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
      `UPDATE vendors SET name=$1, contact_name=$2, phone=$3, email=$4, city=$5, province=$6, address=$7, postal_code=$8, product=$9, booth_size=$10, comment=$11, updated_at=NOW()
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
    const result = await pool.query('SELECT * FROM vendor_schedule WHERE vendor_id = $1 ORDER BY year DESC', [req.params.vendorId]);
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

module.exports = router;
