// Contrato do menu = PR #344 (a4a5fa4): Instagram absoluto + toggle display.
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

ok(/ig-settings/.test(html), "HTML menu Instagram (PR #344)");
ok(/onclick="abrirLocais\(\)"/.test(html), "Locais ligado");
ok(/onclick="toggleMenu\(event\)"/.test(html), "hambúrguer chama toggleMenu");
ok(/position:\s*absolute/.test(blocoMenu), "menu position:absolute como no PR #344");
ok(!/function _portalMenu|function _posicionarMenu|_menuTravaAte/.test(js), "sem remendos portal/fixed/trava");
ok(
  /function toggleMenu\(e\)\s*\{[\s\S]{0,180}?m\.style\.display = aberto \? 'block' : 'none'/.test(js),
  "toggleMenu só display"
);
ok(/ig-perfil-overlay|ig-perfil-box/.test(css), "CSS do perfil Instagram (PR #344) presente");

if (failed) process.exit(1);
console.log("\nUI menu OK (PR #344)");
