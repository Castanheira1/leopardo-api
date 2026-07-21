// Dashboard executivo do DONO DA EMPRESA (super admin: matrículas em
// SUPER_ADMIN_MATRICULAS, ex. 900000): visão consolidada de TODOS os projetos
// para reunião — aderência, custo por km/viagem/colaborador, execução total x
// parcial, recusas da fila, pico por hora e km/dia.
// Contrato é FIXO por projeto: quanto mais gente usa, menor o custo unitário.
require("dotenv").config();
const app = require("../app");
const { pool } = require("../db");
const { exigirSuperAdmin, verificarAdmin, verificarAuth } = require("../auth");
const { periodoFromQuery } = require("../datas");

const DIAS_MES = 30.44; // média civil — prorrateia o contrato mensal no período

app.get("/api/admin/dono/dashboard", verificarAuth, verificarAdmin, exigirSuperAdmin, async (req, res) => {
  const periodo = periodoFromQuery(req.query.de, req.query.ate);
  if (!periodo) return res.status(400).json({ error: "Período inválido" });
  const par = [periodo.de, periodo.ate];
  // Janela da viagem: mesma regra do rateio (finalização; antigas caem no início).
  const noPeriodo = "COALESCE(v.finalizada_em, v.iniciada_em) >= $1::timestamptz AND COALESCE(v.finalizada_em, v.iniciada_em) < $2::timestamptz";
  try {
    // qSegura: cold start / coluna opcional não derruba o dashboard inteiro.
    const qSegura = async (sql, params) => {
      try {
        return await pool.query(sql, params);
      } catch (err) {
        console.warn("dashboard dono query:", err.message);
        return { rows: [] };
      }
    };
    const [projetos, usuarios, engajados, viagens, pico, sexo, pedidos, fila, porDia] = await Promise.all([
      qSegura(`
        SELECT id, nome, codigo, COALESCE(ativo, TRUE) AS ativo,
               COALESCE(valor_contrato_mensal, 0)::float8 AS contrato
        FROM projetos ORDER BY nome`),
      qSegura(`
        SELECT projeto_id, COUNT(*)::int AS cadastrados,
               COUNT(*) FILTER (WHERE COALESCE(ativo, TRUE))::int AS ativos
        FROM usuarios WHERE projeto_id IS NOT NULL GROUP BY projeto_id`),
      // Aderência: quem PARTICIPOU no período (viajou, pediu ou ofertou carona).
      qSegura(`
        SELECT u.projeto_id, COUNT(DISTINCT u.id)::int AS engajados
        FROM usuarios u
        WHERE u.id IN (
          SELECT v.motorista_id FROM viagens v WHERE ${noPeriodo}
          UNION SELECT v.passageiro_id FROM viagens v WHERE ${noPeriodo}
          UNION SELECT p.passageiro_id FROM pedidos p WHERE p.created_at >= $1::timestamptz AND p.created_at < $2::timestamptz
          UNION SELECT c.motorista_id FROM caronas c WHERE c.created_at >= $1::timestamptz AND c.created_at < $2::timestamptz
        )
        GROUP BY u.projeto_id`, par),
      qSegura(`
        SELECT m.projeto_id,
               COUNT(*) FILTER (WHERE v.status = 'concluida')::int AS concluidas,
               COUNT(*) FILTER (WHERE v.status = 'concluida' AND v.destino_motorista_lat IS NOT NULL)::int AS parciais,
               COUNT(*) FILTER (WHERE v.status = 'cancelada')::int AS canceladas,
               COALESCE(SUM(v.distancia_km) FILTER (WHERE v.status = 'concluida' AND COALESCE(v.deslocamento_valido, TRUE)), 0)::float8 AS km
        FROM viagens v JOIN usuarios m ON m.id = v.motorista_id
        WHERE ${noPeriodo}
        GROUP BY m.projeto_id`, par),
      // Pico por hora local (a sessão do pool já roda no fuso do canteiro).
      qSegura(`
        SELECT m.projeto_id, EXTRACT(HOUR FROM v.iniciada_em)::int AS hora, COUNT(*)::int AS viagens
        FROM viagens v JOIN usuarios m ON m.id = v.motorista_id
        WHERE ${noPeriodo}
        GROUP BY 1, 2`, par),
      // Passageiros transportados por sexo (viagens concluídas).
      qSegura(`
        SELECT m.projeto_id, COALESCE(pa.sexo, '?') AS sexo, COUNT(*)::int AS n
        FROM viagens v
        JOIN usuarios m ON m.id = v.motorista_id
        JOIN usuarios pa ON pa.id = v.passageiro_id
        WHERE v.status = 'concluida' AND ${noPeriodo}
        GROUP BY 1, 2`, par),
      qSegura(`
        SELECT u.projeto_id, COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE p.status = 'atendido')::int AS atendidos,
               COUNT(*) FILTER (WHERE p.status = 'cancelado')::int AS frustrados
        FROM pedidos p JOIN usuarios u ON u.id = p.passageiro_id
        WHERE p.created_at >= $1::timestamptz AND p.created_at < $2::timestamptz
        GROUP BY u.projeto_id`, par),
      qSegura(`
        SELECT u.projeto_id,
               COUNT(*) FILTER (WHERE f.status = 'recusada')::int AS recusas,
               COUNT(*) FILTER (WHERE f.status = 'expirada')::int AS expiradas
        FROM pedido_fila f JOIN usuarios u ON u.id = f.motorista_id
        WHERE f.created_at >= $1::timestamptz AND f.created_at < $2::timestamptz
        GROUP BY u.projeto_id`, par),
      qSegura(`
        SELECT m.projeto_id, date_trunc('day', COALESCE(v.finalizada_em, v.iniciada_em)) AS dia,
               COUNT(*) FILTER (WHERE v.status = 'concluida')::int AS viagens,
               COALESCE(SUM(v.distancia_km) FILTER (WHERE v.status = 'concluida' AND COALESCE(v.deslocamento_valido, TRUE)), 0)::float8 AS km
        FROM viagens v JOIN usuarios m ON m.id = v.motorista_id
        WHERE ${noPeriodo}
        GROUP BY 1, 2 ORDER BY 2`, par),
    ]);

    if (!projetos.rows.length) {
      // Projetos é o mínimo; se falhou de vez, avisa de forma clara.
      return res.status(500).json({ error: "Não foi possível listar os projetos" });
    }

    const porProjeto = (rows) => {
      const m = new Map();
      for (const r of rows) m.set(r.projeto_id, r);
      return m;
    };
    const mUsuarios = porProjeto(usuarios.rows);
    const mEngajados = porProjeto(engajados.rows);
    const mViagens = porProjeto(viagens.rows);
    const mPedidos = porProjeto(pedidos.rows);
    const mFila = porProjeto(fila.rows);

    const dias = Math.max(1, (new Date(periodo.ate) - new Date(periodo.de)) / 86400000);
    const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
    const div = (a, b) => (b > 0 ? Math.round((a / b) * 100) / 100 : 0);

    const lista = projetos.rows.map((p) => {
      const u = mUsuarios.get(p.id) || { cadastrados: 0, ativos: 0 };
      const e = mEngajados.get(p.id) || { engajados: 0 };
      const v = mViagens.get(p.id) || { concluidas: 0, parciais: 0, canceladas: 0, km: 0 };
      const pd = mPedidos.get(p.id) || { total: 0, atendidos: 0, frustrados: 0 };
      const f = mFila.get(p.id) || { recusas: 0, expiradas: 0 };
      const custoPeriodo = (p.contrato / DIAS_MES) * dias;
      const picoProj = new Array(24).fill(0);
      for (const r of pico.rows) if (r.projeto_id === p.id) picoProj[r.hora] = r.viagens;
      const sx = { m: 0, f: 0 };
      for (const r of sexo.rows) {
        if (r.projeto_id !== p.id) continue;
        if (String(r.sexo).toUpperCase().startsWith("M")) sx.m += r.n;
        else if (String(r.sexo).toUpperCase().startsWith("F")) sx.f += r.n;
      }
      return {
        id: p.id, nome: p.nome, codigo: p.codigo, ativo: p.ativo,
        contrato_mensal: p.contrato,
        usuarios: {
          cadastrados: u.cadastrados, ativos: u.ativos, engajados: e.engajados,
          aderencia_pct: pct(e.engajados, u.ativos),
        },
        viagens: {
          concluidas: v.concluidas, parciais: v.parciais,
          totais: v.concluidas - v.parciais, canceladas: v.canceladas,
          km: Math.round(v.km * 10) / 10,
          km_dia: div(v.km, dias), por_dia: div(v.concluidas, dias),
        },
        pedidos: {
          total: pd.total, atendidos: pd.atendidos, frustrados: pd.frustrados,
          taxa_atendimento_pct: pct(pd.atendidos, pd.total),
        },
        fila: { recusas: f.recusas, expiradas: f.expiradas },
        sexo: sx,
        custo: {
          periodo: Math.round(custoPeriodo * 100) / 100,
          por_viagem: div(custoPeriodo, v.concluidas),
          por_km: div(custoPeriodo, v.km),
          por_colaborador_mes: div(p.contrato, u.ativos),
          por_engajado_mes: div(p.contrato, e.engajados),
        },
        pico: picoProj,
      };
    });

    // Consolidado (soma dos projetos; percentuais recalculados sobre os totais).
    const soma = (fn) => lista.reduce((acc, p) => acc + fn(p), 0);
    const consolidado = {
      projetos: lista.length,
      projetos_ativos: lista.filter((p) => p.ativo).length,
      contrato_mensal: soma((p) => p.contrato_mensal),
      usuarios_ativos: soma((p) => p.usuarios.ativos),
      engajados: soma((p) => p.usuarios.engajados),
      aderencia_pct: pct(soma((p) => p.usuarios.engajados), soma((p) => p.usuarios.ativos)),
      viagens: soma((p) => p.viagens.concluidas),
      km: Math.round(soma((p) => p.viagens.km) * 10) / 10,
      recusas: soma((p) => p.fila.recusas),
      custo_por_km: div((soma((p) => p.contrato_mensal) / DIAS_MES) * dias, soma((p) => p.viagens.km)),
      custo_por_viagem: div((soma((p) => p.contrato_mensal) / DIAS_MES) * dias, soma((p) => p.viagens.concluidas)),
      pico: new Array(24).fill(0).map((_, h) => soma((p) => p.pico[h])),
      sexo: { m: soma((p) => p.sexo.m), f: soma((p) => p.sexo.f) },
    };

    res.json({
      periodo: { de: periodo.deLabel, ate: periodo.ateLabel, dias: Math.round(dias) },
      consolidado,
      projetos: lista,
      por_dia: porDia.rows,
    });
  } catch (e) {
    console.error("dashboard dono:", e.message, e.stack);
    res.status(500).json({
      error: "Erro ao montar o dashboard",
      detalhe: String(e.message || e).slice(0, 200),
    });
  }
});

