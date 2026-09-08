/**
 * Ingestion run: retrieve → deduplicate → classify → assess relevance → store.
 *
 * Nothing is published here. Ingestion fills the library; edition generation
 * decides what goes on the page.
 */
import { db } from '../db/index.js';
import { fetchSource } from './fetchers.js';
import { categorise, typify, estimateReading, isLongForm } from './classify.js';
import { loadProfileModel, assess } from './relevance.js';
import { slugify, hash, fold, truncate } from '../lib/text.js';

function uniqueSlug(title) {
  const base = slugify(title);
  const exists = db.prepare('SELECT 1 FROM articles WHERE slug = ?');
  if (!exists.get(base)) return base;
  for (let i = 2; i < 200; i++) {
    const s = `${base}-${i}`;
    if (!exists.get(s)) return s;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Dedup key: canonical identifier if we have one, otherwise the folded title. */
function contentHash(item) {
  const canon = (item.canonical_id || '')
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/v\d+$/, '')
    .toLowerCase().trim();
  return canon ? hash('canon', canon) : hash('title', fold(item.title));
}

function findDuplicate(h, title) {
  const byHash = db.prepare('SELECT id, title FROM articles WHERE content_hash = ?').get(h);
  if (byHash) return byHash;
  // Cheap near-duplicate guard: same folded title under a different identifier.
  const t = fold(title);
  if (t.length < 12) return null;
  return db.prepare('SELECT id, title FROM articles WHERE lower(title) = ?').get(title.toLowerCase()) || null;
}

const insert = db.prepare(`
  INSERT INTO articles (
    slug, title, dek, short_summary, source_id, source_name, source_url, canonical_id,
    authors, publication_date, publication_type, peer_review_status, open_access,
    category, reading_time_min, word_estimate,
    relevance_status, relevance_score, relevance_rationale, is_periphery_pick, periphery_bridge,
    status, is_long_form, is_demo, content_hash
  ) VALUES (
    @slug, @title, @dek, @short_summary, @source_id, @source_name, @source_url, @canonical_id,
    @authors, @publication_date, @publication_type, @peer_review_status, @open_access,
    @category, @reading_time_min, @word_estimate,
    @relevance_status, @relevance_score, @relevance_rationale, @is_periphery_pick, @periphery_bridge,
    'ingested', @is_long_form, 0, @content_hash
  )`);

const insertExcerpt = db.prepare(
  `INSERT OR REPLACE INTO article_excerpts (article_id, excerpt) VALUES (?, ?)`
);

export async function runIngestion({ trigger = 'manual', sourceIds = null, log = () => {} } = {}) {
  const run = db.prepare(
    `INSERT INTO ingestion_runs (status, trigger) VALUES ('running', ?)`
  ).run(trigger);
  const runId = run.lastInsertRowid;
  const lines = [];
  const say = (m) => { lines.push(m); log(m); };

  let sources = db.prepare('SELECT * FROM sources WHERE enabled = 1 ORDER BY quality_tier, name').all();
  if (sourceIds?.length) sources = sources.filter(s => sourceIds.includes(s.id));

  const model = loadProfileModel();
  let seen = 0, added = 0, dupes = 0, ok = 0;

  for (const source of sources) {
    const t0 = Date.now();
    const { ok: fine, items, error } = await fetchSource(source);
    db.prepare(`UPDATE sources SET last_fetched_at = datetime('now'), last_status = ? WHERE id = ?`)
      .run(fine ? `ok (${items.length} items, ${Date.now() - t0}ms)` : `error: ${error}`, source.id);

    if (!fine) { say(`✗ ${source.name}: ${error}`); continue; }
    ok++;
    seen += items.length;

    for (const item of items) {
      const h = contentHash(item);
      const dup = findDuplicate(h, item.title);
      if (dup) { dupes++; continue; }

      const category = categorise(item, source);
      const { publication_type, peer_review_status } = typify(item, source);
      const { word_estimate, reading_time_min } = estimateReading(item, publication_type);
      const rel = assess({ ...item, category }, model, { sourceName: source.name });

      const row = {
        slug: uniqueSlug(item.title),
        title: item.title,
        dek: null,
        short_summary: truncate(item.abstract, 300) || null,
        source_id: source.id,
        source_name: source.name,
        source_url: item.url,
        canonical_id: item.canonical_id || null,
        authors: item.authors,
        publication_date: item.publication_date,
        publication_type,
        peer_review_status,
        open_access: item.open_access ? 1 : 0,
        category,
        reading_time_min,
        word_estimate,
        relevance_status: rel.relevance_status,
        relevance_score: rel.relevance_score,
        relevance_rationale: rel.relevance_rationale,
        is_periphery_pick: rel.is_periphery_pick,
        periphery_bridge: rel.periphery_bridge,
        is_long_form: isLongForm({ publication_type, word_estimate }) ? 1 : 0,
        content_hash: h
      };

      try {
        const res = insert.run(row);
        insertExcerpt.run(Number(res.lastInsertRowid), item.abstract || '');
        added++;
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) dupes++;
        else say(`! ${source.name}: could not store "${truncate(item.title, 60)}" — ${err.message}`);
      }
    }
    say(`✓ ${source.name}: ${items.length} seen`);
  }

  const status = ok === 0 && sources.length ? 'failed' : (ok < sources.length ? 'partial' : 'ok');
  db.prepare(`
    UPDATE ingestion_runs SET finished_at = datetime('now'), status = ?, sources_tried = ?,
      sources_ok = ?, items_seen = ?, items_new = ?, items_duplicate = ?, log = ?
    WHERE id = ?`)
    .run(status, sources.length, ok, seen, added, dupes, lines.join('\n'), runId);

  return { runId, status, sources: sources.length, sourcesOk: ok, seen, added, dupes, log: lines };
}
