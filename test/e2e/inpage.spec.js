// "Write with Ark" in real Chromium: the real extension (background and
// content scripts) on a LinkedIn-like page with LinkedIn's note box and
// message box. Free Mode by default: no key, the text comes from the
// extension's own template, and nothing is fetched. Three tests use AI Mode,
// with a fake of Anthropic's Messages API. Checks that the page itself sees
// the text the way it sees typing (its counter, its Send button), that the
// text fits, that nothing is ever sent, and that only your real click or
// key press (not a script in LinkedIn's page) can make Ark write. The last
// test turns Ark off and on again while the page stays open, as an update
// does, and checks that exactly one bar stays and still works.
import { test, expect, fakeClaude, promptText, API_KEY } from './extension.js';
import { openSidePanel } from './side-panel.js';
import { profilePage } from '../fixtures/linkedin-2026.js';
import { PROFILES } from '../fixtures/profiles.js';
import { dialogsScript } from '../fixtures/linkedin-dialogs.js';

const AOIFE = PROFILES.find((p) => p.name === 'Aoife Murphy'); // 2nd: Connect
const SEAN  = PROFILES.find((p) => p.name === "Seán O'Brien"); // 1st: Message
// Made up: Aoife's test page under a name with a title in front, as many
// LinkedIn names in India have.
const ANANYA = { ...AOIFE, slug: 'ananya-rao-test', name: 'Dr. Ananya Rao' };

// What a fake Claude might send: too long for a 200-character note, with a
// filler line, a middle sentence and a sign-off.
const LONG_NOTE = 'Hi Aoife, I hope this message finds you well. Your talk on podcast recommendations at Spotify was great. '
  + 'I am a final-year student working on ranking models for audio and I would love to learn from your experience. '
  + 'Would you be open to a short chat about your team? Thank you, Rahul';

// What a fake Claude might send: short enough for any note box.
const SHORT_NOTE = 'Hi Aoife, your post about the evaluation toolkit caught my eye. Would you be open to connecting?';

// You (made up). With this bio, the note would be well over 200 characters,
// so Free Mode has to leave parts out to fit.
const SENDER = {
  userName: 'Rahul',
  userBio: 'I am finishing an MSc in Data Science at Trinity College Dublin and I am looking for my first data science role in Ireland.',
};

async function openLinkedIn(context, person) {
  const url = `https://www.linkedin.com/in/${person.slug}/`;
  await context.route(url, (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8', body: profilePage(person).replace('</body>', `${dialogsScript}</body>`),
  }));
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

async function writeNote(page) {
  await page.getByRole('button', { name: 'Invite Aoife Murphy to connect' }).click();
  await page.getByRole('button', { name: 'Add a note', exact: true }).click();
  await page.getByRole('button', { name: '✨ Write a note to Aoife' }).click();
}

/** The background's job for this person: the draft the button used. */
function jobFor(serviceWorker, person) {
  return serviceWorker.evaluate(async (id) => (await chrome.storage.session.get(id))[id] || null, `job:/in/${person.slug}/`);
}

/**
 * A script in LinkedIn's own page (not the extension) finds one of Ark's
 * buttons through the bar's open shadow root and calls .click() on it.
 * Returns the button's text and the note box right after the click: Ark
 * changes them at once when it acts on a click.
 */
function scriptClick(page, button) {
  return page.evaluate((cls) => {
    const el = document.querySelector('[data-ark-write]').shadowRoot.querySelector(`button.${cls}`);
    el.click();
    return { button: el.textContent, box: document.querySelector('textarea').value };
  }, button);
}

