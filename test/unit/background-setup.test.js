import { describe, it, expect, vi } from 'vitest';
import { createFakeChrome } from '../helpers/fake-chrome.js';
import { runIsolated, read } from '../helpers/load.js';
import { createWorld, person, promptText, settle, until, API_KEY } from '../helpers/world.js';

const AOIFE = person('aoife', 'Aoife');
const LIAM  = person('liam', 'Liam');
const QUICK = { tabId: 1, mode: 'quick', channel: 'note', maxChars: 200, messageType: 'Networking', tone: 'Neutral' };

function boot(chrome, fetch = vi.fn()) {
  runIsolated('background.js', { chrome, fetch, setTimeout, clearTimeout, setInterval, clearInterval, AbortController });
  return fetch;
}

/** Chrome tells the extension it was just updated. */
function updated(chrome, previousVersion = '3.0.2') {
  chrome.runtime.onInstalled.fns.forEach((fn) => fn({ reason: 'update', previousVersion }));
}

/** AI Mode (a fake key is saved), with Aoife's profile open in tab 1. */
function aoifeWorld(local = {}) {
  return createWorld({
    local: { userApiKey: API_KEY, ...local },
    tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }],
    pages: { 1: AOIFE },
  });
}

/** Wait until the job for this profile is done, and return it. */
function done(w, profileKey = '/in/aoife/') {
  return until(async () => {
    const job = await w.job(profileKey);
    return job && job.step === 'done' ? job : null;
  });
}

/**
 * A message from a content script inside LinkedIn's page in tab `tabId`.
 * Chrome sets sender.tab for these. The side panel is an extension page,
 * so its messages have no sender.tab.
 */
function fromLinkedInPage(w, message, tabId = 1) {
  const tab = w.tabs.find((t) => t.id === tabId);
  const sender = { id: w.chrome.runtime.id, tab: { ...tab }, frameId: 0, url: tab.url };
  return new Promise((resolve) => {
    const answers = w.chrome.runtime.onMessage.fns.map((fn) => fn(message, sender, resolve));
    if (!answers.includes(true)) resolve(undefined); // nobody answers
  });
}

/** A message from the side panel (no sender.tab). */
const fromPanel = (w, message) => w.chrome.runtime.sendMessage(message);

describe('opening the UI', () => {
  it('the toolbar icon opens the side panel when Chrome has one', () => {
    const { chrome } = createFakeChrome();
    boot(chrome);
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    expect(chrome.action.setPopup).not.toHaveBeenCalled();
  });

  it('browsers without the Side Panel API get the same page as a popup', () => {
    const { chrome } = createFakeChrome();
    delete chrome.sidePanel;
    boot(chrome);
    expect(chrome.action.setPopup).toHaveBeenCalledWith({ popup: 'sidepanel.html?mode=popup' });
  });
});

describe('starting up', () => {
  it('sends nothing over the network when it starts or updates, even with a key saved', async () => {
    const { chrome } = createFakeChrome({ local: { userApiKey: API_KEY } });
    const fetch = boot(chrome);
    updated(chrome);
    await settle();
    expect(fetch).not.toHaveBeenCalled(); // no server, and no key check at start-up
  });

  it('after an update, forgets the old license key and its status', async () => {
    const { chrome } = createFakeChrome({
      local: {
        licenseKey: 'OLD-TEST-0000-0000',
        keyStatus: { key: 'OLD-TEST-0000-0000', state: 'valid', remaining: 9, checkedAt: 1 },
        userName: 'Priya Sharma',
      },
    });
    boot(chrome);
    updated(chrome);
    await until(() => !('licenseKey' in chrome.storage.local.data));
    expect(chrome.storage.local.data).not.toHaveProperty('keyStatus');
    expect(chrome.storage.local.data.userName).toBe('Priya Sharma'); // everything else stays
  });

  it('keeps your own Anthropic key, and what is known about it', async () => {
    const keyStatus = { state: 'invalid', keyTail: API_KEY.slice(-8), reason: 'Your Anthropic API key was not accepted.', code: 'auth', checkedAt: 1 };
    const { chrome } = createFakeChrome({ local: { licenseKey: 'OLD-TEST-0000-0000', userApiKey: API_KEY, keyStatus } });
    boot(chrome);
    updated(chrome);
    await until(() => !('licenseKey' in chrome.storage.local.data));
    await settle();
    expect(chrome.storage.local.data.userApiKey).toBe(API_KEY);
    expect(chrome.storage.local.data.keyStatus).toEqual(keyStatus);
  });

  it('after an update from 3.1.0, a resume saved there is not sent: not by Generate, not by the in-page button', async () => {
    // 3.1.0 kept a resume, but never sent it anywhere. Nobody has said yes since.
    const w = aoifeWorld({ userName: 'Priya Sharma', resumeBase64: 'JVBERi0xLjQK', resumeFileName: 'resume.pdf' });
    updated(w.chrome, '3.1.0');
    await settle();

    await w.start(QUICK); // Generate in the side panel
    await done(w);
    await w.inpage({ channel: 'message' }); // "✨ Write" in LinkedIn's message box

    expect(w.calls).toHaveLength(2);
    for (const call of w.calls) {
      expect(call.body.messages[0].content.map((b) => b.type)).toEqual(['text']);
      expect(promptText(call.body)).not.toMatch(/resume/i);
    }
    expect(JSON.stringify(w.calls)).not.toContain('JVBERi0xLjQK');
    // It is still saved: only the missing yes keeps it back.
    expect(w.chrome.storage.local.data.resumeBase64).toBe('JVBERi0xLjQK');
  });
});

