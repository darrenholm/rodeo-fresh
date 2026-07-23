const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { getCreditCap } = require('../lib/creditCap');
const QRCode = require('qrcode');

const MONERIS_PRELOAD_URL = 'https://gateway.moneris.com/chkt/request/request.php';

const pendingCheckouts = new Map();

// The in-memory map dies on every deploy/restart, which loses in-flight
// checkouts (customer pays at Moneris, confirm-payment finds nothing).
// Mirror ticket checkouts to a DB table so confirm-payment can recover them.
pool.query(`CREATE TABLE IF NOT EXISTS pending_checkouts (
  confirmation_code TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`).catch(err => console.error('pending_checkouts table init failed:', err.message));

async function persistPendingCheckout(code, data) {
  try {
    await pool.query(
      `INSERT INTO pending_checkouts (confirmation_code, data) VALUES ($1, $2)
       ON CONFLICT (confirmation_code) DO UPDATE SET data = $2`,
      [code, JSON.stringify(data)]
    );
  } catch (err) {
    console.error(`Failed to persist pending checkout ${code}:`, err.message);
  }
}

async function loadPendingCheckout(code) {
  try {
    const r = await pool.query('SELECT data FROM pending_checkouts WHERE confirmation_code = $1', [code]);
    return r.rows.length ? r.rows[0].data : null;
  } catch (err) {
    console.error(`Failed to load pending checkout ${code}:`, err.message);
    return null;
  }
}

function deletePendingCheckout(code) {
  pendingCheckouts.delete(code);
  pool.query('DELETE FROM pending_checkouts WHERE confirmation_code = $1', [code])
    .catch(err => console.error(`Failed to delete pending checkout ${code}:`, err.message));
}

setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [code, data] of pendingCheckouts.entries()) {
    if (data.createdAt < oneHourAgo) {
      pendingCheckouts.delete(code);
      console.log(`Cleaned up abandoned checkout: ${code}`);
    }
  }
  // DB rows stick around longer so late confirms survive restarts;
  // anything older than 7 days is genuinely dead.
  pool.query(`DELETE FROM pending_checkouts WHERE created_at < NOW() - INTERVAL '7 days'`)
    .catch(err => console.error('pending_checkouts cleanup failed:', err.message));
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

    // AGCO cap on credit loads (per purchase, dollars) — suspendable via feature flag
    if (barTicketsSubtotal > 0) {
      const cap = await getCreditCap(pool);
      if (cap != null && barTicketsSubtotal > cap) {
        return res.status(400).json({
          error: `Bar credit purchases are limited to $${cap} per order (AGCO). Reduce the drink tickets and try again.`,
          limit: cap
        });
      }
    }
    const subtotal = generalSubtotal + childSubtotal + familySubtotal + barTicketsSubtotal;
    const hst = subtotal * 0.13;
    const total = subtotal + hst;

    const quantityAdult = (tickets.general || 0) + ((tickets.family || 0) * 2);
    const quantityChild = (tickets.child || 0) + ((tickets.family || 0) * 2);

    const confirmationCode = `WW-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;

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
      monerisTicket: null
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

    const checkoutEntry = pendingCheckouts.get(confirmationCode);
    checkoutEntry.monerisTicket = monerisTicket;
    pendingCheckouts.set(confirmationCode, checkoutEntry);
    await persistPendingCheckout(confirmationCode, checkoutEntry);

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

    const existingOrder = await pool.query(
      'SELECT * FROM ticket_orders WHERE confirmation_code = $1',
      [confirmation_code]
    );
    if (existingOrder.rows.length > 0) {
      console.log(`Order ${confirmation_code} already exists, skipping duplicate`);
      return res.json({ success: true, message: 'Order already confirmed', confirmation_code });
    }

    let checkoutData = pendingCheckouts.get(confirmation_code);
    if (!checkoutData) {
      // Server restarted (or >1h passed) since preload — recover from the DB mirror
      checkoutData = await loadPendingCheckout(confirmation_code);
      if (checkoutData) {
        console.log(`Recovered pending checkout from DB: ${confirmation_code}`);
      }
    }
    if (!checkoutData) {
      console.error(`No pending checkout found for: ${confirmation_code}`);
      return res.status(404).json({ error: 'Checkout session not found or expired' });
    }

    if (!checkoutData.monerisTicket) {
      console.error(`No Moneris ticket token found for: ${confirmation_code}`);
      return res.status(400).json({ error: 'Missing Moneris ticket token' });
    }

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
    console.log(`[Moneris Receipt] ${confirmation_code}: result=${verifyResult?.response?.receipt?.result}`);

    const paymentSuccess = verifyResult?.response?.success === 'true' &&
                           verifyResult?.response?.receipt?.result === 'a';

    if (!paymentSuccess) {
      console.log(`[Moneris] Payment NOT approved for ${confirmation_code}, result: ${verifyResult?.response?.result}`);
      deletePendingCheckout(confirmation_code);
      return res.status(402).json({ error: 'Payment was not approved by Moneris' });
    }

    console.log(`[Moneris] Payment verified for ${confirmation_code}`);

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

    try {
      const apiKey = process.env.RESEND_API_KEY;
      const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

      if (apiKey) {
        const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [checkoutData.eventId]);
        const event = eventResult.rows.length > 0 ? eventResult.rows[0] : null;

        // Hosted QR URL — Gmail strips data: URI images, so the QR must be a
        // remote image (served by routes/ticketOrders.js /:code/qr.png)
        const qrDataUrl = `${process.env.PUBLIC_API_URL || 'https://api.holmdalerodeo.ca'}/api/ticket-orders/${encodeURIComponent(confirmation_code)}/qr.png`;

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
    <p style="color:#78716c;font-size:12px;margin:4px 0 0;">Can't see the code above? It's also attached to this email — or just show your confirmation number.</p>
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

        // Attach the QR PNG too — some clients (Yahoo web, iPhone Mail privacy
        // protection) block the remote <img>, so the attachment is the fallback.
        const { buildQrAttachment } = require('./email');
        const qrAttachment = await buildQrAttachment(confirmation_code);

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from, to: [checkoutData.customerEmail],
            subject: `🎟 Your Holmdale Pro Rodeo Tickets — ${confirmation_code}`, html,
            ...(qrAttachment ? { attachments: [qrAttachment] } : {})
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

    deletePendingCheckout(confirmation_code);
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
        if (checkoutData && checkoutData.type === 'merch') {
          const created = await finalizeMerchOrder(orderNo, checkoutData, null, 'webhook');
          if (created) {
            try { await sendMerchConfirmationEmail(orderNo, checkoutData); }
            catch (e) { console.error('Webhook merch email failed:', e.message); }
          }
          pendingCheckouts.delete(orderNo);
          console.log(`✓ Webhook: created merch order ${orderNo}`);
        } else if (checkoutData) {
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

// ============================================
// POST /api/moneris/vendor-checkout
// Creates Moneris checkout session for vendor booth payment
// ============================================
router.post('/vendor-checkout', async (req, res) => {
  try {
    const { vendor_id, confirmation_code, amount, booth_size, business_name, email, contact_name } = req.body;

    if (!vendor_id || !confirmation_code || !amount || !email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const orderNo = `VND-${confirmation_code}`;

    pendingCheckouts.set(orderNo, {
      createdAt: Date.now(),
      type: 'vendor',
      vendor_id,
      confirmation_code,
      amount,
      booth_size,
      business_name,
      email,
      contact_name,
      monerisTicket: null
    });

    const { storeId, apiToken, checkoutId } = getMonerisCredentials();
    const subtotal = (parseFloat(amount) / 1.13).toFixed(2);
    const hst = (parseFloat(amount) - parseFloat(subtotal)).toFixed(2);

    const monerisTicket = await monerisPreload({
      store_id: storeId,
      api_token: apiToken,
      checkout_id: checkoutId,
      txn_total: parseFloat(amount).toFixed(2),
      cart_subtotal: subtotal,
      tax: { amount: hst, description: 'HST', rate: '13.00' },
      environment: 'prod',
      action: 'preload',
      order_no: orderNo,
      cust_id: email,
      contact_details: {
        email,
        first_name: contact_name?.split(' ')[0] || contact_name || business_name,
        last_name: contact_name?.split(' ').slice(1).join(' ') || ''
      }
    });

    const entry = pendingCheckouts.get(orderNo);
    entry.monerisTicket = monerisTicket;
    pendingCheckouts.set(orderNo, entry);

    console.log(`✓ Vendor checkout created: ${orderNo} $${amount} vendor=${vendor_id}`);
    res.json({ ticket: monerisTicket, order_no: orderNo });
  } catch (error) {
    console.error('[Vendor Checkout] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/moneris/vendor-confirm
// Verifies Moneris payment and marks vendor as paid
// ============================================
router.post('/vendor-confirm', async (req, res) => {
  try {
    const { confirmation_code, vendor_id } = req.body;
    if (!confirmation_code || !vendor_id) {
      return res.status(400).json({ error: 'confirmation_code and vendor_id required' });
    }

    const orderNo = `VND-${confirmation_code}`;
    const checkoutData = pendingCheckouts.get(orderNo);

    if (!checkoutData?.monerisTicket) {
      console.error(`[Vendor Confirm] No pending checkout for: ${orderNo}`);
      return res.status(404).json({ error: 'Checkout session not found or expired' });
    }

    // Verify with Moneris
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
    console.log(`[Vendor Confirm] ${orderNo}: result=${verifyResult?.response?.receipt?.result}`);

    const paymentSuccess = verifyResult?.response?.success === 'true' &&
                           verifyResult?.response?.receipt?.result === 'a';

    if (!paymentSuccess) {
      console.log(`[Vendor Confirm] Payment NOT approved for ${orderNo}`);
      pendingCheckouts.delete(orderNo);
      return res.status(402).json({ error: 'Payment was not approved' });
    }

    // Mark vendor as paid in database
    await pool.query(
      `UPDATE vendors SET payment_status = 'paid', payment_date = NOW(), updated_date = NOW()
       WHERE id = $1`,
      [vendor_id]
    ).catch(e => console.error('Vendor update error:', e.message));

    // Send confirmation email
    try {
      const apiKey = process.env.RESEND_API_KEY;
      const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
      if (apiKey && checkoutData.email) {
        const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:Arial,sans-serif;">
<div style="max-width:500px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
  <div style="background:#1c1917;padding:24px;text-align:center;">
    <h1 style="margin:0;color:#facc15;font-size:24px;letter-spacing:2px;">🤠 HOLMDALE PRO RODEO</h1>
    <p style="margin:8px 0 0;color:#a8a29e;font-size:14px;">Vendor Registration Confirmed</p>
  </div>
  <div style="padding:24px;">
    <h2 style="color:#1c1917;margin-bottom:16px;">Thank you, ${checkoutData.business_name}!</h2>
    <p style="color:#44403c;margin-bottom:16px;">Your vendor registration and booth payment have been confirmed.</p>
    <div style="background:#f5f5f4;border-radius:10px;padding:16px;margin-bottom:16px;">
      <table style="width:100%;font-size:14px;color:#44403c;">
        <tr><td style="padding:4px 0;font-weight:bold;">📅 Event</td><td>July 31 - August 2, 2026</td></tr>
        <tr><td style="padding:4px 0;font-weight:bold;">📍 Location</td><td>588 Sideroad 10 S., Walkerton, ON</td></tr>
        <tr><td style="padding:4px 0;font-weight:bold;">🏕️ Booth</td><td>${checkoutData.booth_size}</td></tr>
        <tr><td style="padding:4px 0;font-weight:bold;">💳 Amount Paid</td><td style="color:#16a34a;font-weight:bold;">$${parseFloat(checkoutData.amount).toFixed(2)}</td></tr>
        <tr><td style="padding:4px 0;font-weight:bold;">🔖 Reference</td><td>${confirmation_code}</td></tr>
      </table>
    </div>
    <p style="color:#78716c;font-size:13px;">Our team will be in touch with booth assignment details closer to the event.</p>
  </div>
  <div style="background:#1c1917;padding:16px 24px;text-align:center;">
    <p style="margin:0;color:#a8a29e;font-size:12px;">Questions? Email <a href="mailto:info@holmdalerodeo.ca" style="color:#facc15;">info@holmdalerodeo.ca</a></p>
  </div>
</div>
</body></html>`;

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from,
            to: [checkoutData.email],
            subject: `✅ Vendor Registration Confirmed — Holmdale Pro Rodeo 2026`,
            html
          })
        });
        console.log(`✓ Vendor confirmation email sent to ${checkoutData.email}`);
        // Notify admin
