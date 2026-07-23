// Match por proximidade — delega à mesma listagem do mapa (malha + encaixe + filtros).
require("dotenv").config();
const app = require("../app");
const { pool } = require("../db");
const { verificarAuth } = require("../auth");
const { exigirProjeto } = require("../usuarios");
const { listarCaronasParaPassageiro } = require("../services/listagem-caronas");
const { listarPedidosMapaMotorista } = require("../services/listagem-pedidos");

function horariosCompat(h1, h2) {
  if (!h1 || !h2) return true;
  const a = new Date(h1).getTime();
  const b = new Date(h2).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return true;
  return Math.abs(a - b) <= 3600 * 1000;
}

/* ============================ MATCH ============================ */
app.get("/api/caronas/match", verificarAuth, async (req, res) => {
  const { pedido_id } = req.query;
  if (!pedido_id) return res.status(400).json({ error: "pedido_id obrigatório" });
  try {
    const pid = await exigirProjeto(req.user.id, res);
    if (!pid) return;

    const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1", [pedido_id])).rows[0];
    if (!ped) return res.status(404).json({ error: "Pedido não encontrado" });
    if (ped.passageiro_id !== req.user.id) return res.status(403).json({ error: "Pedido de outro usuário" });
    if (ped.destino_lat == null || ped.destino_lng == null) {
      return res.status(400).json({ error: "Pedido sem destino definido" });
    }

    const caronas = await listarCaronasParaPassageiro({
      pid,
      excludeUserId: req.user.id,
      lat: ped.origem_lat,
      lng: ped.origem_lng,
      dest_lat: ped.destino_lat,
      dest_lng: ped.destino_lng,
    });
    res.json(caronas.filter((c) => horariosCompat(c.horario, ped.horario)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar caronas" });
  }
});

app.get("/api/pedidos/match", verificarAuth, async (req, res) => {
  const { carona_id } = req.query;
  if (!carona_id) return res.status(400).json({ error: "carona_id obrigatório" });
  try {
    const pid = await exigirProjeto(req.user.id, res);
    if (!pid) return;

    const car = (await pool.query(
      "SELECT * FROM caronas WHERE id = $1 AND status = 'ativa'",
      [carona_id]
    )).rows[0];
    if (!car) return res.status(404).json({ error: "Carona não encontrada" });
    if (car.motorista_id !== req.user.id) {
      return res.status(403).json({ error: "Carona de outro motorista" });
    }

    const loc = (await pool.query(
      "SELECT lat, lng FROM localizacoes_online WHERE usuario_id = $1 AND disponivel = TRUE",
      [req.user.id]
    )).rows[0];
    const lat = loc?.lat != null ? +loc.lat : +car.origem_lat;
    const lng = loc?.lng != null ? +loc.lng : +car.origem_lng;

    const pedidos = await listarPedidosMapaMotorista({
      pid,
      motoristaId: req.user.id,
      lat,
      lng,
    });
    res.json(
      pedidos.filter((p) => {
        if (p.compat_rota === "none" || !p.compat_rota) return false;
        return horariosCompat(p.horario, car.horario);
      })
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar pedidos" });
  }
});
