const express = require('express');
const router = express.Router();
const pool = require('../config/database'); // Seu pool de conexão do PostgreSQL
const auth = require('../middleware/auth'); // Seu middleware de autenticação
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService'); // Seu serviço de log

// Middleware para verificar permissões específicas
const checkPermission = (allowedRoles) => {
  return (req, res, next) => {
    const userPermission = req.user.permissao; // 'permissao' vem do token JWT decodificado pelo middleware 'auth'
    if (allowedRoles.includes(userPermission)) {
      next();
    } else {
      logAction(req.user.userId, req.user.email, 'FATURAMENTO_ACCESS_DENIED', ENTITY_TYPES.FATURAMENTO, null, { route: req.path, attemptedPermission: userPermission });
      return res.status(403).json({ success: false, message: 'Acesso negado. Permissão insuficiente.' });
    }
  };
};

// --- Permissões ---
const canCreateUpdateView = ['Fiscal', 'Gerente', 'Gestor', 'Dev']; // Adicionei 'Gerente' aqui conforme o padrão
const canDelete = ['Gerente', 'Gestor', 'Dev'];


// ROTA: Criar um novo lançamento de faturamento
router.post('/', auth, checkPermission(canCreateUpdateView), async (req, res) => {
  const { cliente_id, mes_ano, valor_faturamento } = req.body;
  const userId = req.user.userId; // ID do usuário logado
  const userEmail = req.user.email;

  if (!cliente_id || !mes_ano || valor_faturamento === undefined) {
    return res.status(400).json({ success: false, message: 'Campos obrigatórios ausentes: cliente_id, mes_ano, valor_faturamento.' });
  }

  if (isNaN(parseFloat(valor_faturamento)) || parseFloat(valor_faturamento) < 0) {
    return res.status(400).json({ success: false, message: 'Valor do faturamento deve ser um número não negativo.' });
  }

  // Normalizar mes_ano para o primeiro dia do mês
  // Espera-se mes_ano no formato 'YYYY-MM' ou 'YYYY-MM-DD'.
  // Se for 'YYYY-MM', adiciona '-01'.
  let mesAnoDate;
  try {
    if (String(mes_ano).length === 7 && String(mes_ano).includes('-')) { // Formato YYYY-MM
        mesAnoDate = new Date(`${mes_ano}-01T00:00:00.000Z`); // Adiciona dia e considera UTC para evitar problemas de fuso
    } else { // Tenta interpretar como uma data completa
        mesAnoDate = new Date(mes_ano);
        mesAnoDate.setUTCDate(1); // Garante que é o primeiro dia do mês em UTC
        mesAnoDate.setUTCHours(0, 0, 0, 0);
    }
    if (isNaN(mesAnoDate.getTime())) {
        throw new Error('Data inválida');
    }
  } catch (e) {
    return res.status(400).json({ success: false, message: 'Formato de mes_ano inválido. Use YYYY-MM ou uma data válida.' });
  }
  
  const mesAnoFormatted = mesAnoDate.toISOString().split('T')[0]; // Formato YYYY-MM-DD

  try {
    const result = await pool.query(
      'INSERT INTO faturamentos (cliente_id, mes_ano, valor_faturamento, created_by_user_id, updated_by_user_id) VALUES ($1, $2, $3, $4, $4) RETURNING *',
      [cliente_id, mesAnoFormatted, valor_faturamento, userId]
    );
    const novoFaturamento = result.rows[0];
    logAction(userId, userEmail, ACTION_TYPES.FATURAMENTO_CREATED || 'FATURAMENTO_CREATED', ENTITY_TYPES.FATURAMENTO || 'Faturamento', novoFaturamento.id, { newData: novoFaturamento });
    res.status(201).json({ success: true, message: 'Faturamento cadastrado com sucesso!', faturamento: novoFaturamento });
  } catch (error) {
    console.error('Erro ao criar faturamento:', error);
    if (error.constraint === 'faturamento_cliente_mes_ano_unico') {
      logAction(userId, userEmail, 'FATURAMENTO_CREATE_FAILED_DUPLICATE', ENTITY_TYPES.FATURAMENTO || 'Faturamento', null, { cliente_id, mes_ano: mesAnoFormatted, error: error.message });
      return res.status(409).json({ success: false, message: 'Já existe um faturamento para este cliente neste mês/ano.' });
    }
    if (error.constraint === 'fk_faturamentos_cliente') {
      logAction(userId, userEmail, 'FATURAMENTO_CREATE_FAILED_INVALID_CLIENT', ENTITY_TYPES.FATURAMENTO || 'Faturamento', null, { cliente_id, error: error.message });
      return res.status(400).json({ success: false, message: 'Cliente não encontrado.' });
    }
    logAction(userId, userEmail, 'FATURAMENTO_CREATE_FAILED', ENTITY_TYPES.FATURAMENTO || 'Faturamento', null, { error: error.message, input: req.body });
    res.status(500).json({ success: false, message: 'Erro interno ao cadastrar faturamento.' });
  }
});

