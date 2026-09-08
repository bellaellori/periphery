#!/usr/bin/env node
/**
 * Print what the last run actually did, in Markdown.
 *
 * In GitHub Actions this lands on the run's summary page, so the answer to
 * "did it work, and which sources are broken" is one click from the repository
 * rather than buried in a log.
 */
import { db } from '../src/db/index.js';

const out = [];
const say = s => out.push(s);

const ingestion = db.prepare('SELECT * FROM ingestion_runs ORDER BY id DESC LIMIT 1').get();
const generation = db.prepare(`
  SELECT g.*, e.edition_date FROM generation_runs g
  LEFT JOIN editions e ON e.id = g.edition_id
  ORDER BY g.id DESC LIMIT 2`).all();

if (ingestion) {
  const icon = { ok: '✅', partial: '⚠️', failed: '❌', running: '⏳' }[ingestion.status] || '•';
  say(`## ${icon} Ingestion — ${ingestion.status}`);
  say('');
  say(`**${ingestion.items_new}** new · ${ingestion.items_duplicate} already held · `
    + `**${ingestion.sources_ok} of ${ingestion.sources_tried}** sources answered`);
  say('');
  if (ingestion.log) {
    const lines = ingestion.log.split('\n');
    const bad = lines.filter(l => l.startsWith('✗') || l.startsWith('!'));
    if (bad.length) {
      say('### Sources that did not answer');
      say('');
      say('```');
      bad.forEach(l => say(l));
      say('```');
      say('');
      say('_Each of these is a URL to correct, not a broken pipeline — the run carried on without them._');
      say('');
    }
    const good = lines.filter(l => l.startsWith('✓'));
    if (good.length) {
      say('<details><summary>Sources that answered</summary>');
      say('');
      say('```');
      good.forEach(l => say(l));
      say('```');
      say('</details>');
      say('');
    }
  }
} else {
  say('## Ingestion — did not run');
  say('');
}

for (const g of generation.reverse()) {
  const icon = { ok: '✅', empty: '◦', failed: '❌', running: '⏳' }[g.status] || '•';
  const name = g.kind === 'daily' ? 'The Daily Observatory' : 'The Long Read';
  say(`## ${icon} ${name} — ${g.status}`);
  say('');
  if (g.status === 'ok') {
    say(`**${g.selected}** selected from ${g.candidates} candidates · summaries: \`${g.summariser}\``
      + (g.edition_date ? ` · edition of ${g.edition_date}` : ''));
  } else if (g.status === 'empty') {
    say('Nothing new to publish in the window. Not a failure — the previous edition stands.');
  } else if (g.log) {
    say('```');
    say(g.log.split('\n').slice(-12).join('\n'));
    say('```');
  }
  say('');
}

const counts = db.prepare(`
  SELECT (SELECT count(*) FROM articles WHERE status='published') AS published,
         (SELECT count(*) FROM articles) AS held,
         (SELECT count(*) FROM editions WHERE status='published') AS editions,
         (SELECT count(*) FROM articles WHERE is_periphery_pick=1) AS periphery`).get();

say(`---`);
say('');
say(`Library: **${counts.published}** published of ${counts.held} held · `
  + `${counts.editions} editions · ${counts.periphery} found through the periphery`);

console.log(out.join('\n'));