// chrome.storage.local holds your Anthropic key and your resume. The scripts
// this extension runs on linkedin.com never need them. So, each time the
// worker starts, it asks Chrome to keep that storage for the extension's own
// pages and the worker only.
describe('starting up: your key and resume are kept away from LinkedIn pages', () => {
  /** The side panel's Test with an empty field: answered at once, with no request. */
  const emptyTest = { type: 'TEST_API_KEY', payload: { apiKey: ' ' } };
  const EMPTY_TEST_REPLY = { valid: false, reason: 'Paste your key first.', code: 'empty' };

  it('asks Chrome for this as soon as it starts', () => {
    const { chrome } = createFakeChrome({ local: { userApiKey: API_KEY } });
    chrome.storage.local.setAccessLevel = vi.fn(async () => {});
    boot(chrome);
    // Done while the worker's script runs: before any message, and with no install or update event.
    expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  it('a Chrome that cannot do this still starts, and works', async () => {
    const { chrome, dispatchMessage } = createFakeChrome();
    expect(chrome.storage.local.setAccessLevel).toBeUndefined(); // like an older Chrome
    expect(() => boot(chrome)).not.toThrow();
    // The rest of start-up ran: the worker answers the side panel.
    expect(await dispatchMessage(emptyTest)).toEqual(EMPTY_TEST_REPLY);
  });

  it('a Chrome that says no still starts, works, and leaves no error behind', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { chrome, dispatchMessage } = createFakeChrome();
      // A plain function, not vi.fn(): vi.fn() handles the promises it returns
      // itself (to record them), so a refusal nobody catches would not show.
      const asked = [];
      chrome.storage.local.setAccessLevel = (options) => {
        asked.push(options);
        return Promise.reject(new Error('This storage area cannot change its access level.'));
      };
      expect(() => boot(chrome)).not.toThrow();
      expect(asked).toEqual([{ accessLevel: 'TRUSTED_CONTEXTS' }]);
      expect(await dispatchMessage(emptyTest)).toEqual(EMPTY_TEST_REPLY);
      await settle(); // time for Node to report a promise that failed with no one to catch it
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('messages from LinkedIn pages (content scripts) are not trusted', () => {
  it('START_JOB from a LinkedIn page is ignored: no run, and nothing is sent with your key', async () => {
    const w = aoifeWorld();
    expect(await fromLinkedInPage(w, { type: 'START_JOB', payload: QUICK })).toBeUndefined();
    await settle();
    expect(await w.chrome.storage.session.get(null)).toEqual({});
    expect(w.scrapes()).toBe(0);
    expect(w.fetch).not.toHaveBeenCalled();

    // The same message from the side panel starts a run.
    expect(await fromPanel(w, { type: 'START_JOB', payload: QUICK })).toEqual({ ok: true, profileKey: '/in/aoife/' });
    await done(w);
  });

  it('TEST_API_KEY from a LinkedIn page is ignored: no request with your key', async () => {
    const w = aoifeWorld();
    expect(await fromLinkedInPage(w, { type: 'TEST_API_KEY', payload: { apiKey: API_KEY } })).toBeUndefined();
    await settle();
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.chrome.storage.local.data).not.toHaveProperty('keyStatus');

    // From the side panel (Settings), Test works.
    expect(await fromPanel(w, { type: 'TEST_API_KEY', payload: { apiKey: API_KEY } })).toEqual({ valid: true });
  });

  it('IMPORT_MY_PROFILE from a LinkedIn page cannot replace your own profile', async () => {
    const mine = { name: 'Priya Sharma', profileUrl: 'https://www.linkedin.com/in/priya-sharma/', importedAt: 1 };
    const w = aoifeWorld({ myProfile: mine });
    expect(await fromLinkedInPage(w, { type: 'IMPORT_MY_PROFILE', payload: { tabId: 1 } })).toBeUndefined();
    await settle();
    expect(w.chrome.storage.local.data.myProfile).toEqual(mine);
    expect(w.scrapes()).toBe(0);

    // From the side panel (Settings), it reads the profile in that tab.
    expect(await fromPanel(w, { type: 'IMPORT_MY_PROFILE', payload: { tabId: 1 } })).toEqual({ ok: true, name: 'Aoife' });
  });

  it('PEEK_PROFILE from a LinkedIn page gets no answer, and the page is not asked', async () => {
    const w = aoifeWorld();
    expect(await fromLinkedInPage(w, { type: 'PEEK_PROFILE', payload: { tabId: 1 } })).toBeUndefined();
    await settle();
    expect(w.chrome.tabs.sendMessage).not.toHaveBeenCalled();

    // From the side panel, it gets the name and headline.
    expect(await fromPanel(w, { type: 'PEEK_PROFILE', payload: { tabId: 1 } })).toMatchObject({ success: true, data: { name: 'Aoife' } });
  });

  it('INPAGE_WRITE needs the tab it comes from: from the side panel, it cannot pick a tab', async () => {
    const w = aoifeWorld();
    const reply = await fromPanel(w, { type: 'INPAGE_WRITE', payload: { tabId: 1, channel: 'note', maxChars: 200 } });
    expect(reply).toEqual({ ok: false, error: 'Open their LinkedIn profile first.' });
    expect(await w.chrome.storage.session.get(null)).toEqual({});
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it("INPAGE_WRITE writes only for the page's own tab, whatever tab the message names", async () => {
    const w = createWorld({
      tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }, { id: 2, url: LIAM.profileUrl, active: false }],
      pages: { 1: AOIFE, 2: LIAM },
    });
    // The page in tab 2 (Liam's) asks for tab 1 (Aoife's).
    const res = await w.inpage({ channel: 'note', maxChars: 200, tabId: 1 }, 2);
    expect(res).toMatchObject({ ok: true });
    expect(res.message).toMatch(/^Hi Liam,/);
    expect(await w.job('/in/liam/')).toMatchObject({ step: 'done', tabId: 2 });
    expect(await w.job('/in/aoife/')).toBeNull();
  });
});

// The scripts the extension runs in LinkedIn's pages: the page reader, the
// part that answers the background, the writer, and the "✨ Write"
// button. The button uses the writer (for the first name on its label), so
// the writer must come before it.
describe('the scripts that run in LinkedIn pages', () => {
  const PAGE_SCRIPTS = ['scraper.js', 'content_script.js', 'utils/writer.js', 'inpage.js'];
  const manifest = () => JSON.parse(read('manifest.json'));

  /**
   * A LinkedIn tab that was open before the extension was installed or
   * updated. Chrome did not put the scripts in it, so nothing in it answers
   * the background, until the background puts them in. The background gets
   * the real manifest.json.
   */
  function oldTabWorld() {
    const w = createWorld({ tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }], pages: {} });
    w.chrome.runtime.getManifest = () => manifest();
    w.chrome.scripting.executeScript.mockImplementation(async ({ target }) => {
      w.pages[target.tabId] = AOIFE; // now the page answers
      return [];
    });
    return w;
  }

  it('the manifest runs these 4 scripts on LinkedIn, in this order (the writer before the button)', () => {
    const entries = manifest().content_scripts;
    // One entry only: for an old tab, the background puts in the first entry's scripts (see below).
    expect(entries).toHaveLength(1);
    expect(entries[0].js).toEqual(PAGE_SCRIPTS);
  });

  it("the tests' fake Chrome lists the same scripts as the manifest", () => {
    expect(createFakeChrome().chrome.runtime.getManifest().content_scripts[0].js).toEqual(manifest().content_scripts[0].js);
  });

  it('Generate on an old tab: the same scripts are put in, in the same order, then the page is read', async () => {
    const w = oldTabWorld();
    expect(await fromPanel(w, { type: 'START_JOB', payload: QUICK })).toEqual({ ok: true, profileKey: '/in/aoife/' });
    expect((await done(w)).message).toMatch(/^Hi Aoife,/);
    expect(w.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(w.chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1 }, files: manifest().content_scripts[0].js });
  });

  it("the panel's quick look (name and headline) on an old tab: the same scripts are put in", async () => {
    const w = oldTabWorld();
    expect(await fromPanel(w, { type: 'PEEK_PROFILE', payload: { tabId: 1 } })).toMatchObject({ success: true, data: { name: 'Aoife' } });
    expect(w.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(w.chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1 }, files: manifest().content_scripts[0].js });
  });
});
