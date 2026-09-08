/**
 * JSON API.
 *
 * Reader actions (marking relevance, reading) are open — this is a personal site
 * behind an optional site password. Anything that changes the library, the
 * profile or the sources requires ADMIN_TOKEN. Pipeline triggers additionally
 * accept CRON_SECRET so a scheduler can be given a narrow credential.
 */
import { Router } from 'express';
import { db, profile, interests, migrate } from '../db/index.js';
import { runIngestion } from '../pipeline/ingest.js';
import { generateEdition, isLongReadDay } from '../pipeline/edition.js';
import { reassessAll, loadProfileModel, assess } from '../pipeline/relevance.js';
import { categorise, typify, estimateReading, isLongForm, CATEGORY_LABELS } from '../pipeline/classify.js';
import { requireAdmin, requireAutomation } from '../lib/auth.js';
import { slugify, hash, fold, truncate } from '../lib/text.js';
import {
  getArticleById, getArticleBySlug, latestEdition, editionByDate, editionItems,
  savedArticles, saveArticle, unsaveArticle, lastRuns, stats, publishedArticles
} from '../lib/queries.js';

const router = Router();
const ok = (res, data, code = 200) => res.status(code).json({ ok: true, ...data });
const fail = (res, message, code = 400) => res.status(code).json({ ok: false, error: message });

// --------------------------------------------------------------------------
// Health — for uptime checks and for confirming the last run succeeded
// --------------------------------------------------------------------------
router.get('/health', (req, res) => {
  const { ingestion, generation } = lastRuns();
  const lastIngest = ingestion[0] || null;
  const lastGen = generation[0] || null;
  const healthy = (!lastIngest || lastIngest.status !== 'failed')
    && (!lastGen || lastGen.status !== 'failed');
  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    time: new Date().toISOString(),
    stats: stats(),
    last_ingestion: lastIngest && {
      id: lastIngest.id, status: lastIngest.status, finished_at: lastIngest.finished_at,
      items_new: lastIngest.items_new, sources_ok: lastIngest.sources_ok, sources_tried: lastIngest.sources_tried
    },
    last_generation: lastGen && {
      id: lastGen.id, kind: lastGen.kind, status: lastGen.status,
      finished_at: lastGen.finished_at, selected: lastGen.selected, summariser: lastGen.summariser
    },
    long_read_day: isLongReadDay(new Date())
  });
});

// --------------------------------------------------------------------------
// Pipeline
// --------------------------------------------------------------------------
router.post('/ingest', requireAutomation, async (req, res) => {
  try {
    const r = await runIngestion({
      trigger: req.body?.trigger || 'api',
      sourceIds: req.body?.source_ids || null
    });
    ok(res, { run: r });
  } catch (err) { fail(res, err.message, 500); }
});

router.post('/editions/generate', requireAutomation, async (req, res) => {
  const kind = req.body?.kind === 'long_read' ? 'long_read' : 'daily';
  const date = req.body?.date ? new Date(req.body.date) : new Date();
  if (Number.isNaN(date.getTime())) return fail(res, 'Invalid date');
  try {
    const r = await generateEdition(kind, {
      date,
      trigger: req.body?.trigger || 'api',
      publish: req.body?.publish !== false,
      ...(req.body?.window_days ? { windowDays: Number(req.body.window_days) } : {})
    });
    ok(res, { edition: r });
  } catch (err) { fail(res, err.message, 500); }
});

/** One call an external scheduler can make daily: does whatever today needs. */
router.post('/pipeline/run', requireAutomation, async (req, res) => {
  const out = { ingestion: null, editions: [] };
  try {
    if (req.body?.ingest !== false) {
      out.ingestion = await runIngestion({ trigger: 'cron' });
    }
    const kinds = req.body?.kinds
      || ['daily', ...(isLongReadDay(new Date()) ? ['long_read'] : [])];
    for (const kind of kinds) {
      out.editions.push(await generateEdition(kind, { trigger: 'cron' }));
    }
    ok(res, out);
  } catch (err) { fail(res, err.message, 500); }
});

