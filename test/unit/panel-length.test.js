// Connection note vs message, length limits, "Fit", and the note budget (Phase 3).
import { describe, it, expect } from 'vitest';
import { createWorld, openPanel, person, until, settle, KEY } from '../helpers/world.js';

const AOIFE = person('aoife', 'Aoife');
const LONG = 'Hi Aoife, I came across your work on recommendation systems at Spotify and found it really interesting. ' +
  'I hope this message finds you well. ' +
  'I recently finished my MSc in Data Analytics at UCD and I am now looking for data science roles in Dublin. ' +
  'I have been learning a lot about ranking models in my spare time. ' +
  'Would you be open to a 15-minute chat about how you moved into recommendations? Thank you, Rahul';

function world({ local = {}, message = LONG, onRequest } = {}) {
  return createWorld({
    local: { licenseKey: KEY, keyStatus: { key: KEY, state: 'valid', remaining: 9, checkedAt: Date.now() }, ...local },
    tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }],
    pages: { 1: AOIFE },
    server: (path, body) => {
      onRequest?.(path, body);
      if (path === '/api/generate/enrich') {
        return [200, { success: true, profileJSON: { name: 'Aoife' }, enrichmentJSON: { topHooks: ['A hook'] } }];
      }
      return [200, { success: true, message }];
    },
  });
}

async function generate(panel) {
  panel.$('generate-btn').click();
  await until(() => !panel.$('message-section').classList.contains('hidden'));
}

describe('length limits', () => {
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

describe('note budget on a free plan', () => {
  it('counts a copied note once per person, per month', async () => {
    const w = world();
    const panel = await openPanel(w);
    expect(panel.$('channel-hint').textContent).toContain('made here: 0 of ~5');
    await generate(panel);

    panel.$('copy-btn').click();
    await settle();
    panel.$('copy-btn').click(); // copying again for the same person does not count twice
    await settle();
    expect(panel.$('channel-hint').textContent).toContain('made here: 1 of ~5');
  });

  it('when notes run low, suggests connecting without one', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const used = { month, profiles: ['/in/a/', '/in/b/', '/in/c/', '/in/d/'] };
    const panel = await openPanel(world({ local: { noteUsage: used } }));
    expect(panel.$('channel-hint').textContent).toBe(
      'Notes made here this month: 4 of ~5. Running out? Connect without a note, then send a Message once they accept.');
  });
});

describe('the writer is told where the message goes', () => {
  it('Quick Mode: in the bio (marked) and in profileData', async () => {
    const requests = [];
    const panel = await openPanel(world({
      local: { userName: 'Rahul', userBio: 'MSc Data Analytics, UCD.' },
      onRequest: (p, b) => requests.push(b),
    }));
    await generate(panel);
    const [body] = requests;
    expect(body.userBio).toBe('MSc Data Analytics, UCD.\n\n[Message format: LinkedIn connection note. Keep it under 170 characters (hard limit 200, including spaces). No sign-off.]');
    expect(body.profileData.outreachContext).toMatchObject({ channel: 'note', maxChars: 200 });
    expect(Object.keys(body).sort()).toEqual(['key', 'messageType', 'profileData', 'resumeBase64', 'tone', 'userBio', 'userName']);
  });

  it('Deep Mode: inside the enrichment data it sends back', async () => {
    const requests = [];
    const panel = await openPanel(world({ onRequest: (p, b) => requests.push({ p, b }) }));
    panel.$('channel-message').click();
    panel.$('mode-deep').click();
    await generate(panel);
    const deep = requests.find((r) => r.p === '/api/generate/deep').b;
    expect(deep.enrichmentJSON.topHooks).toEqual(['A hook']);
    expect(deep.enrichmentJSON.outreachContext).toMatchObject({ channel: 'message', maxChars: 500 });
    expect(Object.keys(deep).sort()).toEqual(['enrichmentJSON', 'key', 'messageType', 'profileJSON', 'resumeBase64', 'tone']);
  });

  it('reopening the panel restores the channel the message was made for', async () => {
    const w = world();
    let panel = await openPanel(w);
    panel.$('channel-message').click();
    await generate(panel);
    panel.close();
    await w.chrome.storage.local.set({ lastChannel: 'note' }); // e.g. changed on another profile
    panel = await openPanel(w);
    expect(panel.$('channel-message').getAttribute('aria-checked')).toBe('true');
  });
});
