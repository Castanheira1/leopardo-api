// Teste de TOQUE REAL — o que faltava.
//
// Por que este arquivo existe
// ---------------------------
// ui-menu.test.js e ui-sheet.test.js leem dashboard.js/style.css como TEXTO e
// cobram expressões regulares. Isso prova que uma linha foi escrita; não prova
// que o dedo alcança o botão. Três correções seguidas do menu e do "Escolher
// local" passaram nesses testes com o app quebrado na mão do usuário, porque a
// pergunta que importa — "quem recebe o toque no centro deste botão?" — só um
// navegador de verdade responde.
//
// Aqui o dashboard.html sobe num Chromium real, em vários tamanhos de tela, e
// para cada controle visível medimos document.elementFromPoint no centro dele.
// Se quem atende for outro elemento, o botão está morto — mesmo que apareça na
// tela. Defeitos que este teste pega e o de regex não pegava:
//
//   * toast (#message, z 9990) fixo no rodapé engolindo o CTA do sheet;
//   * menu preso no contexto de empilhamento da .modo-bar (z 80);
//   * CTA empurrado para fora da área visível pelos avisos de cadastro;
//   * sheet mais alto que o próprio .map-stage, cobrindo o mapa inteiro e
//     jogando o rodapé (CTA) para fora do palco.
//
// Sem Playwright (ou sem o Chromium dele) o teste se declara PULADO e sai com
// 0, para a suíte de contrato continuar rodando em máquina limpa. No CI isso
// seria falso conforto — um teste que some é pior que teste nenhum — então lá
// UI_TOQUE_OBRIGATORIO=1 transforma qualquer pulo em falha.
//
// Rodar localmente:
//   npm i -D playwright && npx playwright install chromium
//   node tests/ui-toque.test.js
// Com um Chromium já no disco, aponte PLAYWRIGHT_CHROMIUM_PATH para o binário.
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const PUBLIC = path.join(root, "public");
const OBRIGATORIO = !!process.env.UI_TOQUE_OBRIGATORIO;

function pular(motivo) {
  if (OBRIGATORIO) {
    console.error("FALHA ui-toque: " + motivo);
    console.error("       UI_TOQUE_OBRIGATORIO=1 — este teste não pode ser pulado aqui.");
    process.exit(1);
  }
  console.log("PULADO ui-toque: " + motivo);
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  pular("playwright não instalado (npm i -D playwright).");
}

/* ---------------- servidor: public/ + /api de mentira ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const USUARIO = {
  id: 1,
  nome: "Teste da Silva",
  matricula: "123456",
  telefone: "94999990000",
  email: "teste@vap.com",
  empresa: "VAP",
  projeto_codigo: "S11D",
  is_admin: false,
  super_admin: false,
  politica_versao: "1.0",
};

// mapsApiKey precisa existir senão carregarMaps() desiste antes de montar a tela.
const RESPOSTAS = {
  "/api/config": { mapsApiKey: "CHAVE_DE_TESTE", mapsMapId: "DEMO_MAP_ID" },
  "/api/perfil": USUARIO,
  "/api/habilitacao/hoje": { habilitado: false },
  "/api/motorista/oferta-atual": null,
  "/api/projetos": [{ codigo: "S11D", nome: "S11D" }],
};

function subirServidor() {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p.startsWith("/api/")) {
      const corpo = p in RESPOSTAS ? RESPOSTAS[p] : p.endsWith("s") ? [] : {};
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(corpo));
    }
    const arq = path.join(PUBLIC, p === "/" ? "index.html" : p);
    if (!arq.startsWith(PUBLIC) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) {
      res.writeHead(404);
      return res.end("nao encontrado");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(arq)] || "application/octet-stream" });
    fs.createReadStream(arq).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, porta: server.address().port })));
}

/* ---------------- Google Maps de mentira ----------------
   instalarMapsBootstrap() (public/app.js) devolve na hora se já existir
   window.google.maps.importLibrary — então nada é buscado na rede. O layout do
   palco é do CSS, não do mapa: para medir toque, este esqueleto basta. */

