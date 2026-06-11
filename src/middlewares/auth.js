const db = require('../db');
const bcrypt = require('bcryptjs');

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado' });
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Acesso negado' });
  return res.redirect('/');
}

function requireAgency(req, res, next) {
  if (req.session && req.session.userType !== 'client') return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Acesso negado' });
  return res.redirect('/client-portal');
}

// Verifica se usuário tem acesso a um cliente específico
async function canAccessClient(userId, clientId) {
  const result = await db.query('SELECT role, client_access, user_type, client_id FROM users WHERE id = $1', [userId]);
  if (!result.rows.length) return false;
  const user = result.rows[0];
  if (user.role === 'admin' || user.role === 'manager') return true;
  if (user.user_type === 'client') return user.client_id == clientId;
  const access = user.client_access || [];
  if (access.length === 0) return true; // sem restrição
  return access.includes(parseInt(clientId));
}

async function loginUser(email, password) {
  const result = await db.query('SELECT * FROM users WHERE email = $1 AND is_active = true', [email]);
  if (!result.rows.length) return null;
  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return null;
  return user;
}

async function createUser({ name, email, password, role, userType, clientAccess, clientId }) {
  const hash = await bcrypt.hash(password, 10);
  const result = await db.query(
    'INSERT INTO users (name, email, password_hash, role, user_type, client_access, client_id, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [name, email, hash, role || 'analyst', userType || 'agency',
     clientAccess ? `{${clientAccess.join(',')}}` : '{}',
     clientId || null, true]
  );
  return result.rows[0];
}

module.exports = { requireAuth, requireAdmin, requireAgency, canAccessClient, loginUser, createUser };
