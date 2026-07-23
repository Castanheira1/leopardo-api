// Busca de motorista pro pedido: push por proximidade, ativação de agendados e fila sequencial (mais perto primeiro, timeout por oferta). Fica junto porque fila vazia cai no push por proximidade.
require("dotenv").config();
const app = require("../app");
const { FILA_OFERTA_TIMEOUT_S, RAIO_ONLINE_KM, RAIO_ROTA_KM, RAIO_VISIVEL_KM, sqlGpsVisivelMapa } = require("../config");
const { pool } = require("../db");
const { enviarPush } = require("../push");
const { projetoDoUsuario, sqlSelfieValida } = require("../usuarios");
const { codigoDoProjeto, compatRotaPassageiro, corredorRotaCaronaKm, corredorSegmentoKm, haversine, locaisDoProjetoCodigo, melhorPontoDeEncaixe, somarDesvioAcumulado } = require("../geo");

// Notifica motoristas ONLINE (disponivel) dentro de RAIO_ONLINE_KM (600 m).
// Marca o pedido como notificado. Usado no POST (pedido "para agora") e pelo
// agendador (pedido com horário marcado).
async function notificarMotoristasProximos(ped) {
  try {
    const passInfo = (await pool.query(
      "SELECT nome, projeto_id FROM usuarios WHERE id = $1",
      [ped.passageiro_id]
    )).rows[0];
    if (!passInfo?.projeto_id) return;

    const nome = passInfo.nome || "Um colega";
    // Raio por motorista: sem destino (amarelo) usa RAIO_ONLINE_KM (600 m); com
    // carona ativa usa o alcance da barra (caronas.raio_km, default 10 km). Assim o
    // motorista é notificado dos pedidos dentro do raio que ELE calibrou.
    const motoristas = (await pool.query(
      `SELECT motorista_id FROM (
         SELECT DISTINCT ON (h.motorista_id) h.motorista_id,
                ${haversine("l.lat", "l.lng", "$1", "$2")} AS dist,
                COALESCE(ca.raio_km, $4) AS raio
         FROM habilitacoes_motorista h
         JOIN localizacoes_online l ON l.usuario_id = h.motorista_id AND l.disponivel = TRUE
         JOIN usuarios um ON um.id = h.motorista_id
         LEFT JOIN caronas ca ON ca.motorista_id = h.motorista_id AND ca.status = 'ativa'
         WHERE h.status = 'ativa' AND ${sqlSelfieValida("h")}
           AND h.motorista_id <> $3
           AND um.projeto_id = $5
           AND COALESCE(um.ativo, TRUE) = TRUE
         ORDER BY h.motorista_id, h.created_at DESC
       ) s
       WHERE s.dist <= s.raio
       ORDER BY s.dist ASC
       LIMIT 8`,
      [ped.origem_lat, ped.origem_lng, ped.passageiro_id, RAIO_ONLINE_KM, passInfo.projeto_id]
    )).rows;
    const destino = ped.destino_texto ? ` para ${ped.destino_texto}` : " aqui perto";
    motoristas.forEach((m) => enviarPush(m.motorista_id, {
      title: "Carona perto de você",
      body: `${nome} está pedindo carona${destino}. Abra o app para oferecer.`,
      url: "/dashboard.html",
    }));
  } catch (e) { console.warn("notificarMotoristasProximos:", e.message); }
  try { await pool.query("UPDATE pedidos SET notificado = TRUE WHERE id = $1", [ped.id]); } catch (_) {}
}

// Agendador: pedidos com horário marcado só entram no ar na hora marcada.
// Usa a mesma fila sequencial do pedido imediato (usar_fila), não só push 600 m.
async function ativarPedidoAgendado(ped) {
  try {
    // Mesma busca do pedido imediato: fila de NOTIFICAÇÃO não-exclusiva (melhor
    // motorista chamado um a um, pulso visível para todos). A exclusiva antiga
    // escondia o pedido agendado do mapa e bloqueava ofertas manuais.
    await iniciarFilaPedido(ped.id, { exclusiva: false });
    await pool.query("UPDATE pedidos SET notificado = TRUE WHERE id = $1", [ped.id]);
    const destino = ped.destino_texto ? ` para ${ped.destino_texto}` : "";
    enviarPush(ped.passageiro_id, {
      title: "Horário da sua carona",
      body: `Seu pedido agendado entrou no ar${destino}. Procurando motoristas.`,
      url: "/dashboard.html",
    });
  } catch (e) {
    console.warn("ativarPedidoAgendado:", e.message);
  }
}