await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from,
    to: ['darren@holmgraphics.ca'],
    subject: `💳 Vendor Payment Received: ${checkoutData.business_name}`,
    html: `<h2>Vendor Payment Received</h2>
<p><strong>${checkoutData.business_name}</strong> (${checkoutData.contact_name}) has completed their booth payment.</p>
<p>Email: ${checkoutData.email}</p>
<p>Booth: ${checkoutData.booth_size}</p>
<p>Amount Paid: <strong>$${parseFloat(checkoutData.amount).toFixed(2)}</strong></p>
<p>Reference: ${confirmation_code}</p>`
  })
});
      }
    } catch (emailErr) {
      console.error('[Vendor Confirm] Email error:', emailErr.message);
    }

    pendingCheckouts.delete(orderNo);
    console.log(`✓ Vendor payment confirmed: ${orderNo}`);
    res.json({ success: true, confirmation_code });
  } catch (error) {
    console.error('[Vendor Confirm] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/moneris/merch-checkout
// ============================================
router.post('/merch-checkout', async (req, res) => {
  try {
    const { items, customer_info, shipping_address, shipping_cost, shipping_method } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items in cart' });
    }
    if (!customer_info?.name || !customer_info?.email) {
      return res.status(400).json({ error: 'Customer name and email required' });
    }
    if (shipping_method === 'ship' && !shipping_address?.postal_code) {
      return res.status(400).json({ error: 'Shipping address required' });
    }

    // Price everything server-side from the products table
    const lineItems = [];
    for (const item of items) {
      if (!item.product_id) return res.status(400).json({ error: 'Missing product_id' });
      const qty = parseInt(item.quantity) || 1;
      const result = await pool.query('SELECT * FROM products WHERE id = $1', [item.product_id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: `Product not found: ${item.product_id}` });
      }
      const product = result.rows[0];
      if ((product.stock || 0) < qty) {
        return res.status(409).json({ error: `${product.name} is out of stock` });
      }
      // Same variant key convention as the POS (routes/merchSales.js)
      const vkey = item.color && item.size ? `${item.color}|${item.size}` : (item.color || item.size || null);
      if (vkey && product.variant_stock && Object.prototype.hasOwnProperty.call(product.variant_stock, vkey)
          && (parseInt(product.variant_stock[vkey]) || 0) < qty) {
        return res.status(409).json({ error: `${product.name} (${vkey.replace('|', ' / ')}) is out of stock` });
      }
      lineItems.push({
        product_id: product.id,
        name: product.name,
        price: parseFloat(product.price),
        quantity: qty,
        size: item.size || null,
        color: item.color || null
      });
    }

    const subtotal = lineItems.reduce((sum, li) => sum + li.price * li.quantity, 0);
    const shipping = shipping_method === 'pickup' ? 0 : (parseFloat(shipping_cost) || 0);
    const hst = (subtotal + shipping) * 0.13;
    const total = subtotal + shipping + hst;

    const orderNo = `MO-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;

    pendingCheckouts.set(orderNo, {
      createdAt: Date.now(),
      type: 'merch',
      items: lineItems,
      customerName: customer_info.name,
      customerEmail: customer_info.email,
      customerPhone: customer_info.phone || '',
      shippingAddress: shipping_address || null,
      shippingMethod: shipping_method || 'ship',
      shippingCost: shipping,
      subtotal,
      hst,
      total: total.toFixed(2),
      monerisTicket: null
    });

    const { storeId, apiToken, checkoutId } = getMonerisCredentials();
    const monerisTicket = await monerisPreload({
      store_id: storeId,
      api_token: apiToken,
      checkout_id: checkoutId,
      txn_total: total.toFixed(2),
      cart_subtotal: (subtotal + shipping).toFixed(2),
      tax: { amount: hst.toFixed(2), description: 'HST', rate: '13.00' },
      environment: 'prod',
      action: 'preload',
      order_no: orderNo,
      cust_id: customer_info.email,
      contact_details: {
        email: customer_info.email,
        first_name: customer_info.name.split(' ')[0] || customer_info.name,
        last_name: customer_info.name.split(' ').slice(1).join(' ') || ''
      }
    });

    const entry = pendingCheckouts.get(orderNo);
    entry.monerisTicket = monerisTicket;
    pendingCheckouts.set(orderNo, entry);

    console.log(`✓ Merch checkout created: ${orderNo}, total: $${total.toFixed(2)}`);
    res.json({ ticket: monerisTicket, confirmation_code: orderNo });
  } catch (error) {
    console.error('Merch checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Shared by /merch-confirm and the webhook — idempotent on orders.id.
// Records the order and decrements pooled + per-variant stock
// (same convention as routes/merchSales.js).
async function finalizeMerchOrder(orderNo, checkoutData, monerisTxnId, createdBy) {
  const existing = await pool.query('SELECT id FROM orders WHERE id = $1', [orderNo]);
  if (existing.rows.length > 0) return false;

  await pool.query(
    `INSERT INTO orders (id, monaris_transaction_id, customer_name, customer_email, items,
       total_amount, shipping_address, status, created_date, updated_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'paid', NOW(), NOW(), $8)`,
    [orderNo, monerisTxnId || null, checkoutData.customerName, checkoutData.customerEmail,
     JSON.stringify(checkoutData.items),
     checkoutData.total,
     JSON.stringify({
       ...(checkoutData.shippingAddress || {}),
       shipping_method: checkoutData.shippingMethod,
       shipping_cost: checkoutData.shippingCost,
       subtotal: checkoutData.subtotal,
       hst: checkoutData.hst
     }),
     createdBy]
  );

  for (const li of checkoutData.items) {
    await pool.query(
      `UPDATE products SET stock = GREATEST(0, stock - $1), updated_date = NOW() WHERE id = $2`,
      [li.quantity, li.product_id]
    );
    const vkey = li.color && li.size ? `${li.color}|${li.size}` : (li.color || li.size || null);
    if (vkey) {
      await pool.query(
        `UPDATE products
         SET variant_stock = jsonb_set(variant_stock, ARRAY[$1],
               to_jsonb(GREATEST(0, COALESCE((variant_stock->>$1)::int, 0) - $2)))
         WHERE id = $3 AND variant_stock IS NOT NULL AND variant_stock ? $1`,
        [vkey, li.quantity, li.product_id]
      );
    }
  }
  return true;
}

async function sendMerchConfirmationEmail(orderNo, checkoutData) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  if (!apiKey || !checkoutData.customerEmail) return;

  const itemRows = checkoutData.items.map(li => {
    const variant = [li.color, li.size].filter(Boolean).join(' / ');
    return `<tr>
      <td style="padding:6px 0;color:#44403c;">${li.quantity}x ${li.name}${variant ? ` <span style="color:#78716c;">(${variant})</span>` : ''}</td>
      <td style="padding:6px 0;text-align:right;color:#44403c;">$${(li.price * li.quantity).toFixed(2)}</td>
    </tr>`;
  }).join('');

  const isPickup = checkoutData.shippingMethod === 'pickup';
  const addr = checkoutData.shippingAddress;
  const deliveryHtml = isPickup
    ? `<p style="color:#44403c;font-size:14px;">🏪 <strong>Pickup order</strong> — we'll email you when your order is ready for pickup.</p>`
    : `<p style="color:#44403c;font-size:14px;">📦 <strong>Shipping to:</strong><br>${addr?.street || ''}<br>${addr?.city || ''}, ${addr?.province || ''} ${addr?.postal_code || ''}</p>`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:Arial,sans-serif;">
<div style="max-width:500px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
  <div style="background:#1c1917;padding:24px;text-align:center;">
    <h1 style="margin:0;color:#facc15;font-size:24px;letter-spacing:2px;">🤠 HOLMDALE PRO RODEO</h1>
    <p style="margin:8px 0 0;color:#a8a29e;font-size:14px;">Merch Order Confirmation</p>
  </div>
  <div style="padding:24px;">
    <h2 style="color:#1c1917;margin:0 0 4px;">Thanks, ${checkoutData.customerName}!</h2>
    <p style="color:#78716c;font-size:13px;margin:0 0 16px;">Order reference: <strong>${orderNo}</strong></p>
    <div style="background:#f5f5f4;border-radius:10px;padding:16px;margin-bottom:16px;">
      <table style="width:100%;font-size:14px;border-collapse:collapse;">
        ${itemRows}
        <tr><td colspan="2" style="border-top:1px solid #e7e5e4;padding-top:8px;"></td></tr>
        <tr><td style="padding:2px 0;color:#78716c;">Subtotal</td><td style="text-align:right;color:#78716c;">$${checkoutData.subtotal.toFixed(2)}</td></tr>
        <tr><td style="padding:2px 0;color:#78716c;">Shipping</td><td style="text-align:right;color:#78716c;">$${checkoutData.shippingCost.toFixed(2)}</td></tr>
        <tr><td style="padding:2px 0;color:#78716c;">HST (13%)</td><td style="text-align:right;color:#78716c;">$${checkoutData.hst.toFixed(2)}</td></tr>
        <tr><td style="padding:6px 0;font-weight:bold;color:#1c1917;">Total</td><td style="text-align:right;font-weight:bold;font-size:18px;color:#16a34a;">$${parseFloat(checkoutData.total).toFixed(2)}</td></tr>
      </table>
    </div>
    ${deliveryHtml}
  </div>
  <div style="background:#1c1917;padding:16px 24px;text-align:center;">
    <p style="margin:0;color:#a8a29e;font-size:12px;">Questions? Email <a href="mailto:info@holmdalerodeo.ca" style="color:#facc15;">info@holmdalerodeo.ca</a></p>
  </div>
</div>
</body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [checkoutData.customerEmail],
      subject: `🛍 Your Holmdale Pro Rodeo Merch Order — ${orderNo}`,
      html
    })
  });
  console.log(`✓ Merch confirmation email sent for ${orderNo}`);
}

