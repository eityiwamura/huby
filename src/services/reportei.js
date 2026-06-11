const axios = require('axios');
require('dotenv').config();

const reportei = axios.create({
  baseURL: process.env.REPORTEI_BASE_URL || 'https://app.reportei.com/api/v2',
  headers: {
    Authorization: `Bearer ${process.env.REPORTEI_TOKEN}`,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

// Cache de métricas por slug para evitar múltiplas chamadas
const metricsCache = {};

// ─────────────────────────────────────────
// PROJETOS
// ─────────────────────────────────────────
async function listProjects(page = 1, perPage = 100) {
  const { data } = await reportei.get('/projects', { params: { page, per_page: perPage } });
  return data;
}

async function getProject(projectId) {
  const { data } = await reportei.get(`/projects/${projectId}`);
  return data.project;
}

// ─────────────────────────────────────────
// INTEGRAÇÕES
// ─────────────────────────────────────────
async function listIntegrations(projectId = null, slug = null) {
  const params = { per_page: 100 };
  if (projectId) params.project_id = projectId;
  if (slug) params.slug = slug;
  const { data } = await reportei.get('/integrations', { params });
  return data.data || [];
}

// ─────────────────────────────────────────
// MÉTRICAS — busca dinâmica com cache
// ─────────────────────────────────────────

// Métricas prioritárias por slug — apenas reference_keys que sabemos que funcionam
const PRIORITY_METRICS = {
  instagram_business: [
    'ig:followers_count',
    'ig:new_followers_count',
    'ig:current_followers_count',
    'ig:reels_count',
    'ig:reels_views',
    'ig:reels_interactions',
    'ig:reels_engagement_rate',
    'ig:stories_views',
    'ig:stories_impressions',
    'ig:post_interaction_rate',
  ],
  facebook_ads: [
    'fb_ads:spend',
    'fb_ads:impressions',
    'fb_ads:clicks',
    'fb_ads:reach',
    'fb_ads:cpc',
    'fb_ads:cpm',
    'fb_ads:ctr',
    'fb_ads:frequency',
    'fb_ads:results',
    'fb_ads:cost_per_result',
  ],
  google_adwords: [
    'gads:cost',
    'gads:clicks',
    'gads:impressions',
    'gads:ctr',
    'gads:cpc',
    'gads:conversions',
    'gads:cost_per_conversion',
  ],
  google_analytics_4: [
    'ga4:sessions',
    'ga4:users',
    'ga4:new_users',
    'ga4:bounce_rate',
    'ga4:pageviews',
  ],
  search_console: [
    'gsc:clicks',
    'gsc:impressions',
    'gsc:ctr',
    'gsc:position',
  ],
  google_my_business: [
    'gmb:views_search',
    'gmb:views_maps',
    'gmb:actions_phone',
    'gmb:actions_driving_directions',
    'gmb:actions_website',
  ],
  facebook: [
    'fb:page_fans',
    'fb:page_impressions',
    'fb:page_reach',
    'fb:page_engaged_users',
    'fb:page_posts_impressions',
  ],
  tiktok: [
    'tt:followers',
    'tt:video_views',
    'tt:likes',
    'tt:comments',
    'tt:shares',
  ],
  tiktok_ads: [
    'ttads:spend',
    'ttads:impressions',
    'ttads:clicks',
    'ttads:cpc',
    'ttads:conversions',
  ],
  youtube: [
    'yt:views',
    'yt:subscribers_gained',
    'yt:watch_time',
    'yt:average_view_duration',
  ],
};

async function listMetrics(integrationSlug) {
  // Usar cache se disponível
  if (metricsCache[integrationSlug]) return metricsCache[integrationSlug];

  const { data } = await reportei.get('/metrics', {
    params: { integration_slug: integrationSlug, per_page: 100 },
  });
  const metrics = data.data || [];
  metricsCache[integrationSlug] = metrics;
  return metrics;
}

async function getMetricsForSlug(slug) {
  // Busca todas as métricas disponíveis para o slug
  const allMetrics = await listMetrics(slug);
  if (!allMetrics.length) return [];

  // Filtrar apenas métricas prioritárias se definidas
  const priorityKeys = PRIORITY_METRICS[slug];
  if (priorityKeys) {
    const filtered = allMetrics.filter(m =>
      priorityKeys.includes(m.reference_key) &&
      m.component === 'number_v1' // apenas métricas numéricas simples
    );
    // Retornar no máximo 8 métricas para evitar rate limit
    return filtered.slice(0, 8);
  }

  // Sem prioridade definida: pegar as primeiras 5 métricas number_v1
  return allMetrics.filter(m => m.component === 'number_v1').slice(0, 5);
}

// ─────────────────────────────────────────
// BUSCAR DADOS DE MÉTRICAS
// Usa os IDs e estrutura exatos retornados pela API do Reportei
// ─────────────────────────────────────────
async function getMetricsData({ integrationId, start, end, metrics, comparisonStart, comparisonEnd }) {
  if (!metrics || metrics.length === 0) return {};

  // Usar a estrutura exata que veio da API (com id, reference_key, metrics, dimensions, etc.)
  const payload = {
    start,
    end,
    integration_id: integrationId,
    metrics: metrics.map(m => ({
      id: m.id,
      reference_key: m.reference_key,
      component: m.component,
      metrics: m.metrics,
      dimensions: m.dimensions || [],
      filters: m.filters || [],
      filter: m.filter || null,
      sort: m.sort || [],
      chart_type: m.chart_type || null,
      custom: m.custom || [],
      type: m.type || [],
    })),
  };

  if (comparisonStart && comparisonEnd) {
    payload.comparison_start = comparisonStart;
    payload.comparison_end = comparisonEnd;
  }

  const { data } = await reportei.post('/metrics/get-data', payload);
  return data.data || {};
}

// ─────────────────────────────────────────
// RELATÓRIOS
// ─────────────────────────────────────────
async function createReport({ projectId, title, subtitle, start, end, templateId, integrationIds }) {
  const { data } = await reportei.post('/reports', {
    project_id: projectId,
    title,
    subtitle: subtitle || '',
    start,
    end,
    template_id: templateId,
    integration_ids: integrationIds,
  });
  return data;
}

async function listReports(projectId, page = 1) {
  const { data } = await reportei.get('/reports', { params: { project_id: projectId, page, per_page: 20 } });
  return data;
}

async function listTemplates() {
  const { data } = await reportei.get('/templates', { params: { per_page: 100 } });
  return data.data || [];
}

module.exports = {
  listProjects,
  getProject,
  listIntegrations,
  listMetrics,
  getMetricsData,
  getMetricsForSlug,
  createReport,
  listReports,
  listTemplates,
  PRIORITY_METRICS,
};

// ─────────────────────────────────────────
// MÉTRICAS DE POSTS INDIVIDUAIS
// ─────────────────────────────────────────
const POST_METRICS = {
  instagram_business: [
    { reference_key: 'ig:posts_datagrid', component: 'datagrid_v1', metrics: ['reach','likes','comments','shares','saves','total_interactions','engagement_rate'], dimensions: ['media'], filters: [], filter: null, sort: ['-reach'], chart_type: null, custom: [], type: [] },
    { reference_key: 'ig:reels_count', component: 'number_v1', metrics: ['count'], dimensions: ['media','reels'], filters: [], filter: null, sort: [], chart_type: null, custom: [], type: [] },
  ],
  facebook: [
    { reference_key: 'fb:posts_datagrid', component: 'datagrid_v1', metrics: ['reach','likes','comments','shares','total_interactions'], dimensions: ['post'], filters: [], filter: null, sort: ['-reach'], chart_type: null, custom: [], type: [] },
  ],
  tiktok: [
    { reference_key: 'tt:videos_datagrid', component: 'datagrid_v1', metrics: ['video_views','likes','comments','shares'], dimensions: ['video'], filters: [], filter: null, sort: ['-video_views'], chart_type: null, custom: [], type: [] },
  ],
};

async function getPostsMetrics(integrationId, slug, start, end) {
  const baseMetrics = POST_METRICS[slug];
  if (!baseMetrics) {
    // Fallback: tentar buscar métricas de posts da API
    const allMetrics = await listMetrics(slug);
    const postMetrics = allMetrics.filter(m =>
      (m.reference_key.includes('post') || m.reference_key.includes('reel') || m.reference_key.includes('video')) &&
      m.component === 'datagrid_v1'
    ).slice(0, 3);
    if (!postMetrics.length) return {};
    return await getMetricsData({ integrationId, start, end, metrics: postMetrics });
  }

  const metricsWithId = baseMetrics.map(m => ({ ...m, id: uuidv4() }));
  return await getMetricsData({ integrationId, start, end, metrics: metricsWithId });
}

// ─────────────────────────────────────────
// HISTÓRICO MENSAL (para gráficos temporais)
// ─────────────────────────────────────────
async function getMonthlyHistory(integrationId, slug, monthsBack) {
  monthsBack = monthsBack || 12;
  const history = [];
  const now = new Date();

  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const start = d.toISOString().split('T')[0];
    const endD = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const end = endD.toISOString().split('T')[0];

    try {
      const metrics = await getMetricsForSlug(slug);
      if (!metrics.length) continue;
      const data = await getMetricsData({ integrationId, start, end, metrics: metrics.slice(0, 4) });
      history.push({ month: start.substring(0, 7), start, end, data });
    } catch (e) {
      history.push({ month: start.substring(0, 7), start, end, data: {}, error: e.message });
    }

    // Delay para evitar rate limit
    if (i > 0) await new Promise(r => setTimeout(r, 300));
  }

  return history;
}

module.exports.getPostsMetrics = getPostsMetrics;
module.exports.getMonthlyHistory = getMonthlyHistory;
