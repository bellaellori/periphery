/**
 * Editorial desk. Functional, not decorative.
 */
import { Router } from 'express';
import { db, profile, interests } from '../db/index.js';
import { requireAdmin, adminToken } from '../lib/auth.js';
import { runIngestion } from '../pipeline/ingest.js';
import { generateEdition, isLongReadDay, longReadFlavour } from '../pipeline/edition.js';
import { reassessAll } from '../pipeline/relevance.js';
import { CATEGORY_LABELS } from '../pipeline/classify.js';
import { lastRuns, stats, getArticleById, recentEditions } from '../lib/queries.js';

const router = Router();

router.post('/login', (req, res) => {
  const token = String(req.body?.token || '');
  if (adminToken() && token !== adminToken()) {
    return res.status(401).render('admin/login', { title: 'Editorial', error: 'Not that token.' });
  }
  res.setHeader('Set-Cookie',
    `periphery_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  res.redirect('/admin');
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'periphery_admin=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/');
});

router.use(requireAdmin);

router.use((req, res, next) => {
  res.locals.admin = true;
  res.locals.path = req.path;
  res.locals.categoryLabels = CATEGORY_LABELS;
  res.locals.flash = req.query.msg || null;
  next();
});

router.get('/', (req, res) => {
  const runs = lastRuns();
  res.render('admin/dashboard', {
    title: 'Editorial desk',
    stats: stats(),
    runs,
    editions: recentEditions(10),
    today: new Date().toISOString().slice(0, 10),
    isLongReadDay: isLongReadDay(new Date()),
    flavour: longReadFlavour(new Date()),
    schedulerOn: process.env.ENABLE_INTERNAL_SCHEDULER === '1',
    summariser: process.env.ANTHROPIC_API_KEY ? 'model' : 'extractive (no ANTHROPIC_API_KEY set)',
    queue: db.prepare(`
      SELECT * FROM articles WHERE status IN ('ingested','approved')
      ORDER BY relevance_score DESC, ingested_at DESC LIMIT 30`).all()
  });
});

router.get('/articles', (req, res) => {
  const { status = '', q = '', category = '' } = req.query;
  let sql = 'SELECT * FROM articles WHERE 1=1';
  const args = [];
  if (status) { sql += ' AND status = ?'; args.push(status); }
  if (category) { sql += ' AND category = ?'; args.push(category); }
  if (q) { sql += ' AND (title LIKE ? OR source_name LIKE ? OR authors LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY ingested_at DESC LIMIT 200';
  res.render('admin/articles', {
    title: 'All material',
    articles: db.prepare(sql).all(...args),
    filters: { status, q, category }
  });
});

router.get('/articles/:id', (req, res) => {
  const article = getArticleById(req.params.id);
  if (!article) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such item.' });
  res.render('admin/article-edit', {
    title: `Edit — ${article.title}`,
    article,
    excerpt: db.prepare('SELECT excerpt FROM article_excerpts WHERE article_id = ?').get(article.id)?.excerpt || '',
    editions: db.prepare(`SELECT e.* FROM edition_items ei JOIN editions e ON e.id = ei.edition_id
                          WHERE ei.article_id = ?`).all(article.id)
  });
});

const EDITABLE = ['title', 'dek', 'short_summary', 'research_summary', 'what_happened',
  'what_they_did', 'what_they_found', 'evidence_strength', 'why_interesting',
  'broader_question', 'why_it_matters', 'connection_to_research', 'selection_rationale',
  'intellectual_territory', 'concepts_raised', 'source_name', 'source_url', 'authors',
  'publication_date', 'publication_type', 'peer_review_status', 'category',
  'relevance_status', 'status', 'is_long_form'];

router.post('/articles/:id', (req, res) => {
  const fields = EDITABLE.filter(f => f in req.body);
  if (fields.length) {
    db.prepare(`UPDATE articles SET ${fields.map(f => `${f} = ?`).join(', ')},
      summary_provenance = 'human', updated_at = datetime('now') WHERE id = ?`)
      .run(...fields.map(f => (req.body[f] === '' ? null : req.body[f])), req.params.id);
  }
  if ('tags' in req.body) {
    db.prepare('DELETE FROM article_tags WHERE article_id = ?').run(req.params.id);
    for (const raw of String(req.body.tags).split(',')) {
      const name = raw.trim().toLowerCase();
      if (!name) continue;
      const slug = name.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const tag = db.prepare('SELECT id FROM tags WHERE slug = ?').get(slug)
        || db.prepare('INSERT INTO tags (name, slug, kind) VALUES (?, ?, ?) RETURNING id').get(name, slug, 'concept');
      db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)').run(req.params.id, tag.id);
    }
  }
  res.redirect(`/admin/articles/${req.params.id}?msg=Saved`);
});

router.post('/articles/:id/status/:status', (req, res) => {
  const s = ['ingested', 'approved', 'published', 'rejected'].includes(req.params.status)
    ? req.params.status : 'ingested';
  db.prepare(`UPDATE articles SET status = ?, published_at = CASE WHEN ? = 'published'
    THEN COALESCE(published_at, datetime('now')) ELSE published_at END WHERE id = ?`)
    .run(s, s, req.params.id);
  res.redirect(req.get('referer') || '/admin');
});

router.post('/articles/:id/delete', (req, res) => {
  db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
  res.redirect('/admin/articles?msg=Removed');
});

// -------------------------------------------------------------------------
// Sources
// -------------------------------------------------------------------------
router.get('/sources', (req, res) => {
  res.render('admin/sources', {
    title: 'Sources',
    sources: db.prepare('SELECT * FROM sources ORDER BY quality_tier, name').all()
  });
});

router.post('/sources', (req, res) => {
  const { name, url, kind, publisher_type, quality_tier, default_category, homepage, notes } = req.body;
  if (name && url) {
    try {
      db.prepare(`INSERT INTO sources (name, url, kind, publisher_type, quality_tier, default_category, homepage, notes)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(name.trim(), url.trim(), kind || 'rss', publisher_type || 'other',
          Number(quality_tier) || 2, default_category || null, homepage || null, notes || null);
    } catch (err) {
      return res.redirect('/admin/sources?msg=' + encodeURIComponent(err.message));
    }
  }
  res.redirect('/admin/sources?msg=Added');
});

