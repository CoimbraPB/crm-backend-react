const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth'); // Assuming this path is correct
const pool = require('../config/database'); // Assuming this path is correct

// Permissions for managing leads
const LEAD_MANAGEMENT_PERMISSIONS = ['Gerente', 'Dev', 'CRM'];

// Middleware to check for lead management permissions
const canManageLeads = (req, res, next) => {
    if (!req.user || !req.user.permissao || !LEAD_MANAGEMENT_PERMISSIONS.includes(req.user.permissao)) {
        return res.status(403).json({ success: false, message: 'Acesso negado. Permissão insuficiente.' });
    }
    next();
};

// GET all leads with filters
router.get('/', authMiddleware, canManageLeads, async (req, res) => {
    const { empresa, mes, origem, etapaFunil } = req.query;
    try {
        let queryText = 'SELECT * FROM leads_comerciais WHERE 1=1';
        const queryParams = [];

        if (empresa) {
            queryParams.push(`%${empresa}%`);
            queryText += ` AND empresa ILIKE $${queryParams.length}`;
        }
        if (mes) {
            queryParams.push(mes);
            queryText += ` AND EXTRACT(MONTH FROM "contatoInicial") = $${queryParams.length}`;
        }
        if (origem) {
            queryParams.push(origem);
            queryText += ` AND origem = $${queryParams.length}`;
        }
        if (etapaFunil) {
            queryParams.push(etapaFunil);
            queryText += ` AND "etapaFunil" = $${queryParams.length}`;
        }

        queryText += ' ORDER BY "contatoInicial" DESC';

        const result = await pool.query(queryText, queryParams);
        res.json(result.rows);
    } catch (error) {
        console.error('Erro ao buscar leads comerciais:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});

// POST a new lead
router.post('/', authMiddleware, canManageLeads, async (req, res) => {
    const { ...leadData } = req.body;
    if (!leadData.contatoInicial) {
        leadData.contatoInicial = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    }
    try {
        const allowedFields = ['contatoInicial', 'origem', 'classificacao', 'empresa', 'localidade', 'reuniao', 'dataReuniao', 'ultimaproposta', 'statusProposta', 'followUp', 'etapaFunil', 'pontoFocal', 'telefone', 'email', 'numReunioes', 'tipo', 'formato', 'numPropostas', 'status', 'numFollowUps', 'canal', 'observacoes', 'proximaAcao'];
        const fields = Object.keys(leadData).filter(key => allowedFields.includes(key));
        const values = fields.map(key => leadData[key]);
        const placeholders = fields.map((field, i) => {
            if (field === 'ultimaproposta') {
                return `$${i + 1}::VARCHAR`;
            }
            return `$${i + 1}`;
        }).join(', ');

        const queryText = `INSERT INTO leads_comerciais (${fields.map(f => `"${f}"`).join(', ')}) VALUES (${placeholders}) RETURNING *`;
        
        const result = await pool.query(queryText, values);
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Erro ao criar lead comercial:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});

// PUT (update) a lead
router.put('/:id', authMiddleware, canManageLeads, async (req, res) => {
    const { id } = req.params;
    const { ...leadData } = req.body;
    try {
        const allowedFields = ['contatoInicial', 'origem', 'classificacao', 'empresa', 'localidade', 'reuniao', 'dataReuniao', 'ultimaproposta', 'statusProposta', 'followUp', 'etapaFunil', 'pontoFocal', 'telefone', 'email', 'numReunioes', 'tipo', 'formato', 'numPropostas', 'status', 'numFollowUps', 'canal', 'observacoes', 'proximaAcao'];
        const fields = Object.keys(leadData).filter(key => allowedFields.includes(key));
        const querySetParts = fields.map((key, index) => {
            if (key === 'ultimaproposta') {
                return `"${key}" = $${index + 1}::VARCHAR`;
            }
            return `"${key}" = $${index + 1}`;
        });
        const queryValues = fields.map(key => leadData[key]);
        queryValues.push(id);

        const queryText = `UPDATE leads_comerciais SET ${querySetParts.join(', ')} WHERE id = $${queryValues.length} RETURNING *`;

        const result = await pool.query(queryText, queryValues);
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Lead não encontrado.' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error(`Erro ao atualizar lead ${id}:`, error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});

// DELETE a lead
router.delete('/:id', authMiddleware, canManageLeads, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM leads_comerciais WHERE id = $1 RETURNING *', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Lead não encontrado.' });
        }
        res.json({ success: true, message: 'Lead excluído com sucesso.' });
    } catch (error) {
        console.error(`Erro ao excluir lead ${id}:`, error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});

module.exports = router;
