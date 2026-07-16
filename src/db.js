// Pool do PostgreSQL (Supabase Session pooler) + fuso da sessão.
require("dotenv").config();
const { Pool } = require("pg");
const { FUSO_APP } = require("./config");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 10,                        // não subir: o Session pooler do Supabase tem teto próprio
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // falha rápido em vez de enfileirar para sempre
});

pool.on("connect", (client) => {
  client.query(`SET TIME ZONE '${FUSO_APP.replace(/'/g, "")}'`).catch(() => {});
});


module.exports = {
  pool,
};
