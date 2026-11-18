import { describe, it, expect } from 'vitest';
import { bootPopup, settle, type } from '../helpers/popup.js';

const KEY = 'ARK-TEST-0000-0000';
const VALID = { key: KEY, state: 'valid', remaining: 9, checkedAt: Date.now() };

function person(slug, name) {
  return { name, headline: `${name} headline`, currentCompany: 'Spotify', profileUrl: `https://www.linkedin.com/in/${slug}/` };
}

async function recent(chrome) {
  return (await chrome.storage.local.get(['recentContacts'])).recentContacts || [];
}

describe('Recent stays in sync with what the user actually has (B7)', () => {
  it('Regenerate replaces the saved message (Quick Mode)', async () => {
    let n = 0;
    const { chrome, $ } = await bootPopup({
      local: { licenseKey: KEY, keyStatus: VALID },
      onMessage: (msg) => {
        if (msg.action === 'scrapeProfile') return { success: true, data: person('aoife', 'Aoife') };
        if (msg.action === 'generateMessage') return { success: true, generatedMessage: `draft ${++n}` };
        return undefined;
      },
    });
    $('scrape-btn').click(); await settle(10);
    expect((await recent(chrome))[0].message).toBe('draft 1');

    $('regenerate-btn').click(); await settle(10);
    expect($('generated-message').value).toBe('draft 2');
    const saved = await recent(chrome);
    expect(saved).toHaveLength(1);
    expect(saved[0].message).toBe('draft 2');
  });

  it('edits typed into the message box are saved', async () => {
    const { chrome, $ } = await bootPopup({
      local: { licenseKey: KEY, keyStatus: VALID },
      onMessage: (msg) => {
        if (msg.action === 'scrapeProfile') return { success: true, data: person('aoife', 'Aoife') };
        if (msg.action === 'generateMessage') return { success: true, generatedMessage: 'AI draft' };
        return undefined;
      },
    });
    $('scrape-btn').click(); await settle(10);
    type($('generated-message'), 'AI draft, edited by me');
    await settle(10);
    const [saved] = await recent(chrome);
    expect(saved.message).toBe('AI draft, edited by me');
    expect(saved.edited).toBe(true);
  });

  it('Deep Mode keeps each person separate even if the server omits profileUrl', async () => {
    let current = person('aoife', 'Aoife');
    const { chrome, $ } = await bootPopup({
      local: { licenseKey: KEY, keyStatus: VALID },
      onMessage: (msg) => {
        if (msg.action === 'scrapeProfile') return { success: true, data: current };
        // The server's structured profile has no profileUrl field.
        if (msg.type === 'RUN_ENRICH') return { status: 'enrich_complete', profileJSON: { name: current.name }, enrichmentJSON: { topHooks: [] } };
        if (msg.type === 'RUN_GENERATE') return { status: 'generate_complete', generatedMessage: `Hi ${current.name}`, remaining: 8 };
        return undefined;
      },
    });
    $('mode-deep').click();

    $('enrich-btn').click(); await settle(10);
    $('deep-generate-btn').click(); await settle(10);

    current = person('liam', 'Liam');
    $('enrich-btn').click(); await settle(10);
    $('deep-generate-btn').click(); await settle(10);

    const saved = await recent(chrome);
    expect(saved.map((c) => c.name)).toEqual(['Liam', 'Aoife']);
    expect(saved.map((c) => c.profileUrl)).toEqual([
      'https://www.linkedin.com/in/liam/',
      'https://www.linkedin.com/in/aoife/',
    ]);
  });
});