function fakeMaps() {
  const ouvintes = new WeakMap();
  const on = (o, ev, fn) => {
    if (!ouvintes.has(o)) ouvintes.set(o, {});
    const m = ouvintes.get(o);
    (m[ev] = m[ev] || []).push(fn);
    return { remove() {} };
  };
  const disparar = (o, ev, a) => (ouvintes.get(o)?.[ev] || []).slice().forEach((f) => { try { f(a); } catch (_) {} });

  class LatLng {
    constructor(lat, lng) { this._lat = typeof lat === "object" ? lat.lat : lat; this._lng = typeof lat === "object" ? lat.lng : lng; }
    lat() { return this._lat; }
    lng() { return this._lng; }
    toJSON() { return { lat: this._lat, lng: this._lng }; }
    equals() { return false; }
  }
  class LatLngBounds {
    extend() { return this; }
    isEmpty() { return false; }
    getCenter() { return new LatLng(-6.4, -49.9); }
    getNorthEast() { return new LatLng(-6.3, -49.8); }
    getSouthWest() { return new LatLng(-6.5, -50.0); }
    contains() { return true; }
    union() { return this; }
  }
  class MVC {
    addListener(ev, fn) { return on(this, ev, fn); }
    setOptions() {}
  }
  class Mapa extends MVC {
    constructor(el, opts) {
      super();
      this.el = el;
      this._centro = (opts || {}).center || { lat: -6.4, lng: -49.9 };
      this._zoom = (opts || {}).zoom || 15;
      if (el) el.style.background = "#e9e9e9";
      setTimeout(() => { disparar(this, "idle"); disparar(this, "tilesloaded"); disparar(this, "bounds_changed"); }, 30);
    }
    setCenter(c) { this._centro = c; }
    getCenter() { const c = this._centro; return c instanceof LatLng ? c : new LatLng(c.lat, c.lng); }
    setZoom(z) { this._zoom = z; }
    getZoom() { return this._zoom; }
    panTo(c) { this.setCenter(c); }
    panBy() {}
    fitBounds() { setTimeout(() => disparar(this, "idle"), 10); }
    getBounds() { return new LatLngBounds(); }
    getDiv() { return this.el; }
    setMapTypeId() {}
    setHeading() {}
    setTilt() {}
    getProjection() {
      return { fromLatLngToPoint: () => ({ x: 0, y: 0 }), fromPointToLatLng: () => new LatLng(-6.4, -49.9) };
    }
    get controls() { return new Proxy({}, { get: () => ({ push() {}, clear() {} }) }); }
  }
  class OverlayView extends MVC {
    setMap(m) {
      this._map = m;
      if (m) setTimeout(() => { try { this.onAdd && this.onAdd(); this.draw && this.draw(); } catch (_) {} }, 0);
      else { try { this.onRemove && this.onRemove(); } catch (_) {} }
    }
    getMap() { return this._map; }
    getPanes() { const d = document.createElement("div"); return { overlayMouseTarget: d, overlayLayer: d, floatPane: d, markerLayer: d, overlayShadow: d }; }
    getProjection() {
      return {
        fromLatLngToDivPixel: () => ({ x: 0, y: 0 }),
        fromDivPixelToLatLng: () => new LatLng(-6.4, -49.9),
        fromLatLngToContainerPixel: () => ({ x: 0, y: 0 }),
      };
    }
  }
  class Circle extends MVC { setCenter() {} setRadius() {} setMap() {} getBounds() { return new LatLngBounds(); } }
  class Geocoder {
    geocode(_r, cb) {
      const res = [{ formatted_address: "Rua Teste, 100", address_components: [], geometry: { location: new LatLng(-6.4, -49.9) } }];
      if (cb) setTimeout(() => cb(res, "OK"), 5);
      return Promise.resolve({ results: res });
    }
  }
  class PlacesService {
    nearbySearch(_r, cb) { setTimeout(() => cb([], "ZERO_RESULTS"), 5); }
    findPlaceFromQuery(_r, cb) { setTimeout(() => cb([], "ZERO_RESULTS"), 5); }
    textSearch(_r, cb) { setTimeout(() => cb([], "ZERO_RESULTS"), 5); }
    getDetails(_r, cb) { setTimeout(() => cb(null, "NOT_FOUND"), 5); }
  }
  class AdvancedMarkerElement extends MVC {
    constructor(o) { super(); o = o || {}; this.content = o.content || document.createElement("div"); this.position = o.position; this.map = o.map || null; }
  }
  class PinElement { constructor() { this.element = document.createElement("div"); } }
  class DirectionsService { route(_r, cb) { if (cb) setTimeout(() => cb({ routes: [] }, "ZERO_RESULTS"), 5); return Promise.reject(new Error("sem rota")); } }
  class DirectionsRenderer extends MVC { setMap() {} setDirections() {} }
  class Polyline extends MVC { setMap() {} setPath() {} getPath() { return { getArray: () => [] }; } }
  class Marker extends MVC { setMap() {} setPosition() {} setIcon() {} }
  class InfoWindow extends MVC { open() {} close() {} setContent() {} }

  const maps = {
    Map: Mapa, LatLng, LatLngBounds, OverlayView, Circle, Geocoder, Marker, InfoWindow, Polyline, MVCObject: MVC,
    Size: class { constructor(w, h) { this.width = w; this.height = h; } },
    Point: class { constructor(x, y) { this.x = x; this.y = y; } },
    RenderingType: { RASTER: "RASTER", VECTOR: "VECTOR", UNINITIALIZED: "UNINITIALIZED" },
    MapTypeId: { ROADMAP: "roadmap" },
    SymbolPath: { CIRCLE: 0 },
    ControlPosition: { TOP_LEFT: 1, RIGHT_BOTTOM: 2 },
    places: { PlacesService, PlacesServiceStatus: { OK: "OK", ZERO_RESULTS: "ZERO_RESULTS" }, Autocomplete: class {} },
    geometry: {
      spherical: { computeDistanceBetween: () => 1200, computeHeading: () => 45, computeOffset: (p) => p },
      encoding: { decodePath: () => [] },
    },
    DirectionsService, DirectionsRenderer,
    DirectionsStatus: { OK: "OK", ZERO_RESULTS: "ZERO_RESULTS" },
    TravelMode: { DRIVING: "DRIVING" },
    event: {
      addListener: on,
      addListenerOnce: on,
      trigger: disparar,
      removeListener() {},
      clearInstanceListeners() {},
    },
    importLibrary: (nome) => Promise.resolve({
      maps: { Map: Mapa, RenderingType: maps.RenderingType, InfoWindow },
      marker: { AdvancedMarkerElement, PinElement },
      places: { PlacesService, Autocomplete: class {} },
      routes: { DirectionsService, DirectionsRenderer, TravelMode: maps.TravelMode },
      geometry: maps.geometry,
      core: { LatLng, LatLngBounds, event: maps.event },
    }[nome] || {}),
  };
  window.google = window.google || {};
  window.google.maps = maps;
}

