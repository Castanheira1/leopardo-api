#!/usr/bin/env node
/** Testes da rotina de trabalho da frota fake. */
const assert = require("assert");
const R = require("../sim-rotina");

let passed = 0, failed = 0;
function test(nome, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${nome}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${nome}\n      ${e.message}`);
  }
}

console.log("\nsim-rotina");

test("minutosAgoraSP retorna 0–1439", () => {
  const m = R.minutosAgoraSP();
  assert.ok(m >= 0 && m < 1440, String(m));
});

test("emJanela normal e cruzando meia-noite", () => {
  assert.equal(R.emJanela(10 * 60, 8 * 60, 12 * 60), true);
  assert.equal(R.emJanela(7 * 60, 8 * 60, 12 * 60), false);
  // 18h–06h
  assert.equal(R.emJanela(20 * 60, 18 * 60, 6 * 60), true);
  assert.equal(R.emJanela(3 * 60, 18 * 60, 6 * 60), true);
  assert.equal(R.emJanela(12 * 60, 18 * 60, 6 * 60), false);
});

test("turno dia: de manhã indo trabalhar / noite em casa", () => {
  // uid % 10 >= 3 → dia
  const uid = 13;
  const rot = R.montarRotina(uid, []);
  assert.equal(rot.turno, "dia");
  const manha = R.faseNoRelogio(rot, rot.saidaCasa + 20);
  assert.ok(["indo_trabalho", "no_trabalho"].includes(manha.fase), manha.fase);
  const noite = R.faseNoRelogio(rot, 21 * 60);
  assert.equal(noite.fase, "em_casa");
});

test("turno dia: almoço na janela", () => {
  const rot = R.montarRotina(13, []);
  const alm = R.faseNoRelogio(rot, rot.almocoIni + 5);
  assert.equal(alm.fase, "almoco");
});

test("turno noite: plantão à noite, casa de dia", () => {
  // uid % 10 < 3 → noite
  const uid = 10;
  const rot = R.montarRotina(uid, []);
  assert.equal(rot.turno, "noite");
  const noite = R.faseNoRelogio(rot, 21 * 60);
  assert.ok(
    ["indo_trabalho", "no_trabalho", "janta"].includes(noite.fase),
    noite.fase
  );
  const tarde = R.faseNoRelogio(rot, 14 * 60);
  assert.equal(tarde.fase, "em_casa");
});

test("50 uids: ~30% noturno e todos com casa em Canaã", () => {
  let noite = 0;
  for (let id = 1; id <= 50; id++) {
    const r = R.montarRotina(id, [{ nome: "X", lat: -6.42, lng: -50.32 }]);
    if (r.turno === "noite") noite++;
    assert.ok(r.home.lat < -6.4 && r.home.lng > -50, "casa em Canaã");
    assert.ok(r.saidaCasa >= 0 && r.saidaCasa < 1440);
  }
  assert.ok(noite >= 10 && noite <= 20, `noite=${noite}`);
});

test("fmtMin", () => {
  assert.equal(R.fmtMin(7 * 60 + 5), "07:05");
  assert.equal(R.fmtMin(17 * 60 + 20), "17:20");
});

test("alvoMovimento parado quando no local", () => {
  const rot = R.montarRotina(13, []);
  const al = R.faseNoRelogio(rot, 21 * 60); // em casa
  const a = R.alvoMovimento(rot, 21 * 60, { lat: al.dest.lat, lng: al.dest.lng });
  assert.equal(a.chegou, true);
  assert.equal(a.deveMover, false);
});

test("almoço em Arara Azul ou Castanheira (coords calibradas)", () => {
  const locais = [
    { nome: "Restaurante Arara Azul — Usina", lat: -6.449452, lng: -50.242787 },
    { nome: "Refeitório Castanheira — Mina", lat: -6.4144833, lng: -50.3206306 },
  ];
  for (const uid of [13, 14, 15]) {
    const rot = R.montarRotina(uid, locais);
    assert.equal(rot.turno, "dia");
    const alm = R.faseNoRelogio(rot, rot.almocoIni + 5);
    assert.equal(alm.fase, "almoco");
    assert.ok(/arara azul|castanheira/i.test(alm.dest.nome), alm.dest.nome);
    assert.ok(
      Math.abs(alm.dest.lat - rot.restauranteAlmoco.lat) < 1e-6
    );
  }
});

test("janta (dia e noite) também em Arara Azul ou Castanheira", () => {
  const locais = [
    { nome: "Restaurante Arara Azul — Usina", lat: -6.449452, lng: -50.242787 },
    { nome: "Refeitório Castanheira — Mina", lat: -6.4144833, lng: -50.3206306 },
  ];
  // Dia
  const dia = R.montarRotina(13, locais);
  const jDia = R.faseNoRelogio(dia, dia.jantaIni + 5);
  assert.equal(jDia.fase, "janta");
  assert.ok(/arara azul|castanheira/i.test(jDia.dest.nome), jDia.dest.nome);
  assert.ok(Math.abs(jDia.dest.lat - dia.restauranteJanta.lat) < 1e-6);

  // Noite
  const noite = R.montarRotina(10, locais);
  assert.equal(noite.turno, "noite");
  const jNoite = R.faseNoRelogio(noite, noite.jantaIni + 5);
  assert.equal(jNoite.fase, "janta");
  assert.ok(/arara azul|castanheira/i.test(jNoite.dest.nome), jNoite.dest.nome);
  assert.ok(Math.abs(jNoite.dest.lat - noite.restauranteJanta.lat) < 1e-6);
});

console.log(`\n${passed} ok, ${failed} falha(s)`);
process.exit(failed ? 1 : 0);