test("Free Mode: Connect → Add a note → one click fills LinkedIn's note box with a note that fits 200; Send is left to you", async ({ context, serviceWorker, blocked }) => {
  await serviceWorker.evaluate((s) => chrome.storage.local.set(s), SENDER);
  const page = await openLinkedIn(context, AOIFE);
  await writeNote(page);

  const box = page.locator('textarea');
  await expect(box).toHaveValue(/^Hi Aoife, /);
  const value = await box.inputValue();
  expect(value.length).toBeLessThanOrEqual(200);
  await expect(page.locator('[data-counter]')).toHaveText(`${value.length}/200`);
  await expect(page.getByRole('button', { name: 'Send invitation' })).toBeEnabled();
  await expect(page.getByRole('status')).toHaveText(`${value.length}/200. Read it, then press Send.`);

  // The box holds the background's whole Free Mode note, written for a
  // 200-character box (nothing was cut off by the box).
  const job = await jobFor(serviceWorker, AOIFE);
  expect(job).toMatchObject({ writer: 'free', channel: 'note', maxChars: 200, message: value });

  // The browser itself typed it (so Ctrl+Z works), and nothing was sent.
  expect(await page.evaluate(() => window.__inputs)).toContainEqual({ trusted: true, type: 'insertText' });
  expect(await page.evaluate(() => window.__sends)).toEqual([]);
  // No key: nothing left the machine, and nothing even tried.
  expect(blocked).toEqual([]);
});

test('Free Mode: on the profile of "Dr. Ananya Rao", the button says "Write a note to Ananya", and the note says "Hi Ananya,"', async ({ context, serviceWorker, blocked }) => {
  const page = await openLinkedIn(context, ANANYA);
  await page.getByRole('button', { name: 'Invite Dr. Ananya Rao to connect' }).click();
  await page.getByRole('button', { name: 'Add a note', exact: true }).click();

  // The label uses the writer's own rule (utils/writer.js is a content
  // script too): no title. Not "Write a note to Dr."
  const write = page.getByRole('button', { name: '✨ Write a note to Ananya', exact: true });
  await expect(write).toBeEnabled();
  await expect(write).toHaveText('✨ Write a note to Ananya');
  await expect(page.getByRole('status')).toHaveText(''); // the invite is for her: no warning

  // One click: the note names her the same way.
  await write.click();
  const box = page.locator('textarea');
  await expect(box).toHaveValue(/^Hi Ananya, /);
  const value = await box.inputValue();
  expect(value.length).toBeLessThanOrEqual(200);
  await expect(page.getByRole('status')).toHaveText(`${value.length}/200. Read it, then press Send.`);
  await expect(write).toHaveText('✨ Write a note to Ananya');

  // The page gave her name with the title, so both had to leave it out.
  const job = await jobFor(serviceWorker, ANANYA);
  expect(job).toMatchObject({ writer: 'free', channel: 'note', message: value });
  expect(job.profile.name).toBe('Dr. Ananya Rao');
  expect(await page.evaluate(() => window.__sends)).toEqual([]);
  expect(blocked).toEqual([]);
});

