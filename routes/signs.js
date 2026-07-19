const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const pool = require('../config/database');
const router = express.Router();

// ╔══════════════════════════════════════════╗
// ║          SIGN INVENTORY CRUD             ║
// ╚══════════════════════════════════════════╝
//
// Physical sign inventory (what the sign is, size, material, condition,
// where it lives). Each sign is one of three categories and cross-references
// the matching table:
//   sponsor    → sponsors(id)        via sponsor_id
//   vendor     → vendors(id)         via vendor_id
//   operations → sign_locations(id)  via sign_location_id (optional — only
//                roadside directional signs have a sign_locations row)
// The table itself is created in server.js auto-migrations.

const CATEGORIES = ['sponsor', 'vendor', 'operations'];
const CONDITIONS = ['New', 'Good', 'Fair', 'Needs repair', 'Replace'];

// Standard site signage checklist, used by POST /seed-defaults so a new
// season starts from the same walk-through list as the inventory spreadsheet.
const DEFAULT_OPS_SIGNS = [
  'Main entrance / welcome sign',
  'Highway directional signs (roadside)',
  'Parking →',
  'Accessible parking',
  'No parking — fire route',
  'Contestant / trailer parking',
  'Box office / tickets',
  'General admission gate',
  'Gate hours / schedule board',
  'ATM →',
  'Washrooms →',
  'First aid',
  'Lost & found',
  'Beer garden / bar',
  'No alcohol beyond this point (AGCO)',
  '2 drink maximum per visit (AGCO)',
  'ID required — 19+',
  'Food vendors →',
  'Vendor row / marketplace',
  'Exit / no re-entry',
  'Emergency exit',
  'Emergency muster point',
  'Camping area',
  'Livestock area — authorized personnel only',
  'Caution — livestock',
  'No smoking',
  'No pets / service animals only',
  'Volunteer / staff check-in',
  'Grandstand seating sections',
  'Sponsor thank-you banner (all sponsors)',
];

// Coerce and validate a request body into a clean row. Cross-reference ids
// are kept only when they match the category, so a sign can never point at
// both a sponsor and a vendor, and re-categorising clears the stale link.
function cleanSign(body) {
  const category = String(body.category || 'operations').toLowerCase();
  if (!CATEGORIES.includes(category)) {
    return { error: `category must be one of: ${CATEGORIES.join(', ')}` };
  }
  const name = (body.name || '').trim();
  if (!name) return { error: 'name is required' };

  const intOrNull = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  const quantity = intOrNull(body.quantity);

  return {
    row: {
      name,
      category,
      sponsor_id: category === 'sponsor' ? intOrNull(body.sponsor_id) : null,
      vendor_id: category === 'vendor' ? intOrNull(body.vendor_id) : null,
      sign_location_id: intOrNull(body.sign_location_id),
      size: (body.size || '').trim() || null,
      material: (body.material || '').trim() || null,
      quantity: quantity === null || quantity < 0 ? 1 : quantity,
      condition: (body.condition || '').trim() || null,
      site_location: (body.site_location || '').trim() || null,
      storage_location: (body.storage_location || '').trim() || null,
      notes: (body.notes || '').trim() || null,
      active: body.active === undefined ? true : !!body.active,
    },
  };
}

const LIST_SQL = `
  SELECT sg.*,
         sp.name AS sponsor_name,
         vd.name AS vendor_name,
         sl.location AS sign_location_name,
         sl.cross_street AS sign_location_cross_street
    FROM signs sg
    LEFT JOIN sponsors sp ON sp.id = sg.sponsor_id
    LEFT JOIN vendors  vd ON vd.id = sg.vendor_id
    LEFT JOIN sign_locations sl ON sl.id = sg.sign_location_id`;

