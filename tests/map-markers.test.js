/**
 * Contrato de mapa: DEMO sem mapId = mapa branco + OverlayView;
 * Map ID real = Advanced Markers.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const dash = fs.readFileSync(path.join(root, "public/dashboard.html"), "utf8");
const sw = fs.readFileSync(path.join(root, "public/service-worker.js"), "utf8");

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("OK:", msg);
  }
}

ok(
  /if \(!_mapId \|\| _mapId === 'DEMO_MAP_ID'\) return null;/.test(appJs),
  "mapaIdEfetivo null no DEMO (mapa branco)"
);
ok(/delete o\.mapId/.test(appJs), "opcoesMapa remove mapId no DEMO");
ok(
  /const usarAdvanced = !!\(mapaIdEfetivo\(\) && _AdvancedMarkerElement\)/.test(appJs),
  "Advanced Marker só com mapId real"
);
ok(appJs.includes("criarOverlayHtml"), "OverlayView para DEMO");
ok(
  /map\.setOptions\(\{\s*styles:\s*ESTILO_MAPA_CLARO/.test(dash),
  "ESTILO_MAPA_CLARO aplicado no roadmap DEMO"
);
ok(
  /function mapaUsaEstiloLocal\(\)[\s\S]*?mapaIdEfetivo\(\)/.test(dash),
  "mapaUsaEstiloLocal usa mapaIdEfetivo"
);
ok(appJs.includes("function montarNoCarro"), "montarNoCarro presente");
ok(appJs.includes("function carSvgPaths"), "carSvgPaths presente");
ok(/VERSION = "v250"/.test(sw), "service-worker v250");

if (failed) {
  console.error(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log("\nTodos os testes de mapa passaram.");
