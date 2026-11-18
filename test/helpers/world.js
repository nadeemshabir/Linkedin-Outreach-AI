// A fake browser for tests. The REAL background and the REAL side panel talk
// to each other through a fake chrome.* API, the way they do in Chrome.
// LinkedIn pages and Ark's server are fakes that each test controls.
import { vi } from 'vitest';
import { Window } from 'happy-dom';
import { createFakeChrome } from './fake-chrome.js';
import { runIsolated, read, pageScripts } from './load.js';

export const SERVER  = 'https://linkedin-extention-production.up.railway.app';
export const KEY     = 'ARK-TEST-0000-0000';
export const RUNNING = ['reading', 'enriching', 'writing'];

export function person(slug, name, extra = {}) {
  return {
    name,
    headline: `${name}'s headline`,
    currentCompany: 'Spotify',
    profileUrl: `https://www.linkedin.com/in/${slug}/`,
    ...extra,
  };
}

const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

/**
 * @param {object}   o
 * @param {object}   [o.local]    initial chrome.storage.local
 * @param {object}   [o.session]  initial chrome.storage.session
 * @param {Array}    [o.tabs]     [{ id, url, active }]
 * @param {object}   [o.pages]    tabId → profile the content script returns
 * @param {object}   [o.pagesByUrl] url → profile, used when a tab navigates there
 * @param {Function} [o.server]   (path, body) → [status, json] | Response | 'hang'
 */
export function createWorld({ local = {}, session = {}, tabs = [], pages = {}, pagesByUrl = {}, server = () => [404, {}] } = {}) {
  const { chrome, dispatchMessage } = createFakeChrome({ local, session, tabs });

  chrome.tabs.query.mockImplementation(async (q = {}) =>
    tabs.filter((t) => (q.active ? t.active : true)).map((t) => ({ ...t })));

  // The content script on each LinkedIn tab.
  chrome.tabs.sendMessage.mockImplementation(async (tabId, msg) => {
    const page = pages[tabId];
    if (!page) throw new Error('Could not establish connection. Receiving end does not exist.');
    if (msg.action === 'scrapeProfile') return { success: true, data: { ...page } };
    if (msg.action === 'peekProfile') {
      return { success: true, data: { name: page.name, headline: page.headline, profileUrl: page.profileUrl } };
    }
    return undefined;
  });

  // Messages from the panel go to the background, as in Chrome.
  chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
    const reply = dispatchMessage(msg);
    if (cb) { reply.then((r) => cb(r)); return undefined; }
    return reply;
  });

  // Ark's server.
  const calls = [];
  const fetch = vi.fn(async (url, init = {}) => {
    const path = url.replace(SERVER, '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    const out = await server(path, body);
    if (out === 'hang') {
      return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(abortError())));
    }
    if (out instanceof Response) return out;
    const [status, json] = out;
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  });

  runIsolated('background.js', {
    chrome, fetch, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, Response,
  });

  function navigate(tabId, url, page) {
    const tab = tabs.find((t) => t.id === tabId);
    tab.url = url;
    pages[tabId] = page || pagesByUrl[url] || pages[tabId];
    chrome.tabs.onUpdated.fns.forEach((fn) => fn(tabId, { url }, { ...tab }));
  }
  // chrome.tabs.update({ url }) navigates the tab, as in Chrome.
  chrome.tabs.update.mockImplementation(async (tabId, { url } = {}) => { if (url) navigate(tabId, url); });

  return {
    chrome,
    fetch,
    calls,
    tabs,
    pages,
    /** The user clicks another browser tab. */
    activate(tabId) {
      tabs.forEach((t) => { t.active = t.id === tabId; });
      chrome.tabs.onActivated.fns.forEach((fn) => fn({ tabId }));
    },
    /** LinkedIn moves to another page inside the same tab, without a reload. */
    navigate,
    async job(profileKey) {
      const id = `job:${profileKey}`;
      return (await chrome.storage.session.get(id))[id] || null;
    },
    /** Everyone in the tracker, most recent first. */
    async recent() {
      const { contacts = {} } = await chrome.storage.local.get('contacts');
      return Object.values(contacts).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    /** Start a job straight from the background, with no panel open. */
    start(payload) {
      return dispatchMessage({ type: 'START_JOB', payload });
    },
  };
}

/**
 * Open the real side panel page (sidepanel.html + its scripts) in this world.
 * Each panel gets its own document and its own timers, like a real page, so
 * panels from earlier tests can never draw into this one. close() stops all
 * of this panel's listeners and timers, the way closing the panel would.
 */
export async function openPanel(world, { url = 'chrome-extension://test-extension-id/sidepanel.html' } = {}) {
  const win = new Window({ url });
  const doc = win.document;
  const html = read('sidepanel.html');
  doc.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script[\s\S]*?<\/script>/gi, '');

  const timers = new Set();
  const own = {
    setTimeout: (fn, ms, ...args) => {
      const id = setTimeout(() => { timers.delete(id); fn(...args); }, ms);
      timers.add(id);
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: (fn, ms, ...args) => { const id = setInterval(fn, ms, ...args); timers.add(id); return id; },
    clearInterval: (id) => { timers.delete(id); clearInterval(id); },
  };
  const navigator = { clipboard: { writeText: vi.fn(async () => {}) } };

  const events = [world.chrome.storage.onChanged, world.chrome.tabs.onActivated, world.chrome.tabs.onUpdated];
  const before = events.map((e) => e.fns.length);

  // The page's scripts boot on DOMContentLoaded: capture that handler.
  let boot;
  const realAdd = doc.addEventListener.bind(doc);
  doc.addEventListener = (type, fn, opts) => (type === 'DOMContentLoaded' ? (boot = fn) : realAdd(type, fn, opts));
  const code = pageScripts('sidepanel.html').map(read).join('\n;\n');
  // eslint-disable-next-line no-new-func
  new Function(
    'document', 'window', 'location', 'navigator', 'chrome',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'FileReader',
    code,
  )(doc, win, win.location, navigator, world.chrome,
    own.setTimeout, own.clearTimeout, own.setInterval, own.clearInterval, win.FileReader);
  doc.addEventListener = realAdd;

  const added = [];
  await boot();
  events.forEach((e, i) => added.push(e.fns.slice(before[i])));
  await settle();

  return {
    window: win,
    document: doc,
    navigator,
    $: (id) => doc.getElementById(id),
    close() {
      events.forEach((e, i) => added[i].forEach((fn) => e.removeListener(fn)));
      timers.forEach((id) => { clearTimeout(id); clearInterval(id); });
      timers.clear();
    },
  };
}

/** Let pending promises and 0ms timers run. */
export async function settle(times = 10) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Wait until check() returns something truthy (polls with real timers). */
export async function until(check, { timeout = 3000, interval = 5 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`until(): not true after ${timeout}ms: ${check}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Fire a DOM event using the element's own window (each panel has one). */
export function fire(el, type) {
  const W = el.ownerDocument.defaultView;
  el.dispatchEvent(new W.Event(type, { bubbles: true }));
}

export function type(el, text) {
  el.value = text;
  fire(el, 'input');
}

export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
