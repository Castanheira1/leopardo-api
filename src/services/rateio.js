// Rateio por empresa/centro de custo e geração do Excel (ExcelJS).
require("dotenv").config();
const ExcelJS = require("exceljs");
const { pool } = require("../db");
const { numSeguro } = require("../datas");
const { sqlViagemKmValido, sqlViagemNoPeriodo } = require("../km");

function fmtDataBr(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function fmtDataHoraBr(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

async function buscarDadosRateioCompleto(pid, periodo, valorContrato) {
  const [base, totais, ativosQ, porUsuarioQ, viagensQ, concluidasQ] = await Promise.all([
    pool.query(
      `SELECT
         COALESCE(NULLIF(TRIM(pa.empresa_nome), ''), 'Sem empresa') AS empresa_nome,
         COALESCE(NULLIF(TRIM(pa.centro_custo), ''), 'Sem CC') AS centro_custo,
         COUNT(*)::int AS viagens,
         COALESCE(SUM(v.distancia_km), 0) AS km
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       JOIN usuarios pa ON v.passageiro_id = pa.id
       WHERE m.projeto_id = $1 AND v.status = 'concluida' AND ${sqlViagemKmValido("v")}
         AND ${sqlViagemNoPeriodo("v")}
       GROUP BY 1, 2`,
      [pid, periodo.de, periodo.ate]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS viagens, COALESCE(SUM(v.distancia_km), 0) AS km
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       WHERE m.projeto_id = $1 AND v.status = 'concluida' AND ${sqlViagemKmValido("v")}
         AND ${sqlViagemNoPeriodo("v")}`,
      [pid, periodo.de, periodo.ate]
    ),
    pool.query(
      `SELECT COUNT(DISTINCT sub.uid) AS usuarios_ativos
       FROM (
         SELECT v.motorista_id AS uid FROM viagens v
         JOIN usuarios m ON v.motorista_id = m.id
         WHERE m.projeto_id = $1 AND v.status = 'concluida' AND ${sqlViagemKmValido("v")}
           AND ${sqlViagemNoPeriodo("v")}
         UNION
         SELECT v.passageiro_id FROM viagens v
         JOIN usuarios m ON v.motorista_id = m.id
         WHERE m.projeto_id = $1 AND v.status = 'concluida' AND ${sqlViagemKmValido("v")}
           AND ${sqlViagemNoPeriodo("v")}
       ) sub`,
      [pid, periodo.de, periodo.ate]
    ),
    pool.query(
      `SELECT
         pa.matricula,
         pa.nome,
         COALESCE(NULLIF(TRIM(pa.empresa_nome), ''), 'Sem empresa') AS empresa_nome,
         COALESCE(NULLIF(TRIM(pa.centro_custo), ''), 'Sem CC') AS centro_custo,
         COUNT(*)::int AS viagens,
         COALESCE(SUM(v.distancia_km), 0) AS km
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       JOIN usuarios pa ON v.passageiro_id = pa.id
       WHERE m.projeto_id = $1 AND v.status = 'concluida' AND ${sqlViagemKmValido("v")}
         AND ${sqlViagemNoPeriodo("v")}
       GROUP BY pa.matricula, pa.nome, 3, 4
       ORDER BY viagens DESC, km DESC`,
      [pid, periodo.de, periodo.ate]
    ),
    pool.query(
      `SELECT
         v.id,
         v.iniciada_em,
         v.finalizada_em,
         v.distancia_km,
         m.matricula AS motorista_matricula,
         m.nome AS motorista_nome,
         pa.matricula AS passageiro_matricula,
         pa.nome AS passageiro_nome,
         COALESCE(NULLIF(TRIM(pa.empresa_nome), ''), 'Sem empresa') AS empresa_nome,
         COALESCE(NULLIF(TRIM(pa.centro_custo), ''), 'Sem CC') AS centro_custo
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       JOIN usuarios pa ON v.passageiro_id = pa.id
       WHERE m.projeto_id = $1 AND v.status = 'concluida' AND ${sqlViagemKmValido("v")}
         AND ${sqlViagemNoPeriodo("v")}
       ORDER BY v.finalizada_em DESC`,
      [pid, periodo.de, periodo.ate]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS viagens
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       WHERE m.projeto_id = $1 AND v.status = 'concluida' AND ${sqlViagemNoPeriodo("v")}`,
      [pid, periodo.de, periodo.ate]
    ),
  ]);

  const totalViagens = numSeguro(totais.rows[0].viagens);
  const totalKm = numSeguro(totais.rows[0].km);
  const usuariosAtivos = numSeguro(ativosQ.rows[0].usuarios_ativos);
  const viagensConcluidasPeriodo = numSeguro(concluidasQ.rows[0].viagens);
  const custoPorViagem = totalViagens ? Math.round((valorContrato / totalViagens) * 100) / 100 : 0;

  const porEmpresaMap = {};
  const porCc = [];
  for (const row of base.rows) {
    const share = totalViagens ? row.viagens / totalViagens : 0;
    const custo = Math.round(valorContrato * share * 100) / 100;
    porCc.push({
      empresa_nome: row.empresa_nome,
      centro_custo: row.centro_custo,
      viagens: row.viagens,
      km: Math.round(Number(row.km) * 100) / 100,
      custo_alocado: custo,
      percentual: Math.round(share * 10000) / 100,
    });
    if (!porEmpresaMap[row.empresa_nome]) {
      porEmpresaMap[row.empresa_nome] = { empresa_nome: row.empresa_nome, viagens: 0, km: 0, custo_alocado: 0 };
    }
    porEmpresaMap[row.empresa_nome].viagens += row.viagens;
    porEmpresaMap[row.empresa_nome].km += Number(row.km);
    porEmpresaMap[row.empresa_nome].custo_alocado += custo;
  }
  const porEmpresa = Object.values(porEmpresaMap).map((e) => ({
    ...e,
    km: Math.round(e.km * 100) / 100,
    custo_alocado: Math.round(e.custo_alocado * 100) / 100,
    percentual: totalViagens ? Math.round((e.viagens / totalViagens) * 10000) / 100 : 0,
  })).sort((a, b) => b.viagens - a.viagens);

  const porUsuario = porUsuarioQ.rows.map((row) => {
    const share = totalViagens ? row.viagens / totalViagens : 0;
    return {
      matricula: row.matricula,
      nome: row.nome,
      empresa_nome: row.empresa_nome,
      centro_custo: row.centro_custo,
      viagens: row.viagens,
      km: Math.round(Number(row.km) * 100) / 100,
      custo_alocado: Math.round(valorContrato * share * 100) / 100,
      percentual: Math.round(share * 10000) / 100,
    };
  });

  const viagens = viagensQ.rows.map((row) => ({
    id: row.id,
    iniciada_em: row.iniciada_em,
    finalizada_em: row.finalizada_em,
    distancia_km: Math.round(Number(row.distancia_km) * 100) / 100,
    motorista_matricula: row.motorista_matricula,
    motorista_nome: row.motorista_nome,
    passageiro_matricula: row.passageiro_matricula,
    passageiro_nome: row.passageiro_nome,
    empresa_nome: row.empresa_nome,
    centro_custo: row.centro_custo,
    custo_alocado: custoPorViagem,
  }));

  return {
    periodo: {
      de: periodo.de,
      ate: periodo.ate,
      deLabel: periodo.deLabel,
      ateLabel: periodo.ateLabel,
    },
    valor_contrato_mensal: valorContrato,
    totais: {
      viagens: totalViagens,
      viagens_concluidas_periodo: viagensConcluidasPeriodo,
      km: Math.round(totalKm * 100) / 100,
      usuarios_ativos: usuariosAtivos,
      custo_por_km: totalKm > 0 ? Math.round((valorContrato / totalKm) * 100) / 100 : 0,
      custo_por_usuario: usuariosAtivos > 0 ? Math.round((valorContrato / usuariosAtivos) * 100) / 100 : 0,
      custo_por_viagem: custoPorViagem,
    },
    por_empresa: porEmpresa,
    por_centro_custo: porCc.sort((a, b) => b.viagens - a.viagens),
    por_usuario: porUsuario,
    viagens,
  };
}

const XLS_COR = {
  titulo: "FF0D2137",
  tituloTxt: "FFD4A84B",
  cabecalho: "FF1A3A52",
  cabecalhoTxt: "FFFFFFFF",
  zebra: "FFF8F4EC",
  borda: "FFD4C4A8",
  destaque: "FFB8860B",
};

const XLS_FMT = {
  moeda: '"R$" #,##0.00',
  km: '#,##0.00',
  pct: '0.00"%"',
  inteiro: '#,##0',
};

function xlsEstiloTitulo() {
  return {
    font: { name: "Calibri", size: 16, bold: true, color: { argb: XLS_COR.tituloTxt } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: XLS_COR.titulo } },
    alignment: { vertical: "middle", horizontal: "left", wrapText: true },
  };
}

function xlsEstiloSubtitulo() {
  return {
    font: { name: "Calibri", size: 11, color: { argb: "FF334155" } },
    alignment: { vertical: "middle", wrapText: true },
  };
}

function xlsEstiloCabecalho() {
  return {
    font: { name: "Calibri", size: 11, bold: true, color: { argb: XLS_COR.cabecalhoTxt } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: XLS_COR.cabecalho } },
    alignment: { vertical: "middle", horizontal: "center", wrapText: true },
    border: {
      top: { style: "thin", color: { argb: XLS_COR.borda } },
      left: { style: "thin", color: { argb: XLS_COR.borda } },
      bottom: { style: "medium", color: { argb: XLS_COR.destaque } },
      right: { style: "thin", color: { argb: XLS_COR.borda } },
    },
  };
}

