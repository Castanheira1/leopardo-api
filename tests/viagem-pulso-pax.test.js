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
  /vv\.ehMotorista \? vv\.fase === 'encontro' : true/.test(dash)
    || /ehMotorista \? vv\.fase === 'encontro' : true/.test(dash),
  "passageiro sempre ve o proprio pulso; motorista so no encontro"
);
ok(
  /titPulso = vv\.ehMotorista \? 'Passageiro' : 'Você'/.test(dash),
  "titulo do pulso 'Você' no mapa do passageiro"
);
// Nao remove mais o pulso do pax so porque nao e motorista
ok(
  !/if \(vv\.ehMotorista && vv\.posPassageiro && vv\.fase === 'encontro'\) \{\s*if \(vv\.pessoaMarker\) vv\.pessoaMarker\.setPosition/.test(dash),
  "regra antiga (so motorista) removida"
);
ok(/VERSION = "v258"/.test(sw), "SW v258");

// pos inicial para passageiro tambem (embarque)
ok(
  /const posPaxInicial = \(embarque && \(v\.fase \|\| 'encontro'\) === 'encontro'\)/.test(dash),
  "posPaxInicial no embarque para os dois papeis"
);

if (failed) process.exit(1);
console.log("\nPulso passageiro OK");
