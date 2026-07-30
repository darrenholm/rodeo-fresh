require('dotenv').config();   // standalone runs (onsite Mini PC) get creds from .env; Railway injects env itself
const fs = require('fs');
const pool = require('../config/database');

async function runMigrations() {
  try {
    console.log('🔄 Running database migrations...\n');
    
    const sqlFile = fs.readFileSync('./migrations/001_schema.sql', 'utf8');
    
    await pool.query(sqlFile);
    
    console.log('✅ Migrations completed successfully!\n');
    
    // Create default admin user
    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(process.env.DEFAULT_ADMIN_PASSWORD || 'changeme123', 10);
    
    await pool.query(
      `INSERT INTO users (email, password, name, role, created_at, updated_at)
       VALUES ($1, $2, $3, 'admin', NOW(), NOW())
       ON CONFLICT (email) DO NOTHING`,
      [process.env.DEFAULT_ADMIN_EMAIL || 'darren@holmgraphics.ca', hashedPassword, 'Admin User']
    );
    
    console.log('✅ Default admin user created');
    console.log(`   Email: ${process.env.DEFAULT_ADMIN_EMAIL || 'darren@holmgraphics.ca'}`);
    console.log(`   Password: ${process.env.DEFAULT_ADMIN_PASSWORD || 'changeme123'}`);
    console.log('\n⚠️  Please change this password after first login!\n');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runMigrations();