/**
 * Analisador de uso Google Routes (CEO) — dados do contador rotas_uso + tetos env.
 * Ajuda a decidir se sobe cota, mantém 300/dia ou desliga GOOGLE_ROUTES_ENABLED.
 */
app.get("/api/admin/dono/api-maps", verificarAuth, verificarAdmin, exigirSuperAdmin, async (req, res) => {
  const enabled = /^(1|true|yes|on)$/i.test(String(process.env.GOOGLE_ROUTES_ENABLED || ""));
  // Tetos VIGENTES (painel do dono se houver, senão env) — não reler do env aqui,
  // senão o painel mostraria um número e o servidor aplicaria outro.
  let teto_min = Number(process.env.ROTAS_GOOGLE_MAX_MIN || 30);
  let teto_dia = Number(process.env.ROTAS_GOOGLE_MAX_DIA || 300);
  let teto_mes = Number(process.env.ROTAS_GOOGLE_MAX_MES || 9000);
  let teto_origem = "env";
  let teto_seguranca = null;
  try {
    const cfg = require("./config");
    if (typeof cfg.limitesRotas === "function") {
      const L = await cfg.limitesRotas();
      teto_min = L.min; teto_dia = L.dia; teto_mes = L.mes; teto_origem = L.origem;
      teto_seguranca = cfg.TETO_SEGURANCA || null;
    }
  } catch (_) { /* sem config: fica o env */ }
  // Referência de estouro histórico (métricas GCP jul/2026) — contexto de decisão.
  const referencia_estouro = {
    mes: "2026-07",
    calls_approx: 37253,
    custo_brl_approx: 802,
    nota: "Pico com frota fake + loop GPS (antes dos freios). Não é uso atual.",
  };

  // require tardio: evita depender da ordem de carga das rotas no server.js.
  let rotasEstado = { pausado: false, pausado_ate: null, motivo: null, erros: 0, pausas: 0 };
  try {
    const { estadoRotasGoogle } = require("./config");
    if (typeof estadoRotasGoogle === "function") rotasEstado = estadoRotasGoogle();
  } catch (_) { /* sem estado: painel segue com os contadores do banco */ }

  let usadas_hoje = 0;
  let usadas_mes = 0;
  let por_dia = [];
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rotas_uso (
        dia TEXT PRIMARY KEY,
        n INTEGER NOT NULL DEFAULT 0
      )`).catch(() => {});
    const hoje = new Date().toISOString().slice(0, 10);
    const mesPref = hoje.slice(0, 7) + "%";
    const [tot, serie] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(n) FILTER (WHERE dia = $1), 0)::int AS dia_n,
                COALESCE(SUM(n) FILTER (WHERE dia LIKE $2), 0)::int AS mes_n
           FROM rotas_uso`,
        [hoje, mesPref]
      ),
      pool.query(
        `SELECT dia, n::int AS n FROM rotas_uso
          WHERE dia >= (CURRENT_DATE - INTERVAL '14 days')::text
          ORDER BY dia`
      ),
    ]);
    usadas_hoje = Number(tot.rows[0]?.dia_n || 0);
    usadas_mes = Number(tot.rows[0]?.mes_n || 0);
    por_dia = serie.rows.map((r) => ({ dia: r.dia, n: r.n }));
  } catch (e) {
    console.warn("api-maps rotas_uso:", e.message);
  }

  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
  const pct_dia = pct(usadas_hoje, teto_dia);
  const pct_mes = pct(usadas_mes, teto_mes);

  let nivel = "ok";
  if (!enabled) nivel = "desligado";
  else if (pct_dia >= 90 || pct_mes >= 90) nivel = "critico";
  else if (pct_dia >= 60 || pct_mes >= 60) nivel = "atencao";

  const decisoes = [];
  if (!enabled) {
    decisoes.push({
      tipo: "info",
      titulo: "Routes desligada",
      texto: "GOOGLE_ROUTES_ENABLED≠1 — zero custo de Compute Routes. Mapa usa linha reta. Ligue no Render só se precisar polyline pela pista.",
    });
  } else {
    decisoes.push({
      tipo: "ok",
      titulo: "Routes ligada com teto",
      texto: `Ativa com freios no código (${teto_dia}/dia · ${teto_mes}/mês). Confirme cota no GCP: ComputeRoutes ${teto_dia}/dia.`,
    });
  }
  if (enabled && pct_dia >= 80) {
    decisoes.push({
      tipo: "warn",
      titulo: "Dia perto do teto",
      texto: `${usadas_hoje}/${teto_dia} hoje (${pct_dia}%). Evite testes de carga e frota simulada. Após o teto o app usa reta (sem cobrar mais no código).`,
    });
  }
  if (enabled && pct_mes >= 70) {
    decisoes.push({
      tipo: "warn",
      titulo: "Mês elevado",
      texto: `${usadas_mes}/${teto_mes} no mês (${pct_mes}%). Não suba cota no Google sem orçamento. Prefira locais do catálogo e cache.`,
    });
  }
  if (enabled && pct_dia < 40 && pct_mes < 40) {
    decisoes.push({
      tipo: "ok",
      titulo: "Uso sob controle",
      texto: "Pode manter 300/dia no console. Só aumente cota se usuários reais estiverem caindo em reta com frequência.",
    });
  }
  if (usadas_mes === 0 && enabled) {
    decisoes.push({
      tipo: "info",
      titulo: "Sem uso registrado no contador",
      texto: "Tabela rotas_uso zerada neste mês (ou deploy recente). Métricas do GCP ainda podem mostrar histórico antigo.",
    });
  }
  // Google recusando (billing desligado, API não habilitada, chave restrita):
  // o app cai em linha reta. Sem este aviso, parece "uso baixo" quando é falha.
  if (rotasEstado.pausado) {
    decisoes.push({
      tipo: "warn",
      titulo: "Routes pausada: Google recusou as chamadas",
      texto:
        `O app está servindo LINHA RETA sem chamar a API até ${new Date(rotasEstado.pausado_ate).toLocaleTimeString("pt-BR")}. ` +
        `Motivo: ${rotasEstado.motivo}. Verifique no Google Cloud se o faturamento está ativo e se Routes/Places/Maps JS estão habilitadas para a chave.`,
    });
  } else if (rotasEstado.erros > 0) {
    decisoes.push({
      tipo: "warn",
      titulo: "Chamadas com erro desde o último deploy",
      texto: `${rotasEstado.erros} tentativa(s) falharam e viraram linha reta. A cota foi devolvida ao contador. Se repetir, cheque faturamento e restrições da chave no Google Cloud.`,
    });
  }
  decisoes.push({
    tipo: "hist",
    titulo: "Lembrete do estouro (jul/2026)",
    texto: `~${referencia_estouro.calls_approx.toLocaleString("pt-BR")} calls / ~R$ ${referencia_estouro.custo_brl_approx} em Routes — frota fake + loop. Freios atuais existem para não repetir.`,
  });

  res.json({
    enabled,
    teto_min,
    teto_dia,
    teto_mes,
    usadas_hoje,
    usadas_mes,
    pct_dia,
    pct_mes,
    nivel,
    por_dia,
    decisoes,
    referencia_estouro,
    estado: rotasEstado,
    teto_origem,
    teto_seguranca,
    cota_console: {
      compute_routes_dia: teto_dia,
      compute_routes_min_sugerido: Math.min(50, teto_min),
    },
    atualizado_em: new Date().toISOString(),
  });
});

