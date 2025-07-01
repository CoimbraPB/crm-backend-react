const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction } = require('../services/auditLogService');

const checkPermissionGerencial = (req, res, next) => {
  const userPermission = req.user.permissao;
  if (['Gerente', 'Dev'].includes(userPermission)) { 
    next();
  } else {
    logAction(req.user.userId, req.user.email, 'ANALISE_CONTRATUAL_ACCESS_DENIED', 'AnaliseContratual', null, { route: req.path, attemptedPermission: userPermission });
    return res.status(403).json({ success: false, message: 'Acesso negado. Requer permissão de Gerente, Gestor ou Dev.' });
  }
};

// Função auxiliar para obter o primeiro dia do mês anterior
const getPreviousMonthDate = (currentMesAno) => {
  // currentMesAno é esperado no formato "YYYY-MM-DD"
  // Adiciona 'T00:00:00Z' para garantir que seja interpretado como UTC meia-noite
  const currentDate = new Date(currentMesAno + 'T00:00:00Z'); 
  if (isNaN(currentDate.getTime())) {
    // Se a data for inválida por algum motivo, retorna null ou lança um erro mais específico
    // Isso pode acontecer se currentMesAno não estiver no formato esperado.
    console.error(`getPreviousMonthDate: Invalid date constructed from input: ${currentMesAno}`);
    // Para este caso, vamos retornar uma string que provavelmente causará falha na query SQL,
    // ou poderia lançar um erro para ser pego pelo try...catch da rota.
    // Retornar null pode fazer a query buscar por mes_ano_referencia = NULL, o que não é ideal.
    // Uma string obviamente inválida para data SQL é mais segura para debug.
    return 'INVALID_DATE_INPUT'; 
  }
  currentDate.setUTCMonth(currentDate.getUTCMonth() - 1);
  return currentDate.toISOString().split('T')[0]; // Formato YYYY-MM-DD
};


