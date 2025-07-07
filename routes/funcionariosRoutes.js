const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth'); // Ajuste o caminho
const pool = require('../config/database'); // Ajuste o caminho

// Lista de permissões que podem gerenciar funcionários (visualizar e editar)
const GESTAO_FUNCIONARIOS_PERMISSIONS = ['Administrativo', 'Gerente', 'Gestor', 'Dev'];

// Middleware para verificar se o usuário tem permissão para gerenciar funcionários
const canManageFuncionarios = (req, res, next) => {
    if (!req.user || !req.user.permissao || !GESTAO_FUNCIONARIOS_PERMISSIONS.includes(req.user.permissao)) {
        return res.status(403).json({ success: false, message: 'Acesso negado. Permissão insuficiente.' });
    }
    next();
};

// Rota para LISTAR todos os funcionários (com filtro por nome)
// GET /funcionarios?nome=...
router.get('/', authMiddleware, canManageFuncionarios, async (req, res) => {
    const { nome } = req.query; // Para o filtro de busca por nome
    try {
        let queryText = 'SELECT id, email, nome, permissao, setor, ramal, modelo_trabalho, codigo_ifood, predio, foto_perfil_url, criado_em FROM usuarios';
        const queryParams = [];

        if (nome) {
            queryText += ' WHERE nome ILIKE $1'; // ILIKE para case-insensitive
            queryParams.push(`%${nome}%`);
        }

        queryText += ' ORDER BY nome ASC'; // Opcional: ordenar por nome

        const result = await pool.query(queryText, queryParams);
        res.json({ success: true, funcionarios: result.rows });

    } catch (error) {
        console.error('Erro ao buscar funcionários:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor ao buscar funcionários.' });
    }
});

// Rota para ATUALIZAR um funcionário específico
// PUT /funcionarios/:id
router.put('/:id', authMiddleware, canManageFuncionarios, async (req, res) => {
    const { id: targetUserId } = req.params; // ID do usuário a ser atualizado
    const { nome, permissao, setor, ramal, modelo_trabalho, codigo_ifood, predio } = req.body;

    // Validações (adicione mais conforme necessário)
    if (req.body.hasOwnProperty('predio') && predio !== null && predio !== '' && !['173', '177'].includes(String(predio))) {
        return res.status(400).json({ success: false, message: 'Valor inválido para prédio.' });
    }
    const permissoesValidas = ['Dev', 'Gerente', 'Operador', 'Gestor', 'Fiscal', 'Administrativo'];
    if (req.body.hasOwnProperty('permissao') && permissao && !permissoesValidas.includes(permissao)) {
        return res.status(400).json({ success: false, message: 'Valor de permissão inválido.' });
    }
    const setoresValidos = ['Departamento Pessoal', 'Societário', 'Regularização', 'CRM', 'Administrativo', 'Contabilidade', 'Fiscal', 'Pis Cofins', 'Tecnologia']; // Removido null e '' daqui, pois o tratamento abaixo já os converte para null
    if (req.body.hasOwnProperty('setor') && setor && !setoresValidos.includes(setor)) { // Se setor não for nulo/vazio e não estiver na lista
         return res.status(400).json({ success: false, message: `Valor de setor inválido: ${setor}. Valores permitidos: ${setoresValidos.join(', ')} ou deixe em branco.` });
    }

    const modelo_trabalho = ['Presencial', 'Híbrido', 'Home Office',];
    if (req.body.hasOwnProperty('modelo_trabalho') && modelo_trabalho && !modelo_trabalho.includes(modelo_trabalho)) {
        return res.status(400).json({ success: false, message: 'Valor de modelo de trabalho inválido.' });
    }

    try {
        const fieldsToUpdate = {};
        // Apenas adiciona ao update se a propriedade existir no corpo da requisição
        if (req.body.hasOwnProperty('nome')) fieldsToUpdate.nome = nome;
        if (req.body.hasOwnProperty('permissao')) fieldsToUpdate.permissao = permissao;
        // Trata setor: se explicitamente enviado como vazio ou uma string que representa 'nenhum', define como null.
        // Se for um valor válido da lista, usa esse valor.
        // Se não for enviado, não atualiza.
        if (req.body.hasOwnProperty('setor')) {
            fieldsToUpdate.setor = (setor === '' || setor === null || setor === '__NONE__') ? null : setor;
        }
        if (req.body.hasOwnProperty('ramal')) fieldsToUpdate.ramal = (ramal === '') ? null : ramal;
        if (req.body.hasOwnProperty('codigo_ifood')) fieldsToUpdate.codigo_ifood = (codigo_ifood === '') ? null : codigo_ifood;
        if (req.body.hasOwnProperty('predio')) fieldsToUpdate.predio = (predio === '' || predio === null) ? null : String(predio);
        if (req.body.hasOwnProperty('modelo_trabalho')) {
            fieldsToUpdate.modelo_trabalho = (modelo_trabalho === '' || modelo_trabalho === null || modelo_trabalho === '__NONE__') ? null : modelo_trabalho;
        }

        if (Object.keys(fieldsToUpdate).length === 0) {
            return res.status(400).json({ success: false, message: 'Nenhum campo válido fornecido para atualização.' });
        }

        const querySetParts = Object.keys(fieldsToUpdate).map((key, index) => `"${key}" = $${index + 1}`);
        const queryValues = Object.values(fieldsToUpdate);
        queryValues.push(targetUserId);

        const queryText = `UPDATE usuarios SET ${querySetParts.join(', ')} WHERE id = $${queryValues.length} RETURNING id, email, nome, permissao, modelo_trabalho, setor, ramal, codigo_ifood, predio, foto_perfil_url, criado_em`;
        
        const result = await pool.query(queryText, queryValues);

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Funcionário não encontrado para atualização.' });
        }
        res.json({ success: true, message: 'Dados do funcionário atualizados com sucesso!', user: result.rows[0] });

    } catch (error) {
        console.error(`Erro ao atualizar funcionário ${targetUserId}:`, error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor ao atualizar funcionário.' });
    }
});

module.exports = router;