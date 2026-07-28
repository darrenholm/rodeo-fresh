// ============================================================
//  Rodeo Countdown — daily Facebook post counting down to the 2026
//  rodeo weekend (July 31 – Aug 2), switching to day-of hype posts
//  during the event and going silent after. Rides the same Graph API
//  pipeline as lib/spotlight.js; posts are tracked in social_posts
//  with platform 'fb-countdown' so the sponsor-spotlight rotation
//  (platform 'facebook') never sees them.
// ============================================================
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { put } = require('@vercel/blob');
const pool = require('../config/database');
const { getPage } = require('./spotlight');

const GRAPH = 'https://graph.facebook.com/v21.0';
const RODEO_LOGO = path.join(__dirname, '..', 'assets', 'rodeo-logo.png');
const FONT = 'Liberation Sans, Arial, DejaVu Sans, sans-serif';

// Event days (America/Toronto dates)
const FRIDAY = '2026-07-31';
const SATURDAY = '2026-08-01';
const SUNDAY = '2026-08-02';

const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function torontoToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }); // YYYY-MM-DD
}

// What should today's post be? Returns { mode, daysLeft } or null when the
// weekend is over (the cron keeps firing but does nothing).
function todaysMode(today = torontoToday()) {
  if (today > SUNDAY) return null;
  if (today === FRIDAY) return { mode: 'friday', daysLeft: 0 };
  if (today === SATURDAY) return { mode: 'saturday', daysLeft: 0 };
  if (today === SUNDAY) return { mode: 'sunday', daysLeft: 0 };
  const days = Math.round((Date.parse(FRIDAY) - Date.parse(today)) / 86400000);
  return { mode: 'countdown', daysLeft: days };
}

const SCHEDULE_BLOCK = [
  '📅 THE WEEKEND LINEUP',
  '',
  '🐄 FRIDAY JULY 31 — Team Penning 1pm (FREE event!) · 🍗 WING NIGHT 5pm',
  '🤠 SATURDAY AUG 1 — Gates 11am · High School Rodeo 2pm · PRO RODEO 7pm',
  '🤠 SUNDAY AUG 2 — Gates 11am · High School Rodeo 2pm · PRO RODEO 7pm',
  '',
  '🍻 Bar, food booth & food trucks open all three days!',
].join('\n');

const TICKET_BLOCK = [
  '⚠️ This event is expected to SELL OUT — don’t risk missing it at the gate!',
  '🎟️ Get your tickets NOW at holmdalerodeo.ca',
  '$35 adult / $80 family',
].join('\n');

const TAGS = '#HolmdaleProRodeo #Rodeo #Walkerton #BruceCounty #WingNight';

function buildCaption({ mode, daysLeft }) {
  if (mode === 'countdown') {
    const d = daysLeft === 1 ? 'ONLY 1 DAY' : `ONLY ${daysLeft} DAYS`;
    return `🚨 ${d} until the 2026 Holmdale Pro Rodeo! 🚨\n\n${SCHEDULE_BLOCK}\n\n${TICKET_BLOCK}\n\n${TAGS}`;
  }
  if (mode === 'friday') {
    return `🤠 IT’S RODEO WEEKEND — TODAY IS THE DAY!\n\nKick things off at the Holmdale Rodeo Grounds:\n🐄 1:00 PM — Team Penning (FREE event!)\n🍗 5:00 PM — WING NIGHT! Come hungry.\n\n${SCHEDULE_BLOCK}\n\n${TICKET_BLOCK}\n\n${TAGS}`;
  }
  if (mode === 'saturday') {
    return `⭐ PRO RODEO TONIGHT AT 7PM! ⭐\n\n🚪 Gates open 11am\n🏫 2:00 PM — High School Rodeo\n⭐ 7:00 PM — PRO RODEO by Rawhide Rodeos\n🍻 Bar, food booth & food trucks on site all day!\n\nAnd we do it all again tomorrow — same schedule Sunday!\n\n${TICKET_BLOCK}\n\n${TAGS}`;
  }
  // sunday
  return `🚨 LAST CHANCE — FINAL DAY OF THE 2026 HOLMDALE PRO RODEO! 🚨\n\n🚪 Gates open 11am\n🏫 2:00 PM — High School Rodeo\n⭐ 7:00 PM — PRO RODEO by Rawhide Rodeos\n🍻 Bar, food booth & food trucks on site all day!\n\n${TICKET_BLOCK}\n\n${TAGS}`;
}

