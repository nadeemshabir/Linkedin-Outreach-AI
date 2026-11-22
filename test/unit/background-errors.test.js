// Errors and time limits (B8, B9), through the background's job runner.
// AI Mode tests save the user's own (fake) Anthropic key and let a fake
// Claude answer. With no key, the extension runs in Free Mode and sends
// nothing anywhere.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createWorld, openPanel, person, until, type, deferred, claudeReply, promptText, API_KEY, RUNNING,
} from '../helpers/world.js';

// Her headline names her company, so "Works at Spotify" is a talking point.
const AOIFE = person('aoife', 'Aoife', { headline: 'Data Scientist at Spotify' });
const QUICK = { tabId: 1, mode: 'quick', messageType: 'Networking', tone: 'Neutral' };
const DEEP  = { ...QUICK, mode: 'deep' };
const NEW_KEY = 'sk-ant-test-1111'; // also fake: a key you paste later

const HELLO        = 'Hi Aoife! Would you be open to a quick chat?';
const NOT_ACCEPTED = 'Your Anthropic API key was not accepted. Check it in Settings, or remove it to use Free Mode.';
const ORG_BLOCKED  = 'Your Anthropic organization does not allow calls from a browser extension. Use a key from a personal account at console.anthropic.com, or remove the key to use Free Mode.';
const BAD_KEY      = 'Your key has a character that cannot be in a key (often a curly quote or an invisible space from copying). Copy it again from console.anthropic.com.';
// A 404 for the model: the key may be fine, so it says what to do instead.
const NO_MODEL     = 'Your Anthropic account cannot use the model claude-haiku-5-5. Remove your key to use Free Mode, or update the extension.';
const BUSY         = 'Anthropic is busy right now. Please try again in a minute.';
const RATE_LIMIT   = 'Too many requests to Anthropic right now. Wait a minute, then try again.';
const OFFLINE      = 'Could not reach Anthropic. Check your internet connection.';
const TOO_LONG     = 'Claude took too long (over 30s). Please try again.';
// With your resume attached, a time-out also says what makes it slow, and what to do.
const TOO_LONG_WITH_RESUME = 'Claude took too long (over 60s). Your resume is sent with each message, which makes it slower: '
  + 'try again, or untick "Use my resume in AI Mode" in Settings.';
const NO_CREDIT    = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
// No credit left comes back as a 400. It is a billing problem: trying again
// does not help, so the message also says how to go on for free.
const NO_CREDIT_SAID = `Anthropic said: ${NO_CREDIT} Or remove your key to use Free Mode.`;
const CARD_DECLINED  = 'Anthropic could not bill your account: Your credit card was declined. Check Plans & Billing at console.anthropic.com, or remove your key to use Free Mode.';
const SPEND_LIMIT  = 'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.';
// A 400 about the request itself: not about your key, and not about money.
const PROMPT_TOO_LONG = 'prompt is too long: 213442 tokens > 200000 maximum';

// A resume saved in Settings, with "Use my resume in AI Mode" turned on.
const RESUME = { resumeBase64: 'JVBERi0xLjQK', resumeFileName: 'my-resume.pdf', resumeForAI: true }; // "%PDF-1.4"

// A key pasted with a character that can never be in a key. Written as
// escapes, so you can see them: “ and ” are curly quotes, and
// ​ is an invisible zero-width space.
const BAD_KEYS = [
  ['curly quotes (copied from a document)', `“${API_KEY}”`],
  ['a zero-width space (copied from a chat app)', `${API_KEY}​`],
];

/** AI Mode: a (fake) key is saved, and `claude` answers for Anthropic. */
function world(claude, local = {}) {
  return createWorld({
    local: { userApiKey: API_KEY, ...local },
    tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }],
    pages: { 1: AOIFE },
    claude,
  });
}

/** Free Mode: no key saved. */
function freeWorld(opts = {}) {
  return createWorld({ tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }], pages: { 1: AOIFE }, ...opts });
}

/** An error, the way the Messages API sends one. */
const apiError = (status, type, message) => [status, { type: 'error', error: { type, message }, request_id: 'req_test' }];
const html = (status, text) => new Response(text, { status, headers: { 'Content-Type': 'text/html' } });
/** The spend limit you set at console.anthropic.com is reached: a 429 with its own error code. */
const SPEND_LIMIT_REPLY = [429, { type: 'error', error: { type: 'rate_limit_error', message: SPEND_LIMIT, details: { error_code: 'enforced_spend_limit_reached' } } }];

/** The kinds of content in a request to write: 'document' (the resume) and 'text'. */
const kinds = (call) => call.body.messages[0].content.map((b) => b.type);
const hasResume = (body) => Array.isArray(body.messages[0].content) && body.messages[0].content.some((b) => b.type === 'document');

async function finished(w) {
  return until(async () => {
    const job = await w.job('/in/aoife/');
    return job && !RUNNING.includes(job.step) ? job : null;
  });
}

async function keyStatus(w) {
  return (await w.chrome.storage.local.get('keyStatus')).keyStatus;
}

/** Settings: the "Test" button next to the key field. */
function testKey(w, apiKey) {
  return w.chrome.runtime.sendMessage({ type: 'TEST_API_KEY', payload: { apiKey } });
}

