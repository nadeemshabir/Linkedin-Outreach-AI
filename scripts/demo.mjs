// Opens the real extension in a Chromium window, ready to try or to record a
// demo, with no LinkedIn account and no license key:
//   - LinkedIn is a local test page that copies the structure of LinkedIn's
//     2026 profile page, with made-up people (test/fixtures/)
//   - Ark's server is a local fake with example answers
//   - every other site is blocked, so nothing leaves the machine
//
//   npm run demo
//
// Two profiles open: Aoife Murphy (not connected: Connect → Add a note) and
// Seán O'Brien (connected: Message). Click the extension's toolbar icon to
// open the side panel. Close the window to stop.
// (On WSL this needs WSLg, which Windows 11 has. Or run it from Windows.)
import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profilePage } from '../test/fixtures/linkedin-2026.js';
import { PROFILES } from '../test/fixtures/profiles.js';
import { dialogsScript } from '../test/fixtures/linkedin-dialogs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const SERVER = 'https://linkedin-extention-production.up.railway.app';
const PEOPLE = ['Aoife Murphy', "Seán O'Brien"].map((name) => PROFILES.find((p) => p.name === name));
const urlOf = (p) => `https://www.linkedin.com/in/${p.slug}/`;

// You, for common ground (made up): studied at Trinity, worked at Accenture.
const ME = {
  name: 'Rahul Sharma', location: 'Dublin, County Dublin, Ireland', currentCompany: 'Accenture',
  pastCompanies: [], educationEntries: ['Trinity College Dublin — MSc Data Science'], skills: [], importedAt: Date.now(),
};

// Example answers. The note is too long on purpose, to show "Fit to 200".
function quickAnswer(body) {
  const first = String(body.profileData.name || 'there').split(' ')[0];
  const channel = body.profileData.outreachContext && body.profileData.outreachContext.channel;
  if (channel === 'message') {
    return `Hi ${first}, thanks for connecting! I am finishing my MSc in Data Science in Dublin and I am exploring analytics roles. Could I ask you two quick questions about how your team hires graduates?`;
  }
  return `Hi ${first}, fellow Trinity grad and ex-Accenture here. I recently finished my MSc in Data Science and I am exploring data science roles. I loved your PyData Dublin talk on recommenders at Spotify. Would you be open to a 15-minute chat about your path? Thank you, Rahul`;
}

// DEMO_SMOKE=1: start without a window, check the setup works, then stop.
const SMOKE = process.env.DEMO_SMOKE === '1';

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: SMOKE,
  viewport: null,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--window-size=1440,900'],
});
await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
for (const p of PEOPLE) {
  await context.route(urlOf(p), (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8', body: profilePage(p).replace('</body>', `${dialogsScript}</body>`),
  }));
}
await context.route(`${SERVER}/**`, async (route) => {
  const p = new URL(route.request().url()).pathname;
  const body = route.request().postDataJSON() || {};
  await new Promise((r) => setTimeout(r, { '/api/generate/enrich': 2500, '/api/generate/deep': 1500, '/api/generate/quick': 1200 }[p] || 300));
  const answers = {
    '/api/validate': { valid: true, remaining: 20 },
    '/api/generate/quick': () => ({ success: true, message: quickAnswer(body), remaining: 19 }),
    '/api/generate/enrich': {
      success: true,
      profileJSON: { name: 'Aoife Murphy', headline: 'Senior Data Scientist at Spotify', currentCompany: 'Spotify' },
      enrichmentJSON: { topHooks: ['Spotify opened a new ML hub in Dublin this year', 'She spoke at PyData Dublin on recommendation systems'] },
    },
    '/api/generate/deep': { success: true, message: "Hi Aoife, congratulations on Spotify's new Dublin ML hub. I loved your PyData Dublin talk on recommendation systems. Would you be open to a short chat about your team?", remaining: 18 },
  };
  const answer = typeof answers[p] === 'function' ? answers[p]() : answers[p];
  await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', body: JSON.stringify(answer || {}) });
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
await sw.evaluate((me) => chrome.storage.local.set({ licenseKey: 'ARK-DEMO-0000-0000', userName: 'Rahul', myProfile: me }), ME);

const [first] = context.pages();
await first.goto(urlOf(PEOPLE[0]));
const second = await context.newPage();
await second.goto(urlOf(PEOPLE[1]));
await first.bringToFront();

if (SMOKE) {
  const peek = await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.tabs.sendMessage(tab.id, { action: 'peekProfile' });
  }, urlOf(PEOPLE[0]));
  const key = await sw.evaluate(() => chrome.storage.local.get('licenseKey'));
  console.log('smoke:', JSON.stringify({ name: peek.data.name, relationship: peek.data.relationship, key: key.licenseKey }));
  await context.close();
} else {
  console.log('Demo is open. Click the extension icon for the side panel. Close the window to stop.');
  await new Promise((resolve) => context.on('close', resolve));
}
