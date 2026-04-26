const pool = require('./config/database');

async function fixTierSold() {
  try {
    console.log('🔧 Updating tier sold counts...');
    
    await pool.query(`
      UPDATE events 
      SET tier1_sold = 1, tickets_sold = 1
      WHERE id = '696bb80b79d792d4580e5de7'
    `);
    
    console.log('✅ Saturday Rodeo: tier1_sold = 1');
    
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

fixTierSold();
