const express = require('express');
const router = express.Router();
const pool = require('../database');
const auth = require('../middleware/auth');

// Middleware para verificar permissão de Gerente ou Dev
const checkAdminPermission = (req, res, next) => {
  if (req.user && (req.user.permissao === 'Gerente' || req.user.permissao === 'Dev')) {
    next();
  } else {
    return res.status(403).json({ success: false, message: 'Acesso não autorizado. Permissão de Gerente ou Dev necessária.' });
  }
};

// GET /api/ranking-mapia?mes=YYYY-MM - Listar top 10 do mês
router.get('/', auth, async (req, res) => {
  const { mes } = req.query; // Formato YYYY-MM

  if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
    return res.status(400).json({ success: false, message: 'Parâmetro "mes" (YYYY-MM) é obrigatório e deve estar no formato correto.' });
  }

  const primeiroDiaDoMes = `${mes}-01`;

  try {
    const result = await pool.query(
      `SELECT r.id, r.nome_usuario_mapia, r.setor, r.tempo_mapia, r.medalha, 
              r.mes_ano_referencia, r.data_criacao, r.data_atualizacao,
              r.criado_por_usuario_id, u.nome as criado_por_usuario_nome
       FROM ranking_mapia r
       LEFT JOIN usuarios u ON r.criado_por_usuario_id = u.id
       WHERE date_trunc('month', r.mes_ano_referencia) = date_trunc('month', $1::date)
       ORDER BY r.tempo_mapia DESC -- Ajuste a ordenação conforme necessário (ex: converter tempo_mapia para um valor numérico se possível)
       LIMIT 10`,
      [primeiroDiaDoMes]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar ranking Mapia:', err.message);
    res.status(500).json({ success: false, message: 'Erro do servidor ao buscar ranking.' });
  }
});

// POST /api/ranking-mapia - Adicionar nova entrada no ranking (Gerente/Dev)
router.post('/', auth, checkAdminPermission, async (req, res) => {
  const { nome_usuario_mapia, setor, tempo_mapia, medalha, mes_ano_referencia } = req.body;
  const criado_por_usuario_id = req.user.userId; // Ou req.user.id

  if (!nome_usuario_mapia || !tempo_mapia || !mes_ano_referencia) {
    return res.status(400).json({ success: false, message: 'Campos nome_usuario_mapia, tempo_mapia e mes_ano_referencia são obrigatórios.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mes_ano_referencia)) {
      return res.status(400).json({ success: false, message: 'mes_ano_referencia deve estar no formato YYYY-MM-DD.'});
  }

  try {
    const result = await pool.query(
      `INSERT INTO ranking_mapia (nome_usuario_mapia, setor, tempo_mapia, medalha, mes_ano_referencia, criado_por_usuario_id, data_atualizacao)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       RETURNING *`,
      [nome_usuario_mapia, setor, tempo_mapia, medalha, mes_ano_referencia, criado_por_usuario_id]
    );
    
    const newEntry = result.rows[0];
    const adminUser = await pool.query('SELECT nome FROM usuarios WHERE id = $1', [criado_por_usuario_id]);
    const criado_por_usuario_nome = adminUser.rows.length > 0 ? adminUser.rows[0].nome : null;

    res.status(201).json({ ...newEntry, criado_por_usuario_nome });
  } catch (err) {
    console.error('Erro ao criar entrada no ranking Mapia:', err.message);
    if (err.code === '23503') { // Foreign key violation
        return res.status(400).json({ success: false, message: 'ID do usuário criador inválido.' });
    }
    res.status(500).json({ success: false, message: 'Erro do servidor ao criar entrada no ranking.' });
  }
});

// PUT /api/ranking-mapia/:id - Editar entrada existente no ranking (Gerente/Dev)
router.put('/:id', auth, checkAdminPermission, async (req, res) => {
  const { id } = req.params;
  const { nome_usuario_mapia, setor, tempo_mapia, medalha, mes_ano_referencia } = req.body;
  const editor_usuario_id = req.user.userId; // Quem está editando

  if (!nome_usuario_mapia && !setor && !tempo_mapia && !medalha && !mes_ano_referencia) {
    return res.status(400).json({ success: false, message: 'Nenhum dado fornecido para atualização.' });
  }
  if (mes_ano_referencia && !/^\d{4}-\d{2}-\d{2}$/.test(mes_ano_referencia)) {
      return res.status(400).json({ success: false, message: 'mes_ano_referencia deve estar no formato YYYY-MM-DD, se fornecido.'});
  }

  // Constrói a query de atualização dinamicamente
  const fieldsToUpdate = [];
  const values = [];
  let queryIndex = 1;

  if (nome_usuario_mapia !== undefined) {
    fieldsToUpdate.push(`nome_usuario_mapia = $${queryIndex++}`);
    values.push(nome_usuario_mapia);
  }
  if (setor !== undefined) {
    fieldsToUpdate.push(`setor = $${queryIndex++}`);
    values.push(setor);
  }
  if (tempo_mapia !== undefined) {
    fieldsToUpdate.push(`tempo_mapia = $${queryIndex++}`);
    values.push(tempo_mapia);
  }
  if (medalha !== undefined) {
    fieldsToUpdate.push(`medalha = $${queryIndex++}`);
    values.push(medalha);
  }
  if (mes_ano_referencia !== undefined) {
    fieldsToUpdate.push(`mes_ano_referencia = $${queryIndex++}`);
    values.push(mes_ano_referencia);
  }

  fieldsToUpdate.push(`data_atualizacao = CURRENT_TIMESTAMP`);
  fieldsToUpdate.push(`criado_por_usuario_id = $${queryIndex++}`); // Atualiza quem foi o último editor
  values.push(editor_usuario_id);

  values.push(id); // Para a cláusula WHERE id = $N

  try {
    const queryString = `UPDATE ranking_mapia SET ${fieldsToUpdate.join(', ')} WHERE id = $${queryIndex} RETURNING *`;
    const result = await pool.query(queryString, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Entrada do ranking não encontrada.' });
    }

    const updatedEntry = result.rows[0];
    const adminUser = await pool.query('SELECT nome FROM usuarios WHERE id = $1', [editor_usuario_id]);
    const criado_por_usuario_nome = adminUser.rows.length > 0 ? adminUser.rows[0].nome : null;
    
    res.json({ ...updatedEntry, criado_por_usuario_nome });
  } catch (err) {
    console.error('Erro ao atualizar entrada no ranking Mapia:', err.message);
    res.status(500).json({ success: false, message: 'Erro do servidor ao atualizar entrada no ranking.' });
  }
});

// DELETE /api/ranking-mapia/:id - Remover entrada do ranking (Gerente/Dev)
router.delete('/:id', auth, checkAdminPermission, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM ranking_mapia WHERE id = $1 RETURNING id', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Entrada do ranking não encontrada.' });
    }
    res.json({ success: true, message: 'Entrada do ranking excluída com sucesso.' });
  } catch (err) {
    console.error('Erro ao excluir entrada do ranking Mapia:', err.message);
    res.status(500).json({ success: false, message: 'Erro do servidor ao excluir entrada do ranking.' });
  }
});

module.exports = router;