/** Contrato: passageiro mantém pulso no mapa durante a viagem. */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
// dashboard modularizado: HTML + dashboard.js + dashboard.css (contrato vale pro conjunto)
const dash = ["public/dashboard.html", "public/dashboard.js", "public/dashboard.css"]
  .map((p) => fs.readFileSync(path.join(root, p), "utf8")).join("\n");
const sw = fs.readFileSync(path.join(root, "public/service-worker.js"), "utf8");
let failed = 0;
function ok(c, m) {
  if (!c) {
    console.error("FAIL", m);
    failed++;
  } else console.log("OK", m);
}

ok(dash.includes("mostrarPulsoPax"), "flag mostrarPulsoPax em renderViagem");
ok(
  /mostrarPulsoPax = !!vv\.posPassageiro && vv\.fase === 'encontro'/.test(dash),
  "pulso so na fase encontro (apos embarque some)"
);
ok(
  /titPulso = vv\.ehMotorista \? 'Passageiro' : 'Você'/.test(dash),
  "titulo do pulso 'Você' no mapa do passageiro na espera"
);
ok(
  dash.includes("Depois do embarque (fase destino): só o carrinho"),
  "comentario: so carrinho apos embarque"
);
// Ratchet: SW versionado e no mínimo na versão que trouxe o pulso do passageiro.
const swVer = Number((sw.match(/VERSION = "v(\d+)"/) || [])[1] || 0);
ok(swVer >= 259, `SW versionado >= v259 (atual v${swVer})`);

// pos inicial para passageiro tambem (embarque)
ok(
  /const posPaxInicial = \(embarque && \(v\.fase \|\| 'encontro'\) === 'encontro'\)/.test(dash),
  "posPaxInicial no embarque para os dois papeis"
);

if (failed) process.exit(1);
console.log("\nPulso passageiro OK");
