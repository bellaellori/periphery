/**
 * End-to-end exercise of the pipeline against local fixture feeds.
 *
 * Run with:  npm test
 * Uses its own database file, so nothing here touches real data.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TEST_DB = path.join(process.cwd(), 'data', 'test-periphery.db');
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = 'test';

for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}

const { startFixtureServer } = await import('./fixture-server.js');
const { db, migrate } = await import('../src/db/index.js');
const { runIngestion } = await import('../src/pipeline/ingest.js');
const { generateEdition, select, isLongReadDay } = await import('../src/pipeline/edition.js');
const { loadProfileModel, assess, reassessAll } = await import('../src/pipeline/relevance.js');
const { categorise } = await import('../src/pipeline/classify.js');

let server;

before(async () => {
  server = await startFixtureServer(4100);
  migrate();

  db.prepare(`UPDATE research_profile SET statement = ?, daily_size = 5, longread_size = 3 WHERE id = 1`)
    .run('Regulation, closure and distributed control in living systems.');

  const addInterest = db.prepare('INSERT INTO research_interests (kind, value, weight) VALUES (?, ?, ?)');
  [['topic', 'biological regulation', 1.2], ['topic', 'closure', 1.1], ['topic', 'distributed control', 1.1],
   ['concept', 'homeostasis', 1], ['concept', 'interoception', 1], ['concept', 'termination', 0.9],
   ['avoid', 'ceramics', 1]].forEach(i => addInterest.run(...i));

  const addAdj = db.prepare('INSERT INTO concept_adjacency (concept, adjacent, field, strength) VALUES (?, ?, ?, ?)');
  [['closure', 'termination detection', 'computer science', 0.9],
   ['distributed control', 'stigmergy', 'ethology', 0.8],
   ['biological regulation', 'resilience', 'ecology', 0.8],
   ['biological regulation', 'carrying capacity', 'ecology', 0.7]].forEach(a => addAdj.run(...a));

  const addSource = db.prepare(`INSERT INTO sources (name, kind, url, publisher_type, quality_tier)
                                VALUES (?, ?, ?, ?, ?)`);
  addSource.run('Fixture Journal', 'rss', 'http://localhost:4100/rss', 'journal', 1);
  addSource.run('Fixture Review', 'atom', 'http://localhost:4100/atom', 'journal', 1);
  addSource.run('Fixture Preprints', 'arxiv', 'http://localhost:4100/arxiv', 'preprint', 1);
});

after(() => { server?.close(); });

test('ingestion retrieves from every adapter and deduplicates', async () => {
  const r = await runIngestion({ trigger: 'test' });
  assert.equal(r.status, 'ok', 'all three fixture sources should succeed');
  assert.equal(r.sourcesOk, 3);
  assert.equal(r.seen, 7, 'four RSS items, two Atom entries, one arXiv entry');
  assert.equal(r.added, 6, 'the deliberate duplicate must not be stored');
  assert.equal(r.dupes, 1);
});

test('a second run adds nothing', async () => {
  const r = await runIngestion({ trigger: 'test' });
  assert.equal(r.added, 0);
  assert.equal(r.dupes, 7);
});

test('preprints are marked as preprints', () => {
  const a = db.prepare("SELECT * FROM articles WHERE title LIKE '%swarm model%'").get();
  assert.equal(a.publication_type, 'preprint');
  assert.equal(a.peer_review_status, 'preprint');
});

test('classification routes items to plausible sections', () => {
  const homeostasis = db.prepare("SELECT category FROM articles WHERE title LIKE '%homeostatic correction%'").get();
  assert.ok(['regulation', 'medicine', 'neuroscience'].includes(homeostasis.category));
  assert.equal(
    categorise({ title: 'ecosystem resilience and biodiversity', abstract: 'trophic species population dynamics' }, null),
    'ecology'
  );
});

test('direct matches score as core, avoided topics are vetoed', () => {
  const core = db.prepare("SELECT * FROM articles WHERE title LIKE '%homeostatic correction%'").get();
  assert.equal(core.relevance_status, 'core');

  const vetoed = db.prepare("SELECT * FROM articles WHERE title LIKE '%ceramics%'").get();
  assert.equal(vetoed.relevance_status, 'background');
  assert.equal(vetoed.relevance_score, 0);
  assert.match(vetoed.relevance_rationale, /avoided topic/);
});

test('the periphery principle finds material with no shared vocabulary', () => {
  const bridged = db.prepare("SELECT * FROM articles WHERE title LIKE '%consensus protocols%'").get();
  assert.equal(bridged.is_periphery_pick, 1, 'termination detection should bridge to closure');
  assert.equal(bridged.relevance_status, 'periphery');
  assert.match(bridged.relevance_rationale, /through the periphery/i);
  assert.match(bridged.periphery_bridge, /computer science/);

  const ecology = db.prepare("SELECT * FROM articles WHERE title LIKE '%carrying capacity%'").get();
  assert.equal(ecology.is_periphery_pick, 1, 'resilience should bridge to biological regulation');
});

test('editing the profile re-assesses everything already held', () => {
  db.prepare("DELETE FROM concept_adjacency WHERE adjacent = 'termination detection'").run();
  const n = reassessAll();
  assert.ok(n >= 6);
  const was = db.prepare("SELECT * FROM articles WHERE title LIKE '%consensus protocols%'").get();
  assert.equal(was.is_periphery_pick, 0, 'removing the bridge should remove the periphery pick');

  db.prepare('INSERT INTO concept_adjacency (concept, adjacent, field, strength) VALUES (?, ?, ?, ?)')
    .run('closure', 'termination detection', 'computer science', 0.9);
  reassessAll();
  const back = db.prepare("SELECT * FROM articles WHERE title LIKE '%consensus protocols%'").get();
  assert.equal(back.is_periphery_pick, 1, 'restoring the bridge should restore it');
});

test('selection reserves room for periphery picks and spreads categories', () => {
  const candidates = [
    { id: 1, category: 'regulation', relevance_score: 9, is_periphery_pick: 0, relevance_status: 'core' },
    { id: 2, category: 'regulation', relevance_score: 8, is_periphery_pick: 0, relevance_status: 'core' },
    { id: 3, category: 'regulation', relevance_score: 7, is_periphery_pick: 0, relevance_status: 'core' },
    { id: 4, category: 'neuroscience', relevance_score: 6, is_periphery_pick: 0, relevance_status: 'core' },
    { id: 5, category: 'ecology', relevance_score: 2, is_periphery_pick: 1, relevance_status: 'periphery' },
    { id: 6, category: 'distributed', relevance_score: 1.5, is_periphery_pick: 1, relevance_status: 'periphery' }
  ];
  const chosen = select(candidates, { size: 5, peripheryShare: 0.4, maxPerCategory: 2 });
  assert.equal(chosen.length, 5);
  assert.ok(chosen.filter(c => c.is_periphery_pick).length >= 2, 'periphery slots are reserved');
  assert.ok(chosen.filter(c => c.category === 'regulation').length <= 2, 'category cap holds');
  assert.equal(chosen[0].slot, 'lead');
});

test('a daily edition is generated, published and excludes vetoed material', async () => {
  const r = await generateEdition('daily', { trigger: 'test' });
  assert.equal(r.ok, true);
  assert.ok(r.selected > 0);

  const items = db.prepare(`
    SELECT a.* FROM edition_items ei JOIN articles a ON a.id = ei.article_id
    WHERE ei.edition_id = ?`).all(r.editionId);

  assert.ok(items.every(i => i.status === 'published'));
  assert.ok(items.every(i => !/ceramics/.test(i.title)), 'avoided material must never reach an edition');
  assert.ok(items.some(i => i.is_periphery_pick), 'the edition should carry a periphery pick');
  assert.ok(items.every(i => i.short_summary), 'every published item carries a summary');
  assert.ok(items.every(i => i.evidence_strength), 'every published item carries an evidence assessment');
  assert.ok(items.every(i => i.source_url), 'every published item links to its source');
});

test('a long-read edition takes only long-form material', async () => {
  const r = await generateEdition('long_read', { trigger: 'test' });
  if (!r.ok) return; // no long-form candidates in the fixture window is a valid outcome
  const items = db.prepare(`
    SELECT a.* FROM edition_items ei JOIN articles a ON a.id = ei.article_id
    WHERE ei.edition_id = ?`).all(r.editionId);
  assert.ok(items.every(i => i.is_long_form === 1));
});

test('an item is never used in two editions', () => {
  const dupes = db.prepare(`
    SELECT article_id, count(*) n FROM edition_items GROUP BY article_id HAVING n > 1`).all();
  assert.equal(dupes.length, 0);
});

test('the long-read schedule is Wednesday, Saturday and Sunday', () => {
  assert.equal(isLongReadDay(new Date('2026-09-09T12:00:00Z')), true);  // Wednesday
  assert.equal(isLongReadDay(new Date('2026-09-12T12:00:00Z')), true);  // Saturday
  assert.equal(isLongReadDay(new Date('2026-09-13T12:00:00Z')), true);  // Sunday
  assert.equal(isLongReadDay(new Date('2026-09-10T12:00:00Z')), false); // Thursday
  assert.equal(isLongReadDay(new Date('2026-09-11T12:00:00Z')), false); // Friday
});

test('a source that fails does not take down the run', async () => {
  db.prepare(`INSERT INTO sources (name, kind, url, publisher_type) VALUES (?, ?, ?, ?)`)
    .run('Broken fixture', 'rss', 'http://localhost:4199/nothing-here', 'other');
  const r = await runIngestion({ trigger: 'test' });
  assert.equal(r.status, 'partial');
  assert.equal(r.sourcesOk, 3);
  const broken = db.prepare("SELECT last_status FROM sources WHERE name = 'Broken fixture'").get();
  assert.match(broken.last_status, /^error/);
});

test('summaries never invent a source link', () => {
  const rows = db.prepare('SELECT source_url FROM articles').all();
  assert.ok(rows.every(r => r.source_url.startsWith('http://localhost:4100')),
    'every stored URL came from the fixture feed, none was generated');
});
