// Endpoints da fila: oferta atual, aceitar/recusar, status pro passageiro e reoferta.
require("dotenv").config();
const app = require("../app");
const { pool } = require("../db");
const { enviarPush } = require("../push");
const { verificarAuth } = require("../auth");
const { projetoDoUsuario } = require("../usuarios");
const { criarViagemDaProposta } = require("../services/viagens");
const { contarMotoristasOnline, ofertarProximo } = require("../services/fila");

// Motorista consulta a oferta ativa dele na fila (se houver), com dados do
// pedido e o prazo pra responder — alimenta o cronômetro no app.
app.get("/api/motorista/oferta-atual", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.id, f.ordem, f.dist_km, f.ofertada_em, f.expira_em,
              f.encaixe_texto, f.encaixe_lat, f.encaixe_lng, f.exclusiva,
              p.id AS pedido_id, p.origem_texto, p.origem_lat, p.origem_lng,
              p.destino_texto, p.destino_lat, p.destino_lng, p.pessoas, p.observacao,
              u.nome AS passageiro_nome
       FROM pedido_fila f
       JOIN pedidos p ON p.id = f.pedido_id
       JOIN usuarios u ON u.id = p.passageiro_id
       WHERE f.motorista_id = $1 AND f.status = 'ofertada' AND p.status = 'aberto'
       ORDER BY f.ofertada_em DESC LIMIT 1`,
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao consultar oferta" });
  }
});

// Motorista aceita a oferta da fila: cria a proposta (já aceita) + a viagem
// reaproveitando o mesmo caminho de sempre, e trava as demais posições da fila.
app.post("/api/pedido-fila/:id/aceitar", verificarAuth, async (req, res) => {
  try {
    const oferta = (await pool.query(
      `UPDATE pedido_fila SET status = 'aceita', respondida_em = NOW()
       WHERE id = $1 AND motorista_id = $2 AND status = 'ofertada' AND expira_em > NOW()
       RETURNING *`,
      [req.params.id, req.user.id]
    )).rows[0];
    if (!oferta) return res.status(404).json({ error: "Oferta não encontrada, expirada ou já respondida" });

    const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1 AND status = 'aberto'", [oferta.pedido_id])).rows[0];
    if (!ped) return res.status(404).json({ error: "Pedido não está mais disponível" });

    const proposta = (await pool.query(
      `INSERT INTO propostas (de_usuario_id, para_usuario_id, pedido_id, status)
       VALUES ($1, $2, $3, 'aceito') RETURNING *`,
      [req.user.id, ped.passageiro_id, ped.id]
    )).rows[0];
    const viagem = await criarViagemDaProposta(proposta.id);
    if (!viagem) {
      await pool.query("UPDATE propostas SET status = 'recusado' WHERE id = $1", [proposta.id]).catch(() => {});
      await pool.query(
        "UPDATE pedido_fila SET status = 'recusada', respondida_em = NOW() WHERE id = $1",
        [oferta.id]
      ).catch(() => {});
      await ofertarProximo(oferta.pedido_id);
      return res.status(409).json({ error: "Este pedido acabou de ser atendido por outro motorista." });
    }

    // Trava: ninguém mais da fila pode aceitar este pedido.
    await pool.query(
      `UPDATE pedido_fila SET status = 'cancelada'
       WHERE pedido_id = $1 AND id <> $2 AND status IN ('aguardando', 'ofertada')`,
      [oferta.pedido_id, oferta.id]
    );

    const parcial = !!viagem.destino_motorista_texto;
    res.json({ proposta_id: proposta.id, viagem_id: viagem.id, parcial });

    enviarPush(ped.passageiro_id, {
      title: "Carona confirmada!",
      body: parcial
        ? `O motorista vai até ${viagem.destino_motorista_texto}. Desembarque lá e peça outra carona.`
        : "Um motorista aceitou sua solicitação. Toque para acompanhar ao vivo.",
      url: "/dashboard.html",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao aceitar oferta" });
  }
});

// Motorista recusa: some da fila dele e a oferta passa pro próximo mais perto na hora.
app.post("/api/pedido-fila/:id/recusar", verificarAuth, async (req, res) => {
  try {
    const oferta = (await pool.query(
      `UPDATE pedido_fila SET status = 'recusada', respondida_em = NOW()
       WHERE id = $1 AND motorista_id = $2 AND status = 'ofertada'
       RETURNING *`,
      [req.params.id, req.user.id]
    )).rows[0];
    if (!oferta) return res.status(404).json({ error: "Oferta não encontrada ou já respondida" });
    await ofertarProximo(oferta.pedido_id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao recusar oferta" });
  }
});

// Passageiro acompanha a busca (robozinho): qual motorista está sendo chamado
// agora, quantos faltam. Alimenta a animação da bolinha e detecta fim da busca.
app.get("/api/pedidos/:id/fila-status", verificarAuth, async (req, res) => {
  try {
    const ped = (await pool.query(
      "SELECT id, passageiro_id, status FROM pedidos WHERE id = $1",
      [req.params.id]
    )).rows[0];
    if (!ped) return res.status(404).json({ error: "Pedido não encontrado" });
    if (ped.passageiro_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: "Sem permissão" });
    }
    const atual = (await pool.query(
      `SELECT f.motorista_id, f.ordem, u.nome, lo.lat, lo.lng,
              EXISTS (SELECT 1 FROM viagens vv
                      WHERE vv.motorista_id = f.motorista_id
                        AND vv.status = 'em_andamento') AS em_viagem
       FROM pedido_fila f
       JOIN usuarios u ON u.id = f.motorista_id
       LEFT JOIN localizacoes_online lo ON lo.usuario_id = f.motorista_id
       WHERE f.pedido_id = $1 AND f.status = 'ofertada' AND f.expira_em > NOW()
       ORDER BY f.ofertada_em DESC LIMIT 1`,
      [ped.id]
    )).rows[0] || null;
    const tot = (await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status IN ('aguardando', 'ofertada'))::int AS restantes,
              COUNT(*) FILTER (WHERE status = 'recusada')::int AS recusas
       FROM pedido_fila WHERE pedido_id = $1`,
      [ped.id]
    )).rows[0];
    // Verdade pro passageiro: quantos carros ativos existem AGORA no projeto.
    // online = 0 → a tela troca o "procurando…" por um aviso honesto.
    const pid = await projetoDoUsuario(ped.passageiro_id);
    const online = pid ? await contarMotoristasOnline(pid, ped.passageiro_id) : 0;
    const total = tot?.total || 0;
    const restantes = ped.status === "aberto" ? (tot?.restantes || 0) : 0;
    res.json({
      status: ped.status,
      atual: atual ? {
        motorista_id: atual.motorista_id,
        ordem: atual.ordem,
        nome: atual.nome,
        lat: atual.lat != null ? Number(atual.lat) : null,
        lng: atual.lng != null ? Number(atual.lng) : null,
        // Está terminando outra corrida: o passageiro vê "finalizando outra
        // corrida e vem te buscar" em vez de achar que o carro sumiu.
        em_viagem: !!atual.em_viagem,
      } : null,
      total,
      restantes,
      recusas: tot?.recusas || 0,
      // Fila criada e ninguém sobrou (todos recusaram/expiraram) — sem oferta viva.
      esgotada: total > 0 && restantes === 0 && !atual,
      online,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao consultar busca" });
  }
});

