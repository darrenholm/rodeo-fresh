# 🚂 Base44 → Railway Integration Guide

## Complete guide to connecting your Base44 frontend to Railway backend

**Perfect for:** Keeping your Base44 UI while getting production-scale infrastructure

---

## 📋 **Overview**

This guide shows you how to:
1. Deploy your backend to Railway
2. Configure Base44 to call Railway APIs
3. Handle authentication between both systems
4. Test the integration
5. Go live with 12,000 attendee capacity

**Timeline:** 1-2 weeks  
**Cost:** $20/month (Railway Pro)  
**Difficulty:** Intermediate

---

## 🎯 **Architecture**

```
┌──────────────────────────────────────────┐
│  Base44 Frontend                         │
│  https://your-app.base44.com             │
│                                          │
│  Your UI Components:                     │
│  - Event listings                        │
│  - Ticket purchase forms                 │
│  - Product catalog                       │
│  - Staff dashboard                       │
│  - Admin panels                          │
└──────────────────────────────────────────┘
                    ↓
          API Calls (HTTPS)
                    ↓
┌──────────────────────────────────────────┐
│  Railway Backend                         │
│  https://rodeo-api.railway.app           │
│                                          │
│  Your API Endpoints:                     │
│  - GET  /api/events                      │
│  - POST /api/ticket-orders               │
│  - GET  /api/products                    │
│  - POST /api/auth/login                  │
│  - GET  /api/staff                       │
│  - GET  /api/dashboard/stats             │
└──────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────┐
│  Railway PostgreSQL                      │
│  - All your data (88 staff, events...)  │
│  - Auto backups                          │
│  - 100 connections                       │
└──────────────────────────────────────────┘
```

---

## 🚀 **Part 1: Deploy Backend to Railway**

### **Step 1.1: Install Railway CLI**

**On Windows (PowerShell):**
```powershell
npm install -g @railway/cli
```

**On Mac/Linux:**
```bash
npm install -g @railway/cli
```

Verify installation:
```bash
railway --version
```

---

### **Step 1.2: Login to Railway**

```bash
railway login
```

This opens browser for authentication. Login with:
- GitHub account (recommended)
- Or email

---

### **Step 1.3: Deploy Your Backend**

```bash
# Navigate to your backend folder
cd /path/to/backend

# Initialize Railway project
railway init

# When prompted:
# - Project name: rodeo-backend
# - Choose: "Create new project"

# Add PostgreSQL database
railway add

# Choose: PostgreSQL
# This automatically creates database and sets DATABASE_URL

# Deploy your code
railway up

# This uploads your backend and starts it
```

**Expected output:**
```
✓ Project created: rodeo-backend
✓ PostgreSQL added
✓ Deploying...
✓ Deployment successful
✓ URL: https://rodeo-backend-production.up.railway.app
```

---

### **Step 1.4: Set Environment Variables**

```bash
# Set JWT secret
railway variables set JWT_SECRET="your-super-long-random-secret-string-at-least-32-characters"

# Set production mode
railway variables set NODE_ENV="production"

# Set CORS origin (your Base44 app URL)
railway variables set FRONTEND_URL="https://your-app.base44.com"

# Optional: Set Stripe keys
railway variables set STRIPE_SECRET_KEY="sk_live_your_key"
```

**To find your Base44 app URL:**
1. Go to your Base44 dashboard
2. Look for your app URL (e.g., `https://holmdale-rodeo.base44.com`)
3. Use that exact URL for `FRONTEND_URL`

---

### **Step 1.5: Run Database Migrations**

```bash
# Run migrations to create tables
railway run npm run migrate

# Import your CSV data
railway run npm run seed
```

**Expected output:**
```
✓ Running migrations...
✓ All tables created
✓ Default admin user created
  Email: darren@holmgraphics.ca
  Password: changeme123
✓ Importing CSV data...
✓ Imported 88 staff members
✓ Imported 3 events
✓ Imported 37 shifts
✓ Imported 10 ticket orders
✓ Imported 4 products
✓ Imported 28 orders
```

---

### **Step 1.6: Get Your Railway URL**

```bash
# Get your deployment URL
railway status
```

**Output shows:**
```
Project: rodeo-backend
Service: rodeo-backend
URL: https://rodeo-backend-production.up.railway.app
Status: ACTIVE
```

**Save this URL - you'll need it for Base44!**

