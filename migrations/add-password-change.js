const pool = require('./config/database');
(async () => {
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT true");
  await pool.query("UPDATE users SET must_change_password = false WHERE email = 'darren@holmgraphics.ca'");
  console.log('Added must_change_password column, admin exempted');
  process.exit();
})();
