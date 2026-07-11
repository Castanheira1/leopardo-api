#!/usr/bin/env node
require("dotenv").config();
const { Pool } = require("pg");
const R = require("../sim-rotina");

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const min = R.minutosAgoraSP();
  const { rows } = await pool.query("SELECT usuario_id FROM sim_frota");
  for (const r of rows) {
    const rot = R.montarRotina(r.usuario_id, []);
    const al = R.faseNoRelogio(rot, min);
    const hub = R.snapRoteavel(al.dest);
    const pos = R.offsetM(hub, 50 + (r.usuario_id % 15) * 18, (r.usuario_id * 29) % 360);
    await pool.query(
      `UPDATE localizacoes_online SET lat = $2, lng = $3, disponivel = TRUE, atualizado_em = NOW()
       WHERE usuario_id = $1`,
      [r.usuario_id, pos.lat.toFixed(6), pos.lng.toFixed(6)]
    );
    await pool.query(
      `UPDATE sim_frota SET dest_lat = $2, dest_lng = $3, b_lat = $2, b_lng = $3 WHERE usuario_id = $1`,
      [r.usuario_id, hub.lat.toFixed(6), hub.lng.toFixed(6)]
    );
  }
  console.log(JSON.stringify({ reposicionados: rows.length, horario_sp: R.fmtMin(min) }));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
