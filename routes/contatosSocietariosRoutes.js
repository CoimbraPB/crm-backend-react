const express = require('express');
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');

const router = express.Router();

// GET todos os contatos societários (protegido)
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cs.*, c.nome as cliente_nome, c.codigo as cliente_codigo 
      FROM contatos_societarios cs
      JOIN clientes c ON cs.cliente_id = c.id
      ORDER BY c.nome, cs.nome
    `);
    res.json({ success: true, contatos: result.rows });
  } catch (error) {
    console.error('Erro ao buscar contatos societários:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor', error: error.message });
  }
});

// GET contatos societários por cliente_id (protegido)
router.get('/cliente/:cliente_id', auth, async (req, res) => {
  try {
    const { cliente_id } = req.params;
    const result = await pool.query(
      'SELECT cs.*, c.nome as cliente_nome, c.codigo as cliente_codigo FROM contatos_societarios cs JOIN clientes c ON cs.cliente_id = c.id WHERE cs.cliente_id = $1 ORDER BY cs.nome',
      [cliente_id]
    );
    if (result.rows.length === 0) {
      // Retorna sucesso com array vazio se não houver contatos para o cliente,
      // o que é um cenário válido, não necessariamente um erro 404 para a rota em si.
      return res.json({ success: true, contatos: [] });
    }
    res.json({ success: true, contatos: result.rows });
  } catch (error) {
    console.error('Erro ao buscar contatos societários por cliente:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor', error: error.message });
  }
});

// POST criar novo contato societário (protegido)
router.post('/', auth, async (req, res) => {
  try {
    const { cliente_id, nome, email, cpf, data_nascimento, cargo } = req.body;

    if (!cliente_id || !nome || !email || !cpf || !data_nascimento || !cargo) {
      return res.status(400).json({ success: false, message: 'Todos os campos são obrigatórios.' });
    }
    
    // TODO: Adicionar validação mais robusta para CPF, email e data

    const result = await pool.query(
      'INSERT INTO contatos_societarios (cliente_id, nome, email, cpf, data_nascimento, cargo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [cliente_id, nome, email, cpf, data_nascimento, cargo]
    );
    const novoContato = result.rows[0];

    // Log de auditoria
    await logAction(
      req.user.userId, 
      req.user.email,
      ACTION_TYPES.CONTATO_SOCIETARIO_CREATED, // Correção
      ENTITY_TYPES.CONTATO_SOCIETARIO,      // Correção
      novoContato.id,
      { cliente_id, nome, email } 
    );

    res.status(201).json({ success: true, message: 'Contato societário criado com sucesso!', contato: novoContato });
  } catch (error) {
    console.error('Erro ao criar contato societário:', error);
    // Verificar erro de chave única para CPF, por exemplo
    if (error.code === '23505') { // Código de erro do PostgreSQL para unique_violation
        if (error.constraint && error.constraint.includes('cpf')) {
             return res.status(409).json({ success: false, message: 'CPF já cadastrado para outro contato.', error: error.message });
        }
         if (error.constraint && error.constraint.includes('email')) { // Supondo que email também possa ser único por cliente
             return res.status(409).json({ success: false, message: 'E-mail já cadastrado para outro contato neste cliente.', error: error.message });
        }
    }
    res.status(500).json({ success: false, message: 'Erro interno do servidor', error: error.message });
  }
});

// PUT atualizar contato societário (protegido)
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, email, cpf, data_nascimento, cargo } = req.body; // cliente_id não é atualizável por aqui

    if (!nome || !email || !cpf || !data_nascimento || !cargo) {
      return res.status(400).json({ success: false, message: 'Todos os campos são obrigatórios para atualização.' });
    }

    // TODO: Adicionar validação mais robusta

    const result = await pool.query(
      'UPDATE contatos_societarios SET nome = $1, email = $2, cpf = $3, data_nascimento = $4, cargo = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6 RETURNING *',
      [nome, email, cpf, data_nascimento, cargo, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Contato societário não encontrado.' });
    }
    const contatoAtualizado = result.rows[0];

    // Log de auditoria
    await logAction(
      req.user.userId,
      req.user.email,
      ACTION_TYPES.CONTATO_SOCIETARIO_UPDATED, // Correção
      ENTITY_TYPES.CONTATO_SOCIETARIO,       // Correção
      contatoAtualizado.id,
      { nome, email } 
    );

    res.json({ success: true, message: 'Contato societário atualizado com sucesso!', contato: contatoAtualizado });
  } catch (error) {
    console.error('Erro ao atualizar contato societário:', error);
     if (error.code === '23505') { 
        if (error.constraint && error.constraint.includes('cpf')) {
             return res.status(409).json({ success: false, message: 'CPF já cadastrado para outro contato.', error: error.message });
        }
         if (error.constraint && error.constraint.includes('email')) {
             return res.status(409).json({ success: false, message: 'E-mail já cadastrado para outro contato neste cliente.', error: error.message });
        }
    }
    res.status(500).json({ success: false, message: 'Erro interno do servidor', error: error.message });
  }
});

// DELETE contato societário (protegido)
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query('DELETE FROM contatos_societarios WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Contato societário não encontrado.' });
    }
    const contatoExcluido = result.rows[0];

    // Log de auditoria
    await logAction(
      req.user.userId,
      req.user.email,
      ACTION_TYPES.CONTATO_SOCIETARIO_DELETED, // Correção
      ENTITY_TYPES.CONTATO_SOCIETARIO,       // Correção
      id, 
      { nome: contatoExcluido.nome, email: contatoExcluido.email } 
    );

    res.json({ success: true, message: 'Contato societário excluído com sucesso!' });
  } catch (error) {
    console.error('Erro ao excluir contato societário:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor', error: error.message });
  }
});



module.exports = router;
