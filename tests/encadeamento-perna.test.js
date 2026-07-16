/**
 * Contrato do encadeamento de pernas (carona com várias vagas): ao encerrar uma
 * perna, o motorista emenda direto na PRÓXIMA — e a próxima é quem espera há MAIS
 * tempo (a perna mais antiga), não a mais recente.
 *
 * O fix é client-side (public/dashboard.html) e depende de um invariante do
 * backend (/api/viagens vem em created_at DESC, então a ÚLTIMA da lista é a mais
 * antiga). Este teste trava as duas pontas: a seleção no cliente e a ordenação
 * no servidor. Sem framework — regex/contrato sobre o código-fonte, igual aos
 * demais testes de contrato do projeto.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dash = fs.readFileSync(path.join(root, "public/dashboard.html"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("OK:", msg);
  }
}

// Recorta o corpo da função emendarProximaPerna para não casar por acidente.
const m = dash.match(/async function emendarProximaPerna\(\)\s*\{[\s\S]*?\n {4}\}/);
ok(!!m, "emendarProximaPerna existe em dashboard.html");
const corpo = m ? m[0] : "";

// Seleciona a perna MAIS ANTIGA = último item da lista (created_at DESC).
ok(
  /pendentes\[pendentes\.length\s*-\s*1\]/.test(corpo),
  "emendarProximaPerna atende a perna mais antiga (pendentes[pendentes.length - 1])"
);
// Não pode ter voltado a pegar a mais recente (pendentes[0]).
ok(
  !/const\s+prox\s*=\s*pendentes\[0\]/.test(corpo),
  "emendarProximaPerna NÃO pega a perna mais recente (pendentes[0])"
);
// Só considera pernas em andamento do próprio motorista.
ok(
  /status\s*===\s*'em_andamento'/.test(corpo) && /motorista_id/.test(corpo),
  "emendarProximaPerna filtra pernas em andamento do próprio motorista"
);

// Invariante do backend que sustenta o "última = mais antiga": /api/viagens
// precisa vir em created_at DESC.
const rotaViagens = server.match(/app\.get\("\/api\/viagens",[\s\S]*?\n\}\);/);
ok(!!rotaViagens, "rota GET /api/viagens existe em server.js");
ok(
  rotaViagens && /ORDER BY\s+v\.created_at\s+DESC/.test(rotaViagens[0]),
  "/api/viagens ordena por created_at DESC (a última da lista é a mais antiga)"
);

if (failed) {
  console.error(`\n${failed} verificação(ões) falharam.`);
  process.exit(1);
}
console.log("\nContrato de encadeamento de perna: OK");
