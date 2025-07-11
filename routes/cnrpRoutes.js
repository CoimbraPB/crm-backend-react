const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth'); // Certifique-se que o caminho está correto
const pool = require('../config/database'); // Certifique-se que o caminho está correto

const PERMISSOES_RH = ['RH', 'Dev']; // Ajuste se necessário

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

router.post('/', authMiddleware, async (req, res) => {
     console.log('📦 Conteúdo de req.user:', req.user); // <-- Aqui
    const { data_ponto, entrada1, saida1, entrada2, saida2, motivo } = req.body;
    const usuario_solicitante_id = req.user.id;
    const nomeSolicitante = req.user.nome || `Usuário ID ${usuario_solicitante_id}`;

    if (!data_ponto || !motivo) {
        return res.status(400).json({ success: false, message: 'Data do ponto e motivo são obrigatórios.' });
    }

    try {
        const result = await pool.query(
            'INSERT INTO solicitacoes_cnrp (usuario_solicitante_id, data_ponto, entrada1, saida1, entrada2, saida2, motivo) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [usuario_solicitante_id, data_ponto, entrada1 || null, saida1 || null, entrada2 || null, saida2 || null, motivo]
        );
        const novaSolicitacao = result.rows[0];

        const usuariosRhResult = await pool.query("SELECT id FROM usuarios WHERE permissao = ANY($1::varchar[])", [PERMISSOES_RH]);
        
        for (const rhUser of usuariosRhResult.rows) {
            await criarNotificacao(
                'NOVA_CNRP_PARA_RH',
                `Nova solicitação CNRP de ${nomeSolicitante} para a data ${new Date(data_ponto).toLocaleDateString('pt-BR')}.`,
                rhUser.id,
                novaSolicitacao.id,
                `/gerenciamento-cnrp?id=${novaSolicitacao.id}`,
                usuario_solicitante_id
            );
        }

        res.status(201).json({ success: true, message: 'Solicitação CNRP criada com sucesso!', solicitacao: novaSolicitacao });
    } catch (error) {
        console.error('Erro ao criar solicitação CNRP:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor ao criar solicitação.' });
    }
});

router.get('/minhas', authMiddleware, async (req, res) => {
    const usuario_solicitante_id = req.user.id;
    try {
        const result = await pool.query(
            'SELECT * FROM solicitacoes_cnrp WHERE usuario_solicitante_id = $1 ORDER BY data_criacao DESC',
            [usuario_solicitante_id]
        );
        res.json({ success: true, solicitacoes: result.rows });
    } catch (error) {
        console.error('Erro ao buscar minhas solicitações CNRP:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});

router.get('/gerenciamento', authMiddleware, async (req, res) => {
    const { status, dataInicio, dataFim, usuarioId } = req.query;
    let queryText = `
        SELECT sc.*, u.nome AS nome_solicitante, u.email AS email_solicitante 
        FROM solicitacoes_cnrp sc
        JOIN usuarios u ON sc.usuario_solicitante_id = u.id
    `;
    const queryParams = [];
    const conditions = [];

    if (status) {
        queryParams.push(status);
        conditions.push(`sc.status = $${queryParams.length}`);
    }
    if (dataInicio) {
        queryParams.push(dataInicio);
        conditions.push(`sc.data_ponto >= $${queryParams.length}`);
    }
    if (dataFim) {
        queryParams.push(dataFim);
        conditions.push(`sc.data_ponto <= $${queryParams.length}`);
    }
    if (usuarioId) {
        queryParams.push(usuarioId);
        conditions.push(`sc.usuario_solicitante_id = $${queryParams.length}`);
    }

    if (conditions.length > 0) {
        queryText += ' WHERE ' + conditions.join(' AND ');
    }
    queryText += ' ORDER BY sc.data_criacao DESC';

    try {
        const result = await pool.query(queryText, queryParams);
        res.json({ success: true, solicitacoes: result.rows });
    } catch (error) {
        console.error('Erro ao buscar todas as solicitações CNRP:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});

router.put('/:id/status', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { status, observacao_rh } = req.body;
    const modificado_por_rh_id = req.user.id;
    const nomeModificador = req.user.nome || `Usuário ID ${modificado_por_rh_id}`;

    if (!status || !['Pendente', 'Em Análise', 'Concluído', 'Recusado'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Status inválido fornecido.' });
    }

    try {
        const result = await pool.query(
            'UPDATE solicitacoes_cnrp SET status = $1, observacao_rh = $2, modificado_por_rh_id = $3, data_ultima_modificacao = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
            [status, observacao_rh || null, modificado_por_rh_id, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Solicitação CNRP não encontrada.' });
        }
        const solicitacaoAtualizada = result.rows[0];
        
        let tipoNotificacao = 'STATUS_CNRP_ATUALIZADO_SOLICITANTE';
        if (status === 'Recusado') {
            tipoNotificacao = 'CNRP_RECUSADA_SOLICITANTE';
        } else if (status === 'Concluído') {
            tipoNotificacao = 'CNRP_CONCLUIDA_SOLICITANTE';
        }

        await criarNotificacao(
            tipoNotificacao,
            `Status da sua CNRP (${new Date(solicitacaoAtualizada.data_ponto).toLocaleDateString('pt-BR')}) atualizado para: ${status} por ${nomeModificador}. ${observacao_rh ? 'Obs: ' + observacao_rh : ''}`,
            solicitacaoAtualizada.usuario_solicitante_id,
            solicitacaoAtualizada.id,
            `/solicitacoes-cnrp?id=${solicitacaoAtualizada.id}`,
            modificado_por_rh_id
        );

        res.json({ success: true, message: 'Status da solicitação CNRP atualizado com sucesso!', solicitacao: solicitacaoAtualizada });
    } catch (error) {
        console.error('Erro ao atualizar status da solicitação CNRP:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});

module.exports = router;