const express = require('express');
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');

const router = express.Router();

// GET todos os contatos societários COM DADOS DO CLIENTE (para exportação global)
// Endpoint: /api/contatos-societarios/com-cliente (ou o prefixo que você usa para suas rotas da API)
router.get('/com-cliente', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cs.*, c.nome as cliente_nome, c.codigo as cliente_codigo 
      FROM contatos_societarios cs
      JOIN clientes c ON cs.cliente_id = c.id
      ORDER BY c.nome, cs.nome
    `);
    // Se não houver contatos, retorna um array vazio, o que é ok.
    res.json({ success: true, contatos: result.rows || [] });
  } catch (error) {
    console.error('Erro ao buscar contatos societários com dados do cliente:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor ao buscar contatos com dados do cliente.', error: error.message });
  }
});

// GET todos os contatos societários (rota original, pode ser redundante ou usada para outros fins)
// Se o frontend só usa /com-cliente, esta rota pode ser removida ou comentada.
router.get('/', auth, async (req, res) => {
  try {
    // Esta query é a mesma da /com-cliente. Se o objetivo é apenas ter os dados do cliente,
    // esta rota se torna redundante. Se for para ter uma rota sem os dados do cliente,
    // a query precisaria ser ajustada (removendo o JOIN e os campos do cliente).
    // Por ora, mantive a query original que já inclui os dados do cliente.
    const result = await pool.query(`
      SELECT cs.*, c.nome as cliente_nome, c.codigo as cliente_codigo 
      FROM contatos_societarios cs
      JOIN clientes c ON cs.cliente_id = c.id
      ORDER BY c.nome, cs.nome
    `);
    res.json({ success: true, contatos: result.rows || [] });
  } catch (error) {
    console.error('Erro ao buscar contatos societários:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor', error: error.message });
  }
});

// GET contatos societários por cliente_id (protegido)
router.get('/cliente/:cliente_id', auth, async (req, res) => {
  try {
    const { cliente_id } = req.params;
    const result = await pool.query(
      'SELECT cs.*, c.nome as cliente_nome, c.codigo as cliente_codigo FROM contatos_societarios cs JOIN clientes c ON cs.cliente_id = c.id WHERE cs.cliente_id = $1 ORDER BY cs.nome',
      [cliente_id]
    );
    // Retorna sucesso com array vazio se não houver contatos para o cliente
    res.json({ success: true, contatos: result.rows || [] });
  } catch (error) {
    console.error('Erro ao buscar contatos societários por cliente:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor', error: error.message });
  }
});

// POST criar novo contato societário (protegido)
router.post('/', auth, async (req, res) => {
  try {
    const { cliente_id, nome, email, cpf, data_nascimento, cargo } = req.body;

    if (!cliente_id || !nome || !email || !cpf || !data_nascimento || !cargo) {
      return res.status(400).json({ success: false, message: 'Todos os campos são obrigatórios.' });
    }
    
    // TODO: Adicionar validação mais robusta para CPF, email e data

    const result = await pool.query(
      'INSERT INTO contatos_societarios (cliente_id, nome, email, cpf, data_nascimento, cargo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [cliente_id, nome, email, cpf, data_nascimento, cargo]
    );
    const novoContato = result.rows[0];

    // Log de auditoria
    if (req.user && req.user.userId && req.user.email) { // Verificar se req.user está definido
        await logAction(
          req.user.userId, 
          req.user.email,
          ACTION_TYPES.CONTATO_SOCIETARIO_CREATED,
          ENTITY_TYPES.CONTATO_SOCIETARIO,
          novoContato.id,
          { cliente_id: novoContato.cliente_id, nome: novoContato.nome, email: novoContato.email } 
        );
    } else {
        console.warn('Usuário não autenticado ou dados do usuário ausentes no token ao tentar logar ação de criação de contato.');
    }


    res.status(201).json({ success: true, message: 'Contato societário criado com sucesso!', contato: novoContato });
  } catch (error) {
    console.error('Erro ao criar contato societário:', error);
    if (error.code === '23505') { 
        if (error.constraint && error.constraint.includes('cpf')) {
             return res.status(409).json({ success: false, message: 'CPF já cadastrado para outro contato.', errorDetail: error.message });
        }
         if (error.constraint && error.constraint.includes('email_cliente_unique')) { // Supondo uma constraint como: UNIQUE (cliente_id, email)
             return res.status(409).json({ success: false, message: 'E-mail já cadastrado para outro contato neste cliente.', errorDetail: error.message });
        }
    }
    res.status(500).json({ success: false, message: 'Erro interno do servidor ao criar contato.', errorDetail: error.message });
  }
});

// PUT atualizar contato societário (protegido)
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    // cliente_id não é atualizável por aqui para evitar mover contato entre clientes por esta rota.
    const { nome, email, cpf, data_nascimento, cargo } = req.body; 

    if (!nome || !email || !cpf || !data_nascimento || !cargo) {
      return res.status(400).json({ success: false, message: 'Todos os campos (nome, email, cpf, data_nascimento, cargo) são obrigatórios para atualização.' });
    }

    // TODO: Adicionar validação mais robusta

    const result = await pool.query(
      'UPDATE contatos_societarios SET nome = $1, email = $2, cpf = $3, data_nascimento = $4, cargo = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6 RETURNING *',
      [nome, email, cpf, data_nascimento, cargo, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Contato societário não encontrado.' });
    }
    const contatoAtualizado = result.rows[0];

    // Log de auditoria
    if (req.user && req.user.userId && req.user.email) {
        await logAction(
          req.user.userId,
          req.user.email,
          ACTION_TYPES.CONTATO_SOCIETARIO_UPDATED,
          ENTITY_TYPES.CONTATO_SOCIETARIO,
          contatoAtualizado.id,
          { nome: contatoAtualizado.nome, email: contatoAtualizado.email, cpf: contatoAtualizado.cpf } // Adicionado cpf para mais detalhes
        );
    } else {
        console.warn('Usuário não autenticado ou dados do usuário ausentes no token ao tentar logar ação de atualização de contato.');
    }

    res.json({ success: true, message: 'Contato societário atualizado com sucesso!', contato: contatoAtualizado });
  } catch (error) {
    console.error('Erro ao atualizar contato societário:', error);
     if (error.code === '23505') { 
        if (error.constraint && error.constraint.includes('cpf')) {
             return res.status(409).json({ success: false, message: 'CPF já cadastrado para outro contato.', errorDetail: error.message });
        }
         if (error.constraint && error.constraint.includes('email_cliente_unique')) { // Supondo uma constraint como: UNIQUE (cliente_id, email)
             return res.status(409).json({ success: false, message: 'E-mail já cadastrado para outro contato neste cliente.', errorDetail: error.message });
        }
    }
    res.status(500).json({ success: false, message: 'Erro interno do servidor ao atualizar contato.', errorDetail: error.message });
  }
});

// DELETE contato societário (protegido)
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    // Primeiro, buscar o contato para logar os detalhes antes de excluir
    const contatoParaExcluirResult = await pool.query('SELECT nome, email, cliente_id FROM contatos_societarios WHERE id = $1', [id]);
    if (contatoParaExcluirResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Contato societário não encontrado para exclusão.' });
    }
    const contatoExcluidoDetails = contatoParaExcluirResult.rows[0];

    const result = await pool.query('DELETE FROM contatos_societarios WHERE id = $1 RETURNING id', [id]); // Só precisamos do ID de volta para confirmar

    if (result.rowCount === 0) { // rowCount é mais apropriado para DELETE sem RETURNING *
      // Esta verificação pode ser redundante se a busca acima já confirmou a existência
      return res.status(404).json({ success: false, message: 'Contato societário não encontrado (ou já excluído).' });
    }
    
    // Log de auditoria
    if (req.user && req.user.userId && req.user.email) {
        await logAction(
          req.user.userId,
          req.user.email,
          ACTION_TYPES.CONTATO_SOCIETARIO_DELETED,
          ENTITY_TYPES.CONTATO_SOCIETARIO,
          id, // Usar o ID do parâmetro que foi confirmado para exclusão
          { nome: contatoExcluidoDetails.nome, email: contatoExcluidoDetails.email, cliente_id: contatoExcluidoDetails.cliente_id } 
        );
    } else {
        console.warn('Usuário não autenticado ou dados do usuário ausentes no token ao tentar logar ação de exclusão de contato.');
    }

    res.json({ success: true, message: 'Contato societário excluído com sucesso!' });
  } catch (error) {
    console.error('Erro ao excluir contato societário:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor ao excluir contato.', errorDetail: error.message });
  }
});

module.exports = router;