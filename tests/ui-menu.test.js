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

// 2b) Ghost click do WebView: sem trava o menu abre e fecha no mesmo gesto.
ok(
  /_menuTravaAte\s*=\s*Date\.now\(\)\s*\+\s*\d+/.test(js),
  "ao abrir, trava toggle/clique-fora contra o click sintético do WebView"
);
ok(
  /if\s*\(\s*Date\.now\(\)\s*<\s*_menuTravaAte\s*\)\s*return/.test(js),
  "toggleMenu e clique-fora respeitam a trava pós-abertura"
);

// 3) O menu tem de ficar acima do toast (9990) e dos overlays (9998/9999).
const zMenu = Number((css.match(/\.nav-menu\s*\{[\s\S]*?z-index:\s*(\d+)/) || [])[1] || 0);
ok(zMenu > 9999, `.nav-menu acima dos overlays (z-index ${zMenu} > 9999)`);
ok(
  /m\.style\.zIndex = ['"]10050['"]/.test(js),
  "o z-index alto também é aplicado inline ao abrir"
);

// 4) O painel escolhe o lado com mais espaço e ENCOLHE para caber nele — nunca
//    invade a faixa do hambúrguer.
//
//    A regra antiga era outra: altura fixa de ~640px e, se não coubesse abaixo
//    do botão, o painel subia até caber na tela (`top + maxH > vh - margem`).
//    Num celular de 844px isso punha o topo do painel em y=196 com o botão em
//    y=202..240 — o painel abria EM CIMA do hambúrguer, com o "X" bem onde o
//    dedo estava, e o click sintético do WebView fechava o menu no mesmo gesto.
//    Por isso a expressão antiga é cobrada como AUSENTE aqui.
//
//    Quem prova a regra de verdade é tests/ui-toque.test.js, que mede num
//    Chromium real se o centro do ☰ continua atendido pelo próprio ☰.
ok(
  !/top \+ maxH > vh - margem/.test(js),
  "painel não é mais empurrado para cima do botão quando não cabe abaixo"
);
ok(
  /const abaixo = vh - margem - \(r\.bottom \+ margem\)/.test(js)
    && /const acima = r\.top - 2 \* margem/.test(js)
    && /if \(abaixo >= acima\)/.test(js),
  "altura vem do espaço livre do lado escolhido (abaixo vs acima)"
);
ok(
  /overflow-y:\s*auto/.test(css.match(/\.nav-menu\s*\{[\s\S]*?\}/)?.[0] || ""),
  "encolher é seguro: .nav-menu rola o que não couber"
);

// 5) Os itens que o usuário reclamou continuam existindo e ligados.
ok(/onclick="toggleMenu\(event\)"/.test(html), "hambúrguer chama toggleMenu");
ok(/onclick="abrirLocais\(\)"/.test(html), 'item "Locais" ligado a abrirLocais');
ok(/onclick="abrirFavoritos\(\)"/.test(html), 'item "Meus locais favoritos" ligado a abrirFavoritos');
ok(/function abrirLocais/.test(js) && /function abrirFavoritos/.test(js), "abrirLocais/abrirFavoritos definidas no escopo global");

// 6) O toast (#message) não pode engolir o toque de um botão que ele cubra.
//    Ele fica fixo no rodapé (z 9990), bem em cima do CTA do sheet — o botão
//    principal do app ficava morto durante os 5-9 s do aviso.
const toast = (css.match(/body\.theme-dark #message\.message \{[\s\S]*?\}/) || [""])[0];
ok(/pointer-events:\s*none/.test(toast), "toast fixo não intercepta toque (pointer-events: none)");
ok(
  /pointer-events:none/.test(fs.readFileSync(path.join(root, "public/app.js"), "utf8")),
  "toast criado em JS (mostrarToast) também não intercepta"
);

// 7) A aba ativa precisa caber no espaço real — o piso do CSS é medido contra a
//    janela e, com os avisos de cadastro no topo, empurrava o CTA para fora.
ok(/function ajustarAlturaAba/.test(js), "existe o ajuste de altura da aba ativa");
ok(
  /tab\.style\.minHeight = disponivel/.test(js),
  "o ajuste sobrescreve o min-height (min-height vence max-height no CSS)"
);
ok(/new ResizeObserver\(\(\) => ajustarAlturaAba\(\)\)/.test(js), "re-mede quando os avisos entram/saem");

if (failed) process.exit(1);
console.log("\nUI menu OK");
