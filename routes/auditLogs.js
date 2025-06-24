const express = require('express');
const pool = require('../config/database');
const auth = require('../middleware/auth');
// const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService'); // Temporariamente comentado para focar no erro principal

const router = express.Router();

const authorizeDevOnly = (req, res, next) => {
  if (req.user && req.user.permissao === 'Dev') {
    next();
  } else {
    res.status(403).json({ success: false, message: 'Acesso restrito a Desenvolvedores.' });
  }
};

router.get('/', auth, authorizeDevOnly, async (req, res) => {
  const {
    page = 1,
    limit = 20,
    userId,
    userEmail,
    actionType,
    entityType,
    entityId,
    startDate,
    endDate
  } = req.query;

  try {
    const queryParams = [];
    let whereClausesString = ' WHERE 1=1'; // Começa com uma condição sempre verdadeira
    let paramIndex = 1;

    // Base para as duas queries
    const fromAndJoins = 'FROM audit_logs al LEFT JOIN usuarios u ON al.user_id = u.id';

    if (userId) {
      whereClausesString += ` AND al.user_id = $${paramIndex++}`;
      queryParams.push(parseInt(userId));
    }
    if (userEmail) {
      whereClausesString += ` AND al.user_email ILIKE $${paramIndex++}`;
      queryParams.push(`%${userEmail}%`);
    }
    if (actionType) {
      whereClausesString += ` AND al.action_type = $${paramIndex++}`;
      queryParams.push(actionType);
    }
    if (entityType) {
      console.log('Filtrando por entityType no backend:', entityType); // Log para depuração
      whereClausesString += ` AND al.entity_type = $${paramIndex++}`;
      queryParams.push(entityType);
    }
    if (entityId) {
      whereClausesString += ` AND al.entity_id = $${paramIndex++}`;
      queryParams.push(entityId);
    }
    if (startDate) {
      whereClausesString += ` AND al.timestamp >= $${paramIndex++}`;
      queryParams.push(startDate);
    }
    if (endDate) {
      const dateEnd = new Date(endDate);
      dateEnd.setDate(dateEnd.getDate() + 1);
      whereClausesString += ` AND al.timestamp < $${paramIndex++}`;
      queryParams.push(dateEnd.toISOString().split('T')[0]);
    }
    
    // Query de Contagem
    const countQueryString = `SELECT COUNT(al.id) AS total_count ${fromAndJoins} ${whereClausesString}`;
    
    console.log('Count Query:', countQueryString);
    console.log('Count Query Params:', queryParams);
    const totalResult = await pool.query(countQueryString, queryParams);
    const totalLogs = parseInt(totalResult.rows[0].total_count, 10);
    const totalPages = Math.ceil(totalLogs / limit) || 1;

    // Query de Dados
    const dataQueryString = `SELECT al.*, u.nome as user_nome ${fromAndJoins} ${whereClausesString} ORDER BY al.timestamp DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    // Adiciona os parâmetros de paginação DEPOIS dos parâmetros de filtro
    const finalDataQueryParams = [...queryParams, parseInt(limit), (parseInt(page) - 1) * parseInt(limit)];
    
    console.log('Data Query:', dataQueryString);
    console.log('Data Query Params:', finalDataQueryParams);
    const result = await pool.query(dataQueryString, finalDataQueryParams);

    res.json({
      success: true,
      logs: result.rows,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalLogs,
        logsPerPage: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Erro ao buscar logs de auditoria:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor ao buscar logs.' });
  }
});

module.exports = router;