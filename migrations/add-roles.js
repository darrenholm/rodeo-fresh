// ============================================================
//  ROLE-BASED ACCESS CONTROL (RBAC) — Holmdale Rodeo
//  
//  File 1: migrations/add-roles.js
//  Run once: node migrations/add-roles.js
//
//  Adds multi-role support to the users table.
//  Roles: admin, manager, bartender, gate, food, merch
//  A user can have multiple roles (stored as JSONB array).
// ============================================================

const pool = require('../config/database');

async function addRoles() {
  try {
    console.log('🔧 Adding multi-role support to users table...');

    // Add roles column (JSONB array) — keeps old single `role` column for backward compat
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS roles JSONB DEFAULT '["admin"]'
    `);
    console.log('✅ Added roles column');

    // Migrate existing single role → roles array
    await pool.query(`
      UPDATE users 
      SET roles = CASE 
        WHEN role = 'admin' THEN '["admin"]'::jsonb
        WHEN role = 'staff' THEN '["staff"]'::jsonb
        ELSE '["staff"]'::jsonb
      END
      WHERE roles IS NULL OR roles = '["admin"]'::jsonb
    `);
    console.log('✅ Migrated existing roles');

    // Show current users and roles
    const { rows } = await pool.query('SELECT email, role, roles FROM users ORDER BY email');
    console.log('\n📋 Current users:');
    rows.forEach(u => {
      console.log(`  ${u.email} — old: ${u.role} → new: ${JSON.stringify(u.roles)}`);
    });

    console.log('\n🎉 ROLES MIGRATION COMPLETE!');
    console.log('Valid roles: admin, manager, staff');

    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

addRoles();