// ============================================
// POST /api/moneris/merch-confirm
// ============================================
router.post('/merch-confirm', async (req, res) => {
  try {
    const { confirmation_code } = req.body;
    if (!confirmation_code) {
      return res.status(400).json({ error: 'Confirmation code required' });
    }

    const existingOrder = await pool.query('SELECT id FROM orders WHERE id = $1', [confirmation_code]);
    if (existingOrder.rows.length > 0) {
      console.log(`Merch order ${confirmation_code} already exists, skipping duplicate`);
      return res.json({ success: true, message: 'Order already confirmed', confirmation_code });
    }

    const checkoutData = pendingCheckouts.get(confirmation_code);
    if (!checkoutData || checkoutData.type !== 'merch') {
      console.error(`[Merch Confirm] No pending merch checkout for: ${confirmation_code}`);
      return res.status(404).json({ error: 'Checkout session not found or expired' });
    }
    if (!checkoutData.monerisTicket) {
      return res.status(400).json({ error: 'Missing Moneris ticket token' });
    }

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
    console.log(`[Merch Confirm] ${confirmation_code}: result=${verifyResult?.response?.receipt?.result}`);

    const paymentSuccess = verifyResult?.response?.success === 'true' &&
                           verifyResult?.response?.receipt?.result === 'a';
    if (!paymentSuccess) {
      console.log(`[Merch Confirm] Payment NOT approved for ${confirmation_code}`);
      pendingCheckouts.delete(confirmation_code);
      return res.status(402).json({ error: 'Payment was not approved by Moneris' });
    }

    const txnId = verifyResult?.response?.receipt?.cc?.transaction_no || null;
    await finalizeMerchOrder(confirmation_code, checkoutData, txnId, 'web');

    try {
      await sendMerchConfirmationEmail(confirmation_code, checkoutData);
    } catch (emailErr) {
      console.error('Merch email failed (order still confirmed):', emailErr.message);
    }

    pendingCheckouts.delete(confirmation_code);
    console.log(`✓ Merch payment confirmed: ${confirmation_code}`);
    res.json({ success: true, confirmation_code, message: 'Payment confirmed and order created' });
  } catch (error) {
    console.error('Merch confirm error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
