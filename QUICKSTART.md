# Quick Start Guide

## ⚡ Get Running in 5 Minutes

### 1. Install Dependencies (1 min)
```bash
cd backend
npm install
```

### 2. Setup PostgreSQL (2 min)

**Option A: Local PostgreSQL**
```bash
# Install PostgreSQL, then:
createdb rodeo_db
```

**Option B: Cloud PostgreSQL (Recommended)**
- Go to https://supabase.com or https://neon.tech
- Create free account
- Create new PostgreSQL database
- Copy connection string

### 3. Configure Environment (1 min)
```bash
cp .env.example .env
```

Edit `.env`:
```env
DATABASE_URL=postgresql://user:password@host:5432/database
JWT_SECRET=make-this-a-long-random-string
FRONTEND_URL=http://localhost:5173
```

### 4. Run Migrations (1 min)
```bash
npm run migrate
```

This creates:
- All database tables
- Default admin user:
  - Email: `darren@holmgraphics.ca`
  - Password: `changeme123`

### 5. Import Your Data (Optional)
```bash
npm run seed
```

This imports all 7 CSV files into the database.

### 6. Start Server (< 1 min)
```bash
npm run dev
```

✅ **Done!** Your backend is running at `http://localhost:3000`

## 🧪 Test It

### Health Check
```bash
curl http://localhost:3000/health
```

### Login
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"darren@holmgraphics.ca","password":"changeme123"}'
```

### Get Events
```bash
curl http://localhost:3000/api/events
```

## 📱 Connect Your Frontend

In your Base44 frontend, update the API URL:

```javascript
const API_URL = 'http://localhost:3000/api';
```

## 🚀 Deploy to Production

See [DEPLOYMENT.md](DEPLOYMENT.md) for full deployment guide.

**Quick Deploy to Railway:**
```bash
npm install -g @railway/cli
railway login
railway init
railway add postgresql
railway up
railway run npm run migrate
```

Your backend is now live! 🎉

## ❓ Troubleshooting

**Port 3000 already in use?**
```bash
# Change PORT in .env
PORT=3001
```

**Database connection failed?**
- Check DATABASE_URL in .env
- Ensure PostgreSQL is running
- Test connection: `psql <DATABASE_URL>`

**Module not found errors?**
```bash
rm -rf node_modules
npm install
```

## 📚 Learn More

- [README.md](README.md) - Full documentation
- [DEPLOYMENT.md](DEPLOYMENT.md) - Deployment guide
- API endpoints documentation in README.md

---

**Questions?** darren@holmgraphics.ca
