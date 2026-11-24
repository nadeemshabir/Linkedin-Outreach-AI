// Your Anthropic key and your resume are kept in chrome.storage.local. By
// default, Chrome lets an extension's content scripts read that storage too,
// and content scripts run inside LinkedIn's pages. The extension's content scripts
// never need it (they ask the background to write), so each time the
// background starts, it locks that storage to the extension's own pages and
// its service worker (setAccessLevel: TRUSTED_CONTEXTS).
//
// This checks the lock in real Chromium: a script in the extension's content-script
// world on LinkedIn cannot read (or change) the storage, while the side panel
// still reads and saves Settings, and the "✨ Write" button in LinkedIn's note box
// still writes with your key. The key is fake, and Anthropic is a fake too.
import { test, expect, fakeClaude, API_KEY } from './extension.js';
import { openSidePanel } from './side-panel.js';
import { profilePage } from '../fixtures/linkedin-2026.js';
import { PROFILES } from '../fixtures/profiles.js';
import { dialogsScript } from '../fixtures/linkedin-dialogs.js';

const AOIFE       = PROFILES.find((p) => p.name === 'Aoife Murphy'); // 2nd: Connect
const PROFILE_URL = `https://www.linkedin.com/in/${AOIFE.slug}/`;

// What the fake Claude writes (example text): short enough for any note box.
const NOTE = 'Hi Aoife, your post about the evaluation toolkit caught my eye. Would you be open to connecting?';

/**
 * From the service worker, runs a script in the LinkedIn tab, in the
 * content-script world (the same world as the extension's own content scripts). The
 * script tries to read chrome.storage.local, then to change your key.
 */
function contentScriptTriesStorage(serviceWorker) {
  return serviceWorker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const out = { extWorld: globalThis.__outreachInpage === true && typeof LinkedInScraper === 'object' };
        try {
          out.read = await chrome.storage.local.get(null);
        } catch (err) {
          out.readError = String(err && err.message);
        }
        try {
          await chrome.storage.local.set({ userApiKey: 'sk-ant-changed-0000' });
          out.wrote = true;
        } catch (err) {
          out.writeError = String(err && err.message);
        }
        return out;
      },
    });
    return result;
  }, PROFILE_URL);
}

test("your key is locked away from LinkedIn's pages: a content script cannot read storage, while the side panel and the \"✨ Write\" button still work", async ({ context, serviceWorker, blocked }) => {
  // The worker has started (and set the lock). Save a fake key, as Settings would.
  await serviceWorker.evaluate((key) => chrome.storage.local.set({ userApiKey: key, userName: 'Rahul' }), API_KEY);
  const claude = await fakeClaude(context, () => NOTE);
  await context.route(PROFILE_URL, (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8', body: profilePage(AOIFE).replace('</body>', `${dialogsScript}</body>`),
  }));
  const page = await context.newPage();
  await page.goto(PROFILE_URL);

  // A script in the extension's content-script world on LinkedIn: Chrome refuses it
  // the storage, both reading and writing.
  // (Chromium 159 says: "Access to storage is not allowed from this context.")
  const tried = await contentScriptTriesStorage(serviceWorker);
  expect(tried.extWorld).toBe(true); // it ran beside the extension's own content scripts
  expect(tried.read).toBeUndefined(); // it did not get your key
  expect(tried.readError).toMatch(/storage is not allowed/i);
  expect(tried.wrote).toBeUndefined();
  expect(tried.writeError).toMatch(/storage is not allowed/i);
  expect(await serviceWorker.evaluate(() => chrome.storage.local.get('userApiKey'))).toEqual({ userApiKey: API_KEY });

  // The side panel (an extension page) still reads Settings...
  const panel = await openSidePanel(context);
  await expect.poll(() => panel.text('#key-status')).toBe('● AI Mode');
  await panel.click('#tabbtn-settings');
  expect(await panel.value('#api-key')).toBe(API_KEY);
  expect(await panel.value('#user-name')).toBe('Rahul');
  // ...and still saves them.
  await panel.fill('#user-name', 'Rahul Sharma');
  await panel.click('#save-settings-btn');
  await expect.poll(() => panel.text('#settings-status')).toBe('Settings saved! AI Mode is on.');
  expect(await serviceWorker.evaluate(() => chrome.storage.local.get(['userApiKey', 'userName'])))
    .toEqual({ userApiKey: API_KEY, userName: 'Rahul Sharma' });

  // The "✨ Write" button inside LinkedIn's note box still works: the background
  // reads your key and asks (the fake) Anthropic.
  await page.bringToFront();
  await page.getByRole('button', { name: 'Invite Aoife Murphy to connect' }).click();
  await page.getByRole('button', { name: 'Add a note', exact: true }).click();
  await page.getByRole('button', { name: '✨ Write a note to Aoife' }).click();
  await expect(page.locator('textarea')).toHaveValue(NOTE);
  await expect(page.getByRole('status')).toHaveText(`${NOTE.length}/200. Read it, then press Send.`);
  expect(claude.calls).toHaveLength(1);
  expect(claude.calls[0].headers['x-api-key']).toBe(API_KEY);
  expect(await page.evaluate(() => window.__sends)).toEqual([]);

  // Still locked after all that.
  const again = await contentScriptTriesStorage(serviceWorker);
  expect(again.read).toBeUndefined();
  expect(again.readError).toMatch(/storage is not allowed/i);
  expect(blocked).toEqual([]);
});
