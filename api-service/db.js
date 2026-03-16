import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  user: 'user_db_bizzfront',
  host: 'localhost',  // O la IP del servidor
  database: 'gpt',  // Base de datos correcta
  password: '548D466s4@·$-',
  port: 5432,  // Puerto por defecto de PostgreSQL
});

export default pool;
