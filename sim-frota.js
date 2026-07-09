// Frota fake para testes visuais — o admin liga/desliga no painel.
//
// Cria N motoristas simulados (metade "modo amarelo" = só online, metade com
// carona/rota publicada) e movimenta todos direto no banco, num tick de 15 s
// dentro do próprio servidor: os carros saem de pontos aleatórios do S11D,
// vêm para a cidade (Canaã dos Carajás), voltam pro S11D e transitam entre os
// locais reais do catálogo (public/locais-favoritos.json). Nenhum tráfego de
// API é gerado — é tudo UPDATE em localizacoes_online, igual a um celular
// de motorista transmitiria.
//
// Regras que o simulador respeita para os carros aparecerem no mapa:
//   - mesmo projeto_id do admin que ligou (visibilidade é por projeto);
//   - habilitação ativa com selfie "válida" (renovada a cada ~1 h pelo tick,
//     a regra real exige < 12 h);
//   - GPS fresco (tick de 15 s <<< 3 min exigidos para carona publicada).
//
// Os usuários fake têm matrícula com prefixo 99SIM, senha aleatória (ninguém
// loga com eles) e podem ser apagados por completo com DELETE ?apagar=1.

const fs = require("fs");
const path = require("path");

const TICK_MS = 15 * 1000;
const DT_MAX_S = 60;            // servidor dormiu (plano free): não teleporta
const SELFIE_REFRESH_MS = 60 * 60 * 1000;
const FOTO_FAKE = "/logo-vap.png";

// Centro e pontos de circulação em Canaã dos Carajás (sede do município).
const CANAA_CENTRO = { lat: -6.4966, lng: -49.8779 };
const CANAA_SPOTS = [
  { nome: "Canaã — Centro", lat: -6.4966, lng: -49.8779 },
  { nome: "Canaã — Av. dos Pioneiros", lat: -6.5021, lng: -49.8834 },
  { nome: "Canaã — Novo Horizonte", lat: -6.4912, lng: -49.8698 },
  { nome: "Canaã — Praça da Bíblia", lat: -6.4945, lng: -49.8752 },
  { nome: "Canaã — Rodoviária", lat: -6.5003, lng: -49.8718 },
  { nome: "Canaã — Setor Industrial", lat: -6.5068, lng: -49.8891 },
  { nome: "Canaã — Vale do Sol", lat: -6.4874, lng: -49.8816 },
  { nome: "Canaã — Saída p/ S11D (PA-160)", lat: -6.4899, lng: -49.8952 },
];

const NOMES = [
  "João", "Maria", "José", "Ana", "Carlos", "Francisca", "Antônio", "Juliana",
  "Paulo", "Fernanda", "Pedro", "Camila", "Lucas", "Patrícia", "Marcos",
  "Aline", "Rafael", "Bruna", "Felipe", "Larissa", "Gustavo", "Vanessa",
  "Rodrigo", "Simone", "Eduardo", "Débora", "Thiago", "Renata", "Bruno",
  "Cristiane", "Diego", "Tatiane", "Vinícius", "Elaine", "André", "Priscila",
  "Leandro", "Michele", "Fábio", "Adriana", "Sérgio", "Luciana", "Márcio",
  "Rosana", "Alex", "Sandra", "Wesley", "Kelly", "Igor", "Natália",
];
const SOBRENOMES = [
  "Silva", "Santos", "Oliveira", "Souza", "Lima", "Pereira", "Costa",
  "Ferreira", "Almeida", "Nascimento", "Araújo", "Ribeiro", "Carvalho",
  "Gomes", "Martins", "Rocha", "Barbosa", "Moura", "Cardoso", "Teixeira",
];
const CARROS = ["Gol", "Onix", "HB20", "Corolla", "Strada", "Saveiro", "Tracker", "Duster", "Kicks", "Argo", "Polo", "Compass"];
const CORES = ["Prata", "Branco", "Preto", "Vermelho", "Cinza", "Azul"];
const EMPRESAS = ["Vale S.A.", "Empreiteira Serra Sul", "Contrato Operações S11D"];

const rnd = (min, max) => min + Math.random() * (max - min);
const sorteio = (arr) => arr[Math.floor(Math.random() * arr.length)];

function distKm(a, b) {
  const R = 6371, dLat = ((b.lat - a.lat) * Math.PI) / 180, dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}
