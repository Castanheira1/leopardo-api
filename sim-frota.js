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
//
// Eles também RESPONDEM de verdade, pelos mesmos endpoints do app (token
// assinado internamente + chamada em localhost — nada de duplicar regra):
//   - oferta da fila (busca automática): aceita ~70% / recusa ~30%, com
//     atraso humano de 4-11 s;
//   - proposta direta do passageiro (pediu vaga na carona): idem;
//   - pedido aberto SEM fila: um motorista amarelo por perto oferece carona;
//   - quem aceita DIRIGE até o passageiro (fase encontro), confirma o
//     embarque, segue pro destino gravando pontos GPS e finaliza a viagem.
// E a frota trabalha EM LOOP ancorada no passageiro real: o banco fornece a
// última localização dele (localizacoes_online; senão a origem do pedido
// aberto; senão o centro de Canaã) e TODO carro faz o vai-e-volta
// S11D <-> passageiro pela pista, a 90 km/h exatos — o tempo de cada perna
// é a distância real dividida pela velocidade, em tempo real.

const fs = require("fs");
const path = require("path");

const TICK_MS = 10 * 1000;      // cadência fixa de atualização das posições
const DT_MAX_S = 60;            // servidor dormiu (plano free): não teleporta
const VEL_KMH = 90;             // todos os carros na mesma velocidade real
const SELFIE_REFRESH_MS = 60 * 60 * 1000;
const FOTO_FAKE = "/logo-vap.png";

// Fallback da âncora do loop quando não há passageiro real transmitindo nem
// pedido aberto: centro de Canaã dos Carajás (sede do município).
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

// Polyline codificada do Google (Routes API) -> lista de pontos.
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
// Reduz a polyline mantendo o traçado (pontos a pelo menos ~minKm um do outro).
function decimar(pts, minKm) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (distKm(out[out.length - 1], pts[i]) >= minKm) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
// Anda `passoKm` ao longo da rota a partir do ponto/índice atuais.
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