router.post('/sources/:id/toggle', (req, res) => {
  db.prepare('UPDATE sources SET enabled = 1 - enabled WHERE id = ?').run(req.params.id);
  res.redirect('/admin/sources');
});

router.post('/sources/:id/delete', (req, res) => {
  db.prepare('DELETE FROM sources WHERE id = ?').run(req.params.id);
  res.redirect('/admin/sources?msg=Removed');
});

router.post('/sources/:id/test', async (req, res) => {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  const r = await runIngestion({ trigger: 'manual', sourceIds: [source.id] });
  res.redirect('/admin/sources?msg=' + encodeURIComponent(`${source.name}: ${r.added} new, ${r.dupes} duplicates`));
});

// -------------------------------------------------------------------------
// Runs
// -------------------------------------------------------------------------
router.get('/runs', (req, res) => {
  res.render('admin/runs', {
    title: 'Runs',
    ingestion: db.prepare('SELECT * FROM ingestion_runs ORDER BY id DESC LIMIT 40').all(),
    generation: db.prepare(`SELECT g.*, e.edition_date FROM generation_runs g
      LEFT JOIN editions e ON e.id = g.edition_id ORDER BY g.id DESC LIMIT 40`).all()
  });
});

router.post('/run/ingest', async (req, res) => {
  const r = await runIngestion({ trigger: 'manual' });
  res.redirect('/admin?msg=' + encodeURIComponent(
    `Ingestion ${r.status}: ${r.added} new, ${r.dupes} duplicates, ${r.sourcesOk}/${r.sources} sources`));
});

router.post('/run/edition', async (req, res) => {
  const kind = req.body.kind === 'long_read' ? 'long_read' : 'daily';
  try {
    const r = await generateEdition(kind, {
      trigger: 'manual',
      publish: req.body.publish !== 'draft',
      ...(req.body.window_days ? { windowDays: Number(req.body.window_days) } : {})
    });
    res.redirect('/admin?msg=' + encodeURIComponent(
      r.ok ? `${kind} edition built: ${r.selected} items` : `Not built: ${r.reason}`));
  } catch (err) {
    res.redirect('/admin?msg=' + encodeURIComponent(`Failed: ${err.message}`));
  }
});

router.post('/run/reassess', (req, res) => {
  res.redirect('/admin?msg=' + encodeURIComponent(`Re-assessed ${reassessAll()} items`));
});

router.post('/editions/:id/status', (req, res) => {
  const s = req.body.status === 'published' ? 'published' : 'draft';
  db.prepare(`UPDATE editions SET status = ?, published_at = CASE WHEN ? = 'published'
    THEN COALESCE(published_at, datetime('now')) ELSE NULL END WHERE id = ?`)
    .run(s, s, req.params.id);
  res.redirect('/admin?msg=Edition ' + s);
});

router.post('/editions/:id/delete', (req, res) => {
  db.prepare('DELETE FROM editions WHERE id = ?').run(req.params.id);
  res.redirect('/admin?msg=Edition removed');
});

// -------------------------------------------------------------------------
// Interests (the same data as /profile, in a denser form)
// -------------------------------------------------------------------------
router.get('/interests', (req, res) => {
  res.render('admin/interests', {
    title: 'Research interests',
    profile: profile(),
    interests: interests({ activeOnly: false }),
    adjacency: db.prepare('SELECT * FROM concept_adjacency ORDER BY concept, adjacent').all()
  });
});

export default router;
