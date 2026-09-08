#!/usr/bin/env node
/**
 * Pipeline command line — the surface an external scheduler calls.
 *
 *   node src/pipeline/run.js ingest      # retrieve from all enabled sources
 *   node src/pipeline/run.js daily       # ingest, then build The Daily Observatory
 *   node src/pipeline/run.js longread    # ingest, then build The Long Read
 *   node src/pipeline/run.js auto        # do whatever today calls for
 *
 * Exit code 0 on success, 1 on failure, so cron / CI / a healthcheck can tell.
 */
import { migrate } from '../db/index.js';
import { runIngestion } from './ingest.js';
import { generateEdition, isLongReadDay, longReadFlavour } from './edition.js';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function main() {
  const cmd = process.argv[2] || 'auto';
  const trigger = process.env.PERIPHERY_TRIGGER || 'cron';
  migrate();

  const skipIngest = process.argv.includes('--no-ingest');

  if (cmd === 'ingest' || (!skipIngest && ['daily', 'longread', 'long_read', 'auto'].includes(cmd))) {
    const r = await runIngestion({ trigger, log });
    log(`ingestion ${r.status}: ${r.added} new, ${r.dupes} duplicates, from ${r.sourcesOk}/${r.sources} sources`);
    if (cmd === 'ingest') return 0;
  }

  const today = new Date();
  const jobs = [];
  if (cmd === 'daily') jobs.push('daily');
  else if (cmd === 'longread' || cmd === 'long_read') jobs.push('long_read');
  else if (cmd === 'auto') {
    jobs.push('daily');
    if (isLongReadDay(today)) jobs.push('long_read');
  } else {
    console.error(`Unknown command "${cmd}". Use ingest | daily | longread | auto.`);
    return 1;
  }

  let failed = 0;
  for (const kind of jobs) {
    const r = await generateEdition(kind, { trigger, log });
    if (r.ok) {
      log(`${kind} edition ${r.date}: ${r.selected} items`
        + (kind === 'long_read' ? ` (${longReadFlavour(today)} selection)` : ''));
    } else {
      log(`${kind} edition not generated: ${r.reason}`);
      failed++;
    }
  }
  return failed ? 1 : 0;
}

main()
  .then(code => process.exit(code))
  .catch(err => { console.error(err); process.exit(1); });
