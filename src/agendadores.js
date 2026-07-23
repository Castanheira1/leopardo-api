// Timers de fundo: agendados, expiração de pedidos/filas, limpezas, retenção e keep-alive.
require("dotenv").config();
const { FILA_TICK_MS } = require("./config");
const { pool } = require("./db");
const { limparPublicacoesFantasma } = require("./bootstrap-db");
const { enviarPush } = require("./push");
const { aplicarRetencaoFotos } = require("./storage");
const { ativarPedidoAgendado, expirarFilasVencidas } = require("./services/fila");
const { limparErrosAntigos } = require("./erros");

// Retenção do registro de erros (30 dias) — 1x/dia.
setInterval(() => { limparErrosAntigos(); }, 24 * 60 * 60 * 1000);

// Intervalo do agendador (ativa pedidos cujo horário marcado já chegou). 60s em
// produção; a suíte de integração baixa via env para exercitar a ativação sem
// esperar o minuto cheio.
const AGENDADO_TICK_MS = Number(process.env.AGENDADO_TICK_MS || 60 * 1000);
setInterval(async () => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM pedidos
      WHERE status = 'aberto' AND COALESCE(notificado, FALSE) = FALSE
        AND horario IS NOT NULL AND horario <= NOW()
    `);
    await Promise.all(rows.map(ativarPedidoAgendado));
  } catch (err) {
    console.error("Erro ao notificar pedidos agendados:", err.message);
  }
}, AGENDADO_TICK_MS);

// Keep-alive: só no plano FREE do Render (hiberna ~15 min). No starter (US$7)
// não hiberna — ping a cada 10 min só gasta CPU. Ative com RENDER_KEEPALIVE=true
// se ainda estiver no free tier.
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS || 10 * 60 * 1000);
const keepAliveLigado = /^(1|true|yes|on)$/i.test(String(process.env.RENDER_KEEPALIVE || ""));
if (keepAliveLigado && process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/api/config`)
      .then((r) => { if (!r.ok) console.warn("keep-alive: resposta", r.status); })
      .catch((e) => console.warn("keep-alive:", e.message));
  }, KEEPALIVE_MS);
  console.log(`Keep-alive ativo (${KEEPALIVE_MS / 1000}s) em ${process.env.RENDER_EXTERNAL_URL}`);
}

// Marca pedidos antigos como cancelados (limpeza leve): "para agora" parados há mais
// de 10 min (o passageiro esqueceu a busca aberta), e agendados cujo horário já
// passou há mais de 3h.
setInterval(async () => {
  try {
    // Passageiro já está numa viagem em andamento: encerra o pedido pendente
    // dele (não some só da vista — sai de vez, pra não voltar). Sem aviso —
    // ele já está sendo atendido.
    await pool.query(`
      UPDATE pedidos p SET status = 'cancelado'
      WHERE p.status = 'aberto'
        AND EXISTS (SELECT 1 FROM viagens v
                    WHERE v.passageiro_id = p.passageiro_id AND v.status = 'em_andamento')
    `);
    // Busca "para agora" vencida (10 min sem ninguém aceitar): encerra E AVISA —
    // o passageiro não pode descobrir sozinho que a busca morreu.
    const { rows: vencidos } = await pool.query(`
      UPDATE pedidos SET status = 'cancelado'
      WHERE status = 'aberto' AND horario IS NULL
        AND created_at < NOW() - INTERVAL '10 minutes'
      RETURNING id, passageiro_id
    `);
    vencidos.forEach((p) => enviarPush(p.passageiro_id, {
      title: "Busca encerrada",
      body: "Nenhum motorista aceitou desta vez. Peça novamente quando quiser.",
      url: "/dashboard.html",
    }));
    // Agendado cujo horário já passou há mais de 3h: limpeza silenciosa.
    await pool.query(`
      UPDATE pedidos SET status = 'cancelado'
      WHERE status = 'aberto' AND horario IS NOT NULL
        AND horario < NOW() - INTERVAL '3 hours'
    `);
  } catch (err) {
    console.error("Erro ao expirar pedidos:", err.message);
  }
}, 5 * 60 * 1000);

// Cancela rotas publicadas cujo motorista saiu do ar (evita cards antigos na lista).
setInterval(() => {
  limparPublicacoesFantasma().catch((err) => console.error("Erro ao limpar publicações fantasma:", err.message));
}, 5 * 60 * 1000);

// Fila de chamada sequencial (pedido por rota): avança pro próximo motorista
// quando o da vez estoura o prazo sem responder (ver FILA_OFERTA_TIMEOUT_S).
setInterval(() => {
  expirarFilasVencidas().catch((err) => console.error("Erro ao expirar filas:", err.message));
}, FILA_TICK_MS);

// Retenção de fotos de segurança: apaga do Storage após 30 dias.
setInterval(() => { aplicarRetencaoFotos().catch((e) => console.warn("retencao:", e.message)); }, 24 * 60 * 60 * 1000);
setTimeout(() => { aplicarRetencaoFotos().catch(() => {}); }, 60 * 1000);


module.exports = {
  AGENDADO_TICK_MS,
  KEEPALIVE_MS,
};
