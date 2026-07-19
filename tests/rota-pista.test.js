/**
 * Match por "ponto no caminho" (desvio O→P→D), sem buffer de polilinha que
 * inventava pista e puxava CCP para Portaria→Centro.
 */
const {
  compatRotaPassageiro,
  corredorRotaCaronaKm,
  melhorPontoDeEncaixe,
  pontoNoCaminho,
  pontosNoCaminhoCarona,
  locaisDoProjetoCodigo,
} = require("../src/geo");

const locais = locaisDoProjetoCodigo("S11D");
const by = (parte) => {
  const p = locais.find((l) => l.nome && l.nome.includes(parte));
  if (!p) throw new Error(`Local não encontrado: ${parte}`);
  return p;
};

const mro = by("Armazém MRO");
const c07 = by("Canteiro 07");
const arara = by("Rodoviária Arara Azul");
const rest = by("Restaurante Arara Azul");
const cmd = by("CMD");
const port = by("Portaria S11D");
const centro = by("Central de Operações");
const ccp = by("CCP");
const ofi = by("Oficina Usina");
const c15 = by("Canteiro 15");
const tam = by("Tamanduá");

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("OK:", msg);
  }
}

ok(locais.length >= 20, `catálogo S11D (${locais.length})`);

// --- Caso 1: MRO→C07 vs Arara→CMD = TOTAL (CMD no caminho) ---
ok(pontoNoCaminho(mro.lat, mro.lng, cmd.lat, cmd.lng, c07.lat, c07.lng), "CMD no caminho MRO→C07");
ok(
  compatRotaPassageiro(cmd.lat, cmd.lng, mro.lat, mro.lng, c07.lat, c07.lng, locais) === "total",
  "MRO→C07 + Arara→CMD = total"
);

// --- Caso 2: Oficina→C15 vs Arara→Tamanduá = TOTAL ---
ok(
  compatRotaPassageiro(tam.lat, tam.lng, ofi.lat, ofi.lng, c15.lat, c15.lng, locais) === "total",
  "Oficina→C15 + Restaurante Arara→Tamanduá = total"
);
const corEmb = corredorRotaCaronaKm(rest.lat, rest.lng, ofi.lat, ofi.lng, c15.lat, c15.lng, locais);
ok(corEmb.dist === 0 && corEmb.t >= 0 && corEmb.t <= 1, "Arara embarca no caminho Oficina→C15");

// --- Caso 3: Portaria→Centro vs Portaria→CMD ---
// NÃO total (CMD não está no caminho curto até o Centro)
ok(
  !pontoNoCaminho(port.lat, port.lng, cmd.lat, cmd.lng, centro.lat, centro.lng),
  "CMD NÃO está no caminho Portaria→Centro"
);
ok(
  !pontoNoCaminho(port.lat, port.lng, ccp.lat, ccp.lng, centro.lat, centro.lng),
  "CCP NÃO está no caminho Portaria→Centro (bug antigo)"
);
const compatPort = compatRotaPassageiro(
  cmd.lat, cmd.lng, port.lat, port.lng, centro.lat, centro.lng, locais
);
ok(
  compatPort === "parcial" || compatPort === "proximo" || compatPort === "none",
  `Portaria→Centro vs Portaria→CMD não é total (foi ${compatPort})`
);
// Encaixe, se houver, não pode ser CCP
const enc = melhorPontoDeEncaixe(
  { lat: port.lat, lng: port.lng },
  { lat: cmd.lat, lng: cmd.lng },
  { lat: port.lat, lng: port.lng },
  { lat: centro.lat, lng: centro.lng },
  locais
);
ok(!enc || !/CCP/i.test(enc.nome || ""), `encaixe não é CCP (foi ${enc && enc.nome})`);
const noCam = pontosNoCaminhoCarona(port.lat, port.lng, centro.lat, centro.lng, locais);
ok(!noCam.some((p) => /CCP/i.test(p.nome || "")), "lista no-caminho Port→Centro sem CCP");

// Preferência: parcial (Centro no caminho até o CMD) é o certo operacionalmente
ok(compatPort === "parcial", `esperado parcial (motorista deixa no Centro): ${compatPort}`);

if (failed) {
  console.error(`\n${failed} verificação(ões) falharam.`);
  process.exit(1);
}
console.log("\nRota por caminho (S11D): OK");