router.get('/runs', requireAdmin, (req, res) => ok(res, lastRuns()));

// --------------------------------------------------------------------------
// Editions & articles (read)
// --------------------------------------------------------------------------
router.get('/editions/:kind/latest', (req, res) => {
  const e = latestEdition(req.params.kind === 'long_read' ? 'long_read' : 'daily');
  if (!e) return fail(res, 'No edition yet', 404);
  ok(res, { edition: e, items: editionItems(e.id) });
});

router.get('/editions/:kind/:date', (req, res) => {
  const e = editionByDate(req.params.kind, req.params.date);
  if (!e) return fail(res, 'No such edition', 404);
  ok(res, { edition: e, items: editionItems(e.id) });
});

router.get('/articles', (req, res) => {
  const { status, category, limit = 50, offset = 0, q = '' } = req.query;
  let sql = 'SELECT * FROM articles WHERE 1=1';
  const args = [];
  if (status) { sql += ' AND status = ?'; args.push(status); }
  if (category) { sql += ' AND category = ?'; args.push(category); }
  if (q) { sql += ' AND (title LIKE ? OR authors LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY ingested_at DESC LIMIT ? OFFSET ?';
  args.push(Math.min(Number(limit) || 50, 200), Number(offset) || 0);
  ok(res, { articles: db.prepare(sql).all(...args) });
});

router.get('/articles/:slug', (req, res) => {
  const a = getArticleBySlug(req.params.slug) || getArticleById(req.params.slug);
  if (!a) return fail(res, 'Not found', 404);
  ok(res, { article: a });
});

// --------------------------------------------------------------------------
// Articles (write) — for the admin view and for external ingestion
// --------------------------------------------------------------------------
const EDITABLE = [
  'title', 'dek', 'short_summary', 'research_summary', 'what_happened', 'what_they_did',
  'what_they_found', 'evidence_strength', 'why_interesting', 'broader_question',
  'why_it_matters', 'connection_to_research', 'selection_rationale', 'intellectual_territory',
  'concepts_raised', 'source_name', 'source_url', 'authors', 'publication_date',
  'publication_type', 'peer_review_status', 'category', 'reading_time_min',
  'relevance_status', 'status', 'is_long_form', 'open_access'
];

/** Add a piece by hand or from an external ingester. Requires a real source URL. */
router.post('/articles', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.source_url || !b.source_name) {
    return fail(res, 'title, source_name and source_url are required');
  }
  const item = {
    title: String(b.title),
    abstract: b.abstract || b.short_summary || '',
    authors: b.authors || null,
    publication_date: b.publication_date || null,
    publication_type: b.publication_type || 'article',
    peer_review_status: b.peer_review_status || 'unknown',
    canonical_id: b.canonical_id || null,
    url: String(b.source_url),
    word_estimate: b.word_estimate || null
  };
  const category = b.category || categorise(item, null);
  const t = typify(item, null);
  const est = estimateReading(item, t.publication_type);
  const rel = assess({ ...item, category }, loadProfileModel(), { sourceName: b.source_name });
  const h = hash('canon', (item.canonical_id || fold(item.title)));

  try {
    const row = db.prepare(`
      INSERT INTO articles (slug, title, short_summary, source_name, source_url, canonical_id,
        authors, publication_date, publication_type, peer_review_status, category,
        reading_time_min, word_estimate, relevance_status, relevance_score, relevance_rationale,
        is_periphery_pick, periphery_bridge, status, is_long_form, content_hash)
      VALUES (@slug, @title, @short_summary, @source_name, @source_url, @canonical_id,
        @authors, @publication_date, @publication_type, @peer_review_status, @category,
        @reading_time_min, @word_estimate, @relevance_status, @relevance_score, @relevance_rationale,
        @is_periphery_pick, @periphery_bridge, @status, @is_long_form, @content_hash)
      RETURNING *`).get({
      slug: slugify(item.title) + '-' + h.slice(0, 6),
      title: item.title,
      short_summary: truncate(item.abstract, 300) || null,
      source_name: b.source_name,
      source_url: item.url,
      canonical_id: item.canonical_id,
      authors: item.authors,
      publication_date: item.publication_date,
      publication_type: t.publication_type,
      peer_review_status: t.peer_review_status,
      category,
      reading_time_min: est.reading_time_min,
      word_estimate: est.word_estimate,
      relevance_status: rel.relevance_status,
      relevance_score: rel.relevance_score,
      relevance_rationale: rel.relevance_rationale,
      is_periphery_pick: rel.is_periphery_pick,
      periphery_bridge: rel.periphery_bridge,
      status: b.status || 'ingested',
      is_long_form: isLongForm({ publication_type: t.publication_type, word_estimate: est.word_estimate }) ? 1 : 0,
      content_hash: h
    });
    if (item.abstract) {
      db.prepare('INSERT OR REPLACE INTO article_excerpts (article_id, excerpt) VALUES (?, ?)')
        .run(row.id, item.abstract);
    }
    ok(res, { article: row }, 201);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return fail(res, 'Duplicate of an item already held', 409);
    fail(res, err.message, 500);
  }
});