---

### **Step 1.7: Test Your Railway Backend**

Open browser or use curl:

```bash
# Test health endpoint
curl https://rodeo-backend-production.up.railway.app/health

# Expected response:
{"status":"ok","timestamp":"2026-02-16T..."}

# Test events endpoint
curl https://rodeo-backend-production.up.railway.app/api/events

# Should return your 3 events as JSON
```

✅ **Railway backend is now live!**

---

## 🔗 **Part 2: Connect Base44 to Railway**

### **Step 2.1: Create API Configuration in Base44**

In your Base44 project, create a new **code file** or **custom function**:

**File: `config.js`** (or whatever Base44 calls it)

```javascript
// Railway Backend Configuration
const API_CONFIG = {
  // Your Railway URL (replace with yours from Step 1.6)
  BASE_URL: 'https://rodeo-backend-production.up.railway.app/api',
  
  // Request timeout (ms)
  TIMEOUT: 30000,
  
  // Storage keys
  STORAGE: {
    AUTH_TOKEN: 'rodeo_auth_token',
    USER_DATA: 'rodeo_user_data'
  }
};

// Export for use in other files
export default API_CONFIG;
```

---

### **Step 2.2: Create API Helper Functions**

**File: `api.js`** (create in Base44)

```javascript
import API_CONFIG from './config.js';

// ============================================
// AUTHENTICATION HELPERS
// ============================================

function getAuthToken() {
  return localStorage.getItem(API_CONFIG.STORAGE.AUTH_TOKEN);
}

function setAuthToken(token) {
  localStorage.setItem(API_CONFIG.STORAGE.AUTH_TOKEN, token);
}

function clearAuthToken() {
  localStorage.removeItem(API_CONFIG.STORAGE.AUTH_TOKEN);
  localStorage.removeItem(API_CONFIG.STORAGE.USER_DATA);
}

function getUserData() {
  const data = localStorage.getItem(API_CONFIG.STORAGE.USER_DATA);
  return data ? JSON.parse(data) : null;
}

function setUserData(user) {
  localStorage.setItem(API_CONFIG.STORAGE.USER_DATA, JSON.stringify(user));
}

// ============================================
// GENERIC API CALL FUNCTION
// ============================================

async function apiCall(endpoint, options = {}) {
  const token = getAuthToken();
  
  const config = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),
      ...options.headers
    }
  };
  
  try {
    const response = await fetch(`${API_CONFIG.BASE_URL}${endpoint}`, config);
    
    // Handle unauthorized (expired token)
    if (response.status === 401) {
      clearAuthToken();
      throw new Error('Session expired. Please login again.');
    }
    
    // Handle other errors
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `API Error: ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('API Call Failed:', error);
    throw error;
  }
}

// ============================================
// API METHODS
// ============================================