test("AI Mode: Claude's note is too long, so it is shortened to fit 200 by whole sentences; Send is left to you", async ({ context, serviceWorker }) => {
  await serviceWorker.evaluate((key) => chrome.storage.local.set({ userApiKey: key }), API_KEY);
  const claude = await fakeClaude(context, () => LONG_NOTE);
  const page = await openLinkedIn(context, AOIFE);
  await writeNote(page);

  // The filler line and the middle sentence are left out. After "Hi Aoife,"
  // the note goes on in the same line, so "Your" gets a small letter.
  const box = page.locator('textarea');
  await expect(box).toHaveValue('Hi Aoife, your talk on podcast recommendations at Spotify was great. Would you be open to a short chat about your team?');
  const value = await box.inputValue();
  await expect(page.locator('[data-counter]')).toHaveText(`${value.length}/200`);
  await expect(page.getByRole('button', { name: 'Send invitation' })).toBeEnabled();
  await expect(page.getByRole('status')).toHaveText('Shortened to fit 200. Read it, then press Send.');
  expect(await page.evaluate(() => window.__inputs)).toContainEqual({ trusted: true, type: 'insertText' });
  expect(await page.evaluate(() => window.__sends)).toEqual([]);

  // Claude got your key, and was told this is a 200-character note for the
  // person the real content script read on the page.
  expect(claude.calls).toHaveLength(1);
  const [call] = claude.calls;
  expect(call.headers['x-api-key']).toBe(API_KEY);
  const prompt = promptText(call.body);
  expect(prompt).toMatch(/connection note\. Keep it under 170 characters: LinkedIn's hard limit is 200/);
  expect(prompt).toContain('"name": "Aoife Murphy"');
  expect(prompt).toContain('"currentCompany": "Spotify"');
});

test("AI Mode: Anthropic cannot read your resume PDF, so the note is written without it, and the bar in LinkedIn's box says so", async ({ context, serviceWorker, blocked }) => {
  // You said yes to "Use my resume in AI Mode", but the file is not a PDF
  // that Anthropic can read (made up; the fake below refuses it with a 400).
  const resume = Buffer.from('%PDF-1.4\n% a made-up resume that cannot be read\n%%EOF\n').toString('base64');
  await serviceWorker.evaluate((s) => chrome.storage.local.set(s), {
    userApiKey: API_KEY, resumeFileName: 'my-resume.pdf', resumeBase64: resume, resumeForAI: true,
  });
  const blockTypes = (body) => body.messages[body.messages.length - 1].content.map((b) => b.type);
  const claude = await fakeClaude(context, (body) => (blockTypes(body).includes('document')
    ? { status: 400, error: { type: 'invalid_request_error', message: 'The PDF specified could not be read.' } }
    : SHORT_NOTE));
  const page = await openLinkedIn(context, AOIFE);
  await writeNote(page);

  await expect(page.locator('textarea')).toHaveValue(SHORT_NOTE);
  const status = page.getByRole('status');
  await expect(status).toHaveText("Written without your resume: Anthropic could not read the PDF (replace or remove it in the extension's Settings). "
    + `${SHORT_NOTE.length}/200. Read it, then press Send.`);
  await expect(status).toHaveClass('info warn');

  // Asked once with your resume, then once more without it.
  expect(claude.calls.map((call) => blockTypes(call.body))).toEqual([['document', 'text'], ['text']]);
  expect(await jobFor(serviceWorker, AOIFE)).toMatchObject({ writer: 'ai', resumeSkipped: true, message: SHORT_NOTE });
  expect(await page.evaluate(() => window.__sends)).toEqual([]);
  expect(blocked).toEqual([]);
});

test("AI Mode: a script in LinkedIn's page cannot press Write or Undo: nothing is written and nothing is asked of Anthropic; your real click works", async ({ context, serviceWorker, blocked }) => {
  await serviceWorker.evaluate((key) => chrome.storage.local.set({ userApiKey: key }), API_KEY);
  const claude = await fakeClaude(context, () => SHORT_NOTE);
  const page = await openLinkedIn(context, AOIFE);
  await page.getByRole('button', { name: 'Invite Aoife Murphy to connect' }).click();
  await page.getByRole('button', { name: 'Add a note', exact: true }).click();
  const write = page.getByRole('button', { name: '✨ Write a note to Aoife' });
  await expect(write).toBeEnabled();
  const box = page.locator('textarea');

  // The page's script presses Write: nothing happens, not even for a moment.
  expect(await scriptClick(page, 'write')).toEqual({ button: '✨ Write a note to Aoife', box: '' }); // not "Writing…"
  await page.waitForTimeout(1500); // time enough for a run to start, if one had
  expect(claude.calls).toEqual([]); // no paid request on your key
  expect(await jobFor(serviceWorker, AOIFE)).toBeNull(); // the background was not even asked
  await expect(box).toHaveValue('');
  await expect(write).toHaveText('✨ Write a note to Aoife');
  expect(await page.evaluate(() => window.__inputs)).toEqual([]); // LinkedIn saw no typing

  // Your real click on the same button works (Playwright's clicks are real,
  // trusted clicks).
  await write.click();
  await expect(box).toHaveValue(SHORT_NOTE);
  await expect(page.getByRole('status')).toHaveText(`${SHORT_NOTE.length}/200. Read it, then press Send.`);
  expect(claude.calls).toHaveLength(1);

  // Undo too: the page's script cannot take your note out; you can.
  expect(await scriptClick(page, 'undo')).toEqual({ button: 'Undo', box: SHORT_NOTE });
  await expect(box).toHaveValue(SHORT_NOTE);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(box).toHaveValue('');

  expect(claude.calls).toHaveLength(1);
  expect(await page.evaluate(() => window.__sends)).toEqual([]);
  expect(blocked).toEqual([]);
});

test("Free Mode: Enter on the focused button counts as your click too, and the key does not reach LinkedIn's page", async ({ context, serviceWorker, blocked }) => {
  const page = await openLinkedIn(context, AOIFE);
  await page.getByRole('button', { name: 'Invite Aoife Murphy to connect' }).click();
  await page.getByRole('button', { name: 'Add a note', exact: true }).click();
  // LinkedIn's page listens for keys (in a message box, Enter can mean "send").
  await page.evaluate(() => {
    window.__keys = [];
    document.addEventListener('keydown', (e) => window.__keys.push(e.key));
  });

  // Keyboard users press Write with Enter. That is a real, trusted click.
  await page.getByRole('button', { name: '✨ Write a note to Aoife' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('textarea')).toHaveValue(/^Hi Aoife, /);
  expect(await jobFor(serviceWorker, AOIFE)).toMatchObject({ writer: 'free', channel: 'note' });

  expect(await page.evaluate(() => window.__keys)).toEqual([]); // Ark kept the Enter to itself
  expect(await page.evaluate(() => window.__sends)).toEqual([]);
  expect(blocked).toEqual([]);
});

test("Free Mode: message box in LinkedIn's shadow root: the browser types it, LinkedIn's Send turns on, nothing is sent", async ({ context, serviceWorker, blocked }) => {
  const page = await openLinkedIn(context, SEAN);
  await page.getByRole('button', { name: `Message ${SEAN.name}` }).click();
  await page.getByRole('button', { name: '✨ Write a message to Seán' }).click();

  const editor = page.getByRole('textbox', { name: 'Write a message…' });
  await expect(editor).toContainText('Workday'); // from his page
  const job = await jobFor(serviceWorker, SEAN);
  expect(job).toMatchObject({ writer: 'free', channel: 'message' });

  // Every line of the message is in the box, in order, as its own paragraph.
  const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);
  const typed = await editor.innerText();
  expect(typed).toMatch(/^Hi Seán,\n+\S/);
  expect(lines(typed)).toEqual(lines(job.message));
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__inputs)).toContainEqual({ trusted: true, type: 'insertText' });
  expect(await page.evaluate(() => window.__sends)).toEqual([]);
  expect(blocked).toEqual([]);

  // Ctrl+Z takes it back out, like any typing.
  await editor.focus();
  await page.keyboard.press('Control+z');
  await expect(editor).not.toContainText('Workday');
});

