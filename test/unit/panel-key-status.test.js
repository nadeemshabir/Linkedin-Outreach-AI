// The header badge shows the key's real status (B5).
import { describe, it, expect } from 'vitest';
import { createWorld, openPanel, person, until, KEY } from '../helpers/world.js';

const AOIFE = person('aoife', 'Aoife');

function world({ local = {}, server }) {
  return createWorld({
    local,
    tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }],
    pages: { 1: AOIFE },
    server,
  });
}

const validates = (answer) => (path) => (path === '/api/validate' ? answer() : [404, {}]);

describe('header shows the real license key status (B5)', () => {
  it('no key saved: says so and shows the warning', async () => {
    const panel = await openPanel(world({ server: () => [404, {}] }));
    expect(panel.$('key-status').textContent).toBe('No Key');
    expect(panel.$('no-key-warning').classList.contains('hidden')).toBe(false);
  });

  it('a key the server accepts shows how many messages are left', async () => {
    const panel = await openPanel(world({ local: { licenseKey: KEY }, server: validates(() => [200, { valid: true, remaining: 17 }]) }));
    expect(panel.$('key-status').textContent).toBe('● 17 left today');
    expect(panel.$('key-status').className).toContain('active');
    expect(panel.$('no-key-warning').classList.contains('hidden')).toBe(true);
  });

  it('a key the server rejects is NOT shown as active', async () => {
    const panel = await openPanel(world({
      local: { licenseKey: KEY },
      server: validates(() => [200, { valid: false, reason: 'Invalid license key.' }]),
    }));
    expect(panel.$('key-status').textContent).toBe('Invalid key');
    expect(panel.$('no-key-warning').classList.contains('hidden')).toBe(false);
    expect(panel.$('no-key-warning').textContent).toMatch(/Invalid license key\./);
  });

  it('server unreachable: says "Not verified" but does not block the user', async () => {
    const panel = await openPanel(world({
      local: { licenseKey: KEY },
      server: () => { throw new TypeError('Failed to fetch'); },
    }));
    expect(panel.$('key-status').textContent).toBe('Not verified');
    expect(panel.$('no-key-warning').classList.contains('hidden')).toBe(true);
    expect(panel.$('generate-btn').disabled).toBe(false);
  });

  it('does not ask the server again within 10 minutes', async () => {
    const cached = { key: KEY, state: 'valid', remaining: 9, checkedAt: Date.now() - 60_000 };
    const w = world({ local: { licenseKey: KEY, keyStatus: cached }, server: () => [404, {}] });
    const panel = await openPanel(w);
    expect(panel.$('key-status').textContent).toBe('● 9 left today');
    expect(w.calls.filter((c) => c.path === '/api/validate')).toHaveLength(0);
  });

  it('flips to "Invalid key" when the server rejects the key during a generate', async () => {
    const cached = { key: KEY, state: 'valid', remaining: 9, checkedAt: Date.now() };
    const panel = await openPanel(world({
      local: { licenseKey: KEY, keyStatus: cached },
      server: (path) => (path === '/api/generate/quick' ? [403, { error: 'Invalid license key.' }] : [404, {}]),
    }));
    expect(panel.$('key-status').textContent).toBe('● 9 left today');
    panel.$('generate-btn').click();
    await until(() => panel.$('key-status').textContent === 'Invalid key');
    expect(panel.$('status-message').textContent).toBe('Invalid license key.');
  });

  it('checks again when the cached result is for a different key', async () => {
    const cached = { key: 'ARK-OLD0-0000-0000', state: 'valid', remaining: 9, checkedAt: Date.now() };
    const panel = await openPanel(world({
      local: { licenseKey: KEY, keyStatus: cached },
      server: validates(() => [200, { valid: false, reason: 'Invalid license key.' }]),
    }));
    expect(panel.$('key-status').textContent).toBe('Invalid key');
  });
});
