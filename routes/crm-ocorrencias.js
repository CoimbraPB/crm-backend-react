const express = require('express');
const pool = require('../config/database');
const auth = require('../middleware/auth');

const router = express.Router();

// Função auxiliar para validar formato de data (YYYY-MM-DD)
const isValidDate = (dateString) => {
  if (!dateString) return true; // Permite nulo para campos opcionais
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateString)) return false;
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date);
};

// Função auxiliar para converter YYYY-MM-DD para DD-MM-YYYY (formato de resposta)
const toResponseDate = (date) => {
  if (!date) return null;
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
};

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
      data_registro: toResponseDate(occurrence.data_registro),
      data_resolucao: toResponseDate(occurrence.data_resolucao),
      created_at: occurrence.created_at ? new Date(occurrence.created_at).toISOString() : null,
    }));

    res.json(occurrences);
  } catch (error) {
    console.error('Erro ao listar ocorrências CRM:', error);
    res.status(500).json({ message: 'Erro interno do servidor ao listar ocorrências' });
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

    // Validação dos campos obrigatórios
    if (!data_registro || !cliente_id || !titulo_descricao || !descricao_apontamento ||
        !responsavel_interno || !acao_tomada || !acompanhamento_erica_operacional) {
      return res.status(400).json({ message: 'Todos os campos obrigatórios devem ser fornecidos' });
    }

    // Validação de tipos e formatos
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
      data_registro: toResponseDate(result.rows[0].data_registro),
      data_resolucao: toResponseDate(result.rows[0].data_resolucao),
      created_at: result.rows[0].created_at ? new Date(result.rows[0].created_at).toISOString() : null,
    };

    res.status(201).json(newOccurrence);
  } catch (error) {
    console.error('Erro ao criar ocorrência CRM:', error.message, error.stack);
    res.status(500).json({ message: `Erro interno do servidor ao criar ocorrência: ${error.message}` });
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

    // Validação dos campos obrigatórios
    if (!data_registro || !cliente_id || !titulo_descricao || !descricao_apontamento ||
        !responsavel_interno || !acao_tomada || !acompanhamento_erica_operacional) {
      return res.status(400).json({ message: 'Todos os campos obrigatórios devem ser fornecidos' });
    }

    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
      return res.status(400).json({ message: 'ID da ocorrência deve ser um número inteiro positivo' });
    }

    // Validação de tipos e formatos
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
      data_registro: toResponseDate(result.rows[0].data_registro),
      data_resolucao: toResponseDate(result.rows[0].data_resolucao),
      created_at: result.rows[0].created_at ? new Date(result.rows[0].created_at).toISOString() : null,
    };

    res.json(updatedOccurrence);
  } catch (error) {
    console.error('Erro ao atualizar ocorrência CRM:', error.message, error.stack);
    res.status(500).json({ message: `Erro interno do servidor ao atualizar ocorrência: ${error.message}` });
  }
});

// DELETE /crm-occurrences/:id - Deletar uma ocorrência CRM
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
      return res.status(400).json({ message: 'ID da ocorrência deve ser um número inteiro positivo' });
    }

    const result = await pool.query('DELETE FROM ocorrencias_crm WHERE id = $1 RETURNING id', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Ocorrência não encontrada' });
    }

    res.json(true);
  } catch (error) {
    console.error('Erro ao deletar ocorrência CRM:', error.message, error.stack);
    res.status(500).json({ message: `Erro interno do servidor ao deletar ocorrência: ${error.message}` });
  }
});

module.exports = router;