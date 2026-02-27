const express = require('express');
const router = express.Router();
const pool = require('../config/database');

// ============================================
// EMAIL ROUTES — Ticket confirmations via Resend
// ============================================

const RESEND_API_URL = 'https://api.resend.com/emails';

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('✗ RESEND_API_KEY not set');
    throw new Error('Email service not configured');
  }

  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to: [to], subject, html })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('✗ Resend error:', data);
    throw new Error(data.message || 'Email send failed');
  }

  console.log(`✓ Email sent to ${to} — ID: ${data.id}`);
  return data;
}

function generateQRCodeUrl(text) {
  // Use Google Charts API for QR code generation
  return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(text)}`;
}

function buildTicketEmailHtml(ticket, event) {
  const qrUrl = generateQRCodeUrl(ticket.confirmation_code);
  const eventDate = event ? new Date(event.date).toLocaleDateString('en-CA', { 
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
  }) : 'TBD';
  const eventTime = event ? event.time : '';
  const eventTitle = event ? event.title : 'Holmdale Pro Rodeo';
  const venue = event ? event.venue : 'Holmdale Rodeo Grounds';

  const adultQty = ticket.quantity_adult || 0;
  const childQty = ticket.quantity_child || 0;
  const familyQty = ticket.quantity_family || 0;

  let ticketLines = [];
  if (adultQty > 0) ticketLines.push(`${adultQty}x Adult Ticket`);
  if (childQty > 0) ticketLines.push(`${childQty}x Child Ticket (5-12)`);
  if (familyQty > 0) ticketLines.push(`${familyQty}x Family Pass`);
  const ticketSummary = ticketLines.join('<br>');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background:#f5f5f4; font-family: Arial, sans-serif;">
  <div style="max-width:500px; margin:20px auto; background:#ffffff; border-radius:12px; overflow:hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    
    <!-- Header -->
    <div style="background:#1c1917; padding:24px; text-align:center;">
      <h1 style="margin:0; color:#facc15; font-size:24px; letter-spacing:2px;">🤠 HOLMDALE PRO RODEO</h1>
      <p style="margin:8px 0 0; color:#a8a29e; font-size:14px;">Your Ticket Confirmation</p>
    </div>

    <!-- QR Code -->
    <div style="text-align:center; padding:24px;">
      <img src="${qrUrl}" alt="QR Code" style="width:180px; height:180px; border:4px solid #1c1917; border-radius:12px;">
      <div style="margin-top:12px; font-size:24px; font-weight:bold; color:#1c1917; letter-spacing:3px;">
        ${ticket.confirmation_code}
      </div>
      <p style="color:#78716c; font-size:12px; margin:4px 0 0;">Show this QR code at the gate</p>
    </div>

    <!-- Event Details -->
    <div style="padding:0 24px 20px;">
      <div style="background:#f5f5f4; border-radius:10px; padding:16px;">
        <h2 style="margin:0 0 12px; color:#1c1917; font-size:18px;">${eventTitle}</h2>
        <table style="width:100%; font-size:14px; color:#44403c;">
          <tr><td style="padding:4px 0; font-weight:bold;">📅 Date</td><td>${eventDate}</td></tr>
          <tr><td style="padding:4px 0; font-weight:bold;">🕐 Time</td><td>${eventTime}</td></tr>
          <tr><td style="padding:4px 0; font-weight:bold;">📍 Venue</td><td>${venue}</td></tr>
        </table>
      </div>
    </div>

    <!-- Order Details -->
    <div style="padding:0 24px 20px;">
      <div style="border-top:1px solid #e7e5e4; padding-top:16px;">
        <h3 style="margin:0 0 8px; color:#1c1917; font-size:16px;">Order Details</h3>
        <table style="width:100%; font-size:14px; color:#44403c;">
          <tr><td style="padding:4px 0; font-weight:bold;">Name</td><td>${ticket.customer_name}</td></tr>
          <tr><td style="padding:4px 0; font-weight:bold;">Tickets</td><td>${ticketSummary}</td></tr>
          <tr><td style="padding:4px 0; font-weight:bold;">Total</td><td style="font-size:18px; font-weight:bold; color:#16a34a;">$${parseFloat(ticket.total_price).toFixed(2)}</td></tr>
        </table>
      </div>
    </div>

    ${ticket.bar_credits > 0 ? `
    <!-- Bar Credits -->
    <div style="padding:0 24px 20px;">
      <div style="background:#fef3c7; border-radius:10px; padding:12px 16px; text-align:center;">
        <span style="font-size:20px;">🍺</span>
        <span style="font-weight:bold; color:#92400e;">${ticket.bar_credits} Drink Ticket(s) included</span>
        <p style="margin:4px 0 0; font-size:12px; color:#92400e;">Loaded to your wristband at the gate</p>
      </div>
    </div>
    ` : ''}

    <!-- Footer -->
    <div style="background:#1c1917; padding:16px 24px; text-align:center;">
      <p style="margin:0; color:#a8a29e; font-size:12px;">
        Holmdale Rodeo Grounds — Walkerton, Ontario<br>
        Questions? Contact us at info@holmdalerodeo.ca
      </p>
    </div>

  </div>
</body>
</html>`;
}

