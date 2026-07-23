// Propostas: criar/listar e aceitar/recusar/cancelar (cria a viagem no aceite).
// Pedido aberto ou buzina com destino: a resposta do motorista já nasce aceita
// e vira viagem na hora — o passageiro pediu, o motorista aceitou, sem segunda
// confirmação (mesmo caminho do aceite da fila).
require("dotenv").config();
const app = require("../app");
const { pool } = require("../db");
const { enviarPush } = require("../push");
const { verificarAuth } = require("../auth");
const { habilitacaoAtiva, motoristaGpsVivo, sqlSelfieValida, validarMesmoProjeto, passageiroEmViagem, cancelarPedidosAbertosPassageiro } = require("../usuarios");
const { criarViagemDaProposta, pessoasDaProposta, reverterRecursosDaViagem } = require("../services/viagens");
const { ofertarProximo } = require("../services/fila");

/* ============================ PROPOSTAS ============================ */
app.post("/api/propostas", verificarAuth, async (req, res) => {
  const {
    carona_id, pedido_id, contato_id, mensagem,
    selfie_url, selfie_lat, selfie_lng, selfie_em, pessoas,
    encaixe_texto, encaixe_lat, encaixe_lng,
    dest_passageiro_texto, dest_passageiro_lat, dest_passageiro_lng,
  } = req.body;
  if (!carona_id && !pedido_id && !contato_id) return res.status(400).json({ error: "Informe carona_id, pedido_id ou contato_id" });

  try {
    if (await passageiroEmViagem(req.user.id)) {
      return res.status(400).json({ error: "Você já está em uma viagem. Finalize ou cancele antes de solicitar outra carona." });
    }

    let para_usuario_id, dadosSelfie = {};
    // Aceite direto: o passageiro já pediu (pedido aberto ou buzina com destino);
    // a resposta do motorista confirma a viagem na hora.
    let aceiteDireto = false;
    const npessoas = Math.min(6, Math.max(parseInt(pessoas, 10) || 1, 1));
    let encaixeDados = {
      encaixe_texto: encaixe_texto ? String(encaixe_texto).slice(0, 200) : null,
      encaixe_lat: encaixe_lat != null ? +encaixe_lat : null,
      encaixe_lng: encaixe_lng != null ? +encaixe_lng : null,
    };
    if (encaixeDados.encaixe_lat == null || encaixeDados.encaixe_lng == null) {
      encaixeDados = { encaixe_texto: null, encaixe_lat: null, encaixe_lng: null };
    }
    const destPass = {
      dest_passageiro_texto: dest_passageiro_texto ? String(dest_passageiro_texto).slice(0, 200) : null,
      dest_passageiro_lat: dest_passageiro_lat != null ? +dest_passageiro_lat : null,
      dest_passageiro_lng: dest_passageiro_lng != null ? +dest_passageiro_lng : null,
    };
    if (destPass.dest_passageiro_lat == null || destPass.dest_passageiro_lng == null) {
      Object.assign(destPass, { dest_passageiro_texto: null, dest_passageiro_lat: null, dest_passageiro_lng: null });
    }

    if (carona_id) {
      if (!selfie_url) return res.status(400).json({ error: "Selfie é obrigatória para pedir vaga" });
      const car = (await pool.query("SELECT * FROM caronas WHERE id = $1 AND status = 'ativa'", [carona_id])).rows[0];
      if (!car) return res.status(404).json({ error: "Carona indisponível" });
      if (car.motorista_id === req.user.id) return res.status(400).json({ error: "Você é o motorista desta carona" });
      if (!(await validarMesmoProjeto(req.user.id, car.motorista_id, res))) return;
      const foraCarona = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM viagens
         WHERE motorista_id = $1 AND status = 'em_andamento' AND carona_id IS NULL`,
        [car.motorista_id]
      )).rows[0]?.n || 0;
      const vagasEfetivas = (car.vagas || 0) - foraCarona;
      if (vagasEfetivas < npessoas) {
        return res.status(400).json({
          error: npessoas === 1
            ? "Não há vagas disponíveis nesta carona"
            : `Só há ${Math.max(vagasEfetivas, 0)} vaga(s) — você pediu ${npessoas}.`,
        });
      }
      await cancelarPedidosAbertosPassageiro(req.user.id);
      para_usuario_id = car.motorista_id;
      dadosSelfie = { selfie_url, selfie_lat, selfie_lng, selfie_em: selfie_em || new Date() };
    } else if (contato_id) {
      const hab = await habilitacaoAtiva(req.user.id);
      if (!hab) return res.status(403).json({ error: "Ative o modo motorista antes de oferecer carona" });
      const cont = (await pool.query(
        "SELECT * FROM contatos_motorista WHERE id = $1 AND motorista_id = $2",
        [contato_id, req.user.id]
      )).rows[0];
      if (!cont) return res.status(404).json({ error: "Contato indisponível" });
      if (!(await validarMesmoProjeto(req.user.id, cont.passageiro_id, res))) return;
      para_usuario_id = cont.passageiro_id;
      // Buzina com destino = pedido explícito; sem destino é só "combinar no
      // WhatsApp" e aí a oferta ainda precisa do aceite do passageiro.
      aceiteDireto = cont.destino_lat != null && cont.destino_lng != null
        && !(await passageiroEmViagem(cont.passageiro_id));
      await pool.query("UPDATE contatos_motorista SET lido = TRUE WHERE id = $1", [contato_id]);
      await pool.query(
        `UPDATE contatos_motorista SET lido = TRUE
         WHERE motorista_id = $1 AND passageiro_id = $2 AND lido = FALSE`,
        [req.user.id, cont.passageiro_id]
      );
    } else {
      // Motorista oferecendo carona a um pedido -> precisa de habilitação ativa
      const hab = await habilitacaoAtiva(req.user.id);
      if (!hab) return res.status(403).json({ error: "Ative o modo motorista antes de oferecer carona" });
      const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1 AND status = 'aberto'", [pedido_id])).rows[0];
      if (!ped) return res.status(404).json({ error: "Pedido indisponível" });
      if (ped.passageiro_id === req.user.id) return res.status(400).json({ error: "Este pedido é seu" });
      if (!(await validarMesmoProjeto(req.user.id, ped.passageiro_id, res))) return;
      // Pedido com fila ativa (chamada sequencial por rota): só quem está na
      // vez pode responder, e é pelos endpoints /api/pedido-fila/:id — evita
      // dois motoristas aceitando o mesmo pedido ao mesmo tempo. Fila esgotada
      // (todas expiradas/recusadas) libera a oferta manual de novo.
      // Fila NÃO-exclusiva (busca inteligente do pedido broadcast) não bloqueia:
      // qualquer motorista pode oferecer mesmo com o robô chamando o melhor.
      const temFila = (await pool.query(
        `SELECT 1 FROM pedido_fila
         WHERE pedido_id = $1 AND status IN ('aguardando', 'ofertada') AND exclusiva LIMIT 1`,
        [pedido_id]
      )).rows[0];
      if (temFila) return res.status(400).json({ error: "Este pedido está usando busca automática por proximidade" });
      para_usuario_id = ped.passageiro_id;
      aceiteDireto = true;
    }

    const { rows } = await pool.query(
      `INSERT INTO propostas
         (de_usuario_id, para_usuario_id, carona_id, pedido_id, contato_id, mensagem,
          selfie_url, selfie_lat, selfie_lng, selfie_em, pessoas,
          encaixe_texto, encaixe_lat, encaixe_lng,
          dest_passageiro_texto, dest_passageiro_lat, dest_passageiro_lng, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        req.user.id, para_usuario_id, carona_id || null, pedido_id || null, contato_id || null, mensagem || null,
        dadosSelfie.selfie_url || null, dadosSelfie.selfie_lat || null,
        dadosSelfie.selfie_lng || null, dadosSelfie.selfie_em || null,
        npessoas,
        encaixeDados.encaixe_texto, encaixeDados.encaixe_lat, encaixeDados.encaixe_lng,
        destPass.dest_passageiro_texto, destPass.dest_passageiro_lat, destPass.dest_passageiro_lng,
        aceiteDireto ? "aceito" : "pendente",
      ]
    );

    if (aceiteDireto) {
      const viagem = await criarViagemDaProposta(rows[0].id);
      if (!viagem) {
        await pool.query("UPDATE propostas SET status = 'recusado' WHERE id = $1", [rows[0].id]).catch(() => {});
        return res.status(409).json({
          error: pedido_id
            ? "Este pedido acabou de ser atendido por outro motorista."
            : "Não foi possível confirmar a carona. Tente novamente.",
        });
      }
      const parcial = !!viagem.destino_motorista_texto;
      res.json({ ...rows[0], viagem_id: viagem.id, parcial });
      enviarPush(para_usuario_id, {
        title: "Carona confirmada!",
        body: parcial
          ? `O motorista vai até ${viagem.destino_motorista_texto}. Desembarque lá e peça outra carona.`
          : "Um motorista aceitou sua solicitação. Toque para acompanhar ao vivo.",
        url: "/dashboard.html",
      });
      return;
    }

    res.json(rows[0]);

    // Notifica quem recebeu a solicitação (mesmo com o app fechado).
    const deNome = (await pool.query("SELECT nome FROM usuarios WHERE id = $1", [req.user.id])).rows[0]?.nome || "Um colega";
    enviarPush(para_usuario_id, {
      title: "Nova solicitação de carona",
      body: contato_id
        ? `${deNome} ofereceu uma carona para você.`
        : (carona_id ? `${deNome} pediu uma vaga na sua carona.` : `${deNome} ofereceu uma carona para você.`),
      url: "/dashboard.html",
      action: "nova_solicitacao",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao enviar proposta" });
  }
});

app.get("/api/propostas", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pr.*,
              du.nome AS de_nome, pu.nome AS para_nome,
              CASE WHEN pr.status = 'aceito' THEN du.telefone ELSE NULL END AS de_telefone,
              CASE WHEN pr.status = 'aceito' THEN pu.telefone ELSE NULL END AS para_telefone,
              c.origem_texto AS c_origem, c.destino_texto AS c_destino, c.horario AS c_horario,
              p.origem_texto AS p_origem, p.destino_texto AS p_destino, p.horario AS p_horario,
              v.id AS viagem_id, v.status AS viagem_status,
              COALESCE(hm.selfie_url, hped.selfie_url) AS motorista_selfie,
              COALESCE(hm.selfie_em, hped.selfie_em) AS motorista_selfie_em,
              COALESCE(hm.foto_carro_url, hped.foto_carro_url) AS motorista_carro,
              COALESCE(hm.foto_carro_em, hped.foto_carro_em) AS motorista_carro_em,
              COALESCE(hm.placa, hped.placa) AS motorista_placa,
              COALESCE(hm.tag, hped.tag) AS motorista_tag
       FROM propostas pr
       JOIN usuarios du ON pr.de_usuario_id = du.id
       JOIN usuarios pu ON pr.para_usuario_id = pu.id
       LEFT JOIN caronas c ON pr.carona_id = c.id
       LEFT JOIN pedidos p ON pr.pedido_id = p.id
       LEFT JOIN viagens v ON v.proposta_id = pr.id
       LEFT JOIN habilitacoes_motorista hm ON hm.id = c.habilitacao_id
       LEFT JOIN LATERAL (
         SELECT selfie_url, selfie_em, foto_carro_url, foto_carro_em, placa, tag
         FROM habilitacoes_motorista
         WHERE motorista_id = pr.de_usuario_id AND status = 'ativa'
           AND ${sqlSelfieValida("")}
         ORDER BY created_at DESC LIMIT 1
       ) hped ON pr.pedido_id IS NOT NULL
       WHERE pr.de_usuario_id = $1 OR pr.para_usuario_id = $1
       ORDER BY pr.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json(rows.map((r) => ({ ...r, sou_destinatario: r.para_usuario_id === req.user.id })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar propostas" });
  }
});


app.post("/api/propostas/:id/aceitar", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE propostas SET status = 'aceito'
       WHERE id = $1 AND para_usuario_id = $2 AND status = 'pendente'
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Proposta não encontrada" });
    // Cria a viagem na hora do aceite: já liga os dois, habilita rastreamento e contato.
    const viagem = await criarViagemDaProposta(req.params.id);
    if (!viagem) {
      if (rows[0].pedido_id) {
        await pool.query("UPDATE propostas SET status = 'recusado' WHERE id = $1", [req.params.id]).catch(() => {});
        return res.status(409).json({ error: "Este pedido acabou de ser atendido por outra carona." });
      }
      if (rows[0].carona_id) {
        await pool.query("UPDATE propostas SET status = 'recusado' WHERE id = $1", [req.params.id]).catch(() => {});
        return res.status(409).json({ error: "Carona indisponível ou sem vagas suficientes." });
      }
      console.error("[aceitar proposta] viagem não criada para proposta", req.params.id);
      return res.status(500).json({ error: "Não foi possível iniciar a viagem. Tente novamente." });
    }
    res.json({ ...rows[0], viagem_id: viagem.id });

    // Notifica quem fez a solicitação de que foi aceita (app pode estar fechado).
    enviarPush(rows[0].de_usuario_id, {
      title: "Carona confirmada!",
      body: "Sua solicitação foi aceita. Toque para acompanhar ao vivo.",
      url: "/dashboard.html",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao aceitar proposta" });
  }
});

app.post("/api/propostas/:id/recusar", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE propostas SET status = 'recusado'
       WHERE id = $1 AND para_usuario_id = $2 AND status = 'pendente'
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Proposta não encontrada" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erro ao recusar proposta" });
  }
});

