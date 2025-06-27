const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');

// Middleware para verificar permissões específicas
const checkPermission = (allowedRoles) => {
  return (req, res, next) => {
    const userPermission = req.user.permissao;
    if (allowedRoles.includes(userPermission)) {
      next();
    } else {
      logAction(req.user.userId, req.user.email, 'SETOR_ACCESS_DENIED', 'Setor', null, { route: req.path, attemptedPermission: userPermission });
      return res.status(403).json({ success: false, message: 'Acesso negado. Permissão insuficiente.' });
    }
  };
};

const PERMISSOES_GERENCIAIS = ['Gerente', 'Dev'];
const PERMISSOES_VISUALIZACAO = ['Gerente', 'Dev', 'Gestor', 'Fiscal', 'Operador'];

// ROTA: Listar todos os setores ativos
router.get('/', auth, checkPermission(PERMISSOES_VISUALIZACAO), async (req, res) => {
  try {
    const result = await pool.query('SELECT id_setor, nome_setor, ativo, created_at, updated_at FROM setores WHERE ativo = TRUE ORDER BY nome_setor ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar setores:', error);
    logAction(req.user?.userId, req.user?.email, 'SETOR_LIST_FAILED', 'Setor', null, { error: error.message });
    res.status(500).json({ success: false, message: 'Erro interno ao listar setores.' });
  }
});

// ROTA: Criar um novo setor
router.post('/', auth, checkPermission(PERMISSOES_GERENCIAIS), async (req, res) => {
  const { nome_setor } = req.body;
  const userId = req.user.userId;
  const userEmail = req.user.email;
  if (!nome_setor || nome_setor.trim() === '') {
    return res.status(400).json({ success: false, message: 'Nome do setor é obrigatório.' });
  }
  try {
    const result = await pool.query('INSERT INTO setores (nome_setor) VALUES ($1) RETURNING *', [nome_setor.trim()]);
    const novoSetor = result.rows[0];
    logAction(userId, userEmail, ACTION_TYPES.SETOR_CREATED || 'SETOR_CREATED', ENTITY_TYPES.SETOR || 'Setor', novoSetor.id_setor, { newData: novoSetor });
    res.status(201).json({ success: true, message: 'Setor criado!', setor: novoSetor });
  } catch (error) {
    console.error('Erro ao criar setor:', error);
    if (error.constraint === 'setores_nome_setor_key') {
      logAction(userId, userEmail, 'SETOR_CREATE_FAILED_DUPLICATE', 'Setor', null, { nome_setor, error: error.message });
      return res.status(409).json({ success: false, message: 'Já existe um setor com este nome.' });
    }
    logAction(userId, userEmail, 'SETOR_CREATE_FAILED', 'Setor', null, { nome_setor, error: error.message });
    res.status(500).json({ success: false, message: 'Erro ao criar setor.' });
  }
});

// ROTA: Atualizar um setor
router.put('/:id_setor', auth, checkPermission(PERMISSOES_GERENCIAIS), async (req, res) => {
  const { id_setor } = req.params;
  const { nome_setor, ativo } = req.body;
  const userId = req.user.userId;
  const userEmail = req.user.email;
  if ((nome_setor && nome_setor.trim() === '') || (ativo !== undefined && typeof ativo !== 'boolean')) {
    return res.status(400).json({ success: false, message: 'Dados inválidos.' });
  }
  let oldData;
  try {
    const oldResult = await pool.query('SELECT * FROM setores WHERE id_setor = $1', [id_setor]);
    if (oldResult.rows.length === 0) {
      logAction(userId, userEmail, 'SETOR_UPDATE_FAILED_NOT_FOUND', 'Setor', id_setor);
      return res.status(404).json({ success: false, message: 'Setor não encontrado.' });
    }
    oldData = oldResult.rows[0];
  } catch (dbError) { console.error('Erro ao buscar setor para log:', dbError); }
  const fieldsToUpdate = [];
  const values = [];
  let paramIndex = 1;
  if (nome_setor !== undefined) { fieldsToUpdate.push(`nome_setor = $${paramIndex++}`); values.push(nome_setor.trim()); }
  if (ativo !== undefined) { fieldsToUpdate.push(`ativo = $${paramIndex++}`); values.push(ativo); }
  if (fieldsToUpdate.length === 0) return res.status(400).json({ success: false, message: 'Nenhum dado para atualização.' });
  fieldsToUpdate.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id_setor);
  const query = `UPDATE setores SET ${fieldsToUpdate.join(', ')} WHERE id_setor = $${paramIndex} RETURNING *`;
  try {
    const result = await pool.query(query, values);
    logAction(userId, userEmail, ACTION_TYPES.SETOR_UPDATED || 'SETOR_UPDATED', ENTITY_TYPES.SETOR || 'Setor', id_setor, { oldData, newData: result.rows[0] });
    res.json({ success: true, message: 'Setor atualizado!', setor: result.rows[0] });
  } catch (error) {
    console.error('Erro ao atualizar setor:', error);
    if (error.constraint === 'setores_nome_setor_key') {
      logAction(userId, userEmail, 'SETOR_UPDATE_FAILED_DUPLICATE', 'Setor', id_setor, { nome_setor, error: error.message });
      return res.status(409).json({ success: false, message: 'Já existe um setor com este nome.' });
    }
    logAction(userId, userEmail, 'SETOR_UPDATE_FAILED', 'Setor', id_setor, { error: error.message, input: req.body });
    res.status(500).json({ success: false, message: 'Erro ao atualizar setor.' });
  }
});

// ROTA: "Deletar" um setor (desativá-lo)
router.delete('/:id_setor', auth, checkPermission(PERMISSOES_GERENCIAIS), async (req, res) => {
  const { id_setor } = req.params;
  const userId = req.user.userId;
  const userEmail = req.user.email;
  try {
    const setorResult = await pool.query('SELECT * FROM setores WHERE id_setor = $1', [id_setor]);
    if (setorResult.rows.length === 0) {
      logAction(userId, userEmail, 'SETOR_DEACTIVATE_FAILED_NOT_FOUND', 'Setor', id_setor);
      return res.status(404).json({ success: false, message: 'Setor não encontrado.' });
    }
    const result = await pool.query('UPDATE setores SET ativo = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id_setor = $1 RETURNING *', [id_setor]);
    logAction(userId, userEmail, ACTION_TYPES.SETOR_DEACTIVATED || 'SETOR_DEACTIVATED', ENTITY_TYPES.SETOR || 'Setor', id_setor, { deactivatedData: result.rows[0] });
    res.json({ success: true, message: 'Setor desativado.', setor: result.rows[0] });
  } catch (error) {
    console.error('Erro ao desativar setor:', error);
    if (error.constraint && error.message.includes('violates foreign key constraint')) {
        logAction(userId, userEmail, 'SETOR_DEACTIVATE_FAILED_IN_USE', 'Setor', id_setor, { error: error.message });
        return res.status(409).json({ success: false, message: 'Setor não pode ser desativado pois está em uso. Remova as referências em configurações de salário ou alocações de esforço antes.' });
    }
    logAction(userId, userEmail, 'SETOR_DEACTIVATE_FAILED', 'Setor', id_setor, { error: error.message });
    res.status(500).json({ success: false, message: 'Erro ao desativar setor.' });
  }
});

module.exports = router;