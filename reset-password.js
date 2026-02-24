const pool = require('./config/database');
const bcrypt = require('bcryptjs');

async function resetPassword() {
  try {
    const hash = await bcrypt.hash('changeme123', 10);
    const result = await pool.query(
      'UPDATE users SET password = $1 WHERE email = $2 RETURNING email',
      [hash, 'darren@holmgraphics.ca']
    );
    console.log('✓ Password reset for:', result.rows[0]?.email);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

resetPassword();