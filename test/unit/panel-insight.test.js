// Common ground, the goal box and the message check, with the real panel
// and background working together (Phase 4).
import { describe, it, expect } from 'vitest';
import { createWorld, openPanel, person, until, settle, type, KEY } from '../helpers/world.js';

const ME = {
  name: 'Rahul Sharma',
  location: 'Dublin, County Dublin, Ireland',
  currentCompany: 'Accenture',
  pastCompanies: [],
  educationEntries: ['Trinity College Dublin — MSc Data Science'],
  skills: ['Python'],
  importedAt: Date.now(),
};
const AOIFE = person('aoife', 'Aoife Murphy', {
  location: 'Dublin, County Dublin, Ireland',
  currentCompany: 'Spotify',
  pastCompanies: ['Accenture'],
  educationEntries: ['Trinity College Dublin — MSc Computer Science'],
  skills: ['Python', 'SQL'],
});
const VALID = () => ({ key: KEY, state: 'valid', remaining: 9, checkedAt: Date.now() });

function world({ local = {}, message = 'Hi Aoife, fellow Trinity College Dublin grad here, and ex-Accenture too. Open to a quick chat?', requests = [] } = {}) {
  return createWorld({
    local: { licenseKey: KEY, keyStatus: VALID(), ...local },
    tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }],
    pages: { 1: AOIFE },
    server: (path, body) => {
      requests.push({ path, body });
      if (path === '/api/generate/enrich') {
        return [200, { success: true, profileJSON: { name: 'Aoife Murphy' }, enrichmentJSON: { topHooks: ['Spotify opened a Dublin ML hub'] } }];
      }
      return [200, { success: true, message: typeof message === 'function' ? message(body) : message }];
    },
  });
}

async function generate(panel) {
  panel.$('generate-btn').click();
  await until(() => !panel.$('message-section').classList.contains('hidden'));
  await settle();
}

const chipTexts = (panel) => [...panel.$('cg-chips').querySelectorAll('.cg-chip')]
  .map((c) => `${c.getAttribute('aria-pressed') === 'true' ? '[x]' : '[ ]'} ${c.textContent}`);

describe('your own profile', () => {
  it('without it, a tip explains how to get common ground', async () => {
    const panel = await openPanel(world());
    expect(panel.$('cg-tip').classList.contains('hidden')).toBe(false);
    await generate(panel);
    expect(panel.$('common-ground').classList.contains('hidden')).toBe(true);
  });

  it('can be added from the profile you are on', async () => {
    const w = world();
    const panel = await openPanel(w); // standing on a profile (here: Aoife's, as a stand-in for your own)
    panel.$('import-me-btn').click();
    await until(async () => (await w.chrome.storage.local.get('myProfile')).myProfile);
    await until(() => panel.$('me-status').textContent.startsWith('Aoife Murphy · added'));
    expect(panel.$('cg-tip').classList.contains('hidden')).toBe(true);
    expect(panel.$('remove-me-btn').classList.contains('hidden')).toBe(false);
  });
});

describe('common ground', () => {
  it('shows what you share, with the strong ones picked for the writer', async () => {
    const requests = [];
    const panel = await openPanel(world({ local: { myProfile: ME }, requests }));
    await generate(panel);
    expect(chipTexts(panel)).toEqual([
      '[x] 🎓 studied at Trinity College Dublin',
      '[x] 💼 worked at Accenture',
      '[ ] 📍 in Dublin',
    ]);
    expect(requests[0].body.userBio).toContain(
      '[Shared with the recipient, mention one naturally: We both studied at Trinity College Dublin; We have both worked at Accenture.]');
  });

  it('your picks are used for "New version" (Deep Mode puts them first in the hooks)', async () => {
    const requests = [];
    const panel = await openPanel(world({ local: { myProfile: ME }, requests }));
    panel.$('mode-deep').click();
    await generate(panel);

    const chips = panel.$('cg-chips').querySelectorAll('.cg-chip');
    chips[1].click(); // skip Accenture
    chips[2].click(); // use Dublin
    panel.$('regenerate-btn').click();
    await until(() => requests.filter((r) => r.path === '/api/generate/deep').length === 2);

    const second = requests.filter((r) => r.path === '/api/generate/deep')[1].body;
    expect(second.enrichmentJSON.topHooks).toEqual([
      'We both studied at Trinity College Dublin',
      'We are both based in Dublin',
      'Spotify opened a Dublin ML hub',
    ]);
    expect(second.enrichmentJSON.outreachContext.commonGround).toEqual([
      'We both studied at Trinity College Dublin', 'We are both based in Dublin',
    ]);
  });
});

describe('goal', () => {
  it('reaches the writer, and stays with this person when you come back', async () => {
    const requests = [];
    const w = world({ requests });
    let panel = await openPanel(w);
    type(panel.$('goal'), 'Referral for the Data Analyst role');
    await generate(panel);
    expect(requests[0].body.userBio).toContain("[Sender's goal: Referral for the Data Analyst role]");

    panel.close();
    panel = await openPanel(w);
    expect(panel.$('goal').value).toBe('Referral for the Data Analyst role');
  });
});

describe('message check', () => {
  it('a weak AI draft is called out, line by line', async () => {
    const panel = await openPanel(world({ message: 'Hi Aoife, I came across your profile and would like to connect.' }));
    await generate(panel);
    expect(panel.$('strength-score').textContent).toBe('Needs work');
    const items = [...panel.$('strength-list').children].map((li) => `${li.className}: ${li.firstChild.textContent}`);
    expect(items).toEqual([
      'ok: Fits the 200-character note',
      'fail: Nothing specific about Aoife yet',
      'fail: No clear ask',
      'fail: Cliché: "I came across your profile"',
    ]);
  });

  it('updates as you edit', async () => {
    const panel = await openPanel(world({ message: 'Hi Aoife, I came across your profile and would like to connect.' }));
    await generate(panel);
    type(panel.$('generated-message'), 'Hi Aoife, your Spotify recommendations work is exactly what I want to do. Open to a 15-minute chat?');
    expect(panel.$('strength-score').textContent).toBe('Strong');
  });

  it('flags a name in the AI draft that no source backs up', async () => {
    const panel = await openPanel(world({ message: 'Hi Aoife, I enjoyed your PyData Berlin talk about Spotify. Open to a chat?' }));
    await generate(panel);
    const warn = panel.$('strength-list').querySelector('li.warn');
    expect(warn.firstChild.textContent).toBe('Check: "PyData Berlin"');
    expect(warn.querySelector('.tip').textContent).toMatch(/Make sure it is true/);
  });
});
