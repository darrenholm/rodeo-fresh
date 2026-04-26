// ============================================
// ADD THESE ROUTES TO YOUR EXISTING stripe.js
// ============================================

// ============================================
// POST /api/stripe/refund
// Refunds a payment and reverses wristband credits
// Requires manager or admin role
// ============================================
router.post('/refund', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  let staff;
  try {
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET;
    staff = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const roles = staff.roles || [];
  if (!roles.includes('admin') && !roles.includes('manager')) {
    return res.status(403).json({ error: 'Manager or admin role required' });
  }

  try {
    const { payment_intent_id, refund_tickets } = req.body;
    if (!payment_intent_id) return res.status(400).json({ error: 'payment_intent_id required' });

    // Retrieve payment intent
    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (!paymentIntent) return res.status(404).json({ error: 'Payment not found' });

    const rfidUid = paymentIntent.metadata?.rfid_uid;
    const totalTickets = parseInt(paymentIntent.metadata?.tickets || 0);
    const ticketsToRefund = refund_tickets ? parseInt(refund_tickets) : totalTickets;

    if (ticketsToRefund < 1 || ticketsToRefund > totalTickets) {
      return res.status(400).json({ error: `Invalid ticket count. Max refundable: ${totalTickets}` });
    }

    const refundAmount = ticketsToRefund * 700; // $7.00 CAD per ticket in cents

    // Find the charge to refund
    const charges = await stripe.charges.list({ payment_intent: payment_intent_id });
    if (!charges.data.length) return res.status(404).json({ error: 'No charge found for this payment' });

    const charge = charges.data[0];
    if (charge.refunded) return res.status(400).json({ error: 'Payment already fully refunded' });

    // Issue Stripe refund
    const refund = await stripe.refunds.create({
      charge: charge.id,
      amount: refundAmount,
      reason: 'requested_by_customer',
      metadata: {
        refunded_by: staff.email,
        refunded_tickets: ticketsToRefund,
        rfid_uid: rfidUid || ''
      }
    });

    console.log(`[Stripe Refund] ${refund.id} $${(refundAmount/100).toFixed(2)} by ${staff.email}`);

    // Reverse credits on wristband
    if (rfidUid && ticketsToRefund > 0) {
      await pool.query(
        'UPDATE wristbands SET credits = GREATEST(0, credits - $1) WHERE UPPER(rfid_uid) = $2',
        [ticketsToRefund * 7, rfidUid.toUpperCase()]
      );
      console.log(`✓ Reversed ${ticketsToRefund * 7} credits from wristband ${rfidUid}`);
    }

    res.json({
      success: true,
      refund_id: refund.id,
      amount_refunded: refundAmount,
      tickets_refunded: ticketsToRefund,
      rfid_uid: rfidUid
    });

  } catch (error) {
    console.error('[Stripe Refund] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// GET /api/stripe/payment-lookup
// Look up a payment by intent ID or wristband UID
// Requires manager or admin role
// ============================================
router.get('/payment-lookup', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  let staff;
  try {
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET;
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
      // Search by wristband UID in metadata
      const results = await stripe.paymentIntents.search({
        query: `metadata['rfid_uid']:'${q.toUpperCase()}' AND status:'succeeded'`,
        limit: 10
      });
      payments = results.data;
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