// ============================================
// POST /api/email/ticket-confirmation
// Called after successful Moneris payment
// ============================================
router.post('/ticket-confirmation', async (req, res) => {
  try {
    const { confirmation_code, orderId, ticketOrderId } = req.body;
    const code = confirmation_code || orderId || ticketOrderId;

    if (!code) {
      return res.status(400).json({ error: 'No confirmation code provided' });
    }

    console.log(`[Email] Processing confirmation for: ${code}`);

    // Look up the ticket order
    let ticket;
    const result = await pool.query(
      'SELECT * FROM ticket_orders WHERE confirmation_code = $1 OR id = $2',
      [code, code]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket order not found' });
    }

    ticket = result.rows[0];

    if (!ticket.customer_email) {
      console.log(`[Email] No email address for order ${code}`);
      return res.status(400).json({ error: 'No customer email on order' });
    }

    // Update payment status to confirmed
    await pool.query(
      'UPDATE ticket_orders SET payment_status = $1, updated_date = NOW() WHERE id = $2',
      ['confirmed', ticket.id]
    );

    // Look up event details
    let event = null;
    if (ticket.event_id) {
      const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [ticket.event_id]);
      if (eventResult.rows.length > 0) event = eventResult.rows[0];
    }

    // Build and send email
    const html = buildTicketEmailHtml(ticket, event);
    await sendEmail({
      to: ticket.customer_email,
      subject: `🎟 Your Holmdale Pro Rodeo Tickets — ${ticket.confirmation_code}`,
      html
    });

    // Update ticket to note email was sent
    await pool.query(
      'UPDATE ticket_orders SET payment_status = $1, updated_date = NOW() WHERE id = $2',
      ['confirmed_emailed', ticket.id]
    );

    console.log(`✓ Confirmation email sent for ${ticket.confirmation_code} to ${ticket.customer_email}`);

    res.json({ 
      success: true, 
      message: 'Confirmation email sent',
      confirmation_code: ticket.confirmation_code,
      email: ticket.customer_email
    });

  } catch (error) {
    console.error('✗ Email error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/email/send-confirmation
// Alternative endpoint name (same logic)
// ============================================
router.post('/send-confirmation', async (req, res) => {
  // Forward to ticket-confirmation handler
  req.url = '/ticket-confirmation';
  router.handle(req, res);
});

// ============================================
// POST /api/email/resend-ticket
// Resend a confirmation email for an existing order
// ============================================
router.post('/resend-ticket', async (req, res) => {
  try {
    const { confirmation_code, email } = req.body;

    if (!confirmation_code) {
      return res.status(400).json({ error: 'Confirmation code required' });
    }

    const result = await pool.query(
      'SELECT * FROM ticket_orders WHERE confirmation_code = $1',
      [confirmation_code]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const ticket = result.rows[0];
    const sendTo = email || ticket.customer_email;

    if (!sendTo) {
      return res.status(400).json({ error: 'No email address' });
    }

    let event = null;
    if (ticket.event_id) {
      const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [ticket.event_id]);
      if (eventResult.rows.length > 0) event = eventResult.rows[0];
    }

    const html = buildTicketEmailHtml(ticket, event);
    await sendEmail({
      to: sendTo,
      subject: `🎟 Your Holmdale Pro Rodeo Tickets — ${ticket.confirmation_code}`,
      html
    });

    console.log(`✓ Resent confirmation for ${ticket.confirmation_code} to ${sendTo}`);
    res.json({ success: true, message: `Email resent to ${sendTo}` });

  } catch (error) {
    console.error('✗ Resend error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/email/test
// Send a test email to verify Resend is working
// ============================================
router.post('/test', async (req, res) => {
  try {
    const { to } = req.body;
    const testTo = to || 'darren@holmgraphics.ca';

    await sendEmail({
      to: testTo,
      subject: '🤠 Holmdale Rodeo — Email Test',
      html: '<h1>Email is working!</h1><p>Your Resend integration is configured correctly.</p>'
    });

    res.json({ success: true, message: `Test email sent to ${testTo}` });
  } catch (error) {
    console.error('✗ Test email error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