// Problems that stop AI Mode until you act: a refused key, no credit, a
// spend limit, an account that may not use the model. When it is the key you
// saved, the panel's badge says so ("Key not working", "Billing problem",
// "Spend limit reached", "AI Mode not available"), with the reason.
// [what, Anthropic's reply, the message, its code]
const KEY_PROBLEMS = [
  ['not accepted (401)', apiError(401, 'authentication_error', 'invalid x-api-key'), NOT_ACCEPTED, 'auth'],
  ['no credit left (400 "credit balance is too low")', apiError(400, 'invalid_request_error', NO_CREDIT), NO_CREDIT_SAID, 'billing'],
  ['a billing problem (402)', apiError(402, 'billing_error', 'Your credit card was declined.'), CARD_DECLINED, 'billing'],
  ['the spend limit you set is reached (429)', SPEND_LIMIT_REPLY, `Anthropic said: ${SPEND_LIMIT}`, 'spend_limit'],
  ['an account that may not use the model (404)', apiError(404, 'not_found_error', 'model: claude-haiku-5-5'), NO_MODEL, 'model'],
];

// Failures that say nothing about your key: Anthropic is busy, too many
// requests at once, or no internet. [what, the fake Claude, the message, its code]
const NOT_THE_KEY = [
  ['Anthropic is overloaded (529)', () => apiError(529, 'overloaded_error', 'Overloaded'), BUSY, 'busy'],
  ['Anthropic has a problem (500)', () => apiError(500, 'api_error', 'Internal server error'), BUSY, 'busy'],
  ['too many requests (429)', () => apiError(429, 'rate_limit_error', 'Number of requests has exceeded your rate limit.'), RATE_LIMIT, 'rate_limit'],
  ['no internet', () => { throw new TypeError('Failed to fetch'); }, OFFLINE, 'offline'],
];

afterEach(() => vi.useRealTimers());

