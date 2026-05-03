const express = require('express');
const multer = require('multer');
const { put, del } = require('@vercel/blob');
const { authenticateToken, requireRole } = require('../middleware/auth');
const pool = require('../config/database');

const router = express.Router();

const MAX_BYTES = 25 * 1024 * 1024;
const VECTOR_EXTS = ['svg', 'eps', 'ai', 'pdf'];
const BITMAP_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff'];
const VARIANTS = ['full-color', 'black', 'white', 'icon'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES }
});

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

// ─── GET /api/sponsor-logos?sponsor_id=X ───
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { sponsor_id } = req.query;
    let result;
    if (sponsor_id) {
      result = await pool.query(
        'SELECT * FROM sponsor_logos WHERE sponsor_id = $1 ORDER BY is_primary DESC, created_at DESC',
        [sponsor_id]
      );
    } else {
      result = await pool.query(
        'SELECT * FROM sponsor_logos ORDER BY sponsor_id, is_primary DESC, created_at DESC'
      );
    }
    res.json(result.rows);
  } catch (err) {
    console.error('GET /sponsor-logos error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sponsor-logos ───
// multipart/form-data: file=<upload>, sponsor_id, format?, variant?, notes?
router.post(
  '/',
  authenticateToken,
  requireRole('admin', 'manager'),
  upload.single('file'),
  async (req, res) => {
    const client = await pool.connect();
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const sponsorId = parseInt(req.body.sponsor_id, 10);
      if (!sponsorId) return res.status(400).json({ error: 'sponsor_id required' });

      const sponsor = await client.query('SELECT id FROM sponsors WHERE id = $1', [sponsorId]);
      if (sponsor.rows.length === 0) return res.status(404).json({ error: 'Sponsor not found' });

      const ext = extOf(req.file.originalname);
      const format = req.body.format || suggestFormat(ext);
      if (!['vector', 'bitmap'].includes(format)) {
        return res.status(400).json({ error: 'format must be vector or bitmap (or upload a recognized file extension)' });
      }

      const variant = req.body.variant || null;
      if (variant !== null && !VARIANTS.includes(variant)) {
        return res.status(400).json({ error: `variant must be one of: ${VARIANTS.join(', ')}` });
      }

      const safeName = safeFilename(req.file.originalname);
      const blobPath = `sponsor-logos/${sponsorId}/${Date.now()}-${safeName}`;

      const blob = await put(blobPath, req.file.buffer, {
        access: 'public',
        contentType: req.file.mimetype,
        addRandomSuffix: false
      });

      // First logo for this sponsor auto-becomes primary.
      const existingCount = await client.query(
        'SELECT COUNT(*)::int AS n FROM sponsor_logos WHERE sponsor_id = $1',
        [sponsorId]
      );
      const isPrimary = existingCount.rows[0].n === 0;

      const result = await client.query(
        `INSERT INTO sponsor_logos
          (sponsor_id, blob_url, filename, extension, format, variant, is_primary, size_bytes, notes, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          sponsorId, blob.url, req.file.originalname, ext, format,
          variant, isPrimary, req.file.size, req.body.notes || null,
          req.user.userId || null
        ]
      );
      res.json(result.rows[0]);
    } catch (err) {
      console.error('POST /sponsor-logos error:', err);
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  }
);

// ─── PUT /api/sponsor-logos/:id ───
// Updates metadata only (format, variant, notes). Use /:id/primary for primary toggle.
router.put('/:id', authenticateToken, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { format, variant, notes } = req.body;

    if (format !== undefined && !['vector', 'bitmap'].includes(format)) {
      return res.status(400).json({ error: 'format must be vector or bitmap' });
    }
    if (variant !== undefined && variant !== null && !VARIANTS.includes(variant)) {
      return res.status(400).json({ error: `variant must be one of: ${VARIANTS.join(', ')}` });
    }

    const result = await pool.query(
      `UPDATE sponsor_logos
         SET format     = COALESCE($1, format),
             variant    = $2,
             notes      = COALESCE($3, notes),
             updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [format ?? null, variant === undefined ? null : variant, notes ?? null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /sponsor-logos/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/sponsor-logos/:id/primary ───
router.put('/:id/primary', authenticateToken, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const logo = await client.query('SELECT sponsor_id FROM sponsor_logos WHERE id = $1', [req.params.id]);
    if (logo.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    const sponsorId = logo.rows[0].sponsor_id;
    await client.query(
      'UPDATE sponsor_logos SET is_primary = false, updated_at = NOW() WHERE sponsor_id = $1 AND is_primary = true',
      [sponsorId]
    );
    const result = await client.query(
      'UPDATE sponsor_logos SET is_primary = true, updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /sponsor-logos/:id/primary error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── DELETE /api/sponsor-logos/:id ───
router.delete('/:id', authenticateToken, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const found = await pool.query('SELECT blob_url FROM sponsor_logos WHERE id = $1', [req.params.id]);
    if (found.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    // Order matters: blob first, then DB row. If we deleted the DB row first
    // and the blob delete then failed, the blob would be orphaned with no
    // record pointing at it. Doing blob first means the worst case is a stale
    // DB row pointing at a missing blob — recoverable by retrying DELETE.
    // A "blob already gone" error (someone deleted it manually in Vercel's UI)
    // is treated as success so the DB row can still be cleaned up.
    try {
      await del(found.rows[0].blob_url);
    } catch (blobErr) {
      const msg = (blobErr && blobErr.message) || '';
      const isNotFound = blobErr?.status === 404 || /not.?found/i.test(msg);
      if (!isNotFound) {
        console.error('Vercel Blob delete failed:', msg);
        return res.status(502).json({ error: 'Failed to remove file from storage; logo not deleted' });
      }
      console.warn('Vercel Blob already gone for sponsor_logo', req.params.id, '- proceeding with DB delete');
    }

    await pool.query('DELETE FROM sponsor_logos WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /sponsor-logos/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Multer error handler (file too large, etc.) — must be last middleware on this router.
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
