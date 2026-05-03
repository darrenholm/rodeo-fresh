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
const sponsorLogosRoutes = require('./routes/sponsorLogos');
const vendorLogosRoutes = require('./routes/vendorLogos');

// Wristbands & Bar
const wristbandRoutes = require('./routes/wristbands');
const drinkRoutes = require('./routes/drinks');
const staffWristbandRoutes = require('./routes/staff-wristband');

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
  try {
    await pool.query(`ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS is_19_plus BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS bar_credits INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'pending'`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS roles JSONB DEFAULT '["admin"]'`);
    await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS rfid_uid VARCHAR UNIQUE`);
    await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS drink_allowance INTEGER DEFAULT 8`);
    await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS drinks_used INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS wristband_active BOOLEAN DEFAULT false`);

    // Sponsor/vendor logo support — see migrations/002_sponsor_vendor_logos.sql
    // TODO: move to a real migration tool; mirroring SQL here for Railway auto-deploy.
    await pool.query(`ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE vendors  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sponsors_user_id ON sponsors(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vendors_user_id  ON vendors(user_id)`);

    await pool.query(`
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
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sponsor_logos_sponsor ON sponsor_logos(sponsor_id)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sponsor_logos_one_primary ON sponsor_logos(sponsor_id) WHERE is_primary`);

    await pool.query(`
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
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vendor_logos_vendor ON vendor_logos(vendor_id)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_logos_one_primary ON vendor_logos(vendor_id) WHERE is_primary`);

    console.log('✓ Auto-migrations complete');
  } catch (e) {
    console.log('Migration note:', e.message);
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
  console.log('='.repeat(50));
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received: shutting down');
  process.exit(0);
});