export const api = {
  // --------------------------------------
  // AUTHENTICATION
  // --------------------------------------
  
  login: async (email, password) => {
    const response = await apiCall('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    
    // Save token and user data
    setAuthToken(response.token);
    setUserData(response.user);
    
    return response;
  },
  
  register: async (email, password, name) => {
    const response = await apiCall('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name })
    });
    
    setAuthToken(response.token);
    setUserData(response.user);
    
    return response;
  },
  
  logout: () => {
    clearAuthToken();
  },
  
  getCurrentUser: () => {
    return getUserData();
  },
  
  isAuthenticated: () => {
    return !!getAuthToken();
  },
  
  // --------------------------------------
  // EVENTS
  // --------------------------------------
  
  getEvents: async () => {
    return apiCall('/events');
  },
  
  getEvent: async (id) => {
    return apiCall(`/events/${id}`);
  },
  
  getFeaturedEvents: async () => {
    return apiCall('/events?featured=true');
  },
  
  createEvent: async (eventData) => {
    return apiCall('/events', {
      method: 'POST',
      body: JSON.stringify(eventData)
    });
  },
  
  updateEvent: async (id, eventData) => {
    return apiCall(`/events/${id}`, {
      method: 'PUT',
      body: JSON.stringify(eventData)
    });
  },
  
  deleteEvent: async (id) => {
    return apiCall(`/events/${id}`, {
      method: 'DELETE'
    });
  },
  
  // --------------------------------------
  // TICKET ORDERS
  // --------------------------------------
  
  createTicketOrder: async (orderData) => {
    return apiCall('/ticket-orders', {
      method: 'POST',
      body: JSON.stringify(orderData)
    });
  },
  
  getTicketOrders: async (filters = {}) => {
    const params = new URLSearchParams(filters);
    return apiCall(`/ticket-orders?${params}`);
  },
  
  getTicketOrderByConfirmation: async (code) => {
    return apiCall(`/ticket-orders/confirmation/${code}`);
  },
  
  scanTicket: async (ticketId, rfidTagId) => {
    return apiCall(`/ticket-orders/${ticketId}/scan`, {
      method: 'PUT',
      body: JSON.stringify({ rfid_tag_id: rfidTagId })
    });
  },
  
  // --------------------------------------
  // PRODUCTS
  // --------------------------------------
  
  getProducts: async (filters = {}) => {
    const params = new URLSearchParams(filters);
    return apiCall(`/products?${params}`);
  },
  
  getProduct: async (id) => {
    return apiCall(`/products/${id}`);
  },
  
  createProduct: async (productData) => {
    return apiCall('/products', {
      method: 'POST',
      body: JSON.stringify(productData)
    });
  },
  
  updateProduct: async (id, productData) => {
    return apiCall(`/products/${id}`, {
      method: 'PUT',
      body: JSON.stringify(productData)
    });
  },
  
  // --------------------------------------
  // ORDERS
  // --------------------------------------
  
  createOrder: async (orderData) => {
    return apiCall('/orders', {
      method: 'POST',
      body: JSON.stringify(orderData)
    });
  },
  
  getOrders: async (filters = {}) => {
    const params = new URLSearchParams(filters);
    return apiCall(`/orders?${params}`);
  },
  
  getOrder: async (id) => {
    return apiCall(`/orders/${id}`);
  },
  
  updateOrderStatus: async (id, status, tracking) => {
    return apiCall(`/orders/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ 
        status, 
        tracking_number: tracking?.tracking_number,
        shipment_id: tracking?.shipment_id
      })
    });
  },
  
  // --------------------------------------
  // STAFF
  // --------------------------------------
  
  getStaff: async (filters = {}) => {
    const params = new URLSearchParams(filters);
    return apiCall(`/staff?${params}`);
  },
  
  getStaffMember: async (id) => {
    return apiCall(`/staff/${id}`);
  },
  
  createStaffMember: async (staffData) => {
    return apiCall('/staff', {
      method: 'POST',
      body: JSON.stringify(staffData)
    });
  },
  
  updateStaffMember: async (id, staffData) => {
    return apiCall(`/staff/${id}`, {
      method: 'PUT',
      body: JSON.stringify(staffData)
    });
  },
  
  deleteStaffMember: async (id) => {
    return apiCall(`/staff/${id}`, {
      method: 'DELETE'
    });
  },
  
  // --------------------------------------
  // SHIFTS
  // --------------------------------------
  
  getShifts: async (filters = {}) => {
    const params = new URLSearchParams(filters);
    return apiCall(`/shifts?${params}`);
  },
  
  createShift: async (shiftData) => {
    return apiCall('/shifts', {
      method: 'POST',
      body: JSON.stringify(shiftData)
    });
  },
  
  updateShift: async (id, shiftData) => {
    return apiCall(`/shifts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(shiftData)
    });
  },
  
  deleteShift: async (id) => {
    return apiCall(`/shifts/${id}`, {
      method: 'DELETE'
    });
  },
  
  // --------------------------------------
  // DASHBOARD
  // --------------------------------------
  
  getDashboardStats: async () => {
    return apiCall('/dashboard/stats');
  }
};

export default api;
```

---

### **Step 2.3: Update Base44 Components**

Now update your Base44 components to use the Railway API:

#### **Example 1: Login Form**

**Before (Base44 internal):**
```javascript
// Old Base44 code
async function handleLogin() {
  const result = await base44.auth.login(email, password);
  // ...
}
```

**After (Railway backend):**
```javascript
import { api } from './api.js';

async function handleLogin() {
  try {
    const result = await api.login(email, password);
    
    console.log('Login successful:', result.user);
    // Redirect or update UI
    window.location.href = '/dashboard';
    
  } catch (error) {
    console.error('Login failed:', error.message);
    // Show error to user
    alert('Login failed: ' + error.message);
  }
}
```

---

#### **Example 2: Event Listing**

**Before (Base44 internal):**
```javascript
async function loadEvents() {
  const events = await base44.getCollection('events');
  displayEvents(events);
}
```

**After (Railway backend):**
```javascript
import { api } from './api.js';

