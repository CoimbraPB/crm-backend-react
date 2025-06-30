const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');

// Middleware de Permissão (apenas Gerentes e Devs)
const checkPermissionGerencial = (req, res, next) => {
  const userPermission = req.user.permissao;
  if (['Gerente', 'Dev'].includes(userPermission)) {
    next();
  } else {
    logAction(req.user.userId, req.user.email, 'ANALISE_CONTRATUAL_ACCESS_DENIED', 'AnaliseContratual', null, { route: req.path, attemptedPermission: userPermission });
    return res.status(403).json({ success: false, message: 'Acesso negado. Permissão insuficiente.' });
  }
};

// ROTA: Gerar/Atualizar a Análise Contratual para um Mês/Ano específico
router.post('/gerar-analise/:mes_ano', auth, checkPermissionGerencial, async (req, res) => {
  const { mes_ano } = req.params; // YYYY-MM-DD (primeiro dia do mês)
  const userId = req.user.userId;
  const userEmail = req.user.email;
  const FATOR_HORAS_PADRAO_FALLBACK = 220;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const configGlobalRes = await client.query(
      'SELECT percentual_margem_lucro_desejada, fator_horas_mensal_padrao FROM configuracao_analise_global_mensal WHERE mes_ano_referencia = $1',
      [mes_ano]
    );
    if (configGlobalRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Configurações globais (margem, fator horas) não definidas para ${mes_ano}. Por favor, configure-as primeiro.` });
    }
    const configGlobal = configGlobalRes.rows[0];
    const percentualMargem = parseFloat(configGlobal.percentual_margem_lucro_desejada) / 100;
    const fatorHoras = parseInt(configGlobal.fator_horas_mensal_padrao) || FATOR_HORAS_PADRAO_FALLBACK;

    const salariosRes = await client.query(
      'SELECT setor_id, cargo_id, salario_mensal_base FROM configuracoes_salario_cargo_mensal WHERE mes_ano_referencia = $1',
      [mes_ano]
    );
    const mapSalarios = new Map();
    salariosRes.rows.forEach(s => {
      mapSalarios.set(`${s.setor_id}-${s.cargo_id}`, parseFloat(s.salario_mensal_base));
    });

    if (mapSalarios.size === 0) {
        console.warn(`Nenhuma configuração de salário encontrada para ${mes_ano} em configuracoes_salario_cargo_mensal. Custos de mão de obra podem ser zero se houver alocações sem salários correspondentes.`);
    }

    const faturamentosDoMesRes = await client.query(
      `SELECT f.id as faturamento_id, f.cliente_id, f.mes_ano as mes_ano_referencia, f.valor_faturamento
       FROM faturamentos f
       WHERE f.mes_ano = $1 AND EXISTS (
         SELECT 1 FROM alocacao_esforco_cliente_cargo ae 
         WHERE ae.faturamento_id = f.id
       )
      `,
      [mes_ano]
    );

    if (faturamentosDoMesRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: `Nenhum faturamento encontrado em ${mes_ano} que possua lançamentos de esforço associados. Verifique os lançamentos de esforço ou os faturamentos.` });
    }

    const analisesProcessadas = [];

    for (const fatura of faturamentosDoMesRes.rows) {
      const alocacoesRes = await client.query(
        'SELECT setor_id, cargo_id, quantidade_funcionarios, total_horas_gastas_cargo FROM alocacao_esforco_cliente_cargo WHERE faturamento_id = $1',
        [fatura.faturamento_id]
      );

      let custoTotalMaoDeObraCliente = 0;
      for (const aloc of alocacoesRes.rows) {
        const salarioBase = mapSalarios.get(`${aloc.setor_id}-${aloc.cargo_id}`);
        if (salarioBase !== undefined && salarioBase > 0 && fatorHoras > 0) {
          const custoHoraCargo = salarioBase / fatorHoras;
          custoTotalMaoDeObraCliente += parseFloat(aloc.total_horas_gastas_cargo) * custoHoraCargo;
        } else {
            console.warn(`Salário não configurado ou inválido para setor ${aloc.setor_id}, cargo ${aloc.cargo_id} no mês ${mes_ano} para faturamento ${fatura.faturamento_id}. Custo dessa alocação será zero.`);
        }
      }
      custoTotalMaoDeObraCliente = parseFloat(custoTotalMaoDeObraCliente.toFixed(2));

      const valorFaturamentoClienteMes = parseFloat(fatura.valor_faturamento);
      const custoTotalBaseParaMargem = valorFaturamentoClienteMes + custoTotalMaoDeObraCliente;
      const valorIdealComMargem = parseFloat((custoTotalBaseParaMargem * (1 + percentualMargem)).toFixed(2));

      // --- INÍCIO DA LÓGICA PARA VALOR DO CONTRATO ATUAL ---
      let valorContratoAtualPredefinido = null;
      
      const dataMesCorrenteParts = fatura.mes_ano_referencia.split('-').map(Number);
      const dataMesCorrenteObj = new Date(Date.UTC(dataMesCorrenteParts[0], dataMesCorrenteParts[1] - 1, dataMesCorrenteParts[2]));
      
      dataMesCorrenteObj.setUTCMonth(dataMesCorrenteObj.getUTCMonth() - 1);
      const mesAnoAnteriorString = `${dataMesCorrenteObj.getUTCFullYear()}-${String(dataMesCorrenteObj.getUTCMonth() + 1).padStart(2, '0')}-${String(dataMesCorrenteObj.getUTCDate()).padStart(2, '0')}`;

      const analiseAnteriorRes = await client.query(
        `SELECT valor_contrato_atual_cliente_input_gerente 
         FROM analises_contratuais_cliente
         WHERE cliente_id = $1 AND mes_ano_referencia = $2`,
        [fatura.cliente_id, mesAnoAnteriorString]
      );

      if (analiseAnteriorRes.rows.length > 0 && analiseAnteriorRes.rows[0].valor_contrato_atual_cliente_input_gerente !== null) {
        valorContratoAtualPredefinido = parseFloat(analiseAnteriorRes.rows[0].valor_contrato_atual_cliente_input_gerente);
      }
      // --- FIM DA LÓGICA PARA VALOR DO CONTRATO ATUAL ---

      // Lógica para determinar o valor_contrato_atual a ser usado no UPSERT
      const analiseExistenteRes = await client.query(
        'SELECT valor_contrato_atual_cliente_input_gerente FROM analises_contratuais_cliente WHERE faturamento_id = $1',
        [fatura.faturamento_id]
      );
      
      let valorContratoParaUpsert = valorContratoAtualPredefinido;
      if (analiseExistenteRes.rows.length > 0 && analiseExistenteRes.rows[0].valor_contrato_atual_cliente_input_gerente !== null) {
        valorContratoParaUpsert = parseFloat(analiseExistenteRes.rows[0].valor_contrato_atual_cliente_input_gerente);
      }

      const diferencaCalculada = valorContratoParaUpsert !== null ? parseFloat((valorContratoParaUpsert - valorIdealComMargem).toFixed(2)) : null;
      const statusAlertaCalculado = diferencaCalculada !== null ? (diferencaCalculada < 0 ? 'REVISAR_CONTRATO' : 'OK') : null;

      const finalUpsertQuery = `
        INSERT INTO analises_contratuais_cliente (
          faturamento_id, cliente_id, mes_ano_referencia, valor_faturamento_cliente_mes,
          custo_total_mao_de_obra_calculado, custo_total_base_para_margem_calculado,
          percentual_margem_lucro_aplicada, valor_ideal_calculado_com_margem,
          data_analise_gerada, analise_realizada_por_usuario_id,
          valor_contrato_atual_cliente_input_gerente, 
          diferenca_analise, status_alerta
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, $9, $10, $11, $12)
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
          valor_contrato_atual_cliente_input_gerente = COALESCE(analises_contratuais_cliente.valor_contrato_atual_cliente_input_gerente, EXCLUDED.valor_contrato_atual_cliente_input_gerente),
          diferenca_analise = COALESCE(analises_contratuais_cliente.valor_contrato_atual_cliente_input_gerente, EXCLUDED.valor_contrato_atual_cliente_input_gerente) - EXCLUDED.valor_ideal_calculado_com_margem,
          status_alerta = CASE 
                            WHEN COALESCE(analises_contratuais_cliente.valor_contrato_atual_cliente_input_gerente, EXCLUDED.valor_contrato_atual_cliente_input_gerente) - EXCLUDED.valor_ideal_calculado_com_margem < 0 THEN 'REVISAR_CONTRATO'
                            ELSE 'OK' 
                          END
        RETURNING *;
      `;
      
      const analiseResult = await client.query(finalUpsertQuery, [
        fatura.faturamento_id, fatura.cliente_id, fatura.mes_ano_referencia, valorFaturamentoClienteMes,
        custoTotalMaoDeObraCliente, custoTotalBaseParaMargem,
        configGlobal.percentual_margem_lucro_desejada, 
        valorIdealComMargem, 
        userId,
        valorContratoParaUpsert, // $10
        diferencaCalculada,      // $11
        statusAlertaCalculado    // $12
      ]);
      analisesProcessadas.push(analiseResult.rows[0]);
    }

    await client.query('COMMIT');
    logAction(userId, userEmail, 'ANALISE_CONTRATUAL_GERADA', 'AnaliseContratual', null, { mes_ano, count: analisesProcessadas.length });
    res.status(200).json({ success: true, message: `Análise para ${mes_ano} gerada/atualizada para ${analisesProcessadas.length} clientes.`, analises: analisesProcessadas });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Erro ao gerar análise para ${mes_ano}:`, error);
    logAction(userId, userEmail, 'ANALISE_CONTRATUAL_GERAR_FAILED', 'AnaliseContratual', null, { mes_ano, error: error.message });
    res.status(500).json({ success: false, message: 'Erro interno ao gerar análise contratual.' });
  } finally {
    client.release();
  }
});

