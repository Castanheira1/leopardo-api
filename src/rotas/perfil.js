// Perfil, aceite da política (LGPD), locais favoritos e exclusão de conta.
require("dotenv").config();
const bcrypt = require("bcrypt");
const app = require("../app");
const { pool } = require("../db");
const { verificarAuth } = require("../auth");
const { buscarUsuarioFront, invalidarProjetoCache, resolverProjetoId } = require("../usuarios");
const { apagarFotoStorage } = require("../storage");

app.get("/api/perfil", verificarAuth, async (req, res) => {
  try {
    const userFront = await buscarUsuarioFront(req.user.id);
    if (!userFront) return res.status(404).json({ error: "Usuário não encontrado" });
    res.json(userFront);
  } catch (err) {
    res.status(500).json({ error: "Erro ao carregar perfil" });
  }
});

// LGPD: aceite da Política por usuário JÁ logado (portão de consentimento para
// quem se cadastrou antes desta versão). Só grava se ainda não havia aceite, para
// preservar o carimbo original de quem já consentiu.
app.post("/api/perfil/aceitar-politica", verificarAuth, async (req, res) => {
  const versao = String(req.body?.politica_versao || "1.0").slice(0, 20);
  try {
    await pool.query(
      `UPDATE usuarios
         SET politica_aceita_em = COALESCE(politica_aceita_em, NOW()),
             politica_versao = COALESCE(politica_versao, $1)
       WHERE id = $2`,
      [versao, req.user.id]
    );
    const userFront = await buscarUsuarioFront(req.user.id);
    res.json(userFront);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao registrar o aceite" });
  }
});

app.patch("/api/perfil", verificarAuth, async (req, res) => {
  const { telefone, nome, funcao, sexo, empresa_nome, centro_custo, projeto_codigo, projeto_id, email } = req.body;
  const sexoNorm = sexo === "M" || sexo === "F" ? sexo : null;
  try {
    const atual = await buscarUsuarioFront(req.user.id);
    if (!atual) return res.status(404).json({ error: "Usuário não encontrado" });

    let pid = null;
    if (projeto_codigo || projeto_id) {
      pid = await resolverProjetoId(projeto_id, projeto_codigo);
      if (!pid) return res.status(400).json({ error: "Selecione um projeto válido" });
    }

    let emailNovo = null;
    if (email != null && String(email).trim()) {
      if (atual.email) {
        return res.status(400).json({ error: "O email não pode ser alterado pelo perfil. Use recuperação de senha no login." });
      }
      emailNovo = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNovo)) {
        return res.status(400).json({ error: "Email inválido" });
      }
      const dup = await pool.query(
        "SELECT 1 FROM usuarios WHERE email = $1 AND id <> $2",
        [emailNovo, req.user.id]
      );
      if (dup.rows.length) return res.status(409).json({ error: "Este email já está em uso" });
    }

    await pool.query(
      `UPDATE usuarios SET
         telefone = COALESCE($1, telefone),
         nome = COALESCE($2, nome),
         funcao = COALESCE($3, funcao),
         sexo = COALESCE($4, sexo),
         empresa_nome = COALESCE($5, empresa_nome),
         centro_custo = COALESCE($6, centro_custo),
         projeto_id = COALESCE($7, projeto_id),
         email = COALESCE($8, email)
       WHERE id = $9`,
      [
        telefone || null, nome || null, funcao || null, sexoNorm,
        empresa_nome || null, centro_custo ?? null, pid, emailNovo, req.user.id,
      ]
    );
    invalidarProjetoCache(req.user.id);
    const userFront = await buscarUsuarioFront(req.user.id);
    res.json(userFront);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao atualizar perfil" });
  }
});

function normalizarFavoritoItem(item) {
  const nome = String(item?.nome || "").trim().slice(0, 200);
  const busca = String(item?.busca || nome).trim().slice(0, 300);
  if (!nome || !busca) return null;
  const ref = item?.ref;
  let ref_lat = null;
  let ref_lng = null;
  if (ref && Number.isFinite(Number(ref.lat)) && Number.isFinite(Number(ref.lng))) {
    ref_lat = Number(ref.lat);
    ref_lng = Number(ref.lng);
  }
  const grupo = String(item?.grupo || "").trim().slice(0, 100) || null;
  return { nome, busca, ref_lat, ref_lng, grupo };
}

