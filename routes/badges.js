const express = require('express');
const router = express.Router();
const { put } = require('@vercel/blob');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// ============================================================
//  BADGES — VIP / Volunteer / Sponsor printed NFC name tags
//
//  A badge is a row in the `wristbands` table with badge_type set.
//  Because every consumer (bar /drinks/serve, food /wristbands/redeem,
//  balance checker /wristbands/balance) keys on rfid_uid + credits, a
//  badge behaves exactly like a wristband at those stations with NO
//  changes to them.
//
//  Perks (per Holmdale's rules):
//    - volunteer / lower sponsor → a set dollar credit balance
//    - VIP / top sponsor         → `unlimited` flag + a large sentinel
//                                   credit balance so every existing
//                                   credit-decrementing path serves them.
// ============================================================

const UNLIMITED_CREDITS = 100000;          // sentinel balance for unlimited badges
const BADGE_TYPES = ['vip', 'sponsor', 'volunteer'];

// Sponsorship $ → level key (matches the check-in level dropdown). Highest first.
const LEVEL_THRESHOLDS = [[10000,'title'],[6500,'platinum'],[5000,'gold'],[2500,'silver'],[1000,'bronze'],[500,'friend']];
function levelFromAmount(amt){
  amt = Number(amt) || 0;
  for (const [t, k] of LEVEL_THRESHOLDS) { if (amt >= t) return k; }
  return '';
}

