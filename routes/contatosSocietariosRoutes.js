const express = require('express');
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');

const router = express.Router();

// Helper para formatar data para YYYY-MM-DD
// Necessário se o seu driver pg não fizer isso automaticamente para tipo DATE
// ou se você quiser ter certeza absoluta do formato.
// No entanto, para o tipo DATE do PostgreSQL, a conversão para string geralmente já é YYYY-MM-DD.
// A questão principal é como o driver do Node.js (pg) lida com a conversão de DATE para objeto Date do JS.
// Se o driver converte DATE para um objeto Date do JS à meia-noite UTC,
// então o problema de timezone pode ocorrer quando esse objeto Date é serializado para JSON.
// Forçar TO_CHAR na query é a forma mais segura de garantir a string.

router.get('/com-cliente', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        cs.id,
        cs.cliente_id,
        cs.nome,
        cs.email,
        cs.cpf,
        TO_CHAR(cs.data_nascimento, 'YYYY-MM-DD') as data_nascimento, // Formatação aqui
        cs.cargo,
        cs.created_at,
        cs.updated_at,
        c.nome as cliente_nome, 
        c.codigo as cliente_codigo 
      FROM contatos_societarios cs
      JOIN clientes c ON cs.cliente_id = c.id
      ORDER BY c.nome, cs.nome
    `);
    res.json({ success: true, contatos: result.rows || [] });
  } catch (error) {
    console.error('Erro ao buscar contatos societários com dados do cliente:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor ao buscar contatos com dados do cliente.', error: error.message });
  }
});

router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        cs.id,
        cs.cliente_id,
        cs.nome,
        cs.email,
        cs.cpf,
        TO_CHAR(cs.data_nascimento, 'YYYY-MM-DD') as data_nascimento, // Formatação aqui
        cs.cargo,
        cs.created_at,
        cs.updated_at,
        c.nome as cliente_nome, 
        c.codigo as cliente_codigo 
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

router.get('/cliente/:cliente_id', auth, async (req, res) => {
  try {
    const { cliente_id } = req.params;
    const result = await pool.query(
      `SELECT 
          cs.id,
          cs.cliente_id,
          cs.nome,
          cs.email,
          cs.cpf,
          TO_CHAR(cs.data_nascimento, 'YYYY-MM-DD') as data_nascimento, // Formatação aqui
          cs.cargo,
          cs.created_at,
          cs.updated_at,
          c.nome as cliente_nome, 
          c.codigo as cliente_codigo 
        FROM contatos_societarios cs 
        JOIN clientes c ON cs.cliente_id = c.id 
        WHERE cs.cliente_id = $1 
        ORDER BY cs.nome`,
      [cliente_id]
    );
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

    // data_nascimento deve chegar como YYYY-MM-DD do frontend, o que é ok para o tipo DATE do PG
    if (!cliente_id || !nome || !email || !cpf || !data_nascimento || !cargo) {
      return res.status(400).json({ success: false, message: 'Todos os campos são obrigatórios.' });
    }
    
    const result = await pool.query(
      'INSERT INTO contatos_societarios (cliente_id, nome, email, cpf, data_nascimento, cargo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, cliente_id, nome, email, cpf, TO_CHAR(data_nascimento, \'YYYY-MM-DD\') as data_nascimento, cargo, created_at, updated_at',
      [cliente_id, nome, email, cpf, data_nascimento, cargo]
    );
    const novoContato = result.rows[0];

    if (req.user && req.user.userId && req.user.email) {
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
         if (error.constraint && error.constraint.includes('email_cliente_unique')) { 
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
    const { nome, email, cpf, data_nascimento, cargo } = req.body; 

    if (!nome || !email || !cpf || !data_nascimento || !cargo) {
      return res.status(400).json({ success: false, message: 'Todos os campos (nome, email, cpf, data_nascimento, cargo) são obrigatórios para atualização.' });
    }

    const result = await pool.query(
      'UPDATE contatos_societarios SET nome = $1, email = $2, cpf = $3, data_nascimento = $4, cargo = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6 RETURNING id, cliente_id, nome, email, cpf, TO_CHAR(data_nascimento, \'YYYY-MM-DD\') as data_nascimento, cargo, created_at, updated_at',
      [nome, email, cpf, data_nascimento, cargo, id]
    );

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
         if (error.constraint && error.constraint.includes('email_cliente_unique')) { 
             return res.status(409).json({ success: false, message: 'E-mail já cadastrado para outro contato neste cliente.', errorDetail: error.message });
        }
    }
    res.status(500).json({ success: false, message: 'Erro interno do servidor ao atualizar contato.', errorDetail: error.message });
  }
});

// DELETE contato societário (protegido)
// (Não precisa formatar data aqui pois estamos apenas excluindo)
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    const contatoParaExcluirResult = await pool.query('SELECT nome, email, cliente_id FROM contatos_societarios WHERE id = $1', [id]);
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