-- Holmdale Rodeo Database Schema
-- Generated from Base44 export

-- ============================================
-- USERS & AUTHENTICATION
-- ============================================

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'user', -- 'admin', 'user', 'staff'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- STAFF MANAGEMENT
-- ============================================

CREATE TABLE IF NOT EXISTS staff (
  id VARCHAR(255) PRIMARY KEY, -- Using Base44 ID format
  no INTEGER UNIQUE,
  fname VARCHAR(100),
  lname VARCHAR(100),
  fullname VARCHAR(200),
  email VARCHAR(255),
  phone VARCHAR(50),
  adult BOOLEAN DEFAULT false,
  smartserve BOOLEAN DEFAULT false,
  y2024 BOOLEAN DEFAULT false,
  y2025 BOOLEAN DEFAULT false,
  y2026 BOOLEAN DEFAULT false,
  y2027 BOOLEAN DEFAULT false,
  y2028 BOOLEAN DEFAULT false,
  created_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by_id VARCHAR(255),
  created_by VARCHAR(255),
  is_sample BOOLEAN DEFAULT false
);

-- ============================================
-- EVENTS
-- ============================================

CREATE TABLE IF NOT EXISTS events (
  id VARCHAR(255) PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  date TIMESTAMP NOT NULL,
  time VARCHAR(50),
  description TEXT,
  image_url TEXT,
  venue VARCHAR(500),
  general_price DECIMAL(10, 2) DEFAULT 0,
  vip_price DECIMAL(10, 2) DEFAULT 0,
  general_available INTEGER DEFAULT 0,
  vip_available INTEGER DEFAULT 0,
  is_featured BOOLEAN DEFAULT false,
  created_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by_id VARCHAR(255),
  created_by VARCHAR(255),
  is_sample BOOLEAN DEFAULT false
);

-- ============================================
-- SHIFTS / SCHEDULING
-- ============================================

CREATE TABLE IF NOT EXISTS shifts (
  id VARCHAR(255) PRIMARY KEY,
  staff_name VARCHAR(255),
  staff_id VARCHAR(255) REFERENCES staff(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  role VARCHAR(50), -- 'bar', 'gate', etc.
  persons_required INTEGER DEFAULT 6, -- how many staff this shift needs
  notes TEXT,
  event_id VARCHAR(255) REFERENCES events(id) ON DELETE CASCADE,
  created_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by_id VARCHAR(255),
  created_by VARCHAR(255),
  is_sample BOOLEAN DEFAULT false
);

-- ============================================
-- TICKET ORDERS
-- ============================================

CREATE TABLE IF NOT EXISTS ticket_orders (
  id VARCHAR(255) PRIMARY KEY,
  event_id VARCHAR(255) REFERENCES events(id) ON DELETE CASCADE,
  customer_name VARCHAR(255) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  customer_phone VARCHAR(50),
  ticket_type VARCHAR(50) DEFAULT 'general', -- 'general', 'vip'
  quantity_adult INTEGER DEFAULT 0,
  quantity_child INTEGER DEFAULT 0,
  total_price DECIMAL(10, 2) NOT NULL,
  confirmation_code VARCHAR(100) UNIQUE,
  status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'confirmed', 'cancelled'
  scanned BOOLEAN DEFAULT false,
  scanned_at TIMESTAMP,
  rfid_tag_id VARCHAR(100),
  created_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by_id VARCHAR(255),
  created_by VARCHAR(255),
  is_sample BOOLEAN DEFAULT false
);

-- ============================================
-- PRODUCTS (E-COMMERCE)
-- ============================================

CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(500) NOT NULL,
  description TEXT,
  category VARCHAR(100), -- 'hat', 'shirt', etc.
  price DECIMAL(10, 2) NOT NULL,
  image_url TEXT,
  stripe_price_id VARCHAR(255),
  sizes JSONB DEFAULT '[]',
  colors JSONB DEFAULT '[]',
  stock INTEGER DEFAULT 0,
  weight DECIMAL(10, 2),
  length DECIMAL(10, 2),
  width DECIMAL(10, 2),
  height DECIMAL(10, 2),
  created_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by_id VARCHAR(255),
  created_by VARCHAR(255),
  is_sample BOOLEAN DEFAULT false
);

-- ============================================
-- PRODUCT ORDERS
-- ============================================

CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(255) PRIMARY KEY,
  stripe_session_id VARCHAR(255),
  monaris_transaction_id VARCHAR(255),
  customer_name VARCHAR(255) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  items JSONB NOT NULL DEFAULT '[]', -- Array of {product_id, name, price, quantity}
  total_amount DECIMAL(10, 2) NOT NULL,
  shipping_address JSONB, -- {street, city, province, postal_code, country}
  tracking_number VARCHAR(255),
  shipment_id VARCHAR(255),
  status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'paid', 'shipped', 'delivered', 'cancelled'
  created_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by_id VARCHAR(255),
  created_by VARCHAR(255),
  is_sample BOOLEAN DEFAULT false
);

-- ============================================
-- BAR PURCHASES (placeholder - was empty in CSV)
-- ============================================

CREATE TABLE IF NOT EXISTS bar_purchases (
  id VARCHAR(255) PRIMARY KEY,
  event_id VARCHAR(255) REFERENCES events(id) ON DELETE CASCADE,
  staff_id VARCHAR(255) REFERENCES staff(id) ON DELETE SET NULL,
  item_name VARCHAR(255),
  quantity INTEGER DEFAULT 1,
  price DECIMAL(10, 2),
  total DECIMAL(10, 2),
  purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by_id VARCHAR(255),
  created_by VARCHAR(255),
  is_sample BOOLEAN DEFAULT false
);

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================

-- Staff indexes
CREATE INDEX idx_staff_email ON staff(email);
CREATE INDEX idx_staff_fullname ON staff(fullname);
CREATE INDEX idx_staff_no ON staff(no);

-- Event indexes
CREATE INDEX idx_events_date ON events(date);
CREATE INDEX idx_events_featured ON events(is_featured);

-- Shift indexes
CREATE INDEX idx_shifts_date ON shifts(date);
CREATE INDEX idx_shifts_event ON shifts(event_id);
CREATE INDEX idx_shifts_staff ON shifts(staff_id);

-- Ticket order indexes
CREATE INDEX idx_ticket_orders_event ON ticket_orders(event_id);
CREATE INDEX idx_ticket_orders_email ON ticket_orders(customer_email);
CREATE INDEX idx_ticket_orders_confirmation ON ticket_orders(confirmation_code);
CREATE INDEX idx_ticket_orders_status ON ticket_orders(status);

-- Product indexes
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_stock ON products(stock);

-- Order indexes
CREATE INDEX idx_orders_email ON orders(customer_email);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_stripe_session ON orders(stripe_session_id);

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for auto-updating updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_staff_updated_at BEFORE UPDATE ON staff
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_events_updated_at BEFORE UPDATE ON events
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_shifts_updated_at BEFORE UPDATE ON shifts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_ticket_orders_updated_at BEFORE UPDATE ON ticket_orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
