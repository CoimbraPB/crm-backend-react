const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const auth = require('../middleware/auth');

const router = express.Router();

// Login
router.post('/login', async (req, res) => {
  try {
    console.log('Login request received:', { email: req.body.email });
    
    const { email, senha } = req.body;

    if (!email || !senha) {
      return res.status(400).json({
        success: false,
        message: 'Email e senha são obrigatórios'
      });
    }

    // Buscar usuário no banco
    const result = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1',
      [email]
    );

    console.log('Database query result:', result.rows.length);

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Credenciais inválidas'
      });
    }

    const user = result.rows[0];

    // Verificar senha usando bcrypt
    const senhaCorreta = await bcrypt.compare(senha, user.senha);
    if (!senhaCorreta) {
      return res.status(401).json({
        success: false,
        message: 'Credenciais inválidas'
      });
    }

    // Gerar token JWT
  const token = jwt.sign(
    { 
      userId: user.id,
      email: user.email,
      nome: user.nome, // <= adicionar aqui
      permissao: user.permissao
    },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );

    // Remover senha da resposta
    const { senha: _, ...userWithoutPassword } = user;

    console.log('Login successful for user:', user.email);

    // Audit log for successful login
    const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');
    await logAction(user.id, user.email, ACTION_TYPES.USER_LOGIN_SUCCESS, ENTITY_TYPES.USER, user.id);

    res.json({
      success: true,
      user: userWithoutPassword,
      token
    });

  } catch (error) {
    console.error('Erro no login:', error);
    // Optional: Log failed login attempt if you have user information at this stage
    // For example, if email was valid but password was wrong.
    // const { email } = req.body;
    // if (email) {
    //   const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');
    //   await logAction(null, email, ACTION_TYPES.USER_LOGIN_FAILED, ENTITY_TYPES.USER, null, { error: 'Invalid credentials' });
    // }
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// Verificar token
router.get('/verify', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, nome, permissao FROM usuarios WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Usuário não encontrado'
      });
    }

    res.json({
      success: true,
      user: result.rows[0]
    });

  } catch (error) {
    console.error('Erro na verificação:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

module.exports = router;
