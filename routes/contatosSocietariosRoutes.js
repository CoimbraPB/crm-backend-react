const express = require('express');
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService'); // Ajuste o caminho se necessário

const router = express.Router();

// Função auxiliar para formatar datas para o frontend (se necessário)
const formatContatoSocietario = (contato) => {
  if (!contato) return null;
  return {
    ...contato,
    data_nascimento: contato.data_nascimento ? new Date(contato.data_nascimento).toISOString().split('T')[0] : null, // Formato YYYY-MM-DD
    created_at: contato.created_at ? new Date(contato.created_at).toISOString() : null,
    updated_at: contato.updated_at ? new Date(contato.updated_at).toISOString() : null,
  };
};

// GET /contatos-societarios - Listar contatos com filtros
router.get('/', auth, async (req, res) => {
    try {
        const { cliente_id, search, data_nascimento_inicio, data_nascimento_fim, mes_aniversario } = req.query;
        
        let baseQuery = `
            SELECT cs.*, c.nome as nome_cliente, c.codigo as codigo_cliente 
            FROM contatos_societarios cs 
            JOIN clientes c ON cs.cliente_id = c.id 
            WHERE 1=1
        `;
        const queryParams = [];
        let paramIndex = 1;

        if (cliente_id) {
            baseQuery += ` AND cs.cliente_id = $${paramIndex++}`;
            queryParams.push(parseInt(cliente_id));
        }
        if (search) {
            // Busca por nome do contato, CPF do contato, nome do cliente ou código do cliente
            baseQuery += ` AND (cs.nome ILIKE $${paramIndex} OR cs.cpf ILIKE $${paramIndex} OR c.nome ILIKE $${paramIndex} OR c.codigo ILIKE $${paramIndex})`;
            queryParams.push(`%${search}%`);
            paramIndex++; 
        }
        if (data_nascimento_inicio && data_nascimento_fim) {
            baseQuery += ` AND cs.data_nascimento BETWEEN $${paramIndex++} AND $${paramIndex++}`;
            queryParams.push(data_nascimento_inicio, data_nascimento_fim);
        } else if (data_nascimento_inicio) {
            baseQuery += ` AND cs.data_nascimento >= $${paramIndex++}`;
            queryParams.push(data_nascimento_inicio);
        } else if (data_nascimento_fim) {
            baseQuery += ` AND cs.data_nascimento <= $${paramIndex++}`;
            queryParams.push(data_nascimento_fim);
        }
        if (mes_aniversario) {
            const mes = parseInt(mes_aniversario);
            if (mes >= 1 && mes <= 12) {
                baseQuery += ` AND EXTRACT(MONTH FROM cs.data_nascimento) = $${paramIndex++}`;
                queryParams.push(mes);
            } else {
                return res.status(400).json({ message: 'Mês de aniversário inválido. Use um valor entre 1 e 12.' });
            }
        }
        
        baseQuery += ' ORDER BY cs.nome ASC';

        const result = await pool.query(baseQuery, queryParams);
        res.json(result.rows.map(formatContatoSocietario));

    } catch (error) {
        console.error('Erro ao listar contatos societários:', error);
        // Adapte os tipos de ação e entidade conforme definido no seu auditLogService
        // await logAction(req.user?.userId, req.user?.email, 'CONTATO_SOCIETARIO_LIST_FAILED', 'ContatoSocietario', null, { error: error.message, query: req.query });
        res.status(500).json({ message: 'Erro interno do servidor ao listar contatos societários.' });
    }
});

