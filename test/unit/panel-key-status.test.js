// The header says how messages are written: "● Free Mode" (no key: a
// template, on this device) or "● AI Mode" (Claude, with your own Anthropic
// key). If Anthropic stops the key, the header names the problem ("Key not
// working", "Billing problem", "Spend limit reached" or "AI Mode not
// available"), and shows why.
// Also Settings: the key box (Test, Enter, Save, an empty box for Free Mode),
// your resume (sent to Anthropic only while its box is ticked), the privacy
// note, and two panels open at once (one in each Chrome window): what you
// save in one shows up in the other.
// Keys are told apart by their last 8 characters (keyTail). The key itself is
// never stored anywhere but in userApiKey.
import { describe, it, expect } from 'vitest';
import {
  createWorld, openPanel, person, until, settle, type, fire, deferred, claudeReply, promptText, API_KEY,
} from '../helpers/world.js';
import { read } from '../helpers/load.js';

const AOIFE = person('aoife', 'Aoife');
const HELLO = 'Hi Aoife! Would you be open to a quick chat?'; // what the default fake Claude writes to her

// Made-up keys. API_KEY (from the helpers) is 'sk-ant-test-0000'.
const TAIL       = 'est-0000';         // the last 8 characters of API_KEY
const OTHER_KEY  = 'sk-ant-test-1111';
const OTHER_TAIL = 'est-1111';
const THIRD_KEY  = 'sk-ant-test-2222';
// Two keys that end in the same 4 characters (real Anthropic keys all end in
// "AA"). Their last 8 characters differ, so they are two different keys.
const KEY_A = 'sk-ant-test-1234-00AA'; // last 8: '234-00AA'
const KEY_B = 'sk-ant-test-5678-00AA'; // last 8: '678-00AA'

// Tiny made-up PDFs. A test picks one; Save stores it as base64.
const PDF_A = { text: '%PDF-1.4\n', base64: 'JVBERi0xLjQK' };
const PDF_B = { text: '%PDF-1.7\n', base64: 'JVBERi0xLjcK' };
// A resume saved by Ark's 3.1.0: the file, but no "resumeForAI" (3.1.0 never sent it anywhere).
const OLD_RESUME = { resumeBase64: PDF_A.base64, resumeFileName: 'my-resume.pdf' };

// What the panel says when Anthropic stops a key.
const REFUSED   = 'Your Anthropic API key was not accepted. Check it in Settings, or remove it to use Free Mode.';
const NO_CREDIT = 'Anthropic said: Your credit balance is too low to access the Anthropic API. ' +
  'Please go to Plans & Billing to upgrade or purchase credits. Or remove your key to use Free Mode.';
const SPENT     = 'Anthropic said: Your workspace has reached its monthly spend limit.';
const NO_MODEL  = 'Your Anthropic account cannot use the model claude-haiku-5-5. ' +
  'Remove your key to use Free Mode, or update the extension.';
// What Save says.
const SAVED_AI          = 'Settings saved! AI Mode is on.';
const SAVED_FREE        = 'Settings saved! Free Mode is on (no key).';
const STILL_NOT_WORKING = 'Settings saved. AI Mode is still not working: press Test to check again.';
const READY             = 'Message ready. Written by Claude.';

// Anthropic's answers: a bad key, no credit left, a spend limit reached, a
// model the account cannot use, too busy.
const badKey     = () => [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }];
const noCredit   = () => [400, { type: 'error', error: { type: 'invalid_request_error',
  message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }];
const spendLimit = () => [429, { type: 'error', error: { type: 'rate_limit_error',
  message: 'Your workspace has reached its monthly spend limit.', details: { error_code: 'enforced_spend_limit_reached' } } }];
const noModel    = () => [404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-haiku-5-5' } }];
const busy       = () => [529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }];
// A request that runs out of time ends with an AbortError from fetch.
// Here it comes at once, not after the time limit.
const tooSlow    = () => { throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }); };

// Answers that mean AI Mode cannot work with the key until you act. The
// header names the problem, and shows the reason under it.
const PROBLEMS = [
  { why: 'a bad key',              answer: badKey,     code: 'auth',        label: 'Key not working',       reason: REFUSED },
  { why: 'no credit left',         answer: noCredit,   code: 'billing',     label: 'Billing problem',       reason: NO_CREDIT },
  { why: 'a spend limit',          answer: spendLimit, code: 'spend_limit', label: 'Spend limit reached',   reason: SPENT },
  { why: 'a model it cannot use',  answer: noModel,    code: 'model',       label: 'AI Mode not available', reason: NO_MODEL },
];

// What the background saves after Anthropic refused a key whose last 8 characters are `tail`.
const refused = (tail, reason = REFUSED, code = 'auth') => ({ state: 'invalid', keyTail: tail, reason, code, checkedAt: Date.now() });

// No `claude` given: the helper's default fake Claude answers.
function world({ local = {}, claude } = {}) {
  return createWorld({
    local,
    tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }],
    pages: { 1: AOIFE },
    claude,
  });
}

const badge   = (panel) => panel.$('key-status').textContent;
const hidden  = (el) => el.classList.contains('hidden');
// The warning under the header: its text, or null when it is hidden.
const warning = (panel) => (hidden(panel.$('no-key-warning')) ? null : panel.$('key-warning-text').textContent);
const stored  = async (w, name) => (await w.chrome.storage.local.get(name))[name];
const resumeKeys = (w) => w.chrome.storage.local.get(['resumeBase64', 'resumeFileName', 'resumeForAI']);
const myDetails  = (w) => w.chrome.storage.local.get(['userApiKey', 'userName', 'userBio']);

// From now on, the name of each setting written to storage, in order.
// [] means nothing was written at all.
function watchWrites(w) {
  const names = [];
  w.chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') names.push(...Object.keys(changes));
  });
  return names;
}
// The key the last request to Anthropic was sent with.
const keyUsed = (w) => w.calls.at(-1).headers['x-api-key'];

// The kinds of blocks in one request to Claude: ['document', 'text'] when
// the resume went with it, ['text'] when it did not.
const blocks = (call) => call.body.messages[0].content.map((b) => b.type);

// Press Save Settings, and return what it says. The old message is cleared
// first, so it cannot be read by mistake for the new one.
async function save(panel) {
  const bar = panel.$('settings-status');
  bar.textContent = '';
  panel.$('save-settings-btn').click();
  await until(() => bar.textContent.startsWith('Settings saved'));
  await settle(); // the header is drawn again after the message
  return bar.textContent;
}

