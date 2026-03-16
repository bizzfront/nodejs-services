const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// ← Aquí se configura el search_path para todas las queries futuras
pool.query(`SET search_path TO public`)
  .then(() => console.log('search_path configurado a public'))
  .catch(err => console.error('Error configurando search_path:', err));

module.exports = pool;