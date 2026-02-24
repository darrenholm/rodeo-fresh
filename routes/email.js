const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const QRCode = require('qrcode');

// Resend API helper
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY not configured');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Holmdale Pro Rodeo <info@holmdalerodeo.ca>',
      to,
      subject,
      html
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Email send failed: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

// Generate confirmation email HTML
async function generateTicketEmailHtml(ticketOrder, event) {
  // Generate QR code
  const qrCodeData = JSON.stringify({
    confirmation_code: ticketOrder.confirmation_code,
    event_id: ticketOrder.event_id,
    ticket_type: ticketOrder.ticket_type,
    quantity_adult: ticketOrder.quantity_adult,
    quantity_child: ticketOrder.quantity_child,
    customer_email: ticketOrder.customer_email
  });

  const qrCodeDataUrl = await QRCode.toDataURL(qrCodeData, {
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' }
  });

  const eventDate = event.date
    ? new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : 'TBA';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1c1917; color: white; padding: 30px; text-align: center; }
        .content { padding: 30px; background: #f5f5f4; }
        .ticket-details { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; }
        .qr-section { text-align: center; padding: 30px; background: white; margin: 20px 0; border-radius: 8px; }
        .qr-code { max-width: 300px; margin: 20px auto; display: block; }
        .confirmation-code { font-size: 24px; font-weight: bold; color: #1c1917; margin: 20px 0; }
        .footer { text-align: center; padding: 20px; color: #78716c; font-size: 14px; }
        table { width: 100%; }
        td { padding: 8px 0; }
        .label { font-weight: bold; color: #78716c; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🎟️ Your Tickets are Confirmed!</h1>
        </div>
        
        <div class="content">
          <p>Hi ${ticketOrder.customer_name},</p>
          <p>Thank you for your purchase! Your tickets for <strong>${event.title || 'Holmdale Pro Rodeo'}</strong> are confirmed.</p>
          
          <div class="ticket-details">
            <h2>Event Details</h2>
            <table>
              <tr><td class="label">Event:</td><td>${event.title || 'Holmdale Pro Rodeo'}</td></tr>
              <tr><td class="label">Date:</td><td>${eventDate}</td></tr>
              <tr><td class="label">Time:</td><td>${event.time || 'TBA'}</td></tr>
              <tr><td class="label">Venue:</td><td>${event.venue || 'Holmdale Farms'}</td></tr>
              <tr><td class="label">Ticket Type:</td><td>${(ticketOrder.ticket_type || 'general').toUpperCase()}</td></tr>
              <tr><td class="label">Quantity:</td><td>${ticketOrder.quantity_adult || 0} Adult${(ticketOrder.quantity_adult || 0) !== 1 ? 's' : ''}${ticketOrder.quantity_child ? ', ' + ticketOrder.quantity_child + ' Child' + (ticketOrder.quantity_child !== 1 ? 'ren' : '') : ''}</td></tr>
            </table>
          </div>

          <div class="qr-section">
            <h2>Your Entry Pass</h2>
            <p>Show this QR code at the gate for entry:</p>
            <div class="confirmation-code">${ticketOrder.confirmation_code}</div>
            <img src="${qrCodeDataUrl}" alt="Ticket QR Code" class="qr-code" style="max-width: 300px; height: auto; display: block; margin: 20px auto;" />
            <p style="color: #78716c; font-size: 14px; margin-top: 20px;">
              Save this email or take a screenshot of the QR code<br>
              You can also show your confirmation code at the gate
            </p>
          </div>

          <p>We look forward to seeing you at the event!</p>
        </div>
        
        <div class="footer">
          <p>This is an automated confirmation email. Please do not reply.</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

// ============================================
// POST /api/email/ticket-confirmation
// Send ticket confirmation after payment success
// ============================================
router.post('/ticket-confirmation', authenticateToken, async (req, res) => {
  try {
    const { confirmation_code } = req.body;

    if (!confirmation_code) {
      return res.status(400).json({ error: 'Missing confirmation_code' });
    }

    // Find ticket order
    const orderResult = await pool.query(
      'SELECT * FROM ticket_orders WHERE confirmation_code = $1',
      [confirmation_code]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket order not found' });
    }
    const ticketOrder = orderResult.rows[0];

    // Update status to confirmed
    await pool.query(
      "UPDATE ticket_orders SET status = 'confirmed', updated_date = NOW() WHERE id = $1",
      [ticketOrder.id]
    );

    // Get event details
    let event = { title: 'Holmdale Pro Rodeo 2026', date: null, time: 'TBA', venue: 'Holmdale Farms' };
    if (ticketOrder.event_id) {
      const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [ticketOrder.event_id]);
      if (eventResult.rows.length > 0) {
        event = eventResult.rows[0];
      }

      // Decrement available tickets
      try {
        await pool.query(
          'UPDATE events SET tickets_sold = COALESCE(tickets_sold, 0) + $1 WHERE id = $2',
          [ticketOrder.quantity || 1, ticketOrder.event_id]
        );
      } catch (e) {
        console.error('Failed to update tickets_sold:', e.message);
      }
    }

    // Generate and send email
    const emailHtml = await generateTicketEmailHtml(ticketOrder, event);

    const emailResult = await sendEmail({
      to: ticketOrder.customer_email,
      subject: `Your Tickets for ${event.title || 'Holmdale Pro Rodeo'} - Confirmation #${ticketOrder.confirmation_code}`,
      html: emailHtml
    });

    console.log(`✓ Confirmation email sent to ${ticketOrder.customer_email}, ID: ${emailResult.id}`);

    res.json({ success: true, email_sent: true, email_id: emailResult.id });

  } catch (error) {
    console.error('Ticket confirmation email error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/email/send-confirmation
// Alias for ticket-confirmation (backward compatibility)
// ============================================
router.post('/send-confirmation', authenticateToken, async (req, res) => {
  // Forward to ticket-confirmation handler
  req.url = '/ticket-confirmation';
  router.handle(req, res);
});

// ============================================
// POST /api/email/resend-ticket
// Resend ticket confirmation email
// ============================================
router.post('/resend-ticket', authenticateToken, async (req, res) => {
  try {
    const { confirmation_code, ticketOrderId } = req.body;

    let ticketOrder;
    if (confirmation_code) {
      const result = await pool.query(
        'SELECT * FROM ticket_orders WHERE confirmation_code = $1',
        [confirmation_code]
      );
      ticketOrder = result.rows[0];
    } else if (ticketOrderId) {
      const result = await pool.query(
        'SELECT * FROM ticket_orders WHERE id = $1',
        [ticketOrderId]
      );
      ticketOrder = result.rows[0];
    }

    if (!ticketOrder) {
      return res.status(404).json({ error: 'Ticket order not found' });
    }

    // Get event details
    let event = { title: 'Holmdale Pro Rodeo 2026', date: null, time: 'TBA', venue: 'Holmdale Farms' };
    if (ticketOrder.event_id) {
      const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [ticketOrder.event_id]);
      if (eventResult.rows.length > 0) {
        event = eventResult.rows[0];
      }
    }

    const emailHtml = await generateTicketEmailHtml(ticketOrder, event);

    const emailResult = await sendEmail({
      to: ticketOrder.customer_email,
      subject: `Your Tickets (Resent) - Confirmation #${ticketOrder.confirmation_code}`,
      html: emailHtml
    });

    console.log(`✓ Ticket email resent to ${ticketOrder.customer_email}`);

    res.json({ success: true, email_sent: true, email_id: emailResult.id });

  } catch (error) {
    console.error('Resend ticket email error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /api/email/test
// Send a test email
// ============================================
router.post('/test', authenticateToken, async (req, res) => {
  try {
    const { to } = req.body;
    const recipient = to || 'darren@holmgraphics.ca';

    const emailResult = await sendEmail({
      to: recipient,
      subject: 'Holmdale Rodeo - Test Email',
      html: '<h1>Test Email</h1><p>This is a test email from the Holmdale Rodeo system.</p>'
    });

    res.json({ success: true, email_id: emailResult.id });

  } catch (error) {
    console.error('Test email error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
