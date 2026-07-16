// Rotas do rateio no painel admin (JSON + export .xlsx).
require("dotenv").config();
const app = require("../app");
const { carregarAdminEscopo, verificarAuth } = require("../auth");
const { periodoFromQuery } = require("../datas");
const { buscarDadosRateioCompleto, gerarWorkbookRateio } = require("../services/rateio");

app.get("/api/admin/rateio", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const periodo = periodoFromQuery(req.query.de, req.query.ate);
  if (!periodo) return res.status(400).json({ error: "Período inválido" });
  const pid = req.adminEscopo.admin_projeto_id;
  const valorContrato = Number(req.adminEscopo.valor_contrato_mensal) || 0;
  try {
    const dados = await buscarDadosRateioCompleto(pid, periodo, valorContrato);
    res.json({
      periodo: dados.periodo,
      valor_contrato_mensal: dados.valor_contrato_mensal,
      totais: dados.totais,
      por_empresa: dados.por_empresa,
      por_centro_custo: dados.por_centro_custo,
      por_usuario: dados.por_usuario,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao calcular rateio" });
  }
});

function slugDataArquivo(val) {
  const s = String(val || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return "data";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

app.get("/api/admin/rateio/export", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const periodo = periodoFromQuery(req.query.de, req.query.ate);
  if (!periodo) return res.status(400).json({ error: "Período inválido" });
  const pid = req.adminEscopo.admin_projeto_id;
  const valorContrato = Number(req.adminEscopo.valor_contrato_mensal) || 0;
  try {
    const dados = await buscarDadosRateioCompleto(pid, periodo, valorContrato);
    const buffer = await gerarWorkbookRateio(dados, {
      projeto_nome: req.adminEscopo.projeto_nome,
      projeto_codigo: req.adminEscopo.projeto_codigo,
    });
    const deSlug = slugDataArquivo(req.query.de || periodo.de);
    const ateSlug = slugDataArquivo(req.query.ate || periodo.ate);
    const cod = (req.adminEscopo.projeto_codigo || "projeto").replace(/[^\w.-]+/g, "_");
    const nomeArq = `Medicao-Rateio-${cod}_${deSlug}_${ateSlug}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${nomeArq}"`);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "no-store");
    res.end(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao exportar planilha" });
  }
});



module.exports = {
  slugDataArquivo,
};