describe('AI Mode: errors from Anthropic are shown in plain words (B8)', () => {
  it('a key Anthropic does not accept (401): says so, and marks the key as not working', async () => {
    const w = world(() => apiError(401, 'authentication_error', 'invalid x-api-key'));
    await w.start(QUICK);
    const job = await finished(w);
    expect(job).toMatchObject({ step: 'error', failedStep: 'writing', message: null });
    expect(job.error).toEqual({ message: NOT_ACCEPTED, code: 'auth' });

    // The panel then shows "Key not working" for this key. Only the key's
    // last 8 characters are kept here, never the whole key a second time.
    // (8, not 4: real keys all end in "AA", so 4 often match. See below.)
    const status = await keyStatus(w);
    expect(status).toMatchObject({ state: 'invalid', keyTail: API_KEY.slice(-8), reason: NOT_ACCEPTED, code: 'auth' });
    expect(JSON.stringify(status)).not.toContain(API_KEY);
  });

  it('an organization that blocks calls from a browser (401 "CORS"): says that, not "key not accepted"', async () => {
    const w = world(() => apiError(401, 'authentication_error',
      'CORS requests are not allowed for this Organization because of its data retention settings.'));
    await w.start(QUICK);
    const job = await finished(w);
    expect(job).toMatchObject({ step: 'error', failedStep: 'writing', message: null });
    expect(job.error).toEqual({ message: ORG_BLOCKED, code: 'auth' });
    // The key cannot work here, and the panel gives this reason for it.
    expect(await keyStatus(w)).toMatchObject({ state: 'invalid', keyTail: API_KEY.slice(-8), reason: ORG_BLOCKED, code: 'auth' });
  });

  it("passes on Anthropic's own reason (400), and does not blame the key", async () => {
    const w = world(() => apiError(400, 'invalid_request_error', PROMPT_TOO_LONG));
    await w.start(QUICK);
    const job = await finished(w);
    expect(job.error).toEqual({ message: `Anthropic said: ${PROMPT_TOO_LONG}`, code: 'bad_request' });
    expect(w.calls).toHaveLength(1); // no resume was sent, so there is nothing to leave out and try again
    expect(await keyStatus(w)).toBeUndefined();
  });

  it.each([
    ['too many requests (429)', apiError(429, 'rate_limit_error', 'Number of requests has exceeded your rate limit.'), RATE_LIMIT, 'rate_limit'],
    ['Anthropic is overloaded (529)', apiError(529, 'overloaded_error', 'Overloaded'), BUSY, 'busy'],
    ['Anthropic has a problem (500)', apiError(500, 'api_error', 'Internal server error'), BUSY, 'busy'],
  ])('%s: says to try again later, and does not blame the key', async (_what, reply, message, code) => {
    const w = world(() => reply);
    await w.start(QUICK);
    const job = await finished(w);
    expect(job).toMatchObject({ step: 'error', failedStep: 'writing' });
    expect(job.error).toEqual({ message, code });
    expect(await keyStatus(w)).toBeUndefined();
  });

  // Here, trying again would not help. So the message says what is wrong,
  // in Anthropic's own words when it gives a reason. Only an error with no
  // reason and no case of its own ends with "Please try again".
  //
  // No credit, a failed payment or your spend limit stop AI Mode until you
  // act. So the key is marked, and the panel shows "Billing problem" or
  // "Spend limit reached", with the reason.
  it.each([
    ['no credit left (400 "credit balance is too low")', apiError(400, 'invalid_request_error', NO_CREDIT), NO_CREDIT_SAID, 'billing'],
    ['a billing problem (402)', apiError(402, 'billing_error', 'Your credit card was declined.'), CARD_DECLINED, 'billing'],
    ['a billing problem with no reason given (402)', [402, {}],
      'Anthropic could not bill your account. Check Plans & Billing at console.anthropic.com, or remove your key to use Free Mode.',
      'billing'],
    ['the spend limit you set is reached (429)', SPEND_LIMIT_REPLY, `Anthropic said: ${SPEND_LIMIT}`, 'spend_limit'],
    ['the spend limit you set is reached, with no reason given (429)',
      [429, { type: 'error', error: { type: 'rate_limit_error', details: { error_code: 'enforced_spend_limit_reached' } } }],
      'Anthropic said: your spend limit is reached.', 'spend_limit'],
  ])('%s: says what is wrong, and marks the key until you act', async (_what, reply, message, code) => {
    const w = world(() => reply);
    await w.start(QUICK);
    const job = await finished(w);
    expect(job).toMatchObject({ step: 'error', failedStep: 'writing', message: null });
    expect(job.error).toEqual({ message, code });
    expect(w.calls).toHaveLength(1);
    const status = await keyStatus(w);
    expect(status).toMatchObject({ state: 'invalid', keyTail: API_KEY.slice(-8), reason: message, code });
    expect(JSON.stringify(status)).not.toContain(API_KEY);
  });

  it.each([
    ['a request that is too large (413)', apiError(413, 'request_too_large', 'Request exceeds the maximum allowed number of bytes.'),
      'The request was too large for Anthropic (often a large resume PDF).', 'too_large'],
    ['another refusal, with a reason (422)', apiError(422, 'invalid_request_error', 'This request cannot be processed.'),
      'Anthropic said: This request cannot be processed.', 'http_422'],
    ['another refusal, with no reason (405)', html(405, 'Method Not Allowed'),
      'The request to Anthropic failed (error 405). Please try again.', 'http_405'],
  ])('%s: says what is wrong, and does not blame the key', async (_what, reply, message, code) => {
    const w = world(() => reply);
    await w.start(QUICK);
    const job = await finished(w);
    expect(job).toMatchObject({ step: 'error', failedStep: 'writing', message: null });
    expect(job.error).toEqual({ message, code });
    expect(w.calls).toHaveLength(1);
    expect(await keyStatus(w)).toBeUndefined();
  });

  it('a key that may not do this (403) or an account that may not use the model (404): says so, and marks the key', async () => {
    const NOT_ALLOWED = 'Your Anthropic key is not allowed to do this: This organization cannot use the API.';
    const forbidden = world(() => apiError(403, 'permission_error', 'This organization cannot use the API.'));
    await forbidden.start(QUICK);
    expect((await finished(forbidden)).error).toEqual({ message: NOT_ALLOWED, code: 'auth' });
    expect(await keyStatus(forbidden)).toMatchObject({ state: 'invalid', keyTail: API_KEY.slice(-8), reason: NOT_ALLOWED, code: 'auth' });

    const noModel = world(() => apiError(404, 'not_found_error', 'model: claude-haiku-5-5'));
    await noModel.start(QUICK);
    expect((await finished(noModel)).error).toEqual({ message: NO_MODEL, code: 'model' });
    expect(await keyStatus(noModel)).toMatchObject({ state: 'invalid', keyTail: API_KEY.slice(-8), reason: NO_MODEL, code: 'model' });
  });

  it('a network failure says to check the internet connection', async () => {
    const w = world(() => { throw new TypeError('Failed to fetch'); });
    await w.start(QUICK);
    const job = await finished(w);
    expect(job.error).toEqual({ message: OFFLINE, code: 'offline' });
  });

  it.each(BAD_KEYS)('a saved key with %s: says so, sends nothing (it is not "no internet"), and marks the key', async (_what, key) => {
    const w = world(undefined, { userApiKey: key });
    await w.start(QUICK);
    const job = await finished(w);
    expect(job).toMatchObject({ step: 'error', failedStep: 'writing', message: null });
    expect(job.error).toEqual({ message: BAD_KEY, code: 'bad_key' });
    expect(w.fetch).not.toHaveBeenCalled();
    // The tail is taken from the key as saved, the same way the panel takes it.
    expect(await keyStatus(w)).toMatchObject({ state: 'invalid', keyTail: key.trim().slice(-8), reason: BAD_KEY, code: 'bad_key' });
  });

  it('an HTML error page (e.g. 502 from a proxy) does not leak a JSON parse error', async () => {
    const w = world(() => html(502, '<!DOCTYPE html><html><body>Bad Gateway</body></html>'));
    await w.start(QUICK);
    const job = await finished(w);
    expect(job.step).toBe('error');
    expect(job.error.message).not.toMatch(/Unexpected token|JSON|DOCTYPE/i);
    expect(job.error).toEqual({ message: BUSY, code: 'busy' });
  });

  it('a page that is not JSON, with status 200 (e.g. a Wi-Fi login page), is not used as the message', async () => {
    const w = world(() => html(200, '<!DOCTYPE html><html><body>Log in to the Wi-Fi first.</body></html>'));
    await w.start(QUICK);
    const job = await finished(w);
    expect(job).toMatchObject({ step: 'error', message: null });
    expect(job.error).toEqual({ message: 'Anthropic sent an unexpected reply. Please try again.', code: 'bad_response' });
  });

  it('Claude declines (stop_reason "refusal"): says so, and its text is not used as the message', async () => {
    const w = world(() => claudeReply("I can't help with that.", { stop_reason: 'refusal' }));
    await w.start(QUICK);
    const job = await finished(w);
    expect(job).toMatchObject({ step: 'error', message: null });
    expect(job.error.code).toBe('refusal');
    expect(job.error.message).toMatch(/^Claude declined to write this one\./);
    expect(job.error.message).toMatch(/Free Mode/);
    expect(await w.recent()).toEqual([]); // nothing in the tracker
  });

  it('an empty reply cut off by max_tokens says Claude stopped before it finished', async () => {
    const w = world(() => claudeReply('', { stop_reason: 'max_tokens' }));
    await w.start(QUICK);
    const job = await finished(w);
    expect(job.error).toEqual({ message: 'Claude stopped before it finished. Please try again.', code: 'max_tokens' });
  });

  it('an empty reply is an error, not an empty message', async () => {
    const w = world(() => claudeReply('  '));
    await w.start(QUICK);
    const job = await finished(w);
    expect(job).toMatchObject({ step: 'error', message: null });
    expect(job.error).toEqual({ message: 'Claude sent back an empty message. Please try again.', code: 'empty' });
  });
});