// ROTA: Listar faturamentos com filtros (ano, mes, busca por razao_social/codigo do cliente)
router.get('/', auth, checkPermission(canCreateUpdateView), async (req, res) => {
  const { ano, mes, busca } = req.query;
  const userEmail = req.user.email; // Para logs, caso necessário

  if (!ano || !mes) {
    return res.status(400).json({ success: false, message: 'Parâmetros "ano" e "mes" são obrigatórios.' });
  }

  // Validar ano e mes
  const year = parseInt(ano);
  const month = parseInt(mes);
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12 || year < 1900 || year > 2100) {
      return res.status(400).json({ success: false, message: 'Ano ou mês inválido.' });
  }

  // Construir a data para o primeiro dia do mês/ano especificado
  // Formato YYYY-MM-DD para a query no banco
  const mesAnoFilter = `${year}-${String(month).padStart(2, '0')}-01`;

  let query = `
    SELECT 
      f.id, 
      f.cliente_id, 
      c.codigo AS cliente_codigo,
      c.razao_social AS cliente_razao_social,
      f.mes_ano, 
      f.valor_faturamento, 
      f.created_at, 
      f.updated_at,
      uc.nome AS created_by_user_nome,
      uu.nome AS updated_by_user_nome
    FROM faturamentos f
    JOIN clientes c ON f.cliente_id = c.id
    LEFT JOIN usuarios uc ON f.created_by_user_id = uc.id
    LEFT JOIN usuarios uu ON f.updated_by_user_id = uu.id
    WHERE f.mes_ano = $1
  `;
  const queryParams = [mesAnoFilter];
  let paramIndex = 2;

  if (busca) {
    query += ` AND (c.razao_social ILIKE $${paramIndex} OR c.codigo ILIKE $${paramIndex})`;
    queryParams.push(`%${busca}%`);
    paramIndex++;
  }

  query += ` ORDER BY c.razao_social ASC, f.id DESC`; // Ou outra ordenação desejada

  try {
    const result = await pool.query(query, queryParams);
    // logAction(req.user.userId, userEmail, 'FATURAMENTO_LISTED', ENTITY_TYPES.FATURAMENTO || 'Faturamento', null, { filters: { ano, mes, busca } });
    res.json({ success: true, faturamentos: result.rows });
  } catch (error) {
    console.error('Erro ao listar faturamentos:', error);
    logAction(req.user.userId, userEmail, 'FATURAMENTO_LIST_FAILED', ENTITY_TYPES.FATURAMENTO || 'Faturamento', null, { error: error.message, filters: { ano, mes, busca } });
    res.status(500).json({ success: false, message: 'Erro interno ao listar faturamentos.' });
  }
});

