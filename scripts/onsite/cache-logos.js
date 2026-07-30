// Pre-warm the onsite sponsor-logo cache while internet is available.
// Downloads every sponsor_logos blob (logo + preview) into data/logo-cache
// using the same sha1(url) filenames the /api/badges/logo route serves from,
// so badge printing keeps its logos when the grounds have no internet.
//
// Run on the Mini PC (called by update-code.ps1, or by hand):
//   node scripts/onsite/cache-logos.js
//
// Per-file failures are logged and skipped — a partial cache beats none.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// standalone runs (onsite Mini PC) get creds from .env, same as migrations/run.js —
// config/database reads DATABASE_URL at require time, so this must come first
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const pool = require('../../config/database');

const LOGO_CACHE_DIR = process.env.LOGO_CACHE_DIR || path.join(__dirname, '..', '..', 'data', 'logo-cache');

function cachePath(src) {
  const key = crypto.createHash('sha1').update(src).digest('hex');
  const extM = /\.(png|jpe?g|gif|webp|svg)(?:\?|$)/i.exec(src);
  const ext = extM ? extM[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
  return path.join(LOGO_CACHE_DIR, `${key}.${ext}`);
}

(async () => {
  const r = await pool.query(`
    SELECT blob_url AS url FROM sponsor_logos WHERE blob_url IS NOT NULL
    UNION SELECT preview_url FROM sponsor_logos WHERE preview_url IS NOT NULL
    UNION SELECT company_logo_url FROM wristbands
      WHERE company_logo_url LIKE 'https://%.public.blob.vercel-storage.com/%'`);
  const urls = r.rows.map((x) => x.url).filter(Boolean);
  fs.mkdirSync(LOGO_CACHE_DIR, { recursive: true });

  let ok = 0, skip = 0, fail = 0;
  for (const url of urls) {
    const fpath = cachePath(url);
    if (fs.existsSync(fpath)) { skip++; continue; }
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      fs.writeFileSync(fpath, Buffer.from(await resp.arrayBuffer()));
      ok++;
    } catch (e) {
      console.log(`  FAIL ${url} :: ${e.message}`);
      fail++;
    }
  }
  console.log(`[cache-logos] ${urls.length} urls — downloaded ${ok}, already cached ${skip}, failed ${fail}`);
  process.exit(fail > 0 && ok === 0 && skip === 0 ? 1 : 0);
})().catch((e) => { console.error('[cache-logos] FATAL:', e.message); process.exit(1); });
