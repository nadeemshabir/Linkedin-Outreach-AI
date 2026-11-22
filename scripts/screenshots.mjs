// Takes screenshots of the real extension in Chromium: Chrome's real side
// panel (at side-panel size) and the "Write with Ark" button inside
// LinkedIn's note box. It needs no account and no key: LinkedIn is a local
// test page that copies the structure of LinkedIn's 2026 profile page, with
// a made-up person (test/fixtures/), and every other site is blocked.
//
// Every shot is in Free Mode (no key), with the extension's real template
// output, EXCEPT panel-4-quick-done.png. That one shows AI Mode with a FAKE
// Claude: its answer is example text written in this file (see FAKE_CLAUDE
// below), not Claude's. Nothing is sent to Anthropic.
//   node scripts/screenshots.mjs [outDir]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profilePage } from '../test/fixtures/linkedin-2026.js';
import { PROFILES } from '../test/fixtures/profiles.js';
import { dialogsScript } from '../test/fixtures/linkedin-dialogs.js';
import { openSidePanel } from '../test/e2e/side-panel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'screenshots'));
const AOIFE = PROFILES.find((p) => p.name === 'Aoife Murphy');
const PROFILE_URL = `https://www.linkedin.com/in/${AOIFE.slug}/`;
const JOB_ID = `job:/in/${AOIFE.slug}/`;
// Lazy, like the live site: the lower sections load only as the page
// scrolls, so reading the profile takes a second or two. Long enough to
// show the panel "working", even though Free Mode then writes at once.
const PAGE = profilePage(AOIFE, { lazy: true }).replace('</body>', `${dialogsScript}</body>`);

// Your own profile (Settings → "Use the profile I'm on"), for common ground.
const ME = {
  name: 'Rahul Sharma', location: 'Dublin, County Dublin, Ireland', currentCompany: 'Accenture',
  pastCompanies: [], educationEntries: ['Trinity College Dublin — MSc Data Science'], skills: [], importedAt: Date.now(),
};

// ── panel-4 only: a FAKE Claude ────────────────────────────────────────────
// The one AI Mode shot. The key is made up, and the answer below is example
// text written here, NOT by Claude. It is too long on purpose (about 270
// characters), to show the 200 meter and "Fit to 200".
const FAKE_KEY = 'sk-ant-demo-0000';
const FAKE_CLAUDE = 'Hi Aoife, I am a fellow Trinity graduate, now working at Accenture, where you started. I am moving into data science, and I enjoyed your post about open-sourcing your evaluation toolkit for ranking models. Would you be open to a 15-minute chat about your path? Thank you, Rahul';
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';

async function fakeClaude(route) {
  await new Promise((r) => setTimeout(r, 500));
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'msg_screenshot', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
      content: [{ type: 'text', text: FAKE_CLAUDE }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  });
}

fs.mkdirSync(OUT, { recursive: true });

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  viewport: { width: 400, height: 860 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
await context.route(PROFILE_URL, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }));

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
const setLocal = (items) => sw.evaluate((s) => chrome.storage.local.set(s), items);

// Chrome's real side panel (the background takes Generate only from there,
// not from a copy of the panel in a tab). Each shot is 400 wide at 2x.
await setLocal({ userName: 'Rahul', myProfile: ME });
const panel = await openSidePanel(context);
const size = (height) => ({ width: 400, height, scale: 2 });
const shot = (name, height = 860) => panel.screenshot(path.join(OUT, name), size(height));
// The panel scrolls inside itself, so a tall shot shows everything.
const tallShot = (name, height = 1500) => shot(name, height);
const status = (text) => panel.waitFor((t) => document.querySelector('#status-message').textContent.includes(t), text);

// Press Generate and take the shot while the background reads the profile.
// A run only moves forward, so if it is still reading after the shot, the
// shot shows it reading.
async function generateAndShootReading(name) {
  // Size the panel first. Getting the size right can take a second or more
  // (see SidePanel.resize), and the shot must come while it is still reading.
  await panel.resize(size(860));
  await panel.click('#generate-btn');
  await panel.waitFor(() => !!document.querySelector('#step-reading .status-dot.running'));
  await shot(name);
  const step = await sw.evaluate(async (id) => (await chrome.storage.session.get(id))[id].step, JOB_ID);
  if (step !== 'reading') throw new Error(`${name}: the run was already at "${step}" when the shot was taken. Please run the script again.`);
}