async function loadEvents() {
  try {
    // Show loading state
    showLoading(true);
    
    // Fetch from Railway
    const events = await api.getEvents();
    
    // Display events
    displayEvents(events);
    
  } catch (error) {
    console.error('Failed to load events:', error);
    showError('Could not load events. Please try again.');
  } finally {
    showLoading(false);
  }
}
```

---

#### **Example 3: Ticket Purchase**

**Before (Base44 internal):**
```javascript
async function purchaseTickets(eventId, quantity) {
  const order = await base44.createRecord('tickets', {
    event_id: eventId,
    quantity: quantity
  });
}
```

**After (Railway backend):**
```javascript
import { api } from './api.js';

async function purchaseTickets(eventId, quantity, customerInfo) {
  try {
    const order = await api.createTicketOrder({
      event_id: eventId,
      customer_name: customerInfo.name,
      customer_email: customerInfo.email,
      customer_phone: customerInfo.phone || '',
      ticket_type: 'general',
      quantity_adult: quantity,
      quantity_child: 0,
      total_price: quantity * 45 // Adjust price as needed
    });
    
    console.log('Order created:', order);
    
    // Show confirmation
    alert(`Success! Your confirmation code is: ${order.confirmation_code}`);
    
    return order;
    
  } catch (error) {
    console.error('Purchase failed:', error);
    alert('Purchase failed: ' + error.message);
    throw error;
  }
}
```

---

#### **Example 4: Staff List (Admin)**

**Before (Base44 internal):**
```javascript
async function loadStaff() {
  const staff = await base44.getCollection('staff');
  renderStaffTable(staff);
}
```

**After (Railway backend):**
```javascript
import { api } from './api.js';

async function loadStaff(filters = {}) {
  try {
    // Check if user is authenticated
    if (!api.isAuthenticated()) {
      window.location.href = '/login';
      return;
    }
    
    // Fetch staff with filters
    const staff = await api.getStaff(filters);
    
    // Render table
    renderStaffTable(staff);
    
  } catch (error) {
    if (error.message.includes('Session expired')) {
      alert('Your session has expired. Please login again.');
      window.location.href = '/login';
    } else {
      showError('Failed to load staff: ' + error.message);
    }
  }
}

// Example: Filter by year availability
async function loadStaffFor2026() {
  await loadStaff({ year: 2026 });
}
```

---

#### **Example 5: Product Catalog**

**Before (Base44 internal):**
```javascript
async function loadProducts() {
  const products = await base44.getCollection('products');
  displayProducts(products);
}
```

**After (Railway backend):**
```javascript
import { api } from './api.js';

async function loadProducts(category = null) {
  try {
    const filters = {};
    if (category) {
      filters.category = category;
    }
    
    const products = await api.getProducts(filters);
    
    displayProducts(products);
    
  } catch (error) {
    console.error('Failed to load products:', error);
    showError('Could not load products.');
  }
}

// Example: Load only hats
async function loadHats() {
  await loadProducts('hat');
}

// Example: Load only in-stock items
async function loadInStockProducts() {
  const products = await api.getProducts({ in_stock: true });
  displayProducts(products);
}
```

---

## 🔐 **Part 3: Authentication Flow**

### **Step 3.1: Create Login Page**

```javascript
import { api } from './api.js';

// Login form handler
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const errorDiv = document.getElementById('error');
  const submitBtn = document.getElementById('submitBtn');
  
  // Clear previous errors
  errorDiv.textContent = '';
  
  // Disable button during login
  submitBtn.disabled = true;
  submitBtn.textContent = 'Logging in...';
  
  try {
    // Login via Railway backend
    const result = await api.login(email, password);
    
    console.log('Login successful:', result.user);
    
    // Redirect to dashboard
    window.location.href = '/dashboard';
    
  } catch (error) {
    errorDiv.textContent = error.message;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Login';
  }
});
```

---

### **Step 3.2: Protect Pages That Need Auth**

Add this to pages that require login:

```javascript
import { api } from './api.js';

