const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'swim_attendance',
  password: '11111111',
  port: 5432,
});

pool.query('SELECT NOW()')
  .then(res => {
    console.log('SUCCESS! Connected. Server time:', res.rows[0].now);
    pool.end();
  })
  .catch(err => {
    console.error('CONNECTION FAILED:', err.message);
    pool.end();
  });