// POST /contatos-societarios - Criar um novo contato societário
router.post('/', auth, async (req, res) => {
    try {
        const { cliente_id, nome, cpf, data_nascimento, email, telefone, cargo } = req.body;
        const userId = req.user.userId; // Assumindo que o middleware auth adiciona req.user.userId

        if (!cliente_id || !nome || !cpf || !data_nascimento) {
            return res.status(400).json({ message: 'ID do Cliente, Nome, CPF e Data de Nascimento são obrigatórios.' });
        }
        // Validação simples de formato de CPF (11 ou 14 dígitos, considerando máscara)
        const cpfLimpo = cpf.replace(/\D/g, '');
        if (!/^\d{11}$/.test(cpfLimpo)) {
             return res.status(400).json({ message: 'Formato de CPF inválido.' });
        }

        const result = await pool.query(
            `INSERT INTO contatos_societarios (cliente_id, nome, cpf, data_nascimento, email, telefone, cargo, created_by_user_id, updated_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
            [parseInt(cliente_id), nome, cpf, data_nascimento, email, telefone, cargo, userId]
        );
        const novoContato = result.rows[0];

        // await logAction(userId, req.user.email, 'CONTATO_SOCIETARIO_CREATED', 'ContatoSocietario', novoContato.id, { data: novoContato });
        res.status(201).json(formatContatoSocietario(novoContato));

    } catch (error) {
        console.error('Erro ao criar contato societário:', error);
        if (error.code === '23505' && error.constraint === 'contatos_societarios_cpf_key') { 
            // await logAction(req.user?.userId, req.user?.email, 'CONTATO_SOCIETARIO_CREATE_FAILED_DUPLICATE_CPF', 'ContatoSocietario', null, { error: error.message, data: req.body });
            return res.status(409).json({ message: 'CPF já cadastrado.' });
        }
        // await logAction(req.user?.userId, req.user?.email, 'CONTATO_SOCIETARIO_CREATE_FAILED', 'ContatoSocietario', null, { error: error.message, data: req.body });
        res.status(500).json({ message: 'Erro interno do servidor ao criar contato societário.' });
    }
});

// PUT /contatos-societarios/:id - Atualizar um contato societário
router.put('/:id', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { nome, cpf, data_nascimento, email, telefone, cargo, cliente_id } = req.body; // cliente_id é opcional aqui, geralmente não se muda o "dono" do contato.
        const userId = req.user.userId;

        if (!nome || !cpf || !data_nascimento) {
            return res.status(400).json({ message: 'Nome, CPF e Data de Nascimento são obrigatórios.' });
        }
        const cpfLimpo = cpf.replace(/\D/g, '');
        if (!/^\d{11}$/.test(cpfLimpo)) {
             return res.status(400).json({ message: 'Formato de CPF inválido.' });
        }

        // Se cliente_id for fornecido, inclua na atualização. Caso contrário, não.
        let updateQuery = `
            UPDATE contatos_societarios 
            SET nome = $1, cpf = $2, data_nascimento = $3, email = $4, telefone = $5, cargo = $6, updated_by_user_id = $7`;
        const queryParams = [nome, cpf, data_nascimento, email, telefone, cargo, userId];
        let paramIndex = 8;

        if (cliente_id !== undefined) { // Permite alterar cliente_id se fornecido
            updateQuery += `, cliente_id = $${paramIndex++}`;
            queryParams.push(parseInt(cliente_id));
        }
        
        updateQuery += ` WHERE id = $${paramIndex} RETURNING *`;
        queryParams.push(parseInt(id));
        
        const result = await pool.query(updateQuery, queryParams);

        if (result.rows.length === 0) {
            // await logAction(req.user?.userId, req.user?.email, 'CONTATO_SOCIETARIO_UPDATE_FAILED_NOT_FOUND', 'ContatoSocietario', id, { data: req.body });
            return res.status(404).json({ message: 'Contato societário não encontrado.' });
        }
        const contatoAtualizado = result.rows[0];
        // await logAction(userId, req.user.email, 'CONTATO_SOCIETARIO_UPDATED', 'ContatoSocietario', contatoAtualizado.id, { data: contatoAtualizado });
        res.json(formatContatoSocietario(contatoAtualizado));

    } catch (error) {
        console.error('Erro ao atualizar contato societário:', error);
        if (error.code === '23505' && error.constraint === 'contatos_societarios_cpf_key') {
            // await logAction(req.user?.userId, req.user?.email, 'CONTATO_SOCIETARIO_UPDATE_FAILED_DUPLICATE_CPF', 'ContatoSocietario', req.params.id, { error: error.message, data: req.body });
            return res.status(409).json({ message: 'CPF já cadastrado para outro contato.' });
        }
        // await logAction(req.user?.userId, req.user?.email, 'CONTATO_SOCIETARIO_UPDATE_FAILED', 'ContatoSocietario', req.params.id, { error: error.message, data: req.body });
        res.status(500).json({ message: 'Erro interno do servidor ao atualizar contato societário.' });
    }
});

// DELETE /contatos-societarios/:id - Excluir um contato societário
router.delete('/:id', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.userId;

        const result = await pool.query('DELETE FROM contatos_societarios WHERE id = $1 RETURNING *', [parseInt(id)]);

        if (result.rows.length === 0) {
            // await logAction(req.user?.userId, req.user?.email, 'CONTATO_SOCIETARIO_DELETE_FAILED_NOT_FOUND', 'ContatoSocietario', id);
            return res.status(404).json({ message: 'Contato societário não encontrado.' });
        }
        // await logAction(userId, req.user.email, 'CONTATO_SOCIETARIO_DELETED', 'ContatoSocietario', id, { deletedData: result.rows[0] });
        res.status(204).send(); // No content

    } catch (error) {
        console.error('Erro ao excluir contato societário:', error);
        // await logAction(req.user?.userId, req.user?.email, 'CONTATO_SOCIETARIO_DELETE_FAILED', 'ContatoSocietario', req.params.id, { error: error.message });
        res.status(500).json({ message: 'Erro interno do servidor ao excluir contato societário.' });
    }
});

module.exports = router;