// The badge is about the key you have saved NOW. A run started with your
// old key can end after you saved a new one. Then it changes nothing: it
// neither marks the new key, nor clears a mark on it.
describe('AI Mode: which key is marked "not working"', () => {
  it('a run with your old key that is refused does not mark the new key you saved while it ran', async () => {
    const gate = deferred();
    const w = world(async (body) => {
      if (promptText(body) === 'Reply with the single word: OK') return claudeReply('OK'); // the Test of the new key
      await gate.promise;
      return apiError(401, 'authentication_error', 'invalid x-api-key');
    });
    const panel = await openPanel(w);
    await w.start(QUICK);
    await until(() => w.calls.length === 1); // the run's request is out, with the old key
    expect(w.calls[0].headers['x-api-key']).toBe(API_KEY);

    // While it runs, you paste a new key in Settings and press Test. It
    // works, so the panel saves it, with its status.
    type(panel.$('api-key'), NEW_KEY);
    panel.$('validate-btn').click();
    const working = await until(async () => {
      const status = await keyStatus(w);
      return status && status.state === 'ai' ? status : null;
    });
    expect(working).toMatchObject({ state: 'ai', keyTail: NEW_KEY.slice(-8) });
    expect((await w.chrome.storage.local.get('userApiKey')).userApiKey).toBe(NEW_KEY);
    expect(w.calls[1].headers['x-api-key']).toBe(NEW_KEY); // the Test used the new key

    gate.resolve(); // now Anthropic refuses the OLD key
    const job = await finished(w);
    expect(job.error).toEqual({ message: NOT_ACCEPTED, code: 'auth' }); // the run still says why it failed
    // The badge still says your new key works.
    expect(await keyStatus(w)).toEqual(working);
    expect(panel.$('key-status').textContent).toBe('● AI Mode');
    panel.close();
  });

  it('a run with your old key that works does not clear "Key not working" for the new key you saved', async () => {
    const gate = deferred();
    const w = world(async (body) => {
      // You mistyped the new key, so Anthropic refuses its Test.
      if (promptText(body) === 'Reply with the single word: OK') return apiError(401, 'authentication_error', 'invalid x-api-key');
      await gate.promise;
      return claudeReply(HELLO);
    });
    await w.start(QUICK);
    await until(() => w.calls.length === 1); // the run's request is out, with the old key
    expect(w.calls[0].headers['x-api-key']).toBe(API_KEY);

    // While it runs, you save the new key and press Test. It fails, so it is marked.
    await w.chrome.storage.local.set({ userApiKey: NEW_KEY });
    expect(await testKey(w, NEW_KEY)).toEqual({ valid: false, reason: NOT_ACCEPTED, code: 'auth' });
    expect(w.calls[1].headers['x-api-key']).toBe(NEW_KEY);
    const marked = await keyStatus(w);
    expect(marked).toMatchObject({ state: 'invalid', keyTail: NEW_KEY.slice(-8), reason: NOT_ACCEPTED, code: 'auth' });

    gate.resolve(); // now the run with the OLD key works
    expect(await finished(w)).toMatchObject({ step: 'done', writer: 'ai', message: HELLO });
    // That says nothing about the new key: it is still marked.
    expect(await keyStatus(w)).toEqual(marked);
  });

  it('the mark names the key by its last 8 characters, so two keys that end in the same 4 are told apart', async () => {
    // Real Anthropic keys all end in "AA", so the last 4 characters of two
    // keys often match. These two keys (made up) share their last 4, not their last 8.
    const KEY_A = 'sk-ant-test-1111-00AA';
    const KEY_B = 'sk-ant-test-2222-00AA';
    expect(KEY_A.slice(-4)).toBe(KEY_B.slice(-4));

    const w = world(() => apiError(401, 'authentication_error', 'invalid x-api-key'), { userApiKey: KEY_A });
    await w.start(QUICK);
    expect((await finished(w)).error.code).toBe('auth');
    const status = await keyStatus(w);
    expect(status).toMatchObject({ state: 'invalid', keyTail: '111-00AA' });
    expect(status.keyTail).not.toBe(KEY_B.slice(-8)); // so the panel does not show this mark for key B
  });
});

