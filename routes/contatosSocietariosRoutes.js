const express = require('express');
const pool = require('../config/database'); // Ajuste o caminho se necessário
const auth = require('../middleware/auth'); // Ajuste o caminho se necessário
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService'); // Descomente e ajuste o caminho se usar

const router = express.Router();

// GET todos os contatos societários COM DADOS DO CLIENTE (para exportação global e outros usos)
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
        cs.telefone, -- Adicionado telefone
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

// GET contatos societários por cliente_id (protegido)
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
          cs.telefone, -- Adicionado telefone
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

// ROTA DE BUSCA DE CLIENTES POR CONTATO (COM PAGINAÇÃO E FILTROS)
router.get('/search/clientes-por-contato', auth, async (req, res) => {
  const { q, page = 1, limit = 10 } = req.query;

  if (!q || String(q).trim() === '') {
    return res.status(400).json({ success: false, message: 'O termo de busca (q) é obrigatório.' });
  }

  const searchTerm = String(q).trim();
  const searchTermDigits = searchTerm.replace(/\D/g, '');
  const offset = (page - 1) * limit;

  try {
    const queryText = `
      SELECT DISTINCT ON (c.id)
        c.*, 
        cs.nome as matched_contato_nome,
        cs.cpf as matched_contato_cpf,
        cs.telefone as matched_contato_telefone
      FROM clientes c
      JOIN contatos_societarios cs ON c.id = cs.cliente_id
      WHERE 
        cs.nome ILIKE $1 OR 
        cs.cpf = $2 
      ORDER BY c.id, c.nome
      LIMIT $3 OFFSET $4;
    `;
    
    const countQueryText = `
      SELECT COUNT(DISTINCT c.id)
      FROM clientes c
      JOIN contatos_societarios cs ON c.id = cs.cliente_id
      WHERE 
        cs.nome ILIKE $1 OR 
        cs.cpf = $2;
    `;

    const result = await pool.query(queryText, [`%${searchTerm}%`, searchTermDigits, limit, offset]);
    const countResult = await pool.query(countQueryText, [`%${searchTerm}%`, searchTermDigits]);
    
    const totalItems = parseInt(countResult.rows[0].count, 10);
    const totalPages = Math.ceil(totalItems / limit);

    res.json({ 
      success: true, 
      clientes: result.rows,
      pagination: {
        totalItems,
        totalPages,
        currentPage: parseInt(page, 10),
        itemsPerPage: parseInt(limit, 10)
      }
    });
  } catch (error) {
    console.error('Erro ao buscar clientes por contato societário:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor.', errorDetail: error.message });
  }
});


// POST criar novo contato societário (protegido)
router.post('/', auth, async (req, res) => {
  try {
    const { cliente_id, nome, email, cpf, data_nascimento, cargo, telefone } = req.body; // Adicionado telefone

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
    if (data_nascimento && data_nascimento !== '' && data_nascimento !== null && !/^\d{4}-\d{2}-\d{2}$/.test(data_nascimento)) {
        return res.status(400).json({ success: false, message: 'Formato de data inválido. Use YYYY-MM-DD ou deixe vazio/nulo.' });
    }
    // Validação simples para telefone (opcional) - apenas para garantir que não é excessivamente longo se fornecido
    if (telefone && String(telefone).length > 20) {
        return res.status(400).json({ success: false, message: 'Telefone não pode exceder 20 caracteres.' });
    }


    const queryText = `
      INSERT INTO contatos_societarios 
        (cliente_id, nome, email, cpf, data_nascimento, cargo, telefone) 
      VALUES ($1, $2, $3, $4, $5, $6, $7) 
      RETURNING id, cliente_id, nome, email, cpf, TO_CHAR(data_nascimento, 'YYYY-MM-DD') as data_nascimento, cargo, telefone, created_at, updated_at
    `;
    const result = await pool.query(queryText, [
      cliente_id, 
      nome, 
      email || null, 
      cpfDigits, 
      data_nascimento || null, 
      cargo || null,
      telefone || null // Adicionado telefone
    ]);
    const novoContato = result.rows[0];

    if (req.user && req.user.userId && req.user.email) {
        await logAction(
          req.user.userId, 
          req.user.email,
          ACTION_TYPES.CONTATO_SOCIETARIO_CREATED, // Assegure que ACTION_TYPES esteja definido
          ENTITY_TYPES.CONTATO_SOCIETARIO,      // Assegure que ENTITY_TYPES esteja definido
          novoContato.id,
          { ...novoContato } // Loga todos os campos do novo contato
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
    }
    res.status(500).json({ success: false, message: 'Erro interno do servidor ao criar contato.', errorDetail: error.message });
  }
});

// PUT atualizar contato societário (protegido)
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, email, cpf, data_nascimento, cargo, telefone } = req.body; // Adicionado telefone

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
    if (telefone && String(telefone).length > 20) {
        return res.status(400).json({ success: false, message: 'Telefone não pode exceder 20 caracteres.' });
    }
    
    const queryText = `
      UPDATE contatos_societarios 
      SET nome = $1, email = $2, cpf = $3, data_nascimento = $4, cargo = $5, telefone = $6, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $7 
      RETURNING id, cliente_id, nome, email, cpf, TO_CHAR(data_nascimento, 'YYYY-MM-DD') as data_nascimento, cargo, telefone, created_at, updated_at
    `;
    const result = await pool.query(queryText, [
      nome, 
      email || null, 
      cpfDigits, 
      data_nascimento || null, 
      cargo || null, 
      telefone || null, // Adicionado telefone
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
          ACTION_TYPES.CONTATO_SOCIETARIO_UPDATED, // Assegure que ACTION_TYPES esteja definido
          ENTITY_TYPES.CONTATO_SOCIETARIO,       // Assegure que ENTITY_TYPES esteja definido
          contatoAtualizado.id,
          { ...contatoAtualizado } // Loga todos os campos atualizados
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
    }
    res.status(500).json({ success: false, message: 'Erro interno do servidor ao atualizar contato.', errorDetail: error.message });
  }
});

// DELETE contato societário (protegido)
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    // Buscar o contato para log antes de excluir
    const contatoParaExcluirResult = await pool.query('SELECT * FROM contatos_societarios WHERE id = $1', [id]);
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
          ACTION_TYPES.CONTATO_SOCIETARIO_DELETED, // Assegure que ACTION_TYPES esteja definido
          ENTITY_TYPES.CONTATO_SOCIETARIO,       // Assegure que ENTITY_TYPES esteja definido
          id, 
          { nome: contatoExcluidoDetails.nome, cpf: contatoExcluidoDetails.cpf, telefone: contatoExcluidoDetails.telefone } // Log de campos relevantes
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
