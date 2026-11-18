// "Write with Ark" in real Chromium: the real extension (background and
// content scripts) on a LinkedIn-like page with LinkedIn's note box and
// message box, and a fake Ark server. Checks that the page itself sees the
// text the way it sees typing (its counter, its Send button), that the text
// fits, and that nothing is ever sent.
import { test, expect, SERVER } from './extension.js';
import { profilePage } from '../fixtures/linkedin-2026.js';
import { PROFILES } from '../fixtures/profiles.js';
import { dialogsScript } from '../fixtures/linkedin-dialogs.js';

const AOIFE = PROFILES.find((p) => p.name === 'Aoife Murphy'); // 2nd: Connect
const SEAN  = PROFILES.find((p) => p.name === "Seán O'Brien"); // 1st: Message

// Too long for a 200-character note: a filler line, a middle sentence and a sign-off.
const LONG_NOTE = 'Hi Aoife, I hope this message finds you well. Your talk on podcast recommendations at Spotify was great. '
  + 'I am a final-year student working on ranking models for audio and I would love to learn from your experience. '
  + 'Would you be open to a short chat about your team? Thank you, Rahul';

async function linkedinWithArk(context, serviceWorker, person, message) {
  await serviceWorker.evaluate(() => chrome.storage.local.set({ licenseKey: 'ARK-TEST-0000-0000' }));
  const url = `https://www.linkedin.com/in/${person.slug}/`;
  await context.route(url, (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8', body: profilePage(person).replace('</body>', `${dialogsScript}</body>`),
  }));
  const calls = [];
  await context.route(`${SERVER}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push({ path, body: route.request().postDataJSON() });
    const ok = path === '/api/generate/quick';
    await route.fulfill({ status: ok ? 200 : 404, contentType: 'application/json', body: JSON.stringify(ok ? { success: true, message } : {}) });
  });
  const page = await context.newPage();
  await page.goto(url);
  return { page, calls };
}

test("Connect → Add a note → one click fills LinkedIn's note box, fitted to 200; Send is left to you", async ({ context, serviceWorker }) => {
  const { page, calls } = await linkedinWithArk(context, serviceWorker, AOIFE, LONG_NOTE);

  await page.getByRole('button', { name: 'Invite Aoife Murphy to connect' }).click();
  await page.getByRole('button', { name: 'Add a note', exact: true }).click();
  await page.getByRole('button', { name: '✨ Write a note to Aoife' }).click();

  const box = page.locator('textarea');
  await expect(box).toHaveValue('Hi Aoife, Your talk on podcast recommendations at Spotify was great. Would you be open to a short chat about your team?');
  const value = await box.inputValue();
  await expect(page.locator('[data-counter]')).toHaveText(`${value.length}/200`);
  await expect(page.getByRole('button', { name: 'Send invitation' })).toBeEnabled();
  await expect(page.getByRole('status')).toHaveText('Shortened to fit 200. Read it, then press Send.');

  // The browser itself typed it (so Ctrl+Z works), and nothing was sent.
  expect(await page.evaluate(() => window.__inputs)).toContainEqual({ trusted: true, type: 'insertText' });
  expect(await page.evaluate(() => window.__sends)).toEqual([]);

  // The real content script read the real page for the writer, and the
  // writer was told this is a 200-character note.
  const quick = calls.find((c) => c.path === '/api/generate/quick');
  expect(quick.body.profileData).toMatchObject({ name: 'Aoife Murphy', currentCompany: 'Spotify' });
  expect(quick.body.userBio).toMatch(/LinkedIn connection note\. Keep it under 170 characters \(hard limit 200/);
});

test("message box in LinkedIn's shadow root: the browser types it, LinkedIn's Send turns on, nothing is sent", async ({ context, serviceWorker }) => {
  const message = 'Hi Seán,\n\nThanks for connecting! Could I ask you two quick questions about recruiting at Workday?';
  const { page } = await linkedinWithArk(context, serviceWorker, SEAN, message);

  await page.getByRole('button', { name: `Message ${SEAN.name}` }).click();
  await page.getByRole('button', { name: '✨ Write a message to Seán' }).click();

  const editor = page.getByRole('textbox', { name: 'Write a message…' });
  await expect(editor).toContainText('Thanks for connecting! Could I ask you two quick questions about recruiting at Workday?');
  expect(await editor.innerText()).toMatch(/^Hi Seán,\n+Thanks for connecting!/);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__inputs)).toContainEqual({ trusted: true, type: 'insertText' });
  expect(await page.evaluate(() => window.__sends)).toEqual([]);

  // Ctrl+Z takes it back out, like any typing.
  await editor.focus();
  await page.keyboard.press('Control+z');
  await expect(editor).not.toContainText('Thanks for connecting');
});

test('a chat with someone else on this profile: the button says so and nothing is written', async ({ context, serviceWorker }) => {
  const { page, calls } = await linkedinWithArk(context, serviceWorker, AOIFE, 'Hi!');
  await page.evaluate(() => window.openMessageBox('Liam Byrne'));

  const write = page.getByRole('button', { name: '✨ Write a message to Aoife' });
  await expect(write).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('This chat is with Liam Byrne. Open their profile to write to them with Ark.');
  expect(calls).toEqual([]);
});
