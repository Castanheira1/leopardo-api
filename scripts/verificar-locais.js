#!/usr/bin/env node
// Calibra coordenadas do catálogo via Google Places Text Search (New).
// Aceita o resultado do Google só quando o NOME bate (senão mantém ref).
// Uso: GOOGLE_MAPS_API_KEY=... node scripts/verificar-locais.js [--write]
const fs = require("fs");
const path = require("path");

const KEY = process.env.GOOGLE_MAPS_API_KEY;
if (!KEY) { console.error("Falta GOOGLE_MAPS_API_KEY"); process.exit(1); }
const WRITE = process.argv.includes("--write");

const CAT = path.join(__dirname, "..", "public", "locais-favoritos.json");
const cat = JSON.parse(fs.readFileSync(CAT, "utf8"));

const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[—–-]/g, " ").replace(/[()]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

function nomesCombinam(alvo, google) {
  const a = norm(alvo), g = norm(google);
  if (!a || !g) return false;
  if (a === g || g.includes(a) || a.includes(g)) return true;
  // Palavras significativas do alvo presentes no nome do Google.
  const stop = new Set(["s11d", "usina", "mina", "serra", "sul", "complexo", "vale", "de", "do", "da", "e"]);
  const palavras = a.split(" ").filter((w) => w.length > 2 && !stop.has(w));
  if (!palavras.length) return false;
  const hits = palavras.filter((w) => g.includes(w)).length;
  return hits / palavras.length >= 0.6;
}

async function textSearch(query, bias) {
  const body = { textQuery: query, languageCode: "pt-BR", regionCode: "BR", maxResultCount: 5 };
  if (bias) body.locationBias = { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: bias.raio } };
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": KEY,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) return { erro: data.error?.message || r.status };
  return { places: data.places || [] };
}

(async () => {
  const projeto = cat.projetos.S11D;
  const regiao = projeto.regiao;
  const bias = { lat: regiao.lat, lng: regiao.lng, raio: (regiao.raio_km || 45) * 1000 };
  let calibrados = 0, semMatch = 0;

  for (const grupo of projeto.grupos) {
    for (const l of grupo.locais) {
      const q = l.busca || l.nome;
      const res = await textSearch(q, bias);
      await new Promise((r) => setTimeout(r, 120));
      if (res.erro) { console.log(`ERRO   | ${l.nome} | ${res.erro}`); continue; }

      const match = (res.places || []).find((p) => p.location && nomesCombinam(l.nome, p.displayName?.text));
      if (match) {
        const novo = { lat: Number(match.location.latitude.toFixed(6)), lng: Number(match.location.longitude.toFixed(6)) };
        l.ref = novo;
        l.google = true;
        calibrados++;
        console.log(`OK     | ${l.nome}  ->  ${match.displayName.text}  (${novo.lat}, ${novo.lng})`);
      } else {
        delete l.google;
        semMatch++;
        const top = res.places?.[0]?.displayName?.text || "(nada)";
        console.log(`SEM    | ${l.nome} | Google devolveu: ${top} | mantém ref ${l.ref ? l.ref.lat + "," + l.ref.lng : "-"}`);
      }
    }
  }

  console.log(`\nCalibrados: ${calibrados} | Sem match: ${semMatch}`);
  if (WRITE) { fs.writeFileSync(CAT, JSON.stringify(cat, null, 2) + "\n"); console.log("Catálogo atualizado."); }
  else console.log("(dry-run — rode com --write para gravar)");
})();
