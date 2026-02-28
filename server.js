require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pool = require('./config/database');

// ============================================
// IMPORT ROUTES
// ============================================

// Auth & Users
const authRoutes = require('./routes/auth');            // Updated with roles supporth
const staffAuthRoutes = require('./routes/auth-routes');

// Core data
const staffRoutes = require('./routes/staff');
const eventRoutes = require('./routes/events');
const ticketOrderRoutes = require('./routes/ticketOrders');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const dashboardRoutes = require('./routes/dashboard');

// Wristbands & Bar
const wristbandRoutes = require('./routes/wristbands');
const drinkRoutes = require('./routes/drinks');

// Shifts
const shiftRoutes = require('./routes/shift-routes');
const shiftsCrudRoutes = require('./routes/shifts-crud-routes');

// Payments
const monerisRoutes = require('./routes/moneris');

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

const app = express();

// ============================================
// MIDDLEWARE
// ============================================

app.use(helmet());
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, local HTML files, kiosks)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'https://holmdalerodeo.ca',
      'https://www.holmdalerodeo.ca',
      'https://staff.holmdalerodeo.ca',
      'https://holmdale-pro-rodeo.base44.app',
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173',
      'file://'   // Android kiosk WebView
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all for now — tighten for production
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

// Shifts
app.use('/api/shifts', shiftRoutes);
app.use('/api/shifts-manage', shiftRoutes);
app.use('/api/shifts-crud', shiftsCrudRoutes);

// Payments
app.use('/api/moneris', monerisRoutes);

// Email & Reports
app.use('/api/email', emailRoutes);
app.use('/api/reports', reportRoutes);

// NEW: Booth Menu (food menu, drink menu, ticket pricing)
app.use('/api/booth/menu', boothMenuRoutes);

// NEW: Kitchen Orders (kitchen display system)
app.use('/api/kitchen', kitchenRoutes);

// NEW: Merchandise Sales (POS)
app.use('/api/merch', merchRoutes);

// NEW: Wristband Transfer & Balance (public balance check + transfer)
app.use('/api/wristbands', wristbandTransferRoutes);

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
    // Existing migrations
    await pool.query(`ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS is_19_plus BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS bar_credits INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'pending'`);
    
    // Roles migration
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS roles JSONB DEFAULT '["admin"]'`);
    
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
  console.log('   /api/auth          — login, register, roles');
  console.log('   /api/booth/menu    — food + drink menu');
  console.log('   /api/kitchen       — kitchen orders (KDS)');
  console.log('   /api/merch         — merchandise POS');
  console.log('   /api/drinks        — bar inventory & serving');
  console.log('   /api/moneris       — payment processing');
  console.log('   /api/wristbands    — RFID wristbands, balance, transfers');
  console.log('   /api/ticket-orders — gate tickets');
  console.log('   /api/products      — merchandise catalog');
  console.log('   /api/events        — rodeo events');
  console.log('='.repeat(50));
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received: shutting down');
  process.exit(0);
});
