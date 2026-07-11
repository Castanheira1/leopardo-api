// Frota fake para testes visuais — o admin liga/desliga no painel.
//
// ROTINAS DE TRABALHO (independentes do passageiro) — relógio real SP:
//   Turno DIA: casa (Canaã) → S11D de manhã → frentes na mina/usina →
//     almoço ~11–12 → frentes → casa ~17:20
//   Turno NOITE: casa → S11D ~18h → janta noturna → frentes → casa ~06h
// Cada um dos N carros tem rotina própria (bairro, horários, frentes).
// Movimento a 90 km/h pela pista (Routes). Pedido/passageiro NÃO manda no loop.
// Em viagem real (app): prioridade sobre a rotina.
// Matrícula 99SIM; DELETE ?apagar=1 remove tudo.

const fs = require("fs");
const path = require("path");
const rotinaLib = require("./sim-rotina");

const TICK_MS = 5 * 1000;
const DT_MAX_S = 60;
const VEL_KMH = 90;
const SELFIE_REFRESH_MS = 60 * 60 * 1000;
const FOTO_FAKE = "/logo-vap.png";
const SIM_HEADER = "X-Sim-Frota";
// Teto de chamadas Routes da frota fake (compartilha cota com /api/rotas).
const SIM_ROUTES_MAX_MIN = Number(process.env.SIM_ROUTES_MAX_MIN || 12);

const CANAA_CENTRO = { lat: -6.4966, lng: -49.8779 };

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
const round4 = (p) => ({ lat: +(+p.lat).toFixed(4), lng: +(+p.lng).toFixed(4) });

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

/**
 * Ponto estável ao redor da âncora (passageiro / Canaã), por uid.
 * Raio menor (120–450 m) para permanecer em área urbana/vias do Google.
 */
function contornoAoRedor(centro, uid) {
  const id = Math.abs(Number(uid) || 0) || 1;
  const ang = ((id * 47) % 360) * (Math.PI / 180);
  const raioM = 120 + ((id * 13) % 11) * 30; // 120..450 m
  const dLat = (raioM * Math.cos(ang)) / 111320;
  const dLng = (raioM * Math.sin(ang)) / (111320 * Math.cos((centro.lat * Math.PI) / 180) || 1);
  return { lat: centro.lat + dLat, lng: centro.lng + dLng };
}

// Portão na malha do Google (acesso S11D). Pins internos da mina NÃO têm estrada
// no Maps → geravam linha reta no mato. Loop de movimento usa este portão.
const PORTAO_S11D_FIXO = { lat: -6.42, lng: -50.32 };

/** Nascimento perto do portão roteável; nome do local só para o card. */
function posNascimentoS11D(locais, k) {
  const local = locais[(k * 7) % locais.length] || { nome: "S11D", ...PORTAO_S11D_FIXO };
  const raioM = 120 + (k % 8) * 40; // 120..400 m ao redor do PORTÃO (não no mato)
  const ang = ((k * 37) % 360) * (Math.PI / 180);
  const cos = Math.cos((PORTAO_S11D_FIXO.lat * Math.PI) / 180) || 1;
  return {
    local,
    pos: {
      lat: PORTAO_S11D_FIXO.lat + (raioM * Math.cos(ang)) / 111320,
      lng: PORTAO_S11D_FIXO.lng + (raioM * Math.sin(ang)) / (111320 * cos),
    },
    // A do loop = portão (sempre roteável Canaã ↔ mina)
    A: { lat: PORTAO_S11D_FIXO.lat, lng: PORTAO_S11D_FIXO.lng },
  };
}

