import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFakeChrome } from '../helpers/fake-chrome.js';
import { runIsolated } from '../helpers/load.js';

function setup(fetchImpl, local = { licenseKey: 'ARK-TEST-0000-0000' }) {
  const { chrome, dispatchMessage } = createFakeChrome({ local });
  const fetch = vi.fn(fetchImpl);
  runIsolated('background.js', { chrome, fetch, setTimeout, clearTimeout, AbortController });
  return { fetch, send: dispatchMessage };
}

const quick = {
  action: 'generateMessage',
  data: { profileData: { name: 'Aoife' }, settings: { userName: 'Rahul', userBio: '' }, messageType: 'Networking', tone: 'Neutral' },
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const html = (status, text) => new Response(text, { status, headers: { 'Content-Type': 'text/html' } });

// A fetch that never answers, but stops when the request is aborted.
const hangingFetch = (_url, { signal } = {}) => new Promise((_resolve, reject) => {
  signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
});

afterEach(() => vi.useRealTimers());

describe('server errors are shown in plain words (B8)', () => {
  it('an HTML error page (e.g. 502) does not leak a JSON parse error', async () => {
    const { send } = setup(async () => html(502, '<!DOCTYPE html><html><body>Bad Gateway</body></html>'));
    const res = await send(quick);
    expect(res.success).toBe(false);
    expect(res.error).not.toMatch(/Unexpected token|JSON/i);
    expect(res.error).toMatch(/server is having trouble/i);
  });

  it("keeps the server's own reason when it gives one", async () => {
    const { send } = setup(async () => json(403, { error: 'Invalid license key.' }));
    const res = await send(quick);
    expect(res).toEqual({ success: false, error: 'Invalid license key.' });
  });

  it('explains a network failure', async () => {
    const { send } = setup(async () => { throw new TypeError('Failed to fetch'); });
    const res = await send(quick);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/could not reach the server/i);
  });

  it('still returns the message when everything works', async () => {
    const { send, fetch } = setup(async () => json(200, { success: true, message: 'Hi Aoife!' }));
    const res = await send(quick);
    expect(res).toEqual({ success: true, generatedMessage: 'Hi Aoife!' });
    expect(fetch.mock.calls[0][0]).toMatch(/\/api\/generate\/quick$/);
  });
});

describe('requests time out instead of spinning forever (B9)', () => {
  it('quick generate gives up with a clear message', async () => {
    vi.useFakeTimers();
    const { send } = setup(hangingFetch);
    const pending = send(quick);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const res = await pending;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/took too long/i);
  });

  it('deep enrich gives up with a clear message', async () => {
    vi.useFakeTimers();
    const { send } = setup(hangingFetch);
    const pending = send({ type: 'RUN_ENRICH', payload: { rawProfileData: { name: 'Aoife' } } });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const res = await pending;
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/took too long/i);
  });

  it('key check gives up and says why', async () => {
    vi.useFakeTimers();
    const { send } = setup(hangingFetch);
    const pending = send({ type: 'VALIDATE_KEY', payload: { key: 'ARK-TEST-0000-0000' } });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const res = await pending;
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/took too long/i);
  });
});
