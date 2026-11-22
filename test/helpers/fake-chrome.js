// A small in-memory stand-in for the chrome.* extension APIs.
// Good enough to run the extension's scripts in unit tests.
import { vi } from 'vitest';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function makeEvent() {
  const fns = [];
  return {
    fns,
    addListener: (fn) => fns.push(fn),
    removeListener: (fn) => { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
    hasListener: (fn) => fns.includes(fn),
  };
}

function makeStorageArea(data, areaName, onChanged) {
  return {
    data,
    get(keys, cb) {
      let out = {};
      if (keys == null) out = clone(data);
      else if (typeof keys === 'string') { if (keys in data) out[keys] = clone(data[keys]); }
      else if (Array.isArray(keys)) keys.forEach((k) => { if (k in data) out[k] = clone(data[k]); });
      else Object.entries(keys).forEach(([k, def]) => { out[k] = k in data ? clone(data[k]) : def; });
      if (cb) { queueMicrotask(() => cb(out)); return undefined; }
      return Promise.resolve(out);
    },
    set(obj, cb) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: clone(data[k]), newValue: clone(v) };
        data[k] = clone(v);
      }
      onChanged.fns.forEach((fn) => fn(changes, areaName));
      if (cb) { queueMicrotask(cb); return undefined; }
      return Promise.resolve();
    },
    remove(keys, cb) {
      const changes = {};
      [].concat(keys).forEach((k) => {
        if (k in data) { changes[k] = { oldValue: clone(data[k]) }; delete data[k]; }
      });
      onChanged.fns.forEach((fn) => fn(changes, areaName));
      if (cb) { queueMicrotask(cb); return undefined; }
      return Promise.resolve();
    },
  };
}

// The manifest's host_permissions: granted at install.
export const INSTALL_HOSTS = ['https://www.linkedin.com/*', 'https://api.anthropic.com/*'];

/**
 * chrome.permissions, for the optional host access (Google's and OpenAI's
 * APIs). request() is Chrome's prompt. As in Chrome, it works only during a
 * user action: `gesture` is true while a click or key press is handled (the
 * test world sets it), and a call made after an `await` is refused. Access
 * you already have is confirmed at once, with no prompt. Otherwise `answer`
 * is what you click in the prompt: 'allow', 'deny', or a function that
 * returns a promise of one of those (to keep the prompt open). Each prompt
 * Chrome would show is kept in `prompts` (its origins).
 */
function makePermissions(granted) {
  const set = new Set(granted);
  const onAdded = makeEvent();
  const onRemoved = makeEvent();
  const permissions = {
    granted: set,
    answer: 'allow',
    gesture: false,
    prompts: [],
    onAdded,
    onRemoved,
    contains: vi.fn(async ({ origins = [] } = {}) => origins.every((o) => set.has(o))),
    getAll: vi.fn(async () => ({ origins: [...set], permissions: [] })),
    request: vi.fn(({ origins = [] } = {}) => {
      if (!permissions.gesture) return Promise.reject(new Error('This function must be called during a user gesture'));
      const missing = origins.filter((o) => !set.has(o));
      if (!missing.length) return Promise.resolve(true);
      permissions.prompts.push(missing);
      const answer = typeof permissions.answer === 'function' ? permissions.answer(missing) : permissions.answer;
      return Promise.resolve(answer).then((a) => {
        if (a !== 'allow') return false;
        missing.forEach((o) => set.add(o));
        onAdded.fns.forEach((fn) => fn({ origins: missing, permissions: [] }));
        return true;
      });
    }),
    // Also what taking access back in chrome://extensions does.
    remove: vi.fn(async ({ origins = [] } = {}) => {
      const had = origins.filter((o) => set.has(o));
      had.forEach((o) => set.delete(o));
      if (had.length) onRemoved.fns.forEach((fn) => fn({ origins: had, permissions: [] }));
      return true;
    }),
  };
  return permissions;
}

/**
 * @param {object} opts
 * @param {object} [opts.local]   initial chrome.storage.local data
 * @param {object} [opts.session] initial chrome.storage.session data
 * @param {Array}  [opts.tabs]    what chrome.tabs.query returns
 * @param {Array}  [opts.granted] host access the extension has (default: the manifest's host_permissions)
 */
export function createFakeChrome({ local = {}, session = {}, tabs = [], granted = INSTALL_HOSTS } = {}) {
  const onMessage = makeEvent();
  const onChanged = makeEvent();

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: undefined,
      onMessage,
      onInstalled: makeEvent(),
      onStartup: makeEvent(),
      getURL: (p) => `chrome-extension://test-extension-id/${p}`,
      getManifest: () => ({ content_scripts: [{ js: ['scraper.js', 'content_script.js', 'utils/writer.js', 'inpage.js'] }] }),
      getPlatformInfo: vi.fn(async () => ({ os: 'linux' })),
      // Replace in a test to fake answers from another extension context.
      sendMessage: vi.fn(),
    },
    storage: {
      local: makeStorageArea(local, 'local', onChanged),
      session: makeStorageArea(session, 'session', onChanged),
      onChanged,
    },
    tabs: {
      query: vi.fn(async () => tabs),
      get: vi.fn(async (id) => {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return { ...tab };
      }),
      sendMessage: vi.fn(),
      update: vi.fn(async () => {}),
      create: vi.fn(async () => {}),
      onUpdated: makeEvent(),
      onActivated: makeEvent(),
      onRemoved: makeEvent(),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      setPopup: vi.fn(async () => {}),
    },
    sidePanel: {
      setPanelBehavior: vi.fn(async () => {}),
      setOptions: vi.fn(async () => {}),
      open: vi.fn(async () => {}),
    },
    alarms: {
      create: vi.fn(),
      get: vi.fn(async () => undefined),
      clear: vi.fn(async () => true),
      onAlarm: makeEvent(),
    },
    permissions: makePermissions(granted),
  };

  /**
   * Deliver a message to this context's runtime.onMessage listeners,
   * the way Chrome would deliver one from another context.
   * Resolves with whatever the listener passes to sendResponse.
   */
  function dispatchMessage(message, sender = { id: chrome.runtime.id }) {
    return new Promise((resolve) => {
      let async = false;
      for (const fn of onMessage.fns) {
        const ret = fn(message, sender, resolve);
        if (ret === true) async = true;
      }
      if (!async) resolve(undefined);
    });
  }

  return { chrome, dispatchMessage };
}
