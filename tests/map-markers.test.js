/**
 * Testes de contrato: mapa DEMO sem mapId + styles locais; OverlayView para
 * marcadores; nunca styles quando mapId real. Não precisa de Google Maps API.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

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

// --- mapaIdEfetivo: DEMO → null (sem mapId no Map) ---
ok(
  /function mapaIdEfetivo\(\)\s*\{[\s\S]*?if \(!_mapId \|\| _mapId === 'DEMO_MAP_ID'\) return null;/.test(appJs),
  "mapaIdEfetivo devolve null para DEMO_MAP_ID"
);
ok(
  !/function mapaIdEfetivo\(\)\s*\{\s*return _mapId \|\| 'DEMO_MAP_ID';/.test(appJs),
  "mapaIdEfetivo NÃO força DEMO_MAP_ID no Map (regressão 5622eaf)"
);

// --- opcoesMapa: remove mapId quando mid é null ---
ok(
  /function opcoesMapa[\s\S]*?delete o\.mapId/.test(appJs),
  "opcoesMapa remove mapId no modo DEMO"
);
ok(
  !/const o = \{ mapId: mapaIdEfetivo\(\)/.test(appJs),
  "opcoesMapa não injeta mapId cego"
);

// --- OverlayView path para DEMO ---
ok(appJs.includes("function criarOverlayHtml"), "criarOverlayHtml existe");
ok(appJs.includes("obterVapHtmlMarkerClass"), "classe OverlayView cacheada");
ok(
  /const usarAdvanced = !!\(mapaIdEfetivo\(\) && _AdvancedMarkerElement\)/.test(appJs),
  "Advanced Marker só com mapId real"
);
ok(
  /ov = criarOverlayHtml\(map, position, content, zEfetivo, title\)/.test(appJs)
    || /ov = criarOverlayHtml\(map, position, content, zIndex, title\)/.test(appJs),
  "DEMO usa OverlayView HTML (carrinho/pinos)"
);
ok(
  appJs.includes("panes.overlayMouseTarget || panes.floatPane || panes.overlayLayer"),
  "OverlayView tolera panes ausentes (fallback de pane)"
);
ok(
  /if \(!this\.div\) \{\s*try \{ this\.onAdd\(\); \}/.test(appJs),
  "OverlayView re-tenta onAdd no draw se panes estavam null"
);

// --- dashboard: styles só sem mapId ---
ok(
  /function mapaUsaEstiloLocal\(\)\s*\{[\s\S]*?mapaIdEfetivo\(\)/.test(dash),
  "mapaUsaEstiloLocal usa mapaIdEfetivo()"
);
ok(
  /function aplicarEstiloMapa\(map, tipo\)\s*\{[\s\S]*?if \(!mapaUsaEstiloLocal\(\)\) return;/.test(dash),
  "aplicarEstiloMapa aborta com mapId (sem warning Google)"
);

// --- pulse do motorista endurecido ---
ok(
  dash.includes("panes.overlayMouseTarget || panes.floatPane || panes.overlayLayer"),
  "criarPulse usa pane com fallback"
);
ok(
  /map-pulse[\s\S]*?zIndex = '120'/.test(dash) || dash.includes("d.style.zIndex = '120'"),
  "pulso com z-index alto no mapa"
);

// --- raio de pedidos (motorista vê pulso além de 600 m com carona) ---
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
ok(
  /const raioKm = temCarona \? RAIO_VISIVEL_KM : RAIO_ONLINE_KM/.test(server),
  "GET /api/pedidos: 10 km com carona, 600 m online"
);

// --- SW bump ---
ok(/const VERSION = "v246"/.test(sw), "service-worker v246 invalida cache do fix");

// --- SVG do carro ainda existe ---
ok(appJs.includes("function montarNoCarro"), "montarNoCarro (SVG pickup) presente");
ok(appJs.includes("function carSvgPaths"), "carSvgPaths presente");

if (failed) {
  console.error(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log("\nTodos os testes de mapa/marcadores passaram.");
