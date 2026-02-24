const pool = require('../config/database');

async function addTiers() {
  try {
    console.log('🔧 Adding tier support to events table...');
    
    // Add tier columns
    await pool.query(`
      ALTER TABLE events 
      ADD COLUMN IF NOT EXISTS tier1_adult_price DECIMAL(10, 2) DEFAULT 30.00,
      ADD COLUMN IF NOT EXISTS tier1_family_price DECIMAL(10, 2) DEFAULT 70.00,
      ADD COLUMN IF NOT EXISTS tier1_quantity INTEGER DEFAULT 1000,
      ADD COLUMN IF NOT EXISTS tier1_sold INTEGER DEFAULT 0,
      
      ADD COLUMN IF NOT EXISTS tier2_adult_price DECIMAL(10, 2) DEFAULT 35.00,
      ADD COLUMN IF NOT EXISTS tier2_family_price DECIMAL(10, 2) DEFAULT 75.00,
      ADD COLUMN IF NOT EXISTS tier2_quantity INTEGER DEFAULT 1000,
      ADD COLUMN IF NOT EXISTS tier2_sold INTEGER DEFAULT 0,
      
      ADD COLUMN IF NOT EXISTS tier3_adult_price DECIMAL(10, 2) DEFAULT 40.00,
      ADD COLUMN IF NOT EXISTS tier3_family_price DECIMAL(10, 2) DEFAULT 80.00,
      ADD COLUMN IF NOT EXISTS tier3_quantity INTEGER DEFAULT 1000,
      ADD COLUMN IF NOT EXISTS tier3_sold INTEGER DEFAULT 0,
      
      ADD COLUMN IF NOT EXISTS tickets_sold INTEGER DEFAULT 0
    `);
    
    // Update Saturday Rodeo with current tier data
    await pool.query(`
      UPDATE events 
      SET 
        tier1_adult_price = 30.00,
        tier1_family_price = 70.00,
        tier1_quantity = 1000,
        tier1_sold = 9,
        
        tier2_adult_price = 35.00,
        tier2_family_price = 75.00,
        tier2_quantity = 1000,
        tier2_sold = 0,
        
        tier3_adult_price = 40.00,
        tier3_family_price = 80.00,
        tier3_quantity = 1000,
        tier3_sold = 0,
        
        tickets_sold = 9
      WHERE id = '696bb80b79d792d4580e5de7'
    `);
    
    // Update Sunday Rodeo with same tier data
    await pool.query(`
      UPDATE events 
      SET 
        tier1_adult_price = 30.00,
        tier1_family_price = 70.00,
        tier1_quantity = 1000,
        tier1_sold = 0,
        
        tier2_adult_price = 35.00,
        tier2_family_price = 75.00,
        tier2_quantity = 1000,
        tier2_sold = 0,
        
        tier3_adult_price = 40.00,
        tier3_family_price = 80.00,
        tier3_quantity = 1000,
        tier3_sold = 0,
        
        tickets_sold = 0
      WHERE id = '696bb85c206f7ac7afa994bc'
    `);
    
    console.log('✅ Tier support added successfully!');
    console.log('📊 Saturday Rodeo: 9 tickets sold (Tier 1)');
    console.log('📊 Sunday Rodeo: 0 tickets sold (Tier 1)');
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

addTiers();
```

**Commit:** "Fix migration - remove child_price references"

---

## 🚀 **Then It Should Work**

Railway will auto-redeploy and you should see:
```
✅ Tier support added successfully!
