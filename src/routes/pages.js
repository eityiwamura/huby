const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middlewares/auth');
const bcrypt = require('bcryptjs');

// Login
router.get('/login', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect(req.session.userType === 'client' ? '/client-portal' : '/');
  }
  res.render('pages/login', { error: null, layout: false });
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await db.query('SELECT * FROM users WHERE email = $1 AND is_active = true', [email]);
    if (!result.rows.length) return res.render('pages/login', { error: 'Email ou senha incorretos', layout: false });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.render('pages/login', { error: 'Email ou senha incorretos', layout: false });
    req.session.userId = user.id;
    req.session.userName = user.name;
    req.session.role = user.role;
    req.session.userType = user.user_type || 'agency';
    req.session.clientId = user.client_id;
    if (user.user_type === 'client') return res.redirect('/client-portal');
    res.redirect('/');
  } catch (err) {
    res.render('pages/login', { error: 'Erro interno.', layout: false });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Middleware de auth para todas as rotas abaixo
router.use(requireAuth);

// Portal do cliente
router.get('/client-portal', async (req, res) => {
  if (req.session.userType !== 'client') return res.redirect('/');
  const result = await db.query('SELECT * FROM clients WHERE id = $1', [req.session.clientId]);
  if (!result.rows.length) return res.redirect('/login');
  res.render('pages/client-portal', { client: result.rows[0], layout: false });
});

// Dashboard
router.get('/', async (req, res) => {
  if (req.session.userType === 'client') return res.redirect('/client-portal');
  try {
    const clients = await db.query(`
      SELECT c.id, c.name, c.sector, c.city,
        (SELECT COUNT(*) FROM client_integrations ci WHERE ci.client_id = c.id AND ci.is_monitored = true) as active_integrations,
        (SELECT COUNT(*) FROM alerts a WHERE a.client_id = c.id AND a.resolved = false AND a.severity = 'critical') as critical_alerts,
        (SELECT COUNT(*) FROM alerts a WHERE a.client_id = c.id AND a.resolved = false) as pending_alerts
      FROM clients c WHERE c.is_active = true ORDER BY c.name
    `);
    const stats = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM clients WHERE is_active = true) as total_clients,
        (SELECT COUNT(*) FROM alerts WHERE resolved = false AND severity = 'critical') as critical_alerts,
        (SELECT COUNT(*) FROM alerts WHERE resolved = false) as total_alerts,
        (SELECT COUNT(*) FROM ai_analyses WHERE created_at > NOW() - INTERVAL '7 days') as analyses_this_week
    `);
    res.render('pages/dashboard', { clients: clients.rows, stats: stats.rows[0] });
  } catch (err) {
    res.status(500).render('pages/error', { message: err.message, layout: false });
  }
});

// Clientes
router.get('/clients', async (req, res) => {
  try {
    const clients = await db.query(`
      SELECT c.id, c.name, c.sector, c.city, c.state,
        (SELECT COUNT(*) FROM client_integrations ci WHERE ci.client_id = c.id AND ci.is_monitored = true) as active_integrations,
        (SELECT COUNT(*) FROM alerts a WHERE a.client_id = c.id AND a.resolved = false) as pending_alerts
      FROM clients c WHERE c.is_active = true ORDER BY c.name
    `);
    res.render('pages/clients', { clients: clients.rows });
  } catch (err) {
    res.status(500).render('pages/error', { message: err.message, layout: false });
  }
});

router.get('/clients/new', (req, res) => {
  res.render('pages/client-new', { error: null });
});

router.post('/clients', async (req, res) => {
  try {
    const { name, sector, business_type, website_url, city, state, phone, avg_ticket, reportei_project_id, political_mandate, political_party, political_next_election, political_causes, political_base_description } = req.body;
    if (!name || !sector) return res.render('pages/client-new', { error: 'Nome e setor são obrigatórios' });
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    let suggestedTicket = null;
    if (!avg_ticket && sector) {
      try {
        const aiService = require('../services/ai');
        const suggestion = await aiService.suggestTicket({ sector, businessType: business_type, city, state });
        suggestedTicket = suggestion.suggested_ticket;
      } catch (e) {}
    }
    const result = await db.query(`
      INSERT INTO clients (name, slug, sector, business_type, website_url, city, state, phone, avg_ticket, avg_ticket_suggested, avg_ticket_source, reportei_project_id, political_mandate, political_party, political_next_election, political_causes, political_base_description)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id
    `, [name, slug, sector, business_type||null, website_url||null, city||null, state||null, phone||null,
        avg_ticket||suggestedTicket, suggestedTicket, avg_ticket?'manual':'ai_suggested',
        reportei_project_id||null, political_mandate||null, political_party||null,
        political_next_election||null, political_causes||null, political_base_description||null]);
    const clientId = result.rows[0].id;
    if (reportei_project_id) {
      try {
        const reporteiService = require('../services/reportei');
        const integrations = await reporteiService.listIntegrations(reportei_project_id);
        for (const ri of integrations) {
          await db.query(`INSERT INTO client_integrations (client_id, reportei_integration_id, slug, name, status, reportei_last_sync) VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (client_id, reportei_integration_id) DO UPDATE SET slug=$3, name=$4, status=$5, reportei_last_sync=NOW()`,
            [clientId, ri.id, ri.slug, ri.name, ri.status||'active']);
        }
      } catch (e) { console.error('Sync Reportei:', e.message); }
    }
    res.redirect('/clients/' + clientId);
  } catch (err) {
    res.render('pages/client-new', { error: err.message });
  }
});

router.get('/clients/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).render('pages/error', { message: 'Cliente não encontrado', layout: false });
    res.render('pages/client-detail', { client: result.rows[0] });
  } catch (err) {
    res.status(500).render('pages/error', { message: err.message, layout: false });
  }
});

router.get('/clients/:id/edit', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).render('pages/error', { message: 'Cliente não encontrado', layout: false });
    res.render('pages/client-edit', { client: result.rows[0], error: null });
  } catch (err) {
    res.status(500).render('pages/error', { message: err.message, layout: false });
  }
});

router.post('/clients/:id/edit', async (req, res) => {
  try {
    const { name, sector, business_type, website_url, city, state, phone, avg_ticket, reportei_project_id, political_mandate, political_party, political_next_election, political_causes, political_base_description } = req.body;
    await db.query(`UPDATE clients SET name=$1, sector=$2, business_type=$3, website_url=$4, city=$5, state=$6, phone=$7, avg_ticket=$8, reportei_project_id=$9, political_mandate=$10, political_party=$11, political_next_election=$12, political_causes=$13, political_base_description=$14, updated_at=NOW() WHERE id=$15`,
      [name, sector, business_type||null, website_url||null, city||null, state||null, phone||null,
       avg_ticket||null, reportei_project_id||null, political_mandate||null, political_party||null,
       political_next_election||null, political_causes||null, political_base_description||null, req.params.id]);
    res.redirect('/clients/' + req.params.id);
  } catch (err) {
    const result = await db.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    res.render('pages/client-edit', { client: result.rows[0], error: err.message });
  }
});

router.post('/clients/:id/delete', requireAdmin, async (req, res) => {
  await db.query('UPDATE clients SET is_active = false WHERE id = $1', [req.params.id]);
  res.redirect('/clients');
});

// Alertas
router.get('/alerts', (req, res) => {
  res.render('pages/alerts');
});

// Postagens
router.get('/posts', async (req, res) => {
  const clients = await db.query('SELECT id, name FROM clients WHERE is_active = true ORDER BY name');
  res.render('pages/posts', { clients: clients.rows });
});

// Estrategista de Tráfego
router.get('/traffic-strategist', async (req, res) => {
  const clients = await db.query('SELECT id, name FROM clients WHERE is_active = true ORDER BY name');
  res.render('pages/traffic-strategist', { clients: clients.rows });
});

// Relatórios
router.get('/reports', async (req, res) => {
  const clients = await db.query('SELECT id, name FROM clients WHERE is_active = true ORDER BY name');
  res.render('pages/reports', { clients: clients.rows });
});

router.get('/reports/pdf/:uuid', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM saved_reports WHERE uuid = $1', [req.params.uuid]);
    if (!result.rows.length) return res.status(404).send('Relatório não encontrado');
    const report = result.rows[0];
    const analysisResult = await db.query('SELECT * FROM ai_analyses WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1', [report.client_id]);
    const analysis = analysisResult.rows[0] || null;
    if (analysis) {
      analysis.action_plan = typeof analysis.action_plan === 'string' ? JSON.parse(analysis.action_plan) : analysis.action_plan;
    }
    res.render('pages/report-pdf', { report, analysis, layout: false });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.get('/reports/public/:token', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM saved_reports WHERE public_token = $1', [req.params.token]);
    if (!result.rows.length) return res.status(404).send('Relatório não encontrado');
    const report = result.rows[0];
    const analysisResult = await db.query('SELECT * FROM ai_analyses WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1', [report.client_id]);
    const analysis = analysisResult.rows[0] || null;
    if (analysis) {
      analysis.action_plan = typeof analysis.action_plan === 'string' ? JSON.parse(analysis.action_plan) : analysis.action_plan;
    }
    res.render('pages/report-pdf', { report, analysis, layout: false });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Configurações
router.get('/settings', requireAdmin, async (req, res) => {
  try {
    const agencyResult = await db.query('SELECT * FROM agency_settings LIMIT 1');
    const agency = agencyResult.rows[0] || {};
    res.render('pages/settings', { agency, successMsg: req.query.success ? 'Salvo com sucesso!' : null });
  } catch (err) {
    res.status(500).render('pages/error', { message: err.message, layout: false });
  }
});

router.post('/settings/agency', requireAdmin, async (req, res) => {
  const { agency_name, logo_url, primary_color } = req.body;
  await db.query('UPDATE agency_settings SET agency_name=$1, logo_url=$2, primary_color=$3, updated_at=NOW()', [agency_name, logo_url||null, primary_color||'#5b6ef5']);
  res.redirect('/settings?success=1');
});

router.post('/settings/apis', requireAdmin, async (req, res) => {
  const { reportei_token, evolution_api_url, evolution_api_key, evolution_instance, anthropic_api_key } = req.body;
  const updates = ['updated_at=NOW()', 'evolution_api_url=$1', 'evolution_instance=$2'];
  const values = [evolution_api_url||null, evolution_instance||null];
  if (reportei_token && reportei_token !== '••••••••') { updates.push('reportei_token=$' + (values.length+1)); values.push(reportei_token); }
  if (evolution_api_key && evolution_api_key !== '••••••••') { updates.push('evolution_api_key=$' + (values.length+1)); values.push(evolution_api_key); }
  if (anthropic_api_key && anthropic_api_key !== '••••••••') { updates.push('anthropic_api_key=$' + (values.length+1)); values.push(anthropic_api_key); }
  await db.query('UPDATE agency_settings SET ' + updates.join(', '), values);
  res.redirect('/settings?success=1');
});

module.exports = router;
