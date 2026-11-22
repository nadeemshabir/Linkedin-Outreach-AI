// LinkedIn's "Add a note" box and message box, for tests. Made-up people.
//
// installLinkedInDialogs() runs INSIDE the test page (unit tests eval it in
// happy-dom; end-to-end tests add it as a <script>), so it must not use
// anything else from this file.
//
// Message box: copies what was seen on the live site (Nov 2026). It lives in
// an open shadow root on div#interop-outlet[data-testid="interop-shadowdom"]:
// a div[role="dialog"][aria-label="Messaging"] with the person's name in an
// <h2>, and a form with a div[role="textbox"][contenteditable] ("Write a
// message…") and a footer whose Send button (type="submit") stays off until
// the box has text.
//
// Note box: LinkedIn's usual pattern - Connect → "Add a note to your
// invitation?" → "Add a note" → a dialog with a <textarea maxlength>, a
// "0/200" counter, Cancel and Send. Its 2026 markup has NOT been seen live,
// so the tests also cover variants: no maxlength, no counter, inside the
// shadow root (window.__noteWhere = 'shadow').
//
// Like LinkedIn, the page reacts to typing (counter, Send turns on). Every
// press of a Send button is recorded in window.__sends, so tests can check
// that the extension never sends anything. Every input event on a box is
// recorded in window.__inputs (was it the browser's own typing?).

export function installLinkedInDialogs() {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const CSS = `.modal-layer { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; background: rgba(0, 0, 0, 0.4); }
    .modal-layer > [role="dialog"] { background: #fff; color: #000; padding: 16px; width: min(520px, 90vw); border-radius: 8px; }
    textarea { width: 100%; box-sizing: border-box; }
    [contenteditable] { min-height: 60px; border: 1px solid #ccc; padding: 4px; }`;
  window.__sends = [];
  window.__inputs = [];

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  function outlet() {
    let host = document.getElementById('interop-outlet');
    if (!host) {
      host = document.createElement('div');
      host.id = 'interop-outlet';
      host.setAttribute('data-testid', 'interop-shadowdom');
      host.attachShadow({ mode: 'open' }).innerHTML = `<style>${CSS}</style>`;
      document.body.appendChild(host);
    }
    return host.shadowRoot;
  }

  function closeAll() {
    document.querySelectorAll('.modal-layer').forEach((n) => n.remove());
    const host = document.getElementById('interop-outlet');
    if (host) host.shadowRoot.querySelectorAll('.modal-layer').forEach((n) => n.remove());
  }

  function show(where, html) {
    closeAll();
    const layer = document.createElement('div');
    layer.className = 'modal-layer';
    layer.innerHTML = html;
    (where === 'shadow' ? outlet() : document.body).appendChild(layer);
    const dialog = layer.querySelector('[role="dialog"]');
    wire(dialog);
    return dialog;
  }

  function wire(dialog) {
    const field = dialog.querySelector('textarea, [contenteditable="true"]');
    const counter = dialog.querySelector('[data-counter]');
    const text = () => (field.tagName === 'TEXTAREA' ? field.value : field.textContent);
    if (field) {
      field.addEventListener('input', (e) => {
        window.__inputs.push({ trusted: e.isTrusted, type: e.inputType || null });
        dialog.querySelectorAll('[data-send]').forEach((b) => { b.disabled = !text().trim(); });
        if (counter) counter.textContent = `${text().length}/${counter.dataset.counter}`;
      });
    }
    dialog.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-send') && b.type !== 'submit') window.__sends.push(field ? text() : '(no note)');
      if (b.dataset.action === 'add-note') window.openNoteBox({ where: window.__noteWhere });
      if (b.dataset.action === 'dismiss') closeAll();
    });
    const form = dialog.querySelector('form');
    if (form) form.addEventListener('submit', (e) => { e.preventDefault(); window.__sends.push(text()); });
  }

  window.openNoteBox = ({ where = 'document', limit = 200, maxlength = true, counter = true } = {}) => show(where, `
    <div role="dialog" aria-labelledby="test-note-title">
      <button type="button" aria-label="Dismiss" data-action="dismiss">×</button>
      <h2 id="test-note-title">Add a note to your invitation</h2>
      <div><div>
        <textarea name="message" id="custom-message" rows="4" ${maxlength ? `maxlength="${limit}"` : ''}
          placeholder="Ex: We know each other from…"></textarea>
        ${counter ? `<p data-counter="${limit}">0/${limit}</p>` : ''}
      </div></div>
      <div>
        <button type="button" aria-label="Cancel adding a note" data-action="dismiss">Cancel</button>
        <button type="button" aria-label="Send invitation" data-send disabled>Send</button>
      </div>
    </div>`);

  window.openMessageBox = (name) => show('shadow', `
    <div role="dialog" aria-label="Messaging">
      <header>
        <h2>${esc(name)}</h2>
        <button type="button" data-action="dismiss">Close your conversation with ${esc(name)}</button>
      </header>
      <ul><li>Earlier messages would be here.</li></ul>
      <form>
        <div>
          <div><div role="textbox" contenteditable="true" aria-multiline="true" aria-label="Write a message…"><p><br></p></div></div>
          <button type="button">Maximize compose field</button>
        </div>
        <footer>
          <div><button type="button">Attach an image to your conversation with ${esc(name)}</button></div>
          <div><button type="submit" data-send disabled>Send</button><button type="button">Open send options</button></div>
        </footer>
      </form>
    </div>`);

  // A first message (no earlier chat): titled "New message", the person is a
  // tag in the "To" line. Pass labelled=false for a tag with no "Remove" label.
  window.openNewMessageBox = (names, labelled = true) => show('document', `
    <div role="dialog" aria-label="Messaging">
      <header><h2>New message</h2><button type="button" data-action="dismiss">Close</button></header>
      <div>${names.map(n => `<span><span>${esc(n)}</span><button type="button"${labelled ? ` aria-label="Remove ${esc(n)}"` : ''}>✕</button></span>`).join('')}</div>
      <form>
        <div><div role="textbox" contenteditable="true" aria-multiline="true" aria-label="Write a message…"><p><br></p></div></div>
        <footer><div><button type="submit" data-send disabled>Send</button></div></footer>
      </form>
    </div>`);

  // A post editor: also a dialog with a rich text box, but not ours to touch.
  window.openPostBox = () => show('document', `
    <div role="dialog" aria-label="Create a post">
      <h2>Create a post</h2>
      <div role="textbox" contenteditable="true" aria-label="Text editor for creating content"><p><br></p></div>
      <button type="button">Post</button>
    </div>`);

  // Connect → "Add a note to your invitation?"; Message → the message box.
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (!b) return;
    const label = b.getAttribute('aria-label') || '';
    if (/^Invite .+ to connect$/.test(label)) {
      show(window.__noteWhere, `
        <div role="dialog" aria-labelledby="test-choose-title">
          <h2 id="test-choose-title">Add a note to your invitation?</h2>
          <p>Personalize your invitation by adding a note.</p>
          <div>
            <button type="button" data-action="add-note">Add a note</button>
            <button type="button" data-send>Send without a note</button>
          </div>
        </div>`);
    }
    if (/^Message /.test(label)) window.openMessageBox(label.slice('Message '.length));
  });
}

/** For end-to-end pages: the same, as a <script> tag. */
export const dialogsScript = `<script>(${installLinkedInDialogs})();</script>`;