router.patch('/articles/:id', requireAdmin, (req, res) => {
  const a = getArticleById(req.params.id);
  if (!a) return fail(res, 'Not found', 404);
  const fields = Object.keys(req.body || {}).filter(k => EDITABLE.includes(k));
  if (!fields.length) return fail(res, 'No editable fields supplied');
  db.prepare(`UPDATE articles SET ${fields.map(f => `${f} = ?`).join(', ')},
    updated_at = datetime('now'), summary_provenance = CASE WHEN summary_provenance = 'model'
      THEN 'human' ELSE summary_provenance END WHERE id = ?`)
    .run(...fields.map(f => req.body[f]), a.id);
  ok(res, { article: getArticleById(a.id) });
});

router.delete('/articles/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
  ok(res, { deleted: Number(req.params.id) });
});

// --------------------------------------------------------------------------
// Relevance
// --------------------------------------------------------------------------
router.post('/articles/:id/relevant', (req, res) => {
  const a = getArticleById(req.params.id) || getArticleBySlug(req.params.id);
  if (!a) return fail(res, 'Not found', 404);
  saveArticle(a.id, { note: req.body?.note || null, project: req.body?.project || null });
  ok(res, { saved: true, article_id: a.id });
});

router.delete('/articles/:id/relevant', (req, res) => {
  const a = getArticleById(req.params.id) || getArticleBySlug(req.params.id);
  if (!a) return fail(res, 'Not found', 404);
  unsaveArticle(a.id);
  ok(res, { saved: false, article_id: a.id });
});

router.get('/research', (req, res) => {
  ok(res, { saved: savedArticles(req.query) });
});

// Tag a saved piece by hand.
router.post('/articles/:id/tags', requireAdmin, (req, res) => {
  const a = getArticleById(req.params.id);
  if (!a) return fail(res, 'Not found', 404);
  const names = (req.body?.tags || []).map(String);
  for (const raw of names) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    const slug = slugify(name);
    const tag = db.prepare('SELECT id FROM tags WHERE slug = ?').get(slug)
      || db.prepare('INSERT INTO tags (name, slug, kind) VALUES (?, ?, ?) RETURNING id').get(name, slug, 'concept');
    db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)').run(a.id, tag.id);
  }
  ok(res, { article: getArticleById(a.id) });
});

