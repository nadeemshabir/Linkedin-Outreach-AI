// Takes screenshots of the real extension in Chromium: the side panel (at
// side-panel size) and the "Write with Ark" button inside LinkedIn's note box.
// LinkedIn and Ark's server are local fakes, so this needs no account or key.
// The LinkedIn page is a test page that copies the structure of LinkedIn's
// 2026 profile page, with a made-up person (test/fixtures/).
//   node scripts/screenshots.mjs [outDir]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profilePage } from '../test/fixtures/linkedin-2026.js';
import { PROFILES } from '../test/fixtures/profiles.js';
import { dialogsScript } from '../test/fixtures/linkedin-dialogs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'screenshots'));
const SERVER = 'https://linkedin-extention-production.up.railway.app';
const AOIFE = PROFILES.find((p) => p.name === 'Aoife Murphy');
const PROFILE_URL = `https://www.linkedin.com/in/${AOIFE.slug}/`;
const PAGE = profilePage(AOIFE).replace('</body>', `${dialogsScript}</body>`);

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
await panel.locator('#key-status.active').waitFor(); // "● 20 left today", not "Checking…"
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

// The tracker, with a few people at different stages (example data).
const day = 24 * 60 * 60 * 1000;
const t = Date.now();
const person = (slug, name, headline, status, extra = {}) => ({
  profileKey: `/in/${slug}/`, profileUrl: `https://www.linkedin.com/in/${slug}/`, name, headline,
  message: `Hi ${name.split(' ')[0]}, fellow Trinity grad here. Open to a quick chat about your team?`,
  channel: 'note', messageType: 'Referral', tone: 'Casual', status, createdAt: t - 9 * day, updatedAt: t - day, history: [], ...extra,
});
await panel.evaluate((contacts) => chrome.storage.local.set({ contacts }), {
  [`/in/${AOIFE.slug}/`]: person(AOIFE.slug, 'Aoife Murphy', 'Senior Data Scientist at Spotify', 'connected', { connectedAt: t - day }),
  '/in/liam/':  person('liam', 'Liam Byrne', 'Engineering Manager at Stripe', 'sent', { channel: 'message', sentAt: t - 6 * day }),
  '/in/priya/': person('priya', 'Priya Nair', 'ML Engineer at Zalando', 'replied', { sentAt: t - 8 * day, repliedAt: t - 2 * day }),
  '/in/sean/':  person('sean', "Seán O'Brien", 'Recruiter at Workday', 'replied', { sentAt: t - 7 * day, repliedAt: t - 3 * day }),
  '/in/maria/': person('maria', 'Maria Rossi', 'Data Analyst at Google', 'sent', { sentAt: t - 3 * day }),
});
await panel.setViewportSize({ width: 400, height: 1300 });
await panel.click('#tabbtn-recent');
await panel.locator('#due-list .contact-card').first().waitFor();
await panel.screenshot({ path: path.join(OUT, 'panel-7-tracker.png') });

// "Write with Ark" inside LinkedIn's own note box: Connect → Add a note →
// the button → the note, fitted to 200. (It reuses the panel's draft.)
await linkedin.bringToFront();
await linkedin.setViewportSize({ width: 1000, height: 640 });
await linkedin.getByRole('button', { name: 'Invite Aoife Murphy to connect' }).click();
await linkedin.getByRole('button', { name: 'Add a note', exact: true }).click();
const write = linkedin.getByRole('button', { name: '✨ Write a note to Aoife' });
await write.waitFor();
await linkedin.screenshot({ path: path.join(OUT, 'inpage-1-note-box.png') });
await write.click();
await linkedin.getByRole('status').filter({ hasText: 'press Send' }).waitFor();
await linkedin.screenshot({ path: path.join(OUT, 'inpage-2-note-written.png') });

await context.close();
console.log(`Saved screenshots to ${OUT}`);
