/**
 * Sponsor logo + website intake email.
 *
 * Emails each 2026 sponsor (with an email on file) a personalized note showing
 * the logos we currently hold and a button to a tokenized page where they can
 * upload better artwork and confirm their website. See routes/sponsor-intake.js
 * and holmdale-staff-portal/public/sponsor-logos.html.
 *
 * USAGE (run from rodeo-fresh/):
 *   Dry run (writes HTML to scripts/out/, NO DB writes, NO email):
 *     DBURL="<public pg url>" node scripts/send-logo-intake.js
 *   Real test to yourself (mints a working token for each sponsor, sends to ONE address):
 *     railway run --service rodeo-fresh node scripts/send-logo-intake.js --test darren@holmgraphics.ca --limit 1
 *   Live send to all 2026 sponsors:
 *     railway run --service rodeo-fresh node scripts/send-logo-intake.js --send
 *
 * Flags: --send (send to real sponsor emails) | --test <email> (send all to one
 * address) | --limit N (cap how many) | --year YYYY (default 2026).
 */
const { Pool } = require('pg');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const TEST_TO = val('--test', null);
const SEND = has('--send') || !!TEST_TO;     // --test implies a real send
const LIMIT = parseInt(val('--limit', '0'), 10) || 0;
const YEAR = parseInt(val('--year', '2026'), 10);
const TOKEN_TTL_DAYS = 75;                    // covers the run-up to the event
const PAGE_URL = 'https://staff.holmdalerodeo.ca/sponsor-logos.html';

const EMAIL_IMG = ['png', 'jpg', 'jpeg', 'gif'];   // what email clients reliably render
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.DBURL,
  ssl: { rejectUnauthorized: false },
});

function emailImgSrc(l) {
  const ext = (l.extension || '').toLowerCase();
  if (EMAIL_IMG.includes(ext) && l.blob_url) return l.blob_url;
  if (l.preview_url) return l.preview_url;
  return null;
}

function logoBlocks(logos) {
  if (!logos.length) {
    return `<tr><td style="padding:8px 0;color:#991b1b;font-size:14px;">⚠️ We don't have any logo on file for you yet — please upload one.</td></tr>`;
  }
  const cells = logos.map((l) => {
    const src = emailImgSrc(l);
    const fmt = l.format === 'vector' ? 'Vector (print-ready)' : 'Bitmap';
    const inner = src
      ? `<img src="${src}" alt="logo" style="max-width:130px;max-height:60px;display:block;margin:0 auto 6px;">`
      : `<div style="font-size:12px;color:#78716c;padding:14px 6px;">.${(l.extension || '').toUpperCase()} on file<br>(print-ready, no preview)</div>`;
    return `<td style="width:150px;vertical-align:top;text-align:center;padding:6px;">
      <div style="border:1px solid #e7e5e4;border-radius:8px;padding:10px;background:#fafaf9;">
        ${inner}<div style="font-size:11px;color:#78716c;">${fmt} · .${(l.extension || '').toLowerCase()}</div>
      </div></td>`;
  });
  // 2 logos per row
  let rows = '';
  for (let i = 0; i < cells.length; i += 2) {
    rows += `<tr>${cells[i]}${cells[i + 1] || '<td></td>'}</tr>`;
  }
  return rows;
}