/* ==================== FILA DE CHAMADA SEQUENCIAL (pedido por rota) ====================
 * Passageiro escolhe uma rota (origem->destino); todo motorista habilitado e
 * disponível "na pista" (dentro de RAIO_ROTA_KM da linha reta) entra numa fila
 * ordenada do mais perto pro mais longe. Só o motorista da vez recebe a oferta
 * (buzina); se recusar ou estourar o tempo (FILA_OFERTA_TIMEOUT_S), passa pro
 * próximo. Quem aceitar primeiro trava a vaga — os demais somem da fila.
 */

// Quantos motoristas habilitados estão de fato online/disponíveis no projeto
// (mesmo critério de visibilidade do mapa do passageiro). É o "tem carro ativo?"
// que alimenta a tela de busca — sem isso o robozinho procura no vazio.
// pedidoIdSemRecusas: desconta quem já recusou aquele pedido — sobra só quem
// ainda pode aceitar.
// Cache curto (10 s) por projeto+usuário: o fila-status é sondado a cada 3 s
// por passageiro em busca — sem cache, cada tela de espera custava uma varredura
// de projeto por tick. Contagens com recusas de pedido específico não são cacheadas.
const ONLINE_CACHE_MS = Number(process.env.ONLINE_CACHE_MS || 10 * 1000);
const _onlineCache = new Map();
async function contarMotoristasOnline(projetoId, excluirUsuarioId, pedidoIdSemRecusas = null) {
  const chaveCache = pedidoIdSemRecusas ? null : `${projetoId}:${excluirUsuarioId}`;
  if (chaveCache) {
    const hit = _onlineCache.get(chaveCache);
    if (hit && Date.now() - hit.em < ONLINE_CACHE_MS) return hit.n;
  }
  const params = [excluirUsuarioId, projetoId];
  let filtroRecusa = "";
  if (pedidoIdSemRecusas) {
    params.push(pedidoIdSemRecusas);
    filtroRecusa = `AND NOT EXISTS (SELECT 1 FROM pedido_fila fr
                      WHERE fr.pedido_id = $3 AND fr.motorista_id = u.id AND fr.status = 'recusada')`;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT u.id)::int AS n
     FROM localizacoes_online l
     JOIN usuarios u ON u.id = l.usuario_id
     JOIN habilitacoes_motorista h
       ON h.motorista_id = u.id AND h.status = 'ativa' AND ${sqlSelfieValida("h")}
     WHERE l.disponivel = TRUE
       AND COALESCE(u.ativo, TRUE) = TRUE
       AND ${sqlGpsVisivelMapa("l")}
       AND u.id <> $1
       AND u.projeto_id = $2
       ${filtroRecusa}`,
    params
  );
  const n = rows[0]?.n || 0;
  if (chaveCache) {
    _onlineCache.set(chaveCache, { n, em: Date.now() });
    // Poda ocasional: o mapa não cresce além dos passageiros ativos recentes.
    if (_onlineCache.size > 500) {
      const corte = Date.now() - ONLINE_CACHE_MS;
      for (const [k, v] of _onlineCache) if (v.em < corte) _onlineCache.delete(k);
    }
  }
  return n;
}

/* Ranking do "melhor motorista": quem cobre mais da viagem do passageiro é
 * chamado primeiro. Classes (menor = melhor), desempate por distância à origem:
 *   0 rota publicada cobre a viagem inteira (compat total)
 *   1 rota publicada cobre até o destino do motorista (parcial)
 *   2 rota publicada passa por um PONTO EM COMUM que adianta o passageiro (encaixe)
 *   3 GPS do motorista já está na faixa da rota do passageiro
 *   4 rota publicada chega perto do destino (proximo)
 *   5 só está por perto da origem (600 m amarelo / barra da carona)
 */
async function rankearMotoristasParaPedido(ped, projetoId) {
  const orig = { lat: Number(ped.origem_lat), lng: Number(ped.origem_lng) };
  const dest = { lat: Number(ped.destino_lat), lng: Number(ped.destino_lng) };
  const distOrigem = haversine("l.lat", "l.lng", "$1", "$2");
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (u.id) u.id AS motorista_id, l.lat, l.lng, l.vagas AS lo_vagas,
            ${distOrigem} AS dist_km,
            ca.id AS carona_id, ca.origem_lat AS ca_olat, ca.origem_lng AS ca_olng,
            ca.destino_lat AS ca_dlat, ca.destino_lng AS ca_dlng,
            ca.raio_km AS ca_raio, ca.vagas AS ca_vagas, ca.rota_pontos AS ca_rota_pontos,
            (SELECT COUNT(*)::int FROM viagens vv
              WHERE vv.motorista_id = u.id AND vv.status = 'em_andamento') AS viagens_ativas,
            -- Viagens fora de carona (pedido/buzina) não decrementam ca.vagas —
            -- contam aqui para saber quantos lugares o carro ainda tem de fato.
            (SELECT COUNT(*)::int FROM viagens vv
              WHERE vv.motorista_id = u.id AND vv.status = 'em_andamento'
                AND vv.carona_id IS NULL) AS viagens_fora_carona
     FROM localizacoes_online l
     JOIN usuarios u ON u.id = l.usuario_id
     JOIN habilitacoes_motorista h
       ON h.motorista_id = u.id AND h.status = 'ativa' AND ${sqlSelfieValida("h")}
     LEFT JOIN LATERAL (
       SELECT id, origem_lat, origem_lng, destino_lat, destino_lng, raio_km, vagas, rota_pontos
       FROM caronas WHERE motorista_id = u.id AND status = 'ativa'
       ORDER BY created_at DESC LIMIT 1
     ) ca ON TRUE
     WHERE l.disponivel = TRUE
       AND COALESCE(u.ativo, TRUE) = TRUE
       -- GPS vivo (mesmo critério do mapa do passageiro): sem isso o robô
       -- chamava motorista fantasma (app fechado, GPS parado até 15 min) que o
       -- passageiro nem via no mapa — e a espera morria em timeout.
       AND ${sqlGpsVisivelMapa("l")}
       AND u.id <> $3
       AND u.projeto_id = $4
       AND (ca.vagas IS NULL OR ca.vagas > 0)
     ORDER BY u.id, h.created_at DESC`,
    [orig.lat, orig.lng, ped.passageiro_id, projetoId]
  );
  const cod = await codigoDoProjeto(projetoId);
  const locais = locaisDoProjetoCodigo(cod);

  // Paradas de encaixe/parcial já aceitas (outros pax a bordo) — 1 query,
  // desvio acumulado local na malha (sem Google).
  const idsMot = rows.map((m) => m.motorista_id).filter(Boolean);
  const paradasPorMot = new Map();
  if (idsMot.length) {
    try {
      const { rows: paradas } = await pool.query(
        `SELECT motorista_id,
                destino_motorista_lat AS lat,
                destino_motorista_lng AS lng,
                destino_motorista_texto AS nome
         FROM viagens
         WHERE status = 'em_andamento'
           AND destino_motorista_lat IS NOT NULL
           AND destino_motorista_lng IS NOT NULL
           AND motorista_id = ANY($1::int[])`,
        [idsMot]
      );
      for (const p of paradas) {
        if (!paradasPorMot.has(p.motorista_id)) paradasPorMot.set(p.motorista_id, []);
        paradasPorMot.get(p.motorista_id).push({
          lat: Number(p.lat), lng: Number(p.lng), nome: p.nome || null,
        });
      }
    } catch (e) {
      console.warn("rankear desvio acumulado:", e.message);
    }
  }

  const candidatos = [];
  for (const m of rows) {
    const gps = { lat: Number(m.lat), lng: Number(m.lng) };
    const distKm = Number(m.dist_km);
    const temCarona = m.carona_id && m.ca_olat != null && m.ca_dlat != null;
    const caOrig = temCarona ? { lat: Number(m.ca_olat), lng: Number(m.ca_olng) } : null;
    const caDest = temCarona ? { lat: Number(m.ca_dlat), lng: Number(m.ca_dlng) } : null;
    const optsRota = temCarona
      ? { locais, codigo: cod, rota_pontos: m.ca_rota_pontos || null }
      : { locais, codigo: cod };

    // Embarque viável: a ORIGEM do passageiro está na PISTA da carona (polilinha
    // da malha / rota_pontos), OU o motorista está dentro do raio de alcance
    // (600 m amarelo / barra da carona), OU o GPS dele já está na faixa da rota
    // do passageiro.
    const corOrigemCarona = temCarona
      ? corredorRotaCaronaKm(orig.lat, orig.lng, caOrig.lat, caOrig.lng, caDest.lat, caDest.lng, optsRota)
      : null;
    const origemNoCorredor = !!corOrigemCarona
      && corOrigemCarona.dist <= RAIO_ROTA_KM && corOrigemCarona.t >= -0.05 && corOrigemCarona.t <= 1.05;
    const raioAlcance = temCarona ? (Number(m.ca_raio) || RAIO_VISIVEL_KM) : RAIO_ONLINE_KM;
    const dentroDoRaio = Number.isFinite(distKm) && distKm <= raioAlcance;
    const corGpsPax = corredorSegmentoKm(gps.lat, gps.lng, orig.lat, orig.lng, dest.lat, dest.lng);
    const gpsNaFaixa = corGpsPax.dist <= RAIO_ROTA_KM && corGpsPax.t >= -0.05 && corGpsPax.t <= 1.05;
    if (!origemNoCorredor && !dentroDoRaio && !gpsNaFaixa) continue;

    // Encadeamento: motorista EM VIAGEM continua no jogo se ainda tem lugar no
    // carro (vagas declaradas menos passageiros de pedido/buzina a bordo — os
    // aceites de carona já debitam ca.vagas sozinhos). Carro cheio fica de fora.
    const emViagem = Number(m.viagens_ativas) > 0;
    if (emViagem) {
      const vagasBase = temCarona ? Number(m.ca_vagas ?? 1) : (Number(m.lo_vagas) || 1);
      const vagasRestantes = vagasBase - (Number(m.viagens_fora_carona) || 0);
      if (vagasRestantes <= 0) continue;
    }

    let classe = 5;
    let encaixe = null;
    if (temCarona) {
      const compat = compatRotaPassageiro(dest.lat, dest.lng, caOrig.lat, caOrig.lng, caDest.lat, caDest.lng, optsRota);
      if (compat === "total") classe = 0;
      else if (compat === "parcial") classe = 1;
      else {
        const desvioJa = somarDesvioAcumulado(
          caOrig, caDest,
          paradasPorMot.get(m.motorista_id) || [],
          optsRota
        );
        encaixe = melhorPontoDeEncaixe(orig, dest, caOrig, caDest, {
          ...optsRota,
          desvio_acumulado_km: desvioJa,
        });
        if (encaixe) classe = 2;
        else if (compat === "proximo") classe = 4;
      }
    }
    if (classe === 5 && gpsNaFaixa) classe = 3;
    candidatos.push({
      motorista_id: m.motorista_id,
      dist_km: Number.isFinite(distKm) ? distKm : null,
      classe,
      em_viagem: emViagem,
      encaixe: classe === 2 ? encaixe : null,
    });
  }
  // Mesma classe: motorista LIVRE vem antes de quem está finalizando outra
  // corrida; depois, o mais perto.
  candidatos.sort((a, b) =>
    (a.classe - b.classe)
    || ((a.em_viagem ? 1 : 0) - (b.em_viagem ? 1 : 0))
    || ((a.dist_km ?? 1e9) - (b.dist_km ?? 1e9)));
  return candidatos;
}

