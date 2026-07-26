// Contrato do menu simples — restaurado do commit 73dc4f5 (antes do painel
// Instagram / mock amarelo). Lê o front e cobra o que fazia o hambúrguer e
// "Locais" abrirem de verdade: lista curta, position:absolute, toggle display.
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

// 1) Menu simples — sem portal/fixed/trava (foi isso que virou bola de neve).
ok(/position:\s*absolute/.test(blocoMenu), "menu em position:absolute no wrap");
ok(!/function _portalMenu|function _posicionarMenu|_menuTravaAte/.test(js), "sem portal/trava do painel Instagram");
ok(
  /function toggleMenu\(e\)\s*\{[\s\S]{0,200}?m\.style\.display = aberto \? 'block' : 'none'/.test(js),
  "toggleMenu só liga/desliga display"
);
ok(
  /!e\.target\.closest\(['"]\.nav-menu-wrap['"]\)/.test(js),
  "clique-fora fecha quando toca fora do wrap"
);

// 2) HTML do menu antigo (itens de verdade, não painel Instagram).
ok(/class="nav-menu-item"[^>]*>Locais</.test(html) || /class="nav-menu-item">Locais</.test(html), 'item "Locais" no menu simples');
ok(/onclick="abrirLocais\(\)"/.test(html), 'item "Locais" ligado a abrirLocais');
ok(/onclick="abrirFavoritos\(\)"/.test(html), 'item "Meus locais favoritos" ligado a abrirFavoritos');
ok(/onclick="toggleMenu\(event\)"/.test(html), "hambúrguer chama toggleMenu");
ok(!/ig-settings-row/.test(html), "HTML do menu sem linhas Instagram");
ok(/function abrirLocais/.test(js) && /function abrirFavoritos/.test(js), "abrirLocais/abrirFavoritos no escopo global");

// 3) Toast e altura da aba — correções úteis que ficam.
const toast = (css.match(/body\.theme-dark #message\.message \{[\s\S]*?\}/) || [""])[0];
ok(/pointer-events:\s*none/.test(toast), "toast fixo não intercepta toque (pointer-events: none)");
ok(
  /pointer-events:none/.test(fs.readFileSync(path.join(root, "public/app.js"), "utf8")),
  "toast criado em JS (mostrarToast) também não intercepta"
);
ok(/function ajustarAlturaAba/.test(js), "existe o ajuste de altura da aba ativa");
ok(
  /tab\.style\.minHeight = disponivel/.test(js),
  "o ajuste sobrescreve o min-height (min-height vence max-height no CSS)"
);

if (failed) process.exit(1);
console.log("\nUI menu OK");
