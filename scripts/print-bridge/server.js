// ============================================================
//  Rodeo Print Bridge — Seaory S25 badge printing
//
//  The badge pages (badge-checkin.html, badge-print.html,
//  badge-admin.html) rasterize the CR80 card to a 300-DPI PNG in
//  the browser and POST it here; this bridge hands it to the
//  Windows print driver full-bleed. The browser cannot reach the
//  Seaory driver itself, which is why this tiny local app exists.
//
//  Runs on the check-in laptop (the one the S25 is plugged into):
//      node scripts\print-bridge\server.js
//  or via the Startup shortcut created by install-print-bridge.ps1.
//
//  Endpoints (all JSON):
//    GET  /health  → { ok, printer, queued, lastJob }
//    POST /print   → { pngBase64, badgeId, name } → { ok } | { ok:false, error }
//
//  Zero npm dependencies on purpose — copy the folder, run node.
//
//  Env:
//    PRINT_BRIDGE_PORT    (default 7777 — what the portal pages expect)
//    SEAORY_PRINTER_NAME  (default: auto-detect a printer matching /seaory|s2\d/i,
//                          else the Windows default printer)
//    PRINT_BRIDGE_DRY_RUN (=1 to accept jobs without printing — for testing)
// ============================================================

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.PRINT_BRIDGE_PORT || '7777', 10);
const PRINTER = process.env.SEAORY_PRINTER_NAME || '';
const DRY_RUN = process.env.PRINT_BRIDGE_DRY_RUN === '1';
const PS1 = path.join(__dirname, 'print-png.ps1');
const SPOOL_DIR = path.join(os.tmpdir(), 'rodeo-print-bridge');
const MAX_BODY = 25 * 1024 * 1024;      // a CR80 300-DPI PNG is well under this
const JOB_TIMEOUT_MS = 90 * 1000;

let queued = 0;
let lastJob = null;                      // { badgeId, name, ok, error, at }
let chain = Promise.resolve();           // serialize jobs — one card at a time

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// The portal is served from https://staff.holmdalerodeo.ca (or raw-IP http)
// while this bridge is plain-http localhost, so every request is cross-origin
// and Chrome also runs a Private Network Access preflight. Answer both.
function corsHeaders(req) {
  const h = {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  };
  if (req.headers['access-control-request-private-network'] === 'true') {
    h['Access-Control-Allow-Private-Network'] = 'true';
  }
  return h;
}

function sendJson(req, res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(req) });
  res.end(JSON.stringify(obj));
}

// Accept both a data: URL (what canvas.toDataURL sends) and raw base64.
function decodePng(pngBase64) {
  if (typeof pngBase64 !== 'string' || !pngBase64) return null;
  const m = /^data:image\/png;base64,(.+)$/s.exec(pngBase64);
  const b64 = m ? m[1] : pngBase64;
  try {
    const buf = Buffer.from(b64, 'base64');
    // PNG magic bytes — reject garbage before it reaches the driver
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    return buf;
  } catch (e) { return null; }
}

function printFile(file, docName) {
  return new Promise((resolve) => {
    if (DRY_RUN) { resolve({ ok: true, printer: 'DRY RUN' }); return; }
    if (process.platform !== 'win32') {
      resolve({ ok: false, error: 'printing only works on Windows (set PRINT_BRIDGE_DRY_RUN=1 to test)' });
      return;
    }
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1,
                  '-Path', file, '-Printer', PRINTER, '-DocName', docName];
    execFile('powershell.exe', args, { timeout: JOB_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message || '').trim().split(/\r?\n/)[0];
          resolve({ ok: false, error: detail || 'print helper failed' });
        } else {
          resolve({ ok: true, printer: (stdout || '').trim() });
        }
      });
  });
}

async function handlePrint(req, res, body) {
  let data;
  try { data = JSON.parse(body); }
  catch (e) { sendJson(req, res, 400, { ok: false, error: 'invalid JSON body' }); return; }

  const png = decodePng(data.pngBase64);
  if (!png) { sendJson(req, res, 400, { ok: false, error: 'pngBase64 must be a base64 PNG' }); return; }

  const badgeId = String(data.badgeId || 'badge');
  const name = String(data.name || '').trim() || badgeId;

  fs.mkdirSync(SPOOL_DIR, { recursive: true });
  const file = path.join(SPOOL_DIR, `${badgeId.replace(/[^\w.-]/g, '_')}-${Date.now()}.png`);
  fs.writeFileSync(file, png);

  queued++;
  log(`job queued: ${name} (${badgeId}) — ${png.length} bytes, ${queued} in queue`);

  // One card at a time — the S25 feeds a single card per job and two
  // concurrent driver calls make it jam or drop one silently.
  const result = await (chain = chain.then(() => printFile(file, `Badge — ${name}`)));
  queued--;

  lastJob = { badgeId, name, ok: result.ok, error: result.error || null, at: new Date().toISOString() };
  if (result.ok) {
    log(`printed: ${name} on ${result.printer || 'printer'}`);
    fs.unlink(file, () => {});
  } else {
    // keep the PNG on disk so a failed card can be reprinted / debugged
    log(`PRINT FAILED: ${name} — ${result.error} (png kept: ${file})`);
  }
  sendJson(req, res, result.ok ? 200 : 500, result);
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  if (req.method === 'GET' && (url === '/' || url === '/health')) {
    sendJson(req, res, 200, {
      ok: true,
      printer: PRINTER || '(auto-detect Seaory)',
      dryRun: DRY_RUN,
      queued,
      lastJob,
    });
    return;
  }

  if (req.method === 'POST' && url === '/print') {
    let body = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return; }
      body += c;
    });
    req.on('end', () => { handlePrint(req, res, body).catch((e) => {
      log(`unexpected error: ${e.message}`);
      sendJson(req, res, 500, { ok: false, error: e.message });
    }); });
    req.on('error', () => {});
    return;
  }

  sendJson(req, res, 404, { ok: false, error: 'not found' });
});

// Bind localhost only — the portal pages on this machine are the only client;
// nothing on the event LAN should be able to feed cards into the printer.
server.listen(PORT, '127.0.0.1', () => {
  log(`Rodeo Print Bridge listening on http://127.0.0.1:${PORT}`);
  log(`printer: ${PRINTER || '(auto-detect: first printer matching "seaory"/"s2x", else Windows default)'}${DRY_RUN ? ' [DRY RUN]' : ''}`);
});
