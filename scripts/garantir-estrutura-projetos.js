/**
 * Garante estrutura multi-projeto pronta:
 * - linhas em `projetos` (banco)
 * - esqueleto em `public/locais-favoritos.json` (só preencher locais)
 *
 * Não duplica o app. Não apaga locais do S11D.
 * Uso: node scripts/garantir-estrutura-projetos.js
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const CAT_PATH = path.join(__dirname, "..", "public", "locais-favoritos.json");

/** Grupos-padrão (mesmo formato S11D). Locais vazios = calibrar depois. */
const GRUPOS_VAZIOS = () => [
  { titulo: "Acessos e apoio", locais: [] },
  { titulo: "Usina / planta", locais: [] },
  { titulo: "Mina / frente", locais: [] },
  { titulo: "Oficinas e manutenção", locais: [] },
  { titulo: "Canteiros e obras", locais: [] },
  { titulo: "Outros pontos", locais: [] },
];

/**
 * Projetos oficiais. regiao = centro aproximado do canteiro (viés de mapa/Google).
 * Ajustar lat/lng quando calibrar; não precisa ser perfeito no esqueleto.
 */
const PROJETOS = [
  {
    codigo: "S11D",
    nome: "S11D — Serra Sul (Canaã dos Carajás/PA)",
    // S11D já tem locais no JSON — não sobrescrevemos grupos preenchidos
    regiao: { lat: -6.428, lng: -50.285, raio_km: 45 },
  },
  {
    codigo: "SALOBO",
    nome: "Salobo",
    regiao: { lat: -5.79, lng: -50.53, raio_km: 40 },
  },
  {
    codigo: "CARAJAS",
    nome: "Carajás",
    regiao: { lat: -6.06, lng: -50.17, raio_km: 40 },
  },
  {
    codigo: "PARAUAPEBAS",
    nome: "Parauapebas",
    regiao: { lat: -6.067, lng: -49.902, raio_km: 35 },
  },
  {
    codigo: "SOSSEGO",
    nome: "Sossego",
    regiao: { lat: -6.43, lng: -50.05, raio_km: 40 },
  },
  {
    codigo: "ONCA-PUMA",
    nome: "Onça Puma",
    regiao: { lat: -6.75, lng: -51.08, raio_km: 40 },
  },
];

function esqueleto(p) {
  return {
    nome: p.nome,
    regiao: { ...p.regiao },
    calibrado: false,
    nota: "Estrutura pronta. Preencha grupos[].locais com { nome, busca, ref:{lat,lng}, google?:true }. Rode scripts/verificar-locais.js --write se quiser validar no Google.",
    grupos: GRUPOS_VAZIOS(),
  };
}

async function garantirBanco() {
  if (!process.env.DATABASE_URL) {
    console.warn("Sem DATABASE_URL — só atualiza o JSON.");
    return;
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    for (const p of PROJETOS) {
      // Nome curto no banco (cadastro); JSON guarda o nome longo de exibição dos locais.
      const nomeDb = p.codigo === "ONCA-PUMA" ? "Onça Puma"
        : p.codigo === "S11D" ? "S11D"
        : p.nome.split("—")[0].trim();
      await pool.query(
        `INSERT INTO projetos (nome, codigo, valor_contrato_mensal, ativo)
         VALUES ($1, $2, 0, TRUE)
         ON CONFLICT (codigo) DO UPDATE SET ativo = TRUE`,
        [nomeDb, p.codigo]
      );
      const q = await pool.query(
        "SELECT id, codigo, nome, COALESCE(ativo,TRUE) AS ativo FROM projetos WHERE codigo = $1",
        [p.codigo]
      );
      const row = q.rows[0];
      console.log("DB ok", row.codigo, "id=", row.id, "ativo=", row.ativo);
    }
  } finally {
    await pool.end();
  }
}

function garantirJson() {
  const cat = JSON.parse(fs.readFileSync(CAT_PATH, "utf8"));
  if (!cat.projetos) cat.projetos = {};

  cat.descricao =
    "Catálogo de locais POR PROJETO (chave = projetos.codigo). " +
    "O app NÃO é duplicado: um único dashboard.js lê só projetos[codigoDoUsuario]. " +
    "S11D está calibrado; os demais têm estrutura pronta (grupos vazios) — só preencher locais. " +
    "ref = lat/lng curados; google:true = confirmado via Places (scripts/verificar-locais.js).";

  cat.versao = Number(cat.versao || 1) + 0; // keep
  if (!cat.como_adicionar_projeto) {
    cat.como_adicionar_projeto = [
      "1) Criar/ativar linha em tabela projetos (dono.html ou este script)",
      "2) Garantir chave em projetos.<CODIGO> neste JSON (esqueleto)",
      "3) Preencher grupos[].locais com nome, busca, ref.lat/lng",
      "4) Ajustar regiao (centro + raio_km) do canteiro",
      "5) Deploy do public/ (Render). Não precisa novo app.",
    ];
  }

  for (const p of PROJETOS) {
    const cod = p.codigo;
    const atual = cat.projetos[cod];
    if (!atual) {
      cat.projetos[cod] = esqueleto(p);
      console.log("JSON: criado esqueleto", cod);
      continue;
    }
    // Preserva S11D (e qualquer um já com locais)
    const nLocais = (atual.grupos || []).reduce((a, g) => a + (g.locais || []).length, 0);
    if (nLocais > 0) {
      console.log("JSON: mantido (já tem", nLocais, "locais)", cod);
      // só garante regiao se faltar
      if (!atual.regiao) atual.regiao = { ...p.regiao };
      if (atual.calibrado === undefined) atual.calibrado = true;
      continue;
    }
    // Vazio ou incompleto: normaliza esqueleto sem apagar se já tiver nome custom
    cat.projetos[cod] = {
      ...esqueleto(p),
      nome: atual.nome || p.nome,
      regiao: atual.regiao && atual.regiao.lat != null ? atual.regiao : { ...p.regiao },
      grupos: (atual.grupos && atual.grupos.length) ? atual.grupos : GRUPOS_VAZIOS(),
    };
    console.log("JSON: esqueleto normalizado", cod);
  }

  fs.writeFileSync(CAT_PATH, JSON.stringify(cat, null, 2) + "\n", "utf8");
  console.log("Gravado", CAT_PATH);
}

(async () => {
  await garantirBanco();
  garantirJson();
  console.log("\nPronto. App único; cada projeto = chave no JSON + linha no banco.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
