-- Drop old trigger function
DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;

-- Create correct trigger function
CREATE OR REPLACE FUNCTION update_updated_date_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_date = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Recreate triggers with correct column name
DROP TRIGGER IF EXISTS update_users_updated_date ON users;
DROP TRIGGER IF EXISTS update_events_updated_date ON events;
DROP TRIGGER IF EXISTS update_ticket_orders_updated_date ON ticket_orders;
DROP TRIGGER IF EXISTS update_staff_updated_date ON staff;
DROP TRIGGER IF EXISTS update_shifts_updated_date ON shifts;
DROP TRIGGER IF EXISTS update_products_updated_date ON products;
DROP TRIGGER IF EXISTS update_orders_updated_date ON orders;
DROP TRIGGER IF EXISTS update_bar_purchases_updated_date ON bar_purchases;

-- Recreate with correct function name
CREATE TRIGGER update_users_updated_date BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_date_column();

CREATE TRIGGER update_events_updated_date BEFORE UPDATE ON events
    FOR EACH ROW EXECUTE FUNCTION update_updated_date_column();

CREATE TRIGGER update_ticket_orders_updated_date BEFORE UPDATE ON ticket_orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_date_column();

CREATE TRIGGER update_staff_updated_date BEFORE UPDATE ON staff
    FOR EACH ROW EXECUTE FUNCTION update_updated_date_column();

CREATE TRIGGER update_shifts_updated_date BEFORE UPDATE ON shifts
    FOR EACH ROW EXECUTE FUNCTION update_updated_date_column();

CREATE TRIGGER update_products_updated_date BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_date_column();

CREATE TRIGGER update_orders_updated_date BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_date_column();

CREATE TRIGGER update_bar_purchases_updated_date BEFORE UPDATE ON bar_purchases
    FOR EACH ROW EXECUTE FUNCTION update_updated_date_column();
