// Opens the real extension in a Chromium window, ready to try or to record a
// demo, with no LinkedIn account and no API key:
//   - LinkedIn is a local test page that copies the structure of LinkedIn's
//     2026 profile page, with made-up people (test/fixtures/)
//   - messages are written in Free Mode: the extension's own template, on
//     this machine. What you see is the real output; nothing is faked.
//   - every other site is blocked, so nothing leaves the machine
//
//   npm run demo              Free Mode (no key)
//   npm run demo -- --ai      AI Mode with a FAKE Claude: a made-up demo key
//                             and example answers written in this file. It
//                             shows how AI Mode looks (the badge, "Written by
//                             Claude", Fit to 200), not what Claude writes.
//                             Nothing is sent to Anthropic.
//
// Two profiles open: Aoife Murphy (not connected: Connect → Add a note) and
// Seán O'Brien (connected: Message). Click the extension's toolbar icon to
// open the side panel. Close the window to stop.
// (On WSL this needs WSLg, which Windows 11 has. Or run it from Windows.)
//
// DEMO_SMOKE=1: start without a window, write one note through the real side
// panel to check the setup works, print it, then stop. Add --ai to check AI
// Mode (with the fake Claude) the same way.
import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profilePage } from '../test/fixtures/linkedin-2026.js';
import { PROFILES } from '../test/fixtures/profiles.js';
import { dialogsScript } from '../test/fixtures/linkedin-dialogs.js';
import { openSidePanel } from '../test/e2e/side-panel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const AI = process.argv.includes('--ai');
const SMOKE = process.env.DEMO_SMOKE === '1';
const PEOPLE = ['Aoife Murphy', "Seán O'Brien"].map((name) => PROFILES.find((p) => p.name === name));
const urlOf = (p) => `https://www.linkedin.com/in/${p.slug}/`;

// You, for common ground (made up): studied at Trinity, works at Accenture.
const ME = {
  name: 'Rahul Sharma', location: 'Dublin, County Dublin, Ireland', currentCompany: 'Accenture',
  pastCompanies: [], educationEntries: ['Trinity College Dublin — MSc Data Science'], skills: [], importedAt: Date.now(),
};

// ── --ai only: a FAKE Claude ────────────────────────────────────────────────
// These answers are example text written here, NOT by Claude, and the key is
// made up. The fake answers only this key; any other key gets Anthropic's
// "invalid x-api-key" answer, so Settings → Test can show "Key not working".
const DEMO_KEY = 'sk-ant-demo-0000';
const FAKE_ANSWERS = {
  // Too long on purpose (about 270 characters), to show "Fit to 200".
  'note:Aoife': 'Hi Aoife, I am a fellow Trinity graduate, now working at Accenture, where you started. I am moving into data science, and I enjoyed your post about open-sourcing your evaluation toolkit for ranking models. Would you be open to a 15-minute chat about your path? Thank you, Rahul',
  'message:Seán': 'Hi Seán,\n\nThanks for connecting! I am finishing my MSc in Data Science in Dublin, and I am looking at analytics roles.\n\nCould I ask you two quick questions about how Workday hires graduates?\n\nBest,\nRahul',
};

function fakeAnswer(prompt) {
  if (/Reply with the single word: OK/.test(prompt)) return 'OK'; // Settings → Test
  const first = ((prompt.match(/"name":\s*"([^"]+)"/) || [])[1] || 'there').split(' ')[0];
  const channel = /connection note/.test(prompt) ? 'note' : 'message';
  return FAKE_ANSWERS[`${channel}:${first}`] || `Hi ${first}, I would love to hear how you got into your role. Would you be open to a short chat?`;
}

function promptOf(body) {
  const content = (body.messages || []).at(-1)?.content;
  return typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

async function fakeClaude(route) {
  const req = route.request();
  const body = req.postDataJSON() || {};
  if ((await req.headerValue('x-api-key')) !== DEMO_KEY) {
    const error = { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } };
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify(error) });
    return;
  }
  const text = fakeAnswer(promptOf(body));
  await new Promise((r) => setTimeout(r, text === 'OK' ? 300 : 1500)); // feels like a real call
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'msg_demo', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  });
}

// ── Start ───────────────────────────────────────────────────────────────────
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
if (AI) await context.route('https://api.anthropic.com/v1/messages', fakeClaude);

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
const settings = { userName: 'Rahul', myProfile: ME };
if (AI) settings.userApiKey = DEMO_KEY;
await sw.evaluate((s) => chrome.storage.local.set(s), settings);

const [first] = context.pages();
await first.goto(urlOf(PEOPLE[0]));
const second = await context.newPage();
await second.goto(urlOf(PEOPLE[1]));
await first.bringToFront();

if (SMOKE) {
  // Write a note for Aoife in Chrome's real side panel, as a user would. (The
  // background does not take Generate from a copy of the panel in a tab.)
  const peek = await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.tabs.sendMessage(tab.id, { action: 'peekProfile' });
  }, urlOf(PEOPLE[0]));
  const panel = await openSidePanel(context);
  await panel.waitFor(() => document.querySelector('#profile-name').textContent === 'Aoife Murphy');
  await panel.click('#generate-btn');
  await panel.waitFor(() => !!document.querySelector('#status-message.status-success, #status-message.status-error'));
  const status = await panel.text('#status-message');
  const note = await panel.value('#generated-message');
  console.log('smoke:', JSON.stringify({
    name: peek.data.name,
    relationship: peek.data.relationship,
    mode: await panel.text('#key-status'),
    status,
    length: note.length,
    note,
  }));
  await context.close();
  const expected = AI ? 'Message ready. Written by Claude.' : 'Message ready. Written in Free Mode.';
  if (status !== expected || !note.startsWith('Hi Aoife')) {
    console.error(`smoke: FAILED. Expected "${expected}" and a note to Aoife.`);
    process.exit(1);
  }
} else {
  console.log(AI
    ? 'Demo is open in AI Mode with a FAKE Claude: its answers are example text from scripts/demo.mjs, not from Anthropic, and nothing is sent to Anthropic.'
    : 'Demo is open in Free Mode: messages come from the extension\'s own template, on this machine.');
  console.log('Click the extension icon for the side panel. Close the window to stop.');
  await new Promise((resolve) => context.on('close', resolve));
}
