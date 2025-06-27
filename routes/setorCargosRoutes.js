const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');

// Middleware de Permissão
const checkViewPermission = (req, res, next) => {
  // Assumindo que qualquer usuário logado que acesse o form de alocação pode precisar desta lista
  // Ou ajuste para ['Gestor', 'Gerente', 'Dev'] se apenas eles podem ver
  if (req.user) { 
    next();
  } else {
    return res.status(403).json({ success: false, message: 'Acesso negado.' });
  }
};

const checkEditPermission = (req, res, next) => {
    const userPermission = req.user.permissao;
    if (['Gerente', 'Dev'].includes(userPermission)) { // Apenas Gerentes e Devs podem editar associações
        next();
    } else {
        logAction(req.user.userId, req.user.email, 'SETOR_CARGO_ASSOC_ACCESS_DENIED', ENTITY_TYPES.SETOR_CARGO_ASSOCIACAO || 'SetorCargoAssociacao', null, { route: req.path, attemptedPermission: userPermission });
        return res.status(403).json({ success: false, message: 'Acesso negado. Permissão insuficiente.' });
    }
};

// ROTA: Listar todos os cargos ATIVOS associados a um setor específico
router.get('/setor/:setor_id/cargos', auth, checkViewPermission, async (req, res) => {
  const { setor_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT c.id_cargo, c.nome_cargo, c.ativo 
       FROM cargos c
       JOIN setor_cargos sc ON c.id_cargo = sc.cargo_id
       WHERE sc.setor_id = $1 AND c.ativo = TRUE
       ORDER BY c.nome_cargo ASC`,
      [setor_id]
    );
    res.json({ success: true, cargos: result.rows });
  } catch (error) {
    console.error(`Erro ao listar cargos para o setor ${setor_id}:`, error);
    res.status(500).json({ success: false, message: 'Erro interno ao listar cargos do setor.' });
  }
});

// ROTA: Adicionar um ou mais cargos a um setor
router.post('/setor/:setor_id/cargos', auth, checkEditPermission, async (req, res) => {
  const { setor_id } = req.params;
  const { cargo_ids } = req.body; // Espera um array de cargo_ids
  const userId = req.user.userId;
  const userEmail = req.user.email;

  if (!Array.isArray(cargo_ids) || cargo_ids.length === 0) {
    return res.status(400).json({ success: false, message: 'Array de cargo_ids é obrigatório e não pode ser vazio.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inseridosComDetalhes = [];
    const jaExistentes = [];

    for (const cargo_id_str of cargo_ids) { // Renomeado para evitar confusão com a variável de escopo
      const cargo_id = parseInt(cargo_id_str, 10);
      if (isNaN(cargo_id)) {
        console.warn(`Cargo ID inválido ignorado: ${cargo_id_str}`);
        jaExistentes.push({ cargo_id: cargo_id_str, nome_cargo: 'ID Inválido' });
        continue;
      }

      const insertRes = await client.query(
        'INSERT INTO setor_cargos (setor_id, cargo_id) VALUES ($1, $2) ON CONFLICT (setor_id, cargo_id) DO NOTHING RETURNING *',
        [setor_id, cargo_id]
      );
      
      if (insertRes.rows.length > 0) {
        const cargoInfo = await client.query('SELECT nome_cargo FROM cargos WHERE id_cargo = $1', [cargo_id]);
        inseridosComDetalhes.push({ 
            setor_id: parseInt(setor_id, 10), 
            cargo_id: cargo_id,
            nome_cargo: cargoInfo.rows.length > 0 ? cargoInfo.rows[0].nome_cargo : `Cargo ID ${cargo_id}`
        });
      } else {
        const cargoInfo = await client.query('SELECT nome_cargo FROM cargos WHERE id_cargo = $1', [cargo_id]);
        jaExistentes.push({
            cargo_id: cargo_id,
            nome_cargo: cargoInfo.rows.length > 0 ? cargoInfo.rows[0].nome_cargo : `Cargo ID ${cargo_id}`
        });
      }
    }
    
    await client.query('COMMIT');
    logAction(userId, userEmail, ACTION_TYPES.SETOR_CARGOS_ASSOCIATED || 'SETOR_CARGOS_ASSOCIATED', ENTITY_TYPES.SETOR_CARGO_ASSOCIACAO || 'SetorCargoAssociacao', setor_id, { inseridos: inseridosComDetalhes.map(c => c.cargo_id), ignorados: jaExistentes.map(c => c.cargo_id) });
    res.status(201).json({ 
        success: true, 
        message: `${inseridosComDetalhes.length} cargos associados ao setor. ${jaExistentes.length > 0 ? `${jaExistentes.length} já estavam associados ou eram IDs inválidos.` : ''}`, 
        associacoes_criadas: inseridosComDetalhes 
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Erro ao associar cargos ao setor ${setor_id}:`, error);
    logAction(userId, userEmail, ACTION_TYPES.SETOR_CARGOS_ASSOCIATE_FAILED || 'SETOR_CARGOS_ASSOCIATE_FAILED', ENTITY_TYPES.SETOR_CARGO_ASSOCIACAO || 'SetorCargoAssociacao', setor_id, { cargo_ids_tentados: cargo_ids, error: error.message });
    res.status(500).json({ success: false, message: 'Erro interno ao associar cargos.' });
  } finally {
    client.release();
  }
});

