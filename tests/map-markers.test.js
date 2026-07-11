/**
 * Contrato de visualização no mapa:
 * - mapId sempre (DEMO_MAP_ID) → Advanced Markers (carrinho/pulso)
 * - nunca styles no cliente com mapId
 * - pulso via AdvancedMarker, não só OverlayView
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const dash = fs.readFileSync(path.join(root, "public/dashboard.html"), "utf8");
const sw = fs.readFileSync(path.join(root, "public/service-worker.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public/style.css"), "utf8");

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("OK:", msg);
  }
}

// mapId sempre para Advanced Markers
ok(
  /function mapaIdEfetivo\(\)\s*\{\s*return _mapId \|\| 'DEMO_MAP_ID';\s*\}/.test(appJs),
  "mapaIdEfetivo sempre devolve mapId (DEMO ok)"
);
ok(
  /o\.mapId = mapaIdEfetivo\(\)/.test(appJs) || /mapId: mapaIdEfetivo\(\)/.test(appJs),
  "opcoesMapa define mapId"
);
ok(
  !/if \(!_mapId \|\| _mapId === 'DEMO_MAP_ID'\) return null;/.test(appJs),
  "não remove mapId no DEMO (regressão OverlayView)"
);

// Advanced Marker preferido para criarMarcador
ok(
  /if \(_AdvancedMarkerElement\)\s*\{[\s\S]*?new _AdvancedMarkerElement/.test(appJs),
  "criarMarcador usa AdvancedMarkerElement"
);
ok(
  /content: pinEl\.element \|\| pinEl/.test(appJs) || /content = pinEl\.element \|\| pinEl/.test(appJs),
  "PinElement vira content do AdvancedMarker"
);

// dashboard: sem styles com mapId
ok(
  /function mapaUsaEstiloLocal\(\)\s*\{\s*return false;/.test(dash),
  "mapaUsaEstiloLocal desligado (sem styles+mapId)"
);
ok(
  !/map\.setOptions\(\{\s*styles:\s*ESTILO_MAPA_CLARO/.test(dash),
  "aplicarEstiloMapa não seta ESTILO_MAPA_CLARO"
);

// pulso Advanced Marker
ok(
  /function criarPulse\(/.test(dash) && /new _AdvancedMarkerElement/.test(dash),
  "criarPulse usa AdvancedMarkerElement"
);
ok(
  /montarConteudoPulse/.test(dash),
  "conteúdo HTML do pulso montado para o marker"
);
ok(
  /className = 'map-pulse'/.test(dash),
  "classe map-pulse no content"
);

// CSS do pulso compatível com AdvancedMarker (caixa com tamanho)
ok(
  /\.map-pulse\s*\{[\s\S]*?width:\s*48px/.test(css),
  "map-pulse tem largura/altura (não width:0)"
);

// SW
ok(/const VERSION = "v247"/.test(sw), "service-worker v247");

// SVG carro
ok(appJs.includes("function montarNoCarro"), "montarNoCarro presente");
ok(appJs.includes("function carSvgPaths"), "carSvgPaths presente");

if (failed) {
  console.error(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log("\nTodos os testes de visualização no mapa passaram.");
