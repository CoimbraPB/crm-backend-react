const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const auth = require('../middleware/auth'); // Middleware de autenticação geral
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');

const router = express.Router();

// Middleware para verificar se o usuário tem permissão de 'Dev' ou 'Gerente'
// Ajuste as permissões conforme necessário. Por exemplo, talvez 'Gerente' possa criar/listar, mas não deletar.
const authorizeAdminOrDev = (req, res, next) => {
  if (req.user && (req.user.permissao === 'Dev' || req.user.permissao === 'Gerente')) {
    next();
  } else {
    res.status(403).json({ success: false, message: 'Acesso não autorizado para esta operação.' });
  }
};

// Middleware específico para 'Dev' (ex: para deletar usuários ou mudar certas configurações)
const authorizeDevOnly = (req, res, next) => {
  if (req.user && req.user.permissao === 'Dev') {
    next();
  } else {
    res.status(403).json({ success: false, message: 'Acesso restrito a Desenvolvedores.' });
  }
};


// POST /users - Criar um novo usuário
router.post('/', auth, authorizeAdminOrDev, async (req, res) => {
  const { email, senha, nome, permissao } = req.body;

  if (!email || !senha || !nome || !permissao) {
    return res.status(400).json({ success: false, message: 'Todos os campos são obrigatórios: email, senha, nome, permissao.' });
  }

  // Validar tipo de permissão
  const validPermissions = ['Dev', 'Gerente', 'Operador', 'Gestor'];
  if (!validPermissions.includes(permissao)) {
    return res.status(400).json({ success: false, message: 'Permissão inválida.' });
  }

  try {
    // Verificar se o email já existe
    const existingUser = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'Email já cadastrado.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(senha, salt);

    const result = await pool.query(
      'INSERT INTO usuarios (email, senha, nome, permissao, criado_em) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP) RETURNING id, email, nome, permissao, criado_em',
      [email, hashedPassword, nome, permissao]
    );
    const newUser = result.rows[0];

    await logAction(
      req.user.userId,
      req.user.email,
      ACTION_TYPES.USER_CREATED,
      ENTITY_TYPES.USER,
      newUser.id,
      { userData: { email: newUser.email, nome: newUser.nome, permissao: newUser.permissao } }
    );

    res.status(201).json({ success: true, user: newUser });
  } catch (error) {
    console.error('Erro ao criar usuário:', error);
    await logAction(req.user.userId, req.user.email, ACTION_TYPES.SYSTEM_ERROR, ENTITY_TYPES.USER, null, { error: error.message, details: 'Falha ao criar usuário', requestBody: req.body });
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});

// GET /users - Listar todos os usuários
router.get('/', auth, authorizeAdminOrDev, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, nome, permissao, criado_em FROM usuarios ORDER BY nome ASC');
    res.json({ success: true, users: result.rows });
  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    await logAction(req.user.userId, req.user.email, ACTION_TYPES.SYSTEM_ERROR, ENTITY_TYPES.USER, null, { error: error.message, details: 'Falha ao listar usuários' });
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});

// GET /users/:id - Obter um usuário específico
router.get('/:id', auth, authorizeAdminOrDev, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT id, email, nome, permissao, criado_em FROM usuarios WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
    }
    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error(`Erro ao buscar usuário ${id}:`, error);
    await logAction(req.user.userId, req.user.email, ACTION_TYPES.SYSTEM_ERROR, ENTITY_TYPES.USER, id, { error: error.message, details: `Falha ao buscar usuário ${id}` });
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});


