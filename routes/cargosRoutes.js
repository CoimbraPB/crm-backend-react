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
      logAction(req.user.userId, req.user.email, 'CARGO_ACCESS_DENIED', 'Cargo', null, { route: req.path, attemptedPermission: userPermission });
      return res.status(403).json({ success: false, message: 'Acesso negado. Permissão insuficiente.' });
    }
  };
};

const PERMISSOES_GERENCIAIS = ['Gerente', 'Dev']; 
const PERMISSOES_VISUALIZACAO = ['Gerente', 'Dev'];

// ROTA: Listar todos os cargos ativos
router.get('/', auth, checkPermission(PERMISSOES_VISUALIZACAO), async (req, res) => {
  try {
    const result = await pool.query('SELECT id_cargo, nome_cargo, ativo, created_at, updated_at FROM cargos WHERE ativo = TRUE ORDER BY nome_cargo ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar cargos:', error);
    logAction(req.user?.userId, req.user?.email, 'CARGO_LIST_FAILED', 'Cargo', null, { error: error.message });
    res.status(500).json({ success: false, message: 'Erro interno ao listar cargos.' });
  }
});

// ROTA: Criar um novo cargo
router.post('/', auth, checkPermission(PERMISSOES_GERENCIAIS), async (req, res) => {
  const { nome_cargo } = req.body;
  const userId = req.user.userId;
  const userEmail = req.user.email;

  if (!nome_cargo || nome_cargo.trim() === '') {
    return res.status(400).json({ success: false, message: 'Nome do cargo é obrigatório.' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO cargos (nome_cargo) VALUES ($1) RETURNING *',
      [nome_cargo.trim()]
    );
    const novoCargo = result.rows[0];
    // Adicione ACTION_TYPES.CARGO_CREATED e ENTITY_TYPES.CARGO ao seu auditLogService se não existirem
    logAction(userId, userEmail, ACTION_TYPES.CARGO_CREATED || 'CARGO_CREATED', ENTITY_TYPES.CARGO || 'Cargo', novoCargo.id_cargo, { newData: novoCargo });
    res.status(201).json({ success: true, message: 'Cargo criado com sucesso!', cargo: novoCargo });
  } catch (error) {
    console.error('Erro ao criar cargo:', error);
    if (error.constraint === 'cargos_nome_cargo_key') {
      logAction(userId, userEmail, 'CARGO_CREATE_FAILED_DUPLICATE', 'Cargo', null, { nome_cargo, error: error.message });
      return res.status(409).json({ success: false, message: 'Já existe um cargo com este nome.' });
    }
    logAction(userId, userEmail, 'CARGO_CREATE_FAILED', 'Cargo', null, { nome_cargo, error: error.message });
    res.status(500).json({ success: false, message: 'Erro interno ao criar cargo.' });
  }
});

// ROTA: Atualizar um cargo existente (nome ou status ativo)
router.put('/:id_cargo', auth, checkPermission(PERMISSOES_GERENCIAIS), async (req, res) => {
  const { id_cargo } = req.params;
  const { nome_cargo, ativo } = req.body;
  const userId = req.user.userId;
  const userEmail = req.user.email;

  if ((nome_cargo && nome_cargo.trim() === '') || (ativo !== undefined && typeof ativo !== 'boolean')) {
    return res.status(400).json({ success: false, message: 'Dados inválidos para atualização.' });
  }

  let oldData;
  try {
    const oldResult = await pool.query('SELECT * FROM cargos WHERE id_cargo = $1', [id_cargo]);
    if (oldResult.rows.length === 0) {
      logAction(userId, userEmail, 'CARGO_UPDATE_FAILED_NOT_FOUND', 'Cargo', id_cargo);
      return res.status(404).json({ success: false, message: 'Cargo não encontrado.' });
    }
    oldData = oldResult.rows[0];
  } catch (dbError) {
     console.error('Erro ao buscar cargo para log (update):', dbError);
  }

  const fieldsToUpdate = [];
  const values = [];
  let paramIndex = 1;
  if (nome_cargo !== undefined) { fieldsToUpdate.push(`nome_cargo = $${paramIndex++}`); values.push(nome_cargo.trim()); }
  if (ativo !== undefined) { fieldsToUpdate.push(`ativo = $${paramIndex++}`); values.push(ativo); }
  if (fieldsToUpdate.length === 0) return res.status(400).json({ success: false, message: 'Nenhum dado para atualização.' });
  fieldsToUpdate.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id_cargo);
  const query = `UPDATE cargos SET ${fieldsToUpdate.join(', ')} WHERE id_cargo = $${paramIndex} RETURNING *`;

  try {
    const result = await pool.query(query, values);
    const cargoAtualizado = result.rows[0];
    logAction(userId, userEmail, ACTION_TYPES.CARGO_UPDATED || 'CARGO_UPDATED', ENTITY_TYPES.CARGO || 'Cargo', id_cargo, { oldData, newData: cargoAtualizado });
    res.json({ success: true, message: 'Cargo atualizado!', cargo: cargoAtualizado });
  } catch (error) {
    console.error('Erro ao atualizar cargo:', error);
    if (error.constraint === 'cargos_nome_cargo_key') {
      logAction(userId, userEmail, 'CARGO_UPDATE_FAILED_DUPLICATE', 'Cargo', id_cargo, { nome_cargo, error: error.message });
      return res.status(409).json({ success: false, message: 'Já existe um cargo com este nome.' });
    }
    logAction(userId, userEmail, 'CARGO_UPDATE_FAILED', 'Cargo', id_cargo, { error: error.message, input: req.body });
    res.status(500).json({ success: false, message: 'Erro ao atualizar cargo.' });
  }
});

// ROTA: "Deletar" um cargo (desativá-lo)
router.delete('/:id_cargo', auth, checkPermission(PERMISSOES_GERENCIAIS), async (req, res) => {
  const { id_cargo } = req.params;
  const userId = req.user.userId;
  const userEmail = req.user.email;
  try {
    const cargoResult = await pool.query('SELECT * FROM cargos WHERE id_cargo = $1', [id_cargo]);
    if (cargoResult.rows.length === 0) {
      logAction(userId, userEmail, 'CARGO_DEACTIVATE_FAILED_NOT_FOUND', 'Cargo', id_cargo);
      return res.status(404).json({ success: false, message: 'Cargo não encontrado.' });
    }
    const result = await pool.query('UPDATE cargos SET ativo = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id_cargo = $1 RETURNING *', [id_cargo]);
    logAction(userId, userEmail, ACTION_TYPES.CARGO_DEACTIVATED || 'CARGO_DEACTIVATED', ENTITY_TYPES.CARGO || 'Cargo', id_cargo, { deactivatedData: result.rows[0] });
    res.json({ success: true, message: 'Cargo desativado.', cargo: result.rows[0] });
  } catch (error) {
    console.error('Erro ao desativar cargo:', error);
    logAction(userId, userEmail, 'CARGO_DEACTIVATE_FAILED', 'Cargo', id_cargo, { error: error.message });
    res.status(500).json({ success: false, message: 'Erro ao desativar cargo.' });
  }
});

module.exports = router;