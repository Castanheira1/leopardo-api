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
const ExcelJS = require('exceljs');
const { Storage } = require('@google-cloud/storage');

    // Configuração da chave GCP removida. A chave agora é lida diretamente via variáveis de ambiente.

    require("dotenv").config();

    // Configuração segura do Google Cloud Storage
    // Inicializa o cliente do GCS apenas se houver chave e bucket definidos.
    let gcsStorage = null;
    const bucketName = process.env.GCS_BUCKET_NAME;
    if (process.env.GCP_SERVICE_ACCOUNT_KEY && bucketName) {
      try {
        const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
        // Corrige as quebras de linha da chave privada (vêm escapadas no .env)
        if (credentials.private_key) {
          credentials.private_key = credentials.private_key.split("\\n").join("\n");
        }
        gcsStorage = new Storage({ credentials });
        console.log("✅ GCS configurado");
      } catch (err) {
        console.error("❌ Erro ao configurar GCS:", err.message);
      }
    } else {
      console.log("⚠️ GCS não configurado");
    }

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

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
  .then(client => { console.log("✅ Conectado ao PostgreSQL"); client.release(); })
  .catch(err => console.log("Erro ao conectar:", err.message));

    // Google Cloud Storage
    // A inicialização de gcsStorage e bucketName agora acontece após o carregamento do .env.

const uploadToGCS = async (file) => {
  // Retorna null se não houver arquivo ou se o GCS não estiver configurado
  if (!file || !gcsStorage || !bucketName) return null;
  try {
    const gcsFileName = `uploads/${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    const blob = gcsStorage.bucket(bucketName).file(gcsFileName);
    await blob.save(file.buffer, {
      contentType: file.mimetype,
      public: true,
    });
    return `https://storage.googleapis.com/${bucketName}/${gcsFileName}`;
  } catch (err) {
    console.error('Erro upload GCS:', err.message);
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
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
};

const verificarAdmin = (req, res, next) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: "Apenas administradores" });
  next();
};

// Expiração automática de viagens pendentes
setInterval(async () => {
  try {
    await pool.query(`
      UPDATE viagens
      SET status = 'expirado'
      WHERE status = 'pendente'
      AND created_at < NOW() - INTERVAL '30 minutes'
    `);
  } catch (err) {
    console.error("Erro ao expirar viagens:", err);
  }
}, 60000);

// ======================== ROTAS ========================

