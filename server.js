const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const ExcelJS = require("exceljs");
const { Storage } = require("@google-cloud/storage");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

app.set("trust proxy", 1);

if (!JWT_SECRET) {
  console.error("ERRO: JWT_SECRET não definido no .env");
  process.exit(1);
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

pool.connect()
  .then(client => { console.log("Conectado ao PostgreSQL"); client.release(); })
  .catch(err => console.log("Erro ao conectar:", err.message));

let gcsStorage = null;
const bucketName = process.env.GCS_BUCKET_NAME;

if (process.env.GCP_SERVICE_ACCOUNT_KEY && bucketName) {
  try {
    const gcpKeyPath = path.join(__dirname, "gcp-key.json");
    fs.writeFileSync(gcpKeyPath, process.env.GCP_SERVICE_ACCOUNT_KEY.trim());
    console.log("Arquivo gcp-key.json criado com sucesso");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = gcpKeyPath;

    gcsStorage = new Storage({
      keyFilename: gcpKeyPath,
      projectId: JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY).project_id,
      retryOptions: { autoRetry: true, maxRetries: 5 },
      timeout: 30000
    });

    console.log("Google Cloud Storage inicializado CORRETAMENTE");
  } catch (err) {
    console.error("FALHA AO INICIAR GCS:", err.message);
    gcsStorage = null;
  }
} else {
  console.warn("GCP_SERVICE_ACCOUNT_KEY ou GCS_BUCKET_NAME ausente");
}

const uploadToGCS = async (file) => {
  if (!file) return null;
  if (!gcsStorage || !bucketName) {
    console.warn("GCS indisponível");
    return null;
  }
  try {
    const gcsFileName = `uploads/${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    const blob = gcsStorage.bucket(bucketName).file(gcsFileName);
    await blob.save(file.buffer, { contentType: file.mimetype, public: true });
    const url = `https://storage.googleapis.com/${bucketName}/${gcsFileName}`;
    console.log("Upload OK:", url);
    return url;
  } catch (err) {
    console.error("ERRO NO UPLOAD GCS:", err.message);
    return null;
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    ["image/jpeg", "image/png", "image/webp", "image/jpg"].includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Apenas imagens"), false),
});

const verificarAuth = (req, res, next) => {
  const auth = req.headers.authorization || "";
  const tokenHeader = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const token = tokenHeader || req.query.token;
  if (!token) return res.status(401).json({ error: "Token não fornecido" });
  try {
    req.user = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
};

const verificarAdmin = (req, res, next) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: "Apenas administradores" });
  next();
};

setInterval(async () => {
  try {
    await pool.query(`
      UPDATE viagens SET status = 'expirado'
      WHERE status = 'pendente' AND created_at < NOW() - INTERVAL '30 minutes'
    `);
  } catch (err) {
    console.error("Erro ao expirar viagens:", err);
  }
}, 60000);

