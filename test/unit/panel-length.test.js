// Connection note or message: length limits, "Fit", and the note budget.
// Free Mode always writes a note that fits, so the drafts that are too long
// here come from AI Mode: a fake Claude that ignores the limit.
import { describe, it, expect } from 'vitest';
import { createWorld, openPanel, person, until, settle, claudeReply, promptText, API_KEY } from '../helpers/world.js';

const AOIFE = person('aoife', 'Aoife');
const LONG = 'Hi Aoife, I came across your work on recommendation systems at Spotify and found it really interesting. ' +
  'I hope this message finds you well. ' +
  'I recently finished my MSc in Data Analytics at UCD and I am now looking for data science roles in Dublin. ' +
  'I have been learning a lot about ranking models in my spare time. ' +
  'Would you be open to a 15-minute chat about how you moved into recommendations? Thank you, Rahul';

// AI Mode: your key, and a fake Claude that sends back `reply`.
function world({ local = {}, reply = LONG, page = AOIFE } = {}) {
  return createWorld({
    local: { userApiKey: API_KEY, ...local },
    tabs: [{ id: 1, url: page.profileUrl, active: true }],
    pages: { 1: page },
    claude: () => claudeReply(reply),
  });
}

// Free Mode: no key, so the template writes it and nothing is fetched.
// (A copy of `local`: the fake storage writes into the object it is given.)
function freeWorld({ local = {}, page = AOIFE } = {}) {
  return createWorld({
    local: { ...local },
    tabs: [{ id: 1, url: page.profileUrl, active: true }],
    pages: { 1: page },
  });
}

async function generate(panel) {
  panel.$('generate-btn').click();
  await until(() => !panel.$('message-section').classList.contains('hidden'));
}

// What Claude was asked to write, for the last message.
const lastPrompt = (w) => promptText(w.calls.at(-1).body);

// A tagged block in the prompt (like <talking_points>), read back as data.
function taggedBlock(prompt, tag) {
  const m = prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  return m ? JSON.parse(m[1]) : null;
}

describe('length limits, on a long draft from AI Mode', () => {
  it('a connection note over 200 shows red, and offers "Fit to 200"', async () => {
    const panel = await openPanel(world());
    expect(panel.$('channel-note').getAttribute('aria-checked')).toBe('true'); // default
    await generate(panel);
    expect(panel.$('char-count').textContent).toBe(`${LONG.length} / 200`);
    expect(panel.$('char-count').className).toContain('over');
    expect(panel.$('fit-row').classList.contains('hidden')).toBe(false);
    expect(panel.$('fit-btn').textContent).toBe('Fit to 200');
  });

  it('"Fit" shortens it to fit, says what it did, and can be undone', async () => {
    const w = world();
    const panel = await openPanel(w);
    await generate(panel);
    panel.$('fit-btn').click();
    await settle();

    const fitted = panel.$('generated-message').value;
    expect(fitted.length).toBeLessThanOrEqual(200);
    expect(fitted).toContain('Would you be open to a 15-minute chat');
    expect(panel.$('fit-text').textContent).toMatch(/^Shortened from \d+ to \d+ by removing \d sentences\. Please read it once\.$/);
    expect(panel.$('char-count').className).not.toContain('over');
    expect((await w.recent())[0].message).toBe(fitted); // saved like any edit

    panel.$('undo-fit-btn').click();
    await settle();
    expect(panel.$('generated-message').value).toBe(LONG);
  });

  it('"Fit" makes one line after "Hi Aoife,": a common first word then gets a small letter', async () => {
    // Claude wrote the greeting on a line of its own.
    const draft = 'Hi Aoife,\n\nYour talk on ranking models at PyData Dublin was great. I hope this message finds you well. ' +
      'I recently finished my MSc in Data Analytics at UCD and I am now looking for data science roles in Dublin. ' +
      'Would you be open to a 15-minute chat about your work at Spotify?';
    const panel = await openPanel(world({ reply: draft }));
    await generate(panel);
    panel.$('fit-btn').click();
    await settle();
    expect(panel.$('generated-message').value).toBe('Hi Aoife, your talk on ranking models at PyData Dublin was great. ' +
      'Would you be open to a 15-minute chat about your work at Spotify?');
  });

  it('Premium allows 300 characters', async () => {
    const panel = await openPanel(world({ local: { linkedinPlan: 'premium' } }));
    await generate(panel);
    expect(panel.$('char-count').textContent).toBe(`${LONG.length} / 300`);
    expect(panel.$('channel-hint').textContent).toBe('Up to 300 characters on Premium.');
  });

  it('a message to a connection only gets a soft target, no "Fit"', async () => {
    const panel = await openPanel(world());
    panel.$('channel-message').click();
    await generate(panel);
    expect(panel.$('char-count').textContent).toBe(`${LONG.length} chars · aim for under 500`);
    expect(panel.$('fit-row').classList.contains('hidden')).toBe(true);
  });
});