function decodificarPolyline(str) {
  let idx = 0, lat = 0, lng = 0;
  const pts = [];
  while (idx < str.length) {
    for (const eixo of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (eixo === 0) lat += d; else lng += d;
    }
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pts;
}
function decimar(pts, minKm) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (distKm(out[out.length - 1], pts[i]) >= minKm) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function avancarNaRota(pontos, idx, pos, passoKm) {
  let restante = passoKm;
  let cur = pos;
  while (idx < pontos.length) {
    const alvo = pontos[idx];
    const d = distKm(cur, alvo);
    if (d > restante) {
      const f = restante / d;
      return { pos: { lat: cur.lat + (alvo.lat - cur.lat) * f, lng: cur.lng + (alvo.lng - cur.lng) * f }, idx, fim: false };
    }
    restante -= d;
    cur = alvo;
    idx++;
  }
  return { pos: cur, idx, fim: true };
}

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

function montarSimFrota({ app, pool, bcrypt, verificarAuth, carregarAdminEscopo, assinarToken, porta }) {
  const LOCAIS_S11D = carregarLocaisS11D();
  let ultimoTick = 0;
  let ultimaSelfie = 0;
  let tickRodando = false;
  let respondendo = false;

  const tokens = new Map();
  const decisoes = new Map();
  const espontaneas = new Map();
  const viagemEstado = new Map();
  const caminhos = new Map();
  /** motoristas fake em viagem: disponivel=false mas o tick continua movendo */
  const ocupados = new Set();

  const metricas = {
    api_ok: 0,
    api_fail: 0,
    rota_pista: 0,
    rota_reta: 0,
    aceites: 0,
    recusas: 0,
    embarques: 0,
    finalizacoes: 0,
    pontos_gps: 0,
    ultima_falha: null,
  };
  function metInc(k, n = 1) { metricas[k] = (metricas[k] || 0) + n; }

  function tokenDe(uid) {
    const t = tokens.get(uid);
    if (t && t.exp > Date.now()) return t.token;
    const token = assinarToken({ id: uid, matricula: "99SIM", is_admin: false });
    tokens.set(uid, { token, exp: Date.now() + 6 * 3600 * 1000 });
    return token;
  }

  /** @returns {{ ok: boolean, status: number }} */
  async function apiSim(uid, metodo, rota, body) {
    try {
      const r = await fetch(`http://127.0.0.1:${porta}${rota}`, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${tokenDe(uid)}`,
          [SIM_HEADER]: "1",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.ok) {
        metInc("api_ok");
        return { ok: true, status: r.status };
      }
      let detalhe = "";
      try { detalhe = (await r.text()).slice(0, 180); } catch { /* ignore */ }
      metInc("api_fail");
      metricas.ultima_falha = { em: new Date().toISOString(), status: r.status, rota, detalhe };
      if (r.status !== 404) {
        console.warn(`sim-frota apiSim ${metodo} ${rota} -> ${r.status}`, detalhe);
      }
      return { ok: false, status: r.status };
    } catch (e) {
      metInc("api_fail");
      metricas.ultima_falha = { em: new Date().toISOString(), status: 0, rota, detalhe: e.message };
      console.warn("sim-frota apiSim:", rota, e.message);
      return { ok: false, status: 0 };
    }
  }

  /** Decide uma vez (atraso humano); re-tenta até 3x se a API falhar. */
  async function agir(chave, probAceite, executar) {
    let d = decisoes.get(chave);
    if (!d) {
      d = {
        quando: Date.now() + rnd(4000, 11000),
        aceita: Math.random() < probAceite,
        feita: false,
        tentativas: 0,
      };
      decisoes.set(chave, d);
      if (decisoes.size > 800) {
        for (const k of decisoes.keys()) { decisoes.delete(k); if (decisoes.size <= 400) break; }
      }
    }
    if (d.feita || Date.now() < d.quando || d.tentativas >= 3) return;
    d.tentativas++;
    try {
      const ok = await executar(d.aceita);
      if (ok) {
        d.feita = true;
        if (d.aceita) metInc("aceites");
        else metInc("recusas");
      } else {
        d.quando = Date.now() + 2000;
      }
    } catch (e) {
      console.warn("sim-frota agir:", chave, e.message);
      d.quando = Date.now() + 2000;
    }
  }

  async function responder() {
    if (respondendo) return;
    respondendo = true;
    try {
      const sims = (await pool.query("SELECT usuario_id, modo FROM sim_frota")).rows;
      if (!sims.length) return;
      // Ocupados (em viagem) não respondem nova oferta nem propõem espontâneo.
      const ids = sims.map((s) => s.usuario_id).filter((id) => !ocupados.has(id));
      if (!ids.length) return;

      const ofertas = await pool.query(
        `SELECT id, motorista_id FROM pedido_fila
         WHERE status = 'ofertada' AND expira_em > NOW() AND motorista_id = ANY($1)`, [ids]
      );
      for (const o of ofertas.rows) {
        await agir(`fila:${o.id}`, 0.7, async (aceita) => {
          const r = await apiSim(o.motorista_id, "POST", `/api/pedido-fila/${o.id}/${aceita ? "aceitar" : "recusar"}`);
          return r.ok;
        });
      }

      const props = await pool.query(
        `SELECT id, para_usuario_id FROM propostas
         WHERE status = 'pendente' AND para_usuario_id = ANY($1)`, [ids]
      );
      for (const p of props.rows) {
        await agir(`prop:${p.id}`, 0.75, async (aceita) => {
          const r = await apiSim(p.para_usuario_id, "POST", `/api/propostas/${p.id}/${aceita ? "aceitar" : "recusar"}`);
          return r.ok;
        });
      }

      const pedidos = await pool.query(
        `SELECT p.id, p.origem_lat, p.origem_lng FROM pedidos p
         JOIN usuarios u ON u.id = p.passageiro_id
         WHERE p.status = 'aberto' AND u.matricula NOT LIKE '99SIM%'
           AND p.created_at BETWEEN NOW() - INTERVAL '30 minutes' AND NOW() - INTERVAL '15 seconds'
           AND NOT EXISTS (SELECT 1 FROM pedido_fila f WHERE f.pedido_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM propostas pr WHERE pr.pedido_id = p.id AND pr.status IN ('pendente', 'aceito'))`
      );
      if (pedidos.rows.length) {
        const amarelos = (await pool.query(
          `SELECT s.usuario_id, l.lat, l.lng FROM sim_frota s
           JOIN localizacoes_online l ON l.usuario_id = s.usuario_id
           WHERE s.modo = 'amarelo' AND l.disponivel = TRUE`
        )).rows.filter((a) => !ocupados.has(a.usuario_id));
        for (const ped of pedidos.rows) {
          const ctl = espontaneas.get(ped.id) || { em: 0, total: 0 };
          if (ctl.total >= 2 || Date.now() - ctl.em < 90 * 1000) continue;
          const origem = { lat: +ped.origem_lat, lng: +ped.origem_lng };
          const perto = amarelos
            .map((a) => ({ ...a, d: distKm(origem, { lat: +a.lat, lng: +a.lng }) }))
            .filter((a) => a.d <= 2.5)
            .sort((a, b) => a.d - b.d)[0];
          if (!perto) continue;
          ctl.em = Date.now(); ctl.total++;
          espontaneas.set(ped.id, ctl);
          const r = await apiSim(perto.usuario_id, "POST", "/api/propostas", { pedido_id: ped.id });
          if (!r.ok) { ctl.total = Math.max(0, ctl.total - 1); espontaneas.set(ped.id, ctl); }
        }
      }
    } catch (e) {
      if (!/sim_frota.*does not exist/i.test(e.message)) console.warn("sim-frota responder:", e.message);
    } finally {
      respondendo = false;
    }
  }
  setInterval(responder, 5 * 1000).unref?.();

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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sim_rotas (
        chave TEXT PRIMARY KEY,
        pontos JSONB NOT NULL,
        criado_em TIMESTAMP DEFAULT NOW()
      )`);
  }

  const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
  const chavePonto = (p) => `${(+p.lat).toFixed(4)},${(+p.lng).toFixed(4)}`;
  const rotasPendentes = new Map();

  function pontosSaoReta(pts) {
    return !Array.isArray(pts) || pts.length < 3;
  }

  // Portões na malha viária do Google (muitos pins internos da mina NÃO têm via
  // no Maps e geravam linha reta no mato). Usados como âncora de roteamento.
  const PORTAO_S11D = { lat: -6.42, lng: -50.32 };   // acesso S11D roteável
  const PORTAO_CANAA = { lat: -6.4966, lng: -49.8779 }; // centro Canaã
  const VIA_ESTRADA_S11D = { lat: -6.45, lng: -50.15 };
  const VIA_ESTRADA_CANAA = { lat: -6.50, lng: -49.95 };

  /** Se o pin não for alcançável por carro no Google, usa o portão mais perto. */
  function portaoProximo(p) {
    return distKm(p, PORTAO_S11D) <= distKm(p, PORTAO_CANAA) ? PORTAO_S11D : PORTAO_CANAA;
  }

  let simRoutesJanela = { t0: 0, n: 0 };
  function simRoutesPermitida() {
    const agora = Date.now();
    if (agora - simRoutesJanela.t0 > 60_000) simRoutesJanela = { t0: agora, n: 0 };
    if (simRoutesJanela.n >= SIM_ROUTES_MAX_MIN) return false;
    simRoutesJanela.n++;
    return true;
  }

  async function fetchPolylineDrive(a, b) {
    if (!GOOGLE_KEY) return null;
    if (!simRoutesPermitida()) return null; // economiza cota: usa cache ou fica parado
    try {
      const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_KEY,
          "X-Goog-FieldMask": "routes.polyline.encodedPolyline",
        },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: +a.lat, longitude: +a.lng } } },
          destination: { location: { latLng: { latitude: +b.lat, longitude: +b.lng } } },
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_UNAWARE",
        }),
      });
      const j = await r.json().catch(() => null);
      const enc = j?.routes?.[0]?.polyline?.encodedPolyline;
      if (enc) return decimar(decodificarPolyline(enc), 0.08);
      if (j?.error) console.warn("sim-frota Routes:", j.error.message || r.status);
    } catch (e) {
      console.warn("sim-frota Routes:", e.message);
    }
    return null;
  }

  async function rotaReal(a, b) {
    // NUNCA usa trecho reto pin→estrada (era a regressão: carros no mato).
    // Sempre roteia entre hubs com malha viária no Google.
    const aH = rotinaLib.snapRoteavel({ lat: +a.lat, lng: +a.lng, nome: "A" });
    const bH = rotinaLib.snapRoteavel({ lat: +b.lat, lng: +b.lng, nome: "B" });
    const chave = `${chavePonto(aH)}|${chavePonto(bH)}`;
    const inversa = `${chavePonto(bH)}|${chavePonto(aH)}`;
    try {
      const hit = await pool.query("SELECT chave, pontos FROM sim_rotas WHERE chave = ANY($1)", [[chave, inversa]]);
      const direta = hit.rows.find((r) => r.chave === chave);
      if (direta && !pontosSaoReta(direta.pontos)) { metInc("rota_pista"); return direta.pontos; }
      const inv = hit.rows.find((r) => r.chave === inversa);
      if (inv && !pontosSaoReta(inv.pontos)) { metInc("rota_pista"); return [...inv.pontos].reverse(); }
      if (direta || inv) {
        await pool.query("DELETE FROM sim_rotas WHERE chave = ANY($1)", [[chave, inversa]]).catch(() => {});
      }
    } catch (_) { /* cache indisponível */ }
    if (rotasPendentes.has(chave)) return rotasPendentes.get(chave);
    const promessa = (async () => {
      // Mesmo hub: fica parado (sem reta fantasma).
      if (distKm(aH, bH) < 0.12) {
        return [{ lat: +aH.lat, lng: +aH.lng }, { lat: +bH.lat, lng: +bH.lng }];
      }

      let pontos = await fetchPolylineDrive(aH, bH);

      if (pontosSaoReta(pontos)) {
        const vias = [VIA_ESTRADA_S11D, VIA_ESTRADA_CANAA, PORTAO_S11D, PORTAO_CANAA,
          rotinaLib.RODOVIARIA_ARARA, rotinaLib.RODOVIARIA_CASTANHEIRA];
        for (const via of vias) {
          if (distKm(aH, via) < 0.8 || distKm(bH, via) < 0.8) continue;
          const p1 = await fetchPolylineDrive(aH, via);
          const p2 = await fetchPolylineDrive(via, bH);
          if (!pontosSaoReta(p1) && !pontosSaoReta(p2)) {
            pontos = decimar([...p1, ...p2.slice(1)], 0.08);
            break;
          }
        }
      }

      if (pontosSaoReta(pontos)) {
        // Último recurso: só entre portões conhecidos (nunca pin cru no mato).
        const aR = portaoProximo(aH);
        const bR = portaoProximo(bH);
        if (distKm(aR, bR) > 0.5) {
          pontos = await fetchPolylineDrive(aR, bR);
        }
      }

      if (pontosSaoReta(pontos)) {
        metInc("rota_reta");
        // Não move no mato: repete posição do hub de origem.
        return [{ lat: +aH.lat, lng: +aH.lng }, { lat: +aH.lat, lng: +aH.lng }];
      }
      metInc("rota_pista");
      try {
        await pool.query(
          `INSERT INTO sim_rotas (chave, pontos) VALUES ($1, $2)
           ON CONFLICT (chave) DO UPDATE SET pontos = EXCLUDED.pontos, criado_em = NOW()`,
          [chave, JSON.stringify(pontos)]
        );
      } catch (_) { /* sem cache */ }
      return pontos;
    })().finally(() => rotasPendentes.delete(chave));
    rotasPendentes.set(chave, promessa);
    return promessa;
  }

  /**
   * Âncora do loop (sempre ativa, sem precisar de pedido):
   *   1) GPS vivo de usuário real (não-fake), preferindo o mais recente
   *   2) senão centro de Canaã
   * Pedido aberto é opcional: só preenche destino de carona publicada.
   */
  async function contextoPassageiro() {
    // 1) GPS real fresco — movimento da frota NÃO espera pedido.
    const gps = await pool.query(
      `SELECT l.usuario_id, l.lat, l.lng FROM localizacoes_online l
       JOIN usuarios u ON u.id = l.usuario_id
       WHERE u.matricula NOT LIKE '99SIM%'
         AND COALESCE(u.ativo, TRUE) = TRUE
         AND l.atualizado_em > NOW() - INTERVAL '15 minutes'
       ORDER BY l.atualizado_em DESC LIMIT 1`
    );

    let ancora = round4(CANAA_CENTRO);
    let passageiroId = null;
    if (gps.rows[0]) {
      ancora = round4({ lat: +gps.rows[0].lat, lng: +gps.rows[0].lng });
      passageiroId = gps.rows[0].usuario_id;
    }

    // 2) Pedido aberto (opcional) — só para destino de carona / match.
    let pedidoId = null;
    let origem = ancora;
    let destino = null;
    const ped = await pool.query(
      `SELECT p.id, p.passageiro_id, p.origem_lat, p.origem_lng, p.destino_lat, p.destino_lng
       FROM pedidos p
       JOIN usuarios u ON u.id = p.passageiro_id
       WHERE p.status = 'aberto' AND u.matricula NOT LIKE '99SIM%'
       ORDER BY p.created_at DESC LIMIT 1`
    );
    if (ped.rows[0]) {
      const r = ped.rows[0];
      pedidoId = r.id;
      if (!passageiroId) passageiroId = r.passageiro_id;
      if (r.origem_lat != null && r.origem_lng != null) {
        origem = round4({ lat: +r.origem_lat, lng: +r.origem_lng });
        // Sem GPS vivo, o contorno usa a origem do pedido (ainda em Canaã/região).
        if (!gps.rows[0]) ancora = origem;
      }
      if (r.destino_lat != null && r.destino_lng != null) {
        destino = round4({ lat: +r.destino_lat, lng: +r.destino_lng });
      }
    }

    return { ancora, origem, destino, pedidoId, passageiroId };
  }

  async function marcarOcupado(uid) {
    if (ocupados.has(uid)) return;
    ocupados.add(uid);
    await pool.query(
      `UPDATE localizacoes_online SET disponivel = FALSE, online_desde = NULL, atualizado_em = NOW()
       WHERE usuario_id = $1`,
      [uid]
    );
  }

  async function liberarOcupado(uid, modo) {
    if (!ocupados.has(uid)) return;
    ocupados.delete(uid);
    await pool.query(
      `UPDATE localizacoes_online SET disponivel = TRUE, atualizado_em = NOW(),
              online_desde = CASE WHEN $2 = 'amarelo' THEN NOW() ELSE NULL END
       WHERE usuario_id = $1`,
      [uid, modo]
    );
  }

  /** Card da carona = trajetória atual da rotina (não o GPS do passageiro). */
  async function syncCaronaRotina(uid, origem, destino) {
    await pool.query(
      `UPDATE caronas SET
         origem_texto = $2, origem_lat = $3, origem_lng = $4,
         destino_texto = $5, destino_lat = $6, destino_lng = $7
       WHERE motorista_id = $1 AND status = 'ativa'`,
      [
        uid,
        origem.nome || "Origem", (+origem.lat).toFixed(6), (+origem.lng).toFixed(6),
        destino.nome || "Destino", (+destino.lat).toFixed(6), (+destino.lng).toFixed(6),
      ]
    );
  }

  async function tick() {
    if (tickRodando) return;
    tickRodando = true;
    try {
      // Libera quem terminou/cancelou viagem ANTES do SELECT principal — senão
      // o carro fica disponivel=false, some do tick e nunca volta ao mapa.
      if (ocupados.size) {
        const ocupArr = [...ocupados];
        const ainda = (await pool.query(
          `SELECT motorista_id FROM viagens
           WHERE status = 'em_andamento' AND motorista_id = ANY($1)`,
          [ocupArr]
        )).rows;
        const aindaSet = new Set(ainda.map((r) => r.motorista_id));
        const sairam = ocupArr.filter((id) => !aindaSet.has(id));
        if (sairam.length) {
          const modosOut = (await pool.query(
            "SELECT usuario_id, modo FROM sim_frota WHERE usuario_id = ANY($1)",
            [sairam]
          )).rows;
          const modoMap = new Map(modosOut.map((r) => [r.usuario_id, r.modo]));
          for (const uid of sairam) await liberarOcupado(uid, modoMap.get(uid) || "amarelo");
        }
      }

      // Livres (disponivel) OU em viagem (em_andamento) — senão a corrida
      // parava ao setar disponivel=false.
      const { rows } = await pool.query(
        `SELECT s.usuario_id, s.modo, s.dest_lat, s.dest_lng, s.a_lat, s.a_lng,
                s.b_lat, s.b_lng, s.indo_b, s.vel_kmh, l.lat, l.lng, l.disponivel
         FROM sim_frota s
         JOIN localizacoes_online l ON l.usuario_id = s.usuario_id
         WHERE l.disponivel = TRUE
            OR EXISTS (
                 SELECT 1 FROM viagens v
                 WHERE v.motorista_id = s.usuario_id AND v.status = 'em_andamento'
               )`
      );
      if (!rows.length) { ultimoTick = 0; return; }
      const agora = Date.now();
      const dtS = ultimoTick ? Math.min(DT_MAX_S, (agora - ultimoTick) / 1000) : TICK_MS / 1000;
      ultimoTick = agora;
      const idsAtivos = rows.map((r) => r.usuario_id);

      const viagens = (await pool.query(
        `SELECT id, motorista_id, passageiro_id, fase, origem_lat, origem_lng, destino_lat, destino_lng
         FROM viagens WHERE status = 'em_andamento' AND motorista_id = ANY($1)`, [idsAtivos]
      )).rows;
      const viagemDe = new Map(viagens.map((v) => [v.motorista_id, v]));
      const emViagem = new Set(viagens.map((v) => v.motorista_id));

      for (const uid of emViagem) await marcarOcupado(uid);

      // GPS vivo só para corrida real (encontro com passageiro do app).
      const passIds = [...new Set(viagens.map((v) => v.passageiro_id).filter(Boolean))];
      const passLive = new Map();
      if (passIds.length) {
        const liveRows = (await pool.query(
          `SELECT usuario_id, lat, lng FROM localizacoes_online
           WHERE usuario_id = ANY($1) AND atualizado_em > NOW() - INTERVAL '10 minutes'`,
          [passIds]
        )).rows;
        for (const lr of liveRows) passLive.set(lr.usuario_id, { lat: +lr.lat, lng: +lr.lng });
      }

      const minSP = rotinaLib.minutosAgoraSP(new Date(agora));
      const ids = [], lats = [], lngs = [];
      const retargets = [];
      const caronasPraRepublicar = [];
      const fasesTick = []; // debug admin

      for (const r of rows) {
        const uid = r.usuario_id;
        const pos = { lat: +r.lat, lng: +r.lng };
        const dest = { lat: +r.dest_lat, lng: +r.dest_lng };
        const passo = VEL_KMH * dtS / 3600;
        const viagem = viagemDe.get(uid);
        let nova = pos;
        try {
          if (viagem) {
            const noEncontro = viagem.fase === "encontro";
            let alvo = noEncontro
              ? { lat: +viagem.origem_lat, lng: +viagem.origem_lng }
              : { lat: +viagem.destino_lat, lng: +viagem.destino_lng };
            const est = viagemEstado.get(viagem.id) || {};

            if (noEncontro) {
              const live = passLive.get(viagem.passageiro_id);
              if (live) alvo = live;
              // Passageiro andou > 150 m: recalcula rota até o novo pin.
              if (est.alvoEncontro && distKm(est.alvoEncontro, alvo) > 0.15) {
                caminhos.delete(uid);
              }
              est.alvoEncontro = alvo;
            }

            const chave = `v${viagem.id}:${viagem.fase}:${chavePonto(alvo)}`;
            let cam = caminhos.get(uid);
            if (!cam || cam.chave !== chave) {
              cam = { chave, pontos: await rotaReal(pos, alvo), idx: 0 };
              caminhos.set(uid, cam);
            }
            const res = avancarNaRota(cam.pontos, cam.idx, pos, passo);
            cam.idx = res.idx;
            nova = res.pos;

            if (res.fim || distKm(nova, alvo) < 0.04) {
              nova = alvo;
              if (noEncontro) {
                if (!est.chegouEncontroEm) est.chegouEncontroEm = agora;
                else if (!est.iniciada && agora - est.chegouEncontroEm > 9000) {
                  const rIni = await apiSim(uid, "POST", `/api/viagens/${viagem.id}/iniciar`);
                  if (rIni.ok) {
                    est.iniciada = true;
                    metInc("embarques");
                  }
                }
              } else if (!est.finalizada) {
                const rFin = await apiSim(uid, "POST", `/api/viagens/${viagem.id}/finalizar`, {
                  lat: nova.lat,
                  lng: nova.lng,
                });
                if (rFin.ok) {
                  est.finalizada = true;
                  metInc("finalizacoes");
                  if (r.modo === "carona") caronasPraRepublicar.push(uid);
                  caminhos.delete(uid);
                }
              }
              viagemEstado.set(viagem.id, est);
              if (viagemEstado.size > 300) {
                for (const k of viagemEstado.keys()) { viagemEstado.delete(k); if (viagemEstado.size <= 150) break; }
              }
            } else if (!noEncontro) {
              // Rastro GPS pós-embarque (não bloqueia o tick se falhar).
              apiSim(uid, "POST", `/api/viagens/${viagem.id}/pontos`, { pontos: [nova] })
                .then((rp) => { if (rp.ok) metInc("pontos_gps"); })
                .catch(() => {});
            }
          } else {
            // ROTINA DE TRABALHO (relógio real SP) — não depende do passageiro.
            const rotina = rotinaLib.montarRotina(uid, LOCAIS_S11D);
            const alvo = rotinaLib.alvoMovimento(rotina, minSP, pos);
            fasesTick.push({ uid, fase: alvo.fase, label: alvo.label, turno: rotina.turno });

            // Destino em hub roteável + jitter por uid (evita 50 carros no mesmo pixel).
            const destHub = rotinaLib.snapRoteavel({
              lat: +alvo.dest.lat, lng: +alvo.dest.lng, nome: alvo.dest.nome,
            });
            const destAlvo = rotinaLib.offsetM(destHub, 40 + (uid % 12) * 12, (uid * 47) % 360);
            destAlvo.nome = destHub.nome;
            const posHub = rotinaLib.snapRoteavel(pos);
            const posRota = distKm(pos, posHub) > 0.35 ? posHub : pos;

            if (distKm(dest, destAlvo) > 0.4) {
              retargets.push({
                id: uid,
                dest: destAlvo,
                indoB: alvo.fase.includes("casa") || alvo.fase === "indo_casa" ? false : true,
                novaB: destAlvo,
                modo: r.modo,
                rotinaLabel: alvo.label,
              });
            }

            if (alvo.deveMover || distKm(pos, destAlvo) > 0.25) {
              const destEfetivo = distKm(dest, destAlvo) > 0.4 ? destAlvo : dest;
              const chave = `rot:${alvo.fase}:${chavePonto(destEfetivo)}`;
              let cam = caminhos.get(uid);
              const dessincronizado = cam && cam.pontos[cam.idx] && distKm(posRota, cam.pontos[cam.idx]) > 3;
              if (!cam || cam.chave !== chave || dessincronizado) {
                cam = { chave, pontos: await rotaReal(posRota, destEfetivo), idx: 0 };
                caminhos.set(uid, cam);
              }
              const res = avancarNaRota(cam.pontos, cam.idx, posRota, passo);
              cam.idx = res.idx;
              nova = res.pos;
              if (res.fim || distKm(nova, destEfetivo) < 0.15) {
                nova = destEfetivo;
                caminhos.delete(uid);
              }
            } else {
              // Parado no hub da fase (restaurante/rodoviária), nunca no mato.
              nova = destAlvo;
              caminhos.delete(uid);
            }

            // Card da carona acompanha a rotina.
            if (r.modo === "carona") {
              const o = alvo.fase === "indo_trabalho"
                ? rotina.home
                : (alvo.fase === "indo_casa" ? rotina.portao : { lat: +r.a_lat, lng: +r.a_lng, nome: "S11D" });
              await syncCaronaRotina(uid, {
                lat: o.lat, lng: o.lng,
                nome: o.nome || (alvo.fase === "indo_trabalho" ? "Casa (Canaã)" : "S11D"),
              }, destAlvo);
            }
          }
        } catch (e) {
          console.warn("sim-frota mover:", e.message);
        }
        ids.push(uid);
        lats.push(nova.lat.toFixed(6));
        lngs.push(nova.lng.toFixed(6));
      }

      for (const uid of caronasPraRepublicar) {
        const rot = rotinaLib.montarRotina(uid, LOCAIS_S11D);
        const al = rotinaLib.faseNoRelogio(rot, minSP);
        await pool.query(
          `INSERT INTO caronas (motorista_id, origem_texto, origem_lat, origem_lng,
                                destino_texto, destino_lat, destino_lng, vagas, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ativa')
           ON CONFLICT DO NOTHING`,
          [
            uid,
            "S11D", rot.portao.lat.toFixed(6), rot.portao.lng.toFixed(6),
            al.dest.nome || "Destino", (+al.dest.lat).toFixed(6), (+al.dest.lng).toFixed(6),
            1 + (uid % 4),
          ]
        ).catch(async () => {
          // caronas sem unique em motorista: insert se não houver ativa
          await pool.query(
            `INSERT INTO caronas (motorista_id, origem_texto, origem_lat, origem_lng,
                                  destino_texto, destino_lat, destino_lng, vagas, status)
             SELECT $1, $2, $3, $4, $5, $6, $7, $8, 'ativa'
             WHERE NOT EXISTS (SELECT 1 FROM caronas c WHERE c.motorista_id = $1 AND c.status = 'ativa')`,
            [
              uid,
              "S11D", rot.portao.lat.toFixed(6), rot.portao.lng.toFixed(6),
              al.dest.nome || "Destino", (+al.dest.lat).toFixed(6), (+al.dest.lng).toFixed(6),
              1 + (uid % 4),
            ]
          );
        });
        await pool.query(
          `UPDATE sim_frota SET dest_lat = $2, dest_lng = $3, b_lat = $2, b_lng = $3
           WHERE usuario_id = $1`,
          [uid, (+al.dest.lat).toFixed(6), (+al.dest.lng).toFixed(6)]
        );
      }

      if (ids.length) {
        await pool.query(
          `UPDATE localizacoes_online l SET lat = d.lat::numeric, lng = d.lng::numeric, atualizado_em = NOW()
           FROM (SELECT unnest($1::int[]) AS usuario_id, unnest($2::text[]) AS lat, unnest($3::text[]) AS lng) d
           WHERE l.usuario_id = d.usuario_id`,
          [ids, lats, lngs]
        );
      }

      // Dedup retargets (mesmo uid pode entrar 2x no loop)
      const retMap = new Map();
      for (const t of retargets) retMap.set(t.id, t);
      for (const t of retMap.values()) {
        const bLat = t.novaB ? t.novaB.lat : null;
        const bLng = t.novaB ? t.novaB.lng : null;
        await pool.query(
          `UPDATE sim_frota SET dest_lat = $2, dest_lng = $3, indo_b = COALESCE($4, indo_b),
                  b_lat = COALESCE($5, b_lat), b_lng = COALESCE($6, b_lng)
           WHERE usuario_id = $1`,
          [t.id, t.dest.lat.toFixed(6), t.dest.lng.toFixed(6), t.indoB,
           bLat != null ? (+bLat).toFixed(6) : null, bLng != null ? (+bLng).toFixed(6) : null]
        );
      }

      // Amostra de fases para o painel admin (últimas do tick).
      metricas.rotina_amostra = fasesTick.slice(0, 8);
      metricas.horario_sp = rotinaLib.fmtMin(minSP);
      metricas.dia_sp = rotinaLib.diaChaveSP(new Date(agora));

      if (agora - ultimaSelfie > SELFIE_REFRESH_MS) {
        ultimaSelfie = agora;
        await pool.query(
          `UPDATE habilitacoes_motorista SET selfie_em = NOW(), foto_carro_em = NOW(), data = CURRENT_DATE
           WHERE status = 'ativa' AND motorista_id IN (SELECT usuario_id FROM sim_frota)`
        );
        await pool.query(
          `DELETE FROM sim_rotas WHERE chave IN
             (SELECT chave FROM sim_rotas ORDER BY criado_em DESC OFFSET 2000)`
        ).catch(() => {});
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
      const minSP = rotinaLib.minutosAgoraSP();
      const amostra = [];
      const sims = (await pool.query("SELECT usuario_id, modo FROM sim_frota LIMIT 12")).rows;
      for (const s of sims) {
        const rot = rotinaLib.montarRotina(s.usuario_id, LOCAIS_S11D);
        const al = rotinaLib.faseNoRelogio(rot, minSP);
        amostra.push({
          uid: s.usuario_id,
          modo: s.modo,
          turno: rot.turno,
          fase: al.fase,
          label: al.label,
          saida_casa: rotinaLib.fmtMin(rot.saidaCasa),
          almoco: `${rotinaLib.fmtMin(rot.almocoIni)}–${rotinaLib.fmtMin(rot.almocoFim)}`,
          saida_trab: rotinaLib.fmtMin(rot.saidaTrab),
          casa: rot.home.nome,
        });
      }
      res.json({
        ...rows[0],
        em_viagem: ocupados.size,
        horario_sp: rotinaLib.fmtMin(minSP),
        dia_sp: rotinaLib.diaChaveSP(),
        rotinas: amostra,
        metricas: { ...metricas },
      });
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
      const minSP = rotinaLib.minutosAgoraSP();

      if (existentes.length) {
        const ids = existentes.map((e) => e.usuario_id).filter((id) => !ocupados.has(id));
        if (ids.length) {
          await pool.query(
            `UPDATE localizacoes_online SET disponivel = TRUE, atualizado_em = NOW(),
                    online_desde = CASE WHEN usuario_id IN (SELECT usuario_id FROM sim_frota WHERE modo = 'amarelo') THEN NOW() ELSE NULL END
             WHERE usuario_id = ANY($1)`, [ids]
          );
          // Reposiciona cada carro na fase da rotina no horário REAL de agora.
          for (const uid of ids) {
            const rot = rotinaLib.montarRotina(uid, LOCAIS_S11D);
            const al = rotinaLib.faseNoRelogio(rot, minSP);
            const hub = rotinaLib.snapRoteavel(al.dest);
            // Espalha ao redor do hub (não empilha 50 pins iguais no mapa).
            const pos = rotinaLib.offsetM(hub, 50 + (uid % 15) * 18, (uid * 29) % 360);
            await pool.query(
              `UPDATE localizacoes_online SET lat = $2, lng = $3, atualizado_em = NOW() WHERE usuario_id = $1`,
              [uid, (+pos.lat).toFixed(6), (+pos.lng).toFixed(6)]
            );
            await pool.query(
              `UPDATE sim_frota SET dest_lat = $2, dest_lng = $3, b_lat = $2, b_lng = $3,
                      a_lat = $4, a_lng = $5, indo_b = $6, vel_kmh = $7
               WHERE usuario_id = $1`,
              [
                uid,
                (+al.dest.lat).toFixed(6), (+al.dest.lng).toFixed(6),
                rot.portao.lat.toFixed(6), rot.portao.lng.toFixed(6),
                al.fase === "indo_trabalho" || al.fase === "no_trabalho" || al.fase === "almoco" || al.fase === "janta",
                VEL_KMH,
              ]
            );
            if (existentes.find((e) => e.usuario_id === uid)?.modo === "carona") {
              await syncCaronaRotina(uid, {
                lat: rot.home.lat, lng: rot.home.lng, nome: rot.home.nome,
              }, al.dest);
            }
          }
          caminhos.clear();
        }
        await pool.query(
          `UPDATE habilitacoes_motorista SET status = 'ativa', selfie_em = NOW(), foto_carro_em = NOW(), data = CURRENT_DATE
           WHERE motorista_id = ANY($1)`, [existentes.map((e) => e.usuario_id)]
        );
        await pool.query(
          `UPDATE caronas SET status = 'ativa'
           WHERE motorista_id IN (SELECT usuario_id FROM sim_frota WHERE modo = 'carona')
             AND status = 'cancelada'
             AND id IN (SELECT MAX(id) FROM caronas GROUP BY motorista_id)`
        );
        await pool.query("UPDATE sim_frota SET vel_kmh = $1", [VEL_KMH]);
        ultimaSelfie = Date.now();
      }

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

        const rot = rotinaLib.montarRotina(uid, LOCAIS_S11D);
        const al = rotinaLib.faseNoRelogio(rot, minSP);
        const hub = rotinaLib.snapRoteavel(al.dest);
        const posIni = rotinaLib.offsetM(hub, 50 + (k % 15) * 18, (k * 29) % 360);
        const destIni = { ...hub, nome: al.dest.nome || hub.nome };
        const vagas = 1 + (k % 4);

        if (modo === "carona") {
          await pool.query(
            `INSERT INTO caronas (motorista_id, origem_texto, origem_lat, origem_lng,
                                  destino_texto, destino_lat, destino_lng, vagas, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ativa')`,
            [
              uid,
              rot.home.nome, rot.home.lat.toFixed(6), rot.home.lng.toFixed(6),
              destIni.nome || "Destino", (+destIni.lat).toFixed(6), (+destIni.lng).toFixed(6),
              vagas,
            ]
          );
        }

        await pool.query(
          `INSERT INTO localizacoes_online (usuario_id, lat, lng, disponivel, vagas, online_desde, atualizado_em)
           VALUES ($1, $2, $3, TRUE, $4, $5, NOW())
           ON CONFLICT (usuario_id) DO UPDATE SET lat = $2, lng = $3, disponivel = TRUE, vagas = $4, online_desde = $5, atualizado_em = NOW()`,
          [uid, (+posIni.lat).toFixed(6), (+posIni.lng).toFixed(6), vagas, modo === "amarelo" ? new Date() : null]
        );
        await pool.query(
          `INSERT INTO sim_frota (usuario_id, modo, dest_lat, dest_lng, a_lat, a_lng, b_lat, b_lng, indo_b, vel_kmh)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            uid, modo,
            (+destIni.lat).toFixed(6), (+destIni.lng).toFixed(6),
            rot.portao.lat.toFixed(6), rot.portao.lng.toFixed(6),
            (+destIni.lat).toFixed(6), (+destIni.lng).toFixed(6),
            al.fase !== "indo_casa" && al.fase !== "em_casa",
            VEL_KMH,
          ]
        );
      }
      ultimoTick = 0;
      tick();
      res.json({
        ligada: true,
        total: existentes.length + faltam,
        criados: faltam,
        reativados: existentes.length,
        horario_sp: rotinaLib.fmtMin(minSP),
        dia_sp: rotinaLib.diaChaveSP(),
      });
    } catch (err) {
      console.error("sim-frota ligar:", err);
      res.status(500).json({ error: "Erro ao ligar a frota fake" });
    }
  });

  app.delete("/api/admin/sim-frota", verificarAuth, carregarAdminEscopo, async (req, res) => {
    try {
      await garantirTabelaSim();
      caminhos.clear();
      ocupados.clear();
      if (String(req.query.apagar) === "1") {
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
}

montarSimFrota._helpers = {
  distKm,
  jitter,
  contornoAoRedor,
  posNascimentoS11D,
  decimar,
  decodificarPolyline,
  avancarNaRota,
  round4,
  CANAA_CENTRO,
  VEL_KMH,
  TICK_MS,
  SIM_HEADER,
};

module.exports = montarSimFrota;