// Busy, too many requests, too slow, or no internet: none of these says
// anything about your key. So the badge keeps what it knew.
describe('AI Mode: only a problem with the key marks it', () => {
  const WORKING = { state: 'ai', keyTail: API_KEY.slice(-8), checkedAt: 1 };

  it.each(NOT_THE_KEY)('%s, in a run: the key you saved is not marked', async (_what, claude, message, code) => {
    const w = world(claude, { keyStatus: WORKING });
    await w.start(QUICK);
    expect((await finished(w)).error).toEqual({ message, code });
    expect(await keyStatus(w)).toEqual(WORKING);
  });

  it.each(NOT_THE_KEY)('%s, when you Test the key you saved: it is not marked', async (_what, claude, reason, code) => {
    const w = world(claude, { keyStatus: WORKING });
    expect(await testKey(w, API_KEY)).toEqual({ valid: false, reason, code });
    expect(await keyStatus(w)).toEqual(WORKING);
  });

  it('too slow (a time-out), in a run and in a Test: the key you saved is not marked', async () => {
    vi.useFakeTimers();
    const w = world(() => 'hang', { keyStatus: WORKING });
    await w.start(QUICK);
    const tested = testKey(w, API_KEY);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await w.job('/in/aoife/')).error).toEqual({ message: TOO_LONG, code: 'timeout' });
    expect(await tested).toEqual({ valid: false, reason: TOO_LONG, code: 'timeout' });
    expect(await keyStatus(w)).toEqual(WORKING);
  });
});

describe('AI Mode: a resume Anthropic cannot use', () => {
  it.each([
    ['cannot read the PDF (400)', apiError(400, 'invalid_request_error', 'messages.0.content.0.pdf.source: The PDF specified was not valid.')],
    ['finds the request too large (413)', apiError(413, 'request_too_large', 'Request exceeds the maximum allowed number of bytes.')],
  ])('Anthropic %s: writes it once more without the resume, and the job says so', async (_what, refusal) => {
    const w = world((body) => (hasResume(body) ? refusal : claudeReply(HELLO)), RESUME);
    await w.start(QUICK);
    const job = await finished(w);
    expect(job).toMatchObject({ step: 'done', writer: 'ai', message: HELLO, resumeSkipped: true });
    expect(w.calls.map(kinds)).toEqual([['document', 'text'], ['text']]);
    // The second prompt does not talk about a resume that is not there.
    expect(promptText(w.calls[0].body)).toContain('My resume is attached as a PDF.');
    expect(promptText(w.calls[1].body)).not.toMatch(/resume/i);
  });

  it('if it fails again without the resume, it stops: one more try, not more', async () => {
    const w = world(() => apiError(400, 'invalid_request_error', PROMPT_TOO_LONG), RESUME);
    await w.start(QUICK);
    const job = await finished(w);
    expect(w.calls.map(kinds)).toEqual([['document', 'text'], ['text']]);
    expect(job).toMatchObject({ step: 'error', failedStep: 'writing', message: null });
    expect(job.error).toEqual({ message: `Anthropic said: ${PROMPT_TOO_LONG}`, code: 'bad_request' });
  });

  it.each([
    ['a key that is not accepted (401)', apiError(401, 'authentication_error', 'invalid x-api-key'), 'auth'],
    ['no credit left (400 "credit balance is too low")', apiError(400, 'invalid_request_error', NO_CREDIT), 'billing'],
    ['Anthropic is overloaded (529)', apiError(529, 'overloaded_error', 'Overloaded'), 'busy'],
  ])('%s: not tried again without the resume (the resume is not the problem)', async (_what, reply, code) => {
    const w = world(() => reply, RESUME);
    await w.start(QUICK);
    const job = await finished(w);
    expect(w.calls.map(kinds)).toEqual([['document', 'text']]);
    expect(job).toMatchObject({ step: 'error', message: null });
    expect(job.error.code).toBe(code);
    expect(job.resumeSkipped).toBeFalsy();
  });
});

