require('dotenv').config();
const { Pool } = require('pg');

const usingDatabaseUrl = Boolean(process.env.DATABASE_URL);

if (!usingDatabaseUrl && typeof process.env.DB_PASSWORD !== 'string') {
  // If this fires, dotenv did not load your .env file (wrong filename,
  // wrong working directory, or the file is missing). Without this check,
  // pg fails later with a much more confusing error:
  // "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string"
  throw new Error(
    'DB_PASSWORD is not set. Make sure a file named exactly ".env" ' +
    '(not "_env" or ".env.txt") exists in the same folder you run ' +
    '"node server.js" from, and that it defines DB_PASSWORD.'
  );
}

console.log(
  usingDatabaseUrl
    ? 'db.js: connecting using DATABASE_URL'
    : `db.js: connecting using local config (host=${process.env.DB_HOST || 'localhost'}, db=${process.env.DB_NAME || 'swim_attendance'})`
);

const pool = new Pool(
  usingDatabaseUrl
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
      }
    : {
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'swim_attendance',
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT || 5432,
        ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false
      }
);

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client:', err);
});

module.exports = pool;
