// A fake browser for tests. The REAL background and the REAL side panel talk
// to each other through a fake chrome.* API, the way they do in Chrome.
// LinkedIn pages and Ark's server are fakes that each test controls.
import { vi } from 'vitest';
import { createFakeChrome } from './fake-chrome.js';
import { runIsolated, loadPageBody, runInPage } from './load.js';

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
 * @param {Function} [o.server]   (path, body) → [status, json] | Response | 'hang'
 */
export function createWorld({ local = {}, session = {}, tabs = [], pages = {}, server = () => [404, {}] } = {}) {
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
    navigate(tabId, url, page) {
      const tab = tabs.find((t) => t.id === tabId);
      tab.url = url;
      if (page) pages[tabId] = page;
      chrome.tabs.onUpdated.fns.forEach((fn) => fn(tabId, { url }, { ...tab }));
    },
    async job(profileKey) {
      const id = `job:${profileKey}`;
      return (await chrome.storage.session.get(id))[id] || null;
    },
    async recent() {
      return (await chrome.storage.local.get('recentContacts')).recentContacts || [];
    },
    /** Start a job straight from the background, with no panel open. */
    start(payload) {
      return dispatchMessage({ type: 'START_JOB', payload });
    },
  };
}

/**
 * Open the real side panel page (sidepanel.html + its scripts) in this world.
 * close() shuts it the way the user would: its listeners and timers go away.
 */
export async function openPanel(world) {
  globalThis.chrome = world.chrome;
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => {}) }, configurable: true,
  });
  loadPageBody('sidepanel.html');

  const events = [world.chrome.storage.onChanged, world.chrome.tabs.onActivated, world.chrome.tabs.onUpdated];
  const before = events.map((e) => e.fns.length);
  const intervals = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => { const id = realSetInterval(...args); intervals.push(id); return id; };

  // sidepanel.js boots on DOMContentLoaded. Capture that handler instead of
  // registering it, so each panel boots exactly once.
  let boot;
  const original = document.addEventListener;
  document.addEventListener = function (type, fn, opts) {
    if (type === 'DOMContentLoaded') { boot = fn; return undefined; }
    return original.call(this, type, fn, opts);
  };
  try {
    runInPage(['utils/profile-url.js', 'utils/cache.js', 'sidepanel.js']);
    await boot();
  } finally {
    document.addEventListener = original;
    globalThis.setInterval = realSetInterval;
  }
  await settle();

  return {
    $: (id) => document.getElementById(id),
    close() {
      events.forEach((e, i) => e.fns.splice(before[i]));
      intervals.forEach((id) => clearInterval(id));
      document.body.innerHTML = '';
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

export function type(el, text) {
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
