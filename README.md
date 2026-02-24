# Holmdale Rodeo Backend API

Complete Node.js/Express backend for the Holmdale Rodeo Event Management & E-commerce Platform.

## 📋 System Overview

This backend powers a rodeo event management system with:
- **Event Management** - Create and manage rodeo events
- **Staff Scheduling** - Assign staff to shifts (bar/gate roles)
- **Ticket Sales** - Event ticketing with RFID scanning
- **E-commerce** - Product sales (hats, shirts, merchandise)
- **Admin Dashboard** - Analytics and reporting

## 🗄️ Database Schema

### Tables
1. **users** - Authentication and user management
2. **staff** - Employee information with certifications
3. **events** - Rodeo events with pricing
4. **shifts** - Staff scheduling for events
5. **ticket_orders** - Event ticket purchases
6. **products** - Merchandise catalog
7. **orders** - Product order management
8. **bar_purchases** - Bar sales tracking (extensible)

## 🚀 Quick Start

### Prerequisites
- Node.js 16+ 
- PostgreSQL 13+
- npm or yarn

### 1. Install Dependencies
```bash
npm install
```

### 2. Setup Database
Create a PostgreSQL database:
```bash
createdb rodeo_db
```

### 3. Configure Environment
Copy `.env.example` to `.env` and update:
```bash
cp .env.example .env
```

Edit `.env` with your settings:
```env
DATABASE_URL=postgresql://username:password@localhost:5432/rodeo_db
JWT_SECRET=your-secret-key
STRIPE_SECRET_KEY=sk_test_...
```

### 4. Run Migrations
```bash
psql rodeo_db < migrations/001_schema.sql
```

### 5. Import Your Data (Optional)
Place your CSV files in a `data/` directory:
```
data/
  ├── Staff.csv
  ├── Event.csv
  ├── Shift.csv
  ├── TicketOrder.csv
  ├── Product.csv
  └── Order.csv
```

Then run:
```bash
node migrations/seed.js
```

### 6. Start the Server
```bash
# Development
npm run dev

# Production
npm start
```

Server runs on `http://localhost:3000`

## 📚 API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `POST /api/auth/verify` - Verify JWT token

### Staff Management
- `GET /api/staff` - Get all staff (supports filters: ?year=2025&adult=true&smartserve=true)
- `GET /api/staff/:id` - Get single staff member
- `POST /api/staff` - Create staff member (admin only)
- `PUT /api/staff/:id` - Update staff member (admin only)
- `DELETE /api/staff/:id` - Delete staff member (admin only)

### Events
- `GET /api/events` - Get all events (?featured=true)
- `GET /api/events/:id` - Get single event
- `POST /api/events` - Create event (admin only)
- `PUT /api/events/:id` - Update event (admin only)
- `DELETE /api/events/:id` - Delete event (admin only)

### Shifts
- `GET /api/shifts` - Get all shifts (?event_id=...&date=...&role=bar)
- `POST /api/shifts` - Create shift (admin only)
- `PUT /api/shifts/:id` - Update shift (admin only)
- `DELETE /api/shifts/:id` - Delete shift (admin only)

### Ticket Orders
- `GET /api/ticket-orders` - Get all ticket orders (?event_id=...&status=confirmed)
- `GET /api/ticket-orders/:id` - Get single ticket
- `GET /api/ticket-orders/confirmation/:code` - Get by confirmation code
- `POST /api/ticket-orders` - Create ticket order (public)
- `PUT /api/ticket-orders/:id/scan` - Scan ticket with RFID
- `PUT /api/ticket-orders/:id/status` - Update ticket status (admin only)

### Products
- `GET /api/products` - Get all products (?category=hat&in_stock=true)
- `GET /api/products/:id` - Get single product
- `POST /api/products` - Create product (admin only)
- `PUT /api/products/:id` - Update product (admin only)
- `DELETE /api/products/:id` - Delete product (admin only)

### Orders
- `GET /api/orders` - Get all orders (?status=paid&email=...)
- `GET /api/orders/:id` - Get single order
- `POST /api/orders` - Create order (public)
- `PUT /api/orders/:id/status` - Update order status (admin only)

### Dashboard
- `GET /api/dashboard/stats` - Get dashboard statistics (admin only)

## 🔐 Authentication

