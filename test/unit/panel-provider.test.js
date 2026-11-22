// Settings: the AI provider (Anthropic, Google's Gemini, OpenAI) and its
// key, in the REAL side panel talking to the REAL background.
//   - Picking a company applies at once; each company keeps its own key.
//   - The key is hidden like a password, with Show / Hide.
//   - Google and OpenAI need your OK in Chrome first (optional host access):
//     Test and Save ask for it, straight from your click, as Chrome requires.
//     Allowed already: no prompt at all.
//   - A key that is another company's is never sent, and the header says so.
// The Anthropic key box as it always was is tested in panel-key-status.
import { describe, it, expect } from 'vitest';
import {
  createWorld, openPanel, person, until, settle, type, fire, deferred, API_KEY, GEMINI_KEY, OPENAI_KEY,
  GEMINI_ORIGIN, OPENAI_ORIGIN, INSTALL_HOSTS, geminiReply,
} from '../helpers/world.js';

const AOIFE = person('aoife', 'Aoife');

const NO_GOOGLE_YET = 'Chrome has not allowed the extension to reach Google (generativelanguage.googleapis.com) yet. ' +
  'Press Test in Settings and choose Allow, or remove the key to use Free Mode.';
const NO_OPENAI_YET = 'Chrome has not allowed the extension to reach OpenAI (api.openai.com) yet. ' +
  'Press Test in Settings and choose Allow, or remove the key to use Free Mode.';
const OPENAI_KEY_FOR_GEMINI = 'This looks like an OpenAI API key, but the AI provider in Settings is Google (Gemini). ' +
  'Pick OpenAI (GPT) there, or paste a Gemini API key.';

function world({ local = {}, granted = INSTALL_HOSTS, ...fakes } = {}) {
  return createWorld({ local, granted, tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }], pages: { 1: AOIFE }, ...fakes });
}

const badge   = (panel) => panel.$('key-status').textContent;
const hidden  = (el) => el.classList.contains('hidden');
const warning = (panel) => (hidden(panel.$('no-key-warning')) ? null : panel.$('key-warning-text').textContent);
const stored  = async (w, name) => (await w.chrome.storage.local.get(name))[name];
const testResult = (panel) => panel.$('key-validation-status').textContent;

/** Pick a company in Settings' list, the way a user does. It is saved at once. */
async function pick(panel, w, id) {
  const list = panel.$('ai-provider');
  list.value = id;
  fire(list, 'change');
  await until(async () => (await stored(w, 'aiProvider')) === id);
  await settle();
}

/** Press Test, and wait for its result line. */
async function pressTest(panel) {
  const line = panel.$('key-validation-status');
  line.textContent = '';
  panel.$('validate-btn').click();
  await until(() => line.textContent !== '' && !panel.$('validate-btn').disabled);
  await settle();
  return line.textContent;
}

/** Press Save Settings, and return what it says. */
async function save(panel) {
  const bar = panel.$('settings-status');
  bar.textContent = '';
  panel.$('save-settings-btn').click();
  await until(() => bar.textContent.startsWith('Settings saved'));
  await settle();
  return bar.textContent;
}

/** You change the extension's site access in chrome://extensions (Chrome tells the extension). */
function allowInChrome(w, origin) {
  w.chrome.permissions.granted.add(origin);
  w.chrome.permissions.onAdded.fns.forEach((fn) => fn({ origins: [origin], permissions: [] }));
}

