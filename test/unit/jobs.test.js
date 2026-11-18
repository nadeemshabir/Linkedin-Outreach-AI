// The side panel + background "job" design (Phase 2), tested with the REAL
// panel and REAL background code talking through a fake browser.
import { describe, it, expect } from 'vitest';
import { createWorld, openPanel, person, until, settle, type, fire, deferred, KEY } from '../helpers/world.js';

const VALID = () => ({ key: KEY, state: 'valid', remaining: 9, checkedAt: Date.now() });
const AOIFE = person('aoife', 'Aoife');
const LIAM  = person('liam', 'Liam');

const okServer = async (path, body) => {
  if (path === '/api/generate/quick') return [200, { success: true, message: `Hi ${body.profileData.name}!` }];
  if (path === '/api/generate/enrich') {
    return [200, {
      success: true,
      profileJSON: { name: body.rawProfileData.name, headline: 'Structured headline' },
      enrichmentJSON: { topHooks: ['Spotify opened a Dublin office'] },
    }];
  }
  if (path === '/api/generate/deep') return [200, { success: true, message: `Deep hello, ${body.profileJSON.name}`, remaining: 8 }];
  if (path === '/api/validate') return [200, { valid: true, remaining: 9 }];
  return [404, {}];
};

function world(opts = {}) {
  return createWorld({
    local: { licenseKey: KEY, keyStatus: VALID() },
    tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }],
    pages: { 1: AOIFE },
    server: okServer,
    ...opts,
  });
}

const dotOf = (panel, step) => panel.$(`step-${step}`).querySelector('.status-dot').className;

