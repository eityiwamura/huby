const db = require('../db');
const aiService = require('./ai');
const whatsapp = require('./whatsapp');
const reporteiService = require('./reportei');
require('dotenv').config();

// ─────────────────────────────────────────
// VERIFICAR TODOS OS ALERTAS
// Rodado pelo cron a cada hora
// ─────────────────────────────────────────

async function checkAllAlerts() {
  console.log('[Alertas] Iniciando verificação...', new Date().toISOString());

  const clientsResult = await db.query(`
    SELECT c.*, u.email as responsible_email
    FROM clients c
    LEFT JOIN users u ON u.id = c.responsible_user_id
    WHERE c.is_active = true AND c.reportei_project_id IS NOT NULL
  `);

  for (const client of clientsResult.rows) {
    try {
      await checkClientAlerts(client);
    } catch (err) {
      console.error(`[Alertas] Erro no cliente ${client.name}:`, err.message);
    }
  }

  console.log('[Alertas] Verificação concluída');
}

async function checkClientAlerts(client) {
  const intResult = await db.query(
    'SELECT * FROM client_integrations WHERE client_id = $1 AND is_monitored = true AND alerts_enabled = true AND status = $2',
    [client.id, 'active']
  );

  const today = new Date().toISOString().split('T')[0];
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  for (const integration of intResult.rows) {
    // Verificações por tipo de integração
    if (['facebook_ads', 'google_adwords', 'tiktok_ads'].includes(integration.slug)) {
      await checkPaidTrafficAlerts(client, integration, sevenDaysAgo, today);
    }
    if (['instagram_business', 'facebook', 'tiktok'].includes(integration.slug)) {
      await checkOrganicAlerts(client, integration, sevenDaysAgo, today);
    }
  }
}

// ─────────────────────────────────────────
// ALERTAS DE TRÁFEGO PAGO
// ─────────────────────────────────────────

async function checkPaidTrafficAlerts(client, integration, start, end) {
  try {
    const metrics = reporteiService.METRICS_BY_SLUG[integration.slug];
    if (!metrics) return;

    const data = await reporteiService.getMetricsData({
      integrationId: integration.reportei_integration_id,
      start, end,
      metrics,
    });

    // Mapear métricas por reference_key
    const metricMap = {};
    metrics.forEach(m => {
      if (data[m.id || m.reference_key]) {
        metricMap[m.reference_key.split(':')[1]] = data[m.id || m.reference_key].values;
      }
    });

    // Verificar CPL alto
    if (integration.max_cpl && metricMap.cost_per_conversion > integration.max_cpl) {
      await createAlert(client, integration, {
        alert_type: 'high_cpl',
        severity: 'warning',
        title: `CPL alto — ${integration.name}`,
        message: `Custo por lead em R$ ${metricMap.cost_per_conversion?.toFixed(2)} (limite: R$ ${integration.max_cpl})`,
        metric_value: metricMap.cost_per_conversion,
        metric_threshold: integration.max_cpl,
        metric_unit: 'BRL',
      });
    }

    // Verificar ROAS baixo
    if (integration.min_roas && metricMap.roas < integration.min_roas && metricMap.spend > 0) {
      await createAlert(client, integration, {
        alert_type: 'low_roas',
        severity: 'critical',
        title: `ROAS abaixo do mínimo — ${integration.name}`,
        message: `ROAS atual: ${metricMap.roas?.toFixed(2)}x (mínimo esperado: ${integration.min_roas}x)`,
        metric_value: metricMap.roas,
        metric_threshold: integration.min_roas,
        metric_unit: 'x',
      });
    }

    // Verificar zero conversões com investimento
    if (metricMap.conversions === 0 && metricMap.spend > 50) {
      await createAlert(client, integration, {
        alert_type: 'no_conversions',
        severity: 'critical',
        title: `Zero conversões — ${integration.name}`,
        message: `R$ ${metricMap.spend?.toFixed(2)} investidos nos últimos 7 dias sem nenhuma conversão registrada.`,
        metric_value: 0,
        metric_threshold: 1,
        metric_unit: 'conversões',
      });
    }

    // Verificar frequência alta no Meta
    if (integration.slug === 'facebook_ads' && metricMap.frequency > 3.5) {
      await createAlert(client, integration, {
        alert_type: 'high_frequency',
        severity: 'warning',
        title: `Frequência alta — Meta Ads`,
        message: `Frequência média de ${metricMap.frequency?.toFixed(1)} — audiência possivelmente saturada. Limite recomendado: 3.0`,
        metric_value: metricMap.frequency,
        metric_threshold: 3.5,
        metric_unit: 'x',
      });
    }

  } catch (err) {
    console.error(`[Alertas Tráfego] ${client.name} / ${integration.slug}:`, err.message);
  }
}

// ─────────────────────────────────────────
// ALERTAS ORGÂNICOS
// ─────────────────────────────────────────