// Cria a fila do pedido (uma vez) e oferta ao primeiro (melhor colocado).
// exclusiva=true  → modo usar_fila clássico: o pulso some e só o da vez responde.
// exclusiva=false → fila de NOTIFICAÇÃO do pedido broadcast: chama o melhor
// motorista um a um (sem avisar todo mundo de uma vez), mas o pulso continua
// no mapa de todos e qualquer motorista pode oferecer por fora.
async function iniciarFilaPedido(pedidoId, { exclusiva = true } = {}) {
  const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1", [pedidoId])).rows[0];
  if (!ped) return;
  const filaViva = (await pool.query(
    `SELECT 1 FROM pedido_fila
     WHERE pedido_id = $1 AND status IN ('aguardando', 'ofertada', 'aceita') LIMIT 1`,
    [pedidoId]
  )).rows[0];
  if (filaViva) return;
  const pid = await projetoDoUsuario(ped.passageiro_id);
  if (!pid) return;
  const candidatos = await rankearMotoristasParaPedido(ped, pid);
  // Ninguém alcançável agora: não deixa o pedido no vácuo — avisa os motoristas
  // disponíveis num raio (mesmo aviso do "buzina"), pra eles decidirem.
  if (!candidatos.length) { await notificarMotoristasProximos(ped); return; }
  const values = candidatos
    .map((c, i) => `($1, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $2, $${i * 6 + 6}, $${i * 6 + 7}, $${i * 6 + 8})`)
    .join(",");
  const params = [pedidoId, exclusiva];
  candidatos.forEach((c, i) => params.push(
    c.motorista_id, i, c.dist_km,
    c.encaixe?.nome || null, c.encaixe?.lat ?? null, c.encaixe?.lng ?? null
  ));
  await pool.query(
    `INSERT INTO pedido_fila
       (pedido_id, motorista_id, ordem, dist_km, exclusiva, encaixe_texto, encaixe_lat, encaixe_lng)
     VALUES ${values}`,
    params
  );
  await ofertarProximo(pedidoId);
}

