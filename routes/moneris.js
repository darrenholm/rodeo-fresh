const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// Moneris API endpoints
const MONERIS_PRELOAD_URL = 'https://gateway.moneris.com/chkt/request/request.php';
const MONERIS_CHECKOUT_URL = 'https://gateway.moneris.com/chkt/index.php';

// Helper: get Moneris credentials from env
function getMonerisCredentials() {
  const storeId = process.env.MONERIS_STORE_ID;
  const apiToken = process.env.MONERIS_API_TOKEN;
  const checkoutId = process.env.MONERIS_CHECKOUT_ID;

  console.log('Moneris credentials check:', {
    storeId: storeId ? storeId.substring(0, 5) + '...' : 'MISSING',
    apiToken: apiToken ? apiToken.substring(0, 5) + '...' : 'MISSING',
    checkoutId: checkoutId ? checkoutId.substring(0, 5) + '...' : 'MISSING',
    storeIdLength: storeId?.length,
    apiTokenLength: apiToken?.length,
    checkoutIdLength: checkoutId?.length
  });

  if (!storeId || !apiToken || !checkoutId) {
    throw new Error('Moneris credentials not configured');
  }

  return { storeId, apiToken, checkoutId };
}

// Helper: call Moneris preload API
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
// Create Moneris checkout for ticket purchases
// ============================================
router.post('/ticket-checkout', authenticateToken, async (req, res) => {
  try {
    const { tickets, barTickets, barCredits, eventId, customerEmail, customerName, customerPhone } = req.body;

    if (!tickets || !eventId || !customerEmail || !customerName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const totalQuantity = (tickets.general || 0) + (tickets.child || 0) + (tickets.family || 0);
    if (totalQuantity === 0) {
      return res.status(400).json({ error: 'No tickets selected' });
    }

    // Fetch event for pricing
    const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    const event = eventResult.rows[0];

    // Calculate tier pricing
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

    // Calculate totals
    const generalSubtotal = (tickets.general || 0) * adultPrice;
    const childSubtotal = (tickets.child || 0) * childPrice;
    const familySubtotal = (tickets.family || 0) * familyPrice;
    const barTicketsSubtotal = (barTickets || 0) * 7;
    const subtotal = generalSubtotal + childSubtotal + familySubtotal + barTicketsSubtotal;
    const hst = subtotal * 0.13;
    const total = subtotal + hst;

    // Calculate wristband quantities
    const quantityAdult = (tickets.general || 0) + ((tickets.family || 0) * 2);
    const quantityChild = (tickets.child || 0) + ((tickets.family || 0) * 2);

    // Generate IDs matching existing format
    const id = `ticket_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const confirmationCode = `WW-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;

    // Create ticket order in database
    const orderResult = await pool.query(
      `INSERT INTO ticket_orders (
        id, event_id, ticket_type, quantity_adult, quantity_child,
        customer_name, customer_email, customer_phone,
        confirmation_code, status, total_price, created_date, updated_date, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW(), 'web')
      RETURNING *`,
      [
        id, eventId, 'mixed', quantityAdult, quantityChild,
        customerName, customerEmail, customerPhone || '',
        confirmationCode, 'pending', total.toFixed(2)
      ]
    );
    const ticketOrder = orderResult.rows[0];

    // Create Moneris checkout
    const { storeId, apiToken, checkoutId } = getMonerisCredentials();

    const ticket = await monerisPreload({
      store_id: storeId,
      api_token: apiToken,
      checkout_id: checkoutId,
      txn_total: total.toFixed(2),
      cart_subtotal: subtotal.toFixed(2),
      tax: {
        amount: hst.toFixed(2),
        description: 'HST',
        rate: '13.00'
      },
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

    const appUrl = process.env.APP_URL || 'https://holmdalerodeo.ca';
    const successUrl = `${appUrl}/CheckoutSuccess?confirmation_code=${confirmationCode}&ticket_id=${ticketOrder.id}`;

    console.log(`✓ Moneris ticket checkout created: ${confirmationCode}, total: $${total.toFixed(2)}`);

    res.json({
      url: `${MONERIS_CHECKOUT_URL}?ticket=${ticket}&redirect=${encodeURIComponent(successUrl)}`,
      ticket,
      order_id: `TICKET-${Date.now()}`,
      confirmation_code: confirmationCode
    });

  } catch (error) {
    console.error('Ticket checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/moneris/bar-checkout
// Create Moneris checkout for bar ticket purchases
// ============================================
router.post('/bar-checkout', authenticateToken, async (req, res) => {
  try {
    const { rfidTagId, ticketQuantity, customerName } = req.body;

    if (!rfidTagId || !ticketQuantity) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Look up customer name from ticket if not provided
    let name = customerName || 'Bar Customer';
    if (!customerName) {
      try {
        const ticketResult = await pool.query(
          'SELECT customer_name FROM ticket_orders WHERE rfid_tag_id = $1 LIMIT 1',
          [rfidTagId]
        );
        if (ticketResult.rows.length > 0) {
          name = ticketResult.rows[0].customer_name;
        }
      } catch (err) {
        console.log('Could not fetch customer name:', err.message);
      }
    }

    const totalPrice = ticketQuantity * 0.07;

    const { storeId, apiToken, checkoutId } = getMonerisCredentials();

    const ticket = await monerisPreload({
      store_id: storeId,
      api_token: apiToken,
      checkout_id: checkoutId,
      action: 'preload',
      txn_total: totalPrice.toFixed(2),
      order_no: `BAR-${Date.now()}`,
      contact_details: {
        first_name: name
      }
    });

    console.log(`✓ Moneris bar checkout created: ${ticketQuantity} tickets, $${totalPrice.toFixed(2)}`);

    res.json({
      ticket,
      totalPrice
    });

  } catch (error) {
    console.error('Bar checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/moneris/merch-checkout
// Create Moneris checkout for merchandise purchases
// ============================================
router.post('/merch-checkout', authenticateToken, async (req, res) => {
  try {
    const { items, customerEmail, customerName, shippingAddress } = req.body;

    if (!items || items.length === 0 || !customerEmail || !customerName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Calculate totals
    let subtotal = 0;
    for (const item of items) {
      subtotal += (item.price || 0) * (item.quantity || 1);
    }
    const hst = subtotal * 0.13;
    const total = subtotal + hst;

    const orderId = `MERCH-${Date.now()}`;

    const { storeId, apiToken, checkoutId } = getMonerisCredentials();

    const ticket = await monerisPreload({
      store_id: storeId,
      api_token: apiToken,
      checkout_id: checkoutId,
      txn_total: total.toFixed(2),
      cart_subtotal: subtotal.toFixed(2),
      tax: {
        amount: hst.toFixed(2),
        description: 'HST',
        rate: '13.00'
      },
      environment: 'prod',
      action: 'preload',
      order_no: orderId,
      cust_id: customerEmail,
      contact_details: {
        email: customerEmail,
        first_name: customerName.split(' ')[0] || customerName,
        last_name: customerName.split(' ').slice(1).join(' ') || ''
      }
    });

    console.log(`✓ Moneris merch checkout created: ${orderId}, $${total.toFixed(2)}`);

    res.json({
      ticket,
      order_id: orderId,
      total: total.toFixed(2)
    });

  } catch (error) {
    console.error('Merchandise checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/moneris/refund
// Refund a ticket order via Moneris
// ============================================
router.post('/refund', authenticateToken, async (req, res) => {
  try {
    const { ticketOrderId, amount, reason } = req.body;

    if (!ticketOrderId) {
      return res.status(400).json({ error: 'Ticket order ID required' });
    }

    // Look up the ticket order
    const orderResult = await pool.query('SELECT * FROM ticket_orders WHERE id = $1', [ticketOrderId]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket order not found' });
    }
    const order = orderResult.rows[0];

    // Update ticket status to refunded
    await pool.query(
      `UPDATE ticket_orders SET status = 'refunded', updated_date = NOW() WHERE id = $1`,
      [ticketOrderId]
    );

    console.log(`✓ Ticket ${order.confirmation_code} marked as refunded. Reason: ${reason || 'none'}`);

    // Note: For actual Moneris refund processing, you'd need the original transaction ID
    // which would need to be stored during the original payment webhook callback.
    // This currently just marks the order as refunded in the database.

    res.json({
      success: true,
      message: 'Ticket order refunded',
      confirmation_code: order.confirmation_code
    });

  } catch (error) {
    console.error('Refund error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/moneris/webhook
// Handle Moneris payment completion webhook
// ============================================
router.post('/webhook', async (req, res) => {
  try {
    const data = req.body;
    console.log('Moneris webhook received:', JSON.stringify(data));

    const orderNo = data.order_no || data.response?.order_no;
    const success = data.success === 'true' || data.response?.success === 'true';

    if (!orderNo) {
      console.error('Webhook missing order_no');
      return res.status(400).json({ error: 'Missing order_no' });
    }

    if (success) {
      // Update ticket order status to confirmed
      await pool.query(
        `UPDATE ticket_orders SET status = 'confirmed', payment_status = 'paid', updated_date = NOW() 
         WHERE confirmation_code = $1`,
        [orderNo]
      );

      // Update tickets_sold count on event
      const orderResult = await pool.query(
        'SELECT event_id, quantity_adult, quantity_child FROM ticket_orders WHERE confirmation_code = $1',
        [orderNo]
      );
      if (orderResult.rows.length > 0) {
        const { event_id, quantity_adult, quantity_child } = orderResult.rows[0];
        const totalQuantity = (quantity_adult || 0) + (quantity_child || 0);
        await pool.query(
          'UPDATE events SET tickets_sold = COALESCE(tickets_sold, 0) + $1 WHERE id = $2',
          [totalQuantity, event_id]
        );
      }

      console.log(`✓ Payment confirmed for order: ${orderNo}`);
    } else {
      await pool.query(
        `UPDATE ticket_orders SET status = 'failed', payment_status = 'failed', updated_date = NOW() 
         WHERE confirmation_code = $1`,
        [orderNo]
      );
      console.log(`✗ Payment failed for order: ${orderNo}`);
    }

    res.json({ received: true });

  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
