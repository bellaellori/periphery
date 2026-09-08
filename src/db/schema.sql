-- PERIPHERY — schema
-- SQLite. One file, real persistence, portable to any host with a disk volume.
-- Every table is created IF NOT EXISTS so this file doubles as an idempotent migration.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- SOURCES — where material is retrieved from
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'rss',   -- rss | atom | arxiv | crossref | pubmed | biorxiv | json
  url               TEXT NOT NULL,                 -- feed or API endpoint
  homepage          TEXT,
  publisher_type    TEXT NOT NULL DEFAULT 'other', -- journal | preprint | institution | magazine | dataset | other
  quality_tier      INTEGER NOT NULL DEFAULT 2,    -- 1 = primary/peer-reviewed, 2 = strong secondary, 3 = general
  default_category  TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  fetch_interval_h  INTEGER NOT NULL DEFAULT 24,
  last_fetched_at   TEXT,
  last_status       TEXT,
  exclude_pattern   TEXT,   -- drop items whose URL matches this (e.g. '/videos/')
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_url ON sources(url);

-- ---------------------------------------------------------------------------
-- ARTICLES — the core content model
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS articles (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  slug                  TEXT NOT NULL UNIQUE,

  -- editorial surface
  title                 TEXT NOT NULL,
  dek                   TEXT,                       -- subtitle / standfirst
  short_summary         TEXT,                       -- 1–2 sentences, used on index pages
  research_summary      TEXT,                       -- detailed science/research summary
  what_happened         TEXT,
  what_they_did         TEXT,
  what_they_found       TEXT,
  evidence_strength     TEXT,                       -- prose assessment of how strong the evidence is
  why_interesting       TEXT,
  broader_question      TEXT,
  why_it_matters        TEXT,
  connection_to_research TEXT,                      -- connection to the reader's research profile

  -- long-form specific
  selection_rationale   TEXT,                       -- why it was selected
  intellectual_territory TEXT,                      -- what territory it covers
  concepts_raised       TEXT,                       -- useful concepts / questions it raises

  -- provenance
  source_id             INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  source_name           TEXT NOT NULL,
  source_url            TEXT NOT NULL,
  canonical_id          TEXT,                       -- DOI / arXiv id / GUID
  authors               TEXT,
  publication_date      TEXT,                       -- ISO date of the original work
  publication_type      TEXT NOT NULL DEFAULT 'article', -- paper | preprint | review | essay | report | investigation | book_chapter | article
  peer_review_status    TEXT NOT NULL DEFAULT 'unknown',  -- peer_reviewed | preprint | not_applicable | unknown
  open_access           INTEGER NOT NULL DEFAULT 0,

  -- classification
  category              TEXT NOT NULL DEFAULT 'general',
  reading_time_min      INTEGER,
  word_estimate         INTEGER,

  -- relevance
  relevance_status      TEXT NOT NULL DEFAULT 'unassessed', -- core | adjacent | periphery | background | unassessed
  relevance_score       REAL NOT NULL DEFAULT 0,
  relevance_rationale   TEXT,
  is_periphery_pick     INTEGER NOT NULL DEFAULT 0,
  periphery_bridge      TEXT,                       -- the adjacency that justified the pick

  -- lifecycle
  status                TEXT NOT NULL DEFAULT 'ingested', -- ingested | approved | published | rejected
  is_long_form          INTEGER NOT NULL DEFAULT 0,
  is_demo               INTEGER NOT NULL DEFAULT 0,
  summary_provenance    TEXT NOT NULL DEFAULT 'none', -- none | extractive | model | human
  content_hash          TEXT,                       -- dedup key
  ingested_at           TEXT NOT NULL DEFAULT (datetime('now')),
  published_at          TEXT,
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_hash ON articles(content_hash);
CREATE INDEX IF NOT EXISTS idx_articles_canonical ON articles(canonical_id);

-- Retrieved abstract / excerpt, held for the pipeline and the editorial view.
-- Kept out of `articles` deliberately: this is working material for
-- summarisation, never republished in full on the public site.
CREATE TABLE IF NOT EXISTS article_excerpts (
  article_id   INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  excerpt      TEXT,
  retrieved_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- TAGS / CONCEPTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL DEFAULT 'concept',  -- concept | field | method | organism | other
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  weight     REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (article_id, tag_id)
);

-- ---------------------------------------------------------------------------
-- EDITIONS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS editions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,                 -- daily | long_read
  edition_date  TEXT NOT NULL,                 -- YYYY-MM-DD
  title         TEXT NOT NULL,
  standfirst    TEXT,
  editors_note  TEXT,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft | published
  item_count    INTEGER NOT NULL DEFAULT 0,
  generated_by  TEXT,                          -- pipeline | manual
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  published_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_editions_kind_date ON editions(kind, edition_date);

CREATE TABLE IF NOT EXISTS edition_items (
  edition_id  INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  slot        TEXT NOT NULL DEFAULT 'main',   -- lead | main | periphery | brief
  note        TEXT,
  PRIMARY KEY (edition_id, article_id)
);

-- ---------------------------------------------------------------------------
-- RESEARCH PROFILE
-- ---------------------------------------------------------------------------
-- Nothing about the reader's interests is hard-coded in application logic.
-- Everything the selection system uses lives in these two tables and is editable
-- from the interface.
CREATE TABLE IF NOT EXISTS research_profile (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  display_name  TEXT,
  statement     TEXT,             -- prose description of current research concerns
  periphery_appetite REAL NOT NULL DEFAULT 0.35, -- 0–1: share of an edition reserved for adjacent finds
  daily_size    INTEGER NOT NULL DEFAULT 7,
  longread_size INTEGER NOT NULL DEFAULT 4,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS research_interests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,   -- topic | concept | field | author | source | avoid | project
  value       TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1,
  notes       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  expires_on  TEXT,            -- for temporary research projects
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_interests_kind ON research_interests(kind, active);

-- Adjacency map powering the periphery principle. Editable, not hard-coded.
CREATE TABLE IF NOT EXISTS concept_adjacency (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  concept   TEXT NOT NULL,   -- a concept the reader cares about
  adjacent  TEXT NOT NULL,   -- a term from a neighbouring field that often carries it
  field     TEXT,            -- the neighbouring field
  strength  REAL NOT NULL DEFAULT 0.6,
  UNIQUE (concept, adjacent)
);

-- ---------------------------------------------------------------------------
-- SAVED / RELEVANT
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_articles (
  article_id  INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  saved_at    TEXT NOT NULL DEFAULT (datetime('now')),
  note        TEXT,
  project     TEXT
);

-- ---------------------------------------------------------------------------
-- RUN LOGS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  status        TEXT NOT NULL DEFAULT 'running', -- running | ok | partial | failed
  sources_tried INTEGER NOT NULL DEFAULT 0,
  sources_ok    INTEGER NOT NULL DEFAULT 0,
  items_seen    INTEGER NOT NULL DEFAULT 0,
  items_new     INTEGER NOT NULL DEFAULT 0,
  items_duplicate INTEGER NOT NULL DEFAULT 0,
  trigger       TEXT NOT NULL DEFAULT 'manual',  -- cron | manual | api
  log           TEXT
);

CREATE TABLE IF NOT EXISTS generation_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  status        TEXT NOT NULL DEFAULT 'running',
  kind          TEXT NOT NULL,                   -- daily | long_read
  edition_id    INTEGER REFERENCES editions(id) ON DELETE SET NULL,
  candidates    INTEGER NOT NULL DEFAULT 0,
  selected      INTEGER NOT NULL DEFAULT 0,
  summariser    TEXT,                            -- model | extractive
  trigger       TEXT NOT NULL DEFAULT 'manual',
  log           TEXT
);
