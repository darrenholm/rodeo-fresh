const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ============================================
// POST /api/stripe/connection-token
// Gives the kiosk permission to use the reader
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
// Creates a payment intent for the terminal
// ============================================
router.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, rfid_uid, tickets } = req.body;
    if (!amount) return res.status(400).json({ error: 'amount required' });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: parseInt(amount), // in cents
      currency: 'cad',
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      metadata: {
        rfid_uid: rfid_uid || '',
        tickets: tickets || 0,
        source: 'rodeo_kiosk'
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
// Called after reader collects payment
// Adds credits to wristband
// ============================================
router.post('/capture-payment', async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    if (!payment_intent_id) return res.status(400).json({ error: 'payment_intent_id required' });

    // Retrieve to get metadata
    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
    const rfidUid = paymentIntent.metadata?.rfid_uid;
    const tickets = parseInt(paymentIntent.metadata?.tickets || 0);
    const amount = tickets * 7;

    console.log(`[Stripe Terminal] Payment captured: ${payment_intent_id} rfid=${rfidUid} tickets=${tickets}`);

    // Add credits to wristband
    if (rfidUid && tickets > 0) {
      await pool.query(
        'UPDATE wristbands SET credits = credits + $1 WHERE UPPER(rfid_uid) = $2',
        [amount, rfidUid.toUpperCase()]
      );
      console.log(`✓ Stripe Terminal: Added ${tickets} tickets ($${amount}) to wristband ${rfidUid}`);
    }

    res.json({ success: true, tickets, rfid_uid: rfidUid });
  } catch (error) {
    console.error('[Stripe Terminal] Capture error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/stripe/webhook
// Stripe sends payment_intent.succeeded here
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
    const amount = tickets * 7;

    if (rfidUid && tickets > 0) {
      try {
        await pool.query(
          'UPDATE wristbands SET credits = credits + $1 WHERE UPPER(rfid_uid) = $2',
          [amount, rfidUid.toUpperCase()]
        );
        console.log(`✓ Stripe Webhook: Added ${tickets} tickets to wristband ${rfidUid}`);
      } catch (err) {
        console.error('[Stripe Webhook] DB error:', err.message);
      }
    }
  }

  res.json({ received: true });
});

module.exports = router;
