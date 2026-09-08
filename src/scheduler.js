/**
 * Optional in-process scheduler.
 *
 * The pipeline is designed to be driven from OUTSIDE the app — a cron entry, a
 * platform scheduled job, or an HTTP call from a service like GitHub Actions or
 * cron-job.org to /api/pipeline/run. That is the recommended arrangement and it
 * is the one documented in the README.
 *
 * This exists for hosts that offer no scheduler at all. Set ENABLE_INTERNAL_SCHEDULER=1
 * and the running process will check once an hour whether today's editions have
 * been built, and build them if not. It is deliberately idempotent: it looks at
 * what exists in the database rather than keeping timers, so a restart, a sleep
 * or a redeploy cannot cause a double run or a missed day.
 */
import { db } from './db/index.js';
import { runIngestion } from './pipeline/ingest.js';
import { generateEdition, isLongReadDay } from './pipeline/edition.js';

const HOUR = 60 * 60 * 1000;

function hasEdition(kind, date) {
  return !!db.prepare('SELECT 1 FROM editions WHERE kind = ? AND edition_date = ?').get(kind, date);
}

async function tick() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const runHour = Number(process.env.DAILY_RUN_HOUR ?? 6); // local hour, 24h
  if (now.getHours() < runHour) return;

  const wanted = ['daily', ...(isLongReadDay(now) ? ['long_read'] : [])]
    .filter(kind => !hasEdition(kind, today));
  if (!wanted.length) return;

  console.log(`[scheduler] building: ${wanted.join(', ')}`);
  try {
    await runIngestion({ trigger: 'cron', log: m => console.log('[ingest]', m) });
    for (const kind of wanted) {
      const r = await generateEdition(kind, { trigger: 'cron', log: m => console.log('[edition]', m) });
      console.log(`[scheduler] ${kind}:`, r.ok ? `${r.selected} items` : r.reason);
    }
  } catch (err) {
    console.error('[scheduler] run failed:', err.message);
  }
}

export function startInternalScheduler() {
  if (process.env.ENABLE_INTERNAL_SCHEDULER !== '1') {
    console.log('internal scheduler off — drive the pipeline from cron or /api/pipeline/run');
    return null;
  }
  console.log('internal scheduler on — hourly check, builds today\'s editions once');
  setTimeout(tick, 30_000).unref?.();
  const t = setInterval(tick, HOUR);
  t.unref?.();
  return t;
}
