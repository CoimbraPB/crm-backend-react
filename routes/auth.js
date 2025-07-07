const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/database'); // Ajuste o caminho se o seu config estiver em outro lugar
const auth = require('../middleware/auth'); // Ajuste o caminho se o seu middleware estiver em outro lugar
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService'); // Ajuste o caminho se necessário

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
        nome: user.nome,
        permissao: user.permissao,
        foto_perfil_url: user.foto_perfil_url // <--- ADICIONE ESTA LINHA
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Remover senha da resposta
    const { senha: _, ...userWithoutPassword } = user;

    console.log('Login successful for user:', user.email);

    // Audit log for successful login
    await logAction(user.id, user.email, ACTION_TYPES.USER_LOGIN_SUCCESS, ENTITY_TYPES.USER, user.id);

    res.json({
      success: true,
      user: userWithoutPassword,
      token
    });

  } catch (error) {
    console.error('Erro no login:', error);
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

// NOVO ENDPOINT: Alterar Senha (sem autenticação prévia, mas validando senha antiga)
router.post('/change-password-unauthenticated', async (req, res) => {
  try {
    const { email, oldPassword, newPassword } = req.body;

    // Validação de entrada básica
    if (!email || !oldPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Email, senha antiga e nova senha são obrigatórios.'
      });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({
            success: false,
            message: 'Nova senha deve ter pelo menos 6 caracteres.'
        });
    }

    // Buscar usuário no banco
    const userResult = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      // Mensagem genérica para não revelar se o e-mail existe ou não,
      // ou se a senha antiga estava incorreta.
      return res.status(401).json({
        success: false,
        message: 'E-mail ou senha atual incorreta. Verifique os dados e tente novamente.'
      });
    }

    const user = userResult.rows[0];

    // Verificar senha antiga
    const senhaAntigaCorreta = await bcrypt.compare(oldPassword, user.senha);
    if (!senhaAntigaCorreta) {
      // Mesma mensagem genérica
      return res.status(401).json({
        success: false,
        message: 'E-mail ou senha atual incorreta. Verifique os dados e tente novamente.'
      });
    }

    // Gerar hash da nova senha
    const salt = await bcrypt.genSalt(10); // Recomenda-se que o número de rounds seja configurável
    const hashedNewPassword = await bcrypt.hash(newPassword, salt);

    // Atualizar senha no banco
    await pool.query(
      'UPDATE usuarios SET senha = $1 WHERE id = $2',
      [hashedNewPassword, user.id]
    );

    // Audit log
    await logAction(
        user.id, 
        user.email, 
        ACTION_TYPES.USER_PASSWORD_UPDATED, 
        ENTITY_TYPES.USER, 
        user.id, 
        { method: 'change-password-unauthenticated' } // Detalhe adicional
    );

    res.json({
      success: true,
      message: 'Senha alterada com sucesso.'
    });

  } catch (error) {
    console.error('Erro ao alterar senha (unauthenticated):', error);
    // Considerar logar o erro no audit log como SYSTEM_ERROR, se apropriado,
    // mas cuidado para não expor informações sensíveis do erro no log.
    // Exemplo: await logAction(null, req.body.email || 'unknown', ACTION_TYPES.SYSTEM_ERROR, ENTITY_TYPES.SYSTEM, null, { context: 'change-password-unauthenticated', errorMessage: error.message });
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor ao tentar alterar a senha.'
    });
  }
});


module.exports = router;