// 1080x1080 countdown card: rodeo logo up top, a huge headline in the middle,
// dates + ticket call-to-action at the bottom. Same look as the spotlight cards.
async function buildCountdownCard({ mode, daysLeft }) {
  const W = 1080, H = 1080;
  let big, bigSize, sub;
  if (mode === 'countdown') { big = String(daysLeft); bigSize = daysLeft > 9 ? 360 : 430; sub = daysLeft === 1 ? 'DAY UNTIL RODEO' : 'DAYS UNTIL RODEO'; }
  else if (mode === 'friday') { big = 'TODAY!'; bigSize = 200; sub = 'RODEO WEEKEND IS HERE'; }
  else if (mode === 'saturday') { big = 'TONIGHT'; bigSize = 180; sub = 'PRO RODEO · 7PM'; }
  else { big = 'LAST DAY'; bigSize = 160; sub = 'PRO RODEO TONIGHT · 7PM'; }

  const rodeoBuf = fs.readFileSync(RODEO_LOGO);
  const r = await sharp(rodeoBuf).resize(300, 230, { fit:'inside' }).png().toBuffer();
  const m = await sharp(r).metadata();

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#1c1917"/>
    <rect x="0" y="0" width="${W}" height="14" fill="#facc15"/>
    <rect x="0" y="${H-14}" width="${W}" height="14" fill="#facc15"/>
    <text x="${W/2}" y="640" text-anchor="middle" font-family="${FONT}" font-weight="bold" font-size="${bigSize}" fill="#facc15">${esc(big)}</text>
    <text x="${W/2}" y="742" text-anchor="middle" font-family="${FONT}" font-weight="bold" font-size="52" fill="#ffffff" letter-spacing="4">${esc(sub)}</text>
    <text x="${W/2}" y="850" text-anchor="middle" font-family="${FONT}" font-weight="bold" font-size="38" fill="#a8a29e" letter-spacing="2">JULY 31 – AUGUST 2 · WALKERTON, ON</text>
    <rect x="${W/2-330}" y="900" width="660" height="72" rx="36" fill="#facc15"/>
    <text x="${W/2}" y="948" text-anchor="middle" font-family="${FONT}" font-weight="bold" font-size="34" fill="#1c1917" letter-spacing="1">🎟 TICKETS: HOLMDALERODEO.CA</text>
  </svg>`;
  return sharp(Buffer.from(svg))
    .composite([{ input: r, left: Math.round((W - m.width) / 2), top: 60 }])
    .png().toBuffer();
}

// Post today's countdown/hype post. Skips if the weekend is over or one
// already went out today (Toronto) unless opts.force.
async function postCountdown(opts = {}) {
  const plan = todaysMode();
  if (!plan) { console.log('[countdown] rodeo weekend is over — nothing to post'); return { skipped: 'event over' }; }
  if (!opts.force) {
    const today = await pool.query(
      `SELECT 1 FROM social_posts WHERE platform='fb-countdown'
         AND (posted_at AT TIME ZONE 'America/Toronto')::date = (NOW() AT TIME ZONE 'America/Toronto')::date LIMIT 1`);
    if (today.rows.length) { console.log('[countdown] already posted today — skipping'); return { skipped: 'already posted today' }; }
  }

  const png = await buildCountdownCard(plan);
  const blob = await put(`countdown/${Date.now()}-${plan.mode}.png`, png, { access:'public', contentType:'image/png', addRandomSuffix:false });
  const caption = buildCaption(plan);

  const { pageId, pageToken } = await getPage();
  const body = new URLSearchParams({ url: blob.url, message: caption, access_token: pageToken });
  const res = await (await fetch(`${GRAPH}/${pageId}/photos`, { method:'POST', body })).json();
  if (res.error) throw new Error('FB post: ' + res.error.message);

  const postId = res.post_id || res.id;
  await pool.query(
    `INSERT INTO social_posts (platform, fb_post_id, image_url, caption) VALUES ('fb-countdown',$1,$2,$3)`,
    [postId, blob.url, caption]);
  console.log(`[countdown] posted ${plan.mode}${plan.mode==='countdown' ? ' ('+plan.daysLeft+' days)' : ''} -> ${postId}`);
  return { ...plan, postId, imageUrl: blob.url };
}

module.exports = { postCountdown, todaysMode, buildCaption, buildCountdownCard };
