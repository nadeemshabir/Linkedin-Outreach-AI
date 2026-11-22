// The background side of "Write with Ark" inside LinkedIn's own boxes
// (INPAGE_WRITE): the real background and a fake browser. Free Mode (no key)
// is the default. AI Mode tests save a fake Anthropic key, and a fake Claude
// answers.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWorld, openPanel, person, until, type, deferred, claudeReply, promptText, API_KEY } from '../helpers/world.js';

const AOIFE = person('aoife', 'Aoife Murphy');

// A note-length draft, and one that is too long for a 200-character note.
const SHORT = 'Hi Aoife, your talk on podcast recommendations at Spotify was great. Would you be open to a short chat?';
const LONG = 'Hi Aoife, I hope this message finds you well. Your talk on podcast recommendations at Spotify was great. '
  + 'I am a final-year student working on ranking models for audio and I would love to learn from your experience. '
  + 'Would you be open to a short chat about your team? Thank you, Rahul';

// The side panel is the extension's own page, so there "Settings" is clear.
// On linkedin.com it would read as LinkedIn's own settings.
const NOT_ACCEPTED = 'Your Anthropic API key was not accepted. Check it in Settings, or remove it to use Free Mode.';
const NOT_ACCEPTED_ON_LINKEDIN = "Your Anthropic API key was not accepted. Check it in the extension's Settings (click its icon in Chrome's toolbar), or remove it to use Free Mode.";
const DECLINED = 'Claude declined to write this one. Try again, or remove your key in Settings to use Free Mode.';
// No "Settings" in it, so the bar and the panel use the same words.
const NO_MODEL = 'Your Anthropic account cannot use the model claude-haiku-5-5. Remove your key to use Free Mode, or update the extension.';
const DECLINED_ON_LINKEDIN = "Claude declined to write this one. Try again, or remove your key in the extension's Settings (click its icon in Chrome's toolbar) to use Free Mode.";
const TOO_SLOW_WITH_RESUME = 'Claude took too long (over 60s). Your resume is sent with each message, which makes it slower: '
  + 'try again, or untick "Use my resume in AI Mode" in Settings.';
const TOO_SLOW_WITH_RESUME_ON_LINKEDIN = 'Claude took too long (over 60s). Your resume is sent with each message, which makes it slower: '
  + `try again, or untick "Use my resume in AI Mode" in the extension's Settings (click its icon in Chrome's toolbar).`;

const NOTE = { tabId: 1, mode: 'quick', channel: 'note', maxChars: 200, messageType: 'Networking', tone: 'Neutral' };

// A resume saved in Settings, with "Use my resume in AI Mode" turned on.
const RESUME = { resumeBase64: 'JVBERi0xLjQK', resumeFileName: 'my-resume.pdf', resumeForAI: true }; // "%PDF-1.4"
/** The kinds of content in a request to write: 'document' (the resume) and 'text'. */
const kinds = (call) => call.body.messages[0].content.map((b) => b.type);
/** Anthropic cannot read the PDF: it refuses a request that has it. */
const pdfNotValid = (body) => (kinds({ body }).includes('document')
  ? [400, { type: 'error', error: { type: 'invalid_request_error', message: 'The PDF specified was not valid.' } }]
  : claudeReply(SHORT));

afterEach(() => vi.useRealTimers());

/** Free Mode (no key), unless `local` has one. */
function world({ local = {}, session = {}, url = AOIFE.profileUrl, page = AOIFE, claude } = {}) {
  return createWorld({ local, session, tabs: [{ id: 1, url, active: true }], pages: { 1: page }, claude });
}

/** AI Mode: your own (fake) Anthropic key is saved, and Claude writes `message`. */
function aiWorld({ message = SHORT, claude, local = {}, ...rest } = {}) {
  return world({ ...rest, local: { userApiKey: API_KEY, ...local }, claude: claude || (() => claudeReply(message)) });
}

/** The text Claude was given, in request number `i`. */
const prompt = (w, i = 0) => promptText(w.calls[i].body);

