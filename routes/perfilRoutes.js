const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth'); // Seu middleware de autenticação
const pool = require('../config/database'); // Sua conexão com o banco
const { createClient } = require('@supabase/supabase-js');

// Inicializar Supabase Admin Client (apenas uma vez)
// Certifique-se de que SUPABASE_URL e SUPABASE_SERVICE_KEY estão no seu .env
let supabaseAdmin;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
} else {
  // Log de aviso se as chaves não estiverem configuradas, para ajudar no debug.
  console.warn('--------------------------------------------------------------------');
  console.warn('AVISO: SUPABASE_URL ou SUPABASE_SERVICE_KEY não estão configuradas.');
  console.warn('As funcionalidades de upload de fotos de perfil não funcionarão.');
  console.warn('Verifique seu arquivo .env e as configurações do projeto Supabase.');
  console.warn('--------------------------------------------------------------------');
}

// Rota para OBTER o perfil do usuário logado
// GET /api/perfil/meu (ou o prefixo que você definir no server.js)
router.get('/meu', authMiddleware, async (req, res) => {
    // Seu middleware 'auth' já anexa 'req.user' com os dados do token.
    // Seu token tem 'userId', 'email', 'nome', 'permissao'.
    const userId = req.user.userId; 
    try {
        const result = await pool.query(
            'SELECT id, email, nome, permissao, setor, ramal, modelo_trabalho, codigo_ifood, predio, foto_perfil_url, criado_em FROM usuarios WHERE id = $1',
            [userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
        }
        res.json({ success: true, user: result.rows[0] });
    } catch (error) {
        console.error(`Erro ao buscar perfil para userId ${userId}:`, error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor ao buscar perfil.' });
    }
});

// Rota para ATUALIZAR o perfil do usuário logado (dados textuais)
// PUT /api/perfil/meu
router.put('/meu', authMiddleware, async (req, res) => {
    const { setor, ramal, codigo_ifood, predio, nome, modelo_trabalho } = req.body;
    const userId = req.user.userId;

    // Validação para 'predio'
    if (req.body.hasOwnProperty('predio') && predio !== null && predio !== '' && !['173', '177'].includes(predio)) {
        return res.status(400).json({ success: false, message: 'Valor inválido para prédio. Use "173", "177", ou deixe em branco/nulo para limpar.' });
    }

        if (req.body.hasOwnProperty('setor') && setor !== null && setor !== '' && !['Departamento Pessoal','Societário','Regularização','CRM','Administrativo','Contabilidade','Fiscal','Pis Cofins','Tecnologia'].includes(setor)) {
        return res.status(400).json({ success: false, message: 'Valor inválido para Setor. Use as alternativas, ou deixe em branco/nulo para limpar.' });
    }
    if (req.body.hasOwnProperty('modelo_trabalho') && modelo_trabalho && !['Presencial', 'Híbrido', 'Home Office'].includes(modelo_trabalho)) {
        return res.status(400).json({ success: false, message: 'Valor inválido para Modelo de Trabalho. Use "Presencial", "Híbrido", "Home Office", ou deixe em branco/nulo para limpar.' });
    }

    try {
        const fieldsToUpdate = {};
        // Adiciona ao objeto de atualização apenas os campos que foram enviados e são permitidos
        if (req.body.hasOwnProperty('nome')) fieldsToUpdate.nome = nome;
        if (req.body.hasOwnProperty('setor')) {
            fieldsToUpdate.setor = (setor === '' || setor === null) ? null : setor;
        }
        if (req.body.hasOwnProperty('ramal')) {
            fieldsToUpdate.ramal = (ramal === '' || ramal === null) ? null : ramal;
        }
        if (req.body.hasOwnProperty('codigo_ifood')) {
            fieldsToUpdate.codigo_ifood = (codigo_ifood === '' || codigo_ifood === null) ? null : codigo_ifood;
        }
        if (req.body.hasOwnProperty('predio')) {
            fieldsToUpdate.predio = (predio === '' || predio === null) ? null : predio;
        }
        if (req.body.hasOwnProperty('modelo_trabalho')) {
            fieldsToUpdate.modelo_trabalho = (modelo_trabalho === '' || modelo_trabalho === null) ? null : modelo_trabalho;
        }


        if (Object.keys(fieldsToUpdate).length === 0) {
            return res.status(400).json({ success: false, message: 'Nenhum campo válido fornecido para atualização.' });
        }

        const querySetParts = Object.keys(fieldsToUpdate).map((key, index) => `"${key}" = $${index + 1}`);
        const queryValues = Object.values(fieldsToUpdate);

        // Adiciona o userId como último parâmetro para a cláusula WHERE
        queryValues.push(userId);
        const query = `UPDATE usuarios SET ${querySetParts.join(', ')} WHERE id = $${queryValues.length} RETURNING id, email, nome, modelo_trabalho, permissao, setor, ramal, codigo_ifood, predio, foto_perfil_url`;
        
        const result = await pool.query(query, queryValues);

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado para atualização.' });
        }

        res.json({ success: true, message: 'Perfil atualizado com sucesso!', user: result.rows[0] });
    } catch (error) {
        console.error(`Erro ao atualizar perfil para userId ${userId}:`, error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor ao atualizar perfil.' });
    }
});

// Rota para SOLICITAR URL de upload assinada para a foto de perfil
// GET /api/perfil/solicitar-upload-url
router.get('/solicitar-upload-url', authMiddleware, async (req, res) => {
    if (!supabaseAdmin) {
        console.error('Tentativa de solicitar URL de upload sem cliente Supabase Admin configurado.');
        return res.status(500).json({ success: false, message: 'Serviço de upload temporariamente indisponível. Configuração do Supabase Storage incompleta no servidor.' });
    }

    const userId = req.user.userId;
    const supabaseFilePath = `${userId}/profile.png`;

    try {
        const { error: deleteError } = await supabaseAdmin.storage
            .from('profile-pictures')
            .remove([supabaseFilePath]);

        if (deleteError && deleteError.message !== 'The resource was not found' && deleteError.message !== 'Not Found') {
            console.error(`Supabase error deleting old file ${supabaseFilePath}:`, deleteError);
        }

        const { data, error: createUrlError } = await supabaseAdmin.storage
            .from('profile-pictures')
            .createSignedUploadUrl(supabaseFilePath, 300);

        if (createUrlError) {
            console.error(`Supabase error creating signed URL for userId ${userId}, path ${supabaseFilePath}:`, createUrlError);
            return res.status(500).json({ success: false, message: 'Erro ao gerar URL segura para upload.' });
        }

        res.json({ success: true, signedUrl: data.signedUrl, pathForConfirmation: data.path });

    } catch (e) {
        console.error(`Exception creating signed URL for userId ${userId}, path ${supabaseFilePath}:`, e);
        res.status(500).json({ success: false, message: 'Erro interno crítico ao gerar URL para upload.' });
    }
});

// Rota para CONFIRMAR o upload da foto e salvar a URL no perfil do usuário
// POST /api/perfil/confirmar-upload-foto
router.post('/confirmar-upload-foto', authMiddleware, async (req, res) => {
    // O frontend envia o 'pathForConfirmation' que recebeu da rota /solicitar-upload-url
    const { pathForConfirmation } = req.body; 
    const userId = req.user.userId;

    if (!pathForConfirmation) {
        return res.status(400).json({ success: false, message: 'Identificador do caminho do arquivo Supabase não fornecido.' });
    }

    // Validação de segurança: O caminho do arquivo realmente pertence ao usuário logado?
    // O pathForConfirmation deve começar com o userId.
    if (!pathForConfirmation.startsWith(userId + '/')) {
        console.warn(`Tentativa de confirmação de upload não autorizada: userId ${userId} tentou confirmar o path ${pathForConfirmation}`);
        return res.status(403).json({ success: false, message: 'Não autorizado a confirmar este arquivo de perfil.' });
    }

    try {
        // Construir a URL pública. Certifique-se que SUPABASE_URL está correto no .env
        // A URL pública não muda mesmo se você usar URLs assinadas para upload.
        const publicImageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/profile-pictures/${pathForConfirmation}?t=${new Date().getTime()}`;

        const updateQuery = 'UPDATE usuarios SET foto_perfil_url = $1 WHERE id = $2 RETURNING foto_perfil_url';
        const result = await pool.query(updateQuery, [publicImageUrl, userId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado ao tentar salvar URL da foto.' });
        }
        res.json({ success: true, message: 'Foto de perfil atualizada com sucesso!', foto_perfil_url: result.rows[0].foto_perfil_url });
    } catch (error) {
        console.error(`Erro ao confirmar upload de foto para userId ${userId}, path ${pathForConfirmation}:`, error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor ao confirmar atualização da foto.' });
    }
});

module.exports = router;