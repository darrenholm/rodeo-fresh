const pool = require('./config/database');

async function updateSoldCounts() {
  try {
    console.log('📊 Counting sold tickets...');
    
    // Count tickets for Saturday Rodeo
    const saturdayCount = await pool.query(
      `SELECT COUNT(*) as count FROM ticket_orders WHERE event_id = '696bb80b79d792d4580e5de7'`
    );
    
    const saturdaySold = parseInt(saturdayCount.rows[0].count);
    console.log(`Saturday Rodeo: ${saturdaySold} tickets sold`);
    
    // Count tickets for Sunday Rodeo
    const sundayCount = await pool.query(
      `SELECT COUNT(*) as count FROM ticket_orders WHERE event_id = '696bb85c206f7ac7afa994bc'`
    );
    
    const sundaySold = parseInt(sundayCount.rows[0].count);
    console.log(`Sunday Rodeo: ${sundaySold} tickets sold`);
    
    // Update Saturday
    await pool.query(
      `UPDATE events SET tickets_sold = $1, tier1_sold = $2 WHERE id = '696bb80b79d792d4580e5de7'`,
      [saturdaySold, saturdaySold]
    );
    
    // Update Sunday
    await pool.query(
      `UPDATE events SET tickets_sold = $1, tier1_sold = $2 WHERE id = '696bb85c206f7ac7afa994bc'`,
      [sundaySold, sundaySold]
    );
    
    console.log('✅ Sold counts updated!');
    console.log(`📊 Saturday: ${saturdaySold} tickets in Tier 1`);
    console.log(`📊 Sunday: ${sundaySold} tickets in Tier 1`);
    
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

updateSoldCounts();