/** In your tracker: Aoife accepted your connection note. */
function accepted() {
  const now = Date.now();
  return {
    contacts: {
      '/in/aoife/': {
        profileKey: '/in/aoife/', profileUrl: AOIFE.profileUrl, name: 'Aoife Murphy', message: 'Hi Aoife',
        channel: 'note', status: 'connected', createdAt: now, updatedAt: now, connectedAt: now, history: [],
      },
    },
  };
}

async function noteUsage(w) {
  return (await w.chrome.storage.local.get('noteUsage')).noteUsage;
}

describe('Write with Ark, inside LinkedIn: Free Mode (no key)', () => {
  it('nothing written yet: writes a note that fits the box, and hands it over', async () => {
    const w = world();
    const res = await w.inpage({ channel: 'note', maxChars: 200 });

    // Same job as the side panel: it shows there, and the tracker has it.
    const job = await w.job('/in/aoife/');
    expect(job).toMatchObject({ step: 'done', channel: 'note', maxChars: 200, writer: 'free' });
    // resumeSkipped is always there, true or false: Free Mode sends no resume.
    expect(res).toEqual({
      ok: true, message: job.message, reused: false, limit: 200, fit: { changed: false, fits: true, removed: 0 }, resumeSkipped: false,
    });
    expect(res.message).toMatch(/^Hi Aoife,/);
    expect(res.message.length).toBeLessThanOrEqual(200);
    expect((await w.recent())[0]).toMatchObject({ name: 'Aoife Murphy', channel: 'note', status: 'drafted', message: res.message });
    expect(w.fetch).not.toHaveBeenCalled(); // nothing leaves the device
  });

  it("writes to the box's own limit: more room on Premium (300) gives a longer note", async () => {
    // A long post and a bio: together they fit in 300 characters, not in 200.
    const page = person('aoife', 'Aoife Murphy', {
      recentPosts: ['Our team just shipped a new ranking model for podcast recommendations at Spotify, and the results surprised all of us.'],
    });
    const local = { userName: 'Priya Sharma', userBio: 'I am a final-year computer science student at Trinity College Dublin.' };
    const free = await world({ page, local }).inpage({ channel: 'note', maxChars: 200 });
    const premium = await world({ page, local }).inpage({ channel: 'note', maxChars: 300 });

    // Written to fit, so nothing had to be cut afterwards.
    expect(free).toMatchObject({ ok: true, limit: 200, fit: { changed: false, fits: true } });
    expect(premium).toMatchObject({ ok: true, limit: 300, fit: { changed: false, fits: true } });
    expect(free.message.length).toBeLessThanOrEqual(200);
    expect(premium.message.length).toBeLessThanOrEqual(300);
    expect(premium.message.length).toBeGreaterThan(free.message.length);
    // The extra room holds your intro. The 200-character note leaves it out.
    expect(premium.message).toContain('A bit about me: I am a final-year computer science student at Trinity College Dublin.');
    expect(free.message).not.toContain('A bit about me');
  });

  it('a finished draft from the side panel is handed over at once, with your edits', async () => {
    const w = world();
    const panel = await openPanel(w);
    panel.$('generate-btn').click();
    const first = await until(async () => {
      const job = await w.job('/in/aoife/');
      return job && job.step === 'done' ? job : null;
    });
    await until(() => panel.$('generated-message').value === first.message);
    type(panel.$('generated-message'), 'Hi Aoife, loved your Spotify talk. Open to a chat?');
    await until(async () => (await w.job('/in/aoife/')).editedMessage);

    const res = await w.inpage({ channel: 'note', maxChars: 200 });
    expect(res).toMatchObject({ ok: true, reused: true, message: 'Hi Aoife, loved your Spotify talk. Open to a chat?' });
    expect((await w.job('/in/aoife/')).messageId).toBe(first.messageId); // no second run
    expect(w.scrapes()).toBe(1);
  });

  it('a draft for the other kind of box: writes a new one, but does not read the page again', async () => {
    const w = world();
    const note = await w.inpage({ channel: 'note', maxChars: 200 });
    expect(w.scrapes()).toBe(1);

    const res = await w.inpage({ channel: 'message' });
    expect(res).toMatchObject({ ok: true, reused: false, limit: null, fit: null });
    expect(res.message).not.toBe(note.message);
    expect(await w.job('/in/aoife/')).toMatchObject({ channel: 'message', maxChars: 500, message: res.message });
    expect(w.scrapes()).toBe(1);
  });

  it("a message to someone who just accepted thanks them, without pasting in the tracker's notes", async () => {
    const w = world({ local: accepted() });
    const res = await w.inpage({ channel: 'message' });
    expect(res.ok).toBe(true);
    expect(res.message).toContain('Thanks for connecting!');
    expect(res.message).not.toMatch(/accepted my connection request|make my ask/i);
    // You are connected now, so it does not ask to connect.
    expect(res.message).not.toMatch(/open to connecting|could we connect/i);
  });

  it('uses your last choices from the panel (message type, tone)', async () => {
    const w = world({ local: { lastMessageType: 'Referral', lastTone: 'Casual' } });
    const res = await w.inpage({ channel: 'note', maxChars: 200 });
    expect(await w.job('/in/aoife/')).toMatchObject({ messageType: 'Referral', tone: 'Casual' });
    expect(res.message).toMatch(/^Hey Aoife,/); // the casual greeting
    expect(res.message).toMatch(/referr/i); // asks for a referral
  });

  it('always uses the first wording, even after "New version" in the panel', async () => {
    const w = world();
    const doneWith = (variant) => until(async () => {
      const job = await w.job('/in/aoife/');
      return job && job.step === 'done' && job.variant === variant ? job : null;
    });
    // In the panel: a note, then "New version" twice.
    await w.start(NOTE);
    await doneWith(0);
    await w.start({ ...NOTE, regenerate: true });
    await doneWith(1);
    await w.start({ ...NOTE, regenerate: true });
    await doneWith(2);

    // In LinkedIn's message box. There is no message yet, so one is written.
    const res = await w.inpage({ channel: 'message' });
    expect(res).toMatchObject({ ok: true, reused: false });
    expect(await w.job('/in/aoife/')).toMatchObject({ step: 'done', channel: 'message', variant: 0 });
    expect(w.scrapes()).toBe(1); // what was read is used again
    // The same words as for someone you never pressed "New version" for.
    expect(res.message).toBe((await world().inpage({ channel: 'message' })).message);
  });

  it("a note put into LinkedIn counts toward the month's notes, once per person; a message does not", async () => {
    const w = world();
    await w.inpage({ channel: 'note', maxChars: 200 });
    await w.inpage({ channel: 'note', maxChars: 200 });
    expect((await noteUsage(w)).profiles).toEqual(['/in/aoife/']);

    const m = world();
    await m.inpage({ channel: 'message' });
    expect(await noteUsage(m)).toBeUndefined();
  });
});

