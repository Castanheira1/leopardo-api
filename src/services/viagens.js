// Ciclo da viagem a partir da proposta aceita; reversão de recursos no cancelamento.
require("dotenv").config();
const { pool } = require("../db");
const { habilitacaoAtiva, motoristaGpsVivo, projetoDoUsuario } = require("../usuarios");
const { codigoDoProjeto, compatRotaPassageiro, locaisDoProjetoCodigo, melhorPontoDeEncaixe, somarDesvioAcumulado } = require("../geo");

function pessoasDaProposta(pr) {
  return Math.min(6, Math.max(parseInt(pr?.pessoas, 10) || 1, 1));
}

// Cria a viagem a partir de uma proposta aceita (idempotente). Liga motorista
// e passageiro, copia a rota e marca a carona/pedido como atendido.
async function criarViagemDaProposta(propostaId) {
  const pr = (await pool.query("SELECT * FROM propostas WHERE id = $1 AND status = 'aceito'", [propostaId])).rows[0];
  if (!pr) return null;
  const existente = (await pool.query("SELECT * FROM viagens WHERE proposta_id = $1", [propostaId])).rows[0];
  if (existente) return existente;

  const npessoas = pessoasDaProposta(pr);

  // Ponto de encontro (embarque) e destino. O encontro é SEMPRE onde o passageiro
  // está; o destino é para onde ele quer ir. paradaMotorista só é usada na carona
  // parcial (motorista deixa o passageiro num ponto do caminho, ex.: Portaria).
  let motorista_id, passageiro_id, embarque, destino;
  let paradaMotorista = null;
  if (pr.carona_id) {
    motorista_id = pr.para_usuario_id; passageiro_id = pr.de_usuario_id;
    const car = (await pool.query(
      "SELECT * FROM caronas WHERE id = $1 AND status = 'ativa'",
      [pr.carona_id]
    )).rows[0];
    if (!car || (car.vagas || 0) < npessoas) return null;
    embarque = { texto: "Embarque do passageiro", lat: pr.selfie_lat || car?.origem_lat, lng: pr.selfie_lng || car?.origem_lng };
    if (pr.dest_passageiro_lat != null && pr.dest_passageiro_lng != null) {
      destino = {
        texto: pr.dest_passageiro_texto || car?.destino_texto,
        lat: pr.dest_passageiro_lat,
        lng: pr.dest_passageiro_lng,
      };
    } else {
      destino = { texto: car?.destino_texto, lat: car?.destino_lat, lng: car?.destino_lng };
    }
    // Encaixe/parcial gravado na proposta (vaga direta) ou compatibilidade calculada.
    if (pr.encaixe_lat != null && pr.encaixe_lng != null) {
      paradaMotorista = {
        texto: pr.encaixe_texto || "Ponto combinado no caminho",
        lat: pr.encaixe_lat,
        lng: pr.encaixe_lng,
      };
    } else if (car && car.destino_lat != null && pr.selfie_lat != null && pr.selfie_lng != null) {
      const pid = await projetoDoUsuario(passageiro_id);
      const cod = await codigoDoProjeto(pid);
      const locais = locaisDoProjetoCodigo(cod);
      const optsRota = {
        locais, codigo: cod, rota_pontos: car.rota_pontos || null,
        origPax: { lat: pr.selfie_lat, lng: pr.selfie_lng, nome: null },
      };
      const compat = compatRotaPassageiro(
        destino.lat, destino.lng,
        car.origem_lat, car.origem_lng, car.destino_lat, car.destino_lng,
        optsRota
      );
      if (compat === "parcial") {
        paradaMotorista = { texto: car.destino_texto, lat: car.destino_lat, lng: car.destino_lng };
      }
    }
  } else if (pr.pedido_id) {
    motorista_id = pr.de_usuario_id; passageiro_id = pr.para_usuario_id;
    const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1", [pr.pedido_id])).rows[0];
    embarque = { texto: ped?.origem_texto, lat: ped?.origem_lat, lng: ped?.origem_lng };
    destino = { texto: ped?.destino_texto, lat: ped?.destino_lat, lng: ped?.destino_lng };
    const car = (await pool.query(
      `SELECT origem_lat, origem_lng, destino_lat, destino_lng, destino_texto, rota_pontos
       FROM caronas WHERE motorista_id = $1 AND status = 'ativa'
       ORDER BY created_at DESC LIMIT 1`,
      [motorista_id]
    )).rows[0];
    if (car && car.destino_lat != null && ped?.destino_lat != null) {
      const pidEarly = await projetoDoUsuario(passageiro_id);
      const codEarly = await codigoDoProjeto(pidEarly);
      const locaisEarly = locaisDoProjetoCodigo(codEarly);
      const optsEarly = {
        locais: locaisEarly,
        codigo: codEarly,
        rota_pontos: car.rota_pontos || null,
        origPax: ped?.origem_lat != null
          ? { lat: ped.origem_lat, lng: ped.origem_lng, nome: ped.origem_texto || null }
          : undefined,
      };
      const compat = compatRotaPassageiro(
        ped.destino_lat, ped.destino_lng,
        car.origem_lat, car.origem_lng, car.destino_lat, car.destino_lng,
        optsEarly
      );
      if (compat === "parcial") {
        paradaMotorista = { texto: car.destino_texto, lat: car.destino_lat, lng: car.destino_lng };
      }
    }
    if (!paradaMotorista && ped) {
      const fx = (await pool.query(
        `SELECT encaixe_texto, encaixe_lat, encaixe_lng FROM pedido_fila
         WHERE pedido_id = $1 AND motorista_id = $2 AND encaixe_lat IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
        [ped.id, motorista_id]
      )).rows[0];
      if (fx) {
        paradaMotorista = { texto: fx.encaixe_texto || "Ponto combinado no caminho", lat: fx.encaixe_lat, lng: fx.encaixe_lng };
      } else if (car && car.destino_lat != null && ped.destino_lat != null && ped.origem_lat != null) {
        const pid = await projetoDoUsuario(passageiro_id);
        const cod = await codigoDoProjeto(pid);
        const locais = locaisDoProjetoCodigo(cod);
        const caOrig = { lat: +car.origem_lat, lng: +car.origem_lng };
        const caDest = { lat: +car.destino_lat, lng: +car.destino_lng };
        const optsRota = {
          locais,
          codigo: cod,
          rota_pontos: car.rota_pontos || null,
        };
        let desvioJa = 0;
        try {
          const { rows: paradas } = await pool.query(
            `SELECT destino_motorista_lat AS lat, destino_motorista_lng AS lng,
                    destino_motorista_texto AS nome
             FROM viagens
             WHERE motorista_id = $1 AND status = 'em_andamento'
               AND destino_motorista_lat IS NOT NULL`,
            [motorista_id]
          );
          desvioJa = somarDesvioAcumulado(caOrig, caDest, paradas.map((x) => ({
            lat: Number(x.lat), lng: Number(x.lng), nome: x.nome || null,
          })), optsRota);
        } catch (_) { /* ok */ }
        const enc = melhorPontoDeEncaixe(
          { lat: ped.origem_lat, lng: ped.origem_lng },
          { lat: ped.destino_lat, lng: ped.destino_lng },
          caOrig, caDest,
          { ...optsRota, desvio_acumulado_km: desvioJa }
        );
        const compat = compatRotaPassageiro(
          ped.destino_lat, ped.destino_lng,
          car.origem_lat, car.origem_lng, car.destino_lat, car.destino_lng,
          {
            ...optsRota,
            origPax: { lat: ped.origem_lat, lng: ped.origem_lng, nome: ped.origem_texto || null },
          }
        );
        if (enc && compat !== "total") {
          paradaMotorista = { texto: enc.nome || "Ponto combinado no caminho", lat: enc.lat, lng: enc.lng };
        }
      }
    }
  } else {
    motorista_id = pr.de_usuario_id; passageiro_id = pr.para_usuario_id;
    const cont = pr.contato_id
      ? (await pool.query("SELECT * FROM contatos_motorista WHERE id = $1", [pr.contato_id])).rows[0]
      : (await pool.query(
          `SELECT * FROM contatos_motorista
           WHERE motorista_id = $1 AND passageiro_id = $2
           ORDER BY created_at DESC LIMIT 1`,
          [motorista_id, passageiro_id]
        )).rows[0];
    embarque = { texto: cont?.origem_texto, lat: cont?.origem_lat, lng: cont?.origem_lng };
    destino = { texto: cont?.destino_texto, lat: cont?.destino_lat, lng: cont?.destino_lng };
  }
  const hab = await habilitacaoAtiva(motorista_id);

  // GATE atômico contra double-booking de pedido.
  if (pr.pedido_id) {
    const gate = await pool.query(
      "UPDATE pedidos SET status = 'atendido' WHERE id = $1 AND status = 'aberto'",
      [pr.pedido_id]
    );
    if (gate.rowCount === 0) return null;
  }

  // GATE atômico de vagas da carona (mesmo critério do pedido).
  if (pr.carona_id) {
    const gateCar = await pool.query(
      `UPDATE caronas
       SET vagas = vagas - $2,
           status = CASE WHEN vagas - $2 <= 0 THEN 'concluida' ELSE status END
       WHERE id = $1 AND status = 'ativa' AND vagas >= $2
       RETURNING id`,
      [pr.carona_id, npessoas]
    );
    if (gateCar.rowCount === 0) {
      if (pr.pedido_id) {
        await pool.query(
          "UPDATE pedidos SET status = 'aberto' WHERE id = $1 AND status = 'atendido'",
          [pr.pedido_id]
        ).catch(() => {});
      }
      return null;
    }
  }

  let rows;
  try {
    ({ rows } = await pool.query(
      `INSERT INTO viagens
         (proposta_id, carona_id, pedido_id, motorista_id, passageiro_id, habilitacao_id,
          origem_texto, origem_lat, origem_lng, destino_texto, destino_lat, destino_lng,
          destino_motorista_texto, destino_motorista_lat, destino_motorista_lng)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        pr.id, pr.carona_id, pr.pedido_id, motorista_id, passageiro_id, hab ? hab.id : null,
        embarque.texto || null, embarque.lat || null, embarque.lng || null,
        destino.texto || null, destino.lat || null, destino.lng || null,
        paradaMotorista?.texto || null, paradaMotorista?.lat || null, paradaMotorista?.lng || null,
      ]
    ));
  } catch (e) {
    if (pr.pedido_id) {
      await pool.query(
        "UPDATE pedidos SET status = 'aberto' WHERE id = $1 AND status = 'atendido'",
        [pr.pedido_id]
      ).catch(() => {});
    }
    if (pr.carona_id) {
      await pool.query(
        `UPDATE caronas
         SET vagas = LEAST(vagas + $2, 6),
             status = CASE WHEN status = 'concluida' AND vagas + $2 > 0 THEN 'ativa' ELSE status END
         WHERE id = $1`,
        [pr.carona_id, npessoas]
      ).catch(() => {});
    }
    throw e;
  }

  if (pr.pedido_id) {
    await pool.query(
      `UPDATE pedido_fila SET status = 'cancelada'
       WHERE pedido_id = $1 AND status IN ('aguardando', 'ofertada')`,
      [pr.pedido_id]
    ).catch(() => {});
    await pool.query(
      `UPDATE propostas SET status = 'recusado'
       WHERE pedido_id = $1 AND id <> $2 AND status = 'pendente'`,
      [pr.pedido_id, pr.id]
    ).catch(() => {});
  }

  if (pr.carona_id) {
    await pool.query(
      `UPDATE propostas SET status = 'recusado'
       WHERE carona_id = $1 AND id <> $2 AND status = 'pendente'`,
      [pr.carona_id, pr.id]
    ).catch(() => {});
  }

  await pool.query(
    "UPDATE pedidos SET status = 'cancelado' WHERE passageiro_id = $1 AND status = 'aberto' AND id <> COALESCE($2, -1)",
    [passageiro_id, pr.pedido_id || null]
  );
  return rows[0];
}

