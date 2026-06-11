require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const cron = require('node-cron');
const ejsLayouts = require('express-ejs-layouts');
const { pool } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

app.use(session({
  store: new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'huby-secret-dev',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(ejsLayouts);
app.set('layout', 'partials/layout');

app.use((req, res, next) => {
  res.locals.user = req.session?.userId ? { id: req.session.userId, name: req.session.userName, role: req.session.role } : null;
  res.locals.appName = process.env.APP_NAME || 'Huby';
  next();
});

app.use('/', require('./routes/auth'));
app.use('/api', require('./routes/api'));
app.use('/', require('./routes/pages'));

if (process.env.NODE_ENV === 'production') {
  const alertsService = require('./services/alerts');
  const reportsService = require('./services/reports');

  cron.schedule('0 * * * *', async () => {
    await alertsService.checkAllAlerts().catch(console.error);
  });
  cron.schedule('0 12 * * *', async () => {
    await alertsService.checkNoPostAlerts().catch(console.error);
  });
  cron.schedule('0 11 * * 1', async () => {
    await reportsService.generateWeeklyReports().catch(console.error);
  });
  cron.schedule('0 11 1 * *', async () => {
    await reportsService.generateMonthlyReports().catch(console.error);
  });
}

app.use((err, req, res, next) => {
  console.error(err.stack);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Erro interno do servidor' });
  }
  res.status(500).render('pages/error', { message: err.message, layout: false });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Huby rodando na porta ${PORT}`);
  console.log(`   Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   URL: ${process.env.APP_URL || `http://localhost:${PORT}`}\n`);
});

module.exports = app;
