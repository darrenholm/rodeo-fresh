// ============================================================
//  Sponsor Spotlight — generates a branded card, posts it to the
//  Holmdale Rodeo Facebook page, and records it. See the daily cron
//  in server.js and routes/social.js. Setup notes: memory holmdale-facebook-poster.
// ============================================================
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { put } = require('@vercel/blob');
const pool = require('../config/database');
const { sendEmail } = require('../routes/email');

const GRAPH = 'https://graph.facebook.com/v21.0';
const RODEO_LOGO = path.join(__dirname, '..', 'assets', 'rodeo-logo.png');
const TIER_COLOR = { Title:'#facc15', Platinum:'#d9d9e3', Gold:'#d4af37', Silver:'#c0c0c0', Bronze:'#cd7f32', Friend:'#00B74A' };

const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// Fonts available in the container (installed via nixpacks.toml). Listing real
// installed families avoids tofu boxes when no "Arial" exists on the box.
const FONT = 'Liberation Sans, Arial, DejaVu Sans, sans-serif';

async function fit(buf, w, h) {
  const r = await sharp(buf).resize(w, h, { fit:'inside' }).png().toBuffer();
  const m = await sharp(r).metadata();
  return { buf:r, w:m.width, h:m.height };
}

// 1080x1080 spotlight card: rodeo logo, tier badge, sponsor logo on a white panel, dates.
async function buildCard({ name, level, logoBuf }) {
  const W = 1080, H = 1080, tcol = TIER_COLOR[level] || '#facc15';
  const tierTxt = level ? `PROUD ${level.toUpperCase()} SPONSOR` : 'PROUD SPONSOR';
  const nf = name.length > 22 ? 54 : (name.length > 15 ? 70 : 86);
  const comps = [];
  const rodeoBuf = fs.readFileSync(RODEO_LOGO);
  const rl = await fit(rodeoBuf, 300, 230);
  comps.push({ input: rl.buf, left: Math.round((W - rl.w) / 2), top: 50 });
  const PX = 150, PY = 410, PW = 780, PH = 350, pad = 44;
  if (logoBuf) {
    const sl = await fit(logoBuf, PW - pad*2, PH - pad*2);
    comps.push({ input: sl.buf, left: Math.round(PX + (PW - sl.w)/2), top: Math.round(PY + (PH - sl.h)/2) });
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#1c1917"/>
    <rect x="0" y="0" width="${W}" height="14" fill="#facc15"/>
    <rect x="0" y="${H-14}" width="${W}" height="14" fill="#facc15"/>
    <rect x="${W/2-265}" y="312" width="530" height="60" rx="30" fill="${tcol}"/>
    <text x="${W/2}" y="352" text-anchor="middle" font-family="${FONT}" font-weight="bold" font-size="33" fill="#1c1917" letter-spacing="2">${esc(tierTxt)}</text>
    <rect x="${PX}" y="${PY}" width="${PW}" height="${PH}" rx="28" fill="#ffffff"/>
    <text x="${W/2}" y="${PY+PH+95}" text-anchor="middle" font-family="${FONT}" font-weight="bold" font-size="${nf}" fill="#ffffff">${esc(name)}</text>
    <text x="${W/2}" y="945" text-anchor="middle" font-family="${FONT}" font-weight="bold" font-size="40" fill="#facc15" letter-spacing="2">JULY 31 – AUGUST 2, 2026</text>
    <text x="${W/2}" y="1000" text-anchor="middle" font-family="${FONT}" font-size="29" fill="#a8a29e" letter-spacing="3">WALKERTON, ONTARIO</text>
  </svg>`;
  return sharp(Buffer.from(svg)).composite(comps).png().toBuffer();
}

const OPENERS = ['🤠 SPONSOR SPOTLIGHT 🤠', '🌟 SPONSOR SPOTLIGHT 🌟', '🐂 SPONSOR SPOTLIGHT 🐂'];
function buildCaption(s) {
  const tier = s.sponsor_level ? s.sponsor_level.toUpperCase() + ' ' : '';
  const opener = OPENERS[Math.floor(Math.random() * OPENERS.length)];
  let c = `${opener}\n\nHuge thanks to ${s.name} — a proud ${tier}sponsor of the 2026 Holmdale Pro Rodeo!\n\nWe couldn't put on the show without great local businesses like them.`;
  if (s.website) c += `\n👉 ${s.website}`;
  c += `\n\n📅 July 31 – August 2, 2026 · Walkerton, ON\n🎟️ holmdalerodeo.ca\n\n#HolmdaleProRodeo #Rodeo #Walkerton #BruceCounty`;
  return c;
}

// Next sponsor to feature: this year's sponsors that have a web-displayable logo,
// never-posted first, then longest-since-posted; tie-break by tier then name.
// Foam Tek held out until its dark-background logo is cleaned up.
async function selectNextSponsor() {
  const r = await pool.query(`
    SELECT s.id, s.name, s.sponsor_level, NULLIF(s.website,'') AS website,
      (SELECT blob_url FROM sponsor_logos WHERE sponsor_id=s.id AND format='bitmap'
         AND lower(extension) IN ('png','jpg','jpeg') ORDER BY is_primary DESC, created_at DESC LIMIT 1) AS logo,
      (SELECT MAX(posted_at) FROM social_posts sp WHERE sp.sponsor_id=s.id AND sp.platform='facebook') AS last_posted,
      COALESCE((SELECT rank FROM sponsor_levels WHERE name=s.sponsor_level), 99) AS tier_rank
    FROM sponsors s
    WHERE s.active IS NOT FALSE
      AND s.name <> 'Foam Tek'
      AND EXISTS (SELECT 1 FROM sponsor_schedule ss WHERE ss.sponsor_id=s.id AND ss.year=2026)
      AND EXISTS (SELECT 1 FROM sponsor_logos sl WHERE sl.sponsor_id=s.id AND lower(sl.extension) IN ('png','jpg','jpeg'))
    ORDER BY last_posted ASC NULLS FIRST, tier_rank ASC, s.name
    LIMIT 1`);
  return r.rows[0] || null;
}

async function getPage() {
  const tok = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!tok) throw new Error('FB_PAGE_ACCESS_TOKEN not set');
  const r = await (await fetch(`${GRAPH}/me/accounts?fields=id,access_token&access_token=${tok}`)).json();
  if (r.error) throw new Error('FB /me/accounts: ' + r.error.message);
  const page = (r.data || [])[0];
  if (!page) throw new Error('Token has no accessible Facebook page');
  return { pageId: page.id, pageToken: page.access_token };
}

