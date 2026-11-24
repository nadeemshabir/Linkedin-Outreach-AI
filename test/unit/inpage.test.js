// The "✨ Write" button inside LinkedIn's own boxes (inpage.js), on a page that
// copies LinkedIn's structure. Each test gets its own window, with the real
// content scripts loaded the way the manifest lists them: scraper.js,
// content_script.js, utils/writer.js (the button's label uses its
// firstName), then inpage.js. The background is a stub that answers
// INPAGE_WRITE (its own tests: inpage-write.test.js).
//
// Real clicks only: the Write and Undo buttons act only on a click the
// browser marks as real (event.isTrusted). A script in LinkedIn's page could
// call .click() on them, and in AI Mode each write is a paid request on your
// key. happy-dom has no real mouse: its .click() is never trusted, like a
// page script's .click() in Chrome. So when a test stands for YOUR click, it
// uses realClick() below. A plain .click() is a page script's click.
//
// The stub's chrome.runtime has an id, as in Chrome. inpage.js checks it
// each time it looks at the page: after an update, Chrome takes the id away
// from the old copy, and that copy then steps aside (last block of tests).
import vm from 'node:vm';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Window } from 'happy-dom';
import { read } from '../helpers/load.js';
import { until, settle, deferred, type } from '../helpers/world.js';
import { profilePage } from '../fixtures/linkedin-2026.js';
import { PROFILES } from '../fixtures/profiles.js';
import { installLinkedInDialogs } from '../fixtures/linkedin-dialogs.js';

const AOIFE = PROFILES.find((p) => p.name === 'Aoife Murphy'); // 2nd: has Connect
const SEAN  = PROFILES.find((p) => p.name === "Seán O'Brien"); // 1st: has Message
const NOTE  = 'Hi Aoife, your work on recommendations at Spotify caught my eye. Would you be open to a short chat?';

// Made-up people: Aoife's or Seán's test page under another made-up name.
const slugOf = (name) => `${name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}-test`;
const named  = (base, name) => ({ ...base, name, slug: slugOf(name) });

// The files Chrome puts into every LinkedIn page, in the manifest's order.
const CONTENT_SCRIPTS = JSON.parse(read('manifest.json')).content_scripts[0].js;

// The id Chrome gives the extension (made up). After an update, Chrome takes
// it away from the old copy of the content scripts.
const EXTENSION_ID = 'test-extension-id';

/**
 * Puts the content scripts into the page the way Chrome does: each file runs
 * as its own script, and all of them share one global scope. So a top-level
 * `const` in a file makes a second load of that file throw, as in Chrome.
 * (The background loads them all once more into a tab whose content script
 * does not answer: askContentScript in background.js.)
 */
function injectContentScripts(win) {
  for (const file of CONTENT_SCRIPTS) new vm.Script(read(file), { filename: file }).runInContext(win);
}

const windows = [];
afterEach(async () => { while (windows.length) await windows.pop().happyDOM.close(); });

/**
 * Your real mouse click on `el`.
 * happy-dom's Event has no isTrusted, so it reads as not true. For this one
 * click, Event.prototype.isTrusted says true, the way Chrome marks a click
 * you make. It is put back straight after: the patch is on happy-dom's Event
 * class, which every test window shares, and if it stayed on, every
 * .click() would count as yours.
 */
function realClick(el) {
  const proto = el.ownerDocument.defaultView.Event.prototype;
  const own = Object.getOwnPropertyDescriptor(proto, 'isTrusted');
  Object.defineProperty(proto, 'isTrusted', { configurable: true, get: () => true });
  try {
    el.click();
  } finally {
    if (own) Object.defineProperty(proto, 'isTrusted', own);
    else delete proto.isTrusted;
  }
}

/**
 * A LinkedIn profile page with LinkedIn's boxes, and (unless `scripts` is
 * false) the extension's content scripts in it, talking to a stub background that
 * answers `reply`. With `scripts: false`, a test loads the copies itself
 * (loadCopy below).
 */
