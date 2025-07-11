const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');

const router = express.Router();

// 🔒 Permissão: Dev ou Gerente (criar/editar)
const authorizeAdminOrDev = (req, res, next) => {
  if (req.user && (req.user.permissao === 'Dev' || req.user.permissao === 'Gerente')) {
    next();
  } else {
    res.status(403).json({ success: false, message: 'Acesso não autorizado para esta operação.' });
  }
};

// 🔒 Permissão: Somente Dev (excluir)
const authorizeDevOnly = (req, res, next) => {
  if (req.user && req.user.permissao === 'Dev') {
    next();
  } else {
    res.status(403).json({ success: false, message: 'Acesso restrito a Desenvolvedores.' });
  }
};

// 👁️ Permissão: leitura (CRM, Operador, Fiscal, Gerente, Gestor, Dev)
const authorizeReadOnlyUsers = (req, res, next) => {
  const allowed = ['CRM', 'Operador', 'Fiscal', 'Gerente', 'Gestor', 'Dev'];
  if (req.user && allowed.includes(req.user.permissao)) {
    next();
  } else {
    res.status(403).json({ success: false, message: 'Acesso não autorizado para esta operação.' });
  }
};

// 🧩 ROTAS

// POST - Criar usuário
router.post('/', auth, authorizeAdminOrDev, async (req, res) => {
  const { email, senha, nome, permissao } = req.body;
  if (!email || !senha || !nome || !permissao) {
    return res.status(400).json({ success: false, message: 'Todos os campos são obrigatórios.' });
  }

  const validPermissions = ['Dev', 'Gerente', 'Operador', 'Gestor', 'CRM', 'Fiscal'];
  if (!validPermissions.includes(permissao)) {
    return res.status(400).json({ success: false, message: 'Permissão inválida.' });
  }

  try {
    const existing = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'Email já cadastrado.' });
    }

    const hashedPassword = await bcrypt.hash(senha, 10);
    const result = await pool.query(
      'INSERT INTO usuarios (email, senha, nome, permissao, criado_em) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP) RETURNING id, email, nome, permissao, criado_em',
      [email, hashedPassword, nome, permissao]
    );

    const newUser = result.rows[0];
    await logAction(req.user.userId, req.user.email, ACTION_TYPES.USER_CREATED, ENTITY_TYPES.USER, newUser.id, {
      userData: newUser,
    });

    res.status(201).json({ success: true, user: newUser });
  } catch (error) {
    console.error('Erro ao criar usuário:', error);
    await logAction(req.user.userId, req.user.email, ACTION_TYPES.SYSTEM_ERROR, ENTITY_TYPES.USER, null, {
      error: error.message,
      details: 'Falha ao criar usuário',
    });
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});

// GET - Listar todos os usuários
router.get('/', auth, authorizeReadOnlyUsers, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, nome, permissao, setor, ramal, modelo_trabalho, foto_perfil_url, criado_em FROM usuarios ORDER BY nome ASC'
    );
    res.json({ success: true, users: result.rows });
  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    await logAction(req.user.userId, req.user.email, ACTION_TYPES.SYSTEM_ERROR, ENTITY_TYPES.USER, null, {
      error: error.message,
      details: 'Falha ao listar usuários',
    });
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});

// GET - Obter usuário específico
router.get('/:id', auth, authorizeReadOnlyUsers, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'SELECT id, email, nome, permissao, criado_em FROM usuarios WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
    }
    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Erro ao buscar usuário:', error);
    await logAction(req.user.userId, req.user.email, ACTION_TYPES.SYSTEM_ERROR, ENTITY_TYPES.USER, id, {
      error: error.message,
      details: 'Falha ao buscar usuário',
    });
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});