const fetchBuf = async (u) => Buffer.from(await (await fetch(u)).arrayBuffer());

// Post the next sponsor spotlight. Skips if one already went out today (Toronto)
// unless opts.force. Returns a result object.
async function postNextSpotlight(opts = {}) {
  if (!opts.force) {
    const today = await pool.query(
      `SELECT 1 FROM social_posts WHERE platform='facebook'
         AND (posted_at AT TIME ZONE 'America/Toronto')::date = (NOW() AT TIME ZONE 'America/Toronto')::date LIMIT 1`);
    if (today.rows.length) { console.log('[spotlight] already posted today — skipping'); return { skipped: 'already posted today' }; }
  }
  const s = await selectNextSponsor();
  if (!s) { console.log('[spotlight] no eligible sponsor'); return { skipped: 'no eligible sponsor' }; }

  const logoBuf = s.logo ? await fetchBuf(s.logo) : null;
  const png = await buildCard({ name: s.name, level: s.sponsor_level, logoBuf });
  const blob = await put(`spotlights/${Date.now()}-${s.id}.png`, png, { access:'public', contentType:'image/png', addRandomSuffix:false });
  const caption = buildCaption(s);

  const { pageId, pageToken } = await getPage();
  const body = new URLSearchParams({ url: blob.url, message: caption, access_token: pageToken });
  const res = await (await fetch(`${GRAPH}/${pageId}/photos`, { method:'POST', body })).json();
  if (res.error) throw new Error('FB post: ' + res.error.message);

  const postId = res.post_id || res.id;
  await pool.query(
    `INSERT INTO social_posts (sponsor_id, platform, fb_post_id, image_url, caption) VALUES ($1,'facebook',$2,$3,$4)`,
    [s.id, postId, blob.url, caption]);
  console.log(`[spotlight] posted ${s.name} -> ${postId}`);
  return { sponsor: s.name, level: s.sponsor_level, postId, imageUrl: blob.url };
}

