const express = require('express');
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');

const router = express.Router();

// 🔒 Permissão: Apenas Gestor, Gerente, Dev e RH podem criar solicitações
const authorizeCreate = (req, res, next) => {
    const allowed = ['Gestor', 'Gerente', 'Dev', 'RH'];
    if (req.user && allowed.includes(req.user.permissao)) {
        next();
    } else {
        res.status(403).json({ success: false, message: 'Acesso não autorizado para criar solicitações.' });
    }
};

// 👁️ Permissão para visualizar (sem alterações aqui)
const authorizeView = (req, res, next) => {
    const allowedToViewAll = ['Gestor', 'Gerente', 'Dev', 'RH'];
    if (req.user && (allowedToViewAll.includes(req.user.permissao) || req.params.userId == req.user.userId)) {
        next();
    } else {
        res.status(403).json({ success: false, message: 'Acesso não autorizado para visualizar estas informações.' });
    }
};


// --- ROTAS ---

// POST - Criar uma nova solicitação
router.post('/', auth, authorizeCreate, async (req, res) => {
    const { usuario_solicitante_id, tipo_solicitacao, nome_instituicao, valor_solicitado, data_solicitacao, observacao } = req.body;
    const gestor_id = req.user.userId;

    if (!usuario_solicitante_id || !tipo_solicitacao || !nome_instituicao || !valor_solicitado || !data_solicitacao) {
        return res.status(400).json({ success: false, message: 'Todos os campos obrigatórios devem ser preenchidos.' });
    }

    try {
        const query = `
            INSERT INTO solicitacoes_bolsas_cursos
            (usuario_solicitante_id, gestor_id, tipo_solicitacao, nome_instituicao, valor_solicitado, data_solicitacao, observacao)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *;
        `;
        const values = [usuario_solicitante_id, gestor_id, tipo_solicitacao, nome_instituicao, valor_solicitado, data_solicitacao, observacao];

        const result = await pool.query(query, values);
        const newSolicitacao = result.rows[0];

        // Opcional: Log de auditoria
        // await logAction(...);

        res.status(201).json({ success: true, solicitacao: newSolicitacao });
    } catch (error) {
        console.error('Erro ao criar solicitação:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});

// GET - Listar todas as solicitações (para Gestores, Gerentes, Dev, RH)
router.get('/', auth, authorizeCreate, async (req, res) => {
    try {
        const query = `
            SELECT s.*, u.nome AS nome_solicitante, g.nome AS nome_gestor
            FROM solicitacoes_bolsas_cursos s
            JOIN usuarios u ON s.usuario_solicitante_id = u.id
            JOIN usuarios g ON s.gestor_id = g.id
            ORDER BY s.data_solicitacao DESC;
        `;
        const result = await pool.query(query);
        res.json({ success: true, solicitacoes: result.rows });
    } catch (error) {
        console.error('Erro ao listar solicitações:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});

// GET - Listar minhas solicitações (para o usuário logado)
router.get('/minhas', auth, async (req, res) => {
    const usuarioId = req.user.userId;
    try {
        const query = `
            SELECT s.*, g.nome AS nome_gestor
            FROM solicitacoes_bolsas_cursos s
            JOIN usuarios g ON s.gestor_id = g.id
            WHERE s.usuario_solicitante_id = $1
            ORDER BY s.data_solicitacao DESC;
        `;
        const result = await pool.query(query, [usuarioId]);
        res.json({ success: true, solicitacoes: result.rows });
    } catch (error) {
        console.error('Erro ao listar minhas solicitações:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});


module.exports = router;