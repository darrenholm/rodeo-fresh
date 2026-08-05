/**
 * routes/photos.js — Holmdale Pro Rodeo photo library.
 *
 * Two audiences:
 *   1. The public. Browses approved web-sized photos on holmdalerodeo.ca and can
 *      submit their own shots. Public submissions land in a moderation queue and
 *      carry a recorded licence grant.
 *   2. Staff. See everything including pending submissions, moderate, organise
 *      into albums, and pull the full-resolution originals for marketing work.
 *
 * Upload flow (both audiences):
 *   1. Browser resizes the photo locally into a web copy and a thumbnail, and
 *      reads the EXIF capture date.
 *   2. POST .../upload-init  → server creates the DB row and hands back three
 *      presigned PUT URLs (original, web, thumb).
 *   3. Browser PUTs all three straight to R2. Bytes never touch Railway.
 *   4. POST .../:id/complete → server HEADs the keys to confirm they landed and
 *      flips upload_complete.
 *
 * The alternative — POSTing files through Express — means holding 40 MB buffers
 * in Railway memory and paying egress to hand them to R2. Presigning avoids
 * both, at the cost of the two-step handshake above.
 */

const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');
const sharp = require('sharp');
const { authenticateToken, requireRole } = require('../middleware/auth');
const pool = require('../config/database');
const r2 = require('../lib/r2');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
//  Limits & vocabulary
// ─────────────────────────────────────────────────────────────

const MAX_PUBLIC_BYTES = 60 * 1024 * 1024;   // one phone/DSLR frame, generously
const MAX_STAFF_BYTES = 250 * 1024 * 1024;   // room for full-frame TIFF exports

const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'image/heic', 'image/heif', 'image/avif', 'image/tiff'
]);

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif', 'image/tiff': 'tif'
};

const STATUSES = ['pending', 'approved', 'rejected'];

// The exact wording a public uploader agrees to. Stored per-photo at submission
// time so rewording this string later can't change what past uploaders agreed to.
const CONSENT_TEXT =
  'I took this photo (or have the right to share it) and I give Holmdale Pro Rodeo ' +
  'permission to use it in their marketing, website, social media and promotional ' +
  'materials, with credit where practical.';

// Derivative sizes. Must match the values the browser resizes to — the server
// only regenerates at these sizes when the client-side path failed.
const WEB_MAX_EDGE = 2048;
const THUMB_MAX_EDGE = 500;

// ─────────────────────────────────────────────────────────────
//  Anonymous-upload rate limiting
//
//  In-memory, per-IP. rodeo-fresh runs as a single Railway instance, so a shared
//  store would be ceremony without benefit. If it ever scales horizontally this
//  becomes per-instance (i.e. the effective limit multiplies by instance count),
//  which is a degradation, not a hole — the moderation queue is the real
//  backstop against junk reaching the site.
// ─────────────────────────────────────────────────────────────

const RATE_LIMIT = { windowMs: 60 * 60 * 1000, max: 60 };
const rateBuckets = new Map();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function checkRate(req, res) {
  const ip = clientIp(req);
  const now = Date.now();
  const bucket = rateBuckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
    return true;
  }
  if (bucket.count >= RATE_LIMIT.max) {
    const mins = Math.ceil((bucket.resetAt - now) / 60000);
    res.status(429).json({
      error: `Upload limit reached. Please try again in about ${mins} minute${mins === 1 ? '' : 's'}.`
    });
    return false;
  }
  bucket.count++;
  return true;
}

// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) if (now > b.resetAt) rateBuckets.delete(ip);
}, 15 * 60 * 1000).unref();

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'album';
}

/** Shape a DB row for the public gallery — derivatives only, never the original. */
function publicShape(row) {
  return {
    id: row.id,
    caption: row.caption,
    credit: row.credit,
    tags: row.tags || [],
    featured: row.featured,
    width: row.width,
    height: row.height,
    taken_at: row.taken_at,
    created_at: row.created_at,
    album_id: row.album_id,
    album_name: row.album_name || null,
    album_slug: row.album_slug || null,
    thumb_url: r2.publicUrl(row.thumb_key),
    web_url: r2.publicUrl(row.web_key)
  };
}

