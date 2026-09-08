# PERIPHERY

A personal research observatory: an intellectual magazine that assembles itself daily from
journals, preprint servers and institutions, and brings back the things worth knowing —
including the things at the edges of your existing interests, which is the part most
reading systems get wrong.

Masthead: **PERIPHERY** · *Science · Ideas · The World*

---

## Running it

```bash
npm install
npm run seed            # starter sources, a starting research profile, labelled demo content
npm start               # http://localhost:3000
```

That gives you a working site immediately, populated with a demo set that is marked as demo
everywhere it appears. To see the real thing:

```bash
npm run pipeline:daily  # retrieve from the configured sources, build today's edition
npm run seed:clear      # remove the demo set once real material is in
```

Node 20 or newer. The database is SQLite, in a single file — no server to run, and the whole
library is one file to back up.

---

## What it does

**THE DAILY OBSERVATORY** — every day. A ranked selection from the sources, with each entry
answering the six questions: what happened, what the researchers actually did, what they
found, how strong the evidence is, why it is interesting, and what broader question it
connects to. Preprints are labelled as preprints wherever they appear. Findings,
interpretations and speculation are kept apart.

**THE LONG READ** — Wednesday, Saturday and Sunday. Wednesday stays close to the research
profile; the weekend ranges wider. Each selection carries why it was chosen, what territory
it covers, and what concepts it puts in play — and then gets out of the way. The original is
the reading; the note is only the approach to it.

**MY RESEARCH** — everything you have marked *Relevant to my work*, grouped by the concepts
attached to it, searchable and filterable. A piece appears under every concept it carries,
which is what makes it a map rather than a bookmark list.

**RESEARCH PROFILE** — the only thing steering selection. No reader's interests are written
into the application code. Change the profile and every piece already held is re-scored
against it.

**EDITORIAL DESK** (`/admin`) — the ingestion queue, approve/edit/reject, source management,
manual runs, and whether the last automated run succeeded.

---

## The periphery principle

Matching your own keywords returns what you already know how to find. The interesting
material is usually the same problem in another discipline's vocabulary — closure in a
biological control loop and termination in a distributed protocol; regulation in physiology
and governance in an institution.

So the profile carries a second layer, the **periphery map** (`concept_adjacency`): rows
saying "when material talks about *this adjacent term*, in this field, it may be treating one
of my concepts under another name." Two scores are computed for every candidate:

- **direct** — overlap with what you said you work on
- **bridge** — overlap with a neighbouring vocabulary for one of those concerns

A piece where the bridge carried the weight is flagged as a **periphery pick**, shown with the
bridge that found it, and every edition reserves a share of its slots for them. That share is
the *periphery appetite* setting, editable on the profile page.

Matching is done on stems, so `homeostasis` finds `homeostatic` and `regulation` finds
`regulatory`. Multi-word terms score fully when the phrase appears and partially when the
words appear scattered. Anything on the **avoid** list is a hard veto, not a penalty.

Edit the map at `/profile#adjacency`. Remove a bridge and the picks it produced disappear on
the next re-assessment; add one and they come back. There is a test for exactly that.

---

## Architecture

```
src/
  server.js              express app, routes mounted, optional site password
  scheduler.js           optional in-process scheduler (off by default)
  db/
    schema.sql           the whole schema; idempotent, doubles as the migration
    index.js             connection, migrate(), profile/interests helpers
  pipeline/
    fetchers.js          retrieval adapters: rss/atom, arXiv, bioRxiv, Crossref, PubMed, JSON feed
    classify.js          category taxonomy, publication type, reading time
    relevance.js         profile scoring and the periphery principle
    summarise.js         model summariser with a strict brief, extractive fallback
    ingest.js            retrieve → deduplicate → classify → assess → store
    edition.js           select → summarise → compose → publish
    run.js               command line entry point for a scheduler
  routes/                site.js (public), api.js (JSON), admin.js (editorial desk)
  views/                 EJS templates
  lib/                   text handling, formatting, queries, auth
public/                  one stylesheet, one small progressive-enhancement script
scripts/seed.js          sources, profile, demo content
tests/                   pipeline tests against local fixture feeds; browser flow walk
deploy/                  cron, systemd, Fly, GitHub Actions examples
```

The pipeline never publishes what it did not retrieve. Every article row carries the source
name and the URL it came from; summaries are generated only from the abstract and metadata
that were actually fetched; and the summariser's brief requires a `null` rather than an
invention when the material does not support a field. Full text is never reproduced — the
site stores metadata, a summary and a link.

