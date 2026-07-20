const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { resolveUid } = require('../lib/uid');

// ============================================
// DRINK ROUTES
// ============================================

// GET all drinks (for bartender menu)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, price, stock_remaining, active
       FROM drinks
       WHERE active = true
       ORDER BY name`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching drinks:', error);
    res.status(500).json({ error: 'Failed to fetch drinks' });
  }
});

// GET single drink by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM drinks WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Drink not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error serving drink:', error.message, error.stack);
    res.status(500).json({ error: error.message });
}
});

// POST serve drink (deduct from wristband credits AND inventory)
router.post('/serve', authenticateToken, async (req, res) => {
  try {
    const { rfid_uid, drink_id } = req.body;

    if (!rfid_uid || !drink_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Normalize + tolerate legacy wedge-reader UIDs (extra trailing byte)
    const uid = await resolveUid(pool, 'wristbands', rfid_uid);

    // Get drink info
    const drinkResult = await pool.query(
      'SELECT * FROM drinks WHERE id = $1 AND active = true',
      [drink_id]
    );
    if (drinkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Drink not found' });
    }
    const drink = drinkResult.rows[0];

    // Check stock
    if (drink.stock_remaining < 1) {
      return res.status(400).json({ error: 'Drink out of stock' });
    }

    // Get wristband (case insensitive)
    const bandResult = await pool.query(
      'SELECT * FROM wristbands WHERE UPPER(rfid_uid) = UPPER($1)',
      [uid]
    );
    if (bandResult.rows.length === 0) {
      return res.status(404).json({ error: 'Wristband not found' });
    }
    const band = bandResult.rows[0];

    // Check age approval
    if (!band.alcohol_approved) {
      return res.status(403).json({ error: 'Age not verified' });
    }

    // AGCO responsible-service cap: max 2 alcohol servings per visit. The visit
    // counter is reset when staff scans the band (POST /wristbands/start-visit).
    const VISIT_DRINK_LIMIT = 2;
    const servedThisVisit = band.visit_drink_count || 0;
    if (servedThisVisit >= VISIT_DRINK_LIMIT) {
      return res.status(403).json({
        error: `Limit reached: ${VISIT_DRINK_LIMIT} drinks per visit. Re-scan the wristband for another round.`,
        limit_reached: true,
        visit_drink_count: servedThisVisit
      });
    }

    // Check credits
    const bandCredits = parseFloat(band.credits);
    const drinkPrice = parseFloat(drink.price);
    if (bandCredits < drinkPrice) {
      return res.status(400).json({
        error: 'Insufficient credits',
        available: bandCredits,
        required: drinkPrice
      });
    }

    // Deduct credits from wristband + increment the per-visit serving counter
    await pool.query(
      `UPDATE wristbands
       SET credits = credits - $1,
           credits_spent = credits_spent + $1,
           visit_drink_count = COALESCE(visit_drink_count, 0) + 1
       WHERE UPPER(rfid_uid) = UPPER($2)`,
      [drink.price, uid]
    );

    // Deduct from inventory
    await pool.query(
      `UPDATE drinks
       SET stock_remaining = stock_remaining - 1,
           total_sold = total_sold + 1
       WHERE id = $1`,
      [drink_id]
    );

    // Record transaction
    const transactionId = `transaction_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await pool.query(
      `INSERT INTO bar_transactions (
        id, wristband_id, amount, transaction_type, 
        description, drink_name, created_by
      ) VALUES ($1, $2, $3, 'drink', $4, $5, $6)`,
      [
        transactionId,
        band.id,
        drink.price,
        `${drink.name} served`,
        drink.name,
        req.user.email
      ]
    );

    // Get updated wristband (case insensitive)
    const updatedBand = await pool.query(
      'SELECT * FROM wristbands WHERE UPPER(rfid_uid) = UPPER($1)',
      [uid]
    );

    console.log(`✓ Served: ${drink.name} to ${band.customer_name} - $${drink.price}`);

    res.json({
      success: true,
      drink: drink.name,
      amount: drink.price,
      new_balance: updatedBand.rows[0].credits,
      remaining_stock: drink.stock_remaining - 1
    });

  } catch (error) {
    console.error('Error serving drink:', error);
    res.status(500).json({ error: 'Failed to serve drink' });
  }
});

// PUT update drink name and/or price (admin only)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, price } = req.body;
    if (name === undefined && price === undefined) {
      return res.status(400).json({ error: 'Provide name and/or price to update' });
    }
    const setClauses = [];
    const params = [];
    let p = 1;
    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.status(400).json({ error: 'Name cannot be empty' });
      }
      setClauses.push(`name = $${p++}`);
      params.push(String(name).trim());
    }
    if (price !== undefined) {
      const priceNum = parseFloat(price);
      if (isNaN(priceNum) || priceNum < 0) {
        return res.status(400).json({ error: 'Price must be a non-negative number' });
      }
      setClauses.push(`price = $${p++}`);
      params.push(priceNum);
    }
    params.push(id);
    const result = await pool.query(
      `UPDATE drinks SET ${setClauses.join(', ')} WHERE id = $${p} RETURNING *`,
      params
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Drink not found' });
    }
    console.log(`✓ Drink updated: ${result.rows[0].name} (price $${result.rows[0].price})`);
    res.json({ success: true, drink: result.rows[0] });
  } catch (error) {
    console.error('Error updating drink:', error);
    res.status(500).json({ error: 'Failed to update drink' });
  }
});

