const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const authMiddleware = require('../middleware/auth');

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
        responsavel_email, responsavel_data, cliente_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      RETURNING id
    `;
    const values = [
      data_ocorrencia, setor, descricao, valor_desconto || null, tipo_desconto || null,
      colaborador_nome || null, colaborador_cargo || null, advertido || null,
      tipo_advertencia || null, advertencia_outra || null, cliente_comunicado || null,
      meio_comunicacao || null, comunicacao_outro || null, acoes_imediatas || null,
      acoes_corretivas || null, acoes_preventivas || null, responsavel_email, responsavel_data, cliente_id || null
    ];

    const result = await pool.query(query, values);
    res.status(201).json({ id: result.rows[0].id, message: 'Ocorrência criada com sucesso' });
  } catch (err) {
    console.error('Error creating occurrence:', err.stack);
    res.status(500).json({ message: 'Erro ao criar ocorrência', error: err.message });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const result = await pool.query(
      'UPDATE ocorrencias SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Ocorrência não encontrada' });
    }
    res.json({ message: 'Status atualizado com sucesso', data: result.rows[0] });
  } catch (err) {
    console.error('Error updating occurrence:', err.stack);
    res.status(500).json({ message: 'Erro ao atualizar ocorrência', error: err.message });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM ocorrencias WHERE id = $1 RETURNING *', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Ocorrência não encontrada' });
    }
    res.json({ message: 'Ocorrência excluída com sucesso' });
  } catch (err) {
    console.error('Error deleting occurrence:', err.stack);
    res.status(500).json({ message: 'Erro ao excluir ocorrência', error: err.message });
  }
});

module.exports = router;