// Contrato do menu Instagram que funcionava (commit 8ab380c): painel ig-settings
// com position:absolute + toggle display. Sem portal/fixed/trava.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const js = fs.readFileSync(path.join(root, "public/dashboard.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public/dashboard.html"), "utf8");
const css = fs.readFileSync(path.join(root, "public/style.css"), "utf8");

let failed = 0;
function ok(c, m) {
  if (!c) {
    console.error("FAIL", m);
    failed++;
  } else console.log("OK", m);
}

const blocoMenu = (css.match(/\.nav-menu\s*\{[\s\S]*?\}/) || [""])[0];

ok(/ig-settings/.test(html), "HTML do menu Instagram presente");
ok(/ig-settings-row/.test(html) && /onclick="abrirLocais\(\)"/.test(html), 'item "Locais" no painel Instagram');
ok(/onclick="abrirFavoritos\(\)"/.test(html), 'item favoritos ligado');
ok(/onclick="toggleMenu\(event\)"/.test(html), "hambúrguer chama toggleMenu");
ok(/position:\s*absolute/.test(blocoMenu), "menu em position:absolute (como em 8ab380c)");
ok(!/function _portalMenu|function _posicionarMenu|_menuTravaAte/.test(js), "sem portal/fixed/trava dos remendos");
ok(
  /function toggleMenu\(e\)\s*\{[\s\S]{0,200}?m\.style\.display = aberto \? 'block' : 'none'/.test(js),
  "toggleMenu só liga/desliga display"
);
ok(
  /!e\.target\.closest\(['"]\.nav-menu-wrap['"]\)/.test(js),
  "clique-fora fecha fora do wrap"
);
ok(/function abrirLocais/.test(js) && /function abrirFavoritos/.test(js), "abrirLocais/abrirFavoritos no escopo");

const toast = (css.match(/body\.theme-dark #message\.message \{[\s\S]*?\}/) || [""])[0];
ok(/pointer-events:\s*none/.test(toast), "toast não engole toque");
ok(/function ajustarAlturaAba/.test(js), "ajuste de altura da aba existe");

if (failed) process.exit(1);
console.log("\nUI menu OK");
