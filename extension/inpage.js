'use strict';

// inpage.js - "Write with Ark" inside LinkedIn's own boxes.
//
// What it is for: when you open LinkedIn's "Add a note" box (Connect → Add
// a note) or a message box on someone's profile, a small "Write a note to
// Aoife" button appears inside it. One click writes the note for that person
// and puts it into LinkedIn's box, fitted to the box's own limit. No copying
// and pasting between the side panel and the page.
//
// The rules it keeps:
//   - It never clicks Send and never submits anything. You read, then send.
//   - It writes only into a box you opened, and only when you click.
//   - It changes none of LinkedIn's own elements. It adds one small bar with
//     its own shadow root, so neither page's styles can leak into the other.
//   - It checks the box is for the person whose profile is open. If the chat
//     or the invite is for someone else, it says so and writes nothing.
//
// It finds the boxes by roles and labels, never by LinkedIn's class names,
// which change with every release. Seen on the live site (Nov 2026):
//   - The message box is inside an open shadow root (div#interop-outlet,
//     data-testid="interop-shadowdom"): a div[role="dialog"] labelled
//     "Messaging" with the other person's name in its <h2>, a
//     div[role="textbox"][contenteditable="true"] labelled "Write a
//     message…", and a Send button (type="submit") that stays off until the
//     box has text.
//   - Every Connect button is labelled "Invite <Name> to connect", also the
//     ones for other people in the "People you may know" list.
// Not seen live yet: the 2026 "Add a note" box itself. It is found as a
// dialog that talks about a note or invitation and has a <textarea>. Its
// limit comes from the textarea's maxlength, or a "0/200" counter, or (if
// neither is there) your LinkedIn plan in Settings.

