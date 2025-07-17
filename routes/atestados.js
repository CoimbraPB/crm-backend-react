const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');

let supabaseAdmin;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
} else {
  console.warn('AVISO: Chaves do Supabase não configuradas.');
}

const authorizeUploader = (req, res, next) => {
  const allowedRoles = ['Gerente', 'Gestor', 'Dev', 'RH'];
  if (req.user && allowedRoles.includes(req.user.permissao)) {
    next();
  } else {
    res.status(403).json({ success: false, message: 'Você não tem permissão para enviar atestados.' });
  }
};

router.post('/solicitar-upload-url', auth, authorizeUploader, async (req, res) => {
    if (!supabaseAdmin) {
        return res.status(500).json({ success: false, message: 'Serviço de upload indisponível.' });
    }

    const { fileName, colaboradorId } = req.body;
    const gestorId = req.user.userId;

    if (!fileName || !colaboradorId) {
        return res.status(400).json({ success: false, message: 'Nome do arquivo e ID do colaborador são obrigatórios.' });
    }

    try {
        const userExists = await pool.query('SELECT id FROM usuarios WHERE id = $1', [colaboradorId]);
        if (userExists.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Colaborador não encontrado.' });
        }
    } catch(e) {
        console.error("Erro ao validar colaborador:", e);
        return res.status(500).json({ success: false, message: 'Erro ao verificar colaborador.' });
    }

    const fileExtension = fileName.split('.').pop();
    const uniqueFileName = `${colaboradorId}/${new Date().getTime()}_${gestorId}.${fileExtension}`;

    const { data, error } = await supabaseAdmin.storage
        .from('atestados')
        .createSignedUploadUrl(uniqueFileName, 300);

    if (error) {
        console.error('Supabase - Erro ao criar URL assinada para atestado:', error);
        return res.status(500).json({ success: false, message: 'Não foi possível gerar a URL para upload.' });
    }

    res.json({ 
        success: true, 
        signedUrl: data.signedUrl, 
        pathForConfirmation: data.path 
    });
});

router.post('/confirmar-upload', auth, authorizeUploader, async (req, res) => {
    const { pathForConfirmation, colaboradorId, dataInicio, diasAfastamento, observacoes } = req.body;
    const gestorId = req.user.userId;

    if (!pathForConfirmation || !colaboradorId || !dataInicio || !diasAfastamento) {
        return res.status(400).json({ success: false, message: 'Dados incompletos para confirmar.' });
    }

    if (!pathForConfirmation.startsWith(colaboradorId + '/')) {
        return res.status(403).json({ success: false, message: 'Ação não autorizada.' });
    }

    try {
        const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/atestados/${pathForConfirmation}`;
        const fileName = pathForConfirmation.split('/').pop();

        const query = `
            INSERT INTO atestados 
            (usuario_id, gestor_envio_id, url_atestado, nome_arquivo, data_inicio_atestado, dias_afastamento, observacoes)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id;
        `;
        
        const values = [colaboradorId, gestorId, publicUrl, fileName, dataInicio, diasAfastamento, observacoes || null];
        
        const result = await pool.query(query, values);

        if (result.rowCount === 0) {
            throw new Error('Falha ao inserir o registro do atestado.');
        }

        res.status(201).json({ success: true, message: 'Atestado enviado com sucesso!' });

    } catch (error) {
        console.error('Erro ao confirmar upload do atestado:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao salvar o atestado.' });
    }
});

router.get('/usuario/:id', auth, async (req, res) => {
    const { id } = req.params;
    const requesterId = req.user.userId;
    const requesterPermissao = req.user.permissao;

    if (requesterId.toString() !== id && !['Gerente', 'Gestor', 'Dev', 'RH'].includes(requesterPermissao)) {
        return res.status(403).json({ success: false, message: 'Você não tem permissão para ver os atestados de outro usuário.' });
    }

    try {
        const query = 'SELECT * FROM atestados WHERE usuario_id = $1 ORDER BY data_inicio_atestado DESC';
        const { rows } = await pool.query(query, [id]);
        res.json({ success: true, atestados: rows });
    } catch (error) {
        console.error(`Erro ao buscar atestados para o usuário ${id}:`, error);
        res.status(500).json({ success: false, message: 'Erro interno ao buscar atestados.' });
    }
});

// Rota para buscar todos os atestados (para tela de gerenciamento)
router.get('/todos', auth, authorizeUploader, async (req, res) => {
    try {
        const query = `
            SELECT a.*, u.nome as nome_colaborador 
            FROM atestados a
            JOIN usuarios u ON a.usuario_id = u.id
            ORDER BY a.data_envio DESC
        `;
        const { rows } = await pool.query(query);
        res.json({ success: true, atestados: rows });
    } catch (error) {
        console.error('Erro ao buscar todos os atestados:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao buscar todos os atestados.' });
    }
});

// Rota para atualizar o status de um atestado
router.put('/:id/status', auth, authorizeUploader, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!['Aprovado', 'Rejeitado', 'Pendente'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Status inválido.' });
    }

    try {
        const query = 'UPDATE atestados SET status = $1 WHERE id = $2 RETURNING *';
        const { rows } = await pool.query(query, [status, id]);

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Atestado não encontrado.' });
        }

        // TODO: Adicionar lógica de notificação para o usuário aqui

        res.json({ success: true, atestado: rows[0] });
    } catch (error) {
        console.error(`Erro ao atualizar status do atestado ${id}:`, error);
        res.status(500).json({ success: false, message: 'Erro interno ao atualizar status do atestado.' });
    }
});

module.exports = router;
