router.get('/payment-lookup', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  let staff;
  try {
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'rodeo2026secret';
    staff = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const roles = staff.roles || [];
  if (!roles.includes('admin') && !roles.includes('manager')) {
    return res.status(403).json({ error: 'Manager or admin role required' });
  }

  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query required' });

    let payments = [];

    if (q.startsWith('pi_')) {
      // Direct payment intent lookup
      const pi = await stripe.paymentIntents.retrieve(q);
      payments = [pi];
    } else {
      // Search by wristband UID — query our own database
      const result = await pool.query(
        `SELECT payment_intent_id FROM ticket_orders 
         WHERE UPPER(rfid_uid) = UPPER($1) 
         ORDER BY created_at DESC LIMIT 10`,
        [q]
      );
      const ids = result.rows.map(r => r.payment_intent_id).filter(Boolean);
      payments = await Promise.all(ids.map(id => stripe.paymentIntents.retrieve(id)));
    }

    const formatted = await Promise.all(payments.map(async (pi) => {
      const charges = await stripe.charges.list({ payment_intent: pi.id, limit: 1 });
      const charge = charges.data[0];
      return {
        payment_intent_id: pi.id,
        amount: pi.amount,
        currency: pi.currency,
        status: pi.status,
        created: pi.created,
        rfid_uid: pi.metadata?.rfid_uid || '',
        tickets: parseInt(pi.metadata?.tickets || 0),
        refunded: charge?.refunded || false,
        amount_refunded: charge?.amount_refunded || 0,
        charge_id: charge?.id || null
      };
    }));

    res.json({ payments: formatted });

  } catch (error) {
    console.error('[Payment Lookup] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});