/* ---------------- a sonda: quem recebe o toque? ---------------- */

// Roda DENTRO da página. Devolve só os controles doentes.
function sondarControles() {
  const nome = (el) => !el ? "nada"
    : el.tagName.toLowerCase()
      + (el.id ? "#" + el.id : "")
      + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "");

  const doentes = [];
  for (const el of document.querySelectorAll("button, a[href], input, select, .ig-settings-row")) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;                    // não renderizado
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) continue;
    if (el.closest('[style*="display: none"], [style*="display:none"]')) continue;

    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    // Dentro de um container rolável, ficar fora da vista NÃO é defeito: o dedo
    // chega rolando. Só cobramos o que já está na parte visível do rolável.
    let rolavel = null;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY;
      if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight + 2) { rolavel = p; break; }
    }
    if (rolavel) {
      const rr = rolavel.getBoundingClientRect();
      if (cy < rr.top + 2 || cy > rr.bottom - 2) continue;
    }

    const foraDaTela = r.bottom > innerHeight + 1 || r.top < -1 || r.right > innerWidth + 1 || r.left < -1;
    const atende = document.elementFromPoint(cx, cy);
    const chega = !!(atende && (atende === el || el.contains(atende)));
    if (chega && !foraDaTela) continue;

    doentes.push({
      alvo: nome(el),
      texto: (el.textContent || el.value || "").trim().replace(/\s+/g, " ").slice(0, 30),
      y: Math.round(r.top),
      bottom: Math.round(r.bottom),
      vh: innerHeight,
      motivo: foraDaTela ? "fora da área visível" : "coberto por " + nome(atende),
    });
  }
  return doentes;
}

