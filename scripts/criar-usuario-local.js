#!/usr/bin/env node
/** Cria/atualiza usuário de teste local. Uso: node scripts/criar-usuario-local.js */
require("dotenv").config();
const bcrypt = require("bcrypt");
const { Pool } = require("pg");

const matricula = process.env.USER_MATRICULA || "111111";
const senha = process.env.USER_SENHA || "123456";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL ausente");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const hash = await bcrypt.hash(senha, 10);
    const proj = await pool.query("SELECT id FROM projetos WHERE codigo = 'S11D' LIMIT 1");
    const pid = proj.rows[0]?.id;
    if (!pid) throw new Error("projeto S11D não encontrado");

    const { rows } = await pool.query(
      `INSERT INTO usuarios (
         nome, funcao, matricula, telefone, email, senha_hash, is_admin, sexo,
         empresa_nome, projeto_id, ativo, politica_aceita_em, politica_versao
       ) VALUES ($1, $2, $3, $4, $5, $6, FALSE, 'M', $7, $8, TRUE, NOW(), '1.0')
       ON CONFLICT (matricula) DO UPDATE SET
         senha_hash = EXCLUDED.senha_hash,
         nome = EXCLUDED.nome,
         ativo = TRUE,
         politica_aceita_em = COALESCE(usuarios.politica_aceita_em, NOW()),
         projeto_id = EXCLUDED.projeto_id
       RETURNING id, matricula, nome`,
      [
        "Usuario Teste",
        "Colaborador",
        matricula,
        "94999990000",
        "teste@local.dev",
        hash,
        "Vale S.A.",
        pid,
      ]
    );

    let loginOk = false;
    try {
      const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matricula, senha }),
      });
      loginOk = r.ok;
    } catch {
      /* servidor pode estar offline; conta já está no banco */
    }

    console.log(
      JSON.stringify(
        {
          criado: rows[0],
          matricula,
          senha,
          login_api: loginOk ? "ok" : "nao_testado_ou_falhou",
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
