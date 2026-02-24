const pool = require('./config/database');

async function setupDrinks() {
  try {
    console.log('🍺 Setting up drink inventory system...');
    
    // Create drinks table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS drinks (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        price DECIMAL(10,2) DEFAULT 7.00,
        stock_quantity INTEGER DEFAULT 0,
        stock_remaining INTEGER DEFAULT 0,
        total_sold INTEGER DEFAULT 0,
        active BOOLEAN DEFAULT true,
        created_date TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Drinks table created');

    // Add drink_name to bar_transactions
    await pool.query(`
      ALTER TABLE bar_transactions 
      ADD COLUMN IF NOT EXISTS drink_name VARCHAR(255)
    `);
    console.log('✅ Bar transactions updated');

    // Insert initial test drinks
    const drinks = [
      { id: 'drink_coors_light', name: 'Coors Light', stock: 100 },
      { id: 'drink_coors_banquet', name: 'Coors Banquet', stock: 80 },
      { id: 'drink_molson_export', name: 'Molson Export', stock: 75 },
      { id: 'drink_rum', name: 'Rum', stock: 50 },
      { id: 'drink_rye', name: 'Rye', stock: 50 },
      { id: 'drink_vodka', name: 'Vodka', stock: 60 },
      { id: 'drink_twisted_tea', name: 'Twisted Tea', stock: 90 }
    ];

    for (const drink of drinks) {
      await pool.query(`
        INSERT INTO drinks (id, name, stock_quantity, stock_remaining, price)
        VALUES ($1, $2, $3, $3, 7.00)
        ON CONFLICT (id) DO NOTHING
      `, [drink.id, drink.name, drink.stock]);
      console.log(`✅ Added: ${drink.name}`);
    }

    console.log('');
    console.log('🎉 DRINK INVENTORY SYSTEM READY!');
    console.log('✅ Drinks table created');
    console.log('✅ 7 test drinks added');
    console.log('✅ Bar transactions updated');
    
    await pool.end();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

setupDrinks();
