const { Pool } = require('pg');

// Create PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' 
    ? { rejectUnauthorized: false } 
    : false,
  max: 50, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Event handlers
pool.on('connect', () => {
  console.log('✓ Database connected successfully');
});

// A dropped idle connection or a transient network blip surfaces here. The
// pool discards the broken client and opens a new one on the next query, so
// the process must stay up — exiting turned every Railway network hiccup into
// a crash loop that exhausted the restart budget and left the site down.
pool.on('error', (err) => {
  console.error('Database pool error (recovering):', err.message);
});

// Helper function to run queries
pool.queryAsync = (text, params) => {
  return pool.query(text, params);
};

module.exports = pool;