// ROTA: Gerar/Atualizar Análise para um Mês/Ano
router.post('/gerar-analise/:mes_ano', auth, checkPermissionGerencial, async (req, res) => {
  const { mes_ano } = req.params; // YYYY-MM-DD (primeiro dia do mês)
  const userId = req.user.userId, userEmail = req.user.email;
  const FATOR_HORAS_PADRAO_FALLBACK = 220; // Fallback caso não configurado

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Buscar Valores Hora/Cargo para o mês/ano
    const valoresHoraCargoRes = await client.query(
      'SELECT cargo_id, valor_hora FROM config_valores_hora_cargo WHERE mes_ano_referencia = $1',
      [mes_ano]
    );

    if (valoresHoraCargoRes.rows.length === 0) {
      await client.query('ROLLBACK');
      logAction(userId, userEmail, 'ANALISE_CONTRATUAL_GERAR_FAILED', 'AnaliseContratual', null, { mes_ano, error: 'Valores hora/cargo não definidos.' });
      return res.status(400).json({ success: false, message: `Erro ao gerar análise: Valores de hora/cargo não definidos para ${mes_ano}. Por favor, cadastre-os na tela de Configurações da Análise Contratual.` });
    }

    const mapValorHoraCargo = new Map();
    valoresHoraCargoRes.rows.forEach(vh => {
      mapValorHoraCargo.set(vh.cargo_id, parseFloat(vh.valor_hora));
    });

    // 2. Buscar faturamentos do mês que possuem alocação de esforço
    // A coluna f.valor_faturamento não é mais necessária para o cálculo direto, mas pode ser mantida para referência se a tabela faturamentos ainda for usada para outros fins.
    // Para a análise contratual, só precisamos do faturamento_id para ligar com alocacao_esforco.
    const faturamentosDoMesRes = await client.query(
      `SELECT f.id as faturamento_id, f.cliente_id, f.mes_ano as mes_ano_referencia
       FROM faturamentos f 
       WHERE f.mes_ano = $1 AND EXISTS (
         SELECT 1 FROM alocacao_esforco_cliente_cargo ae WHERE ae.faturamento_id = f.id
       )`,
      [mes_ano]
    );

    if (faturamentosDoMesRes.rows.length === 0) {
      await client.query('ROLLBACK');
      logAction(userId, userEmail, 'ANALISE_CONTRATUAL_GERAR_NO_DATA', 'AnaliseContratual', null, { mes_ano });
      return res.status(404).json({ success: false, message: `Nenhum faturamento com esforço de equipe lançado encontrado para ${mes_ano}. A análise não pode ser gerada.` });
    }

    const analisesProcessadas = [];
    let warnings = [];

    for (const fatura of faturamentosDoMesRes.rows) {
      // 3. Calcular Custo Total Cliente para cada faturamento
      const alocacoesRes = await client.query(
        `SELECT ae.cargo_id, c.nome_cargo, ae.quantidade_funcionarios, ae.total_horas_gastas_cargo 
         FROM alocacao_esforco_cliente_cargo ae
         JOIN cargos c ON ae.cargo_id = c.id_cargo
         WHERE ae.faturamento_id = $1`,
        [fatura.faturamento_id]
      );

      if (alocacoesRes.rows.length === 0) {
        warnings.push(`Cliente ID ${fatura.cliente_id} (Faturamento ID ${fatura.faturamento_id}): Nenhuma alocação de esforço (horas/cargos) encontrada. Este cliente não será incluído na análise.`);
        continue; 
      }
      
      let custoTotalCliente = 0;
      let todosCargosTinhamValorHora = true;

      for (const aloc of alocacoesRes.rows) {
        const valorHora = mapValorHoraCargo.get(aloc.cargo_id);
        if (valorHora !== undefined && valorHora >= 0) {
          // Nova lógica: CustoCargoCliente = Qtd Funcionários * Horas Gastas (por funcionário) * Valor Hora Cargo
          custoTotalCliente += parseFloat(aloc.quantidade_funcionarios) * parseFloat(aloc.total_horas_gastas_cargo) * valorHora;
        } else {
          todosCargosTinhamValorHora = false;
          warnings.push(`Cliente ID ${fatura.cliente_id} (Faturamento ID ${fatura.faturamento_id}): Valor hora/cargo não configurado ou inválido para o Cargo '${aloc.nome_cargo}' (ID: ${aloc.cargo_id}) no mês ${mes_ano}. Esta alocação específica não será contabilizada no custo.`);
        }
      }
      
      if (!todosCargosTinhamValorHora && alocacoesRes.rows.length > 0) {
        // Adiciona um aviso mais geral se algum cargo não pôde ser calculado.
        warnings.push(`Cliente ID ${fatura.cliente_id} (Faturamento ID ${fatura.faturamento_id}): Pelo menos uma alocação de esforço não pôde ser contabilizada devido à falta de configuração de valor/hora para o cargo. O custo total calculado para este cliente pode estar subestimado.`);
      }

      custoTotalCliente = parseFloat(custoTotalCliente.toFixed(2));

      // 4. Buscar valor do contrato do mês anterior se for uma nova inserção
      let valorContratoAtualAnterior = null; // Será usado como fallback para valor_contrato_atual_cliente_input_gerente
      const mesAnterior = getPreviousMonthDate(mes_ano);
      
      const contratoAnteriorRes = await client.query(
        `SELECT valor_contrato_atual_cliente_input_gerente 
         FROM analises_contratuais_cliente 
         WHERE cliente_id = $1 AND mes_ano_referencia = $2`,
        [fatura.cliente_id, mesAnterior]
      );

      if (contratoAnteriorRes.rows.length > 0 && contratoAnteriorRes.rows[0].valor_contrato_atual_cliente_input_gerente !== null) {
        valorContratoAtualAnterior = parseFloat(contratoAnteriorRes.rows[0].valor_contrato_atual_cliente_input_gerente);
      }

      // 6. UPSERT da análise contratual
      // 6. UPSERT da análise contratual
      const upsertAnaliseQuery = `
        INSERT INTO analises_contratuais_cliente (
          faturamento_id, cliente_id, mes_ano_referencia,
          custo_total_mao_de_obra_calculado, -- Este é o novo CustoTotalCliente
          data_analise_gerada, analise_realizada_por_usuario_id,
          valor_contrato_atual_cliente_input_gerente, 
          diferenca_analise, 
          status_alerta
        ) VALUES (
          $1, $2, $3,                          -- faturamento_id, cliente_id, mes_ano_referencia
          $4,                                  -- custoTotalCliente (para custo_total_mao_de_obra_calculado)
          CURRENT_TIMESTAMP, $5,               -- data_analise_gerada, analise_realizada_por_usuario_id (userId)
          $6,                                  -- valorContratoAtualAnterior (para valor_contrato_atual_cliente_input_gerente)
          COALESCE($6, 0::numeric) - $4,       -- diferenca_analise: valorContratoAnteriorOuZero - custoTotalCliente
          CASE                                 -- status_alerta
              WHEN COALESCE($6, 0::numeric) - $4 < 0 THEN 'REVISAR_CONTRATO' 
              ELSE 'OK' 
          END
        )
        ON CONFLICT (faturamento_id) DO UPDATE SET
          cliente_id = EXCLUDED.cliente_id, 
          mes_ano_referencia = EXCLUDED.mes_ano_referencia,
          custo_total_mao_de_obra_calculado = EXCLUDED.custo_total_mao_de_obra_calculado, -- Atualiza com o novo CustoTotalCliente
          data_analise_gerada = CURRENT_TIMESTAMP, 
          analise_realizada_por_usuario_id = EXCLUDED.analise_realizada_por_usuario_id,
          valor_contrato_atual_cliente_input_gerente = COALESCE(
            analises_contratuais_cliente.valor_contrato_atual_cliente_input_gerente, 
            EXCLUDED.valor_contrato_atual_cliente_input_gerente
          ),
          diferenca_analise = COALESCE(
            analises_contratuais_cliente.valor_contrato_atual_cliente_input_gerente, 
            EXCLUDED.valor_contrato_atual_cliente_input_gerente, 
            0::numeric
          ) - EXCLUDED.custo_total_mao_de_obra_calculado,
          status_alerta = CASE 
            WHEN COALESCE(
              analises_contratuais_cliente.valor_contrato_atual_cliente_input_gerente, 
              EXCLUDED.valor_contrato_atual_cliente_input_gerente, 
              0::numeric
            ) - EXCLUDED.custo_total_mao_de_obra_calculado < 0 THEN 'REVISAR_CONTRATO' 
            ELSE 'OK' 
          END
        RETURNING *;`;
        
      const params = [
        fatura.faturamento_id,        // $1
        fatura.cliente_id,            // $2
        fatura.mes_ano_referencia,    // $3
        custoTotalCliente,            // $4
        userId,                       // $5
        valorContratoAtualAnterior    // $6
      ];
      const analiseResult = await client.query(upsertAnaliseQuery, params);
      analisesProcessadas.push(analiseResult.rows[0]);
    }

    await client.query('COMMIT');
    logAction(userId, userEmail, 'ANALISE_CONTRATUAL_GERADA', 'AnaliseContratual', null, { mes_ano, count: analisesProcessadas.length, warnings: warnings.length });
    
    let responseMessage = `Análise para ${mes_ano} gerada/atualizada para ${analisesProcessadas.length} clientes.`;
    if (warnings.length > 0) {
        responseMessage += ` Atenção: ${warnings.length} alertas durante o processamento. Verifique os logs do servidor ou os detalhes da análise para mais informações.`;
    }
    // console.warn("Alertas da geração de análise:", warnings); // Log no servidor

    res.status(200).json({ 
        success: true, 
        message: responseMessage, 
        analises: analisesProcessadas,
        warnings: warnings 
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Erro POST /analise-contratual/gerar-analise/${mes_ano}:`, error);
    logAction(userId, userEmail, 'ANALISE_CONTRATUAL_GERAR_FAILED', 'AnaliseContratual', null, { mes_ano, error: error.message, stack: error.stack });
    res.status(500).json({ success: false, message: 'Erro interno ao gerar análise. Consulte os logs para mais detalhes.' });
  } finally {
    client.release();
  }
});

// ROTA: Listar análises para um mês/ano
router.get('/:mes_ano', auth, checkPermissionGerencial, async (req, res) => {
  const { mes_ano } = req.params; // YYYY-MM-DD (primeiro dia do mês)
  const userId = req.user.userId, userEmail = req.user.email;

  try {
    const query = `
      SELECT 
        ac.id as analise_id, 
        ac.faturamento_id, 
        ac.cliente_id, 
        cl.nome as nome_cliente, 
        cl.codigo as codigo_cliente,
        ac.mes_ano_referencia, 
        -- ac.valor_faturamento_cliente_mes, -- Removida
        ac.custo_total_mao_de_obra_calculado, -- Agora representa o CustoTotalCliente
        -- ac.custo_total_base_para_margem_calculado, -- Removida
        -- ac.percentual_margem_lucro_aplicada, -- Removida
        -- ac.valor_ideal_calculado_com_margem, -- Removida (CustoTotalCliente está em custo_total_mao_de_obra_calculado)
        ac.valor_contrato_atual_cliente_input_gerente, 
        ac.diferenca_analise, 
        ac.status_alerta,
        ac.data_analise_gerada, 
        u.nome as nome_usuario_analise
        -- uc.nome as nome_usuario_criacao, -- Removido temporariamente
        -- uu.nome as nome_usuario_atualizacao, -- Removido temporariamente
        -- ac.created_at, -- Removido temporariamente
        -- ac.updated_at -- Removido temporariamente
      FROM analises_contratuais_cliente ac
      JOIN clientes cl ON ac.cliente_id = cl.id
      LEFT JOIN usuarios u ON ac.analise_realizada_por_usuario_id = u.id
      -- LEFT JOIN usuarios uc ON ac.created_by_user_id = uc.id -- Removido temporariamente
      -- LEFT JOIN usuarios uu ON ac.updated_by_user_id = uu.id -- Removido temporariamente
      WHERE ac.mes_ano_referencia = $1 
      ORDER BY cl.nome ASC;`;
    const result = await pool.query(query, [mes_ano]);
    res.json({ success: true, analises: result.rows });
  } catch (error) {
    console.error(`Erro GET /analise-contratual/${mes_ano}:`, error);
    logAction(userId, userEmail, 'ANALISE_CONTRATUAL_LIST_FAILED', 'AnaliseContratual', null, { mes_ano, error: error.message });
    res.status(500).json({ success: false, message: 'Erro ao listar análises.' });
  }
});

// ROTA: Atualizar o "Valor do Contrato Atual" para uma análise específica
router.put('/:analise_id/valor-contrato-atual', auth, checkPermissionGerencial, async (req, res) => {
  const { analise_id } = req.params;
  const { valor_contrato_atual } = req.body;
  const userId = req.user.userId, userEmail = req.user.email;

  if (valor_contrato_atual === undefined || valor_contrato_atual === null || parseFloat(valor_contrato_atual) < 0) {
    logAction(userId, userEmail, 'ANALISE_VALOR_CONTRATO_UPDATE_FAILED', 'AnaliseContratual', analise_id, { input: req.body, error: 'Valor do contrato atual inválido.' });
    return res.status(400).json({ success: false, message: 'Valor do contrato atual é obrigatório e deve ser um número positivo.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Buscar a análise e seu custo_total_mao_de_obra_calculado (que agora é o CustoTotalCliente)
    const analiseRes = await client.query(
        'SELECT id, custo_total_mao_de_obra_calculado, cliente_id, mes_ano_referencia FROM analises_contratuais_cliente WHERE id = $1 FOR UPDATE', 
        [analise_id]
    );

    if (analiseRes.rows.length === 0) {
      await client.query('ROLLBACK');
      logAction(userId, userEmail, 'ANALISE_VALOR_CONTRATO_UPDATE_FAILED', 'AnaliseContratual', analise_id, { error: 'Análise não encontrada.' });
      return res.status(404).json({ success: false, message: 'Análise não encontrada.' });
    }

    const analiseExistente = analiseRes.rows[0];
    // O campo 'custo_total_mao_de_obra_calculado' agora guarda o Custo Total do Cliente (que já inclui a margem)
    const custoTotalClienteCalculado = parseFloat(analiseExistente.custo_total_mao_de_obra_calculado); 
    
    if (isNaN(custoTotalClienteCalculado)) {
        await client.query('ROLLBACK');
        logAction(userId, userEmail, 'ANALISE_VALOR_CONTRATO_UPDATE_FAILED', 'AnaliseContratual', analise_id, { error: 'Custo total cliente na análise é inválido ou não encontrado.' });
        return res.status(500).json({ success: false, message: 'Erro ao processar análise: custo total do cliente inválido.' });
    }

    const novoValorContrato = parseFloat(valor_contrato_atual);
    const novaDiferenca = parseFloat((novoValorContrato - custoTotalClienteCalculado).toFixed(2));
    const novoStatusAlerta = novaDiferenca < 0 ? 'REVISAR_CONTRATO' : (novaDiferenca === 0 ? 'NEUTRO' : 'OK');


    const updateQuery = `
      UPDATE analises_contratuais_cliente 
      SET 
        valor_contrato_atual_cliente_input_gerente = $1, 
        diferenca_analise = $2, 
        status_alerta = $3,
        analise_realizada_por_usuario_id = $4 -- Quem fez a última modificação relevante (input do valor)
        -- updated_by_user_id = $4, -- Coluna não existe no schema atual
        -- updated_at = CURRENT_TIMESTAMP -- Será atualizado pelo trigger do BD
      WHERE id = $5 
      RETURNING *;`;
      
    const result = await client.query(updateQuery, [
        novoValorContrato, 
        novaDiferenca, 
        novoStatusAlerta, 
        userId, 
        analise_id
    ]);

    await client.query('COMMIT');
    logAction(userId, userEmail, 'ANALISE_VALOR_CONTRATO_UPDATED', 'AnaliseContratual', analise_id, { updated_valor: novoValorContrato, old_diferenca: analiseExistente.diferenca_analise, new_diferenca: novaDiferenca });
    res.json({ success: true, message: 'Valor do contrato atualizado com sucesso!', analise: result.rows[0] });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Erro PUT /analise-contratual/${analise_id}/valor-contrato-atual:`, error);
    logAction(userId, userEmail, 'ANALISE_VALOR_CONTRATO_UPDATE_FAILED', 'AnaliseContratual', analise_id, { input: req.body, error: error.message, stack: error.stack });
    res.status(500).json({ success: false, message: 'Erro ao atualizar valor do contrato.' });
  } finally {
    client.release();
  }
});

module.exports = router;
