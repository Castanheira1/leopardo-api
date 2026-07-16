// Supabase Storage (upload/remoção de fotos), multer e retenção de 30 dias.
require("dotenv").config();
const path = require("path");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const { SUPABASE_BUCKET } = require("./config");
const { pool } = require("./db");

// Não derruba o boot quando o Supabase ainda não foi configurado:
// o app sobe e serve as páginas; apenas o upload de fotos fica indisponível.
const supabaseConfigurado = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
if (!supabaseConfigurado) {
  console.warn("AVISO: SUPABASE_URL/SUPABASE_KEY não definidos — upload de fotos desativado.");
}
const supabase = createClient(
  process.env.SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_KEY || "placeholder-key"
);

// Upload genérico para o Supabase Storage (mesmo mecanismo das fotos de carro)
const uploadToSupabase = async (file, pasta = "") => {
  if (!file) return null;
  try {
    const prefixo = pasta ? `${pasta.replace(/\/$/, "")}/` : "";
    const fileName = `${prefixo}${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname) || ".jpg"}`;

    const { error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(fileName, file.buffer, { contentType: file.mimetype, upsert: false });

    if (error) {
      console.error("Erro upload Supabase:", error.message);
      return null;
    }

    const { data: urlData } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(fileName);
    return urlData.publicUrl;
  } catch (err) {
    console.error("Erro upload:", err.message);
    return null;
  }
};

function pathFromPublicUrl(url) {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${SUPABASE_BUCKET}/`;
  const i = url.indexOf(marker);
  if (i === -1) return null;
  return decodeURIComponent(url.slice(i + marker.length));
}

async function apagarFotoStorage(url) {
  const p = pathFromPublicUrl(url);
  if (!p || !supabaseConfigurado) return;
  try {
    await supabase.storage.from(SUPABASE_BUCKET).remove([p]);
  } catch (e) {
    console.warn("apagarFotoStorage:", e.message);
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    ["image/jpeg", "image/png", "image/webp", "image/jpg"].includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Apenas imagens"), false),
});


async function aplicarRetencaoFotos() {
  if (!supabaseConfigurado) return;
  const limite = "NOW() - INTERVAL '30 days'";
  const fontes = [
    { tabela: "habilitacoes_motorista", data: "created_at", cols: ["selfie_url", "foto_carro_url"] },
    { tabela: "pedidos", data: "created_at", cols: ["selfie_url"] },
    { tabela: "propostas", data: "created_at", cols: ["selfie_url"] },
  ];
  for (const f of fontes) {
    for (const col of f.cols) {
      try {
        const { rows } = await pool.query(
          `SELECT id, ${col} AS url FROM ${f.tabela}
           WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${f.data} < ${limite}
           LIMIT 200`
        );
        for (const r of rows) {
          await apagarFotoStorage(r.url);
          await pool.query(`UPDATE ${f.tabela} SET ${col} = NULL WHERE id = $1`, [r.id]);
        }
        if (rows.length) console.log(`retencao: ${rows.length} foto(s) em ${f.tabela}.${col}`);
      } catch (e) {
        console.warn("aplicarRetencaoFotos:", f.tabela, e.message);
      }
    }
  }
}


module.exports = {
  supabaseConfigurado,
  supabase,
  uploadToSupabase,
  pathFromPublicUrl,
  apagarFotoStorage,
  upload,
  aplicarRetencaoFotos,
};
