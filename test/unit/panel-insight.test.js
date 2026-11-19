// Common ground, the goal box and the message check, with the real panel
// and the real background working together (Phase 4). Both writers use what
// you share and your goal: AI Mode puts them in Claude's prompt, and Free
// Mode puts them in the template.
import { describe, it, expect } from 'vitest';
import { createWorld, openPanel, person, until, settle, type, claudeReply, promptText, API_KEY } from '../helpers/world.js';

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
const LIAM = person('liam', 'Liam Byrne');
const AI_DRAFT = 'Hi Aoife, fellow Trinity College Dublin grad here, and ex-Accenture too. Open to a quick chat?';

// Free Mode by default (no key). With key: API_KEY, AI Mode, and a fake
// Claude that sends back `reply`.
function world({ local = {}, key = null, reply = AI_DRAFT } = {}) {
  return createWorld({
    local: key ? { userApiKey: key, ...local } : local,
    tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }],
    pages: { 1: AOIFE },
    pagesByUrl: { [AOIFE.profileUrl]: AOIFE, [LIAM.profileUrl]: LIAM },
    claude: () => claudeReply(reply),
  });
}

async function generate(panel) {
  panel.$('generate-btn').click();
  await until(() => !panel.$('message-section').classList.contains('hidden'));
  await settle();
}

// One line of what Claude was asked, for request number n (0 = the first).
const promptLine = (w, n, start) => promptText(w.calls[n].body).split('\n').find((l) => l.startsWith(start)) || null;