app.post("/api/register", async (req, res) => {
  const { nome, funcao, matricula, senha } = req.body;
  if (!nome || !matricula || !senha) return res.status(400).json({ error: "Preencha todos os campos" });

  try {
    const check = await pool.query("SELECT id FROM usuarios WHERE matricula = $1", [matricula]);
    if (check.rows.length > 0) return res.status(400).json({ error: "Matrícula já cadastrada" });

    const senha_hash = await bcrypt.hash(senha, 10);
    const is_admin = matricula === "000000";

    const { rows } = await pool.query(
      "INSERT INTO usuarios (nome, matricula, senha_hash, funcao, is_admin) VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, matricula, is_admin",
      [nome, matricula, senha_hash, funcao || null, is_admin]
    );

    const token = jwt.sign({ id: rows[0].id, matricula, is_admin }, JWT_SECRET, { algorithm: "HS256", expiresIn: "8h" });
    res.json({ success: true, token, user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao criar conta" });
  }
});

app.post("/api/login", async (req, res) => {
  const { matricula, senha } = req.body;
  if (!matricula || !senha) return res.status(400).json({ error: "Campos obrigatórios" });

  try {
    const { rows } = await pool.query("SELECT * FROM usuarios WHERE matricula = $1", [matricula]);
    if (!rows.length || !(await bcrypt.compare(senha, rows[0].senha_hash)))
      return res.status(401).json({ error: "Credenciais inválidas" });

    const user = rows[0];
    const token = jwt.sign(
      { id: user.id, matricula: user.matricula, is_admin: user.is_admin },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: "8h" }
    );

    res.json({ token, user: { id: user.id, nome: user.nome, matricula: user.matricula, is_admin: user.is_admin } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro no login" });
  }
});

app.post("/api/veiculos", verificarAuth, verificarAdmin, upload.single("foto"), async (req, res) => {
  const { modelo, placa } = req.body;
  if (!modelo || !placa) return res.status(400).json({ error: "Modelo e placa obrigatórios" });

  const fotoUrl = await uploadToGCS(req.file);

  try {
    const { rows } = await pool.query(
      "INSERT INTO veiculos (modelo, placa, foto, ativo) VALUES ($1, $2, $3, true) RETURNING *",
      [modelo, placa.toUpperCase(), fotoUrl]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error("Erro ao cadastrar veículo:", err.message);
    res.status(500).json({ error: "Erro ao cadastrar veículo" });
  }
});

app.get("/api/veiculos", verificarAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT v.*, EXISTS(SELECT 1 FROM viagens WHERE veiculo_id = v.id AND status IN ('pendente','em_uso')) as em_uso
    FROM veiculos v ORDER BY v.id DESC
  `);
  res.json(rows);
});

app.patch("/api/veiculos/:id/toggle", verificarAuth, verificarAdmin, async (req, res) => {
  const { rows } = await pool.query("UPDATE veiculos SET ativo = NOT ativo WHERE id = $1 RETURNING *", [req.params.id]);
  rows.length ? res.json(rows[0]) : res.status(404).json({ error: "Não encontrado" });
});

app.delete("/api/veiculos/:id", verificarAuth, verificarAdmin, async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM veiculos WHERE id = $1", [req.params.id]);
  rowCount ? res.json({ success: true }) : res.status(404).json({ error: "Não encontrado" });
});

app.get("/api/viagens/disponiveis", verificarAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT v.id, v.modelo, v.placa, v.foto FROM veiculos v
    WHERE v.ativo AND v.id NOT IN (SELECT veiculo_id FROM viagens WHERE status IN ('pendente','em_uso'))
    ORDER BY v.modelo
  `);
  res.json(rows);
});

app.post("/api/viagens", verificarAuth, async (req, res) => {
  const { veiculo_id, justificativa } = req.body;
  if (!veiculo_id || !justificativa) return res.status(400).json({ error: "Preencha tudo" });
  const { rows } = await pool.query(
    "INSERT INTO viagens (usuario_id, veiculo_id, justificativa, status) VALUES ($1,$2,$3,'pendente') RETURNING *",
    [req.user.id, veiculo_id, justificativa]
  );
  res.json(rows[0]);
});

app.get("/api/minhas-viagens", verificarAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT v.*, ve.modelo, ve.placa, EXTRACT(EPOCH FROM (NOW() - v.created_at)) as segundos_desde_criacao
    FROM viagens v JOIN veiculos ve ON v.veiculo_id = ve.id
    WHERE v.usuario_id = $1 ORDER BY v.created_at DESC
  `, [req.user.id]);
  res.json(rows);
});

app.get("/api/admin/viagens/pendentes", verificarAuth, verificarAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT v.*, ve.modelo, ve.placa, u.nome, u.matricula,
           EXTRACT(EPOCH FROM (NOW() - v.created_at))/60 as minutos_passados
    FROM viagens v JOIN veiculos ve ON v.veiculo_id = ve.id
    JOIN usuarios u ON v.usuario_id = u.id
    WHERE v.status='pendente' ORDER BY v.created_at
  `);
  res.json(rows);
});

app.get("/api/admin/viagens/em-uso", verificarAuth, verificarAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT v.*, ve.modelo, ve.placa, u.nome, u.matricula,
           TO_CHAR(v.data_inicio AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY, HH24:MI:SS') as data_inicio_br
    FROM viagens v JOIN veiculos ve ON v.veiculo_id = ve.id
    JOIN usuarios u ON v.usuario_id = u.id
    WHERE v.status='em_uso' ORDER BY v.data_inicio
  `);
  res.json(rows);
});

app.post("/api/admin/viagens/:id/start", verificarAuth, verificarAdmin, async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE viagens SET status='em_uso', data_inicio=NOW() WHERE id=$1 AND status='pendente' RETURNING *", [req.params.id]
  );
  rows.length ? res.json(rows[0]) : res.status(404).json({ error: "Não encontrada" });
});

app.post("/api/admin/viagens/:id/stop", verificarAuth, verificarAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    UPDATE viagens SET status='concluido', data_fim=NOW(),
    tempo_dias = EXTRACT(DAY FROM (NOW() - data_inicio)),
    tempo_horas = EXTRACT(EPOCH FROM (NOW() - data_inicio))/3600
    WHERE id=$1 AND status='em_uso' RETURNING *`, [req.params.id]
  );
  rows.length ? res.json(rows[0]) : res.status(404).json({ error: "Não encontrada" });
});

