const pool = require('./config/database');

async function dropTriggers() {
  try {
    console.log('🔧 Dropping problematic triggers...');
    
    await pool.query('DROP TRIGGER IF EXISTS update_users_updated_date ON users CASCADE');
    await pool.query('DROP TRIGGER IF EXISTS update_events_updated_date ON events CASCADE');
    await pool.query('DROP TRIGGER IF EXISTS update_ticket_orders_updated_date ON ticket_orders CASCADE');
    await pool.query('DROP TRIGGER IF EXISTS update_staff_updated_date ON staff CASCADE');
    await pool.query('DROP TRIGGER IF EXISTS update_shifts_updated_date ON shifts CASCADE');
    await pool.query('DROP TRIGGER IF EXISTS update_products_updated_date ON products CASCADE');
    await pool.query('DROP TRIGGER IF EXISTS update_orders_updated_date ON orders CASCADE');
    await pool.query('DROP TRIGGER IF EXISTS update_bar_purchases_updated_date ON bar_purchases CASCADE');
    await pool.query('DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE');
    await pool.query('DROP FUNCTION IF EXISTS update_updated_date_column() CASCADE');
    
    console.log('✅ All triggers dropped successfully!');
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

dropTriggers();
