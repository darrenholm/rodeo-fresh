const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const pool = require('../config/database');
const router = express.Router();

// ============================================
// GET /api/dashboard/daily?date=YYYY-MM-DD
// Daily stats for a given date
// ============================================
router.get('/daily', authenticateToken, async (req, res) => {
    try {
        const date = req.query.date || new Date().toISOString().split('T')[0];

        // 1. Ticket orders for this date
        const ticketResult = await pool.query(`
            SELECT
                COUNT(*) as order_count,
                COALESCE(SUM(quantity_adult), 0) as total_adults,
                COALESCE(SUM(quantity_child), 0) as total_children,
                COALESCE(SUM(total_price::numeric), 0) as ticket_revenue,
                COALESCE(SUM(
                    CASE
                        WHEN LOWER(ticket_type) LIKE '%family%' THEN 4
                        ELSE COALESCE(quantity_adult, 0) + COALESCE(quantity_child, 0)
                    END
                ), 0) as people_counted
            FROM ticket_orders
            WHERE created_date::date = $1
              AND status IN ('confirmed', 'paid')
        `, [date]);

        // 2. Ticket breakdown by type
        const ticketBreakdown = await pool.query(`
            SELECT
                COALESCE(ticket_type, 'Standard') as ticket_type,
                COUNT(*) as order_count,
                COALESCE(SUM(quantity_adult), 0) as adults,
                COALESCE(SUM(quantity_child), 0) as children,
                COALESCE(SUM(
                    CASE
                        WHEN LOWER(ticket_type) LIKE '%family%' THEN 4
                        ELSE COALESCE(quantity_adult, 0) + COALESCE(quantity_child, 0)
                    END
                ), 0) as people,
                COALESCE(SUM(total_price::numeric), 0) as revenue
            FROM ticket_orders
            WHERE created_date::date = $1
              AND status IN ('confirmed', 'paid')
            GROUP BY ticket_type
            ORDER BY revenue DESC
        `, [date]);

        // 3. Gate check-ins (wristbands scanned at gate)
        const gateResult = await pool.query(`
            SELECT COUNT(*) as gate_checkins
            FROM wristbands
            WHERE created_date::date = $1
        `, [date]);

        // 4. Drink ticket sales (credits purchased on wristbands)
        const drinkTicketsResult = await pool.query(`
            SELECT COALESCE(SUM(credits), 0) as drink_tickets_sold
            FROM wristbands
            WHERE created_date::date = $1
        `, [date]);

        // 5. Drinks served (bar purchases / transactions)
        let drinksServed = 0;
        try {
            const barResult = await pool.query(`
                SELECT COALESCE(SUM(quantity), 0) as drinks_served
                FROM bar_purchases
                WHERE created_at::date = $1
            `, [date]);
            drinksServed = parseInt(barResult.rows[0].drinks_served) || 0;
        } catch(e) {
            // Try bar_transactions if bar_purchases doesn't have quantity
            try {
                const barResult2 = await pool.query(`
                    SELECT COUNT(*) as drinks_served
                    FROM bar_transactions
                    WHERE created_at::date = $1
                `, [date]);
                drinksServed = parseInt(barResult2.rows[0].drinks_served) || 0;
            } catch(e2) { /* table may not exist yet */ }
        }

        // 6. Food revenue (kitchen orders)
        let foodRevenue = 0;
        try {
            const foodResult = await pool.query(`
                SELECT COALESCE(SUM(total::numeric), 0) as food_revenue
                FROM kitchen_orders
                WHERE created_at::date = $1
                  AND status != 'cancelled'
            `, [date]);
            foodRevenue = parseFloat(foodResult.rows[0].food_revenue) || 0;
        } catch(e) {
            // Try orders table as fallback
            try {
                const foodResult2 = await pool.query(`
                    SELECT COALESCE(SUM(total_amount::numeric), 0) as food_revenue
                    FROM orders
                    WHERE created_date::date = $1
                      AND order_type = 'food'
                `, [date]);
                foodRevenue = parseFloat(foodResult2.rows[0].food_revenue) || 0;
            } catch(e2) { /* table may not exist yet */ }
        }

        // 7. Merchandise revenue
        let merchRevenue = 0;
        try {
            const merchResult = await pool.query(`
                SELECT COALESCE(SUM(total::numeric), 0) as merch_revenue
                FROM merch_sales
                WHERE created_at::date = $1
            `, [date]);
            merchRevenue = parseFloat(merchResult.rows[0].merch_revenue) || 0;
        } catch(e) { /* table may not exist yet */ }

        const t = ticketResult.rows[0];

        res.json({
            date,
            tickets_sold: parseInt(t.order_count) || 0,
            people_counted: parseInt(t.people_counted) || 0,
            ticket_revenue: parseFloat(t.ticket_revenue) || 0,
            gate_checkins: parseInt(gateResult.rows[0].gate_checkins) || 0,
            drink_tickets_sold: parseInt(drinkTicketsResult.rows[0].drink_tickets_sold) || 0,
            drinks_served: drinksServed,
            food_revenue: foodRevenue,
            merch_revenue: merchRevenue,
            ticket_breakdown: ticketBreakdown.rows
        });

    } catch (error) {
        console.error('Daily dashboard error:', error);
        res.status(500).json({ error: 'Failed to fetch daily stats' });
    }
});

// ============================================
// GET /api/dashboard/stats (existing endpoint)
// ============================================
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const staffCount = await pool.query('SELECT COUNT(*) as count FROM staff');
        const eventsCount = await pool.query('SELECT COUNT(*) as count FROM events');
        const upcomingEvents = await pool.query(
            'SELECT COUNT(*) as count FROM events WHERE date >= NOW()'
        );
        const ticketOrders = await pool.query('SELECT COUNT(*) as count, SUM(total_price) as revenue FROM ticket_orders');
        const productOrders = await pool.query('SELECT COUNT(*) as count, SUM(total_amount) as revenue FROM orders');
        const recentTickets = await pool.query(
            'SELECT * FROM ticket_orders ORDER BY created_date DESC LIMIT 10'
        );
        const recentOrders = await pool.query(
            'SELECT * FROM orders ORDER BY created_date DESC LIMIT 10'
        );

        res.json({
            staff: { total: parseInt(staffCount.rows[0].count) },
            events: {
                total: parseInt(eventsCount.rows[0].count),
                upcoming: parseInt(upcomingEvents.rows[0].count)
            },
            tickets: {
                total: parseInt(ticketOrders.rows[0].count),
                revenue: parseFloat(ticketOrders.rows[0].revenue || 0)
            },
            orders: {
                total: parseInt(productOrders.rows[0].count),
                revenue: parseFloat(productOrders.rows[0].revenue || 0)
            },
            recent: {
                tickets: recentTickets.rows,
                orders: recentOrders.rows
            }
        });
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard stats' });
    }
});

module.exports = router;