// Desfaz carona/pedido quando uma viagem em andamento é cancelada ou encerrada à força.
async function reverterRecursosDaViagem(v) {
  if (!v) return;
  const pr = v.proposta_id
    ? (await pool.query("SELECT pessoas FROM propostas WHERE id = $1", [v.proposta_id])).rows[0]
    : null;
  const npessoas = pessoasDaProposta(pr);
  if (v.carona_id) {
    const car = (await pool.query("SELECT motorista_id FROM caronas WHERE id = $1", [v.carona_id])).rows[0];
    if (car && await motoristaGpsVivo(car.motorista_id)) {
      await pool.query(
        `UPDATE caronas
         SET vagas = LEAST(vagas + $2, 6),
             status = CASE WHEN status IN ('concluida', 'cancelada') THEN 'ativa' ELSE status END
         WHERE id = $1`,
        [v.carona_id, npessoas]
      );
    } else {
      await pool.query(
        "UPDATE caronas SET status = 'cancelada' WHERE id = $1 AND status = 'ativa'",
        [v.carona_id]
      );
    }
  }
  if (v.pedido_id) {
    await pool.query(
      "UPDATE pedidos SET status = 'aberto' WHERE id = $1 AND status <> 'cancelado'",
      [v.pedido_id]
    );
  }
}

async function cancelarViagemAtiva(viagemId, usuarioId) {
  const v = (await pool.query(
    "SELECT * FROM viagens WHERE id = $1 AND status = 'em_andamento'",
    [viagemId]
  )).rows[0];
  if (!v) return { ok: false, status: 404, error: "Viagem não encontrada ou já encerrada" };
  if (![v.motorista_id, v.passageiro_id].includes(usuarioId)) {
    return { ok: false, status: 403, error: "Sem permissão" };
  }
  const { rows } = await pool.query(
    `UPDATE viagens SET status = 'cancelada', finalizada_em = COALESCE(finalizada_em, NOW())
     WHERE id = $1 AND status = 'em_andamento' RETURNING *`,
    [viagemId]
  );
  if (!rows[0]) return { ok: false, status: 404, error: "Viagem não encontrada ou já encerrada" };
  await reverterRecursosDaViagem(v);
  return { ok: true, viagem: rows[0] };
}


module.exports = {
  pessoasDaProposta,
  criarViagemDaProposta,
  reverterRecursosDaViagem,
  cancelarViagemAtiva,
};
