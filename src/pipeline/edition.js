/**
 * Edition generation.
 *
 *   daily      — THE DAILY OBSERVATORY, every day
 *   long_read  — THE LONG READ, Wednesday / Saturday / Sunday
 *
 * Selection is a scored shortlist with two constraints the reader asked for:
 * a reserved share of periphery picks, and category spread so an edition is
 * never seven versions of the same story.
 */
import { db, profile } from '../db/index.js';
import { summarise, summariserName } from './summarise.js';
import { CATEGORY_LABELS } from './classify.js';
import { slugify, readingTime } from '../lib/text.js';

export const LONG_READ_DAYS = [3, 6, 0]; // Wed, Sat, Sun

export function isLongReadDay(date = new Date()) {
  return LONG_READ_DAYS.includes(date.getDay());
}

export function longReadFlavour(date = new Date()) {
  return date.getDay() === 3 ? 'wednesday' : 'weekend';
}

/** What to call a Long Read edition, including one built off-schedule by hand. */
export function longReadLabel(date = new Date()) {
  const d = date.getDay();
  if (d === 3) return 'Wednesday selection';
  if (d === 6 || d === 0) return 'Weekend selection';
  return 'Off-schedule selection';
}

const DAILY_SQL = `
  SELECT a.*, e.excerpt
  FROM articles a
  LEFT JOIN article_excerpts e ON e.article_id = a.id
  LEFT JOIN sources s ON s.id = a.source_id
  WHERE a.status IN ('ingested', 'approved')
    AND a.relevance_status != 'background'
    AND COALESCE(s.publisher_type, '') != 'essay'
    AND a.ingested_at >= datetime('now', @window)
    AND NOT EXISTS (SELECT 1 FROM edition_items ei WHERE ei.article_id = a.id)
  ORDER BY a.relevance_score DESC, a.publication_date DESC
  LIMIT 300`;

// Essays are not scored — their vocabulary deliberately avoids the matcher's
// terms, and their editors already did the selecting. No relevance filter,
// newest first.
const LONGREAD_SQL = `
  SELECT a.*, e.excerpt
  FROM articles a
  LEFT JOIN article_excerpts e ON e.article_id = a.id
  JOIN sources s ON s.id = a.source_id
  WHERE a.status IN ('ingested', 'approved')
    AND s.publisher_type = 'essay'
    AND a.ingested_at >= datetime('now', @window)
    AND NOT EXISTS (SELECT 1 FROM edition_items ei WHERE ei.article_id = a.id)
  ORDER BY a.publication_date DESC, a.id DESC
  LIMIT 300`;

function shortlist({ longForm, windowDays }) {
  return db.prepare(longForm ? LONGREAD_SQL : DAILY_SQL).all({ window: `-${windowDays} days` });
}

/**
 * Pick the running order.
 * @param {object[]} candidates
 * @param {object}   opts { size, peripheryShare, maxPerCategory, maxPerSource, requireDirect }
 */
export function select(candidates, { size, peripheryShare = 0.35, maxPerCategory = 2, maxPerSource = 2, requireDirect = false }) {
  const peripheryTarget = Math.max(1, Math.round(size * peripheryShare));
  const chosen = [];
  const perCategory = new Map();
  const perSource = new Map();

  const take = (a, slot) => {
    chosen.push({ ...a, slot });
    perCategory.set(a.category, (perCategory.get(a.category) || 0) + 1);
    if (a.source_name) perSource.set(a.source_name, (perSource.get(a.source_name) || 0) + 1);
  };
  const roomCategory = a => (perCategory.get(a.category) || 0) < maxPerCategory;
  // Items with no source_name (e.g. bare test fixtures) are exempt, rather
  // than all colliding into a single undefined "source".
  const roomSource = a => !a.source_name || (perSource.get(a.source_name) || 0) < maxPerSource;
  const room = a => roomCategory(a) && roomSource(a);
  const picked = () => new Set(chosen.map(c => c.id));

  // 1. Core / directly relevant material first.
  const direct = candidates
    .filter(a => !a.is_periphery_pick)
    .filter(a => !requireDirect || a.relevance_status === 'core' || a.relevance_status === 'adjacent');
  for (const a of direct) {
    if (chosen.length >= size - peripheryTarget) break;
    if (room(a)) take(a, 'main');
  }

  // 2. The reserved periphery slots — the point of the whole publication.
  const periphery = candidates.filter(a => a.is_periphery_pick && !picked().has(a.id));
  for (const a of periphery) {
    if (chosen.length >= size) break;
    if (room(a)) take(a, 'periphery');
  }

  // 3. Backfill if either pool ran dry, relaxing the category cap last — but
  // the source cap holds even here, so one prolific source cannot fill the rest.
  for (const relax of [false, true]) {
    for (const a of candidates) {
      if (chosen.length >= size) break;
      if (picked().has(a.id)) continue;
      if (!roomSource(a)) continue;
      if (!relax && !roomCategory(a)) continue;
      take(a, a.is_periphery_pick ? 'periphery' : 'main');
    }
  }

  chosen.sort((a, b) => b.relevance_score - a.relevance_score);
  if (chosen[0]) chosen[0].slot = 'lead';
  return chosen.slice(0, size);
}