/** Shape a DB row for staff — everything, plus the moderation fields. */
function staffShape(row) {
  return {
    ...publicShape(row),
    status: row.status,
    source: row.source,
    original_filename: row.original_filename,
    original_bytes: row.original_bytes == null ? null : Number(row.original_bytes),
    content_type: row.content_type,
    has_original: Boolean(row.original_key),
    // Derivatives missing means the browser-side resize failed; the admin UI
    // offers a Reprocess button that regenerates them with sharp.
    needs_processing: Boolean(row.original_key) && !row.thumb_key,
    uploader_name: row.uploader_name,
    uploader_email: row.uploader_email,
    consent: row.consent,
    consent_at: row.consent_at,
    upload_complete: row.upload_complete,
    review_note: row.review_note,
    reviewed_at: row.reviewed_at
  };
}

/**
 * Validate the metadata a client sends to upload-init.
 * Returns { error } or { contentType, ext, bytes }.
 */
function validateUploadMeta(body, maxBytes) {
  const contentType = String(body.content_type || '').toLowerCase();
  if (!ALLOWED_TYPES.has(contentType)) {
    return { error: 'Unsupported file type. Please upload a JPEG, PNG, WEBP, HEIC or TIFF image.' };
  }
  const bytes = Number(body.size);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { error: 'Missing or invalid file size' };
  }
  if (bytes > maxBytes) {
    return { error: `File is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)` };
  }
  return { contentType, ext: EXT_BY_TYPE[contentType] || 'bin', bytes };
}

/**
 * Create the photo row and the three presigned PUT URLs.
 *
 * `derivatives: false` means the browser told us it couldn't produce a web copy
 * or thumbnail (HEIC on a browser that can't decode it, or an image too large
 * for the canvas). We still take the original and let the reprocess job build
 * the derivatives server-side.
 */