app.post("/api/register", async (req, res) => {
  const { nome, funcao, matricula, senha } = req.body;
  if (!nome || !matricula || !senha) {
    return res.status(400).json({ error: "Nome, matrícula e senha são obrigatórios" });
  }

  try {
    const check = await pool.query("SELECT id FROM usuarios WHERE matricula = $1", [matricula]);
    if (check.rows.length > 0) {
      return res.status(400).json({ error: "Matrícula já cadastrada" });
    }

    const senha_hash = await bcrypt.hash(senha, 10);
    const is_admin = matricula === "000000";

    const { rows } = await pool.query(
      "INSERT INTO usuarios (nome, matricula, senha_hash, funcao, is_admin) VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, matricula, is_admin",
      [nome, matricula, senha_hash, funcao || null, is_admin]
    );

    const token = jwt.sign({ id: rows[0].id, matricula, is_admin }, JWT_SECRET, { expiresIn: "8h" });
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
    if (rows.length === 0) return res.status(401).json({ error: "Credenciais inválidas" });

    const user = rows[0];
    const valido = await bcrypt.compare(senha, user.senha_hash);
    if (!valido) return res.status(401).json({ error: "Credenciais inválidas" });

    const token = jwt.sign(
      { id: user.id, matricula: user.matricula, is_admin: user.is_admin },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({
      token,
      user: { id: user.id, nome: user.nome, matricula: user.matricula, is_admin: user.is_admin }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// Veículos
app.post("/api/veiculos", verificarAuth, verificarAdmin, upload.single("foto"), async (req, res) => {
  const { modelo, placa } = req.body;
  if (!modelo || !placa) return res.status(400).json({ error: "Modelo e placa são obrigatórios" });

  const fotoUrl = await uploadToGCS(req.file);

  try {
    const { rows } = await pool.query(
      "INSERT INTO veiculos (modelo, placa, foto, ativo) VALUES ($1, $2, $3, true) RETURNING *",
      [modelo, placa.toUpperCase(), fotoUrl]
    );
    res.json(rows[0]);
  } catch (err) {
    // Erro 23505 indica violação de chave única (placa duplicada)
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Placa já cadastrada' });
    }
    console.error('Erro ao cadastrar veículo:', err.message);
    res.status(500).json({ error: err.detail || 'Erro ao cadastrar veículo' });
  }
});

app.get("/api/veiculos", verificarAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT v.*, 
           EXISTS(SELECT 1 FROM viagens WHERE veiculo_id = v.id AND status IN ('pendente', 'em_uso')) as em_uso
    FROM veiculos v 
    ORDER BY v.id DESC
  `);
  res.json(rows);
});

app.patch("/api/veiculos/:id/toggle", verificarAuth, verificarAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      "UPDATE veiculos SET ativo = NOT ativo WHERE id = $1 RETURNING *",
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Veículo não encontrado" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao alterar status" });
  }
});

app.delete("/api/veiculos/:id", verificarAuth, verificarAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows, rowCount } = await pool.query(
      "DELETE FROM veiculos WHERE id = $1 RETURNING foto",
      [id]
    );
    if (rowCount === 0) return res.status(404).json({ error: "Veículo não encontrado" });
    res.json({ success: true, message: "Veículo excluído com sucesso" });
  } catch (err) {
    console.error("Erro ao excluir veículo:", err.message);
    res.status(500).json({ error: "Erro ao excluir veículo" });
  }
});

app.get("/api/viagens/disponiveis", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT v.id, v.modelo, v.placa, v.foto
      FROM veiculos v
      WHERE v.ativo = true
      AND v.id NOT IN (
        SELECT veiculo_id FROM viagens
        WHERE status IN ('pendente', 'em_uso')
      )
      ORDER BY v.modelo
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar veículos" });
  }
});

app.post("/api/viagens", verificarAuth, async (req, res) => {
  const { veiculo_id, justificativa } = req.body;
  if (!veiculo_id || !justificativa) {
    return res.status(400).json({ error: "Veículo e justificativa são obrigatórios" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO viagens (usuario_id, veiculo_id, justificativa, status)
       VALUES ($1, $2, $3, 'pendente') RETURNING *`,
      [req.user.id, veiculo_id, justificativa]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao criar viagem" });
  }
});

app.get("/api/minhas-viagens", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT v.*, ve.modelo, ve.placa,
             EXTRACT(EPOCH FROM (NOW() - v.created_at)) as segundos_desde_criacao
      FROM viagens v
      JOIN veiculos ve ON v.veiculo_id = ve.id
      WHERE v.usuario_id = $1
      ORDER BY v.created_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar viagens" });
  }
});

app.get("/api/admin/viagens/pendentes", verificarAuth, verificarAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT v.*, ve.modelo, ve.placa, u.nome, u.matricula,
             EXTRACT(EPOCH FROM (NOW() - v.created_at))/60 as minutos_passados
      FROM viagens v
      JOIN veiculos ve ON v.veiculo_id = ve.id
      JOIN usuarios u ON v.usuario_id = u.id
      WHERE v.status = 'pendente'
      ORDER BY v.created_at ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar pendentes" });
  }
});

app.get("/api/admin/viagens/em-uso", verificarAuth, verificarAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT v.*, ve.modelo, ve.placa, u.nome, u.matricula,
             v.data_inicio AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo' as data_inicio_br
      FROM viagens v
      JOIN veiculos ve ON v.veiculo_id = ve.id
      JOIN usuarios u ON v.usuario_id = u.id
      WHERE v.status = 'em_uso'
      ORDER BY v.data_inicio ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar em uso" });
  }
});

app.post("/api/admin/viagens/:id/start", verificarAuth, verificarAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE viagens
       SET status = 'em_uso', data_inicio = NOW()
       WHERE id = $1 AND status = 'pendente'
       RETURNING *`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Viagem não encontrada ou já iniciada" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao iniciar viagem" });
  }
});

app.post("/api/admin/viagens/:id/stop", verificarAuth, verificarAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE viagens
       SET status = 'concluido',
           data_fim = NOW(),
           tempo_dias = EXTRACT(DAY FROM (NOW() - data_inicio)),
           tempo_horas = EXTRACT(EPOCH FROM (NOW() - data_inicio))/3600
       WHERE id = $1 AND status = 'em_uso'
       RETURNING *`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Viagem não encontrada ou já finalizada" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao finalizar viagem" });
  }
});

