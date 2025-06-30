const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction } = require('../services/auditLogService');

// Middleware de permissão para Gerente ou Dev
const checkPermissionGerenteDev = (req, res, next) => {
  const userPermission = req.user.permissao;
  if (['Gerente', 'Dev'].includes(userPermission)) {
    next();
  } else {
    logAction(req.user.userId, req.user.email, 'CONFIG_VALOR_HORA_ACCESS_DENIED', 'ConfigValoresHoraCargo', null, { route: req.path, attemptedPermission: userPermission });
    return res.status(403).json({ success: false, message: 'Acesso negado. Requer permissão de Gerente ou Dev.' });
  }
};

// Middleware de permissão para Gerente, Dev ou Gestor (para leitura)
const checkPermissionLeitura = (req, res, next) => {
  const userPermission = req.user.permissao;
  if (['Gerente', 'Dev', 'Gestor'].includes(userPermission)) {
    next();
  } else {
    logAction(req.user.userId, req.user.email, 'CONFIG_VALOR_HORA_READ_ACCESS_DENIED', 'ConfigValoresHoraCargo', null, { route: req.path, attemptedPermission: userPermission });
    return res.status(403).json({ success: false, message: 'Acesso negado. Requer permissão de Gerente, Dev ou Gestor.' });
  }
};

// ROTA: Listar valores hora por cargo para um mes_ano_referencia
router.get('/:mes_ano', auth, checkPermissionLeitura, async (req, res) => {
  const { mes_ano } = req.params; // Esperado no formato YYYY-MM-DD
  const userId = req.user.userId;
  const userEmail = req.user.email;

  try {
    const result = await pool.query(
      `SELECT cvhc.id, cvhc.mes_ano_referencia, cvhc.cargo_id, c.nome_cargo, cvhc.valor_hora,
              cvhc.created_at, u_created.nome as criado_por_nome,
              cvhc.updated_at, u_updated.nome as atualizado_por_nome
       FROM config_valores_hora_cargo cvhc
       JOIN cargos c ON cvhc.cargo_id = c.id_cargo
       LEFT JOIN usuarios u_created ON cvhc.created_by_user_id = u_created.id
       LEFT JOIN usuarios u_updated ON cvhc.updated_by_user_id = u_updated.id
       WHERE cvhc.mes_ano_referencia = $1
       ORDER BY c.nome_cargo ASC`,
      [mes_ano]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error(`Erro GET /config-valores-hora-cargo/${mes_ano}:`, error);
    logAction(userId, userEmail, 'CONFIG_VALOR_HORA_LIST_FAILED', 'ConfigValoresHoraCargo', null, { mes_ano, error: error.message });
    res.status(500).json({ success: false, message: 'Erro ao buscar configurações de valor hora/cargo.' });
  }
});

// ROTA: Criar/Atualizar (UPSERT) valores hora para múltiplos cargos em um mes_ano_referencia
router.post('/', auth, checkPermissionGerenteDev, async (req, res) => {
  const { mes_ano_referencia, valores } = req.body;
  const userId = req.user.userId;
  const userEmail = req.user.email;

  if (!mes_ano_referencia || !valores || !Array.isArray(valores) || valores.length === 0) {
    return res.status(400).json({ success: false, message: 'mes_ano_referencia e um array de valores são obrigatórios.' });
  }

  // Validar formato YYYY-MM-DD para mes_ano_referencia
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mes_ano_referencia)) {
    return res.status(400).json({ success: false, message: 'Formato de mes_ano_referencia inválido. Use YYYY-MM-DD.'});
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultados = [];

    for (const item of valores) {
      if (item.cargo_id === undefined || item.valor_hora === undefined) {
        throw new Error('Cada item em "valores" deve conter cargo_id e valor_hora.');
      }
      if (typeof item.cargo_id !== 'number' || typeof parseFloat(item.valor_hora) !== 'number' || parseFloat(item.valor_hora) < 0) {
        throw new Error('cargo_id deve ser um número e valor_hora deve ser um número não negativo.');
      }

      const valorHoraNumerico = parseFloat(item.valor_hora);

      const upsertQuery = `
        INSERT INTO config_valores_hora_cargo 
          (mes_ano_referencia, cargo_id, valor_hora, created_by_user_id, updated_by_user_id)
        VALUES ($1, $2, $3, $4, $4)
        ON CONFLICT (mes_ano_referencia, cargo_id) DO UPDATE SET
          valor_hora = EXCLUDED.valor_hora,
          updated_by_user_id = $4,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id, mes_ano_referencia, cargo_id, valor_hora;
      `;
      // No ON CONFLICT, updated_by_user_id é $4 (userId), pois é uma atualização.
      // created_by_user_id não é atualizado no conflito.
      
      const result = await client.query(upsertQuery, [mes_ano_referencia, item.cargo_id, valorHoraNumerico, userId]);
      resultados.push(result.rows[0]);
    }

    await client.query('COMMIT');
    logAction(userId, userEmail, 'CONFIG_VALOR_HORA_UPSERT_SUCCESS', 'ConfigValoresHoraCargo', null, { mes_ano_referencia, count: resultados.length });
    res.status(201).json({ success: true, message: 'Valores hora/cargo salvos com sucesso!', data: resultados });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro POST /config-valores-hora-cargo:', error);
    logAction(userId, userEmail, 'CONFIG_VALOR_HORA_UPSERT_FAILED', 'ConfigValoresHoraCargo', null, { mes_ano_referencia, error: error.message });
    res.status(500).json({ success: false, message: error.message || 'Erro ao salvar configurações de valor hora/cargo.' });
  } finally {
    client.release();
  }
});

module.exports = router;