if (!globalThis.__arkInpage) {
  globalThis.__arkInpage = true;

  (() => {
    const ATTR       = 'data-ark-write';
    const NOTE_WORDS = /\b(note|invitation|invite|personali[sz]e)\b/i;
    const INVITE     = /^invite (.+) to connect$/i;
    const FRESH_MS   = 60 * 1000; // a note box opens right after its Connect click

    const clean      = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const squash     = (s) => String(s || '').replace(/\s+/g, '');
    const norm       = (s) => clean(String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\s]/gu, ' ')).toLowerCase();
    const firstName  = (name) => clean(name).split(' ')[0] || '';
    const onProfile  = () => /^\/in\/[^/]+/.test(location.pathname);
    const samePerson = (a, b) => {
      const x = norm(a);
      const y = norm(b);
      return !!x && !!y && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `));
    };

    // The person whose profile is open (scraper.js reads the top card).
    function profileName() {
      try { return clean(LinkedInScraper.readTopCard(document).name); } catch (_) { return ''; }
    }

    // ── Which "Connect" did you click? ─────────────────────────────────────
    // A note box does not always say who it is for, so remember the last
    // Connect click. A plain "Connect" (no name in its label) is taken to be
    // for the profile that is open.
    let lastInvite = null; // { name, at }
    document.addEventListener('click', (e) => {
      for (const el of e.composedPath()) {
        if (!el || !el.getAttribute) continue;
        const label = clean(el.getAttribute('aria-label'));
        const m = label.match(INVITE);
        if (m) { lastInvite = { name: m[1], at: Date.now() }; return; }
        if (/^(button|menuitem|link)$/.test(el.getAttribute('role') || el.tagName.toLowerCase())
            && /^connect$/i.test(clean(el.textContent))) {
          lastInvite = { name: '', at: Date.now() };
          return;
        }
      }
    }, true);

    // ── Finding LinkedIn's boxes ───────────────────────────────────────────
    function roots() {
      const list = [document];
      const outlet = document.querySelector('[data-testid="interop-shadowdom"], #interop-outlet');
      if (outlet && outlet.shadowRoot) list.push(outlet.shadowRoot);
      return list;
    }

    function isShown(el) {
      if (el.tagName === 'DIALOG' && !el.open) return false;
      return typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0;
    }

    function findBoxes() {
      const boxes = [];
      for (const root of roots()) {
        for (const dialog of root.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog')) {
          // Cheap checks first; isShown() makes the browser work out styles.
          const textarea = dialog.querySelector('textarea');
          const editor   = !textarea && dialog.querySelector('[contenteditable="true"][role="textbox"]');
          if (textarea && NOTE_WORDS.test(dialog.textContent) && isShown(dialog)) {
            boxes.push({ kind: 'note', dialog, field: textarea });
          } else if (editor && /messag/i.test(`${dialog.getAttribute('aria-label')} ${editor.getAttribute('aria-label')}`) && isShown(dialog)) {
            boxes.push({ kind: 'message', dialog, field: editor });
          }
        }
      }
      return boxes;
    }

    function sendButton(dialog) {
      return dialog.querySelector('button[type="submit"]')
        || [...dialog.querySelectorAll('button')].find(b => /^send\b/i.test(clean(b.getAttribute('aria-label') || b.textContent)));
    }

    // The note limit LinkedIn put on this box (null: the background uses
    // your plan from Settings).
    function noteLimit(box) {
      const max = Number(box.field.getAttribute('maxlength'));
      if (max > 0) return max;
      const counter = clean(box.dialog.textContent).match(/\b\d{1,3}\s*\/\s*(\d{3})\b/);
      return counter ? Number(counter[1]) : null;
    }

    // Is this box for someone other than the person whose profile is open?
    function wrongPerson(ui, who) {
      if (!who) return null; // cannot tell here; the background reads the profile anyway
      if (ui.box.kind === 'message') {
        const h = ui.box.dialog.querySelector('h2');
        const chatWith = clean(h && h.textContent);
        return chatWith && !samePerson(chatWith, who)
          ? `This chat is with ${chatWith}. Open their profile to write to them with Ark.`
          : null;
      }
      return ui.inviteFor && !samePerson(ui.inviteFor, who)
        ? `This invite is for ${ui.inviteFor}. Open their profile to write the note with Ark.`
        : null;
    }

    // ── Our bar ────────────────────────────────────────────────────────────
    const bars = new WeakMap(); // our host element → its state

    function barFor(box) {
      let host = box.dialog.querySelector(`[${ATTR}]`);
      if (host && bars.has(host)) {
        const ui = bars.get(host);
        ui.box = box;
        return ui;
      }
      if (host) host.remove(); // left by an older copy of this script

      host = document.createElement('div');
      host.setAttribute(ATTR, box.kind);
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>${CSS}</style>
        <div class="bar">
          <button type="button" class="write"></button>
          <span class="info" role="status" aria-live="polite"></span>
          <button type="button" class="undo" hidden>Undo</button>
        </div>`;
      // Enter / Space on our buttons must not reach LinkedIn's own key
      // handlers (in a message box, Enter can mean "send").
      shadow.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });

      const fresh = lastInvite && Date.now() - lastInvite.at < FRESH_MS;
      const ui = {
        box,
        host,
        write:     shadow.querySelector('.write'),
        info:      shadow.querySelector('.info'),
        undo:      shadow.querySelector('.undo'),
        inviteFor: box.kind === 'note' && fresh ? lastInvite.name : '',
        who:       '',
        blocked:   null,
        busy:      false,
        msg:       null, // [text, tone] after the last click
        before:    null  // what the box held before Ark wrote (for Undo)
      };
      ui.write.addEventListener('click', () => write(ui));
      ui.undo.addEventListener('click', () => undo(ui));
      bars.set(host, ui);
      place(box, host);
      return ui;
    }

    // Between LinkedIn's box and its Send row: [box] [our bar] [Cancel  Send].
    // If there is no Send button to find, right after the box.
    function place(box, host) {
      let row = sendButton(box.dialog);
      while (row && row.parentElement && !row.parentElement.contains(box.field)) row = row.parentElement;
      if (row && row.parentElement) row.parentElement.insertBefore(host, row);
      else box.field.insertAdjacentElement('afterend', host);
    }

    function render(ui) {
      const name = firstName(ui.who);
      ui.write.disabled    = ui.busy || !!ui.blocked;
      ui.write.textContent = ui.busy ? 'Writing…' : `✨ ${name ? `Write a ${ui.box.kind} to ${name}` : 'Write with Ark'}`;
      ui.write.title       = ui.box.kind === 'note'
        ? 'Ark writes a note that fits this box. You read it, then press Send.'
        : 'Ark writes the message into this box. You read it, then press Send.';
      const [text, tone] = ui.blocked ? [ui.blocked, 'warn'] : (ui.msg || ['', '']);
      ui.info.textContent = text;
      ui.info.className   = `info ${tone}`.trim();
      ui.undo.hidden      = ui.busy || ui.before === null;
    }

    // ── Writing ────────────────────────────────────────────────────────────
    async function write(ui) {
      if (ui.busy || ui.blocked) return;
      const { box } = ui;
      ui.busy = true;
      ui.msg  = null;
      render(ui);

      const before = currentText(box.field);
      let res;
      try {
        res = await chrome.runtime.sendMessage({
          type:    'INPAGE_WRITE',
          payload: { channel: box.kind, maxChars: box.kind === 'note' ? noteLimit(box) : null }
        });
      } catch (_) {
        // This copy of the script belongs to an older version of Ark.
        res = { ok: false, error: 'Ark was updated. Reload this page to use it here.' };
      }
      ui.busy = false;

      if (!res || !res.ok) {
        ui.msg = [(res && res.error) || 'Could not write it. Please try again.', 'error'];
      } else if (box.field.isConnected) {
        setText(box.field, res.message);
        ui.before = before;
        ui.msg    = doneMessage(box, res);
      }
      // (If you closed the box meanwhile, the draft is still in the side panel.)
      render(ui);
    }

    function doneMessage(box, res) {
      if (box.kind !== 'note' || !res.limit) return ['Read it, then press Send.', 'ok'];
      const { fit } = res;
      if (fit && !fit.fits) {
        return [`${res.message.length - res.limit} characters over LinkedIn's ${res.limit} limit. Shorten it, then press Send.`, 'warn'];
      }
      if (fit && fit.changed) return [`Shortened to fit ${res.limit}. Read it, then press Send.`, 'ok'];
      return [`${res.message.length}/${res.limit}. Read it, then press Send.`, 'ok'];
    }

    function undo(ui) {
      if (ui.before === null || !ui.box.field.isConnected) return;
      setText(ui.box.field, ui.before);
      ui.before = null;
      ui.msg    = null;
      render(ui);
    }

    function currentText(field) {
      const text = field.tagName === 'TEXTAREA' ? field.value : (field.innerText || field.textContent || '');
      return text.replace(/\n+$/, '');
    }

    // Put text into LinkedIn's box so that LinkedIn notices, as if you typed:
    // its counter updates, its Send button turns on, its draft is saved.
    // First choice: select what is in the box and let the browser itself type
    // the new text. LinkedIn then gets the browser's own input events, and
    // Ctrl+Z still works.
    function setText(field, text) {
      field.focus();
      selectAll(field);
      const typed = typeof document.execCommand === 'function'
        && document.execCommand(text ? 'insertText' : 'delete', false, text);
      if (typed && squash(currentText(field)) === squash(text)) return;

      // Fallback (e.g. the browser cut the text at the box's maxlength):
      // write it ourselves and announce the change.
      if (field.tagName === 'TEXTAREA') {
        field.value = text;
        field.setSelectionRange(text.length, text.length);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      field.replaceChildren(...String(text).split('\n').map(line => {
        const p = document.createElement('p');
        if (line) p.textContent = line;
        else p.append(document.createElement('br'));
        return p;
      }));
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }

    function selectAll(field) {
      if (field.tagName === 'TEXTAREA') {
        field.select();
        return;
      }
      const root = field.getRootNode();
      const selection = (root.getSelection && root.getSelection()) || document.getSelection();
      const range = document.createRange();
      range.selectNodeContents(field);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    // ── Watching for boxes ─────────────────────────────────────────────────
    // LinkedIn is a single-page app: boxes open and close, and the profile
    // changes, without a page load. Look again (at most every 200ms) after
    // the page changes. The message box lives in a shadow root, which needs
    // its own observer.
    let timer = null;
    const watched = new WeakSet();

    function watch(root) {
      if (watched.has(root)) return;
      watched.add(root);
      new MutationObserver(schedule).observe(root, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['open', 'hidden', 'style', 'class', 'aria-hidden']
      });
    }

    function schedule() {
      if (!timer) timer = setTimeout(scan, 200);
    }

    function scan() {
      timer = null;
      roots().forEach(watch);
      if (!onProfile()) {
        // Not on a profile (e.g. a chat left open while you browse): no bars.
        roots().forEach(root => root.querySelectorAll(`[${ATTR}]`).forEach(h => h.remove()));
        return;
      }
      const boxes = findBoxes();
      if (!boxes.length) return;
      const who = profileName();
      for (const box of boxes) {
        const ui = barFor(box);
        ui.who     = who;
        ui.blocked = wrongPerson(ui, who);
        render(ui);
      }
    }

    const CSS = `
      :host { all: initial; display: block; margin: 8px 0; color: inherit; font-family: inherit; font-size: 14px; line-height: 1.4; }
      .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
      .write { font: inherit; font-weight: 600; color: #0a66c2; background: transparent; border: 1px solid currentColor;
               border-radius: 999px; padding: 4px 12px; cursor: pointer; }
      .write:hover:not(:disabled) { background: rgba(10, 102, 194, 0.08); }
      .write:disabled { opacity: 0.6; cursor: default; }
      .write:focus-visible, .undo:focus-visible { outline: 2px solid #0a66c2; outline-offset: 2px; }
      .info { font-size: 13px; }
      .info.warn, .info.error { color: #b24020; }
      .undo { font: inherit; font-size: 13px; color: #0a66c2; background: none; border: 0; padding: 0;
              text-decoration: underline; cursor: pointer; }
      [hidden] { display: none !important; }
    `;

    watch(document);
    document.addEventListener('focusin', schedule, true);
    schedule();
  })();
}