app.get("/api/perfil/favoritos", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT nome, busca, ref_lat, ref_lng, grupo, ordem
       FROM usuarios_favoritos WHERE usuario_id = $1 ORDER BY ordem ASC, nome ASC`,
      [req.user.id]
    );
    res.json(rows.map((r) => ({
      nome: r.nome,
      busca: r.busca,
      grupo: r.grupo || undefined,
      ref: r.ref_lat != null && r.ref_lng != null ? { lat: Number(r.ref_lat), lng: Number(r.ref_lng) } : undefined,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao carregar favoritos" });
  }
});

app.put("/api/perfil/favoritos", verificarAuth, async (req, res) => {
  const lista = Array.isArray(req.body?.favoritos) ? req.body.favoritos : null;
  if (!lista) return res.status(400).json({ error: "Lista de favoritos inválida" });
  if (lista.length > 40) return res.status(400).json({ error: "Máximo de 40 favoritos" });
  const normalizados = [];
  const vistos = new Set();
  for (const item of lista) {
    const f = normalizarFavoritoItem(item);
    if (!f || vistos.has(f.nome)) continue;
    vistos.add(f.nome);
    normalizados.push(f);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM usuarios_favoritos WHERE usuario_id = $1", [req.user.id]);
    for (let i = 0; i < normalizados.length; i++) {
      const f = normalizados[i];
      await client.query(
        `INSERT INTO usuarios_favoritos (usuario_id, nome, busca, ref_lat, ref_lng, grupo, ordem)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.user.id, f.nome, f.busca, f.ref_lat, f.ref_lng, f.grupo, i]
      );
    }
    await client.query("COMMIT");
    res.json(normalizados.map((f) => ({
      nome: f.nome,
      busca: f.busca,
      grupo: f.grupo || undefined,
      ref: f.ref_lat != null ? { lat: f.ref_lat, lng: f.ref_lng } : undefined,
    })));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Erro ao salvar favoritos" });
  } finally {
    client.release();
  }
});

// LGPD + lojas (Google/Apple): exclusão de conta pelo próprio usuário.
// Apaga o registro em `usuarios` (CASCADE nas tabelas filhas). Exige a senha
// para evitar exclusão acidental. Não bloqueia a matrícula — o colaborador
// pode se cadastrar de novo se quiser.
app.delete("/api/perfil", verificarAuth, async (req, res) => {
  const senha = String(req.body?.senha || "");
  if (!senha) {
    return res.status(400).json({ error: "Informe sua senha para confirmar a exclusão da conta." });
  }

  const uid = req.user.id;
  try {
    const { rows } = await pool.query(
      "SELECT id, senha_hash, is_admin, matricula FROM usuarios WHERE id = $1",
      [uid]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

    // Conta bootstrap do sistema: não permite autoexclusão (quebraria o painel).
    if (user.matricula === "000000") {
      return res.status(400).json({
        error: "A conta administradora padrão não pode ser excluída por este caminho.",
      });
    }

    // 403 (não 401): a sessão continua válida; só a confirmação da exclusão falhou.
    // O cliente usa fetchWithAuth, que faz logout em qualquer 401.
    const ok = await bcrypt.compare(senha, user.senha_hash);
    if (!ok) return res.status(403).json({ error: "Senha incorreta." });

    const viagemAtiva = await pool.query(
      `SELECT id FROM viagens
       WHERE status = 'em_andamento' AND (motorista_id = $1 OR passageiro_id = $1)
       LIMIT 1`,
      [uid]
    );
    if (viagemAtiva.rows.length) {
      return res.status(409).json({
        error: "Finalize ou cancele a viagem em andamento antes de excluir a conta.",
      });
    }

    // URLs de foto para limpar no Storage depois do DELETE (best-effort).
    const fotos = await pool.query(
      `SELECT selfie_url AS url FROM habilitacoes_motorista WHERE motorista_id = $1 AND selfie_url IS NOT NULL
       UNION ALL
       SELECT foto_carro_url FROM habilitacoes_motorista WHERE motorista_id = $1 AND foto_carro_url IS NOT NULL
       UNION ALL
       SELECT selfie_url FROM pedidos WHERE passageiro_id = $1 AND selfie_url IS NOT NULL
       UNION ALL
       SELECT selfie_url FROM propostas WHERE de_usuario_id = $1 AND selfie_url IS NOT NULL
       UNION ALL
       SELECT selfie_url FROM contatos_motorista
         WHERE (motorista_id = $1 OR passageiro_id = $1) AND selfie_url IS NOT NULL`,
      [uid]
    );
    const urlsFotos = [...new Set(fotos.rows.map((r) => r.url).filter(Boolean))];

    // Encerra ofertas/pedidos abertos antes do CASCADE (estado limpo p/ o outro lado).
    await pool.query(
      "UPDATE caronas SET status = 'cancelada' WHERE motorista_id = $1 AND status = 'ativa'",
      [uid]
    );
    await pool.query(
      "UPDATE pedidos SET status = 'cancelado' WHERE passageiro_id = $1 AND status = 'aberto'",
      [uid]
    );
    await pool.query(
      `UPDATE propostas SET status = 'recusado'
       WHERE status = 'pendente' AND (de_usuario_id = $1 OR para_usuario_id = $1)`,
      [uid]
    );

    await pool.query("DELETE FROM usuarios WHERE id = $1", [uid]);
    invalidarProjetoCache(uid);

    // Storage fora da transação: falha de rede não deve reverter a exclusão.
    for (const url of urlsFotos) {
      await apagarFotoStorage(url).catch(() => {});
    }

    res.json({
      success: true,
      message: "Conta excluída. Seus dados pessoais foram removidos.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao excluir a conta" });
  }
});


module.exports = {
  normalizarFavoritoItem,
};
