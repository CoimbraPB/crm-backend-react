const express = require('express');
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');

const router = express.Router();

// Função auxiliar para validar formato de data (YYYY-MM-DD)
const isValidDate = (dateString) => {
  if (!dateString) return true; // Permite nulo
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateString)) return false;
  return true; // Simplificado para aceitar qualquer data válida no formato
};

// Função auxiliar para converter data para DD-MM-YYYY
const toResponseDate = (date) => {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null; // Evita Invalid Date
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
};

// GET /crm-occurrences
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id,
        data_registro,
        cliente_id,
        titulo_descricao,
        descricao_apontamento,
        responsavel_interno,
        acao_tomada,
        acompanhamento_erica_operacional,
        data_resolucao,
        feedback_cliente,
        created_at
      FROM ocorrencias_crm
      ORDER BY created_at DESC
    `);

    const occurrences = result.rows.map(occurrence => ({
      ...occurrence,
      data_registro: toResponseDate(occurrence.data_registro),
      data_resolucao: toResponseDate(occurrence.data_resolucao),
      created_at: occurrence.created_at ? new Date(occurrence.created_at).toISOString() : null,
    }));

    res.json(occurrences);
  } catch (error) {
    console.error('Erro ao listar ocorrências CRM:', error.message, error.stack);
    res.status(500).json({ message: 'Erro interno do servidor ao listar ocorrências' });
  }
});

// POST /crm-occurrences
router.post('/', auth, async (req, res) => {
  try {
    const {
      data_registro,
      cliente_id,
      titulo_descricao,
      descricao_apontamento,
      responsavel_interno,
      acao_tomada,
      acompanhamento_erica_operacional,
      data_resolucao,
      feedback_cliente
    } = req.body;

    if (!data_registro || !cliente_id || !titulo_descricao || !descricao_apontamento ||
        !responsavel_interno || !acao_tomada || !acompanhamento_erica_operacional) {
      return res.status(400).json({ message: 'Todos os campos obrigatórios devem ser fornecidos' });
    }

    if (!isValidDate(data_registro)) {
      return res.status(400).json({ message: 'Formato de data_registro inválido (use YYYY-MM-DD)' });
    }
    if (data_resolucao && !isValidDate(data_resolucao)) {
      return res.status(400).json({ message: 'Formato de data_resolucao inválido (use YYYY-MM-DD)' });
    }
    if (!Number.isInteger(Number(cliente_id)) || Number(cliente_id) <= 0) {
      return res.status(400).json({ message: 'cliente_id deve ser um número inteiro positivo' });
    }
    if (titulo_descricao.length > 255) {
      return res.status(400).json({ message: 'titulo_descricao deve ter no máximo 255 caracteres' });
    }
    if (responsavel_interno.length > 100) {
      return res.status(400).json({ message: 'responsavel_interno deve ter no máximo 100 caracteres' });
    }

    const clientExists = await pool.query('SELECT id FROM clientes WHERE id = $1', [cliente_id]);
    if (clientExists.rows.length === 0) {
      return res.status(400).json({ message: 'Cliente inválido' });
    }

    const result = await pool.query(
      `
      INSERT INTO ocorrencias_crm (
        data_registro,
        cliente_id,
        titulo_descricao,
        descricao_apontamento,
        responsavel_interno,
        acao_tomada,
        acompanhamento_erica_operacional,
        data_resolucao,
        feedback_cliente,
        created_at,
        created_by_user_id,
        updated_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, $10, $10)
      RETURNING *
      `,
      [
        data_registro,
        cliente_id,
        titulo_descricao,
        descricao_apontamento,
        responsavel_interno,
        acao_tomada,
        acompanhamento_erica_operacional,
        data_resolucao || null,
        feedback_cliente || null,
        req.user.userId // for created_by_user_id and updated_by_user_id
      ]
    );

    const newOccurrence = {
      ...result.rows[0],
      data_registro: toResponseDate(result.rows[0].data_registro),
      data_resolucao: toResponseDate(result.rows[0].data_resolucao),
      created_at: result.rows[0].created_at ? new Date(result.rows[0].created_at).toISOString() : null,
    };

    // Audit log
    await logAction(
      req.user.userId,
      req.user.email,
      ACTION_TYPES.CRM_OCCURRENCE_CREATED,
      ENTITY_TYPES.CRM_OCCURRENCE,
      newOccurrence.id,
      { occurrenceData: { ...newOccurrence, created_by_user_id: req.user.userId, updated_by_user_id: req.user.userId } }
    );

    res.status(201).json(newOccurrence);
  } catch (error) {
    console.error('Erro ao criar ocorrência CRM:', error.message, error.stack);
    await logAction(
      req.user?.userId,
      req.user?.email,
      ACTION_TYPES.SYSTEM_ERROR,
      ENTITY_TYPES.CRM_OCCURRENCE,
      null,
      { error: error.message, details: 'Failed to create CRM occurrence', requestBody: req.body }
    );
    if (error.code === '23502') {
      return res.status(400).json({ message: `Campo obrigatório ausente: ${error.column}` });
    }
    if (error.code === '23503') {
      return res.status(400).json({ message: 'Cliente inválido (chave estrangeira)' });
    }
    if (error.code === '23505') {
      return res.status(400).json({ message: 'ID duplicado na ocorrência' });
    }
    res.status(500).json({ message: `Erro interno do servidor ao criar ocorrência: ${error.message}` });
  }
});

// PUT /crm-occurrences/:id
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      data_registro,
      cliente_id,
      titulo_descricao,
      descricao_apontamento,
      responsavel_interno,
      acao_tomada,
      acompanhamento_erica_operacional,
      data_resolucao,
      feedback_cliente
    } = req.body;

    if (!cliente_id || !titulo_descricao || !descricao_apontamento ||
        !responsavel_interno || !acao_tomada || !acompanhamento_erica_operacional) {
      return res.status(400).json({ message: 'Campos obrigatórios (exceto data_registro) devem ser fornecidos' });
    }

    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
      return res.status(400).json({ message: 'ID da ocorrência deve ser um número inteiro positivo' });
    }

    if (data_registro && !isValidDate(data_registro)) {
      return res.status(400).json({ message: 'Formato de data_registro inválido (use YYYY-MM-DD)' });
    }
    if (data_resolucao && !isValidDate(data_resolucao)) {
      return res.status(400).json({ message: 'Formato de data_resolucao inválido (use YYYY-MM-DD)' });
    }
    if (!Number.isInteger(Number(cliente_id)) || Number(cliente_id) <= 0) {
      return res.status(400).json({ message: 'cliente_id deve ser um número inteiro positivo' });
    }
    if (titulo_descricao.length > 255) {
      return res.status(400).json({ message: 'titulo_descricao deve ter no máximo 255 caracteres' });
    }
    if (responsavel_interno.length > 100) {
      return res.status(400).json({ message: 'responsavel_interno deve ter no máximo 100 caracteres' });
    }

    const occurrenceExistsResult = await pool.query('SELECT * FROM ocorrencias_crm WHERE id = $1', [id]);
    if (occurrenceExistsResult.rows.length === 0) {
      return res.status(404).json({ message: 'Ocorrência não encontrada' });
    }
    const oldOccurrenceData = occurrenceExistsResult.rows[0];
    const existingDataRegistro = oldOccurrenceData.data_registro;


    const clientExists = await pool.query('SELECT id FROM clientes WHERE id = $1', [cliente_id]);
    if (clientExists.rows.length === 0) {
      return res.status(400).json({ message: 'Cliente inválido' });
    }

    const result = await pool.query(
      `
      UPDATE ocorrencias_crm
      SET
        data_registro = $1,
        cliente_id = $2,
        titulo_descricao = $3,
        descricao_apontamento = $4,
        responsavel_interno = $5,
        acao_tomada = $6,
        acompanhamento_erica_operacional = $7,
        data_resolucao = $8,
        feedback_cliente = $9,
        updated_by_user_id = $11 
      WHERE id = $10
      RETURNING *
      `,
      [
        data_registro || existingDataRegistro,
        cliente_id,
        titulo_descricao,
        descricao_apontamento,
        responsavel_interno,
        acao_tomada,
        acompanhamento_erica_operacional,
        data_resolucao || null,
        feedback_cliente || null,
        id,
        req.user.userId // for updated_by_user_id
      ]
    );

    const updatedOccurrence = {
      ...result.rows[0],
      data_registro: toResponseDate(result.rows[0].data_registro),
      data_resolucao: toResponseDate(result.rows[0].data_resolucao),
      created_at: result.rows[0].created_at ? new Date(result.rows[0].created_at).toISOString() : null,
    };

    // Audit log
    await logAction(
      req.user.userId,
      req.user.email,
      ACTION_TYPES.CRM_OCCURRENCE_UPDATED,
      ENTITY_TYPES.CRM_OCCURRENCE,
      updatedOccurrence.id,
      { oldData: oldOccurrenceData, newData: { ...updatedOccurrence, updated_by_user_id: req.user.userId } }
    );

    res.json(updatedOccurrence);
  } catch (error) {
    console.error('Erro ao atualizar ocorrência CRM:', error.message, error.stack);
    await logAction(
      req.user?.userId,
      req.user?.email,
      ACTION_TYPES.SYSTEM_ERROR,
      ENTITY_TYPES.CRM_OCCURRENCE,
      req.params.id,
      { error: error.message, details: 'Failed to update CRM occurrence', requestBody: req.body }
    );
    if (error.code === '23502') {
      return res.status(400).json({ message: `Campo obrigatório ausente: ${error.column}` });
    }
    if (error.code === '23503') {
      return res.status(400).json({ message: 'Cliente inválido (chave estrangeira)' });
    }
    if (error.code === '22P02') {
      return res.status(400).json({ message: 'Formato de dado inválido (verifique datas ou números)' });
    }
    res.status(500).json({ message: `Erro interno do servidor ao atualizar ocorrência: ${error.message}` });
  }
});

// DELETE /crm-occurrences/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
      return res.status(400).json({ message: 'ID da ocorrência deve ser um número inteiro positivo' });
    }

    const occurrenceToDeleteResult = await pool.query('SELECT * FROM ocorrencias_crm WHERE id = $1', [id]);
    if (occurrenceToDeleteResult.rows.length === 0) {
      return res.status(404).json({ message: 'Ocorrência não encontrada' });
    }
    const occurrenceToDeleteData = occurrenceToDeleteResult.rows[0];

    await pool.query('DELETE FROM ocorrencias_crm WHERE id = $1', [id]);

    // Audit log
    await logAction(
      req.user.userId,
      req.user.email,
      ACTION_TYPES.CRM_OCCURRENCE_DELETED,
      ENTITY_TYPES.CRM_OCCURRENCE,
      id,
      { deletedData: occurrenceToDeleteData }
    );

    res.json(true);
  } catch (error) {
    console.error('Erro ao deletar ocorrência CRM:', error.message, error.stack);
    await logAction(
      req.user?.userId,
      req.user?.email,
      ACTION_TYPES.SYSTEM_ERROR,
      ENTITY_TYPES.CRM_OCCURRENCE,
      req.params.id,
      { error: error.message, details: 'Failed to delete CRM occurrence' }
    );
    res.status(500).json({ message: `Erro interno do servidor ao deletar ocorrência: ${error.message}` });
  }
});

module.exports = router;