async function checkOrganicAlerts(client, integration, start, end) {
  try {
    const metrics = reporteiService.METRICS_BY_SLUG[integration.slug];
    if (!metrics) return;

    const data = await reporteiService.getMetricsData({
      integrationId: integration.reportei_integration_id,
      start, end,
      metrics,
    });

    const metricMap = {};
    metrics.forEach(m => {
      const key = m.reference_key.split(':')[1];
      if (data[m.id || m.reference_key]) {
        metricMap[key] = data[m.id || m.reference_key].values;
      }
    });

    // Verificar engajamento baixo
    if (integration.min_engagement_rate && metricMap.engagement_rate < integration.min_engagement_rate) {
      await createAlert(client, integration, {
        alert_type: 'low_engagement',
        severity: 'warning',
        title: `Engajamento baixo — ${integration.name}`,
        message: `Taxa de engajamento em ${metricMap.engagement_rate?.toFixed(2)}% (mínimo configurado: ${integration.min_engagement_rate}%)`,
        metric_value: metricMap.engagement_rate,
        metric_threshold: integration.min_engagement_rate,
        metric_unit: '%',
      });
    }

    // Verificar queda de seguidores
    if (metricMap.followers_gained < 0) {
      await createAlert(client, integration, {
        alert_type: 'follower_drop',
        severity: 'warning',
        title: `Queda de seguidores — ${integration.name}`,
        message: `${Math.abs(metricMap.followers_gained)} seguidores perdidos nos últimos 7 dias.`,
        metric_value: metricMap.followers_gained,
        metric_threshold: 0,
        metric_unit: 'seguidores',
      });
    }

  } catch (err) {
    console.error(`[Alertas Orgânico] ${client.name} / ${integration.slug}:`, err.message);
  }
}

// ─────────────────────────────────────────
// CRIAR E DISPARAR ALERTA
// ─────────────────────────────────────────

async function createAlert(client, integration, alertData) {
  // Verificar se já existe alerta não resolvido igual nas últimas 24h
  const existing = await db.query(`
    SELECT id FROM alerts
    WHERE client_id = $1 AND integration_id = $2 AND alert_type = $3
    AND resolved = false AND created_at > NOW() - INTERVAL '24 hours'
    LIMIT 1
  `, [client.id, integration.id, alertData.alert_type]);

  if (existing.rows.length) return; // Não duplicar alertas

  // Gerar diagnóstico da IA
  let aiDiagnosis = null, aiAction = null;
  try {
    const diagnosis = await aiService.diagnoseAlert({
      clientId: client.id,
      alertType: alertData.alert_type,
      metricValue: alertData.metric_value,
      metricThreshold: alertData.metric_threshold,
      metricUnit: alertData.metric_unit,
    });
    aiDiagnosis = diagnosis.diagnosis;
    aiAction = diagnosis.immediate_action;
  } catch (err) {
    console.error('[Alertas] Erro ao gerar diagnóstico IA:', err.message);
  }

  // Salvar alerta no banco
  const alertInsert = await db.query(`
    INSERT INTO alerts (
      client_id, integration_id, alert_type, severity, title, message,
      ai_diagnosis, ai_action, metric_value, metric_threshold, metric_unit
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id
  `, [
    client.id, integration.id, alertData.alert_type, alertData.severity,
    alertData.title, alertData.message, aiDiagnosis, aiAction,
    alertData.metric_value, alertData.metric_threshold, alertData.metric_unit,
  ]);

  const alertId = alertInsert.rows[0].id;

  // Enviar WhatsApp se o cliente tem número e alertas ativos
  if (client.phone && client.report_send_whatsapp !== false) {
    try {
      await whatsapp.sendAlert(client.phone, {
        ...alertData,
        client_name: client.name,
        ai_diagnosis: aiDiagnosis,
        ai_action: aiAction,
      });
      await db.query(
        'UPDATE alerts SET sent_whatsapp = true, whatsapp_sent_at = NOW() WHERE id = $1',
        [alertId]
      );
    } catch (err) {
      console.error('[Alertas] Erro ao enviar WhatsApp:', err.message);
    }
  }
}

// ─────────────────────────────────────────
// VERIFICAR FALTA DE POSTAGEM
// Rodado diariamente
// ─────────────────────────────────────────

async function checkNoPostAlerts() {
  const intResult = await db.query(`
    SELECT ci.*, c.name as client_name, c.phone, c.id as client_id
    FROM client_integrations ci
    JOIN clients c ON c.id = ci.client_id
    WHERE ci.is_monitored = true AND ci.alerts_enabled = true
    AND ci.status = 'active' AND ci.post_frequency_days IS NOT NULL
    AND ci.slug IN ('instagram_business', 'facebook', 'tiktok')
  `);

  for (const integration of intResult.rows) {
    try {
      const start = new Date();
      start.setDate(start.getDate() - integration.post_frequency_days);
      const startStr = start.toISOString().split('T')[0];
      const endStr = new Date().toISOString().split('T')[0];

      // Buscar métrica de posts/impressões para verificar atividade
      const metrics = reporteiService.METRICS_BY_SLUG[integration.slug];
      if (!metrics) continue;

      const data = await reporteiService.getMetricsData({
        integrationId: integration.reportei_integration_id,
        start: startStr,
        end: endStr,
        metrics: metrics.slice(0, 3), // impressões básicas
      });

      // Se impressões zeradas, provavelmente sem postagens
      const hasActivity = Object.values(data).some(d => d.values > 0);
      if (!hasActivity) {
        await createAlert(
          { id: integration.client_id, name: integration.client_name, phone: integration.phone },
          integration,
          {
            alert_type: 'no_post',
            severity: 'warning',
            title: `Sem postagens — ${integration.name}`,
            message: `Nenhuma atividade detectada em ${integration.slug.replace('_', ' ')} nos últimos ${integration.post_frequency_days} dias.`,
            metric_value: 0,
            metric_threshold: integration.post_frequency_days,
            metric_unit: 'dias',
          }
        );
      }
    } catch (err) {
      console.error(`[Alertas NoPost] ${integration.client_name}:`, err.message);
    }
  }
}

module.exports = { checkAllAlerts, checkNoPostAlerts, createAlert };