function linkedin({ person = AOIFE, url, extra = '', reply = { ok: true, message: NOTE, limit: 200, fit: { changed: false, fits: true, removed: 0 } }, scripts = true } = {}) {
  const win = new Window({ url: url || `https://www.linkedin.com/in/${person.slug}/`, width: 1280, height: 900 });
  windows.push(win);
  const html = profilePage(person);
  win.document.title = html.match(/<title>([^<]*)<\/title>/)[1];
  win.document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/)[1] + extra;
  win.eval(`(${installLinkedInDialogs})()`);
  const listeners = trackListeners(win.document);

  const sendMessage = vi.fn(async (msg) => (typeof reply === 'function' ? reply(msg) : reply));
  if (scripts) {
    // (content_script.js listens for the background's "read this profile".
    // Nothing here sends that.)
    win.chrome = { runtime: { id: EXTENSION_ID, sendMessage, onMessage: { addListener: vi.fn() } } };
    injectContentScripts(win);
  }

  const doc = win.document;
  const shadow = () => doc.getElementById('interop-outlet')?.shadowRoot;
  /** Every bar of ours on the page, in the page or in LinkedIn's shadow root. */
  const hosts = () => [...doc.querySelectorAll('[data-outreach-write]'), ...(shadow()?.querySelectorAll('[data-outreach-write]') || [])];
  return {
    win,
    doc,
    reply,
    listeners,
    sendMessage,
    shadow,
    hosts,
    /** You click one of LinkedIn's own buttons. */
    click: (selector) => realClick(doc.querySelector(selector)),
    /** Our bar, wherever LinkedIn's box is (page or shadow root). */
    bar() {
      const [host] = hosts();
      if (!host) return null;
      const $ = (s) => host.shadowRoot.querySelector(s);
      return { host, write: $('.write'), info: $('.info'), undo: $('.undo') };
    },
    note: () => doc.querySelector('textarea') || shadow()?.querySelector('textarea'),
    editor: () => shadow()?.querySelector('[role="textbox"]'),
  };
}

/**
 * Keeps the list of listeners on `doc` the way the document itself does: one
 * entry per type, function and capture, gone when removeEventListener gets
 * the same three. The returned array is that live list.
 */
function trackListeners(doc) {
  const on = [];
  const capture = (opts) => (typeof opts === 'boolean' ? opts : !!(opts && opts.capture));
  const same = (a, b) => a.type === b.type && a.fn === b.fn && a.capture === b.capture;
  const add = doc.addEventListener;
  const remove = doc.removeEventListener;
  doc.addEventListener = function addEventListener(type, fn, opts) {
    const entry = { type, fn, capture: capture(opts) };
    if (!on.some((l) => same(l, entry))) on.push(entry);
    return add.call(this, type, fn, opts);
  };
  doc.removeEventListener = function removeEventListener(type, fn, opts) {
    const i = on.findIndex((l) => same(l, { type, fn, capture: capture(opts) }));
    if (i >= 0) on.splice(i, 1);
    return remove.call(this, type, fn, opts);
  };
  return on;
}

/**
 * Loads one copy of the extension's content scripts into the page the way Chrome does:
 * in the extension's own world. A world shares the page's DOM, but has its
 * own global scope (its own globalThis, `chrome` and timers), so a copy in a
 * new world does not see the first copy's "already loaded" marks. After an
 * update, the old copy keeps running in its world, and the background starts
 * the new copy in a fresh one (askContentScript in background.js).
 *
 * The copy answers `reply` like the page's stub background. It also tells a
 * test what it does with the page: the MutationObservers it has watching, the
 * listeners it has on the document, and how many timers it has set.
 * update() cuts it off the way Chrome does after an update: chrome.runtime.id
 * is gone, and messages to the background fail.
 */