All protected endpoints require a JWT token in the Authorization header:
```
Authorization: Bearer <your-jwt-token>
```

### User Roles
- **admin** - Full access to all endpoints
- **staff** - Limited access (can view shifts, events)
- **user** - Basic access (can create orders/tickets)

### Example Login Flow
```javascript
// 1. Login
const response = await fetch('http://localhost:3000/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'darren@holmgraphics.ca',
    password: 'your-password'
  })
});

const { token, user } = await response.json();

// 2. Use token in subsequent requests
const events = await fetch('http://localhost:3000/api/events', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

## 🔧 Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| PORT | Server port | 3000 |
| NODE_ENV | Environment | development/production |
| DATABASE_URL | PostgreSQL connection | postgresql://user:pass@localhost:5432/db |
| JWT_SECRET | JWT signing secret | your-secret-key |
| JWT_EXPIRES_IN | Token expiration | 7d |
| FRONTEND_URL | CORS origin | http://localhost:5173 |
| STRIPE_SECRET_KEY | Stripe API key | sk_test_... |

## 📦 Database Hosting Options

### Recommended Cloud PostgreSQL Providers

1. **Supabase** (Free tier, easiest)
   - https://supabase.com
   - Free: 500MB database, unlimited API requests
   - Auto-scaling, built-in auth

2. **Neon** (Free tier, serverless)
   - https://neon.tech
   - Free: 3GB storage, autoscaling
   - Serverless PostgreSQL

3. **Railway** (Free tier)
   - https://railway.app
   - $5/month credit
   - One-click PostgreSQL

4. **Render** (Free tier)
   - https://render.com
   - Free PostgreSQL database
   - 90-day retention

## 🚢 Deployment Options

### Railway (Recommended - Easiest)
```bash
# 1. Install Railway CLI
npm install -g @railway/cli

# 2. Login
railway login

# 3. Create project
railway init

# 4. Add PostgreSQL
railway add

# 5. Deploy
railway up
```

### Render
1. Push code to GitHub
2. Connect GitHub repo to Render
3. Add PostgreSQL database
4. Set environment variables
5. Deploy

### DigitalOcean App Platform
1. Connect GitHub repository
2. Configure build settings
3. Add managed PostgreSQL
4. Deploy

## 🧪 Testing

Test the API using curl:

```bash
# Health check
curl http://localhost:3000/health

# Register user
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123","name":"Test User"}'

# Get events
curl http://localhost:3000/api/events
```

Or use tools like:
- Postman
- Insomnia
- Thunder Client (VS Code extension)

## 📁 Project Structure

```
backend/
├── config/
│   └── database.js          # PostgreSQL connection
├── middleware/
│   └── auth.js              # JWT authentication
├── migrations/
│   ├── 001_schema.sql       # Database schema
│   └── seed.js              # CSV import script
├── routes/
│   ├── auth.js              # Authentication routes
│   ├── staff.js             # Staff management
│   ├── events.js            # Event management
│   ├── shifts.js            # Shift scheduling
│   ├── ticketOrders.js      # Ticket orders
│   ├── products.js          # Product catalog
│   ├── orders.js            # Product orders
│   └── dashboard.js         # Analytics
├── .env.example             # Environment template
├── package.json             # Dependencies
├── server.js                # Main server file
└── README.md                # This file
```

## 🔄 Connecting Your Base44 Frontend

Update your Base44 frontend API calls to point to this backend:

```javascript
// Before (Base44 backend)
const API_URL = 'https://api.base44.com';

// After (Your backend)
const API_URL = 'http://localhost:3000/api';

// Or in production
const API_URL = 'https://your-backend.railway.app/api';
```

## 🐛 Troubleshooting

### Database Connection Issues
```bash
# Test PostgreSQL connection
psql -h localhost -U username -d rodeo_db

# Check if PostgreSQL is running
pg_isready
```

### Port Already in Use
```bash
# Find process using port 3000
lsof -i :3000

# Kill process
kill -9 <PID>
```

### Module Not Found Errors
```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

## 📞 Support

For issues or questions:
- Email: darren@holmgraphics.ca
- Check server logs for errors
- Verify environment variables are set correctly

## 📝 License

ISC

---

**Built for Holmdale Pro Rodeo** 🤠
#   F o r c e   r e d e p l o y  
 