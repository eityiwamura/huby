const express = require('express');
const router = express.Router();
const { loginUser } = require('../middlewares/auth');

router.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  res.render('pages/login', { error: null, appName: process.env.APP_NAME || 'Huby' });
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await loginUser(email, password);
    if (!user) {
      return res.render('pages/login', { error: 'Email ou senha incorretos', appName: process.env.APP_NAME || 'Huby' });
    }
    req.session.userId = user.id;
    req.session.userName = user.name;
    req.session.role = user.role;
    res.redirect('/');
  } catch (err) {
    res.render('pages/login', { error: 'Erro interno. Tente novamente.', appName: process.env.APP_NAME || 'Huby' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

module.exports = router;
