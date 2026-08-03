const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// ============================================
// GET /api/reports/today-sales
// Get today's ticket sales summary
// ============================================
router.get('/today-sales', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_orders,
        COALESCE(SUM(quantity), 0) as total_tickets,
        COALESCE(SUM(total_price::numeric), 0) as total_revenue,
        COALESCE(SUM(quantity_adult), 0) as total_adults,
        COALESCE(SUM(quantity_child), 0) as total_children
      FROM ticket_orders 
      WHERE created_date::date = CURRENT_DATE
        AND status IN ('confirmed', 'paid')
    `);

    res.json(result.rows[0]);

  } catch (error) {
    console.error('Today sales report error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// GET /api/reports/food-by-day
// Breakdown of food items sold per day (kitchen orders), grouped by
// day and item name. Optional query params:
//   start=YYYY-MM-DD, end=YYYY-MM-DD (inclusive, Eastern Time)
//   booth=main|icecream|all (defaults to all booths)
// ============================================
router.get('/food-by-day', authenticateToken, async (req, res) => {
  try {
    const { start, end, booth } = req.query;

    const params = [];
    let query = `
      SELECT
        (created_at AT TIME ZONE 'America/Toronto')::date AS day,
        COALESCE(
          NULLIF(item->>'name', ''),
          NULLIF(item->>'item_name', ''),
          NULLIF(item->>'title', ''),
          'Unknown Item'
        ) AS item_name,
        COALESCE(booth, 'main') AS booth,
        SUM(
          COALESCE(
            NULLIF(item->>'quantity', '')::numeric,
            NULLIF(item->>'qty', '')::numeric,
            1
          )
        ) AS quantity_sold,
        SUM(
          COALESCE(
            NULLIF(item->>'quantity', '')::numeric,
            NULLIF(item->>'qty', '')::numeric,
            1
          ) * COALESCE(NULLIF(item->>'price', '')::numeric, 0)
        ) AS revenue
      FROM kitchen_orders,
           LATERAL jsonb_array_elements(items) AS item
      WHERE status != 'cancelled'
    `;

    if (start) {
      params.push(start);
      query += ` AND (created_at AT TIME ZONE 'America/Toronto')::date >= $${params.length}`;
    }
    if (end) {
      params.push(end);
      query += ` AND (created_at AT TIME ZONE 'America/Toronto')::date <= $${params.length}`;
    }
    if (booth && booth !== 'all') {
      params.push(booth);
      query += ` AND COALESCE(booth, 'main') = $${params.length}`;
    }

    query += `
      GROUP BY day, item_name, COALESCE(booth, 'main')
      ORDER BY day ASC, quantity_sold DESC
    `;

    const { rows } = await pool.query(query, params);

    // Reshape into one entry per day with its items nested, plus day totals.
    const byDay = new Map();
    for (const row of rows) {
      const day = row.day.toISOString().split('T')[0];
      if (!byDay.has(day)) {
        byDay.set(day, { day, total_quantity: 0, total_revenue: 0, items: [] });
      }
      const entry = byDay.get(day);
      const quantity = parseFloat(row.quantity_sold) || 0;
      const revenue = parseFloat(row.revenue) || 0;
      entry.items.push({
        item_name: row.item_name,
        booth: row.booth,
        quantity_sold: quantity,
        revenue
      });
      entry.total_quantity += quantity;
      entry.total_revenue += revenue;
    }

    res.json({ days: Array.from(byDay.values()) });

  } catch (error) {
    console.error('Food-by-day report error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// GET /api/reports/event-sales
// Whole-event sales: food, drink and merch, itemised. Admin only —
// this is the full financial picture for the weekend.
//
// Query params: start=YYYY-MM-DD, end=YYYY-MM-DD (end EXCLUSIVE, Eastern).
// Defaults to the 2026 event weekend, which runs to 04:00 Monday so that
// sales made after midnight on the Sunday belong to the Sunday.
//
// Three things this deliberately gets right, because the raw tables do not:
//  * Counter line items are classified by their booth_menu category, so the
//    $7 "Ticket" item — which lives in kitchen_orders but is a drink — is
//    reported as drink, not food.
//  * Bar drinks are netted against their refunds.
//  * Wristband 'food' and 'merch' transactions are the payment method for
//    sales already counted in kitchen_orders / merch_sales, so they are
//    reported separately rather than added to revenue.
// ============================================
router.get('/event-sales', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || '') ? req.query.start : '2026-07-31';
    const end   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.end   || '') ? req.query.end   : '2026-08-04';
    const n = v => Number(v) || 0;
    // kitchen_orders/merch_sales are timestamptz; bar_transactions is not, and
    // is already stored in Eastern — so only the former get converted.
    const TZ = `AT TIME ZONE 'America/Toronto'`;

    const [menu, counterRows, barRows, merchRows, flowRows, merchPayRows, hourRows, ktTotal, mtTotal] =
      await Promise.all([
        pool.query(`SELECT booth_id, categories, menu_items FROM booth_menu`),
        pool.query(`
          SELECT COALESCE(k.booth,'main') AS booth,
                 (k.created_at ${TZ})::date AS day,
                 COALESCE(NULLIF(i->>'name',''),'Unknown Item') AS item,
                 SUM(COALESCE(NULLIF(i->>'qty','')::numeric, NULLIF(i->>'quantity','')::numeric, 1)) AS qty,
                 SUM(COALESCE(NULLIF(i->>'qty','')::numeric, NULLIF(i->>'quantity','')::numeric, 1)
                     * COALESCE(NULLIF(i->>'price','')::numeric, 0)) AS gross
          FROM kitchen_orders k, LATERAL jsonb_array_elements(k.items) i
          WHERE k.payment_status = 'paid'
            AND (k.created_at ${TZ})::date >= $1 AND (k.created_at ${TZ})::date < $2
          GROUP BY 1,2,3`, [start, end]),
        pool.query(`
          SELECT drink_name AS item,
                 COUNT(*) FILTER (WHERE transaction_type='drink')  AS served,
                 COUNT(*) FILTER (WHERE transaction_type='refund') AS refunded,
                 COALESCE(SUM(amount) FILTER (WHERE transaction_type='drink'),0)  AS gross,
                 COALESCE(SUM(amount) FILTER (WHERE transaction_type='refund'),0) AS refund_amt
          FROM bar_transactions
          WHERE transaction_type IN ('drink','refund') AND drink_name IS NOT NULL
            AND created_date::date >= $1 AND created_date::date < $2
          GROUP BY 1 ORDER BY 4 DESC`, [start, end]),
        pool.query(`
          SELECT COALESCE(NULLIF(i->>'name',''),'Unknown Item') AS product,
                 COALESCE(NULLIF(i->>'variant',''),'') AS variant,
                 SUM(COALESCE(NULLIF(i->>'qty','')::numeric,1)) AS qty,
                 SUM(COALESCE(NULLIF(i->>'qty','')::numeric,1)
                     * COALESCE(NULLIF(i->>'price','')::numeric,0)) AS gross
          FROM merch_sales m, LATERAL jsonb_array_elements(m.items) i
          WHERE (m.created_at ${TZ})::date >= $1 AND (m.created_at ${TZ})::date < $2
          GROUP BY 1,2 ORDER BY 1, 4 DESC`, [start, end]),
        pool.query(`
          SELECT transaction_type AS type, COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS amt
          FROM bar_transactions
          WHERE created_date::date >= $1 AND created_date::date < $2
          GROUP BY 1 ORDER BY 3 DESC`, [start, end]),
        pool.query(`
          SELECT payment_method AS method, COUNT(*)::int AS sales, COALESCE(SUM(total),0) AS total
          FROM merch_sales
          WHERE (created_at ${TZ})::date >= $1 AND (created_at ${TZ})::date < $2
          GROUP BY 1 ORDER BY 3 DESC`, [start, end]),
        pool.query(`
          WITH h AS (
            SELECT generate_series(
              ($1::date)::timestamp, ($2::date)::timestamp - interval '1 hour', interval '1 hour'
            ) AS hr)
          SELECT to_char(h.hr,'YYYY-MM-DD"T"HH24:00') AS slot,
            COALESCE((SELECT SUM(total) FROM kitchen_orders k
                      WHERE k.payment_status='paid'
                        AND date_trunc('hour', k.created_at ${TZ}) = h.hr),0) AS counter,
            COALESCE((SELECT SUM(amount) FROM bar_transactions b
                      WHERE b.transaction_type IN ('drink','refund')
                        AND date_trunc('hour', b.created_date) = h.hr),0) AS bar,
            COALESCE((SELECT SUM(subtotal) FROM merch_sales m
                      WHERE date_trunc('hour', m.created_at ${TZ}) = h.hr),0) AS merch
          FROM h ORDER BY 1`, [start, end]),
        pool.query(`
          SELECT COUNT(*)::int AS orders, COALESCE(SUM(subtotal),0) AS sub,
                 COALESCE(SUM(tax),0) AS tax, COALESCE(SUM(total),0) AS tot
          FROM kitchen_orders
          WHERE payment_status='paid'
            AND (created_at ${TZ})::date >= $1 AND (created_at ${TZ})::date < $2`, [start, end]),
        pool.query(`
          SELECT COUNT(*)::int AS sales, COALESCE(SUM(subtotal),0) AS sub,
                 COALESCE(SUM(tax),0) AS tax, COALESCE(SUM(total),0) AS tot
          FROM merch_sales
          WHERE (created_at ${TZ})::date >= $1 AND (created_at ${TZ})::date < $2`, [start, end]),
      ]);

    // Menu category lookup: "booth|item name" -> category key.
    const catOf = new Map(), catLabel = new Map();
    for (const b of menu.rows) {
      for (const c of (b.categories || [])) catLabel.set(c.key, c.label || c.key);
      for (const mi of (b.menu_items || [])) catOf.set(`${b.booth_id}|${mi.name}`, mi.cat || 'other');
    }

    const counter = counterRows.rows.map(r => {
      const cat = catOf.get(`${r.booth}|${r.item}`) || 'other';
      return {
        booth: r.booth, day: r.day.toISOString().slice(0, 10), item: r.item,
        cat, catLabel: catLabel.get(cat) || cat, isDrink: cat === 'drinks',
        qty: n(r.qty), gross: n(r.gross),
      };
    });

    const rollUp = rows => {
      const m = new Map();
      for (const r of rows) {
        if (!m.has(r.item)) m.set(r.item, { item: r.item, cat: r.catLabel, booth: r.booth, qty: 0, gross: 0 });
        const o = m.get(r.item); o.qty += r.qty; o.gross += r.gross;
      }
      return [...m.values()].sort((a, b) => b.gross - a.gross);
    };
    const foodItems     = rollUp(counter.filter(r => !r.isDrink));
    const counterDrinks = rollUp(counter.filter(r =>  r.isDrink));

    const barDrinks = barRows.rows.map(r => ({
      item: r.item, served: n(r.served), refunded: n(r.refunded),
      gross: n(r.gross), net: n(r.gross) + n(r.refund_amt),
    }));

    const merchByProduct = [...merchRows.rows.reduce((m, r) => {
      if (!m.has(r.product)) m.set(r.product, { product: r.product, qty: 0, gross: 0, variants: [] });
      const o = m.get(r.product);
      o.qty += n(r.qty); o.gross += n(r.gross);
      if (r.variant) o.variants.push({ variant: r.variant, qty: n(r.qty), gross: n(r.gross) });
      return m;
    }, new Map()).values()].sort((a, b) => b.gross - a.gross);

    // Per-day split. Bar and merch come from their own tables so that days with
    // no counter activity still appear.
    const dayMap = new Map();
    const touch = d => {
      if (!dayMap.has(d)) dayMap.set(d, { date: d, food: 0, drinkTicket: 0, drinkBar: 0, merch: 0 });
      return dayMap.get(d);
    };
    for (const r of counter) touch(r.day)[r.isDrink ? 'drinkTicket' : 'food'] += r.gross;
    for (const r of (await pool.query(`
          SELECT created_date::date AS d, SUM(amount) AS v FROM bar_transactions
          WHERE transaction_type IN ('drink','refund')
            AND created_date::date >= $1 AND created_date::date < $2 GROUP BY 1`, [start, end])).rows)
      touch(r.d.toISOString().slice(0, 10)).drinkBar += n(r.v);
    for (const r of (await pool.query(`
          SELECT (created_at ${TZ})::date AS d, SUM(subtotal) AS v FROM merch_sales
          WHERE (created_at ${TZ})::date >= $1 AND (created_at ${TZ})::date < $2 GROUP BY 1`, [start, end])).rows)
      touch(r.d.toISOString().slice(0, 10)).merch += n(r.v);
    const byDay = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

    const kt = ktTotal.rows[0], mt = mtTotal.rows[0];
    const totals = {
      foodItems:      foodItems.reduce((a, r) => a + r.gross, 0),
      foodUnits:      foodItems.reduce((a, r) => a + r.qty, 0),
      drinkTicket:    counterDrinks.reduce((a, r) => a + r.gross, 0),
      drinkTicketQty: counterDrinks.reduce((a, r) => a + r.qty, 0),
      drinkBarNet:    barDrinks.reduce((a, r) => a + r.net, 0),
      drinksServed:   barDrinks.reduce((a, r) => a + r.served, 0),
      drinksRefunded: barDrinks.reduce((a, r) => a + r.refunded, 0),
      merchSub:       n(mt.sub),
      merchUnits:     merchRows.rows.reduce((a, r) => a + n(r.qty), 0),
      counterOrders:  kt.orders,
      merchSales:     mt.sales,
      taxCounter:     n(kt.tax),
      taxMerch:       n(mt.tax),
    };
    totals.combinedPreTax = totals.foodItems + totals.drinkTicket + totals.drinkBarNet + totals.merchSub;
    totals.combined = totals.combinedPreTax + totals.taxCounter + totals.taxMerch;

    res.json({
      window: { start, end },
      generated_at: new Date().toISOString(),
      totals,
      byDay,
      hourly: hourRows.rows.map(r => ({ slot: r.slot, counter: n(r.counter), bar: n(r.bar), merch: n(r.merch) })),
      foodItems,
      counterDrinks,
      barDrinks,
      merchByProduct,
      merchPay: merchPayRows.rows.map(r => ({ method: r.method, sales: r.sales, total: n(r.total) })),
      flow: flowRows.rows.map(r => ({ type: r.type, n: r.n, amt: n(r.amt) })),
    });

  } catch (error) {
    console.error('Event-sales report error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
