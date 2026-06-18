const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const QRCode = require('qrcode'); // ← ADD THIS to package.json: npm install qrcode

// ============================================
// EMAIL ROUTES — Ticket confirmations via Resend
// ============================================

const RESEND_API_URL = 'https://api.resend.com/emails';

async function sendEmail({ to, subject, html, reply_to, attachments, from: fromOverride }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('✗ RESEND_API_KEY not set');
    throw new Error('Email service not configured');
  }

  const from = fromOverride || process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

  const payload = { from, to: [to], subject, html };
  if (reply_to) payload.reply_to = reply_to;
  if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;

  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('✗ Resend error:', data);
    throw new Error(data.message || 'Email send failed');
  }

  console.log(`✓ Email sent to ${to} — ID: ${data.id}`);
  return data;
}

// ✅ FIX: Generate inline base64 QR code — works in all email clients
async function generateQRCodeDataUrl(text) {
  return await QRCode.toDataURL(text, {
    width: 200,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' }
  });
}

// ✅ FIX: Now async because QR generation is async
async function buildTicketEmailHtml(ticket, event) {
  const qrDataUrl = await generateQRCodeDataUrl(ticket.confirmation_code);

  const eventDate = event
    ? new Date(event.date).toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : 'TBD';
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
    <img src="${qrDataUrl}" alt="QR Code" style="width:180px; height:180px; border:4px solid #1c1917; border-radius:12px;">
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

    const result = await pool.query(
      'SELECT * FROM ticket_orders WHERE confirmation_code = $1 OR id = $2',
      [code, code]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket order not found' });
    }

    const ticket = result.rows[0];
    if (!ticket.customer_email) {
      console.log(`[Email] No email address for order ${code}`);
      return res.status(400).json({ error: 'No customer email on order' });
    }

    await pool.query(
      'UPDATE ticket_orders SET payment_status = $1, updated_date = NOW() WHERE id = $2',
      ['confirmed', ticket.id]
    );

    let event = null;
    if (ticket.event_id) {
      const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [ticket.event_id]);
      if (eventResult.rows.length > 0) event = eventResult.rows[0];
    }

    // ✅ FIX: await the now-async buildTicketEmailHtml
    const html = await buildTicketEmailHtml(ticket, event);
    await sendEmail({
      to: ticket.customer_email,
      subject: `🎟 Your Holmdale Pro Rodeo Tickets — ${ticket.confirmation_code}`,
      html
    });

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

    // ✅ FIX: await the now-async buildTicketEmailHtml
    const html = await buildTicketEmailHtml(ticket, event);
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

