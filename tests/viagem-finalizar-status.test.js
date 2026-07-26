/**
 * Contrato: finalizar NÃO pode ressuscitar viagem cancelada/concluída.
 * Regressão do bug em que escape do passageiro + auto-finalizar do motorista
 * virava 'concluida' e entrava no rateio.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const rotas = fs.readFileSync(path.join(root, "src/rotas/viagens.js"), "utf8");
const svc = fs.readFileSync(path.join(root, "src/services/viagens.js"), "utf8");

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("OK:", msg);
  }
}

const blocoFinalizar = rotas.slice(
  rotas.indexOf('app.post("/api/viagens/:id/finalizar"'),
  rotas.indexOf('app.post("/api/viagens/:id/cancelar"')
);

ok(/v\.status\s*!==\s*['"]em_andamento['"]/.test(blocoFinalizar), "guard status antes do UPDATE");
ok(
  /WHERE id = \$1 AND status = 'em_andamento' RETURNING \*/.test(blocoFinalizar),
  "UPDATE finalizar exige em_andamento"
);
ok(/status\(409\)/.test(blocoFinalizar), "responde 409 se já encerrada");

ok(
  /jaEmbarcou|embarque_em[\s\S]*cancelado/.test(svc) ||
    /fase === ["']destino["'][\s\S]*cancelado/.test(svc),
  "reverterRecursos: após embarque cancela pedido (não reabre)"
);

if (failed) {
  console.error(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log("\nContrato finalizar/status OK");