// ROTA: Listar análises para um mês/ano
router.get('/:mes_ano', auth, checkPermissionGerencial, async (req, res) => {
  const { mes_ano } = req.params; 
  try {
    const query = `
      SELECT 
        ac.id as analise_id, ac.faturamento_id, ac.cliente_id, cl.nome as nome_cliente, cl.codigo as codigo_cliente,
        ac.mes_ano_referencia, ac.valor_faturamento_cliente_mes, 
        ac.custo_total_mao_de_obra_calculado, ac.custo_total_base_para_margem_calculado,
        ac.percentual_margem_lucro_aplicada, ac.valor_ideal_calculado_com_margem,
        ac.valor_contrato_atual_cliente_input_gerente, ac.diferenca_analise, ac.status_alerta,
        ac.data_analise_gerada, u.nome as nome_usuario_analise
      FROM analises_contratuais_cliente ac
      JOIN clientes cl ON ac.cliente_id = cl.id
      LEFT JOIN usuarios u ON ac.analise_realizada_por_usuario_id = u.id
      WHERE ac.mes_ano_referencia = $1
      ORDER BY cl.nome ASC;
    `;
    const result = await pool.query(query, [mes_ano]);
    res.json({ success: true, analises: result.rows });
  } catch (error) {
    console.error(`Erro ao listar análises para ${mes_ano}:`, error);
    logAction(req.user.userId, req.user.email, 'ANALISE_CONTRATUAL_LIST_FAILED', 'AnaliseContratual', null, { mes_ano, error: error.message });
    res.status(500).json({ success: false, message: 'Erro interno ao listar análises.' });
  }
});