router.get('/', authenticateToken, async (req, res) => {
  try {
    const where = [];
    const params = [];
    const category = (req.query.category || '').toLowerCase();
    if (CATEGORIES.includes(category)) {
      params.push(category);
      where.push(`sg.category = $${params.length}`);
    }
    if (req.query.active === 'true') where.push('sg.active IS NOT FALSE');
    const sql = `${LIST_SQL}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY sg.category, COALESCE(sp.name, vd.name, ''), sg.name`;
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /signs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Aggregate counts for the portal header — mirrors the Summary sheet of the
// original inventory spreadsheet (by category / material / condition).
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const [byCategory, byMaterial, byCondition, totals] = await Promise.all([
      pool.query(`SELECT category, COUNT(*)::int AS line_items, COALESCE(SUM(quantity),0)::int AS total_signs
                    FROM signs WHERE active IS NOT FALSE GROUP BY category`),
      pool.query(`SELECT COALESCE(material,'(not recorded)') AS material, COUNT(*)::int AS line_items,
                         COALESCE(SUM(quantity),0)::int AS total_signs
                    FROM signs WHERE active IS NOT FALSE GROUP BY 1 ORDER BY 3 DESC`),
      pool.query(`SELECT COALESCE(condition,'(not recorded)') AS condition, COUNT(*)::int AS line_items
                    FROM signs WHERE active IS NOT FALSE GROUP BY 1`),
      pool.query(`SELECT COUNT(*)::int AS line_items, COALESCE(SUM(quantity),0)::int AS total_signs
                    FROM signs WHERE active IS NOT FALSE`),
    ]);
    res.json({
      totals: totals.rows[0],
      by_category: byCategory.rows,
      by_material: byMaterial.rows,
      by_condition: byCondition.rows,
    });
  } catch (err) {
    console.error('GET /signs/summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Reference lists for portal dropdowns (materials/conditions are free text in
// the DB; these are just the suggested values).
router.get('/options', authenticateToken, async (req, res) => {
  res.json({
    categories: CATEGORIES,
    conditions: CONDITIONS,
    materials: ['Coroplast (corrugated plastic)', 'Vinyl banner', 'Mesh banner',
      'Aluminum / metal', 'Plywood (painted)', 'PVC / Sintra board',
      'Fabric flag', 'Magnetic', 'Cardboard / paper', 'Other'],
    sizes: ['12" x 18"', '18" x 24"', '24" x 36"', '2 ft x 4 ft', '4 ft x 4 ft',
      '4 ft x 8 ft', '3 ft x 6 ft banner', '3 ft x 10 ft banner',
      '4 ft x 10 ft banner', 'Flag (standard)'],
  });
});

router.post('/', authenticateToken, async (req, res) => {
  const { row, error } = cleanSign(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const result = await pool.query(
      `INSERT INTO signs (name, category, sponsor_id, vendor_id, sign_location_id,
                          size, material, quantity, condition, site_location,
                          storage_location, notes, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [row.name, row.category, row.sponsor_id, row.vendor_id, row.sign_location_id,
       row.size, row.material, row.quantity, row.condition, row.site_location,
       row.storage_location, row.notes, row.active]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('POST /signs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// One-click load of the standard operations checklist. Skips names that
// already exist (case-insensitive) so it is safe to run more than once.
router.post('/seed-defaults', authenticateToken, async (req, res) => {
  try {
    let inserted = 0;
    for (const name of DEFAULT_OPS_SIGNS) {
      const result = await pool.query(
        `INSERT INTO signs (name, category)
         SELECT $1::varchar, 'operations'
         WHERE NOT EXISTS (SELECT 1 FROM signs WHERE lower(name) = lower($1::varchar))`,
        [name]
      );
      inserted += result.rowCount;
    }
    res.json({ inserted, skipped: DEFAULT_OPS_SIGNS.length - inserted });
  } catch (err) {
    console.error('POST /signs/seed-defaults error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', authenticateToken, async (req, res) => {
  const { row, error } = cleanSign(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const result = await pool.query(
      `UPDATE signs SET name=$1, category=$2, sponsor_id=$3, vendor_id=$4,
              sign_location_id=$5, size=$6, material=$7, quantity=$8,
              condition=$9, site_location=$10, storage_location=$11, notes=$12,
              active=$13, updated_at=NOW()
       WHERE id=$14 RETURNING *`,
      [row.name, row.category, row.sponsor_id, row.vendor_id, row.sign_location_id,
       row.size, row.material, row.quantity, row.condition, row.site_location,
       row.storage_location, row.notes, row.active, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /signs/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM signs WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /signs/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