// A tagged block of what Claude was asked (like <common_ground>), read back as data.
function taggedBlock(w, n, tag) {
  const m = promptText(w.calls[n].body).match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  return m ? JSON.parse(m[1]) : null;
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
  it('shows what you share, and the strong ones reach Claude (AI Mode)', async () => {
    const w = world({ key: API_KEY, local: { myProfile: ME } });
    const panel = await openPanel(w);
    await generate(panel);
    expect(chipTexts(panel)).toEqual([
      '[x] 🎓 studied at Trinity College Dublin',
      '[x] 💼 worked at Accenture',
      '[ ] 📍 in Dublin',
    ]);
    // It comes from LinkedIn pages, so it goes in its own block, as data.
    expect(promptLine(w, 0, 'We have something in common')).toBe(
      'We have something in common (see <common_ground>). Mention one item naturally.');
    expect(taggedBlock(w, 0, 'common_ground')).toEqual([
      'We both studied at Trinity College Dublin', 'We have both worked at Accenture',
    ]);
  });

  it('Free Mode: the note starts with the strongest one, and passes the message check', async () => {
    const w = world({ local: { myProfile: ME } });
    const panel = await openPanel(w);
    await generate(panel);
    expect(panel.$('generated-message').value).toMatch(/^Hi Aoife, I see we both studied at Trinity College Dublin\. /);
    expect(panel.$('strength-score').textContent).toBe('Strong');
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('your picks are used for "New version" (AI Mode, Deep)', async () => {
    const w = world({ key: API_KEY, local: { myProfile: ME } });
    const panel = await openPanel(w);
    panel.$('mode-deep').click();
    await generate(panel);

    const chips = panel.$('cg-chips').querySelectorAll('.cg-chip');
    chips[1].click(); // skip Accenture
    chips[2].click(); // use Dublin
    panel.$('regenerate-btn').click();
    await until(async () => w.calls.length === 2 && (await w.job('/in/aoife/')).step === 'done');

    expect(taggedBlock(w, 1, 'common_ground')).toEqual([
      'We both studied at Trinity College Dublin', 'We are both based in Dublin',
    ]);
    await until(() => panel.$('status-message').textContent === 'Message ready. Written by Claude.');
    expect(chipTexts(panel)).toEqual([
      '[x] 🎓 studied at Trinity College Dublin',
      '[ ] 💼 worked at Accenture',
      '[x] 📍 in Dublin',
    ]);
  });

  it('your picks are used for "New version" (Free Mode)', async () => {
    const w = world({ local: { myProfile: ME } });
    const panel = await openPanel(w);
    await generate(panel);
    expect(panel.$('generated-message').value).toContain('I see we both studied at Trinity College Dublin.');

    const chips = panel.$('cg-chips').querySelectorAll('.cg-chip');
    chips[1].click(); // skip Accenture
    chips[2].click(); // use Dublin
    panel.$('regenerate-btn').click();
    // "New version" moves on to your next pick. With your picks, that is
    // Dublin. With the first picks, it would have been Accenture.
    await until(() => panel.$('generated-message').value.includes('I see we are both based in Dublin.'));
    expect(panel.$('generated-message').value).not.toContain('Accenture');
    expect((await w.job('/in/aoife/')).useCommonGround).toEqual([
      'We both studied at Trinity College Dublin', 'We are both based in Dublin',
    ]);
  });

  it('one line you pick is used by every "New version", not skipped (Free Mode)', async () => {
    const w = world({ local: { myProfile: ME } });
    const panel = await openPanel(w);
    await generate(panel);

    const chips = panel.$('cg-chips').querySelectorAll('.cg-chip');
    chips[0].click(); // skip Trinity
    chips[1].click(); // skip Accenture
    chips[2].click(); // use Dublin: now it is your only pick
    expect(chipTexts(panel)).toEqual([
      '[ ] 🎓 studied at Trinity College Dublin',
      '[ ] 💼 worked at Accenture',
      '[x] 📍 in Dublin',
    ]);

    // Each "New version" opens with your pick. Only the question changes.
    const versions = [];
    for (const variant of [1, 2]) {
      panel.$('regenerate-btn').click();
      await until(async () => {
        const job = await w.job('/in/aoife/');
        return job.variant === variant && job.step === 'done';
      });
      await settle();
      versions.push(panel.$('generated-message').value);
    }
    expect(versions).toEqual([
      'Hi Aoife, I see we are both based in Dublin. Could we connect?',
      'Hi Aoife, I see we are both based in Dublin. Would you be open to connecting?',
    ]);
    expect(w.fetch).not.toHaveBeenCalled();
  });
});

describe('goal', () => {
  it('reaches Claude (AI Mode)', async () => {
    const w = world({ key: API_KEY });
    const panel = await openPanel(w);
    type(panel.$('goal'), 'Referral for the Data Analyst role');
    await generate(panel);
    expect(promptLine(w, 0, 'My goal:')).toBe('My goal: Referral for the Data Analyst role');
  });

  it("the goal box's own example makes a good question with the default type too (Free Mode)", async () => {
    const panel = await openPanel(world());
    expect(panel.$('message-type').value).toBe('Networking'); // the default
    const example = panel.$('goal').placeholder.replace(/^e\.g\. /, '');
    expect(example).toBe('Referral for the Data Analyst role at Spotify');
    type(panel.$('goal'), example);
    await generate(panel);
    // A referral question, not "a short chat about Referral for…".
    expect(panel.$('generated-message').value).toMatch(/would you consider referring me for the Data Analyst role at Spotify\?$/);
  });

  it('reaches the Free Mode template: the ask is about your goal', async () => {
    const panel = await openPanel(world());
    panel.$('message-type').value = 'Referral';
    type(panel.$('goal'), 'Referral for the Data Analyst role');
    await generate(panel);
    expect(panel.$('generated-message').value).toMatch(/would you consider referring me for the Data Analyst role\?$/);
  });

  it('stays with this person: not shown for the next one, back when you return or reopen the panel', async () => {
    const w = world();
    let panel = await openPanel(w);
    type(panel.$('goal'), 'Referral for the Data Analyst role');
    await generate(panel);

    w.navigate(1, LIAM.profileUrl);
    await until(() => panel.$('profile-name').textContent === 'Liam Byrne');
    expect(panel.$('goal').value).toBe('');

    w.navigate(1, AOIFE.profileUrl);
    await until(() => panel.$('profile-name').textContent === 'Aoife Murphy');
    expect(panel.$('goal').value).toBe('Referral for the Data Analyst role');

    panel.close();
    panel = await openPanel(w);
    expect(panel.$('goal').value).toBe('Referral for the Data Analyst role');
  });
});

describe('message check, on a draft from AI Mode', () => {
  it('a weak draft is called out, line by line', async () => {
    const panel = await openPanel(world({ key: API_KEY, reply: 'Hi Aoife, I came across your profile and would like to connect.' }));
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
    const panel = await openPanel(world({ key: API_KEY, reply: 'Hi Aoife, I came across your profile and would like to connect.' }));
    await generate(panel);
    type(panel.$('generated-message'), 'Hi Aoife, your Spotify recommendations work is exactly what I want to do. Open to a 15-minute chat?');
    expect(panel.$('strength-score').textContent).toBe('Strong');
  });

  it('flags a name in the draft that no source backs up', async () => {
    const panel = await openPanel(world({ key: API_KEY, reply: 'Hi Aoife, I enjoyed your PyData Berlin talk about Spotify. Open to a chat?' }));
    await generate(panel);
    const warn = panel.$('strength-list').querySelector('li.warn');
    expect(warn.firstChild.textContent).toBe('Check: "PyData Berlin"');
    expect(warn.querySelector('.tip').textContent).toMatch(/Make sure it is true/);
  });
});
