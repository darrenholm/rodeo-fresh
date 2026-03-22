const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS feature_flags (key VARCHAR(100) PRIMARY KEY, enabled BOOLEAN DEFAULT false, label VARCHAR(200), description VARCHAR(500), updated_at TIMESTAMPTZ DEFAULT NOW(), updated_by VARCHAR(200))`);
    await pool.query(`INSERT INTO feature_flags (key, enabled, label, description) VALUES ('online_admission', false, 'Online Admission Tickets', 'Allow customers to buy admission tickets on holmdalerodeo.ca'), ('online_merchandise', false, 'Online Merchandise', 'Allow customers to buy merchandise on holmdalerodeo.ca'), ('buy_friend_drink', false, 'Buy a Friend a Drink', 'Allow on-site NFC wristband credit transfers between guests') ON CONFLICT (key) DO NOTHING`);
    console.log('Feature flags ready');
  } catch (e) { console.log('Feature flags note:', e.message); }
})();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, enabled, label, description, updated_at, updated_by FROM feature_flags ORDER BY key');
    const flags = {};
    result.rows.forEach(row => { flags[row.key] = { enabled: row.enabled, label: row.label, description: row.description, updated_at: row.updated_at, updated_by: row.updated_by }; });
    res.json(flags);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch feature flags' }); }
});

router.post('/:key', authenticateToken, async (req, res) => {
  try {
    const { key } = req.params;
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
    const result = await pool.query('UPDATE feature_flags SET enabled = $1, updated_at = NOW(), updated_by = $2 WHERE key = $3 RETURNING *', [enabled, req.user && req.user.email || 'admin', key]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Feature flag not found' });
    res.json({ success: true, flag: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed to update feature flag' }); }
});

module.exports = router;