// Match the normalization used by every other RFID route so a tag read by
// the check-in tablet resolves to the same UID at the bar/gate readers.
function normalizeUid(uid) {
  const cleaned = (uid || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  const bytes = cleaned.match(/.{2}/g);
  return bytes ? bytes.sort().join('') : cleaned;
}

function genId() {
  return `badge_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function actor(req) {
  return req.user?.email || req.user?.name || 'staff';
}

// Decode a data: URL (data:image/jpeg;base64,...) into { buffer, contentType, ext }.
function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) return null;
  const contentType = m[1];
  const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  return { buffer: Buffer.from(m[2], 'base64'), contentType, ext };
}

async function uploadPhoto(badgeId, dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) throw new Error('photo must be a base64 data URL');
  if (parsed.buffer.length > 4 * 1024 * 1024) throw new Error('photo exceeds 4 MB');
  const blob = await put(
    `badges/${badgeId}/${Date.now()}.${parsed.ext}`,
    parsed.buffer,
    { access: 'public', contentType: parsed.contentType, addRandomSuffix: false }
  );
  return blob.url;
}

// Normalize the credit/unlimited pair coming from the client.
function resolveCredits({ unlimited, credits }) {
  if (unlimited) return { unlimited: true, credits: UNLIMITED_CREDITS };
  const n = Math.max(0, Math.round((Number(credits) || 0) * 100) / 100);
  return { unlimited: false, credits: n };
}

const BADGE_COLUMNS = `id, rfid_uid, customer_name, customer_email, ticket_type,
  badge_type, tier, title, company, company_logo_url, photo_url, credits, credits_spent,
  alcohol_approved, unlimited, area_access, access_zones, badge_active, print_status,
  printed_at, created_date,
  GREATEST(credits - credits_spent, 0) AS remaining`;

// Keep only zone keys that exist and are active; de-dupe.
async function sanitizeZones(input) {
  if (!Array.isArray(input)) return [];
  const valid = await pool.query('SELECT key FROM access_zones WHERE active = true');
  const allowed = new Set(valid.rows.map(r => r.key));
  return [...new Set(input.filter(z => allowed.has(z)))];
}

// ─── GET /api/badges  — list all badges (badge_type IS NOT NULL) ───
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status, type } = req.query;
    const where = ['badge_type IS NOT NULL'];
    const params = [];
    if (status) { params.push(status); where.push(`print_status = $${params.length}`); }
    if (type)   { params.push(type);   where.push(`badge_type = $${params.length}`); }
    const result = await pool.query(
      `SELECT ${BADGE_COLUMNS} FROM wristbands
       WHERE ${where.join(' AND ')}
       ORDER BY created_date DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /badges error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/badges/lookup?q=  — find existing sponsors + staff to pre-fill ───
router.get('/lookup', authenticateToken, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ sponsors: [], staff: [] });
    const like = `%${q}%`;

    const [sponsors, staff] = await Promise.all([
      pool.query(
        `SELECT s.id, s.name, s.contact_name, s.email, s.phone, s.city,
                (SELECT blob_url FROM sponsor_logos l
                  WHERE l.sponsor_id = s.id ORDER BY l.is_primary DESC, l.created_at LIMIT 1) AS logo_url,
                COALESCE((SELECT amount FROM sponsor_schedule sc
                  WHERE sc.sponsor_id = s.id ORDER BY sc.year DESC LIMIT 1), 0) AS pledge_amount
         FROM sponsors s
         WHERE s.name ILIKE $1 OR s.contact_name ILIKE $1
         ORDER BY s.name LIMIT 15`,
        [like]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT id, fullname, email, phone
         FROM staff
         WHERE fullname ILIKE $1
         ORDER BY fullname LIMIT 15`,
        [like]
      ).catch(() => ({ rows: [] })),
    ]);

    res.json({
      sponsors: sponsors.rows.map(s => ({
        source: 'sponsor', ref_id: String(s.id),
        name: s.contact_name || s.name, company: s.name,
        company_logo_url: s.logo_url || null,
        sponsorship_level: levelFromAmount(s.pledge_amount),
        email: s.email, phone: s.phone, city: s.city,
      })),
      staff: staff.rows.map(s => ({
        source: 'staff', ref_id: String(s.id),
        name: s.fullname, company: '', email: s.email, phone: s.phone,
      })),
    });
  } catch (err) {
    console.error('GET /badges/lookup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/badges/sponsor-guests?sponsor_id=  — a sponsor's pre-registered, not-yet-checked-in guests ───
// Lets check-in staff pick a guest the sponsor pre-entered (name/title/zones)
// instead of retyping. The badge is still created the normal way (photo + NFC
// card added here), with sponsor_guest_id passed to POST /api/badges to link it.
router.get('/sponsor-guests', authenticateToken, async (req, res) => {
  try {
    const sponsorId = parseInt(req.query.sponsor_id, 10);
    if (!sponsorId) return res.status(400).json({ error: 'sponsor_id required' });

    const sr = await pool.query(
      `SELECT s.id, s.name,
              (SELECT blob_url FROM sponsor_logos l
                WHERE l.sponsor_id = s.id ORDER BY l.is_primary DESC, l.created_at LIMIT 1) AS logo_url,
              COALESCE((SELECT amount FROM sponsor_schedule sc
                WHERE sc.sponsor_id = s.id ORDER BY sc.year DESC LIMIT 1), 0) AS pledge_amount
       FROM sponsors s WHERE s.id = $1`,
      [sponsorId]
    ).catch(() => ({ rows: [] }));
    const sponsor = sr.rows[0] || null;

    const gr = await pool.query(
      `SELECT id, name, title, email, requested_zones
       FROM sponsor_guests
       WHERE sponsor_id = $1 AND status = 'pending'
       ORDER BY created_at`,
      [sponsorId]
    );

    res.json({
      sponsor: sponsor
        ? { id: sponsor.id, company: sponsor.name, company_logo_url: sponsor.logo_url || null,
            sponsorship_level: levelFromAmount(sponsor.pledge_amount) }
        : null,
      guests: gr.rows.map(g => ({
        sponsor_guest_id: g.id,
        name: g.name,
        title: g.title,
        email: g.email,
        access_zones: Array.isArray(g.requested_zones) ? g.requested_zones : [],
      })),
    });
  } catch (err) {
    console.error('GET /badges/sponsor-guests error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/badges/print-queue  — badges waiting to print (for the Seaory station) ───
router.get('/print-queue', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${BADGE_COLUMNS} FROM wristbands
       WHERE badge_type IS NOT NULL AND print_status = 'queued' AND badge_active = true
       ORDER BY created_date ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /badges/print-queue error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/badges/zones  — list controlled-access zones (suites + deck) ───
router.get('/zones', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT key, label, sponsor_label, sort, active FROM access_zones ORDER BY sort, key'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /badges/zones error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/badges/zones/:key  — rename / assign a suite to a sponsor ───
router.put('/zones/:key', authenticateToken, async (req, res) => {
  try {
    const { label, sponsor_label, active } = req.body;
    const result = await pool.query(
      `UPDATE access_zones SET
         label         = COALESCE($1, label),
         sponsor_label = $2,
         active        = COALESCE($3, active)
       WHERE key = $4 RETURNING *`,
      [label ?? null, sponsor_label ?? null, active ?? null, req.params.key]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Zone not found' });
    res.json({ success: true, zone: result.rows[0] });
  } catch (err) {
    console.error('PUT /badges/zones/:key error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/badges/access-check  — door scanner: may this card enter this zone? ───
router.post('/access-check', authenticateToken, async (req, res) => {
  try {
    const { rfid_uid, zone } = req.body;
    if (!rfid_uid || !zone) return res.status(400).json({ error: 'rfid_uid and zone required' });
    const uid = normalizeUid(rfid_uid);

    const zoneRow = await pool.query('SELECT key, label FROM access_zones WHERE key = $1', [zone]);
    const zoneLabel = zoneRow.rows[0]?.label || zone;

    const found = await pool.query(
      `SELECT id, customer_name, photo_url, badge_type, tier, company, access_zones, badge_active
       FROM wristbands WHERE UPPER(rfid_uid) = $1 AND badge_type IS NOT NULL`,
      [uid]
    );
    const badge = found.rows[0] || null;
    const zones = Array.isArray(badge?.access_zones) ? badge.access_zones : [];
    const granted = !!badge && badge.badge_active && zones.includes(zone);

    const logId = `zaccess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    await pool.query(
      `INSERT INTO zone_access_log (id, rfid_uid, badge_id, zone_key, granted, guest_name, scanned_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [logId, uid, badge?.id || null, zone, granted, badge?.customer_name || null, actor(req)]
    );

    res.json({
      granted,
      zone, zone_label: zoneLabel,
      reason: !badge ? 'No badge on this card'
        : !badge.badge_active ? 'Badge deactivated'
        : !granted ? 'Not permitted in this area' : 'Welcome',
      badge: badge ? {
        name: badge.customer_name, photo_url: badge.photo_url,
        badge_type: badge.badge_type, tier: badge.tier, company: badge.company,
        allowed_zones: zones,
      } : null,
    });
  } catch (err) {
    console.error('POST /badges/access-check error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/badges/:id ───
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${BADGE_COLUMNS} FROM wristbands WHERE id = $1 AND badge_type IS NOT NULL`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Badge not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /badges/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/badges  — register a new badge (card must be tapped first) ───
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      rfid_uid, name, title, company, company_logo_url, badge_type, tier,
      email, photo, area_access = false, alcohol_approved = true,
    } = req.body;

    if (!name)      return res.status(400).json({ error: 'name is required' });
    if (!rfid_uid)  return res.status(400).json({ error: 'Tap the NFC card before saving' });
    if (!BADGE_TYPES.includes(badge_type)) {
      return res.status(400).json({ error: `badge_type must be one of: ${BADGE_TYPES.join(', ')}` });
    }

    const uid = normalizeUid(rfid_uid);
    const dupe = await pool.query('SELECT id, customer_name FROM wristbands WHERE UPPER(rfid_uid) = $1', [uid]);
    if (dupe.rows.length > 0) {
      return res.status(409).json({ error: `This card is already assigned to ${dupe.rows[0].customer_name || 'someone'}` });
    }

    const { unlimited, credits } = resolveCredits(req.body);
    const zones = await sanitizeZones(req.body.access_zones);
    const areaAccess = zones.length > 0 || !!area_access;
    const id = genId();

    let photoUrl = null;
    if (photo) photoUrl = await uploadPhoto(id, photo);

    const result = await pool.query(
      `INSERT INTO wristbands
        (id, rfid_uid, customer_name, customer_email, ticket_type, badge_type, tier,
         title, company, company_logo_url, photo_url, credits, alcohol_approved, unlimited, area_access,
         access_zones, badge_active, print_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,'queued',$16)
       RETURNING ${BADGE_COLUMNS}`,
      [id, uid, name, email || null, badge_type, tier || null, title || null,
       company || null, company_logo_url || null, photoUrl, credits, !!alcohol_approved, unlimited, areaAccess,
       JSON.stringify(zones), actor(req)]
    );

    // If this badge fulfils a sponsor's pre-registered guest, mark it checked in.
    if (req.body.sponsor_guest_id) {
      await pool.query(
        `UPDATE sponsor_guests SET status = 'checked_in', badge_id = $1, updated_at = NOW()
         WHERE id = $2 AND status = 'pending'`,
        [id, req.body.sponsor_guest_id]
      ).catch(e => console.error('link sponsor_guest failed:', e.message));
    }

    console.log(`✓ Badge created: ${name} (${badge_type}${tier ? '/' + tier : ''}) → ${uid}`);
    res.json({ success: true, badge: result.rows[0] });
  } catch (err) {
    console.error('POST /badges error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/badges/:id  — edit fields (credits, type, photo, etc.) ───
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const existing = await pool.query(
      'SELECT id FROM wristbands WHERE id = $1 AND badge_type IS NOT NULL', [req.params.id]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Badge not found' });

    const { name, title, company, company_logo_url, badge_type, tier, email, area_access, alcohol_approved, photo } = req.body;
    if (badge_type !== undefined && !BADGE_TYPES.includes(badge_type)) {
      return res.status(400).json({ error: `badge_type must be one of: ${BADGE_TYPES.join(', ')}` });
    }

    let photoUrl;
    if (photo) photoUrl = await uploadPhoto(req.params.id, photo);

    // Only re-resolve credits when the client sent credit/unlimited info.
    const touchCredits = req.body.unlimited !== undefined || req.body.credits !== undefined;
    const { unlimited, credits } = touchCredits ? resolveCredits(req.body) : { unlimited: null, credits: null };

    // Zones drive area_access; only touched when access_zones was sent.
    let zonesParam = null, areaParam = area_access ?? null;
    if (req.body.access_zones !== undefined) {
      const z = await sanitizeZones(req.body.access_zones);
      zonesParam = JSON.stringify(z);
      areaParam = z.length > 0;
    }

    const result = await pool.query(
      `UPDATE wristbands SET
         customer_name    = COALESCE($1, customer_name),
         title            = COALESCE($2, title),
         company          = COALESCE($3, company),
         badge_type       = COALESCE($4, badge_type),
         tier             = COALESCE($5, tier),
         customer_email   = COALESCE($6, customer_email),
         area_access      = COALESCE($7, area_access),
         alcohol_approved = COALESCE($8, alcohol_approved),
         photo_url        = COALESCE($9, photo_url),
         unlimited        = COALESCE($10, unlimited),
         credits          = COALESCE($11, credits),
         access_zones     = COALESCE($12::jsonb, access_zones),
         company_logo_url = COALESCE($13, company_logo_url)
       WHERE id = $14
       RETURNING ${BADGE_COLUMNS}`,
      [name ?? null, title ?? null, company ?? null, badge_type ?? null, tier ?? null,
       email ?? null, areaParam, alcohol_approved ?? null, photoUrl ?? null,
       unlimited, credits, zonesParam, company_logo_url ?? null, req.params.id]
    );
    res.json({ success: true, badge: result.rows[0] });
  } catch (err) {
    console.error('PUT /badges/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/badges/:id/link  — (re)assign an NFC card (e.g. lost-card reissue) ───
router.post('/:id/link', authenticateToken, async (req, res) => {
  try {
    const { rfid_uid } = req.body;
    if (!rfid_uid) return res.status(400).json({ error: 'rfid_uid required' });
    const uid = normalizeUid(rfid_uid);

    const dupe = await pool.query(
      'SELECT id, customer_name FROM wristbands WHERE UPPER(rfid_uid) = $1 AND id != $2', [uid, req.params.id]
    );
    if (dupe.rows.length > 0) {
      return res.status(409).json({ error: `Card already assigned to ${dupe.rows[0].customer_name || 'someone'}` });
    }

    const result = await pool.query(
      `UPDATE wristbands SET rfid_uid = $1
       WHERE id = $2 AND badge_type IS NOT NULL RETURNING ${BADGE_COLUMNS}`,
      [uid, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Badge not found' });
    res.json({ success: true, badge: result.rows[0] });
  } catch (err) {
    console.error('POST /badges/:id/link error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/badges/:id/queue  — (re)queue for printing ───
router.post('/:id/queue', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE wristbands SET print_status = 'queued'
       WHERE id = $1 AND badge_type IS NOT NULL RETURNING ${BADGE_COLUMNS}`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Badge not found' });
    res.json({ success: true, badge: result.rows[0] });
  } catch (err) {
    console.error('POST /badges/:id/queue error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/badges/:id/printed  — mark a badge as printed ───
router.post('/:id/printed', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE wristbands SET print_status = 'printed', printed_at = NOW()
       WHERE id = $1 AND badge_type IS NOT NULL RETURNING ${BADGE_COLUMNS}`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Badge not found' });
    res.json({ success: true, badge: result.rows[0] });
  } catch (err) {
    console.error('POST /badges/:id/printed error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/badges/:id/deactivate  — disable a badge (lost / revoked) ───
router.post('/:id/deactivate', authenticateToken, async (req, res) => {
  try {
    // Zero out perks too — the bar (/drinks/serve) and food (/wristbands/redeem)
    // paths key on credits/alcohol_approved, not badge_active, so a revoked card
    // must lose its spending power here to actually stop working.
    const result = await pool.query(
      `UPDATE wristbands SET badge_active = false, unlimited = false,
         credits = 0, alcohol_approved = false, area_access = false
       WHERE id = $1 AND badge_type IS NOT NULL RETURNING ${BADGE_COLUMNS}`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Badge not found' });
    res.json({ success: true, badge: result.rows[0] });
  } catch (err) {
    console.error('POST /badges/:id/deactivate error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
