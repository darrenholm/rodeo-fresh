const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const QRCode = require('qrcode');

const MONERIS_PRELOAD_URL = 'https://gateway.moneris.com/chkt/request/request.php';

// In-memory store for pending checkout data (cleared after use)
const pendingCheckouts = new Map();

// Clean up abandoned checkouts older than 1 hour
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [code, data] of pendingCheckouts.entries()) {
    if (data.createdAt < oneHourAgo) {
      pendingCheckouts.delete(code);
      console.log(`Cleaned up abandoned checkout: ${code}`);
    }
  }
}, 15 * 60 * 1000);

function getMonerisCredentials() {
  const storeId = process.env.MONERIS_STORE_ID;
  const apiToken = process.env.MONERIS_API_TOKEN;
  const checkoutId = process.env.MONERIS_CHECKOUT_ID;
  if (!storeId || !apiToken || !checkoutId) {
    throw new Error('Moneris credentials not configured');
  }
  return { storeId, apiToken, checkoutId };
}

async function monerisPreload(data) {
  const response = await fetch(MONERIS_PRELOAD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Moneris API error: ${response.status} - ${errorText}`);
  }
  const result = await response.json();
  if (!result.response || result.response.success !== 'true' || !result.response.ticket) {
    throw new Error('Failed to create Moneris checkout: ' + JSON.stringify(result));
  }
  return result.response.ticket;
}

// ============================================
// POST /api/moneris/ticket-checkout
// ============================================
router.post('/ticket-checkout', async (req, res) => {
  try {
    const { tickets, barTickets, barCredits, eventId, customerEmail, customerName, customerPhone } = req.body;

    if (!tickets || !eventId || !customerEmail || !customerName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const totalQuantity = (tickets.general || 0) + (tickets.child || 0) + (tickets.family || 0);
    if (totalQuantity === 0) {
      return res.status(400).json({ error: 'No tickets selected' });
    }

    const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    const event = eventResult.rows[0];

    const ticketsSold = event.tickets_sold || 0;
    let currentTier = 1;
    if (ticketsSold >= event.tier2_quantity) {
      currentTier = 3;
    } else if (ticketsSold >= event.tier1_quantity) {
      currentTier = 2;
    }

    const adultPrice = parseFloat(event[`tier${currentTier}_adult_price`] || '30');
    const childPrice = 10;
    const familyPrice = parseFloat(event[`tier${currentTier}_family_price`] || '70');

    const generalSubtotal = (tickets.general || 0) * adultPrice;
    const childSubtotal = (tickets.child || 0) * childPrice;
    const familySubtotal = (tickets.family || 0) * familyPrice;
    const barTicketsSubtotal = (barTickets || 0) * 7;
    const subtotal = generalSubtotal + childSubtotal + familySubtotal + barTicketsSubtotal;
    const hst = subtotal * 0.13;
    const total = subtotal + hst;

    const quantityAdult = (tickets.general || 0) + ((tickets.family || 0) * 2);
    const quantityChild = (tickets.child || 0) + ((tickets.family || 0) * 2);

    const confirmationCode = `WW-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;

    // Store pending checkout data first
    pendingCheckouts.set(confirmationCode, {
      createdAt: Date.now(),
      eventId,
      quantityAdult,
      quantityChild,
      customerName,
      customerEmail,
      customerPhone: customerPhone || '',
      total: total.toFixed(2),
      barCredits: barCredits || 0,
      monerisTicket: null // will be set after preload
    });

    const { storeId, apiToken, checkoutId } = getMonerisCredentials();
    const monerisTicket = await monerisPreload({
      store_id: storeId,
      api_token: apiToken,
      checkout_id: checkoutId,
      txn_total: total.toFixed(2),
      cart_subtotal: subtotal.toFixed(2),
      tax: { amount: hst.toFixed(2), description: 'HST', rate: '13.00' },
      environment: 'prod',
      action: 'preload',
      order_no: confirmationCode,
      cust_id: customerEmail,
      contact_details: {
        email: customerEmail,
        first_name: customerName.split(' ')[0] || customerName,
        last_name: customerName.split(' ').slice(1).join(' ') || ''
      }
    });

    // Save the Moneris ticket token for receipt verification later
    const checkoutEntry = pendingCheckouts.get(confirmationCode);
    checkoutEntry.monerisTicket = monerisTicket;
    pendingCheckouts.set(confirmationCode, checkoutEntry);

    console.log(`✓ Moneris checkout created: ${confirmationCode}, total: $${total.toFixed(2)}, monerisTicket: ${monerisTicket}`);
    res.json({ ticket: monerisTicket, confirmation_code: confirmationCode });
  } catch (error) {
    console.error('Ticket checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/moneris/confirm-payment
// ============================================
router.post('/confirm-payment', async (req, res) => {
  try {
    const { confirmation_code } = req.body;
    if (!confirmation_code) {
      return res.status(400).json({ error: 'Confirmation code required' });
    }

    // Check for duplicate order
    const existingOrder = await pool.query(
      'SELECT * FROM ticket_orders WHERE confirmation_code = $1',
      [confirmation_code]
    );
    if (existingOrder.rows.length > 0) {
      console.log(`Order ${confirmation_code} already exists, skipping duplicate`);
      return res.json({ success: true, message: 'Order already confirmed', confirmation_code });
    }

    const checkoutData = pendingCheckouts.get(confirmation_code);
    if (!checkoutData) {
      console.error(`No pending checkout found for: ${confirmation_code}`);
      return res.status(404).json({ error: 'Checkout session not found or expired' });
    }

    if (!checkoutData.monerisTicket) {
      console.error(`No Moneris ticket token found for: ${confirmation_code}`);
      return res.status(400).json({ error: 'Missing Moneris ticket token' });
    }

    // ── Verify payment with Moneris using the saved ticket token ──
    const { storeId, apiToken, checkoutId } = getMonerisCredentials();
    const verifyResponse = await fetch(MONERIS_PRELOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store_id: storeId,
        api_token: apiToken,
        checkout_id: checkoutId,
        action: 'receipt',
        ticket: checkoutData.monerisTicket,
        environment: 'prod'
      })
    });

    const verifyResult = await verifyResponse.json();
    console.log(`[Moneris Receipt] ${confirmation_code}:`, JSON.stringify(verifyResult));

    const paymentSuccess = verifyResult?.response?.success === 'true' &&
                       verifyResult?.receipt?.result === 'a';

    if (!paymentSuccess) {
      console.log(`[Moneris] Payment NOT approved for ${confirmation_code}, result: ${verifyResult?.response?.result}`);
      pendingCheckouts.delete(confirmation_code);
      return res.status(402).json({ error: 'Payment was not approved by Moneris' });
    }

    console.log(`[Moneris] Payment verified for ${confirmation_code}`);

    // Create the order
    const id = `ticket_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const orderResult = await pool.query(
      `INSERT INTO ticket_orders (
        id, event_id, ticket_type, quantity_adult, quantity_child,
        customer_name, customer_email, customer_phone,
        confirmation_code, status, payment_status, total_price,
        bar_credits, created_date, updated_date, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW(), 'web')
      RETURNING *`,
      [
        id, checkoutData.eventId, 'mixed',
        checkoutData.quantityAdult, checkoutData.quantityChild,
        checkoutData.customerName, checkoutData.customerEmail, checkoutData.customerPhone,
        confirmation_code, 'confirmed', 'paid', checkoutData.total, checkoutData.barCredits
      ]
    );
    const ticket = orderResult.rows[0];

    const totalQuantity = (checkoutData.quantityAdult || 0) + (checkoutData.quantityChild || 0);
    await pool.query(
      'UPDATE events SET tickets_sold = COALESCE(tickets_sold, 0) + $1 WHERE id = $2',
      [totalQuantity, checkoutData.eventId]
    );

    // Send confirmation email
    try {
      const apiKey = process.env.RESEND_API_KEY;
      const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

      if (apiKey) {
        const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [checkoutData.eventId]);
        const event = eventResult.rows.length > 0 ? eventResult.rows[0] : null;

        const qrDataUrl = await QRCode.toDataURL(confirmation_code, {
          width: 200, margin: 2,
          color: { dark: '#000000', light: '#ffffff' }
        });

        const eventDate = event
          ? new Date(event.date).toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
          : 'TBD';

        let ticketLines = [];
        if (ticket.quantity_adult > 0) ticketLines.push(`${ticket.quantity_adult}x Adult Ticket`);
        if (ticket.quantity_child > 0) ticketLines.push(`${ticket.quantity_child}x Child Ticket`);

        const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:Arial,sans-serif;">
<div style="max-width:500px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
  <div style="background:#1c1917;padding:24px;text-align:center;">
    <h1 style="margin:0;color:#facc15;font-size:24px;letter-spacing:2px;">🤠 HOLMDALE PRO RODEO</h1>
    <p style="margin:8px 0 0;color:#a8a29e;font-size:14px;">Your Ticket Confirmation</p>
  </div>
  <div style="text-align:center;padding:24px;">
    <img src="${qrDataUrl}" alt="QR Code" style="width:180px;height:180px;border:4px solid #1c1917;border-radius:12px;">
    <div style="margin-top:12px;font-size:24px;font-weight:bold;color:#1c1917;letter-spacing:3px;">${confirmation_code}</div>
    <p style="color:#78716c;font-size:12px;margin:4px 0 0;">Show this QR code at the gate</p>
  </div>
  <div style="padding:0 24px 20px;">
    <div style="background:#f5f5f4;border-radius:10px;padding:16px;">
      <h2 style="margin:0 0 12px;color:#1c1917;font-size:18px;">${event ? event.title : 'Holmdale Pro Rodeo'}</h2>
      <table style="width:100%;font-size:14px;color:#44403c;">
        <tr><td style="padding:4px 0;font-weight:bold;">📅 Date</td><td>${eventDate}</td></tr>
        <tr><td style="padding:4px 0;font-weight:bold;">🕐 Time</td><td>${event ? event.time : ''}</td></tr>
        <tr><td style="padding:4px 0;font-weight:bold;">📍 Venue</td><td>${event ? event.venue : 'Holmdale Rodeo Grounds'}</td></tr>
      </table>
    </div>
  </div>
  <div style="padding:0 24px 20px;">
    <div style="border-top:1px solid #e7e5e4;padding-top:16px;">
      <h3 style="margin:0 0 8px;color:#1c1917;font-size:16px;">Order Details</h3>
      <table style="width:100%;font-size:14px;color:#44403c;">
        <tr><td style="padding:4px 0;font-weight:bold;">Name</td><td>${ticket.customer_name}</td></tr>
        <tr><td style="padding:4px 0;font-weight:bold;">Tickets</td><td>${ticketLines.join('<br>')}</td></tr>
        <tr><td style="padding:4px 0;font-weight:bold;">Total</td><td style="font-size:18px;font-weight:bold;color:#16a34a;">$${parseFloat(ticket.total_price).toFixed(2)}</td></tr>
      </table>
    </div>
  </div>
  <div style="background:#1c1917;padding:16px 24px;text-align:center;">
    <p style="margin:0;color:#a8a29e;font-size:12px;">Holmdale Rodeo Grounds — Walkerton, Ontario<br>Questions? Contact us at info@holmdalerodeo.ca</p>
  </div>
</div>
</body></html>`;

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from, to: [checkoutData.customerEmail],
            subject: `🎟 Your Holmdale Pro Rodeo Tickets — ${confirmation_code}`, html
          })
        });

        await pool.query(
          'UPDATE ticket_orders SET payment_status = $1, updated_date = NOW() WHERE id = $2',
          ['confirmed_emailed', id]
        );
        console.log(`✓ Email sent for ${confirmation_code}`);
      }
    } catch (emailErr) {
      console.error('Email failed (order still confirmed):', emailErr.message);
    }

    pendingCheckouts.delete(confirmation_code);
    console.log(`✓ Payment confirmed: ${confirmation_code}`);
    res.json({ success: true, confirmation_code, message: 'Payment confirmed and ticket created' });
  } catch (error) {
    console.error('Confirm payment error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/moneris/webhook
// ============================================
router.post('/webhook', async (req, res) => {
  try {
    const data = req.body;
    console.log('Moneris webhook received:', JSON.stringify(data));

    const orderNo = data.order_no || data.response?.order_no;
    const success = data.success === 'true' || data.response?.success === 'true';

    if (!orderNo) return res.status(400).json({ error: 'Missing order_no' });

    if (success) {
      const existing = await pool.query(
        'SELECT * FROM ticket_orders WHERE confirmation_code = $1', [orderNo]
      );
      if (existing.rows.length > 0) {
        await pool.query(
          `UPDATE ticket_orders SET status = 'confirmed', payment_status = 'paid', updated_date = NOW()
           WHERE confirmation_code = $1 AND status != 'confirmed'`, [orderNo]
        );
      } else {
        const checkoutData = pendingCheckouts.get(orderNo);
        if (checkoutData) {
          const id = `ticket_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          await pool.query(
            `INSERT INTO ticket_orders (
              id, event_id, ticket_type, quantity_adult, quantity_child,
              customer_name, customer_email, customer_phone,
              confirmation_code, status, payment_status, total_price,
              created_date, updated_date, created_by
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW(),'webhook')`,
            [id, checkoutData.eventId, 'mixed',
             checkoutData.quantityAdult, checkoutData.quantityChild,
             checkoutData.customerName, checkoutData.customerEmail, checkoutData.customerPhone,
             orderNo, 'confirmed', 'paid', checkoutData.total]
          );
          const totalQuantity = (checkoutData.quantityAdult || 0) + (checkoutData.quantityChild || 0);
          await pool.query(
            'UPDATE events SET tickets_sold = COALESCE(tickets_sold, 0) + $1 WHERE id = $2',
            [totalQuantity, checkoutData.eventId]
          );
          pendingCheckouts.delete(orderNo);
          console.log(`✓ Webhook: created order ${orderNo}`);
        }
      }
    } else {
      pendingCheckouts.delete(orderNo);
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/moneris/terminal-purchase
// ============================================
router.post('/terminal-purchase', async (req, res) => {
  try {
    const { amount, order_id, rfid_uid, tickets } = req.body;
    if (!amount || !order_id) {
      return res.status(400).json({ error: 'amount and order_id are required' });
    }

    const storeId = process.env.MONERIS_TERMINAL_STORE_ID;
    const apiToken = process.env.MONERIS_TERMINAL_API_TOKEN;
    const terminalId = process.env.MONERIS_TERMINAL_ID;
    const testMode = process.env.MONERIS_TEST_MODE === 'true';

    if (!storeId || !apiToken || !terminalId) {
      return res.status(500).json({ error: 'Moneris terminal credentials not configured' });
    }

    const baseUrl = testMode
      ? 'https://ippostest.moneris.com/v3/Terminal'
      : 'https://ippos.moneris.com/v3/Terminal';

    const amountDollars = (parseInt(amount, 10) / 100).toFixed(2);

    const enrichedOrderId = rfid_uid && tickets
      ? `RODEO-${Date.now()}-${rfid_uid}-${tickets}`
      : order_id;

    const requestBody = {
      store_id: storeId,
      api_token: apiToken,
      action: 'purchase',
      totalAmount: amountDollars,
      orderId: enrichedOrderId,
      postBackUrl: 'https://rodeo-fresh-production-7348.up.railway.app/api/moneris/terminal-callback'
    };

    console.log(`[Moneris Terminal] Sending: order=${enrichedOrderId} amount=$${amountDollars} url=${baseUrl}/${terminalId} testMode=${testMode}`);

    const monerisResp = await fetch(`${baseUrl}/${terminalId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(60000)
    });

    const respText = await monerisResp.text();
    console.log('[Moneris Terminal] Response:', respText);

    let data = {};
    try { data = JSON.parse(respText); } catch(e) {}

    const responseCode = data?.response?.responseCode || data?.responseCode || '';
    const message = data?.response?.message || data?.message || 'Unknown';
    const approved = monerisResp.ok && (
      responseCode === '00' || responseCode === '000' ||
      data?.response?.approved === 'true' || data?.approved === 'true'
    );

    if (approved) {
      console.log(`[Moneris Terminal] Approved: ${responseCode}`);
      return res.json({ success: true, message, responseCode });
    } else {
      console.warn(`[Moneris Terminal] Declined: ${responseCode} - ${message}`);
      return res.status(402).json({ error: message || 'Transaction declined', responseCode });
    }
  } catch (error) {
    console.error('[Moneris Terminal] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/moneris/terminal-callback
// ============================================
router.post('/terminal-callback', async (req, res) => {
  try {
    console.log('[Moneris Terminal Callback]', JSON.stringify(req.body));
    const data = req.body;

    res.status(200).json({ received: true });

    const responseCode = data?.response?.responseCode || data?.responseCode || '';
    const approved = responseCode === '00' || responseCode === '000' || data?.response?.approved === 'true';

    if (!approved) {
      console.log('[Terminal Callback] Payment not approved, code:', responseCode);
      return;
    }

    const orderId = data?.response?.orderId || data?.response?.order_id || data?.orderId || '';
    console.log('[Terminal Callback] Approved! Order:', orderId);

    const parts = orderId.split('-');
    if (parts.length >= 4) {
      const rfidUid = parts[2];
      const tickets = parseInt(parts[3]);
      const amount = tickets * 7;

      if (rfidUid && tickets > 0) {
        await pool.query(
          'UPDATE wristbands SET credits = credits + $1 WHERE UPPER(rfid_uid) = $2',
          [amount, rfidUid.toUpperCase()]
        );
        console.log(`✓ Terminal: Added ${tickets} tickets ($${amount}) to wristband ${rfidUid}`);
      }
    }
  } catch (error) {
    console.error('[Terminal Callback] Error:', error);
  }
});

module.exports = router;