function xlsEstiloCelula(alternar = false, alinhamento = "left") {
  const estilo = {
    font: { name: "Calibri", size: 11, color: { argb: "FF1E293B" } },
    alignment: { vertical: "middle", horizontal: alinhamento, wrapText: true },
    border: {
      top: { style: "hair", color: { argb: XLS_COR.borda } },
      left: { style: "hair", color: { argb: XLS_COR.borda } },
      bottom: { style: "hair", color: { argb: XLS_COR.borda } },
      right: { style: "hair", color: { argb: XLS_COR.borda } },
    },
  };
  if (alternar) {
    estilo.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XLS_COR.zebra } };
  }
  return estilo;
}

function xlsEstiloTotal() {
  return {
    font: { name: "Calibri", size: 11, bold: true, color: { argb: XLS_COR.tituloTxt } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: XLS_COR.titulo } },
    alignment: { vertical: "middle", horizontal: "right" },
    border: {
      top: { style: "medium", color: { argb: XLS_COR.destaque } },
      bottom: { style: "medium", color: { argb: XLS_COR.destaque } },
    },
  };
}

function xlsAplicarCabecalho(ws, rowNum, cols) {
  const row = ws.getRow(rowNum);
  row.height = 28;
  cols.forEach((c, i) => {
    const cell = row.getCell(i + 1);
    cell.value = c;
    cell.style = xlsEstiloCabecalho();
  });
}