describe('the AI provider list', () => {
  it('lists the three companies, with Anthropic picked when nothing was chosen yet (as before there was a choice)', async () => {
    const panel = await openPanel(world());
    const list = panel.$('ai-provider');
    expect([...list.options].map((o) => [o.value, o.textContent])).toEqual([
      ['anthropic', 'Anthropic (Claude)'],
      ['gemini', 'Google (Gemini)'],
      ['openai', 'OpenAI (GPT)'],
    ]);
    expect(list.value).toBe('anthropic');
    expect(panel.$('api-key-label').textContent).toBe('Anthropic API key (optional)');
    expect(panel.$('api-key').placeholder).toBe('sk-ant-…');
    expect(panel.$('key-hint').textContent).toBe('Get a key at console.anthropic.com. It is kept only on this device, hidden like a password, and sent only to Anthropic.');
  });

  it('picking Google (Gemini) applies at once: Free Mode until it has a key, and your Anthropic key is kept for later', async () => {
    const w = world({ local: { userApiKey: API_KEY } });
    const panel = await openPanel(w);
    expect(badge(panel)).toBe('● AI Mode');
    expect(panel.$('api-key').value).toBe(API_KEY);

    await pick(panel, w, 'gemini');
    expect(badge(panel)).toBe('● Free Mode');
    expect(panel.$('api-key').value).toBe('');
    expect(panel.$('api-key-label').textContent).toBe('Gemini API key (optional)');
    expect(panel.$('api-key').placeholder).toBe('AIza…');
    expect(panel.$('key-hint').textContent).toBe('Get a key at aistudio.google.com. It is kept only on this device, hidden like a password, and sent only to Google. ' +
      'The first time you press Test or Save, Chrome asks you to let the extension reach generativelanguage.googleapis.com.');
    // The words about what is sent, and to whom, follow the company.
    expect(panel.$('resume-for-ai').parentElement.textContent.trim()).toBe('Use my resume in AI Mode. It is sent to Google with each message, so Gemini can say what you can offer.');
    expect(panel.document.querySelector('.settings-note-intro').textContent.replace(/\s+/g, ' ').trim())
      .toBe('Everything is saved only on this device. In Free Mode, nothing leaves it. In AI Mode, these go to Google with your key, for each message:');
    expect(await stored(w, 'userApiKey')).toBe(API_KEY);

    // Back to Anthropic: its key is still there, and AI Mode with it.
    await pick(panel, w, 'anthropic');
    expect(panel.$('api-key').value).toBe(API_KEY);
    expect(badge(panel)).toBe('● AI Mode');
    expect(w.fetch).not.toHaveBeenCalled(); // picking sends nothing
  });

  it('what you typed for one company, and did not save, is still there when you come back to it', async () => {
    const w = world();
    const panel = await openPanel(w);
    await pick(panel, w, 'gemini');
    type(panel.$('api-key'), GEMINI_KEY);
    await pick(panel, w, 'openai');
    expect(panel.$('api-key').value).toBe('');
    await pick(panel, w, 'gemini');
    expect(panel.$('api-key').value).toBe(GEMINI_KEY);
    expect(await stored(w, 'geminiApiKey')).toBeUndefined(); // still not saved
  });

  it('two panels (one in each window): a company picked in one is shown in the other', async () => {
    const w = world({ local: { openaiApiKey: OPENAI_KEY }, granted: [...INSTALL_HOSTS, OPENAI_ORIGIN] });
    const first = await openPanel(w);
    const second = await openPanel(w);
    await pick(first, w, 'openai');
    await until(() => second.$('ai-provider').value === 'openai');
    expect(second.$('api-key').value).toBe(OPENAI_KEY);
    expect(second.$('api-key-label').textContent).toBe('OpenAI API key (optional)');
    expect(badge(second)).toBe('● AI Mode');
    first.close();
    second.close();
  });
});

describe('the key is hidden like a password', () => {
  it('Show shows it, Hide hides it again; so do Save and picking another company', async () => {
    const w = world();
    const panel = await openPanel(w);
    const box = panel.$('api-key');
    const show = panel.$('show-key-btn');
    expect([box.type, show.textContent, show.getAttribute('aria-pressed')]).toEqual(['password', 'Show', 'false']);

    show.click();
    expect([box.type, show.textContent, show.getAttribute('aria-pressed'), show.getAttribute('aria-label')]).toEqual(['text', 'Hide', 'true', 'Hide the key']);
    show.click();
    expect([box.type, show.textContent, show.getAttribute('aria-pressed')]).toEqual(['password', 'Show', 'false']);

    show.click();
    await pick(panel, w, 'gemini');
    expect(box.type).toBe('password');

    show.click();
    await save(panel);
    expect(box.type).toBe('password');
  });
});

