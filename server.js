require('dotenv').config();

// Fail fast on misconfigured deploy — better than silently signing JWTs
// with the source-code fallback that previously lived in routes/auth-routes.js.
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable not set');
  process.exit(1);
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pool = require('./config/database');

// ============================================
// IMPORT ROUTES
// ============================================

// Auth & Users
const authRoutes = require('./routes/auth');
const staffAuthRoutes = require('./routes/auth-routes');

// Core data
const staffRoutes = require('./routes/staff');
const eventRoutes = require('./routes/events');
const ticketOrderRoutes = require('./routes/ticketOrders');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const dashboardRoutes = require('./routes/dashboard');
const sponsorsVendorsRoutes = require('./routes/sponsors-vendors');
const sponsorPortalRoutes = require('./routes/sponsors-portal');
const sponsorLogosRoutes = require('./routes/sponsorLogos');
const vendorLogosRoutes = require('./routes/vendorLogos');

// Wristbands & Bar
const wristbandRoutes = require('./routes/wristbands');
const drinkRoutes = require('./routes/drinks');
const staffWristbandRoutes = require('./routes/staff-wristband');

// VIP / Volunteer / Sponsor name-tag badges (printed NFC cards)
const badgeRoutes = require('./routes/badges');

// Shifts
const shiftRoutes = require('./routes/shift-routes');

// Payments
const monerisRoutes = require('./routes/moneris');
const stripeRoutes = require('./routes/stripe');

// Email & Reports
const emailRoutes = require('./routes/email');
const reportRoutes = require('./routes/reports');

// NEW: Food & Drink Menu (database-backed)
const boothMenuRoutes = require('./routes/boothMenu')(pool);

// NEW: Kitchen Display System
const kitchenRoutes = require('./routes/kitchenOrders')(pool);

// NEW: Merchandise POS
const merchRoutes = require('./routes/merchSales')(pool);

// NEW: Wristband Transfer & Balance
const wristbandTransferRoutes = require('./routes/wristbandTransfer')(pool);
const featureRoutes = require('./routes/features');

const app = express();

// ============================================
// MIDDLEWARE
// ============================================

app.use(helmet());
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    const allowedOrigins = [
      'https://holmdalerodeo.ca',
      'https://www.holmdalerodeo.ca',
      'https://staff.holmdalerodeo.ca',
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173',
      'file://'
    ];
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  if (req.path !== '/health') {
    console.log(`${req.method} ${req.path}`);
  }
  next();
});

// ============================================
// ROUTES
// ============================================

// Auth & Users
app.use('/api/auth', authRoutes);
app.use('/api/auth', staffAuthRoutes);

// Core data
app.use('/api/staff', staffRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/ticket-orders', ticketOrderRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/dashboard', dashboardRoutes);

// Wristbands & Bar
app.use('/api/wristbands', wristbandRoutes);
app.use('/api/drinks', drinkRoutes);
app.use('/api/staff-wristband', staffWristbandRoutes);

// Badges (VIP / Volunteer / Sponsor printed NFC name tags)
app.use('/api/badges', badgeRoutes);

// Shifts
app.use('/api/shifts', shiftRoutes);
app.use('/api/shifts-manage', shiftRoutes);

// Payments
app.use('/api/moneris', monerisRoutes);
app.use('/api/stripe', stripeRoutes);

// Email & Reports
app.use('/api/email', emailRoutes);
app.use('/api/reports', reportRoutes);

// Booth Menu
app.use('/api/booth/menu', boothMenuRoutes);

// Kitchen Orders
app.use('/api/kitchen', kitchenRoutes);

// Merchandise Sales
app.use('/api/merch', merchRoutes);

// Sponsors & Vendors
app.use('/api', sponsorsVendorsRoutes);
app.use('/api/sponsor-portal', sponsorPortalRoutes);
app.use('/api/sponsor-logos', sponsorLogosRoutes);
app.use('/api/vendor-logos', vendorLogosRoutes);

// Wristband Transfer & Balance
app.use('/api/wristbands', wristbandTransferRoutes);
app.use('/api/features', featureRoutes);

