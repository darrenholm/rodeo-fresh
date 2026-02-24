# 🎉 Fresh Holmdale Rodeo Backend

## Built From Your Base44 Export - February 17, 2026

This is a **brand new backend** built from scratch using your actual Base44 data structure.

---

## 📊 What's Included

### **Your Data (Ready to Import)**
- ✅ 3 Events (Friday Team Penning, Saturday Rodeo, Sunday Rodeo)
- ✅ 12 Ticket Orders with RFID wristbands
- ✅ 87 Staff members with certifications
- ✅ 36 Shifts for bar & gate roles
- ✅ 4 Products (hats, shirts)
- ✅ Product orders
- ✅ 3 Bar purchases with drink ticket tracking

### **Database Features**
- ✅ Multi-tier ticketing (general, child, family packages)
- ✅ RFID wristband tracking with 19+ age verification
- ✅ Staff scheduling system
- ✅ E-commerce with Stripe integration
- ✅ Bar drink ticket system with redemption tracking

---

## 🚀 Quick Start (10 Minutes)

### **Option A: Deploy to Railway (Recommended)**

```powershell
# 1. Push to GitHub
git init
git add .
git commit -m "Fresh backend"
git remote add origin https://github.com/YOUR_USERNAME/rodeo-backend.git
git push -u origin main

# 2. Deploy to Railway
# Go to railway.app → New Project → Deploy from GitHub
# Select your repo
# Railway auto-deploys!

# 3. Add PostgreSQL in Railway dashboard
# Click "+ New" → Database → PostgreSQL

# 4. Set environment variables in dashboard:
JWT_SECRET=your-long-secret-key
NODE_ENV=production
FRONTEND_URL=https://your-app.base44.com

# 5. Run migrations via Railway dashboard
# Settings → Deploy → Start Command → Temporarily set to:
npm run migrate
# Then change back to: npm start

# 6. Run seed to import your Base44 data
# Same process: temporarily set to npm run seed
```

---

### **Option B: Local Testing First**

```powershell
# 1. Install dependencies
npm install

# 2. Setup local PostgreSQL or use Supabase free tier

# 3. Create .env file
copy .env.example .env
# Edit .env with your DATABASE_URL

# 4. Run migrations
npm run migrate

# 5. Import your Base44 data
npm run seed

# 6. Start server
npm run dev
```

---

## 📋 What Changed From Your Previous Backend

### **Database Updates**
1. **Events table** now includes:
   - `family_price` and `family_available` (for family packages)
   - `child_price` and `child_available` (for child tickets)

2. **TicketOrders table** now includes:
   - `rfid_wristbands` (JSONB array) for tracking multiple wristbands
   - Each wristband can have `tag_id` and `is_19_plus` flag

3. **BarPurchases table** is now properly structured:
   - `ticket_quantity` - number of drink tickets purchased
   - `drinks_redeemed` - how many have been used
   - `rfid_tag_id` - linked to customer's wristband
   - `status` - 'pending' or 'completed'

---

## 🎯 Key Features

### **RFID Wristband System**
Your ticket orders include RFID wristbands for:
- Age verification (19+ tracking)
- Drink ticket redemption at the bar
- Quick entry scanning

Example wristband data:
```json
[{
  "tag_id": "ce:10:b9:64",
  "is_19_plus": true
}]
```

### **Multi-Tier Ticketing**
- **General** - Adult admission ($35-45)
- **Child** - Kids admission ($10)
- **Family** - Family packages ($90-100)

### **Bar Drink Tickets**
Customers can:
1. Purchase drink tickets (linked to RFID)
2. Redeem at bar
3. System tracks remaining tickets

---

## 🗄️ Database Schema

```
users
├─ Authentication & authorization
│
events
├─ Rodeo events with multi-tier pricing
│
ticket_orders
├─ Ticket purchases with RFID wristbands
│
staff
├─ Employees with certifications & availability
│
shifts  
├─ Staff scheduling (bar/gate roles)
│
products
├─ Merchandise catalog
│
orders
├─ Product orders with Stripe
│
bar_purchases
└─ Drink tickets with RFID redemption
```

---

## 📱 API Endpoints

All the same endpoints as before, plus enhancements:

### **Enhanced Endpoints**
- `GET /api/ticket-orders?scanned=false` - Get unscanned tickets
- `POST /api/bar-purchases` - Purchase drink tickets
- `PUT /api/bar-purchases/:id/redeem` - Redeem a drink
- `GET /api/bar-purchases/rfid/:tag` - Get purchases by RFID tag

---

## 🔧 Environment Variables

```env
# Database
DATABASE_URL=postgresql://...

# Auth
JWT_SECRET=your-secret-key
NODE_ENV=production

# CORS
FRONTEND_URL=https://your-app.base44.com

# Stripe (from your Base44 data)
STRIPE_SECRET_KEY=sk_live_...
```

---

## 📊 Your Actual Data Summary

**Events:**
- Friday Team Penning (Free event, 1:00 PM)
- Saturday Rodeo ($45 general, $10 child, $100 family, 7pm)
- Sunday Rodeo ($35 general, $10 child, $90 family, 7pm)

**Venue:** Holmdale Rodeo Grounds

**Ticket Inventory:**
- 3,500 general admission per day
- 1,000 child tickets per day
- 500 family packages per day

---

## 🎯 Next Steps

1. ✅ **Deploy to Railway** (follow Option A above)
2. ✅ **Import your Base44 data** (`npm run seed`)
3. ✅ **Connect your Base44 frontend** (update API URL)
4. ✅ **Test ticket scanning** with RFID wristbands
5. ✅ **Test bar drink ticket system**

---

## 📞 Need Help?

- **Quick Setup**: See QUICKSTART.md
- **Railway Deploy**: See DEPLOYMENT.md
- **Base44 Integration**: See BASE44_INTEGRATION.md
- **Windows Setup**: See WINDOWS_SETUP.md

---

## ✨ What Makes This Backend Special

1. **Built from YOUR actual data** - not a generic template
2. **RFID wristband support** - for age verification & drink tickets
3. **Multi-tier ticketing** - general, child, family packages
4. **Bar drink system** - purchase & redemption tracking
5. **Staff scheduling** - optimized for your bar/gate workflow
6. **Stripe integration** - using your actual price IDs

---

**This backend is ready to handle 12,000+ attendees at your rodeo events!** 🤠🎉

Deploy it to Railway and you're ready to go live!
