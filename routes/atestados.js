const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');

// Inicialização do Supabase Admin Client
// Este bloco garante que o cliente Supabase seja inicializado apenas se as chaves existirem.
let supabaseAdmin;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
} else {
  console.warn('--------------------------------------------------------------------');
  console.warn('AVISO: Chaves do Supabase não configuradas no .env.');
  console.warn('Funcionalidades de upload de atestados não funcionarão.');
  console.warn('--------------------------------------------------------------------');
}

// Middleware de permissão: Quem pode enviar atestados?
// Vamos permitir que 'Gerente', 'Gestor' e 'Dev' enviem atestados.
const authorizeUploader = (req, res, next) => {
  const allowedRoles = ['Gerente', 'Gestor', 'Dev', 'RH']; // Adicionei 'RH' por segurança
  if (req.user && allowedRoles.includes(req.user.permissao)) {
    next();
  } else {
    res.status(403).json({ success: false, message: 'Você não tem permissão para enviar atestados.' });
  }
};

// ROTA 1: Solicitar URL de Upload Assinada para o Atestado
// O gestor (usuário logado) envia o nome do arquivo e o ID do colaborador para quem o atestado se destina.
// POST /api/atestados/solicitar-upload-url
router.post('/solicitar-upload-url', auth, authorizeUploader, async (req, res) => {
    if (!supabaseAdmin) {
        return res.status(500).json({ success: false, message: 'Serviço de upload está temporariamente indisponível.' });
    }

    const { fileName, colaboradorId } = req.body;
    const gestorId = req.user.userId; // O ID do gestor vem do token

    if (!fileName || !colaboradorId) {
        return res.status(400).json({ success: false, message: 'O nome do arquivo e o ID do colaborador são obrigatórios.' });
    }

    // Valida se o colaborador existe (opcional, mas bom para integridade)
    try {
        const userExists = await pool.query('SELECT id FROM usuarios WHERE id = $1', [colaboradorId]);
        if (userExists.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Colaborador não encontrado.' });
        }
    } catch(e) {
        console.error("Erro ao validar colaborador:", e);
        return res.status(500).json({ success: false, message: 'Erro ao verificar colaborador.' });
    }

    // Estrutura do caminho no bucket: `colaboradorId/timestamp_gestorId.extensao`
    // Isso organiza os atestados por pasta de colaborador e evita colisões de nome.
    const fileExtension = fileName.split('.').pop();
    const uniqueFileName = `${colaboradorId}/${new Date().getTime()}_${gestorId}.${fileExtension}`;

    const { data, error } = await supabaseAdmin.storage
        .from('atestados') // Nome do seu novo bucket
        .createSignedUploadUrl(uniqueFileName, 300); // URL válida por 5 minutos

    if (error) {
        console.error('Supabase - Erro ao criar URL assinada para atestado:', error);
        return res.status(500).json({ success: false, message: 'Não foi possível gerar a URL para upload do atestado.' });
    }

    res.json({ 
        success: true, 
        signedUrl: data.signedUrl, 
        pathForConfirmation: data.path 
    });
});

// ROTA 2: Confirmar o Upload e Salvar o Registro no Banco de Dados
// Após o frontend enviar o arquivo para o Supabase, ele chama esta rota.
// POST /api/atestados/confirmar-upload
router.post('/confirmar-upload', auth, authorizeUploader, async (req, res) => {
    const { pathForConfirmation, colaboradorId, dataInicio, diasAfastamento, observacoes } = req.body;
    const gestorId = req.user.userId;

    if (!pathForConfirmation || !colaboradorId || !dataInicio || !diasAfastamento) {
        return res.status(400).json({ success: false, message: 'Dados incompletos para confirmar o envio do atestado.' });
    }

    // Validação de segurança crucial: o caminho do arquivo DEVE começar com o ID do colaborador informado.
    // Isso impede que um gestor envie um arquivo para a pasta de um colaborador, mas registre no banco para outro.
    if (!pathForConfirmation.startsWith(colaboradorId + '/')) {
        console.warn(`Tentativa de confirmação de upload não autorizada: gestor ${gestorId} tentou confirmar path ${pathForConfirmation} para colaborador ${colaboradorId}`);
        return res.status(403).json({ success: false, message: 'Ação não autorizada. O caminho do arquivo não corresponde ao colaborador.' });
    }

    try {
        // Monta a URL pública final do arquivo
        const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/atestados/${pathForConfirmation}`;
        const fileName = pathForConfirmation.split('/').pop();

        // Insere o registro na tabela 'atestados' que criamos
        const query = `
            INSERT INTO atestados 
            (usuario_id, gestor_envio_id, url_atestado, nome_arquivo, data_inicio_atestado, dias_afastamento, observacoes)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id;
        `;
        
        const values = [colaboradorId, gestorId, publicUrl, fileName, dataInicio, diasAfastamento, observacoes || null];
        
        const result = await pool.query(query, values);

        if (result.rowCount === 0) {
            // Se chegou aqui, algo muito errado aconteceu, pois o insert deveria funcionar ou dar erro.
            throw new Error('Falha ao inserir o registro do atestado no banco de dados após o upload.');
        }

        // TODO: Futuramente, você pode adicionar um log de auditoria aqui, como fez no 'users.js'
        // await logAction(gestorId, req.user.email, ACTION_TYPES.ATESTADO_ENVIADO, ENTITY_TYPES.ATESTADO, result.rows[0].id, { ... });

        res.status(201).json({ success: true, message: 'Atestado enviado com sucesso!' });

    } catch (error) {
        console.error('Erro ao confirmar upload do atestado:', error);
        // TODO: Log de erro
        res.status(500).json({ success: false, message: 'Erro interno do servidor ao salvar as informações do atestado.' });
    }
});

module.exports = router;