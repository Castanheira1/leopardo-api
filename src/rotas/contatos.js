// Contato passageiro→motorista (buzina/WhatsApp), pulsos no mapa e eventos de uso.
require("dotenv").config();
const app = require("../app");
const { pool } = require("../db");
const { enviarPush } = require("../push");
const { verificarAuth } = require("../auth");
const { habilitacaoAtiva, projetoDoUsuario, registrarEventoUso, selfieRecentePassageiro, validarMesmoProjeto } = require("../usuarios");
const { codigoDoProjeto, compatRotaPassageiro, haversine, locaisDoProjetoCodigo } = require("../geo");

// Passageiro toca no motorista em modo geral (sem destino): registra uso, avisa o motorista
// e libera o WhatsApp/telefone com mensagem padrão. Vale tanto pro motorista em
// modo geral (combina destino) quanto pro que já publicou carona (buzina/liga
// pra ele direto, sem precisar esperar aceite de proposta) — é o "buzina" da
// fila de motoristas na rota.
app.post("/api/motoristas-online/:id/contato", verificarAuth, async (req, res) => {
  const motoristaId = parseInt(req.params.id, 10);
  if (!motoristaId) return res.status(400).json({ error: "Motorista inválido" });
  const {
    origem_lat, origem_lng, origem_texto,
    destino_lat, destino_lng, destino_texto,
    pessoas,
  } = req.body || {};
  const npessoas = Math.min(6, Math.max(parseInt(pessoas, 10) || 1, 1));
  try {
    if (!(await validarMesmoProjeto(req.user.id, motoristaId, res))) return;

    const hab = await habilitacaoAtiva(motoristaId);
    if (!hab) return res.status(404).json({ error: "Motorista indisponível" });

    const loc = (await pool.query(
      `SELECT l.disponivel, l.lat, l.lng, l.online_desde,
              (SELECT destino_texto FROM caronas WHERE motorista_id = $1 AND status = 'ativa' LIMIT 1) AS destino_texto
       FROM localizacoes_online l WHERE l.usuario_id = $1`,
      [motoristaId]
    )).rows[0];
    const caronaAtiva = (await pool.query(
      `SELECT id, destino_texto, destino_lat, destino_lng, origem_lat, origem_lng, vagas, rota_pontos FROM caronas
       WHERE motorista_id = $1 AND status = 'ativa' AND vagas > 0
       ORDER BY created_at DESC LIMIT 1`,
      [motoristaId]
    )).rows[0];
    // Modo amarelo (online_desde): passageiro vê carro dourado sem rota — buzina
    // combina destino, não "Solicitar vaga". Ignora carona residual no banco.
    const modoAmarelo = !!loc?.online_desde;
    const caronaContato = modoAmarelo ? null : caronaAtiva;
    // Lista caronas publicadas ≠ GPS ao vivo: contato vale se online OU carona ativa.
    if (!loc?.disponivel && !caronaContato) {
      return res.status(404).json({ error: "Motorista não está disponível agora" });
    }
    if (caronaContato && caronaContato.vagas < npessoas) {
      return res.status(400).json({
        error: npessoas === 1
          ? "Não há vagas disponíveis nesta carona"
          : `Só há ${caronaContato.vagas} vaga(s) — você pediu ${npessoas}.`,
      });
    }

    const mot = (await pool.query(
      "SELECT nome, telefone FROM usuarios WHERE id = $1",
      [motoristaId]
    )).rows[0];
    if (!mot?.telefone) return res.status(400).json({ error: "Motorista sem WhatsApp cadastrado" });

    const destinoPax = destino_texto ? String(destino_texto).trim() : null;
    const destinoCarona = modoAmarelo ? null : (loc?.destino_texto || caronaContato?.destino_texto);

    let compatContato = "none";
    if (caronaContato?.destino_lat != null && destino_lat != null && destino_lng != null) {
      const pidCont = await projetoDoUsuario(req.user.id);
      const codCont = await codigoDoProjeto(pidCont);
      const locaisCont = locaisDoProjetoCodigo(codCont);
      compatContato = compatRotaPassageiro(
        destino_lat, destino_lng,
        caronaContato.origem_lat, caronaContato.origem_lng,
        caronaContato.destino_lat, caronaContato.destino_lng,
        {
          locais: locaisCont,
          codigo: codCont,
          rota_pontos: caronaContato.rota_pontos || null,
          origPax: origem_lat != null && origem_lng != null
            ? { lat: +origem_lat, lng: +origem_lng, nome: null }
            : undefined,
        }
      );
      if (compatContato === "total") {
        return res.status(400).json({
          error: "Use Solicitar vaga — vocês vão para o mesmo destino. A buzina não é necessária.",
        });
      }
    }

    const mensagem = destinoPax
      ? `Olá! Quero ir para ${destinoPax}${npessoas > 1 ? ` (${npessoas} pessoas)` : ''}. Posso ir com você?`
      : (destinoCarona
        ? `Olá! Vi que você está indo para ${destinoCarona}. Posso ir com você?`
        : "Olá, qual é o seu destino agora?");

    const prev = (await pool.query(
      `SELECT id FROM contatos_motorista
       WHERE motorista_id = $1 AND passageiro_id = $2 AND lido = FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [motoristaId, req.user.id]
    )).rows[0];

    // Selfie de validação: body (se o app mandar) ou última selfie de pedido/proposta.
    const selfieBody = req.body?.selfie_url ? String(req.body.selfie_url).slice(0, 800) : null;
    const selfieUrl = selfieBody || (await selfieRecentePassageiro(req.user.id));

    const vals = [
      mensagem,
      origem_lat != null ? +origem_lat : null,
      origem_lng != null ? +origem_lng : null,
      origem_texto || null,
      destino_lat != null ? +destino_lat : null,
      destino_lng != null ? +destino_lng : null,
      destinoPax,
      npessoas,
      compatContato !== "none" ? compatContato : null,
      selfieUrl,
    ];

    let contatoRow;
    if (prev) {
      contatoRow = (await pool.query(
        `UPDATE contatos_motorista SET
           mensagem = $1, origem_lat = $2, origem_lng = $3, origem_texto = $4,
           destino_lat = $5, destino_lng = $6, destino_texto = $7, pessoas = $8,
           compat_rota = $9, selfie_url = COALESCE($10, selfie_url),
           created_at = NOW(), lido = FALSE
         WHERE id = $11 RETURNING id`,
        [...vals, prev.id]
      )).rows[0];
      await pool.query(
        `UPDATE contatos_motorista SET lido = TRUE
         WHERE motorista_id = $1 AND passageiro_id = $2 AND lido = FALSE AND id <> $3`,
        [motoristaId, req.user.id, prev.id]
      );
    } else {
      contatoRow = (await pool.query(
        `INSERT INTO contatos_motorista
           (motorista_id, passageiro_id, mensagem,
            origem_lat, origem_lng, origem_texto,
            destino_lat, destino_lng, destino_texto, pessoas, compat_rota, selfie_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [motoristaId, req.user.id, ...vals]
      )).rows[0];
    }

    const pax = (await pool.query("SELECT nome, telefone FROM usuarios WHERE id = $1", [req.user.id])).rows[0];
    await registrarEventoUso(req.user.id, "contato_motorista_geral", { motorista_id: motoristaId });
    await registrarEventoUso(motoristaId, "contato_recebido_geral", { passageiro_id: req.user.id });

    const destinoPush = destinoPax || destinoCarona;
    enviarPush(motoristaId, {
      title: destinoPush ? `${pax?.nome || "Passageiro"} quer ir para ${destinoPush}` : "Alguém quer falar com você",
      body: destinoPush
        ? `${npessoas} pessoa(s) — veja no mapa.`
        : `${pax?.nome || "Um passageiro"} quer combinar destino no WhatsApp.`,
      url: "/dashboard.html",
      action: "contato_mapa",
      contato_id: contatoRow.id,
    });

    res.json({ telefone: mot.telefone, mensagem, contato_id: contatoRow.id, atualizado: !!prev });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao solicitar contato" });
  }
});