function standfirstFor(kind, items) {
  const cats = [...new Set(items.map(i => CATEGORY_LABELS[i.category] || i.category))];
  const nPeriphery = items.filter(i => i.is_periphery_pick).length;
  const spread = cats.length > 3
    ? `${cats.slice(0, 3).join(', ')} and ${cats.length - 3} more`
    : cats.join(', ');

  if (kind === 'daily') {
    return `${items.length} pieces from ${spread}`
      + (nPeriphery ? `, ${nPeriphery} of them found at the edges of the profile rather than inside it` : '')
      + '.';
  }
  return `${items.length} essay${items.length === 1 ? '' : 's'} from Aeon and Psyche, newest first.`;
}

function editorsNoteFor(kind, items) {
  if (kind === 'daily') {
    const preprints = items.filter(i => i.peer_review_status === 'preprint').length;
    return `Today's selection was assembled automatically from the configured sources and ranked against the research profile. `
      + (preprints ? `${preprints} of ${items.length} ${preprints === 1 ? 'item is a preprint' : 'items are preprints'} and ${preprints === 1 ? 'has' : 'have'} not been peer reviewed; ` : '')
      + `each entry links to its original source, which remains the thing to read.`;
  }
  return `Essays aren't scored against the research profile — their vocabulary deliberately avoids the vocabulary a matcher looks for, and their editors already did the selecting. This is simply the newest from Aeon and Psyche, unranked.`;
}

const upsertEdition = db.prepare(`
  INSERT INTO editions (kind, edition_date, title, standfirst, editors_note, status, item_count, generated_by, published_at)
  VALUES (@kind, @edition_date, @title, @standfirst, @editors_note, @status, @item_count, @generated_by, @published_at)
  ON CONFLICT(kind, edition_date) DO UPDATE SET
    title = excluded.title, standfirst = excluded.standfirst, editors_note = excluded.editors_note,
    status = excluded.status, item_count = excluded.item_count, published_at = excluded.published_at
  RETURNING id`);

const applyApparatus = db.prepare(`
  UPDATE articles SET
    dek = COALESCE(@dek, dek),
    short_summary = COALESCE(@short_summary, short_summary),
    research_summary = COALESCE(@research_summary, research_summary),
    what_happened = COALESCE(@what_happened, what_happened),
    what_they_did = COALESCE(@what_they_did, what_they_did),
    what_they_found = COALESCE(@what_they_found, what_they_found),
    evidence_strength = COALESCE(@evidence_strength, evidence_strength),
    why_interesting = COALESCE(@why_interesting, why_interesting),
    broader_question = COALESCE(@broader_question, broader_question),
    why_it_matters = COALESCE(@why_it_matters, why_it_matters),
    connection_to_research = COALESCE(@connection_to_research, connection_to_research),
    selection_rationale = COALESCE(@selection_rationale, selection_rationale),
    intellectual_territory = COALESCE(@intellectual_territory, intellectual_territory),
    concepts_raised = COALESCE(@concepts_raised, concepts_raised),
    summary_provenance = @summary_provenance,
    status = 'published',
    published_at = COALESCE(published_at, datetime('now')),
    updated_at = datetime('now')
  WHERE id = @id`);

export function attachTags(articleId, concepts = []) {
  const getTag = db.prepare('SELECT id FROM tags WHERE slug = ?');
  const addTag = db.prepare('INSERT INTO tags (name, slug, kind) VALUES (?, ?, ?) RETURNING id');
  const link = db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)');
  for (const raw of concepts) {
    const name = String(raw).trim().toLowerCase();
    if (!name || name.length > 60) continue;
    const slug = slugify(name);
    const tag = getTag.get(slug) || addTag.get(name, slug, 'concept');
    link.run(articleId, tag.id);
  }
}

/**
 * Generate (or regenerate) one edition.
 * @param {'daily'|'long_read'} kind
 */