await panel.waitFor(() => document.querySelector('#key-status').textContent.includes('Free Mode'));
await shot('panel-1-no-profile.png');

const linkedin = await context.newPage();
await linkedin.goto(PROFILE_URL);
await panel.waitFor(() => document.querySelector('#profile-name').textContent === 'Aoife Murphy');
await shot('panel-2-on-profile.png');

// Free Mode, Quick.
await generateAndShootReading('panel-3-working.png');
await status('Written in Free Mode.');

// AI Mode with the FAKE Claude (see above), then "New version": a note
// that is too long for 200, with "Fit to 200".
await context.route(ANTHROPIC, fakeClaude);
await setLocal({ userApiKey: FAKE_KEY });
await panel.waitFor(() => document.querySelector('#key-status').textContent.includes('AI Mode'));
await panel.click('#regenerate-btn');
await status('Written by Claude.');
await panel.waitFor(() => document.querySelector('#fit-btn').textContent.includes('Fit to 200'));
await tallShot('panel-4-quick-done.png');
// Back to Free Mode (no key) for everything else.
await sw.evaluate(() => chrome.storage.local.remove(['userApiKey', 'keyStatus']));
await context.unroute(ANTHROPIC, fakeClaude);
await panel.waitFor(() => document.querySelector('#key-status').textContent.includes('Free Mode'));

// Free Mode, Deep. Load the profile again, so reading it scrolls the page
// again (Deep reads the profile fresh).
await linkedin.reload();
await panel.click('#mode-deep');
await generateAndShootReading('panel-5-deep-working.png');
await status('Written in Free Mode.');
await panel.waitFor(() => document.querySelector('#hooks-panel').checkVisibility());
await tallShot('panel-6-deep-done.png');

// The tracker, with a few people at different stages (example data).
const day = 24 * 60 * 60 * 1000;
const t = Date.now();
const person = (slug, name, headline, status, extra = {}) => ({
  profileKey: `/in/${slug}/`, profileUrl: `https://www.linkedin.com/in/${slug}/`, name, headline,
  message: `Hi ${name.split(' ')[0]}, fellow Trinity grad here. Open to a quick chat about your team?`,
  channel: 'note', messageType: 'Referral', tone: 'Casual', status, createdAt: t - 9 * day, updatedAt: t - day, history: [], ...extra,
});
await setLocal({
  contacts: {
    [`/in/${AOIFE.slug}/`]: person(AOIFE.slug, 'Aoife Murphy', 'Senior Data Scientist at Spotify', 'connected', { connectedAt: t - day }),
    '/in/liam/':  person('liam', 'Liam Byrne', 'Engineering Manager at Stripe', 'sent', { channel: 'message', sentAt: t - 6 * day }),
    '/in/priya/': person('priya', 'Priya Nair', 'ML Engineer at Zalando', 'replied', { sentAt: t - 8 * day, repliedAt: t - 2 * day }),
    '/in/sean/':  person('sean', "Seán O'Brien", 'Recruiter at Workday', 'replied', { sentAt: t - 7 * day, repliedAt: t - 3 * day }),
    '/in/maria/': person('maria', 'Maria Rossi', 'Data Analyst at Google', 'sent', { sentAt: t - 3 * day }),
  },
});
await panel.click('#tabbtn-recent');
await panel.waitFor(() => !!document.querySelector('#due-list .contact-card'));
await tallShot('panel-7-tracker.png', 1300);

// Settings, in Free Mode: the optional key box (its "sk-ant-…" hint in lower
// case, as Anthropic keys are), and the resume, which goes to Anthropic only
// if you tick the box.
await panel.click('#tabbtn-settings');
await panel.waitFor(() => document.querySelector('#tab-settings').checkVisibility());
await tallShot('panel-8-settings.png', 1300);

// "Write with Ark" inside LinkedIn's own note box: Connect → Add a note →
// the button → the note. It reuses the panel's Free Mode draft.
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
