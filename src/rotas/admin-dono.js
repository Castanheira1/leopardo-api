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
    const [projetos, usuarios, engajados, viagens, pico, sexo, pedidos, fila, porDia] = await Promise.all([
      pool.query(`
        SELECT id, nome, codigo, COALESCE(ativo, TRUE) AS ativo,
               COALESCE(valor_contrato_mensal, 0)::float8 AS contrato
        FROM projetos ORDER BY nome`),
      pool.query(`
        SELECT projeto_id, COUNT(*)::int AS cadastrados,
               COUNT(*) FILTER (WHERE COALESCE(ativo, TRUE))::int AS ativos
        FROM usuarios WHERE projeto_id IS NOT NULL GROUP BY projeto_id`),
      // Aderência: quem PARTICIPOU no período (viajou, pediu ou ofertou carona).
      pool.query(`
        SELECT u.projeto_id, COUNT(DISTINCT u.id)::int AS engajados
        FROM usuarios u
        WHERE u.id IN (
          SELECT v.motorista_id FROM viagens v WHERE ${noPeriodo}
          UNION SELECT v.passageiro_id FROM viagens v WHERE ${noPeriodo}
          UNION SELECT p.passageiro_id FROM pedidos p WHERE p.created_at >= $1::timestamptz AND p.created_at < $2::timestamptz
          UNION SELECT c.motorista_id FROM caronas c WHERE c.created_at >= $1::timestamptz AND c.created_at < $2::timestamptz
        )
        GROUP BY u.projeto_id`, par),
      pool.query(`
        SELECT m.projeto_id,
               COUNT(*) FILTER (WHERE v.status = 'concluida')::int AS concluidas,
               COUNT(*) FILTER (WHERE v.status = 'concluida' AND v.destino_motorista_lat IS NOT NULL)::int AS parciais,
               COUNT(*) FILTER (WHERE v.status = 'cancelada')::int AS canceladas,
               COALESCE(SUM(v.distancia_km) FILTER (WHERE v.status = 'concluida' AND v.deslocamento_valido), 0)::float8 AS km
        FROM viagens v JOIN usuarios m ON m.id = v.motorista_id
        WHERE ${noPeriodo}
        GROUP BY m.projeto_id`, par),
      // Pico por hora local (a sessão do pool já roda no fuso do canteiro).
      pool.query(`
        SELECT m.projeto_id, EXTRACT(HOUR FROM v.iniciada_em)::int AS hora, COUNT(*)::int AS viagens
        FROM viagens v JOIN usuarios m ON m.id = v.motorista_id
        WHERE ${noPeriodo}
        GROUP BY 1, 2`, par),
      // Passageiros transportados por sexo (viagens concluídas).
      pool.query(`
        SELECT m.projeto_id, COALESCE(pa.sexo, '?') AS sexo, COUNT(*)::int AS n
        FROM viagens v
        JOIN usuarios m ON m.id = v.motorista_id
        JOIN usuarios pa ON pa.id = v.passageiro_id
        WHERE v.status = 'concluida' AND ${noPeriodo}
        GROUP BY 1, 2`, par),
      pool.query(`
        SELECT u.projeto_id, COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE p.status = 'atendido')::int AS atendidos,
               COUNT(*) FILTER (WHERE p.status = 'cancelado')::int AS frustrados
        FROM pedidos p JOIN usuarios u ON u.id = p.passageiro_id
        WHERE p.created_at >= $1::timestamptz AND p.created_at < $2::timestamptz
        GROUP BY u.projeto_id`, par),
      pool.query(`
        SELECT u.projeto_id,
               COUNT(*) FILTER (WHERE f.status = 'recusada')::int AS recusas,
               COUNT(*) FILTER (WHERE f.status = 'expirada')::int AS expiradas
        FROM pedido_fila f JOIN usuarios u ON u.id = f.motorista_id
        WHERE f.created_at >= $1::timestamptz AND f.created_at < $2::timestamptz
        GROUP BY u.projeto_id`, par),
      pool.query(`
        SELECT m.projeto_id, date_trunc('day', COALESCE(v.finalizada_em, v.iniciada_em)) AS dia,
               COUNT(*) FILTER (WHERE v.status = 'concluida')::int AS viagens,
               COALESCE(SUM(v.distancia_km) FILTER (WHERE v.status = 'concluida' AND v.deslocamento_valido), 0)::float8 AS km
        FROM viagens v JOIN usuarios m ON m.id = v.motorista_id
        WHERE ${noPeriodo}
        GROUP BY 1, 2 ORDER BY 2`, par),
    ]);

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
    console.error("dashboard dono:", e.message);
    res.status(500).json({ error: "Erro ao montar o dashboard" });
  }
});
