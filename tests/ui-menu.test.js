// Contrato do menu (hambúrguer) — sem dependência nova, no estilo dos demais
// testes de contrato: lê os arquivos do front e cobra as garantias que já
// quebraram em produção.
//
// Bug que originou o teste: .modo-bar e .nav-menu-wrap têm z-index (80) e cada
// um cria um CONTEXTO DE EMPILHAMENTO. Enquanto o #navMenu ficava dentro deles,
// o z-index 10050 dele só valia entre irmãos — na página o menu era pintado no
// nível 80, ABAIXO do toast (#message, 9990) e dos overlays (9998/9999). O
// painel abria, mas quem recebia o toque era o que estava por cima: "Locais" e
// os demais itens não respondiam, e com um overlay na tela nem o hambúrguer
// respondia. A correção move o menu para o <body> ao abrir.
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

// 1) O menu precisa sair do contexto de empilhamento da barra ao abrir.
ok(
  /document\.body\.appendChild\(\s*m\s*\)/.test(js),
  "menu é movido para o <body> (sai do contexto de empilhamento da barra)"
);
ok(
  /_posicionarMenu[\s\S]{0,600}?document\.body\.appendChild|_portalMenu\(m\)/.test(js),
  "o reposicionamento do menu passa pelo portal para o <body>"
);

// 2) O clique dentro do menu não pode ser tratado como "clique fora".
ok(
  /closest\(['"]#navMenu['"]\)/.test(js),
  "handler de clique-fora reconhece o menu portado (#navMenu)"
);

// 3) O menu tem de ficar acima do toast (9990) e dos overlays (9998/9999).
const zMenu = Number((css.match(/\.nav-menu\s*\{[\s\S]*?z-index:\s*(\d+)/) || [])[1] || 0);
ok(zMenu > 9999, `.nav-menu acima dos overlays (z-index ${zMenu} > 9999)`);
ok(
  /m\.style\.zIndex = ['"]10050['"]/.test(js),
  "o z-index alto também é aplicado inline ao abrir"
);

// 4) Com os avisos de cadastro na tela a barra desce; o painel precisa subir
//    para caber inteiro, senão sobra uma fresta e "Locais" fica fora do alcance.
ok(
  /top \+ maxH > vh - margem/.test(js),
  "painel sobe quando não cabe abaixo do botão (não abre uma fresta)"
);
ok(
  !/maxH = Math\.max\(180, window\.innerHeight - r\.bottom/.test(js),
  "altura não é mais só o espaço abaixo do botão"
);

// 5) Os itens que o usuário reclamou continuam existindo e ligados.
ok(/onclick="toggleMenu\(event\)"/.test(html), "hambúrguer chama toggleMenu");
ok(/onclick="abrirLocais\(\)"/.test(html), 'item "Locais" ligado a abrirLocais');
ok(/onclick="abrirFavoritos\(\)"/.test(html), 'item "Meus locais favoritos" ligado a abrirFavoritos');
ok(/function abrirLocais/.test(js) && /function abrirFavoritos/.test(js), "abrirLocais/abrirFavoritos definidas no escopo global");

if (failed) process.exit(1);
console.log("\nUI menu OK");