// ── Weekly status report ──
async function getStatus() {
  const base = `s.active IS NOT FALSE AND EXISTS(SELECT 1 FROM sponsor_schedule ss WHERE ss.sponsor_id=s.id AND ss.year=2026)`;
  const hasLogo = `EXISTS(SELECT 1 FROM sponsor_logos sl WHERE sl.sponsor_id=s.id AND lower(sl.extension) IN ('png','jpg','jpeg'))`;
  const recent = (await pool.query(
    `SELECT s.name, sp.posted_at FROM social_posts sp JOIN sponsors s ON s.id=sp.sponsor_id
       WHERE sp.platform='facebook' AND sp.posted_at > NOW() - INTERVAL '7 days' ORDER BY sp.posted_at`)).rows;
  const queue = (await pool.query(
    `SELECT s.name, s.sponsor_level FROM sponsors s
       WHERE ${base} AND ${hasLogo} AND s.name <> 'Foam Tek'
         AND NOT EXISTS (SELECT 1 FROM social_posts sp WHERE sp.sponsor_id=s.id AND sp.platform='facebook')
       ORDER BY COALESCE((SELECT rank FROM sponsor_levels WHERE name=s.sponsor_level),99), s.name`)).rows;
  const gaps = (await pool.query(`SELECT s.name FROM sponsors s WHERE ${base} AND NOT ${hasLogo} ORDER BY s.name`)).rows;
  const eligible = (await pool.query(`SELECT COUNT(*)::int n FROM sponsors s WHERE ${base} AND ${hasLogo} AND s.name <> 'Foam Tek'`)).rows[0].n;
  return { recent, queue, gaps, eligible };
}

function reportHtml(st) {
  const li = (arr, fmt) => arr.length ? arr.map(fmt).join('') : '<li style="color:#a8a29e">— none —</li>';
  const d = (x) => new Date(x).toLocaleDateString('en-CA', { weekday:'short', month:'short', day:'numeric' });
  const gapsBlock = st.gaps.length
    ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;margin-top:16px;">
         <p style="margin:0 0 6px;color:#991b1b;font-weight:bold;">⚠️ Won't be spotlighted — no web logo (${st.gaps.length})</p>
         <p style="margin:0 0 8px;color:#7f1d1d;font-size:13px;">Upload a PNG/JPG logo in the staff portal and they auto-join the rotation.</p>
         <ul style="margin:0;padding-left:18px;color:#7f1d1d;">${st.gaps.map(g=>`<li>${g.name}</li>`).join('')}</ul>
       </div>` : `<p style="color:#166534;margin-top:16px;">✅ Every 2026 sponsor has a logo and is in the rotation.</p>`;
  return `<!DOCTYPE html><html><body style="margin:0;background:#f5f5f4;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
    <div style="background:#1c1917;padding:22px;text-align:center;"><h1 style="margin:0;color:#facc15;font-size:22px;letter-spacing:1px;">🤠 SPONSOR SPOTLIGHT — WEEKLY REPORT</h1></div>
    <div style="padding:22px;color:#44403c;">
      <p style="font-size:14px;">Here's the Facebook sponsor-spotlight status. One sponsor posts automatically each day.</p>
      <h3 style="color:#1c1917;margin:18px 0 6px;border-bottom:2px solid #00B74A;padding-bottom:4px;">Posted this week (${st.recent.length})</h3>
      <ul style="margin:0;padding-left:18px;">${li(st.recent, r=>`<li>${r.name} <span style="color:#a8a29e;font-size:12px;">— ${d(r.posted_at)}</span></li>`)}</ul>
      <h3 style="color:#1c1917;margin:18px 0 6px;border-bottom:2px solid #00B74A;padding-bottom:4px;">Coming up (${st.queue.length} queued, ${st.eligible} in rotation)</h3>
      <ul style="margin:0;padding-left:18px;">${li(st.queue.slice(0,8), q=>`<li>${q.name} <span style="color:#a8a29e;font-size:12px;">(${q.sponsor_level||'no tier'})</span></li>`)}${st.queue.length>8?`<li style="color:#a8a29e;">…and ${st.queue.length-8} more</li>`:''}</ul>
      ${gapsBlock}
    </div>
    <div style="background:#1c1917;padding:14px;text-align:center;"><p style="margin:0;color:#a8a29e;font-size:12px;">Holmdale Pro Rodeo · automated weekly report</p></div>
  </div></body></html>`;
}

async function sendWeeklyReport() {
  const to = process.env.SPOTLIGHT_REPORT_TO || 'darren@holmgraphics.ca';
  const st = await getStatus();
  await sendEmail({ to, subject: '🤠 Holmdale Rodeo — Weekly Sponsor Spotlight Report', html: reportHtml(st) });
  console.log(`[spotlight] weekly report sent to ${to} (posted:${st.recent.length} queue:${st.queue.length} gaps:${st.gaps.length})`);
  return { sentTo: to, posted: st.recent.length, queue: st.queue.length, gaps: st.gaps.length };
}

module.exports = { postNextSpotlight, selectNextSponsor, buildCard, buildCaption, getStatus, sendWeeklyReport, getPage };
