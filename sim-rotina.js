/**
 * Rotinas de trabalho da frota fake — independentes do passageiro.
 * Relógio real America/Sao_Paulo; qualquer dia/hora do calendário.
 *
 * Turno dia (~70%): casa → S11D de manhã → frentes → almoço ~11–12 → frentes → casa ~17:20
 * Turno noite (~30%): casa → S11D ~18h → janta noturna → frentes → casa ~06h
 */

const CANAA_CENTRO = { lat: -6.4966, lng: -49.8779 };
const PORTAO_S11D = { lat: -6.42, lng: -50.32 };

// Coordenadas calibradas (locais-favoritos.json) — almoço/janta oficiais.
const RESTAURANTE_ARARA_AZUL = {
  nome: "Restaurante Arara Azul — Usina",
  lat: -6.449452,
  lng: -50.242787,
};
const REFEITORIO_CASTANHEIRA = {
  nome: "Refeitório Castanheira — Mina",
  lat: -6.4144833,
  lng: -50.3206306,
};
const RODOVIARIA_ARARA = {
  nome: "Rodoviária Arara Azul — Usina",
  lat: -6.448992,
  lng: -50.243534,
};
const RODOVIARIA_CASTANHEIRA = {
  nome: "Rodoviária Castanheira — Mina",
  lat: -6.4150501,
  lng: -50.3207222,
};

/** Hubs com acesso por estrada no Google (evitar pins no mato). */
const HUBS_ROTAVEIS = [
  RESTAURANTE_ARARA_AZUL,
  REFEITORIO_CASTANHEIRA,
  RODOVIARIA_ARARA,
  RODOVIARIA_CASTANHEIRA,
  { nome: "Portão S11D", lat: PORTAO_S11D.lat, lng: PORTAO_S11D.lng },
  { nome: "Canaã centro", lat: CANAA_CENTRO.lat, lng: CANAA_CENTRO.lng },
];

/** Busca local calibrado pelo nome (substring, case-insensitive). */
function acharLocal(locais, ...trechos) {
  if (!Array.isArray(locais) || !locais.length) return null;
  for (const t of trechos) {
    const tl = String(t).toLowerCase();
    const found = locais.find((l) => String(l.nome || "").toLowerCase().includes(tl));
    if (found && Number.isFinite(+found.lat) && Number.isFinite(+found.lng)) {
      return { nome: found.nome, lat: +found.lat, lng: +found.lng };
    }
  }
  return null;
}

/** Mantém o NOME do local calibrado, mas move o pin para o hub roteável mais perto. */
function snapRoteavel(local, hubs = HUBS_ROTAVEIS) {
  if (!local || !Number.isFinite(+local.lat)) return { ...HUBS_ROTAVEIS[0] };
  let best = hubs[0];
  let bestD = distKm(local, best);
  for (let i = 1; i < hubs.length; i++) {
    const d = distKm(local, hubs[i]);
    if (d < bestD) {
      bestD = d;
      best = hubs[i];
    }
  }
  return {
    nome: local.nome || best.nome,
    lat: +best.lat,
    lng: +best.lng,
  };
}

const BAIRROS_CANAA = [
  { nome: "Centro", lat: -6.4966, lng: -49.8779 },
  { nome: "Novo Horizonte", lat: -6.5055, lng: -49.8620 },
  { nome: "Vila Salobo", lat: -6.4880, lng: -49.8900 },
  { nome: "Residencial Vale", lat: -6.5120, lng: -49.8710 },
  { nome: "Cidade Nova", lat: -6.4790, lng: -49.8680 },
  { nome: "Parque dos Carajás", lat: -6.5210, lng: -49.8850 },
  { nome: "Bairro da Paz", lat: -6.5030, lng: -49.8490 },
  { nome: "Industrial", lat: -6.4700, lng: -49.9000 },
];

function distKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}

function offsetM(p, metros, angDeg) {
  const th = (angDeg * Math.PI) / 180;
  const cos = Math.cos((p.lat * Math.PI) / 180) || 1;
  return {
    lat: p.lat + (metros * Math.cos(th)) / 111320,
    lng: p.lng + (metros * Math.sin(th)) / (111320 * cos),
  };
}

/** Minutos desde 00:00 em America/Sao_Paulo. */
function minutosAgoraSP(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return h * 60 + m;
}