// ROTA: Atualizar o "Valor do Contrato Atual" e recalcular diferença/alerta para uma análise específica
router.put('/:analise_id/valor-contrato-atual', auth, checkPermissionGerencial, async (req, res) => {
  const { analise_id } = req.params;
  const { valor_contrato_atual } = req.body;
  const userId = req.user.userId;
  const userEmail = req.user.email;

  if (valor_contrato_atual === undefined || parseFloat(valor_contrato_atual) < 0) {
    return res.status(400).json({ success: false, message: 'Valor do contrato atual inválido ou ausente.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const analiseRes = await client.query('SELECT valor_ideal_calculado_com_margem FROM analises_contratuais_cliente WHERE id = $1', [analise_id]);
    if (analiseRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Análise não encontrada.' });
    }
    const valorIdeal = parseFloat(analiseRes.rows[0].valor_ideal_calculado_com_margem);
    const novoValorContrato = parseFloat(valor_contrato_atual);
    const novaDiferenca = parseFloat((novoValorContrato - valorIdeal).toFixed(2));
    const novoStatusAlerta = novaDiferenca < 0 ? 'REVISAR_CONTRATO' : 'OK';

    const updateQuery = `
      UPDATE analises_contratuais_cliente 
      SET 
        valor_contrato_atual_cliente_input_gerente = $1,
        diferenca_analise = $2,
        status_alerta = $3,
        analise_realizada_por_usuario_id = $4,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *;
    `;
    const result = await client.query(updateQuery, [novoValorContrato, novaDiferenca, novoStatusAlerta, userId, analise_id]);
    await client.query('COMMIT');
    
    const analiseAtualizada = result.rows[0];
    logAction(userId, userEmail, 'ANALISE_VALOR_CONTRATO_UPDATED', 'AnaliseContratual', analise_id, { updated_valor: novoValorContrato, analise: analiseAtualizada });
    res.json({ success: true, message: 'Valor do contrato atualizado com sucesso!', analise: analiseAtualizada });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Erro ao atualizar valor do contrato para análise ${analise_id}:`, error);
    logAction(userId, userEmail, 'ANALISE_VALOR_CONTRATO_UPDATE_FAILED', 'AnaliseContratual', analise_id, { input: req.body, error: error.message });
    res.status(500).json({ success: false, message: 'Erro interno ao atualizar valor do contrato.' });
  } finally {
    client.release();
  }
});

module.exports = router;