const db = require('../db');
const aiService = require('./ai');
const reporteiService = require('./reportei');
const whatsapp = require('./whatsapp');

async function generateWeeklyReports() {
  const clients = await db.query(
    'SELECT * FROM clients WHERE is_active = true AND report_weekly = true AND reportei_project_id IS NOT NULL'
  );
  for (const client of clients.rows) {
    await generateReport(client, 'weekly').catch(err => {
      console.error(`[Relatório] Erro semanal ${client.name}:`, err.message);
    });
  }
}

async function generateMonthlyReports() {
  const today = new Date().getDate();
  const clients = await db.query(
    'SELECT * FROM clients WHERE is_active = true AND report_monthly = true AND reportei_project_id IS NOT NULL AND report_day_of_month = $1',
    [today]
  );
  for (const client of clients.rows) {
    await generateReport(client, 'monthly').catch(err => {
      console.error(`[Relatório] Erro mensal ${client.name}:`, err.message);
    });
  }
}

async function generateReport(client, reportType) {
  const end = new Date().toISOString().split('T')[0];
  const days = reportType === 'weekly' ? 7 : 30;
  const start = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

  // 1. Gerar análise IA
  const aiResult = await aiService.analyzeClient({
    clientId: client.id,
    analysisType: 'full',
    periodStart: start,
    periodEnd: end,
    triggeredBy: 'scheduled',
  });

  // 2. Buscar integrações para passar ao Reportei
  const intResult = await db.query(
    'SELECT reportei_integration_id FROM client_integrations WHERE client_id = $1 AND is_monitored = true AND status = $2',
    [client.id, 'active']
  );
  const integrationIds = intResult.rows.map(r => r.reportei_integration_id);

  // 3. Criar relatório no Reportei (se tiver integrações)
  let reporteiUrl = null;
  if (integrationIds.length > 0) {
    try {
      const templates = await reporteiService.listTemplates();
      const templateId = templates[0]?.id;
      if (templateId) {
        const reporteiReport = await reporteiService.createReport({
          projectId: client.reportei_project_id,
          title: `Relatório ${reportType === 'weekly' ? 'Semanal' : 'Mensal'} — ${client.name}`,
          subtitle: `${new Date(start).toLocaleDateString('pt-BR')} a ${new Date(end).toLocaleDateString('pt-BR')}`,
          start, end, templateId,
          integrationIds,
        });
        reporteiUrl = reporteiReport?.external_url;
      }
    } catch (err) {
      console.error('[Relatório] Erro ao criar no Reportei:', err.message);
    }
  }

  // 4. Montar highlights para WhatsApp
  const parsed = aiResult.parsed;
  let highlights = '';
  if (parsed.working_well?.length) {
    highlights += parsed.working_well.slice(0, 2).map(w => `✅ ${w.title}`).join('\n');
  }
  if (parsed.attention_points?.length) {
    highlights += '\n' + parsed.attention_points.slice(0, 2).map(p => `⚠️ ${p.title}`).join('\n');
  }

  let topActions = '';
  if (parsed.action_plan?.length) {
    topActions = parsed.action_plan.slice(0, 3).map((a, i) => `${i + 1}. ${a.action}`).join('\n');
  }

  // 5. Salvar relatório no banco
  const reportInsert = await db.query(`
    INSERT INTO reports (client_id, title, period_start, period_end, report_type, reportei_external_url, ai_analysis_id, triggered_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
  `, [
    client.id,
    `Relatório ${reportType === 'weekly' ? 'Semanal' : 'Mensal'} — ${client.name}`,
    start, end, reportType, reporteiUrl, aiResult.analysis.id, 'scheduled'
  ]);

  // 6. Enviar WhatsApp
  if (client.phone && client.report_send_whatsapp !== false) {
    try {
      await whatsapp.sendReport(client.phone, {
        client_name: client.name,
        report_type: reportType,
        period_start: start,
        period_end: end,
        reportei_external_url: reporteiUrl,
        highlights,
        top_actions: topActions,
      });
      await db.query(
        'UPDATE reports SET sent_whatsapp = true, whatsapp_sent_at = NOW() WHERE id = $1',
        [reportInsert.rows[0].id]
      );
    } catch (err) {
      console.error('[Relatório] Erro ao enviar WhatsApp:', err.message);
    }
  }

  return reportInsert.rows[0];
}

module.exports = { generateWeeklyReports, generateMonthlyReports, generateReport };
