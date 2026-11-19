// The extension's REAL side panel, for the end-to-end tests and for
// scripts/demo.mjs and scripts/screenshots.mjs.
//
// Why not just open sidepanel.html in a tab: the background takes the
// panel's commands (Generate, Test, Use the profile I'm on) only from a page
// that is not in a tab. That stops a content script inside LinkedIn's page
// from sending them. A copy of the panel in a tab is refused the same way.
//
// Playwright cannot see a side panel as a Page, so this talks to it over the
// DevTools protocol (CDP), through a session on one of the context's tabs:
//   - open:  an extension page calls chrome.sidePanel.open(). Chrome allows
//            that only after a user action; Playwright's evaluate() counts.
//   - use:   run code in the panel, click like a mouse and type like a
//            keyboard (so the page gets real, trusted events), and take
//            screenshots.
//   - close: the panel closes itself with window.close().
import fs from 'node:fs';

const PANEL_PAGE = 'sidepanel.html';

async function extensionIdOf(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return { sw, extensionId: new URL(sw.url()).host };
}

/**
 * Opens the side panel in the browser window, as a click on the extension's
 * toolbar icon would, and returns a SidePanel to use it. Call it while the
 * panel is closed. The tab that was active stays active, so the panel shows
 * what that tab shows.
 */
export async function openSidePanel(context, { timeout = 15_000 } = {}) {
  const { sw, extensionId } = await extensionIdOf(context);
  const anchor = context.pages().find((p) => !p.isClosed());
  if (!anchor) throw new Error('openSidePanel: the context needs at least one open tab.');
  const cdp = await context.newCDPSession(anchor);
  const panelUrl = `chrome-extension://${extensionId}/${PANEL_PAGE}`;
  const panelTargets = async () => (await cdp.send('Target.getTargets')).targetInfos
    .filter((t) => t.type === 'page' && t.url === panelUrl);

  const before = new Set((await panelTargets()).map((t) => t.targetId));
  const [active] = await sw.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }));

  // A small extension page (no panel code runs in it) opens the panel.
  const helper = await context.newPage();
  await helper.goto(`chrome-extension://${extensionId}/manifest.json`);
  await helper.evaluate(async () => {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
  });
  await helper.close();
  if (active) await sw.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), active.id);

  const deadline = Date.now() + timeout;
  let target;
  while (!(target = (await panelTargets()).find((t) => !before.has(t.targetId)))) {
    if (Date.now() > deadline) throw new Error('openSidePanel: the side panel did not open.');
    await new Promise((r) => setTimeout(r, 50));
  }
  const panel = new SidePanel(cdp, target.targetId);
  await panel.attach();
  // Ready when the panel has drawn its mode badge (the last step of its start).
  await panel.waitFor(() => document.readyState === 'complete' && !!document.querySelector('#key-status').textContent.trim(), undefined, { timeout });
  return panel;
}

