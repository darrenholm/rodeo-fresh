require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

// Import routes
const authRoutes = require('./routes/auth');
const staffAuthRoutes = require('./routes/auth-routes');
const staffRoutes = require('./routes/staff');
const eventRoutes = require('./routes/events');
const ticketOrderRoutes = require('./routes/ticketOrders');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const dashboardRoutes = require('./routes/dashboard');
const wristbandRoutes = require('./routes/wristbands');
const drinkRoutes = require('./routes/drinks');
const shiftRoutes = require('./routes/shift-routes');
const shiftsCrudRoutes = require('./routes/shifts-crud-routes');
const monerisRoutes = require('./routes/moneris');
const emailRoutes = require('./routes/email');
const reportRoutes = require('./routes/reports');
const app = express();

// ============================================
// MIDDLEWARE
// ============================================

app.use(helmet());
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, or local HTML files)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'https://holmdalerodeo.ca',
      'https://holmdale-pro-rodeo.base44.app',
      'http://localhost:3000',
      'http://127.0.0.1:3000'
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all for now (for testing)
    }
  },
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging in development
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });
}

// ============================================
// ROUTES
// ============================================

app.use('/api/auth', authRoutes);
app.use('/api/auth', staffAuthRoutes); 
app.use('/api/staff', staffRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/shifts', shiftRoutes);
app.use('/api/ticket-orders', ticketOrderRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/wristbands', wristbandRoutes);
app.use('/api/drinks', drinkRoutes);
app.use('/api/shifts-manage', shiftRoutes);
app.use('/api/shifts-crud', shiftsCrudRoutes);
app.use('/api/moneris', monerisRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/reports', reportRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV 
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Holmdale Rodeo API',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      staff: '/api/staff',
      events: '/api/events',
      shifts: '/api/shifts',
      ticketOrders: '/api/ticket-orders',
      products: '/api/products',
      orders: '/api/orders',
      dashboard: '/api/dashboard'
    }
  });
});

// ============================================
// ERROR HANDLING
// ============================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}` 
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  const statusCode = err.status || 500;
  const message = err.message || 'Internal server error';
  
  res.status(statusCode).json({
    error: {
      message,
      ...(process.env.NODE_ENV === 'development' && { 
        stack: err.stack,
        details: err 
      })
    }
  });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log(`🚀 Holmdale Rodeo API Server`);
  console.log(`📡 Running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 URL: http://localhost:${PORT}`);
  console.log('='.repeat(50));
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});
