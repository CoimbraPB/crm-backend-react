const express = require('express');
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');

const router = express.Router();

router.get('/com-cliente', auth, async (req, res) => {
  try {
    const queryText = `
      SELECT 
        cs.id,
        cs.cliente_id,
        cs.nome,
        cs.email,
        cs.cpf,
        TO_CHAR(cs.data_nascimento, 'YYYY-MM-DD') as data_nascimento,
        cs.cargo,
        cs.created_at,
        cs.updated_at,
        c.nome as cliente_nome, 
        c.codigo as cliente_codigo 
      FROM contatos_societarios cs
      JOIN clientes c ON cs.cliente_id = c.id
      ORDER BY c.nome, cs.nome
    `;
    const result = await pool.query(queryText);
    res.json({ success: true, contatos: result.rows || [] });
  } catch (error) {
    console.error('Erro ao buscar contatos societários com dados do cliente:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor ao buscar contatos com dados do cliente.', errorDetail: error.message });
  }
});

router.get('/', auth, async (req, res) => {
  try {
    const queryText = `
      SELECT 
        cs.id,
        cs.cliente_id,
        cs.nome,
        cs.email,
        cs.cpf,
        TO_CHAR(cs.data_nascimento, 'YYYY-MM-DD') as data_nascimento,
        cs.cargo,
        cs.created_at,
        cs.updated_at,
        c.nome as cliente_nome, 
        c.codigo as cliente_codigo 
      FROM contatos_societarios cs
      JOIN clientes c ON cs.cliente_id = c.id
      ORDER BY c.nome, cs.nome
    `;
    const result = await pool.query(queryText);
    res.json({ success: true, contatos: result.rows || [] });
  } catch (error) {
    console.error('Erro ao buscar contatos societários:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor', errorDetail: error.message });
  }
});