app.get("/api/admin/viagens/export-xlsx", verificarAuth, verificarAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.nome, u.matricula, u.funcao, ve.modelo, ve.placa, v.justificativa, v.status,
        TO_CHAR(v.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as solicitado_em,
        TO_CHAR(v.data_inicio AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as data_inicio_br,
        TO_CHAR(v.data_fim AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as data_fim_br,
        v.tempo_dias, v.tempo_horas
      FROM viagens v
      JOIN usuarios u ON v.usuario_id = u.id
      JOIN veiculos ve ON v.veiculo_id = ve.id
      WHERE v.status = 'concluido'
      ORDER BY v.data_fim DESC
    `);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'LEOPARDO';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Histórico de Viagens', {
      properties: { tabColor: { argb: '003D6D' } },
      views: [{ state: 'frozen', ySplit: 2 }]
    });

    sheet.mergeCells('A1:I1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = 'LEOPARDO - Relatório de Viagens Concluídas';
    titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003D6D' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(1).height = 35;

    sheet.columns = [
      { key: 'nome', width: 30 },
      { key: 'matricula', width: 12 },
      { key: 'funcao', width: 20 },
      { key: 'veiculo', width: 22 },
      { key: 'placa', width: 12 },
      { key: 'justificativa', width: 40 },
      { key: 'inicio', width: 18 },
      { key: 'fim', width: 18 },
      { key: 'duracao', width: 14 }
    ];

    const headerRow = sheet.getRow(2);
    headerRow.values = ['Colaborador', 'Matrícula', 'Função', 'Veículo', 'Placa', 'Justificativa', 'Início', 'Fim', 'Duração'];
    headerRow.height = 25;
    headerRow.eachCell((cell) => {
      cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0066B3' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF003D6D' } },
        bottom: { style: 'thin', color: { argb: 'FF003D6D' } },
        left: { style: 'thin', color: { argb: 'FF003D6D' } },
        right: { style: 'thin', color: { argb: 'FF003D6D' } }
      };
    });

    rows.forEach((row, idx) => {
      let duracao = '—';
      if (row.tempo_horas) {
        const horas = Math.floor(row.tempo_horas);
        const minutos = Math.round((row.tempo_horas - horas) * 60);
        duracao = `${horas}h ${minutos}min`;
      }

      const dataRow = sheet.addRow({
        nome: row.nome,
        matricula: row.matricula,
        funcao: row.funcao || '—',
        veiculo: row.modelo,
        placa: row.placa,
        justificativa: row.justificativa,
        inicio: row.data_inicio_br || '—',
        fim: row.data_fim_br || '—',
        duracao: duracao
      });

      dataRow.height = 22;
      const isEven = idx % 2 === 0;

      dataRow.eachCell((cell, colNumber) => {
        cell.font = { name: 'Arial', size: 10 };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: isEven ? 'FFF8FAFC' : 'FFFFFFFF' }
        };
        cell.border = {
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        };
        cell.alignment = { vertical: 'middle', horizontal: colNumber <= 2 ? 'left' : 'center' };
      });
    });

    sheet.addRow([]);
    const footerRow = sheet.addRow([`Gerado em: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} | Total: ${rows.length} viagens`]);
    sheet.mergeCells(`A${footerRow.number}:I${footerRow.number}`);
    footerRow.getCell(1).font = { name: 'Arial', size: 9, italic: true, color: { argb: 'FF666666' } };
    footerRow.getCell(1).alignment = { horizontal: 'right' };

    sheet.autoFilter = { from: 'A2', to: 'I2' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=leopardo_viagens_${new Date().toISOString().split('T')[0]}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao exportar XLSX" });
  }
});

app.get("/api/admin/stats", verificarAuth, verificarAdmin, async (req, res) => {
  const [a,b,c,d,e,f] = await Promise.all([
    pool.query("SELECT COUNT(*) FROM veiculos"),
    pool.query("SELECT COUNT(*) FROM veiculos WHERE ativo"),
    pool.query("SELECT COUNT(*) FROM usuarios"),
    pool.query("SELECT COUNT(*) FROM viagens WHERE status='pendente'"),
    pool.query("SELECT COUNT(*) FROM viagens WHERE status='em_uso'"),
    pool.query("SELECT COUNT(*) FROM viagens WHERE status='concluido'")
  ]);
  res.json({
    totalVeiculos: +a.rows[0].count,
    veiculosAtivos: +b.rows[0].count,
    totalUsuarios: +c.rows[0].count,
    viagensPendentes: +d.rows[0].count,
    viagensEmUso: +e.rows[0].count,
    viagensConcluidas: +f.rows[0].count
  });
});

app.post("/api/admin/reset-senha", verificarAuth, verificarAdmin, async (req, res) => {
  const { matricula } = req.body;
  if (!matricula || matricula.length < 6) return res.status(400).json({ error: "Matrícula inválida" });
  const hash = await bcrypt.hash("123456", 10);
  const { rowCount } = await pool.query("UPDATE usuarios SET senha_hash=$1 WHERE matricula=$2", [hash, matricula.trim()]);
  rowCount ? res.json({ success: true, message: "Senha resetada para 123456" }) : res.status(404).json({ error: "Usuário não encontrado" });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, req, res, next) => {
  console.error("ERRO GLOBAL:", err);
  res.status(500).json({ error: "Erro interno do servidor" });
});

app.listen(PORT, () => {
  console.log(`API RODANDO NA PORTA ${PORT}`);
});