// PUT - Atualizar usuário
router.put('/:id', auth, authorizeAdminOrDev, async (req, res) => {
  const { id } = req.params;
  const { nome, permissao, email } = req.body;

  if (!nome && !permissao && !email) {
    return res.status(400).json({ success: false, message: 'Informe nome, email ou permissão para atualizar.' });
  }

  const validPermissions = ['Dev', 'Gerente', 'Operador', 'Gestor', 'Administrativo', 'CRM', 'Fiscal'];
  if (permissao && !validPermissions.includes(permissao)) {
    return res.status(400).json({ success: false, message: 'Permissão inválida.' });
  }

  if (email && !/.+@.+\..+/.test(email)) {
    return res.status(400).json({ success: false, message: 'Email inválido.' });
  }

  try {
    const oldUser = await pool.query('SELECT * FROM usuarios WHERE id = $1', [id]);
    if (oldUser.rows.length === 0) return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });

    if (permissao === 'Dev' && req.user.permissao !== 'Dev') {
      return res.status(403).json({ success: false, message: 'Apenas Devs podem promover para Dev.' });
    }

    const updates = [];
    const values = [];
    let i = 1;

    if (nome) updates.push(`nome = $${i++}`), values.push(nome);
    if (permissao) updates.push(`permissao = $${i++}`), values.push(permissao);
    if (email && email !== oldUser.rows[0].email) {
      const checkEmail = await pool.query('SELECT id FROM usuarios WHERE email = $1 AND id != $2', [email, id]);
      if (checkEmail.rows.length > 0) {
        return res.status(409).json({ success: false, message: 'Email já em uso por outro usuário.' });
      }
      updates.push(`email = $${i++}`);
      values.push(email);
    }

    values.push(id);

    const query = `UPDATE usuarios SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, email, nome, permissao, criado_em`;
    const result = await pool.query(query, values);

    await logAction(req.user.userId, req.user.email, ACTION_TYPES.USER_UPDATED, ENTITY_TYPES.USER, id, {
      oldData: oldUser.rows[0],
      newData: result.rows[0],
    });

    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Erro ao atualizar usuário:', error);
    await logAction(req.user.userId, req.user.email, ACTION_TYPES.SYSTEM_ERROR, ENTITY_TYPES.USER, id, {
      error: error.message,
      details: 'Erro ao atualizar usuário',
    });
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});

// PUT - Atualizar senha
router.put('/:id/password', auth, authorizeAdminOrDev, async (req, res) => {
  const { id } = req.params;
  const { nova_senha } = req.body;

  if (!nova_senha || nova_senha.length < 6) {
    return res.status(400).json({ success: false, message: 'Senha deve ter no mínimo 6 caracteres.' });
  }

  try {
    const user = await pool.query('SELECT permissao, email FROM usuarios WHERE id = $1', [id]);
    if (user.rows.length === 0) return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });

    if (user.rows[0].permissao === 'Dev' && req.user.permissao !== 'Dev' && parseInt(id) !== req.user.userId) {
      return res.status(403).json({ success: false, message: 'Apenas Devs podem alterar senha de Devs.' });
    }

    const hashed = await bcrypt.hash(nova_senha, 10);
    await pool.query('UPDATE usuarios SET senha = $1 WHERE id = $2', [hashed, id]);

    await logAction(req.user.userId, req.user.email, ACTION_TYPES.USER_PASSWORD_UPDATED, ENTITY_TYPES.USER, id, {
      user_email_updated: user.rows[0].email,
    });

    res.json({ success: true, message: 'Senha atualizada com sucesso.' });
  } catch (error) {
    console.error('Erro ao atualizar senha:', error);
    await logAction(req.user.userId, req.user.email, ACTION_TYPES.SYSTEM_ERROR, ENTITY_TYPES.USER, id, {
      error: error.message,
      details: 'Erro ao atualizar senha',
    });
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});

// DELETE - Excluir usuário (somente Dev)
router.delete('/:id', auth, authorizeDevOnly, async (req, res) => {
  const { id } = req.params;

  if (parseInt(id) === req.user.userId) {
    return res.status(400).json({ success: false, message: 'Você não pode excluir a si mesmo.' });
  }

  try {
    const result = await pool.query('SELECT email, nome, permissao FROM usuarios WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
    }

    await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);

    await logAction(req.user.userId, req.user.email, ACTION_TYPES.USER_DELETED, ENTITY_TYPES.USER, id, {
      deletedUserData: result.rows[0],
    });

    res.json({ success: true, message: 'Usuário excluído com sucesso.' });
  } catch (error) {
    console.error('Erro ao excluir usuário:', error);
    await logAction(req.user.userId, req.user.email, ACTION_TYPES.SYSTEM_ERROR, ENTITY_TYPES.USER, id, {
      error: error.message,
      details: 'Erro ao excluir usuário',
    });
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});

module.exports = router;
