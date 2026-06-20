const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { put } = require('@vercel/blob');
const pool = require('../config/database');

const router = express.Router();

// ============================================================
//  SPONSOR LOGO / WEBSITE INTAKE  (token link, no login)
//
//  Each sponsor is emailed a unique link containing a random token:
//    https://staff.holmdalerodeo.ca/sponsor-logos.html?token=<raw>
//  The token's sha256 is stored in sponsors.intake_token_hash with an
//  expiry. Every endpoint here re-validates the token on each call, so the
//  link itself IS the credential — it only ever exposes/edits that one
//  sponsor's logos + website (all low-sensitivity, public-facing data).
//
//  Unlike the guest portal (sponsors-portal.js, magic-link → JWT session),
//  this token is long-lived and reusable so a sponsor can come back to it
//  over the weeks before the event. Tokens are minted by
//  scripts/send-logo-intake.js when the email goes out.
// ============================================================

const MAX_BYTES = 25 * 1024 * 1024;
const VECTOR_EXTS = ['svg', 'eps', 'ai', 'pdf', 'cdr'];
const BITMAP_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff'];

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function extOf(filename) {
  const m = (filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}
function suggestFormat(ext) {
  if (VECTOR_EXTS.includes(ext)) return 'vector';
  if (BITMAP_EXTS.includes(ext)) return 'bitmap';
  return null;
}
function safeFilename(name) {
  return (name || 'logo').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

// Resolve ?token= (or body.token) to a sponsor, or 401. Attaches req.sponsorId.
async function tokenAuth(req, res, next) {
  try {
    const token = (req.query.token || req.body.token || '').trim();
    if (!token) return res.status(401).json({ error: 'Missing access link token' });
    const r = await pool.query(
      `SELECT id FROM sponsors
        WHERE intake_token_hash = $1 AND intake_token_exp > NOW() AND active IS NOT FALSE
        LIMIT 1`,
      [sha256(token)]
    );
    if (!r.rows.length) {
      return res.status(401).json({ error: 'This link is invalid or has expired. Please contact info@holmdalerodeo.ca.' });
    }
    req.sponsorId = r.rows[0].id;
    next();
  } catch (err) {
    console.error('sponsor-intake tokenAuth error:', err);
    res.status(500).json({ error: err.message });
  }
}

// What the sponsor sees: their record + every logo we hold.
async function sponsorPayload(sponsorId) {
  const s = await pool.query(
    'SELECT id, name, contact_name, website FROM sponsors WHERE id = $1',
    [sponsorId]
  );
  const logos = await pool.query(
    `SELECT id, blob_url, preview_url, filename, extension, format, variant, is_primary, created_at
       FROM sponsor_logos WHERE sponsor_id = $1
      ORDER BY format, is_primary DESC, created_at DESC`,
    [sponsorId]
  );
  return { sponsor: s.rows[0], logos: logos.rows };
}

// ─── GET /api/sponsor-intake?token= — current logos + website ───
router.get('/', tokenAuth, async (req, res) => {
  try {
    res.json(await sponsorPayload(req.sponsorId));
  } catch (err) {
    console.error('GET /sponsor-intake error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/sponsor-intake/website?token= — confirm/update website ───
router.put('/website', tokenAuth, async (req, res) => {
  try {
    let website = (req.body.website || '').trim();
    if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
    await pool.query(
      'UPDATE sponsors SET website = $1, updated_at = NOW() WHERE id = $2',
      [website || null, req.sponsorId]
    );
    res.json({ success: true, website: website || null });
  } catch (err) {
    console.error('PUT /sponsor-intake/website error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sponsor-intake/logo?token= — upload a new logo file ───
router.post('/logo', tokenAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = extOf(req.file.originalname);
    const format = suggestFormat(ext);
    if (!format) {
      return res.status(400).json({ error: `Unsupported file type ".${ext}". Please upload a PNG, JPG, SVG, PDF, AI, EPS, or CDR.` });
    }

    const safeName = safeFilename(req.file.originalname);
    const blobPath = `sponsor-logos/${req.sponsorId}/${Date.now()}-${safeName}`;
    const blob = await put(blobPath, req.file.buffer, {
      access: 'public',
      contentType: req.file.mimetype,
      addRandomSuffix: false,
    });

    // First logo of its kind becomes primary for that sponsor.
    const existing = await pool.query(
      'SELECT COUNT(*)::int AS n FROM sponsor_logos WHERE sponsor_id = $1',
      [req.sponsorId]
    );
    const isPrimary = existing.rows[0].n === 0;

    await pool.query(
      `INSERT INTO sponsor_logos
         (sponsor_id, blob_url, filename, extension, format, is_primary, size_bytes, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.sponsorId, blob.url, req.file.originalname, ext, format, isPrimary, req.file.size,
       'Uploaded by sponsor via logo intake link']
    );

    res.json({ success: true, ...(await sponsorPayload(req.sponsorId)) });
  } catch (err) {
    console.error('POST /sponsor-intake/logo error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Multer error handler (file too large, etc.) — must be last on this router.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File exceeds ${MAX_BYTES / (1024 * 1024)} MB limit` });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;
