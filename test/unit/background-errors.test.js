// Server errors and timeouts (B8, B9), through the background's job runner.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWorld, person, until, KEY, RUNNING } from '../helpers/world.js';

const AOIFE = person('aoife', 'Aoife');
const QUICK = { tabId: 1, mode: 'quick', messageType: 'Networking', tone: 'Neutral' };
const DEEP  = { ...QUICK, mode: 'deep' };

function world(server) {
  return createWorld({
    local: { licenseKey: KEY },
    tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }],
    pages: { 1: AOIFE },
    server,
  });
}

async function finished(w) {
  return until(async () => {
    const job = await w.job('/in/aoife/');
    return job && !RUNNING.includes(job.step) ? job : null;
  });
}

const html = (status, text) => new Response(text, { status, headers: { 'Content-Type': 'text/html' } });

afterEach(() => vi.useRealTimers());

describe('server errors are shown in plain words (B8)', () => {
  it('an HTML error page (e.g. 502) does not leak a JSON parse error', async () => {
    const w = world(() => html(502, '<!DOCTYPE html><html><body>Bad Gateway</body></html>'));
    expect((await w.start(QUICK)).ok).toBe(true);
    const job = await finished(w);
    expect(job.step).toBe('error');
    expect(job.error.message).not.toMatch(/Unexpected token|JSON/i);
    expect(job.error.message).toMatch(/server is having trouble/i);
  });

  it("keeps the server's own reason, and marks the key as rejected", async () => {
    const w = world(() => [403, { error: 'Invalid license key.' }]);
    await w.start(QUICK);
    const job = await finished(w);
    expect(job.error).toEqual({ message: 'Invalid license key.', code: 'http_403' });
    const { keyStatus } = await w.chrome.storage.local.get('keyStatus');
    expect(keyStatus).toMatchObject({ key: KEY, state: 'invalid', reason: 'Invalid license key.' });
  });

  it('explains a network failure', async () => {
    const w = world(() => { throw new TypeError('Failed to fetch'); });
    await w.start(QUICK);
    const job = await finished(w);
    expect(job.error.message).toMatch(/could not reach the server/i);
  });

  it('still returns the message when everything works', async () => {
    const w = world(() => [200, { success: true, message: 'Hi Aoife!' }]);
    await w.start(QUICK);
    const job = await finished(w);
    expect(job).toMatchObject({ step: 'done', message: 'Hi Aoife!' });
    expect(w.calls[0].path).toBe('/api/generate/quick');
  });
});

describe('requests time out instead of spinning forever (B9)', () => {
  it('quick generate gives up with a clear message', async () => {
    vi.useFakeTimers();
    const w = world(() => 'hang');
    await w.start(QUICK);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const job = await w.job('/in/aoife/');
    expect(job.step).toBe('error');
    expect(job.error.message).toMatch(/took too long/i);
  });

  it('deep enrich gives up with a clear message, at the right step', async () => {
    vi.useFakeTimers();
    const w = world(() => 'hang');
    await w.start(DEEP);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const job = await w.job('/in/aoife/');
    expect(job).toMatchObject({ step: 'error', failedStep: 'enriching' });
    expect(job.error.message).toMatch(/took too long/i);
  });

  it('key check gives up and says why', async () => {
    vi.useFakeTimers();
    const w = world(() => 'hang');
    const pending = w.chrome.runtime.sendMessage({ type: 'VALIDATE_KEY', payload: { key: KEY } });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const res = await pending;
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/took too long/i);
  });
});

describe('job guard rails', () => {
  it('"New version" is accepted the instant a run shows done (no lock race)', async () => {
    const w = world(() => [200, { success: true, message: 'Hi Aoife!' }]);
    const answers = [];
    // React exactly when "done" is saved: that is when the panel shows the
    // message and the user can press "New version".
    w.chrome.storage.onChanged.addListener((changes, area) => {
      const job = changes['job:/in/aoife/'] && changes['job:/in/aoife/'].newValue;
      if (area === 'session' && job && job.step === 'done' && answers.length === 0) {
        answers.push(w.start({ ...QUICK, regenerate: true }));
      }
    });
    await w.start(QUICK);
    await until(() => answers.length === 1);
    expect(await answers[0]).toMatchObject({ ok: true });
  });

  it('refuses to start without a license key', async () => {
    const w = createWorld({ tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }], pages: { 1: AOIFE } });
    expect(await w.start(QUICK)).toMatchObject({ ok: false, code: 'no_key' });
  });

  it('refuses to start when the tab is not a LinkedIn profile', async () => {
    const w = createWorld({ local: { licenseKey: KEY }, tabs: [{ id: 1, url: 'https://www.linkedin.com/feed/', active: true }] });
    expect(await w.start(QUICK)).toMatchObject({ ok: false });
  });

  it('stops if the tab moved to another person before reading', async () => {
    const w = world(() => [200, { success: true, message: 'x' }]);
    // The first look at the tab (job start) sees Aoife; by the time the page
    // is read, the user has clicked through to someone else.
    const realGet = w.chrome.tabs.get;
    let looks = 0;
    w.chrome.tabs.get = vi.fn(async (id) => {
      const tab = await realGet(id);
      if (++looks > 1) tab.url = 'https://www.linkedin.com/in/someone-else/';
      return tab;
    });
    await w.start(QUICK);
    const job = await finished(w);
    expect(job.step).toBe('error');
    expect(job.error.message).toMatch(/moved to another page/i);
  });
});
