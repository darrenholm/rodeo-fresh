const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
const { authenticateToken } = require('../middleware/auth');
const { getCreditCap } = require('../lib/creditCap');

// ── Auth helper ──
function requireRole(roles) {
  return (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userRoles = decoded.roles || [];
      console.log(`[requireRole] email=${decoded.email} roles=${JSON.stringify(userRoles)} required=${JSON.stringify(roles)}`);
      if (!roles.some(r => userRoles.includes(r))) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      req.staff = decoded;
      next();
    } catch (e) {
      console.log(`[requireRole] token error: ${e.message}`);
      res.status(401).json({ error: 'Invalid token' });
    }
  };
}

// ============================================
// POST /api/stripe/connection-token
// ============================================
router.post('/connection-token', async (req, res) => {
  try {
    const connectionToken = await stripe.terminal.connectionTokens.create();
    res.json({ secret: connectionToken.secret });
  } catch (error) {
    console.error('[Stripe Terminal] Connection token error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/stripe/create-payment-intent
// ============================================
router.post('/create-payment-intent', authenticateToken, async (req, res) => {
  try {
    const { amount, rfid_uid, tickets, credit_amount, metadata: clientMetadata } = req.body;
    if (!amount) return res.status(400).json({ error: 'amount required' });

    // AGCO cap on credit loads (dollars, per purchase) — suspendable via feature flag
    const creditCents = parseInt(credit_amount || 0);
    if (creditCents > 0) {
      const cap = await getCreditCap(pool);
      if (cap != null && creditCents > cap * 100) {
        return res.status(400).json({
          error: `Credit purchases are limited to $${cap} each (AGCO). Choose a smaller amount.`,
          limit: cap
        });
      }
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: parseInt(amount),
      currency: 'cad',
      payment_method_types: ['card_present', 'interac_present'],
      capture_method: 'manual',
      metadata: {
        source: 'rodeo_kiosk',
        ...(clientMetadata || {}),
        rfid_uid: String(rfid_uid || ''),
        tickets: String(tickets || 0),
        credit_amount: String(credit_amount || 0)
      }
    });

    console.log(`[Stripe Terminal] PaymentIntent created: ${paymentIntent.id} $${(amount/100).toFixed(2)}`);
    res.json({ client_secret: paymentIntent.client_secret, payment_intent_id: paymentIntent.id });
  } catch (error) {
    console.error('[Stripe Terminal] PaymentIntent error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/stripe/capture-payment
// ============================================
router.post('/capture-payment', authenticateToken, async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    if (!payment_intent_id) return res.status(400).json({ error: 'payment_intent_id required' });

    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
    const rfidUid = paymentIntent.metadata?.rfid_uid;
    const tickets = parseInt(paymentIntent.metadata?.tickets || 0);
    const creditAmountCents = parseInt(paymentIntent.metadata?.credit_amount || 0);
    const amount = creditAmountCents > 0 ? creditAmountCents / 100 : tickets * 7;

    if (paymentIntent.status === 'requires_capture') {
      await stripe.paymentIntents.capture(payment_intent_id);
      console.log(`[Stripe Terminal] Payment captured: ${payment_intent_id} rfid=${rfidUid} amount=$${amount}`);
    } else {
      console.log(`[Stripe Terminal] Payment already captured: ${payment_intent_id}`);
    }

    try {
      await pool.query(
        `INSERT INTO stripe_payments (payment_intent_id, rfid_uid, tickets, amount, status)
         VALUES ($1, $2, $3, $4, 'captured')
         ON CONFLICT (payment_intent_id) DO NOTHING`,
        [payment_intent_id, rfidUid || '', tickets, paymentIntent.amount]
      );
    } catch (e) {
      console.error('[Stripe] Failed to save payment record:', e.message);
    }

    if (rfidUid && amount > 0) {
      await pool.query(
        'UPDATE wristbands SET credits = credits + $1 WHERE UPPER(rfid_uid) = $2',
        [amount, rfidUid.toUpperCase()]
      );
      console.log(`✓ Stripe Terminal: Added $${amount} to wristband ${rfidUid}`);
    }

    res.json({ success: true, tickets, amount, rfid_uid: rfidUid });
  } catch (error) {
    console.error('[Stripe Terminal] Capture error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// GET /api/stripe/payment-lookup
// ============================================
router.get('/payment-lookup', requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query required' });
    console.log(`[Payment Lookup] query=${q} staff=${req.staff?.email}`);

    let paymentIntentIds = [];

    if (q.startsWith('pi_')) {
      paymentIntentIds = [q];
    } else {
      const result = await pool.query(
        `SELECT payment_intent_id FROM stripe_payments 
         WHERE UPPER(rfid_uid) = UPPER($1)
         ORDER BY created_at DESC LIMIT 20`,
        [q]
      );
      paymentIntentIds = result.rows.map(r => r.payment_intent_id);
    }

    if (paymentIntentIds.length === 0) {
      return res.json({ payments: [] });
    }

    const formatted = await Promise.all(paymentIntentIds.map(async (id) => {
      try {
        const pi = await stripe.paymentIntents.retrieve(id);
        const charges = await stripe.charges.list({ payment_intent: id, limit: 1 });
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
      } catch (e) {
        return null;
      }
    }));

    res.json({ payments: formatted.filter(Boolean) });
  } catch (error) {
    console.error('[Payment Lookup] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/stripe/refund
// ============================================
router.post('/refund', requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const { payment_intent_id, refund_tickets } = req.body;
    if (!payment_intent_id) return res.status(400).json({ error: 'payment_intent_id required' });

    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
    const rfidUid = paymentIntent.metadata?.rfid_uid;
    const totalTickets = parseInt(paymentIntent.metadata?.tickets || 0);
    const ticketsToRefund = refund_tickets ? parseInt(refund_tickets) : totalTickets;
    const refundAmount = ticketsToRefund * 700;

    const charges = await stripe.charges.list({ payment_intent: payment_intent_id });
    if (!charges.data.length) return res.status(404).json({ error: 'No charge found' });

    const charge = charges.data[0];
    if (charge.refunded) return res.status(400).json({ error: 'Payment already fully refunded' });

    const refund = await stripe.refunds.create({
      charge: charge.id,
      amount: refundAmount,
      reason: 'requested_by_customer',
      metadata: {
        refunded_by: req.staff.email,
        refunded_tickets: ticketsToRefund,
        rfid_uid: rfidUid || ''
      }
    });

    console.log(`[Stripe Refund] ${refund.id} $${(refundAmount/100).toFixed(2)} by ${req.staff.email}`);

    try {
      await pool.query(
        `UPDATE stripe_payments SET refunded = TRUE, refund_id = $1 WHERE payment_intent_id = $2`,
        [refund.id, payment_intent_id]
      );
    } catch (e) {
      console.error('[Stripe] Failed to update refund record:', e.message);
    }

    if (rfidUid && ticketsToRefund > 0) {
      await pool.query(
        'UPDATE wristbands SET credits = GREATEST(0, credits - $1) WHERE UPPER(rfid_uid) = $2',
        [ticketsToRefund * 7, rfidUid.toUpperCase()]
      );
    }

    res.json({ success: true, refund_id: refund.id, amount_refunded: refundAmount, tickets_refunded: ticketsToRefund });
  } catch (error) {
    console.error('[Stripe Refund] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/stripe/refund-confirm
// Called after Terminal SDK processes card-present refund
// Just updates our database — Stripe refund already done by Terminal SDK
// ============================================
router.post('/refund-confirm', requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const { payment_intent_id, refund_tickets } = req.body;
    console.log(`[Refund Confirm] pi=${payment_intent_id} tickets=${refund_tickets} staff=${req.staff?.email}`);
    if (!payment_intent_id) return res.status(400).json({ error: 'payment_intent_id required' });

    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
    const rfidUid = paymentIntent.metadata?.rfid_uid;
    const ticketsToRefund = refund_tickets ? parseInt(refund_tickets) : parseInt(paymentIntent.metadata?.tickets || 0);
    const creditsToReverse = ticketsToRefund * 7;

    await pool.query(
      `UPDATE stripe_payments SET refunded = TRUE WHERE payment_intent_id = $1`,
      [payment_intent_id]
    ).catch(e => console.error('DB update error:', e.message));

    if (rfidUid && ticketsToRefund > 0) {
      await pool.query(
        'UPDATE wristbands SET credits = GREATEST(0, credits - $1) WHERE UPPER(rfid_uid) = $2',
        [creditsToReverse, rfidUid.toUpperCase()]
      );
      console.log(`✓ Reversed ${creditsToReverse} credits from wristband ${rfidUid}`);
    }

    res.json({ success: true, tickets_refunded: ticketsToRefund, credits_reversed: creditsToReverse });
  } catch (error) {
    console.error('[Refund Confirm] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/stripe/webhook
// ============================================
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Stripe Webhook] Signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const rfidUid = pi.metadata?.rfid_uid;
    const tickets = parseInt(pi.metadata?.tickets || 0);
    const creditAmountCents = parseInt(pi.metadata?.credit_amount || 0);
    const amount = creditAmountCents > 0 ? creditAmountCents / 100 : tickets * 7;

    if (rfidUid && amount > 0) {
      try {
        await pool.query(
          'UPDATE wristbands SET credits = credits + $1 WHERE UPPER(rfid_uid) = $2',
          [amount, rfidUid.toUpperCase()]
        );
        console.log(`✓ Stripe Webhook: Added $${amount} to wristband ${rfidUid}`);
      } catch (err) {
        console.error('[Stripe Webhook] DB error:', err.message);
      }
    }
  }

  res.json({ received: true });
});

module.exports = router;
