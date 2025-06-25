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

// GET /api/mensagens-motivacionais - Listar últimas 10 ativas (com nome do autor)
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.id, m.mensagem, m.data_postagem, m.usuario_id, u.nome as usuario_nome
       FROM mensagens_motivacionais m
       LEFT JOIN usuarios u ON m.usuario_id = u.id
       WHERE m.ativo = TRUE
       ORDER BY m.data_postagem DESC
       LIMIT 10`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar mensagens motivacionais:', err.message);
    res.status(500).json({ success: false, message: 'Erro do servidor ao buscar mensagens.' });
  }
});

// POST /api/mensagens-motivacionais - Adicionar nova mensagem
router.post('/', auth, async (req, res) => {
  const { mensagem } = req.body;
  const usuario_id = req.user.userId; // Ou req.user.id, dependendo de como está no seu token JWT

  if (!mensagem || typeof mensagem !== 'string' || mensagem.trim() === '') {
    return res.status(400).json({ success: false, message: 'Conteúdo da mensagem é obrigatório.' });
  }
  if (mensagem.length > 500) { // Exemplo de limite de caracteres
      return res.status(400).json({ success: false, message: 'Mensagem excede o limite de 500 caracteres.' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO mensagens_motivacionais (mensagem, usuario_id) VALUES ($1, $2) RETURNING *',
      [mensagem.trim(), usuario_id]
    );
    // Para retornar com o nome do usuário, podemos fazer uma segunda query ou ajustar o RETURNING se possível com join (mais complexo no insert)
    const newMessage = result.rows[0];
    const userResult = await pool.query('SELECT nome FROM usuarios WHERE id = $1', [newMessage.usuario_id]);
    const usuario_nome = userResult.rows.length > 0 ? userResult.rows[0].nome : null;

    res.status(201).json({ ...newMessage, usuario_nome });
  } catch (err) {
    console.error('Erro ao criar mensagem motivacional:', err.message);
    res.status(500).json({ success: false, message: 'Erro do servidor ao criar mensagem.' });
  }
});

// PUT /api/mensagens-motivacionais/:id/inativar - Marcar mensagem como inativa (Gerente/Dev)
router.put('/:id/inativar', auth, checkAdminPermission, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'UPDATE mensagens_motivacionais SET ativo = FALSE WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Mensagem não encontrada.' });
    }
    res.json({ success: true, message: 'Mensagem inativada com sucesso.' });
  } catch (err) {
    console.error('Erro ao inativar mensagem:', err.message);
    res.status(500).json({ success: false, message: 'Erro do servidor ao inativar mensagem.' });
  }
});

// GET /api/mensagens-motivacionais/stats - Obter contagem de mensagens no mês atual
router.get('/stats', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) as "totalMensagensMes" -- Aspas duplas aqui
       FROM mensagens_motivacionais
       WHERE ativo = TRUE AND date_trunc('month', data_postagem) = date_trunc('month', current_date)`
    );
    if (result.rows.length > 0) {
        // O COUNT(*) sempre retorna uma linha, mesmo que a contagem seja 0.
        // O valor da contagem será uma string, converter para número é uma boa prática.
        res.json({ totalMensagensMes: parseInt(result.rows[0].totalMensagensMes, 10) });
    } else {
        // Isso não deveria acontecer com COUNT(*), mas por segurança:
        res.json({ totalMensagensMes: 0 });
    }
  } catch (err) {
    console.error('Erro ao buscar estatísticas de mensagens:', err.message);
    res.status(500).json({ success: false, message: 'Erro do servidor ao buscar estatísticas.' });
  }
});

module.exports = router;