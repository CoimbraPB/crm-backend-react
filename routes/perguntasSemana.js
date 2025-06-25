const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');

// Middleware para verificar permissão de Gerente ou Dev
const checkAdminPermission = (req, res, next) => {
  if (req.user && (req.user.permissao === 'Gerente' || req.user.permissao === 'Dev')) {
    next();
  } else {
    return res.status(403).json({ success: false, message: 'Acesso não autorizado. Permissão de Gerente ou Dev necessária.' });
  }
};

// GET /api/perguntas-semana/ativa - Obter a pergunta ativa
router.get('/ativa', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.pergunta_texto, p.ativa, p.data_criacao, 
              p.criado_por_usuario_id, u.nome as criado_por_usuario_nome
       FROM perguntas_semana p
       LEFT JOIN usuarios u ON p.criado_por_usuario_id = u.id
       WHERE p.ativa = TRUE 
       ORDER BY p.data_criacao DESC 
       LIMIT 1`
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Nenhuma pergunta ativa encontrada.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao buscar pergunta ativa:', err.message);
    res.status(500).json({ success: false, message: 'Erro do servidor ao buscar pergunta.' });
  }
});

// POST /api/perguntas-semana/:id/responder - Registrar resposta de um usuário
router.post('/:id/responder', auth, async (req, res) => {
  const { id: pergunta_id } = req.params;
  const { resposta } = req.body;
  const usuario_id = req.user.userId; // Ou req.user.id

  if (!resposta || typeof resposta !== 'string' || resposta.trim() === '') {
    return res.status(400).json({ success: false, message: 'Resposta é obrigatória.' });
  }
  if (resposta.length > 50) { // Limite para emojis ou respostas curtas
      return res.status(400).json({ success: false, message: 'Resposta excede o limite de 50 caracteres.' });
  }

  try {
    // Verificar se a pergunta existe e está ativa
    const perguntaResult = await pool.query('SELECT ativa FROM perguntas_semana WHERE id = $1', [pergunta_id]);
    if (perguntaResult.rowCount === 0) {
        return res.status(404).json({ success: false, message: 'Pergunta não encontrada.' });
    }
    if (!perguntaResult.rows[0].ativa) {
        return res.status(400).json({ success: false, message: 'Esta pergunta não está mais ativa para respostas.' });
    }

    const result = await pool.query(
      'INSERT INTO respostas_pergunta_semana (pergunta_id, usuario_id, resposta) VALUES ($1, $2, $3) RETURNING *',
      [pergunta_id, usuario_id, resposta.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') { // unique_violation (uq_resposta_pergunta_usuario)
      return res.status(409).json({ success: false, message: 'Você já respondeu a esta pergunta.' });
    }
    if (err.code === '23503') { // foreign key violation
        if (err.constraint && err.constraint.includes('respostas_pergunta_semana_pergunta_id_fkey')) {
            return res.status(404).json({ success: false, message: 'Pergunta não encontrada para associar a resposta.' });
        }
         if (err.constraint && err.constraint.includes('respostas_pergunta_semana_usuario_id_fkey')) {
            return res.status(400).json({ success: false, message: 'ID do usuário inválido.' });
        }
    }
    console.error('Erro ao registrar resposta:', err.message);
    res.status(500).json({ success: false, message: 'Erro do servidor ao registrar resposta.' });
  }
});

// GET /api/perguntas-semana/:id/respostas/historico - Obter histórico de respostas (Gerente/Dev)
router.get('/:id/respostas/historico', auth, checkAdminPermission, async (req, res) => {
  const { id: pergunta_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT r.id, r.pergunta_id, r.resposta, r.data_resposta,
              r.usuario_id, u.nome as usuario_nome, u.email as usuario_email
       FROM respostas_pergunta_semana r
       JOIN usuarios u ON r.usuario_id = u.id
       WHERE r.pergunta_id = $1
       ORDER BY r.data_resposta DESC`,
      [pergunta_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar histórico de respostas:', err.message);
    res.status(500).json({ success: false, message: 'Erro do servidor ao buscar histórico.' });
  }
});

// --- Rotas de Gerenciamento de Perguntas (Admin) ---