export class SidePanel {
  constructor(cdp, targetId) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.onMessage = (e) => {
      if (e.sessionId !== this.sessionId) return;
      const msg = JSON.parse(e.message);
      const call = msg.id && this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id);
      if (msg.error) call.reject(new Error(`${call.method}: ${msg.error.message}`));
      else call.resolve(msg.result);
    };
    this.onDetach = (e) => {
      if (e.sessionId !== this.sessionId) return;
      this.closed = true;
      for (const call of this.pending.values()) call.reject(new Error(`${call.method}: the side panel is closed`));
      this.pending.clear();
      this.cdp.off('Target.receivedMessageFromTarget', this.onMessage);
      this.cdp.off('Target.detachedFromTarget', this.onDetach);
      this.cdp.detach().catch(() => {});
      if (this.whenClosed) this.whenClosed();
    };
  }

  async attach() {
    this.cdp.on('Target.receivedMessageFromTarget', this.onMessage);
    this.cdp.on('Target.detachedFromTarget', this.onDetach);
    // flatten: false, so that the calls can go through this one CDP session.
    ({ sessionId: this.sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: this.targetId, flatten: false }));
  }

  /** Sends one CDP command to the panel. */
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error(`${method}: the side panel is closed`));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { method, resolve, reject });
      this.cdp.send('Target.sendMessageToTarget', { sessionId: this.sessionId, message: JSON.stringify({ id, method, params }) })
        .catch((err) => { this.pending.delete(id); reject(err); });
    });
  }

  /** Runs fn(arg) inside the panel and returns its (JSON) result. */
  async evaluate(fn, arg) {
    const expression = `(${fn})(${arg === undefined ? '' : JSON.stringify(arg)})`;
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.exceptionDetails) {
      const { exception, text } = res.exceptionDetails;
      throw new Error(`In the side panel: ${(exception && exception.description) || text}`);
    }
    return res.result.value;
  }

  /** Waits until fn(arg) in the panel returns something truthy, and returns it. */
  async waitFor(fn, arg, { timeout = 15_000, interval = 50 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await this.evaluate(fn, arg);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`side panel: not true after ${timeout}ms: ${fn}${arg === undefined ? '' : ` (${JSON.stringify(arg)})`}`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  /** The element's text, with runs of white space made single ('' if it is missing). */
  text(selector) {
    return this.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    }, selector);
  }

  /** The value of an input, select or textarea. */
  value(selector) {
    return this.evaluate((sel) => document.querySelector(sel).value, selector);
  }

  /** Is the element there and shown? */
  visible(selector) {
    return this.evaluate((sel) => {
      const el = document.querySelector(sel);
      return !!el && el.checkVisibility();
    }, selector);
  }

  /**
   * A real mouse click in the middle of the element, once it is shown, on
   * and not covered by anything else (like Playwright's own click).
   */
  async click(selector, { timeout = 15_000 } = {}) {
    const point = await this.waitFor((sel) => {
      const el = document.querySelector(sel);
      if (!el || !el.checkVisibility() || el.disabled) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      return el.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
    }, selector, { timeout });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }

  /** Replaces the text of an input or textarea, as if you typed it. */
  async fill(selector, text) {
    await this.evaluate((sel) => {
      const el = document.querySelector(sel);
      el.focus();
      el.select();
    }, selector);
    if (text) await this.send('Input.insertText', { text });
    else await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  }

  /** Puts files (absolute paths) into an <input type="file">, as if you picked them. */
  async setFiles(selector, paths) {
    const { root } = await this.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`side panel: no element for ${selector}`);
    await this.send('DOM.setFileInputFiles', { nodeId, files: paths });
  }

  /** Waits two frames, so the panel has laid out and painted what changed. */
  frames() {
    return this.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }

  /**
   * Gives the panel this size (CSS pixels) and pixel density, and waits
   * until Chrome really draws it at that size.
   *
   * Why wait: after the first size change, headless Chromium can hand back
   * a picture drawn into the panel's old, smaller area, repeated like tiles.
   * In tests (Nov 2026), 5 of 6 first shots came out tiled. For a short
   * while (usually under 0.4 s) the pictures switch between right and
   * tiled, then they stay right. So one right picture is not enough, and a
   * fixed wait would be a guess.
   *
   * How: a small magenta square goes into the panel's bottom-right corner.
   * A tiled picture cannot have it there. Pictures are taken until the
   * square has been in every one of them for a full second (`steady`); a
   * tiled picture starts that second again. Then the square is removed.
   */
  async resize({ width = 400, height = 860, scale = 2 } = {}, { steady = 1000, timeout = 15_000 } = {}) {
    const size = { width, height, scale };
    if (this.size && JSON.stringify(this.size) === JSON.stringify(size)) return;
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await this.evaluate(() => {
      const mark = document.createElement('div');
      mark.id = 'test-size-mark';
      mark.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 4px; height: 4px; '
        + 'background: #f0f; z-index: 2147483647; pointer-events: none;';
      document.documentElement.append(mark);
    });
    try {
      const deadline = Date.now() + timeout;
      let rightSince = null; // the square has been in every picture since then
      for (;;) {
        await this.frames();
        const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
        if (!(await this.evaluate(markIsInPicture, data))) rightSince = null;
        else if (rightSince === null) rightSince = Date.now();
        else if (Date.now() - rightSince >= steady) break;
        if (Date.now() > deadline) throw new Error(`side panel: not drawn steadily at ${width}x${height} after ${timeout}ms`);
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      if (!this.closed) await this.evaluate(() => document.getElementById('test-size-mark').remove());
    }
    this.size = size;
  }

  /**
   * Saves a PNG of the panel at this size (CSS pixels) and pixel density.
   * The mouse moves off to the corner first, so no button looks hovered.
   * Then it waits for anything short that is still moving (a tab's
   * underline fades over 0.15 s). A spinner that turns for as long as a run
   * lasts is not waited for.
   */
  async screenshot(path, size) {
    await this.resize(size);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    await this.evaluate(() => Promise.race([
      new Promise((r) => setTimeout(r, 2000)),
      Promise.all(document.getAnimations()
        .filter((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => {}))),
    ]));
    await this.frames();
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path, Buffer.from(data, 'base64'));
  }

  /** Closes the side panel (all of its code stops), as closing it in Chrome does. */
  async close({ timeout = 10_000 } = {}) {
    if (this.closed) return;
    const closed = new Promise((resolve) => { this.whenClosed = resolve; });
    this.send('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {});
    let timer;
    await Promise.race([
      closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('side panel: it did not close')), timeout); }),
    ]).finally(() => clearTimeout(timer));
  }
}

/**
 * Runs inside the panel (see resize()). Is the magenta square in this
 * picture (a base64 PNG), at the place where the panel draws it now?
 * The browser itself reads the PNG.
 */
async function markIsInPicture(png) {
  const box = document.getElementById('test-size-mark').getBoundingClientRect();
  const x = Math.floor((box.left + box.width / 2) * devicePixelRatio);
  const y = Math.floor((box.top + box.height / 2) * devicePixelRatio);
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const picture = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  if (x >= picture.width || y >= picture.height) return false;
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(picture, x, y, 1, 1, 0, 0, 1, 1);
  const [red, green, blue] = ctx.getImageData(0, 0, 1, 1).data;
  return red > 230 && green < 30 && blue > 230;
}
