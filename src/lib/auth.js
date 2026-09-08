import crypto from 'node:crypto';

function safeEqual(a = '', b = '') {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function presented(req) {
  const auth = req.headers.authorization || '';
  return [
    req.headers['x-admin-token'],
    auth.startsWith('Bearer ') ? auth.slice(7) : null,
    req.cookies?.periphery_admin,
    req.query?.token,
    req.body?.token
  ].filter(Boolean);
}

export function adminToken() {
  return process.env.ADMIN_TOKEN || '';
}

export function isAdmin(req) {
  const t = adminToken();
  if (!t) return true;                      // no token configured: local/private use
  return presented(req).some(p => safeEqual(p, t));
}

export function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  if (req.accepts('html') && !req.path.startsWith('/api')) {
    return res.status(401).render('admin/login', { title: 'Editorial', error: null, layout: false });
  }
  return res.status(401).json({ error: 'unauthorised' });
}

/**
 * Pipeline endpoints accept either the admin token or a dedicated CRON_SECRET,
 * so an external scheduler can be given a credential that cannot edit anything.
 */
export function requireAutomation(req, res, next) {
  if (isAdmin(req)) return next();
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = [req.headers['x-cron-secret'], req.query?.secret, req.body?.secret].filter(Boolean);
    if (given.some(g => safeEqual(g, secret))) return next();
  }
  return res.status(401).json({ error: 'unauthorised' });
}
