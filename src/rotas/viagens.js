// Viagens: iniciar, pontos GPS, localização ao vivo, embarque, finalizar e histórico.
require("dotenv").config();
const app = require("../app");
const { KM_MINIMO_VIAGEM, RAIO_CHEGADA_DEST_KM } = require("../config");
const { pool } = require("../db");
const { verificarAuth } = require("../auth");
const { haversineKmCoord } = require("../geo");
const { calcularKmGpsViagem, resolverKmMedicaoViagem } = require("../km");
const { cancelarViagemAtiva, criarViagemDaProposta } = require("../services/viagens");
const { emitViagemMeta } = require("../realtime");

/* ============================ VIAGENS ============================ */
// Inicia a viagem a partir de uma proposta aceita (apenas o motorista inicia)
app.post("/api/viagens", verificarAuth, async (req, res) => {
  const { proposta_id } = req.body;
  if (!proposta_id) return res.status(400).json({ error: "proposta_id obrigatório" });

  try {
    const pr = (await pool.query("SELECT * FROM propostas WHERE id = $1 AND status = 'aceito'", [proposta_id])).rows[0];
    if (!pr) return res.status(404).json({ error: "Proposta não aceita ou inexistente" });

    // Só o motorista (lado que oferece o carro) pode iniciar manualmente.
    const motorista_id = pr.carona_id ? pr.para_usuario_id : pr.de_usuario_id;
    if (req.user.id !== motorista_id) {
      return res.status(403).json({ error: "Apenas o motorista inicia a viagem" });
    }

    const viagem = await criarViagemDaProposta(proposta_id);
    if (!viagem) return res.status(404).json({ error: "Proposta não aceita ou inexistente" });
    emitViagemMeta(viagem.id, { status: viagem.status, fase: viagem.fase });
    res.json(viagem);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao iniciar viagem" });
  }
});