// Cancela uma proposta JÁ aceita (qualquer um dos dois lados), antes da viagem
// começar. Reabre a oferta/pedido para novos matches.
app.post("/api/propostas/:id/cancelar", verificarAuth, async (req, res) => {
  try {
    // Permite cancelar uma proposta PENDENTE (chamada em espera) ou ACEITA — mas,
    // nesse caso, só ANTES do embarque (viagem ainda na fase 'encontro', motorista
    // a caminho de buscar). Depois que o motorista confirma o embarque (fase
    // 'destino', POST /api/viagens/:id/iniciar) não dá mais pra cancelar por aqui.
    // Vale para quem enviou ou recebeu. Guarda o status ANTERIOR (numa CTE,
    // atômico com o UPDATE) para saber se uma vaga/viagem precisa ser desfeita.
    const pr = (await pool.query(
      `WITH alvo AS (
         SELECT * FROM propostas
         WHERE id = $1 AND (de_usuario_id = $2 OR para_usuario_id = $2)
           AND status IN ('pendente', 'aceito')
           AND NOT EXISTS (
             SELECT 1 FROM viagens v
             WHERE v.proposta_id = propostas.id AND v.status = 'em_andamento' AND v.fase = 'destino'
           )
         FOR UPDATE
       ),
       atualizado AS (
         UPDATE propostas SET status = 'recusado'
         WHERE id = (SELECT id FROM alvo)
         RETURNING *
       )
       SELECT atualizado.*, alvo.status AS status_anterior
       FROM atualizado JOIN alvo ON alvo.id = atualizado.id`,
      [req.params.id, req.user.id]
    )).rows[0];
    if (!pr) return res.status(400).json({ error: "Não é possível cancelar (viagem já iniciada ou proposta inválida)" });

    // Proposta já tinha virado viagem (fase 'encontro', motorista ainda a
    // caminho): desfaz a viagem também, senão fica um "em_andamento" órfão.
    if (pr.status_anterior === "aceito") {
      await pool.query(
        "UPDATE viagens SET status = 'cancelada', finalizada_em = COALESCE(finalizada_em, NOW()) WHERE proposta_id = $1 AND status = 'em_andamento'",
        [pr.id]
      );
      const v = (await pool.query("SELECT * FROM viagens WHERE proposta_id = $1 ORDER BY id DESC LIMIT 1", [pr.id])).rows[0];
      if (v) await reverterRecursosDaViagem(v);
    }

    // Reabre a carona/pedido para que possam ser oferecidos de novo. Se a
    // proposta JÁ estava aceita, ela tinha ocupado 1 vaga (ver
    // criarViagemDaProposta) — devolve essa vaga agora.
    if (pr.carona_id) {
      const car = (await pool.query("SELECT motorista_id FROM caronas WHERE id = $1", [pr.carona_id])).rows[0];
      const np = pessoasDaProposta(pr);
      if (car && await motoristaGpsVivo(car.motorista_id)) {
        if (pr.status_anterior === "aceito") {
          await pool.query(
            "UPDATE caronas SET vagas = vagas + $2, status = 'ativa' WHERE id = $1 AND status <> 'cancelada'",
            [pr.carona_id, np]
          );
        } else {
          await pool.query("UPDATE caronas SET status = 'ativa' WHERE id = $1 AND status <> 'cancelada'", [pr.carona_id]);
        }
      } else {
        await pool.query(
          "UPDATE caronas SET status = 'cancelada' WHERE id = $1 AND status = 'ativa'",
          [pr.carona_id]
        );
      }
    }
    if (pr.pedido_id) {
      await pool.query("UPDATE pedidos SET status = 'aberto' WHERE id = $1 AND status <> 'cancelado'", [pr.pedido_id]);
      // Pedido com fila ativa: quem cancelou libera a vaga. O aceite tinha
      // travado (cancelado) o resto da fila — reabre essas posições e chama
      // o próximo mais perto na hora, sem esperar o passageiro agir de novo.
      const temFila = (await pool.query("SELECT 1 FROM pedido_fila WHERE pedido_id = $1 LIMIT 1", [pr.pedido_id])).rows[0];
      if (temFila) {
        await pool.query(
          "UPDATE pedido_fila SET status = 'aguardando' WHERE pedido_id = $1 AND status = 'cancelada'",
          [pr.pedido_id]
        );
        await ofertarProximo(pr.pedido_id);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao cancelar" });
  }
});