describe('Free Mode always fits', () => {
  // A long post and a long bio: more than one note can hold.
  const AOIFE_LONG = person('aoife', 'Aoife', {
    currentTitle: 'Senior Machine Learning Engineer',
    recentPosts: ['We just shipped a new ranking model for our music recommendations that blends listening history with ' +
      'audio embeddings, and the offline numbers finally moved after six months of hard work by the whole team.'],
  });
  const ME = {
    userName: 'Rahul',
    userBio: 'I recently finished my MSc in Data Analytics at UCD and I am now looking for data science roles in Dublin, ideally in recommendations.',
  };

  it('a note fits 200 even with a long post and a long bio, so there is no "Fit"', async () => {
    const w = freeWorld({ page: AOIFE_LONG, local: ME });
    const panel = await openPanel(w);
    await generate(panel);

    const note = panel.$('generated-message').value;
    expect(note).toMatch(/^Hi Aoife, .+\?$/);
    expect(note.length).toBeLessThanOrEqual(200);
    expect(panel.$('char-count').textContent).toBe(`${note.length} / 200`);
    expect(panel.$('char-count').className).not.toContain('over');
    expect(panel.$('fit-row').classList.contains('hidden')).toBe(true);
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('on Premium, the note may use the extra room, up to 300: here your intro fits too', async () => {
    // A shorter bio: with her post, it fits in 300 characters, but not in 200.
    const me = { userName: 'Rahul', userBio: 'I recently finished my MSc in Data Analytics at UCD.' };
    const intro = 'A bit about me: I recently finished my MSc in Data Analytics at UCD.';

    const free = await openPanel(freeWorld({ page: AOIFE_LONG, local: me }));
    await generate(free);
    expect(free.$('generated-message').value).not.toContain(intro); // no room for it in 200
    free.close();

    const panel = await openPanel(freeWorld({ page: AOIFE_LONG, local: { ...me, linkedinPlan: 'premium' } }));
    await generate(panel);
    const note = panel.$('generated-message').value;
    expect(note).toContain(intro);
    expect(note.length).toBeGreaterThan(200);
    expect(note.length).toBeLessThanOrEqual(300);
    expect(panel.$('char-count').textContent).toBe(`${note.length} / 300`);
    expect(panel.$('fit-row').classList.contains('hidden')).toBe(true);
  });
});

describe('the writer is told where the message goes', () => {
  it('AI Mode, connection note: under 170 characters (hard limit 200), no sign-off', async () => {
    const w = world();
    const panel = await openPanel(w);
    await generate(panel);
    const prompt = lastPrompt(w);
    expect(prompt).toMatch(/connection note/);
    expect(prompt).toMatch(/under 170 characters/);
    expect(prompt).toMatch(/hard limit is 200\b/);
    expect(prompt).toMatch(/No sign-off/);
    expect(prompt).not.toMatch(/under 600/); // Ark's 3.1.0 asked for "under 600 characters" every time
  });

  it('AI Mode on Premium: under 255 characters (hard limit 300)', async () => {
    const w = world({ local: { linkedinPlan: 'premium' } });
    const panel = await openPanel(w);
    await generate(panel);
    const prompt = lastPrompt(w);
    expect(prompt).toMatch(/under 255 characters/);
    expect(prompt).toMatch(/hard limit is 300\b/);
  });

  it('AI Mode, Deep Mode message: under 500, no note rules, and the talking points it showed', async () => {
    // Her headline says "at Spotify", so her role can be trusted as a talking point.
    const w = world({ page: person('aoife', 'Aoife', { headline: 'Data Scientist at Spotify', currentTitle: 'Data Scientist' }) });
    const panel = await openPanel(w);
    panel.$('channel-message').click();
    panel.$('mode-deep').click();
    await generate(panel);

    const prompt = lastPrompt(w);
    expect(prompt).toMatch(/Write a LinkedIn message to someone I am already connected with\./);
    expect(prompt).toMatch(/under 500 characters/);
    expect(prompt).not.toMatch(/connection note|No sign-off/);
    const shown = [...panel.$('hooks-list').children].map((el) => el.textContent);
    expect(shown).toEqual(['Works as Data Scientist at Spotify']);
    // Claude gets the same talking points, in their own block.
    expect(taggedBlock(prompt, 'talking_points')).toEqual(shown);
  });

  it('reopening the panel restores the channel the message was made for', async () => {
    const w = freeWorld();
    let panel = await openPanel(w);
    panel.$('channel-message').click();
    await generate(panel);
    panel.close();
    await w.chrome.storage.local.set({ lastChannel: 'note' }); // e.g. changed on another profile
    panel = await openPanel(w);
    expect(panel.$('channel-message').getAttribute('aria-checked')).toBe('true');
  });
});

describe('note budget on a free plan', () => {
  it("says the limit comes from LinkedIn's free plan, not from the extension's Free Mode", async () => {
    const panel = await openPanel(freeWorld());
    expect(panel.$('key-status').textContent).toBe('● Free Mode'); // the header, on the same screen
    expect(panel.$('channel-hint').textContent).toBe(
      "Up to 200 characters. LinkedIn's free plan gives only a few notes a month (made here: 0 of ~5).");
  });

  it('counts a copied note once per person, per month', async () => {
    const panel = await openPanel(freeWorld());
    expect(panel.$('channel-hint').textContent).toContain('made here: 0 of ~5');
    await generate(panel);

    panel.$('copy-btn').click();
    await settle();
    panel.$('copy-btn').click(); // copying again for the same person does not count twice
    await settle();
    expect(panel.$('channel-hint').textContent).toContain('made here: 1 of ~5');
  });

  it('when notes run low, suggests connecting without one', async () => {
    const now = new Date(); // local time, like Limits.monthKey()
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const used = { month, profiles: ['/in/a/', '/in/b/', '/in/c/', '/in/d/'] };
    const panel = await openPanel(freeWorld({ local: { noteUsage: used } }));
    expect(panel.$('channel-hint').textContent).toBe(
      'Notes made here this month: 4 of ~5. Running out? Connect without a note, then send a Message once they accept.');
  });
});
