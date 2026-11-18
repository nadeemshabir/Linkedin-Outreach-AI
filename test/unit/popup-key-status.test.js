import { describe, it, expect } from 'vitest';
import { bootPopup } from '../helpers/popup.js';

const KEY = 'ARK-TEST-0000-0000';
const validates = (answer) => (msg) => (msg.type === 'VALIDATE_KEY' ? answer : undefined);

describe('header shows the real license key status (B5)', () => {
  it('no key saved: says so and shows the warning', async () => {
    const { $ } = await bootPopup();
    expect($('key-status').textContent).toBe('No Key');
    expect($('no-key-warning').classList.contains('hidden')).toBe(false);
  });

  it('a key the server accepts shows how many messages are left', async () => {
    const { $ } = await bootPopup({ local: { licenseKey: KEY }, onMessage: validates({ valid: true, remaining: 17 }) });
    expect($('key-status').textContent).toBe('● 17 left today');
    expect($('key-status').className).toContain('active');
    expect($('no-key-warning').classList.contains('hidden')).toBe(true);
  });

  it('a key the server rejects is NOT shown as active', async () => {
    const { $ } = await bootPopup({
      local: { licenseKey: KEY },
      onMessage: validates({ valid: false, reason: 'Invalid license key.' }),
    });
    expect($('key-status').textContent).toBe('Invalid key');
    expect($('key-status').textContent).not.toMatch(/active/i);
    expect($('no-key-warning').classList.contains('hidden')).toBe(false);
    expect($('no-key-warning').textContent).toMatch(/Invalid license key\./);
  });

  it('server unreachable: says "Not verified" but does not block the user', async () => {
    const { $ } = await bootPopup({
      local: { licenseKey: KEY },
      onMessage: validates({ valid: false, reason: 'Could not reach the server.', code: 'offline' }),
    });
    expect($('key-status').textContent).toBe('Not verified');
    expect($('no-key-warning').classList.contains('hidden')).toBe(true);
    expect($('scrape-btn').disabled).toBe(false);
  });

  it('does not ask the server again within 10 minutes', async () => {
    const cached = { key: KEY, state: 'valid', remaining: 9, checkedAt: Date.now() - 60_000 };
    const { $, chrome } = await bootPopup({ local: { licenseKey: KEY, keyStatus: cached } });
    expect($('key-status').textContent).toBe('● 9 left today');
    const calls = chrome.runtime.sendMessage.mock.calls.filter(([m]) => m.type === 'VALIDATE_KEY');
    expect(calls).toHaveLength(0);
  });

  it('flips to "Invalid key" when the server rejects the key during a generate', async () => {
    const cached = { key: KEY, state: 'valid', remaining: 9, checkedAt: Date.now() };
    const { $ } = await bootPopup({
      local: { licenseKey: KEY, keyStatus: cached },
      onMessage: (msg) => {
        if (msg.action === 'scrapeProfile') return { success: true, data: { name: 'Aoife', profileUrl: 'https://www.linkedin.com/in/aoife-test/' } };
        if (msg.action === 'generateMessage') return { success: false, error: 'Invalid license key.', code: 'http_403' };
        return undefined;
      },
    });
    expect($('key-status').textContent).toBe('● 9 left today');
    $('scrape-btn').click();
    await new Promise((r) => setTimeout(r, 30));
    expect($('key-status').textContent).toBe('Invalid key');
    expect($('status-message').textContent).toBe('Invalid license key.');
  });

  it('checks again when the cached result is for a different key', async () => {
    const cached = { key: 'ARK-OLD0-0000-0000', state: 'valid', remaining: 9, checkedAt: Date.now() };
    const { $ } = await bootPopup({
      local: { licenseKey: KEY, keyStatus: cached },
      onMessage: validates({ valid: false, reason: 'Invalid license key.' }),
    });
    expect($('key-status').textContent).toBe('Invalid key');
  });
});
