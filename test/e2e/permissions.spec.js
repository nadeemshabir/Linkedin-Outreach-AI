// What the extension may reach. Its host access is LinkedIn, plus Anthropic's
// API for AI Mode (the same as 3.1.0, so no new install warning).
// Google's and OpenAI's APIs are optional: Chrome asks only when you pick that
// company in Settings, so none is granted at install. It
// also proves the extension still works without the "tabs" permission (B10):
// host access to linkedin.com is enough to read LinkedIn tab URLs.
import { test, expect, serveLinkedInPage } from './extension.js';

const PROFILE_URL = 'https://www.linkedin.com/in/test-person/';
const PAGE = `<!doctype html><html><head><title>Test Person | LinkedIn</title></head>
<body><main><section><h1>Test Person</h1><p>Data Scientist at Example</p></section></main></body></html>`;

test('manifest asks only for what it uses', async ({ serviceWorker }) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions).not.toContain('tabs');
});

test('host access is LinkedIn and Anthropic\'s API (for AI Mode), nothing else', async ({ serviceWorker }) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect([...manifest.host_permissions].sort()).toEqual(['https://api.anthropic.com/*', 'https://www.linkedin.com/*']);
});

test('Google\'s and OpenAI\'s APIs are optional, and not granted at install', async ({ serviceWorker }) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect([...manifest.optional_host_permissions].sort()).toEqual(['https://api.openai.com/*', 'https://generativelanguage.googleapis.com/*']);
  const granted = await serviceWorker.evaluate(() => chrome.permissions.getAll());
  expect(granted.origins).not.toContain('https://api.openai.com/*');
  expect(granted.origins).not.toContain('https://generativelanguage.googleapis.com/*');
});

test('LinkedIn tab URLs are still readable, other sites stay private', async ({ context, serviceWorker }) => {
  await serveLinkedInPage(context, PROFILE_URL, PAGE);
  const linkedin = await context.newPage();
  await linkedin.goto(PROFILE_URL);
  const other = await context.newPage();
  await other.goto('about:blank');

  const urls = await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.url || null));
  expect(urls).toContain(PROFILE_URL);
  expect(urls).not.toContain('about:blank');
});

test('the content script still answers on a LinkedIn profile', async ({ context, serviceWorker }) => {
  await serveLinkedInPage(context, PROFILE_URL, PAGE);
  const page = await context.newPage();
  await page.goto(PROFILE_URL);

  const res = await serviceWorker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.tabs.sendMessage(tab.id, { action: 'scrapeProfile' });
  }, PROFILE_URL);

  expect(res.success).toBe(true);
  expect(res.data.name).toBe('Test Person');
  expect(res.data.profileUrl).toBe(PROFILE_URL);
});
