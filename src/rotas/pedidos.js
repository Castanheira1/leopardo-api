// Pedidos de carona: criação (com fila), listagem, edição de agendamento e cancelamento.
require("dotenv").config();
const app = require("../app");
const { RAIO_ONLINE_KM, RAIO_VISIVEL_KM } = require("../config");
const { pool } = require("../db");
const { verificarAuth } = require("../auth");
const { exigirProjeto, projetoDoUsuario } = require("../usuarios");
const { horarioValido } = require("../datas");
const { codigoDoProjeto, compatRotaPassageiro, haversine, locaisDoProjetoCodigo, melhorPontoDeEncaixe, somarDesvioAcumulado } = require("../geo");
const { iniciarFilaPedido } = require("../services/fila");

/* ============================ PEDIDOS ============================ */
app.post("/api/pedidos", verificarAuth, async (req, res) => {
  const {
    origem_texto, origem_lat, origem_lng,
    destino_texto, destino_lat, destino_lng,
    horario, observacao, pessoas,
    selfie_url, selfie_lat, selfie_lng, selfie_em,
    usar_fila,
  } = req.body;
  const nPessoas = Math.min(Math.max(parseInt(pessoas, 10) || 1, 1), 6);

  if (origem_lat == null || origem_lng == null || destino_lat == null || destino_lng == null) {
    return res.status(400).json({ error: "Origem e destino são obrigatórios" });
  }
  if (!selfie_url) return res.status(400).json({ error: "Selfie é obrigatória para pedir carona" });

  try {
    const pid = await exigirProjeto(req.user.id, res);
    if (!pid) return;

    // Pedido imediato cancela só os "ao vivo" (sem horário futuro pendente).
    // Agendamentos futuros continuam válidos — o passageiro pode pedir outra carona agora.
    const hValido = horarioValido(horario);
    let agendadoNovo = false;
    if (hValido) {
      const { rows: chkNovo } = await pool.query(
        "SELECT ($1::timestamp > NOW()) AS futuro", [hValido]
      );
      agendadoNovo = !!chkNovo[0]?.futuro;
    }
    if (agendadoNovo) {
      await pool.query(
        `UPDATE pedidos SET status = 'cancelado'
         WHERE passageiro_id = $1 AND status = 'aberto'
           AND (horario IS NULL OR horario <= NOW())`,
        [req.user.id]
      );
    } else {
      await pool.query(
        `UPDATE pedidos SET status = 'cancelado'
         WHERE passageiro_id = $1 AND status = 'aberto'
           AND (horario IS NULL OR horario <= NOW() OR COALESCE(notificado, FALSE) = TRUE)`,
        [req.user.id]
      );
    }
    const { rows } = await pool.query(
      `INSERT INTO pedidos
         (passageiro_id, origem_texto, origem_lat, origem_lng,
          destino_texto, destino_lat, destino_lng, horario, observacao, pessoas,
          selfie_url, selfie_lat, selfie_lng, selfie_em, notificado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,FALSE)
       RETURNING *, (horario IS NOT NULL AND horario > NOW()) AS agendado_futuro`,
      [
        req.user.id, origem_texto || null, origem_lat, origem_lng,
        destino_texto || null, destino_lat, destino_lng, hValido, observacao || null, nPessoas,
        selfie_url, selfie_lat || null, selfie_lng || null, selfie_em || new Date(),
      ]
    );
    const ped = rows[0];
    // Decisão do agendamento feita no próprio banco (mesmo fuso da sessão, SET TIME
    // ZONE no connect). Antes isto passava a Date do node-pg de volta por
    // horarioValido() e o Postgres rejeitava a string "GMT..." (erro 500 ao agendar).
    const agendadoFuturo = !!ped.agendado_futuro;
    res.json(ped);

    // Pedido "para agora" (sem horário ou horário já vencido): notifica os motoristas
    // perto na hora. Pedido AGENDADO (horário futuro): não notifica agora — o agendador
    // dispara a notificação na hora marcada (notificado continua FALSE até lá).
    if (!agendadoFuturo) {
      // usar_fila: fila EXCLUSIVA clássica (pulso oculto, só o da vez responde).
      // Sem usar_fila (padrão do app): busca inteligente — o pedido vira pulso
      // no mapa de todos, mas o PUSH vai pro melhor motorista de cada vez
      // (rota que cobre a viagem > encaixe por ponto em comum > mais perto),
      // em vez de buzinar pra todo mundo dentro do raio ao mesmo tempo.
      if (usar_fila) await iniciarFilaPedido(ped.id);
      else {
        await iniciarFilaPedido(ped.id, { exclusiva: false });
        await pool.query("UPDATE pedidos SET notificado = TRUE WHERE id = $1", [ped.id]).catch(() => {});
      }
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao criar pedido" });
  }
});

app.get("/api/pedidos", verificarAuth, async (req, res) => {
  const { lat, lng, meus } = req.query;
  try {
    // "meus": pedidos abertos do próprio passageiro (ficam esperando até casar ou
    // serem cancelados). Inclui quantas ofertas de motorista já chegaram.
    if (meus) {
      const { rows } = await pool.query(
        `SELECT p.*,
                (SELECT COUNT(*) FROM propostas pr
                  WHERE pr.pedido_id = p.id AND pr.status = 'pendente') AS ofertas
         FROM pedidos p
         WHERE p.status = 'aberto' AND p.passageiro_id = $1
         ORDER BY p.created_at DESC`,
        [req.user.id]
      );
      return res.json(rows);
    }

    // Com lat/lng (mapa do motorista): pedidos próximos.
    // - Online sem destino (amarelo): raio RAIO_ONLINE_KM (600 m)
    // - Com carona/rota publicada: alcance da barra (carona.raio_km, default 10 km)
    //   — senão o motorista não via o pulso de quem pediu a poucos km.
    if (lat && lng) {
      const pid = await projetoDoUsuario(req.user.id);
      if (!pid) return res.json([]);
      const temCarona = (await pool.query(
        `SELECT raio_km FROM caronas WHERE motorista_id = $1 AND status = 'ativa' LIMIT 1`,
        [req.user.id]
      )).rows[0];
      const raioKm = temCarona ? (Number(temCarona.raio_km) || RAIO_VISIVEL_KM) : RAIO_ONLINE_KM;
      const distOrigem = haversine("p.origem_lat", "p.origem_lng", "$1", "$2");
      const params = [lat, lng, raioKm, pid, req.user.id];
      const { rows } = await pool.query(
        `SELECT * FROM (
           SELECT p.*, u.nome AS passageiro_nome, u.sexo AS passageiro_sexo,
                  ${distOrigem} AS dist_origem
           FROM pedidos p
           JOIN usuarios u ON p.passageiro_id = u.id
           WHERE p.status = 'aberto'
             AND COALESCE(u.ativo, TRUE) = TRUE
             AND (p.horario IS NULL OR p.horario <= NOW())
             -- Solicitação vencida: pedido "para agora" (ou agendado que já disparou)
             -- parado há mais de 30 min é velho — não aparece mais pro motorista.
             AND COALESCE(p.horario, p.created_at) > NOW() - INTERVAL '30 minutes'
             -- Passageiro já embarcado/em viagem: o pedido antigo dele não reaparece.
             AND NOT EXISTS (SELECT 1 FROM viagens v
                             WHERE v.passageiro_id = p.passageiro_id AND v.status = 'em_andamento')
             -- Pedido em busca automática EXCLUSIVA (usar_fila): só o motorista
             -- da vez responde, pelos endpoints /api/pedido-fila. Não vira pulso
             -- no mapa dos outros enquanto a fila está VIVA (aguardando/ofertada).
             -- Fila NÃO-exclusiva (busca inteligente do broadcast) não esconde
             -- nada: o pulso continua para todos.
             AND NOT EXISTS (SELECT 1 FROM pedido_fila f
                             WHERE f.pedido_id = p.id
                               AND f.status IN ('aguardando', 'ofertada')
                               AND f.exclusiva)
             -- Este motorista já recusou: o pulso não volta pra ele (nem após reload).
             AND NOT EXISTS (SELECT 1 FROM pedido_fila fr
                             WHERE fr.pedido_id = p.id
                               AND fr.motorista_id = $5
                               AND fr.status = 'recusada')
             AND u.projeto_id = $4
         ) s
         WHERE s.dist_origem <= $3
         ORDER BY s.dist_origem ASC
         LIMIT 60`,
        params
      );
      const caronaMot = (await pool.query(
        `SELECT origem_lat, origem_lng, destino_lat, destino_lng, destino_texto, rota_pontos
         FROM caronas WHERE motorista_id = $1 AND status = 'ativa'
         ORDER BY created_at DESC LIMIT 1`,
        [req.user.id]
      )).rows[0];
      const codPed = await codigoDoProjeto(pid);
      const locaisEnc = caronaMot?.destino_lat != null
        ? locaisDoProjetoCodigo(codPed)
        : [];
      const caOrigMot = caronaMot
        ? { lat: +caronaMot.origem_lat, lng: +caronaMot.origem_lng }
        : null;
      const caDestMot = caronaMot
        ? { lat: +caronaMot.destino_lat, lng: +caronaMot.destino_lng }
        : null;
      const optsRota = {
        locais: locaisEnc,
        codigo: codPed,
        rota_pontos: caronaMot?.rota_pontos || null,
      };
      // Paradas já a bordo deste motorista (desvio acumulado local).
      let desvioJaMot = 0;
      if (caronaMot && caOrigMot && caDestMot) {
        try {
          const { rows: paradas } = await pool.query(
            `SELECT destino_motorista_lat AS lat, destino_motorista_lng AS lng,
                    destino_motorista_texto AS nome
             FROM viagens
             WHERE motorista_id = $1 AND status = 'em_andamento'
               AND destino_motorista_lat IS NOT NULL`,
            [req.user.id]
          );
          desvioJaMot = somarDesvioAcumulado(caOrigMot, caDestMot, paradas.map((x) => ({
            lat: Number(x.lat), lng: Number(x.lng), nome: x.nome || null,
          })), optsRota);
        } catch (_) { /* coluna ausente em ambientes antigos */ }
      }
      const enriquecido = rows.map((p) => {
        if (!caronaMot?.destino_lat || p.destino_lat == null) return p;
        const compat = compatRotaPassageiro(
          p.destino_lat, p.destino_lng,
          caronaMot.origem_lat, caronaMot.origem_lng,
          caronaMot.destino_lat, caronaMot.destino_lng,
          optsRota
        );
        // Destino "não bate" mas a rota do motorista passa por um ponto em comum
        // que adianta o passageiro: o pulso mostra até onde dá pra levar.
        if (compat === "none" && p.origem_lat != null) {
          const enc = melhorPontoDeEncaixe(
            { lat: +p.origem_lat, lng: +p.origem_lng },
            { lat: +p.destino_lat, lng: +p.destino_lng },
            caOrigMot, caDestMot,
            { ...optsRota, desvio_acumulado_km: desvioJaMot }
          );
          if (enc) {
            return {
              ...p,
              compat_rota: "encaixe",
              destino_motorista_texto: caronaMot.destino_texto,
              encaixe_texto: enc.nome || caronaMot.destino_texto || null,
              encaixe_lat: enc.lat,
              encaixe_lng: enc.lng,
            };
          }
        }
        return {
          ...p,
          compat_rota: compat,
          destino_motorista_texto: caronaMot.destino_texto,
        };
      });
      return res.json(enriquecido);
    }

    const pid = await projetoDoUsuario(req.user.id);
    if (!pid) return res.json([]);
    const params = [pid, req.user.id];
    const filtroProj = `AND u.projeto_id = $1`;
    const { rows } = await pool.query(
      `SELECT p.*, u.nome AS passageiro_nome, u.sexo AS passageiro_sexo
       FROM pedidos p
       JOIN usuarios u ON p.passageiro_id = u.id
       WHERE p.status = 'aberto'
         AND COALESCE(u.ativo, TRUE) = TRUE
         AND (p.horario IS NULL OR p.horario <= NOW())
         -- Mesmas regras do mapa: sem solicitação vencida (30 min), sem pedido de
         -- passageiro já em viagem, e sem pedido em fila EXCLUSIVA viva
         -- (fila esgotada devolve o pedido à lista; fila não-exclusiva não esconde).
         AND COALESCE(p.horario, p.created_at) > NOW() - INTERVAL '30 minutes'
         AND NOT EXISTS (SELECT 1 FROM viagens v
                         WHERE v.passageiro_id = p.passageiro_id AND v.status = 'em_andamento')
         AND NOT EXISTS (SELECT 1 FROM pedido_fila f
                         WHERE f.pedido_id = p.id
                           AND f.status IN ('aguardando', 'ofertada')
                           AND f.exclusiva)
         -- Quem já recusou não vê o pedido de novo.
         AND NOT EXISTS (SELECT 1 FROM pedido_fila fr
                         WHERE fr.pedido_id = p.id
                           AND fr.motorista_id = $2
                           AND fr.status = 'recusada')
         ${filtroProj}
       ORDER BY p.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar pedidos" });
  }
});

app.delete("/api/pedidos/:id", verificarAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE pedidos SET status = 'cancelado'
       WHERE id = $1 AND passageiro_id = $2 AND status = 'aberto'`,
      [req.params.id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: "Pedido não encontrado" });
    // Libera quem ofereceu: as propostas pendentes deste pedido caem para recusado,
    // assim o motorista não fica preso na tela "Aguardando aceitar".
    await pool.query(
      `UPDATE propostas SET status = 'recusado'
       WHERE pedido_id = $1 AND status = 'pendente'`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao cancelar pedido" });
  }
});

// Editar agendamento futuro (horário / pessoas) antes de entrar no ar.
app.patch("/api/pedidos/:id", verificarAuth, async (req, res) => {
  const { horario, pessoas } = req.body || {};
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Pedido inválido" });
  try {
    const atual = (await pool.query(
      "SELECT * FROM pedidos WHERE id = $1 AND passageiro_id = $2 AND status = 'aberto'",
      [id, req.user.id]
    )).rows[0];
    if (!atual) return res.status(404).json({ error: "Pedido não encontrado" });
    const { rows: chk } = await pool.query(
      `SELECT (horario IS NOT NULL AND horario > NOW()) AS futuro,
              COALESCE(notificado, FALSE) AS notificado
       FROM pedidos WHERE id = $1`,
      [id]
    );
    if (!chk[0]?.futuro || chk[0].notificado) {
      return res.status(400).json({
        error: "Só é possível editar agendamentos futuros que ainda não entraram no ar.",
      });
    }
    const hNovo = horario !== undefined ? horarioValido(horario) : atual.horario;
    if (horario !== undefined && horario && !hNovo) {
      return res.status(400).json({ error: "Horário inválido" });
    }
    if (hNovo) {
      const { rows: fut } = await pool.query(
        "SELECT ($1::timestamp > NOW()) AS ok", [hNovo]
      );
      if (!fut[0]?.ok) return res.status(400).json({ error: "Escolha um horário futuro" });
    }
    const nPessoas = pessoas !== undefined
      ? Math.min(Math.max(parseInt(pessoas, 10) || 1, 1), 6)
      : atual.pessoas;
    const { rows } = await pool.query(
      `UPDATE pedidos SET horario = $1, pessoas = $2, notificado = FALSE
       WHERE id = $3
       RETURNING *, (horario IS NOT NULL AND horario > NOW()) AS agendado_futuro`,
      [hNovo, nPessoas, id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao atualizar pedido" });
  }
});