/**
 * Ajuste dos tetos de Routes pelo painel do dono, sem deploy nem restart.
 *
 * Vale só para a Routes (única API que passa pelo servidor). Mapa, Places e
 * Geocoding são chamados direto do navegador pelo SDK do Google — para esses,
 * a trava é a cota do console, deliberadamente FORA do alcance da aplicação.
 *
 * Os valores são limitados por TETO_SEGURANCA no config.js: um zero a mais
 * digitado por engano não vira fatura.
 */
app.put("/api/admin/dono/api-maps/limites", verificarAuth, verificarAdmin, exigirSuperAdmin, async (req, res) => {
  const cfg = require("./config");
  const teto = cfg.TETO_SEGURANCA || { min: 500, dia: 20000, mes: 300000 };
  const campos = [
    ["rotas_max_min", req.body?.teto_min, teto.min],
    ["rotas_max_dia", req.body?.teto_dia, teto.dia],
    ["rotas_max_mes", req.body?.teto_mes, teto.mes],
  ];

  const gravar = [];
  for (const [chave, bruto, limite] of campos) {
    if (bruto === undefined || bruto === null || bruto === "") continue;
    const n = Number(bruto);
    if (!Number.isFinite(n) || n < 1) {
      return res.status(400).json({ error: `${chave}: informe um número inteiro maior que zero.` });
    }
    if (n > limite) {
      return res.status(400).json({
        error: `${chave}: máximo permitido é ${limite}. Para ir além, altere a variável de ambiente no Render — é uma decisão de orçamento, não de painel.`,
      });
    }
    gravar.push([chave, String(Math.round(n))]);
  }
  if (!gravar.length) return res.status(400).json({ error: "Nada para alterar." });

  try {
    await cfg.garantirTabelaConfig();
    const quem = `${req.user?.matricula || "?"} (${req.user?.nome || "dono"})`;
    for (const [chave, valor] of gravar) {
      await pool.query(
        `INSERT INTO config_app (chave, valor, atualizado_em, atualizado_por)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (chave) DO UPDATE
           SET valor = EXCLUDED.valor, atualizado_em = NOW(), atualizado_por = EXCLUDED.atualizado_por`,
        [chave, valor, quem]
      );
    }
    cfg.invalidarCacheLimites();
    const L = await cfg.limitesRotas();
    console.warn(`[rotas] tetos alterados por ${quem}: ${L.min}/min, ${L.dia}/dia, ${L.mes}/mês`);
    res.json({ success: true, teto_min: L.min, teto_dia: L.dia, teto_mes: L.mes, origem: L.origem });
  } catch (e) {
    console.error("PUT api-maps/limites:", e.message);
    res.status(500).json({ error: "Não foi possível salvar os limites." });
  }
});
