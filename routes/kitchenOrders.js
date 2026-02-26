const express = require('express');
const router = express.Router();

// ============================================================
//  Kitchen Orders Routes — /api/kitchen
//  Manages food orders for the Kitchen Display System (KDS)
//  Used by: food kiosk, FoodOrder page (create), kitchen displays (read/update)
// ============================================================

module.exports = function(pool) {

  // Auto-create table on first load
  (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS kitchen_orders (
          id SERIAL PRIMARY KEY,
          order_number VARCHAR(10) NOT NULL,
          customer_name VARCHAR(100) DEFAULT 'Guest',
          items JSONB NOT NULL DEFAULT '[]',
          subtotal NUMERIC(8,2) DEFAULT 0,
          tax NUMERIC(8,2) DEFAULT 0,
          total NUMERIC(8,2) DEFAULT 0,
          status VARCHAR(20) DEFAULT 'new',
          source VARCHAR(20) DEFAULT 'kiosk',
          payment_status VARCHAR(20) DEFAULT 'pending',
          payment_ref VARCHAR(100),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          completed_at TIMESTAMPTZ,
          picked_up_at TIMESTAMPTZ
        );
      `);
      // Add indexes for fast lookups
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_kitchen_orders_status ON kitchen_orders(status)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_kitchen_orders_created ON kitchen_orders(created_at DESC)`);
      console.log('[kitchen-orders] Table ready');
    } catch (err) {
      console.error('[kitchen-orders] Table setup error:', err.message);
    }
  })();

  // ─── GET /api/kitchen/orders — Active orders for displays ───
  router.get('/orders', async (req, res) => {
    try {
      const { status, since } = req.query;

      let query = `
        SELECT * FROM kitchen_orders
        WHERE status != 'picked_up'
          AND created_at > NOW() - INTERVAL '8 hours'
      `;
      const params = [];

      if (status) {
        params.push(status);
        query += ` AND status = $${params.length}`;
      }

      if (since) {
        params.push(since);
        query += ` AND updated_at > $${params.length}`;
      }

      query += ` ORDER BY
        CASE status
          WHEN 'new' THEN 1
          WHEN 'in_progress' THEN 2
          WHEN 'ready' THEN 3
          ELSE 4
        END,
        created_at ASC`;

      const { rows } = await pool.query(query, params);
      res.json({ orders: rows, count: rows.length });
    } catch (err) {
      console.error('[kitchen-orders] GET error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /api/kitchen/orders — Create new order ───
  router.post('/orders', async (req, res) => {
    try {
      const { customerName, items, subtotal, tax, total, source, paymentRef } = req.body;

      if (!items || items.length === 0) {
        return res.status(400).json({ error: 'No items in order' });
      }

      // Generate short order number (2-digit, cycling 01-99)
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int as cnt FROM kitchen_orders WHERE created_at > CURRENT_DATE`
      );
      const todayCount = countRows[0]?.cnt || 0;
      const orderNumber = String((todayCount % 99) + 1).padStart(2, '0');

      const { rows } = await pool.query(
        `INSERT INTO kitchen_orders (order_number, customer_name, items, subtotal, tax, total, source, payment_ref, payment_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          orderNumber,
          customerName || 'Guest',
          JSON.stringify(items),
          subtotal || 0,
          tax || 0,
          total || 0,
          source || 'kiosk',
          paymentRef || null,
          paymentRef ? 'paid' : 'pending'
        ]
      );

      console.log(`[kitchen-orders] New order #${orderNumber} — ${items.length} items — $${total || 0}`);
      res.json({ success: true, order: rows[0], orderNumber });
    } catch (err) {
      console.error('[kitchen-orders] POST error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── PATCH /api/kitchen/orders/:id — Update order status ───
  router.patch('/orders/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const validStatuses = ['new', 'in_progress', 'ready', 'picked_up'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status. Use: ' + validStatuses.join(', ') });
      }

      let extraFields = '';
      if (status === 'ready') extraFields = ', completed_at = NOW()';
      if (status === 'picked_up') extraFields = ', picked_up_at = NOW()';

      const { rows } = await pool.query(
        `UPDATE kitchen_orders
         SET status = $1, updated_at = NOW() ${extraFields}
         WHERE id = $2
         RETURNING *`,
        [status, id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }

      console.log(`[kitchen-orders] Order #${rows[0].order_number} → ${status}`);
      res.json({ success: true, order: rows[0] });
    } catch (err) {
      console.error('[kitchen-orders] PATCH error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── DELETE /api/kitchen/orders/:id — Cancel/remove order ───
  router.delete('/orders/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { rows } = await pool.query(
        `DELETE FROM kitchen_orders WHERE id = $1 RETURNING order_number`,
        [id]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }
      console.log(`[kitchen-orders] Order #${rows[0].order_number} deleted`);
      res.json({ success: true });
    } catch (err) {
      console.error('[kitchen-orders] DELETE error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/kitchen/stats — Quick summary for admin ───
  router.get('/stats', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'new') AS new_orders,
          COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
          COUNT(*) FILTER (WHERE status = 'ready') AS ready,
          COUNT(*) FILTER (WHERE status = 'picked_up' AND picked_up_at > NOW() - INTERVAL '1 hour') AS picked_up_1h,
          COALESCE(SUM(total) FILTER (WHERE created_at > CURRENT_DATE), 0) AS today_revenue
        FROM kitchen_orders
        WHERE created_at > NOW() - INTERVAL '8 hours'
      `);
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