// Run on page load
window.addEventListener('DOMContentLoaded', () => {
  // Check if user is authenticated
  if (!api.isAuthenticated()) {
    // Redirect to login
    window.location.href = '/login';
    return;
  }
  
  // Get current user info
  const user = api.getCurrentUser();
  console.log('Current user:', user);
  
  // Display user name in header
  document.getElementById('userName').textContent = user.name;
  
  // Load page content
  loadPageContent();
});
```

---

### **Step 3.3: Logout Function**

```javascript
import { api } from './api.js';

function logout() {
  api.logout();
  window.location.href = '/login';
}

// Add to logout button
document.getElementById('logoutBtn').addEventListener('click', logout);
```

---

## 🧪 **Part 4: Testing the Integration**

### **Step 4.1: Test Checklist**

Use this checklist to verify everything works:

#### **Public Endpoints (No Auth Required):**
- [ ] Load events page
- [ ] View event details
- [ ] Browse products
- [ ] View product details
- [ ] Purchase tickets (create order)

#### **Authentication:**
- [ ] Login with admin credentials
  - Email: darren@holmgraphics.ca
  - Password: changeme123
- [ ] Token is saved to localStorage
- [ ] User data is saved to localStorage
- [ ] Logout clears tokens

#### **Authenticated Endpoints:**
- [ ] View staff list
- [ ] View staff details
- [ ] Create new staff member (admin)
- [ ] Update staff member (admin)
- [ ] View shifts
- [ ] View dashboard stats (admin)

#### **Error Handling:**
- [ ] Login with wrong password shows error
- [ ] Expired token redirects to login
- [ ] Network errors show friendly message
- [ ] API errors display to user

---

### **Step 4.2: Manual Testing**

**Test 1: Load Events**
```javascript
// Open browser console on your Base44 app
api.getEvents().then(events => {
  console.log('Events loaded:', events);
});
```

**Test 2: Login**
```javascript
api.login('darren@holmgraphics.ca', 'changeme123')
  .then(result => {
    console.log('Login success:', result);
  })
  .catch(error => {
    console.error('Login failed:', error);
  });
```

**Test 3: Create Ticket Order**
```javascript
api.createTicketOrder({
  event_id: '696bb80b79d792d4580e5de7', // Use real event ID from your data
  customer_name: 'Test Customer',
  customer_email: 'test@example.com',
  customer_phone: '555-1234',
  ticket_type: 'general',
  quantity_adult: 2,
  quantity_child: 0,
  total_price: 90
}).then(order => {
  console.log('Order created:', order);
  console.log('Confirmation code:', order.confirmation_code);
});
```

---

### **Step 4.3: Browser DevTools Testing**

**Check Network Tab:**
1. Open Base44 app in browser
2. Open DevTools (F12)
3. Go to Network tab
4. Perform actions (login, load events, etc.)
5. Verify requests go to Railway URL
6. Check response status (200 = success)

**Check Console Tab:**
1. Look for any errors
2. Verify API responses
3. Check authentication tokens

**Check Application Tab:**
1. Go to Application → Local Storage
2. Verify `rodeo_auth_token` exists after login
3. Verify `rodeo_user_data` exists after login

---

## 🚨 **Part 5: Troubleshooting**

### **Problem 1: CORS Errors**

**Error:** `Access to fetch at 'https://...' has been blocked by CORS policy`

**Solution:**

1. **Check Railway environment variables:**
```bash
railway variables
```

2. **Ensure FRONTEND_URL is set:**
```bash
railway variables set FRONTEND_URL="https://your-app.base44.com"
```

3. **Verify in backend `server.js`:**
```javascript
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
```

4. **Allow multiple origins if needed:**
```javascript
app.use(cors({
  origin: [
    'https://your-app.base44.com',
    'https://holmdale-rodeo.base44.com', // Add all your Base44 URLs
    'http://localhost:3000'
  ],
  credentials: true
}));
```

5. **Redeploy backend:**
```bash
railway up
```

---

### **Problem 2: 401 Unauthorized**

**Error:** API returns 401 on authenticated endpoints

**Solutions:**

1. **Check token is being sent:**
```javascript
// In browser console
localStorage.getItem('rodeo_auth_token');
// Should show a long string (JWT token)
```

2. **Check Authorization header:**
```javascript
// In Network tab, check request headers
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

3. **Verify token hasn't expired:**
```bash
# In Railway, check JWT_EXPIRES_IN
railway variables
```

