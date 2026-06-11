const express = require('express');
const router = express.Router();
const db = require('../db');
const aiService = require('../services/ai');
const reporteiService = require('../services/reportei');
const alertsService = require('../services/alerts');
const { requireAuth } = require('../middlewares/auth');

router.use(requireAuth);

// ─────────────────────────────────────────
// CLIENTES
// ─────────────────────────────────────────

router.get('/clients', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT c.*, u.name as responsible_name,
        (SELECT COUNT(*) FROM client_integrations ci WHERE ci.client_id = c.id AND ci.is_monitored = true) as active_integrations,
        (SELECT COUNT(*) FROM alerts a WHERE a.client_id = c.id AND a.resolved = false) as pending_alerts,
        (SELECT created_at FROM ai_analyses WHERE client_id = c.id ORDER BY created_at DESC LIMIT 1) as last_analysis
      FROM clients c
      LEFT JOIN users u ON u.id = c.responsible_user_id
      WHERE c.is_active = true
      ORDER BY c.name ASC
    `);
    res.json({ clients: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/clients/:id', async (req, res) => {
  try {
    const clientResult = await db.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    if (!clientResult.rows.length) return res.status(404).json({ error: 'Cliente não encontrado' });

    const client = clientResult.rows[0];
    const integrations = await db.query('SELECT * FROM client_integrations WHERE client_id = $1 ORDER BY slug', [req.params.id]);
    const competitors = await db.query('SELECT * FROM client_competitors WHERE client_id = $1', [req.params.id]);
    const recentAlerts = await db.query(
      'SELECT * FROM alerts WHERE client_id = $1 AND resolved = false ORDER BY created_at DESC LIMIT 5',
      [req.params.id]
    );
    const recentAnalyses = await db.query(
      'SELECT id, uuid, analysis_type, period_start, period_end, created_at FROM ai_analyses WHERE client_id = $1 ORDER BY created_at DESC LIMIT 10',
      [req.params.id]
    );

    res.json({ client, integrations: integrations.rows, competitors: competitors.rows, recentAlerts: recentAlerts.rows, recentAnalyses: recentAnalyses.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/clients', async (req, res) => {
  try {
    const { name, sector, businessType, city, state, phone, avgTicket, reporteiProjectId, responsibleUserId, ...rest } = req.body;

    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');

    // Sugerir ticket médio via IA se não informado
    let suggestedTicket = null;
    if (!avgTicket && sector) {
      try {
        const suggestion = await aiService.suggestTicket({ sector, businessType, city, state });
        suggestedTicket = suggestion.suggested_ticket;
      } catch (e) { /* ignora se falhar */ }
    }

    const result = await db.query(`
      INSERT INTO clients (name, slug, sector, business_type, city, state, phone,
        avg_ticket, avg_ticket_suggested, avg_ticket_source,
        reportei_project_id, responsible_user_id,
        political_mandate, political_party, political_next_election,
        political_base_description, political_causes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *
    `, [
      name, slug, sector, businessType, city, state, phone,
      avgTicket || suggestedTicket, suggestedTicket, avgTicket ? 'manual' : 'ai_suggested',
      reporteiProjectId, responsibleUserId,
      rest.politicalMandate, rest.politicalParty, rest.politicalNextElection,
      rest.politicalBaseDescription, rest.politicalCauses,
    ]);

    const client = result.rows[0];

    // Sincronizar integrações do Reportei automaticamente
    if (reporteiProjectId) {
      await syncClientIntegrations(client.id, reporteiProjectId);
    }

    res.json({ client });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/clients/:id', async (req, res) => {
  try {
    const { name, sector, businessType, city, state, phone, avgTicket, reporteiProjectId, responsibleUserId, ...rest } = req.body;

    const result = await db.query(`
      UPDATE clients SET name=$1, sector=$2, business_type=$3, city=$4, state=$5, phone=$6,
        avg_ticket=$7, reportei_project_id=$8, responsible_user_id=$9,
        political_mandate=$10, political_party=$11, political_next_election=$12,
        political_base_description=$13, political_causes=$14, updated_at=NOW()
      WHERE id=$15 RETURNING *
    `, [name, sector, businessType, city, state, phone, avgTicket, reporteiProjectId, responsibleUserId,
        rest.politicalMandate, rest.politicalParty, rest.politicalNextElection,
        rest.politicalBaseDescription, rest.politicalCauses, req.params.id]);

    res.json({ client: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// SINCRONIZAÇÃO COM REPORTEI
// ─────────────────────────────────────────

router.post('/clients/:id/sync-reportei', async (req, res) => {
  try {
    const clientResult = await db.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    const client = clientResult.rows[0];
    if (!client.reportei_project_id) return res.status(400).json({ error: 'Cliente sem projeto Reportei vinculado' });

    const integrations = await syncClientIntegrations(client.id, client.reportei_project_id);
    res.json({ synced: integrations.length, integrations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function syncClientIntegrations(clientId, reporteiProjectId) {
  const reporteiIntegrations = await reporteiService.listIntegrations(reporteiProjectId);
  const synced = [];

  for (const ri of reporteiIntegrations) {
    await db.query(`
      INSERT INTO client_integrations (client_id, reportei_integration_id, slug, name, status, reportei_last_sync)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (client_id, reportei_integration_id)
      DO UPDATE SET slug=$3, name=$4, status=$5, reportei_last_sync=NOW()
    `, [clientId, ri.id, ri.slug, ri.name, ri.status]);
    synced.push(ri);
  }

  await db.query('UPDATE clients SET reportei_last_sync = NOW() WHERE id = $1', [clientId]);
  return synced;
}

// ─────────────────────────────────────────
// INTEGRAÇÕES DO CLIENTE
// ─────────────────────────────────────────

router.put('/clients/:id/integrations/:integrationId', async (req, res) => {
  try {
    const { isMonitored, alertsEnabled, postFrequencyDays, minEngagementRate, maxCpl, maxCpc, minRoas } = req.body;

    await db.query(`
      UPDATE client_integrations SET
        is_monitored = $1, alerts_enabled = $2, post_frequency_days = $3,
        min_engagement_rate = $4, max_cpl = $5, max_cpc = $6, min_roas = $7,
        updated_at = NOW()
      WHERE id = $8 AND client_id = $9
    `, [isMonitored, alertsEnabled, postFrequencyDays, minEngagementRate, maxCpl, maxCpc, minRoas,
        req.params.integrationId, req.params.id]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// ANÁLISES DE IA
// ─────────────────────────────────────────

router.post('/clients/:id/analyze', async (req, res) => {
  try {
    const { analysisType, periodStart, periodEnd } = req.body;

    // Definir período padrão (último mês) se não informado
    const end = periodEnd || new Date().toISOString().split('T')[0];
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);
    const start = periodStart || startDate.toISOString().split('T')[0];

    const result = await aiService.analyzeClient({
      clientId: parseInt(req.params.id),
      analysisType: analysisType || 'full',
      periodStart: start,
      periodEnd: end,
      userId: req.session.userId,
      triggeredBy: 'manual',
    });

    res.json({ analysis: result.analysis, parsed: result.parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/clients/:id/analyses', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, uuid, analysis_type, period_start, period_end, diagnosis,
        attention_points, working_well, action_plan, projection, created_at
      FROM ai_analyses WHERE client_id = $1
      ORDER BY created_at DESC LIMIT 20
    `, [req.params.id]);
    res.json({ analyses: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/analyses/:uuid', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT a.*, c.name as client_name
      FROM ai_analyses a JOIN clients c ON c.id = a.client_id
      WHERE a.uuid = $1
    `, [req.params.uuid]);
    if (!result.rows.length) return res.status(404).json({ error: 'Análise não encontrada' });
    res.json({ analysis: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// CHAT COM IA
// ─────────────────────────────────────────

router.post('/clients/:id/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    const result = await aiService.chatWithClient({
      clientId: parseInt(req.params.id),
      userId: req.session.userId,
      message,
      sessionId,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// ALERTAS
// ─────────────────────────────────────────

router.get('/alerts', async (req, res) => {
  try {
    const { clientId, resolved, severity } = req.query;
    let query = `
      SELECT a.*, c.name as client_name, ci.slug as integration_slug
      FROM alerts a
      JOIN clients c ON c.id = a.client_id
      LEFT JOIN client_integrations ci ON ci.id = a.integration_id
      WHERE 1=1
    `;
    const params = [];
    if (clientId) { params.push(clientId); query += ` AND a.client_id = $${params.length}`; }
    if (resolved !== undefined) { params.push(resolved === 'true'); query += ` AND a.resolved = $${params.length}`; }
    if (severity) { params.push(severity); query += ` AND a.severity = $${params.length}`; }
    query += ' ORDER BY a.created_at DESC LIMIT 50';

    const result = await db.query(query, params);
    res.json({ alerts: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/alerts/:id/resolve', async (req, res) => {
  try {
    await db.query(
      'UPDATE alerts SET resolved = true, resolved_at = NOW(), resolved_by = $1 WHERE id = $2',
      [req.session.userId, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// RECOMENDAÇÕES
// ─────────────────────────────────────────

router.put('/recommendations/:id', async (req, res) => {
  try {
    const { status, outcomeNotes } = req.body;
    const updates = { status, outcome_notes: outcomeNotes };
    if (status === 'accepted') updates.accepted_at = new Date();
    if (status === 'done') updates.done_at = new Date();

    await db.query(
      'UPDATE ai_recommendations SET status=$1, outcome_notes=$2, accepted_at=$3, done_at=$4 WHERE id=$5',
      [status, outcomeNotes, updates.accepted_at || null, updates.done_at || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// SUGESTÃO DE TICKET MÉDIO
// ─────────────────────────────────────────

router.post('/suggest-ticket', async (req, res) => {
  try {
    const suggestion = await aiService.suggestTicket(req.body);
    res.json(suggestion);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// PROJETOS DO REPORTEI (para vincular ao cliente)
// ─────────────────────────────────────────

router.get('/reportei/projects', async (req, res) => {
  try {
    const data = await reporteiService.listProjects(1, 100);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// ─── PAGESPEED ───
router.post('/clients/:id/pagespeed', async (req, res) => {
  try {
    const { url } = req.body;
    const pagespeedService = require('../services/pagespeed');
    const aiService = require('../services/ai');
    const prompts = require('../prompts');
    const axios = require('axios');

    // 1. Rodar PageSpeed mobile + desktop
    const psData = await pagespeedService.analyzeBoth(url);

    // 2. Buscar contexto do cliente
    const clientResult = await db.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    const client = clientResult.rows[0];
    const intResult = await db.query('SELECT * FROM client_integrations WHERE client_id = $1 AND is_monitored = true', [req.params.id]);
    const benchResult = await db.query('SELECT * FROM sector_benchmarks WHERE sector = $1', [client.sector]);
    const clientContext = prompts.buildClientContext(client, intResult.rows, benchResult.rows);

    // 3. Analisar com IA
    const systemPrompt = prompts.pageSpeedSystemPrompt(clientContext);
    const userMessage = 'Analise os resultados do Google PageSpeed para o site ' + url + ':\n\nMOBILE:\nScores: ' + JSON.stringify(psData.mobile ? psData.mobile.scores : psData.scores, null, 2) + '\nCore Web Vitals: ' + JSON.stringify(psData.mobile ? psData.mobile.metrics : psData.metrics, null, 2) + '\n\nDESKTOP:\nScores: ' + JSON.stringify(psData.desktop ? psData.desktop.scores : {}, null, 2) + '\nOportunidades: ' + JSON.stringify((psData.mobile ? psData.mobile.opportunities : psData.opportunities || []).slice(0, 5), null, 2);

    const anthropicAxios = axios.create({
      baseURL: 'https://api.anthropic.com/v1',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      timeout: 60000,
    });

    const response = await anthropicAxios.post('/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    let aiAnalysis = null;
    try {
      const clean = response.data.content[0].text.replace(/```json\n?|\n?```/g, '').trim();
      aiAnalysis = JSON.parse(clean);
    } catch (e) { aiAnalysis = { diagnosis: response.data.content[0].text }; }

    // 4. Salvar no histórico
    const today = new Date().toISOString().split('T')[0];
    await db.query(`
      INSERT INTO ai_analyses (client_id, user_id, analysis_type, period_start, period_end, raw_data, diagnosis, attention_points, working_well, action_plan, projection, model_used, triggered_by)
      VALUES ($1,$2,'pagespeed',$3,$3,$4,$5,$6,$7,$8,$9,'claude-sonnet-4-5','manual')
    `, [req.params.id, req.session.userId, today, JSON.stringify(psData),
        aiAnalysis.diagnosis, JSON.stringify(aiAnalysis.attention_points || []),
        JSON.stringify(aiAnalysis.working_well || []), JSON.stringify(aiAnalysis.action_plan || []),
        aiAnalysis.projection]);

    res.json({ ...psData, ai_analysis: aiAnalysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CONFIGURAÇÕES — USUÁRIOS ───
router.get('/settings/users', async (req, res) => {
  try {
    const result = await db.query('SELECT id, name, email, role, user_type, is_active, client_id FROM users ORDER BY name');
    res.json({ users: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/settings/users', async (req, res) => {
  try {
    const { createUser } = require('../middlewares/auth');
    const user = await createUser(req.body);
    res.json({ user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/settings/users/:id', async (req, res) => {
  try {
    const { is_active } = req.body;
    await db.query('UPDATE users SET is_active = $1 WHERE id = $2', [is_active, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── RELATÓRIOS ───
router.get('/reports/data', async (req, res) => {
  try {
    const { clientId, start, end } = req.query;
    const clientResult = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    if (!clientResult.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado' });
    const client = clientResult.rows[0];

    const intResult = await db.query("SELECT * FROM client_integrations WHERE client_id = $1 AND is_monitored = true AND status = 'active'", [clientId]);
    const integrations = intResult.rows;
    const reporteiService = require('../services/reportei');

    const kpis = [];
    const comparison = [];
    const budgetByPlatform = {};
    const engagementByPlatform = {};
    const metricsHistory = {
      followers: { labels: [], data: [] },
      reach: { labels: [], data: [] },
      spend: { labels: [], data: [] },
      clicks: { labels: [], data: [] }
    };

    const startD = new Date(start);
    const endD = new Date(end);
    const diffDays = Math.ceil((endD - startD) / (1000*60*60*24));
    const compEnd = new Date(startD); compEnd.setDate(compEnd.getDate() - 1);
    const compStart = new Date(compEnd); compStart.setDate(compStart.getDate() - diffDays);
    const compStartStr = compStart.toISOString().split('T')[0];
    const compEndStr = compEnd.toISOString().split('T')[0];

    for (const integration of integrations) {
      try {
        const metrics = await reporteiService.getMetricsForSlug(integration.slug);
        if (!metrics.length) continue;
        const result = await reporteiService.getMetricsData({
          integrationId: integration.reportei_integration_id,
          start, end, metrics: metrics.slice(0, 6),
          comparisonStart: compStartStr, comparisonEnd: compEndStr
        });

        metrics.slice(0, 6).forEach(function(metric) {
          const val = result[metric.id];
          if (!val || val.values === undefined) return;
          const keyParts = metric.reference_key.split(':');
          const metricName = (keyParts[1] || metric.reference_key).replace(/_/g, ' ').toUpperCase();
          const platform = integration.slug.replace(/_/g, ' ');
          const trend = (val.comparison && val.comparison.difference) ? Math.round(val.comparison.difference) : 0;
          const valueFormatted = typeof val.values === 'number' ? val.values.toLocaleString('pt-BR') : String(val.values);

          kpis.push({ label: metricName + ' (' + platform + ')', value: valueFormatted, trend });

          if (val.comparison && val.comparison.values !== null && val.comparison.values !== undefined) {
            comparison.push({
              metric: metricName + ' (' + platform + ')',
              current: valueFormatted,
              previous: typeof val.comparison.values === 'number' ? val.comparison.values.toLocaleString('pt-BR') : String(val.comparison.values || 0),
              variation: val.comparison.difference ? Math.round(val.comparison.difference) : 0
            });
          }

          if (metric.reference_key.includes('spend') || metric.reference_key.includes('cost')) {
            budgetByPlatform[platform] = (budgetByPlatform[platform] || 0) + (typeof val.values === 'number' ? val.values : 0);
          }
          if (metric.reference_key.includes('engagement_rate')) {
            engagementByPlatform[platform] = typeof val.values === 'number' ? parseFloat(val.values.toFixed(2)) : 0;
          }

          if (val.trend && val.trend.data && val.trend.data.length > 0) {
            const trendLabels = val.trend.data.map(function(_, i) { return 'Dia ' + (i+1); });
            if (metric.reference_key.includes('followers') && metricsHistory.followers.data.length === 0) {
              metricsHistory.followers = { labels: trendLabels, data: val.trend.data };
            }
            if (metric.reference_key.includes('reach') && metricsHistory.reach.data.length === 0) {
              metricsHistory.reach = { labels: trendLabels, data: val.trend.data };
            }
            if ((metric.reference_key.includes('spend') || metric.reference_key.includes('cost')) && metricsHistory.spend.data.length === 0) {
              metricsHistory.spend = { labels: trendLabels, data: val.trend.data };
            }
            if (metric.reference_key.includes('clicks') && metricsHistory.clicks.data.length === 0) {
              metricsHistory.clicks = { labels: trendLabels, data: val.trend.data };
            }
          }
        });
      } catch (e) { console.error('Report data error:', integration.slug, e.message); }
    }

    res.json({
      client_name: client.name,
      kpis: kpis.slice(0, 12),
      comparison: comparison.slice(0, 10),
      budget_by_platform: budgetByPlatform,
      engagement_by_platform: engagementByPlatform,
      metrics_history: metricsHistory,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/reports/save', async (req, res) => {
  try {
    const { clientId, start, end, data } = req.body;
    const clientResult = await db.query('SELECT name FROM clients WHERE id = $1', [clientId]);
    const clientName = clientResult.rows[0]?.name || 'Cliente';
    const token = require('crypto').randomBytes(32).toString('hex');
    const result = await db.query(
      'INSERT INTO saved_reports (client_id, user_id, title, period_start, period_end, report_data, public_token) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING uuid, public_token',
      [clientId, req.session.userId, 'Relatório — ' + clientName, start, end, JSON.stringify(data), token]
    );
    res.json({ uuid: result.rows[0].uuid, token: result.rows[0].public_token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/reports/saved', async (req, res) => {
  try {
    const { clientId } = req.query;
    const where = clientId ? 'WHERE client_id = $1 ORDER BY created_at DESC LIMIT 20' : 'ORDER BY created_at DESC LIMIT 20';
    const params = clientId ? [clientId] : [];
    const result = await db.query('SELECT uuid, title, period_start, period_end, public_token, created_at FROM saved_reports ' + where, params);
    res.json({ reports: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/reports/:uuid/token', async (req, res) => {
  try {
    const result = await db.query('SELECT public_token FROM saved_reports WHERE uuid = $1', [req.params.uuid]);
    if (!result.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ token: result.rows[0].public_token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/reports/:uuid', async (req, res) => {
  try {
    await db.query('DELETE FROM saved_reports WHERE uuid = $1', [req.params.uuid]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DELETAR ANÁLISE DO HISTÓRICO ───
router.delete('/analyses/:uuid', async (req, res) => {
  try {
    const result = await db.query('SELECT id FROM ai_analyses WHERE uuid = $1', [req.params.uuid]);
    if (!result.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    await db.query('DELETE FROM ai_recommendations WHERE analysis_id = $1', [result.rows[0].id]);
    await db.query('DELETE FROM ai_analyses WHERE uuid = $1', [req.params.uuid]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ANÁLISE DE POSTAGENS ───
router.post('/clients/:id/posts-analysis', async (req, res) => {
  try {
    const { periodStart, periodEnd } = req.body;
    const axios = require('axios');
    const prompts = require('../prompts');
    const postsPrompts = require('../prompts/posts');
    const reporteiService = require('../services/reportei');

    const clientResult = await db.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    const client = clientResult.rows[0];
    const intResult = await db.query(
      "SELECT * FROM client_integrations WHERE client_id = $1 AND is_monitored = true AND status = 'active' AND slug IN ('instagram_business','facebook','tiktok','youtube','linkedin')",
      [req.params.id]
    );
    const integrations = intResult.rows;
    const benchResult = await db.query('SELECT * FROM sector_benchmarks WHERE sector = $1', [client.sector]);
    const clientContext = prompts.buildClientContext(client, integrations, benchResult.rows);

    // Coletar posts individuais por rede
    const postsData = {};
    const rawPosts = []; // posts individuais para exibir no frontend

    for (const integration of integrations) {
      try {
        const allMetrics = await reporteiService.listMetrics(integration.slug);

        // Buscar datatables de posts (dados por post individual)
        const datatableMetrics = allMetrics.filter(function(m) {
          return m.component === 'datatable_v1' && (
            m.reference_key.includes('reels') ||
            m.reference_key.includes('post') ||
            m.reference_key.includes('stories')
          );
        }).slice(0, 2);

        // Buscar métricas numéricas agregadas
        const numericMetrics = allMetrics.filter(function(m) {
          return m.component === 'number_v1' && (
            m.reference_key.includes('reels') ||
            m.reference_key.includes('engagement') ||
            m.reference_key.includes('reach') ||
            m.reference_key.includes('followers')
          );
        }).slice(0, 5);

        const allToFetch = [...datatableMetrics, ...numericMetrics];
        if (!allToFetch.length) continue;

        const result = await reporteiService.getMetricsData({
          integrationId: integration.reportei_integration_id,
          start: periodStart, end: periodEnd,
          metrics: allToFetch,
        });

        // Extrair posts individuais dos datatables
        datatableMetrics.forEach(function(metric) {
          const val = result[metric.id];
          if (val && val.values && Array.isArray(val.values)) {
            val.values.forEach(function(row) {
              if (Array.isArray(row) && row[0]) {
                const postObj = row[0]; // objeto com id, text e métricas
                rawPosts.push({
                  platform: integration.slug,
                  account: integration.name,
                  type: metric.reference_key.includes('reels') ? 'Reels' : metric.reference_key.includes('stories') ? 'Stories' : 'Post',
                  id: postObj.id || '',
                  caption: (postObj.text || '').substring(0, 200),
                  reach: row.find(function(v) { return typeof v === 'number'; }) || 0,
                  metrics: metric.metrics.reduce(function(acc, key, idx) {
                    if (row[idx + 1] !== undefined) acc[key] = row[idx + 1];
                    return acc;
                  }, {}),
                });
              }
            });
          }
        });

        // Dados agregados para IA
        const summary = {};
        numericMetrics.forEach(function(m) {
          const val = result[m.id];
          if (val && val.values !== undefined) summary[m.reference_key] = val.values;
        });
        if (Object.keys(summary).length) postsData[integration.slug] = {
          integration_name: integration.name,
          aggregated: summary,
          posts_count: rawPosts.filter(function(p) { return p.platform === integration.slug; }).length,
        };
      } catch (e) {
        console.error('Posts error:', integration.slug, e.message);
        postsData[integration.slug] = { error: e.message };
      }
    }

    // Chamar Claude para análise estratégica
    const anthropicAxios = axios.create({
      baseURL: 'https://api.anthropic.com/v1',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      timeout: 120000,
    });

    const postsSummary = rawPosts.slice(0, 20).map(function(p, i) {
      return (i+1) + '. [' + p.type + ' - ' + p.platform + '] ' + p.caption.substring(0, 100) + ' | métricas: ' + JSON.stringify(p.metrics);
    }).join('\n');

    const response = await anthropicAxios.post('/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      system: postsPrompts.postsAnalysisSystemPrompt(clientContext),
      messages: [{ role: 'user', content: 'Analise a performance de postagens do cliente ' + client.name + ' no período de ' + periodStart + ' a ' + periodEnd + '.\n\nDados agregados por rede:\n' + JSON.stringify(postsData, null, 2) + '\n\nPosts individuais (até 20 mais recentes):\n' + postsSummary }],
    });

    const aiText = response.data.content[0].text;
    let parsed;
    try {
      const clean = aiText.replace(/^```json\s*/m,'').replace(/^```\s*/m,'').replace(/```\s*$/m,'').trim();
      const m = (clean.match(/\{[\s\S]*\}/) || aiText.match(/\{[\s\S]*\}/) || [])[0];
      parsed = m ? JSON.parse(m) : { overall_diagnosis: aiText, attention_points: [], action_plan: [] };
    } catch(e) { parsed = { overall_diagnosis: aiText, attention_points: [], action_plan: [] }; }

    res.json({ parsed, raw_posts: rawPosts.slice(0, 30) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ESTRATEGISTA DE TRÁFEGO ───
router.post('/traffic/strategy', async (req, res) => {
  try {
    const { clientId, goalType, goalNumber, budget, context, platforms } = req.body;
    const reporteiService = require('../services/reportei');
    const prompts = require('../prompts');
    const axios = require('axios');

    const clientResult = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    const client = clientResult.rows[0];
    const intResult = await db.query('SELECT * FROM client_integrations WHERE client_id = $1 AND is_monitored = true AND status = $2', [clientId, 'active']);
    const benchResult = await db.query('SELECT * FROM sector_benchmarks WHERE sector = $1', [client.sector]);
    const clientContext = prompts.buildClientContext(client, intResult.rows, benchResult.rows);

    // Coletar dados históricos de tráfego pago
    const paidIntegrations = intResult.rows.filter(i => ['facebook_ads','google_adwords','tiktok_ads'].includes(i.slug));
    const historicalData = {};
    const end = new Date().toISOString().split('T')[0];
    const start = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];

    for (const integration of paidIntegrations) {
      try {
        const metrics = await reporteiService.getMetricsForSlug(integration.slug);
        if (metrics.length) {
          const data = await reporteiService.getMetricsData({ integrationId: integration.reportei_integration_id, start, end, metrics: metrics.slice(0, 8) });
          historicalData[integration.slug] = { name: integration.name, data };
        }
      } catch(e) { historicalData[integration.slug] = { error: e.message }; }
    }

    const anthropic = axios.create({
      baseURL: 'https://api.anthropic.com/v1',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      timeout: 120000,
    });

    const userMsg = `CLIENTE: ${client.name}
META: ${goalNumber} (tipo: ${goalType})
ORÇAMENTO MENSAL: R$ ${budget}
PLATAFORMAS: ${(platforms||[]).join(', ')}
CONTEXTO ADICIONAL: ${context || 'não informado'}

DADOS HISTÓRICOS DOS ÚLTIMOS 90 DIAS:
${JSON.stringify(historicalData, null, 2)}

Com base nesses dados históricos reais, construa uma estratégia COMPLETA e DETALHADA de tráfego pago. Seja extremamente específico sobre configuração de pixel, eventos de conversão, estrutura de campanhas e criativos recomendados.`;

    const response = await anthropic.post('/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 5000,
      system: prompts.paidTrafficStrategistSystemPrompt(clientContext),
      messages: [{ role: 'user', content: userMsg }],
    });

    const aiContent = response.data.content[0].text;
    let strategy;
    try {
      const match = aiContent.match(/\{[\s\S]*\}/);
      strategy = match ? JSON.parse(match[0]) : { goal_analysis: aiContent };
    } catch(e) { strategy = { goal_analysis: aiContent }; }

    res.json({ strategy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RELATÓRIOS COM HISTÓRICO ───
// Override da rota existente de dados para incluir histórico temporal

// ─── ANÁLISE DE POSTAGENS ───
router.post('/clients/:id/posts-analysis', async (req, res) => {
  try {
    const { periodStart, periodEnd } = req.body;
    const axios = require('axios');
    const prompts = require('../prompts');
    const postsPrompts = require('../prompts/posts');
    const reporteiService = require('../services/reportei');

    const clientResult = await db.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    const client = clientResult.rows[0];
    const intResult = await db.query(
      "SELECT * FROM client_integrations WHERE client_id = $1 AND is_monitored = true AND status = 'active' AND slug IN ('instagram_business','facebook','tiktok','youtube','linkedin')",
      [req.params.id]
    );
    const integrations = intResult.rows;
    const benchResult = await db.query('SELECT * FROM sector_benchmarks WHERE sector = $1', [client.sector]);
    const clientContext = prompts.buildClientContext(client, integrations, benchResult.rows);

    // Coletar métricas de posts de cada rede
    const postsData = {};
    for (const integration of integrations) {
      try {
        const allMetrics = await reporteiService.listMetrics(integration.slug);
        // Buscar métricas de posts/reels/stories (datagrid e number por post)
        const postMetrics = allMetrics.filter(function(m) {
          return m.component === 'number_v1' && (
            m.reference_key.includes('reels') ||
            m.reference_key.includes('post') ||
            m.reference_key.includes('stories') ||
            m.reference_key.includes('engagement') ||
            m.reference_key.includes('reach') ||
            m.reference_key.includes('followers')
          );
        }).slice(0, 8);

        if (!postMetrics.length) continue;
        const result = await reporteiService.getMetricsData({
          integrationId: integration.reportei_integration_id,
          start: periodStart, end: periodEnd,
          metrics: postMetrics,
        });
        postsData[integration.slug] = { integration_name: integration.name, metrics: result, metric_defs: postMetrics };
      } catch (e) {
        postsData[integration.slug] = { error: e.message };
      }
    }

    // Chamar Claude para análise
    const anthropicAxios = axios.create({
      baseURL: 'https://api.anthropic.com/v1',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      timeout: 120000,
    });

    const response = await anthropicAxios.post('/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      system: postsPrompts.postsAnalysisSystemPrompt(clientContext),
      messages: [{ role: 'user', content: 'Analise a performance de postagens do cliente ' + client.name + ' no período de ' + periodStart + ' a ' + periodEnd + '.\n\nDados das redes sociais:\n' + JSON.stringify(postsData, null, 2) }],
    });

    const aiText = response.data.content[0].text;
    let parsed;
    try {
      const clean = aiText.replace(/^```json\s*/m,'').replace(/^```\s*/m,'').replace(/```\s*$/m,'').trim();
      const m = (clean.match(/\{[\s\S]*\}/) || aiText.match(/\{[\s\S]*\}/) || [])[0];
      parsed = m ? JSON.parse(m) : { overall_diagnosis: aiText, attention_points: [], action_plan: [] };
    } catch(e) { parsed = { overall_diagnosis: aiText, attention_points: [], action_plan: [] }; }

    res.json({ parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ESTRATEGISTA DE TRÁFEGO ───
router.post('/clients/:id/traffic-strategy', async (req, res) => {
  try {
    const { goal, budget, objective, periodStart, periodEnd } = req.body;
    const axios = require('axios');
    const prompts = require('../prompts');
    const trafficPrompts = require('../prompts/traffic');
    const reporteiService = require('../services/reportei');

    const clientResult = await db.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    const client = clientResult.rows[0];
    const intResult = await db.query(
      "SELECT * FROM client_integrations WHERE client_id = $1 AND is_monitored = true AND status = 'active' AND slug IN ('facebook_ads','google_adwords','tiktok_ads')",
      [req.params.id]
    );
    const integrations = intResult.rows;
    const benchResult = await db.query('SELECT * FROM sector_benchmarks WHERE sector = $1', [client.sector]);
    const clientContext = prompts.buildClientContext(client, integrations, benchResult.rows);

    // Coletar dados de tráfego pago
    const trafficData = {};
    for (const integration of integrations) {
      try {
        const metrics = await reporteiService.getMetricsForSlug(integration.slug);
        if (!metrics.length) continue;
        const result = await reporteiService.getMetricsData({
          integrationId: integration.reportei_integration_id,
          start: periodStart, end: periodEnd,
          metrics: metrics,
        });
        trafficData[integration.slug] = { integration_name: integration.name, metrics: result };
      } catch (e) {
        trafficData[integration.slug] = { error: e.message };
      }
    }

    const anthropicAxios = axios.create({
      baseURL: 'https://api.anthropic.com/v1',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      timeout: 120000,
    });

    const userMessage = 'Crie uma estratégia completa de tráfego pago para o cliente ' + client.name + '.\n\nMETA DO CLIENTE:\n' + goal + '\n\nORÇAMENTO MENSAL: R$ ' + budget + '\nOBJETIVO: ' + objective + '\n\nDADOS HISTÓRICOS DO REPORTEI (' + periodStart + ' a ' + periodEnd + '):\n' + JSON.stringify(trafficData, null, 2) + '\n\nSeja extremamente detalhista, inclua configuração de pixel, eventos, estrutura de campanhas e projeções realistas.';

    const response = await anthropicAxios.post('/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 6000,
      system: trafficPrompts.trafficStrategistSystemPrompt(clientContext),
      messages: [{ role: 'user', content: userMessage }],
    });

    const aiText = response.data.content[0].text;
    let parsed;
    const match = aiText.match(/\{[\s\S]*\}/);
    if (match) { try { parsed = JSON.parse(match[0]); } catch(e) { parsed = { strategy_summary: aiText }; } }
    else parsed = { strategy_summary: aiText };

    res.json({ parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
