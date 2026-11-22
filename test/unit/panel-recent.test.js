// The tracker keeps the message the user actually has: the newest version,
// with their own edits (B7).
import { describe, it, expect } from 'vitest';
import { createWorld, openPanel, person, until, settle, type, claudeReply, API_KEY } from '../helpers/world.js';

const AOIFE = person('aoife', 'Aoife');

describe('Recent stays in sync with what the user actually has (B7)', () => {
  it('"New version" replaces the saved message (AI Mode, Quick)', async () => {
    let n = 0;
    const w = createWorld({
      local: { userApiKey: API_KEY },
      tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }],
      pages: { 1: AOIFE },
      claude: () => claudeReply(`draft ${++n}`),
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

  it('edits typed into the message box are saved (Free Mode)', async () => {
    const w = createWorld({
      tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }],
      pages: { 1: AOIFE },
    });
    const panel = await openPanel(w);
    panel.$('generate-btn').click();
    await until(() => panel.$('status-message').textContent === 'Message ready. Written in Free Mode.');
    const draft = panel.$('generated-message').value;
    expect((await w.recent())[0]).toMatchObject({ message: draft, edited: false });

    type(panel.$('generated-message'), `${draft} Thanks!`);
    await settle();
    expect((await w.recent())[0]).toMatchObject({ message: `${draft} Thanks!`, edited: true });
  });

  it('Deep Mode keeps each person separate as you move between profiles in one tab (Free Mode)', async () => {
    // Headlines with "at": the talking points may then name where they work.
    const aoife = person('aoife', 'Aoife', { headline: 'Data Scientist at Spotify' });
    const liam  = person('liam', 'Liam', { headline: 'Engineering Manager at Stripe', currentCompany: 'Stripe' });
    const w = createWorld({
      tabs: [{ id: 1, url: aoife.profileUrl, active: true }],
      pages: { 1: aoife },
    });
    const talkingPoints = (panel) => [...panel.$('hooks-list').children].map((el) => el.textContent);
    const panel = await openPanel(w);
    panel.$('mode-deep').click();
    panel.$('generate-btn').click();
    await until(() => panel.$('generated-message').value.startsWith('Hi Aoife,'));
    expect(talkingPoints(panel)).toEqual(['Works at Spotify']);

    w.navigate(1, liam.profileUrl, liam);
    await until(() => panel.$('profile-name').textContent === 'Liam');
    panel.$('generate-btn').click();
    await until(() => panel.$('generated-message').value.startsWith('Hi Liam,'));
    expect(talkingPoints(panel)).toEqual(['Works at Stripe']);
    await settle();

    // Two entries, each with its own link and its own draft. (Not checked by
    // order: that comes from the clock, which is not what this test is about.)
    const saved = await w.recent();
    expect(saved).toHaveLength(2);
    const byName = Object.fromEntries(saved.map((c) => [c.name, c]));
    expect(byName.Aoife).toMatchObject({ profileUrl: 'https://www.linkedin.com/in/aoife/', message: expect.stringMatching(/^Hi Aoife,/) });
    expect(byName.Liam).toMatchObject({ profileUrl: 'https://www.linkedin.com/in/liam/', message: expect.stringMatching(/^Hi Liam,/) });
  });
});
