// The side panel in real Chromium: the real extension in Chrome's real side
// panel (see side-panel.js for why not a tab), and the real content script,
// on a test page that copies LinkedIn's 2026 profile page (a made-up
// person). Free Mode needs no key and no network. AI Mode talks to a fake of
// Anthropic's Messages API.
import fs from 'node:fs';
import { test, expect, fakeClaude, promptText, API_KEY } from './extension.js';
import { openSidePanel } from './side-panel.js';
import { profilePage } from '../fixtures/linkedin-2026.js';
import { PROFILES } from '../fixtures/profiles.js';

const AOIFE       = PROFILES.find((p) => p.name === 'Aoife Murphy'); // 2nd: Connect
const PROFILE_URL = `https://www.linkedin.com/in/${AOIFE.slug}/`;
const PROFILE_KEY = `/in/${AOIFE.slug}/`;

// What the fake Claude writes in these tests (example text).
const CLAUDE_NOTE = 'Hi Aoife, your post about the evaluation toolkit for ranking models caught my eye. Would you be open to a short chat about your work at Spotify?';

// You (made up). With this bio, the note would be well over 200 characters,
// so Free Mode has to leave parts out to fit.
const SENDER = {
  userName: 'Rahul',
  userBio: 'I am finishing an MSc in Data Science at Trinity College Dublin and I am looking for my first data science role in Ireland.',
};

// A tiny one-page PDF, standing in for your resume.
const RESUME_PDF = Buffer.from(`%PDF-1.4
1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj
2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj
3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 200 200]>> endobj
trailer <</Root 1 0 R>>
%%EOF
`);

async function serveAoife(context) {
  await context.route(PROFILE_URL, (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8', body: profilePage(AOIFE),
  }));
}

// Open Aoife's profile in a new tab. It becomes the active tab, so the panel
// moves to her.
async function openAoife(context, panel) {
  const linkedin = await context.newPage();
  await linkedin.goto(PROFILE_URL);
  await expect.poll(() => panel.text('#profile-name')).toBe('Aoife Murphy');
  return linkedin;
}

const setLocal = (serviceWorker, items) => serviceWorker.evaluate((s) => chrome.storage.local.set(s), items);
const getLocal = (serviceWorker, keys) => serviceWorker.evaluate((k) => chrome.storage.local.get(k), keys);

/** The blocks of the (last) user message Claude got: [{ type: 'text' | 'document', … }]. */
const blocksOf = (call) => call.body.messages[call.body.messages.length - 1].content;

test('clicking the toolbar icon opens the side panel', async ({ serviceWorker }) => {
  const behavior = await serviceWorker.evaluate(() => chrome.sidePanel.getPanelBehavior());
  expect(behavior.openPanelOnActionClick).toBe(true);
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.side_panel.default_path).toBe('sidepanel.html');
  expect(manifest.action.default_popup).toBeUndefined();
});

test('Free Mode, no key: the panel follows you to a profile and writes a note that fits 200, with no network', async ({ context, serviceWorker, blocked }) => {
  await serveAoife(context);
  await setLocal(serviceWorker, SENDER);
  const panel = await openSidePanel(context);
  await expect.poll(() => panel.text('#key-status')).toBe('● Free Mode');
  expect(await panel.visible('#page-warning')).toBe(true); // no profile open yet

  await openAoife(context, panel);
  await expect.poll(() => panel.visible('#page-warning')).toBe(false);

  await panel.click('#generate-btn');
  await expect.poll(() => panel.text('#status-message')).toBe('Message ready. Written in Free Mode.');
  const note = await panel.value('#generated-message');

  // Her first name (the tab title says "(3) Aoife Murphy"; 3.1.0 wrote
  // "Hi (3),"), something the real content script read on her page (her
  // post, or her role when the post does not fit), and a question at the end.
  expect(note).toMatch(/^Hi Aoife, /);
  expect(note).toMatch(/We just open-sourced our evaluation|Senior Data Scientist at Spotify/);
  expect(note).toMatch(/\?$/);
  expect(note.length).toBeLessThanOrEqual(200);
  await expect.poll(() => panel.text('#char-count')).toBe(`${note.length} / 200`);
  expect(await panel.visible('#fit-row')).toBe(false); // nothing to shorten

  // No key: nothing was sent anywhere, and nothing even tried.
  expect(blocked).toEqual([]);
});

