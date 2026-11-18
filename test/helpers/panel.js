// Boots the real panel page (sidepanel.html + utils/cache.js + sidepanel.js) inside happy-dom.
import { vi } from 'vitest';
import { createFakeChrome } from './fake-chrome.js';
import { loadPageBody, runInPage } from './load.js';

export const PROFILE_URL = 'https://www.linkedin.com/in/aoife-test/';

/**
 * @param {object} opts
 * @param {object} [opts.local]    initial chrome.storage.local
 * @param {string} [opts.tabUrl]   URL of the active tab
 * @param {function} [opts.onMessage]  (msg) => response, answers chrome.runtime.sendMessage
 */
export async function bootPanel({ local = {}, tabUrl = PROFILE_URL, onMessage = () => undefined } = {}) {
  const { chrome } = createFakeChrome({ local, tabs: [{ id: 7, url: tabUrl }] });
  chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
    const result = Promise.resolve(onMessage(msg));
    if (cb) { result.then((r) => setTimeout(() => cb(r), 0)); return undefined; }
    return result;
  });
  globalThis.chrome = chrome;
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => {}) }, configurable: true,
  });

  loadPageBody('sidepanel.html');

  // sidepanel.js boots on DOMContentLoaded. Capture that handler instead of
  // registering it, so every test gets exactly one fresh boot.
  let boot;
  const original = document.addEventListener;
  document.addEventListener = function (type, fn, opts) {
    if (type === 'DOMContentLoaded') { boot = fn; return undefined; }
    return original.call(this, type, fn, opts);
  };
  try {
    runInPage(['utils/cache.js', 'sidepanel.js']);
  } finally {
    document.addEventListener = original;
  }
  await boot();
  await settle();
  return { chrome, $: (id) => document.getElementById(id) };
}

/** Let pending promises and 0ms timers run. */
export async function settle(times = 5) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

export function click(el) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

export function type(el, text) {
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
