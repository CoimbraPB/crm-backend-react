const express = require('express');
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');

const router = express.Router();

// GET /clients - Listar todos os clientes
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
        tipo_servico, 
        created_at,
        resp_fiscal,
        resp_contabil,
        resp_dp
      FROM clientes
    `);

    const clients = result.rows.map(client => ({
      ...client,
      data_entrada: client.data_entrada ? client.data_entrada.toISOString() : null,
      data_saida: client.data_saida ? client.data_saida.toISOString() : null, // Corrigido
      tipo_servico: client.tipo_servico || [],
      created_at: client.created_at ? client.created_at.toISOString() : null,
    }));

    res.json(clients);
  } catch (error) {
    console.error('Erro ao listar clientes:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// POST /clients - Criar um novo cliente
router.post('/', auth, async (req, res) => {
  try {
    const {
      codigo, nome, razao_social, cpf_cnpj, regime_fiscal, situacao, tipo_pessoa,
      estado, municipio, status, possui_ie, ie, filial, empresa_matriz, grupo,
      segmento, data_entrada, data_saida, sistema, tipo_servico,
      resp_fiscal, resp_contabil, resp_dp 
    } = req.body;

    // Validação básica
    if (!codigo || !nome || !razao_social || !cpf_cnpj || !regime_fiscal || !situacao || 
        !tipo_pessoa || !estado || !municipio || !status || !possui_ie || !segmento || 
        !data_entrada || !sistema || !tipo_servico || !Array.isArray(tipo_servico)) {
      return res.status(400).json({ message: 'Todos os campos obrigatórios devem ser fornecidos' });
    }

    // Validação de CPF/CNPJ
    if (!/^\d{11}$|^\d{14}$/.test(cpf_cnpj)) {
      return res.status(400).json({ message: 'CPF/CNPJ inválido' });
    }

    // Validação de enums
    const validRegimeFiscal = ['Simples Nacional', 'Lucro Presumido', 'Lucro Real'];
    const validSituacao = ['Com movimento', 'Sem movimento'];
    const validTipoPessoa = ['Física', 'Jurídica'];
    const validStatus = ['Ativo', 'Inativo', 'Potencial', 'Bloqueado'];
    const validPossuiIe = ['Sim', 'Não', 'Isento'];
    const validSegmento = ['Comércio', 'Holding', 'Indústria', 'Locação', 'Produtor Rural', 'Serviço', 'Transporte'];
    const validSistema = ['Domínio', 'Protheus', 'Rodopar', 'Sap', 'Senior', 'Outros'];

    if (!validRegimeFiscal.includes(regime_fiscal)) {
      return res.status(400).json({ message: 'Regime fiscal inválido' });
    }
    if (!validSituacao.includes(situacao)) {
      return res.status(400).json({ message: 'Situação inválida' });
    }
    if (!validTipoPessoa.includes(tipo_pessoa)) {
      return res.status(400).json({ message: 'Tipo de pessoa inválido' });
    }
    if (!validStatus.includes(status)) {
      return res.status(400).json({ message: 'Status inválido' });
    }
    if (!validPossuiIe.includes(possui_ie)) {
      return res.status(400).json({ message: 'Possui I.E. inválido' });
    }
    if (!validSegmento.includes(segmento)) {
      return res.status(400).json({ message: 'Segmento inválido' });
    }
    if (!validSistema.includes(sistema)) {
      return res.status(400).json({ message: 'Sistema inválido' });
    }

    const result = await pool.query(
      `
      INSERT INTO clientes (
        codigo, nome, razao_social, cpf_cnpj, regime_fiscal, situacao, tipo_pessoa,
        estado, municipio, status, possui_ie, ie, filial, empresa_matriz, grupo,
        segmento, data_entrada, data_saida, sistema, tipo_servico, 
        resp_fiscal, resp_contabil, resp_dp, 
        created_at, created_by_user_id, updated_by_user_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, CURRENT_TIMESTAMP, $24, $24)
      RETURNING *
      `,
      [
        codigo, nome, razao_social, cpf_cnpj, regime_fiscal, situacao, tipo_pessoa,
        estado, municipio, status, possui_ie, ie, filial, empresa_matriz, grupo,
        segmento, data_entrada, data_saida || null, sistema, JSON.stringify(tipo_servico),
        resp_fiscal, resp_contabil, resp_dp,
        req.user.userId // For created_by_user_id and updated_by_user_id
      ]
    );

    const newClient = {
      ...result.rows[0],
      data_entrada: result.rows[0].data_entrada ? result.rows[0].data_entrada.toISOString() : null,
      data_saida: result.rows[0].data_saida ? result.rows[0].data_saida.toISOString() : null,
      tipo_servico: result.rows[0].tipo_servico || [],
      created_at: result.rows[0].created_at ? result.rows[0].created_at.toISOString() : null,
    };

    // Audit log
    await logAction(
      req.user.userId,
      req.user.email,
      ACTION_TYPES.CLIENT_CREATED,
      ENTITY_TYPES.CLIENT,
      newClient.id,
    { clientData: { ...newClient, created_by_user_id: req.user.userId, updated_by_user_id: req.user.userId } }
    );

    res.status(201).json(newClient);
  } catch (error) {
    console.error('Erro ao criar cliente:', error);
    await logAction(
      req.user?.userId,
      req.user?.email,
      ACTION_TYPES.SYSTEM_ERROR,
      ENTITY_TYPES.CLIENT,
      null,
      { error: error.message, details: 'Failed to create client', requestBody: req.body }
    );
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// PUT /clients/:id - Atualizar um cliente
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      codigo, nome, razao_social, cpf_cnpj, regime_fiscal, situacao, tipo_pessoa,
      estado, municipio, status, possui_ie, ie, filial, empresa_matriz, grupo,
      segmento, data_entrada, data_saida, sistema, tipo_servico,
      resp_fiscal, resp_contabil, resp_dp
    } = req.body; // Removido tipo_pessoa duplicado

    // Verificar se o cliente existe
    const clientExistsResult = await pool.query('SELECT * FROM clientes WHERE id = $1', [id]);
    if (clientExistsResult.rows.length === 0) {
      return res.status(404).json({ message: 'Cliente não encontrado' });
    }
    const oldClientData = clientExistsResult.rows[0];

    // Validação básica
    if (!codigo || !nome || !razao_social || !cpf_cnpj || !regime_fiscal || !situacao || 
        !tipo_pessoa || !estado || !municipio || !status || !possui_ie || !segmento || 
        !data_entrada || !sistema || !tipo_servico || !Array.isArray(tipo_servico)) {
      return res.status(400).json({ message: 'Todos os campos obrigatórios devem ser fornecidos' });
    }

    // Validação de CPF/CNPJ
    if (!/^\d{11}$|^\d{14}$/.test(cpf_cnpj)) {
      return res.status(400).json({ message: 'CPF/CNPJ inválido' });
    }

    // Validação de enums
    const validRegimeFiscal = ['Simples Nacional', 'Lucro Presumido', 'Lucro Real'];
    const validSituacao = ['Com movimento', 'Sem movimento'];
    const validTipoPessoa = ['Física', 'Jurídica'];
    const validStatus = ['Ativo', 'Inativo', 'Potencial', 'Bloqueado'];
    const validPossuiIe = ['Sim', 'Não', 'Isento'];
    const validSegmento = ['Comércio', 'Holding', 'Indústria', 'Locação', 'Produtor Rural', 'Serviço', 'Transporte'];
    const validSistema = ['Domínio', 'Protheus', 'Rodopar', 'Sap', 'Senior', 'Outros'];

    if (!validRegimeFiscal.includes(regime_fiscal)) {
      return res.status(400).json({ message: 'Regime fiscal inválido' });
    }
    if (!validSituacao.includes(situacao)) {
      return res.status(400).json({ message: 'Situação inválida' });
    }
    if (!validTipoPessoa.includes(tipo_pessoa)) {
      return res.status(400).json({ message: 'Tipo de pessoa inválido' });
    }
    if (!validStatus.includes(status)) {
      return res.status(400).json({ message: 'Status inválido' });
    }
    if (!validPossuiIe.includes(possui_ie)) {
      return res.status(400).json({ message: 'Possui I.E. inválido' });
    }
    if (!validSegmento.includes(segmento)) {
      return res.status(400).json({ message: 'Segmento inválido' });
    }
    if (!validSistema.includes(sistema)) {
      return res.status(400).json({ message: 'Sistema inválido' });
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
        resp_fiscal = $21,
        resp_contabil = $22,
        resp_dp = $23,
        updated_at = CURRENT_TIMESTAMP,
        updated_by_user_id = $25
      WHERE id = $24
      RETURNING *
      `,
      [
        codigo, nome, razao_social, cpf_cnpj, regime_fiscal, situacao, tipo_pessoa,
        estado, municipio, status, possui_ie, ie, filial, empresa_matriz, grupo,
        segmento, data_entrada, data_saida || null, sistema, JSON.stringify(tipo_servico), 
        resp_fiscal, resp_contabil, resp_dp,
        id, req.user.userId // For updated_by_user_id
      ]
    );

    const updatedClient = {
      ...result.rows[0],
      data_entrada: result.rows[0].data_entrada ? result.rows[0].data_entrada.toISOString() : null,
      data_saida: result.rows[0].data_saida ? result.rows[0].data_saida.toISOString() : null,
      tipo_servico: result.rows[0].tipo_servico || [],
      created_at: result.rows[0].created_at ? result.rows[0].created_at.toISOString() : null,
    };

    // Audit log
    await logAction(
      req.user.userId,
      req.user.email,
      ACTION_TYPES.CLIENT_UPDATED,
      ENTITY_TYPES.CLIENT,
      updatedClient.id,
      { oldData: oldClientData, newData: { ...updatedClient, updated_by_user_id: req.user.userId } }
    );

    res.json(updatedClient);
  } catch (error) {
    console.error('Erro ao atualizar cliente:', error);
    await logAction(
      req.user?.userId,
      req.user?.email,
      ACTION_TYPES.SYSTEM_ERROR,
      ENTITY_TYPES.CLIENT,
      req.params.id,
      { error: error.message, details: 'Failed to update client', requestBody: req.body }
    );
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// DELETE /clients/:id - Deletar um cliente
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch client data before deleting for logging purposes
    const clientToDeleteResult = await pool.query('SELECT * FROM clientes WHERE id = $1', [id]);
    if (clientToDeleteResult.rows.length === 0) {
      return res.status(404).json({ message: 'Cliente não encontrado' });
    }
    const clientToDeleteData = clientToDeleteResult.rows[0];

    const result = await pool.query('DELETE FROM clientes WHERE id = $1 RETURNING id', [id]);
    // No need to check result.rowCount again as we've already confirmed existence

    // Audit log
    await logAction(
      req.user.userId,
      req.user.email,
      ACTION_TYPES.CLIENT_DELETED,
      ENTITY_TYPES.CLIENT,
      id, // The ID of the deleted client
      { deletedData: clientToDeleteData } // Log the data of the client that was deleted
    );

    res.json(true);
  } catch (error) {
    console.error('Erro ao deletar cliente:', error);
    await logAction(
      req.user?.userId,
      req.user?.email,
      ACTION_TYPES.SYSTEM_ERROR,
      ENTITY_TYPES.CLIENT,
      req.params.id,
      { error: error.message, details: 'Failed to delete client' }
    );
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

module.exports = router;