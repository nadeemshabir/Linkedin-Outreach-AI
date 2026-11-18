// Proves the extension still works without the "tabs" permission (B10):
// host permission for linkedin.com is enough to read LinkedIn tab URLs.
import { test, expect, serveLinkedInPage } from './extension.js';

const PROFILE_URL = 'https://www.linkedin.com/in/test-person/';
const PAGE = `<!doctype html><html><head><title>Test Person | LinkedIn</title></head>
<body><main><section><h1>Test Person</h1><p>Data Scientist at Example</p></section></main></body></html>`;

test('manifest asks only for what it uses', async ({ serviceWorker }) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions).not.toContain('tabs');
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