async function createUpload({ body, source, status, userId, ip }, maxBytes) {
  const meta = validateUploadMeta(body, maxBytes);
  if (meta.error) return { error: meta.error, code: 400 };

  const id = crypto.randomUUID();
  const uploadToken = crypto.randomBytes(24).toString('hex');
  const wantDerivatives = body.derivatives !== false;

  const originalKey = `originals/${id}.${meta.ext}`;
  const webKey = wantDerivatives ? `web/${id}.jpg` : null;
  const thumbKey = wantDerivatives ? `thumb/${id}.jpg` : null;

  let albumId = body.album_id ? parseInt(body.album_id, 10) : null;
  if (albumId) {
    const album = await pool.query('SELECT id FROM photo_albums WHERE id = $1', [albumId]);
    if (album.rows.length === 0) albumId = null;
  }

  const takenAt = body.taken_at ? new Date(body.taken_at) : null;
  const validTakenAt = takenAt && !isNaN(takenAt.getTime()) ? takenAt : null;

  const consented = body.consent === true || body.consent === 'true';

  await pool.query(
    `INSERT INTO photos (
       id, album_id, status, source,
       original_key, original_filename, original_bytes, content_type,
       web_key, thumb_key, width, height, taken_at,
       caption, credit, tags,
       uploader_name, uploader_email,
       consent, consent_text, consent_ip, consent_at,
       uploaded_by, upload_token
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [
      id, albumId, status, source,
      originalKey, String(body.filename || '').slice(0, 300) || `photo.${meta.ext}`,
      meta.bytes, meta.contentType,
      webKey, thumbKey,
      body.width ? parseInt(body.width, 10) : null,
      body.height ? parseInt(body.height, 10) : null,
      validTakenAt,
      body.caption ? String(body.caption).slice(0, 2000) : null,
      body.credit ? String(body.credit).slice(0, 200) : null,
      Array.isArray(body.tags) ? body.tags.map(t => String(t).slice(0, 60)).slice(0, 20) : [],
      body.uploader_name ? String(body.uploader_name).slice(0, 160) : null,
      body.uploader_email ? String(body.uploader_email).slice(0, 200) : null,
      consented, consented ? CONSENT_TEXT : null, consented ? ip : null,
      consented ? new Date() : null,
      userId || null, uploadToken
    ]
  );

  const uploads = {
    original: {
      key: originalKey,
      url: await r2.presignPut(r2.BUCKET_ORIGINALS, originalKey, meta.contentType),
      content_type: meta.contentType
    }
  };
  if (wantDerivatives) {
    uploads.web = {
      key: webKey,
      url: await r2.presignPut(r2.BUCKET_PUBLIC, webKey, 'image/jpeg'),
      content_type: 'image/jpeg'
    };
    uploads.thumb = {
      key: thumbKey,
      url: await r2.presignPut(r2.BUCKET_PUBLIC, thumbKey, 'image/jpeg'),
      content_type: 'image/jpeg'
    };
  }

  return { id, upload_token: uploadToken, uploads };
}

/**
 * Confirm the browser's PUTs landed, then mark the row complete.
 *
 * We HEAD the original rather than trust the client: without this a caller could
 * call /complete without uploading anything and put a permanently broken tile in
 * the gallery.
 */
async function finalizeUpload(id) {
  const found = await pool.query('SELECT * FROM photos WHERE id = $1', [id]);
  if (found.rows.length === 0) return { error: 'Photo not found', code: 404 };
  const photo = found.rows[0];

  const originalBytes = await r2.objectSize(r2.BUCKET_ORIGINALS, photo.original_key);
  if (originalBytes === null) {
    return { error: 'Upload did not complete — the original file is not in storage', code: 409 };
  }

  // Derivatives are optional; if either is missing the reprocess job below
  // rebuilds them, so a failed thumbnail PUT doesn't lose the photo.
  let webKey = photo.web_key;
  let thumbKey = photo.thumb_key;
  if (webKey && !(await r2.objectExists(r2.BUCKET_PUBLIC, webKey))) webKey = null;
  if (thumbKey && !(await r2.objectExists(r2.BUCKET_PUBLIC, thumbKey))) thumbKey = null;

  const result = await pool.query(
    `UPDATE photos
        SET upload_complete = true,
            original_bytes  = $1,
            web_key         = $2,
            thumb_key       = $3,
            upload_token    = NULL,
            updated_at      = NOW()
      WHERE id = $4
      RETURNING *`,
    [originalBytes, webKey, thumbKey, id]
  );

  if (!thumbKey || !webKey) {
    // Fire-and-forget: the uploader shouldn't wait on a server-side resize.
    reprocessPhoto(id).catch(err =>
      console.error('Photo reprocess failed for', id, '-', err.message));
  }

  return { photo: result.rows[0] };
}

/**
 * Server-side derivative generation with sharp. The fallback path for photos the
 * browser couldn't resize (HEIC without decoder support, oversized canvas), and
 * the "Reprocess" button in the admin UI.
 */
async function reprocessPhoto(id) {
  const found = await pool.query('SELECT * FROM photos WHERE id = $1', [id]);
  if (found.rows.length === 0) throw new Error('Photo not found');
  const photo = found.rows[0];
  if (!photo.original_key) throw new Error('Photo has no original to process');

  const buf = await r2.getObjectBuffer(r2.BUCKET_ORIGINALS, photo.original_key);
  const meta = await sharp(buf).metadata();

  // EXIF orientation reports the sensor's dimensions; .rotate() below applies the
  // orientation, so for a quarter-turn the stored width/height must be swapped to
  // match what viewers actually see.
  const rotated = meta.orientation >= 5 && meta.orientation <= 8;
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;

  const webKey = `web/${id}.jpg`;
  const thumbKey = `thumb/${id}.jpg`;

  const webBuf = await sharp(buf)
    .rotate()
    .resize(WEB_MAX_EDGE, WEB_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  const thumbBuf = await sharp(buf)
    .rotate()
    .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75, mozjpeg: true })
    .toBuffer();

  await r2.putObject(r2.BUCKET_PUBLIC, webKey, webBuf, 'image/jpeg');
  await r2.putObject(r2.BUCKET_PUBLIC, thumbKey, thumbBuf, 'image/jpeg');

  const result = await pool.query(
    `UPDATE photos
        SET web_key = $1, thumb_key = $2,
            width    = COALESCE($3, width),
            height   = COALESCE($4, height),
            updated_at = NOW()
      WHERE id = $5 RETURNING *`,
    [webKey, thumbKey, width || null, height || null, id]
  );
  return result.rows[0];
}

// ═════════════════════════════════════════════════════════════
//  PUBLIC ROUTES — no authentication
//
//  Registered before the /:id routes below so "public" and "albums" are never
//  swallowed by the id parameter.
// ═════════════════════════════════════════════════════════════

// ─── GET /api/photos/public ─── approved gallery
router.get('/public', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 60, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const where = [
      `p.status = 'approved'`,
      `p.upload_complete = true`,
      `p.thumb_key IS NOT NULL`,
      `(a.id IS NULL OR a.is_public = true)`
    ];
    const params = [];

    if (req.query.album) {
      params.push(req.query.album);
      where.push(`(a.slug = $${params.length} OR a.id::text = $${params.length})`);
    }
    if (req.query.tag) {
      params.push(req.query.tag);
      where.push(`$${params.length} = ANY(p.tags)`);
    }
    if (req.query.featured === 'true') {
      where.push(`p.featured = true`);
    }

    const base = `FROM photos p LEFT JOIN photo_albums a ON a.id = p.album_id WHERE ${where.join(' AND ')}`;

    const countResult = await pool.query(`SELECT COUNT(*)::int AS n ${base}`, params);

    params.push(limit, offset);
    const result = await pool.query(
      `SELECT p.*, a.name AS album_name, a.slug AS album_slug ${base}
        ORDER BY p.featured DESC, COALESCE(p.taken_at, p.created_at) DESC, p.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      total: countResult.rows[0].n,
      limit,
      offset,
      photos: result.rows.map(publicShape)
    });
  } catch (err) {
    console.error('GET /photos/public error:', err);
    res.status(500).json({ error: 'Could not load photos' });
  }
});