### Data model

`sources` · `articles` · `article_excerpts` · `editions` · `edition_items` · `tags` ·
`article_tags` · `research_profile` · `research_interests` · `concept_adjacency` ·
`saved_articles` · `ingestion_runs` · `generation_runs`

Deduplication is on a content hash: the canonical identifier (DOI, arXiv id) where one
exists, the normalised title otherwise, with a second guard on exact title match.

---

## Scheduling the automation

Daily content runs once a day. Long-form selection runs on Wednesday, Saturday and Sunday.
The command decides which of those today needs, so **one scheduled job is enough**:

```bash
node src/pipeline/run.js auto
```

It exits 0 on success and 1 on failure, so a scheduler, a CI job or a healthcheck can tell.
Pick whichever of these fits the host.

### 1. Real cron — a VPS, or any machine that is on

See `deploy/crontab.example` and `deploy/periphery.service`.

```cron
CRON_TZ=Europe/Stockholm
15 6 * * *  cd /srv/periphery && /usr/bin/node --env-file=.env src/pipeline/run.js auto >> /var/log/periphery.log 2>&1
```

### 2. An external scheduler over HTTP — a platform with no cron

`POST /api/pipeline/run` does the same work and is authenticated with `CRON_SECRET`, a
credential that can trigger the pipeline and nothing else.

```bash
curl -X POST https://your-host/api/pipeline/run \
     -H "x-cron-secret: $CRON_SECRET" -H "content-type: application/json" -d '{}'
```

`deploy/github-actions-schedule.yml` is a ready workflow. cron-job.org, EasyCron, Upstash QStash
and Cloudflare Workers Cron all work the same way. Note that GitHub Actions cron is UTC and does
not observe daylight saving.

To keep the two jobs separate, `POST /api/editions/generate` with `{"kind":"daily"}` or
`{"kind":"long_read"}` instead.

### 3. The in-process scheduler — last resort

```
ENABLE_INTERNAL_SCHEDULER=1
DAILY_RUN_HOUR=6
```

Checks hourly whether today's editions exist and builds them if not. It reads the database
rather than holding timers, so a restart, a sleep or a redeploy cannot cause a double run or
a missed day. It only works while the process is up, which is why it is not the default.

### Confirming it worked

`GET /api/health` returns the last ingestion and generation run, and answers **503** if either
failed. Point an uptime checker at it and you will hear about a broken pipeline without
looking. The same information, with logs, is at `/admin/runs`.

A run marked **empty** is not a failure: the pipeline worked and there was nothing new to
publish in the window. It shows on the runs page but does not trip the health check. A run
marked **partial** means some sources answered and some did not — the log names which.

---

## Hosting

The one real requirement is **a disk that persists between deploys**. SQLite is a file; a
platform with an ephemeral filesystem will silently discard the library on every deploy.

| Host | Persistence | Scheduling | Notes |
|---|---|---|---|
| VPS (Hetzner, DigitalOcean…) | any directory | real cron | simplest and cheapest; `deploy/periphery.service` |
| Fly.io | a volume, mounted at `/data` | scheduled Machine, or HTTP | `deploy/fly.toml.example`; `arn` is Stockholm |
| Railway | a volume | built-in cron | set `DATABASE_PATH` into the volume |
| Render | a persistent disk | Render cron job | the free tier has no disk — the paid one does |
| Your own machine | trivially | `launchd`/Task Scheduler/cron | fine if it is on in the mornings |

**Not suitable without changes:** Vercel, Netlify Functions, Cloudflare Workers and other
read-only or ephemeral runtimes. Moving to Postgres for those means rewriting `src/db/` and
the `better-sqlite3` calls in the pipeline; the schema itself ports almost unchanged.

A Dockerfile is included, with `/data` as a volume and a healthcheck already wired to
`/api/health`.

### Environment

Copy `.env.example` to `.env`. The ones that matter:

- `DATABASE_PATH` — point it at the persistent volume
- `ADMIN_TOKEN` — protects `/admin`; **set this before putting the site on a public URL**
- `SITE_PASSWORD` — optional password over the whole site
- `CRON_SECRET` — for the scheduler, so it never needs the admin token
- `ANTHROPIC_API_KEY` — turns on model-written summaries; without it, summaries are
  extracted from the abstract and every entry says so
- `PERIPHERY_USER_AGENT` — put a contact address in it; several scholarly APIs ask for one

---

## Sources

