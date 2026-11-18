// Scraper benchmark: the ORIGINAL v3.0.2 code (from the first commit) vs v2,
// in real Chromium, on pages built like LinkedIn's 2026 profile page.
//
//   node scripts/bench-scraper.mjs            → prints a table
//   node scripts/bench-scraper.mjs --write    → also writes docs/benchmark.md
//
// Two situations:
//   fresh visit  - you open a profile and click the extension right away;
//                  Experience, Education and Skills have not loaded yet
//   scrolled     - you scrolled the whole page yourself first
import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profilePage } from '../test/fixtures/linkedin-2026.js';
import { PROFILES, truth } from '../test/fixtures/profiles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V3_SOURCE = execSync('git show f8f21ec:content_script.js', { cwd: ROOT, encoding: 'utf8' });
const V2_SOURCE = fs.readFileSync(path.join(ROOT, 'extension', 'scraper.js'), 'utf8');

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const same = (a, b) => norm(a) === norm(b);

function score(r, t) {
  const jobs = t.jobs.filter((j, i) => r.jobs[i] && same(r.jobs[i].title, j.title) && same(r.jobs[i].company, j.company)).length / t.jobs.length;
  const schools = t.schools.filter(s => r.schools.some(x => norm(x).startsWith(norm(s)))).length / t.schools.length;
  const got = new Set(r.skills.map(norm));
  const want = new Set(t.skills.map(norm));
  const hit = [...want].filter(s => got.has(s)).length;
  const skills = got.size + want.size === 0 ? 1 : (2 * hit) / (got.size + want.size); // F1
  const posts = t.posts.length === 0 ? (r.posts.length === 0 ? 1 : 0) : t.posts.filter(p => r.posts.some(x => same(x, p))).length / t.posts.length;
  return {
    Name: same(r.name, t.name) ? 1 : 0,
    Headline: same(r.headline, t.headline) ? 1 : 0,
    Location: same(r.location, t.location) ? 1 : 0,
    About: t.about ? (same(r.about, t.about) ? 1 : 0) : (r.about ? 0 : 1),
    'Jobs (title + company)': jobs,
    Schools: schools,
    'Skills (F1)': skills,
    Posts: posts,
  };
}

const shape = (d) => ({
  name: d.name, headline: d.headline, location: d.location, about: d.about,
  jobs: d.experienceEntries || [], schools: d.educationEntries || [], skills: d.skills || [], posts: d.recentPosts || [],
});

async function runV3(page) {
  await page.evaluate(() => {
    window.chrome = { runtime: { onMessage: { addListener(fn) { window.__v3 = fn; } } } };
  });
  await page.addScriptTag({ content: V3_SOURCE });
  const res = await page.evaluate(() => new Promise(resolve => window.__v3({ action: 'scrapeProfile' }, {}, resolve)));
  return shape(res.data);
}

async function runV2(page) {
  await page.addScriptTag({ content: V2_SOURCE });
  const data = await page.evaluate(async () => {
    await LinkedInScraper.loadLazySections(document);
    return LinkedInScraper.scrape(document);
  });
  return shape(data);
}

async function measure(browser, lazy) {
  const totals = { v3: [], v2: [] };
  for (const p of PROFILES) {
    const url = `https://www.linkedin.com/in/${p.slug}/`;
    const html = profilePage(p, { owner: !!p.owner, lazy });
    for (const version of ['v3', 'v2']) {
      const page = await browser.newPage({ viewport: { width: 1366, height: 850 } });
      await page.route(url, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
      await page.goto(url);
      if (!lazy) { // "scrolled": load every section first, like a user who scrolled down
        await page.evaluate(async () => {
          const main = document.querySelector('main');
          for (let i = 0; i < 20; i++) { main.scrollTop += 800; await new Promise(r => setTimeout(r, 50)); }
          main.scrollTop = 0;
        });
      }
      const result = version === 'v3' ? await runV3(page) : await runV2(page);
      totals[version].push(score(result, truth(p)));
      await page.close();
    }
  }
  const fields = Object.keys(totals.v3[0]);
  const avg = (rows, f) => Math.round((100 * rows.reduce((s, r) => s + r[f], 0)) / rows.length);
  const rows = fields.map(f => ({ field: f, v3: avg(totals.v3, f), v2: avg(totals.v2, f) }));
  rows.push({ field: 'Overall', v3: Math.round(rows.reduce((s, r) => s + r.v3, 0) / rows.length), v2: Math.round(rows.reduce((s, r) => s + r.v2, 0) / rows.length) });
  return rows;
}

const browser = await chromium.launch();
const fresh = await measure(browser, true);
const scrolled = await measure(browser, false);
await browser.close();

const table = (rows) => ['| Field | v3.0.2 | v2 |', '|---|---:|---:|', ...rows.map(r => `| ${r.field === 'Overall' ? '**Overall**' : r.field} | ${r.v3}% | ${r.v2}% |`)].join('\n');
const report = `# Scraper benchmark

The original v3.0.2 scraper (commit \`f8f21ec\`, run unchanged) against scraper v2, in real Chromium,
on ${PROFILES.length} made-up profiles built with the structure of LinkedIn's 2026 profile page
(see \`test/fixtures/\`). Run it yourself: \`npm run bench\`.

## Fresh visit (you open a profile and click the extension right away)

${table(fresh)}

## After you scrolled the whole page yourself

${table(scrolled)}

## Why v3 scores so low

- The page scrolls inside \`<main>\`, so v3's \`window.scrollTo\` does nothing: on a fresh visit,
  Experience, Education and Skills never load.
- There is no \`<h1>\`: v3 takes the name from the page title, notification count included
  ("(3) Aoife Murphy"), and finds no headline or location.
- About is one span with \`<br>\` line breaks, which v3 skips; v3 reads the "used at…" lines
  under each skill as skills; and in Activity it reads the author's headline as a post.

The same failures were confirmed on live LinkedIn profiles (Nov 2026). Those results are
described in the write-up; no real profile data is stored in this repo.
`;

console.log(`\nFresh visit\n${table(fresh)}\n\nAfter scrolling\n${table(scrolled)}\n`);
if (process.argv.includes('--write')) {
  fs.writeFileSync(path.join(ROOT, 'docs', 'benchmark.md'), report);
  console.log('Wrote docs/benchmark.md');
}
