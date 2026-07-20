const express = require('express');
const multer = require('multer');
const { put, del } = require('@vercel/blob');
const { authenticateToken, requireRole } = require('../middleware/auth');
const pool = require('../config/database');

const router = express.Router();

const MAX_BYTES = 25 * 1024 * 1024;
const VECTOR_EXTS = ['svg', 'eps', 'ai', 'pdf', 'cdr'];
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

// ─── GET /api/vendor-logos?vendor_id=X ───
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { vendor_id } = req.query;
    let result;
    if (vendor_id) {
      result = await pool.query(
        'SELECT * FROM vendor_logos WHERE vendor_id = $1 ORDER BY is_primary DESC, created_at DESC',
        [vendor_id]
      );
    } else {
      result = await pool.query(
        'SELECT * FROM vendor_logos ORDER BY vendor_id, is_primary DESC, created_at DESC'
      );
    }
    res.json(result.rows);
  } catch (err) {
    console.error('GET /vendor-logos error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/vendor-logos ───
// multipart/form-data: file=<upload>, vendor_id, format?, variant?, notes?
router.post(
  '/',
  authenticateToken,
  requireRole('admin', 'manager'),
  upload.single('file'),
  async (req, res) => {
    const client = await pool.connect();
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const vendorId = parseInt(req.body.vendor_id, 10);
      if (!vendorId) return res.status(400).json({ error: 'vendor_id required' });

      const vendor = await client.query('SELECT id FROM vendors WHERE id = $1', [vendorId]);
      if (vendor.rows.length === 0) return res.status(404).json({ error: 'Vendor not found' });

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
      const blobPath = `vendor-logos/${vendorId}/${Date.now()}-${safeName}`;

      const blob = await put(blobPath, req.file.buffer, {
        access: 'public',
        contentType: req.file.mimetype,
        addRandomSuffix: false
      });

      const existingCount = await client.query(
        'SELECT COUNT(*)::int AS n FROM vendor_logos WHERE vendor_id = $1',
        [vendorId]
      );
      const isPrimary = existingCount.rows[0].n === 0;

      const result = await client.query(
        `INSERT INTO vendor_logos
          (vendor_id, blob_url, filename, extension, format, variant, is_primary, size_bytes, notes, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          vendorId, blob.url, req.file.originalname, ext, format,
          variant, isPrimary, req.file.size, req.body.notes || null,
          req.user.userId || null
        ]
      );
      res.json(result.rows[0]);
    } catch (err) {
      console.error('POST /vendor-logos error:', err);
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  }
);

// ─── PUT /api/vendor-logos/:id ───
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
      `UPDATE vendor_logos
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
    console.error('PUT /vendor-logos/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/vendor-logos/:id/primary ───
router.put('/:id/primary', authenticateToken, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const logo = await client.query('SELECT vendor_id FROM vendor_logos WHERE id = $1', [req.params.id]);
    if (logo.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    const vendorId = logo.rows[0].vendor_id;
    await client.query(
      'UPDATE vendor_logos SET is_primary = false, updated_at = NOW() WHERE vendor_id = $1 AND is_primary = true',
      [vendorId]
    );
    const result = await client.query(
      'UPDATE vendor_logos SET is_primary = true, updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /vendor-logos/:id/primary error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── DELETE /api/vendor-logos/:id ───
router.delete('/:id', authenticateToken, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const found = await pool.query('SELECT blob_url FROM vendor_logos WHERE id = $1', [req.params.id]);
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
      console.warn('Vercel Blob already gone for vendor_logo', req.params.id, '- proceeding with DB delete');
    }

    await pool.query('DELETE FROM vendor_logos WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /vendor-logos/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

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
