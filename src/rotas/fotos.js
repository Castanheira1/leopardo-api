// Upload de foto ao vivo (selfie/carro) para o Storage.
require("dotenv").config();
const app = require("../app");
const { upload, uploadToSupabase } = require("../storage");
const { verificarAuth } = require("../auth");

/* ============================ FOTOS ============================ */
// Recebe a foto capturada ao vivo pela câmera e devolve a URL pública.
// A pasta separa selfies/carros dentro do mesmo bucket.
app.post("/api/fotos", verificarAuth, upload.single("foto"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Foto é obrigatória" });
  if (req.body.origem !== "camera") {
    return res.status(400).json({ error: "Só é permitida foto capturada ao vivo pela câmera." });
  }
  const capturado = req.body.capturado_em ? new Date(req.body.capturado_em) : null;
  if (!capturado || Number.isNaN(capturado.getTime())) {
    return res.status(400).json({ error: "Carimbo de captura inválido." });
  }
  const diffMs = Date.now() - capturado.getTime();
  // iOS/Safari pode demorar para gerar o JPEG/abrir GPS e alguns aparelhos ficam
  // com o relógio levemente adiantado. Mantém a exigência de captura ao vivo,
  // mas evita falso "expirada" por lentidão ou pequeno desvio de relógio.
  const FOTO_MAX_IDADE_MS = 10 * 60 * 1000;
  const FOTO_MAX_RELOGIO_ADIANTADO_MS = 5 * 60 * 1000;
  if (diffMs < -FOTO_MAX_RELOGIO_ADIANTADO_MS || diffMs > FOTO_MAX_IDADE_MS) {
    return res.status(400).json({ error: "Foto expirada ou inválida. Tire uma nova foto com a câmera." });
  }
  const pasta = ["selfies", "carros"].includes(req.body.tipo) ? req.body.tipo : "outros";
  const url = await uploadToSupabase(req.file, pasta);
  if (!url) return res.status(500).json({ error: "Falha ao salvar a foto" });
  res.json({ url });
});