/* ---------------- cenários ---------------- */

// 320x568 fica de fora da varredura geral: com os DOIS avisos de cadastro
// abertos sobram 201px de palco, e o mapa cede o piso para o CTA continuar
// alcançável (ver --sheet-minimo em style.css). O botão de camadas some nesse
// aperto — é a troca aceita, e não um defeito a cobrar aqui.
const TAMANHOS = [
  { w: 390, h: 844 },   // iPhone 12/13/14
  { w: 360, h: 740 },   // Android comum
  { w: 360, h: 640 },   // Android pequeno
  { w: 412, h: 915 },   // Pixel
];
const CENARIOS = [
  { nome: "passageiro", papel: "passageiro", avisos: false },
  { nome: "passageiro + avisos de cadastro", papel: "passageiro", avisos: true },
  { nome: "motorista", papel: "motorista", avisos: false },
];

// O mapa precisa sobrar o bastante para a busca "Para onde vamos" (topo 4px,
// 46px de altura) — sem ela o passageiro não tem como escolher destino.
const PISO_BUSCA = 50;

let falhas = 0;
function ok(condicao, msg, detalhe) {
  if (condicao) { console.log("OK", msg); return; }
  falhas++;
  console.error("FALHA", msg);
  if (detalhe) String(detalhe).split("\n").forEach((l) => console.error("       ", l));
}

async function abrirDashboard(browser, porta, { w, h, papel }) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
  });
  await ctx.addInitScript(fakeMaps);
  await ctx.addInitScript(`
    localStorage.setItem('token', 'token-de-teste');
    localStorage.setItem('user', ${JSON.stringify(JSON.stringify(USUARIO))});
    localStorage.setItem('papel', ${JSON.stringify(papel)});
    // Service worker fora do caminho: o teste é do código do disco.
    if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error('off'));
  `);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${porta}/dashboard.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.getElementById("bootSplash"), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return { ctx, page };
}

