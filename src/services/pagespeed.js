const axios = require('axios');
require('dotenv').config();

const PAGESPEED_API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function analyzeUrl(url, strategy) {
  strategy = strategy || 'mobile';
  var params = {
    url: url,
    strategy: strategy,
    category: ['performance', 'accessibility', 'best-practices', 'seo']
  };
  if (process.env.PAGESPEED_API_KEY) params.key = process.env.PAGESPEED_API_KEY;

  var { data } = await axios.get(PAGESPEED_API, { params: params, timeout: 60000 });
  return extractData(data, strategy);
}

async function analyzeBoth(url) {
  // Rodar mobile primeiro
  var mobile = await analyzeUrl(url, 'mobile');
  // Aguardar 2 segundos para evitar rate limit
  await sleep(2000);
  // Rodar desktop
  var desktop = await analyzeUrl(url, 'desktop');
  return { mobile: mobile, desktop: desktop };
}

function extractData(data, strategy) {
  var cats = (data.lighthouseResult && data.lighthouseResult.categories) || {};
  var audits = (data.lighthouseResult && data.lighthouseResult.audits) || {};

  var scores = {
    performance: Math.round(((cats.performance && cats.performance.score) || 0) * 100),
    accessibility: Math.round(((cats.accessibility && cats.accessibility.score) || 0) * 100),
    best_practices: Math.round(((cats['best-practices'] && cats['best-practices'].score) || 0) * 100),
    seo: Math.round(((cats.seo && cats.seo.score) || 0) * 100),
  };

  var metrics = {};
  var metricKeys = {
    'first-contentful-paint': 'FCP',
    'largest-contentful-paint': 'LCP',
    'total-blocking-time': 'TBT',
    'cumulative-layout-shift': 'CLS',
    'speed-index': 'Speed Index',
    'interactive': 'TTI',
  };

  Object.keys(metricKeys).forEach(function(key) {
    if (audits[key] && audits[key].displayValue) {
      metrics[metricKeys[key]] = audits[key].displayValue;
    }
  });

  var opportunities = [];
  Object.values(audits).forEach(function(audit) {
    if (audit.details && audit.details.type === 'opportunity' && audit.score !== null && audit.score < 0.9) {
      opportunities.push({
        title: audit.title,
        description: audit.description,
        score: audit.score,
        savings: (audit.details && audit.details.overallSavingsMs) ? Math.round(audit.details.overallSavingsMs) + 'ms' : null,
      });
    }
  });
  opportunities.sort(function(a, b) { return a.score - b.score; });

  return { scores: scores, metrics: metrics, opportunities: opportunities.slice(0, 8), strategy: strategy };
}

module.exports = { analyzeUrl: analyzeUrl, analyzeBoth: analyzeBoth };
