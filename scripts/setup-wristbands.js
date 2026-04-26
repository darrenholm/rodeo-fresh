const pool = require('./config/database');

async function setupWristbands() {
  try {
    console.log('🔧 Setting up wristbands database...');
    
    // Create wristbands table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wristbands (
        id VARCHAR(255) PRIMARY KEY,
        rfid_uid VARCHAR(255) UNIQUE NOT NULL,
        ticket_order_id VARCHAR(255) REFERENCES ticket_orders(id),
        customer_name VARCHAR(255),
        customer_email VARCHAR(255),
        ticket_type VARCHAR(50),
        alcohol_approved BOOLEAN DEFAULT false,
        credits DECIMAL(10,2) DEFAULT 0.00,
        credits_spent DECIMAL(10,2) DEFAULT 0.00,
        created_date TIMESTAMP DEFAULT NOW(),
        approved_date TIMESTAMP,
        approved_by VARCHAR(255),
        notes TEXT
      )
    `);
    console.log('✅ Wristbands table created');

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_wristbands_rfid ON wristbands(rfid_uid)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_wristbands_ticket ON wristbands(ticket_order_id)
    `);
    console.log('✅ Wristband indexes created');

    // Create bar transactions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bar_transactions (
        id VARCHAR(255) PRIMARY KEY,
        wristband_id VARCHAR(255) REFERENCES wristbands(id),
        amount DECIMAL(10,2) NOT NULL,
        transaction_type VARCHAR(50) NOT NULL,
        description TEXT,
        created_date TIMESTAMP DEFAULT NOW(),
        created_by VARCHAR(255)
      )
    `);
    console.log('✅ Bar transactions table created');

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_bar_transactions_wristband ON bar_transactions(wristband_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_bar_transactions_date ON bar_transactions(created_date)
    `);
    console.log('✅ Bar transaction indexes created');

    // Add role to users
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'staff'
    `);
    console.log('✅ User role column added');

    // Make you admin
    await pool.query(`
      UPDATE users SET role = 'admin' WHERE email = 'darren@holmgraphics.ca'
    `);
    console.log('✅ Admin role set for darren@holmgraphics.ca');

    // Link staff to users
    await pool.query(`
      ALTER TABLE staff ADD COLUMN IF NOT EXISTS user_id VARCHAR(255)
    `);
    console.log('✅ Staff user_id column added');

    console.log('');
    console.log('🎉 DATABASE SETUP COMPLETE!');
    console.log('✅ Wristbands table ready');
    console.log('✅ Bar transactions table ready');
    console.log('✅ User roles configured');
    
    await pool.end();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

setupWristbands();
