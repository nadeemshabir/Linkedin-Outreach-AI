// "Write with Ark" inside LinkedIn's own boxes (inpage.js), on a page that
// copies LinkedIn's structure. Each test gets its own window, with the real
// scraper.js + inpage.js loaded as content scripts. The background is a
// stub that answers INPAGE_WRITE (its own tests: inpage-write.test.js).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Window } from 'happy-dom';
import { read } from '../helpers/load.js';
import { until, settle, deferred } from '../helpers/world.js';
import { profilePage } from '../fixtures/linkedin-2026.js';
import { PROFILES } from '../fixtures/profiles.js';
import { installLinkedInDialogs } from '../fixtures/linkedin-dialogs.js';

const AOIFE = PROFILES.find((p) => p.name === 'Aoife Murphy'); // 2nd: has Connect
const SEAN  = PROFILES.find((p) => p.name === "Seán O'Brien"); // 1st: has Message
const NOTE  = 'Hi Aoife, your work on recommendations at Spotify caught my eye. Would you be open to a short chat?';

const windows = [];
afterEach(async () => { while (windows.length) await windows.pop().happyDOM.close(); });

function linkedin({ person = AOIFE, url, extra = '', reply = { ok: true, message: NOTE, limit: 200, fit: { changed: false, fits: true, removed: 0 } } } = {}) {
  const win = new Window({ url: url || `https://www.linkedin.com/in/${person.slug}/`, width: 1280, height: 900 });
  windows.push(win);
  const html = profilePage(person);
  win.document.title = html.match(/<title>([^<]*)<\/title>/)[1];
  win.document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/)[1] + extra;
  win.eval(`(${installLinkedInDialogs})()`);

  const sendMessage = vi.fn(async (msg) => (typeof reply === 'function' ? reply(msg) : reply));
  win.chrome = { runtime: { sendMessage } };
  win.eval(`${read('scraper.js')}\n;\n${read('inpage.js')}`);

  const doc = win.document;
  const shadow = () => doc.getElementById('interop-outlet')?.shadowRoot;
  return {
    win,
    doc,
    sendMessage,
    shadow,
    click: (selector) => doc.querySelector(selector).click(),
    /** Our bar, wherever LinkedIn's box is (page or shadow root). */
    bar() {
      const host = doc.querySelector('[data-ark-write]') || shadow()?.querySelector('[data-ark-write]');
      if (!host) return null;
      const $ = (s) => host.shadowRoot.querySelector(s);
      return { host, write: $('.write'), info: $('.info'), undo: $('.undo') };
    },
    note: () => doc.querySelector('textarea') || shadow()?.querySelector('textarea'),
    editor: () => shadow()?.querySelector('[role="textbox"]'),
  };
}

async function openNoteViaConnect(page, name = 'Aoife Murphy') {
  page.click(`button[aria-label="Invite ${name} to connect"]`);
  const addNote = () => [...page.doc.querySelectorAll('button'), ...(page.shadow()?.querySelectorAll('button') || [])]
    .find((b) => b.textContent === 'Add a note');
  (await until(addNote)).click();
  return until(() => page.bar());
}

