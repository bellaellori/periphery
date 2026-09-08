#!/usr/bin/env node
/**
 * Build the reading half of PERIPHERY as plain HTML.
 *
 *   node scripts/build-static.js [outDir] [--base /repo-name]
 *
 * GitHub Pages serves files; it cannot run a program or hold a database. So the
 * magazine — front page, both editions, every article, the archive — is rendered
 * to static pages here, and the parts that need to write something (the save
 * flag, My Research, the profile editor, the editorial desk) are simply absent
 * from the build. Those stay in the running app.
 *
 * The output is self-contained: open outDir/index.html in a browser and it works.
 */
import ejs from 'ejs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db/index.js';
import { fmt } from '../src/lib/format.js';
import { CATEGORY_LABELS } from '../src/pipeline/classify.js';
import { longReadFlavour, longReadLabel } from '../src/pipeline/edition.js';
import {
  latestEdition, editionByDate, editionItems, recentEditions, adjacentEditions,
  getArticleBySlug, publishedArticles, peripheryPicks, articlesForConcept, stats
} from '../src/lib/queries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'src', 'views');

const args = process.argv.slice(2);
const OUT = path.resolve(args.find(a => !a.startsWith('--')) || path.join(ROOT, 'docs'));
const baseArg = args.indexOf('--base');
const BASE = (baseArg !== -1 ? args[baseArg + 1] : (process.env.BASE_PATH || '')).replace(/\/$/, '');

const NAV = [
  { href: '/', label: 'Front page' },
  { href: '/daily', label: 'The Daily Observatory' },
  { href: '/long-read', label: 'The Long Read' },
  { href: '/archive', label: 'Archive' }
];

const COMMON = {
  siteTitle: 'PERIPHERY',
  siteSubtitle: 'Science · Ideas · The World',
  fmt,
  nav: NAV,
  staticMode: true,
  categoryLabels: CATEGORY_LABELS,
  savedCount: 0
};

let written = 0;

