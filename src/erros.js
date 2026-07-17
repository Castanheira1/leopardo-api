// Observabilidade: registro central de erros em produção.
// - Grava em eventos_erro (retenção de 30 dias, aplicada 1x/dia pelos agendadores).
// - Captura o tratador global HTTP, uncaughtException/unhandledRejection e
//   TUDO que passar por console.error (a maioria dos catch das rotas loga por
//   ele) — sem precisar tocar em cada rota.
// - Alerta por email (Resend, mesmas envs dos chamados admin) com throttle de
//   30 min, para o operador saber que produção quebrou sem ficar olhando log.
require("dotenv").config();
const { pool } = require("./db");

const ALERTA_THROTTLE_MS = Number(process.env.ERRO_ALERTA_THROTTLE_MS || 30 * 60 * 1000);
const MAX_INSERTS_POR_MIN = 60; // proteção contra loop de erro inundar o banco

let _ultimoAlerta = 0;
let _janelaInsert = { t0: Date.now(), n: 0 };
let _pausadoAte = 0; // se o próprio insert falhar (DB fora), pausa 60 s

async function garantirTabelaErros() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS eventos_erro (
      id SERIAL PRIMARY KEY,
      origem VARCHAR(80) NOT NULL,
      mensagem TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_eventos_erro_quando ON eventos_erro (criado_em DESC)");
}

async function limparErrosAntigos() {
  await pool.query("DELETE FROM eventos_erro WHERE criado_em < NOW() - INTERVAL '30 days'").catch(() => {});
}

function textoDoErro(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack || ""}`;
      if (typeof a === "object") { try { return JSON.stringify(a); } catch { return String(a); } }
      return String(a);
    })
    .join(" ")
    .slice(0, 2000);
}

/** Nunca lança; nunca loga via console.error (evita recursão). */
function registrarErro(origem, ...args) {
  const agora = Date.now();
  if (agora < _pausadoAte) return;
  if (agora - _janelaInsert.t0 > 60000) _janelaInsert = { t0: agora, n: 0 };
  if (++_janelaInsert.n > MAX_INSERTS_POR_MIN) return;

  const mensagem = textoDoErro(args);
  pool.query("INSERT INTO eventos_erro (origem, mensagem) VALUES ($1, $2)", [origem, mensagem])
    .catch(() => { _pausadoAte = Date.now() + 60000; });
  alertarOperador(origem, mensagem);
}

// Email de alerta com throttle: o primeiro erro da janela dispara; os demais
// só aparecem no painel (Saúde) — sem spam na caixa do operador.
function alertarOperador(origem, mensagem) {
  const apiKey = process.env.RESEND_API_KEY;
  const destino = process.env.ADMIN_EMAIL_NOTIFICACAO;
  if (!apiKey || !destino) return;
  const agora = Date.now();
  if (agora - _ultimoAlerta < ALERTA_THROTTLE_MS) return;
  _ultimoAlerta = agora;
  const from = process.env.EMAIL_FROM || "VAP <onboarding@resend.dev>";
  const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || "";
  fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [destino],
      subject: `[VAP] Erro em produção (${origem})`,
      html: `<h2>VAP registrou um erro</h2>
        <p><strong>Origem:</strong> ${origem}</p>
        <pre style="background:#f4f4f4;padding:12px;border-radius:6px;white-space:pre-wrap;">${String(mensagem).replace(/</g, "&lt;")}</pre>
        <p>Novos erros nos próximos ${Math.round(ALERTA_THROTTLE_MS / 60000)} min não geram email — veja o painel.</p>
        ${baseUrl ? `<p><a href="${baseUrl}/admin.html">Abrir painel (seção Saúde)</a></p>` : ""}`,
    }),
  }).catch(() => {});
}

// console.error passa a registrar também (mantendo a saída normal no log).
const _consoleErrorOriginal = console.error.bind(console);
console.error = (...args) => {
  _consoleErrorOriginal(...args);
  try { registrarErro("console", ...args); } catch (_) {}
};

// Crash real: registra e mantém a semântica de sempre (processo cai; o host
// reinicia). O exit é adiado 1,5 s para o INSERT ter chance de completar.
process.on("uncaughtException", (err) => {
  _consoleErrorOriginal("uncaughtException:", err);
  try { registrarErro("uncaughtException", err); } catch (_) {}
  setTimeout(() => process.exit(1), 1500);
});
process.on("unhandledRejection", (err) => {
  _consoleErrorOriginal("unhandledRejection:", err);
  try { registrarErro("unhandledRejection", err); } catch (_) {}
  setTimeout(() => process.exit(1), 1500);
});

module.exports = { garantirTabelaErros, limparErrosAntigos, registrarErro };