test('a chat with someone else on this profile: the button says so and nothing is written', async ({ context, serviceWorker, blocked }) => {
  const page = await openLinkedIn(context, AOIFE);
  await page.evaluate(() => window.openMessageBox('Liam Byrne'));

  const write = page.getByRole('button', { name: '✨ Write a message to Aoife' });
  await expect(write).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('This chat is with Liam Byrne. Open their profile to write to them with Ark.');
  await expect(page.getByRole('textbox', { name: 'Write a message…' })).toHaveText('');
  expect(await jobFor(serviceWorker, AOIFE)).toBeNull(); // nothing was started
  expect(blocked).toEqual([]);
});

/**
 * Turns Ark off and on again in chrome://extensions. Chrome unloads the
 * extension and loads it again, as it does for an update, and leaves open
 * tabs as they are: the old copy of the content scripts keeps running in
 * them, cut off from the extension. Returns the new service worker.
 */
async function turnOffAndOn(context, extensionId) {
  const next = context.waitForEvent('serviceworker', (w) => w.url().startsWith(`chrome-extension://${extensionId}/`));
  const settings = await context.newPage();
  await settings.goto('chrome://extensions/');
  await settings.evaluate(async (id) => {
    await chrome.management.setEnabled(id, false);
    await chrome.management.setEnabled(id, true);
  }, extensionId);
  await settings.close();
  return next;
}

