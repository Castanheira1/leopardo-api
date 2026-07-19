/**
 * Malha de pista S11D + match em polilinha (rota calculada / gravável).
 */
const {
  calcularRotaCarona,
  catalogoDoProjeto,
  compatRotaPassageiro,
  corredorRotaCaronaKm,
  melhorPontoDeEncaixe,
  locaisDoProjetoCodigo,
} = require("../src/geo");

const codigo = "S11D";
const locais = locaisDoProjetoCodigo(codigo);
const cat = catalogoDoProjeto(codigo);
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
ok(!!cat.grafo, "grafo da malha S11D carregado");
ok(!!cat.malha && Array.isArray(cat.malha.troncos) && cat.malha.troncos.length > 0, "malha.troncos presente");

// --- Rotas na malha ---
const rotaMroC07 = calcularRotaCarona(mro, c07, codigo);
ok(rotaMroC07.fonte === "malha", `MRO→C07 fonte malha (${rotaMroC07.fonte})`);
ok(
  (rotaMroC07.nomes || []).includes("CMD-Usina") || rotaMroC07.pontos.some((p) => /CMD/i.test(p.nome || "")),
  "CMD no caminho malha MRO→Canteiro 07"
);
console.log("   path:", (rotaMroC07.nomes || []).join(" > "));

const rotaPortCentro = calcularRotaCarona(port, centro, codigo);
ok(rotaPortCentro.fonte === "malha", "Portaria→Centro na malha");
ok(
  !(rotaPortCentro.nomes || []).includes("CCP-Usina"),
  "CCP NÃO está no caminho Portaria→Centro"
);
console.log("   path:", (rotaPortCentro.nomes || []).join(" > "));

// --- Match com codigo (malha) ---
const opts = (rota_pontos) => ({ locais, codigo, rota_pontos: rota_pontos || null });

ok(
  compatRotaPassageiro(cmd.lat, cmd.lng, mro.lat, mro.lng, c07.lat, c07.lng, opts(rotaMroC07.pontos)) === "total",
  "MRO→C07 + dest CMD = total (polilinha malha)"
);

const corArara = corredorRotaCaronaKm(
  arara.lat, arara.lng, mro.lat, mro.lng, c07.lat, c07.lng, opts(rotaMroC07.pontos)
);
ok(corArara.dist <= 1.5, `Arara na pista MRO→C07 (dist=${corArara.dist.toFixed(3)})`);

ok(
  compatRotaPassageiro(tam.lat, tam.lng, ofi.lat, ofi.lng, c15.lat, c15.lng, opts()) === "total"
  || corredorRotaCaronaKm(tam.lat, tam.lng, ofi.lat, ofi.lng, c15.lat, c15.lng, opts()).dist <= 1.5,
  "Oficina→C15 cobre Tamanduá (total ou corredor)"
);
const corRest = corredorRotaCaronaKm(rest.lat, rest.lng, ofi.lat, ofi.lng, c15.lat, c15.lng, opts());
ok(corRest.dist <= 1.5, `Restaurante Arara no corredor Oficina→C15 (dist=${corRest.dist.toFixed(3)})`);

const compatPort = compatRotaPassageiro(
  cmd.lat, cmd.lng, port.lat, port.lng, centro.lat, centro.lng, opts(rotaPortCentro.pontos)
);
ok(compatPort !== "total", `Portaria→Centro vs Portaria→CMD não é total (${compatPort})`);

const corCcp = corredorRotaCaronaKm(
  ccp.lat, ccp.lng, port.lat, port.lng, centro.lat, centro.lng, opts(rotaPortCentro.pontos)
);
ok(corCcp.dist > 1.5, `CCP fora do corredor Portaria→Centro (dist=${corCcp.dist.toFixed(3)})`);

const enc = melhorPontoDeEncaixe(
  { lat: port.lat, lng: port.lng },
  { lat: cmd.lat, lng: cmd.lng },
  { lat: port.lat, lng: port.lng },
  { lat: centro.lat, lng: centro.lng },
  opts(rotaPortCentro.pontos)
);
ok(!enc || !/CCP/i.test(enc.nome || ""), `encaixe não é CCP (foi ${enc && enc.nome})`);

// Parcial: Centro no caminho do pax Port→CMD na malha
ok(
  compatPort === "parcial" || compatPort === "proximo",
  `esperado parcial/proximo (${compatPort})`
);

// Ilha Geosol/Lagoas ligada ao tronco da mina (não cai em reta)
const geosol = by("Base Geosol");
const lagoaA = by("Lagoa do Amendoim");
const rotaGeo = calcularRotaCarona(geosol, c07, codigo);
ok(rotaGeo.fonte === "malha", `Geosol→C07 na malha (${rotaGeo.fonte})`);
ok(
  (rotaGeo.nomes || []).includes("Pilha Norte") || rotaGeo.pontos.some((p) => /Pilha Norte/i.test(p.nome || "")),
  "caminho Geosol passa por Pilha Norte (liga a ilha)"
);
const rotaLagoaMina = calcularRotaCarona(lagoaA, by("Rodoviária Castanheira"), codigo);
ok(rotaLagoaMina.fonte === "malha", `Lagoa Amendoim→Castanheira na malha (${rotaLagoaMina.fonte})`);

if (failed) {
  console.error(`\n${failed} verificação(ões) falharam.`);
  process.exit(1);
}
console.log("\nMalha + rota_pontos (S11D): OK");