// PUT /users/:id - Atualizar nome e/ou permissão de um usuário
router.put('/:id', auth, authorizeAdminOrDev, async (req, res) => {
  const { id } = req.params;
  const { nome, permissao } = req.body;

  if (!nome && !permissao) {
    return res.status(400).json({ success: false, message: 'Pelo menos um campo (nome ou permissao) deve ser fornecido para atualização.' });
  }

  // Validar tipo de permissão se fornecida
  if (permissao) {
    const validPermissions = ['Dev', 'Gerente', 'Operador', 'Gestor'];
    if (!validPermissions.includes(permissao)) {
      return res.status(400).json({ success: false, message: 'Permissão inválida.' });
    }
  }
  
  // Impedir que usuário não-Dev altere a permissão para 'Dev' ou de um 'Dev'
  if (req.user.permissao !== 'Dev' && permissao === 'Dev') {
    return res.status(403).json({ success: false, message: 'Apenas Devs podem atribuir a permissão Dev.' });
  }

  try {
    const userToUpdateResult = await pool.query('SELECT * FROM usuarios WHERE id = $1', [id]);
    if (userToUpdateResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
    }
    const oldUserData = userToUpdateResult.rows[0];

    // Impedir que Gerentes alterem Devs (a menos que o Dev esteja alterando a si mesmo, o que é coberto por outras lógicas se necessário)
    if (req.user.permissao === 'Gerente' && oldUserData.permissao === 'Dev' && oldUserData.id !== req.user.userId) {
         return res.status(403).json({ success: false, message: 'Gerentes não podem alterar usuários Dev.' });
    }


    const fieldsToUpdate = [];
    const values = [];
    let queryIndex = 1;

    if (nome) {
      fieldsToUpdate.push(`nome = $${queryIndex++}`);
      values.push(nome);
    }
    if (permissao) {
      fieldsToUpdate.push(`permissao = $${queryIndex++}`);
      values.push(permissao);
    }
    values.push(id);

    const query = `UPDATE usuarios SET ${fieldsToUpdate.join(', ')} WHERE id = $${queryIndex} RETURNING id, email, nome, permissao, criado_em`;
    const result = await pool.query(query, values);
    const updatedUser = result.rows[0];

    await logAction(
      req.user.userId,
      req.user.email,
      ACTION_TYPES.USER_UPDATED,
      ENTITY_TYPES.USER,
      updatedUser.id,
      { oldData: { nome: oldUserData.nome, permissao: oldUserData.permissao }, newData: { nome: updatedUser.nome, permissao: updatedUser.permissao } }
    );

    res.json({ success: true, user: updatedUser });
  } catch (error) {
    console.error(`Erro ao atualizar usuário ${id}:`, error);
    await logAction(req.user.userId, req.user.email, ACTION_TYPES.SYSTEM_ERROR, ENTITY_TYPES.USER, id, { error: error.message, details: `Falha ao atualizar usuário ${id}`, requestBody: req.body });
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});

// PUT /users/:id/password - Atualizar senha de um usuário
router.put('/:id/password', auth, authorizeAdminOrDev, async (req, res) => {
  const { id } = req.params;
  const { nova_senha } = req.body;

  if (!nova_senha) {
    return res.status(400).json({ success: false, message: 'Nova senha é obrigatória.' });
  }
  if (nova_senha.length < 6) { // Exemplo de validação de tamanho mínimo
    return res.status(400).json({ success: false, message: 'Nova senha deve ter pelo menos 6 caracteres.' });
  }
  
  try {
    const userToUpdateResult = await pool.query('SELECT permissao, email FROM usuarios WHERE id = $1', [id]);
    if (userToUpdateResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
    }
    const userToUpdateData = userToUpdateResult.rows[0];

    // Impedir que Gerentes alterem senha de Devs, a menos que seja o próprio Dev
    if (req.user.permissao === 'Gerente' && userToUpdateData.permissao === 'Dev' && parseInt(id) !== req.user.userId) {
      return res.status(403).json({ success: false, message: 'Gerentes não podem alterar a senha de usuários Dev.' });
    }
    // Um usuário pode alterar a própria senha OU um Dev pode alterar qualquer senha (exceto se a lógica acima já barrou)
    if (parseInt(id) !== req.user.userId && req.user.permissao !== 'Dev') {
        // Se não é o próprio usuário e não é Dev, então um Gerente está tentando mudar senha de outro Gerente/Operador/Gestor, o que é permitido por authorizeAdminOrDev
        // Mas se for um Operador/Gestor tentando mudar senha de outro, isso seria barrado por authorizeAdminOrDev
    }


    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(nova_senha, salt);

    await pool.query('UPDATE usuarios SET senha = $1 WHERE id = $2', [hashedPassword, id]);

    await logAction(
      req.user.userId,
      req.user.email,
      ACTION_TYPES.USER_PASSWORD_UPDATED,
      ENTITY_TYPES.USER,
      id,
      { user_email_updated: userToUpdateData.email } 
    );

    res.json({ success: true, message: 'Senha atualizada com sucesso.' });
  } catch (error) {
    console.error(`Erro ao atualizar senha do usuário ${id}:`, error);
    await logAction(req.user.userId, req.user.email, ACTION_TYPES.SYSTEM_ERROR, ENTITY_TYPES.USER, id, { error: error.message, details: `Falha ao atualizar senha do usuário ${id}` });
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});

// DELETE /users/:id - Excluir um usuário
// Somente 'Dev' pode excluir usuários.
router.delete('/:id', auth, authorizeDevOnly, async (req, res) => {
  const { id } = req.params;
  const loggedInUserId = req.user.userId;

  if (parseInt(id) === loggedInUserId) {
    return res.status(400).json({ success: false, message: 'Não é possível excluir a si mesmo.' });
  }
  
  // Opcional: Impedir exclusão do último usuário Dev.
  // if (userToDeleteData.permissao === 'Dev') {
  //   const devCountResult = await pool.query("SELECT COUNT(*) FROM usuarios WHERE permissao = 'Dev'");
  //   if (parseInt(devCountResult.rows[0].count, 10) <= 1) {
  //     return res.status(400).json({ success: false, message: 'Não é possível excluir o último usuário Dev.' });
  //   }
  // }


  try {
    const userToDeleteResult = await pool.query('SELECT email, nome, permissao FROM usuarios WHERE id = $1', [id]);
    if (userToDeleteResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
    }
    const deletedUserData = userToDeleteResult.rows[0];
    
    // Impedir que um Dev exclua outro Dev se não for permitido (pode ser uma regra de negócio)
    // if (deletedUserData.permissao === 'Dev' && req.user.permissao === 'Dev' && parseInt(id) !== loggedInUserId) {
    //   É um Dev tentando excluir outro Dev. Decida se isso é permitido.
    // }


    const result = await pool.query('DELETE FROM usuarios WHERE id = $1 RETURNING id', [id]);
    if (result.rowCount === 0) { // Dupla verificação, embora a primeira query já deva pegar
      return res.status(404).json({ success: false, message: 'Usuário não encontrado para exclusão.' });
    }

    await logAction(
      req.user.userId,
      req.user.email,
      ACTION_TYPES.USER_DELETED,
      ENTITY_TYPES.USER,
      id,
      { deletedUserData: { email: deletedUserData.email, nome: deletedUserData.nome, permissao: deletedUserData.permissao } }
    );

    res.json({ success: true, message: 'Usuário excluído com sucesso.' });
  } catch (error) {
    console.error(`Erro ao excluir usuário ${id}:`, error);
    await logAction(req.user.userId, req.user.email, ACTION_TYPES.SYSTEM_ERROR, ENTITY_TYPES.USER, id, { error: error.message, details: `Falha ao excluir usuário ${id}` });
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});


module.exports = router;
