import { db } from '../db/index.js';
import { CATEGORY_LABELS } from '../pipeline/classify.js';

export const RELEVANCE_LABELS = {
  core: 'Core', adjacent: 'Adjacent', periphery: 'Periphery',
  background: 'Background', unassessed: 'Unassessed'
};

export const REVIEW_LABELS = {
  peer_reviewed: 'Peer reviewed',
  preprint: 'Preprint · not peer reviewed',
  not_applicable: 'Editorial',
  unknown: 'Review status unknown'
};

export const TYPE_LABELS = {
  paper: 'Paper', preprint: 'Preprint', review: 'Review', essay: 'Essay',
  report: 'Report', investigation: 'Investigation', book_chapter: 'Book chapter',
  article: 'Article'
};

const ARTICLE_COLUMNS = `
  a.*,
  (SELECT 1 FROM saved_articles s WHERE s.article_id = a.id) AS is_saved,
  (SELECT group_concat(t.name, '|') FROM article_tags at JOIN tags t ON t.id = at.tag_id
     WHERE at.article_id = a.id) AS tag_names,
  (SELECT group_concat(t.slug, '|') FROM article_tags at JOIN tags t ON t.id = at.tag_id
     WHERE at.article_id = a.id) AS tag_slugs`;

function hydrate(row) {
  if (!row) return row;
  const names = row.tag_names ? row.tag_names.split('|') : [];
  const slugs = row.tag_slugs ? row.tag_slugs.split('|') : [];
  return {
    ...row,
    is_saved: !!row.is_saved,
    tags: names.map((name, i) => ({ name, slug: slugs[i] || '' })),
    category_label: CATEGORY_LABELS[row.category] || row.category,
    review_label: REVIEW_LABELS[row.peer_review_status] || row.peer_review_status,
    type_label: TYPE_LABELS[row.publication_type] || row.publication_type,
    relevance_label: RELEVANCE_LABELS[row.relevance_status] || row.relevance_status
  };
}

export function getArticleBySlug(slug) {
  return hydrate(db.prepare(`SELECT ${ARTICLE_COLUMNS} FROM articles a WHERE a.slug = ?`).get(slug));
}

export function getArticleById(id) {
  return hydrate(db.prepare(`SELECT ${ARTICLE_COLUMNS} FROM articles a WHERE a.id = ?`).get(id));
}

export function latestEdition(kind) {
  return db.prepare(
    `SELECT * FROM editions WHERE kind = ? AND status = 'published'
     ORDER BY edition_date DESC LIMIT 1`).get(kind);
}

export function editionByDate(kind, date) {
  return db.prepare('SELECT * FROM editions WHERE kind = ? AND edition_date = ?').get(kind, date);
}

export function editionItems(editionId) {
  return db.prepare(`
    SELECT ${ARTICLE_COLUMNS}, ei.slot, ei.position, ei.note
    FROM edition_items ei JOIN articles a ON a.id = ei.article_id
    WHERE ei.edition_id = ?
    ORDER BY ei.position`).all(editionId).map(hydrate);
}

export function recentEditions(limit = 24) {
  return db.prepare(`
    SELECT e.*, (SELECT count(*) FROM edition_items ei WHERE ei.edition_id = e.id) AS n
    FROM editions e WHERE e.status = 'published'
    ORDER BY e.edition_date DESC, e.kind LIMIT ?`).all(limit);
}

export function adjacentEditions(kind, date) {
  return {
    prev: db.prepare(`SELECT edition_date FROM editions WHERE kind = ? AND status='published' AND edition_date < ? ORDER BY edition_date DESC LIMIT 1`).get(kind, date),
    next: db.prepare(`SELECT edition_date FROM editions WHERE kind = ? AND status='published' AND edition_date > ? ORDER BY edition_date ASC LIMIT 1`).get(kind, date)
  };
}

/** Everything published, for the archive and category pages. */
export function publishedArticles({ category = null, limit = 60, offset = 0, excludeIds = [] } = {}) {
  let sql = `SELECT ${ARTICLE_COLUMNS} FROM articles a WHERE a.status = 'published'`;
  const args = [];
  if (category) { sql += ' AND a.category = ?'; args.push(category); }
  if (excludeIds.length) sql += ` AND a.id NOT IN (${excludeIds.map(() => '?').join(',')})`;
  args.push(...excludeIds);
  sql += ' ORDER BY a.published_at DESC, a.id DESC LIMIT ? OFFSET ?';
  args.push(limit, offset);
  return db.prepare(sql).all(...args).map(hydrate);
}