// PUT update drink inventory (admin only)
router.put('/:id/stock', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { stock_quantity } = req.body;
    if (stock_quantity === undefined) {
      return res.status(400).json({ error: 'Missing stock_quantity' });
    }
    const result = await pool.query(
      `UPDATE drinks
       SET stock_quantity = $1,
           stock_remaining = $1
       WHERE id = $2
       RETURNING *`,
      [stock_quantity, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Drink not found' });
    }
    console.log(`✓ Stock updated: ${result.rows[0].name} = ${stock_quantity}`);
    res.json({ success: true, drink: result.rows[0] });
  } catch (error) {
    console.error('Error updating stock:', error);
    res.status(500).json({ error: 'Failed to update stock' });
  }
});

// POST restock drink (admin - add to existing stock)
router.post('/:id/restock', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;
    if (!quantity) {
      return res.status(400).json({ error: 'Missing quantity' });
    }
    const result = await pool.query(
      `UPDATE drinks
       SET stock_remaining = stock_remaining + $1,
           stock_quantity = stock_quantity + $1
       WHERE id = $2
       RETURNING *`,
      [quantity, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Drink not found' });
    }
    console.log(`✓ Restocked: ${result.rows[0].name} +${quantity}`);
    res.json({ success: true, drink: result.rows[0] });
  } catch (error) {
    console.error('Error restocking:', error);
    res.status(500).json({ error: 'Failed to restock' });
  }
});

// GET inventory report (admin)
router.get('/admin/inventory', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, price, stock_quantity, stock_remaining, 
              total_sold, (stock_quantity - stock_remaining) as sold_percent,
              active
       FROM drinks
       WHERE active = true
       ORDER BY total_sold DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// POST refund drink (undo a serve)
router.post('/refund', authenticateToken, async (req, res) => {
  try {
    const { transaction_id } = req.body;
    if (!transaction_id) {
      return res.status(400).json({ error: 'Missing transaction_id' });
    }

    // Get transaction details
    const transResult = await pool.query(
      'SELECT * FROM bar_transactions WHERE id = $1',
      [transaction_id]
    );
    if (transResult.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    const transaction = transResult.rows[0];

    // Get wristband by ID (numeric)
    const bandResult = await pool.query(
      'SELECT * FROM wristbands WHERE id = $1',
      [transaction.wristband_id]
    );
    if (bandResult.rows.length === 0) {
      return res.status(404).json({ error: 'Wristband not found' });
    }
    const band = bandResult.rows[0];

    // Get drink to restore stock
    const drinkResult = await pool.query(
      'SELECT * FROM drinks WHERE name = $1',
      [transaction.drink_name]
    );

    // Refund credits to wristband
    await pool.query(
      `UPDATE wristbands 
       SET credits = credits + $1,
           credits_spent = credits_spent - $1
       WHERE id = $2`,
      [transaction.amount, band.id]
    );

    // Restore inventory
    if (drinkResult.rows.length > 0) {
      await pool.query(
        `UPDATE drinks
         SET stock_remaining = stock_remaining + 1,
             total_sold = total_sold - 1
         WHERE id = $1`,
        [drinkResult.rows[0].id]
      );
    }

    // Mark transaction as refunded
    await pool.query(
      `UPDATE bar_transactions
       SET description = description || ' (REFUNDED)',
           transaction_type = 'refund'
       WHERE id = $1`,
      [transaction_id]
    );

    // Get updated wristband
    const updatedBand = await pool.query(
      'SELECT * FROM wristbands WHERE id = $1',
      [band.id]
    );

    console.log(`✓ Refunded: ${transaction.drink_name} for ${band.customer_name}`);

    res.json({
      success: true,
      refunded_amount: transaction.amount,
      new_balance: updatedBand.rows[0].credits
    });

  } catch (error) {
    console.error('Error refunding drink:', error);
    res.status(500).json({ error: 'Failed to refund drink' });
  }
});

// POST create new drink (admin only)
router.post('/create', authenticateToken, async (req, res) => {
  try {
    const { id, name, price, stock_quantity } = req.body;
    if (!id || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const result = await pool.query(
      `INSERT INTO drinks (id, name, price, stock_quantity, stock_remaining, active)
       VALUES ($1, $2, $3, $4, $4, true)
       RETURNING *`,
      [id, name, price || 7.00, stock_quantity || 0]
    );
    console.log(`✓ Created drink: ${name}`);
    res.json({ success: true, drink: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Drink already exists' });
    }
    console.error('Error creating drink:', error);
    res.status(500).json({ error: 'Failed to create drink' });
  }
});

// DELETE remove drink (admin only)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE drinks 
       SET active = false
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Drink not found' });
    }
    console.log(`✓ Removed drink: ${result.rows[0].name}`);
    res.json({ success: true, drink: result.rows[0] });
  } catch (error) {
    console.error('Error removing drink:', error);
    res.status(500).json({ error: 'Failed to remove drink' });
  }
});

module.exports = router;