describe('AI Mode: a run that works', () => {
  it('saves the message, and marks the key as working (an old warning goes away)', async () => {
    // You had no credit left. You paid, and now it works again.
    const w = world(() => claudeReply(HELLO), {
      keyStatus: { state: 'invalid', keyTail: API_KEY.slice(-8), reason: NO_CREDIT_SAID, code: 'billing', checkedAt: 1 },
    });
    await w.start(QUICK);
    const job = await finished(w);
    expect(job).toMatchObject({ step: 'done', writer: 'ai', message: HELLO });

    const status = await keyStatus(w);
    expect(status).toMatchObject({ state: 'ai', keyTail: API_KEY.slice(-8) });
    expect(status).not.toHaveProperty('reason');
    expect(status).not.toHaveProperty('code');
    expect(status.checkedAt).toBeGreaterThan(1);
    expect(JSON.stringify(status)).not.toContain(API_KEY);
  });

  it('removes what Claude sometimes puts around the message ("Here is…", quotes)', async () => {
    const w = world(() => claudeReply('Here is a short note:\n\n"Hi Aoife! Open to a chat?"'));
    await w.start(QUICK);
    expect((await finished(w)).message).toBe('Hi Aoife! Open to a chat?');
  });
});

describe('requests to Claude time out instead of spinning forever (B9)', () => {
  it('gives up after 30 seconds, with a clear message', async () => {
    vi.useFakeTimers();
    const w = world(() => 'hang');
    await w.start(QUICK);

    await vi.advanceTimersByTimeAsync(29_000);
    expect((await w.job('/in/aoife/')).step).toBe('writing'); // still waiting

    await vi.advanceTimersByTimeAsync(1_000);
    const job = await w.job('/in/aoife/');
    expect(job).toMatchObject({ step: 'error', failedStep: 'writing' });
    expect(job.error).toEqual({ message: TOO_LONG, code: 'timeout' });
  });

  it('with your resume attached, it waits 60 seconds (a PDF takes longer to send), then says the resume makes it slow', async () => {
    vi.useFakeTimers();
    const w = world(() => 'hang', RESUME);
    await w.start(QUICK);

    await vi.advanceTimersByTimeAsync(59_000);
    expect((await w.job('/in/aoife/')).step).toBe('writing'); // still waiting

    await vi.advanceTimersByTimeAsync(1_000);
    const job = await w.job('/in/aoife/');
    expect(job).toMatchObject({ step: 'error', failedStep: 'writing' });
    // What to do about it: try again, or stop sending the resume.
    expect(job.error).toEqual({ message: TOO_LONG_WITH_RESUME, code: 'timeout' });
    expect(w.calls.map(kinds)).toEqual([['document', 'text']]); // a time-out is not tried again without the resume
  });

  it('the second try, without your resume, has the usual 30 seconds', async () => {
    vi.useFakeTimers();
    // Anthropic cannot read the PDF. Then the request without it never answers.
    const w = world((body) => (hasResume(body)
      ? apiError(400, 'invalid_request_error', 'The PDF specified was not valid.')
      : 'hang'), RESUME);
    await w.start(QUICK);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(w.calls.map(kinds)).toEqual([['document', 'text'], ['text']]); // the second try is out
    expect((await w.job('/in/aoife/')).step).toBe('writing'); // still waiting

    await vi.advanceTimersByTimeAsync(1_000);
    const job = await w.job('/in/aoife/');
    expect(job).toMatchObject({ step: 'error', failedStep: 'writing', message: null });
    // That request had no resume, so the message does not talk about one.
    expect(job.error).toEqual({ message: TOO_LONG, code: 'timeout' });
  });

  it('Deep Mode: the talking points are kept, and it fails at the writing step', async () => {
    vi.useFakeTimers();
    const w = world(() => 'hang');
    await w.start(DEEP);
    await vi.advanceTimersByTimeAsync(30_000);
    const job = await w.job('/in/aoife/');
    expect(job).toMatchObject({ step: 'error', failedStep: 'writing', enrichmentJSON: { topHooks: ['Works at Spotify'] } });
    expect(job.error.code).toBe('timeout');
  });

  it('the key test gives up and says why', async () => {
    vi.useFakeTimers();
    const w = world(() => 'hang');
    const pending = testKey(w, API_KEY);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual({ valid: false, reason: TOO_LONG, code: 'timeout' });
  });
});