export async function generateEdition(kind, {
  date = new Date(),
  trigger = 'manual',
  publish = true,
  windowDays = kind === 'daily' ? 3 : 21,
  log = () => {}
} = {}) {
  const p = profile();
  const editionDate = date.toISOString().slice(0, 10);

  const run = db.prepare(
    `INSERT INTO generation_runs (kind, status, trigger, summariser) VALUES (?, 'running', ?, ?)`
  ).run(kind, trigger, summariserName());
  const runId = run.lastInsertRowid;
  const lines = [];
  const say = m => { lines.push(m); log(m); };

  try {
    const candidates = shortlist({ longForm: kind === 'long_read', windowDays });
    say(`${candidates.length} candidates in the last ${windowDays} days`);

    if (!candidates.length) {
      // Nothing to publish is not a malfunction: the run worked, the library had
      // nothing new in the window. Recorded as "empty" so a health check does not
      // cry failure over a quiet day — but still visible on the runs page.
      db.prepare(`UPDATE generation_runs SET finished_at = datetime('now'), status = 'empty',
        candidates = 0, selected = 0, log = ? WHERE id = ?`)
        .run(lines.concat(
          'No unused candidates in the window. Either ingestion found nothing new, or everything held is already in an edition.'
        ).join('\n'), runId);
      return { ok: false, reason: 'no-candidates', runId };
    }

    const size = kind === 'daily' ? (p?.daily_size || 7) : (p?.longread_size || 4);
    // Essays are never scored against the profile — their editors already did the
    // selecting — so the Long Read just takes the newest ones rather than ranking them.
    const items = kind === 'long_read'
      ? candidates.slice(0, size).map((a, i) => ({ ...a, slot: i === 0 ? 'lead' : 'main' }))
      : select(candidates, {
          size,
          peripheryShare: p?.periphery_appetite ?? 0.35,
          maxPerCategory: 2,
          maxPerSource: 2
        });
    say(`selected ${items.length} (${items.filter(i => i.is_periphery_pick).length} periphery)`);

    // Editorial apparatus, one item at a time so a single failure is contained.
    for (const item of items) {
      const out = await summarise(
        { ...item, abstract: item.excerpt || item.short_summary || '' },
        {
          longForm: kind === 'long_read',
          relevance: item,
          profileStatement: p?.statement || ''
        }
      );
      if (out._error) say(`summariser fell back for "${item.title.slice(0, 50)}…": ${out._error}`);
      applyApparatus.run({
        id: item.id,
        dek: out.dek ?? null,
        short_summary: out.short_summary ?? null,
        research_summary: out.research_summary ?? null,
        what_happened: out.what_happened ?? null,
        what_they_did: out.what_they_did ?? null,
        what_they_found: out.what_they_found ?? null,
        evidence_strength: out.evidence_strength ?? null,
        why_interesting: out.why_interesting ?? null,
        broader_question: out.broader_question ?? null,
        why_it_matters: out.why_it_matters ?? null,
        connection_to_research: out.connection_to_research ?? null,
        selection_rationale: out.selection_rationale ?? item.relevance_rationale ?? null,
        intellectual_territory: out.intellectual_territory ?? null,
        concepts_raised: out.concepts_raised ?? null,
        summary_provenance: out.summary_provenance
      });
      attachTags(item.id, out.concepts || []);
    }

    const title = kind === 'daily' ? 'The Daily Observatory' : 'The Long Read';
    const { id: editionId } = upsertEdition.get({
      kind,
      edition_date: editionDate,
      title,
      standfirst: standfirstFor(kind, items),
      editors_note: editorsNoteFor(kind, items),
      status: publish ? 'published' : 'draft',
      item_count: items.length,
      generated_by: trigger === 'manual' ? 'manual' : 'pipeline',
      published_at: publish ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null
    });

    db.prepare('DELETE FROM edition_items WHERE edition_id = ?').run(editionId);
    const addItem = db.prepare(
      'INSERT INTO edition_items (edition_id, article_id, position, slot) VALUES (?, ?, ?, ?)'
    );
    items.forEach((it, i) => addItem.run(editionId, it.id, i, it.slot));

    db.prepare(`UPDATE generation_runs SET finished_at = datetime('now'), status = 'ok',
      edition_id = ?, candidates = ?, selected = ?, log = ? WHERE id = ?`)
      .run(editionId, candidates.length, items.length, lines.join('\n'), runId);

    return { ok: true, editionId, kind, date: editionDate, selected: items.length, runId, log: lines };
  } catch (err) {
    db.prepare(`UPDATE generation_runs SET finished_at = datetime('now'), status = 'failed', log = ? WHERE id = ?`)
      .run(lines.concat(`FAILED: ${err.stack || err.message}`).join('\n'), runId);
    throw err;
  }
}