function buildHtml(sponsor, logos, link) {
  const who = sponsor.contact_name ? sponsor.contact_name.split(/\s+/)[0] : (sponsor.name || 'there');
  const siteLine = sponsor.website
    ? `We have your website as <a href="${sponsor.website}" style="color:#00B74A;">${sponsor.website}</a> — please confirm it's current.`
    : `We don't have your website yet — please add it so we can link your logo to your site.`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:Arial,sans-serif;">
<div style="max-width:560px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
  <div style="background:#1c1917;padding:24px;text-align:center;">
    <h1 style="margin:0;color:#facc15;font-size:24px;letter-spacing:2px;">🤠 HOLMDALE PRO RODEO</h1>
    <p style="margin:8px 0 0;color:#a8a29e;font-size:14px;">Sponsor Logo &amp; Website Check</p>
  </div>
  <div style="padding:24px;">
    <p style="color:#44403c;font-size:15px;line-height:1.6;">Hi ${who},</p>
    <p style="color:#44403c;font-size:15px;line-height:1.6;">Thank you for sponsoring the <strong>2026 Holmdale Pro Rodeo</strong> (July 31 – Aug 2)! We're getting your logo ready for our website, the scrolling sponsor banner, social media and event signage — and we want to be sure we're using your <strong>best artwork</strong>.</p>
    <p style="color:#44403c;font-size:15px;line-height:1.6;">Here's what we currently have on file for you:</p>
    <table cellpadding="0" cellspacing="0" style="margin:6px auto 10px;"><tbody>${logoBlocks(logos)}</tbody></table>
    <p style="color:#44403c;font-size:15px;line-height:1.6;">If you have a better or newer logo (a vector file is ideal for print), please upload it using the button below. You can also confirm your website there. ${siteLine}</p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${link}" style="display:inline-block;padding:16px 38px;background:#00B74A;color:white;font-size:17px;font-weight:bold;text-decoration:none;border-radius:10px;">Review &amp; Update My Logo</a>
    </div>
    <p style="color:#78716c;font-size:13px;line-height:1.6;">Or paste this link into your browser:<br><a href="${link}" style="color:#00B74A;word-break:break-all;">${link}</a></p>
  </div>
  <div style="background:#1c1917;padding:16px 24px;text-align:center;">
    <p style="margin:0;color:#a8a29e;font-size:12px;">Questions? Reply to this email or contact <a href="mailto:info@holmdalerodeo.ca" style="color:#facc15;">info@holmdalerodeo.ca</a><br>Holmdale Rodeo Grounds — Walkerton, Ontario</p>
  </div>
</div>
</body></html>`;
}

(async () => {
  const fs = require('fs');
  const path = require('path');
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  let sendEmail = null;
  if (SEND) ({ sendEmail } = require('../routes/email'));

  const { rows: sponsors } = await pool.query(
    `SELECT s.id, s.name, s.contact_name, s.email, s.website
       FROM sponsors s
      WHERE s.active IS NOT FALSE
        AND s.email IS NOT NULL AND s.email <> ''
        AND EXISTS (SELECT 1 FROM sponsor_schedule ss WHERE ss.sponsor_id = s.id AND ss.year = $1)
      ORDER BY s.name`,
    [YEAR]
  );
  const list = LIMIT ? sponsors.slice(0, LIMIT) : sponsors;

  console.log(`\n${SEND ? '📧 SENDING' : '📝 DRY RUN (no DB writes, no email)'} — ${list.length} sponsor(s), year ${YEAR}`);
  if (TEST_TO) console.log(`   TEST MODE: all emails go to ${TEST_TO}\n`);

  let ok = 0, fail = 0;
  for (const s of list) {
    const logos = (await pool.query(
      `SELECT id, blob_url, preview_url, extension, format, is_primary
         FROM sponsor_logos WHERE sponsor_id = $1 ORDER BY format, is_primary DESC, created_at DESC`,
      [s.id]
    )).rows;

    let raw = 'PREVIEW-TOKEN-NOT-MINTED';
    if (SEND) {
      raw = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `UPDATE sponsors SET intake_token_hash = $1,
            intake_token_exp = NOW() + INTERVAL '${TOKEN_TTL_DAYS} days' WHERE id = $2`,
        [sha256(raw), s.id]
      );
    }
    const link = `${PAGE_URL}?token=${raw}`;
    const html = buildHtml(s, logos, link);

    const safe = (s.name || 'sponsor').replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
    fs.writeFileSync(path.join(outDir, `${s.id}-${safe}.html`), html);

    if (SEND) {
      try {
        await sendEmail({
          to: TEST_TO || s.email,
          subject: '🤠 Holmdale Rodeo — please confirm your logo & website',
          html,
          reply_to: 'info@holmdalerodeo.ca',
        });
        ok++;
      } catch (e) {
        console.error(`   ✗ ${s.name} <${s.email}>: ${e.message}`);
        fail++;
      }
    } else {
      const shown = logos.filter(emailImgSrc).length;
      console.log(`   • ${s.name.padEnd(34)} ${String(logos.length).padStart(2)} logo(s), ${shown} shown in email, website: ${s.website ? 'yes' : 'MISSING'}`);
    }
  }

  console.log(`\nHTML previews written to: ${outDir}`);
  if (SEND) console.log(`Result: ${ok} sent, ${fail} failed.`);
  else console.log(`Open one in a browser to review. Re-run with --send (or --test <email>) when ready.`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
