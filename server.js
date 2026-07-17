// VAP — ponto de entrada. A lógica vive em src/ (config, infra, serviços e
// rotas por domínio); este arquivo monta o pipeline HTTP na MESMA ordem do
// antigo monólito: middlewares globais → boot do banco → rotas →
// estáticos → tratador de erro → listen.
require("dotenv").config();

const express = require("express");
const path = require("path");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const compression = require("compression");

const app = require("./src/app");
const { PORT } = require("./src/config");
// Cedo de propósito: patcha console.error e captura uncaught/unhandled desde o boot.
require("./src/erros");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression({
  filter: (req, res) => {
    if (String(req.url || "").includes("/export")) return false;
    return compression.filter(req, res);
  },
}));
// 1200: o polling legítimo de um motorista em viagem chega perto de 600/15min.
// Configurável via RATE_LIMIT_MAX (ex.: testes de carga controlados) — padrão inalterado.
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX || 1200),
}));

// CORS restrito. O front (PWA) é servido pela MESMA origem desta API, então não
// precisa de CORS cross-origin no uso normal. Por padrão, nenhuma origem externa
// é liberada (same-origin continua funcionando). Para liberar um app/origem
// específica, defina CORS_ORIGINS="https://a.com,https://b.com" no ambiente.
// Antes era origin:"*", que deixava qualquer site chamar a API com o token do usuário.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: CORS_ORIGINS.length ? CORS_ORIGINS : false, // false = sem CORS externo (só mesma origem)
  credentials: true,
}));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));


// Conexão + auto-heal do schema (mesma sequência de passos do boot antigo).
require("./src/bootstrap-db");

// Agendadores de fundo (pedidos agendados, filas, limpezas, retenção, keep-alive).
require("./src/agendadores");

// Rotas da API — a ordem dos requires é a ordem de registro no Express e
// reproduz a ordem dos blocos do server.js original.
require("./src/rotas/config");
require("./src/rotas/push");
require("./src/rotas/auth");
require("./src/rotas/perfil");
require("./src/rotas/fotos");
require("./src/rotas/habilitacao");
require("./src/rotas/caronas");
require("./src/rotas/pedidos");
require("./src/rotas/match");
require("./src/rotas/propostas");
require("./src/rotas/fila");
require("./src/rotas/viagens");
require("./src/rotas/localizacao");
require("./src/rotas/contatos");
require("./src/rotas/admin");
require("./src/rotas/admin-rateio");
require("./src/rotas/admin-usuarios");
require("./src/rotas/admin-dono");

/* ============================ ESTÁTICOS ============================ */
// Vínculo domínio ↔ app nativo (lojas): a Apple exige o arquivo SEM extensão
// servido como application/json — o static devolveria octet-stream.
app.get("/.well-known/apple-app-site-association", (req, res) => {
  res.type("application/json");
  res.sendFile(path.join(__dirname, "public", ".well-known", "apple-app-site-association"));
});

// Imagens/fontes mudam raramente: cache de 7 dias no navegador corta requisições
// repetidas (CPU/banda na instância free do Render). HTML/JS/CSS e o
// service-worker ficam em no-cache: o navegador revalida sempre (304 barato) e
// atualizações do app chegam na hora — o cache offline fica por conta do SW.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (/\.(png|jpe?g|webp|ico|svg|woff2?)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=604800");
    } else {
      res.setHeader("Cache-Control", "no-cache");
    }
  },
}));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, req, res, next) => {
  console.error("ERRO GLOBAL:", err.message);
  res.status(500).json({ error: "Erro interno no servidor" });
});

app.listen(PORT, () => {
  console.log(`VAP rodando em http://localhost:${PORT}`);
});