test('AI Mode, your own key: Claude writes it, and is asked for a note under the 200 limit', async ({ context, serviceWorker, blocked }) => {
  await serveAoife(context);
  const claude = await fakeClaude(context, () => CLAUDE_NOTE);
  await setLocal(serviceWorker, { userApiKey: API_KEY });
  const panel = await openSidePanel(context);
  await expect.poll(() => panel.text('#key-status')).toBe('● AI Mode');
  await openAoife(context, panel);

  await panel.click('#generate-btn');
  await expect.poll(() => panel.text('#status-message')).toBe('Message ready. Written by Claude.');
  expect(await panel.value('#generated-message')).toBe(CLAUDE_NOTE);

  // One request, straight to Anthropic, with your key. Nothing else was
  // contacted.
  expect(claude.calls).toHaveLength(1);
  expect(blocked).toEqual([]);
  const [call] = claude.calls;
  expect(call).toMatchObject({ method: 'POST', path: '/v1/messages' });
  expect(call.headers).toMatchObject({
    'x-api-key': API_KEY,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  });
  // Thinking off: a short note does not need it, and it would use up max_tokens.
  expect(call.body).toMatchObject({ model: 'claude-haiku-5-5', thinking: { type: 'disabled' } });

  // The prompt gives the real limit for a note (3.1.0 asked for "under 600
  // characters"), and the profile the real content script read.
  const prompt = promptText(call.body);
  expect(prompt).toMatch(/connection note/);
  expect(prompt).toMatch(/under 170 characters/);
  expect(prompt).toMatch(/hard limit is 200/);
  expect(prompt).toContain('"name": "Aoife Murphy"');
  expect(prompt).toContain('evaluation toolkit for ranking models');
});

test('closing the panel mid-run does not lose the message', async ({ context, serviceWorker }) => {
  await serveAoife(context);
  const claude = await fakeClaude(context, () => CLAUDE_NOTE, { hold: true });
  await setLocal(serviceWorker, { userApiKey: API_KEY });

  let panel = await openSidePanel(context);
  const linkedin = await openAoife(context, panel);

  await panel.click('#generate-btn');
  await expect.poll(() => panel.visible('#close-hint')).toBe(true);
  await expect.poll(() => claude.calls.length).toBe(1); // Claude is writing
  await panel.close(); // the panel is gone while Claude is still working

  claude.release();
  await expect.poll(async () => serviceWorker.evaluate(async (id) => {
    const { [id]: job } = await chrome.storage.session.get(id);
    return job && job.step;
  }, `job:${PROFILE_KEY}`)).toBe('done');

  await linkedin.bringToFront(); // still on the profile
  panel = await openSidePanel(context);
  await expect.poll(() => panel.value('#generated-message')).toBe(CLAUDE_NOTE);
  expect(await panel.text('#status-message')).toBe('Message ready. Written by Claude.');
  const { contacts = {} } = await getLocal(serviceWorker, 'contacts');
  expect(contacts[PROFILE_KEY]).toMatchObject({ name: 'Aoife Murphy', status: 'drafted', profileUrl: PROFILE_URL, message: CLAUDE_NOTE });
});

