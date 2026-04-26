const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function setupShiftAssignments() {
  try {
    console.log('Creating shift_assignments table...');
    
    // Create shift_assignments table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shift_assignments (
        id VARCHAR(255) PRIMARY KEY,
        shift_id VARCHAR(255) NOT NULL,
        staff_id VARCHAR(255) NOT NULL,
        staff_name VARCHAR(255) NOT NULL,
        assigned_date TIMESTAMP DEFAULT NOW(),
        assigned_by VARCHAR(255),
        self_assigned BOOLEAN DEFAULT true,
        notes TEXT,
        UNIQUE(shift_id, staff_id)
      )
    `);
    
    console.log('✅ shift_assignments table created');
    
    // Create index for faster lookups
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_shift_assignments_shift 
      ON shift_assignments(shift_id)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_shift_assignments_staff 
      ON shift_assignments(staff_id)
    `);
    
    console.log('✅ Indexes created');
    console.log('🎉 SHIFT ASSIGNMENTS SYSTEM READY!');
    
    await pool.end();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error setting up shift assignments:', error);
    process.exit(1);
  }
}

setupShiftAssignments();