// ─── GET /api/photos/public/albums ───
router.get('/public/albums', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.name, a.slug, a.year, a.description,
              COUNT(p.id)::int AS photo_count,
              (SELECT thumb_key FROM photos
                WHERE album_id = a.id AND status = 'approved'
                  AND upload_complete = true AND thumb_key IS NOT NULL
                ORDER BY featured DESC, COALESCE(taken_at, created_at) DESC LIMIT 1) AS cover_key
         FROM photo_albums a
         LEFT JOIN photos p
           ON p.album_id = a.id AND p.status = 'approved'
          AND p.upload_complete = true AND p.thumb_key IS NOT NULL
        WHERE a.is_public = true
        GROUP BY a.id
       HAVING COUNT(p.id) > 0
        ORDER BY a.sort_order, a.year DESC NULLS LAST, a.name`
    );
    res.json(result.rows.map(r => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      year: r.year,
      description: r.description,
      photo_count: r.photo_count,
      cover_url: r2.publicUrl(r.cover_key)
    })));
  } catch (err) {
    console.error('GET /photos/public/albums error:', err);
    res.status(500).json({ error: 'Could not load albums' });
  }
});

// ─── GET /api/photos/public/upload-info ───
// Lets the upload form show the current consent wording and album choices
// without hard-coding either into the deployed bundle.
router.get('/public/upload-info', async (req, res) => {
  try {
    const albums = await pool.query(
      `SELECT id, name, year FROM photo_albums
        WHERE is_public = true ORDER BY sort_order, year DESC NULLS LAST, name`
    );
    res.json({
      enabled: r2.isConfigured,
      consent_text: CONSENT_TEXT,
      max_bytes: MAX_PUBLIC_BYTES,
      accepted_types: [...ALLOWED_TYPES],
      albums: albums.rows
    });
  } catch (err) {
    console.error('GET /photos/public/upload-info error:', err);
    res.status(500).json({ error: 'Could not load upload settings' });
  }
});

// ─── POST /api/photos/public/upload-init ───
router.post('/public/upload-init', async (req, res) => {
  try {
    if (!r2.isConfigured) {
      return res.status(503).json({ error: 'Photo uploads are not available right now' });
    }
    if (!checkRate(req, res)) return;

    const name = String(req.body.uploader_name || '').trim();
    const email = String(req.body.uploader_email || '').trim();
    if (name.length < 2) return res.status(400).json({ error: 'Please enter your name' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    if (req.body.consent !== true && req.body.consent !== 'true') {
      return res.status(400).json({ error: 'Please tick the permission box to submit a photo' });
    }

    const out = await createUpload(
      {
        // Credit defaults to the uploader's name so approved public photos carry
        // an attribution without staff having to type one in.
        body: { ...req.body, credit: req.body.credit || name },
        source: 'public',
        status: 'pending',
        userId: null,
        ip: clientIp(req)
      },
      MAX_PUBLIC_BYTES
    );
    if (out.error) return res.status(out.code || 400).json({ error: out.error });
    res.json(out);
  } catch (err) {
    console.error('POST /photos/public/upload-init error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Could not start upload' });
  }
});

// ─── POST /api/photos/public/:id/complete ───
router.post('/public/:id/complete', async (req, res) => {
  try {
    const token = String(req.body.upload_token || '');
    const found = await pool.query(
      'SELECT upload_token, upload_complete FROM photos WHERE id = $1',
      [req.params.id]
    );
    if (found.rows.length === 0) return res.status(404).json({ error: 'Photo not found' });
    if (found.rows[0].upload_complete) return res.json({ success: true, already: true });

    const expected = found.rows[0].upload_token || '';
    // Constant-time compare; lengths must match first or timingSafeEqual throws.
    const ok = expected.length === token.length && expected.length > 0 &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
    if (!ok) return res.status(403).json({ error: 'Invalid upload token' });

    const out = await finalizeUpload(req.params.id);
    if (out.error) return res.status(out.code || 400).json({ error: out.error });
    res.json({ success: true, status: 'pending' });
  } catch (err) {
    console.error('POST /photos/public/:id/complete error:', err);
    res.status(500).json({ error: 'Could not finish upload' });
  }
});

// ═════════════════════════════════════════════════════════════
//  STAFF ROUTES — everything below requires a valid staff token
// ═════════════════════════════════════════════════════════════

router.use(authenticateToken);

// ─── GET /api/photos/stats ───
router.get('/stats', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending'  AND upload_complete)::int AS pending,
         COUNT(*) FILTER (WHERE status = 'approved' AND upload_complete)::int AS approved,
         COUNT(*) FILTER (WHERE status = 'rejected' AND upload_complete)::int AS rejected,
         COUNT(*) FILTER (WHERE upload_complete AND thumb_key IS NULL)::int   AS needs_processing,
         COALESCE(SUM(original_bytes) FILTER (WHERE upload_complete), 0)::bigint AS total_bytes
       FROM photos`
    );
    const row = result.rows[0];
    res.json({ ...row, total_bytes: Number(row.total_bytes) });
  } catch (err) {
    console.error('GET /photos/stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/photos/albums ─── all albums, including non-public ones
router.get('/albums', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*,
              COUNT(p.id)::int AS photo_count,
              COUNT(p.id) FILTER (WHERE p.status = 'pending')::int AS pending_count,
              (SELECT thumb_key FROM photos
                WHERE album_id = a.id AND thumb_key IS NOT NULL
                ORDER BY featured DESC, COALESCE(taken_at, created_at) DESC LIMIT 1) AS cover_key
         FROM photo_albums a
         LEFT JOIN photos p ON p.album_id = a.id AND p.upload_complete = true
        GROUP BY a.id
        ORDER BY a.sort_order, a.year DESC NULLS LAST, a.name`
    );
    res.json(result.rows.map(r => ({ ...r, cover_url: r2.publicUrl(r.cover_key) })));
  } catch (err) {
    console.error('GET /photos/albums error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/photos/albums ───
router.post('/albums', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Album name is required' });

    // Two albums may legitimately share a name across years ("Saturday Night"),
    // so collisions get a numeric suffix rather than an error.
    let slug = slugify(req.body.slug || name);
    const taken = await pool.query('SELECT slug FROM photo_albums WHERE slug LIKE $1', [`${slug}%`]);
    if (taken.rows.some(r => r.slug === slug)) {
      let n = 2;
      while (taken.rows.some(r => r.slug === `${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }

    const result = await pool.query(
      `INSERT INTO photo_albums (name, slug, year, description, is_public, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        name.slice(0, 160), slug,
        req.body.year ? parseInt(req.body.year, 10) : null,
        req.body.description || null,
        req.body.is_public !== false,
        parseInt(req.body.sort_order, 10) || 0
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('POST /photos/albums error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/photos/albums/:id ───
router.patch('/albums/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE photo_albums
          SET name        = COALESCE($1::varchar, name),
              year        = COALESCE($2::integer, year),
              description = COALESCE($3::text, description),
              is_public   = COALESCE($4::boolean, is_public),
              sort_order  = COALESCE($5::integer, sort_order),
              updated_at  = NOW()
        WHERE id = $6 RETURNING *`,
      [
        req.body.name ? String(req.body.name).slice(0, 160) : null,
        req.body.year === undefined ? null : parseInt(req.body.year, 10) || null,
        req.body.description === undefined ? null : req.body.description,
        req.body.is_public === undefined ? null : Boolean(req.body.is_public),
        req.body.sort_order === undefined ? null : parseInt(req.body.sort_order, 10),
        req.params.id
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Album not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /photos/albums/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/photos/albums/:id ───
// The album's photos survive; the FK is ON DELETE SET NULL so they fall back to
// "Unsorted" rather than being destroyed alongside the folder.
router.delete('/albums/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM photo_albums WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Album not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /photos/albums/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/photos ─── staff library, all statuses
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const where = ['p.upload_complete = true'];
    const params = [];

    if (req.query.status && STATUSES.includes(req.query.status)) {
      params.push(req.query.status);
      where.push(`p.status = $${params.length}`);
    }
    if (req.query.album === 'none') {
      where.push('p.album_id IS NULL');
    } else if (req.query.album) {
      params.push(req.query.album);
      where.push(`(a.slug = $${params.length} OR a.id::text = $${params.length})`);
    }
    if (req.query.source && ['public', 'staff'].includes(req.query.source)) {
      params.push(req.query.source);
      where.push(`p.source = $${params.length}`);
    }
    if (req.query.tag) {
      params.push(req.query.tag);
      where.push(`$${params.length} = ANY(p.tags)`);
    }
    if (req.query.needs_processing === 'true') {
      where.push('p.thumb_key IS NULL');
    }
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      const i = params.length;
      where.push(`(p.caption ILIKE $${i} OR p.credit ILIKE $${i}
                   OR p.uploader_name ILIKE $${i} OR p.original_filename ILIKE $${i})`);
    }

    const base = `FROM photos p LEFT JOIN photo_albums a ON a.id = p.album_id WHERE ${where.join(' AND ')}`;
    const countResult = await pool.query(`SELECT COUNT(*)::int AS n ${base}`, params);

    params.push(limit, offset);
    const result = await pool.query(
      `SELECT p.*, a.name AS album_name, a.slug AS album_slug ${base}
        ORDER BY COALESCE(p.taken_at, p.created_at) DESC, p.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      total: countResult.rows[0].n,
      limit,
      offset,
      photos: result.rows.map(staffShape)
    });
  } catch (err) {
    console.error('GET /photos error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/photos/upload-init ─── staff upload (auto-approved)
router.post('/upload-init', requireRole('admin', 'manager'), async (req, res) => {
  try {
    if (!r2.isConfigured) {
      return res.status(503).json({ error: 'Photo storage is not configured on this server' });
    }
    const out = await createUpload(
      {
        body: req.body,
        source: 'staff',
        // Staff uploads skip moderation — the person uploading is the person who
        // would otherwise approve it.
        status: req.body.status === 'pending' ? 'pending' : 'approved',
        userId: req.user.userId || null,
        ip: clientIp(req)
      },
      MAX_STAFF_BYTES
    );
    if (out.error) return res.status(out.code || 400).json({ error: out.error });
    res.json(out);
  } catch (err) {
    console.error('POST /photos/upload-init error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── POST /api/photos/:id/complete ─── staff
router.post('/:id/complete', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const out = await finalizeUpload(req.params.id);
    if (out.error) return res.status(out.code || 400).json({ error: out.error });
    res.json({ success: true, photo: staffShape(out.photo) });
  } catch (err) {
    console.error('POST /photos/:id/complete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/photos/:id/download ─── presigned URL for the full-res original
router.get('/:id/download', async (req, res) => {
  try {
    const found = await pool.query(
      'SELECT original_key, original_filename FROM photos WHERE id = $1',
      [req.params.id]
    );
    if (found.rows.length === 0 || !found.rows[0].original_key) {
      return res.status(404).json({ error: 'Original not found' });
    }
    const url = await r2.presignGet(found.rows[0].original_key, {
      expiresIn: 300,
      downloadAs: found.rows[0].original_filename
    });
    res.json({ url, expires_in: 300, filename: found.rows[0].original_filename });
  } catch (err) {
    console.error('GET /photos/:id/download error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── POST /api/photos/download-batch ─── presign several originals at once
router.post('/download-batch', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 100) : [];
    if (!ids.length) return res.status(400).json({ error: 'No photos selected' });

    const found = await pool.query(
      `SELECT id, original_key, original_filename FROM photos
        WHERE id = ANY($1::uuid[]) AND original_key IS NOT NULL`,
      [ids]
    );
    const files = [];
    for (const row of found.rows) {
      files.push({
        id: row.id,
        filename: row.original_filename,
        // 15 minutes: long enough for a browser to work through 100 sequential
        // downloads, short enough that a leaked link expires the same afternoon.
        url: await r2.presignGet(row.original_key, { expiresIn: 900, downloadAs: row.original_filename })
      });
    }
    res.json({ files });
  } catch (err) {
    console.error('POST /photos/download-batch error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── POST /api/photos/:id/reprocess ─── rebuild derivatives with sharp
router.post('/:id/reprocess', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const photo = await reprocessPhoto(req.params.id);
    res.json({ success: true, photo: staffShape(photo) });
  } catch (err) {
    console.error('POST /photos/:id/reprocess error:', err);
    res.status(500).json({ error: `Could not process this image: ${err.message}` });
  }
});

// ─── PATCH /api/photos/:id ─── moderation + metadata
router.patch('/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { status, caption, credit, tags, album_id, featured, review_note } = req.body;

    if (status !== undefined && !STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    }

    const reviewing = status !== undefined;
    const result = await pool.query(
      `UPDATE photos
          SET status      = COALESCE($1::varchar, status),
              caption     = COALESCE($2::text, caption),
              credit      = COALESCE($3::varchar, credit),
              tags        = COALESCE($4::text[], tags),
              album_id    = CASE WHEN $5::boolean THEN $6::integer ELSE album_id END,
              featured    = COALESCE($7::boolean, featured),
              review_note = COALESCE($8::text, review_note),
              reviewed_by = CASE WHEN $9::boolean THEN $10::integer ELSE reviewed_by END,
              reviewed_at = CASE WHEN $9::boolean THEN NOW() ELSE reviewed_at END,
              updated_at  = NOW()
        WHERE id = $11
        RETURNING *`,
      [
        status ?? null,
        caption === undefined ? null : String(caption).slice(0, 2000),
        credit === undefined ? null : String(credit).slice(0, 200),
        tags === undefined ? null : (Array.isArray(tags) ? tags.map(t => String(t).slice(0, 60)).slice(0, 20) : []),
        // album_id is sent explicitly as null to mean "unfile this photo", which
        // COALESCE can't distinguish from "field omitted" — hence the flag.
        album_id !== undefined,
        album_id === undefined || album_id === null ? null : parseInt(album_id, 10),
        featured === undefined ? null : Boolean(featured),
        review_note === undefined ? null : String(review_note).slice(0, 1000),
        reviewing,
        req.user.userId || null,
        req.params.id
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Photo not found' });
    res.json(staffShape(result.rows[0]));
  } catch (err) {
    console.error('PATCH /photos/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/photos/bulk ─── approve / reject / file / tag / delete many
router.post('/bulk', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 500) : [];
    const action = req.body.action;
    if (!ids.length) return res.status(400).json({ error: 'No photos selected' });

    if (action === 'approve' || action === 'reject') {
      const result = await pool.query(
        `UPDATE photos SET status = $1, reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
          WHERE id = ANY($3::uuid[]) RETURNING id`,
        [action === 'approve' ? 'approved' : 'rejected', req.user.userId || null, ids]
      );
      return res.json({ success: true, updated: result.rowCount });
    }

    if (action === 'move') {
      const albumId = req.body.album_id ? parseInt(req.body.album_id, 10) : null;
      const result = await pool.query(
        `UPDATE photos SET album_id = $1, updated_at = NOW() WHERE id = ANY($2::uuid[]) RETURNING id`,
        [albumId, ids]
      );
      return res.json({ success: true, updated: result.rowCount });
    }

    if (action === 'tag') {
      const tags = Array.isArray(req.body.tags)
        ? req.body.tags.map(t => String(t).slice(0, 60)).slice(0, 20) : [];
      if (!tags.length) return res.status(400).json({ error: 'No tags supplied' });
      // Union with what's already there so bulk-tagging never drops existing tags.
      const result = await pool.query(
        `UPDATE photos
            SET tags = ARRAY(SELECT DISTINCT unnest(tags || $1::text[])),
                updated_at = NOW()
          WHERE id = ANY($2::uuid[]) RETURNING id`,
        [tags, ids]
      );
      return res.json({ success: true, updated: result.rowCount });
    }

    if (action === 'delete') {
      const found = await pool.query(
        'SELECT id, original_key, web_key, thumb_key FROM photos WHERE id = ANY($1::uuid[])',
        [ids]
      );
      await r2.deletePhotoObjects(found.rows);
      const result = await pool.query('DELETE FROM photos WHERE id = ANY($1::uuid[]) RETURNING id', [ids]);
      return res.json({ success: true, deleted: result.rowCount });
    }

    res.status(400).json({ error: 'action must be approve, reject, move, tag or delete' });
  } catch (err) {
    console.error('POST /photos/bulk error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/photos/:id ───
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const found = await pool.query(
      'SELECT id, original_key, web_key, thumb_key FROM photos WHERE id = $1',
      [req.params.id]
    );
    if (found.rows.length === 0) return res.status(404).json({ error: 'Photo not found' });

    await r2.deletePhotoObjects(found.rows);
    await pool.query('DELETE FROM photos WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /photos/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  Housekeeping
//
//  upload-init writes a row before the browser uploads anything, so a closed tab
//  or a failed PUT leaves a row with upload_complete = false forever. Sweep them
//  nightly; two hours is far longer than any real upload takes.
// ─────────────────────────────────────────────────────────────

cron.schedule('20 4 * * *', async () => {
  try {
    const stale = await pool.query(
      `DELETE FROM photos
        WHERE upload_complete = false AND created_at < NOW() - INTERVAL '2 hours'
        RETURNING id, original_key, web_key, thumb_key`
    );
    if (stale.rowCount > 0) {
      // A PUT may have landed even though /complete never ran, so clear storage too.
      if (r2.isConfigured) await r2.deletePhotoObjects(stale.rows);
      console.log(`🧹 Photo library: cleared ${stale.rowCount} abandoned upload(s)`);
    }
  } catch (err) {
    console.error('Photo cleanup job failed:', err.message);
  }
});

module.exports = router;
