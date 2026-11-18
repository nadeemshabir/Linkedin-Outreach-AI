// Playwright fixtures that load the real, unpacked extension into Chromium.
// LinkedIn and the Ark server are never contacted: both are served by
// Playwright request routing from local files and a fake API.
import { test as base, chromium, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const EXTENSION_DIR = path.join(ROOT, 'extension');
export const SERVER = 'https://linkedin-extention-production.up.railway.app';

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', // new headless mode, which supports extensions
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    // Block anything that would leave the machine, unless a test routes it.
    await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
});

/** Serve a local HTML file (or string) at a LinkedIn URL. */
export async function serveLinkedInPage(context, url, htmlOrFixture) {
  const body = htmlOrFixture.trim().startsWith('<')
    ? htmlOrFixture
    : fs.readFileSync(path.join(ROOT, 'test', 'fixtures', htmlOrFixture), 'utf8');
  await context.route(url, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body }));
}

export { expect };