function loadCopy(page, { reply = page.reply } = {}) {
  const { win, doc } = page;
  const sendMessage = vi.fn(async (msg) => (typeof reply === 'function' ? reply(msg) : reply));
  const chrome = { runtime: { id: EXTENSION_ID, sendMessage, onMessage: { addListener: vi.fn() } } };
  const watching = new Set(); // this copy's observers that are connected now
  let timers = 0;
  class MutationObserver extends win.MutationObserver {
    observe(...args) { watching.add(this); return super.observe(...args); }
    disconnect() { watching.delete(this); return super.disconnect(); }
  }
  const world = vm.createContext({
    console, document: doc, location: win.location, Event: win.Event, InputEvent: win.InputEvent, MutationObserver,
    setTimeout: (fn, ms) => { timers += 1; return win.setTimeout(fn, ms); },
    clearTimeout: (id) => win.clearTimeout(id),
    chrome,
  });
  world.window = world;

  const before = new Set(page.listeners);
  for (const file of CONTENT_SCRIPTS) new vm.Script(read(file), { filename: file }).runInContext(world);
  const mine = page.listeners.filter((l) => !before.has(l));

  return {
    sendMessage,
    /** How many of this copy's MutationObservers watch the page now. */
    watching: () => watching.size,
    /** The kinds of document listeners this copy still has on the page. */
    listening: () => mine.filter((l) => page.listeners.includes(l)).map((l) => l.type).sort(),
    /** How many timers this copy has set so far (it looks at the page from a timer). */
    timers: () => timers,
    /** The extension is updated while the page stays open: Chrome cuts this copy off. */
    update() {
      delete chrome.runtime.id;
      sendMessage.mockRejectedValue(new Error('Extension context invalidated.'));
    },
  };
}

/**
 * From now on, counts our bars put into the page and taken out of it (in the
 * page and in LinkedIn's shadow root), as LinkedIn's own page would see it,
 * one change at a time and in order. `most` is the most bars that were on
 * the page at the same moment.
 */
