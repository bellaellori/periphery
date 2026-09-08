import { Router } from 'express';
import { db, profile, interests } from '../db/index.js';
import { CATEGORY_LABELS } from '../pipeline/classify.js';
import { isLongReadDay, longReadFlavour, longReadLabel } from '../pipeline/edition.js';
import { reassessAll } from '../pipeline/relevance.js';
import {
  latestEdition, editionByDate, editionItems, recentEditions, adjacentEditions,
  getArticleBySlug, publishedArticles, peripheryPicks, savedArticles, savedConceptMap,
  savedCategoryCounts, articlesForConcept, saveArticle, unsaveArticle, stats
} from '../lib/queries.js';

const router = Router();

// Values every page needs.
router.use((req, res, next) => {
  res.locals.nav = [
    { href: '/', label: 'Front page' },
    { href: '/daily', label: 'The Daily Observatory' },
    { href: '/long-read', label: 'The Long Read' },
    { href: '/research', label: 'My Research' },
    { href: '/archive', label: 'Archive' }
  ];
  res.locals.path = req.path;
  res.locals.profileName = profile()?.display_name || null;
  res.locals.savedCount = stats().saved;
  res.locals.demoCount = stats().demo;
  res.locals.categoryLabels = CATEGORY_LABELS;
  next();
});

// --------------------------------------------------------------------------
// FRONT PAGE
// --------------------------------------------------------------------------
router.get('/', (req, res) => {
  const daily = latestEdition('daily');
  const dailyItems = daily ? editionItems(daily.id) : [];
  const longRead = latestEdition('long_read');
  const longReadItems = longRead ? editionItems(longRead.id).slice(0, 3) : [];

  const usedIds = [...dailyItems, ...longReadItems].map(a => a.id);
  const periphery = peripheryPicks(4, usedIds);
  const more = publishedArticles({ limit: 6, excludeIds: [...usedIds, ...periphery.map(a => a.id)] });

  res.render('front', {
    title: 'PERIPHERY',
    daily, dailyItems, longRead, longReadItems, periphery, more,
    lead: dailyItems.find(i => i.slot === 'lead') || dailyItems[0] || null,
    isLongReadDay: isLongReadDay(new Date()),
    editions: recentEditions(8)
  });
});

// --------------------------------------------------------------------------
// EDITIONS
// --------------------------------------------------------------------------
function renderEdition(kind, view) {
  return (req, res) => {
    const edition = req.params.date ? editionByDate(kind, req.params.date) : latestEdition(kind);
    if (!edition) {
      return res.status(404).render('empty-edition', {
        title: kind === 'daily' ? 'The Daily Observatory' : 'The Long Read',
        kind,
        isLongReadDay: isLongReadDay(new Date())
      });
    }
    const items = editionItems(edition.id);
    res.render(view, {
      title: `${edition.title} — ${edition.edition_date}`,
      edition,
      items,
      lead: items.find(i => i.slot === 'lead') || items[0],
      flavour: kind === 'long_read' ? longReadFlavour(new Date(edition.edition_date)) : null,
      flavourLabel: kind === 'long_read' ? longReadLabel(new Date(edition.edition_date)) : null,
      neighbours: adjacentEditions(kind, edition.edition_date)
    });
  };
}

router.get('/daily', renderEdition('daily', 'daily'));
router.get('/daily/:date', renderEdition('daily', 'daily'));
router.get('/long-read', renderEdition('long_read', 'long-read'));
router.get('/long-read/:date', renderEdition('long_read', 'long-read'));

router.get('/archive', (req, res) => {
  res.render('archive', {
    title: 'Archive',
    editions: recentEditions(200),
    recent: publishedArticles({ limit: 40 })
  });
});

// --------------------------------------------------------------------------
// ARTICLE
// --------------------------------------------------------------------------
router.get('/article/:slug', (req, res) => {
  const article = getArticleBySlug(req.params.slug);
  if (!article) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such piece.' });
  }
  const inEdition = db.prepare(`
    SELECT e.* FROM edition_items ei JOIN editions e ON e.id = ei.edition_id
    WHERE ei.article_id = ? ORDER BY e.edition_date DESC LIMIT 1`).get(article.id);

  const related = db.prepare(`
    SELECT DISTINCT a.id, a.slug, a.title, a.category, a.source_name, a.reading_time_min
    FROM articles a
    JOIN article_tags at ON at.article_id = a.id
    WHERE a.status = 'published' AND a.id != ?
      AND at.tag_id IN (SELECT tag_id FROM article_tags WHERE article_id = ?)
    LIMIT 5`).all(article.id, article.id);

  res.render('article', {
    title: article.title,
    article,
    inEdition,
    related,
    backTo: req.get('referer') || null
  });
});

// --------------------------------------------------------------------------
// RELEVANCE — the one interaction on every article
// --------------------------------------------------------------------------
router.post('/article/:slug/relevant', (req, res) => {
  const article = getArticleBySlug(req.params.slug);
  if (!article) return res.status(404).send('Not found');
  if (article.is_saved) unsaveArticle(article.id);
  else saveArticle(article.id, { note: req.body?.note || null, project: req.body?.project || null });
  res.redirect(req.body?.return_to || `/article/${article.slug}`);
});