function diaChaveSP(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function fmtMin(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Janela que pode cruzar meia-noite: [start, end). */
function emJanela(min, start, end) {
  const m = ((min % 1440) + 1440) % 1440;
  const s = ((start % 1440) + 1440) % 1440;
  const e = ((end % 1440) + 1440) % 1440;
  if (s === e) return true;
  if (s < e) return m >= s && m < e;
  return m >= s || m < e;
}

function hashUid(uid) {
  let x = Math.abs(Number(uid) || 1) * 2654435761;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

/**
 * Rotina fixa por carro (determinística no uid).
 * @param {number} uid
 * @param {Array<{nome,lat,lng}>} locaisS11D
 */
function montarRotina(uid, locaisS11D = []) {
  const h = hashUid(uid);
  const locais = locaisS11D.length
    ? locaisS11D
    : [{ nome: "Portão S11D", lat: PORTAO_S11D.lat, lng: PORTAO_S11D.lng }];

  // ~30% noturno
  const turno = (uid % 10) < 3 ? "noite" : "dia";
  const bairro = BAIRROS_CANAA[uid % BAIRROS_CANAA.length];

  // Frentes: nome do catálogo, posição SNAP em hub com estrada (senão mato/reta).
  const w1 = locais[(uid * 7) % locais.length];
  const w2 = locais[(uid * 3 + 5) % locais.length];
  const w3 = locais[(uid * 11 + 2) % locais.length];
  const frente1 = snapRoteavel({ nome: w1.nome || "Frente S11D", lat: +w1.lat, lng: +w1.lng });
  const frente2 = snapRoteavel({ nome: w2.nome || "Frente 2", lat: +w2.lat, lng: +w2.lng });
  const frente3 = snapRoteavel({ nome: w3.nome || "Frente 3", lat: +w3.lat, lng: +w3.lng });

  // Usina / portões = hubs calibrados roteáveis.
  const usina = acharLocal(locais, "Restaurante Arara Azul") || acharLocal(locais, "Rodoviária Arara Azul")
    || { ...RODOVIARIA_ARARA };
  const portao = acharLocal(locais, "Rodoviária Castanheira")
    || { nome: "Rodoviária Castanheira — Mina", lat: RODOVIARIA_CASTANHEIRA.lat, lng: RODOVIARIA_CASTANHEIRA.lng };

  // Restaurantes oficiais (já são hubs de estrada no complexo).
  const arara = acharLocal(locais, "Restaurante Arara Azul") || RESTAURANTE_ARARA_AZUL;
  const castanheira = acharLocal(locais, "Refeitório Castanheira") || REFEITORIO_CASTANHEIRA;
  const restaurante = (uid % 2 === 0) ? arara : castanheira;

  // Casa em bairros de Canaã (cidade tem malha; não snap para a mina).
  const home = offsetM(bairro, 80 + (h % 200), (h % 360));
  home.nome = `Casa · ${bairro.nome}`;

  let saidaCasa, almocoIni, almocoFim, jantaIni, jantaFim, saidaTrab;
  if (turno === "dia") {
    // Saída de casa 06:20–07:35
    saidaCasa = 6 * 60 + 20 + (h % 75);
    // Almoço 11:00–12:20 início, duração 40–70 min → Arara Azul ou Castanheira
    almocoIni = 11 * 60 + (h % 80);
    almocoFim = almocoIni + 40 + (h % 30);
    // Janta no restaurante antes de ir embora (17:00–17:50), depois casa
    jantaIni = 17 * 60 + (h % 30);
    jantaFim = jantaIni + 35 + (h % 20);
    // Saída do trabalho / fim da janta → casa (após janta)
    saidaTrab = jantaFim;
  } else {
    // Noturno: sai de casa 17:40–18:50
    saidaCasa = 17 * 60 + 40 + (h % 70);
    // Sem almoço diurno
    almocoIni = -1;
    almocoFim = -1;
    // Janta / pausa noturna 23:00–00:40 → mesmo Arara Azul ou Castanheira
    jantaIni = 23 * 60 + (h % 50);
    jantaFim = jantaIni + 35 + (h % 25);
    // Fim de turno 05:20–06:25
    saidaTrab = 5 * 60 + 20 + (h % 65);
  }

  return {
    uid,
    turno,
    home,
    portao,
    frente1,
    frente2,
    frente3,
    usina,
    /** @deprecated use restauranteAlmoco / restauranteJanta */
    refeitorio: restaurante,
    restauranteAlmoco: restaurante,
    restauranteJanta: restaurante,
    saidaCasa,
    almocoIni,
    almocoFim,
    jantaIni,
    jantaFim,
    saidaTrab,
    // intervalo entre “passeios” internos na mina (min)
    vagarCadaMin: 18 + (h % 25),
  };
}

/**
 * Dado o relógio (minutos SP), devolve fase + destino alvo.
 * @returns {{ fase: string, dest: {lat,lng,nome}, parado: boolean, vagar: boolean, label: string }}
 */
function faseNoRelogio(rotina, minNow) {
  const m = ((minNow % 1440) + 1440) % 1440;
  const {
    turno, home, portao, frente1, frente2, frente3, usina,
    restauranteAlmoco, restauranteJanta, refeitorio,
    saidaCasa, almocoIni, almocoFim, jantaIni, jantaFim, saidaTrab,
  } = rotina;
  const restAlmoco = restauranteAlmoco || refeitorio;
  const restJanta = restauranteJanta || refeitorio;

  const fimVolta = (saidaTrab + 70) % 1440;

  if (turno === "dia") {
    // Madrugada / noite em casa
    if (m < saidaCasa) {
      return slot("em_casa", home, true, false, "Em casa (antes do expediente)");
    }
    // Indo trabalhar
    if (m < saidaCasa + 70) {
      return slot("indo_trabalho", portao, false, false, "Indo para o S11D");
    }
    // Manhã no sítio / frentes (até almoço)
    if (m < almocoIni) {
      const dest = escolherFrente(rotina, m, [frente1, frente2, usina]);
      return slot("no_trabalho", dest, true, true, `No trabalho · ${dest.nome}`);
    }
    // Almoço · Restaurante Arara Azul ou Refeitório Castanheira
    if (m < almocoFim) {
      return slot("almoco", restAlmoco, true, false, `Almoço · ${restAlmoco.nome}`);
    }
    // Tarde no trabalho até janta
    if (m < jantaIni) {
      const dest = escolherFrente(rotina, m, [frente2, frente3, usina, frente1]);
      return slot("no_trabalho", dest, true, true, `No trabalho · ${dest.nome}`);
    }
    // Janta · mesmo tipo de restaurante calibrado (Arara Azul ou Castanheira)
    if (m < jantaFim) {
      return slot("janta", restJanta, true, false, `Janta · ${restJanta.nome}`);
    }
    // Após janta → casa em Canaã
    if (m < saidaTrab + 70) {
      return slot("indo_casa", home, false, false, "Voltando para casa (Canaã)");
    }
    return slot("em_casa", home, true, false, "Em casa (após expediente)");
  }

  // ---- TURNO NOITE (cruza meia-noite) ----
  if (!emJanela(m, saidaCasa, saidaTrab)) {
    if (emJanela(m, saidaTrab, fimVolta)) {
      return slot("indo_casa", home, false, false, "Fim de plantão · indo para casa");
    }
    return slot("em_casa", home, true, false, "Em casa (fora do plantão noturno)");
  }

  // Plantão ativo: primeiros ~70 min indo ao S11D
  if (emJanela(m, saidaCasa, (saidaCasa + 70) % 1440) && emJanela(m, saidaCasa, saidaTrab)) {
    const desdeSaida = (m - saidaCasa + 1440) % 1440;
    if (desdeSaida < 70) {
      return slot("indo_trabalho", portao, false, false, "Plantão · indo para o S11D");
    }
  }

  // Janta noturna · Arara Azul ou Castanheira (coords calibradas)
  if (emJanela(m, jantaIni, jantaFim)) {
    return slot("janta", restJanta, true, false, `Janta · ${restJanta.nome}`);
  }

  // Antes da janta no plantão
  if (emJanela(m, (saidaCasa + 70) % 1440, jantaIni)) {
    const dest = escolherFrente(rotina, m, [frente1, frente3, usina]);
    return slot("no_trabalho", dest, true, true, `Plantão · ${dest.nome}`);
  }

  // Após janta até fim do plantão
  if (emJanela(m, jantaFim, saidaTrab)) {
    const dest = escolherFrente(rotina, m, [frente2, frente1, usina]);
    return slot("no_trabalho", dest, true, true, `Plantão · ${dest.nome}`);
  }

  if (emJanela(m, saidaTrab, fimVolta)) {
    return slot("indo_casa", home, false, false, "Fim de plantão · indo para casa");
  }

  return slot("em_casa", home, true, false, "Em casa");
}

function slot(fase, dest, parado, vagar, label) {
  return {
    fase,
    dest: { lat: +dest.lat, lng: +dest.lng, nome: dest.nome || "Destino" },
    parado: !!parado,
    vagar: !!vagar,
    label,
  };
}

/** Troca de frente a cada ~20 min de forma estável no relógio. */
function escolherFrente(rotina, minNow, lista) {
  const slot = Math.floor(minNow / (rotina.vagarCadaMin || 20));
  const idx = Math.abs(hashUid(rotina.uid) + slot) % lista.length;
  return lista[idx];
}

/**
 * Destino efetivo de movimento: se parado e já chegou, fica; se vagar, pode
 * mudar frente conforme o relógio (já vem em faseNoRelogio).
 */
function alvoMovimento(rotina, minNow, posAtual) {
  const alvo = faseNoRelogio(rotina, minNow);
  const d = distKm(posAtual, alvo.dest);
  // Se “parado” e já no local (< 250 m), não gera nova rota.
  const chegou = d < 0.25;
  return {
    ...alvo,
    chegou,
    // move se ainda não chegou, mesmo em fase “parado” (está a caminho do estacionamento)
    deveMover: !chegou,
  };
}

module.exports = {
  CANAA_CENTRO,
  PORTAO_S11D,
  RESTAURANTE_ARARA_AZUL,
  REFEITORIO_CASTANHEIRA,
  RODOVIARIA_ARARA,
  RODOVIARIA_CASTANHEIRA,
  HUBS_ROTAVEIS,
  BAIRROS_CANAA,
  acharLocal,
  snapRoteavel,
  distKm,
  offsetM,
  minutosAgoraSP,
  diaChaveSP,
  fmtMin,
  emJanela,
  hashUid,
  montarRotina,
  faseNoRelogio,
  alvoMovimento,
};
