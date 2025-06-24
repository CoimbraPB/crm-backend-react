const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const authMiddleware = require('../middleware/auth');
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');

router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*, c.nome, c.codigo
      FROM ocorrencias o
      LEFT JOIN clientes c ON o.cliente_id = c.id
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching occurrences:', err.stack);
    res.status(500).json({ message: 'Erro ao buscar ocorrências', error: err.message });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  const {
    data_ocorrencia, setor, descricao, valor_desconto, tipo_desconto, colaborador_nome,
    colaborador_cargo, advertido, tipo_advertencia, advertencia_outra, cliente_comunicado,
    meio_comunicacao, comunicacao_outro, acoes_imediatas, acoes_corretivas, acoes_preventivas,
    responsavel_email, responsavel_data, cliente_id
  } = req.body;

  try {
    const query = `
      INSERT INTO ocorrencias (
        data_ocorrencia, setor, descricao, valor_desconto, tipo_desconto, colaborador_nome,
        colaborador_cargo, advertido, tipo_advertencia, advertencia_outra, cliente_comunicado,
        meio_comunicacao, comunicacao_outro, acoes_imediatas, acoes_corretivas, acoes_preventivas,
        responsavel_email, responsavel_data, cliente_id, created_by_user_id, updated_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $20)
      RETURNING * 
    `;
    const values = [
      data_ocorrencia, setor, descricao, valor_desconto || null, tipo_desconto || null,
      colaborador_nome || null, colaborador_cargo || null, advertido || null,
      tipo_advertencia || null, advertencia_outra || null, cliente_comunicado || null,
      meio_comunicacao || null, comunicacao_outro || null, acoes_imediatas || null,
      acoes_corretivas || null, acoes_preventivas || null, responsavel_email, responsavel_data, cliente_id || null,
      req.user.userId // for created_by_user_id and updated_by_user_id
    ];

    const result = await pool.query(query, values);
    const newOccurrence = result.rows[0];

    // Audit log
    await logAction(
      req.user.userId,
      req.user.email,
      ACTION_TYPES.GESTOR_OCCURRENCE_CREATED,
      ENTITY_TYPES.GESTOR_OCCURRENCE,
      newOccurrence.id,
      { occurrenceData: newOccurrence }
    );

    res.status(201).json({ id: newOccurrence.id, message: 'Ocorrência criada com sucesso', data: newOccurrence });
  } catch (err) {
    console.error('Error creating occurrence:', err.stack);
    await logAction(
      req.user?.userId,
      req.user?.email,
      ACTION_TYPES.SYSTEM_ERROR,
      ENTITY_TYPES.GESTOR_OCCURRENCE,
      null,
      { error: err.message, details: 'Failed to create Gestor occurrence', requestBody: req.body }
    );
    res.status(500).json({ message: 'Erro ao criar ocorrência', error: err.message });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { status, ...otherUpdateData } = req.body; // Assuming other fields might be updatable in the future

  try {
    const oldOccurrenceResult = await pool.query('SELECT * FROM ocorrencias WHERE id = $1', [id]);
    if (oldOccurrenceResult.rows.length === 0) {
      return res.status(404).json({ message: 'Ocorrência não encontrada' });
    }
    const oldOccurrenceData = oldOccurrenceResult.rows[0];

    // For now, only status is updated. If other fields are added, they should be part of the SET clause.
    // Make sure to list all updatable fields explicitly if more are added.
    const result = await pool.query(
      'UPDATE ocorrencias SET status = $1, updated_by_user_id = $2 WHERE id = $3 RETURNING *',
      [status, req.user.userId, id]
    );
    
    const updatedOccurrence = result.rows[0];

    // Audit log
    await logAction(
      req.user.userId,
      req.user.email,
      ACTION_TYPES.GESTOR_OCCURRENCE_UPDATED,
      ENTITY_TYPES.GESTOR_OCCURRENCE,
      updatedOccurrence.id,
      { oldData: oldOccurrenceData, newData: updatedOccurrence }
    );

    res.json({ message: 'Status atualizado com sucesso', data: updatedOccurrence });
  } catch (err) {
    console.error('Error updating occurrence:', err.stack);
    await logAction(
      req.user?.userId,
      req.user?.email,
      ACTION_TYPES.SYSTEM_ERROR,
      ENTITY_TYPES.GESTOR_OCCURRENCE,
      id,
      { error: err.message, details: 'Failed to update Gestor occurrence', requestBody: req.body }
    );
    res.status(500).json({ message: 'Erro ao atualizar ocorrência', error: err.message });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    const occurrenceToDeleteResult = await pool.query('SELECT * FROM ocorrencias WHERE id = $1', [id]);
    if (occurrenceToDeleteResult.rows.length === 0) {
      return res.status(404).json({ message: 'Ocorrência não encontrada' });
    }
    const occurrenceToDeleteData = occurrenceToDeleteResult.rows[0];

    await pool.query('DELETE FROM ocorrencias WHERE id = $1', [id]);

    // Audit log
    await logAction(
      req.user.userId,
      req.user.email,
      ACTION_TYPES.GESTOR_OCCURRENCE_DELETED,
      ENTITY_TYPES.GESTOR_OCCURRENCE,
      id,
      { deletedData: occurrenceToDeleteData }
    );

    res.json({ message: 'Ocorrência excluída com sucesso' });
  } catch (err) {
    console.error('Error deleting occurrence:', err.stack);
    await logAction(
      req.user?.userId,
      req.user?.email,
      ACTION_TYPES.SYSTEM_ERROR,
      ENTITY_TYPES.GESTOR_OCCURRENCE,
      id,
      { error: err.message, details: 'Failed to delete Gestor occurrence' }
    );
    res.status(500).json({ message: 'Erro ao excluir ocorrência', error: err.message });
  }
});

module.exports = router;