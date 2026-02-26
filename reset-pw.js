const pool = require('./config/database');
const bcrypt = require('bcryptjs');
(async () => {
  const hash = await bcrypt.hash('rodeo2026', 10);
  const r = await pool.query('UPDATE users SET password = ' + "'" + hash + "'" + ' WHERE email = ' + "'" + 'darren@holmgraphics.ca' + "'");
  console.log('Updated:', r.rowCount, 'rows');
  process.exit();
})();