describe('Write with Ark, inside LinkedIn: AI Mode (your own key)', () => {
  it('Claude is told the box is a free 200-character note', async () => {
    const w = aiWorld();
    const res = await w.inpage({ channel: 'note', maxChars: 200 });

    expect(res).toMatchObject({ ok: true, message: SHORT, reused: false, limit: 200, fit: { changed: false, fits: true }, resumeSkipped: false });
    expect(w.calls).toHaveLength(1);
    const text = prompt(w);
    expect(text).toContain('LinkedIn connection note');
    expect(text).toContain('under 170 characters');
    expect(text).toContain('hard limit is 200');
    expect(await w.job('/in/aoife/')).toMatchObject({ step: 'done', writer: 'ai', message: SHORT });
  });

  it("the box's own limit wins: 300 on Premium, even if Settings still says free", async () => {
    const w = aiWorld({ local: { linkedinPlan: 'free' } });
    const res = await w.inpage({ channel: 'note', maxChars: 300 });
    expect(res.limit).toBe(300);
    expect(prompt(w)).toContain('under 255 characters');
    expect(prompt(w)).toContain('hard limit is 300');
  });

  it('no limit on the box: uses your plan from Settings', async () => {
    const premium = aiWorld({ local: { linkedinPlan: 'premium' } });
    expect((await premium.inpage({ channel: 'note', maxChars: null })).limit).toBe(300);
    expect(prompt(premium)).toContain('hard limit is 300');

    const free = aiWorld(); // no plan set: free
    expect((await free.inpage({ channel: 'note' })).limit).toBe(200);
    expect(prompt(free)).toContain('hard limit is 200');
  });

  it('a message to someone who just accepted: Claude is told why you are writing', async () => {
    const w = aiWorld({ local: accepted() });
    await w.inpage({ channel: 'message' });
    const text = prompt(w);
    expect(text).toContain('Write a LinkedIn message to someone I am already connected with.');
    expect(text).toContain('under 500 characters');
    expect(text).toContain('My goal: They just accepted my connection request.');
  });

  it('uses your last choices from the panel (message type, tone)', async () => {
    const w = aiWorld({ local: { lastMessageType: 'Referral', lastTone: 'Casual' } });
    await w.inpage({ channel: 'note', maxChars: 200 });
    expect(prompt(w)).toContain('Purpose: Referral. Tone: Casual.');
  });

  it('a draft too long for the box is fitted to its limit, not cut mid-sentence', async () => {
    const w = aiWorld({ message: LONG });
    const res = await w.inpage({ channel: 'note', maxChars: 200 });

    expect(res.ok).toBe(true);
    expect(res.message.length).toBeLessThanOrEqual(200);
    // The sentence after "Hi Aoife," goes on in small letters, as one sentence does.
    expect(res.message).toMatch(/^Hi Aoife, your talk on podcast recommendations/);
    expect(res.message).toMatch(/Would you be open to a short chat about your team\?$/);
    expect(res.fit).toEqual({ changed: true, fits: true, removed: 3 });
    // The full draft stays in the side panel.
    expect((await w.job('/in/aoife/')).message).toBe(LONG);
  });

  it('a run already going (started in the panel) is waited for, not started twice', async () => {
    const gate = deferred();
    const w = aiWorld({ claude: async () => { await gate.promise; return claudeReply(SHORT); } });
    await w.start({ tabId: 1, mode: 'quick', channel: 'note', maxChars: 200, messageType: 'Networking', tone: 'Neutral' });
    const pending = w.inpage({ channel: 'note', maxChars: 200 });
    gate.resolve();

    expect(await pending).toMatchObject({ ok: true, message: SHORT, reused: true });
    expect(w.calls).toHaveLength(1);
  });

  // You may never open the side panel, so the bar in LinkedIn's box must say
  // when your resume was left out.
  it('your resume: the reply says if it was left out (Anthropic could not read it)', async () => {
    const read = aiWorld({ local: RESUME });
    expect(await read.inpage({ channel: 'note', maxChars: 200 })).toMatchObject({ ok: true, resumeSkipped: false });
    expect(read.calls.map(kinds)).toEqual([['document', 'text']]); // it was sent, and used

    const w = aiWorld({ local: RESUME, claude: pdfNotValid });
    const res = await w.inpage({ channel: 'note', maxChars: 200 });
    expect(res).toEqual({
      ok: true, message: SHORT, reused: false, limit: 200, fit: { changed: false, fits: true, removed: 0 }, resumeSkipped: true,
      aiCompany: 'Anthropic', // for the bar's "Anthropic could not read the PDF"
    });
    expect(w.calls.map(kinds)).toEqual([['document', 'text'], ['text']]); // written again, without it

    // The same draft, handed over again, still says so.
    expect(await w.inpage({ channel: 'note', maxChars: 200 })).toMatchObject({ ok: true, reused: true, message: SHORT, resumeSkipped: true });
    expect(w.calls).toHaveLength(2);
  });
});