function jitter(p, metros) {
  const r = Math.random() * metros, th = Math.random() * 2 * Math.PI;
  return {
    lat: p.lat + (r * Math.cos(th)) / 111320,
    lng: p.lng + (r * Math.sin(th)) / (111320 * Math.cos((p.lat * Math.PI) / 180)),
  };
}

// Locais reais do S11D, do mesmo catálogo que o app usa.
function carregarLocaisS11D() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "locais-favoritos.json"), "utf8"));
    const grupos = j?.projetos?.S11D?.grupos || [];
    const locais = [];
    grupos.forEach((gr) => (gr.locais || []).forEach((l) => {
      if (l.ref && Number.isFinite(l.ref.lat) && Number.isFinite(l.ref.lng)) {
        locais.push({ nome: l.nome, lat: l.ref.lat, lng: l.ref.lng });
      }
    }));
    return locais;
  } catch (e) {
    console.warn("sim-frota: catálogo de locais indisponível:", e.message);
    return [{ nome: "S11D", lat: -6.428, lng: -50.285 }];
  }
}

module.exports = function montarSimFrota({ app, pool, bcrypt, verificarAuth, carregarAdminEscopo }) {
  const LOCAIS_S11D = carregarLocaisS11D();
  let ultimoTick = 0;
  let ultimaSelfie = 0;
  let tickRodando = false;

  async function garantirTabelaSim() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sim_frota (
        usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
        modo VARCHAR(10) NOT NULL CHECK (modo IN ('amarelo', 'carona')),
        dest_lat NUMERIC(10,6) NOT NULL,
        dest_lng NUMERIC(10,6) NOT NULL,
        a_lat NUMERIC(10,6), a_lng NUMERIC(10,6),
        b_lat NUMERIC(10,6), b_lng NUMERIC(10,6),
        indo_b BOOLEAN DEFAULT TRUE,
        vel_kmh NUMERIC(5,1) NOT NULL
      )`);
  }

  // Próximo destino de um carro amarelo: perto de Canaã transita na cidade ou
  // volta pro S11D; no S11D transita entre locais ou vem pra cidade.
  function proximoDestinoAmarelo(pos) {
    const pertoDaCidade = distKm(pos, CANAA_CENTRO) < 6;
    const vaiPraCidade = pertoDaCidade ? Math.random() < 0.6 : Math.random() < 0.45;
    const alvo = vaiPraCidade ? sorteio(CANAA_SPOTS) : sorteio(LOCAIS_S11D);
    return jitter(alvo, 120);
  }

  /* ------------------------------ tick de movimento ------------------------------ */
  async function tick() {
    if (tickRodando) return;
    tickRodando = true;
    try {
      const { rows } = await pool.query(
        `SELECT s.usuario_id, s.modo, s.dest_lat, s.dest_lng, s.a_lat, s.a_lng,
                s.b_lat, s.b_lng, s.indo_b, s.vel_kmh, l.lat, l.lng
         FROM sim_frota s
         JOIN localizacoes_online l ON l.usuario_id = s.usuario_id
         WHERE l.disponivel = TRUE`
      );
      if (!rows.length) { ultimoTick = 0; return; }
      const agora = Date.now();
      const dtS = ultimoTick ? Math.min(DT_MAX_S, (agora - ultimoTick) / 1000) : TICK_MS / 1000;
      ultimoTick = agora;

      const ids = [], lats = [], lngs = [];
      const retargets = [];
      for (const r of rows) {
        const pos = { lat: +r.lat, lng: +r.lng };
        let dest = { lat: +r.dest_lat, lng: +r.dest_lng };
        const dist = distKm(pos, dest);
        const passo = (+r.vel_kmh * dtS / 3600) * rnd(0.85, 1.15);
        let nova;
        if (passo >= dist - 0.03) {
          // Chegou: escolhe o próximo trecho.
          nova = dest;
          if (r.modo === "carona") {
            const indoB = !r.indo_b;
            dest = indoB ? { lat: +r.b_lat, lng: +r.b_lng } : { lat: +r.a_lat, lng: +r.a_lng };
            retargets.push({ id: r.usuario_id, dest, indoB });
          } else {
            dest = proximoDestinoAmarelo(nova);
            retargets.push({ id: r.usuario_id, dest, indoB: null });
          }
        } else {
          const f = passo / dist;
          nova = jitter({ lat: pos.lat + (dest.lat - pos.lat) * f, lng: pos.lng + (dest.lng - pos.lng) * f }, 12);
        }
        ids.push(r.usuario_id);
        lats.push(nova.lat.toFixed(6));
        lngs.push(nova.lng.toFixed(6));
      }

      await pool.query(
        `UPDATE localizacoes_online l SET lat = d.lat::numeric, lng = d.lng::numeric, atualizado_em = NOW()
         FROM (SELECT unnest($1::int[]) AS usuario_id, unnest($2::text[]) AS lat, unnest($3::text[]) AS lng) d
         WHERE l.usuario_id = d.usuario_id`,
        [ids, lats, lngs]
      );
      for (const t of retargets) {
        await pool.query(
          `UPDATE sim_frota SET dest_lat = $2, dest_lng = $3, indo_b = COALESCE($4, indo_b) WHERE usuario_id = $1`,
          [t.id, t.dest.lat.toFixed(6), t.dest.lng.toFixed(6), t.indoB]
        );
      }
      // Selfie/foto "do dia" renovadas de hora em hora (regra real: < 12 h).
      if (agora - ultimaSelfie > SELFIE_REFRESH_MS) {
        ultimaSelfie = agora;
        await pool.query(
          `UPDATE habilitacoes_motorista SET selfie_em = NOW(), foto_carro_em = NOW(), data = CURRENT_DATE
           WHERE status = 'ativa' AND motorista_id IN (SELECT usuario_id FROM sim_frota)`
        );
      }
    } catch (e) {
      if (!/sim_frota.*does not exist/i.test(e.message)) console.warn("sim-frota tick:", e.message);
    } finally {
      tickRodando = false;
    }
  }
  setInterval(tick, TICK_MS).unref?.();

  /* --------------------------------- endpoints --------------------------------- */
  app.get("/api/admin/sim-frota", verificarAuth, carregarAdminEscopo, async (req, res) => {
    try {
      await garantirTabelaSim();
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE l.disponivel)::int AS ativos,
                COUNT(*) FILTER (WHERE l.disponivel AND s.modo = 'carona')::int AS com_rota,
                MAX(l.atualizado_em) AS ultima_atualizacao
         FROM sim_frota s JOIN localizacoes_online l ON l.usuario_id = s.usuario_id`
      );
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Erro ao consultar a frota fake" });
    }
  });

  app.post("/api/admin/sim-frota", verificarAuth, carregarAdminEscopo, async (req, res) => {
    const n = Math.min(100, Math.max(1, parseInt(req.body?.n, 10) || 50));
    const pid = req.adminEscopo.admin_projeto_id;
    try {
      await garantirTabelaSim();
      const existentes = (await pool.query("SELECT usuario_id, modo FROM sim_frota")).rows;

      // Reativa quem já existe (religar depois de desligar).
      if (existentes.length) {
        const ids = existentes.map((e) => e.usuario_id);
        await pool.query(
          `UPDATE localizacoes_online SET disponivel = TRUE, atualizado_em = NOW(),
                  online_desde = CASE WHEN usuario_id IN (SELECT usuario_id FROM sim_frota WHERE modo = 'amarelo') THEN NOW() ELSE NULL END
           WHERE usuario_id = ANY($1)`, [ids]
        );
        await pool.query(
          `UPDATE habilitacoes_motorista SET status = 'ativa', selfie_em = NOW(), foto_carro_em = NOW(), data = CURRENT_DATE
           WHERE motorista_id = ANY($1)`, [ids]
        );
        await pool.query(
          `UPDATE caronas SET status = 'ativa'
           WHERE motorista_id IN (SELECT usuario_id FROM sim_frota WHERE modo = 'carona')
             AND status = 'cancelada'
             AND id IN (SELECT MAX(id) FROM caronas GROUP BY motorista_id)`
        );
        ultimaSelfie = Date.now();
      }

      // Cria o que faltar até n.
      const faltam = Math.max(0, n - existentes.length);
      const senhaHash = await bcrypt.hash(String(Math.random()).slice(2, 14), 10);
      const uniq = String(Date.now()).slice(-5);
      for (let i = 0; i < faltam; i++) {
        const k = existentes.length + i;
        const nome = `${NOMES[k % NOMES.length]} ${sorteio(SOBRENOMES)} ${sorteio(SOBRENOMES)}`;
        const modo = k % 2 ? "carona" : "amarelo";
        const u = await pool.query(
          `INSERT INTO usuarios (nome, funcao, matricula, telefone, email, senha_hash, sexo,
                                 empresa_nome, projeto_id, ativo, politica_aceita_em, politica_versao)
           VALUES ($1, 'Colaborador', $2, $3, $4, $5, $6, $7, $8, TRUE, NOW(), '1.0')
           RETURNING id`,
          [nome, `99SIM${uniq}${String(k).padStart(2, "0")}`, `94988${String(10000 + k)}`,
           `sim.frota.${uniq}.${k}@vap.fake`, senhaHash, k % 2 ? "M" : "F", sorteio(EMPRESAS), pid]
        );
        const uid = u.rows[0].id;
        const placa = `${String.fromCharCode(65 + (k % 26))}${String.fromCharCode(65 + ((k * 7) % 26))}${String.fromCharCode(65 + ((k * 3) % 26))}${1000 + ((k * 37) % 9000)}`;
        await pool.query(
          `INSERT INTO habilitacoes_motorista (motorista_id, placa, tag, foto_carro_url, foto_carro_em, selfie_url, selfie_em, status)
           VALUES ($1, $2, $3, $4, NOW(), $5, NOW(), 'ativa')`,
          [uid, placa, `${CARROS[k % CARROS.length]} ${CORES[k % CORES.length]}`, FOTO_FAKE, FOTO_FAKE]
        );

        // Metade nasce no S11D, metade na cidade — e cada carona liga um lado ao outro.
        const nasceNoS11D = k % 4 < 2;
        const localA = nasceNoS11D ? sorteio(LOCAIS_S11D) : sorteio(CANAA_SPOTS);
        const localB = nasceNoS11D ? sorteio(CANAA_SPOTS) : sorteio(LOCAIS_S11D);
        const posIni = jitter(localA, 400);
        const A = jitter(localA, 80), B = jitter(localB, 80);
        const vagas = 1 + (k % 4);

        if (modo === "carona") {
          await pool.query(
            `INSERT INTO caronas (motorista_id, origem_texto, origem_lat, origem_lng,
                                  destino_texto, destino_lat, destino_lng, vagas, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ativa')`,
            [uid, localA.nome, A.lat.toFixed(6), A.lng.toFixed(6), localB.nome, B.lat.toFixed(6), B.lng.toFixed(6), vagas]
          );
        }
        await pool.query(
          `INSERT INTO localizacoes_online (usuario_id, lat, lng, disponivel, vagas, online_desde, atualizado_em)
           VALUES ($1, $2, $3, TRUE, $4, $5, NOW())
           ON CONFLICT (usuario_id) DO UPDATE SET lat = $2, lng = $3, disponivel = TRUE, vagas = $4, online_desde = $5, atualizado_em = NOW()`,
          [uid, posIni.lat.toFixed(6), posIni.lng.toFixed(6), vagas, modo === "amarelo" ? new Date() : null]
        );
        const dest = modo === "carona" ? B : proximoDestinoAmarelo(posIni);
        await pool.query(
          `INSERT INTO sim_frota (usuario_id, modo, dest_lat, dest_lng, a_lat, a_lng, b_lat, b_lng, indo_b, vel_kmh)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9)`,
          [uid, modo, dest.lat.toFixed(6), dest.lng.toFixed(6), A.lat.toFixed(6), A.lng.toFixed(6),
           B.lat.toFixed(6), B.lng.toFixed(6), rnd(55, 85).toFixed(1)]
        );
      }
      ultimoTick = 0;
      tick();
      res.json({ ligada: true, total: existentes.length + faltam, criados: faltam, reativados: existentes.length });
    } catch (err) {
      console.error("sim-frota ligar:", err);
      res.status(500).json({ error: "Erro ao ligar a frota fake" });
    }
  });

  app.delete("/api/admin/sim-frota", verificarAuth, carregarAdminEscopo, async (req, res) => {
    try {
      await garantirTabelaSim();
      if (String(req.query.apagar) === "1") {
        // Some por completo: apaga os usuários fake (CASCADE limpa o resto).
        const { rowCount } = await pool.query(
          "DELETE FROM usuarios WHERE id IN (SELECT usuario_id FROM sim_frota)"
        );
        return res.json({ ligada: false, apagados: rowCount });
      }
      await pool.query(
        `UPDATE caronas SET status = 'cancelada'
         WHERE status = 'ativa' AND motorista_id IN (SELECT usuario_id FROM sim_frota)`
      );
      const { rowCount } = await pool.query(
        `UPDATE localizacoes_online SET disponivel = FALSE, online_desde = NULL
         WHERE usuario_id IN (SELECT usuario_id FROM sim_frota)`
      );
      res.json({ ligada: false, desligados: rowCount });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Erro ao desligar a frota fake" });
    }
  });
};
