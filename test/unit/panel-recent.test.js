// Recent keeps the message the user actually has (B7).
import { describe, it, expect } from 'vitest';
import { createWorld, openPanel, person, until, settle, type, KEY } from '../helpers/world.js';

const VALID = () => ({ key: KEY, state: 'valid', remaining: 9, checkedAt: Date.now() });

describe('Recent stays in sync with what the user actually has (B7)', () => {
  it('"New version" replaces the saved message (Quick Mode)', async () => {
    let n = 0;
    const aoife = person('aoife', 'Aoife');
    const w = createWorld({
      local: { licenseKey: KEY, keyStatus: VALID() },
      tabs: [{ id: 1, url: aoife.profileUrl, active: true }],
      pages: { 1: aoife },
      server: () => [200, { success: true, message: `draft ${++n}` }],
    });
    const panel = await openPanel(w);
    panel.$('generate-btn').click();
    await until(() => panel.$('generated-message').value === 'draft 1');
    expect((await w.recent())[0].message).toBe('draft 1');

    panel.$('regenerate-btn').click();
    await until(() => panel.$('generated-message').value === 'draft 2');
    await settle();
    const saved = await w.recent();
    expect(saved).toHaveLength(1);
    expect(saved[0].message).toBe('draft 2');
  });

  it('edits typed into the message box are saved', async () => {
    const aoife = person('aoife', 'Aoife');
    const w = createWorld({
      local: { licenseKey: KEY, keyStatus: VALID() },
      tabs: [{ id: 1, url: aoife.profileUrl, active: true }],
      pages: { 1: aoife },
      server: () => [200, { success: true, message: 'AI draft' }],
    });
    const panel = await openPanel(w);
    panel.$('generate-btn').click();
    await until(() => panel.$('generated-message').value === 'AI draft');
    type(panel.$('generated-message'), 'AI draft, edited by me');
    await settle();
    expect((await w.recent())[0]).toMatchObject({ message: 'AI draft, edited by me', edited: true });
  });

  it('Deep Mode keeps each person separate even if the server omits profileUrl', async () => {
    const aoife = person('aoife', 'Aoife');
    const liam  = person('liam', 'Liam');
    const w = createWorld({
      local: { licenseKey: KEY, keyStatus: VALID() },
      tabs: [{ id: 1, url: aoife.profileUrl, active: true }],
      pages: { 1: aoife },
      server: (path, body) => {
        // The server's structured profile has no profileUrl field.
        if (path === '/api/generate/enrich') {
          return [200, { success: true, profileJSON: { name: body.rawProfileData.name }, enrichmentJSON: { topHooks: [] } }];
        }
        return [200, { success: true, message: `Hi ${body.profileJSON.name}`, remaining: 8 }];
      },
    });
    const panel = await openPanel(w);
    panel.$('mode-deep').click();
    panel.$('generate-btn').click();
    await until(() => panel.$('generated-message').value === 'Hi Aoife');

    w.navigate(1, liam.profileUrl, liam);
    await until(() => panel.$('profile-name').textContent === 'Liam');
    panel.$('generate-btn').click();
    await until(() => panel.$('generated-message').value === 'Hi Liam');
    await settle();

    const saved = await w.recent();
    expect(saved.map((c) => c.name)).toEqual(['Liam', 'Aoife']);
    expect(saved.map((c) => c.profileUrl)).toEqual([
      'https://www.linkedin.com/in/liam/',
      'https://www.linkedin.com/in/aoife/',
    ]);
  });
});