describe('Write with Ark, inside LinkedIn (the page)', () => {
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
    bar.write.click();

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
    bar.write.click();
    await settle();
    expect(bar.write.textContent).toBe('Writing…');
    expect(bar.write.disabled).toBe(true);
    bar.write.click(); // a second click while busy does nothing
    gate.resolve();
    await until(() => page.note().value === NOTE);
    expect(page.sendMessage).toHaveBeenCalledTimes(1);
    expect(bar.write.textContent).toBe('✨ Write a note to Aoife');
  });

  it('Undo puts back what you had typed', async () => {
    const page = linkedin();
    const bar = await openNoteViaConnect(page);
    page.note().value = 'Hi Aoife, we met at';
    bar.write.click();
    await until(() => page.note().value === NOTE);
    expect(bar.undo.hidden).toBe(false);

    bar.undo.click();
    expect(page.note().value).toBe('Hi Aoife, we met at');
    expect(page.doc.querySelector('[data-counter]').textContent).toBe('19/200');
    expect(bar.undo.hidden).toBe(true);
  });

  it("the limit is the box's own: maxlength, else its counter, else none (then your plan decides)", async () => {
    const page = linkedin();
    const payloads = [];
    page.sendMessage.mockImplementation(async (m) => { payloads.push(m.payload.maxChars); return { ok: true, message: 'Hi', limit: 200 }; });
    for (const opts of [{ limit: 300 }, { maxlength: false, limit: 300 }, { maxlength: false, counter: false }]) {
      page.win.openNoteBox(opts);
      const bar = await until(() => page.bar());
      bar.write.click();
      await until(() => payloads.length && page.note().value === 'Hi');
      page.doc.querySelector('[data-action="dismiss"]').click();
      await until(() => !page.bar());
    }
    expect(payloads).toEqual([300, 300, null]);
  });

  it('says when a note was shortened to fit, and warns when it still does not fit', async () => {
    const page = linkedin({ reply: { ok: true, message: NOTE, limit: 200, fit: { changed: true, fits: true, removed: 2 } } });
    let bar = await openNoteViaConnect(page);
    bar.write.click();
    await until(() => bar.info.textContent);
    expect(bar.info.textContent).toBe('Shortened to fit 200. Read it, then press Send.');

    const long = 'x'.repeat(230);
    page.sendMessage.mockResolvedValue({ ok: true, message: long, limit: 200, fit: { changed: true, fits: false, removed: 3 } });
    bar.write.click();
    await until(() => page.note().value === long);
    expect(bar.info.textContent).toBe("30 characters over LinkedIn's 200 limit. Shorten it, then press Send.");
    expect(bar.info.className).toBe('info warn');
  });

  it("message box (in LinkedIn's shadow root): writes into the rich text box, Send turns on, nothing is sent", async () => {
    const message = "Hi Seán,\n\nThanks for connecting! Could I ask you two quick questions about recruiting at Workday?";
    const page = linkedin({ person: SEAN, reply: { ok: true, message, limit: null, fit: null } });
    page.click(`button[aria-label="Message ${SEAN.name}"]`);
    const bar = await until(() => page.bar());
    expect(bar.host.parentNode.tagName).toBe('FORM'); // just above LinkedIn's Send row
    expect(bar.host.nextElementSibling.tagName).toBe('FOOTER');
    expect(bar.write.textContent).toBe('✨ Write a message to Seán');

    bar.write.click();
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
    expect(bar.info.textContent).toBe('This chat is with Liam Byrne. Open their profile to write to them with Ark.');
    bar.write.click();
    await settle();
    expect(page.sendMessage).not.toHaveBeenCalled();
  });

  it('an invite to someone in "People you may know": says so, and writes nothing', async () => {
    const page = linkedin({ extra: '<aside><button aria-label="Invite Kim Lee to connect"><span>Connect</span></button></aside>' });
    const bar = await openNoteViaConnect(page, 'Kim Lee');
    expect(bar.write.disabled).toBe(true);
    expect(bar.info.textContent).toBe('This invite is for Kim Lee. Open their profile to write the note with Ark.');
  });

  it("works when the note box is inside LinkedIn's shadow root too", async () => {
    const page = linkedin();
    page.win.__noteWhere = 'shadow';
    const bar = await openNoteViaConnect(page);
    bar.write.click();
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

  it('errors show in the bar; an outdated copy of Ark asks you to reload', async () => {
    const page = linkedin({ reply: { ok: false, error: 'Add your Ark license key first: click the Ark icon in the toolbar, then Settings.' } });
    const bar = await openNoteViaConnect(page);
    bar.write.click();
    await until(() => bar.info.textContent);
    expect(bar.info.textContent).toMatch(/^Add your Ark license key first/);
    expect(bar.info.className).toBe('info error');
    expect(page.note().value).toBe('');

    page.sendMessage.mockRejectedValue(new Error('Extension context invalidated.'));
    bar.write.click();
    await until(() => bar.info.textContent.startsWith('Ark was updated'));
    expect(bar.info.textContent).toBe('Ark was updated. Reload this page to use it here.');
  });
});