(async () => {
  const { server, porta } = await subirServidor();
  let browser;
  try {
    browser = await chromium.launch({
      args: ["--no-sandbox"],
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
    });
  } catch (e) {
    server.close();
    pular("Chromium do playwright ausente (npx playwright install chromium): " + e.message.split("\n")[0]);
  }

  try {
    for (const cen of CENARIOS) {
      for (const t of TAMANHOS) {
        const tag = `${cen.nome} @ ${t.w}x${t.h}`;
        const { ctx, page } = await abrirDashboard(browser, porta, { ...t, papel: cen.papel });

        if (cen.avisos) {
          // Os avisos entram quando /api/perfil responde e empurram a aba para
          // baixo — foi assim que o CTA saiu da tela em produção.
          await page.evaluate(() => {
            ["avisoTelefone", "avisoCadastro"].forEach((id) => {
              const e = document.getElementById(id);
              if (e) e.style.display = "block";
            });
            window.dispatchEvent(new Event("resize"));
          });
          await page.waitForTimeout(700);
        }

        // Toast na tela: é o estado em que o CTA morria (o "Mapa indisponível"
        // do boot dura 9s). Fica aberto durante toda a medição.
        await page.evaluate(() => { try { msg("Mapa indisponível no momento.", "error", 60000); } catch (_) {} });
        await page.waitForTimeout(300);

        const doentes = await page.evaluate(sondarControles);
        ok(doentes.length === 0, `${tag}: todo controle visível recebe o próprio toque`,
          doentes.map((d) => `${d.alvo} "${d.texto}" — ${d.motivo} (y ${d.y}..${d.bottom}, tela ${d.vh})`).join("\n"));

        // O sheet não pode engolir o mapa inteiro: sem a busca no topo do palco
        // o passageiro não tem como marcar destino.
        const palco = await page.evaluate(() => {
          const tab = document.querySelector(".tab-content.active");
          const stage = tab && tab.querySelector(".map-stage");
          const sheet = tab && tab.querySelector(".acao-sheet");
          if (!stage || !sheet) return null;
          const a = stage.getBoundingClientRect();
          const b = sheet.getBoundingClientRect();
          return { mapaVisivel: Math.round(b.top - a.top), palco: Math.round(a.height), sheet: Math.round(b.height) };
        });
        ok(palco && palco.mapaVisivel >= PISO_BUSCA,
          `${tag}: sobra mapa para a busca (>= ${PISO_BUSCA}px)`,
          palco && `mapa visível ${palco.mapaVisivel}px (palco ${palco.palco}, sheet ${palco.sheet})`);

        // O menu ☰ tem de abrir e "Locais" tem de responder — a reclamação que
        // originou tudo isto.
        await page.evaluate(() => {
          window.__abriuLocais = false;
          const orig = window.abrirLocais;
          window.abrirLocais = function () { window.__abriuLocais = true; return orig && orig.apply(this, arguments); };
        });
        let menuAbriu = false;
        try {
          await page.locator("#btnMenu").tap({ timeout: 4000 });
          await page.waitForTimeout(300);
          menuAbriu = await page.evaluate(() => document.getElementById("navMenu").style.display === "block");
        } catch (e) {
          ok(false, `${tag}: hambúrguer aceita o toque`, e.message.split("\n")[0]);
        }
        ok(menuAbriu, `${tag}: hambúrguer abre o menu de configurações`);

        if (menuAbriu) {
          let chamou = false;
          try {
            await page.locator("#navMenu .ig-settings-row", { hasText: "Catálogo do canteiro" }).tap({ timeout: 4000 });
            await page.waitForTimeout(400);
            chamou = await page.evaluate(() => !!window.__abriuLocais);
          } catch (e) {
            ok(false, `${tag}: item "Locais" aceita o toque`, e.message.split("\n")[0]);
          }
          ok(chamou, `${tag}: menu → "Locais" abre o catálogo`);
          await page.evaluate(() => { try { fecharPainel("painelFavoritos"); fecharMenu(); } catch (_) {} });
          await page.waitForTimeout(250);
        }

        // O CTA do passageiro ("Escolher local") é o botão principal do app.
        if (cen.papel === "passageiro") {
          await page.evaluate(() => { window.__abriuLocais = false; });
          let chamou = false;
          try {
            await page.locator("#btnCtaPedir").tap({ timeout: 4000 });
            await page.waitForTimeout(400);
            chamou = await page.evaluate(() => !!window.__abriuLocais);
          } catch (e) {
            ok(false, `${tag}: CTA "Escolher local" aceita o toque`, e.message.split("\n")[0]);
          }
          ok(chamou, `${tag}: CTA "Escolher local" abre o catálogo`);
        }

        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(falhas ? `\n${falhas} verificação(ões) falharam.` : "\nTodos os toques chegam ao destino.");
  process.exit(falhas ? 1 : 0);
})().catch((e) => {
  console.error("ui-toque quebrou:", e);
  process.exit(1);
});