/** Root-relative links only work at a domain root; rewrite them for a subpath. */
function applyBase(html) {
  if (!BASE) return html;
  return html.replace(/\b(href|src)="\/(?!\/)/g, `$1="${BASE}/`);
}

async function page(urlPath, view, data) {
  const html = applyBase(await ejs.renderFile(
    path.join(VIEWS, `${view}.ejs`),
    { ...COMMON, path: urlPath, ...data },
    { views: [VIEWS] }
  ));
  const file = urlPath === '/'
    ? path.join(OUT, 'index.html')
    : path.join(OUT, urlPath.replace(/^\//, ''), 'index.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  written++;
  return file;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

async function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // --- the front page -------------------------------------------------------
  const daily = latestEdition('daily');
  const dailyItems = daily ? editionItems(daily.id) : [];
  const longRead = latestEdition('long_read');
  const longReadItems = longRead ? editionItems(longRead.id).slice(0, 3) : [];
  const usedIds = [...dailyItems, ...longReadItems].map(a => a.id);
  const periphery = peripheryPicks(4, usedIds);

  await page('/', 'front', {
    title: 'PERIPHERY',
    daily, dailyItems, longRead, longReadItems, periphery,
    more: publishedArticles({ limit: 6, excludeIds: [...usedIds, ...periphery.map(a => a.id)] }),
    lead: dailyItems.find(i => i.slot === 'lead') || dailyItems[0] || null,
    isLongReadDay: false,
    editions: recentEditions(8)
  });

  // --- every edition, plus a landing page pointing at the newest -------------
  const editions = db.prepare(
    "SELECT * FROM editions WHERE status = 'published' ORDER BY edition_date DESC"
  ).all();

  for (const e of editions) {
    const items = editionItems(e.id);
    if (!items.length) continue;
    const isDaily = e.kind === 'daily';
    const dir = isDaily ? '/daily' : '/long-read';
    const data = {
      title: `${e.title} — ${e.edition_date}`,
      edition: e,
      items,
      lead: items.find(i => i.slot === 'lead') || items[0],
      flavour: isDaily ? null : longReadFlavour(new Date(e.edition_date)),
      flavourLabel: isDaily ? null : longReadLabel(new Date(e.edition_date)),
      neighbours: adjacentEditions(e.kind, e.edition_date)
    };
    const view = isDaily ? 'daily' : 'long-read';
    await page(`${dir}/${e.edition_date}`, view, data);
    // The newest of each kind is also the section's landing page.
    const newest = latestEdition(e.kind);
    if (newest && newest.id === e.id) await page(dir, view, data);
  }

  for (const kind of ['daily', 'long_read']) {
    if (!latestEdition(kind)) {
      await page(kind === 'daily' ? '/daily' : '/long-read', 'empty-edition', {
        title: kind === 'daily' ? 'The Daily Observatory' : 'The Long Read',
        kind, isLongReadDay: false
      });
    }
  }

  // --- every published article ---------------------------------------------
  const articles = db.prepare(
    "SELECT slug FROM articles WHERE status = 'published' ORDER BY published_at DESC"
  ).all();

  for (const { slug } of articles) {
    const article = getArticleBySlug(slug);
    const inEdition = db.prepare(`
      SELECT e.* FROM edition_items ei JOIN editions e ON e.id = ei.edition_id
      WHERE ei.article_id = ? ORDER BY e.edition_date DESC LIMIT 1`).get(article.id);
    const related = db.prepare(`
      SELECT DISTINCT a.id, a.slug, a.title, a.category, a.source_name, a.reading_time_min
      FROM articles a
      JOIN article_tags at ON at.article_id = a.id
      WHERE a.status = 'published' AND a.id != ?
        AND at.tag_id IN (SELECT tag_id FROM article_tags WHERE article_id = ?)
      LIMIT 5`).all(article.id, article.id);
    await page(`/article/${slug}`, 'article', {
      title: article.title, article, inEdition, related, backTo: null
    });
  }

  // --- indexes --------------------------------------------------------------
  await page('/archive', 'archive', {
    title: 'Archive',
    editions: recentEditions(500),
    recent: publishedArticles({ limit: 60 })
  });

  for (const key of Object.keys(CATEGORY_LABELS)) {
    const items = publishedArticles({ category: key, limit: 200 });
    if (!items.length) continue;
    await page(`/category/${key}`, 'category', {
      title: CATEGORY_LABELS[key], key, label: CATEGORY_LABELS[key], items
    });
  }

  for (const tag of db.prepare('SELECT * FROM tags ORDER BY name').all()) {
    const items = articlesForConcept(tag.slug);
    if (!items.length) continue;
    await page(`/concept/${tag.slug}`, 'concept', { title: tag.name, tag, items });
  }

  await page('/about', 'about', { title: 'About PERIPHERY', stats: stats() });

  if (stats().demo) {
    await page('/demo-source', 'demo-source', { title: 'Demo content' });
  }

  // --- 404, assets, Pages housekeeping --------------------------------------
  const notFound = applyBase(await ejs.renderFile(path.join(VIEWS, 'error.ejs'), {
    ...COMMON, path: '/404', title: 'Not found', code: 404,
    message: 'That page is not in this edition.'
  }, { views: [VIEWS] }));
  fs.writeFileSync(path.join(OUT, '404.html'), notFound);
  written++;

  copyDir(path.join(ROOT, 'public'), path.join(OUT, 'static'));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  fs.writeFileSync(path.join(OUT, 'robots.txt'), 'User-agent: *\nAllow: /\n');

  // --- a guard, not a formality --------------------------------------------
  // The static build must not ship anything that pretends to write. If one of
  // these ever appears, a template guard has been missed.
  const leaks = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.html')) continue;
      const html = fs.readFileSync(p, 'utf8');
      for (const bad of ['data-relevance', '/admin', 'action="/profile', '/research"']) {
        if (html.includes(bad)) leaks.push(`${path.relative(OUT, p)} → ${bad}`);
      }
    }
  };
  walk(OUT);
  if (leaks.length) {
    console.error('Interactive markup leaked into the static build:');
    leaks.slice(0, 20).forEach(l => console.error('  ' + l));
    process.exit(1);
  }

  console.log(`${written} pages → ${OUT}${BASE ? ` (base path ${BASE})` : ''}`);
  console.log(`${editions.length} editions, ${articles.length} articles`);
}

build().catch(err => { console.error(err); process.exit(1); });