describe('side panel + background jobs', () => {
  it('Quick Mode: one click gives a message, and Recent has it', async () => {
    const w = world();
    const panel = await openPanel(w);
    panel.$('generate-btn').click();

    await until(() => panel.$('generated-message').value === 'Hi Aoife!');
    expect(panel.$('status-message').textContent).toBe('Message ready.');
    expect(await w.recent()).toEqual([
      expect.objectContaining({ name: 'Aoife', message: 'Hi Aoife!', profileUrl: 'https://www.linkedin.com/in/aoife/' }),
    ]);
  });

  it('closing the panel mid-run does not lose the message (B6)', async () => {
    const gate = deferred();
    const w = world({
      server: async (path, body) => {
        if (path === '/api/generate/quick') await gate.promise;
        return okServer(path, body);
      },
    });
    const panel = await openPanel(w);
    panel.$('generate-btn').click();
    await until(async () => (await w.job('/in/aoife/'))?.step === 'writing');
    expect(panel.$('close-hint').classList.contains('hidden')).toBe(false);

    panel.close(); // e.g. the user clicks on the LinkedIn page
    gate.resolve(); // ...and the server answers while nothing is open

    await until(async () => (await w.job('/in/aoife/'))?.step === 'done');
    expect((await w.recent())[0].message).toBe('Hi Aoife!');

    const reopened = await openPanel(w);
    expect(reopened.$('generated-message').value).toBe('Hi Aoife!');
    expect(reopened.$('message-section').classList.contains('hidden')).toBe(false);
  });

  it('Deep Mode runs every step from one click (B4)', async () => {
    const gate = deferred();
    const w = world({
      server: async (path, body) => {
        if (path === '/api/generate/deep') await gate.promise;
        return okServer(path, body);
      },
    });
    const panel = await openPanel(w);
    panel.$('mode-deep').click();
    panel.$('generate-btn').click();

    // Mid-run: live progress, and the talking points show before writing ends.
    await until(() => dotOf(panel, 'writing').includes('running'));
    expect(dotOf(panel, 'reading')).toContain('done');
    expect(dotOf(panel, 'enriching')).toContain('done');
    expect(panel.$('hooks-list').textContent).toContain('Spotify opened a Dublin office');

    gate.resolve();
    await until(() => panel.$('generated-message').value === 'Deep hello, Aoife');
    await settle();
    expect(w.calls.map((c) => c.path)).toEqual(['/api/generate/enrich', '/api/generate/deep']);
    expect(panel.$('status-message').textContent).toBe('Message ready. 8 left today.');
    expect(panel.$('key-status').textContent).toBe('● 8 left today');
    expect(panel.$('steps').classList.contains('hidden')).toBe(true); // out of the way once done
  });

  it('"New version" only rewrites: no second page read, no second enrichment', async () => {
    const w = world();
    const panel = await openPanel(w);
    panel.$('mode-deep').click();
    panel.$('generate-btn').click();
    await until(() => panel.$('generated-message').value === 'Deep hello, Aoife');

    panel.$('regenerate-btn').click();
    await until(async () => w.calls.length === 3 && (await w.job('/in/aoife/')).step === 'done');
    expect(w.calls.map((c) => c.path)).toEqual(['/api/generate/enrich', '/api/generate/deep', '/api/generate/deep']);
    const reads = w.chrome.tabs.sendMessage.mock.calls.filter(([, m]) => m.action === 'scrapeProfile');
    expect(reads).toHaveLength(1);
  });

  it('follows tab switches and LinkedIn page changes', async () => {
    const w = world({
      tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }, { id: 2, url: LIAM.profileUrl, active: false }],
      pages: { 1: AOIFE, 2: LIAM },
    });
    const panel = await openPanel(w);
    await until(() => panel.$('profile-name').textContent === 'Aoife'); // shown before generating
    panel.$('generate-btn').click();
    await until(() => panel.$('generated-message').value === 'Hi Aoife!');

    w.activate(2);
    await until(() => panel.$('profile-name').textContent === 'Liam');
    expect(panel.$('message-section').classList.contains('hidden')).toBe(true);

    w.activate(1);
    await until(() => panel.$('profile-name').textContent === 'Aoife');
    expect(panel.$('generated-message').value).toBe('Hi Aoife!');

    w.navigate(1, 'https://www.linkedin.com/feed/');
    await until(() => !panel.$('page-warning').classList.contains('hidden'));
    expect(panel.$('generate-btn').disabled).toBe(true);
  });

  it('a run cut off by Chrome shows "try again", not an endless spinner', async () => {
    const old = Date.now() - 5 * 60 * 1000;
    const stuck = {
      profileKey: '/in/aoife/', profileUrl: AOIFE.profileUrl, tabId: 1, mode: 'deep',
      step: 'enriching', startedAt: old, updatedAt: old,
    };
    const w = world({ session: { 'job:/in/aoife/': stuck } });
    const panel = await openPanel(w);
    await until(() => panel.$('status-message').textContent.includes('interrupted'));
    expect(panel.$('generate-btn').disabled).toBe(false);
    expect(dotOf(panel, 'enriching')).toContain('error');
  });

  it('edits are kept when the panel is closed and opened again', async () => {
    const w = world();
    let panel = await openPanel(w);
    panel.$('generate-btn').click();
    await until(() => panel.$('generated-message').value === 'Hi Aoife!');

    type(panel.$('generated-message'), 'Hi Aoife! (my own edit)');
    await settle();
    panel.close();

    panel = await openPanel(w);
    expect(panel.$('generated-message').value).toBe('Hi Aoife! (my own edit)');
    expect((await w.recent())[0]).toMatchObject({ message: 'Hi Aoife! (my own edit)', edited: true });
  });

  it('remembers the message type and tone you picked last time', async () => {
    const w = world();
    let panel = await openPanel(w);
    panel.$('message-type').value = 'Referral';
    fire(panel.$('message-type'), 'change');
    panel.$('tone').value = 'Casual';
    fire(panel.$('tone'), 'change');
    await settle();
    panel.close();

    panel = await openPanel(w);
    expect(panel.$('message-type').value).toBe('Referral');
    expect(panel.$('tone').value).toBe('Casual');
  });
});
