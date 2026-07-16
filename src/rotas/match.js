// Match por proximidade: caronas para um pedido e pedidos para uma carona.
require("dotenv").config();
const app = require("../app");
const { SQL_GPS_FRESH } = require("../config");
const { pool } = require("../db");
const { verificarAuth } = require("../auth");
const { exigirProjeto } = require("../usuarios");
const { haversine, sqlPedidoCombinaComCarona } = require("../geo");

/* ============================ MATCH ============================ */
// Caronas que combinam com um pedido (origem perto E destino perto)
app.get("/api/caronas/match", verificarAuth, async (req, res) => {
  const { pedido_id } = req.query;
  if (!pedido_id) return res.status(400).json({ error: "pedido_id obrigatório" });
  try {
    const pid = await exigirProjeto(req.user.id, res);
    if (!pid) return;

    const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1", [pedido_id])).rows[0];
    if (!ped) return res.status(404).json({ error: "Pedido não encontrado" });
    if (ped.passageiro_id !== req.user.id) return res.status(403).json({ error: "Pedido de outro usuário" });

    const combinaRota = sqlPedidoCombinaComCarona("$1", "$2", "$3", "$4", "c.origem_lat", "c.origem_lng", "c.destino_lat", "c.destino_lng");
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT c.*, u.nome AS motorista_nome, h.placa, h.tag, h.foto_carro_url,
                ${haversine("c.origem_lat", "c.origem_lng", "$1", "$2")} AS dist_origem,
                ${haversine("c.destino_lat", "c.destino_lng", "$3", "$4")} AS dist_destino
         FROM caronas c
         JOIN usuarios u ON c.motorista_id = u.id
         LEFT JOIN habilitacoes_motorista h ON c.habilitacao_id = h.id
         JOIN localizacoes_online lo ON lo.usuario_id = c.motorista_id
           AND lo.disponivel = TRUE
           AND ${SQL_GPS_FRESH.replace("atualizado_em", "lo.atualizado_em")}
         WHERE c.status = 'ativa' AND c.motorista_id <> $5
           AND u.projeto_id = $7
           AND COALESCE(u.ativo, TRUE) = TRUE
           AND c.vagas > 0
           AND (c.horario IS NULL OR $6::timestamp IS NULL
                OR ABS(EXTRACT(EPOCH FROM (c.horario - $6::timestamp))) <= 3600)
       ) s
       WHERE ${combinaRota.replace(/c\./g, "s.")}
       ORDER BY (s.dist_origem + s.dist_destino) ASC
       LIMIT 20`,
      [ped.origem_lat, ped.origem_lng, ped.destino_lat, ped.destino_lng, req.user.id, ped.horario, pid]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar caronas" });
  }
});

// Pedidos que combinam com uma carona (origem perto E destino perto)
app.get("/api/pedidos/match", verificarAuth, async (req, res) => {
  const { carona_id } = req.query;
  if (!carona_id) return res.status(400).json({ error: "carona_id obrigatório" });
  try {
    const pid = await exigirProjeto(req.user.id, res);
    if (!pid) return;

    const car = (await pool.query("SELECT * FROM caronas WHERE id = $1", [carona_id])).rows[0];
    if (!car) return res.status(404).json({ error: "Carona não encontrada" });

    const combinaRota = sqlPedidoCombinaComCarona("p.origem_lat", "p.origem_lng", "p.destino_lat", "p.destino_lng", "$1", "$2", "$3", "$4");
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT p.*, u.nome AS passageiro_nome,
                ${haversine("p.origem_lat", "p.origem_lng", "$1", "$2")} AS dist_origem,
                ${haversine("p.destino_lat", "p.destino_lng", "$3", "$4")} AS dist_destino
         FROM pedidos p
         JOIN usuarios u ON p.passageiro_id = u.id
         WHERE p.status = 'aberto' AND p.passageiro_id <> $5
           AND u.projeto_id = $7
           AND COALESCE(u.ativo, TRUE) = TRUE
           AND (p.horario IS NULL OR $6::timestamp IS NULL
                OR ABS(EXTRACT(EPOCH FROM (p.horario - $6::timestamp))) <= 3600)
       ) s
       WHERE ${combinaRota.replace(/p\./g, "s.")}
       ORDER BY (s.dist_origem + s.dist_destino) ASC
       LIMIT 20`,
      [car.origem_lat, car.origem_lng, car.destino_lat, car.destino_lng, req.user.id, car.horario, pid]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar pedidos" });
  }
});

