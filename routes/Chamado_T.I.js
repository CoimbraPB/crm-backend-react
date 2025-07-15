const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const pool = require('../config/database');

const PERMISSOES_TI = ['Tecnologia']; // Apenas 'Tecnologia' receberá notificações

const criarNotificacao = async (tipo_notificacao, mensagem, usuario_destino_id, referencia_id = null, link_frontend = null, criado_por_id = null) => {
    try {
        await pool.query(
            'INSERT INTO notificacoes (usuario_destino_id, tipo_notificacao, mensagem, referencia_id, link_frontend, criado_por_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [usuario_destino_id, tipo_notificacao, mensagem, referencia_id, link_frontend, criado_por_id]
        );
    } catch (error) {
        console.error('Erro ao criar notificação:', error);
    }
};

// Criar um novo chamado
router.post('/', authMiddleware, async (req, res) => {
    const { titulo, descricao, categoria, prioridade } = req.body;
    const usuario_solicitante_id = req.user.userId;
    const nomeSolicitante = req.user.nome || `Usuário ID ${usuario_solicitante_id}`;

    if (!usuario_solicitante_id) {
        return res.status(401).json({ success: false, message: 'Falha na autenticação: ID do usuário não determinado.' });
    }

    if (!titulo || !descricao || !categoria || !prioridade) {
        return res.status(400).json({ success: false, message: 'Todos os campos são obrigatórios.' });
    }

    try {
        const result = await pool.query(
            'INSERT INTO chamados_ti (usuario_solicitante_id, titulo, descricao, categoria, prioridade) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [usuario_solicitante_id, titulo, descricao, categoria, prioridade]
        );
        const novoChamado = result.rows[0];

        const usuariosTiResult = await pool.query("SELECT id FROM usuarios WHERE permissao = ANY($1::varchar[])", [PERMISSOES_TI]);

        for (const tiUser of usuariosTiResult.rows) {
            await criarNotificacao(
                'Novo Chamado T.I.',
                `Novo chamado de T.I. de ${nomeSolicitante}: "${titulo}"`,
                tiUser.id,
                novoChamado.id,
                `/gerenciar-chamados-ti?id=${novoChamado.id}`,
                usuario_solicitante_id
            );
        }

        res.status(201).json({ success: true, message: 'Chamado de T.I. criado com sucesso!', chamado: novoChamado });
    } catch (error) {
        console.error('Erro ao criar chamado de T.I.:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor ao criar chamado.' });
    }
});

// Listar os chamados do usuário logado
router.get('/minhas', authMiddleware, async (req, res) => {
    const usuario_solicitante_id = req.user.userId;
    if (!usuario_solicitante_id) {
        return res.status(401).json({ success: false, message: 'Falha na autenticação: ID do usuário não determinado.' });
    }
    try {
        const result = await pool.query(
            'SELECT * FROM chamados_ti WHERE usuario_solicitante_id = $1 ORDER BY data_abertura DESC',
            [usuario_solicitante_id]
        );
        res.json({ success: true, chamados: result.rows });
    } catch (error) {
        console.error('Erro ao buscar meus chamados de T.I.:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});

// Listar todos os chamados para a equipe de T.I. (com filtros)
router.get('/gerenciamento', authMiddleware, async (req, res) => {
    // Verificação de permissão REMOVIDA
    
    const { status, categoria, prioridade, dataInicio, dataFim, nome } = req.query;

    let queryText = `
        SELECT c.*, u.nome AS nome_solicitante, u.setor AS setor_solicitante
        FROM chamados_ti c
        JOIN usuarios u ON c.usuario_solicitante_id = u.id
    `;
    const queryParams = [];
    const conditions = [];

    if (status) {
        queryParams.push(status);
        conditions.push(`c.status = $${queryParams.length}`);
    }
    if (categoria) {
        queryParams.push(categoria);
        conditions.push(`c.categoria = $${queryParams.length}`);
    }
    if (prioridade) {
        queryParams.push(prioridade);
        conditions.push(`c.prioridade = $${queryParams.length}`);
    }
    if (dataInicio) {
        queryParams.push(dataInicio);
        conditions.push(`c.data_abertura >= $${queryParams.length}`);
    }
    if (dataFim) {
        queryParams.push(dataFim);
        conditions.push(`c.data_abertura <= $${queryParams.length}`);
    }
    if (nome && nome.trim() !== '') {
        queryParams.push(`%${nome.trim()}%`);
        conditions.push(`u.nome ILIKE $${queryParams.length}`);
    }

    if (conditions.length > 0) {
        queryText += ' WHERE ' + conditions.join(' AND ');
    }
    queryText += ' ORDER BY c.data_abertura DESC';

    try {
        const result = await pool.query(queryText, queryParams);
        res.json({ success: true, chamados: result.rows });
    } catch (error) {
        console.error('Erro ao buscar todos os chamados de T.I.:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});

// Atualizar o status de um chamado
router.put('/:id/status', authMiddleware, async (req, res) => {


    const { id } = req.params;
    const { status } = req.body;
    const respondido_por_id = req.user.userId;
    const nomeModificador = req.user.nome || `Usuário ID ${respondido_por_id}`;

    if (!status || !['Aberto', 'Em andamento', 'Fechado'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Status inválido fornecido.' });
    }

    try {
        const result = await pool.query(
            'UPDATE chamados_ti SET status = $1, respondido_por_id = $2, data_ultima_modificacao = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
            [status, respondido_por_id, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Chamado de T.I. não encontrado.' });
        }

        const chamadoAtualizado = result.rows[0];

        await criarNotificacao(
            'Status do Chamado T.I. Atualizado',
            `O status do seu chamado "${chamadoAtualizado.titulo}" foi atualizado para: ${status} por ${nomeModificador}.`,
            chamadoAtualizado.usuario_solicitante_id,
            chamadoAtualizado.id,
            `/solicitar-chamados-ti?id=${chamadoAtualizado.id}`,
            respondido_por_id
        );

        res.json({ success: true, message: 'Status do chamado de T.I. atualizado com sucesso!', chamado: chamadoAtualizado });
    } catch (error) {
        console.error('Erro ao atualizar status do chamado de T.I.:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor ao atualizar status.' });
    }
});

// Adicionar ou atualizar uma observação em um chamado
router.put('/:id/observacao', authMiddleware, async (req, res) => {
    // Verificação de permissão


    const { id } = req.params;
    const { observacao } = req.body;
    const respondido_por_id = req.user.userId;

    try {
        const result = await pool.query(
            'UPDATE chamados_ti SET observacao = $1, respondido_por_id = $2, data_ultima_modificacao = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
            [observacao, respondido_por_id, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Chamado de T.I. não encontrado.' });
        }

        const chamadoAtualizado = result.rows[0];

        res.json({ success: true, message: 'Observação do chamado de T.I. atualizada com sucesso!', chamado: chamadoAtualizado });
    } catch (error) {
        console.error('Erro ao atualizar observação do chamado de T.I.:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor ao atualizar observação.' });
    }
});


module.exports = router;