// Recebe lote de pontos GPS durante o trajeto (rastreamento ao vivo)
app.post("/api/viagens/:id/pontos", verificarAuth, async (req, res) => {
  const { pontos } = req.body;
  if (!Array.isArray(pontos) || pontos.length === 0) return res.status(400).json({ error: "Sem pontos" });

  try {
    const v = (await pool.query("SELECT * FROM viagens WHERE id = $1", [req.params.id])).rows[0];
    if (!v) return res.status(404).json({ error: "Viagem não encontrada" });
    if (![v.motorista_id, v.passageiro_id].includes(req.user.id)) {
      return res.status(403).json({ error: "Sem permissão" });
    }

    const values = [];
    const params = [];
    const agora = Date.now();
    pontos.slice(0, 500).forEach((p, i) => {
      const base = i * 4;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      params.push(req.params.id, p.lat, p.lng);
      const emMs = Number(p.em);
      let em = new Date();
      if (Number.isFinite(emMs) && emMs > 0) {
        const candidato = new Date(emMs);
        if (candidato.getTime() <= agora + 60000 && candidato.getTime() >= agora - 86400000) {
          em = candidato;
        }
      }
      params.push(em);
    });

    await pool.query(
      `INSERT INTO viagem_pontos (viagem_id, lat, lng, registrado_em) VALUES ${values.join(",")}`,
      params
    );
    res.json({ success: true, gravados: Math.min(pontos.length, 500) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao gravar rota" });
  }
});


// Posição ao vivo do motorista de uma viagem (passageiro acompanha o carro).
app.get("/api/viagens/:id/localizacao", verificarAuth, async (req, res) => {
  try {
    const v = (await pool.query(
      `SELECT v.motorista_id, v.passageiro_id, v.fase, v.status,
              m.sexo AS motorista_sexo, pa.sexo AS passageiro_sexo
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       JOIN usuarios pa ON v.passageiro_id = pa.id
       WHERE v.id = $1`, [req.params.id]
    )).rows[0];
    if (!v) return res.status(404).json({ error: "Viagem não encontrada" });
    if (!req.user.is_admin && ![v.motorista_id, v.passageiro_id].includes(req.user.id)) {
      return res.status(403).json({ error: "Sem permissão" });
    }
    // Posição ao vivo dos dois lados (cada um transmite a sua) para que um veja o outro.
    const locs = (await pool.query(
      "SELECT usuario_id, lat, lng, speed_kmh FROM localizacoes_online WHERE usuario_id = ANY($1)",
      [[v.motorista_id, v.passageiro_id]]
    )).rows;
    const posDe = (id) => {
      const l = locs.find((x) => x.usuario_id === id);
      if (!l) return null;
      const out = { lat: l.lat, lng: l.lng };
      if (l.speed_kmh != null && Number.isFinite(+l.speed_kmh)) out.speed_kmh = +l.speed_kmh;
      return out;
    };
    // Sempre devolve fase/status (o passageiro reage à mudança), mesmo sem posição ainda.
    // `lat/lng` no topo = posição do motorista (compatível com versões antigas do app).
    const motorista = posDe(v.motorista_id);
    res.json({
      ...(motorista || {}),
      motorista, passageiro: posDe(v.passageiro_id),
      motorista_sexo: v.motorista_sexo, passageiro_sexo: v.passageiro_sexo,
      fase: v.fase, status: v.status,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao obter localização" });
  }
});

// Motorista chegou ao passageiro e embarcou: muda a fase para 'destino'.
app.post("/api/viagens/:id/iniciar", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE viagens SET fase = 'destino', embarque_em = COALESCE(embarque_em, NOW())
       WHERE id = $1 AND motorista_id = $2 AND status = 'em_andamento'
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Viagem não encontrada" });
    await pool.query(
      `DELETE FROM viagem_pontos vp
       WHERE vp.viagem_id = $1
         AND vp.registrado_em < (SELECT embarque_em FROM viagens WHERE id = $1)`,
      [req.params.id]
    );
    emitViagemMeta(rows[0].id, { status: rows[0].status, fase: rows[0].fase });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao iniciar a viagem" });
  }
});

app.post("/api/viagens/:id/finalizar", verificarAuth, async (req, res) => {
  try {
    const v = (await pool.query("SELECT * FROM viagens WHERE id = $1", [req.params.id])).rows[0];
    if (!v) return res.status(404).json({ error: "Viagem não encontrada" });
    if (req.user.id !== v.motorista_id) return res.status(403).json({ error: "Apenas o motorista finaliza" });

    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    const temPos = Number.isFinite(lat) && Number.isFinite(lng);
    let noDestino = false;
    if (temPos && v.destino_lat != null && v.destino_lng != null) {
      noDestino = haversineKmCoord(lat, lng, +v.destino_lat, +v.destino_lng) <= RAIO_CHEGADA_DEST_KM;
    }
    if (req.body?.automatico) {
      if (!noDestino) {
        return res.status(400).json({ error: "Finalização automática só quando o GPS reconhece o destino." });
      }
    }

    const calc = await calcularKmGpsViagem(req.params.id, {
      desde: v.embarque_em || undefined,
    }).catch((err) => {
      console.error("calcularKmGpsViagem falhou (finalizar segue):", err?.message || err);
      return { km: 0, kmBruto: 0, valido: false };
    });
    const med = resolverKmMedicaoViagem(v, calc, req.body?.km_maps, req.body?.km_tela, { noDestino });
    if (!med.valido && noDestino && med.km > 0) {
      med.valido = med.km >= KM_MINIMO_VIAGEM;
    }
    const { rows } = await pool.query(
      `UPDATE viagens SET status = 'concluida', finalizada_em = NOW(),
              distancia_km = $2, deslocamento_valido = $3,
              km_maps = $4, km_tela = $5, km_fonte = $6
       WHERE id = $1 RETURNING *`,
      [req.params.id, med.km, med.valido, med.km_maps, med.km_tela, med.fonte]
    );
    emitViagemMeta(rows[0].id, { status: rows[0].status, fase: rows[0].fase || "destino" });
    res.json({
      ...rows[0],
      deslocamento_valido: med.valido,
      km_bruto: calc.kmBruto,
      km_fonte: med.fonte,
      chegada_destino: noDestino,
      finalizacao_automatica: !!req.body?.automatico,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao finalizar viagem" });
  }
});

// Motorista ou passageiro podem encerrar viagem presa (em_andamento) quando
// finalizar/cancelar proposta não funciona mais (ex.: fase destino).
app.post("/api/viagens/:id/cancelar", verificarAuth, async (req, res) => {
  try {
    const r = await cancelarViagemAtiva(+req.params.id, req.user.id);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    if (r.viagem) {
      emitViagemMeta(r.viagem.id || req.params.id, {
        status: r.viagem.status || "cancelada",
        fase: r.viagem.fase,
      });
    }
    res.json({ success: true, viagem: r.viagem });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao encerrar viagem" });
  }
});

app.get("/api/viagens", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.*, m.nome AS motorista_nome, pa.nome AS passageiro_nome,
              (SELECT COUNT(*) FROM viagem_pontos vp WHERE vp.viagem_id = v.id) AS qtd_pontos
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       JOIN usuarios pa ON v.passageiro_id = pa.id
       WHERE v.motorista_id = $1 OR v.passageiro_id = $1
       ORDER BY v.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar viagens" });
  }
});

app.get("/api/viagens/:id", verificarAuth, async (req, res) => {
  try {
    const v = (await pool.query(
      `SELECT v.*, m.nome AS motorista_nome, m.telefone AS motorista_telefone, m.sexo AS motorista_sexo,
              pa.nome AS passageiro_nome, pa.telefone AS passageiro_telefone, pa.sexo AS passageiro_sexo,
              h.placa, h.tag, h.foto_carro_url, h.foto_carro_em,
              h.selfie_url AS motorista_selfie, h.selfie_em AS motorista_selfie_em,
              pr.selfie_url AS passageiro_selfie, pr.selfie_em AS passageiro_selfie_em,
              pd.selfie_url AS pedido_selfie, pd.selfie_em AS pedido_selfie_em,
              -- Destino FINAL do motorista (rota publicada): a viagem é uma parada
              -- no caminho dele — o mapa desenha a "rota única com parada" até lá.
              cfinal.destino_texto AS motorista_destino_final_texto,
              cfinal.destino_lat AS motorista_destino_final_lat,
              cfinal.destino_lng AS motorista_destino_final_lng,
              -- Partida do motorista (origem da rota publicada) — pino no mapa.
              cfinal.origem_texto AS motorista_partida_texto,
              cfinal.origem_lat AS motorista_partida_lat,
              cfinal.origem_lng AS motorista_partida_lng
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       JOIN usuarios pa ON v.passageiro_id = pa.id
       LEFT JOIN habilitacoes_motorista h ON v.habilitacao_id = h.id
       LEFT JOIN propostas pr ON v.proposta_id = pr.id
       LEFT JOIN pedidos pd ON v.pedido_id = pd.id
       LEFT JOIN LATERAL (
         SELECT c.destino_texto, c.destino_lat, c.destino_lng,
                c.origem_texto, c.origem_lat, c.origem_lng
         FROM caronas c
         WHERE c.id = v.carona_id
            OR (c.motorista_id = v.motorista_id AND c.status = 'ativa')
         ORDER BY (c.id = v.carona_id) DESC, c.created_at DESC
         LIMIT 1
       ) cfinal ON TRUE
       WHERE v.id = $1`,
      [req.params.id]
    )).rows[0];

    if (!v) return res.status(404).json({ error: "Viagem não encontrada" });
    if (!req.user.is_admin && ![v.motorista_id, v.passageiro_id].includes(req.user.id)) {
      return res.status(403).json({ error: "Sem permissão" });
    }

    // Decima o trajeto para no máx. ~500 pontos (mantendo sempre o primeiro e o
    // último) — viagens longas geram milhares de pontos e o traçado não precisa.
    const pontos = (await pool.query(
      `SELECT lat, lng, registrado_em FROM (
         SELECT lat, lng, registrado_em,
                ROW_NUMBER() OVER (ORDER BY registrado_em ASC) AS rn,
                COUNT(*) OVER () AS total
         FROM viagem_pontos WHERE viagem_id = $1
       ) s
       WHERE (s.rn - 1) % GREATEST(1, CEIL(s.total / 500.0)::int) = 0 OR s.rn = s.total
       ORDER BY s.registrado_em ASC`,
      [req.params.id]
    )).rows;

    res.json({ ...v, pontos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao carregar viagem" });
  }
});

