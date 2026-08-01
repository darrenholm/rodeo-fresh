const express = require('express');
const router = express.Router();

// ============================================================
//  Merchandise Sales Routes — /api/merch
//  Records in-person POS sales and manages stock
//  Used by: rodeo-merch-pos.html
// ============================================================

module.exports = function(pool) {

  // Auto-create table on first load
  (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS merch_sales (
          id SERIAL PRIMARY KEY,
          order_id VARCHAR(100) NOT NULL,
          items JSONB NOT NULL DEFAULT '[]',
          subtotal NUMERIC(8,2) DEFAULT 0,
          tax NUMERIC(8,2) DEFAULT 0,
          total NUMERIC(8,2) DEFAULT 0,
          payment_method VARCHAR(20) DEFAULT 'card',
          staff_id VARCHAR(100),
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_merch_sales_created ON merch_sales(created_at DESC)`);
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_stock JSONB`);
      console.log('[merch-sales] Table ready');
    } catch (err) {
      console.error('[merch-sales] Table setup error:', err.message);
    }
  })();

  // ─── POST /api/merch/sales — Record a sale ───
  router.post('/sales', async (req, res) => {
    try {
      const { orderId, items, subtotal, tax, total, paymentMethod, staffId } = req.body;

      if (!items || items.length === 0) {
        return res.status(400).json({ error: 'No items in sale' });
      }

      // Record the sale
      const { rows } = await pool.query(
        `INSERT INTO merch_sales (order_id, items, subtotal, tax, total, payment_method, staff_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [orderId, JSON.stringify(items), subtotal || 0, tax || 0, total || 0, paymentMethod || 'card', staffId || null]
      );

      // Decrease stock for each item
      for (const item of items) {
        if (item.productId && item.qty) {
          await pool.query(
            `UPDATE products SET stock = GREATEST(0, stock - $1), updated_date = NOW() WHERE id = $2`,
            [item.qty, item.productId]
          );
          // Per-variant stock: key is "Color|Size", or just the color/size when only one applies
          const vkey = item.color && item.size ? `${item.color}|${item.size}` : (item.color || item.size || null);
          if (vkey) {
            await pool.query(
              `UPDATE products
               SET variant_stock = jsonb_set(variant_stock, ARRAY[$1],
                     to_jsonb(GREATEST(0, COALESCE((variant_stock->>$1)::int, 0) - $2)))
               WHERE id = $3 AND variant_stock IS NOT NULL AND variant_stock ? $1`,
              [vkey, item.qty, item.productId]
            );
          }
        }
      }

      const totalItems = items.reduce((sum, i) => sum + (i.qty || 1), 0);
      console.log(`[merch-sales] Sale ${orderId}: ${totalItems} items, $${total} via ${paymentMethod}`);
      res.json({ success: true, sale: rows[0] });
    } catch (err) {
      console.error('[merch-sales] POST error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/merch/sales — Get sales history ───
  router.get('/sales', async (req, res) => {
    try {
      const { today, limit } = req.query;

      let query = 'SELECT * FROM merch_sales';
      const params = [];

      if (today === 'true') {
        query += ' WHERE created_at >= CURRENT_DATE';
      }

      query += ' ORDER BY created_at DESC';

      if (limit) {
        params.push(parseInt(limit));
        query += ` LIMIT $${params.length}`;
      }

      const { rows } = await pool.query(query, params);
      res.json({ sales: rows, count: rows.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/merch/stats — Daily sales summary ───
  router.get('/stats', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) AS total_sales,
          COALESCE(SUM(total), 0) AS total_revenue,
          COALESCE(SUM(total) FILTER (WHERE payment_method = 'card'), 0) AS card_revenue,
          COALESCE(SUM(total) FILTER (WHERE payment_method = 'cash'), 0) AS cash_revenue,
          COUNT(*) FILTER (WHERE payment_method = 'card') AS card_count,
          COUNT(*) FILTER (WHERE payment_method = 'cash') AS cash_count
        FROM merch_sales
        WHERE created_at >= CURRENT_DATE
      `);
      // All-time + per-day reporting for the dashboard revenue tiles.
      const { rows: allTime } = await pool.query(`
        SELECT COUNT(*) AS all_time_sales,
               COALESCE(SUM(total), 0) AS all_time_revenue
        FROM merch_sales
      `);
      const { rows: byDay } = await pool.query(`
        SELECT ((created_at AT TIME ZONE 'America/Toronto')::date)::text AS day,
               COUNT(*) AS sales,
               COALESCE(SUM(total), 0) AS revenue
        FROM merch_sales
        GROUP BY 1 ORDER BY 1
      `);
      res.json({ ...rows[0], ...allTime[0], revenue_by_day: byDay });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