test('Settings: the key box keeps lower case, and your resume goes to Claude only while "Use my resume in AI Mode" is ticked', async ({ context, serviceWorker, blocked }, testInfo) => {
  await serveAoife(context);
  const claude = await fakeClaude(context, () => CLAUDE_NOTE);
  const panel = await openSidePanel(context);
  await panel.click('#tabbtn-settings');

  // No capitals in the key box or in its hint: Anthropic keys are lower case
  // and case-sensitive (3.1.0's license box showed everything in capitals).
  expect(await panel.evaluate(() => {
    const box = document.querySelector('#api-key');
    return [box.placeholder, getComputedStyle(box).textTransform, getComputedStyle(box, '::placeholder').textTransform];
  })).toEqual(['sk-ant-…', 'none', 'none']);

  // Type your key, pick a resume (a real file, read by the panel), and save.
  // "Use my resume in AI Mode" starts off.
  await panel.fill('#api-key', API_KEY);
  const pdf = testInfo.outputPath('my-resume.pdf');
  fs.writeFileSync(pdf, RESUME_PDF);
  await panel.setFiles('#resume-upload', [pdf]);
  await expect.poll(() => panel.text('#resume-status')).toBe('my-resume.pdf ready — click Save Settings to confirm.');
  expect(await panel.evaluate(() => document.querySelector('#resume-for-ai').checked)).toBe(false);
  await panel.click('#save-settings-btn');
  await expect.poll(() => panel.text('#settings-status')).toBe('Settings saved! AI Mode is on.');
  await expect.poll(() => panel.text('#key-status')).toBe('● AI Mode');
  const saved = await getLocal(serviceWorker, ['userApiKey', 'resumeFileName', 'resumeBase64', 'resumeForAI']);
  expect(saved).toMatchObject({ userApiKey: API_KEY, resumeFileName: 'my-resume.pdf', resumeForAI: false }); // the key exactly as typed
  expect(Buffer.from(saved.resumeBase64, 'base64').equals(RESUME_PDF)).toBe(true);
  expect(claude.calls).toEqual([]); // saving sends nothing

  // The box is off: Claude gets no resume.
  await panel.click('#tabbtn-current');
  await openAoife(context, panel);
  await panel.click('#generate-btn');
  await expect.poll(() => panel.text('#status-message')).toBe('Message ready. Written by Claude.');
  expect(claude.calls).toHaveLength(1);
  expect(blocksOf(claude.calls[0]).map((b) => b.type)).toEqual(['text']);
  expect(promptText(claude.calls[0].body)).not.toContain('My resume is attached');

  // Tick the box: with a saved resume, that is saved at once (no Save
  // needed), and the next version is written with your resume.
  await panel.click('#tabbtn-settings');
  await panel.click('#resume-for-ai');
  await expect.poll(() => panel.text('#settings-status')).toBe('Saved: AI Mode will send your resume with each message.');
  expect(await getLocal(serviceWorker, 'resumeForAI')).toEqual({ resumeForAI: true });
  await panel.click('#tabbtn-current');
  await panel.click('#regenerate-btn');
  await expect.poll(() => claude.calls.length).toBe(2);
  const [resume, text] = blocksOf(claude.calls[1]);
  expect(resume).toEqual({
    type: 'document', title: 'My resume (the sender)',
    source: { type: 'base64', media_type: 'application/pdf', data: saved.resumeBase64 },
  });
  expect(text.type).toBe('text');
  expect(text.text).toContain('My resume is attached as a PDF.');
  await expect.poll(() => panel.text('#status-message')).toBe('Message ready. Written by Claude.');

  // Untick it: that is saved at once too, so the very next version goes
  // without your resume.
  await panel.click('#tabbtn-settings');
  await panel.click('#resume-for-ai');
  await expect.poll(() => panel.text('#settings-status')).toBe('Saved: your resume will not be sent.');
  expect(await getLocal(serviceWorker, 'resumeForAI')).toEqual({ resumeForAI: false });
  await panel.click('#tabbtn-current');
  await panel.click('#regenerate-btn');
  await expect.poll(() => claude.calls.length).toBe(3);
  expect(blocksOf(claude.calls[2]).map((b) => b.type)).toEqual(['text']);
  expect(promptText(claude.calls[2].body)).not.toContain('My resume is attached');
  await expect.poll(() => panel.text('#status-message')).toBe('Message ready. Written by Claude.');

  // "Remove resume" forgets the file and your yes.
  await panel.click('#tabbtn-settings');
  await panel.click('#remove-resume-btn');
  await expect.poll(() => panel.text('#settings-status')).toBe('Resume removed.');
  expect(await getLocal(serviceWorker, ['resumeFileName', 'resumeBase64', 'resumeForAI'])).toEqual({});
  expect(await panel.evaluate(() => document.querySelector('#resume-for-ai').checked)).toBe(false);

  // You can pick the same PDF again. And after you change the PDF, picking
  // it again reads the new one. (Chrome tells a page nothing when you pick
  // the file that is already in its file picker, so the panel empties the
  // picker after each pick.)
  await panel.setFiles('#resume-upload', [pdf]);
  await expect.poll(() => panel.text('#resume-status')).toBe('my-resume.pdf ready — click Save Settings to confirm.');
  await panel.click('#save-settings-btn');
  await expect.poll(() => panel.text('#resume-status')).toBe('Resume saved ✓');
  expect((await getLocal(serviceWorker, 'resumeBase64')).resumeBase64).toBe(RESUME_PDF.toString('base64'));

  const newer = Buffer.from(RESUME_PDF.toString().replace('%%EOF', '% a newer copy\n%%EOF'));
  fs.writeFileSync(pdf, newer);
  await panel.setFiles('#resume-upload', [pdf]);
  await expect.poll(() => panel.text('#resume-status')).toBe('my-resume.pdf ready — click Save Settings to confirm.');
  await panel.click('#save-settings-btn');
  await expect.poll(() => panel.text('#resume-status')).toBe('Resume saved ✓');
  expect((await getLocal(serviceWorker, 'resumeBase64')).resumeBase64).toBe(newer.toString('base64'));

  expect(claude.calls).toHaveLength(3); // saving sends nothing
  expect(blocked).toEqual([]);
});