describe('Google and OpenAI: Chrome asks once, from your click', () => {
  it('Test with Gemini: Chrome asks first, then one tiny request goes to Google, and the key is saved for Gemini', async () => {
    const w = world();
    const panel = await openPanel(w);
    await pick(panel, w, 'gemini');
    type(panel.$('api-key'), GEMINI_KEY);

    expect(await pressTest(panel)).toBe('✓ Key works. AI Mode is on.');
    expect(w.chrome.permissions.prompts).toEqual([[GEMINI_ORIGIN]]);
    expect(w.calls.map((c) => c.api)).toEqual(['gemini']);
    expect(await stored(w, 'geminiApiKey')).toBe(GEMINI_KEY);
    expect(await stored(w, 'userApiKey')).toBeUndefined();
    expect(await stored(w, 'keyStatus')).toEqual({ state: 'ai', keyTail: GEMINI_KEY.slice(-8), provider: 'gemini', checkedAt: expect.any(Number) });
    expect(badge(panel)).toBe('● AI Mode');
    expect(panel.$('key-status').title).toBe('Gemini writes the messages, with your own Google key.');

    // Allowed once is allowed: the next Test asks nothing.
    await pressTest(panel);
    expect(w.chrome.permissions.prompts).toHaveLength(1);
    expect(w.calls).toHaveLength(2);
  });

  it('Enter in the key box works the same (a key press counts as your action too)', async () => {
    const w = world();
    const panel = await openPanel(w);
    await pick(panel, w, 'openai');
    type(panel.$('api-key'), OPENAI_KEY);
    const box = panel.$('api-key');
    box.dispatchEvent(new panel.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => testResult(panel) === '✓ Key works. AI Mode is on.');
    expect(w.chrome.permissions.prompts).toEqual([[OPENAI_ORIGIN]]);
    expect(await stored(w, 'openaiApiKey')).toBe(OPENAI_KEY);
  });

  it('while Chrome\'s prompt is open, nothing is sent yet', async () => {
    const w = world();
    const answer = deferred();
    w.chrome.permissions.answer = () => answer.promise;
    const panel = await openPanel(w);
    await pick(panel, w, 'openai');
    type(panel.$('api-key'), OPENAI_KEY);

    panel.$('validate-btn').click();
    await settle();
    expect(panel.$('validate-btn').disabled).toBe(true);
    expect(panel.$('validate-btn').textContent).toBe('…');
    expect(w.fetch).not.toHaveBeenCalled();

    answer.resolve('allow');
    await until(() => testResult(panel) === '✓ Key works. AI Mode is on.');
    expect(w.calls.map((c) => c.api)).toEqual(['openai']);
  });

  it('Test, and you click Deny: nothing is sent, the key is not saved, and it says how to fix it', async () => {
    const w = world();
    w.chrome.permissions.answer = 'deny';
    const panel = await openPanel(w);
    await pick(panel, w, 'openai');
    type(panel.$('api-key'), OPENAI_KEY);

    expect(await pressTest(panel)).toBe('✗ Chrome did not allow the extension to reach OpenAI (api.openai.com). Press Test again and choose Allow, or pick another AI provider.');
    expect(w.fetch).not.toHaveBeenCalled();
    expect(await stored(w, 'openaiApiKey')).toBeUndefined();
    expect(badge(panel)).toBe('● Free Mode'); // no OpenAI key saved
  });

  it('Save with an OpenAI key: Chrome asks, the key is saved, and AI Mode is on (Save sends nothing to OpenAI)', async () => {
    const w = world();
    const panel = await openPanel(w);
    await pick(panel, w, 'openai');
    type(panel.$('api-key'), OPENAI_KEY);
    expect(await save(panel)).toBe('Settings saved! AI Mode is on.');
    expect(w.chrome.permissions.prompts).toEqual([[OPENAI_ORIGIN]]);
    expect(await stored(w, 'openaiApiKey')).toBe(OPENAI_KEY);
    expect(badge(panel)).toBe('● AI Mode');
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('Save after you click Deny: saved, but the header says "Needs permission" and why; allowing it later fixes that at once', async () => {
    const w = world();
    w.chrome.permissions.answer = 'deny';
    const panel = await openPanel(w);
    await pick(panel, w, 'openai');
    type(panel.$('api-key'), OPENAI_KEY);
    expect(await save(panel)).toBe('Settings saved, but Chrome did not allow the extension to reach OpenAI (api.openai.com), so AI Mode cannot use GPT yet. Press Test and choose Allow.');
    expect(await stored(w, 'openaiApiKey')).toBe(OPENAI_KEY);
    expect(badge(panel)).toBe('Needs permission');
    expect(warning(panel)).toBe(NO_OPENAI_YET);

    // You allow it in chrome://extensions (or press Test and click Allow).
    allowInChrome(w, OPENAI_ORIGIN);
    await until(() => badge(panel) === '● AI Mode');
    expect(warning(panel)).toBeNull();
  });

  it('access taken back later (in chrome://extensions): the header says so at once, and a run sends nothing', async () => {
    const w = world({ local: { aiProvider: 'gemini', geminiApiKey: GEMINI_KEY }, granted: [...INSTALL_HOSTS, GEMINI_ORIGIN] });
    const panel = await openPanel(w);
    expect(badge(panel)).toBe('● AI Mode');

    await w.chrome.permissions.remove({ origins: [GEMINI_ORIGIN] });
    await until(() => badge(panel) === 'Needs permission');
    expect(warning(panel)).toBe(NO_GOOGLE_YET);

    panel.$('generate-btn').click();
    await until(() => panel.$('status-message').textContent === NO_GOOGLE_YET);
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('a Save that needs no new access asks nothing: Anthropic, an empty key, or access you gave already', async () => {
    const w = world({ granted: [...INSTALL_HOSTS, GEMINI_ORIGIN] });
    const panel = await openPanel(w);
    type(panel.$('api-key'), API_KEY);
    expect(await save(panel)).toBe('Settings saved! AI Mode is on.');
    await pick(panel, w, 'openai');
    expect(await save(panel)).toBe('Settings saved! Free Mode is on (no key).');
    await pick(panel, w, 'gemini');
    type(panel.$('api-key'), GEMINI_KEY);
    expect(await save(panel)).toBe('Settings saved! AI Mode is on.');
    expect(w.chrome.permissions.prompts).toEqual([]);
  });
});

describe('another company\'s key in the box', () => {
  it('Test sends nothing and asks Chrome nothing; Save keeps it, but the header says "Wrong provider"; Generate sends nothing', async () => {
    const w = world();
    const panel = await openPanel(w);
    await pick(panel, w, 'gemini');
    type(panel.$('api-key'), OPENAI_KEY);

    expect(await pressTest(panel)).toBe(`✗ ${OPENAI_KEY_FOR_GEMINI}`);
    expect(w.chrome.permissions.prompts).toEqual([]);

    expect(await save(panel)).toBe(`Settings saved, but AI Mode cannot work yet. ${OPENAI_KEY_FOR_GEMINI}`);
    expect(w.chrome.permissions.prompts).toEqual([]);
    expect(badge(panel)).toBe('Wrong provider');
    expect(warning(panel)).toBe(OPENAI_KEY_FOR_GEMINI);

    panel.$('generate-btn').click();
    await until(() => panel.$('status-message').textContent === OPENAI_KEY_FOR_GEMINI);
    expect(w.fetch).not.toHaveBeenCalled(); // your OpenAI key never went to Google

    // Picking OpenAI, whose key it is, shows no OpenAI key yet (each company
    // keeps its own). Paste it there instead.
    await pick(panel, w, 'openai');
    expect(badge(panel)).toBe('● Free Mode');
  });
});

describe('writing with the company you picked', () => {
  it('Generate with Gemini: "Written by Gemini."', async () => {
    const w = world({ local: { aiProvider: 'gemini', geminiApiKey: GEMINI_KEY }, granted: [...INSTALL_HOSTS, GEMINI_ORIGIN] });
    const panel = await openPanel(w);
    panel.$('generate-btn').click();
    await until(() => panel.$('status-message').textContent === 'Message ready. Written by Gemini.');
    expect(w.calls.map((c) => c.api)).toEqual(['gemini']);
  });

  it('Gemini could not read your resume PDF: the panel names Google', async () => {
    const w = world({
      local: { aiProvider: 'gemini', geminiApiKey: GEMINI_KEY, resumeBase64: 'JVBERi0xLjQK', resumeFileName: 'my-resume.pdf', resumeForAI: true },
      granted: [...INSTALL_HOSTS, GEMINI_ORIGIN],
      gemini: (body) => (body.contents[0].parts.some((p) => p.inlineData)
        ? [400, { error: { code: 400, message: 'The document has no pages.', status: 'INVALID_ARGUMENT' } }]
        : geminiReply('Hi Aoife! Would you be open to a quick chat?')),
    });
    const panel = await openPanel(w);
    panel.$('generate-btn').click();
    await until(() => panel.$('status-message').textContent ===
      'Message ready. Written by Gemini. Google could not read your resume PDF, so it was left out. Replace or remove it in Settings.');
  });

  it('a Gemini key Google refused: the header says "Key not working"; Anthropic, picked again, has its own status', async () => {
    const w = world({
      local: { aiProvider: 'gemini', geminiApiKey: GEMINI_KEY, userApiKey: API_KEY },
      granted: [...INSTALL_HOSTS, GEMINI_ORIGIN],
      gemini: () => [400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }],
    });
    const panel = await openPanel(w);
    panel.$('generate-btn').click();
    await until(() => badge(panel) === 'Key not working');
    expect(warning(panel)).toBe('Your Gemini API key was not accepted. Check it in Settings, or remove it to use Free Mode.');

    await pick(panel, w, 'anthropic');
    expect(badge(panel)).toBe('● AI Mode'); // that status was about the Gemini key
    expect(warning(panel)).toBeNull();
  });
});