// Passageiro limpou a rota / cancelou: some do mapa do motorista (pulso da buzina).
// Marca como lido os contatos abertos deste passageiro (opcionalmente só de 1 motorista).
app.post("/api/motoristas-online/contato/cancelar", verificarAuth, async (req, res) => {
  try {
    const motoristaId = parseInt(req.body?.motorista_id, 10) || null;
    if (motoristaId) {
      await pool.query(
        `UPDATE contatos_motorista SET lido = TRUE
         WHERE passageiro_id = $1 AND motorista_id = $2 AND lido = FALSE`,
        [req.user.id, motoristaId]
      );
    } else {
      await pool.query(
        `UPDATE contatos_motorista SET lido = TRUE
         WHERE passageiro_id = $1 AND lido = FALSE`,
        [req.user.id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao cancelar contato" });
  }
});

app.get("/api/motorista/contatos/novos", verificarAuth, async (req, res) => {
  const desde = parseInt(req.query.desde, 10) || 0;
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.mensagem, c.created_at,
              c.origem_lat, c.origem_lng, c.origem_texto,
              c.destino_lat, c.destino_lng, c.destino_texto, c.pessoas,
              u.nome AS passageiro_nome, u.telefone AS passageiro_telefone, u.sexo AS passageiro_sexo,
              COALESCE(c.selfie_url, ps.selfie_url) AS selfie_url
       FROM contatos_motorista c
       JOIN usuarios u ON u.id = c.passageiro_id
       LEFT JOIN LATERAL (
         SELECT selfie_url FROM pedidos
         WHERE passageiro_id = c.passageiro_id AND selfie_url IS NOT NULL AND selfie_url <> ''
         ORDER BY created_at DESC LIMIT 1
       ) ps ON TRUE
       WHERE c.motorista_id = $1 AND c.lido = FALSE AND c.id > $2
       ORDER BY c.id ASC
       LIMIT 20`,
      [req.user.id, desde]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar contatos" });
  }
});

// Contatos recentes com localização — pulso no mapa do motorista (modo amarelo e rota).
app.get("/api/motorista/contatos/mapa", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (c.passageiro_id)
              c.id, c.passageiro_id, c.mensagem, c.created_at,
              c.origem_lat, c.origem_lng, c.origem_texto,
              c.destino_lat, c.destino_lng, c.destino_texto, c.pessoas, c.compat_rota,
              ca.destino_texto AS destino_motorista_texto,
              ${haversine("ca.destino_lat", "ca.destino_lng", "c.destino_lat", "c.destino_lng")} AS dist_dest_km,
              u.nome AS passageiro_nome, u.telefone AS passageiro_telefone, u.sexo AS passageiro_sexo,
              COALESCE(c.selfie_url, ps.selfie_url) AS selfie_url
       FROM contatos_motorista c
       JOIN usuarios u ON u.id = c.passageiro_id
       LEFT JOIN LATERAL (
         SELECT destino_lat, destino_lng, destino_texto
         FROM caronas
         WHERE motorista_id = c.motorista_id AND status = 'ativa'
         ORDER BY created_at DESC LIMIT 1
       ) ca ON TRUE
       LEFT JOIN LATERAL (
         SELECT selfie_url FROM pedidos
         WHERE passageiro_id = c.passageiro_id AND selfie_url IS NOT NULL AND selfie_url <> ''
         ORDER BY created_at DESC LIMIT 1
       ) ps ON TRUE
       WHERE c.motorista_id = $1
         AND c.lido = FALSE
         AND c.origem_lat IS NOT NULL
         AND c.origem_lng IS NOT NULL
         AND c.created_at > NOW() - INTERVAL '30 minutes'
       ORDER BY c.passageiro_id, c.created_at DESC
       LIMIT 30`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar contatos no mapa" });
  }
});

app.post("/api/motorista/contatos/:id/lido", verificarAuth, async (req, res) => {
  try {
    await pool.query(
      "UPDATE contatos_motorista SET lido = TRUE WHERE id = $1 AND motorista_id = $2",
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro" });
  }
});

// Motorista recusa a buzina/solicitação: some do mapa (lido) e avisa o passageiro.
app.post("/api/motorista/contatos/:id/recusar", verificarAuth, async (req, res) => {
  try {
    const row = (await pool.query(
      `UPDATE contatos_motorista SET lido = TRUE
       WHERE id = $1 AND motorista_id = $2 RETURNING passageiro_id`,
      [req.params.id, req.user.id]
    )).rows[0];
    if (!row) return res.status(404).json({ error: "Solicitação não encontrada" });
    const mot = (await pool.query("SELECT nome FROM usuarios WHERE id = $1", [req.user.id])).rows[0];
    enviarPush(row.passageiro_id, {
      title: "Carona recusada",
      body: `${mot?.nome || "O motorista"} não pode levar agora. Chame outro motorista por perto.`,
      url: "/dashboard.html",
      action: "contato_recusado",
    });
    await registrarEventoUso(req.user.id, "contato_recusado", { passageiro_id: row.passageiro_id });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao recusar" });
  }
});

app.post("/api/eventos-uso", verificarAuth, async (req, res) => {
  const { evento, detalhes } = req.body;
  if (!evento) return res.status(400).json({ error: "evento obrigatório" });
  try {
    await registrarEventoUso(req.user.id, String(evento).slice(0, 64), detalhes || null);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao registrar evento" });
  }
});