// ============================================
// HEALTH & INFO
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'Holmdale Rodeo API',
    version: '3.0.0',
    endpoints: {
      auth: '/api/auth',
      staff: '/api/staff',
      events: '/api/events',
      shifts: '/api/shifts',
      ticketOrders: '/api/ticket-orders',
      products: '/api/products',
      orders: '/api/orders',
      dashboard: '/api/dashboard',
      wristbands: '/api/wristbands',
      drinks: '/api/drinks',
      staffWristband: '/api/staff-wristband',
      moneris: '/api/moneris',
      boothMenu: '/api/booth/menu',
      kitchen: '/api/kitchen/orders',
      merch: '/api/merch/sales',
      reports: '/api/reports',
      wristbandBalance: '/api/wristbands/balance/:uid',
      wristbandTransfer: '/api/wristbands/transfer'
    }
  });
});

// ============================================
// ERROR HANDLING
// ============================================

app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`
  });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  const statusCode = err.status || 500;
  const message = err.message || 'Internal server error';
  res.status(statusCode).json({
    error: { message }
  });
});

// ============================================
// AUTO-MIGRATIONS (run on startup)
// ============================================

(async () => {
  // Each step runs independently so one failing statement can't silently skip
  // the rest of the schema; failures log as errors with the offending SQL.
  const mig = (sql) => pool.query(sql).catch(e =>
    console.error('⚠️  Auto-migration step failed:', e.message, '|', sql.trim().split('\n')[0].slice(0, 80)));
  try {
    await mig(`ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS is_19_plus BOOLEAN DEFAULT false`);
    await mig(`ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS bar_credits INTEGER DEFAULT 0`);
    await mig(`ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'pending'`);
    await mig(`ALTER TABLE users ADD COLUMN IF NOT EXISTS roles JSONB DEFAULT '["admin"]'`);
    await mig(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS rfid_uid VARCHAR UNIQUE`);
    await mig(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS drink_allowance INTEGER DEFAULT 8`);
    await mig(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS drinks_used INTEGER DEFAULT 0`);
    await mig(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS wristband_active BOOLEAN DEFAULT false`);

    // Sponsor / vendor payment flags (record-level)
    await mig(`ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS paid BOOLEAN DEFAULT false`);
    await mig(`ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS in_kind BOOLEAN DEFAULT false`);
    await mig(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS paid BOOLEAN DEFAULT false`);
    await mig(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS in_kind BOOLEAN DEFAULT false`);
    // Active flag — inactive records are hidden from the list by default to reduce clutter
    await mig(`ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`);
    await mig(`ALTER TABLE vendors  ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`);

    // ── VIP / Volunteer / Sponsor name-tag badges ──
    // Badges live in the wristbands table so they instantly work at the
    // existing bar (/drinks/serve), food kiosk (/wristbands/redeem) and
    // balance checker — all keyed on rfid_uid. A normal customer wristband
    // has badge_type = NULL; a printed name tag sets it to vip/sponsor/volunteer.
    // "Unlimited" badges are flagged AND given a large sentinel credit balance
    // so every existing credit-decrementing path serves them without changes.
    await mig(`ALTER TABLE wristbands ADD COLUMN IF NOT EXISTS badge_type VARCHAR(20)`);     // vip | sponsor | volunteer | NULL
    await mig(`ALTER TABLE wristbands ADD COLUMN IF NOT EXISTS tier VARCHAR(50)`);            // e.g. Gold, Silver, Gate Captain
    await mig(`ALTER TABLE wristbands ADD COLUMN IF NOT EXISTS title VARCHAR(255)`);          // line printed under the name
    await mig(`ALTER TABLE wristbands ADD COLUMN IF NOT EXISTS company VARCHAR(255)`);        // sponsor org / department
    await mig(`ALTER TABLE wristbands ADD COLUMN IF NOT EXISTS company_logo_url TEXT`);       // sponsor's primary logo (shown on sponsor/VIP cards)
    await mig(`ALTER TABLE wristbands ADD COLUMN IF NOT EXISTS photo_url TEXT`);              // Vercel Blob URL
    await mig(`ALTER TABLE wristbands ADD COLUMN IF NOT EXISTS unlimited BOOLEAN DEFAULT false`);
    await mig(`ALTER TABLE wristbands ADD COLUMN IF NOT EXISTS area_access BOOLEAN DEFAULT false`); // VIP / all-access area
    await mig(`ALTER TABLE wristbands ADD COLUMN IF NOT EXISTS badge_active BOOLEAN DEFAULT true`);
    await mig(`ALTER TABLE wristbands ADD COLUMN IF NOT EXISTS print_status VARCHAR(20) DEFAULT 'none'`); // none | queued | printed
    await mig(`ALTER TABLE wristbands ADD COLUMN IF NOT EXISTS printed_at TIMESTAMP`);
    await mig(`CREATE INDEX IF NOT EXISTS idx_wristbands_badge_type ON wristbands(badge_type)`);
    await mig(`CREATE INDEX IF NOT EXISTS idx_wristbands_print_status ON wristbands(print_status)`);

    // ── Controlled-access zones (3 private box suites + party deck) ──
    // Each badge carries the set of zone keys it may enter. A suite is limited
    // to one sponsor's guests; the party deck is open to those guests plus some
    // other sponsors. Door scanners (badge-access.html) check membership.
    await mig(`ALTER TABLE wristbands ADD COLUMN IF NOT EXISTS access_zones JSONB DEFAULT '[]'`);
    await mig(`
      CREATE TABLE IF NOT EXISTS access_zones (
        key           VARCHAR(40) PRIMARY KEY,
        label         VARCHAR(120) NOT NULL,
        sponsor_label VARCHAR(255),         -- which sponsor this suite belongs to (label / auto-assign hint)
        sort          INTEGER DEFAULT 0,
        active        BOOLEAN DEFAULT true
      )
    `);
    await mig(`
      INSERT INTO access_zones (key, label, sort) VALUES
        ('suite_1', 'Suite 1', 1),
        ('suite_2', 'Suite 2', 2),
        ('suite_3', 'Suite 3', 3),
        ('party_deck', 'Party Deck', 4)
      ON CONFLICT (key) DO NOTHING
    `);
    await mig(`
      CREATE TABLE IF NOT EXISTS zone_access_log (
        id          VARCHAR(255) PRIMARY KEY,
        rfid_uid    VARCHAR(255),
        badge_id    VARCHAR(255),
        zone_key    VARCHAR(40),
        granted     BOOLEAN,
        guest_name  VARCHAR(255),
        scanned_by  VARCHAR(255),
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `);
    await mig(`CREATE INDEX IF NOT EXISTS idx_zone_access_log_zone ON zone_access_log(zone_key)`);

    // Sponsor/vendor logo support — see migrations/002_sponsor_vendor_logos.sql
    // TODO: move to a real migration tool; mirroring SQL here for Railway auto-deploy.
    await mig(`ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await mig(`ALTER TABLE vendors  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await mig(`CREATE INDEX IF NOT EXISTS idx_sponsors_user_id ON sponsors(user_id)`);
    await mig(`CREATE INDEX IF NOT EXISTS idx_vendors_user_id  ON vendors(user_id)`);

    await mig(`
      CREATE TABLE IF NOT EXISTS sponsor_logos (
        id            SERIAL PRIMARY KEY,
        sponsor_id    INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
        blob_url      TEXT NOT NULL,
        filename      VARCHAR(500) NOT NULL,
        extension     VARCHAR(20),
        format        VARCHAR(10) NOT NULL CHECK (format IN ('vector', 'bitmap')),
        variant       VARCHAR(20) CHECK (variant IS NULL OR variant IN ('full-color', 'black', 'white', 'icon')),
        is_primary    BOOLEAN NOT NULL DEFAULT false,
        size_bytes    BIGINT,
        notes         TEXT,
        uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await mig(`CREATE INDEX IF NOT EXISTS idx_sponsor_logos_sponsor ON sponsor_logos(sponsor_id)`);
    await mig(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sponsor_logos_one_primary ON sponsor_logos(sponsor_id) WHERE is_primary`);

    await mig(`
      CREATE TABLE IF NOT EXISTS vendor_logos (
        id            SERIAL PRIMARY KEY,
        vendor_id     INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
        blob_url      TEXT NOT NULL,
        filename      VARCHAR(500) NOT NULL,
        extension     VARCHAR(20),
        format        VARCHAR(10) NOT NULL CHECK (format IN ('vector', 'bitmap')),
        variant       VARCHAR(20) CHECK (variant IS NULL OR variant IN ('full-color', 'black', 'white', 'icon')),
        is_primary    BOOLEAN NOT NULL DEFAULT false,
        size_bytes    BIGINT,
        notes         TEXT,
        uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await mig(`CREATE INDEX IF NOT EXISTS idx_vendor_logos_vendor ON vendor_logos(vendor_id)`);
    await mig(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_logos_one_primary ON vendor_logos(vendor_id) WHERE is_primary`);

    // ── Sponsor self-registration portal ──
    // Sponsors sign in via an emailed magic link (no password) and pre-enter
    // their own guest list ahead of the event. The rodeo assigns each sponsor a
    // guest cap (max_guests) and the zones their guests may be granted
    // (allocated_zones — a subset of access_zones keys). Staff finalize each
    // pre-registered guest at check-in (photo + NFC card + print).
    await mig(`ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS max_guests       INTEGER`);            // NULL = no cap set yet
    await mig(`ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS allocated_zones  JSONB DEFAULT '[]'`); // zone keys this sponsor may grant
    await mig(`ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS portal_enabled   BOOLEAN DEFAULT false`);
    await mig(`ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS login_token_hash VARCHAR(255)`);       // sha256 of the active magic link
    await mig(`ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS login_token_exp  TIMESTAMP`);

    // Pre-registered guests staged by sponsors; each becomes a badge at check-in.
    await mig(`
      CREATE TABLE IF NOT EXISTS sponsor_guests (
        id              SERIAL PRIMARY KEY,
        sponsor_id      INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
        name            VARCHAR(255) NOT NULL,
        title           VARCHAR(255),                  -- role line printed under the name
        email           VARCHAR(255),
        requested_zones JSONB DEFAULT '[]',            -- subset of sponsor.allocated_zones
        status          VARCHAR(20) DEFAULT 'pending', -- pending | checked_in | cancelled
        badge_id        VARCHAR(255),                  -- wristbands.id once printed
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    await mig(`CREATE INDEX IF NOT EXISTS idx_sponsor_guests_sponsor ON sponsor_guests(sponsor_id)`);

    console.log('✓ Auto-migrations complete');
  } catch (e) {
    console.error('⚠️  Auto-migration block error (unexpected):', e.message);
  }
})();

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log(`🚀 Holmdale Rodeo API Server v3.0`);
  console.log(`📡 Running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 URL: http://localhost:${PORT}`);
  console.log('');
  console.log('📋 Routes loaded:');
  console.log('   /api/auth              — login, register, roles');
  console.log('   /api/booth/menu        — food + drink menu');
  console.log('   /api/kitchen           — kitchen orders (KDS)');
  console.log('   /api/merch             — merchandise POS');
  console.log('   /api/drinks            — bar inventory & serving');
  console.log('   /api/moneris           — payment processing');
  console.log('   /api/stripe            — Stripe Terminal');
  console.log('   /api/wristbands        — RFID wristbands, balance, transfers');
  console.log('   /api/staff-wristband   — staff wristband login, drinks, access');
  console.log('   /api/ticket-orders     — gate tickets');
  console.log('   /api/products          — merchandise catalog');
  console.log('   /api/events            — rodeo events');
  console.log('   /api/sponsors          — sponsors CRUD');
  console.log('   /api/vendors           — vendors CRUD + public registration');
  console.log('   /api/sponsor-logos     — sponsor logo uploads (Vercel Blob)');
  console.log('   /api/vendor-logos      — vendor logo uploads (Vercel Blob)');
  console.log(`[blob] Token loaded: ${(process.env.BLOB_READ_WRITE_TOKEN || 'MISSING').slice(0, 25)}...`);
  console.log('='.repeat(50));
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received: shutting down');
  process.exit(0);
});