router.get('/cliente/:cliente_id', auth, async (req, res) => {
  try {
    const { cliente_id } = req.params;
    const queryText = `
      SELECT 
          cs.id,
          cs.cliente_id,
          cs.nome,
          cs.email,
          cs.cpf,
          TO_CHAR(cs.data_nascimento, 'YYYY-MM-DD') as data_nascimento,
          cs.cargo,
          cs.created_at,
          cs.updated_at,
          c.nome as cliente_nome, 
          c.codigo as cliente_codigo 
        FROM contatos_societarios cs 
        JOIN clientes c ON cs.cliente_id = c.id 
        WHERE cs.cliente_id = $1 
        ORDER BY cs.nome`;
    const result = await pool.query(queryText, [cliente_id]);
    res.json({ success: true, contatos: result.rows || [] });
  } catch (error) {
    console.error('Erro ao buscar contatos societários por cliente:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor', errorDetail: error.message });
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const { cliente_id, nome, email, cpf, data_nascimento, cargo } = req.body;

    if (!cliente_id || !nome || !cpf) { 
      return res.status(400).json({ success: false, message: 'Cliente, Nome e CPF são obrigatórios.' });
    }

    const cpfDigits = String(cpf).replace(/\D/g, '');
    if (cpfDigits.length !== 11) {
        return res.status(400).json({ success: false, message: 'CPF deve conter 11 dígitos.' });
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, message: 'Formato de e-mail inválido.' });
    }
    // Permite string vazia ou null para data_nascimento, mas valida formato se preenchido
    if (data_nascimento && data_nascimento !== '' && data_nascimento !== null && !/^\d{4}-\d{2}-\d{2}$/.test(data_nascimento)) {
        return res.status(400).json({ success: false, message: 'Formato de data inválido. Use YYYY-MM-DD ou deixe vazio/nulo.' });
    }

    const queryText = 'INSERT INTO contatos_societarios (cliente_id, nome, email, cpf, data_nascimento, cargo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, cliente_id, nome, email, cpf, TO_CHAR(data_nascimento, \'YYYY-MM-DD\') as data_nascimento, cargo, created_at, updated_at';
    const result = await pool.query(queryText, [
      cliente_id, 
      nome, 
      email || null, 
      cpfDigits, // Salva apenas os dígitos do CPF
      data_nascimento || null, 
      cargo || null
    ]);
    const novoContato = result.rows[0];

    if (req.user && req.user.userId && req.user.email) {
        await logAction(
          req.user.userId, 
          req.user.email,
          ACTION_TYPES.CONTATO_SOCIETARIO_CREATED,
          ENTITY_TYPES.CONTATO_SOCIETARIO,
          novoContato.id,
          { cliente_id: novoContato.cliente_id, nome: novoContato.nome, email: novoContato.email, cpf: novoContato.cpf } 
        );
    } else {
        console.warn('Usuário não autenticado ou dados do usuário ausentes no token ao tentar logar ação de criação de contato.');
    }

    res.status(201).json({ success: true, message: 'Contato societário criado com sucesso!', contato: novoContato });
  } catch (error) {
    console.error('Erro ao criar contato societário:', error);
    if (error.code === '23505') { 
        if (error.constraint && error.constraint.includes('cpf')) { // Assumindo que a constraint de CPF único se chama algo como '...cpf_key' ou '...cpf_unique'
             return res.status(409).json({ success: false, message: 'CPF já cadastrado para outro contato.', errorDetail: error.message });
        }
        // Adicione aqui a verificação para email único por cliente, se houver essa constraint.
        // Exemplo: if (error.constraint && error.constraint.includes('contatos_societarios_cliente_id_email_key')) { ... }
    }
    res.status(500).json({ success: false, message: 'Erro interno do servidor ao criar contato.', errorDetail: error.message });
  }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, email, cpf, data_nascimento, cargo } = req.body; 

    if (!nome || !cpf) { 
      return res.status(400).json({ success: false, message: 'Nome e CPF são obrigatórios para atualização.' });
    }

    const cpfDigits = String(cpf).replace(/\D/g, '');
    if (cpfDigits.length !== 11) {
        return res.status(400).json({ success: false, message: 'CPF deve conter 11 dígitos.' });
    }
    
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, message: 'Formato de e-mail inválido.' });
    }

    if (data_nascimento && data_nascimento !== '' && data_nascimento !== null && !/^\d{4}-\d{2}-\d{2}$/.test(data_nascimento)) {
        return res.status(400).json({ success: false, message: 'Formato de data inválido. Use YYYY-MM-DD ou deixe vazio/nulo.' });
    }
    
    const queryText = 'UPDATE contatos_societarios SET nome = $1, email = $2, cpf = $3, data_nascimento = $4, cargo = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6 RETURNING id, cliente_id, nome, email, cpf, TO_CHAR(data_nascimento, \'YYYY-MM-DD\') as data_nascimento, cargo, created_at, updated_at';
    const result = await pool.query(queryText, [
      nome, 
      email || null, 
      cpfDigits, // Salva apenas os dígitos do CPF
      data_nascimento || null, 
      cargo || null, 
      id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Contato societário não encontrado.' });
    }
    const contatoAtualizado = result.rows[0];

    if (req.user && req.user.userId && req.user.email) {
        await logAction(
          req.user.userId,
          req.user.email,
          ACTION_TYPES.CONTATO_SOCIETARIO_UPDATED,
          ENTITY_TYPES.CONTATO_SOCIETARIO,
          contatoAtualizado.id,
          { nome: contatoAtualizado.nome, email: contatoAtualizado.email, cpf: contatoAtualizado.cpf } 
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
        // Adicione aqui a verificação para email único por cliente, se houver essa constraint.
    }
    res.status(500).json({ success: false, message: 'Erro interno do servidor ao atualizar contato.', errorDetail: error.message });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    const contatoParaExcluirResult = await pool.query('SELECT nome, email, cliente_id, cpf FROM contatos_societarios WHERE id = $1', [id]);
    if (contatoParaExcluirResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Contato societário não encontrado para exclusão.' });
    }
    const contatoExcluidoDetails = contatoParaExcluirResult.rows[0];

    const result = await pool.query('DELETE FROM contatos_societarios WHERE id = $1 RETURNING id', [id]); 

    if (result.rowCount === 0) { 
      return res.status(404).json({ success: false, message: 'Contato societário não encontrado (ou já excluído).' });
    }
    
    if (req.user && req.user.userId && req.user.email) {
        await logAction(
          req.user.userId,
          req.user.email,
          ACTION_TYPES.CONTATO_SOCIETARIO_DELETED,
          ENTITY_TYPES.CONTATO_SOCIETARIO,
          id, 
          { nome: contatoExcluidoDetails.nome, email: contatoExcluidoDetails.email, cliente_id: contatoExcluidoDetails.cliente_id, cpf: contatoExcluidoDetails.cpf } 
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

// NOVA ROTA: GET para buscar clientes por nome ou CPF do contato societário
router.get('/search/clientes-por-contato', auth, async (req, res) => {
  const { q } = req.query;

  if (!q || String(q).trim() === '') {
    return res.status(400).json({ success: false, message: 'O termo de busca (q) é obrigatório.' });
  }

  const searchTerm = String(q).trim();
  const searchTermDigits = searchTerm.replace(/\D/g, ''); // Para busca por CPF

  try {
    const queryText = `
      SELECT DISTINCT ON (c.id)
        c.*, 
        cs.nome as matched_contato_nome,
        cs.cpf as matched_contato_cpf 
      FROM clientes c
      JOIN contatos_societarios cs ON c.id = cs.cliente_id
      WHERE 
        cs.nome ILIKE $1 OR 
        cs.cpf = $2
      ORDER BY c.id, c.nome;
    `;
    
    const result = await pool.query(queryText, [`%${searchTerm}%`, searchTermDigits]);

    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'Nenhum cliente encontrado para o contato informado.', clientes: [] });
    }
    res.json({ success: true, clientes: result.rows });

  } catch (error) {
    console.error('Erro ao buscar clientes por contato societário:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor.', errorDetail: error.message });
  }
});

module.exports = router;