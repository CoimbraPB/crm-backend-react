const express = require('express');
const pool = require('../config/database');
const auth = require('../middleware/auth');

const router = express.Router();

// GET /api/clientes - Listar todos os clientes
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id, 
        codigo, 
        nome, 
        razao_social, 
        cpf_cnpj, 
        regime_fiscal, 
        situacao, 
        tipo_pessoa, 
        estado, 
        municipio, 
        status, 
        possui_ie, 
        ie, 
        filial, 
        empresa_matriz, 
        grupo, 
        segmento, 
        data_entrada, 
        data_saida, 
        sistema, 
        tipo_servico 
      FROM clientes
    `);
    
    // Converter datas para formato ISO e garantir que tipo_servico seja um array
    const clients = result.rows.map(client => ({
      ...client,
      data_entrada: client.data_entrada ? client.data_entrada.toISOString() : null,
      data_saida: client.data_saida ? client.data_saida.toISOString() : null,
      tipo_servico: client.tipo_servico || [], // Garantir que seja um array
    }));

    res.json({ success: true, data: clients });
  } catch (error) {
    console.error('Erro ao listar clientes:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// POST /api/clientes - Criar um novo cliente
router.post('/', auth, async (req, res) => {
  try {
    const {
      codigo, nome, razao_social, cpf_cnpj, regime_fiscal, situacao, tipo_pessoa,
      estado, municipio, status, possui_ie, ie, filial, empresa_matriz, grupo,
      segmento, data_entrada, data_saida, sistema, tipo_servico
    } = req.body;

    // Validação básica
    if (!codigo || !nome || !cpf_cnpj || !regime_fiscal || !situacao || !tipo_pessoa || !estado || !municipio || !status || !possui_ie || !segmento || !data_entrada || !sistema || !tipo_servico || !Array.isArray(tipo_servico)) {
      return res.status(400).json({
        success: false,
        message: 'Todos os campos obrigatórios devem ser fornecidos'
      });
    }

    // Validação de CPF/CNPJ
    if (!/^\d{11}$|^\d{14}$/.test(cpf_cnpj)) {
      return res.status(400).json({
        success: false,
        message: 'CPF/CNPJ inválido'
      });
    }

    // Validação de enums
    const validRegimeFiscal = ['Simples Nacional', 'Lucro Presumido', 'Lucro Real'];
    const validSituacao = ['Com movimento', 'Sem movimento'];
    const validTipoPessoa = ['Física', 'Jurídica'];
    const validStatus = ['Ativo', 'Inativo', 'Potencial', 'Bloqueado'];
    const validPossuiIe = ['Sim', 'Não', 'Isento'];
    const validSegmento = ['Comércio', 'Holding', 'Indústria', 'Locação', 'Produtor Rural', 'Serviço', 'Transporte'];
    const validSistema = ['Domínio', 'Protheus', 'Rodopar', 'Sap', 'Senio', 'Outros'];

    if (!validRegimeFiscal.includes(regime_fiscal)) {
      return res.status(400).json({
        success: false,
        message: 'Regime fiscal inválido'
      });
    }
    if (!validSituacao.includes(situacao)) {
      return res.status(400).json({
        success: false,
        message: 'Situação inválida'
      });
    }
    if (!validTipoPessoa.includes(tipo_pessoa)) {
      return res.status(400).json({
        success: false,
        message: 'Tipo de pessoa inválido'
      });
    }
    if (!validStatus.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Status inválido'
      });
    }
    if (!validPossuiIe.includes(possui_ie)) {
      return res.status(400).json({
        success: false,
        message: 'Possui I.E. inválido'
      });
    }
    if (!validSegmento.includes(segmento)) {
      return res.status(400).json({
        success: false,
        message: 'Segmento inválido'
      });
    }
    if (!validSistema.includes(sistema)) {
      return res.status(400).json({
        success: false,
        message: 'Sistema inválido'
      });
    }

    const result = await pool.query(
      `
      INSERT INTO clientes (
        codigo, nome, razao_social, cpf_cnpj, regime_fiscal, situacao, tipo_pessoa,
        estado, municipio, status, possui_ie, ie, filial, empresa_matriz, grupo,
        segmento, data_entrada, data_saida, sistema, tipo_servico
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      RETURNING *
      `,
      [
        codigo, nome, razao_social, cpf_cnpj, regime_fiscal, situacao, tipo_pessoa,
        estado, municipio, status, possui_ie, ie, filial, empresa_matriz, grupo,
        segmento, data_entrada, data_saida || null, sistema, JSON.stringify(tipo_servico)
      ]
    );

    const newClient = {
      ...result.rows[0],
      data_entrada: result.rows[0].data_entrada ? result.rows[0].data_entrada.toISOString() : null,
      data_saida: result.rows[0].data_saida ? result.rows[0].data_saida.toISOString() : null,
      tipo_servico: result.rows[0].tipo_servico || [],
    };

    res.status(201).json({ success: true, data: newClient });
  } catch (error) {
    console.error('Erro ao criar cliente:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// PUT /api/clientes/:id - Atualizar um cliente
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      codigo, nome, razao_social, cpf_cnpj, regime_fiscal, situacao, tipo_pessoa,
      estado, municipio, status, possui_ie, ie, filial, empresa_matriz, grupo,
      segmento, data_entrada, data_saida, sistema, tipo_servico
    } = req.body;

    // Verificar se o cliente existe
    const clientExists = await pool.query('SELECT id FROM clientes WHERE id = $1', [id]);
    if (clientExists.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Cliente não encontrado'
      });
    }

    // Validação básica (igual ao POST)
    if (!codigo || !nome || !cpf_cnpj || !regime_fiscal || !situacao || !tipo_pessoa || !estado || !municipio || !status || !possui_ie || !segmento || !data_entrada || !sistema || !tipo_servico || !Array.isArray(tipo_servico)) {
      return res.status(400).json({
        success: false,
        message: 'Todos os campos obrigatórios devem ser fornecidos'
      });
    }

    // Validação de CPF/CNPJ
    if (!/^\d{11}$|^\d{14}$/.test(cpf_cnpj)) {
      return res.status(400).json({
        success: false,
        message: 'CPF/CNPJ inválido'
      });
    }

    // Validação de enums (repetir as mesmas do POST)
    const validRegimeFiscal = ['Simples Nacional', 'Lucro Presumido', 'Lucro Real'];
    const validSituacao = ['Com movimento', 'Sem movimento'];
    const validTipoPessoa = ['Física', 'Jurídica'];
    const validStatus = ['Ativo', 'Inativo', 'Potencial', 'Bloqueado'];
    const validPossuiIe = ['Sim', 'Não', 'Isento'];
    const validSegmento = ['Comércio', 'Holding', 'Indústria', 'Locação', 'Produtor Rural', 'Serviço', 'Transporte'];
    const validSistema = ['Domínio', 'Protheus', 'Rodopar', 'Sap', 'Senio', 'Outros'];

    if (!validRegimeFiscal.includes(regime_fiscal)) {
      return res.status(400).json({
        success: false,
        message: 'Regime fiscal inválido'
      });
    }
    if (!validSituacao.includes(situacao)) {
      return res.status(400).json({
        success: false,
        message: 'Situação inválida'
      });
    }
    if (!validTipoPessoa.includes(tipo_pessoa)) {
      return res.status(400).json({
        success: false,
        message: 'Tipo de pessoa inválido'
      });
    }
    if (!validStatus.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Status inválido'
      });
    }
    if (!validPossuiIe.includes(possui_ie)) {
      return res.status(400).json({
        success: false,
        message: 'Possui I.E. inválido'
      });
    }
    if (!validSegmento.includes(segmento)) {
      return res.status(400).json({
        success: false,
        message: 'Segmento inválido'
      });
    }
    if (!validSistema.includes(sistema)) {
      return res.status(400).json({
        success: false,
        message: 'Sistema inválido'
      });
    }

    const result = await pool.query(
      `
      UPDATE clientes 
      SET 
        codigo = $1, 
        nome = $2, 
        razao_social = $3, 
        cpf_cnpj = $4, 
        regime_fiscal = $5, 
        situacao = $6, 
        tipo_pessoa = $7, 
        estado = $8, 
        municipio = $9, 
        status = $10, 
        possui_ie = $11, 
        ie = $12, 
        filial = $13, 
        empresa_matriz = $14, 
        grupo = $15, 
        segmento = $16, 
        data_entrada = $17, 
        data_saida = $18, 
        sistema = $19, 
        tipo_servico = $20,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $21
      RETURNING *
      `,
      [
        codigo, nome, razao_social, cpf_cnpj, regime_fiscal, situacao, tipo_pessoa,
        estado, municipio, status, possui_ie, ie, filial, empresa_matriz, grupo,
        segmento, data_entrada, data_saida || null, sistema, JSON.stringify(tipo_servico), id
      ]
    );

    const updatedClient = {
      ...result.rows[0],
      data_entrada: result.rows[0].data_entrada ? result.rows[0].data_entrada.toISOString() : null,
      data_saida: result.rows[0].data_saida ? result.rows[0].data_saida.toISOString() : null,
      tipo_servico: result.rows[0].tipo_servico || [],
    };

    res.json({ success: true, data: updatedClient });
  } catch (error) {
    console.error('Erro ao atualizar cliente:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// DELETE /api/clientes/:id - Deletar um cliente
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query('DELETE FROM clientes WHERE id = $1 RETURNING id', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Cliente não encontrado'
      });
    }

    res.json({ success: true, message: 'Cliente deletado com sucesso' });
  } catch (error) {
    console.error('Erro ao deletar cliente:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

module.exports = router;