function countBarChanges(page) {
  let now = page.hosts().length;
  const seen = { added: 0, removed: 0, most: now };
  const isBar = (n) => n.nodeType === 1 && n.hasAttribute('data-outreach-write');
  const observer = new page.win.MutationObserver((records) => {
    for (const r of records) {
      const added = [...r.addedNodes].filter(isBar).length;
      const removed = [...r.removedNodes].filter(isBar).length;
      seen.added += added;
      seen.removed += removed;
      now += added - removed;
      seen.most = Math.max(seen.most, now);
    }
  });
  for (const root of [page.doc, page.shadow()].filter(Boolean)) observer.observe(root, { childList: true, subtree: true });
  return seen;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function openNoteViaConnect(page, name = 'Aoife Murphy') {
  page.click(`button[aria-label="Invite ${name} to connect"]`);
  const addNote = () => [...page.doc.querySelectorAll('button'), ...(page.shadow()?.querySelectorAll('button') || [])]
    .find((b) => b.textContent === 'Add a note');
  realClick(await until(addNote));
  return until(() => page.bar());
}

describe('The Write button, inside LinkedIn (the page)', () => {
  it('Connect → Add a note: a "Write a note to Aoife" button appears between the text box and Send', async () => {
    const page = linkedin();
    page.click('button[aria-label="Invite Aoife Murphy to connect"]');
    await settle(5);
    await new Promise((r) => setTimeout(r, 300));
    expect(page.bar()).toBeNull(); // not in the "Add a note?" question: there is no box yet

    const bar = await openNoteViaConnect(page);
    expect(bar.write.textContent).toBe('✨ Write a note to Aoife');
    expect(bar.write.disabled).toBe(false);
    expect(bar.host.previousElementSibling.querySelector('textarea')).not.toBeNull();
    expect(bar.host.nextElementSibling.querySelector('[aria-label="Send invitation"]')).not.toBeNull();
  });

  it('one click: asks for a note that fits this box, puts it in, and LinkedIn notices (counter, Send on)', async () => {
    const page = linkedin();
    const bar = await openNoteViaConnect(page);
    realClick(bar.write);

    await until(() => page.note().value === NOTE);
    expect(page.sendMessage).toHaveBeenCalledWith({ type: 'INPAGE_WRITE', payload: { channel: 'note', maxChars: 200 } });
    expect(page.doc.querySelector('[data-counter]').textContent).toBe(`${NOTE.length}/200`);
    expect(page.doc.querySelector('[aria-label="Send invitation"]').disabled).toBe(false);
    expect(bar.info.textContent).toBe(`${NOTE.length}/200. Read it, then press Send.`);
    expect(page.win.__sends).toEqual([]); // never sends: that is your click
  });

  it('while it writes, the button is off and says so', async () => {
    const gate = deferred();
    const page = linkedin({ reply: () => gate.promise.then(() => ({ ok: true, message: NOTE, limit: 200 })) });
    const bar = await openNoteViaConnect(page);
    realClick(bar.write);
    await settle();
    expect(bar.write.textContent).toBe('Writing…');
    expect(bar.write.disabled).toBe(true);
    realClick(bar.write); // a second click while busy does nothing
    gate.resolve();
    await until(() => page.note().value === NOTE);
    expect(page.sendMessage).toHaveBeenCalledTimes(1);
    expect(bar.write.textContent).toBe('✨ Write a note to Aoife');
  });

  it('Undo puts back what you had typed', async () => {
    const page = linkedin();
    const bar = await openNoteViaConnect(page);
    page.note().value = 'Hi Aoife, we met at';
    realClick(bar.write);
    await until(() => page.note().value === NOTE);
    expect(bar.undo.hidden).toBe(false);

    realClick(bar.undo);
    expect(page.note().value).toBe('Hi Aoife, we met at');
    expect(page.doc.querySelector('[data-counter]').textContent).toBe('19/200');
    expect(bar.undo.hidden).toBe(true);
  });

  it("a script in LinkedIn's page cannot press Write or Undo: only your real click counts", async () => {
    const page = linkedin();
    const bar = await openNoteViaConnect(page);
    page.note().value = 'Hi Aoife, we met at';
    // A plain .click() in happy-dom is not trusted, like a page script's.
    expect(new page.win.MouseEvent('click').isTrusted).not.toBe(true);

    // A script presses Write: nothing happens, not even for a moment.
    bar.write.click();
    expect(bar.write.textContent).toBe('✨ Write a note to Aoife'); // not "Writing…"
    expect(page.sendMessage).not.toHaveBeenCalled();
    await settle();
    await new Promise((r) => setTimeout(r, 50));
    expect(page.sendMessage).not.toHaveBeenCalled(); // no INPAGE_WRITE: in AI Mode, that would be a paid request
    expect(page.note().value).toBe('Hi Aoife, we met at'); // the box is unchanged
    expect(page.doc.querySelector('[data-counter]').textContent).toBe('0/200'); // LinkedIn saw no change either
    expect(bar.info.textContent).toBe('');
    expect(bar.undo.hidden).toBe(true);

    // Your real click on the same button works.
    realClick(bar.write);
    await until(() => page.note().value === NOTE);
    expect(page.sendMessage).toHaveBeenCalledTimes(1);
    expect(bar.undo.hidden).toBe(false);

    // A script presses Undo: your note stays in the box.
    bar.undo.click();
    await settle();
    expect(page.note().value).toBe(NOTE);
    expect(bar.undo.hidden).toBe(false);

    // Your real click on Undo puts back what you had typed.
    realClick(bar.undo);
    expect(page.note().value).toBe('Hi Aoife, we met at');
    expect(page.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("the limit is the box's own: maxlength, else its counter, else none (then your plan decides)", async () => {
    const page = linkedin();
    const payloads = [];
    page.sendMessage.mockImplementation(async (m) => { payloads.push(m.payload.maxChars); return { ok: true, message: 'Hi', limit: 200 }; });
    for (const opts of [{ limit: 300 }, { maxlength: false, limit: 300 }, { maxlength: false, counter: false }]) {
      page.win.openNoteBox(opts);
      const bar = await until(() => page.bar());
      realClick(bar.write);
      await until(() => payloads.length && page.note().value === 'Hi');
      page.click('[data-action="dismiss"]');
      await until(() => !page.bar());
    }
    expect(payloads).toEqual([300, 300, null]);
  });

  it('says when a note was shortened to fit, and warns when it still does not fit', async () => {
    const page = linkedin({ reply: { ok: true, message: NOTE, limit: 200, fit: { changed: true, fits: true, removed: 2 } } });
    const bar = await openNoteViaConnect(page);
    realClick(bar.write);
    await until(() => bar.info.textContent);
    expect(bar.info.textContent).toBe('Shortened to fit 200. Read it, then press Send.');

    const long = 'x'.repeat(230);
    page.sendMessage.mockResolvedValue({ ok: true, message: long, limit: 200, fit: { changed: true, fits: false, removed: 3 } });
    realClick(bar.write);
    await until(() => page.note().value === long);
    expect(bar.info.textContent).toBe("30 characters over LinkedIn's 200 limit. Shorten it, then press Send.");
    expect(bar.info.className).toBe('info warn');
  });

  it('AI Mode wrote it without your resume (Anthropic could not read the PDF): the bar says so first, as a warning', async () => {
    // You may never open the side panel, so the bar must say it too.
    const SKIPPED = "Written without your resume: Anthropic could not read the PDF (replace or remove it in the extension's Settings).";
    const SHORTER = 'Hi Aoife, would you be open to a short chat?';
    const fits    = { changed: false, fits: true, removed: 0 };
    const page = linkedin({ reply: { ok: true, message: NOTE, limit: 200, fit: fits, resumeSkipped: true, aiCompany: 'Anthropic' } });
    const bar = await openNoteViaConnect(page);
    realClick(bar.write);
    await until(() => page.note().value === NOTE);
    expect(bar.info.textContent).toBe(`${SKIPPED} ${NOTE.length}/200. Read it, then press Send.`);
    expect(bar.info.className).toBe('info warn');

    // Shortened to fit: the warning, then the usual words for that.
    page.sendMessage.mockResolvedValue({ ok: true, message: SHORTER, limit: 200, fit: { changed: true, fits: true, removed: 1 }, resumeSkipped: true, aiCompany: 'Anthropic' });
    realClick(bar.write);
    await until(() => page.note().value === SHORTER);
    expect(bar.info.textContent).toBe(`${SKIPPED} Shortened to fit 200. Read it, then press Send.`);
    expect(bar.info.className).toBe('info warn');

    // Written with your resume (resumeSkipped: false): the usual text only.
    page.sendMessage.mockResolvedValue({ ok: true, message: NOTE, limit: 200, fit: fits, resumeSkipped: false });
    realClick(bar.write);
    await until(() => page.note().value === NOTE);
    expect(bar.info.textContent).toBe(`${NOTE.length}/200. Read it, then press Send.`);
    expect(bar.info.className).toBe('info ok');
    expect(page.sendMessage).toHaveBeenCalledTimes(3);

    // A message box has no limit: the warning, then "Read it, then press Send."
    const message = 'Hi Seán,\n\nCould I ask you two quick questions about recruiting at Workday?';
    const chat = linkedin({ person: SEAN, reply: { ok: true, message, limit: null, fit: null, resumeSkipped: true, aiCompany: 'Anthropic' } });
    chat.click(`button[aria-label="Message ${SEAN.name}"]`);
    const chatBar = await until(() => chat.bar());
    realClick(chatBar.write);
    await until(() => chat.editor().textContent.includes('quick questions'));
    expect(chatBar.info.textContent).toBe(`${SKIPPED} Read it, then press Send.`);
    expect(chatBar.info.className).toBe('info warn');
  });

  it("message box (in LinkedIn's shadow root): writes into the rich text box, Send turns on, nothing is sent", async () => {
    const message = "Hi Seán,\n\nThanks for connecting! Could I ask you two quick questions about recruiting at Workday?";
    const page = linkedin({ person: SEAN, reply: { ok: true, message, limit: null, fit: null } });
    page.click(`button[aria-label="Message ${SEAN.name}"]`);
    const bar = await until(() => page.bar());
    expect(bar.host.parentNode.tagName).toBe('FORM'); // just above LinkedIn's Send row
    expect(bar.host.nextElementSibling.tagName).toBe('FOOTER');
    expect(bar.write.textContent).toBe('✨ Write a message to Seán');

    realClick(bar.write);
    await until(() => page.editor().textContent.includes('quick questions'));
    expect(page.sendMessage).toHaveBeenCalledWith({ type: 'INPAGE_WRITE', payload: { channel: 'message', maxChars: null } });
    expect([...page.editor().querySelectorAll('p')].map((p) => p.textContent))
      .toEqual(['Hi Seán,', '', 'Thanks for connecting! Could I ask you two quick questions about recruiting at Workday?']);
    expect(page.shadow().querySelector('button[type="submit"]').disabled).toBe(false);
    expect(bar.info.textContent).toBe('Read it, then press Send.');
    expect(page.win.__sends).toEqual([]);
  });

  it('a chat with someone else: says so, and writes nothing', async () => {
    const page = linkedin();
    page.win.openMessageBox('Liam Byrne');
    const bar = await until(() => page.bar());
    expect(bar.write.disabled).toBe(true);
    expect(bar.info.textContent).toBe('This chat is with Liam Byrne. Open their profile to write to them.');
    realClick(bar.write); // even your real click does nothing here
    await settle();
    expect(page.sendMessage).not.toHaveBeenCalled();
  });

  it('a "New message" box (first message) for the person on the profile: the button works', async () => {
    const page = linkedin({ person: SEAN });
    page.win.openNewMessageBox([SEAN.name]);
    const bar = await until(() => page.bar());
    expect(bar.write.disabled).toBe(false);
    expect(bar.info.textContent).toBe('');
  });

  it('a "New message" box with a tag that has no label: works if their name is there', async () => {
    const page = linkedin({ person: SEAN });
    page.win.openNewMessageBox([SEAN.name], false);
    const bar = await until(() => page.bar());
    expect(bar.write.disabled).toBe(false);
  });

  it('a "New message" box for someone else, or for two people: says so', async () => {
    const page = linkedin({ person: SEAN });
    page.win.openNewMessageBox(['Liam Byrne']);
    let bar = await until(() => page.bar());
    expect(bar.write.disabled).toBe(true);
    expect(bar.info.textContent).toBe('This chat is with Liam Byrne. Open their profile to write to them.');

    const page2 = linkedin({ person: SEAN });
    page2.win.openNewMessageBox([SEAN.name, 'Liam Byrne']);
    bar = await until(() => page2.bar());
    expect(bar.write.disabled).toBe(true);
    expect(bar.info.textContent).toBe('This message is to more than one person. This button writes to one person at a time.');
  });

  it('an invite to someone in "People you may know": says so, and writes nothing', async () => {
    const page = linkedin({ extra: '<aside><button aria-label="Invite Kim Lee to connect"><span>Connect</span></button></aside>' });
    const bar = await openNoteViaConnect(page, 'Kim Lee');
    expect(bar.write.disabled).toBe(true);
    expect(bar.info.textContent).toBe('This invite is for Kim Lee. Open their profile to write the note.');
  });

  it("works when the note box is inside LinkedIn's shadow root too", async () => {
    const page = linkedin();
    page.win.__noteWhere = 'shadow';
    const bar = await openNoteViaConnect(page);
    realClick(bar.write);
    await until(() => page.shadow().querySelector('textarea').value === NOTE);
  });

  it('leaves other boxes alone: post editors, closed dialogs, pages that are not a profile', async () => {
    const page = linkedin({ extra: '<dialog><h2>Report</h2><p>Tell us about this invitation</p><textarea></textarea></dialog>' });
    page.win.openPostBox();
    await new Promise((r) => setTimeout(r, 300));
    expect(page.bar()).toBeNull();

    const feed = linkedin({ url: 'https://www.linkedin.com/feed/' });
    feed.win.openMessageBox('Aoife Murphy');
    await new Promise((r) => setTimeout(r, 300));
    expect(feed.bar()).toBeNull();
  });

  it('errors show in the bar; an outdated copy of the extension asks you to reload', async () => {
    const refused = "Your Anthropic API key was not accepted. Check it in the extension's Settings (click its icon in Chrome's toolbar), or remove it to use Free Mode.";
    const page = linkedin({ reply: { ok: false, error: refused, code: 'auth' } });
    const bar = await openNoteViaConnect(page);
    realClick(bar.write);
    await until(() => bar.info.textContent);
    expect(bar.info.textContent).toBe(refused);
    expect(bar.info.className).toBe('info error');
    expect(page.note().value).toBe('');

    page.sendMessage.mockRejectedValue(new Error('Extension context invalidated.'));
    realClick(bar.write);
    await until(() => bar.info.textContent.startsWith('The extension was updated'));
    expect(bar.info.textContent).toBe('The extension was updated. Reload this page to use it here.');
  });
});

describe("The Write button uses the note's name for the person", () => {
  // The label uses the writer's own rule (Writer.firstName, from
  // utils/writer.js): no title and no initials. So the button and the note
  // ("Hi Ananya,") name the person the same way.
  it('the manifest puts utils/writer.js into LinkedIn pages, before inpage.js', () => {
    expect(CONTENT_SCRIPTS).toContain('utils/writer.js');
    expect(CONTENT_SCRIPTS.indexOf('utils/writer.js')).toBeLessThan(CONTENT_SCRIPTS.indexOf('inpage.js'));
  });

  for (const [name, label] of [
    ['Dr. Ananya Rao', '✨ Write a note to Ananya'],
    ['S.K. Gupta', '✨ Write a note to Gupta'],
    ['Md. Rahim Uddin', '✨ Write a note to Rahim'],
  ]) {
    it(`on the profile of "${name}", the button says "${label}"`, async () => {
      const page = linkedin({ person: named(AOIFE, name) });
      const bar = await openNoteViaConnect(page, name);
      expect(bar.write.textContent).toBe(label);
      // The invite is for the person whose profile is open: nothing to warn about.
      expect(bar.write.disabled).toBe(false);
      expect(bar.info.textContent).toBe('');
    });
  }

  it('a message box too: "S.K. Gupta" (a connection) gives "✨ Write a message to Gupta"', async () => {
    const page = linkedin({ person: named(SEAN, 'S.K. Gupta') });
    page.click('button[aria-label="Message S.K. Gupta"]');
    const bar = await until(() => page.bar());
    expect(bar.write.textContent).toBe('✨ Write a message to Gupta');
    expect(bar.write.disabled).toBe(false);
    expect(bar.info.textContent).toBe('');
  });

  it('a name with nothing left after the title ("Dr."): the button says "✨ Write a note", and it still writes', async () => {
    const message = 'Hello, your work at Spotify caught my eye. Would you be open to connecting?';
    const page = linkedin({ person: named(AOIFE, 'Dr.'), reply: { ok: true, message, limit: 200, fit: { changed: false, fits: true, removed: 0 } } });
    const bar = await openNoteViaConnect(page, 'Dr.');
    expect(bar.write.textContent).toBe('✨ Write a note');
    expect(bar.write.disabled).toBe(false);

    realClick(bar.write);
    await until(() => page.note().value === message);
    expect(page.sendMessage).toHaveBeenCalledWith({ type: 'INPAGE_WRITE', payload: { channel: 'note', maxChars: 200 } });
    expect(bar.write.textContent).toBe('✨ Write a note');
    expect(bar.info.textContent).toBe(`${message.length}/200. Read it, then press Send.`);
  });

  it('writer.js and inpage.js put into the same page twice: no error, still one bar, one request per click', async () => {
    // When a LinkedIn tab does not answer (say, it was open before an
    // update), the background puts all the content scripts into it once more
    // (askContentScript). If they were there already, each file must do
    // nothing the second time.
    const page = linkedin();
    const writer = page.win.Writer;
    expect(writer.firstName('Dr. Ananya Rao')).toBe('Ananya');
    expect(() => injectContentScripts(page.win)).not.toThrow();
    expect(page.win.Writer).toBe(writer); // set up only once

    const bar = await openNoteViaConnect(page);
    expect(bar.write.textContent).toBe('✨ Write a note to Aoife');
    page.note().focus(); // makes the extension look at the page again
    // Time for a second copy of inpage.js, if one ran, to put in its own bar
    // (or swap ours for it).
    await new Promise((r) => setTimeout(r, 600));
    expect(page.doc.querySelectorAll('[data-outreach-write]')).toHaveLength(1);
    expect(page.bar().host).toBe(bar.host); // still the same bar

    realClick(bar.write);
    await until(() => page.note().value === NOTE);
    expect(page.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('After the extension is updated while LinkedIn stays open', () => {
  // Chrome keeps the old copy of the content scripts running in the page,
  // but cuts it off: chrome.runtime.id is gone, and its messages to the
  // background fail. The background later starts a new copy in a fresh world
  // (askContentScript). Before round 4, the two copies kept swapping each
  // other's bar. Now the old copy steps aside the next time it looks at the
  // page. Each copy here runs in its own world, as in Chrome (loadCopy).

  it('the old copy takes its bar away, stops watching the page, and takes its listeners off', async () => {
    const page = linkedin({ person: SEAN, scripts: false });
    const old = loadCopy(page);
    page.click(`button[aria-label="Message ${SEAN.name}"]`);
    const bar = await until(() => page.bar());
    expect(bar.write.textContent).toBe('✨ Write a message to Seán');
    // It watches the page and LinkedIn's shadow root, and listens for your
    // clicks (which Connect?) and for focus (look again).
    expect(old.watching()).toBe(2);
    expect(old.listening()).toEqual(['click', 'focusin']);

    old.update();
    // LinkedIn changes the page (a new message comes in), so the old copy
    // looks again: it finds itself cut off and steps aside.
    const li = page.doc.createElement('li');
    li.textContent = 'A new message';
    page.shadow().querySelector('ul').append(li);
    await until(() => page.hosts().length === 0);
    expect(old.watching()).toBe(0);
    expect(old.listening()).toEqual([]);
    const timers = old.timers();

    // Later changes: you close the chat, open it again, and click into it.
    realClick(page.shadow().querySelector('[data-action="dismiss"]'));
    page.click(`button[aria-label="Message ${SEAN.name}"]`);
    await until(() => page.editor());
    page.editor().focus();
    await wait(600); // three times the 200ms the extension waits before it looks
    expect(page.hosts()).toEqual([]); // no bar from the old copy
    expect(old.timers()).toBe(timers); // and it did not even plan a look
    expect(old.sendMessage).not.toHaveBeenCalled();
  });

  it('a new copy started next to it shows exactly one bar, keeps it, and writes with the new copy', async () => {
    const page = linkedin({ scripts: false });
    const old = loadCopy(page);
    const oldBar = await openNoteViaConnect(page);
    await wait(500); // the page settles (putting in the bar was a change too)

    // The update. The page has not changed since, so the old copy has not
    // noticed yet: its bar is still there.
    old.update();
    await wait(500);
    expect(page.hosts()).toEqual([oldBar.host]);

    // The background starts a new copy in a fresh world. From now on, count
    // every bar put in or taken out.
    const changes = countBarChanges(page);
    const fresh = loadCopy(page);
    const bar = await until(() => (page.bar() && page.bar().host !== oldBar.host ? page.bar() : null));
    expect(bar.write.textContent).toBe('✨ Write a note to Aoife');
    expect(bar.write.disabled).toBe(false);

    // You click into the box and type, so both copies look at the page again.
    page.note().focus();
    type(page.note(), 'Hi Aoife');
    await wait(800);
    // One swap (the old bar out, the new one in), never two bars at once,
    // and then no more changes (before round 4, the copies kept swapping).
    expect(changes).toEqual({ added: 1, removed: 1, most: 1 });
    expect(page.hosts()).toEqual([bar.host]); // exactly one bar: the new copy's
    expect(old.watching()).toBe(0); // the old copy stepped aside
    expect(old.listening()).toEqual([]);

    // Your click writes, through the new copy (the old one cannot reach the extension).
    realClick(bar.write);
    await until(() => page.note().value === NOTE);
    expect(fresh.sendMessage).toHaveBeenCalledTimes(1);
    expect(fresh.sendMessage).toHaveBeenCalledWith({ type: 'INPAGE_WRITE', payload: { channel: 'note', maxChars: 200 } });
    expect(old.sendMessage).not.toHaveBeenCalled();
    expect(bar.info.textContent).toBe(`${NOTE.length}/200. Read it, then press Send.`);
    expect(page.hosts()).toEqual([bar.host]);
  });
});
