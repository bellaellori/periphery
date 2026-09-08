import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, DB_FILE } from './db/index.js';
import siteRoutes from './routes/site.js';
import apiRoutes from './routes/api.js';
import adminRoutes from './routes/admin.js';
import { startInternalScheduler } from './scheduler.js';
import { fmt } from './lib/format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

migrate();

export const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.locals.fmt = fmt;
app.locals.siteTitle = 'PERIPHERY';
app.locals.siteSubtitle = 'Science · Ideas · The World';

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookies);
app.use('/static', express.static(path.join(__dirname, '..', 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0
}));

function cookies(req, _res, next) {
  req.cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map(c => {
      const i = c.indexOf('=');
      return i === -1 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
    }).filter(([k]) => k)
  );
  next();
}

// Optional whole-site password, for when the site is on a public host.
app.use((req, res, next) => {
  const pw = process.env.SITE_PASSWORD;
  if (!pw) return next();
  if (req.path.startsWith('/static') || req.path === '/unlock' || req.path === '/api/health') return next();
  if (req.cookies.periphery_site === pw) return next();
  if (req.headers['x-site-password'] === pw) return next();
  if (req.method === 'POST' && req.path === '/unlock') return next();
  return res.status(401).render('unlock', { title: 'PERIPHERY', error: null });
});

app.post('/unlock', (req, res) => {
  if (req.body.password === process.env.SITE_PASSWORD) {
    res.setHeader('Set-Cookie',
      `periphery_site=${encodeURIComponent(req.body.password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    return res.redirect('/');
  }
  res.status(401).render('unlock', { title: 'PERIPHERY', error: 'Not that.' });
});

app.use('/api', apiRoutes);
app.use('/admin', adminRoutes);
app.use('/', siteRoutes);

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Not found',
    code: 404,
    message: 'That page is not in this edition.'
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).render('error', {
    title: 'Error',
    code: 500,
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong.' : err.message
  });
});

const PORT = Number(process.env.PORT || 3000);

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PERIPHERY listening on http://localhost:${PORT}`);
    console.log(`database: ${DB_FILE}`);
    startInternalScheduler();
  });
}

export default app;