/**
 * From now on, counts Ark's bars put into the page and taken out of it, seen
 * from LinkedIn's own page, one change at a time. `most` is the most bars on
 * the page at the same moment.
 */
function countBarChanges(page) {
  return page.evaluate(() => {
    const isBar = (n) => n.nodeType === 1 && n.hasAttribute('data-ark-write');
    let now = document.querySelectorAll('[data-ark-write]').length;
    window.__barChanges = { added: 0, removed: 0, most: now };
    new MutationObserver((records) => {
      for (const r of records) {
        const added = [...r.addedNodes].filter(isBar).length;
        const removed = [...r.removedNodes].filter(isBar).length;
        window.__barChanges.added += added;
        window.__barChanges.removed += removed;
        now += added - removed;
        window.__barChanges.most = Math.max(window.__barChanges.most, now);
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

test('Ark is updated while a note box is open (here: turned off and on again): the old copy steps aside, and the side panel brings exactly one bar that stays and writes', async ({ context, extensionId, blocked }) => {
  const page = await openLinkedIn(context, AOIFE);
  await page.getByRole('button', { name: 'Invite Aoife Murphy to connect' }).click();
  await page.getByRole('button', { name: 'Add a note', exact: true }).click();
  const write = page.getByRole('button', { name: '✨ Write a note to Aoife' });
  await expect(write).toBeEnabled();
  const bars = page.locator('[data-ark-write]');
  await expect(bars).toHaveCount(1);

  // The update. The page stays open, and so does the note box.
  const worker = await turnOffAndOn(context, extensionId);
  await page.bringToFront();

  // The old copy is cut off (chrome.runtime.id is gone). The next time the
  // page changes (you type), it looks again and takes its bar away.
  const box = page.locator('textarea');
  await box.fill('Hi Aoife');
  await expect(bars).toHaveCount(0);

  // You open the side panel. It reads the open profile, so the new
  // background puts a new copy of its content scripts into the page.
  await countBarChanges(page);
  const panel = await openSidePanel(context);
  await expect.poll(() => panel.text('#profile-name')).toBe('Aoife Murphy');
  await page.bringToFront();
  await expect(bars).toHaveCount(1);
  await expect(write).toBeEnabled();

  // The bar stays: you keep typing, and nothing swaps it out.
  await box.press('End');
  await box.pressSequentially(', we met at');
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__barChanges)).toEqual({ added: 1, removed: 0, most: 1 });
  await expect(bars).toHaveCount(1);

  // One click: the new copy writes the note (Free Mode: no key, no network).
  await write.click();
  const status = page.getByRole('status');
  await expect(status).toHaveText(/^\d+\/200\. Read it, then press Send\.$/);
  const job = await jobFor(worker, AOIFE);
  expect(job).toMatchObject({ writer: 'free', channel: 'note', maxChars: 200 });
  await expect(box).toHaveValue(job.message);
  await expect(status).toHaveText(`${job.message.length}/200. Read it, then press Send.`);

  // Close the note box and open it again: still exactly one bar, and it works.
  await page.getByRole('button', { name: 'Cancel adding a note' }).click();
  await page.getByRole('button', { name: 'Invite Aoife Murphy to connect' }).click();
  await page.getByRole('button', { name: 'Add a note', exact: true }).click();
  await expect(write).toBeEnabled();
  await page.waitForTimeout(1000);
  await expect(bars).toHaveCount(1);
  await write.click();
  await expect(status).toHaveText(/^\d+\/200\. Read it, then press Send\.$/);
  expect(await box.inputValue()).toBe((await jobFor(worker, AOIFE)).message);

  expect(await page.evaluate(() => window.__sends)).toEqual([]);
  expect(blocked).toEqual([]);
});