4. **Login again to get fresh token:**
```javascript
api.logout();
api.login('darren@holmgraphics.ca', 'changeme123');
```

---

### **Problem 3: Network Timeout**

**Error:** Request takes too long or times out

**Solutions:**

1. **Check Railway service is running:**
```bash
railway status
```

2. **Check Railway logs:**
```bash
railway logs
```

3. **Test Railway backend directly:**
```bash
curl https://rodeo-backend-production.up.railway.app/health
```

4. **Check database connection:**
```bash
railway run npm run migrate
```

---

### **Problem 4: Database Connection Failed**

**Error:** `Database connection failed` in Railway logs

**Solutions:**

1. **Verify PostgreSQL is added:**
```bash
railway services
# Should show PostgreSQL service
```

2. **Check DATABASE_URL is set:**
```bash
railway variables
# Should show DATABASE_URL=postgresql://...
```

3. **Test database connection:**
```bash
railway run node -e "require('./config/database.js')"
```

---

### **Problem 5: API Returns Wrong Data**

**Error:** API returns data but it's not what you expect

**Solutions:**

1. **Check data was imported:**
```bash
railway run npm run seed
```

2. **Query database directly:**
```bash
railway connect postgres
# Then run SQL:
SELECT COUNT(*) FROM events;
SELECT * FROM events LIMIT 5;
```

3. **Check filters/parameters:**
```javascript
// Make sure you're passing correct parameters
api.getStaff({ year: 2026 }); // Not 'y2026'
```

---

## 📊 **Part 6: Performance Optimization**

### **Step 6.1: Add Loading States**

```javascript
import { api } from './api.js';

async function loadEventsWithLoading() {
  const loadingEl = document.getElementById('loading');
  const contentEl = document.getElementById('content');
  const errorEl = document.getElementById('error');
  
  try {
    // Show loading
    loadingEl.style.display = 'block';
    contentEl.style.display = 'none';
    errorEl.style.display = 'none';
    
    // Fetch data
    const events = await api.getEvents();
    
    // Display content
    displayEvents(events);
    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';
    
  } catch (error) {
    // Show error
    loadingEl.style.display = 'none';
    errorEl.textContent = 'Failed to load events: ' + error.message;
    errorEl.style.display = 'block';
  }
}
```

---

### **Step 6.2: Cache Static Data**

```javascript
// Simple cache for data that doesn't change often
const cache = {
  events: null,
  eventsTimestamp: null,
  CACHE_DURATION: 5 * 60 * 1000 // 5 minutes
};

async function getEventsWithCache() {
  const now = Date.now();
  
  // Return cached data if still valid
  if (cache.events && (now - cache.eventsTimestamp) < cache.CACHE_DURATION) {
    console.log('Returning cached events');
    return cache.events;
  }
  
  // Fetch fresh data
  console.log('Fetching fresh events');
  const events = await api.getEvents();
  
  // Update cache
  cache.events = events;
  cache.eventsTimestamp = now;
  
  return events;
}
```

---

### **Step 6.3: Batch Requests**

```javascript
// Instead of multiple sequential requests:
// ❌ BAD
async function loadDashboard() {
  const events = await api.getEvents();
  const staff = await api.getStaff();
  const products = await api.getProducts();
  // Takes 3 seconds (1 sec each)
}

// Do parallel requests:
// ✅ GOOD
async function loadDashboard() {
  const [events, staff, products] = await Promise.all([
    api.getEvents(),
    api.getStaff(),
    api.getProducts()
  ]);
  // Takes 1 second (all at once)
  
  displayDashboard({ events, staff, products });
}
```

---

## 🎯 **Part 7: Going Live**

### **Step 7.1: Change Admin Password**

**IMPORTANT:** Change default password before going live!

```javascript
// In Base44, create admin panel function
async function changePassword(newPassword) {
  try {
    await api.updateUser(api.getCurrentUser().id, {
      password: newPassword
    });
    alert('Password changed successfully!');
  } catch (error) {
    alert('Failed to change password: ' + error.message);
  }
}
```

Or via Railway CLI:
```bash
railway connect postgres

# In psql:
UPDATE users 
SET password = '$2a$10$newHashedPassword...' 
WHERE email = 'darren@holmgraphics.ca';
```

---

### **Step 7.2: Upgrade to Railway Pro**

