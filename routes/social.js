const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const pool = require('../config/database');
const spotlight = require('../lib/spotlight');

// ─── POST /api/social/spotlight/next — post the next spotlight now (admin) ───
// Body { force:true } to post even if one already went out today.
router.post('/spotlight/next', authenticateToken, async (req, res) => {
  try {
    const result = await spotlight.postNextSpotlight({ force: req.body && req.body.force === true });
    res.json(result);
  } catch (err) {
    console.error('POST /social/spotlight/next error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/social/spotlight/preview — who's up next, no posting ───
router.get('/spotlight/preview', authenticateToken, async (req, res) => {
  try {
    const s = await spotlight.selectNextSponsor();
    if (!s) return res.json({ next: null });
    res.json({ next: { name: s.name, level: s.sponsor_level, website: s.website, hasLogo: !!s.logo, lastPosted: s.last_posted } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/social/report — send the weekly status report now (admin) ───
router.post('/report', authenticateToken, async (req, res) => {
  try {
    const r = await spotlight.sendWeeklyReport();
    res.json(r);
  } catch (err) {
    console.error('POST /social/report error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/social/posts — spotlight history ───
router.get('/posts', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT sp.id, s.name, sp.platform, sp.fb_post_id, sp.image_url, sp.posted_at
         FROM social_posts sp JOIN sponsors s ON s.id = sp.sponsor_id
        ORDER BY sp.posted_at DESC LIMIT 100`);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