router.delete('/articles/:id/tags/:slug', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM article_tags WHERE article_id = ?
              AND tag_id = (SELECT id FROM tags WHERE slug = ?)`)
    .run(req.params.id, req.params.slug);
  ok(res, { removed: req.params.slug });
});

// --------------------------------------------------------------------------
// Research interests
// --------------------------------------------------------------------------
router.get('/interests', (req, res) => ok(res, {
  profile: profile(),
  interests: interests({ activeOnly: false }),
  adjacency: db.prepare('SELECT * FROM concept_adjacency ORDER BY concept').all()
}));

router.post('/interests', requireAdmin, (req, res) => {
  const { kind, value, weight = 1, notes = null, expires_on = null } = req.body || {};
  const kinds = ['topic', 'concept', 'field', 'author', 'source', 'avoid', 'project'];
  if (!kinds.includes(kind) || !value) return fail(res, `kind must be one of ${kinds.join(', ')} and value is required`);
  const row = db.prepare(`INSERT INTO research_interests (kind, value, weight, notes, expires_on)
    VALUES (?, ?, ?, ?, ?) RETURNING *`).get(kind, String(value).trim(), Number(weight) || 1, notes, expires_on);
  const n = reassessAll();
  ok(res, { interest: row, reassessed: n }, 201);
});

router.patch('/interests/:id', requireAdmin, (req, res) => {
  const allowed = ['value', 'weight', 'notes', 'active', 'expires_on'];
  const fields = Object.keys(req.body || {}).filter(k => allowed.includes(k));
  if (!fields.length) return fail(res, 'No editable fields supplied');
  db.prepare(`UPDATE research_interests SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`)
    .run(...fields.map(f => req.body[f]), req.params.id);
  ok(res, { reassessed: reassessAll() });
});

router.delete('/interests/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM research_interests WHERE id = ?').run(req.params.id);
  ok(res, { reassessed: reassessAll() });
});

router.patch('/profile', requireAdmin, (req, res) => {
  const allowed = ['display_name', 'statement', 'periphery_appetite', 'daily_size', 'longread_size'];
  const fields = Object.keys(req.body || {}).filter(k => allowed.includes(k));
  if (!fields.length) return fail(res, 'No editable fields supplied');
  db.prepare(`UPDATE research_profile SET ${fields.map(f => `${f} = ?`).join(', ')},
    updated_at = datetime('now') WHERE id = 1`).run(...fields.map(f => req.body[f]));
  ok(res, { profile: profile(), reassessed: reassessAll() });
});

router.post('/reassess', requireAdmin, (req, res) => ok(res, { reassessed: reassessAll() }));

// --------------------------------------------------------------------------
// Sources
// --------------------------------------------------------------------------
router.get('/sources', (req, res) => ok(res, { sources: db.prepare('SELECT * FROM sources ORDER BY quality_tier, name').all() }));

router.post('/sources', requireAdmin, (req, res) => {
  const { name, url, kind = 'rss', homepage = null, publisher_type = 'other',
    quality_tier = 2, default_category = null, notes = null } = req.body || {};
  if (!name || !url) return fail(res, 'name and url are required');
  try {
    const row = db.prepare(`INSERT INTO sources (name, url, kind, homepage, publisher_type,
      quality_tier, default_category, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(name, url, kind, homepage, publisher_type, Number(quality_tier) || 2, default_category, notes);
    ok(res, { source: row }, 201);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return fail(res, 'That source URL is already configured', 409);
    fail(res, err.message, 500);
  }
});

router.patch('/sources/:id', requireAdmin, (req, res) => {
  const allowed = ['name', 'url', 'kind', 'homepage', 'publisher_type', 'quality_tier',
    'default_category', 'enabled', 'fetch_interval_h', 'notes'];
  const fields = Object.keys(req.body || {}).filter(k => allowed.includes(k));
  if (!fields.length) return fail(res, 'No editable fields supplied');
  db.prepare(`UPDATE sources SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`)
    .run(...fields.map(f => req.body[f]), req.params.id);
  ok(res, { source: db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id) });
});

router.delete('/sources/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM sources WHERE id = ?').run(req.params.id);
  ok(res, { deleted: Number(req.params.id) });
});

router.get('/categories', (req, res) => ok(res, { categories: CATEGORY_LABELS }));

router.post('/migrate', requireAdmin, (req, res) => ok(res, { database: migrate() }));

export default router;
