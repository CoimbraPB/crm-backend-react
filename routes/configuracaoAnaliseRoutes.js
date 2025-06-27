const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');

const checkPermissionGerencial = (req, res, next) => {
  const userPermission = req.user.permissao;
  if (['Gerente', 'Dev'].includes(userPermission)) {
    next();
  } else {
    logAction(req.user.userId, req.user.email, 'CONFIG_ANALISE_ACCESS_DENIED', 'ConfiguracaoAnalise', null, { route: req.path, attemptedPermission: userPermission });
    return res.status(403).json({ success: false, message: 'Acesso negado.' });
  }
};

// --- ROTAS PARA CONFIGURAÇÃO GLOBAL MENSAL (Margem, Fator Horas) ---
router.get('/global/:mes_ano', auth, checkPermissionGerencial, async (req, res) => {
  const { mes_ano } = req.params; 
  try {
    const result = await pool.query(
      'SELECT mes_ano_referencia, percentual_margem_lucro_desejada, fator_horas_mensal_padrao FROM configuracao_analise_global_mensal WHERE mes_ano_referencia = $1',
      [mes_ano]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Configuração global não encontrada.' });
    res.json({ success: true, configuracao_global: result.rows[0] });
  } catch (error) {
    console.error('Erro GET /configuracao-analise/global:', error);
    logAction(req.user.userId, req.user.email, 'CONFIG_GLOBAL_GET_FAILED', 'ConfiguracaoAnaliseGlobal', null, { mes_ano, error: error.message });
    res.status(500).json({ success: false, message: 'Erro ao buscar configuração global.' });
  }
});

router.post('/global', auth, checkPermissionGerencial, async (req, res) => {
  const { mes_ano_referencia, percentual_margem_lucro_desejada, fator_horas_mensal_padrao } = req.body;
  const userId = req.user.userId, userEmail = req.user.email;
  if (!mes_ano_referencia || percentual_margem_lucro_desejada === undefined || fator_horas_mensal_padrao === undefined) {
    return res.status(400).json({ success: false, message: 'Campos obrigatórios ausentes.' });
  }
  try {
    const query = `
      INSERT INTO configuracao_analise_global_mensal (mes_ano_referencia, percentual_margem_lucro_desejada, fator_horas_mensal_padrao, definido_por_usuario_id, data_modificacao)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      ON CONFLICT (mes_ano_referencia) DO UPDATE SET
        percentual_margem_lucro_desejada = EXCLUDED.percentual_margem_lucro_desejada,
        fator_horas_mensal_padrao = EXCLUDED.fator_horas_mensal_padrao,
        definido_por_usuario_id = EXCLUDED.definido_por_usuario_id,
        data_modificacao = CURRENT_TIMESTAMP
      RETURNING *;`;
    const result = await pool.query(query, [mes_ano_referencia, percentual_margem_lucro_desejada, fator_horas_mensal_padrao, userId]);
    logAction(userId, userEmail, 'CONFIG_GLOBAL_SAVED', 'ConfiguracaoAnaliseGlobal', result.rows[0].mes_ano_referencia, { newData: result.rows[0] });
    res.status(200).json({ success: true, message: 'Configuração global salva!', configuracao_global: result.rows[0] });
  } catch (error) {
    console.error('Erro POST /configuracao-analise/global:', error);
    logAction(userId, userEmail, 'CONFIG_GLOBAL_SAVE_FAILED', 'ConfiguracaoAnaliseGlobal', null, { input: req.body, error: error.message });
    res.status(500).json({ success: false, message: 'Erro ao salvar configuração global.' });
  }
});

// --- ROTAS PARA CONFIGURAÇÃO DE SALÁRIOS POR CARGO/SETOR MENSAL ---
router.get('/salarios/:mes_ano', auth, checkPermissionGerencial, async (req, res) => {
  const { mes_ano } = req.params;
  try {
    const result = await pool.query(
      `SELECT cscm.id, cscm.mes_ano_referencia, cscm.setor_id, s.nome_setor, cscm.cargo_id, c.nome_cargo, cscm.salario_mensal_base 
       FROM configuracoes_salario_cargo_mensal cscm
       JOIN setores s ON cscm.setor_id = s.id_setor
       JOIN cargos c ON cscm.cargo_id = c.id_cargo
       WHERE cscm.mes_ano_referencia = $1 ORDER BY s.nome_setor, c.nome_cargo`,
      [mes_ano]
    );
    res.json({ success: true, salarios_config: result.rows });
  } catch (error) {
    console.error('Erro GET /configuracao-analise/salarios:', error);
    logAction(req.user.userId, req.user.email, 'CONFIG_SALARIO_GET_FAILED', 'ConfiguracaoSalario', null, { mes_ano, error: error.message });
    res.status(500).json({ success: false, message: 'Erro ao buscar salários.' });
  }
});

router.post('/salarios/:mes_ano', auth, checkPermissionGerencial, async (req, res) => {
  const { mes_ano } = req.params;
  const salarios = req.body.salarios;
  const userId = req.user.userId, userEmail = req.user.email;
  if (!Array.isArray(salarios)) return res.status(400).json({ success: false, message: 'Payload de salários deve ser um array.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const config of salarios) {
      if (config.setor_id === undefined || config.cargo_id === undefined || config.salario_mensal_base === undefined || parseFloat(config.salario_mensal_base) < 0) {
        throw new Error('Dados inválidos para uma ou mais configs de salário.'); // Aborta transação
      }
      const query = `
        INSERT INTO configuracoes_salario_cargo_mensal (mes_ano_referencia, setor_id, cargo_id, salario_mensal_base, definido_por_usuario_id, data_modificacao)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        ON CONFLICT (mes_ano_referencia, setor_id, cargo_id) DO UPDATE SET
          salario_mensal_base = EXCLUDED.salario_mensal_base,
          definido_por_usuario_id = EXCLUDED.definido_por_usuario_id,
          data_modificacao = CURRENT_TIMESTAMP
        RETURNING *;`;
      const result = await client.query(query, [mes_ano, config.setor_id, config.cargo_id, config.salario_mensal_base, userId]);
      results.push(result.rows[0]);
    }
    await client.query('COMMIT');
    logAction(userId, userEmail, 'CONFIG_SALARIO_SAVED_BATCH', 'ConfiguracaoSalario', null, { mes_ano, count: results.length });
    res.status(200).json({ success: true, message: `${results.length} configs de salário salvas para ${mes_ano}!`, saved_configs: results });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro POST /configuracao-analise/salarios:', error);
    logAction(userId, userEmail, 'CONFIG_SALARIO_SAVE_BATCH_FAILED', 'ConfiguracaoSalario', null, { mes_ano, error: error.message });
    res.status(500).json({ success: false, message: error.message || 'Erro ao salvar salários.' });
  } finally {
    client.release();
  }
});

module.exports = router;