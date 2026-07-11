#!/usr/bin/env node
/**
 * Testes unitários dos helpers da frota fake (sem Postgres / sem server).
 * Uso: node tests/sim-frota-helpers.test.js
 */
const assert = require("assert");
const path = require("path");
const sim = require(path.join(__dirname, "..", "sim-frota.js"));
const h = sim._helpers;

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

console.log("\nsim-frota helpers");

test("distKm ~0 no mesmo ponto", () => {
  assert.ok(h.distKm({ lat: -6.5, lng: -49.9 }, { lat: -6.5, lng: -49.9 }) < 1e-6);
});

test("distKm S11D–Canaã em faixa razoável (30–80 km)", () => {
  const d = h.distKm({ lat: -6.43, lng: -50.28 }, h.CANAA_CENTRO);
  assert.ok(d > 30 && d < 80, `dist=${d}`);
});

test("avancarNaRota percorre e termina", () => {
  const pts = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 0.1 },
    { lat: 0, lng: 0.2 },
  ];
  let pos = pts[0], idx = 1;
  let fim = false, guard = 0;
  while (!fim && guard++ < 1000) {
    const r = h.avancarNaRota(pts, idx, pos, 5); // 5 km/passo
    pos = r.pos;
    idx = r.idx;
    fim = r.fim;
  }
  assert.ok(fim, "deveria chegar ao fim");
  assert.ok(h.distKm(pos, pts[pts.length - 1]) < 0.05);
});

test("avancarNaRota passo parcial fica entre pontos", () => {
  const a = { lat: 0, lng: 0 };
  const b = { lat: 0, lng: 0.01 }; // ~1.11 km
  const r = h.avancarNaRota([a, b], 1, a, 0.5);
  assert.equal(r.fim, false);
  assert.ok(r.pos.lng > a.lng && r.pos.lng < b.lng);
});

test("decimar reduz pontos mantendo extremos", () => {
  const pts = [];
  for (let i = 0; i < 20; i++) pts.push({ lat: 0, lng: i * 0.001 });
  const d = h.decimar(pts, 0.5);
  assert.ok(d.length < pts.length);
  assert.deepStrictEqual(d[0], pts[0]);
  assert.deepStrictEqual(d[d.length - 1], pts[pts.length - 1]);
});

test("decodificarPolyline round-trip mínimo (vazio)", () => {
  assert.deepStrictEqual(h.decodificarPolyline(""), []);
});

test("jitter fica perto do centro", () => {
  const c = { lat: -6.5, lng: -49.9 };
  const j = h.jitter(c, 200);
  assert.ok(h.distKm(c, j) <= 0.25);
});

test("round4 arredonda", () => {
  const r = h.round4({ lat: -6.123456789, lng: -49.987654321 });
  assert.equal(r.lat, -6.1235);
  assert.equal(r.lng, -49.9877);
});

test("constantes de realismo presentes", () => {
  assert.equal(h.VEL_KMH, 90);
  assert.equal(h.TICK_MS, 5000);
  assert.equal(h.SIM_HEADER, "X-Sim-Frota");
});

test("passo a 90 km/h em 5 s ≈ 0.125 km", () => {
  const passo = h.VEL_KMH * (h.TICK_MS / 1000) / 3600;
  assert.ok(Math.abs(passo - 0.125) < 1e-9, `passo=${passo}`);
});

test("contornoAoRedor não cai no pin do passageiro e espaça uids", () => {
  const centro = h.CANAA_CENTRO;
  const a = h.contornoAoRedor(centro, 10);
  const b = h.contornoAoRedor(centro, 11);
  const dCentro = h.distKm(centro, a);
  assert.ok(dCentro >= 0.3 && dCentro <= 1.6, `raio=${dCentro}`);
  assert.ok(h.distKm(a, b) > 0.05, "uids diferentes devem se afastar");
  // estável: mesmo uid = mesmo ponto
  assert.deepStrictEqual(h.contornoAoRedor(centro, 10), a);
});

test("posNascimentoS11D espalha carros perto do portão", () => {
  const locais = [
    { nome: "A", lat: -6.43, lng: -50.28 },
    { nome: "B", lat: -6.41, lng: -50.25 },
    { nome: "C", lat: -6.45, lng: -50.30 },
  ];
  const p0 = h.posNascimentoS11D(locais, 0);
  const p1 = h.posNascimentoS11D(locais, 1);
  // Nascimento no anel do portão (120–400 m), não no mato interior
  assert.ok(h.distKm(p0.pos, p0.A) >= 0.1 && h.distKm(p0.pos, p0.A) <= 0.5);
  assert.ok(h.distKm(p0.pos, p1.pos) > 0.02);
});

console.log(`\n${passed} ok, ${failed} falha(s)`);
process.exit(failed ? 1 : 0);