// ROTA: Remover uma associação específica entre setor e cargo
router.delete('/setor/:setor_id/cargo/:cargo_id', auth, checkEditPermission, async (req, res) => {
  const { setor_id, cargo_id } = req.params;
  const userId = req.user.userId;
  const userEmail = req.user.email;
  try {
    const result = await pool.query(
      'DELETE FROM setor_cargos WHERE setor_id = $1 AND cargo_id = $2 RETURNING *',
      [setor_id, cargo_id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Associação não encontrada para remoção.' });
    }
    logAction(userId, userEmail, ACTION_TYPES.SETOR_CARGO_DISSOCIATED || 'SETOR_CARGO_DISSOCIATED', ENTITY_TYPES.SETOR_CARGO_ASSOCIACAO || 'SetorCargoAssociacao', setor_id, { cargo_id_removido: cargo_id });
    res.json({ success: true, message: 'Associação cargo-setor removida com sucesso.' });
  } catch (error) {
    console.error(`Erro ao remover associação do cargo ${cargo_id} do setor ${setor_id}:`, error);
    logAction(userId, userEmail, ACTION_TYPES.SETOR_CARGO_DISSOCIATE_FAILED || 'SETOR_CARGO_DISSOCIATE_FAILED', ENTITY_TYPES.SETOR_CARGO_ASSOCIACAO || 'SetorCargoAssociacao', setor_id, { cargo_id, error: error.message });
    res.status(500).json({ success: false, message: 'Erro interno ao remover associação.' });
  }
});

// ROTA: Listar cargos ATIVOS NÃO associados a um setor específico (para UI de seleção)
router.get('/setor/:setor_id/cargos-nao-associados', auth, checkViewPermission, async (req, res) => {
  const { setor_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT id_cargo, nome_cargo, ativo 
       FROM cargos c
       WHERE c.ativo = TRUE AND NOT EXISTS (
         SELECT 1 FROM setor_cargos sc 
         WHERE sc.setor_id = $1 AND sc.cargo_id = c.id_cargo
       )
       ORDER BY c.nome_cargo ASC`,
      [setor_id]
    );
    res.json({ success: true, cargos: result.rows });
  } catch (error) {
    console.error(`Erro ao listar cargos não associados ao setor ${setor_id}:`, error);
    res.status(500).json({ success: false, message: 'Erro interno ao listar cargos não associados.' });
  }
});

module.exports = router;