// GET /api/perguntas-semana - Listar todas as perguntas para gerenciamento (Gerente/Dev)
router.get('/', auth, checkAdminPermission, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT p.id, p.pergunta_texto, p.ativa, p.data_criacao, 
                p.criado_por_usuario_id, u.nome as criado_por_usuario_nome
         FROM perguntas_semana p
         LEFT JOIN usuarios u ON p.criado_por_usuario_id = u.id
         ORDER BY p.data_criacao DESC`
      );
      res.json(result.rows);
    } catch (err) {
      console.error('Erro ao buscar todas as perguntas:', err.message);
      res.status(500).json({ success: false, message: 'Erro do servidor ao buscar perguntas.' });
    }
});


// POST /api/perguntas-semana - Criar nova pergunta (Gerente/Dev)
router.post('/', auth, checkAdminPermission, async (req, res) => {
  const { pergunta_texto } = req.body;
  const criado_por_usuario_id = req.user.userId; // Ou req.user.id

  if (!pergunta_texto || typeof pergunta_texto !== 'string' || pergunta_texto.trim() === '') {
    return res.status(400).json({ success: false, message: 'Texto da pergunta é obrigatório.' });
  }

  try {
    // Se uma nova pergunta for criada e marcada como ativa, desativar outras perguntas ativas
    // (O plano original mencionava "idealmente garante que apenas uma seja ativa" no PUT /alternar-status, 
    //  mas é bom considerar ao criar também se a nova for 'ativa' por padrão)
    // Para esta implementação, vamos assumir que a lógica de UMA ativa é gerenciada pelo PUT /alternar-status
    // ou que o frontend pode enviar 'ativa: true' e o backend desativaria as outras.
    // Por simplicidade, a nova pergunta será criada como 'ativa = true' por padrão na tabela.
    // Se quiser garantir uma única ativa, adicione aqui uma query para setar `ativa = false` em outras.

    const result = await pool.query(
      'INSERT INTO perguntas_semana (pergunta_texto, criado_por_usuario_id) VALUES ($1, $2) RETURNING *',
      [pergunta_texto.trim(), criado_por_usuario_id]
    );
    
    const newQuestion = result.rows[0];
    const adminUser = await pool.query('SELECT nome FROM usuarios WHERE id = $1', [criado_por_usuario_id]);
    const criado_por_usuario_nome = adminUser.rows.length > 0 ? adminUser.rows[0].nome : null;

    res.status(201).json({ ...newQuestion, criado_por_usuario_nome });
  } catch (err) {
    console.error('Erro ao criar pergunta:', err.message);
    res.status(500).json({ success: false, message: 'Erro do servidor ao criar pergunta.' });
  }
});

// PUT /api/perguntas-semana/:id - Editar texto da pergunta (Gerente/Dev)
router.put('/:id', auth, checkAdminPermission, async (req, res) => {
  const { id } = req.params;
  const { pergunta_texto } = req.body; // Apenas o texto pode ser editado aqui

  if (!pergunta_texto || typeof pergunta_texto !== 'string' || pergunta_texto.trim() === '') {
    return res.status(400).json({ success: false, message: 'Texto da pergunta é obrigatório para edição.' });
  }

  try {
    const result = await pool.query(
      'UPDATE perguntas_semana SET pergunta_texto = $1 WHERE id = $2 RETURNING *',
      [pergunta_texto.trim(), id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Pergunta não encontrada.' });
    }
    
    const updatedQuestion = result.rows[0];
    // Se precisar do nome do criador original, pode buscar ou já ter na pergunta.
    // Para simplificar, retornamos a pergunta atualizada.
    const adminUser = await pool.query('SELECT nome FROM usuarios WHERE id = $1', [updatedQuestion.criado_por_usuario_id]);
    const criado_por_usuario_nome = adminUser.rows.length > 0 ? adminUser.rows[0].nome : null;

    res.json({ ...updatedQuestion, criado_por_usuario_nome });
  } catch (err) {
    console.error('Erro ao editar pergunta:', err.message);
    res.status(500).json({ success: false, message: 'Erro do servidor ao editar pergunta.' });
  }
});

// PUT /api/perguntas-semana/:id/alternar-status - Ativar/Desativar pergunta (Gerente/Dev)
// Esta rota irá ativar a pergunta :id e desativar todas as outras.
router.put('/:id/alternar-status', auth, checkAdminPermission, async (req, res) => {
  const { id: perguntaIdParaAtivar } = req.params;
  const client = await pool.connect(); // Usar transação

  try {
    await client.query('BEGIN');

    // Desativar todas as outras perguntas
    await client.query('UPDATE perguntas_semana SET ativa = FALSE WHERE id != $1', [perguntaIdParaAtivar]);

    // Ativar a pergunta especificada (ou alternar seu estado se já for a única)
    // Para garantir que ela fique ativa:
    const result = await client.query(
        'UPDATE perguntas_semana SET ativa = TRUE WHERE id = $1 RETURNING *', 
        [perguntaIdParaAtivar]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Pergunta não encontrada.' });
    }
    
    await client.query('COMMIT');

    const updatedQuestion = result.rows[0];
    const adminUser = await pool.query('SELECT nome FROM usuarios WHERE id = $1', [updatedQuestion.criado_por_usuario_id]);
    const criado_por_usuario_nome = adminUser.rows.length > 0 ? adminUser.rows[0].nome : null;

    res.json({ ...updatedQuestion, criado_por_usuario_nome });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao alternar status da pergunta:', err.message);
    res.status(500).json({ success: false, message: 'Erro do servidor ao alternar status.' });
  } finally {
    client.release();
  }
});

module.exports = router;