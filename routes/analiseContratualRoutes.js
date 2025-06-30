const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const { logAction, ACTION_TYPES, ENTITY_TYPES } = require('../services/auditLogService');

const checkPermissionGerencial = (req, res, next) => {
  const userPermission = req.user.permissao;
  if (['Gerente', 'Dev'].includes(userPermission)) {
    next();
  } else {
    logAction(req.user.userId, req.user.email, 'ANALISE_CONTRATUAL_ACCESS_DENIED', 'AnaliseContratual', null, { route: req.path, attemptedPermission: userPermission });
    return res.status(403).json({ success: false, message: 'Acesso negado.' });
  }
};

// ROTA: Gerar/Atualizar Análise para um Mês/Ano
router.post('/gerar-analise/:mes_ano', auth, checkPermissionGerencial, async (req, res) => {
  const { mes_ano } = req.params; // YYYY-MM-DD
  const userId = req.user.userId, userEmail = req.user.email;
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
      return res.status(400).json({ success: false, message: `Configs globais não definidas para ${mes_ano}.` });
    }
    const configGlobal = configGlobalRes.rows[0];
    const percentualMargem = parseFloat(configGlobal.percentual_margem_lucro_desejada) / 100;
    const fatorHoras = parseInt(configGlobal.fator_horas_mensal_padrao) || FATOR_HORAS_PADRAO_FALLBACK;

    const salariosRes = await client.query(
      'SELECT setor_id, cargo_id, salario_mensal_base FROM configuracoes_salario_cargo_mensal WHERE mes_ano_referencia = $1',
      [mes_ano]
    );
    const mapSalarios = new Map();
    salariosRes.rows.forEach(s => mapSalarios.set(`${s.setor_id}-${s.cargo_id}`, parseFloat(s.salario_mensal_base)));

    const faturamentosDoMesRes = await client.query(
      `SELECT f.id as faturamento_id, f.cliente_id, f.mes_ano as mes_ano_referencia, f.valor_faturamento
       FROM faturamentos f WHERE f.mes_ano = $1 AND EXISTS (
         SELECT 1 FROM alocacao_esforco_cliente_cargo ae WHERE ae.faturamento_id = f.id )`,
      [mes_ano]
    );
    if (faturamentosDoMesRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: `Nenhum faturamento com esforço lançado para ${mes_ano}.` });
    }

    const analisesProcessadas = [];
    for (const fatura of faturamentosDoMesRes.rows) {
      const alocacoesRes = await client.query(
        'SELECT setor_id, cargo_id, total_horas_gastas_cargo FROM alocacao_esforco_cliente_cargo WHERE faturamento_id = $1',
        [fatura.faturamento_id]
      );
      let custoTotalMaoDeObraCliente = 0;
      for (const aloc of alocacoesRes.rows) {
        const salarioBase = mapSalarios.get(`${aloc.setor_id}-${aloc.cargo_id}`);
        if (salarioBase && fatorHoras > 0) {
          custoTotalMaoDeObraCliente += parseFloat(aloc.total_horas_gastas_cargo) * (salarioBase / fatorHoras);
        } else {
          console.warn(`Salário não configurado para setor ${aloc.setor_id}, cargo ${aloc.cargo_id} no mês ${mes_ano}.`);
        }
      }
      custoTotalMaoDeObraCliente = parseFloat(custoTotalMaoDeObraCliente.toFixed(2));
      const valorFaturamentoClienteMes = parseFloat(fatura.valor_faturamento);
      const custoTotalBaseParaMargem = valorFaturamentoClienteMes + custoTotalMaoDeObraCliente;
      const valorIdealComMargem = parseFloat((custoTotalBaseParaMargem * (1 + percentualMargem)).toFixed(2));

      const upsertAnaliseQuery = `
        INSERT INTO analises_contratuais_cliente (
          faturamento_id, cliente_id, mes_ano_referencia, valor_faturamento_cliente_mes,
          custo_total_mao_de_obra_calculado, custo_total_base_para_margem_calculado,
          percentual_margem_lucro_aplicada, valor_ideal_calculado_com_margem,
          data_analise_gerada, analise_realizada_por_usuario_id,
          valor_contrato_atual_cliente_input_gerente, diferenca_analise, status_alerta
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, $9, 
                  (SELECT acc_ant.valor_contrato_atual_cliente_input_gerente FROM analises_contratuais_cliente acc_ant WHERE acc_ant.faturamento_id = $1), 
                  (SELECT acc_ant.diferenca_analise FROM analises_contratuais_cliente acc_ant WHERE acc_ant.faturamento_id = $1),
                  (SELECT acc_ant.status_alerta FROM analises_contratuais_cliente acc_ant WHERE acc_ant.faturamento_id = $1)
        )
        ON CONFLICT (faturamento_id) DO UPDATE SET
          cliente_id = EXCLUDED.cliente_id, mes_ano_referencia = EXCLUDED.mes_ano_referencia,
          valor_faturamento_cliente_mes = EXCLUDED.valor_faturamento_cliente_mes,
          custo_total_mao_de_obra_calculado = EXCLUDED.custo_total_mao_de_obra_calculado,
          custo_total_base_para_margem_calculado = EXCLUDED.custo_total_base_para_margem_calculado,
          percentual_margem_lucro_aplicada = EXCLUDED.percentual_margem_lucro_aplicada,
          valor_ideal_calculado_com_margem = EXCLUDED.valor_ideal_calculado_com_margem,
          data_analise_gerada = CURRENT_TIMESTAMP, analise_realizada_por_usuario_id = EXCLUDED.analise_realizada_por_usuario_id,
          diferenca_analise = COALESCE(analises_contratuais_cliente.valor_contrato_atual_cliente_input_gerente, 0) - EXCLUDED.valor_ideal_calculado_com_margem,
          status_alerta = CASE WHEN COALESCE(analises_contratuais_cliente.valor_contrato_atual_cliente_input_gerente, 0) - EXCLUDED.valor_ideal_calculado_com_margem < 0 THEN 'REVISAR_CONTRATO' ELSE 'OK' END
        RETURNING *;`;
      const analiseResult = await client.query(upsertAnaliseQuery, [
        fatura.faturamento_id, fatura.cliente_id, fatura.mes_ano_referencia, valorFaturamentoClienteMes,
        custoTotalMaoDeObraCliente, custoTotalBaseParaMargem,
        configGlobal.percentual_margem_lucro_desejada, valorIdealComMargem, userId
      ]);
      analisesProcessadas.push(analiseResult.rows[0]);
    }
    await client.query('COMMIT');
    logAction(userId, userEmail, 'ANALISE_CONTRATUAL_GERADA', 'AnaliseContratual', null, { mes_ano, count: analisesProcessadas.length });
    res.status(200).json({ success: true, message: `Análise para ${mes_ano} gerada/atualizada para ${analisesProcessadas.length} clientes.`, analises: analisesProcessadas });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Erro POST /analise-contratual/gerar-analise/${mes_ano}:`, error);
    logAction(userId, userEmail, 'ANALISE_CONTRATUAL_GERAR_FAILED', 'AnaliseContratual', null, { mes_ano, error: error.message });
    res.status(500).json({ success: false, message: 'Erro ao gerar análise.' });
  } finally {
    client.release();
  }
});

// ROTA: Listar análises para um mês/ano
router.get('/:mes_ano', auth, checkPermissionGerencial, async (req, res) => {
  const { mes_ano } = req.params;
  try {
    const query = `
      SELECT ac.id as analise_id, ac.faturamento_id, ac.cliente_id, cl.nome as nome_cliente, cl.codigo as codigo_cliente,
        ac.mes_ano_referencia, ac.valor_faturamento_cliente_mes, ac.custo_total_mao_de_obra_calculado, 
        ac.custo_total_base_para_margem_calculado, ac.percentual_margem_lucro_aplicada, ac.valor_ideal_calculado_com_margem,
        ac.valor_contrato_atual_cliente_input_gerente, ac.diferenca_analise, ac.status_alerta,
        ac.data_analise_gerada, u.nome as nome_usuario_analise
      FROM analises_contratuais_cliente ac
      JOIN clientes cl ON ac.cliente_id = cl.id
      LEFT JOIN usuarios u ON ac.analise_realizada_por_usuario_id = u.id
      WHERE ac.mes_ano_referencia = $1 ORDER BY cl.nome ASC;`;
    const result = await pool.query(query, [mes_ano]);
    res.json({ success: true, analises: result.rows });
  } catch (error) {
    console.error(`Erro GET /analise-contratual/${mes_ano}:`, error);
    logAction(req.user.userId, req.user.email, 'ANALISE_CONTRATUAL_LIST_FAILED', 'AnaliseContratual', null, { mes_ano, error: error.message });
    res.status(500).json({ success: false, message: 'Erro ao listar análises.' });
  }
});

// ROTA: Atualizar o "Valor do Contrato Atual" para uma análise
router.put('/:analise_id/valor-contrato-atual', auth, checkPermissionGerencial, async (req, res) => {
  const { analise_id } = req.params;
  const { valor_contrato_atual } = req.body;
  const userId = req.user.userId, userEmail = req.user.email;
  if (valor_contrato_atual === undefined || parseFloat(valor_contrato_atual) < 0) {
    return res.status(400).json({ success: false, message: 'Valor do contrato atual inválido.' });
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

    const updateQuery = `UPDATE analises_contratuais_cliente SET 
        valor_contrato_atual_cliente_input_gerente = $1, diferenca_analise = $2, status_alerta = $3,
        analise_realizada_por_usuario_id = $4, updated_at = CURRENT_TIMESTAMP
      WHERE id = $5 RETURNING *;`;
    const result = await client.query(updateQuery, [novoValorContrato, novaDiferenca, novoStatusAlerta, userId, analise_id]);
    await client.query('COMMIT');
    logAction(userId, userEmail, 'ANALISE_VALOR_CONTRATO_UPDATED', 'AnaliseContratual', analise_id, { updated_valor: novoValorContrato });
    res.json({ success: true, message: 'Valor do contrato atualizado!', analise: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Erro PUT /analise-contratual/${analise_id}/valor-contrato-atual:`, error);
    logAction(userId, userEmail, 'ANALISE_VALOR_CONTRATO_UPDATE_FAILED', 'AnaliseContratual', analise_id, { input: req.body, error: error.message });
    res.status(500).json({ success: false, message: 'Erro ao atualizar valor do contrato.' });
  } finally {
    client.release();
  }
});

module.exports = router;