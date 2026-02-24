# Deployment Guide

## 🚀 Quick Deployment to Railway (Recommended)

Railway is the easiest way to deploy your backend with PostgreSQL.

### Step 1: Install Railway CLI
```bash
npm install -g @railway/cli
```

### Step 2: Login to Railway
```bash
railway login
```

### Step 3: Initialize Project
```bash
cd backend
railway init
```

### Step 4: Add PostgreSQL Database
```bash
railway add postgresql
```

This automatically creates a PostgreSQL database and sets the `DATABASE_URL` environment variable.

### Step 5: Set Environment Variables
```bash
railway variables set JWT_SECRET="your-super-secret-key-here"
railway variables set FRONTEND_URL="https://your-frontend-url.com"
railway variables set STRIPE_SECRET_KEY="sk_test_your_stripe_key"
```

### Step 6: Deploy
```bash
railway up
```

Your backend is now live! Railway will give you a URL like:
`https://your-app.railway.app`

### Step 7: Run Migrations
```bash
# Connect to your Railway project
railway run npm run migrate

# Import your CSV data (optional)
railway run npm run seed
```

## 🌐 Alternative: Deploy to Render

### Step 1: Create Account
Go to https://render.com and sign up

### Step 2: Create PostgreSQL Database
1. Click "New +"
2. Select "PostgreSQL"
3. Choose a name
4. Select free tier
5. Create database

Copy the "Internal Database URL" - you'll need this.

### Step 3: Create Web Service
1. Click "New +"
2. Select "Web Service"
3. Connect your GitHub repository
4. Configure:
   - **Name**: rodeo-backend
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`

### Step 4: Add Environment Variables
In the Render dashboard, add:
- `DATABASE_URL` = (paste Internal Database URL from Step 2)
- `JWT_SECRET` = your-secret-key
- `FRONTEND_URL` = https://your-frontend.com
- `NODE_ENV` = production
- `STRIPE_SECRET_KEY` = sk_test_...

### Step 5: Deploy
Click "Create Web Service" - Render will automatically deploy!

### Step 6: Run Migrations
Use Render Shell:
1. Go to your service
2. Click "Shell"
3. Run: `npm run migrate`

## 🐳 Deploy with Docker (Advanced)

### Create Dockerfile
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

### Create docker-compose.yml
```yaml
version: '3.8'
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: rodeo_db
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: your_password
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  backend:
    build: .
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://postgres:your_password@postgres:5432/rodeo_db
      JWT_SECRET: your-secret-key
    depends_on:
      - postgres

volumes:
  postgres_data:
```

### Deploy
```bash
docker-compose up -d
docker-compose exec backend npm run migrate
```

## 📊 After Deployment Checklist

✅ Backend is accessible at your deployment URL
✅ Database migrations have run successfully
✅ Can login with admin credentials
✅ API endpoints return data (test with curl/Postman)
✅ CORS is configured for your frontend
✅ Environment variables are set correctly
✅ Changed default admin password

## 🔧 Connecting Your Frontend

Update your Base44 frontend to use the new backend:

```javascript
// In your frontend config/API file
const API_BASE_URL = process.env.NODE_ENV === 'production'
  ? 'https://your-backend.railway.app/api'
  : 'http://localhost:3000/api';

export default API_BASE_URL;
```

## 🔐 Security Best Practices

1. **Change default admin password** immediately after first login
2. **Use strong JWT_SECRET** (at least 32 random characters)
3. **Enable HTTPS** (Railway/Render do this automatically)
4. **Set FRONTEND_URL** correctly for CORS
5. **Don't commit .env** file to git
6. **Use environment variables** for all secrets
7. **Regular backups** of your database

## 📈 Monitoring

### Railway
- View logs: `railway logs`
- View metrics in Railway dashboard

### Render
- Logs available in dashboard
- Automatic health checks
- Email alerts for downtime

## 🔄 Updating Your App

### Railway
```bash
# Make changes to code
git add .
git commit -m "Updated feature"
railway up
```

### Render
```bash
# Push to GitHub
git push origin main

# Render auto-deploys on push
```

## 💾 Database Backups

### Railway
```bash
railway run pg_dump > backup.sql
```

### Render
Use Render's built-in backup feature in the PostgreSQL dashboard.

## 🆘 Troubleshooting

### Database Connection Failed
- Check DATABASE_URL is correct
- Ensure PostgreSQL service is running
- Verify firewall/network settings

### CORS Errors
- Set FRONTEND_URL environment variable
- Check frontend is using correct backend URL

### 500 Errors
- Check server logs: `railway logs` or Render dashboard
- Verify all environment variables are set
- Check database migrations ran successfully

---

**Need Help?** Email darren@holmgraphics.ca
