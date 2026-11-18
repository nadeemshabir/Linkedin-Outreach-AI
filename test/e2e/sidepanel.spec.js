// The side panel in real Chromium: real extension, real content script on a
// local copy of a LinkedIn-like page, and a fake Ark server.
import { test, expect, serveLinkedInPage, SERVER } from './extension.js';

const PROFILE_URL = 'https://www.linkedin.com/in/aoife-test/';
const PAGE = `<!doctype html><html><head><title>Aoife Murphy | LinkedIn</title></head><body><main>
  <section><h1>Aoife Murphy</h1><p>Senior Data Scientist at Spotify</p><p>Dublin, County Dublin, Ireland</p></section>
  <section><h2>Experience</h2><p>Senior Data Scientist</p><p>Spotify · Full-time</p><p>Jan 2022 - Present · 2 yrs</p><p>Dublin, Ireland</p></section>
</main></body></html>`;

/** Fake Ark server. Answers are held until release() when `hold` is set. */
async function fakeArk(context, { hold = false } = {}) {
  const calls = [];
  let release;
  const gate = hold ? new Promise((r) => { release = r; }) : Promise.resolve();
  await context.route(`${SERVER}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    calls.push({ path, body });
    let status = 404;
    let json = { error: 'not found' };
    if (path === '/api/validate') { status = 200; json = { valid: true, remaining: 20 }; }
    if (path === '/api/generate/quick') {
      await gate;
      status = 200;
      json = { success: true, message: `Hi ${body.profileData.name.split(' ')[0]}, your work on recommendations at ${body.profileData.currentCompany} caught my eye.` };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
  });
  return { calls, release: () => release && release() };
}

async function openPanel(context, extensionId) {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return panel;
}

test('clicking the toolbar icon opens the side panel', async ({ serviceWorker }) => {
  const behavior = await serviceWorker.evaluate(() => chrome.sidePanel.getPanelBehavior());
  expect(behavior.openPanelOnActionClick).toBe(true);
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.side_panel.default_path).toBe('sidepanel.html');
  expect(manifest.action.default_popup).toBeUndefined();
});

test('panel follows you to a profile and generates in one click', async ({ context, extensionId }) => {
  await serveLinkedInPage(context, PROFILE_URL, PAGE);
  const ark = await fakeArk(context);

  const panel = await openPanel(context, extensionId);
  await panel.evaluate(() => chrome.storage.local.set({ licenseKey: 'ARK-TEST-0000-0000' }));
  await expect(panel.locator('#page-warning')).toBeVisible(); // no profile open yet

  const linkedin = await context.newPage(); // becomes the active tab
  await linkedin.goto(PROFILE_URL);
  await expect(panel.locator('#profile-name')).toHaveText('Aoife Murphy');
  await expect(panel.locator('#page-warning')).toBeHidden();

  await panel.click('#generate-btn');
  await expect(panel.locator('#generated-message')).toHaveValue(/^Hi Aoife, your work on recommendations at Spotify/);
  await expect(panel.locator('#status-message')).toHaveText('Message ready.');

  // The real content script read the real page.
  const quick = ark.calls.find((c) => c.path === '/api/generate/quick');
  expect(quick.body.profileData).toMatchObject({ name: 'Aoife Murphy', currentCompany: 'Spotify' });
});

test('closing the panel mid-run does not lose the message', async ({ context, extensionId, serviceWorker }) => {
  await serveLinkedInPage(context, PROFILE_URL, PAGE);
  const ark = await fakeArk(context, { hold: true });

  let panel = await openPanel(context, extensionId);
  await panel.evaluate(() => chrome.storage.local.set({ licenseKey: 'ARK-TEST-0000-0000' }));
  const linkedin = await context.newPage();
  await linkedin.goto(PROFILE_URL);
  await expect(panel.locator('#profile-name')).toHaveText('Aoife Murphy');

  await panel.click('#generate-btn');
  await expect(panel.locator('#close-hint')).toBeVisible();
  await panel.close(); // the panel is gone while the server is still working

  ark.release();
  await expect.poll(async () => serviceWorker.evaluate(async () => {
    const { 'job:/in/aoife-test/': job } = await chrome.storage.session.get('job:/in/aoife-test/');
    return job && job.step;
  })).toBe('done');

  panel = await openPanel(context, extensionId);
  await linkedin.bringToFront(); // back on the profile
  await expect(panel.locator('#generated-message')).toHaveValue(/^Hi Aoife/);
  const { contacts } = await panel.evaluate(() => chrome.storage.local.get('contacts'));
  expect(contacts['/in/aoife-test/']).toMatchObject({ name: 'Aoife Murphy', status: 'drafted', profileUrl: 'https://www.linkedin.com/in/aoife-test/' });
});