describe('Settings: testing your Anthropic key', () => {
  it('a working key that is not saved yet: one tiny real request, and the background notes nothing', async () => {
    const w = freeWorld(); // no key saved yet
    expect(await testKey(w, `  ${API_KEY}  `)).toEqual({ valid: true });

    expect(w.calls).toHaveLength(1);
    const [call] = w.calls;
    expect(call.path).toBe('/v1/messages');
    expect(call.headers).toMatchObject({
      'x-api-key': API_KEY, // without the spaces
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
    // A real (tiny) request, so a key with no credit left is caught too.
    expect(call.body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 16, thinking: { type: 'disabled' } });
    expect(promptText(call.body)).toBe('Reply with the single word: OK');
    // The panel saves this key next, with its status (if it is still open,
    // and its box still holds this key). The background notes nothing.
    expect(await keyStatus(w)).toBeUndefined();
  });

  it('the key you saved passes its Test: AI Mode is noted, and an old mark goes away', async () => {
    const w = world(undefined, {
      keyStatus: { state: 'invalid', keyTail: API_KEY.slice(-8), reason: NO_CREDIT_SAID, code: 'billing', checkedAt: 1 },
    });
    expect(await testKey(w, ` ${API_KEY} `)).toEqual({ valid: true });
    const status = await keyStatus(w);
    expect(status).toEqual({ state: 'ai', keyTail: API_KEY.slice(-8), checkedAt: expect.any(Number) });
    expect(status.checkedAt).toBeGreaterThan(1);
  });

  it('another key passes its Test: the mark on the key you saved stays exactly as it was', async () => {
    // Your saved key has no credit left ("Billing problem"). You paste
    // another key and press Test, then close the panel before the answer
    // comes (a popup closes when you click outside it). That key works,
    // but it was never saved: AI Mode still uses the key with no credit.
    const mark = { state: 'invalid', keyTail: API_KEY.slice(-8), reason: NO_CREDIT_SAID, code: 'billing', checkedAt: 1 };
    const w = world(undefined, { keyStatus: mark });
    expect(await testKey(w, NEW_KEY)).toEqual({ valid: true });
    expect(w.calls[0].headers['x-api-key']).toBe(NEW_KEY);
    expect(await keyStatus(w)).toEqual(mark);
    expect((await w.chrome.storage.local.get('userApiKey')).userApiKey).toBe(API_KEY); // still your old key
  });

  it.each(KEY_PROBLEMS)('a key that does not work, %s: says why', async (_what, reply, reason, code) => {
    const w = freeWorld({ claude: () => reply });
    expect(await testKey(w, API_KEY)).toEqual({ valid: false, reason, code });
    // The key in the field is not saved yet, so nothing is marked.
    expect(await keyStatus(w)).toBeUndefined();
  });

  it.each(KEY_PROBLEMS)('the key you saved fails its Test, %s: it is marked, with the reason and its code', async (_what, reply, reason, code) => {
    const w = world(() => reply);
    expect(await testKey(w, ` ${API_KEY} `)).toEqual({ valid: false, reason, code });
    const status = await keyStatus(w);
    expect(status).toMatchObject({ state: 'invalid', keyTail: API_KEY.slice(-8), reason, code });
    expect(JSON.stringify(status)).not.toContain(API_KEY);
  });

  it.each(KEY_PROBLEMS)('another key fails its Test, %s: the key you saved is not marked', async (_what, reply, reason, code) => {
    const saved = { state: 'ai', keyTail: NEW_KEY.slice(-8), checkedAt: 1 };
    const w = world(() => reply, { userApiKey: NEW_KEY, keyStatus: saved });
    expect(await testKey(w, API_KEY)).toEqual({ valid: false, reason, code });
    expect(await keyStatus(w)).toEqual(saved);
  });

  it.each(BAD_KEYS)('a key with %s: says so, without any request', async (_what, key) => {
    const w = freeWorld();
    expect(await testKey(w, key)).toEqual({ valid: false, reason: BAD_KEY, code: 'bad_key' });
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('an empty field is refused without any request', async () => {
    const w = freeWorld();
    expect(await testKey(w, '   ')).toEqual({ valid: false, reason: 'Paste your key first.', code: 'empty' });
    expect(w.fetch).not.toHaveBeenCalled();
  });
});

// Before it marks (or clears) a key, the background reads your saved key, to
// check that the run or Test used that key. That read can fail (rare: Chrome
// cannot read its storage). Then the key counts as "not saved": nothing is
// marked or cleared, and the run or Test ends as usual.
describe('AI Mode: when your saved key cannot be read (a storage error)', () => {
  const STORAGE_ERROR = 'IO error: could not read the storage.';
  const MARK    = { state: 'invalid', keyTail: API_KEY.slice(-8), reason: NO_CREDIT_SAID, code: 'billing', checkedAt: 1 };
  const WORKING = { state: 'ai', keyTail: API_KEY.slice(-8), checkedAt: 1 };

  /**
   * From now on, reading the saved key on its own (with the AI provider it
   * is for) fails, the way Chrome fails a storage read. (The run's other
   * reads, such as its settings, still work.) Returns the list of reads that
   * failed, to check this really happened.
   */
  function failKeyReads(w) {
    const get = w.chrome.storage.local.get;
    const failed = [];
    w.chrome.storage.local.get = (keys, cb) => {
      if (!cb && [].concat(keys).sort().join() === 'aiProvider,userApiKey') {
        failed.push(keys);
        return Promise.reject(new Error(STORAGE_ERROR));
      }
      return get(keys, cb);
    };
    return failed;
  }

  /** The answer to a message, or 'no answer' if none came within a second. */
  function answerWithin(reply) {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve('no answer'), 1000); });
    return Promise.race([reply, late]).finally(() => clearTimeout(timer));
  }

  /**
   * With fake timers: let up to 5 seconds pass, a little at a time, until
   * Aoife's job has ended. Returns the job as saved then. (5 seconds is
   * less than one heartbeat, 15 seconds.)
   */
  async function endedSoon(w) {
    for (let ms = 0; ms < 5_000; ms += 100) {
      await vi.advanceTimersByTimeAsync(100);
      const job = await w.job('/in/aoife/');
      if (job && !RUNNING.includes(job.step)) return job;
    }
    return w.job('/in/aoife/');
  }

  it('a run that Anthropic refuses still ends: the error shows, the heartbeat stops, and you can run it again', async () => {
    vi.useFakeTimers();
    const w = world(() => apiError(401, 'authentication_error', 'invalid x-api-key'), { keyStatus: WORKING });
    const failed = failKeyReads(w);
    expect(await w.start(QUICK)).toEqual({ ok: true, profileKey: '/in/aoife/' });

    // The error shows at once (not only when the next heartbeat saves the job).
    const job = await endedSoon(w);
    expect(job).toMatchObject({ step: 'error', failedStep: 'writing', message: null });
    expect(job.error).toEqual({ message: NOT_ACCEPTED, code: 'auth' }); // not the storage error
    expect(failed).toHaveLength(1); // it did try to read your key
    expect(await keyStatus(w)).toEqual(WORKING); // it could not tell it was your key, so nothing is marked

    // The heartbeat (every 15 seconds) stopped: a minute later, nothing has saved the job again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await w.job('/in/aoife/')).toEqual(job);

    // The profile is free: Generate is not refused with "Already working on this profile."
    expect(await w.start(QUICK)).toEqual({ ok: true, profileKey: '/in/aoife/' });
    expect(await endedSoon(w)).toMatchObject({ step: 'error', error: { message: NOT_ACCEPTED, code: 'auth' } });
    expect(w.calls).toHaveLength(2);
  });

  it('a run that works still ends "done", with the message (not with the storage error)', async () => {
    const w = world(() => claudeReply(HELLO), { keyStatus: MARK });
    const failed = failKeyReads(w);
    await w.start(QUICK);
    const job = await finished(w);
    expect(job).toMatchObject({ step: 'done', writer: 'ai', message: HELLO, error: null });
    expect(failed).toHaveLength(1);
    expect((await w.recent())[0]).toMatchObject({ name: 'Aoife', message: HELLO });
    // It could not tell it was your key, so the old mark stays (the next Test or run clears it).
    expect(await keyStatus(w)).toEqual(MARK);
  });

  it.each([
    ['a key that works', () => claudeReply('OK'), { valid: true }, MARK],
    ['a key Anthropic refuses (401)', () => apiError(401, 'authentication_error', 'invalid x-api-key'),
      { valid: false, reason: NOT_ACCEPTED, code: 'auth' }, WORKING],
  ])('a Test of %s still answers the panel, and changes no mark', async (_what, claude, answer, before) => {
    const w = world(claude, { keyStatus: before });
    const failed = failKeyReads(w);
    expect(await answerWithin(testKey(w, API_KEY))).toEqual(answer);
    expect(failed).toHaveLength(1);
    expect(await keyStatus(w)).toEqual(before);
  });
});

