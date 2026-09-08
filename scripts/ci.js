#!/usr/bin/env node
/**
 * The two steps that top and tail an automated run.
 *
 *   node scripts/ci.js prepare   before the pipeline
 *   node scripts/ci.js scrub     before committing state back
 *   node scripts/ci.js export    print the current profile as JSON
 *
 * WHY THIS EXISTS
 *
 * GitHub Pages is free from a public repository and costs money from a private
 * one. So the repository is public — but the research profile is not something
 * to publish. It lives in a repository *secret* instead, is injected at the
 * start of each run, and is wiped again before the database is committed back.
 *
 * Be aware of the limit of that: the site shows, on each entry, why it was
 * selected — "sits directly on closure and biological regulation". Those lines
 * are public, so a reader can infer parts of the profile from the magazine
 * itself. What stays private is the written statement and the full list.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, migrate } from '../src/db/index.js';

migrate();

const PROFILE_ENV = 'PERIPHERY_PROFILE';

async function prepare() {
  const n = db.prepare('SELECT count(*) n FROM sources').get().n;
  console.log(`${n} source${n === 1 ? '' : 's'} configured`);
  await applyProfile();
}

async function applyProfile() {
  // Two places the profile can come from, in order of preference:
  //   1. the PERIPHERY_PROFILE secret — private, not in the repository
  //   2. profile.json in the repository — public, but nothing to set up
  let raw = process.env[PROFILE_ENV];
  let origin = 'secret';

  if (!raw) {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'profile.json');
    if (fs.existsSync(file)) {
      raw = fs.readFileSync(file, 'utf8');
      origin = 'profile.json';
    }
  }

  if (!raw) {
    const existing = db.prepare('SELECT statement FROM research_profile WHERE id = 1').get();
    if (existing?.statement) {
      console.log('no profile supplied — using the one already in the database');
    } else {
      console.log('no profile anywhere: nothing will score above background and no edition'
        + ' can be built. Set the PERIPHERY_PROFILE secret or commit a profile.json.');
    }
    return;
  }

  let p;
  try {
    p = JSON.parse(raw);
  } catch (err) {
    console.error(`${PROFILE_ENV} is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE research_profile SET statement = ?, periphery_appetite = ?,
      daily_size = ?, longread_size = ?, display_name = ?, updated_at = datetime('now')
      WHERE id = 1`).run(
      p.statement || '',
      Number(p.periphery_appetite ?? 0.35),
      Number(p.daily_size ?? 7),
      Number(p.longread_size ?? 4),
      p.display_name || null
    );

    db.prepare('DELETE FROM research_interests').run();
    const addInterest = db.prepare(
      'INSERT INTO research_interests (kind, value, weight, notes, expires_on) VALUES (?, ?, ?, ?, ?)'
    );
    for (const i of p.interests || []) {
      if (!i?.kind || !i?.value) continue;
      addInterest.run(i.kind, String(i.value), Number(i.weight ?? 1), i.notes ?? null, i.expires_on ?? null);
    }

    db.prepare('DELETE FROM concept_adjacency').run();
    const addBridge = db.prepare(
      'INSERT OR IGNORE INTO concept_adjacency (concept, adjacent, field, strength) VALUES (?, ?, ?, ?)'
    );
    for (const b of p.adjacency || []) {
      const [concept, adjacent, field, strength] = Array.isArray(b)
        ? b : [b.concept, b.adjacent, b.field, b.strength];
      if (!concept || !adjacent) continue;
      addBridge.run(concept, adjacent, field ?? null, Number(strength ?? 0.6));
    }
  });
  tx();

  const counts = {
    interests: db.prepare('SELECT count(*) n FROM research_interests').get().n,
    bridges: db.prepare('SELECT count(*) n FROM concept_adjacency').get().n
  };
  console.log(`profile applied from ${origin}: ${counts.interests} terms, ${counts.bridges} bridges`);
}

/** Remove the profile before the database is committed to a public repository. */
function scrub() {
  const tx = db.transaction(() => {
    db.prepare(`UPDATE research_profile SET statement = '', display_name = NULL WHERE id = 1`).run();
    db.prepare('DELETE FROM research_interests').run();
    db.prepare('DELETE FROM concept_adjacency').run();
  });
  tx();
  // Fold the write-ahead log back into the file itself. Without this, a copy of
  // periphery.db taken on its own can be missing the most recent commits.
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  console.log('profile removed from the database before commit');
}

/** Print the current profile as the JSON to paste into the secret. */
function exportProfile() {
  const p = db.prepare('SELECT * FROM research_profile WHERE id = 1').get();
  console.log(JSON.stringify({
    display_name: p.display_name,
    statement: p.statement,
    periphery_appetite: p.periphery_appetite,
    daily_size: p.daily_size,
    longread_size: p.longread_size,
    interests: db.prepare('SELECT kind, value, weight, notes, expires_on FROM research_interests').all(),
    adjacency: db.prepare('SELECT concept, adjacent, field, strength FROM concept_adjacency').all()
  }, null, 2));
}

const cmd = process.argv[2];
if (cmd === 'prepare') await prepare();
else if (cmd === 'scrub') scrub();
else if (cmd === 'export') exportProfile();
else { console.error('Usage: ci.js prepare | scrub | export'); process.exit(1); }
