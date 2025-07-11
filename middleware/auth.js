const jwt = require('jsonwebtoken');

const auth = (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'Token não fornecido'
      });
    }

    const token = authHeader.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token não fornecido'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('✅ Token JWT decodificado:', decoded); // <-- Adicionado este log
    req.user = decoded;

    next();

  } catch (error) {
    console.error('❌ Erro ao verificar o token:', error);
    res.status(401).json({
      success: false,
      message: 'Token inválido'
    });
  }
};

module.exports = auth;