// --------------------------------------------------------------------------
// MY RESEARCH
// --------------------------------------------------------------------------
router.get('/research', (req, res) => {
  const { q = '', category = '', concept = '', sort = 'saved_desc', view = 'concepts' } = req.query;
  const items = savedArticles({ q, category, concept, sort });
  const conceptMap = savedConceptMap();

  // Group by concept for the literature-map view; untagged material keeps its own group.
  const groups = [];
  if (view === 'concepts') {
    const used = new Set();
    for (const c of conceptMap) {
      const inGroup = items.filter(a => a.tags.some(t => t.slug === c.slug));
      if (!inGroup.length) continue;
      inGroup.forEach(a => used.add(a.id));
      groups.push({ key: c.slug, label: c.name, items: inGroup });
    }
    const rest = items.filter(a => !used.has(a.id));
    if (rest.length) groups.push({ key: '', label: 'Not yet mapped', items: rest });
  }

  res.render('research', {
    title: 'My Research',
    items, groups, view,
    conceptMap,
    categories: savedCategoryCounts(),
    filters: { q, category, concept, sort }
  });
});

router.get('/concept/:slug', (req, res) => {
  const tag = db.prepare('SELECT * FROM tags WHERE slug = ?').get(req.params.slug);
  if (!tag) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such concept.' });
  res.render('concept', {
    title: tag.name,
    tag,
    items: articlesForConcept(tag.slug)
  });
});

router.get('/category/:key', (req, res) => {
  const key = req.params.key;
  if (!CATEGORY_LABELS[key]) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such section.' });
  }
  res.render('category', {
    title: CATEGORY_LABELS[key],
    key,
    label: CATEGORY_LABELS[key],
    items: publishedArticles({ category: key, limit: 60 })
  });
});

// --------------------------------------------------------------------------
// RESEARCH PROFILE
// --------------------------------------------------------------------------
const INTEREST_KINDS = [
  { kind: 'topic', label: 'Current research topics', hint: 'What you are actually working on now.' },
  { kind: 'concept', label: 'Recurring concepts', hint: 'The ideas that keep coming back, whatever the field.' },
  { kind: 'field', label: 'Fields of interest', hint: 'Disciplines worth watching.' },
  { kind: 'author', label: 'Researchers to follow', hint: 'Matched against author lists.' },
  { kind: 'source', label: 'Sources to weight up', hint: 'Journals and publications you trust most.' },
  { kind: 'project', label: 'Temporary projects', hint: 'Given an end date, they stop steering the selection.' },
  { kind: 'avoid', label: 'Topics to avoid', hint: 'A veto, not a penalty: anything matching is excluded.' }
];

router.get('/profile', (req, res) => {
  res.render('profile', {
    title: 'Research profile',
    profile: profile(),
    kinds: INTEREST_KINDS,
    interests: interests({ activeOnly: false }),
    adjacency: db.prepare('SELECT * FROM concept_adjacency ORDER BY concept, adjacent').all(),
    saved: req.query.saved === '1',
    reassessed: req.query.reassessed || null
  });
});

router.post('/profile', (req, res) => {
  const { display_name = '', statement = '', periphery_appetite, daily_size, longread_size } = req.body;
  db.prepare(`
    UPDATE research_profile SET display_name = ?, statement = ?, periphery_appetite = ?,
      daily_size = ?, longread_size = ?, updated_at = datetime('now') WHERE id = 1`)
    .run(
      display_name.trim() || null,
      statement.trim(),
      Math.min(0.9, Math.max(0, Number(periphery_appetite) || 0.35)),
      Math.min(20, Math.max(3, Number(daily_size) || 7)),
      Math.min(12, Math.max(1, Number(longread_size) || 4))
    );
  const n = reassessAll();
  res.redirect(`/profile?saved=1&reassessed=${n}`);
});

router.post('/profile/interests', (req, res) => {
  const { kind, value, weight = 1, notes = '', expires_on = '' } = req.body;
  if (kind && value?.trim()) {
    db.prepare(`INSERT INTO research_interests (kind, value, weight, notes, expires_on)
                VALUES (?, ?, ?, ?, ?)`)
      .run(kind, value.trim(), Number(weight) || 1, notes.trim() || null, expires_on || null);
    reassessAll();
  }
  res.redirect('/profile#' + (kind || ''));
});

router.post('/profile/interests/:id/delete', (req, res) => {
  db.prepare('DELETE FROM research_interests WHERE id = ?').run(req.params.id);
  reassessAll();
  res.redirect('/profile');
});

router.post('/profile/interests/:id/toggle', (req, res) => {
  db.prepare('UPDATE research_interests SET active = 1 - active WHERE id = ?').run(req.params.id);
  reassessAll();
  res.redirect('/profile');
});

router.post('/profile/adjacency', (req, res) => {
  const { concept, adjacent, field = '', strength = 0.6 } = req.body;
  if (concept?.trim() && adjacent?.trim()) {
    db.prepare(`INSERT OR REPLACE INTO concept_adjacency (concept, adjacent, field, strength)
                VALUES (?, ?, ?, ?)`)
      .run(concept.trim(), adjacent.trim(), field.trim() || null, Number(strength) || 0.6);
    reassessAll();
  }
  res.redirect('/profile#adjacency');
});

router.post('/profile/adjacency/:id/delete', (req, res) => {
  db.prepare('DELETE FROM concept_adjacency WHERE id = ?').run(req.params.id);
  reassessAll();
  res.redirect('/profile#adjacency');
});

router.get('/about', (req, res) => {
  res.render('about', { title: 'About PERIPHERY', stats: stats() });
});

// Demo articles carry no external URL. This explains why rather than 404ing.
router.get('/demo-source', (req, res) => {
  res.render('demo-source', { title: 'Demo content' });
});

export default router;
