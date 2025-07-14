const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth'); // Certifique-se que o caminho está correto
const pool = require('../config/database'); // Certifique-se que o caminho está correto

router.get('/', authMiddleware, async (req, res) => {
    const usuario_destino_id = req.user.userId; // CORRIGIDO AQUI

    if (!usuario_destino_id) {
        console.error('[GET /notificacoes] Erro: ID do usuário não encontrado no token JWT.', req.user);
        return res.status(401).json({ success: false, message: 'Não autorizado ou ID do usuário ausente no token.' });
    }

    const apenasNaoLidas = req.query.apenas_nao_lidas === 'true';
    const limite = parseInt(req.query.limite) || 10;
    const offset = parseInt(req.query.offset) || 0;

    try {
        let queryText = `
            SELECT n.*, u_criador.nome as nome_criador 
            FROM notificacoes n
            LEFT JOIN usuarios u_criador ON n.criado_por_id = u_criador.id
            WHERE n.usuario_destino_id = $1
        `;
        const queryParams = [usuario_destino_id];
        let paramCount = 1;

        if (apenasNaoLidas) {
            queryText += ` AND n.lida = FALSE`;
        }

        queryText += ` ORDER BY n.data_criacao DESC LIMIT $${++paramCount} OFFSET $${++paramCount}`;
        queryParams.push(limite, offset);
        
        const result = await pool.query(queryText, queryParams);
        
        const countResult = await pool.query('SELECT COUNT(*) AS total_nao_lidas FROM notificacoes WHERE usuario_destino_id = $1 AND lida = FALSE', [usuario_destino_id]);
        const contagemNaoLidas = parseInt(countResult.rows[0].total_nao_lidas);

        res.json({ 
            success: true, 
            notificacoes: result.rows,
            contagemNaoLidas: contagemNaoLidas
        });

    } catch (error) {
        console.error('Erro ao buscar notificações:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor ao buscar notificações.' });
    }
});

router.put('/marcar-como-lidas', authMiddleware, async (req, res) => {
    const usuario_destino_id = req.user.userId; // CORRIGIDO AQUI

    if (!usuario_destino_id) {
        console.error('[PUT /marcar-como-lidas] Erro: ID do usuário não encontrado no token JWT.', req.user);
        return res.status(401).json({ success: false, message: 'Não autorizado ou ID do usuário ausente no token.' });
    }

    const { notificacao_ids } = req.body; 

    if (!notificacao_ids) {
        return res.status(400).json({ success: false, message: 'IDs de notificações ou comando "todas" é obrigatório.' });
    }

    try {
        let result;
        if (notificacao_ids === 'todas') {
            result = await pool.query(
                'UPDATE notificacoes SET lida = TRUE WHERE usuario_destino_id = $1 AND lida = FALSE RETURNING id',
                [usuario_destino_id]
            );
        } else if (Array.isArray(notificacao_ids) && notificacao_ids.length > 0) {
            const idsNumericos = notificacao_ids.map(id => parseInt(id)).filter(id => !isNaN(id));
            if (idsNumericos.length === 0) {
                 return res.status(400).json({ success: false, message: 'Nenhum ID de notificação válido fornecido.' });
            }
            result = await pool.query(
                'UPDATE notificacoes SET lida = TRUE WHERE usuario_destino_id = $1 AND id = ANY($2::int[]) AND lida = FALSE RETURNING id',
                [usuario_destino_id, idsNumericos]
            );
        } else {
            return res.status(400).json({ success: false, message: 'Formato de notificacao_ids inválido.' });
        }
        
        res.json({ success: true, message: `${result.rowCount} notificações marcadas como lidas.` });
    } catch (error) {
        console.error('Erro ao marcar notificações como lidas:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});

router.get('/contagem-nao-lidas', authMiddleware, async (req, res) => {
    const usuario_destino_id = req.user.userId; // CORRIGIDO AQUI
    
    if (!usuario_destino_id) {
        console.error('[GET /contagem-nao-lidas] Erro: ID do usuário não encontrado no token JWT.', req.user);
        return res.status(401).json({ success: false, message: 'Não autorizado ou ID do usuário ausente no token.' });
    }

    try {
        const result = await pool.query(
            'SELECT COUNT(*) AS contagem FROM notificacoes WHERE usuario_destino_id = $1 AND lida = FALSE',
            [usuario_destino_id]
        );
        res.json({ success: true, contagem: parseInt(result.rows[0].contagem) });
    } catch (error) {
        console.error('Erro ao buscar contagem de notificações não lidas:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor ao buscar contagem.' });
    }
});

module.exports = router;