const express = require('express');
const router = express.Router();

// ============================================================
//  Booth Menu Routes — /api/booth/menu
//  Stores the full food booth menu configuration in PostgreSQL
//  Used by: rodeo-food-admin.html (write) & rodeo-food-kiosk.html (read)
// ============================================================

module.exports = function(pool) {

  // Auto-create table on first load
  (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS booth_menu (
          id SERIAL PRIMARY KEY,
          booth_id VARCHAR(50) NOT NULL DEFAULT 'main',
          booth_name VARCHAR(100) DEFAULT 'RODEO GRUB',
          tax_rate NUMERIC(5,4) DEFAULT 0.13,
          tax_label VARCHAR(20) DEFAULT 'HST',
          categories JSONB DEFAULT '[]',
          menu_items JSONB DEFAULT '[]',
          drink_categories JSONB DEFAULT '[]',
          drink_menu JSONB DEFAULT '[]',
          ticket_price NUMERIC(8,2) DEFAULT 7.00,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          updated_by VARCHAR(100) DEFAULT 'admin'
        );
      `);
      // Add columns if they don't exist (for existing tables)
      await pool.query(`ALTER TABLE booth_menu ADD COLUMN IF NOT EXISTS drink_menu JSONB DEFAULT '[]'`);
      await pool.query(`ALTER TABLE booth_menu ADD COLUMN IF NOT EXISTS drink_categories JSONB DEFAULT '[]'`);
      await pool.query(`ALTER TABLE booth_menu ADD COLUMN IF NOT EXISTS ticket_price NUMERIC(8,2) DEFAULT 7.00`);
      // Insert default row if none exists
      const { rows } = await pool.query(`SELECT id FROM booth_menu WHERE booth_id = 'main'`);
      if (rows.length === 0) {
        await pool.query(`INSERT INTO booth_menu (booth_id) VALUES ('main')`);
        console.log('[booth-menu] Created default booth_menu row');
      }
      console.log('[booth-menu] Table ready');
    } catch (err) {
      console.error('[booth-menu] Init error:', err.message);
    }
  })();

  // ─── GET /api/booth/menu ─── Read current menu (public, no auth needed)
  router.get('/', async (req, res) => {
    try {
      const boothId = req.query.booth || 'main';
      const { rows } = await pool.query(
        `SELECT booth_name, tax_rate, tax_label, categories, menu_items, updated_at
         FROM booth_menu WHERE booth_id = $1`,
        [boothId]
      );
      if (rows.length === 0) {
        return res.json({
          boothName: 'RODEO GRUB',
          taxRate: 0.13,
          taxLabel: 'HST',
          categories: [],
          menu: [],
          drinkCategories: [],
          drinkMenu: [],
          ticketPrice: 7.00,
          lastUpdated: null
        });
      }
      const row = rows[0];
      res.json({
        boothName: row.booth_name,
        taxRate: parseFloat(row.tax_rate),
        taxLabel: row.tax_label,
        categories: row.categories || [],
        menu: row.menu_items || [],
        drinkCategories: row.drink_categories || [],
        drinkMenu: row.drink_menu || [],
        ticketPrice: parseFloat(row.ticket_price || 7),
        lastUpdated: row.updated_at
      });
    } catch (err) {
      console.error('[booth-menu] GET error:', err.message);
      res.status(500).json({ error: 'Failed to load menu' });
    }
  });

  // ─── POST /api/booth/menu ─── Save/update menu (staff only)
  router.post('/', async (req, res) => {
    try {
      const { boothName, taxRate, taxLabel, categories, menu, drinkCategories, drinkMenu, ticketPrice } = req.body;
      const boothId = req.body.boothId || 'main';

      const { rows } = await pool.query(
        `UPDATE booth_menu SET
           booth_name = COALESCE($1, booth_name),
           tax_rate = COALESCE($2, tax_rate),
           tax_label = COALESCE($3, tax_label),
           categories = COALESCE($4, categories),
           menu_items = COALESCE($5, menu_items),
           drink_categories = COALESCE($6, drink_categories),
           drink_menu = COALESCE($7, drink_menu),
           ticket_price = COALESCE($8, ticket_price),
           updated_at = NOW()
         WHERE booth_id = $9
         RETURNING *`,
        [
          boothName || null,
          taxRate != null ? taxRate : null,
          taxLabel || null,
          categories ? JSON.stringify(categories) : null,
          menu ? JSON.stringify(menu) : null,
          drinkCategories ? JSON.stringify(drinkCategories) : null,
          drinkMenu ? JSON.stringify(drinkMenu) : null,
          ticketPrice != null ? ticketPrice : null,
          boothId
        ]
      );

      if (rows.length === 0) {
        await pool.query(
          `INSERT INTO booth_menu (booth_id, booth_name, tax_rate, tax_label, categories, menu_items, drink_categories, drink_menu, ticket_price)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [boothId, boothName, taxRate, taxLabel, JSON.stringify(categories), JSON.stringify(menu), JSON.stringify(drinkCategories || []), JSON.stringify(drinkMenu || []), ticketPrice || 7]
        );
      }

      console.log(`[booth-menu] Saved — ${(menu || []).length} food items, ${(drinkMenu || []).length} drinks, ticket=$${ticketPrice || '7.00'}`);
      res.json({ success: true, itemCount: (menu || []).length, drinkCount: (drinkMenu || []).length });
    } catch (err) {
      console.error('[booth-menu] POST error:', err.message);
      res.status(500).json({ error: 'Failed to save menu' });
    }
  });

  return router;
};
