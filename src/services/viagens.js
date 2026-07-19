// Ciclo da viagem a partir da proposta aceita; reversão de recursos no cancelamento.
require("dotenv").config();
const { pool } = require("../db");
const { habilitacaoAtiva, motoristaGpsVivo, projetoDoUsuario } = require("../usuarios");
const { codigoDoProjeto, compatRotaPassageiro, locaisDoProjetoCodigo, melhorPontoDeEncaixe } = require("../geo");

// Cria a viagem a partir de uma proposta aceita (idempotente). Liga motorista
// e passageiro, copia a rota e marca a carona/pedido como atendido.
async function criarViagemDaProposta(propostaId) {
  const pr = (await pool.query("SELECT * FROM propostas WHERE id = $1 AND status = 'aceito'", [propostaId])).rows[0];
  if (!pr) return null;
  const existente = (await pool.query("SELECT * FROM viagens WHERE proposta_id = $1", [propostaId])).rows[0];
  if (existente) return existente;

  // Ponto de encontro (embarque) e destino. O encontro é SEMPRE onde o passageiro
  // está; o destino é para onde ele quer ir. paradaMotorista só é usada na carona
  // parcial (motorista deixa o passageiro num ponto do caminho, ex.: Portaria).
  let motorista_id, passageiro_id, embarque, destino;
  let paradaMotorista = null;
  if (pr.carona_id) {
    motorista_id = pr.para_usuario_id; passageiro_id = pr.de_usuario_id;
    const car = (await pool.query("SELECT * FROM caronas WHERE id = $1", [pr.carona_id])).rows[0];
    // passageiro pediu vaga: o embarque é a posição dele (selfie do pedido de vaga)
    embarque = { texto: "Embarque do passageiro", lat: pr.selfie_lat || car?.origem_lat, lng: pr.selfie_lng || car?.origem_lng };
    destino = { texto: car?.destino_texto, lat: car?.destino_lat, lng: car?.destino_lng };
  } else if (pr.pedido_id) {
    motorista_id = pr.de_usuario_id; passageiro_id = pr.para_usuario_id;
    const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1", [pr.pedido_id])).rows[0];
    embarque = { texto: ped?.origem_texto, lat: ped?.origem_lat, lng: ped?.origem_lng };
    destino = { texto: ped?.destino_texto, lat: ped?.destino_lat, lng: ped?.destino_lng };
    // Carona parcial: o motorista tem rota publicada que passa por um ponto do
    // caminho do passageiro mas NÃO chega ao destino final dele. O destino da
    // viagem continua sendo o do passageiro; a parada do motorista (desembarque)
    // fica registrada pra tela desenhar preto→parada + dourado→destino final.
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
    // Encaixe (ponto em comum): a fila do pedido já calculou onde este motorista
    // deixa o passageiro (ex.: Portaria). A viagem nasce com a parada certa.
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
        // Proposta manual (sem fila): calcula o ponto em comum na hora.
        const pid = await projetoDoUsuario(passageiro_id);
        const cod = await codigoDoProjeto(pid);
        const locais = locaisDoProjetoCodigo(cod);
        const optsRota = {
          locais,
          codigo: cod,
          rota_pontos: car.rota_pontos || null,
        };
        const enc = melhorPontoDeEncaixe(
          { lat: ped.origem_lat, lng: ped.origem_lng },
          { lat: ped.destino_lat, lng: ped.destino_lng },
          { lat: car.origem_lat, lng: car.origem_lng },
          { lat: car.destino_lat, lng: car.destino_lng },
          optsRota
        );
        // Só vale como parada se o motorista NÃO cobre a viagem toda (senão a
        // viagem é normal — destino do passageiro).
        const compat = compatRotaPassageiro(
          ped.destino_lat, ped.destino_lng,
          car.origem_lat, car.origem_lng, car.destino_lat, car.destino_lng,
          optsRota
        );
        if (enc && compat !== "total") {
          paradaMotorista = { texto: enc.nome || "Ponto combinado no caminho", lat: enc.lat, lng: enc.lng };
        }
      }
    }
  } else {
    // Motorista ofereceu a um contato ("quer carona"/buzina). Embarque e destino
    // vêm do contato do passageiro — senão a viagem nasce sem coordenadas e a rota
    // não é desenhada. Usa o contato_id gravado; cai no mais recente entre os dois
    // como fallback (propostas antigas, sem a coluna).
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

  // GATE atômico contra double-booking: dois aceites simultâneos (fila + proposta
  // manual) disputavam o mesmo pedido e criavam DUAS viagens. Só quem conseguir
  // virar o pedido de 'aberto' para 'atendido' cria a viagem; o outro recebe null.
  if (pr.pedido_id) {
    const gate = await pool.query(
      "UPDATE pedidos SET status = 'atendido' WHERE id = $1 AND status = 'aberto'",
      [pr.pedido_id]
    );
    if (gate.rowCount === 0) return null;
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
    // Falhou depois do gate: devolve o pedido pro ar (senão sumia sem viagem).
    if (pr.pedido_id) {
      await pool.query(
        "UPDATE pedidos SET status = 'aberto' WHERE id = $1 AND status = 'atendido'",
        [pr.pedido_id]
      ).catch(() => {});
    }
    throw e;
  }
  // Cada aceite ocupa 1 vaga. A carona só fecha (concluida) quando as vagas
  // acabam — com mais de uma vaga, ela continua ativa e visível para os
  // demais passageiros até esgotar.
  if (pr.carona_id) {
    await pool.query(
      `UPDATE caronas
       SET vagas = GREATEST(vagas - 1, 0),
           status = CASE WHEN vagas - 1 <= 0 THEN 'concluida' ELSE status END
       WHERE id = $1`,
      [pr.carona_id]
    );
  }
  // (status 'atendido' já foi garantido pelo gate atômico lá em cima.)
  // Viagem criada: o robô de busca deste pedido para de chamar motoristas
  // (posições vivas da fila são canceladas; quem cancelar a viagem reabre).
  if (pr.pedido_id) {
    await pool.query(
      `UPDATE pedido_fila SET status = 'cancelada'
       WHERE pedido_id = $1 AND status IN ('aguardando', 'ofertada')`,
      [pr.pedido_id]
    ).catch(() => {});
  }
  // Passageiro entrou numa viagem: qualquer OUTRO pedido aberto dele vira passado —
  // senão ele volta a aparecer no mapa dos motoristas enquanto já está sendo levado.
  await pool.query(
    "UPDATE pedidos SET status = 'cancelado' WHERE passageiro_id = $1 AND status = 'aberto' AND id <> COALESCE($2, -1)",
    [passageiro_id, pr.pedido_id || null]
  );
  return rows[0];
}

// Desfaz carona/pedido quando uma viagem em andamento é cancelada ou encerrada à força.
async function reverterRecursosDaViagem(v) {
  if (!v) return;
  if (v.carona_id) {
    const car = (await pool.query("SELECT motorista_id FROM caronas WHERE id = $1", [v.carona_id])).rows[0];
    if (car && await motoristaGpsVivo(car.motorista_id)) {
      await pool.query(
        `UPDATE caronas
         SET vagas = LEAST(vagas + 1, 6),
             status = CASE WHEN status IN ('concluida', 'cancelada') THEN 'ativa' ELSE status END
         WHERE id = $1`,
        [v.carona_id]
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
  criarViagemDaProposta,
  reverterRecursosDaViagem,
  cancelarViagemAtiva,
};