// Pega o próximo candidato "aguardando" (menor ordem) e oferta só pra ele.
async function ofertarProximo(pedidoId) {
  const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1", [pedidoId])).rows[0];
  if (!ped || ped.status !== "aberto") return;
  // Seleção + oferta num ÚNICO statement (FOR UPDATE SKIP LOCKED): duas recusas
  // ou expirações simultâneas não ofertam em dobro nem pulam candidato. A guarda
  // NOT EXISTS impede segunda oferta viva no mesmo pedido.
  const proximo = (await pool.query(
    `UPDATE pedido_fila SET status = 'ofertada', ofertada_em = NOW(),
            expira_em = NOW() + ($2 || ' seconds')::interval
     WHERE id = (
       SELECT id FROM pedido_fila
       WHERE pedido_id = $1 AND status = 'aguardando'
         AND NOT EXISTS (SELECT 1 FROM pedido_fila viva
                         WHERE viva.pedido_id = $1 AND viva.status = 'ofertada'
                           AND viva.expira_em > NOW())
       ORDER BY ordem ASC LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [pedidoId, String(FILA_OFERTA_TIMEOUT_S)]
  )).rows[0];
  if (!proximo) {
    // Nada ofertado: ou já existe oferta viva (outro caminho chegou antes — ok),
    // ou a fila esgotou (todo mundo recusou/não respondeu). Só no esgotamento o
    // PASSAGEIRO é avisado — senão fica esperando um aceite que não vem.
    const st = (await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'aguardando')::int AS aguardando,
              COUNT(*) FILTER (WHERE status = 'ofertada' AND expira_em > NOW())::int AS vivas
       FROM pedido_fila WHERE pedido_id = $1`,
      [pedidoId]
    )).rows[0];
    if (st.total > 0 && st.aguardando === 0 && st.vivas === 0) {
      enviarPush(ped.passageiro_id, {
        title: "Nenhum motorista aceitou ainda",
        body: "Os motoristas chamados não puderam atender. Seu pedido continua visível para quem está por perto.",
        url: "/dashboard.html",
      });
    }
    return;
  }
  // Encaixe: o motorista não vai até o destino do passageiro, mas passa por um
  // ponto em comum — o push já diz onde ele deixaria o passageiro.
  const dicaEncaixe = proximo.encaixe_texto
    ? ` Dá para deixar em ${proximo.encaixe_texto}.`
    : "";
  enviarPush(proximo.motorista_id, {
    title: "Carona pedida perto de você",
    body: `Passageiro pedindo carona${ped.destino_texto ? ` para ${ped.destino_texto}` : ""}. Você é a melhor opção agora — responda rápido.${dicaEncaixe}`,
    url: "/dashboard.html",
    action: "nova_oferta_fila",
  });
}

// Avançador de fundo: ofertas vencidas (motorista não respondeu a tempo) expiram
// e a fila passa pro próximo automaticamente.
async function expirarFilasVencidas() {
  const { rows } = await pool.query(
    `UPDATE pedido_fila SET status = 'expirada'
     WHERE status = 'ofertada' AND expira_em < NOW()
     RETURNING pedido_id`
  );
  const pedidoIds = [...new Set(rows.map((r) => r.pedido_id))];
  await Promise.all(pedidoIds.map((id) => ofertarProximo(id).catch((e) => console.warn("expirarFilasVencidas:", e.message))));
}


module.exports = {
  notificarMotoristasProximos,
  ativarPedidoAgendado,
  ONLINE_CACHE_MS,
  _onlineCache,
  contarMotoristasOnline,
  rankearMotoristasParaPedido,
  iniciarFilaPedido,
  ofertarProximo,
  expirarFilasVencidas,
};
