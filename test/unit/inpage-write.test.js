// The background side of "Write with Ark" inside LinkedIn's own boxes
// (INPAGE_WRITE): the real background, a fake browser, a fake Ark server.
import { describe, it, expect } from 'vitest';
import { createWorld, openPanel, person, until, type, deferred, KEY } from '../helpers/world.js';

const AOIFE = person('aoife', 'Aoife Murphy');
const VALID = () => ({ key: KEY, state: 'valid', remaining: 9, checkedAt: Date.now() });

// A note-length draft, and one that is too long for a 200-character note.
const SHORT = 'Hi Aoife, your talk on podcast recommendations at Spotify was great. Would you be open to a short chat?';
const LONG = 'Hi Aoife, I hope this message finds you well. Your talk on podcast recommendations at Spotify was great. '
  + 'I am a final-year student working on ranking models for audio and I would love to learn from your experience. '
  + 'Would you be open to a short chat about your team? Thank you, Rahul';

function world({ message = SHORT, server, local = {}, session = {}, url = AOIFE.profileUrl } = {}) {
  return createWorld({
    local: { licenseKey: KEY, keyStatus: VALID(), ...local },
    session,
    tabs: [{ id: 1, url, active: true }],
    pages: { 1: AOIFE },
    server: server || (async (path) => (path === '/api/generate/quick' ? [200, { success: true, message }] : [404, {}])),
  });
}

const quickCalls = (w) => w.calls.filter((c) => c.path === '/api/generate/quick');

describe('Write with Ark, inside LinkedIn (background)', () => {
  it('nothing written yet: runs a Quick job for a note, then hands the note over', async () => {
    const w = world();
    const res = await w.inpage({ channel: 'note', maxChars: 200 });

    expect(res).toMatchObject({ ok: true, message: SHORT, reused: false, limit: 200, fit: { changed: false, fits: true } });
    const [call] = quickCalls(w);
    expect(call.body.userBio).toMatch(/LinkedIn connection note\. Keep it under 170 characters \(hard limit 200/);
    // Same job as the side panel: it shows there, and the tracker has it.
    expect(await w.job('/in/aoife/')).toMatchObject({ step: 'done', channel: 'note', message: SHORT });
    expect((await w.recent())[0]).toMatchObject({ name: 'Aoife Murphy', channel: 'note', status: 'drafted' });
  });

  it('a draft that is too long for the box is fitted to its limit, not cut mid-sentence', async () => {
    const w = world({ message: LONG });
    const res = await w.inpage({ channel: 'note', maxChars: 200 });

    expect(res.ok).toBe(true);
    expect(res.message.length).toBeLessThanOrEqual(200);
    expect(res.message).toMatch(/^Hi Aoife, Your talk on podcast recommendations/);
    expect(res.message).toMatch(/Would you be open to a short chat about your team\?$/);
    expect(res.fit).toEqual({ changed: true, fits: true, removed: 3 });
  });

  it('the box\'s own limit wins: 300 on Premium, even if Settings still says free', async () => {
    const w = world();
    await w.inpage({ channel: 'note', maxChars: 300 });
    expect(quickCalls(w)[0].body.userBio).toMatch(/hard limit 300/);
  });

  it('no limit on the box: uses your plan from Settings', async () => {
    const w = world({ local: { linkedinPlan: 'premium' } });
    const res = await w.inpage({ channel: 'note', maxChars: null });
    expect(res.limit).toBe(300);
    expect(quickCalls(w)[0].body.userBio).toMatch(/hard limit 300/);
  });

  it('a finished draft from the side panel is handed over at once, with your edits', async () => {
    const w = world();
    const panel = await openPanel(w);
    panel.$('generate-btn').click();
    await until(() => panel.$('generated-message').value === SHORT);
    type(panel.$('generated-message'), 'Hi Aoife, loved your Spotify talk. Open to a chat?');
    await until(async () => (await w.job('/in/aoife/')).editedMessage);

    const res = await w.inpage({ channel: 'note', maxChars: 200 });
    expect(res).toMatchObject({ ok: true, reused: true, message: 'Hi Aoife, loved your Spotify talk. Open to a chat?' });
    expect(quickCalls(w)).toHaveLength(1); // no second generation
  });

  it('a run already going (started in the panel) is waited for, not started twice', async () => {
    const gate = deferred();
    const w = world({
      server: async (path) => {
        await gate.promise;
        return path === '/api/generate/quick' ? [200, { success: true, message: SHORT }] : [404, {}];
      },
    });
    await w.start({ tabId: 1, mode: 'quick', channel: 'note', maxChars: 200, messageType: 'Networking', tone: 'Neutral' });
    const pending = w.inpage({ channel: 'note', maxChars: 200 });
    gate.resolve();

    expect(await pending).toMatchObject({ ok: true, message: SHORT });
    expect(quickCalls(w)).toHaveLength(1);
  });

  it('a draft for the other kind of box: writes a new one, but does not read the page again', async () => {
    const w = world();
    await w.inpage({ channel: 'note', maxChars: 200 });
    expect(w.scrapes()).toBe(1);

    const res = await w.inpage({ channel: 'message' });
    expect(res).toMatchObject({ ok: true, reused: false, limit: null, fit: null });
    expect(quickCalls(w)).toHaveLength(2);
    expect(quickCalls(w)[1].body.userBio).toMatch(/LinkedIn message to a connection/);
    expect(w.scrapes()).toBe(1);
  });

  it('a message to someone who just accepted: the writer is told why you are writing', async () => {
    const now = Date.now();
    const w = world({
      local: {
        contacts: {
          '/in/aoife/': {
            profileKey: '/in/aoife/', profileUrl: AOIFE.profileUrl, name: 'Aoife Murphy', message: 'Hi Aoife',
            channel: 'note', status: 'connected', createdAt: now, updatedAt: now, connectedAt: now, history: [],
          },
        },
      },
    });
    await w.inpage({ channel: 'message' });
    expect(quickCalls(w)[0].body.userBio).toMatch(/\[Sender's goal: They just accepted my connection request\./);
  });

  it('uses your last choices from the panel (message type, tone)', async () => {
    const w = world({ local: { lastMessageType: 'Referral', lastTone: 'Casual' } });
    await w.inpage({ channel: 'note', maxChars: 200 });
    expect(quickCalls(w)[0].body).toMatchObject({ messageType: 'Referral', tone: 'Casual' });
  });

  it('a note put into LinkedIn counts toward the month\'s notes, once per person', async () => {
    const w = world();
    await w.inpage({ channel: 'note', maxChars: 200 });
    await w.inpage({ channel: 'note', maxChars: 200 });
    const { noteUsage } = await w.chrome.storage.local.get('noteUsage');
    expect(noteUsage.profiles).toEqual(['/in/aoife/']);
  });

  it('errors come back in plain words', async () => {
    const offPage = world({ url: 'https://www.linkedin.com/feed/' });
    expect(await offPage.inpage({ channel: 'note' })).toEqual({ ok: false, error: 'Open their LinkedIn profile first.' });

    const noKey = createWorld({ tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }], pages: { 1: AOIFE } });
    expect(await noKey.inpage({ channel: 'note' })).toMatchObject({ ok: false, code: 'no_key', error: expect.stringMatching(/license key/) });

    const down = world({ server: async () => [503, {}] });
    expect(await down.inpage({ channel: 'note' })).toMatchObject({ ok: false, error: expect.stringMatching(/server is having trouble/) });
  });
});
