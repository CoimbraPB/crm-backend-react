const express = require('express');
const pool = require('../config/database');
const auth = require('../middleware/auth');

const router = express.Router();

// GET /crm-occurrences - Listar todas as ocorrências CRM
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
      data_registro: occurrence.data_registro ? occurrence.data_registro.toISOString().split('T')[0] : null,
      data_resolucao: occurrence.data_resolucao ? occurrence.data_resolucao.toISOString().split('T')[0] : null,
      created_at: occurrence.created_at ? occurrence.created_at.toISOString() : null,
    }));

    res.json(occurrences);
  } catch (error) {
    console.error('Erro ao listar ocorrências CRM:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// POST /crm-occurrences - Criar uma nova ocorrência CRM
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

    // Validação básica
    if (!data_registro || !cliente_id || !titulo_descricao || !descricao_apontamento ||
        !responsavel_interno || !acao_tomada || !acompanhamento_erica_operacional) {
      return res.status(400).json({ message: 'Todos os campos obrigatórios devem ser fornecidos' });
    }

    // Verificar se o cliente existe
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
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
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
        feedback_cliente || null
      ]
    );

    const newOccurrence = {
      ...result.rows[0],
      data_registro: result.rows[0].data_registro ? result.rows[0].data_registro.toISOString().split('T')[0] : null,
      data_resolucao: result.rows[0].data_resolucao ? result.rows[0].data_resolucao.toISOString().split('T')[0] : null,
      created_at: result.rows[0].created_at ? result.rows[0].created_at.toISOString() : null,
    };

    res.status(201).json(newOccurrence);
  } catch (error) {
    console.error('Erro ao criar ocorrência CRM:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// PUT /crm-occurrences/:id - Atualizar uma ocorrência CRM
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

    // Verificar se a ocorrência existe
    const occurrenceExists = await pool.query('SELECT id FROM ocorrencias_crm WHERE id = $1', [id]);
    if (occurrenceExists.rows.length === 0) {
      return res.status(404).json({ message: 'Ocorrência não encontrada' });
    }

    // Verificar se o cliente existe
    const clientExists = await pool.query('SELECT id FROM clientes WHERE id = $1', [cliente_id]);
    if (clientExists.rows.length === 0) {
      return res.status(400).json({ message: 'Cliente inválido' });
    }

    // Validação básica
    if (!data_registro || !cliente_id || !titulo_descricao || !descricao_apontamento ||
        !responsavel_interno || !acao_tomada || !acompanhamento_erica_operacional) {
      return res.status(400).json({ message: 'Todos os campos obrigatórios devem ser fornecidos' });
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
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $10
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
        id
      ]
    );

    const updatedOccurrence = {
      ...result.rows[0],
      data_registro: result.rows[0].data_registro ? result.rows[0].data_registro.toISOString().split('T')[0] : null,
      data_resolucao: result.rows[0].data_resolucao ? result.rows[0].data_resolucao.toISOString().split('T')[0] : null,
      created_at: result.rows[0].created_at ? result.rows[0].created_at.toISOString() : null,
    };

    res.json(updatedOccurrence);
  } catch (error) {
    console.error('Erro ao atualizar ocorrência CRM:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// DELETE /crm-occurrences/:id - Deletar uma ocorrência CRM
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query('DELETE FROM ocorrencias_crm WHERE id = $1 RETURNING id', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Ocorrência não encontrada' });
    }

    res.json(true);
  } catch (error) {
    console.error('Erro ao deletar ocorrência CRM:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

module.exports = router;