app.get("/api/admin/viagens/export-xlsx", verificarAuth, verificarAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        u.nome, 
        u.matricula, 
        ve.modelo, 
        ve.placa, 
        v.justificativa,
        v.data_inicio AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo' as data_inicio_br,
        v.data_fim AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo' as data_fim_br,
        v.tempo_dias,
        v.tempo_horas
      FROM viagens v
      JOIN usuarios u ON v.usuario_id = u.id
      JOIN veiculos ve ON v.veiculo_id = ve.id
      WHERE v.status = 'concluido'
      ORDER BY v.data_inicio DESC
    `);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Viagens');

    worksheet.columns = [
      { header: 'Nome', key: 'nome', width: 25 },
      { header: 'Matrícula', key: 'matricula', width: 12 },
      { header: 'Veículo', key: 'modelo', width: 20 },
      { header: 'Placa', key: 'placa', width: 12 },
      { header: 'Justificativa', key: 'justificativa', width: 35 },
      { header: 'Data Início', key: 'data_inicio', width: 20 },
      { header: 'Data Fim', key: 'data_fim', width: 20 },
      { header: 'Duração', key: 'duracao', width: 15 }
    ];

    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF003D6D' }
    };
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    rows.forEach((row, idx) => {
      const dataInicio = row.data_inicio_br ? new Date(row.data_inicio_br).toLocaleString('pt-BR') : '—';
      const dataFim = row.data_fim_br ? new Date(row.data_fim_br).toLocaleString('pt-BR') : '—';
      const duracao = row.tempo_horas ? `${row.tempo_dias || 0}d ${Math.round((row.tempo_horas % 24) * 10) / 10}h` : '—';

      worksheet.addRow({
        nome: row.nome,
        matricula: row.matricula,
        modelo: row.modelo,
        placa: row.placa,
        justificativa: row.justificativa,
        data_inicio: dataInicio,
        data_fim: dataFim,
        duracao: duracao
      });

      const currentRow = worksheet.getRow(idx + 2);
      currentRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: idx % 2 === 0 ? 'FFF8FAFC' : 'FFFFFFFF' }
      };
      currentRow.border = {
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } }
      };
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=viagens.xlsx');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao exportar XLSX" });
  }
});

app.get("/api/admin/stats", verificarAuth, verificarAdmin, async (req, res) => {
  try {
    const [v, va, u, vp, vu, vc] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM veiculos"),
      pool.query("SELECT COUNT(*) FROM veiculos WHERE ativo = true"),
      pool.query("SELECT COUNT(*) FROM usuarios"),
      pool.query("SELECT COUNT(*) FROM viagens WHERE status = 'pendente'"),
      pool.query("SELECT COUNT(*) FROM viagens WHERE status = 'em_uso'"),
      pool.query("SELECT COUNT(*) FROM viagens WHERE status = 'concluido'")
    ]);

    res.json({
      totalVeiculos: +v.rows[0].count,
      veiculosAtivos: +va.rows[0].count,
      totalUsuarios: +u.rows[0].count,
      viagensPendentes: +vp.rows[0].count,
      viagensEmUso: +vu.rows[0].count,
      viagensConcluidas: +vc.rows[0].count
    });
  } catch (err) {
    console.error("Erro stats:", err);
    res.status(500).json({ error: "Erro ao carregar estatísticas" });
  }
});

// NOVA ROTA: ADMIN RESETAR SENHA POR MATRÍCULA
app.post("/api/admin/reset-senha", verificarAuth, verificarAdmin, async (req, res) => {
  const { matricula } = req.body;
  if (!matricula || matricula.length < 6) {
    return res.status(400).json({ error: 'Matrícula inválida' });
  }

  try {
    const novaSenha = '123456'; // senha padrão
    const senha_hash = await bcrypt.hash(novaSenha, 10);

    const { rowCount } = await pool.query(
      'UPDATE usuarios SET senha_hash = $1 WHERE matricula = $2',
      [senha_hash, matricula.trim()]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    res.json({ 
      success: true, 
      message: `Senha do usuário ${matricula} resetada para: ${novaSenha}` 
    });
  } catch (err) {
    console.error('Erro ao resetar senha:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Servir front-end
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// Tratamento global de erros
app.use((err, req, res, next) => {
  console.error("ERRO GLOBAL:", err.message);
  res.status(500).json({ error: "Erro interno no servidor" });
});

app.listen(PORT, () => {
  console.log(`🚀 API rodando em http://localhost:${PORT}`);
});
