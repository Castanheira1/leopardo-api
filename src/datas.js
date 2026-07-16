// Datas no fuso do canteiro (parede BR), períodos do admin e horários agendados.
require("dotenv").config();
const { pool } = require("./db");

// Horário vindo do cliente: datetime-local (horário de parede do canteiro, sem UTC).
// Protege contra iOS antigo mandando texto inválido.
function horarioValido(h) {
  if (!h) return null;
  // Date (ex.: coluna timestamp lida pelo node-pg): usa os componentes de parede
  // locais — String(Date) vira "... GMT-0300 (...)" e o Postgres recusa esse texto.
  if (h instanceof Date) {
    if (isNaN(h.getTime())) return null;
    const p = (n) => String(n).padStart(2, "0");
    return `${h.getFullYear()}-${p(h.getMonth() + 1)}-${p(h.getDate())} ${p(h.getHours())}:${p(h.getMinutes())}:${p(h.getSeconds())}`;
  }
  const s = String(h).trim();
  if (!s) return null;
  const local = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (local) return `${local[1]}-${local[2]}-${local[3]} ${local[4]}:${local[5]}:00`;
  if (!isNaN(Date.parse(s))) return s;
  return null;
}

async function pedidoAgendadoFuturo(horario) {
  const h = horarioValido(horario);
  if (!h) return false;
  const { rows } = await pool.query("SELECT ($1::timestamp > NOW()) AS futuro", [h]);
  return !!rows[0]?.futuro;
}


function parseDataCalendario(str) {
  const m = String(str || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  return {
    y, mo, d,
    label: `${String(d).padStart(2, "0")}/${String(mo).padStart(2, "0")}/${y}`,
  };
}

// 00:00 em Brasília (UTC-3) = 03:00 UTC no mesmo dia civil.
function inicioDiaBrUtc(ymd) {
  return new Date(Date.UTC(ymd.y, ymd.mo - 1, ymd.d, 3, 0, 0, 0));
}

function fimDiaBrUtcExclusivo(ymd) {
  return new Date(Date.UTC(ymd.y, ymd.mo - 1, ymd.d + 1, 3, 0, 0, 0));
}

function hojeBrYmd() {
  const agoraBr = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return {
    y: agoraBr.getUTCFullYear(),
    mo: agoraBr.getUTCMonth() + 1,
    d: agoraBr.getUTCDate(),
  };
}

function periodoFromQuery(de, ate) {
  const hoje = hojeBrYmd();
  const deYmd = parseDataCalendario(de) || { ...hoje, mo: hoje.mo, d: 1, label: `01/${String(hoje.mo).padStart(2, "0")}/${hoje.y}` };
  const ateYmd = parseDataCalendario(ate) || {
    ...hoje,
    label: `${String(hoje.d).padStart(2, "0")}/${String(hoje.mo).padStart(2, "0")}/${hoje.y}`,
  };
  const inicio = inicioDiaBrUtc(deYmd);
  const fimExcl = fimDiaBrUtcExclusivo(ateYmd);
  if (isNaN(inicio.getTime()) || isNaN(fimExcl.getTime()) || fimExcl <= inicio) return null;
  return {
    de: inicio.toISOString(),
    ate: fimExcl.toISOString(),
    deLabel: deYmd.label,
    ateLabel: ateYmd.label,
  };
}

function numSeguro(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}


module.exports = {
  horarioValido,
  pedidoAgendadoFuturo,
  parseDataCalendario,
  inicioDiaBrUtc,
  fimDiaBrUtcExclusivo,
  hojeBrYmd,
  periodoFromQuery,
  numSeguro,
};