export function peripheryPicks(limit = 5, excludeIds = []) {
  let sql = `SELECT ${ARTICLE_COLUMNS} FROM articles a
             WHERE a.status = 'published' AND a.is_periphery_pick = 1`;
  const args = [];
  if (excludeIds.length) { sql += ` AND a.id NOT IN (${excludeIds.map(() => '?').join(',')})`; args.push(...excludeIds); }
  sql += ' ORDER BY a.published_at DESC LIMIT ?';
  args.push(limit);
  return db.prepare(sql).all(...args).map(hydrate);
}

/** MY RESEARCH — saved material, filterable, sortable, searchable. */
export function savedArticles({ q = '', category = '', concept = '', sort = 'saved_desc' } = {}) {
  const order = ({
    saved_desc: 's.saved_at DESC',
    saved_asc: 's.saved_at ASC',
    published_desc: "COALESCE(a.publication_date, a.published_at) DESC",
    published_asc: "COALESCE(a.publication_date, a.published_at) ASC",
    title: 'a.title COLLATE NOCASE ASC'
  })[sort] || 's.saved_at DESC';

  let sql = `SELECT ${ARTICLE_COLUMNS}, s.saved_at, s.note AS saved_note, s.project
             FROM saved_articles s JOIN articles a ON a.id = s.article_id WHERE 1=1`;
  const args = [];
  if (q) {
    sql += ` AND (a.title LIKE ? OR a.dek LIKE ? OR a.short_summary LIKE ? OR a.research_summary LIKE ?
                  OR a.authors LIKE ? OR a.source_name LIKE ?)`;
    args.push(...Array(6).fill(`%${q}%`));
  }
  if (category) { sql += ' AND a.category = ?'; args.push(category); }
  if (concept) {
    sql += ` AND EXISTS (SELECT 1 FROM article_tags at JOIN tags t ON t.id = at.tag_id
                         WHERE at.article_id = a.id AND t.slug = ?)`;
    args.push(concept);
  }
  sql += ` ORDER BY ${order}`;
  return db.prepare(sql).all(...args).map(hydrate);
}

/** Concept clusters across saved material — the beginnings of a literature map. */
export function savedConceptMap() {
  return db.prepare(`
    SELECT t.name, t.slug, count(*) AS n
    FROM saved_articles s
    JOIN article_tags at ON at.article_id = s.article_id
    JOIN tags t ON t.id = at.tag_id
    GROUP BY t.id HAVING n > 0
    ORDER BY n DESC, t.name`).all();
}

export function savedCategoryCounts() {
  return db.prepare(`
    SELECT a.category, count(*) AS n FROM saved_articles s JOIN articles a ON a.id = s.article_id
    GROUP BY a.category ORDER BY n DESC`).all()
    .map(r => ({ ...r, label: CATEGORY_LABELS[r.category] || r.category }));
}

export function articlesForConcept(slug) {
  return db.prepare(`
    SELECT ${ARTICLE_COLUMNS} FROM articles a
    JOIN article_tags at ON at.article_id = a.id
    JOIN tags t ON t.id = at.tag_id
    WHERE t.slug = ? AND a.status = 'published'
    ORDER BY a.published_at DESC`).all(slug).map(hydrate);
}

export function saveArticle(id, { note = null, project = null } = {}) {
  db.prepare('INSERT OR REPLACE INTO saved_articles (article_id, note, project) VALUES (?, ?, ?)')
    .run(id, note, project);
}

export function unsaveArticle(id) {
  db.prepare('DELETE FROM saved_articles WHERE article_id = ?').run(id);
}

export function isSaved(id) {
  return !!db.prepare('SELECT 1 FROM saved_articles WHERE article_id = ?').get(id);
}

export function lastRuns() {
  return {
    ingestion: db.prepare('SELECT * FROM ingestion_runs ORDER BY id DESC LIMIT 8').all(),
    generation: db.prepare(`
      SELECT g.*, e.edition_date, e.title AS edition_title
      FROM generation_runs g LEFT JOIN editions e ON e.id = g.edition_id
      ORDER BY g.id DESC LIMIT 8`).all()
  };
}

export function stats() {
  const one = sql => db.prepare(sql).get()?.n ?? 0;
  return {
    articles: one('SELECT count(*) n FROM articles'),
    published: one("SELECT count(*) n FROM articles WHERE status = 'published'"),
    queued: one("SELECT count(*) n FROM articles WHERE status IN ('ingested','approved')"),
    saved: one('SELECT count(*) n FROM saved_articles'),
    sources: one('SELECT count(*) n FROM sources WHERE enabled = 1'),
    demo: one('SELECT count(*) n FROM articles WHERE is_demo = 1'),
    concepts: one('SELECT count(*) n FROM tags')
  };
}

export { CATEGORY_LABELS };
