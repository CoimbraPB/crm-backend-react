const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');

const checkAccessPermission = (req, res, next) => {
  const userPermission = req.user.permissao;
  // Ajuste 'Gestor' se o nome do perfil do seu gestor de área for diferente
  if (['Gestor', 'Gerente', 'Dev'].includes(userPermission)) { 
    next();
  } else {
    logAction(req.user.userId, req.user.email, 'ALOCACAO_ESFORCO_ACCESS_DENIED', 'AlocacaoEsforco', null, { route: req.path, attemptedPermission: userPermission });
    return res.status(403).json({ success: false, message: 'Acesso negado.' });
  }
};

// ROTA: Obter alocações para um faturamento_id
router.get('/faturamento/:faturamento_id', auth, checkAccessPermission, async (req, res) => {
  const { faturamento_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT ae.id, ae.faturamento_id, ae.setor_id, s.nome_setor, ae.cargo_id, c.nome_cargo, 
         ae.quantidade_funcionarios, ae.total_horas_gastas_cargo, 
         ae.registrado_por_usuario_id, u.nome as nome_usuario_registro, ae.data_registro
       FROM alocacao_esforco_cliente_cargo ae
       JOIN setores s ON ae.setor_id = s.id_setor
       JOIN cargos c ON ae.cargo_id = c.id_cargo
       LEFT JOIN usuarios u ON ae.registrado_por_usuario_id = u.id
       WHERE ae.faturamento_id = $1 ORDER BY s.nome_setor, c.nome_cargo`,
      [faturamento_id]
    );
    res.json({ success: true, alocacoes: result.rows });
  } catch (error) {
    console.error(`Erro GET /alocacao-esforco/faturamento/${faturamento_id}:`, error);
    logAction(req.user.userId, req.user.email, 'ALOCACAO_ESFORCO_GET_FAILED', 'AlocacaoEsforco', null, { faturamento_id, error: error.message });
    res.status(500).json({ success: false, message: 'Erro ao buscar alocações.' });
  }
});

// ROTA: Salvar (Criar/Atualizar em lote) alocações para um faturamento_id
router.post('/faturamento/:faturamento_id', auth, checkAccessPermission, async (req, res) => {
  const { faturamento_id } = req.params;
  const alocacoes = req.body.alocacoes;
  const userId = req.user.userId, userEmail = req.user.email;
  if (!Array.isArray(alocacoes)) return res.status(400).json({ success: false, message: 'Payload deve ser um array.' });

  for (const aloc of alocacoes) {
    // MODIFICAÇÃO AQUI: Permite quantidade_funcionarios >= 0
    if (aloc.setor_id === undefined || aloc.cargo_id === undefined || 
        aloc.quantidade_funcionarios === undefined || parseInt(String(aloc.quantidade_funcionarios), 10) < 0 || // Alterado de <=0 para <0
        aloc.total_horas_gastas_cargo === undefined || parseFloat(String(aloc.total_horas_gastas_cargo)) < 0) {
      // Mensagem de erro ajustada para refletir que >=0 é permitido para quantidade e horas
      return res.status(400).json({ success: false, message: 'Dados inválidos: setor, cargo são obrigatórios; quantidade e horas não podem ser negativas.' });
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const aloc of alocacoes) {
      const query = `
        INSERT INTO alocacao_esforco_cliente_cargo
          (faturamento_id, setor_id, cargo_id, quantidade_funcionarios, total_horas_gastas_cargo, registrado_por_usuario_id, data_registro)
        VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        ON CONFLICT (faturamento_id, setor_id, cargo_id) DO UPDATE SET
          quantidade_funcionarios = EXCLUDED.quantidade_funcionarios,
          total_horas_gastas_cargo = EXCLUDED.total_horas_gastas_cargo,
          registrado_por_usuario_id = EXCLUDED.registrado_por_usuario_id,
          data_registro = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        RETURNING *;`;
      const result = await client.query(query, [faturamento_id, aloc.setor_id, aloc.cargo_id, aloc.quantidade_funcionarios, aloc.total_horas_gastas_cargo, userId]);
      results.push(result.rows[0]);
    }
    await client.query('COMMIT');
    logAction(userId, userEmail, 'ALOCACAO_ESFORCO_SAVED_BATCH', 'AlocacaoEsforco', null, { faturamento_id, count: results.length });
    res.status(200).json({ success: true, message: `${results.length} alocações salvas para faturamento ${faturamento_id}!`, saved_alocacoes: results });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Erro POST /alocacao-esforco/faturamento/${faturamento_id}:`, error);
    logAction(userId, userEmail, 'ALOCACAO_ESFORCO_SAVE_BATCH_FAILED', 'AlocacaoEsforco', null, { faturamento_id, error: error.message });
    res.status(500).json({ success: false, message: 'Erro ao salvar alocações.' });
  } finally {
    client.release();
  }
});

// ROTA: Deletar uma alocação de esforço específica
router.delete('/:id_alocacao', auth, checkAccessPermission, async (req, res) => {
    const { id_alocacao } = req.params;
    const userId = req.user.userId, userEmail = req.user.email;
    try {
        const result = await pool.query('DELETE FROM alocacao_esforco_cliente_cargo WHERE id = $1 RETURNING *', [id_alocacao]);
        if (result.rowCount === 0) {
            logAction(userId, userEmail, 'ALOCACAO_ESFORCO_DELETE_NOT_FOUND', 'AlocacaoEsforco', id_alocacao);
            return res.status(404).json({ success: false, message: 'Alocação não encontrada.' });
        }
        logAction(userId, userEmail, 'ALOCACAO_ESFORCO_DELETED', 'AlocacaoEsforco', id_alocacao, { deletedData: result.rows[0] });
        res.status(200).json({ success: true, message: 'Alocação excluída.' });
    } catch (error) {
        console.error(`Erro DELETE /alocacao-esforco/${id_alocacao}:`, error);
        logAction(userId, userEmail, 'ALOCACAO_ESFORCO_DELETE_FAILED', 'AlocacaoEsforco', id_alocacao, { error: error.message });
        res.status(500).json({ success: false, message: 'Erro ao excluir alocação.' });
    }
});

module.exports = router;