// ============================================
// POST /api/email/vendor-invite
// Send vendor registration form link by email
// ============================================
router.post('/vendor-invite', authenticateToken, async (req, res) => {
  try {
    const { to, vendor_name, personal_message } = req.body;
    if (!to) {
      return res.status(400).json({ error: 'Email address required' });
    }

    const regUrl = 'https://staff.holmdalerodeo.ca/vendor-register.html';
    const greeting = vendor_name ? `Hi ${vendor_name},` : 'Hello,';
    const personalNote = personal_message
      ? `<p style="color:#44403c;font-size:14px;line-height:1.6;background:#f5f5f4;border-radius:8px;padding:12px;margin:16px 0;font-style:italic;">"${personal_message}"</p>`
      : '';

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:Arial,sans-serif;">
<div style="max-width:500px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
  <div style="background:#1c1917;padding:24px;text-align:center;">
    <h1 style="margin:0;color:#facc15;font-size:24px;letter-spacing:2px;">🤠 HOLMDALE PRO RODEO</h1>
    <p style="margin:8px 0 0;color:#a8a29e;font-size:14px;">Vendor Registration Invitation</p>
  </div>
  <div style="padding:24px;">
    <p style="color:#44403c;font-size:14px;line-height:1.6;">${greeting}</p>
    <p style="color:#44403c;font-size:14px;line-height:1.6;">You're invited to register as a vendor for the <strong>Holmdale Pro Rodeo</strong>! We'd love to have you join us for an exciting weekend of rodeo action and great crowds.</p>
    ${personalNote}
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;margin:20px 0;text-align:center;">
      <p style="margin:0 0 4px;color:#166534;font-weight:bold;font-size:16px;">📅 July 31 - August 2, 2026</p>
      <p style="margin:0;color:#166534;font-size:14px;">📍 588 Sideroad 10 S., Walkerton, ON</p>
    </div>
    <div style="text-align:center;margin:24px 0;">
      <a href="${regUrl}" style="display:inline-block;padding:16px 40px;background:#00B74A;color:white;font-size:18px;font-weight:bold;text-decoration:none;border-radius:10px;">Register Now</a>
    </div>
    <p style="color:#78716c;font-size:13px;line-height:1.6;">Click the button above to fill out the registration form. You'll be able to select your booth size and vendor type. Booth pricing details will follow.</p>
    <p style="color:#78716c;font-size:13px;">Or copy this link: <a href="${regUrl}" style="color:#00B74A;">${regUrl}</a></p>
  </div>
  <div style="background:#1c1917;padding:16px 24px;text-align:center;">
    <p style="margin:0;color:#a8a29e;font-size:12px;">Holmdale Rodeo Grounds — Walkerton, Ontario<br>Questions? Contact us at info@holmdalerodeo.ca</p>
  </div>
</div>
</body></html>`;

    await sendEmail({
      to,
      subject: '🤠 You\'re Invited — Vendor Registration for Holmdale Pro Rodeo',
      html
    });

    console.log(`✓ Vendor invite sent to ${to}`);
    res.json({ success: true, message: `Invitation sent to ${to}` });
  } catch (error) {
    console.error('Vendor invite error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SPONSOR OUTREACH
// POST /api/email/sponsor-outreach
// Body: {
//   sponsor_ids: [number],
//   outreach_year: number,
//   attachment: { filename: string, content_base64: string } | null,
//   reply_to: string,
//   dry_run: boolean
// }
// Returns: { sent: [{sponsor_id, email, status: 'ok'|'error'|'skipped', message, resend_id?}], ... }
// ============================================

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function buildSponsorOutreachHtml({ contact_first_name, sponsor_name, prior_years_phrase }) {
  // greeting line
  const greeting = contact_first_name
    ? `Hi ${escapeHtml(contact_first_name)},`
    : `Hello ${escapeHtml(sponsor_name)} team,`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#222;max-width:640px;margin:0 auto;padding:24px;line-height:1.55;font-size:15px;">

  <p>${greeting}</p>

  <p>We hope you and the team at <strong>${escapeHtml(sponsor_name)}</strong> are doing well. As we get ready for the 2026 Holmdale Pro Rodeo (July 31 – August 2), we wanted to reach out personally — your support in ${escapeHtml(prior_years_phrase)} meant a lot to us, and the event simply wouldn't be what it is without partners like you.</p>

  <p>This year is shaping up to be our biggest yet. A few highlights we're excited about:</p>

  <ul style="padding-left:20px;">
    <li style="margin-bottom:10px;"><strong>A new 140' × 70' permanent building with a covered patio</strong> is going up on the rodeo grounds right now — it'll house a full commercial kitchen, bar facilities, and our mechanical bull, giving us an enhanced venue for the event.</li>
    <li style="margin-bottom:10px;"><strong>High School Rodeo in the afternoon</strong> has been added Saturday and Sunday at 2 PM, expanding the weekend and bringing the next generation of cowboys and cowgirls to the arena.</li>
    <li style="margin-bottom:10px;"><strong>VIP box seats</strong> debuting this year, right above the chutes — an extraordinary up-close view of the action that we think sponsors and their guests are going to love.</li>
  </ul>

  <p>We're putting the final touches on this year's program and wanted to make sure you had a chance to look at the sponsorship opportunities before things fill up. The attached booklet walks through the available levels and what's included at each one. Whether you'd like to renew at the same level or explore something different, we'd love to hear from you.</p>

  <p>If you have any questions or want to talk through what makes sense for <strong>${escapeHtml(sponsor_name)}</strong> this year, just hit reply or give one of us a shout.</p>

  <p>Thanks again for being part of the Holmdale story. We can't wait to see you in the stands — or in one of those VIP boxes — this summer.</p>

  <p style="margin-top:24px;">All the best,<br>
  <strong>Todd &amp; Darren Holm</strong><br>
  <span style="color:#888;">Holmdale Pro Rodeo</span></p>

</body></html>`;
}

function priorYearsPhrase(years) {
  const sorted = [...new Set(years.map(Number))].filter(y => !isNaN(y)).sort((a,b) => a - b);
  if (!sorted.length) return 'past years';
  if (sorted.length === 1) return String(sorted[0]);
  if (sorted.length === 2) return `${sorted[0]} and ${sorted[1]}`;
  return `${sorted.slice(0, -1).join(', ')}, and ${sorted[sorted.length - 1]}`;
}

router.post('/sponsor-outreach', authenticateToken, async (req, res) => {
  try {
    const { sponsor_ids, outreach_year, attachment, reply_to, dry_run, from } = req.body;
    if (!Array.isArray(sponsor_ids) || sponsor_ids.length === 0) {
      return res.status(400).json({ error: 'sponsor_ids must be a non-empty array' });
    }
    const year = parseInt(outreach_year, 10) || new Date().getFullYear();

    // Build attachment array once if provided (Resend wants {filename, content})
    let resendAttachments = null;
    if (attachment && attachment.content_base64) {
      resendAttachments = [{
        filename: attachment.filename || 'sponsorship-booklet.pdf',
        content: attachment.content_base64
      }];
    }

    const subject = `Holmdale Pro Rodeo ${year} — We'd love to have you back`;
    const results = [];

    for (const id of sponsor_ids) {
      // Fetch sponsor + prior years
      const sponsorResult = await pool.query('SELECT * FROM sponsors WHERE id = $1', [id]);
      if (sponsorResult.rows.length === 0) {
        results.push({ sponsor_id: id, status: 'error', message: 'Sponsor not found' });
        continue;
      }
      const sponsor = sponsorResult.rows[0];

      if (!sponsor.email) {
        results.push({ sponsor_id: id, sponsor_name: sponsor.name, status: 'skipped', message: 'No email on file' });
        continue;
      }

      const schedResult = await pool.query(
        `SELECT year FROM sponsor_schedule WHERE sponsor_id = $1 AND amount > 0 AND year < $2 ORDER BY year`,
        [id, year]
      );
      const priorYears = schedResult.rows.map(r => r.year);
      const prior_years_phrase = priorYearsPhrase(priorYears);

      // Extract first name from contact_name (handles "First Last", "First", or blank)
      const contact_first_name = (sponsor.contact_name || '').trim().split(/\s+/)[0] || '';

      const html = buildSponsorOutreachHtml({
        contact_first_name,
        sponsor_name: sponsor.name || sponsor.contact_name || 'there',
        prior_years_phrase
      });

      if (dry_run) {
        results.push({
          sponsor_id: id,
          sponsor_name: sponsor.name,
          email: sponsor.email,
          status: 'dry_run',
          message: 'Would send',
          preview_subject: subject,
          preview_prior_years: prior_years_phrase,
          preview_html: html
        });
        continue;
      }

      try {
        const sendResult = await sendEmail({
          to: sponsor.email,
          subject,
          html,
          from: from || undefined,
          reply_to: reply_to || undefined,
          attachments: resendAttachments
        });
        results.push({
          sponsor_id: id,
          sponsor_name: sponsor.name,
          email: sponsor.email,
          status: 'ok',
          resend_id: sendResult.id
        });
      } catch (err) {
        results.push({
          sponsor_id: id,
          sponsor_name: sponsor.name,
          email: sponsor.email,
          status: 'error',
          message: err.message
        });
      }
    }

    const summary = {
      total: results.length,
      sent: results.filter(r => r.status === 'ok').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      errors: results.filter(r => r.status === 'error').length,
      dry_run: results.filter(r => r.status === 'dry_run').length
    };

    res.json({ summary, results });
  } catch (error) {
    console.error('Sponsor outreach error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
// Expose the Resend helper so other routes (e.g. sponsor-portal magic links)
// can send mail without duplicating the Resend fetch.
module.exports.sendEmail = sendEmail;