// ROTA: Atualizar um lançamento de faturamento
router.put('/:id', auth, checkPermission(canCreateUpdateView), async (req, res) => {
  const { id } = req.params;
  const { valor_faturamento, mes_ano } = req.body; // Permitir alteração de mes_ano também, se necessário
  const userId = req.user.userId;
  const userEmail = req.user.email;

  if (valor_faturamento === undefined && mes_ano === undefined) {
    return res.status(400).json({ success: false, message: 'Pelo menos um campo (valor_faturamento ou mes_ano) deve ser fornecido para atualização.' });
  }

  let mesAnoFormatted;
  if (mes_ano) {
    try {
        let mesAnoDate;
        if (String(mes_ano).length === 7 && String(mes_ano).includes('-')) {
            mesAnoDate = new Date(`${mes_ano}-01T00:00:00.000Z`);
        } else {
            mesAnoDate = new Date(mes_ano);
            mesAnoDate.setUTCDate(1);
            mesAnoDate.setUTCHours(0, 0, 0, 0);
        }
        if (isNaN(mesAnoDate.getTime())) throw new Error('Data inválida');
        mesAnoFormatted = mesAnoDate.toISOString().split('T')[0];
    } catch (e) {
        return res.status(400).json({ success: false, message: 'Formato de mes_ano inválido. Use YYYY-MM ou uma data válida.' });
    }
  }
  
  if (valor_faturamento !== undefined && (isNaN(parseFloat(valor_faturamento)) || parseFloat(valor_faturamento) < 0)) {
    return res.status(400).json({ success: false, message: 'Valor do faturamento deve ser um número não negativo.' });
  }

  // Buscar dados antigos para log
  let oldData;
  try {
    const oldResult = await pool.query('SELECT * FROM faturamentos WHERE id = $1', [id]);
    if (oldResult.rows.length === 0) {
      logAction(userId, userEmail, 'FATURAMENTO_UPDATE_FAILED_NOT_FOUND', ENTITY_TYPES.FATURAMENTO || 'Faturamento', id);
      return res.status(404).json({ success: false, message: 'Faturamento não encontrado.' });
    }
    oldData = oldResult.rows[0];
  } catch (error) {
    // Apenas loga, a verificação principal de existência é feita depois
    console.error('Erro ao buscar faturamento para log antes de atualizar:', error);
  }


  const fieldsToUpdate = [];
  const values = [];
  let paramIndex = 1;

  if (valor_faturamento !== undefined) {
    fieldsToUpdate.push(`valor_faturamento = $${paramIndex++}`);
    values.push(parseFloat(valor_faturamento));
  }
  if (mesAnoFormatted !== undefined) {
    fieldsToUpdate.push(`mes_ano = $${paramIndex++}`);
    values.push(mesAnoFormatted);
  }
  
  fieldsToUpdate.push(`updated_by_user_id = $${paramIndex++}`);
  values.push(userId);
  fieldsToUpdate.push(`updated_at = CURRENT_TIMESTAMP`); // Garante que updated_at seja atualizado

  values.push(id); // Para a cláusula WHERE

  const query = `UPDATE faturamentos SET ${fieldsToUpdate.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

  try {
    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      // Isso não deveria acontecer se a busca anterior funcionou, mas é uma salvaguarda.
      logAction(userId, userEmail, 'FATURAMENTO_UPDATE_FAILED_NOT_FOUND', ENTITY_TYPES.FATURAMENTO || 'Faturamento', id);
      return res.status(404).json({ success: false, message: 'Faturamento não encontrado para atualização.' });
    }
    const faturamentoAtualizado = result.rows[0];
    logAction(userId, userEmail, ACTION_TYPES.FATURAMENTO_UPDATED || 'FATURAMENTO_UPDATED', ENTITY_TYPES.FATURAMENTO || 'Faturamento', id, { oldData, newData: faturamentoAtualizado });
    res.json({ success: true, message: 'Faturamento atualizado com sucesso!', faturamento: faturamentoAtualizado });
  } catch (error) {
    console.error('Erro ao atualizar faturamento:', error);
    if (error.constraint === 'faturamento_cliente_mes_ano_unico') {
      logAction(userId, userEmail, 'FATURAMENTO_UPDATE_FAILED_DUPLICATE', ENTITY_TYPES.FATURAMENTO || 'Faturamento', id, { error: error.message, input: req.body });
      return res.status(409).json({ success: false, message: 'Atualização resultaria em um faturamento duplicado para este cliente neste mês/ano.' });
    }
    logAction(userId, userEmail, 'FATURAMENTO_UPDATE_FAILED', ENTITY_TYPES.FATURAMENTO || 'Faturamento', id, { error: error.message, input: req.body });
    res.status(500).json({ success: false, message: 'Erro interno ao atualizar faturamento.' });
  }
});

// ROTA: Excluir um lançamento de faturamento
router.delete('/:id', auth, checkPermission(canDelete), async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;
  const userEmail = req.user.email;

  // Opcional: buscar dados antes de deletar para log
  let deletedData;
  try {
    const beforeDeleteResult = await pool.query('SELECT * FROM faturamentos WHERE id = $1', [id]);
    if (beforeDeleteResult.rows.length > 0) {
        deletedData = beforeDeleteResult.rows[0];
    }
  } catch (e) {
      console.warn("Não foi possível buscar dados para log antes da exclusão do faturamento:", id);
  }

  try {
    const result = await pool.query('DELETE FROM faturamentos WHERE id = $1 RETURNING *', [id]);
    if (result.rowCount === 0) {
      logAction(userId, userEmail, 'FATURAMENTO_DELETE_FAILED_NOT_FOUND', ENTITY_TYPES.FATURAMENTO || 'Faturamento', id);
      return res.status(404).json({ success: false, message: 'Faturamento não encontrado.' });
    }
    logAction(userId, userEmail, ACTION_TYPES.FATURAMENTO_DELETED || 'FATURAMENTO_DELETED', ENTITY_TYPES.FATURAMENTO || 'Faturamento', id, { deletedData: deletedData || {id: id} });
    res.json({ success: true, message: 'Faturamento excluído com sucesso.' });
  } catch (error) {
    console.error('Erro ao excluir faturamento:', error);
    logAction(userId, userEmail, 'FATURAMENTO_DELETE_FAILED', ENTITY_TYPES.FATURAMENTO || 'Faturamento', id, { error: error.message });
    res.status(500).json({ success: false, message: 'Erro interno ao excluir faturamento.' });
  }
});

module.exports = router;