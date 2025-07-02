const express = require('express');
const router = express.Router();
const pool = require('../config/database'); // Seu pool de conexão PG
const auth = require('../middleware/auth'); // Seu middleware de autenticação
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService'); // Seu serviço de log

const PERMITTED_ROLES = ['Operador', 'Gerente', 'Gestor', 'Dev']; // Adicione 'Dev' ou outros roles se necessário

// Middleware para verificar permissões específicas para estas rotas
const checkPermission = (req, res, next) => {
    if (!req.user || !PERMITTED_ROLES.includes(req.user.permissao)) {
        return res.status(403).json({ success: false, message: 'Acesso negado. Permissão insuficiente.' });
    }
    next();
};

// --- ROTAS PARA CONTATOS SOCIETÁRIOS ---

// GET /api/contatos-societarios/cliente/:clienteId - Listar contatos de um cliente específico
router.get('/cliente/:clienteId', auth, checkPermission, async (req, res) => {
    const { clienteId } = req.params;
    try {
        const result = await pool.query(
            'SELECT * FROM contatos_societarios WHERE cliente_id = $1 ORDER BY nome ASC',
            [clienteId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Erro ao listar contatos societários do cliente:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao buscar contatos societários.' });
    }
});

// POST /api/contatos-societarios/cliente/:clienteId - Criar um novo contato para um cliente
router.post('/cliente/:clienteId', auth, checkPermission, async (req, res) => {
    const { clienteId } = req.params;
    const { nome, cpf, data_nascimento, email, telefone, cargo } = req.body;
    const userId = req.user.userId;

    if (!nome || !cpf || !data_nascimento) {
        return res.status(400).json({ success: false, message: 'Nome, CPF e Data de Nascimento são obrigatórios.' });
    }
    // Adicione mais validações aqui (formato do CPF, data, etc.)

    try {
        const result = await pool.query(
            `INSERT INTO contatos_societarios 
             (cliente_id, nome, cpf, data_nascimento, email, telefone, cargo, created_by_user_id, updated_by_user_id) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
            [clienteId, nome, cpf, data_nascimento, email, telefone, cargo, userId]
        );
        const novoContato = result.rows[0];

        // Audit log
        await logAction(
            userId,
            req.user.email,
            'CONTATO_SOCIETARIO_CREATED', // Defina este tipo no seu auditLogService
            'ContatoSocietario', // Defina este tipo no seu auditLogService
            novoContato.id,
            { contatoData: novoContato }
        );

        res.status(201).json(novoContato);
    } catch (error) {
        console.error('Erro ao criar contato societário:', error);
        if (error.constraint === 'contatos_societarios_cpf_key') { // Exemplo se você tem uma constraint unique no CPF
             return res.status(409).json({ success: false, message: 'CPF já cadastrado.' });
        }
        res.status(500).json({ success: false, message: 'Erro interno ao criar contato societário.' });
    }
});

// PUT /api/contatos-societarios/:contatoId - Atualizar um contato societário
router.put('/:contatoId', auth, checkPermission, async (req, res) => {
    const { contatoId } = req.params;
    const { nome, cpf, data_nascimento, email, telefone, cargo } = req.body; // Não permitir alterar cliente_id aqui
    const userId = req.user.userId;

    if (!nome || !cpf || !data_nascimento) {
        return res.status(400).json({ success: false, message: 'Nome, CPF e Data de Nascimento são obrigatórios.' });
    }
    // Adicione mais validações

    try {
        const contatoExistente = await pool.query('SELECT * FROM contatos_societarios WHERE id = $1', [contatoId]);
        if (contatoExistente.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Contato societário não encontrado.' });
        }

        const result = await pool.query(
            `UPDATE contatos_societarios 
             SET nome = $1, cpf = $2, data_nascimento = $3, email = $4, telefone = $5, cargo = $6, updated_at = CURRENT_TIMESTAMP, updated_by_user_id = $7 
             WHERE id = $8 RETURNING *`,
            [nome, cpf, data_nascimento, email, telefone, cargo, userId, contatoId]
        );
        const contatoAtualizado = result.rows[0];

        // Audit log
        await logAction(
            userId,
            req.user.email,
            'CONTATO_SOCIETARIO_UPDATED',
            'ContatoSocietario',
            contatoAtualizado.id,
            { oldData: contatoExistente.rows[0], newData: contatoAtualizado }
        );

        res.json(contatoAtualizado);
    } catch (error) {
        console.error('Erro ao atualizar contato societário:', error);
         if (error.constraint === 'contatos_societarios_cpf_key') {
             return res.status(409).json({ success: false, message: 'CPF já cadastrado.' });
        }
        res.status(500).json({ success: false, message: 'Erro interno ao atualizar contato societário.' });
    }
});

// DELETE /api/contatos-societarios/:contatoId - Excluir um contato societário
router.delete('/:contatoId', auth, checkPermission, async (req, res) => {
    const { contatoId } = req.params;
    const userId = req.user.userId;

    try {
        const contatoExistente = await pool.query('SELECT * FROM contatos_societarios WHERE id = $1', [contatoId]);
        if (contatoExistente.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Contato societário não encontrado.' });
        }

        await pool.query('DELETE FROM contatos_societarios WHERE id = $1', [contatoId]);

        // Audit log
        await logAction(
            userId,
            req.user.email,
            'CONTATO_SOCIETARIO_DELETED',
            'ContatoSocietario',
            contatoId,
            { deletedData: contatoExistente.rows[0] }
        );

        res.status(200).json({ success: true, message: 'Contato societário excluído com sucesso.' });
    } catch (error) {
        console.error('Erro ao excluir contato societário:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao excluir contato societário.' });
    }
});

// GET /api/contatos-societarios/filtrados - Listar contatos com filtros (para aniversariantes e busca geral)
// Query Params: clienteNome, clienteCodigo, contatoNome, dataNascInicio, dataNascFim, mesAniversario
router.get('/filtrados', auth, checkPermission, async (req, res) => {
    const { clienteNome, clienteCodigo, contatoNome, dataNascInicio, dataNascFim, mesAniversario } = req.query;
    try {
        let queryText = `
            SELECT cs.*, c.nome as nome_cliente, c.codigo as codigo_cliente, c.razao_social as razao_social_cliente
            FROM contatos_societarios cs
            JOIN clientes c ON cs.cliente_id = c.id
            WHERE 1=1
        `;
        const queryParams = [];
        let paramIndex = 1;

        if (clienteNome) {
            queryText += ` AND c.nome ILIKE $${paramIndex++}`;
            queryParams.push(`%${clienteNome}%`);
        }
        if (clienteCodigo) {
            queryText += ` AND c.codigo ILIKE $${paramIndex++}`;
            queryParams.push(`%${clienteCodigo}%`);
        }
        if (contatoNome) {
            queryText += ` AND cs.nome ILIKE $${paramIndex++}`;
            queryParams.push(`%${contatoNome}%`);
        }
        if (dataNascInicio && dataNascFim) {
            queryText += ` AND cs.data_nascimento BETWEEN $${paramIndex++} AND $${paramIndex++}`;
            queryParams.push(dataNascInicio, dataNascFim);
        } else if (dataNascInicio) {
            queryText += ` AND cs.data_nascimento >= $${paramIndex++}`;
            queryParams.push(dataNascInicio);
        } else if (dataNascFim) {
            queryText += ` AND cs.data_nascimento <= $${paramIndex++}`;
            queryParams.push(dataNascFim);
        }
        if (mesAniversario) { // Formato MM (ex: '01' para Janeiro)
            queryText += ` AND EXTRACT(MONTH FROM cs.data_nascimento) = $${paramIndex++}`;
            queryParams.push(parseInt(mesAniversario, 10));
        }

        queryText += ' ORDER BY c.nome ASC, cs.nome ASC';

        const result = await pool.query(queryText, queryParams);
        res.json(result.rows);
    } catch (error) {
        console.error('Erro ao listar contatos societários filtrados:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao buscar contatos societários filtrados.' });
    }
});


// GET /api/contatos-societarios/exportar - Exportar contatos
// Query Params: tipo (todos | aniversariantes), formato (excel | pdf), mes (MM, se aniversariantes)
router.get('/exportar', auth, checkPermission, async (req, res) => {
    const { tipo, formato, mes } = req.query;

    try {
        let queryText = `
            SELECT 
                c.nome as nome_cliente, 
                cs.nome as nome_contato, 
                cs.cargo as cargo_contato, 
                cs.email as email_contato, 
                cs.telefone as telefone_contato, 
                cs.data_nascimento as data_nascimento_contato
            FROM contatos_societarios cs
            JOIN clientes c ON cs.cliente_id = c.id
            WHERE 1=1
        `;
        const queryParams = [];
        let paramIndex = 1;

        if (tipo === 'aniversariantes' && mes) {
            queryText += ` AND EXTRACT(MONTH FROM cs.data_nascimento) = $${paramIndex++}`;
            queryParams.push(parseInt(mes, 10));
        }

        queryText += ' ORDER BY c.nome ASC, cs.nome ASC';
        const result = await pool.query(queryText, queryParams);

        if (formato === 'excel') {
            console.log('Gerando Excel com os dados:', result.rows);
            // Implementar lógica de geração de Excel aqui (ex: com exceljs)
            // res.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            // res.header('Content-Disposition', 'attachment; filename="contatos.xlsx"');
            // const buffer = await gerarExcel(result.rows); // Função hipotética
            // res.send(buffer);
            res.status(501).json({ message: 'Exportação Excel a ser implementada', data_count: result.rows.length });
        } else if (formato === 'pdf') {
            console.log('Gerando PDF com os dados:', result.rows);
            // Implementar lógica de geração de PDF aqui (ex: com pdfmake ou puppeteer)
            // res.header('Content-Type', 'application/pdf');
            // res.header('Content-Disposition', 'attachment; filename="contatos.pdf"');
            // const buffer = await gerarPdf(result.rows); // Função hipotética
            // res.send(buffer);
            res.status(501).json({ message: 'Exportação PDF a ser implementada', data_count: result.rows.length });
        } else {
            // Fallback para JSON se formato não especificado ou inválido, ou para depuração
            res.json(result.rows);
        }

    } catch (error) {
        console.error('Erro ao exportar contatos societários:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao exportar contatos societários.' });
    }
});

module.exports = router;