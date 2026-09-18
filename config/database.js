const { Pool } = require('pg');
require('dotenv').config();

function buildPoolConfig() {
  // Prefer separate vars when set — avoids URL-encoding issues with @ # / in passwords
  if (process.env.DB_HOST || process.env.DB_USER || process.env.DB_NAME) {
    const password = process.env.DB_PASSWORD;
    if (password === undefined || password === null) {
      console.warn('Warning: DB_PASSWORD is not set');
    }
    return {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER || 'postgres',
      password: password == null ? '' : String(password),
      database: process.env.DB_NAME || 'integriti_helpdesk',
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    };
  }

  if (!process.env.DATABASE_URL) {
    console.warn('Warning: DATABASE_URL is not set');
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    };
  }

  // Parse URL so password is always a real string (fixes SASL "password must be a string")
  try {
    const raw = process.env.DATABASE_URL;
    const u = new URL(raw);
    return {
      host: u.hostname || 'localhost',
      port: Number(u.port || 5432),
      user: decodeURIComponent(u.username || 'postgres'),
      password: decodeURIComponent(u.password || ''),
      database: (u.pathname || '/integriti_helpdesk').replace(/^\//, '') || 'integriti_helpdesk',
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    };
  } catch (err) {
    console.warn('Could not parse DATABASE_URL, using connectionString:', err.message);
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    };
  }
}

const pool = new Pool(buildPoolConfig());

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error', err);
});

async function testConnection() {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT NOW() AS now, current_database() AS db');
    console.log(`PostgreSQL connected: database "${result.rows[0].db}" at ${result.rows[0].now}`);
    return true;
  } finally {
    client.release();
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  getClient: () => pool.connect(),
  testConnection,
};
