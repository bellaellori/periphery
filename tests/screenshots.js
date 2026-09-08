/**
 * Walks the main user flows in a real browser and saves screenshots.
 *   node tests/screenshots.js [baseUrl] [outDir]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = process.argv[3] || '/tmp/shots';
fs.mkdirSync(OUT, { recursive: true });

const PAGES = [
  ['front', '/'],
  ['daily', '/daily'],
  ['long-read', '/long-read'],
  ['research', '/research'],
  ['profile', '/profile'],
  ['archive', '/archive'],
  ['about', '/about'],
  ['admin', '/admin']
];

const browser = await chromium.launch();

async function shoot(label, viewport, deviceScaleFactor = 2) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  for (const [name, path] of PAGES) {
    const res = await page.goto(BASE + path, { waitUntil: 'networkidle' });
    if (res.status() >= 400) console.log(`  ! ${path} → ${res.status()}`);
    await page.screenshot({ path: `${OUT}/${label}-${name}.png`, fullPage: true });
  }

  // Article page: follow the first headline on the front page.
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.locator('.lead__title a').first().click();
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${OUT}/${label}-article.png`, fullPage: true });

  // Mark it relevant, confirm the button flips without a reload.
  const btn = page.locator('.flagbtn').first();
  const before = (await btn.textContent()).trim();
  await btn.click();
  await page.waitForTimeout(400);
  const after = (await btn.textContent()).trim();
  console.log(`  relevance toggle (${label}): "${before}" → "${after}"`);
  if (before === after) console.log('  ! relevance button did not change state');
  await page.screenshot({ path: `${OUT}/${label}-article-saved.png`, fullPage: true });

  // ...and that it landed in My Research.
  await page.goto(BASE + '/research', { waitUntil: 'networkidle' });
  const n = await page.locator('.saved').count();
  console.log(`  My Research shows ${n} saved ${n === 1 ? 'piece' : 'pieces'} (${label})`);
  await page.screenshot({ path: `${OUT}/${label}-research-saved.png`, fullPage: true });

  // Put it back.
  const saved = page.locator('.flagbtn.is-saved').first();
  if (await saved.count()) { await saved.click(); await page.waitForTimeout(400); }

  if (errors.length) console.log(`  ! console errors (${label}):`, [...new Set(errors)].slice(0, 5));
  else console.log(`  no console errors (${label})`);
  await ctx.close();
}

console.log('desktop 1440×900');
await shoot('desktop', { width: 1440, height: 900 });
console.log('mobile 390×844');
await shoot('mobile', { width: 390, height: 844 }, 3);
console.log('tablet 834×1112');
await shoot('tablet', { width: 834, height: 1112 });

// Horizontal-overflow check: a publication must never scroll sideways.
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 } });
const page = await ctx.newPage();
for (const [name, path] of PAGES) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  const over = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 1) console.log(`  ! ${name} overflows by ${over}px at 360w`);
}
console.log('overflow check done');

await browser.close();
console.log(`screenshots in ${OUT}`);
