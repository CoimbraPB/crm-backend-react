const express = require('express');
const router = express.Router();
const db = require('../models/Occurrence');
const authMiddleware = require('../middleware/auth');

router.get('/', authMiddleware, (req, res) => {
  db.all('SELECT * FROM gestor_occurrences', [], (err, rows) => {
    if (err) return res.status(500).json({ message: 'Erro ao buscar ocorrências', error: err.message });
    res.json(rows);
  });
});

router.post('/', authMiddleware, (req, res) => {
  const {
    data_ocorrencia, setor, descricao, valor_desconto, tipo_desconto, colaborador_nome,
    colaborador_cargo, advertido, tipo_advertencia, advertencia_outra, cliente_comunicado,
    meio_comunicacao, comunicacao_outro, acoes_imediatas, acoes_corretivas, acoes_preventivas,
    responsavel_email, responsavel_data, cliente_id
  } = req.body;

  const query = `
    INSERT INTO gestor_occurrences (
      data_ocorrencia, setor, descricao, valor_desconto, tipo_desconto, colaborador_nome,
      colaborador_cargo, advertido, tipo_advertencia, advertencia_outra, cliente_comunicado,
      meio_comunicacao, comunicacao_outro, acoes_imediatas, acoes_corretivas, acoes_preventivas,
      responsavel_email, responsavel_data, cliente_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.run(query, [
    data_ocorrencia, setor, descricao, valor_desconto || null, tipo_desconto || null,
    colaborador_nome || null, colaborador_cargo || null, advertido || null,
    tipo_advertencia || null, advertencia_outra || null, cliente_comunicado || null,
    meio_comunicacao || null, comunicacao_outro || null, acoes_imediatas || null,
    acoes_corretivas || null, acoes_preventivas || null, responsavel_email, responsavel_data, cliente_id || null
  ], function(err) {
    if (err) return res.status(500).json({ message: 'Erro ao criar ocorrência', error: err.message });
    res.status(201).json({ id: this.lastID, message: 'Ocorrência criada com sucesso' });
  });
});

router.put('/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  db.run('UPDATE gestor_occurrences SET status = ? WHERE id = ?', [status, id], (err) => {
    if (err) return res.status(500).json({ message: 'Erro ao atualizar ocorrência', error: err.message });
    res.json({ message: 'Status atualizado com sucesso' });
  });
});

router.delete('/:id', authMiddleware, (req, res) => {
  const { id } = req.params;

  db.run('DELETE FROM gestor_occurrences WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).json({ message: 'Erro ao excluir ocorrência', error: err.message });
    res.json({ message: 'Ocorrência excluída com sucesso' });
  });
});

module.exports = router;