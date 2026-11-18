// Takes screenshots of the real side panel in Chromium, at side-panel size.
// LinkedIn and Ark's server are local fakes, so this needs no account or key.
//   node scripts/screenshots.mjs [outDir]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'screenshots'));
const SERVER = 'https://linkedin-extention-production.up.railway.app';
const PROFILE_URL = 'https://www.linkedin.com/in/aoife-test/';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Aoife Murphy | LinkedIn</title></head><body><main>
  <section><h1>Aoife Murphy</h1><p>Senior Data Scientist at Spotify | ML for recommendations</p><p>Dublin, County Dublin, Ireland</p></section>
  <section><h2>Experience</h2>
    <p>Senior Data Scientist</p><p>Spotify · Full-time</p><p>Jan 2022 - Present · 2 yrs</p><p>Dublin, Ireland</p>
    <p>Data Scientist</p><p>Accenture · Full-time</p><p>2018 - 2021 · 3 yrs</p><p>Dublin, Ireland</p>
  </section>
  <section><h2>Education</h2><p>Trinity College Dublin</p><p>MSc Computer Science</p><p>2016 - 2017</p></section>
</main></body></html>`;

// Your own profile (Settings → "Use the profile I'm on"), for common ground.
const ME = {
  name: 'Rahul Sharma', location: 'Dublin, County Dublin, Ireland', currentCompany: 'Accenture',
  pastCompanies: [], educationEntries: ['Trinity College Dublin — MSc Data Science'], skills: [], importedAt: Date.now(),
};

// Example text only, so the screenshots have something realistic in them.
const QUICK_MSG = 'Hi Aoife, fellow Trinity grad and ex-Accenture here. I recently finished my MSc in Data Science and I am exploring data science roles. I loved your PyData Dublin talk on recommenders at Spotify. Would you be open to a 15-minute chat about your path? Thank you, Rahul';
const DEEP_MSG = 'Hi Aoife, congratulations on Spotify\'s new Dublin ML hub. I recently finished my MSc in Data Analytics at UCD and loved your PyData Dublin talk on recommendation systems. Would you be open to a short chat about your team? Best, Rahul';

fs.mkdirSync(OUT, { recursive: true });

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  viewport: { width: 400, height: 860 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
await context.route(PROFILE_URL, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }));
await context.route(`${SERVER}/**`, async (route) => {
  const p = new URL(route.request().url()).pathname;
  await new Promise((r) => setTimeout(r, p.includes('enrich') ? 900 : 500));
  const answers = {
    '/api/validate': { valid: true, remaining: 20 },
    '/api/generate/quick': { success: true, message: QUICK_MSG },
    '/api/generate/enrich': {
      success: true,
      profileJSON: { name: 'Aoife Murphy', headline: 'Senior Data Scientist at Spotify', currentCompany: 'Spotify' },
      enrichmentJSON: { topHooks: ['Spotify opened a new ML hub in Dublin this year', 'She spoke at PyData Dublin on recommendation systems', 'Both studied in Dublin'] },
    },
    '/api/generate/deep': { success: true, message: DEEP_MSG, remaining: 19 },
  };
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answers[p] || {}) });
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
const extensionId = new URL(sw.url()).host;

const panel = await context.newPage();
await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
await panel.evaluate((me) => chrome.storage.local.set({ licenseKey: 'ARK-DEMO-0000-0000', userName: 'Rahul', myProfile: me }), ME);
await panel.reload();
await panel.screenshot({ path: path.join(OUT, 'panel-1-no-profile.png') });

const linkedin = await context.newPage();
await linkedin.goto(PROFILE_URL);
await panel.locator('#profile-name').filter({ hasText: 'Aoife Murphy' }).waitFor();
await panel.screenshot({ path: path.join(OUT, 'panel-2-on-profile.png') });

await panel.click('#generate-btn');
await panel.locator('#close-hint').waitFor({ state: 'visible' });
await panel.screenshot({ path: path.join(OUT, 'panel-3-working.png') });
await panel.locator('#message-section').waitFor({ state: 'visible' });
// The panel scrolls inside itself, so use a tall window to show everything.
await panel.setViewportSize({ width: 400, height: 1500 });
await panel.screenshot({ path: path.join(OUT, 'panel-4-quick-done.png') });
await panel.setViewportSize({ width: 400, height: 860 });

await panel.click('#mode-deep');
await panel.click('#generate-btn');
await panel.locator('#step-enriching .status-dot.running').waitFor();
await panel.screenshot({ path: path.join(OUT, 'panel-5-deep-working.png') });
await panel.locator('#hooks-panel').waitFor({ state: 'visible' });
await panel.locator('#generate-label', { hasText: 'Generate message' }).waitFor();
await panel.setViewportSize({ width: 400, height: 1500 });
await panel.screenshot({ path: path.join(OUT, 'panel-6-deep-done.png') });

await context.close();
console.log(`Saved screenshots to ${OUT}`);