module.exports = function montarSimFrota({ app, pool, bcrypt, verificarAuth, carregarAdminEscopo, assinarToken, porta }) {
  const LOCAIS_S11D = carregarLocaisS11D();
  let ultimoTick = 0;
  let ultimaSelfie = 0;
  let tickRodando = false;
  let respondendo = false;

  /* ------------------ agir como o motorista fake (API real) ------------------ */
  const tokens = new Map();          // uid -> { token, exp }
  const decisoes = new Map();        // 'fila:ID' | 'prop:ID' -> { quando, aceita, feita }
  const espontaneas = new Map();     // pedidoId -> { em, total }
  const viagemEstado = new Map();    // viagemId -> { chegouEncontroEm, iniciada, finalizada }
  const caminhos = new Map();        // uid -> { chave, pontos (rota real), idx }
  function tokenDe(uid) {
    const t = tokens.get(uid);
    if (t && t.exp > Date.now()) return t.token;
    const token = assinarToken({ id: uid, matricula: "99SIM", is_admin: false });
    tokens.set(uid, { token, exp: Date.now() + 6 * 3600 * 1000 });
    return token;
  }
  async function apiSim(uid, metodo, rota, body) {
    try {
      const r = await fetch(`http://127.0.0.1:${porta}${rota}`, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${tokenDe(uid)}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return r.status;
    } catch (e) {
      console.warn("sim-frota apiSim:", rota, e.message);
      return 0;
    }
  }
  // Decide uma vez (com atraso humano) e executa uma vez.
  function agir(chave, probAceite, executar) {
    let d = decisoes.get(chave);
    if (!d) {
      d = { quando: Date.now() + rnd(4000, 11000), aceita: Math.random() < probAceite, feita: false };
      decisoes.set(chave, d);
      if (decisoes.size > 800) {
        for (const k of decisoes.keys()) { decisoes.delete(k); if (decisoes.size <= 400) break; }
      }
    }
    if (!d.feita && Date.now() >= d.quando) { d.feita = true; executar(d.aceita); }
  }

  // Responde ofertas/propostas dirigidas aos fake — roda mais rápido que o
  // tick de movimento pra resposta parecer gente (a oferta da fila expira).
  async function responder() {
    if (respondendo) return;
    respondendo = true;
    try {
      const sims = (await pool.query("SELECT usuario_id, modo FROM sim_frota")).rows;
      if (!sims.length) return;
      const ids = sims.map((s) => s.usuario_id);

      // 1) Busca automática: oferta da fila na vez de um fake.
      const ofertas = await pool.query(
        `SELECT id, motorista_id FROM pedido_fila
         WHERE status = 'ofertada' AND expira_em > NOW() AND motorista_id = ANY($1)`, [ids]
      );
      for (const o of ofertas.rows) {
        agir(`fila:${o.id}`, 0.7, (aceita) =>
          apiSim(o.motorista_id, "POST", `/api/pedido-fila/${o.id}/${aceita ? "aceitar" : "recusar"}`));
      }

      // 2) Passageiro pediu vaga direto na carona de um fake.
      const props = await pool.query(
        `SELECT id, para_usuario_id FROM propostas
         WHERE status = 'pendente' AND para_usuario_id = ANY($1)`, [ids]
      );
      for (const p of props.rows) {
        agir(`prop:${p.id}`, 0.75, (aceita) =>
          apiSim(p.para_usuario_id, "POST", `/api/propostas/${p.id}/${aceita ? "aceitar" : "recusar"}`));
      }

      // 3) Pedido aberto de gente real SEM fila: um amarelo por perto oferece.
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
        )).rows;
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
          apiSim(perto.usuario_id, "POST", "/api/propostas", { pedido_id: ped.id });
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
    // Cache de rotas reais (Routes API): cada par de pontos consulta o Google
    // UMA vez; ida serve pra volta (invertida).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sim_rotas (
        chave TEXT PRIMARY KEY,
        pontos JSONB NOT NULL,
        criado_em TIMESTAMP DEFAULT NOW()
      )`);
  }

  /* --------------------- rota pela pista real (Routes API) --------------------- */
  const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
  const chavePonto = (p) => `${(+p.lat).toFixed(4)},${(+p.lng).toFixed(4)}`;
  const rotasPendentes = new Map();   // dedupe de consultas simultâneas
  async function rotaReal(a, b) {
    const chave = `${chavePonto(a)}|${chavePonto(b)}`;
    const inversa = `${chavePonto(b)}|${chavePonto(a)}`;
    try {
      const hit = await pool.query("SELECT chave, pontos FROM sim_rotas WHERE chave = ANY($1)", [[chave, inversa]]);
      const direta = hit.rows.find((r) => r.chave === chave);
      if (direta) return direta.pontos;
      const inv = hit.rows.find((r) => r.chave === inversa);
      if (inv) return [...inv.pontos].reverse();
    } catch (_) { /* cache indisponível: segue pro cálculo */ }
    if (rotasPendentes.has(chave)) return rotasPendentes.get(chave);
    const promessa = (async () => {
      let pontos = null;
      if (GOOGLE_KEY) {
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
            }),
          });
          const j = await r.json().catch(() => null);
          const enc = j?.routes?.[0]?.polyline?.encodedPolyline;
          if (enc) pontos = decimar(decodificarPolyline(enc), 0.1);
          else if (j?.error) console.warn("sim-frota Routes:", j.error.message || r.status);
        } catch (e) {
          console.warn("sim-frota Routes:", e.message);
        }
      }
      // Sem chave/sem rede/sem rota: linha reta (melhor andar do que parar).
      if (!pontos || pontos.length < 2) pontos = [{ lat: +a.lat, lng: +a.lng }, { lat: +b.lat, lng: +b.lng }];
      try {
        await pool.query(
          "INSERT INTO sim_rotas (chave, pontos) VALUES ($1, $2) ON CONFLICT (chave) DO NOTHING",
          [chave, JSON.stringify(pontos)]
        );
      } catch (_) { /* sem cache, sem drama */ }
      return pontos;
    })().finally(() => rotasPendentes.delete(chave));
    rotasPendentes.set(chave, promessa);
    return promessa;
  }

  // Âncora do loop: a última localização REAL do passageiro, direto do banco
  // (localizacoes_online fresca; senão a origem do pedido aberto mais recente;
  // senão o centro de Canaã). Arredondada a ~11 m pra frota inteira dividir o
  // mesmo cache de rota.
  async function ancoraDoPassageiro() {
    const { rows } = await pool.query(
      `SELECT l.lat, l.lng FROM localizacoes_online l
       JOIN usuarios u ON u.id = l.usuario_id
       WHERE u.matricula NOT LIKE '99SIM%' AND l.atualizado_em > NOW() - INTERVAL '10 minutes'
       ORDER BY l.atualizado_em DESC LIMIT 1`
    );
    let p = rows[0];
    if (!p) {
      const ped = await pool.query(
        `SELECT p.origem_lat AS lat, p.origem_lng AS lng FROM pedidos p
         JOIN usuarios u ON u.id = p.passageiro_id
         WHERE p.status = 'aberto' AND u.matricula NOT LIKE '99SIM%'
         ORDER BY p.created_at DESC LIMIT 1`
      );
      p = ped.rows[0];
    }
    const base = p ? { lat: +p.lat, lng: +p.lng } : CANAA_CENTRO;
    return { lat: +(+base.lat).toFixed(4), lng: +(+base.lng).toFixed(4) };
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
      const idsAtivos = rows.map((r) => r.usuario_id);

      // Viagens em andamento com motorista fake: ele dirige de verdade —
      // encontro (buscar o passageiro) -> embarque -> destino -> finalizar.
      const viagens = (await pool.query(
        `SELECT id, motorista_id, fase, origem_lat, origem_lng, destino_lat, destino_lng
         FROM viagens WHERE status = 'em_andamento' AND motorista_id = ANY($1)`, [idsAtivos]
      )).rows;
      const viagemDe = new Map(viagens.map((v) => [v.motorista_id, v]));

      // Âncora do loop: onde o passageiro real está (fornecida pelo banco).
      // Todo carro faz o vai-e-volta S11D <-> âncora passando perto dele.
      const ancora = await ancoraDoPassageiro();

      const ids = [], lats = [], lngs = [];
      const retargets = [];
      const caronasPraRepublicar = [];
      for (const r of rows) {
        const uid = r.usuario_id;
        const pos = { lat: +r.lat, lng: +r.lng };
        const dest = { lat: +r.dest_lat, lng: +r.dest_lng };
        // 90 km/h exatos: o passo é a velocidade x o tempo REAL decorrido.
        const passo = VEL_KMH * dtS / 3600;
        const viagem = viagemDe.get(uid);
        let nova = pos;
        try {
          if (viagem) {
            // Em corrida: dirige PELA PISTA até o encontro/destino da viagem.
            const noEncontro = viagem.fase === "encontro";
            const alvo = noEncontro
              ? { lat: +viagem.origem_lat, lng: +viagem.origem_lng }
              : { lat: +viagem.destino_lat, lng: +viagem.destino_lng };
            const chave = `v${viagem.id}:${viagem.fase}`;
            let cam = caminhos.get(uid);
            if (!cam || cam.chave !== chave) {
              cam = { chave, pontos: await rotaReal(pos, alvo), idx: 0 };
              caminhos.set(uid, cam);
            }
            const res = avancarNaRota(cam.pontos, cam.idx, pos, passo);
            cam.idx = res.idx;
            nova = res.pos;
            const est = viagemEstado.get(viagem.id) || {};
            if (res.fim || distKm(nova, alvo) < 0.04) {
              nova = alvo;
              if (noEncontro) {
                // Chegou no passageiro: espera uns segundos "embarcando" e confirma.
                if (!est.chegouEncontroEm) est.chegouEncontroEm = agora;
                else if (!est.iniciada && agora - est.chegouEncontroEm > 9000) {
                  est.iniciada = true;
                  apiSim(uid, "POST", `/api/viagens/${viagem.id}/iniciar`);
                }
              } else if (!est.finalizada) {
                est.finalizada = true;
                apiSim(uid, "POST", `/api/viagens/${viagem.id}/finalizar`);
                if (r.modo === "carona") caronasPraRepublicar.push(uid);
                caminhos.delete(uid);
              }
              viagemEstado.set(viagem.id, est);
              if (viagemEstado.size > 300) {
                for (const k of viagemEstado.keys()) { viagemEstado.delete(k); if (viagemEstado.size <= 150) break; }
              }
            } else if (!noEncontro) {
              // Rastro GPS da corrida (conta km depois do embarque) — na pista.
              apiSim(uid, "POST", `/api/viagens/${viagem.id}/pontos`, { pontos: [nova] });
            }
          } else {
            // Loop constante: segue a rota real da perna atual (A = local do
            // S11D; B = âncora do passageiro), sem paradas.
            const chave = `d${chavePonto(dest)}`;
            let cam = caminhos.get(uid);
            // Recalcula se o destino mudou OU se a posição dessincronizou da
            // rota em memória (reinício/ajuste manual): nada de carro saltando
            // de volta pra um caminho velho.
            const dessincronizado = cam && cam.pontos[cam.idx] && distKm(pos, cam.pontos[cam.idx]) > 3;
            if (!cam || cam.chave !== chave || dessincronizado) {
              cam = { chave, pontos: await rotaReal(pos, dest), idx: 0 };
              caminhos.set(uid, cam);
            }
            const res = avancarNaRota(cam.pontos, cam.idx, pos, passo);
            cam.idx = res.idx;
            nova = res.pos;
            if (res.fim) {
              // Fim da perna: dá meia-volta na hora (vai-e-volta constante).
              caminhos.delete(uid);
              const indoB = !r.indo_b;
              let destNovo = indoB ? { lat: +r.b_lat, lng: +r.b_lng } : { lat: +r.a_lat, lng: +r.a_lng };
              // Virando no S11D rumo ao passageiro: se ele se moveu (> 500 m),
              // a ponta B do loop acompanha a âncora nova.
              if (indoB && distKm(destNovo, ancora) > 0.5) {
                destNovo = ancora;
                retargets.push({ id: uid, dest: destNovo, indoB, novaB: ancora, modo: r.modo });
              } else {
                retargets.push({ id: uid, dest: destNovo, indoB });
              }
            }
          }
        } catch (e) {
          console.warn("sim-frota mover:", e.message);
        }
        ids.push(uid);
        lats.push(nova.lat.toFixed(6));
        lngs.push(nova.lng.toFixed(6));
      }

      // Carona consumida numa viagem concluída: publica outra igual (A -> B)
      // pro carro branco continuar no jogo com rota no mapa.
      for (const uid of caronasPraRepublicar) {
        await pool.query(
          `INSERT INTO caronas (motorista_id, origem_texto, origem_lat, origem_lng,
                                destino_texto, destino_lat, destino_lng, vagas, status)
           SELECT s.usuario_id, 'Origem S11D', s.a_lat, s.a_lng, 'Destino combinado', s.b_lat, s.b_lng,
                  1 + (s.usuario_id % 4), 'ativa'
           FROM sim_frota s
           WHERE s.usuario_id = $1
             AND NOT EXISTS (SELECT 1 FROM caronas c WHERE c.motorista_id = $1 AND c.status = 'ativa')`,
          [uid]
        );
      }

      await pool.query(
        `UPDATE localizacoes_online l SET lat = d.lat::numeric, lng = d.lng::numeric, atualizado_em = NOW()
         FROM (SELECT unnest($1::int[]) AS usuario_id, unnest($2::text[]) AS lat, unnest($3::text[]) AS lng) d
         WHERE l.usuario_id = d.usuario_id`,
        [ids, lats, lngs]
      );
      for (const t of retargets) {
        await pool.query(
          `UPDATE sim_frota SET dest_lat = $2, dest_lng = $3, indo_b = COALESCE($4, indo_b),
                  b_lat = COALESCE($5, b_lat), b_lng = COALESCE($6, b_lng)
           WHERE usuario_id = $1`,
          [t.id, t.dest.lat.toFixed(6), t.dest.lng.toFixed(6), t.indoB,
           t.novaB ? t.novaB.lat.toFixed(6) : null, t.novaB ? t.novaB.lng.toFixed(6) : null]
        );
        // Carro branco: a rota publicada acompanha a ponta nova do loop —
        // o destino da carona continua batendo com o caminho de verdade.
        if (t.novaB && t.modo === "carona") {
          await pool.query(
            `UPDATE caronas SET destino_lat = $2, destino_lng = $3
             WHERE motorista_id = $1 AND status = 'ativa'`,
            [t.id, t.novaB.lat.toFixed(6), t.novaB.lng.toFixed(6)]
          );
        }
      }
      // Selfie/foto "do dia" renovadas de hora em hora (regra real: < 12 h);
      // e o cache de rotas fica num teto (rotas de viagem têm pontos únicos).
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
        // Frotas antigas entram no padrão novo: 90 km/h pra todo mundo.
        await pool.query("UPDATE sim_frota SET vel_kmh = $1", [VEL_KMH]);
        ultimaSelfie = Date.now();
      }

      // Cria o que faltar até n.
      const ancoraSeed = await ancoraDoPassageiro();
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

        // Todo carro nasce num local CALIBRADO do S11D (round-robin, sem bolo)
        // e faz o loop A (S11D) <-> B (âncora = onde o passageiro real está).
        const localA = LOCAIS_S11D[(k * 7) % LOCAIS_S11D.length];
        const posIni = jitter(localA, 250);   // nasce "na rua perto" do local, não em cima
        const A = { lat: localA.lat, lng: localA.lng };
        const B = ancoraSeed;
        const vagas = 1 + (k % 4);

        if (modo === "carona") {
          await pool.query(
            `INSERT INTO caronas (motorista_id, origem_texto, origem_lat, origem_lng,
                                  destino_texto, destino_lat, destino_lng, vagas, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ativa')`,
            [uid, localA.nome, A.lat.toFixed(6), A.lng.toFixed(6), "Canaã dos Carajás",
             B.lat.toFixed(6), B.lng.toFixed(6), vagas]
          );
        }
        await pool.query(
          `INSERT INTO localizacoes_online (usuario_id, lat, lng, disponivel, vagas, online_desde, atualizado_em)
           VALUES ($1, $2, $3, TRUE, $4, $5, NOW())
           ON CONFLICT (usuario_id) DO UPDATE SET lat = $2, lng = $3, disponivel = TRUE, vagas = $4, online_desde = $5, atualizado_em = NOW()`,
          [uid, posIni.lat.toFixed(6), posIni.lng.toFixed(6), vagas, modo === "amarelo" ? new Date() : null]
        );
        await pool.query(
          `INSERT INTO sim_frota (usuario_id, modo, dest_lat, dest_lng, a_lat, a_lng, b_lat, b_lng, indo_b, vel_kmh)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9)`,
          [uid, modo, B.lat.toFixed(6), B.lng.toFixed(6), A.lat.toFixed(6), A.lng.toFixed(6),
           B.lat.toFixed(6), B.lng.toFixed(6), VEL_KMH]
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
      caminhos.clear();
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