`npm run seed:sources` installs a starter list: arXiv (four categories), bioRxiv, several
journals, Crossref, PubMed, and a few institutions and serious magazines.

**Verify them on first run.** They were written from knowledge of these publishers' feed
conventions, not fetched — the build environment had no outbound network — so a URL may have
moved. Press **test** beside each source in the editorial desk: a broken source reports its
error there within seconds, is skipped by the pipeline, and costs nothing else. Add your own
at `/admin/sources`; six adapter kinds are available (`rss`, `atom`, `arxiv`, `biorxiv`,
`crossref`, `pubmed`, `json`) and a new one is one function in `fetchers.js`.

Prefer primary sources. Quality tier 1 (peer-reviewed journals, preprint servers, major
institutions) is ranked ahead of tier 3 when two pieces score alike.

---

## The demo content

`npm run seed:demo` loads eleven entries that are labelled demo content in the badge on every
card, in a banner on every article page, and in a source line reading *"Demo entry — not a
real publication"*. No authors, journals, DOIs or URLs are invented anywhere in them: a
plausible-looking citation leading nowhere would be worse than an obvious placeholder, so the
demo entries carry no external source at all and their "source" links land on a page saying
so. `npm run seed:clear` removes the set and any edition left empty by it.

---

## API

Reader actions are open. Anything that changes the library, the profile or the sources needs
`ADMIN_TOKEN` (as `x-admin-token`, a bearer token, or the admin cookie). Pipeline triggers
also accept `CRON_SECRET`.

```
GET    /api/health                     last runs, library counts; 503 if a run failed
POST   /api/ingest                     retrieve from all enabled sources
POST   /api/editions/generate          { kind: daily | long_read, date?, publish? }
POST   /api/pipeline/run               ingest, then whatever today calls for
GET    /api/editions/:kind/latest      the current edition with its items
GET    /api/editions/:kind/:date       a back number
GET    /api/articles                   ?status= &category= &q= &limit= &offset=
GET    /api/articles/:slug
POST   /api/articles                   add one by hand or from an external ingester
PATCH  /api/articles/:id               edit any editorial field
DELETE /api/articles/:id
POST   /api/articles/:id/relevant      mark relevant
DELETE /api/articles/:id/relevant      unmark
POST   /api/articles/:id/tags          { tags: [...] }
GET    /api/research                   saved material; ?q= &category= &concept= &sort=
GET    /api/interests                  profile, terms and the periphery map
POST   /api/interests                  { kind, value, weight?, expires_on? }
PATCH  /api/interests/:id
DELETE /api/interests/:id
PATCH  /api/profile                    statement, periphery appetite, edition sizes
POST   /api/reassess                   re-score the whole library
GET    /api/sources                    list
POST   /api/sources                    add
PATCH  /api/sources/:id                edit or enable/disable
DELETE /api/sources/:id
GET    /api/runs                       ingestion and generation history
```

Every write that touches the profile re-assesses the library and reports how many items
changed.

---

## Tests

```bash
npm test                       # 14 pipeline tests against local fixture feeds
node tests/screenshots.js      # walks the flows in a real browser, saves screenshots
                               # (needs playwright installed; not a dependency of the app)
```

The pipeline suite runs the whole chain against fixture feeds served from localhost, using
its own database file: retrieval through all three adapter shapes, deduplication, preprint
labelling, classification, the avoid-list veto, the periphery bridge firing and un-firing as
the map is edited, the reserved periphery slots, the category cap, edition generation, and a
broken source failing without taking down the run.

The browser walk checks the front page, both editions, an article, marking something
relevant, My Research, the profile editor and the editorial desk at desktop, tablet and phone
widths, and asserts that no page scrolls sideways at 360px.

---

## Editorial commitments

These are enforced in the code, not just intended:

- **Nothing is fabricated.** Papers, findings, authors, citations and URLs come from the
  retrieved source or are absent. The summariser is instructed to return `null` rather than
  fill a gap, and the extractive fallback can only use the source's own sentences.
- **Preprint status is always visible** — on the card, in the edition, on the article page and
  in the provenance block.
- **Uncertainty is preserved.** Every entry carries an evidence assessment that names the
  design and its limits, and the brief separates finding from interpretation from speculation.
- **The original is the reading.** Metadata, a summary and a link — never a reproduction.
  Every entry names its source and points at it.
- **You are told how the summary was made** — model, extractive, or edited by hand.
- **Your interests are data, not code.** Nothing in `src/` names a subject you care about.