describe('Write with Ark, inside LinkedIn: errors', () => {
  it('errors come back in plain words', async () => {
    const offPage = world({ url: 'https://www.linkedin.com/feed/' });
    expect(await offPage.inpage({ channel: 'note' })).toEqual({ ok: false, error: 'Open their LinkedIn profile first.' });

    const busy = aiWorld({ claude: () => [529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }] });
    expect(await busy.inpage({ channel: 'note' })).toEqual({
      ok: false, error: 'Anthropic is busy right now. Please try again in a minute.', code: 'busy',
    });
    // A note that was never written does not count toward the month's notes.
    expect(await noteUsage(busy)).toBeUndefined();
  });

  it("a key problem says where to fix it: the extension's Settings, not LinkedIn's", async () => {
    const refused = aiWorld({ claude: () => [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }] });
    expect(await refused.inpage({ channel: 'note' })).toEqual({ ok: false, error: NOT_ACCEPTED_ON_LINKEDIN, code: 'auth' });

    const declined = aiWorld({ claude: () => claudeReply("I can't help with that.", { stop_reason: 'refusal' }) });
    expect(await declined.inpage({ channel: 'note' })).toEqual({ ok: false, error: DECLINED_ON_LINKEDIN, code: 'refusal' });

    // The side panel shows the same run's error with its own words.
    expect((await refused.job('/in/aoife/')).error).toEqual({ message: NOT_ACCEPTED, code: 'auth' });
    expect((await declined.job('/in/aoife/')).error).toEqual({ message: DECLINED, code: 'refusal' });
  });

  it('an account that may not use the model (404): the bar says what to do instead, in the same words as the panel', async () => {
    const w = aiWorld({ claude: () => [404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-haiku-5-5' } }] });
    expect(await w.inpage({ channel: 'note', maxChars: 200 })).toEqual({ ok: false, error: NO_MODEL, code: 'model' });
    expect((await w.job('/in/aoife/')).error).toEqual({ message: NO_MODEL, code: 'model' });
  });

  // Before it marks a key, the background reads your saved key, to check
  // the run used that key. If that read fails (rare: Chrome cannot read its
  // storage), the run must still end, or the bar would wait forever.
  it('if your saved key cannot be read (a storage error), a refused run still answers the bar', async () => {
    vi.useFakeTimers();
    const w = aiWorld({ claude: () => [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }] });
    const get = w.chrome.storage.local.get;
    const failed = [];
    w.chrome.storage.local.get = (keys, cb) => {
      if (!cb && [].concat(keys).sort().join() === 'aiProvider,userApiKey') { // reading the saved key on its own (with its provider) fails
        failed.push(keys);
        return Promise.reject(new Error('IO error: could not read the storage.'));
      }
      return get(keys, cb);
    };

    let answer = 'no answer';
    w.inpage({ channel: 'note', maxChars: 200 }).then((res) => { answer = res; });
    // Up to 5 seconds, a little at a time (less than one 15-second heartbeat).
    for (let ms = 0; ms < 5_000 && answer === 'no answer'; ms += 100) await vi.advanceTimersByTimeAsync(100);

    expect(answer).toEqual({ ok: false, error: NOT_ACCEPTED_ON_LINKEDIN, code: 'auth' });
    expect(failed).toHaveLength(1); // it did try to read your key
    expect(await noteUsage(w)).toBeUndefined();
  });

  it("your resume makes it too slow: says to untick it in the extension's Settings, not LinkedIn's", async () => {
    vi.useFakeTimers();
    const w = aiWorld({ local: RESUME, claude: () => 'hang' });
    const pending = w.inpage({ channel: 'note', maxChars: 200 });
    await vi.advanceTimersByTimeAsync(60_000); // with a resume, it waits 60 seconds

    expect(await pending).toEqual({ ok: false, error: TOO_SLOW_WITH_RESUME_ON_LINKEDIN, code: 'timeout' });
    expect(w.calls.map(kinds)).toEqual([['document', 'text']]); // a time-out is not tried again without the resume
    // The side panel shows the same run's error with its own words.
    expect((await w.job('/in/aoife/')).error).toEqual({ message: TOO_SLOW_WITH_RESUME, code: 'timeout' });
    // A note that was never written does not count toward the month's notes.
    expect(await noteUsage(w)).toBeUndefined();
  });
});