For 12,000 attendees, upgrade to Railway Pro:

1. Go to Railway dashboard
2. Click your project
3. Go to Settings → Billing
4. Upgrade to **Pro Plan** ($20/month)

**Benefits:**
- 8GB RAM (vs 512MB free)
- No request limits
- Priority support
- Better performance

---

### **Step 7.3: Setup Monitoring**

**In Railway Dashboard:**
1. Go to your service
2. Click "Observability" tab
3. Monitor:
   - Request count
   - Response times
   - Error rates
   - CPU/Memory usage

**Set up alerts:**
1. Go to Settings
2. Add notification webhooks (optional)
3. Configure email alerts

---

### **Step 7.4: Test Under Load**

Use Artillery to simulate traffic:

```bash
# Install Artillery
npm install -g artillery

# Create test script: load-test.yml
cat > load-test.yml << 'EOF'
config:
  target: "https://rodeo-backend-production.up.railway.app"
  phases:
    - duration: 60
      arrivalRate: 10
      name: "Warm up"
    - duration: 120
      arrivalRate: 50
      name: "Moderate load"
    - duration: 60
      arrivalRate: 100
      name: "Peak load"

scenarios:
  - name: "Browse events"
    flow:
      - get:
          url: "/api/events"
      - think: 2
      - get:
          url: "/api/products"
EOF

# Run test
artillery run load-test.yml
```

**Look for:**
- Response times under 500ms
- No 500 errors
- No timeouts

---

## ✅ **Part 8: Final Checklist**

Before going live with 12,000 attendees:

### **Backend:**
- [ ] Deployed to Railway Pro
- [ ] PostgreSQL database created
- [ ] All migrations run
- [ ] CSV data imported
- [ ] Environment variables set
- [ ] CORS configured for Base44
- [ ] Admin password changed
- [ ] SSL/HTTPS working

### **Base44 Frontend:**
- [ ] config.js created with Railway URL
- [ ] api.js created with all methods
- [ ] All components updated to use Railway API
- [ ] Login/logout working
- [ ] Token storage working
- [ ] Error handling implemented
- [ ] Loading states added

### **Testing:**
- [ ] Can login successfully
- [ ] Can browse events
- [ ] Can purchase tickets
- [ ] Can view products
- [ ] Staff can view schedules
- [ ] Admin can manage data
- [ ] Mobile devices tested
- [ ] Load tested (100+ concurrent users)

### **Monitoring:**
- [ ] Railway dashboard accessible
- [ ] Can view logs
- [ ] Can view metrics
- [ ] Error tracking setup

---

## 📞 **Part 9: Support & Resources**

### **Getting Help:**

**Railway Issues:**
- Dashboard: https://railway.app
- Docs: https://docs.railway.app
- Discord: https://discord.gg/railway
- Email: team@railway.app

**Backend Code Issues:**
- Check Railway logs: `railway logs`
- Test endpoints: `curl https://your-url.railway.app/health`
- Review API docs in README.md

**Base44 Integration Issues:**
- Check browser console for errors
- Verify API URL in config.js
- Check CORS settings in Railway
- Test with simple curl first

---

## 🎉 **Success!**

You now have:
- ✅ Base44 frontend (fast development)
- ✅ Railway backend (production scale)
- ✅ PostgreSQL database (your data)
- ✅ Ready for 12,000 attendees

**Total time:** 1-2 weeks  
**Monthly cost:** $20 (Railway Pro)  
**Capacity:** 4000+ users per day  

Your rodeo platform is ready to scale! 🤠

---

## 📝 **Quick Reference**

### **Common API Calls:**

```javascript
// Load events
const events = await api.getEvents();

// Login
await api.login('email@example.com', 'password');

// Create ticket order
await api.createTicketOrder({
  event_id: 'event_id_here',
  customer_name: 'John Doe',
  customer_email: 'john@example.com',
  quantity_adult: 2,
  total_price: 90
});

// Get staff for 2026
const staff = await api.getStaff({ year: 2026 });

// Check if logged in
if (api.isAuthenticated()) {
  // User is logged in
}
```

### **Railway Commands:**

```bash
# View logs
railway logs

# Check status
railway status

# Run migration
railway run npm run migrate

# Set environment variable
railway variables set KEY="value"

# Connect to database
railway connect postgres
```

---

**Questions?** Email: darren@holmgraphics.ca