// Press Enter in a box, the way a keyboard does.
function pressEnter(el) {
  const W = el.ownerDocument.defaultView;
  el.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

// Pick a PDF in the resume box, the way a user does in Chrome (it is saved
// on Save). Chrome fires "change" only when the pick differs from what the
// box holds already. So the same PDF can be picked again only if the panel
// emptied the box in between.
async function upload(panel, name, pdf = PDF_A) {
  const input  = panel.$('resume-upload');
  const before = input.value;
  input.files  = [new panel.window.File([pdf.text], name, { type: 'application/pdf' })];
  if (input.value === before) throw new Error(`Chrome would ignore this pick: the box still holds ${name}.`);
  fire(input, 'change');
  await until(() => panel.$('resume-status').textContent === `${name} ready — click Save Settings to confirm.`);
}

describe('the header: Free Mode or AI Mode', () => {
  it('no key: "● Free Mode", no warning, and nothing is sent anywhere', async () => {
    const w = world();
    const panel = await openPanel(w);
    expect(badge(panel)).toBe('● Free Mode');
    expect(panel.$('key-status').className).toBe('key-status free');
    expect(warning(panel)).toBeNull();
    expect(panel.$('generate-btn').disabled).toBe(false);
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('your own key: "● AI Mode", with no network call just to draw it', async () => {
    const w = world({ local: { userApiKey: API_KEY } });
    const panel = await openPanel(w);
    expect(badge(panel)).toBe('● AI Mode');
    expect(panel.$('key-status').className).toBe('key-status active');
    expect(warning(panel)).toBeNull();
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it.each(PROBLEMS)('Anthropic stops your key during a generate ($why): the header says "$label", with the reason', async ({ answer, code, label, reason }) => {
    const w = world({ local: { userApiKey: API_KEY }, claude: answer });
    const panel = await openPanel(w);
    panel.$('generate-btn').click();

    await until(() => panel.$('status-message').textContent === reason);
    await settle();
    expect(badge(panel)).toBe(label);
    expect(panel.$('key-status').className).toBe('key-status inactive');
    expect(warning(panel)).toBe(reason);
    // The status keeps only the key's last 8 characters, never the key itself.
    const status = await stored(w, 'keyStatus');
    expect(status).toMatchObject({ state: 'invalid', keyTail: TAIL, reason, code });
    expect(JSON.stringify(status)).not.toContain(API_KEY);
  });

  // Each problem the background can save, as the header shows it.
  it.each([
    { why: 'billing',     code: 'billing',     label: 'Billing problem',
      reason: 'Anthropic could not bill your account: Your payment method was declined. Check Plans & Billing at console.anthropic.com, or remove your key to use Free Mode.' },
    { why: 'spend_limit', code: 'spend_limit', label: 'Spend limit reached', reason: SPENT },
    { why: 'model',       code: 'model',       label: 'AI Mode not available', reason: NO_MODEL },
    { why: 'auth',        code: 'auth',        label: 'Key not working',     reason: REFUSED },
    { why: 'bad_key',     code: 'bad_key',     label: 'Key not working',
      reason: 'Your key has a character that cannot be in a key (often a curly quote or an invisible space from copying). Copy it again from console.anthropic.com.' },
    { why: 'no code (saved by an older version)', code: undefined, label: 'Key not working', reason: REFUSED },
  ])('a saved key problem, $why: the header says "$label", with the reason under it', async ({ code, label, reason }) => {
    const status = { state: 'invalid', keyTail: TAIL, reason, checkedAt: Date.now() };
    if (code) status.code = code;
    const w = world({ local: { userApiKey: API_KEY, keyStatus: status } });
    const panel = await openPanel(w);
    expect(badge(panel)).toBe(label);
    expect(panel.$('key-status').className).toBe('key-status inactive');
    expect(warning(panel)).toBe(reason);
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('the warning is only for the key that was refused (the same last 8 characters)', async () => {
    const reason = 'Your Anthropic key is not allowed to do this: This organization has been disabled.';
    const same = await openPanel(world({ local: { userApiKey: API_KEY, keyStatus: refused(TAIL, reason) } }));
    expect(badge(same)).toBe('Key not working');
    expect(warning(same)).toBe(reason);
    same.close();

    const other = await openPanel(world({ local: { userApiKey: OTHER_KEY, keyStatus: refused(TAIL, reason) } }));
    expect(badge(other)).toBe('● AI Mode');
    expect(warning(other)).toBeNull();
  });

  it('saving a different key takes the warning away', async () => {
    const w = world({ local: { userApiKey: API_KEY, keyStatus: refused(TAIL) } });
    const panel = await openPanel(w);
    expect(badge(panel)).toBe('Key not working');

    type(panel.$('api-key'), OTHER_KEY);
    panel.$('save-settings-btn').click();
    await until(() => badge(panel) === '● AI Mode');
    expect(warning(panel)).toBeNull();
    expect(await stored(w, 'userApiKey')).toBe(OTHER_KEY);
  });

  it('when the same key works again (say, after you add credit), the warning goes away', async () => {
    const panel = await openPanel(world({ local: { userApiKey: API_KEY, keyStatus: refused(TAIL, NO_CREDIT, 'billing') } }));
    expect(badge(panel)).toBe('Billing problem');

    panel.$('generate-btn').click();
    await until(() => panel.$('status-message').textContent === READY);
    await until(() => badge(panel) === '● AI Mode');
    expect(warning(panel)).toBeNull();
  });

  it('the Quick/Deep switch is named "Quick or Deep": here, "Mode" means Free Mode or AI Mode', async () => {
    const panel = await openPanel(world());
    const group = panel.$('mode-deep').parentElement;
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(group.getAttribute('aria-label')).toBe('Quick or Deep');
    expect([...group.children].map((b) => b.textContent)).toEqual(['⚡ Quick', '🔍 Deep']);
  });
});

describe('keys are told apart by their last 8 characters, not 4', () => {
  it('Anthropic refused key A. You save key B, which ends in the same 4 characters: the header says AI Mode', async () => {
    const w = world({ local: { userApiKey: KEY_A }, claude: badKey });
    const panel = await openPanel(w);
    panel.$('generate-btn').click();
    await until(() => panel.$('status-message').textContent === REFUSED);
    await until(() => badge(panel) === 'Key not working');
    expect(await stored(w, 'keyStatus')).toMatchObject({ state: 'invalid', keyTail: '234-00AA' });

    type(panel.$('api-key'), KEY_B);
    expect(await save(panel)).toBe(SAVED_AI);
    expect(badge(panel)).toBe('● AI Mode');
    expect(warning(panel)).toBeNull();
  });

  it('a message that works with your saved key B does not clear a failed Test of key A (same last 4 characters)', async () => {
    // Your saved key B works. Key A has no credit left.
    const w = world({
      local: { userApiKey: KEY_B },
      claude: () => (keyUsed(w) === KEY_A ? noCredit() : claudeReply(HELLO)),
    });
    const panel = await openPanel(w);
    type(panel.$('api-key'), KEY_A); // you paste key A and Test it
    panel.$('validate-btn').click();
    await until(() => panel.$('key-validation-status').textContent === `✗ ${NO_CREDIT}`);

    panel.$('generate-btn').click(); // a message with your saved key B works
    await until(() => panel.$('status-message').textContent === READY);
    expect(await stored(w, 'keyStatus')).toMatchObject({ state: 'ai', keyTail: '678-00AA' });

    expect(await save(panel)).toBe(STILL_NOT_WORKING); // then you save key A: its failed Test still counts
    expect(badge(panel)).toBe('Billing problem');
    expect(await stored(w, 'keyStatus')).toMatchObject({ state: 'invalid', keyTail: '234-00AA', reason: NO_CREDIT, code: 'billing' });
  });
});

describe('the key box in Settings', () => {
  it('Test: a working key is saved at once with its "AI Mode" status, and AI Mode starts', async () => {
    const w = world();
    const panel = await openPanel(w);
    panel.$('tabbtn-settings').click();
    type(panel.$('api-key'), `  ${API_KEY}  `);
    panel.$('validate-btn').click();

    await until(() => panel.$('key-validation-status').textContent === '✓ Key works. AI Mode is on.');
    expect(panel.$('key-validation-status').className).toBe('key-validation-status valid');
    expect(await stored(w, 'userApiKey')).toBe(API_KEY);
    // The key was not saved when the Test ran, so the panel writes its status
    // (the background only marks the saved key).
    expect(await stored(w, 'keyStatus')).toEqual({ state: 'ai', keyTail: TAIL, checkedAt: expect.any(Number) });
    await until(() => badge(panel) === '● AI Mode');
    // One small request to Anthropic, with the key you typed (trimmed).
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].headers['x-api-key']).toBe(API_KEY);
  });

  it('Test: a key that works clears its old mark, even before it is your saved key again', async () => {
    // Key B was marked when it ran out of credit. Since then you saved key A.
    const w = world({ local: { userApiKey: API_KEY, keyStatus: refused(OTHER_TAIL, NO_CREDIT, 'billing') } });
    const panel = await openPanel(w);
    expect(badge(panel)).toBe('● AI Mode'); // the mark is about B, not about your key A

    type(panel.$('api-key'), OTHER_KEY); // you add credit, paste B again, and Test it
    panel.$('validate-btn').click();
    await until(() => panel.$('key-validation-status').textContent === '✓ Key works. AI Mode is on.');
    await settle();
    expect(await stored(w, 'userApiKey')).toBe(OTHER_KEY);
    expect(await stored(w, 'keyStatus')).toEqual({ state: 'ai', keyTail: OTHER_TAIL, checkedAt: expect.any(Number) });
    expect(badge(panel)).toBe('● AI Mode');
    expect(warning(panel)).toBeNull();
  });

  it('Test: a key Anthropic refuses shows why, and is not saved', async () => {
    const w = world({ claude: badKey });
    const panel = await openPanel(w);
    type(panel.$('api-key'), API_KEY);
    panel.$('validate-btn').click();

    await until(() => panel.$('key-validation-status').textContent.startsWith('✗'));
    expect(panel.$('key-validation-status').textContent).toBe(`✗ ${REFUSED}`);
    expect(panel.$('key-validation-status').className).toBe('key-validation-status invalid');
    expect(await stored(w, 'userApiKey')).toBeUndefined();
    expect(await stored(w, 'keyStatus')).toBeUndefined();
    expect(badge(panel)).toBe('● Free Mode');
  });

  it("Test: a key with no credit left is caught too, with Anthropic's own reason", async () => {
    const panel = await openPanel(world({ claude: noCredit }));
    type(panel.$('api-key'), API_KEY);
    panel.$('validate-btn').click();

    await until(() => panel.$('key-validation-status').textContent.startsWith('✗'));
    expect(panel.$('key-validation-status').textContent).toBe(`✗ ${NO_CREDIT}`);
  });

  it('Test with an empty box asks you to paste a key, and sends nothing', async () => {
    const w = world();
    const panel = await openPanel(w);
    type(panel.$('api-key'), '   ');
    panel.$('validate-btn').click();
    await settle();

    expect(panel.$('key-validation-status').textContent).toBe('Paste your Anthropic API key first. Leave it empty to use Free Mode.');
    expect(panel.$('key-validation-status').className).toBe('key-validation-status invalid');
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('Enter in the key box runs Test, but does nothing while a Test is still running', async () => {
    const replies = []; // one per request to Anthropic, answered by the test
    const w = world({ claude: () => { const r = deferred(); replies.push(r); return r.promise; } });
    const panel = await openPanel(w);
    const box = panel.$('api-key');
    type(box, API_KEY);
    pressEnter(box);
    await until(() => w.calls.length === 1);
    expect(panel.$('validate-btn').disabled).toBe(true);
    expect(panel.$('validate-btn').textContent).toBe('…');

    pressEnter(box); // Enter again (twice) while it runs: nothing happens
    pressEnter(box);
    await settle();
    expect(w.calls).toHaveLength(1);

    replies[0].resolve(claudeReply('OK'));
    await until(() => panel.$('key-validation-status').textContent === '✓ Key works. AI Mode is on.');
    expect(panel.$('validate-btn').disabled).toBe(false);
    expect(panel.$('validate-btn').textContent).toBe('Test');

    pressEnter(box); // once it is done, Enter runs Test again
    await until(() => w.calls.length === 2);
    replies[1].resolve(claudeReply('OK'));
    await until(() => !panel.$('validate-btn').disabled);
    expect(w.calls).toHaveLength(2);
  });

  it('Enter on a mistyped key, then on the fixed key: the second Enter waits, and the result for the typo is dropped', async () => {
    const replies = [];
    const w = world({ claude: () => { const r = deferred(); replies.push(r); return r.promise; } });
    const panel = await openPanel(w);
    const box = panel.$('api-key');
    type(box, `${API_KEY}x`); // a typo
    pressEnter(box);
    await until(() => w.calls.length === 1);

    type(box, API_KEY); // you fix it and press Enter again, while the first Test still runs
    pressEnter(box);
    await settle();
    expect(w.calls).toHaveLength(1);

    replies[0].resolve(badKey()); // Anthropic refuses the typo
    await until(() => !panel.$('validate-btn').disabled);
    await settle();
    expect(hidden(panel.$('key-validation-status'))).toBe(true); // no "✗" next to the fixed key
    expect(await stored(w, 'userApiKey')).toBeUndefined();
    expect(badge(panel)).toBe('● Free Mode');

    pressEnter(box); // now Enter tests the fixed key
    await until(() => w.calls.length === 2);
    expect(keyUsed(w)).toBe(API_KEY);
    replies[1].resolve(claudeReply('OK'));
    await until(() => panel.$('key-validation-status').textContent === '✓ Key works. AI Mode is on.');
    expect(await stored(w, 'userApiKey')).toBe(API_KEY);
  });

  it.each([
    { why: 'it worked',            answer: () => claudeReply('OK') },
    { why: 'Anthropic refused it', answer: badKey },
  ])('a slow Test of a key you have changed since is dropped ($why): nothing is saved, no Test line, the status stays', async ({ answer }) => {
    const reply = deferred();
    const w = world({ local: { userApiKey: API_KEY, keyStatus: refused(TAIL) }, claude: () => reply.promise.then(answer) });
    const panel = await openPanel(w);
    expect(badge(panel)).toBe('Key not working');

    type(panel.$('api-key'), OTHER_KEY); // you paste key B and press Test: it runs slowly
    panel.$('validate-btn').click();
    await until(() => w.calls.length === 1);

    type(panel.$('api-key'), THIRD_KEY); // meanwhile you paste key C, and Save it
    expect(await save(panel)).toBe(SAVED_AI);
    expect(badge(panel)).toBe('● AI Mode');
    const statusBefore = await stored(w, 'keyStatus');

    reply.resolve(); // then the answer about B comes back
    await until(() => !panel.$('validate-btn').disabled);
    await settle();
    expect(panel.$('validate-btn').textContent).toBe('Test');
    expect(hidden(panel.$('key-validation-status'))).toBe(true); // nothing is said about B
    expect(await stored(w, 'userApiKey')).toBe(THIRD_KEY); // B is not saved over the key you chose
    expect(panel.$('api-key').value).toBe(THIRD_KEY);
    expect(await stored(w, 'keyStatus')).toEqual(statusBefore);
    expect(badge(panel)).toBe('● AI Mode');
  });

  it('Save with an empty box turns on Free Mode, and forgets the old key status', async () => {
    const w = world({ local: { userApiKey: API_KEY, keyStatus: refused(TAIL) } });
    const panel = await openPanel(w);
    expect(panel.$('api-key').value).toBe(API_KEY);
    expect(badge(panel)).toBe('Key not working');

    type(panel.$('api-key'), '');
    panel.$('save-settings-btn').click();
    await until(() => panel.$('settings-status').textContent === SAVED_FREE);
    await until(() => badge(panel) === '● Free Mode');
    expect(warning(panel)).toBeNull();
    expect(await stored(w, 'userApiKey')).toBeFalsy();
    expect(await stored(w, 'keyStatus')).toBeUndefined();
  });

  it('Save keeps the key exactly as typed (keys are case-sensitive), only trimmed', async () => {
    const mixed = 'sk-ant-test-AbCd-0000';
    const w = world();
    const panel = await openPanel(w);
    type(panel.$('api-key'), `  ${mixed}  `);
    panel.$('save-settings-btn').click();

    await until(() => panel.$('settings-status').textContent === SAVED_AI);
    expect(await stored(w, 'userApiKey')).toBe(mixed);
    await until(() => badge(panel) === '● AI Mode');

    // The next message is written with that exact key.
    panel.$('generate-btn').click();
    await until(() => panel.$('status-message').textContent === READY);
    expect(w.calls[0].headers['x-api-key']).toBe(mixed);
  });

  it('the key box shows your key as you typed it, not in capitals (keys are case-sensitive)', async () => {
    const panel = await openPanel(world());
    const css = panel.document.createElement('style');
    css.textContent = read('sidepanel.css'); // the panel's real stylesheet
    panel.document.head.appendChild(css);
    const box = panel.window.getComputedStyle(panel.$('api-key'));
    expect(box.paddingTop).toBe('9px'); // proof that the stylesheet applies to the box
    expect(['', 'none']).toContain(box.textTransform); // '' = no rule sets it (happy-dom); 'none' in Chrome
  });

  it.each(PROBLEMS)('Test fails on your saved key ($why): the header turns to "$label" too', async ({ answer, code, label, reason }) => {
    const w = world({ local: { userApiKey: API_KEY }, claude: answer });
    const panel = await openPanel(w);
    expect(badge(panel)).toBe('● AI Mode');
    expect(panel.$('api-key').value).toBe(API_KEY); // the box shows the saved key

    panel.$('validate-btn').click();
    await until(() => panel.$('key-validation-status').textContent === `✗ ${reason}`);
    await settle();
    expect(badge(panel)).toBe(label);
    expect(warning(panel)).toBe(reason);
    expect(await stored(w, 'keyStatus')).toMatchObject({ state: 'invalid', keyTail: TAIL, reason, code });
  });

  it('Test fails on a new key you have not saved: your saved key is left alone', async () => {
    const w = world({ local: { userApiKey: API_KEY }, claude: badKey });
    const panel = await openPanel(w);
    type(panel.$('api-key'), OTHER_KEY);
    panel.$('validate-btn').click();
    await until(() => panel.$('key-validation-status').textContent === `✗ ${REFUSED}`);
    await settle();

    expect(badge(panel)).toBe('● AI Mode');
    expect(await stored(w, 'keyStatus')).toBeUndefined();
    expect(await stored(w, 'userApiKey')).toBe(API_KEY);
  });

  it.each(PROBLEMS)('a new key fails Test ($why), then you Save it: the header says "$label", and Save says AI Mode is still not working', async ({ answer, code, label, reason }) => {
    const w = world({ local: { userApiKey: API_KEY }, claude: answer });
    const panel = await openPanel(w);
    type(panel.$('api-key'), OTHER_KEY);
    panel.$('validate-btn').click();
    await until(() => panel.$('key-validation-status').textContent === `✗ ${reason}`);
    await settle();
    expect(badge(panel)).toBe('● AI Mode'); // the new key is not saved yet

    panel.$('save-settings-btn').click(); // you save it anyway
    await until(() => panel.$('settings-status').textContent.startsWith('Settings saved'));
    expect(panel.$('settings-status').textContent).toBe(STILL_NOT_WORKING);
    expect(panel.$('settings-status').className).toBe('status-bar status-error');
    await settle();
    expect(badge(panel)).toBe(label);
    expect(warning(panel)).toBe(reason);
    expect(await stored(w, 'userApiKey')).toBe(OTHER_KEY);
    expect(await stored(w, 'keyStatus')).toEqual({ state: 'invalid', keyTail: OTHER_TAIL, reason, code, checkedAt: expect.any(Number) });
    expect(w.calls).toHaveLength(1); // Save sends nothing: it uses what Test found
  });

  it('a slow run with your old key cannot clear "Key not working" for the new key you saved since', async () => {
    const gate = deferred();
    const isTest = (body) => /Reply with the single word: OK/.test(promptText(body));
    const w = world({
      local: { userApiKey: API_KEY },
      claude: (body) => (isTest(body) ? badKey() : gate.promise.then(() => claudeReply(HELLO))),
    });
    const panel = await openPanel(w);
    panel.$('generate-btn').click(); // a run with your saved key starts, and takes a while
    await until(() => w.calls.length === 1);

    type(panel.$('api-key'), OTHER_KEY); // meanwhile, you paste a new key: Test fails, and you Save it
    panel.$('validate-btn').click();
    await until(() => panel.$('key-validation-status').textContent === `✗ ${REFUSED}`);
    panel.$('save-settings-btn').click();
    await until(() => panel.$('settings-status').textContent === STILL_NOT_WORKING);
    await settle();
    expect(badge(panel)).toBe('Key not working');

    gate.resolve(); // now the run with the old key ends well
    await until(() => panel.$('status-message').textContent === READY);
    await settle();
    expect(badge(panel)).toBe('Key not working');
    expect(await stored(w, 'keyStatus')).toMatchObject({ state: 'invalid', keyTail: OTHER_TAIL, reason: REFUSED });
  });

  it('a failed Test counts only for the key you tested: Save another key, and AI Mode is on', async () => {
    const w = world({ claude: badKey });
    const panel = await openPanel(w);
    type(panel.$('api-key'), OTHER_KEY);
    panel.$('validate-btn').click();
    await until(() => panel.$('key-validation-status').textContent === `✗ ${REFUSED}`);

    type(panel.$('api-key'), API_KEY); // you paste the right key, and Save with no Test
    panel.$('save-settings-btn').click();
    await until(() => panel.$('settings-status').textContent.startsWith('Settings saved'));
    expect(panel.$('settings-status').textContent).toBe(SAVED_AI);
    await settle();
    expect(badge(panel)).toBe('● AI Mode');
    expect(await stored(w, 'keyStatus')).toBeUndefined();
  });

  it.each([
    { why: 'Anthropic is busy',     answer: busy,    reason: 'Anthropic is busy right now. Please try again in a minute.' },
    { why: 'the request timed out', answer: tooSlow, reason: 'Claude took too long (over 30s). Please try again.' },
  ])('Test fails because $why: that says nothing about the key, so Save says AI Mode is on', async ({ answer, reason }) => {
    const w = world({ claude: answer });
    const panel = await openPanel(w);
    type(panel.$('api-key'), API_KEY);
    panel.$('validate-btn').click();
    await until(() => panel.$('key-validation-status').textContent === `✗ ${reason}`);

    panel.$('save-settings-btn').click();
    await until(() => panel.$('settings-status').textContent.startsWith('Settings saved'));
    expect(panel.$('settings-status').textContent).toBe(SAVED_AI);
    await settle();
    expect(badge(panel)).toBe('● AI Mode');
    expect(await stored(w, 'keyStatus')).toBeUndefined();
  });

  it('a Test that passes clears the failed one: Save then says AI Mode is on', async () => {
    let answer = noCredit;
    const w = world({ claude: (body) => answer(body) });
    const panel = await openPanel(w);
    type(panel.$('api-key'), API_KEY);
    panel.$('validate-btn').click();
    await until(() => panel.$('key-validation-status').textContent === `✗ ${NO_CREDIT}`);

    answer = () => claudeReply('OK'); // you add credit, then press Test again
    panel.$('validate-btn').click();
    await until(() => panel.$('key-validation-status').textContent === '✓ Key works. AI Mode is on.');

    panel.$('save-settings-btn').click();
    await until(() => panel.$('settings-status').textContent.startsWith('Settings saved'));
    expect(panel.$('settings-status').textContent).toBe(SAVED_AI);
    await settle();
    expect(badge(panel)).toBe('● AI Mode');
    expect(await stored(w, 'keyStatus')).toMatchObject({ state: 'ai', keyTail: TAIL });
  });

  it('Save while your key is not working says so, and hides the old Test line', async () => {
    const w = world({ local: { userApiKey: API_KEY, keyStatus: refused(TAIL) }, claude: badKey });
    const panel = await openPanel(w);
    panel.$('validate-btn').click();
    await until(() => panel.$('key-validation-status').textContent === `✗ ${REFUSED}`);
    expect(hidden(panel.$('key-validation-status'))).toBe(false);

    type(panel.$('user-bio'), 'MSc student in Dublin.'); // you change something else, then Save
    panel.$('save-settings-btn').click();
    await until(() => panel.$('settings-status').textContent.startsWith('Settings saved'));
    expect(panel.$('settings-status').textContent).toBe(STILL_NOT_WORKING);
    expect(panel.$('settings-status').className).toBe('status-bar status-error');
    expect(hidden(panel.$('key-validation-status'))).toBe(true);
    expect(badge(panel)).toBe('Key not working');
    expect(await stored(w, 'userBio')).toBe('MSc student in Dublin.');
  });

  it('Save also hides an old "✓ Key works" line, which may not be true any more', async () => {
    const w = world();
    const panel = await openPanel(w);
    type(panel.$('api-key'), API_KEY);
    panel.$('validate-btn').click();
    await until(() => panel.$('key-validation-status').textContent === '✓ Key works. AI Mode is on.');

    type(panel.$('api-key'), ''); // then you empty the box, for Free Mode
    panel.$('save-settings-btn').click();
    await until(() => panel.$('settings-status').textContent === SAVED_FREE);
    expect(hidden(panel.$('key-validation-status'))).toBe(true);
    await until(() => badge(panel) === '● Free Mode');
  });
});

// The panel remembers a failed Test (for a key problem), so that a Save of
// that same key does not say "AI Mode is on". It is used by one Save only,
// and it is forgotten as soon as that key works.
describe('a failed Test, remembered for Save', () => {
  it('is used by one Save only: after a message works with that key, the next Save says AI Mode is on', async () => {
    let answer = noCredit;
    const w = world({ local: { userApiKey: API_KEY }, claude: (body) => answer(body) });
    const panel = await openPanel(w);
    panel.$('validate-btn').click(); // you Test your saved key: no credit left
    await until(() => panel.$('key-validation-status').textContent === `✗ ${NO_CREDIT}`);
    expect(await save(panel)).toBe(STILL_NOT_WORKING); // Save: the header says so
    expect(badge(panel)).toBe('Billing problem');

    answer = () => claudeReply(HELLO); // you add credit, and a message works
    panel.$('generate-btn').click();
    await until(() => panel.$('status-message').textContent === READY);
    await until(() => badge(panel) === '● AI Mode');

    type(panel.$('user-bio'), 'MSc student in Dublin.'); // later you change your bio, and Save again
    expect(await save(panel)).toBe(SAVED_AI);
    expect(panel.$('settings-status').className).toBe('status-bar status-success');
    expect(badge(panel)).toBe('● AI Mode');
    expect(warning(panel)).toBeNull();
    expect(await stored(w, 'keyStatus')).toMatchObject({ state: 'ai', keyTail: TAIL });
    expect(await stored(w, 'userBio')).toBe('MSc student in Dublin.');
  });

  it('is forgotten when a message works with that key, even with no Save in between', async () => {
    let answer = noCredit;
    const w = world({ local: { userApiKey: API_KEY }, claude: (body) => answer(body) });
    const panel = await openPanel(w);
    panel.$('validate-btn').click(); // you Test your saved key: no credit left
    await until(() => panel.$('key-validation-status').textContent === `✗ ${NO_CREDIT}`);
    await until(() => badge(panel) === 'Billing problem');

    answer = () => claudeReply(HELLO); // you add credit, and a message works
    panel.$('generate-btn').click();
    await until(() => panel.$('status-message').textContent === READY);
    await until(() => badge(panel) === '● AI Mode');

    expect(await save(panel)).toBe(SAVED_AI); // then you Save
    expect(badge(panel)).toBe('● AI Mode');
    expect(await stored(w, 'keyStatus')).toMatchObject({ state: 'ai', keyTail: TAIL });
  });

  it('is forgotten when that key passes a Test in another window', async () => {
    let answer = noCredit;
    const w = world({ claude: (body) => answer(body) });
    const first = await openPanel(w); // the panel in one Chrome window
    type(first.$('api-key'), API_KEY); // you paste a key and Test it: no credit left
    first.$('validate-btn').click();
    await until(() => first.$('key-validation-status').textContent === `✗ ${NO_CREDIT}`);

    answer = () => claudeReply('OK'); // you add credit, then Test the same key in another window
    const second = await openPanel(w);
    type(second.$('api-key'), API_KEY);
    second.$('validate-btn').click();
    await until(() => second.$('key-validation-status').textContent === '✓ Key works. AI Mode is on.');
    await until(() => badge(first) === '● AI Mode');

    expect(await save(first)).toBe(SAVED_AI); // back in the first window, its box still holds that key
    expect(badge(first)).toBe('● AI Mode');
    expect(badge(second)).toBe('● AI Mode');
    expect(await stored(w, 'keyStatus')).toMatchObject({ state: 'ai', keyTail: TAIL });
  });

  it('is not used again by a later Save: after Free Mode and back, Save does not bring the old reason back', async () => {
    const w = world({ local: { userApiKey: API_KEY }, claude: noCredit });
    const panel = await openPanel(w);
    panel.$('validate-btn').click(); // Test fails: no credit left
    await until(() => panel.$('key-validation-status').textContent === `✗ ${NO_CREDIT}`);
    expect(await save(panel)).toBe(STILL_NOT_WORKING); // Save uses it once

    type(panel.$('api-key'), ''); // Free Mode forgets what was known about the key
    expect(await save(panel)).toBe(SAVED_FREE);
    expect(await stored(w, 'keyStatus')).toBeUndefined();

    type(panel.$('api-key'), API_KEY); // later you paste the key back, and Save with no Test
    expect(await save(panel)).toBe(SAVED_AI);
    expect(badge(panel)).toBe('● AI Mode');
    expect(await stored(w, 'keyStatus')).toBeUndefined(); // nothing is known about it now
    expect(w.calls).toHaveLength(1); // only the first Test was sent
  });
});

describe('your resume in Settings', () => {
  it('"Use my resume in AI Mode" is off by default', async () => {
    const panel = await openPanel(world());
    expect(panel.document.querySelector('label[for="resume-upload"]').textContent).toBe('Your Resume (PDF, optional)');
    expect(panel.$('resume-for-ai').checked).toBe(false);
    expect(hidden(panel.$('remove-resume-btn'))).toBe(true); // nothing to remove yet
  });

  it('a resume kept from 3.1.0 is not sent until you tick the box. Ticking saves at once: no Save needed.', async () => {
    const w = world({ local: { userApiKey: API_KEY, ...OLD_RESUME } });
    const panel = await openPanel(w);
    expect(panel.$('resume-status').textContent).toBe('my-resume.pdf saved ✓');
    expect(panel.$('resume-for-ai').checked).toBe(false);

    panel.$('generate-btn').click();
    await until(() => panel.$('status-message').textContent === READY);
    expect(blocks(w.calls[0])).toEqual(['text']);

    panel.$('resume-for-ai').click(); // tick it, and do not press Save
    await until(() => panel.$('settings-status').textContent === 'Saved: AI Mode will send your resume with each message.');
    expect(panel.$('settings-status').className).toBe('status-bar status-success');
    expect(await stored(w, 'resumeForAI')).toBe(true);

    panel.$('regenerate-btn').click();
    await until(async () => w.calls.length === 2 && (await w.job('/in/aoife/')).step === 'done');
    await settle();

    expect(blocks(w.calls[1])).toEqual(['document', 'text']);
    expect(w.calls[1].body.messages[0].content[0]).toMatchObject({
      title: 'My resume (the sender)', source: { type: 'base64', media_type: 'application/pdf', data: OLD_RESUME.resumeBase64 },
    });
    // No note about the resume: Anthropic could read it.
    expect(panel.$('status-message').textContent).toBe(READY);
  });

  it('unticking the box stops the resume at once: no Save needed', async () => {
    const w = world({ local: { userApiKey: API_KEY, ...OLD_RESUME, resumeForAI: true } });
    const panel = await openPanel(w);
    expect(panel.$('resume-for-ai').checked).toBe(true);
    panel.$('generate-btn').click();
    await until(() => panel.$('status-message').textContent === READY);
    expect(blocks(w.calls[0])).toEqual(['document', 'text']); // sent with the resume, as you chose

    panel.$('resume-for-ai').click(); // untick it, then go back and write (no Save)
    await until(() => panel.$('settings-status').textContent === 'Saved: your resume will not be sent.');
    expect(panel.$('settings-status').className).toBe('status-bar status-success');
    expect(await resumeKeys(w)).toEqual({ ...OLD_RESUME, resumeForAI: false }); // the file itself is kept

    panel.$('generate-btn').click();
    await until(async () => w.calls.length === 2 && (await w.job('/in/aoife/')).step === 'done');
    expect(blocks(w.calls[1])).toEqual(['text']);
  });

  it('with no resume, ticking the box stores nothing and says to upload one. It stays ticked, so Save stores it with the file.', async () => {
    const w = world();
    const panel = await openPanel(w);
    panel.$('resume-for-ai').click(); // ticked, but there is no resume yet
    await until(() => panel.$('settings-status').textContent === 'Upload your resume, then press Save Settings.');
    expect(await resumeKeys(w)).toEqual({});
    expect(panel.$('resume-for-ai').checked).toBe(true);

    expect(await save(panel)).toBe(SAVED_FREE); // Save with no file:
    expect(await resumeKeys(w)).toEqual({}); // nothing about a resume is stored
    expect(panel.$('resume-for-ai').checked).toBe(true);

    await upload(panel, 'my-resume.pdf'); // now a PDF, and Save again: the box's choice goes with it
    panel.$('save-settings-btn').click();
    await until(async () => (await stored(w, 'resumeFileName')) === 'my-resume.pdf');
    expect(await resumeKeys(w)).toEqual({ resumeBase64: PDF_A.base64, resumeFileName: 'my-resume.pdf', resumeForAI: true });
    expect(panel.$('resume-status').textContent).toBe('Resume saved ✓');
    expect(hidden(panel.$('remove-resume-btn'))).toBe(false);
  });

  it('a PDF picked but not saved yet: ticking the box names it and says to press Save. It stores nothing; Save stores both.', async () => {
    const w = world();
    const panel = await openPanel(w);
    await upload(panel, 'my-resume.pdf');
    const writes = watchWrites(w);
    panel.$('resume-for-ai').click();
    await until(() => panel.$('settings-status').textContent === 'Press Save Settings to save my-resume.pdf with this choice.');
    expect(writes).toEqual([]); // nothing is saved before Save
    expect(panel.$('resume-for-ai').checked).toBe(true);

    panel.$('save-settings-btn').click();
    await until(async () => (await stored(w, 'resumeFileName')) === 'my-resume.pdf');
    expect(await resumeKeys(w)).toEqual({ resumeBase64: PDF_A.base64, resumeFileName: 'my-resume.pdf', resumeForAI: true });
  });

  it('a saved resume, and a new PDF picked but not saved: ticking stores nothing, names the new file, and the old file is not sent', async () => {
    const w = world({ local: { userApiKey: API_KEY, ...OLD_RESUME } }); // kept from 3.1.0: not sent
    const panel = await openPanel(w);
    await upload(panel, 'new-resume.pdf', PDF_B);
    const writes = watchWrites(w);
    panel.$('resume-for-ai').click(); // tick it, with no Save
    await until(() => panel.$('settings-status').textContent === 'Press Save Settings to save new-resume.pdf with this choice.');
    expect(panel.$('resume-for-ai').checked).toBe(true);
    expect(writes).toEqual([]); // nothing stored: still the old file, still not sent
    expect(await resumeKeys(w)).toEqual(OLD_RESUME);

    panel.$('generate-btn').click(); // you write before you Save
    await until(() => panel.$('status-message').textContent === READY);
    expect(blocks(w.calls[0])).toEqual(['text']); // the old file is not sent

    panel.$('save-settings-btn').click(); // Save stores the new file, with the box's choice
    await until(async () => (await stored(w, 'resumeFileName')) === 'new-resume.pdf');
    expect(await resumeKeys(w)).toEqual({ resumeBase64: PDF_B.base64, resumeFileName: 'new-resume.pdf', resumeForAI: true });

    panel.$('regenerate-btn').click(); // now the new file is sent
    await until(async () => w.calls.length === 2 && (await w.job('/in/aoife/')).step === 'done');
    expect(blocks(w.calls[1])).toEqual(['document', 'text']);
    expect(w.calls[1].body.messages[0].content[0].source.data).toBe(PDF_B.base64);
  });

  it('a saved resume that is sent, and a new PDF picked but not saved: unticking stops the saved one at once, and the message names the new file', async () => {
    const w = world({ local: { userApiKey: API_KEY, ...OLD_RESUME, resumeForAI: true } });
    const panel = await openPanel(w);
    await upload(panel, 'new-resume.pdf', PDF_B);
    panel.$('resume-for-ai').click(); // untick: "do not send my resume", with no Save
    await until(() => panel.$('settings-status').textContent ===
      'Saved: your resume will not be sent. Press Save Settings to keep new-resume.pdf.');
    expect(panel.$('settings-status').className).toBe('status-bar status-success');
    // Stored at once. The saved file stays until Save, and the new one still waits for Save.
    expect(await resumeKeys(w)).toEqual({ ...OLD_RESUME, resumeForAI: false });
    expect(panel.$('file-label').textContent).toBe('new-resume.pdf');

    panel.$('generate-btn').click(); // you write before you press Save
    await until(() => panel.$('status-message').textContent === READY);
    expect(blocks(w.calls[0])).toEqual(['text']); // no resume goes with it

    panel.$('save-settings-btn').click(); // Save keeps the new file, with the box's choice: off
    await until(async () => (await stored(w, 'resumeFileName')) === 'new-resume.pdf');
    expect(await resumeKeys(w)).toEqual({ resumeBase64: PDF_B.base64, resumeFileName: 'new-resume.pdf', resumeForAI: false });
  });

  it('with no resume at all, unticking the box says nothing and stores nothing', async () => {
    const w = world();
    const panel = await openPanel(w);
    panel.$('resume-for-ai').click(); // ticked by mistake: there is no resume
    await until(() => panel.$('settings-status').textContent === 'Upload your resume, then press Save Settings.');
    panel.$('settings-status').textContent = ''; // cleared, so any new message would show here

    const writes = watchWrites(w);
    panel.$('resume-for-ai').click(); // untick it again
    await settle();
    expect(panel.$('resume-for-ai').checked).toBe(false);
    expect(panel.$('settings-status').textContent).toBe('');
    expect(writes).toEqual([]);
  });

  it('Remove resume deletes it and unticks the box, so AI Mode stops sending it', async () => {
    const w = world({ local: { userApiKey: API_KEY, ...OLD_RESUME, resumeForAI: true } });
    const panel = await openPanel(w);
    expect(panel.$('resume-for-ai').checked).toBe(true);
    expect(hidden(panel.$('remove-resume-btn'))).toBe(false);

    panel.$('remove-resume-btn').click();
    await until(() => panel.$('settings-status').textContent === 'Resume removed.');
    expect(await resumeKeys(w)).toEqual({});
    expect(panel.$('resume-for-ai').checked).toBe(false);
    expect(panel.$('file-label').textContent).toBe('Click to upload or drag PDF here');
    expect(hidden(panel.$('resume-status'))).toBe(true);
    expect(hidden(panel.$('remove-resume-btn'))).toBe(true);

    panel.$('generate-btn').click();
    await until(() => panel.$('status-message').textContent === READY);
    expect(blocks(w.calls[0])).toEqual(['text']);
  });

  it('after Remove resume, the same PDF can be picked again: the file box is emptied', async () => {
    const w = world();
    const panel = await openPanel(w);
    await upload(panel, 'my-resume.pdf');
    expect(panel.$('resume-upload').value).toBe(''); // emptied after each pick
    panel.$('save-settings-btn').click();
    await until(async () => (await stored(w, 'resumeFileName')) === 'my-resume.pdf');

    panel.$('remove-resume-btn').click(); // say, by mistake
    await until(() => panel.$('settings-status').textContent === 'Resume removed.');
    expect(panel.$('resume-upload').value).toBe('');
    expect(await resumeKeys(w)).toEqual({});

    await upload(panel, 'my-resume.pdf'); // the same file again
    expect(panel.$('file-label').textContent).toBe('my-resume.pdf');
    panel.$('save-settings-btn').click();
    await until(async () => (await stored(w, 'resumeFileName')) === 'my-resume.pdf');
    expect(panel.$('resume-status').textContent).toBe('Resume saved ✓');
  });

  it('Remove also drops a new PDF you picked but did not save yet', async () => {
    const w = world({ local: { ...OLD_RESUME, resumeForAI: true } });
    const panel = await openPanel(w);
    await upload(panel, 'new-resume.pdf', PDF_B);

    panel.$('remove-resume-btn').click();
    await until(() => panel.$('settings-status').textContent === 'Resume removed.');
    expect(await save(panel)).toBe(SAVED_FREE);
    expect(await resumeKeys(w)).toEqual({}); // no file, and no choice for one
  });

  it('if Anthropic cannot read the PDF, the message is written without it, and the panel says so', async () => {
    const pdfRefused = (body) => (body.messages[0].content.some((b) => b.type === 'document')
      ? [400, { type: 'error', error: { type: 'invalid_request_error', message: 'The PDF specified was not valid.' } }]
      : claudeReply(HELLO));
    const w = world({ local: { userApiKey: API_KEY, ...OLD_RESUME, resumeForAI: true }, claude: pdfRefused });
    const panel = await openPanel(w);
    panel.$('generate-btn').click();

    await until(() => panel.$('generated-message').value === HELLO);
    expect(panel.$('status-message').textContent).toBe('Message ready. Written by Claude. ' +
      'Anthropic could not read your resume PDF, so it was left out. Replace or remove it in Settings.');
    expect(w.calls.map(blocks)).toEqual([['document', 'text'], ['text']]); // with the resume, then without
  });

  it('too slow with your resume attached: the panel says the resume makes it slower, and names the box to untick', async () => {
    const w = world({ local: { userApiKey: API_KEY, ...OLD_RESUME, resumeForAI: true }, claude: tooSlow });
    const panel = await openPanel(w);
    panel.$('generate-btn').click();

    await until(() => panel.$('status-message').classList.contains('status-error'));
    expect(panel.$('status-message').textContent).toBe('Claude took too long (over 60s). Your resume is sent with each message, ' +
      'which makes it slower: try again, or untick "Use my resume in AI Mode" in Settings.');
    // The box it names is there, with that name.
    expect(panel.document.querySelector('label[for="resume-for-ai"]').textContent.trim()).toMatch(/^Use my resume in AI Mode\. /);
    expect(w.calls.map(blocks)).toEqual([['document', 'text']]); // not tried again
    expect(badge(panel)).toBe('● AI Mode'); // a slow request says nothing about your key
  });
});

// Two panels open at once, one in each Chrome window. What you save in one
// shows up in the other, so a Save there does not put the old values back.
// A box you are typing in keeps what you typed.
describe('two panels open at once (one in each Chrome window)', () => {
  // A new copy for each test: the fake storage keeps the object it is given
  // and writes into it, so a shared object would carry one test's Save into the next.
  const me = () => ({ userApiKey: API_KEY, userName: 'Rahul', userBio: 'MSc student in Dublin.' });

  it('you save a new key, name and bio in one panel: the other panel shows them, and a Save there keeps them', async () => {
    const w = world({ local: me() });
    const first  = await openPanel(w);
    const second = await openPanel(w);
    type(first.$('api-key'), OTHER_KEY);
    type(first.$('user-name'), 'Rahul Sharma');
    type(first.$('user-bio'), 'MSc Data Analytics student at UCD.');
    expect(await save(first)).toBe(SAVED_AI);

    // Nothing was typed in these boxes in the second panel, so they follow.
    expect(second.$('api-key').value).toBe(OTHER_KEY);
    expect(second.$('user-name').value).toBe('Rahul Sharma');
    expect(second.$('user-bio').value).toBe('MSc Data Analytics student at UCD.');

    expect(await save(second)).toBe(SAVED_AI); // later you press Save in the second panel
    expect(await myDetails(w)).toEqual({ userApiKey: OTHER_KEY, userName: 'Rahul Sharma', userBio: 'MSc Data Analytics student at UCD.' });
  });

  it('a box you are typing in, in the other panel, keeps what you typed. The boxes you did not touch there follow.', async () => {
    const w = world({ local: me() });
    const first  = await openPanel(w);
    const second = await openPanel(w);
    type(second.$('api-key'), THIRD_KEY); // in the second panel you type a new key and bio, not saved yet
    type(second.$('user-bio'), 'Graduate looking for data roles in Dublin.');

    type(first.$('api-key'), OTHER_KEY); // meanwhile the first panel saves a new key, name and bio
    type(first.$('user-name'), 'Rahul Sharma');
    type(first.$('user-bio'), 'MSc Data Analytics student at UCD.');
    expect(await save(first)).toBe(SAVED_AI);

    expect(second.$('api-key').value).toBe(THIRD_KEY); // what you typed stays
    expect(second.$('user-bio').value).toBe('Graduate looking for data roles in Dublin.');
    expect(second.$('user-name').value).toBe('Rahul Sharma'); // the box you did not touch follows

    expect(await save(second)).toBe(SAVED_AI); // Save there saves what you typed, and keeps the new name
    expect(await myDetails(w)).toEqual({ userApiKey: THIRD_KEY, userName: 'Rahul Sharma', userBio: 'Graduate looking for data roles in Dublin.' });
  });

  it("you empty the key in one panel, for Free Mode: the other panel's key box empties too, so its Save does not turn AI Mode back on", async () => {
    const w = world({ local: { userApiKey: API_KEY } });
    const first  = await openPanel(w);
    const second = await openPanel(w);
    type(second.$('api-key'), ''); // in the second panel you empty the key, to stop AI Mode
    expect(await save(second)).toBe(SAVED_FREE);
    await until(() => badge(first) === '● Free Mode');
    expect(first.$('api-key').value).toBe('');

    type(first.$('user-bio'), 'MSc student in Dublin.'); // later, in the first panel, you change your bio and Save
    expect(await save(first)).toBe(SAVED_FREE);
    expect(await myDetails(w)).toEqual({ userApiKey: '', userName: '', userBio: 'MSc student in Dublin.' });

    first.$('generate-btn').click(); // so messages are still written on this device
    await until(() => first.$('status-message').textContent === 'Message ready. Written in Free Mode.');
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('untick the resume box in one panel, then Save in the other: the resume stays off, and both boxes show it', async () => {
    const w = world({ local: { userApiKey: API_KEY, ...OLD_RESUME, resumeForAI: true } });
    const first  = await openPanel(w);
    const second = await openPanel(w);
    expect(first.$('resume-for-ai').checked).toBe(true);
    expect(second.$('resume-for-ai').checked).toBe(true);

    second.$('resume-for-ai').click(); // untick it in the second panel
    await until(() => second.$('settings-status').textContent === 'Saved: your resume will not be sent.');
    expect(await stored(w, 'resumeForAI')).toBe(false);
    expect(first.$('resume-for-ai').checked).toBe(false); // the first panel's box follows

    type(first.$('user-bio'), 'MSc student in Dublin.'); // later you Save in the first panel
    expect(await save(first)).toBe(SAVED_AI);
    expect(await resumeKeys(w)).toEqual({ ...OLD_RESUME, resumeForAI: false });
    expect(await stored(w, 'userBio')).toBe('MSc student in Dublin.');
    expect(first.$('resume-for-ai').checked).toBe(false);

    first.$('generate-btn').click();
    await until(() => first.$('status-message').textContent === READY);
    expect(blocks(w.calls[0])).toEqual(['text']); // the resume is not sent
  });

  it('a new resume saved in one panel shows in the other as saved, with its Remove button. The saving panel keeps "Resume saved ✓".', async () => {
    const w = world({ local: { userApiKey: API_KEY } });
    const first  = await openPanel(w);
    const second = await openPanel(w);
    await upload(first, 'my-resume.pdf');
    first.$('resume-for-ai').click(); // ticked, for the new file
    await until(() => first.$('settings-status').textContent === 'Press Save Settings to save my-resume.pdf with this choice.');
    expect(await save(first)).toBe(SAVED_AI);
    expect(first.$('resume-status').textContent).toBe('Resume saved ✓'); // its own words stay

    expect(second.$('file-label').textContent).toBe('my-resume.pdf');
    expect(second.$('file-upload-area').classList.contains('has-file')).toBe(true);
    expect(second.$('resume-status').textContent).toBe('my-resume.pdf saved ✓');
    expect(second.$('resume-status').className).toBe('resume-status success');
    expect(hidden(second.$('remove-resume-btn'))).toBe(false);
    expect(second.$('resume-for-ai').checked).toBe(true);

    expect(await save(second)).toBe(SAVED_AI); // a Save in the other panel keeps the new resume, still ticked
    expect(await resumeKeys(w)).toEqual({ resumeBase64: PDF_A.base64, resumeFileName: 'my-resume.pdf', resumeForAI: true });
  });

  it('Remove resume in one panel: the other shows no file, hides its Remove button and unticks its box. The first keeps "Resume removed."', async () => {
    const w = world({ local: { userApiKey: API_KEY, ...OLD_RESUME, resumeForAI: true } });
    const first  = await openPanel(w);
    const second = await openPanel(w);
    expect(second.$('resume-status').textContent).toBe('my-resume.pdf saved ✓');

    first.$('remove-resume-btn').click();
    await until(() => first.$('settings-status').textContent === 'Resume removed.');
    await settle();
    expect(first.$('settings-status').textContent).toBe('Resume removed.'); // its own words stay

    expect(second.$('file-label').textContent).toBe('Click to upload or drag PDF here');
    expect(second.$('file-upload-area').classList.contains('has-file')).toBe(false);
    expect(hidden(second.$('resume-status'))).toBe(true);
    expect(hidden(second.$('remove-resume-btn'))).toBe(true);
    expect(second.$('resume-for-ai').checked).toBe(false);

    expect(await save(second)).toBe(SAVED_AI); // a Save in the other panel does not bring it back
    expect(await resumeKeys(w)).toEqual({});
  });

  it('a PDF you picked in the other panel, not saved yet, stays picked when one panel saves another resume', async () => {
    const w = world({ local: { userApiKey: API_KEY } });
    const first  = await openPanel(w);
    const second = await openPanel(w);
    await upload(second, 'new-resume.pdf', PDF_B); // picked in the second panel, not saved yet

    await upload(first, 'my-resume.pdf'); // the first panel saves another file
    expect(await save(first)).toBe(SAVED_AI);
    expect(second.$('file-label').textContent).toBe('new-resume.pdf');
    expect(second.$('resume-status').textContent).toBe('new-resume.pdf ready — click Save Settings to confirm.');

    expect(await save(second)).toBe(SAVED_AI); // Save there stores the file it shows
    expect(await stored(w, 'resumeFileName')).toBe('new-resume.pdf');
    expect(await stored(w, 'resumeBase64')).toBe(PDF_B.base64);
    expect(first.$('file-label').textContent).toBe('new-resume.pdf'); // and now the first panel shows that one
    expect(first.$('resume-status').textContent).toBe('new-resume.pdf saved ✓');
  });
});

describe('the privacy note in Settings', () => {
  it('says what stays on this device, then lists the 4 things AI Mode sends to Anthropic', async () => {
    const panel = await openPanel(world());
    const note  = panel.document.querySelector('.settings-note');
    const intro = note.firstChild.textContent.replace(/\s+/g, ' ').trim(); // the text before the list
    expect(intro).toBe('Everything is saved only on this device. In Free Mode, nothing leaves it. ' +
      'In AI Mode, these go to Anthropic with your key, for each message:');
    const items = [...note.querySelectorAll('ul.settings-note-list > li')].map((li) => li.textContent.trim());
    expect(items).toEqual([
      'the profile you are viewing',
      'your name, bio and goal',
      'what you have in common (from your own profile)',
      'your resume, if you turned that on',
    ]);
  });

  it('the list is left-aligned inside the centred note', async () => {
    const panel = await openPanel(world());
    const css = panel.document.createElement('style');
    css.textContent = read('sidepanel.css'); // the panel's real stylesheet
    panel.document.head.appendChild(css);
    const note = panel.document.querySelector('.settings-note');
    expect(panel.window.getComputedStyle(note).textAlign).toBe('center');
    expect(panel.window.getComputedStyle(note.querySelector('.settings-note-list')).textAlign).toBe('left');
  });
});

describe('writing a message', () => {
  it('with no key, Generate works in Free Mode, with no network', async () => {
    const w = world();
    const panel = await openPanel(w);
    panel.$('generate-btn').click();

    await until(() => panel.$('status-message').textContent === 'Message ready. Written in Free Mode.');
    expect(panel.$('generated-message').value).toMatch(/^Hi Aoife, .+\?$/);
    expect(w.fetch).not.toHaveBeenCalled();
    expect(await stored(w, 'keyStatus')).toBeUndefined(); // Free Mode says nothing about a key
  });

  it('with a key, Claude writes it', async () => {
    const w = world({ local: { userApiKey: API_KEY } });
    const panel = await openPanel(w);
    panel.$('generate-btn').click();

    await until(() => panel.$('status-message').textContent === READY);
    expect(panel.$('generated-message').value).toBe('Hi Aoife! Would you be open to a quick chat?');
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({ path: '/v1/messages', headers: { 'x-api-key': API_KEY } });
  });
});