// Robô (bolinha) chegou no motorista escolhido: reforça o aviso pra ele (push),
// mas SÓ se ele é mesmo o da vez na fila — sem abrir margem pra spam/abuso.
app.post("/api/pedidos/:id/reofertar-motorista", verificarAuth, async (req, res) => {
  try {
    const pedidoId = parseInt(req.params.id, 10);
    const motoristaId = parseInt(req.body?.motorista_id, 10);
    if (!pedidoId || !motoristaId) return res.status(400).json({ error: "Dados inválidos" });
    const ped = (await pool.query(
      "SELECT id, passageiro_id, destino_texto, status FROM pedidos WHERE id = $1",
      [pedidoId]
    )).rows[0];
    if (!ped) return res.status(404).json({ error: "Pedido não encontrado" });
    if (ped.passageiro_id !== req.user.id) return res.status(403).json({ error: "Sem permissão" });
    if (ped.status !== "aberto") return res.json({ success: true, ignorado: true });
    const ofertada = (await pool.query(
      `SELECT 1 FROM pedido_fila
       WHERE pedido_id = $1 AND motorista_id = $2 AND status = 'ofertada' AND expira_em > NOW()
       LIMIT 1`,
      [pedidoId, motoristaId]
    )).rows[0];
    if (!ofertada) return res.json({ success: true, ignorado: true });
    const pax = (await pool.query("SELECT nome FROM usuarios WHERE id = $1", [ped.passageiro_id])).rows[0];
    enviarPush(motoristaId, {
      title: "Passageiro chamando você",
      body: `${pax?.nome || "Um passageiro"} está te chamando${ped.destino_texto ? ` para ${ped.destino_texto}` : ""}. Responda rápido.`,
      url: "/dashboard.html",
      action: "nova_oferta_fila",
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao reofertar" });
  }
});

// Motorista recusa um pedido (viu pelo pulso/modal): sai da fila desse pedido e,
// se era o motorista da vez, o robô do passageiro segue na hora pro próximo.
// Pedido SEM fila (broadcast/pulso): registra a recusa mesmo assim — o pulso
// não volta pro mapa deste motorista e o passageiro é avisado na hora, em vez
// de ficar esperando um aceite que já morreu.
app.post("/api/pedidos/:id/recusar-motorista", verificarAuth, async (req, res) => {
  try {
    const pedidoId = parseInt(req.params.id, 10);
    if (!pedidoId) return res.status(400).json({ error: "Pedido inválido" });
    const alvo = (await pool.query(
      `WITH alvo AS (
         SELECT id, status FROM pedido_fila
         WHERE pedido_id = $1 AND motorista_id = $2 AND status IN ('aguardando', 'ofertada')
         ORDER BY status = 'ofertada' DESC LIMIT 1
         FOR UPDATE
       ),
       upd AS (
         UPDATE pedido_fila SET status = 'recusada', respondida_em = NOW()
         WHERE id = (SELECT id FROM alvo) RETURNING id
       )
       SELECT alvo.status AS antes FROM alvo`,
      [pedidoId, req.user.id]
    )).rows[0];
    // Era o motorista da vez: avança o robô pro próximo agora mesmo (e, se a
    // fila esgotou, ofertarProximo avisa o passageiro).
    if (alvo?.antes === "ofertada") await ofertarProximo(pedidoId);
    if (!alvo) {
      const ped = (await pool.query(
        "SELECT id, passageiro_id, status FROM pedidos WHERE id = $1",
        [pedidoId]
      )).rows[0];
      if (ped && ped.status === "aberto" && ped.passageiro_id !== req.user.id) {
        const anterior = (await pool.query(
          "SELECT id, status FROM pedido_fila WHERE pedido_id = $1 AND motorista_id = $2 LIMIT 1",
          [pedidoId, req.user.id]
        )).rows[0];
        let registrou = false;
        if (!anterior) {
          await pool.query(
            `INSERT INTO pedido_fila (pedido_id, motorista_id, ordem, status, respondida_em)
             VALUES ($1, $2,
                     COALESCE((SELECT MAX(ordem) + 1 FROM pedido_fila WHERE pedido_id = $1), 0),
                     'recusada', NOW())`,
            [pedidoId, req.user.id]
          );
          registrou = true;
        } else if (anterior.status === "expirada" || anterior.status === "cancelada") {
          // Oferta antiga dele venceu e agora ele recusou de vez: registra.
          await pool.query(
            "UPDATE pedido_fila SET status = 'recusada', respondida_em = NOW() WHERE id = $1",
            [anterior.id]
          );
          registrou = true;
        }
        if (registrou) {
          const pid = await projetoDoUsuario(ped.passageiro_id);
          const alternativas = pid
            ? await contarMotoristasOnline(pid, ped.passageiro_id, pedidoId)
            : 0;
          enviarPush(ped.passageiro_id, {
            title: "Motorista não pôde aceitar",
            body: alternativas > 0
              ? "Seu pedido continua ativo e visível para outros motoristas por perto."
              : "Não há outro motorista online agora. Sua busca segue aberta por alguns minutos — ou tente novamente mais tarde.",
            url: "/dashboard.html",
          });
        }
      }
    }
    res.json({ success: true, avancou: alvo?.antes === "ofertada" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao recusar pedido" });
  }
});