describe('job guard rails', () => {
  it('starts without a key, in Free Mode, and sends nothing anywhere', async () => {
    const w = freeWorld();
    expect(await w.start(QUICK)).toEqual({ ok: true, profileKey: '/in/aoife/' });
    const job = await finished(w);
    expect(job).toMatchObject({ step: 'done', writer: 'free' });
    expect(job.message).toMatch(/^Hi Aoife,/);
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.calls).toEqual([]);
    expect(await keyStatus(w)).toBeUndefined(); // Free Mode needs no key status
  });

  it('a key field with only spaces also means Free Mode', async () => {
    const w = freeWorld({ local: { userApiKey: '   ' } });
    await w.start(QUICK);
    expect(await finished(w)).toMatchObject({ step: 'done', writer: 'free' });
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('"New version" is accepted the instant a run shows done (no lock race)', async () => {
    const w = freeWorld();
    const answers = [];
    // React exactly when "done" is saved: that is when the panel shows the
    // message and the user can press "New version".
    w.chrome.storage.onChanged.addListener((changes, area) => {
      const job = changes['job:/in/aoife/'] && changes['job:/in/aoife/'].newValue;
      if (area === 'session' && job && job.step === 'done' && answers.length === 0) {
        answers.push(w.start({ ...QUICK, regenerate: true }));
      }
    });
    await w.start(QUICK);
    await until(() => answers.length === 1);
    expect(await answers[0]).toMatchObject({ ok: true });
  });

  it('refuses to start when the tab is not a LinkedIn profile', async () => {
    const w = freeWorld({ tabs: [{ id: 1, url: 'https://www.linkedin.com/feed/', active: true }] });
    expect(await w.start(QUICK)).toEqual({ ok: false, error: 'Open a LinkedIn profile first.' });
    expect(await w.chrome.storage.session.get(null)).toEqual({});
  });

  it('stops if the tab moved to another person before reading', async () => {
    const w = freeWorld();
    // The first look at the tab (job start) sees Aoife; by the time the page
    // is read, the user has clicked through to someone else.
    const realGet = w.chrome.tabs.get;
    let looks = 0;
    w.chrome.tabs.get = vi.fn(async (id) => {
      const tab = await realGet(id);
      if (++looks > 1) tab.url = 'https://www.linkedin.com/in/someone-else/';
      return tab;
    });
    await w.start(QUICK);
    const job = await finished(w);
    expect(job).toMatchObject({ step: 'error', failedStep: 'reading' });
    expect(job.error.message).toMatch(/moved to another page/i);
  });
});
