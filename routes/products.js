const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const pool = require('../config/database');
const router = express.Router();

// GET all products
router.get('/', async (req, res) => {
  try {
    const { category, in_stock } = req.query;
    let query = 'SELECT * FROM products WHERE 1=1';
    const params = [];
    let paramCount = 1;
    
    if (category) {
      query += ` AND category = $${paramCount}`;
      params.push(category);
      paramCount++;
    }
    
    if (in_stock !== undefined) {
      query += ` AND stock > 0`;
    }
    
    query += ' ORDER BY created_date DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// GET single product
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// POST create product
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  const { name, description, category, price, image_url, stripe_price_id, sizes, colors, stock, weight, length, width, height, variant_stock } = req.body;
  try {
    const id = `product_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const result = await pool.query(
      `INSERT INTO products (id, name, description, category, price, image_url, stripe_price_id, sizes, colors, stock, weight, length, width, height, variant_stock, created_date, updated_date, created_by_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW(), $16, $17) RETURNING *`,
      [id, name, description, category, price, image_url, stripe_price_id, JSON.stringify(sizes), JSON.stringify(colors), stock, weight, length, width, height, variant_stock ? JSON.stringify(variant_stock) : null, req.user.userId, req.user.email]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// PUT update product
router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name, description, category, price, image_url, stripe_price_id, sizes, colors, stock, weight, length, width, height, variant_stock } = req.body;
  try {
    const result = await pool.query(
      `UPDATE products SET name = $1, description = $2, category = $3, price = $4, image_url = $5, stripe_price_id = $6, sizes = $7, colors = $8, stock = $9, weight = $10, length = $11, width = $12, height = $13, variant_stock = $14, updated_date = NOW()
       WHERE id = $15 RETURNING *`,
      [name, description, category, price, image_url, stripe_price_id, JSON.stringify(sizes), JSON.stringify(colors), stock, weight, length, width, height, variant_stock ? JSON.stringify(variant_stock) : null, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// DELETE product
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json({ message: 'Product deleted successfully', id: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

module.exports = router;
