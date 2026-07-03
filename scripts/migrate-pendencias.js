#!/usr/bin/env node
/**
 * Aplica scripts/atualizar-banco.sql no Postgres.
 * Uso: DATABASE_URL='postgresql://...' node scripts/migrate-pendencias.js
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const url = process.env.DATABASE_URL;
if (!url || /\[SUA-SENHA\]|\[REF\]|\[YOUR-PASSWORD\]/i.test(url)) {
  console.error("Defina DATABASE_URL com a senha real do pooler Supabase (leopardo).");
  process.exit(1);
}

const sql = fs.readFileSync(path.join(__dirname, "atualizar-banco.sql"), "utf8");
const pool = new Pool({
  connectionString: url,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
});

(async () => {
  const client = await pool.connect();
  try {
    await client.query(sql);
    const { rows } = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('admin_chamados', 'tokens_recuperacao', 'matriculas_bloqueadas')
      ORDER BY 1`);
    console.log("OK — tabelas presentes:", rows.map((r) => r.table_name).join(", "));
    const users = await client.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE email IS NOT NULL AND email <> '')::int AS com_email,
             COUNT(*) FILTER (WHERE projeto_id IS NOT NULL)::int AS com_projeto
      FROM usuarios WHERE COALESCE(ativo, TRUE)`);
    console.log("Usuários:", users.rows[0]);
    const chamados = await client.query(
      "SELECT COUNT(*)::int AS pendentes FROM admin_chamados WHERE status = 'pendente'"
    );
    console.log("Chamados admin pendentes:", chamados.rows[0].pendentes);
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error("Falha:", e.message);
  process.exit(1);
});
