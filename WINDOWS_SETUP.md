# 🪟 Windows Setup Guide

## ✅ What You Downloaded

A complete Node.js backend (40KB ZIP) containing:
- All backend code (routes, database, auth)
- Your 7 CSV data files ready to import
- Complete documentation
- Database schema

## 🚀 Quick Setup (10 Minutes)

### Step 1: Extract the ZIP
1. Right-click `rodeo-backend.zip`
2. Click "Extract All..."
3. Choose a location (e.g., `C:\Users\DarrenJHolm\Projects\`)
4. You'll get a `backend` folder

### Step 2: Install Node.js (if needed)
1. Go to https://nodejs.org
2. Download "LTS" version (recommended)
3. Run installer (accept all defaults)
4. **Restart PowerShell/Command Prompt**

Test it works:
```powershell
node --version
npm --version
```

### Step 3: Install Dependencies
Open PowerShell in the backend folder:
1. Hold Shift + Right-click the `backend` folder
2. Choose "Open PowerShell window here"
3. Run:
```powershell
npm install
```
This downloads all required packages (~5 minutes).

### Step 4: Setup Database

**Option A: Cloud Database (Recommended - Free)**
1. Go to https://supabase.com
2. Sign up (free)
3. Click "New Project"
4. Choose a name, password, region
5. Wait for project to be created
6. Go to Settings → Database
7. Copy the "Connection string" (starts with `postgresql://`)

**Option B: Local PostgreSQL**
1. Download PostgreSQL from https://www.postgresql.org/download/windows/
2. Install with default settings
3. Remember the password you set
4. Open pgAdmin or command line
5. Create database: `CREATE DATABASE rodeo_db;`

### Step 5: Configure Environment
In the `backend` folder:

1. Copy `.env.example` to `.env`:
```powershell
copy .env.example .env
```

2. Edit `.env` with Notepad:
```powershell
notepad .env
```

3. Update these values:
```env
# Your Supabase connection string (from Step 4)
DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@[YOUR-HOST]:5432/postgres

# Create a random secret (just mash keyboard)
JWT_SECRET=kj3h4kjh23k4jh23k4jh23k4jh234

# If you have a frontend URL
FRONTEND_URL=http://localhost:3000

# Your Stripe keys (if using Stripe)
STRIPE_SECRET_KEY=sk_test_...
```

4. Save and close

### Step 6: Setup Database Tables
In PowerShell (in the backend folder):
```powershell
npm run migrate
```

This creates:
- All 8 database tables
- Default admin user
  - Email: darren@holmgraphics.ca
  - Password: changeme123

### Step 7: Import Your Data (Optional)
```powershell
npm run seed
```

This imports all 7 CSV files (88 staff, 3 events, 37 shifts, etc.)

### Step 8: Start the Server
```powershell
npm run dev
```

You should see:
```
==================================================
🚀 Holmdale Rodeo API Server
📡 Running on port 3000
🌍 Environment: development
🔗 URL: http://localhost:3000
==================================================
✓ Database connected successfully
```

### Step 9: Test It Works
Open a browser and go to:
- http://localhost:3000 (API info)
- http://localhost:3000/health (health check)

Or in PowerShell:
```powershell
curl http://localhost:3000/health
```

## 🎯 You're Done!

Your backend is now running at `http://localhost:3000`

## 📱 Next Steps

### Test the Login
In PowerShell (new window):
```powershell
curl -X POST http://localhost:3000/api/auth/login `
  -H "Content-Type: application/json" `
  -d '{\"email\":\"darren@holmgraphics.ca\",\"password\":\"changeme123\"}'
```

You should get back a token!

### Connect Your Frontend
In your Base44 frontend code, update the API URL:
```javascript
const API_URL = 'http://localhost:3000/api';
```

### View All Endpoints
See README.md for complete API documentation

## 🚀 Deploy to Production

When ready to go live, see DEPLOYMENT.md for:
- Railway (easiest, free tier)
- Render (free tier)
- Other hosting options

**Quick Railway Deploy:**
```powershell
npm install -g @railway/cli
railway login
railway init
railway add postgresql
railway up
railway run npm run migrate
```

## ❓ Troubleshooting

### "npm: command not found"
- Node.js not installed or PowerShell needs restart
- Close PowerShell, reopen, try again

### "Cannot find module"
```powershell
rm -r node_modules
npm install
```

### "Database connection failed"
- Check DATABASE_URL in .env
- Make sure database exists
- Test connection in pgAdmin or Supabase dashboard

### Port 3000 already in use
Edit `.env`:
```env
PORT=3001
```

### Still stuck?
1. Check the README.md
2. Check server logs for errors
3. Email: darren@holmgraphics.ca

## 📁 Folder Structure

```
backend/
├── config/           # Database connection
├── middleware/       # Authentication
├── routes/           # API endpoints (8 files)
├── migrations/       # Database setup
├── data/            # Your 7 CSV files
├── .env             # YOUR configuration (create this)
├── .env.example     # Template
├── package.json     # Dependencies
├── server.js        # Main server
└── README.md        # Full docs
```

## 🔑 Default Admin Login

After running migrations:
- **Email**: darren@holmgraphics.ca
- **Password**: changeme123

⚠️ **IMPORTANT**: Change this password immediately!

Log in and change password via API or database.

## 🎓 Learn More

- Full API docs: README.md
- Deployment guide: DEPLOYMENT.md
- Quick reference: QUICKSTART.md
- Project overview: PROJECT_SUMMARY.md

---

**Questions?** darren@holmgraphics.ca
