const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const pool = require('../config/database');
const router = express.Router();

// GET all events
router.get('/', async (req, res) => {
  try {
    const { featured } = req.query;
    let query = 'SELECT * FROM events WHERE 1=1';
    const params = [];
    
    if (featured !== undefined) {
      query += ' AND is_featured = $1';
      params.push(featured === 'true');
    }
    
    query += ' ORDER BY date ASC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// GET single event
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

// POST create event
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  const { title, date, time, description, image_url, venue, general_price, vip_price, general_available, vip_available, is_featured } = req.body;
  try {
    const id = `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const result = await pool.query(
      `INSERT INTO events (id, title, date, time, description, image_url, venue, general_price, vip_price, general_available, vip_available, is_featured, created_date, updated_date, created_by_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW(), $13, $14) RETURNING *`,
      [id, title, date, time, description, image_url, venue, general_price, vip_price, general_available, vip_available, is_featured, req.user.userId, req.user.email]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// PUT update event
router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  const {
    title, date, time, description, image_url, venue,
    general_price, vip_price, general_available, vip_available, is_featured,
    tier1_quantity, tier1_adult_price, tier1_family_price,
    tier2_quantity, tier2_adult_price, tier2_family_price,
    tier3_quantity, tier3_adult_price, tier3_family_price
  } = req.body;
  try {
    const result = await pool.query(
      `UPDATE events SET
         title = $1, date = $2, time = $3, description = $4, image_url = $5, venue = $6,
         general_price = $7, vip_price = $8, general_available = $9, vip_available = $10, is_featured = $11,
         tier1_quantity = COALESCE($12, tier1_quantity),
         tier1_adult_price = COALESCE($13, tier1_adult_price),
         tier1_family_price = COALESCE($14, tier1_family_price),
         tier2_quantity = COALESCE($15, tier2_quantity),
         tier2_adult_price = COALESCE($16, tier2_adult_price),
         tier2_family_price = COALESCE($17, tier2_family_price),
         tier3_quantity = COALESCE($18, tier3_quantity),
         tier3_adult_price = COALESCE($19, tier3_adult_price),
         tier3_family_price = COALESCE($20, tier3_family_price),
         updated_date = NOW()
       WHERE id = $21 RETURNING *`,
      [
        title, date, time, description, image_url, venue,
        general_price, vip_price, general_available, vip_available, is_featured,
        tier1_quantity, tier1_adult_price, tier1_family_price,
        tier2_quantity, tier2_adult_price, tier2_family_price,
        tier3_quantity, tier3_adult_price, tier3_family_price,
        req.params.id
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating event:', error);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// DELETE event
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM events WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json({ message: 'Event deleted successfully', id: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete event' });
  }
});
// POST decrement available tickets
router.post('/:id/decrement-tickets', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity_adult, quantity_child, quantity_family } = req.body;

    console.log(`Decrementing tickets for event ${id}:`, { quantity_adult, quantity_child, quantity_family });

    // Get current event
    const eventResult = await pool.query(
      'SELECT general_available, child_available, family_available FROM events WHERE id = $1',
      [id]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const event = eventResult.rows[0];

    // Calculate new availability
    const newGeneralAvailable = event.general_available - (quantity_adult || 0);
    const newChildAvailable = event.child_available - (quantity_child || 0);
    const newFamilyAvailable = event.family_available - (quantity_family || 0);

    // Prevent negative availability
    if (newGeneralAvailable < 0 || newChildAvailable < 0 || newFamilyAvailable < 0) {
      return res.status(400).json({ error: 'Not enough tickets available' });
    }

    // Determine which tier to increment
    const tierResult = await pool.query(
      'SELECT tickets_sold, tier1_quantity, tier2_quantity FROM events WHERE id = $1', [id]
    );
    const ev = tierResult.rows[0];
    const totalQty = (quantity_adult || 0) + (quantity_child || 0) + ((quantity_family || 0) * 4);
    let tierCol = 'tier1_sold';
    if (ev.tickets_sold >= ev.tier1_quantity + ev.tier2_quantity) {
      tierCol = 'tier3_sold';
    } else if (ev.tickets_sold >= ev.tier1_quantity) {
      tierCol = 'tier2_sold';
    }
    // Update event with availability, tickets_sold, and tier sold count
    const result = await pool.query(
      `UPDATE events SET general_available = $1, child_available = $2, family_available = $3, tickets_sold = tickets_sold + $4, ${tierCol} = ${tierCol} + $4, updated_date = CURRENT_TIMESTAMP WHERE id = $5 RETURNING *`,
      [newGeneralAvailable, newChildAvailable, newFamilyAvailable, totalQty, id]
    );

    console.log(`✓ Tickets decremented. New availability:`, {
      general: newGeneralAvailable,
      child: newChildAvailable,
      family: newFamilyAvailable
    });

    res.json({
      success: true,
      event: result.rows[0]
    });
  } catch (error) {
    console.error('Error decrementing tickets:', error);
    res.status(500).json({ error: 'Failed to decrement tickets', details: error.message });
  }
});
// GET current tier for an event
// Supports both /:id/tier and /:id/current-tier
async function getTierHandler(req, res) {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      `SELECT 
        tickets_sold,
        tier1_adult_price, tier1_family_price, tier1_quantity, tier1_sold,
        tier2_adult_price, tier2_family_price, tier2_quantity, tier2_sold,
        tier3_adult_price, tier3_family_price, tier3_quantity, tier3_sold
       FROM events WHERE id = $1`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const event = result.rows[0];
    
    // Determine current tier
    let currentTier = 1;
    let adultPrice = event.tier1_adult_price;
    let familyPrice = event.tier1_family_price;
    
    if (event.tickets_sold >= event.tier1_quantity + event.tier2_quantity) {
      currentTier = 3;
      adultPrice = event.tier3_adult_price;
      familyPrice = event.tier3_family_price;
    } else if (event.tickets_sold >= event.tier1_quantity) {
      currentTier = 2;
      adultPrice = event.tier2_adult_price;
      familyPrice = event.tier2_family_price;
    }
    
    res.json({
      currentTier,
      adultPrice,
      familyPrice,
      childPrice: 10,
      ticketsSold: event.tickets_sold,
      tiers: {
        tier1: {
          adultPrice: event.tier1_adult_price,
          familyPrice: event.tier1_family_price,
          quantity: event.tier1_quantity,
          sold: event.tier1_sold
        },
        tier2: {
          adultPrice: event.tier2_adult_price,
          familyPrice: event.tier2_family_price,
          quantity: event.tier2_quantity,
          sold: event.tier2_sold
        },
        tier3: {
          adultPrice: event.tier3_adult_price,
          familyPrice: event.tier3_family_price,
          quantity: event.tier3_quantity,
          sold: event.tier3_sold
        }
      }
    });
  } catch (error) {
    console.error('Error getting tier:', error);
    res.status(500).json({ error: 'Failed to get tier' });
  }
}

router.get('/:id/tier', getTierHandler);
router.get('/:id/current-tier', getTierHandler);
module.exports = router;
