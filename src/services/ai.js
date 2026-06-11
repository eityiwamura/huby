const axios = require('axios');
const db = require('../db');
const prompts = require('../prompts');
const reporteiService = require('./reportei');
require('dotenv').config();

const anthropic = axios.create({
  baseURL: 'https://api.anthropic.com/v1',
  headers: {
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  },
  timeout: 120000,
});

function parseAIJson(text) {
  try {
    var clean = text
      .replace(/^```json\s*/m, '')
      .replace(/^```\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();
    return JSON.parse(clean);
  } catch(e) {
    // Tentar extrair JSON do texto
    var match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch(e2) {}
    }
    return { diagnosis: text, attention_points: [], working_well: [], action_plan: [], projection: '' };
  }
}

async function analyzeClient({ clientId, analysisType, periodStart, periodEnd, userId, triggeredBy }) {
  triggeredBy = triggeredBy || 'manual';
  var startTime = Date.now();

  var clientResult = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
  if (!clientResult.rows.length) throw new Error('Cliente não encontrado');
  var client = clientResult.rows[0];

  var intResult = await db.query(
    'SELECT * FROM client_integrations WHERE client_id = $1 AND is_monitored = true AND status = $2',
    [clientId, 'active']
  );
  var integrations = intResult.rows;

  var benchResult = await db.query('SELECT * FROM sector_benchmarks WHERE sector = $1', [client.sector]);
  var benchmarks = benchResult.rows;

  var clientContext = prompts.buildClientContext(client, integrations, benchmarks);

  var end = periodEnd;
  var start = periodStart;
  var startD = new Date(start);
  var endD = new Date(end);
  var diffDays = Math.ceil((endD - startD) / (1000 * 60 * 60 * 24));
  var compStart = new Date(startD);
  compStart.setDate(compStart.getDate() - diffDays);
  var compEnd = new Date(startD);
  compEnd.setDate(compEnd.getDate() - 1);
  var comparisonStart = compStart.toISOString().split('T')[0];
  var comparisonEnd = compEnd.toISOString().split('T')[0];

  var rawData = await collectDataByType({ analysisType, integrations, periodStart: start, periodEnd: end, comparisonStart, comparisonEnd });

  var systemPrompt = selectSystemPrompt(analysisType, clientContext, client);
  var userMessage = buildAnalysisMessage(analysisType, rawData, start, end, client);

  var response = await anthropic.post('/messages', {
    model: 'claude-sonnet-4-5',
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  var aiContent = response.data.content[0].text;
  var tokensUsed = (response.data.usage && (response.data.usage.input_tokens + response.data.usage.output_tokens)) || 0;
  var generationTime = Date.now() - startTime;

  var parsed = parseAIJson(aiContent);

  var analysisInsert = await db.query(
    'INSERT INTO ai_analyses (client_id, user_id, analysis_type, period_start, period_end, comparison_start, comparison_end, raw_data, diagnosis, attention_points, working_well, action_plan, projection, model_used, tokens_used, generation_time_ms, triggered_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, uuid',
    [clientId, userId || null, analysisType, start, end, comparisonStart, comparisonEnd,
     JSON.stringify(rawData), parsed.diagnosis,
     JSON.stringify(parsed.attention_points || []),
     JSON.stringify(parsed.working_well || []),
     JSON.stringify(parsed.action_plan || []),
     parsed.projection, 'claude-sonnet-4-5', tokensUsed, generationTime, triggeredBy]
  );

  var analysis = analysisInsert.rows[0];

  if (parsed.action_plan && parsed.action_plan.length) {
    for (var i = 0; i < parsed.action_plan.length; i++) {
      var action = parsed.action_plan[i];
      await db.query(
        'INSERT INTO ai_recommendations (analysis_id, client_id, priority, action, reason, expected_impact) VALUES ($1,$2,$3,$4,$5,$6)',
        [analysis.id, clientId, action.priority, action.action, action.reason, action.expected_impact]
      );
    }
  }

  return { analysis: analysis, parsed: parsed, rawData: rawData };
}

async function collectDataByType({ analysisType, integrations, periodStart, periodEnd, comparisonStart, comparisonEnd }) {
  var data = {};
  var slugsForType = {
    paid_traffic: ['facebook_ads', 'google_adwords', 'tiktok_ads', 'linkedin_ads'],
    organic: ['instagram_business', 'facebook', 'tiktok', 'linkedin', 'youtube', 'threads'],
    seo_gmb: ['search_console', 'google_analytics_4', 'google_my_business'],
    political: ['instagram_business', 'facebook', 'facebook_ads', 'tiktok'],
    cross_channel: null,
    full: null,
  };

  var relevantSlugs = slugsForType[analysisType];
  var filtered = relevantSlugs
    ? integrations.filter(function(i) { return relevantSlugs.indexOf(i.slug) !== -1; })
    : integrations;

  for (var j = 0; j < filtered.length; j++) {
    var integration = filtered[j];
    try {
      var metrics = await reporteiService.getMetricsForSlug(integration.slug);
      if (!metrics || !metrics.length) continue;

      var result = await reporteiService.getMetricsData({
        integrationId: integration.reportei_integration_id,
        start: periodStart,
        end: periodEnd,
        metrics: metrics,
        comparisonStart: comparisonStart,
        comparisonEnd: comparisonEnd,
      });

      data[integration.slug] = {
        integration_name: integration.name,
        metrics: result,
      };
    } catch(err) {
      console.error('Erro ao coletar dados de ' + integration.slug + ':', err.message);
      data[integration.slug] = { error: err.message };
    }
  }
  return data;
}

function selectSystemPrompt(analysisType, clientContext, client) {
  if (client.sector === 'politico') return prompts.politicalSystemPrompt(clientContext);
  switch (analysisType) {
    case 'paid_traffic': return prompts.paidTrafficSystemPrompt(clientContext);
    case 'organic':      return prompts.organicSocialSystemPrompt(clientContext);
    case 'seo_gmb':      return prompts.seoGmbSystemPrompt(clientContext);
    case 'cross_channel':
    case 'full':         return prompts.crossChannelSystemPrompt(clientContext);
    default:             return prompts.paidTrafficSystemPrompt(clientContext);
  }
}

function buildAnalysisMessage(analysisType, rawData, periodStart, periodEnd, client) {
  var typeLabels = {
    paid_traffic: 'tráfego pago',
    organic: 'redes sociais orgânicas',
    seo_gmb: 'SEO e Google Meu Negócio',
    cross_channel: 'visão integrada de canais',
    full: 'análise completa',
    political: 'comunicação política digital',
  };
  var dataStr = JSON.stringify(rawData, null, 2);
  return 'Analise os dados de ' + (typeLabels[analysisType] || analysisType) + ' do cliente ' + client.name + ' para o período de ' + periodStart + ' a ' + periodEnd + '.\n\nDados coletados do Reportei:\n' + dataStr + '\n\nRealize uma análise completa seguindo o formato JSON especificado. Seja específico com os números reais e compare com benchmarks do setor.';
}

async function chatWithClient({ clientId, userId, message, sessionId }) {
  var chatId;
  if (sessionId) {
    var chatResult = await db.query('SELECT id FROM ai_chats WHERE session_id = $1', [sessionId]);
    if (chatResult.rows.length) chatId = chatResult.rows[0].id;
  }
  if (!chatId) {
    var newChat = await db.query('INSERT INTO ai_chats (client_id, user_id) VALUES ($1,$2) RETURNING id, session_id', [clientId, userId]);
    chatId = newChat.rows[0].id;
    sessionId = newChat.rows[0].session_id;
  }

  var historyResult = await db.query('SELECT role, content FROM ai_chat_messages WHERE chat_id = $1 ORDER BY created_at ASC LIMIT 20', [chatId]);
  var history = historyResult.rows;

  await db.query('INSERT INTO ai_chat_messages (chat_id, role, content) VALUES ($1,$2,$3)', [chatId, 'user', message]);

  var clientResult = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
  var client = clientResult.rows[0];
  var intResult = await db.query('SELECT * FROM client_integrations WHERE client_id = $1 AND is_monitored = true AND status = $2', [clientId, 'active']);
  var benchResult = await db.query('SELECT * FROM sector_benchmarks WHERE sector = $1', [client.sector]);
  var clientContext = prompts.buildClientContext(client, intResult.rows, benchResult.rows);

  // Buscar dados reais do Reportei dos últimos 30 dias para enriquecer o contexto do chat
  var recentData = {};
  var end = new Date().toISOString().split('T')[0];
  var start = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  for (var j = 0; j < intResult.rows.length; j++) {
    var integration = intResult.rows[j];
    try {
      var metrics = await reporteiService.getMetricsForSlug(integration.slug);
      if (metrics.length) {
        var result = await reporteiService.getMetricsData({ integrationId: integration.reportei_integration_id, start: start, end: end, metrics: metrics.slice(0, 5) });
        var summary = {};
        Object.keys(result).forEach(function(id) {
          var val = result[id];
          var metric = metrics.find(function(m) { return m.id === id; });
          if (metric && val.values !== undefined) {
            summary[metric.reference_key] = { value: val.values, trend: val.comparison && val.comparison.difference ? val.comparison.difference : null };
          }
        });
        recentData[integration.slug] = { name: integration.name, period: start + ' a ' + end, metrics: summary };
      }
    } catch(e) { recentData[integration.slug] = { error: e.message }; }
  }

  var messages = history.map(function(h) { return { role: h.role, content: h.content }; });
  messages.push({ role: 'user', content: message });

  // Buscar dados reais do Reportei para enriquecer o chat
  var recentDataStr = '';
  try {
    var chatEnd = new Date().toISOString().split('T')[0];
    var chatStartD2 = new Date(); chatStartD2.setDate(chatStartD2.getDate() - 30);
    var chatStart2 = chatStartD2.toISOString().split('T')[0];
    var recentData2 = {};
    for (var ci2 = 0; ci2 < Math.min(intResult.rows.length, 4); ci2++) {
      var chatInt2 = intResult.rows[ci2];
      try {
        var cm = await reporteiService.getMetricsForSlug(chatInt2.slug);
        if (cm.length) {
          var cr2 = await reporteiService.getMetricsData({ integrationId: chatInt2.reportei_integration_id, start: chatStart2, end: chatEnd, metrics: cm.slice(0, 4) });
          var s2 = {};
          cm.slice(0, 4).forEach(function(m) { if (cr2[m.id] && cr2[m.id].values !== undefined) s2[m.reference_key] = cr2[m.id].values; });
          if (Object.keys(s2).length) recentData2[chatInt2.slug] = s2;
        }
      } catch(e2) {}
    }
    if (Object.keys(recentData2).length) recentDataStr = '\n\nDADOS REAIS DO REPORTEI (ultimos 30 dias - use para responder com numeros reais):\n' + JSON.stringify(recentData2, null, 2);
  } catch(e3) {}

  var response = await anthropic.post('/messages', {
    model: 'claude-sonnet-4-5',
    max_tokens: 2000,
    system: prompts.chatSystemPrompt(clientContext) + recentDataStr,
    messages: messages,
  });

  var aiResponse = response.data.content[0].text;
  var tokensUsed = (response.data.usage && (response.data.usage.input_tokens + response.data.usage.output_tokens)) || 0;

  await db.query('INSERT INTO ai_chat_messages (chat_id, role, content, tokens_used) VALUES ($1,$2,$3,$4)', [chatId, 'assistant', aiResponse, tokensUsed]);

  return { response: aiResponse, sessionId: sessionId, chatId: chatId };
}

async function suggestTicket({ sector, businessType, city, state }) {
  var response = await anthropic.post('/messages', {
    model: 'claude-sonnet-4-5',
    max_tokens: 500,
    system: prompts.ticketSuggestionSystemPrompt(),
    messages: [{ role: 'user', content: 'Setor: ' + sector + '\nTipo de negócio: ' + (businessType || 'não informado') + '\nCidade: ' + (city || 'não informada') + ' / ' + (state || '') }],
  });
  return parseAIJson(response.data.content[0].text);
}

async function diagnoseAlert({ clientId, alertType, metricValue, metricThreshold, metricUnit }) {
  var clientResult = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
  var client = clientResult.rows[0];
  var intResult = await db.query('SELECT * FROM client_integrations WHERE client_id = $1 AND is_monitored = true', [clientId]);
  var benchResult = await db.query('SELECT * FROM sector_benchmarks WHERE sector = $1', [client.sector]);
  var clientContext = prompts.buildClientContext(client, intResult.rows, benchResult.rows);

  var response = await anthropic.post('/messages', {
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: prompts.alertDiagnosisSystemPrompt(clientContext),
    messages: [{ role: 'user', content: 'Alerta: ' + alertType + '\nValor atual: ' + metricValue + ' ' + (metricUnit || '') + '\nThreshold: ' + metricThreshold + ' ' + (metricUnit || '') }],
  });
  return parseAIJson(response.data.content[0].text);
}

module.exports = { analyzeClient, chatWithClient, suggestTicket, diagnoseAlert };