function xlsAplicarLinha(ws, rowNum, valores, opts = {}) {
  const row = ws.getRow(rowNum);
  row.height = opts.altura || 22;
  valores.forEach((v, i) => {
    const cell = row.getCell(i + 1);
    cell.value = v;
    const alinh = opts.alinhamentos?.[i] || (typeof v === "number" ? "right" : "left");
    cell.style = xlsEstiloCelula(!!opts.zebra, alinh);
    if (opts.formatos?.[i]) cell.numFmt = opts.formatos[i];
  });
}

function xlsConfigurarAba(ws, colunas) {
  colunas.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width;
    if (c.hidden) ws.getColumn(i + 1).hidden = true;
  });
  ws.views = [{ state: "frozen", ySplit: 0, showGridLines: true }];
}

async function gerarWorkbookRateio(dados, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "VAP";
  wb.created = new Date();
  const geradoEm = fmtDataHoraBr(new Date().toISOString());

  // —— Aba Resumo ——
  const wsResumo = wb.addWorksheet("Resumo", {
    properties: { defaultRowHeight: 22 },
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 },
  });
  xlsConfigurarAba(wsResumo, [
    { width: 28 }, { width: 22 }, { width: 18 }, { width: 18 },
  ]);
  wsResumo.mergeCells("A1:D1");
  const titulo = wsResumo.getCell("A1");
  titulo.value = "Relatório de Medição e Rateio — VAP";
  titulo.style = xlsEstiloTitulo();
  wsResumo.getRow(1).height = 36;

  const info = [
    ["Projeto", meta.projeto_nome || "—", "Código", meta.projeto_codigo || "—"],
    ["Período (de)", dados.periodo.deLabel || fmtDataBr(dados.periodo.de), "Período (até)", dados.periodo.ateLabel || fmtDataBr(dados.periodo.ate)],
    ["Gerado em", geradoEm, "Contrato mensal (R$)", dados.valor_contrato_mensal],
  ];
  let r = 3;
  info.forEach((linha) => {
    const row = wsResumo.getRow(r++);
    row.height = 24;
    linha.forEach((v, i) => {
      const cell = row.getCell(i + 1);
      cell.value = v;
      if (i % 2 === 0) {
        cell.style = {
          ...xlsEstiloSubtitulo(),
          font: { ...xlsEstiloSubtitulo().font, bold: true },
        };
      } else if (typeof v === "number") {
        cell.style = xlsEstiloCelula(false, i === 3 ? "right" : "left");
        if (linha[0].includes("Contrato") || (i === 3 && linha[2]?.includes("Contrato"))) cell.numFmt = XLS_FMT.moeda;
      } else {
        cell.style = xlsEstiloCelula(false, "left");
      }
    });
  });

  r += 1;
  wsResumo.mergeCells(`A${r}:D${r}`);
  const sub = wsResumo.getCell(`A${r}`);
  sub.value = "Indicadores do período (somente viagens com deslocamento GPS válido)";
  sub.style = { ...xlsEstiloSubtitulo(), font: { ...xlsEstiloSubtitulo().font, bold: true, size: 12 } };
  wsResumo.getRow(r).height = 26;
  r++;

  const t = dados.totais;
  const indicadores = [
    ["Viagens válidas (GPS)", numSeguro(t.viagens), "Km percorridos", numSeguro(t.km)],
    ["Usuários ativos", numSeguro(t.usuarios_ativos), "Custo por viagem", numSeguro(t.custo_por_viagem)],
    ["Custo por km", numSeguro(t.custo_por_km), "Custo por usuário", numSeguro(t.custo_por_usuario)],
  ];
  indicadores.forEach((linha) => {
    const row = wsResumo.getRow(r++);
    row.height = 24;
    linha.forEach((v, i) => {
      const cell = row.getCell(i + 1);
      cell.value = numSeguro(v);
      if (i % 2 === 0) {
        cell.style = { ...xlsEstiloSubtitulo(), font: { ...xlsEstiloSubtitulo().font, bold: true } };
      } else if (typeof v === "number" || Number.isFinite(Number(v))) {
        cell.style = xlsEstiloCelula(false, "right");
        cell.numFmt = linha[i - 1].includes("Custo") ? XLS_FMT.moeda
          : linha[i - 1].includes("Km") ? XLS_FMT.km
            : XLS_FMT.inteiro;
      } else {
        cell.style = xlsEstiloCelula(false, "left");
      }
    });
  });

  const conclSemGps = numSeguro(t.viagens_concluidas_periodo) - numSeguro(t.viagens);
  if (numSeguro(t.viagens) === 0 || conclSemGps > 0) {
    r += 1;
    wsResumo.mergeCells(`A${r}:D${r}`);
    const obs = wsResumo.getCell(`A${r}`);
    obs.value = numSeguro(t.viagens) === 0
      ? `Observação: ${numSeguro(t.viagens_concluidas_periodo)} viagem(ns) concluída(s) no período, porém nenhuma com deslocamento GPS válido — só essas entram no rateio e na medição.`
      : `Observação: ${conclSemGps} viagem(ns) concluída(s) no período ficaram de fora por não terem deslocamento GPS válido.`;
    obs.style = { ...xlsEstiloSubtitulo(), font: { ...xlsEstiloSubtitulo().font, italic: true, color: { argb: "FF64748B" } } };
    wsResumo.getRow(r).height = 28;
  }

  r += 1;
  wsResumo.mergeCells(`A${r}:D${r}`);
  wsResumo.getCell(`A${r}`).value = "Onde o valor do contrato está sendo empregado (por empresa)";
  wsResumo.getCell(`A${r}`).style = { ...xlsEstiloSubtitulo(), font: { ...xlsEstiloSubtitulo().font, bold: true, size: 12 } };
  wsResumo.getRow(r).height = 26;
  r++;
  xlsAplicarCabecalho(wsResumo, r++, ["Empresa", "Viagens", "% do contrato", "Custo alocado (R$)"]);
  (dados.por_empresa || []).forEach((e, idx) => {
    xlsAplicarLinha(wsResumo, r++, [e.empresa_nome, e.viagens, e.percentual, e.custo_alocado], {
      zebra: idx % 2 === 0,
      formatos: { 1: XLS_FMT.inteiro, 2: XLS_FMT.pct, 3: XLS_FMT.moeda },
      alinhamentos: ["left", "right", "right", "right"],
    });
  });
  if (dados.por_empresa?.length) {
    const totCusto = dados.por_empresa.reduce((s, e) => s + e.custo_alocado, 0);
    const row = wsResumo.getRow(r++);
    row.height = 26;
    ["Total alocado", t.viagens, 100, totCusto].forEach((v, i) => {
      const cell = row.getCell(i + 1);
      cell.value = v;
      cell.style = xlsEstiloTotal();
      if (i === 1) cell.numFmt = XLS_FMT.inteiro;
      if (i === 2) cell.numFmt = XLS_FMT.pct;
      if (i === 3) cell.numFmt = XLS_FMT.moeda;
      if (i === 0) cell.alignment = { vertical: "middle", horizontal: "left" };
    });
  }

  // —— Aba Por Empresa ——
  const wsEmp = wb.addWorksheet("Por Empresa");
  xlsConfigurarAba(wsEmp, [
    { width: 34 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 20 },
  ]);
  let re = 1;
  wsEmp.mergeCells("A1:E1");
  wsEmp.getCell("A1").value = `Rateio por empresa — ${meta.projeto_nome || meta.projeto_codigo}`;
  wsEmp.getCell("A1").style = xlsEstiloTitulo();
  wsEmp.getRow(1).height = 32;
  re = 3;
  xlsAplicarCabecalho(wsEmp, re++, ["Empresa", "Viagens", "Km", "% do contrato", "Custo alocado (R$)"]);
  (dados.por_empresa || []).forEach((e, idx) => {
    xlsAplicarLinha(wsEmp, re++, [e.empresa_nome, e.viagens, e.km, e.percentual, e.custo_alocado], {
      zebra: idx % 2 === 0,
      formatos: { 1: XLS_FMT.inteiro, 2: XLS_FMT.km, 3: XLS_FMT.pct, 4: XLS_FMT.moeda },
      alinhamentos: ["left", "right", "right", "right", "right"],
    });
  });
  wsEmp.views = [{ state: "frozen", ySplit: 3 }];

  // —— Aba Por Centro de Custo ——
  const wsCc = wb.addWorksheet("Por Centro de Custo");
  xlsConfigurarAba(wsCc, [
    { width: 30 }, { width: 26 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 20 },
  ]);
  wsCc.mergeCells("A1:F1");
  wsCc.getCell("A1").value = `Rateio por centro de custo — ${meta.projeto_nome || meta.projeto_codigo}`;
  wsCc.getCell("A1").style = xlsEstiloTitulo();
  wsCc.getRow(1).height = 32;
  let rc = 3;
  xlsAplicarCabecalho(wsCc, rc++, ["Empresa", "Centro de custo", "Viagens", "Km", "% do contrato", "Custo alocado (R$)"]);
  (dados.por_centro_custo || []).forEach((c, idx) => {
    xlsAplicarLinha(wsCc, rc++, [c.empresa_nome, c.centro_custo, c.viagens, c.km, c.percentual, c.custo_alocado], {
      zebra: idx % 2 === 0,
      formatos: { 2: XLS_FMT.inteiro, 3: XLS_FMT.km, 4: XLS_FMT.pct, 5: XLS_FMT.moeda },
      alinhamentos: ["left", "left", "right", "right", "right", "right"],
    });
  });
  wsCc.views = [{ state: "frozen", ySplit: 3 }];

  // —— Aba Por Usuário ——
  const wsUsr = wb.addWorksheet("Por Usuário");
  xlsConfigurarAba(wsUsr, [
    { width: 14 }, { width: 28 }, { width: 28 }, { width: 22 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 20 },
  ]);
  wsUsr.mergeCells("A1:H1");
  wsUsr.getCell("A1").value = `Custo por usuário (passageiro) — ${meta.projeto_nome || meta.projeto_codigo}`;
  wsUsr.getCell("A1").style = xlsEstiloTitulo();
  wsUsr.getRow(1).height = 32;
  let ru = 3;
  xlsAplicarCabecalho(wsUsr, ru++, [
    "Matrícula", "Nome", "Empresa", "Centro de custo", "Viagens", "Km", "% do contrato", "Custo alocado (R$)",
  ]);
  (dados.por_usuario || []).forEach((u, idx) => {
    xlsAplicarLinha(wsUsr, ru++, [
      u.matricula, u.nome, u.empresa_nome, u.centro_custo, u.viagens, u.km, u.percentual, u.custo_alocado,
    ], {
      zebra: idx % 2 === 0,
      formatos: { 4: XLS_FMT.inteiro, 5: XLS_FMT.km, 6: XLS_FMT.pct, 7: XLS_FMT.moeda },
      alinhamentos: ["left", "left", "left", "left", "right", "right", "right", "right"],
    });
  });
  wsUsr.views = [{ state: "frozen", ySplit: 3 }];

  // —— Aba Detalhe Viagens ——
  const wsViag = wb.addWorksheet("Detalhe Viagens");
  xlsConfigurarAba(wsViag, [
    { width: 10 }, { width: 18 }, { width: 18 }, { width: 14 }, { width: 22 },
    { width: 14 }, { width: 22 }, { width: 26 }, { width: 20 }, { width: 12 }, { width: 18 },
  ]);
  wsViag.mergeCells("A1:K1");
  wsViag.getCell("A1").value = `Detalhamento viagem a viagem — ${meta.projeto_nome || meta.projeto_codigo}`;
  wsViag.getCell("A1").style = xlsEstiloTitulo();
  wsViag.getRow(1).height = 32;
  let rv = 3;
  xlsAplicarCabecalho(wsViag, rv++, [
    "ID", "Início", "Fim", "Matr. motorista", "Motorista",
    "Matr. passageiro", "Passageiro", "Empresa", "Centro de custo", "Km GPS", "Custo (R$)",
  ]);
  (dados.viagens || []).forEach((v, idx) => {
    xlsAplicarLinha(wsViag, rv++, [
      v.id,
      fmtDataHoraBr(v.iniciada_em),
      fmtDataHoraBr(v.finalizada_em),
      v.motorista_matricula,
      v.motorista_nome,
      v.passageiro_matricula,
      v.passageiro_nome,
      v.empresa_nome,
      v.centro_custo,
      v.distancia_km,
      v.custo_alocado,
    ], {
      zebra: idx % 2 === 0,
      altura: 24,
      formatos: { 9: XLS_FMT.km, 10: XLS_FMT.moeda },
      alinhamentos: ["center", "center", "center", "left", "left", "left", "left", "left", "left", "right", "right"],
    });
  });
  wsViag.views = [{ state: "frozen", ySplit: 3 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}


module.exports = {
  fmtDataBr,
  fmtDataHoraBr,
  buscarDadosRateioCompleto,
  XLS_COR,
  XLS_FMT,
  xlsEstiloTitulo,
  xlsEstiloSubtitulo,
  xlsEstiloCabecalho,
  xlsEstiloCelula,
  xlsEstiloTotal,
  xlsAplicarCabecalho,
  xlsAplicarLinha,
  xlsConfigurarAba,
  gerarWorkbookRateio,
};
