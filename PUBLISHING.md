# Putting PERIPHERY online — free, public, readable without a login

This is the MVP: the magazine, live at a URL anyone can open. No saving, no
research profile editor, no editorial desk on the public site — those stay in the
app you run yourself, if and when you want them.

## What it looks like when it works

- A permanent URL — `https://<your-github-name>.github.io/periphery`
- Updated **every morning at 07:15 Stockholm time**, whether or not your computer
  is switched on
- Robert opens the link. No account, no login, nothing to install
- Total cost: nothing. GitHub Actions minutes are unlimited on a public
  repository, and a run uses about three of them

## What is already built and tested

| Piece | State |
|---|---|
| `scripts/build-static.js` | Renders the whole magazine to plain HTML. 61 pages from the demo set; verified no save flag, admin link or profile form survives into the build |
| `.github/workflows/publish.yml` | The daily job: ingest → build the edition → render → commit → publish |
| `scripts/ci.js` | Injects the research profile from a secret before the run, wipes it before the commit |
| `scripts/ci-report.js` | Writes a summary on each run saying which sources answered and which did not |

## The four things that need a GitHub account

Nothing here needs you to type a command. Told to go ahead, these are done for you.

1. **Create the repository.** Public, so Pages is free. It holds the code, the
   built magazine and the library database.
2. **Set two secrets.**
   - `PERIPHERY_PROFILE` — your research profile as JSON. Generated with
     `npm run profile:export`; it is *not* committed to the repository.
   - `ANTHROPIC_API_KEY` — optional. With it, entries are written by a model
     under a strict brief. Without it they are extracted from the abstract, and
     every entry says which it was.
3. **Turn on Pages**, source: GitHub Actions.
4. **Run the workflow once by hand** and read the summary it produces.

## Why that first run matters more than it sounds

Twenty-one sources are configured and **not one has ever been fetched** — neither
sandbox I have worked in can reach the open web. The URLs are written from how
these publishers structure their feeds, which is an educated guess, not a check.

GitHub's machines have open internet. So the first run is the moment the whole
thing gets tested for real, and its summary page lists exactly which sources
answered and which did not, with the error for each. Correcting those is a
half-hour of small edits, and after that the site has actual papers on it.

Expect some of the twenty-one to be wrong. That is the design working, not
failing: a bad source is skipped, logged and replaced.

## About privacy

The repository is public, because private repositories cannot use Pages for free.

Your research statement and your interest list are kept out of it — they live in
an encrypted repository secret and are wiped from the database before each
commit. But be clear-eyed about the limit of that: the magazine shows, on every
entry, *why* it was selected — "sits directly on closure and biological
regulation". Anyone reading the site can infer parts of what it is looking for.

That is inherent to the design, not a leak. If the reasoning needs to be private
too, the site cannot be public, and the honest answer is to run it at home.

## What is deliberately not here

**Saving.** The flag, My Research and the concept map need somewhere that accepts
writes, and a static site has nowhere. Three routes when you want it:

1. Keep saving private — run the full app at home, flag things there. Free, works
   today, nothing to build.
2. A small free write-service (Cloudflare Workers + D1, genuinely free, no card).
   Then the flag works from anywhere including your phone. This is a real build:
   the storage layer gets rewritten.
3. Your own machine published through a tunnel. Everything works, but only while
   the machine is on.

Also worth knowing before choosing: **there are no user accounts.** If saving
worked on a public site as it stands, your flags and Robert's would land in the
same pile.

## One known dependency

The database driver (`better-sqlite3`) is a native module. It normally installs a
prebuilt binary in seconds; if it cannot download one it tries to compile from
source, which needs `nodejs.org` to be reachable.

GitHub Actions runners have that, so the daily job installs cleanly. The
restricted sandbox on your own machine does **not** — `nodejs.org` is blocked
there — which is why the local install attempt failed. A normal Node install on
Windows, in an ordinary terminal, has no such restriction and works.

## Running it locally as well

The static site and the full application are the same database. Nothing stops you
running the real thing on this machine — `npm install`, `npm start` — and having
the public site update in parallel from GitHub.

```
npm install
npm run seed          # sources, a starting profile, the labelled demo set
npm start             # http://localhost:3000 — the full app, saving included
npm run build:static  # render the public half into docs/
```
