const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction } = require('../services/auditLogService');

const checkPermissionGerencial = (req, res, next) => {
  const userPermission = req.user.permissao;
  if (['Gerente', 'Dev', 'Gestor'].includes(userPermission)) { // Adicionado Gestor conforme discussão anterior
    next();
  } else {
    logAction(req.user.userId, req.user.email, 'ANALISE_CONTRATUAL_ACCESS_DENIED', 'AnaliseContratual', null, { route: req.path, attemptedPermission: userPermission });
    return res.status(403).json({ success: false, message: 'Acesso negado. Requer permissão de Gerente, Gestor ou Dev.' });
  }
};

// Função auxiliar para obter o primeiro dia do mês anterior
const getPreviousMonthDate = (currentMesAno) => {
  const currentDate = new Date(currentMesAno + '-01T00:00:00Z'); // Assegura que é UTC para evitar problemas de fuso
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

    // 1. Buscar configurações globais para o mês/ano
    const configGlobalRes = await client.query(
      'SELECT percentual_margem_lucro_desejada, fator_horas_mensal_padrao FROM configuracao_analise_global_mensal WHERE mes_ano_referencia = $1',
      [mes_ano]
    );
    if (configGlobalRes.rows.length === 0) {
      await client.query('ROLLBACK');
      logAction(userId, userEmail, 'ANALISE_CONTRATUAL_GERAR_FAILED', 'AnaliseContratual', null, { mes_ano, error: 'Configurações globais não definidas.' });
      return res.status(400).json({ success: false, message: `Erro ao gerar análise: Configurações globais (Margem de Lucro, Fator Horas) não definidas para ${mes_ano}. Por favor, cadastre-as na tela de Configurações da Análise Contratual.` });
    }
    const configGlobal = configGlobalRes.rows[0];
    const percentualMargem = parseFloat(configGlobal.percentual_margem_lucro_desejada) / 100;
    const fatorHoras = parseInt(configGlobal.fator_horas_mensal_padrao) || FATOR_HORAS_PADRAO_FALLBACK;

    if (isNaN(percentualMargem) || percentualMargem < 0) {
        await client.query('ROLLBACK');
        logAction(userId, userEmail, 'ANALISE_CONTRATUAL_GERAR_FAILED', 'AnaliseContratual', null, { mes_ano, error: 'Percentual de margem de lucro inválido.' });
        return res.status(400).json({ success: false, message: 'Percentual de margem de lucro desejada configurado é inválido.' });
    }
    if (isNaN(fatorHoras) || fatorHoras <= 0) {
        await client.query('ROLLBACK');
        logAction(userId, userEmail, 'ANALISE_CONTRATUAL_GERAR_FAILED', 'AnaliseContratual', null, { mes_ano, error: 'Fator de horas mensal padrão inválido.' });
        return res.status(400).json({ success: false, message: 'Fator de horas mensal padrão configurado é inválido.' });
    }


    // 2. Buscar salários configurados para o mês/ano
    const salariosRes = await client.query(
      'SELECT setor_id, cargo_id, salario_mensal_base FROM configuracoes_salario_cargo_mensal WHERE mes_ano_referencia = $1',
      [mes_ano]
    );
    const mapSalarios = new Map();
    salariosRes.rows.forEach(s => mapSalarios.set(`${s.setor_id}-${s.cargo_id}`, parseFloat(s.salario_mensal_base)));

    if (mapSalarios.size === 0) {
        await client.query('ROLLBACK');
        logAction(userId, userEmail, 'ANALISE_CONTRATUAL_GERAR_FAILED', 'AnaliseContratual', null, { mes_ano, error: 'Nenhum salário configurado.' });
        return res.status(400).json({ success: false, message: `Erro ao gerar análise: Nenhum salário configurado para os cargos/setores no mês ${mes_ano}. Por favor, cadastre-os na tela de Configurações da Análise Contratual.` });
    }

    // 3. Buscar faturamentos do mês que possuem alocação de esforço
    const faturamentosDoMesRes = await client.query(
      `SELECT f.id as faturamento_id, f.cliente_id, f.mes_ano as mes_ano_referencia, f.valor_faturamento
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
      // 4. Calcular custo de mão de obra para cada faturamento
      const alocacoesRes = await client.query(
        'SELECT ae.setor_id, ae.cargo_id, ae.total_horas_gastas_cargo, s.nome_setor, c.nome_cargo FROM alocacao_esforco_cliente_cargo ae JOIN setores s ON s.id_setor = ae.setor_id JOIN cargos c ON c.id_cargo = ae.cargo_id WHERE ae.faturamento_id = $1',
        [fatura.faturamento_id]
      );

      if (alocacoesRes.rows.length === 0) {
        warnings.push(`Cliente ID ${fatura.cliente_id} (Faturamento ID ${fatura.faturamento_id}): Nenhuma alocação de esforço encontrada, pulando cálculo de custo de mão de obra.`);
        continue;
      }

      let custoTotalMaoDeObraCliente = 0;
      let temAlocacaoValida = false;

      for (const aloc of alocacoesRes.rows) {
        const salarioBase = mapSalarios.get(`${aloc.setor_id}-${aloc.cargo_id}`);
        if (salarioBase !== undefined && salarioBase > 0) {
          temAlocacaoValida = true;
          custoTotalMaoDeObraCliente += parseFloat(aloc.total_horas_gastas_cargo) * (salarioBase / fatorHoras);
        } else {
          warnings.push(`Cliente ID ${fatura.cliente_id} (Faturamento ID ${fatura.faturamento_id}): Salário não configurado ou inválido para Setor '${aloc.nome_setor}' e Cargo '${aloc.nome_cargo}' no mês ${mes_ano}. Esta alocação não será contabilizada no custo.`);
        }
      }

      if (!temAlocacaoValida && alocacoesRes.rows.length > 0) {
        warnings.push(`Cliente ID ${fatura.cliente_id} (Faturamento ID ${fatura.faturamento_id}): Todas as alocações de esforço não puderam ser contabilizadas por falta de configuração de salário. Custo de mão de obra será R$0.00.`);
      }


      custoTotalMaoDeObraCliente = parseFloat(custoTotalMaoDeObraCliente.toFixed(2));
      const valorFaturamentoClienteMes = parseFloat(fatura.valor_faturamento);
      const custoTotalBaseParaMargem = valorFaturamentoClienteMes + custoTotalMaoDeObraCliente;
      const valorIdealComMargem = parseFloat((custoTotalBaseParaMargem * (1 + percentualMargem)).toFixed(2));

      // 5. Buscar valor do contrato do mês anterior se for uma nova inserção
      let valorContratoAtualAnterior = null;
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
      // No INSERT, se valorContratoAtualAnterior for null, ele será inserido como NULL.
      // A lógica de diferenca_analise e status_alerta usará COALESCE para tratar esse NULL como 0 para o cálculo inicial.
      const upsertAnaliseQuery = `
        INSERT INTO analises_contratuais_cliente (
          faturamento_id, cliente_id, mes_ano_referencia, valor_faturamento_cliente_mes,
          custo_total_mao_de_obra_calculado, custo_total_base_para_margem_calculado,
          percentual_margem_lucro_aplicada, valor_ideal_calculado_com_margem,
          data_analise_gerada, analise_realizada_por_usuario_id,
          valor_contrato_atual_cliente_input_gerente,
          diferenca_analise,
          status_alerta,
          created_by_user_id, updated_by_user_id
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, $9,
            $10, -- valor_contrato_atual_cliente_input_gerente (pode ser null)
            COALESCE($10, 0) - $8, -- diferenca_analise
            CASE
                WHEN COALESCE($10, 0) - $8 < 0 THEN 'REVISAR_CONTRATO'
                ELSE 'OK'
            END, -- status_alerta
            $9, $9
        )
        ON CONFLICT (faturamento_id) DO UPDATE SET
          cliente_id = EXCLUDED.cliente_id,
          mes_ano_referencia = EXCLUDED.mes_ano_referencia,
          valor_faturamento_cliente_mes = EXCLUDED.valor_faturamento_cliente_mes,
          custo_total_mao_de_obra_calculado = EXCLUDED.custo_total_mao_de_obra_calculado,
          custo_total_base_para_margem_calculado = EXCLUDED.custo_total_base_para_margem_calculado,
          percentual_margem_lucro_aplicada = EXCLUDED.percentual_margem_lucro_aplicada,
          valor_ideal_calculado_com_margem = EXCLUDED.valor_ideal_calculado_com_margem,
          data_analise_gerada = CURRENT_TIMESTAMP,
          analise_realizada_por_usuario_id = EXCLUDED.analise_realizada_por_usuario_id,
          -- Mantém o valor_contrato_atual_cliente_input_gerente existente no UPDATE,
          -- ele só é alterado pela rota PUT específica.
          -- No entanto, se ele era NULL e o EXCLUDED.valor_contrato_atual_cliente_input_gerente (que veio do $10)
          -- tiver um valor (do mês anterior), usamos esse valor.
          valor_contrato_atual_cliente_input_gerente = COALESCE(
            analises_contratuais_cliente.valor_contrato_atual_cliente_input_gerente, -- valor já existente na tabela para este faturamento_id
            EXCLUDED.valor_contrato_atual_cliente_input_gerente -- valor do INSERT (que pode ser do mês anterior ou null)
          ),
          diferenca_analise = COALESCE(analises_contratuais_cliente.valor_contrato_atual_cliente_input_gerente, EXCLUDED.valor_contrato_atual_cliente_input_gerente, 0) - EXCLUDED.valor_ideal_calculado_com_margem,
          status_alerta = CASE
                            WHEN COALESCE(analises_contratuais_cliente.valor_contrato_atual_cliente_input_gerente, EXCLUDED.valor_contrato_atual_cliente_input_gerente, 0) - EXCLUDED.valor_ideal_calculado_com_margem < 0 THEN 'REVISAR_CONTRATO'
                            ELSE 'OK'
                          END,
          updated_by_user_id = EXCLUDED.updated_by_user_id,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *;`;

      const analiseResult = await client.query(upsertAnaliseQuery, [
        fatura.faturamento_id, fatura.cliente_id, fatura.mes_ano_referencia, valorFaturamentoClienteMes,
        custoTotalMaoDeObraCliente, custoTotalBaseParaMargem,
        configGlobal.percentual_margem_lucro_desejada, // Armazena o percentual usado
        valorIdealComMargem,
        userId,
        valorContratoAtualAnterior // $10: Usado para o COALESCE no INSERT e no UPDATE
      ]);
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
        ac.valor_faturamento_cliente_mes,
        ac.custo_total_mao_de_obra_calculado,
        ac.custo_total_base_para_margem_calculado,
        ac.percentual_margem_lucro_aplicada,
        ac.valor_ideal_calculado_com_margem,
        ac.valor_contrato_atual_cliente_input_gerente,
        ac.diferenca_analise,
        ac.status_alerta,
        ac.data_analise_gerada,
        u.nome as nome_usuario_analise,
        uc.nome as nome_usuario_criacao,
        uu.nome as nome_usuario_atualizacao,
        ac.created_at,
        ac.updated_at
      FROM analises_contratuais_cliente ac
      JOIN clientes cl ON ac.cliente_id = cl.id
      LEFT JOIN usuarios u ON ac.analise_realizada_por_usuario_id = u.id
      LEFT JOIN usuarios uc ON ac.created_by_user_id = uc.id
      LEFT JOIN usuarios uu ON ac.updated_by_user_id = uu.id
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

    // Buscar a análise e seu valor ideal calculado
    const analiseRes = await client.query(
        'SELECT id, valor_ideal_calculado_com_margem, cliente_id, mes_ano_referencia FROM analises_contratuais_cliente WHERE id = $1 FOR UPDATE',
        [analise_id]
    );

    if (analiseRes.rows.length === 0) {
      await client.query('ROLLBACK');
      logAction(userId, userEmail, 'ANALISE_VALOR_CONTRATO_UPDATE_FAILED', 'AnaliseContratual', analise_id, { error: 'Análise não encontrada.' });
      return res.status(404).json({ success: false, message: 'Análise não encontrada.' });
    }

    const analiseExistente = analiseRes.rows[0];
    const valorIdeal = parseFloat(analiseExistente.valor_ideal_calculado_com_margem);
    const novoValorContrato = parseFloat(valor_contrato_atual);
    const novaDiferenca = parseFloat((novoValorContrato - valorIdeal).toFixed(2));
    const novoStatusAlerta = novaDiferenca < 0 ? 'REVISAR_CONTRATO' : (novaDiferenca === 0 ? 'NEUTRO' : 'OK');


    const updateQuery = `
      UPDATE analises_contratuais_cliente
      SET
        valor_contrato_atual_cliente_input_gerente = $1,
        diferenca_analise = $2,
        status_alerta = $3,
        analise_realizada_por_usuario_id = $4, -- Quem fez a última modificação relevante (input do valor)
        updated_by_user_id = $4,
        updated_at = CURRENT_TIMESTAMP
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