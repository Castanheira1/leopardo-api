const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const h = fs.readFileSync(path.join(root, "public/dashboard.html"), "utf8");
const css = fs.readFileSync(path.join(root, "public/style.css"), "utf8");
const sw = fs.readFileSync(path.join(root, "public/service-worker.js"), "utf8");
let failed = 0;
function ok(c, m) {
  if (!c) {
    console.error("FAIL", m);
    failed++;
  } else console.log("OK", m);
}
ok(h.includes("function garantirUiAcaoVisivel"), "garantirUiAcaoVisivel");
ok(h.includes("Botão/alça na hora") || h.includes("NÃO espera o Google Maps"), "showTab nao espera Maps");
ok(css.includes("min-height: min(60dvh, 440px)"), "map-stage min-height");
ok(css.includes("min-height: min(70dvh, 520px)"), "tab min-height");
ok(!/theme-dark \.map-stage \{\s*height: 100%;\s*min-height: 0;/.test(css), "sem min-height:0");
ok(sw.includes('VERSION = "v249"'), "sw v249");
ok(/id="acaoSheetPed" class="acao-sheet acao-sheet-ped"/.test(h), "sheet ped aberto no HTML");
ok(/id="acaoSheetOfe" class="acao-sheet acao-sheet-ofe"/.test(h), "sheet ofe aberto no HTML");
if (failed) process.exit(1);
console.log("\nUI sheet OK");
