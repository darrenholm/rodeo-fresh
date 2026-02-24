# 🇨🇦 Web Hosting Canada Deployment Guide

## Deploying Node.js Backend to holmdalerodeo.ca

This guide is for **Web Hosting Pro** plan with Node.js support via cPanel.

---

## 📋 **Prerequisites**

- ✅ Web Hosting Canada **Web Hosting Pro** plan
- ✅ cPanel access
- ✅ Domain: holmdalerodeo.ca
- ✅ Your backend code (rodeo-backend.zip)

---

## 🚀 **Deployment Steps**

### **Step 1: Access cPanel**

1. Go to https://holmdalerodeo.ca/cpanel (or your WHC login URL)
2. Login with your cPanel credentials
3. Look for **"Setup Node.js App"** or **"Node.js Selector"** in Software section

---

### **Step 2: Create Node.js Application**

In cPanel → **Setup Node.js App**:

1. Click **"Create Application"**

2. Fill in the form:
   - **Node.js version**: Select latest available (18.x or 20.x)
   - **Application mode**: Production
   - **Application root**: `rodeo-backend` (or `backend`)
   - **Application URL**: `api.holmdalerodeo.ca` (or subdomain you want)
   - **Application startup file**: `server.js`
   - **Environment variables**: (we'll add these next)

3. Click **"Create"**

---

### **Step 3: Upload Your Backend Files**

**Option A: File Manager (Easier)**

1. In cPanel → **File Manager**
2. Navigate to the application root you created (e.g., `/home/username/rodeo-backend/`)
3. Click **Upload**
4. Upload your `rodeo-backend.zip`
5. Right-click the ZIP → **Extract**
6. Move all files from `backend/` folder to the root of `rodeo-backend/`
7. Delete the now-empty `backend/` folder and ZIP file

**Option B: FTP (Alternative)**

1. Use FileZilla or another FTP client
2. Connect to your hosting (FTP details in cPanel)
3. Upload all files from your extracted `backend/` folder
4. Upload to `/home/username/rodeo-backend/`

**Your structure should look like:**
```
/home/username/rodeo-backend/
├── config/
├── routes/
├── migrations/
├── data/
├── server.js
├── package.json
└── .env
```

---

### **Step 4: Setup PostgreSQL Database**

1. In cPanel → **PostgreSQL Databases**

2. **Create Database:**
   - Database name: `rodeo_db` (will become username_rodeo_db)
   - Click **Create Database**

3. **Create User:**
   - Username: `rodeo_user`
   - Password: (generate strong password)
   - Click **Create User**

4. **Add User to Database:**
   - Select user: `rodeo_user`
   - Select database: `rodeo_db`
   - Grant **ALL PRIVILEGES**
   - Click **Add**

5. **Note your connection details:**
   - Host: `localhost` (or specific hostname from WHC)
   - Database: `username_rodeo_db` (with your cPanel username prefix)
   - User: `username_rodeo_user`
   - Password: (your generated password)
   - Port: `5432`

---

### **Step 5: Configure Environment Variables**

**Two methods:**

#### **Method A: Through Node.js App Interface (Recommended)**

1. Go back to **Setup Node.js App**
2. Click on your application
3. Scroll to **Environment Variables**
4. Add these variables:

```
DATABASE_URL=postgresql://username_rodeo_user:your_password@localhost:5432/username_rodeo_db
NODE_ENV=production
PORT=3000
JWT_SECRET=your-super-secret-random-string-make-it-long
FRONTEND_URL=https://holmdalerodeo.ca
STRIPE_SECRET_KEY=sk_live_your_stripe_key
```

#### **Method B: .env File**

1. In File Manager, edit or create `.env` file in application root
2. Add the same variables as above
3. Save

**IMPORTANT:** Replace:
- `username` with your actual cPanel username
- `your_password` with the PostgreSQL password you created
- `your-super-secret-random-string-make-it-long` with a random string
- `sk_live_your_stripe_key` with your actual Stripe key

---

### **Step 6: Install Dependencies**

1. In cPanel → **Setup Node.js App**
2. Click on your application
3. Look for **"Run NPM Install"** button or terminal
4. Click it (this runs `npm install`)

**If there's a terminal/SSH access:**
```bash
cd ~/rodeo-backend
npm install
```

---

### **Step 7: Run Database Migrations**

You need to run the migration to create database tables.

**Option A: SSH Terminal (if available)**
```bash
cd ~/rodeo-backend
source /home/username/nodevenv/rodeo-backend/18/bin/activate
npm run migrate
npm run seed  # Optional: import CSV data
```

**Option B: Web-based Terminal**
- Some WHC plans have **Terminal** in cPanel
- Use it to run the same commands above

**Option C: Use pgAdmin or phpPgAdmin**
1. In cPanel → **phpPgAdmin** (if available)
2. Select your `rodeo_db` database
3. Go to **SQL** tab
4. Copy and paste the entire contents of `migrations/001_schema.sql`
5. Execute

Then manually create admin user:
```sql
INSERT INTO users (email, password, name, role, created_at, updated_at)
VALUES (
  'darren@holmgraphics.ca',
  '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', -- password: changeme123
  'Admin User',
  'admin',
  NOW(),
  NOW()
);
```

---

### **Step 8: Start the Application**

1. In **Setup Node.js App** → Click your application
2. Click **"Restart"** button
3. Application should now be running!

---

### **Step 9: Setup Domain/Subdomain**

**Option A: Subdomain (Recommended)**

1. In cPanel → **Subdomains**
2. Create subdomain: `api.holmdalerodeo.ca`
3. Document root: point to your Node.js app directory
4. The Node.js app will handle requests at this subdomain

**Option B: Main Domain**

1. Use `holmdalerodeo.ca` for frontend (static files)
2. Use `holmdalerodeo.ca/api` for backend
3. Configure in Node.js app settings

**Note:** Web Hosting Canada typically proxies Node.js apps automatically. The app runs on an internal port, and Apache/nginx proxies requests to it.

---

### **Step 10: Configure SSL (HTTPS)**

1. In cPanel → **SSL/TLS Status**
2. Find `api.holmdalerodeo.ca` (or your domain)
3. Click **"Run AutoSSL"**
4. Wait for SSL certificate to be issued (free Let's Encrypt)

Your backend will now be accessible at:
- `https://api.holmdalerodeo.ca`

---

### **Step 11: Test Your Backend**

Open browser or use curl:

```bash
# Health check
https://api.holmdalerodeo.ca/health

# API info
https://api.holmdalerodeo.ca/

# Login test
curl -X POST https://api.holmdalerodeo.ca/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"darren@holmgraphics.ca","password":"changeme123"}'
```

---

### **Step 12: Update Frontend**

In your frontend code:

```javascript
const API_URL = 'https://api.holmdalerodeo.ca/api';
```

Update CORS in backend `.env`:
```env
FRONTEND_URL=https://holmdalerodeo.ca
```

---

## 🔧 **Troubleshooting**

### **Application Won't Start**

1. Check **Error Log** in Node.js App interface
2. Common issues:
   - Missing dependencies: Run `npm install` again
   - Wrong Node version: Change to 18.x or 20.x
   - Database connection: Verify DATABASE_URL

### **Database Connection Failed**

1. Verify PostgreSQL is running
2. Check database name includes cPanel username prefix
3. Test connection in phpPgAdmin
4. Ensure DATABASE_URL in .env is correct

### **Port Issues**

WHC assigns ports automatically. Don't hardcode port 3000 in production.

In `server.js`, ensure:
```javascript
const PORT = process.env.PORT || 3000;
```

### **Module Not Found**

```bash
cd ~/rodeo-backend
rm -rf node_modules
npm install
```

### **500 Internal Server Error**

1. Check application error logs
2. Ensure all environment variables are set
3. Verify file permissions (644 for files, 755 for directories)

---

## 📊 **Performance Tips**

1. **Enable caching** in your Node.js app
2. **Use PM2** if WHC supports it (keeps app running)
3. **Monitor resources** in cPanel (CPU/Memory usage)
4. **Database indexes** are already created in schema

---

## 🔒 **Security Checklist**

- ✅ Change default admin password immediately
- ✅ Use strong JWT_SECRET
- ✅ Enable HTTPS/SSL
- ✅ Keep Node.js updated
- ✅ Don't commit .env to Git
- ✅ Use environment variables for secrets
- ✅ Set NODE_ENV=production

---

## 📱 **Accessing Logs**

In **Setup Node.js App** → Your App:
- Click **"View Log"** or **"Error Log"**
- Monitor for issues

Or via SSH:
```bash
tail -f ~/rodeo-backend/logs/error.log
```

---

## 🆘 **Still Having Issues?**

1. **Contact WHC Support**: 1-877-977-5678
   - They can help with Node.js app setup
   - Ask about PostgreSQL connection details

2. **Check Documentation**:
   - WHC Knowledge Base: https://www.webhostingcanada.com/kb/

3. **Email me**: darren@holmgraphics.ca

---

## 🎯 **Final Checklist**

- ✅ Node.js app created and running
- ✅ PostgreSQL database created
- ✅ Environment variables configured
- ✅ Dependencies installed (`npm install`)
- ✅ Migrations run (database tables created)
- ✅ Admin user created
- ✅ SSL certificate installed
- ✅ Backend accessible at api.holmdalerodeo.ca
- ✅ Frontend updated with new API URL
- ✅ Test login works

---

## 🚀 **You're Live!**

Your backend is now running on Web Hosting Canada!

- **Backend**: https://api.holmdalerodeo.ca
- **Frontend**: https://holmdalerodeo.ca

Next: Deploy your frontend to the main domain and you're done! 🎉
