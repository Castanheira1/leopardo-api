/** Contrato: passageiro mantém pulso no mapa durante a viagem. */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const dash = fs.readFileSync(path.join(root, "public/dashboard.html"), "utf8");
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
ok(/VERSION = "v259"/.test(sw), "SW v259");

// pos inicial para passageiro tambem (embarque)
ok(
  /const posPaxInicial = \(embarque && \(v\.fase \|\| 'encontro'\) === 'encontro'\)/.test(dash),
  "posPaxInicial no embarque para os dois papeis"
);

if (failed) process.exit(1);
console.log("\nPulso passageiro OK");
