/** Contrato: mapa branco no DEMO + sessão única por conta. */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const dash = fs.readFileSync(path.join(root, "public/dashboard.html"), "utf8");
// O back-end foi modularizado (server.js + src/**). O contrato de sessão vale
// para o conjunto: concatena tudo para os greps abaixo continuarem válidos.
function lerBackend() {
  const partes = [fs.readFileSync(path.join(root, "server.js"), "utf8")];
  for (const dir of ["src", "src/rotas", "src/services"]) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith(".js")) partes.push(fs.readFileSync(path.join(abs, f), "utf8"));
    }
  }
  return partes.join("\n");
}
const server = lerBackend();
const sw = fs.readFileSync(path.join(root, "public/service-worker.js"), "utf8");
let failed = 0;
function ok(c, m) {
  if (!c) {
    console.error("FAIL", m);
    failed++;
  } else console.log("OK", m);
}

// Mapa branco DEMO
ok(
  /if \(!_mapId \|\| _mapId === 'DEMO_MAP_ID'\) return null;/.test(appJs),
  "mapaIdEfetivo null no DEMO (permite styles)"
);
ok(/delete o\.mapId/.test(appJs), "opcoesMapa remove mapId no DEMO");
ok(
  /const usarAdvanced = !!\(mapaIdEfetivo\(\) && _AdvancedMarkerElement\)/.test(appJs),
  "Advanced Marker só com mapId real"
);
ok(
  /map\.setOptions\(\{\s*styles:\s*ESTILO_MAPA_CLARO/.test(dash),
  "aplicarEstiloMapa aplica ESTILO_MAPA_CLARO"
);
ok(
  /function mapaUsaEstiloLocal\(\)[\s\S]*?return !mapaIdEfetivo\(\)/.test(dash),
  "estilo local quando sem mapId"
);

// Sessão única
ok(server.includes("function emitirTokenSessao"), "emitirTokenSessao");
ok(server.includes("sessao_id"), "coluna sessao_id");
ok(server.includes("Sessão encerrada: esta conta entrou em outro dispositivo"), "msg kick outro device");
ok(/async \(req, res, next\) =>/.test(server) && server.includes("payload.sid"), "verificarAuth checa sid");
ok(appJs.includes("Sessão encerrada") || appJs.includes("resp.clone()"), "front propaga erro 401");

ok(/VERSION = "v\d+"/.test(sw), "SW versioned");

if (failed) process.exit(1);
console.log("\nSessao + mapa branco OK");
